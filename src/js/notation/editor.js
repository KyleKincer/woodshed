// Transcribe workspace: write and correct the drum part against the
// recording. The score view is the engraved part (as the chart shows it); the
// lanes view is an event grid aligned with the recording. Hits store only their
// position; written rhythm is derived, so entry is "where", never "how long".
//
// Edit · Chart re-frame (architecture §2.15, spec §5.2, maps/notation.md §12):
// the internals (entry, selection, gestures, the save model, 16-bar pages and
// alphaTab rendering) are unchanged; the frame is gone. This module owns only
// the surface (score or lanes, focus scope `edit.chart.score`), the lane labels,
// the note list and the inspector panel bodies it renders into the frame's
// slots. src/edit/chart/chart-edit.js draws the toolbar, menus, inspector tabs,
// kit bank and save status from state() and drives everything through run().
// Keys are registry commands (src/edit/chart/commands.js) that call run();
// nothing here listens for keys.
//
//   createNotationWorkspace({host, slots: {inspector: {kit, properties, listen}, kitBank, status}, part, song,
//     engine, songMap, transport, mix, drumAudio, listen, viewport, openMap, openDrumImport, dialog, drumKeys})
//   → {run(id, ...args), state(), subscribe(fn) → off, menus(), setPaging(mode), focus(), setVisible(b),
//      tick(t), flush(), notice(text), destroy(), surface}
//
// Adapters (each optional; the defaults drive the engine directly, as 1.9 did):
//   transport  {playStop, pause, again, playFrom(t), seek(t), setLoop({a, b, aBar, bBar}), isPlaying()}
//              seek(t): stopped → move the cue; playing → seek without moving it
//   mix        {hasRecordedDrums(), recordedDrumsOut(), toggleRecordedDrums()}: the same state as the Mix sheet
//   drumAudio  the session's DrumAudio (an object or a getter); previews and audition play through it
//   listen     {mode(), setMode(m), level(), setLevel(x)}: Listen persists across postures (notation session)
//   viewport   {get() → {start, end}, set(start, end)}: the lanes' seconds window
//   openMap(q, {edit, bar})  Bar meter & label… / Align in tempo map… switch to Edit · Map at that bar
//   openDrumImport()         Part ▾ Drum part from file…
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
import {Dialog} from '../../ui/dialog.js';
import {drumKeyFor,drumKeyLabel,keyStringLetter,reservedScoreKeys,validateDrumKeys,STEP_VALUE} from '../../edit/chart/commands.js';
import {editMenu,partMenu,sectionsMenu} from '../../edit/chart/menus.js';
import '../../styles/views/notation/editor.css';

export const STEPS=Object.freeze([[4,'♩','Quarter','1/4'],[8,'♪','Eighth','1/8'],[16,'𝅘𝅥𝅯','Sixteenth','1/16'],[32,'1/32','32nd','1/32'],[64,'1/64','64th','1/64']]);
export const TUPLETS=Object.freeze([[1,'Straight'],[3,'Triplet'],[5,'Quintuplet'],[6,'Sextuplet'],[7,'Septuplet']]);
export const GRIDS=Object.freeze([4,8,16,32,64]);
export const FAMILIES=Object.freeze([['cymbal','Cymbals & hi-hat'],['drum','Drums'],['foot','Feet'],['aux','Other']]);
export const PAGE=16;
/** Paging modes this build supports (D48): 'scroll' joins with src/edit/chart/scroll-view.js (ED7). */
export const PAGING_MODES=Object.freeze(['pages']);
export const INSPECTOR_TABS=Object.freeze(['kit','properties','listen']);
/** Save status copy (maps/notation.md §8.8). */
export const STATUS_TEXT=Object.freeze({loading:'Opening part…',saved:'Saved',local:'Saved on this device',saving:'Saving…',offline:'Waiting for connection · edits kept here',conflict:'Another version exists · edits kept here','storage-error':'Device storage unavailable · export a backup','read-only':'Read-only shared part',fixture:'Local development fixture'});
/**
 * The score's label sizes in Edit · Chart (spec §8.1 desk minimums: 12 px anywhere, 14 px on coarse pointers). The
 * score view's defaults stay at the 1.9 sizes (11/15) for the geometry baseline, so the editor passes its floors.
 */
export const SCORE_FONTS=Object.freeze({fine:Object.freeze({barNumber:12,marker:15}),coarse:Object.freeze({barNumber:14,marker:15})});
const scoreFonts=()=>{let coarse=false;try{coarse=!!globalThis.matchMedia?.('(pointer: coarse)').matches;}catch{coarse=false;}return {...SCORE_FONTS[coarse?'coarse':'fine']};};
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

export async function createNotationWorkspace({host,slots={},part,song,engine,songMap=null,transport=null,mix=null,drumAudio=null,listen=null,viewport=null,openMap=null,openDrumImport=null,dialog=formDialog,drumKeys=null,prefs=appPrefs}) {
  const seq=++workspaceSeq,ids={help:`notation-help-${seq}`,cell:`notation-active-cell-${seq}`};
  let layout=prefs.get('edit.chart.view')==='lanes'?'lanes':'score',cursor=fraction(0),selected=new Set(),barRange=[0,0],piece='snare',stepValue=8,stepDotted=false,stepTuplet=1,voice='auto',clipboard=[],showList=false;
  let selectionKind='bars',noteClipboard=null,inspectorTab='kit',auditionPads=false,gridValue=16,gridTuplet=1,allLanes=false,page=0,followPlayback=true,paging='pages';
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
  function defaultView(){const s=score();if(!s)return {start:0,end:Math.max(1,engine.duration||8)};const positions=starts(s.timeline),last=Math.min(page+PAGE,s.timeline.measures.length)-1;return {start:toTime(s.timeline,positions[page]),end:toTime(s.timeline,positions[last]+number(s.timeline.measures[last].length))};}
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
  const selectedHits=()=>score().bars.flatMap(b=>b.hits).filter(h=>selected.has(h.id));
  const active=()=>locate(score().timeline,number(cursor));
  const step=()=>stepOf(stepValue,stepDotted,stepTuplet);
  const gridStep=()=>durationOf(gridValue,false,gridTuplet);
  const navigationStep=()=>layout==='lanes'?gridStep():step();
  const rows=()=>laneRows(score(),{piece,all:allLanes});
  const pageOf=index=>Math.floor(index/PAGE)*PAGE;
  const negate=f=>subtract(fraction(0),f);
  function rangeLabel(){return barRange[0]===barRange[1]?`Bar ${barRange[0]+1}`:`Bars ${barRange[0]+1}–${barRange[1]+1}`;}

  function navigate(q,{seek=false,extend=false}={}){
    const total=extent(score().timeline);
    cursor=number(q)>=0&&number(q)<total?q:fraction(Math.round(clamp(number(q),0,total-.0001)*1e6),1e6);
    selected.clear();selectionKind=extend?'bars':'notes';const a=active();barRange=extend?[Math.min(barRange[0],a.index),Math.max(barRange[1],a.index)]:[a.index,a.index];
    page=pageOf(a.index);
    if(seek)tr.seek(toTime(score().timeline,number(cursor)));
    followPlayback=false;
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
  function moveNotes(delta){if(!selected.size)return;if(layout==='lanes')moveLaneNotes(editor(),selected,delta,0,rows());else editor().move(selected,delta);cursor=add(cursor,delta);const index=active().index;barRange=[index,index];page=pageOf(index);changed();}
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
  function importNative(){const input=document.createElement('input');input.type='file';input.accept='.json,application/json';input.onchange=async()=>{try{const file=input.files[0];if(!file)return;if(file.size>8_000_000)throw new Error('The score file is too large.');const data=JSON.parse(await file.text());if(data.format!=='woodshed-notation')throw new Error('Choose a Woodshed notation export.');const imported=upgradeScore(data.score);validateScore(imported);await dialog({title:'Replace drum part',submitLabel:'Replace part',body:fragment(`<p>This replaces the current notation with ${xml(file.name)}. The audio stays in place. Undo restores your current part. Check alignment if this came from a different recording.</p>`),onSubmit:()=>{editor().transact(s=>Object.assign(s,imported));if(songMap){try{songMap.replaceFromTimeline(imported.timeline);}catch(error){editor().undo();message(error.message);return;}}cursor=fraction(0);selected.clear();barRange=[0,0];page=0;changed();}});}catch(e){message(e.message);}};input.click();}
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
  function goToBar(index){const s=score();navigate(musicalStarts(s.timeline)[clamp(Math.round(index),0,s.timeline.measures.length-1)]);}

  host.classList.add('notation-workspace');
  // The surface scrolls under Edit · Chart's sticky toolbar and (iPad portrait) its docked kit bank by design, so the
  // fixture's overlap check leaves it out (data-structure-allow).
  host.innerHTML=`<div class="notation-body"><div class="notation-lane-labels" role="group" aria-label="Kit pieces" hidden></div><div class="notation-surface" role="grid" data-scope="edit.chart.score" data-structure-allow="overlap" aria-label="Drum notation. Click to place the cursor, double-click to add, drum keys enter notes, Space plays." aria-describedby="${ids.help}" tabindex="0"><div class="notation-score"></div><div class="notation-lanes" hidden></div><div class="notation-sr-only" role="row"><span role="gridcell" id="${ids.cell}"></span></div></div></div>
    <p class="notation-help" id="${ids.help}"></p><div class="notation-note-list" role="group" aria-label="Note list" hidden></div><p class="notation-unavailable" hidden>This song has no drum part to edit.</p>`;
  const surface=host.querySelector('.notation-surface'),scoreHost=host.querySelector('.notation-score'),lanesHost=host.querySelector('.notation-lanes'),labelsHost=host.querySelector('.notation-lane-labels');
  surface.setAttribute('aria-activedescendant',ids.cell);

  // ---- inspector panels (rendered into the frame's slots) ---------------------------------------------------
  const kitPads=()=>FAMILIES.map(([f,label])=>`<div class="notation-pads" role="group" aria-label="${label}" data-family="${f}"><span class="notation-pad-family">${label}</span>${KIT.filter(k=>k.family===f).map(k=>`<button type="button" class="notation-pad" data-kit="${k.id}" data-family="${k.family}" ${pressed(piece===k.id)}><span>${xml(k.name)}</span>${keyCap(k)?`<kbd class="ui-kbd">${xml(keyCap(k))}</kbd>`:''}</button>`).join('')}</div>`).join('');
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
    host.querySelector('.notation-help').textContent=hits.length?`${hits.length} selected`:layout==='lanes'?'Double-click to add · Drag to move':'Double-click the staff or press a drum key to add';
    host.querySelector(`#${ids.cell}`).textContent=`Bar ${a.index+1}, beat ${(1+a.offset*a.measure.denominator/4).toFixed(2)}, ${kitPiece(piece)?.name||'Drums'}. ${hits.length?hits.map(describe).join('; '):'No note selected.'}`;
    const list=host.querySelector('.notation-note-list');list.hidden=!showList;
    if(showList){const first=layout==='score'?page:barRange[0],last=layout==='score'?Math.min(page+PAGE,s.timeline.measures.length)-1:barRange[1];const visibleBars=s.bars.filter(b=>{const i=s.timeline.measures.findIndex(m=>m.id===b.measureId);return i>=first&&i<=last;});list.innerHTML=visibleBars.flatMap(b=>b.hits.map(h=>`<button type="button" data-hit="${h.id}" ${pressed(selected.has(h.id))}>Bar ${s.timeline.measures.findIndex(m=>m.id===b.measureId)+1}, beat ${(1+number(h.offset)).toFixed(3)} · ${xml(describe(h))}</button>`)).join('')||'<p>No written notes in these bars.</p>';}
    else list.replaceChildren();
    renderInspector();
  }

  function caretLabel(){return kitPiece(piece)?.short||'';}
  function renderScore(){
    lanesHost.hidden=true;scoreHost.hidden=false;
    const s=score(),total=s.timeline.measures.length,last=Math.min(page+PAGE,total)-1;
    if(!view)view=createScoreView(scoreHost,{scale:1,fonts:scoreFonts(),onRender:()=>{view.setCaret({q:number(cursor),label:caretLabel()});view.setSelection(selected);view.setRange(barRange[0]!==barRange[1]?barRange:null);},onPointer:scorePointer});
    const key=`${page}:${s.layout||''}`;
    if(view.score!==s||renderedKey!==key){renderedKey=key;view.setScore(s,{range:[page,last]});}
    else{view.setCaret({q:number(cursor),label:caretLabel()});view.setSelection(selected);view.setRange(barRange[0]!==barRange[1]?barRange:null);}
  }
  function renderLanesView(){
    scoreHost.hidden=true;lanesHost.hidden=false;
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
  surface.addEventListener('wheel',e=>{if(layout!=='lanes'||!editor())return;e.preventDefault();const width=surface.clientWidth||800,{mode,delta}=interpretWheel(e,width,now());if(!delta)return;followPlayback=false;const v=getView(),span=v.end-v.start;if(mode==='pan')setView(v.start+delta/width*span,v.end+delta/width*span);else{const relative=clamp((e.clientX-surface.getBoundingClientRect().left)/width,0,1),center=v.start+relative*span,next=clamp(span*Math.exp(delta*.0015),.25,engine.duration);setView(center-relative*next,center+(1-relative)*next);}render();},{passive:false});

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
      case 'setExpression':setExpression(args[0],args[1]);break;
      case 'setPiece':if(kitPiece(args[0])){piece=args[0];render();}break;
      case 'setVoice':voice=String(args[0]);if(selected.size&&voice!=='auto'){editor().change(selected,{voice:Number(voice)});changed();}else render();break;
      case 'setAudition':auditionPads=!!args[0];render();break;
      case 'undo':if(editor().undo()){selected.clear();changed();}break;
      case 'redo':if(editor().redo()){selected.clear();changed();}break;
      case 'delete':if(editor().remove(selected)){selected.clear();changed();}break;
      case 'copy':copy();break;
      case 'paste':return repeat(true);
      case 'repeat':return repeat();
      case 'select-bar':selectionKind='bars';barRange=[a.index,a.index];selected=new Set((s.bars.find(b=>b.measureId===a.measure.id)?.hits||[]).map(h=>h.id));render();break;
      case 'clear':cancelGesture();selected.clear();render();break;
      case 'move-dialog':return moveDialog();
      case 'tuplet-dialog':return tupletDialog();
      case 'review':editor().transact(d=>{for(let i=barRange[0];i<=barRange[1];i++)editor().bar(i,d).coverage='reviewed';});changed();break;
      // navigation and paging
      case 'previous':navigate(musicalStarts(s.timeline)[Math.max(0,a.index-1)]);break;
      case 'next':navigate(musicalStarts(s.timeline)[Math.min(positions.length-1,a.index+1)]);break;
      case 'goToBar':goToBar(args[0]);break;
      case 'page-prev':page=Math.max(0,page-PAGE);if(layout==='lanes')fitPage();render();break;
      case 'page-next':page=Math.min(pageOf(positions.length-1),page+PAGE);if(layout==='lanes')fitPage();render();break;
      case 'goToPage':page=clamp(pageOf(Number(args[0])*PAGE),0,pageOf(positions.length-1));if(layout==='lanes')fitPage();render();break;
      case 'fit':if(layout==='lanes'){fitBars(...barRange);render();}break;
      case 'follow':{followPlayback=!followPlayback;if(followPlayback){const current=locate(s.timeline,toQuarter(s.timeline,engine.getPosition())).index;page=pageOf(current);if(layout==='lanes')fitBars(current,Math.min(current+3,positions.length-1));}render();break;}
      case 'loop':{const from=toTime(s.timeline,positions[barRange[0]]),to=toTime(s.timeline,positions[barRange[1]]+number(s.timeline.measures[barRange[1]].length));tr.setLoop({a:from,b:to,aBar:barRange[0],bBar:barRange[1]});message(`Looping ${rangeLabel().toLowerCase()}.`);break;}
      case 'align':openMap?.(a.startPosition,{edit:true,bar:a.index});break;
      case 'align-beat':openMap?.(cursor,{bar:a.index});break;
      // views and panels
      case 'view':case 'setLayoutView':{const next=args[0]==='lanes'?'lanes':'score';if(next===layout)break;layout=next;prefs.set('edit.chart.view',layout);if(layout==='lanes'){fitPage();revealCursor();}render();break;}
      case 'part-layout':case 'setPartLayout':{const next=args[0]==='split'?'split':'combined';if((s.layout||'combined')!==next){editor().setLayout(next);changed();}break;}
      case 'all-lanes':allLanes=!allLanes;render();break;
      case 'list':showList=!showList;render();break;
      case 'setGrid':gridValue=GRIDS.includes(Number(args[0]))?Number(args[0]):gridValue;if(args[1]!==undefined)gridTuplet=args[1]?3:1;render();break;
      case 'setInspectorTab':if(INSPECTOR_TABS.includes(args[0])){inspectorTab=args[0];notify();}break;
      case 'paging':setPaging(args[0]);prefs.set('edit.chart.paging',paging);break;
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
      case 'resolve':return dialog({title:'Load saved version',submitLabel:'Export local edits & load saved',body:fragment('<p>Your current edits will be exported first so you can recover them. Then load the version saved on the server.</p>'),onSubmit:async()=>{exportNative();await part.reload();cursor=fraction(0);selected.clear();barRange=[0,0];page=0;render();}});
      default:throw new Error(`Unknown chart action: ${name}`);
    }
    return undefined;
  }
  /** Lanes show the first 8 bars of the page after a page or view change. */
  function fitPage(){const last=Math.min(page+PAGE,score().timeline.measures.length)-1;fitBars(page,Math.max(page,Math.min(last,page+7)));}
  function setPaging(mode){if(!PAGING_MODES.includes(mode))throw new Error(`Paging "${mode}" is not available.`);paging=mode;notify();}

  function state(){
    const s=score(),has=!!s;
    const total=has?s.timeline.measures.length:0,last=has?Math.min(page+PAGE,total)-1:0;
    const a=has?active():null,hits=has?selectedHits():[],current=hits.length?hits[0]:expression,kit=kitPiece(piece);
    const recovery=status==='conflict'?'resolve':status==='offline'||status==='storage-error'?'retry':null;
    return {
      ready:has,layout,paging,pagingModes:[...PAGING_MODES],inspectorTab,
      step:{value:stepValue,dotted:stepDotted,tuplet:stepTuplet},grid:{value:gridValue,triplet:gridTuplet===3},
      piece:{id:piece,name:kit?.name??'Drums',short:kit?.short??'',key:kit?keyFor(kit):''},
      selectedCount:hits.length,canClear:gesture||selected.size>0,
      range:{first:page,last:Math.max(page,last),page:Math.floor(page/PAGE),pages:Math.max(1,Math.ceil(total/PAGE)),total},
      barLabel:has?rangeLabel():'',barRange:[...barRange],
      position:a?`Bar ${a.index+1} · Beat ${(1+a.offset*a.measure.denominator/4).toFixed(2)}`:'',
      canUndo:!!editor()?.undoStack?.length,canRedo:!!editor()?.redoStack?.length,
      status,statusText:statusText(status),recovery,message:messageText,
      listenMode:listening.mode(),listen:{mode:listening.mode(),level:has?listening.level():.65},recordedDrums:{available:has&&mixer.has(),out:has&&mixer.has()&&mixer.out()},
      audition:auditionPads,allLanes,showList,follow:followPlayback,
      partLayout:s?.layout||'combined',expression:{accent:!!current.accent,heavy:!!current.heavy,ghost:!!current.ghost,flam:!!current.flam,drag:!!current.drag,roll:current.roll||0,sticking:current.sticking||'',velocity:current.velocity??.75},voice,
    };
  }
  /** Edit ▾, Part ▾ and the section jump menu as Menu items (src/edit/chart/menus.js); sections run goToBar here. */
  function menus(){
    const s=score();
    const sections=s?s.timeline.measures.map((m,i)=>(i===0||m.label)?{id:`bar-${i}`,label:m.label||'Start',bar:i}:null).filter(Boolean):[];
    return {edit:editMenu(),part:partMenu(state()),sections:sectionsMenu(sections,(name,...args)=>attempt(()=>action(name,...args)))};
  }

  const resize=new ResizeObserver(()=>{if(editor()&&host.offsetWidth&&layout==='lanes')render();});resize.observe(host);
  const unsubscribe=part.subscribe(reason=>{if(disposed)return;if(reason?.type==='error'){message(reason.message);return;}if(!editor()){render();return;}if(reason==='shared'||reason==='reload'||reason==='import'){selected.clear();cursor=fraction(Math.round(clamp(number(cursor),0,extent(score().timeline)-.0001)*1e6),1e6);const index=active().index;barRange=[index,index];page=pageOf(index);}ownAudio?.setScore?.(score());if(visible)render();});
  const unstatus=part.onStatus(next=>saveStatus(next));
  if(editor()){const current=locate(score().timeline,toQuarter(score().timeline,engine.getPosition()));barRange=[current.index,current.index];cursor=current.startPosition;page=pageOf(current.index);
    // Feet default to the kit piece most used in the part.
    const used=new Map();for(const b of score().bars)for(const h of b.hits)used.set(h.instrument,(used.get(h.instrument)||0)+1);if(used.size&&!used.has(piece))piece=[...used].sort((a,b)=>b[1]-a[1])[0][0];}

  return {
    surface,
    run(id,...args){if(disposed)return undefined;return attempt(()=>action(id,...args));},
    state,
    subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    menus,
    setPaging,
    focus,
    flush:()=>part.flush(),
    notice:message,
    setVisible(next){visible=!!next;host.hidden=!visible;if(!visible){cancelGesture();}else{if(layout==='lanes'&&editor())revealCursor();render();}},
    tick(time){if(!editor()||!visible||disposed)return;const s=score(),q=toQuarter(s.timeline,time),playing=!!engine.playing;
      // Follow turns itself back on with every Play (maps/notation.md §12.2).
      if(playing&&!wasPlaying){followPlayback=true;}wasPlaying=playing;
      if(layout==='score'){if(followPlayback&&playing){const current=locate(s.timeline,q).index;if(current<page||current>=page+PAGE){page=pageOf(current);render();}}view?.setPlayhead(playing||engine.paused?q:null);return;}
      const v=getView();
      if(followPlayback&&playing&&(time<v.start||time>v.end)){const span=v.end-v.start;setView(time-.1*span,time+.9*span);}
      if(JSON.stringify(getView())!==lastView){render();return;}
      let head=lanesHost.querySelector('.notation-playhead');if(!head){head=document.createElement('div');head.className='notation-playhead';lanesHost.append(head);}
      head.hidden=!playing;if(playing&&lanesData){head.style.left=lanesData.qx(q)+'px';head.style.top='0px';head.style.height=lanesData.height+'px';}},
    get focused(){return surfaceFocused();},
    destroy(){if(disposed)return;disposed=true;cancelGesture();unsubscribe();unstatus();resize.disconnect();for(const root of delegated){root.removeEventListener('click',onClick);root.removeEventListener('change',onChange);}listeners.clear();ownAudio?.destroy();view?.destroy();host.replaceChildren();host.classList.remove('notation-workspace','is-lanes','is-score');},
  };
}
