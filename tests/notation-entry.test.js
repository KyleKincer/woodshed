// @vitest-environment node
import {expect,test} from 'vitest';
import {scoreFromTiming,snapPosition,nearestDuration,moveLaneNotes} from '../src/js/notation/entry.js';
import {ScoreEditor,emptyScore,fraction,durationOf,toTime,starts,validateScore} from '../shared/notation.ts';
const section={bpm:160,beatsPerBar:4,unit:4};
const hit=(instrument,offset=0)=>({id:crypto.randomUUID(),instrument,offset:fraction(offset),duration:durationOf(8),voice:1,value:8,dotted:false,tuplet:1,accent:false,ghost:false,flam:false,sticking:'',velocity:.75});
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
test('lane grid remains independent of written duration and preserves exact triplets',()=>{
  const s=emptyScore(8);expect(snapPosition(s,.73,durationOf(16))).toEqual(fraction(3,4));
  expect(snapPosition(s,4.32,durationOf(8,false,3))).toEqual(fraction(13,3));
  expect(nearestDuration(.74)).toMatchObject({value:8,dotted:true,duration:fraction(3,4)});
});
test('independent lanes accept overlapping rhythms and duration changes without editing the other drum',()=>{
  const e=new ScoreEditor(emptyScore(8)),hat=hit('closedHat'),snare=hit('snare');e.insert(0,hat);e.insert(0,snare);
  e.change(new Set([snare.id]),{value:4,duration:durationOf(4)});e.insert(0,hit('closedHat',1));
  expect(e.score.bars[0].hits.find(h=>h.id===hat.id).value).toBe(8);e.undo();e.undo();expect(e.score.bars[0].hits.find(h=>h.id===snare.id).value).toBe(8);
});
test('lane drag moves across bars and instruments in one undo, rejects collisions atomically',()=>{
  const e=new ScoreEditor(emptyScore(8)),a=hit('snare',3);e.insert(0,a);const before=structuredClone(e.score);
  moveLaneNotes(e,new Set([a.id]),fraction(1),1);expect(e.score.bars[1].hits[0]).toMatchObject({id:a.id,instrument:'crossStick',offset:fraction(0)});
  e.undo();expect(e.score).toEqual(before);
  expect(()=>moveLaneNotes(e,new Set([a.id]),fraction(-4),0)).toThrow();expect(e.score).toEqual(before);
});
test('missing pulse data uses the existing whole-note beat unit without changing its tempo',()=>{
  const score=scoreFromTiming(8,{beats:[],sectionAt:()=>({bpm:120,beatsPerBar:4,unit:1})});
  expect(score.timeline.measures[0].denominator).toBe(1);expect(score.timeline.measures[0].length).toEqual(fraction(16));expect(toTime(score.timeline,4)).toBe(.5);validateScore(score);
});
