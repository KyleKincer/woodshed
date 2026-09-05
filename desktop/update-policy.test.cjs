const {test}=require('node:test');const assert=require('node:assert/strict');
const {canRestart,publicUpdateState}=require('./update-policy.cjs');
test('updates never restart during playback or processing',()=>{
  for(const activity of [{playing:true,processing:false},{playing:false,processing:true},{playing:true,processing:true}])assert.equal(canRestart(activity),false);
  assert.equal(canRestart({playing:false,processing:false}),true);
});
test('update state exposes only bounded display data',()=>{
  assert.deepEqual(publicUpdateState('downloading',{version:'1.1.1',percent:150,token:'secret',message:'Downloading'}),{status:'downloading',version:'1.1.1',percent:100,message:'Downloading'});
});
