// @vitest-environment node
// A song added from the user's own stems: the shared rules (shared/own-stems.ts) and the Add sheet's plan
// (src/library/stem-set.js).
import {describe, expect, test} from 'vitest';
import {MAX_OWN_STEMS, guessRole, looksLikeStems, separationMode, validOwnStems} from '../shared/own-stems.ts';
import {COPY, ROLES, songTitleFrom, stemPlan} from '../src/library/stem-set.js';

const id = (n) => `${String(n).repeat(8)}-1111-4222-8333-944455556666`;

describe('guessRole', () => {
  test('stem names, Clone Hero / Rock Band packs and DAW bounces', () => {
    const cases = {
      'drums.ogg': 'drums', 'drums_1.ogg': 'drums', 'Drums 3.wav': 'drums', 'Kick.wav': 'drums', 'OH L.wav': 'other',
      'Overheads.wav': 'drums', 'bass.ogg': 'bass', 'Bass DI.wav': 'bass', 'vocals.ogg': 'vocals', 'vocals_1.ogg': 'vocals',
      'Lead Vox.wav': 'vocals', 'BGV.wav': 'vocals', 'guitar.ogg': 'guitar', 'rhythm.ogg': 'guitar', 'Gtr 2.wav': 'guitar',
      'keys.ogg': 'piano', 'Piano.flac': 'piano', 'Synth Pad.wav': 'piano', 'song.ogg': 'mix', 'Full Mix.wav': 'mix',
      'Harbor Lights (Master).wav': 'mix', 'crowd.ogg': 'skip', 'preview.ogg': 'skip', 'Click.wav': 'skip',
      'other.wav': 'other', 'Strings.wav': 'other', 'Harbor Lights - drums.wav': 'drums',
    };
    for (const [name, role] of Object.entries(cases)) expect(guessRole(name), name).toBe(role);
  });

  test('looksLikeStems: two or more files that name a stem', () => {
    expect(looksLikeStems(['drums.ogg', 'bass.ogg', 'song.ogg'])).toBe(true);
    expect(looksLikeStems(['drums.ogg', 'song.ogg'])).toBe(false);
    expect(looksLikeStems(['Harbor Lights.mp3', 'garage-take-4.wav'])).toBe(false);
    expect(looksLikeStems(['drums.ogg'])).toBe(false);
  });
});

describe('the split a mix gets with the user\'s stems', () => {
  test('guitar or piano need the 6-stem split; a two-part split takes only its focus', () => {
    expect(separationMode('full', ['drums', 'bass'])).toBe('full');
    expect(separationMode('full', ['guitar'])).toBe('six');
    expect(separationMode('six', ['piano', 'drums'])).toBe('six');
    expect(separationMode('drums', ['drums'])).toBe('drums');
    expect(separationMode('drums', ['drums', 'bass'])).toBe('full');
    expect(separationMode('vocals', ['drums'])).toBe('full');
  });

  test('validOwnStems: known names, upload ids, no repeats, at most MAX_OWN_STEMS', () => {
    expect(validOwnStems([{name: 'drums', value: id(1), filename: 'drums.wav'}, {name: 'drums', value: id(2)}])).toBe(true);
    expect(validOwnStems([])).toBe(false);
    expect(validOwnStems([{name: 'kazoo', value: id(1)}])).toBe(false);
    expect(validOwnStems([{name: 'drums', value: '../etc'}])).toBe(false);
    expect(validOwnStems([{name: 'drums', value: id(1)}, {name: 'bass', value: id(1)}])).toBe(false);
    expect(validOwnStems(Array.from({length: MAX_OWN_STEMS + 1}, (_, i) => ({name: 'other', value: `${String(i).padStart(8, '0')}-1111-4222-8333-944455556666`})))).toBe(false);
  });
});

describe('the Add sheet\'s plan (stem-set.js)', () => {
  test('a mix with stems, a mix alone, stems alone, merged and left-out files', () => {
    expect(stemPlan(['mix', 'drums', 'bass'], 'full')).toMatchObject({ok: true, mode: 'full', mix: true,
      lines: ['Woodshed splits the full mix and uses your Drums and Bass instead of its own.']});
    expect(stemPlan(['mix', 'guitar'], 'full')).toMatchObject({mode: 'six', lines: [COPY.splitYours(['Guitar']), COPY.splitInto(6)]});
    expect(stemPlan(['mix', 'skip'], 'drums')).toMatchObject({ok: true, mode: 'drums', lines: [COPY.mixOnly, COPY.leftOut(1)]});
    expect(stemPlan(['drums', 'drums', 'bass', 'skip'], 'full')).toMatchObject({ok: true, mode: 'own', mix: false,
      lines: [COPY.yoursOnly(2), COPY.merged('Drums', 2), COPY.leftOut(1)]});
    expect(stemPlan(['vocals'], 'full').lines).toEqual(['Nothing to split: your stem is the song, as it is.']);
  });

  test('two full mixes, or every file left out, can\'t be added', () => {
    expect(stemPlan(['mix', 'mix', 'drums'])).toMatchObject({ok: false, reason: COPY.twoMixes});
    expect(stemPlan(['skip', 'skip'])).toMatchObject({ok: false, reason: COPY.nothing});
  });

  test('the role menu', () => {
    expect(ROLES.map(r => r.label)).toEqual(['Full mix', 'Drums', 'Bass', 'Vocals', 'Guitar', 'Keys', 'Other', 'Leave out']);
  });

  test('the song title: the dropped folder, else what the names share, else the mix\'s name', () => {
    expect(songTitleFrom(['drums.ogg', 'bass.ogg'], ['Songs/Northbound - Glasshouse', 'Songs/Northbound - Glasshouse'])).toBe('Northbound - Glasshouse');
    expect(songTitleFrom(['Harbor Lights - drums.wav', 'Harbor Lights - bass.wav', 'crowd.ogg'])).toBe('Harbor Lights');
    expect(songTitleFrom(['drums.ogg', 'bass.ogg', 'Glasshouse (full mix).wav'])).toBe('Glasshouse (full mix)');
    expect(songTitleFrom(['drums.ogg', 'bass.ogg'])).toBe(COPY.untitled);
  });
});
