const {randomBytes}=require('node:crypto');
const {Readable,Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
function validateMediaUrl(value){
  if(typeof value!=='string'||value.length>16384)throw Error('Invalid audio URL');
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||!url.hostname.endsWith('.r2.cloudflarestorage.com')||!url.searchParams.has('X-Amz-Signature'))throw Error('Expected an authorized R2 audio URL');
  return url.href;
}
function createMediaProxy({origin,fetcher=fetch,maxBytes=300_000_000,now=Date.now}){
  const tickets=new Map();
  return {
    register(value){
      const url=validateMediaUrl(value);
      for(const [key,ticket] of tickets)if(ticket.expires<now())tickets.delete(key);
      if(tickets.size>=128)throw Error('Too many pending audio downloads');
      const key=randomBytes(24).toString('hex');tickets.set(key,{url,expires:now()+60000});
      return `${origin}/media/${key}`;
    },
    async serve(req,res){
      const key=new URL(req.url,origin).pathname.slice('/media/'.length);
      if(req.method!=='GET'||(req.headers.origin&&req.headers.origin!==origin)){res.writeHead(403);res.end();return;}
      const ticket=tickets.get(key);tickets.delete(key);
      if(!ticket||ticket.expires<now()){res.writeHead(404);res.end();return;}
      const abort=new AbortController();res.once('close',()=>abort.abort());
      try{
        const upstream=await fetcher(ticket.url,{redirect:'error',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(600000)])});
        if(!upstream.ok||!upstream.body)throw Error('Audio download failed');
        const length=Number(upstream.headers.get('content-length'))||0;
        if(length>maxBytes)throw Error('Audio file is too large');
        res.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'",...(length?{'Content-Length':String(length)}:{})});
        let bytes=0;
        const limit=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;callback(bytes>maxBytes?Error('Audio file is too large'):null,chunk);}});
        await pipeline(Readable.fromWeb(upstream.body),limit,res,{signal:abort.signal});
      }catch{
        if(!res.headersSent){res.writeHead(502,{'Content-Type':'text/plain'});res.end('Could not download audio. Try again.');}else res.destroy();
      }finally{abort.abort();}
    },
  };
}
module.exports={createMediaProxy,validateMediaUrl};
