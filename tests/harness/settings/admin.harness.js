// SE3's harness (/__harness/admin): Administration on the real views (src/settings/admin/admin.js and
// account.js) in the top-bar frame, through the real client (auth.initialize on the fixture), with a
// stateful admin backend installed over the fixture's static admin handlers for this page only: every
// mutation works, writes the audit log and refreshes the live queries.
//   ?page=admin (default)        /admin: storage cards, policy form, accounts, audit history
//     email=<address>            the account search prefilled (exact match)
//     many=1                     60 accounts and 40 audit rows, so both lists offer Load more
//   ?page=account&id=<userId>    /admin/accounts/:id (default user2, Dana Ruiz; user1 is the admin
//                                Kyle Kincer; user3 is export-only and over its limit)
//   open=policy|access|override|notes|revoke|cancel
//                                opens that change's Reason dialog (policy: the default limit becomes
//                                2 GB; access: Export only; override: 2 GB; notes: an added line;
//                                revoke: the online computer; cancel: the running job)
//   reason=<text>                types it into the open dialog's Reason field
//   submit=1                     then presses the dialog's confirm action
//   fail=load|save               the page's first query fails · every change is refused
//   slow=1                       changes take 30 s (the busy dialog)
//   empty=1                      no computers, jobs or history on the account
// window.__admin = {state, router, view, open(name)} for states.
import {h} from '/src/ui/h.js';
import {signal, store} from '/src/app/store.js';
import {handlers} from '/tests/fixture/db/index.js';

const GB = 1e9, MB = 1e6, MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const user = {id: 'user1', name: 'Kyle Kincer', email: 'kyle@example.com', image: null};

/** Errors the way Convex delivers a ConvexError (client.js turns it into an ApiError). */
function coded(code, message, extra = {}) {
  const error = new Error(message);
  error.data = {code, message, ...extra};
  return error;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function seed(now, query) {
  const many = query.get('many') === '1';
  const empty = query.get('empty') === '1';
  const users = [
    {id: 'user1', name: 'Kyle Kincer', email: 'kyle@example.com', createdAt: now - 400 * DAY, emailVerified: true, admin: true, usedBytes: 412 * MB},
    {id: 'user2', name: 'Dana Ruiz', email: 'dana@example.com', createdAt: now - 120 * DAY, emailVerified: true, admin: false, usedBytes: 980 * MB},
    {id: 'user3', name: '', email: 'sam.l@example.com', createdAt: now - 60 * DAY, emailVerified: false, admin: false, usedBytes: 2.1 * GB},
    {id: 'user4', name: 'Theo Park', email: 'theo@example.com', createdAt: now - 9 * DAY, emailVerified: true, admin: false, usedBytes: 0},
  ];
  if (many) for (let i = 5; i <= 60; i++) users.push({id: `user${i}`, name: `Player ${i}`, email: `player${i}@example.com`, createdAt: now - i * DAY, emailVerified: true, admin: false, usedBytes: (i * 37 % 900) * MB});
  const controls = {user3: {status: 'export_only', byteLimit: null, notes: 'Over limit after downgrade.'}, user4: {status: 'suspended', byteLimit: null, notes: ''},
    user2: {status: 'active', byteLimit: null, notes: 'Beta tester. Asked about FLAC export.'}};
  const devices = empty ? [] : [
    {id: 'd1', userId: 'user2', name: 'Dana’s MacBook Pro', revoked: false, revokedBy: null, lastSeenAt: now - 20_000},
    {id: 'd2', userId: 'user2', name: 'Studio PC', revoked: false, revokedBy: null, lastSeenAt: now - 3 * DAY},
    {id: 'd3', userId: 'user2', name: 'Old laptop', revoked: true, revokedBy: 'user', lastSeenAt: now - 90 * DAY},
    {id: 'd4', userId: 'user2', name: 'Loaner Mac mini', revoked: true, revokedBy: 'admin', lastSeenAt: null},
    {id: 'd5', userId: 'user2', name: 'New desktop', revoked: false, revokedBy: null, lastSeenAt: null},
  ];
  const jobs = empty ? [] : [
    {id: 'j1', userId: 'user2', label: 'Harbor Lights', status: 'running', stage: 'separate', createdAt: now - 4 * MIN},
    {id: 'j2', userId: 'user2', label: 'Undertow', status: 'error', stage: 'download', error: 'Sign in to confirm you’re not a bot.', retryAt: now + 5 * MIN, createdAt: now - 30 * MIN},
    {id: 'j3', userId: 'user2', label: 'Paper Boats', status: 'queued', stage: 'queued', createdAt: now - 2 * MIN},
    {id: 'j4', userId: 'user2', label: 'Glasshouse', status: 'done', stage: 'done', createdAt: now - 2 * DAY},
    {id: 'j5', userId: 'user2', label: 'Night Drive', status: 'error', stage: 'separate', error: 'Separation failed: out of memory (CUDA).', createdAt: now - 5 * DAY},
    {id: 'j6', userId: 'user2', label: 'Low Tide', status: 'canceled', stage: 'download', createdAt: now - 6 * DAY},
  ];
  const audit = [];
  if (!empty) {
    audit.push({_id: 'a1', actorId: 'user1', targetId: 'app', action: 'policy.update', reason: 'Raise default limit for launch', at: now - DAY,
      before: {baseAppBytes: 150 * GB, fundedBytes: 50 * GB, userBytes: 500 * MB, appBytes: 200 * GB}, after: {userBytes: GB, appBytes: 150 * GB}});
    audit.push({_id: 'a2', actorId: 'user1', targetId: 'user3', action: 'account.update', reason: 'Over limit after downgrade', at: now - 3 * DAY,
      before: {status: 'active', byteLimit: null, notes: ''}, after: {status: 'export_only', byteLimit: null, notes: 'Over limit after downgrade.'}});
    audit.push({_id: 'a3', actorId: 'user1', targetId: 'user2', action: 'device.revoke', reason: 'Lost in transit', at: now - 8 * DAY,
      before: {id: 'd4', revoked: false, revokedBy: null}, after: {revoked: true, revokedBy: 'admin'}});
    audit.push({_id: 'a4', actorId: 'user9', targetId: 'user2', action: 'job.cancel', reason: 'Stuck after the 2.0 update', at: now - 20 * DAY,
      before: {id: 'j6', status: 'running'}, after: {status: 'canceled'}});
    if (many) for (let i = 5; i < 41; i++) audit.push({_id: `a${i}`, actorId: 'user1', targetId: `user${i}`, action: 'account.update', reason: `Support ticket #${1000 + i}`,
      at: now - (20 + i) * DAY, before: null, after: {status: 'active', byteLimit: 2 * GB, notes: ''}});
  }
  return {users, controls, devices, jobs, audit, policy: {userBytes: GB, baseAppBytes: 150 * GB}, fundedBytes: 50 * GB, appUsed: 61.2 * GB, seq: 100};
}

/** The stateful admin backend over `state`, with convex/admin.ts's rules and response shapes. */
function backend(state, {now, fail, slow}) {
  const control = id => state.controls[id] ?? {status: 'active', byteLimit: null, notes: ''};
  const userBytes = () => state.policy.userBytes;
  const limitOf = id => control(id).byteLimit ?? userBytes();
  const reason = text => {
    const t = String(text ?? '').trim();
    if (t.length < 3 || t.length > 500) throw coded('invalid', 'Enter a reason (3–500 characters).', {field: 'reason'});
    return t;
  };
  const audit = (actorId, targetId, action, why, before, after) => state.audit.unshift({_id: `a${++state.seq}`, actorId, targetId, action, reason: why, before, after, at: now()});
  const pageOf = (rows, {cursor, numItems}) => {
    const start = cursor ? Number(cursor) : 0;
    const n = Math.min(50, numItems ?? 25);
    const page = rows.slice(start, start + n);
    const end = start + page.length;
    return {page, isDone: end >= rows.length, continueCursor: end >= rows.length ? null : String(end)};
  };
  const firstLoad = new Set();
  const loadFails = name => { if (fail === 'load' && !firstLoad.has(name)) { firstLoad.add(name); throw coded('unknown', 'Connection lost while the query was in flight.'); } };
  const mutate = async fn => {
    if (slow) await wait(30_000);
    if (fail === 'save') throw coded('invalid', 'Notes are limited to 4000 characters.', {field: 'notes'});
    return fn();
  };
  const row = u => ({id: u.id, name: u.name, email: u.email, createdAt: u.createdAt, status: control(u.id).status, usedBytes: u.usedBytes, limitBytes: limitOf(u.id), admin: u.admin});
  return {
    'admin:access': () => true,
    'admin:overview': () => {
      loadFails('overview');
      return {baseAppBytes: state.policy.baseAppBytes, fundedBytes: state.fundedBytes, userBytes: userBytes(),
        appBytes: state.policy.baseAppBytes + state.fundedBytes, usedBytes: state.appUsed};
    },
    'admin:accounts': ({paginationOpts, email}) => {
      const rows = (email ? state.users.filter(u => u.email === email.trim()) : [...state.users]).sort((a, b) => b.createdAt - a.createdAt);
      const result = pageOf(rows, paginationOpts ?? {});
      return {...result, page: result.page.map(row)};
    },
    'admin:account': ({id}) => {
      loadFails('account');
      const u = state.users.find(x => x.id === id);
      if (!u) throw coded('not_found', 'Account not found.');
      const c = control(id);
      return {...row(u), emailVerified: u.emailVerified, byteLimit: c.byteLimit, notes: c.notes,
        devices: state.devices.filter(d => d.userId === id).map(({userId, ...d}) => ({...d})),
        jobs: state.jobs.filter(j => j.userId === id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 30).map(({userId, ...j}) => ({...j}))};
    },
    'admin:history': ({targetId, paginationOpts}) => pageOf(targetId ? state.audit.filter(a => a.targetId === targetId) : state.audit, paginationOpts ?? {}),
    'admin:updateAccount': args => mutate(() => {
      const why = reason(args.reason);
      const u = state.users.find(x => x.id === args.id);
      if (!u) throw coded('not_found', 'Account not found.');
      if (u.admin && args.status !== 'active') throw coded('invalid', 'An administrator account cannot be restricted.');
      if (args.byteLimit !== null && (!Number.isSafeInteger(args.byteLimit) || args.byteLimit < 0)) throw coded('invalid', 'Storage limits must be nonnegative whole bytes.');
      if (args.notes.length > 4000) throw coded('invalid', 'Notes are limited to 4000 characters.', {field: 'notes'});
      const before = state.controls[args.id] ? {...state.controls[args.id]} : null;
      state.controls[args.id] = {status: args.status, byteLimit: args.byteLimit, notes: args.notes};
      audit(user.id, args.id, 'account.update', why, before, {status: args.status, byteLimit: args.byteLimit, notes: args.notes});
      return null;
    }),
    'admin:updatePolicy': args => mutate(() => {
      const why = reason(args.reason);
      for (const v of [args.userBytes, args.appBytes]) if (!Number.isSafeInteger(v) || v < 0) throw coded('invalid', 'Storage limits must be nonnegative whole bytes.');
      const before = {baseAppBytes: state.policy.baseAppBytes, fundedBytes: state.fundedBytes, userBytes: userBytes(), appBytes: state.policy.baseAppBytes + state.fundedBytes};
      state.policy = {userBytes: args.userBytes, baseAppBytes: args.appBytes};
      audit(user.id, 'app', 'policy.update', why, before, {userBytes: args.userBytes, appBytes: args.appBytes});
      return null;
    }),
    'admin:revokeDevice': args => mutate(() => {
      const why = reason(args.reason);
      const d = state.devices.find(x => x.id === args.id);
      if (!d) throw coded('not_found', 'Device not found.');
      const before = {id: d.id, revoked: d.revoked, revokedBy: d.revokedBy};
      Object.assign(d, {revoked: true, revokedBy: 'admin'});
      audit(user.id, d.userId, 'device.revoke', why, before, {revoked: true, revokedBy: 'admin'});
      return null;
    }),
    'admin:cancelJob': args => mutate(() => {
      const why = reason(args.reason);
      const j = state.jobs.find(x => x.id === args.id);
      const live = j && (j.status === 'queued' || j.status === 'running' || (j.status === 'error' && j.retryAt != null));
      if (!live) throw coded('invalid', 'Job is no longer active.');
      const before = {id: j.id, status: j.status};
      Object.assign(j, {status: 'canceled', retryAt: undefined});
      delete j.retryAt;
      audit(user.id, j.userId, 'job.cancel', why, before, {status: 'canceled'});
      return null;
    }),
  };
}

/** A router that records what the views ask for (links included). */
function fakeRouter() {
  const log = [];
  return {
    log,
    current: signal({name: 'admin', path: '/admin', params: {}, query: {}}),
    navigate(to, opts) { log.push(['navigate', to, opts ?? null]); },
    back(opts) { log.push(['back', opts ?? null]); },
    setQuery(patch) { log.push(['setQuery', patch]); },
  };
}

const waitFor = (read, timeoutMs = 5000) => new Promise((resolve, reject) => {
  const started = performance.now();
  const step = () => {
    const value = read();
    if (value) { resolve(value); return; }
    if (performance.now() - started > timeoutMs) { reject(new Error('admin harness: timed out')); return; }
    setTimeout(step, 30);
  };
  step();
});

export default async function mount(el, {fixture, query}) {
  const now = () => fixture?.now?.() ?? Date.now();
  const state = seed(now(), query);
  Object.assign(handlers, backend(state, {now, fail: query.get('fail'), slow: query.get('slow') === '1'}));

  const [auth, {mountTopbar}, {registry}, {startDispatcher}, {desktop}] = await Promise.all([
    import('/src/app/auth.js'), import('/src/app/topbar.js'), import('/src/app/commands.js'), import('/src/app/dispatch.js'),
    import('/src/app/desktop.js'), import('/src/app/global-commands.js'),
  ]);
  const {user: signedIn} = await auth.initialize();
  store.session.value = {user: {...user, ...signedIn, id: signedIn?.id ?? user.id}, status: 'active', admin: true, online: true};
  const router = fakeRouter();
  registry.provide('router', () => router);
  startDispatcher({registry});

  el.style.padding = '0';
  el.style.overflow = 'hidden';
  el.style.height = '100%';
  const header = h('header', {class: 'app-topbar'});
  const outlet = h('main', {class: 'app-main'});
  el.replaceChildren(h('div', {class: 'app-frame', dataset: {chrome: 'topbar'}, style: {height: '100%'}}, header, outlet));
  mountTopbar(header, {router, store, desktop, registry});
  outlet.addEventListener('click', e => {
    const a = e.target.closest?.('a[href]');
    if (!a || e.defaultPrevented) return;
    e.preventDefault();
    router.navigate(a.getAttribute('href'));
  });

  const page = query.get('page') === 'account' ? 'account' : 'admin';
  const id = query.get('id') || 'user2';
  const mod = page === 'account' ? await import('/src/settings/admin/account.js') : await import('/src/settings/admin/admin.js');
  const match = page === 'account'
    ? {name: 'adminAccount', path: `/admin/accounts/${id}`, params: {id}, query: {}}
    : {name: 'admin', path: '/admin', params: {}, query: query.get('email') ? {email: query.get('email')} : {}};
  const view = await mod.mount(outlet, match, {router, store, registry, desktop});

  const find = (selector, text) => [...outlet.querySelectorAll(selector)].find(n => !text || n.textContent.includes(text) || n.getAttribute('aria-label')?.includes(text));
  const setField = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', {bubbles: true})); };
  async function open(name) {
    if (name === 'policy') {
      setField(outlet.querySelector('.admin-policy-field input'), '2');
      outlet.querySelector('.admin-policy-save').click();
    } else if (name === 'access') {
      find('[role=radio]', 'Export only').click();
    } else if (name === 'override') {
      setField(outlet.querySelector('.admin-override-field input'), '2');
      find('button', 'Save override').click();
    } else if (name === 'notes') {
      const area = outlet.querySelector('.admin-notes-field textarea');
      setField(area, `${area.value}\nUpgraded to Plus on 28 Oct.`);
      find('button', 'Save notes').click();
    } else if (name === 'revoke') {
      find('button', 'Revoke Dana’s MacBook Pro').click();
    } else if (name === 'cancel') {
      find('button', 'Cancel Harbor Lights').click();
    }
    return waitFor(() => document.querySelector('dialog.admin-reason-dialog[open]'));
  }

  const opening = query.get('open');
  if (opening) {
    const dialog = await open(opening);
    const reason = query.get('reason');
    if (reason) setField(dialog.querySelector('input[name=reason]'), reason);
    if (query.get('submit') === '1') {
      dialog.querySelector('button[type=submit]').click();
      if (query.get('slow') !== '1') await waitFor(() => !dialog.isConnected || dialog.querySelector('[role=alert]:not([hidden]), .ui-dialog-field-error:not([hidden])'));
    }
  }
  window.__admin = {state, router, view, open};
}
