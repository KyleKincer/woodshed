const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('woodshedDesktop', Object.freeze({
  onOpenUpdates: callback => { const listener = () => callback(); ipcRenderer.on('desktop:open-updates', listener); return () => ipcRenderer.removeListener('desktop:open-updates', listener); },
  info: () => ipcRenderer.invoke('desktop:info'),
  update: action => ipcRenderer.invoke('desktop:update', action),
  setPlaying: playing => ipcRenderer.send('desktop:playing', Boolean(playing)),
  onUpdate: callback => { const listener = (_event, state) => callback(state); ipcRenderer.on('desktop:update-state', listener); return () => ipcRenderer.removeListener('desktop:update-state', listener); },
}));
