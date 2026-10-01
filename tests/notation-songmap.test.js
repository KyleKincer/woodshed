// @vitest-environment happy-dom
import {beforeEach,afterEach,expect,test,vi} from 'vitest';
vi.mock('../src/js/notation/store.js',()=>({NotationStore:vi.fn(),loadSharedNotation:vi.fn(),watchSharedNotation:()=>()=>{}}));
vi.mock('../src/js/notation/audio.js',()=>({DrumAudio:class{mode='recording';out={gain:{value:.65}};play(){}setScore(){}setMode(){}destroy(){}}}));
vi.mock('../src/js/notation/render.js',async()=>{
  const {starts,number,toTime,KIT}=await import('../shared/notation.ts');
  const draw=(host,{score,indices,width,timeRange,selected,cursor})=>{
    const positions=starts(score.timeline),qx=q=>q*50;
    host.innerHTML='<svg width="800" height="364"></svg>';
    return {height:364,qx,quarterAt:(_,x)=>x/50,bars:indices.map(index=>({index,left:positions[index]*50,right:(positions[index]+number(score.timeline.measures[index].length))*50})),targets:score.bars.flatMap(b=>{const index=score.timeline.measures.findIndex(m=>m.id===b.measureId);return b.hits.map(hit=>({hit,index,x:(positions[index]+number(hit.offset))*50,right:(positions[index]+number(hit.offset)+number(hit.duration))*50-2,y:26+KIT.findIndex(k=>k.id===hit.instrument)*30}));})};
  };
  return {renderStaff:draw,renderLanes:draw,describe:h=>`${h.instrument} 1/${h.value}`,xml:s=>String(s)};
});
import {createNotationWorkspace} from '../src/js/notation/editor.js';
import {SongMapStore} from '../src/js/song-map.js';
import {defaultSongMap,editBars,setMeter,pin} from '../shared/song-map.ts';
let workspace,host,engine,persistence,songMap;
beforeEach(()=>{document.body.innerHTML='<main class="player"><section class="notation-workspace"></section></main>';host=document.querySelector('section');engine={duration:16,playing:false,ctx:{currentTime:0},tracks:[],seek:vi.fn(),getPosition:()=>0};persistence={load:vi.fn(async()=>null),set:vi.fn(),destroy:vi.fn()};songMap=new SongMapStore(defaultSongMap(16,120),16);});
afterEach(()=>workspace?.destroy());
const open=async(score=null,extra={})=>{persistence.load.mockResolvedValue(score);workspace=await createNotationWorkspace({host,song:{id:'song',title:'Song'},engine,persistence,metronome:{beats:[]},songMap,getView:()=>({start:0,end:8}),setView:vi.fn(),setFollow:vi.fn(),play:vi.fn(),...extra});};
const key=(k,extra={})=>host.querySelector('[role="grid"]').dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true,...extra}));
const saved=()=>persistence.set.mock.calls.at(-1)[0];

test('a new drum part uses the song map, and map edits retime it without touching notes',async()=>{
  await open();
  key('s');
  expect(saved().timeline.measures.map(m=>m.id)).toEqual(songMap.data.measures.map(m=>m.id));
  songMap.edit(d=>pin(d,{n:16,d:1},7));          // bar 5 lands at 7 s instead of 8 s
  expect(saved().timeline.anchors.some(a=>a.time===7)).toBe(true);
  expect(saved().bars[0].hits).toHaveLength(1);
});

test('the song map refuses meter changes that would strand written notes',async()=>{
  await open();
  key('5');key('ArrowRight');key('ArrowRight');key('ArrowRight');key('k'); // a quarter-note kick on beat 4 of bar 1
  expect(()=>songMap.edit(d=>editBars(d,0,0,m=>setMeter(m,3,4)))).toThrow(/Bar 1 has drum notes/);
  expect(()=>songMap.edit(d=>editBars(d,1,1,m=>setMeter(m,3,4)))).not.toThrow();
});

test('bar properties and align beat open the tempo map instead of a seconds dialog',async()=>{
  const openMap=vi.fn();
  await open(null,{openMap});
  host.querySelector('[data-action="align-beat"]').click();
  expect(openMap).toHaveBeenCalledWith(expect.objectContaining({n:0}));
  host.querySelector('[data-action="align"]').click();
  expect(openMap).toHaveBeenLastCalledWith(expect.objectContaining({n:0}),{edit:true});
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test('keys go to the tempo map while it is active',async()=>{
  let active=false;
  await open(null,{mapActive:()=>active});
  active=true;key('s');expect(persistence.set).not.toHaveBeenCalled();
  active=false;key('s');expect(persistence.set).toHaveBeenCalled();
});
