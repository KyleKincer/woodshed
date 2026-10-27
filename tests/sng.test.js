import {test,expect} from 'vitest';
import {extractSngChart,extractSngChartFromReader,MAX_SNG_CHART_BYTES} from '../shared/sng.ts';
const encoder=new TextEncoder();
const bytes=(s)=>encoder.encode(s);
const join=(...parts)=>{const result=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const p of parts){result.set(p,offset);offset+=p.length;}return result;};
const uint32=(n)=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,n,true);return b;};
const uint64=(n)=>join(uint32(n>>>0),uint32(Math.floor(n/4294967296)));
const str=(s)=>join(uint32(bytes(s).length),bytes(s));
const set64=(array,offset,n)=>{array.set(uint64(n),offset);};
function packageFixture({name='notes.chart',chart=bytes('[Song]\n{\nResolution = 192\n}\n[SyncTrack]\n{\n0 = B 120000\n}'),audioLength=1024*1024,metadata={delay:'50',chart_offset:'-1.25'},version=1}={}) {
  const mask=Uint8Array.from({length:16},(_,i)=>i*7+1);
  const metadataBytes=join(uint64(Object.keys(metadata).length),...Object.entries(metadata).map(([key,value])=>join(str(key),str(value))));
  const names=['song.opus',name],contents=[audioLength,chart.length];
  const indexLength=8+names.reduce((n,name)=>n+1+bytes(name).length+16,0),dataStart=26+8+metadataBytes.length+8+indexLength+8;
  const fileStarts=[dataStart,dataStart+audioLength];
  const index=join(uint64(names.length),...names.map((name,i)=>join(new Uint8Array([bytes(name).length]),bytes(name),uint64(contents[i]),uint64(fileStarts[i]))));
  const prefix=join(bytes('SNGPKG'),uint32(version),mask,uint64(metadataBytes.length),metadataBytes,uint64(index.length),index,uint64(audioLength+chart.length));
  const masked=chart.map((b,i)=>b^mask[i%16]^(i&255));
  const size=dataStart+audioLength+chart.length;
  const ranges=[];
  const read=async(start,end)=>{
    ranges.push([start,end]);
    // Any accidental audio request fails; the fixture never allocates audio bytes.
    if(start<dataStart&&end<=dataStart)return prefix.slice(start,end);
    if(start>=fileStarts[1]&&end<=size)return masked.slice(start-fileStarts[1],end-fileStarts[1]);
    throw new Error('Audio bytes must never be requested');
  };
  const fetcher=async(_url,init)=>{
    const range=new Headers(init.headers).get('range').match(/^bytes=(\d+)-(\d+)$/),start=Number(range[1]),end=Number(range[2])+1;
    const result=await read(start,end);
    return new Response(result,{status:206,headers:{'content-range':`bytes ${start}-${end-1}/${size}`,'content-length':String(result.length),etag:'"fixture"'}});
  };
  return {chart,prefix,indexLength,metadataLength:metadataBytes.length,dataStart,size,ranges,read,fetcher};
}

test('reads only headers and selected chart, unmasking with per-file offsets, never bundled audio',async()=>{
  const f=packageFixture({audioLength:4*1024*1024*1024,chart:Uint8Array.from({length:1000},(_,i)=>i&255)});
  const result=await extractSngChart('https://files.enchor.us/test.sng',f.fetcher);
  expect(result.name).toBe('notes.chart');expect(result.bytes).toEqual(f.chart);expect(result.metadata).toEqual({delay:'50',chart_offset:'-1.25'});
  expect(f.ranges).toHaveLength(4);expect(f.ranges.reduce((sum,[a,b])=>sum+b-a,0)).toBeLessThan(2000);
});

test('can reuse exactly the same selective parser for local File.slice reads',async()=>{
  const f=packageFixture({name:'notes.mid',chart:bytes('MThd MIDI placeholder')});
  const result=await extractSngChartFromReader(f.read,f.size);
  expect(result.name).toBe('notes.mid');expect(result.bytes).toEqual(f.chart);expect(f.ranges).toHaveLength(4);
});

test('rejects servers ignoring Range without consuming the full response body',async()=>{
  let consumed=0,cancelled=0;
  const fetcher=async()=>new Response(new ReadableStream({pull(controller){consumed++;controller.enqueue(new Uint8Array(100));},cancel(){cancelled++;}}),{status:200});
  await expect(extractSngChart('https://files.enchor.us/test.sng',fetcher)).rejects.toThrow('bounded downloads');expect(cancelled).toBe(1);expect(consumed).toBeLessThanOrEqual(1);
});

test('rejects incorrect Content-Range headers and compressed range responses',async()=>{
  for(const headers of [{'content-range':'bytes 1-34/1000'},{'content-range':'bytes 0-33/1000','content-length':'10000'},{'content-range':'bytes 0-33/1000','content-encoding':'gzip'}]) {
    await expect(extractSngChart('https://files.enchor.us/test.sng',async()=>new Response(new Uint8Array(34),{status:206,headers}))).rejects.toThrow('inconsistent byte range');
  }
});

test('bounds streamed responses even when Content-Length is absent or dishonest',async()=>{
  await expect(extractSngChart('https://files.enchor.us/test.sng',async()=>new Response(new Uint8Array(35),{status:206,headers:{'content-range':'bytes 0-33/1000'}}))).rejects.toThrow('exceeded');
  await expect(extractSngChart('https://files.enchor.us/test.sng',async()=>new Response(new Uint8Array(33),{status:206,headers:{'content-range':'bytes 0-33/1000'}}))).rejects.toThrow('incomplete');
});

test('rejects changed archive sizes or etags between range requests',async()=>{
  for(const change of ['size','etag']) {
    const f=packageFixture();let calls=0;
    const fetcher=async(...args)=>{const r=await f.fetcher(...args);if(++calls>1){if(change==='etag')r.headers.set('etag','"different"');else r.headers.set('content-range',r.headers.get('content-range').replace(`/${f.size}`,`/${f.size+1}`));}return r;};
    await expect(extractSngChart('https://files.enchor.us/test.sng',fetcher)).rejects.toThrow(change==='etag'?'changed':'inconsistent');
  }
});

test('rejects incorrect magic and unsupported versions',async()=>{
  const invalid=packageFixture();invalid.prefix[0]=88;
  await expect(extractSngChart('https://files.enchor.us/test.sng',invalid.fetcher)).rejects.toThrow('identifier');
  await expect(extractSngChart('https://files.enchor.us/test.sng',packageFixture({version:2}).fetcher)).rejects.toThrow('version');
});

test('caps metadata and index lengths before fetching large sections',async()=>{
  const metadata=packageFixture();set64(metadata.prefix,26,513*1024);
  await expect(extractSngChart('https://files.enchor.us/test.sng',metadata.fetcher)).rejects.toThrow('metadata section');expect(metadata.ranges).toHaveLength(1);
  const index=packageFixture();set64(index.prefix,34+index.metadataLength,513*1024);
  await expect(extractSngChart('https://files.enchor.us/test.sng',index.fetcher)).rejects.toThrow('file index');expect(index.ranges).toHaveLength(2);
});

test('rejects invalid counts, unsafe names and overlapping file pointers',async()=>{
  const count=packageFixture();set64(count.prefix,34+count.metadataLength+8,1025);
  await expect(extractSngChart('https://files.enchor.us/test.sng',count.fetcher)).rejects.toThrow('number of files');
  await expect(extractSngChart('https://files.enchor.us/test.sng',packageFixture({name:'../notes.chart'}).fetcher)).rejects.toThrow('unsafe');
  const overlap=packageFixture();const indexStart=34+overlap.metadataLength+8;set64(overlap.prefix,indexStart+8+1+bytes('song.opus').length+8,overlap.dataStart-1);
  await expect(extractSngChart('https://files.enchor.us/test.sng',overlap.fetcher)).rejects.toThrow('out-of-bounds');
});

test('rejects invalid metadata lengths instead of reading into the file index',async()=>{
  const f=packageFixture();const firstKeyLength=34+8;f.prefix.set(uint32(0xffffffff),firstKeyLength);
  await expect(extractSngChart('https://files.enchor.us/test.sng',f.fetcher)).rejects.toThrow('truncated');
});

test('rejects missing or oversized charts without requesting chart or audio bytes',async()=>{
  const missing=packageFixture({name:'album.jpg'});await expect(extractSngChart('https://files.enchor.us/test.sng',missing.fetcher)).rejects.toThrow('no notes');expect(missing.ranges).toHaveLength(3);
  const tooLarge=packageFixture({chart:new Uint8Array(MAX_SNG_CHART_BYTES+1)});await expect(extractSngChart('https://files.enchor.us/test.sng',tooLarge.fetcher)).rejects.toThrow('too large');expect(tooLarge.ranges).toHaveLength(3);
});

test('forwards AbortSignal and rejects aborted downloads',async()=>{
  const controller=new AbortController();controller.abort();let aborted=false;
  await expect(extractSngChart('https://files.enchor.us/test.sng',async(_url,init)=>{aborted=init.signal.aborted;throw new Error('cancelled');},{signal:controller.signal})).rejects.toThrow('cancelled');expect(aborted).toBe(true);
});
