export function themeControl() {
  const preference = window.woodshedAppearance?.preference || 'system';
  return `<label class="theme-control">Theme <select data-theme-choice aria-label="Theme">${[['system','System'],['light','Light'],['dark','Dark']].map(([value,label]) => `<option value="${value}" ${value === preference ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`;
}

export function returnOnStop() {
  try { return localStorage.getItem('ws.stopBehavior') !== 'stay'; } catch { return true; }
}

export function setStopBehavior(value) {
  try { localStorage.setItem('ws.stopBehavior', value === 'stay' ? 'stay' : 'return'); } catch {}
}
