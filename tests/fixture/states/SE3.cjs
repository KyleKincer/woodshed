// SE3's states: Administration (spec §6.4; architecture §10.4 "SE3 (every section, web and desktop)").
// Harness states run the real views on /__harness/admin (tests/harness/settings/admin.harness.js) with a
// stateful admin backend; the se3-app-* states run the full app's /admin routes on the fixture's own
// admin handlers (fx-admin=1).
//   se3-admin                 overview cards, policy form, accounts, audit history; targets and focus rings
//   se3-admin-search          ?email= prefilled: one exact match; then a miss and Show all
//   se3-admin-more            Load more on accounts and on the history
//   se3-policy-dialog         the Reason dialog for a policy change
//   se3-policy-saved          a policy change goes through: cards, fields and history follow
//   se3-account               an account: header, access, storage, notes, computers, jobs, history
//   se3-account-admin         an administrator's account: the restricting options disabled with the reason
//   se3-access-dialog         Export only → the Reason dialog (danger)
//   se3-reason-short          a 2-character reason is refused at the field; nothing is saved
//   se3-access-saved          Export only with a reason: the access, toast and history follow
//   se3-revoke                Revoke… a computer: it reads "Revoked by an administrator"
//   se3-cancel-job            Cancel… the bot-check-waiting job: it reads Cancelled
//   se3-override-saved        a 2 GB storage override
//   se3-notes-dialog          the notes edit and its Reason dialog
//   se3-save-refused          the server refuses the change: the dialog stays open with its message
//   se3-dialog-busy           the dialog while the change runs (actions inert)
//   se3-account-missing       an id that does not exist
//   se3-account-bad-id        an id the server's validator refuses reads as not found
//   se3-account-load-error    the first load fails: Retry recovers
//   se3-account-empty         no computers, jobs or history
//   se3-app-admin             the full app at /admin (fx-admin=1), web and desktop
//   se3-app-back              the full app: open an account, Back returns to /admin with its row focused and
//                             history.state.idx one lower
'use strict';

const {checkTargets} = require('../probes/probe-targets.cjs');
const {walkFocus} = require('../probes/probe-focus.cjs');

const H = '/__harness/admin';
const BASE = 'fx-reset=1&fx-now=2026-10-28T12:00:00Z';
const ACCOUNT = `${H}?${BASE}&page=account&id=user2`;

async function settle(page) {
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter(a => Number.isFinite(a.effect?.getComputedTiming?.().endTime ?? Infinity))
    .map(a => a.finished.catch(() => {}))));
}

async function expectTargets(t, page) {
  await settle(page);
  const problems = await checkTargets(page);
  t.expect(!problems.length, `targets: ${JSON.stringify(problems)}`);
}

/** Runs in the page: what an administrator reads. */
function facts() {
  const text = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
  const shown = el => !!el && !el.closest('[hidden]');
  const dialog = document.querySelector('dialog.admin-reason-dialog');
  return {
    title: text(document.querySelector('.admin-title')),
    cards: [...document.querySelectorAll('.admin-cards .admin-card-value')].map(text),
    policy: [...document.querySelectorAll('.admin-policy input')].map(i => i.value),
    accounts: [...document.querySelectorAll('.admin-account-link')].filter(shown).map(a => a.dataset.focusKey),
    accountsEmpty: text([...document.querySelectorAll('.admin-accounts-box .admin-empty')].find(shown)),
    audit: [...document.querySelectorAll('.admin-audit-row .admin-audit-title')].map(text),
    auditReasons: [...document.querySelectorAll('.admin-audit-row .admin-audit-reason')].map(text),
    more: [...document.querySelectorAll('.admin-more')].filter(shown).length,
    access: [...document.querySelectorAll('.admin-access [role=radio]')].map(r => ({name: text(r), checked: r.getAttribute('aria-checked'), disabled: r.getAttribute('aria-disabled')})),
    accessHelp: text(document.querySelector('#admin-access-help')),
    usage: text(document.querySelector('.admin-usage .admin-card-value')),
    override: document.querySelector('.admin-override-field input')?.value ?? null,
    devices: [...document.querySelectorAll('.admin-items')].at(0) ? [...[...document.querySelectorAll('.admin-items')][0].children].map(li => text(li.querySelector('.admin-item-meta'))) : [],
    jobs: [...document.querySelectorAll('.admin-items')].at(1) ? [...[...document.querySelectorAll('.admin-items')][1].children].map(li => text(li.querySelector('.admin-item-meta'))) : [],
    dialog: dialog ? {
      title: text(dialog.querySelector('.ui-dialog-title')), body: text(dialog.querySelector('.ui-dialog-body:not([hidden])')),
      error: text(dialog.querySelector('.ui-dialog-error:not([hidden])')), fieldError: text(dialog.querySelector('.ui-dialog-field-error:not([hidden])')),
      busy: dialog.hasAttribute('data-busy'), actions: [...dialog.querySelectorAll('.ui-dialog-action')].map(b => `${text(b)}:${b.dataset.variant}`),
      focused: document.activeElement?.name ?? null,
    } : null,
    toast: text(document.querySelector('.ui-toast')),
    alert: text([...document.querySelectorAll('.admin-load-error')].find(shown)),
  };
}

const waitText = (page, selector, text, timeout = 5000) =>
  page.waitForFunction(([s, x]) => [...document.querySelectorAll(s)].some(n => n.textContent.includes(x)), [selector, text], {timeout});

module.exports = [
  {
    name: 'se3-admin',
    url: `${H}?${BASE}`,
    async fn(page, t) {
      const f = await page.evaluate(facts);
      t.expect(f.title === 'Administration', `title ${f.title}`);
      t.expect(JSON.stringify(f.cards) === JSON.stringify(['61.2 GB of 200 GB', '1.0 GB', '200 GB']), `cards ${f.cards}`);
      t.expect(JSON.stringify(f.policy) === '["1","150"]', `policy fields ${f.policy}`);
      t.expect(f.accounts.join() === 'account:user4,account:user3,account:user2,account:user1', `accounts ${f.accounts}`);
      t.expect(f.audit[0] === 'Storage policy changed' && f.audit.length === 4, `history ${f.audit}`);
      t.expect(f.auditReasons[0].endsWith('by you'), `the signed-in administrator reads as you (${f.auditReasons[0]})`);
      await expectTargets(t, page);
      if (t.device === 'laptop') {
        const focus = await walkFocus(page, {stops: 16});
        t.expect(!focus.length, focus.join('; '));
      }
    },
  },
  {
    name: 'se3-admin-search',
    url: `${H}?${BASE}&email=dana@example.com`,
    async fn(page, t) {
      let f = await page.evaluate(facts);
      t.expect(f.accounts.join() === 'account:user2', `one exact match ${f.accounts}`);
      const field = page.getByRole('searchbox', {name: 'Find an account by exact email'});
      await field.fill('nobody@example.com');
      await field.press('Enter');
      await waitText(page, '.admin-accounts-box .admin-empty', 'No account uses nobody@example.com.');
      await t.capture('miss');
      await page.getByRole('button', {name: 'Show all'}).click();
      await page.waitForFunction(() => document.querySelectorAll('.admin-account-link').length === 4);
      f = await page.evaluate(facts);
      const log = await page.evaluate(() => window.__admin.router.log.filter(e => e[0] === 'setQuery').map(e => e[1].email));
      t.expect(JSON.stringify(log) === '["nobody@example.com",null]', `?email= mirrored with replace (${JSON.stringify(log)})`);
    },
  },
  {
    name: 'se3-admin-more',
    url: `${H}?${BASE}&many=1`,
    opts: {devices: ['laptop']},
    async fn(page, t) {
      let f = await page.evaluate(facts);
      t.expect(f.accounts.length === 25 && f.audit.length === 25 && f.more === 2, `first pages ${f.accounts.length}/${f.audit.length}/${f.more}`);
      await page.getByRole('button', {name: 'Load more'}).first().click();
      await page.waitForFunction(() => document.querySelectorAll('.admin-account-link').length === 50);
      await page.getByRole('button', {name: 'Load more'}).first().click();
      await page.waitForFunction(() => document.querySelectorAll('.admin-account-link').length === 60);
      await page.getByRole('button', {name: 'Load more'}).click();
      await page.waitForFunction(() => document.querySelectorAll('.admin-audit-row').length === 40);
      f = await page.evaluate(facts);
      t.expect(f.more === 0, 'nothing more to load');
    },
  },
  {
    name: 'se3-policy-dialog',
    url: `${H}?${BASE}&open=policy&reason=Launch%20week`,
    async fn(page, t) {
      const f = await page.evaluate(facts);
      t.expect(f.dialog?.title === 'Change the storage policy?', `dialog ${JSON.stringify(f.dialog)}`);
      t.expect(f.dialog.body === 'Default account limit 2.0 GB · base app ceiling 150 GB.', `body ${f.dialog.body}`);
      t.expect(f.dialog.actions.join() === 'Cancel:secondary,Save policy:primary', `actions ${f.dialog.actions}`);
      t.expect(f.dialog.focused === 'reason', 'the Reason field has focus');
      await expectTargets(t, page);
    },
  },
  {
    name: 'se3-policy-saved',
    url: `${H}?${BASE}&open=policy&reason=Launch%20week&submit=1`,
    async fn(page, t) {
      await waitText(page, '.admin-cards .admin-card-value', '2.0 GB');
      await waitText(page, '.admin-audit-reason', 'Launch week');
      const f = await page.evaluate(facts);
      t.expect(!f.dialog, 'the dialog closed');
      t.expect(f.cards[1] === '2.0 GB' && f.policy[0] === '2', `the default follows (${f.cards} / ${f.policy})`);
      t.expect(f.audit.length === 5 && f.auditReasons[0].startsWith('“Launch week”'), `history ${f.auditReasons[0]}`);
      t.expect(f.toast === 'Storage policy saved.', `toast ${f.toast}`);
    },
  },
  {
    name: 'se3-account',
    url: ACCOUNT,
    async fn(page, t) {
      const f = await page.evaluate(facts);
      t.expect(f.title === 'Dana Ruiz' && f.usage === '980 MB of 1.0 GB', `${f.title} · ${f.usage}`);
      t.expect(f.access.map(a => `${a.name}:${a.checked}`).join() === 'Active:true,Export only:false,Suspended:false', `access ${JSON.stringify(f.access)}`);
      t.expect(JSON.stringify(f.devices) === JSON.stringify(['Online', 'Last seen 3 days ago', 'Revoked by its owner', 'Revoked by an administrator', 'Never seen']), `computers ${f.devices}`);
      t.expect(JSON.stringify(f.jobs) === JSON.stringify(['Queued', 'Running · separate', 'Waiting to retry', 'Done', 'Failed · separate', 'Cancelled · download']), `jobs ${f.jobs}`);
      const revoke = await page.getByRole('button', {name: /^Revoke .*…$/}).count();
      const cancel = await page.getByRole('button', {name: /^Cancel .*…$/}).count();
      t.expect(revoke === 3 && cancel === 3, `Revoke… ×${revoke}, Cancel… ×${cancel}`);
      await expectTargets(t, page);
      if (t.device === 'laptop') {
        const focus = await walkFocus(page, {stops: 18});
        t.expect(!focus.length, focus.join('; '));
      }
      await page.evaluate(() => { document.querySelector('.admin-scroller').scrollTop = 1e6; });
      await t.capture('bottom');
      await page.evaluate(() => { document.activeElement?.blur?.(); document.querySelector('.admin-scroller').scrollTop = 0; });
    },
  },
  {
    name: 'se3-account-admin',
    url: `${H}?${BASE}&page=account&id=user1`,
    async fn(page, t) {
      await page.getByRole('radio', {name: 'Suspended'}).click({force: true});
      await waitText(page, '.ui-segmented-reason', 'An administrator account can’t be restricted.');
      const f = await page.evaluate(facts);
      t.expect(f.access.filter(a => a.disabled === 'true').length === 2 && !f.dialog, `disabled options, no dialog ${JSON.stringify(f.access)}`);
    },
  },
  {
    name: 'se3-access-dialog',
    url: `${ACCOUNT}&open=access`,
    async fn(page, t) {
      const f = await page.evaluate(facts);
      t.expect(f.dialog?.title === 'Change access to Export only?', `dialog ${JSON.stringify(f.dialog)}`);
      t.expect(f.dialog.actions.join() === 'Cancel:secondary,Change access:danger', `actions ${f.dialog.actions}`);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('dialog.admin-reason-dialog'));
      const after = await page.evaluate(facts);
      t.expect(after.access[0].checked === 'true', 'Esc puts Active back');
    },
  },
  {
    name: 'se3-reason-short',
    url: `${ACCOUNT}&open=access&reason=no&submit=1`,
    async fn(page, t) {
      const f = await page.evaluate(facts);
      t.expect(f.dialog?.fieldError === 'Reason needs at least 3 characters.', `field error ${JSON.stringify(f.dialog)}`);
      const writes = await page.evaluate(() => window.__admin.state.audit.length);
      t.expect(writes === 4, 'nothing was written');
    },
  },
  {
    name: 'se3-access-saved',
    url: `${ACCOUNT}&open=access&reason=Chargeback%20pending&submit=1`,
    opts: {devices: ['laptop']},
    async fn(page, t) {
      await waitText(page, '.admin-audit-title', 'Account changed');
      const f = await page.evaluate(facts);
      t.expect(f.access[1].checked === 'true' && f.toast === 'Access changed to Export only.', `${JSON.stringify(f.access)} · ${f.toast}`);
      t.expect(f.auditReasons[0].startsWith('“Chargeback pending”'), `history ${f.auditReasons[0]}`);
    },
  },
  {
    name: 'se3-revoke',
    url: `${ACCOUNT}&open=revoke&reason=Lost%20laptop&submit=1`,
    opts: {devices: ['laptop']},
    async fn(page, t) {
      await page.waitForFunction(() => document.querySelector('.admin-items .admin-item-meta')?.textContent === 'Revoked by an administrator');
      const f = await page.evaluate(facts);
      t.expect(f.toast === 'Dana’s MacBook Pro revoked.' && f.audit[0] === 'Computer revoked', `${f.toast} · ${f.audit[0]}`);
    },
  },
  {
    name: 'se3-cancel-job',
    url: `${ACCOUNT}&open=cancel&reason=Stuck%20for%20an%20hour&submit=1`,
    opts: {devices: ['laptop']},
    async fn(page, t) {
      await waitText(page, '.admin-audit-title', 'Job cancelled');
      const f = await page.evaluate(facts);
      t.expect(f.jobs[1] === 'Cancelled · separate' && f.toast === 'Harbor Lights cancelled.', `${f.jobs} · ${f.toast}`);
    },
  },
  {
    name: 'se3-override-saved',
    url: `${ACCOUNT}&open=override&reason=Podcast%20project&submit=1`,
    opts: {devices: ['laptop']},
    async fn(page, t) {
      await waitText(page, '.admin-usage .admin-card-value', '980 MB of 2.0 GB');
      const f = await page.evaluate(facts);
      t.expect(f.override === '2' && f.toast === 'Storage override saved.', `${f.override} · ${f.toast}`);
    },
  },
  {
    name: 'se3-notes-dialog',
    url: `${ACCOUNT}&open=notes&reason=Support%20call`,
    async fn(page, t) {
      const f = await page.evaluate(facts);
      t.expect(f.dialog?.title === 'Save the notes?', `dialog ${JSON.stringify(f.dialog)}`);
    },
  },
  {
    name: 'se3-save-refused',
    url: `${ACCOUNT}&fail=save&open=notes&reason=Support%20call&submit=1`,
    async fn(page, t) {
      const f = await page.evaluate(facts);
      t.expect(f.dialog?.error?.endsWith('Notes are limited to 4000 characters.'), `the server's message in the dialog (${JSON.stringify(f.dialog)})`);
      t.expect(!f.dialog.busy, 'not busy any more');
    },
  },
  {
    name: 'se3-dialog-busy',
    url: `${ACCOUNT}&slow=1&open=revoke&reason=Lost%20laptop&submit=1`,
    opts: {devices: ['laptop']},
    async fn(page, t) {
      const f = await page.evaluate(facts);
      t.expect(f.dialog?.busy === true, 'busy while the change runs');
      await page.keyboard.press('Escape');
      t.expect((await page.evaluate(facts)).dialog, 'Esc does not abandon a running change');
    },
  },
  {
    name: 'se3-account-missing',
    url: `${H}?${BASE}&page=account&id=nobody`,
    async fn(page, t) {
      const headings = await page.getByRole('heading').allTextContents();
      t.expect(JSON.stringify(headings) === '["Account not found"]', `one heading (${headings})`);
      await page.getByRole('button', {name: 'Administration'}).click();
      const log = await page.evaluate(() => window.__admin.router.log.at(-1));
      t.expect(JSON.stringify(log) === '["back",{"fallback":"/admin"}]', `Back leads out (${JSON.stringify(log)})`);
    },
  },
  {
    name: 'se3-account-bad-id',
    url: `${H}?${BASE}&page=account&id=garbage`,
    async fn(page, t) {
      await waitText(page, '.admin-title', 'Account not found');
      const headings = await page.getByRole('heading').allTextContents();
      t.expect(JSON.stringify(headings) === '["Account not found"]', `one heading (${headings})`);
      const f = await page.evaluate(facts);
      t.expect(f.alert === null, `no load error (${f.alert})`);
    },
  },
  {
    name: 'se3-account-load-error',
    url: `${H}?${BASE}&page=account&fail=load`,
    async fn(page, t) {
      const f = await page.evaluate(facts);
      t.expect(f.alert?.startsWith('This couldn’t be loaded. Connection lost while the query was in flight.'), `alert ${f.alert}`);
      await t.capture('error');
      await page.getByRole('button', {name: 'Retry'}).click();
      await waitText(page, '.admin-title', 'Dana Ruiz');
    },
  },
  {
    name: 'se3-account-empty',
    url: `${H}?${BASE}&page=account&empty=1`,
    async fn(page, t) {
      await page.evaluate(() => { document.querySelector('.admin-scroller').scrollTop = 1e6; });
      const empties = await page.evaluate(() => [...document.querySelectorAll('.admin-empty')].filter(n => !n.hidden).map(n => n.textContent));
      t.expect(JSON.stringify(empties) === JSON.stringify(['No paired computers.', 'No jobs.', 'No changes to this account yet.']), `empties ${empties}`);
    },
  },
  {
    name: 'se3-app-admin',
    url: '/admin?fx-reset=1&fx-admin=1&fx-now=2026-10-28T12:00:00Z',
    opts: {ready: 'admin'},
    async fn(page, t) {
      const f = await page.evaluate(facts);
      t.expect(f.title === 'Administration' && f.accounts.length === 4, `the full app mounts Administration (${f.title}, ${f.accounts})`);
      await expectTargets(t, page);
    },
  },
  {
    name: 'se3-app-admin-desktop',
    url: '/admin?fx-reset=1&fx-admin=1&fx-desktop=1&fx-now=2026-10-28T12:00:00Z',
    opts: {ready: 'admin', devices: ['laptop']},
    async fn(page, t) {
      const f = await page.evaluate(facts);
      t.expect(f.title === 'Administration', 'the desktop app mounts Administration');
    },
  },
  {
    name: 'se3-app-back',
    url: '/admin?fx-reset=1&fx-admin=1&fx-now=2026-10-28T12:00:00Z',
    opts: {ready: 'admin', capture: false},
    async fn(page, t) {
      const idx0 = await page.evaluate(() => history.state?.idx);
      await page.locator('a[data-focus-key="account:user2"]').click();
      await t.ready('adminAccount');
      const idx1 = await page.evaluate(() => history.state?.idx);
      t.expect(idx1 === idx0 + 1, `opening an account pushes (${idx0} → ${idx1})`);
      t.expect(await page.getByRole('heading', {level: 1, name: 'Dana Ruiz'}).count() === 1, 'the account page');
      await page.getByRole('button', {name: 'Administration'}).click();
      await t.ready('admin');
      await page.waitForFunction(() => document.activeElement?.dataset?.focusKey === 'account:user2', null, {timeout: 5000}).catch(() => {});
      const back = await page.evaluate(() => ({idx: history.state?.idx, path: location.pathname, focus: document.activeElement?.dataset?.focusKey ?? null}));
      t.expect(back.path === '/admin' && back.idx === idx0, `Back returns to /admin with idx ${idx0} (${JSON.stringify(back)})`);
      t.expect(back.focus === 'account:user2', `the opened account's row has focus (${back.focus})`);
    },
  },
];
