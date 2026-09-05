/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { test, expect, vi, afterEach } from 'vitest';
import schema from './schema';
import { api, internal } from './_generated/api';
import { limits } from './storage';
const modules=import.meta.glob('./**/*.ts');
afterEach(()=>{vi.unstubAllEnvs();vi.useRealTimers();});
async function setup(){
 const t=convexTest(schema,modules);
 const userId=await t.run(ctx=>ctx.db.insert('users',{name:'Alice',email:'alice@test.example',emailVerified:true,createdAt:1}));
 const otherId=await t.run(ctx=>ctx.db.insert('users',{name:'Bob',email:'bob@test.example',emailVerified:true,createdAt:1}));
 const user=t.withIdentity({subject:userId}),other=t.withIdentity({subject:otherId});
 await t.mutation(internal.billingData.bindCustomer,{userId,customerId:'cus_alice'});
 const sync=async(status='active')=>{
  const lease=await t.mutation(internal.billingData.beginSync,{customerId:'cus_alice'});
  await t.mutation(internal.billingData.applySync,{...lease!,subscription:{id:'sub_alice',status,interval:'month',periodEnd:Date.now()+86400000,cancelAtPeriodEnd:false}});
 };
 return {t,user,other,userId,sync};
}
test('billing only exposes the authenticated account and rejects anonymous actions',async()=>{
 const {t,user,other}=await setup();
 await expect(t.query(api.billingData.status,{})).rejects.toThrow('Not signed in');
 await expect(t.action(api.billing.checkout,{interval:'month'})).rejects.toThrow('Not signed in');
 await expect(t.action(api.billing.portal,{})).rejects.toThrow('Not signed in');
 expect((await user.query(api.billingData.status,{})).hasCustomer).toBe(true);
 expect((await other.query(api.billingData.status,{})).hasCustomer).toBe(false);
 await expect(other.action(api.billing.portal,{})).rejects.toThrow('No billing account');
});
test('paid capacity is counted once, honors admin overrides, and stale sync cannot downgrade',async()=>{
 const {t,user,userId,sync}=await setup();await sync();await sync();
 expect((await user.query(api.storage.usage,{})).limitBytes).toBe(5e9);
 expect(await t.run(ctx=>limits(ctx))).toMatchObject({baseAppBytes:8e9,fundedBytes:5e9,appBytes:13e9});
 const old=await t.mutation(internal.billingData.beginSync,{customerId:'cus_alice'});await sync();
 await t.mutation(internal.billingData.applySync,{...old!,subscription:null});
 expect((await user.query(api.billingData.status,{})).access).toBe('paid');
 await t.run(ctx=>ctx.db.insert('accountControls',{userId,status:'active',byteLimit:100,notes:''}));
 expect((await user.query(api.storage.usage,{})).limitBytes).toBe(100);
});
test('checkout leases reject parallel starts and stale completions',async()=>{
 const {t,userId}=await setup();
 const first=await t.mutation(internal.billingData.beginCheckout,{userId,interval:'month'});
 await expect(t.mutation(internal.billingData.beginCheckout,{userId,interval:'month'})).rejects.toThrow('already opening');
 expect(await t.mutation(internal.billingData.finishCheckout,{userId,generation:first.generation!+1,url:'https://wrong.example'})).toBe(false);
 await t.mutation(internal.billingData.finishCheckout,{userId,generation:first.generation!,sessionId:'cs_1',url:'https://checkout.stripe.com/test',expiresAt:Date.now()+1800000,interval:'month'});
 expect(await t.mutation(internal.billingData.beginCheckout,{userId,interval:'month'})).toMatchObject({kind:'existing',url:'https://checkout.stripe.com/test'});
 await expect(t.mutation(internal.billingData.bindCustomer,{userId,customerId:'cus_someone_else'})).rejects.toThrow('mismatch');
});
test('grace deadline is stable, recovery prevents cleanup, and expired grace releases capacity once',async()=>{
 vi.useFakeTimers();const {t,user,userId,sync}=await setup();await sync();await sync('canceled');
 const grace=await user.query(api.billingData.status,{});expect(grace.access).toBe('grace');
 expect(grace.limitBytes).toBe(250e6);
 await sync('canceled');expect((await user.query(api.billingData.status,{})).graceEndsAt).toBe(grace.graceEndsAt);
 await sync();vi.setSystemTime(grace.graceEndsAt!+1);
 await t.mutation(internal.billingData.startCleanup,{userId,deadline:grace.graceEndsAt!});
 expect((await user.query(api.billingData.status,{})).access).toBe('paid');
 await sync('canceled');const second=await user.query(api.billingData.status,{});vi.setSystemTime(second.graceEndsAt!+1);
 await t.mutation(internal.billingData.startCleanup,{userId,deadline:second.graceEndsAt!});
 await t.mutation(internal.billingData.startCleanup,{userId,deadline:second.graceEndsAt!});
 expect(await t.run(ctx=>limits(ctx))).toMatchObject({fundedBytes:0,appBytes:8e9});
});

test('former subscribers can start a new checkout after cancellation',async()=>{
 const {t,userId,sync}=await setup();await sync();await sync('canceled');
 await t.run(async ctx=>{const row=await ctx.db.query('billingAccounts').withIndex('by_userId',q=>q.eq('userId',userId)).unique();await ctx.db.patch(row!._id,{checkoutSessionId:'cs_already_completed',checkoutUrl:'https://checkout.stripe.com/old',checkoutInterval:'month',checkoutExpiresAt:Date.now()+1800000});});
 expect(await t.mutation(internal.billingData.beginCheckout,{userId,interval:'month'})).toMatchObject({kind:'create'});
});
test('cleanup waits for R2 deletion and stops as soon as the remaining library fits',async()=>{
 vi.useFakeTimers();const {t,userId,user,sync}=await setup();await sync();await sync('canceled');
 const ids=await t.run(async ctx=>{
  const jobId=await ctx.db.insert('jobs',{userId,kind:'import',label:'test',status:'done',stage:'done',percent:100,createdAt:1,updatedAt:1});
  const objects=[];
  for(let i=0;i<2;i++){
   const key=`users/${userId}/${i}/drums.webm`;
   objects.push(await ctx.db.insert('audioObjects',{userId,jobId,key,name:'drums.webm',bytes:200e6,mime:'audio/webm',checksum:'a'.repeat(43)+'=',expiresAt:0,status:'ready'}));
   await ctx.db.insert('songs',{userId,title:`Song ${i}`,duration:10,stems:[{name:'drums',key}],stemMode:'full',quality:{model:'htdemucs',shifts:0,overlap:0.25,format:'opus',bitrate:192},addedAt:i});
  }
  await ctx.db.insert('storageUsage',{scope:`user:${userId}`,bytes:400e6});await ctx.db.insert('storageUsage',{scope:'app',bytes:400e6});return objects;
 });
 const grace=await user.query(api.billingData.status,{});vi.setSystemTime(grace.graceEndsAt!+1);
 await t.mutation(internal.billingData.startCleanup,{userId,deadline:grace.graceEndsAt!});
 await t.mutation(internal.billingData.cleanup,{userId});
 expect((await user.query(api.songs.list,{})).songs).toHaveLength(1);
 await t.mutation(internal.billingData.cleanup,{userId});
 expect((await user.query(api.songs.list,{})).songs).toHaveLength(1);
 await t.mutation(internal.storage.deleted,{id:ids[0]});await t.mutation(internal.billingData.cleanup,{userId});
 expect((await user.query(api.songs.list,{})).songs).toHaveLength(1);
 expect((await user.query(api.billingData.status,{})).cleanupPending).toBe(false);
});
