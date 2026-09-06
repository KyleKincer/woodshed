import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ConvexClient } from 'convex/browser';
import { anyApi as api } from 'convex/server';

const here = path.dirname(fileURLToPath(import.meta.url));
const data = process.env.WOODSHED_DATA_DIR || path.join(os.homedir(), '.woodshed-companion');
let port = Number(process.env.WOODSHED_COMPANION_PORT || 47831);
const webOrigin = new URL(process.env.WOODSHED_WEB_URL || 'http://localhost:5173').origin;
const origins = new Set([webOrigin]);
const configFile = path.join(data, 'connection.json');
await fs.mkdir(data, { recursive: true, mode: 0o700 });
let config;
try { config = JSON.parse(await fs.readFile(configFile, 'utf8')); }
catch { config = { token: crypto.randomBytes(32).toString('hex') }; }
if (process.argv.includes('--reset-pairing')) config = { token: crypto.randomBytes(32).toString('hex') };
await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
let acceptingJobs = true;
let client, identity, stopSubscription, busy = false, pending = null, current = null;
const python = process.env.WOODSHED_PYTHON || path.join(here, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const childEnv = { ...process.env, PATH: `${path.dirname(python)}${path.delimiter}${process.env.PATH}`, PYTHONUNBUFFERED: '1', OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || String(Math.min(4, os.availableParallelism())) };
const safe = value => String(value).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'untitled';
const accountDir = () => path.join(data, 'accounts', crypto.createHash('sha256').update(`${config.convexUrl}:${identity.userId}`).digest('hex').slice(0, 24));
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
async function body(req, max = 16384) {
  const parts = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > max) throw new Error('Request too large.'); parts.push(chunk); }
  return JSON.parse(Buffer.concat(parts).toString() || '{}');
}
function limitBytes(max) {
  let size = 0;
  return new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; callback(size > max ? new Error('File too large.') : null, chunk); } });
}
async function connect(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !/^[a-z0-9-]+\.convex\.cloud$/.test(parsed.hostname) || parsed.pathname !== '/') throw new Error('Expected a Convex deployment URL.');
  if (busy && config.convexUrl !== url) throw new Error('Wait for processing to finish before switching deployments.');
  const next = new ConvexClient(url);
  let who;
  try { who = await next.query(api.devices.identity, { token: config.token }); }
  catch (error) { await next.close(); throw error; }
  stopSubscription?.(); await client?.close();
  client = next; identity = who; config.convexUrl = url;
  await fs.mkdir(accountDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  stopSubscription = client.onUpdate(api.worker.next, {token: config.token}, job => {
    pending = job;
    if (current && (!job || job._id !== current.id)) killCurrent();
    void drain();
  }, error => { console.error('Companion connection:', error.message); killCurrent(); });
}
function killCurrent() {
  current?.abort.abort();
  if (!current?.child) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(current.child.pid), '/T', '/F']);
  else { try { process.kill(-current.child.pid, 'SIGTERM'); } catch {} }
}
async function download(url, destination) {
  const response = await fetch(url, {signal:current?.abort.signal});
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`);
  await pipeline(Readable.fromWeb(response.body), limitBytes(300_000_000), createWriteStream(destination));
}
async function execute(job, root) {
  current.abort.signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    const executable = process.env.WOODSHED_PROCESSOR || python;
    const args = process.env.WOODSHED_PROCESSOR ? [root] : [path.join(here, 'process.py'), root];
    const child = spawn(executable, args, { env: childEnv, detached: process.platform !== 'win32', stdio: ['ignore','pipe','pipe'] });
    current.child = child;
    let buffer = '', lastProgress = 0, errorMessage = '', stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.error) errorMessage = event.error;
        if (event.stage && Date.now() - lastProgress > 2000) {
          lastProgress = Date.now();
          client.mutation(api.worker.progress, {token: config.token, jobId: job._id, stage: event.stage, percent: event.percent, message: event.message}).then(ok => { if (!ok) killCurrent(); }).catch(error => console.error('Progress update:', error.message));
        }
      }
    });
    child.on('error', reject);
    child.on('exit', code => {if(current?.child===child) current.child=null;code === 0 ? resolve() : reject(new Error(errorMessage || stderr || `Processor exited (${code}). Run npm run companion:setup first.`));});
  });
}
async function runJob(queued) {
  const job = await client.mutation(api.worker.claim, {token: config.token, jobId: queued._id});
  const root = path.join(accountDir(), 'jobs', safe(job._id));
  await fs.mkdir(root, { recursive: true });
  if (job.source?.type === 'upload') {
    if (!/^[a-f0-9-]{36}$/.test(job.source.value)) throw new Error('Original file unavailable locally. Add the file again.');
    job.localSource = path.join(accountDir(), 'uploads', job.source.value);
  }
  if (job.kind === 'import') {
    const entries = JSON.parse(await fs.readFile(path.join(accountDir(), 'imports.json'), 'utf8'));
    job.legacySong = entries[job.importMeta.id];
    if (!job.legacySong) throw new Error('Legacy files missing. Import from this computer again.');
  }
  if (job.kind === 'beats') {
    const urls = await client.action(api.media.signKeys, {token:config.token, keys:job.song.stems.map(s=>s.key)});
    job.localStems = [];
    for (const [i, stem] of job.song.stems.entries()) {
      const dest = path.join(root, `input-${i}.audio`);
      await download(urls[stem.key], dest); job.localStems.push(dest);
    }
  }
  await fs.writeFile(path.join(root, 'job.json'), JSON.stringify(job));
  await execute(job, root);
  const result = JSON.parse(await fs.readFile(path.join(root, 'result.json'), 'utf8'));
  if (job.kind === 'beats') { await client.mutation(api.worker.beatsDone, {token:config.token, jobId:job._id, beats:result.beats}); return; }
  const files = [];
  for (const f of result.files) {
    const filePath = path.join(root, f.name);
    const hash = crypto.createHash('sha256');
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    files.push({name:f.name, bytes:(await fs.stat(filePath)).size, mime:f.mime, checksum:hash.digest('base64')});
  }
  await client.mutation(api.worker.progress, {token:config.token, jobId:job._id, stage:'sync',percent:95,message:'Syncing your library…'});
  current.abort.signal.throwIfAborted();
  const uploads = await client.action(api.blobs.prepare, {token:config.token, jobId:job._id, files});
  for (const file of uploads) {
    current.abort.signal.throwIfAborted();
    const response = await fetch(file.url, {signal:current.abort.signal,method:'PUT', headers:{'content-type':file.mime,'content-length':String(file.bytes),'x-amz-checksum-sha256':file.checksum},body:createReadStream(path.join(root,file.name)),duplex:'half'});
    if (!response.ok) throw new Error(`Sync upload failed (${response.status}). Your local files are safe.`);
  }
  const {files: _files, ...meta} = result;
  const stems = result.files.filter(f=>f.stem).map(f=>{const u=uploads.find(u=>u.name===f.name);return {name:f.stem,key:u.key,bytes:u.bytes,mime:u.mime};});
  const coverKey = uploads.find(u=>u.name==='cover.jpg')?.key;
  const songId = await client.action(api.blobs.complete, {token:config.token, jobId:job._id,result:{...meta,stems,...(coverKey ? {coverKey}: {})}});
  await fs.writeFile(path.join(root,'synced.json'),JSON.stringify({songId}));
}
async function drain() {
  if (!acceptingJobs || busy || !pending) return;
  const job = pending; pending = null; busy = true; current = {id:job._id,child:null,abort:new AbortController()};
  try { await runJob(job); }
  catch (error) {
    console.error('Job failed:', error.message);
    try { await client.mutation(api.worker.progress,{token:config.token,jobId:job._id,stage:'error',percent:0,error:error.message}); } catch {}
  } finally {
    busy = false; current = null;
    if (pending?._id === job._id) pending = null;
    // Resolve next once after completion; no idle polling or per-second heartbeats.
    try { pending = await client.query(api.worker.next,{token:config.token}); } catch {}
    if (pending) setTimeout(()=>void drain(),100);
  }
}
function legacyDirs() {
  return [path.join(os.homedir(),'Library','Application Support','woodshed'), path.join(process.env.APPDATA || path.join(os.homedir(),'AppData','Roaming'),'woodshed'), path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(),'.config'),'woodshed')];
}
async function readLegacy(dir) {
  const input = JSON.parse(await fs.readFile(path.join(dir,'library.json'),'utf8'));
  const songs = Array.isArray(input) ? input : input.songs;
  if (!Array.isArray(songs)) throw new Error('Unrecognized library.json.');
  return songs.map(song => {
    const songDir=path.join(dir,'media',safe(song.id));
    return {...song,
      stems:(song.stems||[]).map(stem=>({...stem,path:stem.path?path.resolve(dir,stem.path):path.join(songDir,path.basename(stem.file))})),
      ...(song.thumb?{coverPath:path.join(songDir,path.basename(song.thumb))}:song.coverPath?{coverPath:path.resolve(dir,song.coverPath)}:{})};
  });
}
const server = http.createServer(async (req,res)=>{
  const origin = req.headers.origin;
  if (!['127.0.0.1:'+port,'localhost:'+port].includes(req.headers.host) || !origin || !origins.has(origin)) { json(res,403,{error:'Untrusted origin.'});return; }
  res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');
  if (req.method==='OPTIONS') { res.writeHead(204,{'Access-Control-Allow-Methods':'GET,POST','Access-Control-Allow-Headers':'authorization,content-type,x-filename','Access-Control-Allow-Private-Network':'true'});res.end();return; }
  const expected = Buffer.from(`Bearer ${config.token}`), supplied = Buffer.from(req.headers.authorization || '');
  if (expected.length!==supplied.length || !crypto.timingSafeEqual(expected,supplied)) {json(res,401,{error:'Invalid local processor credential.'});return;}
  try {
    if (req.url==='/status' && req.method==='GET') {json(res,200,{name:os.hostname(),connected:!!identity,deviceId:identity?.deviceId, userId:identity?.userId,busy});return;}
    if (req.url==='/connect' && req.method==='POST') {const input=await body(req);await connect(input.convexUrl);json(res,200,identity);return;}
    if (!client || !identity) throw new Error('Pair the companion in Settings first.');
    // Recheck revocation before any filesystem operation.
    await client.query(api.devices.identity,{token:config.token});
    if (req.url==='/upload' && req.method==='POST') {
      const id=crypto.randomUUID();const dir=path.join(accountDir(),'uploads');await fs.mkdir(dir,{recursive:true});
      const dest=path.join(dir,id);
      try {await pipeline(req,limitBytes(1_000_000_000),createWriteStream(dest,{flags:'wx'}));}catch(error){await fs.rm(dest,{force:true});throw error;}
      json(res,200,{id});return;
    }
    if (req.url==='/export-originals' && req.method==='POST') {
      const target=path.join(os.homedir(),'Downloads','Woodshed-originals-'+new Date().toISOString().replace(/[:.]/g,'-'));
      let count=0;
      async function copyAudio(from,to) {
        for(const e of await fs.readdir(from,{withFileTypes:true})) {
          const source=path.join(from,e.name),dest=path.join(to,e.name);
          if(e.isDirectory()) await copyAudio(source,dest);
          else if(/\.(wav|flac)$/.test(e.name)) {await fs.mkdir(to,{recursive:true});await fs.copyFile(source,dest);count++;}
        }
      }
      const jobs=path.join(accountDir(),'jobs');
      await copyAudio(jobs,target);
      json(res,200,{directory:target,count});return;
    }
    if (req.url==='/legacy' && req.method==='GET') {
      const found=[];for(const dir of legacyDirs()){try{const songs=await readLegacy(dir);found.push({directory:dir,count:songs.length});}catch{}}
      json(res,200,found);return;
    }
    if (req.url==='/import' && req.method==='POST') {
      const {directory}=await body(req);const songs=await readLegacy(directory);
      const file=path.join(accountDir(),'imports.json');let entries={};try{entries=JSON.parse(await fs.readFile(file,'utf8'));}catch{}
      for(const s of songs) entries[String(s.id)]=s;
      await fs.writeFile(file,JSON.stringify(entries));
      let count=0, skipped=0;
      for(const s of songs) {
        if(count>=20) break;
        const result=await client.mutation(api.worker.importSong,{token:config.token,legacyId:String(s.id),title:String(s.title||'Imported song'),tempo:s.tempo??null,practice:s.practice??null});
        if(result.jobId) count++; else skipped++;
      }
      json(res,200,{count,skipped,remaining:Math.max(0,songs.length-count-skipped)});return;
    }
    json(res,404,{error:'Unknown endpoint.'});
  } catch(error) {json(res,400,{error:error.message});}
});
server.listen(port,'127.0.0.1',()=>{
  port = server.address().port;
  if (process.parentPort) { process.parentPort.postMessage({port,token:config.token}); return; }
  console.log(`Woodshed companion listening on 127.0.0.1:${port}`);
  console.log('Open Woodshed for desktop and sign in to connect the local processor.');
  console.log(`Local originals and stems: ${data}`);
});
if(config.convexUrl) connect(config.convexUrl).catch(error=>console.error('Desktop processor connection:',error.message));
async function shutdown(){acceptingJobs=false;killCurrent();stopSubscription?.();await client?.close();server.close();process.exit(0);}
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,shutdown);
process.parentPort?.on('message',event=>{
  if(event.data?.type==='quiesce'){if(!busy)acceptingJobs=false;process.parentPort.postMessage({type:'quiesced',busy});}
  if(event.data?.type==='shutdown')void shutdown();
});
