// In-memory stand-in for src/js/backend.js used by the tempo-map fixture.
export const saved = {tempo: null, practice: null};
window.fixtureSaved = saved;
export const onSong = () => () => {};
export const saveTempo = async (id, tempo) => { saved.tempo = structuredClone(tempo); };
export const savePractice = async (id, practice) => { saved.practice = structuredClone(practice); };
export const getNotation = async () => null;
export const getSharedNotation = async () => null;
export const signKey = async () => null;
export async function signKeys() { return window.fixtureUrls; }
export async function detectBeats(id, onProgress) {
  onProgress('Listening…');
  await new Promise(resolve => setTimeout(resolve, 300));
  return {beats: window.fixtureBeats.map((time, i) => [time, i % 4 === 0 ? 1 : i % 4 + 1])};
}
