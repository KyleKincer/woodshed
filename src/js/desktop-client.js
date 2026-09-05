import { initializeLocalDesktop } from './companion.js';
let state = {status:'idle'}, button, applying = false;
const icon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function render() {
  if (!button) return;
  button.hidden = !['available', 'downloading', 'ready'].includes(state.status);
  button.disabled = applying || state.status === 'downloading';
  const label = state.status === 'downloading'
    ? `Downloading update — ${Math.round(state.percent || 0)}%`
    : 'Update and restart Woodshed';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.classList.toggle('is-downloading', state.status === 'downloading');
}
async function applyUpdate() {
  if (applying || !['available', 'ready'].includes(state.status)) return;
  const version = state.version ? ` ${state.version}` : '';
  if (!window.confirm(`Update to Woodshed${version} and restart?\n\nWoodshed will download the update and restart when it is ready. Playback and song processing must be stopped before it can restart.`)) return;
  applying = true;
  render();
  try {
    if (state.status === 'available') await window.woodshedDesktop.update('download');
    const result = await window.woodshedDesktop.update('install');
    if (result?.message) window.alert(result.message);
  } catch (error) {
    window.alert(error.message || 'The update could not finish. Try again.');
  } finally {
    applying = false;
    render();
  }
}
async function checkUpdates() {
  if (applying || state.status === 'downloading') {
    window.alert('The update is downloading. Woodshed will restart when it is ready.');
    return;
  }
  if (['available', 'ready'].includes(state.status)) { await applyUpdate(); return; }
  try {
    const result = await window.woodshedDesktop.update('check');
    if (result?.message) { window.alert(result.message); return; }
    state = result;
    render();
    if (['available', 'ready'].includes(state.status)) await applyUpdate();
    else window.alert(state.status === 'current' ? 'Woodshed is up to date.' : 'Could not check for updates. Try again later.');
  } catch (error) { window.alert(error.message || 'Could not check for updates.'); }
}
export async function initializeDesktop() {
  button = document.createElement('button');
  button.type = 'button';
  button.className = 'desktop-update-trigger';
  button.innerHTML = icon;
  button.onclick = applyUpdate;
  document.getElementById('user-button').before(button);
  render();
  window.woodshedDesktop.onUpdate(next => { state = next; render(); });
  window.woodshedDesktop.onOpenUpdates?.(checkUpdates);
  document.addEventListener('woodshed:show-updates', checkUpdates);
  try { const info = await initializeLocalDesktop(); state = info.update; render(); }
  catch (error) { console.error('Could not initialize local processing:', error); }
}
