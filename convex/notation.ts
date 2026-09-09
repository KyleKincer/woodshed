import {v,ConvexError} from 'convex/values';
import {query,mutation} from './_generated/server';
import type {QueryCtx,MutationCtx} from './_generated/server';
import type {Id} from './_generated/dataModel';
import {requireUserId,requireWritableUserId} from './lib/auth';
import {barValidator,headerValidator} from './lib/notationValidators';
import {validateTimeline,validateBar,MAX_MEASURES,MAX_HITS} from '../shared/notation';
import {sharedSource} from './sharing';

export async function readPart(ctx:QueryCtx|MutationCtx,songId:Id<'songs'>){
  const part=await ctx.db.query('notationParts').withIndex('by_songId',q=>q.eq('songId',songId)).unique();
  if(!part)return null;
  const rows=await ctx.db.query('notationBars').withIndex('by_partId',q=>q.eq('partId',part._id)).take(MAX_MEASURES+1);
  if(rows.length>MAX_MEASURES)throw new ConvexError('Score is too large.');
  return {part,rows};
}
export async function sharedPart(ctx:QueryCtx|MutationCtx,songId:Id<'songs'>){
  const share=await ctx.db.query('songShares').withIndex('by_songId',q=>q.eq('songId',songId)).unique();
  return share?.includeNotation===false?null:readPart(ctx,songId);
}
export async function deletePart(ctx:MutationCtx,partId:Id<'notationParts'>){
  const rows=await ctx.db.query('notationBars').withIndex('by_partId',q=>q.eq('partId',partId)).take(MAX_MEASURES+1);
  for(const row of rows)await ctx.db.delete(row._id);await ctx.db.delete(partId);
}
export async function capturePart(ctx:MutationCtx,songId:Id<'songs'>,userId:string){
  const data=await sharedPart(ctx,songId);if(!data)return undefined;
  const partId=await ctx.db.insert('notationParts',{userId,header:data.part.header,revision:1,lastMutation:'shared-copy',hitCount:data.part.hitCount});
  for(const row of data.rows)await ctx.db.insert('notationBars',{partId,bar:row.bar});return partId;
}
export const get=query({args:{songId:v.optional(v.id('songs')),token:v.optional(v.string())},handler:async(ctx,args)=>{
  let songId=args.songId;
  if(args.token){const song=await sharedSource(ctx,args.token);if(!song)return null;songId=song._id;const share=await ctx.db.query('songShares').withIndex('by_songId',q=>q.eq('songId',songId!)).unique();if(share?.includeNotation===false)return null;}
  else{const userId=await requireUserId(ctx);const song=songId?await ctx.db.get(songId):null;if(!song||song.userId!==userId)throw new ConvexError('Song unavailable.');}
  const result=await readPart(ctx,songId!);return result?{score:{...result.part.header,bars:result.rows.map(r=>r.bar)},revision:result.part.revision}:null;
}});
export const save=mutation({args:{songId:v.id('songs'),baseRevision:v.number(),mutationId:v.string(),header:headerValidator,bars:v.array(barValidator)},handler:async(ctx,args)=>{
  const userId=await requireWritableUserId(ctx),song=await ctx.db.get(args.songId);if(!song||song.userId!==userId)throw new ConvexError('Song unavailable.');
  if(args.mutationId.length>100||!args.mutationId||args.bars.length>16||!Number.isSafeInteger(args.baseRevision)||args.baseRevision<0||!args.header.title.trim()||args.header.title.length>100)throw new ConvexError('Invalid score update.');
  validateTimeline(args.header.timeline);for(const bar of args.bars)validateBar(bar,args.header.timeline);
  if(new Set(args.bars.map(b=>b.measureId)).size!==args.bars.length)throw new ConvexError('Duplicate bar update.');
  const existing=await readPart(ctx,args.songId);
  if(existing?.part.lastMutation===args.mutationId)return {revision:existing.part.revision};
  if((existing?.part.revision??0)!==args.baseRevision)throw new ConvexError({code:'NOTATION_CONFLICT',message:'This part changed on another device. Your local edits are retained. Export them or load the saved version.'});
  const measureIds=new Set(args.header.timeline.measures.map(m=>m.id));
  const unchanged=(existing?.rows||[]).filter(r=>measureIds.has(r.bar.measureId)&&!args.bars.some(b=>b.measureId===r.bar.measureId));
  for(const row of unchanged)validateBar(row.bar,args.header.timeline);
  const hitCount=unchanged.reduce((n,r)=>n+r.bar.hits.length,0)+args.bars.reduce((n,b)=>n+b.hits.length,0);
  if(hitCount>MAX_HITS)throw new ConvexError(`A part can contain up to ${MAX_HITS} hits.`);
  const revision=args.baseRevision+1, fields={userId,songId:args.songId,header:args.header,revision,lastMutation:args.mutationId,hitCount};
  const partId=existing?.part._id??await ctx.db.insert('notationParts',fields);
  if(existing)await ctx.db.patch(partId,fields);
  for(const row of existing?.rows||[])if(!measureIds.has(row.bar.measureId))await ctx.db.delete(row._id);
  for(const bar of args.bars){const row=existing?.rows.find(r=>r.bar.measureId===bar.measureId);if(row)await ctx.db.patch(row._id,{bar});else await ctx.db.insert('notationBars',{partId,bar});}
  return {revision};
}});
