import {describe,test,expect} from 'vitest';
import {parseMidiTempo,parseChartTempo,parseBeatText,parseTempoFile,importTempoFile,offsetTempoMap,MAX_TEMPO_FILE_BYTES} from '../src/js/tempo-import.js';
import {compile,timeAt,velocityAt,validateSongMap,defaultSongMap,beatsOf} from '../shared/song-map.ts';
import {number,fraction} from '../shared/notation.ts';

const text=(s)=>Array.from(new TextEncoder().encode(s));
const u16=(n)=>[n>>8&255,n&255];
const u32=(n)=>[n>>>24,n>>>16&255,n>>>8&255,n&255];
const vlq=(n)=>{const b=[n&127];while(n=Math.floor(n/128))b.unshift((n&127)|128);return b;};
const event=(delta,...data)=>[...vlq(delta),...data];
const tempo=(delta,us)=>event(delta,255,81,3,...u32(us).slice(1));
const meter=(delta,n,d)=>event(delta,255,88,4,n,Math.log2(d),24,8);
const end=(delta=0)=>event(delta,255,47,0);
const midi=(tracks,{format=tracks.length>1?1:0,resolution=480}={})=>new Uint8Array([...text('MThd'),...u32(6),...u16(format),...u16(tracks.length),...u16(resolution),...tracks.flatMap(t=>[...text('MTrk'),...u32(t.length),...t])]);
const chart=(sync,extra='',drums='')=>`[Song]\n{\n Resolution = 192\n ${extra}\n}\n[SyncTrack]\n{\n${sync}\n}\n${drums}`;

describe('MIDI tempo maps',()=>{
  test('tempo events retain exact tempo changes and meter changes across tracks',()=>{
    const input=midi([[...tempo(0,500000),...meter(0,4,4),...tempo(1920,600000),...meter(0,3,8),...end(1440)], [...event(240,0x90,60,80),...event(240,0x80,60,0),...end()]]);
    const {map,format}=parseMidiTempo(input,{duration:12});validateSongMap(map);const c=compile(map);
    expect(format).toBe('midi');expect(timeAt(c,4)).toBeCloseTo(2);expect(timeAt(c,5)).toBeCloseTo(2.6);expect(velocityAt(c,5)*60).toBeCloseTo(100);
    expect(map.measures[1]).toMatchObject({numerator:3,denominator:8});expect(map.tailQpm).toBe(100);
  });
  test('retains a partial bar before an off-bar meter change',()=>{
    const {map}=parseMidiTempo(midi([[...tempo(0,500000),...meter(720,3,4),...end()]]),{duration:5});
    expect(map.measures[0].length).toEqual(fraction(3,2));expect(map.measures[1].numerator).toBe(3);
  });
  test('meter changes at unusual tick divisions are not rounded into a different bar position',()=>{
    const {map}=parseMidiTempo(midi([[...tempo(0,500000),...meter(1,3,4),...end()]],{resolution:32767}),{duration:10});expect(map.measures[0].length).toEqual(fraction(1,32767));
  });
  test('omitted tempo uses the standard 120 BPM default, with a warning',()=>{
    const result=parseMidiTempo(midi([[...end(480)]]),{duration:10});expect(result.map.tailQpm).toBe(120);expect(result.warnings[0]).toContain('120 BPM');
  });
  test('last tempo event at a shared tick wins and no duplicate pins are created',()=>{
    const {map}=parseMidiTempo(midi([[...tempo(0,500000),...tempo(0,600000),...end()]]),{duration:10});
    expect(map.pins).toHaveLength(1);expect(map.tailQpm).toBe(100);
  });
  test('extracts channel 10 GM percussion with running status, note-off lengths and velocity',()=>{
    const track=[...tempo(0,500000),...event(0,0x99,36,127),...event(240,38,64),...event(240,36,0),...event(240,0x89,38,0),...end()];
    const {drums}=parseMidiTempo(midi([track]),{duration:10});
    expect(drums.hits[0]).toEqual({q:0,midi:36,durationQ:1,velocity:1});
    expect(drums.hits[1]).toMatchObject({q:.5,midi:38,durationQ:1});expect(drums.hits[1].velocity).toBeCloseTo(64/127);
  });
  test('does not interpret ordinary pitched notes as drums',()=>{
    expect(parseMidiTempo(midi([[...tempo(0,500000),...event(0,0x90,36,100),...end()]]),{duration:10})).not.toHaveProperty('drums');
  });
  test('rejects SMPTE and independent format 2 sequences',()=>{
    expect(()=>parseMidiTempo(midi([[...end()]],{resolution:0xe728}),{duration:10})).toThrow('SMPTE');
    expect(()=>parseMidiTempo(midi([[...end()]],{format:2}),{duration:10})).toThrow('format 2');
  });
  test('rejects malformed events, missing track ends, zero tempo and unsupported meters',()=>{
    for(const track of [[...tempo(0,0),...end()],[...event(0,255,81,4,1,2,3,4),...end()],[...meter(0,17,4),...end()],[...meter(0,4,32),...end()],[...tempo(0,500000)]])expect(()=>parseMidiTempo(midi([track]),{duration:10})).toThrow();
    expect(()=>parseMidiTempo(midi([[...event(0,12,127),...end()]]),{duration:10})).toThrow('running status');
    expect(()=>parseMidiTempo(midi([[0xff,0xff,0xff,0xff,0,...end()]]),{duration:10})).toThrow('variable-length');
  });
  test('rejects truncated input and oversized maps',()=>{
    expect(()=>parseMidiTempo(midi([[...end()]]).slice(0,-1),{duration:10})).toThrow('truncated');
    expect(()=>parseMidiTempo(new Uint8Array(MAX_TEMPO_FILE_BYTES+1),{duration:10})).toThrow('10 MB');
    expect(()=>parseMidiTempo(midi([[...tempo(0,60000),...end()]]),{duration:86400})).toThrow('1024');
  });
});

describe('Clone Hero tempo maps',()=>{
  test('loads decimal BPM, explicit denominator and a positive audio offset',()=>{
    const {map,warnings}=parseChartTempo(chart('0 = B 117600\n0 = TS 4\n768 = B 140000\n768 = TS 7 3','Offset = 1.25'),{duration:20});
    const c=compile(map);expect(timeAt(c,0)).toBeCloseTo(1.25);expect(timeAt(c,4)).toBeCloseTo(1.25+4*60/117.6);expect(map.measures[1]).toMatchObject({numerator:7,denominator:8});expect(warnings[0]).toContain('1.250');
  });
  test('negative chart offsets keep bar positions instead of clamping pins together',()=>{
    const {map}=parseChartTempo(chart('0 = B 120000\n768 = B 100000','Offset = -0.25'),{duration:10});
    const c=compile(map);expect(timeAt(c,1)).toBeCloseTo(.25);expect(timeAt(c,4)).toBeCloseTo(1.75);expect(map.pins[0].time).toBe(0);expect(number(map.pins[0].position)).toBeCloseTo(.5);
  });
  test('editor A anchors do not override playback B events',()=>{
    const {map}=parseChartTempo(chart('0 = B 120000\n768 = B 120000\n768 = A 1000000'),{duration:10});expect(timeAt(compile(map),4)).toBeCloseTo(2);
  });
  test('extracts ExpertDrums and honors cymbal flags while warning about approximations',()=>{
    const drums='[ExpertDrums]\n{\n0 = N 0 0\n0 = N 2 0\n0 = N 66 0\n192 = N 3 0\n384 = N 4 0\n384 = N 68 0\n}';
    const result=parseChartTempo(chart('0 = B 120000','',drums),{duration:10});
    expect(result.drums.hits.map(h=>[h.q,h.midi])).toEqual([[0,36],[0,42],[1,47],[2,49]]);expect(result.drums.warnings[0]).toContain('approximate');
  });
  test('rejects bad resolution, unsupported meter and malformed sync rows',()=>{
    expect(()=>parseChartTempo('[Song]{Resolution = 0}\n[SyncTrack]{0 = B 120000}',{duration:10})).toThrow('resolution');
    expect(()=>parseChartTempo(chart('0 = B 0'),{duration:10})).toThrow('tempo');
    expect(()=>parseChartTempo(chart('0 = B 120000\n0 = TS 4 5'),{duration:10})).toThrow('meter');
    expect(()=>parseChartTempo(chart('0 = B NaN'),{duration:10})).toThrow('value');
  });
});

describe('beat timestamp files and dispatch',()=>{
  test('imports headers, comments, pickups and changing downbeat spacing',()=>{
    const {map,warnings}=parseBeatText('# Source\nbeat_time_stamp beat_position_in_bar bar_number\n0.25 3 0\n.75 1 1\n1.25 2 1\n1.75 3 1\n2.25 1 2\n2.8 2 2\n3.4 1 3',{duration:10});
    validateSongMap(map);const c=compile(map);expect(timeAt(c,0)).toBe(.25);expect(timeAt(c,1)).toBe(.75);expect(map.measures[0].label).toBe('Pickup');expect(map.measures[1].numerator).toBe(3);expect(map.measures[2].numerator).toBe(2);expect(warnings[0]).toContain('quarter notes');
  });
  test('an explicit denominator keeps mixed numerators without guessing a note unit',()=>{
    const {map,warnings}=parseBeatText('0 1\n.5 2\n1 3\n1.5 4\n2 1\n2.5 2\n3 3\n3.5 1',{duration:8,denominator:4});
    expect(map.measures[0]).toMatchObject({numerator:4,denominator:4});expect(map.measures[1]).toMatchObject({numerator:3,denominator:4});expect(warnings).toEqual([]);
  });
  test('six eighth-note annotations with a6/8 hint retain every annotated pulse',()=>{
    const rows=Array.from({length:13},(_,i)=>`${i*.25} ${i%6+1}`).join('\n');
    const {map,warnings}=parseBeatText(rows,{duration:4,meter:{numerator:6,denominator:8}}),c=compile(map);
    expect(map.measures[0]).toMatchObject({numerator:6,denominator:8,length:fraction(3),grouping:[1,1,1,1,1,1]});
    expect(number(map.pins[1].position)).toBe(.5);expect(timeAt(c,3)).toBeCloseTo(1.5);expect(beatsOf(map,c,4).slice(0,13).map(b=>b.time)).toEqual(Array.from({length:13},(_,i)=>i*.25));expect(warnings).toEqual([]);
  });
  test('two felt pulses per6/8 bar become dotted quarters without moving timestamps',()=>{
    const {map,warnings}=parseBeatText('0 1\n.75 2\n1.5 1\n2.25 2\n3 1',{duration:4,meter:{numerator:6,denominator:8}}),c=compile(map);
    expect(map.measures[0]).toMatchObject({numerator:6,denominator:8,length:fraction(3),grouping:[3,3]});expect(number(map.pins[1].position)).toBe(1.5);expect(beatsOf(map,c,4).slice(0,5).map(b=>b.time)).toEqual([0,.75,1.5,2.25,3]);expect(warnings).toEqual([]);
  });
  test('invalid and ambiguous meter hints remain explicit quarter-note fallbacks',()=>{
    for(const options of [{denominator:3},{meter:{numerator:0,denominator:8}},{meter:{numerator:6,denominator:8}}]) {
      const {map,warnings}=parseBeatText('0 1\n.5 2\n1 3\n1.5 1',{duration:4,...options});expect(map.measures[0]).toMatchObject({numerator:3,denominator:4});expect(warnings[0]).toContain('no usable meter hint');
    }
  });
  test('rejects duplicates, disorder, invalid columns and oversized beat sets',()=>{
    for(const text of ['0 1\n0 2','1 1\n.5 2','0\n1','0 1\n1 0','0 1 x\n1 2 1','-1 1\n0 2'])expect(()=>parseBeatText(text,{duration:10})).toThrow();
    expect(()=>parseBeatText(Array.from({length:8001},(_,i)=>`${i*.5} ${i%4+1}`).join('\n'),{duration:5000})).toThrow('8000');
  });
  test('dispatches MIDI by header and chart by content and gives actionable GP guidance',async()=>{
    expect(parseTempoFile(midi([[...end()]]),{name:'notes.bin',duration:10}).format).toBe('midi');
    expect(parseTempoFile(chart('0 = B 120000'),{duration:10}).format).toBe('chart');
    expect(()=>parseTempoFile('whatever',{name:'tab.gp5',duration:10})).toThrow('Export');
    const file={name:'beats.tsv',size:20,arrayBuffer:async()=>new TextEncoder().encode('0 1\n.5 2').buffer};
    expect((await importTempoFile(file,{duration:10})).format).toBe('beats');
  });
  test('requires a valid song duration',()=>{
    expect(()=>parseTempoFile('0 1\n.5 2')).toThrow('Open a song');
  });
});

describe('offset adjustment',()=>{
  test('shifts without mutating source or changing tempo',()=>{
    const base=defaultSongMap(10,117.6,4,4,2),shifted=offsetTempoMap(base,.25);expect(base.pins[0].time).toBe(2);expect(shifted.pins[0].time).toBe(2.25);expect(velocityAt(compile(shifted),4)*60).toBeCloseTo(117.6);
  });
  test('clipping all original pins still preserves the final tempo and bar numbering',()=>{
    const base={...defaultSongMap(10),pins:[{position:fraction(0),time:0},{position:fraction(4),time:4}]};delete base.tailQpm;
    const shifted=offsetTempoMap(base,-5),c=compile(shifted);expect(timeAt(c,6)).toBeCloseTo(1);expect(velocityAt(c,8)*60).toBeCloseTo(60);
  });
  test('late-recording offsets stay within the native fraction bounds',()=>{
    const base=defaultSongMap(2000,117.6);const shifted=offsetTempoMap(base,-1000.123456);validateSongMap(shifted);expect(timeAt(compile(shifted),2000)).toBeCloseTo(2000*60/117.6-1000.123456,4);
  });
  test('declines clipping through a ramp instead of changing its timing silently',()=>{
    const base=defaultSongMap(10);base.pins=[{position:fraction(0),time:0,ramp:true},{position:fraction(4),time:3},{position:fraction(8),time:5}];
    expect(()=>offsetTempoMap(base,-1)).toThrow('gradual tempo ramp');
  });
});
