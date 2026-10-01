// In-memory stand-in for src/js/notation/store.js used by the tempo-map fixture.
export class NotationStore {
  constructor(songId, onStatus = () => {}) { this.onStatus = onStatus; this.score = null; }
  async load() { this.onStatus('saved'); return this.score; }
  set(score) { this.score = structuredClone(score); window.fixtureScore = this.score; this.onStatus('saved'); }
  async flush() {}
  async reload() { return this.score; }
  destroy() {}
}
export const loadSharedNotation = async () => null;
export const watchSharedNotation = () => () => {};
