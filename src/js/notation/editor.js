import {ScoreEditor,KIT,id,fraction,number,add,subtract,compare,durationOf,emptyScore,starts,extent,locate,toTime,toQuarter,validateScore,validateTimeline,beatGroups,musicalStarts} from '../../../shared/notation.ts';
import {renderStaff,renderLanes,describe,xml} from './render.js';
import {DrumAudio} from './audio.js';
import {NotationStore,loadSharedNotation,watchSharedNotation} from './store.js';
import {focusModal} from '../modal-focus.js';
import {isPointerControl} from '../interactions.js';
import {wheelNavigation} from '../timeline-navigation.js';
import './notation.css';

const btn=(action,label,title='')=>`<button type="button" data-action="${action}" title="${xml(title||label)}">${label}</button>`;
const durations=[[1,'𝅝','Whole'],[2,'𝅗𝅥','Half'],[4,'♩','Quarter'],[8,'♪','Eighth'],[16,'♬','Sixteenth'],[32,'1/32','32nd'],[64,'1/64','64th']];
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const download=(value,name,type='application/json')=>{const url=URL.createObjectURL(new Blob([value],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};

export async function createNotationWorkspace({host,song,engine,metronome,getView,setView,setFollow,play,readOnly=false,shareToken=null,persistence=null,onLoopChange=()=>{},onMixerChange=()=>{}}) {
  let editor=null,disposed=false,layout='staff',mode=readOnly?'select':'write',cursor=fraction(0),selected=new Set(),barRange=[0,0],piece='snare',value=8,dotted=false,tuplet=1,voice='auto',filter='all',clipboard=[],expandedStart=0,showList=false;
  let selectionKind='bars',noteClipboard=null;
  let expression={accent:false,ghost:false,flam:false,sticking:'',velocity:.75};
  let shortcuts={};try{shortcuts=JSON.parse(localStorage.getItem('ws.notation.keys')||'{}');}catch{}
  const interpretWheel=wheelNavigation();let followPlayback=true;
  const keyFor=kit=>shortcuts[kit.id]||kit.key;
  let audio=null,store=null,lastView='',status='loading',timingSignature='';
  const focus=()=>{if(!document.querySelector('[role="dialog"]'))host.querySelector('.notation-surface')?.focus({preventScroll:true});};
  const message=text=>{const target=host.querySelector('.notation-message');if(target)target.textContent=text;};
  const saveStatus=state=>{status=state;const el=host.querySelector('.notation-save');if(el)el.textContent=({loading:'Opening part…',saved:'Saved',local:'Saved on this device',saving:'Saving…',offline:'Waiting for connection · edits kept here',conflict:'Another version exists · edits kept here','storage-error':'Device storage unavailable · export a backup'})[state]||state;host.querySelector('[data-action="resolve"]')?.classList.toggle('hidden',state!=='conflict');host.querySelector('[data-action="retry-save"]')?.classList.toggle('hidden',!['offline','storage-error'].includes(state));};
  host.innerHTML='<div class="notation-loading"><strong>Preparing your transcription workspace</strong><div class="notation-placeholder"></div></div>';
  try{
    let score;
    if(readOnly)score=(await loadSharedNotation(shareToken))?.score;
    else{store=persistence||new NotationStore(song.id,saveStatus);score=await store.load();if(persistence)status='Local development fixture';}
    if(disposed)return {destroy(){store?.destroy();}};
    if(score)editor=new ScoreEditor(score);
  }catch(error){store?.destroy();host.innerHTML=`<div class="notation-empty"><h2>Couldn’t open this part</h2><p>${xml(error.data?.message||error.message)}</p>${btn('retry','Try again')}</div>`;host.querySelector('button').onclick=()=>location.reload();throw error;}
  await document.fonts?.ready;
  const ensureAudio=()=>audio??(audio=new DrumAudio(engine));
  function updateTiming(){if(!editor)return;const signature=JSON.stringify(editor.score.timeline);if(timingSignature===signature)return;timingSignature=signature;const timeline=editor.score.timeline,positions=starts(timeline),beats=[],sections=[];
    timeline.measures.forEach((m,i)=>{const groups=beatGroups(m),pulse=groups[0]*4/m.denominator,start=positions[i],time=toTime(timeline,start);sections.push({t:time,bpm:60/(toTime(timeline,start+pulse)-time),beatsPerBar:groups.length,unit:m.denominator});let q=0;for(const group of groups){const time=toTime(timeline,start+q);if(q<number(m.length)-1e-7&&time>=0&&time<engine.duration)beats.push({time,downbeat:q===0});q+=group*4/m.denominator;}});
    metronome.setNotationTiming(beats,sections);
  }
  const changed=()=>{if(!editor)return;const score=editor.score;selected=new Set([...selected].filter(id=>score.bars.some(b=>b.hits.some(h=>h.id===id))));if(number(cursor)>=extent(score.timeline))cursor=fraction(Math.round((extent(score.timeline)-.0001)*1e6),1e6);barRange=barRange.map(i=>Math.min(i,score.timeline.measures.length-1));store?.set(editor.score);audio?.setScore(editor.score);updateTiming();render();};
  const attempt=fn=>{try{fn();}catch(error){message(error.message||String(error));}};
  const selectedHits=()=>editor.score.bars.flatMap(b=>b.hits).filter(h=>selected.has(h.id));
  const active=()=>locate(editor.score.timeline,number(cursor));
  const step=()=>durationOf(value,dotted,tuplet);
  function rangeLabel(){return barRange[0]===barRange[1]?`Bar ${barRange[0]+1}`:`Bars ${barRange[0]+1}–${barRange[1]+1}`;}
  function navigate(q,{seek=false,extend=false}={}){
    const total=extent(editor.score.timeline),old=active().index;
    cursor=fraction(Math.round(clamp(number(q),0,total-.0001)*1000000),1000000);
    // Preserve exact fractions for keyboard steps and tuplets.
    if(number(q)>=0&&number(q)<total)cursor=q;
    selected.clear();selectionKind=extend?'bars':'notes';const a=active();barRange=extend?[Math.min(barRange[0],a.index),Math.max(barRange[1],a.index)]:[a.index,a.index];
    if(layout==='expanded'&&(a.index<expandedStart||a.index>=expandedStart+12))expandedStart=Math.floor(a.index/12)*12;
    if(seek&&!engine.playing)engine.seek(toTime(editor.score.timeline,number(cursor)));
    setFollow(false);
    followPlayback=false;
    const time=toTime(editor.score.timeline,number(cursor)),view=getView();
    if(layout!=='expanded'&&(time<view.start||time>view.end)){const width=view.end-view.start;setView(time-.1*width,time+.9*width);}
    render();
  }
  function insert(instrument=piece){
    const kit=KIT.find(k=>k.id===instrument);piece=instrument==='rest'?piece:instrument;
    const a=active(),hit={id:id(),instrument,offset:subtract(cursor,a.startPosition),duration:step(),voice:voice==='auto'?(kit?.voice||1):Number(voice),value,dotted,tuplet,...expression};
    if(readOnly||mode==='preview'){ensureAudio().play(hit,engine.ctx.currentTime,true);message(`Preview · ${kit?.name||'Rest'}`);return;}
    if(mode!=='write'){ensureAudio().play(hit,engine.ctx.currentTime,true);message('Press N or choose Write to add notes.');return;}
    selectionKind='notes';selected=new Set([editor.insert(a.index,hit)]);barRange=[a.index,a.index];changed();ensureAudio().play(selectedHits()[0],engine.ctx.currentTime,true);
  }
  function setDuration(v=value,d=dotted,t=tuplet){
    if(!readOnly&&mode==='select'&&selected.size)editor.change(selected,{value:v,dotted:d,tuplet:t,duration:durationOf(v,d,t)});
    value=v;dotted=d;tuplet=t;
    if(!readOnly&&mode==='select'&&selected.size)changed();else render();
  }
  function setExpression(property,next){if(readOnly)return;if(selected.size){editor.change(selected,{[property]:next});changed();}else{expression={...expression,[property]:next};render();}}
  function copy(wholeBars=false){
    if(!wholeBars&&selectionKind==='notes'&&selected.size){
      const positions=starts(editor.score.timeline),notes=[];
      for(const bar of editor.score.bars){const index=editor.score.timeline.measures.findIndex(m=>m.id===bar.measureId);for(const hit of bar.hits)if(selected.has(hit.id))notes.push({hit:structuredClone(hit),position:add(musicalStarts(editor.score.timeline)[index],hit.offset)});}
      const first=notes.reduce((p,n)=>compare(n.position,p)<0?n.position:p,notes[0].position);
      noteClipboard=notes.map(({hit,position})=>({hit,offset:subtract(position,first)}));
      message(`${notes.length} note${notes.length===1?'':'s'} copied. Paste at the edit cursor.`);return;
    }
    noteClipboard=null;clipboard=Array.from({length:barRange[1]-barRange[0]+1},(_,i)=>structuredClone(editor.score.bars.find(b=>b.measureId===editor.score.timeline.measures[barRange[0]+i].id)||{coverage:'unstarted',hits:[]}));message(`${rangeLabel()} copied. Paste creates independent notes.`);
  }
  function moveNotes(delta){if(readOnly||!selected.size)return;editor.move(selected,delta);cursor=add(cursor,delta);const index=active().index;barRange=[index,index];changed();}
  function moveDialog(){if(!selected.size){message('Select notes to move first.');return;}dialog('Move selected notes',`<p>Move ${selected.size} selected note${selected.size===1?'':'s'} by a musical offset. Positive values move later; negative values move earlier. Other notes stay in place.</p><label>Quarter notes <input name="delta" type="number" step="any" value="${number(step())}" required></label><p class="hint">You can also use Alt + ← / → to move by the current duration.</p>`,data=>{const delta=Number(data.get('delta'));if(!Number.isFinite(delta))throw new Error('Enter a musical offset.');moveNotes(fraction(Math.round(delta*1e6),1e6));});}
  function dialog(title,body,onSubmit,label='Apply'){
    const modal=document.createElement('div');modal.className='modal notation-dialog';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-label',title);
    modal.innerHTML=`<form class="modal-card"><h2>${xml(title)}</h2>${body}<p class="notation-dialog-error" role="alert"></p><div class="modal-actions">${btn('cancel','Cancel')}<button class="btn-primary" type="submit">${xml(label)}</button></div></form>`;
    document.body.append(modal);const close=()=>{modal.remove();focus();};modal.querySelector('[data-action="cancel"]').onclick=close;focusModal(modal,close);
    modal.querySelector('form').onsubmit=async e=>{e.preventDefault();try{await onSubmit(new FormData(e.target));close();}catch(error){modal.querySelector('[role="alert"]').textContent=error.data?.message||error.message;}};return modal;
  }
  function createPart(){const section=metronome.sectionAt(engine.getPosition());
    dialog('Create drum part',`<p>Set the first downbeat and the pulse you count. Existing audio and practice timing stay in place.</p><div class="notation-form-grid"><label>Tempo <input name="bpm" type="number" min="20" max="400" value="${section.bpm}" required></label><label>Beats per bar <input name="n" type="number" min="1" max="16" value="${section.beatsPerBar}" required></label><label>Meter denominator <select name="d"><option value="4">Quarter note</option><option value="8" ${section.unit===8?'selected':''}>Eighth note</option><option value="16">Sixteenth note</option></select></label><label>Tempo beat unit <select name="pulse"><option value="1">Quarter note</option><option value="1.5">Dotted quarter</option><option value=".5" ${section.unit===8?'selected':''}>Eighth note</option><option value=".25" ${section.unit===16?'selected':''}>Sixteenth note</option></select></label><label>Pickup (quarter notes) <input name="pickup" type="number" min="0" max="32" step=".0625" value="0"></label><label>First downbeat (seconds) <input name="start" type="number" min="0" max="${engine.duration-.01}" step=".001" value="${metronome.beats.find(b=>b.downbeat)?.time||0}" required></label></div><label class="notation-check"><input name="useBeats" type="checkbox" checked> Follow the existing beat positions</label><p class="hint">Each existing pulse represents the selected tempo beat unit. For 6/8 counted in two, choose dotted quarter. Turn this off to start a steady map. You can refine alignment and meter bar by bar.</p>`,data=>{
      const n=Number(data.get('n')),d=Number(data.get('d')),bpm=Number(data.get('bpm')),start=Number(data.get('start'));
      const pulse=Number(data.get('pulse')),score=emptyScore(engine.duration,bpm*pulse,n,d,start);
      if(data.has('useBeats')&&metronome.beats.length>1){
        const beats=metronome.beats.filter(b=>b.time>=start-1e-6);const downbeats=beats.map((b,i)=>b.downbeat?i:-1).filter(i=>i>=0);
        if(downbeats.length>1){let q=0;const measures=[],anchors=[];
          for(let j=0;j<downbeats.length;j++){const begin=downbeats[j],end=downbeats[j+1]??beats.length,count=end-begin;if(!count)continue;const meter=metronome.source==='detected'?count*pulse*d/4:metronome.sectionAt(beats[begin].time).beatsPerBar;
            if(!Number.isInteger(meter)||meter>16||meter<1)throw new Error('These pulses do not fit the chosen meter. Correct the beat unit or start a steady map.');
            const length=fraction(4*meter,d);measures.push({id:id(),numerator:meter,denominator:d,length,label:''});
            for(let i=begin;i<end;i++)anchors.push({position:fraction(Math.round((q+(i-begin)*pulse)*16),16),time:beats[i].time});q+=number(length);
          }
          if(anchors.length>=2){score.timeline={version:1,measures,anchors};validateTimeline(score.timeline);}
        }
      }
      const pickup=Number(data.get('pickup'));if(pickup>0){const downbeat=toTime(score.timeline,0);if(downbeat<=0)throw new Error('A pickup needs recording time before the first downbeat. Set the first downbeat later.');const length=fraction(Math.round(pickup*16),16),begin=Math.max(0,toTime(score.timeline,-pickup));score.timeline.anchors=score.timeline.anchors.map(a=>({...a,position:add(a.position,length)}));score.timeline.anchors.unshift({position:fraction(0),time:begin});score.timeline.measures.unshift({...structuredClone(score.timeline.measures[0]),id:id(),length,label:'Pickup'});}
      editor=new ScoreEditor(score);cursor=fraction(0);barRange=[0,0];changed();fitBars(0,pickup>0?0:Math.min(3,score.timeline.measures.length-1));
    },'Create part');
  }
  function fitBars(first,last){const positions=starts(editor.score.timeline),t=editor.score.timeline;setView(toTime(t,positions[first]),toTime(t,positions[last]+number(t.measures[last].length)));setFollow(false);}
  function repeat(paste=false){if(paste&&noteClipboard){editor.pasteHits(cursor,noteClipboard);changed();message('Notes pasted at the edit cursor.');return;}if(!paste)copy(true);if(!clipboard.length){message('Select and copy one or more bars first.');return;}
    dialog(paste?'Paste passage':'Repeat passage',`<p>${clipboard.length} bar${clipboard.length===1?'':'s'}. Every copy can be edited independently.</p><div class="notation-form-grid"><label>Start at bar <input name="to" type="number" min="1" max="${editor.score.timeline.measures.length}" value="${paste?barRange[0]+1:Math.min(barRange[1]+2,editor.score.timeline.measures.length)}" required></label><label>Copies <input name="count" type="number" min="1" max="64" value="1" required></label></div><label class="notation-check"><input name="replace" type="checkbox"> Replace written notes in the destination</label>`,data=>{editor.paste(0,Number(data.get('to'))-1,Number(data.get('count')),data.has('replace'),clipboard);changed();},'Paste');
  }
  function alignment(){const a=active(),m=a.measure,t=editor.score.timeline,time=toTime(t,a.start);
    dialog(`Align bar ${a.index+1}`,`<p>Moving this bar’s downbeat changes its alignment to the recording. Notes keep their musical positions.</p><div class="notation-form-grid"><label>Downbeat (seconds) <input name="time" type="number" min="0" max="${engine.duration}" step=".001" value="${time.toFixed(3)}" required></label><label>Section label <input name="label" maxlength="120" value="${xml(m.label)}" placeholder="Verse, chorus, fill…"></label><label>Meter numerator <input name="n" type="number" min="1" max="16" value="${m.numerator}" required></label><label>Meter denominator <select name="d">${[2,4,8,16].map(d=>`<option value="${d}" ${d===m.denominator?'selected':''}>${d}</option>`).join('')}</select></label><label>Beat grouping <input name="grouping" value="${beatGroups(m).join('+')}" placeholder="3+3 or 2+2+3" required></label><label>Actual length (quarter notes) <input name="length" type="number" min=".0625" max="32" step=".0625" value="${number(m.length)}" required></label></div><p class="hint">Use a shorter actual length for a pickup or partial ending. Changing the length shifts later bar numbers in musical time; their audio alignment stays fixed. Existing notes must fit.</p>`,data=>{
      editor.transact(s=>{const measure=s.timeline.measures[a.index],length=fraction(Math.round(Number(data.get('length'))*16),16),delta=number(length)-number(measure.length),boundary=a.start+number(measure.length);measure.numerator=Number(data.get('n'));measure.denominator=Number(data.get('d'));measure.label=String(data.get('label')).trim();measure.length=length;measure.grouping=String(data.get('grouping')).split('+').map(n=>Number(n.trim()));
        s.timeline.anchors=s.timeline.anchors.filter(anchor=>Math.abs(number(anchor.position)-a.start)>1e-7).map(anchor=>number(anchor.position)>=boundary?{...anchor,position:add(anchor.position,fraction(Math.round(delta*16),16))}:anchor);
        s.timeline.anchors.push({position:a.startPosition,time:Number(data.get('time'))});s.timeline.anchors.sort((x,y)=>compare(x.position,y.position));
      });changed();
    });
  }
  function exportNative(){download(JSON.stringify({format:'woodshed-notation',version:1,song:{title:song.title,artist:song.artist,duration:engine.duration},score:editor.score},null,2),`${song.title.replace(/[^\p{L}\p{N} -]/gu,'_')}-drums.woodshed.json`);}
  function importNative(){const input=document.createElement('input');input.type='file';input.accept='.json';input.onchange=async()=>{try{const file=input.files[0];if(!file)return;if(file.size>8_000_000)throw new Error('The score file is too large.');const data=JSON.parse(await file.text());if(data.format!=='woodshed-notation')throw new Error('Choose a Woodshed notation export.');validateScore(data.score);dialog('Replace drum part',`<p>This replaces the current notation with ${xml(file.name)}. The audio stays in place. Undo restores your current part. Check alignment if this came from a different recording.</p>`,()=>{editor.transact(s=>Object.assign(s,data.score));cursor=fraction(0);selected.clear();barRange=[0,0];changed();},'Replace part');}catch(e){message(e.message);}};input.click();}
  function printScore(){const page=document.createElement('div');page.className='notation-print';const title=document.createElement('h1');title.textContent=`${song.title} — Drums`;page.append(title);const t=editor.score.timeline;
    for(let i=0;i<t.measures.length;i+=4){const row=document.createElement('div');page.append(row);renderStaff(row,{score:editor.score,indices:Array.from({length:Math.min(4,t.measures.length-i)},(_,j)=>i+j),width:1000,print:true});}
    document.body.append(page);window.print();page.remove();
  }
  function keyboardSettings(){dialog('Drum shortcuts',`<p>Choose a single letter for each pad. Duration, navigation, and transport shortcuts stay consistent.</p><div class="notation-form-grid">${KIT.map(k=>`<label>${k.name}<input name="${k.id}" value="${xml(keyFor(k))}" maxlength="1" pattern="[a-zA-Z]" required></label>`).join('')}</div>`,data=>{const next=Object.fromEntries(KIT.map(k=>[k.id,String(data.get(k.id)).toLowerCase()]));const keys=Object.values(next);if(new Set(keys).size!==keys.length||keys.some(k=>'nrag'.includes(k)))throw new Error('Each pad needs a unique letter. N, R, A and G are reserved for Write, Rest, Accent and Ghost.');shortcuts=next;localStorage.setItem('ws.notation.keys',JSON.stringify(next));render();});}

  function render(){if(disposed)return;
    if(!editor){host.innerHTML=`<div class="notation-empty"><span class="notation-eyebrow">DRUM TRANSCRIPTION</span><h2>${readOnly?'No drum part shared yet':'Write what you hear.'}</h2><p>${readOnly?'The sender can include their notation in this link.':'Loop a passage. Choose a rhythm. Add your kick, snare and cymbals at the keyboard.'}</p>${readOnly?'':btn('create','Create drum part')}<small>One score. Staff, expanded score and drum lanes.</small></div>`;host.querySelector('[data-action="create"]')?.addEventListener('click',createPart);return;}
    const focused=document.activeElement,hadFocus=host.querySelector('.notation-surface')===focused;
    const focusAttribute=host.contains(focused)?[...focused.attributes].find(a=>a.name.startsWith('data-')):null;
    const a=active(),hits=selectedHits(),current=hits.length?hits[0]:expression;
    host.classList.toggle('is-expanded',layout==='expanded');host.classList.toggle('is-lanes',layout==='lanes');
    host.closest('.player').classList.toggle('notation-expanded',layout==='expanded');
    host.innerHTML=`<header class="notation-heading"><div><span class="notation-eyebrow">TRANSCRIBE</span><h2>Drums <span class="notation-save" role="status"></span></h2></div><div class="notation-views" aria-label="Notation view">${[['staff','Staff'],['lanes','Drum lanes'],['expanded','Expand score']].map(([v,l])=>`<button data-view="${v}" aria-pressed="${layout===v}">${l}</button>`).join('')}</div>${btn('export','Export')}${btn('print','Print')}${readOnly?'':btn('import','Import')}</header>
      <div class="notation-toolbar" aria-label="Note entry tools"><div class="notation-mode">${['select','write','preview'].map(m=>`<button data-mode="${m}" aria-pressed="${mode===m}" ${readOnly&&m==='write'?'disabled':''}>${m[0].toUpperCase()+m.slice(1)}</button>`).join('')}</div><div class="notation-durations" aria-label="Note duration">${durations.map(([v,symbol,label])=>`<button data-duration="${v}" aria-pressed="${value===v}" title="${label} · ${7-Math.log2(v)}" aria-label="${label} note">${symbol}</button>`).join('')}<button data-action="dot" aria-pressed="${dotted}" title="Dotted duration · .">•</button></div><label>Tuplet <select data-field="tuplet">${[[1,'None'],[3,'3:2'],[5,'5:2'],[7,'7:2']].map(([v,l])=>`<option value="${v}" ${tuplet===v?'selected':''}>${l}</option>`).join('')}</select></label><label>Entry voice <select data-field="voice">${[['auto','Auto'],['1','1 · Hands'],['2','2 · Feet']].map(([v,l])=>`<option value="${v}" ${voice===v?'selected':''}>${l}</option>`).join('')}</select></label>${btn('rest','Rest','Write rest · R')}${btn('undo','↶','Undo · ⌘/Ctrl Z')}${btn('redo','↷','Redo · ⌘/Ctrl Shift Z')}${btn('shortcuts','Keys')}</div>
      <div class="notation-pads" aria-label="Drum kit">${KIT.map(k=>`<button data-kit="${k.id}" aria-pressed="${piece===k.id}"><span>${k.name}</span><kbd>${xml(keyFor(k).toUpperCase())}</kbd></button>`).join('')}</div>
      <div class="notation-section-tools"><span class="notation-range">${rangeLabel()}</span>${btn('previous','←','Previous bar')}${btn('next','→','Next bar')}${btn('fit','Fit selection')}${btn('loop','Loop selection')}${btn('follow',followPlayback?'Following playback':'Return to playhead')}${readOnly?'':btn('copy','Copy')+btn('paste','Paste')+btn('repeat','Repeat bars…')+btn('move','Move…')+btn('review','Mark reviewed')+btn('align','Align / meter')+btn('align-beat','Align beat')}<label class="notation-filter">Show voice <select data-field="filter"><option value="all">Both</option><option value="1" ${filter==='1'?'selected':''}>1</option><option value="2" ${filter==='2'?'selected':''}>2</option></select></label></div>
      <div class="notation-body"><aside class="notation-sections">${layout==='expanded'?`<h3>Sections</h3>${editor.score.timeline.measures.map((m,i)=>(i===0||m.label)?`<button data-bar="${i}"><span>${xml(m.label||'Start')}</span><small>Bar ${i+1}</small></button>`:'').join('')}<small>${editor.score.bars.filter(b=>b.coverage==='reviewed').length} / ${editor.score.timeline.measures.length} reviewed</small>`:layout==='lanes'?`<div class="notation-lane-labels">${KIT.map(k=>`<span>${k.name}<kbd>${xml(keyFor(k).toUpperCase())}</kbd></span>`).join('')}</div>`:'<div class="notation-staff-label"><strong>Drum kit</strong><span>Percussion</span><small>Ⅰ Hands<br>Ⅱ Feet</small></div>'}</aside>
      <div class="notation-surface" role="grid" aria-label="Drum notation. N writes, arrows move, drum keys add hits, Space plays." aria-describedby="notation-help" tabindex="0"><div class="notation-rendered"></div><div class="notation-playhead"></div></div></div>
      <div class="notation-inspector"><strong>${hits.length?`${hits.length} selected`:mode==='write'?'Next hit':'No hit selected'}</strong>${['accent','ghost','flam'].map(p=>`<label><input type="checkbox" data-expression="${p}" ${current[p]?'checked':''} ${readOnly?'disabled':''}>${p[0].toUpperCase()+p.slice(1)}</label>`).join('')}<label>Sticking <select data-expression="sticking"><option value="">—</option><option ${current.sticking==='L'?'selected':''}>L</option><option ${current.sticking==='R'?'selected':''}>R</option></select></label><label>Velocity <input data-expression="velocity" type="range" min=".05" max="1" step=".05" value="${current.velocity}"></label>${btn('delete','Delete selected')}${btn('list',showList?'Hide note list':'Note list')}</div>
      <div class="notation-audition"><label>Listen to <select data-field="listen">${[['recording','Recording'],['notation','Notation'],['both','Both']].map(([v,l])=>`<option value="${v}" ${audio?.mode===v?'selected':''}>${l}</option>`).join('')}</select></label><label>Notation level <input data-field="level" type="range" min="0" max="1" step=".05" value="${audio?.out.gain.value??.65}"></label>${btn('mute-drums','Mute recorded drums')}${btn('play-cursor','Play from cursor')}<span class="notation-position">Bar ${a.index+1} · ${a.offset.toFixed(2)} quarter notes</span></div>
      <div class="notation-note-list ${showList?'':'hidden'}" aria-label="Accessible note list"></div><footer class="notation-footer"><span id="notation-help">${mode==='write'?'Add hits at this step · → advances · Space plays':mode==='preview'?'Preview sounds without writing':'Select a note to edit · N to write'} · Tab leaves the editor</span><span class="notation-message" role="status"></span>${btn('retry-save','Retry saving')}${btn('resolve','Review saved version')}</footer>`;
    if(readOnly)host.querySelectorAll('[data-action="rest"],[data-action="undo"],[data-action="redo"],[data-action="delete"],[data-expression]').forEach(e=>e.disabled=true);
    saveStatus(readOnly?'Read-only shared part':status);
    const surface=host.querySelector('.notation-surface'),container=host.querySelector('.notation-rendered');
    const width=Math.max(240,surface.clientWidth||800),positions=starts(editor.score.timeline),view=getView();
    let indices=layout==='expanded'?Array.from({length:Math.min(12,editor.score.timeline.measures.length-expandedStart)},(_,i)=>expandedStart+i):editor.score.timeline.measures.map((m,i)=>i).filter(i=>toTime(editor.score.timeline,positions[i]+number(editor.score.timeline.measures[i].length))>view.start+1e-8&&toTime(editor.score.timeline,positions[i])<view.end-1e-8);
    if(!indices.length)indices=[a.index];
    const requiredWidth=i=>{const bar=editor.score.bars.find(b=>b.measureId===editor.score.timeline.measures[i].id),onsets=new Set((bar?.hits||[]).map(h=>number(h.offset)));return Math.max(160,48+onsets.size*20+(bar?.hits.filter(h=>h.flam).length||0)*14);};
    const barsPerRow=Math.max(1,Math.floor(width/Math.max(260,...indices.map(requiredWidth))));
    const tooWide=layout!=='expanded'&&indices.some(i=>(toTime(editor.score.timeline,positions[i]+number(editor.score.timeline.measures[i].length))-toTime(editor.score.timeline,positions[i]))/(view.end-view.start)*width<requiredWidth(i));
    const rows=tooWide?[]:layout==='expanded'?Array.from({length:Math.ceil(indices.length/barsPerRow)},(_,i)=>indices.slice(i*barsPerRow,i*barsPerRow+barsPerRow)):[indices];
    if(tooWide)container.innerHTML=`<div class="notation-zoom-prompt"><strong>Zoom in to write comfortably</strong><p>Keep individual notes readable. Fit the selected bars or zoom into a passage.</p>${btn('fit','Fit selection')}</div>`;
    let rowTop=0;const rowData=[];
    for(const items of rows){const row=document.createElement('div');row.className='notation-row';container.append(row);let result;
      try{result=(layout==='lanes'?renderLanes:renderStaff)(row,{score:editor.score,indices:items,width,timeRange:layout==='expanded'?null:view,selected,cursor:number(cursor),voice:filter,range:barRange});}
      catch(error){row.innerHTML=`<p class="notation-render-error">This passage could not be drawn. Your notes are safe. Use the note list to edit it.</p>`;message(error.message);continue;}
      const top=rowTop;rowData.push({...result,items,top});rowTop+=result.height;
      const positionFromX=(bar,x)=>{
        const raw=layout==='lanes'?toQuarter(editor.score.timeline,view.start+x/width*(view.end-view.start)):result.quarterAt(bar,x);
        const offset=clamp(Math.round((raw-positions[bar.index])/number(step()))*number(step()),0,Math.max(0,number(editor.score.timeline.measures[bar.index].length)-number(step())));
        return add(musicalStarts(editor.score.timeline)[bar.index],fraction(Math.round(offset/number(step()))*step().n,step().d));
      };
      const hover=document.createElement('div');hover.className='notation-hover';hover.hidden=true;row.append(hover);
      row.onpointermove=e=>{if(mode!=='write'||readOnly||e.buttons||e.pointerType==='touch'){hover.hidden=true;return;}const rect=row.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top,bar=result.bars.find(b=>x>=b.left&&x<b.right);if(!bar||y<24){hover.hidden=true;return;}const q=positionFromX(bar,x),kit=layout==='lanes'?KIT[clamp(Math.round((y-26)/30),0,KIT.length-1)]:KIT.find(k=>k.id===piece);hover.hidden=false;hover.style.left=result.qx(number(q))+'px';hover.textContent=`${kit.name} · ${number(subtract(q,musicalStarts(editor.score.timeline)[bar.index])).toFixed(2)}`;};
      row.onpointerleave=()=>{hover.hidden=true;};
      row.onpointerdown=e=>{if(e.button!==0)return;attempt(()=>{
        const rect=row.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;followPlayback=false;setFollow(false);
        const bar=result.bars.find(b=>x>=b.left&&x<b.right);if(!bar)return;
        if(y<24){selectionKind='bars';barRange=e.shiftKey?[Math.min(barRange[0],bar.index),Math.max(barRange[1],bar.index)]:[bar.index,bar.index];selected=new Set(editor.score.bars.filter(b=>{const i=editor.score.timeline.measures.findIndex(m=>m.id===b.measureId);return i>=barRange[0]&&i<=barRange[1];}).flatMap(b=>b.hits.map(h=>h.id)));cursor=musicalStarts(editor.score.timeline)[bar.index];render();focus();return;}
        const target=result.targets.filter(t=>Math.abs(t.x-x)<13&&Math.abs(t.y-y)<13).sort((a,b)=>Math.abs(a.x-x)+Math.abs(a.y-y)-Math.abs(b.x-x)-Math.abs(b.y-y))[0];
        if(target){selectionKind='notes';if(!e.shiftKey)selected.clear();selected.add(target.hit.id);piece=target.hit.instrument==='rest'?piece:target.hit.instrument;cursor=add(musicalStarts(editor.score.timeline)[target.index],target.hit.offset);barRange=[target.index,target.index];if(mode==='select'){value=target.hit.value;dotted=target.hit.dotted;tuplet=target.hit.tuplet;}render();focus();return;}
        navigate(positionFromX(bar,x),{seek:mode==='select'});
        if(layout==='lanes')piece=KIT[clamp(Math.round((y-26)/30),0,KIT.length-1)].id;
        if(mode==='write'&&!readOnly)insert();focus();
      });};
    }
    if(layout==='expanded'){const paging=document.createElement('div');paging.className='notation-pagination';paging.innerHTML=`${btn('page-prev','Previous page')}<span>Bars ${expandedStart+1}–${Math.min(expandedStart+12,editor.score.timeline.measures.length)} of ${editor.score.timeline.measures.length}</span>${btn('page-next','Next page')}`;container.append(paging);}
    if(layout==='lanes'&&!tooWide){const preview=document.createElement('div');preview.className='notation-staff-preview';const label=document.createElement('span');label.textContent='Staff preview · same notes';preview.append(label);const drawing=document.createElement('div');preview.append(drawing);container.append(preview);renderStaff(drawing,{score:editor.score,indices,width,timeRange:view,selected,cursor:number(cursor),voice:filter,range:barRange});}
    // One active grid cell describes the current musical address. Written notes
    // also remain available as individual controls in the optional note list.
    const accessible=document.createElement('div');accessible.className='notation-sr-only';accessible.setAttribute('role','row');accessible.innerHTML=`<span role="gridcell" id="notation-active-cell">Bar ${a.index+1}, offset ${a.offset.toFixed(3)} quarter notes, ${xml(KIT.find(k=>k.id===piece)?.name||'Drums')}. ${hits.length?hits.map(describe).map(xml).join('; '):'No note selected.'}</span>`;surface.append(accessible);surface.setAttribute('aria-activedescendant','notation-active-cell');
    surface._rows=rowData;surface.onkeydown=onKey;
    surface.addEventListener('wheel',e=>{if(layout==='expanded')return;e.preventDefault();const {mode,delta}=interpretWheel(e,width);if(!delta)return;followPlayback=false;setFollow(false);const view=getView(),span=view.end-view.start;if(mode==='pan')setView(view.start+delta/width*span,view.end+delta/width*span);else{const relative=clamp((e.clientX-surface.getBoundingClientRect().left)/width,0,1),center=view.start+relative*span,next=clamp(span*Math.exp(delta*.0015),.25,engine.duration);setView(center-relative*next,center+(1-relative)*next);}render();},{passive:false});
    const list=host.querySelector('.notation-note-list');if(showList){const visible=editor.score.bars.filter(b=>indices.some(i=>editor.score.timeline.measures[i].id===b.measureId));list.innerHTML=visible.flatMap(b=>b.hits.map(h=>`<button data-hit="${h.id}">Bar ${editor.score.timeline.measures.findIndex(m=>m.id===b.measureId)+1}, offset ${number(h.offset).toFixed(3)} · ${xml(describe(h))}</button>`)).join('')||'<p>No written notes in these bars.</p>';}
    for(const el of host.querySelectorAll('button'))el.addEventListener('click',e=>{attempt(()=>{
      if(el.dataset.view){layout=el.dataset.view;render();}
      else if(el.dataset.mode){mode=el.dataset.mode;render();}
      else if(el.dataset.duration)setDuration(Number(el.dataset.duration));
      else if(el.dataset.kit)insert(el.dataset.kit);
      else if(el.dataset.bar)navigate(musicalStarts(editor.score.timeline)[Number(el.dataset.bar)]);
      else if(el.dataset.hit){selectionKind='notes';selected=new Set([el.dataset.hit]);const bar=editor.score.bars.find(b=>b.hits.some(h=>h.id===el.dataset.hit)),index=editor.score.timeline.measures.findIndex(m=>m.id===bar.measureId),hit=bar.hits.find(h=>h.id===el.dataset.hit);cursor=add(musicalStarts(editor.score.timeline)[index],hit.offset);barRange=[index,index];piece=hit.instrument==='rest'?piece:hit.instrument;value=hit.value;dotted=hit.dotted;tuplet=hit.tuplet;mode='select';render();}
      else action(el.dataset.action);
    });if(e.detail>0)queueMicrotask(focus);});
    for(const el of host.querySelectorAll('[data-field]'))el.onchange=()=>{const pointer=isPointerControl(el);attempt(()=>{const field=el.dataset.field;if(field==='tuplet')setDuration(value,dotted,Number(el.value));if(field==='voice'){voice=el.value;if(mode==='select'&&selected.size&&voice!=='auto'&&!readOnly){editor.change(selected,{voice:Number(voice)});changed();}else render();}if(field==='filter'){filter=el.value;render();}if(field==='listen'){const player=ensureAudio();player.setScore(editor.score);player.setMode(el.value);}if(field==='level')ensureAudio().out.gain.setTargetAtTime(Number(el.value),engine.ctx.currentTime,.015);});if(pointer)queueMicrotask(focus);};
    for(const el of host.querySelectorAll('[data-expression]'))el.onchange=()=>{const pointer=isPointerControl(el);attempt(()=>setExpression(el.dataset.expression,el.type==='checkbox'?el.checked:el.type==='range'?Number(el.value):el.value));if(pointer)queueMicrotask(focus);};
    lastView=JSON.stringify(view);if(hadFocus)focus();else if(focusAttribute)host.querySelector(`[${focusAttribute.name}="${CSS.escape(focusAttribute.value)}"]`)?.focus({preventScroll:true});
  }
  function action(name){if(!name)return;if(readOnly&&['undo','redo','rest','delete','paste','repeat','move','review','align','align-beat','import'].includes(name))return;
    const a=active(),positions=starts(editor.score.timeline);
    switch(name){
      case 'dot':setDuration(value,!dotted);break;
      case 'rest':insert('rest');break;
      case 'undo':if(editor.undo()){selected.clear();changed();}break;
      case 'redo':if(editor.redo()){selected.clear();changed();}break;
      case 'delete':if(editor.remove(selected)){selected.clear();changed();}break;
      case 'copy':copy();break;
      case 'paste':repeat(true);break;
      case 'repeat':repeat();break;
      case 'move':moveDialog();break;
      case 'review':editor.transact(s=>{for(let i=barRange[0];i<=barRange[1];i++)editor.bar(i,s).coverage='reviewed';});changed();break;
      case 'previous':navigate(musicalStarts(editor.score.timeline)[Math.max(0,a.index-1)]);break;
      case 'next':navigate(musicalStarts(editor.score.timeline)[Math.min(positions.length-1,a.index+1)]);break;
      case 'fit':fitBars(...barRange);render();break;
      case 'follow':{followPlayback=!followPlayback;setFollow(followPlayback);if(followPlayback){const current=locate(editor.score.timeline,toQuarter(editor.score.timeline,engine.getPosition())).index;expandedStart=Math.floor(current/12)*12;fitBars(current,Math.min(current+3,positions.length-1));}render();break;}
      case 'loop':engine.setLoop(true,toTime(editor.score.timeline,positions[barRange[0]]),toTime(editor.score.timeline,positions[barRange[1]]+number(editor.score.timeline.measures[barRange[1]].length)));onLoopChange();break;
      case 'align':alignment();break;
      case 'align-beat':dialog('Align this beat',`<p>Set the recording time for the edit cursor at bar ${a.index+1}, offset ${a.offset.toFixed(3)} quarter notes. Notes keep their musical positions.</p><label>Recording time (seconds) <input name="time" type="number" min="0" max="${engine.duration}" step=".001" value="${toTime(editor.score.timeline,number(cursor)).toFixed(3)}" required></label>`,data=>{editor.transact(s=>{s.timeline.anchors=s.timeline.anchors.filter(p=>compare(p.position,cursor)!==0);s.timeline.anchors.push({position:cursor,time:Number(data.get('time'))});s.timeline.anchors.sort((a,b)=>compare(a.position,b.position));});changed();});break;
      case 'export':exportNative();break;
      case 'import':importNative();break;
      case 'print':printScore();break;
      case 'shortcuts':keyboardSettings();break;
      case 'list':showList=!showList;render();break;
      case 'page-prev':expandedStart=Math.max(0,expandedStart-12);render();break;
      case 'page-next':expandedStart=Math.min(Math.floor((positions.length-1)/12)*12,expandedStart+12);render();break;
      case 'play-cursor':engine.seek(toTime(editor.score.timeline,number(cursor)));if(!engine.playing)void play();break;
      case 'mute-drums':{const track=engine.tracks.find(t=>t.name==='drums');if(track){engine.toggleMute('drums');onMixerChange();message(track.muted?'Recorded drums muted; backing mix retained.':'Recorded drums restored.');}else message('This song does not have an isolated drum stem.');break;}
      case 'retry-save':void store?.persist().then(()=>store.flush()).catch(e=>message(e.data?.message||e.message));break;
      case 'resolve':dialog('Load saved version',`<p>Your current edits will be exported first so you can recover them. Then load the version saved on the server.</p>`,async()=>{exportNative();const saved=await store.reload();editor=saved?new ScoreEditor(saved):null;cursor=fraction(0);selected.clear();barRange=[0,0];timingSignature='';if(editor){updateTiming();audio?.setScore(editor.score);}else{metronome.setNotationTiming();audio?.setMode('recording');}render();},'Export local edits & load saved');break;
    }
  }
  function onKey(e){if(e.isComposing||e.target!==e.currentTarget||e.key==='Tab')return;const k=e.key.toLowerCase(),mod=e.metaKey||e.ctrlKey;
    if(e.code==='Space'||e.key==='Enter'){e.preventDefault();e.stopPropagation();if(!e.repeat)void play({pause:e.key==='Enter'});return;}
    if(e.altKey){if(!mod&&(k==='arrowleft'||k==='arrowright')){e.preventDefault();e.stopPropagation();attempt(()=>moveNotes(k==='arrowright'?step():subtract(fraction(0),step())));focus();}return;}let handled=true;
    attempt(()=>{if(mod){if(k==='z')action(e.shiftKey?'redo':'undo');else if(k==='y')action('redo');else if(k==='c')copy();else if(k==='v')action('paste');else if(k==='d')action('repeat');else if(k==='a'){selectionKind='bars';const a=active();barRange=[a.index,a.index];selected=new Set((editor.score.bars.find(b=>b.measureId===a.measure.id)?.hits||[]).map(h=>h.id));render();}else handled=false;}
      else if(k==='arrowright')navigate(add(cursor,step()),{extend:e.shiftKey});
      else if(k==='arrowleft')navigate(subtract(cursor,step()),{extend:e.shiftKey});
      else if(k==='arrowup'||k==='arrowdown'){const i=KIT.findIndex(k=>k.id===piece);piece=KIT[clamp(i+(k==='arrowup'?-1:1),0,KIT.length-1)].id;render();}
      else if(k==='home')navigate(active().startPosition);
      else if(k==='end')navigate(subtract(add(active().startPosition,active().measure.length),step()));
      else if(k==='escape'){mode='select';selected.clear();render();}
      else if(k==='n'&&!readOnly){mode='write';render();}
      else if(k==='delete'||k==='backspace')action('delete');
      else if(k==='r')action('rest');
      else if(/^[1-7]$/.test(k))setDuration(2**(7-Number(k)));
      else if(k==='+'||k==='=')setDuration(Math.min(64,value*2));
      else if(k==='-'||k==='_')setDuration(Math.max(1,value/2));
      else if(k==='.')setDuration(value,!dotted);
      else if(k==='/')setDuration(value,dotted,tuplet===3?1:3);
      else if(k==='a'&&!readOnly)setExpression('accent',!(selected.size?selectedHits()[0].accent:expression.accent));
      else if(k==='g'&&!readOnly)setExpression('ghost',!(selected.size?selectedHits()[0].ghost:expression.ghost));
      else{const kit=KIT.find(item=>keyFor(item)===k);if(kit){if(!e.repeat)insert(kit.id);}else handled=false;}
    });
    if(handled){e.preventDefault();e.stopPropagation();focus();}
  }
  const resize=new ResizeObserver(()=>{if(editor&&host.offsetWidth)render();});resize.observe(host);
  const theme=()=>render();window.addEventListener('woodshed:theme',theme);
  if(editor){const current=locate(editor.score.timeline,toQuarter(editor.score.timeline,engine.getPosition()));barRange=[current.index,current.index];cursor=current.startPosition;if(getView().end-getView().start>toTime(editor.score.timeline,current.start+number(current.measure.length)*8)-toTime(editor.score.timeline,current.start))fitBars(current.index,Math.min(current.index+3,editor.score.timeline.measures.length-1));}
  updateTiming();render();
  const sharedUpdate=data=>{if(disposed)return;editor=data?.score?new ScoreEditor(data.score):null;selected.clear();timingSignature='';if(editor){cursor=fraction(Math.round(clamp(number(cursor),0,extent(editor.score.timeline)-.0001)*1e6),1e6);const index=active().index;barRange=[index,index];updateTiming();audio?.setScore(editor.score);}else{audio?.setMode('recording');metronome.setNotationTiming();}render();};
  const unwatch=readOnly?watchSharedNotation(shareToken,sharedUpdate,()=>sharedUpdate(null)):()=>{};
  return {flush:()=>store?.flush(),setVisible(visible){host.hidden=!visible;if(!visible){audio?.setMode('recording');metronome.setNotationTiming();timingSignature='';host.closest('.player').classList.remove('notation-expanded');}else{updateTiming();render();focus();}},
    tick(time){if(!editor||host.hidden||disposed)return;if(layout==='expanded'&&followPlayback&&engine.playing){const current=locate(editor.score.timeline,toQuarter(editor.score.timeline,time)).index;if(current<expandedStart||current>=expandedStart+12){expandedStart=Math.floor(current/12)*12;render();}}
      const view=getView();if(layout!=='expanded'&&JSON.stringify(view)!==lastView){render();return;}
      const surface=host.querySelector('.notation-surface'),head=host.querySelector('.notation-playhead'),q=toQuarter(editor.score.timeline,time),row=surface?._rows?.find(r=>q>=starts(editor.score.timeline)[r.items[0]]&&q<=starts(editor.score.timeline)[r.items.at(-1)]+number(editor.score.timeline.measures[r.items.at(-1)].length));
      if(head){head.hidden=!row||!engine.playing;if(row){head.style.left=row.qx(q)+'px';head.style.top=row.top+'px';head.style.height=row.height+'px';}}},
    destroy(){disposed=true;unwatch();resize.disconnect();window.removeEventListener('woodshed:theme',theme);audio?.destroy();store?.destroy();metronome.setNotationTiming(null,null,false);host.closest('.player')?.classList.remove('notation-expanded');host.remove();}};
}
