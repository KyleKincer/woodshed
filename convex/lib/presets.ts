// Quality presets — the single source of truth, shared by the browser (via the
// `config` query), the Convex functions, and Modal (passed in the job payload).
//
// "shifts" is prediction averaging: htdemucs_ft runs 4 sub-models, so the total
// GPU passes are 4 × max(1, shifts). That is the dominant cost driver now that
// separation runs on rented GPUs rather than the user's laptop, hence the
// `estCostUsd` hint surfaced in the UI.

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
    estCostUsd: 0.22,
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    description: 'Great quality without the long wait.',
    model: 'htdemucs_ft',
    shifts: 2,
    overlap: 0.25,
    estCostUsd: 0.05,
  },
  fast: {
    id: 'fast',
    label: 'Fast',
    description: 'Good for a quick pass.',
    model: 'htdemucs',
    shifts: 0,
    overlap: 0.25,
    estCostUsd: 0.01,
  },
} as const;

export const DEFAULT_PRESET = 'studio';

export const MODELS = [
  { id: 'htdemucs_ft', label: 'Fine-tuned (best)' },
  { id: 'htdemucs', label: 'Standard' },
  { id: 'htdemucs_6s', label: 'With piano & guitar' },
  { id: 'mdx_extra', label: 'Alternative' },
];

export const STEM_MODES = {
  full: { id: 'full', label: 'Full band (drums · bass · vocals · other)', twoStems: null },
  drums: { id: 'drums', label: 'Drums + everything else', twoStems: 'drums' },
  vocals: { id: 'vocals', label: 'Vocals + everything else', twoStems: 'vocals' },
  bass: { id: 'bass', label: 'Bass + everything else', twoStems: 'bass' },
} as const;

// Opus bitrates offered per stem. 192k is well past transparent for a single
// separated stem and keeps a 4-minute song around 20 MB across four stems.
export const BITRATES = [
  { id: 128, label: '128 kbps — smallest' },
  { id: 192, label: '192 kbps — recommended' },
  { id: 256, label: '256 kbps — highest' },
];

export const DEFAULT_SETTINGS: {
  preset: string;
  stemMode: string;
  format: 'opus' | 'flac';
  bitrate: number;
  custom: { model: string; shifts: number; overlap: number };
} = {
  preset: DEFAULT_PRESET,
  stemMode: 'full',
  // Delivery format for separated stems. Opus in a WebM container decodes
  // sample-exactly via decodeAudioData in Chrome, Firefox and Safari 15+.
  format: 'opus',
  bitrate: 192,
  custom: {
    model: 'htdemucs_ft',
    shifts: 10,
    overlap: 0.5,
  },
};

export type Settings = typeof DEFAULT_SETTINGS & Record<string, any>;

/** Merge stored settings over the defaults so new keys appear for old rows. */
export function withDefaults(saved: any): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...(saved || {}),
    custom: { ...DEFAULT_SETTINGS.custom, ...((saved || {}).custom || {}) },
  };
}

/** Resolve the effective Demucs + encoding parameters from a settings object. */
export function resolveQuality(settings: any): Quality {
  const s = withDefaults(settings);
  const base =
    s.preset === 'custom'
      ? { model: s.custom.model, shifts: s.custom.shifts, overlap: s.custom.overlap }
      : (() => {
          const p = (PRESETS as any)[s.preset] || PRESETS[DEFAULT_PRESET];
          return { model: p.model, shifts: p.shifts, overlap: p.overlap };
        })();
  return {
    ...base,
    format: s.format === 'flac' ? 'flac' : 'opus',
    bitrate: s.bitrate || DEFAULT_SETTINGS.bitrate,
  };
}

/** Stem filenames Demucs produces, by mode — mirrors modal/separate.py. */
export function expectedStems(stemMode: string, model: string): string[] {
  if (stemMode === 'full') {
    return model === 'htdemucs_6s'
      ? ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano']
      : ['drums', 'bass', 'other', 'vocals'];
  }
  const focus = (STEM_MODES as any)[stemMode]?.twoStems || 'drums';
  return [focus, `no_${focus}`];
}
