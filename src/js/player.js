import { MultitrackEngine } from './engine.js';
import { computePeaks, drawWaveform } from './waveform.js';

const STEM_COLOR_VAR = {
  drums: '--drums', bass: '--bass', vocals: '--vocals', other: '--other',
  guitar: '--guitar', piano: '--piano',
  no_drums: '--other', no_vocals: '--vocals', no_bass: '--bass',
};

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}
function colorFor(stem) { return cssVar(STEM_COLOR_VAR[stem] || '--accent'); }
function prettyStem(name) { return name.replace('no_', 'no ').replace('_', ' '); }
function fmt(t) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

let engine = null;
let rafId = null;
let keyHandler = null;

export function closePlayer() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (engine) { engine.destroy(); engine = null; }
  if (keyHandler) { window.removeEventListener('keydown', keyHandler); keyHandler = null; }
}

export async function openPlayer(song) {
  closePlayer();
  const root = document.getElementById('player-root');
  root.innerHTML = `<div class="loading"><div class="spinner"></div><p style="margin-top:14px">Loading stems…</p></div>`;

  engine = new MultitrackEngine();
  const stems = song.stems.map((s) => ({
    name: s.name,
    url: window.api.mediaUrl(song.id, s.file),
    color: colorFor(s.name),
  }));

  let info;
  try {
    info = await engine.loadStems(stems);
  } catch (e) {
    root.innerHTML = `<div class="loading"><p>Couldn't load audio: ${e.message}</p></div>`;
    return;
  }

  const cover = song.thumb
    ? `style="background-image:url('${window.api.mediaUrl(song.id, song.thumb)}')"`
    : '';

  root.innerHTML = `
    <div class="player-head">
      <div class="cover" ${cover}></div>
      <div>
        <div class="ptitle">${escapeHtml(song.title)}</div>
        <div class="psub">${escapeHtml(song.uploader || '')} · ${song.stems.length} stems · ${song.quality?.model || ''}</div>
      </div>
    </div>
    <div class="tracks" id="tracks">
      <div class="timeline" id="timeline">
        <div class="loop-region" id="loop-region" style="display:none"></div>
        <div class="playhead" id="playhead" style="left:0"></div>
      </div>
      <div class="timeline" id="timeline-interact" style="pointer-events:auto;cursor:crosshair" title="Click to seek · drag to set an A–B loop"></div>
    </div>
    <div class="transport">
      <div class="transport-main">
        <button class="play-btn" id="play">▶</button>
        <div class="time" id="time">0:00 / ${fmt(info.duration)}</div>
        <div class="scrub">
          <div class="scrub-track" id="scrub">
            <div class="scrub-loop" id="scrub-loop" style="display:none"></div>
            <div class="scrub-fill" id="scrub-fill"></div>
          </div>
        </div>
      </div>
      <div class="transport-tools">
        <div class="tool">
          <span>Speed</span>
          <input type="range" id="speed" min="0.5" max="1.5" step="0.05" value="1" />
          <span class="speed-val" id="speed-val">1.00×</span>
          <button class="toggle-btn" id="speed-reset">Reset</button>
        </div>
        <div class="tool">
          <button class="toggle-btn" id="loop-toggle">Loop A–B</button>
          <button class="toggle-btn" id="loop-clear">Clear</button>
        </div>
        <div class="tool">
          <button class="toggle-btn" id="mixer-reset">Reset mixer</button>
        </div>
        <div class="tool kbd-hint">space play · ←/→ seek · [ ] set loop · L loop · 1–6 mute · 0 reset</div>
      </div>
    </div>
  `;

  const tracksEl = document.getElementById('tracks');
  const timeline = document.getElementById('timeline');
  const trackRows = [];

  info.tracks.forEach((t, i) => {
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
      <div class="track-wave"><canvas></canvas></div>
    `;
    tracksEl.insertBefore(row, timeline);
    trackRows.push({ track: t, canvas: row.querySelector('canvas'), row });
  });

  // Draw waveforms once laid out.
  const drawAll = () => {
    for (const { track, canvas } of trackRows) {
      const w = Math.max(200, Math.floor(canvas.clientWidth));
      const peaks = computePeaks(track.buffer, w);
      track._peaks = peaks;
      drawWaveform(canvas, peaks, track.color, { dim: track.muted });
    }
  };
  requestAnimationFrame(drawAll);
  const ro = new ResizeObserver(() => drawAll());
  ro.observe(tracksEl);

  // ---- Track controls ----
  tracksEl.querySelectorAll('.tbtn.mute').forEach((btn) => {
    btn.onclick = () => {
      const muted = engine.toggleMute(btn.dataset.stem);
      btn.classList.toggle('on', muted);
      redrawDim();
    };
  });
  tracksEl.querySelectorAll('.tbtn.solo').forEach((btn) => {
    btn.onclick = () => {
      const soloed = engine.toggleSolo(btn.dataset.stem);
      btn.classList.toggle('on', soloed);
      redrawDim();
    };
  });
  tracksEl.querySelectorAll('.track-vol').forEach((sl) => {
    sl.oninput = () => engine.setVolume(sl.dataset.stem, parseFloat(sl.value));
  });

  function redrawDim() {
    const anySolo = engine.tracks.some((t) => t.soloed);
    for (const { track, canvas } of trackRows) {
      const audible = anySolo ? track.soloed : !track.muted;
      drawWaveform(canvas, track._peaks, track.color, { dim: !audible });
    }
  }

  // ---- Transport ----
  const playBtn = document.getElementById('play');
  const playhead = document.getElementById('playhead');
  const scrubFill = document.getElementById('scrub-fill');
  const scrub = document.getElementById('scrub');
  const timeEl = document.getElementById('time');
  const loopRegion = document.getElementById('loop-region');
  const scrubLoop = document.getElementById('scrub-loop');

  function setPlayIcon() { playBtn.textContent = engine.playing ? '❚❚' : '▶'; }
  playBtn.onclick = async () => {
    if (engine.playing) engine.pause(); else await engine.play();
    setPlayIcon();
  };

  engine.onEnded = () => setPlayIcon();

  // Scrub bar seek
  scrub.onclick = (e) => {
    const r = scrub.getBoundingClientRect();
    engine.seek(((e.clientX - r.left) / r.width) * engine.duration);
  };

  // ---- Loop region via drag on the waveform timeline ----
  const interact = document.getElementById('timeline-interact');
  let dragStart = null;
  interact.addEventListener('mousedown', (e) => {
    const r = interact.getBoundingClientRect();
    dragStart = { x: e.clientX, t: ((e.clientX - r.left) / r.width) * engine.duration };
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragStart) return;
    const r = interact.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * engine.duration;
    if (Math.abs(e.clientX - dragStart.x) > 4) {
      const a = Math.max(0, Math.min(dragStart.t, t));
      const b = Math.min(engine.duration, Math.max(dragStart.t, t));
      engine.setLoop(true, a, b);
      updateLoopUI();
      setLoopBtn(true);
    }
  });
  window.addEventListener('mouseup', (e) => {
    if (!dragStart) return;
    if (Math.abs(e.clientX - dragStart.x) <= 4) {
      engine.seek(dragStart.t); // a click = seek
    }
    dragStart = null;
  });

  function updateLoopUI() {
    const { enabled, a, b } = engine.loop;
    if (enabled && b > a) {
      const left = (a / engine.duration) * 100;
      const width = ((b - a) / engine.duration) * 100;
      loopRegion.style.display = 'block';
      loopRegion.style.left = left + '%';
      loopRegion.style.width = width + '%';
      scrubLoop.style.display = 'block';
      scrubLoop.style.left = left + '%';
      scrubLoop.style.width = width + '%';
    } else {
      loopRegion.style.display = 'none';
      scrubLoop.style.display = 'none';
    }
  }

  const loopToggle = document.getElementById('loop-toggle');
  function setLoopBtn(on) { loopToggle.classList.toggle('on', on); }
  loopToggle.onclick = () => {
    const willEnable = !engine.loop.enabled;
    if (willEnable && engine.loop.b <= engine.loop.a) {
      engine.setLoop(true, 0, engine.duration);
    } else {
      engine.setLoop(willEnable);
    }
    setLoopBtn(engine.loop.enabled);
    updateLoopUI();
  };
  document.getElementById('loop-clear').onclick = () => {
    engine.setLoop(false, 0, engine.duration);
    setLoopBtn(false);
    updateLoopUI();
  };

  // ---- Speed ----
  const speed = document.getElementById('speed');
  const speedVal = document.getElementById('speed-val');
  speed.oninput = () => {
    const r = parseFloat(speed.value);
    engine.setSpeed(r);
    speedVal.textContent = r.toFixed(2) + '×';
  };
  document.getElementById('speed-reset').onclick = () => {
    speed.value = 1; engine.setSpeed(1); speedVal.textContent = '1.00×';
  };

  // ---- Mixer reset ----
  document.getElementById('mixer-reset').onclick = () => {
    engine.resetMixer();
    tracksEl.querySelectorAll('.tbtn').forEach((b) => b.classList.remove('on'));
    tracksEl.querySelectorAll('.track-vol').forEach((s) => (s.value = 1));
    redrawDim();
  };

  // ---- Animation loop ----
  function frame() {
    const pos = engine.getPosition();
    const pct = engine.duration ? (pos / engine.duration) * 100 : 0;
    playhead.style.left = pct + '%';
    scrubFill.style.width = pct + '%';
    timeEl.textContent = `${fmt(pos)} / ${fmt(engine.duration)}`;
    engine.tickEnd();
    rafId = requestAnimationFrame(frame);
  }
  frame();

  // ---- Keyboard shortcuts ----
  keyHandler = (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (engine.playing) engine.pause(); else engine.play();
      setPlayIcon();
    } else if (e.code === 'ArrowLeft') {
      engine.seek(engine.getPosition() - (e.shiftKey ? 1 : 5));
    } else if (e.code === 'ArrowRight') {
      engine.seek(engine.getPosition() + (e.shiftKey ? 1 : 5));
    } else if (e.key === '[') {
      engine.setLoop(true, engine.getPosition(), engine.loop.b);
      setLoopBtn(true); updateLoopUI();
    } else if (e.key === ']') {
      engine.setLoop(true, engine.loop.a, engine.getPosition());
      setLoopBtn(true); updateLoopUI();
    } else if (e.key.toLowerCase() === 'l') {
      loopToggle.click();
    } else if (e.key === '0') {
      document.getElementById('mixer-reset').click();
    } else if (/^[1-9]$/.test(e.key)) {
      const idx = parseInt(e.key, 10) - 1;
      const row = trackRows[idx];
      if (row) {
        const muted = engine.toggleMute(row.track.name);
        row.row.querySelector('.tbtn.mute').classList.toggle('on', muted);
        redrawDim();
      }
    }
  };
  window.addEventListener('keydown', keyHandler);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
