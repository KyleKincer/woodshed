import {KIT, kitPiece, starts, number, toTime} from '../../../shared/notation.ts';
import {engraveBar, rhythmCells} from '../../../shared/engrave.ts';


/** Deterministic synthesized kit, rendered once into local buffers. No downloads. */
// Each kit piece borrows a synthesized voice; `pitch` scales its frequencies
// and `length` its ring, so variants (toms, crash 2, splash, chokes) differ.
export const VOICES={kick:{voice:'kick'},pedalHat:{voice:'pedalHat'},snare:{voice:'snare'},rimshot:{voice:'snare',pitch:1.15,crack:true},crossStick:{voice:'crossStick'},
  closedHat:{voice:'closedHat'},halfHat:{voice:'openHat',length:.45},openHat:{voice:'openHat'},
  tom1:{voice:'tom',pitch:1.2},rackTom:{voice:'tom'},tom3:{voice:'tom',pitch:.85},tom4:{voice:'floorTom',pitch:1.2},floorTom:{voice:'floorTom'},floorTom2:{voice:'floorTom',pitch:.82},
  ride:{voice:'ride'},rideEdge:{voice:'ride',pitch:.94,length:.9},rideChoke:{voice:'ride',length:.15},rideBell:{voice:'bell'},cowbell:{voice:'cowbell'},
  crash:{voice:'crash'},crashChoke:{voice:'crash',length:.12},crash2:{voice:'crash',pitch:1.1},crash2Choke:{voice:'crash',pitch:1.1,length:.12},
  splash:{voice:'crash',pitch:1.5,length:.4},splashChoke:{voice:'crash',pitch:1.5,length:.1},china:{voice:'china'},chinaChoke:{voice:'china',length:.12}};
const SECONDS={kick:.45,snare:.22,crossStick:.09,tom:.36,floorTom:.5,closedHat:.07,pedalHat:.09,openHat:.75,ride:1.4,bell:1.0,cowbell:.3,crash:2.2,china:1.6};
/** Hitting a key piece cuts the ringing pieces listed for it (a hand grabbing the cymbal, a closing hat). */
export const CHOKES={closedHat:['openHat','halfHat'],pedalHat:['openHat','halfHat'],crashChoke:['crash'],crash2Choke:['crash2'],splashChoke:['splash'],chinaChoke:['china'],rideChoke:['ride','rideEdge','rideBell']};
const ROLL_STEP={1:.5,2:.25,3:.125};// quarter notes per stroke: 8th, 16th, 32nd

export function sample(ctx,id) {
  const {voice,pitch=1,length=1,crack=false}=VOICES[id]||VOICES.snare;
  const seconds=SECONDS[voice]*length,rate=ctx.sampleRate;
  const buffer=ctx.createBuffer(1,Math.ceil(seconds*rate),rate),out=buffer.getChannelData(0);
  let seed=123456789,phase=0,lastNoise=0;
  for(let i=0;i<out.length;i++){
    const t=i/rate;seed=(Math.imul(seed,1664525)+1013904223)>>>0;const noise=seed/2147483648-1,high=noise-lastNoise;lastNoise=noise;
    const ring=Math.exp(-t*5/seconds);
    let v;
    if(voice==='kick'){phase+=2*Math.PI*(48+100*Math.exp(-t*40))/rate;v=Math.sin(phase)*Math.exp(-t*13)+high*Math.exp(-t*150)*.12;}
    else if(voice==='snare'){v=noise*.65*Math.exp(-t*24)+Math.sin(t*2*Math.PI*185*pitch)*.35*Math.exp(-t*35)+(crack?high*.35*Math.exp(-t*90):0);}
    else if(voice==='crossStick'){v=(Math.sin(t*2*Math.PI*1150)*.45+high*.25)*Math.exp(-t*70)+Math.sin(t*2*Math.PI*420)*.2*Math.exp(-t*45);}
    else if(voice==='tom'||voice==='floorTom'){const f=(voice==='tom'?160:95)*pitch;phase+=2*Math.PI*(f+35*Math.exp(-t*25))/rate;v=Math.sin(phase)*Math.exp(-t*10)+noise*.08*Math.exp(-t*30);}
    else if(voice==='cowbell'){v=Math.tanh(2.5*(Math.sin(t*2*Math.PI*545)+Math.sin(t*2*Math.PI*815)))*.32*Math.exp(-t*14);}
    else if(voice==='china'){v=(high*.42+noise*.12+Math.sin(t*2*Math.PI*1730*pitch)*Math.sin(t*2*Math.PI*2490*pitch)*.22)*ring;}
    else {const bell=voice==='bell';v=(high*.28+Math.sin(t*2*Math.PI*4013*pitch)*Math.sin(t*2*Math.PI*2931*pitch)*(bell?.5:.16))*ring;}
    out[i]=v*Math.min(1,i/Math.max(1,rate*.001));
  }
  return buffer;
}

/**
 * Playback events for a score: one per hit, plus the repeated strokes of a
 * roll. A roll lasts until the next onset of the same piece or the end of its
 * written cell (a merged half or whole note counts as its cell), whichever
 * comes first, so audio matches the tremolo the chart shows.
 */
export function scoreEvents(score){
  const timeline=score.timeline,positions=starts(timeline),layout=score.layout??'combined',hits=[];
  for(const bar of score.bars){
    const index=timeline.measures.findIndex(m=>m.id===bar.measureId),measure=timeline.measures[index];
    if(!measure)continue;
    let written=null;
    for(const hit of bar.hits){
      if(!kitPiece(hit.instrument))continue;
      const offset=number(hit.offset),q=positions[index]+offset;let end=q;
      if(ROLL_STEP[hit.roll]){
        const voice=layout==='split'?hit.voice:1,spans=(bar.tuplets??[]).filter(s=>!s.voice||s.voice===voice);
        const cell=rhythmCells(measure,spans).find(c=>offset>=number(c.start)-1e-9&&offset<number(c.start)+number(c.length)-1e-9);
        end=cell?number(cell.start)+number(cell.length):number(measure.length);
        try{written??=engraveBar(bar,measure,layout);const beat=written.voices.find(v=>v.voice===voice)?.beats.find(b=>b.hits.some(h=>h.id===hit.id));if(beat)end=Math.max(end,number(beat.start)+number(beat.duration));}catch{}
        end+=positions[index];
      }
      hits.push({hit,q,end});
    }
  }
  const next=new Map(),events=[];
  for(const entry of [...hits].sort((a,b)=>b.q-a.q)){
    const {hit,q}=entry,end=Math.min(entry.end,next.get(hit.instrument)??Infinity);next.set(hit.instrument,q);
    events.push({...hit,time:toTime(timeline,q)});
    const step=ROLL_STEP[hit.roll];
    if(step)for(let k=1;q+k*step<end-1e-9;k++)events.push({...hit,id:`${hit.id}:roll${k}`,accent:false,heavy:false,flam:false,drag:false,roll:0,stroke:k,time:toTime(timeline,q+k*step)});
  }
  return events.sort((a,b)=>a.time-b.time);
}

/** Chart playback levels (`practice.chartAudio`, D27): the drum-hit output gain for Quiet and Loud. */
export const LEVELS = Object.freeze({quiet: .35, loud: .65});

/**
 * One drum-part player per song session (D27). Hits are scheduled ahead on the
 * engine's own output timeline and sound through `engine.aux` (§5.0), the
 * post-master bus that `stopAt` and `pause` silence with the stems.
 *
 * - A discontinuity (`subscribeTransport` / the `'transport'` event: seek,
 *   play, stop, loop jump) cancels every scheduled hit.
 * - A plan change (`'plan' {from}`: a scheduled rate, a quantized jump,
 *   `cancelPending`, a loop edit that keeps the position, later passes and
 *   gaps) cancels only the hits at or after `from` and reschedules from there,
 *   so the audio before the cut is untouched and the new plan's hits in the
 *   lookahead window are not skipped.
 * - `mode`: 'recording' (no hits; the recorded drums sound), 'notation' (hits
 *   only; the recorded drums are muted) or 'both'.
 */
export class DrumAudio {
  constructor(engine){
    this.engine=engine;this.ctx=engine.ctx;this.out=this.ctx.createGain();this.out.gain.value=LEVELS.loud;
    this.out.connect(engine.aux??this.ctx.destination);
    this.buffers=new Map();this.active=new Set();this.events=[];this.mode='recording';this.until=0;this.revision=engine.revision;
    this.timer=setInterval(()=>this.tick(),25);
    this.unsubscribe=engine.subscribeTransport(()=>{this.cancel();this.revision=engine.revision;this.until=this.ctx.currentTime;});
    this.offPlan=engine.on?.('plan',({from})=>this.replan(from))??(()=>{});
  }
  /** The part's score (null: no hits). */
  setScore(score){this.events=score?scoreEvents(score):[];this.cancel();this.until=this.ctx.currentTime;}
  setMode(mode){this.mode=mode;this.engine.setRecordingAudible(mode!=='notation');this.cancel();this.until=this.ctx.currentTime;}
  /** Output gain of the drum hits (0..1). */
  setLevel(gain){const value=Math.max(0,Math.min(1,Number.isFinite(gain)?gain:LEVELS.loud));this.out.gain.value=value;}
  get level(){return this.out.gain.value;}
  /** Stop hits scheduled at or after `from` (every hit by default). */
  cancel(from=-Infinity){
    const now=this.ctx.currentTime;
    for(const entry of this.active){
      if(entry.when<from)continue;
      try{entry.gain.gain.cancelScheduledValues(now);entry.gain.gain.setTargetAtTime(0,now,.005);entry.source.stop(now+.025);}catch{}
      this.active.delete(entry);
    }
  }
  /** The engine replaced its plan from `from`: drop the hits there and reschedule them on the new plan. */
  replan(from){
    if(!Number.isFinite(from))return;
    this.cancel(from);
    this.until=Math.min(this.until,from);
  }
  /** Fade out ringing pieces that `instrument` chokes, from `when` on. Sounds scheduled later keep ringing. */
  choke(instrument,when){
    const targets=CHOKES[instrument];if(!targets)return;
    const hat=instrument==='closedHat'||instrument==='pedalHat';
    for(const e of this.active)if(targets.includes(e.instrument)&&e.when<=when){try{e.gain.gain.setTargetAtTime(0,when,hat?.01:.02);e.source.stop(when+(hat?.06:.12));}catch{}}
  }
  play(hit,when=this.ctx.currentTime,preview=false){
    if(!KIT.some(k=>k.id===hit.instrument))return;
    if(preview&&this.ctx.state==='suspended')void this.ctx.resume();
    if(!this.buffers.has(hit.instrument))this.buffers.set(hit.instrument,sample(this.ctx,hit.instrument));
    this.choke(hit.instrument,when);
    const source=this.ctx.createBufferSource(),gain=this.ctx.createGain();source.buffer=this.buffers.get(hit.instrument);
    gain.gain.setValueAtTime((hit.velocity??.75)*(hit.ghost?.4:1)*(hit.heavy?1.4:hit.accent?1.25:1),when);
    source.connect(gain).connect(this.out);const entry={source,gain,instrument:hit.instrument,when};this.active.add(entry);
    source.onended=()=>{this.active.delete(entry);source.disconnect();gain.disconnect();};source.start(when);
    // A drag (ruff) is two grace strokes and replaces a flam's single grace.
    const graces=hit.drag?[.06,.03]:hit.flam?[.025]:[];
    for(const offset of graces)this.play({...hit,drag:false,flam:false,roll:0,accent:false,heavy:false,velocity:(hit.velocity??.75)*(hit.drag?.4:.45)},Math.max(this.ctx.currentTime,when-offset),preview);
  }
  tick(){const now=this.ctx.currentTime;
    if(this.engine.revision!==this.revision){this.cancel();this.revision=this.engine.revision;this.until=now;}
    if(this.mode==='recording'||!this.engine.playing){this.until=now;return;}
    const start=Math.max(now,this.until),end=now+.12;
    // The engine includes audible pre-roll as a segment; silent count-in has no
    // segment until the target. Thus exactly one clock determines all onsets.
    for(const hit of this.engine.beatsBetween(start,end,this.events))this.play(hit,hit.when);
    this.until=end;
  }
  /** Ends the player (session dispose). A live engine gets its recorded drums back. */
  destroy(){clearInterval(this.timer);this.unsubscribe();this.offPlan();this.cancel();this.out.disconnect();if(!this.engine.destroyed)this.engine.setRecordingAudible(true);}
}
