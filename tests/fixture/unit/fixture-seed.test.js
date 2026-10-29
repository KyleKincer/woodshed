// @vitest-environment node
// Seed v2 (architecture §9.2 FX1 "Seed adds", Appendix A): every required
// case exists, rows are consistent with each other and with the 2.0 schema,
// maps validate, and the seed is deterministic and JSON-serialisable.
import {describe, it, expect} from 'vitest';
import {createSeed, seedKey, buildMap, REHEARSAL, SHARE_TOKEN, DEMO_TOKEN, SEED_SWITCHES, USER_ID} from '../db/seed.js';
import {cleanSongMap, validateSongMap, compile, timeAt} from '../../../shared/song-map.ts';
import {number, beatGroups} from '../../../shared/notation.ts';
import schema from '../../../convex/schema.ts';

const NOW = Date.parse('2026-10-28T09:00:00Z');
const seed = createSeed({now: NOW});
const song = id => seed.songs.find(s => s.id === id);
const practiceOf = id => seed.songPractice.find(p => p.songId === id)?.practice;
const PRACTICE_CAP = 32_768;

/** Problems with `value` against a convex/values validator (the kinds convex/schema.ts uses). */
function schemaProblems(v, value, path, out = []) {
  if (value === undefined) { if (v.isOptional !== 'optional') out.push(`${path}: missing`); return out; }
  const bad = what => out.push(`${path}: ${JSON.stringify(value)?.slice(0, 60)} is not ${what}`);
  switch (v.kind) {
    case 'any': break;
    case 'string': case 'id': if (typeof value !== 'string') bad('a string'); break;
    case 'float64': if (typeof value !== 'number') bad('a number'); break;
    case 'boolean': if (typeof value !== 'boolean') bad('a boolean'); break;
    case 'null': if (value !== null) bad('null'); break;
    case 'literal': if (value !== v.value) bad(JSON.stringify(v.value)); break;
    case 'array': if (!Array.isArray(value)) bad('an array'); else value.forEach((e, i) => schemaProblems(v.element, e, `${path}[${i}]`, out)); break;
    case 'record': if (!value || typeof value !== 'object') bad('a record'); else for (const [k, e] of Object.entries(value)) schemaProblems(v.value, e, `${path}.${k}`, out); break;
    case 'object':
      if (!value || typeof value !== 'object' || Array.isArray(value)) { bad('an object'); break; }
      for (const [k, f] of Object.entries(v.fields)) schemaProblems(f, value[k], `${path}.${k}`, out);
      for (const k of Object.keys(value)) if (!(k in v.fields)) out.push(`${path}.${k}: not in the schema`);
      break;
    case 'union': if (!v.members.some(m => !schemaProblems(m, value, path).length)) bad('any member of the union'); break;
    default: out.push(`${path}: unchecked validator kind ${v.kind}`);
  }
  return out;
}

describe('the rehearsal song (Appendix A)', () => {
  const gh = song('glasshouse');
  it('is mapped (origin edited), 64 bars at 120 bpm, with the eight sections', () => {
    const map = gh.tempo.songMap;
    expect(map.origin).toBe('edited');
    expect(map.measures).toHaveLength(64);
    const c = compile(map);
    expect(c.spans[0].v0 * 60).toBeCloseTo(120, 9);
    expect(timeAt(c, 4 * 64)).toBeCloseTo(128, 9);
    expect(map.measures.filter(m => m.label).map(m => m.label)).toEqual(['Intro', 'Verse', 'Chorus', 'Verse 2', 'Chorus 2', 'Bridge', 'Chorus 3', 'Outro']);
    expect(gh.mapSummary).toEqual({real: true, bpm: 120, meter: '4/4', sections: ['Intro', 'Verse', 'Chorus', 'Verse 2', 'Chorus 2', 'Bridge', 'Chorus 3', 'Outro']});
    expect(Object.keys(gh.tempo)).toEqual(['songMap']);
  });
  it('has 4 stems, a drum part on the same measures, and no saved practice', () => {
    expect(gh.stems.map(s => s.name)).toEqual(['drums', 'bass', 'vocals', 'other']);
    expect(gh.hasChart).toBe(true);
    const score = seed.notation.glasshouse.score;
    expect(score.timeline.measures.map(m => m.id)).toEqual(gh.tempo.songMap.measures.map(m => m.id));
    expect(score.bars).toHaveLength(64);
    expect(score.bars.every(b => b.hits.length > 0)).toBe(true);
    expect(score.bars.at(-1).hits.map(h => h.instrument)).toContain('crashChoke');
    expect(new Set(score.bars.flatMap(b => b.hits.map(h => h.id))).size).toBe(score.bars.reduce((n, b) => n + b.hits.length, 0));
    expect(gh.practice).toBeUndefined();
    expect(practiceOf('glasshouse')).toBeUndefined();
    expect(gh.practiceSummary).toBeUndefined();
  });
  it('the account is a drummer (primary) with Fresh defaults: count-in off, click countin', () => {
    expect(seed.settings.profile.primary).toBe('drums');
    expect(seed.settings.practice.countIn.on).toBe(false);
    expect(seed.settings.practice.click).toBe('countin');
    expect(REHEARSAL.duration).toBe(gh.duration);
  });
});

describe('maps', () => {
  const withMap = seed.songs.filter(s => s.tempo?.songMap);
  it('every stored songMap validates and survives cleanSongMap (origin kept)', () => {
    expect(withMap.map(s => s.id).sort()).toEqual(['glasshouse', 'lanterns', 'lowtide', 'nightbus', 'shuffle', 'velvet']);
    for (const s of withMap) {
      expect(() => validateSongMap(s.tempo.songMap), s.id).not.toThrow();
      const clean = cleanSongMap(s.tempo.songMap);
      expect(clean, s.id).not.toBeNull();
      // shared/song-map.ts gains `origin` in F5 (§4.1); until then cleanSongMap drops it.
      expect({...clean, origin: s.tempo.songMap.origin}).toMatchObject({...s.tempo.songMap});
    }
  });
  it('mapped songs carry each origin; the 1.9 maps carry none', () => {
    expect(Object.fromEntries(withMap.map(s => [s.id, s.tempo.songMap.origin ?? null]))).toEqual({
      glasshouse: 'edited', lowtide: 'edited', lanterns: 'imported', velvet: 'detected', nightbus: null, shuffle: null,
    });
  });
  it('lowtide has a one-beat pickup before bar 1', () => {
    const [pickup, first] = song('lowtide').tempo.songMap.measures;
    expect(number(pickup.length)).toBe(1);
    expect(number(first.length)).toBe(4);
    const c = compile(song('lowtide').tempo.songMap);
    expect(timeAt(c, 1)).toBeCloseTo(.5 + 60 / 104, 3);
  });
  it('lanterns is in 7/8 grouped 2+2+3', () => {
    const m = song('lanterns').tempo.songMap.measures[0];
    expect([m.numerator, m.denominator]).toEqual([7, 8]);
    expect(beatGroups(m)).toEqual([2, 2, 3]);
    expect(song('lanterns').mapSummary.meter).toBe('7/8');
  });
  it('nightbus is a 1.6–1.9 save: no origin, two pins and labels (a real map), plus the dual-write and click fields', () => {
    const t = song('nightbus').tempo;
    expect(t.songMap.pins.length).toBe(2);
    expect(t.songMap.measures.some((m, i) => m.label && !(i === 0 && m.label === 'Pickup'))).toBe(true);
    expect(t.source).toBe('detected');
    expect(t.detected.length).toBeGreaterThan(2);
    expect(t).toMatchObject({map: [], countIn: false, enabled: false, accent: true});
  });
  it('shuffle has the 120 bpm placeholder map (not real): one pin at 0, full 4/4 bars, no labels', () => {
    const map = song('shuffle').tempo.songMap;
    expect(map.pins).toEqual([{position: {n: 0, d: 1}, time: 0}]);
    expect(map.tailQpm).toBe(120);
    expect(map.measures.every(m => m.numerator === 4 && m.denominator === 4 && !m.label && !m.grouping)).toBe(true);
    expect(song('shuffle').mapSummary).toBeUndefined();
  });
  it('legacy shapes: cobblestone a pre-1.6 tempo.map, secondwind pre-1.6 detected beats with click fields', () => {
    expect(song('cobblestone').tempo.songMap).toBeUndefined();
    expect(song('cobblestone').tempo.map).toEqual([{t: .4, bpm: 88, beatsPerBar: 4, unit: 4}, {t: 120.4, bpm: 92, beatsPerBar: 3, unit: 4}]);
    const sw = song('secondwind').tempo;
    expect(sw.songMap).toBeUndefined();
    expect(sw.source).toBe('detected');
    expect(sw.detected.length).toBeGreaterThan(100);
    expect(sw).toMatchObject({countIn: true, countInLength: 2, countInUnit: 'bars', enabled: false, accent: false, volume: .8, audiblePreRoll: true});
  });
  it('unmapped songs have no tempo at all', () => {
    for (const id of ['jam03', 'counting', 'quiet', 'metropolis']) expect(song(id).tempo, id).toBeNull();
  });
  it('buildMap refuses a pickup before 0 s and pins every N bars', () => {
    expect(() => buildMap({prefix: 'x', duration: 10, qpm: 120, pickup: 2, firstDownbeat: .5})).toThrow(/pickup starts before 0/);
    const m = buildMap({prefix: 'x', duration: 32, qpm: 120, pins: 4});
    expect(m.songMap.pins).toHaveLength(4);
    expect(m.bars).toBe(16);
  });
});

describe('practice', () => {
  it('v2 rows live in songPractice; lowtide has spots, markers, chartAudio, click and a trainer', () => {
    expect(seed.songPractice.map(p => p.songId).sort()).toEqual(['lanterns', 'lowtide']);
    for (const row of seed.songPractice) expect(row).toMatchObject({userId: USER_ID, practice: {v: 2}});
    const p = practiceOf('lowtide');
    expect(p.spots.filter(s => !s.deleted)).toHaveLength(3);
    expect(p.spots.some(s => s.deleted)).toBe(true);
    expect(p.markers.filter(m => !m.deleted)).toHaveLength(2);
    expect(p.chartAudio).toBe('quiet');
    expect(p.click).toEqual({countIn: {on: true, length: 1, unit: 'bars'}, mode: 'always', lastMode: 'countin', accent: true, volume: .6, preRoll: false});
    expect(p.trainer).toEqual({start: .7, end: 1, step: .05, passes: 2});
    expect(p.loop).toMatchObject({on: true, eachPassCount: true, playTimes: 0, between: 'none'});
  });
  it('bar references point at measures of the song’s own map, and times agree with them', () => {
    const map = song('lowtide').tempo.songMap, c = compile(map);
    const starts = []; let q = 0;
    for (const m of map.measures) { starts.push(q); q += number(m.length); }
    const check = (ref, t) => {
      const i = map.measures.findIndex(m => m.id === ref.id);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(timeAt(c, starts[i])).toBeCloseTo(t, 3);
    };
    const p = practiceOf('lowtide');
    check(p.loop.aBar, p.loop.a); check(p.loop.bBar, p.loop.b);
    for (const s of p.spots) { check(s.aBar, s.a); check(s.bBar, s.b); }
  });
  it('summaries agree with the practice they summarise (top 3 spots by lastAt)', () => {
    const p = practiceOf('lowtide'), sum = song('lowtide').practiceSummary;
    const live = p.spots.filter(s => !s.deleted).sort((a, b) => b.lastAt - a.lastAt);
    expect(sum.spots).toEqual(live.slice(0, 3).map(({id, name, rate}) => ({id, name, rate})));
    expect(sum).toMatchObject({rate: p.rate, minusMe: p.minusMe, surface: p.surface, spotCount: live.length, loopLabel: 'Chorus loop'});
    expect(song('lowtide').lastPracticedAt).toBe(p.lastAt);
    expect(song('lanterns').practiceSummary).toEqual({rate: 1, minusMe: false, surface: 'stems', spotCount: 0, spots: []});
  });
  it('v1 rows keep songs.practice in the shapes 1.x stored', () => {
    expect(song('secondwind').practice).toMatchObject({rate: .85, loop: {enabled: true, a: 30.5, b: 40.5}, grid: {visible: true}});
    expect(song('cobblestone').practice).toEqual({rate: 1});
    expect(song('metropolis').practice).toEqual({rate: 1, loop: {enabled: false, a: 0, b: 0}, tracks: []});
  });
  it('every practice blob is within the B2 cap', () => {
    for (const row of seed.songPractice) expect(JSON.stringify(row.practice).length).toBeLessThan(PRACTICE_CAP);
  });
});

describe('review flags, suggestions and sharing', () => {
  it('velvet has a sectionSuggestion; shuffle recordingUnconfirmed; jam03 needsReview; counting a metadataSuggestion', () => {
    const suggestion = song('velvet').sectionSuggestion;
    expect(suggestion.sections.length).toBeGreaterThanOrEqual(4);
    expect(suggestion.sections.every(s => s.t0 >= 0 && s.confidence > 0 && s.confidence <= 1 && s.label)).toBe(true);
    expect(seed.jobs.find(j => j.jobId === suggestion.jobId)).toBeTruthy();
    expect(song('velvet').tempo.songMap.measures.every(m => !m.label)).toBe(true);
    expect(song('shuffle')).toMatchObject({recordingUnconfirmed: true, source: {type: 'search'}});
    expect(song('jam03')).toMatchObject({needsReview: true, source: {type: 'upload'}, originDeviceId: 'dev1'});
    expect(song('counting')).toMatchObject({metadataStatus: 'uncertain', metadataSuggestion: {title: 'Counting Stars Backwards'}});
  });
  it('a demo share and the share dialog’s link exist with valid tokens', () => {
    expect(seed.demoToken).toBe(DEMO_TOKEN);
    expect(Object.values(seed.shares).map(s => s.token).sort()).toEqual([SHARE_TOKEN, DEMO_TOKEN].sort());
    for (const s of Object.values(seed.shares)) expect(s.token).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('song rows against convex/schema.ts', () => {
  const fields = schema.tables.songs.validator.fields;
  const FIXTURE_ONLY = ['id', 'coverUrl', 'bpm', 'offset'];
  it('hold only schema values: no null for an optional column, no value outside a union', () => {
    for (const fx of [{}, {account: 'new'}, {devices: 'none'}, {auth: 'export_only'}]) {
      for (const row of createSeed({fx, now: NOW}).songs) {
        const problems = Object.keys(row).filter(k => !(k in fields) && !FIXTURE_ONLY.includes(k)).map(k => `${row.id}.${k}: not in the schema`);
        for (const [k, f] of Object.entries(fields)) if (k in row) schemaProblems(f, row[k], `${row.id}.${k}`, problems);
        expect(problems, JSON.stringify(fx)).toEqual([]);
      }
    }
  });
  it('a song with no metadata lookup has no metadataStatus or MusicBrainz ids', () => {
    for (const id of ['lowtide', 'jam03', 'quiet']) for (const k of ['metadataStatus', 'metadataRecordingId', 'metadataReleaseId']) expect(song(id), `${id}.${k}`).not.toHaveProperty(k);
    expect(song('glasshouse').metadataStatus).toBe('matched');
    expect(song('metropolis').metadataStatus).toBe('pending');
  });
  it('the checker catches the values the seed used to hold', () => {
    expect(schemaProblems(fields.metadataStatus, 'done', 's.metadataStatus')).toHaveLength(1);
    expect(schemaProblems(fields.metadataRecordingId, null, 's.metadataRecordingId')).toHaveLength(1);
    expect(schemaProblems(fields.metadataStatus, undefined, 's.metadataStatus')).toEqual([]);
  });
});

describe('jobs', () => {
  const byId = id => seed.jobs.find(j => j.jobId === id);
  it('cover every job state', () => {
    const states = seed.jobs.map(j => `${j.kind}:${j.status}:${j.stage}`);
    for (const expected of ['separate:queued:queued', 'separate:running:download', 'separate:running:separate', 'separate:running:finalize', 'beats:running:detect', 'sections:running:detect', 'import:running:finalize', 'separate:error:download', 'separate:error:separate', 'beats:done:detect'])
      expect(states, expected).toContain(expected);
    expect(byId('job-up').source.type).toBe('upload');
    expect(byId('job-run').startedAt).toBeLessThan(NOW);
    expect(byId('job-beats').chainedFrom).toBe('job-done-quiet');
    expect(byId('job-bot')).toMatchObject({errorCode: 'bot_check', retryAt: NOW + 5 * 6e4, attempts: 1});
    expect(byId('job-fail').errorCode).toBe('separation_failed');
    expect(byId('job-re').songId).toBe('counting');
  });
  it('the done, unapplied user detection is on a mapped song (D44)', () => {
    const d = byId('job-detect-nightbus');
    expect(d).toMatchObject({kind: 'beats', status: 'done'});
    expect(d.chainedFrom).toBeUndefined();
    expect(d.appliedAt).toBeUndefined();
    expect(d.result.beats.length).toBeGreaterThan(100);
    expect(song(d.songId).tempo.songMap.pins.length).toBeGreaterThan(1);
  });
  it('rows carry the listActive v2 fields', () => {
    for (const j of seed.jobs) {
      expect(j, j.jobId).toMatchObject({jobId: expect.any(String), kind: expect.any(String), status: expect.any(String), stage: expect.any(String), percent: expect.any(Number), createdAt: expect.any(Number), updatedAt: expect.any(Number), attempts: expect.any(Number)});
      if (j.kind === 'separate') expect(j.settingsSummary, j.jobId).toEqual({preset: 'balanced', stemMode: 'full', model: 'htdemucs_ft'});
    }
  });
});

describe('devices, setlists, pins and references', () => {
  it('two devices, one online (busy) and one offline', () => {
    expect(seed.devices.map(d => d.id)).toEqual(['dev1', 'dev2']);
    expect(seed.devicePresence.map(p => [p.deviceId, p.state])).toEqual([['dev1', 'busy'], ['dev2', 'offline']]);
    expect(NOW - seed.devicePresence[0].lastSeenAt).toBeLessThan(150_000);
    expect(NOW - seed.devicePresence[1].lastSeenAt).toBeGreaterThan(150_000);
  });
  it('dev1 is busy with job-run only while job-run exists (fx-jobs=0, an empty library)', () => {
    expect(seed.devicePresence[0]).toMatchObject({state: 'busy', currentJobId: 'job-run'});
    for (const fx of [{jobs: '0'}, {library: 'empty'}]) {
      const other = createSeed({fx, now: NOW});
      expect(other.jobs.some(j => j.jobId === 'job-run')).toBe(false);
      expect(other.devicePresence[0].state).toBe('idle');
      expect(other.devicePresence[0]).not.toHaveProperty('currentJobId');
    }
    const offline = createSeed({fx: {devices: 'offline'}, now: NOW});
    expect(offline.devicePresence.map(p => p.state)).toEqual(['offline', 'offline']);
  });
  it('every reference resolves: job songs and devices, setlist songs, pins, shares, presence', () => {
    const songs = new Set(seed.songs.map(s => s.id)), devices = new Set(seed.devices.map(d => d.id)), jobs = new Set(seed.jobs.map(j => j.jobId));
    for (const j of seed.jobs) {
      if (j.songId) expect(songs.has(j.songId), j.jobId).toBe(true);
      if (j.deviceId) expect(devices.has(j.deviceId), j.jobId).toBe(true);
      if (j.chainedFrom) expect(jobs.has(j.chainedFrom), j.jobId).toBe(true);
    }
    for (const list of seed.setlists) for (const id of list.songIds) expect(songs.has(id), list.name).toBe(true);
    expect(seed.settings.pins.length).toBeGreaterThan(0);
    for (const id of seed.settings.pins) expect(songs.has(id)).toBe(true);
    for (const id of Object.keys(seed.shares)) expect(songs.has(id)).toBe(true);
    for (const p of seed.devicePresence) expect(devices.has(p.deviceId)).toBe(true);
    for (const p of seed.devicePresence) if (p.currentJobId) expect(jobs.has(p.currentJobId)).toBe(true);
    for (const id of Object.keys(seed.notation)) expect(song(id).hasChart).toBe(true);
    for (const s of seed.songs) if (s.coverKey) expect(seed.coverKeys[s.coverKey], s.id).toBeTruthy();
  });
});

describe('switches, determinism and storage', () => {
  it('the same switches and clock give the same seed; it survives JSON unchanged', () => {
    expect(createSeed({now: NOW})).toEqual(seed);
    expect(JSON.parse(JSON.stringify(seed))).toEqual(seed);
    expect(JSON.stringify(seed).length).toBeLessThan(1_500_000);
  });
  it('fx-library=empty: no songs, jobs, setlists, shares or practice', () => {
    const empty = createSeed({fx: {library: 'empty'}, now: NOW});
    expect([empty.songs, empty.jobs, empty.setlists, empty.songPractice]).toEqual([[], [], [], []]);
    expect(empty.shares).toEqual({});
    expect(empty.demoToken).toBeNull();
    expect(empty.settings.pins).toEqual([]);
  });
  it('fx-jobs=0 keeps only finished jobs', () => {
    expect(createSeed({fx: {jobs: '0'}, now: NOW}).jobs.every(j => j.status === 'done')).toBe(true);
  });
  it('fx-devices=none|offline|online', () => {
    const none = createSeed({fx: {devices: 'none'}, now: NOW});
    expect(none.devices).toEqual([]);
    expect(none.jobs.some(j => j.deviceId)).toBe(false);
    expect(createSeed({fx: {devices: 'offline'}, now: NOW}).devicePresence.map(p => p.state)).toEqual(['offline', 'offline']);
    expect(createSeed({fx: {devices: 'online'}, now: NOW}).devicePresence.map(p => p.state)).toEqual(['busy', 'idle']);
  });
  it('fx-account=new has no stored settings; fx-auth and fx-billing shape the account', () => {
    expect(createSeed({fx: {account: 'new'}, now: NOW}).settings).toBeNull();
    expect(createSeed({fx: {auth: 'suspended'}, now: NOW}).user.status).toBe('suspended');
    expect(createSeed({fx: {auth: 'export_only'}, now: NOW}).user.status).toBe('export_only');
    expect(createSeed({fx: {billing: 'grace'}, now: NOW}).billing).toMatchObject({access: 'grace', graceEndsAt: NOW + 9 * 864e5});
    expect(createSeed({fx: {billing: 'disabled'}, now: NOW}).billing.enabled).toBe(false);
  });
  it('seedKey depends only on the seed switches', () => {
    expect(seedKey({desktop: '1', media: 'slow'})).toBe(seedKey({}));
    for (const k of SEED_SWITCHES) expect(seedKey({[k]: 'x'}), k).not.toBe(seedKey({}));
  });
});
