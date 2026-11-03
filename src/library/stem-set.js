// The Add sheet's "Stems of one song" (shared/own-stems.ts): several files that are one song's stems, each with a
// role (a stem, the full mix, or left out). Pure: the sheet (add-sheet.js) renders what these return.
//
//   ROLES                       the role choices, in menu order: [{value, label}]
//   songTitleFrom(names, dirs?) the song's name from its files: their folder, else what their names share
//   stemPlan(roles, stemMode)   what adding these files will do: {ok, reason?, lines: [text], mode, mix, stems}
//     ok false with a reason when they can't be added as one song (two full mixes, nothing chosen).
//     mode  the split the mix gets (separationMode), or OWN_STEM_MODE when there is no mix (nothing is split).

import {OWN_STEM_MODE, guessRole, looksLikeStems, separationMode} from '../../shared/own-stems.ts';

export {guessRole, looksLikeStems};

export const ROLE_LABELS = Object.freeze({
  mix: 'Full mix', drums: 'Drums', bass: 'Bass', vocals: 'Vocals', guitar: 'Guitar', piano: 'Keys', other: 'Other', skip: 'Leave out',
});
export const ROLES = Object.freeze(['mix', 'drums', 'bass', 'vocals', 'guitar', 'piano', 'other', 'skip']
  .map(value => Object.freeze({value, label: ROLE_LABELS[value]})));

const SPLITS = Object.freeze({full: 4, six: 6});
const list = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

export const COPY = Object.freeze({
  untitled: 'Untitled song',
  twoMixes: 'Choose one full mix. The other files are its stems.',
  nothing: 'Choose at least one file to add.',
  splitYours: names => `Woodshed splits the full mix and uses your ${list(names)} instead of its own.`,
  splitInto: n => `It splits into ${n} stems so your stems have a place.`,
  mixOnly: 'Woodshed splits the full mix as usual.',
  yoursOnly: n => (n === 1 ? 'Nothing to split: your stem is the song, as it is.' : `Nothing to split: your ${n} stems are the song, as they are.`),
  merged: (name, n) => `Your ${n} ${name} files are mixed into one ${name} stem.`,
  leftOut: n => `${n === 1 ? '1 file is' : `${n} files are`} left out.`,
});

const fileStem = name => String(name ?? '').replace(/\.[a-z0-9]{2,5}$/i, '');

/**
 * The song's name from its files: the folder they came from (a dropped folder's webkitRelativePath), else the start
 * their names share (trimmed of separators), else the first name that isn't a stem's.
 */
export function songTitleFrom(names, dirs = []) {
  const folder = dirs.map(d => String(d ?? '').split('/').filter(Boolean).at(-1)).find(Boolean);
  if (folder) return folder;
  // Files the names say to leave out (a crowd track, a preview) don't count.
  const kept = names.filter(n => guessRole(n) !== 'skip');
  names = kept.length ? kept : names;
  const stems = names.map(fileStem).filter(Boolean);
  if (!stems.length) return COPY.untitled;
  let prefix = stems[0];
  for (const s of stems.slice(1)) while (prefix && !s.toLowerCase().startsWith(prefix.toLowerCase())) prefix = prefix.slice(0, -1);
  prefix = prefix.replace(/[\s_\-.(\[]+$/, '').trim();
  if (prefix.length >= 3) return prefix;
  return stems.find((s, i) => guessRole(names[i]) === 'mix') ?? COPY.untitled;
}

/** What adding files with these roles does (see the header). */
export function stemPlan(roles, stemMode = 'full') {
  const mixes = roles.filter(r => r === 'mix').length;
  const stems = roles.filter(r => r && r !== 'mix' && r !== 'skip');
  const skipped = roles.filter(r => r === 'skip').length;
  if (mixes > 1) return {ok: false, reason: COPY.twoMixes, lines: [], mode: stemMode, mix: true, stems};
  if (!mixes && !stems.length) return {ok: false, reason: COPY.nothing, lines: [], mode: stemMode, mix: false, stems};
  const named = [...new Set(stems)];
  const lines = [];
  let mode = OWN_STEM_MODE;
  if (mixes) {
    mode = stems.length ? separationMode(stemMode, named) : stemMode;
    lines.push(stems.length ? COPY.splitYours(named.map(n => ROLE_LABELS[n])) : COPY.mixOnly);
    if (stems.length && mode !== stemMode && SPLITS[mode]) lines.push(COPY.splitInto(SPLITS[mode]));
  } else {
    lines.push(COPY.yoursOnly(named.length));
  }
  for (const name of named) {
    const n = stems.filter(s => s === name).length;
    if (n > 1) lines.push(COPY.merged(ROLE_LABELS[name], n));
  }
  if (skipped) lines.push(COPY.leftOut(skipped));
  return {ok: true, lines, mode, mix: !!mixes, stems};
}
