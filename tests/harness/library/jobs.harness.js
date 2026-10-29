// LB1b's harness (/__harness/jobs): the Jobs chip and popover and the "Is this right?" chip on the real
// modules, over the fixture database through the real client (auth.initialize, then S1's startData fills
// store.library as the app does). Add fx-desktop=1 for the desktop app (the processor footer), with
// fx-processor=stopped for an offline processor; fx-devices=none|offline for the web footer variants.
//   ?part=jobs (default)   the app frame with the top bar and the Jobs chip in its slot
//     open=1               opens the Jobs popover;  focus=<jobId> opens it focused on that job's row
//     uploads=1            two uploads in store.library.uploads: one at 12 of 31 MB, one that failed
//     found=1              starts a beat detection on a mapped song (glasshouse); it finishes during the
//                          session and stays unapplied, so the popover offers it (Open song · Not now)
//     only=<kind,…>        keeps only these job kinds in the database (separate, beats, sections, import)
//   ?part=review           a row of sample cards for the songs that need review, each with its chip
//     open=<songId>        opens that song's popover;  suggest=1 gives `counting` a suggestion for another
//                          recording ("Counting Stars", with ids), so Yes applies it
// The dispatcher runs as in the app (Esc closes the popovers through its overlay stack).
// window.__jobs = {model, store, router, topbar, chips, uploads} for states.
import {signal, store} from '/src/app/store.js';

const user = {id: 'user1', name: 'Kyle Kincer', email: 'kyle@example.com', image: null};
const MB = 1e6;

/** A router that records navigation. */
function fakeRouter() {
  const current = signal({name: 'library', path: '/', params: {}, query: {}});
  const log = [];
  return {
    current, log,
    navigate(to, opts) { log.push(['navigate', to, opts?.state ?? null]); },
    setQuery(patch) { log.push(['setQuery', patch]); },
    href: (name, params, query) => `/?q=${encodeURIComponent(query?.q ?? '')}`,
  };
}

/** Signs in on the fixture and starts the library subscriptions, as main.js boot steps 3–6 do. */
async function startApp(fixture) {
  const [auth, {startData}, {desktop}] = await Promise.all([
    import('/src/app/auth.js'), import('/src/app/data.js'), import('/src/app/desktop.js'),
  ]);
  const {user: signedIn} = await auth.initialize();
  store.session.value = {user: signedIn ?? user, status: 'active', admin: false, online: true};
  startData();
  if (desktop.available) await desktop.start();
  await new Promise(resolve => {
    if (store.library.loaded.peek()) { resolve(); return; }
    const off = store.library.loaded.subscribe(v => { if (v) { off(); resolve(); } });
  });
  return {desktop};
}

const waitFor = (read, timeoutMs = 5000) => new Promise((resolve, reject) => {
  const started = performance.now();
  const step = () => {
    const value = read();
    if (value) { resolve(value); return; }
    if (performance.now() - started > timeoutMs) { reject(new Error('jobs harness: timed out')); return; }
    setTimeout(step, 50);
  };
  step();
});

/** An upload entry as src/library/upload.js keeps them (LB2a). */
function sampleUpload({id, name, loaded, total, state, error = null}) {
  const progress = signal({loaded, total});
  const st = signal(state);
  return {id, name, deviceId: 'dev1', progress, state: st, error, cancel() { st.value = 'canceled'; }, promise: Promise.resolve()};
}

async function jobsPart(el, h, query, fixture) {
  const only = query.get('only');
  if (only) {
    const kinds = new Set(only.split(','));
    fixture.update(db => { db.jobs = db.jobs.filter(j => kinds.has(j.kind ?? 'separate')); });
  }
  const {desktop} = await startApp(fixture);
  const [{mountTopbar}, {registry}, jobs, {startDispatcher}] = await Promise.all([
    import('/src/app/topbar.js'), import('/src/app/commands.js'), import('/src/library/jobs.js'), import('/src/app/dispatch.js'),
    import('/src/app/global-commands.js'),
  ]);
  const router = fakeRouter();
  registry.provide('router', () => router);
  startDispatcher({registry});

  el.style.padding = '0';
  el.style.overflow = 'hidden';
  const header = h('header', {});
  const content = h('div', {attrs: {'data-scroller': true}},
    h('div', {class: 'app-content'}, h('h1', {style: {fontSize: 'var(--fs-32)', paddingBlock: 'var(--s6) var(--s3)'}}, 'Library')));
  const app = h('div', {class: 'app-frame', dataset: {chrome: 'topbar'}}, header,
    h('main', {class: 'app-main shell-main'}, h('div', {class: 'shell-outlet'}, content)));
  el.replaceChildren(app);
  const topbar = mountTopbar(header, {router, store, desktop, registry});
  registry.provide('topbar', () => topbar);

  const model = jobs.createJobsModel({router});
  const chip = jobs.mountJobsChip(topbar.jobsSlot, {model});

  const uploads = [];
  if (query.get('uploads') === '1') {
    uploads.push(sampleUpload({id: 'up-a', name: 'garage-take-4.wav', loaded: 12.4 * MB, total: 31.2 * MB, state: 'uploading'}));
    uploads.push(sampleUpload({id: 'up-b', name: 'notes.pdf', loaded: 0, total: 0, state: 'error',
      error: {code: 'unreadable', message: 'notes.pdf: the file is not audio (application/pdf).'}}));
    store.library.uploads.value = [...uploads];
  }
  if (query.get('found') === '1') {
    await fixture.call('mutation', 'jobs:createBeatDetection', {songId: 'glasshouse'});
    await waitFor(() => model.items.peek().find(i => i.status === 'done' && i.songId === 'glasshouse'), 8000);
  }

  const focus = query.get('focus');
  if (query.get('open') === '1' || focus) jobs.openJobsPopover({anchor: topbar.jobsSlot, focusJobId: focus, model});
  window.__jobs = {model, store, router, topbar, chip, uploads, jobs};
}

async function reviewPart(el, h, query, fixture) {
  if (query.get('suggest') === '1') {
    fixture.update(db => {
      const song = db.songs.find(s => s.id === 'counting');
      song.metadataSuggestion = {recordingId: 'b6a1c0de-0000-4000-8000-0000000000aa', releaseId: 'c0ffee00-0000-4000-8000-0000000000bb',
        title: 'Counting Stars', artist: 'Ada Moreno & The Tide', album: 'Harbor Lights (Deluxe)', year: '2018'};
    });
  }
  await startApp(fixture);
  const [{ReviewChip}, {registry}, {startDispatcher}] = await Promise.all([import('/src/library/review-chip.js'), import('/src/app/commands.js'),
    import('/src/app/dispatch.js')]);
  const router = fakeRouter();
  registry.provide('router', () => router);
  startDispatcher({registry});
  const songs = () => [...store.library.songs.peek().values()];
  const review = songs().filter(s => s.reviewMetadata);
  const chips = new Map();
  const grid = h('div', {style: {display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 'var(--s5)', padding: 'var(--s6)'}});
  for (const song of review) {
    const chip = ReviewChip(song, {router});
    chips.set(song.id, chip);
    const cover = song.coverUrl ? h('img', {src: song.coverUrl, alt: '', style: {width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block'}})
      : h('div', {style: {width: '100%', aspectRatio: '1', background: 'var(--surface-2)'}});
    grid.append(h('article', {class: 'lb1b-sample-card', dataset: {songId: song.id}, style: {display: 'flex', flexDirection: 'column', gap: 'var(--s2)'}},
      cover, h('p', {style: {margin: 0, fontWeight: 'var(--fw-semibold)'}}, song.title),
      h('p', {style: {margin: 0, color: 'var(--ink-2)', fontSize: 'var(--fs-14)'}}, song.artist || 'Unknown artist'), chip.el));
  }
  el.replaceChildren(h('div', {attrs: {'data-scroller': true}, style: {height: '100%', overflow: 'auto'}}, grid));
  // Rows update by id as the songs list changes (a confirm clears reviewMetadata).
  store.library.songs.subscribe(map => { for (const [id, chip] of chips) { const s = map.get(id); if (s) chip.update(s); } });
  const open = query.get('open');
  if (open && chips.has(open)) chips.get(open).open();
  window.__jobs = {store, router, chips};
}

export default async function mount(el, {fixture, query, h}) {
  const part = query.get('part') ?? 'jobs';
  if (part === 'review') return reviewPart(el, h, query, fixture);
  return jobsPart(el, h, query, fixture);
}
