// Pre-paint appearance (architecture §2.5, §7.2, §7.5). A classic script that
// runs in <head> before any CSS, on every page (app, Shared Stage, download).
// No network. It reads storage and never writes it, and never listens to it:
// cross-tab sync and every persisted change belong to src/app/prefs.js, which
// calls window.woodshedAppearance.apply({theme, stage}) on each change.
//
// Root attributes it sets:
//   data-theme          resolved 'light'|'dark' (ws.prefs.theme; 'system' follows the OS)
//   data-stage-theme    'dark' when prefs.stage is 'dark' or the theme is dark, else 'light'
//   data-place=stage    pre-paint only, for /s/:id and /share/… deep links (the router owns it after boot)
//   data-library-layout 'grid'|'list'
//   style.colorScheme and <meta name=theme-color> from the active token set
(() => {
  const root = document.documentElement;
  // --bg of each token set (§7.2): paper, night, stage. This file is exempt from the colour guard.
  const THEME_COLOR = {paper: '#f6f5f0', night: '#121615', stage: '#08090a'};
  const THEMES = ['system', 'light', 'dark'];
  const STAGES = ['dark', 'match'];

  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const parse = text => { try { return text == null ? undefined : JSON.parse(text); } catch { return undefined; } };
  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

  function initial() {
    const prefs = parse(read('ws.prefs'));
    if (isObject(prefs)) {
      return {
        theme: THEMES.includes(prefs.theme) ? prefs.theme : 'system',
        stage: STAGES.includes(prefs.stage) ? prefs.stage : 'dark',
        layout: isObject(prefs.library) && prefs.library.layout === 'list' ? 'list' : 'grid',
      };
    }
    // Before the first run of the new shell: the 1.x keys (prefs.js migrates and removes them).
    const legacyTheme = read('ws.theme');
    const view = parse(read('ws.view'));
    return {
      theme: THEMES.includes(legacyTheme) ? legacyTheme : 'system',
      stage: 'dark',
      layout: isObject(view) && view.layout === 'list' ? 'list' : 'grid',
    };
  }

  const start = initial();
  let preference = start.theme;
  let stage = start.stage;
  const system = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  const path = window.location.pathname;
  if (path === '/download') root.dataset.startup = 'download';
  if (/^\/s\/[^/]+\/?$/.test(path) || /^\/share\//.test(path)) root.dataset.place = 'stage';
  root.dataset.libraryLayout = start.layout;

  const resolved = () => (preference === 'system' ? (system && system.matches ? 'dark' : 'light') : preference);

  // color-scheme and theme-color from the current root attributes; the router calls it after it sets data-place.
  function refresh() {
    const theme = root.dataset.theme === 'dark' ? 'dark' : 'light';
    const darkStage = root.dataset.place === 'stage' && root.dataset.stageTheme === 'dark';
    const set = darkStage ? 'stage' : theme === 'dark' ? 'night' : 'paper';
    root.style.colorScheme = darkStage || theme === 'dark' ? 'dark' : 'light';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLOR[set]);
    return set;
  }

  function paint() {
    const theme = resolved();
    root.dataset.theme = theme;
    root.dataset.stageTheme = stage === 'dark' || theme === 'dark' ? 'dark' : 'light';
    refresh();
    window.dispatchEvent(new CustomEvent('woodshed:theme', {detail: {preference, theme, stage}}));
  }

  window.woodshedAppearance = Object.freeze({
    get preference() { return preference; },
    get theme() { return resolved(); },
    get stage() { return stage; },
    /** Applies a theme and/or Stage preference to the page. Persists nothing; prefs.js owns storage. */
    apply(next = {}) {
      if (THEMES.includes(next.theme)) preference = next.theme;
      if (STAGES.includes(next.stage)) stage = next.stage;
      paint();
    },
    refresh,
  });

  if (system) {
    const onSystem = () => { if (preference === 'system') paint(); };
    if (system.addEventListener) system.addEventListener('change', onSystem);
    else if (system.addListener) system.addListener(onSystem);
  }
  // The theme-color <meta> may be parsed after this script; set it again once the document is ready.
  document.addEventListener('DOMContentLoaded', refresh, {once: true});
  paint();
})();
