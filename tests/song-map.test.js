import {expect,test} from 'vitest';
import {fraction,number,validateTimeline,toTime} from '../shared/notation.ts';
import {rebarBars,beatsPinnedNear,compile,timeAt,positionAt,velocityAt,beatsOf,fromSections,fromBeats,fromTimeline,toTimeline,defaultSongMap,pin,unpin,renumberPin,editBars,setMeter,meterRun,scaleTempo,validateSongMap,cleanSongMap,normalize,measureStarts,pulseOf} from '../shared/song-map.ts';

const map=(pins,measures=8,extra={})=>({version:1,measures:Array.from({length:measures},(_,i)=>({id:'m'+i,numerator:4,denominator:4,length:fraction(4),label:''})),pins,...extra});

test('two pins solve an exact decimal tempo with no rounding',()=>{
  const data=map([{position:fraction(0),time:1},{position:fraction(96*4),time:1+96*4*60/117.6}],120);
  const c=compile(data);
  expect(velocityAt(c,10)*60).toBeCloseTo(117.6,9);
  expect(timeAt(c,96*4)).toBeCloseTo(1+96*4*60/117.6,9);
  expect(positionAt(c,timeAt(c,123.25))).toBeCloseTo(123.25,9);
});

test('a ramp starts at the incoming tempo, lands exactly on the next pin and inverts cleanly',()=>{
  const data=map([{position:fraction(0),time:0},{position:fraction(16),time:8,ramp:true},{position:fraction(32),time:14}],12);
  const c=compile(data);
  expect(c.spans[1].ramp).toBe(true);
  expect(c.spans[1].v0).toBeCloseTo(2);              // 120 BPM coming in
  expect(c.spans[1].v1).toBeGreaterThan(2);           // accelerating to fit 16 beats in 6 s
  expect(timeAt(c,32)).toBeCloseTo(14,9);
  for(const q of [17,20.5,31])expect(positionAt(c,timeAt(c,q))).toBeCloseTo(q,9);
  const timeline=toTimeline(data);validateTimeline(timeline);
  expect(toTime(timeline,24)).toBeCloseTo(timeAt(c,24),3);
});

test('an opening ramp lands on the steady tempo after it',()=>{
  // 96 → 112 BPM over 32 beats, then steady 112.
  let t=0;const times=[0];for(let i=0;i<32;i++){t+=60/(96+16*(i+.5)/32);times.push(t);}
  const data=map([{position:fraction(0),time:0,ramp:true},{position:fraction(32),time:times[32]},{position:fraction(36),time:times[32]+4*60/112}],12);
  const c=compile(data);
  expect(c.spans[0].v1*60).toBeCloseTo(112,6);
  expect(c.spans[0].v0*60).toBeCloseTo(96,0);
  for(const q of [8,16,24])expect(timeAt(c,q)).toBeCloseTo(times[q],2);
});

test('legacy manual sections keep every click time, including partial bars and unit meters',()=>{
  const data=fromSections([{t:0.5,bpm:120,beatsPerBar:4,unit:4},{t:5.25,bpm:90,beatsPerBar:6,unit:8}],20);
  validateSongMap(data);
  const beats=beatsOf(data,compile(data),20);
  const legacy=[];for(let t=0.5;t<5.25-1e-6;t+=0.5)legacy.push(t);for(let t=5.25;t<20-1e-6;t+=60/90)legacy.push(t);
  expect(beats.map(b=>b.time)).toHaveLength(legacy.length);
  beats.forEach((b,i)=>expect(b.time).toBeCloseTo(legacy[i],6));
  expect(beats.find(b=>Math.abs(b.time-5.25)<1e-6).downbeat).toBe(true);
  expect(data.measures[2]).toMatchObject({numerator:4,length:fraction(2)}); // 10 clicks in 4/4 → 4+4+2
});

test('detected beats pin every pulse, infer meter from downbeats and keep a pickup',()=>{
  const raw=[[0.4,4],[1,1],[1.5,2],[2,3],[2.5,1],[2.75,2],[3,3],[3.25,1]].map(([time,k])=>({time,downbeat:k===1}));
  const data=fromBeats(raw,6);validateSongMap(data);
  expect(data.measures[0]).toMatchObject({label:'Pickup',numerator:3,length:fraction(1)});
  expect(data.measures[1].numerator).toBe(3);
  const beats=beatsOf(data,compile(data),6);
  raw.forEach(r=>expect(beats.some(b=>Math.abs(b.time-r.time)<1e-9&&b.downbeat===r.downbeat)).toBe(true));
});

test('changing a meter keeps every later pin on its own bar line and in time',()=>{
  const data=map([{position:fraction(0),time:0},{position:fraction(32),time:16}],10);
  const before=compile(data);
  const dropped=editBars(data,2,2,m=>setMeter(m,2,4));
  expect(dropped).toBe(0);
  expect(data.pins[1]).toMatchObject({position:fraction(30),time:16}); // still the downbeat of bar 9
  expect(velocityAt(compile(data),1)).toBeLessThan(velocityAt(before,1)); // fewer beats in the same time
  expect(meterRun(data,0)).toBe(1);
});

test('pins stay ordered: conflicts are refused or replaced, the last pin stays, renumber cannot cross pins',()=>{
  const data=map([{position:fraction(0),time:0},{position:fraction(8),time:4},{position:fraction(16),time:8}]);
  expect(()=>pin(data,fraction(12),3)).toThrow();
  expect(pin(data,fraction(12),3,true)).toBe(1);
  expect(data.pins.map(p=>number(p.position))).toEqual([0,12,16]);
  expect(()=>renumberPin(data,fraction(16),fraction(8))).toThrow();
  renumberPin(data,fraction(16),fraction(20));
  const single=map([{position:fraction(0),time:0}]);expect(()=>unpin(single,fraction(0))).toThrow();
});

test('normalization covers the recording, keeps protected bars, and the default is 120 BPM 4/4',()=>{
  const data=defaultSongMap(10);
  expect(data.measures).toHaveLength(5);
  const slower={...structuredClone(data),tailQpm:60};normalize(slower,10);expect(slower.measures).toHaveLength(3);
  const keep=structuredClone(data);keep.tailQpm=60;normalize(keep,10,id=>id===data.measures[4].id);expect(keep.measures).toHaveLength(5);
});

test('half and double time reinterpret pins without moving them in time',()=>{
  const data=map([{position:fraction(0),time:0},{position:fraction(8),time:4}],4);
  scaleTempo(data,0.5);normalize(data,8);
  expect(data.pins[1]).toMatchObject({position:fraction(4),time:4});
  expect(velocityAt(compile(data),1)*60).toBeCloseTo(60);
});

test('compound and odd meters count their felt pulse',()=>{
  expect(pulseOf({numerator:6,denominator:8,length:fraction(3),label:'',id:'a'})).toBe(1.5);
  expect(pulseOf({numerator:7,denominator:8,grouping:[2,2,3],length:fraction(7,2),label:'',id:'b'})).toBe(0.5);
});

test('stored maps are cleaned and validated; drum-part timelines are adopted as-is',()=>{
  expect(cleanSongMap({version:1,measures:[],pins:[]})).toBeNull();
  const data=defaultSongMap(10);
  expect(cleanSongMap({...data,extra:'x'})).not.toHaveProperty('extra');
  const timeline={version:1,measures:data.measures.slice(0,2),anchors:[{position:fraction(0),time:.1},{position:fraction(1),time:.6}]};
  const adopted=fromTimeline(timeline,10);
  expect(adopted.measures[0].id).toBe(data.measures[0].id);
  expect(measureStarts(adopted.measures).length).toBe(adopted.measures.length);
});

test('re-barring keeps every pin and beat time; only later bar lines move',()=>{
  const data=map(Array.from({length:20},(_,i)=>({position:fraction(i),time:i*.5})),8);
  const before=beatsOf(data,compile(data),20).map(b=>b.time);
  expect(beatsPinnedNear(data,1,1)).toBe(true);
  rebarBars(data,1,1,m=>setMeter(m,3,4));
  const beats=beatsOf(data,compile(data),20);
  expect(beats.map(b=>b.time).slice(0,20)).toEqual(before.slice(0,20));
  expect(beats.find(b=>b.bar===2&&b.beat===1).time).toBeCloseTo(3.5); // bar 3 now starts a beat earlier
  expect(beatsPinnedNear(map([{position:fraction(0),time:0},{position:fraction(16),time:8}]),0,2)).toBe(false);
});
