// Cloud storage usage (convex/storage.ts). One-line wrappers over src/api/client.js (§2.1).
//
//   usage() → {usedBytes, limitBytes, appFull}
import {query, subscribe} from './client.js';

export const usage = () => query('storage:usage', {});
/** Live usage (Settings → Plan & storage). Returns off(). */
export const subscribeUsage = (onValue, onError) => subscribe('storage:usage', {}, onValue, onError);
