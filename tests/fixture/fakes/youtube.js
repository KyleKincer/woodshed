// A YouTube player for the fixture (the real one needs the network): src/stage/video-panel.js uses
// window.__woodshedVideoPlayer when it exists. It draws a dark frame with the video id and its time, runs its clock
// at its speed while playing, buffers SEEK_MS after a seek made while playing, and offers YouTube's fixed speeds.
//   fx-video=blocked   every video fails with YouTube's error 150 (the owner refuses embedding)
// Controls (window.fixture.youtube): players() [{videoId, time(), playing, rate, seeks}].
export const SEEK_MS = 250;
const STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export function installYouTube(win, switches = {}) {
  const players = [];
  win.__woodshedVideoPlayer = (host, {videoId}) => {
    const doc = host.ownerDocument;
    const el = doc.createElement('div');
    el.className = 'fx-video';
    el.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;background:#1d2421;color:#e8e4da;font:600 15px/1.4 system-ui;text-align:center';
    host.append(el);
    const now = () => win.performance.now();
    const state = {t: 0, at: now(), mode: 'paused', rate: 1, until: 0};
    const time = () => (state.mode === 'playing' ? state.t + (now() - state.at) / 1000 * state.rate : state.t);
    const settle = () => { if (state.mode === 'buffering' && now() >= state.until) { state.t = state.t; state.at = now(); state.mode = 'playing'; } };
    const player = {
      videoId, el, seeks: [], volume: 0,
      ready: false, rates: STEPS, duration: 360,
      error: switches.video === 'blocked' ? 150 : null,
      get playing() { settle(); return state.mode === 'playing'; },
      get buffering() { settle(); return state.mode === 'buffering'; },
      get rate() { return state.rate; },
      time() { settle(); return time(); },
      play() { settle(); if (state.mode === 'paused') { state.at = now(); state.mode = 'playing'; } },
      pause() { state.t = time(); state.at = now(); state.mode = 'paused'; },
      seek(t) {
        const was = state.mode !== 'paused';
        state.t = Math.max(0, t); state.at = now(); player.seeks.push(t);
        if (was) { state.mode = 'buffering'; state.until = now() + SEEK_MS; }
      },
      setRate(r) { state.t = time(); state.at = now(); state.rate = r; },
      setVolume(v) { player.volume = v; },
      destroy() { clearInterval(paint); el.remove(); players.splice(players.indexOf(player), 1); },
    };
    const paint = setInterval(() => {
      const t = player.time();
      el.textContent = `▶ ${videoId}\n${Math.floor(t / 60)}:${String((t % 60).toFixed(1)).padStart(4, '0')} · ${state.mode} · ${state.rate}×`;
      el.style.whiteSpace = 'pre-line';
    }, 100);
    setTimeout(() => { player.ready = true; }, 50);
    players.push(player);
    return player;
  };
  return {players: () => players.map(p => ({videoId: p.videoId, time: p.time(), playing: p.playing, rate: p.rate, seeks: [...p.seeks]}))};
}
