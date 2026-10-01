import {expect,test} from 'vitest';
import {fraction} from '../shared/notation.ts';
import {SongMapStore} from '../src/js/song-map.js';
import {defaultSongMap,pin,unpin,fromSections,validateSongMap,fromTimeline} from '../shared/song-map.ts';

test('beat detection keeps bar ids so drum notes stay attached and guards still pass',()=>{
  const store=new SongMapStore(defaultSongMap(20),20);
  const id=store.data.measures[0].id;
  store.setGuard('notation',timeline=>{if(!timeline.measures.some(m=>m.id===id))throw new Error('notes stranded');});
  store.replaceFromBeats(Array.from({length:30},(_,i)=>({time:.3+i*.55,downbeat:i%4===0})));
  expect(store.data.measures[0].id).toBe(id);
  expect(store.pins).toHaveLength(30);
});

test('removing a pin back to one keeps the tempo instead of resetting to 120',()=>{
  const store=new SongMapStore(defaultSongMap(20),20);
  store.edit(d=>pin(d,fraction(16),9));           // 4 bars in 9 s → 106.67 BPM
  store.edit(d=>unpin(d,fraction(16)));
  expect(store.bpmAt(1)).toBeCloseTo(106.67,1);
});

test('migrated maps stay editable when a section starts milliseconds after a click',()=>{
  const data=fromSections([{t:0,bpm:120,beatsPerBar:4,unit:4},{t:4.004,bpm:90,beatsPerBar:4,unit:4}],20);
  expect(()=>validateSongMap(data)).not.toThrow();
  const store=new SongMapStore(data,20);
  expect(()=>store.edit(d=>pin(d,fraction(40),18))).not.toThrow();
});

test('drum-part timelines with crowded anchors adopt; invalid maps never replace the current one',()=>{
  const measures=[{id:'a',numerator:4,denominator:4,length:fraction(4),label:''}];
  const timeline={version:1,measures,anchors:[{position:fraction(0),time:1},{position:fraction(1,64),time:1.00005},{position:fraction(1),time:1.5}]};
  const store=new SongMapStore(defaultSongMap(20),20);
  expect(store.adopt(fromTimeline(timeline,20))).toBe(true);
  expect(store.pins.map(p=>p.time)).toEqual([1,1.5]);
  expect(store.adopt({version:1,measures:[],pins:[]})).toBe(false);
  expect(store.pins.map(p=>p.time)).toEqual([1,1.5]);
});
