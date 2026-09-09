import {id,fraction,number,add,durationOf,emptyScore,validateScore,KIT,musicalStarts,locate,subtract,extent} from '../../../shared/notation.ts';

/** Seed a draft from the actual practice pulses, without rounding audio times. */
export function scoreFromTiming(duration,metronome){
  const beats=(metronome.beats||[]).filter(b=>Number.isFinite(b.time)&&b.time>=0&&b.time<duration)
    .sort((a,b)=>a.time-b.time).filter((b,i,a)=>!i||b.time>a[i-1].time);
  const initial=metronome.sectionAt(beats[0]?.time||0);
  if(!beats.length){
    const score=emptyScore(duration,initial.bpm,initial.beatsPerBar,4,0),unit=initial.unit||4;
    for(const m of score.timeline.measures){m.denominator=unit;m.length=fraction(4*m.numerator,unit);m.grouping=Array(m.numerator).fill(1);}
    for(const a of score.timeline.anchors)a.position=fraction(a.position.n*4,a.position.d*unit);
    validateScore(score);return score;
  }
  const measures=[],anchors=[];let q=fraction(0),begin=0;
  while(begin<beats.length){
    const section=metronome.sectionAt(beats[begin].time),d=section.unit||4;
    const next=beats.findIndex((b,i)=>i>begin&&b.downbeat);
    const end=next<0?beats.length:next,count=end-begin;
    // Edited/detected downbeats define bars. Split implausibly long runs at
    // the existing meter, retaining every pulse and its exact timestamp.
    const nominal=Math.max(1,Math.min(16,(metronome.source==='detected'&&next<0?measures.at(-1)?.numerator:section.beatsPerBar)||4));
    const take=count>16?nominal:count,n=next>=0&&count<=16?count:Math.max(take,nominal);
    const pickup=begin===0&&!beats[begin].downbeat;
    measures.push({id:id(),numerator:pickup?Math.max(n,nominal):n,denominator:d,
      length:fraction(4*(next<0?n:take),d),label:pickup?'Pickup':'',grouping:Array(pickup?Math.max(n,nominal):n).fill(1)});
    for(let i=0;i<take;i++)anchors.push({position:add(q,fraction(4*i,d)),time:beats[begin+i].time});
    q=add(q,measures.at(-1).length);begin+=take;
  }
  // The final pulse needs a slope even for very short recordings.
  const last=anchors.at(-1),section=metronome.sectionAt(last.time);
  const interval=anchors.length>1?last.time-anchors.at(-2).time:60/section.bpm;
  anchors.push({position:add(last.position,fraction(4,section.unit||4)),time:last.time+interval});
  const score={version:1,title:'Drums',timeline:{version:1,measures,anchors},bars:[]};
  validateScore(score);return score;
}

export function snapPosition(score,raw,grid){
  const a=locate(score.timeline,Math.max(0,Math.min(raw,extent(score.timeline)-1e-8)));
  const ticks=Math.max(0,Math.min(Math.round((raw-a.start)/number(grid)),Math.ceil(number(a.measure.length)/number(grid))-1));
  return add(a.startPosition,fraction(ticks*grid.n,grid.d));
}

/** Resize to a written duration; grid placement remains independent. */
export function nearestDuration(length,tuplet=1){
  const choices=[];
  for(const value of [1,2,4,8,16,32,64])for(const dotted of [false,true]){
    const duration=durationOf(value,dotted,tuplet);choices.push({value,dotted,tuplet,duration});
  }
  return choices.sort((a,b)=>Math.abs(number(a.duration)-length)-Math.abs(number(b.duration)-length))[0];
}

/** A whole drag is one validated, undoable transaction. */
export function moveLaneNotes(editor,ids,delta,laneDelta=0){
  return editor.transact(s=>{
    const positions=musicalStarts(s.timeline),moving=[];
    for(const bar of s.bars){const index=s.timeline.measures.findIndex(m=>m.id===bar.measureId);
      for(const hit of bar.hits)if(ids.has(hit.id))moving.push({hit,position:add(add(positions[index],hit.offset),delta)});
      if(bar.hits.some(h=>ids.has(h.id))){bar.hits=bar.hits.filter(h=>!ids.has(h.id));bar.coverage='progress';}
    }
    for(const {hit,position} of moving){
      if(number(position)<0||number(position)>=extent(s.timeline))throw new Error('Notes must stay within the part.');
      const lane=KIT.findIndex(k=>k.id===hit.instrument),kit=KIT[lane+laneDelta];
      if(lane>=0&&!kit)throw new Error('Notes must stay within the drum kit.');
      const target=locate(s.timeline,number(position));
      editor.bar(target.index,s).hits.push({...hit,offset:subtract(position,target.startPosition),
        ...(lane>=0&&laneDelta?{instrument:kit.id,voice:kit.voice}:{})});
      editor.bar(target.index,s).coverage='progress';
    }
  });
}
