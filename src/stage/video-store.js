// The song's playthrough videos as the Stage edits them (shared/video.ts): the panel (video-panel.js) and the
// Playthrough video sheet (sheets/video.js) read and change one list. An edit shows at once (a nudge moves the
// video while it plays) and is saved after SAVE_MS without another edit (songs.setVideos replaces the list).
//
//   createVideoStore({session, save, device?, now?}) → {
//     videos      ReadonlySignal<Video[]>   the song's, with unsaved edits applied
//     angle       ReadonlySignal<string|null>   the video shown on this device (remembered per song)
//     current()   the shown Video, or null
//     add({videoId, label?, offset?}) → Video · update(id, patch) · remove(id) · setAngle(id) · flush() · destroy()
//     readOnly    a shared song's list can't be changed (every method is a no-op)
//     saving      ReadonlySignal<'idle'|'saving'|'error'>
//   }

import {computed, effect, readonly, signal} from '../app/store.js';
import {deviceStore} from '../app/prefs.js';
import {MAX_VIDEOS, OFFSET_MAX, validVideos} from '../../shared/video.ts';

export const SAVE_MS = 600;
const ANGLES = 'videoAngle';

const peek = (v) => (v && typeof v.peek === 'function' ? v.peek() : v);
const clamp = (x) => Math.max(-OFFSET_MAX, Math.min(OFFSET_MAX, Math.round(x * 1000) / 1000));

export function createVideoStore({session, save, device = deviceStore(ANGLES)} = {}) {
  const songId = session?.id;
  const readOnly = !!session?.readOnly;
  const songVideos = computed(() => {
    const list = session?.song?.value?.videos;
    return Array.isArray(list) ? list : [];
  });
  const pending = signal(null);          // the edited list, until the song shows it saved
  const saving = signal('idle');
  const videos = computed(() => pending.value ?? songVideos.value);
  const remembered = signal(songId ? device.get(songId) : null);
  const angle = computed(() => {
    const list = videos.value;
    return list.find((v) => v.id === remembered.value)?.id ?? list[0]?.id ?? null;
  });
  let timer = null, seq = 0;

  // The song caught up with what was saved: the pending copy is no longer needed.
  const offSong = effect(() => {
    const own = songVideos.value, mine = pending.peek();
    if (mine && saving.peek() === 'idle' && JSON.stringify(own) === JSON.stringify(mine)) pending.value = null;
  });

  async function flush() {
    clearTimeout(timer);
    timer = null;
    const list = pending.peek();
    if (!list || readOnly || !songId) return;
    const mine = ++seq;
    saving.value = 'saving';
    try {
      await save({id: songId, videos: list});
      if (mine === seq) saving.value = 'idle';
      if (mine === seq && JSON.stringify(songVideos.peek()) === JSON.stringify(list)) pending.value = null;
    } catch (error) {
      if (mine === seq) saving.value = 'error';
      console.error('[video] saving the videos failed', error);
    }
  }

  function edit(fn) {
    if (readOnly) return false;
    const next = fn(structuredClone(peek(videos)));
    if (!next || !validVideos(next)) return false;
    pending.value = next;
    clearTimeout(timer);
    timer = setTimeout(() => { void flush(); }, SAVE_MS);
    return true;
  }

  const newId = (list) => {
    for (let i = 1; ; i++) if (!list.some((v) => v.id === `v${i}`)) return `v${i}`;
  };

  return {
    videos: readonly(videos),
    angle: readonly(angle),
    saving: readonly(saving),
    readOnly,
    current: () => peek(videos).find((v) => v.id === peek(angle)) ?? null,
    add({videoId, label = '', offset = 0}) {
      let added = null;
      edit((list) => {
        if (list.length >= MAX_VIDEOS) return null;
        added = {id: newId(list), videoId, label: String(label).trim().slice(0, 80), offset: clamp(offset)};
        return [...list, added];
      });
      if (added) this.setAngle(added.id);
      return added;
    },
    update(id, patch) {
      return edit((list) => list.map((v) => (v.id !== id ? v : {
        ...v,
        ...(patch.label !== undefined ? {label: String(patch.label).slice(0, 80)} : {}),
        ...(Number.isFinite(patch.offset) ? {offset: clamp(patch.offset)} : {}),
      })));
    },
    remove(id) { return edit((list) => list.filter((v) => v.id !== id)); },
    setAngle(id) {
      remembered.value = id;
      if (songId) device.set(songId, id);
    },
    flush,
    destroy() {
      offSong();
      if (timer) void flush();
    },
  };
}
