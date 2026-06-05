'use strict';

const { app, BrowserWindow, ipcMain, protocol, shell, net, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
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

function runQuiet(bin, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args);
    let err = '';
    c.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} exited ${code}\n${err}`))));
  });
}

function runCapture(bin, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args);
    let out = '', err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err = (err + d).slice(-3000)));
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(bin)} exited ${code}\n${err}`))));
  });
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

  if (process.env.WOODSHED_SHOT) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        await wait(1800);
        await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-id]')?.click(); true;`);
        await wait(3500);
        const img = await mainWindow.webContents.capturePage();
        require('fs').writeFileSync(process.env.WOODSHED_SHOT, img.toPNG());
        console.log('SHOT saved to', process.env.WOODSHED_SHOT);
      } catch (e) { console.log('SHOT error', e.message); }
    });
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
  ipcMain.handle('library:saveTempo', (_e, { id, tempo }) => store.updateSong(id, { tempo }));
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

  // Re-run separation on an existing song (optionally with new settings),
  // updating it in place.
  ipcMain.handle('process:reprocess', (_e, { songId, settings }) => {
    const song = store.getLibrary().songs.find((s) => s.id === songId);
    if (!song) return { error: 'Song not found' };
    const source = song.source || (song.url ? classifyInput(song.url) : null);
    if (!source) return { error: 'This song has no re-processable source.' };
    const jobId = `${Date.now()}_${jobCounter++}`;
    processor.enqueue({
      jobId, source, replaceId: songId,
      label: `${song.title} (reprocess)`,
      settings, addedAt: song.addedAt,
    });
    return { jobId };
  });

  // Auto-detect beats/downbeats with BeatNet (provisions its env on first use).
  ipcMain.handle('metro:detect', async (_e, songId) => {
    const song = store.getLibrary().songs.find((s) => s.id === songId);
    if (!song) return { error: 'Song not found' };
    const onLog = (line) => emit('runtime:log', { line });
    const progress = (stage, message) => emit('metro:detectProgress', { songId, stage, message });
    let mix = null;
    try {
      progress('setup', 'Preparing the beat detector…');
      const py = await runtime.ensureBeatnet(onLog);

      progress('mix', 'Building a mix from the stems…');
      const ffmpeg = runtime.resolveTool('ffmpeg');
      if (!ffmpeg) throw new Error('ffmpeg is not available.');
      const songDir = store.songDir(songId);
      mix = path.join(os.tmpdir(), `woodshed-mix-${songId}.wav`);
      const inputs = song.stems.flatMap((s) => ['-i', path.join(songDir, s.file)]);
      await runQuiet(ffmpeg, ['-y', ...inputs, '-filter_complex', `amix=inputs=${song.stems.length}:normalize=0`, mix]);

      progress('detect', 'Detecting beats…');
      const script = path.join(__dirname, 'lib', 'beatnet_detect.py');
      const out = await runCapture(py, [script, mix]);
      const line = out.split('\n').find((l) => l.startsWith('BEATS_JSON'));
      if (!line) throw new Error('Beat detection produced no output.');
      const { beats } = JSON.parse(line.slice('BEATS_JSON'.length));
      return { beats };
    } catch (e) {
      return { error: String(e.message || e) };
    } finally {
      if (mix) { try { fs.rmSync(mix, { force: true }); } catch {} }
    }
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
