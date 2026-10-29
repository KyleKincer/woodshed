// SH1's states: the Share dialog, the Shared Stage and the demo (architecture §2.18, §9 SH1; spec §6.1, §4.13, §6.6).
//
// The Share dialog:
//   sh1-dialog-stage-menu        /s/glasshouse: Stage ⋯ → Share… opens "Share Glasshouse" on its active link (seeded),
//                                with the stored choices; Copy link writes the URL (VITE_SHARE_ORIGIN, else this origin)
//                                and reads "Copied ✓" for 2 s; targets
//   sh1-dialog-create-stop       the harness (/__harness/share?song=lowtide&session=1; Low Tide has no link and no chart):
//                                Drum chart off with its reason; Create link flushes the session (final), then shows the
//                                read-only link, Copy link and "A new link replaces the old one."; Stop sharing asks
//                                "Stop sharing? The link stops working for everyone." (captured -stop-confirm), then
//                                the link is gone from the database; the final capture is a new link
// The Shared Stage (/share/<fixture token>, a boot route; the fixture's share token is Glasshouse's):
//   sh1-shared-stage             every boot step ran; the Stage read-only with "Shared by Kyle K." and Add to my
//                                library; Space plays (the wake lock is requested, a toast holds while playing); ?
//                                opens the shortcut sheet; ⌘K the palette with no song or navigation groups; the ⋯
//                                menu has no Edit rows (captured -menu)
//   sh1-shared-stage-pedals      pedals and MIDI started at boot step 7: with pedal mode and a MIDI binding on, the
//                                virtual pad's note plays and the right pedal stops
//   sh1-shared-stage-signedout   a signed-out visitor: Sign in to keep a copy
//   sh1-shared-stage-add         a change says "Changes stay on this device until you add the song to your library."
//                                once and is kept on this device under the token; Add to my library opens the copy
//                                (/s/glasshouse-copy) with that practice
//   sh1-shared-stage-unavailable fx-share=missing: "This link doesn’t work any more." with Open Woodshed
// The demo:
//   sh1-demo                     library.demo (Open example) → /share/<demo token> (Paper Lanterns) with Minus me
//                                from the profile (drums), as the first-run card promises
'use strict';

const {checkTargets} = require('../probes/probe-targets.cjs');

const SHARE_TOKEN = 'a3f1'.repeat(16);
const DEMO_TOKEN = 'dec0'.repeat(16);
const NOW = 'fx-now=2026-10-28T12:00:00Z';
const app = (p, query = '') => `${p}?fx-reset=1&${NOW}${query ? `&${query}` : ''}`;
const SHARED = `/share/${SHARE_TOKEN}`;
const REQUIRES = ['src/share/share-dialog.js', 'src/share/shared-stage.js', 'src/stage/hud.js', 'src/stage/menus.js'];
const STAGE = {requires: REQUIRES, ready: 'stage'};
const SHARE = {requires: REQUIRES, ready: 'share'};
const enc = (value) => encodeURIComponent(JSON.stringify(value));
const PEDALS = {enabled: true, profile: 'practice', custom: {}, pedals: [
  {slot: 'left', code: 'KeyB', canHold: true}, {slot: 'right', code: 'KeyN', canHold: true},
]};
const MIDI = {enabled: true, bindings: [{type: 'note', number: 36, command: 'transport.playStop'}]};

/** Runs in the page: the open Share dialog's facts. */
function dialogFacts() {
  const d = document.querySelector('dialog.share-dialog[open]');
  if (!d) return null;
  const text = (sel) => d.querySelector(sel)?.textContent.replace(/\s+/g, ' ').trim() ?? null;
  const shown = (sel) => { const el = d.querySelector(sel); return !!el && el.checkVisibility(); };
  const boxes = [...d.querySelectorAll('.share-check-input')];
  return {
    title: text('.ui-dialog-title'), lead: text('.share-lead'),
    choices: [...d.querySelectorAll('.share-check')].map((l) => l.textContent.trim()),
    checked: boxes.map((b) => b.checked), disabled: boxes.map((b) => b.disabled),
    chartNote: text('.share-check-note'),
    link: d.querySelector('.share-link-input')?.value ?? null, linkReadOnly: d.querySelector('.share-link-input')?.readOnly ?? null,
    linkShown: shown('.share-link'), createShown: shown('.share-create'),
    copy: text('.share-copy .ui-button-label') ?? text('.share-copy'), note: text('.share-link .share-note'),
    stopShown: shown('.share-stop'), width: Math.round(d.getBoundingClientRect().width),
    focused: document.activeElement?.className ?? null,
  };
}

/** Runs in the page: the Shared Stage's identity row and the session. */
function stageFacts() {
  const root = document.documentElement;
  const session = window.__woodshed?.activeSession();
  return {
    place: root.dataset.place, posture: root.dataset.posture, ready: root.dataset.viewReady,
    steps: window.__woodshedShare?.steps ?? null,
    shared: document.querySelector('.hud-shared, [class*="hud-shared"]')?.textContent.trim()
      ?? [...document.querySelectorAll('.hud-meta *')].map((n) => n.textContent.trim()).find((s) => s.startsWith('Shared by')) ?? null,
    action: document.querySelector('.hud-action-slot .share-action')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
    actionKind: document.querySelector('.hud-action-slot .share-action')?.dataset.shareAction ?? null,
    sessionId: session?.id ?? null,
    practice: session?.practice.value ?? null,
    status: document.querySelector('.stage-status')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
  };
}

async function openStageMenu(page) {
  await page.locator('.hud-more').first().click();
  await page.waitForSelector('[role=menu]', {state: 'visible'});
  return page.evaluate(() => [...document.querySelectorAll('[role=menu] .ui-menu-label')].map((n) => n.textContent.trim()));
}

async function expectTargets(t, page) {
  const targets = await checkTargets(page);
  t.expect(!targets.length, `targets: ${JSON.stringify(targets)}`);
}

module.exports = [
  // ------------------------------------------------------------------ the Share dialog
  {
    name: 'sh1-dialog-stage-menu',
    url: app('/s/glasshouse'),
    opts: STAGE,
    async fn(page, t) {
      await t.loadPhase('ready');
      const rows = await openStageMenu(page);
      t.expect(rows.includes('Share…'), `the ⋯ menu has Share… (${rows})`);
      await page.locator('[role=menu] [role=menuitem]', {hasText: 'Share…'}).click();
      await page.waitForSelector('dialog.share-dialog[open] .share-link:not([hidden])');
      const f = await page.evaluate(dialogFacts);
      t.expect(f.title === 'Share Glasshouse', `title (${f.title})`);
      t.expect(f.lead === 'Anyone with the link can listen and practise along. They can save their own copy.', `body (${f.lead})`);
      t.expect(JSON.stringify(f.choices) === '["Sections and tempo map","Drum chart"]', `choices ${JSON.stringify(f.choices)}`);
      t.expect(f.checked[0] === true && f.checked[1] === true, `the link's stored choices ${JSON.stringify(f.checked)}`);
      const url = `${t.base}/share/${SHARE_TOKEN}`;
      t.expect(f.link === url && f.linkReadOnly, `the read-only link (${f.link})`);
      t.expect(f.note === 'A new link replaces the old one.' && f.stopShown && !f.createShown, 'note and Stop sharing, no Create link');
      t.expect(f.width <= 480 && f.width >= 320, `the 480 px dialog (${f.width})`);
      t.expect(/share-copy/.test(f.focused ?? ''), `focus on Copy link (${f.focused})`);
      await page.locator('dialog.share-dialog .share-copy').click();
      await page.waitForFunction(() => /Copied ✓/.test(document.querySelector('dialog.share-dialog .share-copy')?.textContent ?? ''));
      t.expect(await page.evaluate(() => window.fixture.clipboard.text()) === url, 'Copy link wrote the URL');
      await expectTargets(t, page);
      await t.capture('copied');
      await page.waitForFunction(() => /Copy link/.test(document.querySelector('dialog.share-dialog .share-copy')?.textContent ?? ''),
        null, {timeout: 4000});
      t.expect(true, '"Copied ✓" reverts to Copy link after 2 s');
    },
  },
  {
    name: 'sh1-dialog-create-stop',
    url: '/__harness/share?song=lowtide&session=1&fx-reset=1',
    opts: {requires: REQUIRES},
    async fn(page, t) {
      await page.waitForSelector('dialog.share-dialog[open] .share-create:not([aria-disabled=true])');
      let f = await page.evaluate(dialogFacts);
      t.expect(f.title === 'Share Low Tide Static' || /^Share /.test(f.title), `title (${f.title})`);
      t.expect(f.checked[0] === true && f.checked[1] === false && f.disabled[1] === true, `☑ map ☐ chart (disabled) ${JSON.stringify(f)}`);
      t.expect(f.chartNote === 'This song has no drum chart yet.', `the chart's reason (${f.chartNote})`);
      t.expect(!f.linkShown && f.createShown, 'Create link, no link yet');
      await expectTargets(t, page);
      await page.locator('dialog.share-dialog .share-create').click();
      await page.waitForSelector('dialog.share-dialog .share-link:not([hidden])');
      f = await page.evaluate(dialogFacts);
      const share = await page.evaluate(() => window.fixture.db().shares.lowtide ?? null);
      t.expect(!!share && f.link === `${t.base}/share/${share.token}`, `the new link (${f.link})`);
      t.expect(share.includeMap === true && share.includeNotation === false, `the choices sent ${JSON.stringify(share)}`);
      t.expect(JSON.stringify(await page.evaluate(() => window.__share.flushes)) === '[{"final":true}]', 'the session was flushed (final) first');
      await page.locator('dialog.share-dialog .share-stop').click();
      await page.waitForSelector('dialog.ui-dialog[open]:not(.share-dialog)');
      const confirm = await page.evaluate(() => {
        const d = [...document.querySelectorAll('dialog.ui-dialog[open]')].find((x) => !x.classList.contains('share-dialog'));
        return d?.textContent.replace(/\s+/g, ' ').trim() ?? '';
      });
      t.expect(confirm.includes('Stop sharing?') && confirm.includes('The link stops working for everyone.'), `the confirm (${confirm})`);
      await t.capture('stop-confirm');
      await page.locator('dialog.ui-dialog[open]:not(.share-dialog) button', {hasText: 'Stop sharing'}).click();
      await page.waitForSelector('dialog.share-dialog .share-create:not([hidden])');
      t.expect(await page.evaluate(() => window.fixture.db().shares.lowtide ?? null) === null, 'the link is gone');
      t.expect(/share-create/.test(await page.evaluate(() => document.activeElement?.className ?? '')), 'focus back on Create link');
      await page.locator('dialog.share-dialog .share-create').click();
      await page.waitForSelector('dialog.share-dialog .share-link:not([hidden])');
    },
  },

  // ------------------------------------------------------------------ the Shared Stage
  {
    name: 'sh1-shared-stage',
    url: app(SHARED),
    opts: SHARE,
    async fn(page, t) {
      await t.loadPhase('ready');
      const f = await page.evaluate(stageFacts);
      t.expect(JSON.stringify(f.steps) === JSON.stringify(['common', 'root', 'auth', 'store', 'commands', 'palette', 'starters', 'router', 'view', 'mount']),
        `every boot step ran in order (${f.steps})`);
      t.expect(f.place === 'stage' && f.posture === 'stage', `the Stage place and posture (${f.place}/${f.posture})`);
      t.expect(f.shared === 'Shared by Kyle K.', `identity (${f.shared})`);
      t.expect(f.action === 'Add to my library' && f.actionKind === 'add', `the action (${f.action})`);
      t.expect(f.sessionId === 'shared', `the shared session (${f.sessionId})`);
      t.expect(!(await page.evaluate(() => window.__woodshed.commands.isEnabled('edit.open'))), 'edit.open is off');
      t.expect(!(await page.evaluate(() => window.__woodshed.commands.isEnabled('stage.share'))), 'stage.share is off');
      await expectTargets(t, page);

      // ⋯: no Edit rows (spec §4.13).
      const rows = await openStageMenu(page);
      t.expect(!rows.some((r) => /^Edit/.test(r)), `no Edit rows (${rows})`);
      await t.capture('menu');
      await page.keyboard.press('Escape');
      await page.waitForSelector('[role=menu]', {state: 'hidden'});

      // ? and ⌘K.
      await page.keyboard.press('Shift+Slash');
      await page.waitForSelector('dialog.app-shortcuts[open]');
      await page.keyboard.press('Escape');
      await page.waitForSelector('dialog.app-shortcuts[open]', {state: 'detached'});
      const mod = t.device === 'ipad' || process.platform === 'darwin' ? 'Meta' : 'Control';   // the iPad platform is Apple's
      await page.keyboard.press(`${mod}+KeyK`);
      await page.waitForSelector('dialog.app-palette[open]');
      const groups = await page.evaluate(() => [...document.querySelectorAll('dialog.app-palette [role=option]')].map((o) => o.textContent));
      t.expect(groups.length > 0 && !groups.some((g) => /Glasshouse|Low Tide|Settings…/.test(g)), `no songs or navigation in the palette (${groups.length})`);
      await page.keyboard.press('Escape');
      await page.waitForSelector('dialog.app-palette[open]', {state: 'detached'});

      // Space plays; the wake lock is requested; a toast holds while playing.
      await page.locator('body').click({position: {x: 2, y: 2}}).catch(() => {});
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.keyboard.press('Space');
      await t.transportPhase('playing');
      await page.waitForFunction(() => window.fixture.wakeLock.state().requests > 0, null, {timeout: 5000});
      const held = await page.evaluate(async () => {
        const fb = await import('/src/app/feedback.js');
        window.__sh1Toast = fb.toast('Held while playing');
        await new Promise((r) => setTimeout(r, 100));
        return {state: fb.toastState(), playing: window.__woodshed.store.stage.value?.playing};
      });
      t.expect(held.playing === true && held.state.held && held.state.visible === null, `the toast holds while playing ${JSON.stringify(held)}`);
      await page.keyboard.press('Shift+Space');
      await page.waitForFunction(() => document.documentElement.dataset.transportPhase !== 'playing', null, {timeout: 5000});
      await page.evaluate(() => window.__sh1Toast?.dismiss?.());
    },
  },
  {
    name: 'sh1-shared-stage-pedals',
    url: app(SHARED, `fx-prefs=${enc({pedals: PEDALS, midi: MIDI})}`),
    opts: {...SHARE, requires: [...REQUIRES, 'src/app/pedals.js', 'src/app/midi.js'], themes: ['light'], capture: false},
    async fn(page, t) {
      await t.loadPhase('ready');
      const playing = (on) => page.waitForFunction((v) => window.__woodshed.store.stage.value?.playing === v, on, {timeout: 5000});
      await page.waitForFunction(() => window.fixture.midi.state().requests > 0, null, {timeout: 5000});
      await page.evaluate(() => window.fixture.midi.note(36, 110));   // the pad: Play
      await playing(true);
      await page.keyboard.press('n');                                  // the right pedal (tap): Play/Stop
      await playing(false);
      t.expect(true, 'MIDI and the pedals reach the Shared Stage');
    },
  },
  {
    name: 'sh1-shared-stage-signedout',
    url: app(SHARED, 'fx-auth=signedout'),
    opts: SHARE,
    async fn(page, t) {
      await t.loadPhase('ready');
      const f = await page.evaluate(stageFacts);
      t.expect(f.action === 'Sign in to keep a copy' && f.actionKind === 'signin', `the action (${f.action})`);
      t.expect(f.shared === 'Shared by Kyle K.', `identity (${f.shared})`);
      await expectTargets(t, page);
    },
  },
  {
    name: 'sh1-shared-stage-add',
    url: app(SHARED),
    opts: {...SHARE, devices: ['laptop', 'ipad'], themes: ['light']},
    async fn(page, t) {
      await t.loadPhase('ready');
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.keyboard.press('Period');   // Faster (+5%)
      await page.waitForFunction(() => /Changes stay on this device until you add the song to your library\./
        .test(document.querySelector('.stage-status')?.textContent ?? ''), null, {timeout: 5000});
      await t.capture('notice');
      await page.evaluate(() => window.__woodshed.idle());
      const local = await page.evaluate((token) => JSON.parse(localStorage.getItem(`ws.share.${token}`) ?? 'null'), SHARE_TOKEN);
      t.expect(local && Math.abs(local.rate - 1.05) < 1e-6, `kept on this device under the token (${local?.rate})`);
      const server = await page.evaluate(() => window.fixture.db().songPractice.find((r) => r.songId === 'glasshouse')?.practice?.rate ?? null);
      t.expect(server !== 1.05, 'the sharer’s practice is untouched');
      // A second change says nothing new.
      await page.keyboard.press('Period');
      await page.locator('.hud-action-slot .share-action').click();
      await page.waitForURL('**/s/glasshouse-copy**', {timeout: 15000});
      await t.ready('stage');
      await t.loadPhase('ready');
      const copy = await page.evaluate(() => ({
        rate: window.fixture.db().songPractice.find((r) => r.songId === 'glasshouse-copy')?.practice?.rate ?? null,
        session: window.__woodshed.activeSession()?.practice.value?.rate ?? null,
      }));
      t.expect(Math.abs(copy.rate - 1.1) < 1e-6, `the saved copy has this device's practice (${copy.rate})`);
      t.expect(await page.evaluate((token) => localStorage.getItem(`ws.share.${token}`), SHARE_TOKEN) === null, 'the device copy is cleared');
    },
  },
  {
    name: 'sh1-shared-stage-unavailable',
    url: app(SHARED, 'fx-share=missing'),
    opts: SHARE,
    async fn(page, t) {
      const text = await page.evaluate(() => document.querySelector('.share-page')?.textContent.replace(/\s+/g, ' ').trim() ?? '');
      t.expect(text.startsWith('This link doesn’t work any more.') && text.includes('Open Woodshed'), `the page (${text})`);
      await expectTargets(t, page);
    },
  },

  // ------------------------------------------------------------------ the demo
  {
    name: 'sh1-demo',
    url: app('/'),
    opts: {requires: [...REQUIRES, 'src/share/demo.js'], ready: 'library'},
    async fn(page, t) {
      t.expect(await page.evaluate(() => window.__woodshed.commands.isEnabled('library.demo')), 'library.demo is enabled');
      await page.evaluate(() => { void window.__woodshed.commands.run('library.demo'); });
      await page.waitForURL(`**/share/${DEMO_TOKEN}`, {timeout: 15000});
      await t.ready('share');
      await t.loadPhase('ready');
      await page.waitForFunction(() => window.__woodshed.activeSession()?.practice.value?.minusMe === true, null, {timeout: 5000});
      const f = await page.evaluate(stageFacts);
      const muted = (f.practice?.tracks ?? []).filter((x) => x.muted).map((x) => x.name);
      t.expect(muted.includes('drums'), `Minus me from the profile: drums out (${JSON.stringify(f.practice?.tracks)})`);
      t.expect(f.shared === 'Shared by Kyle K.', `identity (${f.shared})`);
    },
  },
];
