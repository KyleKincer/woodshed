import {convex} from './auth.js';
import {anyApi as api} from 'convex/server';
import {focusModal} from './modal-focus.js';

export async function showShareDialog(song, {beforeShare=async()=>{}} = {}) {
  document.querySelector('#share-dialog')?.remove();
  const modal=document.createElement('div');modal.id='share-dialog';modal.className='modal';
  modal.innerHTML='<div class="modal-card"><h2>Share song</h2><p class="share-song-title"></p><p class="hint">Anyone with the link can listen and save their own copy. Tempo maps, beat corrections, loop, speed, mixer, grid, and count-in settings are included. Private notes and tags stay private.</p><label class="field share-link-field hidden"><span>Share link</span><input type="url" readonly aria-label="Share link"></label><p class="share-status hint" role="status">Loading sharing settings…</p><div class="modal-actions"><button class="btn-ghost" data-close>Close</button><button class="btn-danger hidden" data-stop>Stop sharing</button><button class="btn-primary" data-copy disabled>Create link</button></div></div>';
  modal.querySelector('.share-song-title').textContent=song.title;document.body.append(modal);
  const status=modal.querySelector('.share-status'),copy=modal.querySelector('[data-copy]'),stop=modal.querySelector('[data-stop]'),field=modal.querySelector('.share-link-field'),input=modal.querySelector('input');
  const close=()=>modal.remove();modal.querySelector('[data-close]').onclick=close;
  modal.onclick=e=>{if(e.target===modal)close();};focusModal(modal,close);
  let token=null,busy=false;
  const paint=()=>{field.classList.toggle('hidden',!token);stop.classList.toggle('hidden',!token);copy.textContent=token?'Copy link':'Create link';copy.disabled=busy;stop.disabled=busy;if(token)input.value=`https://woodshed.kylekincer.com/share/${token}`;};
  const act=async fn=>{if(busy)return;busy=true;paint();try{await fn();}catch(error){status.textContent=error.data || error.message || 'Something went wrong. Try again.';}finally{busy=false;if(modal.isConnected)paint();}};
  copy.onclick=()=>act(async()=>{
    await beforeShare();
    if(!token){status.textContent='Creating link…';token=(await convex.mutation(api.sharing.create,{id:song.id})).token;paint();}
    try{await navigator.clipboard.writeText(input.value);status.textContent='Link copied. Saved copies remain available if you stop sharing.';}
    catch{status.textContent='Select and copy the link above.';input.focus();input.select();}
  });
  stop.onclick=()=>act(async()=>{await convex.mutation(api.sharing.revoke,{id:song.id});token=null;status.textContent='Sharing stopped. Previously saved copies remain available. Creating a link again will use a new address.';});
  await act(async()=>{const result=await convex.query(api.sharing.status,{id:song.id});token=result?.token;status.textContent=token?'This link is active. Saved copies remain available if you stop sharing.':'Create a private, unlisted link. It won’t appear in search engines.';});
}
