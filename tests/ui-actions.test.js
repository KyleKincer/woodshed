// @vitest-environment happy-dom
// U1 actions: icon, Button, IconButton, Toggle, HoldButton (architecture §2.12, §9.4 U1).
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createRegistry} from '../src/app/commands.js';
import {setPlatform} from '../src/app/keys.js';
import * as clock from '../src/app/clock.js';
import {hasIcon, icon, installIcons} from '../src/ui/icon.js';
import * as buttonModule from '../src/ui/button.js';
import {Button, IconButton, applyCommon, trackPress, setAttr} from '../src/ui/button.js';
import {Toggle} from '../src/ui/toggle.js';
import {HoldButton} from '../src/ui/hold-button.js';
import {tooltip} from '../src/ui/tooltip.js';
import {Kbd} from '../src/ui/kbd.js';
import {ProgressRing} from '../src/ui/progress.js';
import {pointer, restoreDomShims, tap} from './helpers/dom.js';

// The U3 display peers, imported statically by their contract paths (§9.0) and mocked here by
// their contract shapes (§2.12): tooltip(el, {text, kbd}) → off, Kbd({keys}) → {el, set, destroy},
// ProgressRing({value, size, label}) → {el, set, destroy}. Fresh fakes per test (installPeers).
vi.mock('../src/ui/tooltip.js', () => ({tooltip: vi.fn()}));
vi.mock('../src/ui/kbd.js', () => ({Kbd: vi.fn()}));
vi.mock('../src/ui/progress.js', () => ({ProgressRing: vi.fn()}));
const fakes = {off: null, rings: []};
function installPeers() {
  fakes.off = vi.fn();
  fakes.rings = [];
  vi.mocked(tooltip).mockReset().mockImplementation(() => fakes.off);
  vi.mocked(Kbd).mockReset().mockImplementation(({keys}) => {
    const el = document.createElement('kbd');
    el.className = 'fake-kbd';
    el.textContent = keys;
    return {el, set: vi.fn(({keys: k}) => { el.textContent = k; }), destroy: vi.fn(() => el.remove())};
  });
  vi.mocked(ProgressRing).mockReset().mockImplementation(props => {
    const el = document.createElement('span');
    el.className = 'ui-progress-ring';
    const made = {props, values: [], el};
    fakes.rings.push(made);
    return {el, set: vi.fn(({value}) => made.values.push(value)), destroy: vi.fn(() => el.remove())};
  });
}

const FAKE = {toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame']};

let r;
const mounted = [];
function mount(prim) {
  document.body.append(prim.el);
  mounted.push(prim);
  return prim;
}
const name = el => el.getAttribute('aria-label') ?? [...el.childNodes]
  .filter(n => !(n.nodeType === 1 && n.getAttribute('aria-hidden') === 'true'))
  .map(n => (n.nodeType === 1 && n.hidden ? '' : n.textContent)).join('').trim();

beforeEach(() => {
  r = createRegistry();
  setPlatform('win');
  installPeers();
});

afterEach(() => {
  for (const p of mounted.splice(0)) p.destroy();
  document.body.replaceChildren();
  restoreDomShims();
  vi.useRealTimers();
  clock.reset();
  setPlatform(null);
});

describe('icon', () => {
  it('renders a sprite reference with the contract markup', () => {
    const svg = icon('play');
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('class')).toBe('ui-icon');
    expect([svg.getAttribute('width'), svg.getAttribute('height')]).toEqual(['20', '20']);
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(svg.querySelector('use').getAttribute('href')).toBe('#i-play');
    expect(icon('drum', {size: 32}).getAttribute('width')).toBe('32');
  });

  it('refuses names that are not sprite ids', () => {
    expect(() => icon('')).toThrow(TypeError);
    expect(() => icon('#i-play')).toThrow(TypeError);
    expect(() => icon(undefined)).toThrow(TypeError);
  });

  it('inlines the sprite hidden, once, and reuses one already in the page', () => {
    const root = installIcons();
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.getAttribute('focusable')).toBe('false');
    expect(document.body.firstChild).toBe(root);
    expect(document.getElementById('i-play')?.tagName.toLowerCase()).toBe('symbol');
    expect(document.getElementById('i-drum')).not.toBeNull();   // the custom glyph
    expect(installIcons()).toBe(root);
    expect(document.querySelectorAll('#i-play')).toHaveLength(1);
    expect(hasIcon('play')).toBe(true);
    expect(hasIcon('not-an-icon')).toBe(false);

    document.body.replaceChildren();
    const host = document.createElement('div');
    const existing = installIcons(document);
    host.append(existing);
    document.body.append(host);
    expect(installIcons()).toBe(existing);
  });
});

describe('shared plumbing', () => {
  it('applies and replaces the common props', () => {
    const el = document.createElement('div');
    const a = {className: 'one two', id: 'x', attrs: {title: 'T', 'aria-describedby': 'd'}, dataset: {kind: 'a', flag: true}, testid: 'tid'};
    applyCommon(el, a);
    expect(el.className).toBe('one two');
    expect(el.id).toBe('x');
    expect(el.getAttribute('title')).toBe('T');
    expect(el.getAttribute('data-kind')).toBe('a');
    expect(el.getAttribute('data-flag')).toBe('');
    expect(el.getAttribute('data-testid')).toBe('tid');
    applyCommon(el, {className: 'two three', attrs: {lang: 'en'}, dataset: {kind: 'b'}}, a);
    expect(el.className).toBe('two three');
    expect(el.hasAttribute('id')).toBe(false);
    expect(el.hasAttribute('title')).toBe(false);
    expect(el.getAttribute('lang')).toBe('en');
    expect(el.hasAttribute('data-flag')).toBe(false);
    expect(el.getAttribute('data-kind')).toBe('b');
    expect(el.hasAttribute('data-testid')).toBe(false);
  });

  it('setAttr only writes changes', () => {
    const el = document.createElement('div');
    const spy = vi.spyOn(el, 'setAttribute');
    setAttr(el, 'aria-pressed', 'true');
    setAttr(el, 'aria-pressed', 'true');
    setAttr(el, 'hidden', true);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(el.getAttribute('hidden')).toBe('');
    setAttr(el, 'hidden', false);
    expect(el.hasAttribute('hidden')).toBe(false);
  });

  it('trackPress fires a long-press on the fake clock and drops the click that follows', () => {
    vi.useFakeTimers(FAKE);
    const el = document.createElement('button');
    const ac = new AbortController();
    const long = vi.fn();
    const t = trackPress(el, {signal: ac.signal, ms: 500, onLongPress: long});
    pointer(el, 'pointerdown', {pointerType: 'touch'});
    vi.advanceTimersByTime(499);
    expect(long).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(long).toHaveBeenCalledTimes(1);
    expect(t.consumeClick()).toBe(true);
    expect(t.consumeClick()).toBe(false);
    ac.abort();
  });
});

describe('Button', () => {
  it('renders the label, variant, size and type, and patches in place', () => {
    const b = mount(Button({label: 'Save', variant: 'primary', size: 'lg', icon: 'check', className: 'extra', testid: 'save'}));
    const el = b.el;
    expect(el.tagName).toBe('BUTTON');
    expect(el.type).toBe('button');
    expect(el.classList.contains('ui-button')).toBe(true);
    expect(el.classList.contains('extra')).toBe(true);
    expect(el.dataset).toMatchObject({variant: 'primary', size: 'lg', testid: 'save'});
    expect(name(el)).toBe('Save');
    const label = el.querySelector('.ui-button-label');
    const svg = el.querySelector('svg.ui-icon');
    expect(svg.getAttribute('width')).toBe('24');
    b.set({label: 'Saved'});
    expect(el.querySelector('.ui-button-label')).toBe(label);
    expect(el.querySelector('svg.ui-icon')).toBe(svg);
    expect(label.textContent).toBe('Saved');
    b.set({icon: 'x', className: 'other'});
    expect(el.querySelector('svg.ui-icon')).not.toBe(svg);
    expect(el.querySelector('use').getAttribute('href')).toBe('#i-x');
    expect(el.classList.contains('extra')).toBe(false);
    expect(el.classList.contains('other')).toBe(true);
    b.set({variant: 'bogus', size: 'huge'});
    expect(el.dataset).toMatchObject({variant: 'secondary', size: 'md'});
  });

  it('calls onClick, and a disabled button stays focusable but ignores activation', () => {
    const onClick = vi.fn();
    const b = mount(Button({label: 'Go', onClick}));
    b.el.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    b.set({disabled: true});
    expect(b.el.getAttribute('aria-disabled')).toBe('true');
    expect(b.el.hasAttribute('disabled')).toBe(false);
    b.el.focus();
    expect(document.activeElement).toBe(b.el);
    b.el.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders disabledReason as visible text linked by aria-describedby, outside the name', () => {
    const onClick = vi.fn();
    const b = mount(Button({label: 'Re-split', disabledReason: 'Re-split from Woodshed for desktop.', onClick}));
    const reason = b.el.querySelector('.ui-button-reason');
    expect(reason.textContent).toBe('Re-split from Woodshed for desktop.');
    expect(reason.hidden).toBe(false);
    expect(b.el.getAttribute('aria-describedby')).toBe(reason.id);
    expect(name(b.el)).toBe('Re-split');
    expect(b.el.getAttribute('aria-disabled')).toBe('true');
    b.el.click();
    expect(onClick).not.toHaveBeenCalled();
    b.set({disabledReason: null});
    expect(b.el.querySelector('.ui-button-reason')).toBeNull();
    expect(b.el.hasAttribute('aria-describedby')).toBe(false);
    expect(b.el.hasAttribute('aria-disabled')).toBe(false);
  });

  it('shows busy states with aria-busy and still lets clicks through', () => {
    const onClick = vi.fn();
    const b = mount(Button({label: 'Play', onClick}));
    b.set({busy: true});
    expect(b.el.getAttribute('aria-busy')).toBe('true');
    expect(b.el.querySelector('.ui-button-spinner')).not.toBeNull();
    expect(name(b.el)).toBe('Play');
    b.set({busy: 'Opening secure billing…'});
    expect(name(b.el)).toBe('Opening secure billing…');
    b.set({busy: {label: 'Loading', percent: 61.6}});
    expect(name(b.el)).toBe('Loading 62%');
    b.el.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    b.set({busy: false});
    expect(b.el.hasAttribute('aria-busy')).toBe(false);
    expect(b.el.querySelector('.ui-button-spinner')).toBeNull();
    expect(name(b.el)).toBe('Play');
  });

  it('renders pressed, sublabel and an explicit key-cap', () => {
    const b = mount(Button({label: 'Count-in', sublabel: '1 bar', pressed: false, kbd: 'KeyC'}));
    expect(b.el.getAttribute('aria-pressed')).toBe('false');
    expect(b.el.querySelector('.ui-button-sublabel').textContent).toBe('1 bar');
    expect(b.el.getAttribute('aria-keyshortcuts')).toBe('C');
    const cap = b.el.querySelector('.ui-button-kbd');
    expect(cap.textContent).toContain('C');
    expect(cap.getAttribute('aria-hidden')).toBe('true');
    b.set({pressed: true, sublabel: null, kbd: null});
    expect(b.el.getAttribute('aria-pressed')).toBe('true');
    expect(b.el.querySelector('.ui-button-sublabel')).toBeNull();
    expect(b.el.querySelector('.ui-button-kbd')).toBeNull();
    expect(b.el.hasAttribute('aria-keyshortcuts')).toBe(false);
    b.set({pressed: undefined});
    expect(b.el.hasAttribute('aria-pressed')).toBe(false);
  });

  it('dock and play sizes carry their size for the stacked layout', () => {
    const b = mount(Button({label: 'Again', icon: 'rotate-ccw', size: 'dock'}));
    expect(b.el.dataset.size).toBe('dock');
    const kids = [...b.el.children].map(c => c.getAttribute('class'));
    expect(kids.indexOf('ui-icon')).toBeLessThan(kids.indexOf('ui-button-text'));
  });

  describe('with a command', () => {
    let state, runs;
    beforeEach(() => {
      state = {enabled: true, reason: null, checked: false, title: 'Loop'};
      runs = [];
      r.register({
        id: 'loop.toggle', title: () => state.title, group: 'Loop', keys: ['KeyL', 'Shift+KeyL'], scopes: ['stage'], icon: 'repeat',
        when: () => state.enabled, disabledReason: () => state.reason, checked: () => state.checked,
        run: (c, args) => runs.push({source: c.source, event: c.event, args}),
      });
    });

    it('takes its label, icon, title and key from the registry', () => {
      const b = mount(Button({command: 'loop.toggle', registry: r}));
      expect(name(b.el)).toBe('Loop');
      expect(b.el.querySelector('use').getAttribute('href')).toBe('#i-repeat');
      expect(b.el.getAttribute('aria-keyshortcuts')).toBe('L');
      expect(b.el.getAttribute('aria-pressed')).toBe('false');
      expect(tooltip).toHaveBeenLastCalledWith(b.el, {text: 'Loop', kbd: 'KeyL'});
      expect(b.el.hasAttribute('title')).toBe(false);
      const own = mount(Button({command: 'loop.toggle', registry: r, label: 'Loop it', icon: 'repeat-1', kbd: true}));
      expect(name(own.el)).toBe('Loop it');
      expect(own.el.querySelector('use').getAttribute('href')).toBe('#i-repeat-1');
      expect(own.el.querySelector('.ui-button-kbd').textContent).toContain('L');
    });

    it('runs the command with source pointer and the click event', () => {
      const onClick = vi.fn();
      const b = mount(Button({command: 'loop.toggle', registry: r, onClick}));
      b.el.click();
      expect(runs).toHaveLength(1);
      expect(runs[0].source).toBe('pointer');
      expect(runs[0].event?.type).toBe('click');
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('tracks when, disabledReason, checked and title live', () => {
      vi.useFakeTimers(FAKE);
      const b = mount(Button({command: 'loop.toggle', registry: r}));
      state.enabled = false;
      r.invalidate();
      vi.advanceTimersByTime(50);
      expect(b.el.getAttribute('aria-disabled')).toBe('true');
      expect(b.el.querySelector('.ui-button-reason')).toBeNull();
      b.el.click();
      expect(runs).toHaveLength(0);

      state.enabled = true;
      state.reason = 'Needs a bar grid';
      r.invalidate();
      vi.advanceTimersByTime(50);
      expect(b.el.getAttribute('aria-disabled')).toBe('true');
      expect(b.el.querySelector('.ui-button-reason').textContent).toBe('Needs a bar grid');

      state.reason = null;
      state.checked = true;
      state.title = 'Loop on';
      r.invalidate();
      vi.advanceTimersByTime(50);
      expect(b.el.hasAttribute('aria-disabled')).toBe(false);
      expect(b.el.getAttribute('aria-pressed')).toBe('true');
      expect(name(b.el)).toBe('Loop on');
      b.el.click();
      expect(runs).toHaveLength(1);
    });

    it('picks up a command registered after the button, and unsubscribes on destroy', () => {
      const b = mount(Button({command: 'speed.reset', registry: r, label: 'Reset'}));
      expect(b.el.getAttribute('aria-disabled')).toBe('true');
      r.register({id: 'speed.reset', title: 'Reset speed', group: 'Speed', keys: ['`'], scopes: ['stage'], run: () => runs.push('reset')});
      expect(b.el.hasAttribute('aria-disabled')).toBe(false);
      expect(b.el.getAttribute('aria-keyshortcuts')).toBe('`');

      const off = vi.fn();
      const fake = {...r, onChange: vi.fn(() => off)};
      const c = Button({command: 'speed.reset', registry: fake});
      document.body.append(c.el);
      expect(fake.onChange).toHaveBeenCalledTimes(1);
      c.destroy();
      expect(off).toHaveBeenCalledTimes(1);
      expect(c.el.isConnected).toBe(false);
    });
  });

  describe('long-press', () => {
    beforeEach(() => vi.useFakeTimers(FAKE));

    it('fires after 500 ms held and drops the click that follows', () => {
      const onClick = vi.fn(), onLongPress = vi.fn();
      const b = mount(Button({label: 'Play', onClick, onLongPress}));
      pointer(b.el, 'pointerdown', {pointerType: 'touch', x: 10, y: 10});
      vi.advanceTimersByTime(499);
      expect(onLongPress).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onLongPress).toHaveBeenCalledTimes(1);
      pointer(b.el, 'pointerup', {pointerType: 'touch', x: 10, y: 10});
      b.el.click();
      expect(onClick).not.toHaveBeenCalled();
      const menu = new MouseEvent('contextmenu', {bubbles: true, cancelable: true});
      b.el.dispatchEvent(menu);
      expect(menu.defaultPrevented).toBe(true);
    });

    it('a short press clicks; moving past the slop cancels; longPressMs is honoured', () => {
      const onClick = vi.fn(), onLongPress = vi.fn();
      const b = mount(Button({label: 'Play', onClick, onLongPress, longPressMs: 800}));
      tap(b.el, {x: 5, y: 5});
      expect(onClick).toHaveBeenCalledTimes(1);
      pointer(b.el, 'pointerdown', {x: 5, y: 5});
      pointer(b.el, 'pointermove', {x: 30, y: 5});
      vi.advanceTimersByTime(1000);
      expect(onLongPress).not.toHaveBeenCalled();
      pointer(b.el, 'pointerup', {x: 30, y: 5});
      pointer(b.el, 'pointerdown', {x: 5, y: 5});
      vi.advanceTimersByTime(799);
      expect(onLongPress).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onLongPress).toHaveBeenCalledTimes(1);
    });

    it('a disabled button never long-presses', () => {
      const onLongPress = vi.fn();
      const b = mount(Button({label: 'Play', onLongPress, disabled: true}));
      pointer(b.el, 'pointerdown', {pointerType: 'touch'});
      vi.advanceTimersByTime(600);
      expect(onLongPress).not.toHaveBeenCalled();
    });
  });
});

describe('IconButton', () => {
  it('throws in development without a label', () => {
    expect(() => IconButton({icon: 'x'})).toThrow(/label/);
    expect(() => IconButton({icon: 'x', label: '  '})).toThrow(/label/);
  });

  it('names itself with aria-label and hides the text', () => {
    const b = mount(IconButton({label: 'Close', icon: 'x', kbd: 'Escape'}));
    expect(b.el.getAttribute('aria-label')).toBe('Close');
    expect(b.el.dataset.iconOnly).toBe('');
    expect(b.el.querySelector('.ui-button-text').hidden).toBe(true);
    expect(tooltip).toHaveBeenCalledWith(b.el, {text: 'Close', kbd: 'Escape'});
    expect(b.el.hasAttribute('title')).toBe(false);
  });

  it('takes its name from a command', () => {
    r.register({id: 'app.shortcuts', title: 'Keyboard shortcuts', group: 'App', keys: ['?'], scopes: ['global'], icon: 'keyboard', run() {}});
    const b = mount(IconButton({command: 'app.shortcuts', registry: r}));
    expect(b.el.getAttribute('aria-label')).toBe('Keyboard shortcuts');
    expect(b.el.getAttribute('aria-keyshortcuts')).toBe('?');
    expect(() => IconButton({command: 'not.registered', registry: r})).toThrow(/label/);
  });
});

describe('Toggle', () => {
  it('flips aria-pressed and reports the new state', () => {
    const onChange = vi.fn();
    const t = mount(Toggle({label: 'Count-in', sublabel: '1 bar', onChange}));
    expect(t.el.getAttribute('aria-pressed')).toBe('false');
    expect(t.el.classList.contains('ui-toggle')).toBe(true);
    t.el.click();
    expect(t.el.getAttribute('aria-pressed')).toBe('true');
    expect(t.pressed).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(true, expect.any(Event));
    t.el.click();
    expect(onChange).toHaveBeenLastCalledWith(false, expect.any(Event));
    t.set({pressed: true});
    expect(t.el.getAttribute('aria-pressed')).toBe('true');
    expect(name(t.el)).toBe('Count-in1 bar');
  });

  it('names the feature, never the state', () => {
    expect(() => Toggle({label: 'On'})).toThrow(/feature/);
    const t = mount(Toggle({label: 'Click'}));
    expect(() => t.set({label: 'Off'})).toThrow(/feature/);
  });

  it('follows a command\'s checked state and reports it after running', () => {
    vi.useFakeTimers(FAKE);
    let on = false;
    r.register({id: 'click.countIn', title: 'Count-in', group: 'Click', keys: ['KeyC'], scopes: ['stage'], checked: () => on, run: () => { on = !on; }});
    const onChange = vi.fn();
    const t = mount(Toggle({command: 'click.countIn', registry: r, onChange}));
    expect(t.el.getAttribute('aria-pressed')).toBe('false');
    t.el.click();
    expect(onChange).toHaveBeenCalledWith(true, expect.any(Event));
    vi.advanceTimersByTime(50);
    expect(t.el.getAttribute('aria-pressed')).toBe('true');
    on = false;
    r.invalidate();
    vi.advanceTimersByTime(50);
    expect(t.el.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('HoldButton', () => {
  let playing, onActivate, onTapWhileHold;
  beforeEach(() => {
    vi.useFakeTimers(FAKE);
    clock.set(0);
    clock.set(() => Date.now());
    playing = true;
    onActivate = vi.fn();
    onTapWhileHold = vi.fn();
  });
  const make = (extra = {}) => mount(HoldButton({label: 'Library', icon: 'chevron-left', requireHold: () => playing, onActivate, onTapWhileHold, ...extra}));

  it('is an ordinary button when no hold is required (pointer and keyboard)', () => {
    playing = false;
    const b = make();
    tap(b.el);
    expect(onActivate).toHaveBeenCalledTimes(1);
    b.el.click();
    expect(onActivate).toHaveBeenCalledTimes(2);
    expect(onTapWhileHold).not.toHaveBeenCalled();
  });

  it('activates only after holdMs held, with the ring filling', () => {
    const b = make();
    pointer(b.el, 'pointerdown', {pointerType: 'touch'});
    expect(b.el.hasAttribute('data-holding')).toBe(true);
    vi.advanceTimersByTime(300);
    const fill = fakes.rings[0].values.at(-1);
    expect(fill).toBeGreaterThan(0.4);
    expect(fill).toBeLessThan(0.6);
    vi.advanceTimersByTime(299);
    expect(onActivate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(b.el.hasAttribute('data-holding')).toBe(false);
    pointer(b.el, 'pointerup', {pointerType: 'touch'});
    b.el.click();
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onTapWhileHold).not.toHaveBeenCalled();
  });

  it('a short tap gives the hint once and never activates', () => {
    const b = make({holdMs: 1000});
    pointer(b.el, 'pointerdown', {pointerType: 'touch'});
    vi.advanceTimersByTime(400);
    pointer(b.el, 'pointerup', {pointerType: 'touch'});
    b.el.click();
    vi.advanceTimersByTime(2000);
    expect(onTapWhileHold).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('keyboard activation gives the hint while a hold is required, and acts at once otherwise', () => {
    const b = make();
    b.el.click();   // Enter/Space on a focused button: a click with no pointer before it
    expect(onTapWhileHold).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
    playing = false;
    b.el.click();
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('leaving the button mid-hold cancels silently', () => {
    const b = make();
    pointer(b.el, 'pointerdown');
    vi.advanceTimersByTime(200);
    pointer(b.el, 'pointerleave');
    vi.advanceTimersByTime(1000);
    expect(b.el.hasAttribute('data-holding')).toBe(false);
    expect(onActivate).not.toHaveBeenCalled();
    expect(onTapWhileHold).not.toHaveBeenCalled();
    b.el.click();   // a later keyboard activation is not swallowed
    expect(onTapWhileHold).toHaveBeenCalledTimes(1);
  });

  it('requires a label when icon-only and cleans up on destroy', () => {
    expect(() => HoldButton({icon: 'chevron-left', iconOnly: true})).toThrow(/label/);
    const b = make({iconOnly: true});
    expect(b.el.getAttribute('aria-label')).toBe('Library');
    pointer(b.el, 'pointerdown');
    b.destroy();
    mounted.splice(mounted.indexOf(b), 1);
    vi.advanceTimersByTime(1000);
    expect(onActivate).not.toHaveBeenCalled();
    expect(b.el.isConnected).toBe(false);
  });
});

// The U3 display peers (mocked above): U1 renders through them and has no stand-ins of its own.
describe('display peers (U3 contract)', () => {
  it('has no peer seam or stand-in left (static imports, I0B-11)', () => {
    expect(buttonModule).not.toHaveProperty('setPeers');
    expect(buttonModule).not.toHaveProperty('peers');
    const plain = mount(Button({label: 'Save'}));
    expect(tooltip).not.toHaveBeenCalled();   // no text and no key: no tooltip at all
    expect(plain.el.hasAttribute('title')).toBe(false);
    expect(buttonModule.attachTooltip(plain.el, {text: '  ', kbd: null})).toBeTypeOf('function');
    expect(tooltip).not.toHaveBeenCalled();
  });

  it('IconButton: aria-label plus the tooltip with its key-cap, and no native title', () => {
    const b = mount(IconButton({label: 'Close', icon: 'x', kbd: 'Escape'}));
    expect(b.el.getAttribute('aria-label')).toBe('Close');
    expect(tooltip).toHaveBeenCalledTimes(1);
    expect(tooltip).toHaveBeenCalledWith(b.el, {text: 'Close', kbd: 'Escape'});
    expect(b.el.hasAttribute('title')).toBe(false);
    b.set({label: 'Close panel'});
    expect(fakes.off).toHaveBeenCalledTimes(1);
    expect(tooltip).toHaveBeenLastCalledWith(b.el, {text: 'Close panel', kbd: 'Escape'});
    b.destroy();
    mounted.splice(mounted.indexOf(b), 1);
    expect(fakes.off).toHaveBeenCalledTimes(2);
  });

  it('a command button gets the tooltip from the registry, and a shown key-cap is a Kbd', () => {
    r.register({id: 'loop.toggle', title: 'Loop', group: 'Loop', keys: ['KeyL'], scopes: ['stage'], icon: 'repeat', run() {}});
    const b = mount(Button({command: 'loop.toggle', registry: r, kbd: true}));
    expect(tooltip).toHaveBeenCalledWith(b.el, {text: 'Loop', kbd: 'KeyL'});
    expect(Kbd).toHaveBeenCalledWith({keys: 'KeyL'});
    const cap = b.el.querySelector('.fake-kbd');
    expect(cap.classList.contains('ui-button-kbd')).toBe(true);
    expect(cap.getAttribute('aria-hidden')).toBe('true');
    expect(b.el.querySelectorAll('kbd')).toHaveLength(1);   // the Kbd only, no plain <kbd> beside it
    expect(b.el.querySelector('.ui-keycap')).toBe(null);
  });

  it('HoldButton: a ProgressRing that fills with the hold and empties after it', () => {
    vi.useFakeTimers(FAKE);
    clock.set(0);
    clock.set(() => Date.now());
    const onActivate = vi.fn();
    const b = mount(HoldButton({label: 'Library', icon: 'chevron-left', requireHold: () => true, onActivate}));
    expect(ProgressRing).toHaveBeenCalledWith({value: 0, size: 32, label: 'Library'});
    const ring = fakes.rings[0];
    expect(ring.el.getAttribute('aria-hidden')).toBe('true');
    expect(b.el.querySelector('.ui-hold-icon').contains(ring.el)).toBe(true);
    expect([...b.el.querySelector('.ui-hold-icon').children].map(c => c.getAttribute('class'))).toEqual(['ui-progress-ring', 'ui-icon']);
    expect(b.el.querySelector('svg:not(.ui-icon)')).toBe(null);   // no stand-in ring beside the peer
    pointer(b.el, 'pointerdown', {pointerType: 'touch'});
    vi.advanceTimersByTime(300);
    const mid = ring.values.at(-1);
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
    vi.advanceTimersByTime(300);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(ring.values).toContain(1);
    expect(ring.values.at(-1)).toBe(0);
    expect(b.el.hasAttribute('data-holding')).toBe(false);
    b.set({size: 'play'});
    expect(ProgressRing).toHaveBeenLastCalledWith({value: 0, size: 48, label: 'Library'});
    expect(fakes.rings[1].el.isConnected).toBe(true);
    expect(ring.el.isConnected).toBe(false);   // the old ring is destroyed, not left beside the new one
  });
});

describe('HoldButton ring at rest (stylesheet)', () => {
  it('hides the ProgressRing unless a hold runs, and drops its easing', async () => {
    const {readFileSync} = await import('node:fs');
    const {resolve} = await import('node:path');
    const css = readFileSync(resolve(process.cwd(), 'src/styles/primitives/hold-button.css'), 'utf8');
    expect(css).toMatch(/\.ui-hold-button:not\(\[data-holding\]\) \.ui-hold-icon > :not\(\.ui-icon\) \{ visibility: hidden; \}/);
    expect(css).toMatch(/\.ui-hold-icon \.ui-progress-ring-fill \{ transition: none; \}/);
    // The stand-ins' styles are gone with them (I0B-11).
    expect(css).not.toMatch(/ui-hold-ring-/);
    expect(readFileSync(resolve(process.cwd(), 'src/styles/primitives/button.css'), 'utf8')).not.toMatch(/ui-keycap/);
  });
});
