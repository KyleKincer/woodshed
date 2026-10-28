// Fixture handlers for the signed-in account: users, admin, billing and storage.
//   fx-auth=fail   users:me fails like a lost connection (the fatal boot card)
//   fx-admin=1     the account is an administrator; without it every admin query and
//                  mutation but admin:access is refused (not_owner), as requireAdmin does
// (fx-auth=suspended|export_only and fx-billing=… shape the seed, db/seed.js.)
//
// Administration is stateful, with convex/admin.ts's rules and response shapes (ported from
// SE3's harness, tests/harness/settings/admin.harness.js). Its tables live in `db.admin`,
// created from the seed's clock on first use and persisted with the rest of the db:
//   users     user1 (the signed-in administrator, db.user), user2 Dana Ruiz (devices, jobs,
//             notes), user3 export-only and over its limit, user4 suspended
//   controls  {[userId]: {status, byteLimit, notes}} (accountControls)
//   devices   d1 online · d2 seen 3 days ago · d3 revoked by its owner · d4 revoked by an
//             admin · d5 never seen (all Dana's)
//   jobs      j1 running · j2 bot check waiting for its retry · j3 queued · j4 done ·
//             j5 failed · j6 canceled (all Dana's)
//   audit     a1–a4, newest first; every admin mutation adds a row
// Ids follow v.id(): `user<N>` and `nobody` (a well-formed id of a deleted account) are
// well formed; anything else fails admin:account with the validator's uncoded error.
import {db, fx, clone, wait, convexError, DAY} from './runtime.js';

const GB = 1e9, MB = 1e6, MIN = 6e4;

/** The admin tables for a fresh seed (now = db.meta.seededAt). */
export function seedAdmin(now, user = {}) {
  return {
    users: [
      {id: 'user1', name: user.name ?? 'Kyle Kincer', email: user.email ?? 'kyle@example.com', createdAt: now - 400 * DAY, emailVerified: true, admin: true, usedBytes: 412 * MB},
      {id: 'user2', name: 'Dana Ruiz', email: 'dana@example.com', createdAt: now - 120 * DAY, emailVerified: true, admin: false, usedBytes: 980 * MB},
      {id: 'user3', name: '', email: 'sam.l@example.com', createdAt: now - 60 * DAY, emailVerified: false, admin: false, usedBytes: 2.1 * GB},
      {id: 'user4', name: 'Theo Park', email: 'theo@example.com', createdAt: now - 9 * DAY, emailVerified: true, admin: false, usedBytes: 0},
    ],
    controls: {
      user2: {status: 'active', byteLimit: null, notes: 'Beta tester. Asked about FLAC export.'},
      user3: {status: 'export_only', byteLimit: null, notes: 'Over limit after downgrade.'},
      user4: {status: 'suspended', byteLimit: null, notes: ''},
    },
    devices: [
      {id: 'd1', userId: 'user2', name: 'Dana’s MacBook Pro', revoked: false, revokedBy: null, lastSeenAt: now - 20_000},
      {id: 'd2', userId: 'user2', name: 'Studio PC', revoked: false, revokedBy: null, lastSeenAt: now - 3 * DAY},
      {id: 'd3', userId: 'user2', name: 'Old laptop', revoked: true, revokedBy: 'user', lastSeenAt: now - 90 * DAY},
      {id: 'd4', userId: 'user2', name: 'Loaner Mac mini', revoked: true, revokedBy: 'admin', lastSeenAt: null},
      {id: 'd5', userId: 'user2', name: 'New desktop', revoked: false, revokedBy: null, lastSeenAt: null},
    ],
    jobs: [
      {id: 'j1', userId: 'user2', label: 'Harbor Lights', status: 'running', stage: 'separate', createdAt: now - 4 * MIN},
      {id: 'j2', userId: 'user2', label: 'Undertow', status: 'error', stage: 'download', error: 'Sign in to confirm you’re not a bot.', retryAt: now + 5 * MIN, createdAt: now - 30 * MIN},
      {id: 'j3', userId: 'user2', label: 'Paper Boats', status: 'queued', stage: 'queued', createdAt: now - 2 * MIN},
      {id: 'j4', userId: 'user2', label: 'Glasshouse', status: 'done', stage: 'done', createdAt: now - 2 * DAY},
      {id: 'j5', userId: 'user2', label: 'Night Drive', status: 'error', stage: 'separate', error: 'Separation failed: out of memory (CUDA).', createdAt: now - 5 * DAY},
      {id: 'j6', userId: 'user2', label: 'Low Tide', status: 'canceled', stage: 'download', createdAt: now - 6 * DAY},
    ],
    audit: [
      {_id: 'a1', actorId: 'user1', targetId: 'app', action: 'policy.update', reason: 'Raise default limit for launch', at: now - DAY,
        before: {baseAppBytes: 150 * GB, fundedBytes: 50 * GB, userBytes: 500 * MB, appBytes: 200 * GB}, after: {userBytes: GB, appBytes: 150 * GB}},
      {_id: 'a2', actorId: 'user1', targetId: 'user3', action: 'account.update', reason: 'Over limit after downgrade', at: now - 3 * DAY,
        before: {status: 'active', byteLimit: null, notes: ''}, after: {status: 'export_only', byteLimit: null, notes: 'Over limit after downgrade.'}},
      {_id: 'a3', actorId: 'user1', targetId: 'user2', action: 'device.revoke', reason: 'Lost in transit', at: now - 8 * DAY,
        before: {id: 'd4', revoked: false, revokedBy: null}, after: {revoked: true, revokedBy: 'admin'}},
      {_id: 'a4', actorId: 'user9', targetId: 'user2', action: 'job.cancel', reason: 'Stuck after the 2.0 update', at: now - 20 * DAY,
        before: {id: 'j6', status: 'running'}, after: {status: 'canceled'}},
    ],
    policy: {userBytes: GB, baseAppBytes: 150 * GB},
    fundedBytes: 50 * GB,
    appUsed: 61.2 * GB,
    seq: 100,
  };
}

const state = () => (db.admin ??= seedAdmin(db.meta?.seededAt ?? Date.now(), db.user ?? {}));
const actorId = () => db.user?._id ?? 'user1';

function requireAdmin() {
  if (fx.admin !== '1') throw convexError({code: 'not_owner', message: 'Administrator access required.'});
  return actorId();
}
function reason(text) {
  const t = String(text ?? '').trim();
  if (t.length < 3 || String(text ?? '').length > 500) throw convexError({code: 'invalid', message: 'Enter a reason (3–500 characters).', field: 'reason'});
  return t;
}
function byteLimit(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw convexError({code: 'invalid', message: 'Storage limits must be nonnegative whole bytes.'});
}
/** As v.id('users') refuses an id of the wrong shape: an uncoded error. */
function userId(id) {
  if (typeof id !== 'string' || !/^(user\d+|nobody)$/.test(id)) throw new Error(`Validator error: Expected ID for table "users", got \`${id}\``);
  return id;
}
/** paginate() over rows already in order; numItems is capped at 50 like the server. */
function pageOf(rows, {cursor, numItems} = {}) {
  const start = cursor ? Number(cursor) : 0;
  const page = rows.slice(start, start + Math.min(50, numItems ?? 25));
  const end = start + page.length;
  return {page: clone(page), isDone: end >= rows.length, continueCursor: end >= rows.length ? null : String(end)};
}
function audit(targetId, action, why, before, after) {
  const s = state();
  s.audit.unshift({_id: `a${++s.seq}`, actorId: actorId(), targetId, action, reason: why, before, after, at: Date.now()});
}

const control = id => state().controls[id] ?? {status: 'active', byteLimit: null, notes: ''};
const limitOf = id => control(id).byteLimit ?? state().policy.userBytes;
const accountRow = u => ({id: u.id, name: u.name, email: u.email, createdAt: u.createdAt, status: control(u.id).status, usedBytes: u.usedBytes, limitBytes: limitOf(u.id), admin: u.admin});

/** users:me as convex/users.ts returns it: `id`, not the stored row's `_id`; no null picture. */
function me() {
  const u = db.user;
  if (!u) return null;
  return {id: u._id, name: u.name, email: u.email, ...(u.picture != null ? {picture: u.picture} : {}), status: u.status ?? 'active'};
}

export const handlers = {
  'users:me': async () => { if (fx.auth === 'fail') { await wait(600); throw new Error('[CONVEX Q(users:me)] Connection lost while action was in flight'); } return me(); },
  'admin:access': () => fx.admin === '1',
  'admin:overview': () => {
    requireAdmin();
    const s = state();
    return {baseAppBytes: s.policy.baseAppBytes, fundedBytes: s.fundedBytes, userBytes: s.policy.userBytes, appBytes: s.policy.baseAppBytes + s.fundedBytes, usedBytes: s.appUsed};
  },
  'admin:accounts': ({paginationOpts, email} = {}) => {
    requireAdmin();
    const exact = email?.trim();
    const rows = (exact ? state().users.filter(u => u.email === exact) : [...state().users]).sort((a, b) => b.createdAt - a.createdAt);
    const result = pageOf(rows, paginationOpts);
    return {...result, page: result.page.map(accountRow)};
  },
  'admin:account': ({id} = {}) => {
    requireAdmin();
    userId(id);
    const s = state();
    const u = s.users.find(x => x.id === id);
    if (!u) throw convexError({code: 'not_found', message: 'Account not found.'});
    const c = control(id);
    return clone({...accountRow(u), emailVerified: u.emailVerified, byteLimit: c.byteLimit, notes: c.notes,
      devices: s.devices.filter(d => d.userId === id).map(({userId: _, ...d}) => d),
      jobs: s.jobs.filter(j => j.userId === id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 30).map(({userId: _, ...j}) => j)});
  },
  'admin:history': ({targetId, paginationOpts} = {}) => {
    requireAdmin();
    const rows = targetId ? state().audit.filter(a => a.targetId === targetId) : state().audit;
    return pageOf(rows, paginationOpts);
  },
  'admin:updateAccount': args => {
    requireAdmin();
    const why = reason(args.reason);
    const s = state();
    const u = s.users.find(x => x.id === userId(args.id));
    if (!u) throw convexError({code: 'not_found', message: 'Account not found.'});
    if (u.admin && args.status !== 'active') throw convexError({code: 'invalid', message: 'An administrator account cannot be restricted.'});
    if (args.byteLimit !== null) byteLimit(args.byteLimit);
    if (String(args.notes ?? '').length > 4000) throw convexError({code: 'invalid', message: 'Notes are limited to 4000 characters.', field: 'notes'});
    const before = s.controls[args.id] ? {...s.controls[args.id]} : null;
    const after = {status: args.status, byteLimit: args.byteLimit, notes: args.notes};
    s.controls[args.id] = {...after};
    audit(args.id, 'account.update', why, before, after);
    return null;
  },
  'admin:updatePolicy': args => {
    requireAdmin();
    const why = reason(args.reason);
    byteLimit(args.userBytes); byteLimit(args.appBytes);
    const s = state();
    const before = {baseAppBytes: s.policy.baseAppBytes, fundedBytes: s.fundedBytes, userBytes: s.policy.userBytes, appBytes: s.policy.baseAppBytes + s.fundedBytes};
    s.policy = {userBytes: args.userBytes, baseAppBytes: args.appBytes};
    audit('app', 'policy.update', why, before, {userBytes: args.userBytes, appBytes: args.appBytes});
    return null;
  },
  'admin:revokeDevice': args => {
    requireAdmin();
    const why = reason(args.reason);
    const d = state().devices.find(x => x.id === args.id);
    if (!d) throw convexError({code: 'not_found', message: 'Device not found.'});
    const before = {id: d.id, revoked: d.revoked, revokedBy: d.revokedBy ?? null};
    Object.assign(d, {revoked: true, revokedBy: 'admin'});
    audit(d.userId, 'device.revoke', why, before, {revoked: true, revokedBy: 'admin'});
    return null;
  },
  'admin:cancelJob': args => {
    requireAdmin();
    const why = reason(args.reason);
    const j = state().jobs.find(x => x.id === args.id);
    // A bot-checked job waiting for its automatic retry is still live.
    const live = j && (j.status === 'queued' || j.status === 'running' || (j.status === 'error' && j.retryAt != null));
    if (!live) throw convexError({code: 'invalid', message: 'Job is no longer active.'});
    const before = {id: j.id, status: j.status};
    j.status = 'canceled';
    delete j.retryAt;
    audit(j.userId, 'job.cancel', why, before, {status: 'canceled'});
    return null;
  },
  'storage:usage': () => ({usedBytes: db.billing.usedBytes, limitBytes: db.billing.limitBytes, appFull: false}),
  'billingData:status': () => clone(db.billing),
  'billing:checkout': async () => { await wait(800); throw convexError('Checkout is not available in the fixture.'); },
  'billing:portal': async () => { await wait(800); throw convexError('The billing portal is not available in the fixture.'); },
};
