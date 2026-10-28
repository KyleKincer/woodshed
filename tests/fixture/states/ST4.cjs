// ST4's states: the Stage frame (architecture §9.10 ST4, §10.4 "ST4–ST11" captures, §11.4).
//
// stage.js imports ST5's hud.js and controls.js and ST6's strip.js (same-wave peers, §9.0): every
// state lists them in opts.requires (skipped until they merge, run with --strict-requires at I2a).
// Surfaces, menus and sheets of later waves render "Not built yet" inside the frame (D2), so the
// states allow the placeholder text (structure.placeholder) until wave 2b.
//
// The harness (/__harness/frame, a real test session; tests/harness/stage/frame.harness.js):
//   st4-frame                rail (laptop) / band (iPad): the music column 1176 × 844 beside the 264 px rail;
//                            the band's full-width music above the strip and the 88 px dock; targets
//   st4-frame-kit            Distance Kit: the 312 px rail
//   st4-frame-focus          Focus: the 120 px mini rail; on the band the strip and dock go, height only
//   st4-frame-relayout       laptop → 820×1180 → band, once, 150 ms after the resize settles
//   st4-frame-resume         the resume chip "Back at **Chorus loop** · 75% · Drums out [Start over]",
//                            read as it appears (it lives RESUME_MS = 4 s from mount, not from data-load-phase=ready)
//   st4-frame-loading        interactive loading: live controls, data-load-phase not ready
//   st4-frame-error          the storage error in the music area; the controls aria-disabled with the reason
//   st4-frame-error-missing  missing stems: the stems named, [Try again] [Re-split]
//   st4-frame-review         "Is this the right recording?" floating over the music; Play hides it and
//                            the music box stays exactly where it was (spec §4.10)
//   st4-frame-offer          "Bars found while you were away [Use them] [Not now]" in the status line
//   st4-frame-markers        the markers offer after the song becomes mapped
//   st4-frame-unmapped       an unmapped song (the Wave page placeholder)
//   st4-frame-sheet          J opens the Spots sheet: a rail popover left of the controls / a bottom sheet
//   st4-frame-esc            Esc stopped leaves (laptop); on iPad it never does
// The app on the fixture database:
//   st4-app-stage            /s/glasshouse reaches load and transport phases with the dark Stage theme
//   st4-app-back             Library → card → Stage → Back: the Library again, the card focused, history idx − 1
//   st4-app-transition       the first and the second Library → Stage opens of a page load each run
//                            document.startViewTransition (Chromium);
//                            with fx-nofeature=viewtransition it does not, and the Stage still opens
//   st4-app-review           /s/shuffle (an unconfirmed search) shows the recording banner
//   st4-app-setlist          /s/lowtide?set=set-friday: Alt+↓ replaces the entry with the next song in the set
//   st4-app-resume           /s/lowtide (saved v2 practice): the resume chip in the status line, read as it appears
'use strict';

const {checkTargets} = require('../probes/probe-targets.cjs');

const PEERS = ['src/stage/hud.js', 'src/stage/controls.js', 'src/stage/strip.js'];
const NOW = 'fx-now=2026-10-28T12:00:00Z';
const frame = (query = '') => `/__harness/frame?place=stage${query ? `&${query}` : ''}`;
const app = (path, query = '') => `${path}?fx-reset=1&${NOW}${query ? `&${query}` : ''}`;
const FRAME = {requires: PEERS, structure: {placeholder: true}};
const APP = {requires: PEERS, ready: 'stage', structure: {placeholder: true}};

/** Runs in the page: the frame's boxes. */
function frameFacts() {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el || (el.checkVisibility && !el.checkVisibility())) return null;
    const r = el.getBoundingClientRect();
    return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)};
  };
  const root = document.querySelector('.stage');
  return {
    layout: root?.getAttribute('data-stage-layout') ?? null,
    distance: root?.getAttribute('data-distance') ?? null,
    focus: !!root?.hasAttribute('data-focus'),
    main: box('.stage-main'), music: box('.stage-music'), strip: box('.stage-strip'), controls: box('.stage-controls'), hud: box('.stage-hud'),
    status: box('.stage-status'),
    loadPhase: document.documentElement.dataset.loadPhase ?? null,
    transportPhase: document.documentElement.dataset.transportPhase ?? null,
    vw: innerWidth, vh: innerHeight,
  };
}

const statusText = (page) => page.evaluate(() => (document.querySelector('.stage-status')?.textContent ?? '').replace(/\s+/g, ' ').trim());
const loaded = (t) => t.loadPhase('ready');

/**
 * The resume chip, read the moment it shows. stage.js clears it RESUME_MS (4 s) of wall-clock time
 * after mount (spec §4.12 step 5), and under load mount → data-load-phase=ready alone can take
 * longer than that, so these states run with opts.ready false: the poll starts at the page's load
 * event, before the Stage mounts, and the text, the bold part and the [Start over] button are read
 * in the same frame that first shows "Back at" (no second round trip for the chip to expire in).
 * Then the route's (or harness's) view-ready is awaited as the runner would have.
 */
async function readResumeChip(page, t, route) {
  const handle = await page.waitForFunction(() => {
    const root = document.documentElement;
    if (root.dataset.harnessError) return {harnessError: root.dataset.harnessError};
    const el = document.querySelector('.stage-status');
    const text = (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text.startsWith('Back at')) return false;
    const visible = (node) => !!node && (!node.checkVisibility || node.checkVisibility()) && node.getBoundingClientRect().width > 0;
    const startOver = [...el.querySelectorAll('button')].find((b) => b.textContent.replace(/\s+/g, ' ').trim() === 'Start over');
    return {text, strong: el.querySelector('.stage-status-strong')?.textContent ?? null, startOver: visible(startOver)};
  }, null, {timeout: 30_000}).catch((error) => {
    throw new Error(`expectation failed: the resume chip never showed (${error.message.split('\n')[0]})`);
  });
  const chip = await handle.jsonValue();
  if (chip.harnessError) throw new Error(`harness: ${chip.harnessError}`);
  await t.ready(route);
  const harnessError = await page.evaluate(() => document.documentElement.dataset.harnessError);
  if (harnessError) throw new Error(`harness: ${harnessError}`);
  return chip;
}

async function expectTargets(t, page) {
  const problems = await checkTargets(page);
  t.expect(!problems.length, `targets: ${JSON.stringify(problems.slice(0, 6))}`);
}

module.exports = [
  // ------------------------------------------------------------------ the harness
  {
    name: 'st4-frame',
    url: frame(),
    opts: FRAME,
    async fn(page, t) {
      await loaded(t);
      const f = await page.evaluate(frameFacts);
      if (t.device === 'laptop') {
        t.expect(f.layout === 'rail', `laptop is the rail (${f.layout})`);
        t.expect(f.main.w === 1176 && f.main.h === 900, `the music column is 1176 wide at full height (${JSON.stringify(f.main)})`);
        t.expect(f.music.h === 844 && f.strip.h === 56, `music 844 above a 56 px strip (${f.music.h}, ${f.strip.h})`);
        t.expect(f.hud.w === 264 && f.controls.w === 264 && f.hud.x === 1176, `the 264 px rail on the right (${JSON.stringify(f.hud)})`);
        t.expect(f.controls.y + f.controls.h === 900, 'the controls sit at the bottom of the rail');
      } else {
        t.expect(f.layout === 'band', `iPad portrait is the band (${f.layout})`);
        t.expect(f.music.w === f.vw, `the music spans the full width (${f.music.w})`);
        t.expect(f.strip.h === 56 && f.controls.h >= 88, `strip 56, dock ≥ 88 (${f.strip.h}, ${f.controls.h})`);
        t.expect(f.controls.y + f.controls.h === f.vh, 'the dock is at the bottom');
        t.expect(f.hud.y === 0 && f.music.y >= f.hud.h, 'the HUD band is on top');
      }
      t.expect(f.transportPhase === 'stopped', `transport stopped (${f.transportPhase})`);
      const names = await page.evaluate(() => ({
        music: !!document.querySelector('[role=region][aria-label="Music"]'),
        status: document.querySelector('.stage-status')?.getAttribute('role'),
        theme: getComputedStyle(document.querySelector('.stage-music')).backgroundColor,
      }));
      t.expect(names.music && names.status === 'status', `the Music region and the status line (${JSON.stringify(names)})`);
      t.expect(names.theme === 'rgb(8, 9, 10)', `the Stage is always dark (${names.theme})`);
      await expectTargets(t, page);
    },
  },
  {
    name: 'st4-frame-kit',
    url: frame('distance=kit'),
    opts: {...FRAME, devices: ['laptop']},
    async fn(page, t) {
      await loaded(t);
      const f = await page.evaluate(frameFacts);
      t.expect(f.distance === 'kit' && f.hud.w === 312 && f.main.w === 1440 - 312, `Kit: the 312 px rail (${JSON.stringify(f.hud)})`);
    },
  },
  {
    name: 'st4-frame-focus',
    url: frame('focus=1'),
    opts: FRAME,
    async fn(page, t) {
      await loaded(t);
      const f = await page.evaluate(frameFacts);
      t.expect(f.focus, 'Focus is on');
      if (t.device === 'laptop') {
        t.expect(f.controls.w === 120 && f.main.w === 1320, `the 120 px mini rail, music 1320 wide (${f.controls.w}, ${f.main.w})`);
      } else {
        t.expect(!f.strip && !f.controls, 'the band hides the strip and the dock');
        t.expect(f.music.w === f.vw, 'the width is unchanged');
        const tapped = await page.evaluate(async () => {
          document.querySelector('.stage-reveal').dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
          await new Promise((r) => requestAnimationFrame(() => r()));
          const r = document.querySelector('.stage-controls').getBoundingClientRect();
          return {shown: r.height > 0, bottom: Math.round(r.bottom)};
        });
        t.expect(tapped.shown && tapped.bottom === f.vh, `a tap in the reveal zone shows the dock (${JSON.stringify(tapped)})`);
        await t.capture('revealed');
      }
    },
  },
  {
    name: 'st4-frame-relayout',
    url: frame(),
    opts: {...FRAME, devices: ['laptop'], capture: false},
    async fn(page, t) {
      await loaded(t);
      await page.setViewportSize({width: 820, height: 1180});
      const early = await page.evaluate(frameFacts);
      t.expect(early.layout === 'rail', 'no relayout before the resize settles');
      await page.waitForSelector('.stage[data-stage-layout="band"]', {timeout: 2000});
      const f = await page.evaluate(frameFacts);
      t.expect(f.music.w === 820 && f.controls.h >= 88, `one relayout to the band (${JSON.stringify(f.music)})`);
      await page.setViewportSize({width: 1440, height: 900});
      await page.waitForSelector('.stage[data-stage-layout="rail"]', {timeout: 2000});
    },
  },
  {
    name: 'st4-frame-resume',
    url: frame('practice=resume'),
    opts: {...FRAME, ready: false},
    async fn(page, t) {
      const chip = await readResumeChip(page, t, 'frame');
      t.expect(chip.text.startsWith('Back at Chorus loop · 75% · Drums out'), `the resume chip (${chip.text})`);
      t.expect(chip.strong === 'Chorus loop', `the bold part (${chip.strong})`);
      t.expect(chip.startOver, '[Start over]');
      await loaded(t);
    },
  },
  {
    name: 'st4-frame-loading',
    url: frame('loading=1'),
    opts: FRAME,
    async fn(page, t) {
      await t.loadPhase('signing');
      const f = await page.evaluate(() => ({
        disabled: document.querySelector('.stage-controls')?.getAttribute('aria-disabled'),
        error: !document.querySelector('.stage-error')?.hidden,
      }));
      t.expect(f.disabled == null && !f.error, `controls live while loading (${JSON.stringify(f)})`);
    },
  },
  {
    name: 'st4-frame-error',
    url: frame('error=storage'),
    opts: FRAME,
    async fn(page, t) {
      await t.loadPhase('error');
      const f = await page.evaluate(() => {
        const controls = document.querySelector('.stage-controls');
        const reason = document.getElementById(controls.getAttribute('aria-describedby'));
        return {disabled: controls.getAttribute('aria-disabled'), reason: reason?.textContent ?? '', panel: document.querySelector('.stage-error')?.textContent ?? ''};
      });
      t.expect(f.disabled === 'true' && f.reason.includes('Couldn’t reach storage'), `aria-disabled with the reason (${JSON.stringify(f)})`);
      t.expect(await page.getByRole('button', {name: 'Try again'}).isVisible(), '[Try again]');
    },
  },
  {
    name: 'st4-frame-error-missing',
    url: frame('error=missing'),
    opts: FRAME,
    async fn(page, t) {
      await t.loadPhase('error');
      const panel = await page.evaluate(() => document.querySelector('.stage-error')?.textContent ?? '');
      t.expect(panel.includes('Missing stem audio for Drums, Bass, Vocals & Other.'), `the stems named (${panel})`);
      t.expect(await page.getByRole('button', {name: /Re-split/}).isVisible(), '[Re-split] (its web reason visible)');
    },
  },
  {
    name: 'st4-frame-review',
    url: frame('review=1'),
    opts: FRAME,
    async fn(page, t) {
      await loaded(t);
      const text = await page.evaluate(() => (document.querySelector('.stage-banners')?.textContent ?? '').replace(/\s+/g, ' '));
      t.expect(text.includes('Is this the right recording?') && text.includes('Harbor Lights — Ada Moreno (Official Audio) · YouTube · 3:41'), `the banner (${text})`);
      for (const name of ['Yes', 'Wrong song — search again', 'Delete this one']) {
        t.expect(await page.getByRole('button', {name, exact: true}).isVisible(), `[${name}]`);
      }
      const f = await page.evaluate(frameFacts);
      const banner = await page.evaluate(() => {
        const r = document.querySelector('.stage-review')?.getBoundingClientRect();
        return r ? {y: Math.round(r.y), bottom: Math.round(r.bottom)} : null;
      });
      t.expect(f.music.y === f.main.y && banner && banner.y >= f.music.y && banner.bottom <= f.music.y + f.music.h,
        `the banner floats over the music, out of its flow (${JSON.stringify({music: f.music, main: f.main, banner})})`);
      await page.evaluate(() => window.__frame.run('transport.playStop'));
      await t.transportPhase('playing');
      const during = await page.evaluate(frameFacts);
      t.expect(JSON.stringify(during.music) === JSON.stringify(f.music) && JSON.stringify(during.strip) === JSON.stringify(f.strip),
        `Play moves nothing (${JSON.stringify({stopped: f.music, playing: during.music})})`);
      t.expect(await page.evaluate(() => document.querySelector('.stage-review')?.hidden === true), 'the banner hides while playing');
      await page.evaluate(() => window.__frame.run('transport.stop'));
      await t.transportPhase('stopped');
      const after = await page.evaluate(frameFacts);
      t.expect(JSON.stringify(after.music) === JSON.stringify(f.music), 'Stop moves nothing either');
      t.expect(await page.evaluate(() => document.querySelector('.stage-review')?.hidden === false), 'the banner is back when stopped');
    },
  },
  {
    name: 'st4-frame-offer',
    url: frame('offer=1'),
    opts: FRAME,
    async fn(page, t) {
      await loaded(t);
      const text = await statusText(page);
      t.expect(text.includes('Bars found while you were away'), `the offer (${text})`);
      t.expect(await page.getByRole('button', {name: 'Use them'}).isVisible() && await page.getByRole('button', {name: 'Not now'}).isVisible(), '[Use them] [Not now]');
    },
  },
  {
    name: 'st4-frame-markers',
    url: frame('markers=1'),
    opts: FRAME,
    async fn(page, t) {
      await loaded(t);
      const text = await statusText(page);
      t.expect(text.includes('Turn 2 markers into sections'), `the markers offer (${text})`);
      t.expect(await page.getByRole('button', {name: 'Turn into sections'}).isVisible(), '[Turn into sections]');
    },
  },
  {
    name: 'st4-frame-unmapped',
    url: frame('mapped=0'),
    opts: FRAME,
    async fn(page, t) {
      await loaded(t);
      const later = await page.evaluate(() => document.querySelector('.stage-surface-later')?.textContent ?? '');
      t.expect(later.includes('Wave page'), `the Wave page placeholder (${later})`);
    },
  },
  {
    name: 'st4-frame-sheet',
    url: frame(),
    opts: FRAME,
    async fn(page, t) {
      await loaded(t);
      await page.evaluate(() => window.__frame.run('spot.list'));
      const sheet = await page.waitForSelector('[data-sheet="spots"]', {state: 'visible', timeout: 5000});
      const presentation = await sheet.getAttribute('data-presentation');
      t.expect(presentation === (t.device === 'laptop' ? 'popover' : 'bottom'), `rail popover / band sheet (${presentation})`);
      const playing = await page.evaluate(() => document.documentElement.dataset.transportPhase);
      t.expect(playing === 'stopped', 'a sheet never touches playback');
    },
  },
  {
    name: 'st4-frame-esc',
    url: frame(),
    opts: {...FRAME, capture: false},
    async fn(page, t) {
      await loaded(t);
      await page.keyboard.press('Escape');
      const calls = await page.evaluate(() => window.__frame.router.calls.map((c) => c[0]));
      if (t.device === 'laptop') t.expect(calls.includes('back'), `Esc stopped leaves on a laptop (${calls})`);
      await page.goto(`${t.base}${frame('fx-platform=ipad')}`);
      await page.waitForSelector('html[data-view-ready="frame"]');
      await loaded(t);
      await page.keyboard.press('Escape');
      const ipad = await page.evaluate(() => window.__frame.router.calls.map((c) => c[0]));
      t.expect(!ipad.includes('back'), `Esc never leaves on an iPad (${ipad})`);
    },
  },

  // ------------------------------------------------------------------ the app
  {
    name: 'st4-app-stage',
    url: app('/s/glasshouse'),
    opts: APP,
    async fn(page, t) {
      await loaded(t);
      const f = await page.evaluate(frameFacts);
      t.expect(f.layout === (t.device === 'laptop' ? 'rail' : 'band'), `layout (${f.layout})`);
      const root = await page.evaluate(() => ({place: document.documentElement.dataset.place, theme: document.documentElement.dataset.stageTheme,
        stage: window.__woodshed.store.stage.value}));
      t.expect(root.place === 'stage' && root.theme === 'dark', `the dark Stage (${JSON.stringify(root)})`);
      t.expect(root.stage?.songId === 'glasshouse' && root.stage.playing === false, `store.stage (${JSON.stringify(root.stage)})`);
    },
  },
  {
    name: 'st4-app-back',
    url: app('/'),
    opts: {requires: PEERS, ready: 'library', structure: {placeholder: true}, capture: false},
    async fn(page, t) {
      await page.locator('[data-key="song:glasshouse"] .lib-open-cover').click();
      await t.ready('stage');
      await loaded(t);
      const idx = await page.evaluate(() => history.state?.idx ?? null);
      await page.evaluate(() => window.__woodshed.commands.run('stage.leave'));
      await t.ready('library');
      const focus = await page.waitForFunction(() => {
        const a = document.activeElement;
        return a && a !== document.body ? {inCard: !!a.closest('[data-key="song:glasshouse"]'), visible: a.checkVisibility()} : null;
      }, null, {timeout: 5000}).then((h) => h.jsonValue(), () => null);
      const after = await page.evaluate(() => ({idx: history.state?.idx ?? null, path: location.pathname}));
      t.expect(after.path === '/', `back on the Library (${after.path})`);
      t.expect(focus?.inCard && focus.visible, `the opened card is focused (${JSON.stringify(focus)})`);
      t.expect(idx != null && after.idx === idx - 1, `history went back one entry (idx ${idx} → ${after.idx})`);
    },
  },
  {
    name: 'st4-app-transition',
    url: app('/'),
    opts: {requires: PEERS, ready: 'library', structure: {placeholder: true}, devices: ['laptop'], capture: false},
    async fn(page, t) {
      const open = async () => {
        await page.locator('[data-key="song:glasshouse"] .lib-open-cover').click();
        await t.ready('stage');
        await loaded(t);
      };
      await page.evaluate(() => {
        window.__transitions = 0;
        const start = document.startViewTransition?.bind(document);
        if (start) document.startViewTransition = (fn) => { window.__transitions++; return start(fn); };
      });
      await open();
      const first = await page.evaluate(() => window.__transitions);
      t.expect(first === 1, `the first open of the page load runs one View Transition (${first})`);
      await page.evaluate(() => window.__woodshed.commands.run('stage.leave'));
      await t.ready('library');
      await open();
      const n = await page.evaluate(() => window.__transitions);
      t.expect(n === 2, `the second open runs one more (${n})`);
      t.expect(await page.evaluate(() => !document.querySelector('.stage-entry-ghost')), 'the ghost cover is gone');
      await page.goto(`${t.base}${app('/', 'fx-nofeature=viewtransition')}`);
      await t.ready('library');
      await open();
      await page.evaluate(() => window.__woodshed.commands.run('stage.leave'));
      await t.ready('library');
      await open();
      t.expect(await page.evaluate(() => typeof document.startViewTransition === 'undefined'), 'no View Transitions in this browser');
    },
  },
  {
    name: 'st4-app-review',
    url: app('/s/shuffle'),
    opts: APP,
    async fn(page, t) {
      await loaded(t);
      const text = await page.evaluate(() => (document.querySelector('.stage-banners')?.textContent ?? '').replace(/\s+/g, ' '));
      t.expect(text.includes('Is this the right recording?') && text.includes('Sunday Shuffle'), `the banner (${text})`);
    },
  },
  {
    name: 'st4-app-setlist',
    url: app('/s/lowtide', 'set=set-friday'),
    opts: {...APP, devices: ['laptop'], capture: false},
    async fn(page, t) {
      await loaded(t);
      await page.waitForFunction(() => window.__woodshed.commands.isEnabled('setlist.next'), null, {timeout: 5000});
      const idx = await page.evaluate(() => history.state?.idx);
      await page.keyboard.press('Alt+ArrowDown');
      await page.waitForFunction(() => location.pathname === '/s/secondwind', null, {timeout: 5000});
      await t.ready('stage');
      await loaded(t);
      const after = await page.evaluate(() => ({idx: history.state?.idx, search: location.search}));
      t.expect(after.idx === idx && after.search.includes('set=set-friday'), `the next song replaces the entry and keeps the set (${JSON.stringify(after)})`);
    },
  },
  {
    name: 'st4-app-resume',
    url: app('/s/lowtide'),
    opts: {...APP, ready: false},
    async fn(page, t) {
      const chip = await readResumeChip(page, t, 'stage');
      t.expect(chip.text.startsWith('Back at'), `the resume chip (${chip.text})`);
      t.expect(chip.startOver, '[Start over]');
      await loaded(t);
    },
  },
];
