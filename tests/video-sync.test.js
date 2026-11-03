// @vitest-environment node
// src/js/video/video-sync.js keeps a playthrough video on the transport, and shared/video.ts reads YouTube links.
// The player is simulated: its clock runs at its speed, a seek buffers for SEEK_S before it plays on, and it offers
// YouTube's fixed speed steps (or any speed).
import {describe, expect, test} from 'vitest';
import {SYNC, createVideoSync, rateFor} from '../src/js/video/video-sync.js';
import {linkStart, offsetFor, parseYouTubeId, validVideos, videoLabel} from '../shared/video.ts';

const STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const SEEK_S = 0.3;

function rig({speed = 1, rates = STEPS, offset = 5, duration = 300, phase = 'stopped', position = 10, anySpeed = false} = {}) {
  const clock = {ms: 0};
  const player = {
    ready: true, t: 0, state: 'paused', rate: 1, rates, duration, seeks: [], until: 0,
    get playing() { return this.state === 'playing'; },
    get buffering() { return this.state === 'buffering'; },
    time() { return this.t; },
    play() { if (this.state === 'paused') this.state = 'playing'; this.wantPlay = true; },
    pause() { this.state = 'paused'; this.wantPlay = false; },
    seek(t) { this.t = t; this.seeks.push(t); if (this.wantPlay) { this.state = 'buffering'; this.until = clock.ms + SEEK_S * 1000; } },
    // YouTube's player snaps to its steps unless it takes any speed (it does, though it lists only the steps).
    setRate(r) { this.rate = anySpeed ? r : rates.reduce((a, b) => (Math.abs(b - r) < Math.abs(a - r) ? b : a)); },
  };
  const song = {phase, rate: speed, position};
  const transport = {snapshot: {peek: () => ({phase: song.phase, rate: song.rate})}, position: () => song.position};
  const sync = createVideoSync({player, transport, offset: () => offset, now: () => clock.ms});
  /** Runs `seconds` of time in SYNC.intervalMs steps; returns the largest drift seen once settled (after `settle` s). */
  function run(seconds, {settle = 2} = {}) {
    let worst = 0;
    const dt = SYNC.intervalMs / 1000;
    for (let s = 0; s < seconds; s += dt) {
      clock.ms += SYNC.intervalMs;
      if (song.phase === 'playing') song.position += dt * song.rate;
      if (player.state === 'buffering' && clock.ms >= player.until) player.state = 'playing';
      if (player.state === 'playing') player.t += dt * player.rate;
      sync.tick();
      if (s >= settle && song.phase === 'playing') worst = Math.max(worst, Math.abs(player.t - (song.position + offset)));
    }
    return worst;
  }
  return {player, song, sync, run, clock};
}

describe('video sync', () => {
  test('stopped: the video waits, paused, on the frame the song is at; a new cue moves it', () => {
    const r = rig({position: 10});
    r.run(1);
    expect(r.player.state).toBe('paused');
    expect(r.player.t).toBeCloseTo(15, 3);
    r.song.position = 42;
    r.run(0.4);
    expect(r.player.t).toBeCloseTo(47, 3);
  });

  test('playing at a speed YouTube has: in step, without seeking', () => {
    const r = rig({speed: 1});
    r.run(1);
    r.song.phase = 'playing';
    const seeks = r.player.seeks.length;
    expect(r.run(60)).toBeLessThan(0.25);
    expect(r.player.rate).toBe(1);
    expect(r.player.seeks.length).toBe(seeks);
  });

  test('playing at 85%, which YouTube lacks: it switches between 75% and 100% and stays close, without seeking', () => {
    const r = rig({speed: 0.85});
    r.run(1);
    r.song.phase = 'playing';
    const seeks = r.player.seeks.length;
    expect(r.run(60, {settle: 4})).toBeLessThan(SYNC.dither + 0.1);
    expect([0.75, 1]).toContain(r.player.rate);
    expect(r.player.seeks.length).toBe(seeks);
  });

  test('a player that takes any speed though it lists only the steps: 85% exactly, no switching', () => {
    const r = rig({speed: 0.85, anySpeed: true});
    r.run(1);
    r.song.phase = 'playing';
    expect(r.run(30, {settle: 4})).toBeLessThan(0.06);
    expect(r.player.rate).toBeCloseTo(0.85, 2);
  });

  test('any speed when the player offers it', () => {
    const r = rig({speed: 0.85, rates: [0.85, 1]});
    r.song.phase = 'playing';
    r.run(10);
    expect(r.player.rate).toBe(0.85);
  });

  test('a loop restart while playing: one seek, back on time once it lands', () => {
    const r = rig({speed: 1, phase: 'playing'});
    r.run(10);
    r.song.position -= 8;   // the loop wraps
    const before = r.player.seeks.length;
    r.run(1, {settle: 99});
    expect(r.player.seeks.length).toBe(before + 1);
    expect(r.run(10, {settle: 1})).toBeLessThan(SYNC.seekDrift);
  });

  test('before the video starts and after it ends: paused on its first or last frame', () => {
    const early = rig({offset: -20, position: 5, phase: 'playing'});
    early.run(1);
    expect(early.sync.tick()).toBe('before');
    expect(early.player.state).toBe('paused');
    expect(early.player.t).toBe(0);
    const late = rig({offset: 0, position: 400, duration: 300});
    late.run(1);
    expect(late.sync.tick()).toBe('after');
  });

  test('no player yet: waiting', () => {
    const r = rig();
    r.player.ready = false;
    expect(r.sync.tick()).toBe('waiting');
  });

  test('rateFor: the exact speed, else the neighbour that closes the drift', () => {
    expect(rateFor(1.25, STEPS, {current: 1, drift: 0})).toBe(1.25);
    expect(rateFor(0.85, STEPS, {current: 1, drift: -0.1})).toBe(1);
    expect(rateFor(0.85, STEPS, {current: 1, drift: 0.1})).toBe(0.75);
    expect(rateFor(0.85, STEPS, {current: 0.75, drift: 0.01})).toBe(0.75);
    expect(rateFor(0.85, STEPS, {current: 1.5, drift: 0})).toBe(0.75);
    expect(rateFor(0.1, STEPS, {current: 1, drift: 0})).toBe(0.25);
  });
});

describe('YouTube links (shared/video.ts)', () => {
  test('ids from every link shape; anything else is null', () => {
    for (const link of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube.com/watch?v=dQw4w9WgXcQ&t=42s', 'https://youtu.be/dQw4w9WgXcQ?t=10',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=x', 'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'https://www.youtube.com/live/dQw4w9WgXcQ', 'dQw4w9WgXcQ']) {
      expect(parseYouTubeId(link), link).toBe('dQw4w9WgXcQ');
    }
    for (const bad of ['', 'https://vimeo.com/123', 'https://evil.example/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=short', 'not a link'])
      expect(parseYouTubeId(bad), bad).toBeNull();
  });

  test('a link\'s start time', () => {
    expect(linkStart('https://youtu.be/dQw4w9WgXcQ?t=90')).toBe(90);
    expect(linkStart('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s')).toBe(90);
    expect(linkStart('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(0);
  });

  test('validation, offsets and labels', () => {
    const video = {id: 'v1', videoId: 'dQw4w9WgXcQ', label: 'Overhead', offset: 14.3};
    expect(validVideos([video, {...video, id: 'v2', label: ''}])).toBe(true);
    expect(validVideos([video, video])).toBe(false);
    expect(validVideos([{...video, videoId: 'x'}])).toBe(false);
    expect(validVideos([{...video, offset: NaN}])).toBe(false);
    expect(validVideos(Array.from({length: 9}, (_, i) => ({...video, id: `v${i}`})))).toBe(false);
    expect(offsetFor(30.25, 16)).toBe(14.25);
    expect(videoLabel({label: ' '}, 1)).toBe('Video 2');
    expect(videoLabel(video, 0)).toBe('Overhead');
  });
});
