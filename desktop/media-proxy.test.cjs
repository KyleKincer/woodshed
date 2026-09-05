const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createMediaProxy,validateMediaUrl}=require('./media-proxy.cjs');
const signed='https://account.r2.cloudflarestorage.com/woodshed/stem.webm?X-Amz-Signature=test';
test('native audio accepts only signed HTTPS R2 URLs',()=>{
  assert.equal(validateMediaUrl(signed),signed);
  for(const url of ['http://account.r2.cloudflarestorage.com/file?X-Amz-Signature=x','https://localhost/file?X-Amz-Signature=x','https://account.r2.cloudflarestorage.com.evil.test/file?X-Amz-Signature=x','https://account.r2.cloudflarestorage.com/file','https://user:pass@account.r2.cloudflarestorage.com/file?X-Amz-Signature=x'])assert.throws(()=>validateMediaUrl(url));
});
test('native audio streams without upstream CORS, with single-use tickets',async()=>{
  let proxy,options;
  const server=http.createServer((req,res)=>proxy.serve(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  proxy=createMediaProxy({origin,fetcher:async(_url,opts)=>{options=opts;return new Response('audio-bytes',{headers:{'content-length':'11'}});}});
  try{
    const url=proxy.register(signed);
    assert.equal((await fetch(url,{headers:{Origin:'https://untrusted.test'}})).status,403);
    const response=await fetch(url);
    assert.equal(await response.text(),'audio-bytes');
    assert.equal(options.redirect,'error');
    assert.equal((await fetch(url)).status,404);
    assert.equal(response.headers.get('content-security-policy'),"default-src 'none'");
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('native audio refuses expired tickets and oversized responses',async()=>{
  let proxy,time=0;
  const server=http.createServer((req,res)=>proxy.serve(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  proxy=createMediaProxy({origin:`http://127.0.0.1:${server.address().port}`,now:()=>time,maxBytes:10,fetcher:async()=>new Response('oversized audio',{headers:{'content-length':'15'}})});
  try{
    const expired=proxy.register(signed);time=60001;
    assert.equal((await fetch(expired)).status,404);
    assert.equal((await fetch(proxy.register(signed))).status,502);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
