// @vitest-environment node
import {expect,test} from 'vitest';
import {ScoreEditor,emptyScore,fraction,number,add,durationOf,toTime,toQuarter,validateTimeline,validateScore,beatGroups,groupAt} from '../shared/notation.ts';
const hit=(instrument='snare',offset=fraction(0),extra={})=>({id:crypto.randomUUID(),instrument,offset,duration:durationOf(8),voice:1,value:8,dotted:false,tuplet:1,accent:false,ghost:false,flam:false,sticking:'',velocity:.75,...extra});
test('exact tuplets survive repeated navigation and piecewise audio alignment',()=>{
  let q=fraction(0);for(let i=0;i<300;i++)q=add(q,durationOf(8,false,3));expect(q).toEqual(fraction(100));
  const s=emptyScore(32);s.timeline.anchors=[{position:fraction(0),time:1},{position:fraction(4),time:3.1},{position:fraction(8),time:5.8}];
  for(const position of [0,1/3,4,5.5,8,12])expect(toQuarter(s.timeline,toTime(s.timeline,position))).toBeCloseTo(position,10);
  s.timeline.anchors[1].time=.5;expect(()=>validateTimeline(s.timeline)).toThrow('forward');
});
test('simultaneous entry is idempotent; deletion never moves later notes; undo restores expression',()=>{
  const e=new ScoreEditor(emptyScore(16)),snare=hit(),kick=hit('kick',fraction(0),{voice:2}),later=hit('snare',fraction(2),{ghost:true,flam:true,sticking:'L'});
  e.insert(0,snare);e.insert(0,kick);expect(e.insert(0,hit())).toBe(snare.id);e.insert(0,later);
  expect(e.score.bars[0].hits).toHaveLength(3);e.remove(new Set([snare.id]));expect(e.score.bars[0].hits.find(h=>h.id===later.id).offset).toEqual(fraction(2));
  e.undo();expect(e.score.bars[0].hits).toHaveLength(3);e.redo();expect(e.score.bars[0].hits.find(h=>h.id===later.id)).toMatchObject({ghost:true,flam:true,sticking:'L'});
});
test('duration conflicts and cross-meter paste are atomic; duplicate has independent IDs',()=>{
  const e=new ScoreEditor(emptyScore(16)),a=hit(),b=hit('snare',fraction(1));e.insert(0,a);e.insert(0,b);
  expect(()=>e.change(new Set([a.id]),{duration:durationOf(2),value:2})).toThrow('another written beat');expect(e.score.bars[0].hits[0].value).toBe(8);
  e.paste(0,1,2,false,[e.score.bars[0]]);expect(e.score.bars).toHaveLength(3);expect(e.score.bars[1].hits[0].id).not.toBe(a.id);
  e.remove(new Set([e.score.bars[1].hits[0].id]));expect(e.score.bars[0].hits).toHaveLength(2);
  expect(()=>e.paste(0,1,1,false,[e.score.bars[0]])).toThrow('destination contains notes');
});
test('meter changes preserve stable note addresses; pickup and reviewed silence are valid',()=>{
  const e=new ScoreEditor(emptyScore(16));e.transact(s=>{s.timeline.measures[0].length=fraction(1);s.timeline.measures[1].numerator=7;s.timeline.measures[1].denominator=8;s.timeline.measures[1].length=fraction(7,2);e.bar(0,s).coverage='reviewed';});
  e.insert(1,hit('closedHat',fraction(1,3),{duration:durationOf(8,false,3),tuplet:3}));validateScore(e.score);
  expect(e.score.bars[0]).toMatchObject({coverage:'reviewed',hits:[]});expect(number(e.score.timeline.measures[1].length)).toBe(3.5);
  const tooLong=hit('snare',fraction(1),{duration:durationOf(1),value:1});expect(()=>e.insert(1,tooLong)).toThrow('does not fit');
});

test('selected-note movement and paste preserve timing, expression, independent identity and undo',()=>{
  const e=new ScoreEditor(emptyScore(16)),a=hit('snare',fraction(7,2),{ghost:true});e.insert(0,a);
  e.move(new Set([a.id]),fraction(1,2));expect(e.score.bars[1].hits[0]).toMatchObject({id:a.id,offset:fraction(0),ghost:true});
  e.pasteHits(fraction(5),[{hit:a,offset:fraction(0)}]);const copy=e.score.bars[1].hits[1];expect(copy.id).not.toBe(a.id);expect(copy.offset).toEqual(fraction(1));
  expect(()=>e.move(new Set([a.id]),fraction(1))).toThrow();expect(e.score.bars[1].hits[0].offset).toEqual(fraction(0));
  e.undo();expect(e.score.bars[1].hits).toHaveLength(1);e.undo();expect(e.score.bars[0].hits[0].offset).toEqual(fraction(7,2));
});
test('compound and irregular grouping controls the counted pulse without changing bar duration',()=>{
  const s=emptyScore(16,60,6,8),m=s.timeline.measures[0];expect(beatGroups(m)).toEqual([3,3]);expect(groupAt(m,1)).toBe(0);expect(groupAt(m,1.5)).toBe(1);expect(toTime(s.timeline,3)).toBe(3);
  m.numerator=7;m.length=fraction(7,2);m.grouping=[2,2,3];validateScore(s);expect(groupAt(m,2.5)).toBe(2);m.grouping=[3,3];expect(()=>validateScore(s)).toThrow('add up');
});
