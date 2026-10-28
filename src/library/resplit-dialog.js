// The Re-split dialog (architecture §2.16, spec §3.7; D38): "Re-split Harbor Lights" with Stems and Quality segmented
// controls, the cost line and [Re-split].
//
//   openResplitDialog({songId, songIds, stemMode, preset, router, desktop, store, account, prefs, jobs, device})
//     → Promise<void>   resolves once the dialog has closed (after the jobs started, or on Cancel)
//   openResplit(song, opts) → the same for one song (the contract name, §2.16)
//   presetOf(quality) → 'fast'|'balanced'|'studio'|null   the preset a song's stored `quality` was split with
//   estimateMinutes({stats, preset, seconds}) → number|null     from prefs.jobStats ({[preset]: {secPerMin, n}}, DT2)
//   costLine({device, preset, stemMode, seconds, stats, many}) → the cost line
//
// `song.resplit` (src/stage/commands.js, scopes Stage and Library) imports this module and calls
// openResplitDialog({songId, router, desktop}); the card menu and the selection bar call it directly.
//
// - Stems: 4 stems · 6 stems · Drums + rest · Vocals + rest · Bass + rest, preselected from the song's stem layout
//   (`stemMode`, or opts.stemMode: "Re-split with 6 stems" passes 'six'). Quality: Fast · Balanced · Studio (and
//   Custom when the account uses it), preselected from the song's stored quality, else the account preset.
// - Cost line: "Runs on <this computer's name> · about N min at <Quality> · replaces the stems; your loops, map, spots
//   and chart are kept." The estimate is prefs.jobStats[preset].secPerMin × the songs' minutes; without history the
//   middle clause is "<Quality> quality".
// - [Re-split] runs jobs.createSeparation({deviceId, settings, label, replaceSongId}) for each song on this computer's
//   processor (the song's own source; the server keeps loops, map, spots and chart). The dialog stays open while it
//   runs; a refusal is shown inline in the dialog, in error-copy's words (context 'resplit'): D38's "Re-split this song
//   on <device>, which has the original file.", the processor being offline, an export-only account. With several
//   songs, the ones that started are kept and a partial failure is reported in a toast.
// - Desktop only. On the web the dialog does not open: a toast says "Needs Woodshed for desktop" (the card menu and
//   song.resplit already disable the item with that reason).

import '../styles/views/library/selection.css';
import {store as appStore} from '../app/store.js';
import {account as appAccount} from '../app/account.js';
import {prefs as appPrefs} from '../app/prefs.js';
import {desktop as appDesktop} from '../app/desktop.js';
import {toast as appToast} from '../app/feedback.js';
import {describeError} from '../app/error-copy.js';
import * as jobsApi from '../api/jobs.js';
import {PRESETS, SIX_STEM_MODEL} from '../../convex/lib/presets.ts';
import {Dialog} from '../ui/dialog.js';
import {Segmented} from '../ui/segmented.js';
import {h} from '../ui/h.js';
import {STEM_MODES, jobSettings} from './add-model.js';
import {uploadDevice} from './upload.js';
import {COPY} from './library-actions.copy.js';

export const QUALITY_PRESETS = Object.freeze(['fast', 'balanced', 'studio']);
const DIALOG_WIDTH = 600;
let seq = 0;

/** The preset a stored `quality` came from: same model (the 6-stem model runs every preset) and passes. */
export function presetOf(quality) {
  if (!quality || typeof quality !== 'object') return null;
  for (const id of QUALITY_PRESETS) {
    const p = PRESETS[id];
    const model = quality.model === p.model || quality.model === SIX_STEM_MODEL;
    if (model && Number(quality.shifts) === p.shifts && Number(quality.overlap) === p.overlap) return id;
  }
  return null;
}

/** Whole minutes for `seconds` of audio at `preset` from the local job history, or null without any. */
export function estimateMinutes({stats, preset, seconds}) {
  const entry = stats && typeof stats === 'object' ? stats[preset] : null;
  const rate = Number(entry?.secPerMin);
  const length = Number(seconds);
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(length) || length <= 0) return null;
  return Math.max(1, Math.round((rate * (length / 60)) / 60));
}

/** The cost line (spec §3.7). */
export function costLine({device, preset, seconds, stats, many = false}) {
  const quality = COPY.presets[preset] ?? COPY.presets.balanced;
  return COPY.cost({device: device || COPY.thisComputer, minutes: estimateMinutes({stats, preset, seconds}), quality, many});
}

const isStemMode = mode => STEM_MODES.includes(mode);
const titleOf = song => song?.title || 'Untitled';

/** One song's re-split dialog (the §2.16 contract name). */
export function openResplit(song, opts = {}) {
  return openResplitDialog({...opts, songIds: [song?.id].filter(Boolean)});
}

export async function openResplitDialog(opts = {}) {
  const store = opts.store ?? appStore;
  const account = opts.account ?? appAccount;
  const prefs = opts.prefs ?? appPrefs;
  const desktop = opts.desktop ?? appDesktop;
  const jobs = opts.jobs ?? jobsApi;
  const toast = opts.toast ?? appToast;
  const device = opts.device ?? uploadDevice;

  if (!desktop?.available) { toast(COPY.needsDesktop); return; }
  const wanted = opts.songIds ?? (opts.songId != null ? [opts.songId] : []);
  const library = store.library.songs.peek();
  const songs = [...new Set(wanted)].map(id => library.get(id)).filter(Boolean);
  if (!songs.length) { toast(COPY.resplitGone, {tone: 'error'}); return; }
  const many = songs.length > 1;

  const settings = account.value.peek() ?? {};
  const profile = account.profile?.peek?.() ?? settings.profile ?? null;
  const fallback = jobSettings(profile, settings);
  const common = (pick) => { const values = new Set(songs.map(pick)); return values.size === 1 ? [...values][0] : null; };
  let stemMode = isStemMode(opts.stemMode) ? opts.stemMode : (isStemMode(common(s => s.stemMode)) ? common(s => s.stemMode) : fallback.stemMode);
  const presets = settings.preset === 'custom' ? [...QUALITY_PRESETS, 'custom'] : [...QUALITY_PRESETS];
  let preset = presets.includes(opts.preset) ? opts.preset
    : (common(s => presetOf(s.quality)) ?? (presets.includes(settings.preset) ? settings.preset : 'balanced'));

  const seconds = songs.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
  const processor = () => desktop.processor?.peek?.() ?? null;
  const cost = h('p', {class: 'lib-resplit-cost', attrs: {'aria-live': 'polite'}});
  const renderCost = () => {
    cost.textContent = costLine({device: processor()?.name, preset, seconds, stats: prefs.value?.peek?.()?.jobStats, many});
  };

  const id = `lib-resplit-${++seq}`;
  const stemsLabel = h('span', {class: 'lib-resplit-label', id: `${id}-stems`}, COPY.stems);
  const qualityLabel = h('span', {class: 'lib-resplit-label', id: `${id}-quality`}, COPY.quality);
  const stems = Segmented({value: stemMode, className: 'lib-resplit-stems', attrs: {'aria-labelledby': stemsLabel.id},
    options: STEM_MODES.map(mode => ({value: mode, label: COPY.stemModes[mode]})),
    onChange: value => { stemMode = value; renderCost(); }});
  const quality = Segmented({value: preset, className: 'lib-resplit-quality', attrs: {'aria-labelledby': qualityLabel.id},
    options: presets.map(p => ({value: p, label: COPY.presets[p]})),
    onChange: value => { preset = value; renderCost(); }});
  renderCost();
  const body = h('div', {class: 'lib-resplit'},
    h('div', {class: 'lib-resplit-group'}, stemsLabel, stems.el),
    h('div', {class: 'lib-resplit-group'}, qualityLabel, quality.el),
    cost);

  async function submit() {
    let deviceId = processor()?.deviceId ?? null;
    try {
      if (!deviceId) deviceId = await device();
    } catch (err) {
      throw new Error(describeError(err, {context: 'resplit'}).sentence);
    }
    const jobSettingsNow = jobSettings(profile, settings, {stemMode, preset});
    const started = [], failed = [];
    for (const song of songs) {
      try {
        await jobs.createSeparation({deviceId, settings: jobSettingsNow, label: titleOf(song), replaceSongId: song.id});
        started.push(song);
      } catch (error) {
        failed.push({song, error});
      }
    }
    if (!started.length) throw new Error(describeError(failed[0].error, {context: 'resplit'}).sentence);
    desktop.refreshStatus?.();
    if (failed.length) {
      toast(COPY.resplitPartial(started.length, songs.length), {tone: 'error', key: 'lib-resplit'});
    } else {
      toast(many ? COPY.resplitStarted(started.length) : COPY.resplitStartedOne(titleOf(started[0])), {tone: 'ok', key: 'lib-resplit'});
    }
  }

  const dialog = Dialog({
    title: many ? COPY.resplitTitleMany(songs.length) : COPY.resplitTitle(titleOf(songs[0])),
    body,
    width: DIALOG_WIDTH,
    className: 'lib-resplit-dialog',
    form: {fields: [], onSubmit: submit},
    actions: [
      {label: COPY.resplitCancel, value: null, variant: 'secondary'},
      {label: COPY.resplitConfirm, value: 'submit', variant: 'primary', submit: true, autofocus: true},
    ],
  });
  try {
    await dialog.closed;
  } finally {
    stems.destroy();
    quality.destroy();
  }
}
