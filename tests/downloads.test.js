// @vitest-environment happy-dom
import {beforeEach,afterEach,expect,test,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {detectPlatform,normalizeRelease,fetchRelease,RELEASE_SOURCES,ReleaseUnavailableError} from '../src/js/download-release.js';
const manifest=JSON.parse(readFileSync(process.cwd()+'/public/downloads.json','utf8'));
beforeEach(()=>{
  vi.stubGlobal('navigator',{platform:'Win32',userAgent:'Mozilla Windows NT 10.0 Win64 x64'});
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>structuredClone(manifest)})));
});
afterEach(()=>vi.unstubAllGlobals());
test('detects desktop OS without mistaking mobile or unsupported Linux ARM for a desktop installer',()=>{
  expect(detectPlatform()).toBe('windows');
  expect(detectPlatform({platform:'MacIntel',userAgent:'Macintosh',maxTouchPoints:0})).toBe('mac');
  expect(detectPlatform({platform:'MacIntel',userAgent:'Macintosh',maxTouchPoints:5})).toBe('mobile');
  expect(detectPlatform({platform:'Linux',userAgent:'Android'})).toBe('mobile');
  expect(detectPlatform({platform:'Linux x86_64',userAgent:'Linux'})).toBe('linux');
  expect(detectPlatform({platform:'Linux aarch64',userAgent:'Linux'})).toBe('web');
  expect(detectPlatform({platform:'Linux x86_64',userAgent:'CrOS'})).toBe('web');
});
test('unpublished, incomplete, or redirected installer metadata cannot become a download button',()=>{
  expect(()=>normalizeRelease({...manifest,draft:true})).toThrow();
  expect(()=>normalizeRelease({...manifest,assets:[]})).toThrow();
  const changed=structuredClone(manifest);changed.assets[0].browser_download_url='https://example.com/file.exe';
  expect(()=>normalizeRelease(changed)).toThrow('Invalid installer');
});

const ok=body=>({ok:true,status:200,json:async()=>structuredClone(body)});
test('fetchRelease asks the cached lookup first and returns a normalised release',async()=>{
  const fetchImpl=vi.fn(async()=>ok(manifest));
  const release=await fetchRelease({fetch:fetchImpl});
  expect(RELEASE_SOURCES).toEqual(['/api/downloads','/downloads.json']);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl.mock.calls[0][0]).toBe('/api/downloads');
  expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  expect(release).toEqual(normalizeRelease(manifest));
  expect(Object.keys(release.downloads)).toEqual(['mac','windows','linux']);
});
test('fetchRelease falls back to the bundled manifest on an outage, an error status or bad metadata',async()=>{
  for(const first of [async()=>{throw new Error('offline');},async()=>({ok:false,status:503,json:async()=>({})}),async()=>ok({...manifest,draft:true})]){
    const fetchImpl=vi.fn().mockImplementationOnce(first).mockImplementationOnce(async()=>ok(manifest));
    const release=await fetchRelease({fetch:fetchImpl});
    expect(fetchImpl.mock.calls.map(c=>c[0])).toEqual(['/api/downloads','/downloads.json']);
    expect(release.version).toBe(normalizeRelease(manifest).version);
  }
});
test('fetchRelease rejects with every cause when no source works',async()=>{
  const fetchImpl=vi.fn(async url=>{throw new Error(`down: ${url}`);});
  const error=await fetchRelease({fetch:fetchImpl}).catch(e=>e);
  expect(error).toBeInstanceOf(ReleaseUnavailableError);
  expect(error.message).toBe('Downloads couldn’t load. Check your connection and try again.');
  expect(error.causes).toEqual([{url:'/api/downloads',message:'down: /api/downloads'},{url:'/downloads.json',message:'down: /downloads.json'}]);
});
test('fetchRelease times out a stalled source and moves on',async()=>{
  vi.useFakeTimers();
  try{
    const fetchImpl=vi.fn((url,{signal})=>url==='/api/downloads'
      ?new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason)))
      :Promise.resolve(ok(manifest)));
    const pending=fetchRelease({fetch:fetchImpl,timeoutMs:10000});
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).version).toBe(normalizeRelease(manifest).version);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }finally{vi.useRealTimers();}
});
test('fetchRelease stops when the caller aborts',async()=>{
  const controller=new AbortController();
  const fetchImpl=vi.fn((url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason))));
  const pending=fetchRelease({fetch:fetchImpl,signal:controller.signal});
  controller.abort(new DOMException('left the page','AbortError'));
  const error=await pending.catch(e=>e);
  expect(error.name).toBe('AbortError');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  await expect(fetchRelease({fetch:fetchImpl,signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
