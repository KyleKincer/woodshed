// A YouTube player the Stage drives (src/stage/video-panel.js): the privacy-enhanced embed (youtube-nocookie.com),
// muted, without its own controls or captions, steered over postMessage. The panel crops the frame so YouTube's title
// bar and pause overlays fall outside the picture (video.css .stage-video-frame). That is the protocol YouTube's iframe API library
// speaks, so no third-party script runs in the app; the only thing the app's CSP admits is that frame.
//
//   createYouTubePlayer(host, {videoId, origin?, win?, onChange?}) → Player
//   Player = {
//     el                      the <iframe>
//     get ready / playing / rate / duration / rates / error   (error: YouTube's code, e.g. 150 = embedding refused)
//     time()                  the video's time now: its last report, run forward at its rate while it plays
//     play() · pause() · seek(seconds) · setRate(rate) · setVolume(0–100) (0 = muted) · destroy()
//   }
//   Commands sent before the player is ready wait for it; onChange() hears every report.

export const EMBED_ORIGIN = 'https://www.youtube-nocookie.com';
/** How often to say "listening" until the player answers (the widget protocol's handshake). */
const HANDSHAKE_MS = 250;
const PLAYING = 1, BUFFERING = 3;

let seq = 0;

export function embedUrl(videoId, origin) {
  const params = new URLSearchParams({
    enablejsapi: '1', origin, widget_referrer: origin, controls: '0', playsinline: '1', rel: '0', iv_load_policy: '3',
    disablekb: '1', fs: '0', mute: '1', modestbranding: '1', cc_load_policy: '0',
  });
  return `${EMBED_ORIGIN}/embed/${encodeURIComponent(videoId)}?${params}`;
}

export function createYouTubePlayer(host, {videoId, origin = globalThis.location?.origin ?? '', win = globalThis.window, onChange = () => {}} = {}) {
  const id = ++seq;
  const doc = host.ownerDocument;
  const el = doc.createElement('iframe');
  el.className = 'yt-player';
  el.title = 'Playthrough video';
  el.allow = 'autoplay; encrypted-media; picture-in-picture';
  el.referrerPolicy = 'strict-origin-when-cross-origin';
  el.setAttribute('tabindex', '-1');
  el.src = embedUrl(videoId, origin);
  host.append(el);

  const info = {time: 0, at: 0, state: -1, rate: 1, duration: 0, rates: [1], volume: 0};
  let ready = false, error = null, destroyed = false, handshake = null;
  const queue = [];
  const now = () => (win?.performance?.now?.() ?? Date.now());

  function post(message) {
    try { el.contentWindow?.postMessage(JSON.stringify({...message, id, channel: 'widget'}), EMBED_ORIGIN); } catch { /* frame gone */ }
  }
  /** YouTube's automatic captions ("[music]") come back with each new playback: unloaded every time it starts playing. */
  function captionsOff() {
    if (!ready) return;
    post({event: 'command', func: 'unloadModule', args: ['captions']});
    post({event: 'command', func: 'unloadModule', args: ['cc']});
  }
  function command(func, args = []) {
    if (destroyed) return;
    if (!ready) { queue.push([func, args]); return; }
    post({event: 'command', func, args});
  }

  function onMessage(e) {
    if (e.origin !== EMBED_ORIGIN || e.source !== el.contentWindow) return;
    let data;
    try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
    if (!data || typeof data !== 'object') return;
    if (handshake) { clearInterval(handshake); handshake = null; }
    const at = now();
    switch (data.event) {
      case 'onReady':
        ready = true;
        captionsOff();
        for (const [func, args] of queue.splice(0)) post({event: 'command', func, args});
        break;
      case 'initialDelivery':
      case 'infoDelivery': {
        const i = data.info ?? {};
        if (Number.isFinite(i.currentTime)) { info.time = i.currentTime; info.at = at; }
        if (Number.isFinite(i.playerState)) { if (i.playerState === PLAYING && info.state !== PLAYING) captionsOff(); info.state = i.playerState; }
        if (Number.isFinite(i.playbackRate)) info.rate = i.playbackRate;
        if (Number.isFinite(i.duration)) info.duration = i.duration;
        if (Array.isArray(i.availablePlaybackRates) && i.availablePlaybackRates.length) info.rates = i.availablePlaybackRates.filter(Number.isFinite);
        if (Number.isFinite(i.volume)) info.volume = i.volume;
        break;
      }
      case 'onStateChange':
        if (Number.isFinite(data.info)) { if (data.info === PLAYING) captionsOff(); info.time = player.time(); info.at = at; info.state = data.info; }
        break;
      case 'onPlaybackRateChange':
        if (Number.isFinite(data.info)) { info.time = player.time(); info.at = at; info.rate = data.info; }
        break;
      case 'onError':
        error = Number(data.info) || 0;
        break;
      default:
        return;
    }
    onChange(player);
  }
  win?.addEventListener('message', onMessage);
  el.addEventListener('load', () => {
    if (destroyed) return;
    clearInterval(handshake);
    post({event: 'listening'});
    handshake = setInterval(() => post({event: 'listening'}), HANDSHAKE_MS);
  });

  const player = {
    el,
    get ready() { return ready; },
    get playing() { return info.state === PLAYING; },
    get buffering() { return info.state === BUFFERING; },
    get rate() { return info.rate; },
    get duration() { return info.duration; },
    get rates() { return info.rates; },
    get error() { return error; },
    time() {
      return info.state === PLAYING ? info.time + (now() - info.at) / 1000 * info.rate : info.time;
    },
    play() { command('playVideo'); },
    pause() { command('pauseVideo'); },
    seek(seconds) {
      const t = Math.max(0, seconds);
      info.time = t; info.at = now();
      command('seekTo', [t, true]);
    },
    setRate(rate) { command('setPlaybackRate', [rate]); },
    setVolume(volume) {
      const v = Math.max(0, Math.min(100, Math.round(volume)));
      if (v === 0) command('mute'); else { command('unMute'); command('setVolume', [v]); }
    },
    destroy() {
      destroyed = true;
      clearInterval(handshake);
      win?.removeEventListener('message', onMessage);
      el.remove();
    },
  };
  return player;
}
