// Stand-in for 'convex/browser': every client talks to the in-memory db.
import {call, subscribe, fx} from '../db/index.js';
const nameOf = ref => typeof ref === 'string' ? ref : ref[Symbol.for('functionName')];
export class ConvexClient {
  constructor(url) { this.url = url; }
  query(ref, args) { return call('query', nameOf(ref), args); }
  mutation(ref, args) { return call('mutation', nameOf(ref), args); }
  action(ref, args) { return call('action', nameOf(ref), args); }
  onUpdate(ref, args, cb, onError) { return subscribe(nameOf(ref), args, cb, onError); }
  setAuth(fetchToken, onChange) { setTimeout(() => onChange?.(fx.auth !== 'unverified'), 0); }
  close() {}
}
export class ConvexHttpClient extends ConvexClient {}
export class BaseConvexClient {}
