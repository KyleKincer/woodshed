import {expect,test} from 'vitest';
import {detectOnsets,nearestOnset} from '../src/js/onsets.js';
test('finds percussive hits within a few milliseconds and snaps only inside the tolerance',()=>{
  const rate=44100,length=rate*3,data=new Float32Array(length),hits=[0.5,1.25,2.0,2.4];
  let seed=1;const noise=()=>((seed=seed*16807%2147483647)/2147483647-.5);
  for(let i=0;i<length;i++)data[i]=noise()*0.002;
  for(const t of hits){const start=Math.round(t*rate);for(let i=0;i<4000;i++)data[start+i]+=noise()*Math.exp(-i/600);}
  const onsets=detectOnsets({length,sampleRate:rate,numberOfChannels:1,getChannelData:()=>data});
  for(const t of hits)expect(Math.abs(nearestOnset(onsets,t,.05)-t)).toBeLessThan(.006);
  expect(onsets.length).toBe(hits.length);
  expect(nearestOnset(onsets,1.0,.04)).toBeNull();
});
