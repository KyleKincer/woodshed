import {createNotationWorkspace} from '../src/js/notation/editor.js';
import {MultitrackEngine} from '../src/js/engine.js';
import {Metronome} from '../src/js/metronome.js';
import {emptyScore,ScoreEditor,fraction,durationOf,KIT} from '../shared/notation.ts';
import {computePeaksRange,drawWaveform} from '../src/js/waveform.js';
import {initializeInteractions} from '../src/js/interactions.js';
initializeInteractions();
crypto.randomUUID??=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
const engine=new MultitrackEngine(),sampleRate=22050,seconds=32,pcm=new Float32Array(sampleRate*seconds);
for(let beat=0;beat<64;beat++)for(let i=0;i<sampleRate*.2;i++){const t=i/sampleRate;pcm[Math.round(beat*.5*sampleRate)+i]+=(Math.sin(t*2*Math.PI*(beat%2?180:70))*.6)*Math.exp(-t*28);}
// HTTP previews do not expose AudioWorklet. Exercise the actual native engine
// and notation sampler here; pitch-stretch DSP has separate audio tests.
const buffer=engine.ctx.createBuffer(1,pcm.length,sampleRate);buffer.copyToChannel(pcm,0);
const gain=engine.ctx.createGain();gain.connect(engine.master);
engine.duration=seconds;engine.loop.b=seconds;engine.preservePitch=false;
engine.tracks=[{name:'drums',buffer,gain,volume:1,muted:false,soloed:false,nativeSources:new Set()}];
engine.pitchGate=engine.ctx.createGain();engine.stretch={schedule(){},stop(){}};
const model=new ScoreEditor(emptyScore(seconds));model.score.timeline.measures[0].label='Verse';model.score.timeline.measures[8].label='Chorus';
for(let bar=0;bar<12;bar++)for(let step=0;step<8;step++)for(const instrument of ['closedHat',...(step%4===0?['kick']:step%4===2?['snare']:[])])model.insert(bar,{id:crypto.randomUUID(),instrument,offset:fraction(step,2),duration:durationOf(8),voice:KIT.find(k=>k.id===instrument).voice,value:8,dotted:false,tuplet:1,accent:step===0,ghost:false,flam:false,sticking:'',velocity:.75});
model.score.bars[0].coverage='reviewed';const metro=new Metronome(engine);let windowView={start:0,end:8};const waveform=document.querySelector('#wave');
const draw=()=>drawWaveform(waveform,computePeaksRange(engine.tracks[0].buffer,windowView.start,windowView.end,waveform.clientWidth),getComputedStyle(document.documentElement).getPropertyValue('--drums').trim());
const play=async({pause=false}={})=>{if(engine.playing){pause?engine.pause():engine.stop();}else await engine.play();document.querySelector('#play').textContent=engine.playing?'■':'▶';};
const persistence={load:async()=>new URLSearchParams(location.search).has('empty')?null:model.score,set:()=>{},flush:async()=>{},destroy(){}};
const editor=await createNotationWorkspace({host:document.querySelector('#editor'),song:{id:'fixture',title:'Glasshouse',artist:'Northbound'},engine,metronome:metro,getView:()=>windowView,setView:(start,end)=>{windowView={start:Math.max(0,start),end:Math.min(seconds,end)};draw();},setFollow:()=>{},play,persistence});
document.querySelector('#play').onclick=()=>play();document.querySelector('#speed').oninput=e=>{engine.setSpeed(Number(e.target.value));document.querySelector('#rate').textContent=engine.rate.toFixed(2)+'×';};
document.querySelector('#theme').onclick=()=>{const dark=document.documentElement.dataset.theme!=='dark';document.documentElement.dataset.theme=dark?'dark':'light';document.querySelector('#theme').textContent=dark?'Light mode':'Dark mode';window.dispatchEvent(new Event('woodshed:theme'));draw();};
draw();const frame=()=>{engine.tickEnd();const pos=engine.getPosition();editor.tick(pos);document.querySelector('#position').textContent=`${pos.toFixed(2)} / 32.00`;requestAnimationFrame(frame);};frame();
