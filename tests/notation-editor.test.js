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
import {emptyScore,fraction,durationOf} from '../shared/notation.ts';
let workspace,host,engine,persistence;
beforeEach(()=>{document.body.innerHTML='<main class="player"><section class="notation-workspace"></section></main>';host=document.querySelector('section');engine={duration:8,playing:false,ctx:{currentTime:0},tracks:[],seek:vi.fn(),getPosition:()=>0};persistence={load:vi.fn(async()=>null),set:vi.fn(),destroy:vi.fn()};});
afterEach(()=>workspace?.destroy());
async function open(score=null){persistence.load.mockResolvedValue(score);workspace=await createNotationWorkspace({host,song:{id:'song',title:'Song'},engine,persistence,metronome:{beats:Array.from({length:16},(_,i)=>({time:.05802540606553842+i*.5,downbeat:i%4===0})),sectionAt:()=>({bpm:120,beatsPerBar:4,unit:4}),setNotationTiming:vi.fn()},getView:()=>({start:0,end:8}),setView:vi.fn(),setFollow:vi.fn(),play:vi.fn()});}
const key=(k,extra={})=>host.querySelector('[role="grid"]').dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true,...extra}));
const clickAction=name=>host.querySelector(`[data-action="${name}"]`).click();
const pointer=(x,y,move)=>{const row=host.querySelector('.notation-row');row.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:1,clientX:x,clientY:y}));if(move)row.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,clientX:move[0],clientY:move[1]}));row.dispatchEvent(new PointerEvent('pointerup',{pointerId:1,clientX:move?.[0]??x,clientY:move?.[1]??y}));};
const saved=()=>persistence.set.mock.calls.at(-1)[0];
test('opens directly with exact timing; new note duration and expressions edit immediately',async()=>{
  await open();expect(document.querySelector('[role="dialog"]')).toBeNull();expect(host.querySelector('[data-mode]')).toBeNull();expect(persistence.set).not.toHaveBeenCalled();
  key('s');key('5');key('g');expect(saved().bars[0].hits[0]).toMatchObject({instrument:'snare',value:4,duration:fraction(1),ghost:true});expect(saved().timeline.anchors[0].time).toBe(.05802540606553842);
  key('ArrowRight');key('4');key('s');expect(saved().bars[0].hits).toHaveLength(2);expect(saved().bars[0].hits[0].value).toBe(4);expect(saved().bars[0].hits[1].value).toBe(8);
});
test('single click positions playback even while playing; double click adds without a mode',async()=>{
  await open();engine.playing=true;pointer(100,100);expect(engine.seek).toHaveBeenCalled();expect(persistence.set).not.toHaveBeenCalled();
  pointer(100,100);expect(saved().bars[0].hits).toHaveLength(1);
  pointer(200,10);expect(engine.seek).toHaveBeenLastCalledWith(expect.any(Number));
});
test('lane selection, move, resize and marquee are direct gestures with atomic undo',async()=>{
  await open();host.querySelector('[data-view="lanes"]').click();key('s');key('5');
  pointer(8,206,[58,236]);expect(saved().bars[0].hits[0]).toMatchObject({instrument:'crossStick',offset:fraction(1)});
  pointer(96,236,[123,236]);expect(saved().bars[0].hits[0]).toMatchObject({value:4,dotted:true,duration:fraction(3,2)});
  clickAction('undo');expect(saved().bars[0].hits[0].duration).toEqual(fraction(1));
  pointer(40,215,[115,250]);key('Delete');expect(saved().bars[0].hits).toHaveLength(0);
  clickAction('undo');expect(saved().bars[0].hits).toHaveLength(1);
});
test('workspace routing claims drum keys after waveform focus and preserves text editing',async()=>{
  await open();const event=new KeyboardEvent('keydown',{key:'s',bubbles:true,cancelable:true});document.body.dispatchEvent(event);workspace.handleKey(event);expect(event.defaultPrevented).toBe(true);expect(saved().bars[0].hits[0].instrument).toBe('snare');
  const before=persistence.set.mock.calls.length;const input=document.createElement('input');host.append(input);const textKey=new KeyboardEvent('keydown',{key:'s',cancelable:true});input.dispatchEvent(textKey);workspace.handleKey(textKey);expect(textKey.defaultPrevented).toBe(false);expect(persistence.set).toHaveBeenCalledTimes(before);
  const snap=new KeyboardEvent('keydown',{key:'S',shiftKey:true,cancelable:true});workspace.handleKey(snap);expect(snap.defaultPrevented).toBe(false);expect(persistence.set).toHaveBeenCalledTimes(before);
});
