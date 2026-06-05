import { initLibrary, renderLibrary } from './library.js';
import { initSettings, renderSettings } from './settings.js';
import { openPlayer, closePlayer } from './player.js';

let config = null;

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name !== 'player') closePlayer();
  if (name === 'settings') renderSettings();
  if (name === 'library') renderLibrary(document.getElementById('lib-search').value);
}

async function openSong(song) {
  // Player isn't a nav item; switch views manually.
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-player'));
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
  await openPlayer(song);
}

async function checkDeps() {
  const deps = await window.api.checkDeps();
  const banner = document.getElementById('deps-banner');
  const missingRequired = Object.values(deps).filter((v) => !v.found && !v.optional).map((v) => v.bin);
  const spotdlMissing = deps.spotdl && !deps.spotdl.found;

  if (missingRequired.length) {
    banner.classList.remove('hidden');
    banner.innerHTML = `
      <span>⚠ Missing: <strong>${missingRequired.join(', ')}</strong>. Install with
      <code>brew install yt-dlp ffmpeg</code> and <code>pipx install demucs</code>, then recheck.</span>
      <button class="toggle-btn" id="recheck">Recheck</button>`;
    document.getElementById('recheck').onclick = checkDeps;
  } else if (spotdlMissing) {
    banner.classList.remove('hidden');
    banner.innerHTML = `
      <span>Tip: install <code>spotdl</code> (<code>pipx install spotdl</code>) for reliable Spotify links. Everything else is ready.</span>
      <button class="toggle-btn" id="recheck">Recheck</button>
      <button class="toggle-btn" id="dismiss-banner">Dismiss</button>`;
    document.getElementById('recheck').onclick = checkDeps;
    document.getElementById('dismiss-banner').onclick = () => banner.classList.add('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

async function boot() {
  config = await window.api.getConfig();

  initLibrary(config, openSong);
  initSettings(config);

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });
  document.getElementById('player-back').addEventListener('click', () => showView('library'));

  await renderLibrary();
  await checkDeps();
}

boot();
