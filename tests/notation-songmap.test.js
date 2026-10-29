// @vitest-environment happy-dom
import {beforeEach,afterEach,expect,test,vi} from 'vitest';
// alphaTab cannot lay out in happy-dom; the editor only needs a view that accepts scores.
vi.mock('../src/js/notation/score-view.js',()=>({createScoreView:(host,options={})=>{
  host.replaceChildren(document.createElement('div'));let score=null;
  const view={stage:host.firstChild,ready:true,get score(){return score;},setScore(next){score=next;options.onRender?.(view);},
    setOptions(){},setScale(){},setBarsPerRow(){},setBarMarks(){},setCaret(){},setSelection(){},setPlayhead(){},setLoop(){},setRange(){},noteBoxes:()=>[],barBounds:()=>null,barAt:()=>0,rendered:()=>true,destroy(){}};
  return view;}}));
vi.mock('../src/js/notation/store.js',()=>({NotationStore:vi.fn(),loadSharedNotation:vi.fn(),watchSharedNotation:()=>()=>{}}));
vi.mock('../src/js/notation/audio.js',()=>({DrumAudio:class{mode='recording';out={gain:{value:.65}};play(){}setScore(){}setMode(){}destroy(){}}}));
import {createNotationWorkspace} from '../src/js/notation/editor.js';
import {openPart} from '../src/js/notation/part.js';
import {SongMapStore} from '../src/js/song-map.js';
import {createRegistry} from '../src/app/commands.js';
import {startDispatcher} from '../src/app/dispatch.js';
import {defineChartCommands} from '../src/edit/chart/commands.js';
import {defaultSongMap,editBars,setMeter,pin} from '../shared/song-map.ts';
import {emptyScore,fraction} from '../shared/notation.ts';

// Keys go through the dispatcher to the Edit · Chart commands (the score's focus scope, D18).
let workspace,part,host,engine,persistence,songMap,registry,stopDispatch,offChart;
const song={id:'song',title:'Song'},metronome={beats:[],sectionAt:()=>({bpm:120,beatsPerBar:4,unit:4})};
const prefs={data:{},get(path){return this.data[path];},set(path,value){this.data[path]=value;}};
beforeEach(()=>{prefs.data={};document.body.innerHTML='<main><section class="notation-workspace"></section></main>';host=document.querySelector('section');
  engine={duration:16,playing:false,ctx:{currentTime:0},tracks:[],loop:{enabled:false},seek:vi.fn(),getPosition:()=>0};
  persistence={load:vi.fn(async()=>null),set:vi.fn(),destroy:vi.fn(),flush:vi.fn()};songMap=new SongMapStore(defaultSongMap(16,120),16);
  registry=createRegistry();defineChartCommands({registry});stopDispatch=startDispatcher({registry,platform:'win'});
  registry.provide('posture',()=>'edit');registry.provide('edit',()=>({tab:'chart'}));offChart=registry.provide('chart',()=>workspace);});
afterEach(()=>{workspace?.destroy();part?.destroy();stopDispatch();offChart();workspace=null;});
const open=async(score=null,extra={})=>{persistence.load.mockResolvedValue(score);part=await openPart({song,engine,metronome,songMap,persistence});
  workspace=await createNotationWorkspace({host,part,song,engine,songMap,prefs,drumKeys:{get:()=>({}),save(){},reserved:()=>({})},...extra});workspace.setVisible(true);workspace.focus();};
const codeOf=k=>/^[a-z]$/i.test(k)?`Key${k.toUpperCase()}`:/^\d$/.test(k)?`Digit${k}`:k;
const key=(k,extra={})=>host.querySelector('[role="grid"]').dispatchEvent(new KeyboardEvent('keydown',{key:k,code:codeOf(k),bubbles:true,cancelable:true,...extra}));
const saved=()=>persistence.set.mock.calls.at(-1)[0];

test('a new drum part uses the song map, and map edits retime it without touching notes',async()=>{
  await open();key('s');
  expect(saved().timeline.measures.map(m=>m.id)).toEqual(songMap.data.measures.map(m=>m.id));
  songMap.edit(d=>pin(d,{n:16,d:1},7),'pin');          // bar 5 lands at 7 s instead of 8 s
  expect(saved().timeline.anchors.some(a=>a.time===7)).toBe(true);
  expect(saved().bars[0].hits).toEqual([expect.objectContaining({instrument:'snare',offset:fraction(0)})]);
});

test('undo after a map edit restores the notes on the new timing',async()=>{
  await open();key('s');
  songMap.edit(d=>pin(d,{n:16,d:1},7),'pin');
  workspace.focus();key('z',{ctrlKey:true});
  expect(saved().bars.flatMap(b=>b.hits)).toHaveLength(0);
  expect(saved().timeline.anchors.some(a=>a.time===7)).toBe(true);
});

test('the song map refuses meter changes that would strand written notes',async()=>{
  await open();
  key('5');key('ArrowRight');key('ArrowRight');key('ArrowRight');key('k'); // a kick on beat 4 of bar 1
  expect(()=>songMap.edit(d=>editBars(d,0,0,m=>setMeter(m,3,4)),'meter')).toThrow(/Bar 1 has drum notes/);
  expect(saved().timeline.measures[0].numerator).toBe(4);
  expect(()=>songMap.edit(d=>editBars(d,1,1,m=>setMeter(m,3,4)),'meter')).not.toThrow();
  expect(saved().timeline.measures[1].numerator).toBe(3);
});

test('a saved part on its own timing adopts the song map and keeps its notes',async()=>{
  const score=emptyScore(16);
  score.bars=[{measureId:score.timeline.measures[0].id,coverage:'progress',hits:[{id:'kick',instrument:'kick',offset:fraction(0),voice:2,accent:false,ghost:false,flam:false,sticking:'',velocity:.8}]}];
  await open(score);
  expect(part.score.timeline).toEqual(songMap.timeline());
  expect(part.score.bars[0]).toMatchObject({measureId:songMap.data.measures[0].id,hits:[expect.objectContaining({id:'kick'})]});
});

test('an imported draft takes the song map timing',async()=>{
  await open();
  const draft=emptyScore(16,90);
  draft.bars=[{measureId:draft.timeline.measures[1].id,coverage:'progress',hits:[{id:'snare',instrument:'snare',offset:fraction(1),voice:1,accent:false,ghost:false,flam:false,sticking:'',velocity:.8}]}];
  part.importScore(draft);
  expect(saved().timeline).toEqual(songMap.timeline());
  expect(saved().bars).toEqual([expect.objectContaining({measureId:songMap.data.measures[1].id})]);
});

test('bar meter & label and align in tempo map switch to Edit · Map at that bar instead of a seconds dialog',async()=>{
  const openMap=vi.fn();
  await open(null,{openMap});
  key('5');key('ArrowRight');key('ArrowRight');key('ArrowRight');key('ArrowRight');   // bar 2
  registry.run('chart.align');
  expect(openMap).toHaveBeenCalledWith(expect.objectContaining({n:4}),{bar:1});
  registry.run('chart.barMeter');
  expect(openMap).toHaveBeenLastCalledWith(expect.objectContaining({n:4}),{edit:true,bar:1});
  expect(document.querySelector('dialog')).toBeNull();
});

test('map subscription echoes with reordered object fields never write notation',async()=>{
  await open();key('s');
  const before=persistence.set.mock.calls.length;
  const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reorder(value[key])])):value;
  const timeline=reorder(songMap.timeline());
  vi.spyOn(songMap,'timeline').mockReturnValue(timeline);
  for(let i=0;i<5;i++)songMap._emit('load');
  expect(persistence.set).toHaveBeenCalledTimes(before);
  part.destroy();songMap._emit('edit');expect(persistence.set).toHaveBeenCalledTimes(before);
});
