// @vitest-environment happy-dom
// The setlist page (/set/:id; architecture §2.16, §6.8; spec B3, §7.8): rows in order with the controls table, Play from
// the top → /s/<first>?set=<id>, touch on open, reorder by ⌥↑/⌥↓ and by dragging the handle (saved with setSongs,
// whose returned order wins; the focused row never moves in the DOM), remove with the 8 s Undo toast, inline rename,
// delete, the read-only paused account, and the loading, missing and empty states.
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {installPopoverShim, pointer, restoreDomShims, setRect, tap} from './helpers/dom.js';

const {mount, moveId, reinsert, FIRST_DATA_MS} = await import('../src/library/setlist-page.js');
const {COPY, CONTROLS, UNDO_MS} = await import('../src/library/library-actions.copy.js');
const {signal} = await import('../src/app/store.js');

const SONGS = [
  {id: 'glasshouse', title: 'Glasshouse', artist: 'Northbound', duration: 128},
  {id: 'lowtide', title: 'Low Tide Static', artist: 'Northbound', duration: 92},
  {id: 'secondwind', title: 'Second Wind', artist: 'The Ferry Hours', duration: 90},
  {id: 'nightbus', title: 'Night Bus', artist: '', duration: 233},
];
const NAME = 'Friday at the Grange';

function nameOf(el) {
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) return labelledby.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim();
  return (el.getAttribute('aria-label') ?? el.textContent).replace(/\s+/g, ' ').trim();
}
const SELECTORS = {button: 'button', link: 'a[href]', list: 'ol, ul, [role=list]'};
const byRole = (root, role, name) => [...root.querySelectorAll(SELECTORS[role])].find(el => nameOf(el) === name || nameOf(el).startsWith(`${name},`)) ?? null;

function fakeApi(initial) {
  let listener = null, value = initial;
  const api = {
    subscribeGet: vi.fn(({id}, onValue) => { listener = onValue; if (value !== undefined) onValue(value); return () => { listener = null; }; }),
    touch: vi.fn(async () => null),
    setSongs: vi.fn(async ({songIds}) => songIds),
    rename: vi.fn(async () => null),
    remove: vi.fn(async () => null),
    push(next) { value = next; listener?.(next); },
  };
  return api;
}

async function setup({data = {id: 'set-friday', name: NAME, songIds: SONGS.map(s => s.id)}, status = 'active', songs = SONGS} = {}) {
  const store = {
    library: {songs: signal(new Map(songs.map(s => [s.id, s]))), loaded: signal(true), setlists: signal([])},
    session: signal({status}),
  };
  const api = fakeApi(data);
  const router = {navigate: vi.fn()};
  const calls = [];
  const feedback = {
    toast: vi.fn((message, options = {}) => { calls.push({message, options}); return {dismiss() {}, update() {}}; }),
    announce: vi.fn(),
    confirm: vi.fn(async () => true),
  };
  const el = document.body.appendChild(document.createElement('div'));
  const view = await mount(el, {name: 'setlist', params: {id: 'set-friday'}, query: {}}, {store, router, api, feedback});
  return {el, view, api, router, calls, feedback, store};
}

const rowIds = el => [...el.querySelectorAll('.set-row')].map(li => li.dataset.songId);
const altKey = (target, key) => target.dispatchEvent(new KeyboardEvent('keydown', {key, code: key, altKey: true, bubbles: true, cancelable: true}));

beforeEach(() => { installPopoverShim(); document.body.replaceChildren(); });
afterEach(() => { restoreDomShims(); vi.useRealTimers(); });

describe('order helpers', () => {
  it('moveId moves one place either way and stops at the ends', () => {
    expect(moveId(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveId(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    const same = ['a', 'b'];
    expect(moveId(same, 'a', -1)).toBe(same);
    expect(moveId(same, 'z', 1)).toBe(same);
  });
  it('reinsert puts an id back at its index (clamped), once', () => {
    expect(reinsert(['a', 'c'], 'b', 1)).toEqual(['a', 'b', 'c']);
    expect(reinsert(['a'], 'b', 9)).toEqual(['a', 'b']);
    expect(reinsert(['a', 'b'], 'b', 0)).toEqual(['a', 'b']);
  });
});

describe('the setlist page', () => {
  it('renders the header, the rows in order and every controls-table row; touches the list once', async () => {
    const {el, api} = await setup();
    expect(el.querySelector('h1').textContent).toBe(NAME);
    expect(el.querySelector('.set-meta').textContent).toBe('4 songs · 9 min');
    expect(rowIds(el)).toEqual(['glasshouse', 'lowtide', 'secondwind', 'nightbus']);
    const page = CONTROLS.filter(r => r.where === 'setlist-page');
    const sample = {
      [COPY.openSong('Harbor Lights')]: COPY.openSong('Glasshouse'),
      [COPY.moveHandle('Harbor Lights')]: COPY.moveHandle('Glasshouse'),
      [COPY.removeSong('Harbor Lights', NAME)]: COPY.removeSong('Glasshouse', NAME),
    };
    for (const row of page) expect(byRole(el, row.role, sample[row.name] ?? row.name), `${row.role} "${row.name}"`).not.toBeNull();
    const open = el.querySelector('.set-open');
    expect(open.getAttribute('href')).toBe('/s/glasshouse?set=set-friday');
    expect(nameOf(open)).toBe('Practise Glasshouse, 1 of 4');
    expect(api.touch).toHaveBeenCalledTimes(1);
    expect(api.touch).toHaveBeenCalledWith({id: 'set-friday'});
  });

  it('Play from the top opens the first song with ?set=; a row opens its song', async () => {
    const {el, router} = await setup();
    tap(byRole(el, 'button', COPY.play));
    expect(router.navigate).toHaveBeenLastCalledWith('/s/glasshouse?set=set-friday');
    el.querySelectorAll('.set-open')[2].dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
    expect(router.navigate).toHaveBeenLastCalledWith('/s/secondwind?set=set-friday');
  });

  it('⌥↓ / ⌥↑ on a focused row reorder, save with setSongs and announce; the focused row keeps focus', async () => {
    const {el, api, feedback} = await setup();
    const handle = el.querySelectorAll('.set-handle')[0];
    handle.focus();
    altKey(handle, 'ArrowDown');
    expect(rowIds(el)).toEqual(['lowtide', 'glasshouse', 'secondwind', 'nightbus']);
    expect(api.setSongs).toHaveBeenCalledWith({id: 'set-friday', songIds: ['lowtide', 'glasshouse', 'secondwind', 'nightbus']});
    expect(feedback.announce).toHaveBeenCalledWith('Glasshouse moved to 2 of 4', expect.anything());
    expect(document.activeElement).toBe(handle);
    await vi.waitFor(() => expect(api.setSongs).toHaveBeenCalledTimes(1));
    altKey(handle, 'ArrowUp');
    altKey(el.querySelectorAll('.set-handle')[0], 'ArrowUp');   // already first: nothing
    await vi.waitFor(() => expect(rowIds(el)[0]).toBe('glasshouse'));
    expect(api.setSongs).toHaveBeenCalledTimes(2);
  });

  it('the stored order setSongs returns wins (a song deleted meanwhile drops out)', async () => {
    const {el, api} = await setup();
    api.setSongs.mockResolvedValueOnce(['lowtide', 'glasshouse', 'nightbus']);
    altKey(el.querySelector('.set-handle'), 'ArrowDown');
    await vi.waitFor(() => expect(rowIds(el)).toEqual(['lowtide', 'glasshouse', 'nightbus']));
  });

  it('a refused save puts the old order back with an error toast', async () => {
    const {el, api, calls} = await setup();
    api.setSongs.mockRejectedValueOnce(Object.assign(new Error('x'), {code: 'not_found'}));
    altKey(el.querySelector('.set-handle'), 'ArrowDown');
    await vi.waitFor(() => expect(rowIds(el)).toEqual(['glasshouse', 'lowtide', 'secondwind', 'nightbus']));
    expect(calls.at(-1).options.tone).toBe('error');
  });

  it('dragging the handle reorders by row midpoints, then saves once on release', async () => {
    const {el, api, feedback} = await setup();
    setRect(el.querySelector('.set-scroller'), {top: 0, height: 2000, width: 800});
    const list = el.querySelector('.set-list');
    for (const li of list.children) {
      Object.defineProperty(li, 'offsetTop', {configurable: true, get: () => [...list.children].indexOf(li) * 64});
      Object.defineProperty(li, 'offsetHeight', {configurable: true, get: () => 64});
    }
    const handle = list.children[0].querySelector('.set-handle');
    pointer(handle, 'pointerdown', {y: 100, pointerType: 'touch'});
    pointer(handle, 'pointermove', {y: 102, pointerType: 'touch'});      // within the slop: no drag yet
    expect(list.children[0].dataset.dragging).toBeUndefined();
    pointer(handle, 'pointermove', {y: 100 + 64 * 2 + 10, pointerType: 'touch'});
    expect(list.children[2].dataset.dragging).toBe('');
    expect(rowIds(el)).toEqual(['lowtide', 'secondwind', 'glasshouse', 'nightbus']);
    expect(api.setSongs).not.toHaveBeenCalled();
    pointer(handle, 'pointerup', {y: 238, pointerType: 'touch'});
    expect(api.setSongs).toHaveBeenCalledTimes(1);
    expect(api.setSongs).toHaveBeenCalledWith({id: 'set-friday', songIds: ['lowtide', 'secondwind', 'glasshouse', 'nightbus']});
    expect(feedback.announce).toHaveBeenCalledWith('Glasshouse moved to 3 of 4', expect.anything());
    expect(list.querySelector('[data-dragging]')).toBeNull();
  });

  it('a cancelled drag puts the rows back and saves nothing', async () => {
    const {el, api} = await setup();
    setRect(el.querySelector('.set-scroller'), {top: 0, height: 2000, width: 800});
    const list = el.querySelector('.set-list');
    for (const li of list.children) {
      Object.defineProperty(li, 'offsetTop', {configurable: true, get: () => [...list.children].indexOf(li) * 64});
      Object.defineProperty(li, 'offsetHeight', {configurable: true, get: () => 64});
    }
    const handle = list.children[0].querySelector('.set-handle');
    pointer(handle, 'pointerdown', {y: 100});
    pointer(handle, 'pointermove', {y: 200});
    pointer(handle, 'pointercancel', {y: 200});
    expect(rowIds(el)).toEqual(['glasshouse', 'lowtide', 'secondwind', 'nightbus']);
    expect(api.setSongs).not.toHaveBeenCalled();
  });

  it('✕ removes the song at once; the 8 s Undo puts it back where it was', async () => {
    const {el, api, calls} = await setup();
    tap(byRole(el, 'button', COPY.removeSong('Low Tide Static', NAME)));
    expect(rowIds(el)).toEqual(['glasshouse', 'secondwind', 'nightbus']);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(api.setSongs).toHaveBeenCalledWith({id: 'set-friday', songIds: ['glasshouse', 'secondwind', 'nightbus']});
    expect(calls[0].message).toBe(`Removed “Low Tide Static” from ${NAME}`);
    expect(calls[0].options.durationMs).toBe(UNDO_MS);
    await calls[0].options.action.run();
    expect(api.setSongs).toHaveBeenLastCalledWith({id: 'set-friday', songIds: ['glasshouse', 'lowtide', 'secondwind', 'nightbus']});
    expect(rowIds(el)).toEqual(['glasshouse', 'lowtide', 'secondwind', 'nightbus']);
  });

  it('removing a focused row moves focus to the next row’s ✕', async () => {
    const {el} = await setup();
    const remove = byRole(el, 'button', COPY.removeSong('Glasshouse', NAME));
    remove.focus();
    tap(remove);
    expect(document.activeElement).toBe(byRole(el, 'button', COPY.removeSong('Low Tide Static', NAME)));
  });

  it('Rename is inline: Enter saves a tidy name, Esc cancels, an empty name is refused at the field', async () => {
    const {el, api} = await setup();
    tap(byRole(el, 'button', COPY.rename));
    const input = el.querySelector('.set-rename-input');
    expect(el.querySelector('.set-rename').hidden).toBe(false);
    expect(el.querySelector('h1').hidden).toBe(true);
    expect(input.value).toBe(NAME);
    expect(document.activeElement).toBe(input);
    input.value = '  ';
    el.querySelector('.set-rename').dispatchEvent(new Event('submit', {cancelable: true}));
    expect(el.querySelector('.set-rename-error').hidden).toBe(false);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(api.rename).not.toHaveBeenCalled();
    input.value = '  Saturday   set ';
    el.querySelector('.set-rename').dispatchEvent(new Event('submit', {cancelable: true}));
    await vi.waitFor(() => expect(el.querySelector('h1').hidden).toBe(false));
    expect(api.rename).toHaveBeenCalledWith({id: 'set-friday', name: 'Saturday set'});
    expect(el.querySelector('h1').textContent).toBe('Saturday set');
    tap(byRole(el, 'button', COPY.rename));
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
    expect(el.querySelector('.set-rename').hidden).toBe(true);
    expect(document.activeElement).toBe(byRole(el, 'button', COPY.rename));
  });

  it('Delete setlist… asks, deletes and returns to the Library', async () => {
    const {el, api, router, feedback, calls} = await setup();
    tap(byRole(el, 'button', COPY.deleteSetlist));
    await vi.waitFor(() => expect(api.remove).toHaveBeenCalledWith({id: 'set-friday'}));
    expect(feedback.confirm).toHaveBeenCalledWith(expect.objectContaining({title: `Delete “${NAME}”?`, danger: true}));
    await vi.waitFor(() => expect(router.navigate).toHaveBeenCalledWith('/', {replace: true}));
    expect(calls.at(-1).message).toBe(`Deleted “${NAME}”`);
  });

  it('a paused (export-only) account sees the list read-only, with a note', async () => {
    const {el} = await setup({status: 'export_only'});
    expect(el.querySelector('.set-note').hidden).toBe(false);
    expect(el.querySelector('.set-note').textContent).toBe(COPY.readOnly);
    expect(byRole(el, 'button', COPY.rename).getAttribute('aria-disabled')).toBe('true');
    expect(el.querySelector('.set-handle').disabled).toBe(true);
    expect(byRole(el, 'button', COPY.removeSong('Glasshouse', NAME)).getAttribute('aria-disabled')).toBe('true');
    expect(byRole(el, 'button', COPY.play).getAttribute('aria-disabled')).toBeNull();
  });

  it('a deleted (or foreign) list: "This setlist isn’t here" with a way back', async () => {
    const {el, api, router} = await setup({data: null});
    expect(el.querySelector('.set-page').dataset.state).toBe('missing');
    expect(el.textContent).toContain(COPY.missingTitle);
    expect(api.touch).not.toHaveBeenCalled();
    const back = [...el.querySelectorAll('.set-edge a')].find(a => a.textContent === COPY.missingAction);
    back.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
    expect(router.navigate).toHaveBeenCalledWith('/');
  });

  it('an empty list: the empty state, Play disabled', async () => {
    const {el} = await setup({data: {id: 'set-friday', name: NAME, songIds: []}});
    expect(el.querySelector('.set-page').dataset.state).toBe('empty');
    expect(el.textContent).toContain(COPY.emptyTitle);
    expect(byRole(el, 'button', COPY.play).getAttribute('aria-disabled')).toBe('true');
  });

  it('loading: mount resolves after FIRST_DATA_MS with a row skeleton, then the list arrives', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    const store = {library: {songs: signal(new Map(SONGS.map(s => [s.id, s]))), loaded: signal(true)}, session: signal({status: 'active'})};
    const api = fakeApi(undefined);
    const el = document.body.appendChild(document.createElement('div'));
    const pending = mount(el, {params: {id: 'set-friday'}}, {store, api, router: {navigate() {}}, feedback: {toast() {}, announce() {}}});
    await vi.advanceTimersByTimeAsync(FIRST_DATA_MS);
    const view = await pending;
    expect(el.querySelector('.set-page').dataset.state).toBe('loading');
    expect(el.querySelector('.ui-skeleton')).not.toBeNull();
    api.push({id: 'set-friday', name: NAME, songIds: ['nightbus']});
    expect(el.querySelector('.set-page').dataset.state).toBe('ready');
    expect(rowIds(el)).toEqual(['nightbus']);
    view.unmount();
    expect(el.childElementCount).toBe(0);
  });

  it('a subscription update while a save is in flight waits for it', async () => {
    const {el, api} = await setup();
    let release;
    api.setSongs.mockImplementationOnce(({songIds}) => new Promise(resolve => { release = () => resolve(songIds); }));
    altKey(el.querySelector('.set-handle'), 'ArrowDown');
    api.push({id: 'set-friday', name: NAME, songIds: SONGS.map(s => s.id)});   // the stale order, before the save lands
    expect(rowIds(el)[0]).toBe('lowtide');
    release();
    await vi.waitFor(() => expect(rowIds(el)[0]).toBe('lowtide'));
  });

  it('update() with another id subscribes to that list', async () => {
    const {view, api} = await setup();
    view.update({params: {id: 'set-warmup'}});
    expect(api.subscribeGet).toHaveBeenLastCalledWith({id: 'set-warmup'}, expect.any(Function), expect.any(Function));
  });
});
