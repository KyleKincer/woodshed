'use strict';
// Electron main: wiring only (architecture §6.11). Every behaviour lives in a
// factored module that takes the Electron APIs as arguments and is tested with
// fakes under node --test:
//   static-server.cjs  UI server, exists-or-index serving (D9)
//   ipc-handlers.cjs   every desktop:* handler, the companion host, background shortcuts
//   menu.cjs           the registry-driven application menu (§2.20)
//   window-state.cjs   window size and position memory, full-screen events
//   permissions.cjs    the permission allow-list and navigation guards
//   flush.cjs          renderer flush, the quit guard, the update install order
//   update-controller.cjs  update checks and prompts (deferred while playing)
const {
  app, BrowserWindow, ipcMain, shell, utilityProcess, dialog, Menu, powerMonitor, powerSaveBlocker,
  globalShortcut, Notification, systemPreferences, nativeTheme,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { autoUpdater } = require('electron-updater');
const { createUpdateController } = require('./update-controller.cjs');
const { createMediaProxy } = require('./media-proxy.cjs');
const { createStaticHandler, createUiServer, listen } = require('./static-server.cjs');
const { installPermissions, installNavigationGuards } = require('./permissions.cjs');
const { createMenuController } = require('./menu.cjs');
const { createWindowState, watchFullScreen } = require('./window-state.cjs');
const { requestFlush, createQuitGuard, installUpdate } = require('./flush.cjs');
const {
  createHandlers, createTrust, createCompanionHost, createDesktopPrefs, companionEnv, deviceName,
} = require('./ipc-handlers.cjs');

const APP_USER_MODEL_ID = 'com.kylekincer.woodshed';
const smokeTest = process.argv.includes('--smoke-test');
const UI_ORIGIN = smokeTest ? 'http://127.0.0.1:47833' : 'http://127.0.0.1:47832';
if (smokeTest) app.setPath('userData', fs.mkdtempSync(path.join(app.getPath('temp'), 'woodshed-smoke-')));

const isMac = process.platform === 'darwin';
const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'build');
const webRoot = path.join(__dirname, '..', 'dist');
const userData = app.getPath('userData');
const themeFile = path.join(userData, 'appearance.json');

let window = null;
let webServer = null;
let updates = null;
let handlers = null;
let closing = false;
const getWindow = () => (window && !window.isDestroyed() ? window : null);
const sendToWindow = (channel, payload) => getWindow()?.webContents.send(channel, payload);
const trusted = createTrust({ getWindow, uiOrigin: UI_ORIGIN });
const showDialog = options => {
  const win = getWindow();
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
};
const flush = () => requestFlush(getWindow()?.webContents, { trusted });

try {
  const saved = JSON.parse(fs.readFileSync(themeFile, 'utf8'));
  if (['system', 'light', 'dark'].includes(saved.theme)) nativeTheme.themeSource = saved.theme;
} catch {
  // No saved appearance yet.
}
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#171c1b' : '#f8f7f1');
nativeTheme.on('updated', () => getWindow()?.setBackgroundColor(windowBackground()));

const mediaProxy = createMediaProxy({ origin: UI_ORIGIN });
const prefs = createDesktopPrefs({ file: path.join(userData, 'desktop-prefs.json') });
const companion = createCompanionHost({
  fork: (entry, args, options) => utilityProcess.fork(entry, args, options),
  entry: path.join(resources, 'companion', 'server.mjs'),
  env: companionEnv({ uiOrigin: UI_ORIGIN, userData, resources, appVersion: app.getVersion(), name: deviceName() }),
  origin: UI_ORIGIN,
  onState: state => sendToWindow('desktop:processor-state', state),
});
const menu = createMenuController({
  Menu,
  isMac,
  isPackaged: app.isPackaged,
  appName: 'Woodshed',
  send: id => sendToWindow('desktop:command', { id, source: 'menu' }),
  openUpdates: () => sendToWindow('desktop:open-updates'),
  openLicenses: () => void shell.openPath(path.join(resources, 'THIRD-PARTY-NOTICES.txt')),
});

function setupUpdates() {
  updates = createUpdateController({
    updater: autoUpdater,
    publish: state => sendToWindow('desktop:update-state', state),
    showDialog,
    quiesce: () => companion.quiesce(),
    resume: () => companion.resume(),
    install: () => installUpdate({
      markClosing: () => { closing = true; },
      flush,
      stopCompanion: () => companion.stop(),
      quitAndInstall: () => autoUpdater.quitAndInstall(false, true),
    }),
    isFocused: () => getWindow()?.isFocused() === true,
    version: app.getVersion(),
    packaged: app.isPackaged,
  });
  powerMonitor.on('resume', () => updates.wake());
}

function createWindow(windowState) {
  const restored = windowState.load();
  window = new BrowserWindow({
    icon: path.join(__dirname, 'icon.png'),
    ...restored.options,
    backgroundColor: windowBackground(),
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Saved before the quit guard's close listener runs.
  windowState.track(window);
  watchFullScreen(window, sendToWindow);
  installNavigationGuards(window.webContents, { uiOrigin: UI_ORIGIN, shell });
  installPermissions(window.webContents.session, { uiOrigin: UI_ORIGIN });
  window.once('ready-to-show', () => {
    window.show();
    windowState.applyAfterShow(window, restored);
  });
  window.on('focus', () => void updates?.focus());
  window.on('close', createQuitGuard({
    isClosing: () => closing,
    localStatus: () => companion.status(),
    showDialog,
    flush,
    quit: () => { closing = true; app.quit(); },
  }));
  window.on('closed', () => { window = null; });
  window.webContents.on('render-process-gone', () => handlers?.resetActivity());
  window.webContents.on('did-navigate', () => handlers?.resetActivity());
}

async function runSmokeTest() {
  // The DOM assertions move to the new shell in integration I1 (§6.11 item 12).
  if (!companion.info()) throw Error('Local processor did not start');
  const info=await companion.status();
  const page=await window.webContents.executeJavaScript(`({title:document.title,bridge:!!window.woodshedDesktop,header:!!document.querySelector('#app-header'),sidebar:!!document.querySelector('#sidebar')})`);
  if(!page.bridge||!page.header||page.sidebar)throw Error('Desktop UI smoke check failed');
  const appearance = await window.webContents.executeJavaScript(`(async () => {
    if(!window.woodshedAppearance)throw Error('Appearance bootstrap missing');
    // apply() paints without persisting (theme-init.js, §2.5); setTheme drives nativeTheme.
    for(const theme of ['dark','light']) {
      window.woodshedAppearance.apply({theme});
      await window.woodshedDesktop.setTheme(theme);
      if(document.documentElement.dataset.theme!==theme || getComputedStyle(document.body).colorScheme!==theme)throw Error('Theme did not apply: '+theme);
    }
    window.woodshedAppearance.apply({theme:'system'});
    await window.woodshedDesktop.setTheme('system');
    return document.documentElement.dataset.theme;
  })()`);
  if(nativeTheme.themeSource!=='system')throw Error('Native appearance did not return to system');
  console.log(JSON.stringify({appearanceSmoke:appearance}));
  // Exercise the separately bundled Guitar Pro parser under Chromium's
  // real CSP. This tiny artificial GP3 fixture is alphaTab's strings test:
  // v1.8.4, MPL-2.0; source and license are in the bundled alphaTab notice.
  const guitarProFile = fs.readdirSync(path.join(webRoot,'assets')).find(name=>/^guitar-pro-import-.*\.js$/.test(name));
  if (!guitarProFile) throw Error('Guitar Pro importer missing from desktop bundle');
  const guitarPro = await window.webContents.executeJavaScript(`(async () => {
    const {parseGuitarPro} = await import('/assets/' + ${JSON.stringify(guitarProFile)});
    if(typeof parseGuitarPro!=='function')throw Error('Guitar Pro parser export missing');
    const bytes = Uint8Array.from(atob("GEZJQ0hJRVIgR1VJVEFSIFBSTyB2My4wMAAAAAAAAAEAAAAAAQAAAAABAAAAAAEAAAAAAQAAAAABAAAAAAEAAAAAAQAAAAABAAAAAQAAAAAAeAAAAAAAAAAZAAAADQgAAAAAAAAZAAAADQgAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAAAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAAYAAAAAQEAAAAAAAABAAAAAQAAAAMEBAAGU3B1ciAxAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAABAAAAAOwAAADcAAAAyAAAALQAAACgAAAAAAAAAAQAAAAEAAAACAAAAGAAAAAAAAAD/AAAAAgAAAAAAfjABBgEwAQYCMAEGAzABBgQwAQYFMAEGBkEC/wA="), value=>value.charCodeAt(0));
    const result = parseGuitarPro(bytes, {duration:4});
    if(result.format!=='guitar-pro' || result.map.version!==1 || result.map.tailQpm!==120 || !result.map.pins.length || result.map.pins.some(pin=>!Number.isFinite(pin.time)) || result.map.measures[0].numerator!==4 || result.drums)throw Error('Guitar Pro playback map smoke failed');
    return {format:result.format, bars:result.map.measures.length, tempo:result.map.tailQpm};
  })()`);
  console.log(JSON.stringify({guitarProSmoke:guitarPro}));
  // Check the packaged module, MIME type, CSP, WASM compilation and actual
  // audio output in Chromium on every release platform.
  const stretchFile = fs.readdirSync(path.join(webRoot,'assets')).find(name=>/^SignalsmithStretch-.*\.mjs$/.test(name));
  if (!stretchFile) throw Error('Pitch worklet missing from desktop bundle');
  const audio = await window.webContents.executeJavaScript(`(async () => {
    const url = '/assets/' + ${JSON.stringify(stretchFile)};
    const {default: Stretch} = await import(url);
    Stretch.moduleUrl = url;
    // Offline rendering verifies PCM without depending on a CI runner's
    // physical audio device on CI runners.
    const ctx = new OfflineAudioContext(2, 96000, 48000);
    const source = await Stretch(ctx, {numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[6],channelCount:6,channelCountMode:'explicit',channelInterpretation:'discrete'});
    const tone = Float32Array.from({length:ctx.sampleRate*3},(_,i)=>Math.sin(2*Math.PI*440*i/ctx.sampleRate)*0.2);
    const inverted = Float32Array.from(tone,v=>-v);
    await source.addBuffers([tone,tone,inverted,inverted,tone,tone]);
    const splitter = ctx.createChannelSplitter(6), merger = ctx.createChannelMerger(2);
    source.connect(splitter);
    for(let channel=0;channel<6;channel++)splitter.connect(merger,channel,channel%2);
    merger.connect(ctx.destination);
    await source.schedule({active:true,input:0,output:ctx.currentTime+0.15,rate:0.75,semitones:0});
    const rendered = await ctx.startRendering();
    const samples = rendered.getChannelData(0).subarray(48000);
    let energy=0, crossings=0;
    samples.forEach((v,i)=>{energy+=v*v;if(i && samples[i-1]<=0 && v>0)crossings++;});
    const rms = Math.sqrt(energy/samples.length), hz = crossings*ctx.sampleRate/samples.length;
    if(rms<0.05 || Math.abs(hz-440)>8)throw Error('Pitch playback smoke failed: '+JSON.stringify({rms,hz}));
    source.disconnect(); source.port.close();
    return {rms,hz};
  })()`, true);
  console.log(JSON.stringify({audioSmoke:audio}));
  console.log(JSON.stringify({smoke:'passed',page,processorReady:typeof info.busy==='boolean'}));
  if(!process.env.CI)fs.writeFileSync(path.join(app.getPath('temp'),'woodshed-desktop-smoke.png'),(await window.capturePage()).toPNG());
  closing=true;app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { getWindow()?.show(); getWindow()?.focus(); });
  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_USER_MODEL_ID);
    menu.install();
    webServer = createUiServer({
      origin: UI_ORIGIN,
      handleStatic: createStaticHandler({ webRoot }),
      mediaProxy,
      onOAuthCallback: search => {
        const win = getWindow();
        if (!win) return;
        void win.loadURL(`${UI_ORIGIN}/?${search}`);
        win.show();
        win.focus();
      },
    });
    await listen(webServer, UI_ORIGIN);
    // The window opens while the processor starts: the renderer reads phase
    // 'starting' from info() and gets 'ready' or 'stopped' live. A processor
    // that fails (or hangs until the 20 s timeout) leaves phase 'stopped' and
    // the app usable (Restart processor).
    const processorStarted = companion.start().catch(error => console.error(error.message));
    setupUpdates();
    const { screen } = require('electron');
    createWindow(createWindowState({ file: path.join(userData, 'window-state.json'), screen }));
    handlers = createHandlers({
      app, ipcMain, BrowserWindow, powerSaveBlocker, globalShortcut, Notification, systemPreferences, shell,
      getWindow, trusted, updateController: updates, companion, nativeTheme, mediaProxy, menu, prefs, themeFile,
    });
    await window.loadURL(UI_ORIGIN);
    if (smokeTest) {
      await processorStarted;
      await runSmokeTest();
    }
  }).catch(error => {
    if (smokeTest) { console.error(error); app.exit(1); return; }
    dialog.showErrorBox('Woodshed could not start', error.message);
    closing = true;
    app.quit();
  });
  app.on('before-quit', event => {
    if (!closing && getWindow()) { event.preventDefault(); window.close(); return; }
    closing = true;
    webServer?.close();
    if (companion.isRunning()) { event.preventDefault(); companion.stop().finally(() => app.quit()); }
  });
  app.on('window-all-closed', () => app.quit());
}
