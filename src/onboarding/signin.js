// The sign-in card (architecture §2.19, §2.3.1 step 3; spec §6.6.1): a centred 400 px card with
// the wordmark, "Practise along with any song", three lines with 20 px icons, a 48 px
// [Continue with Google] and the fine print. There is no theme picker: the theme follows the system.
//
//   renderSignIn(el, {error, signIn}) → {el, destroy()}
//     error    the AuthError main.js caught (kind 'oauth': expired, access_denied, invalid_flow,
//              oauth_error, rejected, unverified), or null; shown as an alert above the button
//     signIn   starts Google OAuth (main.js passes auth.signIn; default: src/app/auth.js signIn).
//              While it runs the button reads "Opening Google…"; a failure shows its message and
//              re-enables it. A successful start keeps it busy (the page is leaving for Google)
//              until the user comes back unfinished: a bfcache pageshow on the web, or the
//              desktop window regaining focus (desktop opens Google in the system browser).
//   signInMessage(error) → string|null
//     the sentence for an error, in today's sign-in copy (auth.js OAUTH_MESSAGES): a known OAuth
//     code maps to its message; 'rejected' carries the backend's own message; anything else shows
//     its message, else the fallback.
//
// The card sits in its own [data-scroller] (D26) inside the bare frame main.js renders it into.

import '../styles/views/onboarding/onboarding.css';
import '../styles/views/onboarding/signin.css';
import {h} from '../ui/h.js';
import {icon} from '../ui/icon.js';
import {Button} from '../ui/button.js';
import {InlineStatus} from '../ui/status.js';
import {OAUTH_MESSAGES, signIn as authSignIn} from '../app/auth.js';
import {COPY} from './onboarding.copy.js';

const text = value => (typeof value === 'string' && value.trim() ? value.trim() : '');

/** The sign-in sentence for `error` (see the header), or null without one. */
export function signInMessage(error) {
  if (error == null) return null;
  const code = typeof error.code === 'string' ? error.code : '';
  if (code === 'rejected') return text(error.message) || OAUTH_MESSAGES.fallback;
  if (code && Object.prototype.hasOwnProperty.call(OAUTH_MESSAGES, code) && code !== 'fallback') return OAUTH_MESSAGES[code];
  return text(error.message) || OAUTH_MESSAGES.fallback;
}

/** What a failed signIn() shows: an AuthError maps like `error`; anything else means sign-in could not start. */
const failureMessage = err => (err && typeof err.kind === 'string' ? signInMessage(err) : OAUTH_MESSAGES.start_failed);

let seq = 0;

/** Renders the sign-in card into `el`. See the header. */
export function renderSignIn(el, {error = null, signIn = authSignIn} = {}) {
  const titleId = `onboarding-signin-title-${++seq}`;
  const doc = el.ownerDocument;
  const status = InlineStatus({tone: 'error', text: '', className: 'onboarding-signin-error'});
  // Unhidden before the text changes, so the alert is announced.
  const showError = message => {
    status.el.hidden = !message;
    status.set({text: message ?? ''});
  };
  showError(signInMessage(error));

  let busy = false, destroyed = false, offReturn = null;
  const view = doc.defaultView;
  const rearm = () => {
    offReturn?.();
    offReturn = null;
    busy = false;
    if (!destroyed) button.set({busy: false, disabled: false});
  };
  // A started sign-in resolves as soon as the browser is sent to Google, while this page is still
  // loaded, so the button stays "Opening Google…" (a second press would start a second flow and
  // overwrite the one the first needs). It comes back only when the user returns without having
  // finished: on the web, a back navigation that restores this page from the bfcache; in the
  // desktop app (which opens Google in the system browser and keeps this page), the window
  // regaining focus after it lost it.
  const awaitReturn = () => {
    if (!view) return;
    const desktop = !!view.woodshedDesktop;
    let away = !doc.hasFocus();
    const onPageShow = e => { if (e.persisted) rearm(); };
    const onBlur = () => { away = true; };
    const onFocus = () => { if (away) rearm(); };
    view.addEventListener('pageshow', onPageShow);
    if (desktop) {
      view.addEventListener('blur', onBlur);
      view.addEventListener('focus', onFocus);
    }
    offReturn = () => {
      view.removeEventListener('pageshow', onPageShow);
      view.removeEventListener('blur', onBlur);
      view.removeEventListener('focus', onFocus);
    };
  };
  const button = Button({
    label: COPY.signin.continue,
    variant: 'primary',
    size: 'lg',
    className: 'onboarding-signin-button',
    onClick: async () => {
      if (busy) return;
      busy = true;
      showError(null);
      button.set({busy: COPY.signin.opening, disabled: true});
      try {
        await signIn();
      } catch (err) {
        if (!destroyed) showError(failureMessage(err));
        rearm();
        return;
      }
      if (!destroyed) awaitReturn();
    },
  });

  const lines = h('ul', {class: 'onboarding-signin-lines', attrs: {'aria-label': COPY.signin.linesLabel}},
    ...COPY.signin.lines.map(line => h('li', {class: 'onboarding-signin-line'},
      icon(line.icon, {size: 20}), h('span', {}, line.text))));

  const card = h('section', {class: 'onboarding-signin', attrs: {'aria-labelledby': titleId}},
    h('p', {class: 'onboarding-wordmark'}, COPY.wordmark),
    h('h1', {class: 'onboarding-signin-title', attrs: {id: titleId}}, COPY.signin.title),
    lines,
    status.el,
    button.el,
    h('p', {class: 'onboarding-signin-fine'}, COPY.signin.finePrint));
  const wrap = h('div', {class: 'onboarding-centre', attrs: {'data-scroller': true}}, card);
  el.replaceChildren(wrap);

  const previousTitle = doc.title;
  doc.title = COPY.signin.documentTitle;

  return {
    el: wrap,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      offReturn?.();
      offReturn = null;
      button.destroy();
      status.destroy();
      wrap.remove();
      if (doc.title === COPY.signin.documentTitle) doc.title = previousTitle;
    },
  };
}
