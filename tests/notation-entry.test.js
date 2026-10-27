// @vitest-environment node
import {expect,test} from 'vitest';
import {scoreFromTiming,snapPosition,moveLaneNotes} from '../src/js/notation/entry.js';
import {laneRows} from '../src/js/notation/lanes.js';
import {ScoreEditor,emptyScore,fraction,durationOf,toTime,validateScore,KIT} from '../shared/notation.ts';
const section={bpm:160,beatsPerBar:4,unit:4};
const hit=(instrument,offset=0)=>({id:crypto.randomUUID(),instrument,offset:typeof offset==='number'?fraction(offset*12,12):offset,voice:KIT.find(k=>k.id===instrument).voice,accent:false,ghost:false,flam:false,sticking:'',velocity:.75});
test('opening preserves exact existing downbeat and every variable-tempo pulse without a setup form',()=>{
  const first=.05802540606553842,beats=Array.from({length:10},(_,i)=>({time:first+i*.37+i*i*.001,downbeat:i%4===0}));
  const score=scoreFromTiming(4,{beats,sectionAt:()=>section});
  expect(score.timeline.anchors[0].time).toBe(first);
  beats.forEach((beat,i)=>expect(toTime(score.timeline,i)).toBe(beat.time));
  expect(score.timeline.measures.map(m=>m.numerator)).toEqual([4,4,4]);expect(score.bars).toEqual([]);validateScore(score);
});
test('existing meter changes, pickup pulses and duplicate detection times open directly',()=>{
  const beats=[{time:.1,downbeat:false},{time:.1,downbeat:false},...Array.from({length:7},(_,i)=>({time:.5+i*.5,downbeat:[0,4].includes(i)}))];
  const score=scoreFromTiming(4,{beats,sectionAt:t=>({...section,beatsPerBar:t>=2.5?3:4,unit:t>=2.5?8:4})});
  expect(score.timeline.measures.map(m=>[m.numerator,m.denominator,m.length])).toEqual([[4,4,fraction(1)],[4,4,fraction(4)],[3,8,fraction(3,2)]]);
  expect(score.timeline.measures[0].label).toBe('Pickup');expect(toTime(score.timeline,5)).toBe(2.5);
});
test('a single pulse still produces a usable score',()=>{
  const score=scoreFromTiming(.2,{beats:[{time:.05802540606553842,downbeat:true}],sectionAt:()=>section});
  validateScore(score);expect(toTime(score.timeline,1)).toBeCloseTo(.4330254060655384);
});
test('lane grid snaps onsets within the bar and preserves exact triplets',()=>{
  const s=emptyScore(8);expect(snapPosition(s,.73,durationOf(16))).toEqual(fraction(3,4));
  expect(snapPosition(s,4.32,durationOf(8,false,3))).toEqual(fraction(13,3));
  expect(snapPosition(s,3.99,durationOf(4))).toEqual(fraction(3));expect(snapPosition(s,-1,durationOf(8))).toEqual(fraction(0));
});
test('independent lanes accept overlapping rhythms and expression changes without editing the other drum',()=>{
  const e=new ScoreEditor(emptyScore(8)),hat=hit('closedHat'),snare=hit('snare');e.insert(0,hat);e.insert(0,snare);
  e.insert(0,hit('closedHat',.5));e.insert(0,hit('snare',fraction(1,3)));e.insert(0,hit('snare',fraction(2,3)));
  e.change(new Set([snare.id]),{accent:true,velocity:1});validateScore(e.score);
  expect(e.score.bars[0].hits.find(h=>h.id===hat.id)).toMatchObject({accent:false,velocity:.75});e.undo();expect(e.score.bars[0].hits.find(h=>h.id===snare.id).accent).toBe(false);
});
test('lane rows show the core kit, pieces in use and the current piece in staff order',()=>{
  const e=new ScoreEditor(emptyScore(8));e.insert(0,hit('china'));
  const rows=laneRows(e.score,{piece:'cowbell'});
  expect(rows).toEqual(KIT.filter(k=>k.core||['china','cowbell'].includes(k.id)).map(k=>k.id));expect(rows[0]).toBe('china');
  expect(laneRows(e.score,{all:true})).toHaveLength(KIT.length);
});
test('lane drag moves across bars and instruments in one undo, rejects collisions atomically',()=>{
  const lanes=['closedHat','snare','kick'],e=new ScoreEditor(emptyScore(8)),a=hit('snare',3),b=hit('closedHat',3);e.insert(0,a);e.insert(0,b);e.insert(1,hit('closedHat',1));const before=structuredClone(e.score);
  moveLaneNotes(e,new Set([a.id]),fraction(1),1,lanes);expect(e.score.bars[1].hits.find(h=>h.id===a.id)).toMatchObject({instrument:'kick',voice:2,offset:fraction(0)});
  expect(e.score.bars[0].hits.map(h=>h.id)).toEqual([b.id]);
  e.undo();expect(e.score).toEqual(before);
  moveLaneNotes(e,new Set([a.id,b.id]),fraction(1,2),0,lanes);expect(e.score.bars[0].hits.map(h=>h.offset)).toEqual([fraction(7,2),fraction(7,2)]);e.undo();
  expect(()=>moveLaneNotes(e,new Set([a.id]),fraction(-4),0,lanes)).toThrow('within the part');
  expect(()=>moveLaneNotes(e,new Set([a.id,b.id]),fraction(2),0,lanes)).toThrow('already has a note');
  expect(()=>moveLaneNotes(e,new Set([a.id,b.id]),fraction(0),-1,lanes)).toThrow('drum kit');
  expect(()=>moveLaneNotes(e,new Set([a.id]),fraction(0),1,['crash','kick'])).toThrow('drum kit');
  expect(e.score).toEqual(before);
});
test('missing pulse data uses the existing whole-note beat unit without changing its tempo',()=>{
  const score=scoreFromTiming(8,{beats:[],sectionAt:()=>({bpm:120,beatsPerBar:4,unit:1})});
  expect(score.timeline.measures[0].denominator).toBe(1);expect(score.timeline.measures[0].length).toEqual(fraction(16));expect(toTime(score.timeline,4)).toBe(.5);validateScore(score);
});
