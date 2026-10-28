// /welcome, "What do you play?" (architecture §2.19, D39; spec §6.6.2): one skippable screen that
// boot pushes once while account.onboarding.whatDoYouPlay is unset. A full-bleed place (chrome
// 'none'): the wordmark, the question, why it matters, the InstrumentPicker, [Continue] and [Skip].
//
//   mount(el, match, ctx) → {update(match), unmount()}      the route view (§2.3 Mounting)
//     ctx.router   navigate('/', {replace: true}) after Continue or Skip
//     ctx.account  the account module (default: src/app/account.js account); tests and the harness
//                  pass their own
//
// Continue → account.patch({profile, onboarding: {whatDoYouPlay: 'done'}}) → replace('/'). It needs at
// least one instrument (its visible reason says so) and waits for the save: a failure keeps the
// screen with "Couldn't save · [Retry]". Skip → account.markOnboarding('whatDoYouPlay', 'skipped') →
// replace('/') at once (the write is optimistic; if it fails, boot asks again next time). Skip never
// downgrades an answer already given ('done'): before the account has loaded it waits for the
// settings, then writes only if the flag is still unset. Retry keeps keyboard focus on Continue.
// Until the user touches the picker it follows the account's profile (another device may have set
// it), so an existing profile is pre-chosen.

import '../styles/views/onboarding/onboarding.css';
import '../styles/views/onboarding/welcome.css';
import {h} from '../ui/h.js';
import {Button} from '../ui/button.js';
import {InlineStatus} from '../ui/status.js';
import {account as appAccount} from '../app/account.js';
import {InstrumentPicker, normaliseProfile} from './instruments.js';
import {COPY} from './onboarding.copy.js';

let seq = 0;

export function mount(el, match, ctx = {}) {
  const account = ctx.account ?? appAccount;
  const router = ctx.router;
  const doc = el.ownerDocument;
  const titleId = `onboarding-welcome-title-${++seq}`;
  let profile = normaliseProfile(account.profile.peek());
  let touched = false, saving = false, left = false;

  const status = InlineStatus({tone: 'error', text: '', className: 'onboarding-welcome-status'});
  status.el.hidden = true;
  const showFailure = () => {
    status.el.hidden = false;
    status.set({text: COPY.welcome.saveFailed, action: {label: COPY.welcome.retry, run: () => save()}});
  };
  const hideFailure = () => {
    status.el.hidden = true;
    status.set({text: '', action: null});
  };

  const picker = InstrumentPicker({
    value: profile,
    labelledBy: titleId,
    onChange: next => {
      touched = true;
      profile = next;
      renderActions();
    },
  });

  const continueButton = Button({label: COPY.welcome.continue, variant: 'primary', size: 'lg', className: 'onboarding-welcome-continue',
    onClick: () => save()});
  const skipButton = Button({label: COPY.welcome.skip, variant: 'quiet', size: 'lg', className: 'onboarding-welcome-skip',
    onClick: () => skip()});

  function renderActions() {
    const none = !profile.instruments.length;
    continueButton.set({
      busy: saving ? COPY.welcome.saving : false,
      disabled: saving || none,
      disabledReason: !saving && none ? COPY.welcome.chooseFirst : null,
    });
    skipButton.set({disabled: saving});
    picker.set({disabled: saving});
  }

  function leave() {
    if (left) return;
    left = true;
    router?.navigate('/', {replace: true});
  }

  async function save() {
    if (saving || left || !profile.instruments.length) return;
    saving = true;
    // Retry lives in the status, which hides now: keep focus on the screen (Continue stays
    // focusable while busy, through aria-disabled).
    if (status.el.contains(doc.activeElement)) continueButton.el.focus({preventScroll: true});
    hideFailure();
    renderActions();
    try {
      await account.patch({profile: picker.value, onboarding: {whatDoYouPlay: 'done'}});
    } catch (err) {
      saving = false;
      if (left) return;
      console.warn('[welcome] the profile was not saved:', err?.message ?? err);
      renderActions();
      showFailure();
      return;
    }
    saving = false;
    leave();
  }

  // Writes 'skipped' only over an unanswered flag, and only once the account's settings are known:
  // before settings.config arrives, account.value is the defaults, and the server merges onboarding
  // key by key, so writing then could replace a 'done' given on another device.
  function markSkipped() {
    if (account.value.peek()?.onboarding?.whatDoYouPlay) return;
    account.markOnboarding('whatDoYouPlay', 'skipped')
      .catch(err => console.warn('[welcome] "skipped" was not saved; first run will ask again:', err?.message ?? err));
  }

  function skip() {
    if (saving || left) return;
    if (account.loaded.peek()) markSkipped();
    else {
      // Leave now; write once the settings arrive (the account module outlives this view).
      const off = account.loaded.subscribe(isLoaded => {
        if (!isLoaded) return;
        off();
        markSkipped();
      });
    }
    leave();
  }

  // Follow the account's profile until the user makes a choice here.
  const offProfile = account.profile.subscribe(next => {
    if (touched || saving) return;
    profile = normaliseProfile(next);
    picker.set({value: profile});
    renderActions();
  });

  const title = h('h1', {class: 'onboarding-welcome-title', attrs: {id: titleId, tabindex: '-1'}}, COPY.welcome.title);
  const page = h('section', {class: 'onboarding-welcome', attrs: {'aria-labelledby': titleId}},
    h('p', {class: 'onboarding-wordmark'}, COPY.wordmark),
    title,
    h('p', {class: 'onboarding-welcome-body'}, COPY.welcome.body),
    picker.el,
    status.el,
    h('div', {class: 'onboarding-welcome-actions'}, continueButton.el, skipButton.el));
  const scroller = h('div', {class: 'onboarding-welcome-scroller', attrs: {'data-scroller': true}}, page);
  el.replaceChildren(scroller);
  renderActions();

  const previousTitle = doc.title;
  doc.title = COPY.welcome.documentTitle;
  title.focus({preventScroll: true});

  return {
    update() {},
    unmount() {
      left = true;
      offProfile();
      picker.destroy();
      continueButton.destroy();
      skipButton.destroy();
      status.destroy();
      scroller.remove();
      if (doc.title === COPY.welcome.documentTitle) doc.title = previousTitle;
    },
  };
}
