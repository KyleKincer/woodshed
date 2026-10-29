// @vitest-environment happy-dom
// Library selection mode (architecture §2.16, spec §2.6, §7.7, §7.8): the Selection model (toggle, Shift ranges, ⌘A,
// the 100 cap worded "Up to 100 at a time", Esc), card clicks, the 'library' command context with LB1a's library
// commands, bulk delete (the Dialog copy, sequential songs.remove, the partial-failure report), pins with the 8 s Undo
// toast, and the floating bar (its controls table, Edit details → /edit/details?ids=, Re-split on desktop only).
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {installPopoverShim, restoreDomShims, tap} from './helpers/dom.js';

const peers = vi.hoisted(() => ({resplit: null}));
vi.mock('../src/library/resplit-dialog.js', async importOriginal => {
  peers.resplit = vi.fn(async () => {});
  return {...await importOriginal(), openResplitDialog: peers.resplit, openResplit: vi.fn()};
});

const {createSelection, sharedSelection, selectionClick, selectionContext, deleteSongs, setPinned, mountSelectionBar, MAX_SELECTION, UNDO_MS}
  = await import('../src/library/selection.js');
const {COPY, CONTROLS} = await import('../src/library/library-actions.copy.js');
const {createRegistry} = await import('../src/app/commands.js');
const {defineLibraryCommands} = await import('../src/library/commands.js');
const {signal} = await import('../src/app/store.js');
const {MAX_PINS} = await import('../convex/lib/presets.ts');

function nameOf(el) {
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) return labelledby.split(/\s+/).map(id => el.ownerDocument.getElementById(id)?.textContent ?? '').join(' ').trim();
  const label = el.getAttribute('aria-label');
  if (label) return label.trim();
  return el.textContent.replace(/\s+/g, ' ').trim();
}
const ROLE = {button: 'button, [role=button]', toolbar: '[role=toolbar]', dialog: 'dialog, [role=dialog]'};
const byRole = (root, role, name) => [...root.querySelectorAll(ROLE[role])].find(el => nameOf(el) === name) ?? null;
const ids = n => Array.from({length: n}, (_, i) => `s${i + 1}`);
const song = (id, extra = {}) => ({id, title: `Song ${id}`, duration: 120, ...extra});

function fakeStore(list = [song('a'), song('b'), song('c')]) {
  return {
    library: {songs: signal(new Map(list.map(s => [s.id, s]))), loaded: signal(true), setlists: signal([])},
    session: signal({status: 'active'}),
  };
}
function fakeAccount(pins = []) {
  const p = signal(pins);
  return {pins: p, value: signal({pins}), patch: vi.fn(async change => { if (change.pins) p.value = change.pins; return change; })};
}
const recorder = () => {
  const calls = [];
  const toast = vi.fn((message, options = {}) => { const handle = {message, options, dismiss: vi.fn(), update: vi.fn()}; calls.push(handle); return handle; });
  return {toast, calls};
};

beforeEach(() => { installPopoverShim(); document.body.replaceChildren(); });
afterEach(() => { restoreDomShims(); vi.useRealTimers(); for (const d of document.querySelectorAll('dialog')) d.remove(); });

// =====================================================================================================
describe('createSelection', () => {
  it('starts off; a toggle enters selection mode and the last toggle off keeps it on until clear()', () => {
    const s = createSelection();
    expect(s.active.peek()).toBe(false);
    expect(s.toggle('a')).toBe(true);
    expect(s.active.peek()).toBe(true);
    expect([...s.ids.peek()]).toEqual(['a']);
    s.toggle('a');
    expect(s.count.peek()).toBe(0);
    expect(s.active.peek()).toBe(true);
    s.clear();
    expect(s.active.peek()).toBe(false);
  });

  it('start() enters selection mode with nothing selected (Sort ▾ → Select), start(id) with that card (D49)', () => {
    const s = createSelection();
    s.start();
    expect(s.active.peek()).toBe(true);
    expect(s.count.peek()).toBe(0);
    s.start('b');
    expect(s.has('b')).toBe(true);
    s.start('b');
    expect(s.count.peek()).toBe(1);   // start never deselects
  });

  it('Shift ranges run from the last toggled card over the visible order, both directions', () => {
    const order = ['a', 'b', 'c', 'd', 'e'];
    const s = createSelection({order: () => order});
    s.toggle('b');
    s.range('d');
    expect(s.list()).toEqual(['b', 'c', 'd']);
    s.toggle('e');
    s.range('a');
    expect(s.list()).toEqual(order);
    const fresh = createSelection({order: () => order});
    fresh.range('c');            // no anchor yet: a plain toggle
    expect(fresh.list()).toEqual(['c']);
  });

  it(`caps at ${MAX_SELECTION}: a toggle past it adds nothing, ⌘A and ranges take what fits, and \`limited\` says so`, () => {
    const all = ids(140);
    const s = createSelection({order: () => all});
    s.selectAll();
    expect(s.count.peek()).toBe(MAX_SELECTION);
    expect(s.limited.peek()).toBe(true);
    expect(s.list()).toEqual(all.slice(0, MAX_SELECTION));
    expect(s.toggle('s120')).toBe(false);
    expect(s.has('s120')).toBe(false);
    s.toggle('s1');
    expect(s.limited.peek()).toBe(false);
    expect(s.count.peek()).toBe(99);
    s.range('s130');              // from s1 to s130: only one more fits
    expect(s.count.peek()).toBe(100);
    expect(s.limited.peek()).toBe(true);
    expect(COPY.cap).toBe('Up to 100 at a time');
  });

  it('prune drops songs that no longer exist; list() keeps the visual order, then the hidden ones', () => {
    const order = ['c', 'b', 'a'];
    const s = createSelection({order: () => order});
    s.set(['a', 'x', 'c']);
    expect(s.list()).toEqual(['c', 'a', 'x']);
    s.prune(new Map([['a', 1], ['c', 1]]));
    expect(s.list()).toEqual(['c', 'a']);
  });

  it('sharedSelection is one object', () => {
    expect(sharedSelection()).toBe(sharedSelection());
  });
});

describe('selectionClick', () => {
  const click = (extra = {}) => new MouseEvent('click', {button: 0, ...extra});
  it('⌘/Ctrl-click toggles, Shift-click ranges, a plain click opens until selecting, then toggles', () => {
    const order = ['a', 'b', 'c'];
    const s = createSelection({order: () => order});
    expect(selectionClick(s, 'a', click())).toBe(false);
    expect(s.active.peek()).toBe(false);
    expect(selectionClick(s, 'a', click({metaKey: true}))).toBe(true);
    expect(selectionClick(s, 'c', click({shiftKey: true}))).toBe(true);
    expect(s.list()).toEqual(order);
    expect(selectionClick(s, 'b', click())).toBe(true);
    expect(s.list()).toEqual(['a', 'c']);
    expect(selectionClick(s, 'b', click({ctrlKey: true}))).toBe(true);
    expect(s.has('b')).toBe(true);
    expect(selectionClick(s, 'b', new MouseEvent('click', {button: 1}))).toBe(false);   // a middle click stays native
  });
});

describe('the library command context (library.select, .selectAll, .deleteSelected, app.escape)', () => {
  function setup(selection, extra = {}) {
    const registry = createRegistry();
    defineLibraryCommands({registry});
    const announce = vi.fn();
    const ctx = selectionContext(selection, {announce, ...extra});
    registry.provide('library', () => ctx);
    return {registry, ctx, announce};
  }

  it('Select is available (Sort ▾); selectAll and deleteSelected need selection mode; exitSelection ends it', () => {
    const order = ids(5);
    const s = createSelection({order: () => order});
    const deleteSelected = vi.fn();
    const {registry, ctx, announce} = setup(s, {deleteSelected});
    expect(registry.isEnabled('library.select')).toBe(true);
    expect(registry.isEnabled('library.selectAll')).toBe(false);
    expect(registry.run('library.select')).toBe(true);
    expect(s.active.peek()).toBe(true);
    expect(announce).toHaveBeenCalledWith(COPY.selectingOn, expect.anything());
    expect(registry.run('library.selectAll')).toBe(true);
    expect(s.list()).toEqual(order);
    expect(registry.run('library.deleteSelected')).toBe(true);
    expect(deleteSelected).toHaveBeenCalled();
    expect(ctx.selecting).toBe(true);
    expect(ctx.exitSelection()).toBe(true);
    expect(s.active.peek()).toBe(false);
    expect(ctx.exitSelection()).toBe(false);
  });

  it('⌘A (Mod+KeyA) and ⌫ are the library scope keys while selecting', () => {
    const {registry} = setup(createSelection());
    expect(registry.get('library.selectAll').keys).toContain('Mod+KeyA');
    expect(registry.get('library.deleteSelected').keys).toContain('Backspace');
  });
});

// =====================================================================================================
describe('deleteSongs', () => {
  const dialog = () => document.querySelector('dialog.ui-dialog');
  const actions = () => [...dialog().querySelectorAll('.ui-dialog-action')];

  it('the bulk Dialog uses the spec copy; Cancel deletes nothing', async () => {
    const api = {remove: vi.fn(async () => true)};
    const {toast} = recorder();
    const done = deleteSongs([song('a'), song('b'), song('c')], {api, toast, announce: vi.fn()});
    expect(dialog().querySelector('.ui-dialog-title').textContent).toBe('Delete 3 songs?');
    expect(dialog().querySelector('.ui-dialog-body').textContent)
      .toBe('Their stems and charts are removed from your library. Shared links stop working.');
    expect(actions().map(b => b.textContent)).toEqual(['Cancel', 'Delete 3 songs']);
    expect(actions()[1].dataset.variant).toBe('danger');
    expect(document.activeElement).toBe(actions()[0]);      // focus starts on the safe action
    tap(actions()[0]);
    expect(await done).toBeNull();
    expect(api.remove).not.toHaveBeenCalled();
  });

  it('removes one after another (never in parallel), then an ok toast', async () => {
    let inFlight = 0, most = 0;
    const order = [];
    const api = {remove: vi.fn(async ({id}) => { inFlight++; most = Math.max(most, inFlight); order.push(id); await Promise.resolve(); inFlight--; return true; })};
    const {toast, calls} = recorder();
    const done = deleteSongs([song('a'), song('b'), song('c')], {api, toast, announce: vi.fn()});
    tap(actions()[1]);
    const result = await done;
    expect(order).toEqual(['a', 'b', 'c']);
    expect(most).toBe(1);
    expect(result).toEqual({deleted: ['a', 'b', 'c'], failed: []});
    expect(calls[0].message).toBe('Deleting 1 of 3…');
    expect(calls[0].update).toHaveBeenCalledWith('Deleting 3 of 3…');
    expect(calls[0].dismiss).toHaveBeenCalled();
    expect(calls.at(-1).message).toBe('Deleted 3 songs');
    expect(calls.at(-1).options.tone).toBe('ok');
  });

  it('reports a partial failure: an error toast naming what stayed, with Details listing each reason', async () => {
    const api = {remove: vi.fn(async ({id}) => { if (id === 'b') throw Object.assign(new Error('boom'), {code: 'not_found'}); return true; })};
    const {toast, calls} = recorder();
    const done = deleteSongs([song('a'), song('b', {title: 'Harbor Lights'}), song('c')], {api, toast, announce: vi.fn()});
    tap(actions()[1]);
    const result = await done;
    expect(result.deleted).toEqual(['a', 'c']);
    expect(result.failed.map(f => f.id)).toEqual(['b']);
    const report = calls.at(-1);
    expect(report.options.tone).toBe('error');
    expect(report.message).toBe('Deleted 2 of 3 songs. 1 song couldn’t be deleted. Not deleted: Harbor Lights.');
    expect(report.options.action.label).toBe('Details');
    report.options.action.run();
    expect(dialog().querySelector('.lib-fail-list').textContent).toContain('Harbor Lights');
  });

  it('one song: its own title and copy', async () => {
    const api = {remove: vi.fn(async () => true)};
    const {toast, calls} = recorder();
    const done = deleteSongs([song('a', {title: 'Glasshouse'})], {api, toast, announce: vi.fn()});
    expect(dialog().querySelector('.ui-dialog-title').textContent).toBe('Delete “Glasshouse”?');
    expect(actions().map(b => b.textContent)).toEqual(['Cancel', 'Delete song']);
    tap(actions()[1]);
    await done;
    expect(calls.at(-1).message).toBe('Deleted “Glasshouse”');
  });
});

// =====================================================================================================
describe('setPinned (8 s Undo toast)', () => {
  it('pins, then Undo takes out exactly what was pinned (a pin added meanwhile stays)', async () => {
    const account = fakeAccount(['x']);
    const songs = fakeStore([song('a', {title: 'Glasshouse'}), song('b')]).library.songs;
    const {toast, calls} = recorder();
    expect(await setPinned(['a'], true, {account, toast, songs})).toBe(true);
    expect(account.pins.peek()).toEqual(['x', 'a']);
    expect(calls[0].message).toBe('Pinned “Glasshouse”');
    expect(calls[0].options.durationMs).toBe(UNDO_MS);
    expect(UNDO_MS).toBe(8000);
    account.pins.value = ['x', 'a', 'b'];
    await calls[0].options.action.run();
    expect(account.pins.peek()).toEqual(['x', 'b']);
  });

  it('unpins several; Undo puts each back at its old place', async () => {
    const account = fakeAccount(['a', 'b', 'c', 'd']);
    const {toast, calls} = recorder();
    await setPinned(['b', 'd'], false, {account, toast, songs: fakeStore().library.songs});
    expect(account.pins.peek()).toEqual(['a', 'c']);
    expect(calls[0].message).toBe('Unpinned 2 songs');
    await calls[0].options.action.run();
    expect(account.pins.peek()).toEqual(['a', 'b', 'c', 'd']);
  });

  it(`refuses past ${MAX_PINS} pins with the room left; nothing changes`, async () => {
    const account = fakeAccount(ids(MAX_PINS - 1));
    const {toast, calls} = recorder();
    expect(await setPinned(['p', 'q'], true, {account, toast, songs: fakeStore().library.songs})).toBe(false);
    expect(account.patch).not.toHaveBeenCalled();
    expect(calls[0].message).toBe(`Up to ${MAX_PINS} pins: there’s room for 1 more song`);
  });

  it('a failed save is an error toast, and no Undo is offered', async () => {
    const account = fakeAccount([]);
    account.patch.mockRejectedValueOnce(Object.assign(new Error('offline'), {code: 'unknown'}));
    const {toast, calls} = recorder();
    expect(await setPinned(['a'], true, {account, toast, songs: fakeStore().library.songs})).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].options.tone).toBe('error');
  });
});

// =====================================================================================================
describe('the floating bar', () => {
  function mountBar({desktop = true, pins = [], list, status} = {}) {
    const store = fakeStore(list);
    if (status) store.session.value = {status};
    const account = fakeAccount(pins);
    const router = {navigate: vi.fn()};
    const {toast, calls} = recorder();
    const announce = vi.fn();
    const api = {remove: vi.fn(async () => true)};
    const order = [...store.library.songs.peek().keys()];
    const selection = createSelection({order: () => order});
    const host = document.body.appendChild(document.createElement('div'));
    const bar = mountSelectionBar(host, selection, {store, account, router, toast, announce, api, desktop: {available: desktop}});
    return {store, account, router, calls, announce, api, selection, host, bar};
  }

  it('renders the controls table rows with their roles and names', () => {
    const {host, selection} = mountBar();
    selection.start('a');
    for (const row of CONTROLS.filter(r => r.where === 'bar')) {
      expect(byRole(host, row.role, row.name), `${row.role} "${row.name}"`).not.toBeNull();
    }
  });

  it('is hidden until selecting; shows "N selected" and the cap; announces the count', () => {
    const {bar, selection, announce} = mountBar();
    expect(bar.el.hidden).toBe(true);
    selection.start();
    expect(bar.el.hidden).toBe(false);
    expect(bar.el.querySelector('.lib-selbar-count').textContent).toBe('Select songs');
    expect(byRole(bar.el, 'button', 'Delete').getAttribute('aria-disabled')).toBe('true');
    selection.toggle('a');
    selection.toggle('b');
    expect(bar.el.querySelector('.lib-selbar-count').textContent).toBe('2 selected');
    expect(announce).toHaveBeenCalledWith('2 selected', expect.anything());
    expect(bar.el.querySelector('.lib-selbar-cap').hidden).toBe(true);
    selection.clear();
    expect(bar.el.hidden).toBe(true);
  });

  it('shows "Up to 100 at a time" when ⌘A hits the cap', () => {
    const list = ids(120).map(id => song(id));
    const {bar, selection} = mountBar({list});
    selection.selectAll();
    expect(bar.el.querySelector('.lib-selbar-count').textContent).toBe('100 selected');
    expect(bar.el.querySelector('.lib-selbar-cap').hidden).toBe(false);
    expect(bar.el.querySelector('.lib-selbar-cap').textContent).toBe('Up to 100 at a time');
  });

  it('Edit details opens /edit/details?ids=… in the visible order and keeps the selection to come back to (D34, §2.15)', () => {
    const {bar, selection, router} = mountBar();
    selection.toggle('c');
    selection.toggle('a');
    tap(byRole(bar.el, 'button', 'Edit details'));
    expect(router.navigate).toHaveBeenCalledWith('/edit/details?ids=a,c');
    expect(selection.active.peek()).toBe(true);
    expect(selection.list()).toEqual(['a', 'c']);
    // Leaving the Library unmounts the bar; the selection is still there when it comes back.
    bar.destroy();
    expect(selection.list()).toEqual(['a', 'c']);
  });

  it('`hosted` is true while a bar is mounted (Select is offered only then); destroy is idempotent', () => {
    const selection = createSelection();
    expect(selection.hosted.peek()).toBe(false);
    const store = fakeStore();
    const deps = {store, account: fakeAccount(), desktop: {available: true}, announce: vi.fn()};
    const one = selection.mountBar(document.body.appendChild(document.createElement('div')), deps);
    const two = selection.mountBar(document.body.appendChild(document.createElement('div')), deps);
    expect(selection.hosted.peek()).toBe(true);
    one.destroy();
    one.destroy();
    expect(selection.hosted.peek()).toBe(true);
    two.destroy();
    expect(selection.hosted.peek()).toBe(false);
  });

  it('Re-split is disabled with "Paused on this account" for export-only and suspended accounts (D10)', () => {
    for (const status of ['export_only', 'suspended']) {
      const {bar, selection, store} = mountBar({status});
      selection.toggle('a');
      const resplit = [...bar.el.querySelectorAll('button')].find(b => b.querySelector('.ui-button-label')?.textContent === 'Re-split');
      expect(resplit.getAttribute('aria-disabled'), status).toBe('true');
      expect(document.getElementById(resplit.getAttribute('aria-describedby')).textContent).toBe(COPY.pausedAccount);
      peers.resplit.mockClear();
      tap(resplit);
      expect(peers.resplit).not.toHaveBeenCalled();
      store.session.value = {status: 'active'};
      expect(resplit.getAttribute('aria-disabled')).toBeNull();
      expect(resplit.hasAttribute('aria-describedby')).toBe(false);
      bar.destroy();
    }
  });

  it('Pin pins the selection; with every selected song pinned it is Unpin', async () => {
    const {bar, selection, account} = mountBar({pins: ['a']});
    selection.toggle('a');
    expect(byRole(bar.el, 'button', 'Unpin')).not.toBeNull();
    selection.toggle('b');
    tap(byRole(bar.el, 'button', 'Pin'));
    await vi.waitFor(() => expect(account.pins.peek()).toEqual(['a', 'b']));
    expect(byRole(bar.el, 'button', 'Unpin')).not.toBeNull();
  });

  it('Re-split shows on the desktop app only and opens the dialog for the selection', () => {
    const web = mountBar({desktop: false});
    web.selection.start('a');
    expect(byRole(web.bar.el, 'button', 'Re-split').hidden).toBe(true);
    web.bar.destroy();
    const {bar, selection} = mountBar({desktop: true});
    selection.toggle('a');
    selection.toggle('b');
    const resplit = byRole(bar.el, 'button', 'Re-split');
    expect(resplit.hidden).toBe(false);
    tap(resplit);
    expect(peers.resplit).toHaveBeenCalledWith(expect.objectContaining({songIds: ['a', 'b']}));
  });

  it('Delete asks, deletes and ends selection; failures stay selected', async () => {
    const {bar, selection, api} = mountBar();
    api.remove.mockImplementation(async ({id}) => { if (id === 'b') throw new Error('nope'); return true; });
    selection.toggle('a');
    selection.toggle('b');
    tap(byRole(bar.el, 'button', 'Delete'));
    const dialog = document.querySelector('dialog.ui-dialog');
    expect(dialog.querySelector('.ui-dialog-title').textContent).toBe('Delete 2 songs?');
    tap(dialog.querySelectorAll('.ui-dialog-action')[1]);
    await vi.waitFor(() => expect(api.remove).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(selection.list()).toEqual(['b']));
    expect(selection.active.peek()).toBe(true);
  });

  it('Done ends selection; songs deleted elsewhere drop out of it', () => {
    const {bar, selection, store} = mountBar();
    selection.toggle('a');
    selection.toggle('b');
    store.library.songs.value = new Map([['b', song('b')]]);
    expect(selection.list()).toEqual(['b']);
    tap(byRole(bar.el, 'button', 'Done'));
    expect(selection.active.peek()).toBe(false);
    bar.destroy();
    expect(bar.el.isConnected).toBe(false);
  });
});
