// The Stage's playthrough video (shared/video.ts). Each video is a muted YouTube player
// (src/js/video/youtube-player.js) kept on the transport by src/js/video/video-sync.js: it plays, pauses, jumps,
// loops and changes speed with the song.
//
//   createVideoPanel(host, {session, stage, store, prefs?, createPlayer?, timers?, device?}) → {el, tick(), destroy()}
//     store   video-store.js (the song's videos and the angle shown); host is the Stage's .stage-video
//
// Where it sits (this device, prefs.video.dock): 'side' beside the music, 'top' above it, 'float' a small window in
// a corner of the music; 'auto' is side on the rail (laptops, landscape iPads) and top on the band (portrait, phones).
// Side and top have a divider to drag (or arrow keys on it) for their size; the floating window is dragged to any
// corner (it snaps) and resized from its inner corner. Sizes are remembered per dock (prefs.video.side/top/float).
//
// Its controls sit on the video, out of the way: the angles (chips, when there are several), the sound (on/off) and
// ⋯: Line up…, Mirror, Reset zoom, Show all angles, Layout ▸ and Hide video. On a mouse they show while the pointer is
// over the video; on touch they stay, small. With several videos and room for them (side, top), Show all angles plays
// them together; else the others wait as thumbnails under the video (side) to switch to.
// Wheel or pinch zooms into the picture (up to ZOOM_MAX), drag pans it, a double-click resets it; with Mirror, this
// is the device's per video (deviceStore 'videoView'). YouTube's own title bar and pause overlays are cropped out of
// the picture (video.css), and presses never reach its player: a stray tap can't pause it.
//   Root attributes for tests: data-dock, data-status (of the first screen), data-video-id, data-all.

import {effect, untracked} from '../app/store.js';
import {prefs as appPrefs, deviceStore, VIDEO_SIZE} from '../app/prefs.js';
import {h} from '../ui/h.js';
import {icon} from '../ui/icon.js';
import {Menu} from '../ui/menu.js';
import {createYouTubePlayer} from '../js/video/youtube-player.js';
import {SYNC, createVideoSync} from '../js/video/video-sync.js';
import {videoLabel} from '../../shared/video.ts';
import {COPY, clockTime} from './video.copy.js';

/** YouTube's player error codes: 100 = removed or private, 101/150 = the owner refuses embedding. */
const BLOCKED = new Set([101, 150]);
export const ZOOM_MAX = 3;
/** Most videos played at once (Show all angles). */
export const ALL_MAX = 4;
/** Above the music, the most of the height the video takes until the user drags it. */
export const TOP_AUTO_MAX = 0.4;
export const TOP_AUTO_MAX_NARROW = 0.5;
const DOCKS = ['side', 'top', 'float'];

/** The dock in effect: the device's choice, else side on the rail and top on the band. */
export function dockFor(pref, layout) {
  return DOCKS.includes(pref) ? pref : layout === 'rail' ? 'side' : 'top';
}

/** A view {zoom, x, y, mirror} with its pan kept inside the picture (x, y are shares of the box, from its centre). */
export function clampView(view) {
  const zoom = Math.max(1, Math.min(ZOOM_MAX, Number(view?.zoom) || 1));
  const room = (zoom - 1) / 2;
  const clamp = (v) => Math.max(-room, Math.min(room, Number(v) || 0));
  return {zoom, x: clamp(view?.x), y: clamp(view?.y), mirror: !!view?.mirror};
}

/** The corner nearest a point, in a box: 'tl' | 'tr' | 'bl' | 'br'. */
export function nearestCorner(x, y, box) {
  return `${y < box.top + box.height / 2 ? 't' : 'b'}${x < box.left + box.width / 2 ? 'l' : 'r'}`;
}

const thumbUrl = (videoId) => `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`;
const peek = (v) => (v && typeof v.peek === 'function' ? v.peek() : v);

export function createVideoPanel(host, {session, stage, store, prefs = appPrefs, createPlayer = null, timers = globalThis,
  device = deviceStore('videoView')} = {}) {
  const make = createPlayer ?? globalThis.__woodshedVideoPlayer ?? createYouTubePlayer;
  const doc0 = () => host.ownerDocument;
  const offs = [];
  const screens = new Map();   // video id → screen
  let destroyed = false, timer = null, menu = null, dock = null;

  const screensEl = h('div', {class: 'stage-video-screens'});
  const thumbs = h('div', {class: 'stage-video-thumbs', attrs: {role: 'group', 'aria-label': COPY.angles}});
  const divider = h('div', {class: 'stage-video-divider', tabindex: 0, attrs: {role: 'separator', 'aria-label': COPY.resize}});
  const grip = h('div', {class: 'stage-video-grip', attrs: {'aria-hidden': 'true'}});
  const el = h('section', {class: 'stage-video-panel', attrs: {'aria-label': COPY.region}, dataset: {status: 'waiting'}},
    divider, screensEl, thumbs, grip);
  host.append(el);

  const pref = (path) => prefs.get(`video.${path}`);
  const layoutNow = () => (peek(stage?.layout) === 'rail' ? 'rail' : 'band');
  const viewOf = (videoId) => clampView(device.get(videoId) ?? {});
  const saveView = (videoId, view) => device.set(videoId, clampView(view));

  // ---------------------------------------------------------------- screens

  function buildScreen(video) {
    const frame = h('div', {class: 'stage-video-frame'});
    const viewport = h('div', {class: 'stage-video-viewport'}, frame);
    const shield = h('div', {class: 'stage-video-shield', attrs: {'aria-hidden': 'true'}});
    const status = h('p', {class: 'stage-video-status', attrs: {role: 'status'}, hidden: true});
    const chips = h('div', {class: 'stage-video-chips', attrs: {role: 'group', 'aria-label': COPY.angles}});
    const sound = h('button', {type: 'button', class: 'stage-video-tool', dataset: {tool: 'sound'}});
    const more = h('button', {type: 'button', class: 'stage-video-tool', dataset: {tool: 'more'}, attrs: {'aria-label': COPY.more, 'aria-haspopup': 'menu', title: COPY.more}},
      icon('ellipsis', {size: 20}));
    const tools = h('div', {class: 'stage-video-tools'}, sound, more);
    const overlay = h('div', {class: 'stage-video-overlay'}, chips, tools);
    const box = h('div', {class: 'stage-video-box'}, viewport, shield, status, overlay);
    const screen = {video, box, viewport, frame, shield, status, chips, sound, more, tools, player: null, sync: null, state: 'waiting', view: viewOf(video.videoId)};
    sound.addEventListener('click', () => toggleSound());
    more.addEventListener('click', () => openMenu(more, screen));
    bindGestures(screen);
    mountPlayer(screen);
    applyView(screen);
    return screen;
  }

  function mountPlayer(screen) {
    screen.player?.destroy?.();
    screen.player = make(screen.frame, {videoId: screen.video.videoId});
    screen.player.setVolume?.(Number(pref('volume')) || 0);
    screen.videoId = screen.video.videoId;
    const id = screen.video.id;
    screen.sync = createVideoSync({
      player: screen.player,
      transport: session.transport,
      offset: () => store.videos.peek().find((v) => v.id === id)?.offset ?? 0,
    });
    showStatus(screen, 'waiting', COPY.loading);
  }

  function destroyScreen(screen) {
    screen.player?.destroy?.();
    screen.box.remove();
  }

  function applyView(screen) {
    const {zoom, x, y, mirror} = screen.view;
    screen.viewport.style.transform = `translate(${x * 100}%, ${y * 100}%) scale(${zoom})${mirror ? ' scaleX(-1)' : ''}`;
    if (zoom > 1) screen.box.dataset.zoomed = ''; else delete screen.box.dataset.zoomed;
  }

  function showStatus(screen, kind, text, {action} = {}) {
    screen.state = kind;
    screen.box.dataset.status = kind;
    screen.status.replaceChildren();
    screen.status.hidden = !text;
    if (text) screen.status.append(h('span', {}, text));
    if (action) screen.status.append(action);
  }

  function youtubeLink(videoId) {
    return h('a', {class: 'stage-video-link', href: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, target: '_blank', rel: 'noopener noreferrer'},
      COPY.openOnYouTube);
  }

  // ---------------------------------------------------------------- what is shown

  function shownVideos() {
    const list = store.videos.peek();
    const all = !!pref('all') && list.length > 1 && dock !== 'float';
    if (all) return list.slice(0, ALL_MAX);
    const v = list.find((x) => x.id === store.angle.peek()) ?? list[0];
    return v ? [v] : [];
  }

  function render() {
    if (destroyed) return;
    dock = dockFor(pref('dock'), layoutNow());
    const list = store.videos.peek();
    const shown = shownVideos();
    const all = shown.length > 1;
    el.dataset.dock = dock;
    host.dataset.dock = dock;
    if (all) el.dataset.all = ''; else delete el.dataset.all;
    // Keep the players of the videos still shown (a reload would lose their place); make the new ones.
    const keep = new Set(shown.map((v) => v.id));
    for (const [id, screen] of screens) if (!keep.has(id)) { destroyScreen(screen); screens.delete(id); }
    for (const v of shown) {
      let screen = screens.get(v.id);
      if (!screen) { screen = buildScreen(v); screens.set(v.id, screen); }
      else if (screen.videoId !== v.videoId) { screen.video = v; mountPlayer(screen); screen.view = viewOf(v.videoId); applyView(screen); }
      screen.video = v;
    }
    screensEl.replaceChildren(...shown.map((v) => screens.get(v.id).box));
    // Controls: the first screen carries the angles (one at a time) and the tools; with all angles each is labelled.
    shown.forEach((v, i) => {
      const screen = screens.get(v.id);
      screen.chips.replaceChildren();
      screen.tools.hidden = i > 0;
      if (all) screen.chips.append(h('span', {class: 'stage-video-chip', dataset: {label: ''}}, videoLabel(v, list.indexOf(v))));
      else if (list.length > 1 && dock !== 'side') {
        for (const [j, other] of list.entries()) {
          const chip = h('button', {type: 'button', class: 'stage-video-chip', attrs: {'aria-pressed': String(other.id === v.id)}}, videoLabel(other, j));
          chip.addEventListener('click', () => store.setAngle(other.id));
          screen.chips.append(chip);
        }
      }
      screen.chips.hidden = !screen.chips.childNodes.length;
    });
    // Side dock, one at a time: the other angles as thumbnails under the video.
    const others = !all && dock === 'side' && list.length > 1 ? list.filter((v) => v.id !== shown[0]?.id) : [];
    thumbs.replaceChildren(...others.map((v) => {
      const b = h('button', {type: 'button', class: 'stage-video-thumb', attrs: {'aria-label': COPY.watch(videoLabel(v, list.indexOf(v)))}},
        h('img', {src: thumbUrl(v.videoId), alt: '', loading: 'lazy', referrerPolicy: 'no-referrer'}),
        h('span', {}, videoLabel(v, list.indexOf(v))));
      b.addEventListener('click', () => store.setAngle(v.id));
      return b;
    }));
    thumbs.hidden = !others.length;
    paintSound();
    applySize();
    el.dataset.videoId = shown[0]?.videoId ?? '';
  }

  // ---------------------------------------------------------------- sound

  function paintSound() {
    const on = (Number(pref('volume')) || 0) > 0;
    for (const screen of screens.values()) {
      screen.sound.replaceChildren(icon(on ? 'volume-2' : 'volume-x', {size: 20}));
      screen.sound.setAttribute('aria-label', on ? COPY.soundOff : COPY.soundOn);
      screen.sound.title = on ? COPY.soundOff : COPY.soundOn;
      screen.sound.setAttribute('aria-pressed', String(on));
    }
  }
  function toggleSound() {
    const volume = Number(pref('volume')) || 0;
    prefs.update((d) => {
      if (volume > 0) { d.video.unmuted = volume; d.video.volume = 0; } else d.video.volume = d.video.unmuted || 60;
    });
  }

  // ---------------------------------------------------------------- the menu

  function openMenu(anchor, screen) {
    menu?.close?.();
    const list = store.videos.peek();
    const view = screen.view;
    const setDock = (value) => prefs.set('video.dock', value);
    const items = [
      {id: 'lineup', label: COPY.lineUp, icon: 'sliders-horizontal', run: () => stage?.openSheet?.('video', {anchor})},
      {id: 'mirror', label: COPY.mirror, type: 'checkbox', checked: view.mirror, run: () => setView(screen, {...screen.view, mirror: !screen.view.mirror})},
      ...(view.zoom > 1 ? [{id: 'zoom', label: COPY.resetZoom, icon: 'zoom-out', run: () => setView(screen, {...screen.view, zoom: 1, x: 0, y: 0})}] : []),
      ...(list.length > 1 && dock !== 'float' ? [{id: 'all', label: COPY.allAngles, type: 'checkbox', checked: !!pref('all'), run: () => prefs.set('video.all', !pref('all'))}] : []),
      {type: 'submenu', label: COPY.layout, icon: 'layout-grid', items: [
        {id: 'dock-auto', label: COPY.docks.auto, type: 'radio', checked: (pref('dock') ?? 'auto') === 'auto', run: () => setDock('auto')},
        {id: 'dock-side', label: COPY.docks.side, type: 'radio', checked: pref('dock') === 'side', run: () => setDock('side')},
        {id: 'dock-top', label: COPY.docks.top, type: 'radio', checked: pref('dock') === 'top', run: () => setDock('top')},
        {id: 'dock-float', label: COPY.docks.float, type: 'radio', checked: pref('dock') === 'float', run: () => setDock('float')},
      ]},
      {type: 'separator'},
      {id: 'hide', label: COPY.hide, icon: 'x', kbd: 'KeyY', run: () => stage?.setVideoShown?.(false)},
    ];
    menu = Menu({items, anchor, placement: 'bottom', label: COPY.more, onClose: () => { menu = null; }});
  }

  function setView(screen, view) {
    screen.view = clampView(view);
    applyView(screen);
    saveView(screen.video.videoId, screen.view);
  }

  // ---------------------------------------------------------------- zoom, pan, move

  function bindGestures(screen) {
    const {shield, box} = screen;
    const pointers = new Map();
    let gesture = null;   // {kind: 'pan'|'pinch'|'move', …}

    shield.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = box.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5, py = (e.clientY - r.top) / r.height - 0.5;
      const v = screen.view;
      const zoom = Math.max(1, Math.min(ZOOM_MAX, v.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
      // The point under the pointer stays under it.
      const ux = (px - v.x) / v.zoom, uy = (py - v.y) / v.zoom;
      setView(screen, {...v, zoom, x: px - ux * zoom, y: py - uy * zoom});
    }, {passive: false});

    shield.addEventListener('dblclick', (e) => { e.preventDefault(); setView(screen, {...screen.view, zoom: 1, x: 0, y: 0}); });

    shield.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
      try { shield.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      const r = box.getBoundingClientRect();
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        gesture = {kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: screen.view.zoom};
      } else if (screen.view.zoom > 1) gesture = {kind: 'pan', x0: e.clientX, y0: e.clientY, v0: screen.view, w: r.width, h: r.height};
      else if (dock === 'float') gesture = {kind: 'move', x0: e.clientX, y0: e.clientY};
      else gesture = null;
    });
    shield.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
      if (!gesture) return;
      if (gesture.kind === 'pinch' && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const zoom = gesture.z0 * Math.hypot(a.x - b.x, a.y - b.y) / gesture.d0;
        screen.view = clampView({...screen.view, zoom});
        applyView(screen);
      } else if (gesture.kind === 'pan') {
        screen.view = clampView({...gesture.v0, x: gesture.v0.x + (e.clientX - gesture.x0) / gesture.w, y: gesture.v0.y + (e.clientY - gesture.y0) / gesture.h});
        applyView(screen);
      } else if (gesture.kind === 'move') {
        host.style.translate = `${e.clientX - gesture.x0}px ${e.clientY - gesture.y0}px`;
        host.dataset.moving = '';
      }
    });
    const end = (e) => {
      if (!pointers.delete(e.pointerId)) return;
      if (gesture?.kind === 'move') {
        const body = host.parentElement.getBoundingClientRect(), r = host.getBoundingClientRect();
        host.style.translate = '';
        delete host.dataset.moving;
        const corner = nearestCorner(r.left + r.width / 2, r.top + r.height / 2, body);
        if (corner !== pref('float.corner')) prefs.set('video.float.corner', corner);
      } else if (gesture) saveView(screen.video.videoId, screen.view);
      gesture = pointers.size === 1 && screen.view.zoom > 1
        ? (() => { const [p] = [...pointers.values()]; const r = box.getBoundingClientRect(); return {kind: 'pan', x0: p.x, y0: p.y, v0: screen.view, w: r.width, h: r.height}; })()
        : null;
    };
    shield.addEventListener('pointerup', end);
    shield.addEventListener('pointercancel', end);
  }

  // ---------------------------------------------------------------- size (divider, floating window)

  /** Above the music, until dragged: as tall as the video needs at the full width, at most TOP_AUTO_MAX of the height. */
  function autoTop() {
    const body = host.parentElement?.getBoundingClientRect?.();
    if (!body?.width || !body?.height) return 0.3;
    const want = (body.width * 9 / 16 + 16) / body.height;
    // A phone's narrow screen: the full width matters more than the chart's height.
    return Math.max(VIDEO_SIZE.top[0], Math.min(body.width < 640 ? TOP_AUTO_MAX_NARROW : TOP_AUTO_MAX, want));
  }
  function sizeNow() {
    if (dock === 'float') return Number(pref('float.width')) || 360;
    if (dock === 'top') return Number.isFinite(pref('top')) ? pref('top') : autoTop();
    return Number(pref('side')) || 0.32;
  }

  function applySize(value = sizeNow()) {
    host.style.inlineSize = host.style.blockSize = host.style.width = '';
    if (dock === 'side') host.style.inlineSize = `${value * 100}%`;
    else if (dock === 'top') host.style.blockSize = `${value * 100}%`;
    else {
      host.style.width = `${value}px`;
      host.dataset.corner = pref('float.corner') ?? 'br';
    }
    if (dock !== 'float') delete host.dataset.corner;
    const [min, max] = VIDEO_SIZE[dock];
    divider.hidden = dock === 'float';
    grip.hidden = dock !== 'float';
    divider.setAttribute('aria-orientation', dock === 'side' ? 'vertical' : 'horizontal');
    divider.setAttribute('aria-valuemin', String(Math.round(min * 100)));
    divider.setAttribute('aria-valuemax', String(Math.round(max * 100)));
    divider.setAttribute('aria-valuenow', String(Math.round(value * 100)));
  }

  function bindResize() {
    let drag = null;
    divider.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { divider.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      drag = {body: host.parentElement.getBoundingClientRect(), value: sizeNow()};
      host.dataset.resizing = '';
    });
    divider.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const [min, max] = VIDEO_SIZE[dock];
      const raw = dock === 'side' ? (drag.body.right - e.clientX) / drag.body.width : (e.clientY - drag.body.top) / drag.body.height;
      drag.value = Math.max(min, Math.min(max, raw));
      applySize(drag.value);
    });
    const done = () => {
      if (!drag) return;
      delete host.dataset.resizing;
      prefs.set(`video.${dock}`, Math.round(drag.value * 1000) / 1000);
      drag = null;
    };
    divider.addEventListener('pointerup', done);
    divider.addEventListener('pointercancel', done);
    divider.addEventListener('dblclick', () => prefs.set(`video.${dock}`, dock === 'side' ? 0.32 : null));
    divider.addEventListener('keydown', (e) => {
      const grow = dock === 'side' ? {ArrowLeft: 1, ArrowRight: -1} : {ArrowDown: 1, ArrowUp: -1};
      const step = grow[e.key];
      if (!step) return;
      e.preventDefault();
      e.stopPropagation();
      const [min, max] = VIDEO_SIZE[dock];
      prefs.set(`video.${dock}`, Math.max(min, Math.min(max, Math.round((sizeNow() + step * 0.02) * 100) / 100)));
    });
    divider.dataset.consumeKeys = 'ArrowLeft ArrowRight ArrowUp ArrowDown';

    let resize = null;
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { grip.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      resize = {x0: e.clientX, w0: sizeNow(), sign: (pref('float.corner') ?? 'br').endsWith('r') ? -1 : 1, value: sizeNow()};
    });
    grip.addEventListener('pointermove', (e) => {
      if (!resize) return;
      const [min, max] = VIDEO_SIZE.float;
      resize.value = Math.round(Math.max(min, Math.min(max, resize.w0 + resize.sign * (e.clientX - resize.x0))));
      applySize(resize.value);
    });
    const finish = () => { if (resize) { prefs.set('video.float.width', resize.value); resize = null; } };
    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);
  }
  bindResize();

  // ---------------------------------------------------------------- sync

  function tick() {
    if (destroyed) return;
    for (const screen of screens.values()) {
      const {player, sync} = screen;
      if (!player || !sync) continue;
      if (player.error != null) {
        showStatus(screen, 'error', BLOCKED.has(player.error) ? COPY.blocked : player.error === 100 ? COPY.missing : COPY.failed,
          {action: youtubeLink(screen.video.videoId)});
        continue;
      }
      const state = sync.tick();
      if (state === 'before') showStatus(screen, 'before', COPY.before(clockTime(-(screen.video.offset ?? 0))));
      else if (state === 'after') showStatus(screen, 'after', COPY.after);
      else if (state === 'waiting') showStatus(screen, 'waiting', COPY.loading);
      else if (screen.state !== state || !screen.status.hidden) showStatus(screen, state, '');
    }
    const first = screens.get(shownVideos()[0]?.id);
    el.dataset.status = first?.state ?? 'waiting';
  }

  // The list, the angle, the dock, the size and showing all: one render (players are kept where they can be).
  offs.push(effect(() => {
    store.videos.value; store.angle.value; peek(stage?.layout?.value);
    const p = prefs.get('video');
    void [p?.dock, p?.all, p?.side, p?.top, p?.float?.width, p?.float?.corner];
    untracked(render);
  }));
  // The device's video sound.
  offs.push(effect(() => {
    const volume = Number(prefs.get('video.volume')) || 0;
    untracked(() => {
      for (const screen of screens.values()) screen.player?.setVolume?.(volume);
      paintSound();
    });
  }));

  // Above the music and not dragged: its height follows the width (a rotation, a window resize).
  const RO = doc0().defaultView?.ResizeObserver;
  if (RO && host.parentElement) {
    const ro = new RO(() => { if (dock === 'top' && !Number.isFinite(pref('top'))) applySize(); });
    ro.observe(host.parentElement);
    offs.push(() => ro.disconnect());
  }

  timer = timers.setInterval(tick, SYNC.intervalMs);
  tick();

  return {
    el,
    get player() { return screens.get(shownVideos()[0]?.id)?.player ?? null; },
    get players() { return [...screens.values()].map((s) => s.player); },
    tick,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      timers.clearInterval(timer);
      menu?.close?.();
      for (const off of offs.splice(0)) { try { off(); } catch { /* best effort */ } }
      for (const screen of screens.values()) destroyScreen(screen);
      screens.clear();
      for (const k of ['dock', 'corner', 'moving', 'resizing']) delete host.dataset[k];
      host.style.inlineSize = host.style.blockSize = host.style.width = host.style.translate = '';
      el.remove();
    },
  };
}
