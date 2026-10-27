// @vitest-environment happy-dom
import {beforeEach,afterEach,expect,test,vi} from 'vitest';
// alphaTab cannot lay out in happy-dom: a fake view records what the chart
// asks it to draw and lets tests point at synthetic bars and beats.
// Bars are four quarters long, four to a line, 100 px per line.
const views=vi.hoisted(()=>[]);
vi.mock('../src/js/notation/score-view.js',()=>({createScoreView:(host,options={})=>{
  const stage=document.createElement('div');host.replaceChildren(stage);
  const calls={setScore:[],setCaret:[],setSelection:[],setPlayhead:[],setLoop:[],setRange:[],setScale:[]};let score=null;
  const view={host,stage,calls,options,ready:true,get score(){return score;},
    setScore(next,opts={}){score=next;calls.setScore.push([next,opts]);options.onRender?.(view);},
    setOptions(){},setBarsPerRow(){},setBarMarks(){},noteBoxes:()=>[],rendered:()=>true,destroy(){view.destroyed=true;},
    barAt:q=>Math.max(0,Math.min(Math.floor(q/4),(score?.timeline.measures.length??1)-1)),
    barBounds:i=>({x:(i%4)*200,y:Math.floor(i/4)*100,w:200,h:100,lineTop:0,lineHeight:80}),
    pointer:(kind,at,event={})=>options.onPointer({kind,at,event:{button:0,pointerId:1,pointerType:'mouse',clientX:10,clientY:10,preventDefault(){},...event}})};
  for(const name of ['setCaret','setSelection','setPlayhead','setLoop','setRange','setScale'])view[name]=value=>calls[name].push(value);
  views.push(view);return view;}}));
vi.mock('../src/js/notation/store.js',()=>({NotationStore:vi.fn(),loadSharedNotation:vi.fn(),watchSharedNotation:()=>()=>{}}));
vi.mock('../src/js/notation/audio.js',()=>({DrumAudio:class{mode='recording';out={gain:{value:.65}};play(){}setScore(){}setMode(){}destroy(){}}}));
import {attachNotation} from '../src/js/notation/launcher.js';
import {demoScore} from './fixtures/drum-score.js';
import {emptyScore} from '../shared/notation.ts';

// 120 bpm in 4/4: every bar is 2 s. Intro is bars 1–4, Verse 5–12, Chorus 13–16.
let launcher,root,engine,persistence,options,position;
const metronome={beats:[],sectionAt:()=>({bpm:120,beatsPerBar:4,unit:4})};
beforeEach(()=>{views.length=0;localStorage.clear();position=0;
  document.body.innerHTML='<div class="song"><div class="player"><nav class="workspace-nav"><button data-workspace="practice" aria-pressed="true">Practice</button><button data-workspace="transcribe" aria-pressed="false">Transcribe</button></nav><div class="tracks"></div><div class="transport"></div></div></div>';
  root=document.querySelector('.song');
  const drums={name:'drums',muted:false};
  engine={duration:32,playing:false,ctx:{currentTime:0},tracks:[drums],loop:{enabled:false},seek:vi.fn(),getPosition:()=>position,toggleMute:vi.fn(name=>{if(name==='drums')drums.muted=!drums.muted;}),setLoop:vi.fn()};
  persistence={load:vi.fn(async()=>null),set:vi.fn(),destroy:vi.fn(),flush:vi.fn()};
  options={root,song:{id:'song',title:'Song'},engine,metronome,persistence,openImport:vi.fn(),onMixerChange:vi.fn(),
    setLoop:vi.fn((a,b)=>{engine.loop={enabled:true,a,b};}),clearLoop:vi.fn(()=>{engine.loop={enabled:false};}),
    getView:()=>({start:0,end:8}),setView:vi.fn(),setFollow:vi.fn(),play:vi.fn()};
});
afterEach(()=>{launcher?.destroy();launcher=null;vi.useRealTimers();vi.restoreAllMocks();});
const player=()=>root.querySelector('.player');
const chartHost=()=>root.querySelector('section.chart');
const view=()=>views.at(-1);
async function open(score=demoScore(32),extra={}){persistence.load.mockResolvedValue(score);launcher=attachNotation({...options,...extra});
  await vi.waitFor(()=>expect(persistence.load).toHaveBeenCalled());}
async function openChart(score,extra){await open(score,extra);await vi.waitFor(()=>expect(player().classList.contains('chart-active')).toBe(true));await vi.waitFor(()=>expect(view()?.calls.setScore.length).toBeGreaterThan(0));}
// The launcher flushes the part only once it has loaded; the view choice follows within a tick.
const settle=async()=>{await vi.waitFor(async()=>{await launcher.flush();expect(persistence.flush).toHaveBeenCalled();});await new Promise(resolve=>setTimeout(resolve,0));};
const click=selector=>root.querySelector(selector).click();
const tap=(at,event={})=>{view().pointer('down',at,event);view().pointer('up',at,event);};

test('a song with drum notation opens straight to the chart',async()=>{
  await openChart();
  expect(chartHost().hidden).toBe(false);
  expect(root.querySelector('[data-practice-view="chart"]').getAttribute('aria-pressed')).toBe('true');
  expect(view().calls.setScore.at(-1)[0].bars.length).toBeGreaterThan(0);
  expect(localStorage.getItem('ws.practice.view')).toBeNull();
});

test('a device that last chose the stems stays on Tracks, and can still switch to the chart',async()=>{
  localStorage.setItem('ws.practice.view','tracks');
  await open();await settle();
  expect(player().classList.contains('chart-active')).toBe(false);expect(views).toHaveLength(0);
  click('[data-workspace="practice"]');await settle();expect(player().classList.contains('chart-active')).toBe(false);
  click('[data-practice-view="chart"]');
  await vi.waitFor(()=>expect(view()?.calls.setScore.length).toBe(1));
  expect(localStorage.getItem('ws.practice.view')).toBe('chart');
});

test('a song without notation stays on Tracks; its empty chart offers import and Transcribe',async()=>{
  await open(null);await settle();
  expect(player().classList.contains('chart-active')).toBe(false);
  click('[data-practice-view="chart"]');
  await vi.waitFor(()=>expect(chartHost().querySelector('.chart-empty').hidden).toBe(false));
  expect(views).toHaveLength(0);
  click('[data-chart="import"]');
  expect(options.openImport).toHaveBeenCalled();expect(player().classList.contains('chart-active')).toBe(false);
  click('[data-practice-view="chart"]');await settle();
  click('[data-chart="transcribe"]');
  await vi.waitFor(()=>expect(player().classList.contains('notation-active')).toBe(true));
  expect(root.querySelector('section.notation-workspace').hidden).toBe(false);
});

test('a shared song without notation explains there is no chart instead of offering edits',async()=>{
  launcher=attachNotation({...options,readOnly:true,shareToken:'token',persistence:null,openImport:null});
  click('[data-practice-view="chart"]');
  await vi.waitFor(()=>expect(chartHost().querySelector('.chart-empty h2')?.textContent).toBe('No drum chart shared'));
  expect(chartHost().querySelector('[data-chart="import"],[data-chart="transcribe"]')).toBeNull();
});

test('tapping a bar plays from the nearest beat, or the bar start when no beat is close',async()=>{
  await openChart();
  tap({index:1,q:5.3,beatQ:5.5});expect(engine.seek).toHaveBeenLastCalledWith(2.75);
  tap({index:2,q:8.2,beatQ:null});expect(engine.seek).toHaveBeenLastCalledWith(4);
  tap({index:3,q:12.1,beatQ:13.5});expect(engine.seek).toHaveBeenLastCalledWith(6);
  expect(options.setLoop).not.toHaveBeenCalled();
});

test('dragging across bars loops them from the first bar to the end of the last',async()=>{
  await openChart();
  view().pointer('down',{index:3,q:13},{clientX:10});
  view().pointer('move',{index:2,q:9},{clientX:40});
  view().pointer('move',{index:1,q:5},{clientX:90});
  expect(view().calls.setRange.at(-1)).toEqual([1,3]);
  view().pointer('up',{index:1,q:5},{clientX:90});
  expect(options.setLoop).toHaveBeenCalledWith(2,8);expect(engine.seek).toHaveBeenLastCalledWith(2);
  expect(view().calls.setRange.at(-1)).toBeNull();
  expect(view().calls.setLoop.at(-1)).toEqual([4,16]);
});

test('on touch, a long press marks the first bar and the next tap loops through the last',async()=>{
  await openChart();vi.useFakeTimers();
  const touch={pointerType:'touch'};
  view().pointer('down',{index:5,q:21},touch);vi.advanceTimersByTime(400);
  expect(view().calls.setRange.at(-1)).toEqual([5,5]);
  view().pointer('up',{index:5,q:21},touch);
  expect(options.setLoop).not.toHaveBeenCalled();expect(engine.seek).not.toHaveBeenCalled();
  tap({index:7,q:29},touch);
  expect(options.setLoop).toHaveBeenCalledWith(10,16);expect(engine.seek).toHaveBeenLastCalledWith(10);
});

test('a touch that scrolls before the long press neither seeks nor loops',async()=>{
  await openChart();vi.useFakeTimers();
  const touch={pointerType:'touch'};
  view().pointer('down',{index:2,q:9},{...touch,clientY:10});
  view().pointer('move',{index:6,q:25},{...touch,clientY:120});vi.advanceTimersByTime(400);
  view().pointer('up',{index:6,q:25},{...touch,clientY:120});
  expect(engine.seek).not.toHaveBeenCalled();expect(options.setLoop).not.toHaveBeenCalled();
  expect(view().calls.setRange).toHaveLength(0);
});

test('section chips are numbered in order and seek to their first bar',async()=>{
  const score=demoScore(48);score.timeline.measures[20].label='Verse';
  await openChart(score);
  expect([...chartHost().querySelectorAll('[data-section]')].map(b=>b.textContent)).toEqual(['Intro','Verse','Chorus','Verse 2']);
  click('[data-section="12"]');expect(engine.seek).toHaveBeenLastCalledWith(24);
  click('[data-section="20"]');expect(engine.seek).toHaveBeenLastCalledWith(40);
});

test('Loop section loops the section that is playing, and a second tap turns it off',async()=>{
  await openChart();
  position=13;launcher.tick(position);                    // bar 7, in the verse
  expect(chartHost().querySelector('[data-section="4"]').getAttribute('aria-current')).toBe('true');
  click('[data-chart="loop-section"]');
  expect(options.setLoop).toHaveBeenCalledWith(8,24);expect(engine.seek).toHaveBeenLastCalledWith(8);
  click('[data-chart="loop-section"]');
  expect(options.clearLoop).toHaveBeenCalledTimes(1);expect(options.setLoop).toHaveBeenCalledTimes(1);
});

test('Mute drums toggles the recorded drum stem and shows its state',async()=>{
  await openChart();
  const mute=()=>chartHost().querySelector('[data-chart="mute-drums"]');
  expect(mute().hidden).toBe(false);
  click('[data-chart="mute-drums"]');
  expect(engine.toggleMute).toHaveBeenCalledWith('drums');expect(options.onMixerChange).toHaveBeenCalled();
  expect(mute().getAttribute('aria-pressed')).toBe('true');expect(mute().textContent).toBe('Drums muted');
  click('[data-chart="mute-drums"]');expect(mute().getAttribute('aria-pressed')).toBe('false');
});

test('Mute drums is hidden when the song has no drum stem',async()=>{
  engine.tracks=[{name:'bass',muted:false}];
  await openChart();
  expect(chartHost().querySelector('[data-chart="mute-drums"]').hidden).toBe(true);
});

test('scrolling the chart by hand while playing stops following; tapping a bar resumes',async()=>{
  await openChart();
  vi.spyOn(performance,'now').mockReturnValue(1e6);
  const follow=()=>chartHost().querySelector('[data-chart="follow"]').getAttribute('aria-pressed');
  const wheel=()=>chartHost().querySelector('.chart-scroll').dispatchEvent(new WheelEvent('wheel',{deltaY:120}));
  wheel();expect(follow()).toBe('true');                  // paused: reading ahead is not a manual override
  engine.playing=true;wheel();expect(follow()).toBe('false');
  tap({index:2,q:8,beatQ:8});expect(follow()).toBe('true');
});

test('an imported part opens the chart with a notice, and the empty part is restored by undo',async()=>{
  await open(null);await settle();
  const draft=demoScore(32);
  await launcher.importScore(draft);
  expect(player().classList.contains('chart-active')).toBe(true);
  expect(chartHost().querySelector('.chart-notice').hidden).toBe(false);
  expect(persistence.set.mock.calls.at(-1)[0].bars.length).toBeGreaterThan(0);
  await expect(launcher.importScore(emptyScore(32))).rejects.toThrow('already has drum notation');
  click('[data-workspace="transcribe"]');
  await vi.waitFor(()=>expect(root.querySelector('section.notation-workspace [data-action="undo"]')).not.toBeNull());
  click('section.notation-workspace [data-action="undo"]');
  expect(persistence.set.mock.calls.at(-1)[0].bars).toHaveLength(0);
});

test('falling back to Tracks never records a view choice for the device',async()=>{
  await open(null);await settle();
  click('[data-workspace="transcribe"]');click('[data-workspace="practice"]');await settle();
  click('[data-practice-view="chart"]');await settle();
  click('[data-chart="import"]');
  expect(localStorage.getItem('ws.practice.view')).toBe('chart');
});

test('Loop section turns off a last section that runs past the end of the recording',async()=>{
  engine.duration=31;
  engine.setLoop=vi.fn();
  options.setLoop=vi.fn((a,b)=>{engine.loop={enabled:true,a,b:Math.min(b,engine.duration)};});
  await openChart();
  position=29;launcher.tick(position);
  click('[data-chart="loop-section"]');
  expect(engine.loop).toMatchObject({enabled:true,b:31});
  click('[data-chart="loop-section"]');
  expect(options.clearLoop).toHaveBeenCalled();expect(engine.loop.enabled).toBe(false);
});

test('Mute drums follows the drum stem when it is muted elsewhere',async()=>{
  await openChart();
  engine.toggleMute('drums');launcher.tick(position);
  expect(root.querySelector('[data-chart="mute-drums"]').getAttribute('aria-pressed')).toBe('true');
});

test('opening the tempo map from the chart shows the stems',async()=>{
  await openChart();
  launcher.leaveChart();
  await vi.waitFor(()=>expect(player().classList.contains('chart-active')).toBe(false));
  expect(localStorage.getItem('ws.practice.view')).toBeNull();
});

test('a mouse drag released outside the score still sets the loop',async()=>{
  await openChart();
  view().stage.setPointerCapture=vi.fn();
  view().pointer('down',{index:1,q:4});
  view().pointer('move',{index:3,q:12},{clientX:300,buttons:1});
  view().pointer('move',{index:6,q:24},{clientX:600,buttons:0});
  expect(options.setLoop).toHaveBeenCalledWith(2,8);
  expect(view().stage.setPointerCapture).toHaveBeenCalled();
});
