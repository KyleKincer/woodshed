import {starts,number,toTime,toQuarter,locate} from '../../../shared/notation.ts';

/** Waveforms share bar boundaries; engraved noteheads use the bar's interior. */
export function staffGeometry(score,indices,width,timeRange=null){
  const timeline=score.timeline,positions=starts(timeline);
  const first=positions[indices[0]],total=indices.reduce((sum,i)=>sum+number(timeline.measures[i].length),0);
  const boundaryX=q=>timeRange?(toTime(timeline,q)-timeRange.start)/(timeRange.end-timeRange.start)*width:24+(q-first)/total*(width-48);
  const bars=indices.map(index=>{
    const start=positions[index],end=start+number(timeline.measures[index].length),left=boundaryX(start),right=boundaryX(end);
    const bar=score.bars.find(b=>b.measureId===timeline.measures[index].id),leading=bar?.hits.some(h=>number(h.offset)===0&&h.flam)?46:22;
    return {index,start,end,left,right,noteLeft:left+leading,noteRight:Math.max(left+leading+1,right-18)};
  });
  const clamp=n=>Math.max(0,Math.min(1,n));
  const qx=q=>{
    const index=locate(timeline,q).index,bar=bars.find(b=>b.index===index);
    if(!bar)return q<first?-100:width+100;
    return bar.noteLeft+clamp((boundaryX(q)-bar.left)/(bar.right-bar.left))*(bar.noteRight-bar.noteLeft);
  };
  const quarterAt=(bar,x)=>{
    const relative=clamp((x-bar.noteLeft)/(bar.noteRight-bar.noteLeft));
    return timeRange?toQuarter(timeline,toTime(timeline,bar.start)+relative*(toTime(timeline,bar.end)-toTime(timeline,bar.start))):bar.start+relative*(bar.end-bar.start);
  };
  return {bars,boundaryX,qx,quarterAt};
}
