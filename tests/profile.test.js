import {describe, expect, test} from 'vitest';
import {INSTRUMENTS, STEM_FOR, myStems, addDefaults, describeMapping} from '../src/app/profile.js';

const FOUR = ['drums', 'bass', 'other', 'vocals'];
const SIX = ['drums', 'bass', 'guitar', 'piano', 'vocals', 'other'];
const profile = (...instruments) => ({instruments, primary: instruments[0] ?? null, openWithMyPart: 'in'});

describe('constants', () => {
  test('instruments and the stem table match the contract', () => {
    expect(INSTRUMENTS).toEqual(['drums', 'bass', 'guitar', 'keys', 'vocals', 'other']);
    expect(STEM_FOR).toEqual({drums: ['drums'], bass: ['bass'], vocals: ['vocals'], guitar: ['guitar', 'other'], keys: ['piano', 'other'], other: ['other']});
    expect(Object.keys(STEM_FOR).sort()).toEqual([...INSTRUMENTS].sort());
  });

  test('the shared tables cannot be mutated by a caller', () => {
    expect(Object.isFrozen(INSTRUMENTS)).toBe(true);
    expect(Object.isFrozen(STEM_FOR)).toBe(true);
    expect(Object.isFrozen(STEM_FOR.guitar)).toBe(true);
  });
});

describe('myStems (D37)', () => {
  test.each([
    // [instrument, stems, names, fallbacks, missing]
    ['drums', FOUR, ['drums'], [], []],
    ['drums', SIX, ['drums'], [], []],
    ['bass', FOUR, ['bass'], [], []],
    ['bass', SIX, ['bass'], [], []],
    ['vocals', FOUR, ['vocals'], [], []],
    ['vocals', SIX, ['vocals'], [], []],
    ['guitar', SIX, ['guitar'], [], []],
    ['guitar', FOUR, ['other'], ['guitar'], []],
    ['keys', SIX, ['piano'], [], []],
    ['keys', FOUR, ['other'], ['keys'], []],
    ['other', FOUR, ['other'], [], []],
    ['other', SIX, ['other'], [], []],
  ])('%s on %j', (instrument, stems, names, fallbacks, missing) => {
    expect(myStems(profile(instrument), stems)).toEqual({names, fallbacks, missing});
  });

  test.each([
    // 2-stem songs: only an exact stem name matches, and no_* stems never match
    ['drums', ['drums', 'no_drums'], ['drums'], []],
    ['vocals', ['vocals', 'no_vocals'], ['vocals'], []],
    ['bass', ['bass', 'no_bass'], ['bass'], []],
    ['guitar', ['drums', 'no_drums'], [], ['guitar']],
    ['keys', ['vocals', 'no_vocals'], [], ['keys']],
    ['other', ['bass', 'no_bass'], [], ['other']],
    ['drums', ['vocals', 'no_vocals'], [], ['drums']],
    ['bass', ['drums', 'no_drums'], [], ['bass']],
  ])('2-stem: %s on %j', (instrument, stems, names, missing) => {
    expect(myStems(profile(instrument), stems)).toEqual({names, fallbacks: [], missing});
  });

  test('several instruments: names follow the song order and a shared fallback stem appears once', () => {
    expect(myStems(profile('keys', 'guitar', 'vocals'), FOUR)).toEqual({names: ['other', 'vocals'], fallbacks: ['keys', 'guitar'], missing: []});
    expect(myStems(profile('vocals', 'drums'), SIX)).toEqual({names: ['drums', 'vocals'], fallbacks: [], missing: []});
    expect(myStems(profile('guitar', 'other'), FOUR)).toEqual({names: ['other'], fallbacks: ['guitar'], missing: []});
    expect(myStems(profile('drums', 'guitar'), ['drums', 'no_drums'])).toEqual({names: ['drums'], fallbacks: [], missing: ['guitar']});
  });

  test('no profile, an empty profile or no stems match nothing', () => {
    expect(myStems(null, FOUR)).toEqual({names: [], fallbacks: [], missing: []});
    expect(myStems(undefined, FOUR)).toEqual({names: [], fallbacks: [], missing: []});
    expect(myStems(profile(), FOUR)).toEqual({names: [], fallbacks: [], missing: []});
    expect(myStems(profile('drums'), [])).toEqual({names: [], fallbacks: [], missing: ['drums']});
    expect(myStems(profile('drums'), null)).toEqual({names: [], fallbacks: [], missing: ['drums']});
  });

  test('unknown and duplicate instruments are ignored; stem names match case-insensitively and are returned as given', () => {
    expect(myStems({instruments: ['drums', 'drums', 'kazoo', 7, null]}, ['Drums', 'Bass'])).toEqual({names: ['Drums'], fallbacks: [], missing: []});
    expect(myStems({instruments: 'drums'}, FOUR)).toEqual({names: [], fallbacks: [], missing: []});
  });

  test('non-string stem names are skipped', () => {
    expect(myStems(profile('bass'), [null, 3, 'bass', ''])).toEqual({names: ['bass'], fallbacks: [], missing: []});
  });
});

describe('addDefaults', () => {
  const stock = {preset: 'balanced', stemMode: 'full', bitrate: 192};

  test.each([
    [null, 'full'],
    [profile(), 'full'],
    [profile('drums'), 'full'],
    [profile('bass', 'vocals', 'other'), 'full'],
    [profile('guitar'), 'six'],
    [profile('keys'), 'six'],
    [profile('drums', 'keys'), 'six'],
  ])('profile %j with stock settings → %s, balanced', (p, stemMode) => {
    expect(addDefaults(p, stock)).toEqual({stemMode, preset: 'balanced'});
  });

  test('never a two-part mode from the profile alone', () => {
    // every subset of instruments
    for (let mask = 0; mask < 1 << INSTRUMENTS.length; mask++) {
      const p = profile(...INSTRUMENTS.filter((_, i) => mask & (1 << i)));
      expect(['full', 'six']).toContain(addDefaults(p, stock).stemMode);
      expect(['full', 'six']).toContain(addDefaults(p, null).stemMode);
    }
  });

  test('saved stem modes ("Use these for future songs") win over the profile', () => {
    expect(addDefaults(profile('drums'), {...stock, stemMode: 'six'})).toEqual({stemMode: 'six', preset: 'balanced'});
    expect(addDefaults(profile('guitar'), {...stock, stemMode: 'drums'})).toEqual({stemMode: 'drums', preset: 'balanced'});
    expect(addDefaults(profile(), {...stock, stemMode: 'vocals', preset: 'studio'})).toEqual({stemMode: 'vocals', preset: 'studio'});
  });

  test('the saved preset is kept; an unknown stem mode falls back to the profile rule', () => {
    expect(addDefaults(profile('keys'), {preset: 'fast', stemMode: 'full'})).toEqual({stemMode: 'six', preset: 'fast'});
    expect(addDefaults(profile('keys'), {preset: 'custom', stemMode: 'weird'})).toEqual({stemMode: 'six', preset: 'custom'});
    expect(addDefaults(profile('bass'), {preset: '', stemMode: 3})).toEqual({stemMode: 'full', preset: 'balanced'});
    expect(addDefaults(undefined, undefined)).toEqual({stemMode: 'full', preset: 'balanced'});
  });
});

describe('describeMapping', () => {
  test('one line per instrument in profile order', () => {
    expect(describeMapping(profile('guitar', 'drums', 'keys', 'bass', 'vocals', 'other'))).toEqual([
      'Guitar → guitar stem on 6-stem songs, otherwise Other',
      'Drums → drums stem',
      'Keys → piano stem on 6-stem songs, otherwise Other',
      'Bass → bass stem',
      'Vocals → vocals stem',
      'Other → other stem',
    ]);
  });

  test('no profile → no lines', () => {
    expect(describeMapping(null)).toEqual([]);
    expect(describeMapping(profile())).toEqual([]);
    expect(describeMapping({instruments: ['guitar', 'guitar', 'tuba']})).toEqual(['Guitar → guitar stem on 6-stem songs, otherwise Other']);
  });
});
