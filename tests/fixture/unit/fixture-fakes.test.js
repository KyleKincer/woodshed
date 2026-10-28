// @vitest-environment node
// The preamble's fakes (architecture §11.2), each on a fresh happy-dom Window:
// platform, feature removal, manual audio, wake lock, MIDI, Media Session,
// install prompt, share and clipboard, the local processor (fetch and XHR
// uploads) and the desktop bridge. tests/fixture/states/FX1.cjs runs the same
// fakes in Chromium.
import {describe, it, expect, vi, afterEach} from 'vitest';
import {Window} from 'happy-dom';
import {applyPlatform, PLATFORMS} from '../fakes/platform.js';
import {parseFeatures, removeFeatures, FEATURES} from '../fakes/features.js';
import {installManualAudio, STEP_MS} from '../fakes/manual-audio.js';
import {installWakeLock} from '../fakes/wake-lock.js';
import {installMidi} from '../fakes/midi.js';
import {installMediaSession} from '../fakes/media-session.js';
import {installInstallPrompt} from '../fakes/install-prompt.js';
import {installShare, installClipboard} from '../fakes/share-clipboard.js';
import {createCompanion, searchResults, ORIGIN, TOKEN} from '../fakes/companion.js';
import {installDesktopBridge} from '../fakes/desktop-bridge.js';

const windows = [];
function makeWindow() {
  const win = new Window({url: 'http://127.0.0.1:5190/'});
  win.console.error = vi.fn();
  windows.push(win);
  return win;
}
afterEach(async () => { vi.useRealTimers(); for (const w of windows.splice(0)) await w.happyDOM.close(); });
const AUTH = {authorization: `Bearer ${TOKEN}`};

describe('fx-platform', () => {
  it('ipad looks like desktop-class iPadOS Safari', () => {
    const win = makeWindow();
    expect(applyPlatform(win, 'ipad')).toBe('ipad');
    expect(win.navigator.platform).toBe('MacIntel');
    expect(win.navigator.maxTouchPoints).toBe(5);
    expect(win.navigator.userAgent).toMatch(/Version\/18\.0 Safari/);
    expect(win.navigator.userAgentData).toBeUndefined();
  });
  it('mac and win look like Chrome there, with userAgentData', async () => {
    const mac = makeWindow();
    applyPlatform(mac, 'mac');
    expect([mac.navigator.platform, mac.navigator.maxTouchPoints, mac.navigator.userAgentData.platform]).toEqual(['MacIntel', 0, 'macOS']);
    expect((await mac.navigator.userAgentData.getHighEntropyValues(['architecture'])).architecture).toBe('arm');
    const win = makeWindow();
    applyPlatform(win, 'win');
    expect([win.navigator.platform, win.navigator.userAgentData.platform]).toEqual(['Win32', 'Windows']);
    expect(Object.keys(PLATFORMS)).toEqual(['ipad', 'mac', 'win']);
  });
  it('unset does nothing; an unknown name is a console error', () => {
    const win = makeWindow(), before = win.navigator.userAgent;
    expect(applyPlatform(win, undefined)).toBeNull();
    expect(applyPlatform(win, 'android')).toBeNull();
    expect(win.navigator.userAgent).toBe(before);
    expect(win.console.error).toHaveBeenCalledWith(expect.stringContaining('fx-platform must be one of ipad, mac, win'));
  });
});

describe('fx-nofeature', () => {
  /** A window with every feature present, as in Chromium. */
  function fullWindow() {
    const win = makeWindow();
    const add = (proto, key, value) => Object.defineProperty(proto, key, {configurable: true, writable: true, value});
    for (const key of ['showPopover', 'hidePopover', 'togglePopover']) add(win.HTMLElement.prototype, key, () => {});
    Object.defineProperty(win.HTMLElement.prototype, 'popover', {configurable: true, get: () => null});
    add(win.Document.prototype, 'startViewTransition', () => {});
    for (const key of ['wakeLock', 'requestMIDIAccess', 'mediaSession', 'share', 'canShare']) add(win.Navigator.prototype, key, {});
    Object.defineProperty(win.CSSStyleDeclaration.prototype, 'anchorName', {configurable: true, get: () => ''});
    win.MediaMetadata = class {};
    Object.defineProperty(win, 'CSS', {configurable: true, writable: true, value: {supports: () => true}});
    return win;
  }
  it('parses the list and reports unknown names', () => {
    const win = makeWindow();
    expect([...parseFeatures(' anchor, MIDI ,,share', win)]).toEqual(['anchor', 'midi', 'share']);
    expect([...parseFeatures('anchor,teleport', win)]).toEqual(['anchor']);
    expect(win.console.error).toHaveBeenCalledWith(expect.stringContaining('unknown feature "teleport"'));
    expect([...parseFeatures(undefined, win)]).toEqual([]);
  });
  it('removes each feature so feature detection fails', () => {
    const win = fullWindow();
    const removed = removeFeatures(win, 'anchor,popover,wakelock,midi,mediasession,viewtransition,share,clipboard');
    expect([...removed].sort()).toEqual([...FEATURES].sort());
    const nav = win.navigator;
    expect(['wakeLock', 'requestMIDIAccess', 'mediaSession', 'share', 'canShare', 'clipboard'].filter(k => k in nav)).toEqual([]);
    expect('showPopover' in win.HTMLElement.prototype || 'popover' in win.HTMLElement.prototype).toBe(false);
    expect('startViewTransition' in win.document).toBe(false);
    expect('anchorName' in win.CSSStyleDeclaration.prototype).toBe(false);
    expect(win.MediaMetadata).toBeUndefined();
    expect(win.CSS.supports('anchor-name: --a')).toBe(false);
    expect(win.CSS.supports('position-area', 'top')).toBe(false);
    expect(win.CSS.supports('selector(:popover-open)')).toBe(false);
    expect(win.CSS.supports('view-transition-name: x')).toBe(false);
    expect(win.CSS.supports('display: grid')).toBe(true);
  });
  it('leaves everything alone for an empty list', () => {
    const win = fullWindow();
    expect(removeFeatures(win, '').size).toBe(0);
    expect('wakeLock' in win.navigator).toBe(true);
    expect(win.CSS.supports('anchor-name: --a')).toBe(true);
  });
});

describe('fx-audio=manual', () => {
  function audioWindow() {
    const win = makeWindow();
    win.AudioContext = class AudioContext { get currentTime() { return 99; } getOutputTimestamp() { return {}; } };
    return win;
  }
  it('AudioContext time stands still until advance(ms) moves it in 25 ms steps', async () => {
    const win = audioWindow();
    const {audio, advance} = installManualAudio(win);
    const ctx = new win.AudioContext();
    expect(ctx.currentTime).toBe(0);
    expect(win.AudioContext.name).toBe('AudioContext');
    expect(ctx.getOutputTimestamp().contextTime).toBe(0);
    const runFor = vi.fn(async () => {});
    win.__pwClock = {controller: {runFor}};
    await advance(110);
    expect(ctx.currentTime).toBeCloseTo(.11, 9);
    expect(runFor.mock.calls.map(c => c[0])).toEqual([25, 25, 25, 25, 10]);
    expect(STEP_MS).toBe(25);
    audio.set(5);
    expect(ctx.currentTime).toBe(5);
    expect(audio.contexts()).toBe(1);
    await expect(advance(-1)).rejects.toThrow(RangeError);
    expect(() => audio.set(-1)).toThrow(RangeError);
  });
  it('without the page clock each step waits real time', async () => {
    vi.useFakeTimers();
    const win = audioWindow();
    const {audio, advance} = installManualAudio(win);
    const done = advance(50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await done).toBeCloseTo(.05, 9);
    expect(audio.time()).toBeCloseTo(.05, 9);
  });
  it('reports a browser without AudioContext', () => {
    const win = makeWindow();
    delete win.AudioContext;
    expect(installManualAudio(win)).toBeNull();
    expect(win.console.error).toHaveBeenCalledWith(expect.stringContaining('no AudioContext'));
  });
});

describe('wake lock', () => {
  it('grants while visible; deny() releases held locks and refuses new ones; grant() allows again', async () => {
    const win = makeWindow(), control = installWakeLock(win);
    const sentinel = await win.navigator.wakeLock.request('screen');
    const onrelease = vi.fn(), listener = vi.fn();
    sentinel.onrelease = onrelease;
    sentinel.addEventListener('release', listener);
    expect(control.state()).toMatchObject({mode: 'grant', held: true, active: 1, requests: 1});
    control.deny();
    expect(sentinel.released).toBe(true);
    expect(onrelease).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    await expect(win.navigator.wakeLock.request('screen')).rejects.toMatchObject({name: 'NotAllowedError'});
    control.grant();
    const again = await win.navigator.wakeLock.request();
    await again.release();
    await again.release();
    expect(control.state()).toMatchObject({held: false, releases: 2, requests: 3});
    await expect(win.navigator.wakeLock.request('system')).rejects.toThrow(TypeError);
  });
  it('a hidden page cannot take one and loses the ones it had', async () => {
    const win = makeWindow(), control = installWakeLock(win);
    const sentinel = await win.navigator.wakeLock.request('screen');
    Object.defineProperty(win.document, 'visibilityState', {configurable: true, get: () => 'hidden'});
    win.document.dispatchEvent(new win.Event('visibilitychange'));
    expect(sentinel.released).toBe(true);
    await expect(win.navigator.wakeLock.request('screen')).rejects.toMatchObject({name: 'NotAllowedError'});
    expect(control.state().held).toBe(false);
  });
});

describe('Web MIDI', () => {
  it('one virtual input that sends notes and control changes', async () => {
    const win = makeWindow(), control = installMidi(win);
    const access = await win.navigator.requestMIDIAccess({sysex: false});
    const [input] = access.inputs.values();
    expect(input).toMatchObject({id: 'fx-midi-1', name: 'Fixture Pad', type: 'input', state: 'connected'});
    const viaHandler = [], viaListener = [];
    input.onmidimessage = e => viaHandler.push([...e.data]);
    input.addEventListener('midimessage', e => viaListener.push([...e.data]));
    expect(control.note(38, 90)).toBe(true);
    control.noteOff(38);
    control.cc(1, 64, {channel: 9});
    expect(viaHandler).toEqual([[0x90, 38, 90], [0x80, 38, 0], [0xB9, 1, 64]]);
    expect(viaListener).toEqual(viaHandler);
    expect(control.state()).toMatchObject({requests: 1, connected: true, listening: true, sent: viaHandler});
    expect(() => control.note(128)).toThrow(RangeError);
    expect(() => control.cc(1, 1, {channel: 16})).toThrow(RangeError);
  });
  it('disconnect/connect fire statechange; deny() refuses access', async () => {
    const win = makeWindow(), control = installMidi(win);
    const access = await win.navigator.requestMIDIAccess({sysex: true});
    const changes = [];
    access.onstatechange = e => changes.push(e.port.state);
    control.disconnect();
    expect(access.inputs.size).toBe(0);
    expect(control.note(60)).toBe(false);
    control.connect();
    expect(changes).toEqual(['disconnected', 'connected']);
    expect(control.state().sysexRequested).toBe(true);
    control.deny();
    await expect(win.navigator.requestMIDIAccess()).rejects.toMatchObject({name: 'SecurityError'});
    control.allow();
    expect(await win.navigator.requestMIDIAccess()).toBe(access);
  });
});

describe('Media Session recorder', () => {
  it('records handlers, metadata, playback and position state; press() calls the handler', () => {
    const win = makeWindow(), control = installMediaSession(win);
    const session = win.navigator.mediaSession;
    const next = vi.fn();
    session.setActionHandler('nexttrack', next);
    session.setActionHandler('play', () => {});
    session.setActionHandler('play', null);
    session.metadata = new win.MediaMetadata({title: 'Glasshouse', artist: 'Northbound', artwork: [{src: 'cover.png', sizes: '512x512'}]});
    session.playbackState = 'playing';
    session.playbackState = 'bogus';
    session.setPositionState({duration: 128, position: 12, playbackRate: .75});
    expect(control.press('nexttrack', {seekTime: 3})).toBe(true);
    expect(next).toHaveBeenCalledWith({action: 'nexttrack', seekTime: 3});
    expect(control.press('previoustrack')).toBe(false);
    const state = control.state();
    expect(state.actions).toEqual(['nexttrack']);
    expect(state.metadata).toEqual({title: 'Glasshouse', artist: 'Northbound', album: '', artwork: [{src: 'cover.png', sizes: '512x512', type: ''}]});
    expect(state.playbackState).toBe('playing');
    expect(state.positionState).toEqual({duration: 128, position: 12, playbackRate: .75});
    expect(state.log.filter(e => e.type === 'press').map(e => [e.action, e.handled])).toEqual([['nexttrack', true], ['previoustrack', false]]);
    expect(() => session.setActionHandler('dance', () => {})).toThrow(TypeError);
    expect(() => session.setPositionState({duration: 10, position: 20})).toThrow(TypeError);
  });
});

describe('beforeinstallprompt', () => {
  it('offer() dispatches the event; prompt() resolves the outcome once and fires appinstalled when accepted', async () => {
    vi.useFakeTimers();
    const win = makeWindow(), control = installInstallPrompt(win);
    let kept = null;
    const installed = vi.fn();
    win.addEventListener('beforeinstallprompt', e => { e.preventDefault(); kept = e; });
    win.addEventListener('appinstalled', installed);
    expect(control.offer()).toBe(false);
    expect(kept.platforms).toEqual(['web']);
    expect(await kept.prompt()).toEqual({outcome: 'accepted', platform: 'web'});
    expect((await kept.userChoice).outcome).toBe('accepted');
    await expect(kept.prompt()).rejects.toMatchObject({name: 'InvalidStateError'});
    await vi.advanceTimersByTimeAsync(1);
    expect(installed).toHaveBeenCalledOnce();
    control.setOutcome('dismissed');
    control.offer();
    expect((await kept.prompt()).outcome).toBe('dismissed');
    expect(control.state()).toEqual({offers: 2, prompts: 2, outcome: 'dismissed', installed: true});
    expect(() => control.setOutcome('maybe')).toThrow(TypeError);
  });
});

describe('share and clipboard recorders', () => {
  it('navigator.share records calls; reject() makes the next one fail; empty data is a TypeError', async () => {
    const win = makeWindow(), control = installShare(win);
    await win.navigator.share({title: 'Glasshouse', url: 'https://woodshed.example/share/x'});
    control.reject();
    await expect(win.navigator.share({text: 'again'})).rejects.toMatchObject({name: 'AbortError'});
    await win.navigator.share({text: 'third'});
    await expect(win.navigator.share({})).rejects.toThrow(TypeError);
    expect(control.calls().map(c => c.title ?? c.text ?? null)).toEqual(['Glasshouse', 'again', 'third', null]);
    expect(win.navigator.canShare({url: 'x'})).toBe(true);
    expect(win.navigator.canShare({})).toBe(false);
    expect(control.state().count).toBe(4);
  });
  it('navigator.clipboard keeps text, records writes, and can be denied', async () => {
    const win = makeWindow(), control = installClipboard(win);
    await win.navigator.clipboard.writeText('https://woodshed.example/share/abc');
    expect(await win.navigator.clipboard.readText()).toBe('https://woodshed.example/share/abc');
    control.set('pasted text');
    expect(await win.navigator.clipboard.readText()).toBe('pasted text');
    await win.navigator.clipboard.write([{types: ['text/plain'], getType: async () => new win.Blob(['from write'])}]);
    expect(control.text()).toBe('from write');
    expect(control.writes()).toEqual([{type: 'text/plain', text: 'https://woodshed.example/share/abc'}, {types: ['text/plain'], text: 'from write'}]);
    control.deny();
    await expect(win.navigator.clipboard.readText()).rejects.toMatchObject({name: 'NotAllowedError'});
    control.allow();
    expect(await win.navigator.clipboard.read()).toEqual([]);
  });
});

describe('the local processor (fetch)', () => {
  const get = (win, path, headers = AUTH) => win.fetch(`${ORIGIN}${path}`, {headers});
  it('/status by switch, and the bearer token is required', async () => {
    const win = makeWindow();
    createCompanion(win, {});
    expect(await (await get(win, '/status')).json()).toMatchObject({connected: true, deviceId: 'dev1', busy: false, job: null, modelsReady: {htdemucs_ft: true}, version: '2.0.0'});
    expect((await get(win, '/status', {})).status).toBe(401);
    const offline = makeWindow(); createCompanion(offline, {companion: 'offline'});
    expect(await (await get(offline, '/status')).json()).toMatchObject({connected: false, deviceId: null});
    const busy = makeWindow(); createCompanion(busy, {companion: 'busy'});
    expect((await (await get(busy, '/status')).json()).job).toEqual({id: 'job-run', stage: 'separate', percent: 46});
    const first = makeWindow(); createCompanion(first, {companion: 'firstrun'});
    expect(Object.values((await (await get(first, '/status')).json()).modelsReady)).toEqual([false, false, false, false]);
    const down = makeWindow(); createCompanion(down, {companion: 'down'});
    await expect(get(down, '/status')).rejects.toThrow(TypeError);
  });
  it('/resolve: a URL, a Spotify link, a playlist, an unavailable video and a bad input', async () => {
    const win = makeWindow();
    createCompanion(win, {});
    const resolve = async url => { const r = await get(win, `/resolve?url=${encodeURIComponent(url)}`); return {status: r.status, body: await r.json()}; };
    const one = await resolve('https://www.youtube.com/watch?v=abcdefgh');
    expect(one).toMatchObject({status: 200, body: {kind: 'url', candidates: [{id: 'abcdefgh', provider: 'youtube', live: false}]}});
    expect((await resolve('https://open.spotify.com/track/x')).body).toMatchObject({kind: 'spotify', query: 'Glasshouse Northbound'});
    expect(await resolve('https://www.youtube.com/watch?v=a&list=PL1')).toMatchObject({status: 422, body: {code: 'playlist'}});
    expect(await resolve('https://youtu.be/unavailable')).toMatchObject({status: 404, body: {code: 'unavailable'}});
    expect(await resolve('ftp://example.com/song')).toMatchObject({status: 400, body: {code: 'invalid'}});
  });
  it('/search: up to n candidates, nothing for "zzz", bot check, timeout and SoundCloud', async () => {
    const win = makeWindow();
    createCompanion(win, {});
    const search = async (q, n = 5) => { const r = await get(win, `/search?q=${encodeURIComponent(q)}&n=${n}`); return {status: r.status, body: await r.json()}; };
    const five = await search('glasshouse northbound');
    expect(five.body.candidates).toHaveLength(5);
    expect(five.body.candidates[0]).toMatchObject({title: 'Glasshouse Northbound (Official Audio)', channel: 'Northbound', provider: 'youtube', thumbnail: expect.stringMatching(/^data:image\/svg\+xml,/)});
    expect(five.body.candidates.some(c => c.live && c.duration === null)).toBe(true);
    expect((await search('glasshouse', 2)).body.candidates).toHaveLength(2);
    expect((await search('zzz')).body.candidates).toEqual([]);
    expect(await search('botcheck please')).toMatchObject({status: 503, body: {code: 'bot_check'}});
    expect(await search('timeout')).toMatchObject({status: 504, body: {code: 'timeout'}});
    expect((await search('soundcloud demo')).body.provider).toBe('soundcloud');
    expect(await search('x', 9)).toMatchObject({status: 400});
    expect(searchResults('a b', 5).map(c => c.id)).toEqual(searchResults('a b', 5).map(c => c.id));
    const failing = makeWindow(); createCompanion(failing, {lookup: 'fail'});
    expect((await get(failing, '/search?q=glasshouse&n=5')).status).toBe(503);
  });
  it('candidate thumbnails are local data: URLs (a rendered row never reaches the network)', async () => {
    const win = makeWindow();
    createCompanion(win, {});
    const search = await (await get(win, '/search?q=glasshouse&n=5')).json();
    const resolved = await (await get(win, `/resolve?url=${encodeURIComponent('https://www.youtube.com/watch?v=abcdefgh')}`)).json();
    const spotify = await (await get(win, `/resolve?url=${encodeURIComponent('https://open.spotify.com/track/x')}`)).json();
    const thumbs = [...search.candidates, ...resolved.candidates, ...spotify.candidates].map(c => c.thumbnail).filter(Boolean);
    expect(thumbs.length).toBeGreaterThan(5);
    for (const t of thumbs) expect(t).toMatch(/^data:image\/svg\+xml,/);
    expect(JSON.stringify([search, resolved, spotify])).not.toMatch(/ytimg|https:\/\/i\./);
  });
  it('legacy import, export and unknown routes; other origins go to the real fetch', async () => {
    const win = makeWindow();
    const real = vi.fn(async () => new win.Response('{}'));
    win.fetch = real;
    const companion = createCompanion(win, {legacy: '1'});
    expect(await (await get(win, '/legacy')).json()).toEqual([{directory: '~/Library/Application Support/woodshed', count: 48}]);
    expect(await (await win.fetch(`${ORIGIN}/import`, {method: 'POST', headers: AUTH, body: '{}'})).json()).toEqual({count: 20, skipped: 0, remaining: 28});
    expect((await win.fetch(`${ORIGIN}/export-originals`, {method: 'POST', headers: AUTH})).status).toBe(200);
    expect((await get(win, '/nowhere')).status).toBe(404);
    await win.fetch('https://example.com/x');
    expect(real).toHaveBeenCalledWith('https://example.com/x', {});
    expect(companion.calls().map(c => c.path)).toEqual(['/legacy', '/import', '/export-originals', '/nowhere']);
    const controller = new win.AbortController();
    controller.abort();
    await expect(win.fetch(`${ORIGIN}/status`, {headers: AUTH, signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
  });
});

describe('the local processor (XHR uploads)', () => {
  function upload(win, {name = 'take 1.wav', size = 10_000, auth = true} = {}) {
    const xhr = new win.XMLHttpRequest(), progress = [], events = [];
    xhr.open('POST', `${ORIGIN}/upload`);
    if (auth) xhr.setRequestHeader('Authorization', AUTH.authorization);
    xhr.setRequestHeader('X-Filename', encodeURIComponent(name));
    xhr.upload.addEventListener('progress', e => progress.push([e.loaded, e.total]));
    for (const type of ['loadstart', 'load', 'error', 'abort', 'loadend']) xhr.addEventListener(type, () => events.push(type));
    const done = new Promise(resolve => xhr.addEventListener('loadend', () => resolve()));
    xhr.send(new win.Blob([new Uint8Array(size)]));
    return {xhr, progress, events, done};
  }
  it('reports real progress in ten steps, then 200 {id}', async () => {
    vi.useFakeTimers();
    const win = makeWindow(), companion = createCompanion(win, {});
    const {xhr, progress, events, done} = upload(win);
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(progress).toHaveLength(10);
    expect(progress[4]).toEqual([5000, 10_000]);
    expect(progress.at(-1)).toEqual([10_000, 10_000]);
    expect(xhr.status).toBe(200);
    expect(xhr.readyState).toBe(4);
    expect(JSON.parse(xhr.responseText)).toEqual({id: 'up-1'});
    expect(xhr.getResponseHeader('content-type')).toBe('application/json');
    expect(events).toEqual(['loadstart', 'load', 'loadend']);
    expect(companion.uploads()).toEqual([{filename: 'take 1.wav', size: 10_000, auth: true, via: 'xhr'}]);
  });
  it('abort() stops it with abort events and no response', async () => {
    vi.useFakeTimers();
    const win = makeWindow();
    createCompanion(win, {});
    const {xhr, progress, events, done} = upload(win);
    await vi.advanceTimersByTimeAsync(400);
    xhr.abort();
    await done;
    await vi.advanceTimersByTimeAsync(2000);
    expect(progress.length).toBeLessThan(10);
    expect(events).toEqual(['loadstart', 'abort', 'loadend']);
    expect(xhr.status).toBe(0);
  });
  it('fx-upload=fail drops the connection half way; fx-upload=slow takes 10 s; a missing token is a 401', async () => {
    vi.useFakeTimers();
    const failing = makeWindow();
    createCompanion(failing, {upload: 'fail'});
    const broken = upload(failing);
    await vi.advanceTimersByTimeAsync(2000);
    await broken.done;
    expect(broken.progress).toHaveLength(5);
    expect(broken.events).toEqual(['loadstart', 'error', 'loadend']);
    const slow = makeWindow();
    createCompanion(slow, {upload: 'slow'});
    const late = upload(slow);
    await vi.advanceTimersByTimeAsync(5000);
    expect(late.progress).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(6000);
    await late.done;
    expect(late.xhr.status).toBe(200);
    const plain = makeWindow();
    createCompanion(plain, {});
    const unauthorised = upload(plain, {auth: false});
    await vi.advanceTimersByTimeAsync(2000);
    await unauthorised.done;
    expect(unauthorised.xhr.status).toBe(401);
    expect(unauthorised.progress).toEqual([]);
  });
  it('fx-companion=down: an upload errors at once, with no upload progress', async () => {
    vi.useFakeTimers();
    const win = makeWindow();
    createCompanion(win, {companion: 'down'});
    const refused = upload(win);
    const uploadEvents = [];
    for (const type of ['progress', 'error', 'loadend']) refused.xhr.upload.addEventListener(type, () => uploadEvents.push(type));
    await vi.advanceTimersByTimeAsync(100);
    await refused.done;
    expect(refused.progress).toEqual([]);
    expect(uploadEvents).toEqual(['error', 'loadend']);
    expect(refused.events).toEqual(['loadstart', 'error', 'loadend']);
    expect(refused.xhr.status).toBe(0);
  });
});

describe('the desktop bridge', () => {
  it('exposes exactly the final preload methods, frozen; every on*() returns off', async () => {
    const win = makeWindow(), control = installDesktopBridge(win, {});
    const bridge = win.woodshedDesktop;
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.keys(bridge).sort()).toEqual(['info', 'mediaUrl', 'notify', 'onCommand', 'onFlushRequest', 'onFullScreen', 'onNavigate', 'onOpenUpdates', 'onProcessorState', 'onUpdate', 'registerMenu', 'restartProcessor', 'setActivity', 'setBackgroundShortcuts', 'setTheme', 'update']);
    for (const key of Object.keys(bridge).filter(k => k.startsWith('on'))) {
      const off = bridge[key](() => {});
      expect(typeof off, key).toBe('function');
      off();
    }
    expect(Object.values(control.listenerCounts()).every(n => n === 0)).toBe(true);
    expect(() => bridge.onCommand('nope')).toThrow(TypeError);
    expect(await bridge.info()).toEqual({version: '2.0.0', platform: 'darwin-arm64', companion: {port: 47831, token: TOKEN}, update: {status: 'idle', percent: 40, version: '2.0.1'}, processor: {phase: 'ready'}});
  });
  it('switches shape info(): update, processor phase, platform and a stopped processor', async () => {
    const win = makeWindow();
    installDesktopBridge(win, {update: 'ready', processor: 'starting', platform: 'win'});
    expect(await win.woodshedDesktop.info()).toMatchObject({platform: 'win32-x64', update: {status: 'ready'}, processor: {phase: 'starting'}});
    const down = makeWindow();
    installDesktopBridge(down, {companion: 'down'});
    expect(await down.woodshedDesktop.info()).toMatchObject({companion: null, processor: {phase: 'stopped'}});
  });
  it('commands, navigation, full screen, updates and processor state reach their listeners', async () => {
    vi.useFakeTimers();
    const win = makeWindow(), control = installDesktopBridge(win, {}), bridge = win.woodshedDesktop;
    const seen = [];
    bridge.onCommand(c => seen.push(['command', c]));
    bridge.onNavigate(r => seen.push(['navigate', r]));
    bridge.onFullScreen(on => seen.push(['fullScreen', on]));
    bridge.onUpdate(u => seen.push(['update', u.status]));
    bridge.onOpenUpdates(() => seen.push(['openUpdates']));
    bridge.onProcessorState(p => seen.push(['processor', p.phase]));
    expect(control.command('transport.playStop', 'global')).toBe(1);
    control.navigate('/s/glasshouse');
    control.fullScreen(true);
    control.updateState({status: 'available'});
    control.openUpdates();
    control.processorState({phase: 'stopped', exitCode: 1});
    const restarted = bridge.restartProcessor();
    await vi.advanceTimersByTimeAsync(300);
    expect(await restarted).toEqual({port: 47831, token: TOKEN});
    expect(seen).toEqual([['command', {id: 'transport.playStop', source: 'global'}], ['navigate', '/s/glasshouse'], ['fullScreen', true], ['update', 'available'], ['openUpdates'], ['processor', 'stopped'], ['processor', 'restarting'], ['processor', 'ready']]);
    expect((await bridge.info()).update.status).toBe('available');
    expect(await bridge.update('show')).toMatchObject({status: 'available'});
  });
  it('records menus, activity, notifications, theme and shortcuts', async () => {
    const win = makeWindow(), control = installDesktopBridge(win, {}), bridge = win.woodshedDesktop;
    expect(control.menu()).toBeNull();
    bridge.registerMenu([{menu: 'file', items: [{id: 'library.add', label: 'Add Songs…', accelerator: 'CmdOrCtrl+N', enabled: true}, {type: 'separator'}, {id: 'view.distance', label: 'Distance', submenu: [{id: 'view.distance.near', label: 'Near', type: 'radio', checked: false}]}]}]);
    expect(control.menu()[0].items[2].submenu[0].id).toBe('view.distance.near');
    bridge.registerMenu([{menu: 'file', items: [{id: 'Bad Id', label: 'x'}]}]);
    expect(win.console.error).toHaveBeenCalledWith(expect.stringContaining('invalid menu ids ["Bad Id"]'));
    expect(control.menus()).toHaveLength(2);
    expect(() => bridge.registerMenu({})).toThrow(TypeError);
    bridge.setActivity({playing: false, songOpen: true, keepAwake: false});
    expect(control.activity()).toEqual({playing: false, songOpen: true, keepAwake: false});
    expect(await bridge.notify({title: 'Glasshouse is ready', body: 'Open it', route: '/s/glasshouse'})).toBe(true);
    control.setNotifyResult(false);
    expect(await bridge.notify({title: 't', body: 'b', route: '/'})).toBe(false);
    expect(control.notifications()).toHaveLength(2);
    await bridge.setTheme('dark');
    expect(bridge.mediaUrl('blob:x')).toBe('blob:x');
    expect(await bridge.setBackgroundShortcuts(true)).toEqual({registered: ['MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack'], failed: [], accessibility: 'granted'});
    expect(await bridge.setBackgroundShortcuts(false)).toEqual({registered: [], failed: []});
    const failing = makeWindow();
    installDesktopBridge(failing, {shortcuts: 'fail', platform: 'win'});
    expect(await failing.woodshedDesktop.setBackgroundShortcuts(true)).toEqual({registered: [], failed: ['MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack']});
    expect(control.calls().map(c => c.method)).toContain('setTheme');
  });
  it('flush() waits for every flush listener, with the quit guard’s timeout', async () => {
    vi.useFakeTimers();
    const win = makeWindow(), control = installDesktopBridge(win, {}), bridge = win.woodshedDesktop;
    let flushed = false;
    bridge.onFlushRequest(() => new Promise(resolve => setTimeout(() => { flushed = true; resolve(); }, 100)));
    const ok = control.flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(await ok).toEqual({flushed: true, timedOut: false, listeners: 1});
    expect(flushed).toBe(true);
    bridge.onFlushRequest(() => new Promise(() => {}));
    const late = control.flush({timeoutMs: 3000});
    await vi.advanceTimersByTimeAsync(3000);
    expect(await late).toEqual({flushed: false, timedOut: true, listeners: 2});
  });
});
