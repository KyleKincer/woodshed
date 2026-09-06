import { initializeInteractions } from './interactions.js';
import { transitionView } from './motion.js';
import { renderBilling } from './billing.js';
import { renderDownload } from './desktop.js';
import { renderAdmin } from './admin.js';
import { convex } from './auth.js';
import { anyApi as api } from 'convex/server';
import { initLibrary, renderLibrary } from './library.js';
import { initSettings, renderSettings } from './settings.js';
import { openPlayer, closePlayer } from './player.js';
import { ensureSignedIn, mountUserButton, showFatal } from './auth.js';
import { likelySupportsOpus } from './stemcache.js';
import * as backend from './backend.js';

initializeInteractions();

let config = null;

function showView(name) {
  transitionView(() => {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    document.body.classList.toggle('in-player', name === 'player');
    if (name !== 'player') closePlayer();
    if (name === 'billing') renderBilling();
    if (name === 'admin') renderAdmin();
    if (name === 'settings') renderSettings();
    if (name === 'library') renderLibrary(document.getElementById('lib-search').value);
  });
}

function openSong(song) {
  transitionView(() => {
    document.getElementById('content').scrollTop = 0;
    // The player shares the app header and fills the remaining viewport.
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-player'));
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    document.body.classList.add('in-player');
    // Paint the header and loading tracks now; audio resolves independently.
    void openPlayer(song);
  });
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
  // Gate the app on a signed-in session; everything below needs a user.
  // A failure here has already painted its own explanation, so stop quietly
  // rather than adding an unhandled rejection on top of it.
  try {
    await ensureSignedIn();
  } catch {
    return;
  }
  const admin = await convex.query(api.admin.access, {});
  mountUserButton({ admin, navigate: showView });

  try {
    config = await backend.getConfig();
  } catch (e) {
    showFatal(
      "Couldn't reach the backend",
      `${String(e.message || e)}<br><br>Check that <code>npx convex dev</code> is running.`
    );
    return;
  }

  initLibrary(config, openSong);
  initSettings(config);

  document.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });


  await renderLibrary();
  maybeCodecWarning();
  if (location.pathname === '/billing') showView('billing');
  document.addEventListener('woodshed:billing', () => showView('billing'));
  if (location.pathname === '/admin' && admin) showView('admin');
  if (window.woodshedDesktop) {
    const { initializeDesktop } = await import('./desktop-client.js');
    initializeDesktop();
  }
}

if (location.pathname === '/download') renderDownload();
else boot();
