// @vitest-environment happy-dom
import {beforeEach,afterEach,expect,test,vi} from 'vitest';
// alphaTab cannot lay out in happy-dom: a fake view records what the editor
// asks it to draw and lets tests point at synthetic bars, beats and notes.
const views=vi.hoisted(()=>[]);
vi.mock('../src/js/notation/score-view.js',()=>({createScoreView:(host,options={})=>{
  const stage=document.createElement('div');host.replaceChildren(stage);
  const calls={setScore:[],setCaret:[],setSelection:[],setPlayhead:[],setLoop:[],setRange:[]};let score=null;
  const view={host,stage,calls,ready:true,get score(){return score;},
    setScore(next,opts={}){score=next;calls.setScore.push([next,opts]);options.onRender?.(view);},
    setOptions(){},setScale(){},setBarsPerRow(){},setBarMarks(){},noteBoxes:()=>[],barBounds:i=>({x:0,y:i*100,w:200,h:100,lineTop:0,lineHeight:80}),barAt:()=>0,rendered:()=>true,destroy(){},
    pointer:(kind,at,event={})=>options.onPointer({kind,at,event:{button:0,pointerId:1,pointerType:'mouse',clientX:10,clientY:10,preventDefault(){},...event}})};
  for(const name of ['setCaret','setSelection','setPlayhead','setLoop','setRange'])view[name]=value=>calls[name].push(value);
  views.push(view);return view;}}));
vi.mock('../src/js/notation/store.js',()=>({NotationStore:vi.fn(),loadSharedNotation:vi.fn(),watchSharedNotation:()=>()=>{}}));
vi.mock('../src/js/notation/audio.js',()=>({DrumAudio:class{mode='recording';out={gain:{value:.65}};play(){}setScore(){}setMode(){}destroy(){}}}));
import {createNotationWorkspace} from '../src/js/notation/editor.js';
import {openPart} from '../src/js/notation/part.js';
import {createRegistry} from '../src/app/commands.js';
import {startDispatcher} from '../src/app/dispatch.js';
import {defineChartCommands} from '../src/edit/chart/commands.js';
import {emptyScore,fraction} from '../shared/notation.ts';

// Keys reach the editor only as registry commands in the score's focus scope (D18, D45): the
// dispatcher runs on an isolated registry with the Edit · Chart commands, and the workspace is the
// 'chart' context. The frame's inspector slots are plain elements.
let workspace,part,host,engine,persistence,registry,stopDispatch,offChart,slots,prefsData;
const metronome={beats:[],sectionAt:()=>({bpm:120,beatsPerBar:4,unit:4})};
const memoryPrefs=()=>({get:path=>path.split('.').reduce((o,k)=>o?.[k],prefsData),set(path,value){const keys=path.split('.');let o=prefsData;for(const k of keys.slice(0,-1))o=o[k]??={};o[keys.at(-1)]=value;}});
beforeEach(()=>{views.length=0;prefsData={edit:{chart:{view:'score',paging:'pages',keys:{}}}};document.body.innerHTML='<main><section class="notation-workspace"></section></main>';host=document.querySelector('section');
  slots={inspector:{kit:document.createElement('div'),properties:document.createElement('div'),listen:document.createElement('div')},status:document.createElement('p')};
  for(const el of [...Object.values(slots.inspector),slots.status])document.body.append(el);
  engine={duration:8,playing:false,ctx:{currentTime:0},tracks:[],loop:{enabled:false},seek:vi.fn(),getPosition:()=>0,setLoop:vi.fn(),toggleMute:vi.fn()};
  persistence={load:vi.fn(async()=>null),set:vi.fn(),destroy:vi.fn(),flush:vi.fn()};
  registry=createRegistry();defineChartCommands({registry});stopDispatch=startDispatcher({registry,platform:'win'});
  registry.provide('posture',()=>'edit');registry.provide('edit',()=>({tab:'chart'}));offChart=registry.provide('chart',()=>workspace);});
afterEach(()=>{workspace?.destroy();part?.destroy();stopDispatch();offChart();workspace=null;});
async function open(score=null,extra={}){persistence.load.mockResolvedValue(score);part=await openPart({song:{id:'song',title:'Song'},engine,metronome,persistence});
  workspace=await createNotationWorkspace({host,slots,part,song:{id:'song',title:'Song'},engine,prefs:memoryPrefs(),drumKeys:{get:()=>prefsData.edit.chart.keys,save:vi.fn(),reserved:()=>({})},...extra});workspace.setVisible(true);workspace.focus();}
const surface=()=>host.querySelector('[role="grid"]');
const CODES={'/':'Slash','.':'Period','=':'Equal','-':'Minus',' ':'Space'};
const codeOf=k=>/^[a-z]$/i.test(k)?`Key${k.toUpperCase()}`:/^\d$/.test(k)?`Digit${k}`:CODES[k]??k;
// A key pressed with the score focused, as the dispatcher sees it (letters and digits on e.code, D56).
const key=(k,extra={})=>{const target=document.activeElement&&document.activeElement!==document.body?document.activeElement:surface();const e=new KeyboardEvent('keydown',{key:k,code:codeOf(k),bubbles:true,cancelable:true,...extra});target.dispatchEvent(e);return e;};
const run=(name,...args)=>workspace.run(name,...args);
const saved=()=>persistence.set.mock.calls.at(-1)[0];
const hits=()=>saved().bars.flatMap(b=>b.hits);
const view=()=>views.at(-1);
// Score gestures: down comes from the view, up from the window.
const tap=(at,{x=10,y=10,shiftKey=false}={})=>{view().pointer('down',at,{clientX:x,clientY:y});window.dispatchEvent(new PointerEvent('pointerup',{clientX:x,clientY:y,shiftKey}));workspace.focus();};
// happy-dom has no layout: give the lanes the 800 px width they are drawn at.
const lane=(x,y,move)=>{const el=host.querySelector('.notation-lanes');Object.defineProperty(el,'clientWidth',{value:800,configurable:true});el.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:1,clientX:x,clientY:y}));if(move)el.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,clientX:move[0],clientY:move[1]}));el.dispatchEvent(new PointerEvent('pointerup',{pointerId:1,clientX:move?.[0]??x,clientY:move?.[1]??y}));workspace.focus();};
// Lane rows at 120 bpm over an 8 s view: 50 px per quarter; core kit rows from the top.
const ROW={snare:208,crossStick:236};

test('drum keys write at the cursor and store only position, never written duration',async()=>{
  await open();expect(document.querySelector('dialog')).toBeNull();expect(persistence.set).not.toHaveBeenCalled();
  key('s');expect(hits()).toHaveLength(1);expect(hits()[0]).toMatchObject({instrument:'snare',offset:fraction(0),voice:1});
  for(const field of ['duration','value','dotted','tuplet'])expect(hits()[0]).not.toHaveProperty(field);
  key('5');key('ArrowRight');key('k');expect(hits()[1]).toMatchObject({instrument:'kick',offset:fraction(1),voice:2});
  key('3');key('ArrowRight');key('h');expect(hits()[2]).toMatchObject({instrument:'closedHat',offset:fraction(5,4)});
  expect(view().calls.setCaret.at(-1).q).toBe(1.25);
});

test('R skips a step without writing, and the same key twice in one place does not duplicate',async()=>{
  await open();key('4');key('r');key('r');expect(persistence.set).not.toHaveBeenCalled();
  key('s');expect(hits()[0].offset).toEqual(fraction(1));
  key('s');expect(hits()).toHaveLength(1);
  key('ArrowRight');key('s');expect(hits().map(h=>h.offset)).toEqual([fraction(1),fraction(3,2)]);
});

test('/ cycles tuplet steps and writes on the tuplet grid',async()=>{
  // The toolbar draws the tuplet from state().
  await open();const tuplet=()=>String(workspace.state().step.tuplet);
  key('4');key('/');expect(tuplet()).toBe('3');
  key('ArrowRight');key('s');expect(hits()[0].offset).toEqual(fraction(1,3));
  key('ArrowRight');key('ArrowRight');key('k');expect(hits()[1].offset).toEqual(fraction(1));
  for(const next of ['5','6','7','1'])key('/'),expect(tuplet()).toBe(next);
});

test('an explicit tuplet refuses notes off its grid',async()=>{
  await open();run('tuplet-dialog');
  const form=document.querySelector('dialog form');form.querySelector('[name="count"]').value='3';
  form.dispatchEvent(new Event('submit',{cancelable:true}));await vi.waitFor(()=>expect(document.querySelector('dialog[open]')).toBeNull());workspace.focus();
  expect(saved().bars[0].tuplets).toEqual([{start:fraction(0),length:fraction(1),count:3}]);
  const count=persistence.set.mock.calls.length;
  key('3');key('ArrowRight');key('s');
  expect(persistence.set).toHaveBeenCalledTimes(count);expect(slots.status.textContent).toMatch(/cannot be written there/);expect(workspace.state().message).toMatch(/cannot be written there/);
});

test('A, G and Shift+A change the selected note, or arm the next one',async()=>{
  await open();key('s');
  key('a');expect(hits()[0].accent).toBe(true);
  key('g');expect(hits()[0].ghost).toBe(true);
  key('A',{shiftKey:true});expect(hits()[0]).toMatchObject({heavy:true,accent:true});
  key('a');expect(hits()[0].accent).toBe(false);
  key('Escape');const count=persistence.set.mock.calls.length;key('g');expect(persistence.set).toHaveBeenCalledTimes(count);
  key('ArrowRight');key('k');expect(hits()[1]).toMatchObject({instrument:'kick',ghost:true,accent:false});
});

test('kit pads write at the cursor unless they are set to audition',async()=>{
  await open();
  slots.inspector.kit.querySelector('[data-kit="rideBell"]').click();expect(hits()[0].instrument).toBe('rideBell');
  const count=persistence.set.mock.calls.length;
  slots.inspector.kit.querySelector('[data-field="audition"]').click();
  expect(slots.inspector.kit.querySelector('[data-field="audition"]').getAttribute('aria-pressed')).toBe('true');
  slots.inspector.kit.querySelector('[data-kit="snare"]').click();expect(persistence.set).toHaveBeenCalledTimes(count);
  workspace.focus();key('s');expect(hits().map(h=>h.instrument)).toEqual(['rideBell','snare']);
});

test('clicking the score places the cursor and seeks; double-click writes the piece on that line',async()=>{
  await open();
  tap({index:0,q:1.1,y:70,lineTop:0,lineHeight:80});
  expect(view().calls.setCaret.at(-1).q).toBe(1);expect(engine.seek).toHaveBeenLastCalledWith(.5);expect(persistence.set).not.toHaveBeenCalled();
  tap({index:0,q:1.1,y:70,lineTop:0,lineHeight:80});
  expect(hits()[0]).toMatchObject({instrument:'kick',offset:fraction(1)});
  engine.playing=true;engine.seek.mockClear();
  tap({index:1,q:6,y:30,lineTop:0,lineHeight:80},{x:300});
  expect(engine.seek).not.toHaveBeenCalled();expect(view().calls.setCaret.at(-1).q).toBe(6);
});

test('clicking a note selects it for editing and deletion',async()=>{
  await open();key('s');key('Escape');
  tap({index:0,q:0,hit:hits()[0],y:30,lineTop:0,lineHeight:80});
  expect([...view().calls.setSelection.at(-1)]).toEqual([hits()[0].id]);
  key('Delete');expect(hits()).toHaveLength(0);
  key('z',{ctrlKey:true});expect(hits()).toHaveLength(1);
});

test('the layout switch is saved with the part and re-engraves it',async()=>{
  await open();key('s');
  slots.inspector.properties.querySelector('[data-layout="split"]').click();
  expect(saved().layout).toBe('split');expect(view().calls.setScore.at(-1)[0].layout).toBe('split');
  slots.inspector.properties.querySelector('[data-layout="combined"]').click();expect(saved()).not.toHaveProperty('layout');
});

test('lane drags move notes in time and across lanes; marquee and delete are undoable',async()=>{
  await open();run('view','lanes');key('s');
  lane(5,ROW.snare,[55,ROW.crossStick]);expect(hits()[0]).toMatchObject({instrument:'crossStick',offset:fraction(1)});
  key('z',{ctrlKey:true});expect(hits()[0]).toMatchObject({instrument:'snare',offset:fraction(0)});
  key('z',{ctrlKey:true,shiftKey:true});
  lane(40,195,[115,250]);key('Delete');expect(hits()).toHaveLength(0);
  run('undo');expect(hits()).toHaveLength(1);
});

test('double-click in a lane writes that piece; double-click on a lane note removes it',async()=>{
  await open();run('view','lanes');
  lane(100,ROW.snare);lane(100,ROW.snare);expect(hits()[0]).toMatchObject({instrument:'snare',offset:fraction(2)});
  lane(103,ROW.snare);lane(103,ROW.snare);expect(hits()).toHaveLength(0);
});

test('drum keys apply only while the score has focus, and text editing keeps its keys (D18)',async()=>{
  await open();surface().blur();
  const outside=new KeyboardEvent('keydown',{key:'s',code:'KeyS',bubbles:true,cancelable:true});document.body.dispatchEvent(outside);
  expect(outside.defaultPrevented).toBe(false);expect(persistence.set).not.toHaveBeenCalled();
  workspace.focus();expect(key('s').defaultPrevented).toBe(true);expect(hits()[0].instrument).toBe('snare');
  const before=persistence.set.mock.calls.length;const input=document.createElement('input');host.append(input);input.focus();
  const textKey=key('s');expect(textKey.defaultPrevented).toBe(false);expect(persistence.set).toHaveBeenCalledTimes(before);
  workspace.focus();const snap=key('S',{shiftKey:true});expect(snap.defaultPrevented).toBe(false);expect(persistence.set).toHaveBeenCalledTimes(before);
});

test('an imported draft is one undoable edit, upgraded to positions only, and never replaces written notes',async()=>{
  await open();
  const draft=emptyScore(8);draft.version=1;
  draft.bars=[{measureId:draft.timeline.measures[0].id,coverage:'progress',hits:[
    {id:'imported-kick',instrument:'kick',offset:fraction(0),duration:fraction(1,2),voice:2,value:8,dotted:false,tuplet:1,velocity:.8,accent:false,ghost:false,flam:false,sticking:''},
    {id:'imported-rest',instrument:'rest',offset:fraction(1,2),duration:fraction(1,2),voice:1,value:8,dotted:false,tuplet:1,velocity:.8,accent:false,ghost:false,flam:false,sticking:''}]}];
  part.importScore(draft);
  expect(saved().version).toBe(2);expect(hits()).toHaveLength(1);expect(hits()[0]).toMatchObject({id:'imported-kick',instrument:'kick'});expect(hits()[0]).not.toHaveProperty('duration');
  expect(view().calls.setScore.at(-1)[0]).toBe(part.score);
  expect(()=>part.importScore(draft)).toThrow(expect.objectContaining({code:'HAS_NOTATION'}));
  key('z',{ctrlKey:true});expect(saved().bars).toHaveLength(0);
});

test('importScore with replace swaps a written part in one undo step',async()=>{
  await open();
  const hit=(id,instrument)=>({id,instrument,offset:fraction(0),duration:fraction(1,4),voice:1,value:4,dotted:false,tuplet:1,velocity:.8,accent:false,ghost:false,flam:false,sticking:''});
  const draft=emptyScore(8);draft.version=1;
  draft.bars=[{measureId:draft.timeline.measures[0].id,coverage:'progress',hits:[hit('first','kick')]}];
  part.importScore(draft);
  const next=emptyScore(8);next.version=1;
  next.bars=[{measureId:next.timeline.measures[1].id,coverage:'reviewed',hits:[hit('second','snare')]}];
  expect(part.stats).toEqual({notes:1,reviewed:0});
  part.importScore(next,{replace:true});
  expect(hits().map(h=>h.id)).toEqual(['second']);expect(part.stats).toEqual({notes:1,reviewed:1});
  key('z',{ctrlKey:true});expect(hits().map(h=>h.id)).toEqual(['first']);
});
