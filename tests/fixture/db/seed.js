// Seed data for the fixture database (architecture §11.2, package FX1).
//
// `createSeed({fx, now})` returns a fresh, JSON-serialisable database whose
// tables mirror the 2.0 Convex schema (§6.2) with client-side ids:
//   user · settings (userSettings.settings, stored shape) · songs · songPractice
//   jobs · devices · devicePresence · setlists · notation · shares · demoToken
//   coverKeys · billing · meta
// The same switches and clock always give the same data (ids included), so
// captures and assertions are stable.
//
// What the seed covers (each row names its song or job):
//   rehearsal song (Appendix A)  glasshouse: 64 bars at 120 bpm, origin 'edited', 8 sections, 4 stems,
//                                a drum part, no saved practice; the profile is drums (primary)
//   v2 practice                  lowtide (spots, markers, chartAudio, click, trainer, loop by bars), lanterns
//   v1 practice rows             secondwind (full v1 with grid), cobblestone ({rate: 1}), metropolis ({rate, loop, tracks: []})
//   mapped (origin)              glasshouse 'edited', lowtide 'edited', lanterns 'imported', velvet 'detected'
//   unmapped                     jam03, counting, quiet (no tempo), shuffle (the 120 bpm placeholder map)
//   1.6–1.9 no-origin map        nightbus (with the 1.9 dual-write and click fields)
//   pre-1.6 tempo.map            cobblestone;  pre-1.6 tempo.detected: secondwind (with legacy click fields)
//   pickup map · 7/8 map         lowtide (one-beat pickup) · lanterns (2+2+3)
//   sectionSuggestion            velvet
//   recordingUnconfirmed         shuffle (an unconfirmed search);  needsReview: jam03 (untitled upload)
//   metadataSuggestion           counting (metadataStatus 'uncertain')
//   demo share                   demoToken → lanterns;  the share dialog's link: glasshouse
//   jobs                         every state: queued, upload, download, separate (ETA), finalize, beats (chained),
//                                sections, import, bot_check with retryAt, failed separation_failed, re-split,
//                                and done jobs including an unapplied user detection (nightbus)
//   devices                      dev1 online (busy), dev2 offline;  setlists: two;  pins: three
//
// Seed-affecting switches: fx-library=empty, fx-jobs=0, fx-billing=…, fx-auth=suspended|export_only,
// fx-devices=none|offline|online, fx-account=new (no stored account settings: first run).
import {emptyScore, fraction} from '../../../shared/notation.ts';
import {demoScore} from '../../fixtures/drum-score.js';

export const SEED_VERSION = 2;
export const SHARE_TOKEN = 'a3f1'.repeat(16);
export const DEMO_TOKEN = 'dec0'.repeat(16);
export const USER_ID = 'user1';
const DAY = 864e5, HOUR = 36e5, MIN = 6e4;

/** The switches that change the seed; a persisted db with another key is reseeded. */
export const SEED_SWITCHES = ['library', 'jobs', 'billing', 'auth', 'devices', 'account', 'now'];
export const seedKey = (fx = {}) => JSON.stringify(SEED_SWITCHES.map(k => fx[k] ?? null));

// ---- artwork ----------------------------------------------------------------
const svg = body => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">${body}</svg>`)}`;
export const COVERS = {
  weather: svg('<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2a4a"/><stop offset="1" stop-color="#e2725b"/></linearGradient></defs><rect width="300" height="300" fill="url(#g)"/><circle cx="150" cy="190" r="70" fill="#f6d27a"/><rect y="200" width="300" height="100" fill="#14203a"/><path d="M0 215h300M0 235h300M0 255h300" stroke="#f6d27a" stroke-opacity=".5" stroke-width="3"/><text x="20" y="40" font-family="Georgia" font-size="22" fill="#fff">NORTHBOUND</text>'),
  lanterns: svg('<rect width="300" height="300" fill="#2d1b33"/>' + [[70, 90], [160, 60], [230, 130], [110, 180], [200, 220]].map(([x, y]) => `<g transform="translate(${x} ${y})"><ellipse rx="26" ry="34" fill="#ff9f43"/><ellipse rx="16" ry="24" fill="#ffd28a"/></g>`).join('') + '<text x="150" y="285" text-anchor="middle" font-family="Helvetica" font-size="18" letter-spacing="4" fill="#ffd28a">MARISOL VEGA</text>'),
  crossings: svg('<rect width="300" height="300" fill="#e8e1cf"/><path d="M0 220 Q150 140 300 220V300H0Z" fill="#2f5d62"/><path d="M40 210 70 120h10l30 90" fill="none" stroke="#1f2a2c" stroke-width="6"/><rect x="40" y="120" width="220" height="8" fill="#1f2a2c"/><text x="150" y="60" text-anchor="middle" font-family="Georgia" font-style="italic" font-size="30" fill="#1f2a2c">Crossings</text>'),
  satellites: svg('<rect width="300" height="300" fill="#05070d"/>' + Array.from({length: 60}, (_, i) => `<circle cx="${(i * 97) % 300}" cy="${(i * 53) % 300}" r="${(i % 3) * .7 + .5}" fill="#fff"/>`).join('') + '<circle cx="150" cy="150" r="60" fill="none" stroke="#7fd1ff" stroke-width="2"/><ellipse cx="150" cy="150" rx="110" ry="28" fill="none" stroke="#7fd1ff" stroke-width="2" transform="rotate(-20 150 150)"/><circle cx="246" cy="118" r="7" fill="#7fd1ff"/>'),
  nightbus: svg('<rect width="300" height="300" fill="#0f3d3e"/><rect x="30" y="120" width="240" height="90" rx="14" fill="#f4c430"/><g fill="#0f3d3e">' + [50, 100, 150, 200].map(x => `<rect x="${x}" y="135" width="38" height="30" rx="4"/>`).join('') + '</g><circle cx="80" cy="215" r="16" fill="#111"/><circle cx="220" cy="215" r="16" fill="#111"/><text x="150" y="70" text-anchor="middle" font-family="Courier" font-weight="bold" font-size="28" fill="#f4c430">NIGHT BUS</text>'),
  harbor: svg('<rect width="300" height="300" fill="#a7c5eb"/><path d="M0 200h300v100H0z" fill="#3f6e9c"/><path d="M120 200 150 80l30 120z" fill="#fff"/><rect x="146" y="60" width="8" height="140" fill="#333"/>'),
};

// ---- song maps ----------------------------------------------------------------
const round = (n, digits = 4) => +n.toFixed(digits);
const pad = i => String(i + 1).padStart(2, '0');

/**
 * A song map in the stored `SongMapData` shape (shared/song-map.ts) with
 * deterministic measure ids `<prefix>-mNN`, covering `duration`.
 *   qpm: quarter notes per minute; firstDownbeat: time of bar 1's downbeat
 *   pickup: quarter notes in a short first bar before it (0 = none)
 *   labels: {measureIndex: label}; origin: stamped when given (2.0 saves)
 *   pins: 'ends' (first and last bar), 'one' (the placeholder), or a number N (every N bars)
 */
export function buildMap({prefix, duration, qpm, numerator = 4, denominator = 4, grouping, firstDownbeat = 0, pickup = 0, labels = {}, origin, pins = 'ends', tailQpm}) {
  const spq = 60 / qpm, barQ = 4 * numerator / denominator, start = round(firstDownbeat - pickup * spq);
  if (start < 0) throw new Error(`${prefix}: the pickup starts before 0 s`);
  const full = Math.ceil((duration - firstDownbeat) / (barQ * spq) - 1e-9);
  const lengths = [...(pickup ? [pickup] : []), ...Array(full).fill(barQ)];
  const measures = [], starts = [];
  let q = 0;
  lengths.forEach((len, i) => {
    starts.push(q);
    const length = len === barQ ? fraction(4 * numerator, denominator) : fraction(Math.round(len * 1e6), 1e6);
    measures.push({id: `${prefix}-m${pad(i)}`, numerator, denominator, length, label: labels[i] ?? '', ...(grouping ? {grouping: [...grouping]} : {})});
    q += len;
  });
  const pinAt = i => ({position: fraction(Math.round(starts[i] * 1e6), 1e6), time: round(start + starts[i] * spq)});
  let pinList;
  if (pins === 'one') pinList = [pinAt(0)];
  else if (pins === 'ends') pinList = [pinAt(0), pinAt(measures.length - 1)];
  else { pinList = []; for (let i = 0; i < measures.length; i += pins) pinList.push(pinAt(i)); if (pinList.length < 2) pinList.push(pinAt(measures.length - 1)); }
  const songMap = {version: 1, measures, pins: pinList, ...(tailQpm ? {tailQpm} : {}), ...(origin ? {origin} : {})};
  const timeOf = i => round(start + starts[i] * spq);
  const groups = grouping ?? (denominator === 8 && [6, 9, 12].includes(numerator) ? Array(numerator / 3).fill(3) : Array(numerator).fill(1));
  const pulse = groups.every(g => g === groups[0]) ? groups[0] * 4 / denominator : 4 / denominator;
  const sections = measures.map((m, i) => [m.label, i]).filter(([label]) => label && label !== 'Pickup').map(([label]) => label);
  return {songMap, timeOf, bars: measures.length, bpm: Math.round(qpm / pulse), meter: `${numerator}/${denominator}`, sections};
}

/** The 1.9 detected-beat list that rode along every save (`metronome.serialize`). */
function beatList(bpm, offset, seconds, beatsPerBar = 4, limit = Infinity) {
  const out = [];
  for (let t = offset, i = 0; t < seconds - .2 && i < limit; t += 60 / bpm, i++) out.push({time: round(t), downbeat: i % beatsPerBar === 0});
  return out;
}

// ---- the rehearsal song (Appendix A) -------------------------------------------
export const REHEARSAL = {
  id: 'glasshouse', bars: 64, bpm: 120, duration: 128,
  sections: [['Intro', 0, 'intro'], ['Verse', 4, 'verse'], ['Chorus', 12, 'chorus'], ['Verse 2', 20, 'verse'],
    ['Chorus 2', 28, 'chorus'], ['Bridge', 36, 'bridge'], ['Chorus 3', 44, 'chorus'], ['Outro', 56, 'outro']],
};

/** demoScore(64, 120) has 32 bars: intro 0–3, verse 4–11, chorus 12–19, outro 20–31 (31 ends it). */
const SOURCE_BARS = {intro: [0, 4], verse: [4, 12], chorus: [12, 20], bridge: [20, 28], outro: [20, 32]};

/** The rehearsal song's drum part: the demo grooves laid out over its 8 sections, on its map's measures. */
function rehearsalScore(map) {
  const demo = demoScore(64, 120), sourceBars = demo.bars;
  const base = emptyScore(REHEARSAL.duration, REHEARSAL.bpm);
  const timeline = {version: 1, measures: map.songMap.measures.map(m => ({...structuredClone(m)})), anchors: base.timeline.anchors};
  const bounds = REHEARSAL.sections.map(([, at], i) => [at, REHEARSAL.sections[i + 1]?.[1] ?? REHEARSAL.bars]);
  const bars = [];
  REHEARSAL.sections.forEach(([, at, kind], s) => {
    const [from, to] = SOURCE_BARS[kind], [b0, b1] = bounds[s];
    for (let bar = b0; bar < b1; bar++) {
      const last = bar === REHEARSAL.bars - 1;
      const source = sourceBars[last ? 31 : from + ((bar - b0) % (to - from - (kind === 'outro' ? 1 : 0)))];
      const measureId = timeline.measures[bar].id;
      bars.push({measureId, coverage: source.coverage, hits: source.hits.map((h, j) => ({...structuredClone(h), id: `${measureId}-h${String(j + 1).padStart(2, '0')}`}))});
    }
  });
  return {version: 2, title: 'Drums', timeline, bars};
}

// ---- rows ------------------------------------------------------------------------
const stemsOf = (id, names, duration) => names.map(name => ({name, key: `${id}/${name}`, bytes: Math.round(duration * 20_000), mime: 'audio/ogg; codecs=opus'}));
const FOUR = ['drums', 'bass', 'vocals', 'other'], SIX = ['drums', 'bass', 'vocals', 'guitar', 'piano', 'other'];
const QUALITY = {model: 'htdemucs_ft', shifts: 2, overlap: .25, format: 'opus', bitrate: 160};
const BLANK = {albumArtist: '', year: '', genre: '', trackNumber: '', discNumber: '', musicalKey: '', tuning: '', tags: [], notes: '', metadataLocks: [], metadataStatus: 'done', metadataRecordingId: null, metadataReleaseId: null, artwork: null, coverUrl: null, uploader: '', artist: '', album: '', source: null, coverKey: null, stemMode: 'full', quality: QUALITY, tempo: null};
function song(s) {
  const row = {...structuredClone(BLANK), ...s, stems: s.stems || stemsOf(s.id, FOUR, s.duration)};
  row.hasChart ??= false;
  return row;
}
const mapSummary = map => ({real: true, bpm: map.bpm, meter: map.meter, sections: map.sections.slice(0, 64)});
const bar = (map, i, beat = 0) => ({id: map.songMap.measures[i].id, beat});

const SETTINGS = {preset: 'balanced', stemMode: 'full', model: 'htdemucs_ft'};
const JOB_SETTINGS = {preset: 'balanced', stemMode: 'full', format: 'opus', bitrate: 160, custom: {model: 'htdemucs_ft', shifts: 2, overlap: .25}};

export function createSeed({fx = {}, now = Date.now()} = {}) {
  const ago = ms => now - ms;
  const emptyLibrary = fx.library === 'empty';

  // Maps --------------------------------------------------------------------------
  const ghMap = buildMap({prefix: 'gh', duration: REHEARSAL.duration, qpm: REHEARSAL.bpm, origin: 'edited',
    labels: Object.fromEntries(REHEARSAL.sections.map(([label, at]) => [at, label]))});
  const ltMap = buildMap({prefix: 'lt', duration: 92, qpm: 104, pickup: 1, firstDownbeat: round(.5 + 60 / 104), origin: 'edited',
    labels: {1: 'Verse', 9: 'Chorus', 17: 'Verse 2', 25: 'Chorus 2', 33: 'Outro'}});
  const lnMap = buildMap({prefix: 'ln', duration: 75, qpm: 92, numerator: 7, denominator: 8, grouping: [2, 2, 3], firstDownbeat: .3, origin: 'imported'});
  const vaMap = buildMap({prefix: 'va', duration: 244, qpm: 100, firstDownbeat: .22, origin: 'detected', pins: 4});
  // 1.6–1.9: a hand-edited map saved without `origin`, with the dual-write noise and click fields.
  const nbMap = buildMap({prefix: 'nb', duration: 233, qpm: 86, firstDownbeat: .4, labels: {0: 'Pickup', 8: 'Chorus', 24: 'Verse 2', 32: 'Chorus 2'}});
  // The 120 bpm placeholder every 1.9 song got before anyone mapped it.
  const shMap = buildMap({prefix: 'sh', duration: 312, qpm: 120, pins: 'one', tailQpm: 120});
  const legacyClick = {accent: true, volume: .7, countIn: false, countInLength: 1, countInUnit: 'bars', audiblePreRoll: false, enabled: false};

  const glassScore = rehearsalScore(ghMap);

  // Practice ----------------------------------------------------------------------
  const spot = (id, name, map, i0, i1, rate, extra) => ({id, name, a: map.timeOf(i0), b: map.timeOf(i1), aBar: bar(map, i0), bBar: bar(map, i1), rate, passes: 0, updatedAt: ago(2 * DAY), ...extra});
  const lowtidePractice = {
    v: 2, lastAt: ago(DAY), cue: ltMap.timeOf(9), surface: 'roadmap', anchorBar: 9, anchorTime: ltMap.timeOf(9),
    rate: .9, lastRate: 1, keepPitch: true,
    loop: {on: true, a: ltMap.timeOf(9), b: ltMap.timeOf(17), aBar: bar(ltMap, 9), bBar: bar(ltMap, 17), eachPassCount: true, playTimes: 0, between: 'none'},
    tracks: [{name: 'drums', volume: 1, muted: true, soloed: false}, {name: 'bass', volume: .8, muted: false, soloed: false}, {name: 'vocals', volume: 1, muted: false, soloed: false}, {name: 'other', volume: .6, muted: false, soloed: false}],
    minusMe: true, onlyMe: false, chartAudio: 'quiet',
    click: {countIn: {on: true, length: 1, unit: 'bars'}, mode: 'always', lastMode: 'countin', accent: true, volume: .6, preRoll: false},
    trainer: {start: .7, end: 1, step: .05, passes: 2},
    spots: [
      spot('sp-lt-1', 'Chorus fill', ltMap, 15, 17, .8, {note: 'Lead with the left hand into the crash.', lastAt: ago(DAY), passes: 14, updatedAt: ago(DAY)}),
      spot('sp-lt-2', 'Verse groove', ltMap, 1, 5, .9, {lastAt: ago(3 * DAY), passes: 6, updatedAt: ago(3 * DAY)}),
      spot('sp-lt-3', 'Outro tag', ltMap, 33, 37, 1, {lastAt: ago(5 * DAY), passes: 2, updatedAt: ago(5 * DAY)}),
      spot('sp-lt-4', 'Old intro idea', ltMap, 0, 2, 1, {deleted: true, updatedAt: ago(4 * DAY)}),
    ],
    markers: [
      {id: 'mk-lt-1', t: 31.2, label: 'Snare roll', updatedAt: ago(2 * DAY)},
      {id: 'mk-lt-2', t: 58.6, label: 'Marker 2', updatedAt: ago(2 * DAY)},
      {id: 'mk-lt-3', t: 70, label: 'Cut', deleted: true, updatedAt: ago(DAY)},
    ],
  };
  const lanternsPractice = {
    v: 2, lastAt: ago(3 * DAY), cue: 12.4, surface: 'stems', rate: 1,
    loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none'},
    tracks: [{name: 'guitar', volume: .7, muted: false, soloed: true}], minusMe: false, chartAudio: 'off', trainer: null, spots: [],
    markers: [{id: 'mk-ln-1', t: 12.4, label: 'Guitar enters', updatedAt: ago(3 * DAY)}, {id: 'mk-ln-2', t: 40, label: 'Marker 2', updatedAt: ago(3 * DAY)}],
  };

  // Songs -------------------------------------------------------------------------
  const songs = emptyLibrary ? [] : [
    song({id: 'glasshouse', title: 'Glasshouse', artist: 'Northbound', album: 'Weather Systems', albumArtist: 'Northbound', year: '2021', genre: 'Indie rock', trackNumber: '3', musicalKey: 'A minor', tuning: 'Standard', tags: ['drums', 'setlist'], notes: 'Watch the flam into the chorus. Ride bell on the triplet section.',
      duration: REHEARSAL.duration, bpm: REHEARSAL.bpm, coverKey: 'covers/weather.png', source: {type: 'url', value: 'https://www.youtube.com/watch?v=fixture01'}, resolvedUrl: 'https://www.youtube.com/watch?v=fixture01', provider: 'Youtube', addedAt: ago(2 * DAY),
      tempo: {songMap: ghMap.songMap}, tempoRev: 3, mapSummary: mapSummary(ghMap), hasChart: true, metadataStatus: 'matched'}),
    song({id: 'lowtide', title: 'Low Tide Static', artist: 'Northbound', album: 'Weather Systems', year: '2021', genre: 'Indie rock', trackNumber: '7', duration: 92, bpm: 104, offset: .5, coverKey: 'covers/weather.png', source: {type: 'url', value: 'https://www.youtube.com/watch?v=fixture02'}, addedAt: ago(3 * DAY),
      tempo: {songMap: ltMap.songMap}, tempoRev: 5, mapSummary: mapSummary(ltMap), lastPracticedAt: lowtidePractice.lastAt,
      practiceSummary: {loopLabel: 'Chorus loop', rate: .9, minusMe: true, surface: 'roadmap', spotCount: 3, spots: [{id: 'sp-lt-1', name: 'Chorus fill', rate: .8}, {id: 'sp-lt-2', name: 'Verse groove', rate: .9}, {id: 'sp-lt-3', name: 'Outro tag', rate: 1}]}}),
    song({id: 'lanterns', title: 'Paper Lanterns', artist: 'Marisol Vega', album: 'Paper Lanterns', year: '2023', genre: 'Pop', musicalKey: 'E major', duration: 75, bpm: 92, offset: .3, stems: stemsOf('lanterns', SIX, 75), quality: {model: 'htdemucs_6s', shifts: 1, overlap: .25, format: 'opus', bitrate: 192}, coverUrl: COVERS.lanterns, artwork: {kind: 'upload', key: 'artwork/lanterns.png'}, source: {type: 'spotify', value: 'https://open.spotify.com/track/fixture'}, addedAt: ago(5 * DAY),
      tempo: {songMap: lnMap.songMap}, tempoRev: 1, mapSummary: mapSummary(lnMap), lastPracticedAt: lanternsPractice.lastAt,
      practiceSummary: {rate: 1, minusMe: false, surface: 'stems', spotCount: 0, spots: []}}),
    song({id: 'secondwind', title: 'Second Wind', artist: 'The Ferry Hours', album: 'Crossings', year: '2019', genre: 'Folk rock', tags: ['bass', 'audition'], notes: 'Bridge walk-up at 0:48 — slow loop until clean.', duration: 90, bpm: 96, offset: .5, coverKey: 'covers/crossings.png', source: {type: 'url', value: 'https://www.youtube.com/watch?v=fixture04'}, addedAt: ago(8 * DAY),
      // pre-1.6 detected beats, with the click settings 1.x kept inside tempo (D51)
      tempo: {source: 'detected', detected: beatList(96, .5, 90), map: [], accent: false, volume: .8, countIn: true, countInLength: 2, countInUnit: 'bars', audiblePreRoll: true, enabled: false},
      practice: {rate: .85, loop: {enabled: true, a: 30.5, b: 40.5}, grid: {visible: true, snap: true, division: 2}, tracks: [{name: 'vocals', volume: .6, muted: true, soloed: false}, {name: 'bass', volume: 1, muted: false, soloed: false}]}}),
    song({id: 'cobblestone', title: 'Cobblestone', artist: 'The Ferry Hours', album: 'Crossings', year: '2019', duration: 201, bpm: 88, offset: .4, addedAt: ago(9 * DAY),
      // pre-1.6 manual sections: 88 bpm in 4, then 92 bpm in 3
      tempo: {source: 'map', map: [{t: .4, bpm: 88, beatsPerBar: 4, unit: 4}, {t: 120.4, bpm: 92, beatsPerBar: 3, unit: 4}], detected: [], ...legacyClick},
      practice: {rate: 1}}),
    song({id: 'nightbus', title: 'Night Bus', artist: 'Kito & the Late Shift', duration: 233, bpm: 86, offset: .4, stems: stemsOf('nightbus', ['vocals', 'no_vocals'], 233), stemMode: 'vocals', coverKey: 'covers/nightbus.png', addedAt: ago(12 * DAY),
      tempo: {...legacyClick, songMap: nbMap.songMap, source: 'detected', map: [], detected: beatList(86, .4, 233, 4, 64)}}),
    song({id: 'jam03', title: 'untitled_jam_03.wav', duration: 148, source: {type: 'upload', value: 'local1', filename: 'untitled_jam_03.wav'}, metadataStatus: 'none', needsReview: true, originDeviceId: 'dev1', addedAt: ago(14 * DAY)}),
    song({id: 'shuffle', title: 'Sunday Shuffle (Blues Backing Track in A)', uploader: 'BluesLessonsChannel', duration: 312, genre: 'Blues', tags: ['backing track', 'warmup'], source: {type: 'search', value: 'sunday shuffle blues backing track in a'}, resolvedUrl: 'https://www.youtube.com/watch?v=fixture08', provider: 'Youtube', recordingUnconfirmed: true, addedAt: ago(20 * DAY),
      tempo: {...legacyClick, songMap: shMap.songMap, source: 'detected', map: [], detected: beatList(120, 0, 312, 4, 32)}}),
    song({id: 'velvet', title: 'Velvet Arc', artist: 'Marisol Vega', album: 'Satellites', year: '2020', duration: 244, bpm: 100, offset: .22, coverKey: 'covers/satellites.png', addedAt: ago(22 * DAY),
      tempo: {songMap: vaMap.songMap}, tempoRev: 1, mapSummary: mapSummary(vaMap),
      sectionSuggestion: {jobId: 'job-beats-velvet', createdAt: ago(21 * DAY), sections: [
        {t0: vaMap.timeOf(0), label: 'Intro', confidence: .62}, {t0: vaMap.timeOf(8), label: 'Verse', confidence: .71}, {t0: vaMap.timeOf(24), label: 'Chorus', confidence: .83},
        {t0: vaMap.timeOf(40), label: 'Verse', confidence: .69}, {t0: vaMap.timeOf(56), label: 'Chorus', confidence: .8}, {t0: vaMap.timeOf(72), label: 'Bridge', confidence: .48},
        {t0: vaMap.timeOf(80), label: 'Chorus', confidence: .77}, {t0: vaMap.timeOf(96), label: 'Outro', confidence: .58}]}}),
    song({id: 'counting', title: 'Counting Stars Backwards', artist: 'Ada Moreno', album: 'Harbor Lights', duration: 187, coverUrl: COVERS.harbor, addedAt: ago(30 * DAY), metadataStatus: 'uncertain',
      metadataSuggestion: {recordingId: 'b6a1c0de-0000-4000-8000-00000000c0de', releaseId: 'c0ffee00-0000-4000-8000-00000000beef', title: 'Counting Stars Backwards', artist: 'Ada Moreno', album: 'Harbor Lights', year: '2017', duration: 186}}),
    song({id: 'metropolis', title: 'Metropolis Pt. II (Live)', artist: 'Glass Animals of Ohio', album: 'Live at the Grange, Vol. 2 — Deluxe Anniversary Edition', year: '2018', duration: 563, addedAt: ago(40 * DAY), metadataStatus: 'pending',
      practice: {rate: 1, loop: {enabled: false, a: 0, b: 0}, tracks: []}}),
    song({id: 'quiet', title: 'Quiet Hours', artist: 'Northbound', album: 'Early Demos', duration: 176, addedAt: ago(50 * DAY)}),
  ];
  const has = id => songs.some(s => s.id === id);

  const songPractice = [
    ['lowtide', lowtidePractice], ['lanterns', lanternsPractice],
  ].filter(([id]) => has(id)).map(([songId, practice]) => ({songId, userId: USER_ID, practice, updatedAt: practice.lastAt}));

  // Devices -----------------------------------------------------------------------
  const devicesMode = fx.devices || 'mixed';
  const devices = devicesMode === 'none' ? [] : [
    {id: 'dev1', userId: USER_ID, name: 'Kyle’s MacBook Pro', displayName: 'Studio MacBook', revoked: false, createdAt: ago(200 * DAY)},
    {id: 'dev2', userId: USER_ID, name: 'DESKTOP-4F2K9', revoked: false, createdAt: ago(90 * DAY)},
  ];
  const online = id => devicesMode === 'online' || (devicesMode === 'mixed' && id === 'dev1');
  const devicePresence = devices.map(d => d.id === 'dev1'
    ? {deviceId: 'dev1', userId: USER_ID, lastSeenAt: online('dev1') ? ago(20e3) : ago(2 * HOUR), state: online('dev1') ? 'busy' : 'offline', ...(online('dev1') ? {currentJobId: 'job-run'} : {}), appVersion: '2.0.0', platform: 'darwin-arm64', accelerator: 'Apple GPU'}
    : {deviceId: 'dev2', userId: USER_ID, lastSeenAt: online('dev2') ? ago(30e3) : ago(3 * DAY), state: online('dev2') ? 'idle' : 'offline', appVersion: '1.9.0', platform: 'win32-x64', accelerator: 'NVIDIA GPU'});
  const deviceFor = id => (devices.some(d => d.id === id) ? id : undefined);

  // Jobs --------------------------------------------------------------------------
  const job = ({deviceId = 'dev1', createdAt, ...rest}) => {
    const row = {kind: 'separate', status: 'running', stage: 'queued', percent: 0, attempts: 0, settings: JOB_SETTINGS, settingsSummary: SETTINGS, ...rest, createdAt, updatedAt: rest.updatedAt ?? Math.max(createdAt, rest.startedAt ?? 0)};
    const device = deviceFor(deviceId);
    if (device) row.deviceId = device;
    return row;
  };
  const url = value => ({type: 'url', value});
  const activeJobs = [
    job({jobId: 'job-run', stage: 'separate', percent: 46, message: 'Separating stems… (Apple GPU, pass 2/4)', label: 'Harbor Lights — Ada Moreno', source: url('https://www.youtube.com/watch?v=harbor01'), confirmed: true, attempts: 1, createdAt: ago(4 * MIN), startedAt: ago(102e3), meta: {title: 'Harbor Lights', artist: 'Ada Moreno', channel: 'Ada Moreno', album: 'Harbor Lights', duration: 204, coverKey: 'covers/harbor.png'}}),
    job({jobId: 'job-dl', stage: 'download', percent: 12, message: 'Downloading audio…', label: 'https://www.youtube.com/watch?v=lighthouse', source: url('https://www.youtube.com/watch?v=lighthouse'), confirmed: true, attempts: 1, createdAt: ago(3 * MIN), startedAt: ago(40e3), meta: {title: 'Lighthouse Keeper', uploader: 'The Tidewater Collective', channel: 'The Tidewater Collective', duration: 241}}),
    job({jobId: 'job-up', stage: 'download', percent: 40, message: 'Converting to WAV…', label: 'rehearsal-2026-10-12.wav', source: {type: 'upload', value: 'up-7f3a', filename: 'rehearsal-2026-10-12.wav'}, attempts: 1, createdAt: ago(2 * MIN), startedAt: ago(15e3), meta: {title: 'rehearsal-2026-10-12.wav'}}),
    job({jobId: 'job-fin', stage: 'finalize', percent: 90, message: 'Encoding sync copies locally…', label: 'Tin Roof Rain — Northbound', source: url('https://www.youtube.com/watch?v=tinroof'), confirmed: true, attempts: 1, createdAt: ago(9 * MIN), startedAt: ago(6 * MIN), meta: {title: 'Tin Roof Rain', artist: 'Northbound', channel: 'Northbound', duration: 198}}),
    job({jobId: 'job-q', status: 'queued', stage: 'queued', label: 'marisol vega satellites live', source: {type: 'search', value: 'marisol vega satellites live'}, confirmed: false, createdAt: ago(MIN)}),
    job({jobId: 'job-q2', status: 'queued', stage: 'queued', deviceId: 'dev2', label: 'https://soundcloud.com/ferryhours/undertow-demo', source: url('https://soundcloud.com/ferryhours/undertow-demo'), confirmed: true, createdAt: ago(50e3)}),
    job({jobId: 'job-beats', kind: 'beats', stage: 'detect', percent: 50, message: 'Finding bars…', songId: 'quiet', chainedFrom: 'job-done-quiet', label: 'Finding bars — Quiet Hours', settings: {sections: true}, settingsSummary: undefined, attempts: 1, createdAt: ago(6 * MIN), startedAt: ago(70e3)}),
    job({jobId: 'job-sections', kind: 'sections', stage: 'detect', percent: 30, message: 'Suggesting sections…', songId: 'lanterns', label: 'Finding sections — Paper Lanterns', settings: {}, settingsSummary: undefined, attempts: 1, createdAt: ago(5 * MIN), startedAt: ago(30e3)}),
    job({jobId: 'job-import', kind: 'import', stage: 'finalize', percent: 60, message: 'Copying files…', label: 'Old Friends', importMeta: {id: 'legacy-17', tempo: {map: [{t: 0, bpm: 101, beatsPerBar: 4, unit: 4}]}, practice: {rate: 1}}, settingsSummary: undefined, attempts: 1, createdAt: ago(7 * MIN), startedAt: ago(90e3)}),
    job({jobId: 'job-bot', status: 'error', stage: 'download', label: 'https://www.youtube.com/watch?v=blocked123', source: url('https://www.youtube.com/watch?v=blocked123'), confirmed: true, meta: {title: 'Undertow'}, errorCode: 'bot_check', retryAt: now + 5 * MIN, attempts: 1, createdAt: ago(20 * MIN), startedAt: ago(19 * MIN), updatedAt: ago(18 * MIN),
      error: 'ERROR: [youtube] blocked123: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.\nyt-dlp exited with code 1'}),
    job({jobId: 'job-fail', status: 'error', stage: 'separate', label: 'Paper Boats — Marisol Vega', source: url('https://www.youtube.com/watch?v=paperboats'), confirmed: true, meta: {title: 'Paper Boats', artist: 'Marisol Vega', duration: 222}, errorCode: 'separation_failed', attempts: 1, createdAt: ago(40 * MIN), startedAt: ago(39 * MIN), updatedAt: ago(35 * MIN),
      error: 'RuntimeError: separation stopped: the model returned no audio for pass 3/4\nseparator exited with code 1'}),
    job({jobId: 'job-re', stage: 'separate', percent: 71, message: 'Separating stems… (Apple GPU, pass 3/4)', songId: 'counting', label: 'Counting Stars Backwards (re-split)', source: url('https://www.youtube.com/watch?v=counting'), confirmed: true, attempts: 1, createdAt: ago(8 * MIN), startedAt: ago(5 * MIN)}),
  ];
  const doneJobs = [
    job({jobId: 'job-done-quiet', status: 'done', stage: 'done', percent: 100, songId: 'quiet', label: 'Quiet Hours — Northbound', source: url('https://www.youtube.com/watch?v=quiet'), confirmed: true, attempts: 1, createdAt: ago(10 * MIN), startedAt: ago(10 * MIN), updatedAt: ago(6 * MIN)}),
    job({jobId: 'job-done-velvet', status: 'done', stage: 'done', percent: 100, songId: 'velvet', label: 'Velvet Arc — Marisol Vega', source: url('https://www.youtube.com/watch?v=velvetarc'), confirmed: true, attempts: 1, createdAt: ago(21 * DAY + 10 * MIN), startedAt: ago(21 * DAY + 10 * MIN), updatedAt: ago(21 * DAY + MIN)}),
    job({jobId: 'job-beats-velvet', kind: 'beats', status: 'done', stage: 'detect', percent: 100, songId: 'velvet', chainedFrom: 'job-done-velvet', label: 'Finding bars — Velvet Arc', settings: {sections: true}, settingsSummary: undefined, attempts: 1, createdAt: ago(21 * DAY), startedAt: ago(21 * DAY), updatedAt: ago(21 * DAY),
      result: {beats: beatList(100, .22, 244, 4, 16).map((b, i) => [b.time, i % 4 + 1]), sections: []}}),
    // A detection the user started on a mapped song and has not applied yet (D44: "Bars found while you were away").
    job({jobId: 'job-detect-nightbus', kind: 'beats', status: 'done', stage: 'detect', percent: 100, songId: 'nightbus', label: 'Finding bars — Night Bus', settings: {sections: false}, settingsSummary: undefined, attempts: 1, createdAt: ago(3 * HOUR), startedAt: ago(3 * HOUR), updatedAt: ago(3 * HOUR) + 40e3,
      result: {beats: beatList(86.2, .41, 233).map((b, i) => [b.time, i % 4 + 1]), sections: []}}),
  ];
  const jobs = emptyLibrary ? [] : [...(fx.jobs === '0' ? [] : activeJobs), ...doneJobs].map(j => {
    // Drop the keys a helper left undefined, so the seed survives a JSON round trip unchanged.
    for (const k of Object.keys(j)) if (j[k] === undefined) delete j[k];
    return j;
  });

  // Account ---------------------------------------------------------------------------
  const settings = fx.account === 'new' ? null : {
    preset: 'balanced', stemMode: 'full', format: 'opus', bitrate: 160, custom: {model: 'htdemucs_ft', shifts: 2, overlap: .25},
    autoBeats: true, autoSections: true, notifyReady: true,
    profile: {instruments: ['drums', 'bass'], primary: 'drums', openWithMyPart: 'in'},
    pins: ['glasshouse', 'lowtide', 'nightbus'].filter(has),
    onboarding: {whatDoYouPlay: 'done', coach: 15, desktopFirstRun: true},
    practice: {stop: 'cue', countIn: {on: false, length: 1, unit: 'bars'}, click: 'countin', eachPassCount: true, keepPitch: true, wake: 10},
  };
  const setlists = emptyLibrary ? [] : [
    {id: 'set-friday', userId: USER_ID, name: 'Friday at the Grange', songIds: ['glasshouse', 'lowtide', 'secondwind', 'nightbus', 'velvet'], createdAt: ago(10 * DAY), updatedAt: ago(DAY), lastOpenedAt: ago(DAY)},
    {id: 'set-warmup', userId: USER_ID, name: 'Warm-ups', songIds: ['shuffle', 'quiet'], createdAt: ago(30 * DAY), updatedAt: ago(12 * DAY)},
  ];
  const status = fx.auth === 'suspended' ? 'suspended' : fx.auth === 'export_only' ? 'export_only' : 'active';

  const billing = {enabled: fx.billing !== 'disabled', access: 'free', status: null, interval: null, periodEnd: null, cancelAtPeriodEnd: false, graceEndsAt: null, hasCustomer: false, cleanupPending: false, usedBytes: 412e6, limitBytes: 1e9, freeBytes: 1e9, proBytes: 25e9, monthlyCents: 200, annualCents: 2000};
  if (fx.billing === 'plus') Object.assign(billing, {access: 'paid', status: 'active', interval: 'year', periodEnd: now + 200 * DAY, hasCustomer: true, usedBytes: 3.8e9, limitBytes: 25e9});
  if (fx.billing === 'cancel') Object.assign(billing, {access: 'paid', status: 'active', interval: 'month', periodEnd: now + 12 * DAY, cancelAtPeriodEnd: true, hasCustomer: true, usedBytes: 3.8e9, limitBytes: 25e9});
  if (fx.billing === 'grace') Object.assign(billing, {access: 'grace', status: 'canceled', graceEndsAt: now + 9 * DAY, hasCustomer: true, usedBytes: 3.8e9, limitBytes: 1e9});

  const shares = {};
  if (has('glasshouse')) shares.glasshouse = {token: SHARE_TOKEN, includeNotation: true, createdAt: ago(DAY)};
  if (has('lanterns')) shares.lanterns = {token: DEMO_TOKEN, includeNotation: false, createdAt: ago(60 * DAY)};

  return {
    meta: {seedVersion: SEED_VERSION, seededAt: now},
    user: {_id: USER_ID, name: 'Kyle Kincer', email: 'kyle@example.com', picture: null, status},
    settings,
    songs, songPractice, jobs, devices, devicePresence, setlists,
    notation: has('glasshouse') ? {glasshouse: {score: glassScore, revision: 3}} : {},
    shares,
    demoToken: has('lanterns') ? DEMO_TOKEN : null,
    coverKeys: {'covers/weather.png': COVERS.weather, 'covers/crossings.png': COVERS.crossings, 'covers/satellites.png': COVERS.satellites, 'covers/nightbus.png': COVERS.nightbus, 'covers/harbor.png': COVERS.harbor},
    billing,
  };
}
