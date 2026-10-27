// @vitest-environment happy-dom
import {beforeEach,afterEach,expect,test,vi} from 'vitest';
vi.mock('../src/js/auth.js',()=>({convex:{query:vi.fn(),mutation:vi.fn()}}));
import {convex} from '../src/js/auth.js';
import {NotationStore} from '../src/js/notation/store.js';
import {emptyScore,fraction,durationOf} from '../shared/notation.ts';
let disk,stores=[];
const storage=async(key,value)=>{if(value!==undefined)disk=structuredClone(value);return structuredClone(disk);};
beforeEach(()=>{vi.clearAllMocks();disk=null;convex.query.mockResolvedValue(null);convex.mutation.mockImplementation(async (_fn,args)=>({revision:args.baseRevision+1}));});
afterEach(()=>{stores.forEach(s=>{s.blocked=true;s.destroy();});stores=[];});
const create=()=>{const s=new NotationStore('song',vi.fn(),storage);stores.push(s);return s;};
const serverOrder=value=>Array.isArray(value)?value.map(serverOrder):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,serverOrder(value[key])])):value;
test('editing a score loaded with server object-key ordering finishes after one save',async()=>{
  const score=emptyScore(16);
  // Convex returns object fields in key order, unlike the editor's constructors.
  convex.query.mockResolvedValue({score:serverOrder(score),revision:4});
  convex.mutation.mockImplementation(async (_fn,args)=>{
    if(convex.mutation.mock.calls.length>3)throw new Error('Notation save did not converge');
    return {revision:args.baseRevision+1};
  });
  const s=create();const loaded=await s.load();s.set({...loaded,title:'Edited part'});
  await s.flush();
  expect(convex.mutation).toHaveBeenCalledTimes(1);
  expect(disk.score).toEqual(disk.baseline);
});
test('unchanged server content, repeated notifications, and reconnects do not save',async()=>{
  const score=emptyScore(16);score.bars=[{measureId:score.timeline.measures[0].id,coverage:'reviewed',hits:[]}];
  convex.query.mockResolvedValue({score:serverOrder(score),revision:8});
  const s=create();await s.load();
  for(let i=0;i<5;i++){s.set(i%2?score:serverOrder(score));await s.flush();}
  window.dispatchEvent(new Event('online'));await s.flush();
  expect(convex.mutation).not.toHaveBeenCalled();
  expect(s.onStatus).toHaveBeenLastCalledWith('saved');
});
test('imported display-only fields cannot keep the save drain dirty',async()=>{
  const s=create();await s.load();
  convex.mutation.mockImplementation(async (_fn,args)=>{
    if(convex.mutation.mock.calls.length>3)throw new Error('Notation save did not converge');
    return {revision:args.baseRevision+1};
  });
  s.set({...emptyScore(16),displayMode:'lanes'});await s.flush();
  expect(convex.mutation).toHaveBeenCalledTimes(1);expect(disk.score).toEqual(disk.baseline);
});
test('bar edits and header edits converge together after server round trips',async()=>{
  const score=emptyScore(80);score.bars=score.timeline.measures.slice(0,25).map(m=>({measureId:m.id,coverage:'reviewed',hits:[]}));
  convex.query.mockResolvedValue({score:serverOrder(score),revision:8});
  convex.mutation.mockImplementation(async (_fn,args)=>{
    if(convex.mutation.mock.calls.length>3)throw new Error('Notation save did not converge');
    return {revision:args.baseRevision+1};
  });
  const s=create();const loaded=await s.load();
  s.set({...loaded,title:'Edited part',bars:loaded.bars.map(b=>({...b,coverage:'progress'}))});await s.flush();
  expect(convex.mutation).toHaveBeenCalledTimes(2);expect(s.revision).toBe(10);
  await s.flush();expect(convex.mutation).toHaveBeenCalledTimes(2);
});
test('an already-saved acknowledgement recovers a journal from an older client',async()=>{
  const score=emptyScore(16),baseline=serverOrder(score);
  disk={score:baseline,baseline:{...score,title:'Before'},revision:7,pending:{args:{songId:'song',baseRevision:7,mutationId:'pending',header:{version:1,title:score.title,timeline:score.timeline},bars:[]},nextBaseline:score}};
  convex.query.mockResolvedValue({score:baseline,revision:7});
  convex.mutation.mockRejectedValue(Object.assign(new Error('already saved'),{data:{code:'NOTATION_UNCHANGED',revision:7}}));
  const s=create();await s.load();await s.flush();
  expect(convex.mutation).toHaveBeenCalledTimes(1);expect(convex.mutation.mock.lastCall[1].header.version).toBe(2);
  expect(disk.pending).toBeNull();expect(s.blocked).toBe(false);expect(s.revision).toBe(7);
});
test('recovery retains an undo made while a save was awaiting acknowledgement',async()=>{
  const original=emptyScore(16),changed={...original,title:'Pending edit'};
  disk={score:original,baseline:original,revision:4,pending:{args:{songId:'song',baseRevision:4,mutationId:'pending',header:{version:1,title:changed.title,timeline:changed.timeline},bars:[]},nextBaseline:changed}};
  convex.query.mockResolvedValue({score:original,revision:4});
  const s=create();await s.load();await s.flush();
  expect(convex.mutation).toHaveBeenCalledTimes(2);
  expect(convex.mutation.mock.lastCall[1]).toMatchObject({baseRevision:5,header:{title:original.title}});
  expect(disk.score).toEqual(disk.baseline);
});
test('batches a large passage, clears undone bars, and only reports Saved after acknowledgement',async()=>{
  const s=create();await s.load();const score=emptyScore(80);score.bars=score.timeline.measures.slice(0,25).map(m=>({measureId:m.id,coverage:'reviewed',hits:[]}));s.set(score);await s.flush();
  expect(convex.mutation).toHaveBeenCalledTimes(2);expect(disk.revision).toBe(2);expect(disk.score).toEqual(disk.baseline);expect(s.onStatus).toHaveBeenLastCalledWith('saved');
  s.set({...score,bars:[]});await s.flush();expect(convex.mutation).toHaveBeenCalledTimes(4);expect(disk.baseline.bars).toEqual([]);
});
test('an interrupted request retries with the same mutation ID and retains changes made while saving',async()=>{
  const s=create();await s.load();const score=emptyScore(16);s.set(score);convex.mutation.mockRejectedValueOnce(new Error('connection lost'));await expect(s.flush()).rejects.toThrow();
  const first=disk.pending.args.mutationId;s.set({...score,title:'Revised part'});await s.flush();expect(convex.mutation.mock.calls[1][1].mutationId).toBe(first);expect(disk.score.title).toBe('Revised part');expect(disk.baseline.title).toBe('Revised part');
});
test('conflicts preserve the journal and never overwrite the other revision',async()=>{
  const s=create();await s.load();s.set(emptyScore(16));const conflict=Object.assign(new Error('conflict'),{data:{code:'NOTATION_CONFLICT'}});convex.mutation.mockRejectedValue(conflict);
  await expect(s.flush()).rejects.toThrow('conflict');expect(s.blocked).toBe(true);expect(disk.score).not.toBeNull();expect(s.onStatus).toHaveBeenLastCalledWith('conflict');
  window.dispatchEvent(new Event('online'));expect(convex.mutation).toHaveBeenCalledTimes(1);
});

test('reload replays an interrupted save without comparing its acknowledgement to a stale query',async()=>{
  const first=create();await first.load();const score=emptyScore(16);first.set(score);convex.mutation.mockRejectedValueOnce(new Error('lost'));await expect(first.flush()).rejects.toThrow();
  const pendingId=disk.pending.args.mutationId;first.blocked=true;first.destroy();
  // The query sees revision zero; retry commits revision one after that snapshot.
  const recovered=create();await recovered.load();expect(recovered.blocked).toBe(false);expect(recovered.revision).toBe(1);expect(convex.mutation.mock.lastCall[1].mutationId).toBe(pendingId);await recovered.flush();expect(disk.pending).toBeNull();expect(disk.score).toEqual(disk.baseline);
});

const hitV1=(id,instrument,offset,value=8)=>({id,offset,duration:durationOf(value),instrument,voice:instrument==='kick'?2:1,value,dotted:false,tuplet:1,accent:true,ghost:false,flam:false,sticking:'L',velocity:.8});
const v1Score=score=>({version:1,title:score.title,timeline:score.timeline,bars:score.timeline.measures.slice(0,2).map((m,i)=>({measureId:m.id,coverage:'progress',hits:[hitV1('snare'+i,'snare',fraction(1),4),hitV1('kick'+i,'kick',fraction(0),4),hitV1('rest'+i,'rest',fraction(2),2)]}))});
const upgradedHit=(id,instrument,offset)=>({id,offset,instrument,voice:instrument==='kick'?2:1,accent:true,ghost:false,flam:false,sticking:'L',velocity:.8});
test('a version 1 part loads as version 2 without saving until it is edited',async()=>{
  const old=v1Score(emptyScore(16));convex.query.mockResolvedValue({score:serverOrder(old),revision:3});
  const s=create();const loaded=await s.load();
  expect(loaded).toMatchObject({version:2,title:old.title});
  expect(Object.fromEntries(loaded.bars.map(b=>[b.measureId,b.hits]))).toEqual(Object.fromEntries(old.bars.map((b,i)=>[b.measureId,[upgradedHit('snare'+i,'snare',fraction(1)),upgradedHit('kick'+i,'kick',fraction(0))]])));
  s.set(old);s.set(loaded);await s.flush();
  expect(convex.mutation).not.toHaveBeenCalled();expect(s.onStatus).toHaveBeenLastCalledWith('saved');
  s.set({...loaded,bars:[{...loaded.bars[0],coverage:'reviewed'},loaded.bars[1]]});await s.flush();
  expect(convex.mutation).toHaveBeenCalledTimes(1);
  expect(convex.mutation.mock.lastCall[1]).toMatchObject({baseRevision:3,header:{version:2},bars:[{measureId:loaded.bars[0].measureId,coverage:'reviewed',hits:loaded.bars[0].hits}]});
});
test('a version 1 journal replays its pending save as version 2',async()=>{
  const base=emptyScore(16),old=v1Score(base),edited={...old,title:'Pending edit'};
  disk={score:edited,baseline:old,revision:2,pending:{args:{songId:'song',baseRevision:2,mutationId:'pending-v1',header:{version:1,title:edited.title,timeline:edited.timeline},bars:edited.bars},nextBaseline:edited}};
  convex.query.mockResolvedValue({score:old,revision:2});
  const s=create();await s.load();await s.flush();
  expect(convex.mutation).toHaveBeenCalledTimes(1);
  const args=convex.mutation.mock.lastCall[1];
  expect(args).toMatchObject({mutationId:'pending-v1',baseRevision:2,header:{version:2,title:'Pending edit',timeline:base.timeline}});
  expect(args.bars).toEqual(old.bars.map((b,i)=>({measureId:b.measureId,coverage:'progress',hits:[upgradedHit('snare'+i,'snare',fraction(1)),upgradedHit('kick'+i,'kick',fraction(0))]})));
  expect(disk.pending).toBeNull();expect(disk.score).toEqual(disk.baseline);expect(disk.baseline).toMatchObject({version:2,title:'Pending edit'});expect(s.revision).toBe(3);
});
test('the stem layout is saved in the header and survives reloads',async()=>{
  const score=emptyScore(16);convex.query.mockResolvedValue({score,revision:1});
  const s=create();const loaded=await s.load();s.set({...loaded,layout:'split'});await s.flush();
  expect(convex.mutation).toHaveBeenCalledTimes(1);
  expect(convex.mutation.mock.lastCall[1]).toMatchObject({header:{version:2,layout:'split',title:score.title},bars:[]});
  expect(disk.baseline.layout).toBe('split');
  convex.query.mockResolvedValue({score:serverOrder({...score,layout:'split'}),revision:2});
  expect((await s.reload()).layout).toBe('split');
  s.set({...loaded,layout:'split'});await s.flush();expect(convex.mutation).toHaveBeenCalledTimes(1);
  s.set(loaded);await s.flush();
  expect(convex.mutation).toHaveBeenCalledTimes(2);expect(convex.mutation.mock.lastCall[1].header).not.toHaveProperty('layout');
});
