// ST8b's harness (/__harness/sheets-b): the real Stage frame (src/stage/stage.js) on a real song
// session (tests/helpers/test-session.js over the fixture's synthetic stems) with the app registry,
// dispatcher and feedback, so the Spots list, the Notes card, Tap the beat and Get bars open through
// the frame's own openSheet: rail popovers left of their control on a laptop, bottom sheets on the
// band, the Notes card in the music's notes host. Load it with ?place=stage (the Stage tokens).
// States: tests/fixture/states/ST8b.cjs (use fx-audio=manual so audio time moves only on request).
//
// Query:
//   sheet=spots|notes|tapBeat|getBars   the sheet opened once the audio is ready (default: none)
//   mapped=0              a song nobody mapped (Wave page, seconds, the Get bars intro)
//   spots=0               no saved spots (the empty list)
//   devices=online|offline   a paired computer (B5): web detection runs there
// window.__sheetsB = {ts, session, view, router, registry, run(id, args), open(name)}
import {registry} from '/src/app/commands.js';
import '/src/app/global-commands.js';
import '/src/stage/transport-commands.js';
import '/src/stage/commands.js';
import {startDispatcher} from '/src/app/dispatch.js';
import * as feedback from '/src/app/feedback.js';
import {platform} from '/src/app/platform.js';
import {store} from '/src/app/store.js';
import {createTestSession} from '/tests/helpers/test-session.js';
import {stemUrl} from '/tests/fixture/audio.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const DAY = 86_400_000;
const SHEETS = ['spots', 'notes', 'tapBeat', 'getBars'];

const SPOTS = [
  {id: 'spot-fill', name: 'Fill into the chorus', a: 28, b: 32, rate: 1, passes: 3, lastAt: NOW - 3 * 3_600_000, updatedAt: NOW - DAY},
  {id: 'spot-bridge', name: 'Bridge walk-up', a: 80, b: 84, rate: 0.85, passes: 14, lastAt: NOW - 2 * DAY, updatedAt: NOW - 2 * DAY,
    note: 'Lead with the left hand into the crash.'},
  {id: 'spot-outro', name: 'Outro build', a: 112, b: 128, rate: 0.9, passes: 0, updatedAt: NOW - 5 * DAY},
];
const MARKERS = [{id: 'marker-groove', t: 12, label: 'Groove', updatedAt: 1}, {id: 'marker-fill', t: 40, label: 'Fill', updatedAt: 1}];

function practiceFor({mapped, spots}) {
  return {v: 2, cue: 0, rate: 1, tracks: [], minusMe: false, trainer: null,
    loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none'},
    spots: spots ? structuredClone(SPOTS) : [], markers: mapped ? [] : structuredClone(MARKERS)};
}

export default async function mount(el, {query, h}) {
  const mapped = query.get('mapped') !== '0';
  const spots = query.get('spots') !== '0';
  const devices = ['online', 'offline'].includes(query.get('devices')) ? query.get('devices') : [];
  const id = 'glasshouse';
  const duration = 128;
  const ts = await createTestSession({
    id, title: 'Glasshouse', artist: 'Northbound', mapped, duration,
    practice: practiceFor({mapped, spots}),
    devices,
    song: {notes: 'Watch the flam into the chorus.\nRide bell on the triplet section.', musicalKey: 'A minor', tuning: 'Standard', tags: ['drums', 'setlist']},
    media: {
      async signKeys(keys) {
        return Object.fromEntries(keys.map((key) => [key, stemUrl({id, duration, bpm: 120, offset: 0}, key.split('/').pop())]));
      },
    },
    load: false,
    status: (text, options) => feedback.status(text, options),
  });
  // Get bars reads the paired computers from the app store (data.js keeps it there in the app).
  store.library.devices.value = ts.library.devices.peek();

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
  const host = h('div', {class: 'sheets-b-harness'});
  host.style.position = 'fixed';
  host.style.inset = '0';
  el.append(host);
  const view = await stage.mount(host, {name: 'stage', path: `/s/${ts.id}`, params: {songId: ts.id}, query: {}},
    {router, store, registry, feedback, platform, session: ts.session});
  await ts.ready();

  const COMMAND = {spots: 'spot.list', notes: 'stage.notes', tapBeat: 'stage.tapBeat', getBars: 'stage.getBars'};
  const api = {
    ts, session: ts.session, view, router, registry,
    run: (cmd, args) => registry.run(cmd, {source: 'key', args}),
    open: (name) => registry.run(COMMAND[name], {source: 'pointer'}),
  };
  window.__sheetsB = api;
  const sheet = query.get('sheet');
  if (SHEETS.includes(sheet)) api.open(sheet);
  return api;
}
