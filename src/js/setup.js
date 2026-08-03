// First-run setup screen. Shows what's needed, runs provisioning, streams the
// log, and resolves once the runtime is ready.

const TOOL_LABELS = {
  ffmpeg: 'Audio tools',
  ffprobe: 'Audio inspector',
  demucs: 'Stem separator',
  'yt-dlp': 'Downloader',
  spotdl: 'Spotify support',
};
const SOURCE_LABEL = { managed: 'ready', bundled: 'included', system: 'found', missing: 'pending' };

export async function ensureRuntimeReady() {
  const status = await window.api.runtimeStatus();
  if (status.ready) return true;
  return runSetupScreen(status);
}

function renderChecklist(status) {
  const el = document.getElementById('setup-checklist');
  el.innerHTML = Object.entries(status.tools)
    .map(([key, t]) => {
      const optional = key === 'spotdl';
      const ok = t.found;
      const cls = ok ? 'ok' : 'pending';
      const ic = ok ? '✓' : '○';
      const src = ok ? SOURCE_LABEL[t.source] : optional ? 'optional' : 'needs setup';
      return `<div class="setup-item ${cls}" data-tool="${key}">
        <span class="ic">${ic}</span>
        <span>${TOOL_LABELS[key] || key}</span>
        <span class="sub">${src}</span>
      </div>`;
    })
    .join('');
}

function runSetupScreen(initialStatus) {
  return new Promise((resolve) => {
    const setup = document.getElementById('setup');
    const goBtn = document.getElementById('setup-go');
    const retryBtn = document.getElementById('setup-retry');
    const logEl = document.getElementById('setup-log');
    const errEl = document.getElementById('setup-error');
    setup.classList.remove('hidden');
    renderChecklist(initialStatus);

    let unsub = null;

    const start = async () => {
      goBtn.classList.add('hidden');
      retryBtn.classList.add('hidden');
      errEl.classList.add('hidden');
      logEl.classList.remove('hidden');
      logEl.textContent = '';
      goBtn.disabled = true;

      unsub = window.api.on('runtime:log', ({ line }) => {
        logEl.textContent += line + '\n';
        logEl.scrollTop = logEl.scrollHeight;
        // Light-touch progress: flip the demucs row to "active" once installing.
        if (/Installing|PyTorch|demucs/i.test(line)) markActive('demucs');
        if (/uv|Python .* environment/i.test(line)) markActive('yt-dlp');
      });

      const res = await window.api.provisionRuntime();
      if (unsub) { unsub(); unsub = null; }

      if (res.ok) {
        renderChecklist(res.status);
        document.getElementById('setup-title').textContent = 'Ready!';
        setTimeout(() => { setup.classList.add('hidden'); resolve(true); }, 600);
      } else {
        errEl.textContent = res.error || 'Setup failed.';
        errEl.classList.remove('hidden');
        retryBtn.classList.remove('hidden');
        retryBtn.disabled = false;
      }
    };

    goBtn.onclick = start;
    retryBtn.onclick = start;
  });
}

function markActive(tool) {
  const item = document.querySelector(`.setup-item[data-tool="${tool}"]`);
  if (item && !item.classList.contains('ok')) {
    item.classList.remove('pending');
    item.classList.add('active');
    item.querySelector('.ic').textContent = '⟳';
  }
}
