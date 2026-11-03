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

beforeEach(() => { prefs.update((d) => { d.video = {show: true, volume: 0, unmuted: 60, dock: 'auto', side: 0.32, top: null, float: {corner: 'br', width: 360}, all: false}; d.video.top = null; }); });
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
  function mount(videos = [V1, V2], {layout = 'rail', device = memoryDevice(), ...opts} = {}) {
    const session = sessionWith(videos, opts);
    const store = createVideoStore({session, save: vi.fn(async () => {}), device: memoryDevice()});
    const factory = fakePlayerFactory();
    const body = document.createElement('div');
    const host = document.createElement('div');
    body.append(host);
    document.body.append(body);
    const stage = {openSheet: vi.fn(), setVideoShown: vi.fn(), layout: signal(layout)};
    const timers = {setInterval: () => 1, clearInterval: () => {}};
    const panel = createVideoPanel(host, {session, stage, store, prefs, createPlayer: factory, timers, device});
    return {session, store, factory, panel, stage, host, device};
  }
  const tool = (r, name) => r.panel.el.querySelector(`.stage-video-tool[data-tool=${name}]`);
  async function menuItem(r, label) {
    tool(r, 'more').click();
    await vi.waitFor(() => expect([...document.querySelectorAll('[role^=menuitem]')].some((el) => el.textContent.includes(label))).toBe(true));
    return [...document.querySelectorAll('[role^=menuitem]')].find((el) => el.textContent.includes(label));
  }

  test('beside the music on the rail, above it on the band; the device can choose, and floating sits in a corner', () => {
    const r = mount([V1], {layout: 'rail'});
    expect(r.host.dataset.dock).toBe('side');
    expect(r.host.style.inlineSize).toBe('32%');
    r.stage.layout.value = 'band';
    expect(r.host.dataset.dock).toBe('top');
    expect(r.host.style.blockSize).toBe('30%');   // no size to measure here: the fallback (in a page, the full width's height)
    prefs.set('video.top', 0.25);
    expect(r.host.style.blockSize).toBe('25%');
    prefs.set('video.dock', 'float');
    expect(r.host.dataset.dock).toBe('float');
    expect(r.host.dataset.corner).toBe('br');
    expect(r.host.style.width).toBe('360px');
    expect(r.panel.el.querySelector('.stage-video-divider').hidden).toBe(true);
    expect(r.panel.el.querySelector('.stage-video-grip').hidden).toBe(false);
  });

  test('the divider resizes with the arrow keys, within limits, and is remembered', () => {
    const r = mount([V1], {layout: 'rail'});
    const divider = r.panel.el.querySelector('[role=separator]');
    expect(divider.getAttribute('aria-valuenow')).toBe('32');
    divider.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowLeft', bubbles: true}));
    expect(prefs.get('video.side')).toBeCloseTo(0.34, 6);
    expect(r.host.style.inlineSize).toBe('34%');
    for (let i = 0; i < 30; i++) divider.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowLeft', bubbles: true}));
    expect(prefs.get('video.side')).toBeLessThanOrEqual(0.62);
  });

  test('plays the shown angle on the song\'s frame; the angles switch from chips (above) and thumbnails (beside)', async () => {
    const r = mount([V1, V2], {layout: 'band', position: 20});
    expect(r.factory.made).toHaveLength(1);
    expect(r.panel.el.dataset.videoId).toBe(V1.videoId);
    r.panel.tick();
    expect(r.factory.made[0].t).toBeCloseTo(34.3, 6);
    r.store.update('v1', {offset: 15});
    await new Promise((resolve) => setTimeout(resolve, 150));   // stopped, the video seeks at most every 120 ms
    r.panel.tick();
    expect(r.factory.made[0].t).toBeCloseTo(35, 6);
    const chips = [...r.panel.el.querySelectorAll('.stage-video-chip')];
    expect(chips.map((c) => c.textContent)).toEqual(['Overhead', 'Video 2']);
    expect(chips[0].getAttribute('aria-pressed')).toBe('true');
    chips[1].click();
    expect(r.factory.made).toHaveLength(2);
    expect(r.factory.made[0].destroyed).toBe(true);
    expect(r.panel.el.dataset.videoId).toBe(V2.videoId);
    // Beside the music, the other angle waits as a thumbnail under the video.
    r.stage.layout.value = 'rail';
    const thumbs = [...r.panel.el.querySelectorAll('.stage-video-thumb')];
    expect(thumbs.map((t) => t.getAttribute('aria-label'))).toEqual(['Watch Overhead']);
    expect(thumbs[0].querySelector('img').src).toBe(`https://i.ytimg.com/vi/${V1.videoId}/mqdefault.jpg`);
    thumbs[0].click();
    expect(r.panel.el.dataset.videoId).toBe(V1.videoId);
  });

  test('Show all angles plays them together (not while floating)', () => {
    const r = mount([V1, V2], {layout: 'rail'});
    prefs.set('video.all', true);
    expect(r.panel.el.dataset.all).toBe('');
    expect(r.panel.el.querySelectorAll('.stage-video-box')).toHaveLength(2);
    expect(r.panel.players.filter((p) => !p.destroyed)).toHaveLength(2);
    expect([...r.panel.el.querySelectorAll('.stage-video-chip[data-label]')].map((c) => c.textContent)).toEqual(['Overhead', 'Video 2']);
    prefs.set('video.dock', 'float');
    expect(r.panel.el.querySelectorAll('.stage-video-box')).toHaveLength(1);
  });

  test('the sound button and the menu: Line up…, Mirror, Hide video', async () => {
    const r = mount([V1]);
    expect(r.factory.made[0].volume).toBe(0);
    expect(tool(r, 'sound').getAttribute('aria-label')).toBe(COPY.soundOn);
    tool(r, 'sound').click();
    expect(prefs.get('video.volume')).toBe(60);
    expect(r.factory.made[0].volume).toBe(60);
    expect(tool(r, 'sound').getAttribute('aria-label')).toBe(COPY.soundOff);
    tool(r, 'sound').click();
    expect(prefs.get('video.volume')).toBe(0);
    (await menuItem(r, COPY.mirror)).click();
    expect(r.panel.el.querySelector('.stage-video-viewport').style.transform).toContain('scaleX(-1)');
    (await menuItem(r, COPY.lineUp)).click();
    await vi.waitFor(() => expect(r.stage.openSheet).toHaveBeenCalledWith('video', expect.anything()));
    (await menuItem(r, COPY.hide)).click();
    await vi.waitFor(() => expect(r.stage.setVideoShown).toHaveBeenCalledWith(false));
  });

  test('wheel zooms into the picture (remembered for the video on this device); a double-click resets it', () => {
    const device = memoryDevice();
    const r = mount([V1], {device});
    const shield = r.panel.el.querySelector('.stage-video-shield');
    shield.dispatchEvent(new WheelEvent('wheel', {deltaY: -400, clientX: 0, clientY: 0, bubbles: true, cancelable: true}));
    const view = device.get(V1.videoId);
    expect(view.zoom).toBeGreaterThan(1.5);
    expect(r.panel.el.querySelector('.stage-video-box').hasAttribute('data-zoomed')).toBe(true);
    shield.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, cancelable: true}));
    expect(device.get(V1.videoId)).toEqual({zoom: 1, x: 0, y: 0, mirror: false});
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

  test('destroy removes the players and the dock', () => {
    const r = mount([V1]);
    r.panel.destroy();
    expect(r.factory.made[0].destroyed).toBe(true);
    expect(r.host.childElementCount).toBe(0);
    expect(r.host.dataset.dock).toBeUndefined();
  });
});

describe('the Playthrough video sheet', () => {
  function open({videos = [], readOnly = false, desktop = true, fetchAudio, search} = {}) {
    const session = sessionWith(videos, {readOnly});
    const store = createVideoStore({session, save: vi.fn(async () => {}), device: memoryDevice()});
    const registry = createRegistry();
    registry.provide('stage', () => ({videos: store}));
    const container = document.createElement('div');
    document.body.append(container);
    session.song.value = {...session.song.peek(), title: 'Harbor Lights', artist: 'Ada Moreno'};
    const handle = render(container, {session, registry, prefs, desktop: {available: desktop}, fetchAudio, search});
    return {session, store, container, handle};
  }
  const button = (root, name) => [...root.querySelectorAll('button')].find((b) => !b.closest('[hidden]') && (b.getAttribute('aria-label') ?? b.textContent.trim()) === name) ?? null;

  test('add a YouTube link (its t= is where the recording starts); anything else is refused', () => {
    const r = open();
    const input = r.container.querySelector('.sheet-video-input[type=url]');
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

  test('find a playthrough (desktop): the song\'s name searched on YouTube; Add adds it and lines it up', async () => {
    const search = vi.fn(async () => ({candidates: [
      {id: 'a', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Harbor Lights drum cam', channel: 'Kit Cam', duration: 205, thumbnail: null, live: false},
      {id: 'b', url: 'https://soundcloud.com/x/y', title: 'Not a video', channel: '', duration: 10, thumbnail: null, live: false},
      {id: 'c', url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Live now', channel: '', duration: null, thumbnail: null, live: true},
    ]}));
    const fetchAudio = vi.fn(async () => { throw Object.assign(new Error('offline'), {code: 'processor_offline'}); });
    const r = open({search, fetchAudio});
    const data = new Float32Array(1600);
    r.session.engine = {tracks: [{name: 'drums', buffer: {sampleRate: 16000, length: 1600, numberOfChannels: 1, getChannelData: () => data}}]};
    const find = r.container.querySelector('.sheet-video-input[type=search]');
    expect(find.value).toBe('Ada Moreno Harbor Lights drum playthrough');
    expect(r.container.querySelector('[data-section=find] h3').textContent).toBe(COPY.find);
    button(r.container, COPY.search).click();
    await vi.waitFor(() => expect(r.container.querySelectorAll('.sheet-video-result')).toHaveLength(1));
    expect(search).toHaveBeenCalledWith('Ada Moreno Harbor Lights drum playthrough', expect.anything());
    expect(r.container.querySelector('.sheet-video-result').textContent).toContain('Kit Cam · 3:25');
    button(r.container, `${COPY.use}: Harbor Lights drum cam`).click();
    expect(r.store.videos.peek().map((v) => v.videoId)).toEqual(['dQw4w9WgXcQ']);
    await vi.waitFor(() => expect(fetchAudio).toHaveBeenCalledWith('dQw4w9WgXcQ', expect.anything()));
    expect(r.container.querySelector('[data-section=find] h3').textContent).toBe(COPY.findAnother);
  });

  test('the browser searches on YouTube itself; layout and all angles are this device\'s', () => {
    const r = open({videos: [V1, V2], desktop: false});
    const link = r.container.querySelector('.sheet-video-web');
    expect(link.href).toBe('https://www.youtube.com/results?search_query=Ada%20Moreno%20Harbor%20Lights%20drum%20playthrough');
    expect(r.container.querySelector('[data-section=find] [data-desktop]').hidden).toBe(true);
    const dock = r.container.querySelector('[role=radiogroup][aria-label="Layout"]');
    [...dock.querySelectorAll('[role=radio]')].find((x) => x.textContent === COPY.docks.float).click();
    expect(prefs.get('video.dock')).toBe('float');
    button(r.container, COPY.allAngles).click();
    expect(prefs.get('video.all')).toBe(true);
  });

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
