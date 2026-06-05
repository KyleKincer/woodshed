// Library grid: renders processed songs (and in-progress ones, as cards with a
// loading overlay), the add-song modal, search, and per-card actions.

let config = null;
let onOpenSong = null;
// In-flight jobs, keyed by jobId: { jobId, songId, title, uploader, duration, thumbFile, stage, percent, error }
const processing = new Map();

export function initLibrary(cfg, openSongCb) {
  config = cfg;
  onOpenSong = openSongCb;
  wireAddModal();
  subscribeJobs();
  document.getElementById('lib-search').addEventListener('input', (e) => renderLibrary(e.target.value));
}

function fmtDur(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const STAGE_LABEL = { queued: 'Queued', download: 'Downloading', separate: 'Separating', finalize: 'Finishing' };

export async function renderLibrary(filter = '') {
  const lib = await window.api.listLibrary();
  const grid = document.getElementById('library-grid');
  const empty = document.getElementById('library-empty');
  const q = filter.trim().toLowerCase();
  const match = (title, uploader) => !q || (title || '').toLowerCase().includes(q) || (uploader || '').toLowerCase().includes(q);

  const storeIds = new Set(lib.songs.map((s) => s.id));
  const procList = [...processing.values()];
  // Reprocessing jobs overlay an existing card; new jobs render their own card.
  const procBySong = new Map(procList.filter((p) => p.songId && storeIds.has(p.songId)).map((p) => [p.songId, p]));
  const pendingNew = procList.filter((p) => !p.songId || !storeIds.has(p.songId));

  const songs = lib.songs.filter((s) => match(s.title, s.uploader));
  const newCards = pendingNew.filter((p) => match(p.title, p.uploader));

  empty.classList.toggle('hidden', songs.length + newCards.length > 0);

  grid.innerHTML =
    newCards.map((p) => pendingCardHtml(p)).join('') +
    songs.map((s) => cardHtml(s, procBySong.get(s.id))).join('');

  // Wire store-song cards.
  grid.querySelectorAll('.card[data-id]').forEach((card) => {
    const id = card.dataset.id;
    const song = lib.songs.find((s) => s.id === id);
    if (!song) return;
    const proc = procBySong.get(id);
    if (!proc) {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.card-menu')) return;
        onOpenSong(song);
      });
    }
    card.querySelector('.card-menu')?.addEventListener('click', (e) => {
      e.stopPropagation();
      cardMenu(song, e.currentTarget);
    });
  });

  wireProcButtons(grid);
}

function wireProcButtons(grid) {
  grid.querySelectorAll('.card-proc [data-cancel]').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); window.api.cancelJob(b.closest('.card').dataset.job); });
  });
  grid.querySelectorAll('.card-proc [data-dismiss]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      processing.delete(b.closest('.card').dataset.job);
      renderLibrary(currentFilter());
    });
  });
}

function coverAttr(thumbUrl) {
  return thumbUrl ? `style="background-image:url('${thumbUrl}')"` : '';
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

function cardHtml(s, proc) {
  const cover = s.thumb ? coverAttr(window.api.mediaUrl(s.id, s.thumb)) : '';
  const stemLabel = s.stems.length >= 4 ? `${s.stems.length} stems` : s.stems.map((x) => x.name).join(' / ');
  return `<div class="card ${proc ? 'is-processing' : ''}" data-id="${s.id}" ${proc ? `data-job="${proc.jobId}"` : ''}>
    <div class="badges"><span class="badge">${stemLabel}</span></div>
    ${proc ? '' : '<button class="card-menu">⋯</button>'}
    <div class="cover" ${cover}>${s.thumb ? '' : '♪'}</div>
    <div class="meta">
      <div class="title">${esc(s.title)}</div>
      <div class="sub"><span>${esc(s.uploader || '')}</span><span>${fmtDur(s.duration)}</span></div>
    </div>
    ${proc ? overlayHtml(proc) : ''}
  </div>`;
}

// A card for a job whose song isn't in the library yet.
function pendingCardHtml(p) {
  const thumbUrl = p.songId && p.thumbFile ? window.api.mediaUrl(p.songId, p.thumbFile) : null;
  return `<div class="card is-processing pending" data-job="${p.jobId}">
    <div class="cover" ${coverAttr(thumbUrl)}>${thumbUrl ? '' : '♪'}</div>
    <div class="meta">
      <div class="title">${esc(p.title || 'Processing…')}</div>
      <div class="sub"><span>${esc(p.uploader || '')}</span><span>${fmtDur(p.duration)}</span></div>
    </div>
    ${overlayHtml(p)}
  </div>`;
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
  const card = document.querySelector(`.card[data-job="${p.jobId}"]`);
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
