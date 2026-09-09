/** Canonical musical data. No renderer, audio clock or DOM types belong here. */
export type Fraction = {n:number; d:number};
export type Measure = {id:string; numerator:number; denominator:number; length:Fraction; label:string; grouping?:number[]};
export type Anchor = {position:Fraction; time:number};
export type Timeline = {version:1; measures:Measure[]; anchors:Anchor[]};
export type Hit = {id:string; offset:Fraction; duration:Fraction; instrument:string; voice:1|2;
  value:number; dotted:boolean; tuplet:number; accent:boolean; ghost:boolean; flam:boolean; sticking:''|'L'|'R'; velocity:number};
export type Bar = {measureId:string; coverage:'unstarted'|'progress'|'reviewed'; hits:Hit[]};
export type Score = {version:1; title:string; timeline:Timeline; bars:Bar[]};
export const MAX_MEASURES=512, MAX_HITS_PER_BAR=256, MAX_HITS=16000;
export const KIT = [
  {id:'crash',name:'Crash',key:'c',midi:49,line:0,note:'a/5/x2',voice:1},
  {id:'ride',name:'Ride',key:'d',midi:51,line:1,note:'f/5/x2',voice:1},
  {id:'rideBell',name:'Ride bell',key:'b',midi:53,line:1,note:'f/5/d2',voice:1},
  {id:'openHat',name:'Open hi-hat',key:'j',midi:46,line:0,note:'g/5/x2',voice:1},
  {id:'closedHat',name:'Closed hi-hat',key:'h',midi:42,line:0,note:'g/5/x2',voice:1},
  {id:'rackTom',name:'Rack tom',key:'t',midi:48,line:2,note:'e/5',voice:1},
  {id:'snare',name:'Snare',key:'s',midi:38,line:3,note:'c/5',voice:1},
  {id:'crossStick',name:'Cross-stick',key:'x',midi:37,line:3,note:'c/5/x2',voice:1},
  {id:'floorTom',name:'Floor tom',key:'f',midi:43,line:4,note:'a/4',voice:1},
  {id:'kick',name:'Kick',key:'k',midi:36,line:5,note:'f/4',voice:2},
  {id:'pedalHat',name:'Pedal hi-hat',key:'p',midi:44,line:6,note:'d/4/x2',voice:2},
] as const;
const gcd=(a:number,b:number):number=>b?gcd(b,a%b):a;
export function fraction(n:number,d=1):Fraction {
  if(!Number.isSafeInteger(n)||!Number.isSafeInteger(d)||d<=0)throw new Error('Invalid musical duration.');
  const g=gcd(Math.abs(n),d)||1;return {n:n/g,d:d/g};
}
export const number=(a:Fraction)=>a.n/a.d;
export const add=(a:Fraction,b:Fraction)=>fraction(a.n*b.d+b.n*a.d,a.d*b.d);
export const subtract=(a:Fraction,b:Fraction)=>fraction(a.n*b.d-b.n*a.d,a.d*b.d);
export const compare=(a:Fraction,b:Fraction)=>a.n*b.d-b.n*a.d;
export const id=()=>crypto.randomUUID();
export const durationOf=(value:number,dotted=false,tuplet=1)=>fraction(4*(dotted?3:1)*(tuplet>1?2:1),value*(dotted?2:1)*tuplet);
/** Meter grouping controls beaming and the counted pulse, independently of BPM. */
export function beatGroups(measure:Measure):number[]{return measure.grouping??(measure.denominator===8&&[6,9,12].includes(measure.numerator)?Array(measure.numerator/3).fill(3):Array(measure.numerator).fill(1));}
export function groupAt(measure:Measure,offset:number){let end=0;const groups=beatGroups(measure);for(let i=0;i<groups.length;i++){end+=groups[i]*4/measure.denominator;if(offset<end-1e-8)return i;}return groups.length-1;}
export function musicalStarts(timeline:Timeline){let q=fraction(0);return timeline.measures.map(m=>{const start=q;q=add(q,m.length);return start;});}
export function starts(timeline:Timeline) {return musicalStarts(timeline).map(number);}
export function extent(timeline:Timeline) {return timeline.measures.reduce((q,m)=>q+number(m.length),0);}
function interpolate(anchors:Anchor[],input:number,inKey:'time'|'position') {
  const x=(a:Anchor)=>inKey==='time'?a.time:number(a.position), y=(a:Anchor)=>inKey==='time'?number(a.position):a.time;
  let low=0,high=anchors.length-1;
  while(low+1<high){const mid=(low+high)>>1;if(x(anchors[mid])<=input)low=mid;else high=mid;}
  if(input>=x(anchors[anchors.length-1]))low=anchors.length-2;
  const a=anchors[low],b=anchors[low+1];return y(a)+(input-x(a))*(y(b)-y(a))/(x(b)-x(a));
}
export const toTime=(timeline:Timeline,q:number)=>interpolate(timeline.anchors,q,'position');
export const toQuarter=(timeline:Timeline,time:number)=>interpolate(timeline.anchors,time,'time');
export function locate(timeline:Timeline,q:number) {
  const positions=starts(timeline);let index=0;for(let i=0;i<positions.length;i++){if(positions[i]<=q+1e-8)index=i;else break;}
  return {index,measure:timeline.measures[index],offset:q-positions[index],start:positions[index],startPosition:musicalStarts(timeline)[index]};
}
export function emptyScore(duration:number,bpm=120,numerator=4,denominator=4,firstDownbeat=0):Score {
  if(!Number.isFinite(bpm)||bpm<5||bpm>800||!Number.isInteger(numerator)||numerator<1||numerator>16||![2,4,8,16].includes(denominator)||!Number.isFinite(firstDownbeat)||firstDownbeat<0||firstDownbeat>=duration)throw new Error('Check the tempo, meter and first downbeat.');
  const barLength=4*numerator/denominator, secondsPerQuarter=60/bpm;
  const total=(duration-firstDownbeat)/secondsPerQuarter, count=Math.ceil(total/barLength);
  if(count>MAX_MEASURES)throw new Error(`This part exceeds ${MAX_MEASURES} bars. Choose a slower tempo or larger meter.`);
  const measures=Array.from({length:Math.max(1,count)},()=>({id:id(),numerator,denominator,length:fraction(4*numerator,denominator),label:''}));
  const timeline:Timeline={version:1,measures,anchors:[{position:fraction(0),time:firstDownbeat},{position:fraction(4*numerator,denominator),time:firstDownbeat+barLength*secondsPerQuarter}]};
  return {version:1,title:'Drums',timeline,bars:[]};
}
export function validateTimeline(t:Timeline) {
  if(t.version!==1||!t.measures.length||t.measures.length>MAX_MEASURES||t.anchors.length<2||t.anchors.length>8192)throw new Error('Invalid score timeline.');
  const ids=new Set<string>();
  for(const m of t.measures){if(!m.id||m.id.length>80||ids.has(m.id)||!Number.isInteger(m.numerator)||m.numerator<1||m.numerator>16||![1,2,4,8,16].includes(m.denominator)||m.label.length>120)throw new Error('Invalid measure.');ids.add(m.id);validateFraction(m.length);if(number(m.length)<=0||number(m.length)>m.numerator*4/m.denominator)throw new Error('Invalid measure length.');if(m.grouping&&(!m.grouping.length||m.grouping.length>16||m.grouping.some(n=>!Number.isInteger(n)||n<1)||m.grouping.reduce((a,b)=>a+b,0)!==m.numerator))throw new Error('Beat groups must add up to the meter numerator.');}
  let p=-Infinity,time=-Infinity;
  for(const a of t.anchors){validateFraction(a.position);if(number(a.position)<=p||!Number.isFinite(a.time)||a.time<0||a.time<=time)throw new Error('Alignment anchors must move forward in both music and audio time.');p=number(a.position);time=a.time;}
}
function validateFraction(f:Fraction){if(!Number.isSafeInteger(f.n)||Math.abs(f.n)>1e8||!Number.isSafeInteger(f.d)||f.d<1||f.d>1e6)throw new Error('Musical fraction is out of range.');}
export function validateBar(bar:Bar,timeline:Timeline) {
  const m=timeline.measures.find(m=>m.id===bar.measureId);if(!m||bar.hits.length>MAX_HITS_PER_BAR||!['unstarted','progress','reviewed'].includes(bar.coverage))throw new Error('Invalid bar.');
  const ids=new Set<string>(),slots=new Set<string>();
  for(const h of bar.hits){validateFraction(h.offset);validateFraction(h.duration);
    const slot=`${number(h.offset)}:${h.instrument}${h.instrument==='rest'?':'+h.voice:''}`;
    if(['dotted','accent','ghost','flam'].some(k=>typeof h[k as keyof Hit]!=='boolean')||!h.id||h.id.length>80||ids.has(h.id)||slots.has(slot)||number(h.offset)<0||number(h.duration)<=0||number(add(h.offset,h.duration))>number(m.length)+1e-8||!(h.instrument==='rest'||KIT.some(k=>k.id===h.instrument))||![1,2].includes(h.voice)||![1,2,4,8,16,32,64].includes(h.value)||![1,3,5,7].includes(h.tuplet)||compare(h.duration,durationOf(h.value,h.dotted,h.tuplet))!==0||!['','L','R'].includes(h.sticking)||!Number.isFinite(h.velocity)||h.velocity<0.05||h.velocity>1)throw new Error('A note does not fit this bar or has invalid data.');
    ids.add(h.id);slots.add(slot);
  }
  for(let i=0;i<bar.hits.length;i++)for(let j=i+1;j<bar.hits.length;j++){
    const a=bar.hits[i],b=bar.hits[j];
    if(a.voice!==b.voice||!overlaps(a,b))continue;
    if(a.instrument==='rest'||b.instrument==='rest'||compare(a.offset,b.offset)!==0||compare(a.duration,b.duration)!==0)throw new Error('These rhythms overlap in one voice. Choose the other voice for an independent rhythm.');
  }
}
export function validateScore(score:Score){if(score.version!==1||!score.title.trim()||score.title.length>100)throw new Error('Invalid drum part.');validateTimeline(score.timeline);if(score.bars.length>MAX_MEASURES||new Set(score.bars.map(b=>b.measureId)).size!==score.bars.length||score.bars.reduce((n,b)=>n+b.hits.length,0)>MAX_HITS)throw new Error('This score exceeds its supported size.');for(const b of score.bars)validateBar(b,score.timeline);}

/** Immutable transactions give every edit a single inverse and preserve audio time. */
export class ScoreEditor {
  score:Score; undoStack:Score[]=[]; redoStack:Score[]=[];
  constructor(score:Score){validateScore(score);this.score=structuredClone(score);}
  transact(change:(draft:Score)=>void){const draft=structuredClone(this.score);change(draft);validateScore(draft);if(JSON.stringify(draft)===JSON.stringify(this.score))return false;this.undoStack.push(this.score);if(this.undoStack.length>100)this.undoStack.shift();this.redoStack=[];this.score=draft;return true;}
  undo(){const previous=this.undoStack.pop();if(!previous)return false;this.redoStack.push(this.score);this.score=previous;return true;}
  redo(){const next=this.redoStack.pop();if(!next)return false;this.undoStack.push(this.score);this.score=next;return true;}
  bar(index:number,draft=this.score):Bar {const measureId=draft.timeline.measures[index]?.id;if(!measureId)throw new Error('Choose a bar in the song.');let bar=draft.bars.find(b=>b.measureId===measureId);if(!bar){bar={measureId,coverage:'unstarted',hits:[]};draft.bars.push(bar);}return bar;}
  insert(index:number,hit:Hit){const existing=this.score.bars.find(b=>b.measureId===this.score.timeline.measures[index].id)?.hits.find(h=>h.instrument===hit.instrument&&compare(h.offset,hit.offset)===0);if(existing)return existing.id;
    this.transact(s=>{const bar=this.bar(index,s);if(hit.instrument==='rest'&&bar.hits.some(h=>h.voice===hit.voice&&overlaps(h,hit)))throw new Error('Delete the notes in this voice before writing a rest here.');if(bar.hits.some(h=>h.voice===hit.voice&&h.instrument==='rest'&&overlaps(h,hit)))throw new Error('Remove the explicit rest before adding a hit here.');bar.hits.push(hit);bar.coverage='progress';});return hit.id;}
  remove(ids:Set<string>){return this.transact(s=>{for(const b of s.bars){const hits=b.hits.filter(h=>!ids.has(h.id));if(hits.length!==b.hits.length){b.hits=hits;b.coverage='progress';}}});}
  change(ids:Set<string>,patch:Partial<Hit>){return this.transact(s=>{for(const b of s.bars)for(const h of b.hits)if(ids.has(h.id)){const next={...h,...patch};if(patch.duration&&b.hits.some(other=>other.id!==h.id&&other.voice===h.voice&&compare(other.offset,h.offset)!==0&&overlaps(other,next)))throw new Error('That duration reaches another written beat. Shorten it or move the other beat first.');Object.assign(h,patch);b.coverage='progress';}});}
  move(ids:Set<string>,delta:Fraction){return this.transact(s=>{const positions=musicalStarts(s.timeline),moving:{hit:Hit;position:Fraction}[]=[];
    for(const bar of s.bars){const index=s.timeline.measures.findIndex(m=>m.id===bar.measureId);for(const hit of bar.hits)if(ids.has(hit.id))moving.push({hit,position:add(add(positions[index],hit.offset),delta)});if(bar.hits.some(h=>ids.has(h.id))){bar.hits=bar.hits.filter(h=>!ids.has(h.id));bar.coverage='progress';}}
    for(const {hit,position} of moving){if(number(position)<0||number(position)>=extent(s.timeline))throw new Error('The selected notes would move outside the song.');const target=locate(s.timeline,number(position)),bar=this.bar(target.index,s);bar.hits.push({...hit,offset:subtract(position,target.startPosition)});bar.coverage='progress';}
  });}
  pasteHits(position:Fraction,hits:{hit:Hit;offset:Fraction}[]){return this.transact(s=>{for(const item of hits){const q=add(position,item.offset);if(number(q)<0||number(q)>=extent(s.timeline))throw new Error('The pasted notes extend beyond the song.');const target=locate(s.timeline,number(q)),bar=this.bar(target.index,s);bar.hits.push({...structuredClone(item.hit),id:id(),offset:subtract(q,target.startPosition)});bar.coverage='progress';}});}
  paste(from:number,to:number,count=1,replace=false,source:Bar[]=[]) {return this.transact(s=>{if(!source.length)throw new Error('Copy a passage first.');if(!Number.isInteger(count)||count<1||count>64||to+source.length*count>s.timeline.measures.length)throw new Error('The repeated passage extends beyond the song.');for(let repeat=0;repeat<count;repeat++)for(let i=0;i<source.length;i++){const target=this.bar(to+repeat*source.length+i,s);if(target.hits.length&&!replace)throw new Error('The destination contains notes. Enable Replace written notes to continue.');target.hits=source[i].hits.map(h=>({...structuredClone(h),id:id()}));target.coverage=source[i].coverage==='unstarted'?'unstarted':'progress';}});}
}
const overlaps=(a:Hit,b:Hit)=>compare(a.offset,add(b.offset,b.duration))<0&&compare(b.offset,add(a.offset,a.duration))<0;
