// Administration (convex/admin.ts; architecture §2.1, §6.6). One-line wrappers over
// src/api/client.js; every failure is an ApiError ({code, message, data}).
//
//   access() → boolean                                   is the caller an administrator
//   overview() → {usedBytes, appBytes, baseAppBytes, fundedBytes, userBytes}
//   accounts({email?, cursor?, numItems?}) → {page: AccountRow[], isDone, continueCursor}
//     AccountRow {id, name, email, createdAt, status, usedBytes, limitBytes, admin}; `email` is an exact match
//   account({id}) → {id, name, email, createdAt, emailVerified, status, byteLimit: number|null, notes,
//                    usedBytes, limitBytes, admin,
//                    devices: [{id, name, revoked, revokedBy: 'user'|'admin'|null, lastSeenAt: number|null}],
//                    jobs: [{id, label, status, stage, error, createdAt, retryAt?}]}   (≤ 30 newest jobs)
//   history({targetId?, cursor?, numItems?}) → {page: AuditRow[], isDone, continueCursor}
//     AuditRow {_id, actorId, targetId, action, reason, before, after, at}; newest first
//   updateAccount({id, status, byteLimit, notes, reason}) → null      every field is written; send the current ones
//   updatePolicy({userBytes, appBytes, reason}) → null                appBytes is the base ceiling (paid capacity is added)
//   revokeDevice({id, reason}) → null                                 an admin revoke; the computer cannot pair again
//   cancelJob({id, reason}) → null                                    queued, running, or waiting for a bot-check retry
// Every mutation needs a reason of 3–500 characters (`invalid`, data.field 'reason').
import {mutation, query, subscribe} from './client.js';

/** Rows per page of the account list and the audit history (the server caps it at 50). */
export const PAGE_SIZE = 25;

const page = ({cursor = null, numItems = PAGE_SIZE} = {}) => ({cursor, numItems});

export const access = () => query('admin:access', {});
export const overview = () => query('admin:overview', {});
/** Live overview; returns off(). */
export const subscribeOverview = (onValue, onError) => subscribe('admin:overview', {}, onValue, onError);
export const accounts = ({email, ...opts} = {}) => query('admin:accounts', {paginationOpts: page(opts), ...(email ? {email} : {})});
export const account = ({id}) => query('admin:account', {id});
/** Live account page data; returns off(). */
export const subscribeAccount = ({id}, onValue, onError) => subscribe('admin:account', {id}, onValue, onError);
export const history = ({targetId, ...opts} = {}) => query('admin:history', {paginationOpts: page(opts), ...(targetId ? {targetId} : {})});
export const updateAccount = ({id, status, byteLimit, notes, reason}) => mutation('admin:updateAccount', {id, status, byteLimit, notes, reason});
export const updatePolicy = ({userBytes, appBytes, reason}) => mutation('admin:updatePolicy', {userBytes, appBytes, reason});
export const revokeDevice = ({id, reason}) => mutation('admin:revokeDevice', {id, reason});
export const cancelJob = ({id, reason}) => mutation('admin:cancelJob', {id, reason});
