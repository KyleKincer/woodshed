// Transcribe workspace: write and correct the drum part against the
// recording. The score view is the engraved part (as the chart shows it); the
// lanes view is an event grid aligned with the recording. Hits store only their
// position; written rhythm is derived, so entry is "where", never "how long".
//
// Edit · Chart (architecture §2.15, spec §5.2, maps/notation.md §12): this
// module owns the surface (score or lanes, focus scope `edit.chart.score`), the
// lane labels, the note list and the inspector panel bodies it renders into
// the frame's slots. src/edit/chart/chart-edit.js draws the toolbar, the
// section navigator, the status bar, menus, inspector tabs and kit bank from
// state() and drives everything through run(). Keys are registry commands
// (src/edit/chart/commands.js) that call run(); nothing here listens for keys.
//
// The score is the whole song on one scrolling sheet (2.8; the 16-bar pages
// are gone): alphaTab engraves every bar and paints only the lines on screen,
// so an edit re-engraves the part in one pass. The sheet scrolls inside the
// frame's scroller (`scroll.el`): the caret is kept in view, playback is
// followed line by line, a manual scroll pauses Follow, and a zoom or a
// re-engraving keeps the bar at the top of the window where it was.
//
//   createNotationWorkspace({host, slots: {inspector: {kit, properties, listen}, kitBank, status}, part, song,
//     engine, songMap, transport, mix, drumAudio, listen, viewport, scroll, openMap, openDrumImport, dialog, drumKeys})
//   → {run(id, ...args), state(), subscribe(fn) → off, menus(), focus(), setVisible(b), tick(t), flush(),
//      notice(text), visibleBars() → {first, last}|null, onViewport(fn) → off, where(time) → bars (fractional),
//      destroy(), surface}
//
// Adapters (each optional; the defaults drive the engine directly, as 1.9 did):
//   transport  {playStop, pause, again, playFrom(t), seek(t), setLoop({a, b, aBar, bBar}), isPlaying()}
//              seek(t): stopped → move the cue; playing → seek without moving it
//   mix        {hasRecordedDrums(), recordedDrumsOut(), toggleRecordedDrums()}: the same state as the Mix sheet
//   drumAudio  the session's DrumAudio (an object or a getter); previews and audition play through it
//   listen     {mode(), setMode(m), level(), setLevel(x)}: Listen persists across postures (notation session)
//   viewport   {get() → {start, end}, set(start, end)}: the lanes' seconds window
//   scroll     {el, insets() → {top, bottom}}: the element that scrolls the sheet (default: the nearest
//              [data-scroller]) and how much of its top and bottom is covered by sticky bars
//   openMap(q, {edit, bar})  Bar meter & label… / Align in tempo map… switch to Edit · Map at that bar
//   openDrumImport()         Part ▾ Import a chart from a file…
//   dialog({title, body: Element, submitLabel, onSubmit(form: FormData)}) → Promise; a thrown error shows inline
//   drumKeys   {get() → {kitId: KeyString|''}, save(keys), reserved() → {KeyString: title}}
import {KIT,kitPiece,id,fraction,number,add,subtract,compare,durationOf,starts,extent,locate,toTime,toQuarter,validateScore,upgradeScore,musicalStarts} from '../../../shared/notation.ts';
import {canWrite,rhythmCells} from '../../../shared/engrave.ts';
import {createScoreView} from './score-view.js';
import {renderLanes,laneRows,LANE_HEIGHT,LANE_TOP} from './lanes.js';
import {xml} from './html.js';
import {DrumAudio} from './audio.js';
import {wheelNavigation} from '../timeline-navigation.js';
import {snapPosition,moveLaneNotes} from './entry.js';
import {now} from '../../app/clock.js';
import {prefs as appPrefs} from '../../app/prefs.js';
import {confirm as appConfirm} from '../../app/feedback.js';
import {Dialog} from '../../ui/dialog.js';
import {drumKeyFor,drumKeyLabel,keyStringLetter,reservedScoreKeys,validateDrumKeys,STEP_VALUE} from '../../edit/chart/commands.js';
import {editMenu,partMenu,sectionsMenu} from '../../edit/chart/menus.js';
import '../../styles/views/notation/editor.css';

export const STEPS=Object.freeze([[4,'♩','Quarter','1/4'],[8,'♪','Eighth','1/8'],[16,'𝅘𝅥𝅯','Sixteenth','1/16'],[32,'1/32','32nd','1/32'],[64,'1/64','64th','1/64']]);
export const TUPLETS=Object.freeze([[1,'Straight'],[3,'Triplet'],[5,'Quintuplet'],[6,'Sextuplet'],[7,'Septuplet']]);
export const GRIDS=Object.freeze([4,8,16,32,64]);
export const FAMILIES=Object.freeze([['cymbal','Cymbals & hi-hat'],['drum','Drums'],['foot','Feet'],['aux','Other']]);
/** Zoom steps of the sheet (the engraving scale; 1 is alphaTab's own size, what Edit · Chart drew before 2.8). */
export const ZOOM_STEPS=Object.freeze([.6,.7,.8,.9,1,1.1,1.25,1.5,1.75,2]);
export const DEFAULT_ZOOM=1;
/** How many bars the lanes show after a jump or a view change. */
export const LANE_BARS=8;
/** Follow: the playing line stays in the top part of the window; beyond this share of it, the sheet scrolls. */
export const FOLLOW_ZONE=.55;
/** A manual scroll this soon after one the editor made is its own momentum, not the user's (ms). */
export const SCROLL_GUARD_MS=700;
/** Wheel travel (px, with Ctrl or ⌘ held: a trackpad pinch) per zoom step. */
export const ZOOM_WHEEL_PX=36;
/** A width change re-engraves this long after it settles (a window being dragged wider engraves once). */
export const RESIZE_SETTLE_MS=150;
export const INSPECTOR_TABS=Object.freeze(['kit','properties','listen']);
/** Save status copy (maps/notation.md §8.8). */
export const STATUS_TEXT=Object.freeze({loading:'Opening part…',saved:'Saved',local:'Saved on this device',saving:'Saving…',offline:'Waiting for connection · edits kept here',conflict:'Another version exists · edits kept here','storage-error':'Device storage unavailable · export a backup','read-only':'Read-only shared part',fixture:'Local development fixture'});
/**
 * The score's label sizes in Edit · Chart (spec §8.1 desk minimums: 12 px anywhere, 14 px on coarse pointers). The
 * score view's defaults stay at the 1.9 sizes (11/15) for the geometry baseline, so the editor passes its floors.
 */
export const SCORE_FONTS=Object.freeze({fine:Object.freeze({barNumber:12,marker:15}),coarse:Object.freeze({barNumber:14,marker:15})});
/** Label sizes in engraving px for a zoom: below 100% they grow so the on-screen size keeps its floor. */
export const scoreFonts=(zoom=1)=>{let coarse=false;try{coarse=!!globalThis.matchMedia?.('(pointer: coarse)').matches;}catch{coarse=false;}const floors=SCORE_FONTS[coarse?'coarse':'fine'],k=Math.min(1,zoom>0?zoom:1);return {barNumber:Math.ceil(floors.barNumber/k-1e-9),marker:Math.ceil(floors.marker/k-1e-9)};};
/** The nearest zoom step to a stored or requested value. */
export const snapZoom=value=>{const v=Number(value);if(!Number.isFinite(v))return DEFAULT_ZOOM;return ZOOM_STEPS.reduce((best,z)=>Math.abs(z-v)<Math.abs(best-v)-1e-9?z:best,ZOOM_STEPS[0]);};
/** The sections of a timeline for the navigator: the first bar and every labelled bar start one. */
export function sectionsOf(timeline){const m=timeline?.measures??[],out=[];m.forEach((measure,i)=>{if(i===0||measure.label)out.push({id:`bar-${i}`,label:measure.label||'',bar:i,bars:0});});out.forEach((sec,k)=>{sec.bars=(out[k+1]?.bar??m.length)-sec.bar;});return out;}
const SLIDER_KEYS='ArrowLeft ArrowRight ArrowUp ArrowDown Home End PageUp PageDown';
const DOUBLE_CLICK_MS=400;
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const download=(value,name,type='application/json')=>{const url=URL.createObjectURL(new Blob([value],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
/** Grid step for entry: a written value, dotted, or `tuplet` notes in the time of 2 (triplets) or 4. */
const stepOf=(value,dotted,tuplet)=>tuplet>1?fraction(4*(tuplet<4?2:4),value*tuplet):durationOf(value,dotted,1);
export function describe(hit){const k=kitPiece(hit.instrument);return `${k?.name||hit.instrument}${hit.heavy?', heavy accent':hit.accent?', accent':''}${hit.ghost?', ghost':''}${hit.drag?', drag':hit.flam?', flam':''}${hit.roll?`, roll (${hit.roll} slash${hit.roll>1?'es':''})`:''}${hit.sticking?`, ${hit.sticking} hand`:''}`;}
/** The piece written on a staff position, preferring the current piece when it shares the line. */
const pieceForLine=(line,current)=>{const at=KIT.filter(k=>k.line===line);if(!at.length)return null;return at.find(k=>k.id===current)?.id||at.find(k=>k.core)?.id||at[0].id;};
const pressed=on=>`aria-pressed="${on?'true':'false'}"`;
/** How a piece's notehead is drawn on a pad: cymbals and stick clicks are crosses, the bell a diamond, the cowbell a triangle. */
export function padHead(kit){
  if(kit.id==='rideBell')return 'diamond';
  if(kit.id==='cowbell')return 'triangle';
  if(kit.id==='openHat')return 'circle-cross';
  if(kit.id==='rimshot')return 'slash';
  if(kit.family==='cymbal'||kit.id==='crossStick'||kit.id==='pedalHat')return 'cross';
  return 'oval';
}
/**
 * A pad's picture: the piece's notehead where it sits on the staff (KitPiece.line: 0 is the top line, 8 the bottom
 * line), so the Kit panel reads like the score. A choke has the stopped mark (+) above the head.
 */
export function padGlyph(kit){
  const y=9+2*kit.line,x=14,head=padHead(kit),lines=[0,2,4,6,8].map(l=>`<path class="pad-staff" d="M3 ${9+2*l}H25"/>`).join('');
  const ledger=kit.line<=-2?`<path class="pad-staff" d="M9 5H19"/>`:kit.line>=10?`<path class="pad-staff" d="M9 29H19"/>`:'';
  const cross=`<path class="pad-stroke" d="M${x-2.6} ${y-2.6}l5.2 5.2M${x+2.6} ${y-2.6}l-5.2 5.2"/>`;
  const shape={
    oval:`<ellipse class="pad-fill" cx="${x}" cy="${y}" rx="3.3" ry="2.4" transform="rotate(-22 ${x} ${y})"/>`,
    slash:`<ellipse class="pad-fill" cx="${x}" cy="${y}" rx="3.3" ry="2.4" transform="rotate(-22 ${x} ${y})"/><path class="pad-stroke" d="M${x-4.4} ${y+3.6}l8.8 -7.2"/>`,
    cross,
    'circle-cross':`${cross}<circle class="pad-stroke" cx="${x}" cy="${y}" r="4.3"/>`,
    diamond:`<path class="pad-fill" d="M${x} ${y-3.4}l3.6 3.4l-3.6 3.4l-3.6 -3.4z"/>`,
    triangle:`<path class="pad-fill" d="M${x} ${y-3.2}l3.8 6.2h-7.6z"/>`,
  }[head];
  const choke=/Choke$/.test(kit.id)?`<path class="pad-stroke" d="M${x+5.2} ${y-6.4}v4.2M${x+3.1} ${y-4.3}h4.2"/>`:'';
  return `<svg class="notation-pad-glyph" viewBox="2 0 24 34" width="24" height="34" aria-hidden="true" focusable="false">${lines}${ledger}${shape}${choke}</svg>`;
}
let workspaceSeq=0;

/** A form dialog on the Dialog primitive: `body` holds the controls; onSubmit gets the form's FormData. */
export function formDialog({title,body,submitLabel='Apply',onSubmit}){
  let dialog=null;
  dialog=Dialog({title,body,width:560,className:'notation-dialog',
    actions:[{label:'Cancel',value:null},{label:submitLabel,value:'submit',variant:'primary',submit:true}],
    form:{fields:[],onSubmit:async()=>{await onSubmit(new FormData(dialog.el.querySelector('form')));}}});
  return dialog.closed;
}
const fragment=html=>{const box=document.createElement('div');box.className='notation-dialog-body';box.innerHTML=html;return box;};

export async function createNotationWorkspace({host,slots={},part,song,engine,songMap=null,transport=null,mix=null,drumAudio=null,listen=null,viewport=null,scroll=null,openMap=null,openDrumImport=null,dialog=formDialog,confirm:ask=appConfirm,drumKeys=null,prefs=appPrefs}) {
  const seq=++workspaceSeq,ids={help:`notation-help-${seq}`,cell:`notation-active-cell-${seq}`};
  let layout=prefs.get('edit.chart.view')==='lanes'?'lanes':'score',cursor=fraction(0),selected=new Set(),barRange=[0,0],piece='snare',stepValue=8,stepDotted=false,stepTuplet=1,voice='auto',clipboard=[],showList=false;
  let selectionKind='bars',wholeBarArmed=false,noteClipboard=null,inspectorTab='kit',auditionPads=false,gridValue=16,gridTuplet=1,allLanes=false,followPlayback=true,zoom=snapZoom(prefs.get('edit.chart.zoom'));
  // Scrolling the sheet: what to bring into view after the next engraving, the bar pinned at the top of the window
  // (kept there across a zoom or a re-engraving), the line playback last followed, and when the editor last scrolled.
  let pendingReveal=null,anchor=null,followedLine=null,scrolledAt=-Infinity,viewportFrame=0,lastVisible='';
  const viewportListeners=new Set();
  let cancelGesture=()=>{},gesture=false,lastPointerClick=null,disposed=false,status=part.status,messageText='',wasPlaying=false,visible=true;
  let expression={accent:false,heavy:false,ghost:false,flam:false,drag:false,roll:0,sticking:'',velocity:.75};
  const interpretWheel=wheelNavigation();
  const listeners=new Set();
  const keys=drumKeys??{get:()=>prefs.get('edit.chart.keys')??{},save:next=>prefs.set('edit.chart.keys',next),reserved:()=>reservedScoreKeys()};
  const keyFor=kit=>drumKeyFor(kit,keys.get());
  const keyCap=kit=>{const k=keyFor(kit);return k?drumKeyLabel(k):'';};
  let ownAudio=null,view=null,renderedKey='',lastView='',lanesData=null;
  const editor=()=>part.editor;
  const score=()=>part.editor?.score;
  const audio=()=>{const provided=typeof drumAudio==='function'?drumAudio():drumAudio;if(provided)return provided;if(!ownAudio){ownAudio=new DrumAudio(engine);ownAudio.setScore?.(score());}return ownAudio;};
  const tr={
    playStop:()=>transport?.playStop?.(),pause:()=>transport?.pause?.(),again:()=>transport?.again?.(),
    playFrom:t=>{if(transport?.playFrom)return transport.playFrom(t);engine.seek(t);if(!engine.playing)return engine.play?.();},
    seek:t=>{if(transport?.seek)transport.seek(t);else engine.seek(t);},
    setLoop:range=>{if(transport?.setLoop)transport.setLoop(range);else engine.setLoop(true,range.a,range.b);},
    isPlaying:()=>transport?.isPlaying?transport.isPlaying():!!engine.playing,
  };
  const mixer={
    has:()=>mix?.hasRecordedDrums?mix.hasRecordedDrums():engine.tracks.some(t=>t.name==='drums'),
    out:()=>mix?.recordedDrumsOut?!!mix.recordedDrumsOut():!!engine.tracks.find(t=>t.name==='drums')?.muted,
    toggle:()=>{if(mix?.toggleRecordedDrums)mix.toggleRecordedDrums();else engine.toggleMute('drums');},
  };
  const listening={
    mode:()=>listen?.mode?listen.mode():(typeof drumAudio==='function'?drumAudio():drumAudio)?.mode??ownAudio?.mode??'recording',
    setMode:m=>{if(listen?.setMode)listen.setMode(m);else{const a=audio();a.setScore?.(score());a.setMode(m);}},
    level:()=>listen?.level?listen.level():audio().level??audio().out?.gain.value??.65,
    setLevel:x=>{if(listen?.setLevel)listen.setLevel(x);else{const a=audio();if(a.setLevel)a.setLevel(x);else a.out.gain.value=x;}},
  };
  let ownView=null;
  const lanesWindow=viewport??{get:()=>ownView??defaultView(),set:(start,end)=>{ownView={start,end};}};
  function defaultView(){const s=score();if(!s)return {start:0,end:Math.max(1,engine.duration||8)};const positions=starts(s.timeline),total=s.timeline.measures.length,first=clamp(barRange[0],0,total-1),last=Math.min(first+LANE_BARS,total)-1;return {start:toTime(s.timeline,positions[first]),end:toTime(s.timeline,positions[last]+number(s.timeline.measures[last].length))};}
  const getView=()=>lanesWindow.get();
  const setView=(start,end)=>lanesWindow.set(start,end);

  const surfaceFocused=()=>!!surface&&(document.activeElement===surface||surface.contains(document.activeElement));
  const focus=()=>{if(!disposed&&!document.querySelector('dialog[open]'))surface?.focus({preventScroll:true});};
  const notify=()=>{if(disposed)return;const snapshot=state();for(const fn of [...listeners]){try{fn(snapshot);}catch(err){queueMicrotask(()=>{throw err;});}}};
  const message=text=>{messageText=String(text??'');if(slots.status)slots.status.textContent=messageText;notify();};
  const statusText=state=>STATUS_TEXT[state]||state;
  const saveStatus=state=>{status=state;notify();};
  const changed=()=>{if(!editor())return;const s=score();selected=new Set([...selected].filter(id=>s.bars.some(b=>b.hits.some(h=>h.id===id))));if(number(cursor)>=extent(s.timeline))cursor=fraction(Math.round((extent(s.timeline)-.0001)*1e6),1e6);barRange=barRange.map(i=>Math.min(i,s.timeline.measures.length-1));part.commit();};
  const attempt=fn=>{try{return fn();}catch(error){message(error.message||String(error));return undefined;}};
  // state() runs for every command the registry evaluates: with nothing selected there is nothing to look for.
  const selectedHits=()=>selected.size?score().bars.flatMap(b=>b.hits).filter(h=>selected.has(h.id)):[];
  const active=()=>locate(score().timeline,number(cursor));
  const step=()=>stepOf(stepValue,stepDotted,stepTuplet);
  const gridStep=()=>durationOf(gridValue,false,gridTuplet);
  const navigationStep=()=>layout==='lanes'?gridStep():step();
  const rows=()=>laneRows(score(),{piece,all:allLanes});
  const negate=f=>subtract(fraction(0),f);
  function rangeLabel(){return barRange[0]===barRange[1]?`Bar ${barRange[0]+1}`:`Bars ${barRange[0]+1}–${barRange[1]+1}`;}
  const count=(n,word)=>`${n.toLocaleString('en-US')} ${word}${n===1?'':'s'}`;
  /** The hit ids in bars a..b. */
  function hitsInBars(a,b){const s=score();return new Set(s.bars.filter(bar=>{const i=s.timeline.measures.findIndex(m=>m.id===bar.measureId);return i>=a&&i<=b;}).flatMap(bar=>bar.hits.map(h=>h.id)));}
  /** ⌘A and Select all bars: the bars with their notes selected (the expression keys and Delete act on them). */
  function selectBars(a,b){selectionKind='bars';barRange=[Math.min(a,b),Math.max(a,b)];selected=hitsInBars(...barRange);}
  /** What Delete removes: the selected notes, else every note in a bar range made with Shift (+→ or click). */
  const deleteTargets=()=>selected.size||selectionKind!=='bars'||barRange[0]===barRange[1]?selected:hitsInBars(...barRange);
  /** Clear drum chart…: every note and reviewed mark goes (one undo step) after a confirm; the map stays. */
  async function clearPart(){
    const s=score(),notes=s.bars.reduce((n,b)=>n+b.hits.length,0),reviewed=s.bars.filter(b=>b.coverage==='reviewed').length;
    if(!notes&&s.bars.every(b=>b.coverage==='unstarted')){message('The drum chart is already empty.');return false;}
    const ok=await ask({title:'Clear the drum chart?',body:`This removes ${notes?`all ${count(notes,'note')}`:'the empty bars’ progress'}${reviewed?` and the reviewed marks on ${count(reviewed,'bar')}`:''}. The tempo map, meters and sections stay. Undo brings the chart back.`,confirmLabel:'Clear chart',danger:true});
    if(!ok||disposed||!editor())return false;
    editor().transact(d=>{for(const bar of d.bars){bar.hits=[];bar.coverage='unstarted';delete bar.tuplets;}});
    selected.clear();selectionKind='notes';wholeBarArmed=false;changed();message('Cleared the drum chart. Undo brings it back.');return true;
  }

  function navigate(q,{seek=false,extend=false,align='nearest'}={}){
    const total=extent(score().timeline);
    cursor=number(q)>=0&&number(q)<total?q:fraction(Math.round(clamp(number(q),0,total-.0001)*1e6),1e6);
    selected.clear();selectionKind=extend?'bars':'notes';wholeBarArmed=false;const a=active();barRange=extend?[Math.min(barRange[0],a.index),Math.max(barRange[1],a.index)]:[a.index,a.index];
    if(seek)tr.seek(toTime(score().timeline,number(cursor)));
    followPlayback=false;pendingReveal={index:a.index,align};
    const time=toTime(score().timeline,number(cursor)),v=getView();
    if(layout==='lanes'&&(time<v.start||time>v.end)){const width=v.end-v.start;setView(time-.1*width,time+.9*width);}
    render();
  }
  function insert(instrument=piece,{preview=false}={}){
    const kit=kitPiece(instrument);if(!kit)return;piece=instrument;
    const a=active(),{heavy,drag,roll,...rest}=expression,hit={id:id(),instrument,offset:subtract(cursor,a.startPosition),voice:voice==='auto'?kit.voice:Number(voice),...rest,flam:expression.flam&&!drag,...(heavy?{heavy:true}:{}),...(drag?{drag:true}:{}),...(roll?{roll}:{})};
    if(preview){audio().play(hit,engine.ctx.currentTime,true);message(`Preview · ${kit.name}`);render();return;}
    const bar=score().bars.find(b=>b.measureId===a.measure.id);
    if(!canWrite(bar,a.measure,hit,score().layout))throw new Error('A note cannot be written there. Choose a coarser step, or clear the tuplet on this beat.');
    selectionKind='notes';selected=new Set([editor().insert(a.index,hit)]);barRange=[a.index,a.index];changed();audio().play(selectedHits()[0]||hit,engine.ctx.currentTime,true);
  }
  function auditionPiece(kitId){const kit=kitPiece(kitId);if(!kit)return;piece=kit.id;audio().play({instrument:kit.id,velocity:.75},engine.ctx.currentTime,true);render();}
  /** Bring the cursor's bars into the lanes' window. */
  function revealCursor(){const s=score(),t=toTime(s.timeline,number(cursor)),v=getView();if(t>=v.start&&t<=v.end)return;const index=active().index;fitBars(index,Math.min(index+3,s.timeline.measures.length-1));}
  function setStep(value=stepValue,dotted=stepDotted,tuplet=stepTuplet){stepValue=value;stepDotted=tuplet>1?false:dotted;stepTuplet=tuplet;
    // Keep the cursor on the new grid inside its beat.
    const a=active(),snapped=snapPosition(score(),number(cursor),step());if(compare(snapped,cursor)!==0&&locate(score().timeline,number(snapped)).index===a.index)cursor=snapped;render();}
  function setExpression(property,next){if(selected.size){const patch={[property]:next};if(property==='drag'&&next)patch.flam=false;if(property==='flam'&&next)patch.drag=false;if(property==='heavy'&&next)patch.accent=true;editor().change(selected,patch);changed();}else{expression={...expression,[property]:next};if(property==='drag'&&next)expression.flam=false;if(property==='flam'&&next)expression.drag=false;render();}}
  const toggleExpression=property=>setExpression(property,!(selected.size?selectedHits()[0][property]:expression[property]));
  function copy(wholeBars=false){
    const s=score();
    if(!wholeBars&&selectionKind==='notes'&&selected.size){
      const notes=[];
      for(const bar of s.bars){const index=s.timeline.measures.findIndex(m=>m.id===bar.measureId);for(const hit of bar.hits)if(selected.has(hit.id))notes.push({hit:structuredClone(hit),position:add(musicalStarts(s.timeline)[index],hit.offset)});}
      const first=notes.reduce((p,n)=>compare(n.position,p)<0?n.position:p,notes[0].position);
      noteClipboard=notes.map(({hit,position})=>({hit,offset:subtract(position,first)}));
      message(`${notes.length} note${notes.length===1?'':'s'} copied. Paste at the edit cursor.`);return;
    }
    noteClipboard=null;clipboard=Array.from({length:barRange[1]-barRange[0]+1},(_,i)=>structuredClone(s.bars.find(b=>b.measureId===s.timeline.measures[barRange[0]+i].id)||{coverage:'unstarted',hits:[]}));message(`${rangeLabel()} copied.`);
  }
  function moveNotes(delta){if(!selected.size)return;if(layout==='lanes')moveLaneNotes(editor(),selected,delta,0,rows());else editor().move(selected,delta);cursor=add(cursor,delta);const index=active().index;barRange=[index,index];pendingReveal={index,align:'nearest'};changed();}
  function moveDialog(){if(!selected.size){message('Select notes to move first.');return;}return dialog({title:'Move selected notes',submitLabel:'Move',body:fragment(`<p>Move ${selected.size} selected note${selected.size===1?'':'s'} by a musical offset. Positive values move later; negative values move earlier. Other notes stay in place.</p><label class="notation-field">Quarter notes <input name="delta" type="number" step="any" value="${number(step())}" required></label><p class="notation-hint">You can also use Alt + ← / → to move by the current step.</p>`),onSubmit:data=>{const delta=Number(data.get('delta'));if(String(data.get('delta')).trim()===''||!Number.isFinite(delta))throw new Error('Enter a musical offset.');moveNotes(fraction(Math.round(delta*1e6),1e6));}});}
  function fitBars(first,last){const positions=starts(score().timeline),t=score().timeline;setView(toTime(t,positions[first]),toTime(t,positions[last]+number(t.measures[last].length)));followPlayback=false;}
  function repeat(paste=false){if(paste&&noteClipboard){editor().pasteHits(cursor,noteClipboard);changed();message('Notes pasted at the edit cursor.');return;}if(!paste)copy(true);if(!clipboard.length){message('Select and copy one or more bars first.');return;}
    const total=score().timeline.measures.length;
    return dialog({title:paste?'Paste passage':'Repeat passage',submitLabel:'Paste',body:fragment(`<p>${clipboard.length} bar${clipboard.length===1?'':'s'}.</p><div class="notation-form-grid"><label class="notation-field">Start at bar <input name="to" type="number" min="1" max="${total}" value="${paste?barRange[0]+1:Math.min(barRange[1]+2,total)}" required></label><label class="notation-field">Copies <input name="count" type="number" min="1" max="64" value="1" required></label></div><label class="notation-check"><input name="replace" type="checkbox"> Replace written notes in the destination</label>`),onSubmit:data=>{const to=Number(data.get('to')),count=Number(data.get('count'));if(!Number.isInteger(to)||to<1||to>total)throw new Error(`Choose a bar from 1 to ${total}.`);if(!Number.isInteger(count)||count<1||count>64)throw new Error('Choose 1 to 64 copies.');editor().paste(0,to-1,count,data.has('replace'),clipboard);changed();}});
  }
  /** Explicit tuplet over the beat at the cursor, for rhythms the automatic grid can't infer. */
  function tupletDialog(){const a=active(),cells=rhythmCells(a.measure),cell=cells.find(c=>compare(c.start,a.offset===0?fraction(0):fraction(Math.round(a.offset*960),960))<=0&&compare(add(c.start,c.length),fraction(Math.round(a.offset*960),960))>0)||cells[0],beat=number(cell.length),bar=score().bars.find(b=>b.measureId===a.measure.id),existing=(bar?.tuplets||[]).find(t=>compare(t.start,cell.start)<=0&&compare(add(t.start,t.length),cell.start)>0);
    return dialog({title:`Tuplet in bar ${a.index+1}`,body:fragment(`<p>Most tuplets are written automatically from where the notes fall. Set one here for rhythms that span beats, such as quarter-note triplets, or to keep a bracket on a beat with a single note.</p><div class="notation-form-grid"><label class="notation-field">Notes in the tuplet <select name="count">${[...new Set([0,2,3,4,5,6,7,9,...(existing?[existing.count]:[])])].sort((x,y)=>x-y).map(n=>`<option value="${n}" ${(existing?existing.count===n:n===3)?'selected':''}>${n?n:'Automatic (clear)'}</option>`).join('')}</select></label><label class="notation-field">Spanning <select name="span">${[[.5,'Half a beat'],[1,'One beat'],[2,'Two beats'],[4,'Four beats']].filter(([n])=>n*beat<=number(a.measure.length)+1e-9).map(([n,l])=>`<option value="${n}" ${(existing?Math.abs(number(existing.length)/beat-n)<1e-9:n===1)?'selected':''}>${l}</option>`).join('')}</select></label></div><p class="notation-hint">Starts at beat ${cells.indexOf(cell)+1}. Notes already in the span must fall on the tuplet's grid.</p>`),onSubmit:data=>{const count=Number(data.get('count')),length=fraction(Math.round(Number(data.get('span'))*beat*960),960);if(compare(add(cell.start,length),a.measure.length)>0)throw new Error('The tuplet would run past the end of the bar.');editor().setTuplet(a.index,count?{start:cell.start,length,count}:null,cell.start,length);changed();}});}
  function exportNative(){download(JSON.stringify({format:'woodshed-notation',version:2,song:{title:song.title,artist:song.artist,duration:engine.duration},score:score()},null,2),`${String(song.title||'Song').replace(/[^\p{L}\p{N} -]/gu,'_')}-drums.woodshed.json`);}
  function importNative(){const input=document.createElement('input');input.type='file';input.accept='.json,application/json';input.onchange=async()=>{try{const file=input.files[0];if(!file)return;if(file.size>8_000_000)throw new Error('The score file is too large.');const data=JSON.parse(await file.text());if(data.format!=='woodshed-notation')throw new Error('Choose a Woodshed notation export.');const imported=upgradeScore(data.score);validateScore(imported);await dialog({title:'Replace drum part',submitLabel:'Replace part',body:fragment(`<p>This replaces the current notation with ${xml(file.name)}. The audio stays in place. Undo restores your current part. Check alignment if this came from a different recording.</p>`),onSubmit:()=>{editor().transact(s=>Object.assign(s,imported));if(songMap){try{songMap.replaceFromTimeline(imported.timeline);}catch(error){editor().undo();message(error.message);return;}}cursor=fraction(0);selected.clear();barRange=[0,0];pendingReveal={index:0,align:'start'};changed();}});}catch(e){message(e.message);}};input.click();}
  function printScore(){
    const sheet=document.createElement('div');sheet.className='notation-print';sheet.innerHTML=`<h1>${xml(song.title)} — Drums</h1><div class="notation-print-score"></div>`;document.body.append(sheet);
    const printView=createScoreView(sheet.querySelector('.notation-print-score'),{print:true,barsPerRow:4,onRender:()=>{setTimeout(()=>{window.print();printView.destroy();sheet.remove();},50);}});
    printView.setScore(score());
  }
  /** Drum keys…: one letter per pad (physical keys, D56); the score's own keys are reserved (D18). */
  function keyboardSettings(){
    const current=keys.get();
    return dialog({title:'Drum keys',submitLabel:'Save keys',body:fragment(`<p>A pad's letter writes it at the cursor while the score or lanes have focus. Leave a field empty for no key.</p><div class="notation-form-grid notation-keys-grid">${KIT.map(k=>`<label class="notation-field">${xml(k.name)}<input name="${k.id}" value="${xml(keyStringLetter(drumKeyFor(k,current)))}" maxlength="1" autocomplete="off" spellcheck="false" aria-describedby="${ids.help}-keys"></label>`).join('')}</div><p class="notation-hint" id="${ids.help}-keys">Letters A to Z; each pad needs its own.</p>`),onSubmit:data=>{const result=validateDrumKeys(Object.fromEntries(KIT.map(k=>[k.id,String(data.get(k.id)??'')])),{reserved:keys.reserved()});if(result.error)throw new Error(result.error);keys.save(result.keys);message('Drum keys saved.');render();}});
  }
  /**
   * A jump (the navigator, a section, ?bar=): the bar's line goes to the top of the window; the lanes show it and
   * the bars after it. `seek` also moves the cue there while the song is stopped, so Play starts from the jump.
   */
  function goToBar(index,{seek=false}={}){const s=score(),target=clamp(Math.round(Number(index)||0),0,s.timeline.measures.length-1);barRange=[target,target];if(layout==='lanes')fitBars(target,Math.min(target+LANE_BARS,s.timeline.measures.length)-1);navigate(musicalStarts(s.timeline)[target],{seek:seek&&!tr.isPlaying(),align:'start'});}

  // ---- the sheet's scroller ---------------------------------------------------------------------------------
  const scroller=()=>scroll?.el??host.closest?.('[data-scroller]')??null;
  const insets=()=>{const given=scroll?.insets?.()??{};return {top:Math.max(0,Number(given.top)||0),bottom:Math.max(0,Number(given.bottom)||0)};};
  const reducedMotion=()=>{try{return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;}catch{return false;}};
  /** The window onto the sheet, in the sheet's own (score stage) coordinates: what the sticky bars leave uncovered. */
  function sheetWindow(){const el=scroller();if(!el||!view?.stage)return null;const box=el.getBoundingClientRect(),stage=view.stage.getBoundingClientRect(),pad=insets(),top=box.top+pad.top-stage.top,bottom=box.top+el.clientHeight-pad.bottom-stage.top;return bottom>top?{el,top,bottom,height:bottom-top}:null;}
  function scrollBy(delta,smooth){const w=scroller();if(!w||Math.abs(delta)<1)return;scrolledAt=now();const top=clamp(w.scrollTop+delta,0,Math.max(0,w.scrollHeight-w.clientHeight));if(typeof w.scrollTo==='function')w.scrollTo({top,behavior:smooth&&!reducedMotion()?'smooth':'auto'});else w.scrollTop=top;}
  /**
   * Brings bar `index` into the window. 'nearest' scrolls only when its line is cut off; 'start' puts the line near
   * the top; 'follow' does that once the line has left the top part of the window (playback).
   */
  function reveal(index,{align='nearest',smooth=false}={}){
    if(layout!=='score'||!view?.ready)return false;const b=view.barBounds(index),w=sheetWindow();if(!b||!w)return false;
    // The line with its bar numbers and section name above, and its stems and stickings below.
    const top=Math.min(b.y,b.lineTop-24),bottom=Math.max(b.y+b.h,b.lineTop+b.lineHeight+24),lead=Math.min(40,w.height*.1);
    let delta=0;
    if(align==='start')delta=top-lead-w.top;
    else if(align==='follow'){if(top<w.top||top>w.top+w.height*FOLLOW_ZONE||bottom>w.bottom)delta=top-lead-w.top;}
    else if(top<w.top)delta=top-12-w.top;
    else if(bottom>w.bottom)delta=Math.min(bottom+12-w.bottom,top-12-w.top);
    scrollBy(delta,smooth);return true;
  }
  /** The bars whose lines show in the window, or null (lanes, not engraved, no scroller). */
  function visibleBars(){if(layout!=='score'||!view?.ready)return null;const w=sheetWindow();return w?view.barsBetween?.(w.top,w.bottom)??null:null;}
  /** Pins the first bar in the window, with how far its line sits from the window's top. */
  function captureAnchor(){const w=sheetWindow(),bars=w&&view?.ready?view.barsBetween?.(w.top,w.bottom):null,b=bars?view.barBounds(bars.first):null;anchor=b?{index:bars.first,offset:b.y-w.top}:null;}
  function restoreAnchor(){if(!anchor||layout!=='score')return;const b=view?.barBounds(anchor.index),w=sheetWindow();if(b&&w)scrollBy(b.y-w.top-anchor.offset,false);}
  function reportViewport(){viewportFrame=0;if(disposed)return;const bars=visibleBars(),key=bars?`${bars.first}:${bars.last}`:'';if(key===lastVisible)return;lastVisible=key;for(const fn of [...viewportListeners]){try{fn(bars);}catch(err){queueMicrotask(()=>{throw err;});}}}
  const scheduleViewport=()=>{if(!viewportFrame)viewportFrame=requestAnimationFrame(reportViewport);};
  /** After every engraving: a pending jump wins; otherwise the pinned bar stays where it was. */
  function settleScroll(){if(pendingReveal){const {index,align}=pendingReveal;if(reveal(index,{align}))pendingReveal=null;}else restoreAnchor();captureAnchor();scheduleViewport();}
  const onScroll=()=>{if(layout==='score'&&view?.ready&&!pendingReveal)captureAnchor();scheduleViewport();};
  // A scroll the user makes while the song plays pauses Follow (as on the Stage); Play turns it back on.
  const onManualScroll=e=>{if(e.type==='pointerdown'&&e.target!==e.currentTarget)return;if(e.ctrlKey||e.metaKey||layout!=='score'||!followPlayback||!tr.isPlaying())return;if(now()-scrolledAt<SCROLL_GUARD_MS&&e.type==='wheel'&&Math.abs(e.deltaY)<4)return;followPlayback=false;notify();};
  function setZoom(next){const z=snapZoom(next);if(Math.abs(z-zoom)<1e-6)return;zoom=z;prefs.set('edit.chart.zoom',zoom);if(view&&layout==='score'){if(!pendingReveal)captureAnchor();if(view.configure({scale:zoom,fonts:scoreFonts(zoom)}))view.relayout();}notify();}
  const stepZoom=dir=>{const i=ZOOM_STEPS.indexOf(snapZoom(zoom));setZoom(ZOOM_STEPS[clamp(i+(dir<0?-1:1),0,ZOOM_STEPS.length-1)]);};

  host.classList.add('notation-workspace');
  // The surface scrolls under Edit · Chart's sticky toolbar and (iPad portrait) its docked kit bank by design, so the
  // fixture's overlap check leaves it out (data-structure-allow).
  host.innerHTML=`<div class="notation-body"><div class="notation-lane-labels" role="group" aria-label="Kit pieces" hidden></div><div class="notation-surface" role="grid" data-scope="edit.chart.score" data-structure-allow="overlap" aria-label="Drum notation. Click to place the cursor, double-click to add, drum keys enter notes, Space plays." aria-describedby="${ids.help}" tabindex="0"><div class="notation-score"><div class="notation-sheet-head" aria-hidden="true"><p class="notation-sheet-title"></p><p class="notation-sheet-sub"></p></div><div class="notation-engraving"></div></div><div class="notation-lanes" hidden></div><div class="notation-sr-only" role="row"><span role="gridcell" id="${ids.cell}"></span></div></div></div>
    <p class="notation-help notation-sr-only" id="${ids.help}"></p><div class="notation-note-list" role="group" aria-label="Note list" hidden></div><p class="notation-unavailable" hidden>This song has no drum part to edit.</p>`;
  const surface=host.querySelector('.notation-surface'),sheet=host.querySelector('.notation-score'),scoreHost=host.querySelector('.notation-engraving'),lanesHost=host.querySelector('.notation-lanes'),labelsHost=host.querySelector('.notation-lane-labels');
  surface.setAttribute('aria-activedescendant',ids.cell);
  // The sheet's heading, as on printed music: the song, then who plays it and the part.
  host.querySelector('.notation-sheet-title').textContent=song?.title||'Untitled';
  host.querySelector('.notation-sheet-sub').textContent=[song?.artist,'Drums'].filter(Boolean).join(' · ');

  // ---- inspector panels (rendered into the frame's slots) ---------------------------------------------------
  const kitPads=()=>FAMILIES.map(([f,label])=>`<div class="notation-pads" role="group" aria-label="${label}" data-family="${f}"><span class="notation-pad-family">${label}</span>${KIT.filter(k=>k.family===f).map(k=>`<button type="button" class="notation-pad" data-kit="${k.id}" data-family="${k.family}" title="${xml(k.name)}" aria-label="${xml(k.name)}" ${pressed(piece===k.id)}>${padGlyph(k)}<span class="notation-pad-name">${xml(k.short)}</span>${keyCap(k)?`<kbd class="ui-kbd">${xml(keyCap(k))}</kbd>`:''}</button>`).join('')}</div>`).join('');
  function renderInspector(){
    const ins=slots.inspector||{};const hits=selectedHits(),current=hits.length?hits[0]:expression;
    if(ins.kit)ins.kit.innerHTML=`<div class="notation-panel-head"><button type="button" class="notation-toggle" data-field="audition" ${pressed(auditionPads)}>Audition only</button><span class="notation-hint">${auditionPads?'Pads play without writing.':'Pads write at the cursor.'}</span></div>${kitPads()}`;
    if(ins.properties){const v=hits.length?String(current.voice):voice;
      ins.properties.innerHTML=`<div class="notation-inspector"><p class="notation-panel-title">${hits.length?`${hits.length} selected`:'Next note'}</p><div class="notation-toggles" role="group" aria-label="Articulation">${[['accent','Accent'],['heavy','Heavy accent'],['ghost','Ghost'],['flam','Flam'],['drag','Drag']].map(([p,l])=>`<button type="button" class="notation-toggle" data-expression="${p}" ${pressed(!!current[p])}>${l}</button>`).join('')}</div><label class="notation-field">Roll <select data-expression="roll">${[[0,'None'],[1,'1 slash'],[2,'2 slashes'],[3,'3 slashes']].map(([n,l])=>`<option value="${n}" ${(current.roll||0)===n?'selected':''}>${l}</option>`).join('')}</select></label><label class="notation-field">Sticking <select data-expression="sticking"><option value="" ${current.sticking?'':'selected'}>—</option><option value="L" ${current.sticking==='L'?'selected':''}>L</option><option value="R" ${current.sticking==='R'?'selected':''}>R</option></select></label><label class="notation-field">Velocity <input data-expression="velocity" type="range" min=".05" max="1" step=".05" value="${current.velocity??.75}" data-consume-keys="${SLIDER_KEYS}"></label><label class="notation-field">Voice <select data-field="voice">${[['auto','Auto'],['1','1 · Hands'],['2','2 · Feet']].map(([n,l])=>`<option value="${n}" ${v===n?'selected':''}>${l}</option>`).join('')}</select></label><button type="button" class="notation-action" data-action="delete" ${hits.length?'':'disabled'}>Delete</button></div><div class="notation-part-layout" role="group" aria-labelledby="notation-part-layout-${seq}"><p class="notation-panel-title" id="notation-part-layout-${seq}">Part layout <span class="notation-hint">saved with the part</span></p><div class="notation-segments">${[['combined','Together','One rhythm for the whole kit'],['split','Hands & feet','Hands stems up, feet stems down']].map(([n,l,t])=>`<button type="button" class="notation-toggle" data-layout="${n}" ${pressed((score().layout||'combined')===n)} title="${t}">${l}</button>`).join('')}</div></div>`;}
    if(ins.listen){const mode=listening.mode(),hasDrums=mixer.has(),out=hasDrums&&mixer.out();
      ins.listen.innerHTML=`<div class="notation-audition"><label class="notation-field">Listen to <select data-field="listen">${[['recording','Recording'],['notation','Notation'],['both','Both']].map(([n,l])=>`<option value="${n}" ${mode===n?'selected':''}>${l}</option>`).join('')}</select></label><label class="notation-field">Notation level <input data-field="level" type="range" min="0" max="1" step=".05" value="${listening.level()}" data-consume-keys="${SLIDER_KEYS}"></label><div class="notation-recorded" role="group" aria-labelledby="notation-recorded-${seq}"><p class="notation-panel-title" id="notation-recorded-${seq}">Recorded drums</p>${hasDrums?`<div class="notation-segments"><button type="button" class="notation-toggle" data-recorded="in" ${pressed(!out)}>In</button><button type="button" class="notation-toggle" data-recorded="out" ${pressed(out)}>Out</button></div><p class="notation-hint">The same switch as the Mix sheet.</p>`:'<p class="notation-hint">This song has no separate drum stem.</p>'}</div><button type="button" class="notation-action" data-action="play-cursor">Play from cursor</button></div>`;}
    if(slots.kitBank&&typeof slots.kitBank.update==='function')slots.kitBank.update(state());
  }

  function renderChrome(){
    const s=score(),a=active(),hits=selectedHits();
    host.classList.toggle('is-lanes',layout==='lanes');host.classList.toggle('is-score',layout==='score');
    labelsHost.hidden=layout!=='lanes';
    if(layout==='lanes')labelsHost.innerHTML=`<div class="notation-lane-gap" style="height:${LANE_TOP}px"></div>${rows().map(idName=>{const k=kitPiece(idName);return `<button type="button" class="notation-lane-label" data-audition-kit="${k.id}" title="Audition ${xml(k.name)}" ${pressed(piece===k.id)} style="height:${LANE_HEIGHT}px">${xml(k.short)}${keyCap(k)?`<kbd class="ui-kbd">${xml(keyCap(k))}</kbd>`:''}</button>`;}).join('')}`;
    else labelsHost.replaceChildren();
    host.querySelector('.notation-help').textContent=hits.length?`${hits.length} selected`:hintText();
    host.querySelector(`#${ids.cell}`).textContent=`Bar ${a.index+1}, beat ${(1+a.offset*a.measure.denominator/4).toFixed(2)}, ${kitPiece(piece)?.name||'Drums'}. ${hits.length?hits.map(describe).join('; '):'No note selected.'}`;
    const list=host.querySelector('.notation-note-list');list.hidden=!showList;
    if(showList){const first=barRange[0],last=barRange[1];const visibleBars=s.bars.filter(b=>{const i=s.timeline.measures.findIndex(m=>m.id===b.measureId);return i>=first&&i<=last;});list.innerHTML=visibleBars.flatMap(b=>b.hits.map(h=>`<button type="button" data-hit="${h.id}" ${pressed(selected.has(h.id))}>Bar ${s.timeline.measures.findIndex(m=>m.id===b.measureId)+1}, beat ${(1+number(h.offset)).toFixed(3)} · ${xml(describe(h))}</button>`)).join('')||`<p>No written notes in ${rangeLabel().toLowerCase()}.</p>`;}
    else list.replaceChildren();
    renderInspector();
  }

  const hintText=()=>layout==='lanes'?'Double-click to add · Drag to move':'Double-click the staff or press a drum key to add';
  /** The caret, the selected notes and the bar range, in one overlay pass. The status bar and the Kit panel name the piece. */
  function drawMarks(){const marks={caret:{q:number(cursor)},selection:selected,range:barRange[0]!==barRange[1]?barRange:null};if(view.setMarks)view.setMarks(marks);else{view.setCaret(marks.caret);view.setSelection(marks.selection);view.setRange(marks.range);}}
  function renderScore(){
    lanesHost.hidden=true;sheet.hidden=false;
    const s=score();
    // The whole song, with the part's own line breaks (the Stage's "New line here"), as the Stage's chart draws it.
    if(!view)view=createScoreView(scoreHost,{scale:zoom,fonts:scoreFonts(zoom),resizeSettleMs:RESIZE_SETTLE_MS,onRender:()=>{drawMarks();settleScroll();},onPointer:scorePointer});
    const key=s.layout||'';
    if(view.score!==s||renderedKey!==key){renderedKey=key;if(view.ready&&!pendingReveal)captureAnchor();view.setScore(s,{lineBreaks:true});}
    else{drawMarks();if(pendingReveal&&reveal(pendingReveal.index,{align:pendingReveal.align}))pendingReveal=null;}
  }
  function renderLanesView(){
    sheet.hidden=true;lanesHost.hidden=false;pendingReveal=null;
    const s=score(),width=Math.max(240,surface.clientWidth||800),positions=starts(s.timeline),v=getView();
    let indices=s.timeline.measures.map((m,i)=>i).filter(i=>toTime(s.timeline,positions[i]+number(s.timeline.measures[i].length))>v.start+1e-8&&toTime(s.timeline,positions[i])<v.end-1e-8);
    if(!indices.length)indices=[active().index];
    lanesData={...renderLanes(lanesHost,{score:s,indices,width,timeRange:v,selected,cursor:number(cursor),grid:number(gridStep()),rows:rows()}),width};
    lastView=JSON.stringify(v);
  }
  function render(){if(disposed)return;
    const has=!!editor();
    host.querySelector('.notation-body').hidden=!has;host.querySelector('.notation-unavailable').hidden=has;
    if(!has){notify();return;}
    const focused=document.activeElement,hadFocus=surface===focused;
    const roots=[host,...Object.values(slots.inspector||{})].filter(Boolean);
    const owner=roots.find(r=>r!==focused&&r.contains?.(focused));
    const focusAttribute=owner?[...focused.attributes].find(a=>a.name.startsWith('data-')&&a.name!=='data-consume-keys'):null;
    renderChrome();
    if(layout==='score')renderScore();else renderLanesView();
    if(hadFocus)focus();else if(owner&&focusAttribute)owner.querySelector(`[${focusAttribute.name}="${CSS.escape(focusAttribute.value)}"]`)?.focus({preventScroll:true});
    notify();
  }

  // Score pointer: click places the cursor (snapped to the step) or selects a
  // note; double-click writes the piece on that staff line; drag selects.
  function scorePointer({kind,event,at}){
    // A touch scroll cancels the gesture; never let its pointerup land later.
    if(kind==='cancel'){cancelGesture();return;}
    if(kind==='down'){if(event.button!==0||at.index==null)return;cancelGesture();followPlayback=false;gesture=true;
      const start={x:event.clientX,y:event.clientY,at,before:new Set(selected)};let moved=false,box=null;
      const stage=view.stage,rect=stage.getBoundingClientRect();
      const move=e=>{moved||=Math.hypot(e.clientX-start.x,e.clientY-start.y)>5;if(!moved)return;box??=Object.assign(document.createElement('div'),{className:'notation-drag-preview'});stage.append(box);const x0=Math.min(start.x,e.clientX)-rect.left,y0=Math.min(start.y,e.clientY)-rect.top;box.style.cssText=`left:${x0}px;top:${y0}px;width:${Math.abs(e.clientX-start.x)}px;height:${Math.abs(e.clientY-start.y)}px`;};
      const up=e=>{cleanup();attempt(()=>{
        const t=now(),doubleClick=!moved&&lastPointerClick&&t-lastPointerClick.time<DOUBLE_CLICK_MS&&Math.hypot(e.clientX-lastPointerClick.x,e.clientY-lastPointerClick.y)<8;
        lastPointerClick=moved||doubleClick?null:{time:t,x:e.clientX,y:e.clientY};
        if(moved){const x0=Math.min(start.x,e.clientX)-rect.left,x1=Math.max(start.x,e.clientX)-rect.left,y0=Math.min(start.y,e.clientY)-rect.top,y1=Math.max(start.y,e.clientY)-rect.top;selectionKind='notes';selected=e.shiftKey?start.before:new Set();for(const n of view.noteBoxes())if(n.x+n.w>=x0&&n.x<=x1&&n.y+n.h>=y0&&n.y<=y1)selected.add(n.hit.id);render();return;}
        if(at.hit){selectionKind='notes';const hitBar=score().bars.find(b=>b.hits.some(h=>h.id===at.hit.id)),index=score().timeline.measures.findIndex(m=>m.id===hitBar.measureId);
          selected=e.shiftKey?new Set(start.before):new Set();if(e.shiftKey&&start.before.has(at.hit.id))selected.delete(at.hit.id);else selected.add(at.hit.id);
          piece=at.hit.instrument;cursor=add(musicalStarts(score().timeline)[index],at.hit.offset);barRange=[index,index];
          if(doubleClick)inspectorTab='properties';
          if(!tr.isPlaying())tr.seek(toTime(score().timeline,number(cursor)));render();return;}
        const q=snapPosition(score(),at.q,step());
        // Shift-click extends the bar range to this bar, like Shift+→ (Delete then clears the range).
        if(e.shiftKey&&!doubleClick){navigate(q,{extend:true});return;}
        if(doubleClick){const line=Math.round((at.y-at.lineTop)/(at.lineHeight/8)),chosen=pieceForLine(line,piece);if(chosen)piece=chosen;cursor=q;insert();return;}
        navigate(q,{seek:!tr.isPlaying()});
      });focus();};
      const cleanup=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);box?.remove();gesture=false;cancelGesture=()=>{};};
      const cancel=()=>cancelGesture();
      cancelGesture=()=>{cleanup();render();};
      window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',cancel);
    }
  }

  // Lanes pointer: time-aligned grid; drag notes in time or across lanes.
  lanesHost.addEventListener('pointerdown',e=>{
    if(e.button!==0||!lanesData)return;e.preventDefault();cancelGesture();followPlayback=false;
    const rect=lanesHost.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top,width=lanesData.width,v=getView(),bar=lanesData.bars.find(b=>x>=b.left&&x<b.right);if(!bar)return;
    const targetAt=(px,py)=>lanesData.targets.filter(t=>px>=t.x-3&&px<=t.right+3&&Math.abs(t.y-py)<12).sort((a,b)=>Math.abs(a.x-px)-Math.abs(b.x-px))[0];
    const target=y>=LANE_TOP?targetAt(x,y):null,positionFromX=px=>snapPosition(score(),toQuarter(score().timeline,v.start+px/width*(v.end-v.start)),gridStep());
    const origin=y<LANE_TOP?fraction(Math.round(clamp(toQuarter(score().timeline,v.start+x/width*(v.end-v.start)),0,extent(score().timeline)-1e-6)*1e6),1e6):positionFromX(x),before=new Set(selected);
    let moved=false,lastX=x,lastY=y;const overlay=document.createElement('div');overlay.className='notation-drag-preview';lanesHost.append(overlay);lanesHost.setPointerCapture?.(e.pointerId);gesture=true;
    const cleanup=()=>{lanesHost.removeEventListener('pointermove',move);lanesHost.removeEventListener('pointerup',up);lanesHost.removeEventListener('pointercancel',cancel);overlay.remove();try{lanesHost.releasePointerCapture?.(e.pointerId);}catch{}gesture=false;cancelGesture=()=>{};};
    const cancel=()=>{cleanup();render();focus();};cancelGesture=cancel;
    const move=event=>{if(event.pointerId!==e.pointerId)return;lastX=clamp(event.clientX-rect.left,0,width-1);lastY=event.clientY-rect.top;moved||=Math.hypot(lastX-x,lastY-y)>4;if(!moved)return;
      if(target)overlay.style.cssText=`left:${lastX-(x-target.x)}px;top:${LANE_TOP+clamp(Math.round((lastY-LANE_TOP-LANE_HEIGHT/2)/LANE_HEIGHT),0,rows().length-1)*LANE_HEIGHT+LANE_HEIGHT/2-8}px;width:12px;height:16px`;
      else if(y>=LANE_TOP)overlay.style.cssText=`left:${Math.min(x,lastX)}px;top:${Math.min(y,lastY)}px;width:${Math.abs(lastX-x)}px;height:${Math.abs(lastY-y)}px`;};
    const up=event=>{if(event.pointerId!==e.pointerId)return;cleanup();attempt(()=>{
      const t=now(),doubleClick=!moved&&lastPointerClick&&t-lastPointerClick.time<DOUBLE_CLICK_MS&&Math.hypot(e.clientX-lastPointerClick.x,e.clientY-lastPointerClick.y)<8;
      lastPointerClick=moved||doubleClick?null:{time:t,x:e.clientX,y:e.clientY};
      const laneList=rows();
      if(target){selectionKind='notes';selected=e.shiftKey?new Set(before):before.has(target.hit.id)?new Set(before):new Set();
        if(e.shiftKey&&before.has(target.hit.id)&&!moved)selected.delete(target.hit.id);else selected.add(target.hit.id);
        piece=target.hit.instrument;cursor=add(musicalStarts(score().timeline)[target.index],target.hit.offset);barRange=[target.index,target.index];
        if(doubleClick){selected=new Set([target.hit.id]);action('delete');return;}
        if(moved){const lane=laneList.indexOf(target.hit.instrument),laneDelta=clamp(Math.round((lastY-y)/LANE_HEIGHT),-lane,laneList.length-1-lane);const delta=subtract(positionFromX(lastX-(x-target.x)),add(musicalStarts(score().timeline)[target.index],target.hit.offset));moveLaneNotes(editor(),selected,delta,laneDelta,laneList);cursor=add(cursor,delta);piece=laneList[lane+laneDelta]||piece;changed();return;}
        tr.seek(toTime(score().timeline,number(cursor)));render();return;}
      if(moved&&y>=LANE_TOP){selectionKind='notes';selected=e.shiftKey?before:new Set();for(const t of lanesData.targets)if(t.right>=Math.min(x,lastX)&&t.x<=Math.max(x,lastX)&&t.y>=Math.min(y,lastY)&&t.y<=Math.max(y,lastY))selected.add(t.hit.id);render();return;}
      if(y<LANE_TOP&&e.shiftKey){selectionKind='bars';barRange=[Math.min(barRange[0],bar.index),Math.max(barRange[1],bar.index)];selected=new Set(score().bars.filter(b=>{const i=score().timeline.measures.findIndex(m=>m.id===b.measureId);return i>=barRange[0]&&i<=barRange[1];}).flatMap(b=>b.hits.map(h=>h.id)));tr.seek(toTime(score().timeline,number(origin)));render();return;}
      if(y>=LANE_TOP)piece=laneList[clamp(Math.floor((y-LANE_TOP)/LANE_HEIGHT),0,laneList.length-1)];
      navigate(origin,{seek:true});
      if(doubleClick&&y>=LANE_TOP)insert();
    });focus();};
    lanesHost.addEventListener('pointermove',move);lanesHost.addEventListener('pointerup',up);lanesHost.addEventListener('pointercancel',cancel);
  });
  // Ctrl/⌘ + wheel (a trackpad pinch) zooms the sheet; a plain wheel scrolls it.
  let zoomWheel=0;
  surface.addEventListener('wheel',e=>{if(!editor())return;if(layout!=='lanes'){if(!(e.ctrlKey||e.metaKey))return;e.preventDefault();zoomWheel+=e.deltaY;if(Math.abs(zoomWheel)>=ZOOM_WHEEL_PX){stepZoom(zoomWheel>0?-1:1);zoomWheel=0;}return;}e.preventDefault();const width=surface.clientWidth||800,{mode,delta}=interpretWheel(e,width,now());if(!delta)return;followPlayback=false;const v=getView(),span=v.end-v.start;if(mode==='pan')setView(v.start+delta/width*span,v.end+delta/width*span);else{const relative=clamp((e.clientX-surface.getBoundingClientRect().left)/width,0,1),center=v.start+relative*span,next=clamp(span*Math.exp(delta*.0015),.25,engine.duration);setView(center-relative*next,center+(1-relative)*next);}render();},{passive:false});

  // Clicks in the editor's own DOM and in the inspector slots (pads, toggles, the note list).
  const onClick=e=>{const el=e.target.closest?.('button');if(!el||el.disabled||!editor()||el.closest('.notation-surface .score-stage'))return;attempt(()=>{
    if(el.dataset.layout){editor().setLayout(el.dataset.layout);changed();}
    else if(el.dataset.kit)insert(el.dataset.kit,{preview:auditionPads});
    else if(el.dataset.auditionKit)auditionPiece(el.dataset.auditionKit);
    else if(el.dataset.hit){selectionKind='notes';selected=new Set([el.dataset.hit]);const bar=score().bars.find(b=>b.hits.some(h=>h.id===el.dataset.hit)),index=score().timeline.measures.findIndex(m=>m.id===bar.measureId),hit=bar.hits.find(h=>h.id===el.dataset.hit);cursor=add(musicalStarts(score().timeline)[index],hit.offset);barRange=[index,index];piece=hit.instrument;render();}
    else if(el.dataset.field==='audition'){auditionPads=!auditionPads;render();}
    else if(el.dataset.expression)toggleExpression(el.dataset.expression);
    else if(el.dataset.recorded)action('recorded-drums',el.dataset.recorded==='out');
    else if(el.dataset.action)action(el.dataset.action);
  });if(e.detail>0)queueMicrotask(focus);};
  const isTextField=el=>el.matches?.('textarea,input:not([type]),input[type=text],input[type=number],input[type=search]');
  const onChange=e=>{const el=e.target;attempt(()=>{
    if(el.dataset.expression)setExpression(el.dataset.expression,el.type==='range'||el.dataset.expression==='roll'?Number(el.value):el.value);
    const field=el.dataset.field;if(!field)return;
    if(field==='voice'){voice=el.value;if(selected.size&&voice!=='auto'){editor().change(selected,{voice:Number(voice)});changed();}else render();}
    if(field==='listen')action('listen',el.value);
    if(field==='level')action('level',Number(el.value));
  });if(!isTextField(el))queueMicrotask(focus);};
  const delegated=[host,...Object.values(slots.inspector||{})].filter(Boolean);
  for(const root of delegated){root.addEventListener('click',onClick);root.addEventListener('change',onChange);}

  function action(name,...args){if(!name||!editor())return;
    const a=active(),s=score(),positions=starts(s.timeline);
    switch(name){
      // entry
      case 'write':case 'add-note':insert();break;
      case 'piece':insert(args[0]);break;
      case 'pad':insert(args[0],{preview:auditionPads});break;
      case 'audition':auditionPiece(args[0]);break;
      case 'skip':navigate(add(cursor,step()));break;
      case 'cursor':{const dir=args[0]<0?-1:1,extend=!!args[1]?.extend;if(layout==='lanes'&&selected.size&&!extend)moveNotes(dir<0?negate(gridStep()):gridStep());else navigate(dir<0?subtract(cursor,navigationStep()):add(cursor,navigationStep()),{extend});break;}
      case 'piece-step':{const dir=args[0]<0?-1:1,list=layout==='lanes'?rows():KIT.map(item=>item.id);if(layout==='lanes'&&selected.size){moveLaneNotes(editor(),selected,fraction(0),dir,list);changed();break;}const i=list.indexOf(piece);piece=list[clamp(i+dir,0,list.length-1)];render();break;}
      case 'move':moveNotes(args[0]<0?negate(navigationStep()):navigationStep());break;
      case 'bar-start':navigate(a.startPosition);break;
      case 'bar-end':navigate(subtract(add(a.startPosition,a.measure.length),step()));break;
      case 'step':setStep(STEP_VALUE[args[0]]??stepValue,stepDotted,stepTuplet);break;
      case 'setStep':setStep(args[0]??stepValue,args[1]??stepDotted,args[2]??stepTuplet);break;
      case 'setTuplet':setStep(stepValue,stepDotted,Number(args[0])||1);break;
      case 'finer':setStep(Math.min(64,stepValue*2));break;
      case 'coarser':setStep(Math.max(4,stepValue/2));break;
      case 'dot':setStep(stepValue,!stepDotted,1);break;
      case 'tuplet-cycle':setStep(stepValue,false,stepTuplet===1?3:stepTuplet===3?5:stepTuplet===5?6:stepTuplet===6?7:1);break;
      case 'accent':toggleExpression('accent');break;
      case 'heavy':toggleExpression('heavy');break;
      case 'ghost':toggleExpression('ghost');break;
      case 'flam':toggleExpression('flam');break;
      case 'drag':toggleExpression('drag');break;
      // R or L: the same hand again clears the sticking.
      case 'sticking':{const hand=args[0]==='L'?'L':'R',held=selected.size?selectedHits()[0].sticking||'':expression.sticking;setExpression('sticking',held===hand?'':hand);break;}
      case 'setExpression':setExpression(args[0],args[1]);break;
      case 'setPiece':if(kitPiece(args[0])){piece=args[0];render();}break;
      case 'setVoice':voice=String(args[0]);if(selected.size&&voice!=='auto'){editor().change(selected,{voice:Number(voice)});changed();}else render();break;
      case 'setAudition':auditionPads=!!args[0];render();break;
      case 'undo':if(editor().undo()){selected.clear();changed();if(messageText)message('');}break;
      case 'redo':if(editor().redo()){selected.clear();changed();if(messageText)message('');}break;
      case 'delete':{const targets=deleteTargets(),n=targets.size,bars=selectionKind==='bars'&&n>1?rangeLabel():'';if(editor().remove(targets)){selected.clear();changed();if(bars)message(`Deleted ${count(n,'note')} from ${bars}. Undo brings them back.`);}break;}
      case 'copy':copy();break;
      case 'paste':return repeat(true);
      case 'repeat':return repeat();
      // ⌘A selects the bar; pressed again on that bar, the whole part.
      case 'select-bar':if(wholeBarArmed&&selectionKind==='bars'&&barRange[0]===a.index&&barRange[1]===a.index)return action('select-all');selectBars(a.index,a.index);wholeBarArmed=true;render();break;
      case 'select-all':{const total=s.timeline.measures.length;selectBars(0,total-1);wholeBarArmed=false;message(`All ${count(total,'bar')} selected · ${count(selected.size,'note')}.`);render();break;}
      case 'clear-part':return clearPart();
      case 'clear':cancelGesture();selected.clear();selectionKind='notes';wholeBarArmed=false;render();break;
      case 'move-dialog':return moveDialog();
      case 'tuplet-dialog':return tupletDialog();
      case 'review':editor().transact(d=>{for(let i=barRange[0];i<=barRange[1];i++)editor().bar(i,d).coverage='reviewed';});changed();break;
      // navigation and paging
      case 'previous':navigate(musicalStarts(s.timeline)[Math.max(0,a.index-1)]);break;
      case 'next':navigate(musicalStarts(s.timeline)[Math.min(positions.length-1,a.index+1)]);break;
      case 'goToBar':goToBar(args[0],args[1]);break;
      // [ and ]: the start of this section (or the one before, from a section's first bar) and the next section.
      case 'section-prev':{const list=sectionsOf(s.timeline),k=list.findLastIndex(sec=>sec.bar<=a.index),here=list[Math.max(0,k)];goToBar(a.index>here.bar||number(cursor)>number(a.startPosition)+1e-9?here.bar:list[Math.max(0,k-1)].bar,{seek:true});break;}
      case 'section-next':{const next=sectionsOf(s.timeline).find(sec=>sec.bar>a.index);if(next)goToBar(next.bar,{seek:true});break;}
      case 'fit':if(layout==='lanes'){fitBars(...barRange);render();}break;
      case 'follow':case 'setFollow':{const want=name==='setFollow'?!!args[0]:!followPlayback;if(want===followPlayback)break;followPlayback=want;followedLine=null;if(followPlayback){const current=locate(s.timeline,clamp(toQuarter(s.timeline,engine.getPosition()),0,extent(s.timeline)-1e-6)).index;if(layout==='lanes')fitBars(current,Math.min(current+3,positions.length-1));else reveal(current,{align:'follow',smooth:true});}render();break;}
      case 'zoom-in':stepZoom(1);break;
      case 'zoom-out':stepZoom(-1);break;
      case 'zoom-reset':setZoom(DEFAULT_ZOOM);break;
      case 'setZoom':setZoom(args[0]);break;
      // New line here: the bar under the cursor starts a line of the chart (saved with the part; the Stage draws it too).
      case 'line-break':{if(a.index===0){message('Bar 1 always starts a line.');break;}const on=!(s.lineBreaks??[]).includes(a.measure.id);editor().setLineBreak(a.measure.id,on);changed();message(on?`Bar ${a.index+1} starts a new line.`:`Bar ${a.index+1} no longer starts a new line.`);break;}
      case 'clear-line-breaks':if(editor().clearLineBreaks()){changed();message('Line breaks cleared. Undo brings them back.');}break;
      case 'loop':{const from=toTime(s.timeline,positions[barRange[0]]),to=toTime(s.timeline,positions[barRange[1]]+number(s.timeline.measures[barRange[1]].length));tr.setLoop({a:from,b:to,aBar:barRange[0],bBar:barRange[1]});message(`Looping ${rangeLabel().toLowerCase()}.`);break;}
      case 'align':openMap?.(a.startPosition,{edit:true,bar:a.index});break;
      case 'align-beat':openMap?.(cursor,{bar:a.index});break;
      // views and panels
      case 'view':case 'setLayoutView':{const next=args[0]==='lanes'?'lanes':'score';if(next===layout)break;layout=next;prefs.set('edit.chart.view',layout);if(layout==='lanes'){fitCursor();revealCursor();}else pendingReveal={index:a.index,align:'start'};render();break;}
      case 'part-layout':case 'setPartLayout':{const next=args[0]==='split'?'split':'combined';if((s.layout||'combined')!==next){editor().setLayout(next);changed();}break;}
      case 'all-lanes':allLanes=!allLanes;render();break;
      case 'list':showList=!showList;render();break;
      case 'setGrid':gridValue=GRIDS.includes(Number(args[0]))?Number(args[0]):gridValue;if(args[1]!==undefined)gridTuplet=args[1]?3:1;render();break;
      case 'setInspectorTab':if(INSPECTOR_TABS.includes(args[0])){inspectorTab=args[0];notify();}break;
      // listening and the mix
      case 'listen':case 'setListen':listening.setMode(args[0]);render();break;
      case 'level':case 'setLevel':listening.setLevel(clamp(Number(args[0])||0,0,1));notify();break;
      case 'play-cursor':{const t=toTime(s.timeline,number(cursor));void tr.playFrom(t);break;}
      case 'recorded-drums':case 'mute-drums':{if(!mixer.has()){message('This song does not have an isolated drum stem.');break;}const want=args.length?!!args[0]:!mixer.out();if(want!==mixer.out())mixer.toggle();message(mixer.out()?'Recorded drums out; the backing mix keeps playing.':'Recorded drums back in.');render();break;}
      case 'refresh':render();break;
      // the part
      case 'export':exportNative();break;
      case 'import':importNative();break;
      case 'drum-import':if(openDrumImport)return openDrumImport();message('Drum part import is not available here.');break;
      case 'print':printScore();break;
      case 'drum-keys':return keyboardSettings();
      case 'retry-save':return Promise.resolve(part.store?.persist()).then(()=>part.store?.flush()).catch(e=>message(e.data?.message||e.message));
      case 'resolve':return dialog({title:'Load saved version',submitLabel:'Export local edits & load saved',body:fragment('<p>Your current edits will be exported first so you can recover them. Then load the version saved on the server.</p>'),onSubmit:async()=>{exportNative();await part.reload();cursor=fraction(0);selected.clear();barRange=[0,0];pendingReveal={index:0,align:'start'};render();}});
      default:throw new Error(`Unknown chart action: ${name}`);
    }
    return undefined;
  }
  /** Lanes show the cursor's bar and the bars after it after a view change. */
  function fitCursor(){const index=active().index;fitBars(index,Math.min(index+LANE_BARS,score().timeline.measures.length)-1);}

  function state(){
    const s=score(),has=!!s;
    const total=has?s.timeline.measures.length:0,sections=has?sectionsOf(s.timeline):[];
    const a=has?active():null,hits=has?selectedHits():[],current=hits.length?hits[0]:expression,kit=kitPiece(piece);
    const recovery=status==='conflict'?'resolve':status==='offline'||status==='storage-error'?'retry':null;
    return {
      ready:has,layout,inspectorTab,
      step:{value:stepValue,dotted:stepDotted,tuplet:stepTuplet},grid:{value:gridValue,triplet:gridTuplet===3},
      piece:{id:piece,name:kit?.name??'Drums',short:kit?.short??'',key:kit?keyFor(kit):''},
      selectedCount:hits.length,deletable:has?deleteTargets().size:0,canClear:gesture||selected.size>0,empty:!has||s.bars.every(b=>!b.hits.length&&b.coverage==='unstarted'),
      total,cursorBar:a?a.index:0,sections,section:a?Math.max(0,sections.findLastIndex(sec=>sec.bar<=a.index)):0,
      zoom,canZoomIn:zoom<ZOOM_STEPS.at(-1)-1e-6,canZoomOut:zoom>ZOOM_STEPS[0]+1e-6,
      lineBreak:!!a&&(a.index===0||(s.lineBreaks??[]).includes(a.measure.id)),lineBreaks:has?(s.lineBreaks??[]).length:0,
      hint:has?hintText():'',selectionLabel:hits.length?`${count(hits.length,'note')} selected`:has&&barRange[0]!==barRange[1]?`${rangeLabel()} selected`:'',
      barLabel:has?rangeLabel():'',barRange:[...barRange],
      position:a?`Bar ${a.index+1} · Beat ${(1+a.offset*a.measure.denominator/4).toFixed(2)}`:'',
      canUndo:!!editor()?.undoStack?.length,canRedo:!!editor()?.redoStack?.length,
      status,statusText:statusText(status),recovery,message:messageText,
      listenMode:listening.mode(),listen:{mode:listening.mode(),level:has?listening.level():.65},recordedDrums:{available:has&&mixer.has(),out:has&&mixer.has()&&mixer.out()},
      audition:auditionPads,allLanes,showList,follow:followPlayback,playing:wasPlaying,
      partLayout:s?.layout||'combined',expression:{accent:!!current.accent,heavy:!!current.heavy,ghost:!!current.ghost,flam:!!current.flam,drag:!!current.drag,roll:current.roll||0,sticking:current.sticking||'',velocity:current.velocity??.75},voice,
    };
  }
  /** Edit ▾, Part ▾ and the section jump menu as Menu items (src/edit/chart/menus.js); sections run goToBar here. */
  function menus(){
    const s=score();
    const sections=s?sectionsOf(s.timeline).map(sec=>({...sec,label:sec.label||'Start'})):[];
    return {edit:editMenu(),part:partMenu(state()),sections:sectionsMenu(sections,(name,...args)=>attempt(()=>action(name,...args)))};
  }

  const resize=new ResizeObserver(()=>{if(editor()&&host.offsetWidth&&layout==='lanes')render();});resize.observe(host);
  const unsubscribe=part.subscribe(reason=>{if(disposed)return;if(reason?.type==='error'){message(reason.message);return;}if(!editor()){render();return;}if(reason==='shared'||reason==='reload'||reason==='import'){selected.clear();cursor=fraction(Math.round(clamp(number(cursor),0,extent(score().timeline)-.0001)*1e6),1e6);const index=active().index;barRange=[index,index];}ownAudio?.setScore?.(score());if(visible)render();});
  const unstatus=part.onStatus(next=>saveStatus(next));
  const scrollEl=scroller();
  if(scrollEl){scrollEl.addEventListener('scroll',onScroll,{passive:true});for(const type of ['wheel','touchmove','pointerdown'])scrollEl.addEventListener(type,onManualScroll,{passive:true});}
  if(editor()){const current=locate(score().timeline,toQuarter(score().timeline,engine.getPosition()));barRange=[current.index,current.index];cursor=current.startPosition;if(current.index>0)pendingReveal={index:current.index,align:'start'};
    // Feet default to the kit piece most used in the part.
    const used=new Map();for(const b of score().bars)for(const h of b.hits)used.set(h.instrument,(used.get(h.instrument)||0)+1);if(used.size&&!used.has(piece))piece=[...used].sort((a,b)=>b[1]-a[1])[0][0];}

  return {
    surface,
    run(id,...args){if(disposed)return undefined;return attempt(()=>action(id,...args));},
    state,
    subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    menus,
    focus,
    visibleBars,
    /** fn({first, last}|null) whenever the bars in the window change (a scroll, a zoom, an engraving). */
    onViewport(fn){viewportListeners.add(fn);return()=>viewportListeners.delete(fn);},
    /** A time on the song as bars from the start (bar index plus the fraction played of it). */
    where(time){const s=score();if(!s)return 0;const a=locate(s.timeline,clamp(toQuarter(s.timeline,Number(time)||0),0,extent(s.timeline)-1e-6));return a.index+clamp(a.offset/number(a.measure.length),0,1);},
    get scoreView(){return view;},
    flush:()=>part.flush(),
    notice:message,
    setVisible(next){visible=!!next;host.hidden=!visible;if(!visible){cancelGesture();}else{if(layout==='lanes'&&editor())revealCursor();render();}},
    tick(time){if(!editor()||!visible||disposed)return;const s=score(),q=toQuarter(s.timeline,time),playing=!!engine.playing;
      // Follow turns itself back on with every Play (maps/notation.md §12.2).
      if(playing!==wasPlaying){wasPlaying=playing;followedLine=null;if(playing)followPlayback=true;notify();}
      if(layout==='score'){view?.setPlayhead(playing||engine.paused?q:null);
        // Follow: when the playing bar moves onto another line, that line comes to the top part of the window.
        if(followPlayback&&playing&&view?.ready){const current=locate(s.timeline,clamp(q,0,extent(s.timeline)-1e-6)).index,b=view.barBounds(current);if(b&&b.y!==followedLine){followedLine=b.y;reveal(current,{align:'follow',smooth:true});}}
        return;}
      const v=getView();
      if(followPlayback&&playing&&(time<v.start||time>v.end)){const span=v.end-v.start;setView(time-.1*span,time+.9*span);}
      if(JSON.stringify(getView())!==lastView){render();return;}
      let head=lanesHost.querySelector('.notation-playhead');if(!head){head=document.createElement('div');head.className='notation-playhead';lanesHost.append(head);}
      head.hidden=!playing;if(playing&&lanesData){head.style.left=lanesData.qx(q)+'px';head.style.top='0px';head.style.height=lanesData.height+'px';}},
    get focused(){return surfaceFocused();},
    destroy(){if(disposed)return;disposed=true;cancelGesture();unsubscribe();unstatus();resize.disconnect();if(viewportFrame)cancelAnimationFrame(viewportFrame);viewportListeners.clear();if(scrollEl){scrollEl.removeEventListener('scroll',onScroll);for(const type of ['wheel','touchmove','pointerdown'])scrollEl.removeEventListener(type,onManualScroll);}for(const root of delegated){root.removeEventListener('click',onClick);root.removeEventListener('change',onChange);}listeners.clear();ownAudio?.destroy();view?.destroy();host.replaceChildren();host.classList.remove('notation-workspace','is-lanes','is-score');},
  };
}
