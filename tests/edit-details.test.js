// @vitest-environment happy-dom
// Edit · Details (src/edit/details/*; spec §5.3, architecture §2.15, §6.9, maps/meta-css-backend.md G1–G17):
// the field table, per-field autosave on blur (notes debounced 1 s, flushed on unmount), inline Saved,
// Revert with `unlock`, client validation with the server's copy, server field errors, live updates that
// never overwrite a focused or pending field, artwork upload / remove / revert, the Match section
// (Yes → confirm, Find another → results → Review → the field-diff review → update with `match`,
// Try again → retry, #match), and bulk mode (getMany, Apply to N songs, Revert through updateEach).
// The bulk posture bar is ED2's (tests/edit-frame.test.js); a stand-in records it here. Sizes,
// columns and colours are Playwright states (tests/fixture/states/ED6.cjs).
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const bars = vi.hoisted(() => []);
vi.mock('../src/edit/edit.js', () => ({
  mountBulkPostureBar: (el, opts) => {
    const bar = document.createElement('header');
    bar.className = 'edit-bulk';
    const h1 = document.createElement('h1');
    h1.textContent = `Editing details · ${opts.count} songs`;
    bar.append(h1);
    el.append(bar);
    const saveStatus = {value: null};
    const b = {el: bar, opts, saveStatus, set: vi.fn(({count}) => { h1.textContent = `Editing details · ${count} songs`; }), destroy: vi.fn(() => bar.remove())};
    bars.push(b);
    return b;
  },
}));

import {signal} from '../src/app/store.js';
import {ApiError} from '../src/api/client.js';
import {mount, COPY} from '../src/edit/details/details.js';
import {FIELDS, GROUPS, FIELD_ORDER, commonValue, storedValue, check, NOTES_DEBOUNCE_MS} from '../src/edit/details/fields.js';
import {diffRows} from '../src/edit/details/match.js';
import {coverOf, REVERT_UPLOAD_MS} from '../src/edit/details/artwork.js';
import {parseIds} from '../src/edit/details/bulk.js';
import {FIELD_KEYS, LABELS, MESSAGES, STATUS_COPY} from '../shared/metadata.ts';

const REC = (n) => `5e1f0000-0000-4000-8000-00000000000${n}`;
const REL = (n) => `7e1e0000-0000-4000-8000-00000000000${n}`;

const SONG = Object.freeze({
  id: 's1', title: 'Glasshouse', artist: 'Northbound', album: 'Weather Systems', albumArtist: 'Northbound', year: '2021',
  genre: 'Indie rock', trackNumber: '3', discNumber: '', musicalKey: 'A minor', tuning: 'Standard', tags: ['drums', 'setlist'],
  notes: 'Watch the flam.', metadataLocks: ['title'], metadataStatus: 'matched', coverKey: 'covers/weather.png', coverUrl: null,
  artwork: null,
});

const CANDIDATES = [
  {recordingId: REC(1), releaseId: REL(1), title: 'Glasshouse', artist: 'Northbound', album: 'Weather Systems (Deluxe)', albumArtist: 'Northbound', year: '2022', trackNumber: '4', discNumber: '1', duration: 64},
  {recordingId: REC(2), title: 'Glasshouse (Live)', artist: 'Northbound', album: '', year: '', duration: 71, disambiguation: 'live'},
];

/** A fake backend over one live song signal (the session's `song`), following the server's rules loosely. */
function backend(song = SONG) {
  const live = signal(structuredClone(song));
  const patch = (changes, unlock = [], match) => {
    const next = structuredClone(live.peek());
    const locks = new Set(next.metadataLocks ?? []);
    for (const [k, v] of Object.entries(changes ?? {})) { next[k] = structuredClone(v); locks.add(k); }
    for (const k of unlock ?? []) locks.delete(k);
    next.metadataLocks = [...locks];
    if (match) { next.metadataStatus = 'matched'; next.metadataRecordingId = match.recordingId; delete next.metadataSuggestion; }
    live.value = next;
  };
  const metadata = {
    update: vi.fn(async ({changes, unlock, match}) => { patch(changes, unlock, match); return null; }),
    updateEach: vi.fn(async () => null),
    confirm: vi.fn(async () => { const n = structuredClone(live.peek()); n.metadataStatus = 'matched'; delete n.metadataSuggestion; live.value = n; return null; }),
    find: vi.fn(async ({recordingId}) => (recordingId
      ? [{...CANDIDATES[0], releaseId: REL(2), album: 'Weather Systems'}, {...CANDIDATES[0], releaseId: REL(3), album: 'Compilation'}]
      : CANDIDATES)),
    detail: vi.fn(async ({recordingId, releaseId}) => ({...CANDIDATES.find((c) => c.recordingId === recordingId), ...(releaseId ? {releaseId} : {})})),
    retry: vi.fn(async () => null),
    uploadArtwork: vi.fn(async () => 'artwork/new.png'),
  };
  return {live, metadata};
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 4) { for (let i = 0; i < n; i++) await tick(); }

let host, view, be, edit, announce;
const cleanups = [];

async function open({song = SONG, hash = '', deps = {}} = {}) {
  be = backend(song);
  edit = {saveStatus: signal(null)};
  announce = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  window.location.hash = hash;
  const session = {id: song.id, song: be.live};
  view = await mount(host, {name: 'edit', params: {songId: song.id, tab: 'details'}, query: {}}, {
    session, edit, embedded: true,
    detailsDeps: {metadata: be.metadata, songs: {}, sign: async (k) => `https://signed.test/${k}`, now: () => 1_000_000, decode: null,
      objectURL: {create: () => 'blob:preview', revoke: vi.fn()}, announce, ...deps},
  });
  cleanups.push(() => view.unmount());
  return view;
}

const row = (key) => host.querySelector(`.details-field[data-key="${key}"]`);
const input = (key) => row(key).querySelector('input, textarea');
const status = (key) => row(key).querySelector('.ui-field-status, .details-chip-status')?.textContent ?? '';
const errorOf = (key) => { const e = row(key).querySelector('.ui-field-error'); return e && !e.hidden ? e.textContent : ''; };
const revertOf = (key) => row(key).querySelector('.details-revert');
const button = (name, root = host) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === name || b.getAttribute('aria-label') === name);

function type(key, value) {
  const el = input(key);
  el.focus();
  el.value = value;
  el.dispatchEvent(new Event('input', {bubbles: true}));
}
function blur(key) {
  const el = input(key);
  el.dispatchEvent(new FocusEvent('blur'));
  el.blur();
}
async function edit_(key, value) { type(key, value); blur(key); await settle(); }

beforeEach(() => { bars.length = 0; });
afterEach(() => {
  vi.useRealTimers();
  for (const off of cleanups.splice(0).reverse()) { try { off(); } catch { /* gone */ } }
  host?.remove();
  window.location.hash = '';
});

// ---------------------------------------------------------------------------------------------------------------

describe('the field table (spec §5.3)', () => {
  test('Song and Practice hold every field but artwork, in shared/metadata.ts order, with its label', () => {
    expect([...GROUPS.song, ...GROUPS.practice]).toEqual(FIELD_ORDER);
    expect(FIELD_ORDER).toEqual(FIELD_KEYS.filter((k) => k !== 'artwork'));
    expect(GROUPS.song).toEqual(['title', 'artist', 'album', 'albumArtist', 'year', 'genre', 'trackNumber', 'discNumber']);
    expect(GROUPS.practice).toEqual(['musicalKey', 'tuning', 'tags', 'notes']);
    for (const key of FIELD_ORDER) expect(FIELDS[key].label).toBe(LABELS[key]);
    expect(FIELDS.title.required).toBe(true);
    expect(FIELDS.tags.kind).toBe('chips');
    expect(FIELDS.notes.kind).toBe('textarea');
    expect(FIELDS.year.inputmode).toBe('numeric');
  });

  test('storedValue and commonValue (bulk "Multiple values")', () => {
    expect(storedValue({}, 'album')).toBe('');
    expect(storedValue({tags: null}, 'tags')).toEqual([]);
    expect(commonValue([{genre: 'Rock'}, {genre: ' Rock '}], 'genre')).toEqual({mixed: false, value: 'Rock'});
    expect(commonValue([{genre: 'Rock'}, {genre: 'Pop'}], 'genre')).toEqual({mixed: true, value: ''});
    expect(commonValue([{tags: ['a', 'b']}, {tags: ['A', 'b']}], 'tags').mixed).toBe(true);
    expect(commonValue([{tags: ['a']}, {tags: ['a']}], 'tags')).toEqual({mixed: false, value: ['a']});
  });

  test('check() uses the server rules and copy', () => {
    expect(check('title', '  ')).toEqual({error: MESSAGES.titleRequired});
    expect(check('year', '21')).toEqual({error: MESSAGES.year});
    expect(check('albumArtist', 'x'.repeat(501)).error).toBe('Album artist is too long (500 characters max).');
    expect(check('tags', [' a ', 'A', 'b'])).toEqual({value: ['a', 'b']});
  });

  test('renders the four sections with labelled fields and the stored values', async () => {
    await open();
    expect([...host.querySelectorAll('h2')].map((n) => n.textContent)).toEqual(['Song', 'Practice', 'Artwork', 'Match']);
    for (const key of FIELD_ORDER) {
      const control = input(key);
      const label = row(key).querySelector('label');
      expect(label.textContent).toBe(LABELS[key]);
      expect(label.htmlFor).toBe(control.id);
    }
    expect(input('title').value).toBe('Glasshouse');
    expect(input('title').getAttribute('aria-required')).toBe('true');
    expect(input('notes').value).toBe('Watch the flam.');
    expect([...row('tags').querySelectorAll('.ui-chip')].map((c) => c.textContent.trim())).toEqual(['drums', 'setlist']);
    expect(host.querySelectorAll('.details-revert:not([hidden])')).toHaveLength(0);
  });
});

describe('autosave per field', () => {
  test('blur saves the one changed field, shows "Saved" inline and in the posture bar, then offers Revert', async () => {
    await open();
    await edit_('genre', 'Post-rock');
    expect(be.metadata.update).toHaveBeenCalledTimes(1);
    expect(be.metadata.update).toHaveBeenCalledWith({ids: ['s1'], changes: {genre: 'Post-rock'}});
    expect(status('genre')).toBe('Saved');
    expect(edit.saveStatus.peek()).toEqual({state: 'saved', text: 'Saved'});
    expect(revertOf('genre').hidden).toBe(false);
    expect(revertOf('genre').getAttribute('aria-label')).toBe('Revert genre');
    expect(revertOf('album').hidden).toBe(true);
  });

  test('Enter commits a text field', async () => {
    await open();
    type('album', 'Weather');
    input('album').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    await settle();
    expect(be.metadata.update).toHaveBeenCalledWith({ids: ['s1'], changes: {album: 'Weather'}});
  });

  test('an unchanged value never saves (G1), even with extra spaces, and shows the cleaned value', async () => {
    await open();
    await edit_('artist', '  Northbound  ');
    expect(be.metadata.update).not.toHaveBeenCalled();
    expect(input('artist').value).toBe('Northbound');
  });

  test('"Saving…" while the save is in flight', async () => {
    await open();
    let release;
    be.metadata.update.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    await edit_('genre', 'Jazz');
    expect(status('genre')).toBe('Saving…');
    expect(edit.saveStatus.peek()).toEqual({state: 'saving', text: 'Saving…'});
    release(null);
    await settle();
    expect(status('genre')).toBe('Saved');
  });

  test('a client validation error shows under the field with the server copy, and nothing is sent', async () => {
    await open();
    await edit_('year', '21');
    expect(be.metadata.update).not.toHaveBeenCalled();
    expect(errorOf('year')).toBe(MESSAGES.year);
    expect(input('year').getAttribute('aria-invalid')).toBe('true');
    await edit_('title', '');
    expect(errorOf('title')).toBe('Enter a song title.');
    // Fixing it clears the error and saves.
    await edit_('year', '2020');
    expect(errorOf('year')).toBe('');
    expect(input('year').hasAttribute('aria-invalid')).toBe(false);
    expect(be.metadata.update).toHaveBeenCalledWith({ids: ['s1'], changes: {year: '2020'}});
  });

  test('a coded server field error lands on its field; any other failure is the inline status', async () => {
    await open();
    be.metadata.update.mockRejectedValueOnce(new ApiError({code: 'invalid', message: 'Album is too long (500 characters max).', data: {field: 'album'}}));
    await edit_('album', 'Long');
    expect(errorOf('album')).toBe('Album is too long (500 characters max).');
    be.metadata.update.mockRejectedValueOnce(new ApiError({code: 'account_suspended', message: 'nope'}));
    await edit_('genre', 'Jazz');
    expect(status('genre')).toBe('This account is suspended.');
    expect(edit.saveStatus.peek()).toEqual({state: 'error', text: COPY.saveFailed});
  });

  test('tags save on every chip change', async () => {
    await open();
    const el = input('tags');
    el.focus();
    el.value = 'warmup';
    el.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    await settle();
    expect(be.metadata.update).toHaveBeenLastCalledWith({ids: ['s1'], changes: {tags: ['drums', 'setlist', 'warmup']}});
    expect(status('tags')).toBe('Saved');
    button('Remove drums').click();
    await settle();
    expect(be.metadata.update).toHaveBeenLastCalledWith({ids: ['s1'], changes: {tags: ['setlist', 'warmup']}});
  });

  test('notes save after 1 s of idle typing, not before', async () => {
    vi.useFakeTimers();
    await open();
    type('notes', 'Slow loop the bridge.');
    await vi.advanceTimersByTimeAsync(NOTES_DEBOUNCE_MS - 100);
    expect(be.metadata.update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(be.metadata.update).toHaveBeenCalledWith({ids: ['s1'], changes: {notes: 'Slow loop the bridge.'}});
  });

  test('unmount flushes pending notes and typed text (G15)', async () => {
    await open();
    type('notes', 'Half typed');
    type('genre', 'Funk');
    view.unmount();
    const calls = be.metadata.update.mock.calls.map((c) => c[0].changes);
    expect(calls).toContainEqual({notes: 'Half typed'});
    expect(calls).toContainEqual({genre: 'Funk'});
  });

  test('pagehide flushes the notes', async () => {
    await open();
    type('notes', 'Leaving');
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(be.metadata.update).toHaveBeenCalledWith({ids: ['s1'], changes: {notes: 'Leaving'}});
  });
});

describe('Revert (G2)', () => {
  test('puts back the value the page opened with and unlocks a field that was not locked', async () => {
    await open();
    await edit_('genre', 'Post-rock');
    revertOf('genre').click();
    await settle();
    expect(be.metadata.update).toHaveBeenLastCalledWith({ids: ['s1'], changes: {genre: 'Indie rock'}, unlock: ['genre']});
    expect(input('genre').value).toBe('Indie rock');
    expect(be.live.peek().metadataLocks).not.toContain('genre');
    expect(revertOf('genre').hidden).toBe(true);
  });

  test('keeps the lock of a field that was locked, and reverts after several saves to the first value', async () => {
    await open();
    await edit_('title', 'Glass House');
    await edit_('title', 'Glass House (Remastered)');
    revertOf('title').click();
    await settle();
    expect(be.metadata.update).toHaveBeenLastCalledWith({ids: ['s1'], changes: {title: 'Glasshouse'}, unlock: []});
    expect(input('title').value).toBe('Glasshouse');
  });

  test('Revert clears a shown error and replaces typed text', async () => {
    await open();
    await edit_('year', '1999');
    await edit_('year', 'abc');
    expect(errorOf('year')).toBe(MESSAGES.year);
    revertOf('year').click();
    await settle();
    expect(errorOf('year')).toBe('');
    expect(input('year').value).toBe('2021');
  });
});

describe('live updates (G12)', () => {
  test('fill unfocused fields, never a focused, typed or pending one', async () => {
    await open();
    let release;
    be.metadata.update.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    type('genre', 'Jazz');
    blur('genre');              // pending
    await settle();
    type('artist', 'Typing');   // focused and typed
    be.live.value = {...be.live.peek(), artist: 'Server artist', album: 'Server album', genre: 'Server genre'};
    await settle();
    expect(input('artist').value).toBe('Typing');
    expect(input('genre').value).toBe('Jazz');
    expect(input('album').value).toBe('Server album');
    release(null);
    await settle();
  });

  test('a field showing an error keeps the typed value', async () => {
    await open();
    await edit_('trackNumber', 'A1');
    be.live.value = {...be.live.peek(), trackNumber: '5'};
    await settle();
    expect(input('trackNumber').value).toBe('A1');
    expect(errorOf('trackNumber')).toBe(MESSAGES.number);
  });

  test('the Match section follows the song', async () => {
    await open();
    be.live.value = {...be.live.peek(), metadataStatus: 'unavailable'};
    await settle();
    expect(host.querySelector('.details-match').dataset.state).toBe('unavailable');
  });
});

describe('Artwork (G11)', () => {
  test('coverOf: explicit artwork wins over the imported cover; removed shows none', () => {
    expect(coverOf({coverKey: 'k'})).toEqual({key: 'k', url: null});
    expect(coverOf({artwork: {kind: 'removed'}, coverKey: 'k'})).toBeNull();
    expect(coverOf({artwork: {kind: 'release', releaseId: REL(1)}, coverUrl: 'https://x/c.jpg', coverKey: 'k'})).toEqual({url: 'https://x/c.jpg'});
    expect(coverOf({artwork: {kind: 'upload', key: 'a/1.png'}})).toEqual({key: 'a/1.png', url: null});
    expect(coverOf({coverUrl: 'https://x/c.jpg'})).toEqual({url: 'https://x/c.jpg'});
  });

  test('the cover is signed and painted over the fallback sleeve', async () => {
    await open();
    await settle();
    const img = host.querySelector('.details-cover img');
    expect(img.src).toBe('https://signed.test/covers/weather.png');
    expect(host.querySelector('.details-cover').style.backgroundImage).toContain('data:image/svg+xml');
  });

  function choose(file) {
    const el = host.querySelector('.details-file');
    Object.defineProperty(el, 'files', {value: [file], configurable: true});
    el.dispatchEvent(new Event('change'));
  }

  test('Upload image: checks the file, decodes it, uploads, then saves the key', async () => {
    const decode = vi.fn(async () => ({close: vi.fn()}));
    await open({deps: {decode}});
    choose(new File([new Uint8Array(10)], 'c.png', {type: 'image/png'}));
    await settle(6);
    expect(decode).toHaveBeenCalled();
    expect(be.metadata.uploadArtwork).toHaveBeenCalledWith(expect.objectContaining({id: 's1', file: expect.any(File), signal: expect.any(AbortSignal)}));
    expect(be.metadata.update).toHaveBeenCalledWith({ids: ['s1'], changes: {artwork: {kind: 'upload', key: 'artwork/new.png'}}});
    expect(host.querySelector('.details-artwork-status').textContent).toContain(COPY.coverSaved);
    expect(announce).toHaveBeenCalledWith(COPY.coverSaved);
  });

  test('a wrong type, an oversized or an unreadable image is refused before uploading', async () => {
    const decode = vi.fn(async () => { throw new Error('bad'); });
    await open({deps: {decode}});
    choose(new File(['x'], 'c.gif', {type: 'image/gif'}));
    await settle();
    expect(host.querySelector('.details-artwork-status').textContent).toContain(COPY.artworkInvalid);
    choose(new File([new Uint8Array(2_000_001)], 'big.png', {type: 'image/png'}));
    await settle();
    expect(host.querySelector('.details-artwork-status').textContent).toContain(COPY.artworkInvalid);
    choose(new File([new Uint8Array(10)], 'c.png', {type: 'image/png'}));
    await settle();
    expect(host.querySelector('.details-artwork-status').textContent).toContain(COPY.artworkUnreadable);
    expect(be.metadata.uploadArtwork).not.toHaveBeenCalled();
  });

  test('a failed upload shows the error and saves nothing', async () => {
    await open();
    be.metadata.uploadArtwork.mockRejectedValueOnce(new ApiError({code: 'invalid', message: 'Artwork upload is not available.', data: {field: 'artwork'}}));
    choose(new File([new Uint8Array(10)], 'c.png', {type: 'image/png'}));
    await settle(6);
    expect(host.querySelector('.details-artwork-status').textContent).toContain('Artwork upload is not available.');
    expect(be.metadata.update).not.toHaveBeenCalled();
  });

  test('Remove saves {kind: removed}; Revert restores an earlier choice and unlocks it', async () => {
    await open({song: {...SONG, artwork: {kind: 'release', releaseId: REL(1)}, coverUrl: 'https://caa.test/1.jpg'}});
    expect(button('Revert cover').hidden).toBe(true);
    button(COPY.remove).click();
    await settle();
    expect(be.metadata.update).toHaveBeenLastCalledWith({ids: ['s1'], changes: {artwork: {kind: 'removed'}}});
    expect(button(COPY.remove).hidden).toBe(true);
    expect(button('Revert cover').hidden).toBe(false);
    button('Revert cover').click();
    await settle();
    expect(be.metadata.update).toHaveBeenLastCalledWith({ids: ['s1'], changes: {artwork: {kind: 'release', releaseId: REL(1)}}, unlock: ['artwork']});
    expect(button('Revert cover').hidden).toBe(true);
  });

  test('an earlier upload can be restored only within an hour; no Revert without an earlier choice', async () => {
    let t = 1_000_000;
    await open({song: {...SONG, artwork: {kind: 'upload', key: 'artwork/old.png'}}, deps: {now: () => t}});
    button(COPY.remove).click();
    await settle();
    t += REVERT_UPLOAD_MS - 1;
    be.live.value = {...be.live.peek()};
    await settle();
    expect(button('Revert cover').hidden).toBe(false);
    t += 2;
    be.live.value = {...be.live.peek()};
    await settle();
    expect(button('Revert cover').hidden).toBe(true);
    view.unmount();
    await open();   // an imported cover: no artwork choice to go back to
    button(COPY.remove).click();
    await settle();
    expect(button('Revert cover').hidden).toBe(true);
  });

  test('Choose another cover → Use this cover saves the release', async () => {
    await open();
    button(COPY.chooseCover).click();
    await settle();
    const panel = host.querySelector('.details-artwork .details-lookup');
    expect(panel.hidden).toBe(false);
    expect(be.metadata.find).toHaveBeenCalledWith({id: 's1', title: 'Glasshouse', artist: 'Northbound'});
    button(COPY.useCover, panel).click();
    await settle();
    expect(be.metadata.update).toHaveBeenLastCalledWith({ids: ['s1'], changes: {artwork: {kind: 'release', releaseId: REL(1)}}});
    expect(panel.hidden).toBe(true);
  });
});

describe('Match (§6.9)', () => {
  test('the status copy for each metadataStatus', async () => {
    const cases = [
      [{metadataStatus: 'pending'}, STATUS_COPY.pending, false],
      [{metadataStatus: 'matched'}, STATUS_COPY.matched, false],
      [{metadataStatus: 'uncertain', metadataSuggestion: {title: 'Glasshouse', artist: 'Northbound', recordingId: REC(1)}}, STATUS_COPY.suggestion, true],
      [{metadataStatus: 'uncertain'}, STATUS_COPY.noMatch, true],
      [{metadataStatus: 'unavailable'}, STATUS_COPY.unavailable, false],
      [{metadataStatus: null}, COPY.notLookedUp, false],
    ];
    for (const [patch, text, yes] of cases) {
      await open({song: {...SONG, ...patch}});
      expect(host.querySelector('.details-match-text').textContent).toBe(text);
      expect(button(COPY.yes).hidden).toBe(!yes);
      view.unmount();
      host.remove();
    }
  });

  test('[Yes, this is right] confirms the match', async () => {
    await open({song: {...SONG, metadataStatus: 'uncertain'}});
    button(COPY.yes).click();
    await settle();
    expect(be.metadata.confirm).toHaveBeenCalledWith({id: 's1'});
    expect(host.querySelector('.details-match').dataset.state).toBe('matched');
    expect(host.querySelector('.details-match-note').textContent).toContain(COPY.confirmed);
  });

  test('[Try again] retries an unavailable lookup; a failure is a warn line', async () => {
    await open({song: {...SONG, metadataStatus: 'unavailable'}});
    button(COPY.tryAgain).click();
    await settle();
    expect(be.metadata.retry).toHaveBeenCalledWith({id: 's1'});
    be.metadata.retry.mockRejectedValueOnce(new ApiError({code: 'lookup_busy', message: 'busy'}));
    button(COPY.tryAgain).click();
    await settle();
    const note = host.querySelector('.details-match-note');
    expect(note.hidden).toBe(false);
    expect(note.dataset.tone).toBe('warn');
  });

  test('Find another match → results → Albums / covers → Review → Use selected details records the match (G4)', async () => {
    await open({song: {...SONG, metadataLocks: ['title', 'year'], metadataStatus: 'uncertain'}});
    await edit_('trackNumber', '9');   // changed this session: left unticked in the review
    button(COPY.findAnother).click();
    await settle();
    const match = host.querySelector('.details-match');
    expect(be.metadata.find).toHaveBeenLastCalledWith({id: 's1', title: 'Glasshouse', artist: 'Northbound'});
    expect(match.querySelectorAll('.details-result')).toHaveLength(2);
    expect(match.querySelector('.details-result-title').textContent).toBe('Glasshouse');
    // Albums / covers lists the releases of that recording.
    button(COPY.releases, match).click();
    await settle();
    expect(be.metadata.find).toHaveBeenLastCalledWith({id: 's1', title: 'Glasshouse', artist: 'Northbound', recordingId: REC(1)});
    expect([...match.querySelectorAll('.details-result-title')].map((n) => n.textContent)).toEqual(['Weather Systems', 'Compilation']);
    button(COPY.allRecordings, match).click();
    await settle();
    button(COPY.review, match).click();
    await settle();
    expect(be.metadata.detail).toHaveBeenCalledWith({id: 's1', recordingId: REC(1), releaseId: REL(1)});
    const rows = [...match.querySelectorAll('.details-diff-row')].map((r) => ({key: r.querySelector('input').dataset.key, checked: r.querySelector('input').checked}));
    expect(rows).toEqual([
      {key: 'album', checked: true}, {key: 'year', checked: false}, {key: 'trackNumber', checked: false}, {key: 'discNumber', checked: true},
    ]);
    button(COPY.useSelected, match).click();
    await settle();
    expect(be.metadata.update).toHaveBeenLastCalledWith({ids: ['s1'], changes: {album: 'Weather Systems (Deluxe)', discNumber: '1'},
      match: {recordingId: REC(1), releaseId: REL(1)}});
    expect(match.dataset.state).toBe('matched');
    expect(match.querySelector('.details-lookup').hidden).toBe(true);
    expect(input('album').value).toBe('Weather Systems (Deluxe)');
    expect(revertOf('album').hidden).toBe(false);
  });

  test('a lookup error keeps the panel and every field usable', async () => {
    await open();
    be.metadata.find.mockRejectedValueOnce(new ApiError({code: 'lookup_unavailable', message: 'off'}));
    button(COPY.findAnother).click();
    await settle();
    const status = host.querySelector('.details-match .details-lookup-status');
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain('Finding songs isn’t available right now.');
    expect(input('album').disabled).toBe(false);
  });

  test('a stale search answer is dropped', async () => {
    await open();
    let first;
    be.metadata.find.mockImplementationOnce(() => new Promise((r) => { first = r; }));
    button(COPY.findAnother).click();
    await settle();
    // A second search (Enter in the title) answers at once.
    host.querySelector('.details-match .details-search input').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    await settle();
    first([{...CANDIDATES[1], title: 'Stale'}]);
    await settle();
    expect([...host.querySelectorAll('.details-match .details-result-title')].map((n) => n.textContent)).toEqual(['Glasshouse', 'Glasshouse (Live)']);
  });

  test('a suggestion for another song can be reviewed and applied', async () => {
    const suggestion = {recordingId: REC(3), releaseId: REL(4), title: 'Glass House', artist: 'Northbound', album: 'Weather Systems', year: '2021'};
    await open({song: {...SONG, metadataStatus: 'uncertain', metadataSuggestion: suggestion}});
    expect(host.querySelector('.details-suggestion').hidden).toBe(false);
    button(COPY.reviewSuggestion).click();
    await settle();
    const rows = [...host.querySelectorAll('.details-diff-row input')].map((i) => i.dataset.key);
    expect(rows).toEqual(['title']);
    button(COPY.useSelected).click();
    await settle();
    expect(be.metadata.update).toHaveBeenLastCalledWith({ids: ['s1'], changes: {}, match: {recordingId: REC(3), releaseId: REL(4)}});
  });

  test('diffRows: identity fields that differ and validate; locked and changed fields unticked', () => {
    const rows = diffRows({title: 'A', artist: 'B', year: 'nineteen', trackNumber: 2, album: 'Same'},
      {values: {title: 'a2', artist: 'B', album: 'Same'}, locks: new Set(['title']), changed: new Set()});
    expect(rows).toEqual([{key: 'title', label: 'Title', from: 'a2', to: 'A', checked: false}, {key: 'trackNumber', label: 'Track', from: '', to: '2', checked: true}]);
  });

  test('#match scrolls to and focuses the Match section', async () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    await open({hash: '#match'});
    expect(spy).toHaveBeenCalled();
    expect(document.activeElement).toBe(host.querySelector('.details-match h2'));
    spy.mockRestore();
  });

  test('the attribution links MusicBrainz and the Cover Art Archive', async () => {
    await open();
    const links = [...host.querySelectorAll('.details-match .details-attribution a')];
    expect(links.map((a) => a.href)).toEqual(['https://musicbrainz.org/', 'https://coverartarchive.org/']);
    expect(links.every((a) => a.rel.includes('noopener'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('bulk mode (G9, G10)', () => {
  const SONGS = [
    {id: 'a', title: 'One', artist: 'Same', genre: 'Rock', tags: ['x'], metadataLocks: ['genre']},
    {id: 'b', title: 'Two', artist: 'Same', genre: 'Pop', tags: ['x'], metadataLocks: []},
    {id: 'c', title: 'Three', artist: 'Same', genre: '', tags: ['x'], metadataLocks: []},
  ];

  async function openBulk({ids = 'a,b,c,gone', songs = SONGS, getMany} = {}) {
    be = backend();
    const songsApi = {getMany: getMany ?? vi.fn(async () => structuredClone(songs))};
    host = document.createElement('div');
    document.body.append(host);
    announce = vi.fn();
    view = await mount(host, {name: 'bulkDetails', params: {}, query: {ids}}, {
      router: {back: vi.fn(), navigate: vi.fn()}, detailsDeps: {metadata: be.metadata, songs: songsApi, announce},
    });
    cleanups.push(() => view.unmount());
    await view.loaded;
    return songsApi;
  }
  const applyOf = (key) => [...row(key).querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Apply to'));

  test('parseIds: comma list, trimmed, deduplicated, at most 100', () => {
    expect(parseIds(' a, b,,a ,c')).toEqual(['a', 'b', 'c']);
    expect(parseIds(Array.from({length: 120}, (_, i) => `s${i}`).join(','))).toHaveLength(100);
    expect(parseIds(undefined)).toEqual([]);
  });

  test('loads the songs with getMany, inside the bulk posture bar, and shows shared and mixed values', async () => {
    const api = await openBulk();
    expect(api.getMany).toHaveBeenCalledWith({ids: ['a', 'b', 'c', 'gone']});
    expect(bars).toHaveLength(1);
    expect(bars[0].set).toHaveBeenLastCalledWith({count: 3});
    expect(host.querySelector('.details[data-mode=bulk]')).not.toBeNull();
    expect(host.querySelector('.details-missing').textContent).toContain('1 song is no longer in your library.');
    expect(host.querySelector('.details-bulk-songs').textContent).toBe('One, Two and Three');
    expect(input('artist').value).toBe('Same');
    expect(input('genre').value).toBe('');
    expect(input('genre').placeholder).toBe(COPY.mixed);
    expect(input('title').placeholder).toBe(COPY.mixed);
    expect(host.querySelector('.details-artwork')).toBeNull();
    expect(host.querySelector('.details-match')).toBeNull();
    expect(applyOf('genre').textContent).toContain('Apply to 3 songs');
    for (const key of FIELD_ORDER) expect(applyOf(key).getAttribute('aria-disabled')).toBe('true');
  });

  test('nothing saves on blur; Apply sends one update over every id, then "Applied to 3 songs" and Revert', async () => {
    await openBulk();
    type('genre', 'Indie');
    blur('genre');
    await settle();
    expect(be.metadata.update).not.toHaveBeenCalled();
    expect(applyOf('genre').getAttribute('aria-disabled')).toBeNull();
    applyOf('genre').click();
    await settle();
    expect(be.metadata.update).toHaveBeenCalledWith({ids: ['a', 'b', 'c'], changes: {genre: 'Indie'}});
    expect(row('genre').querySelector('.details-applied').textContent).toBe('Applied to 3 songs');
    expect(input('genre').placeholder).not.toBe(COPY.mixed);
    expect(applyOf('genre').getAttribute('aria-disabled')).toBe('true');
    expect(announce).toHaveBeenCalledWith('Applied to 3 songs');
    expect(bars[0].saveStatus.value).toEqual({state: 'saved', text: 'Saved'});

    const revert = button('Revert genre on every song');
    expect(revert.hidden).toBe(false);
    revert.click();
    await settle();
    expect(be.metadata.updateEach).toHaveBeenCalledWith({items: [
      {id: 'a', changes: {genre: 'Rock'}, unlock: []},
      {id: 'b', changes: {genre: 'Pop'}, unlock: ['genre']},
      {id: 'c', changes: {genre: ''}, unlock: ['genre']},
    ]});
    expect(input('genre').placeholder).toBe(COPY.mixed);
    expect(revert.hidden).toBe(true);
  });

  test('a shared value enables Apply only when it changes; a touched mixed field warns that empty clears', async () => {
    await openBulk();
    type('artist', 'Same');
    expect(applyOf('artist').getAttribute('aria-disabled')).toBe('true');
    type('artist', 'Other');
    expect(applyOf('artist').getAttribute('aria-disabled')).toBeNull();
    type('genre', 'x');
    type('genre', '');
    expect(applyOf('genre').getAttribute('aria-disabled')).toBeNull();
    expect(row('genre').querySelector('.ui-field-hint').textContent).toBe(COPY.clearsAll(3));
    applyOf('genre').click();
    await settle();
    expect(be.metadata.update).toHaveBeenCalledWith({ids: ['a', 'b', 'c'], changes: {genre: ''}});
  });

  test('validation runs before Apply: an empty title is refused for every song', async () => {
    await openBulk();
    type('title', 'x');
    type('title', '');
    applyOf('title').click();
    await settle();
    expect(be.metadata.update).not.toHaveBeenCalled();
    expect(errorOf('title')).toBe(MESSAGES.titleRequired);
  });

  test('tags apply as a list to every song', async () => {
    await openBulk();
    const el = input('tags');
    el.focus();
    el.value = 'warmup';
    el.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    expect(be.metadata.update).not.toHaveBeenCalled();
    applyOf('tags').click();
    await settle();
    expect(be.metadata.update).toHaveBeenCalledWith({ids: ['a', 'b', 'c'], changes: {tags: ['x', 'warmup']}});
  });

  test('no songs left: a notice with a way back; a load failure offers Try again', async () => {
    await openBulk({songs: []});
    expect(host.querySelector('.details-none').textContent).toContain(COPY.none);
    view.unmount();
    host.remove();
    const getMany = vi.fn().mockRejectedValueOnce(new ApiError({code: 'unknown', message: 'x'})).mockResolvedValue(structuredClone(SONGS));
    await openBulk({getMany});
    expect(host.querySelector('.ui-status').textContent).toContain(COPY.loadFailed);
    host.querySelector('.ui-status-action').click();
    await view.loaded;
    expect(getMany).toHaveBeenCalledTimes(2);
    expect(row('title')).not.toBeNull();
  });
});
