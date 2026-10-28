// The "Not built yet" view (architecture D2; deleted in wave 4). routes.js resolves every contract
// path that has no module yet to this file, so each unbuilt place still mounts, navigates and goes
// back like a real view, and the fixture's structural check can flag an unexpected placeholder.
//
//   mount(el, match, ctx) → {update(match), unmount()}   any route: a page (or, for a modal route
//                                                        such as /add, a modal panel over its parent)
//   boot(match)                                          a boot route (/download, /share/:token)
//   renderSignIn(el, {error, signIn}) → {destroy}        the sign-in card until ON1's signin.js lands:
//                                                        Continue with Google works, errors show inline
//
// Copy is in COPY; CONTROLS lists each control's role and accessible name (the table test).

import '../styles/views/shell/placeholder.css';
import {pushOverlay} from './dispatch.js';
import {restoreFocus, trapTab} from '../ui/popover.js';
import {h} from '../ui/h.js';
import {Button} from '../ui/button.js';
import {InlineStatus} from '../ui/status.js';

export const COPY = Object.freeze({
  notBuilt: 'Not built yet',
  body: 'This part of Woodshed arrives in a later build.',
  back: 'Back to Library',
  close: 'Close',
  wordmark: 'Woodshed',
  signInTitle: 'Sign in to Woodshed',
  signIn: 'Continue with Google',
  signingIn: 'Opening Google…',
  titles: Object.freeze({
    library: 'Library', add: 'Add song', welcome: 'What do you play?', stage: 'Stage', edit: 'Edit', editFind: 'Find a chart',
    bulkDetails: 'Edit details', settings: 'Settings', settingsPage: 'Settings', admin: 'Administration',
    adminAccount: 'Account', setlist: 'Setlist', download: 'Get Woodshed for desktop', share: 'Shared song',
  }),
});

export const CONTROLS = Object.freeze([
  {where: 'page', role: 'link', name: COPY.back},
  {where: 'modal', role: 'button', name: COPY.close},
  {where: 'signin', role: 'button', name: COPY.signIn},
]);

const titleOf = match => COPY.titles[match?.name] ?? COPY.notBuilt;

function page(match, {modal = false, headingId}) {
  return [
    h('p', {class: 'shell-placeholder-kicker'}, COPY.notBuilt),
    h('h1', {class: 'shell-placeholder-title', id: headingId}, titleOf(match)),
    h('p', {class: 'shell-placeholder-body'}, COPY.body),
    modal || match?.name === 'library' ? null : h('a', {class: 'shell-placeholder-link', href: '/'}, COPY.back),
  ];
}

let seq = 0;

/** A placeholder page for any route; a modal route gets a modal panel over its parent view. */
export function mount(el, match, ctx = {}) {
  const headingId = `shell-placeholder-${++seq}`;
  if (match?.route?.modalOver) return mountModal(el, match, ctx, headingId);
  const body = h('div', {class: 'shell-placeholder', attrs: {'data-placeholder': match?.name ?? ''}}, ...page(match, {headingId}));
  const scroller = h('div', {class: 'shell-placeholder-scroller', attrs: {'data-scroller': true}},
    h('div', {class: 'app-content'}, body));
  el.replaceChildren(scroller);
  let current = match;
  return {
    update(next) {
      current = next;
      body.dataset.placeholder = next?.name ?? '';
      body.querySelector('.shell-placeholder-title').textContent = titleOf(current);
    },
    unmount() { scroller.remove(); },
  };
}

function mountModal(el, match, ctx, headingId) {
  const doc = el.ownerDocument;
  const previous = doc.activeElement;
  const close = () => (ctx.router?.back ? ctx.router.back({fallback: '/'}) : undefined);
  const closeButton = Button({label: COPY.close, variant: 'secondary', onClick: close});
  const panel = h('div', {class: 'shell-placeholder shell-placeholder-panel',
    attrs: {role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': headingId, 'data-placeholder': match.name}},
  ...page(match, {modal: true, headingId}), h('div', {class: 'shell-placeholder-actions'}, closeButton.el));
  const backdrop = h('div', {class: 'shell-placeholder-backdrop'}, panel);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  el.replaceChildren(backdrop);
  const pop = pushOverlay({el: panel, modal: true, onEscape: close});
  const untrap = trapTab(panel);
  closeButton.el.focus({preventScroll: true});
  return {
    update(next) { panel.querySelector('.shell-placeholder-title').textContent = titleOf(next); },
    unmount() {
      pop();
      untrap();
      restoreFocus(previous, panel);
      closeButton.destroy();
      backdrop.remove();
    },
  };
}

/** A boot route (/download, /share/:token) whose module is not built yet: a page in #app. */
export function boot(match, {doc = globalThis.document} = {}) {
  const outlet = doc.getElementById('app') ?? doc.body;
  outlet.classList.add('app-frame');
  outlet.dataset.chrome = 'none';
  const main = h('main', {class: 'app-main'});
  outlet.replaceChildren(main);
  mount(main, match);
  doc.documentElement.dataset.viewReady = match?.name ?? 'placeholder';
}

/**
 * The sign-in card until ON1's src/onboarding/signin.js exists (same contract: renderSignIn(el, {error})).
 * `signIn` starts OAuth (main.js passes auth.signIn); a failure shows its message inline.
 */
export function renderSignIn(el, {error = null, signIn} = {}) {
  const status = InlineStatus({tone: 'error', text: error?.message ?? ''});
  status.el.hidden = !error;
  const button = Button({label: COPY.signIn, variant: 'primary', size: 'lg', className: 'shell-signin-button',
    onClick: async () => {
      if (typeof signIn !== 'function') return;
      button.set({busy: COPY.signingIn, disabled: true});
      status.el.hidden = true;
      try {
        await signIn();
      } catch (err) {
        status.set({text: err?.message || COPY.signIn});
        status.el.hidden = false;
      }
      button.set({busy: false, disabled: false});
    }});
  const card = h('section', {class: 'shell-placeholder shell-signin', attrs: {'aria-labelledby': 'shell-signin-title'}},
    h('p', {class: 'shell-signin-wordmark'}, COPY.wordmark),
    h('h1', {class: 'shell-placeholder-title', id: 'shell-signin-title'}, COPY.signInTitle),
    status.el,
    button.el,
    h('p', {class: 'shell-placeholder-kicker'}, COPY.notBuilt));
  const wrap = h('div', {class: 'shell-centre', attrs: {'data-scroller': true}}, card);
  el.replaceChildren(wrap);
  return {
    destroy() {
      button.destroy();
      status.destroy();
      wrap.remove();
    },
  };
}
