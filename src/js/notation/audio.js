import {KIT, starts, number, toTime} from '../../../shared/notation.ts';


/** Deterministic synthesized kit, rendered once into local buffers. No downloads. */
// Each kit piece borrows a synthesized voice; pitch and length vary within a family.
const VOICES={kick:['kick'],pedalHat:['pedalHat'],snare:['snare'],rimshot:['snare',1.15],crossStick:['crossStick'],closedHat:['closedHat'],halfHat:['openHat',.45],openHat:['openHat'],
  rackTom:['rackTom'],tom1:['rackTom',1.2],tom3:['rackTom',.85],tom4:['floorTom',1.2],floorTom:['floorTom'],floorTom2:['floorTom',.82],
  ride:['ride'],rideEdge:['ride',.9],rideChoke:['ride',.18],rideBell:['rideBell'],cowbell:['rideBell',1.4],
  crash:['crash'],crashChoke:['crash',.12],crash2:['crash',1.12],crash2Choke:['crash',.12],splash:['crash',1.6],splashChoke:['crash',.1],china:['china'],chinaChoke:['china',.12]};
function sample(ctx,id) {
  const [instrument,shape=1]=VOICES[id]||['snare'];
  // `shape` is a pitch factor for drums and a length factor for cymbals.
  const cymbal=['openHat','ride','crash','china'].includes(instrument);
  const seconds={kick:.45,snare:.22,crossStick:.09,rackTom:.36,floorTom:.5,closedHat:.07,pedalHat:.09,openHat:.75,ride:1.4,rideBell:1.0,crash:2.2,china:1.6}[instrument]*(cymbal?Math.min(1,shape):1);
  const buffer=ctx.createBuffer(1,Math.ceil(seconds*ctx.sampleRate),ctx.sampleRate),out=buffer.getChannelData(0);
  let seed=123456789,phase=0,lastNoise=0;
  for(let i=0;i<out.length;i++){
    const t=i/ctx.sampleRate;seed=(Math.imul(seed,1664525)+1013904223)>>>0;const noise=seed/2147483648-1,high=noise-lastNoise;lastNoise=noise;
    if(instrument==='kick'){phase+=2*Math.PI*(48+100*Math.exp(-t*40))/ctx.sampleRate;out[i]=Math.sin(phase)*Math.exp(-t*13)+high*Math.exp(-t*150)*.12;}
    else if(instrument==='snare'||instrument==='crossStick'){out[i]=(noise*.65*Math.exp(-t*24)+Math.sin(t*2*Math.PI*185)*.35*Math.exp(-t*35))*(instrument==='crossStick'?.7:1);}
    else if(instrument==='rackTom'||instrument==='floorTom'){const f=(instrument==='rackTom'?160:95)*(cymbal?1:shape);phase+=2*Math.PI*(f+35*Math.exp(-t*25))/ctx.sampleRate;out[i]=Math.sin(phase)*Math.exp(-t*10)+noise*.08*Math.exp(-t*30);}
    else if(instrument==='china'){out[i]=(high*.42+noise*.12+Math.sin(t*2*Math.PI*1730)*Math.sin(t*2*Math.PI*2490)*.22)*Math.exp(-t*5/seconds);}
    else {const bell=instrument==='rideBell',f=bell&&!cymbal?shape:1;out[i]=(high*.28+Math.sin(t*2*Math.PI*4013*f)*Math.sin(t*2*Math.PI*2931*f)*(bell?.5:.16))*Math.exp(-t*5/seconds);}
    out[i]*=Math.min(1,i/Math.max(1,ctx.sampleRate*.001));
  }
  return buffer;
}
export class DrumAudio {
  constructor(engine){this.engine=engine;this.ctx=engine.ctx;this.out=this.ctx.createGain();this.out.gain.value=.65;this.out.connect(this.ctx.destination);this.buffers=new Map();this.active=new Set();this.events=[];this.mode='recording';this.until=0;this.revision=engine.revision;this.timer=setInterval(()=>this.tick(),25);this.unsubscribe=engine.subscribeTransport(()=>{this.cancel();this.revision=engine.revision;this.until=this.ctx.currentTime;});}
  setScore(score){const positions=starts(score.timeline);this.events=score.bars.flatMap(bar=>{const index=score.timeline.measures.findIndex(m=>m.id===bar.measureId);return bar.hits.filter(h=>h.instrument!=='rest').map(h=>({...h,time:toTime(score.timeline,positions[index]+number(h.offset))}));}).sort((a,b)=>a.time-b.time);this.cancel();this.until=this.ctx.currentTime;}
  setMode(mode){this.mode=mode;this.engine.setRecordingAudible(mode!=='notation');this.cancel();this.until=this.ctx.currentTime;}
  cancel(){for(const entry of this.active){try{entry.gain.gain.cancelScheduledValues(this.ctx.currentTime);entry.gain.gain.setTargetAtTime(0,this.ctx.currentTime,.005);entry.source.stop(this.ctx.currentTime+.025);}catch{}}this.active.clear();}
  play(hit,when=this.ctx.currentTime,preview=false){
    if(!KIT.some(k=>k.id===hit.instrument))return;
    if(preview&&this.ctx.state==='suspended')void this.ctx.resume();
    if(!this.buffers.has(hit.instrument))this.buffers.set(hit.instrument,sample(this.ctx,hit.instrument));
    if(['closedHat','pedalHat'].includes(hit.instrument))for(const e of this.active)if((e.instrument==='openHat'||e.instrument==='halfHat')&&e.when<=when){e.gain.gain.setTargetAtTime(0,when,.01);e.source.stop(when+.06);}
    const source=this.ctx.createBufferSource(),gain=this.ctx.createGain();source.buffer=this.buffers.get(hit.instrument);
    gain.gain.setValueAtTime((hit.velocity??.75)*(hit.ghost?.4:1)*(hit.heavy?1.4:hit.accent?1.25:1),when);
    source.connect(gain).connect(this.out);const entry={source,gain,instrument:hit.instrument,when};this.active.add(entry);
    source.onended=()=>{this.active.delete(entry);source.disconnect();gain.disconnect();};source.start(when);
    if(hit.flam)this.play({...hit,flam:false,roll:0,velocity:(hit.velocity??.75)*.45},Math.max(this.ctx.currentTime,when-.025),preview);
    if(hit.drag)for(const offset of [.06,.03])this.play({...hit,drag:false,flam:false,roll:0,velocity:(hit.velocity??.75)*.4},Math.max(this.ctx.currentTime,when-offset),preview);
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
  destroy(){clearInterval(this.timer);this.unsubscribe();this.cancel();this.out.disconnect();this.engine.setRecordingAudible(true);}
}
