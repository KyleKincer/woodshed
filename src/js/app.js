import { initLibrary, renderLibrary } from './library.js';
import { initSettings, renderSettings } from './settings.js';
import { openPlayer, closePlayer } from './player.js';
import { ensureRuntimeReady } from './setup.js';

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

async function maybeSpotifyTip() {
  // Non-blocking nudge: Spotify links work best with spotdl, which is optional.
  const status = await window.api.runtimeStatus();
  const banner = document.getElementById('deps-banner');
  if (status.tools.spotdl && !status.tools.spotdl.found) {
    banner.classList.remove('hidden');
    banner.innerHTML = `
      <span>Spotify links work best with <code>spotdl</code>. It installs automatically the next time you run setup; for now, paste a YouTube/SoundCloud link or search instead.</span>
      <button class="toggle-btn" id="dismiss-banner">Dismiss</button>`;
    document.getElementById('dismiss-banner').onclick = () => banner.classList.add('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

async function boot() {
  // Gate the app on a ready tool runtime (first run provisions it).
  await ensureRuntimeReady();

  config = await window.api.getConfig();

  initLibrary(config, openSong);
  initSettings(config);

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });
  document.getElementById('player-back').addEventListener('click', () => showView('library'));

  await renderLibrary();
  await maybeSpotifyTip();
}

boot();
