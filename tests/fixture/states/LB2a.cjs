// LB2a's states: the Library's window drop (spec §3.1, architecture §2.16) in the real app on the fixture
// database, in Chromium, with DragEvents carrying File objects (a page-made DataTransfer ignores dropEffect
// writes, so the copy / no-drop cursor is asserted by tests/library-dropzone.test.js):
//   lb2a-drop-target      a 3-file drag over the Library: the "Drop to add 3 files" target is a popover in the
//                         top layer over the dimmed window, takes no focus, is announced, and a dragover anywhere is
//                         accepted; captured
//   lb2a-drop-add         the drop stages the three files and opens /add (LB2b's sheet takes them and lists them by
//                         name; until it lands /add is the placeholder and they stay staged); nothing is uploaded
//                         and no job is created
//   lb2a-drop-elsewhere   on /welcome (Library place, but not the Library): no target, and a dropped file is
//                         swallowed: the app stays where it is
'use strict';

const NOW = 'fx-now=2026-10-28T12:00:00Z';
const FILES = ['Harbor Lights.mp3', 'garage-take-4.wav', 'notes.pdf'];

/** Runs in the page: dispatches a drag event of `type` carrying `names` as Files on the element at (x, y). */
function dispatchDrag([type, names, x, y]) {
  const dt = new DataTransfer();
  for (const name of names) dt.items.add(new File(['x'.repeat(16)], name, {type: name.endsWith('.pdf') ? 'application/pdf' : 'audio/mpeg'}));
  const target = document.elementFromPoint(x, y) ?? document.body;
  const e = new DragEvent(type, {bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt});
  target.dispatchEvent(e);
  return {prevented: e.defaultPrevented, target: target.tagName};
}

/** Runs in the page: the drop target's state. */
function targetFacts() {
  const el = document.querySelector('.lib-drop');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const title = el.querySelector('.ui-dialog-title');
  return {
    open: el.matches(':popover-open'),
    title: title?.textContent ?? null,
    titleSize: title ? getComputedStyle(title).fontSize : null,
    box: {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)},
    centred: Math.abs(r.x + r.width / 2 - innerWidth / 2) < 2 && Math.abs(r.y + r.height / 2 - innerHeight / 2) < 2,
    backdrop: getComputedStyle(el, '::backdrop').backgroundColor,
    focusKept: document.activeElement === window.__lb2aFocusBefore,
  };
}

async function dragOver(page, names = FILES) {
  const size = page.viewportSize();
  const x = Math.round(size.width / 2), y = Math.round(size.height * 0.6);
  const enter = await page.evaluate(dispatchDrag, ['dragenter', names, x, y]);
  const over = await page.evaluate(dispatchDrag, ['dragover', names, x, y]);
  return {enter, over, x, y};
}

module.exports = [
  {
    name: 'lb2a-drop-target',
    url: `/?fx-reset=1&${NOW}`,
    opts: {ready: 'library'},
    async fn(page, t) {
      await page.evaluate(() => { window.__lb2aFocusBefore = document.activeElement; });
      const {enter, over} = await dragOver(page);
      t.expect(enter.prevented && over.prevented, `dragenter and dragover are accepted (${JSON.stringify({enter, over})})`);
      await page.waitForSelector('.lib-drop:popover-open');
      const f = await page.evaluate(targetFacts);
      t.expect(f && f.open, `the target is a popover in the top layer (${JSON.stringify(f)})`);
      t.expect(f.focusKept, 'it takes no focus');
      // Screen readers hear the same line (feedback.announce, polite).
      await page.waitForFunction(() => document.querySelector('.app-live-host')?.textContent.includes('Drop to add 3 files'));
      t.expect(f.title === 'Drop to add 3 files', `it reads "Drop to add 3 files" (${f.title})`);
      t.expect(f.centred, `the card is centred ${JSON.stringify(f.box)}`);
      t.expect(f.backdrop !== 'rgba(0, 0, 0, 0)', `the window is dimmed (${f.backdrop})`);
      t.expect(parseFloat(f.titleSize) >= 15, `the line is at least 15 px (${f.titleSize})`);
      // The whole window takes the drop: a dragover at every corner and over the card is accepted, and the target stays.
      const size = page.viewportSize();
      const points = [[3, 3], [size.width - 4, 3], [3, size.height - 4], [size.width - 4, size.height - 4], [f.box.x + 20, f.box.y + 20]];
      for (const [x, y] of points) {
        const over = await page.evaluate(dispatchDrag, ['dragover', FILES, x, y]);
        t.expect(over.prevented, `a dragover at ${x},${y} is accepted (${JSON.stringify(over)})`);
      }
      t.expect((await page.evaluate(targetFacts))?.open, 'the target stays while the files hover');
    },
  },
  {
    name: 'lb2a-drop-add',
    url: `/?fx-reset=1&${NOW}`,
    opts: {ready: 'library', capture: false, structure: {placeholder: true}},
    async fn(page, t) {
      const before = await page.evaluate(() => window.fixture.db().jobs.length);
      const {x, y} = await dragOver(page);
      await page.waitForSelector('.lib-drop:popover-open');
      const drop = await page.evaluate(dispatchDrag, ['drop', FILES, x, y]);
      t.expect(drop.prevented, 'the drop is taken (the browser does not open the file)');
      await page.waitForFunction(() => location.pathname === '/add');
      t.expect(!(await page.evaluate(targetFacts)), 'the target is gone after the drop');
      const staged = await page.evaluate(async () => {
        const mod = await import('/src/library/dropzone.js');
        return mod.takeStagedFiles().map(f => f.name);
      });
      // LB2b's sheet takes the files when it mounts; while /add is the placeholder they wait here for it.
      const placeholder = await page.evaluate(() => document.body.textContent.includes('Not built yet'));
      if (placeholder) {
        t.expect(JSON.stringify(staged) === JSON.stringify(FILES), `the three files are staged for the sheet (placeholder: ${staged})`);
      } else {
        // The sheet took them: it lists each dropped file by name (notes.pdf in its "isn't audio" line).
        await page.waitForFunction(names => names.every(name => document.body.innerText.includes(name.replace(/\.[^.]+$/, ''))), FILES, {timeout: 5000}).catch(() => {});
        const shown = await page.evaluate(names => names.filter(name => document.body.innerText.includes(name.replace(/\.[^.]+$/, ''))), FILES);
        t.expect(staged.length === 0 && shown.length === FILES.length,
          `the sheet took the three staged files and lists them (left staged: ${staged}; listed: ${shown})`);
      }
      const after = await page.evaluate(() => window.fixture.db().jobs.length);
      t.expect(after === before, `nothing was uploaded or queued (${before} → ${after} jobs)`);
      const uploads = await page.evaluate(() => window.__woodshed.store.library.uploads.peek().length);
      t.expect(uploads === 0, `no upload started (${uploads})`);
    },
  },
  {
    name: 'lb2a-drop-elsewhere',
    url: `/welcome?fx-reset=1&${NOW}`,
    opts: {ready: 'welcome', capture: false, devices: ['laptop'], themes: ['light']},
    async fn(page, t) {
      const {enter, over, x, y} = await dragOver(page, ['a.mp3']);
      t.expect(!(await page.evaluate(targetFacts)), 'no drop target off the Library');
      t.expect(!enter.prevented && over.prevented, `the dragover is refused here (${JSON.stringify({enter, over})})`);
      const drop = await page.evaluate(dispatchDrag, ['drop', ['a.mp3'], x, y]);
      t.expect(drop.prevented, 'a stray drop is swallowed');
      t.expect(await page.evaluate(() => location.pathname) === '/welcome', 'the app stays on /welcome');
    },
  },
];
