// @vitest-environment node
import {describe, test, expect} from 'vitest';
import {Settings, importer, exporter, model} from '@coderline/alphatab';
import {parseGuitarPro} from '../src/js/guitar-pro-import.js';
import {importTempoFile, MAX_TEMPO_FILE_BYTES} from '../src/js/tempo-import.js';
import {compile, timeAt, validateSongMap} from '../shared/song-map.ts';
import {number, fraction, validateScore} from '../shared/notation.ts';
import {importDrumHits} from '../src/js/notation/import-drums.js';
import fixtures from './fixtures/guitar-pro/scores.json';

const bytes = name => Uint8Array.from(atob(fixtures[name]), c => c.charCodeAt(0));
const supportedFixtures = Object.keys(fixtures).filter(name=>!name.includes('time-signatures'));
const gp = (tex, change) => {
  const score = importer.ScoreLoader.loadAlphaTex(tex, new Settings());
  change?.(score);
  return new exporter.Gp7Exporter().export(score);
};
const kit = '\\tempo 120 \\instrument percussion \\articulation defaults . ';
const section = (score, bar, text) => { const s = new model.Section(); s.text = text; score.masterBars[bar].section = s; };

describe('direct Guitar Pro imports', () => {
  test.each(supportedFixtures)('loads real upstream binary %s', name => {
    const result = parseGuitarPro(bytes(name), {duration:25});
    validateSongMap(result.map);
    expect(result.format).toBe('guitar-pro');
    expect(result.warnings.join(' ')).toContain('score playback');
  });
  test('retains nominal meter changes and rejects a real legacy file with unsupported meter', () => {
    const data=gp('\\tempo 120 . \\ts 4 4 0.6.1 | \\ts 7 8 0.6.8 0.6.8 0.6.8 0.6.8 0.6.8 0.6.8 0.6.8');
    const {map}=parseGuitarPro(data,{duration:25});
    expect(map.measures[0]).toMatchObject({numerator:4,denominator:4});
    expect(map.measures[1]).toMatchObject({numerator:7,denominator:8});
    expect(()=>parseGuitarPro(bytes('guitarpro4/time-signatures.gp4'),{duration:25})).toThrow('meter');
  });
  test('GP5 percussion imports GM kit hits rather than pitched guitar notes', () => {
    const {drums} = parseGuitarPro(bytes('guitarpro5/percussion-all.gp5'), {duration:25});
    expect(drums.source).toBe('guitar-pro');
    expect(drums.hits.length).toBeGreaterThan(10);
    expect(drums.hits.some(hit=>hit.midi===36)).toBe(true);
    expect(parseGuitarPro(bytes('guitarpro3/strings.gp3'), {duration:25}).drums).toBeUndefined();
  });
  test('a real GP7 pickup ends after two quarter notes, retaining the following 4/4 downbeat', () => {
    const {map} = parseGuitarPro(bytes('guitarpro7/anacrusis.gp'), {duration:25});
    expect(map.measures[0]).toMatchObject({numerator:4, denominator:4});
    expect(number(map.measures[0].length)).toBe(2);
    expect(number(map.measures[1].length)).toBe(4);
  });
  test('GP8 within-bar tempo changes retain their musical coordinates', () => {
    const {map} = parseGuitarPro(bytes('guitarpro8/beat-tempo-change.gp'), {duration:25});
    expect(map.pins.some(pin=>Math.abs(number(pin.position)-2)<.001)).toBe(true);
    expect(map.pins.some(pin=>Math.abs(number(pin.position)-6.55)<.002)).toBe(true);
  });
  test('expands a repeated bar and its drum notes in playback order', () => {
    const data = gp('\\tempo 120 \\instrument percussion \\articulation defaults . SnareHit SnareHit SnareHit SnareHit | SnareHit SnareHit SnareHit SnareHit', score=>{
      score.masterBars[0].isRepeatStart=true;
      score.masterBars[1].repeatCount=2;
      score.rebuildRepeatGroups();
    });
    const result=parseGuitarPro(data,{duration:9});
    expect(result.drums.hits.map(h=>h.q)).toEqual(Array.from({length:16},(_,i)=>i));
    expect(timeAt(compile(result.map),12)).toBeCloseTo(6);
  });
  test('reads drum articulations, accents and ghosts from the score model, not the MIDI rendering', () => {
    const {map, drums} = parseGuitarPro(gp(kit+'(ChinaHit KickHit2).4 HiHatHalf{ac}.4 RideEdge{hac}.4 SnareRimShot{g}.4 | CrashMediumHit.4 ChinaChoke.4 RideBell.4 SnareSideStick.4'), {duration:5});
    expect(drums.hits.map(h=>[h.q,h.gp,h.midi])).toEqual([[0,52,52],[0,36,36],[1,92,46],[2,93,51],[3,91,38],[4,57,57],[5,96,52],[6,53,53],[7,37,37]]);
    expect(drums.hits[2]).toMatchObject({accent:true,heavy:false,ghost:false});
    expect(drums.hits[3]).toMatchObject({accent:false,heavy:true});
    expect(drums.hits[4]).toMatchObject({ghost:true,accent:false});
    const {score} = importDrumHits(drums.hits, map, {source:drums.source});
    expect(score.bars.flatMap(b=>b.hits).map(h=>h.instrument)).toEqual(['china','kick','halfHat','rideEdge','rimshot','crash2','chinaChoke','rideBell','crossStick']);
  });
  test('grace notes become flams and drags, tremolo becomes a roll, and tuplet groups are reported', () => {
    const data = gp(kit+'SnareHit.4 SnareHit.4 SnareHit.4 SnareHit.4 | SnareHit.16{gr} SnareHit.4 SnareHit.16{gr} SnareHit.16{gr} SnareHit.4 SnareHit.8{tu 3} SnareHit.8{tu 3} SnareHit.8{tu 3} SnareHit.4{tp 16} | SnareHit.4{tu 3} SnareHit.4{tu 3} SnareHit.4{tu 3} r.2');
    const result = parseGuitarPro(data, {duration:7});
    const {drums} = result;
    expect(drums.hits.map(h=>h.q)).toEqual([0,1,2,3,4,5,6,6+1/3,6+2/3,7,8,8+2/3,8+4/3].map(q=>expect.closeTo(q,9)));
    expect(drums.hits[4]).toMatchObject({flam:true,drag:false}); expect(drums.hits[5]).toMatchObject({flam:false,drag:true});
    expect(drums.hits[9].roll).toBe(2); expect(drums.hits[8]).not.toHaveProperty('roll');
    // Snare-only groups belong to the hands voice.
    expect(drums.tuplets).toEqual([{q:6,length:1,count:3,voice:1},{q:8,length:2,count:3,voice:1}]);
    expect(result.warnings.join(' ')).not.toContain('Grace hits before the first downbeat');
    // The eighth-note triplet restates the beat grid; the quarter-note triplet does not.
    const {score} = importDrumHits(drums.hits, result.map, {source:drums.source, tuplets:drums.tuplets});
    validateScore(score);
    const [, second, third] = score.bars;
    expect(second).not.toHaveProperty('tuplets');
    expect(second.hits.map(h=>h.offset)).toEqual([fraction(0),fraction(1),fraction(2),fraction(7,3),fraction(8,3),fraction(3)]);
    expect(second.hits.slice(0,2)).toMatchObject([{flam:true},{flam:false,drag:true}]);expect(second.hits[5].roll).toBe(2);
    expect(third.tuplets).toEqual([{start:fraction(0),length:fraction(2),count:3,voice:1}]);
    expect(third.hits.map(h=>h.offset)).toEqual([fraction(0),fraction(2,3),fraction(4,3)]);
  });
  test('grace hits before the first downbeat are disclosed', () => {
    const result = parseGuitarPro(gp(kit+'SnareHit.16{gr} SnareHit.4 SnareHit.4 SnareHit.4 SnareHit.4'), {duration:3});
    expect(result.warnings.join(' ')).toContain('Grace hits before the first downbeat');
    expect(result.drums.hits[0]).toMatchObject({q:0,flam:true});
  });
  test('section names label the played bars, repeated sections included', () => {
    const data = gp(kit+'SnareHit.1 | SnareHit.1 | SnareHit.1', score=>{
      section(score,0,'  Intro  ');section(score,1,'Verse');
      score.masterBars[1].isRepeatStart=true;score.masterBars[1].repeatCount=2;score.rebuildRepeatGroups();
    });
    const {map, drums} = parseGuitarPro(data, {duration:9});
    expect(map.measures.slice(0,4).map(m=>m.label)).toEqual(['Intro','Verse','Verse','']);
    validateSongMap(map);
    expect(drums.hits.map(h=>h.q)).toEqual([0,4,8,12]);
  });
  test('tempo returns to the earlier marking when a repeated section restarts',()=>{
    const data=gp('\\tempo 120 . 0.6.1 | \\tempo 60 0.6.1',score=>{
      score.masterBars[0].isRepeatStart=true;score.masterBars[1].repeatCount=2;score.rebuildRepeatGroups();
    });
    const {map}=parseGuitarPro(data,{duration:13}),timing=compile(map);
    expect(timeAt(timing,4)).toBeCloseTo(2);
    expect(timeAt(timing,8)).toBeCloseTo(6);
    expect(timeAt(timing,12)).toBeCloseTo(8);
    expect(timeAt(timing,16)).toBeCloseTo(12);
  });
  test('plays alternate endings once in their correct repeat passes',()=>{
    const data=gp('\\tempo 120 \\instrument percussion \\articulation defaults . SnareHit SnareHit SnareHit SnareHit | CymbalHit CymbalHit CymbalHit CymbalHit | SnareHit SnareHit SnareHit SnareHit',score=>{
      score.masterBars[0].isRepeatStart=true;
      score.masterBars[1].alternateEndings=1;score.masterBars[1].repeatCount=2;
      score.masterBars[2].alternateEndings=2;score.rebuildRepeatGroups();
    });
    const {drums}=parseGuitarPro(data,{duration:9});
    expect(drums.hits.map(h=>h.q)).toEqual(Array.from({length:16},(_,i)=>i));
    expect(drums.hits.map(h=>h.midi)).toEqual([...Array(4).fill(38),...Array(4).fill(49),...Array(8).fill(38)]);
  });
  test('a percussion staff on a custom channel remains a drum draft',()=>{
    const data=gp('\\instrument percussion \\articulation defaults . SnareHit SnareHit SnareHit SnareHit',score=>{
      score.tracks[0].playbackInfo.primaryChannel=3;score.tracks[0].playbackInfo.secondaryChannel=3;
    });
    const {drums}=parseGuitarPro(data,{duration:4});
    expect(drums.hits.map(h=>h.midi)).toEqual([38,38,38,38]);
  });
  test('a pitched staff on MIDI channel 10 does not become invented drum notation',()=>{
    const data=gp('0.6.4 0.6.4 0.6.4 0.6.4',score=>{
      score.tracks[0].playbackInfo.primaryChannel=9;score.tracks[0].playbackInfo.secondaryChannel=9;
    });
    expect(parseGuitarPro(data,{duration:4}).drums).toBeUndefined();
  });
  test('discloses backing-track synchronization instead of treating it as score tempo',()=>{
    const data=gp('\\tempo 120 . 0.6.1 | 0.6.1',score=>{
      score.applyFlatSyncPoints([
        {barIndex:0,barPosition:0,barOccurence:0,millisecondOffset:1000},
        {barIndex:1,barPosition:0,barOccurence:0,millisecondOffset:5000},
      ]);
    });
    const result=parseGuitarPro(data,{duration:8});
    expect(result.warnings.join(' ')).toContain('sync points are not applied');
    expect(timeAt(compile(result.map),4)).toBeCloseTo(2);
  });
  test('refuses free-time bars rather than silently assigning them a measured duration',()=>{
    const data=gp('0.6.1',score=>{score.masterBars[0].isFreeTime=true;});
    expect(()=>parseGuitarPro(data,{duration:4})).toThrow('free-time');
  });
  test('accepts every GP picker extension through the lazy asynchronous import', async () => {
    for (const name of supportedFixtures) {
      const b64=fixtures[name];
      const data=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));
      const file={name:name.split('/').at(-1),size:data.length,arrayBuffer:async()=>data.buffer};
      expect((await importTempoFile(file,{duration:25})).format).toBe('guitar-pro');
    }
  });
  test('rejects malformed files and missing recordings with useful guidance', () => {
    expect(()=>parseGuitarPro(new Uint8Array([1,2,3]),{duration:25})).toThrow();
    expect(()=>parseGuitarPro(new Uint8Array(MAX_TEMPO_FILE_BYTES+1),{duration:25})).toThrow('10 MB');
    expect(()=>parseGuitarPro(bytes('guitarpro3/strings.gp3'))).toThrow('Open a song');
  });
  test('caps unfolded repeats before a small score can expand without bound',()=>{
    const data=gp('0.6.1 | 0.6.1',score=>{
      score.masterBars[0].isRepeatStart=true;score.masterBars[1].repeatCount=1024;score.rebuildRepeatGroups();
    });
    expect(()=>parseGuitarPro(data,{duration:25})).toThrow('1024 bars');
  });
});
