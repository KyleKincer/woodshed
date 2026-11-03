// @vitest-environment happy-dom
// The playthrough video on the Stage: the song's list as the Stage edits it (src/stage/video-store.js), the panel
// beside the music (src/stage/video-panel.js, with a fake player), and the Playthrough video sheet
// (src/stage/sheets/video.js).
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {signal} from '../src/app/store.js';
import {createRegistry} from '../src/app/commands.js';
import {prefs} from '../src/app/prefs.js';
import {createVideoStore, SAVE_MS} from '../src/stage/video-store.js';
import {createVideoPanel} from '../src/stage/video-panel.js';
import {render} from '../src/stage/sheets/video.js';
import {COPY, clockTime, parseClock} from '../src/stage/video.copy.js';

const V1 = {id: 'v1', videoId: 'dQw4w9WgXcQ', label: 'Overhead', offset: 14.3};
const V2 = {id: 'v2', videoId: 'abcdefghijk', label: '', offset: 2};

function memoryDevice() {
  const m = new Map();
  return {get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), remove: (k) => m.delete(k), m};
}

function sessionWith(videos = [], {readOnly = false, phase = 'stopped', position = 0} = {}) {
  const song = signal({id: 's1', title: 'Glasshouse', videos});
  const snap = signal({phase, rate: 1});
  const pos = {t: position};
  return {id: 's1', readOnly, song, transport: {snapshot: snap, position: () => pos.t}, pos, snap};
}

function fakePlayerFactory() {
  const made = [];
  const factory = (host, {videoId}) => {
    const p = {videoId, ready: true, playing: false, buffering: false, rate: 1, rates: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2], duration: 300,
      t: 0, error: null, volume: null, destroyed: false, seeks: [],
      el: host.ownerDocument.createElement('div'),
      time() { return this.t; }, play() { this.playing = true; }, pause() { this.playing = false; },
      seek(t) { this.t = t; this.seeks.push(t); }, setRate(r) { this.rate = r; }, setVolume(v) { this.volume = v; },
      destroy() { this.destroyed = true; this.el.remove(); }};
    host.append(p.el);
    made.push(p);
    return p;
  };
  factory.made = made;
  return factory;
}

beforeEach(() => { prefs.update((d) => { d.video = {show: true, volume: 0}; }); });
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

describe('the video store', () => {
  test('edits show at once and save once, a moment later; the song catching up drops the pending copy', async () => {
    vi.useFakeTimers();
    const session = sessionWith([V1]);
    const save = vi.fn(async ({videos}) => { session.song.value = {...session.song.peek(), videos}; });
    const store = createVideoStore({session, save, device: memoryDevice()});
    expect(store.angle.peek()).toBe('v1');
    store.update('v1', {offset: 14.31});
    store.update('v1', {offset: 14.32});
    expect(store.current().offset).toBe(14.32);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_MS + 10);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toEqual({id: 's1', videos: [{...V1, offset: 14.32}]});
    expect(store.videos.peek()).toEqual([{...V1, offset: 14.32}]);
  });

  test('add (a new id, shown), remove, the angle remembered per song on this device', () => {
    const device = memoryDevice();
    const session = sessionWith([V1]);
    const store = createVideoStore({session, save: vi.fn(async () => {}), device});
    const added = store.add({videoId: 'abcdefghijk', offset: 3});
    expect(added).toEqual({id: 'v2', videoId: 'abcdefghijk', label: '', offset: 3});
    expect(store.angle.peek()).toBe('v2');
    expect(device.m.get('s1')).toBe('v2');
    store.remove('v2');
    expect(store.angle.peek()).toBe('v1');
    expect(createVideoStore({session: sessionWith([V1, V2]), save: vi.fn(), device}).angle.peek()).toBe('v2');
  });

  test('a shared song\'s videos can\'t be changed', () => {
    const save = vi.fn();
    const store = createVideoStore({session: sessionWith([V1], {readOnly: true}), save, device: memoryDevice()});
    expect(store.readOnly).toBe(true);
    expect(store.update('v1', {offset: 1})).toBe(false);
    expect(store.add({videoId: 'abcdefghijk'})).toBeNull();
    expect(store.current().offset).toBe(14.3);
  });
});

describe('the video panel', () => {
  function mount(videos = [V1, V2], opts = {}) {
    const session = sessionWith(videos, opts);
    const store = createVideoStore({session, save: vi.fn(async () => {}), device: memoryDevice()});
    const factory = fakePlayerFactory();
    const host = document.createElement('div');
    document.body.append(host);
    const stage = {openSheet: vi.fn(), setVideoShown: vi.fn()};
    const timers = {setInterval: () => 1, clearInterval: () => {}};
    const panel = createVideoPanel(host, {session, stage, store, prefs, createPlayer: factory, timers});
    return {session, store, factory, panel, stage, host};
  }

  test('plays the shown angle, follows the song (paused on the song\'s frame) and switches angle', async () => {
    const r = mount([V1, V2], {position: 20});
    expect(r.factory.made).toHaveLength(1);
    expect(r.panel.el.dataset.videoId).toBe(V1.videoId);
    r.panel.tick();
    expect(r.factory.made[0].t).toBeCloseTo(34.3, 6);
    // A nudge applies at once.
    r.store.update('v1', {offset: 15});
    await new Promise((resolve) => setTimeout(resolve, 150));   // stopped, the video seeks at most every 120 ms
    r.panel.tick();
    expect(r.factory.made[0].t).toBeCloseTo(35, 6);
    const select = r.panel.el.querySelector('.stage-video-angle');
    expect([...select.options].map((o) => o.textContent)).toEqual(['Overhead', 'Video 2']);
    select.value = 'v2';
    select.dispatchEvent(new Event('change'));
    expect(r.factory.made).toHaveLength(2);
    expect(r.factory.made[0].destroyed).toBe(true);
    expect(r.panel.el.dataset.videoId).toBe(V2.videoId);
  });

  test('Line up… opens the sheet, ✕ hides the video, and the sound is this device\'s', () => {
    const r = mount([V1]);
    expect(r.panel.el.querySelector('.stage-video-angle').hidden).toBe(true);
    expect(r.panel.el.querySelector('.stage-video-name').textContent).toBe('Overhead');
    r.panel.el.querySelector('.stage-video-button').click();
    expect(r.stage.openSheet).toHaveBeenCalledWith('video', expect.anything());
    r.panel.el.querySelector(`[aria-label="${COPY.hide}"]`).click();
    expect(r.stage.setVideoShown).toHaveBeenCalledWith(false);
    expect(r.factory.made[0].volume).toBe(0);
    prefs.set('video.volume', 40);
    expect(r.factory.made[0].volume).toBe(40);
  });

  test('before the video starts, and a video its owner won\'t let play here', () => {
    const r = mount([{...V1, offset: -12}], {position: 3});
    r.panel.tick();
    expect(r.panel.el.dataset.status).toBe('before');
    expect(r.panel.el.querySelector('.stage-video-status').textContent).toBe(COPY.before('0:12.0'));
    r.factory.made[0].error = 150;
    r.panel.tick();
    expect(r.panel.el.dataset.status).toBe('error');
    expect(r.panel.el.querySelector('.stage-video-status').textContent).toContain(COPY.blocked);
    expect(r.panel.el.querySelector('.stage-video-link').href).toBe(`https://www.youtube.com/watch?v=${V1.videoId}`);
  });

  test('destroy removes the player', () => {
    const r = mount([V1]);
    r.panel.destroy();
    expect(r.factory.made[0].destroyed).toBe(true);
    expect(r.host.childElementCount).toBe(0);
  });
});

describe('the Playthrough video sheet', () => {
  function open({videos = [], readOnly = false, desktop = true, fetchAudio} = {}) {
    const session = sessionWith(videos, {readOnly});
    const store = createVideoStore({session, save: vi.fn(async () => {}), device: memoryDevice()});
    const registry = createRegistry();
    registry.provide('stage', () => ({videos: store}));
    const container = document.createElement('div');
    document.body.append(container);
    const handle = render(container, {session, registry, prefs, desktop: {available: desktop}, fetchAudio});
    return {session, store, container, handle};
  }
  const button = (root, name) => [...root.querySelectorAll('button')].find((b) => !b.closest('[hidden]') && (b.getAttribute('aria-label') ?? b.textContent.trim()) === name) ?? null;

  test('add a YouTube link (its t= is where the recording starts); anything else is refused', () => {
    const r = open();
    const input = r.container.querySelector('.sheet-video-input');
    input.value = 'https://example.com/video';
    button(r.container, COPY.add).click();
    expect(r.container.querySelector('.sheet-video-error').textContent).toBe(COPY.notYouTube);
    input.value = 'https://youtu.be/dQw4w9WgXcQ?t=14';
    button(r.container, COPY.add).click();
    expect(r.store.videos.peek()).toEqual([{id: 'v1', videoId: 'dQw4w9WgXcQ', label: '', offset: 14}]);
    expect(r.container.querySelector('.sheet-video-time').value).toBe('0:14.0');
    expect(button(r.container, COPY.addAnother)).not.toBeNull();
  });

  test('line it up by hand: the start time and the nudges', () => {
    const r = open({videos: [V1]});
    const time = r.container.querySelector('.sheet-video-time');
    time.value = '0:20.5';
    time.dispatchEvent(new Event('change'));
    expect(r.store.current().offset).toBe(20.5);
    button(r.container, COPY.nudge(-0.1)).click();
    button(r.container, COPY.nudge(0.01)).click();
    expect(r.store.current().offset).toBeCloseTo(20.41, 6);
    time.value = 'soon';
    time.dispatchEvent(new Event('change'));
    expect(r.container.querySelector('#' + time.getAttribute('aria-describedby')).textContent).toBe(COPY.invalidTime);
  });

  test('line up automatically (desktop): the video\'s sound against the song\'s', async () => {
    // The song: one stem with a burst every half second, slightly irregular; the video: the same, 3.25 s later.
    const rate = 16000, hits = [];
    let x = 7;
    const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let t = 0.3; t < 30; t += 0.25 * (1 + Math.floor(rnd() * 3))) hits.push(t);
    const buffer = (shift, length) => {
      const data = new Float32Array(Math.ceil(length * rate));
      for (const t of hits) { const at = Math.round((t + shift) * rate); for (let i = 0; i < 400 && at + i < data.length; i++) if (at + i >= 0) data[at + i] += Math.sin(i) * Math.exp(-i / 80); }
      return {sampleRate: rate, length: data.length, numberOfChannels: 1, getChannelData: () => data, duration: length};
    };
    const r = open({videos: [{...V1, offset: 0}], fetchAudio: vi.fn(async () => new ArrayBuffer(8))});
    r.session.engine = {tracks: [{name: 'drums', buffer: buffer(0, 31)}], ctx: {decodeAudioData: async () => buffer(3.25, 35)}};
    button(r.container, COPY.auto).click();
    await vi.waitFor(() => expect(r.container.querySelector('[data-section=lineup] [role=status]').textContent).toMatch(/lined up/i), {timeout: 10000});
    expect(r.store.current().offset).toBeCloseTo(3.25, 1);
  }, 20000);

  test('the browser has no automatic line-up; a shared song can only be watched', () => {
    const web = open({videos: [V1], desktop: false});
    expect(button(web.container, COPY.auto)).toBeNull();
    expect(web.container.textContent).toContain(COPY.autoDesktop);
    const shared = open({videos: [V1], readOnly: true});
    expect(shared.container.querySelector('.sheet-video-add').hidden).toBe(true);
    expect(shared.container.querySelector('[data-section=lineup]').hidden).toBe(true);
    expect(shared.container.textContent).toContain(COPY.readOnly);
  });

  test('this device: the video\'s sound and Show beside the music', () => {
    const r = open({videos: [V1]});
    const show = button(r.container, COPY.show);
    show.click();
    expect(prefs.get('video.show')).toBe(false);
  });
});

describe('times', () => {
  test('clockTime and parseClock', () => {
    expect(clockTime(14.3)).toBe('0:14.3');
    expect(clockTime(75.04)).toBe('1:15.0');
    expect(clockTime(-2.06)).toBe('−0:02.1');
    expect(parseClock('0:14.3')).toBeCloseTo(14.3, 6);
    expect(parseClock('1:02:03')).toBe(3723);
    expect(parseClock('-0:02,5')).toBe(-2.5);
    expect(parseClock('14')).toBe(14);
    expect(parseClock('x')).toBeNull();
  });
});
