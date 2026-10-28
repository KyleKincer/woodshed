// Settings → Processing (architecture §2.17, §2.11, §6.5, §6.6, D40, D47, §9.12 SE2; spec §6.2, §6.5,
// §3.2): how songs are split, and the processor that splits them.
//
// In Woodshed for desktop:
//   Processor            the processor status (processorLabel: "Processor ready", "Splitting 1 · 46%",
//                        "Starting… (first run, ~1 min)", "Offline — Restart", "Couldn't connect this
//                        computer to your account.") and [Restart processor] (desktop.restartProcessor);
//                        a pairing failure adds [Try again] (desktop.retryPairing). /status is polled
//                        (desktop.watchStatus) while the section is open.
//   Default stems        Full band · 4 | Full band + guitar & piano · 6 (account stemMode, written with
//                        addDefaultsSaved: true so the Add sheet honours it, profile.js addDefaults). Two-part
//                        splits are never a default (spec §3.2); the Add sheet chooses them per song. A
//                        layout that takes away the profile's own stem says so.
//   Quality              one segmented control: Fast · Balanced · Studio · Custom (account preset), the
//                        preset's description and, once this computer has split songs, its estimate
//                        (prefs.jobStats). The duplicate 1.9 slider is gone.
//   Advanced <details>   Model, Quality passes (0–10), Overlap (0.1–0.75): any change makes the quality
//                        Custom (account custom). Open while the quality is Custom.
//   Audio bitrate        Opus bitrate per stem (account bitrate); the 1.9 format choice is gone.
//   Notify when songs are ready · Find bars automatically · Suggest sections automatically
//                        account notifyReady, autoBeats (B6) and autoSections (D47)
//   Import an old Woodshed library   the companion's /legacy scan, then /import (20 songs at a time)
//   Export original audio            the companion's /export-originals (WAV and FLAC into Downloads)
// In a browser (spec §6.2: "on web it shows processor status plus the B5 device list"):
//   Processor            which paired computer splits the songs added here (B5): online, busy, offline
//   Your computers       each paired computer (store.library.devices): name, Online / Offline · last seen,
//                        songs waiting, platform and version, [Rename] (devices.rename) and [Remove]
//                        (devices.revoke, after a confirm)
//   the one desktop note "These need Woodshed for desktop: Import an old library, Export original audio,
//                        Processing. [Get it ↗]" — desktop-only rows are never shown disabled.
//
// Every account control saves on change through its row's saver ("Saved" / "Couldn't save · [Retry]");
// account.patch is optimistic and reverts on failure, and the controls follow the stored settings
// (another device or tab, a revert) while the section is open.
//
// Copy and controls are exported here (COPY, CONTROLS, ROWS) because settings.copy.js is SE1's
// (architecture §9.0, "copy and controls tables"). Tests and harnesses may pass, beside the frame's
// ctx: `companion` (a loader resolving to {legacyLibraries, importLegacy, localRequest}), `devicesApi`
// ({rename, revoke}), `now` and `timers`.

import '../../styles/views/settings/sections.css';
import '../../styles/views/settings/processing.css';
import {h, reconcileList} from '../../ui/h.js';
import {Button, uid} from '../../ui/button.js';
import {Segmented} from '../../ui/segmented.js';
import {Stepper} from '../../ui/stepper.js';
import {Toggle} from '../../ui/toggle.js';
import {Select, TextField} from '../../ui/field.js';
import {InlineStatus} from '../../ui/status.js';
import {icon} from '../../ui/icon.js';
import {createSaver, desktopNote, settingRow} from '../settings.js';
import {SECTION_TITLES} from '../settings.copy.js';
import {processorLabel} from '../../app/desktop.js';
import {addDefaults} from '../../app/profile.js';
import {describeError} from '../../app/error-copy.js';
import {feedback as appFeedback} from '../../app/feedback.js';
import {now as clockNow} from '../../app/clock.js';
import {removesMyStem, removesMyStemLine} from '../../library/add-model.js';
import {relativeTime} from '../../library/song-labels.js';
import * as appDevicesApi from '../../api/devices.js';
import {BITRATES, DEFAULT_PRESET, MODELS, OVERLAP, PRESETS, SHIFTS, SIX_STEM_MODEL} from '../../../convex/lib/presets.ts';

/** The stem layouts Settings offers as the default (spec §3.2: two-part splits are never a default). */
export const DEFAULT_LAYOUTS = Object.freeze(['full', 'six']);
/** The quality choices, in order; 'custom' is the Advanced mix. */
export const QUALITY_CHOICES = Object.freeze(['fast', 'balanced', 'studio', 'custom']);
/** devices.rename accepts 1–80 characters after trimming (convex/devices.ts). */
export const DEVICE_NAME_MAX = 80;
/** The song length the quality estimate speaks of. */
export const ESTIMATE_SONG_MINUTES = 4;

export const COPY = Object.freeze({
  processor: Object.freeze({
    label: 'Processor',
    restart: 'Restart processor',
    restarting: 'Restarting…',
    tryAgain: 'Try again',
    restartFailed: 'The processor didn’t restart. Quit Woodshed and open it again.',
    thisComputer: name => `On this computer: ${name}`,
    hint: 'Woodshed for desktop splits songs and finds their bars on this computer.',
  }),
  stems: Object.freeze({
    label: 'Default stems',
    full: 'Full band · 4',
    six: 'Full band + guitar & piano · 6',
    hint: 'For the songs you add. When you add a song you can pick another layout for it, including a two-part split.',
  }),
  quality: Object.freeze({
    label: 'Quality',
    fast: 'Fast',
    balanced: 'Balanced',
    studio: 'Studio',
    custom: 'Custom',
    customHint: 'Your own model, passes and overlap, set under Advanced.',
    estimate: minutes => (minutes < 1
      ? `Under a minute for a ${ESTIMATE_SONG_MINUTES}-minute song on this computer.`
      : `About ${minutes} min for a ${ESTIMATE_SONG_MINUTES}-minute song on this computer.`),
  }),
  advanced: Object.freeze({
    summary: 'Advanced',
    model: 'Model',
    passes: 'Quality passes',
    fewerPasses: 'Fewer passes',
    morePasses: 'More passes',
    overlap: 'Overlap',
    lessOverlap: 'Less overlap',
    moreOverlap: 'More overlap',
    hint: 'Changing any of these makes the quality Custom. More passes sound cleaner and take longer; overlap is usually best left at 0.25.',
    sixNote: 'Full band + guitar & piano always splits with the With piano & guitar model.',
  }),
  bitrate: Object.freeze({
    label: 'Audio bitrate',
    hint: 'Per stem. A higher bitrate sounds closer to the original and uses more cloud storage. It applies to songs split from now on.',
  }),
  notify: Object.freeze({
    label: 'Notify when songs are ready',
    hint: 'A notification when a song finishes splitting while you’re in another app.',
  }),
  autoBeats: Object.freeze({
    label: 'Find bars automatically',
    hint: 'After a song is split, Woodshed finds its bars and beats, so loops and the road map line up with the music.',
  }),
  autoSections: Object.freeze({
    label: 'Suggest sections automatically',
    hint: 'Woodshed suggests where the verses and choruses are. Nothing changes in a song until you keep the suggestions.',
  }),
  importLegacy: Object.freeze({
    label: 'Import an old Woodshed library',
    hint: 'Adds the songs from an earlier version of Woodshed on this computer. Your old files stay where they are.',
    find: 'Find old library',
    finding: 'Looking…',
    none: 'No old library was found on this computer. If you know where it is, enter its folder.',
    found: (count, directory) => `${count} ${count === 1 ? 'song' : 'songs'} in ${directory}`,
    importFound: count => `Import ${count} ${count === 1 ? 'song' : 'songs'}`,
    importFoundIn: (count, directory) => `Import ${count} ${count === 1 ? 'song' : 'songs'} from ${directory}`,
    folder: 'Old library folder',
    folderHint: 'The folder that holds library.json.',
    importFolder: 'Import from this folder',
    importing: 'Importing…',
    queued: count => `Added ${count} ${count === 1 ? 'song' : 'songs'} to Jobs. Your old files are kept.`,
    remaining: count => `When they finish, import again for the other ${count}.`,
    skipped: count => `${count} ${count === 1 ? 'was' : 'were'} already in your library.`,
    nothingNew: 'Every song in this library is already in Woodshed or on its way.',
    failed: 'The old library couldn’t be imported.',
  }),
  exportOriginals: Object.freeze({
    label: 'Export original audio',
    button: 'Export original audio',
    exporting: 'Exporting…',
    hint: 'Copies the WAV and FLAC files this computer made into a new folder in Downloads.',
    done: (count, directory) => `Copied ${count} ${count === 1 ? 'file' : 'files'} to ${directory}.`,
    empty: 'There is no original audio on this computer yet.',
    failed: 'The original audio couldn’t be exported.',
  }),
  web: Object.freeze({
    label: 'Processor',
    online: name => `${name} is online. Songs you add here are split on it.`,
    busy: name => `${name} is online and splitting a song. Songs you add here wait their turn.`,
    offline: name => `${name} is offline. Songs you add here start when it’s back.`,
    none: 'No computer is connected yet. Woodshed for desktop splits songs on your Mac, Windows or Linux computer, and they appear here.',
  }),
  devices: Object.freeze({
    label: 'Your computers',
    hint: 'Computers signed in to Woodshed for desktop with this account.',
    listLabel: 'Paired computers',
    online: 'Online',
    busy: 'Online · splitting a song',
    offline: when => (when ? `Offline · last seen ${when}` : 'Offline'),
    never: 'Not seen yet',
    queued: n => (n >= appDevicesApi.QUEUED_COUNT_CAP ? 'More than 20 songs waiting' : `${n} ${n === 1 ? 'song' : 'songs'} waiting`),
    version: v => `Woodshed ${v}`,
    rename: 'Rename',
    renameName: name => `Rename ${name}`,
    remove: 'Remove',
    removeName: name => `Remove ${name}`,
    nameField: 'Name',
    save: 'Save',
    removeTitle: name => `Remove ${name}?`,
    removeBody: 'It stops splitting songs for this account. Signing in to Woodshed for desktop on it again connects it again.',
    removeConfirm: 'Remove',
    removed: name => `Removed ${name}.`,
    failed: 'That didn’t work. Check your connection and try again.',
    unnamed: 'Your computer',
  }),
  platforms: Object.freeze({darwin: 'Mac', win32: 'Windows', linux: 'Linux'}),
  /** The web note's items (spec §6.2, exactly). */
  desktopItems: Object.freeze(['Import an old library', 'Export original audio', 'Processing']),
});

const C = COPY;

/**
 * Every control the section shows, as [{section, context, role, name, group?}] (the same table form as
 * settings.copy.js CONTROLS). Contexts: 'desktop' (Woodshed for desktop), 'web' (a browser; the paired
 * computers' Rename/Remove buttons are named per computer, COPY.devices.renameName/removeName),
 * 'pairFailed' (desktop, the processor could not pair), 'legacyNone' (desktop, after a scan that found
 * no old library).
 */
const radios = (group, names, context = 'desktop') => [
  {section: 'processing', context, role: 'radiogroup', name: group},
  ...names.map(name => ({section: 'processing', context, role: 'radio', name, group})),
];
export const CONTROLS = Object.freeze([
  {section: 'processing', context: 'desktop', role: 'button', name: C.processor.restart},
  {section: 'processing', context: 'pairFailed', role: 'button', name: C.processor.tryAgain},
  ...radios(C.stems.label, [C.stems.full, C.stems.six]),
  ...radios(C.quality.label, QUALITY_CHOICES.map(id => C.quality[id])),
  {section: 'processing', context: 'desktop', role: 'combobox', name: C.advanced.model},
  {section: 'processing', context: 'desktop', role: 'spinbutton', name: C.advanced.passes},
  {section: 'processing', context: 'desktop', role: 'button', name: C.advanced.fewerPasses},
  {section: 'processing', context: 'desktop', role: 'button', name: C.advanced.morePasses},
  {section: 'processing', context: 'desktop', role: 'spinbutton', name: C.advanced.overlap},
  {section: 'processing', context: 'desktop', role: 'button', name: C.advanced.lessOverlap},
  {section: 'processing', context: 'desktop', role: 'button', name: C.advanced.moreOverlap},
  {section: 'processing', context: 'desktop', role: 'combobox', name: C.bitrate.label},
  {section: 'processing', context: 'desktop', role: 'button', name: C.notify.label},
  {section: 'processing', context: 'desktop', role: 'button', name: C.autoBeats.label},
  {section: 'processing', context: 'desktop', role: 'button', name: C.autoSections.label},
  {section: 'processing', context: 'desktop', role: 'button', name: C.importLegacy.find},
  {section: 'processing', context: 'legacyNone', role: 'textbox', name: C.importLegacy.folder},
  {section: 'processing', context: 'legacyNone', role: 'button', name: C.importLegacy.importFolder},
  {section: 'processing', context: 'desktop', role: 'button', name: C.exportOriginals.button},
  {section: 'processing', context: 'web', role: 'link', name: 'Get it ↗'},
].map(Object.freeze));

/**
 * The rows, as [{section, row, label, scope, path, context}]: `scope` is where the value is kept (D40:
 * every processing setting is the account's; 'info' rows show facts or run actions).
 */
export const ROWS = Object.freeze([
  {section: 'processing', row: 'processor', label: C.processor.label, scope: 'info', path: null, context: 'desktop'},
  {section: 'processing', row: 'stemMode', label: C.stems.label, scope: 'account', path: 'stemMode', context: 'desktop'},
  {section: 'processing', row: 'quality', label: C.quality.label, scope: 'account', path: 'preset', context: 'desktop'},
  {section: 'processing', row: 'advanced', label: null, scope: 'account', path: 'custom', context: 'desktop'},
  {section: 'processing', row: 'bitrate', label: null, scope: 'account', path: 'bitrate', context: 'desktop'},
  {section: 'processing', row: 'notifyReady', label: C.notify.label, scope: 'account', path: 'notifyReady', context: 'desktop'},
  {section: 'processing', row: 'autoBeats', label: C.autoBeats.label, scope: 'account', path: 'autoBeats', context: 'desktop'},
  {section: 'processing', row: 'autoSections', label: C.autoSections.label, scope: 'account', path: 'autoSections', context: 'desktop'},
  {section: 'processing', row: 'importLegacy', label: C.importLegacy.label, scope: 'info', path: null, context: 'desktop'},
  {section: 'processing', row: 'exportOriginals', label: C.exportOriginals.label, scope: 'info', path: null, context: 'desktop'},
  {section: 'processing', row: 'processor', label: C.web.label, scope: 'info', path: null, context: 'web'},
  {section: 'processing', row: 'devices', label: C.devices.label, scope: 'info', path: null, context: 'web'},
].map(Object.freeze));

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)

/** The quality choice the stored settings show: a preset id, or 'custom'. */
export function qualityChoice(settings, presets = PRESETS) {
  const preset = settings?.preset;
  if (preset === 'custom') return 'custom';
  return presets?.[preset] ? preset : (presets?.[DEFAULT_PRESET] ? DEFAULT_PRESET : 'custom');
}

/** The {model, shifts, overlap} a split runs with: the preset's, or the custom mix. */
export function effectiveQuality(settings, presets = PRESETS) {
  const choice = qualityChoice(settings, presets);
  const source = choice === 'custom' ? settings?.custom : presets[choice];
  return {
    model: typeof source?.model === 'string' && source.model ? source.model : PRESETS[DEFAULT_PRESET].model,
    shifts: Number.isFinite(source?.shifts) ? source.shifts : PRESETS[DEFAULT_PRESET].shifts,
    overlap: Number.isFinite(source?.overlap) ? source.overlap : PRESETS[DEFAULT_PRESET].overlap,
  };
}

/** The default layout the account shows (profile.js addDefaults; only full or six). */
export function defaultLayout(profile, settings) {
  const {stemMode} = addDefaults(profile, settings);
  return DEFAULT_LAYOUTS.includes(stemMode) ? stemMode : 'full';
}

/** "About 2 min for a 4-minute song on this computer.", from prefs.jobStats; '' without history. */
export function estimateText(jobStats, preset) {
  const stat = jobStats?.[preset];
  if (!stat || !(Number(stat.n) >= 1) || !(Number(stat.secPerMin) > 0)) return '';
  const minutes = Math.round((stat.secPerMin * ESTIMATE_SONG_MINUTES) / 60);
  return C.quality.estimate(minutes);
}

const round2 = v => Math.round(v * 100) / 100;

/** 'darwin-arm64' → 'Mac'; '' for an unknown platform. */
export function platformName(platform) {
  const os = String(platform ?? '').split('-')[0];
  return C.platforms[os] ?? '';
}

/** A paired computer's state: {state: 'online'|'busy'|'offline'|'never', text}. */
export function deviceStatus(device, now) {
  if (typeof device?.lastSeenAt !== 'number') return {state: 'never', text: C.devices.never};
  if (appDevicesApi.isOnline(device, now)) {
    return device.state === 'busy' ? {state: 'busy', text: C.devices.busy} : {state: 'online', text: C.devices.online};
  }
  return {state: 'offline', text: C.devices.offline(relativeTime(device.lastSeenAt, now))};
}

const nameOf = device => String(device?.name ?? '').trim() || C.devices.unnamed;

/** The web Processor line (B5): the computer that splits what is added here. */
export function webProcessorText(devices, now) {
  const list = Array.isArray(devices) ? devices.filter(Boolean) : [];
  const online = appDevicesApi.onlineDevices(list, now);
  if (online.length) {
    const device = online.find(d => d.state !== 'busy') ?? online[0];
    return {state: device.state === 'busy' ? 'busy' : 'online', text: device.state === 'busy' ? C.web.busy(nameOf(device)) : C.web.online(nameOf(device))};
  }
  if (list.length) return {state: 'offline', text: C.web.offline(nameOf(list[0]))};
  return {state: 'none', text: C.web.none};
}

/** What an /import answer says: queued, skipped and remaining songs. */
export function importResultText(result) {
  const count = Number(result?.count) || 0, skipped = Number(result?.skipped) || 0, remaining = Number(result?.remaining) || 0;
  if (!count && !remaining) return C.importLegacy.nothingNew;
  const parts = [];
  if (count) parts.push(C.importLegacy.queued(count));
  if (skipped) parts.push(C.importLegacy.skipped(skipped));
  if (remaining) parts.push(C.importLegacy.remaining(remaining));
  return parts.join(' ');
}

/** What an /export-originals answer says. */
export function originalsText(result) {
  const count = Number(result?.count) || 0;
  return count ? C.exportOriginals.done(count, String(result?.directory ?? '')) : C.exportOriginals.empty;
}

/** A sentence for a failed local-processor request: error-copy for coded ones, else the processor's own words. */
export function companionErrorText(err, lead) {
  const code = typeof err?.code === 'string' ? err.code : 'unknown';
  if (code !== 'unknown' && code !== 'invalid') return `${lead} ${describeError(err, {context: 'job'}).sentence}`;
  const own = String(err?.message ?? '').trim();
  return own ? `${lead} ${own}` : lead;
}

// ---------------------------------------------------------------------------------------------
// The section

function render(el, ctx) {
  const {account, prefs, platform, desktop, store} = ctx;
  const desktopApp = !!(platform?.isDesktopApp || desktop?.available);
  const parts = [];
  const offs = [];
  const keep = part => { parts.push(part); return part; };
  let destroyed = false;

  const page = h('div', {class: 'settings-section settings-processing', dataset: {section: 'processing', context: desktopApp ? 'desktop' : 'web'}});
  if (desktopApp) renderDesktop();
  else renderWeb();
  el.replaceChildren(page);

  // ------------------------------------------------------------------- desktop
  function renderDesktop() {
    const settings = () => account.value.peek();
    const config = () => store?.config?.peek?.() ?? null;
    const presets = () => config()?.presets ?? PRESETS;
    const models = () => config()?.models ?? MODELS;
    const bitrates = () => config()?.bitrates ?? BITRATES;
    const companion = ctx.companion ?? (() => import('../../js/companion.js'));
    const saverFor = focus => keep(createSaver({focus}));
    const patch = (saver, change) => saver.run(() => account.patch(change));
    const rows = [];

    // ---- Processor
    {
      const dot = h('span', {class: 'settings-processor-dot', 'aria-hidden': 'true'});
      const label = h('span', {class: 'settings-processor-label'});
      const line = h('p', {class: 'settings-value settings-processor', role: 'status'}, dot, label);
      const name = h('p', {class: 'settings-row-hint settings-processor-name'});
      const problem = InlineStatus({tone: 'error', text: ''});
      problem.el.hidden = true;
      keep(problem);
      const restart = keep(Button({label: C.processor.restart, icon: 'refresh-cw', onClick: async () => {
        problem.el.hidden = true;
        restart.set({busy: C.processor.restarting, disabled: true});
        try {
          await desktop.restartProcessor();
        } catch (err) {
          console.warn('[settings] the processor did not restart:', err?.message ?? err);
          if (!destroyed) { problem.set({text: C.processor.restartFailed}); problem.el.hidden = false; }
        } finally {
          if (!destroyed) restart.set({busy: false, disabled: false});
        }
      }}));
      const retry = keep(Button({label: C.processor.tryAgain, onClick: async () => {
        retry.set({busy: true, disabled: true});
        try { await desktop.retryPairing(); } finally { if (!destroyed) retry.set({busy: false, disabled: false}); }
      }}));
      const show = p => {
        const phase = p?.phase ?? 'starting';
        label.textContent = (phase === 'pair-failed' ? p.message : null) || processorLabel(p) || '';
        line.dataset.phase = phase;
        const state = phase === 'ready' || phase === 'busy' ? 'ok' : phase === 'offline' || phase === 'pair-failed' ? 'off' : 'wait';
        line.dataset.state = state;
        name.textContent = p?.name ? C.processor.thisComputer(p.name) : '';
        retry.el.hidden = phase !== 'pair-failed';
        restart.set({variant: phase === 'offline' ? 'primary' : 'secondary'});
      };
      const processor = desktop.processor ?? store?.processor;
      show(processor?.peek?.());
      if (processor?.subscribe) offs.push(processor.subscribe(show));
      offs.push(desktop.watchStatus?.() ?? (() => {}));
      rows.push(settingRow({row: 'processor', label: C.processor.label, hint: C.processor.hint, scope: 'info',
        controls: [line, h('div', {class: 'settings-actions'}, restart.el, retry.el), name, problem.el]}));
    }

    // ---- Default stems
    let stemSeg, stemWarning;
    {
      const saver = saverFor(() => stemSeg.el.querySelector('[aria-checked=true]'));
      const row = settingRow({row: 'stemMode', label: C.stems.label, hint: C.stems.hint, scope: 'account', saver});
      stemSeg = keep(Segmented({
        attrs: {'aria-labelledby': row.labelId},
        options: DEFAULT_LAYOUTS.map(value => ({value, label: C.stems[value]})),
        value: defaultLayout(settings().profile, settings()),
        onChange: value => patch(saver, {stemMode: value, addDefaultsSaved: true}),
      }));
      stemWarning = h('p', {class: 'settings-warning', role: 'note', hidden: true},
        h('span', {class: 'settings-warning-icon', 'aria-hidden': 'true'}, icon('alert-triangle', {size: 20})), h('span', {class: 'settings-warning-text'}));
      row.el.querySelector('.settings-row-control').prepend(stemSeg.el);
      row.el.append(stemWarning);
      rows.push(row);
    }

    // ---- Quality + Advanced
    let qualitySeg, qualityHint, details, modelSelect, passes, overlap, sixNote;
    {
      const saver = saverFor(() => qualitySeg.el.querySelector('[aria-checked=true]'));
      const row = settingRow({row: 'quality', label: C.quality.label, hint: ' ', scope: 'account', saver});
      qualityHint = row.el.querySelector('.settings-row-hint');
      qualitySeg = keep(Segmented({
        attrs: {'aria-labelledby': row.labelId, 'aria-describedby': row.hintId},
        options: QUALITY_CHOICES.map(value => ({value, label: C.quality[value]})),
        value: qualityChoice(settings(), presets()),
        onChange: value => {
          if (value === 'custom') {
            details.open = true;
            patch(saver, {preset: 'custom', custom: effectiveQuality(settings(), presets())});
          } else {
            patch(saver, {preset: value});
          }
        },
      }));
      row.el.querySelector('.settings-row-control').prepend(qualitySeg.el);
      rows.push(row);

      // Advanced: one saver for the three fields.
      const advSaver = saverFor(() => details.querySelector('summary'));
      const writeCustom = change => patch(advSaver, {preset: 'custom', custom: {...effectiveQuality(settings(), presets()), ...change}});
      modelSelect = keep(Select({
        label: C.advanced.model,
        options: models().map(m => ({value: m.id, label: m.label})),
        value: effectiveQuality(settings(), presets()).model,
        onChange: model => writeCustom({model}),
      }));
      passes = keep(Stepper({
        label: C.advanced.passes, decLabel: C.advanced.fewerPasses, incLabel: C.advanced.morePasses,
        min: SHIFTS.min, max: SHIFTS.max, step: 1, bigStep: 2,
        value: effectiveQuality(settings(), presets()).shifts,
        format: v => String(v),
        onChange: shifts => writeCustom({shifts}),
      }));
      overlap = keep(Stepper({
        label: C.advanced.overlap, decLabel: C.advanced.lessOverlap, incLabel: C.advanced.moreOverlap,
        min: OVERLAP.min, max: OVERLAP.max, step: 0.05, bigStep: 0.15,
        value: effectiveQuality(settings(), presets()).overlap,
        format: v => round2(v).toFixed(2),
        onChange: v => writeCustom({overlap: round2(v)}),
      }));
      const labelled = (text, control) => h('div', {class: 'settings-advanced-field'},
        h('span', {class: 'settings-inline-label', 'aria-hidden': 'true'}, text), control.el);
      sixNote = h('p', {class: 'settings-tip', hidden: true}, C.advanced.sixNote);
      const hintId = uid('settings-advanced-hint');
      details = h('details', {class: 'settings-advanced', open: qualityChoice(settings(), presets()) === 'custom'},
        h('summary', {class: 'settings-advanced-summary', 'aria-describedby': hintId},
          h('span', {class: 'settings-advanced-chevron', 'aria-hidden': 'true'}, icon('chevron-right', {size: 20})),
          h('span', {}, C.advanced.summary)),
        h('div', {class: 'settings-advanced-body'},
          h('p', {class: 'settings-row-hint', id: hintId}, C.advanced.hint),
          h('div', {class: 'settings-advanced-fields'}, modelSelect.el, labelled(C.advanced.passes, passes), labelled(C.advanced.overlap, overlap)),
          sixNote,
          h('div', {class: 'settings-advanced-saver'}, advSaver.el)));
      rows.push({el: h('div', {class: 'settings-row', dataset: {scope: 'account', row: 'advanced'}}, details)});
    }

    // ---- Audio bitrate
    let bitrateSelect;
    {
      const saver = saverFor(() => bitrateSelect.input);
      bitrateSelect = keep(Select({
        label: C.bitrate.label, hint: C.bitrate.hint,
        options: bitrates().map(b => ({value: b.id, label: b.label})),
        value: settings().bitrate,
        onChange: bitrate => patch(saver, {bitrate}),
      }));
      rows.push({el: h('div', {class: 'settings-row', dataset: {scope: 'account', row: 'bitrate'}},
        h('div', {class: 'settings-row-control'}, bitrateSelect.el, saver.el))});
    }

    // ---- The three switches
    const toggles = {};
    for (const [key, copy] of [['notifyReady', C.notify], ['autoBeats', C.autoBeats], ['autoSections', C.autoSections]]) {
      let toggle;
      const id = uid('settings-row');
      const saver = saverFor(() => toggle.el);
      toggle = keep(Toggle({
        label: copy.label, pressed: !!settings()[key], className: 'settings-toggle',
        attrs: {'aria-describedby': `${id}-hint`},
        onChange: pressed => patch(saver, {[key]: pressed}),
      }));
      toggles[key] = toggle;
      rows.push(settingRow({row: key, hint: copy.hint, scope: 'account', controls: [toggle], saver, labelId: id}));
    }

    // ---- Import an old Woodshed library
    rows.push(importRow(companion));

    // ---- Export original audio
    {
      const result = InlineStatus({tone: 'info', text: ''});
      result.el.hidden = true;
      keep(result);
      const button = keep(Button({label: C.exportOriginals.button, icon: 'download', onClick: async () => {
        result.el.hidden = true;
        button.set({busy: C.exportOriginals.exporting, disabled: true});
        try {
          const mod = await companion();
          const answer = await mod.localRequest('/export-originals', {});
          if (!destroyed) result.set({tone: 'ok', text: originalsText(answer)});
        } catch (err) {
          if (!destroyed) result.set({tone: 'error', text: companionErrorText(err, C.exportOriginals.failed)});
        } finally {
          if (!destroyed) { result.el.hidden = false; button.set({busy: false, disabled: false}); }
        }
      }}));
      rows.push(settingRow({row: 'exportOriginals', label: C.exportOriginals.label, hint: C.exportOriginals.hint, scope: 'info',
        controls: [button, result.el]}));
    }

    let shownModels = models(), shownBitrates = bitrates();
    function sync() {
      const s = settings();
      const layout = defaultLayout(s.profile, s);
      stemSeg.set({value: layout});
      const mine = removesMyStem(s.profile, layout, s);
      stemWarning.hidden = !mine;
      stemWarning.querySelector('.settings-warning-text').textContent = mine ? removesMyStemLine(mine) : '';
      const choice = qualityChoice(s, presets());
      qualitySeg.set({value: choice});
      const description = choice === 'custom' ? C.quality.customHint : presets()[choice]?.description ?? '';
      const estimate = choice === 'custom' ? '' : estimateText(prefs?.get?.('jobStats'), choice);
      qualityHint.textContent = [description, estimate].filter(Boolean).join(' ');
      const q = effectiveQuality(s, presets());
      if (models() !== shownModels) {
        shownModels = models();
        modelSelect.set({options: shownModels.map(m => ({value: m.id, label: m.label}))});
      }
      modelSelect.set({value: q.model});
      passes.set({value: q.shifts});
      overlap.set({value: q.overlap});
      sixNote.hidden = !(layout === 'six' && q.model !== SIX_STEM_MODEL);
      if (bitrates() !== shownBitrates) {
        shownBitrates = bitrates();
        bitrateSelect.set({options: shownBitrates.map(b => ({value: b.id, label: b.label}))});
      }
      bitrateSelect.set({value: s.bitrate});
      for (const [key, toggle] of Object.entries(toggles)) toggle.set({pressed: !!s[key]});
    }
    sync();
    offs.push(account.value.subscribe(() => sync()));
    if (store?.config?.subscribe) offs.push(store.config.subscribe(() => sync()));
    if (prefs?.value?.subscribe) offs.push(prefs.value.subscribe(() => sync()));

    page.append(h('div', {class: 'settings-group'}, rows.map(r => r.el)));
  }

  /** Import an old Woodshed library: scan (/legacy), then import a found library or a typed folder. */
  function importRow(companion) {
    const L = C.importLegacy;
    const result = keep(InlineStatus({tone: 'info', text: ''}));
    result.el.hidden = true;
    const found = h('ul', {class: 'settings-legacy-found', role: 'list', hidden: true});
    const foundButtons = [];
    let folder = null, folderButton = null;
    const manual = h('div', {class: 'settings-legacy-manual', hidden: true});
    let busy = false;

    const say = (tone, text) => { result.set({tone, text}); result.el.hidden = !text; };
    const setBusy = on => {
      busy = on;
      find.set({disabled: on});
      for (const b of foundButtons) b.set({disabled: on});
      folderButton?.set({disabled: on});
    };

    async function runImport(directory, button) {
      if (busy || !directory) return;
      say('info', '');
      setBusy(true);
      button?.set({busy: L.importing});
      try {
        const mod = await companion();
        const answer = await mod.importLegacy(directory);
        if (!destroyed) say('ok', importResultText(answer));
      } catch (err) {
        if (!destroyed) say('error', companionErrorText(err, L.failed));
      } finally {
        if (!destroyed) { button?.set({busy: false}); setBusy(false); }
      }
    }

    function showManual() {
      if (folder) { manual.hidden = false; return; }
      folder = keep(TextField({label: L.folder, hint: L.folderHint, autocomplete: 'off', onCommit: () => {}}));
      folderButton = keep(Button({label: L.importFolder, onClick: () => runImport(folder.input.value.trim(), folderButton)}));
      folder.input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); runImport(folder.input.value.trim(), folderButton); }
      });
      folder.el.setAttribute('data-consume-keys', 'Enter');
      manual.append(folder.el, folderButton.el);
      manual.hidden = false;
    }

    const find = keep(Button({label: L.find, icon: 'folder-open', onClick: async () => {
      if (busy) return;
      say('info', '');
      setBusy(true);
      find.set({busy: L.finding});
      try {
        const mod = await companion();
        const libraries = (await mod.legacyLibraries()) ?? [];
        if (destroyed) return;
        for (const b of foundButtons.splice(0)) b.destroy();
        found.replaceChildren();
        const list = Array.isArray(libraries) ? libraries.filter(l => l?.directory) : [];
        for (const lib of list) {
          const count = Number(lib.count) || 0;
          const button = keep(Button({
            label: L.importFound(count), variant: 'primary', size: 'sm',
            attrs: list.length > 1 ? {'aria-label': L.importFoundIn(count, lib.directory)} : null,
            onClick: () => runImport(lib.directory, button),
          }));
          foundButtons.push(button);
          found.append(h('li', {class: 'settings-legacy-item'}, h('span', {class: 'settings-value'}, L.found(count, lib.directory)), button.el));
        }
        found.hidden = !list.length;
        if (!list.length) { say('info', L.none); showManual(); }
      } catch (err) {
        if (!destroyed) say('error', companionErrorText(err, L.failed));
      } finally {
        if (!destroyed) { find.set({busy: false}); setBusy(false); }
      }
    }}));
    return settingRow({row: 'importLegacy', label: L.label, hint: L.hint, scope: 'info', controls: [find, found, result.el, manual]});
  }

  // ------------------------------------------------------------------- web
  function renderWeb() {
    const D = C.devices;
    const devicesApi = ctx.devicesApi ?? appDevicesApi;
    const fb = ctx.feedback ?? appFeedback;
    const now = ctx.now ?? clockNow;
    const timers = ctx.timers ?? globalThis;
    const devices = () => (store?.library?.devices?.peek?.() ?? []).filter(Boolean);

    const dot = h('span', {class: 'settings-processor-dot', 'aria-hidden': 'true'});
    const label = h('span', {class: 'settings-processor-label'});
    const line = h('p', {class: 'settings-value settings-processor'}, dot, label);
    const processorRow = settingRow({row: 'processor', label: C.web.label, scope: 'info', controls: [line]});

    const problem = keep(InlineStatus({tone: 'error', text: ''}));
    problem.el.hidden = true;
    const list = h('ul', {class: 'settings-devices', role: 'list', 'aria-label': D.listLabel, tabindex: '-1'});
    const devicesRow = settingRow({row: 'devices', label: D.label, hint: D.hint, scope: 'info', controls: [list, problem.el]});

    function deviceItem(device) {
      const nameEl = h('span', {class: 'settings-device-name'});
      const stateDot = h('span', {class: 'settings-processor-dot', 'aria-hidden': 'true'});
      const stateEl = h('span', {class: 'settings-device-state'});
      const metaEl = h('span', {class: 'settings-device-meta'});
      const queuedEl = h('span', {class: 'settings-device-meta'});
      let current = device;
      const rename = Button({label: D.rename, icon: 'pencil', size: 'sm', variant: 'quiet', onClick: () => renameDevice(current)});
      const remove = Button({label: D.remove, icon: 'trash-2', size: 'sm', variant: 'quiet', tone: 'danger', onClick: () => removeDevice(current)});
      const el = h('li', {class: 'settings-device', dataset: {deviceId: device.deviceId}},
        h('div', {class: 'settings-device-text'}, nameEl,
          h('span', {class: 'settings-device-line'}, stateDot, stateEl), metaEl, queuedEl),
        h('div', {class: 'settings-device-actions'}, rename.el, remove.el));
      function update(d) {
        current = d;
        const name = nameOf(d);
        nameEl.textContent = name;
        const status = deviceStatus(d, now());
        stateEl.textContent = status.text;
        el.dataset.state = status.state;
        const meta = [platformName(d.platform), d.appVersion ? D.version(d.appVersion) : ''].filter(Boolean).join(' · ');
        metaEl.textContent = meta;
        metaEl.hidden = !meta;
        const queued = Number(d.queued) || 0;
        queuedEl.textContent = queued ? D.queued(queued) : '';
        queuedEl.hidden = !queued;
        rename.el.setAttribute('aria-label', D.renameName(name));
        remove.el.setAttribute('aria-label', D.removeName(name));
      }
      update(device);
      return {el, update, destroy() { rename.destroy(); remove.destroy(); el.remove(); }};
    }

    async function renameDevice(device) {
      const name = nameOf(device);
      problem.el.hidden = true;
      await fb.form({
        title: D.renameName(name), submitLabel: D.save,
        fields: [{name: 'name', label: D.nameField, required: true, maxLength: DEVICE_NAME_MAX, value: name, autocomplete: 'off'}],
        onSubmit: async values => {
          try {
            await devicesApi.rename({deviceId: device.deviceId, name: values.name});
          } catch (err) {
            throw Object.assign(new Error(err?.code === 'invalid' ? (err.message || D.failed) : D.failed), err?.code === 'invalid' ? {field: 'name'} : {});
          }
        },
      });
    }

    async function removeDevice(device) {
      const name = nameOf(device);
      problem.el.hidden = true;
      const ok = await fb.confirm({title: D.removeTitle(name), body: D.removeBody, confirmLabel: D.removeConfirm, danger: true});
      if (!ok || destroyed) return;
      try {
        await devicesApi.revoke({deviceId: device.deviceId});
        if (destroyed) return;
        fb.toast?.(D.removed(name), {tone: 'ok', key: 'device-removed'});
        list.focus({preventScroll: true});
      } catch (err) {
        console.warn('[settings] the computer was not removed:', err?.message ?? err);
        if (!destroyed) { problem.set({text: D.failed}); problem.el.hidden = false; }
      }
    }

    function show() {
      const all = devices();
      const status = webProcessorText(all, now());
      label.textContent = status.text;
      line.dataset.state = status.state === 'online' || status.state === 'busy' ? 'ok' : status.state === 'offline' ? 'off' : 'none';
      dot.hidden = status.state === 'none';
      reconcileList(list, all, {key: d => d.deviceId, create: deviceItem});
      devicesRow.el.hidden = !all.length;
    }
    show();
    const devicesSignal = store?.library?.devices;
    if (devicesSignal?.subscribe) offs.push(devicesSignal.subscribe(() => show()));
    const tick = timers.setInterval(() => { if (!destroyed) show(); }, appDevicesApi.RECHECK_MS);
    offs.push(() => timers.clearInterval(tick));
    offs.push(() => reconcileList(list, [], {key: d => d.deviceId, create: deviceItem}));

    page.append(
      h('div', {class: 'settings-group'}, processorRow.el, devicesRow.el),
      desktopNote(C.desktopItems));
  }

  return {
    destroy() {
      destroyed = true;
      for (const off of offs.splice(0)) { try { off(); } catch (err) { console.error('[settings] processing cleanup failed', err); } }
      for (const part of parts.splice(0)) part.destroy();
      page.remove();
    },
  };
}

export default Object.freeze({id: 'processing', title: SECTION_TITLES.processing, render});
