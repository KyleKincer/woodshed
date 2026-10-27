// Transcribe workspace: write and correct the drum part against the
// recording. The score view is the engraved part (as the chart shows it); the
// lanes view is an event grid aligned with the waveform. Hits store only their
// position; written rhythm is derived, so entry is "where", never "how long".
import {KIT,kitPiece,id,fraction,number,add,subtract,compare,durationOf,starts,extent,locate,toTime,toQuarter,validateScore,upgradeScore,beatGroups,musicalStarts} from '../../../shared/notation.ts';
import {canWrite,rhythmCells} from '../../../shared/engrave.ts';
import {createScoreView} from './score-view.js';
import {renderLanes,laneRows,LANE_HEIGHT,LANE_TOP} from './lanes.js';
import {xml} from './html.js';
import {DrumAudio} from './audio.js';
import {focusModal} from '../modal-focus.js';
import {isPointerControl} from '../interactions.js';
import {wheelNavigation} from '../timeline-navigation.js';
import {snapPosition,moveLaneNotes} from './entry.js';
import './notation.css';

const btn=(action,label,title='')=>`<button type="button" data-action="${action}" title="${xml(title||label)}">${label}</button>`;
const steps=[[4,'♩','Quarter'],[8,'♪','Eighth'],[16,'𝅘𝅥𝅯','Sixteenth'],[32,'1/32','32nd'],[64,'1/64','64th']];
const tuplets=[[1,'Straight'],[3,'Triplet'],[5,'Quintuplet'],[6,'Sextuplet'],[7,'Septuplet']];
const families=[['cymbal','Cymbals & hi-hat'],['drum','Drums'],['foot','Feet'],['aux','Other']];
const PAGE=16;
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const download=(value,name,type='application/json')=>{const url=URL.createObjectURL(new Blob([value],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
/** Grid step for entry: a written value, dotted, or `tuplet` notes in the time of 2 (triplets) or 4. */
const stepOf=(value,dotted,tuplet)=>tuplet>1?fraction(4*(tuplet<4?2:4),value*tuplet):durationOf(value,dotted,1);
export function describe(hit){const k=kitPiece(hit.instrument);return `${k?.name||hit.instrument}${hit.heavy?', heavy accent':hit.accent?', accent':''}${hit.ghost?', ghost':''}${hit.drag?', drag':hit.flam?', flam':''}${hit.roll?`, roll (${hit.roll} slash${hit.roll>1?'es':''})`:''}${hit.sticking?`, ${hit.sticking} hand`:''}`;}
/** The piece written on a staff position, preferring the current piece when it shares the line. */
const pieceForLine=(line,current)=>{const at=KIT.filter(k=>k.line===line);if(!at.length)return null;return at.find(k=>k.id===current)?.id||at.find(k=>k.core)?.id||at[0].id;};

export async function createNotationWorkspace({host,part,song,engine,songMap=null,mapActive=()=>false,openMap=null,getView,setView,setFollow,play,readOnly=false,onLoopChange=()=>{},onMixerChange=()=>{},setLoop=null}) {
  let layout=localStorage.getItem?.('ws.notation.layout')==='lanes'?'lanes':'score',cursor=fraction(0),selected=new Set(),barRange=[0,0],piece='snare',stepValue=8,stepDotted=false,stepTuplet=1,voice='auto',clipboard=[],showList=false;
  let selectionKind='bars',noteClipboard=null,panel='',auditionPads=false,gridValue=16,gridTuplet=1,allLanes=false,page=0,followPlayback=true;
  let cancelGesture=()=>{},lastPointerClick=null,disposed=false,status=part.status;
  let expression={accent:false,heavy:false,ghost:false,flam:false,drag:false,roll:0,sticking:'',velocity:.75};
  let shortcuts={};try{shortcuts=JSON.parse(localStorage.getItem('ws.notation.keys')||'{}');}catch{}
  const interpretWheel=wheelNavigation();
  const keyFor=kit=>shortcuts[kit.id]??kit.key;
  let audio=null,view=null,renderedKey='',lastView='',lanesData=null;
  const editor=()=>part.editor;
  const score=()=>part.editor?.score;
  const focus=()=>{if(!document.querySelector('[role="dialog"]'))host.querySelector('.notation-surface')?.focus({preventScroll:true});};
  const message=text=>{const target=host.querySelector('.notation-message');if(target)target.textContent=text;};
  const statusText=state=>({loading:'Opening part…',saved:'Saved',local:'Saved on this device',saving:'Saving…',offline:'Waiting for connection · edits kept here',conflict:'Another version exists · edits kept here','storage-error':'Device storage unavailable · export a backup','read-only':'Read-only shared part',fixture:'Local development fixture'})[state]||state;
  const saveStatus=state=>{status=state;const el=host.querySelector('.notation-save');if(el)el.textContent=statusText(state);host.querySelector('[data-action="resolve"]')?.classList.toggle('hidden',state!=='conflict');host.querySelector('[data-action="retry-save"]')?.classList.toggle('hidden',!['offline','storage-error'].includes(state));};
  const ensureAudio=()=>audio??(audio=new DrumAudio(engine));
  const changed=()=>{if(!editor())return;const s=score();selected=new Set([...selected].filter(id=>s.bars.some(b=>b.hits.some(h=>h.id===id))));if(number(cursor)>=extent(s.timeline))cursor=fraction(Math.round((extent(s.timeline)-.0001)*1e6),1e6);barRange=barRange.map(i=>Math.min(i,s.timeline.measures.length-1));part.commit();};
  const attempt=fn=>{try{fn();}catch(error){message(error.message||String(error));}};
  const selectedHits=()=>score().bars.flatMap(b=>b.hits).filter(h=>selected.has(h.id));
  const active=()=>locate(score().timeline,number(cursor));
  const step=()=>stepOf(stepValue,stepDotted,stepTuplet);
  const gridStep=()=>durationOf(gridValue,false,gridTuplet);
  const navigationStep=()=>layout==='lanes'?gridStep():step();
  const rows=()=>laneRows(score(),{piece,all:allLanes});
  const pageOf=index=>Math.floor(index/PAGE)*PAGE;
  function rangeLabel(){return barRange[0]===barRange[1]?`Bar ${barRange[0]+1}`:`Bars ${barRange[0]+1}–${barRange[1]+1}`;}

  function navigate(q,{seek=false,extend=false}={}){
    const total=extent(score().timeline);
    cursor=number(q)>=0&&number(q)<total?q:fraction(Math.round(clamp(number(q),0,total-.0001)*1e6),1e6);
    selected.clear();selectionKind=extend?'bars':'notes';const a=active();barRange=extend?[Math.min(barRange[0],a.index),Math.max(barRange[1],a.index)]:[a.index,a.index];
    page=pageOf(a.index);
    if(seek)engine.seek(toTime(score().timeline,number(cursor)));
    setFollow(false);followPlayback=false;
    const time=toTime(score().timeline,number(cursor)),v=getView();
    if(layout==='lanes'&&(time<v.start||time>v.end)){const width=v.end-v.start;setView(time-.1*width,time+.9*width);}
    render();
  }
  function insert(instrument=piece,{preview=false}={}){
    const kit=kitPiece(instrument);if(!kit)return;piece=instrument;
    const a=active(),{heavy,drag,roll,...rest}=expression,hit={id:id(),instrument,offset:subtract(cursor,a.startPosition),voice:voice==='auto'?kit.voice:Number(voice),...rest,flam:expression.flam&&!drag,...(heavy?{heavy:true}:{}),...(drag?{drag:true}:{}),...(roll?{roll}:{})};
    if(readOnly||preview){ensureAudio().play(hit,engine.ctx.currentTime,true);message(`Preview · ${kit.name}`);render();return;}
    const bar=score().bars.find(b=>b.measureId===a.measure.id);
    if(!canWrite(bar,a.measure,hit,score().layout))throw new Error('A note cannot be written there. Choose a coarser step, or clear the tuplet on this beat.');
    selectionKind='notes';selected=new Set([editor().insert(a.index,hit)]);barRange=[a.index,a.index];changed();ensureAudio().play(selectedHits()[0]||hit,engine.ctx.currentTime,true);
  }
  /** Bring the cursor's bars into the waveform window used by the lanes. */
  function revealCursor(){const s=score(),t=toTime(s.timeline,number(cursor)),v=getView();if(t>=v.start&&t<=v.end)return;const index=active().index;fitBars(index,Math.min(index+3,s.timeline.measures.length-1));}
  function setStep(value=stepValue,dotted=stepDotted,tuplet=stepTuplet){stepValue=value;stepDotted=tuplet>1?false:dotted;stepTuplet=tuplet;
    // Keep the cursor on the new grid inside its beat.
    const a=active(),snapped=snapPosition(score(),number(cursor),step());if(compare(snapped,cursor)!==0&&locate(score().timeline,number(snapped)).index===a.index)cursor=snapped;render();}
  function setExpression(property,next){if(readOnly)return;if(selected.size){const patch={[property]:next};if(property==='drag'&&next)patch.flam=false;if(property==='flam'&&next)patch.drag=false;if(property==='heavy'&&next)patch.accent=true;editor().change(selected,patch);changed();}else{expression={...expression,[property]:next};if(property==='drag'&&next)expression.flam=false;if(property==='flam'&&next)expression.drag=false;render();}}
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
  function moveNotes(delta){if(readOnly||!selected.size)return;if(layout==='lanes')moveLaneNotes(editor(),selected,delta,0,rows());else editor().move(selected,delta);cursor=add(cursor,delta);const index=active().index;barRange=[index,index];page=pageOf(index);changed();}
  function moveDialog(){if(!selected.size){message('Select notes to move first.');return;}dialog('Move selected notes',`<p>Move ${selected.size} selected note${selected.size===1?'':'s'} by a musical offset. Positive values move later; negative values move earlier. Other notes stay in place.</p><label>Quarter notes <input name="delta" type="number" step="any" value="${number(step())}" required></label><p class="hint">You can also use Alt + ← / → to move by the current step.</p>`,data=>{const delta=Number(data.get('delta'));if(!Number.isFinite(delta))throw new Error('Enter a musical offset.');moveNotes(fraction(Math.round(delta*1e6),1e6));});}
  function dialog(title,body,onSubmit,label='Apply'){
    const modal=document.createElement('div');modal.className='modal notation-dialog';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-label',title);
    modal.innerHTML=`<form class="modal-card"><h2>${xml(title)}</h2>${body}<p class="notation-dialog-error" role="alert"></p><div class="modal-actions">${btn('cancel','Cancel')}<button class="btn-primary" type="submit">${xml(label)}</button></div></form>`;
    document.body.append(modal);const close=()=>{modal.remove();focus();};modal.querySelector('[data-action="cancel"]').onclick=close;focusModal(modal,close);
    modal.querySelector('form').onsubmit=async e=>{e.preventDefault();try{await onSubmit(new FormData(e.target));close();}catch(error){modal.querySelector('[role="alert"]').textContent=error.data?.message||error.message;}};return modal;
  }
  function fitBars(first,last){const positions=starts(score().timeline),t=score().timeline;setView(toTime(t,positions[first]),toTime(t,positions[last]+number(t.measures[last].length)));setFollow(false);}
  function repeat(paste=false){if(paste&&noteClipboard){editor().pasteHits(cursor,noteClipboard);changed();message('Notes pasted at the edit cursor.');return;}if(!paste)copy(true);if(!clipboard.length){message('Select and copy one or more bars first.');return;}
    dialog(paste?'Paste passage':'Repeat passage',`<p>${clipboard.length} bar${clipboard.length===1?'':'s'}.</p><div class="notation-form-grid"><label>Start at bar <input name="to" type="number" min="1" max="${score().timeline.measures.length}" value="${paste?barRange[0]+1:Math.min(barRange[1]+2,score().timeline.measures.length)}" required></label><label>Copies <input name="count" type="number" min="1" max="64" value="1" required></label></div><label class="notation-check"><input name="replace" type="checkbox"> Replace written notes in the destination</label>`,data=>{editor().paste(0,Number(data.get('to'))-1,Number(data.get('count')),data.has('replace'),clipboard);changed();},'Paste');
  }
  /** Explicit tuplet over the beat at the cursor, for rhythms the automatic grid can't infer. */
  function tupletDialog(){const a=active(),cells=rhythmCells(a.measure),cell=cells.find(c=>compare(c.start,a.offset===0?fraction(0):fraction(Math.round(a.offset*960),960))<=0&&compare(add(c.start,c.length),fraction(Math.round(a.offset*960),960))>0)||cells[0],beat=number(cell.length),bar=score().bars.find(b=>b.measureId===a.measure.id),existing=(bar?.tuplets||[]).find(t=>compare(t.start,cell.start)<=0&&compare(add(t.start,t.length),cell.start)>0);
    dialog(`Tuplet in bar ${a.index+1}`,`<p>Most tuplets are written automatically from where the notes fall. Set one here for rhythms that span beats, such as quarter-note triplets, or to keep a bracket on a beat with a single note.</p><div class="notation-form-grid"><label>Notes in the tuplet <select name="count">${[...new Set([0,2,3,4,5,6,7,9,...(existing?[existing.count]:[])])].sort((x,y)=>x-y).map(n=>`<option value="${n}" ${(existing?existing.count===n:n===3)?'selected':''}>${n?n:'Automatic (clear)'}</option>`).join('')}</select></label><label>Spanning <select name="span">${[[.5,'Half a beat'],[1,'One beat'],[2,'Two beats'],[4,'Four beats']].filter(([n])=>n*beat<=number(a.measure.length)+1e-9).map(([n,l])=>`<option value="${n}" ${(existing?Math.abs(number(existing.length)/beat-n)<1e-9:n===1)?'selected':''}>${l}</option>`).join('')}</select></label></div><p class="hint">Starts at beat ${cells.indexOf(cell)+1}. Notes already in the span must fall on the tuplet's grid.</p>`,data=>{const count=Number(data.get('count')),length=fraction(Math.round(Number(data.get('span'))*beat*960),960);if(compare(add(cell.start,length),a.measure.length)>0)throw new Error('The tuplet would run past the end of the bar.');editor().setTuplet(a.index,count?{start:cell.start,length,count}:null,cell.start,length);changed();});}
  function alignment(){const a=active(),m=a.measure,t=score().timeline,time=toTime(t,a.start);
    dialog(`Align bar ${a.index+1}`,`<p>Adjust meter and recording alignment.</p><div class="notation-form-grid"><label>Downbeat (seconds) <input name="time" type="number" min="0" max="${engine.duration}" step="any" value="${time}" required></label><label>Section label <input name="label" maxlength="120" value="${xml(m.label)}" placeholder="Verse, chorus, fill…"></label><label>Meter numerator <input name="n" type="number" min="1" max="16" value="${m.numerator}" required></label><label>Meter denominator <select name="d">${[2,4,8,16].map(d=>`<option value="${d}" ${d===m.denominator?'selected':''}>${d}</option>`).join('')}</select></label><label>Beat grouping <input name="grouping" value="${beatGroups(m).join('+')}" placeholder="3+3 or 2+2+3" required></label><label>Actual length (quarter notes) <input name="length" type="number" min=".0625" max="32" step=".0625" value="${number(m.length)}" required></label></div><p class="hint">Shorten the length for a pickup or partial bar. Notes must fit within the bar.</p>`,data=>{
      editor().transact(s=>{const measure=s.timeline.measures[a.index],length=fraction(Math.round(Number(data.get('length'))*16),16),delta=number(length)-number(measure.length),boundary=a.start+number(measure.length);measure.numerator=Number(data.get('n'));measure.denominator=Number(data.get('d'));measure.label=String(data.get('label')).trim();measure.length=length;measure.grouping=String(data.get('grouping')).split('+').map(n=>Number(n.trim()));
        s.timeline.anchors=s.timeline.anchors.filter(anchor=>Math.abs(number(anchor.position)-a.start)>1e-7).map(anchor=>number(anchor.position)>=boundary?{...anchor,position:add(anchor.position,fraction(Math.round(delta*16),16))}:anchor);
        s.timeline.anchors.push({position:a.startPosition,time:Number(data.get('time'))});s.timeline.anchors.sort((x,y)=>compare(x.position,y.position));
      });changed();
    });
  }
  function exportNative(){download(JSON.stringify({format:'woodshed-notation',version:2,song:{title:song.title,artist:song.artist,duration:engine.duration},score:score()},null,2),`${song.title.replace(/[^\p{L}\p{N} -]/gu,'_')}-drums.woodshed.json`);}
  function importNative(){const input=document.createElement('input');input.type='file';input.accept='.json';input.onchange=async()=>{try{const file=input.files[0];if(!file)return;if(file.size>8_000_000)throw new Error('The score file is too large.');const data=JSON.parse(await file.text());if(data.format!=='woodshed-notation')throw new Error('Choose a Woodshed notation export.');const imported=upgradeScore(data.score);validateScore(imported);dialog('Replace drum part',`<p>This replaces the current notation with ${xml(file.name)}. The audio stays in place. Undo restores your current part. Check alignment if this came from a different recording.</p>`,()=>{editor().transact(s=>Object.assign(s,imported));if(songMap){try{songMap.replaceFromTimeline(imported.timeline);}catch(error){editor().undo();message(error.message);return;}}cursor=fraction(0);selected.clear();barRange=[0,0];page=0;changed();},'Replace part');}catch(e){message(e.message);}};input.click();}
  function printScore(){
    const page=document.createElement('div');page.className='notation-print';page.innerHTML=`<h1>${xml(song.title)} — Drums</h1><div class="notation-print-score"></div>`;document.body.append(page);
    const printView=createScoreView(page.querySelector('.notation-print-score'),{print:true,barsPerRow:4,onRender:()=>{setTimeout(()=>{window.print();printView.destroy();page.remove();},50);}});
    printView.setScore(score());
  }
  function keyboardSettings(){dialog('Drum shortcuts',`<p>Drum keys enter notes at the cursor. 1–7 set the step; / cycles tuplet steps; arrows move the cursor; R skips a step; Space plays. Leave a field empty for no key.</p><div class="notation-form-grid">${KIT.map(k=>`<label>${xml(k.name)}<input name="${k.id}" value="${xml(keyFor(k))}" maxlength="1" pattern="[a-zA-Z]?"></label>`).join('')}</div>`,data=>{const next=Object.fromEntries(KIT.map(k=>[k.id,String(data.get(k.id)).toLowerCase()]));const keys=Object.values(next).filter(Boolean);if(new Set(keys).size!==keys.length||keys.some(k=>'nrag'.includes(k)))throw new Error('Each pad needs a unique letter. N, R, A and G are reserved for Write, Skip, Accent and Ghost.');shortcuts=next;try{localStorage.setItem('ws.notation.keys',JSON.stringify(next));}catch{}render();});}

  host.innerHTML=`<header class="notation-heading"></header><div class="notation-toolbar" aria-label="Note tools"></div><div class="notation-panel hidden"></div><div class="notation-empty notation-unshared" hidden><h2>No notation shared</h2></div>
    <div class="notation-body"><aside class="notation-sections"></aside><div class="notation-surface" role="grid" aria-label="Drum notation. Click to place the cursor, double-click to add, drum keys enter notes, Space plays." aria-describedby="notation-help" tabindex="0"><div class="notation-score"></div><div class="notation-lanes"></div><div class="notation-pagination"></div><div class="notation-sr-only" role="row"><span role="gridcell" id="notation-active-cell"></span></div></div></div>
    <div class="notation-note-list hidden" aria-label="Accessible note list"></div><footer class="notation-footer"></footer>`;
  const surface=host.querySelector('.notation-surface'),scoreHost=host.querySelector('.notation-score'),lanesHost=host.querySelector('.notation-lanes');
  surface.setAttribute('aria-activedescendant','notation-active-cell');

  function renderChrome(){
    const s=score(),a=active(),hits=selectedHits(),current=hits.length?hits[0]:expression;
    host.classList.toggle('is-lanes',layout==='lanes');host.classList.toggle('is-score',layout==='score');
    host.closest('.player')?.classList.toggle('notation-expanded',layout==='score');
    host.querySelector('.notation-heading').innerHTML=`<strong>Drums</strong><span class="notation-save" role="status"></span><div class="notation-views" aria-label="Notation view">${[['score','Score'],['lanes','Drum lanes']].map(([v,l])=>`<button type="button" data-view="${v}" aria-pressed="${layout===v}">${l}</button>`).join('')}</div><button type="button" data-action="panel-kit" aria-expanded="${panel==='kit'}">Kit</button><button type="button" data-action="panel-properties" aria-expanded="${panel==='properties'}">Properties</button><button type="button" data-action="panel-mixer" aria-expanded="${panel==='mixer'}">Listen</button><details class="notation-menu"><summary aria-label="Notation commands">•••</summary><div>${btn('copy','Copy')}${readOnly?'':btn('paste','Paste')+btn('repeat','Repeat bars…')+btn('move','Move notes…')+btn('tuplet','Tuplet on this beat…')+btn('review','Mark bars reviewed')+btn('align',songMap?'Bar meter & label…':'Bar properties…',songMap?'Edit this bar in the tempo map (Shift+M)':'')+btn('align-beat',songMap?'Align in tempo map…':'Align beat…',songMap?'Pin this position to the recording in the tempo map':'')}${btn('export','Export')}${btn('print','Print')}${readOnly?'':btn('import','Import…')}${btn('shortcuts','Keyboard shortcuts…')}${btn('list',showList?'Hide note list':'Note list')}${layout==='lanes'?btn('all-lanes',allLanes?'Show kit in use':'Show every kit piece'):''}</div></details>`;
    host.querySelector('.notation-toolbar').innerHTML=`<div class="notation-durations" role="group" aria-label="Cursor step">${steps.map(([v,symbol,label])=>`<button type="button" data-step="${v}" aria-pressed="${stepValue===v}" title="${label} step · ${7-Math.log2(v)}" aria-label="${label} step">${symbol}</button>`).join('')}<button type="button" data-action="dot" aria-pressed="${stepDotted}" title="Dotted step · ." ${stepTuplet>1?'disabled':''}>•</button></div><label>Tuplet <select data-field="tuplet">${tuplets.map(([v,l])=>`<option value="${v}" ${stepTuplet===v?'selected':''}>${l}</option>`).join('')}</select></label><div class="notation-layout" role="group" aria-label="Note layout">${[['combined','Together','One rhythm for the whole kit'],['split','Hands / feet','Hands stems up, feet stems down']].map(([v,l,t])=>`<button type="button" data-layout="${v}" aria-pressed="${(s.layout||'combined')===v}" title="${t}" ${readOnly?'disabled':''}>${l}</button>`).join('')}</div>${btn('skip','Skip','Move one step without writing · R')}${btn('undo','↶','Undo · ⌘/Ctrl Z')}${btn('redo','↷','Redo · ⌘/Ctrl Shift Z')}
      <div class="notation-navigation"><span class="notation-range">${rangeLabel()}</span>${btn('previous','←','Previous bar')}${btn('next','→','Next bar')}${layout==='lanes'?btn('fit','Fit'):''}${btn('loop','Loop','Loop the selected bars')}<button type="button" data-action="follow" aria-pressed="${followPlayback}">Follow</button></div>`;
    const panelHost=host.querySelector('.notation-panel');panelHost.classList.toggle('hidden',!panel);
    panelHost.innerHTML=panel==='kit'?`<div class="notation-panel-title"><strong>Drum kit</strong><label><input type="checkbox" data-field="audition" ${auditionPads?'checked':''}> Audition only</label></div>${families.map(([f,label])=>`<div class="notation-pads" role="group" aria-label="${label}"><span class="notation-pad-family">${label}</span>${KIT.filter(k=>k.family===f).map(k=>`<button type="button" data-kit="${k.id}" aria-pressed="${piece===k.id}"><span>${xml(k.name)}</span>${keyFor(k)?`<kbd>${xml(keyFor(k).toUpperCase())}</kbd>`:''}</button>`).join('')}</div>`).join('')}`
      :panel==='properties'?`<div class="notation-inspector"><strong>${hits.length?`${hits.length} selected`:'Next note'}</strong>${[['accent','Accent'],['heavy','Heavy accent'],['ghost','Ghost'],['flam','Flam'],['drag','Drag']].map(([p,l])=>`<label><input type="checkbox" data-expression="${p}" ${current[p]?'checked':''} ${readOnly?'disabled':''}>${l}</label>`).join('')}<label>Roll <select data-expression="roll" ${readOnly?'disabled':''}>${[[0,'None'],[1,'1 slash'],[2,'2 slashes'],[3,'3 slashes']].map(([v,l])=>`<option value="${v}" ${(current.roll||0)===v?'selected':''}>${l}</option>`).join('')}</select></label><label>Sticking <select data-expression="sticking" ${readOnly?'disabled':''}><option value="">—</option><option ${current.sticking==='L'?'selected':''}>L</option><option ${current.sticking==='R'?'selected':''}>R</option></select></label><label>Velocity <input data-expression="velocity" type="range" min=".05" max="1" step=".05" value="${current.velocity}" ${readOnly?'disabled':''}></label><label>Voice <select data-field="voice" ${readOnly?'disabled':''}>${[['auto','Auto'],['1','1 · Hands'],['2','2 · Feet']].map(([v,l])=>`<option value="${v}" ${String(hits.length?current.voice:voice)===v?'selected':''}>${l}</option>`).join('')}</select></label>${btn('delete','Delete')}</div>`
      :panel==='mixer'?`<div class="notation-audition"><label>Listen to <select data-field="listen">${[['recording','Recording'],['notation','Notation'],['both','Both']].map(([v,l])=>`<option value="${v}" ${(audio?.mode||'recording')===v?'selected':''}>${l}</option>`).join('')}</select></label><label>Notation level <input data-field="level" type="range" min="0" max="1" step=".05" value="${audio?.out.gain.value??.65}"></label>${btn('mute-drums','Mute recorded drums')}${btn('play-cursor','Play from cursor')}</div>`:'';
    const sections=s.timeline.measures.map((m,i)=>(i===0||m.label)?`<button type="button" data-bar="${i}"><span>${xml(m.label||'Start')}</span><small>Bar ${i+1}</small></button>`:'').join('');
    host.querySelector('.notation-sections').innerHTML=layout==='lanes'?`<div class="notation-lane-labels" style="padding-top:${LANE_TOP}px">${rows().map(idName=>{const k=kitPiece(idName);return `<button type="button" data-audition-kit="${k.id}" title="Audition ${xml(k.name)}" aria-pressed="${piece===k.id}" style="height:${LANE_HEIGHT}px">${xml(k.short)}${keyFor(k)?`<kbd>${xml(keyFor(k).toUpperCase())}</kbd>`:''}</button>`;}).join('')}</div>`:`<div class="notation-piece"><small>Writing</small><strong>${xml(kitPiece(piece)?.name||'Drums')}</strong>${keyFor(kitPiece(piece))?`<kbd>${xml(keyFor(kitPiece(piece)).toUpperCase())}</kbd>`:''}${readOnly?'':btn('add-note','Add note','Write at the cursor · N')}</div><h3>Sections</h3>${sections}`;
    host.querySelector('.notation-footer').innerHTML=`<span id="notation-help">${hits.length?`${hits.length} selected`:layout==='lanes'?'Double-click to add · Drag to move':'Double-click the staff or press a drum key to add'}</span><span class="notation-message" role="status"></span><span class="notation-position">Bar ${a.index+1} · Beat ${(1+a.offset*a.measure.denominator/4).toFixed(2)}</span>${layout==='lanes'?`<label>Grid <select data-field="grid">${[4,8,16,32,64].map(v=>`<option value="${v}" ${gridValue===v?'selected':''}>1/${v}</option>`).join('')}</select></label><label><input type="checkbox" data-field="grid-triplet" ${gridTuplet===3?'checked':''}>Triplet</label>`:''}${btn('retry-save','Retry saving')}${btn('resolve','Review saved version')}`;
    if(readOnly)host.querySelectorAll('[data-action="skip"],[data-action="undo"],[data-action="redo"],[data-action="delete"],[data-action="add-note"]').forEach(e=>e.disabled=true);
    saveStatus(readOnly?'read-only':status);
    host.querySelector('#notation-active-cell').textContent=`Bar ${a.index+1}, beat ${(1+a.offset*a.measure.denominator/4).toFixed(2)}, ${kitPiece(piece)?.name||'Drums'}. ${hits.length?hits.map(describe).join('; '):'No note selected.'}`;
    const list=host.querySelector('.notation-note-list');list.classList.toggle('hidden',!showList);
    if(showList){const first=layout==='score'?page:barRange[0],last=layout==='score'?Math.min(page+PAGE,s.timeline.measures.length)-1:barRange[1];const visible=s.bars.filter(b=>{const i=s.timeline.measures.findIndex(m=>m.id===b.measureId);return i>=first&&i<=last;});list.innerHTML=visible.flatMap(b=>b.hits.map(h=>`<button type="button" data-hit="${h.id}">Bar ${s.timeline.measures.findIndex(m=>m.id===b.measureId)+1}, beat ${(1+number(h.offset)).toFixed(3)} · ${xml(describe(h))}</button>`)).join('')||'<p>No written notes in these bars.</p>';}
  }

  function caretLabel(){return kitPiece(piece)?.short||'';}
  function renderScore(){
    lanesHost.hidden=true;scoreHost.hidden=false;
    const s=score(),total=s.timeline.measures.length,last=Math.min(page+PAGE,total)-1;
    if(!view)view=createScoreView(scoreHost,{scale:1,onRender:()=>{view.setCaret({q:number(cursor),label:caretLabel()});view.setSelection(selected);view.setRange(barRange[0]!==barRange[1]?barRange:null);},onPointer:scorePointer});
    const key=`${page}:${s.layout||''}`;
    if(view.score!==s||renderedKey!==key){renderedKey=key;view.setScore(s,{range:[page,last]});}
    else{view.setCaret({q:number(cursor),label:caretLabel()});view.setSelection(selected);view.setRange(barRange[0]!==barRange[1]?barRange:null);}
    host.querySelector('.notation-pagination').innerHTML=total>PAGE?`${btn('page-prev','Previous bars')}<span>Bars ${page+1}–${last+1} of ${total}</span>${btn('page-next','Next bars')}`:'';
  }
  function renderLanesView(){
    scoreHost.hidden=true;lanesHost.hidden=false;host.querySelector('.notation-pagination').innerHTML='';
    const s=score(),width=Math.max(240,surface.clientWidth||800),positions=starts(s.timeline),v=getView();
    let indices=s.timeline.measures.map((m,i)=>i).filter(i=>toTime(s.timeline,positions[i]+number(s.timeline.measures[i].length))>v.start+1e-8&&toTime(s.timeline,positions[i])<v.end-1e-8);
    if(!indices.length)indices=[active().index];
    lanesData={...renderLanes(lanesHost,{score:s,indices,width,timeRange:v,selected,cursor:number(cursor),grid:number(gridStep()),rows:rows()}),width};
    lastView=JSON.stringify(v);
  }
  function render(){if(disposed)return;
    // A shared song may gain or lose notation while open; keep the workspace intact.
    for(const el of host.querySelectorAll('.notation-toolbar,.notation-body,.notation-footer,.notation-note-list'))el.hidden=!editor();
    host.querySelector('.notation-unshared').hidden=!!editor();
    if(!editor())return;
    const focused=document.activeElement,hadFocus=surface===focused,focusAttribute=host.contains(focused)&&focused!==surface?[...focused.attributes].find(a=>a.name.startsWith('data-')):null;
    renderChrome();
    if(layout==='score')renderScore();else renderLanesView();
    if(hadFocus)focus();else if(focusAttribute)host.querySelector(`[${focusAttribute.name}="${CSS.escape(focusAttribute.value)}"]`)?.focus({preventScroll:true});
  }

  // Score pointer: click places the cursor (snapped to the step) or selects a
  // note; double-click writes the piece on that staff line; drag selects.
  function scorePointer({kind,event,at}){
    // A touch scroll cancels the gesture; never let its pointerup land later.
    if(kind==='cancel'){cancelGesture();return;}
    if(kind==='down'){if(event.button!==0||at.index==null)return;cancelGesture();followPlayback=false;setFollow(false);
      const start={x:event.clientX,y:event.clientY,at,before:new Set(selected)};let moved=false,box=null;
      const stage=view.stage,rect=stage.getBoundingClientRect();
      const move=e=>{moved||=Math.hypot(e.clientX-start.x,e.clientY-start.y)>5;if(!moved)return;box??=Object.assign(document.createElement('div'),{className:'notation-drag-preview'});stage.append(box);const x0=Math.min(start.x,e.clientX)-rect.left,y0=Math.min(start.y,e.clientY)-rect.top;box.style.cssText=`left:${x0}px;top:${y0}px;width:${Math.abs(e.clientX-start.x)}px;height:${Math.abs(e.clientY-start.y)}px`;};
      const up=e=>{cleanup();attempt(()=>{
        const doubleClick=!moved&&lastPointerClick&&performance.now()-lastPointerClick.time<400&&Math.hypot(e.clientX-lastPointerClick.x,e.clientY-lastPointerClick.y)<8;
        lastPointerClick=moved||doubleClick?null:{time:performance.now(),x:e.clientX,y:e.clientY};
        if(moved){const x0=Math.min(start.x,e.clientX)-rect.left,x1=Math.max(start.x,e.clientX)-rect.left,y0=Math.min(start.y,e.clientY)-rect.top,y1=Math.max(start.y,e.clientY)-rect.top;selectionKind='notes';selected=e.shiftKey?start.before:new Set();for(const n of view.noteBoxes())if(n.x+n.w>=x0&&n.x<=x1&&n.y+n.h>=y0&&n.y<=y1)selected.add(n.hit.id);render();return;}
        if(at.hit){selectionKind='notes';const hitBar=score().bars.find(b=>b.hits.some(h=>h.id===at.hit.id)),index=score().timeline.measures.findIndex(m=>m.id===hitBar.measureId);
          selected=e.shiftKey?new Set(start.before):new Set();if(e.shiftKey&&start.before.has(at.hit.id))selected.delete(at.hit.id);else selected.add(at.hit.id);
          piece=at.hit.instrument;cursor=add(musicalStarts(score().timeline)[index],at.hit.offset);barRange=[index,index];
          if(doubleClick){panel='properties';}
          if(!engine.playing)engine.seek(toTime(score().timeline,number(cursor)));render();return;}
        const q=snapPosition(score(),at.q,step());
        if(doubleClick&&!readOnly){const line=Math.round((at.y-at.lineTop)/(at.lineHeight/8)),chosen=pieceForLine(line,piece);if(chosen)piece=chosen;cursor=q;insert();return;}
        navigate(q,{seek:!engine.playing});
      });focus();};
      const cleanup=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);box?.remove();cancelGesture=()=>{};};
      const cancel=()=>cancelGesture();
      cancelGesture=()=>{cleanup();render();};
      window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',cancel);
    }
  }

  // Lanes pointer: time-aligned grid; drag notes in time or across lanes.
  lanesHost.addEventListener('pointerdown',e=>{
    if(e.button!==0||!lanesData)return;e.preventDefault();cancelGesture();followPlayback=false;setFollow(false);
    const rect=lanesHost.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top,width=lanesData.width,v=getView(),bar=lanesData.bars.find(b=>x>=b.left&&x<b.right);if(!bar)return;
    const targetAt=(px,py)=>lanesData.targets.filter(t=>px>=t.x-3&&px<=t.right+3&&Math.abs(t.y-py)<12).sort((a,b)=>Math.abs(a.x-px)-Math.abs(b.x-px))[0];
    const target=y>=LANE_TOP?targetAt(x,y):null,positionFromX=px=>snapPosition(score(),toQuarter(score().timeline,v.start+px/width*(v.end-v.start)),gridStep());
    const origin=y<LANE_TOP?fraction(Math.round(clamp(toQuarter(score().timeline,v.start+x/width*(v.end-v.start)),0,extent(score().timeline)-1e-6)*1e6),1e6):positionFromX(x),before=new Set(selected);
    let moved=false,lastX=x,lastY=y;const overlay=document.createElement('div');overlay.className='notation-drag-preview';lanesHost.append(overlay);lanesHost.setPointerCapture?.(e.pointerId);
    const cleanup=()=>{lanesHost.removeEventListener('pointermove',move);lanesHost.removeEventListener('pointerup',up);lanesHost.removeEventListener('pointercancel',cancel);overlay.remove();try{lanesHost.releasePointerCapture?.(e.pointerId);}catch{}cancelGesture=()=>{};};
    const cancel=()=>{cleanup();render();focus();};cancelGesture=cancel;
    const move=event=>{if(event.pointerId!==e.pointerId)return;lastX=clamp(event.clientX-rect.left,0,width-1);lastY=event.clientY-rect.top;moved||=Math.hypot(lastX-x,lastY-y)>4;if(!moved)return;
      if(target&&!readOnly)overlay.style.cssText=`left:${lastX-(x-target.x)}px;top:${LANE_TOP+clamp(Math.round((lastY-LANE_TOP-LANE_HEIGHT/2)/LANE_HEIGHT),0,rows().length-1)*LANE_HEIGHT+LANE_HEIGHT/2-8}px;width:12px;height:16px`;
      else if(!target&&y>=LANE_TOP)overlay.style.cssText=`left:${Math.min(x,lastX)}px;top:${Math.min(y,lastY)}px;width:${Math.abs(lastX-x)}px;height:${Math.abs(lastY-y)}px`;};
    const up=event=>{if(event.pointerId!==e.pointerId)return;cleanup();attempt(()=>{
      const doubleClick=!moved&&lastPointerClick&&performance.now()-lastPointerClick.time<400&&Math.hypot(e.clientX-lastPointerClick.x,e.clientY-lastPointerClick.y)<8;
      lastPointerClick=moved||doubleClick?null:{time:performance.now(),x:e.clientX,y:e.clientY};
      const laneList=rows();
      if(target){selectionKind='notes';selected=e.shiftKey?new Set(before):before.has(target.hit.id)?new Set(before):new Set();
        if(e.shiftKey&&before.has(target.hit.id)&&!moved)selected.delete(target.hit.id);else selected.add(target.hit.id);
        piece=target.hit.instrument;cursor=add(musicalStarts(score().timeline)[target.index],target.hit.offset);barRange=[target.index,target.index];
        if(doubleClick&&!readOnly){selected=new Set([target.hit.id]);action('delete');return;}
        if(moved&&!readOnly){const lane=laneList.indexOf(target.hit.instrument),laneDelta=clamp(Math.round((lastY-y)/LANE_HEIGHT),-lane,laneList.length-1-lane);const delta=subtract(positionFromX(lastX-(x-target.x)),add(musicalStarts(score().timeline)[target.index],target.hit.offset));moveLaneNotes(editor(),selected,delta,laneDelta,laneList);cursor=add(cursor,delta);piece=laneList[lane+laneDelta]||piece;changed();return;}
        engine.seek(toTime(score().timeline,number(cursor)));render();return;}
      if(moved&&y>=LANE_TOP){selectionKind='notes';selected=e.shiftKey?before:new Set();for(const t of lanesData.targets)if(t.right>=Math.min(x,lastX)&&t.x<=Math.max(x,lastX)&&t.y>=Math.min(y,lastY)&&t.y<=Math.max(y,lastY))selected.add(t.hit.id);render();return;}
      if(y<LANE_TOP&&e.shiftKey){selectionKind='bars';barRange=[Math.min(barRange[0],bar.index),Math.max(barRange[1],bar.index)];selected=new Set(score().bars.filter(b=>{const i=score().timeline.measures.findIndex(m=>m.id===b.measureId);return i>=barRange[0]&&i<=barRange[1];}).flatMap(b=>b.hits.map(h=>h.id)));engine.seek(toTime(score().timeline,number(origin)));render();return;}
      if(y>=LANE_TOP)piece=laneList[clamp(Math.floor((y-LANE_TOP)/LANE_HEIGHT),0,laneList.length-1)];
      navigate(origin,{seek:true});
      if(doubleClick&&y>=LANE_TOP&&!readOnly)insert();
    });focus();};
    lanesHost.addEventListener('pointermove',move);lanesHost.addEventListener('pointerup',up);lanesHost.addEventListener('pointercancel',cancel);
  });
  surface.addEventListener('wheel',e=>{if(layout!=='lanes')return;e.preventDefault();const width=surface.clientWidth||800,{mode,delta}=interpretWheel(e,width);if(!delta)return;followPlayback=false;setFollow(false);const v=getView(),span=v.end-v.start;if(mode==='pan')setView(v.start+delta/width*span,v.end+delta/width*span);else{const relative=clamp((e.clientX-surface.getBoundingClientRect().left)/width,0,1),center=v.start+relative*span,next=clamp(span*Math.exp(delta*.0015),.25,engine.duration);setView(center-relative*next,center+(1-relative)*next);}render();},{passive:false});
  surface.addEventListener('keydown',e=>onKey(e));

  host.addEventListener('click',e=>{const el=e.target.closest('button');if(!el||!host.contains(el)||el.closest('.notation-surface .score-stage'))return;attempt(()=>{
    if(el.dataset.view){layout=el.dataset.view;try{localStorage.setItem('ws.notation.layout',layout);}catch{}if(layout==='lanes')revealCursor();render();}
    else if(el.dataset.step)setStep(Number(el.dataset.step),stepDotted,stepTuplet);
    else if(el.dataset.layout){if(!readOnly){editor().setLayout(el.dataset.layout);changed();}}
    else if(el.dataset.kit)insert(el.dataset.kit,{preview:auditionPads});
    else if(el.dataset.auditionKit){const kit=kitPiece(el.dataset.auditionKit);piece=kit.id;ensureAudio().play({instrument:kit.id,velocity:.75},engine.ctx.currentTime,true);render();}
    else if(el.dataset.bar)navigate(musicalStarts(score().timeline)[Number(el.dataset.bar)]);
    else if(el.dataset.hit){selectionKind='notes';selected=new Set([el.dataset.hit]);const bar=score().bars.find(b=>b.hits.some(h=>h.id===el.dataset.hit)),index=score().timeline.measures.findIndex(m=>m.id===bar.measureId),hit=bar.hits.find(h=>h.id===el.dataset.hit);cursor=add(musicalStarts(score().timeline)[index],hit.offset);barRange=[index,index];piece=hit.instrument;render();}
    else action(el.dataset.action);
  });if(e.detail>0)queueMicrotask(focus);});
  host.addEventListener('change',e=>{const el=e.target;const pointer=isPointerControl(el);attempt(()=>{
    if(el.dataset.expression)setExpression(el.dataset.expression,el.type==='checkbox'?el.checked:el.type==='range'||el.dataset.expression==='roll'?Number(el.value):el.value);
    const field=el.dataset.field;if(!field)return;
    if(field==='grid'){gridValue=Number(el.value);render();}
    if(field==='grid-triplet'){gridTuplet=el.checked?3:1;render();}
    if(field==='audition'){auditionPads=el.checked;render();}
    if(field==='tuplet')setStep(stepValue,stepDotted,Number(el.value));
    if(field==='voice'){voice=el.value;if(selected.size&&voice!=='auto'&&!readOnly){editor().change(selected,{voice:Number(voice)});changed();}else render();}
    if(field==='listen'){const player=ensureAudio();player.setScore(score());player.setMode(el.value);}
    if(field==='level')ensureAudio().out.gain.setTargetAtTime(Number(el.value),engine.ctx.currentTime,.015);
  });if(pointer)queueMicrotask(focus);});

  function action(name){if(!name||!editor())return;if(readOnly&&['undo','redo','skip','delete','paste','repeat','move','review','align','align-beat','import','tuplet','add-note'].includes(name))return;
    const a=active(),s=score(),positions=starts(s.timeline);
    switch(name){
      case 'panel-kit':case 'panel-properties':case 'panel-mixer':panel=panel===name.slice(6)?'':name.slice(6);render();break;
      case 'all-lanes':allLanes=!allLanes;render();break;
      case 'add-note':insert();break;
      case 'dot':setStep(stepValue,!stepDotted,stepTuplet);break;
      case 'skip':navigate(add(cursor,step()));break;
      case 'undo':if(editor().undo()){selected.clear();changed();}break;
      case 'redo':if(editor().redo()){selected.clear();changed();}break;
      case 'delete':if(editor().remove(selected)){selected.clear();changed();}break;
      case 'copy':copy();break;
      case 'paste':repeat(true);break;
      case 'repeat':repeat();break;
      case 'move':moveDialog();break;
      case 'tuplet':tupletDialog();break;
      case 'review':editor().transact(d=>{for(let i=barRange[0];i<=barRange[1];i++)editor().bar(i,d).coverage='reviewed';});changed();break;
      case 'previous':navigate(musicalStarts(s.timeline)[Math.max(0,a.index-1)]);break;
      case 'next':navigate(musicalStarts(s.timeline)[Math.min(positions.length-1,a.index+1)]);break;
      case 'fit':fitBars(...barRange);render();break;
      case 'follow':{followPlayback=!followPlayback;setFollow(followPlayback);if(followPlayback){const current=locate(s.timeline,toQuarter(s.timeline,engine.getPosition())).index;page=pageOf(current);if(layout==='lanes')fitBars(current,Math.min(current+3,positions.length-1));}render();break;}
      case 'loop':{const from=toTime(s.timeline,positions[barRange[0]]),to=toTime(s.timeline,positions[barRange[1]]+number(s.timeline.measures[barRange[1]].length));if(setLoop)setLoop(from,to);else{engine.setLoop(true,from,to);onLoopChange();}break;}
      case 'align':if(songMap&&openMap)openMap(a.startPosition,{edit:true});else alignment();break;
      case 'align-beat':if(songMap&&openMap){openMap(cursor);break;}dialog('Align this beat',`<p>Set the recording time for the edit cursor at bar ${a.index+1}, offset ${a.offset.toFixed(3)} quarter notes. Notes keep their musical positions.</p><label>Recording time (seconds) <input name="time" type="number" min="0" max="${engine.duration}" step="any" value="${toTime(s.timeline,number(cursor))}" required></label>`,data=>{editor().transact(d=>{d.timeline.anchors=d.timeline.anchors.filter(p=>compare(p.position,cursor)!==0);d.timeline.anchors.push({position:cursor,time:Number(data.get('time'))});d.timeline.anchors.sort((x,y)=>compare(x.position,y.position));});changed();});break;
      case 'export':exportNative();break;
      case 'import':importNative();break;
      case 'print':printScore();break;
      case 'shortcuts':keyboardSettings();break;
      case 'list':showList=!showList;render();break;
      case 'page-prev':page=Math.max(0,page-PAGE);render();break;
      case 'page-next':page=Math.min(pageOf(positions.length-1),page+PAGE);render();break;
      case 'play-cursor':engine.seek(toTime(s.timeline,number(cursor)));if(!engine.playing)void play();break;
      case 'mute-drums':{const track=engine.tracks.find(t=>t.name==='drums');if(track){engine.toggleMute('drums');onMixerChange();message(track.muted?'Recorded drums muted; backing mix retained.':'Recorded drums restored.');}else message('This song does not have an isolated drum stem.');break;}
      case 'retry-save':void part.store?.persist().then(()=>part.store.flush()).catch(e=>message(e.data?.message||e.message));break;
      case 'resolve':dialog('Load saved version','<p>Your current edits will be exported first so you can recover them. Then load the version saved on the server.</p>',async()=>{exportNative();await part.reload();cursor=fraction(0);selected.clear();barRange=[0,0];page=0;render();},'Export local edits & load saved');break;
    }
  }
  function onKey(e){if(!editor()||host.hidden||e.defaultPrevented||e.isComposing||e.key==='Tab'||mapActive()||e.target?.closest?.('input,select,textarea,[contenteditable],button,summary,a[href]'))return;const k=e.key.toLowerCase(),mod=e.metaKey||e.ctrlKey;if(e.shiftKey&&k==='s'&&!mod)return;
    if(e.code==='Space'||e.key==='Enter'){e.preventDefault();e.stopPropagation();if(!e.repeat)void play({pause:e.key==='Enter'});return;}
    if(e.altKey){if(!mod&&(k==='arrowleft'||k==='arrowright')){e.preventDefault();e.stopPropagation();attempt(()=>moveNotes(k==='arrowright'?navigationStep():subtract(fraction(0),navigationStep())));focus();}return;}let handled=true;
    attempt(()=>{if(mod){if(k==='z')action(e.shiftKey?'redo':'undo');else if(k==='y')action('redo');else if(k==='c')copy();else if(k==='v')action('paste');else if(k==='d')action('repeat');else if(k==='a'){selectionKind='bars';const a=active();barRange=[a.index,a.index];selected=new Set((score().bars.find(b=>b.measureId===a.measure.id)?.hits||[]).map(h=>h.id));render();}else handled=false;}
      else if(k==='arrowright')layout==='lanes'&&selected.size&&!e.shiftKey?moveNotes(gridStep()):navigate(add(cursor,navigationStep()),{extend:e.shiftKey});
      else if(k==='arrowleft')layout==='lanes'&&selected.size&&!e.shiftKey?moveNotes(subtract(fraction(0),gridStep())):navigate(subtract(cursor,navigationStep()),{extend:e.shiftKey});
      else if(k==='arrowup'||k==='arrowdown'){const list=layout==='lanes'?rows():KIT.map(item=>item.id);if(layout==='lanes'&&selected.size&&!readOnly){moveLaneNotes(editor(),selected,fraction(0),k==='arrowup'?-1:1,list);changed();return;}const i=list.indexOf(piece);piece=list[clamp(i+(k==='arrowup'?-1:1),0,list.length-1)];render();}
      else if(k==='home')navigate(active().startPosition);
      else if(k==='end')navigate(subtract(add(active().startPosition,active().measure.length),step()));
      else if(k==='escape'){cancelGesture();selected.clear();panel='';render();}
      else if(k==='n'&&!readOnly)insert();
      else if(k==='delete'||k==='backspace')action('delete');
      else if(k==='r')action('skip');
      else if(/^[1-7]$/.test(k))setStep(Math.min(64,Math.max(4,2**(7-Number(k)))),stepDotted,stepTuplet);
      else if(k==='+'||k==='=')setStep(Math.min(64,stepValue*2));
      else if(k==='-'||k==='_')setStep(Math.max(4,stepValue/2));
      else if(k==='.')setStep(stepValue,!stepDotted,1);
      else if(k==='/')setStep(stepValue,false,stepTuplet===1?3:stepTuplet===3?5:stepTuplet===5?6:stepTuplet===6?7:1);
      else if(k==='a'&&!readOnly)setExpression(e.shiftKey?'heavy':'accent',!(selected.size?selectedHits()[0][e.shiftKey?'heavy':'accent']:expression[e.shiftKey?'heavy':'accent']));
      else if(k==='g'&&!readOnly)setExpression('ghost',!(selected.size?selectedHits()[0].ghost:expression.ghost));
      else{const kit=KIT.find(item=>keyFor(item)===k);if(kit){if(!e.repeat)insert(kit.id);}else handled=false;}
    });
    if(handled){e.preventDefault();e.stopPropagation();focus();}
  }
  const resize=new ResizeObserver(()=>{if(editor()&&host.offsetWidth&&layout==='lanes')render();});resize.observe(host);
  const theme=()=>{if(layout==='lanes')render();};window.addEventListener('woodshed:theme',theme);
  const unsubscribe=part.subscribe(reason=>{if(disposed)return;if(reason?.type==='error'){message(reason.message);return;}if(!editor()){render();return;}if(reason==='shared'||reason==='reload'||reason==='import'){selected.clear();cursor=fraction(Math.round(clamp(number(cursor),0,extent(score().timeline)-.0001)*1e6),1e6);const index=active().index;barRange=[index,index];page=pageOf(index);}audio?.setScore(score());if(!host.hidden)render();});
  const unstatus=part.onStatus(state=>saveStatus(state));
  if(editor()){const current=locate(score().timeline,toQuarter(score().timeline,engine.getPosition()));barRange=[current.index,current.index];cursor=current.startPosition;page=pageOf(current.index);
    // Feet default to the kit piece most used in the part.
    const used=new Map();for(const b of score().bars)for(const h of b.hits)used.set(h.instrument,(used.get(h.instrument)||0)+1);if(used.size&&!used.has(piece))piece=[...used].sort((a,b)=>b[1]-a[1])[0][0];}
  return {handleKey:onKey,flush:()=>part.flush(),notice:message,
    setVisible(visible){host.hidden=!visible;if(!visible){cancelGesture();audio?.setMode('recording');host.closest('.player')?.classList.remove('notation-expanded');}else{if(layout==='lanes'&&editor())revealCursor();render();focus();}},
    tick(time){if(!editor()||host.hidden||disposed)return;const s=score(),q=toQuarter(s.timeline,time);
      if(layout==='score'){if(followPlayback&&engine.playing){const current=locate(s.timeline,q).index;if(current<page||current>=page+PAGE){page=pageOf(current);render();}}view?.setPlayhead(engine.playing||engine.paused?q:null);return;}
      const v=getView();if(JSON.stringify(v)!==lastView){render();return;}
      let head=lanesHost.querySelector('.notation-playhead');if(!head){head=document.createElement('div');head.className='notation-playhead';lanesHost.append(head);}
      head.hidden=!engine.playing;if(engine.playing&&lanesData){head.style.left=lanesData.qx(q)+'px';head.style.top='0px';head.style.height=lanesData.height+'px';}},
    destroy(){disposed=true;cancelGesture();unsubscribe();unstatus();resize.disconnect();window.removeEventListener('woodshed:theme',theme);audio?.destroy();view?.destroy();host.closest('.player')?.classList.remove('notation-expanded');host.remove();}};
}
