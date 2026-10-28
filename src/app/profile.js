// The instrument profile (architecture §2.22, D37): which stems are "my part"
// for Minus me, the Add sheet's default split, and the plain-words mapping
// Settings → Instruments shows. Pure: no DOM, no storage, no clock.
//
// Profile = {instruments: Instrument[], primary: Instrument|null, openWithMyPart: 'in'|'out'}

/** @typedef {'drums'|'bass'|'guitar'|'keys'|'vocals'|'other'} Instrument */

export const INSTRUMENTS = Object.freeze(['drums', 'bass', 'guitar', 'keys', 'vocals', 'other']);

/** Stems that carry each instrument, best first. The second entry is the fallback on songs without the dedicated stem. */
export const STEM_FOR = Object.freeze({
  drums: Object.freeze(['drums']),
  bass: Object.freeze(['bass']),
  vocals: Object.freeze(['vocals']),
  guitar: Object.freeze(['guitar', 'other']),
  keys: Object.freeze(['piano', 'other']),
  other: Object.freeze(['other']),
});

const LABEL = {drums: 'Drums', bass: 'Bass', guitar: 'Guitar', keys: 'Keys', vocals: 'Vocals', other: 'Other'};
const STEM_MODES = ['full', 'six', 'drums', 'vocals', 'bass'];
const DEFAULT_PRESET = 'balanced';

/** The profile's instruments: known names only, deduplicated, in the order the user chose them. */
function instrumentsOf(profile) {
  const list = profile && Array.isArray(profile.instruments) ? profile.instruments : [];
  const out = [];
  for (const instrument of list) {
    if (INSTRUMENTS.includes(instrument) && !out.includes(instrument)) out.push(instrument);
  }
  return out;
}

/** A two-part split (`drums` + `no_drums`): only an exact stem name counts there, and `no_*` stems never match. */
function isTwoPart(names) {
  return names.some(name => name.startsWith('no_'));
}

/**
 * The stems that are "my part" on this song (D37).
 * names: the stem names to mute for Minus me, in the song's stem order;
 * fallbacks: instruments that matched `other` because the song has no dedicated stem for them;
 * missing: instruments with no matching stem at all.
 */
export function myStems(profile, stemNames) {
  const stems = Array.isArray(stemNames) ? stemNames.filter(name => typeof name === 'string' && name) : [];
  const lower = stems.map(name => name.toLowerCase());
  const twoPart = isTwoPart(lower);
  const matched = new Set(), fallbacks = [], missing = [];
  for (const instrument of instrumentsOf(profile)) {
    const candidates = twoPart ? STEM_FOR[instrument].slice(0, 1) : STEM_FOR[instrument];
    const index = candidates.findIndex(stem => lower.includes(stem));
    if (index < 0) { missing.push(instrument); continue; }
    matched.add(candidates[index]);
    if (index > 0) fallbacks.push(instrument);
  }
  const names = stems.filter((name, i) => matched.has(lower[i]));
  return {names, fallbacks, missing};
}

/**
 * The Add sheet's default split. The settings' stem mode wins once the user saved one with
 * "Use these for future songs" (any mode other than the stock `full`); otherwise guitar or keys
 * in the profile → `six`, else `full`. The default is never a two-part mode. Preset: the
 * settings' preset, else `balanced`.
 */
export function addDefaults(profile, settings) {
  const saved = settings && typeof settings === 'object' ? settings : {};
  const preset = typeof saved.preset === 'string' && saved.preset ? saved.preset : DEFAULT_PRESET;
  if (STEM_MODES.includes(saved.stemMode) && saved.stemMode !== 'full') return {stemMode: saved.stemMode, preset};
  const instruments = instrumentsOf(profile);
  const stemMode = instruments.includes('guitar') || instruments.includes('keys') ? 'six' : 'full';
  return {stemMode, preset};
}

/** One plain-words line per profile instrument: 'Guitar → guitar stem on 6-stem songs, otherwise Other'. */
export function describeMapping(profile) {
  return instrumentsOf(profile).map(instrument => {
    const [stem, fallback] = STEM_FOR[instrument];
    return fallback
      ? `${LABEL[instrument]} → ${stem} stem on 6-stem songs, otherwise ${LABEL[fallback]}`
      : `${LABEL[instrument]} → ${stem} stem`;
  });
}
