// Runs before styles paint, including signed-out and desktop pages. No network.
(() => {
  if (window.location.pathname === '/download') document.documentElement.dataset.startup = 'download';
  try { document.documentElement.dataset.libraryLayout = JSON.parse(localStorage.getItem('ws.view') || '{}').layout === 'list' ? 'list' : 'grid'; } catch {}
  const key = 'ws.theme';
  const valid = value => ['system', 'light', 'dark'].includes(value) ? value : 'system';
  const read = () => { try { return valid(localStorage.getItem(key)); } catch { return 'system'; } };
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = read();
  function apply() {
    const theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#171c1b' : '#f8f7f1');
    document.querySelectorAll('[data-theme-choice]').forEach(control => { control.value = preference; });
    window.dispatchEvent(new CustomEvent('woodshed:theme', {detail: {preference, theme}}));
  }
  function syncNative() { window.woodshedDesktop?.setTheme?.(preference).catch(() => {}); }
  window.woodshedAppearance = Object.freeze({
    get preference() { return preference; },
    set(value) {
      preference = valid(value);
      try { localStorage.setItem(key, preference); } catch { /* Session-only when storage is unavailable. */ }
      apply(); syncNative();
    },
  });
  system.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) { preference = read(); apply(); syncNative(); }
  });
  document.addEventListener('change', event => {
    if (event.target.matches('[data-theme-choice]')) window.woodshedAppearance.set(event.target.value);
  });
  document.addEventListener('DOMContentLoaded', apply, {once: true});
  apply(); syncNative();
})();
