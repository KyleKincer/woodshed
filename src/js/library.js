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
    const url = urlInput.value.trim();
    if (!url) { urlInput.focus(); return; }
    const settings = { ...config.settings, preset: presetSel.value, stemMode: stemSel.value };
    await window.api.addSong(url, settings);
    close();
  };

  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('add-go').click(); });
}

// ---------- Jobs / progress ----------
function subscribeJobs() {
  window.api.on('process:queued', ({ jobId, url }) => {
    addJobCard(jobId, url);
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
}

function jobsContainer() { return document.getElementById('jobs'); }

function addJobCard(jobId, url) {
  if (jobs.has(jobId)) return;
  const el = document.createElement('div');
  el.className = 'job';
  el.innerHTML = `
    <div class="job-top"><span class="job-title">${esc(url)}</span><span class="job-stage">Queued…</span></div>
    <div class="job-bar"><div class="job-fill"></div></div>`;
  jobsContainer().appendChild(el);
  jobs.set(jobId, { url, el });
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
  job.el.querySelector('.job-stage').textContent = 'Failed';
  job.el.querySelector('.job-top').insertAdjacentHTML('beforeend', `<button class="toggle-btn" style="margin-left:8px">Dismiss</button>`);
  const detail = document.createElement('div');
  detail.style.cssText = 'font-size:12px;color:var(--bad);margin-top:8px;white-space:pre-wrap';
  detail.textContent = error.split('\n').slice(0, 3).join('\n');
  job.el.appendChild(detail);
  job.el.querySelector('button').onclick = () => removeJob(jobId);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
