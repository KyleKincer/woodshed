/** Keep engraving fonts and synthesis off the normal startup path. */
export function attachNotation(options){
  const {root}=options,nav=root.querySelector('.workspace-nav');let workspace=null,pending=null,closed=false,wanted=false;
  const host=document.createElement('section');host.className='notation-workspace';host.hidden=true;host.setAttribute('aria-label','Drum transcription');root.querySelector('.transport').before(host);
  const paint=()=>{root.querySelector('.player').classList.toggle('notation-active',wanted);nav.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String((b.dataset.workspace==='transcribe')===wanted)));};
  const show=async()=>{wanted=true;paint();host.hidden=false;
    if(workspace){workspace.setVisible(true);return;}
    host.innerHTML='<div class="notation-loading" role="status">Preparing your transcription workspace…</div>';
    try{pending??=import('./editor.js').then(({createNotationWorkspace})=>createNotationWorkspace({...options,host}));const result=await pending;if(closed){result.destroy();return;}workspace=result;workspace.setVisible(wanted);}
    catch{pending=null;host.innerHTML='<div class="notation-empty"><h2>Couldn’t open transcription</h2><p>Your audio is still available. Check your connection and try again.</p><button>Try again</button></div>';host.querySelector('button').onclick=show;}
  };
  nav.querySelector('[data-workspace="transcribe"]').onclick=show;
  nav.querySelector('[data-workspace="practice"]').onclick=()=>{wanted=false;paint();host.hidden=true;workspace?.setVisible(false);};
  return {tick:time=>workspace?.tick(time),flush:()=>workspace?.flush(),destroy(){closed=true;workspace?.destroy();host.remove();}};
}
