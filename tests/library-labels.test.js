// src/library/song-labels.js (architecture §2.16, spec §2.2 and §2.4): the card's artist line, row 3's meta line,
// the Continue state line and relative times.
import {describe, expect, it} from 'vitest';
import {
  artistLabel, formatDuration, initialsOf, metaLine, minusMeLabel, practiceLine, practisedLine, ratePercent, relativeTime, spotLabel,
  stateLine,
} from '../src/library/song-labels.js';

// 2026-10-28 12:00 local time: relative times count calendar days in the local zone.
const NOW = new Date(2026, 9, 28, 12, 0, 0).getTime();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

describe('artistLabel', () => {
  it('is the artist, else the uploader', () => {
    expect(artistLabel({artist: 'Northbound', uploader: 'Channel'})).toBe('Northbound');
    expect(artistLabel({artist: '', uploader: 'BluesLessonsChannel'})).toBe('BluesLessonsChannel');
    expect(artistLabel({artist: '  ', uploader: ' Up '})).toBe('Up');
  });
  it('stays empty when the artist was deliberately cleared (locked)', () => {
    expect(artistLabel({artist: '', uploader: 'Channel', metadataLocks: ['artist']})).toBe('');
  });
  it('is empty without a song or names', () => {
    expect(artistLabel(null)).toBe('');
    expect(artistLabel({})).toBe('');
  });
});

describe('formatDuration', () => {
  it.each([[64, '1:04'], [0, '0:00'], [59.6, '1:00'], [3729, '1:02:09'], [563, '9:23']])('%s s → %s', (s, text) => {
    expect(formatDuration(s)).toBe(text);
  });
  it('is empty for a missing or negative duration', () => {
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(NaN)).toBe('');
    expect(formatDuration(-1)).toBe('');
  });
});

describe('metaLine', () => {
  const stems = n => Array.from({length: n}, (_, i) => ({name: `s${i}`, key: `k${i}`}));
  it('joins duration · Chart · Mapped · N spots · N stems with the stem count only when not 4', () => {
    expect(metaLine({duration: 64, hasChart: true, mapSummary: {real: true, sections: []}, practiceSummary: {spotCount: 2}, stems: stems(6)}))
      .toBe('1:04 · Chart · Mapped · 2 spots · 6 stems');
    expect(metaLine({duration: 90, hasChart: false, mapSummary: {real: false, sections: []}, stems: stems(4)})).toBe('1:30');
    expect(metaLine({duration: 233, stems: stems(2), practiceSummary: {spotCount: 1}})).toBe('3:53 · 1 spot · 2 stems');
  });
  it('drops what is missing', () => {
    expect(metaLine({stems: []})).toBe('');
    expect(metaLine(null)).toBe('');
  });
});

describe('practice and state lines', () => {
  const profile = {instruments: ['bass', 'drums'], primary: 'drums', openWithMyPart: 'in'};
  const song = {lastPracticedAt: NOW - DAY, practiceSummary: {loopLabel: 'Bridge loop', rate: 0.85, minusMe: true, spotCount: 0, spots: []}};

  it('reads "Bridge loop · 85% · Drums out · practised yesterday"', () => {
    expect(stateLine(song, NOW, {profile})).toBe('Bridge loop · 85% · Drums out · practised yesterday');
    expect(practiceLine(song, {profile})).toBe('Bridge loop · 85% · Drums out');
    expect(practisedLine(song, NOW)).toBe('practised yesterday');
  });
  it('names the primary instrument, else the first, else "My part out"', () => {
    expect(minusMeLabel({instruments: ['vocals'], primary: null})).toBe('Vocals out');
    expect(minusMeLabel({instruments: [], primary: null})).toBe('My part out');
    expect(minusMeLabel(null)).toBe('My part out');
    expect(practiceLine({practiceSummary: {rate: 1, minusMe: true}})).toBe('100% · My part out');
  });
  it('leaves out the loop and Minus me when absent, and the time when never practised', () => {
    expect(stateLine({lastPracticedAt: NOW - 3 * DAY, practiceSummary: {rate: 1, minusMe: false}}, NOW)).toBe('100% · practised 3 days ago');
    expect(stateLine({practiceSummary: {rate: 0.9}}, NOW)).toBe('90%');
    expect(stateLine({}, NOW)).toBe('');
  });
  it('ratePercent rounds and defaults to 100%', () => {
    expect(ratePercent(0.855)).toBe('86%');
    expect(ratePercent(0.25)).toBe('25%');
    expect(ratePercent(undefined)).toBe('100%');
  });
});

describe('relativeTime', () => {
  it.each([
    [NOW - 20_000, 'just now'],
    [NOW + 5 * MIN, 'just now'],
    [NOW - 5 * MIN, '5 min ago'],
    [NOW - HOUR, '1 hour ago'],
    [NOW - 3 * HOUR, '3 hours ago'],
    [NOW - 13 * HOUR, 'yesterday'],
    [NOW - DAY, 'yesterday'],
    [NOW - 2 * DAY, '2 days ago'],
    [NOW - 6 * DAY, '6 days ago'],
    [NOW - 8 * DAY, 'last week'],
    [NOW - 20 * DAY, '2 weeks ago'],
    [NOW - 40 * DAY, 'last month'],
    [NOW - 100 * DAY, '3 months ago'],
    [NOW - 400 * DAY, 'last year'],
    [NOW - 1000 * DAY, '2 years ago'],
  ])('%s → %s', (ms, text) => {
    expect(relativeTime(ms, NOW)).toBe(text);
  });
  it('is empty without a time', () => {
    expect(relativeTime(null, NOW)).toBe('');
    expect(relativeTime(NOW, undefined)).toBe('');
  });
});

describe('spot and group labels', () => {
  it('spotLabel', () => {
    expect(spotLabel({name: 'Bridge walk-up', rate: 0.85})).toBe('Bridge walk-up · 85%');
    expect(spotLabel({name: '', rate: 1})).toBe('Spot · 100%');
  });
  it('initialsOf', () => {
    expect(initialsOf('Early Demos')).toBe('ED');
    expect(initialsOf('northbound')).toBe('N');
    expect(initialsOf('“Quoted” name')).toBe('QN');
    expect(initialsOf('')).toBe('·');
  });
});
