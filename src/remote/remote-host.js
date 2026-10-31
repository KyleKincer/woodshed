// The phone remote's host side (2.1; convex/remote.ts). Started once by the signed-in app (main.js).
//
//   startRemoteHost({store, registry, api, prefs, platform, feedback, getSession, setTimer, clearTimer, now, locks})
//     → stop()
//   hostIdOf(prefs) → string   this device's stable host id (created once, kept in prefs.remote.hostId)
//   deviceName(platform, nav) → 'Mac' | 'iPad' | 'iPhone' | 'Windows PC' | 'Android' | 'Linux PC' | 'Computer'
//   remoteState(session, {registry, t}) → the remoteStateValidator object: the HUD's own words
//   hostStatus   signal {hosting: bool, hostId, watchedAt: number|null, elsewhere?: true}: the Phone remote
//                dialog reads it (`elsewhere`: another tab of this browser hosts, and this one waits)
//   learnServerTime({now}, localNow) / serverTime(localNow) / knowsServerTime()   the server's clock (below)
//
// While one of the account's songs is open on the Stage or in Edit (store.stage, not a shared song) and this
// device allows it (prefs.remote.allow), the device is a host: it announces {hostId, name, song} at once
// (`fresh`, dropping commands left from before) and again every HEARTBEAT_MS; it runs each command a remote
// sends once, through the registry with source 'remote' (only REMOTE_COMMANDS; a command that cannot run
// now, or was sent more than COMMAND_TTL_MS ago, is acked and dropped), and acks them; and while a remote is
// watching (the commands query's `watchedAt` within WATCH_MS) it publishes what the HUD shows, when that
// changes, at most every PUBLISH_MS. The first command from a remote in a session says so in the status line.
// The next song updates the host in place: the host closes only when no song follows within LINGER_MS, and at
// once when the setting turns off, the page hides or the app stops (a page restored from the back/forward
// cache hosts again).
//
// The tabs of one browser share the host id, so only one of them hosts: a tab with a song open asks for a Web
// Lock named after the host id, and hosts while it holds it. When it stops hosting it lets go (after its
// close lands), and a waiting tab with a song open takes over. Without Web Locks every tab hosts.
import {COMMAND_TTL_MS, HEARTBEAT_MS, STALE_MS, isRemoteCommand} from '../../shared/remote.ts';
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
/** A song that closes keeps the host this long, so the next song (a setlist's Next) updates it in place. */
export const LINGER_MS = 5_000;

export const COPY = Object.freeze({
  controlled: 'Your phone is controlling playback.',
});

const peek = (v) => (v && typeof v.peek === 'function' ? v.peek() : v);

const status = signal({hosting: false, hostId: null, watchedAt: null});
export const hostStatus = readonly(status);

// The server's clock minus this device's. `announce` (here) and `watch` (the /remote page, the Library bar)
// return the server's time, and every freshness check (a host's `seenAt`, a remote's `watchedAt`, a command's
// `sentAt`) is made by it, so a device whose own clock is off still finds, publishes to and runs the others.
const clock = {skew: 0, known: false};
/** Learns the server's clock from a mutation's `{now}`, read at `localNow` by this device's clock. */
export function learnServerTime(result, localNow) {
  if (!Number.isFinite(result?.now) || !Number.isFinite(localNow)) return false;
  clock.skew = result.now - localNow;
  clock.known = true;
  return true;
}
/** The server's clock now, as this device estimates it (its own until it learned better). */
export const serverTime = (localNow) => localNow + clock.skew;
/** Whether a server time has been learned yet (a remote that follows no host asks `watch` for one). */
export const knowsServerTime = () => clock.known;
/** Forgets the server's clock (tests). */
export function resetServerTime() { clock.skew = 0; clock.known = false; }

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
  setTimer = globalThis.setInterval.bind(globalThis), clearTimer = globalThis.clearInterval.bind(globalThis), now = clockNow,
  locks = globalThis.navigator?.locks} = {}) {
  const hostId = hostIdOf(prefs);
  const name = deviceName(platform);
  let current = null;     // {songId, session, heartbeat, poll, offCommands, watchedAt, lastJson, lastPublish, ran: Set, told}
  let announced = false;  // the host row is this tab's: announced and not closed yet
  let lingering = null;   // the timer that closes the host when no song followed the last one
  let lock = null;        // the Web Lock this tab hosts under: {abort, release, granted: Promise<boolean>}
  let stopped = false;

  const quiet = (promise) => Promise.resolve(promise).catch((err) => console.warn('[remote] host call failed', err));
  const serverNow = () => serverTime(now());

  function announce(session, fresh = false) {
    const song = peek(session.song) ?? {};
    const args = {hostId, name, platform: platformTag(platform), title: song.title || 'Untitled', fresh};
    if (session.id && typeof session.id === 'string') args.songId = session.id;
    if (song.artist) args.artist = song.artist;
    return quiet(api.announce(args)).then((result) => { learnServerTime(result, now()); });
  }

  /** Resolves true once this tab holds the host lock (at once without Web Locks), false when it gave up first.
   *  While another tab holds it, hostStatus says so (`elsewhere`). */
  function hold() {
    if (typeof locks?.request !== 'function') return Promise.resolve(true);
    if (!lock) {
      const l = {abort: new AbortController(), release: null, granted: null};
      const name = `woodshed-remote-host:${hostId}`;
      l.granted = new Promise((resolve) => {
        const take = () => {
          resolve(true);
          return new Promise((release) => { l.release = release; });
        };
        // Taken at once when free; otherwise the tab says another one hosts, and queues for the lock.
        const wait = () => {
          if (l.abort.signal.aborted) { resolve(false); return null; }
          status.value = {hosting: false, hostId, watchedAt: null, elsewhere: true};
          return locks.request(name, {signal: l.abort.signal}, take);
        };
        Promise.resolve(locks.request(name, {ifAvailable: true}, (got) => (got ? take() : wait())))
          .catch((err) => resolve(err?.name !== 'AbortError'));   // dropped while waiting; any other failure: as without
      });
      lock = l;
    }
    return lock.granted;
  }

  function publishIfChanged() {
    const c = current;
    if (!c || !c.watchedAt || serverNow() - c.watchedAt > WATCH_MS) return;
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
    let ran = false;
    for (const cmd of fresh) {
      c.ran.add(cmd.id);
      // Sent while this device slept or was offline: running it now would surprise whoever tapped it long ago.
      if (!isRemoteCommand(cmd.command) || serverNow() - cmd.sentAt > COMMAND_TTL_MS) continue;
      ran = true;
      try { registry.run(cmd.command, {source: 'remote'}); } catch (err) { console.warn('[remote] command failed', cmd.command, err); }
    }
    if (ran && !c.told) { c.told = true; feedback.status?.(COPY.controlled, {key: 'remote'}); }
    c.lastPublish = 0;
    publishIfChanged();
    void quiet(api.ack({hostId, ids: fresh.map((cmd) => cmd.id)}));
  }

  /** Stops hosting this song here; the host row stays (for the next song, or until leave()). */
  function drop() {
    const c = current;
    if (!c) return;
    current = null;
    status.value = {hosting: false, hostId, watchedAt: null};
    clearTimer(c.heartbeat);
    clearTimer(c.poll);
    try { c.offCommands?.(); } catch { /* already gone */ }
  }

  /** Stops hosting and closes the host row, then lets go of the lock (a request still waiting is dropped). */
  function leave() {
    drop();
    if (status.peek().elsewhere) status.value = {hosting: false, hostId, watchedAt: null};
    clearTimer(lingering);
    lingering = null;
    const l = lock;
    lock = null;
    l?.abort.abort();
    if (!announced) { l?.release?.(); return; }
    announced = false;
    // The lock goes once the close has landed, so the tab that takes over never has its own announce closed.
    void quiet(api.close({hostId})).finally(() => l?.release?.());
  }

  /** The song closed: keep the host LINGER_MS for the next one (a tab that never announced lets go at once). */
  function linger() {
    drop();
    if (!announced) { leave(); return; }
    lingering ??= setTimer(leave, LINGER_MS);
  }

  const hostable = (session, songId) => !stopped && !!session && !session.readOnly && peek(store.stage)?.songId === songId
    && current?.songId !== songId;

  async function enter(songId) {
    const session = await getSession();
    if (!hostable(session, songId)) return;
    if (!(await hold()) || !hostable(session, songId)) return;   // another tab hosts until it lets go
    clearTimer(lingering);
    lingering = null;
    drop();
    const c = {songId, session, watchedAt: null, lastJson: '', lastPublish: 0, ran: new Set(), told: false};
    current = c;
    announced = true;   // a fresh announce patches the row this tab already has, keeping `watchedAt`
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
    if (!allow) { leave(); return; }
    if (!songId) { linger(); return; }
    if (current?.songId === songId) return;
    void enter(songId);
  });

  const onHide = () => { if (globalThis.document?.visibilityState === 'hidden') publishIfChanged(); };
  globalThis.document?.addEventListener?.('visibilitychange', onHide);
  const onUnload = () => leave();
  globalThis.addEventListener?.('pagehide', onUnload);
  // Back from the back/forward cache: the Stage is still open, but pagehide closed the host.
  const onShow = (event) => {
    const songId = peek(store.stage)?.songId;
    if (event?.persisted && !stopped && songId && prefs.get('remote.allow') !== false) void enter(songId);
  };
  globalThis.addEventListener?.('pageshow', onShow);

  return function stop() {
    stopped = true;
    offEffect();
    globalThis.document?.removeEventListener?.('visibilitychange', onHide);
    globalThis.removeEventListener?.('pagehide', onUnload);
    globalThis.removeEventListener?.('pageshow', onShow);
    leave();
  };
}

