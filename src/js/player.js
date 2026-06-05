import { MultitrackEngine } from './engine.js';
import { computePeaksRange, drawWaveform } from './waveform.js';

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

let engine = null;
let rafId = null;
let keyHandler = null;
let cleanupFns = [];

export function closePlayer() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (engine) { engine.destroy(); engine = null; }
  if (keyHandler) { window.removeEventListener('keydown', keyHandler); keyHandler = null; }
  cleanupFns.forEach((fn) => fn());
  cleanupFns = [];
}

export async function openPlayer(song) {
  closePlayer();
  const root = document.getElementById('player-root');
  root.innerHTML = `<div class="loading"><div class="spinner"></div><p style="margin-top:14px">Loading stems…</p></div>`;

  engine = new MultitrackEngine();
  const stems = song.stems.map((s) => ({ name: s.name, url: window.api.mediaUrl(song.id, s.file), color: colorFor(s.name) }));

  let info;
  try { info = await engine.loadStems(stems); }
  catch (e) { root.innerHTML = `<div class="loading"><p>Couldn't load audio: ${e.message}</p></div>`; return; }

  const duration = info.duration;
  const view = { start: 0, end: duration }; // visible time window

  const cover = song.thumb ? `style="background-image:url('${window.api.mediaUrl(song.id, song.thumb)}')"` : '';
  root.innerHTML = `
    <div class="player-head">
      <div class="cover" ${cover}></div>
      <div>
        <div class="ptitle">${escapeHtml(song.title)}</div>
        <div class="psub">${escapeHtml(song.artist || song.uploader || '')} · ${song.stems.length} stems · ${song.quality?.model || ''}</div>
      </div>
    </div>

    <div class="tracks" id="tracks">
      <div class="timeline" id="timeline">
        <div class="loop-region" id="loop-region" style="display:none"></div>
        <div class="loop-handle" id="handle-a" style="display:none"></div>
        <div class="loop-handle" id="handle-b" style="display:none"></div>
        <div class="playhead" id="playhead" style="left:0"></div>
        <div class="time-tip" id="time-tip" style="display:none"></div>
      </div>
      <div class="timeline" id="timeline-interact"></div>
    </div>

    <div class="overview" id="overview" title="Drag the bracket to pan · drag its edges to zoom · click to seek">
      <canvas id="mini-canvas"></canvas>
      <div class="mini-loop" id="mini-loop" style="display:none"></div>
      <div class="mini-view" id="mini-view"><span class="mv-edge l"></span><span class="mv-edge r"></span></div>
      <div class="mini-playhead" id="mini-playhead"></div>
    </div>

    <div class="transport">
      <div class="transport-main">
        <button class="play-btn" id="play">▶</button>
        <div class="time" id="time">0:00.00 / ${fmt(duration)}</div>
        <div class="loop-readout" id="loop-readout">
          <span class="lr-label">Loop</span>
          <button class="nudge" data-edge="a" data-d="-0.05">−</button>
          <span class="lr-val" id="lr-a">—</span>
          <button class="nudge" data-edge="a" data-d="0.05">+</button>
          <span class="lr-sep">→</span>
          <button class="nudge" data-edge="b" data-d="-0.05">−</button>
          <span class="lr-val" id="lr-b">—</span>
          <button class="nudge" data-edge="b" data-d="0.05">+</button>
          <span class="lr-len" id="lr-len"></span>
        </div>
      </div>
      <div class="transport-tools">
        <div class="tool">
          <span>Zoom</span>
          <button class="toggle-btn" id="zoom-out">−</button>
          <button class="toggle-btn" id="zoom-in">+</button>
          <button class="toggle-btn" id="zoom-fit">Fit</button>
        </div>
        <div class="tool">
          <span>Speed</span>
          <input type="range" id="speed" min="0.5" max="1.5" step="0.05" value="1" />
          <span class="speed-val" id="speed-val">1.00×</span>
        </div>
        <div class="tool">
          <button class="toggle-btn" id="set-a">Set A</button>
          <button class="toggle-btn" id="set-b">Set B</button>
          <button class="toggle-btn" id="loop-toggle">Loop</button>
          <button class="toggle-btn" id="loop-clear">Clear</button>
        </div>
        <div class="tool">
          <button class="toggle-btn" id="mixer-reset">Reset mixer</button>
        </div>
        <div class="tool kbd-hint">space · ←/→ seek · ,/. nudge · [ ] set loop · −/= zoom · \\ fit</div>
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
  }

  // ---- overview / minimap ----
  const overview = document.getElementById('overview');
  const miniCanvas = document.getElementById('mini-canvas');
  const miniLoop = document.getElementById('mini-loop');
  const miniView = document.getElementById('mini-view');
  const miniPlay = document.getElementById('mini-playhead');
  function drawMini() {
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
  const EDGE_PX = 7;
  function loopOrder(a, b) { return a <= b ? [a, b] : [b, a]; }

  interact.addEventListener('mousemove', (e) => {
    if (drag) return;
    const r = interact.getBoundingClientRect();
    const x = e.clientX - r.left;
    const t = xToTime(x);
    // hover cursor + time tooltip
    let cursor = 'text';
    const { enabled, a, b } = engine.loop;
    if (enabled && b > a) {
      if (Math.abs(x - timeToX(a)) <= EDGE_PX || Math.abs(x - timeToX(b)) <= EDGE_PX) cursor = 'ew-resize';
      else if (x > timeToX(a) && x < timeToX(b)) cursor = 'grab';
    }
    interact.style.cursor = cursor;
    timeTip.style.display = 'block';
    timeTip.style.left = clamp(x, 0, waveW()) + 'px';
    timeTip.textContent = fmt2(t);
  });
  interact.addEventListener('mouseleave', () => { if (!drag) timeTip.style.display = 'none'; });

  interact.addEventListener('mousedown', (e) => {
    const r = interact.getBoundingClientRect();
    const x = e.clientX - r.left;
    const t = xToTime(x);
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
    if (!drag) return;
    const r = interact.getBoundingClientRect();
    const x = e.clientX - r.left;
    const t = clamp(xToTime(x), 0, duration);
    if (Math.abs(x - drag.startX) > 3) drag.moved = true;
    timeTip.style.display = 'block';
    timeTip.style.left = clamp(x, 0, waveW()) + 'px';
    timeTip.textContent = fmt2(t);

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
    if (!drag) return;
    if (!drag.moved && (drag.mode === 'new')) engine.seek(drag.startT); // click = seek
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
      engine.seek(((clamp(e.clientX - r.left, 0, overview.clientWidth)) / overview.clientWidth) * duration);
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
  document.getElementById('set-a').onclick = () => { const b = engine.loop.b > engine.getPosition() ? engine.loop.b : duration; engine.setLoop(true, engine.getPosition(), b); updateLoopOverlay(); };
  document.getElementById('set-b').onclick = () => { const a = engine.loop.a < engine.getPosition() ? engine.loop.a : 0; engine.setLoop(true, a, engine.getPosition()); updateLoopOverlay(); };
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
    engine.tickEnd();
    rafId = requestAnimationFrame(frame);
  }
  frame();

  // ---- keyboard ----
  keyHandler = (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    const k = e.key;
    if (e.code === 'Space') { e.preventDefault(); engine.playing ? engine.pause() : engine.play(); setPlayIcon(); }
    else if (e.code === 'ArrowLeft') engine.seek(engine.getPosition() - (e.shiftKey ? 1 : 5));
    else if (e.code === 'ArrowRight') engine.seek(engine.getPosition() + (e.shiftKey ? 1 : 5));
    else if (k === ',') engine.seek(engine.getPosition() - (e.shiftKey ? 0.01 : 0.05));
    else if (k === '.') engine.seek(engine.getPosition() + (e.shiftKey ? 0.01 : 0.05));
    else if (k === '[') { engine.setLoop(true, engine.getPosition(), Math.max(engine.loop.b, engine.getPosition() + 0.1)); setLoopBtn(true); updateLoopOverlay(); }
    else if (k === ']') { engine.setLoop(true, Math.min(engine.loop.a, engine.getPosition() - 0.1), engine.getPosition()); setLoopBtn(true); updateLoopOverlay(); }
    else if (k.toLowerCase() === 'l') loopToggle.click();
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
