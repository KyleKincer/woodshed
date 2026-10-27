// Tempo-only interchange. Files are parsed locally; notes and audio are never uploaded.
import {fraction, number, add, subtract, compare, id, MAX_MEASURES} from '../../shared/notation.ts';
import {compile, timeAt, positionAt, normalize, validateSongMap, fromBeats, MAX_PINS, MIN_QPM, MAX_QPM} from '../../shared/song-map.ts';

export const MAX_TEMPO_FILE_BYTES = 10 * 1024 * 1024;
const MAX_EVENTS = 1000000;
const fail = (message) => { throw new Error(message); };
const finite = (n) => Number.isFinite(n);
const qFraction = (q) => { const denominator=Math.max(1,Math.min(1000000,Math.floor(99999999/Math.max(1,Math.abs(q))))); return fraction(Math.round(q*denominator),denominator); };
const validDuration = (duration) => { if (!finite(duration) || duration <= 0) fail('Open a song before importing a tempo map.'); };
const validTick = (tick) => { if (!Number.isSafeInteger(tick) || tick < 0) fail('The tempo file contains an invalid tick position.'); };
const validTempo = (bpm) => { if (!finite(bpm) || bpm < MIN_QPM || bpm > MAX_QPM) fail('The tempo file needs a tempo between 10 and 1000 quarter notes per minute.'); };
function validMeter(numerator, denominator) {
  if (!Number.isInteger(numerator) || numerator < 1 || numerator > 16 || ![1,2,4,8,16].includes(denominator)) fail('This file contains a meter Woodshed cannot represent (use 1–16 beats and a denominator of 1, 2, 4, 8 or 16).');
}
function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  fail('Could not read this tempo file.');
}
function checkedText(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_TEMPO_FILE_BYTES) fail('Choose a tempo file smaller than 10 MB.');
  return text.replace(/^\uFEFF/, '');
}
function dedupe(events) {
  const out = [];
  for (const e of [...events].sort((a,b) => a.tick-b.tick)) { if (out.at(-1)?.tick === e.tick) out[out.length-1] = e; else out.push(e); }
  return out;
}

/** Shift a candidate without changing any intervals. Pre-zero pins are represented by a boundary pin. */
export function offsetTempoMap(input, seconds) {
  if (!finite(seconds)) fail('Enter a valid offset in seconds.');
  const map = structuredClone(input), c = compile(map);
  if (map.pins[0].time + seconds < 0) {
    if (c.spans.some(s => s.ramp && s.t0 < -seconds && s.t1 > -seconds)) fail('Keep the start of a gradual tempo ramp inside the recording when shifting this map.');
    const q = positionAt(c, -seconds);
    if (!map.tailQpm) { validTempo(c.tail*60); map.tailQpm=c.tail*60; }
    map.pins = map.pins.filter(p => p.time + seconds > 0.0001).map(p => ({...p, time:p.time+seconds}));
    map.pins.unshift({position:qFraction(q), time:0});
  } else map.pins.forEach(p => { p.time += seconds; });
  validateSongMap(map);
  return map;
}

export const shiftTempoMap = offsetTempoMap;

function eventMap(tempos, meters, resolution, duration, offset = 0) {
  validDuration(duration);
  if (!Number.isInteger(resolution) || resolution < 1 || resolution > 32767) fail('The file has an invalid ticks-per-quarter-note resolution.');
  if (!finite(offset) || Math.abs(offset) > 86400) fail('The chart has an invalid audio offset.');
  tempos = dedupe([{tick:0, bpm:120}, ...tempos]);
  meters = dedupe([{tick:0, numerator:4, denominator:4}, ...meters]);
  if (tempos.length > MAX_PINS) fail('The tempo file has more than 8000 tempo changes.');
  for (const t of tempos) { validTick(t.tick); validTempo(t.bpm); }
  for (const m of meters) { validTick(m.tick); validMeter(m.numerator,m.denominator); }
  let seconds = 0;
  const pins = tempos.map((t,i) => {
    if (i) seconds += (t.tick-tempos[i-1].tick)/resolution*60/tempos[i-1].bpm;
    return {position:fraction(t.tick,resolution), time:seconds};
  });
  const map = {version:1, measures:[], pins, tailQpm:tempos.at(-1).bpm};
  const c = compile(map);
  const endQ = Math.max(positionAt(c, Math.max(0,duration-offset)), number(pins.at(-1).position), meters.at(-1).tick/resolution);
  let q = fraction(0), meterIndex = 0;
  do {
    while (meters[meterIndex+1] && compare(fraction(meters[meterIndex+1].tick,resolution),q)<=0) meterIndex++;
    const meter = meters[meterIndex], next = meters[meterIndex+1] ? fraction(meters[meterIndex+1].tick,resolution) : null;
    const fullLength=fraction(4*meter.numerator,meter.denominator);
    const length=next && compare(next,add(q,fullLength))<0 ? subtract(next,q) : fullLength;
    if (!(number(length) > 0)) fail('The tempo file has an invalid meter change.');
    map.measures.push({id:id(), numerator:meter.numerator, denominator:meter.denominator, length, label:''});
    if (map.measures.length > MAX_MEASURES) fail('This tempo map needs more than 1024 bars.');
    q = add(q,length);
  } while (number(q) <= endQ+1e-9);
  const shifted = offset ? offsetTempoMap(map,offset) : map;
  normalize(shifted,duration);
  validateSongMap(shifted);
  return shifted;
}

export function parseMidiTempo(value, {duration} = {}) {
  const bytes = bytesOf(value);
  if (bytes.length > MAX_TEMPO_FILE_BYTES) fail('Choose a tempo file smaller than 10 MB.');
  let p=0, limit=bytes.length;
  const need = (n) => { if (p+n > limit) fail('This MIDI file is truncated.'); };
  const read = () => { need(1); return bytes[p++]; };
  const u16 = () => read()*256+read();
  const u32 = () => read()*16777216+read()*65536+read()*256+read();
  const tag = () => String.fromCharCode(read(),read(),read(),read());
  const vlq = () => { let v=0; for(let i=0;i<4;i++){const b=read();v=v*128+(b&127);if(!(b&128))return v;} fail('The MIDI file contains an invalid variable-length value.'); };
  if(tag() !== 'MThd') fail('Choose a standard MIDI file (.mid or .midi).');
  const headerLength=u32();
  if(headerLength<6) fail('The MIDI header is invalid.');
  need(headerLength);
  const headerEnd=p+headerLength, format=u16(), tracks=u16(), resolution=u16();
  if(format>1) fail('MIDI format 2 contains independent songs. Export a format 0 or 1 MIDI file instead.');
  if(!tracks || tracks>1024 || (format===0&&tracks!==1)) fail('The MIDI track count is invalid.');
  if(resolution&0x8000) fail('SMPTE MIDI timing is not a musical tempo map. Export a ticks-per-quarter-note MIDI file instead.');
  p=headerEnd;
  const tempos=[], meters=[], drumHits=[]; let events=0;
  for(let track=0;track<tracks;track++) {
    limit=bytes.length;
    if(tag()!=='MTrk') fail('The MIDI file is missing a track.');
    const size=u32();need(size);const end=p+size;limit=end;
    let tick=0,running=0,ended=false;const activeDrums=new Map();
    while(p<end) {
      if(++events>MAX_EVENTS) fail('This MIDI file has too many events.');
      tick+=vlq();validTick(tick);
      let status=read();
      if(status<0x80) { if(!running)fail('The MIDI file has invalid running status.');p--;status=running; }
      if(status<0xf0) {
        running=status;const count=(status&0xe0)===0xc0?1:2,values=[];
        for(let i=0;i<count;i++) {const value=read();if(value>=0x80)fail('The MIDI file has an invalid note event.');values.push(value);}
        const kind=status&0xf0;
        if((status&0x0f)===9 && (kind===0x90||kind===0x80)) {
          const [midi,velocity]=values,active=activeDrums.get(midi)||[];
          if(kind===0x90&&velocity>0) {
            if(drumHits.length>=16000)fail('This MIDI file contains more than 16000 drum hits.');
            const hit={q:tick/resolution,midi,durationQ:0,velocity:velocity/127};drumHits.push(hit);active.push(hit);activeDrums.set(midi,active);
          } else if(active.length) {const hit=active.shift();hit.durationQ=tick/resolution-hit.q;}
        }
      } else if(status===0xff) {
        running=0;const type=read(),length=vlq();need(length);
        if(type===0x51) { if(length!==3)fail('The MIDI tempo event is invalid.');const us=bytes[p]*65536+bytes[p+1]*256+bytes[p+2];if(!us)fail('The MIDI tempo must be positive.');tempos.push({tick,bpm:60000000/us}); }
        else if(type===0x58) { if(length!==4)fail('The MIDI time signature is invalid.');meters.push({tick,numerator:bytes[p],denominator:2**bytes[p+1]}); }
        else if(type===0x2f) { if(length)fail('The MIDI end-of-track event is invalid.');ended=true; }
        p+=length;
        if(ended) { if(p!==end)fail('The MIDI file contains data after an end-of-track event.');break; }
      } else if(status===0xf0||status===0xf7) { running=0;const length=vlq();need(length);p+=length; }
      else fail('The MIDI file contains an unsupported system event.');
    }
    if(!ended) fail('The MIDI track has no end-of-track event.');
    limit=bytes.length;
  }
  if(p!==bytes.length) fail('The MIDI file has unexpected trailing data.');
  return {map:eventMap(tempos,meters,resolution,duration),format:'midi',warnings:tempos.length?[]:['This MIDI stores no tempo events; the standard default of 120 BPM is being used.'],...(drumHits.length?{drums:{hits:drumHits.sort((a,b)=>a.q-b.q),source:'midi',warnings:[]}}:{})};
}

export function parseChartTempo(text, {duration} = {}) {
  text=checkedText(text);
  const section = (name) => text.match(new RegExp('\\['+name+'\\]\\s*\\{([\\s\\S]*?)\\}'))?.[1];
  const song=section('Song'),sync=section('SyncTrack');
  if(song===undefined||sync===undefined) fail('Choose a Clone Hero .chart file containing Song and SyncTrack sections.');
  const resolution=Number(song.match(/^\s*Resolution\s*=\s*"?(\d+)"?\s*$/m)?.[1]);
  const offsetLine=song.match(/^\s*Offset\s*=\s*(.*?)\s*$/m)?.[1];
  const offset=offsetLine===undefined?0:Number(offsetLine.replace(/^"|"$/g,''));
  const tempos=[],meters=[];let rows=0;
  for(const raw of sync.split(/\r?\n/)) {
    const line=raw.replace(/\/\/.*$/,'').trim();if(!line)continue;
    if(++rows>MAX_PINS*3)fail('This chart has too many synchronization events.');
    const m=line.match(/^(\d+)\s*=\s*(B|TS|A)\s+(.+)$/);
    if(!m)fail('The chart contains an invalid synchronization event.');
    const tick=Number(m[1]),values=m[3].trim().split(/\s+/).map(Number);validTick(tick);
    if(values.some(v=>!Number.isSafeInteger(v)||v<0))fail('The chart contains an invalid synchronization value.');
    if(m[2]==='B') {if(values.length!==1)fail('The chart tempo event is invalid.');tempos.push({tick,bpm:values[0]/1000});}
    else if(m[2]==='TS') {if(values.length<1||values.length>2)fail('The chart time signature is invalid.');meters.push({tick,numerator:values[0],denominator:values.length===2?2**values[1]:4});}
    else if(values.length!==1)fail('The chart anchor event is invalid.');
    // A marks editor locks; playback follows the B events, as specified by .chart.
  }
  if(!tempos.length)fail('This chart contains no tempo events.');
  const drumSection=section('ExpertDrums'),drumHits=[];
  if(drumSection!==undefined) {
    const notes=new Map();
    for(const raw of drumSection.split(/\r?\n/)) {
      const m=raw.trim().match(/^(\d+)\s*=\s*N\s+(\d+)\s+(\d+)\s*$/);if(!m)continue;
      const tick=Number(m[1]),lane=Number(m[2]),length=Number(m[3]);validTick(tick);validTick(length);
      if(!notes.has(tick))notes.set(tick,[]);notes.get(tick).push({lane,length});
      if(notes.size>16000)fail('This chart contains too many drum hits.');
    }
    for(const [tick,at] of notes) for(const note of at) {
      const cymbal=at.some(n=>n.lane===note.lane+64),lane=note.lane;
      const midi=lane===0||lane===32?36:lane===1?38:lane===2?(cymbal?42:48):lane===3?(cymbal?51:47):lane===4?(cymbal?49:45):lane===5?49:null;
      if(midi===null)continue;
      if(drumHits.length>=16000)fail('This chart contains more than 16000 drum hits.');
      drumHits.push({q:tick/resolution,midi,durationQ:note.length/resolution,velocity:.8});
    }
  }
  return {map:eventMap(tempos,meters,resolution,duration,offset),format:'chart',warnings:offset?[`The chart's ${offset.toFixed(3)} s audio offset is included.`]:[],...(drumHits.length?{drums:{hits:drumHits.sort((a,b)=>a.q-b.q),source:'chart',warnings:['Game lanes approximate the kit: yellow cymbal becomes hi-hat, blue cymbal ride, and green cymbal crash. Check the imported drum sounds and rhythms.']}}:{})};
}

/** Harmonix/Isophonics rows: seconds, beat-in-bar, optional bar number. Beat units are not encoded. */
export function parseBeatText(text, {duration, denominator, meter} = {}) {
  validDuration(duration);text=checkedText(text);
  const beats=[];let previous=-Infinity;
  for(const raw of text.split(/\r?\n/)) {
    const line=raw.replace(/#.*/,'').trim();if(!line)continue;
    if(!beats.length && /^(beat_time_stamp|time|timestamp)(?:[,\s]|$)/i.test(line))continue;
    const columns=line.split(/[,\s]+/),time=Number(columns[0]),beat=Number(columns[1]);
    if(columns.length<2||columns.length>3||!finite(time)||time<0||!Number.isInteger(beat)||beat<1||beat>16||(columns.length===3&&!Number.isInteger(Number(columns[2]))))fail('Use beat timestamps with two or three columns: seconds, beat in bar, and optionally bar number.');
    if(time<=previous+0.0001)fail('Beat timestamps must increase without duplicates.');
    if(beats.length>=MAX_PINS)fail('This beat file has more than 8000 beats.');
    if(beats.length && beat!==1 && beat!==beats.at(-1).index+1)fail('Beat numbers must increase consecutively inside each bar.');
    beats.push({time,downbeat:beat===1,index:beat});previous=time;
  }
  if(beats.length<2)fail('A beat file needs at least two beat timestamps.');
  const span=Math.max(duration,beats.at(-1).time+0.001);
  const map=fromBeats(beats,span),warnings=[];
  const hintedDenominator=meter?.denominator ?? denominator;
  let unitsPerPulse=1,knownUnit=[1,2,4,8,16].includes(hintedDenominator);
  if(meter && (!Number.isInteger(meter.numerator)||meter.numerator<1||meter.numerator>16))knownUnit=false;
  // A 6/8 annotation may count six eighths or two dotted quarters. Only a
  // complete bar resolves that distinction; the timestamps alone cannot.
  if(knownUnit && meter?.numerator>=6 && meter.numerator%3===0 && [8,16].includes(hintedDenominator)) {
    const downbeats=beats.map((b,i)=>b.downbeat?i:-1).filter(i=>i>=0),counts=new Map();
    for(let i=1;i<downbeats.length;i++){const count=downbeats[i]-downbeats[i-1];counts.set(count,(counts.get(count)||0)+1);}
    const count=[...counts].sort((a,b)=>b[1]-a[1])[0]?.[0];
    if(count===meter.numerator)unitsPerPulse=1;
    else if(count===meter.numerator/3)unitsPerPulse=3;
    else knownUnit=false;
  }
  if(knownUnit) {
    for(const m of map.measures) {
      const pulseCount=m.numerator;
      m.numerator=pulseCount*unitsPerPulse;m.denominator=hintedDenominator;
      validMeter(m.numerator,m.denominator);
      m.length=fraction(m.length.n*4*unitsPerPulse,m.length.d*hintedDenominator);
      m.grouping=Array(pulseCount).fill(unitsPerPulse);
    }
    for(const p of map.pins)p.position=fraction(p.position.n*4*unitsPerPulse,p.position.d*hintedDenominator);
  } else warnings.push('Beat timestamps do not encode a note value; no usable meter hint was available, so beats are imported as quarter notes. Check compound meters in the map.');
  validateSongMap(map);
  if(map.measures.length>MAX_MEASURES)fail('This tempo map needs more than 1024 bars.');
  return {map,format:'beats',warnings};
}

export function parseTempoFile(value, {name='',duration,denominator,meter} = {}) {
  const extension=name.toLowerCase().split('.').at(-1);
  if(['gp','gp3','gp4','gp5','gpx','musicxml','xml'].includes(extension))fail('Export the tempo map as MIDI from your score editor, then import the .mid file.');
  if(typeof value!=='string') {
    const bytes=bytesOf(value);
    if(bytes.length>MAX_TEMPO_FILE_BYTES)fail('Choose a tempo file smaller than 10 MB.');
    if(bytes.length>=4&&String.fromCharCode(...bytes.subarray(0,4))==='MThd')return parseMidiTempo(bytes,{duration});
    if(extension==='mid'||extension==='midi')fail('Choose a standard MIDI file (.mid or .midi).');
    value=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  }
  return extension==='chart'||/\[SyncTrack\]/.test(value)?parseChartTempo(value,{duration}):parseBeatText(value,{duration,denominator,meter});
}

export async function importTempoFile(file, {duration,denominator,meter} = {}) {
  if(!file||typeof file.arrayBuffer!=='function')fail('Choose a MIDI, Clone Hero chart, or beat timestamp file.');
  if(file.size>MAX_TEMPO_FILE_BYTES)fail('Choose a tempo file smaller than 10 MB.');
  return parseTempoFile(await file.arrayBuffer(),{name:file.name,duration,denominator,meter});
}
