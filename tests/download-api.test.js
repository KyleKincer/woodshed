import {afterEach,expect,test,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import downloads from '../api/downloads.js';
const manifest=JSON.parse(readFileSync(new URL('../public/downloads.json',import.meta.url),'utf8'));
afterEach(()=>vi.unstubAllGlobals());
function response(){return {headers:{},setHeader(key,value){this.headers[key]=value;},status(code){this.code=code;return this;},json(data){this.body=data;return this;}};}
test('the same-origin endpoint caches only validated public release metadata',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({...manifest,privateField:'not exposed'})})));
  const res=response();await downloads({method:'GET'},res);
  expect(res.code).toBe(200);expect(res.body.tag_name).toBe(manifest.tag_name);
  expect(res.body.privateField).toBeUndefined();expect(res.headers['Cache-Control']).toContain('s-maxage=60');
  expect(fetch.mock.calls[0][0]).toBe('https://api.github.com/repos/KyleKincer/woodshed/releases/latest');
});
test('upstream failures are not cached and write methods do not call GitHub',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:false})));
  const res=response();await downloads({method:'GET'},res);
  expect(res.code).toBe(503);expect(res.headers['Cache-Control']).toBe('no-store');
  fetch.mockClear();const denied=response();await downloads({method:'POST'},denied);
  expect(denied.code).toBe(405);expect(fetch).not.toHaveBeenCalled();
});
