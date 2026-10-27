// @vitest-environment node
import {expect,test} from 'vitest';
import {ScoreEditor,emptyScore,fraction,number,add,durationOf,toTime,toQuarter,validateTimeline,validateScore,beatGroups,groupAt,upgradeScore,KIT,kitPiece} from '../shared/notation.ts';
const hit=(instrument='snare',offset=fraction(0),extra={})=>({id:crypto.randomUUID(),instrument,offset,voice:['kick','pedalHat'].includes(instrument)?2:1,accent:false,ghost:false,flam:false,sticking:'',velocity:.75,...extra});
test('exact tuplets survive repeated navigation and piecewise audio alignment',()=>{
  let q=fraction(0);for(let i=0;i<300;i++)q=add(q,durationOf(8,false,3));expect(q).toEqual(fraction(100));
  const s=emptyScore(32);s.timeline.anchors=[{position:fraction(0),time:1},{position:fraction(4),time:3.1},{position:fraction(8),time:5.8}];
  for(const position of [0,1/3,4,5.5,8,12])expect(toQuarter(s.timeline,toTime(s.timeline,position))).toBeCloseTo(position,10);
  s.timeline.anchors[1].time=.5;expect(()=>validateTimeline(s.timeline)).toThrow('forward');
});
test('simultaneous entry is idempotent; deletion never moves later notes; undo restores expression',()=>{
  const e=new ScoreEditor(emptyScore(16)),snare=hit(),kick=hit('kick'),later=hit('snare',fraction(2),{ghost:true,flam:true,drag:true,roll:2,sticking:'L'});
  e.insert(0,snare);e.insert(0,kick);expect(e.insert(0,hit())).toBe(snare.id);e.insert(0,later);
  expect(e.score.bars[0].hits).toHaveLength(3);e.remove(new Set([snare.id]));expect(e.score.bars[0].hits.find(h=>h.id===later.id).offset).toEqual(fraction(2));
  e.undo();expect(e.score.bars[0].hits).toHaveLength(3);e.redo();expect(e.score.bars[0].hits.find(h=>h.id===later.id)).toMatchObject({ghost:true,flam:true,drag:true,roll:2,sticking:'L'});
});
test('hits store only position and how they are played',()=>{
  const e=new ScoreEditor(emptyScore(16)),a=hit('snare',fraction(1,3));e.insert(0,a);
  expect(Object.keys(e.score.bars[0].hits[0]).sort()).toEqual(['accent','flam','ghost','id','instrument','offset','sticking','velocity','voice']);
  e.change(new Set([a.id]),{heavy:true,roll:3});expect(e.score.bars[0].hits[0]).toMatchObject({heavy:true,roll:3});
  e.change(new Set([a.id]),{heavy:false,roll:0,drag:false});expect(e.score.bars[0].hits[0]).not.toHaveProperty('heavy');expect(e.score.bars[0].hits[0]).not.toHaveProperty('roll');expect(e.score.bars[0].hits[0]).not.toHaveProperty('drag');
});
test('invalid changes and cross-meter paste are atomic; duplicate has independent IDs',()=>{
  const e=new ScoreEditor(emptyScore(16)),a=hit(),b=hit('snare',fraction(1));e.insert(0,a);e.insert(0,b);
  const before=structuredClone(e.score);
  expect(()=>e.change(new Set([a.id,b.id]),{offset:fraction(1)})).toThrow('does not fit');expect(e.score).toEqual(before);
  expect(()=>e.change(new Set([a.id]),{roll:4})).toThrow();expect(()=>e.change(new Set([a.id]),{instrument:'cymbal'})).toThrow();expect(e.score).toEqual(before);
  e.setTuplet(0,{start:fraction(2),length:fraction(1),count:3},fraction(2),fraction(1));
  e.paste(0,1,2,false,[e.score.bars[0]]);expect(e.score.bars).toHaveLength(3);expect(e.score.bars[1].hits[0].id).not.toBe(a.id);
  expect(e.score.bars[2].tuplets).toEqual([{start:fraction(2),length:fraction(1),count:3}]);
  e.remove(new Set([e.score.bars[1].hits[0].id]));expect(e.score.bars[0].hits).toHaveLength(2);
  expect(()=>e.paste(0,1,1,false,[e.score.bars[0]])).toThrow('destination contains notes');
  e.transact(s=>{s.timeline.measures[3].numerator=3;s.timeline.measures[3].length=fraction(3);});
  const late=structuredClone(e.score);
  expect(()=>e.paste(0,3,1,false,[{...e.score.bars[0],tuplets:undefined,hits:[hit('snare',fraction(7,2))]}])).toThrow('does not fit');expect(e.score).toEqual(late);
});
test('meter changes preserve stable note addresses; pickup and reviewed silence are valid',()=>{
  const e=new ScoreEditor(emptyScore(16)),kept=hit('kick',fraction(5,2));e.insert(2,kept);const measureId=e.score.timeline.measures[2].id;
  e.transact(s=>{s.timeline.measures[0].length=fraction(1);s.timeline.measures[1].numerator=7;s.timeline.measures[1].denominator=8;s.timeline.measures[1].length=fraction(7,2);e.bar(0,s).coverage='reviewed';});
  expect(e.score.bars.find(b=>b.hits.some(h=>h.id===kept.id))).toMatchObject({measureId,hits:[{offset:fraction(5,2)}]});
  e.insert(1,hit('closedHat',fraction(1,3)));validateScore(e.score);
  expect(e.score.bars.find(b=>b.measureId===e.score.timeline.measures[0].id)).toMatchObject({coverage:'reviewed',hits:[]});expect(number(e.score.timeline.measures[1].length)).toBe(3.5);
  expect(()=>e.insert(1,hit('snare',fraction(7,2)))).toThrow('does not fit');
  expect(()=>e.insert(1,hit('snare',fraction(1,35)))).toThrow('128th');
});
test('explicit tuplets replace overlapping spans, refuse notes off their grid, and clear',()=>{
  const e=new ScoreEditor(emptyScore(16));e.insert(0,hit('snare',fraction(1,3)));
  expect(()=>e.setTuplet(0,{start:fraction(0),length:fraction(2),count:3},fraction(0),fraction(2))).toThrow('tuplet');expect(e.score.bars[0]).not.toHaveProperty('tuplets');
  e.remove(new Set(e.score.bars[0].hits.map(h=>h.id)));e.insert(0,hit('snare',fraction(2,3)));
  e.setTuplet(0,{start:fraction(0),length:fraction(2),count:3},fraction(0),fraction(2));
  expect(()=>e.insert(0,hit('snare',fraction(1,4)))).toThrow('tuplet');
  e.setTuplet(0,{start:fraction(1),length:fraction(1),count:5},fraction(1),fraction(1));
  expect(e.score.bars[0].tuplets).toEqual([{start:fraction(1),length:fraction(1),count:5}]);
  e.setTuplet(0,null,fraction(0),fraction(4));expect(e.score.bars[0]).not.toHaveProperty('tuplets');
  expect(()=>e.setTuplet(0,{start:fraction(3),length:fraction(2),count:3},fraction(3),fraction(2))).toThrow('tuplet');
  expect(()=>e.setTuplet(0,{start:fraction(0),length:fraction(5,4),count:3},fraction(0),fraction(5,4))).toThrow('tuplet');
});
test('layout defaults to combined and only split is stored',()=>{
  const e=new ScoreEditor(emptyScore(8));expect(e.setLayout('combined')).toBe(false);
  e.setLayout('split');expect(e.score.layout).toBe('split');e.setLayout('combined');expect(e.score).not.toHaveProperty('layout');
  expect(()=>validateScore({...e.score,layout:'stacked'})).toThrow('Invalid drum part');
});
test('version 1 parts upgrade on open; unknown future versions are refused',()=>{
  const s=emptyScore(8),measureId=s.timeline.measures[0].id;
  const v1={...s,version:1,bars:[{measureId,coverage:'reviewed',hits:[
    {id:'a',offset:fraction(1,3),duration:fraction(1,3),instrument:'snare',voice:1,value:8,dotted:false,tuplet:3,accent:false,ghost:true,flam:false,sticking:'R',velocity:.5},
    {id:'r',offset:fraction(2,3),duration:fraction(1,3),instrument:'rest',voice:1,value:8,dotted:false,tuplet:3,accent:false,ghost:false,flam:false,sticking:'',velocity:.5}]}]};
  const e=new ScoreEditor(v1);
  expect(e.score.version).toBe(2);expect(e.score.bars[0]).toEqual({measureId,coverage:'reviewed',hits:[{id:'a',offset:fraction(1,3),instrument:'snare',voice:1,accent:false,ghost:true,flam:false,sticking:'R',velocity:.5}]});
  expect(upgradeScore(e.score)).toEqual(e.score);
  expect(()=>upgradeScore({...s,version:3})).toThrow('newer version');
});
test('the kit keeps the original piece ids and maps each GP articulation to one piece',()=>{
  expect(KIT).toHaveLength(27);
  for(const id of ['crash','openHat','closedHat','ride','rideBell','rackTom','snare','crossStick','floorTom','kick','pedalHat'])expect(kitPiece(id)).toBeTruthy();
  expect(new Set(KIT.map(k=>k.id)).size).toBe(27);expect(new Set(KIT.map(k=>k.gp)).size).toBe(27);
  expect(KIT.filter(k=>k.voice===2).map(k=>k.id)).toEqual(['kick','pedalHat']);
  const keys=KIT.map(k=>k.key).filter(Boolean);expect(new Set(keys).size).toBe(keys.length);
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
