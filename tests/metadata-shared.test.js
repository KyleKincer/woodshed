import {describe, expect, test} from 'vitest';
import {ConvexError} from 'convex/values';
import {
  ARTWORK_TYPES, FIELD_KEYS, IDENTITY_KEYS, LABELS, LIMITS, MBID, MESSAGES, STATUS_COPY, TEXT_FIELDS,
  changedKeys, cleanTags, hasValue, isFieldKey, maxLength, sameValue, statusLine, tooLongMessage, validateField, validatePatch,
} from '../shared/metadata.ts';
import {cleanMetadata} from '../convex/lib/songMetadata.ts';

const REL = '22222222-2222-4222-8222-222222222222';

describe('fields, labels and limits', () => {
  test('every field has a label, and text fields are the fields minus tags and artwork', () => {
    for (const key of FIELD_KEYS) expect(LABELS[key]).toMatch(/^[A-Z][a-z]+( [a-z]+)?$/);
    expect(Object.keys(LABELS).sort()).toEqual([...FIELD_KEYS].sort());
    expect([...TEXT_FIELDS].sort()).toEqual(FIELD_KEYS.filter(k => k !== 'tags' && k !== 'artwork').sort());
    expect(IDENTITY_KEYS.every(k => FIELD_KEYS.includes(k))).toBe(true);
    expect(LABELS.albumArtist).toBe('Album artist');
    expect(LABELS.trackNumber).toBe('Track');
    expect(LABELS.musicalKey).toBe('Key');
  });

  test('limits are the server limits', () => {
    expect(LIMITS).toMatchObject({text: 500, notes: 10_000, tags: 30, tag: 60, search: 500, bulk: 100, artworkBytes: 2_000_000});
    expect(maxLength('title')).toBe(500);
    expect(maxLength('notes')).toBe(10_000);
    expect([...ARTWORK_TYPES]).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    expect(isFieldKey('albumArtist')).toBe(true);
    for (const bad of ['metadataLocks', '', 'Title', 7, null]) expect(isFieldKey(bad)).toBe(false);
  });

  test('too-long copy names the label, never the key', () => {
    expect(tooLongMessage('albumArtist')).toBe('Album artist is too long (500 characters max).');
    expect(tooLongMessage('notes')).toBe('Notes are too long (10,000 characters max).');
    for (const key of TEXT_FIELDS) {
      expect(tooLongMessage(key).startsWith(`${LABELS[key]} `)).toBe(true);
      if (/[A-Z]/.test(key)) expect(tooLongMessage(key)).not.toContain(key);
    }
  });
});

describe('validateField', () => {
  const ok = (key, raw, value) => expect(validateField(key, raw)).toEqual({value});
  const bad = (key, raw, error) => expect(validateField(key, raw)).toEqual({error, field: key});

  test('text is trimmed and checked against its rules', () => {
    ok('title', '  Glasshouse ', 'Glasshouse');
    ok('artist', '', '');
    ok('year', ' 2021 ', '2021');
    ok('year', '', '');
    ok('trackNumber', '12', '12');
    ok('discNumber', '9999', '9999');
    ok('albumArtist', 'x'.repeat(500), 'x'.repeat(500));
    ok('notes', 'x'.repeat(10_000), 'x'.repeat(10_000));
    bad('title', ' ', MESSAGES.titleRequired);
    bad('year', '21', MESSAGES.year);
    bad('year', '2021-01', MESSAGES.year);
    bad('trackNumber', '0', MESSAGES.number);
    bad('trackNumber', '-1', MESSAGES.number);
    bad('discNumber', '10000', MESSAGES.number);
    bad('albumArtist', 'x'.repeat(501), 'Album artist is too long (500 characters max).');
    bad('notes', 'x'.repeat(10_001), 'Notes are too long (10,000 characters max).');
    bad('genre', 42, 'Genre must be text.');
  });

  test('tags are trimmed, emptied and deduplicated case-insensitively', () => {
    ok('tags', [' Warmup ', 'warmup', '', 'Slow', 'WARMUP'], ['Warmup', 'Slow']);
    ok('tags', [], []);
    bad('tags', Array(31).fill('a'), MESSAGES.tags);
    bad('tags', ['x'.repeat(61)], MESSAGES.tags);
    bad('tags', 'warmup', MESSAGES.tags);
    bad('tags', ['ok', 3], MESSAGES.tags);
    expect(cleanTags(['b', 'B', ' a ', 'A '])).toEqual(['b', 'a']);
  });

  test('artwork must be a valid choice', () => {
    ok('artwork', {kind: 'removed'}, {kind: 'removed'});
    ok('artwork', {kind: 'upload', key: 'users/u/artwork/x/cover.jpg'}, {kind: 'upload', key: 'users/u/artwork/x/cover.jpg'});
    ok('artwork', {kind: 'release', releaseId: REL}, {kind: 'release', releaseId: REL});
    for (const raw of [null, 'removed', {kind: 'release', releaseId: 'nope'}, {kind: 'upload', key: ''}, {kind: 'other'}])
      bad('artwork', raw, MESSAGES.artwork);
    expect(MBID.test(REL)).toBe(true);
  });

  test('an unknown key is an error naming that key', () => {
    expect(validateField('metadataLocks', [])).toEqual({error: MESSAGES.unknownField, field: 'metadataLocks'});
  });
});

describe('validatePatch', () => {
  test('cleans every defined key and reports the first error in page order', () => {
    expect(validatePatch({title: ' A ', tags: ['x', 'X'], genre: undefined})).toEqual({value: {title: 'A', tags: ['x']}});
    expect(validatePatch({notes: 'x'.repeat(10_001), year: 'soon', title: ''})).toEqual({error: MESSAGES.titleRequired, field: 'title'});
    expect(validatePatch({})).toEqual({value: {}});
  });

  test('the server cleans and fails exactly like the shared rules (G7)', () => {
    const patches = [
      {title: ' A '}, {tags: [' a', 'A', '']}, {year: '2021', trackNumber: '3'}, {artwork: {kind: 'release', releaseId: REL}},
      {albumArtist: 'x'.repeat(501)}, {title: ''}, {year: 'x'}, {discNumber: '0'}, {tags: Array(31).fill('t')},
      {artwork: {kind: 'release', releaseId: 'bad'}}, {notes: 'x'.repeat(10_001)},
    ];
    for (const patch of patches) {
      const shared = validatePatch(patch);
      let server;
      try {
        server = {value: cleanMetadata(patch)};
      } catch (error) {
        expect(error).toBeInstanceOf(ConvexError);
        server = {error: error.data.message, field: error.data.field, code: error.data.code};
      }
      if ('error' in shared) expect(server).toEqual({...shared, code: 'invalid'});
      else expect(server).toEqual(shared);
    }
  });
});

describe('sameValue and changedKeys (G1)', () => {
  test('text compares trimmed, with missing equal to empty', () => {
    expect(sameValue('title', 'A', ' A ')).toBe(true);
    expect(sameValue('genre', undefined, '')).toBe(true);
    expect(sameValue('genre', null, '  ')).toBe(true);
    expect(sameValue('genre', 'Jazz', 'jazz')).toBe(false);
  });

  test('tags compare after cleaning, artwork by choice', () => {
    expect(sameValue('tags', undefined, [])).toBe(true);
    expect(sameValue('tags', ['a', 'b'], [' a', 'A', 'b'])).toBe(true);
    expect(sameValue('tags', ['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameValue('artwork', undefined, null)).toBe(true);
    expect(sameValue('artwork', undefined, {kind: 'removed'})).toBe(false);
    expect(sameValue('artwork', {kind: 'release', releaseId: REL}, {kind: 'release', releaseId: REL.toUpperCase()})).toBe(true);
    expect(sameValue('artwork', {kind: 'upload', key: 'a'}, {kind: 'upload', key: 'b'})).toBe(false);
    expect(sameValue('artwork', {kind: 'upload', key: 'a'}, {kind: 'release', releaseId: REL})).toBe(false);
  });

  test('changedKeys lists only real changes, in field order', () => {
    const stored = {title: 'A', artist: 'B', genre: 'Jazz', tags: ['x']};
    expect(changedKeys({genre: 'Jazz ', title: 'A', tags: ['x', 'X'], year: ''}, stored)).toEqual([]);
    expect(changedKeys({notes: 'n', genre: 'Rock', title: 'A', artwork: {kind: 'removed'}}, stored)).toEqual(['genre', 'notes', 'artwork']);
  });

  test('hasValue', () => {
    const song = {title: 'A', artist: ' ', tags: [], artwork: {kind: 'removed'}};
    expect(hasValue(song, 'title')).toBe(true);
    expect(hasValue(song, 'artist')).toBe(false);
    expect(hasValue(song, 'album')).toBe(false);
    expect(hasValue(song, 'tags')).toBe(false);
    expect(hasValue(song, 'artwork')).toBe(true);
  });
});

describe('statusLine (§6.9 status copy)', () => {
  test.each([
    [{metadataStatus: 'pending'}, 'pending', 'Finding song details…', undefined],
    [{metadataStatus: 'matched'}, 'matched', 'Matched on MusicBrainz', undefined],
    [{metadataStatus: 'uncertain', metadataSuggestion: {recordingId: 'r', title: 't'}}, 'suggestion', 'Not sure this is right', undefined],
    [{metadataStatus: 'uncertain'}, 'noMatch', 'No match found', undefined],
    [{metadataStatus: 'unavailable'}, 'unavailable', "Couldn't reach MusicBrainz", {id: 'retry', label: 'Try again'}],
  ])('%j → %s', (song, state, text, action) => {
    const line = statusLine(song);
    expect(line).toEqual(action ? {state, text, action} : {state, text});
    expect(Object.values(STATUS_COPY)).toContain(text);
  });

  test('no lookup ever ran (or an unknown stored value) shows no status', () => {
    for (const song of [{}, {metadataStatus: null}, {metadataStatus: 'done'}, null, undefined]) expect(statusLine(song)).toBeNull();
  });
});
