// @vitest-environment happy-dom
// U3: display primitives (architecture §2.12, D15; spec §3.4, §4.3, §8.6–8.8).
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {keydown, pointer, restoreDomShims, setMedia} from './helpers/dom.js';
import {setPlatform} from '../src/app/keys.js';
import {createRegistry} from '../src/app/commands.js';
import {openOverlays, pushOverlay, startDispatcher} from '../src/app/dispatch.js';
import {Kbd, kbdLabel, TOUCH_ONLY_QUERY} from '../src/ui/kbd.js';
import {placeTooltip, tooltip, TOOLTIP_DELAY_MS, TOOLTIP_LEAVE_GRACE_MS} from '../src/ui/tooltip.js';
import {ProgressRail, ProgressRing, StageStepper, stageStates, STATIC_RAIL_VALUE} from '../src/ui/progress.js';
import {Tabs} from '../src/ui/tabs.js';
import {EmptyState} from '../src/ui/empty.js';
import {Skeleton} from '../src/ui/skeleton.js';
import {Readout} from '../src/ui/readout.js';
import {BeatLamps, chunkGroups, groupOfUnit, lampLayout} from '../src/ui/beat-lamps.js';

beforeEach(() => {
  document.body.replaceChildren();
  setPlatform('win');
});

afterEach(() => {
  restoreDomShims();
  setPlatform(null);
  vi.useRealTimers();
  document.body.replaceChildren();
  delete document.documentElement.dataset.place;
  delete document.documentElement.dataset.posture;
});

const mount = p => { document.body.append(p.el); return p; };

// ------------------------------------------------------------------------------------------------ common props

describe('common props and destroy (every display primitive)', () => {
  const factories = {
    Kbd: () => Kbd({keys: 'KeyK'}),
    ProgressRail: () => ProgressRail({value: 0.5}),
    ProgressRing: () => ProgressRing({value: 0.5}),
    StageStepper: () => StageStepper({stages: [{id: 'a', label: 'A'}], current: 'a'}),
    Tabs: () => Tabs({tabs: [{id: 'a', label: 'A'}], value: 'a', label: 'T'}),
    EmptyState: () => EmptyState({title: 'Nothing'}),
    Skeleton: () => Skeleton({shape: 'card', count: 2}),
    Readout: () => Readout({value: '1'}),
    BeatLamps: () => BeatLamps({units: 4, groups: [1, 1, 1, 1]}),
  };

  test.each(Object.keys(factories))('%s applies className, id, attrs, dataset and testid, patches them, and destroys', name => {
    const p = mount(factories[name]());
    expect(Object.keys(p).sort()).toEqual(expect.arrayContaining(['destroy', 'el', 'set']));
    const cls = p.el.className;
    expect(cls).toMatch(/\bui-/);
    p.set({className: 'one two', id: 'x-1', attrs: {'aria-describedby': 'd'}, dataset: {volatile: true}, testid: 'tid'});
    expect(p.el.classList.contains('one')).toBe(true);
    expect(p.el.classList.contains('two')).toBe(true);
    expect(p.el.id).toBe('x-1');
    expect(p.el.getAttribute('aria-describedby')).toBe('d');
    expect(p.el.dataset.volatile).toBe('');
    expect(p.el.dataset.testid).toBe('tid');
    p.set({className: 'two', attrs: {}, dataset: {}, testid: null});
    expect(p.el.classList.contains('one')).toBe(false);
    expect(p.el.classList.contains('two')).toBe(true);
    expect(p.el.className).toContain(cls.split(' ')[0]);
    expect(p.el.hasAttribute('aria-describedby')).toBe(false);
    expect('volatile' in p.el.dataset).toBe(false);
    expect('testid' in p.el.dataset).toBe(false);
    p.destroy();
    expect(p.el.isConnected).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ Kbd

describe('Kbd', () => {
  test('labels follow the platform: ⌘ glyphs on Mac and iPad, words elsewhere', () => {
    setPlatform('mac');
    expect(mount(Kbd({keys: 'Mod+KeyK'})).el.textContent).toBe('⌘K');
    expect(Kbd({keys: 'Shift+Space'}).el.textContent).toBe('⇧Space');
    expect(Kbd({keys: 'Mod+Shift+KeyZ'}).el.textContent).toBe('⇧⌘Z');
    setPlatform('ipad');
    expect(Kbd({keys: 'Mod+KeyK'}).el.textContent).toBe('⌘K');
    setPlatform('win');
    expect(Kbd({keys: 'Mod+KeyK'}).el.textContent).toBe('Ctrl+K');
    expect(Kbd({keys: 'Shift+Space'}).el.textContent).toBe('Shift+Space');
    expect(Kbd({keys: 'Mod+Shift+KeyZ'}).el.textContent).toBe('Ctrl+Shift+Z');
    expect(Kbd({keys: '['}).el.textContent).toBe('[');
    expect(Kbd({keys: 'Digit1'}).el.textContent).toBe('1');
  });

  test('set() picks up a keys.js platform change made after the cap was drawn', () => {
    setPlatform('win');
    const k = mount(Kbd({keys: 'Mod+KeyK'}));
    expect(k.el.textContent).toBe('Ctrl+K');
    setPlatform('mac');
    const text = k.el.firstChild;
    k.set({});
    expect(k.el.textContent).toBe('⌘K');
    k.set({});
    expect(k.el.firstChild).not.toBe(text);
    const again = k.el.firstChild;
    k.set({force: false});
    expect(k.el.firstChild).toBe(again);   // unchanged labels are not re-rendered
  });

  test('a platform prop overrides keys.js, and set() relabels', () => {
    const k = mount(Kbd({keys: 'Mod+KeyK', platform: 'mac'}));
    expect(k.el.textContent).toBe('⌘K');
    expect(k.el.tagName).toBe('KBD');
    expect(k.el.dataset.keys).toBe('Mod+KeyK');
    k.set({platform: 'win'});
    expect(k.el.textContent).toBe('Ctrl+K');
    k.set({keys: 'KeyL'});
    expect(k.el.textContent).toBe('L');
    expect(kbdLabel('Mod+,', {platform: 'mac'})).toBe('⌘,');
  });

  test('an array renders alternatives as nested caps, read as "or"', () => {
    const k = mount(Kbd({keys: ['PageDown', 'ArrowRight']}));
    const caps = k.el.querySelectorAll('kbd.ui-kbd-key');
    expect([...caps].map(c => c.textContent)).toEqual(['Page Down', '→']);
    expect(k.el.querySelector('.sr-only').textContent).toBe(' or ');
    expect(k.el.querySelector('.ui-kbd-sep').getAttribute('aria-hidden')).toBe('true');
  });

  test('hidden on touch-only devices unless forced, tracking the media query live', () => {
    setMedia({coarse: false, hoverNone: false});
    const k = mount(Kbd({keys: 'KeyL'}));
    const forced = mount(Kbd({keys: 'KeyL', force: true}));
    expect(k.el.hidden).toBe(false);
    setMedia({coarse: true, hoverNone: true});
    expect(window.matchMedia(TOUCH_ONLY_QUERY).matches).toBe(true);
    expect(k.el.hidden).toBe(true);
    expect(forced.el.hidden).toBe(false);
    expect(forced.el.dataset.force).toBe('');
    // A coarse pointer that still hovers (a stylus, a hybrid) keeps its caps.
    setMedia({coarse: true, hoverNone: false});
    expect(k.el.hidden).toBe(false);
    setMedia({coarse: true, hoverNone: true});
    k.set({force: true});
    expect(k.el.hidden).toBe(false);
    k.set({force: false});
    expect(k.el.hidden).toBe(true);
  });

  test('created on a touch-only device it starts hidden; destroy stops listening', () => {
    setMedia({coarse: true, hoverNone: true});
    const k = mount(Kbd({keys: 'KeyL'}));
    expect(k.el.hidden).toBe(true);
    k.destroy();
    setMedia({coarse: false, hoverNone: false});
    expect(k.el.hidden).toBe(true);
  });

  test('a hint cap carries data-hint (shown only under [data-kbd-hints], spec §5.0)', () => {
    const k = mount(Kbd({keys: 'Digit5', hint: true}));
    expect(k.el.dataset.hint).toBe('');
    k.set({hint: false});
    expect('hint' in k.el.dataset).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ tooltip

describe('tooltip', () => {
  const button = (attrs = {}) => {
    const b = document.createElement('button');
    for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
    b.textContent = attrs.text ?? '';
    document.body.append(b);
    return b;
  };
  const shown = () => document.querySelector('[role=tooltip]');

  test('hover shows it after 400 ms with the text and the key-cap, and describes the anchor', () => {
    vi.useFakeTimers();
    const b = button({'aria-label': 'Zoom in'});
    const off = tooltip(b, {text: 'Zoom the chart in', kbd: '='});
    pointer(b, 'pointerenter', {pointerType: 'mouse'});
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1);
    expect(shown()).toBeNull();
    vi.advanceTimersByTime(1);
    const tip = shown();
    expect(tip).not.toBeNull();
    expect(tip.querySelector('.ui-tooltip-text').textContent).toBe('Zoom the chart in');
    expect(tip.querySelector('kbd.ui-kbd').textContent).toBe('=');
    expect(b.getAttribute('aria-describedby')).toBe(tip.id);
    pointer(b, 'pointerleave', {pointerType: 'mouse'});
    vi.advanceTimersByTime(TOOLTIP_LEAVE_GRACE_MS);
    expect(shown()).toBeNull();
    expect(b.hasAttribute('aria-describedby')).toBe(false);
    off();
  });

  test('touch never shows a tooltip', () => {
    vi.useFakeTimers();
    const b = button({'aria-label': 'Loop'});
    tooltip(b, {text: 'Loop', kbd: 'KeyL'});
    pointer(b, 'pointerenter', {pointerType: 'touch'});
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS * 3);
    expect(shown()).toBeNull();
  });

  test('keyboard focus shows it; blur, Escape and pointerdown hide it', () => {
    vi.useFakeTimers();
    const b = button({'aria-label': 'Loop'});
    tooltip(b, {text: 'Loop this section', kbd: 'KeyL'});
    b.focus();
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(shown()).not.toBeNull();
    keydown('Escape', {target: b});
    expect(shown()).toBeNull();
    b.blur();
    b.focus();
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(shown()).not.toBeNull();
    pointer(b, 'pointerdown', {pointerType: 'mouse'});
    expect(shown()).toBeNull();
    b.focus();
    b.blur();
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(shown()).toBeNull();
  });

  test('one tooltip at a time; the next shows at once while one is up (warm)', () => {
    vi.useFakeTimers();
    const a = button({'aria-label': 'A'});
    const c = button({'aria-label': 'C'});
    tooltip(a, {text: 'First'});
    tooltip(c, {text: 'Second'});
    pointer(a, 'pointerenter');
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(shown().textContent).toBe('First');
    pointer(a, 'pointerleave');
    pointer(c, 'pointerenter');
    expect(document.querySelectorAll('[role=tooltip]')).toHaveLength(1);
    expect(shown().textContent).toBe('Second');
    pointer(c, 'pointerleave');
    vi.advanceTimersByTime(1000);
    pointer(a, 'pointerenter');
    expect(shown()).toBeNull();
  });

  test('a tooltip repeating the accessible name does not describe; text and kbd may be functions; off.set updates', () => {
    vi.useFakeTimers();
    const b = button({'aria-label': 'Loop'});
    let title = 'Loop';
    const off = tooltip(b, {text: () => title, kbd: () => 'KeyL'});
    pointer(b, 'pointerenter');
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(shown().textContent).toContain('Loop');
    expect(b.hasAttribute('aria-describedby')).toBe(false);
    off.set({text: 'Loop the chorus', kbd: null});
    expect(shown().querySelector('.ui-tooltip-text').textContent).toBe('Loop the chorus');
    expect(shown().querySelector('kbd')).toBeNull();
    expect(b.getAttribute('aria-describedby')).toBe(shown().id);
    title = 'ignored after set';
    off();
    expect(shown()).toBeNull();
    pointer(b, 'pointerenter');
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(shown()).toBeNull();
  });

  test('keeps an existing aria-describedby and restores it', () => {
    vi.useFakeTimers();
    const b = button({'aria-label': 'Split', 'aria-describedby': 'reason'});
    tooltip(b, {text: 'Re-split this song'});
    pointer(b, 'pointerenter');
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(b.getAttribute('aria-describedby')).toBe(`reason ${shown().id}`);
    pointer(b, 'pointerleave');
    vi.advanceTimersByTime(TOOLTIP_LEAVE_GRACE_MS);
    expect(b.getAttribute('aria-describedby')).toBe('reason');
  });

  test('Escape hides a hover tooltip wherever focus is (a non-modal overlay); an overlay behind it stays', () => {
    vi.useFakeTimers();
    const stop = startDispatcher({registry: createRegistry(), platform: 'win'});
    const sheetClosed = vi.fn();
    const popSheet = pushOverlay({modal: false, onEscape: sheetClosed});
    const b = button({'aria-label': 'Loop'});
    const off = tooltip(b, {text: 'Loop (L)'});
    pointer(b, 'pointerenter', {pointerType: 'mouse'});
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(shown()).not.toBeNull();
    expect(openOverlays()).toHaveLength(2);
    expect(document.activeElement).toBe(document.body);
    keydown('Escape', {target: document.body});
    expect(shown()).toBeNull();
    expect(sheetClosed).not.toHaveBeenCalled();
    expect(openOverlays()).toHaveLength(1);
    keydown('Escape', {target: document.body});
    expect(sheetClosed).toHaveBeenCalledTimes(1);
    // Hidden any other way, it leaves the stack too.
    pointer(b, 'pointerenter', {pointerType: 'mouse'});
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(openOverlays()).toHaveLength(2);
    pointer(b, 'pointerdown', {pointerType: 'mouse'});
    expect(openOverlays()).toHaveLength(1);
    popSheet();
    stop();
    off();
  });

  test('removing the anchor while the tooltip is up hides it and clears the warm state', async () => {
    vi.useFakeTimers();
    const b = button({'aria-label': 'Search'});
    const other = button({'aria-label': 'Other'});
    tooltip(b, {text: 'Search songs', kbd: 'Mod+KeyK'});
    tooltip(other, {text: 'Something else'});
    pointer(b, 'pointerenter', {pointerType: 'mouse'});
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(shown()).not.toBeNull();
    b.remove();
    await Promise.resolve();
    await Promise.resolve();
    expect(shown()).toBeNull();
    vi.advanceTimersByTime(1000);
    pointer(other, 'pointerenter', {pointerType: 'mouse'});
    expect(shown()).toBeNull();   // not "warm": the stale tooltip no longer counts as visible
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(shown().textContent).toBe('Something else');
  });

  test('Enter or Space on the focused anchor hides it (keyboard activation, like pointerdown)', () => {
    vi.useFakeTimers();
    const b = button({'aria-label': 'Loop'});
    tooltip(b, {text: 'Loop this section', kbd: 'KeyL'});
    b.focus();
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(shown()).not.toBeNull();
    keydown('Enter', {target: b});
    expect(shown()).toBeNull();
    b.blur();
    b.focus();
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(shown()).not.toBeNull();
    keydown('Space', {target: b});
    expect(shown()).toBeNull();
  });

  test('hoverable: moving from the anchor onto the tooltip keeps it; leaving the tooltip hides it', () => {
    vi.useFakeTimers();
    const b = button({'aria-label': 'Zoom in'});
    tooltip(b, {text: 'Zoom the chart in'});
    pointer(b, 'pointerenter', {pointerType: 'mouse'});
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    const tip = shown();
    pointer(b, 'pointerleave', {pointerType: 'mouse'});
    pointer(tip, 'pointerenter', {pointerType: 'mouse'});
    vi.advanceTimersByTime(TOOLTIP_LEAVE_GRACE_MS * 3);
    expect(shown()).toBe(tip);
    pointer(tip, 'pointerleave', {pointerType: 'mouse'});
    vi.advanceTimersByTime(TOOLTIP_LEAVE_GRACE_MS);
    expect(shown()).toBeNull();
  });

  test('scroll and resize hide it and remove their listeners', () => {
    vi.useFakeTimers();
    const b = button({'aria-label': 'Loop'});
    tooltip(b, {text: 'Loop this section'});
    const spy = vi.spyOn(globalThis, 'removeEventListener');
    for (const type of ['scroll', 'resize']) {
      pointer(b, 'pointerenter', {pointerType: 'mouse'});
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS * 2);
      expect(shown()).not.toBeNull();
      globalThis.dispatchEvent(new window.Event(type));
      expect(shown()).toBeNull();
      expect(spy.mock.calls.some(([t]) => t === type)).toBe(true);
      pointer(b, 'pointerleave', {pointerType: 'mouse'});
      vi.advanceTimersByTime(1000);
    }
    spy.mockRestore();
  });

  test('placeTooltip goes above, flips below near the top and clamps to the viewport', () => {
    const view = {width: 400, height: 300};
    const size = {width: 100, height: 30};
    expect(placeTooltip({left: 150, top: 100, bottom: 140, width: 40, height: 40}, size, view)).toEqual({left: 120, top: 62, placement: 'top'});
    expect(placeTooltip({left: 150, top: 10, bottom: 50, width: 40, height: 40}, size, view)).toEqual({left: 120, top: 58, placement: 'bottom'});
    expect(placeTooltip({left: 0, top: 100, bottom: 140, width: 20, height: 40}, size, view).left).toBe(8);
    expect(placeTooltip({left: 390, top: 100, bottom: 140, width: 10, height: 40}, size, view).left).toBe(292);
  });
});

// ------------------------------------------------------------------------------------------------ progress

describe('ProgressRail', () => {
  test('determinate: progressbar semantics and the fill', () => {
    const r = mount(ProgressRail({value: 0.46, label: 'Splitting'}));
    expect(r.el.getAttribute('role')).toBe('progressbar');
    expect(r.el.getAttribute('aria-label')).toBe('Splitting');
    expect(r.el.getAttribute('aria-valuenow')).toBe('46');
    expect(r.el.getAttribute('aria-valuetext')).toBe('46%');
    expect(r.el.querySelector('.ui-progress-rail-fill').style.getPropertyValue('--progress')).toBe('0.46');
    expect('indeterminate' in r.el.dataset).toBe(false);
    r.set({value: 2});
    expect(r.el.getAttribute('aria-valuenow')).toBe('100');
    r.set({value: -1});
    expect(r.el.getAttribute('aria-valuenow')).toBe('0');
  });

  test('null → shimmer; static at 90% under reduced motion, tracking the media query live', () => {
    setMedia({reducedMotion: false});
    const r = mount(ProgressRail({value: null, label: 'Finishing'}));
    const fill = r.el.querySelector('.ui-progress-rail-fill');
    expect(r.el.dataset.indeterminate).toBe('');
    expect(r.el.dataset.motion).toBe('animate');
    expect(r.el.hasAttribute('aria-valuenow')).toBe(false);
    expect(fill.style.getPropertyValue('--progress')).toBe('');
    setMedia({reducedMotion: true});
    expect(r.el.dataset.motion).toBe('static');
    expect(fill.style.getPropertyValue('--progress')).toBe(String(STATIC_RAIL_VALUE));
    expect(r.el.hasAttribute('aria-valuenow')).toBe(false);   // still indeterminate for assistive tech
    setMedia({reducedMotion: false});
    expect(r.el.dataset.motion).toBe('animate');
    r.set({value: 0.3});
    expect('motion' in r.el.dataset).toBe(false);
    expect('indeterminate' in r.el.dataset).toBe(false);
  });

  test('created under reduced motion it starts static; destroy stops listening', () => {
    setMedia({reducedMotion: true});
    const r = mount(ProgressRail({value: null}));
    expect(r.el.dataset.motion).toBe('static');
    r.destroy();
    setMedia({reducedMotion: false});
    expect(r.el.dataset.motion).toBe('static');
  });

  test('striped track ("Waiting") and a decorative rail without a label', () => {
    const r = mount(ProgressRail({value: 0, striped: true}));
    expect(r.el.dataset.striped).toBe('');
    expect(r.el.getAttribute('aria-hidden')).toBe('true');
    expect(r.el.hasAttribute('role')).toBe(false);
    r.set({striped: false, label: 'Waiting'});
    expect('striped' in r.el.dataset).toBe(false);
    expect(r.el.getAttribute('role')).toBe('progressbar');
    expect(r.el.hasAttribute('aria-hidden')).toBe(false);
  });
});

describe('ProgressRing', () => {
  test('value draws the arc; sizes by name or px', () => {
    const r = mount(ProgressRing({value: 0.62, label: 'Loading 62%'}));
    const arc = r.el.querySelector('.ui-progress-ring-fill');
    expect(arc.getAttribute('stroke-dasharray')).toBe('62.00 100');
    expect(arc.getAttribute('pathLength')).toBe('100');
    expect(r.el.getAttribute('aria-valuenow')).toBe('62');
    expect(r.el.dataset.size).toBe('md');
    r.set({size: 'lg'});
    expect(r.el.dataset.size).toBe('lg');
    r.set({size: 80});
    expect('size' in r.el.dataset).toBe(false);
    expect(r.el.style.inlineSize).toBe('80px');
    r.set({size: 'fill'});
    expect(r.el.dataset.size).toBe('fill');
    expect(r.el.style.inlineSize).toBe('');
  });

  test('null turns; reduced motion holds a static arc', () => {
    setMedia({reducedMotion: false});
    const r = mount(ProgressRing({value: null}));
    expect(r.el.dataset.motion).toBe('animate');
    expect(r.el.getAttribute('aria-hidden')).toBe('true');
    setMedia({reducedMotion: true});
    expect(r.el.dataset.motion).toBe('static');
    expect(r.el.querySelector('.ui-progress-ring-fill').getAttribute('stroke-dasharray')).toBe('25.00 100');
  });
});

describe('StageStepper', () => {
  const STAGES = [{id: 'fetch', label: 'Fetch'}, {id: 'split', label: 'Split'}, {id: 'finish', label: 'Finish'}, {id: 'ready', label: 'Ready'}];

  test('stageStates is pure: done before current, pending after, nothing started for null', () => {
    expect(stageStates(STAGES, 'split')).toEqual(['done', 'current', 'pending', 'pending']);
    expect(stageStates(STAGES, null)).toEqual(['pending', 'pending', 'pending', 'pending']);
    expect(stageStates(STAGES, 'ready')).toEqual(['done', 'done', 'done', 'current']);
    expect(stageStates(STAGES, 'finish', {failed: true})).toEqual(['done', 'done', 'failed', 'pending']);
  });

  test('renders Fetch ✓ — Split ● 46% — Finish — Ready', () => {
    const s = mount(StageStepper({stages: STAGES, current: 'split', percent: 46}));
    expect(s.el.tagName).toBe('OL');
    expect(s.el.getAttribute('aria-label')).toBe('Progress');
    const items = [...s.el.children];
    expect(items.map(li => li.dataset.state)).toEqual(['done', 'current', 'pending', 'pending']);
    expect(items.map(li => li.querySelector('.ui-stage-stepper-label').textContent)).toEqual(['Fetch', 'Split', 'Finish', 'Ready']);
    expect(items[0].querySelector('use').getAttribute('href')).toBe('#i-check');
    expect(items[1].getAttribute('aria-current')).toBe('step');
    expect(items.filter(li => li.hasAttribute('aria-current'))).toHaveLength(1);
    const pct = items[1].querySelector('.ui-stage-stepper-percent');
    expect(pct.textContent).toBe('46%');
    expect(pct.dataset.volatile).toBe('');
    expect(items[2].querySelector('.ui-stage-stepper-percent').hidden).toBe(true);
    expect(items.map(li => li.querySelector('.sr-only').textContent)).toEqual([', done', ', in progress', ', not started', ', not started']);
  });

  test('set moves the current stage reusing nodes; failed shows ✕', () => {
    const s = mount(StageStepper({stages: STAGES, current: 'split', percent: 46, label: 'Harbor Lights'}));
    const split = s.el.children[1];
    s.set({percent: 47});
    expect(split.querySelector('.ui-stage-stepper-percent').textContent).toBe('47%');
    s.set({current: 'finish', percent: null});
    expect(s.el.children[1]).toBe(split);
    expect(split.dataset.state).toBe('done');
    expect(s.el.children[2].dataset.state).toBe('current');
    expect(s.el.children[2].querySelector('.ui-stage-stepper-percent').hidden).toBe(true);
    s.set({failed: true});
    expect(s.el.children[2].dataset.state).toBe('failed');
    expect(s.el.children[2].querySelector('use').getAttribute('href')).toBe('#i-x');
    expect(s.el.getAttribute('aria-label')).toBe('Harbor Lights');
    s.set({stages: STAGES.slice(1)});
    expect(s.el.children).toHaveLength(3);
    expect(s.el.children[0]).toBe(split);
  });
});

// ------------------------------------------------------------------------------------------------ Tabs

describe('Tabs', () => {
  const TABS = [{id: 'map', label: 'Map'}, {id: 'chart', label: 'Chart'}, {id: 'details', label: 'Details'}];

  test('tablist semantics, roving tabindex and ids for panels', () => {
    const t = mount(Tabs({tabs: TABS.map(x => ({...x, controls: `panel-${x.id}`})), value: 'chart', label: 'Edit', variant: 'posture', id: 'edit-tabs'}));
    expect(t.el.getAttribute('role')).toBe('tablist');
    expect(t.el.getAttribute('aria-label')).toBe('Edit');
    expect(t.el.dataset.variant).toBe('posture');
    expect(t.el.getAttribute('data-consume-keys')).toBe('ArrowLeft ArrowRight Home End');
    const tabs = [...t.el.querySelectorAll('[role=tab]')];
    expect(tabs.map(x => x.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(tabs.map(x => x.tabIndex)).toEqual([-1, 0, -1]);
    expect(tabs.map(x => x.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON']);
    expect(tabs[0].type).toBe('button');
    expect(tabs[1].id).toBe(t.tabId('chart'));
    expect(t.tabId('chart')).toBe('edit-tabs-tab-chart');
    expect(tabs[1].getAttribute('aria-controls')).toBe('panel-chart');
  });

  test('a click selects and reports source pointer; clicking the selected tab does nothing', () => {
    const onChange = vi.fn();
    const t = mount(Tabs({tabs: TABS, value: 'map', onChange}));
    const [, chart] = t.el.querySelectorAll('[role=tab]');
    chart.dispatchEvent(new MouseEvent('click', {bubbles: true, detail: 1}));
    expect(onChange).toHaveBeenCalledWith('chart', {source: 'pointer'});
    expect(chart.getAttribute('aria-selected')).toBe('true');
    expect(chart.tabIndex).toBe(0);
    chart.dispatchEvent(new MouseEvent('click', {bubbles: true, detail: 1}));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('arrows move focus with wrap-around and skip disabled tabs; Home/End; manual activation selects on Enter', () => {
    const onChange = vi.fn();
    const t = mount(Tabs({tabs: [...TABS.slice(0, 2), {id: 'off', label: 'Off', disabled: true}, TABS[2]], value: 'map', onChange}));
    const tab = id => t.el.querySelector(`[data-tab=${id}]`);
    t.focus();
    expect(document.activeElement).toBe(tab('map'));
    expect(keydown('ArrowRight').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(tab('chart'));
    keydown('ArrowRight');
    expect(document.activeElement).toBe(tab('details'));   // 'off' is skipped
    expect(tab('off').getAttribute('aria-disabled')).toBe('true');
    keydown('ArrowRight');
    expect(document.activeElement).toBe(tab('map'));        // wraps
    keydown('ArrowLeft');
    expect(document.activeElement).toBe(tab('details'));
    keydown('Home');
    expect(document.activeElement).toBe(tab('map'));
    keydown('End');
    expect(document.activeElement).toBe(tab('details'));
    expect(tab('details').tabIndex).toBe(0);
    expect(tab('map').tabIndex).toBe(-1);
    expect(onChange).not.toHaveBeenCalled();
    // Enter activates the focused button natively (a click with detail 0).
    tab('details').dispatchEvent(new MouseEvent('click', {bubbles: true, detail: 0}));
    expect(onChange).toHaveBeenCalledWith('details', {source: 'keyboard'});
    tab('off').dispatchEvent(new MouseEvent('click', {bubbles: true}));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("activation 'auto' selects as focus moves", () => {
    const onChange = vi.fn();
    const t = mount(Tabs({tabs: TABS, value: 'map', onChange, activation: 'auto'}));
    t.focus();
    keydown('ArrowRight');
    expect(onChange).toHaveBeenCalledWith('chart', {source: 'keyboard'});
    expect(t.el.querySelector('[data-tab=chart]').getAttribute('aria-selected')).toBe('true');
  });

  test('href tabs are links; with onChange a plain click is handled, a modified click is left to the browser; Space activates', () => {
    const onChange = vi.fn();
    const t = mount(Tabs({tabs: [{id: 'general', label: 'General', href: '/settings/general'}, {id: 'audio', label: 'Audio', href: '/settings/audio'}], value: 'general', onChange}));
    const audio = t.el.querySelector('[data-tab=audio]');
    expect(audio.tagName).toBe('A');
    expect(audio.getAttribute('href')).toBe('/settings/audio');
    const click = new MouseEvent('click', {bubbles: true, cancelable: true, detail: 1});
    audio.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith('audio', {source: 'pointer'});
    const general = t.el.querySelector('[data-tab=general]');
    const meta = new MouseEvent('click', {bubbles: true, cancelable: true, metaKey: true});
    general.dispatchEvent(meta);
    expect(meta.defaultPrevented).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
    general.focus();
    const space = keydown('Space');
    expect(space.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith('general', {source: 'keyboard'});
  });

  test('set() reconciles tabs without recreating the focused one', () => {
    const t = mount(Tabs({tabs: TABS, value: 'map'}));
    const chart = t.el.querySelector('[data-tab=chart]');
    chart.focus();
    t.set({tabs: [{id: 'chart', label: 'Drum chart'}, ...TABS.filter(x => x.id !== 'chart')], value: 'chart'});
    expect(t.el.querySelector('[data-tab=chart]')).toBe(chart);
    expect(document.activeElement).toBe(chart);
    expect(chart.textContent).toBe('Drum chart');
    expect(chart.getAttribute('aria-selected')).toBe('true');
    t.set({tabs: TABS.slice(1)});
    expect(t.el.querySelectorAll('[role=tab]')).toHaveLength(2);
  });

  test('a tab without a label throws in dev', () => {
    expect(() => Tabs({tabs: [{id: 'x', label: ''}]})).toThrow(/needs a label/);
  });

  test('dispatcher interop: arrows on a focused tab stay with the tablist, not the registry', () => {
    const r = createRegistry();
    const ran = [];
    r.register({id: 'transport.prevBar', title: 'Previous bar', group: 'Transport', keys: ['ArrowLeft'], scopes: ['stage'], run: () => ran.push('prev')});
    r.register({id: 'transport.nextBar', title: 'Next bar', group: 'Transport', keys: ['ArrowRight'], scopes: ['stage'], run: () => ran.push('next')});
    const stop = startDispatcher({registry: r, platform: 'win'});
    document.documentElement.dataset.place = 'stage';
    document.documentElement.dataset.posture = 'stage';
    try {
      const outside = document.createElement('button');
      document.body.append(outside);
      outside.focus();
      keydown('ArrowRight');
      expect(ran).toEqual(['next']);
      const t = mount(Tabs({tabs: TABS, value: 'map'}));
      t.focus();
      keydown('ArrowRight');
      expect(document.activeElement).toBe(t.el.querySelector('[data-tab=chart]'));
      keydown('ArrowLeft');
      expect(document.activeElement).toBe(t.el.querySelector('[data-tab=map]'));
      expect(ran).toEqual(['next']);
    } finally {
      stop();
    }
  });

  test('non-string ids work for click and arrow keys', () => {
    const onChange = vi.fn();
    const t = mount(Tabs({tabs: [{id: 1, label: 'A'}, {id: 2, label: 'B'}, {id: 3, label: 'C'}], value: 1, onChange}));
    const tabs = [...t.el.querySelectorAll('[role=tab]')];
    tabs[1].dispatchEvent(new MouseEvent('click', {bubbles: true, detail: 1}));
    expect(onChange).toHaveBeenCalledWith(2, {source: 'pointer'});
    tabs[1].focus();
    keydown('ArrowRight', {target: tabs[1]});
    expect(document.activeElement).toBe(tabs[2]);
    keydown('Enter', {target: tabs[2]});
    tabs[2].click();
    expect(onChange).toHaveBeenLastCalledWith(3, expect.anything());
  });

  test('a tab that loses its href becomes a button; one that gains it becomes a link', () => {
    const t = mount(Tabs({tabs: [{id: 'a', label: 'A', href: '/a'}, {id: 'b', label: 'B'}], value: 'a'}));
    let [a, b] = t.el.querySelectorAll('[role=tab]');
    expect(a.tagName).toBe('A');
    expect(a.getAttribute('href')).toBe('/a');
    t.set({tabs: [{id: 'a', label: 'A'}, {id: 'b', label: 'B', href: '/b'}]});
    [a, b] = t.el.querySelectorAll('[role=tab]');
    expect(a.tagName).toBe('BUTTON');
    expect(a.hasAttribute('href')).toBe(false);
    expect(a.getAttribute('aria-selected')).toBe('true');
    expect(a.id).toBe(t.tabId('a'));
    expect(b.tagName).toBe('A');
    expect(b.getAttribute('href')).toBe('/b');
    expect(t.el.querySelectorAll('[role=tab]')).toHaveLength(2);
  });
});

// ------------------------------------------------------------------------------------------------ EmptyState

describe('EmptyState', () => {
  test('a labelled section with a heading, a body and actions', () => {
    const onFind = vi.fn();
    const button = document.createElement('button');
    button.textContent = 'Write one';
    const e = mount(EmptyState({
      title: 'No drum chart yet',
      body: ['No songs match "', Object.assign(document.createElement('b'), {textContent: 'zzzz'}), '".'],
      actions: [{label: 'Find a chart', onClick: onFind, variant: 'primary'}, {label: 'Get Woodshed for desktop', href: '/download', target: '_blank'}, {el: button}],
    }));
    expect(e.el.tagName).toBe('SECTION');
    const h = e.el.querySelector('h2');
    expect(h.textContent).toBe('No drum chart yet');
    expect(e.el.getAttribute('aria-labelledby')).toBe(h.id);
    expect(e.el.querySelector('.ui-empty-body').textContent).toBe('No songs match "zzzz".');
    expect(e.el.querySelector('.ui-empty-body b').textContent).toBe('zzzz');
    const [find, link, own] = e.el.querySelector('.ui-empty-actions').children;
    expect(find.tagName).toBe('BUTTON');
    expect(find.type).toBe('button');
    expect(find.dataset.variant).toBe('primary');
    find.click();
    expect(onFind).toHaveBeenCalledTimes(1);
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/download');
    expect(link.rel).toBe('noopener');
    expect(own).toBe(button);
  });

  test('heading level, hidden empty parts and updates', () => {
    const e = mount(EmptyState({title: 'Nothing here', headingLevel: 3}));
    expect(e.el.querySelector('h3').textContent).toBe('Nothing here');
    expect(e.el.querySelector('.ui-empty-body').hidden).toBe(true);
    expect(e.el.querySelector('.ui-empty-actions').hidden).toBe(true);
    e.set({body: 'Add a song to start.', headingLevel: 2});
    expect(e.el.querySelector('h3')).toBeNull();
    expect(e.el.querySelector('h2').textContent).toBe('Nothing here');
    expect(e.el.querySelector('.ui-empty-body').hidden).toBe(false);
    e.set({actions: [{label: 'Show all', onClick() {}}]});
    expect(e.el.querySelector('.ui-empty-actions').textContent).toBe('Show all');
    expect(() => EmptyState({actions: [{onClick() {}}]})).toThrow(/needs a label/);
  });
});

// ------------------------------------------------------------------------------------------------ Skeleton

describe('Skeleton', () => {
  test.each([['card', 8], ['row', 3], ['text', 4], ['cell', 16]])('%s × %i', (shape, count) => {
    const s = mount(Skeleton({shape, count}));
    expect(s.el.dataset.shape).toBe(shape);
    expect(s.el.querySelectorAll('.ui-skeleton-item')).toHaveLength(count);
    expect(s.el.getAttribute('aria-hidden')).toBe('true');
    if (shape === 'card' || shape === 'row') expect(s.el.querySelectorAll('.ui-skeleton-cover')).toHaveLength(count);
    if (shape === 'cell') expect(s.el.querySelectorAll('.ui-skeleton-cell')).toHaveLength(count);
  });

  test('a label adds a status for assistive tech; count and shape changes rebuild; bad shapes throw in dev', () => {
    const s = mount(Skeleton({shape: 'card', count: 2, label: 'Loading songs…'}));
    expect(s.el.hasAttribute('aria-hidden')).toBe(false);
    expect(s.el.querySelector('[role=status]').textContent).toBe('Loading songs…');
    const first = s.el.querySelector('.ui-skeleton-item');
    s.set({label: 'Loading songs…'});
    expect(s.el.querySelector('.ui-skeleton-item')).toBe(first);
    s.set({count: 3});
    expect(s.el.querySelectorAll('.ui-skeleton-item')).toHaveLength(3);
    expect(s.el.querySelector('[role=status]')).not.toBeNull();
    s.set({label: null, count: 0});
    expect(s.el.children).toHaveLength(0);
    expect(s.el.getAttribute('aria-hidden')).toBe('true');
    expect(() => Skeleton({shape: 'blob'})).toThrow(/unknown shape/);
  });
});

// ------------------------------------------------------------------------------------------------ Readout

describe('Readout', () => {
  test('minCh fixes the value width in ch so digits never jitter the layout', () => {
    const r = mount(Readout({label: 'Position', value: '13 · 2', size: 'position', mono: true, minCh: 7}));
    const value = r.el.querySelector('.ui-readout-value');
    expect(value.style.minWidth).toBe('7ch');
    r.set({value: '114 · 4'});
    expect(value.style.minWidth).toBe('7ch');
    r.set({minCh: 5});
    expect(value.style.minWidth).toBe('5ch');
    r.set({minCh: null});
    expect(value.style.minWidth).toBe('');
    r.set({sub: '0:26 / 1:04', subMinCh: 11});
    expect(r.el.querySelector('.ui-readout-sub').style.minWidth).toBe('11ch');
  });

  test('a labelled group with size, tone and mono; sub hidden when empty', () => {
    const r = mount(Readout({label: 'Speed', value: '100%', sub: '', size: 'speed', tone: 'ink-3', mono: true}));
    expect(r.el.getAttribute('role')).toBe('group');
    expect(r.el.getAttribute('aria-label')).toBe('Speed');
    expect(r.el.dataset.size).toBe('speed');
    expect(r.el.dataset.tone).toBe('ink-3');
    expect(r.el.dataset.mono).toBe('');
    expect(r.el.querySelector('.ui-readout-sub').hidden).toBe(true);
    r.set({value: '75%', sub: '84 bpm', tone: 'ink'});
    expect(r.el.querySelector('.ui-readout-value').textContent).toBe('75%');
    expect(r.el.querySelector('.ui-readout-sub').textContent).toBe('84 bpm');
    expect(r.el.querySelector('.ui-readout-sub').hidden).toBe(false);
    expect(r.el.dataset.tone).toBe('ink');
    r.set({mono: false, label: null, value: 0});
    expect('mono' in r.el.dataset).toBe(false);
    expect(r.el.hasAttribute('role')).toBe(false);
    expect(r.el.querySelector('.ui-readout-value').textContent).toBe('0');
  });

  test('per-frame updates touch only the text node, and only when the text changed', () => {
    const r = mount(Readout({value: '1:12', size: 'position', mono: true}));
    const node = r.el.querySelector('.ui-readout-value').firstChild;
    const records = [];
    const mo = new MutationObserver(list => records.push(...list));
    mo.observe(r.el, {subtree: true, attributes: true, childList: true, characterData: true});
    r.set({value: '1:12'});
    r.set({value: '1:12'});
    r.set({value: '1:13'});
    return Promise.resolve().then(() => {
      mo.disconnect();
      expect(r.el.querySelector('.ui-readout-value').firstChild).toBe(node);
      expect(node.data).toBe('1:13');
      expect(records.map(m => m.type)).toEqual(['characterData']);
    });
  });

  test.each(['identity', 'sub', 'loop', 'section', 'speed', 'position', 'count'])('size %s is accepted', size => {
    expect(Readout({size}).el.dataset.size).toBe(size);
  });

  test('unknown sizes and tones throw in dev', () => {
    expect(() => Readout({size: 'huge'})).toThrow(/unknown size/);
    expect(() => Readout({tone: 'red'})).toThrow(/unknown tone/);
  });
});

// ------------------------------------------------------------------------------------------------ BeatLamps

describe('BeatLamps (D15)', () => {
  const kinds = l => [...l.el.querySelectorAll('.ui-beat-lamp')].map(d => d.dataset.kind);
  const states = l => [...l.el.querySelectorAll('.ui-beat-lamp')].map(d => d.dataset.state).join(' ');
  const groupSizes = l => [...l.el.querySelectorAll('.ui-beat-lamps-group')].map(g => g.children.length);

  test('4/4: four dots in one even row, the downbeat largest', () => {
    const l = mount(BeatLamps({units: 4, groups: [1, 1, 1, 1]}));
    expect(l.mode).toBe('units');
    expect(l.dots).toBe(4);
    expect(kinds(l)).toEqual(['downbeat', 'beat', 'beat', 'beat']);
    expect(groupSizes(l)).toEqual([4]);
    expect(l.el.getAttribute('aria-hidden')).toBe('true');
    expect(l.el.dataset.mode).toBe('units');
  });

  test('7/8 as 2+2+3: seven dots in three groups; each counted beat larger than the units', () => {
    const l = mount(BeatLamps({units: 7, groups: [2, 2, 3]}));
    expect(l.dots).toBe(7);
    expect(groupSizes(l)).toEqual([2, 2, 3]);
    expect(kinds(l)).toEqual(['downbeat', 'unit', 'beat', 'unit', 'beat', 'unit', 'unit']);
  });

  test('6/8: six dots in two groups of three', () => {
    const l = mount(BeatLamps({units: 6, groups: [3, 3]}));
    expect(groupSizes(l)).toEqual([3, 3]);
    expect(kinds(l)).toEqual(['downbeat', 'unit', 'unit', 'beat', 'unit', 'unit']);
  });

  test('15/16: more than 12 units shows one dot per group', () => {
    const l = mount(BeatLamps({units: 15, groups: [3, 3, 3, 3, 3]}));
    expect(l.mode).toBe('groups');
    expect(l.el.dataset.mode).toBe('groups');
    expect(l.dots).toBe(5);
    expect(kinds(l)).toEqual(['downbeat', 'beat', 'beat', 'beat', 'beat']);
    expect(groupSizes(l)).toEqual([5]);
    const odd = lampLayout(15, [4, 4, 4, 3]);
    expect(odd.mode).toBe('groups');
    expect(odd.dots.map(d => d.unit)).toEqual([0, 4, 8, 12]);
  });

  test('15/16 and 16/16 with the default all-ones grouping still show at most 12 dots (chunked)', () => {
    const fifteen = lampLayout(15, null);
    expect(fifteen.mode).toBe('groups');
    expect(fifteen.groups).toEqual([3, 3, 3, 3, 3]);
    expect(fifteen.dots).toHaveLength(5);
    const sixteen = lampLayout(16, Array(16).fill(1));
    expect(sixteen.groups).toEqual([4, 4, 4, 4]);
    expect(sixteen.dots.map(d => d.unit)).toEqual([0, 4, 8, 12]);
    expect(lampLayout(13, null).groups).toEqual([4, 4, 5]);
    expect(lampLayout(14, null).groups).toEqual([4, 4, 4, 2]);
    // Chunks follow counted-beat boundaries.
    expect(chunkGroups([2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 15)).toEqual([3, 3, 3, 3, 3]);
    for (let n = 13; n <= 48; n++) expect(lampLayout(n, null).dots.length).toBeLessThanOrEqual(12);
    const l = mount(BeatLamps({units: 16, groups: null}));
    expect(l.dots).toBe(4);
    l.frame(9);
    expect(states(l)).toBe('past past now next');
  });

  test('12 units is still one dot per unit; bad groups fall back to one per unit', () => {
    expect(lampLayout(12, [3, 3, 3, 3]).mode).toBe('units');
    expect(lampLayout(12, [3, 3, 3, 3]).dots).toHaveLength(12);
    expect(lampLayout(13, [3, 3, 3, 2, 2]).mode).toBe('groups');
    expect(lampLayout(4, [2, 3]).groups).toEqual([1, 1, 1, 1]);
    expect(lampLayout(3, null).groups).toEqual([1, 1, 1]);
    expect(lampLayout(0, []).dots).toEqual([]);
    expect(groupOfUnit([0, 2, 4], 7, 5)).toBe(2);
    expect(groupOfUnit([0, 2, 4], 7, 1)).toBe(0);
    expect(groupOfUnit([0, 2, 4], 7, 7)).toBe(-1);
    expect(groupOfUnit([0, 2, 4], 7, -1)).toBe(-1);
  });

  test('frame lights the playhead unit: ● ●  ● ◉  ○ ○ ○', () => {
    const l = mount(BeatLamps({units: 7, groups: [2, 2, 3]}));
    expect(states(l)).toBe('next next next next next next next');
    l.frame(3);
    expect(states(l)).toBe('past past past now next next next');
    l.frame(0);
    expect(states(l)).toBe('now next next next next next next');
    l.frame(null);
    expect(states(l)).toBe('next next next next next next next');
    l.frame(-1);
    l.frame(99);
    expect(states(l)).toBe('next next next next next next next');
  });

  test('in groups mode the lit dot is the counted beat holding the unit', () => {
    const l = mount(BeatLamps({units: 15, groups: [3, 3, 3, 3, 3]}));
    l.frame(7);
    expect(states(l)).toBe('past past now next next');
    l.frame(14);
    expect(states(l)).toBe('past past past past now');
  });

  test('a counted beat onset flashes its dot; ticks inside a beat do not; groupStart true re-triggers', () => {
    const l = mount(BeatLamps({units: 7, groups: [2, 2, 3]}));
    const dots = [...l.el.querySelectorAll('.ui-beat-lamp')];
    l.frame(0);
    expect(dots[0].dataset.flash).toBe('1');
    l.frame(0);
    l.frame(1);
    expect(dots[0].dataset.flash).toBe('1');
    expect(dots[1].dataset.flash).toBeUndefined();
    l.frame(2);
    expect(dots[0].dataset.flash).toBeUndefined();
    expect(dots[2].dataset.flash).toBe('2');
    l.frame(2, true);
    expect(dots[2].dataset.flash).toBe('1');
    l.frame(null);
    expect(dots.some(d => d.dataset.flash)).toBe(false);
  });

  test('a one-group bar re-flashes its downbeat when the playhead wraps to the next bar', () => {
    const l = mount(BeatLamps({units: 3, groups: [3]}));
    const dot = l.el.querySelector('.ui-beat-lamp');
    l.frame(0);
    expect(dot.dataset.flash).toBe('1');
    l.frame(1);
    l.frame(2);
    expect(dot.dataset.flash).toBe('1');
    l.frame(0);
    expect(dot.dataset.flash).toBe('2');
    l.frame(0);
    expect(dot.dataset.flash).toBe('2');   // repeated ticks on the same unit are not onsets
    // A one-unit bar (1/4) relies on groupStart = true at each onset.
    const one = mount(BeatLamps({units: 1, groups: [1]}));
    const d1 = one.el.querySelector('.ui-beat-lamp');
    one.frame(0);
    one.frame(0);
    expect(d1.dataset.flash).toBe('1');
    one.frame(0, true);
    expect(d1.dataset.flash).toBe('2');
  });

  test('frame with an unchanged unit makes no DOM writes; a step writes only the dots that change', async () => {
    const l = mount(BeatLamps({units: 4, groups: [1, 1, 1, 1]}));
    l.frame(1);
    const records = [];
    const mo = new MutationObserver(list => records.push(...list));
    mo.observe(l.el, {subtree: true, attributes: true, childList: true});
    l.frame(1);
    l.frame(1);
    await Promise.resolve();
    expect(records).toHaveLength(0);
    l.frame(2);
    await Promise.resolve();
    mo.disconnect();
    const touched = new Set(records.map(m => m.target));
    expect(touched.size).toBe(2);   // dot 1 → past and dot 2 → now (its flash rides on the same dot)
    expect(records.every(m => m.type === 'attributes')).toBe(true);
    expect(records.some(m => m.type === 'childList')).toBe(false);
  });

  test('set() keeps the dots for the same meter and rebuilds on a meter change; size', () => {
    const l = mount(BeatLamps({units: 4, groups: [1, 1, 1, 1]}));
    const first = l.el.querySelector('.ui-beat-lamp');
    l.set({units: 4, groups: [1, 1, 1, 1]});
    expect(l.el.querySelector('.ui-beat-lamp')).toBe(first);
    l.set({units: 7, groups: [2, 2, 3]});
    expect(l.el.querySelector('.ui-beat-lamp')).not.toBe(first);
    expect(l.dots).toBe(7);
    expect(l.el.dataset.size).toBe('md');
    l.set({size: 'sm'});
    expect(l.el.dataset.size).toBe('sm');
  });

  test('groupStart as a unit index picks the counted beat', () => {
    const l = mount(BeatLamps({units: 15, groups: [3, 3, 3, 3, 3]}));
    l.frame(6, 6);
    expect(states(l)).toBe('past past now next next');
  });
});
