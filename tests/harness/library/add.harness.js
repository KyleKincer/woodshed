// LB2b's harness (/__harness/add): the Add sheet (src/library/add-sheet.js) on the real modules over the fixture
// database through the real client (auth.initialize, then S1's startData fills store.library as the app does).
// fx-desktop=1 is the desktop app (B4 lookups, files, the local device line; fx-companion=down for an offline
// processor); without it the web (B5: fx-devices=none for the explainer, offline for an offline computer).
//   q=<text>          pre-fills the omnibox (/add?q=…), so lookups run at once
//   files=<a,b,…>     stages these file names as if dropped on the Library (".pdf" files are not audio)
//   duration=<s>      the <audio> duration every file reports (else the real probe, which cannot read fake files)
//   change=1          opens the Change panel;  stats=1 seeds prefs.jobStats for the Quality estimates
//   submit=1          presses Add & split once the sheet is ready (inline errors, the after-submit state)
//   menu=1            opens the B5 computer menu (web)
//   pick=1            /add?pick=1
//   dismiss=<jobId>   history state {dismissJobId} (Search for another version)
//   paused=1          an export-only account
// The dispatcher runs as in the app (Esc closes the sheet). window.__add = {sheet, router, store, closed, toasts}.
import {signal, store} from '/src/app/store.js';

const user = {id: 'user1', name: 'Kyle Kincer', email: 'kyle@example.com', image: null};

function fakeRouter() {
  const log = [];
  return {
    current: signal({name: 'add', path: '/add', params: {}, query: {}}),
    log,
    navigate(to, opts) { log.push(['navigate', to, opts?.state ?? null]); },
    back(opts) { log.push(['back', opts?.fallback ?? null]); },
    setQuery(patch) { log.push(['setQuery', patch]); },
  };
}

async function startApp(paused) {
  const [auth, {startData}, {desktop}, {startAccount}] = await Promise.all([
    import('/src/app/auth.js'), import('/src/app/data.js'), import('/src/app/desktop.js'), import('/src/app/account.js'),
  ]);
  const {user: signedIn} = await auth.initialize();
  store.session.value = {user: signedIn ?? user, status: paused ? 'export_only' : 'active', admin: false, online: true};
  startAccount?.();
  startData();
  if (desktop.available) await desktop.start();
  await new Promise(resolve => {
    if (store.library.loaded.peek()) { resolve(); return; }
    const off = store.library.loaded.subscribe(v => { if (v) { off(); resolve(); } });
  });
  return {desktop};
}

const waitFor = (read, timeoutMs = 8000) => new Promise((resolve, reject) => {
  const started = performance.now();
  const step = () => {
    const value = read();
    if (value) { resolve(value); return; }
    if (performance.now() - started > timeoutMs) { reject(new Error('add harness: timed out')); return; }
    setTimeout(step, 50);
  };
  step();
});

export default async function mount(el, {query, fixture}) {
  const paused = query.get('paused') === '1';
  const {desktop} = await startApp(paused);
  if (desktop.available) await waitFor(() => ['ready', 'busy', 'offline', 'pair-failed'].includes(store.processor.peek()?.phase));
  await waitFor(() => store.account.peek() != null);
  const [{createAddSheet}, {startDispatcher}, {registry}, {stageFiles}, {prefs}, feedback] = await Promise.all([
    import('/src/library/add-sheet.js'), import('/src/app/dispatch.js'), import('/src/app/commands.js'),
    import('/src/library/dropzone.js'), import('/src/app/prefs.js'), import('/src/app/feedback.js'),
  ]);
  startDispatcher({registry});
  if (query.get('stats') === '1') prefs.set('jobStats', {fast: {secPerMin: 15, n: 4}, balanced: {secPerMin: 30, n: 9}, studio: {secPerMin: 95, n: 2}});
  const names = (query.get('files') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (names.length) {
    stageFiles(names.map((name, i) => new File([new Uint8Array(1024 * (i + 3) * 1024)], name,
      {type: name.endsWith('.pdf') ? 'application/pdf' : 'audio/mpeg'})));
  }
  const duration = Number(query.get('duration'));
  const router = fakeRouter();
  const toasts = [];
  const closed = [];
  const page = document.createElement('main');
  page.className = 'add-harness-page';
  page.textContent = 'Library';
  el.append(page);
  const sheet = createAddSheet({
    host: el, router: null,
    ...(Number.isFinite(duration) && duration > 0 ? {durationOf: async () => duration} : {}),
    feedback: {
      toast: (message, opts) => { toasts.push({message: Array.isArray(message) ? message.map(m => m.textContent ?? m).join('') : String(message), opts}); return feedback.toast(message, opts); },
      announce: feedback.announce,
    },
    onClose: (reason, added) => closed.push({reason, added: added ? {title: added.title, keys: added.keys} : null}),
  });
  const q = query.get('q');
  const state = query.get('dismiss') ? {dismissJobId: query.get('dismiss')} : null;
  sheet.update({name: 'add', path: '/add', query: {...(q ? {q} : {}), ...(query.get('pick') === '1' ? {pick: '1'} : {})}, params: {}, state});
  window.__add = {sheet, router, store, closed, toasts, fixture};

  // Settle: lookups answer (desktop) and durations arrive before the capture.
  const lookups = () => {
    const s = sheet.state();
    return s.lookup.status !== 'loading' && !s.files.some(f => f.probing);
  };
  await waitFor(lookups).catch(() => {});
  if (query.get('change') === '1') sheet.el.querySelector('.lib-add-change')?.click();
  if (query.get('menu') === '1') sheet.el.querySelector('.lib-add-device-pick')?.click();
  if (query.get('submit') === '1') {
    sheet.el.querySelector('.lib-add-submit')?.click();
    await waitFor(() => !sheet.state().busy).catch(() => {});
  }
}
