// @vitest-environment happy-dom
import {beforeEach, afterEach, expect, test, vi} from 'vitest';
import {readFileSync} from 'node:fs';
const state = vi.hoisted(() => ({engines:[],load:null}));
vi.mock('../src/js/backend.js', () => ({onSong:vi.fn(()=>()=>{}),signKeys:vi.fn(async()=>({d:'test.wav'})),savePractice:vi.fn(async()=>{}),saveTempo:vi.fn(async()=>{})}));
vi.mock('../src/js/waveform.js', () => ({computePeaksRange:()=>[],drawWaveform:()=>{}}));
vi.mock('../src/js/engine.js', () => ({MultitrackEngine:class {
  rate=1; preservePitch=true; duration=10; playing=false; loop={enabled:false,a:0,b:10};
  tracks=[{name:'drums',color:'#aaa',volume:1,muted:false,soloed:false}];
  ctx={createGain:()=>({gain:{},connect(){},disconnect(){}})};
  constructor(){state.engines.push(this);}
  async loadStems(){await state.load;return {duration:10,tracks:this.tracks};}
  editPosition=0; paused=false;
  getPosition=()=>0; tickEnd=()=>{}; destroy=vi.fn();
  play=vi.fn(async()=>{this.playing=true;this.paused=false;}); pause=vi.fn(()=>{this.playing=false;this.paused=true;});
  stop=vi.fn(()=>{this.playing=false;this.paused=false;});
  setSpeed(value){this.rate=value;} setPreservePitch(value){this.preservePitch=value;}
  setLoop(enabled,a,b){this.loop={enabled,a,b};}
  setVolume(){} toggleMute(){} toggleSolo(){}
}}));
import {openPlayer,closePlayer} from '../src/js/player.js';
import {initializeInteractions} from '../src/js/interactions.js';
initializeInteractions();
const song={id:'s',title:'Song',duration:10,stems:[{name:'drums',key:'d'}],practice:{rate:0.75}};
beforeEach(()=>{
  document.body.innerHTML='<div id="header-song"></div><div id="player-root"></div>';
  song.practice={rate:0.75};
  localStorage.clear();state.engines=[];state.load=Promise.resolve();
  globalThis.ResizeObserver=class {observe(){}disconnect(){}};
  HTMLCanvasElement.prototype.getContext=()=>new Proxy({}, {get:(target,key)=>target[key]??(()=>{}),set:(target,key,value)=>{target[key]=value;return true;}});
  globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{};
});
afterEach(()=>closePlayer());
test('loading progress is contained inside the track panel and controls become ready together',async()=>{
  let finish;state.load=new Promise(resolve=>{finish=resolve;});
  const ready=openPlayer(song);
  const root=document.getElementById('player-root');
  expect(root.getAttribute('aria-busy')).toBe('true');
  expect(root.querySelector('.tracks > .player-load-progress[role=status]')).not.toBeNull();
  expect(root.querySelectorAll('.track')).toHaveLength(1);
  expect(root.querySelector('#speed').disabled).toBe(true);
  finish();await ready;
  expect(root.hasAttribute('aria-busy')).toBe(false);
  expect(root.querySelector('.player-load-progress')).toBeNull();
  expect(root.querySelectorAll('.track')).toHaveLength(1);
  expect(root.querySelector('#speed').disabled).toBe(false);
  expect(root.querySelector('#bar-position').textContent).toBe('Bar 1 / 5 · Beat 1');
});
test('double-click resets the speed and pitch preference can be toggled and restored',async()=>{
  await openPlayer(song);
  const speed=document.getElementById('speed');
  expect(speed.value).toBe('0.75');
  speed.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
  expect(speed.value).toBe('1');expect(state.engines[0].rate).toBe(1);
  expect(document.getElementById('speed-val').textContent).toBe('1.00×');
  const pitch=document.getElementById('preserve-pitch');
  expect(pitch.getAttribute('aria-pressed')).toBe('true');
  pitch.click();expect(state.engines[0].preservePitch).toBe(false);
  expect(localStorage.getItem('ws.preservePitch')).toBe('0');
  await openPlayer(song);expect(document.getElementById('preserve-pitch').getAttribute('aria-pressed')).toBe('false');
});
test('load failures keep a retry path and dispose audio resources',async()=>{
  state.load=Promise.reject(new Error('offline'));
  await openPlayer(song);
  expect(document.querySelector('[role=alert]').textContent).toContain("Couldn't load audio: offline");
  expect(document.querySelector('[role=alert] button').disabled).toBe(false);
  expect(state.engines[0].destroy).toHaveBeenCalled();
  expect(document.getElementById('player-root').hasAttribute('aria-busy')).toBe(false);
});
test('a load finishing after navigation does not replace the next song',async()=>{
  let finish;state.load=new Promise(resolve=>{finish=resolve;});
  const old=openPlayer(song);await Promise.resolve();
  state.load=Promise.resolve();await openPlayer({...song,title:'Next song'});
  finish();await old;
  expect(document.querySelector('.ptitle').textContent).toBe('Next song');
  expect(state.engines[0].destroy).toHaveBeenCalled();
});
test('busy song containers cannot acquire an in-flow action spinner',()=>{
  const css=readFileSync(process.cwd()+'/src/css/record-club.css','utf8');
  const rules=css.split('}').filter(rule=>rule.includes('[aria-busy=true]::before'));
  expect(rules.length).toBeGreaterThan(0);
  expect(rules.every(rule=>rule.includes('button[aria-busy=true]::before'))).toBe(true);
});

test('pointer-clicked checkboxes and sliders release Space to transport, without key-repeat toggling',async()=>{
  await openPlayer(song);
  for (const id of ['m-accent','speed','preserve-pitch']) {
    const control=document.getElementById(id);
    control.focus();control.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));
    await Promise.resolve();
    const e=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:' ',code:'Space'});
    document.activeElement.dispatchEvent(e);await Promise.resolve();
    expect(e.defaultPrevented).toBe(true);
    const repeat=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:' ',code:'Space',repeat:true});
    document.activeElement.dispatchEvent(repeat);await Promise.resolve();
  }
  expect(state.engines[0].play).toHaveBeenCalledTimes(2);
  expect(state.engines[0].stop).toHaveBeenCalledTimes(1);
});
test('text entry, dialogs, and keyboard-focused checkboxes retain their keyboard behavior',async()=>{
  await openPlayer(song);
  for (const id of ['m-bpm','m-accent']) {
    document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));
    const control=document.getElementById(id);control.focus();
    const e=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:' ',code:'Space'});
    control.dispatchEvent(e);expect(e.defaultPrevented).toBe(false);
  }
  document.body.insertAdjacentHTML('beforeend','<div role="dialog"></div>');
  document.body.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:' ',code:'Space'}));
  expect(state.engines[0].play).not.toHaveBeenCalled();
});
test('count-in controls default to silent, allow custom units, and persist on immediate navigation',async()=>{
  const backend=await import('../src/js/backend.js');
  await openPlayer(song);document.getElementById('metro-btn').click();
  const enabled=document.getElementById('m-countin');
  expect(document.getElementById('m-preroll').checked).toBe(false);
  enabled.checked=true;enabled.dispatchEvent(new Event('change'));
  const length=document.getElementById('m-countin-length'), unit=document.getElementById('m-countin-unit');
  expect(length.disabled).toBe(false);
  length.value='3';length.dispatchEvent(new Event('change'));
  unit.value='beats';unit.dispatchEvent(new Event('change'));
  closePlayer();
  expect(backend.saveTempo).toHaveBeenLastCalledWith('s',expect.objectContaining({countIn:true,countInLength:3,countInUnit:'beats',audiblePreRoll:false}));
});

test('Space stops at the edit cursor by default; Enter pauses and resumes without count-in',async()=>{
  await openPlayer(song);const active=state.engines[0];
  const key=async(key,code=key)=>{document.body.dispatchEvent(new KeyboardEvent('keydown',{key,code,bubbles:true,cancelable:true}));await Promise.resolve();await Promise.resolve();};
  await key(' ','Space');expect(active.play).toHaveBeenCalledTimes(1);
  await key('Enter');expect(active.pause).toHaveBeenCalledTimes(1);
  await key('Enter');expect(active.play).toHaveBeenLastCalledWith(expect.objectContaining({countIn:null}));
  await key(' ','Space');expect(active.stop).toHaveBeenLastCalledWith({returnToEdit:true});
  localStorage.setItem('ws.stopBehavior','stay');
  await key(' ','Space');await key(' ','Space');
  expect(active.stop).toHaveBeenLastCalledWith({returnToEdit:false});
  expect(document.querySelector('.transport-main #pause')).not.toBeNull();
  expect(document.querySelector('#edit-cursor')).not.toBeNull();
});

test('shared playback uses scoped media and cache identities, with no owner mutation or subscription',async()=>{
  const backend=await import('../src/js/backend.js');vi.clearAllMocks();
  const resolveUrls=vi.fn(async()=>({d:'https://storage.test/audio'}));
  await openPlayer(song,{readOnly:true,resolveUrls,cacheNamespace:'share:token:revision:'});
  expect(resolveUrls).toHaveBeenCalledTimes(1);expect(backend.onSong).not.toHaveBeenCalled();
  expect(document.querySelector('.header-edit-song')).toBeNull();expect(document.querySelector('.header-share-song')).toBeNull();
  expect(document.getElementById('m-detect').disabled).toBe(true);
  const countIn=document.getElementById('m-countin');countIn.checked=true;countIn.dispatchEvent(new Event('change'));
  closePlayer();expect(backend.saveTempo).not.toHaveBeenCalled();expect(backend.savePractice).not.toHaveBeenCalled();
});
