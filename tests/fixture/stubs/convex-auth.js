// Stand-in for '@convex-dev/auth/browser': a session that is already signed in
// (or signed out with ?fx-auth=signedout).
import {fx} from '../db.js';
export const defaultStorage = () => ({getItem: () => null, setItem() {}, removeItem() {}});
export class AuthClient {
  constructor() { this.listeners = new Set(); this.state = {isLoading: true, isAuthenticated: false}; }
  async init() { this.state = {isLoading: false, isAuthenticated: fx.auth !== 'signedout'}; this.listeners.forEach(fn => fn()); }
  getSnapshot() { return this.state; }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  fetchAccessToken = async () => 'fixture-token';
  async signOut() { this.state = {isLoading: false, isAuthenticated: false}; }
  ambientSignInValues() {
    const values = {flowError: fx.signinError ? {code: fx.signinError} : null, actions: {signIn: async () => { await new Promise(r => setTimeout(r, 400)); throw new Error('fixture'); }}};
    return {get: key => values[key], subscribe: () => () => {}};
  }
}
