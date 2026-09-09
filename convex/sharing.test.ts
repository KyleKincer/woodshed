/// <reference types="vite/client" />
import {convexTest} from 'convex-test';
import {expect,test,vi,beforeEach,afterEach} from 'vitest';
import schema from './schema';
import {api,internal} from './_generated/api';
import {emptyScore} from '../shared/notation';
const remote=vi.hoisted(()=>({objects:new Map<string,{ContentLength:number,ContentType:string,ETag:string}>(),copyHook:null as null|(()=>Promise<void>),copies:0}));
vi.mock('./r2',()=>({r2:{config:{bucket:'test'},getUrl:vi.fn(async(key:string)=>'https://storage.test/'+key),deleteObject:vi.fn(async()=>{}),client:{send:vi.fn(async(command:any)=>{
  const {Key,CopySource,CopySourceIfMatch}=command.input;
  if(command.constructor.name==='HeadObjectCommand'){const head=remote.objects.get(Key);if(!head)throw Error('Missing file');return head;}
  if(command.constructor.name==='CopyObjectCommand'){
    remote.copies++;if(remote.copyHook)await remote.copyHook();
    const head=remote.objects.get(decodeURIComponent(CopySource.slice(5)));if(!head||head.ETag!==CopySourceIfMatch)throw Error('Source changed');
    const copied={...head,ETag:'copied-'+head.ETag};remote.objects.set(Key,copied);return {CopyObjectResult:{ETag:copied.ETag}};
  }
  throw Error('Unexpected storage operation');
})}}}));
const modules=import.meta.glob('./**/*.ts');
const quality={model:'htdemucs',shifts:0,overlap:.25,format:'opus' as const};
beforeEach(()=>{remote.objects.clear();remote.copyHook=null;remote.copies=0;});
afterEach(()=>vi.unstubAllEnvs());
async function setup(){
  const t=convexTest(schema,modules),alice=t.withIdentity({subject:'alice'}),bob=t.withIdentity({subject:'bob'});
  const songId=await t.run(async ctx=>{
    const stems=[{name:'drums',key:'private/audio drums',bytes:100,mime:'audio/webm'},{name:'bass',key:'private/bass',bytes:100,mime:'audio/webm'}];
    const id=await ctx.db.insert('songs',{userId:'alice',title:'Shared song',artist:'Artist',duration:120,stemMode:'full',quality,stems,coverKey:'private/cover',addedAt:1,
      source:{type:'upload',value:'/private/original.wav'},notes:'Private note',tags:['private tag'],
      tempo:{map:[{t:0,bpm:97,beatsPerBar:7,unit:8,notes:'private'}],detected:[{time:1,downbeat:true}],countIn:true,countInLength:2,countInUnit:'bars',audiblePreRoll:false,notes:'private'},
      practice:{rate:.75,loop:{enabled:true,a:10,b:20},grid:{visible:true,snap:true,division:2},tracks:[{name:'drums',volume:.5,muted:true,soloed:false}],notes:'private'},
    });
    for(const f of [...stems,{name:'cover',key:'private/cover',bytes:10,mime:'image/png'}]){
      await ctx.db.insert('audioObjects',{userId:'alice',songId:id,key:f.key,name:f.name,bytes:f.bytes,mime:f.mime,checksum:'',expiresAt:0,status:'ready'});
      remote.objects.set(f.key,{ContentLength:f.bytes,ContentType:f.mime,ETag:f.name});
    }
    await ctx.db.insert('storageUsage',{scope:'app',bytes:210});await ctx.db.insert('storageUsage',{scope:'user:alice',bytes:210});
    return id;
  });
  const {token}=await alice.mutation(api.sharing.create,{id:songId});
  return {t,alice,bob,songId,token};
}
test('public links expose only the song and practice setup; private and arbitrary files remain protected',async()=>{
  const {t,bob,songId,token}=await setup();
  const view=await t.query(api.sharing.view,{token});
  expect(view?.tempo).toMatchObject({map:[{bpm:97,beatsPerBar:7,unit:8}],detected:[{time:1,downbeat:true}],countInLength:2});
  expect(view?.practice).toMatchObject({rate:.75,loop:{a:10,b:20},tracks:[{muted:true}]});
  expect(JSON.stringify(view)).not.toMatch(/private|alice/);
  expect(view?.stems[0].key).toBe('stem-0');
  expect(await t.query(api.songs.get,{id:songId})).toBeNull();
  await expect(t.mutation(api.sharing.create,{id:songId})).rejects.toThrow('Not signed in');
  await expect(bob.mutation(api.sharing.create,{id:songId})).rejects.toThrow('unavailable');
  await expect(bob.mutation(api.sharing.revoke,{id:songId})).rejects.toThrow('Not your');
  expect(await bob.query(internal.media.authorizedKeys,{keys:['private/bass']})).toEqual([]);
  expect(await t.query(api.sharing.view,{token:'invalid'})).toBeNull();
});
test('revocation invalidates the link and media access; re-enabling never revives the old link',async()=>{
  const {t,alice,songId,token}=await setup();
  expect((await alice.mutation(api.sharing.create,{id:songId})).token).toBe(token);
  await alice.mutation(api.sharing.revoke,{id:songId});
  expect(await t.query(api.sharing.view,{token})).toBeNull();
  await expect(t.action(api.shareAudio.playback,{token})).rejects.toThrow('unavailable');
  const next=await alice.mutation(api.sharing.create,{id:songId});expect(next.token).not.toBe(token);
  expect(await t.query(api.sharing.view,{token:next.token})).not.toBeNull();
});
test('saving copies audio, cover, tempo and practice independently; repeated saves do not charge twice',async()=>{
  const {t,alice,bob,songId,token}=await setup();
  const savedId=await bob.action(api.shareAudio.save,{token});
  expect(await bob.action(api.shareAudio.save,{token})).toBe(savedId);expect(remote.copies).toBe(3);
  const saved=await bob.query(api.songs.get,{id:savedId});if(!saved)throw Error('Missing saved song');
  expect(saved.tempo.map[0].bpm).toBe(97);expect(saved.practice.loop.a).toBe(10);expect(saved.notes).toBe('');expect(saved.source).toBeNull();
  expect(saved.stems.every((s:any)=>s.key.startsWith('users/bob/shared/'))).toBe(true);
  expect((await bob.query(api.storage.usage,{})).usedBytes).toBe(210);
  await alice.mutation(api.songs.saveTempo,{id:songId,tempo:{map:[{t:0,bpm:200}]}});
  await alice.mutation(api.sharing.revoke,{id:songId});await alice.mutation(api.songs.remove,{id:songId});
  expect((await bob.query(api.songs.get,{id:savedId}))!.tempo.map[0].bpm).toBe(97);
  expect(await bob.query(internal.media.authorizedKeys,{keys:saved.stems.map((s:any)=>s.key)})).toHaveLength(2);
  await bob.mutation(api.songs.savePractice,{id:savedId,practice:{rate:1}});
  expect((await bob.query(api.songs.get,{id:savedId}))!.practice.rate).toBe(1);
});
test('owners open their existing song, anonymous saves are denied, and deleting a saved copy allows adding again',async()=>{
  const {t,alice,bob,songId,token}=await setup();
  expect(await alice.action(api.shareAudio.save,{token})).toBe(songId);expect(remote.copies).toBe(0);
  await expect(t.action(api.shareAudio.save,{token})).rejects.toThrow('Not signed in');
  const first=await bob.action(api.shareAudio.save,{token});await bob.mutation(api.songs.remove,{id:first});
  const second=await bob.action(api.shareAudio.save,{token});expect(second).not.toBe(first);
});
test('revocation during a copy prevents commit and retires every reserved destination',async()=>{
  const {t,alice,bob,songId,token}=await setup();let revoked=false;
  remote.copyHook=async()=>{if(!revoked){revoked=true;await alice.mutation(api.sharing.revoke,{id:songId});}};
  await expect(bob.action(api.shareAudio.save,{token})).rejects.toThrow('unavailable');
  expect((await bob.query(api.songs.list,{})).songs).toHaveLength(0);
  const rows=await t.run(ctx=>ctx.db.query('audioObjects').withIndex('by_userId_status',q=>q.eq('userId','bob').eq('status','deleting')).take(10));
  expect(rows).toHaveLength(3);
  for(const row of rows)await t.mutation(internal.storage.deleted,{id:row._id});
  expect((await bob.query(api.storage.usage,{})).usedBytes).toBe(0);
});
test('a failed copy never creates a partial song and can be retried',async()=>{
  const {bob,token}=await setup();remote.copyHook=async()=>{throw Error('offline');};
  await expect(bob.action(api.shareAudio.save,{token})).rejects.toThrow('copy all');
  expect((await bob.query(api.songs.list,{})).songs).toHaveLength(0);
  remote.copyHook=null;expect(await bob.action(api.shareAudio.save,{token})).toBeTruthy();
});
test('user and app quotas reject saves before copying',async()=>{
  const {bob,token}=await setup();vi.stubEnv('CLOUD_USER_BYTE_LIMIT','200');
  await expect(bob.action(api.shareAudio.save,{token})).rejects.toThrow('library is full');
  vi.stubEnv('CLOUD_USER_BYTE_LIMIT','1000');vi.stubEnv('CLOUD_APP_BYTE_LIMIT','400');
  await expect(bob.action(api.shareAudio.save,{token})).rejects.toThrow('Cloud storage');
  expect(remote.copies).toBe(0);expect((await bob.query(api.storage.usage,{})).usedBytes).toBe(0);
});
test('suspended senders disable public access, export-only recipients cannot save',async()=>{
  const {t,bob,token}=await setup();
  await t.run(ctx=>ctx.db.insert('accountControls',{userId:'bob',status:'export_only',notes:''}));
  await expect(bob.action(api.shareAudio.save,{token})).rejects.toThrow('export-only');
  await t.run(ctx=>ctx.db.insert('accountControls',{userId:'alice',status:'suspended',notes:''}));
  expect(await t.query(api.sharing.view,{token})).toBeNull();
});
test('simultaneous attempts cannot create duplicate reservations or overwrite the first save',async()=>{
  const {bob,token}=await setup();let release!:()=>void;const held=new Promise<void>(r=>{release=r;});
  remote.copyHook=()=>held;
  const first=bob.action(api.shareAudio.save,{token});
  await vi.waitFor(()=>expect(remote.copies).toBe(3));
  await expect(bob.action(api.shareAudio.save,{token})).rejects.toThrow('already being added');
  release();await first;expect((await bob.query(api.songs.list,{})).songs).toHaveLength(1);
});

test('missing audio fails before reservation and a reprocessed source gets a new cache revision',async()=>{
  const {t,bob,songId,token}=await setup();const before=await t.query(api.sharing.view,{token});
  remote.objects.delete('private/bass');await expect(bob.action(api.shareAudio.save,{token})).rejects.toThrow('could not be loaded');
  expect((await bob.query(api.storage.usage,{})).usedBytes).toBe(0);
  await t.run(ctx=>ctx.db.patch(songId,{stems:[{name:'drums',key:'new/reprocessed',bytes:100,mime:'audio/webm'}]}));
  expect((await t.query(api.sharing.view,{token}))?.revision).not.toBe(before?.revision);
});
test('disabling account writes during a save prevents commit and cleans up reservations',async()=>{
  const {t,bob,token}=await setup();let changed=false;
  remote.copyHook=async()=>{if(!changed){changed=true;await t.run(ctx=>ctx.db.insert('accountControls',{userId:'bob',status:'export_only',notes:''}));}};
  await expect(bob.action(api.shareAudio.save,{token})).rejects.toThrow('export-only');
  expect((await bob.query(api.songs.list,{})).songs).toHaveLength(0);
});
test('expired imports release reserved files and stale cleanup cannot affect a later successful attempt',async()=>{
  const {t,bob,token}=await setup();
  const heads=[...remote.objects].map(([sourceKey,h])=>({sourceKey,bytes:h.ContentLength,mime:h.ContentType,etag:h.ETag}));
  const first=await bob.mutation(internal.sharing.beginImport,{token,heads});if(!first.id)throw Error('Missing import');
  await t.run(ctx=>ctx.db.patch(first.id!,{expiresAt:0}));
  await expect(bob.mutation(internal.sharing.finishImport,{id:first.id,attempt:first.attempt!})).rejects.toThrow('timed out');
  await t.mutation(internal.sharing.failImport,{id:first.id,attempt:first.attempt!});
  const saved=await bob.action(api.shareAudio.save,{token});
  await t.mutation(internal.sharing.failImport,{id:first.id,attempt:first.attempt!});
  expect(await bob.query(api.songs.get,{id:saved})).not.toBeNull();
});

test('recipient gets a coherent notation snapshot even when the sender edits while audio copies',async()=>{
  const {t,alice,bob,songId,token}=await setup();const score=emptyScore(120),{bars,...header}=score;
  bars.push({measureId:score.timeline.measures[0].id,coverage:'reviewed',hits:[]});
  await alice.mutation(api.notation.save,{songId,baseRevision:0,mutationId:'initial-score',header,bars});
  let edited=false;remote.copyHook=async()=>{if(edited)return;edited=true;await alice.mutation(api.notation.save,{songId,baseRevision:1,mutationId:'later-score',header:{...header,title:'Changed during copy'},bars:[]});};
  const copyId=await bob.action(api.shareAudio.save,{token});const copied=await bob.query(api.notation.get,{songId:copyId});
  expect(copied?.score.title).toBe('Drums');expect(copied?.score.timeline).toEqual(score.timeline);expect(copied?.score.bars[0].coverage).toBe('reviewed');
  expect((await alice.query(api.notation.get,{songId}))?.score.title).toBe('Changed during copy');
  await alice.mutation(api.songs.remove,{id:songId});expect((await bob.query(api.notation.get,{songId:copyId}))?.score.title).toBe('Drums');
});
