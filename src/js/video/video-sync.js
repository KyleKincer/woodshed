// Keeps a playthrough video on the transport (src/stage/video-panel.js): the video's time is the song's time plus the
// video's offset (shared/video.ts), at the transport's speed.
//
//   createVideoSync({player, transport, offset, now?}) → {tick() → status, reset()}
//     player     youtube-player.js (or a fake): {ready, playing, buffering, rate, rates, duration, time(), play(),
//                pause(), seek(t), setRate(r)}
//     transport  {snapshot: Signal<{phase, rate}>, position() → seconds}
//     offset     () → seconds (videoTime = songTime + offset)
//   tick() is called every SYNC.intervalMs (the panel's timer). It returns what the panel shows:
//     'waiting' (no player yet) · 'before' (the song is before the video starts) · 'after' (past its end) ·
//     'synced' · 'catching' (a seek to catch up is in flight)
//
// - Stopped (or counting in): the video is paused on the frame the song is at, so a cue, a jump or a loop start
//   shows where playing will start; during a count-in that seek is already done when the music starts.
// - Playing: the video plays at the transport's speed. YouTube lists only some speeds (0.25 … 2 in steps) but its
//   player takes others when asked: a speed it lacks is asked for as it is, and if the player won't take it the
//   video runs at the listed one above or below, chosen by whether it is behind or ahead (SYNC.dither), which keeps
//   it on time without seeking. It seeks only when it is further off than
//   SYNC.seekDrift (a jump, a loop restart, buffering), at most once per SYNC.seekGapMs, aiming ahead by what the
//   last seek took to land (`lead`, learned).

export const SYNC = Object.freeze({
  intervalMs: 200,
  pausedDrift: 0.04,    // stopped: a frame this far off is sought again
  seekDrift: 0.35,      // playing: further off than this seeks
  dither: 0.03,         // playing at a speed YouTube lacks: switch neighbours past this much drift
  steer: 0.05,          // a player that takes any speed: at most this much faster or slower to catch up
  seekGapMs: 900,
  pausedSeekGapMs: 120,
  rateGapMs: 400,
  playGapMs: 600,
  leadStart: 0.2,
  leadMax: 0.8,
});

const EPS = 0.001;

/** The available speed equal to `rate`, else null. */
export function exactRate(rate, rates) {
  return (rates ?? []).find((r) => Math.abs(r - rate) < EPS) ?? null;
}

/** The available speeds just below and above `rate` (either may be null). */
export function neighbours(rate, rates) {
  const sorted = [...(rates ?? [])].filter(Number.isFinite).sort((a, b) => a - b);
  let lower = null, upper = null;
  for (const r of sorted) { if (r <= rate) lower = r; if (r >= rate && upper === null) upper = r; }
  return {lower, upper};
}

/**
 * The speed to ask for: `rate` when the player has it, else the neighbour that closes the drift (behind → the one
 * above), keeping the current one while the drift is small.
 */
export function rateFor(rate, rates, {current, drift}) {
  const exact = exactRate(rate, rates);
  if (exact !== null) return exact;
  const {lower, upper} = neighbours(rate, rates);
  if (lower === null) return upper ?? rate;
  if (upper === null) return lower;
  if (drift < -SYNC.dither) return upper;
  if (drift > SYNC.dither) return lower;
  if (Math.abs(current - lower) < EPS || Math.abs(current - upper) < EPS) return current;
  return rate - lower <= upper - rate ? lower : upper;
}

export function createVideoSync({player, transport, offset, now = () => globalThis.performance?.now?.() ?? Date.now()}) {
  let lastSeek = -Infinity, lastRate = -Infinity, lastPlay = -Infinity;
  // Whether the player takes a speed it doesn't list: YouTube's list names its menu's steps, but its player plays
  // 0.85× when asked. Unknown until asked: the first speed it lacks is asked for once, and used from then on if it sticks.
  let custom = null, probe = null;
  let lead = SYNC.leadStart, landing = null;   // landing: {target, at} of the last seek while playing

  function seek(t, at) { player.seek(Math.max(0, t)); lastSeek = at; }

  function tick() {
    if (!player?.ready) return 'waiting';
    const at = now();
    const snap = transport.snapshot?.peek?.() ?? {};
    const playing = snap.phase === 'playing';
    const speed = Number.isFinite(snap.rate) && snap.rate > 0 ? snap.rate : 1;
    const target = (Number(transport.position?.()) || 0) + (Number(offset()) || 0);
    const duration = player.duration > 0 ? player.duration : Infinity;

    if (target < 0 || target > duration - 0.05) {
      if (player.playing) player.pause();
      const edge = target < 0 ? 0 : duration;
      if (Number.isFinite(edge) && Math.abs(player.time() - edge) > SYNC.pausedDrift && at - lastSeek > SYNC.pausedSeekGapMs) seek(edge, at);
      return target < 0 ? 'before' : 'after';
    }

    if (!playing) {
      landing = null;
      if (player.playing) player.pause();
      if (Math.abs(player.time() - target) > SYNC.pausedDrift && at - lastSeek > SYNC.pausedSeekGapMs) seek(target, at);
      return 'synced';
    }

    const drift = player.time() - target;
    // A seek made while playing has landed: learn how far behind it came out.
    if (landing && player.playing && at - landing.at > 600) {
      lead = Math.max(0, Math.min(SYNC.leadMax, lead - drift * 0.5));
      landing = null;
    }
    if (Math.abs(drift) > SYNC.seekDrift && at - lastSeek > SYNC.seekGapMs) {
      seek(target + lead * speed, at);
      landing = {at};
      if (!player.playing && at - lastPlay > SYNC.playGapMs) { player.play(); lastPlay = at; }
      return 'catching';
    }
    // Does the player take a speed it doesn't list? The answer to the last one asked for, once it had time to stick.
    if (probe && custom === null) {
      if (Math.abs(player.rate - probe.rate) < EPS) custom = true;
      else if (at - probe.at > SYNC.rateGapMs * 2) custom = false;
    }
    let wanted;
    if (custom === true) {
      // Any speed: steered (at most SYNC.steer either way) until it is on time again.
      wanted = Math.abs(drift) > SYNC.dither / 2 ? speed * (1 - Math.max(-SYNC.steer, Math.min(SYNC.steer, drift / 2))) : speed;
    } else if (exactRate(speed, player.rates) !== null || custom === null) {
      wanted = speed;
    } else {
      wanted = rateFor(speed, player.rates, {current: player.rate, drift});
    }
    const probing = custom === null && probe !== null;   // asked once: wait for the answer before asking again
    if (!probing && Math.abs(player.rate - wanted) > EPS && at - lastRate > SYNC.rateGapMs) {
      player.setRate(wanted);
      lastRate = at;
      if (custom === null && exactRate(wanted, player.rates) === null) probe = {rate: wanted, at};
    }
    if (!player.playing && !player.buffering && at - lastPlay > SYNC.playGapMs) { player.play(); lastPlay = at; }
    return at - lastSeek < SYNC.seekGapMs ? 'catching' : 'synced';
  }

  return {
    tick,
    reset() { lastSeek = lastRate = lastPlay = -Infinity; landing = null; },
    get lead() { return lead; },
  };
}
