// ST2's harness (/__harness/wave): the waveform renderer, grid, loop handles, pinch and
// press recogniser on synthetic stems over a real SongMapStore (64 bars of 4/4 at 120 bpm,
// 2 s per bar). States: tests/fixture/states/ST2.cjs.
//   Stems panel   drawRows (drums on, bass OUT, guitar SOLO, vocals dim) + drawGrid (beats) +
//                 mountLoopHandles (bar snap; Alt → beats; Shift → none) over bars 2–3
//   Road map      four bar cells of drawEnvelopeStack (drums primary, bass muted)
//   Strip         drawStripWave of the mix
//   Pinch         a chart stand-in, 120% scaled 80–200% with a live CSS transform
//   Press         a pad that logs every recognised gesture
// Query: ?seconds=16 (song length), ?loop=a,b (seconds).
import {createPeaks, drawEnvelopeStack, drawGrid, drawRows, drawStripWave} from '../../../src/stage/wave-render.js';
import {gridTicks, snapTime} from '../../../src/stage/grid.js';
import {mountLoopHandles} from '../../../src/stage/loop-handles.js';
import {createPinch} from '../../../src/stage/pinch.js';
import {createPressRecognizer} from '../../../src/stage/press.js';
import {mapStore, sectioned} from '../../fixtures/maps.js';

const SAMPLE_RATE = 22050;
const STEMS = ['drums', 'bass', 'guitar', 'vocals', 'piano', 'other'];

/** Deterministic synthetic stems: drum hits on the beats, a bass line, strummed guitar, a sung line. */
function synthesize(seconds) {
  const length = Math.round(seconds * SAMPLE_RATE);
  const make = fill => {
    const buffer = new AudioBuffer({length, sampleRate: SAMPLE_RATE, numberOfChannels: 2});
    const l = buffer.getChannelData(0), r = buffer.getChannelData(1);
    fill(l, r);
    return buffer;
  };
  let seed = 12345;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 * 2 - 1; };
  const beat = 0.5;
  const buffers = {
    drums: make((l, r) => {
      for (let i = 0; i < length; i++) {
        const t = i / SAMPLE_RATE, phase = t % beat, accent = Math.floor(t / beat) % 4 === 0 ? 1 : 0.6;
        const v = rand() * Math.exp(-phase * 30) * accent + rand() * 0.04 * Math.exp(-((t + 0.25) % beat) * 60);
        l[i] = v; r[i] = v * 0.9;
      }
    }),
    bass: make((l, r) => {
      for (let i = 0; i < length; i++) {
        const t = i / SAMPLE_RATE, note = [55, 55, 73.4, 65.4][Math.floor(t / 2) % 4];
        const v = Math.sin(2 * Math.PI * note * t) * (0.35 + 0.25 * Math.exp(-(t % 1) * 4));
        l[i] = v; r[i] = v;
      }
    }),
    guitar: make((l, r) => {
      for (let i = 0; i < length; i++) {
        const t = i / SAMPLE_RATE, strum = Math.exp(-(t % 1) * 3);
        const v = (Math.sin(2 * Math.PI * 196 * t) + 0.5 * Math.sin(2 * Math.PI * 247 * t)) * 0.3 * strum + rand() * 0.02;
        l[i] = v; r[i] = v * 0.8;
      }
    }),
    vocals: make((l, r) => {
      for (let i = 0; i < length; i++) {
        const t = i / SAMPLE_RATE, phrase = t % 8 < 6 ? Math.sin(Math.PI * (t % 2) / 2) : 0;
        const v = Math.sin(2 * Math.PI * 330 * t) * 0.45 * phrase;
        l[i] = v; r[i] = v;
      }
    }),
    piano: make((l, r) => {
      for (let i = 0; i < length; i++) {
        const t = i / SAMPLE_RATE, v = Math.sin(2 * Math.PI * 262 * t) * 0.25 * Math.exp(-(t % 2) * 1.5);
        l[i] = v; r[i] = v;
      }
    }),
    other: make((l, r) => {
      for (let i = 0; i < length; i++) { const v = rand() * 0.08; l[i] = v; r[i] = v; }
    }),
  };
  return STEMS.map(name => ({name, buffer: buffers[name]}));
}

/** A canvas sized to its CSS box in device pixels; returns {canvas, ctx, w, h, dpr}. */
function sized(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  return {canvas, ctx, w, h, dpr};
}

const fmt = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;

export default async function mount(el, {query, h}) {
  const seconds = Math.max(4, Math.min(120, Number(query.get('seconds')) || 16));
  const map = mapStore(sectioned, {duration: seconds});
  const peaks = createPeaks(synthesize(seconds));
  const [qa, qb] = (query.get('loop') ?? '2,6').split(',').map(Number);
  const width = Math.max(320, Math.min(1100, el.clientWidth - 48));

  const style = (node, css) => { node.style.cssText = css; return node; };
  const section = (id, title, ...children) => h('section', {'aria-labelledby': id, class: 'st2-section'},
    style(h('h2', {id}, title), 'font-size: var(--fs-20); margin: var(--s5) 0 var(--s3)'), ...children);

  // ---- Stems panel: rows + grid + loop handles
  const ROWS = [
    {name: 'drums', color: 'drums', state: 'on'}, {name: 'bass', color: 'bass', state: 'out'},
    {name: 'guitar', color: 'guitar', state: 'solo'}, {name: 'vocals', color: 'vocals', state: 'dim'},
  ];
  const ROW_H = 72;
  const stemsHost = style(h('div', {'data-testid': 'stems-panel'}), `position: relative; width: ${width}px; height: ${ROWS.length * ROW_H}px; background: var(--surface); border-radius: var(--r-surface); overflow: hidden`);
  const stemsCanvas = h('canvas', {role: 'img', 'aria-label': 'Stem waveforms: drums, bass (muted), guitar (solo), vocals', 'data-testid': 'stems-canvas'});
  stemsHost.append(stemsCanvas);
  const loopText = h('p', {id: 'st2-loop-readout', 'aria-live': 'polite', class: 'tabular'}, '');
  const phaseText = h('p', {id: 'st2-loop-phase'}, 'No edit yet');
  const t0 = 0, t1 = seconds;
  const toX = t => stemsHost.getBoundingClientRect().left + ((t - t0) / (t1 - t0)) * width;
  const toT = x => t0 + ((x - stemsHost.getBoundingClientRect().left) / width) * (t1 - t0);
  const rowRects = () => {
    const r = stemsHost.getBoundingClientRect();
    return ROWS.map((_, i) => new DOMRect(r.left, r.top + i * ROW_H, width, ROW_H));
  };
  const showLoop = (a, b, phase) => {
    loopText.textContent = `Loop ${fmt(a)}–${fmt(b)}`;
    stemsHost.dataset.loopA = String(Math.round(a * 1000) / 1000);
    stemsHost.dataset.loopB = String(Math.round(b * 1000) / 1000);
    phaseText.textContent = `Last edit: ${phase}`;
  };
  const loop = mountLoopHandles(stemsHost, {
    toX, toT, rows: rowRects,
    snap: (t, {alt, shift}) => (shift ? Math.max(0, t) : snapTime(map, t, alt ? 'beat' : 'bar')),
    onEdit: ({a, b, phase}) => { showLoop(a, b, phase); if (phase === 'commit') loop.set({a, b}); },
    playing: () => stemsHost.dataset.playing === 'true',
  });

  const drawStems = () => {
    const {ctx, dpr} = sized(stemsCanvas, width, ROWS.length * ROW_H);
    drawRows(ctx, {rows: ROWS.map((r, i) => ({...r, y: i * ROW_H, h: ROW_H})), t0, t1, width, dpr, peaks});
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawGrid(ctx, {ticks: gridTicks(map, t0, t1, 'beat'), t0, t1, w: width, h: ROWS.length * ROW_H});
    stemsCanvas.dataset.peaksReady = String(peaks.ready);
  };

  // ---- Road map cells
  const CELL_H = 88, cells = 4, cellW = Math.floor((width - (cells - 1) * 8) / cells);
  const roadmap = style(h('div', {role: 'list', 'aria-label': 'Bars 1 to 4'}), `display: flex; gap: var(--s2); width: ${width}px`);
  const cellCanvases = [];
  for (let i = 0; i < cells; i++) {
    const canvas = h('canvas', {role: 'img', 'aria-label': `Bar ${i + 1} stems`, 'data-testid': `cell-${i + 1}`});
    cellCanvases.push(canvas);
    roadmap.append(style(h('div', {role: 'listitem'},
      style(h('span', {class: 'tabular'}, `${i + 1}`), 'position: absolute; left: var(--s2); top: var(--s1); font-size: var(--fs-14); color: var(--ink-3)'),
      canvas), `position: relative; width: ${cellW}px; height: ${CELL_H}px; background: var(--surface); border-radius: var(--r-control)`));
  }
  const drawCells = () => {
    map.bars.slice(0, cells).forEach((bar, i) => {
      const {ctx, dpr} = sized(cellCanvases[i], cellW, CELL_H);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawEnvelopeStack(ctx, {x: 4, y: 24, w: cellW - 8, h: CELL_H - 32, t0: bar.t0, t1: bar.t1, dpr, peaks, stems: [
        {name: 'drums', color: 'drums', state: 'on', primary: true}, {name: 'bass', color: 'bass', state: 'out'},
        {name: 'guitar', color: 'guitar', state: 'on'}, {name: 'vocals', color: 'vocals', state: 'on'}]});
      cellCanvases[i].dataset.peaksReady = String(peaks.ready);
    });
  };

  // ---- Strip
  const stripCanvas = h('canvas', {role: 'img', 'aria-label': 'Song overview waveform', 'data-testid': 'strip'});
  const strip = style(h('div', {}, stripCanvas), `width: ${width}px; height: 48px; background: var(--surface-2); border-radius: var(--r-control); overflow: hidden`);
  const drawStrip = () => {
    const {ctx, dpr} = sized(stripCanvas, width, 48);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawStripWave(ctx, {w: width, h: 48, peaks, duration: seconds, dpr});
    stripCanvas.dataset.peaksReady = String(peaks.ready);
  };

  // ---- Pinch
  let scale = 1.2;
  const pinchLabel = h('span', {class: 'tabular'}, 'Chart 120%');
  const score = style(h('div', {'data-testid': 'pinch-content'}, pinchLabel), 'display: grid; place-items: center; width: 100%; height: 100%; font-size: var(--fs-24); background: var(--surface-2); border-radius: var(--r-control)');
  const pinchPad = style(h('div', {'data-testid': 'pinch-pad', 'aria-label': 'Pinch to resize the chart', role: 'group'}, score),
    `width: ${Math.min(width, 480)}px; height: 200px; overflow: hidden; touch-action: pan-y; border: 1px solid var(--line); border-radius: var(--r-surface)`);
  pinchPad.dataset.scale = String(scale);
  const pinch = createPinch(pinchPad, {
    base: scale, min: 0.8, max: 2, preview: score,
    onPreview: ({value}) => { pinchPad.dataset.preview = value.toFixed(3); },
    onCommit: ({value}) => {
      scale = Math.round(value * 100) / 100;
      pinch.setBase(scale);
      pinchPad.dataset.scale = String(scale);
      pinchLabel.textContent = `Chart ${Math.round(scale * 100)}%`;
    },
  });

  // ---- Press
  const pressLog = h('ol', {role: 'log', 'aria-label': 'Recognised gestures', 'data-testid': 'press-log'});
  const pressPad = style(h('div', {tabindex: '0', role: 'application', 'aria-label': 'Press test area: tap, double-tap, long-press, drag or open the menu', 'data-testid': 'press-pad'},
    style(h('span', {}, 'Tap · double-tap · long-press · drag · right-click'), 'color: var(--ink-3)')),
  `display: grid; place-items: center; width: ${Math.min(width, 480)}px; height: 160px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-surface)`);
  const record = name => (e, info) => {
    const detail = info ? Object.entries(info).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `${k}=${typeof v === 'number' ? Math.round(v) : v}`).join(' ') : '';
    pressLog.append(h('li', {'data-gesture': name, 'data-pointer': e.pointerType}, `${name} · ${e.pointerType}${e.keyboard ? ' · keyboard' : ''}${detail ? ` · ${detail}` : ''}`));
    pressPad.dataset.lastGesture = name;
    while (pressLog.children.length > 40) pressLog.firstElementChild.remove();
  };
  const offPress = createPressRecognizer(pressPad, {
    onTap: record('tap'), onDouble: record('double'), onLongStart: record('longStart'), onLongDrag: record('longDrag'),
    onLongEnd: record('longEnd'), onMenu: record('menu'), onDragStart: record('dragStart'), onDragEnd: record('dragEnd'),
  });

  el.append(
    style(h('h1', {}, 'Waveform, grid, loop handles, pinch and press'), 'font-size: var(--fs-24)'),
    section('st2-stems', 'Stem rows with grid and loop', stemsHost, loopText, phaseText),
    section('st2-roadmap', 'Road map cells', roadmap),
    section('st2-strip', 'Strip overview', strip),
    section('st2-pinch', 'Pinch', pinchPad),
    section('st2-press', 'Press', pressPad, pressLog),
  );

  drawStems();
  drawCells();
  drawStrip();
  loop.set({a: qa, b: qb});
  showLoop(qa, qb, 'none');
  phaseText.textContent = 'No edit yet';

  return {
    loop,
    peaks,
    setPlaying(on) { stemsHost.dataset.playing = String(!!on); loop.update(); },
    destroy() { loop.destroy(); pinch.destroy(); offPress(); },
  };
}
