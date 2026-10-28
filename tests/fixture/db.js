// In-memory Convex stand-in for the full-app fixture. Every query, mutation
// and action the web app calls is routed here by function name
// ("module:function"). Scenario switches come from the page URL:
//   fx-auth=signedout      sign-in screen
//   fx-auth=suspended      suspended-account screen
//   fx-auth=fail           boot failure ("Couldn't open Woodshed")
//   fx-companion=offline   desktop app whose local processor is disconnected
//   fx-update=available|downloading|ready  desktop update states
//   fx-signinError=expired sign-in screen with an OAuth error
//   fx-view=<group>-<layout>, fx-practice=chart|tracks, fx-notation=score|lanes, fx-overview=1  seed device prefs
//   fx-desktop=1           pretend to be Woodshed for desktop (enables Add song)
//   fx-library=empty       no songs, no jobs
//   fx-library=slow        library never arrives (startup skeleton)
//   fx-jobs=0              hide in-progress/failed jobs
//   fx-billing=free|plus|cancel|grace|disabled
//   fx-admin=1             account is an administrator
//   fx-media=fail          media.signKeys fails (player load error)
//   fx-media=slow          stem URLs take 8 s (player loading state)
//   fx-share=missing       shared-song link is unavailable
//   fx-share=saved         shared song already saved to the library
import {demoScore} from '/tests/fixtures/drum-score.js';
import {stemUrl} from './audio.js';

const params = new URLSearchParams(location.search);
export const fx = Object.fromEntries([...params].filter(([k]) => k.startsWith('fx-')).map(([k, v]) => [k.slice(3), v]));
window.fixture = {fx};

// ---- artwork --------------------------------------------------------------
const svg = body => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">${body}</svg>`)}`;
const COVERS = {
  weather: svg('<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2a4a"/><stop offset="1" stop-color="#e2725b"/></linearGradient></defs><rect width="300" height="300" fill="url(#g)"/><circle cx="150" cy="190" r="70" fill="#f6d27a"/><rect y="200" width="300" height="100" fill="#14203a"/><path d="M0 215h300M0 235h300M0 255h300" stroke="#f6d27a" stroke-opacity=".5" stroke-width="3"/><text x="20" y="40" font-family="Georgia" font-size="22" fill="#fff">NORTHBOUND</text>'),
  lanterns: svg('<rect width="300" height="300" fill="#2d1b33"/>' + [[70, 90], [160, 60], [230, 130], [110, 180], [200, 220]].map(([x, y]) => `<g transform="translate(${x} ${y})"><ellipse rx="26" ry="34" fill="#ff9f43"/><ellipse rx="16" ry="24" fill="#ffd28a"/></g>`).join('') + '<text x="150" y="285" text-anchor="middle" font-family="Helvetica" font-size="18" letter-spacing="4" fill="#ffd28a">MARISOL VEGA</text>'),
  crossings: svg('<rect width="300" height="300" fill="#e8e1cf"/><path d="M0 220 Q150 140 300 220V300H0Z" fill="#2f5d62"/><path d="M40 210 70 120h10l30 90" fill="none" stroke="#1f2a2c" stroke-width="6"/><rect x="40" y="120" width="220" height="8" fill="#1f2a2c"/><text x="150" y="60" text-anchor="middle" font-family="Georgia" font-style="italic" font-size="30" fill="#1f2a2c">Crossings</text>'),
  satellites: svg('<rect width="300" height="300" fill="#05070d"/>' + Array.from({length: 60}, (_, i) => `<circle cx="${(i * 97) % 300}" cy="${(i * 53) % 300}" r="${(i % 3) * .7 + .5}" fill="#fff"/>`).join('') + '<circle cx="150" cy="150" r="60" fill="none" stroke="#7fd1ff" stroke-width="2"/><ellipse cx="150" cy="150" rx="110" ry="28" fill="none" stroke="#7fd1ff" stroke-width="2" transform="rotate(-20 150 150)"/><circle cx="246" cy="118" r="7" fill="#7fd1ff"/>'),
  nightbus: svg('<rect width="300" height="300" fill="#0f3d3e"/><rect x="30" y="120" width="240" height="90" rx="14" fill="#f4c430"/><g fill="#0f3d3e">' + [50, 100, 150, 200].map(x => `<rect x="${x}" y="135" width="38" height="30" rx="4"/>`).join('') + '</g><circle cx="80" cy="215" r="16" fill="#111"/><circle cx="220" cy="215" r="16" fill="#111"/><text x="150" y="70" text-anchor="middle" font-family="Courier" font-weight="bold" font-size="28" fill="#f4c430">NIGHT BUS</text>'),
  harbor: svg('<rect width="300" height="300" fill="#a7c5eb"/><path d="M0 200h300v100H0z" fill="#3f6e9c"/><path d="M120 200 150 80l30 120z" fill="#fff"/><rect x="146" y="60" width="8" height="140" fill="#333"/>'),
};

// ---- songs ----------------------------------------------------------------
const now = Date.now(), day = 864e5;
const four = id => ['drums', 'bass', 'vocals', 'other'].map(name => ({name, key: `${id}/${name}`}));
const six = id => ['drums', 'bass', 'vocals', 'guitar', 'piano', 'other'].map(name => ({name, key: `${id}/${name}`}));
const base = {albumArtist: '', year: '', genre: '', trackNumber: '', discNumber: '', musicalKey: '', tuning: '', tags: [], notes: '', metadataLocks: [], metadataStatus: 'done', metadataRecordingId: null, metadataReleaseId: null, artwork: null, coverUrl: null, uploader: '', artist: '', album: '', source: null, coverKey: null, stemMode: 'full', quality: {model: 'htdemucs_ft', shifts: 2, overlap: .25, format: 'opus', bitrate: 160}, tempo: null, practice: null};
const song = (s) => ({...base, ...s, stems: s.stems || four(s.id)});
const beatsAt = (bpm, offset, seconds) => { const out = []; for (let t = offset, i = 0; t < seconds - .2; t += 60 / bpm, i++) out.push({time: +t.toFixed(4), downbeat: i % 4 === 0}); return out; };

const glassScore = demoScore(64, 120);
export const SCORES = {glasshouse: glassScore};

export const db = {
  user: {_id: 'user1', name: 'Kyle Kincer', email: 'kyle@example.com', picture: null, status: fx.auth === 'suspended' ? 'suspended' : 'active'},
  settings: null,
  songs: fx.library === 'empty' ? [] : [
    song({id: 'glasshouse', title: 'Glasshouse', artist: 'Northbound', album: 'Weather Systems', albumArtist: 'Northbound', year: '2021', genre: 'Indie rock', trackNumber: '3', musicalKey: 'A minor', tuning: 'Standard', tags: ['drums', 'setlist'], notes: 'Watch the flam into the chorus. Ride bell on the triplet section.', duration: 64, bpm: 120, coverKey: 'covers/weather.png', source: {type: 'url', value: 'https://www.youtube.com/watch?v=fixture01'}, addedAt: now - 2 * day, practice: {rate: 1, tracks: [{name: 'drums', volume: 1, muted: true, soloed: false}]}}),
    song({id: 'lowtide', title: 'Low Tide Static', artist: 'Northbound', album: 'Weather Systems', year: '2021', genre: 'Indie rock', trackNumber: '7', duration: 92, bpm: 104, coverKey: 'covers/weather.png', source: {type: 'url', value: 'https://www.youtube.com/watch?v=fixture02'}, addedAt: now - 3 * day}),
    song({id: 'lanterns', title: 'Paper Lanterns', artist: 'Marisol Vega', album: 'Paper Lanterns', year: '2023', genre: 'Pop', musicalKey: 'E major', duration: 75, bpm: 92, stems: six('lanterns'), stemMode: 'full', quality: {model: 'htdemucs_6s', shifts: 1, overlap: .25, format: 'opus', bitrate: 192}, coverUrl: COVERS.lanterns, artwork: {kind: 'upload', key: 'x'}, source: {type: 'spotify', value: 'https://open.spotify.com/track/fixture'}, addedAt: now - 5 * day}),
    song({id: 'secondwind', title: 'Second Wind', artist: 'The Ferry Hours', album: 'Crossings', year: '2019', genre: 'Folk rock', tags: ['bass', 'audition'], notes: 'Bridge walk-up at 0:48 — slow loop until clean.', duration: 90, bpm: 96, offset: .5, coverKey: 'covers/crossings.png', source: {type: 'url', value: 'https://www.youtube.com/watch?v=fixture04'}, addedAt: now - 8 * day,
      tempo: {source: 'detected', detected: beatsAt(96, .5, 90)}, practice: {rate: .85, loop: {enabled: true, a: 30.5, b: 40.5}, tracks: [{name: 'vocals', volume: .6, muted: true, soloed: false}, {name: 'bass', volume: 1, muted: false, soloed: false}]}}),
    song({id: 'cobblestone', title: 'Cobblestone', artist: 'The Ferry Hours', album: 'Crossings', year: '2019', duration: 201, addedAt: now - 9 * day}),
    song({id: 'nightbus', title: 'Night Bus', artist: 'Kito & the Late Shift', duration: 233, stems: [{name: 'vocals', key: 'nightbus/vocals'}, {name: 'no_vocals', key: 'nightbus/no_vocals'}], stemMode: 'vocals', coverKey: 'covers/nightbus.png', addedAt: now - 12 * day}),
    song({id: 'jam03', title: 'untitled_jam_03.wav', duration: 148, source: {type: 'upload', value: 'local1', filename: 'untitled_jam_03.wav'}, metadataStatus: 'none', addedAt: now - 14 * day}),
    song({id: 'shuffle', title: 'Sunday Shuffle (Blues Backing Track in A)', uploader: 'BluesLessonsChannel', duration: 312, genre: 'Blues', tags: ['backing track', 'warmup'], source: {type: 'url', value: 'https://www.youtube.com/watch?v=fixture08'}, addedAt: now - 20 * day}),
    song({id: 'velvet', title: 'Velvet Arc', artist: 'Marisol Vega', album: 'Satellites', year: '2020', duration: 244, coverKey: 'covers/satellites.png', addedAt: now - 22 * day}),
    song({id: 'counting', title: 'Counting Stars Backwards', artist: 'Ada Moreno', album: 'Harbor Lights', duration: 187, coverUrl: COVERS.harbor, addedAt: now - 30 * day}),
    song({id: 'metropolis', title: 'Metropolis Pt. II (Live)', artist: 'Glass Animals of Ohio', album: 'Live at the Grange, Vol. 2 — Deluxe Anniversary Edition', year: '2018', duration: 563, addedAt: now - 40 * day}),
    song({id: 'quiet', title: 'Quiet Hours', artist: 'Northbound', album: 'Early Demos', duration: 176, addedAt: now - 50 * day}),
  ],
  jobs: fx.library === 'empty' || fx.jobs === '0' ? [] : [
    {jobId: 'job-run', kind: 'separate', status: 'running', stage: 'separate', percent: 46, message: 'Separating stems…', label: 'Harbor Lights — Ada Moreno', meta: {title: 'Harbor Lights', artist: 'Ada Moreno', album: 'Harbor Lights', duration: 204, coverKey: 'covers/harbor.png'}},
    {jobId: 'job-dl', kind: 'separate', status: 'running', stage: 'download', percent: 12, message: 'Downloading…', label: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', meta: {title: 'Lighthouse Keeper', uploader: 'The Tidewater Collective'}},
    {jobId: 'job-q', kind: 'separate', status: 'queued', stage: 'queued', percent: 0, message: 'Waiting for your computer…', label: 'marisol vega satellites live'},
    {jobId: 'job-err', kind: 'separate', status: 'error', stage: 'download', percent: 0, label: 'https://www.youtube.com/watch?v=blocked123', meta: {title: 'Undertow'}, error: 'ERROR: [youtube] blocked123: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.\nyt-dlp exited with code 1'},
    {jobId: 'job-re', kind: 'separate', status: 'running', stage: 'separate', percent: 71, message: 'Separating stems…', songId: 'counting', label: 'Counting Stars Backwards (reprocess)'},
  ],
  notation: {glasshouse: {score: glassScore, revision: 3}},
  shares: {},
  coverKeys: {'covers/weather.png': COVERS.weather, 'covers/crossings.png': COVERS.crossings, 'covers/satellites.png': COVERS.satellites, 'covers/nightbus.png': COVERS.nightbus, 'covers/harbor.png': COVERS.harbor},
  billing: (() => {
    const b = {enabled: fx.billing !== 'disabled', access: 'free', status: null, interval: null, periodEnd: null, cancelAtPeriodEnd: false, graceEndsAt: null, hasCustomer: false, cleanupPending: false, usedBytes: 412e6, limitBytes: 1e9, freeBytes: 1e9, proBytes: 25e9, monthlyCents: 200, annualCents: 2000};
    if (fx.billing === 'plus') Object.assign(b, {access: 'paid', status: 'active', interval: 'year', periodEnd: now + 200 * day, hasCustomer: true, usedBytes: 3.8e9, limitBytes: 25e9});
    if (fx.billing === 'cancel') Object.assign(b, {access: 'paid', status: 'active', interval: 'month', periodEnd: now + 12 * day, cancelAtPeriodEnd: true, hasCustomer: true, usedBytes: 3.8e9, limitBytes: 25e9});
    if (fx.billing === 'grace') Object.assign(b, {access: 'grace', status: 'canceled', graceEndsAt: now + 9 * day, hasCustomer: true, usedBytes: 3.8e9, limitBytes: 1e9});
    return b;
  })(),
};
// A shared link for Glasshouse exists so the share dialog can show both states.
const TOKEN = 'a3f1'.repeat(16);
db.shares.glasshouse = {token: TOKEN, includeNotation: true};
window.fixture.db = db;
window.fixture.shareToken = TOKEN;

const clone = v => structuredClone(v);
const publicSong = ({bpm, offset, ...s}) => clone(s);
const findSong = id => db.songs.find(s => s.id === id);

// ---- subscriptions --------------------------------------------------------
const subs = new Set();
export function subscribe(name, args, cb, onError) {
  const sub = {name, args, cb, onError, last: undefined};
  subs.add(sub);
  run(sub);
  const stop = () => subs.delete(sub);
  return Object.assign(stop, {unsubscribe: stop, getCurrentValue: () => sub.last});
}
async function run(sub) {
  if (!subs.has(sub)) return;
  try {
    const value = await call('query', sub.name, sub.args);
    if (value === NEVER) return;
    const json = JSON.stringify(value);
    if (json === sub.lastJson) return;
    sub.lastJson = json; sub.last = value;
    sub.cb(value);
  } catch (error) { sub.onError?.(error); }
}
export function changed() { setTimeout(() => subs.forEach(run), 0); }
const NEVER = Symbol('never');

// Running jobs creep forward so the library looks alive.
setInterval(() => {
  let any = false;
  for (const j of db.jobs) if (j.status === 'running' && j.percent < 99 && !j.frozen) { j.percent = Math.min(99, j.percent + 1); any = true; }
  if (any) changed();
}, 4000);
window.fixture.freezeJobs = () => db.jobs.forEach(j => { j.frozen = true; });

function convexError(data) { const e = new Error(typeof data === 'string' ? data : data.message); e.data = data; return e; }

// ---- handlers -------------------------------------------------------------
const PRESETS_P = import('/convex/lib/presets.ts');

const handlers = {
  // users / auth / admin
  'users:me': async () => { if (fx.auth === 'fail') { await wait(600); throw new Error('[CONVEX Q(users:me)] Connection lost while action was in flight'); } return clone(db.user); },
  'admin:access': () => fx.admin === '1',
  'admin:overview': () => ({usedBytes: 61.2e9, appBytes: 200e9, baseAppBytes: 150e9, userBytes: 1e9}),
  'admin:accounts': () => ({page: [
    {id: 'user1', name: 'Kyle Kincer', email: 'kyle@example.com', admin: true, status: 'active', usedBytes: 412e6, limitBytes: 1e9},
    {id: 'user2', name: 'Dana Ruiz', email: 'dana@example.com', admin: false, status: 'active', usedBytes: 980e6, limitBytes: 1e9},
    {id: 'user3', name: '', email: 'sam.l@example.com', admin: false, status: 'export_only', usedBytes: 2.1e9, limitBytes: 1e9},
    {id: 'user4', name: 'Theo Park', email: 'theo@example.com', admin: false, status: 'suspended', usedBytes: 0, limitBytes: 1e9},
  ], isDone: true, continueCursor: null}),
  'admin:account': ({id}) => ({id, name: 'Dana Ruiz', email: 'dana@example.com', emailVerified: true, createdAt: now - 120 * day, usedBytes: 980e6, limitBytes: 1e9, byteLimit: null, status: 'active', admin: false, notes: 'Beta tester. Asked about FLAC export.', devices: [{id: 'd1', name: 'Dana’s MacBook Pro', revoked: false}, {id: 'd2', name: 'Studio PC', revoked: true}], jobs: [{id: 'j1', label: 'Harbor Lights', status: 'running', stage: 'separate'}, {id: 'j2', label: 'Undertow', status: 'error', stage: 'download', error: 'YouTube blocked the download.'}]}),
  'admin:history': () => ({page: [{at: now - day, action: 'policy.update', targetId: 'app', reason: 'Raise default limit for launch', actorId: 'user1'}, {at: now - 3 * day, action: 'account.update', targetId: 'user3', reason: 'Over limit after downgrade', actorId: 'user1'}], isDone: true, continueCursor: null}),
  'devices:pair': () => null,

  // settings
  'settings:config': async () => {
    const p = await PRESETS_P;
    db.settings ??= p.withDefaults(null);
    return {settings: clone(db.settings), presets: p.PRESETS, defaultPreset: p.DEFAULT_PRESET, models: p.MODELS, stemModes: p.STEM_MODES, bitrates: p.BITRATES};
  },
  'settings:save': ({settings}) => { db.settings = clone(settings); return settings; },
  'storage:usage': () => ({usedBytes: db.billing.usedBytes, limitBytes: db.billing.limitBytes, appFull: false}),
  'billingData:status': () => clone(db.billing),
  'billing:checkout': async () => { await wait(800); throw convexError('Checkout is not available in the fixture.'); },
  'billing:portal': async () => { await wait(800); throw convexError('The billing portal is not available in the fixture.'); },

  // library
  'songs:list': () => fx.library === 'slow' ? NEVER : ({songs: db.songs.map(publicSong)}),
  'songs:get': ({id}) => { const s = findSong(id); return s ? publicSong(s) : null; },
  'songs:rename': ({id, title}) => { findSong(id).title = title; changed(); return publicSong(findSong(id)); },
  'songs:saveTempo': ({id, tempo}) => { const s = findSong(id); if (s) s.tempo = clone(tempo); changed(); return null; },
  'songs:savePractice': ({id, practice}) => { const s = findSong(id); if (s) s.practice = clone(practice); changed(); return null; },
  'songs:remove': ({id}) => { db.songs = db.songs.filter(s => s.id !== id); changed(); return null; },
  'songs:exportPage': () => ({page: db.songs.map(publicSong), isDone: true, continueCursor: null}),
  'metadata:update': ({ids, changes}) => {
    for (const id of ids) { const s = findSong(id); if (!s) continue; const {artwork, ...rest} = changes; Object.assign(s, rest); if (artwork?.kind === 'removed') { s.coverUrl = null; s.coverKey = null; } if (artwork?.kind === 'release') s.coverUrl = COVERS.harbor; }
    changed(); return null;
  },
  'metadataLookup:find': async ({title, artist, recordingId}) => {
    await wait(500);
    if (recordingId) return [
      {recordingId, releaseId: 'rel-1', title, artist: artist || 'Northbound', album: 'Weather Systems', year: '2021', duration: 64},
      {recordingId, releaseId: 'rel-2', title, artist: artist || 'Northbound', album: 'Weather Systems (Deluxe)', year: '2022', duration: 64},
      {recordingId, releaseId: 'rel-3', title, artist: artist || 'Northbound', album: 'Songs from the Shed: A Compilation', year: '2023', duration: 65},
    ];
    return [
      {recordingId: 'rec-1', releaseId: 'rel-1', title: title || 'Glasshouse', artist: artist || 'Northbound', album: 'Weather Systems', year: '2021', duration: 64},
      {recordingId: 'rec-2', releaseId: 'rel-4', title: title || 'Glasshouse', artist: artist || 'Northbound', album: 'Glasshouse (Single)', year: '2020', duration: 63, disambiguation: 'radio edit'},
      {recordingId: 'rec-3', releaseId: null, title: `${title || 'Glasshouse'} (Live)`, artist: artist || 'Northbound', album: '', year: '', duration: 71, disambiguation: 'live, 2022-05-14: The Grange'},
    ];
  },
  'metadataLookup:detail': async () => { await wait(300); return {title: 'Glasshouse', artist: 'Northbound', album: 'Weather Systems', albumArtist: 'Northbound', year: '2021', genre: 'Alternative rock', trackNumber: '3', discNumber: '1'}; },
  'artworkUpload:prepare': () => { throw convexError('Artwork upload is not available in the fixture.'); },

  // media
  'media:signKeys': async ({keys}) => {
    if (fx.media === 'fail') { await wait(300); throw new Error('Request timed out (fixture)'); }
    if (fx.media === 'slow' && keys.some(k => !db.coverKeys[k])) await wait(8000);
    const out = {};
    for (const key of keys) {
      if (db.coverKeys[key]) { out[key] = db.coverKeys[key]; continue; }
      const [id, stem] = key.split('/'), s = findSong(id);
      if (s) out[key] = stemUrl(s, stem, SCORES[id]);
    }
    return out;
  },

  // jobs
  'jobs:listActive': () => clone(db.jobs),
  'jobs:get': ({jobId}) => clone(db.jobs.find(j => j.jobId === jobId) || db.beatJobs?.[jobId] || null),
  'jobs:cancel': ({jobId}) => { db.jobs = db.jobs.filter(j => j.jobId !== jobId); changed(); return null; },
  'jobs:dismiss': ({jobId}) => { db.jobs = db.jobs.filter(j => j.jobId !== jobId); changed(); return null; },
  'jobs:retry': ({jobId}) => { const j = db.jobs.find(x => x.jobId === jobId); Object.assign(j, {status: 'queued', stage: 'queued', percent: 0, error: null}); changed(); return null; },
  'jobs:createSeparation': ({source, label, replaceSongId}) => {
    const jobId = `job-${Math.random().toString(36).slice(2, 8)}`;
    db.jobs.unshift({jobId, kind: 'separate', status: 'queued', stage: 'queued', percent: 0, label, songId: replaceSongId, meta: source?.type === 'search' ? {title: label} : source?.type === 'upload' ? {title: source.filename} : {}});
    changed();
    setTimeout(() => { const j = db.jobs.find(x => x.jobId === jobId); if (j) { Object.assign(j, {status: 'running', stage: 'download', percent: 8, meta: {...j.meta, title: j.meta.title || 'Harbor Lights', artist: 'Ada Moreno', duration: 204}}); changed(); } }, 1500);
    return {jobId};
  },
  'jobs:createBeatDetection': ({songId}) => {
    const jobId = `beats-${songId}`;
    db.beatJobs = {...db.beatJobs, [jobId]: {jobId, kind: 'beats', status: 'running', message: 'Listening for beats…'}};
    setTimeout(() => { const s = findSong(songId); db.beatJobs[jobId] = {jobId, kind: 'beats', status: 'done', result: {beats: beatsAt(s.bpm || 120, s.offset || 0, s.duration).map((b, i) => [b.time, i % 4 + 1])}}; changed(); }, 1500);
    return {jobId};
  },

  // tempo sources
  'tempoSources:search': async ({query}) => {
    await wait(400);
    if (/zzz/.test(query)) return {candidates: [], warnings: []};
    return {candidates: [
      {id: 'hx-1', title: 'Glasshouse', artist: 'Northbound', album: 'Weather Systems', source: 'harmonix', duration: 64.2, bpm: 120},
      {id: 'ch-1', title: 'Glasshouse', artist: 'Northbound', album: 'Weather Systems', source: 'chorus', duration: 64, charter: 'Rhythmatic', hasDrums: false},
      {id: 'ch-2', title: 'Glasshouse (Live at the Grange)', artist: 'Northbound', album: 'Live', source: 'chorus', duration: 71.5, charter: 'drumbot', hasDrums: false},
    ], warnings: []};
  },
  'tempoSources:load': async ({id}) => {
    await wait(300);
    const shift = id === 'ch-2' ? 1.2 : id === 'ch-1' ? 0.04 : 0;
    return {format: 'beats', text: beatsAt(120, shift, 64).map((b, i) => `${b.time}\t${i % 4 + 1}\t${Math.floor(i / 4) + 1}`).join('\n'), sourceUrl: 'https://github.com/urinieto/harmonixset'};
  },

  // notation
  'notation:get': ({songId, token}) => {
    if (token) return fx.share === 'missing' ? null : clone(db.notation.glasshouse);
    return db.notation[songId] ? clone(db.notation[songId]) : null;
  },
  'notation:save': ({songId, header, bars}) => {
    const cur = db.notation[songId] || {score: {...header, bars: []}, revision: 0};
    const merged = {...header, bars: [...cur.score.bars.filter(b => !bars.some(n => n.measureId === b.measureId)), ...bars].filter(b => b.hits.length || b.coverage !== 'unstarted')};
    db.notation[songId] = {score: merged, revision: cur.revision + 1};
    return {revision: cur.revision + 1};
  },

  // sharing
  'sharing:status': ({id}) => db.shares[id] ? clone(db.shares[id]) : null,
  'sharing:create': ({id, includeNotation}) => { db.shares[id] = {token: db.shares[id]?.token || [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join(''), includeNotation}; return {token: db.shares[id].token}; },
  'sharing:revoke': ({id}) => { delete db.shares[id]; return null; },
  'sharing:view': ({token}) => {
    if (fx.share === 'missing' || token !== TOKEN) return null;
    const s = publicSong(findSong('glasshouse'));
    return {...s, id: 'shared', revision: 'r1', coverKey: 'cover', stems: s.stems.map((x, i) => ({name: x.name, key: `stem-${i}`}))};
  },
  'sharing:saved': () => fx.share === 'saved' ? {songId: 'glasshouse', status: 'ready'} : null,
  'shareAudio:playback': () => { const s = findSong('glasshouse'); return Object.fromEntries([...s.stems.map((x, i) => [`stem-${i}`, stemUrl(s, x.name, SCORES.glasshouse)]), ['cover', COVERS.weather]]); },
  'shareAudio:save': async () => { await wait(800); return 'glasshouse'; },
};

const wait = ms => new Promise(r => setTimeout(r, ms));

export async function call(kind, name, args = {}) {
  const handler = handlers[name];
  if (!handler) { console.warn(`[fixture] no handler for ${kind} ${name}`, args); throw new Error(`Fixture has no handler for ${name}`); }
  const result = await handler(args || {});
  if (kind === 'mutation') changed();
  return result === undefined ? null : result;
}
