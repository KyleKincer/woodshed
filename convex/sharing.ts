import {v, ConvexError} from 'convex/values';
import {query,mutation,internalQuery,internalMutation} from './_generated/server';
import type {QueryCtx,MutationCtx} from './_generated/server';
import type {Doc,Id} from './_generated/dataModel';
import {internal} from './_generated/api';
import {requireUserId,requireWritableUserId,getUserId,accountControl} from './lib/auth';
import {coverKeyOf} from './lib/songMetadata';
import {adjust,limits,used,retireKey} from './storage';

const unavailable = () => new ConvexError('This share link is unavailable. It may have been stopped or the song removed.');
const tokenValid = (token:string) => /^[a-f0-9]{64}$/.test(token);
export async function sharedSource(ctx:QueryCtx|MutationCtx,token:string) {
  if(!tokenValid(token))return null;
  const share=await ctx.db.query('songShares').withIndex('by_token',q=>q.eq('token',token)).unique();
  if(!share?.active)return null;
  const song=await ctx.db.get(share.songId);
  if(!song || song.userId!==share.userId || (await accountControl(ctx,share.userId))?.status==='suspended')return null;
  if(!song.stems.length || song.stems.length>8)return null;
  for(const key of song.stems.map(s=>s.key)) {
    const object=await ctx.db.query('audioObjects').withIndex('by_key',q=>q.eq('key',key)).unique();
    if(object && object.status!=='ready')return null;
  }
  return song;
}
function pick(value:unknown,keys:string[]) {
  const row=value && typeof value==='object' ? value as Record<string,unknown> : {};
  return Object.fromEntries(keys.filter(k=>['string','number','boolean'].includes(typeof row[k])).map(k=>[k,row[k]]));
}
function practiceSettings(value:unknown) {
  if(!value || typeof value!=='object')return undefined;
  const p=value as Record<string,unknown>;
  return {...pick(p,['rate']),loop:pick(p.loop,['enabled','a','b']),grid:pick(p.grid,['visible','snap','division']),
    tracks:Array.isArray(p.tracks)?p.tracks.slice(0,8).map(t=>pick(t,['name','volume','muted','soloed'])):[]};
}
function tempoSettings(value:unknown) {
  if(!value || typeof value!=='object')return undefined;
  const t=value as Record<string,unknown>;
  return {...pick(t,['accent','volume','countIn','countInLength','countInUnit','audiblePreRoll','enabled','source']),
    map:Array.isArray(t.map)?t.map.slice(0,8192).map(s=>pick(s,['t','bpm','beatsPerBar','unit'])):[],
    detected:Array.isArray(t.detected)?t.detected.slice(0,8192).map(b=>pick(b,['time','downbeat'])):null};
}
// Explicit allowlist: no notes, personal tags, source file paths or account IDs.
export function sharedSnapshot(song:Doc<'songs'>) {
  return {
    title:song.title, artist:song.artist || song.uploader || '', album:song.album || '',
    albumArtist:song.albumArtist || '', year:song.year || '', genre:song.genre || '',
    trackNumber:song.trackNumber || '', discNumber:song.discNumber || '',
    musicalKey:song.musicalKey || '', tuning:song.tuning || '',
    duration:song.duration, stems:song.stems, stemMode:song.stemMode, quality:song.quality,
    coverKey:coverKeyOf(song), artwork:song.artwork?.kind==='release'?song.artwork:undefined,
    tempo:tempoSettings(song.tempo), practice:practiceSettings(song.practice),
  };
}
export const status=query({
  args:{id:v.id('songs')},handler:async(ctx,{id})=>{
    const userId=await requireUserId(ctx),song=await ctx.db.get(id);
    if(!song||song.userId!==userId)throw new ConvexError('Song unavailable.');
    const share=await ctx.db.query('songShares').withIndex('by_songId',q=>q.eq('songId',id)).unique();
    return share?.active?{token:share.token}:null;
  },
});
export const create=mutation({
  args:{id:v.id('songs')},handler:async(ctx,{id})=>{
    const userId=await requireWritableUserId(ctx),song=await ctx.db.get(id);
    if(!song||song.userId!==userId)throw new ConvexError('Song unavailable.');
    if(!song.stems.length||song.stems.length>8)throw new ConvexError('Finish processing this song before sharing it.');
    for(const stem of song.stems){const o=await ctx.db.query('audioObjects').withIndex('by_key',q=>q.eq('key',stem.key)).unique();if(o&&o.status!=='ready')throw new ConvexError('Finish syncing this song before sharing it.');}
    const existing=await ctx.db.query('songShares').withIndex('by_songId',q=>q.eq('songId',id)).unique();
    if(existing?.active)return {token:existing.token};
    const token=(crypto.randomUUID()+crypto.randomUUID()).replaceAll('-','');
    if(existing)await ctx.db.patch(existing._id,{token,active:true,createdAt:Date.now()});
    else await ctx.db.insert('songShares',{songId:id,userId,token,active:true,createdAt:Date.now()});
    return {token};
  },
});
export const revoke=mutation({
  args:{id:v.id('songs')},handler:async(ctx,{id})=>{
    const userId=await requireUserId(ctx),share=await ctx.db.query('songShares').withIndex('by_songId',q=>q.eq('songId',id)).unique();
    if(share&&share.userId!==userId)throw new ConvexError('Not your share link.');
    if(share)await ctx.db.patch(share._id,{active:false});
    return null;
  },
});
export const view=query({
  args:{token:v.string()},handler:async(ctx,{token})=>{
    const song=await sharedSource(ctx,token);if(!song)return null;
    const snapshot=sharedSnapshot(song);
    // File IDs are opaque to visitors; signing is a separate, scoped endpoint.
    return {...snapshot,id:'shared',revision:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(song.stems.map(s=>s.key).join('|')))),b=>b.toString(16).padStart(2,'0')).join(''),coverKey:snapshot.coverKey?'cover':null,
      coverUrl:snapshot.artwork?`https://coverartarchive.org/release/${snapshot.artwork.releaseId}/front-500`:null,
      stems:snapshot.stems.map((s,i)=>({name:s.name,key:`stem-${i}`}))};
  },
});
export const mediaContext=internalQuery({
  args:{token:v.string()},handler:async(ctx,{token})=>{
    const song=await sharedSource(ctx,token);if(!song)throw unavailable();
    const cover=coverKeyOf(song);
    return [...song.stems.map((s,i)=>({id:`stem-${i}`,key:s.key})),...(cover?[{id:'cover',key:cover}]:[])];
  },
});
export const saved=query({
  args:{token:v.string()},handler:async(ctx,{token})=>{
    const userId=await getUserId(ctx);if(!userId)return null;
    const song=await sharedSource(ctx,token);if(!song)return null;
    if(song.userId===userId)return {songId:song._id,status:'ready'};
    const saved=await ctx.db.query('shareImports').withIndex('by_userId_and_sourceSongId',q=>q.eq('userId',userId).eq('sourceSongId',song._id)).unique();
    if(saved?.songId && await ctx.db.get(saved.songId))return {songId:saved.songId,status:'ready'};
    return saved?.status==='copying'?{songId:null,status:'copying'}:null;
  },
});
export const importContext=internalQuery({
  args:{token:v.string()},handler:async(ctx,{token})=>{
    await requireWritableUserId(ctx);const song=await sharedSource(ctx,token);if(!song)throw unavailable();
    return sharedSnapshot(song);
  },
});
const headValidator=v.object({sourceKey:v.string(),bytes:v.number(),mime:v.string(),etag:v.string()});
export const beginImport=internalMutation({
  args:{token:v.string(),heads:v.array(headValidator)},handler:async(ctx,{token,heads})=>{
    const userId=await requireWritableUserId(ctx),song=await sharedSource(ctx,token);if(!song)throw unavailable();
    if(song.userId===userId)return {songId:song._id};
    const existing=await ctx.db.query('shareImports').withIndex('by_userId_and_sourceSongId',q=>q.eq('userId',userId).eq('sourceSongId',song._id)).unique();
    if(existing?.songId && await ctx.db.get(existing.songId))return {songId:existing.songId};
    if(existing?.status==='copying')throw new ConvexError('This song is already being added. Please wait.');
    const snapshot=sharedSnapshot(song),keys=[...song.stems.map(s=>s.key),...(snapshot.coverKey?[snapshot.coverKey]:[])];
    if(heads.length!==keys.length||new Set(heads.map(h=>h.sourceKey)).size!==keys.length||heads.some(h=>!keys.includes(h.sourceKey)||!Number.isSafeInteger(h.bytes)||h.bytes<1||h.bytes>250_000_000||!h.etag))throw new ConvexError('The shared audio changed. Reload the link and try again.');
    if((await ctx.db.query('songs').withIndex('by_user',q=>q.eq('userId',userId)).take(1000)).length>=1000)throw new ConvexError('Your library has reached its song limit. Remove a song before adding another.');
    const bytes=heads.reduce((n,h)=>n+h.bytes,0),policy=await limits(ctx,userId);
    if(await used(ctx,`user:${userId}`)+bytes>policy.userBytes)throw new ConvexError('Your cloud library is full. Upgrade or remove songs, then try again.');
    if(await used(ctx,'app')+bytes>policy.appBytes)throw new ConvexError('Cloud storage is currently full. Try adding this song later.');
    const attempt=crypto.randomUUID(),expiresAt=Date.now()+15*60_000;
    await adjust(ctx,userId,bytes);
    const files=[];
    for(const [i,h] of heads.entries()){
      const key=`users/${encodeURIComponent(userId)}/shared/${attempt}/${i}`;
      const objectId=await ctx.db.insert('audioObjects',{userId,key,name:`shared-${i}`,bytes:h.bytes,mime:h.mime,checksum:'',expiresAt,status:'reserved'});
      files.push({...h,key,objectId});
    }
    const row={userId,sourceSongId:song._id,token,attempt,status:'copying' as const,snapshot,expiresAt,files,songId:undefined};
    let id=existing?existing._id:await ctx.db.insert('shareImports',row);
    if(existing)await ctx.db.replace(id,row);
    await ctx.scheduler.runAt(expiresAt,internal.sharing.failImport,{id,attempt});
    return {id,attempt,files};
  },
});
export const finishImport=internalMutation({
  args:{id:v.id('shareImports'),attempt:v.string()},handler:async(ctx,{id,attempt})=>{
    const userId=await requireWritableUserId(ctx),row=await ctx.db.get(id);
    if(!row||row.userId!==userId||row.attempt!==attempt)throw new ConvexError('Import unavailable.');
    if(row.status==='ready'&&row.songId)return row.songId;
    if(row.status!=='copying'||row.expiresAt<=Date.now())throw new ConvexError('Adding this song timed out. Please try again.');
    if(!await sharedSource(ctx,row.token))throw unavailable();
    const keyMap=new Map(row.files.map(f=>[f.sourceKey,f.key]));
    const snapshot=row.snapshot;
    const songId=await ctx.db.insert('songs',{...snapshot,userId,addedAt:Date.now(),
      stems:snapshot.stems.map((s:{name:string,key:string})=>{const f=row.files.find(f=>f.sourceKey===s.key)!;return {name:s.name,key:f.key,bytes:f.bytes,mime:f.mime};}),
      coverKey:snapshot.coverKey?keyMap.get(snapshot.coverKey):undefined});
    for(const f of row.files){const object=await ctx.db.get(f.objectId);if(object?.status!=='reserved')throw new ConvexError('Import expired.');await ctx.db.patch(f.objectId,{status:'ready',songId,verified:true});}
    await ctx.db.patch(id,{status:'ready',songId,snapshot:null,files:[]});return songId;
  },
});
export const failImport=internalMutation({
  args:{id:v.id('shareImports'),attempt:v.string()},handler:async(ctx,{id,attempt})=>{
    const row=await ctx.db.get(id);if(!row||row.attempt!==attempt||row.status!=='copying')return null;
    for(const f of row.files)await retireKey(ctx,f.key);
    await ctx.db.patch(id,{status:'failed',snapshot:null,files:[]});return null;
  },
});
