import {staffGeometry} from './geometry.js';
import {Renderer,Stave,StaveNote,TickContext,ModifierContext,Dot,Parenthesis,Modifier,Annotation,Articulation,GraceNote,GraceNoteGroup,Beam,Tuplet} from 'vexflow/bravura';
import {KIT,number,starts,toTime,fraction,compare,add,subtract,durationOf,groupAt} from '../../../shared/notation.ts';
export const xml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const color=name=>getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function withDerivedRests(bar,measure){
  const hits=[...(bar?.hits||[])];if(!hits.length)return hits;
  for(const voice of [1,2]){const events=hits.filter(h=>h.voice===voice).sort((a,b)=>compare(a.offset,b.offset));if(!events.length)continue;let cursor=fraction(0);
    const gap=end=>{let guard=0;while(compare(cursor,end)<0&&guard++<256){const remaining=subtract(end,cursor),candidates=[];
      for(const value of [4,8,16,32,64])for(const tuplet of [1,3,5,7]){const duration=durationOf(value,false,tuplet);if(compare(duration,remaining)<=0)candidates.push({value,tuplet,duration});}
      candidates.sort((a,b)=>compare(b.duration,a.duration));const next=candidates[0];if(!next)break;
      hits.push({id:`derived-${voice}-${number(cursor)}`,instrument:'rest',voice,offset:cursor,...next,dotted:false,ghost:false,accent:false,flam:false,sticking:'',synthetic:true});cursor=add(cursor,next.duration);
    }};
    for(const h of events){gap(h.offset);const end=add(h.offset,h.duration);if(compare(end,cursor)>0)cursor=end;}gap(measure.length);
  }
  return hits;
}
export function describe(hit){return `${KIT.find(k=>k.id===hit.instrument)?.name||'Rest'}, ${hit.dotted?'dotted ':''}1/${hit.value}${hit.tuplet>1?`, ${hit.tuplet}-tuplet`:''}${hit.ghost?', ghost':''}${hit.accent?', accent':''}${hit.flam?', flam':''}${hit.sticking?`, ${hit.sticking} hand`:''}, voice ${hit.voice}`;}

/** Shared bar boundaries with interior engraving space; musical wrapping in score view. */
export function renderStaff(host,{score,indices,width,timeRange=null,selected=new Set(),cursor,voice='all',print=false,range=null}) {
  host.replaceChildren();const height=172,renderer=new Renderer(host,Renderer.Backends.SVG);renderer.resize(width,height);
  const ctx=renderer.getContext(),ink=print?'#111':color('--text')||'#17201f',accent=print?'#111':color('--accent')||'#174bd1',muted=print?'#555':color('--muted')||'#68716d';
  ctx.setFillStyle(ink);ctx.setStrokeStyle(ink);
  const positions=starts(score.timeline),geometry=staffGeometry(score,indices,width,timeRange),{boundaryX,qx,bars,quarterAt}=geometry;
  const targets=[];
  for(const index of indices){
    const measure=score.timeline.measures[index],start=positions[index],end=start+number(measure.length),left=boundaryX(start),right=boundaryX(end);
    if(!print&&range&&index>=range[0]&&index<=range[1]){ctx.setFillStyle(color('--selected')||'#edf2ff');ctx.fillRect(left,0,right-left,19);}
    const stave=new Stave(left,35,right-left);stave.setStyle({strokeStyle:muted});stave.setContext(ctx).draw();
    ctx.setFont('Arial',11);ctx.setFillStyle(ink);ctx.fillText(String(index+1),left+5,13);
    ctx.setFont('Arial',10);ctx.setFillStyle(muted);if(index===indices[0]||score.timeline.measures[index-1].numerator!==measure.numerator||score.timeline.measures[index-1].denominator!==measure.denominator)ctx.fillText(`${measure.numerator}/${measure.denominator}`,left+5,153);
    const bar=score.bars.find(b=>b.measureId===measure.id),hits=withDerivedRests(bar,measure).filter(h=>voice==='all'||h.voice===Number(voice));

    if(!hits.length){if(bar?.coverage==='reviewed'){const rest=new StaveNote({clef:'percussion',keys:['b/4'],duration:'1r'});rest.setStave(stave);new TickContext().addTickable(rest).preFormat().setX((left+right)/2-stave.getNoteStartX());rest.setStyle({fillStyle:ink,strokeStyle:ink});rest.setContext(ctx).draw();}else{ctx.setFont('Arial',11);ctx.setFillStyle(muted);ctx.fillText('Not transcribed',Math.max(8,left+(right-left)/2-36),126);}}
    if(bar?.coverage==='reviewed'){ctx.setFont('Arial',9);ctx.setFillStyle(muted);ctx.fillText('Reviewed',right-52,13);}
    const groups=new Map();
    for(const hit of hits){const key=`${number(hit.offset)}:${hit.voice}:${hit.value}:${hit.dotted}:${hit.tuplet}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(hit);}
    const notes=[];
    for(const group of groups.values()){
      const hit=group[0],rest=hit.instrument==='rest';
      const note=new StaveNote({clef:'percussion',keys:group.map(h=>KIT.find(k=>k.id===h.instrument)?.note||'b/4'),duration:String(hit.value)+(rest?'r':''),stemDirection:hit.voice===1?1:-1});
      note.setStave(stave);note.setStyle({fillStyle:hit.synthetic?muted:ink,strokeStyle:hit.synthetic?muted:ink});
      if(rest)note.setKeyLine(0,hit.voice===1?4:1);
      if(hit.dotted)Dot.buildAndAttach([note],{all:true});
      group.forEach((h,i)=>{
        if(selected.has(h.id))note.setKeyStyle(i,{fillStyle:accent,strokeStyle:accent});
        if(h.ghost){note.addModifier(new Parenthesis(Modifier.Position.LEFT),i);note.addModifier(new Parenthesis(Modifier.Position.RIGHT),i);}
        if(h.accent)note.addModifier(new Articulation('a>').setPosition(Modifier.Position.ABOVE),i);
        if(h.sticking)note.addModifier(new Annotation(h.sticking).setVerticalJustification(Annotation.VerticalJustify.BOTTOM),i);
        if(h.instrument==='openHat')note.addModifier(new Annotation('o').setVerticalJustification(Annotation.VerticalJustify.TOP),i);
        if(h.flam)note.addModifier(new GraceNoteGroup([new GraceNote({keys:[KIT.find(k=>k.id===h.instrument)?.note||'c/5'],duration:'16',slash:true})],true),i);
      });
      const modifiers=new ModifierContext();note.addToModifierContext(modifiers);modifiers.preFormat();
      const x=qx(start+number(hit.offset)),tick=new TickContext().addTickable(note).preFormat().setX(x-stave.getNoteStartX());
      tick.setX(tick.getX()+x-note.getAbsoluteX()-note.getGlyphWidth()/2);
      notes.push({note,group,x,offset:number(hit.offset),voice:hit.voice,value:hit.value,tuplet:hit.tuplet});
    }
    const beams=[];const tuplets=[];
    for(const v of [1,2]){
      const ordered=notes.filter(n=>n.voice===v).sort((a,b)=>a.offset-b.offset);
      let run=[];const flush=()=>{if(run.length>1){try{beams.push(new Beam(run.map(n=>n.note)));}catch{}}run=[];};
      for(const item of ordered){const previous=run.at(-1);if(item.value<8||item.note.isRest()||(previous&&(groupAt(measure,previous.offset)!==groupAt(measure,item.offset)||Math.abs(previous.offset+number(previous.group[0].duration)-item.offset)>1e-6)))flush();if(item.value>=8&&!item.note.isRest())run.push(item);}flush();
      for(let i=0;i<ordered.length;i++){const n=ordered[i];if(n.tuplet<=1)continue;const group=ordered.slice(i,i+n.tuplet);if(group.length===n.tuplet&&group.every(g=>g.tuplet===n.tuplet&&g.value===n.value)){tuplets.push(new Tuplet(group.map(g=>g.note),{numNotes:n.tuplet,notesOccupied:2,bracketed:true}));i+=n.tuplet-1;}else{ctx.setFont('Arial',10);ctx.setFillStyle(muted);ctx.fillText(String(n.tuplet),n.x,45);}}
    }
    for(const {note,group,x} of notes){note.setContext(ctx).draw();const ys=note.getYs();group.forEach((hit,i)=>{if(!hit.synthetic)targets.push({hit,index,x,y:ys[i]});});}
    for(const beam of beams)beam.setContext(ctx).draw();for(const tuplet of tuplets)tuplet.setContext(ctx).draw();
  }
  const svg=host.querySelector('svg');svg.setAttribute('aria-hidden','true');svg.style.overflow='hidden';
  if(cursor!=null){const line=document.createElementNS('http://www.w3.org/2000/svg','line');line.setAttribute('x1',qx(cursor));line.setAttribute('x2',qx(cursor));line.setAttribute('y1','28');line.setAttribute('y2','146');line.setAttribute('stroke',accent);line.setAttribute('stroke-dasharray','4 3');svg.append(line);}
  return {targets,bars,qx,height,quarterAt};
}

export function renderLanes(host,{score,indices,width,timeRange,selected,cursor,voice='all'}) {
  const positions=starts(score.timeline),height=KIT.length*30+34,qx=q=>(toTime(score.timeline,q)-timeRange.start)/(timeRange.end-timeRange.start)*width;
  const targets=[],bars=[];
  const bits=[`<svg width="${width}" height="${height}" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">`];
  for(let row=0;row<KIT.length;row++){const y=26+row*30;bits.push(`<path d="M0 ${y+15}H${width}" stroke="var(--border)" opacity=".5"/>`);}
  for(const index of indices){const m=score.timeline.measures[index],start=positions[index],left=qx(start),right=qx(start+number(m.length));bars.push({index,left,right});
    const bar=score.bars.find(b=>b.measureId===m.id);bits.push(`<path d="M${left} 0V${height}" stroke="var(--border)"/><text x="${left+6}" y="14" fill="var(--muted)" font-size="11">${index+1}</text>`);
    if(!bar||bar.coverage==='unstarted')bits.push(`<rect x="${left}" y="20" width="${right-left}" height="${height-20}" fill="var(--grid-minor)"/><text x="${left+8}" y="${height-8}" fill="var(--muted)" font-size="10">Not transcribed</text>`);
    for(let q=.25;q<number(m.length);q+=.25){const x=qx(start+q);bits.push(`<path d="M${x} 20V${height}" stroke="var(--grid-minor)"${Number.isInteger(q)?' stroke-width="2"':''}/>`);}
    for(const hit of bar?.hits||[]){if(hit.instrument==='rest'||(voice!=='all'&&hit.voice!==Number(voice)))continue;const row=KIT.findIndex(k=>k.id===hit.instrument),x=qx(start+number(hit.offset)),y=26+row*30;
      bits.push(`<rect x="${x-5}" y="${y-5}" rx="2" width="10" height="10" fill="${hit.ghost?'var(--bg-2)':selected.has(hit.id)?'var(--accent)':'var(--drums)'}" stroke="${selected.has(hit.id)?'var(--accent)':'var(--drums)'}" stroke-width="${hit.accent?3:1}"/>`);
      if(hit.flam)bits.push(`<circle cx="${x-11}" cy="${y}" r="2" fill="var(--drums)"/>`);targets.push({hit,index,x,y});
    }
  }
  bits.push(`<path d="M${qx(cursor)} 20V${height}" stroke="var(--accent)" stroke-dasharray="4 3"/></svg>`);host.innerHTML=bits.join('');return {targets,bars,qx,height};
}
