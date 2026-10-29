import {expect,test} from 'vitest';
import {fraction} from '../shared/notation.ts';
import {SongMapStore} from '../src/js/song-map.js';
import {defaultSongMap,pin,unpin,fromSections,validateSongMap,fromTimeline} from '../shared/song-map.ts';

test('beat detection keeps bar ids so drum notes stay attached and guards still pass',()=>{
  const store=new SongMapStore(defaultSongMap(20),20);
  const id=store.data.measures[0].id;
  store.setGuard('notation',timeline=>{if(!timeline.measures.some(m=>m.id===id))throw new Error('notes stranded');});
  store.replaceFromBeats(Array.from({length:30},(_,i)=>({time:.3+i*.55,downbeat:i%4===0})));
  expect(store.data.measures[0].id).toBe(id);
  expect(store.pins).toHaveLength(30);
});

test('removing a pin back to one keeps the tempo instead of resetting to 120',()=>{
  const store=new SongMapStore(defaultSongMap(20),20);
  store.edit(d=>pin(d,fraction(16),9));           // 4 bars in 9 s → 106.67 BPM
  store.edit(d=>unpin(d,fraction(16)));
  expect(store.bpmAt(1)).toBeCloseTo(106.67,1);
});

test('migrated maps stay editable when a section starts milliseconds after a click',()=>{
  const data=fromSections([{t:0,bpm:120,beatsPerBar:4,unit:4},{t:4.004,bpm:90,beatsPerBar:4,unit:4}],20);
  expect(()=>validateSongMap(data)).not.toThrow();
  const store=new SongMapStore(data,20);
  expect(()=>store.edit(d=>pin(d,fraction(40),18))).not.toThrow();
});

test('drum-part timelines with crowded anchors adopt; invalid maps never replace the current one',()=>{
  const measures=[{id:'a',numerator:4,denominator:4,length:fraction(4),label:''}];
  const timeline={version:1,measures,anchors:[{position:fraction(0),time:1},{position:fraction(1,64),time:1.00005},{position:fraction(1),time:1.5}]};
  const store=new SongMapStore(defaultSongMap(20),20);
  expect(store.adopt(fromTimeline(timeline,20))).toBe(true);
  expect(store.pins.map(p=>p.time)).toEqual([1,1.5]);
  expect(store.adopt({version:1,measures:[],pins:[]})).toBe(false);
  expect(store.pins.map(p=>p.time)).toEqual([1,1.5]);
});

// ---- 2.0 store behaviour (architecture §4.2) --------------------------------
import {describe, vi} from 'vitest';
import {REASON_ORIGIN, LABEL_REASONS} from '../src/js/song-map.js';
import {fromTaps, cleanSongMap} from '../shared/song-map.ts';
import {mapStore, unmapped, sectioned, pickup, sevenEight} from './fixtures/maps.js';

const labelBar = (i, label) => (d) => { d.measures[i].label = label; };

describe('revision', () => {
  test('bumps on every data change, including restore, undo and setDuration, but not on a no-op', () => {
    const store = mapStore(unmapped), seen = [store.revision];
    store.edit(labelBar(1, 'Verse'), 'label'); seen.push(store.revision);
    store.edit(labelBar(1, 'Verse'), 'label'); seen.push(store.revision);
    store.undo(); seen.push(store.revision);
    store.restore(mapStore(sectioned).snapshot()); seen.push(store.revision);
    store.setDuration(40); seen.push(store.revision);
    expect(seen[1]).toBeGreaterThan(seen[0]);
    expect(seen[2]).toBe(seen[1]);
    for (const i of [3, 4, 5]) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
  });
  test('the event carries the reason and the new revision', () => {
    const store = mapStore(unmapped), listener = vi.fn();
    store.subscribe(listener);
    store.edit(labelBar(2, 'Bridge'), 'label');
    expect(listener).toHaveBeenCalledWith('label', {reason: 'label', revision: store.revision});
  });
});

describe('setDuration', () => {
  test('re-normalises silently: no event, no undo step, caches rebuilt', () => {
    const store = new SongMapStore(defaultSongMap(1), 1), listener = vi.fn();
    store.subscribe(listener);
    expect(store.bars).toHaveLength(1);
    store.setDuration(20);
    expect(listener).not.toHaveBeenCalled();
    expect(store.undoStack).toHaveLength(0);
    expect(store.duration).toBe(20);
    expect(store.bars).toHaveLength(10);
    expect(store.beats).toHaveLength(40);
    store.setDuration(5);
    expect(store.bars).toHaveLength(3);
  });
  test('keeps bars holding notation when the recording turns out shorter', () => {
    const store = new SongMapStore(defaultSongMap(20), 20), kept = store.data.measures[8].id;
    const guard = () => {}; guard.keep = (id) => id === kept;
    store.setGuard('notation', guard);
    store.setDuration(4);
    expect(store.data.measures.map((m) => m.id)).toContain(kept);
  });
  test('does nothing for the same length', () => {
    const store = mapStore(unmapped), revision = store.revision;
    store.setDuration(30);
    expect(store.revision).toBe(revision);
  });
});

describe('origin stamping and reasons', () => {
  test('each reason stamps its origin; restore and tempo-source-cancel keep the data’s own', () => {
    const cases = {pin: 'edited', label: 'edited', sections: 'edited', tap: 'tapped', detect: 'detected', timeline: 'imported', 'part-fit': 'imported', 'tempo-source': 'imported'};
    for (const [reason, origin] of Object.entries(cases)) {
      const store = mapStore(unmapped);
      store.edit((d) => { d.pins[0].time = 0.25; }, reason);
      expect(store.data.origin, reason).toBe(origin);
    }
    const store = mapStore(sectioned), baseline = mapStore(unmapped).serialize();
    store.replace(baseline, 'tempo-source-cancel');
    expect(store.data).not.toHaveProperty('origin');
    store.replace({...baseline, origin: 'tapped'}, 'tempo-source-cancel');
    expect(store.data.origin).toBe('tapped');
  });
  test('an explicit origin wins over the reason table', () => {
    const store = mapStore(unmapped);
    store.edit((d) => { d.tailQpm = 90; }, 'tempo', {origin: 'imported'});
    expect(store.data.origin).toBe('imported');
    expect(() => store.edit((d) => { d.tailQpm = 91; }, 'tempo', {origin: 'guessed'})).toThrow(/origin/);
    expect(store.data.tailQpm).toBe(90);
  });
  test('a no-op never stamps an origin or creates an undo step', () => {
    const store = mapStore(unmapped);
    store.edit(() => {}, 'pin');
    store.replace(store.serialize(), 'tapBeat');
    expect(store.data).not.toHaveProperty('origin');
    expect(store.undoStack).toHaveLength(0);
    expect(store.isReal).toBe(false);
  });
  test('replace(next, reason): tempo-source → imported, tapBeat → tapped; replaceFromBeats → detected', () => {
    const store = mapStore(unmapped);
    store.replace(fromTaps([1, 1.6, 2.2, 2.8, 3.4], 30), 'tapBeat');
    expect(store.data.origin).toBe('tapped');
    store.replaceFromBeats(Array.from({length: 20}, (_, i) => ({time: 0.4 + i * 0.5, downbeat: i % 4 === 0})));
    expect(store.data.origin).toBe('detected');
    store.replace(mapStore(unmapped).serialize(), 'tempo-source');
    expect(store.data.origin).toBe('imported');
  });
  test('every call names a reason: replace without one, or an unknown reason, throws and changes nothing', () => {
    const store = mapStore(unmapped), before = store.serialize();
    expect(() => store.replace(mapStore(sectioned).serialize())).toThrow(TypeError);
    expect(() => store.edit(labelBar(1, 'X'), 'replace')).toThrow(/Unknown song-map edit reason/);
    expect(store.serialize()).toEqual(before);
    expect(Object.keys(REASON_ORIGIN)).not.toContain('replace');
    expect(LABEL_REASONS).toEqual(['label', 'sections']);
  });
  test('the generic edit reason is edited', () => {
    const store = mapStore(unmapped);
    store.edit((d) => { d.tailQpm = 100; });
    expect(store.data.origin).toBe('edited');
  });
});

describe('snapshot, restore and withoutUndo (D23)', () => {
  test('snapshot is a deep copy with the origin', () => {
    const store = mapStore(sectioned), snap = store.snapshot();
    snap.measures[0].label = 'changed';
    expect(store.data.measures[0].label).toBe('Intro');
    expect(snap.origin).toBe('edited');
  });
  test('restore sets data with no undo entry, keeps its origin and emits restore', () => {
    const store = mapStore(unmapped), listener = vi.fn();
    const before = store.snapshot();
    store.edit((d) => { d.pins[0].time = 0.4; }, 'pin');
    const after = store.snapshot(), stack = store.undoStack.length;
    store.subscribe(listener);
    expect(store.restore(before)).toBe(true);
    expect(store.data).not.toHaveProperty('origin');
    expect(store.undoStack).toHaveLength(stack);
    expect(listener).toHaveBeenCalledWith('restore', expect.objectContaining({reason: 'restore'}));
    store.restore(after);
    expect(store.data.origin).toBe('edited');
    expect(store.restore(after)).toBe(false);
  });
  test('restore refuses invalid data and guard refusals, changing nothing', () => {
    const store = mapStore(sectioned), before = store.serialize();
    expect(() => store.restore({version: 1, measures: [], pins: []})).toThrow();
    store.setGuard('notation', () => { throw new Error('notes stranded'); });
    expect(() => store.restore(mapStore(unmapped).snapshot())).toThrow('notes stranded');
    expect(store.serialize()).toEqual(before);
  });
  test('withoutUndo: edits push nothing on the map stack but still emit, save and clear redo', () => {
    const store = mapStore(unmapped), listener = vi.fn();
    store.edit(labelBar(1, 'A'), 'label');
    store.undo();
    expect(store.redoStack).toHaveLength(1);
    store.subscribe(listener);
    const before = store.snapshot();
    const out = store.withoutUndo((map) => { map.edit(labelBar(2, 'Verse'), 'label'); map.edit(labelBar(4, 'Chorus'), 'label'); return 'done'; });
    expect(out).toBe('done');
    expect(store.undoStack).toHaveLength(0);
    expect(store.redoStack).toHaveLength(0);
    expect(listener).toHaveBeenCalledTimes(2);
    // The caller's practice-undo entry restores the snapshots (origin kept).
    const after = store.snapshot();
    store.restore(before);
    expect(store.sections).toEqual([]);
    store.restore(after);
    expect(store.sections.map((s) => s.name)).toEqual(['Start', 'Verse', 'Chorus']);
  });
  test('withoutUndo nests and recovers after a throw', () => {
    const store = mapStore(unmapped);
    expect(() => store.withoutUndo(() => { throw new Error('boom'); })).toThrow('boom');
    store.withoutUndo(() => store.withoutUndo(() => store.edit(labelBar(1, 'In'), 'label')));
    expect(store.undoStack).toHaveLength(0);
    store.edit(labelBar(2, 'Out'), 'label');
    expect(store.undoStack).toHaveLength(1);
  });
});

describe('linked undo/redo', () => {
  test('the linked actions run with this step’s undo and redo', () => {
    const store = mapStore(unmapped), log = [];
    store.edit(labelBar(3, 'Chorus'), 'sections', {linked: {undo: () => log.push('untomb'), redo: () => log.push('tomb')}});
    store.undo();
    expect(store.sections).toEqual([]);
    store.redo();
    expect(store.sections.map((s) => s.name)).toEqual(['Start', 'Chorus']);
    store.undo();
    expect(log).toEqual(['untomb', 'tomb', 'untomb']);
  });
  test('a batch collects every linked action into its one step', () => {
    const store = mapStore(unmapped), log = [];
    store.beginBatch();
    store.edit(labelBar(1, 'A'), 'label', {linked: {undo: () => log.push('u1'), redo: () => log.push('r1')}});
    store.edit(labelBar(2, 'B'), 'label', {linked: {undo: () => log.push('u2'), redo: () => log.push('r2')}});
    store.endBatch();
    expect(store.undoStack).toHaveLength(1);
    store.undo(); store.redo();
    expect(log).toEqual(['u2', 'u1', 'r1', 'r2']);
  });
  test('a no-op edit drops its linked action', () => {
    const store = mapStore(unmapped), undo = vi.fn();
    store.edit(() => {}, 'sections', {linked: {undo, redo: vi.fn()}});
    expect(store.undo()).toBe(false);
    expect(undo).not.toHaveBeenCalled();
  });
});

describe('batches', () => {
  test('abortBatch restores the pre-batch data silently and leaves both stacks exactly as they were (D20)', () => {
    const store = mapStore(sectioned), listener = vi.fn(), linkedUndo = vi.fn();
    store.edit(labelBar(1, 'Pre'), 'label');
    store.edit(labelBar(2, 'Pre 2'), 'label');
    store.undo();
    const undo = [...store.undoStack], redo = [...store.redoStack], before = store.snapshot();
    store.subscribe(listener);
    store.beginBatch();
    store.replace(mapStore(unmapped).serialize(), 'tempo-source');
    store.edit((d) => { d.pins[0].time = 1; }, 'tempo-source', {linked: {undo: linkedUndo, redo: vi.fn()}});
    listener.mockClear();
    expect(store.abortBatch()).toBe(true);
    expect(store.snapshot()).toEqual(before);
    expect(store.undoStack).toEqual(undo);
    expect(store.redoStack).toEqual(redo);
    expect(linkedUndo).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls.map((c) => c[0])).toEqual(['restore']);
    expect(store.batch).toBeNull();
  });
  test('abortBatch with nothing changed emits nothing; with no batch it returns false', () => {
    const store = mapStore(unmapped), listener = vi.fn();
    store.subscribe(listener);
    expect(store.abortBatch()).toBe(false);
    store.beginBatch();
    expect(store.abortBatch()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });
  test('endBatch makes one undo step; undo inside an open batch does nothing and never closes it', () => {
    const store = mapStore(unmapped);
    store.edit(labelBar(1, 'Before'), 'label');
    store.beginBatch();
    store.edit(labelBar(2, 'One'), 'tap');
    expect(store.undo()).toBe(false);
    expect(store.redo()).toBe(false);
    expect(store.batch).not.toBeNull();
    store.edit(labelBar(3, 'Two'), 'tap');
    expect(store.endBatch()).toBe(true);
    expect(store.undoStack).toHaveLength(2);
    store.undo();
    expect(store.data.measures.slice(1, 4).map((m) => m.label)).toEqual(['Before', '', '']);
  });
});

describe('adopt and load', () => {
  test('adopt keeps a valid origin, upgrades data without one like load, and emits only on a change', () => {
    const store = mapStore(unmapped), listener = vi.fn();
    store.subscribe(listener);
    // The untouched placeholder stays unmapped: adopting it never makes the song real.
    const placeholder = defaultSongMap(30);       // fresh ids, so it differs from the loaded placeholder
    expect(store.adopt(placeholder)).toBe(true);
    expect(store.data.origin).toBeUndefined();
    expect(store.isReal).toBe(false);
    // A 1.6–1.9 map someone made (rule 3) is stamped imported.
    const { origin: _, ...made } = mapStore(pickup).serialize();
    expect(store.adopt(made)).toBe(true);
    expect(store.data.origin).toBe('imported');
    expect(listener.mock.calls.map((c) => c[0])).toEqual(['adopt', 'adopt']);
    expect(store.adopt(store.serialize())).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.adopt({...mapStore(sevenEight).serialize(), origin: 'tapped'})).toBe(true);
    expect(store.data.origin).toBe('tapped');
    expect(store.adopt({version: 1, measures: [], pins: []})).toBe(false);
    expect(store.data.origin).toBe('tapped');
  });
  test('a stand-alone adopt is one undo step that restores the previous map, keeping earlier history', () => {
    const store = mapStore(sectioned);
    store.edit(labelBar(3, 'Fill'), 'label');
    expect(store.adopt(mapStore(pickup).serialize())).toBe(true);
    expect(store.undoStack).toHaveLength(2);
    expect(store.undo()).toBe(true);
    expect(store.data.measures[3].label).toBe('Fill');
    expect(store.data.measures).toHaveLength(64);
    expect(store.undo()).toBe(true);
    expect(store.data.measures[3].label).toBe('');
  });
  test('adopt inside beginBatch/endBatch (mapChange with Edit · Map mounted) is exactly one map-stack step', () => {
    const store = mapStore(sectioned);
    store.edit(labelBar(3, 'Fill'), 'label');
    const before = store.snapshot();
    store.beginBatch();
    expect(store.adopt(mapStore(pickup).serialize())).toBe(true);
    expect(store.batch).not.toBeNull();
    expect(store.endBatch()).toBe(true);
    expect(store.undoStack).toHaveLength(2);
    store.undo();
    expect(store.data).toEqual(before);
  });
  test('adopt inside withoutUndo pushes nothing (open-time and practice-stack adoption)', () => {
    const store = mapStore(sectioned);
    store.edit(labelBar(3, 'Fill'), 'label');
    store.withoutUndo(() => store.adopt(mapStore(pickup).serialize()));
    expect(store.undoStack).toHaveLength(1);
    expect(store.data.origin).toBe('edited');
    expect(store.data.measures[0].id).toBe('p0');
  });
  test('a foreign adopt during an audition joins the batch, so Keep my map still restores everything', () => {
    const store = mapStore(sectioned);
    store.edit(labelBar(3, 'Fill'), 'label');
    const history = [...store.undoStack], original = store.snapshot();
    store.beginBatch();
    store.edit((d) => { d.tailQpm = 100; }, 'tempo-source');
    store.adopt(mapStore(pickup).serialize());
    expect(store.abortBatch()).toBe(true);
    expect(store.data).toEqual(original);
    expect(store.undoStack).toEqual(history);
  });
  test('load reads the stored origin and has no legacy field', () => {
    const store = mapStore(pickup);
    expect(store.data.origin).toBe('edited');
    expect(store).not.toHaveProperty('legacy');
    expect(cleanSongMap(store.serialize()).origin).toBe('edited');
  });
});

test('undo after setDuration re-normalises the restored step to the decoded length', () => {
  const store = new SongMapStore(defaultSongMap(4), 4);
  store.edit((d) => { d.measures[1].label = 'Verse'; }, 'label');
  store.setDuration(20);
  store.undo();
  expect(store.bars).toHaveLength(10);
  expect(store.beats.at(-1).time).toBeCloseTo(19.5);
  store.redo();
  expect(store.bars).toHaveLength(10);
  expect(store.sections.map((s) => s.name)).toEqual(['Start', 'Verse']);
});

describe('batches see every change (D20)', () => {
  test('withoutUndo edits inside an open batch still mark it: abortBatch restores them, endBatch records them', () => {
    const store = mapStore(sectioned);
    store.beginBatch();
    store.withoutUndo(() => store.edit(labelBar(2, 'X'), 'label'));
    expect(store.abortBatch()).toBe(true);
    expect(store.data.measures[2].label).toBe('');
    expect(store.undoStack).toHaveLength(0);
    store.beginBatch();
    store.withoutUndo(() => store.edit(labelBar(2, 'X'), 'label'));
    expect(store.endBatch()).toBe(true);
    expect(store.undoStack).toHaveLength(1);
    store.undo();
    expect(store.data.measures[2].label).toBe('');
  });
  test('restore inside an open batch marks it, so abortBatch undoes it', () => {
    const store = mapStore(sectioned), original = store.snapshot();
    store.beginBatch();
    expect(store.restore(mapStore(pickup).snapshot())).toBe(true);
    expect(store.abortBatch()).toBe(true);
    expect(store.data).toEqual(original);
  });
});

describe('barIndexAt is time-based (§4.3); barIndexAtQ keeps the quarter-note lookup', () => {
  test('at 120 qpm a time and a quarter position name different bars', () => {
    const store = mapStore(sectioned);           // 2 s and 4 quarters per bar
    expect(store.barIndexAt(10)).toBe(5);        // 10 s → bar index 5
    expect(store.barIndexAtQ(10)).toBe(2);       // 10 quarters → bar index 2
    expect(store.barIndexAtQ(store.positionAt(10))).toBe(store.barIndexAt(10));
    expect(store.timeToBar(10).index).toBe(5);
  });
});

describe('1.9 player API is gone after I1 (ticket I1-3)', () => {
  test('SongMapStore has no positionLabel; barBeatAt is the bar/beat lookup', () => {
    const store = mapStore(sectioned);
    expect('positionLabel' in store).toBe(false);
    expect(typeof store.barBeatAt).toBe('function');
  });
});
