// @vitest-environment happy-dom
// score-view.js against a recording alphaTab fake (alphaTab cannot lay out in
// happy-dom). What these prove: the label fonts and their defaults, theme
// colours from the host's tokens, the first render waiting for the UI face
// (and tolerating no document.fonts), the loop edges and their hit areas, one
// render per configure + relayout, the theme listener re-engraving only when
// the host's tokens changed, and the width settle (a width change waits for the
// relayout that comes with it). Engraving geometry is probe-geometry.cjs.
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {installFontsStub, restoreDomShims} from './helpers/dom.js';

const apis = vi.hoisted(() => []);
vi.mock('@coderline/alphatab/font/Bravura.woff2?url', () => ({default: '/bravura.woff2'}));
vi.mock('@coderline/alphatab/font/Bravura.woff?url', () => ({default: '/bravura.woff'}));
vi.mock('../src/js/notation/alphatab-score.js', () => ({
  buildAlphaTabScore: (at, score, options) => ({score: {built: true, options}, beats: new Map(), bars: score.timeline.measures.map((_, i) => i), noteHits: new Map()}),
}));
vi.mock('@coderline/alphatab', () => {
  const NotationElement = new Proxy({}, {get: (_, name) => String(name)});
  class Settings {
    constructor() {
      this.core = {};
      this.player = {};
      this.display = {resources: {elementFonts: new Map()}};
      this.notation = {elements: new Map()};
    }
  }
  const event = () => { const fns = []; return {on: fn => fns.push(fn), fire: (...a) => fns.forEach(fn => fn(...a))}; };
  class AlphaTabApi {
    constructor(root, settings) {
      this.root = root; this.settings = settings;
      this.renderFinished = event(); this.error = event();
      this.updates = 0; this.renders = []; this.relayouts = 0; this.boundsLookup = null; this.destroyed = false;
      // Width: alphaTab renders at its container's width and re-engraves (triggerResize) when it changes.
      this.container = {width: 800, isVisible: true}; this.renderer = {width: 0}; this.resizes = 0;
      apis.push(this);
    }
    /** alphaTab's (throttled) container resize handler. */
    containerResized(width) { this.container.width = width; if (this.container.width !== this.renderer.width) this.triggerResize(); }
    triggerResize() { this.resizes += 1; this.renderer.width = this.container.width; }
    updateSettings() { this.updates += 1; this.snapshot = JSON.parse(JSON.stringify({scale: this.settings.display.scale, barsPerRow: this.settings.display.barsPerRow, fonts: Object.fromEntries(this.settings.display.resources.elementFonts), colours: this.colours()})); }
    colours() { const r = this.settings.display.resources; return {main: r.mainGlyphColor, lines: r.staffLineColor, bar: r.barNumberColor}; }
    renderScore(score) { this.renders.push(score); this.renderer.width = this.container.width; }
    render() { this.relayouts += 1; this.renderer.width = this.container.width; }
    /** Lays out `bars` bars, four to a 150 px system, 200 px each, and finishes the render. */
    finish(bars = 8) {
      this.boundsLookup = {
        findBeat: () => null,
        findMasterBarByIndex: k => {
          if (k >= bars) return null;
          const x = (k % 4) * 200, y = Math.floor(k / 4) * 150;
          return {realBounds: {x, y: y + 30, w: 200, h: 80}, staffSystemBounds: {realBounds: {x: 0, y, w: 800, h: 150}},
            visualBounds: {x, y: y + 20, w: 200, h: 100}, lineAlignedBounds: {x, y: y + 50, w: 200, h: 40}};
        },
      };
      this.renderFinished.fire();
    }
    destroy() { this.destroyed = true; }
  }
  return {
    Settings, AlphaTabApi, NotationElement,
    LayoutMode: {Page: 'page'}, StaveProfile: {Score: 'score'}, FontFileFormat: {Woff2: 'woff2', Woff: 'woff'},
    model: {Color: {fromJson: v => `color(${v})`}, Font: {fromJson: v => `font(${v})`}},
  };
});

import {createScoreView, DEFAULT_FONTS, HANDLE_HIT_PX, FONT_PROBE, FONT_WAIT_MS} from '../src/js/notation/score-view.js';
import {demoScore} from './fixtures/drum-score.js';

let host, view;
const api = () => apis.at(-1);
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function setTokens(tokens) { for (const [name, value] of Object.entries(tokens)) host.style.setProperty(name, value); }

beforeEach(() => {
  apis.length = 0;
  document.body.innerHTML = '<div id="score"></div>';
  host = document.getElementById('score');
});
afterEach(() => {
  view?.destroy();
  view = null;
  restoreDomShims();
  vi.useRealTimers();
});

describe('fonts', () => {
  it('keeps the 1.9 label sizes by default, so the geometry harness engraves as 1.9 did', async () => {
    view = createScoreView(host, {scale: 1});
    view.setScore(demoScore(32, 120));
    await flush();
    expect(DEFAULT_FONTS).toEqual({barNumber: 11, marker: 15});
    expect(api().snapshot.fonts.BarNumber).toBe('font(11px Arial, Helvetica, sans-serif)');
    expect(api().snapshot.fonts.EffectMarker).toBe('font(bold 15px Arial, Helvetica, sans-serif)');
    expect(api().snapshot.fonts.EffectTempo).toBe('font(bold 12px Arial, Helvetica, sans-serif)');
  });

  it('takes a fonts option and setFonts, with the family from the host’s --font-ui', async () => {
    setTokens({'--font-ui': "'Atkinson Hyperlegible Next', system-ui, sans-serif"});
    view = createScoreView(host, {scale: 1.2, fonts: {barNumber: 12, marker: 17}});
    view.setScore(demoScore(32, 120));
    await flush();
    expect(api().snapshot.fonts.BarNumber).toBe("font(12px 'Atkinson Hyperlegible Next', system-ui, sans-serif)");
    expect(api().snapshot.fonts.EffectMarker).toBe("font(bold 17px 'Atkinson Hyperlegible Next', system-ui, sans-serif)");
    api().finish();
    const relayouts = api().relayouts;
    view.setFonts({barNumber: 7, marker: 10});
    expect(api().relayouts).toBe(relayouts + 1);
    expect(api().snapshot.fonts.BarNumber).toMatch(/^font\(7px /);
    view.setFonts({barNumber: 7, marker: 10});
    expect(api().relayouts).toBe(relayouts + 1);
    expect(view.fonts).toEqual({barNumber: 7, marker: 10});
  });

  it('waits for the UI face before the first engraving, at most 1.5 s', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    vi.resetModules();
    const never = {load: vi.fn(() => new Promise(() => {}))};
    Object.defineProperty(document, 'fonts', {value: never, configurable: true});
    try {
      const fresh = await import('../src/js/notation/score-view.js');
      view = fresh.createScoreView(host);
      view.setScore(demoScore(32, 120));
      await vi.advanceTimersByTimeAsync(0);
      expect(never.load).toHaveBeenCalledWith(FONT_PROBE);
      expect(api().renders).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(FONT_WAIT_MS);
      expect(api().renders).toHaveLength(1);
      // Later engravings do not wait again.
      view.setScore(demoScore(16, 120));
      expect(api().renders).toHaveLength(2);
    } finally {
      delete document.fonts;
    }
  });

  it('engraves once the face loads, and only the latest score when several arrive meanwhile', async () => {
    vi.resetModules();
    installFontsStub();
    const fresh = await import('../src/js/notation/score-view.js');
    view = fresh.createScoreView(host);
    const first = demoScore(32, 120), second = demoScore(16, 120);
    view.setScore(first);
    view.setScore(second);
    await flush();
    expect(document.fonts.loads).toEqual([FONT_PROBE]);
    expect(api().renders).toHaveLength(1);
    expect(view.score).toBe(second);
  });

  it('tolerates a page without document.fonts', async () => {
    vi.resetModules();
    expect(document.fonts).toBeUndefined();
    const fresh = await import('../src/js/notation/score-view.js');
    view = fresh.createScoreView(host);
    view.setScore(demoScore(32, 120));
    await flush();
    expect(api().renders).toHaveLength(1);
  });
});

describe('theme', () => {
  it('reads --ink (notes), --ink-3 (staff lines) and --ink-2 (bar numbers) from the host, not the document root (spec §8.3)', async () => {
    document.documentElement.style.setProperty('--ink', '#000001');
    setTokens({'--ink': '#ffffff', '--ink-3': '#9aa5a0', '--ink-2': '#d3dad6'});
    view = createScoreView(host);
    view.setScore(demoScore(32, 120));
    await flush();
    expect(api().snapshot.colours).toEqual({main: 'color(#ffffff)', lines: 'color(#9aa5a0)', bar: 'color(#d3dad6)'});
    document.documentElement.style.removeProperty('--ink');
  });

  it('prints with --print-ink', async () => {
    setTokens({'--ink': '#ffffff', '--print-ink': '#111111'});
    view = createScoreView(host, {print: true});
    view.setScore(demoScore(32, 120));
    await flush();
    expect(api().snapshot.colours.main).toBe('color(#111111)');
  });

  it('re-engraves on woodshed:theme and woodshed:place only when the host’s tokens changed', async () => {
    setTokens({'--ink': '#ffffff', '--ink-3': '#9aa5a0', '--ink-2': '#d3dad6'});
    view = createScoreView(host);
    view.setScore(demoScore(32, 120));
    await flush();
    api().finish();
    window.dispatchEvent(new Event('woodshed:theme'));   // the always-dark Stage: nothing changed
    expect(api().relayouts).toBe(0);
    setTokens({'--ink': '#17201f'});
    window.dispatchEvent(new Event('woodshed:place'));
    expect(api().relayouts).toBe(1);
    expect(api().snapshot.colours.main).toBe('color(#17201f)');
    view.destroy();
    view = null;
    setTokens({'--ink': '#eef0ea'});
    window.dispatchEvent(new Event('woodshed:theme'));
    expect(apis[0].relayouts).toBe(1);
  });
});

describe('layout calls', () => {
  it('configure changes settings without rendering; relayout renders once', async () => {
    view = createScoreView(host, {scale: 1.2});
    view.setScore(demoScore(32, 120));
    await flush();
    api().finish();
    expect(view.configure({scale: 1.6, barsPerRow: 2, fonts: {barNumber: 9}})).toBe(true);
    expect(api().relayouts).toBe(0);
    expect(view.configure({scale: 1.6, barsPerRow: 2})).toBe(false);
    view.relayout();
    expect(api().relayouts).toBe(1);
    expect(api().snapshot).toMatchObject({scale: 1.6, barsPerRow: 2});
    expect(view.ready).toBe(false);
    api().finish();
    expect(view.ready).toBe(true);
    view.setScale(1);
    view.setBarsPerRow(-1);
    expect(api().relayouts).toBe(3);
  });

  it('a relayout with no score is a no-op; one before any engraving engraves instead', async () => {
    view = createScoreView(host);
    view.relayout();
    expect(api().relayouts).toBe(0);
    expect(api().renders).toHaveLength(0);
    view.setScore(demoScore(32, 120));
    view.relayout();   // the face is still loading: the pending first engraving covers it
    await flush();
    expect(api().relayouts).toBe(0);
    expect(api().renders).toHaveLength(1);
  });

  it('re-engraves a width change at once by default (alphaTab’s own handler)', async () => {
    view = createScoreView(host);
    view.setScore(demoScore(32, 120));
    await flush();
    api().finish();
    api().containerResized(600);
    expect(api().resizes).toBe(1);
  });

  it('with resizeSettleMs a width change waits, and a relayout in the window takes the new width (one engraving)', async () => {
    view = createScoreView(host, {resizeSettleMs: 250});
    view.setScore(demoScore(32, 120));
    await flush();
    api().finish();
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    // The rail → band switch: the column narrows, then the layout's sizes arrive 150 ms later.
    api().containerResized(600);
    expect(api().resizes).toBe(0);
    vi.advanceTimersByTime(150);
    view.configure({scale: 1.5, barsPerRow: 2});
    view.relayout();
    expect(api().relayouts).toBe(1);
    expect(api().renderer.width).toBe(600);
    vi.advanceTimersByTime(250);
    expect(api().resizes).toBe(0);
    expect(api().relayouts).toBe(1);
    // A width change with nothing else re-engraves once, after the last change settles.
    api().containerResized(700);
    vi.advanceTimersByTime(100);
    api().containerResized(720);
    vi.advanceTimersByTime(249);
    expect(api().resizes).toBe(0);
    vi.advanceTimersByTime(1);
    expect(api().resizes).toBe(1);
    expect(api().renderer.width).toBe(720);
  });

  it('with resizeSettleMs a hidden view waits until it is shown, and nothing fires after destroy', async () => {
    view = createScoreView(host, {resizeSettleMs: 250});
    view.setScore(demoScore(32, 120));
    await flush();
    api().finish();
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    api().container.isVisible = false;
    api().containerResized(0);
    vi.advanceTimersByTime(300);
    expect(api().resizes).toBe(0);
    // Shown again at the width it was engraved at: nothing to re-engrave.
    api().container.isVisible = true;
    api().containerResized(800);
    vi.advanceTimersByTime(300);
    expect(api().resizes).toBe(0);
    api().containerResized(500);
    const a = api();
    view.destroy();
    view = null;
    vi.advanceTimersByTime(300);
    expect(a.resizes).toBe(0);
  });

  it('reports the bars it laid out and their bounds', async () => {
    const onRender = vi.fn();
    view = createScoreView(host, {onRender});
    view.setScore(demoScore(16, 120));   // 8 bars
    await flush();
    api().finish(8);
    expect(onRender).toHaveBeenCalledWith(view);
    expect(view.renderedBars()).toBe(8);
    expect(view.barBounds(5)).toEqual({x: 200, y: 150, w: 200, h: 150, lineTop: 200, lineHeight: 40});
    expect(view.barAt(4 * 5 + 1)).toBe(5);
  });
});

describe('overlay and loop handles', () => {
  async function engraved() {
    view = createScoreView(host);
    view.setScore(demoScore(16, 120));
    await flush();
    api().finish(8);
  }
  const edge = side => host.querySelector(`.score-handles [data-loop-edge=${side}]`);

  it('layers the overlay under the notes and the handles above, both aria-hidden', async () => {
    await engraved();
    const stage = host.querySelector('.score-stage');
    expect([...stage.children].map(c => c.getAttribute('class'))).toEqual(['score-overlay', 'score-engraving', 'score-handles']);
    expect(stage.querySelector('.score-overlay').getAttribute('aria-hidden')).toBe('true');
    expect(stage.querySelector('.score-handles').getAttribute('aria-hidden')).toBe('true');
  });

  it('draws the playing bar with --now-soft and the 3 px --now cursor classes', async () => {
    await engraved();
    view.setPlayhead(6);
    const bar = host.querySelector('.score-now-bar'), line = host.querySelector('.score-playhead');
    expect(bar.getAttribute('x')).toBe('200');
    expect(line.getAttribute('x1')).not.toBeNull();
    expect(host.querySelector('.score-now').style.display).toBe('');
  });

  it('shows loop edges only with handles on and a loop set: bracket, 3 px edge, 20 px grip, 44 px hit area', async () => {
    await engraved();
    view.setLoop([8, 20]);   // bars 3–5
    expect(edge('start').style.display).toBe('none');
    view.setLoopHandles(true);
    expect(edge('start').style.display).toBe('');
    expect(HANDLE_HIT_PX).toBe(44);
    const hit = edge('start').querySelector('.score-loop-hit');
    expect(hit.getAttribute('width')).toBe('44');
    expect(hit.getAttribute('x')).toBe('-22');
    expect(Number(hit.getAttribute('height'))).toBeGreaterThanOrEqual(150);   // the system's height
    expect(edge('start').querySelector('.score-loop-grip').getAttribute('r')).toBe('10');
    expect(edge('start').querySelector('.score-loop-bracket').getAttribute('d')).toMatch(/^M 8 /);
    expect(edge('end').querySelector('.score-loop-bracket').getAttribute('d')).toMatch(/^M -8 /);
    // Start at bar 3's left edge (x 400, system 0); end on the bar line after bar 5 (its right edge, x 200, system 1).
    expect(edge('start').style.transform).toBe('translate(400px, 0px)');
    expect(edge('end').style.transform).toBe('translate(200px, 150px)');
    expect(host.querySelectorAll('.score-loop')).toHaveLength(3);   // one band per bar
    view.setLoop(null);
    expect(edge('end').style.display).toBe('none');
  });

  it('turns the edges’ snap animation off only while a pointer drags them', async () => {
    await engraved();
    view.setLoopHandles(true);
    view.setLoop([8, 20], {dragging: true});
    expect(host.querySelector('.score-handles').classList.contains('is-dragging')).toBe(true);
    view.setLoop([8, 16]);
    expect(host.querySelector('.score-handles').classList.contains('is-dragging')).toBe(false);
  });

  it('keeps the editor’s marks (range, caret)', async () => {
    await engraved();
    view.setRange([1, 2]);
    expect(host.querySelectorAll('.score-range')).toHaveLength(2);
    view.setCaret({q: 5, label: '1/16'});
    expect(host.querySelector('.score-caret-label').textContent).toBe('1/16');
  });

  it('destroy removes the listeners and the markup', async () => {
    await engraved();
    view.destroy();
    expect(api().destroyed).toBe(true);
    expect(host.children).toHaveLength(0);
    expect(host.classList.contains('score-view')).toBe(false);
    view = null;
  });
});
