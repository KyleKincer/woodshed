// Fixture handlers for convex/tempoSources.ts (Find a chart). A query with
// "zzz" finds nothing.
import {wait} from './runtime.js';

const beatsAt = (bpm, offset, seconds) => { const out = []; for (let t = offset, i = 0; t < seconds - .2; t += 60 / bpm, i++) out.push({time: +t.toFixed(4), downbeat: i % 4 === 0}); return out; };

export const handlers = {
  'tempoSources:search': async ({query}) => {
    await wait(400);
    if (/zzz/.test(query)) return {candidates: [], warnings: []};
    return {candidates: [
      {id: 'hx-1', title: 'Glasshouse', artist: 'Northbound', album: 'Weather Systems', source: 'harmonix', duration: 128.2, bpm: 120},
      {id: 'ch-1', title: 'Glasshouse', artist: 'Northbound', album: 'Weather Systems', source: 'chorus', duration: 128, charter: 'Rhythmatic', hasDrums: false},
      {id: 'ch-2', title: 'Glasshouse (Live at the Grange)', artist: 'Northbound', album: 'Live', source: 'chorus', duration: 135.5, charter: 'drumbot', hasDrums: false},
    ], warnings: []};
  },
  'tempoSources:load': async ({id}) => {
    await wait(300);
    const shift = id === 'ch-2' ? 1.2 : id === 'ch-1' ? 0.04 : 0;
    return {format: 'beats', text: beatsAt(120, shift, 128).map((b, i) => `${b.time}\t${i % 4 + 1}\t${Math.floor(i / 4) + 1}`).join('\n'), sourceUrl: 'https://github.com/urinieto/harmonixset'};
  },
};
