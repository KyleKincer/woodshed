// @vitest-environment happy-dom
import {beforeEach,afterEach,expect,test,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {detectPlatform,normalizeRelease} from '../src/js/download-release.js';
import {renderDownload} from '../src/js/desktop.js';
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
test('main button downloads the detected installer directly and all four formats remain on the page',async()=>{
  await renderDownload();
  const button=document.getElementById('recommended-download');
  expect(button.textContent).toContain('Download for Windows');
  expect(button.href).toMatch(/\/releases\/download\/v[\d.]+\/Woodshed-[\d.]+-win-x64\.exe$/);
  expect(button.getAttribute('download')).toMatch(/\.exe$/);
  expect(document.querySelectorAll('.download-file')).toHaveLength(4);
  expect(document.querySelector('.download-platforms').hasAttribute('aria-busy')).toBe(false);
  button.addEventListener('click',e=>e.preventDefault());button.click();
  expect(document.getElementById('download-status').textContent).toContain('should start shortly');
});
test('mobile offers the web player and macOS explicitly identifies the Apple Silicon requirement',async()=>{
  navigator.platform='MacIntel';navigator.userAgent='Macintosh';navigator.maxTouchPoints=5;
  await renderDownload();expect(document.getElementById('recommended-download').getAttribute('href')).toBe('/');
  navigator.maxTouchPoints=0;await renderDownload();
  expect(document.getElementById('recommended-download').href).toMatch(/-mac-arm64\.dmg$/);
  expect(document.getElementById('recommended-detail').textContent).toContain('Requires Apple Silicon');
});
test('a lookup outage falls back to working downloads, and a complete outage offers retry',async()=>{
  fetch.mockRejectedValueOnce(new Error('API unavailable'));
  await renderDownload();expect(fetch.mock.calls[1][0]).toBe('/downloads.json');
  expect(document.querySelectorAll('.download-file')).toHaveLength(4);
  fetch.mockRejectedValue(new Error('offline'));
  await renderDownload();expect(document.getElementById('retry-downloads').classList.contains('hidden')).toBe(false);
  expect(document.getElementById('recommended-download').getAttribute('href')).toBe('#all-downloads');
  fetch.mockResolvedValue({ok:true,json:async()=>manifest});
  await document.getElementById('retry-downloads').onclick();
  expect(document.querySelectorAll('.download-file')).toHaveLength(4);
});
test('unpublished, incomplete, or redirected installer metadata cannot become a download button',()=>{
  expect(()=>normalizeRelease({...manifest,draft:true})).toThrow();
  expect(()=>normalizeRelease({...manifest,assets:[]})).toThrow();
  const changed=structuredClone(manifest);changed.assets[0].browser_download_url='https://example.com/file.exe';
  expect(()=>normalizeRelease(changed)).toThrow('Invalid installer');
});
