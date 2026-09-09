// @vitest-environment happy-dom
import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
const subscriptions=vi.hoisted(()=>({}));
vi.mock('../src/js/backend.js',()=>({
  onLibrary:vi.fn((cb,error)=>{subscriptions.library=cb;subscriptions.error=error;return ()=>{};}),
  onJobs:vi.fn(cb=>{subscriptions.jobs=cb;return ()=>{};}),
  signKeys:vi.fn(()=>new Promise(()=>{})),
}));
vi.mock('../src/js/companion.js',()=>({isDesktopApp:()=>false}));
import {initLibrary,renderLibrary,teardownLibrary} from '../src/js/library.js';
import {finishStartup} from '../src/js/startup.js';
import {signKeys} from '../src/js/backend.js';
import {PRESETS,STEM_MODES,DEFAULT_SETTINGS} from '../convex/lib/presets';
const config={presets:PRESETS,stemModes:STEM_MODES,settings:DEFAULT_SETTINGS};
beforeEach(()=>{
  const html=readFileSync(process.cwd() + '/index.html','utf8');
  document.body.innerHTML=html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g,'');
  signKeys.mockImplementation(()=>new Promise(()=>{}));
});
afterEach(()=>teardownLibrary());
test('first library and jobs snapshots replace the skeleton together, without waiting for artwork',async()=>{
  let resolveArt;signKeys.mockImplementation(()=>new Promise(resolve=>{resolveArt=resolve;}));
  const ready=initLibrary(config,vi.fn());let loaded=false;ready.then(()=>{loaded=true;});
  await renderLibrary();subscriptions.jobs([]);await Promise.resolve();
  expect(loaded).toBe(false);expect(document.querySelector('.startup-skeleton')).not.toBeNull();
  expect(document.getElementById('library-empty').classList.contains('hidden')).toBe(true);
  subscriptions.library({songs:[{id:'one',title:'Practice song',stems:[],coverKey:'cover-test'}]});
  await ready;finishStartup();
  const button=document.querySelector('.song-open');button.focus();
  expect(button.getAttribute('aria-label')).toBe('Open Practice song');
  expect(document.querySelector('.startup-skeleton')).toBeNull();
  resolveArt({'cover-test':'https://example.com/cover.png'});await Promise.resolve();
  expect(document.activeElement).toBe(button);
  expect(document.querySelector('[data-cover-key] img').getAttribute('src')).toBe('https://example.com/cover.png');
});
test('a genuinely empty library appears only after both snapshots',async()=>{
  const ready=initLibrary(config,vi.fn());subscriptions.library({songs:[]});await Promise.resolve();
  expect(document.getElementById('library-empty').classList.contains('hidden')).toBe(true);
  subscriptions.jobs([]);await ready;
  expect(document.getElementById('library-empty').classList.contains('hidden')).toBe(false);
});
test('subscription errors reach startup recovery instead of leaving an endless skeleton',async()=>{
  const ready=initLibrary(config,vi.fn());
  const rejected=expect(ready).rejects.toThrow('offline');
  subscriptions.error(new Error('offline'));await rejected;
});
