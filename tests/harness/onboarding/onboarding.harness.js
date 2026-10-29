// ON1's harness (/__harness/onboarding): the first-run screens on the real modules
// (architecture §9.8 ON1; spec §6.6.1–6.6.3). States: tests/fixture/states/ON1.cjs.
//   ?part=signin    the sign-in card in the bare full-bleed frame main.js renders it into
//                     error=<code>        an AuthError{kind: 'oauth', code} as main.js passes it
//                                         (expired, access_denied, invalid_flow, oauth_error,
//                                         unverified; rejected carries "Your account is not allowed.")
//                     signin=fail|hang    Continue's signIn throws (sign-in could not start) · never
//                                         settles (the "Opening Google…" state); default: resolves
//   ?part=welcome   the /welcome view mounted by its route contract over the real account controller
//                   (createAccount) on an in-memory settings store, with a recording router
//                     profile=a,b         the account's profile instruments (in order); out=1 openWithMyPart 'out'
//                     fail=1              the first settings.patch fails (offline)
//                     slow=1              settings.patch waits for window.__onboarding.answer()
//                     done=1              onboarding.whatDoYouPlay is already 'done'
//   ?part=picker    the InstrumentPicker alone (as Settings → Instruments uses it)
//                     profile=a,b · mapping=1 (the plain-words stem mapping) · openWith=0 (no open-with row)
// window.__onboarding = {log, patches, navigations, settings(), answer()} for states.
import {signal} from '/src/app/store.js';
import {ApiError} from '/src/api/client.js';
import {AuthError} from '/src/app/auth.js';
import {createAccount} from '/src/app/account.js';
import {mergeSettings, withDefaults} from '/convex/lib/presets.ts';
import {renderSignIn} from '/src/onboarding/signin.js';
import {mount as mountWelcome} from '/src/onboarding/welcome.js';
import {InstrumentPicker} from '/src/onboarding/instruments.js';

const list = value => (value ? value.split(',').filter(Boolean) : []);

/** The bare full-bleed frame main.js gives the sign-in card and full-bleed views. */
function bare(el, h) {
  el.style.padding = '0';
  const main = h('main', {class: 'app-main', style: {height: '100%'}});
  const app = h('div', {class: 'app-frame', dataset: {chrome: 'none'}}, main);
  el.replaceChildren(app);
  return main;
}

function signinPart(el, h, query) {
  const code = query.get('error');
  const error = code
    ? new AuthError({kind: 'oauth', code, message: code === 'rejected' ? 'Your account is not allowed.' : undefined})
    : null;
  const mode = query.get('signin');
  const log = [];
  const signIn = () => {
    log.push('signIn');
    if (mode === 'fail') return new Promise((_, reject) => setTimeout(() => reject(new AuthError({kind: 'oauth', code: 'start_failed'})), 200));
    if (mode === 'hang') return new Promise(() => {});
    return Promise.resolve();
  };
  const card = renderSignIn(bare(el, h), {error, signIn});
  window.__onboarding = {log, card};
  return card;
}

function welcomePart(el, h, query) {
  const log = [], patches = [], navigations = [];
  let failures = query.get('fail') === '1' ? 1 : 0;
  const slow = query.get('slow') === '1';
  const pending = [];
  const saved = {profile: {instruments: list(query.get('profile')), openWithMyPart: query.get('out') === '1' ? 'out' : 'in'}};
  if (query.get('done') === '1') saved.onboarding = {whatDoYouPlay: 'done'};
  const store = {config: signal(null), account: signal(withDefaults(saved)), pendingAccount: signal(null)};
  const api = {
    subscribeConfig: () => () => {},
    async patch(partial) {
      log.push('patch');
      patches.push(JSON.parse(JSON.stringify(partial)));
      if (slow) await new Promise(resolve => pending.push(resolve));
      if (failures > 0) {
        failures -= 1;
        throw new ApiError({code: 'network', message: 'Woodshed could not reach its server.'});
      }
      const merged = mergeSettings(withDefaults(store.account.peek()), partial);
      store.account.value = merged;
      return merged;
    },
  };
  const account = createAccount({store, api, toast: () => {}});
  const router = {navigate(to, opts = {}) { log.push('navigate'); navigations.push({to, replace: !!opts.replace}); }};
  const outlet = bare(el, h);
  const view = mountWelcome(outlet, {name: 'welcome', path: '/welcome', params: {}, query: {}}, {router, account});
  window.__onboarding = {
    log, patches, navigations, view,
    settings: () => JSON.parse(JSON.stringify(store.account.peek())),
    answer: () => { for (const resolve of pending.splice(0)) resolve(); },
  };
  return view;
}

function pickerPart(el, h, query) {
  const changes = [];
  const picker = InstrumentPicker({
    value: {instruments: list(query.get('profile')), openWithMyPart: query.get('out') === '1' ? 'out' : 'in'},
    mapping: query.get('mapping') === '1',
    openWith: query.get('openWith') !== '0',
    onChange: (profile, info) => changes.push({profile, ...info}),
  });
  const page = h('div', {attrs: {'data-scroller': true}},
    h('div', {class: 'app-content', style: {paddingBlock: 'var(--s6)'}},
      h('h1', {style: {fontSize: 'var(--fs-24)', marginBottom: 'var(--s4)'}}, 'Instruments'),
      picker.el));
  el.replaceChildren(page);
  window.__onboarding = {changes, picker};
  return picker;
}

export default async function mount(el, {query, h}) {
  const part = query.get('part') ?? 'signin';
  switch (part) {
    case 'signin': return signinPart(el, h, query);
    case 'welcome': return welcomePart(el, h, query);
    case 'picker': return pickerPart(el, h, query);
    default: throw new Error(`onboarding harness: unknown part ${part}`);
  }
}
