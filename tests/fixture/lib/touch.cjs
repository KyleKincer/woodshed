// Touch input through CDP Input.dispatchTouchEvent (architecture §11.4):
// Playwright has no multi-touch API, so pinch and two-finger pan send two
// touch points at once. Use a context created with hasTouch: true.
//
//   const touch = await createTouch(page);
//   await touch.tap({x, y}) / touch.tap(locator)
//   await touch.doubleTap(target, {gapMs = 80})
//   await touch.longPress(target, {ms = 600})                     hold without moving
//   await touch.drag(from, to, {steps = 12, holdMs = 0})          one finger; holdMs first = long-press-drag
//   await touch.swipe(from, to, {ms = 120})                       a quick flick
//   await touch.pinch(center, {from = 80, to = 200, steps = 10, angle = 0})   two fingers apart (to > from) or together
//   await touch.pan(center, {dx, dy}, {spread = 80, steps = 10})  two fingers moving together
//   touch.start(points) / touch.move(points) / touch.end()        the raw events ([{x, y, id}])
// A target is {x, y} or a Playwright Locator (its centre). Each gesture records
// itself in touch.log ([{gesture, …}]), which lib/count.cjs reads.
'use strict';

const FRAME_MS = 16;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function pointOf(target) {
  if (target && typeof target.x === 'number' && typeof target.y === 'number') return {x: target.x, y: target.y};
  if (target && typeof target.boundingBox === 'function') {
    const box = await target.boundingBox();
    if (!box) throw new Error('touch: the target is not visible');
    return {x: box.x + box.width / 2, y: box.y + box.height / 2};
  }
  throw new TypeError('touch: a target is {x, y} or a Locator');
}

/** Two finger positions `distance` apart around `center`, along `angle` (degrees). */
function fingers(center, distance, angle = 0) {
  const rad = angle * Math.PI / 180, dx = Math.cos(rad) * distance / 2, dy = Math.sin(rad) * distance / 2;
  return [{x: center.x - dx, y: center.y - dy, id: 0}, {x: center.x + dx, y: center.y + dy, id: 1}];
}

/** Points on the straight line a → b, `steps` of them, excluding a and including b. */
function path(a, b, steps) {
  const out = [];
  for (let i = 1; i <= steps; i++) out.push({x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps});
  return out;
}

/** `send(method, params)` is a CDP session's send (or a fake, in tests). */
function touchOn(send, {sleep: wait = sleep} = {}) {
  const log = [];
  const dispatch = (type, points) => send('Input.dispatchTouchEvent', {type, touchPoints: points.map(({x, y, id = 0}) => ({x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, id, radiusX: 4, radiusY: 4, force: 1}))});
  const api = {
    log,
    start: points => dispatch('touchStart', points),
    move: points => dispatch('touchMove', points),
    end: () => dispatch('touchEnd', []),
    async tap(target) {
      const p = await pointOf(target);
      await api.start([p]); await wait(30); await api.end();
      log.push({gesture: 'tap', ...p});
    },
    async doubleTap(target, {gapMs = 80} = {}) {
      const p = await pointOf(target);
      await api.start([p]); await wait(30); await api.end();
      await wait(gapMs);
      await api.start([p]); await wait(30); await api.end();
      log.push({gesture: 'doubleTap', ...p});
    },
    async longPress(target, {ms = 600} = {}) {
      const p = await pointOf(target);
      await api.start([p]); await wait(ms); await api.end();
      log.push({gesture: 'longPress', ...p, ms});
    },
    async drag(from, to, {steps = 12, holdMs = 0} = {}) {
      const a = await pointOf(from), b = await pointOf(to);
      await api.start([a]);
      if (holdMs) await wait(holdMs);
      for (const p of path(a, b, steps)) { await api.move([p]); await wait(FRAME_MS); }
      await api.end();
      log.push({gesture: holdMs ? 'longPressDrag' : 'drag', from: a, to: b, holdMs});
    },
    async swipe(from, to, {ms = 120} = {}) {
      const a = await pointOf(from), b = await pointOf(to), steps = Math.max(2, Math.round(ms / FRAME_MS));
      await api.start([a]);
      for (const p of path(a, b, steps)) { await api.move([p]); await wait(ms / steps); }
      await api.end();
      log.push({gesture: 'swipe', from: a, to: b});
    },
    async pinch(center, {from = 80, to = 200, steps = 10, angle = 0} = {}) {
      const c = await pointOf(center);
      await api.start(fingers(c, from, angle));
      for (let i = 1; i <= steps; i++) { await api.move(fingers(c, from + (to - from) * i / steps, angle)); await wait(FRAME_MS); }
      await api.end();
      log.push({gesture: 'pinch', center: c, from, to});
    },
    async pan(center, {dx = 0, dy = 0} = {}, {spread = 80, steps = 10} = {}) {
      const c = await pointOf(center);
      await api.start(fingers(c, spread));
      for (let i = 1; i <= steps; i++) { await api.move(fingers({x: c.x + dx * i / steps, y: c.y + dy * i / steps}, spread)); await wait(FRAME_MS); }
      await api.end();
      log.push({gesture: 'pan', center: c, dx, dy});
    },
  };
  return api;
}

/** A touch driver for a Playwright page (opens its own CDP session). */
async function createTouch(page, opts = {}) {
  const cdp = await page.context().newCDPSession(page);
  const touch = touchOn((method, params) => cdp.send(method, params), opts);
  touch.detach = () => cdp.detach();
  return touch;
}

module.exports = {createTouch, touchOn, fingers, path, pointOf};
