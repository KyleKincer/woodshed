'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Whitelisted event channels the renderer may subscribe to.
const EVENTS = ['process:queued', 'process:progress', 'process:done', 'process:error'];

contextBridge.exposeInMainWorld('api', {
  checkDeps: () => ipcRenderer.invoke('deps:check'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),

  listLibrary: () => ipcRenderer.invoke('library:list'),
  renameSong: (id, title) => ipcRenderer.invoke('library:rename', { id, title }),
  deleteSong: (id) => ipcRenderer.invoke('library:delete', id),
  openExternal: (url) => ipcRenderer.invoke('library:openExternal', url),

  addSong: (url, settings) => ipcRenderer.invoke('process:add', { url, settings }),

  // Returns an unsubscribe function.
  on: (channel, cb) => {
    if (!EVENTS.includes(channel)) throw new Error(`Unknown channel: ${channel}`);
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  // Build a media URL for a song stem/cover.
  mediaUrl: (songId, file) => `wsmedia://local/${encodeURIComponent(songId)}/${encodeURIComponent(file)}`,
});
