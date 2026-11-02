// The Chart layout sheet (⋯ › Chart layout…, the palette): how the drum chart is laid out on this device, and
// the song's own line breaks.
//
// - Bars per line: Auto (the default: each line holds as many bars as their notes fit, so a busy bar gets the
//   room it needs) or 1–6 (prefs chart.lines.bars).
// - Spacing: Tight · Normal · Roomy (prefs chart.lines.spacing; chart-surface.js SPACING).
// - Size: Smaller · Larger (view.smaller / view.bigger, this Distance's size, like = and −).
// - Notation: Together · Hands & feet (view.display; the device's choice, else the part's own).
// - Line breaks: the bars that start a new line in this song (Score.lineBreaks, saved with the drum part, so
//   on every device), set from a bar's menu (New line here); Clear line breaks drops them all (owner only).
// - Reset layout: Auto, Normal and the part's own notation.
//
// The chart relayouts as each choice changes (chart-surface.js watches the prefs). Copy: sheets-b.copy.js.
//
//   export function render(container, {session, close, registry?, prefs?}) → {el, destroy}

import '../../styles/views/stage/sheets-layout.css';
import {registry as appRegistry} from '../../app/commands.js';
import {prefs as appPrefs} from '../../app/prefs.js';
import {effect} from '../../app/store.js';
import {h} from '../../ui/h.js';
import {Button} from '../../ui/button.js';
import {Segmented} from '../../ui/segmented.js';
import {COPY as ALL} from './sheets-b.copy.js';

const C = ALL.layout;
const BARS = Object.freeze(['auto', '1', '2', '3', '4', '5', '6']);
const SPACINGS = Object.freeze(['tight', 'normal', 'roomy']);
const peek = (v) => (v && typeof v === 'object' && typeof v.peek === 'function' ? v.peek() : v ?? null);
let seq = 0;

export function render(container, {session, registry = appRegistry, prefs = appPrefs} = {}) {
  if (!session) throw new TypeError('chart layout: a session is required');
  const id = `sheet-layout-${++seq}`;
  const offs = [];
  const part = () => session.notation?.part ?? null;
  const stage = () => { try { return registry.context()?.stage ?? null; } catch { return null; } };
  const notationNow = () => peek(stage()?.display) ?? part()?.score?.layout ?? 'combined';
  const breaks = () => (part()?.score?.lineBreaks ?? []).length;
  const canBreak = () => !session.readOnly && !!part()?.editor && !part()?.readOnly;
  const pref = (key, list, fallback) => { const v = prefs.get(`chart.lines.${key}`); return list.includes(v) ? v : fallback; };

  const section = (key, title, ...children) => {
    const headingId = `${id}-${key}`;
    return h('section', {class: 'sheet-layout-section', dataset: {section: key}, attrs: {'aria-labelledby': headingId}},
      h('h3', {class: 'sheet-layout-heading', id: headingId}, title), ...children);
  };

  const bars = Segmented({label: C.bars, size: 'md', className: 'sheet-layout-bars',
    options: BARS.map((value) => ({value, label: value === 'auto' ? C.auto : value})),
    value: pref('bars', BARS, 'auto'),
    onChange: (value) => prefs.set('chart.lines.bars', value)});
  const spacing = Segmented({label: C.spacing, size: 'md', className: 'sheet-layout-spacing',
    options: SPACINGS.map((value) => ({value, label: C[value]})),
    value: pref('spacing', SPACINGS, 'normal'),
    onChange: (value) => prefs.set('chart.lines.spacing', value)});
  const smaller = Button({label: C.smaller, command: 'view.smaller', registry, icon: 'zoom-out', size: 'md', variant: 'secondary'});
  const bigger = Button({label: C.bigger, command: 'view.bigger', registry, icon: 'zoom-in', size: 'md', variant: 'secondary'});
  const notation = Segmented({label: C.notation, size: 'md', className: 'sheet-layout-notation',
    options: [{value: 'combined', label: C.together}, {value: 'split', label: C.handsFeet}],
    value: notationNow(),
    onChange: (layout) => registry.run('view.display', {source: 'pointer', args: {layout}})});
  const breaksText = h('p', {class: 'sheet-layout-hint', id: `${id}-breaks-hint`});
  const clear = Button({label: C.clear, size: 'md', variant: 'secondary', icon: 'x',
    attrs: {'aria-describedby': breaksText.id},
    onClick: () => {
      const p = part();
      if (!canBreak() || !p.editor.clearLineBreaks()) return;
      p.commit('layout');
      paintBreaks();
    }});
  const reset = Button({label: C.reset, size: 'md', variant: 'ghost', icon: 'rotate-ccw',
    onClick: () => {
      prefs.update((d) => { d.chart.lines = {bars: 'auto', spacing: 'normal'}; });
      registry.run('view.display', {source: 'pointer', args: {layout: null}});
      notation.set({value: notationNow()});
    }});
  const parts = [bars, spacing, smaller, bigger, notation, clear, reset];

  function paintBreaks() {
    const n = breaks();
    breaksText.textContent = n ? C.breaksSome(n) : C.breaksNone;
    clear.el.hidden = !n || !canBreak();
  }

  const root = h('div', {class: 'sheet-layout', dataset: {sheetBody: 'chartLayout'}},
    section('bars', C.bars, bars.el, h('p', {class: 'sheet-layout-hint'}, C.barsHint)),
    section('spacing', C.spacing, spacing.el),
    section('size', C.size, h('div', {class: 'sheet-layout-row'}, smaller.el, bigger.el)),
    section('notation', C.notation, notation.el),
    section('breaks', C.breaks, breaksText, clear.el),
    h('div', {class: 'sheet-layout-foot'}, reset.el));
  container.append(root);
  paintBreaks();
  const p = part();
  if (typeof p?.subscribe === 'function') offs.push(p.subscribe(() => { paintBreaks(); notation.set({value: notationNow()}); }));
  // The notation, bars and spacing chosen elsewhere (the ⋯ menu's Display, another window) show here too.
  const display = stage()?.display;
  if (display && typeof display.subscribe === 'function') offs.push(display.subscribe(() => notation.set({value: notationNow()})));
  offs.push(effect(() => {
    const b = prefs.get('chart.lines.bars'), s = prefs.get('chart.lines.spacing');
    bars.set({value: BARS.includes(b) ? b : 'auto'});
    spacing.set({value: SPACINGS.includes(s) ? s : 'normal'});
  }));

  return {
    el: root,
    destroy() {
      for (const off of offs.splice(0)) { try { off(); } catch { /* best effort */ } }
      for (const c of parts) c.destroy?.();
      root.remove();
    },
  };
}
