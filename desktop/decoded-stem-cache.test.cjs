const {test} = require('node:test');
const assert = require('node:assert/strict');
const buffer = length => ({length,numberOfChannels:2});
test('reopening stems reuses decoded audio but sample-rate changes require decoding', async () => {
  const {DecodedStemCache} = await import('../src/js/decoded-stem-cache.js');
  const cache = new DecodedStemCache(1024);
  let decodes=0;
  const decode=async()=>{decodes++;return buffer(20);};
  const first=await cache.load('stem-a',44100,decode);
  assert.equal(await cache.load('stem-a',44100,decode),first);
  assert.equal(decodes,1);
  await cache.load('stem-a',48000,decode);
  assert.equal(decodes,2);
});
test('decoded audio evicts least-recently-used stems within its byte budget', async () => {
  const {DecodedStemCache} = await import('../src/js/decoded-stem-cache.js');
  const cache = new DecodedStemCache(160);
  const loads=[];
  const load=key=>cache.load(key,44100,async()=>{loads.push(key);return buffer(10);});
  await load('a');await load('b');await load('a');await load('c');await load('a');
  assert.deepEqual(loads,['a','b','c']);
  assert.equal(cache.bytes,160);
  await load('b');
  assert.deepEqual(loads,['a','b','c','b']);
  assert.equal(cache.bytes,160);
});
test('clearing cache also invalidates pending decodes and oversized audio is not retained', async () => {
  const {DecodedStemCache} = await import('../src/js/decoded-stem-cache.js');
  const cache = new DecodedStemCache(80);
  let finish;
  const pending=cache.load('pending',44100,()=>new Promise(resolve=>{finish=resolve;}));
  cache.clear();finish(buffer(10));await pending;
  assert.equal(cache.bytes,0);
  await cache.load('large',44100,async()=>buffer(11));
  assert.equal(cache.entries.size,0);
});
