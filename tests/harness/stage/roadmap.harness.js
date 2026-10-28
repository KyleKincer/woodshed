// ST10's harness (/__harness/roadmap): the Road map and the Wave page inside the real Stage frame
// (src/stage/stage.js resolves src/stage/surfaces/roadmap-surface.js by its contract path), on a
// real song session (tests/helpers/test-session.js in the browser) over the fixture's synthetic
// stems, so the stacked envelopes have shape. The app registry, dispatcher, feedback and platform
// are the app's, so glass, loop drags, the stage.bars grid scope and Follow work as in the app.
// Load it with ?place=stage (the Stage tokens) and fx-audio=manual (audio time moves on request).
// States: tests/fixture/states/ST10.cjs.
//
// Query:
//   mapped=0              a song nobody mapped (the Wave page)
//   song=sections|meter   the rehearsal song (64 bars, 8 sections) | a tempo change at bar 33
//                         (120 → 100 qpm) and a 7/8 (2+2+3) Bridge
//   scenario=             fresh (default) | looping (the Chorus loop, two spots, a marker) |
//                         minus (Minus me: the drums out, a spot) | markers (unmapped markers and a spot)
//   cue=<s>               the cue
//   peaks=0               signing never answers: the bar grid shimmers (no peaks yet)
//   distance=near|stand|kit   the device's Distance (prefs) before mounting
//   ipad=1                platform.isIPad
// window.__roadmap = {ts, session, view, router, surfaceEl(), run(id, args)}
import {registry} from '/src/app/commands.js';
import '/src/app/global-commands.js';
import '/src/stage/transport-commands.js';
import '/src/stage/commands.js';
import {startDispatcher} from '/src/app/dispatch.js';
import * as feedback from '/src/app/feedback.js';
import {platform} from '/src/app/platform.js';
import {prefs} from '/src/app/prefs.js';
import {store} from '/src/app/store.js';
import {createTestSession} from '/tests/helpers/test-session.js';
import {stemUrl} from '/tests/fixture/audio.js';
import {sectioned} from '/tests/fixtures/maps.js';

const frac = (n, d = 1) => ({n, d});

/** 32 bars at 120 qpm, then 100 qpm (a tempo chip on bar 33); the Bridge (bars 41–48) in 7/8 2+2+3. */
function meterTempo() {
  const tempo = structuredClone(sectioned.tempo);
  const m = tempo.songMap;
  m.pins = [{position: frac(0), time: 0}, {position: frac(128), time: 64}];
  m.tailQpm = 100;
  for (let i = 40; i < 48; i++) Object.assign(m.measures[i], {numerator: 7, denominator: 8, length: frac(7, 2), grouping: [2, 2, 3]});
  // 64 s + 32 q × 0.6 + 28 q × 0.6 + 64 q × 0.6
  return {tempo, duration: 64 + (32 + 28 + 64) * 0.6};
}

function practice(fields = {}) {
  return {v: 2, cue: 0, rate: 1, tracks: [], minusMe: false, trainer: null, spots: [], markers: [], ...fields,
    loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none', ...(fields.loop ?? {})}};
}

const SCENARIOS = {
  fresh: () => practice(),
  looping: () => practice({cue: 32, loop: {on: true, a: 32, b: 48},
    spots: [{id: 'spot-fill', name: 'Fill into the chorus', a: 28, b: 32, rate: 0.8, passes: 3, updatedAt: 1},
      {id: 'spot-bridge', name: 'Bridge walk-up', a: 80, b: 96, rate: 0.9, passes: 1, updatedAt: 1}],
    markers: [{id: 'marker-flam', t: 41, label: 'Flam', updatedAt: 1}]}),
  minus: () => practice({cue: 16, minusMe: true, tracks: [{name: 'drums', volume: 1, muted: true, soloed: false}],
    spots: [{id: 'spot-groove', name: 'Verse groove', a: 16, b: 24, rate: 1, passes: 0, updatedAt: 1}]}),
  markers: () => practice({cue: 20, markers: [{id: 'marker-1', t: 12, label: 'Groove', updatedAt: 1},
    {id: 'marker-2', t: 41, label: 'Marker 2', updatedAt: 1}, {id: 'marker-3', t: 96, label: 'Big ending', updatedAt: 1}],
  spots: [{id: 'spot-run', name: 'The run', a: 52, b: 58, rate: 0.85, passes: 2, updatedAt: 1}]}),
};

export default async function mount(el, {query, h}) {
  const distance = query.get('distance');
  prefs.update((d) => {
    d.practice.distance = ['near', 'stand', 'kit'].includes(distance) ? distance : 'stand';
    d.practice.focus = false;
  });
  const mapped = query.get('mapped') !== '0';
  const song = query.get('song') === 'meter' ? 'meter' : 'sections';
  const scenario = SCENARIOS[query.get('scenario')] ? query.get('scenario') : 'fresh';
  const stored = SCENARIOS[scenario]();
  stored.surface = 'roadmap';
  if (query.has('cue')) stored.cue = Number(query.get('cue')) || 0;
  const {tempo, duration} = song === 'meter' ? meterTempo() : {tempo: structuredClone(sectioned.tempo), duration: sectioned.duration};
  const id = 'glasshouse';
  const noPeaks = query.get('peaks') === '0';

  const ts = await createTestSession({
    id, title: 'Glasshouse', artist: 'Northbound',
    tempo: mapped ? tempo : null, mapped, duration,
    practice: stored,
    status: (text, options) => feedback.status(text, options),
    media: noPeaks ? {signKeys: () => new Promise(() => {})} : {
      async signKeys(keys) {
        return Object.fromEntries(keys.map((key) => [key, stemUrl({id, duration, bpm: 120, offset: 0}, key.split('/').pop())]));
      },
    },
    load: false,
  });

  const router = {
    calls: [],
    navigate(to, opts) { this.calls.push(['navigate', to, opts ?? null]); },
    back(opts) { this.calls.push(['back', opts ?? null]); },
    setQuery(patch) { this.calls.push(['setQuery', patch]); },
    onLeave: () => () => {},
    link: () => () => {},
  };
  const harnessPlatform = query.get('ipad') === '1' ? {...platform, isIPad: true, isIOS: true} : platform;
  registry.provide('router', () => router);
  registry.provide('feedback', () => feedback);
  registry.provide('store', () => store);
  registry.provide('platform', () => harnessPlatform);
  registry.provide('desktop', () => ({available: false}));
  startDispatcher({platform: harnessPlatform});
  document.documentElement.dataset.posture = 'stage';

  const stage = await import('/src/stage/stage.js');
  const host = h('div', {class: 'roadmap-harness'});
  host.style.position = 'fixed';
  host.style.inset = '0';
  el.append(host);
  const view = await stage.mount(host, {name: 'stage', path: `/s/${id}`, params: {songId: id}, query: {}},
    {router, store, registry, feedback, platform: harnessPlatform, session: ts.session});
  if (!noPeaks) await ts.ready();

  const surfaceEl = () => document.querySelector('.stage-surface .roadmap');
  window.__roadmap = {
    ts, session: ts.session, view, router,
    surfaceEl,
    run: (cmd, args) => registry.run(cmd, {source: 'key', args}),
  };
  return window.__roadmap;
}
