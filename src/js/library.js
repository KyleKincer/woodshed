// Library grid: renders processed songs (and in-progress ones, as cards with a
// loading overlay), the add-song modal, search, and per-card actions.

let config = null;
let onOpenSong = null;
// In-flight jobs, keyed by jobId: { jobId, songId, title, uploader, duration, thumbFile, stage, percent, error }
const processing = new Map();

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
  subscribeJobs();
  wireViewControls();
  document.getElementById('lib-search').addEventListener('input', (e) => renderLibrary(e.target.value));
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

const STAGE_LABEL = { queued: 'Queued', download: 'Downloading', separate: 'Separating', finalize: 'Finishing' };
const artistOf = (s) => s.artist || s.uploader || '';
const albumOf = (s) => s.album || '';

export async function renderLibrary(filter = '') {
  const lib = await window.api.listLibrary();
  const container = document.getElementById('library-grid');
  const empty = document.getElementById('library-empty');
  const q = filter.trim().toLowerCase();
  const match = (...fields) => !q || fields.some((f) => (f || '').toLowerCase().includes(q));

  const storeIds = new Set(lib.songs.map((s) => s.id));
  const procList = [...processing.values()];
  // Reprocessing jobs overlay an existing card; new jobs render their own card.
  const procBySong = new Map(procList.filter((p) => p.songId && storeIds.has(p.songId)).map((p) => [p.songId, p]));
  const pendingNew = procList.filter((p) => !p.songId || !storeIds.has(p.songId));

  const songs = lib.songs.filter((s) => match(s.title, s.uploader, artistOf(s), albumOf(s)));
  const newCards = pendingNew.filter((p) => match(p.title, p.uploader, p.artist, p.album));

  empty.classList.toggle('hidden', songs.length + newCards.length > 0);

  // Build sections based on the grouping mode.
  const sections = [];
  if (newCards.length) sections.push({ title: 'In progress', items: newCards.map(vmPending) });

  if (view.group === 'songs') {
    sections.push({ title: null, items: songs.map((s) => vmSong(s, procBySong.get(s.id))) });
  } else {
    const keyFn = view.group === 'albums' ? albumOf : artistOf;
    const unknown = view.group === 'albums' ? 'Unknown album' : 'Unknown artist';
    const groups = new Map();
    for (const s of songs) {
      const k = (keyFn(s) || '').trim() || unknown;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
    [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }))
      .forEach(([title, list]) => {
        const art = list.find((s) => s.thumb);
        sections.push({
          title, count: list.length,
          coverUrl: art ? window.api.mediaUrl(art.id, art.thumb) : null,
          items: list.map((s) => vmSong(s, procBySong.get(s.id))),
        });
      });
  }

  container.innerHTML = sections.map(sectionHtml).join('');
  wireCards(container, lib, procBySong);
}

// ---- view models ----
function vmSong(s, proc) {
  return {
    id: s.id, jobId: proc?.jobId, title: s.title,
    artist: artistOf(s), album: albumOf(s), duration: s.duration,
    thumbUrl: s.thumb ? window.api.mediaUrl(s.id, s.thumb) : null,
    stemLabel: s.stems.length >= 4 ? `${s.stems.length} stems` : s.stems.map((x) => x.name).join(' / '),
    proc, isPending: false,
  };
}
function vmPending(p) {
  return {
    id: p.songId, jobId: p.jobId, title: p.title || 'Processing…',
    artist: p.artist || p.uploader || '', album: p.album || '', duration: p.duration,
    thumbUrl: p.songId && p.thumbFile ? window.api.mediaUrl(p.songId, p.thumbFile) : null,
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

function wireCards(container, lib, procBySong) {
  container.querySelectorAll('[data-id]').forEach((el) => {
    const id = el.dataset.id;
    const song = lib.songs.find((s) => s.id === id);
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
    b.addEventListener('click', (e) => { e.stopPropagation(); window.api.cancelJob(b.closest('[data-job]').dataset.job); });
  });
  container.querySelectorAll('[data-dismiss]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      processing.delete(b.closest('[data-job]').dataset.job);
      renderLibrary(currentFilter());
    });
  });
}

// External link for a song, if it has one (downloads/Spotify do; files/searches don't).
function sourceUrl(song) {
  const v = song.source?.value || song.url;
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
    ...(url ? [{ label: 'Open original source', action: () => window.api.openExternal(url) }] : []),
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
  if (name && name.trim()) { await window.api.renameSong(song.id, name.trim()); renderLibrary(currentFilter()); }
}

async function deleteSong(song) {
  const ok = await confirmModal('Delete song?', `"${song.title}" and its stem files will be permanently removed.`, 'Delete');
  if (ok) { await window.api.deleteSong(song.id); renderLibrary(currentFilter()); }
}

function reprocessDialog(song) {
  const presets = [...Object.values(config.presets), { id: 'custom', label: 'Custom (from Settings)' }];
  const fileSource = song.source?.type === 'file';
  const m = buildDialog('Reprocess song', `
    <p class="dlg-msg">Re-run separation for “${esc(song.title)}”${fileSource ? ' (needs the original file to still exist)' : ' from its original source'}. The new stems replace the current ones.</p>
    <label class="field"><span>Quality preset</span>
      <select id="rp-preset">${presets.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}</select>
    </label>
    <label class="field"><span>Stems</span>
      <select id="rp-stem">${Object.values(config.stemModes).map((x) => `<option value="${x.id}">${esc(x.label)}</option>`).join('')}</select>
    </label>
    <div class="modal-actions">
      <button class="btn-ghost" data-cancel>Cancel</button>
      <button class="btn-primary" data-ok>Reprocess</button>
    </div>`);
  // Default to the song's current layout; preset to the app default.
  m.querySelector('#rp-preset').value = config.settings.preset;
  m.querySelector('#rp-stem').value = song.stemMode || config.settings.stemMode;
  const close = () => m.remove();
  m.querySelector('[data-cancel]').onclick = close;
  m.addEventListener('click', (e) => { if (e.target === m) close(); });
  m.querySelector('[data-ok]').onclick = async () => {
    const settings = {
      ...config.settings,
      preset: m.querySelector('#rp-preset').value,
      stemMode: m.querySelector('#rp-stem').value,
    };
    close();
    const res = await window.api.reprocessSong(song.id, settings);
    if (res?.error) await confirmModal('Could not reprocess', res.error, 'OK');
  };
}

function currentFilter() { return document.getElementById('lib-search').value; }

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
    desc.textContent = p ? p.description : '';
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
    await window.api.addSong(input, modalSettings());
    close();
  };
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('add-go').click(); });

  // File picker inside the modal (uses the modal's quality/stem choices).
  document.getElementById('add-pick').onclick = async () => {
    const paths = await window.api.pickAudio();
    if (paths.length) { await window.api.addFiles(paths, modalSettings()); close(); }
  };

  // Drop zone inside the modal.
  const dropZone = document.getElementById('file-drop');
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('over');
    const paths = filesToPaths(e.dataTransfer.files);
    if (paths.length) { await window.api.addFiles(paths, modalSettings()); close(); }
  });

  setupGlobalDrop();
}

function filesToPaths(fileList) {
  return Array.from(fileList)
    .map((f) => window.api.pathForFile(f))
    .filter((p) => p && /\.(mp3|wav|flac|m4a|aac|ogg|opus|aiff?|wma)$/i.test(p));
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
    const paths = filesToPaths(e.dataTransfer.files);
    if (paths.length) await window.api.addFiles(paths, config.settings);
  });
}

// ---------- Jobs / progress (rendered as cards with an overlay) ----------
function subscribeJobs() {
  window.api.on('process:queued', ({ jobId, label, replaceId }) => {
    // For a reprocess, attach to the existing song's card immediately.
    processing.set(jobId, { jobId, songId: replaceId || undefined, title: label, stage: 'queued', percent: 0 });
    renderLibrary(currentFilter());
  });
  window.api.on('process:meta', ({ jobId, songId, title, uploader, duration, thumbFile }) => {
    const p = processing.get(jobId) || { jobId };
    Object.assign(p, { songId, title, uploader, duration, thumbFile });
    processing.set(jobId, p);
    renderLibrary(currentFilter());
  });
  window.api.on('process:progress', ({ jobId, stage, percent }) => {
    const p = processing.get(jobId);
    if (!p) return;
    p.stage = stage;
    p.percent = percent;
    patchOverlay(p); // cheap in-place update; avoid a full re-render every tick
  });
  window.api.on('process:done', ({ jobId }) => {
    processing.delete(jobId);
    renderLibrary(currentFilter());
  });
  window.api.on('process:error', ({ jobId, error }) => {
    const p = processing.get(jobId);
    if (!p) return;
    p.error = error;
    renderLibrary(currentFilter());
  });
  window.api.on('process:canceled', ({ jobId }) => {
    processing.delete(jobId);
    renderLibrary(currentFilter());
  });
}

// Update just the progress text/bar of a card without rebuilding the grid.
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

// ---------- Lightweight dialogs (window.prompt/confirm don't work in Electron) ----------
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
