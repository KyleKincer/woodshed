// Fixture handlers for convex/settings.ts. Created by FX1 with the 1.9 fixture's
// handlers moved verbatim; BK4 (wave 0B) owns the bodies from here on (§6.5:
// patch, demo; `save` is deleted). One adaptation to the v2 seed: `db.settings`
// is the stored row (with the 2.0 profile, pins, onboarding and practice
// defaults, or null for fx-account=new), so config merges it over the defaults
// as the server does. The demo share token is `db.demoToken`.
import {db, clone} from './runtime.js';

const PRESETS_P = import('../../../convex/lib/presets.ts');

export const handlers = {
  'settings:config': async () => {
    const p = await PRESETS_P;
    return {settings: clone(p.withDefaults(db.settings)), presets: p.PRESETS, defaultPreset: p.DEFAULT_PRESET, models: p.MODELS, stemModes: p.STEM_MODES, bitrates: p.BITRATES};
  },
  'settings:save': ({settings}) => { db.settings = clone(settings); return settings; },
};
