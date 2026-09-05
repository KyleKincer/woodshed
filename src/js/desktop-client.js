import { initializeLocalDesktop } from './companion.js';
let state={status:'idle'}, root, trigger, panel, processingError='';
const icon='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function render(){
  if(!root)return;
  const messages={idle:'App updates',checking:'Checking for updates…',current:'Woodshed is up to date',available:`Woodshed ${state.version} is available`,downloading:`Downloading update — ${Math.round(state.percent)}%`,ready:'Update ready',error:state.message};
  const message=messages[state.status]||'App updates';
  trigger.title=message;trigger.setAttribute('aria-label',`App updates: ${message}`);
  root.classList.toggle('has-update',['available','ready'].includes(state.status));
  root.classList.toggle('has-error',state.status==='error'||!!processingError);
  trigger.classList.toggle('is-downloading',state.status==='downloading');
  panel.replaceChildren();
  const title=document.createElement('strong');title.textContent=message;panel.append(title);
  if(state.status==='ready'){const note=document.createElement('p');note.className='hint';note.textContent='Restart when playback and processing are finished.';panel.append(note);}
  if(state.status==='downloading'){const progress=document.createElement('progress');progress.max=100;progress.value=state.percent;progress.setAttribute('aria-label','Update download progress');panel.append(progress);}
  if(processingError){const note=document.createElement('p');note.className='hint';note.textContent=`Local processing: ${processingError}`;panel.append(note);}
  const actions={available:['Download update','download'],ready:['Restart to update','install'],current:['Check for updates','check'],error:['Try again','check'],idle:['Check for updates','check']};
  if(actions[state.status]){
    const [label,action]=actions[state.status];const button=document.createElement('button');button.className='btn-ghost';button.textContent=label;
    button.onclick=async()=>{button.disabled=true;try{const result=await window.woodshedDesktop.update(action);if(result?.message)title.textContent=result.message;}catch(error){const note=document.createElement('p');note.className='hint';note.textContent=error.message;panel.append(note);}finally{button.disabled=false;}};
    panel.append(button);
  }
}
export async function initializeDesktop(){
  root=document.createElement('details');root.className='desktop-update-menu';
  trigger=document.createElement('summary');trigger.className='desktop-update-trigger';trigger.innerHTML=icon;
  panel=document.createElement('div');panel.className='desktop-update-panel';panel.setAttribute('aria-live','polite');
  root.append(trigger,panel);document.getElementById('user-button').before(root);render();
  document.addEventListener('click',event=>{if(!root.contains(event.target))root.open=false;});
  root.addEventListener('keydown',event=>{if(event.key==='Escape'){root.open=false;trigger.focus();}});
  window.woodshedDesktop.onUpdate(next=>{state=next;render();});
  const open=()=>{root.open=true;render();};
  window.woodshedDesktop.onOpenUpdates?.(open);
  document.addEventListener('woodshed:show-updates',open);
  try{const info=await initializeLocalDesktop();state=info.update;render();}
  catch(error){processingError=error.message;render();}
}
