// ST6's harness (/__harness/strip): the song strip on a real song session (tests/helpers/test-session.js
// in the browser over the fixture's synthetic stems, so the overview waveform has shape), in the
// Stage frame's slot: under the music on the rail (the music column is the viewport minus the
// 264 px rail) or above a dock placeholder on the band. The app registry carries the transport
// and Stage commands (focus.play/focus.loop, stage.getBars, sections.keepAll/review) and the
// dispatcher runs, so the stage.strip focus scope works as in the app.
// States: tests/fixture/states/ST6.cjs (use fx-audio=manual so audio time moves only on request).
//
// Query:
//   layout=band|rail      default: rail on a wide viewport, band otherwise (layout.js's rule)
//   song=sections|many|plain|pickup   the rehearsal song (8 sections), 32 two-bar parts (they overflow),
//                         the rehearsal map without sections, the pickup map (default sections)
//   mapped=0              a song nobody mapped (the waveform and the "No bar grid" chip)
//   scenario=             fresh (default) | looping (the Chorus loop, two spots, a marker) |
//                         markers (unmapped markers) | suggest (suggested sections) | stems (a viewport window)
//   cue=<s>               the cue
// window.__strip = {ts, session, strip, sheets, scrubs, windows}
import {registry} from '../../../src/app/commands.js';
import {startDispatcher} from '../../../src/app/dispatch.js';
import {signal} from '../../../src/app/store.js';
import '../../../src/stage/transport-commands.js';
import '../../../src/stage/commands.js';
import {mountStrip} from '../../../src/stage/strip.js';
import {createTestSession, waitForLoad} from '../../helpers/test-session.js';
import {stemUrl} from '../../fixture/audio.js';
import {pickup, sectioned} from '../../fixtures/maps.js';

const clone = (v) => structuredClone(v);

function tempoFor(song) {
  if (song === 'pickup') return clone(pickup.tempo);
  const tempo = clone(sectioned.tempo);
  if (song === 'plain') for (const m of tempo.songMap.measures) m.label = '';
  if (song === 'many') tempo.songMap.measures.forEach((m, i) => { m.label = i % 2 === 0 ? `Part ${i / 2 + 1}` : ''; });
  return tempo;
}

function practice(fields = {}) {
  return {v: 2, cue: 0, rate: 1, tracks: [], minusMe: false, trainer: null, spots: [], markers: [], ...fields,
    loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none', ...(fields.loop ?? {})}};
}

const SCENARIOS = {
  fresh: () => practice(),
  looping: () => practice({cue: 32, loop: {on: true, a: 32, b: 48},
    spots: [{id: 'spot-fill', name: 'Fill into the chorus', a: 28, b: 32, rate: 0.8, passes: 3, updatedAt: 1},
      {id: 'spot-bridge', name: 'Bridge groove', a: 80, b: 96, rate: 0.9, passes: 1, updatedAt: 1}],
    markers: [{id: 'marker-flam', t: 41, label: 'Flam', updatedAt: 1}]}),
  markers: () => practice({cue: 20, markers: [{id: 'marker-1', t: 12, label: 'Groove', updatedAt: 1},
    {id: 'marker-2', t: 60, label: 'Marker 2', updatedAt: 1}, {id: 'marker-3', t: 96, label: 'Big ending', updatedAt: 1}]}),
  suggest: () => practice(),
  stems: () => practice({cue: 40}),
};

const SUGGESTION = {jobId: 'job-harness-sections', createdAt: 1, sections: [
  {t0: 0, label: 'Intro', confidence: 0.6}, {t0: 16, label: 'Verse', confidence: 0.7}, {t0: 48, label: 'Chorus', confidence: 0.8},
  {t0: 80, label: 'Bridge', confidence: 0.55}, {t0: 96, label: 'Chorus 2', confidence: 0.75}, {t0: 112, label: 'Outro', confidence: 0.6},
]};

export default async function mount(el, {query, h}) {
  const wide = innerWidth / innerHeight >= 1.15 && innerWidth >= 1000;
  const layout = query.get('layout') === 'band' || query.get('layout') === 'rail' ? query.get('layout') : wide ? 'rail' : 'band';
  const mapped = query.get('mapped') !== '0';
  const song = ['sections', 'many', 'plain', 'pickup'].includes(query.get('song')) ? query.get('song') : 'sections';
  const scenario = SCENARIOS[query.get('scenario')] ? query.get('scenario') : 'fresh';
  const stored = SCENARIOS[scenario]();
  if (query.has('cue')) stored.cue = Number(query.get('cue')) || 0;
  const duration = song === 'pickup' ? pickup.duration : sectioned.duration;
  const id = 'glasshouse';

  const ts = await createTestSession({
    id, title: 'Glasshouse', artist: 'Northbound',
    tempo: mapped ? tempoFor(song) : null, mapped, duration,
    practice: stored,
    ...(scenario === 'suggest' ? {sectionSuggestion: SUGGESTION} : {}),
    media: {
      // The fixture's synthetic stems (sections, phrases, dynamics), so the overview reads like a song.
      async signKeys(keys) {
        return Object.fromEntries(keys.map((key) => [key, stemUrl({id, duration, bpm: 120, offset: 0}, key.split('/').pop())]));
      },
    },
    load: false,
  });
  const session = ts.session;

  // The Stage frame (ST4's stage.js does this in the app).
  const root = document.documentElement;
  root.dataset.place = 'stage';
  root.dataset.posture = 'stage';
  root.dataset.stageTheme = root.dataset.stageTheme || 'dark';
  el.style.padding = '0';
  el.style.overflow = 'hidden';
  const sheets = [];
  const stage = {
    layout, anchors: new Map(),
    openSheet(name) { sheets.push(name); frame.dataset.sheet = name; return {close() {}}; },
    closeSheets() {},
  };
  registry.provide('session', () => session);
  registry.provide('transport', () => session.transport);
  registry.provide('stage', () => stage);
  startDispatcher({registry});

  const css = (node, text) => { node.style.cssText = text; return node; };
  const frame = css(h('div', {class: 'st6-frame', 'data-testid': 'stage-frame'}), 'position: fixed; inset: 0; display: flex; background: var(--bg); color: var(--ink);');
  frame.dataset.stageLayout = layout;
  frame.dataset.distance = 'stand';
  const note = (text) => css(h('p', {}, text), 'margin: 0; color: var(--ink-3); font: var(--fw-semibold) var(--fs-16)/1 var(--font-ui);');
  const music = css(h('div', {class: 'st6-music', 'data-testid': 'music'}, note('Music surface')),
    'flex: 1 1 auto; min-height: 0; display: grid; place-items: center; border: 1px dashed var(--line);');
  const slot = css(h('div', {class: 'st6-strip-slot', 'data-testid': 'strip-slot'}),
    'flex: none; height: 56px; min-width: 0; border-top: 1px solid var(--line); background: var(--bg);');
  stage.anchors.set('strip', slot);
  stage.anchors.set('getBars', slot);
  if (layout === 'rail') {
    const column = css(h('div', {class: 'st6-column'}, music, slot), 'flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column;');
    const rail = css(h('aside', {'aria-label': 'Stage rail'}, note('Rail')), 'flex: none; width: var(--rail-w); display: grid; place-items: center; background: var(--surface); border-left: 1px solid var(--line);');
    frame.append(column, rail);
  } else {
    css(frame, `${frame.style.cssText} flex-direction: column;`);
    const dock = css(h('div', {'data-testid': 'dock'}, note('Dock')), 'flex: none; height: 88px; display: grid; place-items: center; background: var(--surface); border-top: 1px solid var(--line);');
    frame.append(music, slot, dock);
  }
  el.append(frame);

  const scrubs = [];
  const windows = [];
  const viewport = signal(scenario === 'stems' ? {t0: 32, t1: 56} : null);
  const strip = mountStrip(slot, {
    session,
    onScrub: (t) => { scrubs.push(t); music.dataset.revealed = String(Math.round(t * 100) / 100); },
    viewport,
    onViewport: (v) => { windows.push(v); viewport.value = v; },
  });
  session.frame.start();

  window.__strip = {ts, session, strip, sheets, scrubs, windows, viewport};
  await waitForLoad(session);
  frame.dataset.loadPhase = session.load.peek().phase;
  session.load.subscribe((l) => { frame.dataset.loadPhase = l.phase; });
  session.transport.snapshot.subscribe((s) => { frame.dataset.transportPhase = s.phase; });
  frame.dataset.transportPhase = session.transport.snapshot.peek().phase;
  return {ts, strip};
}
