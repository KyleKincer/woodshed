// I1: on the 2.0 API client (the 1.9 src/js/auth.js is gone). Owner calls use the
// authenticated client; share-token reads use the public client, so a signed-out
// Shared Stage visitor never reaches an uninitialized client.
import {query, mutation, publicClient} from '../../api/client.js';
const convex = {query, mutation};
import {anyApi as api} from 'convex/server';
import {sameContent as equal} from '../../../shared/content.ts';
import {upgradeScore,upgradeBar} from '../../../shared/notation.ts';
const openDB=()=>new Promise((resolve,reject)=>{const request=indexedDB.open('woodshed-notation',1);request.onupgradeneeded=()=>request.result.createObjectStore('drafts');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
async function journal(key,value){const db=await openDB();try{return await new Promise((resolve,reject)=>{const tx=db.transaction('drafts',value===undefined?'readonly':'readwrite'),store=tx.objectStore('drafts');const request=value===undefined?store.get(key):store.put(value,key);tx.oncomplete=()=>resolve(request.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}finally{db.close();}}
const clone=value=>structuredClone(value);
const header=score=>({version:score.version,title:score.title,...(score.layout?{layout:score.layout}:{}),timeline:score.timeline});
const canonical=input=>{if(!input)return null;const score=upgradeScore(input);return {...header(clone(score)),bars:score.bars.filter(b=>b.hits.length||b.coverage!=='unstarted').map(clone).sort((a,b)=>a.measureId.localeCompare(b.measureId))};};
async function savePart(args){
  try{return await convex.mutation(api.notation.save,args);}
  catch(error){if(error.data?.code!=='NOTATION_UNCHANGED')throw error;return {revision:error.data.revision};}
}

/** Acknowledged revisions, a durable local journal, and serialized idempotent writes. */
export class NotationStore {
  constructor(songId,onStatus=()=>{},storage=journal){this.storage=storage;this.songId=songId;this.onStatus=onStatus;this.revision=0;this.baseline=null;this.score=null;this.pending=null;this.running=null;this.blocked=false;this.closed=false;this.timer=null;this.disk=Promise.resolve();this.diskPending=0;this.diskFailed=false;this.online=()=>{if(!this.blocked)void this.flush().catch(()=>{});};this.beforeUnload=e=>{if(this.diskPending||this.diskFailed){e.preventDefault();e.returnValue='';}};window.addEventListener('online',this.online);window.addEventListener('beforeunload',this.beforeUnload);}
  async load(){
    const [remote,draft]=await Promise.all([convex.query(api.notation.get,{songId:this.songId}),this.storage(this.songId).catch(()=>null)]);
    if(remote)remote.score=canonical(remote.score);
    this.baseline=remote?.score??null;this.revision=remote?.revision??0;
    if(draft?.score&&(draft.pending||!equal(canonical(draft.score),canonical(draft.baseline)))){
      this.score=canonical(draft.score);this.baseline=canonical(draft.baseline);this.revision=draft.revision;this.pending=draft.pending;
      if(this.pending){this.pending.nextBaseline=canonical(this.pending.nextBaseline);
        // A journal written before derived-rhythm notation replays as version 2.
        const args=this.pending.args;if(args.header?.version===1)this.pending.args={...args,header:header(upgradeScore({...args.header,bars:[]})),bars:args.bars.map(upgradeBar)};}
      let replayed=false;
      if(this.pending){try{const result=await savePart(this.pending.args);this.revision=result.revision;this.baseline=this.pending.nextBaseline;this.pending=null;replayed=true;await this.persist();}catch(error){if(error.data?.code==='NOTATION_CONFLICT')this.blocked=true;}}
      // A successful replay is newer than the remote snapshot fetched above.
      if(!replayed&&!this.pending&&this.revision!==(remote?.revision??0)&&!equal(this.baseline,remote?.score))this.blocked=true;
      this.onStatus(this.blocked?'conflict':'local');
      if(!this.blocked)this.timer=setTimeout(()=>void this.flush().catch(()=>{}),650);
    }else{this.score=clone(remote?.score??null);this.onStatus('saved');}
    return this.score;
  }
  persist(){const value=clone({score:this.score,baseline:this.baseline,revision:this.revision,pending:this.pending});this.diskPending++;this.disk=this.disk.catch(()=>{}).then(()=>this.storage(this.songId,value)).then(result=>{this.diskFailed=false;return result;},error=>{this.diskFailed=true;throw error;}).finally(()=>{this.diskPending--;});return this.disk;}
  set(score){const next=canonical(score);if(equal(next,this.score))return;this.score=next;this.onStatus(this.blocked?'conflict':'local');void this.persist().catch(()=>this.onStatus('storage-error'));clearTimeout(this.timer);this.timer=setTimeout(()=>void this.flush().catch(()=>{}),650);}
  async flush(){clearTimeout(this.timer);if(this.running)return this.running;if(this.blocked)throw new Error('Resolve the notation conflict before sharing.');
    this.running=this.drain().finally(()=>{this.running=null;});return this.running;
  }
  async drain(){
    try{
      await this.disk;
      while(this.score&&!equal(this.score,this.baseline)){
        this.onStatus('saving');
        if(!this.pending){const score=clone(this.score),removed=(this.baseline?.bars||[]).filter(b=>!score.bars.some(s=>s.measureId===b.measureId)&&score.timeline.measures.some(m=>m.id===b.measureId)).map(b=>({measureId:b.measureId,coverage:'unstarted',hits:[]}));
          const changed=[...removed,...score.bars.filter(bar=>!equal(bar,this.baseline?.bars.find(b=>b.measureId===bar.measureId)))].slice(0,16);
          const nextBaseline={...header(score),bars:[...(this.baseline?.bars||[]).filter(b=>score.timeline.measures.some(m=>m.id===b.measureId)&&!changed.some(c=>c.measureId===b.measureId)),...changed]};
          // Canonical ordering avoids writing forever after a bar edit.
          this.pending={args:{songId:this.songId,baseRevision:this.revision,mutationId:crypto.randomUUID(),header:header(score),bars:changed},nextBaseline:canonical(nextBaseline)};await this.persist();
        }
        const result=await savePart(this.pending.args);
        this.revision=result.revision;this.baseline=this.pending.nextBaseline;this.pending=null;await this.persist();
      }
      this.onStatus('saved');
    }catch(error){if(error.data?.code==='NOTATION_CONFLICT'){this.blocked=true;this.onStatus('conflict');}else this.onStatus(this.diskFailed?'storage-error':'offline');throw error;}
  }
  async reload(){if(this.running)await this.running.catch(()=>{});const remote=await convex.query(api.notation.get,{songId:this.songId});this.score=canonical(remote?.score??null);this.baseline=clone(this.score);this.revision=remote?.revision??0;this.pending=null;this.blocked=false;await this.persist();this.onStatus('saved');return this.score;}
  destroy(){this.closed=true;clearTimeout(this.timer);window.removeEventListener('online',this.online);void this.flush().catch(()=>{}).finally(()=>window.removeEventListener('beforeunload',this.beforeUnload));}
}
export const loadSharedNotation=token=>publicClient().query(api.notation.get,{token});
export const watchSharedNotation=(token,onChange,onError)=>publicClient().subscribe(api.notation.get,{token},onChange,onError);
