// Low-level alphaTab import only: no notation renderer, synthesizer, fonts,
// soundfonts or network requests. This module is loaded on the first GP import.
import {Settings, importer, midi} from '@coderline/alphatab';
import {parseMidiTempo, MAX_TEMPO_FILE_BYTES} from './tempo-import.js';
import {preflightGuitarPro} from './guitar-pro-bounds.js';
import {MAX_MEASURES} from '../../shared/notation.ts';
import {MAX_PINS} from '../../shared/song-map.ts';

const fail = message => { throw new Error(message); };
const MAX_NOTES = 100000;
const MAX_DRUM_HITS = 16000;
const validTempo = tempo => { if (!Number.isFinite(tempo) || tempo < 10 || tempo > 1000) fail('The Guitar Pro score needs tempos between 10 and 1000 quarter notes per minute.'); };

/** Import score playback order into the same native map/draft as MIDI files. */
export function parseGuitarPro(value, {duration} = {}) {
  if (!Number.isFinite(duration) || duration <= 0) fail('Open a song before importing a tempo map.');
  let bytes = value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : null;
  if (!bytes) fail('Could not read this Guitar Pro file.');
  if (bytes.length > MAX_TEMPO_FILE_BYTES) fail('Choose a Guitar Pro file smaller than 10 MB.');
  bytes = preflightGuitarPro(bytes);
  const settings = new Settings();
  settings.importer.maxDecodingBufferSize = 32 * 1024 * 1024;
  let score;
  try { score = importer.ScoreLoader.loadScoreFromBytes(bytes, settings); }
  catch { fail('Could not read this Guitar Pro file. Try resaving it as GP3, GP4, GP5, GPX or GP, or export MIDI from Guitar Pro.'); }
  if (!score.masterBars.length || !score.tracks.length) fail('This Guitar Pro file contains no score.');
  if (score.masterBars.length > MAX_MEASURES || score.tracks.length > 64) fail('This Guitar Pro score exceeds the 1024-bar or 64-track import limit.');
  const warnings = ['Guitar Pro timing follows score playback, including repeats and alternate endings. Check it against the recording and adjust the offset if needed.'];
  const percussion = new Set();
  let notes = 0, beats = 0, automations = 0;
  validTempo(score.tempo);
  for (const bar of score.masterBars) {
    if (!Number.isInteger(bar.timeSignatureNumerator) || bar.timeSignatureNumerator < 1 || bar.timeSignatureNumerator > 16 || ![1,2,4,8,16].includes(bar.timeSignatureDenominator)) fail('This Guitar Pro file contains a meter Woodshed cannot represent (use 1–16 beats and a denominator of 1, 2, 4, 8 or 16).');
    if (bar.isFreeTime) fail('This Guitar Pro score contains free-time bars. Add measured timing in Guitar Pro or import a MIDI export with explicit timing.');
    if (!Number.isInteger(bar.repeatCount) || bar.repeatCount < 0 || bar.repeatCount > MAX_MEASURES) fail('This Guitar Pro file has an unsupported repeat count.');
    if (bar.syncPoints?.length) warnings.push('Backing-track audio sync points are not applied. This import uses the score tempo; check alignment near both ends of the recording.');
    if (bar.fermata?.size) warnings.push('Fermatas need review against the recording; held-note notation does not specify the recorded pause length.');
    automations += bar.tempoAutomations.length;
    if (automations > MAX_PINS) fail('This Guitar Pro score has more than 8000 tempo changes.');
    for (const automation of bar.tempoAutomations) {
      validTempo(automation.value);
      if (!Number.isFinite(automation.ratioPosition) || automation.ratioPosition < 0 || automation.ratioPosition > 1) fail('This Guitar Pro file has an invalid tempo-change position.');
      if (automation.isLinear) warnings.push('Tempo automations are imported as explicit changes. Check gradual tempo transitions against the recording and refine the map if needed.');
    }
  }
  for (const track of score.tracks) {
    if (track.staves.length > 8) fail('This Guitar Pro score exceeds the eight-staff-per-track import limit.');
    // A custom percussion MIDI channel must still import as percussion. A
    // pitched part accidentally assigned channel 10 must never invent drums.
    if (track.staves.length && track.staves.every(staff => staff.isPercussion)) percussion.add(track.index);
    else if (track.staves.some(staff => staff.isPercussion)) warnings.push('A mixed pitched/percussion track was omitted from the drum draft. Export its drum staff as MIDI to import it separately.');
    for (const staff of track.staves) for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) {
      if (++beats > MAX_NOTES) fail('This Guitar Pro score contains more than 100000 beats. Import a shorter score.');
      notes += beat.notes.length;
      if (notes > MAX_NOTES) fail('This Guitar Pro score contains more than 100000 notes. Import a shorter score.');
    }
  }
  const file = new midi.MidiFile();
  // Keep only timing and genuine percussion. Suppressing bends/controllers
  // avoids an unnecessary MIDI event stream for the other instruments.
  class ImportHandler extends midi.AlphaSynthMidiFileHandler {
    drumHits = 0;
    tempoEvents = 0;
    leadingGrace = false;
    addTickShift(shift) { if (shift) this.leadingGrace = true; }
    addNote(track, start, length, key, velocity) {
      if (!percussion.has(track)) return;
      if (start < 0) { this.leadingGrace = true; return; }
      if (++this.drumHits > MAX_DRUM_HITS) fail('The expanded Guitar Pro drum part contains more than 16000 hits. Import a shorter score.');
      super.addNote(0, Math.round(start), Math.max(0, Math.round(length)), key, velocity, 9);
    }
    addTempo(tick, tempo) {
      if (++this.tempoEvents > MAX_PINS) fail('The expanded Guitar Pro score has more than 8000 tempo changes.');
      super.addTempo(Math.round(tick), tempo);
    }
    addTimeSignature(tick, numerator, denominator) { super.addTimeSignature(Math.round(tick), numerator, denominator); }
    addRest() {}
    addControlChange() {}
    addProgramChange() {}
    addBend() {}
    addNoteBend() {}
    finishTrack(track, tick) { if (track === 0) super.finishTrack(0, Math.round(tick)); }
  }
  const handler = new ImportHandler(file, true);
  const generator = new midi.MidiFileGenerator(score, settings, handler);
  const addMasterBar = generator.tickLookup.addMasterBar.bind(generator.tickLookup);
  generator.tickLookup.addMasterBar = lookup => {
    if (generator.tickLookup.masterBars.length >= MAX_MEASURES) fail('The expanded Guitar Pro score needs more than 1024 bars.');
    // A signature at EVERY played bar preserves a pickup followed by the same
    // nominal meter. Ordinary MIDI exporters omit that repeated signature.
    handler.addTimeSignature(lookup.start, lookup.masterBar.timeSignatureNumerator, lookup.masterBar.timeSignatureDenominator);
    addMasterBar(lookup);
  };
  generator.generate();
  if (handler.leadingGrace) warnings.push('Grace hits before the first downbeat were omitted; bar 1 stays at time zero. Check the intro and offset.');
  const result = parseMidiTempo(file.toBinary(), {duration});
  return {...result, format:'guitar-pro', warnings:[...new Set([...warnings, ...result.warnings])],
    ...(result.drums ? {drums:{...result.drums, source:'guitar-pro', warnings:['Guitar Pro percussion is an editable starting point. Check kit articulations, ornaments and written rhythms against the recording.']}} : {})};
}
