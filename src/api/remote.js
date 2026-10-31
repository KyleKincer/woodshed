// The phone remote (2.1; convex/remote.ts). One-line wrappers; failures come out as ApiError
// (src/api/client.js) with the server's code: `not_found` (the host closed its song), `invalid`,
// `not_signed_in`.
//
// A host row: {hostId, name, platform?, songId?, title, artist?, seenAt}. A view: {host, state, updatedAt} or
// null, where state is what the host's HUD shows (convex/lib/validators.ts remoteStateValidator). `announce`
// and `watch` resolve {now}, the server's time: clients judge `seenAt`, `watchedAt` and `sentAt` by it.

import {mutation, query, subscribe} from './client.js';

/** Host: this device has a song open (also the heartbeat). `fresh` drops commands left from before. Resolves {now}. */
export const announce = (args) => mutation('remote:announce', args);
/** Host: the song closed here. */
export const close = ({hostId}) => mutation('remote:close', {hostId});
/** Host: what the HUD shows now. */
export const publish = ({hostId, state}) => mutation('remote:publish', {hostId, state});
/** Host: live commands waiting for this device. Returns off(). */
export const subscribeCommands = ({hostId}, onValue, onError) => subscribe('remote:commands', {hostId}, onValue, onError);
/** Host: these commands ran. */
export const ack = ({hostId, ids}) => mutation('remote:ack', {hostId, ids});

/** Remote: the account's hosts, most recently seen first. */
export const hosts = () => query('remote:hosts', {});
/** Remote: live `hosts`. Returns off(). */
export const subscribeHosts = (onValue, onError) => subscribe('remote:hosts', {}, onValue, onError);
/** Remote: live view of one host. Returns off(). */
export const subscribeView = ({hostId}, onValue, onError) => subscribe('remote:view', {hostId}, onValue, onError);
/** Remote: this host is open here (every HEARTBEAT_MS while it is). Resolves {now}; with no host, that is all. */
export const watch = ({hostId} = {}) => mutation('remote:watch', hostId ? {hostId} : {});
/** Remote: run a command on a host. Resolves {queued}. */
export const send = ({hostId, command}) => mutation('remote:send', {hostId, command});
