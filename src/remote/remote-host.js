// The phone remote's host side (2.1; convex/remote.ts). Started once by the signed-in app (main.js).
//
//   startRemoteHost({store, registry, api, prefs, platform, feedback, getSession, setTimer, clearTimer, now})
//     → stop()
//   hostIdOf(prefs) → string   this device's stable host id (created once, kept in prefs.remote.hostId)
//   deviceName(platform, nav) → 'Mac' | 'iPad' | 'iPhone' | 'Windows PC' | 'Android' | 'Linux PC' | 'Computer'
//   remoteState(session, {registry, t}) → the remoteStateValidator object: the HUD's own words
//   hostStatus   signal {hosting: bool, hostId, watchedAt: number|null}: the Phone remote dialog reads it
//
// While one of the account's songs is open on the Stage or in Edit (store.stage, not a shared song) and this
// device allows it (prefs.remote.allow), the device is a host: it announces {hostId, name, song} at once
// (`fresh`, dropping commands left from before) and again every HEARTBEAT_MS; it runs each command a remote
// sends once, through the registry with source 'remote' (only REMOTE_COMMANDS; a command that cannot run
// now is acked and dropped), and acks them; and while a remote is watching (the commands query's
// `watchedAt` within WATCH_MS) it publishes what the HUD shows, when that changes, at most every
// PUBLISH_MS. The first command from a remote in a session says so in the status line. When the song
// closes, the setting turns off or the app stops, the host closes.
import {HEARTBEAT_MS, STALE_MS, isRemoteCommand} from '../../shared/remote.ts';
import * as appApi from '../api/remote.js';
import {registry as appRegistry} from '../app/commands.js';
import * as appFeedback from '../app/feedback.js';
import {now as clockNow} from '../app/clock.js';
import {platform as appPlatform} from '../app/platform.js';
import {prefs as appPrefs} from '../app/prefs.js';
import {effect, readonly, signal, store as appStore} from '../app/store.js';

/** State is checked this often while watched; it is published only when it changed. */
export const PUBLISH_MS = 300;
/** A remote counts as watching while its last `watch` is this recent. */
export const WATCH_MS = STALE_MS;

export const COPY = Object.freeze({
  controlled: 'Your phone is controlling playback.',
});

const peek = (v) => (v && typeof v.peek === 'function' ? v.peek() : v);

const status = signal({hosting: false, hostId: null, watchedAt: null});
export const hostStatus = readonly(status);

export function hostIdOf(prefs = appPrefs) {
  const stored = prefs.get('remote.hostId');
  if (typeof stored === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) return stored;
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const id = Array.from(bytes, (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b & 63]).join('');
  prefs.set('remote.hostId', id);
  return id;
}

export function deviceName(p = appPlatform, nav = globalThis.navigator) {
  const ua = String(nav?.userAgent ?? '');
  if (p?.isIPad) return 'iPad';
  if (p?.isIOS) return 'iPhone';
  if (p?.isMac) return 'Mac';
  if (p?.isWindows) return 'Windows PC';
  if (/Android/i.test(ua)) return 'Android';
  if (/Linux/i.test(ua)) return 'Linux PC';
  return 'Computer';
}

const platformTag = (p) => (p?.isIPad ? 'ipad' : p?.isIOS ? 'iphone' : p?.isMac ? 'mac' : p?.isWindows ? 'windows' : 'other');

/** The HUD's readouts as the remote shows them. */
export function remoteState(session, {registry = appRegistry, t} = {}) {
  const snap = peek(session.transport?.snapshot) ?? {};
  const time = Number.isFinite(t) ? t : (session.engine?.getPosition?.() ?? snap.cue ?? 0);
  const position = session.position;
  const map = session.map;
  const rate = Number.isFinite(snap.rate) ? snap.rate : 1;
  let bpm;
  if (map?.isReal && typeof map.bpmAt === 'function' && typeof map.positionAt === 'function') {
    const felt = map.bpmAt(map.positionAt(Math.max(0, time)));
    if (Number.isFinite(felt) && felt > 0) bpm = Math.round(felt * rate);
  }
  const region = position?.regionAt?.(time);
  const section = region ? String(region.label ?? region.name ?? '') : '';
  const next = position?.next?.(time)?.text ?? '';
  const label = position?.label?.(time)?.main ?? '';
  const loop = snap.loop ?? {};
  const mine = snap.mix?.mine ?? [];
  const state = {
    phase: String(snap.phase ?? 'loading'),
    rate,
    loop: !!loop.on,
    countIn: !!snap.countIn?.on,
    click: snap.click?.mode === 'always',
    minusMe: !!snap.mix?.minusMe,
    trainer: !!snap.trainer && !snap.trainer.done,
    setlist: !!registry.state?.('setlist.next')?.enabled || !!registry.state?.('setlist.prev')?.enabled,
  };
  if (label) state.position = String(label);
  if (section) state.section = section;
  if (next) state.next = String(next);
  if (bpm !== undefined) state.bpm = bpm;
  if (loop.on && loop.label) state.loopLabel = String(loop.label);
  if (mine.length) state.mine = mine.join(' + ');
  return state;
}

export function startRemoteHost({store = appStore, registry = appRegistry, api = appApi, prefs = appPrefs, platform = appPlatform,
  feedback = appFeedback, getSession = async () => (await import('../stage/session.js')).activeSession?.(),
  setTimer = globalThis.setInterval.bind(globalThis), clearTimer = globalThis.clearInterval.bind(globalThis), now = clockNow} = {}) {
  const hostId = hostIdOf(prefs);
  const name = deviceName(platform);
  let current = null;   // {songId, session, heartbeat, poll, offCommands, watchedAt, lastJson, lastPublish, ran: Set, told}
  let stopped = false;

  const quiet = (promise) => Promise.resolve(promise).catch((err) => console.warn('[remote] host call failed', err));

  function announce(session, fresh = false) {
    const song = peek(session.song) ?? {};
    const args = {hostId, name, platform: platformTag(platform), title: song.title || 'Untitled', fresh};
    if (session.id && typeof session.id === 'string') args.songId = session.id;
    if (song.artist) args.artist = song.artist;
    return quiet(api.announce(args));
  }

  function publishIfChanged() {
    const c = current;
    if (!c || !c.watchedAt || now() - c.watchedAt > WATCH_MS) return;
    if (now() - c.lastPublish < PUBLISH_MS) return;
    let state;
    try { state = remoteState(c.session, {registry}); } catch (err) { console.warn('[remote] state failed', err); return; }
    const json = JSON.stringify(state);
    if (json === c.lastJson) return;
    c.lastJson = json;
    c.lastPublish = now();
    void quiet(api.publish({hostId, state}));
  }

  function onCommands(value) {
    const c = current;
    if (!c || !value) return;
    const watchedAt = Number.isFinite(value.watchedAt) ? value.watchedAt : null;
    if (watchedAt !== c.watchedAt) {
      c.watchedAt = watchedAt;
      c.lastJson = '';
      c.lastPublish = 0;
      status.value = {hosting: true, hostId, watchedAt};
      publishIfChanged();
    }
    const fresh = (value.commands ?? []).filter((cmd) => !c.ran.has(cmd.id));
    if (!fresh.length) return;
    for (const cmd of fresh) {
      c.ran.add(cmd.id);
      if (!isRemoteCommand(cmd.command)) continue;
      try { registry.run(cmd.command, {source: 'remote'}); } catch (err) { console.warn('[remote] command failed', cmd.command, err); }
    }
    if (!c.told) { c.told = true; feedback.status?.(COPY.controlled, {key: 'remote'}); }
    c.lastPublish = 0;
    publishIfChanged();
    void quiet(api.ack({hostId, ids: fresh.map((cmd) => cmd.id)}));
  }

  function leave() {
    const c = current;
    if (!c) return;
    current = null;
    status.value = {hosting: false, hostId, watchedAt: null};
    clearTimer(c.heartbeat);
    clearTimer(c.poll);
    try { c.offCommands?.(); } catch { /* already gone */ }
    void quiet(api.close({hostId}));
  }

  async function enter(songId) {
    const session = await getSession();
    if (stopped || !session || session.readOnly || peek(store.stage)?.songId !== songId || current?.songId === songId) return;
    leave();
    const c = {songId, session, watchedAt: null, lastJson: '', lastPublish: 0, ran: new Set(), told: false};
    current = c;
    await announce(session, true);
    if (current !== c) return;
    status.value = {hosting: true, hostId, watchedAt: null};
    c.heartbeat = setTimer(() => { if (current === c) void announce(session); }, HEARTBEAT_MS);
    c.poll = setTimer(() => { if (current === c) publishIfChanged(); }, PUBLISH_MS);
    c.offCommands = api.subscribeCommands({hostId}, onCommands, (err) => console.warn('[remote] commands failed', err));
  }

  const offEffect = effect(() => {
    const stage = store.stage.value;
    const allow = prefs.get('remote.allow') !== false;   // a signal read: the effect follows the setting
    const songId = stage?.songId ?? null;
    if (!songId || !allow) { leave(); return; }
    if (current?.songId === songId) return;
    void enter(songId);
  });

  const onHide = () => { if (globalThis.document?.visibilityState === 'hidden') publishIfChanged(); };
  globalThis.document?.addEventListener?.('visibilitychange', onHide);
  const onUnload = () => leave();
  globalThis.addEventListener?.('pagehide', onUnload);

  return function stop() {
    stopped = true;
    offEffect();
    globalThis.document?.removeEventListener?.('visibilitychange', onHide);
    globalThis.removeEventListener?.('pagehide', onUnload);
    leave();
  };
}

