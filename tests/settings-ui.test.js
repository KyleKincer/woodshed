// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { PRESETS, MODELS, STEM_MODES, BITRATES, DEFAULT_SETTINGS } from '../convex/lib/presets';

vi.mock('../src/js/backend.js', () => ({ saveSettings: vi.fn(async () => {}), cloudUsage: vi.fn(async () => ({ usedBytes: 41e6, limitBytes: 250e6 })) }));
vi.mock('../src/js/companion.js', () => ({ localRequest: vi.fn(), legacyLibraries: vi.fn(), importLegacy: vi.fn() }));
vi.mock('../src/js/export.js', () => ({ exportLibrary: vi.fn() }));
vi.mock('../src/js/stemcache.js', () => ({ clearStemCache: vi.fn(), stemCacheSize: vi.fn(async () => 0) }));
import { initSettings, renderSettings } from '../src/js/settings.js';
import { saveSettings } from '../src/js/backend.js';
let config;
const el = id => document.getElementById(id);
function input(id, value) {
  el(id).value = value;
  el(id).dispatchEvent(new Event('input', { bubbles: true }));
}
beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<main id="view-settings" class="active"><div class="view-header"><h1>Settings</h1></div><div id="settings-root"></div></main>';
  delete window.woodshedDesktop;
  config = { settings: structuredClone(DEFAULT_SETTINGS), presets: PRESETS, models: MODELS, stemModes: STEM_MODES, bitrates: BITRATES };
  initSettings(config);
});
test('advanced starts with effective preset values and edits preserve the other effective parameters', async () => {
  renderSettings();
  expect(el('c-shifts').value).toBe('2'); // stored custom defaults are Studio's 10
  expect(el('custom-section').open).toBe(false);
  input('c-overlap', '0.4');
  expect(config.settings.preset).toBe('custom');
  expect(config.settings.custom).toEqual({ model: 'htdemucs_ft', shifts: 2, overlap: 0.4 });
  expect(el('quality-label').textContent).toBe('Custom');
  await vi.waitFor(() => expect(saveSettings).toHaveBeenCalled());
  expect(document.body.textContent).not.toContain('Changes saved');
});
test('all three presets reset custom parameters, and custom survives reopening', () => {
  renderSettings();
  for (const [index, id] of ['fast', 'balanced', 'studio'].entries()) {
    input('quality-preset', index);
    expect(config.settings.preset).toBe(id);
    for (const key of ['model', 'shifts', 'overlap']) expect(el(`c-${key}`).value).toBe(String(PRESETS[id][key]));
  }
  input('c-shifts', 7);
  renderSettings();
  expect(el('custom-section').open).toBe(true);
  expect(el('c-shifts').value).toBe('7');
  document.querySelector('[data-preset-index="1"]').click();
  expect(config.settings.preset).toBe('balanced');
  expect(el('c-shifts').value).toBe('2');
});
test('saves snapshots in order and reports failures without a saved label', async () => {
  let release;
  saveSettings.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  renderSettings();
  input('quality-preset', 0);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  input('quality-preset', 2);
  expect(saveSettings).toHaveBeenCalledTimes(1);
  expect(saveSettings.mock.calls[0][0].preset).toBe('fast');
  release();
  await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(2));
  expect(saveSettings.mock.calls[1][0].preset).toBe('studio');
  saveSettings.mockRejectedValueOnce(new Error('Offline'));
  input('s-bitrate', 256);
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]').textContent).toContain('Offline'));
});
test('desktop displays installed version and invokes native updates; web explains automatic updates', async () => {
  window.woodshedDesktop = { info: vi.fn(async () => ({ version: '1.2.9' })), update: vi.fn(async () => {}) };
  renderSettings();
  await vi.waitFor(() => expect(el('app-version').textContent).toBe('Version 1.2.9'));
  el('desktop-updates').click();
  expect(window.woodshedDesktop.update).toHaveBeenCalledWith('show');
  expect(document.body.textContent).not.toContain('Desktop connection');
  delete window.woodshedDesktop;
  renderSettings();
  expect(el('desktop-updates')).toBeNull();
  expect(document.body.textContent).toContain('The web app updates automatically.');
  // Optional local visual-review artifact, never used by the application.
  if (process.env.UI_SNAPSHOTS) {
    mkdirSync('artifacts', { recursive: true });
    writeFileSync('artifacts/settings.html', `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/css/styles.css"><link rel="stylesheet" href="/src/css/record-club.css"><style>body{display:block;overflow:auto;padding:32px}</style>${document.body.innerHTML}`);
  }
});
