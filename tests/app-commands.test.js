// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as commands from '../src/app/commands.js';
import {BOOT_SCOPES, createRegistry, GROUPS} from '../src/app/commands.js';

const def = (over = {}) => ({id: 'transport.again', title: 'Start again', group: 'Transport', run: () => {}, ...over});

let r;
beforeEach(() => { r = createRegistry(); });
afterEach(() => {
  vi.useRealTimers();
  delete document.documentElement.dataset.place;
  delete document.documentElement.dataset.posture;
});

describe('register', () => {
  it('stores frozen, canonical definitions in order', () => {
    r.register(def({keys: ['Enter'], scopes: ['stage', 'edit.chart']}));
    r.register(def({id: 'transport.pause', title: 'Pause / continue', keys: ['Shift+Space'], scopes: ['stage']}));
    expect(r.all().map(d => d.id)).toEqual(['transport.again', 'transport.pause']);
    const d = r.get('transport.again');
    expect(Object.isFrozen(d)).toBe(true);
    expect(d).toMatchObject({keys: ['Enter'], scopes: ['stage', 'edit.chart'], repeat: false, pedal: false, global: false});
    expect(r.get('nope')).toBe(null);
  });

  it('canonicalises keys', () => {
    r.register(def({id: 'practice.redo', group: 'Practice', keys: ['Shift+Mod+KeyZ', 'Meta+KeyY'], scopes: ['stage']}));
    expect(r.get('practice.redo').keys).toEqual(['Mod+Shift+KeyZ', 'Mod+KeyY']);
    expect(r.bindingsFor('stage').get('Mod+Shift+KeyZ').id).toBe('practice.redo');
  });

  it('validates every field', () => {
    const bad = [
      [def({id: 'Transport.again'}), /id/],
      [def({id: 'transport'}), /id/],
      [def({id: 'transport.'}), /id/],
      [def({title: ''}), /title/],
      [def({title: undefined}), /title/],
      [def({group: 'Stuff'}), /group/],
      [def({group: undefined}), /group/],
      [def({run: undefined}), /run/],
      [def({when: true}), /when/],
      [def({keys: 'Enter', scopes: ['stage']}), /keys/],
      [def({keys: ['Return'], scopes: ['stage']}), /Invalid key/],
      [def({keys: ['Enter', 'Enter'], scopes: ['stage']}), /same key/],
      [def({keys: ['Enter']}), /no scopes/],
      [def({scopes: ['']}), /scopes/],
      [def({menu: {electron: 'Window'}}), /menu.electron/],
      [def({classicKeys: []}), /unknown field "classicKeys"/],
    ];
    for (const [d, msg] of bad) expect(() => r.register(d), JSON.stringify(Object.keys(d))).toThrow(msg);
    expect(r.all()).toEqual([]);
  });

  it('accepts a title function', () => {
    r.register(def({id: 'mix.minusMe', group: 'Mix', title: c => (c.session ? 'Minus bass' : 'Minus me')}));
    expect(r.titleFor('mix.minusMe')).toBe('Minus me');
    r.provide('session', () => ({}));
    expect(r.titleFor('mix.minusMe')).toBe('Minus bass');
  });

  it('rejects reserved browser keys (rule 10)', () => {
    for (const k of ['Mod+KeyN', 'Mod+KeyW', 'Mod+KeyT', 'Mod+,', 'Mod+Digit1', 'Mod+Digit9', 'Mod+=', 'Mod+-', 'Mod+Digit0']) {
      expect(() => r.register(def({id: 'app.x', group: 'App', keys: [k], scopes: ['global']})), k).toThrow(/reserved/);
    }
  });

  it('refuses duplicate ids; unregister frees them', () => {
    const off = r.register(def());
    expect(() => r.register(def())).toThrow(/already registered/);
    off();
    expect(r.get('transport.again')).toBe(null);
    expect(r.unregister('transport.again')).toBe(false);
    r.register(def());
    expect(r.unregister('transport.again')).toBe(true);
  });

  it('registerMany is all or nothing', () => {
    expect(() => r.registerMany([def(), def({id: 'transport.stop', title: 'Stop'}), def({id: 'bad'})])).toThrow(/id/);
    expect(r.all()).toEqual([]);
    const off = r.registerMany([def({keys: ['Enter'], scopes: ['stage']}), def({id: 'transport.stop', title: 'Stop'})]);
    expect(r.all()).toHaveLength(2);
    off();
    expect(r.all()).toHaveLength(0);
    expect(r.bindingsFor('stage').size).toBe(0);
  });

  it('exports the groups of spec §7.1', () => {
    expect(GROUPS).toEqual(['Transport', 'Loop', 'Speed', 'Click', 'Mix', 'Navigate', 'View', 'Practice', 'Edit', 'Map', 'Chart',
      'Library', 'App']);
  });
});

describe('bindings', () => {
  it('indexes keys per scope', () => {
    r.register(def({keys: ['Enter'], scopes: ['stage', 'edit.chart']}));
    r.register(def({id: 'focus.play', title: 'Play from here', keys: ['Enter'], scopes: ['stage.strip']}));
    expect([...r.bindingsFor('stage').keys()]).toEqual(['Enter']);
    expect(r.bindingsFor('edit.chart').get('Enter').id).toBe('transport.again');
    expect(r.bindingsFor('stage.strip').get('Enter').id).toBe('focus.play');
    expect(r.bindingsFor('library').size).toBe(0);
    expect(r.defsFor('stage', 'Enter').map(d => d.id)).toEqual(['transport.again']);
    expect(r.boundScopes().sort()).toEqual(['edit.chart', 'stage', 'stage.strip']);
  });

  it('keeps every def for a key in a scope, first one in bindingsFor', () => {
    r.register(def({id: 'a.one', keys: ['KeyX'], scopes: ['stage']}));
    r.register(def({id: 'a.two', keys: ['KeyX'], scopes: ['stage']}));
    expect(r.bindingsFor('stage').get('KeyX').id).toBe('a.one');
    expect(r.defsFor('stage', 'KeyX').map(d => d.id)).toEqual(['a.one', 'a.two']);
    r.unregister('a.one');
    expect(r.bindingsFor('stage').get('KeyX').id).toBe('a.two');
  });
});

describe('run, when, disabledReason, checked', () => {
  it('runs with the context and args; returns false when unknown or disabled', () => {
    const run = vi.fn();
    r.register(def({run, when: c => !!c.transport}));
    expect(r.run('nope')).toBe(false);
    expect(r.run('transport.again')).toBe(false);
    expect(run).not.toHaveBeenCalled();
    const transport = {again: vi.fn()};
    r.provide('transport', () => transport);
    expect(r.run('transport.again', {args: {n: 2}, source: 'menu'})).toBe(true);
    const [ctx, args] = run.mock.calls[0];
    expect(args).toEqual({n: 2});
    expect(ctx.transport).toBe(transport);
    expect(ctx.source).toBe('menu');
    expect(ctx.args).toEqual({n: 2});
    expect(ctx.event).toBe(null);
  });

  it('defaults the source to pointer', () => {
    const run = vi.fn();
    r.register(def({run}));
    r.run('transport.again');
    expect(run.mock.calls[0][0].source).toBe('pointer');
  });

  it('disabledReason disables with a visible reason', () => {
    const run = vi.fn();
    r.register(def({id: 'song.resplit', title: 'Re-split…', group: 'Library', run,
      disabledReason: c => (c.platform?.isDesktopApp ? null : 'Re-split from Woodshed for desktop.')}));
    expect(r.state('song.resplit')).toMatchObject({visible: true, enabled: false, reason: 'Re-split from Woodshed for desktop.'});
    expect(r.isEnabled('song.resplit')).toBe(false);
    expect(r.disabledReasonFor('song.resplit')).toBe('Re-split from Woodshed for desktop.');
    expect(r.run('song.resplit')).toBe(false);
    const off = r.provide('platform', {isDesktopApp: true});
    expect(r.isEnabled('song.resplit')).toBe(true);
    expect(r.disabledReasonFor('song.resplit')).toBe(null);
    expect(r.run('song.resplit')).toBe(true);
    off();
    expect(r.isEnabled('song.resplit')).toBe(false);
  });

  it('when false hides and disables; a throwing predicate counts as false', () => {
    r.register(def({when: c => c.session.ready}));
    expect(r.state('transport.again')).toMatchObject({visible: false, enabled: false, reason: null});
    expect(r.passes(r.get('transport.again'), r.context())).toBe(false);
    r.provide('session', {ready: true});
    expect(r.state('transport.again')).toMatchObject({visible: true, enabled: true});
  });

  it('isChecked reflects checked(), undefined when not a toggle', () => {
    let on = false;
    r.register(def({id: 'click.countIn', title: 'Count-in', group: 'Click', checked: () => on}));
    r.register(def());
    expect(r.isChecked('click.countIn')).toBe(false);
    on = true;
    expect(r.isChecked('click.countIn')).toBe(true);
    expect(r.isChecked('transport.again')).toBe(undefined);
    expect(r.isChecked('nope')).toBe(undefined);
  });

  it('lets errors from run propagate', () => {
    r.register(def({run: () => { throw new Error('boom'); }}));
    expect(() => r.run('transport.again')).toThrow('boom');
  });
});

describe('context and providers', () => {
  it('reads providers lazily and falls back to the root attributes', () => {
    const getter = vi.fn(() => ({id: 's1'}));
    r.provide('session', getter);
    const ctx = r.context({source: 'key'});
    expect(getter).not.toHaveBeenCalled();
    expect(ctx.session).toEqual({id: 's1'});
    expect(ctx.session).toEqual({id: 's1'});
    expect(getter).toHaveBeenCalledTimes(1);
    expect(ctx.source).toBe('key');
    expect(ctx.place).toBe(null);
    document.documentElement.dataset.place = 'stage';
    document.documentElement.dataset.posture = 'stage';
    const c2 = r.context();
    expect(c2.place).toBe('stage');
    expect(c2.posture).toBe('stage');
  });

  it('exposes every contract name, plus custom providers', () => {
    r.provide('jobs', () => 'jobs!');
    const ctx = r.context();
    for (const name of ['place', 'posture', 'route', 'session', 'transport', 'stage', 'edit', 'map', 'chart', 'library', 'focused',
      'store', 'router', 'feedback', 'platform', 'source', 'event', 'args']) expect(name in ctx, name).toBe(true);
    expect(ctx.jobs).toBe('jobs!');
  });

  it('derives the route from the router when no route provider exists', () => {
    const match = {name: 'edit', params: {tab: 'map'}};
    r.provide('router', {current: {value: match}});
    expect(r.context().route).toBe(match);
  });

  it('stacks providers; off restores the previous one', () => {
    const offA = r.provide('stage', 'A');
    const offB = r.provide('stage', 'B');
    expect(r.context().stage).toBe('B');
    offB();
    expect(r.context().stage).toBe('A');
    offA();
    expect(r.context().stage).toBe(null);
  });

  it('extra values override providers', () => {
    r.provide('focused', {kind: 'bar'});
    expect(r.context({focused: {kind: 'section'}}).focused).toEqual({kind: 'section'});
  });
});

describe('scopes', () => {
  it('defines the boot scopes', () => {
    expect(r.getScope('stage.strip')).toMatchObject({stop: false, passThrough: []});
    expect(r.getScope('stage.bars')).toMatchObject({stop: false});
    expect(r.getScope('edit.chart.score')).toMatchObject({
      stop: true, passThrough: ['Space', 'Shift+Space', 'Enter', 'Escape', 'PageUp', 'PageDown', 'Mod+KeyK', '?', 'KeyE'],
    });
    expect(BOOT_SCOPES.map(([n]) => n)).toEqual(['stage.strip', 'stage.bars', 'edit.chart.score']);
    expect(r.getScope('nope')).toBe(null);
  });

  it('defineScope canonicalises pass-through keys and validates them', () => {
    expect(r.defineScope('x.y', {stop: true, passThrough: ['Shift+Mod+KeyK']}).passThrough).toEqual(['Mod+Shift+KeyK']);
    expect(() => r.defineScope('x.z', {passThrough: ['Nope']})).toThrow();
    expect(() => r.defineScope('')).toThrow();
  });
});

describe('registerDynamic', () => {
  it('declares a family by id template', () => {
    const off = r.registerDynamic('mix.mute.{n}', [1, 2, 3]);
    expect(r.dynamicFamilies()).toEqual([{template: 'mix.mute.{n}', ids: ['mix.mute.1', 'mix.mute.2', 'mix.mute.3']}]);
    off();
    expect(r.dynamicFamilies()).toEqual([]);
  });

  it('registers expanded definitions from a definition template', () => {
    const run = vi.fn();
    const off = r.registerDynamic({id: 'mix.mute.{n}', title: (c, n) => `Mute stem ${n}`, group: 'Mix', keys: ['Digit{n}'],
      scopes: ['stage'], when: (c, n) => n !== 3, run}, [1, 2, 3]);
    expect(r.all().map(d => d.id)).toEqual(['mix.mute.1', 'mix.mute.2', 'mix.mute.3']);
    expect(r.bindingsFor('stage').get('Digit2').id).toBe('mix.mute.2');
    expect(r.titleFor('mix.mute.2')).toBe('Mute stem 2');
    expect(r.isEnabled('mix.mute.3')).toBe(false);
    r.run('mix.mute.2', {args: {x: 1}});
    expect(run.mock.calls[0][1]).toEqual({x: 1, n: 2});
    off();
    expect(r.all()).toEqual([]);
    expect(r.dynamicFamilies()).toEqual([]);
  });

  it('substitutes string titles and kit ids', () => {
    r.registerDynamic({id: 'chart.piece.{n}', title: 'Write {n}', group: 'Chart', run: () => {}}, ['snare', 'kick']);
    expect(r.get('chart.piece.kick').title).toBe('Write kick');
  });

  it('validates the template', () => {
    expect(() => r.registerDynamic('mix.mute', [1])).toThrow(/\{n\}/);
    expect(() => r.registerDynamic('mix.mute.{n}', [])).toThrow(/non-empty/);
  });
});

describe('onChange and invalidate', () => {
  it('notifies registry changes at once', () => {
    const fn = vi.fn();
    const off = r.onChange(fn);
    r.register(def());
    r.registerMany([def({id: 'transport.stop', title: 'Stop'}), def({id: 'transport.pause', title: 'Pause'})]);
    r.unregister('transport.stop');
    expect(fn.mock.calls.map(c => c[0])).toEqual([
      {type: 'registry', ids: ['transport.again']},
      {type: 'registry', ids: ['transport.stop', 'transport.pause']},
      {type: 'registry', ids: ['transport.stop']},
    ]);
    off();
    r.register(def({id: 'transport.x', title: 'X'}));
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('debounces state re-evaluation by 50 ms and reports only changed ids', () => {
    vi.useFakeTimers();
    let playing = false;
    r.register(def({id: 'transport.pause', title: 'Pause', when: () => playing}));
    r.register(def({id: 'transport.stop', title: 'Stop'}));
    const fn = vi.fn();
    r.onChange(fn);
    r.invalidate();
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenLastCalledWith({type: 'state', ids: ['transport.pause', 'transport.stop']});   // first snapshot
    fn.mockClear();
    playing = true;
    r.invalidate();
    r.invalidate();
    vi.advanceTimersByTime(49);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({type: 'state', ids: ['transport.pause']});
    fn.mockClear();
    r.invalidate();
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();                                            // nothing changed
  });

  it('re-evaluates after a run', () => {
    vi.useFakeTimers();
    let on = false;
    r.register(def({id: 'click.countIn', title: 'Count-in', group: 'Click', checked: () => on, run: () => { on = !on; }}));
    r.invalidate();
    vi.advanceTimersByTime(50);
    const fn = vi.fn();
    r.onChange(fn);
    r.run('click.countIn');
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledWith({type: 'state', ids: ['click.countIn']});
  });

  it('isolates a throwing listener', async () => {
    const good = vi.fn();
    r.onChange(() => { throw new Error('listener'); });
    r.onChange(good);
    const thrown = new Promise(resolve => {
      const prev = globalThis.queueMicrotask;
      globalThis.queueMicrotask = fn => { globalThis.queueMicrotask = prev; try { fn(); } catch (err) { resolve(err); } };
    });
    r.register(def());
    expect(good).toHaveBeenCalled();
    await expect(thrown).resolves.toMatchObject({message: 'listener'});
  });
});

describe('the app-wide registry', () => {
  it('module functions share one registry with the boot scopes', () => {
    expect(commands.getScope('edit.chart.score').stop).toBe(true);
    const off = commands.register(def({id: 'test.appWide', title: 'App-wide', group: 'App', keys: ['KeyQ'], scopes: ['global']}));
    expect(commands.registry.get('test.appWide')).toBe(commands.get('test.appWide'));
    expect(commands.bindingsFor('global').get('KeyQ').id).toBe('test.appWide');
    off();
    expect(commands.get('test.appWide')).toBe(null);
  });
});
