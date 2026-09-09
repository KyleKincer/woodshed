// @vitest-environment happy-dom
import {beforeEach,afterEach,expect,test,vi} from 'vitest';
vi.mock('../src/js/auth.js',()=>({convex:{query:vi.fn(),mutation:vi.fn()}}));
import {convex} from '../src/js/auth.js';
import {NotationStore} from '../src/js/notation/store.js';
import {emptyScore} from '../shared/notation.ts';
let disk,stores=[];
const storage=async(key,value)=>{if(value!==undefined)disk=structuredClone(value);return structuredClone(disk);};
beforeEach(()=>{vi.clearAllMocks();disk=null;convex.query.mockResolvedValue(null);convex.mutation.mockImplementation(async (_fn,args)=>({revision:args.baseRevision+1}));});
afterEach(()=>{stores.forEach(s=>{s.blocked=true;s.destroy();});stores=[];});
const create=()=>{const s=new NotationStore('song',vi.fn(),storage);stores.push(s);return s;};
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
