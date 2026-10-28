// @vitest-environment happy-dom
// SE3: Administration (spec §6.4, architecture §2.17, §9.10): overview cards, the policy form, the account
// search by exact email, /admin/accounts/:id (access segmented, storage override, notes, computers with
// lastSeenAt and Revoke…, jobs with Cancel…, audit history with Load more), and the Reason dialog in front of
// every change (≥ 3 characters; window.prompt is never used).
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {installPopoverShim, keydown, restoreDomShims} from './helpers/dom.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const GB = 1e9, MB = 1e6, MIN = 60_000, DAY = 86_400_000;

const api = vi.hoisted(() => {
  const subs = {overview: new Set(), account: new Map()};
  const api = {
    PAGE_SIZE: 25,
    subs,
    data: null,
    emitOverview() { for (const s of subs.overview) s.onValue(structuredClone(api.data.overview)); },
    emitAccount(id) { for (const s of subs.account.get(id) ?? []) s.onValue(structuredClone(api.data.accounts[id])); },
  };
  return api;
});

vi.mock('../src/api/admin.js', () => {
  const pageOf = (rows, cursor, n = 25) => {
    const start = cursor ? Number(cursor) : 0;
    const page = rows.slice(start, start + n);
    const end = start + page.length;
    return {page: structuredClone(page), isDone: end >= rows.length, continueCursor: end >= rows.length ? null : String(end)};
  };
  return {
    PAGE_SIZE: 25,
    access: vi.fn(async () => true),
    overview: vi.fn(async () => structuredClone(api.data.overview)),
    subscribeOverview: vi.fn((onValue, onError) => {
      const sub = {onValue, onError};
      api.subs.overview.add(sub);
      queueMicrotask(() => {
        if (!api.subs.overview.has(sub)) return;
        if (api.data.overviewError) onError?.(api.data.overviewError); else onValue(structuredClone(api.data.overview));
      });
      return () => api.subs.overview.delete(sub);
    }),
    accounts: vi.fn(async ({email, cursor} = {}) => {
      const rows = email ? api.data.list.filter(a => a.email === email) : api.data.list;
      return pageOf(rows, cursor);
    }),
    account: vi.fn(async ({id}) => structuredClone(api.data.accounts[id])),
    subscribeAccount: vi.fn(({id}, onValue, onError) => {
      const sub = {onValue, onError};
      if (!api.subs.account.has(id)) api.subs.account.set(id, new Set());
      api.subs.account.get(id).add(sub);
      queueMicrotask(() => {
        if (!api.subs.account.get(id)?.has(sub)) return;
        const error = api.data.accountErrors?.shift?.();
        if (error) onError?.(error);
        else if (!api.data.accounts[id]) onError?.(Object.assign(new Error('Account not found.'), {code: 'not_found', data: {}}));
        else onValue(structuredClone(api.data.accounts[id]));
      });
      return () => api.subs.account.get(id)?.delete(sub);
    }),
    history: vi.fn(async ({targetId, cursor} = {}) => pageOf(targetId ? api.data.audit.filter(a => a.targetId === targetId) : api.data.audit, cursor)),
    updateAccount: vi.fn(async () => null),
    updatePolicy: vi.fn(async () => null),
    revokeDevice: vi.fn(async () => null),
    cancelJob: vi.fn(async () => null),
  };
});

const adminApi = await import('../src/api/admin.js');
const clock = await import('../src/app/clock.js');
const {toastState, resetFeedback} = await import('../src/app/feedback.js');
const {store} = await import('../src/app/store.js');
const admin = await import('../src/settings/admin/admin.js');
const account = await import('../src/settings/admin/account.js');
const {askReason, REASON_COPY, REASON_MIN, REASON_MAX, reasonError} = await import('../src/settings/admin/reason-dialog.js');

// ---------------------------------------------------------------------------------------------- data

function seed() {
  const dana = {
    id: 'user2', name: 'Dana Ruiz', email: 'dana@example.com', createdAt: NOW - 120 * DAY, emailVerified: true, status: 'active',
    byteLimit: null, notes: 'Beta tester.', usedBytes: 980 * MB, limitBytes: GB, admin: false,
    devices: [
      {id: 'd1', name: 'Dana’s MacBook Pro', revoked: false, revokedBy: null, lastSeenAt: NOW - 20_000},
      {id: 'd2', name: 'Studio PC', revoked: false, revokedBy: null, lastSeenAt: NOW - 3 * DAY},
      {id: 'd3', name: 'Old laptop', revoked: true, revokedBy: 'user', lastSeenAt: NOW - 90 * DAY},
      {id: 'd4', name: 'Loaner Mac mini', revoked: true, revokedBy: 'admin', lastSeenAt: null},
      {id: 'd5', name: 'New desktop', revoked: false, revokedBy: null, lastSeenAt: null},
    ],
    jobs: [
      {id: 'j3', label: 'Paper Boats', status: 'queued', stage: 'queued', createdAt: NOW - 2 * MIN},
      {id: 'j1', label: 'Harbor Lights', status: 'running', stage: 'separate', createdAt: NOW - 4 * MIN},
      {id: 'j2', label: 'Undertow', status: 'error', stage: 'download', error: 'Sign in to confirm you’re not a bot.', retryAt: NOW + 5 * MIN, createdAt: NOW - 30 * MIN},
      {id: 'j4', label: 'Glasshouse', status: 'done', stage: 'done', createdAt: NOW - 2 * DAY},
      {id: 'j5', label: 'Night Drive', status: 'error', stage: 'separate', error: 'Separation failed.', createdAt: NOW - 5 * DAY},
      {id: 'j6', label: '', status: 'canceled', stage: 'download', createdAt: NOW - 6 * DAY},
    ],
  };
  const kyle = {...structuredClone(dana), id: 'user1', name: 'Kyle Kincer', email: 'kyle@example.com', admin: true, notes: '', devices: [], jobs: []};
  const list = [
    {id: 'user4', name: 'Theo Park', email: 'theo@example.com', createdAt: NOW - 9 * DAY, status: 'suspended', usedBytes: 0, limitBytes: GB, admin: false},
    {id: 'user3', name: '', email: 'sam.l@example.com', createdAt: NOW - 60 * DAY, status: 'export_only', usedBytes: 2.1 * GB, limitBytes: GB, admin: false},
    {id: 'user2', name: 'Dana Ruiz', email: 'dana@example.com', createdAt: NOW - 120 * DAY, status: 'active', usedBytes: 980 * MB, limitBytes: GB, admin: false},
    {id: 'user1', name: 'Kyle Kincer', email: 'kyle@example.com', createdAt: NOW - 400 * DAY, status: 'active', usedBytes: 412 * MB, limitBytes: GB, admin: true},
  ];
  const audit = [
    {_id: 'a1', actorId: 'user1', targetId: 'app', action: 'policy.update', reason: 'Raise default limit for launch', at: NOW - DAY,
      before: {baseAppBytes: 150 * GB, fundedBytes: 50 * GB, userBytes: 500 * MB, appBytes: 200 * GB}, after: {userBytes: GB, appBytes: 150 * GB}},
    {_id: 'a2', actorId: 'user9', targetId: 'user3', action: 'account.update', reason: 'Over limit after downgrade', at: NOW - 3 * DAY,
      before: null, after: {status: 'export_only', byteLimit: null, notes: 'x'}},
    {_id: 'a3', actorId: 'user1', targetId: 'user2', action: 'device.revoke', reason: 'Lost in transit', at: NOW - 8 * DAY,
      before: {id: 'd4', revoked: false, revokedBy: null}, after: {revoked: true, revokedBy: 'admin'}},
  ];
  return {
    overview: {usedBytes: 61.2 * GB, appBytes: 200 * GB, baseAppBytes: 150 * GB, fundedBytes: 50 * GB, userBytes: GB},
    list, audit, accounts: {user1: kyle, user2: dana}, accountErrors: [],
  };
}

// ---------------------------------------------------------------------------------------------- helpers

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const visibleText = el => {
  const clone = el.cloneNode(true);
  for (const n of clone.querySelectorAll('[aria-hidden=true], [hidden], .ui-button-reason')) n.remove();
  // Text nodes joined with spaces: separate blocks read as separate words, as a screen reader says them.
  const walker = document.createTreeWalker(clone, 4);
  const parts = [];
  while (walker.nextNode()) parts.push(walker.currentNode.nodeValue);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
};
function accName(el) {
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
  if (el.getAttribute('aria-labelledby')) return el.getAttribute('aria-labelledby').split(' ').map(id => visibleText(document.getElementById(id))).join(' ');
  if (el.id) { const label = document.querySelector(`label[for="${el.id}"]`); if (label) return visibleText(label); }
  return visibleText(el);
}
function roleOf(el) {
  if (el.getAttribute('role')) return el.getAttribute('role');
  if (/^H[1-6]$/.test(el.tagName)) return 'heading';
  if (el.tagName === 'BUTTON') return 'button';
  if (el.tagName === 'A' && el.hasAttribute('href')) return 'link';
  if (el.tagName === 'TEXTAREA') return 'textbox';
  if (el.tagName === 'INPUT') return el.type === 'search' ? 'searchbox' : 'textbox';
  return null;
}
const all = (root = document) => [...root.querySelectorAll('button, a, input, textarea, h1, h2, h3, [role]')].filter(el => !el.closest('[hidden]'));
const byRole = (role, name, root) => all(root).filter(el => roleOf(el) === role && (name === undefined || accName(el) === name));
const one = (role, name, root) => {
  const found = byRole(role, name, root);
  if (found.length !== 1) throw new Error(`expected one ${role} "${name}", found ${found.length}`);
  return found[0];
};
const dialog = () => document.querySelector('dialog.admin-reason-dialog');
const typeInto = (input, value) => { input.value = value; input.dispatchEvent(new window.Event('input', {bubbles: true})); };
const submit = form => form.dispatchEvent(new window.Event('submit', {cancelable: true, bubbles: true}));
async function giveReason(text) {
  const d = dialog();
  expect(d).toBeTruthy();
  typeInto(d.querySelector('input[name=reason]'), text);
  submit(d.querySelector('form'));
  await flush();
}
const toastText = () => toastState().visible?.message ?? null;

function fakeRouter() {
  return {navigate: vi.fn(), back: vi.fn(), setQuery: vi.fn()};
}

let host, view, router;
async function mountAdmin(match = {name: 'admin', params: {}, query: {}}) {
  view = await admin.mount(host, match, {router, store});
  return view;
}
async function mountAccount(id = 'user2') {
  view = await account.mount(host, {name: 'adminAccount', params: {id}, query: {}}, {router, store});
  return view;
}

beforeEach(() => {
  installPopoverShim();
  clock.set?.(() => NOW);
  api.data = seed();
  api.subs.overview.clear();
  api.subs.account.clear();
  vi.clearAllMocks();
  router = fakeRouter();
  store.session.value = {user: {id: 'user1', name: 'Kyle Kincer', email: 'kyle@example.com'}, status: 'active', admin: true, online: true};
  host = document.createElement('main');
  document.body.append(host);
  window.prompt = vi.fn(() => { throw new Error('window.prompt must not be used'); });
});

afterEach(async () => {
  for (const d of document.querySelectorAll('dialog')) d.__uiClose?.();
  await view?.unmount?.();
  view = null;
  resetFeedback();
  restoreDomShims();
  clock.reset?.();
  document.body.replaceChildren();
});

// ---------------------------------------------------------------------------------------------- formatting

describe('formatting', () => {
  test.each([
    [0, '0 MB'], [-5, '0 MB'], [NaN, '0 MB'], [2.5 * MB, '2.5 MB'], [412 * MB, '412 MB'], [980.4 * MB, '980 MB'],
    [GB, '1.0 GB'], [1.25 * GB, '1.3 GB'], [61.2 * GB, '61.2 GB'], [200 * GB, '200 GB'], [1499 * GB, '1499 GB'],
  ])('formatBytes(%s) is %s', (bytes, text) => expect(admin.formatBytes(bytes)).toBe(text));

  test.each([
    ['', null], ['  ', null], ['2', 2 * GB], ['0', 0], ['0.25', 250 * MB], ['.5', 500 * MB], ['1.5 GB', 1.5 * GB], ['150', 150 * GB],
    ['-1', NaN], ['abc', NaN], ['1,5', NaN], ['1e3', NaN], ['9'.repeat(20), NaN],
  ])('parseGB(%j) is %s', (text, bytes) => expect(admin.parseGB(text)).toBe(bytes));

  test('gbText round-trips through parseGB to the megabyte', () => {
    for (const bytes of [0, 250 * MB, GB, 1.5 * GB, 150 * GB, 123_456_789]) {
      expect(Math.abs(admin.parseGB(admin.gbText(bytes)) - bytes)).toBeLessThan(MB);
    }
    expect(admin.gbText(250 * MB)).toBe('0.25');
    expect(admin.gbText(-1)).toBe('');
  });

  test('status labels', () => {
    expect(['active', 'export_only', 'suspended', undefined].map(admin.statusLabel)).toEqual(['Active', 'Export only', 'Suspended', 'Active']);
  });

  test('audit rows describe what changed', () => {
    const [policy, update, revoke] = seed().audit;
    expect(admin.describeAudit(policy)).toEqual({title: 'Storage policy changed', changes: ['Default account limit: 500 MB → 1.0 GB']});
    expect(admin.describeAudit(update)).toEqual({title: 'Account changed', changes: ['Access: Active → Export only', 'Notes edited']});
    expect(admin.describeAudit({...update, before: {status: 'export_only', byteLimit: null, notes: 'x'}, after: {status: 'export_only', byteLimit: 2 * GB, notes: 'x'}}).changes)
      .toEqual(['Storage override: default → 2.0 GB']);
    expect(admin.describeAudit(revoke, {names: {d4: 'Loaner Mac mini'}})).toEqual({title: 'Computer revoked', changes: ['Computer: Loaner Mac mini']});
    expect(admin.describeAudit(revoke).changes).toEqual(['Computer: d4']);
    expect(admin.describeAudit({action: 'job.cancel', before: {id: 'j1', status: 'running'}}, {names: {j1: 'Harbor Lights'}}).changes)
      .toEqual(['Job: Harbor Lights (was running)']);
    expect(admin.describeAudit({action: 'policy.update', before: {baseAppBytes: 150 * GB, userBytes: GB}, after: {userBytes: GB, appBytes: 180 * GB}}).changes)
      .toEqual(['Base app ceiling: 150 GB → 180 GB']);
  });

  test('computer and job lines', () => {
    const d = seed().accounts.user2.devices;
    expect(d.map(x => account.deviceLine(x, NOW))).toEqual(['Online', 'Last seen 3 days ago', 'Revoked by its owner', 'Revoked by an administrator', 'Never seen']);
    expect(account.deviceLine({...d[0], lastSeenAt: NOW - 10 * MIN}, NOW)).toBe('Last seen 10 min ago');
    const j = seed().accounts.user2.jobs;
    expect(j.map(account.jobLine)).toEqual(['Queued', 'Running · separate', 'Waiting to retry', 'Done', 'Failed · separate', 'Cancelled · download']);
    expect(j.map(account.isLiveJob)).toEqual([true, true, true, false, false, false]);
  });
});

// ---------------------------------------------------------------------------------------------- the Reason dialog

describe('askReason', () => {
  test('requires at least 3 characters, trims, and resolves the reason', async () => {
    const run = vi.fn(async () => null);
    const p = askReason({title: 'Revoke “Studio PC”?', body: 'It stops processing.', confirmLabel: 'Revoke', danger: true, run});
    const d = dialog();
    expect(d.querySelector('.ui-dialog-title').textContent).toBe('Revoke “Studio PC”?');
    const input = d.querySelector('input[name=reason]');
    expect(accName(input)).toBe(REASON_COPY.label);
    expect(input.maxLength).toBe(REASON_MAX);
    expect(document.activeElement).toBe(input);
    const [cancel, confirm] = d.querySelectorAll('.ui-dialog-action');
    expect([cancel.textContent, confirm.textContent, confirm.dataset.variant]).toEqual(['Cancel', 'Revoke', 'danger']);
    await giveReason('');
    expect(d.querySelector('.ui-dialog-field-error').textContent).toBe('Reason is required.');
    await giveReason(' ok ');
    expect(d.querySelector('.ui-dialog-field-error').textContent).toBe(`Reason needs at least ${REASON_MIN} characters.`);
    expect(run).not.toHaveBeenCalled();
    await giveReason('  Lost in transit  ');
    expect(run).toHaveBeenCalledWith('Lost in transit');
    await expect(p).resolves.toBe('Lost in transit');
    expect(dialog()).toBeNull();
    expect(window.prompt).not.toHaveBeenCalled();
  });

  test('a refused change stays in the dialog with the error inline; a refused reason shows at the field', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Enter a reason (3–500 characters).'), {code: 'invalid', data: {field: 'reason'}}))
      .mockRejectedValueOnce(Object.assign(new Error('An administrator account cannot be restricted.'), {code: 'invalid', data: {}}))
      .mockResolvedValueOnce(null);
    const p = askReason({title: 'Change access?', run});
    await giveReason('why');
    const d = dialog();
    expect(d.querySelector('.ui-dialog-field-error').textContent).toBe('Woodshed couldn’t use that. Check it and try again. Enter a reason (3–500 characters).');
    await giveReason('because');
    expect(d.querySelector('.ui-dialog-error').textContent).toBe('Woodshed couldn’t use that. Check it and try again. An administrator account cannot be restricted.');
    expect(d.isConnected).toBe(true);
    expect(d.querySelector('input[name=reason]').value).toBe('because');
    submit(d.querySelector('form'));
    await expect(p).resolves.toBe('because');
  });

  test('Cancel and Esc resolve null without running the change', async () => {
    const run = vi.fn();
    const p = askReason({title: 'Cancel “Undertow”?', confirmLabel: 'Cancel job', cancelLabel: 'Keep it', run});
    const [keep] = dialog().querySelectorAll('.ui-dialog-action');
    expect(keep.textContent).toBe('Keep it');
    keep.click();
    await expect(p).resolves.toBeNull();
    const q = askReason({title: 'Save the notes?', run});
    keydown({key: 'Escape', code: 'Escape'}, {target: dialog()});
    await expect(q).resolves.toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  test('error text: the app’s copy, then the server’s detail', () => {
    expect(reasonError(Object.assign(new Error('Notes are limited to 4000 characters.'), {code: 'invalid'})))
      .toBe('Woodshed couldn’t use that. Check it and try again. Notes are limited to 4000 characters.');
    expect(reasonError({code: 'unknown'})).toBe('Your change couldn’t be saved.');
  });
});

// ---------------------------------------------------------------------------------------------- /admin

describe('/admin', () => {
  test('every control in CONTROLS renders with its role and accessible name', async () => {
    await mountAdmin();
    for (const {role, name} of admin.CONTROLS) expect(byRole(role, name), `${role} "${name}"`).toHaveLength(1);
    expect(host.querySelectorAll('[data-scroller]')).toHaveLength(1);
  });

  test('mount resolves once the overview, the first accounts and the history arrived', async () => {
    let release;
    adminApi.history.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    let done = false;
    const p = admin.mount(host, {name: 'admin', params: {}, query: {}}, {router, store}).then(v => { done = true; view = v; });
    await flush();
    expect(done).toBe(false);
    expect(host.querySelector('.admin-audit-box').getAttribute('aria-busy')).toBe('true');
    release({page: [], isDone: true, continueCursor: null});
    await p;
    expect(done).toBe(true);
    expect(host.querySelector('.admin-audit-box').getAttribute('aria-busy')).toBe('false');
    expect(visibleText(host.querySelector('.admin-audit-box'))).toContain('No administration changes yet.');
  });

  test('overview cards show storage used of the ceiling, the default, and base plus paid capacity', async () => {
    await mountAdmin();
    const cards = [...host.querySelectorAll('.admin-card')].map(visibleText);
    expect(cards[0]).toContain('61.2 GB of 200 GB');
    expect(cards[1]).toContain('1.0 GB');
    expect(cards[2]).toContain('200 GB');
    expect(cards[2]).toContain('150 GB base + 50.0 GB paid capacity');
    expect(one('progressbar', 'Cloud storage used').getAttribute('aria-valuenow')).toBe('31');
    api.data.overview = {...api.data.overview, usedBytes: 210 * GB};
    api.emitOverview();
    expect(host.querySelector('.admin-meter').dataset.tone).toBe('warn');
  });

  test('an overview that fails to load says so; the rest of the page still works', async () => {
    api.data.overviewError = Object.assign(new Error('Connection lost.'), {code: 'unknown'});
    await mountAdmin();
    expect(one('alert', undefined, host).textContent).toContain('Connection lost.');
    expect(byRole('link').length).toBeGreaterThan(0);
  });

  test('the policy form: blank and bad sizes are refused, an unchanged policy says so, a change goes through the Reason dialog', async () => {
    await mountAdmin();
    const user = one('textbox', 'Default account limit (GB)');
    const app = one('textbox', 'Base app ceiling (GB)');
    expect([user.value, app.value]).toEqual(['1', '150']);
    const form = host.querySelector('form.admin-policy');
    submit(form);
    expect(visibleText(form)).toContain('Change a limit to save the policy.');
    expect(dialog()).toBeNull();
    typeInto(user, 'lots');
    expect(user.getAttribute('aria-invalid')).toBe('true');
    typeInto(user, '');
    submit(form);
    expect(user.getAttribute('aria-invalid')).toBe('true');
    expect(dialog()).toBeNull();
    typeInto(user, '2');
    typeInto(app, '180');
    submit(form);
    await flush();
    expect(dialog().querySelector('.ui-dialog-title').textContent).toBe('Change the storage policy?');
    expect(dialog().querySelector('.ui-dialog-body').textContent).toBe('Default account limit 2.0 GB · base app ceiling 180 GB.');
    adminApi.history.mockClear();
    await giveReason('Launch week');
    expect(adminApi.updatePolicy).toHaveBeenCalledWith({userBytes: 2 * GB, appBytes: 180 * GB, reason: 'Launch week'});
    expect(dialog()).toBeNull();
    expect(toastText()).toBe('Storage policy saved.');
    expect(adminApi.history).toHaveBeenCalledTimes(1);
  });

  test('a field left as shown keeps the stored bytes (no rounding to the GB text)', async () => {
    api.data.overview.userBytes = 123_456_789;
    await mountAdmin();
    typeInto(one('textbox', 'Base app ceiling (GB)'), '151');
    submit(host.querySelector('form.admin-policy'));
    await flush();
    await giveReason('More room');
    expect(adminApi.updatePolicy).toHaveBeenCalledWith({userBytes: 123_456_789, appBytes: 151 * GB, reason: 'More room'});
  });

  test('cancelling the Reason dialog changes nothing', async () => {
    await mountAdmin();
    typeInto(one('textbox', 'Default account limit (GB)'), '3');
    submit(host.querySelector('form.admin-policy'));
    await flush();
    dialog().querySelector('.ui-dialog-action').click();
    await flush();
    expect(adminApi.updatePolicy).not.toHaveBeenCalled();
    expect(one('textbox', 'Default account limit (GB)').value).toBe('3');
  });

  test('accounts: rows link to the account page and carry the focus key Back restores', async () => {
    await mountAdmin();
    const links = byRole('link').filter(a => a.classList.contains('admin-account-link'));
    expect(links.map(a => a.getAttribute('href'))).toEqual(['/admin/accounts/user4', '/admin/accounts/user3', '/admin/accounts/user2', '/admin/accounts/user1']);
    expect(links.map(a => a.dataset.focusKey)).toEqual(['account:user4', 'account:user3', 'account:user2', 'account:user1']);
    expect(visibleText(links[1])).toBe('sam.l@example.com Export only 2.1 GB of 1.0 GB · Over limit');
    expect(visibleText(links[3])).toBe('Kyle Kincer Admin kyle@example.com Active 412 MB of 1.0 GB');
    expect(links[1].querySelector('.admin-account-usage').dataset.tone).toBe('warn');
  });

  test('search by exact email mirrors ?email= and Show all clears it', async () => {
    await mountAdmin();
    const field = one('searchbox', 'Find an account by exact email');
    typeInto(field, '  dana@example.com ');
    submit(host.querySelector('form.admin-search'));
    await flush();
    expect(adminApi.accounts).toHaveBeenLastCalledWith({email: 'dana@example.com', cursor: null});
    expect(router.setQuery).toHaveBeenLastCalledWith({email: 'dana@example.com'});
    expect(byRole('link').filter(a => a.classList.contains('admin-account-link')).map(a => a.dataset.focusKey)).toEqual(['account:user2']);
    typeInto(field, 'Dana@Example.com');
    submit(host.querySelector('form.admin-search'));
    await flush();
    expect(visibleText(host.querySelector('.admin-accounts-box'))).toBe('No account uses Dana@Example.com.');
    one('button', 'Show all').click();
    await flush();
    expect(router.setQuery).toHaveBeenLastCalledWith({email: null});
    expect(field.value).toBe('');
    expect(byRole('button', 'Show all')).toHaveLength(0);
    expect(host.querySelectorAll('.admin-account-link')).toHaveLength(4);
  });

  test('the ?email= of a deep link or of Back is searched on mount and on update', async () => {
    await mountAdmin({name: 'admin', params: {}, query: {email: 'theo@example.com'}});
    expect(adminApi.accounts).toHaveBeenLastCalledWith({email: 'theo@example.com', cursor: null});
    expect(one('searchbox', 'Find an account by exact email').value).toBe('theo@example.com');
    view.update({name: 'admin', params: {}, query: {}});
    await flush();
    expect(adminApi.accounts).toHaveBeenLastCalledWith({email: undefined, cursor: null});
  });

  test('Load more pages through accounts and the audit history', async () => {
    api.data.list = Array.from({length: 30}, (_, i) => ({id: `u${i}`, name: `Player ${i}`, email: `p${i}@example.com`, createdAt: NOW - i * DAY,
      status: 'active', usedBytes: 0, limitBytes: GB, admin: false}));
    api.data.audit = Array.from({length: 27}, (_, i) => ({_id: `a${i}`, actorId: 'user1', targetId: `u${i}`, action: 'account.update', reason: `Ticket ${i}`,
      at: NOW - i * DAY, before: null, after: {status: 'active', byteLimit: GB, notes: ''}}));
    await mountAdmin();
    expect(host.querySelectorAll('.admin-account-link')).toHaveLength(25);
    expect(host.querySelectorAll('.admin-audit-row')).toHaveLength(25);
    const [moreAccounts, moreHistory] = byRole('button', 'Load more');
    moreAccounts.click();
    await flush();
    expect(adminApi.accounts).toHaveBeenLastCalledWith({email: undefined, cursor: '25'});
    expect(host.querySelectorAll('.admin-account-link')).toHaveLength(30);
    moreHistory.click();
    await flush();
    expect(adminApi.history).toHaveBeenLastCalledWith({targetId: undefined, cursor: '25'});
    expect(host.querySelectorAll('.admin-audit-row')).toHaveLength(27);
    expect(byRole('button', 'Load more')).toHaveLength(0);
  });

  test('the audit history names the change, its target, the reason and who made it (“you” for yourself)', async () => {
    await mountAdmin();
    const rows = [...host.querySelectorAll('.admin-audit-row')];
    expect(visibleText(rows[0])).toBe('Storage policy changed Storage policy yesterday Default account limit: 500 MB → 1.0 GB “Raise default limit for launch” by you');
    expect(visibleText(rows[1])).toBe('Account changed Account user3 3 days ago Access: Active → Export only Notes edited “Over limit after downgrade” by user9');
    expect(rows[1].querySelector('a').getAttribute('href')).toBe('/admin/accounts/user3');
    expect(rows[0].querySelector('time').getAttribute('datetime')).toBe(new Date(NOW - DAY).toISOString());
    expect(rows[0].querySelector('time').hasAttribute('data-volatile')).toBe(true);
  });

  test('a failed account list shows the error with Retry', async () => {
    adminApi.accounts.mockRejectedValueOnce(Object.assign(new Error('Administrator access required.'), {code: 'not_owner'}));
    await mountAdmin();
    const alert = host.querySelector('.admin-accounts-box [role=alert]');
    expect(alert.textContent).toContain('Administrator access required.');
    alert.querySelector('button').click();
    await flush();
    expect(host.querySelectorAll('.admin-account-link')).toHaveLength(4);
  });

  test('unmount stops the live overview', async () => {
    await mountAdmin();
    expect(api.subs.overview.size).toBe(1);
    await view.unmount();
    view = null;
    expect(api.subs.overview.size).toBe(0);
    expect(host.childElementCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------- /admin/accounts/:id

describe('/admin/accounts/:id', () => {
  test('every control in CONTROLS renders with its role and accessible name', async () => {
    await mountAccount();
    for (const {role, name} of account.CONTROLS) expect(byRole(role, name), `${role} "${name}"`).toHaveLength(1);
    expect(host.querySelectorAll('[data-scroller]')).toHaveLength(1);
  });

  test('the header and storage', async () => {
    await mountAccount();
    expect(one('heading', 'Dana Ruiz').tagName).toBe('H1');
    expect(visibleText(host.querySelector('.admin-meta'))).toBe('dana@example.com Email verified Joined 4 months ago Active');
    expect(visibleText(host.querySelector('.admin-usage'))).toBe('980 MB of 1.0 GB');
    expect(one('progressbar', 'Storage used').getAttribute('aria-valuenow')).toBe('98');
    api.data.accounts.user2 = {...api.data.accounts.user2, usedBytes: 1.2 * GB};
    api.emitAccount('user2');
    expect(visibleText(host.querySelector('.admin-usage'))).toContain('Over the limit: new uploads are paused.');
  });

  test('Back returns through the router (the Library-style focus restore lands on the account’s row)', async () => {
    await mountAccount();
    one('button', 'Administration').click();
    expect(router.back).toHaveBeenCalledWith({fallback: '/admin'});
  });

  test('access: choosing Export only asks for a reason and writes status with the current limit and notes', async () => {
    await mountAccount();
    const group = one('radiogroup', 'Account access');
    expect(byRole('radio', undefined, group).map(r => [accName(r), r.getAttribute('aria-checked')]))
      .toEqual([['Active', 'true'], ['Export only', 'false'], ['Suspended', 'false']]);
    one('radio', 'Export only').click();
    await flush();
    expect(dialog().querySelector('.ui-dialog-title').textContent).toBe('Change access to Export only?');
    expect(dialog().querySelector('.ui-dialog-body').textContent).toBe(account.COPY.accessHelp.export_only);
    await giveReason('Chargeback');
    expect(adminApi.updateAccount).toHaveBeenCalledWith({id: 'user2', status: 'export_only', byteLimit: null, notes: 'Beta tester.', reason: 'Chargeback'});
    expect(toastText()).toBe('Access changed to Export only.');
    expect(one('radio', 'Export only').getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('#admin-access-help').textContent).toBe(account.COPY.accessHelp.export_only);
  });

  test('access: cancelling puts the segmented control back', async () => {
    await mountAccount();
    one('radio', 'Suspended').click();
    await flush();
    keydown({key: 'Escape', code: 'Escape'}, {target: dialog()});
    await flush();
    expect(adminApi.updateAccount).not.toHaveBeenCalled();
    expect(one('radio', 'Active').getAttribute('aria-checked')).toBe('true');
    expect(one('radio', 'Suspended').getAttribute('aria-checked')).toBe('false');
  });

  test('an administrator’s access cannot be restricted: the options are disabled with the reason', async () => {
    await mountAccount('user1');
    expect(one('radio', 'Export only').getAttribute('aria-disabled')).toBe('true');
    one('radio', 'Suspended').click();
    await flush();
    expect(dialog()).toBeNull();
    expect(visibleText(host.querySelector('.admin-access'))).toContain('An administrator account can’t be restricted.');
    expect(visibleText(host.querySelector('.admin-meta'))).toContain('Admin');
  });

  test('storage override: bad text is refused, blank means the plan limit, a size goes through the dialog', async () => {
    await mountAccount();
    const field = one('textbox', 'Storage override (GB)');
    const form = field.closest('form');
    expect(field.value).toBe('');
    submit(form);
    expect(visibleText(form)).toContain('Nothing has changed yet.');
    typeInto(field, '2 TB');
    submit(form);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(dialog()).toBeNull();
    typeInto(field, '2');
    submit(form);
    await flush();
    expect(dialog().querySelector('.ui-dialog-body').textContent).toBe('Plan limit → 2.0 GB');
    await giveReason('Podcast project');
    expect(adminApi.updateAccount).toHaveBeenLastCalledWith({id: 'user2', status: 'active', byteLimit: 2 * GB, notes: 'Beta tester.', reason: 'Podcast project'});
    expect(toastText()).toBe('Storage override saved.');
    typeInto(field, '');
    submit(form);
    await flush();
    expect(dialog().querySelector('.ui-dialog-body').textContent).toBe('2.0 GB → Plan limit');
    await giveReason('Back to normal');
    expect(adminApi.updateAccount).toHaveBeenLastCalledWith({id: 'user2', status: 'active', byteLimit: null, notes: 'Beta tester.', reason: 'Back to normal'});
    typeInto(field, '0');
    submit(form);
    await flush();
    await giveReason('Abuse report');
    expect(adminApi.updateAccount).toHaveBeenLastCalledWith(expect.objectContaining({byteLimit: 0}));
  });

  test('notes: saved through the dialog; a live update never overwrites what the administrator is typing', async () => {
    await mountAccount();
    const area = one('textbox', 'Private notes');
    expect(area.value).toBe('Beta tester.');
    typeInto(area, 'Beta tester. Prefers email.');
    area.dispatchEvent(new window.Event('blur'));
    api.data.accounts.user2 = {...api.data.accounts.user2, usedBytes: 990 * MB};
    api.emitAccount('user2');
    expect(area.value).toBe('Beta tester. Prefers email.');
    submit(area.closest('form'));
    await flush();
    expect(dialog().querySelector('.ui-dialog-title').textContent).toBe('Save the notes?');
    await giveReason('Support call');
    expect(adminApi.updateAccount).toHaveBeenCalledWith({id: 'user2', status: 'active', byteLimit: null, notes: 'Beta tester. Prefers email.', reason: 'Support call'});
    expect(toastText()).toBe('Notes saved.');
    // Another administrator's edit arrives while this one has not typed: it shows.
    api.data.accounts.user2 = {...api.data.accounts.user2, notes: 'Beta tester. Prefers email. VIP.'};
    api.emitAccount('user2');
    expect(area.value).toBe('Beta tester. Prefers email. VIP.');
  });

  test('a refused change keeps the dialog open with the server’s reason', async () => {
    adminApi.updateAccount.mockRejectedValueOnce(Object.assign(new Error('Notes are limited to 4000 characters.'), {code: 'invalid', data: {field: 'notes'}}));
    await mountAccount();
    typeInto(one('textbox', 'Private notes'), 'x');
    submit(one('textbox', 'Private notes').closest('form'));
    await flush();
    await giveReason('Tidy up');
    expect(dialog().querySelector('.ui-dialog-error').textContent).toContain('Notes are limited to 4000 characters.');
    expect(toastText()).toBeNull();
  });

  test('computers: presence from lastSeenAt, who revoked, and Revoke… on active ones only', async () => {
    await mountAccount();
    const rows = [...host.querySelectorAll('.admin-items')[0].children];
    expect(rows.map(r => visibleText(r.querySelector('.admin-item-text')))).toEqual([
      'Dana’s MacBook Pro Online', 'Studio PC Last seen 3 days ago', 'Old laptop Revoked by its owner',
      'Loaner Mac mini Revoked by an administrator', 'New desktop Never seen']);
    expect(byRole('button').filter(b => accName(b).startsWith('Revoke')).map(accName))
      .toEqual(['Revoke Dana’s MacBook Pro…', 'Revoke Studio PC…', 'Revoke New desktop…']);
    one('button', 'Revoke Studio PC…').click();
    await flush();
    expect(dialog().querySelector('.ui-dialog-title').textContent).toBe('Revoke “Studio PC”?');
    await giveReason('Sold the computer');
    expect(adminApi.revokeDevice).toHaveBeenCalledWith({id: 'd2', reason: 'Sold the computer'});
    expect(toastText()).toBe('Studio PC revoked.');
    api.data.accounts.user2.devices[1] = {...api.data.accounts.user2.devices[1], revoked: true, revokedBy: 'admin'};
    api.emitAccount('user2');
    expect(byRole('button', 'Revoke Studio PC…')).toHaveLength(0);
  });

  test('presence lines follow the clock', async () => {
    vi.useFakeTimers({toFake: ['setInterval', 'clearInterval']});
    try {
      let now = NOW;
      clock.set(() => now);
      await mountAccount();
      expect(host.querySelector('.admin-item-meta').textContent).toBe('Online');
      now = NOW + 10 * MIN;
      vi.advanceTimersByTime(admin.TICK_MS);
      expect(host.querySelector('.admin-item-meta').textContent).toBe('Last seen 10 min ago');
    } finally {
      vi.useRealTimers();
    }
  });

  test('jobs: Cancel… on queued, running and bot-check-waiting jobs only; it asks for a reason', async () => {
    await mountAccount();
    expect(byRole('button').filter(b => accName(b).startsWith('Cancel ')).map(accName))
      .toEqual(['Cancel Paper Boats…', 'Cancel Harbor Lights…', 'Cancel Undertow…']);
    const rows = [...host.querySelectorAll('.admin-items')[1].children];
    expect(visibleText(rows[2].querySelector('.admin-item-text'))).toBe('Undertow Waiting to retry Sign in to confirm you’re not a bot. 30 min ago');
    expect(visibleText(rows[5].querySelector('.admin-item-text'))).toBe('Untitled job Cancelled · download 6 days ago');
    one('button', 'Cancel Undertow…').click();
    await flush();
    const [keep, confirm] = dialog().querySelectorAll('.ui-dialog-action');
    expect([keep.textContent, confirm.textContent]).toEqual(['Keep it', 'Cancel job']);
    await giveReason('Bot check loop');
    expect(adminApi.cancelJob).toHaveBeenCalledWith({id: 'j2', reason: 'Bot check loop'});
    expect(toastText()).toBe('Undertow cancelled.');
  });

  test('the account’s history loads with its target, names its computers, and reloads after a change', async () => {
    await mountAccount();
    expect(adminApi.history).toHaveBeenCalledWith({targetId: 'user2', cursor: null});
    const rows = [...host.querySelectorAll('.admin-audit-row')];
    expect(rows.map(visibleText)).toEqual(['Computer revoked last week Computer: Loaner Mac mini “Lost in transit” by you']);
    adminApi.history.mockClear();
    one('button', 'Revoke New desktop…').click();
    await flush();
    await giveReason('Unknown machine');
    expect(adminApi.history).toHaveBeenCalledWith({targetId: 'user2', cursor: null});
  });

  test('an account that does not exist says so under one h1, with Back to leave', async () => {
    await mountAccount('nobody');
    expect(byRole('heading').map(el => `${el.tagName}:${accName(el)}`)).toEqual(['H1:Account not found']);
    expect(visibleText(host.querySelector('.admin-missing'))).toBe(account.COPY.notFoundBody);
    expect(byRole('button', 'Administration')).toHaveLength(1);
    expect(host.querySelector('.admin-account-body').hidden).toBe(true);
  });

  test('a failed load offers Retry, which subscribes again', async () => {
    api.data.accountErrors = [Object.assign(new Error('Connection lost.'), {code: 'unknown'})];
    await mountAccount();
    const alert = one('alert', undefined, host);
    expect(alert.textContent).toContain('Connection lost.');
    alert.querySelector('button').click();
    await flush();
    expect(one('heading', 'Dana Ruiz')).toBeTruthy();
    expect(host.querySelector('.admin-load-error').hidden).toBe(true);
  });

  test('update(match) to another account resubscribes; unmount unsubscribes', async () => {
    await mountAccount();
    view.update({name: 'adminAccount', params: {id: 'user1'}, query: {}});
    await flush();
    expect(one('heading', 'Kyle Kincer')).toBeTruthy();
    expect(api.subs.account.get('user2').size).toBe(0);
    await view.unmount();
    view = null;
    expect(api.subs.account.get('user1').size).toBe(0);
  });
});
