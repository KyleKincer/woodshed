// The boot status (architecture §1, §2.3.1): index.html carries <div id="startup" role="status">
// and html[data-startup=loading]; main.js shows the status while it signs in and mounts the first
// view, and removes it once a view, the sign-in card, the paused page or the fatal card is up.
//
//   showStartup({slowMs = 8000, onRetry})  "Opening Woodshed…"; after slowMs, "Still connecting…" [Retry]
//   finishStartup()                        html[data-startup=ready]; the status leaves the page
//   showSignIn()                           html[data-startup=signin]; the status leaves the page
//
// The status lives outside #app, so views never replace it; theme-init.js marks /download with
// data-startup=download, which this module leaves alone.

import '../styles/views/shell/fatal.css';

export const STARTUP_COPY = Object.freeze({
  opening: 'Opening Woodshed…',
  slow: 'Still connecting…',
  retry: 'Retry',
});
export const SLOW_MS = 8000;
const STATUS_ID = 'startup';

let slowTimer = null;

const docOf = doc => doc ?? globalThis.document;

function statusElement(doc) {
  let el = doc.getElementById(STATUS_ID);
  if (!el) {
    el = doc.createElement('div');
    el.id = STATUS_ID;
    doc.body.append(el);
  }
  el.setAttribute('role', 'status');
  el.className = 'shell-startup';
  return el;
}

function render(el, {slow, onRetry}) {
  const doc = el.ownerDocument;
  const pulse = doc.createElement('span');
  pulse.className = 'shell-startup-pulse';
  pulse.setAttribute('aria-hidden', 'true');
  const label = doc.createElement('span');
  label.className = 'shell-startup-text';
  label.textContent = slow ? STARTUP_COPY.slow : STARTUP_COPY.opening;
  const parts = [pulse, label];
  if (slow) {
    const retry = doc.createElement('button');
    retry.type = 'button';
    retry.className = 'shell-startup-retry';
    retry.textContent = STARTUP_COPY.retry;
    retry.addEventListener('click', () => onRetry?.());
    parts.push(retry);
  }
  el.dataset.slow = slow ? 'true' : 'false';
  el.replaceChildren(...parts);
}

function clearSlow() {
  if (slowTimer != null) clearTimeout(slowTimer);
  slowTimer = null;
}

/** Shows the boot status. After `slowMs` it reads "Still connecting…" with [Retry] (`onRetry`, default reload). */
export function showStartup({slowMs = SLOW_MS, onRetry, doc} = {}) {
  const d = docOf(doc);
  clearSlow();
  d.documentElement.dataset.startup = 'loading';
  const el = statusElement(d);
  const retry = onRetry ?? (() => d.defaultView?.location?.reload());
  render(el, {slow: false, onRetry: retry});
  if (Number.isFinite(slowMs) && slowMs >= 0) {
    slowTimer = setTimeout(() => {
      slowTimer = null;
      if (el.isConnected) render(el, {slow: true, onRetry: retry});
    }, slowMs);
  }
  return el;
}

function dismiss(d, state) {
  clearSlow();
  d.documentElement.dataset.startup = state;
  d.getElementById(STATUS_ID)?.remove();
}

/** The first view (or the paused page, or the fatal card) is on screen: the status goes away. */
export function finishStartup({doc} = {}) {
  dismiss(docOf(doc), 'ready');
}

/** The sign-in card is on screen: the status goes away. */
export function showSignIn({doc} = {}) {
  dismiss(docOf(doc), 'signin');
}
