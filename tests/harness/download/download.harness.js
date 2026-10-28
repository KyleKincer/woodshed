// DL1's harness (/__harness/download): the real /download page through its bootRoutes entry
// (`boot`), mounted as the app would mount it (into #app, which replaces the harness <main>), over
// a fake release lookup built from the bundled public/downloads.json. States: tests/fixture/states/DL1.cjs.
// Query:
//   release=ok|fallback|fail|slow   ok: /api/downloads answers · fallback: /api/downloads answers 503 and
//                                   /downloads.json answers · fail: every lookup fails until
//                                   window.__dl1.heal() · slow: every lookup waits for window.__dl1.answer()
//   ua=chromeos                     a ChromeOS navigator (no installer fits); otherwise the browser's own
//                                   navigator (fx-platform=mac|win|ipad, or the container's Linux)
// Fixture switches that matter: fx-platform (the detected installer), fx-desktop=1 (inside the
// desktop app: same-origin new-tab links navigate in place).
// Installer links point at GitHub; the harness cancels their navigation (the page's own click
// handling still runs), so a state can click them.
import {boot} from '../../../src/download/download.js';
import manifest from '../../../public/downloads.json';

const NAVIGATORS = {
  chromeos: {platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', maxTouchPoints: 0},
};

const answer = () => new Response(JSON.stringify(manifest), {status: 200, headers: {'content-type': 'application/json'}});

export default async function mount(el, {query}) {
  const mode = query.get('release') ?? 'ok';
  let healed = false;
  const waiting = new Set();
  const calls = [];

  const abortable = (signal, run) => new Promise((resolve, reject) => {
    const entry = {resolve: () => resolve(run())};
    waiting.add(entry);
    signal?.addEventListener('abort', () => { waiting.delete(entry); reject(signal.reason); }, {once: true});
  });

  async function fetch(url, {signal} = {}) {
    calls.push(url);
    if (mode === 'slow') return abortable(signal, answer);
    if (mode === 'fail' && !healed) throw new TypeError('Failed to fetch');
    if (mode === 'fallback' && url === '/api/downloads') return new Response('{}', {status: 503});
    return answer();
  }

  window.__dl1 = {
    calls,
    heal() { healed = true; },
    answer() { for (const entry of [...waiting]) { waiting.delete(entry); entry.resolve(); } },
  };

  document.addEventListener('click', e => {
    const link = e.target instanceof Element ? e.target.closest('a[download]') : null;
    if (link) e.preventDefault();
  }, true);

  const app = document.createElement('div');
  app.id = 'app';
  el.replaceWith(app);
  const view = await boot({name: 'download', path: '/download', params: {}, query: {}}, {
    root: app,
    fetch,
    navigator: NAVIGATORS[query.get('ua')] ?? navigator,
    timeoutMs: mode === 'slow' ? 10 * 60_000 : 10_000,
  });
  window.__dl1.view = view;
  return view;
}
