// Fixture handlers for the signed-in account: users, admin, billing and storage.
//   fx-auth=fail   users:me fails like a lost connection (the fatal boot card)
//   fx-admin=1     the account is an administrator
// (fx-auth=suspended|export_only and fx-billing=… shape the seed, db/seed.js.)
import {db, fx, clone, wait, convexError, DAY} from './runtime.js';

export const handlers = {
  'users:me': async () => { if (fx.auth === 'fail') { await wait(600); throw new Error('[CONVEX Q(users:me)] Connection lost while action was in flight'); } return clone(db.user); },
  'admin:access': () => fx.admin === '1',
  'admin:overview': () => ({usedBytes: 61.2e9, appBytes: 200e9, baseAppBytes: 150e9, userBytes: 1e9}),
  'admin:accounts': () => ({page: [
    {id: 'user1', name: 'Kyle Kincer', email: 'kyle@example.com', admin: true, status: 'active', usedBytes: 412e6, limitBytes: 1e9},
    {id: 'user2', name: 'Dana Ruiz', email: 'dana@example.com', admin: false, status: 'active', usedBytes: 980e6, limitBytes: 1e9},
    {id: 'user3', name: '', email: 'sam.l@example.com', admin: false, status: 'export_only', usedBytes: 2.1e9, limitBytes: 1e9},
    {id: 'user4', name: 'Theo Park', email: 'theo@example.com', admin: false, status: 'suspended', usedBytes: 0, limitBytes: 1e9},
  ], isDone: true, continueCursor: null}),
  'admin:account': ({id}) => ({id, name: 'Dana Ruiz', email: 'dana@example.com', emailVerified: true, createdAt: db.meta.seededAt - 120 * DAY, usedBytes: 980e6, limitBytes: 1e9, byteLimit: null, status: 'active', admin: false, notes: 'Beta tester. Asked about FLAC export.', devices: [{id: 'd1', name: 'Dana’s MacBook Pro', revoked: false}, {id: 'd2', name: 'Studio PC', revoked: true}], jobs: [{id: 'j1', label: 'Harbor Lights', status: 'running', stage: 'separate'}, {id: 'j2', label: 'Undertow', status: 'error', stage: 'download', error: 'YouTube blocked the download.'}]}),
  'admin:history': () => ({page: [{at: db.meta.seededAt - DAY, action: 'policy.update', targetId: 'app', reason: 'Raise default limit for launch', actorId: 'user1'}, {at: db.meta.seededAt - 3 * DAY, action: 'account.update', targetId: 'user3', reason: 'Over limit after downgrade', actorId: 'user1'}], isDone: true, continueCursor: null}),
  'storage:usage': () => ({usedBytes: db.billing.usedBytes, limitBytes: db.billing.limitBytes, appFull: false}),
  'billingData:status': () => clone(db.billing),
  'billing:checkout': async () => { await wait(800); throw convexError('Checkout is not available in the fixture.'); },
  'billing:portal': async () => { await wait(800); throw convexError('The billing portal is not available in the fixture.'); },
};
