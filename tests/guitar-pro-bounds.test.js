import {describe,test,expect} from 'vitest';
import {zipSync,strToU8} from 'fflate';
import {preflightGuitarPro,MAX_GP_EXPANDED_BYTES} from '../src/js/guitar-pro-bounds.js';

const put32=(bytes,p,n)=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).setUint32(p,n,true);
function filesystem() {
  const b=new Uint8Array(4+4096*3);b.set(strToU8('BCFS'));
  put32(b,4+4096,2);b.set(strToU8('score.gpif'),4+4096+4);
  put32(b,4+4096+140,4);put32(b,4+4096+148,2);
  b.set(strToU8('<x/>'),4+8192);return b;
}
function literalGpx(input) {
  const bits=[];
  const write=(n,count,reversed=false)=>{for(let i=0;i<count;i++)bits.push((n>>(reversed?i:count-i-1))&1);};
  for(let p=0;p<input.length;p+=3) {const size=Math.min(3,input.length-p);write(0,1);write(size,2,true);for(let i=0;i<size;i++)write(input[p+i],8);}
  const out=new Uint8Array(8+Math.ceil(bits.length/8));out.set(strToU8('BCFZ'));put32(out,4,input.length);
  bits.forEach((b,i)=>out[8+(i>>3)]|=b<<(7-(i&7)));return out;
}

describe('bounded Guitar Pro containers',()=>{
  test('passes legacy bytes through and verifies a current compressed score',()=>{
    const legacy=strToU8('FICHIER GUITAR PRO');expect(preflightGuitarPro(legacy)).toBe(legacy);
    const gp=zipSync({'VERSION':strToU8('7'),'Content/score.gpif':strToU8('<GPIF/>')});
    expect(preflightGuitarPro(gp)).toBe(gp);
  });
  test('rejects broken CRC, truncation, missing score and forged inflated sizes',()=>{
    const stored=zipSync({'Content/score.gpif':strToU8('<GPIF/>')},{level:0});
    const broken=stored.slice();broken[30+'Content/score.gpif'.length]^=1;
    expect(()=>preflightGuitarPro(broken)).toThrow('checksum');
    expect(()=>preflightGuitarPro(stored.slice(0,-8))).toThrow('directory');
    expect(()=>preflightGuitarPro(zipSync({'audio.wav':strToU8('data')}))).toThrow('score data');
    const huge=stored.slice();put32(huge,22,MAX_GP_EXPANDED_BYTES+1);
    expect(()=>preflightGuitarPro(huge)).toThrow('sizes disagree');
  });
  test('rejects a ZIP bomb with dishonest uncompressed headers',()=>{
    const gp=zipSync({'Content/score.gpif':new Uint8Array(1024*1024)});
    const view=new DataView(gp.buffer);let central=-1;
    for(let i=0;i<gp.length-4;i++)if(view.getUint32(i,true)===0x02014b50){central=i;break;}
    put32(gp,22,1);put32(gp,central+24,1);
    expect(()=>preflightGuitarPro(gp)).toThrow('declared size');
  });
  test('bounds total expanded bytes across ZIP entries',()=>{
    const gp=zipSync({'Content/score.gpif':strToU8('<GPIF/>'),'one':strToU8('x'),'two':strToU8('y')});
    const view=new DataView(gp.buffer);
    for(let p=0;p<gp.length-46;p++)if(view.getUint32(p,true)===0x02014b50)put32(gp,p+24,17*1024*1024);
    expect(()=>preflightGuitarPro(gp)).toThrow('32 MiB');
  });
  test('validates BCFS and normalizes bounded compressed GPX',()=>{
    const raw=filesystem();expect(preflightGuitarPro(raw)).toBe(raw);
    expect(preflightGuitarPro(literalGpx(raw))).toEqual(raw);
  });
  test('rejects oversized GPX allocation claims and invalid sectors',()=>{
    const gpx=new Uint8Array(8);gpx.set(strToU8('BCFZ'));put32(gpx,4,MAX_GP_EXPANDED_BYTES+1);
    expect(()=>preflightGuitarPro(gpx)).toThrow('32 MiB');
    const raw=filesystem();put32(raw,4+4096+140,0x7fffffff);
    expect(()=>preflightGuitarPro(raw)).toThrow('32 MiB');
    const bad=filesystem();put32(bad,4+4096+148,100000);
    expect(()=>preflightGuitarPro(bad)).toThrow('sector');
  });
  test('rejects truncated compression and invalid backreferences',()=>{
    const raw=literalGpx(filesystem());expect(()=>preflightGuitarPro(raw.slice(0,-20))).toThrow('truncated');
    const bad=new Uint8Array(10);bad.set(strToU8('BCFZ'));put32(bad,4,4);bad[8]=0x80;
    expect(()=>preflightGuitarPro(bad)).toThrow('reference');
  });
});
