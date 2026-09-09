// @vitest-environment node
import {expect,test} from 'vitest';
import {emptyScore,fraction} from '../shared/notation.ts';
import {staffGeometry} from '../src/js/notation/geometry.js';

test('staff notes and click targets stay inside barlines while bar boundaries follow variable audio timing',()=>{
  const score=emptyScore(16);score.timeline.anchors=[{position:fraction(0),time:0},{position:fraction(1),time:.4},{position:fraction(4),time:2.5},{position:fraction(8),time:4}];
  const geometry=staffGeometry(score,[0,1],800,{start:0,end:4});
  expect(geometry.bars[0].right).toBe(500);expect(geometry.bars[1].left).toBe(500);
  for(const q of [0,1/3,1,3.5,4,5,7.5]){
    const bar=geometry.bars[q<4?0:1],x=geometry.qx(q);
    expect(x).toBeGreaterThan(bar.left+15);expect(x).toBeLessThan(bar.right-15);expect(geometry.quarterAt(bar,x)).toBeCloseTo(q,10);
  }
});
test('expanded score reserves room for grace notes and final notes independent of waveform scale',()=>{
  const score=emptyScore(16);score.bars=[{measureId:score.timeline.measures[0].id,hits:[{offset:fraction(0),flam:true}]}];
  const geometry=staffGeometry(score,[0,1],800),bar=geometry.bars[0];
  expect(geometry.qx(0)-bar.left).toBe(46);expect(geometry.qx(3.9375)).toBeLessThan(bar.right-18);
  expect(geometry.quarterAt(bar,geometry.qx(1/3))).toBeCloseTo(1/3,12);
});
