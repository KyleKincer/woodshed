// @vitest-environment happy-dom
// The song card menu and the selection menu (architecture §2.16, spec §2.5, §7.7; D49, D10): the item list in order
// on the desktop app and on the web, shortcut hints, visible disabled reasons (web Re-split, paused accounts, Share
// until SH1), Select first, navigation, pins, Open original source, Delete, the selection menu while selecting, and
// "Add to setlist ▸" with its 8 s Undo and the new-list Dialog. Rendered through the real Menu primitive for the
// controls table.
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {installPopoverShim, restoreDomShims, tap} from './helpers/dom.js';

const peers = vi.hoisted(() => ({resplit: null}));
vi.mock('../src/library/resplit-dialog.js', () => {
  peers.resplit = vi.fn(async () => {});
  return {openResplitDialog: peers.resplit, openResplit: vi.fn()};
});

const {cardMenuItems, addToSetlistItems, addToSetlist, createSetlistWith, sourceUrl} = await import('../src/library/card-menu.js');
const {createSelection} = await import('../src/library/selection.js');
const {COPY, CONTROLS, UNDO_MS} = await import('../src/library/library-actions.copy.js');
const {Menu, resolveItem} = await import('../src/ui/menu.js');
const {createRegistry} = await import('../src/app/commands.js');
const {signal} = await import('../src/app/store.js');

const HARBOR = {id: 'harbor', title: 'Harbor Lights', duration: 204, hasChart: true, source: {type: 'url', value: 'https://www.youtube.com/watch?v=harbor01'}};
const JAM = {id: 'jam', title: 'untitled_jam_03.wav', duration: 148, hasChart: false, source: {type: 'upload', value: 'local1', filename: 'untitled_jam_03.wav'}};
const LISTS = [
  {id: 'set-friday', name: 'Friday at the Grange', count: 5, songIds: ['a', 'b', 'c', 'd', 'e']},
  {id: 'set-warmup', name: 'Warm-ups', count: 2, songIds: ['harbor', 'x']},
];

function setup({desktop = true, status = 'active', pins = [], lists = LISTS, songs = [HARBOR, JAM], share = false} = {}) {
  const store = {
    library: {songs: signal(new Map(songs.map(s => [s.id, s]))), setlists: signal(lists), loaded: signal(true)},
    session: signal({status}),
  };
  const pinsSig = signal(pins);
  const account = {pins: pinsSig, value: signal({pins}), patch: vi.fn(async change => { pinsSig.value = change.pins; return change; })};
  const router = {navigate: vi.fn()};
  const calls = [];
  const toast = vi.fn((message, options = {}) => { const h = {message, options, dismiss: vi.fn(), update: vi.fn()}; calls.push(h); return h; });
  const setlists = {
    addSongs: vi.fn(async ({songIds}) => ({added: songIds})),
    get: vi.fn(async ({id}) => ({id, name: 'x', songIds: ['a', 'b', 'harbor', 'z']})),
    setSongs: vi.fn(async ({songIds}) => songIds),
    create: vi.fn(async () => 'set-3'),
    remove: vi.fn(async () => null),
  };
  const selection = createSelection({order: () => songs.map(s => s.id)});
  const win = {open: vi.fn()};
  const shareDialog = vi.fn();
  const later = share ? {'../share/share-dialog.js': async () => ({openShareDialog: shareDialog})} : {};
  const ctx = {store, account, router, toast, setlists, selection, desktop: {available: desktop}, window: win, later,
    confirm: vi.fn(async () => true), songsApi: {remove: vi.fn(async () => true)}};
  return {ctx, store, account, router, calls, toast, setlists, selection, win, shareDialog};
}

const labels = items => items.map(i => (i.type === 'separator' ? '—' : i.label));
const find = (items, id) => items.find(i => i.id === id);

beforeEach(() => { installPopoverShim(); document.body.replaceChildren(); });
afterEach(() => { restoreDomShims(); for (const d of document.querySelectorAll('dialog')) d.remove(); });

describe('cardMenuItems', () => {
  it('desktop, a song with a chart and an http source: the spec §2.5 list with Select first (D49)', () => {
    const {ctx} = setup();
    const items = cardMenuItems(HARBOR, ctx);
    expect(labels(items)).toEqual(['Select', '—', 'Practice', 'Edit details…', 'Edit chart', 'Edit map', '—',
      'Pin', 'Share…', 'Add to setlist', '—', 'Re-split…', 'Open original source', '—', 'Delete…']);
    expect(find(items, 'card.practice').kbd).toBe('Enter');
    expect(find(items, 'card.editDetails').kbd).toBe('KeyE');
    expect(find(items, 'card.delete').danger).toBe(true);
    expect(find(items, 'card.addToSetlist').type).toBe('submenu');
    expect(find(items, 'card.resplit').reason).toBeNull();
  });

  it('web, an upload without a chart: no Edit chart, no source link; Re-split disabled with the visible reason', () => {
    const {ctx} = setup({desktop: false});
    const items = cardMenuItems(JAM, ctx);
    expect(labels(items)).toEqual(['Select', '—', 'Practice', 'Edit details…', 'Edit map', '—',
      'Pin', 'Share…', 'Add to setlist', '—', 'Re-split…', '—', 'Delete…']);
    const resplit = resolveItem(find(items, 'card.resplit'), createRegistry());
    expect(resplit.disabled).toBe(true);
    expect(resplit.reason).toBe('Needs Woodshed for desktop');
  });

  it('a paused (export-only) account may pin but not share, re-split or change setlists (D10)', () => {
    const {ctx} = setup({status: 'export_only', share: true});
    const items = cardMenuItems(HARBOR, ctx);
    expect(find(items, 'card.share').reason).toBe(COPY.pausedAccount);
    expect(find(items, 'card.resplit').reason).toBe(COPY.pausedAccount);
    expect(find(items, 'card.addToSetlist').reason).toBe(COPY.pausedAccount);
    expect(find(items, 'card.pin').reason ?? null).toBeNull();
  });

  it('Share… says "Not built yet" until SH1’s share dialog exists, then opens it with the song', async () => {
    expect(find(cardMenuItems(HARBOR, setup().ctx), 'card.share').reason).toBe('Not built yet');
    const {ctx, shareDialog} = setup({share: true});
    const share = find(cardMenuItems(HARBOR, ctx), 'card.share');
    expect(share.reason).toBeNull();
    share.run();
    await vi.waitFor(() => expect(shareDialog).toHaveBeenCalledWith({song: HARBOR, session: null}));
  });

  it('Select enters selection mode with this card selected', () => {
    const {ctx, selection} = setup();
    find(cardMenuItems(HARBOR, ctx), 'card.select').run();
    expect(selection.active.peek()).toBe(true);
    expect(selection.list()).toEqual(['harbor']);
  });

  it('Practice, Edit details, Edit chart and Edit map navigate', () => {
    const {ctx, router} = setup();
    const items = cardMenuItems(HARBOR, ctx);
    for (const id of ['card.practice', 'card.editDetails', 'card.editChart', 'card.editMap']) find(items, id).run();
    expect(router.navigate.mock.calls.map(c => c[0])).toEqual(['/s/harbor', '/s/harbor/edit/details', '/s/harbor/edit/chart', '/s/harbor/edit/map']);
  });

  it('Pin / Unpin follow the pins, with the 8 s Undo toast', async () => {
    const {ctx, account, calls} = setup({pins: []});
    await find(cardMenuItems(HARBOR, ctx), 'card.pin').run();
    expect(account.pins.peek()).toEqual(['harbor']);
    expect(calls[0].message).toBe('Pinned “Harbor Lights”');
    expect(calls[0].options.durationMs).toBe(UNDO_MS);
    const unpin = find(cardMenuItems(HARBOR, ctx), 'card.unpin');
    expect(unpin.label).toBe('Unpin');
    await unpin.run();
    expect(account.pins.peek()).toEqual([]);
  });

  it('Re-split opens the Re-split dialog; Open original source opens the link in a new tab', () => {
    const {ctx, win} = setup();
    const items = cardMenuItems(HARBOR, ctx);
    find(items, 'card.resplit').run();
    expect(peers.resplit).toHaveBeenCalledWith(expect.objectContaining({songIds: ['harbor']}));
    find(items, 'card.openSource').run();
    expect(win.open).toHaveBeenCalledWith('https://www.youtube.com/watch?v=harbor01', '_blank', 'noopener,noreferrer');
    expect(sourceUrl({source: {type: 'spotify', value: 'https://open.spotify.com/track/x'}})).toBe('https://open.spotify.com/track/x');
    expect(sourceUrl({source: {type: 'search', value: 'harbor lights'}})).toBeNull();
  });

  it('Delete… confirms, then removes the song', async () => {
    const {ctx} = setup();
    await find(cardMenuItems(HARBOR, ctx), 'card.delete').run();
    expect(ctx.confirm).toHaveBeenCalledWith(expect.objectContaining({title: 'Delete “Harbor Lights”?', danger: true}));
    expect(ctx.songsApi.remove).toHaveBeenCalledWith({id: 'harbor'});
  });

  it('while selecting, a selected card’s menu is the selection menu (spec §7.7); an unselected one keeps Select', async () => {
    const {ctx, selection, router} = setup();
    selection.toggle('harbor');
    selection.toggle('jam');
    const items = cardMenuItems(HARBOR, ctx);
    expect(labels(items)).toEqual(['Edit details of 2 songs…', 'Pin 2 songs', 'Add to setlist', 'Re-split 2 songs…', '—', 'Done', '—', 'Delete 2 songs…']);
    find(items, 'selection.details').run();
    expect(router.navigate).toHaveBeenCalledWith('/edit/details?ids=harbor,jam');
    expect(selection.active.peek()).toBe(false);
    selection.toggle('jam');
    expect(cardMenuItems(HARBOR, ctx)[0].label).toBe('Select');
    const del = find(cardMenuItems(JAM, ctx), 'selection.delete');
    await del.run();
    expect(ctx.songsApi.remove).toHaveBeenCalledWith({id: 'jam'});
    expect(selection.active.peek()).toBe(false);
  });

  it('renders every card-menu row of the controls table with its role and name', () => {
    const {ctx} = setup({share: true});
    const anchor = document.body.appendChild(document.createElement('button'));
    const menu = Menu({items: cardMenuItems(HARBOR, ctx), anchor, label: 'Harbor Lights', presentation: 'popover', registry: createRegistry()});
    const rows = [...document.querySelectorAll('[role=menu] [role=menuitem]')];
    const names = rows.map(row => document.getElementById(row.getAttribute('aria-labelledby')).textContent);
    for (const row of CONTROLS.filter(r => r.where === 'card-menu')) expect(names, row.name).toContain(row.name);
    const practice = rows[names.indexOf('Practice')];
    expect(practice.getAttribute('aria-keyshortcuts')).toBe('Enter');
    expect(rows[names.indexOf('Edit details…')].getAttribute('aria-keyshortcuts')).toBe('E');
    menu.destroy();
  });

  it('a web Re-split row shows its reason, described by it and disabled', () => {
    const {ctx} = setup({desktop: false});
    const anchor = document.body.appendChild(document.createElement('button'));
    const menu = Menu({items: cardMenuItems(HARBOR, ctx), anchor, presentation: 'popover', registry: createRegistry()});
    const row = [...document.querySelectorAll('[role=menuitem]')].find(r => r.textContent.includes('Re-split'));
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(row.getAttribute('aria-describedby')).textContent).toBe('Needs Woodshed for desktop');
    menu.destroy();
  });
});

describe('Add to setlist ▸', () => {
  it('lists every setlist; one that already holds the song is disabled with its reason; then New setlist…', () => {
    const {ctx} = setup();
    const item = addToSetlistItems(['harbor'], ctx);
    expect(item.label).toBe('Add to setlist');
    expect(labels(item.items)).toEqual(['Friday at the Grange · 5 songs', 'Warm-ups · 2 songs', '—', 'New setlist…']);
    expect(item.items[0].reason).toBeNull();
    expect(item.items[1].reason).toBe('Already in this list');
    for (const row of CONTROLS.filter(r => r.where === 'setlist-submenu')) expect(labels(item.items)).toContain(row.name);
  });

  it('a list that would pass 100 songs is disabled as full; 100 lists disable New setlist…', () => {
    const full = {id: 'big', name: 'Big', count: 100, songIds: Array.from({length: 100}, (_, i) => `q${i}`)};
    const many = Array.from({length: 100}, (_, i) => ({id: `l${i}`, name: `L${i}`, count: 0, songIds: []}));
    expect(addToSetlistItems(['harbor'], setup({lists: [full]}).ctx).items[0].reason).toBe('This list is full');
    expect(addToSetlistItems(['harbor'], setup({lists: many}).ctx).items.at(-1).reason).toBe('You have 100 setlists');
  });

  it('adding shows the 8 s Undo toast; Undo removes exactly the songs it added from the current order', async () => {
    const {ctx, setlists, calls} = setup();
    setlists.addSongs.mockResolvedValueOnce({added: ['harbor']});
    expect(await addToSetlist(LISTS[0], ['harbor', 'a'], ctx)).toEqual(['harbor']);
    expect(setlists.addSongs).toHaveBeenCalledWith({id: 'set-friday', songIds: ['harbor', 'a']});
    expect(calls[0].message).toBe('Added “Harbor Lights” to Friday at the Grange');
    expect(calls[0].options.durationMs).toBe(8000);
    await calls[0].options.action.run();
    expect(setlists.get).toHaveBeenCalledWith({id: 'set-friday'});
    expect(setlists.setSongs).toHaveBeenCalledWith({id: 'set-friday', songIds: ['a', 'b', 'z']});
  });

  it('nothing new to add: "Already in …", no Undo; a refusal is an error toast', async () => {
    const {ctx, setlists, calls} = setup();
    setlists.addSongs.mockResolvedValueOnce({added: []});
    await addToSetlist(LISTS[1], ['harbor'], ctx);
    expect(calls[0].message).toBe('Already in Warm-ups');
    expect(calls[0].options.action).toBeUndefined();
    setlists.addSongs.mockRejectedValueOnce(Object.assign(new Error('full'), {code: 'setlist_full'}));
    await addToSetlist(LISTS[0], ['harbor'], ctx);
    expect(calls[1].options.tone).toBe('error');
    expect(calls[1].message).toBe('This setlist is full.');
  });

  it('New setlist…: a name in a Dialog creates the list with the songs; Undo deletes it', async () => {
    const {ctx, setlists, calls} = setup();
    const done = createSetlistWith(['harbor', 'jam'], {...ctx, form: undefined});
    const dialog = document.querySelector('dialog.ui-dialog');
    expect(dialog.querySelector('.ui-dialog-title').textContent).toBe('New setlist');
    const input = dialog.querySelector('input');
    input.value = '   Thursday   rehearsal ';
    dialog.querySelector('form').dispatchEvent(new Event('submit', {cancelable: true}));
    expect(await done).toBe('set-3');
    expect(setlists.create).toHaveBeenCalledWith({name: 'Thursday rehearsal', songIds: ['harbor', 'jam']});
    expect(calls[0].message).toBe('Created Thursday rehearsal with 2 songs');
    await calls[0].options.action.run();
    expect(setlists.remove).toHaveBeenCalledWith({id: 'set-3'});
  });

  it('New setlist…: a server refusal of the name shows at the field and keeps the Dialog open', async () => {
    const {ctx, setlists} = setup();
    setlists.create.mockRejectedValueOnce(Object.assign(new Error('bad'), {code: 'invalid', data: {field: 'name'}}));
    const done = createSetlistWith(['harbor'], {...ctx, form: undefined});
    const dialog = document.querySelector('dialog.ui-dialog');
    dialog.querySelector('input').value = 'Ok';
    dialog.querySelector('form').dispatchEvent(new Event('submit', {cancelable: true}));
    await vi.waitFor(() => expect(dialog.querySelector('.ui-dialog-field-error').hidden).toBe(false));
    expect(dialog.open).toBe(true);
    tap(dialog.querySelector('.ui-dialog-action'));   // Cancel
    expect(await done).toBeNull();
  });
});
