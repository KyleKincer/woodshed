// ST11's harness (/__harness/stems): the Stems surface inside the real Stage (src/stage/stage.js, which
// finds src/stage/surfaces/stems-surface.js by its contract path) on a real song session
// (tests/helpers/test-session.js in the browser) over the fixture's synthetic stems, so every row's
// waveform has shape. The song opens on the Stems surface (practice.surface = 'stems'), with the app
// registry, the dispatcher, feedback and the platform, so the strip's viewport bracket, the glass
// pill, the 'stage.stems' scope and every key work as in the app. Load it with ?place=stage.
//
// Query:
//   mapped=0              a song nobody mapped (times on the ruler, no grid)
//   scenario=             fresh (default) | looping (the Chorus looped) | mix (drums out, bass soloed)
//   cue=<s>               the cue
//   zoom=<s>              prefs.stems.zoom before mounting (the visible seconds; 'fit' → null)
//   grid=off|bar|beat|half|quarter, snap=0, follow=0   prefs.stems before mounting
// window.__stems = {ts, session, view, registry, run(id, args), root()} for the states
// (tests/fixture/states/ST11.cjs; use fx-audio=manual so audio time moves only on request).
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

const GRID = ['off', 'bar', 'beat', 'half', 'quarter'];

function practice(fields = {}) {
  return {v: 2, cue: 0, rate: 1, tracks: [], minusMe: false, trainer: null, spots: [], markers: [], surface: 'stems', ...fields,
    loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none', ...(fields.loop ?? {})}};
}

const SCENARIOS = {
  fresh: () => practice(),
  looping: () => practice({cue: 32, loop: {on: true, a: 32, b: 48}}),
  mix: () => practice({cue: 20, tracks: [
    {name: 'drums', volume: 1, muted: true, soloed: false}, {name: 'bass', volume: 0.8, muted: false, soloed: true},
    {name: 'vocals', volume: 1, muted: false, soloed: false}, {name: 'other', volume: 1, muted: false, soloed: false}]}),
};

export default async function mount(el, {query, h}) {
  prefs.update((d) => {
    d.practice.distance = 'stand';
    d.practice.focus = false;
    if (query.has('zoom')) d.stems.zoom = query.get('zoom') === 'fit' ? null : Number(query.get('zoom')) || null;
    if (GRID.includes(query.get('grid'))) d.stems.grid = query.get('grid');
    if (query.has('snap')) d.stems.snap = query.get('snap') !== '0';
    if (query.has('follow')) d.stems.follow = query.get('follow') !== '0';
  });
  const mapped = query.get('mapped') !== '0';
  const scenario = SCENARIOS[query.get('scenario')] ? query.get('scenario') : 'fresh';
  const stored = SCENARIOS[scenario]();
  if (query.has('cue')) stored.cue = Number(query.get('cue')) || 0;
  const id = 'glasshouse';
  const duration = 128;
  const ts = await createTestSession({
    id, title: 'Glasshouse', artist: 'Northbound', mapped, duration, practice: stored,
    media: {
      async signKeys(keys) {
        return Object.fromEntries(keys.map((key) => [key, stemUrl({id, duration, bpm: 120, offset: 0}, key.split('/').pop())]));
      },
    },
    load: false,
    status: (text, options) => feedback.status(text, options),
  });

  const router = {
    calls: [],
    navigate(to, opts) { this.calls.push(['navigate', to, opts ?? null]); },
    back(opts) { this.calls.push(['back', opts ?? null]); },
    setQuery(patch) { this.calls.push(['setQuery', patch]); },
    onLeave: () => () => {},
    link: () => () => {},
  };
  registry.provide('router', () => router);
  registry.provide('feedback', () => feedback);
  registry.provide('store', () => store);
  registry.provide('platform', () => platform);
  registry.provide('desktop', () => ({available: false}));
  startDispatcher({platform});
  document.documentElement.dataset.posture = 'stage';

  const stage = await import('/src/stage/stage.js');
  const host = h('div', {class: 'stems-harness'});
  host.style.position = 'fixed';
  host.style.inset = '0';
  el.append(host);
  const view = await stage.mount(host, {name: 'stage', path: `/s/${id}`, params: {songId: id}, query: {}},
    {router, store, registry, feedback, platform, session: ts.session});
  await ts.ready();
  window.__stems = {
    ts, session: ts.session, view, registry, router,
    run: (cmd, args) => registry.run(cmd, {source: 'key', args}),
    root: () => document.querySelector('section.stems'),
  };
  return window.__stems;
}
