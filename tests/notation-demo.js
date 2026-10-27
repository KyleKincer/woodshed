import {attachNotation} from '../src/js/notation/launcher.js';
import {MultitrackEngine} from '../src/js/engine.js';
import {Metronome} from '../src/js/metronome.js';
import {upgradeScore} from '../shared/notation.ts';
import {demoScore} from './fixtures/drum-score.js';
import {computePeaksRange,drawWaveform} from '../src/js/waveform.js';
import {initializeInteractions} from '../src/js/interactions.js';
initializeInteractions();
crypto.randomUUID??=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
const params=new URLSearchParams(location.search);
if(params.get('theme'))document.documentElement.dataset.theme=params.get('theme');
// ?score=local loads tests/local/score.json (ignored by git) for checks against a real part.
let score=demoScore(64,120);
if(params.get('score')==='local')score=upgradeScore(await (await fetch('./local/vsor-score.json')).json());
const engine=new MultitrackEngine(),sampleRate=22050,seconds=Math.ceil(Math.min(600,score.timeline.measures.length*4*60/Number(params.get('bpm')||(params.get('score')==='local'?130:120)))),pcm=new Float32Array(sampleRate*seconds);
for(let beat=0;beat<seconds*2;beat++)for(let i=0;i<sampleRate*.2&&Math.round(beat*.5*sampleRate)+i<pcm.length;i++){const t=i/sampleRate;pcm[Math.round(beat*.5*sampleRate)+i]+=(Math.sin(t*2*Math.PI*(beat%2?180:70))*.6)*Math.exp(-t*28);}
// HTTP previews do not expose AudioWorklet. Exercise the actual native engine
// and notation sampler here; pitch-stretch DSP has separate audio tests.
const buffer=engine.ctx.createBuffer(1,pcm.length,sampleRate);buffer.copyToChannel(pcm,0);
const gain=engine.ctx.createGain();gain.connect(engine.master);
engine.duration=seconds;engine.loop.b=seconds;engine.preservePitch=false;
engine.tracks=[{name:'drums',buffer,gain,volume:1,muted:false,soloed:false,nativeSources:new Set()}];
engine.pitchGate=engine.ctx.createGain();engine.stretch={schedule(){},stop(){}};
const metro=new Metronome(engine);let windowView={start:0,end:8};const waveform=document.querySelector('#wave');
const draw=()=>drawWaveform(waveform,computePeaksRange(engine.tracks[0].buffer,windowView.start,windowView.end,waveform.clientWidth),getComputedStyle(document.documentElement).getPropertyValue('--drums').trim());
const play=async({pause=false}={})=>{if(engine.playing){pause?engine.pause():engine.stop();}else await engine.play();document.querySelector('#play').textContent=engine.playing?'■':'▶';};
const persistence={status:'fixture',load:async()=>params.has('empty')?null:structuredClone(score),set:()=>{},flush:async()=>{},persist:async()=>{},destroy(){}};
const root=document.querySelector('main');
const notation=attachNotation({root,song:{id:'fixture',title:'Glasshouse',artist:'Northbound'},engine,metronome:metro,getView:()=>windowView,setView:(start,end)=>{windowView={start:Math.max(0,start),end:Math.min(seconds,end)};draw();},setFollow:()=>{},play,persistence,
  setLoop:(a,b)=>engine.setLoop(true,a,b),clearLoop:()=>engine.setLoop(false)});
window.fixture={engine,notation};
document.querySelector('#play').onclick=()=>play();document.querySelector('#speed').oninput=e=>{engine.setSpeed(Number(e.target.value));document.querySelector('#rate').textContent=engine.rate.toFixed(2)+'×';};
document.querySelector('#theme').onclick=()=>{const dark=document.documentElement.dataset.theme!=='dark';document.documentElement.dataset.theme=dark?'dark':'light';document.querySelector('#theme').textContent=dark?'Light mode':'Dark mode';window.dispatchEvent(new Event('woodshed:theme'));draw();};
draw();const frame=()=>{engine.tickEnd();const pos=engine.getPosition();notation.tick(pos);document.querySelector('#position').textContent=`${pos.toFixed(2)} / ${seconds.toFixed(2)}`;requestAnimationFrame(frame);};frame();
if(params.get('seek'))engine.seek(Number(params.get('seek')));
if(params.get('view')==='transcribe')document.querySelector('[data-workspace="transcribe"]').click();
