// The Mix sheet (spec §4.7 "Mix sheet", §7.6; architecture §2.14.3 rule 18, D27, D37):
//   top row      Minus me: Drums (56 px toggle) · I play: Drums ▾ (ON1's InstrumentPicker inline,
//                editing the account profile) · Only me · Full mix (resets mute, solo and levels; undoable)
//   mode switch  Tap to: Mute · Solo, so solo is visible on touch (a long-press or Shift-click on a
//                pad always solos)
//   stem pads    StemPads in canonical order (drums, bass, guitar, piano, vocals, other; a two-part
//                song shows its pair), 120×168 on the band, 160×96 in the rail popover, key-caps 1–9
//   chart        Chart playback Off · Quiet · Loud when the song has a drum part
//   no stem      the honest lines when the profile's instrument has no stem of its own: on the
//                desktop with [Re-split with 6 stems] (song.resplit), on the web pointing to Woodshed
//                for desktop
//
//   render(container, {session, close, layout?, registry?, account?, desktop?}) → {el, destroy()}
//     layout     'band' | 'rail' (default: from the sheet's presentation; a popover is the rail's)
//     registry   the command registry (default the app registry): Minus me, Only me and Full mix
//                are `mix.minusMe` / `mix.onlyMe` / `mix.full` (their key-caps are the commands'
//                keys), Chart playback runs `mix.chartAudio {level}` with each option checked and
//                disabled by `registry.state(id, context({args}))` (§3.1, the I1b handoff), and
//                Re-split is `song.resplit`
//     account    {value | profile, patch(partial)}; default src/app/account.js. The picker writes
//                `account.patch({profile})`; the transport follows the profile on its own
//     desktop    {available}; default src/app/desktop.js
//
// Every mix change goes through the transport (one practice-undo step, saved with the song;
// level drags coalesce per stem). When Minus me / Only me find no stem for the player (the
// transport's 'mix-sheet' event opens this sheet, which is already open), the toggles are
// unavailable and the picker opens so the player can say what they play. A read-only (shared)
// song keeps the mix controls but shows neither the picker nor Re-split, and its no-stem note
// keeps only the plain fact (no "choose" prompt, no "Re-split …" sentence).
//
// Pure helpers (exported for tests): padState(track), mixNotes(profile, stems).

import '../../styles/views/stage/sheets-mix.css';
import {registry as appRegistry} from '../../app/commands.js';
import {account as appAccount} from '../../app/account.js';
import {desktop as appDesktop} from '../../app/desktop.js';
import {myStems} from '../../app/profile.js';
import {h, reconcileList} from '../../ui/h.js';
import {Button} from '../../ui/button.js';
import {Toggle} from '../../ui/toggle.js';
import {Segmented} from '../../ui/segmented.js';
import {StemPad} from '../../ui/stem-pad.js';
import {InlineStatus} from '../../ui/status.js';
import {InstrumentPicker, normaliseProfile} from '../../onboarding/instruments.js';
import {INSTRUMENT_LABELS} from '../../onboarding/onboarding.copy.js';
import {stemLabel} from '../transport-commands.js';   // also registers the mix.* commands
import {COPY} from './sheets-a.copy.js';

const M = COPY.mix;
const STEM_TOKENS = new Set(['drums', 'bass', 'guitar', 'piano', 'vocals', 'other']);
const CHART_LEVELS = Object.freeze(['off', 'quiet', 'loud']);
/** Pads with a key-cap: mix.mute.N / mix.solo.N reach the first nine stems (§3.1). */
const KEYED = 9;

let seq = 0;
const read = (sig) => (sig && typeof sig.peek === 'function' ? sig.peek() : null);

/** 'band' or 'rail' for the sheet holding `container` (a popover is the rail's). */
export function sheetLayout(container, layout) {
  if (layout === 'band' || layout === 'rail') return layout;
  const host = container?.closest?.('[data-presentation]');
  return host?.getAttribute('data-presentation') === 'popover' ? 'rail' : 'band';
}

/** A pad's state word: SOLO wins over OUT (an explicit solo is what you hear), else ON. */
export function padState(track) {
  if (track?.soloed) return 'solo';
  if (track?.muted) return 'out';
  return 'on';
}

/** The stem colour token of a stem name ('no_drums' and unknown stems use Other's). */
const stemToken = (name) => {
  const lower = String(name ?? '').toLowerCase();
  return STEM_TOKENS.has(lower) ? lower : 'other';
};

const instrumentWord = (instrument) => (INSTRUMENT_LABELS[instrument] ?? String(instrument)).toLowerCase();
const or = (words) => (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`);

/**
 * The note under the top row for this profile on these stems, or null:
 *   {kind: 'choose'}                     no instrument chosen yet
 *   {kind: 'missing', instruments}       no stem matches (e.g. bass on a drums / no_drums split)
 *   {kind: 'fallback', instruments}      the instrument fell back to Other (guitar, keys on 4 stems)
 */
export function mixNotes(profile, stems) {
  const p = normaliseProfile(profile);
  if (!p.instruments.length) return {kind: 'choose'};
  const {names, fallbacks, missing} = myStems(p, stems);
  if (!names.length) return {kind: 'missing', instruments: or(missing.map(instrumentWord))};
  if (fallbacks.length) return {kind: 'fallback', instruments: or(fallbacks.map(instrumentWord))};
  return null;
}

const profileOf = (account) => {
  const v = read(account?.profile) ?? read(account?.value)?.profile ?? null;
  return normaliseProfile(v);
};

/** The Mix sheet (see the header). */
export function render(container, {session, close, layout = null, registry = appRegistry, account = appAccount,
  desktop = appDesktop} = {}) {
  if (!session?.transport) throw new TypeError('mix sheet: a session with a transport is required');
  void close;
  const transport = session.transport;
  const id = `sheet-mix-${++seq}`;
  const offs = [];
  const parts = [];
  const snap = () => read(transport.snapshot) ?? {};
  /** A command's state for these args (§3.1; the I1b handoff's per-option rule). */
  const stateOf = (cmd, args) => registry.state(cmd, registry.context(args === undefined ? {} : {args}));
  const run = (cmd, args) => registry.run(cmd, {source: 'pointer', ...(args === undefined ? {} : {args})});
  const mixOf = () => snap().mix ?? {tracks: [], minusMe: false, onlyMe: false, mine: [], chartAudio: 'off'};
  const writable = !session.readOnly;
  const onDesktop = () => !!desktop?.available;
  let mode = 'mute';
  let pickerOpen = false;
  let saving = 0;

  // ---- top row -----------------------------------------------------------------------------------------------
  const noteId = `${id}-note`;
  const minusMe = Toggle({label: M.minusMe(''), command: 'mix.minusMe', registry, icon: '', kbd: true, size: 'lg',
    className: 'sheet-mix-minus-me', pressed: !!stateOf('mix.minusMe')?.checked, onChange: () => update()});
  const onlyMe = Toggle({label: M.onlyMe, command: 'mix.onlyMe', registry, icon: '', kbd: true, size: 'lg',
    className: 'sheet-mix-only-me', pressed: !!stateOf('mix.onlyMe')?.checked, onChange: () => update()});
  const fullMix = Button({label: M.fullMix, command: 'mix.full', registry, icon: '', kbd: true, size: 'lg', className: 'sheet-mix-full',
    onClick: () => update()});
  const iPlay = Button({label: M.iPlay(''), size: 'lg', className: 'sheet-mix-i-play', iconEnd: 'chevron-down',
    attrs: {'aria-expanded': 'false', 'aria-controls': `${id}-picker`},
    onClick: () => { pickerOpen = !pickerOpen; update(); }});
  parts.push(minusMe, onlyMe, fullMix, iPlay);
  const top = h('div', {class: 'sheet-mix-top'}, minusMe.el, iPlay.el, onlyMe.el, fullMix.el);

  // ---- the inline picker (ON1's InstrumentPicker without the open-with choice) --------------------------------
  const saveError = InlineStatus({tone: 'error', text: M.saveFailed});
  saveError.el.hidden = true;
  const picker = InstrumentPicker({value: profileOf(account), openWith: false, label: M.iPlayPicker,
    onChange: (profile) => { void saveProfile(profile); }});
  parts.push(saveError, picker);
  const pickerRegion = h('div', {class: 'sheet-mix-picker', id: `${id}-picker`}, picker.el, saveError.el);

  async function saveProfile(profile) {
    saveError.el.hidden = true;
    saving++;
    try {
      await account.patch({profile: {...profile, instruments: [...profile.instruments]}});
    } catch (err) {
      console.warn('[mix sheet] the profile could not be saved', err);
      saveError.el.hidden = false;
      picker.set({value: profileOf(account)});
    } finally {
      saving--;
      update();
    }
  }

  // ---- the no-stem note ---------------------------------------------------------------------------------------
  const noteText = h('p', {class: 'sheet-mix-note-text'});
  const resplit = Button({label: M.resplit, command: 'song.resplit', registry, size: 'md', variant: 'secondary', className: 'sheet-mix-resplit'});
  parts.push(resplit);
  const note = h('div', {class: 'sheet-mix-note', id: noteId}, noteText, resplit.el);

  // ---- mode switch -------------------------------------------------------------------------------------------
  const tapTo = Segmented({label: M.tapTo, size: 'md', className: 'sheet-mix-mode', value: mode,
    options: [{value: 'mute', label: M.mute}, {value: 'solo', label: M.solo}],
    onChange: (value) => { mode = value === 'solo' ? 'solo' : 'mute'; update(); }});
  parts.push(tapTo);
  const modeLabel = h('span', {class: 'sheet-mix-mode-label', attrs: {'aria-hidden': 'true'}}, M.tapTo);
  const modeRow = h('div', {class: 'sheet-mix-mode-row'}, modeLabel, tapTo.el, h('p', {class: 'sheet-mix-hint'}, M.soloHint));

  // ---- stem pads ---------------------------------------------------------------------------------------------
  const pads = h('div', {class: 'sheet-mix-pads', role: 'group', attrs: {'aria-label': M.stems}});
  const noStems = h('p', {class: 'sheet-mix-hint'}, M.noStems);
  const padEntries = new Map();
  function padProps(track, index) {
    return {
      name: stemLabel(track.name), color: stemToken(track.name), state: padState(track), level: track.volume,
      keyCap: index < KEYED ? `Digit${index + 1}` : null, mode, size: sheetLayout(container, layout),
      dataset: {stem: track.name},
    };
  }
  function createPad(track) {
    const name = track.name;
    const current = () => mixOf().tracks.find((t) => t.name === name) ?? track;
    const pad = StemPad({...padProps(track, 0),
      onToggle: () => { transport.setMuted(name, !current().muted); },
      onSolo: () => { transport.setSoloed(name, !current().soloed); },
      onLevel: (v) => { transport.setVolume(name, v); },
    });
    const entry = {el: pad.el, pad, update: (item) => pad.set(padProps(item.track, item.index)), destroy: () => pad.destroy()};
    padEntries.set(name, entry);
    return entry;
  }

  // ---- chart playback ----------------------------------------------------------------------------------------
  const chartOptions = () => CHART_LEVELS.map((level) => {
    const st = stateOf('mix.chartAudio', {level});
    return {value: level, label: M.chartLevels[level], disabled: !st?.enabled, reason: st?.enabled ? null : st?.reason ?? null, checked: !!st?.checked};
  });
  const chartValue = (options) => options.find((o) => o.checked)?.value ?? 'off';
  const bare = (options) => options.map(({checked: _, ...o}) => o);
  const firstChart = chartOptions();
  const chart = Segmented({label: M.chartAudio, size: 'md', className: 'sheet-mix-chart', value: chartValue(firstChart),
    options: bare(firstChart),
    onChange: (level) => { run('mix.chartAudio', {level}); update(); }});
  parts.push(chart);
  const chartLabelId = `${id}-chart`;
  const chartRow = h('section', {class: 'sheet-mix-chart-row', attrs: {'aria-labelledby': chartLabelId}},
    h('h3', {class: 'sheet-mix-heading', id: chartLabelId}, M.chartAudio), chart.el);

  const el = h('div', {class: 'sheet-mix', dataset: {sheetContent: 'mix'}}, top, pickerRegion, note, modeRow, pads, noStems, chartRow);
  container.append(el);

  function update() {
    const mix = mixOf();
    const tracks = Array.isArray(mix.tracks) ? mix.tracks : [];
    const stems = tracks.map((t) => t.name);
    const profile = profileOf(account);
    const mine = Array.isArray(mix.mine) ? mix.mine : [];
    const hasPart = mine.length > 0;
    const notes = stems.length ? mixNotes(profile, stems) : null;
    el.dataset.layout = sheetLayout(container, layout);

    // Top row.
    const mineWords = M.join(mine.map(stemLabel));
    const minusState = stateOf('mix.minusMe'), onlyState = stateOf('mix.onlyMe');
    minusMe.set({label: M.minusMe(mineWords), pressed: !!minusState?.checked, disabled: !hasPart || !minusState?.enabled,
      disabledReason: minusState?.reason ?? null, attrs: {'aria-describedby': !hasPart && notes ? noteId : null}});
    onlyMe.set({pressed: !!onlyState?.checked, disabled: !hasPart || !onlyState?.enabled, disabledReason: onlyState?.reason ?? null,
      attrs: {'aria-describedby': !hasPart && notes ? noteId : null}});
    fullMix.set({});
    fullMix.el.dataset.full = String(tracks.every((t) => !t.muted && !t.soloed && t.volume === 1));
    const instruments = M.list(profile.instruments.map((i) => INSTRUMENT_LABELS[i] ?? i));
    iPlay.set({label: M.iPlay(instruments), attrs: {'aria-expanded': String(pickerOpen), 'aria-controls': `${id}-picker`}});
    iPlay.el.hidden = !writable;
    if (!saving) picker.set({value: profile});
    pickerRegion.hidden = !writable || !pickerOpen;

    // The no-stem note. A read-only song can be neither re-split nor told what you play, so it
    // keeps only the plain fact.
    let text = '';
    let showResplit = false;
    if (notes?.kind === 'choose') text = writable ? M.choose : M.chooseShared;
    else if (notes?.kind === 'missing') {
      text = !writable ? M.noMatch(notes.instruments) : `${M.noMatch(notes.instruments)} ${onDesktop() ? M.noMatchDesktop : M.noMatchWeb}`;
      showResplit = writable && onDesktop();
    } else if (notes?.kind === 'fallback') {
      text = !writable || onDesktop() ? M.fallback(notes.instruments) : `${M.fallback(notes.instruments)} ${M.fallbackWeb}`;
      showResplit = writable && onDesktop();
    }
    noteText.textContent = text;
    note.hidden = !text;
    note.dataset.kind = notes?.kind ?? '';
    resplit.el.hidden = !showResplit;

    // Pads.
    tapTo.set({value: mode});
    reconcileList(pads, tracks.map((track, index) => ({track, index})), {
      key: (item) => item.track.name,
      create: (item) => { const entry = createPad(item.track); entry.update(item); return entry; },
    });
    for (const name of [...padEntries.keys()]) if (!stems.includes(name)) padEntries.delete(name);
    pads.hidden = !tracks.length;
    modeRow.hidden = !tracks.length;
    noStems.hidden = tracks.length > 0;

    // Chart playback.
    chartRow.hidden = !session.notation?.part;
    const levels = chartOptions();
    chart.set({options: bare(levels), value: chartValue(levels)});
  }

  // With no instrument chosen (or none on this song), the picker opens at once.
  {
    const first = mixOf();
    const stems = (first.tracks ?? []).map((t) => t.name);
    const notes = stems.length ? mixNotes(profileOf(account), stems) : null;
    pickerOpen = writable && (notes?.kind === 'choose' || notes?.kind === 'missing');
  }

  offs.push(transport.snapshot.subscribe(() => update()));
  if (typeof registry.onChange === 'function') offs.push(registry.onChange(() => update()));
  const accountSource = account?.profile?.subscribe ? account.profile : account?.value?.subscribe ? account.value : null;
  if (accountSource) offs.push(accountSource.subscribe(() => update()));
  if (session.notation?.hasNotation?.subscribe) offs.push(session.notation.hasNotation.subscribe(() => update()));
  let destroyed = false;
  void Promise.resolve(session.notation?.ready).then(() => { if (!destroyed) update(); }, () => {});
  update();

  return {
    el,
    destroy() {
      destroyed = true;
      for (const off of offs.splice(0)) { try { off?.(); } catch (err) { console.error('[mix sheet] cleanup failed', err); } }
      for (const entry of padEntries.values()) entry.destroy();
      padEntries.clear();
      for (const p of parts.splice(0)) p.destroy();
      el.remove();
    },
  };
}

export default render;
