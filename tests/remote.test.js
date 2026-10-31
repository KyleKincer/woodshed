// @vitest-environment happy-dom
// The phone remote's client side (src/remote): the host (announce, heartbeat, commands through the registry,
// publishing only while watched, leaving), the /remote page (which device, the readouts, the buttons, nothing
// open), the Library bar, and the Phone remote dialog's QR code.
import {afterEach, describe, expect, test, vi} from 'vitest';
import qrcode from 'qrcode-generator';
import {COMMAND_TTL_MS, HEARTBEAT_MS, STALE_MS} from '../shared/remote.ts';
import {signal} from '../src/app/store.js';
import {COPY as HOST_COPY, LINGER_MS, WATCH_MS, deviceName, hostIdOf, hostStatus, learnServerTime, remoteState, resetServerTime,
  startRemoteHost} from '../src/remote/remote-host.js';
import {COPY as PAGE_COPY, liveHosts, mount, pickHost} from '../src/remote/remote-page.js';
import {COPY as BAR_COPY, mountRemoteBar} from '../src/remote/remote-bar.js';
import {COPY as SHEET_COPY, RECHECK_MS, openRemoteSheet, qrSvg, remoteUrl} from '../src/remote/remote-sheet.js';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); resetServerTime(); });

/** prefs whose get() reads a signal, as the app's does (effects follow it). */
function reactivePrefs(data = {}) {
  const sig = signal(structuredClone(data));
  return {
    sig,
    get(path) { return path.split('.').reduce((o, k) => o?.[k], sig.value); },
    set(path, value) {
      const next = structuredClone(sig.peek());
      const keys = path.split('.');
      let o = next;
      for (const k of keys.slice(0, -1)) o = o[k] ??= {};
      o[keys.at(-1)] = value;
      sig.value = next;
    },
  };
}

/** Manual timers: run(ms) fires every interval that would have fired. */
function timers() {
  const list = new Map();
  let seq = 0;
  return {
    setTimer: (fn, ms) => { list.set(++seq, {fn, ms}); return seq; },
    clearTimer: id => { list.delete(id); },
    tick(ms) { for (const {fn, ms: every} of [...list.values()]) if (ms % every === 0 || ms >= every) fn(); },
    get count() { return list.size; },
  };
}

/** A Web Locks stand-in shared by the tabs of one browser: one holder per name, the others wait in turn. */
function fakeLocks() {
  const held = new Set(), waiting = [];
  function grant() {
    for (const w of [...waiting]) {
      if (held.has(w.name)) continue;
      waiting.splice(waiting.indexOf(w), 1);
      held.add(w.name);
      Promise.resolve(w.fn({name: w.name})).then(w.resolve, w.reject).finally(() => { held.delete(w.name); grant(); });
    }
  }
  return {
    request: (name, {signal: abort, ifAvailable = false} = {}, fn) => new Promise((resolve, reject) => {
      const w = {name, fn, resolve, reject};
      // ifAvailable: granted only when nothing holds or waits for the name; otherwise fn(null) at once.
      if (ifAvailable && (held.has(name) || waiting.some(o => o.name === name))) {
        Promise.resolve().then(() => fn(null)).then(resolve, reject);
        return;
      }
      abort?.addEventListener('abort', () => {
        if (!waiting.includes(w)) return;
        waiting.splice(waiting.indexOf(w), 1);
        reject(new DOMException('Aborted', 'AbortError'));
      });
      waiting.push(w);
      void Promise.resolve().then(grant);
    }),
  };
}

function fakeApi(serverNow = () => 0) {
  const calls = [];
  let onCommands = null;
  return {
    calls,
    push(value) { onCommands?.(value); },
    announce: vi.fn(async a => { calls.push(['announce', a]); return {now: serverNow()}; }),
    close: vi.fn(async a => { calls.push(['close', a]); return null; }),
    publish: vi.fn(async a => { calls.push(['publish', a]); return null; }),
    ack: vi.fn(async a => { calls.push(['ack', a]); return null; }),
    subscribeCommands: vi.fn((args, fn) => { onCommands = fn; return () => { onCommands = null; }; }),
  };
}

function fakeSession({readOnly = false} = {}) {
  const snapshot = signal({phase: 'playing', rate: 0.75, loop: {on: true, label: 'Chorus'}, countIn: {on: true}, click: {mode: 'always'},
    mix: {minusMe: true, mine: ['drums']}, trainer: null});
  return {
    id: 'song1', readOnly,
    song: signal({title: 'Glasshouse', artist: 'Northbound'}),
    transport: {snapshot},
    engine: {getPosition: () => 42},
    map: {isReal: true, bpmAt: () => 120, positionAt: t => t},
    position: {regionAt: () => ({label: 'Chorus'}), next: () => ({text: 'next: Bridge · 4 bars'}), label: () => ({main: '23 · 3'})},
  };
}

/** One tab hosting. `skew`: the server's clock minus this device's. `locks`: the browser's Web Locks (none: as without). */
function hostBed({allow = true, readOnly = false, skew = 0, locks = null} = {}) {
  const store = {stage: signal(null)};
  const registry = {run: vi.fn(() => true), state: () => ({enabled: false})};
  let clock = 1_000_000;
  const api = fakeApi(() => clock + skew);
  const prefs = reactivePrefs({remote: {allow, hostId: 'this-device-1', last: null}});
  const t = timers();
  const feedback = {status: vi.fn()};
  const session = fakeSession({readOnly});
  const stop = startRemoteHost({store, registry, api, prefs, feedback, platform: {isMac: true},
    getSession: async () => session, setTimer: t.setTimer, clearTimer: t.clearTimer, now: () => clock, locks});
  return {store, registry, api, prefs, t, feedback, session, stop, advance: ms => { clock += ms; }, now: () => clock};
}
const flush = () => new Promise(r => setTimeout(r, 0));

describe('the host', () => {
  test('a song opening announces this device (fresh), heartbeats, and closing the song leaves', async () => {
    const b = hostBed();
    expect(b.api.announce).not.toHaveBeenCalled();
    b.store.stage.value = {songId: 'song1'};
    await flush();
    expect(b.api.announce).toHaveBeenCalledWith({hostId: 'this-device-1', name: 'Mac', platform: 'mac', title: 'Glasshouse',
      artist: 'Northbound', songId: 'song1', fresh: true});
    expect(b.api.subscribeCommands).toHaveBeenCalledWith({hostId: 'this-device-1'}, expect.any(Function), expect.any(Function));
    b.t.tick(HEARTBEAT_MS);
    expect(b.api.announce).toHaveBeenLastCalledWith(expect.objectContaining({fresh: false}));
    b.store.stage.value = {songId: 'song1', playing: true};   // the same song: no new announce
    await flush();
    expect(b.api.announce.mock.calls.filter(([a]) => a.fresh)).toHaveLength(1);
    b.store.stage.value = null;
    expect(b.api.close).not.toHaveBeenCalled();   // a next song may follow
    b.t.tick(LINGER_MS);
    expect(b.api.close).toHaveBeenCalledWith({hostId: 'this-device-1'});
    expect(b.t.count).toBe(0);
    b.stop();
  });

  test('the next song updates the host in place: no close between songs, so a remote keeps following it', async () => {
    const b = hostBed();
    b.store.stage.value = {songId: 'song1'};
    await flush();
    b.store.stage.value = null;                    // the Stage unmounts for the setlist's next song
    b.session.id = 'song2';
    b.session.song.value = {title: 'Low Tide'};
    b.store.stage.value = {songId: 'song2'};
    await flush();
    b.t.tick(LINGER_MS);
    expect(b.api.close).not.toHaveBeenCalled();
    expect(b.api.announce).toHaveBeenLastCalledWith(expect.objectContaining({songId: 'song2', title: 'Low Tide', fresh: true}));
    b.api.push({watchedAt: b.now(), commands: []});   // the row kept watchedAt: publishing goes on at once
    expect(b.api.publish).toHaveBeenCalledTimes(1);
    b.stop();
  });

  test('two tabs of one browser share the host id, so one hosts (a Web Lock) and the other takes over after it', async () => {
    const locks = fakeLocks();
    const a = hostBed({locks}), b = hostBed({locks});
    a.store.stage.value = {songId: 'song1'};
    await flush();
    b.store.stage.value = {songId: 'song1'};
    await flush();
    expect(a.api.announce).toHaveBeenCalledTimes(1);
    expect(b.api.announce).not.toHaveBeenCalled();
    expect(b.api.subscribeCommands).not.toHaveBeenCalled();   // so a phone's Play runs in one tab only
    a.store.stage.value = null;
    a.t.tick(LINGER_MS);
    await flush();
    expect(a.api.close).toHaveBeenCalledWith({hostId: 'this-device-1'});
    expect(b.api.announce).toHaveBeenCalledWith(expect.objectContaining({fresh: true}));
    expect(b.api.subscribeCommands).toHaveBeenCalledTimes(1);
    a.store.stage.value = {songId: 'song1'};     // tab A opens a song again: it waits for B
    await flush();
    expect(a.api.announce).toHaveBeenCalledTimes(1);
    a.stop();
    b.stop();
    const refused = hostBed({locks: {request: async () => { throw new DOMException('No locks here', 'SecurityError'); }}});
    refused.store.stage.value = {songId: 'song1'};   // Web Locks that fail: it hosts, as without them
    await flush();
    expect(refused.api.announce).toHaveBeenCalledTimes(1);
    refused.stop();
  });

  test('a tab that waits while another one hosts says so, and hosts once that tab lets go', async () => {
    const locks = fakeLocks();
    let release;
    void locks.request('woodshed-remote-host:this-device-1', {}, () => new Promise(r => { release = r; }));   // the other tab
    await flush();
    const b = hostBed({locks});
    b.store.stage.value = {songId: 'song1'};
    await flush();
    expect(hostStatus.peek()).toEqual({hosting: false, hostId: 'this-device-1', watchedAt: null, elsewhere: true});
    expect(b.api.announce).not.toHaveBeenCalled();
    release();
    await flush();
    await flush();
    expect(b.api.announce).toHaveBeenCalledTimes(1);
    expect(hostStatus.peek()).toEqual({hosting: true, hostId: 'this-device-1', watchedAt: null});
    b.stop();
    const c = hostBed({locks});                           // waiting, then the song closes: the line goes too
    void locks.request('woodshed-remote-host:this-device-1', {}, () => new Promise(r => { release = r; }));
    await flush();
    c.store.stage.value = {songId: 'song1'};
    await flush();
    expect(hostStatus.peek().elsewhere).toBe(true);
    c.store.stage.value = null;
    await flush();
    expect(hostStatus.peek()).toEqual({hosting: false, hostId: 'this-device-1', watchedAt: null});
    c.stop();
    release();
  });

  test('a page restored from the back/forward cache hosts again', async () => {
    const b = hostBed();
    b.store.stage.value = {songId: 'song1'};
    await flush();
    globalThis.dispatchEvent(Object.assign(new Event('pagehide'), {persisted: true}));
    expect(b.api.close).toHaveBeenCalledTimes(1);
    globalThis.dispatchEvent(Object.assign(new Event('pageshow'), {persisted: true}));
    await flush();
    expect(b.api.announce.mock.calls.filter(([a]) => a.fresh)).toHaveLength(2);
    expect(b.api.subscribeCommands).toHaveBeenCalledTimes(2);
    b.stop();
  });

  test('turning remote control off leaves at once; a shared (read-only) song never hosts', async () => {
    const b = hostBed();
    b.store.stage.value = {songId: 'song1'};
    await flush();
    b.prefs.set('remote.allow', false);
    expect(b.api.close).toHaveBeenCalled();
    b.stop();
    const shared = hostBed({readOnly: true});
    shared.store.stage.value = {songId: 'song1'};
    await flush();
    expect(shared.api.announce).not.toHaveBeenCalled();
    shared.stop();
  });

  test('commands run once each through the registry, then are acked; the first one says so', async () => {
    const b = hostBed();
    b.store.stage.value = {songId: 'song1'};
    await flush();
    const commands = [{id: 'c1', command: 'transport.playStop', sentAt: b.now() - 200}, {id: 'c2', command: 'library.deleteSongs', sentAt: b.now() - 100}];
    b.api.push({watchedAt: null, commands});
    b.api.push({watchedAt: null, commands});   // the same rows again before the ack lands: not run twice
    expect(b.registry.run).toHaveBeenCalledTimes(1);
    expect(b.registry.run).toHaveBeenCalledWith('transport.playStop', {source: 'remote'});
    expect(b.api.ack).toHaveBeenCalledWith({hostId: 'this-device-1', ids: ['c1', 'c2']});
    expect(b.feedback.status).toHaveBeenCalledWith(HOST_COPY.controlled, {key: 'remote'});
    b.stop();
  });

  test(`a command sent more than ${COMMAND_TTL_MS / 1000} s ago by the server's clock (this device slept) is acked, not run`, async () => {
    const b = hostBed({skew: 120_000});            // this device's clock is two minutes slow
    b.store.stage.value = {songId: 'song1'};
    await flush();
    const server = b.now() + 120_000;
    b.api.push({watchedAt: null, commands: [{id: 'old', command: 'transport.playStop', sentAt: server - COMMAND_TTL_MS - 1000},
      {id: 'new', command: 'speed.up', sentAt: server - 1000}]});
    expect(b.registry.run.mock.calls).toEqual([['speed.up', {source: 'remote'}]]);
    expect(b.api.ack).toHaveBeenCalledWith({hostId: 'this-device-1', ids: ['old', 'new']});
    b.stop();
  });

  test('a remote watching counts by the server\'s clock, so a host whose own clock is fast still publishes', async () => {
    const b = hostBed({skew: -120_000});           // this device's clock is two minutes fast
    b.store.stage.value = {songId: 'song1'};
    await flush();
    b.api.push({watchedAt: b.now() - 120_000, commands: []});
    expect(b.api.publish).toHaveBeenCalledTimes(1);
    b.stop();
  });

  test('publishes the HUD only while a remote watches, and only when it changed', async () => {
    const b = hostBed();
    b.store.stage.value = {songId: 'song1'};
    await flush();
    b.t.tick(300);
    expect(b.api.publish).not.toHaveBeenCalled();
    b.api.push({watchedAt: b.now(), commands: []});
    expect(b.api.publish).toHaveBeenCalledTimes(1);
    expect(b.api.publish.mock.calls[0][0].state).toMatchObject({phase: 'playing', section: 'Chorus', position: '23 · 3', rate: 0.75, bpm: 90,
      loop: true, loopLabel: 'Chorus', countIn: true, click: true, minusMe: true, mine: 'drums'});
    b.advance(400);
    b.t.tick(300);
    expect(b.api.publish).toHaveBeenCalledTimes(1);   // nothing changed
    b.session.transport.snapshot.value = {...b.session.transport.snapshot.peek(), phase: 'stopped'};
    b.t.tick(300);
    expect(b.api.publish).toHaveBeenCalledTimes(2);
    b.advance(STALE_MS + 1000);                        // the remote went away
    b.session.transport.snapshot.value = {...b.session.transport.snapshot.peek(), rate: 1};
    b.t.tick(300);
    expect(b.api.publish).toHaveBeenCalledTimes(2);
    b.stop();
  });

  test('the device keeps one host id; the device name comes from the platform', () => {
    const prefs = reactivePrefs({remote: {hostId: null}});
    const id = hostIdOf(prefs);
    expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(hostIdOf(prefs)).toBe(id);
    expect(deviceName({isIPad: true, isIOS: true})).toBe('iPad');
    expect(deviceName({isIOS: true})).toBe('iPhone');
    expect(deviceName({isWindows: true})).toBe('Windows PC');
    expect(deviceName({}, {userAgent: 'Mozilla/5.0 (Linux; Android 14)'})).toBe('Android');
  });

  test('remoteState leaves out what an unmapped, stopped song does not have', () => {
    const session = fakeSession();
    session.map = {isReal: false};
    session.position = {regionAt: () => null, next: () => null, label: () => ({main: '1:12'})};
    session.transport.snapshot.value = {phase: 'stopped', rate: 1, loop: {on: false}, countIn: {on: false}, click: {mode: 'off'}, mix: {minusMe: false, mine: []}};
    expect(remoteState(session, {registry: {state: () => null}})).toEqual({phase: 'stopped', rate: 1, loop: false, countIn: false,
      click: false, minusMe: false, trainer: false, setlist: false, position: '1:12'});
  });
});

describe('choosing a host', () => {
  const rows = [{hostId: 'a', seenAt: 1000}, {hostId: 'b', seenAt: 5000}, {hostId: 'me', seenAt: 6000}, {hostId: 'old', seenAt: 5000 - STALE_MS - 1}];
  test('fresh hosts only, never this device, newest first', () => {
    expect(liveHosts(rows, {now: 5000, self: 'me'}).map(h => h.hostId)).toEqual(['b', 'a']);
  });
  test('the asked one, else the last one used here, else the newest', () => {
    const hosts = liveHosts(rows, {now: 5000, self: 'me'});
    expect(pickHost(hosts, {asked: 'a', last: 'b'}).hostId).toBe('a');
    expect(pickHost(hosts, {asked: 'gone', last: 'a'}).hostId).toBe('a');
    expect(pickHost(hosts, {}).hostId).toBe('b');
    expect(pickHost([], {})).toBeNull();
  });
  test('with nothing asked or remembered, the one followed now stays (not whichever heartbeat came last)', () => {
    const hosts = liveHosts(rows, {now: 5000, self: 'me'});
    expect(pickHost(hosts, {current: 'a'}).hostId).toBe('a');
    expect(pickHost(hosts, {last: 'b', current: 'a'}).hostId).toBe('b');
    expect(pickHost(hosts, {current: 'gone'}).hostId).toBe('b');
  });
});

describe('the /remote page', () => {
  function pageApi(hosts) {
    let onHosts = null, onView = null;
    return {
      sent: [],
      emitHosts(v) { onHosts?.(v); },
      emitView(v) { onView?.(v); },
      subscribeHosts: vi.fn((fn) => { onHosts = fn; return () => {}; }),
      subscribeView: vi.fn((args, fn) => { onView = fn; return () => {}; }),
      watch: vi.fn(async () => null),
      send: vi.fn(async function ({command}) { this.sent.push(command); return {queued: true}; }),
      hosts,
    };
  }
  const byName = name => [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === name || b.textContent.trim().startsWith(name));

  test('nothing open elsewhere says how to get there; a host appearing shows it at once', async () => {
    const api = pageApi();
    const el = document.body.appendChild(document.createElement('div'));
    const view = await mount(el, {query: {}}, {api, prefs: reactivePrefs({remote: {hostId: 'phone-self-1'}}), now: () => 10_000,
      setTimer: () => 1, clearTimer: () => {}, haptic: () => {}, wakeLock: {request: async () => null}});
    expect(el.querySelector('.remote').dataset.state).toBe('loading');
    api.emitHosts([]);
    expect(el.textContent).toContain(PAGE_COPY.noneTitle);
    api.emitHosts([{hostId: 'mac-1', name: 'MacBook', title: 'Glasshouse', artist: 'Northbound', seenAt: 9_000}]);
    expect(el.querySelector('.remote').dataset.state).toBe('host');
    expect(api.subscribeView).toHaveBeenCalledWith({hostId: 'mac-1'}, expect.any(Function), expect.any(Function));
    expect(api.watch).toHaveBeenCalledWith({hostId: 'mac-1'});
    view.unmount();
  });

  test('shows the host\'s readouts and sends a command per button', async () => {
    const api = pageApi();
    const prefs = reactivePrefs({remote: {hostId: 'phone-self-1', last: null}});
    const el = document.body.appendChild(document.createElement('div'));
    const view = await mount(el, {query: {host: 'mac-1'}}, {api, prefs, now: () => 10_000, setTimer: () => 1, clearTimer: () => {},
      haptic: () => {}, wakeLock: {request: async () => null}});
    api.emitHosts([{hostId: 'ipad-1', name: 'iPad', title: 'Low Tide', seenAt: 9_500}, {hostId: 'mac-1', name: 'MacBook', title: 'Glasshouse', artist: 'Northbound', seenAt: 9_000}]);
    expect(prefs.get('remote.last')).toBe('mac-1');
    expect(el.querySelector('.remote-picker').hidden).toBe(false);
    api.emitView({host: {hostId: 'mac-1'}, state: {phase: 'playing', position: '23 · 3', section: 'Chorus', next: 'next: Bridge · 4 bars',
      rate: 0.85, bpm: 102, loop: true, loopLabel: 'Chorus', countIn: true, click: false, minusMe: true, mine: 'drums', setlist: false}, updatedAt: 1});
    expect(el.querySelector('.remote-song').textContent).toBe('Glasshouse');
    expect(el.querySelector('.remote-song-sub').textContent).toBe('Northbound · on MacBook');
    expect(el.querySelector('.remote-section').textContent).toBe('Chorus');
    expect(el.querySelector('.remote-speed').textContent).toBe('85% · 102 bpm');
    expect(byName(PAGE_COPY.stop)).toBeTruthy();
    expect(byName('Loop: Chorus').getAttribute('aria-pressed')).toBe('true');
    expect(byName(PAGE_COPY.minusMe('drums')).getAttribute('aria-pressed')).toBe('true');
    byName(PAGE_COPY.stop).click();
    byName(PAGE_COPY.nextSection).click();
    byName('Loop: Chorus').click();
    byName(PAGE_COPY.faster).click();
    await flush();
    expect(api.sent).toEqual(['transport.playStop', 'nav.nextSection', 'transport.loopToggle', 'speed.up']);
    expect(api.send).toHaveBeenCalledWith({hostId: 'mac-1', command: 'transport.playStop'});
    view.unmount();
  });

  const two = (mac, ipad) => [{hostId: 'mac-1', name: 'MacBook', title: 'Glasshouse', seenAt: mac},
    {hostId: 'ipad-1', name: 'iPad', title: 'Low Tide', seenAt: ipad}];
  const pageCtx = (api, prefs, more = {}) => ({api, prefs, now: () => 10_000, setTimer: () => 1, clearTimer: () => {}, haptic: () => {},
    wakeLock: {request: async () => null}, ...more});

  test('a pick in the Device menu wins over ?host= and stays picked as the hosts heartbeat', async () => {
    const api = pageApi();
    const prefs = reactivePrefs({remote: {hostId: 'phone-self-1', last: null}});
    const router = {setQuery: vi.fn()};
    const el = document.body.appendChild(document.createElement('div'));
    const view = await mount(el, {query: {host: 'mac-1'}}, pageCtx(api, prefs, {router}));
    api.emitHosts(two(9_000, 9_500));
    expect(el.querySelector('.remote-song').textContent).toBe('Glasshouse');
    const picker = el.querySelector('.remote-picker');
    picker.value = 'ipad-1';
    picker.dispatchEvent(new Event('change'));
    expect(el.querySelector('.remote-song').textContent).toBe('Low Tide');
    api.emitHosts(two(9_900, 9_600));              // a heartbeat
    expect(el.querySelector('.remote-song').textContent).toBe('Low Tide');
    expect(prefs.get('remote.last')).toBe('ipad-1');
    expect(router.setQuery).toHaveBeenCalledWith({host: 'ipad-1'});
    view.unmount();
  });

  test('with two hosts and nothing remembered it stays on the one it follows while both heartbeat', async () => {
    const api = pageApi();
    const el = document.body.appendChild(document.createElement('div'));
    const view = await mount(el, {query: {}}, pageCtx(api, reactivePrefs({remote: {hostId: 'phone-self-1', last: null}})));
    api.emitHosts(two(9_000, 9_500));
    expect(el.querySelector('.remote-song').textContent).toBe('Low Tide');
    api.emitHosts(two(9_900, 9_500));              // the Mac heartbeats
    api.emitHosts(two(9_900, 9_950));
    expect(el.querySelector('.remote-song').textContent).toBe('Low Tide');
    expect(api.subscribeView).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  test('a phone whose clock is fast still sees the hosts: liveness is by the server\'s clock, which watch returns', async () => {
    const api = pageApi();
    api.watch = vi.fn(async () => ({now: 10_000 - 120_000}));   // this phone is two minutes fast
    const el = document.body.appendChild(document.createElement('div'));
    const view = await mount(el, {query: {}}, pageCtx(api, reactivePrefs({remote: {hostId: 'phone-self-1'}})));
    expect(api.watch).toHaveBeenCalledWith({});      // no host followed yet: just the server's time
    api.emitHosts([{hostId: 'mac-1', name: 'MacBook', title: 'Glasshouse', seenAt: 10_000 - 121_000}]);
    await flush();
    expect(el.querySelector('.remote').dataset.state).toBe('host');
    expect(api.watch).toHaveBeenLastCalledWith({hostId: 'mac-1'});
    view.unmount();
  });

  test('a host that closed its song says so', async () => {
    const api = pageApi();
    api.send = vi.fn(async () => { throw Object.assign(new Error('gone'), {code: 'not_found'}); });
    const el = document.body.appendChild(document.createElement('div'));
    const view = await mount(el, {query: {}}, {api, prefs: reactivePrefs({remote: {hostId: 'phone-self-1'}}), now: () => 10_000,
      setTimer: () => 1, clearTimer: () => {}, haptic: () => {}, wakeLock: {request: async () => null}});
    api.emitHosts([{hostId: 'mac-1', name: 'MacBook', title: 'Glasshouse', seenAt: 9_000}]);
    byName(PAGE_COPY.again).click();
    await flush();
    expect(el.querySelector('.remote-status').textContent).toContain(PAGE_COPY.closed);
    view.unmount();
  });
});

describe('the Library bar', () => {
  test('appears while another device has a song open and opens the remote for it', () => {
    let emit;
    const api = {subscribeHosts: vi.fn(fn => { emit = fn; return () => {}; })};
    const router = {navigate: vi.fn()};
    const host = document.body.appendChild(document.createElement('div'));
    const bar = mountRemoteBar(host, {router, api, prefs: reactivePrefs({remote: {hostId: 'this-device-1'}}), now: () => 10_000,
      setTimer: () => 1, clearTimer: () => {}});
    expect(bar.el.hidden).toBe(true);
    emit([{hostId: 'this-device-1', name: 'Mac', title: 'Mine', seenAt: 9_900}]);   // this device: not shown
    expect(bar.el.hidden).toBe(true);
    emit([{hostId: 'mac-1', name: 'MacBook', title: 'Glasshouse', seenAt: 9_000}, {hostId: 'ipad-1', name: 'iPad', title: 'Low Tide', seenAt: 8_000}]);
    expect(bar.el.hidden).toBe(false);
    expect(bar.el.textContent).toContain(BAR_COPY.open('Glasshouse', 'MacBook') + BAR_COPY.more(1));
    bar.el.querySelector('button').click();
    expect(router.navigate).toHaveBeenCalledWith('/remote?host=mac-1');
    bar.destroy();
  });

  test('a device whose clock is fast still shows it: it asks the server\'s time once', async () => {
    let emit;
    const api = {subscribeHosts: vi.fn(fn => { emit = fn; return () => {}; }), watch: vi.fn(async () => ({now: 10_000 - 120_000}))};
    const host = document.body.appendChild(document.createElement('div'));
    const bar = mountRemoteBar(host, {api, prefs: reactivePrefs({remote: {hostId: 'this-device-1'}}), now: () => 10_000,
      setTimer: () => 1, clearTimer: () => {}});
    emit([{hostId: 'mac-1', name: 'MacBook', title: 'Glasshouse', seenAt: 10_000 - 121_000}]);
    await flush();
    expect(api.watch).toHaveBeenCalledWith({});
    expect(bar.el.hidden).toBe(false);
    bar.destroy();
    mountRemoteBar(host, {api, prefs: reactivePrefs({remote: {hostId: 'this-device-1'}}), now: () => 10_000,
      setTimer: () => 1, clearTimer: () => {}}).destroy();
    expect(api.watch).toHaveBeenCalledTimes(1);      // known now
  });
});

describe('the Phone remote dialog', () => {
  test('"Your phone is connected." clears once the phone stops watching, by the server\'s clock', async () => {
    let clock = 1_000_000;
    learnServerTime({now: clock - 120_000}, clock);   // this device's clock is two minutes fast
    const watchedAt = clock - 120_000 - 1000;
    const t = timers();
    const closed = openRemoteSheet({prefs: reactivePrefs({remote: {allow: true, hostId: 'mac-host-1'}}), origin: 'https://woodshed.example',
      status: signal({hosting: true, hostId: 'mac-host-1', watchedAt}), platform: {isMac: true}, now: () => clock,
      setTimer: t.setTimer, clearTimer: t.clearTimer});
    const line = document.querySelector('.remote-sheet-status');
    expect(line.textContent).toBe(SHEET_COPY.connected);
    clock += WATCH_MS;                               // no watch since: the phone left
    t.tick(RECHECK_MS);
    expect(line.textContent).toBe(SHEET_COPY.waiting);
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === SHEET_COPY.done).click();
    await closed;
    expect(t.count).toBe(0);
  });

  test('the status line (a live region) is rewritten only when it changes, and names another tab that hosts', async () => {
    const t = timers();
    const status = signal({hosting: false, hostId: 'mac-host-1', watchedAt: null});
    const closed = openRemoteSheet({prefs: reactivePrefs({remote: {allow: true, hostId: 'mac-host-1'}}), origin: 'https://woodshed.example',
      status, platform: {isMac: true}, now: () => 1_000_000, setTimer: t.setTimer, clearTimer: t.clearTimer});
    const line = document.querySelector('.remote-sheet-status');
    expect(line.textContent).toBe(SHEET_COPY.waiting);
    const writes = [];
    const observer = new MutationObserver(list => writes.push(...list));
    observer.observe(line, {childList: true, characterData: true, subtree: true});
    t.tick(RECHECK_MS);
    t.tick(RECHECK_MS);
    await Promise.resolve();
    expect(writes).toHaveLength(0);
    status.value = {hosting: false, hostId: 'mac-host-1', watchedAt: null, elsewhere: true};
    expect(line.textContent).toBe(SHEET_COPY.elsewhere);
    observer.disconnect();
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === SHEET_COPY.done).click();
    await closed;
  });

  test('the QR code encodes the remote link for this device', () => {
    const url = remoteUrl('mac-host-1', 'https://woodshed.kylekincer.com/');
    expect(url).toBe('https://woodshed.kylekincer.com/remote?host=mac-host-1');
    const svg = qrSvg(url);
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    const n = qr.getModuleCount();
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${n + 8} ${n + 8}`);
    let dark = 0;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) dark++;
    expect(svg.querySelector('path').getAttribute('d').match(/M/g)).toHaveLength(dark);
  });
});
