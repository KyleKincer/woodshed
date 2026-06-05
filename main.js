'use strict';

const { app, BrowserWindow, ipcMain, protocol, shell, net, dialog } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { Store } = require('./lib/store');
const { Runtime } = require('./lib/runtime');
const { Processor, classifyInput } = require('./lib/processor');
const { PRESETS, MODELS, STEM_MODES, DEFAULT_PRESET } = require('./lib/presets');

let store;
let runtime;
let processor;
let mainWindow;
let jobCounter = 0;
let provisioning = false;

// Serve library audio/art through a custom scheme so the renderer can fetch it
// without nodeIntegration. URLs look like: wsmedia://stems/<songId>/<file>
protocol.registerSchemesAsPrivileged([
  { scheme: 'wsmedia', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0e0f13',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  if (process.env.WOODSHED_DIAG) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, src) => {
      console.log(`[renderer:${level}] ${message} (${src}:${line})`);
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.log(`[did-fail-load] ${code} ${desc} ${url}`);
    });
    mainWindow.webContents.on('render-process-gone', (_e, d) => console.log('[render-gone]', JSON.stringify(d)));
  }
}

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  runtime = new Runtime(app.getPath('userData'));
  processor = new Processor(store, emit, runtime);

  // Custom protocol handler — resolves only within the media dir (no traversal).
  protocol.handle('wsmedia', (request) => {
    try {
      const url = new URL(request.url);
      // host is ignored; pathname carries <songId>/<file>
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const target = path.normalize(path.join(store.mediaDir, rel));
      if (!target.startsWith(store.mediaDir)) {
        return new Response('Forbidden', { status: 403 });
      }
      return net.fetch(pathToFileURL(target).toString());
    } catch (e) {
      return new Response('Bad request', { status: 400 });
    }
  });

  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function registerIpc() {
  ipcMain.handle('runtime:status', () => runtime.status());

  ipcMain.handle('runtime:provision', async () => {
    if (provisioning) return { alreadyRunning: true };
    provisioning = true;
    try {
      const onLog = (line) => emit('runtime:log', { line });
      await runtime.provision(onLog);
      return { ok: true, status: runtime.status() };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    } finally {
      provisioning = false;
    }
  });

  ipcMain.handle('config:get', () => ({
    settings: store.getSettings(),
    presets: PRESETS,
    defaultPreset: DEFAULT_PRESET,
    models: MODELS,
    stemModes: STEM_MODES,
  }));

  ipcMain.handle('settings:save', (_e, settings) => store.saveSettings(settings));

  ipcMain.handle('library:list', () => store.getLibrary());
  ipcMain.handle('library:rename', (_e, { id, title }) => store.updateSong(id, { title }));
  ipcMain.handle('library:delete', (_e, id) => store.deleteSong(id));
  ipcMain.handle('library:openExternal', (_e, url) => shell.openExternal(url));

  // Add from a text input — URL (any yt-dlp site), Spotify link, or search text.
  ipcMain.handle('process:add', (_e, { input, settings }) => {
    const source = classifyInput(input);
    const jobId = `${Date.now()}_${jobCounter++}`;
    processor.enqueue({ jobId, source, label: input, settings, addedAt: Date.now() });
    return { jobId };
  });

  // Add one or more local audio files.
  ipcMain.handle('process:addFiles', (_e, { paths, settings }) => {
    const jobIds = [];
    for (const p of paths) {
      const jobId = `${Date.now()}_${jobCounter++}`;
      processor.enqueue({
        jobId,
        source: { type: 'file', value: p },
        label: path.basename(p),
        settings,
        addedAt: Date.now(),
      });
      jobIds.push(jobId);
    }
    return { jobIds };
  });

  ipcMain.handle('process:cancel', (_e, jobId) => processor.cancel(jobId));

  ipcMain.handle('dialog:pickAudio', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose audio files',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'aif', 'aiff', 'wma'] }],
    });
    return res.canceled ? [] : res.filePaths;
  });
}
