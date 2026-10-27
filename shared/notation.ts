/** Canonical musical data. No renderer, audio clock or DOM types belong here. */
export type Fraction = {n:number; d:number};
export type Measure = {id:string; numerator:number; denominator:number; length:Fraction; label:string; grouping?:number[]};
export type Anchor = {position:Fraction; time:number};
export type Timeline = {version:1; measures:Measure[]; anchors:Anchor[]};
/**
 * A drum hit stores only *when* it sounds and how it is played. Written
 * durations, rests and tuplet brackets are derived by shared/engrave.ts.
 */
export type Hit = {id:string; offset:Fraction; instrument:string; voice:1|2;
  accent:boolean; ghost:boolean; flam:boolean; sticking:''|'L'|'R'; velocity:number;
  /** Heavy (marcato) accent. */ heavy?:boolean;
  /** Two-note drag/ruff grace instead of a single flam grace. */ drag?:boolean;
  /** Tremolo slashes: 1 = 8th, 2 = 16th, 3 = 32nd roll. */ roll?:number};
/** Explicit tuplet: `count` equal divisions of `length` from `start`. Overrides automatic beat grids. */
export type TupletSpan = {start:Fraction; length:Fraction; count:number; voice?:1|2};
export type Bar = {measureId:string; coverage:'unstarted'|'progress'|'reviewed'; hits:Hit[]; tuplets?:TupletSpan[]};
/** 'combined' (default) writes one rhythm like Guitar Pro and Songsterr; 'split' writes hands stems-up and feet stems-down. */
export type Layout = 'split'|'combined';
export type Score = {version:2; title:string; layout?:Layout; timeline:Timeline; bars:Bar[]};
/** Version 1 stored authored durations on each hit. Kept only for upgrade-on-read. */
export type HitV1 = {id:string; offset:Fraction; duration:Fraction; instrument:string; voice:1|2;
  value:number; dotted:boolean; tuplet:number; accent:boolean; ghost:boolean; flam:boolean; sticking:''|'L'|'R'; velocity:number};
export const MAX_MEASURES=1024, MAX_HITS_PER_BAR=256, MAX_HITS=16000, MAX_TUPLETS_PER_BAR=32;
type KitPiece = {id:string; name:string; short:string; key:string; midi:number; gp:number; line:number; voice:1|2; family:'cymbal'|'drum'|'foot'|'aux'; core?:boolean};
/**
 * Staff order, top to bottom. `gp` is the Guitar Pro 7 / alphaTab percussion
 * articulation (notehead, staff line and technique symbol); `line` is its
 * staff position in half-spaces below the top line; `midi` is the
 * General MIDI note used for playback and interchange. The original 11 piece
 * ids are retained so stored parts never need renaming.
 */
export const KIT:readonly KitPiece[] = [
  {id:'china',name:'China',short:'China',key:'q',midi:52,gp:52,line:-3,voice:1,family:'cymbal'},
  {id:'chinaChoke',name:'China (choke)',short:'China ✕',key:'',midi:52,gp:96,line:-3,voice:1,family:'cymbal'},
  {id:'splash',name:'Splash',short:'Splash',key:'w',midi:55,gp:55,line:-2,voice:1,family:'cymbal'},
  {id:'splashChoke',name:'Splash (choke)',short:'Splash ✕',key:'',midi:55,gp:95,line:-2,voice:1,family:'cymbal'},
  {id:'crash',name:'Crash',short:'Crash',key:'c',midi:49,gp:49,line:-2,voice:1,family:'cymbal',core:true},
  {id:'crashChoke',name:'Crash (choke)',short:'Crash ✕',key:'',midi:49,gp:97,line:-2,voice:1,family:'cymbal'},
  {id:'crash2',name:'Crash 2',short:'Crash 2',key:'e',midi:57,gp:57,line:-1,voice:1,family:'cymbal'},
  {id:'crash2Choke',name:'Crash 2 (choke)',short:'Crash 2 ✕',key:'',midi:57,gp:98,line:-1,voice:1,family:'cymbal'},
  {id:'openHat',name:'Open hi-hat',short:'Open HH',key:'j',midi:46,gp:46,line:-1,voice:1,family:'cymbal',core:true},
  {id:'halfHat',name:'Half-open hi-hat',short:'Half HH',key:'l',midi:46,gp:92,line:-1,voice:1,family:'cymbal'},
  {id:'closedHat',name:'Closed hi-hat',short:'Hi-hat',key:'h',midi:42,gp:42,line:-1,voice:1,family:'cymbal',core:true},
  {id:'ride',name:'Ride',short:'Ride',key:'d',midi:51,gp:51,line:0,voice:1,family:'cymbal',core:true},
  {id:'rideEdge',name:'Ride (edge)',short:'Ride edge',key:'o',midi:59,gp:93,line:0,voice:1,family:'cymbal'},
  {id:'rideBell',name:'Ride bell',short:'Bell',key:'b',midi:53,gp:53,line:0,voice:1,family:'cymbal',core:true},
  {id:'rideChoke',name:'Ride (choke)',short:'Ride ✕',key:'',midi:51,gp:94,line:0,voice:1,family:'cymbal'},
  {id:'cowbell',name:'Cowbell',short:'Cowbell',key:'m',midi:56,gp:56,line:0,voice:1,family:'aux'},
  {id:'tom1',name:'High tom',short:'Tom 1',key:'y',midi:50,gp:50,line:1,voice:1,family:'drum'},
  {id:'rackTom',name:'Rack tom',short:'Tom 2',key:'t',midi:48,gp:48,line:2,voice:1,family:'drum',core:true},
  {id:'tom3',name:'Mid tom',short:'Tom 3',key:'u',midi:47,gp:47,line:4,voice:1,family:'drum'},
  {id:'snare',name:'Snare',short:'Snare',key:'s',midi:38,gp:38,line:3,voice:1,family:'drum',core:true},
  {id:'rimshot',name:'Rimshot',short:'Rimshot',key:'z',midi:40,gp:91,line:3,voice:1,family:'drum'},
  {id:'crossStick',name:'Cross-stick',short:'X-stick',key:'x',midi:37,gp:37,line:3,voice:1,family:'drum',core:true},
  {id:'tom4',name:'Low tom',short:'Tom 4',key:'i',midi:45,gp:45,line:5,voice:1,family:'drum'},
  {id:'floorTom',name:'Floor tom',short:'Floor',key:'f',midi:43,gp:43,line:6,voice:1,family:'drum',core:true},
  {id:'floorTom2',name:'Low floor tom',short:'Floor 2',key:'v',midi:41,gp:41,line:5,voice:1,family:'drum'},
  {id:'kick',name:'Kick',short:'Kick',key:'k',midi:36,gp:36,line:7,voice:2,family:'foot',core:true},
  {id:'pedalHat',name:'Pedal hi-hat',short:'HH pedal',key:'p',midi:44,gp:44,line:9,voice:2,family:'foot',core:true},
];
export const kitPiece=(id:string)=>KIT.find(k=>k.id===id);
import {engraveBar,rhythmCells,chooseGrid} from './engrave';
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
  return {version:2,title:'Drums',timeline,bars:[]};
}
export function validateTimeline(t:Timeline) {
  if(t.version!==1||!t.measures.length||t.measures.length>MAX_MEASURES||t.anchors.length<2||t.anchors.length>8192)throw new Error('Invalid score timeline.');
  const ids=new Set<string>();
  for(const m of t.measures){if(!m.id||m.id.length>80||ids.has(m.id)||!Number.isInteger(m.numerator)||m.numerator<1||m.numerator>16||![1,2,4,8,16].includes(m.denominator)||m.label.length>120)throw new Error('Invalid measure.');ids.add(m.id);validateFraction(m.length);if(number(m.length)<=0||number(m.length)>m.numerator*4/m.denominator)throw new Error('Invalid measure length.');if(m.grouping&&(!m.grouping.length||m.grouping.length>16||m.grouping.some(n=>!Number.isInteger(n)||n<1)||m.grouping.reduce((a,b)=>a+b,0)!==m.numerator))throw new Error('Beat groups must add up to the meter numerator.');}
  let p=-Infinity,time=-Infinity;
  for(const a of t.anchors){validateFraction(a.position);if(number(a.position)<=p||!Number.isFinite(a.time)||a.time<0||a.time<=time)throw new Error('Alignment anchors must move forward in both music and audio time.');p=number(a.position);time=a.time;}
}
function validateFraction(f:Fraction){if(!Number.isSafeInteger(f.n)||Math.abs(f.n)>1e8||!Number.isSafeInteger(f.d)||f.d<1||f.d>1e6)throw new Error('Musical fraction is out of range.');}
const isWritableLength=(f:Fraction)=>[1,2,4,8,16,32,64].some(v=>compare(f,fraction(4,v))===0||compare(f,fraction(6,v))===0);
export function validateBar(input:Bar|unknown,timeline:Timeline) {
  const m=timeline.measures.find(m=>m.id===(input as Bar)?.measureId);
  const bar=m?currentBar(input,m):upgradeBar(input);if(!m||bar.hits.length>MAX_HITS_PER_BAR||!['unstarted','progress','reviewed'].includes(bar.coverage))throw new Error('Invalid bar.');
  const ids=new Set<string>(),slots=new Set<string>();
  for(const h of bar.hits){validateFraction(h.offset);
    const slot=`${number(h.offset)}:${h.instrument}`;
    if(['accent','ghost','flam'].some(k=>typeof h[k as keyof Hit]!=='boolean')||['heavy','drag'].some(k=>h[k as keyof Hit]!==undefined&&typeof h[k as keyof Hit]!=='boolean')||(h.roll!==undefined&&![0,1,2,3].includes(h.roll))||!h.id||h.id.length>80||ids.has(h.id)||slots.has(slot)||compare(h.offset,fraction(0))<0||compare(h.offset,m.length)>=0||!kitPiece(h.instrument)||![1,2].includes(h.voice)||!['','L','R'].includes(h.sticking)||!Number.isFinite(h.velocity)||h.velocity<0.05||h.velocity>1)throw new Error('A note does not fit this bar or has invalid data.');
    ids.add(h.id);slots.add(slot);
  }
  const spans=bar.tuplets??[];
  if(spans.length>MAX_TUPLETS_PER_BAR)throw new Error('Too many tuplets in one bar.');
  for(const t of spans){validateFraction(t.start);validateFraction(t.length);
    if(!Number.isInteger(t.count)||t.count<2||t.count>16||(t.voice!==undefined&&![1,2].includes(t.voice))||compare(t.start,fraction(0))<0||compare(add(t.start,t.length),m.length)>0||!isWritableLength(t.length))throw new Error('Invalid tuplet.');}
  for(let i=0;i<spans.length;i++)for(let j=i+1;j<spans.length;j++){const a=spans[i],b=spans[j];
    if((a.voice&&b.voice&&a.voice!==b.voice))continue;
    if(compare(a.start,add(b.start,b.length))<0&&compare(b.start,add(a.start,a.length))<0)throw new Error('Tuplets overlap.');}
  // Every bar must be writable in both stem layouts a reader can choose.
  engraveBar(bar,m,'split');engraveBar(bar,m,'combined');
}
export function validateScore(score:Score){if(score.version!==2||!score.title.trim()||score.title.length>100||(score.layout!==undefined&&!['split','combined'].includes(score.layout)))throw new Error('Invalid drum part.');validateTimeline(score.timeline);if(score.bars.length>MAX_MEASURES||new Set(score.bars.map(b=>b.measureId)).size!==score.bars.length||score.bars.reduce((n,b)=>n+b.hits.length,0)>MAX_HITS)throw new Error('This score exceeds its supported size.');for(const b of score.bars)validateBar(b,score.timeline);}

/** Version 1 hits carried authored durations; v2 derives them. Explicit rests are dropped. */
export function upgradeBar(input:any):Bar {
  if(!input||!Array.isArray(input.hits)||!input.hits.some((h:any)=>'duration' in h||h.instrument==='rest'))return input as Bar;
  return {measureId:input.measureId,coverage:input.coverage,hits:input.hits.filter((h:any)=>h.instrument!=='rest').map(({duration,value,dotted,tuplet,...h}:any)=>h),...(input.tuplets?{tuplets:input.tuplets}:{})};
}
export function upgradeScore(input:any):Score {
  if(!input||typeof input!=='object')throw new Error('Invalid drum part.');
  if(input.version!==1&&input.version!==2)throw new Error('This drum part was saved by a newer version of Woodshed. Update Woodshed to open it.');
  const measures=new Map<string,Measure>((input.timeline?.measures||[]).map((m:Measure)=>[m.id,m]));
  const bars=(input.bars||[]).map((b:any)=>measures.has(b?.measureId)?currentBar(b,measures.get(b.measureId)!):upgradeBar(b));
  return input.version===2?{...input,bars}:{version:2,title:input.title,timeline:input.timeline,bars};
}
const isLegacyBar=(input:any)=>Array.isArray(input?.hits)&&input.hits.some((h:any)=>'duration' in h||h.instrument==='rest');
/**
 * A bar in the current format. Version 1 positions the engraver cannot write
 * (the old importer kept 1/96, 1/40 and 1/56 quarter positions) are snapped
 * per beat to the simplest grid, so every legacy part still opens.
 */
export function currentBar(input:any,measure:Measure):Bar {
  const bar=upgradeBar(input);
  if(!isLegacyBar(input))return bar;
  try{engraveBar(bar,measure,'split');engraveBar(bar,measure,'combined');return bar;}catch{}
  const cells=rhythmCells(measure),seen=new Set<string>(),hits:Hit[]=[];
  for(const cell of cells){
    const end=add(cell.start,cell.length),inside=bar.hits.filter(h=>compare(h.offset,cell.start)>=0&&compare(h.offset,end)<0);
    if(!inside.length)continue;
    const length=number(cell.length),s=chooseGrid(length,inside.map(h=>number(h.offset)-number(cell.start)));
    for(const h of inside){
      let steps=Math.round((number(h.offset)-number(cell.start))*s/length);
      if(steps>=s&&compare(end,measure.length)>=0)steps=s-1;
      const offset=add(cell.start,fraction(steps*cell.length.n,cell.length.d*s)),key=`${number(offset)}:${h.instrument}`;
      if(seen.has(key))continue;seen.add(key);hits.push({...h,offset});
    }
  }
  return {...bar,hits};
}
/** Immutable transactions give every edit a single inverse and preserve audio time. */
export class ScoreEditor {
  score:Score; undoStack:Score[]=[]; redoStack:Score[]=[];
  constructor(score:Score){score=upgradeScore(score);validateScore(score);this.score=structuredClone(score);}
  transact(change:(draft:Score)=>void){const draft=structuredClone(this.score);change(draft);validateScore(draft);if(JSON.stringify(draft)===JSON.stringify(this.score))return false;this.undoStack.push(this.score);if(this.undoStack.length>100)this.undoStack.shift();this.redoStack=[];this.score=draft;return true;}
  undo(){const previous=this.undoStack.pop();if(!previous)return false;this.redoStack.push(this.score);this.score=previous;return true;}
  redo(){const next=this.redoStack.pop();if(!next)return false;this.undoStack.push(this.score);this.score=next;return true;}
  bar(index:number,draft=this.score):Bar {const measureId=draft.timeline.measures[index]?.id;if(!measureId)throw new Error('Choose a bar in the song.');let bar=draft.bars.find(b=>b.measureId===measureId);if(!bar){bar={measureId,coverage:'unstarted',hits:[]};draft.bars.push(bar);}return bar;}
  insert(index:number,hit:Hit){const existing=this.score.bars.find(b=>b.measureId===this.score.timeline.measures[index].id)?.hits.find(h=>h.instrument===hit.instrument&&compare(h.offset,hit.offset)===0);if(existing)return existing.id;
    this.transact(s=>{const bar=this.bar(index,s);bar.hits.push(hit);bar.coverage='progress';});return hit.id;}
  remove(ids:Set<string>){return this.transact(s=>{for(const b of s.bars){const hits=b.hits.filter(h=>!ids.has(h.id));if(hits.length!==b.hits.length){b.hits=hits;b.coverage='progress';}}});}
  change(ids:Set<string>,patch:Partial<Hit>){return this.transact(s=>{for(const b of s.bars)for(const h of b.hits)if(ids.has(h.id)){Object.assign(h,patch);for(const k of ['heavy','drag','roll'] as const)if(h[k]===undefined||h[k]===false||h[k]===0)delete h[k];b.coverage='progress';}});}
  /** Set or clear (count 0) an explicit tuplet over [start, start+length) of a bar. */
  setTuplet(index:number,span:TupletSpan|null,start:Fraction,length:Fraction){return this.transact(s=>{const bar=this.bar(index,s),end=add(start,length);
    const tuplets=(bar.tuplets??[]).filter(t=>compare(t.start,end)>=0||compare(add(t.start,t.length),start)<=0);
    if(span)tuplets.push(span);tuplets.sort((a,b)=>compare(a.start,b.start));if(tuplets.length)bar.tuplets=tuplets;else delete bar.tuplets;bar.coverage='progress';});}
  setLayout(layout:Layout){return this.transact(s=>{if(layout==='combined')delete s.layout;else s.layout=layout;});}
  move(ids:Set<string>,delta:Fraction){return this.transact(s=>{const positions=musicalStarts(s.timeline),moving:{hit:Hit;position:Fraction}[]=[];
    for(const bar of s.bars){const index=s.timeline.measures.findIndex(m=>m.id===bar.measureId);for(const hit of bar.hits)if(ids.has(hit.id))moving.push({hit,position:add(add(positions[index],hit.offset),delta)});if(bar.hits.some(h=>ids.has(h.id))){bar.hits=bar.hits.filter(h=>!ids.has(h.id));bar.coverage='progress';}}
    for(const {hit,position} of moving){if(number(position)<0||number(position)>=extent(s.timeline))throw new Error('The selected notes would move outside the song.');const target=locate(s.timeline,number(position)),bar=this.bar(target.index,s);if(bar.hits.some(h=>h.instrument===hit.instrument&&compare(h.offset,subtract(position,target.startPosition))===0))throw new Error('That drum already has a note there.');bar.hits.push({...hit,offset:subtract(position,target.startPosition)});bar.coverage='progress';}
  });}
  pasteHits(position:Fraction,hits:{hit:Hit;offset:Fraction}[]){return this.transact(s=>{for(const item of hits){const q=add(position,item.offset);if(number(q)<0||number(q)>=extent(s.timeline))throw new Error('The pasted notes extend beyond the song.');const target=locate(s.timeline,number(q)),bar=this.bar(target.index,s),offset=subtract(q,target.startPosition);bar.hits=bar.hits.filter(h=>!(h.instrument===item.hit.instrument&&compare(h.offset,offset)===0));bar.hits.push({...structuredClone(item.hit),id:id(),offset});bar.coverage='progress';}});}
  paste(from:number,to:number,count=1,replace=false,source:Bar[]=[]) {return this.transact(s=>{if(!source.length)throw new Error('Copy a passage first.');if(!Number.isInteger(count)||count<1||count>64||to+source.length*count>s.timeline.measures.length)throw new Error('The repeated passage extends beyond the song.');for(let repeat=0;repeat<count;repeat++)for(let i=0;i<source.length;i++){const target=this.bar(to+repeat*source.length+i,s);if(target.hits.length&&!replace)throw new Error('The destination contains notes. Enable Replace written notes to continue.');target.hits=source[i].hits.map(h=>({...structuredClone(h),id:id()}));if(source[i].tuplets?.length)target.tuplets=structuredClone(source[i].tuplets);else delete target.tuplets;target.coverage=source[i].coverage==='unstarted'?'unstarted':'progress';}});}
}
