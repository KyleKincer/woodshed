// Library grid: renders processed songs (and in-progress ones, as cards with a
// loading overlay), the add-song modal, search, and per-card actions.
//
// Song and job state both arrive as live Convex subscriptions, so progress
// updates and finished separations land here without polling — and survive a
// page reload mid-job, which the old IPC event stream did not.

import * as backend from './backend.js';

let config = null;
let onOpenSong = null;

let songs = [];
let jobs = []; // separation jobs from the server
// Browser-side uploads that have no server job yet, keyed by a local id.
const uploads = new Map();
// R2 cover key -> signed URL, filled in before each render.
let coverUrls = {};
let unsubscribers = [];

// View preferences (grouping + layout) persisted in localStorage.
let view = loadView();
function loadView() {
  try { return { group: 'songs', layout: 'grid', ...JSON.parse(localStorage.getItem('ws.view') || '{}') }; }
  catch { return { group: 'songs', layout: 'grid' }; }
}
function saveView() { localStorage.setItem('ws.view', JSON.stringify(view)); }

export function initLibrary(cfg, openSongCb) {
  config = cfg;
  onOpenSong = openSongCb;
  wireAddModal();
  wireViewControls();
  document.getElementById('lib-search').addEventListener('input', (e) => renderLibrary(e.target.value));

  unsubscribers.forEach((fn) => fn());
  unsubscribers = [
    backend.onLibrary((lib) => {
      songs = lib?.songs || [];
      renderLibrary(currentFilter());
    }),
    backend.onJobs((list) => {
      jobs = (list || []).filter((j) => j.kind === 'separate');
      renderLibrary(currentFilter());
    }),
  ];
}

export function teardownLibrary() {
  unsubscribers.forEach((fn) => fn());
  unsubscribers = [];
}

function wireViewControls() {
  const gs = document.getElementById('group-seg');
  const ls = document.getElementById('layout-seg');
  const sync = () => {
    gs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.group === view.group));
    ls.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.layout === view.layout));
  };
  gs.querySelectorAll('button').forEach((b) => (b.onclick = () => { view.group = b.dataset.group; saveView(); sync(); renderLibrary(currentFilter()); }));
  ls.querySelectorAll('button').forEach((b) => (b.onclick = () => { view.layout = b.dataset.layout; saveView(); sync(); renderLibrary(currentFilter()); }));
  sync();
}

function fmtDur(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const STAGE_LABEL = {
  queued: 'Queued', upload: 'Uploading', download: 'Downloading',
  separate: 'Separating', finalize: 'Finishing',
};
const artistOf = (s) => s.artist || s.uploader || '';
const albumOf = (s) => s.album || '';

// Renders are async only because cover art needs signed URLs; overlapping
// calls are common (a subscription tick mid-render), so stale ones bail out.
let renderToken = 0;

export async function renderLibrary(filter = '') {
  const token = ++renderToken;
  const container = document.getElementById('library-grid');
  const empty = document.getElementById('library-empty');
  const q = String(filter).trim().toLowerCase();
  const match = (...fields) => !q || fields.some((f) => (f || '').toLowerCase().includes(q));

  const procList = allPending();
  const songIds = new Set(songs.map((s) => s.id));
  // Reprocessing jobs overlay an existing card; new jobs render their own card.
  const procBySong = new Map(procList.filter((p) => p.songId && songIds.has(p.songId)).map((p) => [p.songId, p]));
  const pendingNew = procList.filter((p) => !p.songId || !songIds.has(p.songId));

  const shown = songs.filter((s) => match(s.title, s.uploader, artistOf(s), albumOf(s)));
  const newCards = pendingNew.filter((p) => match(p.title, p.uploader, p.artist, p.album));

  // Resolve every cover we're about to draw in one batched, cached call.
  const keys = [
    ...shown.map((s) => s.coverKey),
    ...newCards.map((p) => p.coverKey),
  ].filter(Boolean);
  if (keys.length) {
    try { coverUrls = { ...coverUrls, ...(await backend.signKeys(keys)) }; }
    catch { /* covers are decorative; render without them */ }
  }
  if (token !== renderToken) return; // a newer render already started

  empty.classList.toggle('hidden', shown.length + newCards.length > 0);

  const sections = [];
  if (newCards.length) sections.push({ title: 'In progress', items: newCards.map(vmPending) });

  if (view.group === 'songs') {
    sections.push({ title: null, items: shown.map((s) => vmSong(s, procBySong.get(s.id))) });
  } else {
    const keyFn = view.group === 'albums' ? albumOf : artistOf;
    const unknown = view.group === 'albums' ? 'Unknown album' : 'Unknown artist';
    const groups = new Map();
    for (const s of shown) {
      const k = (keyFn(s) || '').trim() || unknown;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
    [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }))
      .forEach(([title, list]) => {
        const art = list.find((s) => s.coverKey);
        sections.push({
          title, count: list.length,
          coverUrl: art ? coverUrls[art.coverKey] : null,
          items: list.map((s) => vmSong(s, procBySong.get(s.id))),
        });
      });
  }

  container.innerHTML = sections.map(sectionHtml).join('');
  wireCards(container, procBySong);
}

/** Server jobs plus browser-side uploads, in one uniform shape. */
function allPending() {
  const fromJobs = jobs.map((j) => ({
    jobId: j.jobId,
    songId: j.songId,
    title: j.meta?.title || j.label,
    uploader: j.meta?.uploader || '',
    artist: j.meta?.artist || '',
    album: j.meta?.album || '',
    duration: j.meta?.duration || 0,
    coverKey: j.meta?.coverKey || null,
    stage: j.stage,
    percent: j.percent,
    message: j.message,
    error: j.status === 'error' ? j.error || 'Processing failed.' : null,
    local: false,
  }));
  const fromUploads = [...uploads.values()].map((u) => ({
    jobId: u.id,
    songId: null,
    title: u.name,
    uploader: '', artist: '', album: '', duration: 0, coverKey: null,
    stage: 'upload',
    percent: u.total ? (u.loaded / u.total) * 100 : 0,
    message: 'Uploading…',
    error: u.error || null,
    local: true,
  }));
  return [...fromUploads, ...fromJobs];
}

// ---- view models ----
function vmSong(s, proc) {
  return {
    id: s.id, jobId: proc?.jobId, title: s.title,
    artist: artistOf(s), album: albumOf(s), duration: s.duration,
    thumbUrl: s.coverKey ? coverUrls[s.coverKey] || null : null,
    stemLabel: s.stems.length >= 4 ? `${s.stems.length} stems` : s.stems.map((x) => x.name).join(' / '),
    proc, isPending: false,
  };
}
function vmPending(p) {
  return {
    id: p.songId, jobId: p.jobId, title: p.title || 'Processing…',
    artist: p.artist || p.uploader || '', album: p.album || '', duration: p.duration,
    thumbUrl: p.coverKey ? coverUrls[p.coverKey] || null : null,
    stemLabel: null, proc: p, isPending: true,
  };
}
// Secondary line: in the Artists view show the album; otherwise the artist.
function subFor(vm) { return view.group === 'artists' ? vm.album : vm.artist; }

// ---- section + item rendering ----
function sectionHtml(sec) {
  const header = sec.title
    ? `<div class="section-head">
        ${sec.coverUrl ? `<div class="section-cover" style="background-image:url('${sec.coverUrl}')"></div>` : ''}
        <div class="section-title">${esc(sec.title)}</div>
        ${sec.count ? `<div class="section-count">${sec.count} song${sec.count > 1 ? 's' : ''}</div>` : ''}
      </div>`
    : '';
  const body = view.layout === 'list'
    ? `<div class="library-list">${sec.items.map(listRow).join('')}</div>`
    : `<div class="library-grid">${sec.items.map(gridCard).join('')}</div>`;
  return `<section class="lib-section">${header}${body}</section>`;
}

function coverAttr(thumbUrl) {
  return thumbUrl ? `style="background-image:url('${thumbUrl}')"` : '';
}

function gridCard(vm) {
  return `<div class="card ${vm.proc ? 'is-processing' : ''}" ${vm.id ? `data-id="${vm.id}"` : ''} ${vm.jobId ? `data-job="${vm.jobId}"` : ''}>
    ${vm.stemLabel ? `<div class="badges"><span class="badge">${vm.stemLabel}</span></div>` : ''}
    ${vm.proc || vm.isPending ? '' : '<button class="card-menu">⋯</button>'}
    <div class="cover" ${coverAttr(vm.thumbUrl)}>${vm.thumbUrl ? '' : '♪'}</div>
    <div class="meta">
      <div class="title">${esc(vm.title)}</div>
      <div class="sub"><span>${esc(subFor(vm) || '')}</span><span>${fmtDur(vm.duration)}</span></div>
    </div>
    ${vm.proc ? overlayHtml(vm.proc) : ''}
  </div>`;
}

function listRow(vm) {
  return `<div class="list-row ${vm.proc ? 'is-processing' : ''}" ${vm.id ? `data-id="${vm.id}"` : ''} ${vm.jobId ? `data-job="${vm.jobId}"` : ''}>
    <div class="list-thumb" ${coverAttr(vm.thumbUrl)}>${vm.thumbUrl ? '' : '♪'}</div>
    <div class="list-main">
      <div class="list-title">${esc(vm.title)}</div>
      <div class="list-sub">${esc(subFor(vm) || '')}</div>
    </div>
    ${vm.stemLabel ? `<div class="list-badge">${vm.stemLabel}</div>` : ''}
    ${vm.proc ? procInlineHtml(vm.proc) : `<div class="list-dur">${fmtDur(vm.duration)}</div>${vm.isPending ? '' : '<button class="card-menu list-menu">⋯</button>'}`}
  </div>`;
}

function overlayHtml(p) {
  if (p.error) {
    return `<div class="card-proc error">
      <div class="cp-title">Failed</div>
      <div class="cp-sub">${esc((p.error.split('\n')[0] || '').slice(0, 80))}</div>
      <button class="cp-btn" data-dismiss>Dismiss</button>
    </div>`;
  }
  const pct = Math.round(p.percent || 0);
  return `<div class="card-proc">
    <div class="spinner"></div>
    <div class="cp-title">${STAGE_LABEL[p.stage] || 'Working'} · ${pct}%</div>
    <div class="cp-bar"><div class="cp-fill" style="width:${pct}%"></div></div>
    <button class="cp-btn" data-cancel>Cancel</button>
  </div>`;
}

// Compact, inline progress for list rows.
function procInlineHtml(p) {
  if (p.error) {
    return `<div class="proc-inline error"><span class="cp-title">Failed</span><button class="cp-btn" data-dismiss>Dismiss</button></div>`;
  }
  const pct = Math.round(p.percent || 0);
  return `<div class="proc-inline">
    <div class="cp-bar"><div class="cp-fill" style="width:${pct}%"></div></div>
    <span class="cp-title">${STAGE_LABEL[p.stage] || 'Working'} · ${pct}%</span>
    <button class="cp-btn" data-cancel>Cancel</button>
  </div>`;
}

function wireCards(container, procBySong) {
  container.querySelectorAll('[data-id]').forEach((el) => {
    const id = el.dataset.id;
    const song = songs.find((s) => s.id === id);
    if (!song) return;
    const proc = procBySong.get(id);
    if (!proc) {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.card-menu')) return;
        onOpenSong(song);
      });
    }
    el.querySelector('.card-menu')?.addEventListener('click', (e) => {
      e.stopPropagation();
      cardMenu(song, e.currentTarget);
    });
  });
  container.querySelectorAll('[data-cancel]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const jobId = b.closest('[data-job]').dataset.job;
      if (uploads.has(jobId)) { uploads.delete(jobId); renderLibrary(currentFilter()); }
      else backend.cancelJob(jobId);
    });
  });
  container.querySelectorAll('[data-dismiss]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const jobId = b.closest('[data-job]').dataset.job;
      if (uploads.has(jobId)) { uploads.delete(jobId); renderLibrary(currentFilter()); }
      else backend.dismissJob(jobId);
    });
  });
}

// External link for a song, if it has one (downloads/Spotify do; uploads don't).
function sourceUrl(song) {
  const v = song.source?.value;
  if (!v) return null;
  return /^https?:\/\//i.test(v) ? v : null;
}

function closeCardMenu() {
  document.querySelector('.ctx-menu')?.remove();
  document.removeEventListener('mousedown', onDocDown, true);
  document.removeEventListener('keydown', onMenuKey, true);
}
function onDocDown(e) { if (!e.target.closest('.ctx-menu')) closeCardMenu(); }
function onMenuKey(e) { if (e.key === 'Escape') closeCardMenu(); }

function cardMenu(song, anchor) {
  closeCardMenu();
  const url = sourceUrl(song);
  const items = [
    { label: 'Play', action: () => onOpenSong(song) },
    { label: 'Reprocess…', action: () => reprocessDialog(song) },
    { label: 'Rename…', action: () => renameSong(song) },
    ...(url ? [{ label: 'Open original source', action: () => backend.openExternal(url) }] : []),
    { label: 'Delete', danger: true, action: () => deleteSong(song) },
  ];

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  items.forEach((it) => {
    const b = document.createElement('button');
    b.className = 'ctx-item' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    b.onclick = () => { closeCardMenu(); it.action(); };
    menu.appendChild(b);
  });
  document.body.appendChild(menu);

  // Position under the ⋯ button, kept on-screen.
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = r.top - mh - 6;
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = Math.max(8, top) + 'px';

  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onMenuKey, true);
}

async function renameSong(song) {
  const name = await promptModal('Rename song', song.title);
  if (name && name.trim()) await backend.renameSong(song.id, name.trim());
}

async function deleteSong(song) {
  const ok = await confirmModal('Delete song?', `"${song.title}" and its stem files will be permanently removed.`, 'Delete');
  if (ok) await backend.deleteSong(song.id);
}

function reprocessDialog(song) {
  const presets = [...Object.values(config.presets), { id: 'custom', label: 'Custom (from Settings)' }];
  const uploadSource = song.source?.type === 'upload';
  const m = buildDialog('Reprocess song', `
    <p class="dlg-msg">Re-run separation for “${esc(song.title)}”${uploadSource ? ' from the file you uploaded' : ' from its original source'}. The new stems replace the current ones; your beat track and title are kept.</p>
    <label class="field"><span>Quality preset</span>
      <select id="rp-preset">${presets.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}</select>
    </label>
    <label class="field"><span>Stems</span>
      <select id="rp-stem">${Object.values(config.stemModes).map((x) => `<option value="${x.id}">${esc(x.label)}</option>`).join('')}</select>
    </label>
    <p id="rp-cost" class="hint"></p>
    <div class="modal-actions">
      <button class="btn-ghost" data-cancel>Cancel</button>
      <button class="btn-primary" data-ok>Reprocess</button>
    </div>`);
  const presetSel = m.querySelector('#rp-preset');
  presetSel.value = config.settings.preset;
  m.querySelector('#rp-stem').value = song.stemMode || config.settings.stemMode;
  const cost = m.querySelector('#rp-cost');
  const syncCost = () => { cost.textContent = costHint(presetSel.value); };
  presetSel.onchange = syncCost;
  syncCost();
  const close = () => m.remove();
  m.querySelector('[data-cancel]').onclick = close;
  m.addEventListener('click', (e) => { if (e.target === m) close(); });
  m.querySelector('[data-ok]').onclick = async () => {
    const settings = {
      ...config.settings,
      preset: presetSel.value,
      stemMode: m.querySelector('#rp-stem').value,
    };
    close();
    try {
      await backend.reprocessSong(song.id, settings, `${song.title} (reprocess)`);
    } catch (e) {
      await confirmModal('Could not reprocess', String(e.message || e), 'OK');
    }
  };
}

/** Separation runs on rented GPUs now, so make the cost visible up front. */
function costHint(presetId) {
  const p = config.presets[presetId];
  if (!p?.estCostUsd) return 'Custom settings — cost scales with model and shift averaging.';
  return `Roughly $${p.estCostUsd.toFixed(2)} of GPU time per song.`;
}

function currentFilter() {
  return document.getElementById('lib-search')?.value || '';
}

// ---------- Add modal ----------
function wireAddModal() {
  const modal = document.getElementById('add-modal');
  const urlInput = document.getElementById('add-url');
  const presetSel = document.getElementById('add-preset');
  const stemSel = document.getElementById('add-stemmode');
  const desc = document.getElementById('add-preset-desc');

  const presets = [...Object.values(config.presets), { id: 'custom', label: 'Custom (from Settings)', description: 'Uses the custom parameters set in Settings.' }];
  presetSel.innerHTML = presets.map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
  stemSel.innerHTML = Object.values(config.stemModes).map((m) => `<option value="${m.id}">${m.label}</option>`).join('');

  const syncDesc = () => {
    const p = presets.find((x) => x.id === presetSel.value);
    desc.textContent = `${p ? p.description : ''} ${costHint(presetSel.value)}`.trim();
  };
  presetSel.onchange = syncDesc;

  const modalSettings = () => ({ ...config.settings, preset: presetSel.value, stemMode: stemSel.value });

  const open = () => {
    presetSel.value = config.settings.preset;
    stemSel.value = config.settings.stemMode;
    urlInput.value = '';
    syncDesc();
    modal.classList.remove('hidden');
    urlInput.focus();
  };
  const close = () => modal.classList.add('hidden');

  document.querySelectorAll('[data-add], #add-btn').forEach((b) => b.addEventListener('click', open));
  document.getElementById('add-cancel').onclick = close;
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  document.getElementById('add-go').onclick = async () => {
    const input = urlInput.value.trim();
    if (!input) { urlInput.focus(); return; }
    close();
    try { await backend.addSong(input, modalSettings()); }
    catch (e) { await confirmModal('Could not add song', String(e.message || e), 'OK'); }
  };
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('add-go').click(); });

  // Real <input type=file> now — there is no native dialog to call into.
  const picker = document.getElementById('add-file-input');
  document.getElementById('add-pick').onclick = () => picker.click();
  picker.onchange = async () => {
    const files = audioFiles(picker.files);
    picker.value = '';
    if (files.length) { close(); await uploadAndQueue(files, modalSettings()); }
  };

  // Drop zone inside the modal.
  const dropZone = document.getElementById('file-drop');
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('over');
    const files = audioFiles(e.dataTransfer.files);
    if (files.length) { close(); await uploadAndQueue(files, modalSettings()); }
  });

  setupGlobalDrop();
}

function audioFiles(fileList) {
  return Array.from(fileList || []).filter(
    (f) => backend.AUDIO_FILE_RE.test(f.name) || (f.type || '').startsWith('audio/')
  );
}

/**
 * Upload each file to R2 and queue a separation job, showing a local progress
 * card until the server job takes over.
 */
async function uploadAndQueue(files, settings) {
  for (const file of files) {
    const id = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    uploads.set(id, { id, name: file.name, loaded: 0, total: file.size, error: null });
    renderLibrary(currentFilter());
    try {
      await backend.addFiles([file], settings, ({ loaded, total }) => {
        const u = uploads.get(id);
        if (!u) return; // canceled
        u.loaded = loaded;
        u.total = total;
        patchOverlay({ jobId: id, stage: 'upload', percent: total ? (loaded / total) * 100 : 0 });
      });
      uploads.delete(id);
    } catch (e) {
      const u = uploads.get(id);
      if (u) u.error = String(e.message || e);
    }
    renderLibrary(currentFilter());
  }
}

// Drop audio files anywhere in the window to add them with default settings.
function setupGlobalDrop() {
  const overlay = document.getElementById('drop-overlay');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    depth++;
    overlay.classList.remove('hidden');
  });
  window.addEventListener('dragover', (e) => { if (!overlay.classList.contains('hidden')) e.preventDefault(); });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; overlay.classList.add('hidden'); } });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    overlay.classList.add('hidden');
    // If the add modal is open it handles its own drop.
    if (!document.getElementById('add-modal').classList.contains('hidden')) return;
    const files = audioFiles(e.dataTransfer.files);
    if (files.length) await uploadAndQueue(files, config.settings);
  });
}

// Update just the progress text/bar of a card without rebuilding the grid.
// Upload progress fires far faster than the grid can usefully re-render.
function patchOverlay(p) {
  const card = document.querySelector(`[data-job="${p.jobId}"]`);
  if (!card) return;
  const pct = Math.round(p.percent || 0);
  const title = card.querySelector('.cp-title');
  const fill = card.querySelector('.cp-fill');
  if (title) title.textContent = `${STAGE_LABEL[p.stage] || 'Working'} · ${pct}%`;
  if (fill) fill.style.width = `${pct}%`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Lightweight dialogs ----------
function promptModal(title, value = '') {
  return new Promise((resolve) => {
    const m = buildDialog(title, `
      <input id="dlg-input" class="dlg-input" type="text" />
      <div class="modal-actions">
        <button class="btn-ghost" data-cancel>Cancel</button>
        <button class="btn-primary" data-ok>Save</button>
      </div>`);
    const input = m.querySelector('#dlg-input');
    input.value = value;
    const done = (v) => { m.remove(); resolve(v); };
    m.querySelector('[data-cancel]').onclick = () => done(null);
    m.querySelector('[data-ok]').onclick = () => done(input.value);
    m.addEventListener('click', (e) => { if (e.target === m) done(null); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value);
      if (e.key === 'Escape') done(null);
    });
    input.focus();
    input.select();
  });
}

function confirmModal(title, message, okLabel = 'OK') {
  return new Promise((resolve) => {
    const m = buildDialog(title, `
      <p class="dlg-msg">${esc(message)}</p>
      <div class="modal-actions">
        <button class="btn-ghost" data-cancel>Cancel</button>
        <button class="btn-danger" data-ok>${esc(okLabel)}</button>
      </div>`);
    const done = (v) => { m.remove(); resolve(v); };
    m.querySelector('[data-cancel]').onclick = () => done(false);
    m.querySelector('[data-ok]').onclick = () => done(true);
    m.addEventListener('click', (e) => { if (e.target === m) done(false); });
    document.addEventListener('keydown', function k(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', k); done(false); }
    });
  });
}

function buildDialog(title, innerHtml) {
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="modal-card"><h2>${esc(title)}</h2>${innerHtml}</div>`;
  document.body.appendChild(m);
  return m;
}
