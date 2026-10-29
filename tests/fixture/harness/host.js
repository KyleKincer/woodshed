// Harness host (architecture §11.2): the page at /__harness/<name> loads this
// module after the fixture's early.js and preamble.js. Like the app it loads
// src/styles/main.css (tokens, fonts) and inlines the icon sprite, then mounts
// the harness: `default async function mount(el, {fixture, query, h})`.
// Peers that do not exist yet are skipped (import.meta.glob finds nothing), so
// a harness never breaks the build of another package.
// Query parameters:
//   theme=light|dark       the desk theme (default: the system colour scheme)
//   place=stage            html[data-place=stage] (Stage tokens, D3); stage=dark|light (default dark)
// The page sets html[data-view-ready=<name>] once mount resolves (runners wait on it), and
// html[data-harness-error] plus a console error when it throws.
const HARNESSES = import.meta.glob(['/tests/harness/**/*.harness.js', '/tests/fixture/harness/*.harness.js']);
const STYLES = import.meta.glob('/src/styles/main.css');
const SPRITE = import.meta.glob('/src/styles/icons.svg', {query: '?raw', import: 'default'});
const H = import.meta.glob('/src/ui/h.js');

const root = document.documentElement;
const query = new URLSearchParams(location.search);
const name = decodeURIComponent(location.pathname.replace(/^\/__harness\/?/, '').replace(/\/$/, ''));

/** A small h() for when src/ui/h.js does not exist yet: h(tag, props, ...children). */
export function fallbackH(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class' || key === 'className') el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) if (child != null && child !== false) el.append(child instanceof Node ? child : String(child));
  return el;
}

function applyTheme() {
  const theme = query.get('theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  root.dataset.theme = theme;
  if (query.get('place')) root.dataset.place = query.get('place');
  if (root.dataset.place === 'stage') root.dataset.stageTheme = query.get('stage') ?? 'dark';
  const dark = root.dataset.place === 'stage' ? root.dataset.stageTheme === 'dark' || theme === 'dark' : theme === 'dark';
  root.style.colorScheme = dark ? 'dark' : 'light';
}

async function start() {
  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  const entry = Object.entries(HARNESSES).filter(([file]) => file.endsWith(`/${name}.harness.js`));
  if (entry.length !== 1) throw new Error(entry.length ? `Two harnesses are named ${name}: ${entry.map(([f]) => f).join(', ')}` : `No harness is named ${name}`);
  for (const load of Object.values(STYLES)) await load();
  for (const load of Object.values(SPRITE)) {
    const sprite = document.createElement('div');
    sprite.hidden = true;
    sprite.setAttribute('aria-hidden', 'true');
    sprite.innerHTML = await load();
    document.body.prepend(sprite);
  }
  const hModule = await Object.values(H)[0]?.();
  const h = hModule?.h ?? fallbackH;
  const mod = await entry[0][1]();
  if (typeof mod.default !== 'function') throw new Error(`${entry[0][0]} has no default mount function`);
  const el = document.getElementById('harness');
  const mounted = await mod.default(el, {fixture: window.fixture, query, h});
  window.__harness = {name, file: entry[0][0], mounted: mounted ?? null};
  root.dataset.viewReady = name;
}

start().catch(error => {
  root.dataset.harnessError = error?.message ?? String(error);
  console.error(`[harness] ${name}:`, error);
});
