import {ConvexClient} from 'convex/browser';
import {anyApi as api} from 'convex/server';
import {convex,restoreSignIn,ensureSignedIn} from './auth.js';
import {openPlayer,closePlayer} from './player.js';
import {finishStartup} from './startup.js';
import {themeControl} from './preferences.js';

export async function renderSharedSong() {
  const token=location.pathname.match(/^\/share\/([a-f0-9]{64})\/?$/)?.[1];
  document.title='Shared song · Woodshed';
  const robots=document.createElement('meta');robots.name='robots';robots.content='noindex, nofollow, noarchive';document.head.append(robots);
  document.body.classList.add('in-player','shared-page');
  document.querySelector('#app-header .header-home').innerHTML='<a class="brand" href="/">Woodshed</a>';
  document.querySelector('#app-header .header-actions').innerHTML=themeControl();
  document.querySelectorAll('.view').forEach(view=>view.classList.toggle('active',view.id==='view-player'));
  const root=document.getElementById('player-root');
  const banner=document.createElement('div');banner.className='share-banner';
  banner.innerHTML='<div><strong>Shared song</strong><small>Saved copies count toward your cloud storage.</small><span class="share-message" role="status">Opening shared song…</span></div><button class="btn-primary" disabled>Add to library</button><a class="btn-ghost" href="/">My library</a>';
  root.before(banner);
  const button=banner.querySelector('button'),message=banner.querySelector('.share-message');
  root.innerHTML='<div class="shared-placeholder"><div class="wave-skeleton"></div><p>Preparing shared song…</p></div>';
  finishStartup();
  let user=null,savedId=null,busy=false,remoteCopying=false,available=false,currentRevision=null,unsubSaved=()=>{},unsub=()=>{};
  const client=new ConvexClient(import.meta.env.VITE_CONVEX_URL);
  const unavailable=()=>{
    available=false;closePlayer();button.disabled=true;
    message.textContent='This link is unavailable. It may have been stopped or the song removed.';
    root.innerHTML='<div class="shared-placeholder"><h2>Song unavailable</h2><p>Ask the sender for a new link. Songs you already saved are still in your library.</p></div>';
  };
  const paint=()=>{button.disabled=busy||remoteCopying||!available;button.textContent=busy||remoteCopying?'Adding…':savedId?'Open in library':user?'Add to library':'Sign in to add';};
  const add=async()=>{
    if(busy||remoteCopying||!available)return;
    if(savedId){location.assign('/?song='+encodeURIComponent(savedId));return;}
    if(!user){closePlayer();location.assign(`/share/${token}?save=1`);return;}
    busy=true;paint();message.textContent='Saving your copy…';
    try{
      savedId=await convex.action(api.shareAudio.save,{token});
      message.textContent='Added to your library. Your practice settings are now independent.';
      history.replaceState(null,'',`/share/${token}`);
    }catch(error){message.textContent=error.data || 'Couldn’t add this song. Check your connection and try again.';}
    finally{busy=false;paint();}
  };
  button.onclick=add;
  if(!token){unavailable();client.close();return;}
  unsub=client.onUpdate(api.sharing.view,{token},song=>{
    if(!song){unavailable();currentRevision=null;return;}
    available=true;document.title=`${song.title} · Shared on Woodshed`;
    if(!busy)message.textContent='Listen here, or save your own copy with its tempo and practice setup.';
    paint();
    if(song.revision!==currentRevision){currentRevision=song.revision;
      void openPlayer(song,{readOnly:true,cacheNamespace:`share:${token}:${song.revision}:`,resolveUrls:()=>client.action(api.shareAudio.playback,{token})});
    }
  },()=>{closePlayer();available=false;paint();message.textContent='Couldn’t open this song. Check your connection and reload to try again.';});
  const saving=new URLSearchParams(location.search).get('save')==='1';
  if(saving){
    const cancel=document.createElement('a');cancel.className='btn-ghost';cancel.href=`/share/${token}`;cancel.textContent='Keep listening without signing in';
    document.querySelector('.signin-inner')?.append(cancel);
  }
  try{
    user=await (saving?ensureSignedIn():restoreSignIn());
    finishStartup();paint();
    if(user){
      unsubSaved=convex.onUpdate(api.sharing.saved,{token},state=>{
        savedId=state?.songId || null;
        remoteCopying=state?.status==='copying';paint();
        if(remoteCopying){message.textContent='This song is being added to your library…';button.disabled=true;}
        else paint();
        if(savedId)message.textContent='Already in your library. Open it to use your saved practice settings.';
      },()=>{});
      if(saving){
        // Wait for the public song verdict; never add before link validation.
        const song=await client.query(api.sharing.view,{token});
        if(song){available=true;await add();}
      }
    }
  }catch{message.textContent='Sign-in could not finish. Reload to try again.';}
  window.addEventListener('pagehide',()=>{unsub();unsubSaved();client.close();closePlayer();},{once:true});
}
