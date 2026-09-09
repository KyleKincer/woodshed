// @vitest-environment happy-dom
import {beforeEach,expect,test,vi} from 'vitest';
import {finishStartup,showStartup,showSignIn,waitForAuthSession} from '../src/js/startup.js';
beforeEach(() => {
  document.body.innerHTML='<header id="app-header" inert></header><main id="content" inert></main><div id="signin" class="hidden"></div><div id="startup-status"></div>';
  showStartup();
});
function session(initial) {
  let state=initial, listener;
  const unsubscribe=vi.fn();
  return {getSnapshot:()=>state,subscribe:callback=>{listener=callback;return unsubscribe;},unsubscribe,
    update:next=>{state=next;listener();}};
}
test('restoring a session never exposes sign-in or an interactive empty shell',async()=>{
  const auth=session({isLoading:true,isAuthenticated:false});
  const signedOut=vi.fn(showSignIn);
  const ready=waitForAuthSession(auth,{onSignedOut:signedOut,onLoading:showStartup});
  expect(document.documentElement.dataset.startup).toBe('loading');
  auth.update({isLoading:false,isAuthenticated:true});await ready;
  expect(signedOut).not.toHaveBeenCalled();
  expect(document.getElementById('signin').classList.contains('hidden')).toBe(true);
  expect(document.getElementById('content').hasAttribute('inert')).toBe(true);
  finishStartup();expect(document.getElementById('content').hasAttribute('inert')).toBe(false);
  expect(document.getElementById('startup-status')).toBeNull();
  expect(auth.unsubscribe).toHaveBeenCalled();
});
test('confirmed signed-out users see sign-in; OAuth completion returns to loading until content is ready',async()=>{
  const auth=session({isLoading:false,isAuthenticated:false});
  const ready=waitForAuthSession(auth,{onSignedOut:showSignIn,onLoading:showStartup});
  expect(document.documentElement.dataset.startup).toBe('signin');
  auth.update({isLoading:true,isAuthenticated:false});
  expect(document.documentElement.dataset.startup).toBe('loading');
  auth.update({isLoading:false,isAuthenticated:true});await ready;
  expect(document.documentElement.dataset.startup).toBe('loading');
});
test('an already authenticated session skips sign-in entirely',async()=>{
  const onSignedOut=vi.fn();
  await waitForAuthSession(session({isLoading:false,isAuthenticated:true}),{onSignedOut,onLoading:showStartup});
  expect(onSignedOut).not.toHaveBeenCalled();
});
