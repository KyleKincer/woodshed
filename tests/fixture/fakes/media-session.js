// Media Session recorder (architecture §11.2, D13): navigator.mediaSession is
// replaced by an object that records what the page registers. Controls
// (window.fixture.media):
//   press(action, details = {})  call the page's handler, as a headset or lock
//                                screen would; returns false when none is set
//   state()                      {actions, metadata, playbackState, positionState, log}
export const ACTIONS = ['play', 'pause', 'stop', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack', 'skipad', 'togglemicrophone', 'togglecamera', 'hangup', 'previousslide', 'nextslide', 'enterpictureinpicture'];

export function installMediaSession(win) {
  const handlers = new Map(), log = [];
  let metadata = null, playbackState = 'none', positionState = null;
  const snapshot = m => (m ? {title: m.title ?? '', artist: m.artist ?? '', album: m.album ?? '', artwork: [...(m.artwork ?? [])].map(a => ({src: a.src, sizes: a.sizes ?? '', type: a.type ?? ''}))} : null);

  if (typeof win.MediaMetadata !== 'function') {
    win.MediaMetadata = class MediaMetadata {
      constructor(init = {}) { this.title = init.title ?? ''; this.artist = init.artist ?? ''; this.album = init.album ?? ''; this.artwork = init.artwork ?? []; }
    };
  }

  const session = {
    setActionHandler(action, handler) {
      if (!ACTIONS.includes(action)) throw new TypeError(`Failed to execute 'setActionHandler' on 'MediaSession': The provided value '${action}' is not a valid enum value of type MediaSessionAction.`);
      if (handler) handlers.set(action, handler); else handlers.delete(action);
      log.push({type: 'handler', action, set: !!handler});
    },
    setPositionState(state = {}) {
      if (state.duration !== undefined && (!(state.duration >= 0) || (state.position ?? 0) > state.duration)) throw new TypeError('Invalid position state (fixture).');
      positionState = Object.keys(state).length ? {duration: state.duration, position: state.position ?? 0, playbackRate: state.playbackRate ?? 1} : null;
      log.push({type: 'position', state: positionState});
    },
    setMicrophoneActive() {}, setCameraActive() {},
    get metadata() { return metadata; },
    set metadata(value) { metadata = value ?? null; log.push({type: 'metadata', metadata: snapshot(metadata)}); },
    get playbackState() { return playbackState; },
    set playbackState(value) {
      if (!['none', 'paused', 'playing'].includes(value)) return;
      playbackState = value; log.push({type: 'playbackState', value});
    },
  };
  Object.defineProperty(win.navigator, 'mediaSession', {configurable: true, get: () => session});

  return {
    press(action, details = {}) {
      const handler = handlers.get(action);
      log.push({type: 'press', action, handled: !!handler});
      if (!handler) return false;
      handler({action, ...details});
      return true;
    },
    state: () => ({actions: [...handlers.keys()].sort(), metadata: snapshot(metadata), playbackState, positionState, log: structuredClone(log)}),
  };
}
