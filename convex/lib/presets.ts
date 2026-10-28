// Quality presets and account settings: the single source of truth, shared by
// the browser (through the `config` query, and `src/app/account.js` for the
// defaults and the merge rule), the Convex functions, and the companion (the
// resolved `quality` travels in the claimed job).
//
// "shifts" is prediction averaging: htdemucs_ft runs 4 sub-models, so the total
// passes are 4 × max(1, shifts). It is the dominant cost of a separation.

export type Quality = {
  model: string;
  shifts: number;
  overlap: number;
  format: 'opus' | 'flac' | 'wav';
  bitrate?: number;
};

export const PRESETS = {
  studio: {
    id: 'studio',
    label: 'Studio',
    description: 'Best separation. Takes the longest.',
    model: 'htdemucs_ft',
    shifts: 10,
    overlap: 0.5,
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    description: 'Great quality without the long wait.',
    model: 'htdemucs_ft',
    shifts: 2,
    overlap: 0.25,
  },
  fast: {
    id: 'fast',
    label: 'Fast',
    description: 'Good for a quick pass.',
    model: 'htdemucs',
    shifts: 0,
    overlap: 0.25,
  },
} as const;

export const DEFAULT_PRESET = 'balanced';

export const MODELS = [
  { id: 'htdemucs_ft', label: 'Fine-tuned (best)' },
  { id: 'htdemucs', label: 'Standard' },
  { id: 'htdemucs_6s', label: 'With piano & guitar' },
  { id: 'mdx_extra', label: 'Alternative' },
];

/** The only model that separates guitar and piano; the `six` stem mode always runs it. */
export const SIX_STEM_MODEL = 'htdemucs_6s';

export const STEM_MODES = {
  full: { id: 'full', label: 'Full band (drums · bass · vocals · other)', twoStems: null },
  six: { id: 'six', label: 'Full band + guitar & piano · 6', twoStems: null },
  drums: { id: 'drums', label: 'Drums + everything else', twoStems: 'drums' },
  vocals: { id: 'vocals', label: 'Vocals + everything else', twoStems: 'vocals' },
  bass: { id: 'bass', label: 'Bass + everything else', twoStems: 'bass' },
} as const;

// Opus bitrates offered per stem. 192k is well past transparent for a single
// separated stem and keeps a 4-minute song around 20 MB across four stems.
export const BITRATES = [
  { id: 128, label: '128 kbps — smallest' },
  { id: 160, label: '160 kbps — smaller' },
  { id: 192, label: '192 kbps — recommended' },
  { id: 256, label: '256 kbps — highest' },
];

// ---- account settings (architecture §2.4, §6.5) ---------------------------------

/** Profile instruments, in picker order. `src/app/profile.js` exports the same list. */
export const INSTRUMENTS = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'] as const;
export type Instrument = (typeof INSTRUMENTS)[number];

export const MAX_PINS = 12;
export const MAX_INSTRUMENTS = INSTRUMENTS.length;
export const COUNT_IN_LENGTH = { min: 1, max: 16 } as const;
/** `onboarding.coach` is a bitmask of the Stage coach-mark steps 1–4. */
export const COACH_MASK = 0b1111;
export const SHIFTS = { min: 0, max: 10 } as const;
export const OVERLAP = { min: 0.1, max: 0.75 } as const;

export const STOP_MODES = ['cue', 'stay'] as const;
export const COUNT_IN_UNITS = ['bars', 'beats'] as const;
export const CLICK_MODES = ['off', 'countin', 'always'] as const;
export const WAKE_OPTIONS = [5, 10, 30, 'always'] as const;
export const OPEN_WITH_MY_PART = ['in', 'out'] as const;
export const WHAT_DO_YOU_PLAY = ['done', 'skipped'] as const;

export type Profile = { instruments: Instrument[]; primary: Instrument | null; openWithMyPart: 'in' | 'out' };
export type PracticeDefaults = {
  stop: (typeof STOP_MODES)[number];
  countIn: { on: boolean; length: number; unit: (typeof COUNT_IN_UNITS)[number] };
  click: (typeof CLICK_MODES)[number];
  eachPassCount: boolean;
  keepPitch: boolean;
  wake: (typeof WAKE_OPTIONS)[number];
};
export type Onboarding = { whatDoYouPlay?: (typeof WHAT_DO_YOU_PLAY)[number]; coach?: number; desktopFirstRun?: boolean };

export type AccountSettings = {
  preset: string;
  stemMode: string;
  bitrate: number;
  custom: { model: string; shifts: number; overlap: number };
  autoBeats: boolean;
  autoSections: boolean;
  notifyReady: boolean;
  profile: Profile;
  pins: string[];
  onboarding: Onboarding;
  practice: PracticeDefaults;
  /** Written true with stemMode/preset by the Add sheet's "Use these for future songs" (§2.22). Absent means false. */
  addDefaultsSaved?: boolean;
};

export const DEFAULT_SETTINGS: AccountSettings = {
  preset: DEFAULT_PRESET,
  stemMode: 'full',
  bitrate: 192,
  custom: {
    model: 'htdemucs_ft',
    shifts: 10,
    overlap: 0.5,
  },
  autoBeats: true,
  autoSections: true,
  notifyReady: true,
  profile: { instruments: [], primary: null, openWithMyPart: 'in' },
  pins: [],
  onboarding: {},
  practice: {
    stop: 'cue',
    countIn: { on: false, length: 1, unit: 'bars' },
    click: 'countin',
    eachPassCount: true,
    keepPitch: true,
    wake: 10,
  },
};

export type Settings = AccountSettings & Record<string, any>;

/** Settings keys 1.9 stored that 2.0 no longer has; `withDefaults` drops them (one-way upgrade). */
const RETIRED_KEYS = ['format'];

const isPlain = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const plain = (value: unknown): Record<string, any> => (isPlain(value) ? value : {});
const copy = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const has = (object: object, key: unknown) =>
  typeof key === 'string' && Object.prototype.hasOwnProperty.call(object, key);

/**
 * Stored settings over the defaults, so new keys appear for old rows. `custom`,
 * `profile`, `onboarding` and `practice` (with `practice.countIn`) merge key by
 * key; everything else replaces. Retired 1.9 keys are dropped. Always returns
 * fresh objects, never the defaults themselves.
 */
export function withDefaults(saved: any): Settings {
  const s = plain(saved);
  const rest: Record<string, any> = {};
  for (const [key, value] of Object.entries(s)) if (!RETIRED_KEYS.includes(key) && value !== undefined) rest[key] = value;
  const d = DEFAULT_SETTINGS;
  const practice = plain(s.practice);
  return copy({
    ...d,
    ...rest,
    custom: { ...d.custom, ...plain(s.custom) },
    profile: { ...d.profile, ...plain(s.profile) },
    pins: Array.isArray(s.pins) ? s.pins : d.pins,
    onboarding: { ...d.onboarding, ...plain(s.onboarding) },
    practice: { ...d.practice, ...practice, countIn: { ...d.practice.countIn, ...plain(practice.countIn) } },
  });
}

/**
 * Only the processing part of settings (preset, stemMode, bitrate, custom), over the
 * defaults: what a separation job stores as `job.settings`, without the account's
 * profile, pins, onboarding or practice defaults.
 */
export function processingSettings(saved: any): Pick<AccountSettings, 'preset' | 'stemMode' | 'bitrate' | 'custom'> {
  const s = withDefaults(saved);
  return { preset: s.preset, stemMode: s.stemMode, bitrate: s.bitrate, custom: s.custom };
}

/**
 * The `settings.patch` merge: plain objects merge key by key at every depth;
 * arrays, primitives and null replace; `undefined` leaves the key alone. Returns
 * a new object and never mutates its inputs. The client applies the same rule
 * optimistically (`src/app/account.js`).
 */
export function mergeSettings<T extends Record<string, any>>(base: T, patch: Record<string, any>): T {
  const out: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(plain(patch))) {
    if (value === undefined) continue;
    out[key] = isPlain(value) && isPlain(out[key]) ? mergeSettings(out[key], value) : copy(value);
  }
  return out as T;
}

/** JSON with object keys sorted at every depth, so equal settings give equal strings whatever their key order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlain(value)) {
    return `{${Object.keys(value)
      .filter(k => value[k] !== undefined)
      .sort()
      .map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Structural equality of two settings values, independent of key order (the
 * database returns a document's fields in its own order, not insertion order).
 */
export function sameSettings(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

export type PatchError = { code: 'invalid' | 'pins_full'; field: string; message: string };
export type PatchCheck = { ok: true; patch: Record<string, any> } | ({ ok: false } & PatchError);

const isInt = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const oneOf = (list: readonly unknown[], value: unknown) => list.includes(value);
const onlyKeys = (value: Record<string, any>, keys: string[]) => Object.keys(value).every(k => keys.includes(k));

/**
 * Validates a `settings.patch` argument and normalises it: the profile's
 * instruments and the pins are deduplicated, in order (before their caps apply),
 * and a profile `primary` that is not one of its instruments becomes the first
 * instrument, or null. Covers every key, type,
 * enum and cap, so the fixture (which has no Convex validators) gives the same
 * answers as the server. Song ownership of pins needs the database and is
 * checked by the caller.
 */
export function checkPatch(input: unknown): PatchCheck {
  const bad = (field: string, message: string, code: PatchError['code'] = 'invalid'): PatchCheck =>
    ({ ok: false, code, field, message });
  if (!isPlain(input)) return bad('patch', 'Settings must be an object.');
  const patch: Record<string, any> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    switch (key) {
      case 'preset':
        if (!(value === 'custom' || has(PRESETS, value))) return bad(key, 'Choose a quality preset.');
        break;
      case 'stemMode':
        if (!has(STEM_MODES, value)) return bad(key, 'Choose how to split songs.');
        break;
      case 'bitrate':
        if (!BITRATES.some(b => b.id === value)) return bad(key, 'Choose a bitrate.');
        break;
      case 'custom': {
        if (!isPlain(value) || !onlyKeys(value, ['model', 'shifts', 'overlap'])) return bad(key, 'Custom quality needs a model, passes and overlap.');
        if (!MODELS.some(m => m.id === value.model)) return bad('custom.model', 'Choose a model.');
        if (!isInt(value.shifts, SHIFTS.min, SHIFTS.max)) return bad('custom.shifts', `Quality passes must be a whole number from ${SHIFTS.min} to ${SHIFTS.max}.`);
        if (!(typeof value.overlap === 'number' && value.overlap >= OVERLAP.min && value.overlap <= OVERLAP.max)) return bad('custom.overlap', `Overlap must be from ${OVERLAP.min} to ${OVERLAP.max}.`);
        break;
      }
      case 'autoBeats':
      case 'autoSections':
      case 'notifyReady':
      case 'addDefaultsSaved':
        if (typeof value !== 'boolean') return bad(key, 'Expected on or off.');
        break;
      case 'profile': {
        if (!isPlain(value) || !onlyKeys(value, ['instruments', 'primary', 'openWithMyPart'])) return bad(key, 'The instrument profile is incomplete.');
        const list = value.instruments;
        if (!Array.isArray(list)) return bad('profile.instruments', `Choose up to ${MAX_INSTRUMENTS} instruments.`);
        if (list.some(i => !oneOf(INSTRUMENTS, i))) return bad('profile.instruments', 'Unknown instrument.');
        // Deduplicate first, then cap (the same order as pins).
        const instruments = [...new Set(list)];
        if (instruments.length > MAX_INSTRUMENTS) return bad('profile.instruments', `Choose up to ${MAX_INSTRUMENTS} instruments.`);
        if (!(value.primary === null || oneOf(INSTRUMENTS, value.primary))) return bad('profile.primary', 'Unknown instrument.');
        if (!oneOf(OPEN_WITH_MY_PART, value.openWithMyPart)) return bad('profile.openWithMyPart', 'Choose whether songs open with your part in or out.');
        // A primary the profile no longer lists (its chip was deselected) moves to the
        // first instrument left, or null; it is normalised, never refused.
        const primary = value.primary !== null && instruments.includes(value.primary) ? value.primary : (instruments[0] ?? null);
        patch[key] = { instruments, primary, openWithMyPart: value.openWithMyPart };
        continue;
      }
      case 'pins': {
        if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id)) return bad(key, 'Pins must be song ids.');
        const pins = [...new Set(value)];
        if (pins.length > MAX_PINS) return bad(key, `Up to ${MAX_PINS} pins`, 'pins_full');
        patch[key] = pins;
        continue;
      }
      case 'onboarding': {
        if (!isPlain(value)) return bad(key, 'Onboarding must be an object.');
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(value)) {
          if (v === undefined) continue;
          if (k === 'whatDoYouPlay') { if (!oneOf(WHAT_DO_YOU_PLAY, v)) return bad('onboarding.whatDoYouPlay', 'Expected done or skipped.'); }
          else if (k === 'coach') { if (!isInt(v, 0, COACH_MASK)) return bad('onboarding.coach', 'Coach steps are a bitmask of steps 1–4.'); }
          else if (k === 'desktopFirstRun') { if (typeof v !== 'boolean') return bad('onboarding.desktopFirstRun', 'Expected on or off.'); }
          else return bad(`onboarding.${k}`, 'Unknown onboarding step.');
          out[k] = v;
        }
        patch[key] = out;
        continue;
      }
      case 'practice': {
        if (!isPlain(value)) return bad(key, 'Practice defaults must be an object.');
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(value)) {
          if (v === undefined) continue;
          const field = `practice.${k}`;
          if (k === 'stop') { if (!oneOf(STOP_MODES, v)) return bad(field, 'Choose where Stop returns.'); }
          else if (k === 'click') { if (!oneOf(CLICK_MODES, v)) return bad(field, 'Choose Off, Count-in only or Always.'); }
          else if (k === 'wake') { if (!oneOf(WAKE_OPTIONS, v)) return bad(field, 'Choose 5, 10 or 30 minutes, or Always.'); }
          else if (k === 'eachPassCount' || k === 'keepPitch') { if (typeof v !== 'boolean') return bad(field, 'Expected on or off.'); }
          else if (k === 'countIn') {
            if (!isPlain(v) || !onlyKeys(v, ['on', 'length', 'unit'])) return bad(field, 'The count-in needs on, length and unit.');
            if (typeof v.on !== 'boolean') return bad('practice.countIn.on', 'Expected on or off.');
            if (!isInt(v.length, COUNT_IN_LENGTH.min, COUNT_IN_LENGTH.max)) return bad('practice.countIn.length', `The count-in is ${COUNT_IN_LENGTH.min} to ${COUNT_IN_LENGTH.max} bars or beats.`);
            if (!oneOf(COUNT_IN_UNITS, v.unit)) return bad('practice.countIn.unit', 'Count in bars or beats.');
          }
          else return bad(field, 'Unknown practice setting.');
          out[k] = v;
        }
        patch[key] = out;
        continue;
      }
      default:
        return bad(key, 'Unknown setting.');
    }
    patch[key] = value;
  }
  return { ok: true, patch: copy(patch) };
}

/**
 * Resolve the effective Demucs + encoding parameters. Takes a settings object,
 * or a preset id with an optional stem mode (`resolveQuality('fast', 'six')`,
 * as a retry with "Try Fast quality" re-resolves a job). The `six` stem mode
 * always runs htdemucs_6s and keeps the preset's passes and overlap. Stems are
 * always Opus (the 1.9 `format` setting is gone).
 */
export function resolveQuality(settings: any, stemMode?: string): Quality {
  const raw = typeof settings === 'string' ? { preset: settings } : plain(settings);
  const s = withDefaults(stemMode === undefined ? raw : { ...raw, stemMode });
  const base =
    s.preset === 'custom'
      ? { model: s.custom.model, shifts: s.custom.shifts, overlap: s.custom.overlap }
      : (() => {
          const p = (PRESETS as any)[s.preset] || PRESETS[DEFAULT_PRESET];
          return { model: p.model, shifts: p.shifts, overlap: p.overlap };
        })();
  const model = s.stemMode === 'six' ? SIX_STEM_MODEL : MODELS.some(m => m.id === base.model) ? base.model : 'htdemucs';
  return {
    model,
    shifts: Number.isFinite(base.shifts) ? Math.max(SHIFTS.min, Math.min(SHIFTS.max, Math.floor(base.shifts))) : 0,
    overlap: Number.isFinite(base.overlap) ? Math.max(OVERLAP.min, Math.min(OVERLAP.max, base.overlap)) : 0.25,
    format: 'opus',
    bitrate: BITRATES.some(b => b.id === s.bitrate) ? s.bitrate : DEFAULT_SETTINGS.bitrate,
  };
}

const FOUR_STEMS = ['drums', 'bass', 'other', 'vocals'];
const SIX_STEMS = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];

/** Stem filenames Demucs produces, by mode (and model, for `full`). */
export function expectedStems(stemMode: string, model?: string): string[] {
  if (stemMode === 'six') return [...SIX_STEMS];
  if (stemMode === 'full') return model === SIX_STEM_MODEL ? [...SIX_STEMS] : [...FOUR_STEMS];
  const focus = (STEM_MODES as any)[stemMode]?.twoStems || 'drums';
  return [focus, `no_${focus}`];
}
