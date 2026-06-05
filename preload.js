'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Whitelisted event channels the renderer may subscribe to.
const EVENTS = ['process:queued', 'process:progress', 'process:done', 'process:error', 'process:canceled', 'runtime:log'];

contextBridge.exposeInMainWorld('api', {
  runtimeStatus: () => ipcRenderer.invoke('runtime:status'),
  provisionRuntime: () => ipcRenderer.invoke('runtime:provision'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),

  listLibrary: () => ipcRenderer.invoke('library:list'),
  renameSong: (id, title) => ipcRenderer.invoke('library:rename', { id, title }),
  deleteSong: (id) => ipcRenderer.invoke('library:delete', id),
  openExternal: (url) => ipcRenderer.invoke('library:openExternal', url),

  addSong: (input, settings) => ipcRenderer.invoke('process:add', { input, settings }),
  addFiles: (paths, settings) => ipcRenderer.invoke('process:addFiles', { paths, settings }),
  reprocessSong: (songId, settings) => ipcRenderer.invoke('process:reprocess', { songId, settings }),
  cancelJob: (jobId) => ipcRenderer.invoke('process:cancel', jobId),
  pickAudio: () => ipcRenderer.invoke('dialog:pickAudio'),
  // Resolve the absolute path of a dropped File (Electron's File.path replacement).
  pathForFile: (file) => webUtils.getPathForFile(file),

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
