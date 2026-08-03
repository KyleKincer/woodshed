import { MultitrackEngine } from './engine.js';
import { Metronome } from './metronome.js';
import { computePeaksRange, drawWaveform } from './waveform.js';
import * as backend from './backend.js';
import { codecErrorMessage, isDecodeError } from './stemcache.js';

const TIME_SIGS = ['4/4', '3/4', '2/4', '5/4', '6/4', '7/4', '6/8', '9/8', '12/8', '5/8', '7/8'];
const GRID_STORAGE_KEY = 'ws.grid';
const GRID_DIVISIONS = [
  { value: 1, label: 'Beat' },
  { value: 2, label: '1/2 beat' },
  { value: 4, label: '1/4 beat' },
];

const STEM_COLOR_VAR = {
  drums: '--drums', bass: '--bass', vocals: '--vocals', other: '--other',
  guitar: '--guitar', piano: '--piano',
  no_drums: '--other', no_vocals: '--vocals', no_bass: '--bass',
};
const MIN_SPAN = 0.25; // smallest zoom window, seconds

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'; }
function colorFor(stem) { return cssVar(STEM_COLOR_VAR[stem] || '--accent'); }
function prettyStem(name) { return name.replace('no_', 'no ').replace('_', ' '); }
function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmt2(t) { // m:ss.cc (centiseconds) for precise readouts
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const cs = Math.round((t - Math.floor(t)) * 100);
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function loadGridSettings() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(GRID_STORAGE_KEY) || '{}'); }
  catch {}
  const division = GRID_DIVISIONS.some((d) => d.value === raw.division) ? raw.division : 1;
  return { visible: raw.visible !== false, snap: raw.snap === true, division };
}

let engine = null;
let metronome = null;
let rafId = null;
let keyHandler = null;
let cleanupFns = [];

export function closePlayer() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (metronome) { metronome.destroy(); metronome = null; }
  if (engine) { engine.destroy(); engine = null; }
  if (keyHandler) { window.removeEventListener('keydown', keyHandler); keyHandler = null; }
  cleanupFns.forEach((fn) => fn());
  cleanupFns = [];
}

export async function openPlayer(song, onBack) {
  closePlayer();
  const root = document.getElementById('player-root');
  root.innerHTML = `<div class="loading"><div class="spinner"></div><p style="margin-top:14px">Loading stems…</p></div>`;

  engine = new MultitrackEngine();

  // Stems and cover live in R2; resolve every key to a signed URL in one call.
  const keys = song.stems.map((s) => s.key).concat(song.coverKey ? [song.coverKey] : []);
  let urls;
  try { urls = await backend.signKeys(keys); }
  catch (e) { root.innerHTML = `<div class="loading"><p>Couldn't reach storage: ${escapeHtml(e.message)}</p></div>`; return; }

  const stems = song.stems.map((s) => ({
    name: s.name, key: s.key, url: urls[s.key], color: colorFor(s.name),
  }));
  const unresolved = stems.filter((s) => !s.url).map((s) => s.name);
  if (unresolved.length) {
    root.innerHTML = `<div class="loading"><p>Missing stem audio for: ${escapeHtml(unresolved.join(', '))}.<br>Try reprocessing this song.</p></div>`;
    return;
  }

  const progressEl = root.querySelector('.loading p');
  let info;
  try {
    info = await engine.loadStems(stems, (done, total, bytes) => {
      if (!progressEl) return;
      const mb = (n) => (n / 1048576).toFixed(1);
      progressEl.textContent = bytes.total
        ? `Loading stems… ${mb(bytes.loaded)} / ${mb(bytes.total)} MB`
        : `Loading stems… ${done}/${total}`;
    });
  } catch (e) {
    const msg = isDecodeError(e) ? codecErrorMessage : `Couldn't load audio: ${e.message}`;
    root.innerHTML = `<div class="loading"><p style="max-width:52ch;line-height:1.5">${escapeHtml(msg)}</p></div>`;
    return;
  }

  const duration = info.duration;
  const view = { start: 0, end: duration }; // visible time window
  const grid = loadGridSettings();

  const coverUrl = song.coverKey ? urls[song.coverKey] : null;
  const cover = coverUrl ? `style="background-image:url('${coverUrl}')"` : '';
  const overviewOpen = localStorage.getItem('ws.overview') === '1';
  root.innerHTML = `
    <div class="player">
      <div class="player-topbar">
        <button class="back-btn" id="player-back">‹ Library</button>
        <div class="pt-cover" ${cover}></div>
        <div class="pt-meta">
          <div class="ptitle">${escapeHtml(song.title)}</div>
          <div class="psub">${escapeHtml(song.artist || song.uploader || '')} · ${song.stems.length} stems · ${song.quality?.model || ''}</div>
        </div>
        <div class="pt-spacer"></div>
        <button class="toggle-btn ${overviewOpen ? 'on' : ''}" id="mini-toggle" title="Toggle overview / minimap">Overview</button>
      </div>

      <div class="tracks" id="tracks">
        <div class="timeline" id="timeline">
          <canvas id="grid-canvas" class="grid-canvas"></canvas>
          <div class="tempo-markers" id="tempo-markers"></div>
          <div class="loop-region" id="loop-region" style="display:none"></div>
          <div class="loop-handle" id="handle-a" style="display:none"></div>
          <div class="loop-handle" id="handle-b" style="display:none"></div>
          <div class="playhead" id="playhead" style="left:0"></div>
          <div class="time-tip" id="time-tip" style="display:none"></div>
        </div>
        <div class="timeline" id="timeline-interact"></div>
      </div>

      <div class="overview ${overviewOpen ? '' : 'hidden'}" id="overview" title="Drag the bracket to pan · drag its edges to zoom · click to seek">
        <canvas id="mini-canvas"></canvas>
        <div class="mini-loop" id="mini-loop" style="display:none"></div>
        <div class="mini-view" id="mini-view"><span class="mv-edge l"></span><span class="mv-edge r"></span></div>
        <div class="mini-playhead" id="mini-playhead"></div>
      </div>

      <div class="transport">
        <button class="play-btn" id="play">▶</button>
        <div class="time" id="time">0:00.00 / ${fmt(duration)}</div>

        <div class="t-divider"></div>
        <div class="t-group loop-readout" id="loop-readout">
          <button class="toggle-btn sm" id="loop-toggle" title="Toggle A–B loop (L)">Loop</button>
          <button class="nudge" data-edge="a" data-d="-0.05" title="Nudge A back">−</button>
          <span class="lr-val" id="lr-a">—</span>
          <button class="nudge" data-edge="a" data-d="0.05" title="Nudge A forward">+</button>
          <span class="lr-sep">→</span>
          <button class="nudge" data-edge="b" data-d="-0.05" title="Nudge B back">−</button>
          <span class="lr-val" id="lr-b">—</span>
          <button class="nudge" data-edge="b" data-d="0.05" title="Nudge B forward">+</button>
          <span class="lr-len" id="lr-len"></span>
          <button class="toggle-btn sm" id="set-a" title="Set A at playhead ([)">A⇤</button>
          <button class="toggle-btn sm" id="set-b" title="Set B at playhead (])">⇥B</button>
          <button class="toggle-btn sm" id="loop-clear" title="Clear loop">Clear</button>
        </div>

        <div class="t-divider"></div>
        <div class="t-group">
          <span class="t-label">Speed</span>
          <input type="range" id="speed" min="0.5" max="1.5" step="0.05" value="1" />
          <span class="speed-val" id="speed-val">1.00×</span>
        </div>

        <div class="t-divider"></div>
        <div class="t-group" title="Zoom">
          <button class="toggle-btn sm" id="zoom-out">−</button>
          <button class="toggle-btn sm" id="zoom-in">+</button>
          <button class="toggle-btn sm" id="zoom-fit">Fit</button>
        </div>

        <div class="t-divider"></div>
        <div class="t-group grid-controls" title="Beat grid">
          <span class="t-label">Grid</span>
          <button class="toggle-btn sm" id="grid-toggle" title="Show beat grid (G)">On</button>
          <select id="grid-division" title="Grid subdivision">
            ${GRID_DIVISIONS.map((d) => `<option value="${d.value}">${d.label}</option>`).join('')}
          </select>
          <button class="toggle-btn sm" id="grid-snap" title="Snap seeks and loop edits to the grid (S)">Snap</button>
        </div>

        <div class="t-divider"></div>
        <button class="toggle-btn sm" id="metro-btn" title="Metronome (M)">♩ Metro</button>

        <div class="t-spacer"></div>
        <button class="toggle-btn sm" id="mixer-reset" title="Reset mixer (0)">⟲ Mix</button>
        <button class="toggle-btn sm" id="help" title="space play · ←/→ seek (shift=1s) · ,/. nudge (shift=.01s) · click waveform to seek · [ ] set loop A/B · Home/End jump to A/B · L loop · −/= zoom · \\ fit · G grid · S snap · M metronome · 1–9 mute · 0 reset">?</button>
      </div>

      <div class="metro-pop hidden" id="metro-pop">
        <div class="mp-row">
          <button class="toggle-btn" id="m-onoff">Off</button>
          <div class="mp-bpm">
            <button class="nudge" id="m-bpm-dn">−</button>
            <input id="m-bpm" type="number" min="20" max="400" value="120" />
            <span class="mp-unit">BPM</span>
            <button class="nudge" id="m-bpm-up">+</button>
            <button class="toggle-btn sm" id="m-tap" title="Tap in time with the track">Tap</button>
          </div>
          <select id="m-sig" title="Time signature"></select>
        </div>
        <div class="mp-row">
          <button class="toggle-btn sm" id="m-setdown">Set downbeat at playhead</button>
          <label class="mp-check"><input type="checkbox" id="m-accent" checked /> Accent</label>
          <label class="mp-check"><input type="checkbox" id="m-countin" /> Count-in</label>
          <span class="t-label">Vol</span>
          <input type="range" id="m-vol" min="0" max="1" step="0.01" value="0.7" />
        </div>
        <div class="mp-row mp-detect">
          <button class="toggle-btn" id="m-detect">✨ Auto-detect beats</button>
          <span class="mp-detect-status" id="m-detect-status">Manual tempo</span>
          <button class="toggle-btn sm hidden" id="m-edit-toggle">✎ Edit beats</button>
          <button class="toggle-btn sm hidden" id="m-detect-clear">Use manual</button>
        </div>
        <div class="mp-row mp-edit hidden" id="mp-edit">
          <button class="toggle-btn sm" id="be-add" title="Add a beat at the playhead">＋ Beat</button>
          <button class="toggle-btn sm" id="be-down" title="Toggle downbeat (D)">Downbeat</button>
          <button class="toggle-btn sm" id="be-del" title="Delete selected beat (Delete)">Delete</button>
          <span class="t-label">Shift all</span>
          <button class="nudge" id="be-shl" title="Shift whole track earlier">◄</button>
          <button class="nudge" id="be-shr" title="Shift whole track later">►</button>
          <span class="be-hint">drag a beat to move · click empty to add · click a beat then Delete</span>
        </div>
        <div class="mp-changes" id="mp-manual">
          <div class="mp-changes-head">
            <span>Tempo / time-sig changes</span>
            <button class="toggle-btn sm" id="m-add">＋ Add at playhead</button>
          </div>
          <div id="m-list" class="mp-list"></div>
        </div>
      </div>
    </div>
  `;

  const tracksEl = document.getElementById('tracks');
  const timeline = document.getElementById('timeline');
  const interact = document.getElementById('timeline-interact');
  const playhead = document.getElementById('playhead');
  const loopRegion = document.getElementById('loop-region');
  const handleA = document.getElementById('handle-a');
  const handleB = document.getElementById('handle-b');
  const timeTip = document.getElementById('time-tip');
  const trackRows = [];

  info.tracks.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'track';
    row.innerHTML = `
      <div class="track-ctrl">
        <div class="track-name"><span class="track-dot" style="background:${t.color}"></span>${prettyStem(t.name)}</div>
        <div class="track-buttons">
          <button class="tbtn mute" data-stem="${t.name}">Mute</button>
          <button class="tbtn solo" data-stem="${t.name}">Solo</button>
        </div>
        <input class="track-vol" type="range" min="0" max="1" step="0.01" value="1" data-stem="${t.name}" />
      </div>
      <div class="track-wave"><canvas></canvas></div>`;
    tracksEl.insertBefore(row, timeline);
    trackRows.push({ track: t, canvas: row.querySelector('canvas'), row });
  });

  // ---- coordinate mapping (wave area) ----
  const waveW = () => interact.clientWidth;
  const span = () => view.end - view.start;
  const timeToX = (t) => ((t - view.start) / span()) * waveW();
  const xToTime = (x) => view.start + (x / waveW()) * span();

  // ---- waveform drawing (throttled; recomputed per zoom window) ----
  let wfPending = false;
  function scheduleWaveforms() {
    if (wfPending) return;
    wfPending = true;
    requestAnimationFrame(() => { wfPending = false; drawWaveforms(); });
  }
  function drawWaveforms() {
    const anySolo = engine.tracks.some((t) => t.soloed);
    for (const { track, canvas } of trackRows) {
      const w = Math.max(200, Math.floor(canvas.clientWidth));
      const peaks = computePeaksRange(track.buffer, view.start, view.end, w);
      const audible = anySolo ? track.soloed : !track.muted;
      drawWaveform(canvas, peaks, track.color, { dim: !audible });
    }
    drawGrid();
  }

  // Beat grid + tempo-change markers over the visible window.
  const gridCanvas = document.getElementById('grid-canvas');
  const tempoMarkers = document.getElementById('tempo-markers');
  function shouldSnapToGrid() { return grid.visible && grid.snap && metronome?.beats?.length; }
  function persistGridSettings() {
    localStorage.setItem(GRID_STORAGE_KEY, JSON.stringify(grid));
  }
  function gridTicksForView(t0, t1) {
    if (!metronome?.beats?.length) return [];
    const ticks = [];
    const div = Math.max(1, grid.division | 0);
    const beats = metronome.beats;
    for (let i = 0; i < beats.length; i++) {
      const b = beats[i];
      if (b.time >= t0 && b.time <= t1) ticks.push({ time: b.time, downbeat: b.downbeat, beat: b });
      const next = beats[i + 1];
      if (!next || div === 1) continue;
      for (let k = 1; k < div; k++) {
        const t = b.time + ((next.time - b.time) * k) / div;
        if (t >= t0 && t <= t1) ticks.push({ time: t, subdivision: true });
      }
    }
    return ticks.sort((a, b) => a.time - b.time);
  }
  function snapTime(t) {
    const raw = clamp(t, 0, duration);
    if (!shouldSnapToGrid()) return raw;
    const beats = metronome.beats;
    let lo = 0, hi = beats.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (beats[mid].time < raw) lo = mid + 1;
      else hi = mid;
    }
    const candidates = [];
    const addInterval = (i) => {
      const a = beats[i], b = beats[i + 1];
      if (!a) return;
      candidates.push(a.time);
      if (!b) return;
      candidates.push(b.time);
      const div = Math.max(1, grid.division | 0);
      for (let k = 1; k < div; k++) candidates.push(a.time + ((b.time - a.time) * k) / div);
    };
    addInterval(lo - 1);
    addInterval(lo);
    if (lo > 0) candidates.push(beats[lo - 1].time);
    if (beats[lo]) candidates.push(beats[lo].time);
    let best = raw, dist = Infinity;
    for (const c of candidates) {
      const d = Math.abs(c - raw);
      if (d < dist) { best = c; dist = d; }
    }
    return clamp(best, 0, duration);
  }
  function seekTo(t) { engine.seek(snapTime(t)); }
  function tipText(t) { return shouldSnapToGrid() ? `${fmt2(t)} grid` : fmt2(t); }
  function drawGrid() {
    const dpr = window.devicePixelRatio || 1;
    const w = timeline.clientWidth, h = timeline.clientHeight;
    gridCanvas.width = w * dpr; gridCanvas.height = h * dpr;
    const ctx = gridCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    tempoMarkers.innerHTML = '';
    if (!grid.visible || !metronome) return;
    for (const tick of gridTicksForView(view.start, view.end)) {
      const x = timeToX(tick.time);
      const sel = beatEditing && tick.beat && tick.beat === selectedBeat;
      ctx.strokeStyle = sel ? 'rgba(255,255,255,0.95)'
        : tick.subdivision ? 'rgba(255,255,255,0.045)'
          : tick.downbeat ? 'rgba(124,91,255,0.55)' : 'rgba(255,255,255,0.10)';
      ctx.lineWidth = sel ? 2 : tick.downbeat ? 1.5 : 1;
      ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); ctx.stroke();
      if (beatEditing && tick.beat) { // grab handle at the top of each beat
        ctx.fillStyle = sel ? '#fff' : tick.downbeat ? 'rgba(124,91,255,0.9)' : 'rgba(255,255,255,0.4)';
        ctx.fillRect(x - 3, 0, 6, 6);
      }
    }
    // Section-change flags (skip the very first/base section unless it's > 0).
    metronome.map.forEach((s, i) => {
      if (s.t < view.start || s.t > view.end) return;
      if (i === 0 && s.t <= 0.001) return;
      const flag = document.createElement('div');
      flag.className = 'tempo-flag';
      flag.style.left = timeToX(s.t) + 'px';
      flag.textContent = `${s.bpm} · ${s.beatsPerBar}/${s.unit}`;
      tempoMarkers.appendChild(flag);
    });
  }

  // ---- overview / minimap ----
  const overview = document.getElementById('overview');
  const miniCanvas = document.getElementById('mini-canvas');
  const miniLoop = document.getElementById('mini-loop');
  const miniView = document.getElementById('mini-view');
  const miniPlay = document.getElementById('mini-playhead');
  function drawMini() {
    if (overview.classList.contains('hidden')) return;
    const w = Math.max(200, overview.clientWidth);
    const src = trackRows[0]?.track.buffer;
    if (src) drawWaveform(miniCanvas, computePeaksRange(src, 0, duration, w), cssVar('--muted'), { dim: false });
    updateMiniOverlay();
  }
  function updateMiniOverlay() {
    const w = overview.clientWidth;
    miniView.style.left = (view.start / duration) * w + 'px';
    miniView.style.width = Math.max(6, (span() / duration) * w) + 'px';
    const { enabled, a, b } = engine.loop;
    if (enabled && b > a) {
      miniLoop.style.display = 'block';
      miniLoop.style.left = (a / duration) * w + 'px';
      miniLoop.style.width = ((b - a) / duration) * w + 'px';
    } else miniLoop.style.display = 'none';
  }

  // ---- overlay (playhead + loop region + handles) within the zoom window ----
  function updateLoopOverlay() {
    const { enabled, a, b } = engine.loop;
    const w = waveW();
    if (enabled && b > a) {
      const xa = clamp(timeToX(a), 0, w);
      const xb = clamp(timeToX(b), 0, w);
      const visible = b >= view.start && a <= view.end;
      loopRegion.style.display = visible ? 'block' : 'none';
      loopRegion.style.left = xa + 'px';
      loopRegion.style.width = Math.max(0, xb - xa) + 'px';
      placeHandle(handleA, a);
      placeHandle(handleB, b);
    } else {
      loopRegion.style.display = 'none';
      handleA.style.display = 'none';
      handleB.style.display = 'none';
    }
    updateLoopReadout();
    updateMiniOverlay();
  }
  function placeHandle(el, t) {
    const inside = t >= view.start && t <= view.end;
    el.style.display = inside ? 'block' : 'none';
    if (inside) el.style.left = timeToX(t) + 'px';
  }
  function updateLoopReadout() {
    const { enabled, a, b } = engine.loop;
    const has = enabled && b > a;
    document.getElementById('lr-a').textContent = has ? fmt2(a) : '—';
    document.getElementById('lr-b').textContent = has ? fmt2(b) : '—';
    document.getElementById('lr-len').textContent = has ? `(${(b - a).toFixed(2)}s)` : '';
    document.getElementById('loop-toggle').classList.toggle('on', enabled);
    document.getElementById('loop-readout').classList.toggle('active', has);
  }

  // ---- zoom & pan ----
  function setView(start, end) {
    let s = clamp(start, 0, duration);
    let e = clamp(end, s + MIN_SPAN, duration);
    if (e - s < MIN_SPAN) s = clamp(e - MIN_SPAN, 0, duration);
    view.start = s; view.end = e;
    scheduleWaveforms();
    updateLoopOverlay();
  }
  function zoomAt(centerTime, factor) {
    const newSpan = clamp(span() * factor, MIN_SPAN, duration);
    const frac = clamp((centerTime - view.start) / span(), 0, 1);
    setView(centerTime - frac * newSpan, centerTime - frac * newSpan + newSpan);
  }
  function panBy(dt) { const sp = span(); setView(view.start + dt, view.start + dt + sp); }
  function fit() { setView(0, duration); }

  document.getElementById('zoom-in').onclick = () => zoomAt((view.start + view.end) / 2, 0.5);
  document.getElementById('zoom-out').onclick = () => zoomAt((view.start + view.end) / 2, 2);
  document.getElementById('zoom-fit').onclick = fit;

  const gridToggle = document.getElementById('grid-toggle');
  const gridSnap = document.getElementById('grid-snap');
  const gridDivision = document.getElementById('grid-division');
  function refreshGridUI() {
    gridToggle.textContent = grid.visible ? 'On' : 'Off';
    gridToggle.classList.toggle('on', grid.visible);
    gridSnap.classList.toggle('on', grid.snap && grid.visible);
    gridSnap.disabled = !grid.visible;
    gridDivision.disabled = !grid.visible;
    gridDivision.value = String(grid.division);
    playhead.classList.toggle('snap-on', shouldSnapToGrid());
  }
  gridToggle.onclick = () => {
    grid.visible = !grid.visible;
    if (!grid.visible) grid.snap = false;
    refreshGridUI(); drawGrid(); persistGridSettings();
  };
  gridSnap.onclick = () => {
    if (!grid.visible) return;
    grid.snap = !grid.snap;
    refreshGridUI(); drawGrid(); persistGridSettings();
  };
  gridDivision.onchange = () => {
    grid.division = parseInt(gridDivision.value, 10) || 1;
    refreshGridUI(); drawGrid(); persistGridSettings();
  };
  refreshGridUI();

  // Wheel: zoom at cursor; shift / horizontal = pan.
  interact.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      panBy(((e.deltaX || e.deltaY) / waveW()) * span());
    } else {
      const r = interact.getBoundingClientRect();
      zoomAt(xToTime(e.clientX - r.left), Math.exp(e.deltaY * 0.0015));
    }
  }, { passive: false });

  // ---- main waveform interaction (seek / loop create / edge drag / move) ----
  let drag = null;
  let beatDrag = null;       // dragging a beat in edit mode
  let beatEditing = false;   // beat-correction mode (detected tracks)
  let selectedBeat = null;   // reference to the selected beat object
  const EDGE_PX = 7;
  const selectBeat = (b) => { selectedBeat = b; drawGrid(); };
  function loopOrder(a, b) { return a <= b ? [a, b] : [b, a]; }

  interact.addEventListener('mousemove', (e) => {
    if (drag || beatDrag) return;
    const r = interact.getBoundingClientRect();
    const x = e.clientX - r.left;
    const rawT = xToTime(x);
    const t = snapTime(rawT);
    if (beatEditing) {
      const near = metronome.nearestBeat(rawT, (8 / waveW()) * span());
      interact.style.cursor = near ? 'grab' : 'copy';
      timeTip.style.display = 'block';
      timeTip.style.left = clamp(x, 0, waveW()) + 'px';
      timeTip.textContent = fmt2(rawT);
      return;
    }
    // hover cursor + time tooltip
    let cursor = 'text';
    const { enabled, a, b } = engine.loop;
    if (enabled && b > a) {
      if (Math.abs(x - timeToX(a)) <= EDGE_PX || Math.abs(x - timeToX(b)) <= EDGE_PX) cursor = 'ew-resize';
      else if (x > timeToX(a) && x < timeToX(b)) cursor = 'grab';
    }
    interact.style.cursor = cursor;
    timeTip.style.display = 'block';
    timeTip.style.left = clamp(shouldSnapToGrid() ? timeToX(t) : x, 0, waveW()) + 'px';
    timeTip.textContent = tipText(t);
  });
  interact.addEventListener('mouseleave', () => { if (!drag) timeTip.style.display = 'none'; });

  interact.addEventListener('mousedown', (e) => {
    const r = interact.getBoundingClientRect();
    const x = e.clientX - r.left;
    const rawT = xToTime(x);
    const t = snapTime(rawT);
    if (beatEditing) {
      const near = metronome.nearestBeat(rawT, (8 / waveW()) * span());
      beatDrag = near ? { obj: near, startX: x, moved: false } : { obj: null, addAt: rawT, startX: x, moved: false };
      if (near) selectBeat(near);
      return;
    }
    const { enabled, a, b } = engine.loop;
    let mode = 'new';
    if (enabled && b > a) {
      if (Math.abs(x - timeToX(a)) <= EDGE_PX) mode = 'edgeA';
      else if (Math.abs(x - timeToX(b)) <= EDGE_PX) mode = 'edgeB';
      else if (x > timeToX(a) + EDGE_PX && x < timeToX(b) - EDGE_PX) mode = 'move';
    }
    drag = { mode, startX: x, startT: t, origA: a, origB: b, moved: false };
  });

  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragUp);
  cleanupFns.push(() => { window.removeEventListener('mousemove', onDragMove); window.removeEventListener('mouseup', onDragUp); });

  function onDragMove(e) {
    if (beatDrag) {
      const r = interact.getBoundingClientRect();
      const x = e.clientX - r.left;
      const t = clamp(xToTime(x), 0, duration);
      if (Math.abs(x - beatDrag.startX) > 3) beatDrag.moved = true;
      if (beatDrag.obj && beatDrag.moved) metronome.moveBeat(beatDrag.obj, t);
      timeTip.style.display = 'block';
      timeTip.style.left = clamp(x, 0, waveW()) + 'px';
      timeTip.textContent = fmt2(t);
      return;
    }
    if (!drag) return;
    const r = interact.getBoundingClientRect();
    const x = e.clientX - r.left;
    const t = snapTime(xToTime(x));
    if (Math.abs(x - drag.startX) > 3) drag.moved = true;
    timeTip.style.display = 'block';
    timeTip.style.left = clamp(shouldSnapToGrid() ? timeToX(t) : x, 0, waveW()) + 'px';
    timeTip.textContent = tipText(t);

    if (drag.mode === 'edgeA') {
      engine.setLoop(true, Math.min(t, engine.loop.b - 0.02), engine.loop.b);
    } else if (drag.mode === 'edgeB') {
      engine.setLoop(true, engine.loop.a, Math.max(t, engine.loop.a + 0.02));
    } else if (drag.mode === 'move') {
      const len = drag.origB - drag.origA;
      let na = clamp(drag.origA + (t - drag.startT), 0, duration - len);
      engine.setLoop(true, na, na + len);
    } else if (drag.mode === 'new' && drag.moved) {
      const [a, b] = loopOrder(drag.startT, t);
      if (b - a >= 0.02) { engine.setLoop(true, a, b); setLoopBtn(true); }
    }
    updateLoopOverlay();
  }
  function onDragUp() {
    if (beatDrag) {
      if (!beatDrag.moved) {
        if (beatDrag.obj) selectBeat(beatDrag.obj);            // click a beat → select
        else selectBeat(metronome.addBeat(beatDrag.addAt, false)); // click empty → add
      }
      beatDrag = null;
      timeTip.style.display = 'none';
      return;
    }
    if (!drag) return;
    // A click (no drag) always seeks — even inside the loop or on a handle.
    if (!drag.moved) seekTo(drag.startT);
    drag = null;
    timeTip.style.display = 'none';
  }

  // ---- overview interaction ----
  let mdrag = null;
  overview.addEventListener('mousedown', (e) => {
    const r = overview.getBoundingClientRect();
    const x = e.clientX - r.left;
    const w = overview.clientWidth;
    const vx0 = (view.start / duration) * w;
    const vx1 = (view.end / duration) * w;
    let mode = 'seek';
    if (Math.abs(x - vx0) <= 6) mode = 'vstart';
    else if (Math.abs(x - vx1) <= 6) mode = 'vend';
    else if (x > vx0 && x < vx1) mode = 'pan';
    mdrag = { mode, startX: x, vs: view.start, ve: view.end, moved: false };
    e.preventDefault();
  });
  function onMiniMove(e) {
    if (!mdrag) return;
    const r = overview.getBoundingClientRect();
    const w = overview.clientWidth;
    const x = clamp(e.clientX - r.left, 0, w);
    const t = (x / w) * duration;
    if (Math.abs(x - mdrag.startX) > 2) mdrag.moved = true;
    if (mdrag.mode === 'pan') {
      const dt = ((x - mdrag.startX) / w) * duration;
      const sp = mdrag.ve - mdrag.vs;
      setView(mdrag.vs + dt, mdrag.vs + dt + sp);
    } else if (mdrag.mode === 'vstart') setView(t, view.end);
    else if (mdrag.mode === 'vend') setView(view.start, t);
  }
  function onMiniUp(e) {
    if (!mdrag) return;
    if (!mdrag.moved && mdrag.mode === 'seek') {
      const r = overview.getBoundingClientRect();
      seekTo(((clamp(e.clientX - r.left, 0, overview.clientWidth)) / overview.clientWidth) * duration);
    }
    mdrag = null;
  }
  window.addEventListener('mousemove', onMiniMove);
  window.addEventListener('mouseup', onMiniUp);
  cleanupFns.push(() => { window.removeEventListener('mousemove', onMiniMove); window.removeEventListener('mouseup', onMiniUp); });

  // ---- track controls ----
  tracksEl.querySelectorAll('.tbtn.mute').forEach((btn) => {
    btn.onclick = () => { btn.classList.toggle('on', engine.toggleMute(btn.dataset.stem)); drawWaveforms(); };
  });
  tracksEl.querySelectorAll('.tbtn.solo').forEach((btn) => {
    btn.onclick = () => { btn.classList.toggle('on', engine.toggleSolo(btn.dataset.stem)); drawWaveforms(); };
  });
  tracksEl.querySelectorAll('.track-vol').forEach((sl) => {
    sl.oninput = () => engine.setVolume(sl.dataset.stem, parseFloat(sl.value));
  });

  // ---- transport ----
  const playBtn = document.getElementById('play');
  const timeEl = document.getElementById('time');
  function setPlayIcon() { playBtn.textContent = engine.playing ? '❚❚' : '▶'; }
  playBtn.onclick = async () => { if (engine.playing) engine.pause(); else await engine.play(); setPlayIcon(); };
  engine.onEnded = () => setPlayIcon();

  // Loop controls
  const loopToggle = document.getElementById('loop-toggle');
  function setLoopBtn(on) { loopToggle.classList.toggle('on', on); }
  loopToggle.onclick = () => {
    const willEnable = !engine.loop.enabled;
    if (willEnable && engine.loop.b <= engine.loop.a) engine.setLoop(true, view.start, view.end);
    else engine.setLoop(willEnable);
    updateLoopOverlay();
  };
  document.getElementById('loop-clear').onclick = () => { engine.setLoop(false, 0, duration); updateLoopOverlay(); };
  document.getElementById('set-a').onclick = () => { const t = snapTime(engine.getPosition()); const b = engine.loop.b > t ? engine.loop.b : duration; engine.setLoop(true, t, b); updateLoopOverlay(); };
  document.getElementById('set-b').onclick = () => { const t = snapTime(engine.getPosition()); const a = engine.loop.a < t ? engine.loop.a : 0; engine.setLoop(true, a, t); updateLoopOverlay(); };
  document.querySelectorAll('.nudge').forEach((btn) => {
    btn.onclick = () => {
      const d = parseFloat(btn.dataset.d);
      let { a, b } = engine.loop;
      if (btn.dataset.edge === 'a') a = clamp(a + d, 0, b - 0.02);
      else b = clamp(b + d, a + 0.02, duration);
      engine.setLoop(true, a, b);
      updateLoopOverlay();
    };
  });

  // Click the A / B time readouts to jump the playhead there.
  const loopActive = () => engine.loop.enabled && engine.loop.b > engine.loop.a;
  const lrA = document.getElementById('lr-a');
  const lrB = document.getElementById('lr-b');
  lrA.classList.add('jumpable');
  lrB.classList.add('jumpable');
  lrA.title = 'Jump playhead to A (Home)';
  lrB.title = 'Jump playhead to B (End)';
  lrA.onclick = () => { if (loopActive()) seekTo(engine.loop.a); };
  lrB.onclick = () => { if (loopActive()) seekTo(engine.loop.b); };

  // Speed
  const speed = document.getElementById('speed');
  const speedVal = document.getElementById('speed-val');
  speed.oninput = () => { const r = parseFloat(speed.value); engine.setSpeed(r); speedVal.textContent = r.toFixed(2) + '×'; };

  document.getElementById('mixer-reset').onclick = () => {
    engine.resetMixer();
    tracksEl.querySelectorAll('.tbtn').forEach((b) => b.classList.remove('on'));
    tracksEl.querySelectorAll('.track-vol').forEach((s) => (s.value = 1));
    drawWaveforms();
  };

  // Back + overview toggle
  document.getElementById('player-back').onclick = () => { if (onBack) onBack(); };
  const miniToggle = document.getElementById('mini-toggle');
  miniToggle.onclick = () => {
    const open = !overview.classList.toggle('hidden');
    miniToggle.classList.toggle('on', open);
    localStorage.setItem('ws.overview', open ? '1' : '0');
    if (open) requestAnimationFrame(() => { drawMini(); updateMiniOverlay(); });
  };

  // ---- metronome ----
  metronome = new Metronome(engine);
  metronome.load(song.tempo);

  const metroPop = document.getElementById('metro-pop');
  const metroBtn = document.getElementById('metro-btn');
  const mOnoff = document.getElementById('m-onoff');
  const mBpm = document.getElementById('m-bpm');
  const mSig = document.getElementById('m-sig');
  const mAccent = document.getElementById('m-accent');
  const mCountin = document.getElementById('m-countin');
  const mVol = document.getElementById('m-vol');
  const mList = document.getElementById('m-list');
  mSig.innerHTML = TIME_SIGS.map((s) => `<option value="${s}">${s}</option>`).join('');

  let saveTimer = null;
  function persistTempo() { clearTimeout(saveTimer); saveTimer = setTimeout(() => backend.saveTempo(song.id, metronome.serialize()), 400); }
  const activeSection = () => metronome.sectionAt(engine.getPosition());
  const metroActiveIndex = () => { const t = engine.getPosition(); let idx = 0; metronome.map.forEach((s, i) => { if (s.t <= t + 1e-6) idx = i; }); return idx; };

  function refreshMetroUI() {
    const s = activeSection();
    if (document.activeElement !== mBpm) mBpm.value = s.bpm;
    mSig.value = `${s.beatsPerBar}/${s.unit}`;
    mAccent.checked = metronome.accent;
    mCountin.checked = metronome.countIn;
    mVol.value = metronome.volume;
    mOnoff.textContent = metronome.enabled ? 'On' : 'Off';
    mOnoff.classList.toggle('on', metronome.enabled);
    metroBtn.classList.toggle('on', metronome.enabled);
    const active = metroActiveIndex();
    mList.innerHTML = metronome.map.map((sec, i) => `<div class="mp-item ${i === active ? 'active' : ''}" data-i="${i}">
        <span class="mp-time">${fmt2(sec.t)}</span>
        <span class="mp-info">${sec.bpm} BPM · ${sec.beatsPerBar}/${sec.unit}</span>
        ${metronome.map.length > 1 ? `<button class="mp-del" data-i="${i}" title="Delete change">✕</button>` : ''}
      </div>`).join('');
    mList.querySelectorAll('.mp-item').forEach((el) => {
      el.onclick = (e) => { if (e.target.closest('.mp-del')) return; engine.seek(metronome.map[+el.dataset.i].t); refreshMetroUI(); };
    });
    mList.querySelectorAll('.mp-del').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); metronome.removeSectionAt(metronome.map[+b.dataset.i].t); };
    });
    // Detected vs manual state.
    const detStatus = document.getElementById('m-detect-status');
    const detClear = document.getElementById('m-detect-clear');
    const editToggle = document.getElementById('m-edit-toggle');
    const manual = document.getElementById('mp-manual');
    const detected = metronome.source === 'detected' && metronome.detected;
    if (detected) {
      detStatus.textContent = `Detected ✓ (${metronome.detected.length} beats)`;
      detClear.classList.remove('hidden');
      editToggle.classList.remove('hidden');
      manual.classList.add('dim');
    } else {
      detStatus.textContent = 'Manual tempo';
      detClear.classList.add('hidden');
      editToggle.classList.add('hidden');
      manual.classList.remove('dim');
      if (beatEditing) { beatEditing = false; document.getElementById('mp-edit').classList.add('hidden'); editToggle.classList.remove('on'); }
    }
  }
  metronome.onChange = () => { refreshMetroUI(); drawGrid(); persistTempo(); };

  metroBtn.onclick = () => { metroPop.classList.toggle('hidden'); if (!metroPop.classList.contains('hidden')) refreshMetroUI(); };
  mOnoff.onclick = () => metronome.setEnabled(!metronome.enabled);

  const setBpm = (v) => metronome.setSection(engine.getPosition(), { bpm: clamp(Math.round(v), 20, 400) });
  mBpm.onchange = () => setBpm(parseFloat(mBpm.value) || 120);
  document.getElementById('m-bpm-dn').onclick = () => setBpm(activeSection().bpm - 1);
  document.getElementById('m-bpm-up').onclick = () => setBpm(activeSection().bpm + 1);
  mSig.onchange = () => { const [n, u] = mSig.value.split('/').map(Number); metronome.setSection(engine.getPosition(), { beatsPerBar: n, unit: u }); };
  document.getElementById('m-setdown').onclick = () => metronome.setDownbeatAt(engine.getPosition());
  mAccent.onchange = () => metronome.setAccent(mAccent.checked);
  mCountin.onchange = () => metronome.setCountIn(mCountin.checked);
  mVol.oninput = () => metronome.setVolume(parseFloat(mVol.value));
  document.getElementById('m-add').onclick = () => { const s = activeSection(); metronome.addChangeAt(engine.getPosition(), s.bpm, s.beatsPerBar, s.unit); };

  // Tap tempo: tap interval sets BPM; the first tap of a burst sets the downbeat.
  let taps = [];
  let tapReset = null;
  document.getElementById('m-tap').onclick = () => {
    const wall = performance.now() / 1000;
    if (!taps.length) taps._firstMedia = engine.getPosition();
    taps.push(wall);
    if (taps.length > 8) taps.shift();
    if (taps.length >= 2) {
      let sum = 0;
      for (let i = 1; i < taps.length; i++) sum += taps[i] - taps[i - 1];
      const bpm = clamp(Math.round(60 / (sum / (taps.length - 1))), 20, 400);
      const s = activeSection();
      s.bpm = bpm;
      s.t = Math.max(0, taps._firstMedia ?? s.t);
      metronome.recompute(); metronome._notify();
      if (!metronome.enabled) metronome.setEnabled(true);
    }
    clearTimeout(tapReset);
    tapReset = setTimeout(() => { taps = []; }, 2000);
  };

  // Auto-detect (BeatNet), now a Modal job. The first run of the day pays a
  // container cold start, so the status line tracks the job's own messages.
  const mDetect = document.getElementById('m-detect');
  const mDetectStatus = document.getElementById('m-detect-status');
  const mDetectClear = document.getElementById('m-detect-clear');
  let detecting = false;
  mDetect.onclick = async () => {
    if (detecting) return;
    detecting = true;
    mDetect.disabled = true;
    mDetectStatus.textContent = 'Starting…';
    let res;
    try {
      res = await backend.detectBeats(song.id, (msg) => {
        mDetectStatus.textContent = String(msg).slice(0, 70);
      });
    } catch (e) {
      res = { error: String(e.message || e) };
    }
    detecting = false;
    mDetect.disabled = false;
    if (res.error) { mDetectStatus.textContent = '⚠ ' + res.error.split('\n')[0].slice(0, 64); return; }
    metronome.setDetected(res.beats);
    if (!metronome.enabled) metronome.setEnabled(true);
    refreshMetroUI();
  };
  mDetectClear.onclick = () => { beatEditing = false; metronome.clearDetected(); };

  // Manual beat correction
  const mpEdit = document.getElementById('mp-edit');
  const mEditToggle = document.getElementById('m-edit-toggle');
  mEditToggle.onclick = () => {
    beatEditing = !beatEditing;
    mEditToggle.classList.toggle('on', beatEditing);
    mpEdit.classList.toggle('hidden', !beatEditing);
    interact.style.cursor = beatEditing ? 'copy' : 'text';
    drawGrid();
  };
  const editTarget = () => selectedBeat || metronome.nearestBeat(engine.getPosition(), 0.4);
  document.getElementById('be-add').onclick = () => selectBeat(metronome.addBeat(engine.getPosition(), false));
  document.getElementById('be-down').onclick = () => { const b = editTarget(); if (b) { metronome.toggleDownbeat(b); selectBeat(b); } };
  document.getElementById('be-del').onclick = () => { const b = editTarget(); if (b) { metronome.removeBeat(b); selectedBeat = null; drawGrid(); } };
  document.getElementById('be-shl').onclick = () => metronome.shiftAll(-0.01);
  document.getElementById('be-shr').onclick = () => metronome.shiftAll(0.01);

  async function doPlayPause() {
    if (engine.playing) { engine.pause(); setPlayIcon(); return; }
    if (metronome.enabled && metronome.countIn) {
      playBtn.disabled = true;
      metronome.countInThenPlay(async () => { await engine.play(); playBtn.disabled = false; setPlayIcon(); });
    } else { await engine.play(); setPlayIcon(); }
  }
  playBtn.onclick = doPlayPause;

  // ---- initial draw + resize ----
  requestAnimationFrame(() => { drawWaveforms(); drawMini(); updateLoopOverlay(); });
  const ro = new ResizeObserver(() => { drawWaveforms(); drawMini(); updateLoopOverlay(); });
  ro.observe(tracksEl);
  ro.observe(overview);
  cleanupFns.push(() => ro.disconnect());

  // ---- animation loop (playhead + auto-follow) ----
  function frame() {
    const pos = engine.getPosition();
    // auto-scroll the view to keep the playhead visible while playing
    if (engine.playing && (pos < view.start || pos > view.end)) {
      const sp = span();
      setView(pos - sp * 0.1, pos - sp * 0.1 + sp);
    }
    const x = timeToX(pos);
    const w = waveW();
    playhead.style.display = pos >= view.start && pos <= view.end ? 'block' : 'none';
    playhead.style.left = clamp(x, 0, w) + 'px';
    miniPlay.style.left = (pos / duration) * overview.clientWidth + 'px';
    timeEl.textContent = `${fmt2(pos)} / ${fmt(duration)}`;
    // Keep the metronome popover's active-section display in sync as the
    // playhead crosses tempo changes (cheap; only when the popover is open).
    if (!metroPop.classList.contains('hidden')) {
      const idx = metroActiveIndex();
      if (idx !== frame._lastIdx) { frame._lastIdx = idx; refreshMetroUI(); }
    }
    playhead.classList.toggle('snap-on', shouldSnapToGrid());
    engine.tickEnd();
    rafId = requestAnimationFrame(frame);
  }
  frame();

  // ---- keyboard ----
  keyHandler = (e) => {
    if ((e.target.tagName === 'INPUT' && e.target.type !== 'range') || e.target.tagName === 'SELECT') return;
    const k = e.key;
    if (beatEditing && selectedBeat && (k === 'Delete' || k === 'Backspace')) { e.preventDefault(); metronome.removeBeat(selectedBeat); selectedBeat = null; drawGrid(); return; }
    if (beatEditing && selectedBeat && k.toLowerCase() === 'd') { metronome.toggleDownbeat(selectedBeat); drawGrid(); return; }
    if (e.code === 'Space') { e.preventDefault(); doPlayPause(); }
    else if (k.toLowerCase() === 'm') metroBtn.click();
    else if (k.toLowerCase() === 'g') gridToggle.click();
    else if (k.toLowerCase() === 's') gridSnap.click();
    else if (e.code === 'ArrowLeft') seekTo(engine.getPosition() - (e.shiftKey ? 1 : 5));
    else if (e.code === 'ArrowRight') seekTo(engine.getPosition() + (e.shiftKey ? 1 : 5));
    else if (k === ',') seekTo(engine.getPosition() - (e.shiftKey ? 0.01 : 0.05));
    else if (k === '.') seekTo(engine.getPosition() + (e.shiftKey ? 0.01 : 0.05));
    else if (k === '[') { const t = snapTime(engine.getPosition()); engine.setLoop(true, t, Math.max(engine.loop.b, t + 0.1)); setLoopBtn(true); updateLoopOverlay(); }
    else if (k === ']') { const t = snapTime(engine.getPosition()); engine.setLoop(true, Math.min(engine.loop.a, t - 0.1), t); setLoopBtn(true); updateLoopOverlay(); }
    else if (k.toLowerCase() === 'l') loopToggle.click();
    else if (k === 'Home') { if (engine.loop.enabled && engine.loop.b > engine.loop.a) seekTo(engine.loop.a); }
    else if (k === 'End') { if (engine.loop.enabled && engine.loop.b > engine.loop.a) seekTo(engine.loop.b); }
    else if (k === '-' || k === '_') zoomAt(engine.getPosition(), 2);
    else if (k === '=' || k === '+') zoomAt(engine.getPosition(), 0.5);
    else if (k === '\\') fit();
    else if (k === '0') document.getElementById('mixer-reset').click();
    else if (/^[1-9]$/.test(k)) {
      const row = trackRows[parseInt(k, 10) - 1];
      if (row) { row.row.querySelector('.tbtn.mute').classList.toggle('on', engine.toggleMute(row.track.name)); drawWaveforms(); }
    }
  };
  window.addEventListener('keydown', keyHandler);
}
