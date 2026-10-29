// Fixture handlers for convex/settings.ts (architecture §6.5, BK4). They use the
// server's own rules from convex/lib/presets.ts: `config` merges the stored row
// (`db.settings`, null for fx-account=new) over the defaults; `patch` validates
// with `checkPatch`, keeps only pins of seeded songs, merges with
// `mergeSettings` and stores the result; `demo` serves `db.demoToken` when it is
// a 64-hex token. `settings.save` is gone (D42).
import {db, clone, convexError} from './runtime.js';

const PRESETS_P = import('../../../convex/lib/presets.ts');
const DEMO_TOKEN_RE = /^[a-f0-9]{64}$/;

export const handlers = {
  'settings:config': async () => {
    const p = await PRESETS_P;
    return {settings: clone(p.withDefaults(db.settings)), presets: p.PRESETS, defaultPreset: p.DEFAULT_PRESET, models: p.MODELS, stemModes: p.STEM_MODES, bitrates: p.BITRATES};
  },
  'settings:patch': async ({patch}) => {
    const p = await PRESETS_P;
    const checked = p.checkPatch(patch);
    if (!checked.ok) throw convexError({code: checked.code, message: checked.message, field: checked.field});
    const change = checked.patch;
    // Every seeded song belongs to the fixture's account; an unknown id is a deleted song and drops out.
    if (change.pins) change.pins = change.pins.filter(id => db.songs.some(s => s.id === id));
    db.settings = p.mergeSettings(p.withDefaults(db.settings), change);
    return clone(db.settings);
  },
  'settings:demo': () => (typeof db.demoToken === 'string' && DEMO_TOKEN_RE.test(db.demoToken) ? {token: db.demoToken} : null),
};
