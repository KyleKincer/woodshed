// ON1's states: sign-in, "What do you play?" and the InstrumentPicker (architecture §9.8 ON1,
// §10.3; spec §6.6.1–6.6.3).
//
// The onboarding harness (/__harness/onboarding):
//   on1-signin            the sign-in card: 400 px card, title, three lines with 20 px icons, the 48 px
//                         button (56 on coarse pointers), no theme picker, no alert; targets and focus
//   on1-signin-opening    Continue with Google → "Opening Google…" (busy, disabled)
//   on1-signin-failed     a sign-in that cannot start: today's "Could not start Google sign-in…" alert
//   on1-signin-error      each OAuth error code shows today's message (expired is captured)
//   on1-welcome           first run: 56 px chips, the first tapped is primary, the open-with choice,
//                         Continue writes {profile, onboarding.whatDoYouPlay: 'done'} and replaces with /
//   on1-welcome-keys      the same by keyboard only (Tab, Space), with the focus ring on every stop
//   on1-welcome-saving    Continue while the save is in flight: "Saving…", every control refuses
//   on1-welcome-fail      the save fails: "Couldn't save · Retry"; Retry saves and leaves
//   on1-welcome-skip      Skip marks 'skipped' and leaves at once
//   on1-welcome-prefill   an existing profile (another device) is pre-chosen
//   on1-picker-settings   the picker as Settings → Instruments shows it: the stem mapping in plain words
// The app on the fixture database:
//   on1-app-signin        signed out → ON1's card (not the placeholder); Continue cannot start on the
//                         fixture → today's message; no top bar
//   on1-app-signin-error  fx-signinError=expired → today's expired message in the card
//   on1-app-welcome       fx-account=new → /welcome (ON1's view); Guitar + Keys, "Start with my part out",
//                         Continue → / with the profile and the flag in the database; a reload stays home
//   on1-app-skip          fx-account=new → Skip → / with onboarding.whatDoYouPlay 'skipped'
// The Library (LB1a, same wave) is reached through the view resolver (D2), so it is the placeholder until
// it merges: those states allow the placeholder.
'use strict';

const {checkTargets} = require('../probes/probe-targets.cjs');
const {walkFocus} = require('../probes/probe-focus.cjs');

const BASE = '/__harness/onboarding';
const PLACEHOLDER_OK = {placeholder: true};

const TODAY = {
  access_denied: 'Sign-in was canceled. You can try again.',
  expired: 'This sign-in link expired. Please sign in again.',
  invalid_flow: 'Sign-in must finish in the same browser where it started. Please try again here.',
  oauth_error: 'Google sign-in could not finish. Please try again.',
  unverified: 'Your session could not be verified. Sign in again.',
  start_failed: 'Could not start Google sign-in. Check your connection and try again.',
};
const INSTRUMENTS = ['Drums', 'Bass', 'Guitar', 'Keys', 'Vocals', 'Other'];

async function expectTargets(t, page, where = 'page') {
  const problems = await checkTargets(page);
  t.expect(!problems.length, `targets (${where}): ${JSON.stringify(problems)}`);
}

async function expectFocus(t, page) {
  const problems = await walkFocus(page, {stops: 20});
  t.expect(!problems.length, `focus rings: ${JSON.stringify(problems)}`);
}

/** Runs in the page: the sign-in card's geometry and contents. */
function signinFacts() {
  const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; };
  const card = document.querySelector('.onboarding-signin');
  const button = document.querySelector('.onboarding-signin-button');
  const icons = [...card.querySelectorAll('.onboarding-signin-line svg')].map(box);
  const alert = [...document.querySelectorAll('[role=alert]')].find(el => el.checkVisibility());
  return {
    card: box(card), vw: innerWidth, vh: innerHeight, button: box(button), icons,
    coarse: matchMedia('(pointer: coarse)').matches,
    lines: [...card.querySelectorAll('.onboarding-signin-line')].map(li => li.textContent),
    title: card.querySelector('h1')?.textContent,
    themeControls: document.querySelectorAll('select, input, [role=radiogroup], [role=radio], [role=switch]').length,
    themeText: /theme/i.test(document.body.textContent),
    controls: [...document.querySelectorAll('button, a[href], [role=button]')].filter(el => el.checkVisibility()).length,
    alert: alert ? alert.textContent : null,
    scrollers: document.querySelectorAll('[data-scroller]:not(#harness)').length,
  };
}

/** Runs in the page: the welcome screen's chips. */
function welcomeFacts() {
  const chips = [...document.querySelectorAll('.onboarding-instruments-chips .ui-chip')];
  return {
    chips: chips.map(chip => {
      const r = chip.getBoundingClientRect();
      const main = chip.querySelector('.ui-chip-main');
      return {h: Math.round(r.height), w: Math.round(r.width), pressed: main.getAttribute('aria-pressed'), badge: chip.querySelector('.ui-chip-badge')?.textContent ?? null};
    }),
    focused: document.activeElement?.tagName,
    title: document.title,
    scrollers: document.querySelectorAll('[data-scroller]:not(#harness)').length,
    column: Math.round(document.querySelector('.onboarding-welcome').getBoundingClientRect().width),
  };
}

const onboarding = page => page.evaluate(() => {
  const o = window.__onboarding;
  return {log: o.log, patches: o.patches, navigations: o.navigations, settings: o.settings?.()};
});

async function checkSignin(page, t) {
  const f = await page.evaluate(signinFacts);
  t.expect(f.title === 'Practise along with any song', `title "${f.title}"`);
  t.expect(JSON.stringify(f.lines) === JSON.stringify([
    'Split any song into drums, bass, vocals and more',
    'Loop the hard part, slow it down, take your part out',
    'Read drum charts that follow the recording',
  ]), `lines ${JSON.stringify(f.lines)}`);
  t.expect(f.card.w <= 400 && f.card.w >= Math.min(400, f.vw - 32), `400 px card (${f.card.w})`);
  t.expect(Math.abs(f.card.x + f.card.w / 2 - f.vw / 2) <= 1, `centred horizontally ${JSON.stringify(f.card)}`);
  t.expect(f.icons.length === 3 && f.icons.every(b => b.w === 20 && b.h === 20), `20 px icons ${JSON.stringify(f.icons)}`);
  t.expect(f.button.h === (f.coarse ? 56 : 48), `the button is ${f.coarse ? 56 : 48} px (${f.button.h})`);
  t.expect(f.themeControls === 0 && !f.themeText, 'no theme picker');
  t.expect(f.scrollers === 1, 'one scroller');
  return f;
}

module.exports = [
  // ------------------------------------------------------------------ sign-in
  {
    name: 'on1-signin',
    url: `${BASE}?part=signin`,
    async fn(page, t) {
      const f = await checkSignin(page, t);
      t.expect(f.alert === null, 'no alert without an error');
      t.expect(f.controls === 1, `one control (${f.controls})`);
      t.expect(await page.getByRole('button', {name: 'Continue with Google'}).isVisible(), 'Continue with Google by role and name');
      await expectTargets(t, page);
      if (t.device === 'laptop') await expectFocus(t, page);
    },
  },
  {
    name: 'on1-signin-opening',
    url: `${BASE}?part=signin&signin=hang`,
    opts: {themes: ['light']},
    async fn(page, t) {
      const b = page.getByRole('button', {name: 'Continue with Google'});
      await b.click();
      await page.waitForSelector('.onboarding-signin-button[aria-busy=true]');
      const text = await page.locator('.onboarding-signin-button').textContent();
      t.expect(text.includes('Opening Google…'), `busy text (${text})`);
      t.expect(await page.locator('.onboarding-signin-button').getAttribute('aria-disabled') === 'true', 'disabled while opening');
      await page.locator('.onboarding-signin-button').click({force: true});
      t.expect(JSON.stringify((await page.evaluate(() => window.__onboarding.log))) === '["signIn"]', 'one start only');
    },
  },
  {
    name: 'on1-signin-failed',
    url: `${BASE}?part=signin&signin=fail`,
    opts: {themes: ['light']},
    async fn(page, t) {
      await page.getByRole('button', {name: 'Continue with Google'}).click();
      const alert = page.getByRole('alert');
      await alert.waitFor();
      t.expect((await alert.textContent()) === TODAY.start_failed, `today's start failure (${await alert.textContent()})`);
      t.expect(await page.locator('.onboarding-signin-button').getAttribute('aria-disabled') === null, 'Continue is back');
    },
  },
  {
    name: 'on1-signin-error',
    url: `${BASE}?part=signin&error=expired`,
    async fn(page, t) {
      await checkSignin(page, t);
      const text = await page.getByRole('alert').textContent();
      t.expect(text === TODAY.expired, `the expired message (${text})`);
      await expectTargets(t, page);
      if (t.device !== 'laptop' || t.theme !== 'light') return;
      // Every other code, on the same page (no capture).
      for (const [code, message] of Object.entries(TODAY)) {
        if (code === 'start_failed') continue;
        await page.goto(`${t.base}${BASE}?part=signin&error=${code}`);
        await t.ready('onboarding');
        const shown = await page.getByRole('alert').textContent();
        t.expect(shown === message, `${code}: "${shown}"`);
      }
      await page.goto(`${t.base}${BASE}?part=signin&error=rejected`);
      await t.ready('onboarding');
      t.expect((await page.getByRole('alert').textContent()) === 'Your account is not allowed.', 'rejected carries the backend\'s message');
      await page.goto(`${t.base}${BASE}?part=signin&error=expired`);
      await t.ready('onboarding');
    },
  },

  // ------------------------------------------------------------------ /welcome
  {
    name: 'on1-welcome',
    url: `${BASE}?part=welcome`,
    async fn(page, t) {
      let f = await page.evaluate(welcomeFacts);
      t.expect(f.chips.length === 6 && f.chips.every(c => c.h === 56), `56 px chips ${JSON.stringify(f.chips)}`);
      t.expect(f.focused === 'H1', 'the question has focus');
      t.expect(f.title === 'What do you play? — Woodshed', `document title "${f.title}"`);
      t.expect(f.scrollers === 1, 'one scroller');
      t.expect(f.column <= 560, `560 px column (${f.column})`);
      for (const name of INSTRUMENTS) t.expect(await page.getByRole('button', {name, exact: true}).count() === 1, `${name} chip`);
      t.expect(await page.getByRole('radiogroup', {name: 'When you open a song:'}).isVisible(), 'the open-with choice');
      const cont = page.getByRole('button', {name: 'Continue', exact: true});
      t.expect(await cont.getAttribute('aria-disabled') === 'true', 'Continue waits for a choice');
      t.expect((await cont.textContent()).includes('Choose what you play, or skip'), 'with its reason');
      await expectTargets(t, page, 'empty');
      await t.capture('empty');

      await page.getByRole('button', {name: 'Guitar', exact: true}).click();
      await page.getByRole('button', {name: 'Drums', exact: true}).click();
      f = await page.evaluate(welcomeFacts);
      t.expect(f.chips[2].badge === 'Primary' && f.chips[2].pressed === 'true', `Guitar (first tapped) is primary ${JSON.stringify(f.chips)}`);
      t.expect(f.chips[0].badge === null && f.chips[0].pressed === 'true', 'Drums is chosen, not primary');
      t.expect(await page.getByRole('button', {name: 'Guitar Primary', exact: true}).count() === 1, 'the primary chip is named with its badge');
      t.expect(f.chips.every(c => c.h === 56), 'chips keep 56 px with the badge');
      await page.getByRole('radio', {name: 'Start with my part out'}).click();
      await expectTargets(t, page, 'chosen');
      await t.capture('chosen');

      await cont.click();
      await page.waitForFunction(() => window.__onboarding.navigations.length === 1);
      const o = await onboarding(page);
      t.expect(JSON.stringify(o.patches) === JSON.stringify([{profile: {instruments: ['guitar', 'drums'], primary: 'guitar', openWithMyPart: 'out'}, onboarding: {whatDoYouPlay: 'done'}}]),
        `the patch ${JSON.stringify(o.patches)}`);
      t.expect(JSON.stringify(o.navigations) === JSON.stringify([{to: '/', replace: true}]), `replace('/') ${JSON.stringify(o.navigations)}`);
    },
  },
  {
    name: 'on1-welcome-keys',
    url: `${BASE}?part=welcome`,
    opts: {devices: ['laptop'], capture: false},
    async fn(page, t) {
      await expectFocus(t, page);
      await page.evaluate(() => document.querySelector('h1').focus());
      // Tab to Bass (the second chip), Space; Tab to Vocals, Space; Tab into the radiogroup, → for part out.
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Space');
      for (let i = 0; i < 3; i += 1) await page.keyboard.press('Tab');
      await page.keyboard.press('Space');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => document.activeElement.textContent.trim());
      t.expect(focused === 'Continue', `Tab reaches Continue (${focused})`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__onboarding.navigations.length === 1);
      const o = await onboarding(page);
      t.expect(JSON.stringify(o.patches[0].profile) === JSON.stringify({instruments: ['bass', 'vocals'], primary: 'bass', openWithMyPart: 'out'}),
        `keyboard profile ${JSON.stringify(o.patches)}`);
    },
  },
  {
    name: 'on1-welcome-saving',
    url: `${BASE}?part=welcome&slow=1&profile=drums`,
    opts: {themes: ['dark']},
    async fn(page, t) {
      const cont = page.getByRole('button', {name: 'Continue', exact: true});
      await cont.click();
      await page.waitForSelector('.onboarding-welcome-continue[aria-busy=true]');
      t.expect((await page.locator('.onboarding-welcome-continue').textContent()).includes('Saving…'), 'Saving…');
      t.expect(await page.locator('.onboarding-welcome-skip').getAttribute('aria-disabled') === 'true', 'Skip waits');
      await page.getByRole('button', {name: 'Bass', exact: true}).click({force: true});
      t.expect(await page.getByRole('button', {name: 'Bass', exact: true}).getAttribute('aria-pressed') === 'false', 'chips refuse changes');
      await t.capture('saving');
      await page.evaluate(() => window.__onboarding.answer());
      await page.waitForFunction(() => window.__onboarding.navigations.length === 1);
    },
  },
  {
    name: 'on1-welcome-fail',
    url: `${BASE}?part=welcome&fail=1&profile=keys`,
    async fn(page, t) {
      await page.getByRole('button', {name: 'Continue', exact: true}).click();
      const alert = page.getByRole('alert');
      await alert.waitFor();
      t.expect((await alert.textContent()).includes('Couldn’t save'), `the failure (${await alert.textContent()})`);
      t.expect((await onboarding(page)).navigations.length === 0, 'stays on the screen');
      await expectTargets(t, page, 'failed');
      await t.capture('failed');
      await page.getByRole('button', {name: 'Retry'}).click();
      await page.waitForFunction(() => window.__onboarding.navigations.length === 1);
      const o = await onboarding(page);
      t.expect(o.patches.length === 2 && o.settings.onboarding.whatDoYouPlay === 'done', `retried ${JSON.stringify(o.patches)}`);
    },
  },
  {
    name: 'on1-welcome-skip',
    url: `${BASE}?part=welcome`,
    opts: {capture: false, themes: ['light']},
    async fn(page, t) {
      await page.getByRole('button', {name: 'Skip', exact: true}).click();
      await page.waitForFunction(() => window.__onboarding.patches.length === 1);
      const o = await onboarding(page);
      t.expect(JSON.stringify(o.patches) === '[{"onboarding":{"whatDoYouPlay":"skipped"}}]', `skip patch ${JSON.stringify(o.patches)}`);
      t.expect(JSON.stringify(o.navigations) === '[{"to":"/","replace":true}]', 'replace(\'/\')');
    },
  },
  {
    name: 'on1-welcome-prefill',
    url: `${BASE}?part=welcome&profile=vocals,keys&out=1`,
    opts: {devices: ['ipad'], themes: ['light']},
    async fn(page, t) {
      const f = await page.evaluate(welcomeFacts);
      t.expect(f.chips[4].pressed === 'true' && f.chips[4].badge === 'Primary' && f.chips[3].pressed === 'true', `pre-chosen ${JSON.stringify(f.chips)}`);
      t.expect(await page.getByRole('radio', {name: 'Start with my part out'}).getAttribute('aria-checked') === 'true', 'part out');
      t.expect(await page.getByRole('button', {name: 'Continue', exact: true}).getAttribute('aria-disabled') === null, 'Continue is ready');
      await expectTargets(t, page);
    },
  },
  {
    name: 'on1-picker-settings',
    url: `${BASE}?part=picker&profile=guitar,drums&mapping=1`,
    async fn(page, t) {
      const lines = await page.locator('.onboarding-instruments-mapping li').allTextContents();
      t.expect(JSON.stringify(lines) === JSON.stringify(['Guitar → guitar stem on 6-stem songs, otherwise Other', 'Drums → drums stem']), `mapping ${JSON.stringify(lines)}`);
      await page.getByRole('button', {name: 'Keys', exact: true}).click();
      t.expect((await page.locator('.onboarding-instruments-mapping li').count()) === 3, 'the mapping follows the chips');
      await expectTargets(t, page);
    },
  },

  // ------------------------------------------------------------------ the app on the fixture
  {
    name: 'on1-app-signin',
    url: '/?fx-auth=signedout&fx-reset=1',
    opts: {ready: false},
    async fn(page, t) {
      await page.waitForSelector('html[data-startup=signin]');
      await checkSignin(page, t);
      t.expect(!(await page.locator('.shell-signin, [data-placeholder]').count()), 'ON1\'s card, not the placeholder');
      t.expect(!(await page.locator('.app-topbar').count()), 'no top bar');
      await expectTargets(t, page);
      await t.capture();
      // The fixture's OAuth cannot start: today's message.
      await page.getByRole('button', {name: 'Continue with Google'}).click();
      const alert = page.getByRole('alert');
      await alert.waitFor();
      t.expect((await alert.textContent()) === TODAY.start_failed, `start failure (${await alert.textContent()})`);
    },
  },
  {
    name: 'on1-app-signin-error',
    url: '/?fx-auth=signedout&fx-signinError=expired&fx-reset=1',
    opts: {ready: false, devices: ['laptop']},
    async fn(page, t) {
      await page.waitForSelector('html[data-startup=signin]');
      const text = await page.getByRole('alert').textContent();
      t.expect(text === TODAY.expired, `the expired message (${text})`);
    },
  },
  {
    name: 'on1-app-welcome',
    url: '/?fx-account=new&fx-reset=1',
    opts: {ready: 'welcome', structure: PLACEHOLDER_OK},
    async fn(page, t) {
      const facts = await page.evaluate(() => ({path: location.pathname, chrome: document.getElementById('app').dataset.chrome,
        placeholder: !!document.querySelector('[data-placeholder]'), banners: document.querySelector('.shell-banners')?.hidden}));
      t.expect(facts.path === '/welcome' && facts.chrome === 'none' && !facts.placeholder, `ON1's /welcome ${JSON.stringify(facts)}`);
      await expectTargets(t, page);
      await page.getByRole('button', {name: 'Guitar', exact: true}).click();
      await page.getByRole('button', {name: 'Keys', exact: true}).click();
      await page.getByRole('radio', {name: 'Start with my part out'}).click();
      await t.capture('chosen');
      await page.getByRole('button', {name: 'Continue', exact: true}).click();
      await t.ready('library');
      const after = await page.evaluate(() => ({path: location.pathname, idx: history.state.idx, settings: window.fixture.db().settings}));
      t.expect(after.path === '/', `home (${after.path})`);
      t.expect(after.idx === 1, `replaced, not pushed (idx ${after.idx})`);
      t.expect(JSON.stringify(after.settings.profile) === JSON.stringify({instruments: ['guitar', 'keys'], primary: 'guitar', openWithMyPart: 'out'}),
        `stored profile ${JSON.stringify(after.settings.profile)}`);
      t.expect(after.settings.onboarding?.whatDoYouPlay === 'done', `stored flag ${JSON.stringify(after.settings.onboarding)}`);
      // The answer sticks: a reload boots to the Library, not /welcome.
      await page.reload();
      await t.ready('library');
      t.expect(await page.evaluate(() => location.pathname) === '/', 'a reload stays home');
    },
  },
  {
    name: 'on1-app-skip',
    url: '/?fx-account=new&fx-reset=1',
    opts: {ready: 'welcome', structure: PLACEHOLDER_OK, capture: false, devices: ['ipad'], themes: ['dark']},
    async fn(page, t) {
      await page.getByRole('button', {name: 'Skip', exact: true}).click();
      await t.ready('library');
      await page.waitForFunction(() => window.fixture.db().settings?.onboarding?.whatDoYouPlay === 'skipped');
      const after = await page.evaluate(() => ({path: location.pathname, settings: window.fixture.db().settings}));
      t.expect(after.path === '/', `home (${after.path})`);
      t.expect((after.settings.profile?.instruments ?? []).length === 0, 'no profile written');
    },
  },
];
