// FX1's states: the fixture itself, end to end in Chromium.
//   fx1-harness-smoke   captures the fixture's own harness page (4 variants)
//   fx1-fakes           every fake of preamble.js, through the APIs the app uses
//   fx1-db-persist      sessionStorage persistence across reloads and a new tab, fx-reset, seed switches
//   fx1-switches        fx-platform, fx-nofeature, fx-prefs and a legacy key
//   fx1-structure       each structural check catches its problem on a real page
//   fx1-touch-count     CDP multi-touch and the counting wrapper (taps and gestures)
//   fx1-keys-count      the counting wrapper (keys, chords, typed characters, budgets)
//   fx1-waits           the runner's readiness waits and idle()
//   fx1-clock           fx-audio=manual with Playwright's page clock: t.advance and fixture.advance
//   fx1-app-boot        the app boots on the fixture database
'use strict';

const NOW = '2026-10-28T09:00:00.000Z';
const SMOKE = '/__harness/fixture-smoke';

/** Runs in the page: exercises every fake and returns what each one did. */
async function exerciseFakes() {
  const out = {};
  const ORIGIN = 'http://127.0.0.1:47831', AUTH = {authorization: `Bearer ${'f'.repeat(64)}`};
  const caught = async fn => { try { await fn(); return null; } catch (e) { return e.name; } };

  out.date = {now: Date.now(), instance: new Date() instanceof Date, called: typeof Date(), parsed: new Date(2020, 0, 2).getFullYear()};

  const db = window.fixture.db();
  db.songs.length = 0;
  out.db = {songs: window.fixture.db().songs.length, rehearsal: window.fixture.db().songs[0].id};

  const sentinel = await navigator.wakeLock.request('screen');
  let releaseEvents = 0;
  sentinel.addEventListener('release', () => releaseEvents++);
  const heldBefore = window.fixture.wakeLock.state().held;
  window.fixture.wakeLock.deny();
  const denied = await caught(() => navigator.wakeLock.request('screen'));
  window.fixture.wakeLock.grant();
  const again = await navigator.wakeLock.request('screen');
  out.wakeLock = {heldBefore, released: sentinel.released, releaseEvents, denied, againReleased: again.released, state: window.fixture.wakeLock.state()};

  const access = await navigator.requestMIDIAccess();
  const input = [...access.inputs.values()][0];
  const messages = [];
  input.onmidimessage = e => messages.push([...e.data]);
  window.fixture.midi.note(60, 100);
  window.fixture.midi.cc(64, 127);
  window.fixture.midi.deny();
  out.midi = {inputs: access.inputs.size, name: input.name, messages, denied: await caught(() => navigator.requestMIDIAccess())};

  let pressed = null;
  navigator.mediaSession.setActionHandler('nexttrack', details => { pressed = details.action; });
  navigator.mediaSession.metadata = new MediaMetadata({title: 'Glasshouse', artist: 'Northbound'});
  navigator.mediaSession.playbackState = 'playing';
  const handled = window.fixture.media.press('nexttrack');
  out.media = {handled, pressed, unhandled: window.fixture.media.press('seekto'), state: window.fixture.media.state()};

  let deferred = null, installed = false;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; });
  window.addEventListener('appinstalled', () => { installed = true; });
  const notCancelled = window.fixture.install.offer();
  const choice = await deferred.prompt();
  await new Promise(r => setTimeout(r, 20));
  out.install = {notCancelled, outcome: choice.outcome, userChoice: (await deferred.userChoice).outcome, installed, state: window.fixture.install.state()};

  await navigator.share({title: 'Glasshouse', url: 'https://woodshed.example/share/x'});
  window.fixture.share.reject();
  const rejected = await caught(() => navigator.share({url: 'https://x.example'}));
  out.share = {calls: window.fixture.share.calls().length, rejected, canShare: navigator.canShare({url: 'https://x.example'})};

  await navigator.clipboard.writeText('copied link');
  out.clipboard = {read: await navigator.clipboard.readText(), text: window.fixture.clipboard.text()};

  out.upload = await new Promise(resolve => {
    const xhr = new XMLHttpRequest(), progress = [];
    xhr.open('POST', `${ORIGIN}/upload`);
    xhr.setRequestHeader('Authorization', AUTH.authorization);
    xhr.setRequestHeader('X-Filename', encodeURIComponent('take 1.wav'));
    xhr.upload.onprogress = e => progress.push([e.loaded, e.total]);
    xhr.onload = () => resolve({status: xhr.status, id: JSON.parse(xhr.responseText).id, progress, calls: window.fixture.upload.calls()});
    xhr.onerror = () => resolve({status: 'error'});
    xhr.send(new Blob([new Uint8Array(50_000)]));
  });

  const json = async (path, init = {}) => { const r = await fetch(`${ORIGIN}${path}`, {headers: AUTH, ...init}); return {status: r.status, body: await r.json()}; };
  out.companion = {
    status: await json('/status'),
    unauthorised: (await fetch(`${ORIGIN}/status`)).status,
    playlist: await json(`/resolve?url=${encodeURIComponent('https://www.youtube.com/playlist?list=PL1')}`),
    resolved: await json(`/resolve?url=${encodeURIComponent('https://www.youtube.com/watch?v=abcdefgh')}`),
    search: await json('/search?q=glasshouse&n=5'),
    empty: await json('/search?q=zzz&n=5'),
  };

  const bridge = window.woodshedDesktop, phases = [], commands = [];
  bridge.onProcessorState(s => phases.push(s.phase));
  const offCommand = bridge.onCommand(c => commands.push(c));
  bridge.registerMenu([{menu: 'file', items: [{id: 'library.add', label: 'Add Songs…', accelerator: 'CmdOrCtrl+N', enabled: true}]}]);
  window.fixture.desktop.command('app.shortcuts', 'global');
  offCommand();
  window.fixture.desktop.command('app.shortcuts');
  let flushed = 0;
  bridge.onFlushRequest(async () => { flushed++; });
  bridge.setActivity({playing: true, songOpen: true, keepAwake: true});
  const info = await bridge.info();
  out.bridge = {
    frozen: Object.isFrozen(bridge), port: info.companion.port, processor: info.processor.phase,
    restart: await bridge.restartProcessor(), phases, commands,
    menu: window.fixture.desktop.menu(), flush: await window.fixture.desktop.flush(), flushed,
    notified: await bridge.notify({title: 'Glasshouse is ready', body: 'Open it', route: '/s/glasshouse'}),
    notifications: window.fixture.desktop.notifications().length, activity: window.fixture.desktop.activity(),
    shortcuts: await bridge.setBackgroundShortcuts(true), mediaUrl: bridge.mediaUrl('blob:x'),
    methods: Object.keys(bridge).sort(),
  };

  const ctx = new AudioContext();
  const t0 = ctx.currentTime;
  await window.fixture.advance(100);
  out.audio = {t0, t1: ctx.currentTime, time: window.fixture.audio.time()};
  await ctx.close();
  return out;
}

const BRIDGE_METHODS = ['info', 'mediaUrl', 'notify', 'onCommand', 'onFlushRequest', 'onFullScreen', 'onNavigate', 'onOpenUpdates', 'onProcessorState', 'onUpdate', 'registerMenu', 'restartProcessor', 'setActivity', 'setBackgroundShortcuts', 'setTheme', 'update'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

module.exports = [
  {
    name: 'fx1-harness-smoke',
    url: `${SMOKE}?fx-now=${NOW}`,
    async fn(page, t) {
      t.expect(await page.getByRole('heading', {level: 1, name: 'Fixture'}).isVisible(), 'the harness heading renders');
      const songs = await page.getByRole('region', {name: 'Songs'}).getByRole('listitem').count();
      t.expect(songs === 12, `12 seed songs listed (got ${songs})`);
      t.expect(await page.locator('[data-volatile]').count() === 1, 'the clock is marked volatile');
    },
  },
  {
    name: 'fx1-fakes',
    url: `${SMOKE}?fx-desktop=1&fx-audio=manual&fx-now=${NOW}`,
    opts: {devices: ['laptop'], themes: ['light'], capture: false},
    async fn(page, t) {
      const r = await page.evaluate(exerciseFakes);
      t.expect(Math.abs(r.date.now - Date.parse(NOW)) < 120_000 && r.date.instance && r.date.called === 'string' && r.date.parsed === 2020, `fx-now moves Date (${JSON.stringify(r.date)})`);
      t.expect(r.db.songs === 12 && r.db.rehearsal === 'glasshouse', 'fixture.db() returns a deep copy');
      t.expect(r.wakeLock.heldBefore && r.wakeLock.released && r.wakeLock.releaseEvents === 1 && r.wakeLock.denied === 'NotAllowedError' && !r.wakeLock.againReleased && r.wakeLock.state.held, `wake lock grant/deny (${JSON.stringify(r.wakeLock)})`);
      t.expect(r.midi.inputs === 1 && same(r.midi.messages, [[0x90, 60, 100], [0xB0, 64, 127]]) && r.midi.denied === 'SecurityError', `MIDI (${JSON.stringify(r.midi)})`);
      t.expect(r.media.handled && r.media.pressed === 'nexttrack' && r.media.unhandled === false && r.media.state.metadata.title === 'Glasshouse' && r.media.state.playbackState === 'playing', `Media Session (${JSON.stringify(r.media)})`);
      t.expect(r.install.notCancelled === false && r.install.outcome === 'accepted' && r.install.userChoice === 'accepted' && r.install.installed, `install prompt (${JSON.stringify(r.install)})`);
      t.expect(r.share.calls === 2 && r.share.rejected === 'AbortError' && r.share.canShare, `share (${JSON.stringify(r.share)})`);
      t.expect(r.clipboard.read === 'copied link' && r.clipboard.text === 'copied link', 'clipboard');
      t.expect(r.upload.status === 200 && r.upload.id && r.upload.progress.length === 10 && same(r.upload.progress.at(-1), [50_000, 50_000]) && r.upload.calls[0].filename === 'take 1.wav' && r.upload.calls[0].auth, `XHR upload (${JSON.stringify(r.upload)})`);
      const c = r.companion;
      t.expect(c.status.status === 200 && c.status.body.connected && c.status.body.modelsReady.htdemucs_ft && c.unauthorised === 401, '/status');
      t.expect(c.playlist.status === 422 && c.playlist.body.code === 'playlist' && c.resolved.body.kind === 'url' && c.resolved.body.candidates.length === 1, '/resolve');
      t.expect(c.search.body.candidates.length === 5 && c.empty.body.candidates.length === 0, '/search');
      const b = r.bridge;
      t.expect(same(b.methods, BRIDGE_METHODS) && b.frozen, `every bridge method (${b.methods})`);
      t.expect(b.port === 47831 && b.processor === 'ready' && b.restart.port === 47831 && same(b.phases, ['restarting', 'ready']), 'processor state');
      t.expect(same(b.commands, [{id: 'app.shortcuts', source: 'global'}]) && b.menu[0].items[0].id === 'library.add', 'menu and commands');
      t.expect(b.flush.flushed && b.flushed === 1 && b.notified && b.notifications === 1 && b.activity.keepAwake && b.shortcuts.registered.length === 3 && b.mediaUrl === 'blob:x', 'flush, notify, activity, shortcuts');
      t.expect(r.audio.t0 === 0 && Math.abs(r.audio.t1 - 0.1) < 1e-9, `fx-audio=manual (${JSON.stringify(r.audio)})`);
    },
  },
  {
    name: 'fx1-db-persist',
    url: SMOKE,
    opts: {devices: ['laptop'], themes: ['light'], capture: false},
    async fn(page, t) {
      const title = () => page.evaluate(() => window.fixture.db().songs.find(s => s.id === 'glasshouse')?.title);
      await page.evaluate(() => window.fixture.update(db => { db.songs.find(s => s.id === 'glasshouse').title = 'Persisted title'; }));
      await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('fx-db')).data.songs[0].title === 'Persisted title');
      await page.reload(); await t.ready('fixture-smoke');
      t.expect(await title() === 'Persisted title', 'a reload keeps a change');
      const [tab] = await Promise.all([page.context().waitForEvent('page'), page.evaluate(() => { window.open(location.href); })]);
      await tab.waitForSelector('html[data-view-ready="fixture-smoke"]', {state: 'attached'});
      t.expect(await tab.evaluate(() => window.fixture.db().songs[0].title) === 'Persisted title', 'a tab opened from it starts from the same data');
      await tab.close();
      await page.goto(`${t.base}${SMOKE}?fx-library=empty`); await t.ready('fixture-smoke');
      t.expect(await page.evaluate(() => window.fixture.db().songs.length) === 0, 'another seed switch reseeds');
      await page.goto(`${t.base}${SMOKE}`); await t.ready('fixture-smoke');
      t.expect(await title() === 'Glasshouse', 'switching back reseeds again');
      await page.evaluate(() => window.fixture.update(db => { db.songs[0].title = 'Changed again'; }));
      await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('fx-db')).data.songs[0].title === 'Changed again');
      await page.goto(`${t.base}${SMOKE}?fx-reset=1`); await t.ready('fixture-smoke');
      t.expect(await title() === 'Glasshouse', 'fx-reset=1 starts from the seed');
    },
  },
  {
    name: 'fx1-switches',
    url: `${SMOKE}?fx-platform=ipad&fx-nofeature=anchor,popover,wakelock,midi,mediasession,viewtransition&fx-view=albums-list&fx-prefs=${encodeURIComponent(JSON.stringify({theme: 'dark', practice: {distance: 'kit'}}))}`,
    opts: {devices: ['laptop'], themes: ['light'], capture: false},
    async fn(page, t) {
      const r = await page.evaluate(() => ({
        platform: navigator.platform, touch: navigator.maxTouchPoints, uaData: 'userAgentData' in navigator, fixture: window.fixture.platform,
        wakeLock: 'wakeLock' in navigator, midi: 'requestMIDIAccess' in navigator, media: 'mediaSession' in navigator,
        popover: 'showPopover' in HTMLElement.prototype || 'popover' in HTMLElement.prototype, transition: typeof document.startViewTransition,
        anchor: CSS.supports('anchor-name: --a') || CSS.supports('position-anchor', '--a'), grid: CSS.supports('display: grid'),
        removed: window.fixture.removed, fakes: {wakeLock: !!window.fixture.wakeLock, midi: !!window.fixture.midi, media: !!window.fixture.media},
        prefs: JSON.parse(localStorage.getItem('ws.prefs')), view: JSON.parse(localStorage.getItem('ws.view')), early: window.__FIXTURE__,
      }));
      t.expect(r.platform === 'MacIntel' && r.touch === 5 && !r.uaData && r.fixture === 'ipad', `fx-platform=ipad (${JSON.stringify(r)})`);
      t.expect(!r.wakeLock && !r.midi && !r.media && !r.popover && r.transition === 'undefined' && !r.anchor && r.grid, `fx-nofeature (${JSON.stringify(r)})`);
      t.expect(r.removed.length === 6 && !r.fakes.wakeLock && !r.fakes.midi && !r.fakes.media, 'a removed feature is never faked');
      t.expect(r.prefs.v === 1 && r.prefs.theme === 'dark' && r.prefs.practice.distance === 'kit', `fx-prefs (${JSON.stringify(r.prefs)})`);
      t.expect(r.view.group === 'albums' && r.view.layout === 'list' && r.early === true, 'legacy keys and window.__FIXTURE__');
    },
  },
  {
    name: 'fx1-structure',
    url: SMOKE,
    opts: {devices: ['laptop'], themes: ['light'], capture: false},
    async fn(page, t) {
      for (const demo of ['overflow', 'overlap', 'clip', 'placeholder']) {
        await page.goto(`${t.base}${SMOKE}?demo=${demo}`); await t.ready('fixture-smoke');
        const problems = await t.structure();
        t.expect(problems.length === 1 && problems[0].startsWith(`${demo}:`), `the ${demo} check finds the demo problem (${JSON.stringify(problems)})`);
        t.expect((await t.structure({skip: [demo]})).length === 0, `opts.structure.skip turns the ${demo} check off`);
      }
      await page.goto(`${t.base}${SMOKE}`); await t.ready('fixture-smoke');
    },
  },
  {
    name: 'fx1-touch-count',
    url: SMOKE,
    opts: {devices: ['ipad'], themes: ['light'], capture: false},
    async fn(page, t) {
      await page.evaluate(() => {
        window.__touches = {max: 0, starts: 0};
        addEventListener('touchstart', e => { window.__touches.starts++; window.__touches.max = Math.max(window.__touches.max, e.touches.length); });
        addEventListener('touchmove', e => { window.__touches.max = Math.max(window.__touches.max, e.touches.length); });
      });
      const counter = await t.counter({mode: 'touch'});
      await counter.step('pinch the list', () => counter.touch.pinch({x: 400, y: 500}, {from: 80, to: 220}));
      await counter.step('tap the heading', () => counter.touch.tap(page.getByRole('heading', {level: 1})));
      const touches = await page.evaluate(() => window.__touches);
      t.expect(touches.max === 2, `two touch points at once (${JSON.stringify(touches)})`);
      const report = counter.assertBudget({actions: 2, taps: 1, gestures: 1});
      t.expect(report.totals.keys === 0, 'no keys');
      let refused = false;
      try { await counter.keyboard.press('Space'); } catch { refused = true; }
      t.expect(refused, 'a touch-only counter refuses keys');
    },
  },
  {
    name: 'fx1-keys-count',
    url: SMOKE,
    opts: {devices: ['laptop'], themes: ['light'], capture: false},
    async fn(page, t) {
      await page.evaluate(() => { const input = document.createElement('input'); input.setAttribute('aria-label', 'Search songs'); document.getElementById('harness').prepend(input); });
      const counter = await t.counter({mode: 'keys'});
      await counter.step('search', async () => { await counter.keyboard.press('Tab'); await counter.keyboard.type('glasshouse'); await counter.keyboard.press('Enter'); });
      await counter.step('palette', () => counter.keyboard.press('Mod+K'));
      const value = await page.getByRole('textbox', {name: 'Search songs'}).inputValue();
      t.expect(value === 'glasshouse', `typing reached the field (${value})`);
      const report = counter.assertBudget({actions: 2, keys: 3});
      t.expect(report.totals.typed === 10, 'typed characters are counted apart');
      let over = null;
      try { counter.assertBudget({keys: 2}); } catch (e) { over = e.message; }
      t.expect(over?.includes('3 keys > budget 2'), `an exceeded budget fails (${over})`);
    },
  },
  {
    name: 'fx1-waits',
    url: SMOKE,
    opts: {devices: ['laptop'], themes: ['light'], capture: false},
    async fn(page, t) {
      // The readiness attributes later views set (§11.4), set here after a delay; each wait resolves only then.
      await page.evaluate(() => setTimeout(() => {
        const el = document.getElementById('harness');
        Object.assign(el.dataset, {loadPhase: 'ready', transportPhase: 'playing', rendered: 'true', peaksReady: ''});
      }, 150));
      const before = Date.now();
      await Promise.all([t.loadPhase(), t.transportPhase('playing'), t.rendered(), t.peaksReady()]);
      t.expect(Date.now() - before >= 100, 'the waits resolved when the attributes appeared');
      let failed = null;
      await t.idle().catch(e => { failed = e.message; });
      t.expect(/window.__woodshed is not installed/.test(failed), `idle() needs the dev handle (${failed})`);
      await page.evaluate(() => { window.__woodshed = {idle: async () => 'flushed'}; });
      t.expect(await t.idle() === 'flushed', 'idle() awaits window.__woodshed.idle()');
    },
  },
  {
    name: 'fx1-clock',
    url: `${SMOKE}?fx-audio=manual`,
    opts: {devices: ['laptop'], themes: ['light'], capture: false, installClock: NOW},
    async fn(page, t) {
      const start = await page.evaluate(() => { window.__ctx = new AudioContext(); return {date: Date.now(), audio: window.__ctx.currentTime}; });
      await t.advance(100);
      await page.evaluate(() => window.fixture.advance(50));
      const end = await page.evaluate(() => ({date: Date.now(), audio: window.__ctx.currentTime}));
      t.expect(start.audio === 0 && Math.abs(end.audio - .15) < 1e-9, `audio time moved by 150 ms (${JSON.stringify(end)})`);
      // page.clock.install keeps time flowing, so the page clock moved by at least the 150 ms run on it.
      t.expect(end.date - start.date >= 150 && end.date - start.date < 1150, `the page clock moved with it (${end.date - start.date} ms)`);
      t.expect(Math.abs(start.date - Date.parse(NOW)) < 1000, 'page.clock.install started at the given time');
    },
  },
  {
    name: 'fx1-app-boot',
    url: '/',
    opts: {devices: ['laptop'], themes: ['light'], capture: false, structure: false, ready: false},
    async fn(page, t) {
      // 1.9 marks html[data-startup=ready]; the 2.0 shell marks html[data-view-ready] (§2.3).
      await page.waitForSelector('html[data-startup="ready"], html[data-view-ready]', {state: 'attached', timeout: 30_000});
      const fixture = await page.evaluate(() => ({fixture: window.__FIXTURE__, songs: window.fixture.db().songs.length}));
      t.expect(fixture.fixture === true && fixture.songs === 12, 'the app booted on the fixture database');
    },
  },
];
