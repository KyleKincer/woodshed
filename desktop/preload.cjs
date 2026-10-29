'use strict';
// The renderer bridge, window.woodshedDesktop (architecture §2.20,
// maps/companion-desktop.md §16.11). Sandboxed preload: it may require only
// 'electron', so it is self-contained. Every on* returns an unsubscribe.
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, map) {
  return callback => {
    if (typeof callback !== 'function') throw new TypeError('Expected a callback');
    const listener = (_event, payload) => callback(map(payload));
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

// Flush: one listener for the process. Main sends desktop:flush {id}; every
// registered callback runs (pending saves), then desktop:flushed {id} answers,
// at once when nothing is registered.
const flushers = new Set();
ipcRenderer.on('desktop:flush', async (_event, request) => {
  const id = request && typeof request.id === 'string' ? request.id : null;
  await Promise.allSettled([...flushers].map(fn => {
    try {
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error);
    }
  }));
  ipcRenderer.send('desktop:flushed', { id });
});

function activity(payload) {
  const out = {};
  for (const key of ['playing', 'songOpen', 'keepAwake']) {
    if (payload && typeof payload[key] === 'boolean') out[key] = payload[key];
  }
  return out;
}

contextBridge.exposeInMainWorld('woodshedDesktop', Object.freeze({
  info: () => ipcRenderer.invoke('desktop:info'),
  update: action => ipcRenderer.invoke('desktop:update', action),
  onUpdate: subscribe('desktop:update-state', state => state),
  onOpenUpdates: subscribe('desktop:open-updates', () => undefined),
  setTheme: theme => ipcRenderer.invoke('desktop:theme', theme),
  mediaUrl: url => ipcRenderer.invoke('desktop:media-url', url),
  onProcessorState: subscribe('desktop:processor-state', state => state),
  restartProcessor: () => ipcRenderer.invoke('desktop:restart-processor'),
  registerMenu: spec => ipcRenderer.send('desktop:menu', spec),
  onCommand: subscribe('desktop:command', payload => ({ id: payload?.id, source: payload?.source })),
  setActivity: payload => ipcRenderer.send('desktop:activity', activity(payload)),
  setBackgroundShortcuts: (enabled, options) => ipcRenderer.invoke('desktop:global-shortcuts', enabled === true,
    { promptAccessibility: options?.promptAccessibility === true }),
  notify: payload => ipcRenderer.invoke('desktop:notify', payload),
  onNavigate: subscribe('desktop:navigate', route => route),
  onFlushRequest: callback => {
    if (typeof callback !== 'function') throw new TypeError('Expected a callback');
    flushers.add(callback);
    return () => {
      flushers.delete(callback);
    };
  },
  onFullScreen: subscribe('desktop:fullscreen', payload => payload?.on === true),
}));
