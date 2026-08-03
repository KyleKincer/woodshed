import { initLibrary, renderLibrary } from './library.js';
import { initSettings, renderSettings } from './settings.js';
import { openPlayer, closePlayer } from './player.js';
import { ensureSignedIn, mountUserButton, showFatal } from './auth.js';
import { likelySupportsOpus } from './stemcache.js';
import * as backend from './backend.js';

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

// Warn before a user downloads 20 MB they can't play. This is only a hint —
// the player reports the authoritative failure if decoding actually breaks.
function maybeCodecWarning() {
  const banner = document.getElementById('deps-banner');
  if (likelySupportsOpus()) {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  banner.innerHTML = `
    <span>This browser may not be able to decode Opus audio. Chrome, Edge, Firefox, and Safari 15+ all can — or switch stems to FLAC in Settings.</span>
    <button class="toggle-btn" id="dismiss-banner">Dismiss</button>`;
  document.getElementById('dismiss-banner').onclick = () => banner.classList.add('hidden');
}

async function boot() {
  // Gate the app on a signed-in Clerk session; everything below needs a user.
  // A failure here has already painted its own explanation, so stop quietly
  // rather than adding an unhandled rejection on top of it.
  try {
    await ensureSignedIn();
  } catch {
    return;
  }
  mountUserButton();

  try {
    config = await backend.getConfig();
  } catch (e) {
    showFatal(
      "Couldn't reach the backend",
      `${String(e.message || e)}<br><br>Check that <code>npx convex dev</code> is running and that the Clerk JWT template named <code>convex</code> exists.`
    );
    return;
  }

  initLibrary(config, openSong);
  initSettings(config);

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });
  initSidebar();

  await renderLibrary();
  maybeCodecWarning();
}

boot();
