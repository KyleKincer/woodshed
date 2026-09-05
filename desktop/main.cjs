const { app, BrowserWindow, ipcMain, shell, utilityProcess, dialog, Menu } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { autoUpdater } = require('electron-updater');
const { canRestart, publicUpdateState } = require('./update-policy.cjs');
const smokeTest = process.argv.includes('--smoke-test');
const UI_ORIGIN = smokeTest ? 'http://127.0.0.1:47833' : 'http://127.0.0.1:47832';
if(smokeTest)app.setPath('userData',fs.mkdtempSync(path.join(app.getPath('temp'),'woodshed-smoke-')));
let window, webServer, companion, companionInfo, playing = false, closing = false;
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
      const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'};
      res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* https://*.convex.cloud wss://*.convex.cloud https://*.convex.site https://*.r2.cloudflarestorage.com; img-src 'self' data: blob: https:; media-src 'self' blob: https:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'"});res.end(data);
    }catch{res.writeHead(404);res.end('Not found');}
  });
  return new Promise((resolve,reject)=>{webServer.once('error',reject);webServer.listen(Number(new URL(UI_ORIGIN).port),'127.0.0.1',resolve);});
}
function startCompanion() {
  return new Promise((resolve,reject)=>{
    const processor=path.join(resources,'processor','woodshed-processor',process.platform==='win32'?'woodshed-processor.exe':'woodshed-processor');
    companion=utilityProcess.fork(companionEntry,[],{env:{...process.env,WOODSHED_WEB_URL:UI_ORIGIN,WOODSHED_COMPANION_PORT:'0',WOODSHED_DATA_DIR:path.join(app.getPath('userData'),'library'),WOODSHED_PROCESSOR:processor,PATH:path.join(resources,'bin')+path.delimiter+process.env.PATH,TORCH_HOME:path.join(app.getPath('userData'),'models'),MPLCONFIGDIR:path.join(app.getPath('userData'),'matplotlib')},stdio:'pipe'});
    const timer=setTimeout(()=>reject(new Error('Local processor did not start.')),20000);
    companion.once('message', info=>{clearTimeout(timer);companionInfo=info;resolve(info);});
    companion.on('exit',code=>{clearTimeout(timer);companionInfo=null;if(!closing)emit('error',{message:'Local processor stopped. Restart Woodshed to reconnect.'});if(code)reject(new Error('Local processor exited.'));});
    companion.stderr?.on('data',data=>console.error(String(data)));
  });
}
async function stopCompanion(){
  if(!companion)return;
  const child=companion;companion=null;
  await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve();},2500);child.once('exit',()=>{clearTimeout(timer);resolve();});child.postMessage({type:'shutdown'});});
}
function setupUpdates() {
  autoUpdater.autoDownload=false;
  autoUpdater.autoInstallOnAppQuit=false;
  autoUpdater.allowPrerelease=false;
  autoUpdater.on('checking-for-update',()=>emit('checking'));
  autoUpdater.on('update-available',info=>emit('available',info));
  autoUpdater.on('update-not-available',()=>emit('current',{version:app.getVersion()}));
  autoUpdater.on('download-progress',info=>emit('downloading',{...info,version:updateState.version}));
  autoUpdater.on('update-downloaded',info=>emit('ready',info));
  autoUpdater.on('error',error=>emit('error',{message: error.message.includes('404')?'No published update is available yet.':'Could not check or download the update. Try again later.'}));
  if(app.isPackaged){setTimeout(()=>autoUpdater.checkForUpdates().catch(()=>{}),15000).unref();setInterval(()=>{if(!['downloading','ready'].includes(updateState.status))autoUpdater.checkForUpdates().catch(()=>{});},6*60*60*1000).unref();}
}
ipcMain.handle('desktop:info',event=>{
  if(!trusted(event))throw new Error('Untrusted window');
  return {version:app.getVersion(),companion:companionInfo,update:updateState};
});
ipcMain.on('desktop:playing',(event,value)=>{if(trusted(event))playing=!!value;});
ipcMain.handle('desktop:update',async(event,action)=>{
  if(!trusted(event))throw new Error('Untrusted window');
  if(!app.isPackaged)return {message:'Updates are available in installed builds.'};
  if(action==='check' && !['downloading','ready'].includes(updateState.status))await autoUpdater.checkForUpdates();
  else if(action==='download' && updateState.status==='available'){emit('downloading',{version:updateState.version});await autoUpdater.downloadUpdate();}
  else if(action==='install' && updateState.status==='ready'){
    const status=await localStatus();
    if(!canRestart({playing,processing:status.busy}))throw new Error('Stop playback and wait for processing to finish before updating.');
    const quiesced=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Could not pause the processor. Try again.')),3000);const listener=message=>{if(message.type==='quiesced'){clearTimeout(timeout);companion.off('message',listener);resolve(message);}};companion.on('message',listener);companion.postMessage({type:'quiesce'});});
    if(quiesced.busy)throw new Error('A processing job just started. Wait for it to finish before updating.');
    closing=true;await stopCompanion();autoUpdater.quitAndInstall(false,true);
  }
  return updateState;
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
    Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Woodshed',submenu:[{label:'Check for Updates…',click:()=>{window?.webContents.send('desktop:open-updates');if(app.isPackaged&&!['downloading','ready'].includes(updateState.status))autoUpdater.checkForUpdates().catch(()=>{});}},{role:'quit'}]},{role:'editMenu'},{role:'viewMenu'}]));
    setupUpdates();await window.loadURL(UI_ORIGIN);
    if(process.argv.includes('--smoke-test')){
      const info=await localStatus();
      const page=await window.webContents.executeJavaScript(`({title:document.title,bridge:!!window.woodshedDesktop,header:!!document.querySelector('#app-header'),sidebar:!!document.querySelector('#sidebar')})`);
      if(!page.bridge||!page.header||page.sidebar)throw Error('Desktop UI smoke check failed');
      console.log(JSON.stringify({smoke:'passed',page,processorReady:typeof info.busy==='boolean'}));
      fs.writeFileSync(path.join(app.getPath('temp'),'woodshed-desktop-smoke.png'),(await window.capturePage()).toPNG());
      closing=true;app.quit();
    }
  }).catch(error=>{if(smokeTest){console.error(error);app.exit(1);return;}dialog.showErrorBox('Woodshed could not start',error.message);closing=true;app.quit();});
  app.on('before-quit',event=>{if(!closing&&window&&!window.isDestroyed()){event.preventDefault();window.close();return;}closing=true;webServer?.close();if(companion){event.preventDefault();stopCompanion().finally(()=>app.quit());}});
  app.on('window-all-closed',()=>app.quit());
}
