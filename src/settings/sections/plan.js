// Settings → Plan & storage (architecture §2.17, §6.3 billing, §9.12 SE2; spec §6.2, §6.3): what the
// cloud library uses, the plan that pays for it, and the way to take it all home.
//
//   Cloud storage    a meter "0.4 of 1.0 GB" (storage.usage, live), the "cloud is full" and "over your
//                    limit" notes, and the 5 largest songs (store.library.songs, by their stems' bytes),
//                    each a link to the song
//   Plan             notices (grace period, cancel at period end, a failed payment), Monthly | Yearly,
//                    and the Free and Plus cards with prices from billingData.status monthlyCents /
//                    annualCents (never hard-coded), storage, "Your plan", [Get Plus] (billing.checkout →
//                    Stripe; disabled with its reason while upgrades are off) and [Manage subscription]
//                    (billing.portal) for an account with a billing customer
//   Export library   [Export library (ZIP)]: src/js/export.js, with the save picker opened inside the
//                    click; progress, [Cancel export], the result. Where the browser has no save picker
//                    (iPad, Safari, Firefox) the 100 MB note says what fits.
//   Playback cache   "412 MB · [Clear]" (this device's Cache API stem cache, src/js/stemcache.js)
// `/settings/plan?checkout=success` (Stripe's return, through the /billing redirect) toasts once when the
// section opens; the query stays on the URL (I2a-15). The billing subscription (billingData.status) and
// the usage subscription are closed when the section closes (maps/shell.md S9).
//
// Copy and controls are exported here (COPY, CONTROLS, ROWS) because settings.copy.js is SE1's
// (architecture §9.0). Tests and harnesses may pass, beside the frame's ctx: `billingApi`
// ({subscribeStatus, checkout, portal}), `storageApi` ({subscribeUsage}), `exporter` (exportLibrary's
// signature), `cache` ({supported(), size(), clear()}), `formatDate(ms)` and `location` ({assign}).

import '../../styles/views/settings/sections.css';
import '../../styles/views/settings/plan.css';
import {h} from '../../ui/h.js';
import {Button, uid} from '../../ui/button.js';
import {Segmented} from '../../ui/segmented.js';
import {InlineStatus} from '../../ui/status.js';
import {Banner} from '../../ui/banner.js';
import {ProgressRail} from '../../ui/progress.js';
import {settingRow} from '../settings.js';
import {SECTION_TITLES} from '../settings.copy.js';
import {describeError} from '../../app/error-copy.js';
import {feedback as appFeedback} from '../../app/feedback.js';
import {artistLabel} from '../../library/song-labels.js';
import * as appBillingApi from '../../api/billing.js';
import * as appStorageApi from '../../api/storage.js';
import {exportLibrary, libraryBytes, EXPORT_COPY, FALLBACK_LIMIT} from '../../js/export.js';
import {clearStemCache, stemCacheSize} from '../../js/stemcache.js';

/** The largest songs listed under the meter. */
export const LARGEST_COUNT = 5;
/** A four-stem song's typical size, for "About N songs with four stems". */
export const BYTES_PER_SONG = 24e6;

export const COPY = Object.freeze({
  usage: Object.freeze({
    label: 'Cloud storage',
    meter: 'Cloud storage used',
    of: (used, limit) => `${used} of ${limit}`,
    loading: 'Measuring…',
    hint: 'Songs still uploading count too.',
    appFull: 'Cloud storage is full for now, so new songs can’t sync. Playback and export still work, and songs on your computer are kept.',
    overLimit: 'Your library is over its storage limit. Adding songs is paused until you get more storage or delete some songs.',
    largest: 'Largest songs',
    failed: 'Storage use couldn’t load.',
  }),
  plan: Object.freeze({
    label: 'Plan',
    interval: 'Billing period',
    monthly: 'Monthly',
    yearly: 'Yearly',
    free: 'Free',
    plus: 'Plus',
    yours: 'Your plan',
    perMonth: '/ month',
    storage: bytes => `${bytes} of cloud storage`,
    songs: n => `About ${n.toLocaleString('en-US')} songs with four stems.`,
    capacity: 'Actual capacity depends on each song’s length, stems and quality.',
    freeFeatures: Object.freeze(['Splitting on your computer', 'Every practice tool, on every device', 'Library export']),
    plusFeatures: Object.freeze(['Everything in Free', 'Room for a much bigger library']),
    billedMonthly: price => `${price} billed monthly.`,
    billedYearly: (price, saving) => (saving ? `${price} billed yearly. Save ${saving} a year.` : `${price} billed yearly.`),
    getPlus: 'Get Plus',
    opening: 'Opening secure checkout…',
    manage: 'Manage subscription',
    openingPortal: 'Opening billing…',
    disabled: 'Upgrades are being set up. Your free library is ready to use.',
    checkoutFailed: 'Checkout couldn’t open. Try again in a moment.',
    portalFailed: 'The billing page couldn’t open. Try again in a moment.',
    finePrint: 'Prices in USD. Cancel any time. When a paid period ends you keep Plus until its last day, then have 14 days to export your library or trim it to the free limit; after that, the oldest cloud songs over the limit are removed. Files on your computer are never touched.',
    loading: 'Loading your plan…',
    failed: 'Your plan couldn’t load.',
    retry: 'Try again',
    grace: (date, free) => `Your Plus plan has ended. By ${date}, export your library or trim it to the free ${free} to keep the songs you want; after that, the oldest songs over the limit are removed.`,
    ending: date => `Your Plus plan ends on ${date}. Manage your subscription to keep it.`,
    pastDue: 'Your last payment didn’t go through. Update your payment details in Manage subscription to keep Plus.',
    checkoutSuccess: 'Welcome to Plus. Your new storage shows here within a minute.',
  }),
  export: Object.freeze({
    label: 'Export library',
    button: 'Export library (ZIP)',
    exporting: 'Exporting…',
    cancel: 'Cancel export',
    progress: 'Export progress',
    hint: 'Everything in your cloud library in one ZIP file: stems, covers, drum charts, practice, setlists and settings. Keep it somewhere safe; it is the only copy outside Woodshed.',
    limitIPad: 'On iPad, an export can be up to 100 MB. For a bigger library, export from Chrome or Edge on a computer, or from Woodshed for desktop.',
    limitBrowser: 'In this browser, an export can be up to 100 MB. For a bigger library, use Chrome or Edge, or Woodshed for desktop.',
    canceled: 'Export canceled. Nothing was saved.',
    failed: 'The export didn’t finish.',
    tryAgain: 'Try again.',
  }),
  cache: Object.freeze({
    label: 'Playback cache',
    clear: 'Clear',
    clearName: 'Clear playback cache',
    clearing: 'Clearing…',
    measuring: 'Measuring…',
    hint: 'Audio kept on this device so songs open faster. Clearing it keeps your library; songs download again the next time you open them.',
    cleared: 'Cleared.',
    unsupported: 'This browser doesn’t keep a playback cache.',
    failed: 'The cache couldn’t be cleared.',
  }),
});

const C = COPY;

/**
 * Every control, as [{section, context, role, name, group?}] (the table form of settings.copy.js
 * CONTROLS). Contexts: 'all'; 'free' (no Plus: Get Plus); 'customer' (a billing customer: Manage
 * subscription); 'exporting' (an export running: Cancel export). The largest songs are links named by
 * their titles.
 */
export const CONTROLS = Object.freeze([
  {section: 'plan', context: 'all', role: 'radiogroup', name: C.plan.interval},
  {section: 'plan', context: 'all', role: 'radio', name: C.plan.monthly, group: C.plan.interval},
  {section: 'plan', context: 'all', role: 'radio', name: C.plan.yearly, group: C.plan.interval},
  {section: 'plan', context: 'free', role: 'button', name: C.plan.getPlus},
  {section: 'plan', context: 'customer', role: 'button', name: C.plan.manage},
  {section: 'plan', context: 'all', role: 'button', name: C.export.button},
  {section: 'plan', context: 'exporting', role: 'button', name: C.export.cancel},
  {section: 'plan', context: 'all', role: 'button', name: C.cache.clearName},
].map(Object.freeze));

/** The rows, as [{section, row, label, scope, path}] (D40: the playback cache is this device's). */
export const ROWS = Object.freeze([
  {section: 'plan', row: 'usage', label: C.usage.label, scope: 'info', path: null},
  {section: 'plan', row: 'plans', label: C.plan.label, scope: 'info', path: null},
  {section: 'plan', row: 'export', label: C.export.label, scope: 'info', path: null},
  {section: 'plan', row: 'cache', label: C.cache.label, scope: 'device', path: null},
].map(Object.freeze));

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)

const GB = 1e9, MB = 1e6;
const trimZero = text => text.replace(/\.0$/, '');

/** '412 MB', '1.2 GB', '25 GB'; '0 MB' for nothing. */
export function formatBytes(bytes) {
  const n = Number(bytes) > 0 ? Number(bytes) : 0;
  if (n >= GB) return `${trimZero((n / GB).toFixed(1))} GB`;
  return `${Math.round(n / MB)} MB`;
}

/** The meter's words, in the limit's unit (spec §6.2: "1.2 of 2.0 GB"). */
export function usageText(used, limit) {
  const u = Number(used) > 0 ? Number(used) : 0, l = Number(limit) > 0 ? Number(limit) : 0;
  if (l >= GB) return C.usage.of((u / GB).toFixed(1), `${(l / GB).toFixed(1)} GB`);
  return C.usage.of(String(Math.round(u / MB)), `${Math.round(l / MB)} MB`);
}

/** The used fraction, 0…1. */
export const usageFraction = (used, limit) => (Number(limit) > 0 ? Math.max(0, Math.min(1, (Number(used) || 0) / Number(limit))) : 0);

/** The `count` songs that take the most storage: [{id, title, artist, bytes}], largest first. */
export function largestSongs(songs, count = LARGEST_COUNT) {
  const list = songs instanceof Map ? [...songs.values()] : Array.isArray(songs) ? songs : [];
  return list
    .map(song => ({id: song?.id, title: String(song?.title ?? '').trim() || 'Untitled', artist: artistLabel(song), bytes: libraryBytes([song])}))
    .filter(s => s.id && s.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes || a.title.localeCompare(b.title))
    .slice(0, count);
}

/** '$2', '$1.67', '$20' from cents. */
export function formatPrice(cents) {
  const n = Math.max(0, Math.round(Number(cents) || 0));
  return n % 100 === 0 ? `$${n / 100}` : `$${(n / 100).toFixed(2)}`;
}

/** The Plus card's price for an interval: {price: per month, cadence}. */
export function planPrice({monthlyCents, annualCents} = {}, interval = 'year') {
  if (interval === 'month') return {price: formatPrice(monthlyCents), cadence: C.plan.billedMonthly(formatPrice(monthlyCents))};
  const saving = Math.round((Number(monthlyCents) || 0) * 12 - (Number(annualCents) || 0));
  return {price: formatPrice(Math.round((Number(annualCents) || 0) / 12)), cadence: C.plan.billedYearly(formatPrice(annualCents), saving > 0 ? formatPrice(saving) : '')};
}

/** "November 6, 2026" (the reader's locale). */
export const formatDate = ms => new Intl.DateTimeFormat(undefined, {year: 'numeric', month: 'long', day: 'numeric'}).format(new Date(ms));

/** The plan notices for a billing status: [{key, tone, text}]. */
export function planNotices(status, {format = formatDate} = {}) {
  if (!status) return [];
  const out = [];
  if (status.access === 'grace' && Number.isFinite(status.graceEndsAt)) {
    out.push({key: 'grace', tone: 'warn', text: C.plan.grace(format(status.graceEndsAt), formatBytes(status.freeBytes))});
  }
  if (status.access === 'paid' && status.cancelAtPeriodEnd && Number.isFinite(status.periodEnd)) {
    out.push({key: 'ending', tone: 'info', text: C.plan.ending(format(status.periodEnd))});
  }
  if (status.access === 'paid' && ['past_due', 'unpaid'].includes(status.status)) out.push({key: 'pastDue', tone: 'warn', text: C.plan.pastDue});
  return out;
}

/** The interval the cards open on: the subscription's, else Yearly. */
export const initialInterval = status => (status?.interval === 'month' ? 'month' : 'year');

const plainClick = e => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

// ---------------------------------------------------------------------------------------------
// The section

function render(el, ctx) {
  const {store, platform, router} = ctx;
  const win = ctx.window ?? globalThis.window;
  const billingApi = ctx.billingApi ?? appBillingApi;
  const storageApi = ctx.storageApi ?? appStorageApi;
  const exporter = ctx.exporter ?? exportLibrary;
  const cache = ctx.cache ?? {supported: () => !!win && 'caches' in win, size: stemCacheSize, clear: clearStemCache};
  const fb = ctx.feedback ?? appFeedback;
  const format = ctx.formatDate ?? formatDate;
  const location = ctx.location ?? win?.location;
  const sub = ctx.layout === 'stack' ? 'h2' : 'h3';
  const parts = [];
  const offs = [];
  const keep = part => { parts.push(part); return part; };
  let destroyed = false;

  // ------------------------------------------------------------------ Cloud storage
  const usageRowId = uid('settings-row');
  const fill = h('span', {class: 'settings-meter-fill'});
  const meter = h('div', {class: 'settings-meter', role: 'meter', 'aria-labelledby': usageRowId,
    'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0'}, fill);
  const usageValue = h('p', {class: 'settings-value settings-usage-value', role: 'status'}, C.usage.loading);
  const usageNote = h('p', {class: 'settings-usage-note', hidden: true});
  const largestId = uid('settings-largest');
  const largestList = h('ol', {class: 'settings-largest', 'aria-labelledby': largestId});
  const largest = h('div', {class: 'settings-largest-block', hidden: true},
    h('p', {class: 'settings-inline-label', id: largestId}, C.usage.largest), largestList);
  const usageRow = settingRow({row: 'usage', label: C.usage.label, hint: C.usage.hint, scope: 'info', labelId: usageRowId,
    controls: [h('div', {class: 'settings-usage'}, meter, usageValue), usageNote, largest]});

  let usage = null;
  function showUsage() {
    if (!usage) return;
    const fraction = usageFraction(usage.usedBytes, usage.limitBytes);
    const text = usageText(usage.usedBytes, usage.limitBytes);
    fill.style.setProperty('--settings-meter', String(fraction));
    meter.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    meter.setAttribute('aria-valuetext', text);
    meter.dataset.full = String(fraction >= 1);
    usageValue.textContent = text;
    const over = Number(usage.usedBytes) > Number(usage.limitBytes) && Number(usage.limitBytes) > 0;
    const note = usage.appFull ? C.usage.appFull : over ? C.usage.overLimit : '';
    usageNote.textContent = note;
    usageNote.hidden = !note;
  }
  function showLargest() {
    const top = largestSongs(store?.library?.songs?.peek?.());
    largestList.replaceChildren(...top.map(song => h('li', {class: 'settings-largest-item'},
      h('a', {href: `/s/${encodeURIComponent(song.id)}`, class: 'settings-largest-link', dataset: {focusKey: `settings-largest:${song.id}`},
        on: {click: e => {
          if (!plainClick(e) || !router?.navigate) return;
          e.preventDefault();
          router.navigate(`/s/${encodeURIComponent(song.id)}`);
        }}}, song.title),
      song.artist ? h('span', {class: 'settings-largest-artist'}, song.artist) : null,
      h('span', {class: 'settings-largest-size'}, formatBytes(song.bytes)))));
    largest.hidden = !top.length;
  }
  offs.push(storageApi.subscribeUsage(value => {
    if (destroyed || !value) return;
    usage = value;
    showUsage();
  }, err => {
    console.warn('[settings] storage usage failed:', err?.message ?? err);
    if (!destroyed && !usage) usageValue.textContent = C.usage.failed;
  }));
  showLargest();
  if (store?.library?.songs?.subscribe) offs.push(store.library.songs.subscribe(() => showLargest()));

  // ------------------------------------------------------------------ Plan
  const P = C.plan;
  let status = null, interval = null, pending = false;
  const notices = h('div', {class: 'settings-notices'});
  const noticeParts = [];
  const planStatus = keep(InlineStatus({tone: 'info', text: P.loading}));
  const actionStatus = keep(InlineStatus({tone: 'error', text: ''}));
  actionStatus.el.hidden = true;
  const intervalId = uid('settings-interval');
  const intervalSeg = keep(Segmented({
    attrs: {'aria-labelledby': intervalId},
    size: 'sm',
    options: [{value: 'month', label: P.monthly}, {value: 'year', label: P.yearly}],
    value: 'year',
    onChange: value => { interval = value; showPlan(); },
  }));

  const card = (id, title) => {
    const headingId = uid(`settings-plan-${id}`);
    const badge = h('span', {class: 'settings-plan-badge', hidden: true}, P.yours);
    const price = h('span', {class: 'settings-plan-price'});
    const per = h('span', {class: 'settings-plan-per'});
    const cadence = h('p', {class: 'settings-plan-cadence'});
    const storage = h('p', {class: 'settings-plan-storage'});
    const songs = h('p', {class: 'settings-plan-songs'});
    const features = h('ul', {class: 'settings-plan-features', role: 'list'});
    const actions = h('div', {class: 'settings-plan-actions'});
    const el = h('article', {class: 'settings-plan', dataset: {plan: id}, 'aria-labelledby': headingId},
      h('div', {class: 'settings-plan-head'}, h(sub, {class: 'settings-plan-title', id: headingId}, title), badge),
      h('p', {class: 'settings-plan-amount'}, price, ' ', per), cadence, storage, songs, features, actions);
    return {el, badge, price, per, cadence, storage, songs, features, actions};
  };
  const freeCard = card('free', P.free);
  const plusCard = card('plus', P.plus);
  freeCard.features.replaceChildren(...P.freeFeatures.map(f => h('li', {}, f)));
  plusCard.features.replaceChildren(...P.plusFeatures.map(f => h('li', {}, f)));

  const openBilling = async (button, busyLabel, run, failedText) => {
    if (pending) return;
    pending = true;
    actionStatus.el.hidden = true;
    syncButtons();
    button.set({busy: busyLabel});
    try {
      const url = await run();
      if (typeof url !== 'string' || !url) throw new Error('No billing URL.');
      location.assign(url);
    } catch (err) {
      console.warn('[settings] billing did not open:', err?.message ?? err);
      if (!destroyed) { actionStatus.set({text: failedText}); actionStatus.el.hidden = false; }
    } finally {
      pending = false;
      if (!destroyed) { button.set({busy: false}); syncButtons(); }
    }
  };
  const getPlus = keep(Button({label: P.getPlus, variant: 'primary', onClick: () =>
    openBilling(getPlus, P.opening, () => billingApi.checkout({interval: interval ?? 'year'}), P.checkoutFailed)}));
  const manage = keep(Button({label: P.manage, icon: 'external-link', onClick: () =>
    openBilling(manage, P.openingPortal, () => billingApi.portal(), P.portalFailed)}));
  plusCard.actions.append(getPlus.el, manage.el);

  function syncButtons() {
    const enabled = !!status?.enabled;
    getPlus.set({disabled: pending || !enabled, disabledReason: !enabled ? P.disabled : null});
    manage.set({disabled: pending});
  }

  const plans = h('div', {class: 'settings-plans'}, freeCard.el, plusCard.el);
  const planBody = h('div', {class: 'settings-plan-body', hidden: true},
    notices,
    h('div', {class: 'settings-inline'}, h('span', {class: 'settings-inline-label', id: intervalId}, P.interval), intervalSeg.el),
    plans,
    actionStatus.el,
    h('p', {class: 'settings-tip'}, P.finePrint));
  const plansRow = settingRow({row: 'plans', label: P.label, scope: 'info', controls: [planStatus.el, planBody]});

  function showPlan() {
    if (!status) return;
    planStatus.el.hidden = true;
    planBody.hidden = false;
    if (interval == null) interval = initialInterval(status);
    intervalSeg.set({value: interval});
    const paid = status.access === 'paid';
    freeCard.badge.hidden = paid;
    plusCard.badge.hidden = !paid;
    freeCard.el.dataset.current = String(!paid);
    plusCard.el.dataset.current = String(paid);
    freeCard.price.textContent = formatPrice(0);
    freeCard.per.textContent = '';
    freeCard.cadence.textContent = '';
    freeCard.cadence.hidden = true;
    freeCard.storage.textContent = P.storage(formatBytes(status.freeBytes));
    freeCard.songs.textContent = P.songs(Math.floor((Number(status.freeBytes) || 0) / BYTES_PER_SONG));
    const {price, cadence} = planPrice(status, interval);
    plusCard.price.textContent = price;
    plusCard.per.textContent = P.perMonth;
    plusCard.cadence.textContent = cadence;
    plusCard.storage.textContent = P.storage(formatBytes(status.proBytes));
    plusCard.songs.textContent = `${P.songs(Math.floor((Number(status.proBytes) || 0) / BYTES_PER_SONG))} ${P.capacity}`;
    getPlus.el.hidden = paid;
    manage.el.hidden = !status.hasCustomer;
    syncButtons();
    for (const part of noticeParts.splice(0)) part.destroy();
    for (const n of planNotices(status, {format})) {
      const banner = Banner({tone: n.tone, text: n.text, dataset: {notice: n.key}});
      noticeParts.push(banner);
      notices.append(banner.el);
    }
    notices.hidden = !noticeParts.length;
  }

  let offStatus = null;
  function watchStatus() {
    offStatus?.();
    planStatus.set({tone: 'info', text: P.loading, action: null});
    planStatus.el.hidden = false;
    offStatus = billingApi.subscribeStatus(value => {
      if (destroyed || !value) return;
      status = value;
      showPlan();
    }, err => {
      console.warn('[settings] the plan failed to load:', err?.message ?? err);
      if (destroyed || status) return;
      planStatus.set({tone: 'error', text: P.failed, action: {label: P.retry, run: () => watchStatus()}});
    });
  }
  watchStatus();
  offs.push(() => offStatus?.());
  offs.push(() => { for (const part of noticeParts.splice(0)) part.destroy(); });

  // ?checkout=success: Stripe's return (spec §6.3). The URL keeps its query.
  const query = router?.current?.peek?.()?.query ?? Object.fromEntries(new URLSearchParams(win?.location?.search ?? ''));
  if (query?.checkout === 'success') fb.toast?.(P.checkoutSuccess, {tone: 'ok', key: 'checkout-success'});

  // ------------------------------------------------------------------ Export library
  const E = C.export;
  let controller = null;
  const exportStatus = keep(InlineStatus({tone: 'info', text: ''}));
  exportStatus.el.hidden = true;
  const progressText = h('p', {class: 'settings-value settings-export-progress', role: 'status'});
  const rail = keep(ProgressRail({value: null, label: E.progress}));
  const progress = h('div', {class: 'settings-export-running', hidden: true}, rail.el, progressText);
  const cancel = keep(Button({label: E.cancel, variant: 'quiet', onClick: () => controller?.abort()}));
  cancel.el.hidden = true;
  const exportButton = keep(Button({label: E.button, icon: 'download', variant: 'primary', onClick: () => startExport()}));
  const pickerless = typeof win?.showSaveFilePicker !== 'function';
  const limitNote = pickerless ? h('p', {class: 'settings-tip', dataset: {limit: String(FALLBACK_LIMIT)}}, platform?.isIPad ? E.limitIPad : E.limitBrowser) : null;
  const exportRow = settingRow({row: 'export', label: E.label, hint: E.hint, scope: 'info',
    controls: [h('div', {class: 'settings-actions'}, exportButton.el, cancel.el), progress, exportStatus.el, limitNote]});

  function finishExport() {
    controller = null;
    progress.hidden = true;
    cancel.el.hidden = true;
    exportButton.set({busy: false, disabled: false});
  }
  function startExport() {
    if (controller) return;
    controller = new AbortController();
    const signal = controller.signal;
    exportStatus.el.hidden = true;
    exportButton.set({busy: E.exporting, disabled: true});
    // exportLibrary opens the save picker synchronously, inside this click.
    let running;
    try {
      running = Promise.resolve(exporter((text, detail = {}) => {
        if (destroyed || controller?.signal !== signal) return;
        progress.hidden = false;
        cancel.el.hidden = false;
        progressText.textContent = text;
        const total = Number(detail.total) || 0;
        rail.set({value: detail.phase === 'song' && total ? detail.done / total : detail.phase === 'finish' || detail.phase === 'done' ? 1 : null});
      }, {signal}));
    } catch (err) {
      running = Promise.reject(err);
    }
    running.then(result => {
      if (destroyed) return;
      finishExport();
      exportStatus.set({tone: 'ok', text: EXPORT_COPY.done(Number(result?.songs) || 0)});
      exportStatus.el.hidden = false;
    }, err => {
      if (destroyed) return;
      const aborted = err?.name === 'AbortError';
      const byUs = signal.aborted;
      finishExport();
      if (aborted && !byUs) return;   // the save picker was cancelled: nothing to say
      exportStatus.set(aborted ? {tone: 'info', text: E.canceled} : {tone: 'error', text: exportFailedText(err)});
      exportStatus.el.hidden = false;
    });
  }
  offs.push(() => controller?.abort());

  // ------------------------------------------------------------------ Playback cache
  const K = C.cache;
  const cacheValue = h('p', {class: 'settings-value settings-cache-value', role: 'status'}, K.measuring);
  const cacheStatus = keep(InlineStatus({tone: 'ok', text: ''}));
  cacheStatus.el.hidden = true;
  const clear = keep(Button({label: K.clear, icon: 'trash-2', attrs: {'aria-label': K.clearName}, onClick: async () => {
    cacheStatus.el.hidden = true;
    clear.set({busy: K.clearing, disabled: true});
    try {
      await cache.clear();
      if (destroyed) return;
      cacheStatus.set({tone: 'ok', text: K.cleared});
    } catch (err) {
      console.warn('[settings] the playback cache was not cleared:', err?.message ?? err);
      if (destroyed) return;
      cacheStatus.set({tone: 'error', text: K.failed});
    }
    cacheStatus.el.hidden = false;
    clear.set({busy: false, disabled: false});
    measure();
  }}));
  const supported = !!cache.supported?.();
  async function measure() {
    if (!supported) { cacheValue.textContent = K.unsupported; clear.el.hidden = true; return; }
    try {
      const bytes = await cache.size();
      if (!destroyed) cacheValue.textContent = formatBytes(bytes);
    } catch (err) {
      console.warn('[settings] the playback cache could not be measured:', err?.message ?? err);
      if (!destroyed) { cacheValue.textContent = K.unsupported; clear.el.hidden = true; }
    }
  }
  measure();
  const cacheRow = settingRow({row: 'cache', label: K.label, hint: K.hint, scope: 'device',
    controls: [h('div', {class: 'settings-cache'}, cacheValue, h('span', {class: 'settings-cache-sep', 'aria-hidden': 'true'}, '·'), clear.el), cacheStatus.el]});

  const page = h('div', {class: 'settings-section settings-plan-section', dataset: {section: 'plan'}},
    h('div', {class: 'settings-group'}, usageRow.el, plansRow.el, exportRow.el, cacheRow.el));
  el.replaceChildren(page);

  return {
    destroy() {
      destroyed = true;
      for (const off of offs.splice(0)) { try { off(); } catch (err) { console.error('[settings] plan cleanup failed', err); } }
      for (const part of parts.splice(0)) part.destroy();
      page.remove();
    },
  };
}

/**
 * The export failure line: a backend error reads through error-copy; export.js's own sentences as they
 * are; anything else (a TypeError, a network failure) "Try again." rather than its raw message.
 */
export function exportFailedText(err) {
  if (err && typeof err.code === 'string') return `${C.export.failed} ${describeError(err, {context: 'load'}).sentence}`;
  const own = err instanceof Error && err.constructor === Error ? String(err.message ?? '').trim() : '';
  return `${C.export.failed} ${own || C.export.tryAgain}`;
}

export default Object.freeze({id: 'plan', title: SECTION_TITLES.plan, render});
