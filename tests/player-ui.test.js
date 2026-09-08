// @vitest-environment happy-dom
import {beforeEach, afterEach, expect, test, vi} from 'vitest';
import {readFileSync} from 'node:fs';
const state = vi.hoisted(() => ({engines:[],load:null}));
vi.mock('../src/js/backend.js', () => ({onSong:()=>()=>{},signKeys:vi.fn(async()=>({d:'test.wav'})),savePractice:vi.fn(async()=>{}),saveTempo:vi.fn(async()=>{})}));
vi.mock('../src/js/waveform.js', () => ({computePeaksRange:()=>[],drawWaveform:()=>{}}));
vi.mock('../src/js/engine.js', () => ({MultitrackEngine:class {
  rate=1; preservePitch=true; duration=10; playing=false; loop={enabled:false,a:0,b:10};
  tracks=[{name:'drums',color:'#aaa',volume:1,muted:false,soloed:false}];
  ctx={createGain:()=>({gain:{},connect(){},disconnect(){}})};
  constructor(){state.engines.push(this);}
  async loadStems(){await state.load;return {duration:10,tracks:this.tracks};}
  getPosition=()=>0; tickEnd=()=>{}; destroy=vi.fn();
  setSpeed(value){this.rate=value;} setPreservePitch(value){this.preservePitch=value;}
  setLoop(enabled,a,b){this.loop={enabled,a,b};}
  setVolume(){} toggleMute(){} toggleSolo(){}
}}));
import {openPlayer,closePlayer} from '../src/js/player.js';
const song={id:'s',title:'Song',duration:10,stems:[{name:'drums',key:'d'}],practice:{rate:0.75}};
beforeEach(()=>{
  document.body.innerHTML='<div id="header-song"></div><div id="player-root"></div>';
  song.practice={rate:0.75};
  localStorage.clear();state.engines=[];state.load=Promise.resolve();
  globalThis.ResizeObserver=class {observe(){}disconnect(){}};
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
