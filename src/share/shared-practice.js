// Device-local practice for a share token (architecture §2.18, §2.14.5; spec §4.13).
//
// A Shared Stage session is read-only on the server: its practice state (practice-state.js,
// `local: {token}`) persists to this device only, as deviceStore('share').set(token, practice)
// (ws.share.<token>), and reads that copy back on open. This module owns the rest of that story:
//
//   sharedPractice(token, {store}) → {read(), has(), clear(), noticeShown(), markNotice()}
//     read()          the device copy (a practice blob, any version) or null
//     clear()         drops the copy and the notice flag (after migrating into a saved song)
//     noticeShown()   whether the one-time notice was shown for this token on this device
//   watchLocalNotice({session, token, status, store}) → off
//     The first change the viewer makes to their practice (loop, speed, mix, spots, markers, click,
//     trainer…, not the play position) says once per token and device, in the Stage status line:
//     "Changes stay on this device until you add the song to your library."
//   migrateSharedPractice({token, songId, duration, songs, store}) → Promise<boolean>
//     After shareAudio.save: the device copy, through the one-way upgrade, becomes the new song's
//     practice (songs.savePractice, final) and is then cleared. False (nothing written) when this
//     device has no copy: the saved song keeps the practice the sharer shared.

import * as appSongs from '../api/songs.js';
import {deviceStore} from '../app/prefs.js';
import {upgradePractice} from '../../shared/practice.ts';
import {COPY} from './share.copy.js';

/** practice-state.js's namespace for a viewer's device copy (ws.share.<token>). */
export const PRACTICE_NAMESPACE = 'share';
/** The one-time notice's flag (ws.shareNotice.<token>). */
export const NOTICE_NAMESPACE = 'shareNotice';
/** How long the notice stays in the status line. */
export const NOTICE_MS = 6000;

/** Practice keys a viewer changes on purpose; lastAt, the anchor and the surface follow playback and views. */
export const NOTICE_KEYS = Object.freeze(['loop', 'rate', 'keepPitch', 'tracks', 'minusMe', 'onlyMe', 'chartAudio', 'click',
  'trainer', 'spots', 'markers', 'cue']);

const stores = (store) => ({
  practice: store?.practice ?? deviceStore(PRACTICE_NAMESPACE),
  notice: store?.notice ?? deviceStore(NOTICE_NAMESPACE),
});

/** The device copy and notice flag for one token. */
export function sharedPractice(token, {store} = {}) {
  const s = stores(store);
  const key = String(token ?? '');
  const read = () => {
    if (!key) return null;
    const value = s.practice.get(key);
    return value && typeof value === 'object' ? value : null;
  };
  return {
    read,
    has: () => read() !== null,
    clear() {
      if (!key) return;
      s.practice.remove(key);
      s.notice.remove(key);
    },
    noticeShown() { return !!key && s.notice.get(key) === true; },
    markNotice() { if (key) s.notice.set(key, true); },
  };
}

const fingerprint = (p) => JSON.stringify(NOTICE_KEYS.map((key) => p?.[key] ?? null));

/** Shows the one-time "Changes stay on this device…" line on the viewer's first change. Returns off(). */
export function watchLocalNotice({session, token, status, store} = {}) {
  const local = sharedPractice(token, {store});
  const value = session?.practice?.value;
  if (!value || typeof value.subscribe !== 'function' || local.noticeShown()) return () => {};
  let base = fingerprint(value.peek());
  let off = null;
  off = value.subscribe((next) => {
    const now = fingerprint(next);
    if (now === base) return;
    base = now;
    if (local.noticeShown()) { off?.(); return; }
    local.markNotice();
    status?.(COPY.localNotice, {key: 'share-local', durationMs: NOTICE_MS});
    off?.();
  });
  return () => off?.();
}

/** Moves this device's practice for `token` into the saved song `songId`. See the header. */
export async function migrateSharedPractice({token, songId, duration, songs = appSongs, store} = {}) {
  const local = sharedPractice(token, {store});
  const raw = local.read();
  if (!raw || !songId) return false;
  const span = Number.isFinite(duration) && duration > 0 ? duration : undefined;
  await songs.savePractice({id: songId, practice: upgradePractice(raw, {duration: span}), final: true});
  local.clear();
  return true;
}
