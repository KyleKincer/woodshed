// Boot failures and account states (architecture §2.13, spec §2.7, §6.3).
//
//   renderFatal(el, {title, message, details, onRetry}) → {destroy}
//     A centred 480 px card: "Couldn't open Woodshed. Check your connection and try again. [Retry]",
//     the raw details behind a Details disclosure (mono, selectable, with Copy).
//   renderPaused(el, {status, reason}) → {destroy}
//     "Your account is paused", the reason, [Manage billing] [Export library] [Sign out]: a calm full
//     page in the app frame for a suspended account (main.js stops booting there).
//   mountBanners(el, {store, platform, codecSupported, visible}) → {destroy}
//     The shell's in-flow banners above a top-bar place's view: offline, export-only (adding songs is
//     paused; the Library stays readable) and the codec warning with [Dismiss]. `visible` (a signal)
//     is false on full-bleed places (chrome 'none': Stage, Edit, /welcome), which show none of them.
//
// Copy is in COPY; CONTROLS lists each control's role and accessible name (the table test).

import '../styles/views/shell/fatal.css';
import {action as apiAction} from '../api/client.js';
import {signOut as authSignOut} from './auth.js';
import {SENTENCES, ROWS, LABELS} from './error-copy.copy.js';
import {describeError} from './error-copy.js';
import {effect} from './store.js';
import {Banner} from '../ui/banner.js';
import {Button} from '../ui/button.js';
import {h} from '../ui/h.js';
import {InlineStatus} from '../ui/status.js';

export const COPY = Object.freeze({
  fatalTitle: 'Couldn’t open Woodshed',
  fatalMessage: 'Check your connection and try again.',
  retry: 'Retry',
  details: 'Details',
  copy: 'Copy',
  copied: 'Copied',
  noDetails: 'No further details.',
  pausedTitle: 'Your account is paused',
  reasons: Object.freeze({
    suspended: 'An administrator paused this account. You can still export your library. Contact the app owner to restore access.',
    export_only: 'Adding songs is paused on this account. You can still play, practise and export your library.',
  }),
  manageBilling: 'Manage billing',
  exportLibrary: 'Export library',
  exporting: 'Exporting…',
  exported: 'Your library was exported.',
  billingFailed: 'The billing page couldn’t be opened. Try again.',
  exportFailed: 'The export didn’t finish.',
  tryAgain: 'Try again.',
  signOut: 'Sign out',
  offline: SENTENCES.offline,
  codec: SENTENCES.codec,
  exportOnly: ROWS.accountPaused.sentence,
  exportOnlyMore: 'You can still play, practise and export your library.',
  plan: LABELS.plan,
  dismiss: LABELS.dismiss,
  notices: 'Notices',
});

export const CONTROLS = Object.freeze([
  {where: 'fatal', role: 'button', name: COPY.retry},
  {where: 'fatal', role: 'disclosure', name: COPY.details},   // <details><summary>
  {where: 'fatal', role: 'button', name: COPY.copy},
  {where: 'paused', role: 'button', name: COPY.manageBilling},
  {where: 'paused', role: 'button', name: COPY.exportLibrary},
  {where: 'paused', role: 'button', name: COPY.signOut},
  {where: 'banner:export-only', role: 'button', name: COPY.plan},
  {where: 'banner:codec', role: 'button', name: COPY.dismiss},
]);

let seq = 0;

function detailsText(details) {
  if (details == null || details === '') return COPY.noDetails;
  if (details instanceof Error) return [details.name && details.name !== 'Error' ? `${details.name}: ` : '', details.message || String(details),
    details.cause ? `\n${detailsText(details.cause)}` : ''].join('');
  if (typeof details === 'string') return details;
  try { return JSON.stringify(details, null, 2); } catch { return String(details); }
}

async function copyText(text, win = globalThis.window) {
  try {
    await win?.navigator?.clipboard?.writeText?.(text);
    return true;
  } catch {
    return false;
  }
}

/** The fatal boot card. `onRetry` re-runs boot (main.js calls auth.initialize() again). */
export function renderFatal(el, {title = COPY.fatalTitle, message = COPY.fatalMessage, details = null, onRetry} = {}) {
  const id = `shell-fatal-${++seq}`;
  const raw = detailsText(details);
  const retry = Button({label: COPY.retry, variant: 'primary', icon: 'refresh-cw', onClick: () => onRetry?.()});
  const copy = Button({label: COPY.copy, variant: 'quiet', size: 'sm', icon: 'copy', className: 'shell-fatal-copy',
    onClick: async () => { if (await copyText(raw)) copy.set({label: COPY.copied, icon: 'check'}); }});
  const disclosure = h('details', {class: 'shell-fatal-details'},
    h('summary', {class: 'shell-fatal-summary'}, COPY.details),
    h('pre', {class: 'shell-fatal-raw selectable'}, raw),
    copy.el);
  const card = h('section', {class: 'shell-card shell-fatal', attrs: {role: 'alert', 'aria-labelledby': `${id}-title`}},
    h('h1', {class: 'shell-card-title', id: `${id}-title`}, title),
    h('p', {class: 'shell-card-body selectable'}, message),
    h('div', {class: 'shell-card-actions'}, retry.el),
    disclosure);
  const wrap = h('div', {class: 'shell-centre', attrs: {'data-scroller': true}}, card);
  el.replaceChildren(wrap);
  retry.el.focus({preventScroll: true});
  return {
    el: card,
    destroy() {
      retry.destroy();
      copy.destroy();
      wrap.remove();
    },
  };
}

/**
 * The paused page's export failure line. export.js throws a plain Error with a sentence written for
 * people (the browser cannot stream a large archive, …); a backend error reads through error-copy;
 * anything else (a TypeError, a network failure) gets "Try again." rather than its raw message.
 */
export function exportFailedText(err) {
  if (err && typeof err.code === 'string') return `${COPY.exportFailed} ${describeError(err, {context: 'job'}).sentence}`;
  const own = err instanceof Error && err.name === 'Error' && err.constructor === Error ? String(err.message ?? '').trim() : '';
  return `${COPY.exportFailed} ${own || COPY.tryAgain}`;
}

/**
 * The paused-account page. Manage billing opens the Stripe portal (billing:portal), Export library
 * streams the ZIP (src/js/export.js, loaded on demand), Sign out ends the session and reloads.
 */
export function renderPaused(el, {status = 'suspended', reason, win = globalThis.window} = {}) {
  const id = `shell-paused-${++seq}`;
  const line = InlineStatus({tone: 'info', text: ''});
  line.el.hidden = true;
  const say = (tone, text) => { line.set({tone, text}); line.el.hidden = !text; };

  const billing = Button({label: COPY.manageBilling, variant: 'primary', onClick: async () => {
    billing.set({busy: true, disabled: true});
    try {
      const url = await apiAction('billing:portal', {});
      if (typeof url !== 'string' || !url) throw new Error('No billing URL.');
      win.location.assign(url);
    } catch {
      say('error', COPY.billingFailed);
    }
    billing.set({busy: false, disabled: false});
  }});
  const exporter = Button({label: COPY.exportLibrary, variant: 'secondary', icon: 'download', onClick: async () => {
    exporter.set({busy: COPY.exporting, disabled: true});
    try {
      const {exportLibrary} = await import('../js/export.js');
      await exportLibrary(text => say('info', text));
      say('ok', COPY.exported);
    } catch (err) {
      if (err?.name !== 'AbortError') say('error', exportFailedText(err));
    }
    exporter.set({busy: false, disabled: false});
  }});
  const leave = Button({label: COPY.signOut, variant: 'quiet', icon: 'log-out', onClick: async () => {
    leave.set({busy: true, disabled: true});
    await authSignOut();
    win.location.reload();
  }});
  const card = h('section', {class: 'shell-card shell-paused', attrs: {'aria-labelledby': `${id}-title`, 'data-status': status}},
    h('h1', {class: 'shell-card-title', id: `${id}-title`}, COPY.pausedTitle),
    h('p', {class: 'shell-card-body selectable'}, reason ?? COPY.reasons[status] ?? COPY.reasons.suspended),
    h('div', {class: 'shell-card-actions'}, billing.el, exporter.el, leave.el),
    line.el);
  const wrap = h('div', {class: 'shell-centre', attrs: {'data-scroller': true}}, card);
  el.replaceChildren(wrap);
  return {
    el: card,
    destroy() {
      billing.destroy();
      exporter.destroy();
      leave.destroy();
      line.destroy();
      wrap.remove();
    },
  };
}

/**
 * The shell's banners (in flow, never fixed): offline while `platform.online` is false; export-only
 * while `store.session.status` is 'export_only' ([Plan & storage] → `navigate('/settings/plan')`);
 * the codec warning when `codecSupported` is false, until dismissed on this page. Nothing shows while
 * `visible.value` is false (a full-bleed place).
 */
export function mountBanners(el, {store, platform, codecSupported = true, visible = null, navigate = () => {}} = {}) {
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', COPY.notices);
  let codecDismissed = false;
  const banners = {
    offline: Banner({tone: 'warn', text: COPY.offline, className: 'shell-banner', dataset: {banner: 'offline'}}),
    exportOnly: Banner({tone: 'info', title: COPY.exportOnly, text: COPY.exportOnlyMore, className: 'shell-banner',
      dataset: {banner: 'export-only'}, actions: [{label: COPY.plan, run: () => navigate('/settings/plan')}]}),
    codec: Banner({tone: 'warn', text: COPY.codec, className: 'shell-banner', dataset: {banner: 'codec'},
      actions: [{label: COPY.dismiss, run: () => { codecDismissed = true; render(); }}]}),
  };
  const order = ['offline', 'exportOnly', 'codec'];
  let shown = {};
  function render() {
    const show = visible ? visible.value !== false : true;
    const next = {
      offline: show && (platform?.online ? !platform.online.value : false),
      exportOnly: show && store?.session?.value?.status === 'export_only',
      codec: show && !codecSupported && !codecDismissed,
    };
    shown = next;
    el.replaceChildren(...order.filter(k => next[k]).map(k => banners[k].el));
    el.hidden = !el.childElementCount;
  }
  const dispose = effect(render);
  return {
    get shown() { return {...shown}; },
    destroy() {
      dispose();
      for (const b of Object.values(banners)) b.destroy();
      el.replaceChildren();
    },
  };
}
