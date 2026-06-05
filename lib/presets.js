'use strict';

// Quality presets. "model" is the Demucs model name, "shifts" is prediction
// averaging (more = better & much slower), "overlap" is segment overlap, and
// "format" maps to the Demucs output flag.
//
// The DEFAULT preset is the maximum-quality one — same idea as the CLI script:
// htdemucs_ft + shifts 10 + overlap 0.5 + 32-bit float WAV.
const PRESETS = {
  studio: {
    id: 'studio',
    label: 'Studio — max quality',
    description: 'Fine-tuned model, heavy shift averaging. Slowest, best separation.',
    model: 'htdemucs_ft',
    shifts: 10,
    overlap: 0.5,
    format: 'float32',
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    description: 'Fine-tuned model with light averaging. Good quality, ~3–4x faster.',
    model: 'htdemucs_ft',
    shifts: 2,
    overlap: 0.25,
    format: 'float32',
  },
  fast: {
    id: 'fast',
    label: 'Fast',
    description: 'Base model, no averaging. Quickest turnaround for quick ideas.',
    model: 'htdemucs',
    shifts: 0,
    overlap: 0.25,
    format: 'int24',
  },
};

const DEFAULT_PRESET = 'studio';

// Models the user can pick in Custom mode.
const MODELS = [
  { id: 'htdemucs_ft', label: 'htdemucs_ft (fine-tuned, best)' },
  { id: 'htdemucs', label: 'htdemucs (default hybrid transformer)' },
  { id: 'htdemucs_6s', label: 'htdemucs_6s (adds piano + guitar stems)' },
  { id: 'mdx_extra', label: 'mdx_extra (alternative, no vocals bleed)' },
];

// Stem layouts. "drums" = the original two-stem ask; "full" = the four stems
// most useful for practicing (mute whichever part you're playing). 6s adds
// piano + guitar.
const STEM_MODES = {
  full: { id: 'full', label: 'Full band (drums · bass · vocals · other)', twoStems: null },
  drums: { id: 'drums', label: 'Drums + everything else', twoStems: 'drums' },
  vocals: { id: 'vocals', label: 'Vocals + everything else', twoStems: 'vocals' },
  bass: { id: 'bass', label: 'Bass + everything else', twoStems: 'bass' },
};

const DEFAULT_SETTINGS = {
  preset: DEFAULT_PRESET,
  stemMode: 'full',
  // Custom overrides (only used when preset === 'custom')
  custom: {
    model: 'htdemucs_ft',
    shifts: 10,
    overlap: 0.5,
    format: 'float32',
  },
  device: 'auto', // auto | mps | cuda | cpu
};

/** Resolve the effective Demucs parameters from a settings object. */
function resolveQuality(settings) {
  if (settings.preset === 'custom') {
    return { ...settings.custom };
  }
  const p = PRESETS[settings.preset] || PRESETS[DEFAULT_PRESET];
  return { model: p.model, shifts: p.shifts, overlap: p.overlap, format: p.format };
}

module.exports = {
  PRESETS,
  DEFAULT_PRESET,
  MODELS,
  STEM_MODES,
  DEFAULT_SETTINGS,
  resolveQuality,
};
