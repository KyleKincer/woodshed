const {test}=require('node:test');const assert=require('node:assert/strict');
const {publicUpdateState}=require('./update-policy.cjs');
test('update state exposes only bounded display data',()=>{
  assert.deepEqual(publicUpdateState('downloading',{version:'1.1.1',percent:150,token:'secret',message:'Downloading'}),{status:'downloading',version:'1.1.1',percent:100,message:'Downloading'});
});
