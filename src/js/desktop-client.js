import { initializeLocalDesktop } from './companion.js';
let state = {status:'idle'}, root;
function render() {
  if(!root)return;
  root.replaceChildren();
  const text=document.createElement('span');
  const messages={idle:'Desktop app',checking:'Checking for updates…',current:'Woodshed is up to date',available:`Woodshed ${state.version} is available`,downloading:`Downloading update — ${Math.round(state.percent)}%`,ready:'Update ready. Restart when you’re ready.',error:state.message};
  text.textContent=messages[state.status]||'Desktop app';root.append(text);
  const actions={available:['Download update','download'],ready:['Restart to update','install'],current:['Check again','check'],error:['Try again','check'],idle:['Check for updates','check']};
  if(actions[state.status]){const [label,action]=actions[state.status];const button=document.createElement('button');button.className='btn-ghost';button.textContent=label;button.onclick=async()=>{button.disabled=true;try{const result=await window.woodshedDesktop.update(action);if(result?.message)text.textContent=result.message;}catch(e){text.textContent=e.message;}finally{button.disabled=false;}};root.append(button);}
  if(['available','ready'].includes(state.status)){const later=document.createElement('button');later.className='btn-ghost';later.textContent='Later';later.onclick=()=>root.classList.add('hidden');root.append(later);}
}
export async function initializeDesktop() {
  root=document.createElement('div');root.className='desktop-update hidden';root.setAttribute('role','status');document.getElementById('app-header').after(root);
  window.woodshedDesktop.onUpdate(next=>{state=next;render();if(['available','downloading','ready','error'].includes(state.status))root.classList.remove('hidden');});
  try {const info=await initializeLocalDesktop();state=info.update;render();}
  catch(e){root.textContent=e.message;root.classList.remove('hidden');}
  window.woodshedDesktop.onOpenUpdates(()=>{root.classList.remove('hidden');render();});
  document.addEventListener('woodshed:show-updates',()=>{root.classList.remove('hidden');render();});
}
