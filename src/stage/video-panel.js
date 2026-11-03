// The Stage's playthrough video (shared/video.ts): beside the music on the rail, above it on the band. The video is
// a muted YouTube player (src/js/video/youtube-player.js) kept on the transport by src/js/video/video-sync.js: it
// plays, pauses, jumps, loops and changes speed with the song. Its sound is the device's prefs.video.volume
// (0 = muted, the default: the stems are the song's sound).
//
//   createVideoPanel(host, {session, stage, store, prefs?, createPlayer?, timers?}) → {el, destroy()}
//     store   video-store.js (the song's videos and the angle shown)
//   The bar under the video: the angle (a menu when there are several), Line up… (the Playthrough video sheet) and
//   Hide video (view.video). The video itself takes no presses (a shield covers it): a stray tap never pauses it.
//   Root attributes for tests: data-status (waiting · before · after · synced · catching · error), data-video-id.

import {effect, untracked} from '../app/store.js';
import {prefs as appPrefs} from '../app/prefs.js';
import {h} from '../ui/h.js';
import {icon} from '../ui/icon.js';
import {createYouTubePlayer} from '../js/video/youtube-player.js';
import {SYNC, createVideoSync} from '../js/video/video-sync.js';
import {videoLabel} from '../../shared/video.ts';
import {COPY, clockTime} from './video.copy.js';

/** YouTube's player error codes: 100 = removed or private, 101/150 = the owner refuses embedding. */
const BLOCKED = new Set([101, 150]);

export function createVideoPanel(host, {session, stage, store, prefs = appPrefs, createPlayer = null, timers = globalThis} = {}) {
  const make = createPlayer ?? globalThis.__woodshedVideoPlayer ?? createYouTubePlayer;
  const offs = [];
  let player = null, sync = null, shownId = null, timer = null, destroyed = false;

  const frame = h('div', {class: 'stage-video-frame'});
  const shield = h('div', {class: 'stage-video-shield', attrs: {'aria-hidden': 'true'}});
  const status = h('p', {class: 'stage-video-status', attrs: {role: 'status'}, hidden: true});
  const box = h('div', {class: 'stage-video-box'}, frame, shield, status);
  const angle = h('select', {class: 'stage-video-angle', attrs: {'aria-label': COPY.angle}});
  const angleName = h('span', {class: 'stage-video-name'});
  const lineUp = h('button', {type: 'button', class: 'stage-video-button'}, icon('sliders-horizontal', {size: 20}), h('span', {}, COPY.lineUp));
  const hide = h('button', {type: 'button', class: 'stage-video-icon', attrs: {'aria-label': COPY.hide, title: COPY.hide}}, icon('x', {size: 20}));
  const bar = h('div', {class: 'stage-video-bar'}, angle, angleName, h('span', {class: 'stage-video-gap'}), lineUp, hide);
  const el = h('section', {class: 'stage-video-panel', attrs: {'aria-label': COPY.region}, dataset: {status: 'waiting'}}, box, bar);
  host.append(el);

  angle.addEventListener('change', () => store.setAngle(angle.value));
  lineUp.addEventListener('click', () => stage?.openSheet?.('video', {anchor: lineUp}));
  hide.addEventListener('click', () => stage?.setVideoShown?.(false));

  function showStatus(kind, text, {action} = {}) {
    el.dataset.status = kind;
    status.replaceChildren();
    status.hidden = !text;
    if (!text) return;
    status.append(h('span', {}, text));
    if (action) status.append(action);
  }

  function youtubeLink(videoId) {
    return h('a', {class: 'stage-video-link', href: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, target: '_blank', rel: 'noopener noreferrer'},
      COPY.openOnYouTube);
  }

  function mountPlayer(video) {
    player?.destroy?.();
    player = null;
    sync = null;
    shownId = video?.id ?? null;
    el.dataset.videoId = video?.videoId ?? '';
    if (!video) return;
    player = make(frame, {videoId: video.videoId});
    player.setVolume?.(Number(prefs.get('video.volume')) || 0);
    sync = createVideoSync({
      player,
      transport: session.transport,
      offset: () => store.videos.peek().find((v) => v.id === shownId)?.offset ?? 0,
    });
    showStatus('waiting', COPY.loading);
  }

  function tick() {
    if (destroyed || !player || !sync) return;
    if (player.error != null) {
      const id = el.dataset.videoId;
      showStatus('error', BLOCKED.has(player.error) ? COPY.blocked : player.error === 100 ? COPY.missing : COPY.failed, {action: youtubeLink(id)});
      return;
    }
    const state = sync.tick();
    if (state === 'before') {
      const offset = store.current()?.offset ?? 0;
      showStatus('before', COPY.before(clockTime(-offset)));
    } else if (state === 'after') showStatus('after', COPY.after);
    else if (state === 'waiting') showStatus('waiting', COPY.loading);
    else showStatus(state, '');
  }

  // The list and the angle shown: the menu, and the player when the shown video (or its id) changes.
  offs.push(effect(() => {
    const list = store.videos.value;
    const id = store.angle.value;
    untracked(() => {
      angle.replaceChildren(...list.map((v, i) => h('option', {value: v.id, selected: v.id === id}, videoLabel(v, i))));
      angle.value = id ?? '';
      angle.hidden = list.length < 2;
      const index = list.findIndex((v) => v.id === id);
      angleName.textContent = list.length < 2 && index >= 0 ? videoLabel(list[index], index) : '';
      angleName.hidden = list.length >= 2;
      const video = list[index] ?? null;
      if (video?.id !== shownId || (video && el.dataset.videoId !== video.videoId)) mountPlayer(video);
    });
  }));
  // The device's video sound.
  offs.push(effect(() => {
    const volume = Number(prefs.get('video.volume')) || 0;
    untracked(() => player?.setVolume?.(volume));
  }));

  timer = timers.setInterval(tick, SYNC.intervalMs);
  tick();

  return {
    el,
    get player() { return player; },
    tick,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      timers.clearInterval(timer);
      for (const off of offs.splice(0)) { try { off(); } catch { /* best effort */ } }
      player?.destroy?.();
      el.remove();
    },
  };
}

