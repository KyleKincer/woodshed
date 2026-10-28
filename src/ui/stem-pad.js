// StemPad (architecture §2.12, spec §4.7 Mix sheet and §7.6): one stem's pad.
//
//   StemPad({name, color, state: 'on' | 'out' | 'solo', level = 1, keyCap, mode = 'mute' | 'solo',
//            size = 'band' | 'rail', max = 1, onToggle(), onSolo(), onLevel(level, {final}), …common props})
//     → {el, set(partial), destroy()}
//
// Gestures (spec §7.6): tap = onToggle (onSolo in Solo mode); Shift-click or a 500 ms long-press =
// onSolo; double tap = level 100% (resetLevel 1); a vertical drag inside the pad = level
// (onLevel(v, {final: false}) while dragging, {final: true} on release). A pointer tap waits
// DOUBLE_TAP_MS for a second tap before it acts, so a double tap never flips the mute; keyboard
// activation (Enter on the pad's button) acts at once.
// Looks (spec §8.3, architecture §7.5): On is a filled pad with the stem colour bar and `ON`; Out
// is an outline with a hatch and a struck-through `OUT`, never opacity; Solo is an accent ring
// with `SOLO`, no hue of its own. The level is a vertical fill and a value strip (a role=slider:
// arrows and Home/End adjust it). `color` is a stem token name ('drums', 'stem-drums' or
// '--stem-drums'); `keyCap` a KeyString ('Digit1'), shown in the corner and as aria-keyshortcuts.
//
// Accessibility: the pad is a group named by the stem; its button is a toggle named for the
// action of the current mode ("Mute Drums", aria-pressed when out; "Solo Drums", pressed when
// soloed), and the strip is the "Drums level" slider.

import '../styles/primitives/stem-pad.css';
import {aria as ariaKeys} from '../app/keys.js';
import {applyCommon, keyCap as makeKeyCap, requireLabel, setAttr, setText} from './button.js';
import {DOUBLE_TAP_MS, DOUBLE_TAP_SLOP, DRAG_SLOP, Fader, percent} from './fader.js';

export const LONG_PRESS_MS = 500;
export const STATES = Object.freeze(['on', 'out', 'solo']);
const WORD = {on: 'ON', out: 'OUT', solo: 'SOLO'};

/** 'drums' | 'stem-drums' | '--stem-drums' → 'var(--stem-drums)'. */
export function stemColor(name) {
  const raw = String(name ?? 'other').trim().replace(/^--/, '');
  const token = raw.startsWith('stem-') ? raw : `stem-${raw}`;
  return /^[a-z0-9-]+$/.test(token) ? `var(--${token})` : 'var(--stem-other)';
}

export function StemPad(props = {}) {
  let p = {state: 'on', level: 1, mode: 'mute', size: 'band', max: 1, ...props};
  requireLabel('StemPad', p.name);
  const ac = new AbortController();
  const opts = {signal: ac.signal};

  const el = document.createElement('div');
  el.className = 'ui-stem-pad';
  el.setAttribute('role', 'group');
  const fill = document.createElement('span');
  fill.className = 'ui-stem-pad-fill';
  fill.setAttribute('aria-hidden', 'true');
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'ui-stem-pad-main';
  const bar = document.createElement('span');
  bar.className = 'ui-stem-pad-bar';
  bar.setAttribute('aria-hidden', 'true');
  const nameEl = document.createElement('span');
  nameEl.className = 'ui-stem-pad-name';
  const word = document.createElement('span');
  word.className = 'ui-stem-pad-word';
  word.setAttribute('aria-hidden', 'true');
  main.append(bar, nameEl, word);
  let cap = null;

  const fader = Fader({
    variant: 'pad', host: el, value: p.level, min: 0, max: p.max, resetValue: 1, label: `${p.name} level`, format: percent,
    className: 'ui-stem-pad-level',
    onInput: v => { p.level = v; p.onLevel?.(v, {final: false}); },
    onChange: v => { p.level = v; p.onLevel?.(v, {final: true}); },
  });
  el.append(fill, main, fader.el);
  let prevCommon = {};

  function render() {
    applyCommon(el, p, prevCommon);
    prevCommon = {className: p.className, id: p.id, attrs: p.attrs, dataset: p.dataset, testid: p.testid};
    const state = STATES.includes(p.state) ? p.state : 'on';
    const solo = p.mode === 'solo';
    setAttr(el, 'aria-label', p.name);
    setAttr(el, 'data-state', state);
    setAttr(el, 'data-mode', solo ? 'solo' : 'mute');
    setAttr(el, 'data-size', p.size === 'rail' ? 'rail' : 'band');
    el.style.setProperty('--pad-color', stemColor(p.color ?? p.name));
    setText(nameEl, p.name);
    setText(word, WORD[state]);
    setAttr(main, 'aria-label', `${solo ? 'Solo' : 'Mute'} ${p.name}`);
    setAttr(main, 'aria-pressed', String(solo ? state === 'solo' : state === 'out'));
    setAttr(main, 'aria-keyshortcuts', p.keyCap ? ariaKeys(p.keyCap) : null);
    if (p.keyCap) {
      if (!cap) { cap = makeKeyCap(p.keyCap, {className: 'ui-stem-pad-key'}); main.append(cap.el); } else cap.set({keys: p.keyCap});
    } else if (cap) { cap.destroy(); cap = null; }
  }

  // ---- gestures on the whole pad
  let press = null;     // {id, x, y, shift, moved, long, timer}
  let pending = null;   // {timer, x, y}: a tap waiting for a possible second tap
  let suppressClick = false;

  const act = ({shift = false} = {}) => {
    if (shift || p.mode === 'solo') p.onSolo?.();
    else p.onToggle?.();
  };
  const clearPending = () => { if (pending) { clearTimeout(pending.timer); pending = null; } };

  el.addEventListener('pointerdown', e => {
    if (!e.isPrimary || e.button !== 0) return;
    suppressClick = false;
    clearTimeout(press?.timer);
    press = {id: e.pointerId, x: e.clientX, y: e.clientY, shift: e.shiftKey, moved: false, long: false, inMain: main.contains(e.target), timer: null};
    const own = press;
    press.timer = setTimeout(() => {
      if (press !== own || own.moved) return;
      own.long = true;
      clearPending();
      p.onSolo?.();
    }, LONG_PRESS_MS);
  }, opts);
  el.addEventListener('pointermove', e => {
    if (!press || e.pointerId !== press.id || press.moved) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_SLOP) {
      press.moved = true;
      clearTimeout(press.timer);
    }
  }, opts);
  el.addEventListener('pointerup', e => {
    if (!press || e.pointerId !== press.id) return;
    const done = press;
    press = null;
    clearTimeout(done.timer);
    // The click that follows lands on the button only when the press began and ended on it.
    suppressClick = done.inMain && main.contains(e.target);
    if (done.long || done.moved || fader.dragging) return;
    if (done.shift || e.shiftKey) { clearPending(); act({shift: true}); return; }
    if (pending && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) <= DOUBLE_TAP_SLOP) {
      clearPending();
      fader.reset();
      return;
    }
    clearPending();
    pending = {x: e.clientX, y: e.clientY, timer: setTimeout(() => { pending = null; act(); }, DOUBLE_TAP_MS)};
  }, opts);
  el.addEventListener('pointercancel', e => {
    if (!press || e.pointerId !== press.id) return;
    clearTimeout(press.timer);
    press = null;
  }, opts);
  // A touch long-press solos; it must not also open the platform's context menu.
  el.addEventListener('contextmenu', e => { if (press && e.pointerType !== 'mouse') e.preventDefault(); }, opts);

  // Keyboard and assistive-technology activation of the pad's button acts at once.
  main.addEventListener('click', e => {
    if (suppressClick) { suppressClick = false; return; }
    act({shift: e.shiftKey});
  }, opts);

  render();

  return {
    el,
    /** The level strip (role=slider). */
    get level() { return fader.value; },
    set(partial = {}) {
      p = {...p, ...partial};
      if ('name' in partial) requireLabel('StemPad', p.name);
      const faderPatch = {};
      if ('level' in partial) faderPatch.value = partial.level;
      if ('max' in partial) faderPatch.max = partial.max;
      if ('name' in partial) faderPatch.label = `${p.name} level`;
      if (Object.keys(faderPatch).length) fader.set(faderPatch);
      render();
    },
    destroy() {
      clearPending();
      clearTimeout(press?.timer);
      press = null;
      ac.abort();
      cap?.destroy();
      fader.destroy();
      el.remove();
    },
  };
}
