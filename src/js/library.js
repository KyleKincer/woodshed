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
      cardMenu(song);
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

async function cardMenu(song) {
  const action = window.prompt(
    `"${song.title}"\n\nType an action:\n  r = rename\n  d = delete\n  s = open source on YouTube`,
    ''
  );
  if (!action) return;
  const a = action.trim().toLowerCase();
  if (a === 'r') {
    const name = window.prompt('New name:', song.title);
    if (name) { await window.api.renameSong(song.id, name); renderLibrary(); }
  } else if (a === 'd') {
    if (window.confirm(`Delete "${song.title}" and its stem files?`)) {
      await window.api.deleteSong(song.id);
      renderLibrary();
    }
  } else if (a === 's') {
    window.api.openExternal(song.url);
  }
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
