// ED2's states: the Edit frame (architecture §9.14 ED2, §10.5 "ED2/ED3" captures and the Stage ↔ Edit
// flows, §11.4). Spec §5.0, wireframe §10.10.
//
// edit.js imports ED3's map/view.js, ED5's chart/chart-edit.js and ED6's details/details.js (same-wave
// peers, §9.0): every state lists them in opts.requires (skipped until they merge, run with
// --strict-requires at I3a).
//
// The harness (/__harness/edit, a real test session with neutral stand-in tab views; tests/harness/edit/edit.harness.js):
//   ed2-frame-map          laptop: the 48 px posture bar with its 2 px --edit top border, title and label, the
//                          320 px inspector on the right, the 56 px slim transport at the bottom; iPad portrait:
//                          the inspector as a 45% bottom sheet with its 56 px header and the landscape hint;
//                          the app theme (never the Stage's); no key-cap hints before keyboard use; targets
//   ed2-frame-collapsed    iPad: the sheet collapses to its 56 px header and the main area takes the room
//   ed2-frame-hints        laptop: a key press inside Edit shows the key-cap hints (Esc, ⌘Z, ⇧⌘Z)
//   ed2-frame-chart        "Editing drum chart": no inspector while the chart puts none there; Undo / Redo shown
//   ed2-frame-details      "Editing details": no inspector, no Undo / Redo
//   ed2-frame-bulk         the bulk Details bar "Editing details · 3 songs": Done only, no tabs or transport;
//                          Esc goes back with fallback '/'
//   ed2-frame-esc          Esc on Map with nothing typed is Done: replace with the song's Stage (no origin)
//   ed2-frame-sheet        the slim transport's speed chip opens the Speed sheet as a bottom sheet
// The app on the fixture database (the real tab views):
//   ed2-app-roundtrip      /s/glasshouse: Play, E → Edit · Map (pushed) with the music still playing and the app
//                          theme; the Chart tab replaces the entry; Done goes back to the Stage (history idx
//                          as before), still playing
//   ed2-app-deeplink       /s/glasshouse/edit/details opened directly: Done replaces it with the Stage
'use strict';

const {checkTargets} = require('../probes/probe-targets.cjs');

const PEERS = ['src/edit/map/view.js', 'src/edit/chart/chart-edit.js', 'src/edit/details/details.js'];
const NOW = 'fx-now=2026-10-28T12:00:00Z';
const harness = (query = '') => `/__harness/edit?place=edit${query ? `&${query}` : ''}`;
const app = (path, query = '') => `${path}?fx-reset=1&${NOW}${query ? `&${query}` : ''}`;
const FRAME = {requires: PEERS};

/** Runs in the page: the frame's boxes and theme facts. */
function frameFacts() {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el || (el.checkVisibility && !el.checkVisibility())) return null;
    const r = el.getBoundingClientRect();
    return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)};
  };
  const root = document.querySelector('.edit');
  const bar = document.querySelector('.edit-bar');
  const barStyle = bar ? getComputedStyle(bar) : null;
  // The token colours, resolved the way the page resolves them.
  const probe = document.createElement('span');
  probe.style.color = 'var(--edit)';
  probe.style.backgroundColor = 'var(--bg)';
  document.body.append(probe);
  const tokens = {edit: getComputedStyle(probe).color, bg: getComputedStyle(probe).backgroundColor};
  probe.remove();
  const visible = (el) => !!el && (!el.checkVisibility || el.checkVisibility());
  return {
    layout: root?.dataset.editLayout ?? null,
    inspectorState: root?.dataset.inspector ?? null,
    kbdHints: !!root?.hasAttribute('data-kbd-hints'),
    hintCaps: [...document.querySelectorAll('.edit-bar kbd[data-hint]')].filter(visible).length,
    bar: box('.edit-bar'), main: box('.edit-main'), inspector: box('.edit-inspector'), inspectorHead: box('.edit-inspector-head'),
    transport: box('.edit-transport'), slim: box('.edit-slim'),
    hint: visible(document.querySelector('.edit-inspector-hint')) ? document.querySelector('.edit-inspector-hint').textContent.trim() : null,
    label: document.querySelector('.edit-label')?.textContent ?? null,
    title: document.querySelector('.edit-title')?.textContent ?? null,
    h1: [...document.querySelectorAll('h1')].map((n) => n.textContent),
    tabs: [...document.querySelectorAll('.edit-bar [role=tab]')].map((n) => ({name: n.textContent.trim(), selected: n.getAttribute('aria-selected')})),
    undo: visible(document.querySelector('.edit-undo')), redo: visible(document.querySelector('.edit-redo')),
    border: barStyle ? {width: barStyle.borderTopWidth, style: barStyle.borderTopStyle, color: barStyle.borderTopColor} : null,
    rootBg: root ? getComputedStyle(root).backgroundColor : null,
    tokens,
    place: document.documentElement.dataset.place ?? null,
    vw: innerWidth, vh: innerHeight,
  };
}

async function expectTargets(t, page) {
  const problems = await checkTargets(page);
  t.expect(!problems.length, `targets: ${JSON.stringify(problems.slice(0, 6))}`);
}

/** The common posture-bar checks: 48 px tall, a 2 px --edit top border, the app theme. */
function expectBar(t, f) {
  t.expect(f.bar && f.bar.h === 48 && f.bar.y === 0 && f.bar.w === f.vw, `the posture bar is 48 px across the top (${JSON.stringify(f.bar)})`);
  t.expect(f.border?.width === '2px' && f.border.style === 'solid' && f.border.color === f.tokens.edit,
    `a 2 px --edit top border (${JSON.stringify(f.border)} vs ${f.tokens.edit})`);
  // The Stage tokens apply only on html[data-place=stage] (D3); data-stage-theme is a device pref that may stay set.
  t.expect(f.place === 'edit', `the app theme, not the Stage's (place ${f.place})`);
  t.expect(f.rootBg === f.tokens.bg, `the frame paints the app --bg (${f.rootBg} vs ${f.tokens.bg})`);
}

function expectTransport(t, f) {
  t.expect(f.slim && f.slim.h === 56, `the slim transport is 56 px (${JSON.stringify(f.slim)})`);
  t.expect(f.transport && f.transport.y + f.transport.h === f.vh, `at the bottom (${JSON.stringify(f.transport)})`);
}

const loaded = (t) => t.loadPhase('ready');

module.exports = [
  // ------------------------------------------------------------------ the harness
  {
    name: 'ed2-frame-map',
    url: harness(),
    opts: FRAME,
    async fn(page, t) {
      await loaded(t);
      const f = await page.evaluate(frameFacts);
      expectBar(t, f);
      expectTransport(t, f);
      t.expect(f.label === 'Editing map' && f.title === 'Glasshouse' && f.h1.length === 1 && f.h1[0] === 'Glasshouse',
        `title and label (${f.title}, ${f.label}, ${JSON.stringify(f.h1)})`);
      t.expect(JSON.stringify(f.tabs.map((x) => x.name)) === '["Map","Chart","Details"]' && f.tabs[0].selected === 'true', `the tabs (${JSON.stringify(f.tabs)})`);
      t.expect(f.undo && f.redo, 'Undo and Redo are shown on Map');
      t.expect(!f.kbdHints && f.hintCaps === 0, `no key-cap hints before keyboard use (${f.kbdHints}, ${f.hintCaps})`);
      const bodyTop = f.bar.h, bodyBottom = f.transport.y;
      if (t.device === 'laptop') {
        t.expect(f.layout === 'wide' && f.inspectorState === 'open', `laptop: the right column (${f.layout}, ${f.inspectorState})`);
        t.expect(f.inspector.w === 320 && f.inspector.x === f.vw - 320, `the 320 px inspector on the right (${JSON.stringify(f.inspector)})`);
        t.expect(f.main.w === f.vw - 320 && f.main.y === bodyTop && f.main.h === bodyBottom - bodyTop, `main beside it (${JSON.stringify(f.main)})`);
        t.expect(f.inspectorHead === null && f.hint === null, 'no sheet header and no landscape hint on a laptop');
      } else {
        t.expect(f.layout === 'portrait' && f.inspectorState === 'open', `iPad portrait: the bottom sheet (${f.layout}, ${f.inspectorState})`);
        const body = bodyBottom - bodyTop;
        t.expect(Math.abs(f.inspector.h - body * 0.45) <= 1 && f.inspector.w === f.vw && f.inspector.y + f.inspector.h === bodyBottom,
          `the sheet is 45% of the body (${f.inspector.h} of ${body})`);
        t.expect(Math.abs(f.main.h - body * 0.55) <= 1 && f.main.w === f.vw, `the lanes fill the top 55% (${JSON.stringify(f.main)})`);
        t.expect(f.inspectorHead?.h === 56, `the 56 px sheet header (${JSON.stringify(f.inspectorHead)})`);
        t.expect(f.hint === 'Map editing is roomier in landscape', `the landscape hint (${f.hint})`);
      }
      await expectTargets(t, page);
    },
  },
  {
    name: 'ed2-frame-collapsed',
    url: harness(),
    opts: {...FRAME, devices: ['ipad']},
    async fn(page, t) {
      await loaded(t);
      await page.getByRole('button', {name: 'Inspector'}).click();
      await t.waitAttr('.edit', 'data-inspector', 'collapsed');
      const f = await page.evaluate(frameFacts);
      t.expect(f.inspector.h === 56 && f.inspectorHead.h === 56, `collapsed to the 56 px header (${JSON.stringify(f.inspector)})`);
      t.expect(f.main.h === f.transport.y - f.bar.h - 56, `the main area takes the room (${JSON.stringify(f.main)})`);
      const expanded = await page.getByRole('button', {name: 'Inspector'}).getAttribute('aria-expanded');
      t.expect(expanded === 'false', `aria-expanded false (${expanded})`);
    },
  },
  {
    name: 'ed2-frame-hints',
    url: harness(),
    opts: {...FRAME, devices: ['laptop']},
    async fn(page, t) {
      await loaded(t);
      await page.keyboard.press('ArrowRight');
      await t.waitAttr('.edit', 'data-kbd-hints', '');
      const f = await page.evaluate(frameFacts);
      t.expect(f.kbdHints && f.hintCaps === 3, `Esc, ⌘Z and ⇧⌘Z key-caps show after keyboard use (${f.hintCaps})`);
      const structure = await t.structure();
      t.expect(!structure.length, `structure with the hints (${JSON.stringify(structure.slice(0, 4))})`);
    },
  },
  {
    name: 'ed2-frame-chart',
    url: harness('tab=chart'),
    opts: FRAME,
    async fn(page, t) {
      await loaded(t);
      const f = await page.evaluate(frameFacts);
      expectBar(t, f);
      expectTransport(t, f);
      t.expect(f.label === 'Editing drum chart' && f.tabs[1].selected === 'true', `the chart label and tab (${f.label})`);
      t.expect(f.inspector === null && f.inspectorState === 'none' && f.main.w === f.vw, `no inspector until the chart fills it (${JSON.stringify(f.main)})`);
      t.expect(f.undo && f.redo, 'Undo and Redo are shown on Chart');
    },
  },
  {
    name: 'ed2-frame-details',
    url: harness('tab=details'),
    opts: FRAME,
    async fn(page, t) {
      await loaded(t);
      const f = await page.evaluate(frameFacts);
      expectBar(t, f);
      expectTransport(t, f);
      t.expect(f.label === 'Editing details' && f.tabs[2].selected === 'true', `the details label and tab (${f.label})`);
      t.expect(f.inspector === null && !f.undo && !f.redo, 'no inspector and no Undo / Redo on Details');
    },
  },
  {
    name: 'ed2-frame-bulk',
    url: harness('bulk=3'),
    opts: FRAME,
    async fn(page, t) {
      const f = await page.evaluate(frameFacts);
      t.expect(f.bar && f.bar.h === 48 && f.bar.w === f.vw, `the bulk posture bar is 48 px (${JSON.stringify(f.bar)})`);
      t.expect(f.border?.width === '2px' && f.border.color === f.tokens.edit, `its 2 px --edit border (${JSON.stringify(f.border)})`);
      t.expect(f.h1.length === 1 && f.h1[0] === 'Editing details · 3 songs', `the label is the h1 (${JSON.stringify(f.h1)})`);
      t.expect(f.tabs.length === 0 && !f.undo && f.slim === null, 'no tabs, no Undo / Redo, no slim transport');
      // The bar stays at the top while the page scrolls under it.
      await page.evaluate(() => { document.querySelector('.edit-harness-bulk-page').scrollTop = 400; });
      const after = await page.evaluate(frameFacts);
      t.expect(after.bar.y === 0, `sticky at the top (${JSON.stringify(after.bar)})`);
      await page.getByRole('button', {name: 'Done'}).focus();
      await page.keyboard.press('Escape');
      const calls = await page.evaluate(() => window.__edit.router.calls);
      t.expect(JSON.stringify(calls) === JSON.stringify([['back', {fallback: '/'}]]), `Esc goes back to the selection (${JSON.stringify(calls)})`);
    },
  },
  {
    name: 'ed2-frame-esc',
    url: harness(),
    opts: {...FRAME, devices: ['laptop'], capture: false},
    async fn(page, t) {
      await loaded(t);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => window.__edit.router.calls.length > 0, null, {timeout: 5000});
      const {calls, id} = await page.evaluate(() => ({calls: window.__edit.router.calls, id: window.__edit.ts.id}));
      t.expect(JSON.stringify(calls) === JSON.stringify([['navigate', `/s/${id}`, {replace: true}]]), `Esc is Done: replace with the Stage (${JSON.stringify(calls)})`);
    },
  },
  {
    name: 'ed2-frame-sheet',
    url: harness(),
    opts: FRAME,
    async fn(page, t) {
      await loaded(t);
      await page.locator('.edit-slim [data-ctl=speed] button').click();
      await page.waitForSelector('.ui-sheet[data-sheet="speed"] [data-sheet-content="speed"]', {timeout: 10_000});
      // Docked at the bottom once its entry slide settles.
      const docked = await page.waitForFunction(() => {
        const r = document.querySelector('.ui-sheet[data-sheet="speed"]')?.getBoundingClientRect();
        return r && r.height > 0 && Math.abs(r.bottom - innerHeight) <= 1 ? {y: r.y, h: r.height, w: r.width, vh: innerHeight} : false;
      }, null, {timeout: 5000}).then((hnd) => hnd.jsonValue(), () => null);
      t.expect(!!docked, 'the Speed sheet is a bottom sheet docked at the bottom of the window');
      t.expect(docked.h > 200, `with the Speed sheet inside (${JSON.stringify(docked)})`);
    },
  },

  // ------------------------------------------------------------------ the app
  {
    name: 'ed2-app-roundtrip',
    url: app('/s/glasshouse'),
    opts: {requires: PEERS, ready: 'stage', devices: ['laptop'], capture: false, timeout: 90_000},
    async fn(page, t) {
      await t.loadPhase('ready');
      await page.keyboard.press('Space');
      await t.transportPhase('playing');
      const idx = await page.evaluate(() => history.state?.idx ?? null);
      await page.keyboard.press('KeyE');
      await t.ready('edit');
      const inEdit = await page.evaluate(() => ({
        path: location.pathname, idx: history.state?.idx ?? null, place: document.documentElement.dataset.place,
        stageTokens: document.documentElement.matches('[data-place=stage]'), label: document.querySelector('.edit-label')?.textContent,
        playing: window.__woodshed.activeSession()?.transport.snapshot.phase,
      }));
      t.expect(inEdit.path === '/s/glasshouse/edit/map' && inEdit.idx === idx + 1, `E pushes Edit · Map (${JSON.stringify(inEdit)})`);
      t.expect(inEdit.place === 'edit' && !inEdit.stageTokens, `the app theme in Edit (${JSON.stringify(inEdit)})`);
      t.expect(inEdit.label === 'Editing map', `the label (${inEdit.label})`);
      t.expect(inEdit.playing === 'playing', `the music keeps playing into Edit (${inEdit.playing})`);
      await page.getByRole('tab', {name: 'Chart'}).click();
      await page.waitForFunction(() => location.pathname === '/s/glasshouse/edit/chart', null, {timeout: 10_000});
      const chartIdx = await page.evaluate(() => history.state?.idx ?? null);
      t.expect(chartIdx === idx + 1, `the tab switch replaced the entry (${chartIdx})`);
      await page.getByRole('button', {name: 'Done'}).click();
      await t.ready('stage');
      const back = await page.evaluate(() => ({path: location.pathname, idx: history.state?.idx ?? null,
        playing: window.__woodshed.activeSession()?.transport.snapshot.phase}));
      t.expect(back.path === '/s/glasshouse' && back.idx === idx, `Done went back to the Stage entry (${JSON.stringify(back)})`);
      t.expect(back.playing === 'playing', `still playing on the Stage (${back.playing})`);
    },
  },
  {
    name: 'ed2-app-deeplink',
    url: app('/s/glasshouse/edit/details'),
    opts: {requires: PEERS, ready: 'edit', devices: ['laptop'], capture: false},
    async fn(page, t) {
      const before = await page.evaluate(() => ({idx: history.state?.idx ?? null, length: history.length}));
      await page.getByRole('button', {name: 'Done'}).click();
      await t.ready('stage');
      const after = await page.evaluate(() => ({path: location.pathname, idx: history.state?.idx ?? null, length: history.length}));
      t.expect(after.path === '/s/glasshouse' && after.idx === before.idx && after.length === before.length,
        `Done replaced Edit with the Stage (${JSON.stringify({before, after})})`);
    },
  },
];
