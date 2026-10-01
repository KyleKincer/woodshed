import {expect,test} from 'vitest';
import {fraction} from '../shared/notation.ts';
import {SongMapStore} from '../src/js/song-map.js';
import {segments,tempoRange,guides} from '../src/js/map-lane.js';

const map=(pins,bars=12)=>new SongMapStore({version:1,measures:Array.from({length:bars},(_,i)=>({id:'m'+i,numerator:4,denominator:4,length:fraction(4),label:''})),pins},24);

test('a stretch that disagrees with both neighbours is flagged as a likely miscount',()=>{
  // 120 BPM everywhere except bars 3–4, which read 4 beats fast (a missing bar).
  const store=map([{position:fraction(0),time:0},{position:fraction(8),time:4},{position:fraction(12),time:5.6},{position:fraction(20),time:9.6}]);
  const segs=segments(store,24);
  expect(segs.filter(s=>s.suspect)).toHaveLength(1);
  expect(Math.round(segs.find(s=>s.suspect).q0)).toBe(150);
});

test('the lane range ignores outliers and always has room around a steady tempo',()=>{
  const steady=tempoRange([{t0:0,t1:20,q0:120,q1:120}]);
  expect(steady.lo).toBeLessThan(120);expect(steady.hi).toBeGreaterThan(120);
  const withGap=tempoRange([{t0:0,t1:20,q0:100,q1:112},{t0:20,t1:20.02,q0:900,q1:900}]);
  expect(withGap.hi).toBeLessThan(140);
  expect(guides({lo:92,hi:118})).toEqual([100,110]);
});
