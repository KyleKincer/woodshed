// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createRegistry} from '../src/app/commands.js';
import {activeScopeChain, openOverlays, pushOverlay, setPedalHandler, setSurfaceScope, startDispatcher} from '../src/app/dispatch.js';

let r, stop, pops, ran;

function cmd(id, keys, scopes, extra = {}) {
  const group = extra.group ?? 'Transport';
  r.register({id, title: id, group, keys, scopes, run: (c, args) => ran.push({id, source: c.source, event: c.event, args}), ...extra});
}

function setPlace(place, posture) {
  const ds = document.documentElement.dataset;
  if (place) ds.place = place; else delete ds.place;
  if (posture) ds.posture = posture; else delete ds.posture;
}

function key(type, init, target = document.activeElement ?? document.body) {
  const e = new KeyboardEvent(type, {bubbles: true, cancelable: true, composed: true, ...init});
  (target ?? document.body).dispatchEvent(e);
  return e;
}
const down = (init, target) => key('keydown', init, target);
const up = (init, target) => key('keyup', init, target);
const SPACE = {key: ' ', code: 'Space'};
const ENTER = {key: 'Enter', code: 'Enter'};
const ESC = {key: 'Escape', code: 'Escape'};

function el(html) {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

const ids = () => ran.map(x => x.id);

beforeEach(() => {
  r = createRegistry();
  ran = [];
  pops = [];
  stop = startDispatcher({registry: r, platform: 'win'});
  setPlace('stage', 'stage');
});

afterEach(() => {
  stop();
  for (const pop of pops) pop();
  setSurfaceScope(null);
  setPedalHandler(null);
  setPlace(null, null);
  document.body.replaceChildren();
  vi.useRealTimers();
});

const overlay = opts => { const pop = pushOverlay(opts); pops.push(pop); return pop; };

describe('rule 1: ignored events', () => {
  beforeEach(() => cmd('transport.playStop', ['Space'], ['stage']));

  it('ignores an already prevented event', () => {
    const e = new KeyboardEvent('keydown', {...SPACE, bubbles: true, cancelable: true});
    e.preventDefault();
    document.body.dispatchEvent(e);
    expect(ran).toEqual([]);
  });

  it('ignores composition, dead keys and plain Tab', () => {
    down({...SPACE, isComposing: true});
    down({key: 'Dead', code: 'BracketLeft'});
    cmd('app.tab', ['Tab'], ['stage'], {group: 'App'});
    const tab = down({key: 'Tab', code: 'Tab'});
    const shiftTab = down({key: 'Tab', code: 'Tab', shiftKey: true});
    expect(ran).toEqual([]);
    expect(tab.defaultPrevented).toBe(false);
    expect(shiftTab.defaultPrevented).toBe(false);
  });
});

describe('rule 2: pedals', () => {
  it('the pedal handler takes owned keys, keydown and keyup, before everything else', () => {
    cmd('nav.nextSection', ['PageDown'], ['stage'], {group: 'Navigate'});
    const handler = {owns: e => e.code === 'PageDown', down: vi.fn(), up: vi.fn()};
    setPedalHandler(handler);
    overlay({modal: true});                                    // even a modal overlay does not see pedal keys
    const d = down({key: 'PageDown', code: 'PageDown'});
    const u = up({key: 'PageDown', code: 'PageDown'});
    expect(handler.down).toHaveBeenCalledTimes(1);
    expect(handler.up).toHaveBeenCalledTimes(1);
    expect(d.defaultPrevented && u.defaultPrevented).toBe(true);
    expect(ran).toEqual([]);
  });

  it('keys the handler does not own reach the registry; without pedal mode PageDown is an ordinary key', () => {
    cmd('nav.nextSection', ['PageDown'], ['stage'], {group: 'Navigate'});
    setPedalHandler({owns: e => e.code === 'KeyB', down: vi.fn(), up: vi.fn()});
    down({key: 'PageDown', code: 'PageDown'});
    setPedalHandler(null);
    down({key: 'PageDown', code: 'PageDown'});
    expect(ids()).toEqual(['nav.nextSection', 'nav.nextSection']);
  });

  it('a keyup reaches the handler that took its keydown, even after that handler is replaced or removed', () => {
    const first = {owns: () => true, down: vi.fn(), up: vi.fn()};
    const second = {owns: () => true, down: vi.fn(), up: vi.fn()};
    setPedalHandler(first);
    down({key: 'b', code: 'KeyB'});
    setPedalHandler(second);
    const u = up({key: 'b', code: 'KeyB'});
    expect(first.up).toHaveBeenCalledTimes(1);
    expect(second.up).not.toHaveBeenCalled();
    expect(u.defaultPrevented).toBe(true);
    down({key: 'b', code: 'KeyB'});
    setPedalHandler(null);
    up({key: 'b', code: 'KeyB'});
    expect(second.up).toHaveBeenCalledTimes(1);
    up({key: 'b', code: 'KeyB'});                            // a stray keyup with no handler is ignored
    expect(second.up).toHaveBeenCalledTimes(1);
  });

  it('validates the handler', () => {
    expect(() => setPedalHandler({owns: () => true})).toThrow(/owns\(e\), down\(e\) and up\(e\)/);
  });
});

describe('rule 3: modal overlays', () => {
  beforeEach(() => {
    cmd('transport.playStop', ['Space'], ['stage']);
    cmd('app.palette', ['Mod+KeyK'], ['global'], {group: 'App'});
    cmd('palette.next', ['ArrowDown'], ['palette'], {group: 'App'});
  });

  it('runs only the overlay scope bindings plus Esc → onEscape', () => {
    const onEscape = vi.fn();
    const host = el('<div role="dialog"><input id="q"></div>');
    host.querySelector('#q').focus();
    overlay({el: host, modal: true, onEscape, scope: 'palette'});
    const space = down(SPACE);
    const k = down({key: 'k', code: 'KeyK', ctrlKey: true});
    down({key: 'ArrowDown', code: 'ArrowDown'});
    expect(ids()).toEqual(['palette.next']);
    expect(space.defaultPrevented).toBe(false);                 // left to the overlay's own elements
    expect(k.defaultPrevented).toBe(false);
    const esc = down(ESC);
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(esc.defaultPrevented).toBe(true);
  });

  it('a non-modal overlay above a modal one closes first on Esc, and its scope is consulted too', () => {
    cmd('menu.first', ['Home'], ['menu'], {group: 'App'});
    const modalEsc = vi.fn(), menuEsc = vi.fn();
    overlay({modal: true, onEscape: modalEsc, scope: 'palette'});
    overlay({modal: false, onEscape: menuEsc, scope: 'menu'});
    down({key: 'Home', code: 'Home'});
    down({key: 'ArrowDown', code: 'ArrowDown'});
    down(SPACE);
    expect(ids()).toEqual(['menu.first', 'palette.next']);
    down(ESC);
    expect(menuEsc).toHaveBeenCalledTimes(1);
    expect(modalEsc).not.toHaveBeenCalled();
  });

  it('pop is idempotent and restores normal dispatch', () => {
    const pop = pushOverlay({modal: true});
    expect(openOverlays()).toHaveLength(1);
    down(SPACE);
    pop(); pop();
    expect(openOverlays()).toHaveLength(0);
    down(SPACE);
    expect(ids()).toEqual(['transport.playStop']);
  });
});

describe('non-modal overlays (D36) and rule 8', () => {
  beforeEach(() => {
    cmd('transport.playStop', ['Space'], ['stage']);
    cmd('app.escape', ['Escape'], ['global'], {group: 'App'});
  });

  it('let registry keys through', () => {
    overlay({modal: false, onEscape: vi.fn()});
    down(SPACE);
    expect(ids()).toEqual(['transport.playStop']);
  });

  it('Esc closes the topmost one instead of reaching the registry', () => {
    const a = vi.fn(), b = vi.fn();
    overlay({modal: false, onEscape: a});
    overlay({modal: false, onEscape: b});
    const e = down(ESC);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
    expect(ran).toEqual([]);
  });

  it('with no overlay, Esc reaches the registry', () => {
    down(ESC);
    expect(ids()).toEqual(['app.escape']);
  });
});

describe('rule 4: text inputs pass only Esc and Mod+K', () => {
  beforeEach(() => {
    cmd('transport.playStop', ['Space'], ['stage']);
    cmd('marker.add', ['KeyS'], ['stage'], {group: 'Practice'});
    cmd('app.palette', ['Mod+KeyK'], ['global'], {group: 'App'});
    cmd('app.escape', ['Escape'], ['global'], {group: 'App'});
    cmd('practice.undo', ['Mod+KeyZ'], ['stage'], {group: 'Practice'});
  });

  for (const [name, html] of [
    ['input', '<input id="t">'],
    ['search input', '<input id="t" type="search">'],
    ['textarea', '<textarea id="t"></textarea>'],
    ['select', '<select id="t"><option>a</option></select>'],
    ['contenteditable', '<div id="t" contenteditable="true" tabindex="0"></div>'],
    ['data-text-input', '<div data-text-input><div id="t" tabindex="0"></div></div>'],
  ]) {
    it(`${name}: typing stays native, Mod+K opens the palette`, () => {
      el(html).querySelector('#t').focus();
      const space = down(SPACE);
      const s = down({key: 's', code: 'KeyS'});
      const z = down({key: 'z', code: 'KeyZ', ctrlKey: true});
      expect(ran).toEqual([]);
      expect(space.defaultPrevented || s.defaultPrevented || z.defaultPrevented).toBe(false);
      const k = down({key: 'k', code: 'KeyK', ctrlKey: true});
      expect(ids()).toEqual(['app.palette']);
      expect(k.defaultPrevented).toBe(true);
    });
  }

  it('Esc blurs the field and does not reach the registry', () => {
    const input = el('<input id="t">').querySelector('#t');
    input.focus();
    const e = down(ESC);
    expect(document.activeElement).not.toBe(input);
    expect(e.defaultPrevented).toBe(true);
    expect(ran).toEqual([]);
  });

  it('Esc closes the overlay the field is in', () => {
    const onEscape = vi.fn();
    const host = el('<div><textarea id="t"></textarea></div>');
    overlay({el: host, modal: false, onEscape});
    host.querySelector('#t').focus();
    down(ESC);
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('a field that consumes Esc keeps it', () => {
    const input = el('<input id="t" data-consume-keys="Escape">').querySelector('#t');
    input.focus();
    const e = down(ESC);
    expect(document.activeElement).toBe(input);
    expect(e.defaultPrevented).toBe(false);
  });

  it('checkboxes and range inputs are not text inputs', () => {
    el('<input id="c" type="checkbox">').querySelector('#c').focus();
    down({key: 's', code: 'KeyS'});
    expect(ids()).toEqual(['marker.add']);
  });
});

describe('rule 5: data-consume-keys', () => {
  beforeEach(() => {
    cmd('transport.playStop', ['Space'], ['stage']);
    cmd('nav.barBack', ['ArrowLeft'], ['stage'], {group: 'Navigate'});
    cmd('cue.nudgeBack', ['Alt+ArrowLeft'], ['stage'], {group: 'Navigate'});
    cmd('nav.home', ['Home'], ['stage'], {group: 'Navigate'});
    cmd('mix.mute.1', ['Digit1'], ['stage'], {group: 'Mix'});
    cmd('mix.solo.1', ['Shift+Digit1'], ['stage'], {group: 'Mix'});
    cmd('marker.add', ['KeyS'], ['stage'], {group: 'Practice'});
  });

  const slider = () => el('<div id="s" role="slider" tabindex="0" aria-valuenow="1" ' +
    'data-consume-keys="ArrowLeft ArrowRight ArrowUp ArrowDown Home End"></div>').querySelector('#s');

  it('a focused Slider keeps its arrows and Home/End', () => {
    slider().focus();
    const left = down({key: 'ArrowLeft', code: 'ArrowLeft'});
    const home = down({key: 'Home', code: 'Home'});
    expect(ran).toEqual([]);
    expect(left.defaultPrevented || home.defaultPrevented).toBe(false);
  });

  it('a focused Slider never swallows Space, digits or letters', () => {
    slider().focus();
    down(SPACE);
    down({key: '1', code: 'Digit1'});
    down({key: '!', code: 'Digit1', shiftKey: true});
    down({key: 's', code: 'KeyS'});
    expect(ids()).toEqual(['transport.playStop', 'mix.mute.1', 'mix.solo.1', 'marker.add']);
  });

  it('Shift keeps consuming; other modifiers reach the registry', () => {
    slider().focus();
    down({key: 'ArrowLeft', code: 'ArrowLeft', shiftKey: true});
    down({key: 'ArrowLeft', code: 'ArrowLeft', altKey: true});
    expect(ids()).toEqual(['cue.nudgeBack']);
  });

  it('an ancestor declaration covers its descendants', () => {
    const host = el('<div role="radiogroup" data-consume-keys="ArrowLeft ArrowRight"><button id="b" role="radio">x</button></div>');
    host.querySelector('#b').focus();
    down({key: 'ArrowLeft', code: 'ArrowLeft'});
    expect(ran).toEqual([]);
  });
});

describe('rule 6: focus scopes', () => {
  beforeEach(() => {
    cmd('transport.again', ['Enter'], ['stage', 'edit.chart']);
    cmd('transport.loopToggle', ['KeyL'], ['stage'], {group: 'Loop'});
    cmd('focus.play', ['Enter'], ['stage.strip', 'stage.bars']);
    cmd('focus.loop', ['KeyL'], ['stage.strip', 'stage.bars'], {group: 'Loop', when: c => !!c.focused});
  });

  const strip = () => el('<nav aria-label="Sections" data-scope="stage.strip" data-consume-keys="ArrowLeft ArrowRight Home End">' +
    '<button id="seg">Chorus</button></nav>').querySelector('#seg');

  it('Enter on a focused button inside a focus scope that binds Enter plays from it', () => {
    strip().focus();
    const e = down(ENTER);
    expect(ids()).toEqual(['focus.play']);
    expect(e.defaultPrevented).toBe(true);
  });

  it('a def whose when fails falls through to the outer scopes', () => {
    strip().focus();
    down({key: 'l', code: 'KeyL'});
    expect(ids()).toEqual(['transport.loopToggle']);
    r.provide('focused', {kind: 'section', t0: 0, t1: 10, label: 'Chorus'});
    down({key: 'l', code: 'KeyL'});
    expect(ids()).toEqual(['transport.loopToggle', 'focus.loop']);
  });

  it('the innermost scope wins', () => {
    cmd('inner.enter', ['Enter'], ['inner.scope']);
    el('<div data-scope="stage.bars"><div data-scope="inner.scope"><span id="x" tabindex="0"></span></div></div>')
      .querySelector('#x').focus();
    down(ENTER);
    expect(ids()).toEqual(['inner.enter']);
  });

  describe('a stop scope (edit.chart.score, D18)', () => {
    let score;
    beforeEach(() => {
      setPlace('edit', 'edit');
      r.provide('route', {name: 'edit', params: {tab: 'chart'}});
      cmd('transport.playStop', ['Space'], ['stage', 'edit']);
      cmd('click.countIn', ['KeyC'], ['stage', 'edit'], {group: 'Click'});
      cmd('edit.done', ['Escape'], ['edit'], {group: 'Edit'});
      cmd('chart.loopSelection', ['KeyL'], ['edit.chart'], {group: 'Chart'});
      cmd('chart.pageNext', ['PageDown'], ['edit.chart'], {group: 'Chart'});
      cmd('app.palette', ['Mod+KeyK'], ['global'], {group: 'App'});
      cmd('app.shortcuts', ['?'], ['global'], {group: 'App'});
      cmd('edit.open', ['KeyE'], ['edit'], {group: 'Edit'});
      cmd('chart.piece.snare', ['KeyS'], ['edit.chart.score'], {group: 'Chart'});
      cmd('chart.clear', ['Escape'], ['edit.chart.score'], {group: 'Chart', when: c => !!c.chart?.selection});
      score = el('<div data-scope="edit.chart.score" tabindex="0" id="score"></div>').querySelector('#score');
      score.focus();
    });

    it('blocks every key outside its pass-through list', () => {
      const c = down({key: 'c', code: 'KeyC'});
      const l = down({key: 'l', code: 'KeyL'});
      expect(ran).toEqual([]);
      expect(c.defaultPrevented || l.defaultPrevented).toBe(false);
    });

    it('its own bindings run', () => {
      down({key: 's', code: 'KeyS'});
      expect(ids()).toEqual(['chart.piece.snare']);
    });

    it('pass-through keys reach the outer scopes', () => {
      down(SPACE);
      down({key: 'PageDown', code: 'PageDown'});
      down({key: 'k', code: 'KeyK', ctrlKey: true});
      down({key: '?', code: 'Slash', shiftKey: true});
      down(ENTER);
      down({key: 'e', code: 'KeyE'});
      expect(ids()).toEqual(['transport.playStop', 'chart.pageNext', 'app.palette', 'app.shortcuts', 'transport.again', 'edit.open']);
    });

    it('Esc clears the selection first, then passes through to Done', () => {
      const off = r.provide('chart', {selection: {}});
      down(ESC);
      off();
      down(ESC);
      expect(ids()).toEqual(['chart.clear', 'edit.done']);
    });

    it('a drum letter on E wins inside the surface', () => {
      cmd('chart.piece.crash2', ['KeyE'], ['edit.chart.score'], {group: 'Chart'});
      down({key: 'e', code: 'KeyE'});
      expect(ids()).toEqual(['chart.piece.crash2']);
    });
  });
});

describe('rule 7: Enter and Space on focused controls (D35)', () => {
  beforeEach(() => {
    cmd('transport.again', ['Enter'], ['stage']);
    cmd('transport.playStop', ['Space'], ['stage', 'edit']);
    cmd('library.openFocused', ['Enter'], ['library'], {group: 'Library'});
    cmd('app.test', ['Space'], ['library'], {group: 'App'});
  });

  for (const html of ['<button id="x">b</button>', '<a id="x" href="#a">a</a>', '<div id="x" role="menuitem" tabindex="0"></div>',
    '<div id="x" role="tab" tabindex="0"></div>', '<div id="x" role="option" tabindex="0"></div>',
    '<div id="x" role="switch" tabindex="0"></div>', '<details><summary id="x">s</summary></details>']) {
    it(`Enter on ${html.match(/<(\w+)/)[1]} ${html.match(/role="(\w+)"/)?.[1] ?? ''} is native`, () => {
      el(html).querySelector('#x').focus();
      const e = down(ENTER);
      expect(ran).toEqual([]);
      expect(e.defaultPrevented).toBe(false);
    });
  }

  it('Enter on a button a pointer click focused goes to the registry (Again, not the clicked button)', () => {
    const b = el('<button id="b">Loop</button>').querySelector('#b');
    b.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}));
    b.focus();
    const e = down(ENTER);
    expect(ids()).toEqual(['transport.again']);
    expect(e.defaultPrevented).toBe(true);
    down(ENTER);                                             // still pointer-focused: keys do not change how it got focus
    expect(ids()).toEqual(['transport.again', 'transport.again']);
  });

  it('a pointer-focused button becomes keyboard-focused when focus returns to it by keyboard', () => {
    const host = el('<button id="a">A</button><button id="b">B</button>');
    const [a, b] = host.querySelectorAll('button');
    a.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
    a.focus();
    down({key: 'Tab', code: 'Tab'});                         // Tab moves focus; code runs focus() as the browser would
    b.focus();
    expect(down(ENTER).defaultPrevented).toBe(false);
    down({key: 'Tab', code: 'Tab', shiftKey: true});
    a.focus();
    expect(down(ENTER).defaultPrevented).toBe(false);
    expect(ran).toEqual([]);
  });

  it('Library: Enter on a clicked card button opens the focused song through the registry', () => {
    setPlace('library', null);
    const b = el('<button id="b">Song</button>').querySelector('#b');
    b.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
    b.focus();
    down(ENTER);
    expect(ids()).toEqual(['library.openFocused']);
  });

  it('Enter elsewhere in the Stage is Again', () => {
    down(ENTER);
    expect(ids()).toEqual(['transport.again']);
  });

  it('Space on a focused button goes to the registry in the Stage and Edit, and its keyup is prevented', () => {
    el('<button id="b">Loop</button>').querySelector('#b').focus();
    const d = down(SPACE);
    const u = up(SPACE);
    expect(ids()).toEqual(['transport.playStop']);
    expect(d.defaultPrevented).toBe(true);
    expect(u.defaultPrevented).toBe(true);
    setPlace('edit', 'edit');
    down(SPACE);
    expect(ids()).toEqual(['transport.playStop', 'transport.playStop']);
  });

  it('Space on a focused button is native outside the Stage and Edit', () => {
    setPlace('library', null);
    el('<button id="b">Open</button>').querySelector('#b').focus();
    const d = down(SPACE);
    expect(ran).toEqual([]);
    expect(d.defaultPrevented).toBe(false);
    expect(up(SPACE).defaultPrevented).toBe(false);
  });
});

describe('rule 9: the scope chain', () => {
  beforeEach(() => {
    cmd('view.focus', ['KeyF'], ['stage'], {group: 'View'});
    cmd('stems.follow', ['KeyF'], ['stage.stems'], {group: 'View'});
    cmd('view.bigger', ['='], ['stage'], {group: 'View', repeat: true});
    cmd('app.shortcuts', ['?'], ['global'], {group: 'App'});
    cmd('library.add', ['KeyN'], ['library'], {group: 'Library'});
    cmd('map.digit.1', ['Digit1'], ['edit.map'], {group: 'Map'});
    cmd('mix.mute.1', ['Digit1'], ['stage'], {group: 'Mix'});
    cmd('edit.done', ['Escape'], ['edit'], {group: 'Edit'});
    cmd('app.escape', ['Escape'], ['global'], {group: 'App'});
  });

  it('the surface scope comes before the posture (D24)', () => {
    down({key: 'f', code: 'KeyF'});
    setSurfaceScope('stage.stems');
    down({key: 'f', code: 'KeyF'});
    setSurfaceScope(null);
    down({key: 'f', code: 'KeyF'});
    expect(ids()).toEqual(['view.focus', 'stems.follow', 'view.focus']);
  });

  it('Edit postures: the tab scope, then edit, then global', () => {
    setPlace('edit', 'edit');
    r.provide('route', {name: 'edit', params: {tab: 'map'}});
    down({key: '1', code: 'Digit1'});
    down(ESC);
    expect(ids()).toEqual(['map.digit.1', 'edit.done']);
    expect(activeScopeChain()).toEqual(['edit.map', 'edit', 'global']);
  });

  it('the bulk Details route maps to edit.details', () => {
    setPlace('edit', 'edit');
    r.provide('route', {name: 'bulkDetails', params: {}});
    expect(activeScopeChain()).toEqual(['edit.details', 'edit', 'global']);
  });

  it('place scopes and global', () => {
    setPlace('library', null);
    down({key: 'n', code: 'KeyN'});
    down({key: '?', code: 'Slash', shiftKey: true});
    down({key: 'f', code: 'KeyF'});
    down(ESC);
    expect(ids()).toEqual(['library.add', 'app.shortcuts', 'app.escape']);
    expect(activeScopeChain()).toEqual(['library', 'global']);
    setPlace('settings', null);
    expect(activeScopeChain()).toEqual(['settings', 'global']);
  });

  it('activeScopeChain lists focus scopes first', () => {
    el('<nav data-scope="stage.strip"><button id="b">x</button></nav>').querySelector('#b').focus();
    setSurfaceScope('stage.stems');
    expect(activeScopeChain()).toEqual(['stage.strip', 'stage.stems', 'stage', 'global']);
  });

  it('auto-repeat re-runs only repeat commands, but is always prevented', () => {
    const f = down({key: 'f', code: 'KeyF', repeat: true});
    down({key: '=', code: 'Equal', repeat: true});
    down({key: '=', code: 'Equal', repeat: true});
    expect(ids()).toEqual(['view.bigger', 'view.bigger']);
    expect(f.defaultPrevented).toBe(true);
  });

  it('runs with source key and the event', () => {
    const e = down({key: 'f', code: 'KeyF'});
    expect(ran[0]).toMatchObject({id: 'view.focus', source: 'key'});
    expect(ran[0].event).toBe(e);
  });

  it('unbound keys stay native', () => {
    const e = down({key: 'x', code: 'KeyX'});
    expect(e.defaultPrevented).toBe(false);
    expect(up({key: 'x', code: 'KeyX'}).defaultPrevented).toBe(false);
  });
});

describe('layouts', () => {
  it('AZERTY ? (Shift on the US M key) opens the shortcut sheet even where Shift+KeyM is bound', () => {
    cmd('mix.onlyMe', ['Shift+KeyM'], ['stage', 'edit.map'], {group: 'Mix'});
    cmd('app.shortcuts', ['?'], ['global'], {group: 'App'});
    down({key: '?', code: 'KeyM', shiftKey: true});
    down({key: 'M', code: 'KeyM', shiftKey: true});          // US Shift+M is still Only me
    expect(ids()).toEqual(['app.shortcuts', 'mix.onlyMe']);
  });

  it('German / (Shift+7) searches in the Library and still solos stem 7 in the Stage', () => {
    cmd('library.search', ['/'], ['library'], {group: 'Library'});
    cmd('mix.solo.7', ['Shift+Digit7'], ['stage'], {group: 'Mix'});
    down({key: '/', code: 'Digit7', shiftKey: true});
    setPlace('library', null);
    down({key: '/', code: 'Digit7', shiftKey: true});
    expect(ids()).toEqual(['mix.solo.7', 'library.search']);
  });

  it('US + (Shift+=) makes the Stage bigger; numpad digits mute stems', () => {
    cmd('view.bigger', ['='], ['stage'], {group: 'View'});
    cmd('mix.mute.3', ['Digit3'], ['stage'], {group: 'Mix'});
    down({key: '+', code: 'Equal', shiftKey: true});
    down({key: '3', code: 'Numpad3'});
    expect(ids()).toEqual(['view.bigger', 'mix.mute.3']);
  });
});

describe('rule 10: reservations', () => {
  it('reserved browser keys cannot be bound, so they always stay native', () => {
    expect(() => cmd('library.addMod', ['Mod+KeyN'], ['library'], {group: 'Library'})).toThrow(/reserved/);
    expect(() => cmd('library.addCtrl', ['Ctrl+KeyN'], ['library'], {group: 'Library'})).toThrow(/reserved/);
    expect(() => cmd('app.closeCtrl', ['Ctrl+KeyW'], ['stage'], {group: 'App'})).toThrow(/reserved/);
    const e = down({key: 'n', code: 'KeyN', ctrlKey: true});
    expect(e.defaultPrevented).toBe(false);
    expect(ran).toEqual([]);
  });
});

describe('keyup', () => {
  it('prevents only the keyup matching a prevented keydown, once', () => {
    cmd('transport.playStop', ['Space'], ['stage']);
    down(SPACE);
    expect(up(SPACE).defaultPrevented).toBe(true);
    expect(up(SPACE).defaultPrevented).toBe(false);
  });

  it('a window blur forgets pending keyups', () => {
    cmd('transport.playStop', ['Space'], ['stage']);
    down(SPACE);
    window.dispatchEvent(new Event('blur'));
    expect(up(SPACE).defaultPrevented).toBe(false);
  });
});

describe('lifecycle', () => {
  it('stop removes the listeners', () => {
    cmd('transport.playStop', ['Space'], ['stage']);
    stop();
    down(SPACE);
    expect(ran).toEqual([]);
    stop = startDispatcher({registry: r, platform: 'win'});
    down(SPACE);
    expect(ids()).toEqual(['transport.playStop']);
  });

  it('starting again replaces the previous listeners', () => {
    cmd('transport.playStop', ['Space'], ['stage']);
    const again = startDispatcher({registry: r, platform: 'win'});
    down(SPACE);
    expect(ids()).toEqual(['transport.playStop']);
    stop();                                                         // the old stop no longer owns the dispatcher
    down(SPACE);
    expect(ids()).toEqual(['transport.playStop', 'transport.playStop']);
    again();
    stop = () => {};
  });

  it('Mod is ⌘ on macOS', () => {
    stop();
    stop = startDispatcher({registry: r, platform: 'mac'});
    cmd('app.palette', ['Mod+KeyK'], ['global'], {group: 'App'});
    down({key: 'k', code: 'KeyK', ctrlKey: true});
    down({key: 'k', code: 'KeyK', metaKey: true});
    expect(ids()).toEqual(['app.palette']);
  });
});
