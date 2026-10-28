// The Stage control set (architecture §2.14.10, spec §4.6): one set of controls, rendered as the
// band dock, the rail grid, the Focus mini rail or Edit's 56 px slim transport.
//
//   mountControls(el, {session, variant = 'dock', stage, registry}) → {el, destroy()}
//     variant   'dock'  [Again 72][Play 96][Loop 72][− 75% + 184][Count-in 80][Mix 104], 64 tall (Play 80),
//                       12 px gaps, 16 px padding: 700 px (the dock never scales with Distance)
//               'rail'  a 2-column grid of 56 px rows (Play 72), 8 px gaps:
//                       [speed][countIn|click][loop|mix][again|play]
//               'mini'  Speed + Play (the Focus mini rail)
//               'slim'  ⟲ ▶ ‖, bar.beat + time, loop chip, speed chip, count-in, click, Mix chip (Edit, ED2)
//     stage     the 'stage' context (stage.js); its `anchors` Map gets 'play', 'speed', 'loop', 'click'
//               and 'mix' while mounted, so the sheet commands anchor their popovers to these controls
//     registry  the command registry (default: the app registry)
//
// Every control runs a registry command (CONTROL_SET): a tap runs `command`; a long-press (500 ms),
// a right-click, Shift+F10 or the ContextMenu key runs `longPress`; the Mix ⌃ zone runs `caret`.
// Pressed, labels and the Play state follow the transport snapshot directly; enabled state and
// disabled reasons follow the registry (the controls invalidate it on every snapshot change). While
// audio loads, Play shows a ProgressRing with 'Loading 62%' / 'Decoding 3 of 4' / 'Preparing
// pitch-preserving playback' (pressing arms "Play when ready"); while counting it reads `✕ Count`.
// While playing the controls dim to 70% and stay fully live (controls.css).
import '../styles/views/stage/controls.css';
import {registry as appRegistry} from '../app/commands.js';
import {effect, untracked} from '../app/store.js';
import {Button, IconButton} from '../ui/button.js';
import {h} from '../ui/h.js';
import {ProgressRing} from '../ui/progress.js';
import {Stepper} from '../ui/stepper.js';
import {MIN_RATE, MAX_RATE} from '../../shared/practice.ts';
import {readFrame} from './frame.js';
import {stemLabel} from './transport-commands.js';
import {COPY, CONTROL_ROWS} from './hud.copy.js';

export const CONTROL_SET = Object.freeze([
  {id: 'again',   command: 'transport.again'},
  {id: 'play',    command: 'transport.playStop', longPress: 'transport.pause'},
  {id: 'loop',    command: 'transport.loopToggle', longPress: 'loop.card'},
  {id: 'speed',   kind: 'stepper', dec: 'speed.down', inc: 'speed.up', value: 'speed.sheet', valueLongPress: 'speed.toggle100'},
  {id: 'countIn', command: 'click.countIn', longPress: 'click.sheet'},
  {id: 'click',   command: 'click.toggle', longPress: 'click.sheet', variants: ['rail', 'slim']},
  {id: 'mix',     command: 'mix.minusMe', caret: 'mix.sheet', longPress: 'mix.sheet'},
  {id: 'pause',   command: 'transport.pause', variants: ['slim']},
].map(Object.freeze));

/** The accessible control rows per variant (role, name, command), for the table test and registry CI. */
export const CONTROLS = CONTROL_ROWS;
export {COPY};

export const VARIANTS = Object.freeze(['dock', 'rail', 'mini', 'slim']);
/** Which CONTROL_SET rows each variant renders, in order (spec §4.6). */
export const LAYOUT = Object.freeze({
  dock: Object.freeze(['again', 'play', 'loop', 'speed', 'countIn', 'mix']),
  rail: Object.freeze(['speed', 'countIn', 'click', 'loop', 'mix', 'again', 'play']),
  mini: Object.freeze(['speed', 'play']),
  slim: Object.freeze(['again', 'play', 'pause', 'position', 'loop', 'speed', 'countIn', 'click', 'mix']),
});
/** Long-press on a control (the Menu primitive's card long-press; music surfaces use 350 ms). */
export const LONG_PRESS_MS = 500;

const row = (id) => CONTROL_SET.find((r) => r.id === id);
const pct = (rate) => Math.round((Number.isFinite(rate) ? rate : 1) * 100);
const PCT_MIN = Math.round(MIN_RATE * 100);
const PCT_MAX = Math.round(MAX_RATE * 100);

/** The Play control's state for a snapshot and a load state (pure; the table test reads it). */
export function playState(snapshot, load) {
  const phase = snapshot?.phase ?? 'loading';
  const l = load ?? {phase: 'ready'};
  if (l.phase === 'error') {
    return {mode: 'error', icon: 'play', label: COPY.play, sublabel: null, name: COPY.play, ring: null, reason: COPY.loadError};
  }
  if (l.phase !== 'ready' || phase === 'loading') {
    let label, sublabel = null, name, ring;
    if (l.phase === 'decoding') {
      const n = Math.max(1, l.tracks || 1);
      const i = Math.min(n, (l.decoded || 0) + 1);
      label = COPY.decoding(i, n).split(' ')[0];
      sublabel = `${i} of ${n}`;
      name = COPY.decoding(i, n);
      ring = (l.decoded || 0) / n;
    } else if (l.phase === 'preparing') {
      label = COPY.preparing.split(' ')[0];
      name = COPY.preparing;
      ring = null;
    } else {
      const known = l.totalBytes > 0;
      const p = known ? Math.max(0, Math.min(100, Math.round((l.loadedBytes / l.totalBytes) * 100))) : null;
      label = COPY.loading(null).replace('…', '');
      sublabel = p == null ? null : `${p}%`;
      name = COPY.loading(p);
      ring = p == null ? null : p / 100;
    }
    if (snapshot?.armed) name = `${name} · ${COPY.armed}`;
    return {mode: 'loading', icon: null, label, sublabel, name, ring, armed: !!snapshot?.armed, reason: null};
  }
  if (phase === 'counting') return {mode: 'counting', icon: 'x', label: COPY.count, sublabel: null, name: COPY.cancelCount, ring: null, reason: null};
  if (phase === 'playing') return {mode: 'playing', icon: 'square', label: COPY.stop, sublabel: null, name: COPY.stop, ring: null, reason: null};
  return {mode: 'stopped', icon: 'play', label: COPY.play, sublabel: null, name: COPY.play, ring: null, reason: null};
}

/** Count-in: 'Count-in' with its length ('1 bar', '2 bars', '4 beats'); unmapped 'Lead-in' · '2 s' (D14). */
export function countInState(snapshot, {mapped}) {
  const c = snapshot?.countIn ?? {};
  return {
    label: mapped ? COPY.countIn : COPY.leadIn,
    sublabel: mapped ? COPY.countLength(Number.isFinite(c.length) ? c.length : 1, c.unit) : COPY.leadInLength,
    pressed: !!c.on,
  };
}

/** Mix main zone: `Drums` · `OUT` while Minus me mutes your part, else `Mix` (spec §4.6). */
export function mixState(snapshot) {
  const mix = snapshot?.mix ?? {};
  if (mix.minusMe) {
    const mine = Array.isArray(mix.mine) ? mix.mine : [];
    const label = mine.length === 1 ? stemLabel(mine[0]) : COPY.mine;
    return {label, sublabel: COPY.out, pressed: true, name: COPY.minusMeName(`${label} ${COPY.out}`)};
  }
  return {label: COPY.mixControl, sublabel: null, pressed: false, name: COPY.minusMeName(COPY.mixControl)};
}

export function mountControls(el, {session, variant = 'dock', stage = null, registry = appRegistry} = {}) {
  if (!el) throw new TypeError('mountControls: el is required');
  if (!session?.transport) throw new TypeError('mountControls: session is required');
  if (!VARIANTS.includes(variant)) throw new RangeError(`mountControls: unknown variant ${JSON.stringify(variant)}`);
  const {transport} = session;
  const snap = () => transport.snapshot.peek();
  const mapped = () => !!session.map?.isReal;
  const run = (id, extra = {}) => registry.run(id, {source: 'pointer', ...extra});
  const ac = new AbortController();
  const listen = {signal: ac.signal};
  const destroyers = [];
  const offs = [];
  const parts = {};
  const slim = variant === 'slim';
  const size = slim ? 'sm' : 'dock';

  const root = h('div', {class: 'ctl-set', role: 'toolbar', 'aria-label': COPY.transport, dataset: {variant}});
  el.append(root);

  /** Long-press, right-click, Shift+F10 and ContextMenu on `target` run `command`. */
  function bindLongPress(target, command) {
    target.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (target.getAttribute('aria-disabled') === 'true') return;
      run(command, {event: e});
    }, listen);
  }

  function control(id, node, extraClass = '') {
    const cell = h('div', {class: ['ctl', extraClass], dataset: {ctl: id}}, node);
    root.append(cell);
    return cell;
  }

  // ---- builders -----------------------------------------------------------------------------------------------
  function buildAgain() {
    const def = row('again');
    const b = slim
      ? IconButton({label: COPY.again, icon: 'rotate-ccw', command: def.command, registry, size})
      : Button({label: COPY.again, icon: 'rotate-ccw', command: def.command, registry, size});
    destroyers.push(() => b.destroy());
    parts.again = b;
    control('again', b.el);
  }

  function buildPlay() {
    const def = row('play');
    const b = Button({label: COPY.play, icon: 'play', command: def.command, registry, size: slim ? 'sm' : 'play', variant: 'primary',
      iconOnly: slim, longPressMs: LONG_PRESS_MS, onLongPress: (e) => run(def.longPress, {event: e})});
    bindLongPress(b.el, def.longPress);
    const ring = ProgressRing({value: null, size: slim ? 'sm' : 'md'});
    ring.el.classList.add('ctl-ring');
    ring.el.setAttribute('aria-hidden', 'true');
    ring.el.hidden = true;
    b.el.prepend(ring.el);
    destroyers.push(() => ring.destroy(), () => b.destroy());
    parts.play = {button: b, ring, key: ''};
    control('play', b.el);
  }

  function paintPlay(s, load) {
    const p = parts.play;
    if (!p) return;
    const st = playState(s, load);
    const key = JSON.stringify(st);
    if (key === p.key) return;
    p.key = key;
    p.ring.el.hidden = st.mode !== 'loading';
    if (st.mode === 'loading') p.ring.set({value: st.ring});
    p.button.el.dataset.mode = st.mode;
    p.button.el.toggleAttribute('data-armed', !!st.armed);
    p.button.set({
      label: slim ? st.name : st.label,
      sublabel: slim ? undefined : st.sublabel ?? undefined,
      icon: st.icon,
      disabled: st.mode === 'error' ? true : undefined,
      disabledReason: st.reason ?? undefined,
      attrs: slim || st.name === st.label ? {} : {'aria-label': st.name},
    });
  }

  function buildLoop() {
    const def = row('loop');
    const b = Button({label: COPY.loopControl, icon: slim ? undefined : 'repeat', command: def.command, registry, size,
      longPressMs: LONG_PRESS_MS, onLongPress: (e) => run(def.longPress, {event: e}), pressed: false});
    bindLongPress(b.el, def.longPress);
    destroyers.push(() => b.destroy());
    parts.loop = b;
    control('loop', b.el);
  }

  function buildSpeed() {
    const def = row('speed');
    if (slim) {
      const b = Button({label: COPY.speedChip(100), size, command: def.value, registry, icon: 'gauge',
        longPressMs: LONG_PRESS_MS, onLongPress: (e) => run(def.valueLongPress, {event: e}), attrs: {'aria-label': `${COPY.speed} 100%`}});
      bindLongPress(b.el, def.valueLongPress);
      destroyers.push(() => b.destroy());
      parts.speedChip = b;
      control('speed', b.el);
      return;
    }
    let value = pct(snap().rate);
    const stepper = Stepper({
      label: COPY.speed, decLabel: COPY.slower, incLabel: COPY.faster, value, min: PCT_MIN, max: PCT_MAX, step: 1, bigStep: 5,
      size: 'dock', format: (v) => COPY.percent(v),
      onChange: (v, {source}) => {
        const delta = v - value;
        if (source === 'key' && Math.abs(delta) !== 1 && Math.abs(delta) !== 5) {
          run('speed.set', {args: {rate: v / 100}, source: 'key'});
        } else if (source === 'key' && Math.abs(delta) === 1) {
          run(delta > 0 ? 'speed.upFine' : 'speed.downFine', {source: 'key'});
        } else {
          run(delta > 0 ? def.inc : def.dec, {source: source === 'key' ? 'key' : 'pointer'});
        }
        value = pct(snap().rate);
        stepper.set({value});
      },
      onValueClick: (e) => run(def.value, {event: e}),
      onValueLongPress: (e) => run(def.valueLongPress, {event: e}),
    });
    const valueEl = stepper.el.querySelector('.ui-stepper-value');
    if (valueEl) bindLongPress(valueEl, def.valueLongPress);
    destroyers.push(() => stepper.destroy());
    parts.speed = {stepper, get value() { return value; }, set(v) { value = v; stepper.set({value: v}); }};
    control('speed', stepper.el);
  }

  function buildCountIn() {
    const def = row('countIn');
    const b = Button({label: COPY.countIn, sublabel: slim ? undefined : COPY.countLength(1, 'bars'), icon: variant === 'dock' ? 'count-in' : undefined,
      command: def.command, registry, size, pressed: false,
      longPressMs: LONG_PRESS_MS, onLongPress: (e) => run(def.longPress, {event: e})});
    bindLongPress(b.el, def.longPress);
    destroyers.push(() => b.destroy());
    parts.countIn = b;
    control('countIn', b.el);
  }

  function buildClick() {
    const def = row('click');
    const b = Button({label: COPY.click, icon: slim ? undefined : undefined, command: def.command, registry, size, pressed: false,
      longPressMs: LONG_PRESS_MS, onLongPress: (e) => run(def.longPress, {event: e})});
    bindLongPress(b.el, def.longPress);
    destroyers.push(() => b.destroy());
    parts.click = b;
    control('click', b.el);
  }

  function buildMix() {
    const def = row('mix');
    const main = Button({label: COPY.mixControl, icon: variant === 'dock' ? 'minus-me' : undefined, command: def.command, registry, size,
      pressed: false, longPressMs: LONG_PRESS_MS, onLongPress: (e) => run(def.longPress, {event: e}),
      className: 'ctl-mix-main', attrs: {'aria-label': COPY.minusMeName(COPY.mixControl)}});
    bindLongPress(main.el, def.longPress);
    const caret = IconButton({label: COPY.mixSheet, icon: 'chevron-up', command: def.caret, registry, size, variant: 'secondary', className: 'ctl-mix-caret'});
    destroyers.push(() => main.destroy(), () => caret.destroy());
    parts.mix = {main, caret, key: ''};
    const group = h('div', {class: 'ctl-mix'}, main.el, caret.el);
    control('mix', group);
  }

  function buildPause() {
    const def = row('pause');
    const b = IconButton({label: COPY.pause, icon: 'pause', command: def.command, registry, size});
    destroyers.push(() => b.destroy());
    parts.pause = b;
    control('pause', b.el);
  }

  function buildPosition() {
    const bar = h('span', {class: 'ctl-pos-bar'});
    const sep = h('span', {class: 'ctl-pos-sep', 'aria-hidden': 'true'}, COPY.separator.trim());
    const beat = h('span', {class: 'ctl-pos-beat'});
    const main = h('span', {class: 'ctl-pos-main'}, bar, sep, beat);
    const sub = h('span', {class: 'ctl-pos-sub'});
    const box = h('div', {class: 'ctl-position', role: 'group', 'aria-label': COPY.position, dataset: {volatile: true}}, main, sub);
    parts.position = {bar, sep, beat, sub, box, text: ''};
    control('position', box);
  }

  function paintPosition(frame) {
    const p = parts.position;
    if (!p) return;
    const {main, sub} = session.position.label(frame.position);
    const text = `${main}|${sub ?? ''}`;
    if (text === p.text) return;
    p.text = text;
    const at = main.indexOf(COPY.separator);
    p.bar.textContent = at < 0 ? main : main.slice(0, at);
    p.beat.textContent = at < 0 ? '' : main.slice(at + COPY.separator.length);
    p.sep.hidden = at < 0;
    p.beat.hidden = at < 0;
    p.sub.textContent = sub ?? '';
    p.sub.hidden = !sub;
    p.box.setAttribute('aria-label', `${COPY.position} ${main}${sub ? `, ${sub}` : ''}`);
  }

  const BUILD = {again: buildAgain, play: buildPlay, loop: buildLoop, speed: buildSpeed, countIn: buildCountIn, click: buildClick,
    mix: buildMix, pause: buildPause, position: buildPosition};
  for (const id of LAYOUT[variant]) BUILD[id]();

  // ---- painting -----------------------------------------------------------------------------------------------
  const last = {};
  function paint() {
    const s = snap();
    const load = session.load?.peek?.() ?? {phase: 'ready'};
    root.toggleAttribute('data-playing', s.phase === 'playing' || s.phase === 'counting');
    root.dataset.phase = s.phase;
    paintPlay(s, load);
    if (parts.loop && last.loop !== !!s.loop?.on) {
      last.loop = !!s.loop?.on;
      parts.loop.set({pressed: last.loop});
    }
    if (parts.speed) {
      const v = pct(s.rate);
      if (v !== parts.speed.value) parts.speed.set(v);
      parts.speed.stepper.el.toggleAttribute('data-at-100', v === 100);
    }
    if (parts.speedChip) {
      const v = pct(s.rate);
      if (last.speedChip !== v) {
        last.speedChip = v;
        parts.speedChip.set({label: COPY.speedChip(v), attrs: {'aria-label': `${COPY.speed} ${v}%`}});
      }
    }
    if (parts.countIn) {
      const c = countInState(s, {mapped: mapped()});
      const key = JSON.stringify(c);
      if (last.countIn !== key) {
        last.countIn = key;
        parts.countIn.set({label: c.label, sublabel: slim ? undefined : c.sublabel, pressed: c.pressed});
      }
    }
    if (parts.click) {
      const on = s.click?.mode === 'always';
      if (last.click !== on) { last.click = on; parts.click.set({pressed: on}); }
    }
    if (parts.mix) {
      const m = mixState(s);
      const key = JSON.stringify(m);
      if (parts.mix.key !== key) {
        parts.mix.key = key;
        parts.mix.main.set({label: slim ? `${m.label}${m.sublabel ? ` ${m.sublabel}` : ''}` : m.label,
          sublabel: slim ? undefined : m.sublabel ?? undefined, pressed: m.pressed, attrs: {'aria-label': m.name}});
      }
    }
    if (parts.position) paintPosition(readFrame(session));
  }

  offs.push(effect(() => {
    if (session.transport.snapshot) session.transport.snapshot.value;
    session.load?.value;
    session.position?.mapped?.value;
    session.position?.revision?.value;
    untracked(() => {
      paint();
      // Enabled state and disabled reasons (speed at 25%, Click on an unmapped song) follow the snapshot.
      registry.invalidate?.();
    });
  }));
  if (parts.position && session.frame?.subscribe) {
    offs.push(session.frame.subscribe((f) => paintPosition(f), {hz: 30}));
  }

  // ---- anchors (the sheets anchor to these controls) ---------------------------------------------------------
  // Set on the 'stage' context's `anchors` Map while mounted. (Not [data-anchor]: that attribute is the
  // overlay primitive's positioning hook, src/styles/primitives/position.css.)
  const anchorEls = [
    ['play', parts.play?.button.el],
    ['speed', parts.speed?.stepper.el ?? parts.speedChip?.el],
    ['loop', parts.loop?.el],
    ['click', parts.click?.el ?? parts.countIn?.el],
    ['mix', root.querySelector('.ctl-mix')],
  ].filter(([, node]) => !!node);
  const anchors = stage?.anchors ?? registry.context?.().stage?.anchors ?? null;
  const mine = [];
  if (anchors && typeof anchors.set === 'function') {
    for (const [name, node] of anchorEls) { anchors.set(name, node); mine.push([name, node]); }
  }

  return {
    el: root,
    destroy() {
      ac.abort();
      for (const off of offs.splice(0)) { try { off?.(); } catch (err) { console.warn('[controls] cleanup failed', err); } }
      for (const fn of destroyers.splice(0)) { try { fn(); } catch (err) { console.warn('[controls] cleanup failed', err); } }
      for (const [name, node] of mine) if (anchors.get(name) === node) anchors.delete(name);
      mine.length = 0;
      root.remove();
    },
  };
}

export default mountControls;
