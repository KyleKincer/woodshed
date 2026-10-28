// Counting wrapper for flows (architecture §11.4, Appendix A). Flows drive the
// page through the counter and declare each intended action as a step:
//
//   const counter = createCounter(page, {mode: 'keys', mod: 'Control'});
//   await counter.step('open the song', async () => {
//     await counter.keyboard.press('/'); await counter.keyboard.type('glasshouse'); await counter.keyboard.press('Enter');
//   });
//   counter.assertBudget('F-laptop');   // or {actions: 6}
//
// It records, per step, keydowns (a key or a chord counts once; characters typed
// into a text field are not counted), taps and gestures (double-tap, long-press,
// drag, swipe, pinch and pan count once each). A step is one action; a step
// with no input, or input outside any step, fails the budget. mode 'keys'
// forbids touch and mode 'touch' forbids keys, as the keys-only and touch-only
// scripts require. 'Mod+K' presses Meta+K when mod is 'Meta' (fx-platform=mac), else Control+K.
'use strict';

const {createTouch} = require('./touch.cjs');

/** Appendix A budgets (inclusive maxima). K: "< 10 keys". */
const BUDGETS = {
  'F-laptop': {actions: 6, mode: 'keys'},
  'R-laptop': {actions: 3, mode: 'keys'},
  'F-ipad': {actions: 6, mode: 'touch'},
  'R-ipad': {actions: 3, mode: 'touch'},
  K: {keys: 9, mode: 'keys'},
};
const GESTURES = ['doubleTap', 'longPress', 'drag', 'swipe', 'pinch', 'pan'];

/** Runs in the page: is the focused element a text field? */
function focusIsTextField() {
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image', 'hidden'].includes(el.type);
  return ['textbox', 'searchbox', 'combobox'].includes(el.getAttribute('role'));
}

/** 'Mod+Shift+K' → 'Control+Shift+K' (or Meta). */
function resolveKey(key, mod) {
  return String(key).split('+').map(part => (part === 'Mod' ? mod : part)).join('+');
}

/** A printable character a text field would take: 'a', 'A', '/', 'Shift+A'. */
function isCharacter(key) {
  const parts = String(key).split('+').filter(Boolean);
  const main = parts[parts.length - 1] ?? '';
  const mods = parts.slice(0, -1);
  return (main.length === 1 || main === 'Space') && mods.every(m => m === 'Shift');
}

function createCounter(page, {mode = 'any', mod = 'Control', touch = null, isTextField = () => page.evaluate(focusIsTextField)} = {}) {
  if (!['any', 'keys', 'touch'].includes(mode)) throw new Error(`count: mode is any, keys or touch, got ${JSON.stringify(mode)}`);
  const steps = [];
  const outside = {label: '(outside a step)', keys: 0, typed: 0, taps: 0, gestures: 0, events: []};
  let current = null;
  const bucket = () => current ?? outside;
  const forbid = kind => {
    if (mode === 'keys' && kind === 'touch') throw new Error('count: this flow is keys only, but it used touch');
    if (mode === 'touch' && kind === 'keys') throw new Error('count: this flow is touch only, but it used the keyboard');
  };

  async function keydown(key, run) {
    forbid('keys');
    const typed = isCharacter(key) && await isTextField();
    const b = bucket();
    if (typed) b.typed++; else b.keys++;
    b.events.push({type: typed ? 'typed' : 'key', key});
    await run(resolveKey(key, mod));
  }
  const keyboard = {
    press: (key, opts) => keydown(key, k => page.keyboard.press(k, opts)),
    down: key => keydown(key, k => page.keyboard.down(k)),
    up: key => page.keyboard.up(resolveKey(key, mod)),
    async type(text, opts) {
      forbid('keys');
      const typed = await isTextField(), b = bucket();
      if (typed) b.typed += text.length; else b.keys += text.length;
      b.events.push({type: typed ? 'typed' : 'keys', text});
      await page.keyboard.type(text, opts);
    },
    async insertText(text) {
      forbid('keys');
      bucket().typed += text.length;
      bucket().events.push({type: 'typed', text});
      await page.keyboard.insertText(text);
    },
  };

  let driver = touch;
  const touchDriver = async () => (driver ??= await createTouch(page));
  const touchApi = {};
  for (const gesture of ['tap', ...GESTURES]) {
    touchApi[gesture] = async (...args) => {
      forbid('touch');
      const b = bucket();
      if (gesture === 'tap') b.taps++; else b.gestures++;
      b.events.push({type: gesture});
      return (await touchDriver())[gesture](...args);
    };
  }

  async function step(label, fn) {
    if (current) throw new Error(`count: step "${label}" started inside step "${current.label}"`);
    current = {label, keys: 0, typed: 0, taps: 0, gestures: 0, events: []};
    steps.push(current);
    try { return await fn(); } finally { current = null; }
  }

  function report() {
    const strip = ({events, ...rest}) => ({...rest, inputs: rest.keys + rest.taps + rest.gestures});
    const list = steps.map(strip);
    const totals = list.reduce((t, s) => ({keys: t.keys + s.keys, typed: t.typed + s.typed, taps: t.taps + s.taps, gestures: t.gestures + s.gestures}), {keys: 0, typed: 0, taps: 0, gestures: 0});
    return {steps: list, outside: strip(outside), totals: {actions: list.length, ...totals}};
  }

  function assertBudget(budget) {
    const spec = typeof budget === 'string' ? BUDGETS[budget] : budget;
    if (!spec) throw new Error(`count: unknown budget ${JSON.stringify(budget)} (known: ${Object.keys(BUDGETS).join(', ')})`);
    const r = report(), problems = [];
    if (spec.mode && spec.mode !== 'any' && mode !== spec.mode) problems.push(`the ${budget} script is ${spec.mode} only; this counter is ${mode}`);
    if (r.outside.inputs + r.outside.typed) problems.push(`${r.outside.inputs + r.outside.typed} input(s) outside any step`);
    for (const s of r.steps) if (!s.inputs && !s.typed) problems.push(`step "${s.label}" had no input`);
    for (const key of ['actions', 'keys', 'taps', 'gestures']) if (spec[key] !== undefined && r.totals[key] > spec[key]) problems.push(`${r.totals[key]} ${key} > budget ${spec[key]}`);
    if (problems.length) {
      const error = new Error(`count: over budget${typeof budget === 'string' ? ` (${budget})` : ''}: ${problems.join('; ')}\n${JSON.stringify(r, null, 1)}`);
      error.report = r;
      throw error;
    }
    return r;
  }

  return {keyboard, touch: touchApi, step, report, assertBudget};
}

module.exports = {createCounter, BUDGETS, resolveKey, isCharacter, focusIsTextField};
