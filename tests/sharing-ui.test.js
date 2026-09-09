// @vitest-environment happy-dom
import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
const state=vi.hoisted(()=>({user:null,view:null,publicUpdate:null,savedUpdate:null,save:vi.fn(),signIn:vi.fn(),restore:vi.fn()}));
vi.mock('convex/browser',()=>({ConvexClient:class{
  onUpdate(_ref,_args,cb){state.publicUpdate=cb;cb(state.view);return ()=>{};}
  query=async()=>state.view; action=async()=>({});close(){}
}}));
vi.mock('../src/js/auth.js',()=>({
  convex:{action:(...args)=>state.save(...args),onUpdate(_ref,_args,cb){state.savedUpdate=cb;cb(null);return ()=>{};}},
  restoreSignIn:()=>state.restore(),ensureSignedIn:()=>state.signIn(),
}));
vi.mock('../src/js/player.js',()=>({openPlayer:vi.fn(),closePlayer:vi.fn()}));
import {openPlayer,closePlayer} from '../src/js/player.js';
import {renderSharedSong} from '../src/js/shared-song.js';
const token='a'.repeat(64);
beforeEach(()=>{
  vi.clearAllMocks();state.restore.mockResolvedValue(null);state.signIn.mockResolvedValue({name:'Listener'});state.save.mockResolvedValue('saved-song');
  state.view={id:'shared',title:'Shared tune',revision:'one',stems:[{name:'drums',key:'stem-0'}],tempo:{map:[{t:0,bpm:97}]}};
  const html=readFileSync(process.cwd()+'/index.html','utf8');
  document.body.innerHTML=html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g,'');
  vi.stubGlobal('location',{pathname:'/share/'+token,search:'',assign:vi.fn()});
  vi.stubGlobal('history',{replaceState:vi.fn()});
});
afterEach(()=>{window.dispatchEvent(new Event('pagehide'));vi.unstubAllGlobals();});
test('anonymous recipients can practice without sign-in; adding preserves the link through authentication',async()=>{
  await renderSharedSong();
  expect(openPlayer).toHaveBeenCalledWith(state.view,expect.objectContaining({readOnly:true,cacheNamespace:`share:${token}:one:`}));
  expect(state.signIn).not.toHaveBeenCalled();
  const button=document.querySelector('.share-banner button');expect(button.textContent).toBe('Sign in to add');button.click();
  expect(location.assign).toHaveBeenCalledWith('/share/'+token+'?save=1');
});
test('signed-in saves suppress duplicate clicks and become Open in library',async()=>{
  state.restore.mockResolvedValue({name:'Listener'});let finish;state.save.mockImplementation(()=>new Promise(r=>{finish=r;}));
  await renderSharedSong();const button=document.querySelector('.share-banner button');
  button.click();button.click();expect(state.save).toHaveBeenCalledTimes(1);expect(button.disabled).toBe(true);
  finish('saved-song');await Promise.resolve();await Promise.resolve();
  expect(button.textContent).toBe('Open in library');button.click();expect(location.assign).toHaveBeenCalledWith('/?song=saved-song');
});
test('an already saved song opens without copying; revocation stops playback and disables adding',async()=>{
  state.restore.mockResolvedValue({name:'Listener'});await renderSharedSong();
  state.savedUpdate({songId:'existing',status:'ready'});document.querySelector('.share-banner button').click();
  expect(state.save).not.toHaveBeenCalled();expect(location.assign).toHaveBeenCalledWith('/?song=existing');
  state.publicUpdate(null);expect(closePlayer).toHaveBeenCalled();expect(document.querySelector('.share-banner button').disabled).toBe(true);
  expect(document.getElementById('player-root').textContent).toContain('Song unavailable');
});
test('failed saves keep a retry path and signed-in redirects complete the requested add',async()=>{
  location.search='?save=1';state.save.mockRejectedValueOnce({data:'Your cloud library is full.'});
  await renderSharedSong();expect(state.signIn).toHaveBeenCalledTimes(1);
  expect(document.querySelector('.share-message').textContent).toContain('library is full');
  expect(document.querySelector('.share-banner button').disabled).toBe(false);
  expect(document.querySelector('.signin-inner a').getAttribute('href')).toBe('/share/'+token);
});
test('invalid tokens have a stable unavailable state and never initialize authentication',async()=>{
  location.pathname='/share/bad';await renderSharedSong();
  expect(state.restore).not.toHaveBeenCalled();expect(openPlayer).not.toHaveBeenCalled();
  expect(document.querySelector('.shared-placeholder h2').textContent).toBe('Song unavailable');
});
