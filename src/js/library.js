// Library grid: renders processed songs, the add-song modal, live job progress,
// search, and per-card actions (rename / delete / open source).

let config = null;
let onOpenSong = null;
const jobs = new Map(); // jobId -> { url, el }

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

export async function renderLibrary(filter = '') {
  const lib = await window.api.listLibrary();
  const grid = document.getElementById('library-grid');
  const empty = document.getElementById('library-empty');
  const q = filter.trim().toLowerCase();
  const songs = lib.songs.filter((s) => !q || s.title.toLowerCase().includes(q) || (s.uploader || '').toLowerCase().includes(q));

  empty.classList.toggle('hidden', songs.length > 0 || jobs.size > 0);
  grid.innerHTML = songs.map(cardHtml).join('');

  grid.querySelectorAll('.card').forEach((card) => {
    const id = card.dataset.id;
    const song = lib.songs.find((s) => s.id === id);
    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-menu')) return;
      onOpenSong(song);
    });
    card.querySelector('.card-menu').addEventListener('click', (e) => {
      e.stopPropagation();
      cardMenu(song, e.currentTarget);
    });
  });
}

function cardHtml(s) {
  const cover = s.thumb
    ? `style="background-image:url('${window.api.mediaUrl(s.id, s.thumb)}')"`
    : '';
  const stemLabel = s.stems.length >= 4 ? `${s.stems.length} stems` : s.stems.map((x) => x.name).join(' / ');
  return `<div class="card" data-id="${s.id}">
    <div class="badges"><span class="badge">${stemLabel}</span></div>
    <button class="card-menu">⋯</button>
    <div class="cover" ${cover}>${s.thumb ? '' : '♪'}</div>
    <div class="meta">
      <div class="title">${esc(s.title)}</div>
      <div class="sub"><span>${esc(s.uploader || '')}</span><span>${fmtDur(s.duration)}</span></div>
    </div>
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

// ---------- Jobs / progress ----------
function subscribeJobs() {
  window.api.on('process:queued', ({ jobId, label }) => {
    addJobCard(jobId, label);
  });
  window.api.on('process:progress', ({ jobId, stage, percent, message }) => {
    updateJob(jobId, stage, percent, message);
  });
  window.api.on('process:done', ({ jobId }) => {
    removeJob(jobId);
    renderLibrary(document.getElementById('lib-search').value);
  });
  window.api.on('process:error', ({ jobId, error }) => {
    failJob(jobId, error);
  });
  window.api.on('process:canceled', ({ jobId }) => {
    removeJob(jobId);
    renderLibrary(document.getElementById('lib-search').value);
  });
}

function jobsContainer() { return document.getElementById('jobs'); }

function addJobCard(jobId, label) {
  if (jobs.has(jobId)) return;
  const el = document.createElement('div');
  el.className = 'job';
  el.innerHTML = `
    <div class="job-top">
      <span class="job-title">${esc(label)}</span>
      <span class="job-right">
        <span class="job-stage">Queued…</span>
        <button class="job-cancel" title="Cancel">✕</button>
      </span>
    </div>
    <div class="job-bar"><div class="job-fill"></div></div>`;
  el.querySelector('.job-cancel').onclick = () => {
    el.querySelector('.job-stage').textContent = 'Canceling…';
    window.api.cancelJob(jobId);
  };
  jobsContainer().appendChild(el);
  jobs.set(jobId, { label, el });
  document.getElementById('library-empty').classList.add('hidden');
}

const STAGE_LABEL = { download: 'Downloading', separate: 'Separating stems', finalize: 'Finishing' };

function updateJob(jobId, stage, percent, message) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.el.querySelector('.job-stage').textContent = `${STAGE_LABEL[stage] || stage} · ${Math.round(percent)}%`;
  job.el.querySelector('.job-fill').style.width = `${percent}%`;
}

function removeJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.el.remove();
  jobs.delete(jobId);
}

function failJob(jobId, error) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.el.classList.add('error');
  job.el.querySelector('.job-bar')?.remove();
  job.el.querySelector('.job-cancel')?.remove();
  job.el.querySelector('.job-stage').textContent = 'Failed';
  job.el.querySelector('.job-top').insertAdjacentHTML('beforeend', `<button class="toggle-btn" style="margin-left:8px">Dismiss</button>`);
  const detail = document.createElement('pre');
  detail.className = 'job-error';
  detail.textContent = error;
  job.el.appendChild(detail);
  job.el.querySelector('button').onclick = () => removeJob(jobId);
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
