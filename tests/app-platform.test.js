// @vitest-environment happy-dom
// src/app/platform.js (architecture §2.11, spec §4.2, D13).
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {signal} from '../src/app/store.js';
import * as clock from '../src/app/clock.js';
import {createRegistry} from '../src/app/commands.js';
import {
  detect, fixtureSwitches, globalsOf, createPlatform, haptic, createWakeLock, wakeSetting, watchInterruptions,
  startMediaSession, startGestureAudio, createInstall, silentWav, mediaMetadataFor,
} from '../src/app/platform.js';
import {installWakeLock} from './fixture/fakes/wake-lock.js';
import {installMediaSession} from './fixture/fakes/media-session.js';
import {installInstallPrompt} from './fixture/fakes/install-prompt.js';
import {PLATFORMS} from './fixture/fakes/platform.js';
import {setMedia, restoreDomShims} from './helpers/dom.js';

const NAV = {
  ipad: {...PLATFORMS.ipad},
  iphone: {platform: 'iPhone', maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'},
  mac: {...PLATFORMS.mac},
  macSafari: {platform: 'MacIntel', maxTouchPoints: 0, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'},
  win: {...PLATFORMS.win},
  linux: {platform: 'Linux x86_64', maxTouchPoints: 0, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0.0.0'},
};

let visibility = 'visible';
function setVisibility(state) {
  visibility = state;
  document.dispatchEvent(new window.Event('visibilitychange'));
}

beforeEach(() => {
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => visibility});
});

afterEach(() => {
  vi.useRealTimers();
  clock.reset();
  restoreDomShims();
  vi.restoreAllMocks();
});

/** A transport-shaped fake: snapshot signal, events, and the methods platform.js calls. */
function fakeTransport(phase = 'stopped') {
  const listeners = new Map();
  const snapshot = signal({phase, armed: false});
  return {
    snapshot,
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type).delete(fn);
    },
    emit(type, payload = {}) { for (const fn of [...(listeners.get(type) ?? [])]) fn(payload); },
    count: type => listeners.get(type)?.size ?? 0,
    setPhase(next, extra = {}) { snapshot.value = {...snapshot.peek(), phase: next, ...extra}; },
    playStop: vi.fn(), again: vi.fn(), interrupt: vi.fn(), goToRegion: vi.fn(),
  };
}

function fakeEngine() {
  const listeners = new Set();
  return {
    ctx: {state: 'suspended', resume: vi.fn(() => Promise.resolve())},
    on(type, fn) { if (type === 'interrupted') listeners.add(fn); return () => listeners.delete(fn); },
    interrupt(state = 'interrupted') { for (const fn of [...listeners]) fn({state}); },
    count: () => listeners.size,
  };
}

describe('detect()', () => {
  test('identifies each platform from the navigator alone', () => {
    expect(detect({navigator: NAV.ipad})).toMatchObject({isIPad: true, isIOS: true, isMac: false, isWindows: false, isDesktopApp: false});
    expect(detect({navigator: NAV.iphone})).toMatchObject({isIPad: false, isIOS: true, isMac: false});
    expect(detect({navigator: NAV.mac})).toMatchObject({isIPad: false, isIOS: false, isMac: true, isWindows: false});
    expect(detect({navigator: NAV.macSafari})).toMatchObject({isMac: true, isIPad: false});
    expect(detect({navigator: NAV.win})).toMatchObject({isWindows: true, isMac: false, isIOS: false});
    expect(detect({navigator: NAV.linux})).toMatchObject({isWindows: false, isMac: false, isIOS: false, isIPad: false});
    expect(detect({navigator: NAV.mac, bridge: {}}).isDesktopApp).toBe(true);
    expect(detect()).toMatchObject({isDesktopApp: false, isMac: false, features: {wakeLock: false, midi: false}});
  });

  test('feature probes read only what is passed in', () => {
    const nav = {...NAV.mac, wakeLock: {}, requestMIDIAccess: () => {}, mediaSession: {}};
    const css = {supports: q => /anchor-name/.test(q)};
    const doc = {documentElement: {showPopover() {}}, startViewTransition() {}};
    expect(detect({navigator: nav, css, document: doc}).features)
      .toEqual({anchor: true, popover: true, wakeLock: true, midi: true, mediaSession: true, viewTransition: true});
    expect(detect({navigator: NAV.mac}).features)
      .toEqual({anchor: false, popover: false, wakeLock: false, midi: false, mediaSession: false, viewTransition: false});
  });

  test('is pure: the same inputs give equal results and no global is read', () => {
    const input = {navigator: {...NAV.ipad, wakeLock: {}}, fx: {nofeature: 'midi'}};
    const a = detect(input);
    vi.stubGlobal('navigator', NAV.win);
    vi.stubGlobal('woodshedDesktop', {});
    const b = detect(input);
    vi.unstubAllGlobals();
    expect(b).toEqual(a);
    expect(Object.isFrozen(input.navigator)).toBe(false);
    expect(input.fx).toEqual({nofeature: 'midi'});
  });

  test('fx-platform and fx-nofeature override the navigator', () => {
    const nav = {...NAV.mac, wakeLock: {}, requestMIDIAccess: () => {}, mediaSession: {}};
    const doc = {documentElement: {showPopover() {}}, startViewTransition() {}};
    const css = {supports: () => true};
    expect(detect({navigator: nav, fx: {platform: 'ipad'}})).toMatchObject({isIPad: true, isIOS: true, isMac: false, isWindows: false});
    expect(detect({navigator: NAV.ipad, fx: {platform: 'mac'}})).toMatchObject({isIPad: false, isIOS: false, isMac: true});
    expect(detect({navigator: NAV.mac, fx: {platform: 'win'}})).toMatchObject({isWindows: true, isMac: false});
    expect(detect({navigator: NAV.mac, fx: {platform: 'bogus'}}).isMac).toBe(true);
    expect(detect({navigator: nav, css, document: doc, fx: {nofeature: 'anchor, popover,wakelock,midi,mediasession,viewtransition,share'}}).features)
      .toEqual({anchor: false, popover: false, wakeLock: false, midi: false, mediaSession: false, viewTransition: false});
    expect(detect({navigator: nav, css, document: doc, fx: {nofeature: 'midi'}}).features).toMatchObject({midi: false, wakeLock: true, popover: true});
  });

  test('the switches come from window.__FIXTURE_EARLY__.fx, only under the fixture', () => {
    expect(fixtureSwitches({__FIXTURE__: true, __FIXTURE_EARLY__: {fx: {platform: 'ipad'}}})).toEqual({platform: 'ipad'});
    expect(fixtureSwitches({__FIXTURE__: true, fixture: {fx: {platform: 'win'}}})).toEqual({platform: 'win'});
    expect(fixtureSwitches({__FIXTURE_EARLY__: {fx: {platform: 'ipad'}}, location: {search: '?fx-platform=ipad'}})).toBeNull();
    const win = {__FIXTURE__: true, __FIXTURE_EARLY__: {fx: {platform: 'ipad', nofeature: 'wakelock'}},
      navigator: {...NAV.mac, wakeLock: {}}, location: {search: ''}, document: null};
    expect(detect(globalsOf(win))).toMatchObject({isIPad: true, features: {wakeLock: false}});
  });
});

describe('platform signals', () => {
  test('coarse, hoverFine and reducedMotion follow matchMedia; online follows the window', () => {
    setMedia({coarse: false, hoverNone: false, reducedMotion: false});
    const p = createPlatform(window);
    expect([p.coarse.value, p.hoverFine.value, p.reducedMotion.value]).toEqual([false, true, false]);
    setMedia({coarse: true, hoverNone: true, reducedMotion: true});
    expect([p.coarse.value, p.hoverFine.value, p.reducedMotion.value]).toEqual([true, false, true]);
    window.dispatchEvent(new window.Event('offline'));
    expect(p.online.value).toBe(false);
    window.dispatchEvent(new window.Event('online'));
    expect(p.online.value).toBe(true);
    expect(() => { p.coarse.value = false; }).toThrow();
    expect(p.standalone).toBe(false);
    setMedia({standalone: true});
    expect(createPlatform(window).standalone).toBe(true);
  });

  test('haptic vibrates where it can', () => {
    const nav = {vibrate: vi.fn(() => true)};
    expect(haptic(8, nav)).toBe(true);
    expect(nav.vibrate).toHaveBeenCalledWith(8);
    expect(haptic(8, {})).toBe(false);
  });
});

describe('wake lock', () => {
  const MIN = 60_000;
  let fake;
  beforeEach(() => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
    fake = installWakeLock(window);
  });
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  const make = (wake = 10, extra = {}) => createWakeLock({navigator, document, desktop: {available: false}, wake: () => wake, ...extra});

  test('wake setting is 5, 10, 30 or always; anything else is 10', () => {
    expect([5, 10, 30, 'always', 7, null, undefined].map(wakeSetting)).toEqual([5, 10, 30, 'always', 10, 10, 10]);
  });

  test('acquires while playing, keeps the lock N minutes after Stop, then releases', async () => {
    const lock = make(10);
    expect(lock.supported).toBe(true);
    lock.update({stageOpen: true, playing: true});
    await flush();
    expect(lock.held.value).toBe(true);
    expect(fake.state()).toMatchObject({held: true, requests: 1});
    lock.update({playing: false});
    vi.advanceTimersByTime(10 * MIN - 1);
    await flush();
    expect(lock.held.value).toBe(true);
    vi.advanceTimersByTime(1);
    await flush();
    expect(lock.held.value).toBe(false);
    expect(fake.state()).toMatchObject({held: false, releases: 1});
    // Playing again re-acquires.
    lock.update({playing: true});
    await flush();
    expect(lock.held.value).toBe(true);
    expect(fake.state().requests).toBe(2);
  });

  test('an open Stage that never played counts from the moment it opened; an explicit stoppedAt wins', async () => {
    const lock = make(5);
    lock.update({stageOpen: true, playing: false});
    await flush();
    expect(lock.held.value).toBe(true);
    vi.advanceTimersByTime(5 * MIN);
    await flush();
    expect(lock.held.value).toBe(false);
    const other = make(30);
    other.update({stageOpen: true, playing: false, stoppedAt: clock.now() - 29 * MIN});
    await flush();
    expect(other.held.value).toBe(true);
    vi.advanceTimersByTime(MIN);
    await flush();
    expect(other.held.value).toBe(false);
  });

  test('stoppedAt: null at Stop counts the grace from the Stop, not from opening', async () => {
    const lock = make(10);
    lock.update({stageOpen: true, playing: false, stoppedAt: null});
    vi.advanceTimersByTime(1000);
    lock.update({stageOpen: true, playing: true, stoppedAt: null});
    vi.advanceTimersByTime(20 * MIN);
    lock.update({stageOpen: true, playing: false, stoppedAt: null});
    await flush();
    expect(lock.held.value).toBe(true);
    vi.advanceTimersByTime(10 * MIN);
    await flush();
    expect(lock.held.value).toBe(false);
  });

  test("'always' holds while the Stage is open; closing releases", async () => {
    const lock = make('always');
    lock.update({stageOpen: true, playing: false});
    await flush();
    vi.advanceTimersByTime(600 * MIN);
    await flush();
    expect(lock.held.value).toBe(true);
    lock.release();
    await flush();
    expect(lock.held.value).toBe(false);
    expect(fake.state().held).toBe(false);
  });

  test('the system releases on hide; visible re-acquires', async () => {
    const lock = make(10);
    lock.update({stageOpen: true, playing: true});
    await flush();
    setVisibility('hidden');
    await flush();
    expect(lock.held.value).toBe(false);
    setVisibility('visible');
    await flush();
    expect(lock.held.value).toBe(true);
    expect(fake.state()).toMatchObject({held: true, requests: 2});
  });

  test('denied: supported stays true, held stays false, and visible tries again', async () => {
    fake.deny();
    const lock = make(10);
    lock.update({stageOpen: true, playing: true});
    await flush();
    expect(lock.supported).toBe(true);
    expect(lock.held.value).toBe(false);
    lock.update({playing: true});
    await flush();
    expect(fake.state().requests).toBe(1);
    fake.grant();
    setVisibility('hidden');
    setVisibility('visible');
    await flush();
    expect(lock.held.value).toBe(true);
  });

  test('a lock granted after the Stage closed is released at once', async () => {
    const lock = make(10);
    lock.update({stageOpen: true, playing: true});
    lock.release();
    await flush();
    expect(lock.held.value).toBe(false);
    expect(fake.state().held).toBe(false);
  });

  test('unsupported without navigator.wakeLock', () => {
    const lock = createWakeLock({navigator: {}, document, desktop: {available: false}, wake: () => 10});
    expect(lock.supported).toBe(false);
    lock.update({stageOpen: true, playing: true});
    expect(lock.held.value).toBe(false);
  });

  test('the desktop app keeps the display awake through setActivity', async () => {
    const desktop = {available: true, setActivity: vi.fn()};
    const lock = createWakeLock({navigator, document, desktop, wake: () => 5});
    expect(lock.supported).toBe(true);
    lock.update({stageOpen: true, playing: true});
    expect(desktop.setActivity).toHaveBeenLastCalledWith({keepAwake: true});
    expect(lock.held.value).toBe(true);
    expect(fake.state().requests).toBe(0);
    lock.update({playing: false});
    vi.advanceTimersByTime(5 * MIN);
    expect(desktop.setActivity).toHaveBeenLastCalledWith({keepAwake: false});
    expect(desktop.setActivity).toHaveBeenCalledTimes(2);
    expect(lock.held.value).toBe(false);
  });

  test('changing the wake setting applies to an open Stage at once', async () => {
    const account = signal({practice: {wake: 30}});
    const lock = createWakeLock({navigator, document, desktop: {available: false}, wake: () => account.peek().practice.wake, settings: account});
    lock.update({stageOpen: true, playing: false});
    await flush();
    vi.advanceTimersByTime(6 * MIN);
    await flush();
    expect(lock.held.value).toBe(true);
    account.value = {practice: {wake: 5}};
    await flush();
    expect(lock.held.value).toBe(false);
    account.value = {practice: {wake: 'always'}};
    await flush();
    expect(lock.held.value).toBe(true);
    lock.destroy();
    account.value = {practice: {wake: 10}};
    expect(lock.held.value).toBe(false);
  });

  test('destroy stops listening for visibility', async () => {
    const lock = make(10);
    lock.update({stageOpen: true, playing: true});
    await flush();
    lock.destroy();
    setVisibility('hidden');
    setVisibility('visible');
    await flush();
    expect(fake.state().requests).toBe(1);
    expect(lock.held.value).toBe(false);
  });
});

describe('interruptions', () => {
  test('the engine\'s interrupted event interrupts the transport', () => {
    const engine = fakeEngine(), transport = fakeTransport('playing');
    const off = watchInterruptions({engine, transport, platform: {isIOS: false, isIPad: false}, document});
    engine.interrupt('interrupted');
    expect(transport.interrupt).toHaveBeenCalledWith('audio');
    off();
    expect(engine.count()).toBe(0);
  });

  test('on iOS and iPadOS, hiding the page while playing interrupts; stopped or elsewhere it does not', () => {
    const engine = fakeEngine(), transport = fakeTransport('playing');
    const off = watchInterruptions({engine, transport, platform: {isIOS: true, isIPad: true}, document});
    setVisibility('hidden');
    expect(transport.interrupt).toHaveBeenCalledTimes(1);
    setVisibility('visible');
    transport.setPhase('counting');
    setVisibility('hidden');
    expect(transport.interrupt).toHaveBeenCalledTimes(2);
    transport.setPhase('stopped');
    setVisibility('hidden');
    expect(transport.interrupt).toHaveBeenCalledTimes(2);
    off();
    transport.setPhase('playing');
    setVisibility('hidden');
    expect(transport.interrupt).toHaveBeenCalledTimes(2);

    const mac = fakeTransport('playing');
    const offMac = watchInterruptions({engine: fakeEngine(), transport: mac, platform: {isIOS: false, isIPad: false, isMac: true}, document});
    setVisibility('hidden');
    expect(mac.interrupt).not.toHaveBeenCalled();
    offMac();
  });
});

describe('Media Session', () => {
  let media;
  beforeEach(() => { media = installMediaSession(window); });
  const song = signal({id: 's1', title: 'Glasshouse', artist: 'Northbound', album: 'Rooms', coverUrl: 'https://coverartarchive.org/release/r1/front-500'});

  test('registers the handlers and routes them to the transport and registry', () => {
    const transport = fakeTransport('stopped');
    const registry = createRegistry();
    const next = vi.fn();
    registry.register({id: 'nav.nextSection', title: 'Next section', group: 'Navigate', run: next});
    const off = startMediaSession({transport, session: {song}, registry, platform: {isIOS: false}});
    expect(media.state().actions).toEqual(['nexttrack', 'pause', 'play', 'previoustrack']);
    media.press('play');
    expect(transport.playStop).toHaveBeenCalledTimes(1);
    media.press('pause');
    expect(transport.playStop).toHaveBeenCalledTimes(1);
    transport.setPhase('playing');
    media.press('play');
    expect(transport.playStop).toHaveBeenCalledTimes(1);
    media.press('pause');
    expect(transport.playStop).toHaveBeenCalledTimes(2);
    media.press('previoustrack');
    expect(transport.again).toHaveBeenCalledTimes(1);
    media.press('nexttrack');
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].source).toBe('media');
    expect(transport.goToRegion).not.toHaveBeenCalled();
    off();
    expect(media.state().actions).toEqual([]);
    expect(media.state().playbackState).toBe('none');
    expect(media.state().metadata).toBeNull();
  });

  test('nexttrack falls back to the next region when the command is not registered', () => {
    const transport = fakeTransport('playing');
    const off = startMediaSession({transport, session: {song}, registry: createRegistry(), platform: {isIOS: false}});
    media.press('nexttrack');
    expect(transport.goToRegion).toHaveBeenCalledWith(1);
    off();
  });

  test('metadata and playbackState stay current', () => {
    const transport = fakeTransport('stopped');
    const s = signal({title: 'Harbor Lights', artist: '', uploader: 'Ada Moreno Official', album: ''});
    const off = startMediaSession({transport, session: {song: s}, registry: createRegistry(), platform: {isIOS: false}});
    expect(media.state().metadata).toEqual({title: 'Harbor Lights', artist: 'Ada Moreno Official', album: '',
      artwork: [{src: '/icon-512.png', sizes: '512x512', type: 'image/png'}]});
    expect(media.state().playbackState).toBe('paused');
    transport.setPhase('counting');
    expect(media.state().playbackState).toBe('playing');
    transport.setPhase('paused');
    expect(media.state().playbackState).toBe('paused');
    s.value = song.peek();
    expect(media.state().metadata).toEqual({title: 'Glasshouse', artist: 'Northbound', album: 'Rooms',
      artwork: [{src: 'https://coverartarchive.org/release/r1/front-500', sizes: '500x500', type: 'image/jpeg'}]});
    off();
  });

  test('mediaMetadataFor honours a locked empty artist', () => {
    expect(mediaMetadataFor({title: 'T', artist: '', uploader: 'Channel', metadataLocks: ['artist']}).artist).toBe('');
    expect(mediaMetadataFor(null)).toBeNull();
  });

  test('without a Media Session nothing is registered, and nothing breaks', () => {
    const transport = fakeTransport();
    const off = startMediaSession({transport, session: {song}, navigator: {}, registry: createRegistry(), platform: {isIOS: false}});
    expect(transport.count('gesture')).toBe(0);
    off();
  });

  test('iOS/iPadOS keep-alive: plays inside the gesture, pauses on stop, ended and interrupted', () => {
    vi.useFakeTimers();
    const play = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    const pause = vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:keepalive');
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const transport = fakeTransport('stopped');
    const off = startMediaSession({transport, session: {song}, registry: createRegistry(), platform: {isIOS: true, isIPad: true}});
    expect(created).toHaveBeenCalledTimes(1);
    const blob = created.mock.calls[0][0];
    expect(blob.type).toBe('audio/wav');
    expect(play).not.toHaveBeenCalled();

    transport.emit('gesture');            // synchronously inside the Play gesture
    expect(play).toHaveBeenCalledTimes(1);
    const audio = play.mock.contexts[0];
    expect(audio.loop).toBe(true);
    expect(audio.volume).toBe(1);
    expect(audio.getAttribute('src')).toBe('blob:keepalive');

    transport.setPhase('counting');
    transport.setPhase('playing');
    expect(pause).not.toHaveBeenCalled();
    transport.setPhase('stopped');
    expect(pause).not.toHaveBeenCalled();  // debounced past Again's stop → play
    vi.runAllTimers();
    expect(pause).toHaveBeenCalledTimes(1);

    transport.emit('gesture');
    transport.setPhase('stopped', {armed: true});   // Play when ready: still waiting, keep playing
    expect(pause).toHaveBeenCalledTimes(1);
    transport.emit('interrupted', {reason: 'audio'});
    expect(pause).toHaveBeenCalledTimes(2);
    transport.emit('gesture');
    transport.emit('ended', {reason: 'end'});
    expect(pause).toHaveBeenCalledTimes(3);
    expect(play).toHaveBeenCalledTimes(3);

    off();
    expect(revoked).toHaveBeenCalledWith('blob:keepalive');
    expect(transport.count('gesture')).toBe(0);
    expect(transport.count('ended')).toBe(0);
    expect(transport.count('interrupted')).toBe(0);
  });

  test('iOS keep-alive survives Again with count-in and a field change before the phase event', () => {
    vi.useFakeTimers();
    const play = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    const pause = vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:keepalive');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const transport = fakeTransport('stopped');
    const off = startMediaSession({transport, session: {song}, registry: createRegistry(), platform: {isIOS: true, isIPad: true}});
    transport.emit('gesture');
    transport.setPhase('playing');
    // Again while playing with count-in: gesture, then stopped → counting → playing.
    transport.emit('gesture');
    transport.setPhase('stopped');
    transport.setPhase('counting');
    transport.setPhase('playing');
    vi.runAllTimers();
    expect(pause).not.toHaveBeenCalled();
    // Again whose stop and play straddle a macrotask: the element is restarted on re-entry.
    transport.emit('gesture');
    transport.setPhase('stopped');
    vi.runAllTimers();
    expect(pause).toHaveBeenCalledTimes(1);
    const plays = play.mock.calls.length;
    transport.setPhase('counting');
    expect(play).toHaveBeenCalledTimes(plays + 1);
    vi.runAllTimers();
    expect(pause).toHaveBeenCalledTimes(1);
    off();
    vi.useRealTimers();
  });

  test('no keep-alive element off iOS', () => {
    const created = vi.spyOn(URL, 'createObjectURL');
    const transport = fakeTransport();
    const off = startMediaSession({transport, session: {song}, registry: createRegistry(), platform: {isIOS: false, isIPad: false, isMac: true}});
    expect(created).not.toHaveBeenCalled();
    expect(transport.count('gesture')).toBe(0);
    off();
  });

  test('the silent WAV is one second of 16-bit silence', () => {
    const bytes = new Uint8Array(silentWav());
    const ascii = (a, b) => String.fromCharCode(...bytes.slice(a, b));
    expect([ascii(0, 4), ascii(8, 12), ascii(36, 40)]).toEqual(['RIFF', 'WAVE', 'data']);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint32(40, true)).toBe(16000);
    expect(bytes.length).toBe(44 + 16000);
    expect(bytes.slice(44).every(b => b === 0)).toBe(true);
  });
});

describe('startGestureAudio', () => {
  test('resumes a suspended context synchronously inside the gesture', () => {
    const transport = fakeTransport(), engine = fakeEngine();
    const off = startGestureAudio({transport, engine});
    transport.emit('gesture');
    expect(engine.ctx.resume).toHaveBeenCalledTimes(1);
    engine.ctx.state = 'interrupted';
    transport.emit('gesture');
    expect(engine.ctx.resume).toHaveBeenCalledTimes(2);
    engine.ctx.state = 'running';
    transport.emit('gesture');
    engine.ctx.state = 'closed';
    transport.emit('gesture');
    expect(engine.ctx.resume).toHaveBeenCalledTimes(2);
    off();
    expect(transport.count('gesture')).toBe(0);
  });

  test('a rejected resume never throws out of the gesture', () => {
    const transport = fakeTransport(), engine = fakeEngine();
    engine.ctx.resume = vi.fn(() => Promise.reject(new Error('not allowed')));
    startGestureAudio({transport, engine});
    expect(() => transport.emit('gesture')).not.toThrow();
  });
});

describe('install', () => {
  test('Chromium: the deferred prompt, then installed', async () => {
    vi.useFakeTimers();
    const prompts = installInstallPrompt(window);
    Object.defineProperty(navigator, 'userAgentData', {configurable: true, get: () => ({brands: [{brand: 'Chromium', version: '141'}]})});
    const install = createInstall({window, platform: {isIOS: false, isIPad: false, isDesktopApp: false}});
    delete navigator.userAgentData;
    expect(install.state.value).toEqual({canPrompt: false, installed: false, steps: 'chromium'});
    expect(prompts.offer()).toBe(false);   // the page kept the event
    expect(install.state.value).toEqual({canPrompt: true, installed: false, steps: 'chromium'});
    const outcome = install.prompt();
    expect(install.state.value.canPrompt).toBe(false);
    expect(await outcome).toBe('accepted');
    vi.runAllTimers();   // appinstalled
    expect(install.state.value).toEqual({canPrompt: false, installed: true, steps: 'none'});
    expect(await install.prompt()).toBe('unavailable');
  });

  test('a dismissed prompt stays uninstalled', async () => {
    const prompts = installInstallPrompt(window);
    prompts.setOutcome('dismissed');
    const install = createInstall({window, platform: {isIOS: false, isIPad: false}});
    prompts.offer();
    expect(await install.prompt()).toBe('dismissed');
    expect(install.state.value.installed).toBe(false);
  });

  test('iPad shows the iOS steps; the desktop app and standalone show none', () => {
    expect(createInstall({window, platform: {isIOS: true, isIPad: true}}).state.value).toEqual({canPrompt: false, installed: false, steps: 'ios'});
    expect(createInstall({window, platform: {isDesktopApp: true}}).state.value.steps).toBe('none');
    setMedia({standalone: true});
    expect(createInstall({window, platform: {isIOS: true}}).state.value).toEqual({canPrompt: false, installed: true, steps: 'none'});
  });
});

describe('PWA assets', () => {
  const read = path => readFileSync(`${process.cwd()}/${path}`);
  /** {width, height, colorType} from a PNG's IHDR chunk. */
  const png = path => {
    const b = read(path);
    expect([...b.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(b.subarray(12, 16).toString('latin1')).toBe('IHDR');
    return {width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25]};
  };

  test('the manifest is valid and its icons exist at their declared sizes', () => {
    const m = JSON.parse(read('public/manifest.webmanifest').toString('utf8'));
    expect(m).toMatchObject({name: 'Woodshed', short_name: 'Woodshed', start_url: '/', scope: '/', id: '/',
      display: 'standalone', orientation: 'any', theme_color: '#08090a', background_color: '#08090a'});
    expect(m.description.length).toBeGreaterThan(10);
    const purposes = m.icons.map(i => `${i.sizes} ${i.purpose}`);
    expect(purposes).toEqual(expect.arrayContaining(['192x192 any', '512x512 any', '512x512 maskable']));
    for (const icon of m.icons) {
      expect(icon.type).toBe('image/png');
      expect(icon.src).toMatch(/^\/icon-[\w-]+\.png$/);
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(png(`public${icon.src}`)).toMatchObject({width: w, height: h});
    }
  });

  test('the apple-touch icon and the maskable icon are opaque, full-bleed squares', () => {
    expect(png('public/icon-180.png')).toEqual({width: 180, height: 180, colorType: 2});
    expect(png('public/icon-maskable-512.png')).toEqual({width: 512, height: 512, colorType: 2});
    expect(png('public/icon-192.png')).toMatchObject({width: 192, height: 192});
    expect(png('public/icon-512.png')).toMatchObject({width: 512, height: 512});
  });

  test('vercel.json: no local processor origin in the CSP, the manifest served as JSON, History routes rewritten', () => {
    const v = JSON.parse(read('vercel.json').toString('utf8'));
    const csp = v.headers.flatMap(h => h.headers).find(h => h.key === 'Content-Security-Policy').value;
    expect(csp).not.toMatch(/127\.0\.0\.1|localhost/);
    expect(csp).toMatch(/media-src [^;]*blob:/);          // the iOS keep-alive WAV is a blob URL
    expect(csp).toMatch(/connect-src 'self' https:\/\/\*\.convex\.cloud wss:\/\/\*\.convex\.cloud/);
    const manifest = v.headers.find(h => h.source === '/manifest.webmanifest').headers;
    expect(manifest).toContainEqual({key: 'Content-Type', value: 'application/manifest+json'});
    expect(v.rewrites.at(-1)).toEqual({source: '/(.*)', destination: '/index.html'});
  });
});
