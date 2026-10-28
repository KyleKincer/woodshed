// @vitest-environment happy-dom
// ON1: the sign-in card, /welcome "What do you play?" and the InstrumentPicker
// (architecture §2.19, §9.8 ON1; spec §6.6.1–6.6.3).
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {renderSignIn, signInMessage} from '../src/onboarding/signin.js';
import {InstrumentPicker, normaliseProfile, withInstruments} from '../src/onboarding/instruments.js';
import {mount as mountWelcome} from '../src/onboarding/welcome.js';
import {CONTROL_CONTEXTS, CONTROLS, COPY, INSTRUMENT_LABELS, PRIMARY_BADGE} from '../src/onboarding/onboarding.copy.js';
import {AuthError, OAUTH_MESSAGES, oauthError} from '../src/app/auth.js';
import {createAccount} from '../src/app/account.js';
import {ApiError} from '../src/api/client.js';
import {signal} from '../src/app/store.js';
import {INSTRUMENTS} from '../src/app/profile.js';
import {routes} from '../src/app/routes.js';
import {mergeSettings, withDefaults} from '../convex/lib/presets.ts';

// ---------------------------------------------------------------------------------------------
// helpers

const collapse = s => s.replace(/\s+/g, ' ').trim();
const isHidden = el => !!el.closest('[hidden], [aria-hidden=true]');
/** The accessible name: aria-label, else aria-labelledby, else the exposed text (element children are separate words). */
function accName(el) {
  if (el.hasAttribute('aria-label')) return collapse(el.getAttribute('aria-label'));
  if (el.hasAttribute('aria-labelledby')) {
    return collapse(el.getAttribute('aria-labelledby').split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' '));
  }
  const walk = node => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1 || node.hidden || node.getAttribute('aria-hidden') === 'true') return '';
    return ` ${[...node.childNodes].map(walk).join('')} `;
  };
  return collapse(walk(el));
}
const roleOf = el => el.getAttribute('role') ?? (el.matches('a[href]') ? 'link' : el.matches('button') ? 'button'
  : el.matches('select') ? 'combobox' : el.matches('input, textarea') ? 'textbox' : null);
/** Every control exposed to assistive tech. */
const exposedControls = root => [...root.querySelectorAll('a[href], button, input, select, textarea, [role=button], [role=radio], [role=checkbox], [role=link]')]
  .filter(el => !isHidden(el));
const byRole = (root, role, name) => exposedControls(root).filter(el => roleOf(el) === role && (name === undefined || accName(el) === name));
const button = (root, name) => {
  const found = byRole(root, 'button', name);
  if (found.length !== 1) throw new Error(`expected one button "${name}", found ${found.length}: ${exposedControls(root).map(accName).join(' | ')}`);
  return found[0];
};
const chip = (root, instrument) => root.querySelectorAll('.onboarding-instruments-chips .ui-chip-main')[INSTRUMENTS.indexOf(instrument)];
const tap = el => el.click();
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
// happy-dom's PageTransitionEvent ignores `persisted`, so it is set by hand.
const pageshow = persisted => Object.defineProperty(new Event('pageshow'), 'persisted', {value: persisted});
const alertOf = root => [...root.querySelectorAll('[role=alert]')].find(el => !isHidden(el)) ?? null;

function host() {
  const el = document.createElement('main');
  document.body.append(el);
  return el;
}

/** The real account controller over an in-memory settings store; `fail` failures first. */
function fakeAccount({settings = {}, fail = 0, hold = false} = {}) {
  const store = {config: signal(null), account: signal(withDefaults(settings)), pendingAccount: signal(null)};
  const patches = [];
  const waiting = [];
  const api = {
    subscribeConfig: () => () => {},
    patch: vi.fn(async partial => {
      patches.push(JSON.parse(JSON.stringify(partial)));
      if (hold) await new Promise(resolve => waiting.push(resolve));
      if (fail > 0) { fail -= 1; throw new ApiError({code: 'network', message: 'offline'}); }
      const merged = mergeSettings(withDefaults(store.account.peek()), partial);
      store.account.value = merged;
      return merged;
    }),
  };
  const account = createAccount({store, api, toast: () => {}});
  return {account, store, api, patches, release: () => { for (const r of waiting.splice(0)) r(); }};
}

const fakeRouter = () => ({navigate: vi.fn()});
const WELCOME_MATCH = {name: 'welcome', path: '/welcome', params: {}, query: {}};

let warn;
beforeEach(() => {
  document.body.replaceChildren();
  document.title = 'Woodshed';
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

// ---------------------------------------------------------------------------------------------
// copy (spec §6.6.1–6.6.2, exact)

describe('copy (spec §6.6)', () => {
  test('the sign-in card copy is spec §6.6.1 exactly', () => {
    expect(COPY.signin.title).toBe('Practise along with any song');
    expect(COPY.signin.lines.map(l => l.text)).toEqual([
      'Split any song into drums, bass, vocals and more',
      'Loop the hard part, slow it down, take your part out',
      'Read drum charts that follow the recording',
    ]);
    expect(COPY.signin.continue).toBe('Continue with Google');
    expect(COPY.signin.finePrint).toBe('New here? This creates your free account. Adding songs uses the free desktop app (Mac, Windows, Linux). Practising works everywhere, including iPad.');
    expect(COPY.wordmark).toBe('Woodshed');
  });

  test('every sign-in line icon is in the sprite', () => {
    const sprite = readFileSync(`${process.cwd()}/src/styles/icons.svg`, 'utf8');
    for (const line of COPY.signin.lines) expect(sprite, line.icon).toContain(`id="i-${line.icon}"`);
  });

  test('"What do you play?" copy is spec §6.6.2 exactly', () => {
    expect(COPY.welcome.title).toBe('What do you play?');
    expect(COPY.welcome.body).toBe('Woodshed can take your part out of the mix so you can play it, and picks the right stems when you add songs.');
    expect(COPY.picker.openWithLabel).toBe('When you open a song:');
    expect([COPY.picker.hearEverything, COPY.picker.partOut]).toEqual(['Hear everything', 'Start with my part out']);
    expect(Object.keys(INSTRUMENT_LABELS)).toEqual(INSTRUMENTS);
    expect(Object.values(INSTRUMENT_LABELS)).toEqual(['Drums', 'Bass', 'Guitar', 'Keys', 'Vocals', 'Other']);
    expect(COPY.welcome.saveFailed).toBe('Couldn’t save');
    expect(COPY.welcome.retry).toBe('Retry');
  });
});

// ---------------------------------------------------------------------------------------------
// CONTROLS (the table-driven test, §9.0)

describe('CONTROLS: every row renders with its role and accessible name, and nothing else', () => {
  const renderers = {
    signin: async () => {
      const el = host();
      renderSignIn(el, {error: null, signIn: vi.fn()});
      return el;
    },
    welcome: async () => {
      const el = host();
      mountWelcome(el, WELCOME_MATCH, {router: fakeRouter(), account: fakeAccount().account});
      return el;
    },
    'welcome-fail': async () => {
      const el = host();
      mountWelcome(el, WELCOME_MATCH, {router: fakeRouter(), account: fakeAccount({fail: 1}).account});
      tap(chip(el, 'drums'));
      tap(button(el, 'Continue'));
      await vi.waitFor(() => expect(alertOf(el)).not.toBeNull());
      return el;
    },
    picker: async () => {
      const el = host();
      el.append(InstrumentPicker({value: null, onChange: vi.fn()}).el);
      return el;
    },
  };

  test('every context has a renderer', () => {
    expect(Object.keys(renderers)).toEqual([...CONTROL_CONTEXTS]);
    expect(new Set(CONTROLS.map(r => r.context))).toEqual(new Set(CONTROL_CONTEXTS));
  });

  test.each(CONTROL_CONTEXTS)('%s', async context => {
    const root = await renderers[context]();
    const rows = CONTROLS.filter(r => r.context === context);
    for (const row of rows) expect(byRole(root, row.role, row.name), `${row.role} "${row.name}"`).toHaveLength(1);
    const exposed = exposedControls(root).map(el => `${roleOf(el)} ${accName(el)}`);
    expect(exposed.sort()).toEqual(rows.map(r => `${r.role} ${r.name}`).sort());
  });
});

// ---------------------------------------------------------------------------------------------
// sign-in (spec §6.6.1)

describe('renderSignIn (§2.19, spec §6.6.1)', () => {
  test('the card: wordmark, title heading, three lines with 20 px icons, a 48 px (lg) primary button, fine print', () => {
    const el = host();
    const view = renderSignIn(el, {signIn: vi.fn()});
    const scroller = el.querySelector('[data-scroller]');
    expect(scroller).toBe(view.el);
    expect(el.querySelectorAll('[data-scroller]')).toHaveLength(1);
    const card = el.querySelector('section.onboarding-signin');
    expect(card.querySelector('.onboarding-wordmark').textContent).toBe('Woodshed');
    const h1 = card.querySelector('h1');
    expect(h1.textContent).toBe(COPY.signin.title);
    expect(card.getAttribute('aria-labelledby')).toBe(h1.id);
    const items = [...card.querySelectorAll('.onboarding-signin-lines li')];
    expect(items.map(li => li.textContent)).toEqual(COPY.signin.lines.map(l => l.text));
    for (const [i, li] of items.entries()) {
      const svg = li.querySelector('svg');
      expect([svg.getAttribute('width'), svg.getAttribute('height')]).toEqual(['20', '20']);
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.querySelector('use').getAttribute('href')).toBe(`#i-${COPY.signin.lines[i].icon}`);
    }
    const continueButton = button(el, 'Continue with Google');
    expect(continueButton.dataset.variant).toBe('primary');
    expect(continueButton.dataset.size).toBe('lg');
    expect(card.querySelector('.onboarding-signin-fine').textContent).toBe(COPY.signin.finePrint);
    expect(document.title).toBe(COPY.signin.documentTitle);
  });

  test('there is no theme picker (the theme follows the system)', () => {
    const el = host();
    renderSignIn(el, {signIn: vi.fn()});
    expect(el.querySelectorAll('select, input, [role=radiogroup], [role=radio], [role=switch]')).toHaveLength(0);
    expect(el.textContent).not.toMatch(/theme|light|dark|system/i);
    expect(exposedControls(el)).toHaveLength(1);
  });

  test('without an error there is no alert', () => {
    const el = host();
    renderSignIn(el, {error: null, signIn: vi.fn()});
    expect(alertOf(el)).toBeNull();
  });

  // Today's sign-in copy (1.9 src/js/auth.js), per OAuth flow error code.
  const TODAY = [
    ['access_denied', 'Sign-in was canceled. You can try again.'],
    ['expired', 'This sign-in link expired. Please sign in again.'],
    ['invalid_flow', 'Sign-in must finish in the same browser where it started. Please try again here.'],
    ['oauth_error', 'Google sign-in could not finish. Please try again.'],
    ['unverified', 'Your session could not be verified. Sign in again.'],
    ['start_failed', 'Could not start Google sign-in. Check your connection and try again.'],
  ];

  test.each(TODAY)('AuthError{kind: oauth, code: %s} shows today\'s message', (code, message) => {
    expect(OAUTH_MESSAGES[code]).toBe(message);
    // Thrown by auth.initialize() (oauthError) and as main.js passes it on.
    const el = host();
    renderSignIn(el, {error: oauthError({code}), signIn: vi.fn()});
    expect(alertOf(el).textContent).toBe(message);
    // Built without a message (the AuthError default would be the network sentence): still today's copy.
    expect(signInMessage(new AuthError({kind: 'oauth', code}))).toBe(message);
  });

  test('a rejected sign-in shows the backend\'s own message; without one, the fallback', () => {
    expect(signInMessage(oauthError({code: 'rejected', message: 'Woodshed is invite-only right now.'}))).toBe('Woodshed is invite-only right now.');
    expect(signInMessage({kind: 'oauth', code: 'rejected', message: ''})).toBe('Sign-in could not finish. Please try again.');
  });

  test('an unknown code or a bare {message} shows its message; nothing at all shows the fallback', () => {
    expect(signInMessage({message: 'This sign-in link expired. Please sign in again.'})).toBe('This sign-in link expired. Please sign in again.');
    expect(signInMessage({kind: 'oauth', code: 'brand_new', message: 'Something new.'})).toBe('Something new.');
    expect(signInMessage({kind: 'oauth', code: 'fallback'})).toBe(OAUTH_MESSAGES.fallback);
    expect(signInMessage({})).toBe(OAUTH_MESSAGES.fallback);
    expect(signInMessage(null)).toBeNull();
    expect(signInMessage(undefined)).toBeNull();
  });

  test('Continue with Google runs signIn with "Opening Google…" and stays busy after a started sign-in', async () => {
    let finish;
    const signIn = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const el = host();
    renderSignIn(el, {error: oauthError({code: 'expired'}), signIn});
    const b = button(el, 'Continue with Google');
    tap(b);
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(b.getAttribute('aria-busy')).toBe('true');
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(b.textContent).toContain('Opening Google…');
    expect(alertOf(el)).toBeNull();   // the old error leaves when a new attempt starts
    tap(b);
    expect(signIn).toHaveBeenCalledTimes(1);   // no second start while busy
    finish();
    await flush();
    // Resolved = the page is being sent to Google: still busy, and a second press starts nothing.
    expect(b.getAttribute('aria-busy')).toBe('true');
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(b.textContent).toContain('Opening Google…');
    tap(b);
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(alertOf(el)).toBeNull();
    // Focus coming back does nothing on the web (only desktop re-arms that way).
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    expect(b.getAttribute('aria-disabled')).toBe('true');
    // A plain pageshow (not from the bfcache) does nothing either.
    window.dispatchEvent(pageshow(false));
    expect(b.getAttribute('aria-disabled')).toBe('true');
  });

  test('back from Google without finishing (bfcache pageshow), Continue with Google is back', async () => {
    const signIn = vi.fn().mockResolvedValue(undefined);
    const el = host();
    renderSignIn(el, {signIn});
    const b = button(el, 'Continue with Google');
    tap(b);
    await flush();
    expect(b.getAttribute('aria-busy')).toBe('true');
    window.dispatchEvent(pageshow(true));
    expect(b.getAttribute('aria-busy')).toBeNull();
    expect(b.getAttribute('aria-disabled')).toBeNull();
    expect(accName(b)).toBe('Continue with Google');
    tap(b);
    expect(signIn).toHaveBeenCalledTimes(2);
  });

  test('desktop: the button re-arms when the window regains focus after the system browser took it', async () => {
    window.woodshedDesktop = {};
    try {
      const signIn = vi.fn().mockResolvedValue(undefined);
      const el = host();
      renderSignIn(el, {signIn});
      const b = button(el, 'Continue with Google');
      tap(b);
      await flush();
      expect(b.getAttribute('aria-disabled')).toBe('true');
      window.dispatchEvent(new Event('blur'));   // the system browser opens
      expect(b.getAttribute('aria-disabled')).toBe('true');
      window.dispatchEvent(new Event('focus'));  // the user comes back without finishing
      expect(b.getAttribute('aria-busy')).toBeNull();
      expect(b.getAttribute('aria-disabled')).toBeNull();
      tap(b);
      expect(signIn).toHaveBeenCalledTimes(2);
    } finally {
      delete window.woodshedDesktop;
    }
  });

  test('destroy() after a started sign-in stops listening for the return', async () => {
    const el = host();
    const view = renderSignIn(el, {signIn: vi.fn().mockResolvedValue(undefined)});
    const b = button(el, 'Continue with Google');
    tap(b);
    await flush();
    const remove = vi.spyOn(window, 'removeEventListener');
    view.destroy();
    expect(remove.mock.calls.map(c => c[0])).toContain('pageshow');
    remove.mockRestore();
  });

  test('a failed start shows its mapped message; a non-AuthError means sign-in could not start', async () => {
    const el = host();
    const signIn = vi.fn()
      .mockRejectedValueOnce(new AuthError({kind: 'oauth', code: 'start_failed', message: OAUTH_MESSAGES.start_failed}))
      .mockRejectedValueOnce(oauthError({code: 'rejected', message: 'Not on the list.'}))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderSignIn(el, {signIn});
    const b = button(el, 'Continue with Google');
    tap(b);
    await vi.waitFor(() => expect(alertOf(el)?.textContent).toBe(OAUTH_MESSAGES.start_failed));
    expect(b.getAttribute('aria-disabled')).toBeNull();
    tap(b);
    await vi.waitFor(() => expect(alertOf(el)?.textContent).toBe('Not on the list.'));
    tap(b);
    await vi.waitFor(() => expect(alertOf(el)?.textContent).toBe(OAUTH_MESSAGES.start_failed));
  });

  test('a network AuthError from signIn shows its own sentence', async () => {
    const el = host();
    renderSignIn(el, {signIn: vi.fn().mockRejectedValue(new AuthError({kind: 'network', message: 'Woodshed could not reach its server. Check your connection and try again.'}))});
    tap(button(el, 'Continue with Google'));
    await vi.waitFor(() => expect(alertOf(el)?.textContent).toBe('Woodshed could not reach its server. Check your connection and try again.'));
  });

  test('destroy() removes the card and restores the document title; a late failure is ignored', async () => {
    let fail;
    const el = host();
    const view = renderSignIn(el, {signIn: () => new Promise((_, reject) => { fail = reject; })});
    tap(button(el, 'Continue with Google'));
    view.destroy();
    expect(el.children).toHaveLength(0);
    expect(document.title).toBe('Woodshed');
    fail(new Error('late'));
    await flush();
    expect(el.children).toHaveLength(0);
    view.destroy();   // twice is harmless
  });

  test('main.js renders this card for a signed-out boot (its contract call)', () => {
    const main = readFileSync(`${process.cwd()}/src/app/main.js`, 'utf8');
    expect(main).toContain("import.meta.glob('../onboarding/signin.js')");
    expect(main).toMatch(/render\(el, \{error: error \?\? null, signIn: \(\) => auth\.signIn\(\)\}\)/);
  });
});

// ---------------------------------------------------------------------------------------------
// InstrumentPicker (§2.19)

describe('normaliseProfile and withInstruments', () => {
  test('normaliseProfile keeps known instruments once, in order, with a valid primary and open-with choice', () => {
    expect(normaliseProfile(null)).toEqual({instruments: [], primary: null, openWithMyPart: 'in'});
    expect(normaliseProfile({instruments: ['bass', 'kazoo', 'bass', 'drums'], primary: 'drums', openWithMyPart: 'out'}))
      .toEqual({instruments: ['bass', 'drums'], primary: 'drums', openWithMyPart: 'out'});
    expect(normaliseProfile({instruments: ['keys', 'vocals'], primary: 'drums', openWithMyPart: 'sideways'}))
      .toEqual({instruments: ['keys', 'vocals'], primary: 'keys', openWithMyPart: 'in'});
    expect(normaliseProfile({instruments: 'drums'})).toEqual({instruments: [], primary: null, openWithMyPart: 'in'});
  });

  test('withInstruments: the first chosen is primary; it stays while chosen; removing it hands it to the earliest left', () => {
    let p = withInstruments(null, ['guitar']);
    expect(p.primary).toBe('guitar');
    p = withInstruments(p, ['guitar', 'drums', 'vocals']);
    expect(p).toEqual({instruments: ['guitar', 'drums', 'vocals'], primary: 'guitar', openWithMyPart: 'in'});
    p = withInstruments(p, ['drums', 'vocals']);
    expect(p.primary).toBe('drums');
    p = withInstruments({...p, openWithMyPart: 'out'}, []);
    expect(p).toEqual({instruments: [], primary: null, openWithMyPart: 'out'});
  });
});

describe('InstrumentPicker (§2.19)', () => {
  function picker(props = {}) {
    const onChange = vi.fn();
    const p = InstrumentPicker({onChange, ...props});
    const el = host();
    el.append(p.el);
    return {p, el, onChange};
  }

  test('six 56 px instrument chips in a named group, then "When you open a song:" as a radiogroup', () => {
    const {el} = picker();
    const group = el.querySelector('.onboarding-instruments-chips');
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('What do you play?');
    expect(group.dataset.multiple).toBe('');
    const chips = [...group.querySelectorAll('.ui-chip-main')];
    expect(chips.map(accName)).toEqual(['Drums', 'Bass', 'Guitar', 'Keys', 'Vocals', 'Other']);
    expect(chips.every(c => c.getAttribute('aria-pressed') === 'false')).toBe(true);
    const radios = el.querySelector('[role=radiogroup]');
    expect(accName(radios)).toBe('When you open a song:');
    expect(byRole(el, 'radio').map(r => [accName(r), r.getAttribute('aria-checked')]))
      .toEqual([['Hear everything', 'true'], ['Start with my part out', 'false']]);
    const css = readFileSync(`${process.cwd()}/src/styles/views/onboarding/instruments.css`, 'utf8');
    expect(css).toMatch(/\.onboarding-instruments-chips \.ui-chip \{[^}]*min-height: 56px/);
  });

  test('the first tapped becomes primary; more taps keep it; untapping it moves the badge', () => {
    const {el, onChange, p} = picker();
    tap(chip(el, 'bass'));
    expect(onChange).toHaveBeenLastCalledWith({instruments: ['bass'], primary: 'bass', openWithMyPart: 'in'}, {change: 'instruments'});
    expect(accName(chip(el, 'bass'))).toBe(`Bass ${PRIMARY_BADGE}`);
    expect(chip(el, 'bass').getAttribute('aria-pressed')).toBe('true');
    tap(chip(el, 'drums'));
    tap(chip(el, 'keys'));
    expect(onChange).toHaveBeenLastCalledWith({instruments: ['bass', 'drums', 'keys'], primary: 'bass', openWithMyPart: 'in'}, {change: 'instruments'});
    expect(el.querySelectorAll('.ui-chip-badge')).toHaveLength(1);
    tap(chip(el, 'bass'));
    expect(p.value).toEqual({instruments: ['drums', 'keys'], primary: 'drums', openWithMyPart: 'in'});
    expect(accName(chip(el, 'drums'))).toBe(`Drums ${PRIMARY_BADGE}`);
    expect(accName(chip(el, 'bass'))).toBe('Bass');
    tap(chip(el, 'drums'));
    tap(chip(el, 'keys'));
    expect(p.value).toEqual({instruments: [], primary: null, openWithMyPart: 'in'});
    expect(el.querySelectorAll('.ui-chip-badge')).toHaveLength(0);
  });

  test('the open-with-my-part choice', () => {
    const {el, onChange} = picker({value: {instruments: ['drums']}});
    tap(byRole(el, 'radio', 'Start with my part out')[0]);
    expect(onChange).toHaveBeenLastCalledWith({instruments: ['drums'], primary: 'drums', openWithMyPart: 'out'}, {change: 'openWithMyPart'});
    tap(byRole(el, 'radio', 'Hear everything')[0]);
    expect(onChange).toHaveBeenLastCalledWith({instruments: ['drums'], primary: 'drums', openWithMyPart: 'in'}, {change: 'openWithMyPart'});
  });

  test('value comes in normalised; set({value}) re-renders without onChange; value is a copy', () => {
    const {el, onChange, p} = picker({value: {instruments: ['vocals', 'guitar'], primary: 'guitar', openWithMyPart: 'out'}});
    expect(accName(chip(el, 'guitar'))).toBe(`Guitar ${PRIMARY_BADGE}`);
    expect(byRole(el, 'radio', 'Start with my part out')[0].getAttribute('aria-checked')).toBe('true');
    p.set({value: {instruments: ['keys']}});
    expect(onChange).not.toHaveBeenCalled();
    expect(p.value).toEqual({instruments: ['keys'], primary: 'keys', openWithMyPart: 'in'});
    expect(chip(el, 'vocals').getAttribute('aria-pressed')).toBe('false');
    p.value.instruments.push('drums');
    expect(p.value.instruments).toEqual(['keys']);
  });

  test('labelledBy names the group by an outside heading; openWith: false hides the choice; mapping lists the stems', () => {
    const heading = document.createElement('h2');
    heading.id = 'instruments-heading';
    heading.textContent = 'Your instruments';
    document.body.append(heading);
    const {el, p} = picker({labelledBy: 'instruments-heading', openWith: false, mapping: true, value: {instruments: ['guitar', 'drums']}});
    const group = el.querySelector('.onboarding-instruments-chips');
    expect(group.hasAttribute('aria-label')).toBe(false);
    expect(accName(group)).toBe('Your instruments');
    expect(el.querySelector('.onboarding-instruments-open').hidden).toBe(true);
    expect(byRole(el, 'radio')).toHaveLength(0);
    const lines = [...el.querySelectorAll('.onboarding-instruments-mapping li')].map(li => li.textContent);
    expect(lines).toEqual(['Guitar → guitar stem on 6-stem songs, otherwise Other', 'Drums → drums stem']);
    p.set({labelledBy: null, label: 'I play'});
    expect(group.getAttribute('aria-label')).toBe('I play');
    expect(group.hasAttribute('aria-labelledby')).toBe(false);
    p.set({value: {instruments: []}});
    expect(el.querySelector('.onboarding-instruments-mapping').hidden).toBe(true);
  });

  test('disabled refuses every change', () => {
    const {el, onChange, p} = picker({disabled: true});
    tap(chip(el, 'drums'));
    tap(byRole(el, 'radio', 'Start with my part out')[0]);
    expect(onChange).not.toHaveBeenCalled();
    expect(chip(el, 'drums').getAttribute('aria-disabled')).toBe('true');
    p.set({disabled: false});
    tap(chip(el, 'drums'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('destroy() removes it', () => {
    const {el, p} = picker();
    p.destroy();
    expect(el.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// /welcome (§2.19, D39; spec §6.6.2)

describe('/welcome', () => {
  function welcome(options = {}) {
    const fake = fakeAccount(options);
    const router = fakeRouter();
    const el = host();
    const view = mountWelcome(el, WELCOME_MATCH, {router, account: fake.account});
    return {...fake, router, el, view};
  }

  test('the route resolves to this view (no placeholder)', async () => {
    const route = routes.find(r => r.name === 'welcome');
    const mod = await route.view();
    expect(mod.mount).toBe(mountWelcome);
  });

  test('one scroller, the wordmark, the question as the focused heading, the copy, the picker, Continue and Skip', () => {
    const {el} = welcome();
    expect(el.querySelectorAll('[data-scroller]')).toHaveLength(1);
    expect(el.querySelector('.onboarding-wordmark').textContent).toBe('Woodshed');
    const h1 = el.querySelector('h1');
    expect(h1.textContent).toBe('What do you play?');
    expect(document.activeElement).toBe(h1);
    expect(el.querySelector('.onboarding-welcome-body').textContent).toBe(COPY.welcome.body);
    expect(accName(el.querySelector('.onboarding-instruments-chips'))).toBe('What do you play?');
    expect(button(el, 'Continue').dataset.variant).toBe('primary');
    expect(button(el, 'Skip').dataset.variant).toBe('quiet');
    expect(document.title).toBe(COPY.welcome.documentTitle);
  });

  test('Continue needs an instrument; its reason says so', () => {
    const {el, api} = welcome();
    const c = button(el, 'Continue');
    expect(c.getAttribute('aria-disabled')).toBe('true');
    expect(c.querySelector('.ui-button-reason').textContent).toBe(COPY.welcome.chooseFirst);
    tap(c);
    expect(api.patch).not.toHaveBeenCalled();
    tap(chip(el, 'drums'));
    expect(c.getAttribute('aria-disabled')).toBeNull();
    expect(c.querySelector('.ui-button-reason')).toBeNull();
  });

  test('Continue writes the profile and the onboarding flag, then replaces the URL with /', async () => {
    const {el, api, patches, router, account} = welcome();
    tap(chip(el, 'guitar'));
    tap(chip(el, 'drums'));
    tap(byRole(el, 'radio', 'Start with my part out')[0]);
    const c = button(el, 'Continue');
    tap(c);
    await vi.waitFor(() => expect(router.navigate).toHaveBeenCalledWith('/', {replace: true}));
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(patches[0]).toEqual({profile: {instruments: ['guitar', 'drums'], primary: 'guitar', openWithMyPart: 'out'}, onboarding: {whatDoYouPlay: 'done'}});
    expect(account.value.peek().onboarding.whatDoYouPlay).toBe('done');
    expect(account.profile.peek()).toEqual({instruments: ['guitar', 'drums'], primary: 'guitar', openWithMyPart: 'out'});
    tap(c);   // leaving: nothing more happens until the router unmounts the view
    tap(button(el, 'Skip'));
    expect(router.navigate).toHaveBeenCalledTimes(1);
    expect(api.patch).toHaveBeenCalledTimes(1);
  });

  test('while saving, Continue reads "Saving…" and nothing can change; a second press does nothing', async () => {
    const {el, api, release, router} = welcome({hold: true});
    tap(chip(el, 'bass'));
    const c = button(el, 'Continue');
    tap(c);
    await flush();
    expect(c.getAttribute('aria-busy')).toBe('true');
    expect(c.textContent).toContain('Saving…');
    expect(c.querySelector('.ui-button-reason')).toBeNull();
    expect(chip(el, 'drums').getAttribute('aria-disabled')).toBe('true');
    expect(button(el, 'Skip').getAttribute('aria-disabled')).toBe('true');
    tap(c);
    tap(button(el, 'Skip'));
    expect(api.patch).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(router.navigate).toHaveBeenCalledTimes(1));
  });

  test('a failed save keeps the screen with "Couldn’t save · Retry"; Retry saves', async () => {
    const {el, api, router, account} = welcome({fail: 1});
    tap(chip(el, 'keys'));
    tap(button(el, 'Continue'));
    await vi.waitFor(() => expect(alertOf(el)).not.toBeNull());
    const alert = alertOf(el);
    expect(alert.querySelector('.ui-status-text').textContent).toBe('Couldn’t save');
    expect(router.navigate).not.toHaveBeenCalled();
    expect(account.value.peek().onboarding.whatDoYouPlay).toBeUndefined();   // the optimistic patch reverted
    expect(button(el, 'Continue').getAttribute('aria-disabled')).toBeNull();
    expect(chip(el, 'keys').getAttribute('aria-pressed')).toBe('true');   // the choice is kept
    expect(warn).toHaveBeenCalled();
    tap(button(el, 'Retry'));
    await vi.waitFor(() => expect(router.navigate).toHaveBeenCalledWith('/', {replace: true}));
    expect(api.patch).toHaveBeenCalledTimes(2);
    expect(alertOf(el)).toBeNull();
  });

  test('Retry keeps keyboard focus on the screen (Continue), and a second failure leaves it there', async () => {
    const {el, api} = welcome({fail: 2});
    tap(chip(el, 'keys'));
    tap(button(el, 'Continue'));
    await vi.waitFor(() => expect(alertOf(el)).not.toBeNull());
    const retry = button(el, 'Retry');
    retry.focus();
    expect(document.activeElement).toBe(retry);
    tap(retry);
    expect(document.activeElement).toBe(el.querySelector('.onboarding-welcome-continue'));
    await vi.waitFor(() => expect(alertOf(el)).not.toBeNull());
    expect(api.patch).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(el.querySelector('.onboarding-welcome-continue'));
  });

  test('Skip marks "skipped" and leaves at once', async () => {
    const {el, patches, router, account} = welcome();
    tap(chip(el, 'drums'));
    tap(button(el, 'Skip'));
    expect(router.navigate).toHaveBeenCalledWith('/', {replace: true});
    await flush();
    expect(patches).toEqual([{onboarding: {whatDoYouPlay: 'skipped'}}]);   // the profile is not written
    expect(account.value.peek().onboarding.whatDoYouPlay).toBe('skipped');
    expect(account.profile.peek().instruments).toEqual([]);
  });

  test('Skip leaves even when the flag cannot be saved (first run asks again next time)', async () => {
    const {el, router, account} = welcome({fail: 1});
    tap(button(el, 'Skip'));
    expect(router.navigate).toHaveBeenCalledWith('/', {replace: true});
    await flush();
    await flush();
    expect(account.value.peek().onboarding.whatDoYouPlay).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  test('Skip before the account has loaded leaves at once, then writes only if the loaded flag is unset', async () => {
    // Loads with 'done' (answered on another device): nothing is written.
    const done = fakeAccount();
    done.store.account.value = null;
    const router = fakeRouter();
    const el = host();
    mountWelcome(el, WELCOME_MATCH, {router, account: done.account});
    tap(button(el, 'Skip'));
    expect(router.navigate).toHaveBeenCalledWith('/', {replace: true});
    await flush();
    expect(done.api.patch).not.toHaveBeenCalled();
    done.store.account.value = withDefaults({onboarding: {whatDoYouPlay: 'done'}});
    await flush();
    expect(done.api.patch).not.toHaveBeenCalled();
    expect(done.account.value.peek().onboarding.whatDoYouPlay).toBe('done');

    // Loads unanswered: 'skipped' is written then.
    document.body.replaceChildren();
    const fresh = fakeAccount();
    fresh.store.account.value = null;
    const el2 = host();
    const view = mountWelcome(el2, WELCOME_MATCH, {router: fakeRouter(), account: fresh.account});
    tap(button(el2, 'Skip'));
    view.unmount();   // the router leaves; the write still follows the load
    await flush();
    expect(fresh.api.patch).not.toHaveBeenCalled();
    fresh.store.account.value = withDefaults({});
    await vi.waitFor(() => expect(fresh.patches).toEqual([{onboarding: {whatDoYouPlay: 'skipped'}}]));
  });

  test('Skip never downgrades an answer already given', async () => {
    const {el, api, router} = welcome({settings: {onboarding: {whatDoYouPlay: 'done'}, profile: {instruments: ['vocals']}}});
    tap(button(el, 'Skip'));
    expect(router.navigate).toHaveBeenCalledTimes(1);
    await flush();
    expect(api.patch).not.toHaveBeenCalled();
  });

  test('an existing profile is pre-chosen, and followed until the user touches the picker', async () => {
    const {el, store} = welcome({settings: {profile: {instruments: ['vocals', 'keys'], primary: 'keys', openWithMyPart: 'out'}}});
    expect(chip(el, 'vocals').getAttribute('aria-pressed')).toBe('true');
    expect(accName(chip(el, 'keys'))).toBe(`Keys ${PRIMARY_BADGE}`);
    expect(byRole(el, 'radio', 'Start with my part out')[0].getAttribute('aria-checked')).toBe('true');
    expect(button(el, 'Continue').getAttribute('aria-disabled')).toBeNull();
    // Another device answers first.
    store.account.value = withDefaults({profile: {instruments: ['bass'], primary: 'bass'}});
    expect(chip(el, 'bass').getAttribute('aria-pressed')).toBe('true');
    expect(chip(el, 'vocals').getAttribute('aria-pressed')).toBe('false');
    tap(chip(el, 'drums'));
    store.account.value = withDefaults({profile: {instruments: ['other']}});
    expect(chip(el, 'other').getAttribute('aria-pressed')).toBe('false');
    expect(chip(el, 'drums').getAttribute('aria-pressed')).toBe('true');
  });

  test('unmount removes the view, stops following the account and restores the title; a late save does not navigate', async () => {
    const {el, view, store, release, router} = welcome({hold: true});
    tap(chip(el, 'drums'));
    tap(button(el, 'Continue'));
    view.unmount();
    expect(el.children).toHaveLength(0);
    expect(document.title).toBe('Woodshed');
    store.account.value = withDefaults({profile: {instruments: ['bass']}});
    release();
    await flush();
    await flush();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  test('the default account is the app account module', () => {
    const source = readFileSync(`${process.cwd()}/src/onboarding/welcome.js`, 'utf8');
    expect(source).toContain("import {account as appAccount} from '../app/account.js'");
    expect(source).toContain('ctx.account ?? appAccount');
  });
});
