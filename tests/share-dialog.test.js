// @vitest-environment happy-dom
import {beforeEach,expect,test,vi} from 'vitest';
vi.mock('../src/js/auth.js',()=>({convex:{query:vi.fn(),mutation:vi.fn()}}));
import {convex} from '../src/js/auth.js';
import {showShareDialog} from '../src/js/share-dialog.js';
beforeEach(()=>{vi.clearAllMocks();document.body.innerHTML='';convex.query.mockResolvedValue(null);convex.mutation.mockResolvedValue({token:'a'.repeat(64)});Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:vi.fn(async()=>{})}});});
test('creating a link flushes current practice first and offers explicit stop sharing',async()=>{
  const order=[];const beforeShare=vi.fn(async()=>{order.push('save');});convex.mutation.mockImplementation(async()=>{order.push('create');return {token:'a'.repeat(64)};});
  await showShareDialog({id:'song',title:'Practice'},{beforeShare});
  document.querySelector('[data-copy]').click();await vi.waitFor(()=>expect(navigator.clipboard.writeText).toHaveBeenCalled());
  expect(order).toEqual(['save','create']);expect(document.querySelector('input').value).toBe('https://woodshed.kylekincer.com/share/'+'a'.repeat(64));
  document.querySelector('[data-stop]').click();await vi.waitFor(()=>expect(document.querySelector('.share-status').textContent).toContain('Sharing stopped'));
  expect(document.querySelector('.share-link-field').classList.contains('hidden')).toBe(true);
});
test('clipboard failures leave a selectable link, and private song names are escaped',async()=>{
  navigator.clipboard.writeText.mockRejectedValue(new Error('denied'));
  await showShareDialog({id:'song',title:'<img src=x onerror=bad>'});document.querySelector('[data-copy]').click();
  await vi.waitFor(()=>expect(document.querySelector('.share-status').textContent).toContain('Select and copy'));
  expect(document.querySelector('.share-song-title img')).toBeNull();expect(document.querySelector('input').value).toContain('/share/');
});
test('a failed practice save does not create or copy a stale share setup',async()=>{
  await showShareDialog({id:'song',title:'Practice'},{beforeShare:async()=>{throw Error('Could not save practice');}});
  document.querySelector('[data-copy]').click();await vi.waitFor(()=>expect(document.querySelector('[data-copy]').disabled).toBe(false));
  expect(convex.mutation).not.toHaveBeenCalled();expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
});
