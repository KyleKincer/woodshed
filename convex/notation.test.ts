/// <reference types="vite/client" />
import {convexTest} from 'convex-test';
import {test,expect} from 'vitest';
import {anyApi as api} from 'convex/server';
import schema from './schema';
import {emptyScore,fraction,durationOf} from '../shared/notation';
const modules=import.meta.glob('./**/*.ts');
async function setup(){const t=convexTest(schema,modules),alice=t.withIdentity({subject:'alice'}),bob=t.withIdentity({subject:'bob'});const songId=await t.run(ctx=>ctx.db.insert('songs',{userId:'alice',title:'Test',duration:20,addedAt:1,stems:[{name:'drums',key:'drums'}],stemMode:'full',quality:{model:'htdemucs',shifts:0,overlap:.25,format:'opus'}}));const score=emptyScore(20);const {bars,...header}=score;const args={songId,baseRevision:0,mutationId:'first',header,bars};return {t,alice,bob,songId,score,args};}
test('writes require ownership and writable account access; retries do not duplicate revisions',async()=>{
  const {t,alice,bob,songId,args}=await setup();await expect(t.mutation(api.notation.save,args)).rejects.toThrow('Not signed');await expect(bob.mutation(api.notation.save,args)).rejects.toThrow('unavailable');
  expect(await alice.mutation(api.notation.save,args)).toEqual({revision:1});expect(await alice.mutation(api.notation.save,args)).toEqual({revision:1});
  await expect(alice.mutation(api.notation.save,{...args,mutationId:'other'})).rejects.toThrow('NOTATION_CONFLICT');
  await t.run(ctx=>ctx.db.insert('accountControls',{userId:'alice',status:'export_only',notes:''}));await expect(alice.mutation(api.notation.save,{...args,baseRevision:1,mutationId:'blocked'})).rejects.toThrow('export-only');
  expect((await alice.query(api.notation.get,{songId})).revision).toBe(1);
});
test('score validation rejects corrupt positions and unsafe updates atomically',async()=>{
  const {alice,args,score}=await setup();const bar={measureId:score.timeline.measures[0].id,coverage:'progress',hits:[{id:'hit',offset:fraction(4),duration:durationOf(8),value:8,voice:1,instrument:'snare',dotted:false,tuplet:1,accent:false,ghost:false,flam:false,sticking:'',velocity:.75}]};
  await expect(alice.mutation(api.notation.save,{...args,bars:[bar]})).rejects.toThrow('does not fit');expect(await alice.query(api.notation.get,{songId:args.songId})).toBeNull();
  await expect(alice.mutation(api.notation.save,{...args,header:{...args.header,timeline:{...args.header.timeline,anchors:[{position:fraction(0),time:0},{position:fraction(0),time:1}]}}})).rejects.toThrow('forward');
});
test('sharing inclusion and revocation govern read-only score access',async()=>{
  const {t,alice,bob,args,songId}=await setup();await alice.mutation(api.notation.save,args);const {token}=await alice.mutation(api.sharing.create,{id:songId});
  expect((await t.query(api.notation.get,{token})).score.title).toBe('Drums');await expect(bob.query(api.notation.get,{songId})).rejects.toThrow('unavailable');
  await alice.mutation(api.sharing.create,{id:songId,includeNotation:false});expect(await t.query(api.notation.get,{token})).toBeNull();
  await alice.mutation(api.sharing.create,{id:songId,includeNotation:true});await alice.mutation(api.sharing.revoke,{id:songId});expect(await t.query(api.notation.get,{token})).toBeNull();
  await alice.mutation(api.songs.remove,{id:songId});expect(await t.run(ctx=>ctx.db.query('notationParts').take(10))).toEqual([]);expect(await t.run(ctx=>ctx.db.query('notationBars').take(10))).toEqual([]);
});
