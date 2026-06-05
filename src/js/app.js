import { initLibrary, renderLibrary } from './library.js';
import { initSettings, renderSettings } from './settings.js';
import { openPlayer, closePlayer } from './player.js';
import { ensureRuntimeReady } from './setup.js';

let config = null;

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.body.classList.toggle('in-player', name === 'player');
  if (name !== 'player') closePlayer();
  if (name === 'settings') renderSettings();
  if (name === 'library') renderLibrary(document.getElementById('lib-search').value);
}

async function openSong(song) {
  // Player isn't a nav item; switch views manually and hide the sidebar for space.
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-player'));
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
  document.body.classList.add('in-player');
  await openPlayer(song, () => showView('library'));
}

function initSidebar() {
  const collapsed = localStorage.getItem('ws.sidebarCollapsed') === '1';
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const toggle = document.getElementById('sidebar-toggle');
  // Tooltips for the collapsed icon rail.
  document.querySelector('.nav-btn[data-view="library"]')?.setAttribute('title', 'Library');
  document.querySelector('.nav-btn[data-view="settings"]')?.setAttribute('title', 'Settings');
  document.getElementById('add-btn')?.setAttribute('title', 'Add song');

  const apply = () => {
    const c = document.body.classList.contains('sidebar-collapsed');
    localStorage.setItem('ws.sidebarCollapsed', c ? '1' : '0');
    toggle.textContent = c ? '›' : '‹';
    toggle.title = c ? 'Expand sidebar (⌘.)' : 'Collapse sidebar (⌘.)';
  };
  const toggleSidebar = () => { document.body.classList.toggle('sidebar-collapsed'); apply(); };
  toggle.onclick = toggleSidebar;
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === '.') { e.preventDefault(); toggleSidebar(); }
  });
  apply();
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
  initSidebar();

  await renderLibrary();
  await maybeSpotifyTip();
}

boot();
