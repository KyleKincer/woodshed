// A song added from the user's own stems (the Add sheet's "Stems of one song"; convex/jobs.ts createSeparation;
// companion/process.py). An upload source may carry `stems`: the user's files, each with the stem it is.
//
// - With a full mix (source.value is the mix's upload id): the mix is split as usual, and each of the user's stems
//   is used instead of the split's stem of the same name. The split layout is chosen so the user's stems fit it
//   (separationMode): guitar or piano needs the 6-stem split, and a two-part split ("Drums + rest") can only take
//   its own focus stem.
// - Without a mix (source.value ''): nothing is split. The song's stems are the user's files, and its stemMode is
//   OWN_STEM_MODE.
// Several files with the same name (Clone Hero's drums_1…drums_4) are mixed into that one stem.

/** The stems a user's file can be: the names the whole app knows (labels, colours, "my instrument"). */
export const OWN_STEM_NAMES = Object.freeze(['drums', 'bass', 'vocals', 'guitar', 'piano', 'other'] as const);
export type OwnStemName = typeof OWN_STEM_NAMES[number];
/** A file's role in the Add sheet: a stem, the full mix, or left out. */
export type StemRole = OwnStemName | 'mix' | 'skip';

/** The stemMode of a song made only of the user's stems (nothing was split). */
export const OWN_STEM_MODE = 'own';
/** The most files one song can be added from. */
export const MAX_OWN_STEMS = 16;

const TWO_PART = new Set(['drums', 'vocals', 'bass']);
const UPLOAD_ID = /^[a-f0-9-]{36}$/;

export type OwnStem = {name: string; value: string; filename?: string};

/** Whether `stems` is a valid list of the user's stems: 1–MAX_OWN_STEMS, known names, upload ids, unique ids. */
export function validOwnStems(stems: unknown): stems is OwnStem[] {
  if (!Array.isArray(stems) || !stems.length || stems.length > MAX_OWN_STEMS) return false;
  const ids = new Set<string>();
  for (const s of stems) {
    if (!s || typeof s !== 'object') return false;
    const {name, value, filename} = s as OwnStem;
    if (!OWN_STEM_NAMES.includes(name as OwnStemName) || typeof value !== 'string' || !UPLOAD_ID.test(value) || ids.has(value)) return false;
    if (filename !== undefined && (typeof filename !== 'string' || filename.length > 500)) return false;
    ids.add(value);
  }
  return true;
}

/**
 * The split layout for a mix added with the user's stems: the chosen one when the stems fit it, else the 4-stem
 * split ('full'), or the 6-stem split ('six') when a stem is guitar or piano (the 4-stem split leaves them in Other,
 * so the user's guitar would play twice).
 */
export function separationMode(stemMode: string, names: readonly string[]): string {
  if (names.some(n => n === 'guitar' || n === 'piano')) return 'six';
  if (TWO_PART.has(stemMode) && names.some(n => n !== stemMode)) return 'full';
  return stemMode;
}

// A file name's words, in order of precedence: the first rule whose pattern matches wins. Clone Hero and
// Rock Band packs name their files song/drums(_1…4)/bass/rhythm/guitar/keys/vocals(_1)/crowd/preview.
const ROLE_RULES: ReadonlyArray<readonly [RegExp, StemRole]> = [
  [/\b(crowd|preview|click|count[- ]?in|metronome|guide)\b/, 'skip'],
  [/\b(drums?|drumkit|kit|kick|snare|toms?|overheads?|cymbals?|hi[- ]?hats?|percussion|perc)\b/, 'drums'],
  [/\b(bass|bassline)\b/, 'bass'],
  [/\b(vocals?|vox|voice|voices|lead[- ]?vocal|bgv|backing[- ]?vocals?|choir|singer)\b/, 'vocals'],
  [/\b(guitars?|gtrs?|rhythm|lead)\b/, 'guitar'],
  [/\b(piano|keys|keyboards?|synths?|organ|rhodes)\b/, 'piano'],
  [/\b(song|mix|full|master|mastered|original|stereo|instrumental|backing)\b/, 'mix'],
  [/\b(other|rest|misc)\b/, 'other'],
];

/** The role a file's name suggests ('other' when nothing matches). Numbers and separators are word breaks. */
export function guessRole(filename: string): StemRole {
  const base = String(filename ?? '').replace(/\.[a-z0-9]{2,5}$/i, '').toLowerCase().replace(/[_\-.\d()[\]]+/g, ' ');
  for (const [re, role] of ROLE_RULES) if (re.test(base)) return role;
  return 'other';
}

/** True when the names suggest stems of one song: at least two files, and two or more of them name a stem. */
export function looksLikeStems(filenames: readonly string[]): boolean {
  if (filenames.length < 2) return false;
  const roles = filenames.map(guessRole);
  return roles.filter(r => r !== 'mix' && r !== 'skip' && r !== 'other').length >= 2;
}
