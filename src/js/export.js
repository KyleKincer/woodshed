import { Zip, ZipPassThrough } from 'fflate';
import * as backend from './backend.js';
const encoder = new TextEncoder();
const safe = text => String(text).replace(/[^\p{L}\p{N}._ -]/gu,'_').slice(0,100) || 'song';

/** Audio is already compressed. Stream a ZIP without recompressing/buffering it. */
export async function exportLibrary(onProgress = () => {}) {
  // Pick the destination during the click gesture, before network awaits.
  const handle = window.showSaveFilePicker ? await window.showSaveFilePicker({suggestedName:'Woodshed-library.zip',types:[{description:'ZIP archive',accept:{'application/zip':['.zip']}}]}) : null;
  const songs=[];let cursor=null, page;
  do {page=await backend.exportPage(cursor);songs.push(...page.page);cursor=page.continueCursor;} while(!page.isDone);
  const total=songs.reduce((sum,s)=>sum+s.stems.reduce((n,t)=>n+(t.bytes||0),0),0);
  const fallbackLimit=100_000_000;
  if(!handle && total>fallbackLimit) throw new Error('This browser cannot stream a large archive to disk. Export from Chrome or Edge on a desktop.');
  const writer=handle?await handle.createWritable():null;
  let outputBytes=0,chain=Promise.resolve();const chunks=[];
  let finishedResolve,finishedReject;
  const finished=new Promise((resolve,reject)=>{finishedResolve=resolve;finishedReject=reject;});
  const zip=new Zip((error,chunk,final)=>{
    if(error){finishedReject(error);return;}
    outputBytes+=chunk.length;
    chain=chain.then(async()=>{
      if(writer) await writer.write(chunk);
      else {if(outputBytes>fallbackLimit) throw new Error('Archive exceeds this browser’s memory limit. Use desktop Chrome or Edge.');chunks.push(chunk);}
    });
    chain.catch(finishedReject);
    if(final) chain.then(finishedResolve,finishedReject);
  });
  // Mark rejection handled immediately while downloads are still in flight.
  finished.catch(()=>{});
  async function add(name, bytes) {const entry=new ZipPassThrough(name);zip.add(entry);entry.push(bytes,true);await chain;}
  try {
    await add('manifest.json',encoder.encode(JSON.stringify({version:1,exportedAt:new Date().toISOString(),songs},null,2)));
    const config=await backend.getConfig();await add('settings.json',encoder.encode(JSON.stringify(config.settings,null,2)));
    for(const [i,song] of songs.entries()) {
      onProgress(`Exporting ${i+1}/${songs.length}: ${song.title}`);
      const keys=[...song.stems.map(s=>s.key),...(song.coverKey?[song.coverKey]:[])];
      const urls=await backend.signKeys(keys);
      for(const key of keys) {
        const response=await fetch(urls[key]);if(!response.ok||!response.body) throw new Error(`Could not export ${song.title}.`);
        const entry=new ZipPassThrough(`${safe(song.title)}-${song.id}/${safe(key.split('/').pop())}`);zip.add(entry);
        const reader=response.body.getReader();
        while(true){const {value,done}=await reader.read();if(done)break;entry.push(value);await chain;}
        entry.push(new Uint8Array(),true);await chain;
      }
    }
    zip.end();await finished;
    if(writer) await writer.close();
    else {const url=URL.createObjectURL(new Blob(chunks,{type:'application/zip'}));const a=document.createElement('a');a.href=url;a.download='Woodshed-library.zip';a.click();setTimeout(()=>URL.revokeObjectURL(url),60_000);}
    onProgress(`Exported ${songs.length} songs.`);
  } catch(error){zip.terminate();await writer?.abort().catch(()=>{});throw error;}
}
