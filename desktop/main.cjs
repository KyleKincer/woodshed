const { app, BrowserWindow, ipcMain, shell, utilityProcess, dialog, Menu, powerMonitor } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { autoUpdater } = require('electron-updater');
const { publicUpdateState } = require('./update-policy.cjs');
const { createUpdateController } = require('./update-controller.cjs');
const {createMediaProxy}=require('./media-proxy.cjs');
const smokeTest = process.argv.includes('--smoke-test');
const UI_ORIGIN = smokeTest ? 'http://127.0.0.1:47833' : 'http://127.0.0.1:47832';
const mediaProxy=createMediaProxy({origin:UI_ORIGIN});
if(smokeTest)app.setPath('userData',fs.mkdtempSync(path.join(app.getPath('temp'),'woodshed-smoke-')));
let window, webServer, companion, companionInfo, closing = false, updates;
let updateState = publicUpdateState('idle');
const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'build');
const webRoot = path.join(__dirname, '..', 'dist');
const companionEntry = app.isPackaged ? path.join(process.resourcesPath, 'companion', 'server.mjs') : path.join(resources, 'companion', 'server.mjs');
function trusted(event) { return event.senderFrame === window?.webContents.mainFrame && new URL(event.senderFrame.url).origin === UI_ORIGIN; }
function emit(status, info) { updateState = publicUpdateState(status, info); window?.webContents.send('desktop:update-state', updateState); }
async function localStatus() {
  if (!companionInfo) return {busy:false};
  const response = await fetch(`http://127.0.0.1:${companionInfo.port}/status`, {headers:{Origin:UI_ORIGIN,Authorization:`Bearer ${companionInfo.token}`},signal:AbortSignal.timeout(3000)});
  if (!response.ok) throw new Error('Processing status unavailable.');
  return response.json();
}
function startWeb() {
  webServer = http.createServer((req,res) => {
    if(req.headers.host !== new URL(UI_ORIGIN).host) { res.writeHead(403);res.end();return; }
    const url=new URL(req.url,UI_ORIGIN);
    if(url.pathname.startsWith('/media/')){void mediaProxy.serve(req,res);return;}
    if(url.pathname === '/oauth/callback') {
      window?.loadURL(UI_ORIGIN+'/?'+url.searchParams.toString());window?.show();window?.focus();
      res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'"});
      res.end('<html><title>Return to Woodshed</title><body style="font:18px system-ui;background:#0e0f13;color:#e6e8ee;padding:60px"><h1>Return to Woodshed</h1><p>Finish signing in in the desktop app. You can close this tab.</p></body></html>');return;
    }
    try {
    const relative = url.pathname.startsWith('/assets/') ? decodeURIComponent(url.pathname.slice(1)) : 'index.html';
    const file=path.resolve(webRoot,relative);
    if (!file.startsWith(webRoot+path.sep)) {res.writeHead(403);res.end();return;}
      const data=fs.readFileSync(file);
      const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml'};
      res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* https://*.convex.cloud wss://*.convex.cloud https://*.convex.site https://*.r2.cloudflarestorage.com; img-src 'self' data: blob: https:; media-src 'self' blob: https:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'"});res.end(data);
    }catch{res.writeHead(404);res.end('Not found');}
  });
  return new Promise((resolve,reject)=>{webServer.once('error',reject);webServer.listen(Number(new URL(UI_ORIGIN).port),'127.0.0.1',resolve);});
}
function startCompanion() {
  return new Promise((resolve,reject)=>{
    const processor=path.join(resources,'processor','woodshed-processor',process.platform==='win32'?'woodshed-processor.exe':'woodshed-processor');
    companion=utilityProcess.fork(companionEntry,[],{env:{...process.env,WOODSHED_WEB_URL:UI_ORIGIN,WOODSHED_COMPANION_PORT:'0',WOODSHED_DATA_DIR:path.join(app.getPath('userData'),'library'),WOODSHED_PROCESSOR:processor,SSL_CERT_FILE:process.env.SSL_CERT_FILE||path.join(resources,'processor','woodshed-processor','_internal','certifi','cacert.pem'),PATH:path.join(resources,'bin')+path.delimiter+process.env.PATH,TORCH_HOME:path.join(app.getPath('userData'),'models'),MPLCONFIGDIR:path.join(app.getPath('userData'),'matplotlib')},stdio:'pipe'});
    const timer=setTimeout(()=>reject(new Error('Local processor did not start.')),20000);
    companion.once('message', info=>{clearTimeout(timer);companionInfo=info;resolve(info);});
    companion.on('exit',code=>{clearTimeout(timer);companionInfo=null;if(!closing)emit('error',{message:'Local processor stopped. Restart Woodshed to reconnect.'});if(code)reject(new Error('Local processor exited.'));});
    companion.stderr?.on('data',data=>console.error(String(data)));
  });
}
async function stopCompanion(forUpdate = false){
  if(!companion)return;
  const child=companion;companion=null;
  await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve();},2500);child.once('exit',()=>{clearTimeout(timer);resolve();});child.postMessage({type:'shutdown',forUpdate});});
}
async function quiesceCompanion() {
  if (!companion) return {busy:false};
  const child = companion;
  return new Promise(resolve => {
    const listener = message => { if (message.type === 'quiesced') {clearTimeout(timer);child.off('message',listener);resolve(message);} };
    const timer = setTimeout(() => {child.off('message',listener);resolve({busy:true});},3000);
    child.on('message',listener);child.postMessage({type:'quiesce'});
  });
}
function setupUpdates() {
  updates = createUpdateController({updater:autoUpdater,publish:next=>{updateState=next;window?.webContents.send('desktop:update-state',next);},
    showDialog:options=>dialog.showMessageBox(window,options),quiesce:quiesceCompanion,resume:()=>companion?.postMessage({type:'resume'}),
    install:async()=>{closing=true;await stopCompanion(true);autoUpdater.quitAndInstall(false,true);},
    isFocused:()=>window?.isFocused(),version:app.getVersion(),packaged:app.isPackaged});
  window.on('focus',()=>void updates.focus());
  powerMonitor.on('resume',()=>updates.wake());
}
ipcMain.handle('desktop:media-url',(event,url)=>{if(!trusted(event))throw Error('Untrusted window');return mediaProxy.register(url);});
ipcMain.handle('desktop:info',event=>{
  if(!trusted(event))throw new Error('Untrusted window');
  return {version:app.getVersion(),companion:companionInfo,update:updateState};
});
ipcMain.handle('desktop:update',async(event,action)=>{
  if(!trusted(event))throw new Error('Untrusted window');
  if(action !== 'show')throw new Error('Unknown update action');
  await updates.show();
  return updates.getState();
});
if(!app.requestSingleInstanceLock()){app.quit();}else{
  app.on('second-instance',()=>{window?.show();window?.focus();});
  app.whenReady().then(async()=>{
    await startWeb();await startCompanion();
    window=new BrowserWindow({icon:path.join(__dirname,'icon.png'),width:1280,height:850,minWidth:640,minHeight:480,backgroundColor:'#0e0f13',show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    const openExternal=url=>{try{const parsed=new URL(url);if(parsed.protocol==='https:')shell.openExternal(url);}catch{}};
    window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==UI_ORIGIN){event.preventDefault();openExternal(url);}});
    window.webContents.setWindowOpenHandler(({url})=>{openExternal(url);return {action:'deny'};});
    window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    window.once('ready-to-show',()=>window.show());
    window.on('close',async event=>{
      if(closing)return;
      event.preventDefault();
      try{const status=await localStatus();if(status.busy){const result=await dialog.showMessageBox(window,{type:'question',buttons:['Keep processing','Quit Woodshed'],defaultId:0,cancelId:0,message:'A song is still processing',detail:'Quitting stops this job. Completed local stages can resume when you reopen Woodshed.'});if(result.response===0)return;}}catch{}
      closing=true;app.quit();
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Woodshed',submenu:[{label:'Check for Updates…',click:()=>window?.webContents.send('desktop:open-updates')},{role:'quit'}]},{role:'editMenu'},{role:'viewMenu'}]));
    setupUpdates();await window.loadURL(UI_ORIGIN);
    if(process.argv.includes('--smoke-test')){
      const info=await localStatus();
      const page=await window.webContents.executeJavaScript(`({title:document.title,bridge:!!window.woodshedDesktop,header:!!document.querySelector('#app-header'),sidebar:!!document.querySelector('#sidebar')})`);
      if(!page.bridge||!page.header||page.sidebar)throw Error('Desktop UI smoke check failed');
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
  }).catch(error=>{if(smokeTest){console.error(error);app.exit(1);return;}dialog.showErrorBox('Woodshed could not start',error.message);closing=true;app.quit();});
  app.on('before-quit',event=>{if(!closing&&window&&!window.isDestroyed()){event.preventDefault();window.close();return;}closing=true;webServer?.close();if(companion){event.preventDefault();stopCompanion().finally(()=>app.quit());}});
  app.on('window-all-closed',()=>app.quit());
}
