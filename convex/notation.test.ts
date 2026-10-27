/// <reference types="vite/client" />
import {convexTest} from 'convex-test';
import {test,expect} from 'vitest';
import {anyApi as api} from 'convex/server';
import schema from './schema';
import {emptyScore,fraction,durationOf,upgradeScore,validateScore} from '../shared/notation';
const modules=import.meta.glob('./**/*.ts');
async function setup(){const t=convexTest(schema,modules),alice=t.withIdentity({subject:'alice'}),bob=t.withIdentity({subject:'bob'});const songId=await t.run(ctx=>ctx.db.insert('songs',{userId:'alice',title:'Test',duration:20,addedAt:1,stems:[{name:'drums',key:'drums'}],stemMode:'full',quality:{model:'htdemucs',shifts:0,overlap:.25,format:'opus'}}));const score=emptyScore(20);const {bars,...header}=score;const args={songId,baseRevision:0,mutationId:'first',header,bars};return {t,alice,bob,songId,score,args};}
const hit=(id:string,instrument:string,offset=fraction(0),extra={})=>({id,offset,instrument,voice:instrument==='kick'?2:1,accent:false,ghost:false,flam:false,sticking:'',velocity:.75,...extra});
/** Desktop 1.5 and earlier web clients wrote authored durations and explicit rests. */
const hitV1=(id:string,instrument:string,offset=fraction(0),value=8)=>({id,offset,duration:durationOf(value),instrument,voice:instrument==='kick'?2:1,value,dotted:false,tuplet:1,accent:false,ghost:false,flam:false,sticking:'',velocity:.75});
const v1Header=(header:any)=>({version:1,title:header.title,timeline:header.timeline});
const snapshot=(t:any)=>t.run(async (ctx:any)=>({parts:await ctx.db.query('notationParts').collect(),bars:await ctx.db.query('notationBars').collect()}));
test('writes require ownership and writable account access; retries do not duplicate revisions',async()=>{
  const {t,alice,bob,songId,args}=await setup();await expect(t.mutation(api.notation.save,args)).rejects.toThrow('Not signed');await expect(bob.mutation(api.notation.save,args)).rejects.toThrow('unavailable');
  expect(await alice.mutation(api.notation.save,args)).toEqual({revision:1});expect(await alice.mutation(api.notation.save,args)).toEqual({revision:1});
  await expect(alice.mutation(api.notation.save,{...args,mutationId:'other'})).rejects.toThrow('NOTATION_CONFLICT');
  await t.run(ctx=>ctx.db.insert('accountControls',{userId:'alice',status:'export_only',notes:''}));await expect(alice.mutation(api.notation.save,{...args,baseRevision:1,mutationId:'blocked'})).rejects.toThrow('export-only');
  expect((await alice.query(api.notation.get,{songId})).revision).toBe(1);
});
test('score validation rejects corrupt positions, tuplets and unsafe updates atomically',async()=>{
  const {alice,args,score}=await setup();const measureId=score.timeline.measures[0].id;
  await expect(alice.mutation(api.notation.save,{...args,bars:[{measureId,coverage:'progress',hits:[hit('late','snare',fraction(4))]}]})).rejects.toThrow('does not fit');
  await expect(alice.mutation(api.notation.save,{...args,bars:[{measureId,coverage:'progress',hits:[],tuplets:[{start:fraction(3),length:fraction(2),count:3}]}]})).rejects.toThrow('Invalid tuplet');
  await expect(alice.mutation(api.notation.save,{...args,bars:[{measureId,coverage:'progress',hits:[],tuplets:[{start:fraction(0),length:fraction(2),count:3},{start:fraction(1),length:fraction(1),count:5}]}]})).rejects.toThrow('overlap');
  expect(await alice.query(api.notation.get,{songId:args.songId})).toBeNull();
  await expect(alice.mutation(api.notation.save,{...args,header:{...args.header,timeline:{...args.header.timeline,anchors:[{position:fraction(0),time:0},{position:fraction(0),time:1}]}}})).rejects.toThrow('forward');
  await expect(alice.mutation(api.notation.save,{...args,header:{...args.header,version:3}})).rejects.toThrow();
});
test('version 2 parts keep their layout and explicit tuplets',async()=>{
  const {alice,args,songId,score}=await setup();
  const triplets=[0,1,2].map(i=>hit('t'+i,'snare',fraction(i,3))),quintuplet=[0,1,2,3,4].map(i=>hit('q'+i,'closedHat',fraction(10+i,5),i?{}:{roll:2}));
  const bar={measureId:score.timeline.measures[0].id,coverage:'progress',hits:[...triplets,...quintuplet,hit('k','kick',fraction(0),{heavy:true}),hit('f','rackTom',fraction(3),{flam:true,drag:true})],tuplets:[{start:fraction(2),length:fraction(1),count:5,voice:1}]};
  const header={...args.header,layout:'split'};
  expect(await alice.mutation(api.notation.save,{...args,header,bars:[bar]})).toEqual({revision:1});
  const saved=(await alice.query(api.notation.get,{songId})).score;
  expect(saved).toEqual({...header,bars:[bar]});
  expect(()=>validateScore(saved)).not.toThrow();
  // Switching back to the default layout clears the stored field.
  await alice.mutation(api.notation.save,{...args,baseRevision:1,mutationId:'combined',header:args.header,bars:[]});
  const combined=(await alice.query(api.notation.get,{songId})).score;
  expect(combined.layout).toBeUndefined();expect(combined.bars).toEqual([bar]);
});
test('desktop 1.5 clients keep saving version 1 parts unchanged',async()=>{
  const {alice,args,songId,score}=await setup();const header=v1Header(args.header);
  const bar={measureId:score.timeline.measures[0].id,coverage:'progress',hits:[hitV1('hat','closedHat'),hitV1('snare','snare',fraction(1),4),{...hitV1('rest','rest',fraction(2),2),voice:1}]};
  expect(await alice.mutation(api.notation.save,{...args,header,bars:[bar]})).toEqual({revision:1});
  expect(await alice.mutation(api.notation.save,{...args,baseRevision:1,mutationId:'second',header:{...header,title:'Old client'},bars:[]})).toEqual({revision:2});
  // The old client reads back exactly what it wrote.
  expect(await alice.query(api.notation.get,{songId})).toEqual({score:{...header,title:'Old client',bars:[bar]},revision:2});
});
test('an outdated client cannot write version 1 over a version 2 part',async()=>{
  const {t,alice,args,songId,score}=await setup();
  const bar={measureId:score.timeline.measures[0].id,coverage:'progress',hits:[hit('snare','snare',fraction(1,3))]};
  await alice.mutation(api.notation.save,{...args,header:{...args.header,layout:'split'},bars:[bar]});
  const before=await snapshot(t);
  const old={...args,baseRevision:1,mutationId:'old',header:v1Header(args.header),bars:[{measureId:bar.measureId,coverage:'reviewed',hits:[hitV1('kick','kick')]}]};
  await expect(alice.mutation(api.notation.save,old)).rejects.toMatchObject({data:{code:'NOTATION_UPGRADE_REQUIRED'}});
  await expect(alice.mutation(api.notation.save,{...old,bars:[]})).rejects.toThrow('Update Woodshed');
  expect(await snapshot(t)).toEqual(before);
  expect((await alice.query(api.notation.get,{songId})).score).toMatchObject({version:2,layout:'split',bars:[bar]});
});
test('upgrading a version 1 part keeps its untouched version 1 bars readable',async()=>{
  const {alice,args,songId,score}=await setup();const [first,second]=score.timeline.measures;
  const oldFirst={measureId:first.id,coverage:'reviewed',hits:[hitV1('hat','closedHat'),hitV1('kick','kick',fraction(0),4),hitV1('rest','rest',fraction(1),4)]};
  const oldSecond={measureId:second.id,coverage:'progress',hits:[hitV1('snare','snare',fraction(1),4)]};
  await alice.mutation(api.notation.save,{...args,header:v1Header(args.header),bars:[oldFirst,oldSecond]});
  // A current client loads, upgrades in memory, and writes only the bar it edited.
  const newSecond={measureId:second.id,coverage:'progress',hits:[hit('snare','snare',fraction(1)),hit('ghost','snare',fraction(7,4),{ghost:true,velocity:.3})]};
  expect(await alice.mutation(api.notation.save,{...args,baseRevision:1,mutationId:'upgrade',bars:[newSecond]})).toEqual({revision:2});
  const stored=(await alice.query(api.notation.get,{songId})).score;
  expect(stored.version).toBe(2);
  expect(stored.bars).toEqual(expect.arrayContaining([oldFirst,newSecond]));
  const upgraded=upgradeScore(stored);expect(()=>validateScore(upgraded)).not.toThrow();
  expect(upgraded.bars.find(b=>b.measureId===first.id)).toEqual({measureId:first.id,coverage:'reviewed',hits:[hit('hat','closedHat'),hit('kick','kick')]});
  // Mixed rows still validate on later saves that leave them untouched.
  expect(await alice.mutation(api.notation.save,{...args,baseRevision:2,mutationId:'retitle',header:{...args.header,title:'Upgraded'},bars:[]})).toEqual({revision:3});
  await expect(alice.mutation(api.notation.save,{...args,baseRevision:3,mutationId:'old',header:v1Header(args.header),bars:[]})).rejects.toThrow('NOTATION_UPGRADE_REQUIRED');
});
test('sharing inclusion and revocation govern read-only score access',async()=>{
  const {t,alice,bob,args,songId}=await setup();await alice.mutation(api.notation.save,args);const {token}=await alice.mutation(api.sharing.create,{id:songId});
  expect((await t.query(api.notation.get,{token})).score.title).toBe('Drums');await expect(bob.query(api.notation.get,{songId})).rejects.toThrow('unavailable');
  await alice.mutation(api.sharing.create,{id:songId,includeNotation:false});expect(await t.query(api.notation.get,{token})).toBeNull();
  await alice.mutation(api.sharing.create,{id:songId,includeNotation:true});await alice.mutation(api.sharing.revoke,{id:songId});expect(await t.query(api.notation.get,{token})).toBeNull();
  await alice.mutation(api.songs.remove,{id:songId});expect(await t.run(ctx=>ctx.db.query('notationParts').take(10))).toEqual([]);expect(await t.run(ctx=>ctx.db.query('notationBars').take(10))).toEqual([]);
});
test('desktop 1.5 request shapes preserve web notation and its sharing preference',async()=>{
  const {t,alice,args,songId}=await setup();await alice.mutation(api.notation.save,args);
  const before=await alice.query(api.notation.get,{songId});
  // Existing desktop clients know only the original song settings and omit the
  // new inclusion argument when retrieving or creating an active share link.
  await alice.mutation(api.songs.saveTempo,{id:songId,tempo:{source:'manual',map:[{t:0,bpm:87,beatsPerBar:4,unit:4}]}});
  await alice.mutation(api.songs.savePractice,{id:songId,practice:{rate:.75,loop:{enabled:true,a:1,b:4},tracks:[]}});
  const {token}=await alice.mutation(api.sharing.create,{id:songId,includeNotation:false});
  expect(await alice.mutation(api.sharing.create,{id:songId})).toEqual({token});
  expect(await alice.query(api.notation.get,{songId})).toEqual(before);
  expect(await t.query(api.notation.get,{token})).toBeNull();
  expect((await alice.query(api.songs.get,{id:songId}))?.practice.rate).toBe(.75);
});
test('independent drum rhythms round-trip through saves and shared parts',async()=>{
  const {t,alice,args,songId,score}=await setup();
  const bar={measureId:score.timeline.measures[0].id,coverage:'progress',hits:[hit('hat','closedHat',fraction(0),{accent:true}),hit('hat2','closedHat',fraction(1,2)),hit('snare','snare',fraction(1),{sticking:'R'}),hit('kick','kick',fraction(3,4))]};
  await alice.mutation(api.notation.save,{...args,bars:[bar]});
  expect((await alice.query(api.notation.get,{songId})).score.bars).toEqual([bar]);
  const {token}=await alice.mutation(api.sharing.create,{id:songId});
  expect((await t.query(api.notation.get,{token})).score.bars).toEqual([bar]);
});
test('unchanged legacy saves stop without revising the part or rewriting bars',async()=>{
  const {t,alice,args,songId,score}=await setup();
  const bar={measureId:score.timeline.measures[0].id,coverage:'reviewed',hits:[]};
  await alice.mutation(api.notation.save,{...args,bars:[bar]});
  const before=await snapshot(t);
  for(const bars of [[],[bar]]){
    const result=alice.mutation(api.notation.save,{...args,baseRevision:1,mutationId:'loop',bars});
    await expect(result).rejects.toThrow('NOTATION_UNCHANGED');
  }
  expect(await snapshot(t)).toEqual(before);
  expect((await alice.query(api.notation.get,{songId})).revision).toBe(1);
  await alice.mutation(api.notation.save,{...args,baseRevision:1,mutationId:'edit',header:{...args.header,title:'Updated title'}});
  expect((await alice.query(api.notation.get,{songId})).revision).toBe(2);
});
