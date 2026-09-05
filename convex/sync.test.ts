/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { expect, test, vi, afterEach } from 'vitest';
import schema from './schema';
import { api, internal } from './_generated/api';
import { hashToken } from './devices';
const modules = import.meta.glob('./**/*.ts');
const token='a'.repeat(64), otherToken='b'.repeat(64);
const file = (bytes: number, name='drums.webm') => ({name,bytes,mime:'audio/webm',checksum:'a'.repeat(43)+'='});
afterEach(()=>vi.unstubAllEnvs());
async function setup(){
  const t=convexTest(schema,modules);
  const alice=t.withIdentity({subject:'alice'}), bob=t.withIdentity({subject:'bob'});
  const deviceId=await alice.mutation(api.devices.pair,{tokenHash:await hashToken(token),name:'desktop'});
  const other=await bob.mutation(api.devices.pair,{tokenHash:await hashToken(otherToken),name:'other'});
  const makeJob=async()=>{
    const {jobId}=await alice.mutation(api.jobs.createSeparation,{deviceId,source:{type:'search',value:'test'},settings:{preset:'fast'},label:'test'});
    await t.mutation(api.worker.claim,{token,jobId});return jobId;
  };
  return {t,alice,bob,deviceId,other,makeJob};
}
test('anonymous callers and cross-account devices cannot create jobs or take over pairing',async()=>{
 const {t,bob,deviceId}=await setup();
 await expect(t.mutation(api.jobs.createSeparation,{deviceId,settings:{},label:'test',source:{type:'search',value:'x'}})).rejects.toThrow('Not signed in');
 await expect(bob.mutation(api.jobs.createSeparation,{deviceId,settings:{},label:'test',source:{type:'search',value:'x'}})).rejects.toThrow('companion');
 await expect(bob.mutation(api.devices.pair,{tokenHash:await hashToken(token),name:'stolen'})).rejects.toThrow('another account');
});
test('quota reservation counts concurrent jobs and is idempotent',async()=>{
 vi.stubEnv('CLOUD_USER_BYTE_LIMIT','100');vi.stubEnv('CLOUD_APP_BYTE_LIMIT','150');
 const {t,alice,makeJob}=await setup();const j1=await makeJob(),j2=await makeJob();
 await t.mutation(internal.storage.reserve,{token,jobId:j1,files:[file(60)]});
 await t.mutation(internal.storage.reserve,{token,jobId:j1,files:[file(60)]});
 expect((await alice.query(api.storage.usage,{})).usedBytes).toBe(60);
 await expect(t.mutation(internal.storage.reserve,{token,jobId:j2,files:[file(50)]})).rejects.toThrow('library is full');
 expect((await alice.query(api.storage.usage,{})).usedBytes).toBe(60);
});
test('global quota cannot be bypassed by another account',async()=>{
 vi.stubEnv('CLOUD_USER_BYTE_LIMIT','100');vi.stubEnv('CLOUD_APP_BYTE_LIMIT','100');
 const {t,bob,other,makeJob}=await setup();const jobId=await makeJob();
 await t.mutation(internal.storage.reserve,{token,jobId,files:[file(60)]});
 const r=await bob.mutation(api.jobs.createSeparation,{deviceId:other,settings:{},label:'other',source:{type:'search',value:'other'}});
 await t.mutation(api.worker.claim,{token:otherToken,jobId:r.jobId});
 await expect(t.mutation(internal.storage.reserve,{token:otherToken,jobId:r.jobId,files:[file(60)]})).rejects.toThrow('Cloud storage');
});
test('completion is idempotent and only grants media and exports to owner',async()=>{
 const {t,alice,bob,makeJob}=await setup();const jobId=await makeJob();
 const rows=await t.mutation(internal.storage.reserve,{token,jobId,files:[file(100)]});
 const result={title:'Test',duration:240,stemMode:'full',quality:{model:'htdemucs',shifts:0,overlap:0.25,format:'opus' as const,bitrate:192},stems:[{name:'drums',key:rows[0].key}]};
 const id=await t.mutation(internal.worker.finish,{token,jobId,result});
 expect(await t.mutation(internal.worker.finish,{token,jobId,result})).toBe(id);
 expect((await alice.query(api.songs.list,{})).songs).toHaveLength(1);
 expect((await bob.query(api.songs.list,{})).songs).toHaveLength(0);
 expect(await alice.query(internal.media.authorizedKeys,{keys:[rows[0].key]})).toEqual([rows[0].key]);
 expect(await bob.query(internal.media.authorizedKeys,{keys:[rows[0].key]})).toEqual([]);
 expect((await bob.query(api.songs.exportPage,{paginationOpts:{cursor:null,numItems:50}})).page).toEqual([]);
 await expect(bob.mutation(api.songs.savePractice,{id,practice:{}})).rejects.toThrow('Not your song');
});
test('cancellation wins over progress and completion; revoked device loses access',async()=>{
 const {t,alice,deviceId,makeJob}=await setup();const jobId=await makeJob();
 await alice.mutation(api.jobs.cancel,{jobId});
 expect(await t.mutation(api.worker.progress,{token,jobId,stage:'separate',percent:50})).toBe(false);
 await expect(t.mutation(internal.storage.reserve,{token,jobId,files:[file(100)]})).rejects.toThrow('unavailable');
 await alice.mutation(api.devices.revoke,{deviceId});
 await expect(t.query(api.worker.next,{token})).rejects.toThrow('not paired');
});
test('deleting retains quota until blob deletion succeeds',async()=>{
 const {t,alice,makeJob}=await setup();const jobId=await makeJob();
 const [row]=await t.mutation(internal.storage.reserve,{token,jobId,files:[file(100)]});
 await t.mutation(internal.storage.expire,{id:row._id});
 expect((await alice.query(api.storage.usage,{})).usedBytes).toBe(100);
 await t.mutation(internal.storage.deleted,{id:row._id});
 await t.mutation(internal.storage.deleted,{id:row._id});
 expect((await alice.query(api.storage.usage,{})).usedBytes).toBe(0);
});
test('repeated legacy import while running returns the same job',async()=>{
 const {t}=await setup();
 const args={token,legacyId:'old-song',title:'Old song'};
 const first=await t.mutation(api.worker.importSong,args);
 if(!first.jobId) throw new Error('Expected an import job');
 await t.mutation(api.worker.claim,{token,jobId:first.jobId});
 const again=await t.mutation(api.worker.importSong,args);
 expect(again.jobId).toBe(first.jobId);
});
test('reserved uploads cannot claim another job or finish after cancellation',async()=>{
 const {t,alice,makeJob}=await setup();const jobId=await makeJob();
 await expect(t.mutation(internal.storage.reserve,{token:otherToken,jobId,files:[file(10)]})).rejects.toThrow('unavailable');
 const [row]=await t.mutation(internal.storage.reserve,{token,jobId,files:[file(10)]});
 await alice.mutation(api.jobs.cancel,{jobId});
 await expect(t.mutation(internal.worker.finish,{token,jobId,result:{title:'Canceled',duration:4,stemMode:'full',quality:{model:'htdemucs',shifts:0,overlap:0.25,format:'opus'},stems:[{name:'drums',key:row.key}]}})).rejects.toThrow('no longer running');
 expect((await alice.query(api.songs.list,{})).songs).toEqual([]);
});
