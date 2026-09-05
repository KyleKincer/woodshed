/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { test, expect, vi, afterEach } from 'vitest';
import schema from './schema';
import { api, internal } from './_generated/api';
import { hashToken } from './devices';
const modules=import.meta.glob('./**/*.ts');
afterEach(()=>vi.unstubAllEnvs());
async function setup(){
 const t=convexTest(schema,modules);
 const [ownerId,userId]=await t.run(async ctx=>Promise.all(['owner','user'].map(name=>ctx.db.insert('users',{name,email:`${name}@test.example`,emailVerified:true,createdAt:1}))));
 vi.stubEnv('ADMIN_USER_IDS',ownerId);
 const owner=t.withIdentity({subject:ownerId}),user=t.withIdentity({subject:userId});
 return {t,owner,user,ownerId,userId};
}
test('admin data and mutations reject anonymous and ordinary users, including forged email',async()=>{
 const {t,user,ownerId,userId}=await setup();
 for(const client of [t,user,t.withIdentity({subject:userId,email:'owner@test.example'})]){
  await expect(client.query(api.admin.account,{id:ownerId})).rejects.toThrow();
  await expect(client.mutation(api.admin.updateAccount,{id:userId,status:'active',byteLimit:1000,notes:'',reason:'test reason'})).rejects.toThrow();
  await expect(client.query(api.admin.history,{paginationOpts:{cursor:null,numItems:25}})).rejects.toThrow();
 }
});
test('account override, reset, and global policy are applied to real reservations and audited',async()=>{
 const {t,owner,user,userId}=await setup();
 await owner.mutation(api.admin.updatePolicy,{userBytes:50,appBytes:150,reason:'Initial limits'});
 await owner.mutation(api.admin.updateAccount,{id:userId,status:'active',byteLimit:200,notes:'Support grant',reason:'Testing override'});
 const token='c'.repeat(64);
 const deviceId=await user.mutation(api.devices.pair,{tokenHash:await hashToken(token),name:'Computer'});
 const make=async()=>{const {jobId}=await user.mutation(api.jobs.createSeparation,{deviceId,settings:{},label:'x',source:{type:'search',value:'x'}});await t.mutation(api.worker.claim,{token,jobId});return jobId;};
 const file=(bytes:number)=>({name:'drums.webm',bytes,mime:'audio/webm',checksum:'a'.repeat(43)+'='});
 await t.mutation(internal.storage.reserve,{token,jobId:await make(),files:[file(100)]});
 await expect(t.mutation(internal.storage.reserve,{token,jobId:await make(),files:[file(60)]})).rejects.toThrow('Cloud storage');
 await owner.mutation(api.admin.updateAccount,{id:userId,status:'active',byteLimit:null,notes:'',reason:'Reset grant'});
 expect((await user.query(api.storage.usage,{})).limitBytes).toBe(50);
 expect((await owner.query(api.admin.history,{paginationOpts:{cursor:null,numItems:25}})).page).toHaveLength(3);
});
test('restrictions block browser and companion access; export-only preserves export; admin cannot self-lock',async()=>{
 const {t,owner,user,userId,ownerId}=await setup();const token='d'.repeat(64);
 const deviceId=await user.mutation(api.devices.pair,{tokenHash:await hashToken(token),name:'Computer'});
 const change=(status:'active'|'export_only'|'suspended')=>owner.mutation(api.admin.updateAccount,{id:userId,status,byteLimit:null,notes:'',reason:'Access review'});
 await change('export_only');
 await expect(user.mutation(api.jobs.createSeparation,{deviceId,settings:{},label:'x',source:{type:'search',value:'x'}})).rejects.toThrow('export-only');
 await expect(t.query(api.worker.next,{token})).rejects.toThrow('export-only');
 expect((await user.query(api.songs.exportPage,{paginationOpts:{cursor:null,numItems:25}})).page).toEqual([]);
 await change('suspended');await expect(user.query(api.songs.list,{})).rejects.toThrow('suspended');
 await expect(user.query(internal.media.authorizedKeys,{keys:['anything']})).rejects.toThrow('suspended');
 await change('active');expect((await user.query(api.songs.list,{})).songs).toEqual([]);
 await expect(owner.mutation(api.admin.updateAccount,{id:ownerId,status:'suspended',byteLimit:null,notes:'',reason:'Lock myself'})).rejects.toThrow('administrator');
});
test('revocation and job cancellation enforce access and record reasons atomically',async()=>{
 const {t,owner,user}=await setup();const token='e'.repeat(64);
 const deviceId=await user.mutation(api.devices.pair,{tokenHash:await hashToken(token),name:'Computer'});
 const {jobId}=await user.mutation(api.jobs.createSeparation,{deviceId,settings:{},label:'x',source:{type:'search',value:'x'}});
 await expect(owner.mutation(api.admin.cancelJob,{id:jobId,reason:''})).rejects.toThrow('reason');
 expect((await user.query(api.jobs.get,{jobId}))?.status).toBe('queued');
 await owner.mutation(api.admin.cancelJob,{id:jobId,reason:'Stop stuck job'});
 expect(await t.query(api.worker.next,{token})).toBeNull();
 await owner.mutation(api.admin.revokeDevice,{id:deviceId,reason:'Lost computer'});
 await expect(t.query(api.worker.next,{token})).rejects.toThrow('not paired');
 expect((await owner.query(api.admin.history,{paginationOpts:{cursor:null,numItems:25}})).page).toHaveLength(2);
});

test('owner access binds to trusted Google account ID, never email or client claims',async()=>{
 const {t,user}=await setup();
 vi.stubEnv('ADMIN_USER_IDS','');vi.stubEnv('OWNER_GOOGLE_ACCOUNT_ID','google-owner-id');
 const id=await t.mutation(internal.users.createUserGoogle,{provider:'google',providerAccountId:'google-owner-id',profile:{id:'google-owner-id',email:'owner@test.example',emailVerified:true,name:'Owner'}});
 const owner=t.withIdentity({subject:id});
 expect(await owner.query(api.admin.access,{})).toBe(true);
 expect(await user.query(api.admin.access,{})).toBe(false);
 const impostor=await t.mutation(internal.users.createUserGoogle,{provider:'google',providerAccountId:'someone-else',profile:{id:'someone-else',email:'owner@test.example',emailVerified:true,name:'Owner'}});
 expect(await t.withIdentity({subject:impostor,email:'owner@test.example'}).query(api.admin.access,{})).toBe(false);
 vi.stubEnv('OWNER_GOOGLE_ACCOUNT_ID','');
 expect(await owner.query(api.admin.access,{})).toBe(false);
});
