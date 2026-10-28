// The Add sheet (route `add`, `/add`, modal over the Library; spec §3.1–3.3 and §3.6, architecture §2.16, §9.12
// LB2b). Every way in (＋ Add song, N, the palette, ⌘V with a link, a window drop, "Add 'x'", ⌘N, the error actions
// "Search for another version" and "Upload a file instead") opens this one sheet.
//
//   mount(el, match, ctx) → {update(match), unmount()}        the view (ctx: {router, store, …})
//   createAddSheet(options) → {el, update(match), close(reason), destroy(), state()}   the sheet, deps injectable
//
// Container: a centred 640 px modal dialog on fine pointers; a bottom sheet at 90% of the viewport with a grabber
// (swipe down dismisses, through sheet.js shouldDismiss) on iPad and coarse pointers. Both are a native <dialog>
// (showModal, Tab kept inside, Esc closes through the dispatcher's overlay stack: a modal overlay, D36). The whole
// sheet is a drop zone. Closing (✕, Cancel, Esc, the backdrop, a swipe) goes Back to the Library.
//
// Body, top to bottom: the title; the omnibox (56 px, autofocused; Choose files…, and Paste on coarse pointers) with
// its hint line; inline errors (spec §3.6: one sentence, the primary action, Details with Copy; the input is kept);
// the resolution area; the duplicate notice; the defaults line with Change; the removes-my-stem warning; the footer
// with the device line, "⇧↵ add another", Cancel and Add & split ("Add 3 files").
//
// Resolution (400 ms after typing stops; at once for ?q=, Paste and a drop):
//   desktop  a link → /resolve (one candidate row); free text → /search (3–5 radio rows, the first chosen, ↑/↓ move);
//            a Spotify link → "Spotify doesn't allow downloads…" then /resolve's search candidates. A chosen
//            candidate submits as a `url` source with confirmed: true and its meta (B4, D43). A lookup that fails
//            (anything but `aborted`/`lookup_busy`, which are ignored) falls back to the honest single-result line;
//            a playlist link is an inline error.
//   web/iPad always the single-result line (lookups need the local processor): a pasted link is confirmed: true, a
//            search or a Spotify link confirmed: false (D43). Jobs go to the chosen paired computer (B5): the device
//            line "Your MacBook Pro will split this · ● Online ▾" picks it (prefs.deviceId); an offline one queues
//            ("… is offline. Songs you add start when it's back."). Files are disabled on the web.
//            Without a paired computer the body is the explainer: the platform download (fetchRelease, new tab),
//            Other platforms, Copy download link, Share download link (navigator.share), Open the example song.
//   files    (desktop) one row each with name, size and duration (<audio> metadata) and ✕; non-audio files and files
//            over 1 GB are flagged inline and excluded; one file gets an editable title (sent only when changed).
//            Uploads go through upload.js startUploads (LB2a).
//
// After submit: the sheet closes, the toast "Adding **Title** · [Undo]" (10 s; Undo → jobs.cancel or the upload's
// cancel) and a polite announcement; the Library shows the new card first under "Adding" (home.js, LB1a) and this
// module moves focus to it and rings it for 1.5 s. ⇧↵ submits and keeps the sheet open, cleared, for the next song.
// "Use these for future songs" saves the Change choice with account.patch({stemMode, preset, addDefaultsSaved: true}).
// A sheet opened by "Search for another version" (history state {dismissJobId}) dismisses that failed job once the
// new one is submitted. ?pick=1 focuses Choose files… and opens the picker at once when the page has a user
// activation. An export-only account sees "Adding songs is paused on this account." [Plan & storage].

import '../styles/views/library/add.css';
import {h} from '../ui/h.js';
import {icon} from '../ui/icon.js';
import {Button} from '../ui/button.js';
import {Segmented} from '../ui/segmented.js';
import {Kbd} from '../ui/kbd.js';
import {Menu} from '../ui/menu.js';
import {shouldDismiss} from '../ui/sheet.js';
import {closeLayersInside, focusables, pushModalHost, restoreFocus, trackLayer, trapTab} from '../ui/popover.js';
import {pushOverlay} from '../app/dispatch.js';
import {effect, store as appStore, untracked} from '../app/store.js';
import {account as appAccount} from '../app/account.js';
import {prefs as appPrefs} from '../app/prefs.js';
import {platform as appPlatform} from '../app/platform.js';
import {desktop as appDesktop} from '../app/desktop.js';
import {now as clockNow} from '../app/clock.js';
import {announce as appAnnounce, toast as appToast} from '../app/feedback.js';
import {describeError} from '../app/error-copy.js';
import * as jobsApi from '../api/jobs.js';
import * as settingsApi from '../api/settings.js';
import {isOnline, RECHECK_MS} from '../api/devices.js';
import {resolveSource, searchSources} from '../js/companion.js';
import {detectPlatform, fetchRelease as appFetchRelease} from '../js/download-release.js';
import {PLATFORMS} from '../download/download.copy.js';
import {
  COPY as MODEL_COPY, audioFiles, badges, classify, defaultsParts, findDuplicate, jobSettings, removesMyStem, removesMyStemLine,
} from './add-model.js';
import {COPY as UPLOAD_COPY, MAX_UPLOAD_BYTES, startUploads, uploadDevice} from './upload.js';
import {takeStagedFiles} from './dropzone.js';
import {COPY, PROVIDERS, QUALITY_OPTIONS, STEM_OPTIONS} from './add-sheet.copy.js';

export {COPY, CONTROLS} from './add-sheet.copy.js';

/** Typing settles this long before a lookup starts (spec §3.2 item 3). */
export const DEBOUNCE_MS = 400;
/** The Undo in the "Adding" toast lasts this long (spec §3.2). */
export const UNDO_MS = 10_000;
/** The new card's accent ring (spec §3.2). */
export const RING_MS = 1500;
/** How long the sheet waits for the new card to appear in the Library before giving up on focusing it. */
export const CARD_WAIT_MS = 10_000;
/** A `lookup_busy` answer is asked again after this long. */
export const BUSY_RETRY_MS = 1000;
/** Candidate rows asked for (spec: 3–5). */
export const SEARCH_RESULTS = 5;
/** Durations are read from <audio> metadata within this long, else shown as unknown. */
export const DURATION_TIMEOUT_MS = 8000;
const META_MAX = 300;
const LABEL_MAX = 500;
const THUMB_MAX = 2000;
const DOWNLOAD_PATH = '/download';

let sheetSeq = 0;

// ---------------------------------------------------------------- pure helpers (exported for tests)

/** m:ss for a duration in seconds, or null. */
export function formatDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return null;
  const total = Math.round(s);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
  const ss = String(sec).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The file name without its extension (the title field's starting value). */
export function fileStem(name) {
  const text = String(name ?? '').trim();
  const stem = text.replace(/\.[a-z0-9]{1,8}$/i, '').trim();
  return stem || text;
}

/**
 * Minutes a split takes on this computer from prefs.jobStats ({[preset]: {secPerMin, n}}, written by notify-ready.js),
 * for `seconds` of audio; null without history or without a duration (an estimate is never invented).
 */
export function estimateMinutes(jobStats, preset, seconds) {
  const stat = jobStats?.[preset];
  const rate = Number(stat?.secPerMin);
  const dur = Number(seconds);
  if (!Number.isFinite(rate) || rate <= 0 || !(Number(stat?.n) > 0) || !Number.isFinite(dur) || dur <= 0) return null;
  return Math.max(1, Math.round((rate * dur) / 60 / 60));
}

const clip = (text, max) => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** The job meta for a chosen B4 candidate (jobs.createSeparation: strings ≤ 300, an https thumbnail ≤ 2000). */
export function candidateMeta(candidate) {
  if (!candidate) return undefined;
  const meta = {};
  const title = clip(candidate.title, META_MAX);
  if (title) meta.title = title;
  const channel = clip(candidate.channel, META_MAX);
  if (channel) meta.channel = channel;
  if (Number.isFinite(candidate.duration) && candidate.duration > 0) meta.duration = candidate.duration;
  if (typeof candidate.thumbnail === 'string' && /^https:\/\//.test(candidate.thumbnail) && candidate.thumbnail.length <= THUMB_MAX) meta.thumbnail = candidate.thumbnail;
  if (typeof candidate.provider === 'string' && candidate.provider) meta.provider = candidate.provider;
  return Object.keys(meta).length ? meta : undefined;
}

/**
 * What a text submission sends (D43): {source, label, meta?, confirmed}.
 *   input      classify() of the omnibox
 *   candidate  the chosen B4 candidate (desktop) or null
 */
export function textSubmission(input, candidate) {
  if (!input || input.kind === 'empty') return null;
  if (candidate) {
    return {source: {type: 'url', value: candidate.url}, label: clip(candidate.title, LABEL_MAX) || clip(input.value, LABEL_MAX),
      meta: candidateMeta(candidate), confirmed: true};
  }
  if (input.kind === 'url') return {source: {type: 'url', value: input.value}, label: clip(input.value, LABEL_MAX), confirmed: true};
  if (input.kind === 'spotify') return {source: {type: 'spotify', value: input.value}, label: clip(input.value, LABEL_MAX), confirmed: false};
  return {source: {type: 'search', value: input.value}, label: clip(input.value, LABEL_MAX), confirmed: false};
}

/** The paired computer B5 sends jobs to: the remembered one if still paired, else the first online, else the first. */
export function chooseDevice(devices, rememberedId, at) {
  const list = Array.isArray(devices) ? devices.filter(d => d && d.deviceId) : [];
  if (!list.length) return null;
  return list.find(d => d.deviceId === rememberedId) ?? list.find(d => isOnline(d, at)) ?? list[0];
}

/** The duration of an audio file from its <audio> metadata, or null (no media support, unreadable, timed out). */
export function probeDuration(file, {doc = globalThis.document, url = globalThis.URL, timeoutMs = DURATION_TIMEOUT_MS} = {}) {
  if (!file || !doc || typeof url?.createObjectURL !== 'function') return Promise.resolve(null);
  return new Promise(resolve => {
    let src = null;
    let audio = null;
    let timer = null;
    const done = value => {
      clearTimeout(timer);
      if (audio) { audio.removeAttribute('src'); audio.onloadedmetadata = audio.onerror = null; }
      if (src) { try { url.revokeObjectURL(src); } catch { /* already revoked */ } }
      resolve(Number.isFinite(value) && value > 0 ? value : null);
    };
    try {
      src = url.createObjectURL(file);
      audio = doc.createElement('audio');
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => done(audio.duration);
      audio.onerror = () => done(null);
      timer = setTimeout(() => done(null), timeoutMs);
      audio.src = src;
    } catch {
      done(null);
    }
  });
}

/** Parts [{text} | {strong}] → nodes. */
function parts(list) {
  return list.map(p => (typeof p === 'string' ? p : h('strong', {}, p.strong)));
}

// ---------------------------------------------------------------- the sheet

/**
 * Builds and opens the sheet. Options (all injectable; the app passes ctx through mount):
 *   host, router, store, account, prefs, platform, desktop, jobs ({createSeparation, cancel, dismiss}),
 *   lookups ({resolveSource, searchSources}), uploads ({startUploads, uploadDevice}), takeStagedFiles,
 *   feedback ({toast, announce}), settings ({demo}), fetchRelease, detectPlatform, now, navigator, origin,
 *   durationOf(file) → Promise<number|null>, onClose(reason) (when there is no router).
 */
export function createAddSheet(options = {}) {
  const o = {
    store: appStore, account: appAccount, prefs: appPrefs, platform: appPlatform, desktop: appDesktop,
    jobs: jobsApi, lookups: {resolveSource, searchSources}, uploads: {startUploads, uploadDevice}, takeStagedFiles,
    feedback: {toast: appToast, announce: appAnnounce}, settings: settingsApi, fetchRelease: appFetchRelease, detectPlatform,
    now: clockNow, navigator: globalThis.navigator, origin: globalThis.location?.origin ?? '', durationOf: probeDuration,
    router: null, host: null, onClose: null, ...options,
  };
  const doc = o.host?.ownerDocument ?? globalThis.document;
  const win = doc.defaultView ?? globalThis.window;
  const seq = ++sheetSeq;
  const ids = {title: `lib-add-${seq}-title`, hint: `lib-add-${seq}-hint`, files: `lib-add-${seq}-files-note`,
    panel: `lib-add-${seq}-panel`, cands: `lib-add-${seq}-cands`};
  const desktopApp = !!o.desktop?.available;
  const coarse = !!o.platform?.coarse?.peek?.() || !!o.platform?.isIPad || (!!o.platform?.isIOS && !desktopApp);
  const presentation = coarse ? 'sheet' : 'dialog';
  const previous = doc.activeElement;
  const cleanups = [];
  const primitives = [];
  const timers = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
  const cancelLater = id => { clearTimeout(id); timers.delete(id); };
  const prim = p => { primitives.push(p); return p; };

  // ---------- state
  const st = {
    text: '',
    input: classify(''),
    lookup: {status: 'idle', key: null, kind: null, candidates: [], query: null},   // idle|loading|ready|fallback|error
    selected: 0,
    files: [],            // {id, file, name, size, audio, tooLarge, duration, probing}
    title: '',            // the single file's title field
    titleEdited: false,
    duplicateDismissed: null,   // the duplicate song id the user chose to add again
    error: null,          // describeError() result shown inline
    errorOpen: false,
    changeOpen: false,
    choice: {stemMode: null, preset: null},
    saveDefaults: false,
    busy: false,
    notice: null,         // a one-line status after ⇧↵
    deviceId: null,       // B5 choice (web)
    dismissJobId: null,
    open: true,
  };
  let lookupController = null;
  let debounceTimer = null;
  let fileSeq = 0;

  const accountValue = () => o.account?.value?.peek?.() ?? {};
  const profile = () => o.account?.profile?.peek?.() ?? accountValue().profile ?? null;
  const songs = () => o.store?.library?.songs?.peek?.() ?? new Map();
  const devices = () => o.store?.library?.devices?.peek?.() ?? [];
  const exportOnly = () => o.store?.session?.peek?.()?.status === 'export_only';
  const processor = () => o.store?.processor?.peek?.() ?? {phase: desktopApp ? 'starting' : 'web'};
  const at = () => o.now();
  const hasDevices = () => devices().length > 0;
  /** 'desktop' | 'web' (B5, a paired computer) | 'explainer' (web, none). */
  const mode = () => (desktopApp ? 'desktop' : hasDevices() ? 'web' : 'explainer');
  const chosenDevice = () => chooseDevice(devices(), st.deviceId ?? o.prefs?.get?.('deviceId'), at());
  const audio = () => st.files.filter(f => f.audio && !f.tooLarge);
  const resolvedChoice = () => ({...(st.choice.stemMode ? {stemMode: st.choice.stemMode} : {}), ...(st.choice.preset ? {preset: st.choice.preset} : {})});
  const settingsNow = () => jobSettings(profile(), accountValue(), resolvedChoice());

  // ---------- skeleton
  const title = h('h2', {class: 'lib-add-title', id: ids.title}, COPY.title);
  const closeButton = h('button', {type: 'button', class: 'lib-add-close', 'aria-label': COPY.close}, icon('x'));
  const grabber = h('span', {class: 'lib-add-grabber', 'aria-hidden': 'true'});
  const head = h('header', {class: 'lib-add-head'}, grabber, title, closeButton);

  const input = h('input', {
    type: 'text', class: 'lib-add-input selectable', autocomplete: 'off', spellcheck: false, enterKeyHint: 'go',
    'aria-label': COPY.omniboxLabel, 'aria-describedby': ids.hint, maxLength: 2000,
  });
  const fileInput = h('input', {type: 'file', multiple: true, class: 'lib-add-file-input', tabIndex: -1, 'aria-hidden': 'true',
    accept: 'audio/*,.mp3,.wav,.flac,.m4a,.aac,.ogg,.oga,.opus,.aif,.aiff,.aifc,.wma'});
  const chooseButton = prim(Button({label: COPY.chooseFiles, variant: 'quiet', className: 'lib-add-choose', onClick: () => openPicker()}));
  const pasteButton = coarse ? prim(Button({label: COPY.paste, variant: 'quiet', className: 'lib-add-paste', onClick: () => paste()})) : null;
  const omnibox = h('div', {class: 'lib-add-omnibox'}, icon('search'), input, pasteButton?.el, chooseButton.el, fileInput);
  const hint = h('p', {class: 'lib-add-hint', id: ids.hint}, COPY.hint);
  const filesNote = h('p', {class: 'lib-add-files-note', id: ids.files, hidden: true}, COPY.filesWeb);
  const errorSlot = h('div', {class: 'lib-add-error-slot'});
  const resolution = h('div', {class: 'lib-add-resolution'});
  const duplicateSlot = h('div', {class: 'lib-add-duplicate-slot'});
  const defaultsText = h('span', {class: 'lib-add-defaults-text'});
  const changeButton = h('button', {type: 'button', class: 'lib-add-change', 'aria-expanded': 'false', 'aria-controls': ids.panel,
    'aria-label': COPY.changeLabel}, COPY.change);
  const defaultsLine = h('p', {class: 'lib-add-defaults'}, defaultsText, ' ', changeButton);
  const panel = h('div', {class: 'lib-add-panel', id: ids.panel, hidden: true});
  const warning = h('p', {class: 'lib-add-warning', role: 'status', hidden: true});
  const noticeLine = h('p', {class: 'lib-add-notice', role: 'status', hidden: true});
  const form = h('div', {class: 'lib-add-form'}, omnibox, hint, filesNote, errorSlot, resolution, duplicateSlot, defaultsLine, panel, warning, noticeLine);
  const explainer = h('div', {class: 'lib-add-explainer', hidden: true});
  const pausedSlot = h('div', {class: 'lib-add-paused', hidden: true});
  const body = h('div', {class: 'lib-add-body'}, pausedSlot, explainer, form);

  const deviceLine = h('div', {class: 'lib-add-device'});
  const submitButton = prim(Button({label: COPY.submit, variant: 'primary', size: coarse ? 'lg' : 'md', className: 'lib-add-submit',
    onClick: () => submit({keepOpen: false})}));
  const cancelButton = prim(Button({label: COPY.cancel, variant: 'quiet', size: coarse ? 'lg' : 'md', className: 'lib-add-cancel',
    onClick: () => close('cancel')}));
  const anotherKbd = prim(Kbd({keys: 'Shift+Enter'}));
  const anotherHint = h('span', {class: 'lib-add-another', 'aria-hidden': 'true'}, anotherKbd.el, ' ', COPY.addAnother);
  const actions = h('div', {class: 'lib-add-actions'}, anotherHint, cancelButton.el, submitButton.el);
  const footer = h('footer', {class: 'lib-add-footer'}, deviceLine, actions);
  const dropTarget = h('div', {class: 'lib-add-drop', hidden: true, 'aria-hidden': 'true'}, icon('upload', {size: 32}), h('p', {}, COPY.dropTarget));

  const el = h('dialog', {class: 'lib-add', 'aria-labelledby': ids.title, dataset: {presentation, mode: mode(), testid: 'add-sheet'}},
    head, body, footer, dropTarget);
  submitButton.el.setAttribute('aria-keyshortcuts', 'Enter Shift+Enter');

  // ---------- open
  (o.host ?? doc.body).append(el);
  try { el.showModal(); } catch { el.setAttribute('open', ''); }
  cleanups.push(pushModalHost(el), trackLayer(el), trapTab(el));
  cleanups.push(pushOverlay({el, modal: true, onEscape: () => close('escape')}));
  const listen = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); cleanups.push(() => target.removeEventListener(type, fn, opts)); };
  listen(el, 'cancel', e => { e.preventDefault(); close('escape'); });
  listen(el, 'keydown', e => {
    if (e.key === 'Escape' && !e.defaultPrevented && !e.isComposing) { e.preventDefault(); close('escape'); }
  });
  listen(closeButton, 'click', () => close('close'));
  listen(el, 'pointerdown', e => {
    if (e.target !== el || presentation === 'sheet' && dragging) return;
    const r = el.getBoundingClientRect();
    if (r.width && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) close('outside');
  });

  // ---------- the swipe (bottom sheet)
  let dragging = null;
  if (presentation === 'sheet') {
    listen(head, 'pointerdown', e => {
      if (dragging || (e.button ?? 0) !== 0 || closeButton.contains(e.target)) return;
      dragging = {id: e.pointerId, y0: e.clientY, h: el.getBoundingClientRect().height || (win?.innerHeight ?? 0) * 0.9, samples: [{y: e.clientY, t: at()}]};
      try { head.setPointerCapture?.(e.pointerId); } catch { /* synthetic */ }
      el.dataset.dragging = '';
    });
    listen(head, 'pointermove', e => {
      if (!dragging || e.pointerId !== dragging.id) return;
      const dy = Math.max(0, e.clientY - dragging.y0);
      dragging.samples.push({y: e.clientY, t: at()});
      if (dragging.samples.length > 6) dragging.samples.shift();
      el.style.setProperty('translate', `0 ${Math.round(dy)}px`);
      e.preventDefault();
    });
    const end = e => {
      if (!dragging || e.pointerId !== dragging.id) return;
      const dy = e.clientY - dragging.y0;
      const first = dragging.samples[0], t = at();
      const v = t > first.t ? (e.clientY - first.y) / (t - first.t) : 0;
      const height = dragging.h;
      dragging = null;
      delete el.dataset.dragging;
      el.style.removeProperty('translate');
      if (e.type === 'pointerup' && shouldDismiss({dy, h: height, v})) close('swipe');
    };
    listen(head, 'pointerup', end);
    listen(head, 'pointercancel', end);
  }

  // ---------- the drop zone (the whole sheet)
  let dragDepth = 0;
  const carriesFiles = e => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  listen(el, 'dragenter', e => {
    if (!carriesFiles(e) || mode() === 'explainer') return;
    e.preventDefault();
    dragDepth += 1;
    dropTarget.hidden = false;
  });
  listen(el, 'dragover', e => {
    if (!carriesFiles(e) || mode() === 'explainer') return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    dropTarget.hidden = false;
  });
  listen(el, 'dragleave', e => {
    if (!carriesFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropTarget.hidden = true;
  });
  listen(el, 'drop', e => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropTarget.hidden = true;
    if (mode() === 'explainer') return;
    addFiles(Array.from(e.dataTransfer?.files ?? []));
  });

  // ---------- omnibox
  listen(input, 'input', () => {
    st.text = input.value;
    st.input = classify(st.text);
    st.error = null;
    st.notice = null;
    st.duplicateDismissed = null;
    scheduleLookup(DEBOUNCE_MS);
    render();
  });
  listen(input, 'keydown', e => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const n = shownCandidates().length;
      if (n > 1) {
        e.preventDefault();
        select((st.selected + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
      }
    }
  });
  listen(el, 'keydown', e => {
    if (e.key !== 'Enter' || e.isComposing || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    // Enter on a button, link or checkbox activates it natively; ⇧↵ always submits and keeps the sheet open.
    const native = t?.closest?.('button, a[href], input[type=checkbox], [role=menuitem], [role=menuitemradio]') && t !== input;
    if (native && !e.shiftKey) return;
    if (t?.closest?.('.lib-add-explainer')) return;
    e.preventDefault();
    submit({keepOpen: e.shiftKey});
  });
  listen(fileInput, 'change', () => {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = '';
    addFiles(files);
  });

  function openPicker() {
    if (mode() !== 'desktop') return;
    try { fileInput.click(); } catch { /* blocked */ }
  }

  async function paste() {
    try {
      const text = await o.navigator?.clipboard?.readText?.();
      if (typeof text !== 'string') throw new Error('no clipboard');
      setText(text.trim(), {lookupNow: true});
      input.focus({preventScroll: true});
    } catch {
      st.notice = COPY.pasteFailed;
      render();
    }
  }

  function setText(value, {lookupNow = false} = {}) {
    st.text = value;
    input.value = value;
    st.input = classify(value);
    st.error = null;
    st.duplicateDismissed = null;
    scheduleLookup(lookupNow ? 0 : DEBOUNCE_MS);
    render();
  }

  // ---------- lookups (desktop only, B4)
  function lookupKey(input) { return input.kind === 'empty' ? null : `${input.kind}:${input.value}`; }

  function scheduleLookup(ms) {
    cancelLater(debounceTimer);
    debounceTimer = null;
    const key = lookupKey(st.input);
    if (!desktopApp || !key) {
      lookupController?.abort();
      lookupController = null;
      st.lookup = {status: 'idle', key: null, kind: null, candidates: [], query: null};
      return;
    }
    if (st.lookup.key === key && st.lookup.status !== 'idle') return;
    if (ms <= 0) { runLookup(); return; }
    debounceTimer = later(runLookup, ms);
  }

  async function runLookup() {
    debounceTimer = null;
    const input = st.input;
    const key = lookupKey(input);
    if (!key) return;
    lookupController?.abort();
    const controller = new AbortController();
    lookupController = controller;
    st.lookup = {status: 'loading', key, kind: input.kind, candidates: [], query: null};
    st.selected = 0;
    render();
    try {
      const result = input.kind === 'search'
        ? await o.lookups.searchSources(input.value, {n: SEARCH_RESULTS, signal: controller.signal})
        : await o.lookups.resolveSource(input.value, {signal: controller.signal});
      if (controller !== lookupController || !st.open) return;
      const candidates = Array.isArray(result?.candidates) ? result.candidates.slice(0, input.kind === 'url' ? 1 : SEARCH_RESULTS) : [];
      st.lookup = {status: 'ready', key, kind: input.kind, candidates, query: result?.query ?? null};
    } catch (error) {
      if (controller !== lookupController || !st.open) return;
      const code = error?.code;
      if (controller.signal.aborted) return;
      if (code === 'lookup_busy') {
        st.lookup = {status: 'idle', key: null, kind: null, candidates: [], query: null};
        debounceTimer = later(runLookup, BUSY_RETRY_MS);
        return;
      }
      if (code === 'playlist') {
        st.lookup = {status: 'error', key, kind: input.kind, candidates: [], query: null};
        st.error = describeError(error, {context: 'add', router: o.router ?? undefined, desktop: o.desktop});
      } else {
        // B4 failed (or the processor is still starting): the honest single-result line.
        st.lookup = {status: 'fallback', key, kind: input.kind, candidates: [], query: null};
      }
    } finally {
      if (controller === lookupController) lookupController = null;
    }
    render();
  }

  /** The candidate rows shown for the current input (desktop, B4). */
  function shownCandidates() {
    return st.lookup.status === 'ready' && st.lookup.key === lookupKey(st.input) ? st.lookup.candidates : [];
  }
  const chosenCandidate = () => shownCandidates()[st.selected] ?? null;

  // ---------- files
  function addFiles(list) {
    const fresh = (list ?? []).filter(Boolean);
    if (!fresh.length) return;
    const {audio: ok} = audioFiles(fresh);
    for (const file of fresh) {
      const entry = {id: `f${++fileSeq}`, file, name: String(file.name || 'upload'), size: Math.max(0, Number(file.size) || 0),
        audio: ok.includes(file), tooLarge: false, duration: null, probing: false};
      entry.tooLarge = entry.audio && entry.size > MAX_UPLOAD_BYTES;
      if (entry.audio && !entry.tooLarge && desktopApp) {
        entry.probing = true;
        Promise.resolve(o.durationOf(file)).catch(() => null).then(d => {
          entry.probing = false;
          entry.duration = Number.isFinite(d) && d > 0 ? d : null;
          if (st.open) render();
        });
      }
      st.files.push(entry);
    }
    syncTitle();
    st.error = null;
    st.notice = null;
    render();
  }

  function removeFile(id) {
    const at = st.files.findIndex(f => f.id === id);
    if (at < 0) return;
    st.files.splice(at, 1);
    syncTitle();
    render();
    // Focus stays in the list: the next row's ✕, else the omnibox.
    const next = resolution.querySelector('.lib-add-file-remove');
    (next ?? input).focus({preventScroll: true});
  }

  function syncTitle() {
    const single = audio().length === 1 ? audio()[0] : null;
    if (!single) { st.title = ''; st.titleEdited = false; return; }
    if (!st.titleEdited) st.title = fileStem(single.name);
  }

  // ---------- candidate selection
  function select(index, {focus = false} = {}) {
    const n = shownCandidates().length;
    if (!n) return;
    st.selected = Math.max(0, Math.min(n - 1, index));
    st.duplicateDismissed = null;
    const rows = resolution.querySelectorAll('[role=radio]');
    rows.forEach((row, i) => {
      row.setAttribute('aria-checked', String(i === st.selected));
      row.tabIndex = i === st.selected ? 0 : -1;
    });
    if (focus) rows[st.selected]?.focus({preventScroll: false});
    rows[st.selected]?.scrollIntoView?.({block: 'nearest'});
    renderDuplicate();
    renderDefaults();
  }

  // ---------- rendering
  function render() {
    if (!st.open) return;
    const m = mode();
    el.dataset.mode = m;
    const paused = exportOnly() && m !== 'explainer';
    explainer.hidden = m !== 'explainer';
    form.hidden = m === 'explainer';
    footer.hidden = m === 'explainer';
    if (m === 'explainer') { renderExplainer(); renderPaused(false); return; }
    renderPaused(paused);
    input.placeholder = firstRun ? COPY.placeholderFirst : COPY.placeholder;
    const filesOk = m === 'desktop';
    chooseButton.set({disabled: !filesOk});
    if (filesOk) chooseButton.el.removeAttribute('aria-describedby'); else chooseButton.el.setAttribute('aria-describedby', ids.files);
    filesNote.hidden = filesOk;
    renderError();
    renderResolution();
    renderDuplicate();
    renderDefaults();
    renderDevice();
    noticeLine.textContent = st.notice ?? '';
    noticeLine.hidden = !st.notice;
    renderSubmit();
  }

  function renderPaused(on) {
    pausedSlot.hidden = !on;
    if (!on) { pausedSlot.replaceChildren(); return; }
    if (pausedSlot.childNodes.length) return;
    pausedSlot.append(errorBlock(describeError({code: 'account_export_only', message: ''}, {context: 'add', router: o.router ?? undefined})));
  }

  function renderSubmit() {
    const files = audio();
    const label = files.length > 1 ? COPY.submitFiles(files.length) : COPY.submit;
    const ready = canSubmit();
    submitButton.set({label, disabled: !ready || st.busy, busy: st.busy ? COPY.busy : false});
    anotherHint.hidden = coarse;
  }

  function canSubmit() {
    if (exportOnly() || mode() === 'explainer') return false;
    if (st.error && st.lookup.status === 'error') return false;
    if (mode() === 'desktop' && audio().length) return true;
    if (st.input.kind === 'empty') return false;
    if (st.lookup.status === 'ready' && st.lookup.key === lookupKey(st.input) && !st.lookup.candidates.length) return false;
    return true;
  }

  let shownError;
  function renderError() {
    if (shownError === st.error) return;
    shownError = st.error;
    errorSlot.replaceChildren();
    if (st.error) errorSlot.append(errorBlock(st.error));
  }

  /** One error (spec §3.6): the sentence, the primary (and secondary) action, Details with Copy. */
  function errorBlock(described) {
    const detailsId = `lib-add-${seq}-details-${++fileSeq}`;
    const sentence = h('p', {class: 'lib-add-error-text'}, icon('alert-triangle'), h('span', {class: 'selectable'}, described.sentence));
    const row = h('div', {class: 'lib-add-error-actions'});
    for (const action of [described.primary, described.secondary].filter(Boolean)) {
      row.append(h('button', {type: 'button', class: 'lib-add-error-action', on: {click: () => runErrorAction(action)}}, action.label));
    }
    const pre = h('pre', {class: 'lib-add-error-details selectable', id: detailsId, hidden: true}, described.details);
    const copyBtn = h('button', {type: 'button', class: 'lib-add-error-copy', hidden: true}, COPY.copyDetails);
    copyBtn.addEventListener('click', async () => {
      try { await o.navigator?.clipboard?.writeText?.(described.details); copyBtn.textContent = COPY.copied; } catch { /* left selectable */ }
    });
    const toggle = h('button', {type: 'button', class: 'lib-add-error-toggle', 'aria-expanded': 'false', 'aria-controls': detailsId}, COPY.details);
    const open = on => {
      toggle.setAttribute('aria-expanded', String(on));
      pre.hidden = !on;
      copyBtn.hidden = !on;
    };
    toggle.addEventListener('click', () => { st.errorOpen = pre.hidden; open(pre.hidden); });
    if (described.detailsFirst) row.prepend(toggle); else row.append(toggle);
    row.append(copyBtn);
    open(st.errorOpen && described === st.error);
    return h('div', {class: 'lib-add-error', role: 'alert'}, sentence, row, pre);
  }

  async function runErrorAction(action) {
    if (action.target === 'add.pick') { openPicker(); return; }
    if (action.target === 'add.search') { input.focus(); return; }
    try { await action.run(); } catch (error) { console.error('[add] error action failed', error); }
    if (action.target === 'processor.restart') { st.error = null; render(); }
  }

  /** What the resolution area shows; it is rebuilt only when this changes (focus inside it survives store ticks). */
  function resolutionKey(m) {
    const files = st.files.map(f => [f.id, f.probing, f.duration]);
    const lookup = st.lookup.key === lookupKey(st.input) ? [st.lookup.status, st.lookup.candidates.map(c => c.id)] : ['loading'];
    return JSON.stringify([m, files, st.input.kind, st.input.value, lookup]);
  }

  let shownResolution = null;
  function renderResolution() {
    const m = mode();
    const key = resolutionKey(m);
    if (key === shownResolution) return;
    shownResolution = key;
    resolution.replaceChildren();
    const input = st.input;
    if (st.files.length) {
      resolution.append(filesList(m));
      if (m === 'desktop' && audio().length) {
        if (input.kind !== 'empty') resolution.append(h('p', {class: 'lib-add-line'}, COPY.filesInstead));
        return;
      }
    }
    if (input.kind === 'empty') return;
    if (input.kind === 'spotify') resolution.append(h('p', {class: 'lib-add-line'}, COPY.spotifyLead));
    if (m !== 'desktop') { resolution.append(fallbackLine(input)); return; }
    const lookup = st.lookup.key === lookupKey(input) ? st.lookup : {status: 'loading'};
    if (lookup.status === 'loading' || lookup.status === 'idle') {
      resolution.append(h('p', {class: 'lib-add-line lib-add-looking', role: 'status', dataset: {volatile: ''}}, icon('loader'), COPY.looking));
      return;
    }
    if (lookup.status === 'fallback') { resolution.append(fallbackLine(input)); return; }
    if (lookup.status === 'error') return;
    if (!lookup.candidates.length) {
      resolution.append(h('p', {class: 'lib-add-line', role: 'status'}, COPY.noResults(input.value)));
      return;
    }
    resolution.append(candidateRows(lookup.candidates));
  }

  function fallbackLine(input) {
    if (input.kind === 'url') {
      return h('div', {class: 'lib-add-fallback', role: 'status'}, h('p', {class: 'lib-add-line'}, icon('link'), COPY.urlFallback),
        h('p', {class: 'lib-add-url selectable'}, input.value));
    }
    if (input.kind === 'spotify') return h('p', {class: 'lib-add-line lib-add-fallback', role: 'status'}, COPY.spotifyFallback);
    return h('p', {class: 'lib-add-line lib-add-fallback', role: 'status'}, COPY.searchFallback(input.value));
  }

  function candidateRows(list) {
    if (st.selected >= list.length) st.selected = 0;
    const group = h('div', {class: 'lib-add-candidates', role: 'radiogroup', id: ids.cands, 'aria-label': COPY.candidatesLabel,
      attrs: {'data-consume-keys': 'ArrowUp ArrowDown ArrowLeft ArrowRight'}});
    list.forEach((c, i) => {
      const titleId = `lib-add-${seq}-c${i}`;
      const marks = badges(c.title);
      const duration = formatDuration(c.duration);
      const thumb = c.thumbnail
        ? h('img', {class: 'lib-add-thumb', src: c.thumbnail, alt: '', width: 96, height: 54, attrs: {loading: 'lazy', decoding: 'async'}})
        : h('span', {class: 'lib-add-thumb lib-add-thumb-empty', 'aria-hidden': 'true'}, icon('music'));
      const row = h('div', {
        class: 'lib-add-candidate', role: 'radio', 'aria-checked': String(i === st.selected), tabIndex: i === st.selected ? 0 : -1,
        'aria-labelledby': titleId, dataset: {index: String(i)},
      },
      h('span', {class: 'lib-add-radio', 'aria-hidden': 'true'}),
      thumb,
      h('span', {class: 'lib-add-candidate-text'},
        h('span', {class: 'lib-add-candidate-title', id: titleId}, c.title),
        h('span', {class: 'lib-add-candidate-meta'}, COPY.candidateMeta(c.channel, PROVIDERS[c.provider] ?? PROVIDERS.other))),
      h('span', {class: 'lib-add-candidate-end'},
        ...marks.map(b => h('span', {class: 'lib-add-badge', dataset: {badge: b.toLowerCase()}}, b)),
        c.live ? h('span', {class: 'lib-add-badge', dataset: {badge: 'stream'}}, COPY.liveStream) : null,
        duration ? h('span', {class: 'lib-add-duration tabular'}, duration) : null));
      row.addEventListener('click', () => { select(i); input.focus({preventScroll: true}); });
      group.append(row);
    });
    group.addEventListener('keydown', e => {
      const n = list.length;
      if (['ArrowDown', 'ArrowRight'].includes(e.key)) { e.preventDefault(); select((st.selected + 1) % n, {focus: true}); }
      else if (['ArrowUp', 'ArrowLeft'].includes(e.key)) { e.preventDefault(); select((st.selected + n - 1) % n, {focus: true}); }
      else if (e.key === ' ') {
        const i = Number(e.target?.dataset?.index);
        if (Number.isInteger(i)) { e.preventDefault(); select(i, {focus: true}); }
      }
    });
    return group;
  }

  function filesList(m) {
    const removeButton = f => {
      const remove = h('button', {type: 'button', class: 'lib-add-file-remove', 'aria-label': COPY.removeFile(f.name)}, icon('x'));
      remove.addEventListener('click', () => removeFile(f.id));
      return remove;
    };
    const list = h('ul', {class: 'lib-add-files', 'aria-label': COPY.filesLabel});
    const flags = [];
    for (const f of st.files) {
      if (!f.audio || f.tooLarge) {
        const text = f.audio ? `${f.name}: ${UPLOAD_COPY.tooLarge}` : MODEL_COPY.notAudio(f.name);
        flags.push(h('p', {class: 'lib-add-flag', role: 'status'}, icon('alert-circle'), h('span', {class: 'selectable'}, text), removeButton(f)));
        continue;
      }
      const duration = f.probing ? COPY.durationUnknown : formatDuration(f.duration) ?? COPY.durationUnknown;
      list.append(h('li', {class: 'lib-add-file', dataset: {disabled: m !== 'desktop' ? '' : null}},
        icon('file-audio'),
        h('span', {class: 'lib-add-file-name selectable'}, f.name),
        h('span', {class: 'lib-add-file-meta tabular'}, `${COPY.sizeMB(f.size)} · ${duration}`),
        removeButton(f)));
    }
    const out = [];
    if (list.childNodes.length) out.push(list);
    out.push(...flags);
    if (m !== 'desktop') out.push(h('p', {class: 'lib-add-line'}, COPY.filesWeb));
    else if (audio().length === 1) out.push(titleField());
    return h('div', {class: 'lib-add-files-block'}, ...out);
  }

  function titleField() {
    const id = `lib-add-${seq}-title-field`;
    const hintId = `${id}-hint`;
    const field = h('input', {type: 'text', class: 'lib-add-title-input selectable', id, value: st.title, maxLength: 300, autocomplete: 'off',
      'aria-describedby': hintId});
    field.addEventListener('input', () => {
      st.title = field.value;
      st.titleEdited = field.value.trim() !== fileStem(audio()[0]?.name ?? '');
    });
    return h('div', {class: 'lib-add-title-field'},
      h('label', {class: 'lib-add-label', for: id}, COPY.titleField), field,
      h('p', {class: 'lib-add-field-hint', id: hintId}, COPY.titleHint));
  }

  /** What the duplicate check runs on, in order: [{url?, title?, artist?, duration?}]. */
  function duplicateProbes() {
    const files = audio();
    if (files.length && mode() === 'desktop') {
      const f = files[0];
      return f.duration ? [{title: st.titleEdited ? st.title : fileStem(f.name), duration: f.duration}] : [];
    }
    const out = [];
    if (st.input.kind === 'url' || st.input.kind === 'spotify') out.push({url: st.input.value});
    const c = chosenCandidate();
    if (c) out.push({url: c.url, title: c.title, artist: c.channel, duration: c.duration ?? undefined});
    return out;
  }

  let shownDuplicate = null, duplicateButtons = [];
  function renderDuplicate() {
    let found = null;
    if (!st.busy) for (const probe of duplicateProbes()) { found = findDuplicate(probe, songs()); if (found) break; }
    const song = found && found.id !== st.duplicateDismissed ? found : null;
    const key = song ? JSON.stringify([song.id, song.title, song.artist]) : '';
    if (key === shownDuplicate) return;
    shownDuplicate = key;
    for (const b of duplicateButtons.splice(0)) b.destroy();
    duplicateSlot.replaceChildren();
    if (!song) return;
    const open = Button({label: COPY.openIt, size: 'sm', onClick: () => openSong(song.id)});
    const again = Button({label: COPY.addAnotherVersion, size: 'sm', variant: 'quiet', onClick: () => {
      st.duplicateDismissed = song.id;
      renderDuplicate();
      input.focus({preventScroll: true});
    }});
    duplicateButtons = [open, again];
    duplicateSlot.append(h('div', {class: 'lib-add-duplicate', role: 'status'},
      icon('info'),
      h('p', {class: 'lib-add-duplicate-text'}, h('strong', {}, COPY.duplicateLead), ' ',
        h('span', {class: 'selectable'}, COPY.duplicateName(song.title || 'Untitled', song.artist || song.uploader || ''))),
      h('div', {class: 'lib-add-duplicate-actions'}, open.el, again.el)));
  }

  function openSong(id) {
    if (o.router?.navigate) o.router.navigate(`/s/${encodeURIComponent(id)}`);
  }

  // ---------- defaults line and Change
  let stemsControl = null, qualityControl = null, saveBox = null, estimateNote = null;
  function renderDefaults() {
    const choice = resolvedChoice();
    defaultsText.replaceChildren(...defaultsParts(profile(), accountValue(), choice).map(p => (p.strong ? h('strong', {}, p.text) : p.text)));
    changeButton.setAttribute('aria-expanded', String(st.changeOpen));
    panel.hidden = !st.changeOpen;
    const settings = settingsNow();
    if (st.changeOpen) renderPanel(settings);
    const lost = removesMyStem(profile(), settings.stemMode, settings);
    warning.hidden = !lost;
    warning.textContent = lost ? removesMyStemLine(lost) : '';
  }
  listen(changeButton, 'click', () => {
    st.changeOpen = !st.changeOpen;
    renderDefaults();
    if (st.changeOpen) panel.querySelector('[role=radio][tabindex="0"], [role=radio]')?.focus({preventScroll: true});
  });

  /** Seconds of audio the next job adds (for the estimates), or null when unknown. */
  function durationNow() {
    const files = audio();
    if (files.length && mode() === 'desktop') {
      if (files.some(f => !f.duration)) return null;
      return files.reduce((sum, f) => sum + f.duration, 0);
    }
    return chosenCandidate()?.duration ?? null;
  }

  function qualityOptions() {
    const stats = desktopApp ? o.prefs?.get?.('jobStats') ?? {} : {};
    const seconds = durationNow();
    return QUALITY_OPTIONS.map(q => {
      const min = desktopApp ? estimateMinutes(stats, q.value, seconds) : null;
      return {value: q.value, label: min ? `${q.label} · ${COPY.estimate(min)}` : q.label};
    });
  }

  function renderPanel(settings) {
    if (!stemsControl) {
      const stemsId = `lib-add-${seq}-stems`, qualityId = `lib-add-${seq}-quality`, saveId = `lib-add-${seq}-save`;
      stemsControl = prim(Segmented({label: COPY.stemsLabel, className: 'lib-add-seg', options: STEM_OPTIONS.map(x => ({...x})), value: settings.stemMode,
        attrs: {'aria-labelledby': `${stemsId}-l`},
        onChange: value => { st.choice.stemMode = value; renderDefaults(); }}));
      qualityControl = prim(Segmented({label: COPY.qualityLabel, className: 'lib-add-seg', options: qualityOptions(), value: settings.preset,
        attrs: {'aria-labelledby': `${qualityId}-l`},
        onChange: value => { st.choice.preset = value; renderDefaults(); }}));
      saveBox = h('input', {type: 'checkbox', id: saveId, class: 'lib-add-save-input', checked: st.saveDefaults});
      saveBox.addEventListener('change', () => { st.saveDefaults = saveBox.checked; });
      estimateNote = h('p', {class: 'lib-add-field-hint lib-add-estimate-note', hidden: true}, COPY.estimateNote);
      const customNote = h('p', {class: 'lib-add-field-hint'}, COPY.customHint);
      panel.append(
        h('div', {class: 'lib-add-panel-row'}, h('span', {class: 'lib-add-label', id: `${stemsId}-l`}, COPY.stemsLabel), stemsControl.el),
        h('div', {class: 'lib-add-panel-row'}, h('span', {class: 'lib-add-label', id: `${qualityId}-l`}, COPY.qualityLabel), qualityControl.el, estimateNote),
        h('label', {class: 'lib-add-save', for: saveId}, saveBox, h('span', {}, COPY.saveDefaults)),
        h('p', {class: 'lib-add-field-hint'}, COPY.qualityHint),
        customNote);
    }
    stemsControl.set({value: settings.stemMode});
    const opts = qualityOptions();
    qualityControl.set({options: opts, value: settings.preset});
    estimateNote.hidden = !opts.some((x, i) => x.label !== QUALITY_OPTIONS[i].label);
  }

  // ---------- device line
  let deviceMenu = null, shownDevice = null, deviceButtons = [];
  function deviceKey() {
    if (desktopApp) { const p = processor(); return JSON.stringify(['local', p?.phase, !!p?.firstRun]); }
    const d = chosenDevice();
    return JSON.stringify(['remote', d?.deviceId, d?.name, d ? isOnline(d, at()) : null, devices().length]);
  }
  function renderDevice() {
    const key = deviceKey();
    if (key === shownDevice) return;
    const hadFocus = deviceLine.contains(doc.activeElement);
    shownDevice = key;
    for (const b of deviceButtons.splice(0)) b.destroy();
    deviceLine.replaceChildren();
    buildDevice();
    if (hadFocus) (deviceLine.querySelector('button') ?? input).focus({preventScroll: true});
  }
  function buildDevice() {
    if (desktopApp) {
      const p = processor();
      const phase = p?.phase ?? 'starting';
      const word = phase === 'starting' && p?.firstRun ? COPY.processor.firstRun : COPY.processor[phase] ?? COPY.processor.starting;
      const tone = phase === 'ready' || phase === 'busy' ? 'ok' : phase === 'offline' || phase === 'pair-failed' ? 'danger' : 'neutral';
      deviceLine.append(h('p', {class: 'lib-add-device-text'}, icon('cpu'), `${COPY.localDevice} · `,
        h('span', {class: 'lib-add-dot', dataset: {tone}, 'aria-hidden': 'true'}), ' ', word));
      if (phase === 'offline' && o.desktop?.restartProcessor) {
        const restart = Button({label: COPY.restartProcessor, size: 'sm', variant: 'quiet', onClick: () => o.desktop.restartProcessor()});
        deviceButtons.push(restart);
        deviceLine.append(restart.el);
      }
      return;
    }
    const device = chosenDevice();
    if (!device) return;
    const online = isOnline(device, at());
    const name = device.name || 'Your computer';
    const textNode = online
      ? h('p', {class: 'lib-add-device-text'}, icon('monitor'), ...parts(COPY.remoteDevice(name)), ' · ',
        h('span', {class: 'lib-add-dot', dataset: {tone: 'ok'}, 'aria-hidden': 'true'}), ' ', COPY.online)
      : h('p', {class: 'lib-add-device-text'}, icon('wifi-off'), COPY.deviceOffline(name));
    deviceLine.append(textNode);
    if (devices().length > 1) {
      const pick = h('button', {type: 'button', class: 'lib-add-device-pick', 'aria-haspopup': 'menu', 'aria-label': COPY.chooseDevice(name)},
        icon('chevron-down'));
      pick.addEventListener('click', () => openDeviceMenu(pick));
      deviceLine.append(pick);
    }
  }

  function openDeviceMenu(anchor) {
    deviceMenu?.close?.();
    const current = chosenDevice();
    deviceMenu = Menu.open(devices().map(d => ({
      id: d.deviceId, type: 'radio', label: COPY.deviceItem(d.name || 'Computer', isOnline(d, at())), checked: d.deviceId === current?.deviceId,
      run: () => {
        st.deviceId = d.deviceId;
        o.prefs?.set?.('deviceId', d.deviceId);
        render();
        deviceLine.querySelector('.lib-add-device-pick')?.focus({preventScroll: true});
      },
    })), {anchor, label: COPY.devicesMenu, placement: 'top'});
  }

  // ---------- the explainer (web, no paired computer)
  let explainerBuilt = false;
  function renderExplainer() {
    if (explainerBuilt) return;
    explainerBuilt = true;
    const origin = o.origin || '';
    const downloadUrl = `${origin}${DOWNLOAD_PATH}`;
    const detected = safe(() => o.detectPlatform(o.navigator), 'web');
    const installable = Object.prototype.hasOwnProperty.call(PLATFORMS, detected);
    const newTab = text => [h('span', {}, text), icon('external-link'), h('span', {class: 'sr-only'}, ` ${COPY.newTab}`)];
    const primary = h('a', {class: 'lib-add-download', href: DOWNLOAD_PATH, target: '_blank', rel: 'noopener', attrs: {'data-native': ''}},
      icon('download'), ...newTab(installable ? PLATFORMS[detected].primary : COPY.getDesktop));
    const other = h('a', {class: 'lib-add-link', href: DOWNLOAD_PATH, target: '_blank', rel: 'noopener', attrs: {'data-native': ''}}, ...newTab(COPY.otherPlatforms));
    const status = h('p', {class: 'lib-add-explainer-status', role: 'status'});
    const copy = prim(Button({label: COPY.copyLink, icon: 'copy', variant: 'quiet', onClick: async () => {
      try {
        await o.navigator.clipboard.writeText(downloadUrl);
        status.textContent = COPY.linkCopied;
      } catch {
        status.textContent = `${COPY.copyLink}: ${downloadUrl}`;
      }
    }}));
    const canShare = typeof o.navigator?.share === 'function';
    const share = canShare && (coarse || o.platform?.isIPad) ? prim(Button({label: COPY.shareLink, icon: 'share-2', variant: 'quiet', onClick: async () => {
      try { await o.navigator.share({title: COPY.shareTitle, text: COPY.shareText, url: downloadUrl}); } catch { /* dismissed */ }
    }})) : null;
    const example = prim(Button({label: COPY.openExample, icon: 'play', onClick: () => openExample(example)}));
    explainer.append(
      h('div', {class: 'lib-add-explainer-card'},
        h('p', {class: 'lib-add-explainer-lead selectable'}, h('strong', {}, COPY.explainerStrong), ' ', COPY.explainerBody),
        h('div', {class: 'lib-add-explainer-actions'}, primary),
        h('div', {class: 'lib-add-explainer-links'}, other, copy.el, share?.el),
        h('p', {class: 'lib-add-field-hint'}, COPY.alreadyInstalled),
        status),
      h('p', {class: 'lib-add-meanwhile'}, h('span', {}, COPY.meanwhile), ' ', example.el));
    if (installable) {
      Promise.resolve().then(() => o.fetchRelease()).then(release => {
        const file = release?.downloads?.[detected]?.[0];
        if (!file?.url || !st.open) return;
        primary.href = file.url;
        primary.setAttribute('download', file.name);
      }).catch(() => { /* the /download page lists every platform */ });
    }
  }

  async function openExample(button) {
    button.set({busy: true});
    try {
      const demo = await o.settings.demo();
      const token = demo?.token;
      if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) {
        if (o.router?.navigate) o.router.navigate(`/share/${token}`); else win?.location?.assign?.(`/share/${token}`);
        return;
      }
    } catch { /* fall through */ }
    button.set({busy: false, disabled: true});
  }

  // ---------- submit
  async function submit({keepOpen}) {
    if (st.busy || !st.open) return;
    render();
    if (!canSubmit()) { input.focus({preventScroll: true}); return; }
    const m = mode();
    const files = m === 'desktop' ? audio() : [];
    const textItem = files.length ? null : textSubmission(st.input, m === 'desktop' ? chosenCandidate() : null);
    if (!files.length && !textItem) return;
    st.busy = true;
    st.error = null;
    render();
    let added;
    try {
      added = files.length ? await submitFiles(files) : await submitText(textItem, m);
    } catch (error) {
      st.busy = false;
      st.error = describeError(error, {context: 'add', router: o.router ?? undefined, desktop: o.desktop, device: chosenDevice()?.name});
      st.errorOpen = false;
      if (!st.open) return;
      render();
      input.focus({preventScroll: true});
      return;
    }
    st.busy = false;
    afterAdd(added);
    if (keepOpen && st.open) {
      reset();
      st.notice = COPY.added(added.title);
      render();
      input.focus({preventScroll: true});
      return;
    }
    close('submit', {added});
  }

  async function submitText(item, m) {
    let deviceId;
    if (m === 'desktop') deviceId = await o.uploads.uploadDevice();
    else deviceId = chosenDevice()?.deviceId;
    if (!deviceId) throw {code: 'device_unpaired', message: '', data: {}};
    const created = await o.jobs.createSeparation({...item, deviceId, settings: settingsNow()});
    const jobId = created?.jobId ?? null;
    const title = item.meta?.title || item.source.value;
    return {kind: 'job', jobId, title, keys: jobId ? [`job:${jobId}`] : [],
      undo: async () => (jobId ? (await o.jobs.cancel({jobId})) !== false : false)};
  }

  async function submitFiles(files) {
    // Asking for the processor first shows a missing one inline, before the sheet closes.
    const deviceId = await o.uploads.uploadDevice();
    const single = files.length === 1;
    const titleOverride = single && st.titleEdited && st.title.trim() ? st.title.trim() : undefined;
    const handles = o.uploads.startUploads(files.map(f => f.file), {
      settings: accountValue(), profile: profile(), choice: Object.keys(resolvedChoice()).length ? resolvedChoice() : null, deviceId,
      ...(titleOverride ? {title: titleOverride} : {}),
    });
    const title = single ? (titleOverride ?? fileStem(files[0].name)) : COPY.filesTitle(files.length);
    return {kind: 'upload', handles, title, keys: handles.map(hd => `job:upload:${hd.id}`),
      undo: async () => (await Promise.all(handles.map(hd => Promise.resolve(hd.cancel()).catch(() => false)))).every(Boolean)};
  }

  /** Everything that follows a successful add, whether the sheet stays open or not. */
  function afterAdd(added) {
    if (st.saveDefaults) {
      const settings = settingsNow();
      Promise.resolve(o.account?.patch?.({stemMode: settings.stemMode, preset: settings.preset, addDefaultsSaved: true}))
        .catch(error => console.error('[add] saving the defaults failed', error));
      st.saveDefaults = false;
      st.choice = {stemMode: null, preset: null};
      if (saveBox) saveBox.checked = false;
    }
    if (st.dismissJobId) {
      const jobId = st.dismissJobId;
      st.dismissJobId = null;
      Promise.resolve(o.jobs.dismiss?.({jobId})).catch(() => { /* already gone */ });
    }
    const handle = o.feedback.toast(parts(COPY.toast(added.title)), {
      tone: 'info', durationMs: UNDO_MS, key: `add:${added.keys[0] ?? added.title}`,
      action: {label: COPY.undo, run: () => undo(added)},
    });
    o.feedback.announce(COPY.announce(added.title), {politeness: 'polite', key: 'add-sheet'});
    return handle;
  }

  async function undo(added) {
    let ok = false;
    try { ok = await added.undo(); } catch { ok = false; }
    o.feedback.toast(ok ? COPY.undone(added.title) : COPY.undoFailed, {tone: ok ? 'info' : 'warn'});
  }

  function reset() {
    st.text = '';
    input.value = '';
    st.input = classify('');
    st.files = [];
    st.title = '';
    st.titleEdited = false;
    st.duplicateDismissed = null;
    st.error = null;
    cancelLater(debounceTimer);
    lookupController?.abort();
    lookupController = null;
    st.lookup = {status: 'idle', key: null, kind: null, candidates: [], query: null};
    st.selected = 0;
  }

  // ---------- close
  function close(reason = 'close', {added = null} = {}) {
    if (!st.open) return;
    st.open = false;
    teardown();
    if (o.router?.back) o.router.back({fallback: '/'});
    o.onClose?.(reason, added);
    if (added) focusNewCard(added, doc, {afterRoute: !!o.router?.back});
  }

  function teardown() {
    cancelLater(debounceTimer);
    for (const id of timers) clearTimeout(id);
    timers.clear();
    lookupController?.abort();
    lookupController = null;
    deviceMenu?.close?.();
    closeLayersInside(el, 'dialog');
    for (const fn of cleanups.splice(0).reverse()) { try { fn(); } catch (error) { console.error(error); } }
    for (const p of [...primitives.splice(0), ...duplicateButtons.splice(0), ...deviceButtons.splice(0)]) p.destroy?.();
    restoreFocus(previous, el);
    try { if (el.open) el.close(); } catch { /* not open */ }
    el.remove();
  }

  // ---------- live inputs
  let firstRun = false;
  const offs = [];
  offs.push(effect(() => {
    // Re-render when the account, the processor, the devices or the songs change.
    o.account?.value?.value;
    o.store?.processor?.value;
    o.store?.library?.devices?.value;
    o.store?.library?.songs?.value;
    o.store?.session?.value;
    untracked(() => render());
  }));
  if (!desktopApp) {
    // "Online" is computed from lastSeenAt (D11): look again while the sheet is open.
    const tick = () => { render(); later(tick, RECHECK_MS); };
    later(tick, RECHECK_MS);
  }
  cleanups.push(() => { for (const off of offs.splice(0)) off(); });

  // Desktop first run: the first-song placeholder, once (architecture §2.19).
  if (desktopApp && accountValue()?.onboarding?.desktopFirstRun !== true && songs().size === 0) {
    firstRun = true;
    Promise.resolve(o.account?.markOnboarding?.('desktopFirstRun', true)).catch(() => {});
  }

  // Staged files (the Library's window drop, LB2a) arrive here.
  const staged = safe(() => o.takeStagedFiles?.() ?? [], []);
  if (staged.length) addFiles(staged);
  render();

  // ---------- route input
  function update(match) {
    if (!st.open) return;
    const query = match?.query ?? {};
    const state = match?.state ?? null;
    if (state && typeof state.dismissJobId === 'string') st.dismissJobId = state.dismissJobId;
    if (typeof query.q === 'string' && query.q.trim() && query.q !== st.text) setText(query.q.trim(), {lookupNow: true});
    if (query.pick === '1' && mode() === 'desktop') {
      chooseButton.el.focus({preventScroll: true});
      if (o.navigator?.userActivation?.isActive) openPicker();
      return;
    }
    if (mode() === 'explainer') {
      (focusables(explainer)[0] ?? el).focus({preventScroll: true});
      return;
    }
    input.focus({preventScroll: true});
    if (st.text) input.select?.();
  }

  return {
    el,
    update,
    close,
    destroy() { if (!st.open) return; st.open = false; teardown(); },
    /** A snapshot for tests and the harness. */
    state: () => ({...st, files: st.files.map(f => ({...f})), mode: mode(), presentation, canSubmit: canSubmit()}),
  };
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

/**
 * After the sheet closes, focus the new card in the Library ("Adding" group, home.js) and ring it for 1.5 s.
 * An upload's card is replaced by its job's card once the upload ends; focus follows it there.
 */
export function focusNewCard(added, doc = globalThis.document, {timeoutMs = CARD_WAIT_MS, ringMs = RING_MS, afterRoute = false} = {}) {
  const keys = added?.keys ?? [];
  if (!keys.length || !doc?.body) return () => {};
  let stopped = false;
  const stops = [];
  const stop = () => { stopped = true; for (const fn of stops.splice(0)) fn(); };
  const find = key => {
    const node = doc.querySelector(`[data-focus-key="${CSS_ESCAPE(key)}"]`);
    return node && !node.closest('.lib-add') ? node : null;
  };
  const ring = node => {
    const card = node.closest('.lib-card, .lib-row') ?? node;
    card.setAttribute('data-add-ring', '');
    const id = setTimeout(() => card.removeAttribute('data-add-ring'), ringMs);
    stops.push(() => clearTimeout(id));
  };
  const waitFor = (key, onFound) => {
    const now = find(key);
    if (now) { onFound(now); return; }
    const observer = new Observer(() => {
      const node = find(key);
      if (!node) return;
      observer.disconnect();
      clearTimeout(timer);
      onFound(node);
    });
    observer.observe(doc.body, {childList: true, subtree: true, attributes: true, attributeFilter: ['data-focus-key']});
    const timer = setTimeout(() => observer.disconnect(), timeoutMs);
    stops.push(() => { observer.disconnect(); clearTimeout(timer); });
  };
  const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  // Back to the Library first: the router restores the scroll and focus of its entry once the view is ready, so the
  // card is focused after that (html[data-view-ready] leaves 'add').
  const routed = fn => {
    const root = doc.documentElement;
    const done = () => !afterRoute || (root.dataset.viewReady && root.dataset.viewReady !== 'add');
    if (done()) { fn(); return; }
    const observer = new Observer(() => { if (!done()) return; observer.disconnect(); clearTimeout(timer); fn(); });
    observer.observe(root, {attributes: true, attributeFilter: ['data-view-ready']});
    const timer = setTimeout(() => observer.disconnect(), timeoutMs);
    stops.push(() => { observer.disconnect(); clearTimeout(timer); });
  };
  routed(() => waitFor(keys[0], node => {
    if (stopped) return;
    node.focus({preventScroll: true});
    node.scrollIntoView?.({block: 'center'});
    ring(node);
  }));
  // Uploads: when the first file becomes a job, move focus to its card if it was on the upload's.
  const handle = added.handles?.[0];
  if (handle?.promise) {
    handle.promise.then(result => {
      if (stopped || !result?.jobId) return;
      const active = doc.activeElement;
      const lost = !active || active === doc.body || !active.isConnected || active.dataset?.focusKey === keys[0];
      if (!lost) return;
      waitFor(`job:${result.jobId}`, node => { if (!stopped) node.focus({preventScroll: false}); });
    }, () => {});
  }
  return stop;
}

const CSS_ESCAPE = value => (globalThis.CSS?.escape ? globalThis.CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&'));

// ---------------------------------------------------------------- the view

/** The `add` route's view (modal over the Library, §2.3). */
export function mount(el, match, ctx = {}) {
  const sheet = createAddSheet({
    host: el,
    router: ctx.router ?? null,
    ...(ctx.store ? {store: ctx.store} : {}),
    ...(ctx.platform ? {platform: ctx.platform} : {}),
    ...(ctx.desktop ? {desktop: ctx.desktop} : {}),
    ...(ctx.feedback ? {feedback: {toast: ctx.feedback.toast ?? appToast, announce: ctx.feedback.announce ?? appAnnounce}} : {}),
  });
  sheet.update(match);
  return {
    update(next) { sheet.update(next); },
    unmount() { sheet.destroy(); },
  };
}
