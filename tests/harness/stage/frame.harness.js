// ST4's harness (/__harness/frame): the Stage frame (src/stage/stage.js) mounted full-window on a
// real song session (tests/helpers/test-session.js `createTestSession`, browser-safe: silent stems
// on the page's AudioContext) with the app registry, dispatcher, feedback and platform. The
// rehearsal song (64 bars, 8 sections) unless told otherwise. Load it with ?place=stage so the
// Stage tokens apply (the harness host sets html[data-place=stage][data-stage-theme=dark]).
//
// Query:
//   mapped=0          a song nobody mapped (the Wave page placeholder, time readouts)
//   practice=resume   saved practice: the Chorus looped at 75 % with the drums out (the resume chip)
//   error=storage     signing the stems fails (the load error in the music area)
//   error=missing     no stem URLs (the missing-stems error with Re-split)
//   loading=1         signing never answers (the interactive loading state)
//   review=1          an unconfirmed search (the "Is this the right recording?" banner)
//   offer=1           "Bars found while you were away" in the status line, with [Use them] [Not now]
//   markers=1         an unmapped song with two markers that becomes mapped (the markers offer)
//   distance=near|stand|kit, focus=1   device prefs before mounting
//   ipad=1            platform.isIPad (Esc never leaves)
// window.__frame = {ts, view, router, registry, run(id, args)} for the states (tests/fixture/states/ST4.cjs).
//
// stage.js imports ST5's hud.js and controls.js and ST6's strip.js (same-wave peers): the states
// declare them in opts.requires. Surfaces, menus and sheets of later waves render "Not built yet".
import {registry} from '/src/app/commands.js';
import '/src/app/global-commands.js';
import '/src/stage/transport-commands.js';
import '/src/stage/commands.js';
import {startDispatcher} from '/src/app/dispatch.js';
import * as feedback from '/src/app/feedback.js';
import {platform} from '/src/app/platform.js';
import {prefs} from '/src/app/prefs.js';
import {signal, store} from '/src/app/store.js';
import {createTestSession} from '/tests/helpers/test-session.js';
import {sectioned} from '/tests/fixtures/maps.js';

const SECTION_LEN = 16;   // the rehearsal song: 8 bars of 2 s per section
const CHORUS = {a: 2 * SECTION_LEN, b: 3 * SECTION_LEN};

function practiceFor(query) {
  if (query.get('practice') === 'resume') {
    return {v: 2, cue: CHORUS.a, rate: 0.75, loop: {on: true, a: CHORUS.a, b: CHORUS.b, eachPassCount: true, playTimes: 0, between: 'none'},
      tracks: [{name: 'drums', volume: 1, muted: true, soloed: false}], minusMe: true, trainer: null, spots: [], markers: []};
  }
  if (query.get('markers') === '1') {
    return {v: 2, cue: 0, rate: 1, loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none'}, tracks: [], minusMe: false, trainer: null,
      spots: [], markers: [{id: 'm1', t: 16, label: 'Verse', updatedAt: 1}, {id: 'm2', t: 32, label: 'Chorus', updatedAt: 1}]};
  }
  return null;
}

function mediaFor(query) {
  const error = query.get('error');
  if (error === 'storage') return {signKeys: async () => { throw new Error('Storage is unreachable (harness).'); }};
  if (error === 'missing') return {signKeys: async () => ({})};
  if (query.get('loading') === '1') return {signKeys: () => new Promise(() => {})};
  return undefined;
}

export default async function mount(el, {query, h}) {
  const distance = query.get('distance');
  prefs.update((d) => {
    d.practice.distance = ['near', 'stand', 'kit'].includes(distance) ? distance : 'stand';
    d.practice.focus = query.get('focus') === '1';
  });
  const review = query.get('review') === '1';
  const markers = query.get('markers') === '1';
  const ts = await createTestSession({
    mapped: !(query.get('mapped') === '0' || markers),
    practice: practiceFor(query),
    media: mediaFor(query),
    load: false,
    status: (text, options) => feedback.status(text, options),
    title: review ? 'Harbor Lights — Ada Moreno (Official Audio)' : 'Glasshouse',
    artist: review ? '' : 'Northbound',
    ...(review ? {recordingUnconfirmed: true, duration: 221, song: {provider: 'YouTube', source: {type: 'search', value: 'harbor lights ada moreno'}}} : {}),
  });
  if (query.get('offer') === '1') {
    ts.session.detect = {...ts.session.detect, offer: signal({jobId: 'harness-job', beats: []}), dismissOffer: () => {}};
  }

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
  const host = h('div', {class: 'frame-harness'});
  host.style.position = 'fixed';
  host.style.inset = '0';
  el.append(host);
  const view = await stage.mount(host, {name: 'stage', path: `/s/${ts.id}`, params: {songId: ts.id}, query: {}},
    {router, store, registry, feedback, platform: harnessPlatform, session: ts.session});

  if (!query.get('error') && query.get('loading') !== '1') await ts.ready();
  if (query.get('offer') === '1') {
    feedback.status('Bars found while you were away', {action: {label: 'Use them', run() {}}, key: 'detect-offer', durationMs: Infinity});
  }
  if (markers) ts.session.mapChange('Bars found', (m) => m.adopt(structuredClone(sectioned.tempo.songMap)));
  window.__frame = {ts, view, router, registry, run: (id, args) => registry.run(id, {source: 'key', args})};
  return window.__frame;
}
