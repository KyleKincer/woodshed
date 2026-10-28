// U3's harness (/__harness/display): the display primitives on fake data.
//   ?part=desk  (default) key-caps, tooltips, progress, the stage stepper, tabs, empty states, skeletons
//   ?part=stage readouts and beat lamps on every Stage layout × Distance (use with ?place=stage)
// The mount result (window.__harness.mounted) exposes the instances for the states in
// tests/fixture/states/U3.cjs: {kbds, rails, rings, stepper, tabs, lamps, readouts, unmount}.
import {Kbd} from '/src/ui/kbd.js';
import {tooltip} from '/src/ui/tooltip.js';
import {ProgressRail, ProgressRing, StageStepper} from '/src/ui/progress.js';
import {Tabs} from '/src/ui/tabs.js';
import {EmptyState} from '/src/ui/empty.js';
import {Skeleton} from '/src/ui/skeleton.js';
import {Readout} from '/src/ui/readout.js';
import {BeatLamps} from '/src/ui/beat-lamps.js';
import {createRegistry} from '/src/app/commands.js';
import {startDispatcher} from '/src/app/dispatch.js';

// Page layout only (the primitives bring their own CSS); tokens only.
const PAGE_CSS = `
  .u3 { display: flex; flex-direction: column; gap: var(--s6); padding: var(--s5); max-inline-size: 1280px; margin-inline: auto; }
  .u3 h1 { font-size: var(--fs-24); margin: 0; }
  .u3 > section > h2 { font-size: var(--fs-16); color: var(--ink-2); margin: 0 0 var(--s3); }
  .u3-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s4); }
  .u3-col { display: flex; flex-direction: column; gap: var(--s3); }
  .u3-card { padding: var(--s4); border: 1px solid var(--line); border-radius: var(--r-surface); background: var(--surface); min-inline-size: 0; }
  .u3-rail { inline-size: 240px; display: flex; flex-direction: column; gap: var(--s1); font-size: var(--fs-14); color: var(--ink-2); }
  .u3-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--s4); }
  .u3-list { display: flex; flex-direction: column; gap: var(--s2); }
  .u3-cells { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: var(--s1); }
  .u3-tip { min-block-size: var(--h-md); padding: 0 var(--s4); border: 1px solid var(--line-strong); border-radius: var(--r-control); background: var(--surface); color: var(--ink); font: inherit; }
  .u3-panel { padding: var(--s3) 0; color: var(--ink-2); }
  .u3-stage { display: flex; flex-direction: column; gap: var(--s5); padding: var(--s4); border: 1px solid var(--line); border-radius: var(--r-surface); background: var(--surface); }
  .u3-stage h3 { margin: 0; font-size: var(--fs-14); color: var(--ink-3); }
  .u3-hud { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--s5); }
  .u3-meter { font-size: var(--fs-12); color: var(--ink-3); }
`;

const STAGES = [{id: 'fetch', label: 'Fetch'}, {id: 'split', label: 'Split'}, {id: 'finish', label: 'Finish'}, {id: 'ready', label: 'Ready'}];

function desk(el, h, made) {
  const section = (id, title, ...children) => h('section', {class: 'u3-col', 'aria-labelledby': id}, h('h2', {id}, title), ...children);

  // Key-caps
  const caps = ['Mod+KeyK', 'Shift+Space', 'KeyL', '[', 'Digit5', 'Mod+Shift+KeyZ'].map(keys => Kbd({keys}));
  const forced = Kbd({keys: 'Space', force: true, testid: 'kbd-forced'});
  const alt = Kbd({keys: ['PageDown', 'ArrowRight']});
  made.kbds.push(...caps, forced, alt);
  const kbdRow = h('div', {class: 'u3-row', 'data-testid': 'kbd-row'}, ...caps.map(k => k.el), forced.el, alt.el,
    h('span', {'data-kbd-hints': ''}, Kbd({keys: 'Digit3', hint: true}).el));

  // Tooltips
  const tipButtons = [
    ['Zoom in', 'Zoom the chart in', '='],
    ['Loop', 'Loop this section', 'KeyL'],
    ['Search', 'Search songs', 'Mod+KeyK'],
  ].map(([label, text, kbd]) => {
    const b = h('button', {type: 'button', class: 'u3-tip', 'aria-label': label, 'data-testid': `tip-${label.toLowerCase().replace(/\s+/g, '-')}`}, label);
    made.offs.push(tooltip(b, {text, kbd}));
    return b;
  });

  // Progress
  const rail = (label, props) => {
    const r = ProgressRail({label, ...props});
    made.rails[label] = r;
    return h('div', {class: 'u3-rail'}, h('span', {}, label), r.el);
  };
  const rings = [
    ProgressRing({value: 0.62, size: 'sm', label: 'Loading 62%'}),
    ProgressRing({value: 0.62, label: 'Loading 62%'}),
    ProgressRing({value: 0.25, size: 'lg', label: 'Decoding 1 of 4'}),
    ProgressRing({value: null, size: 48, label: 'Preparing pitch-preserving playback', testid: 'ring-indeterminate'}),
  ];
  made.rings.push(...rings);
  const stepper = StageStepper({stages: STAGES, current: 'split', percent: 46, label: 'Harbor Lights', testid: 'stepper'});
  const failed = StageStepper({stages: STAGES, current: 'finish', failed: true, label: 'Glasshouse'});
  made.stepper = stepper;

  // Tabs
  const panel = h('div', {class: 'u3-panel', id: 'u3-panel', role: 'tabpanel', 'data-testid': 'tab-panel'}, 'Map');
  const posture = Tabs({
    tabs: ['map', 'chart', 'details'].map(id => ({id, label: id[0].toUpperCase() + id.slice(1), controls: 'u3-panel'})),
    value: 'map', variant: 'posture', label: 'Edit', testid: 'tabs-posture',
    onChange: id => { panel.textContent = id[0].toUpperCase() + id.slice(1); panel.setAttribute('aria-labelledby', posture.tabId(id)); },
  });
  panel.setAttribute('aria-labelledby', posture.tabId('map'));
  const sectionTabs = Tabs({
    tabs: [{id: 'general', label: 'General'}, {id: 'audio', label: 'Audio'}, {id: 'pedals', label: 'Pedals', disabled: true}, {id: 'device', label: 'This device'}],
    value: 'audio', variant: 'section', label: 'Settings', activation: 'auto', testid: 'tabs-section',
  });
  made.tabs.push(posture, sectionTabs);

  // Empty states
  const empties = [
    EmptyState({title: 'No drum chart yet', actions: [{label: 'Find a chart', variant: 'primary', onClick() {}}, {label: 'Import a file', onClick() {}}, {label: 'Write one', variant: 'quiet', onClick() {}}]}),
    EmptyState({title: 'No results', body: ['No songs match "', h('b', {}, 'zzzz'), '".'], actions: [{label: 'Clear search', onClick() {}}]}),
  ];

  // Skeletons
  const cards = Skeleton({shape: 'card', count: 4, label: 'Loading songs…'});
  const rows = Skeleton({shape: 'row', count: 2});
  const lines = Skeleton({shape: 'text', count: 3});
  const cells = Skeleton({shape: 'cell', count: 8});

  el.append(h('div', {class: 'u3'},
    h('h1', {}, 'Display primitives'),
    section('u3-kbd', 'Key-caps', kbdRow),
    section('u3-tooltip', 'Tooltips', h('div', {class: 'u3-row'}, ...tipButtons)),
    section('u3-progress', 'Progress',
      h('div', {class: 'u3-row'},
        rail('Uploading', {value: 0.39}),
        rail('Waiting', {value: 0, striped: true}),
        rail('Finishing', {value: null}),
        rail('Done', {value: 1})),
      h('div', {class: 'u3-row', 'data-testid': 'rings'}, ...rings.map(r => r.el))),
    section('u3-stepper', 'Stage stepper', h('div', {class: 'u3-col'}, stepper.el, failed.el)),
    section('u3-tabs', 'Tabs', h('div', {class: 'u3-card u3-col'}, posture.el, panel), h('div', {class: 'u3-card'}, sectionTabs.el)),
    section('u3-empty', 'Empty states', h('div', {class: 'u3-row'}, ...empties.map(e => h('div', {class: 'u3-card'}, e.el)))),
    section('u3-skeleton', 'Skeletons',
      h('div', {class: 'u3-grid', 'aria-busy': 'true', 'data-testid': 'skeleton-cards'}, cards.el),
      h('div', {class: 'u3-list'}, rows.el),
      lines.el,
      h('div', {class: 'u3-cells'}, cells.el)),
  ));
}

const LAYOUTS = ['band', 'rail'];
const DISTANCES = ['near', 'stand', 'kit'];

function stage(el, h, made) {
  const blocks = [];
  for (const layout of LAYOUTS) {
    for (const distance of DISTANCES) {
      const key = `${layout}-${distance}`;
      const r = {
        section: Readout({label: 'Section', value: 'Chorus', size: 'section', testid: `section-${key}`}),
        next: Readout({label: 'Next', value: 'Verse 2 in 2 · 1', size: 'sub', tone: 'now'}),
        position: Readout({label: 'Position', value: '13 · 2', sub: '0:26 / 1:04', size: 'position', mono: true, minCh: 7, subMinCh: 11, testid: `position-${key}`}),
        speed: Readout({label: 'Speed', value: '75%', sub: '84 bpm', size: 'speed', mono: true, minCh: 4, testid: `speed-${key}`}),
        speed100: Readout({label: 'Speed', value: '100%', sub: '112 bpm', size: 'speed', mono: true, tone: 'ink-3', minCh: 4}),
        loop: Readout({label: 'Loop', value: 'LOOP · Chorus', sub: 'Bars 13–20 · pass 3', size: 'loop'}),
      };
      made.readouts[key] = r;
      const lamps = {
        '4/4': BeatLamps({units: 4, groups: [1, 1, 1, 1], testid: `lamps-44-${key}`}),
        '7/8': BeatLamps({units: 7, groups: [2, 2, 3], testid: `lamps-78-${key}`}),
        '6/8': BeatLamps({units: 6, groups: [3, 3]}),
        '15/16': BeatLamps({units: 15, groups: [3, 3, 3, 3, 3], testid: `lamps-1516-${key}`}),
      };
      lamps['4/4'].frame(1);
      lamps['7/8'].frame(3);
      lamps['6/8'].frame(0);
      lamps['15/16'].frame(7);
      made.lamps[key] = lamps;
      blocks.push(h('div', {class: 'u3-stage', dataset: {stageLayout: layout, distance}, 'data-testid': `stage-${key}`},
        h('h3', {}, `${layout} · ${distance}`),
        h('div', {class: 'u3-hud', role: 'group', 'aria-label': `Now playing (${layout}, ${distance})`},
          r.section.el, r.next.el, r.position.el, r.speed.el, r.speed100.el, r.loop.el),
        h('div', {class: 'u3-hud'}, ...Object.entries(lamps).map(([meter, l]) => h('div', {class: 'u3-col'}, h('span', {class: 'u3-meter'}, meter), l.el)))));
    }
  }
  const count = Readout({label: 'Count-in', value: '3', sub: 'Count-in · bar 13', size: 'count', tone: 'now', mono: true, minCh: 1, testid: 'count'});
  made.readouts.count = count;
  el.append(h('div', {class: 'u3'}, h('h1', {}, 'Stage readouts and lamps'), ...blocks,
    h('div', {class: 'u3-stage', dataset: {stageLayout: 'band', distance: 'stand'}}, h('h3', {}, 'count-in'), count.el)));
}

export default async function mount(el, {query, h}) {
  const style = h('style', {}, PAGE_CSS);
  document.head.append(style);
  const made = {kbds: [], offs: [], rails: {}, rings: [], stepper: null, tabs: [], lamps: {}, readouts: {}};
  // The app's keyboard dispatcher (an empty registry): Escape reaches tooltips through its overlay stack.
  const stopDispatcher = startDispatcher({registry: createRegistry()});
  if ((query.get('part') ?? 'desk') === 'stage') stage(el, h, made);
  else desk(el, h, made);
  return {
    ...made,
    unmount() {
      for (const off of made.offs) off();
      stopDispatcher();
      style.remove();
      el.replaceChildren();
    },
  };
}
