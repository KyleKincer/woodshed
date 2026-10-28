// @vitest-environment happy-dom
// LB2b: the Add sheet (src/library/add-sheet.js; spec §3.1–3.3 and §3.6, architecture §2.16, §9.12). Behaviour,
// structure, roles and accessible names (happy-dom); geometry, the 640 px dialog, the 90% iPad sheet, the 56 px
// omnibox and the row heights are checked by the LB2b fixture states.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

vi.mock('../src/api/jobs.js', () => ({createSeparation: vi.fn(), cancel: vi.fn(), dismiss: vi.fn()}));
vi.mock('../src/api/settings.js', () => ({demo: vi.fn(), patch: vi.fn(), subscribeConfig: vi.fn(() => () => {})}));
vi.mock('../src/js/companion.js', () => ({resolveSource: vi.fn(), searchSources: vi.fn(), requireCompanion: vi.fn(), uploadXHR: vi.fn()}));

const {computed, signal, store} = await import('../src/app/store.js');
const {installPopoverShim, restoreDomShims} = await import('./helpers/dom.js');
const mod = await import('../src/library/add-sheet.js');
const {
  createAddSheet, mount, focusNewCard, formatDuration, fileStem, estimateMinutes, candidateMeta, textSubmission, chooseDevice,
  probeDuration, COPY, CONTROLS, DEBOUNCE_MS, UNDO_MS, RING_MS, BUSY_RETRY_MS,
} = mod;
const {STEM_OPTIONS, QUALITY_OPTIONS} = await import('../src/library/add-sheet.copy.js');
const {COPY: MODEL_COPY} = await import('../src/library/add-model.js');
const {COPY: UPLOAD_COPY} = await import('../src/library/upload.js');

const T0 = Date.parse('2026-10-28T12:00:00Z');
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const settle = async () => { await flush(); await new Promise(r => setTimeout(r, 0)); await flush(); };

const candidate = (title, channel, duration, extra = {}) => ({
  url: `https://www.youtube.com/watch?v=${title.length}${channel.length}x`, id: `v${title.length}`, title, channel, duration,
  thumbnail: 'https://i.ytimg.com/vi/x/mqdefault.jpg', provider: 'youtube', live: false, ...extra,
});
const RESULTS = [
  candidate('Harbor Lights (Official Audio)', 'Ada Moreno', 221),
  candidate('Harbor Lights — Live at the Roundhouse', 'Ada Moreno', 372),
  candidate('Harbor Lights (Drum Cover)', 'StickWorks', 230, {thumbnail: 'data:image/png;base64,AAAA'}),
];
const DEVICES = [
  {deviceId: 'dev1', name: 'Studio MacBook', lastSeenAt: T0 - 10_000, state: 'idle'},
  {deviceId: 'dev2', name: 'MacBook Pro', lastSeenAt: T0 - 3 * 864e5, state: 'offline'},
];
const SONGS = [
  {id: 'glass', title: 'Glasshouse', artist: 'Northbound', duration: 128, source: {type: 'url', value: 'https://www.youtube.com/watch?v=fixture01'}},
  {id: 'harbor', title: 'Harbor Lights', artist: 'Ada Moreno', duration: 221, source: {type: 'search', value: 'harbor lights'}},
];

/** The accessible name of an element (the roles the sheet uses). */
function nameOf(el) {
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) return labelledby.split(/\s+/).map(id => el.ownerDocument.getElementById(id)?.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();
  const label = el.getAttribute('aria-label');
  if (label) return label.trim();
  if (el.id) {
    const forLabel = el.ownerDocument.querySelector(`label[for="${el.id}"]`);
    if (forLabel) return forLabel.textContent.replace(/\s+/g, ' ').trim();
  }
  return el.textContent.replace(/\s+/g, ' ').trim();
}
const ROLE_SELECTORS = {
  button: 'button', link: 'a[href]', dialog: 'dialog', textbox: 'input[type=text]', checkbox: 'input[type=checkbox]',
  radiogroup: '[role=radiogroup]', radio: '[role=radio]', list: 'ul', menuitemradio: '[role=menuitemradio]',
};
const visible = el => !el.closest('[hidden]');
const allByRole = (root, role) => [...root.querySelectorAll(ROLE_SELECTORS[role])].filter(visible);
const byRole = (root, role, name) => allByRole(root, role).find(el => (name instanceof RegExp ? name.test(nameOf(el)) : nameOf(el) === name)) ?? null;

let s, d, sheets, staged, prefsData;

function makeStore({devices = [], songs = SONGS, phase = 'ready', status = 'active'} = {}) {
  return {
    library: {songs: signal(new Map(songs.map(x => [x.id, x]))), devices: signal(devices), uploads: signal([]), jobs: signal([]), loaded: signal(true)},
    processor: signal({phase, name: 'Studio MacBook', deviceId: 'dev1', job: null, firstRun: false}),
    session: signal({user: {id: 'u'}, status, admin: false, online: true}),
  };
}

function makeAccount(settings = {}) {
  const value = signal({preset: 'balanced', stemMode: 'full', custom: {model: 'htdemucs_ft', shifts: 2, overlap: 0.25},
    profile: {instruments: ['drums'], primary: 'drums', openWithMyPart: 'in'}, onboarding: {desktopFirstRun: true}, ...settings});
  return {value, profile: computed(() => value.value.profile), patch: vi.fn(async () => {}), markOnboarding: vi.fn(async () => {})};
}

function uploadHandle(id, file) {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {id, file, name: file.name, cancel: vi.fn(async () => true), promise, finish: jobId => resolve({jobId})};
}

function makeDeps({desktop = true, coarse = false, ipad = false, devices, songs, phase, status, account = {}, ...over} = {}) {
  s = makeStore({devices: devices ?? (desktop ? [] : DEVICES), songs, phase, status});
  prefsData = {deviceId: null, jobStats: {}};
  staged = [];
  d = {
    store: s,
    account: makeAccount(account),
    prefs: {get: k => prefsData[k], set: vi.fn((k, v) => { prefsData[k] = v; })},
    platform: {coarse: signal(coarse), isIPad: ipad, isIOS: ipad},
    desktop: {available: desktop, restartProcessor: vi.fn(async () => {})},
    jobs: {createSeparation: vi.fn(async () => ({jobId: 'job-new'})), cancel: vi.fn(async () => true), dismiss: vi.fn(async () => true)},
    lookups: {
      searchSources: vi.fn(async q => ({query: q, provider: 'youtube', candidates: RESULTS})),
      resolveSource: vi.fn(async url => ({kind: /spotify/.test(url) ? 'spotify' : 'url', candidates: /spotify/.test(url) ? RESULTS : [RESULTS[0]]})),
    },
    uploads: {
      startUploads: vi.fn(files => files.map((f, i) => uploadHandle(`upload-${i + 1}`, f))),
      uploadDevice: vi.fn(async () => 'dev1'),
    },
    takeStagedFiles: () => { const out = staged; staged = []; return out; },
    feedback: {toast: vi.fn(() => ({dismiss() {}, update() {}})), announce: vi.fn()},
    settings: {demo: vi.fn(async () => ({token: 'a'.repeat(64)}))},
    fetchRelease: vi.fn(async () => ({version: '2.0.0', downloads: {mac: [{url: 'https://github.com/KyleKincer/woodshed/releases/download/v2.0.0/Woodshed-mac-arm64.dmg', name: 'Woodshed-mac-arm64.dmg'}]}})),
    detectPlatform: () => (ipad ? 'mobile' : 'mac'),
    now: () => T0,
    navigator: {
      clipboard: {readText: vi.fn(async () => 'https://youtu.be/abc123'), writeText: vi.fn(async () => {})},
      share: vi.fn(async () => {}),
      userActivation: {isActive: true},
    },
    origin: 'https://woodshed.example',
    durationOf: vi.fn(async () => 221),
    router: {navigate: vi.fn(), back: vi.fn()},
    ...over,
  };
  return d;
}

function open(options = {}, match = {query: {}}) {
  const deps = d ?? makeDeps();
  const sheet = createAddSheet({...deps, ...options});
  sheets.push(sheet);
  sheet.update({name: 'add', path: '/add', params: {}, state: null, ...match});
  return sheet;
}

const audioFile = (name, size = 3_100_000) => Object.defineProperty(new File([new Uint8Array(8)], name, {type: 'audio/mpeg'}), 'size', {value: size});
const pdf = name => new File(['%PDF'], name, {type: 'application/pdf'});
const input = sheet => sheet.el.querySelector('.lib-add-input');
const submitBtn = sheet => sheet.el.querySelector('.lib-add-submit');
const type = (sheet, text) => { const i = input(sheet); i.value = text; i.dispatchEvent(new Event('input', {bubbles: true})); };
const key = (target, k, extra = {}) => target.dispatchEvent(new KeyboardEvent('keydown', {key: k, bubbles: true, cancelable: true, ...extra}));

beforeEach(() => {
  installPopoverShim();
  document.body.replaceChildren();
  sheets = [];
  d = null;
});
afterEach(() => {
  for (const sheet of sheets) sheet.destroy();
  restoreDomShims();
  vi.useRealTimers();
  document.body.replaceChildren();
});

// =====================================================================================================
describe('pure helpers', () => {
  test('formatDuration and fileStem', () => {
    expect(formatDuration(221)).toBe('3:41');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(0)).toBeNull();
    expect(fileStem('Harbor Lights.mp3')).toBe('Harbor Lights');
    expect(fileStem('take.4.final.wav')).toBe('take.4.final');
    expect(fileStem('noext')).toBe('noext');
  });

  test('estimateMinutes needs history and a duration (never invented)', () => {
    const stats = {balanced: {secPerMin: 30, n: 5}, fast: {secPerMin: 15, n: 0}};
    expect(estimateMinutes(stats, 'balanced', 240)).toBe(2);
    expect(estimateMinutes(stats, 'balanced', 20)).toBe(1);
    expect(estimateMinutes(stats, 'fast', 240)).toBeNull();      // no finished job yet
    expect(estimateMinutes(stats, 'studio', 240)).toBeNull();
    expect(estimateMinutes(stats, 'balanced', null)).toBeNull();
  });

  test('candidateMeta keeps only an https thumbnail and clips strings', () => {
    expect(candidateMeta(RESULTS[0])).toEqual({title: RESULTS[0].title, channel: 'Ada Moreno', duration: 221,
      thumbnail: RESULTS[0].thumbnail, provider: 'youtube'});
    expect(candidateMeta(RESULTS[2]).thumbnail).toBeUndefined();
    expect(candidateMeta({title: 'x'.repeat(400), duration: null}).title).toHaveLength(300);
    expect(candidateMeta(null)).toBeUndefined();
  });

  test.each([
    ['a chosen B4 candidate', {kind: 'search', value: 'harbor'}, RESULTS[1], {type: 'url', value: RESULTS[1].url}, true],
    ['a pasted link', {kind: 'url', value: 'https://youtu.be/x'}, null, {type: 'url', value: 'https://youtu.be/x'}, true],
    ['a search without B4', {kind: 'search', value: 'harbor lights'}, null, {type: 'search', value: 'harbor lights'}, false],
    ['a Spotify link without B4', {kind: 'spotify', value: 'https://open.spotify.com/track/1'}, null, {type: 'spotify', value: 'https://open.spotify.com/track/1'}, false],
  ])('textSubmission: %s (D43)', (_, input, chosen, source, confirmed) => {
    const out = textSubmission(input, chosen);
    expect(out.source).toEqual(source);
    expect(out.confirmed).toBe(confirmed);
    if (chosen) expect(out.meta.title).toBe(chosen.title);
  });

  test('chooseDevice: remembered, else first online, else first', () => {
    expect(chooseDevice(DEVICES, 'dev2', T0).deviceId).toBe('dev2');
    expect(chooseDevice(DEVICES, 'gone', T0).deviceId).toBe('dev1');
    expect(chooseDevice([DEVICES[1]], null, T0).deviceId).toBe('dev2');
    expect(chooseDevice([], null, T0)).toBeNull();
  });

  test('probeDuration resolves null without media support', async () => {
    expect(await probeDuration(audioFile('a.mp3'), {url: {}})).toBeNull();
    expect(await probeDuration(null)).toBeNull();
  });
});

// =====================================================================================================
describe('controls table (spec §3.1–3.3)', () => {
  const CONTEXTS = {
    desktop: async () => open(),
    candidates: async () => { const sh = open({}, {query: {q: 'harbor lights'}}); await settle(); return sh; },
    files: async () => { makeDeps(); staged = [audioFile('Harbor Lights.mp3'), audioFile('garage-take-4.wav')]; const sh = open(); await settle(); return sh; },
    file: async () => { makeDeps(); staged = [audioFile('Harbor Lights.mp3')]; const sh = open(); await settle(); return sh; },
    duplicate: async () => { const sh = open({}, {query: {q: 'https://www.youtube.com/watch?v=fixture01'}}); await settle(); return sh; },
    change: async () => { const sh = open(); sh.el.querySelector('.lib-add-change').click(); return sh; },
    web: async () => { makeDeps({desktop: false}); return open(); },
    ipad: async () => { makeDeps({desktop: false, coarse: true, ipad: true}); return open(); },
    error: async () => {
      makeDeps();
      d.uploads.uploadDevice.mockRejectedValue({code: 'processor_offline', message: 'The local processor is not ready.', data: {}});
      const sh = open({}, {query: {q: 'harbor lights'}});
      await settle();
      submitBtn(sh).click();
      await settle();
      return sh;
    },
    explainer: async () => { makeDeps({desktop: false, devices: [], coarse: true, ipad: true}); return open(); },
  };

  for (const [context, build] of Object.entries(CONTEXTS)) {
    test(`every ${context} control has its role and name`, async () => {
      if (!d && context !== 'files' && context !== 'file') makeDeps();
      const sheet = await build();
      for (const row of CONTROLS.filter(r => r.context === context)) {
        if (row.count) {
          expect(allByRole(sheet.el, row.role).length, `${row.role} count`).toBe(row.count);
          expect(byRole(sheet.el, row.role, row.name), `${row.role} "${row.name}"`).not.toBeNull();
        } else {
          expect(byRole(document.body, row.role, row.name), `${row.role} "${row.name}" (${context})`).not.toBeNull();
        }
      }
      d = null;
    });
  }

  test('the sheet is a labelled modal dialog with the spec title and placeholder', () => {
    makeDeps();
    const sheet = open();
    expect(sheet.el.tagName).toBe('DIALOG');
    expect(sheet.el.open).toBe(true);
    expect(nameOf(sheet.el)).toBe('Add a song');
    expect(input(sheet).placeholder).toBe('Paste a link or search for a song');
    expect(sheet.el.querySelector('.lib-add-hint').textContent).toBe(COPY.hint);
    expect(document.activeElement).toBe(input(sheet));       // autofocused
    expect(sheet.state().presentation).toBe('dialog');
  });

  test('iPad: a bottom sheet with a grabber and a Paste button', async () => {
    makeDeps({desktop: false, coarse: true, ipad: true});
    const sheet = open();
    expect(sheet.el.dataset.presentation).toBe('sheet');
    expect(sheet.el.querySelector('.lib-add-grabber')).not.toBeNull();
    byRole(sheet.el, 'button', 'Paste').click();
    await settle();
    expect(d.navigator.clipboard.readText).toHaveBeenCalled();
    expect(input(sheet).value).toBe('https://youtu.be/abc123');
    expect(sheet.el.querySelector('.lib-add-fallback').textContent).toContain(COPY.urlFallback);
  });

  test('a fine pointer has no Paste button', () => {
    makeDeps();
    expect(byRole(open().el, 'button', 'Paste')).toBeNull();
  });
});

// =====================================================================================================
describe('desktop: B4 lookups', () => {
  test('typing looks up 400 ms after the last keystroke', async () => {
    vi.useFakeTimers();
    makeDeps();
    const sheet = open();
    type(sheet, 'harb');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 50);
    type(sheet, 'harbor lights');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    expect(d.lookups.searchSources).not.toHaveBeenCalled();
    expect(sheet.el.textContent).toContain(COPY.looking);
    await vi.advanceTimersByTimeAsync(1);
    expect(d.lookups.searchSources).toHaveBeenCalledTimes(1);
    expect(d.lookups.searchSources.mock.calls[0][0]).toBe('harbor lights');
    expect(d.lookups.searchSources.mock.calls[0][1].n).toBe(5);
    await vi.advanceTimersByTimeAsync(0);
    expect(allByRole(sheet.el, 'radio')).toHaveLength(3);
  });

  test('candidate rows: thumbnail, title, channel, duration and badges; the first is chosen; ↑/↓ move', async () => {
    makeDeps();
    const sheet = open({}, {query: {q: 'harbor lights'}});
    await settle();
    const rows = allByRole(sheet.el, 'radio');
    expect(rows.map(r => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(rows[0].querySelector('img').getAttribute('width')).toBe('96');
    expect(rows[0].textContent).toContain('Ada Moreno · YouTube');
    expect(rows[0].textContent).toContain('3:41');
    expect([...rows[0].querySelectorAll('.lib-add-badge')].map(b => b.textContent)).toEqual(['Official']);
    expect([...rows[1].querySelectorAll('.lib-add-badge')].map(b => b.textContent)).toEqual(['Live']);
    expect([...rows[2].querySelectorAll('.lib-add-badge')].map(b => b.textContent)).toEqual(['Cover']);
    key(input(sheet), 'ArrowDown');
    key(input(sheet), 'ArrowDown');
    expect(rows.map(r => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true']);
    key(input(sheet), 'ArrowDown');                   // wraps
    expect(sheet.state().selected).toBe(0);
    key(input(sheet), 'ArrowUp');
    expect(sheet.state().selected).toBe(2);
    expect(rows[2].tabIndex).toBe(0);
    expect(rows[0].tabIndex).toBe(-1);
    // Arrows inside the radiogroup move and focus.
    rows[2].focus();
    key(rows[2], 'ArrowUp');
    expect(sheet.state().selected).toBe(1);
    expect(document.activeElement).toBe(rows[1]);
    expect(sheet.el.querySelector('[role=radiogroup]').getAttribute('data-consume-keys')).toContain('ArrowUp');
  });

  test('a chosen candidate submits as its link, confirmed, with its meta (B4, D43)', async () => {
    makeDeps();
    const sheet = open({}, {query: {q: 'harbor lights'}});
    await settle();
    key(input(sheet), 'ArrowDown');
    key(input(sheet), 'Enter');
    await settle();
    expect(d.uploads.uploadDevice).toHaveBeenCalled();
    const args = d.jobs.createSeparation.mock.calls[0][0];
    expect(args).toMatchObject({source: {type: 'url', value: RESULTS[1].url}, deviceId: 'dev1', confirmed: true, label: RESULTS[1].title});
    expect(args.meta).toMatchObject({title: RESULTS[1].title, channel: 'Ada Moreno', duration: 372, provider: 'youtube'});
    expect(args.settings).toMatchObject({stemMode: 'full', preset: 'balanced'});
    expect(sheet.el.isConnected).toBe(false);
    expect(d.router.back).toHaveBeenCalledWith({fallback: '/'});
  });

  test('a failed lookup falls back to the honest single-result line; the search is unconfirmed', async () => {
    makeDeps();
    d.lookups.searchSources.mockRejectedValue({code: 'bot_check', message: 'Sign in to confirm'});
    const sheet = open({}, {query: {q: 'harbor lights'}});
    await settle();
    expect(sheet.el.querySelector('.lib-add-fallback').textContent).toBe(COPY.searchFallback('harbor lights'));
    expect(sheet.el.querySelector('.lib-add-error')).toBeNull();
    submitBtn(sheet).click();
    await settle();
    expect(d.jobs.createSeparation.mock.calls[0][0]).toMatchObject({source: {type: 'search', value: 'harbor lights'}, confirmed: false});
  });

  test('aborted answers are ignored; lookup_busy asks again', async () => {
    vi.useFakeTimers();
    makeDeps();
    d.lookups.searchSources.mockRejectedValueOnce({code: 'lookup_busy'});
    const sheet = open({}, {query: {q: 'harbor lights'}});
    await vi.advanceTimersByTimeAsync(0);
    expect(sheet.el.querySelector('.lib-add-fallback')).toBeNull();
    await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS);
    expect(d.lookups.searchSources).toHaveBeenCalledTimes(2);
    expect(allByRole(sheet.el, 'radio')).toHaveLength(3);
    // A newer input aborts the older lookup; its late answer changes nothing.
    let release;
    d.lookups.searchSources.mockImplementationOnce((q, {signal}) => new Promise((_, reject) => {
      release = () => reject(Object.assign(new Error('aborted'), {code: 'aborted'}));
      signal.addEventListener('abort', () => {});
    }));
    type(sheet, 'night bus');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    type(sheet, 'night bus kito');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(sheet.el.querySelector('.lib-add-fallback')).toBeNull();
    expect(allByRole(sheet.el, 'radio')).toHaveLength(3);
  });

  test('a link resolves to one candidate row; a failure shows "We’ll fetch this link…" and the raw URL', async () => {
    makeDeps();
    const sheet = open({}, {query: {q: 'https://youtu.be/abc'}});
    await settle();
    expect(d.lookups.resolveSource).toHaveBeenCalledWith('https://youtu.be/abc', expect.any(Object));
    expect(allByRole(sheet.el, 'radio')).toHaveLength(1);
    sheets.pop().destroy();
    makeDeps();
    d.lookups.resolveSource.mockRejectedValue({code: 'timeout'});
    const fallback = open({}, {query: {q: 'https://youtu.be/abc'}});
    await settle();
    expect(fallback.el.querySelector('.lib-add-fallback').textContent).toContain(COPY.urlFallback);
    expect(fallback.el.querySelector('.lib-add-url').textContent).toBe('https://youtu.be/abc');
    submitBtn(fallback).click();
    await settle();
    expect(d.jobs.createSeparation.mock.calls[0][0]).toMatchObject({source: {type: 'url', value: 'https://youtu.be/abc'}, confirmed: true});
  });

  test('a playlist link is an inline error that keeps the input and blocks Add', async () => {
    makeDeps();
    d.lookups.resolveSource.mockRejectedValue({code: 'playlist', message: 'This is a playlist.'});
    const sheet = open({}, {query: {q: 'https://www.youtube.com/playlist?list=PL1'}});
    await settle();
    const error = sheet.el.querySelector('.lib-add-error');
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toContain('This link is a playlist. Add one song at a time.');
    expect(input(sheet).value).toBe('https://www.youtube.com/playlist?list=PL1');
    expect(submitBtn(sheet).getAttribute('aria-disabled')).toBe('true');
    type(sheet, 'harbor lights');
    expect(sheet.el.querySelector('.lib-add-error')).toBeNull();
  });

  test('Spotify: the lead line, then candidates; without B4 the Spotify single-result line (unconfirmed)', async () => {
    makeDeps();
    const sheet = open({}, {query: {q: 'https://open.spotify.com/track/abc'}});
    await settle();
    expect(sheet.el.textContent).toContain(COPY.spotifyLead);
    expect(allByRole(sheet.el, 'radio')).toHaveLength(3);
    sheets.pop().destroy();
    makeDeps();
    d.lookups.resolveSource.mockRejectedValue({code: 'lookup_unavailable'});
    const fallback = open({}, {query: {q: 'https://open.spotify.com/track/abc'}});
    await settle();
    expect(fallback.el.textContent).toContain(COPY.spotifyLead);
    expect(fallback.el.querySelector('.lib-add-fallback').textContent).toBe(COPY.spotifyFallback);
    submitBtn(fallback).click();
    await settle();
    expect(d.jobs.createSeparation.mock.calls[0][0]).toMatchObject({source: {type: 'spotify'}, confirmed: false});
  });

  test('no results: an honest line and Add is blocked', async () => {
    makeDeps();
    d.lookups.searchSources.mockResolvedValue({query: 'zzz', provider: 'youtube', candidates: []});
    const sheet = open({}, {query: {q: 'zzz'}});
    await settle();
    expect(sheet.el.textContent).toContain(COPY.noResults('zzz'));
    expect(submitBtn(sheet).getAttribute('aria-disabled')).toBe('true');
  });

  test('the processor offline at submit: inline error with Restart processor and Details; the input is kept', async () => {
    makeDeps({phase: 'offline'});
    d.uploads.uploadDevice.mockRejectedValue({code: 'processor_offline', message: 'The local processor is not ready. Restart Woodshed.', data: {}});
    const sheet = open({}, {query: {q: 'harbor lights'}});
    await settle();
    submitBtn(sheet).click();
    await settle();
    const error = sheet.el.querySelector('.lib-add-error');
    expect(error.textContent).toContain('Woodshed’s processor isn’t running on this computer.');
    expect(sheet.el.isConnected).toBe(true);
    expect(input(sheet).value).toBe('harbor lights');
    expect(d.jobs.createSeparation).not.toHaveBeenCalled();
    const details = byRole(error, 'button', 'Details');
    expect(details.getAttribute('aria-expanded')).toBe('false');
    details.click();
    expect(error.querySelector('pre').hidden).toBe(false);
    expect(error.querySelector('pre').textContent).toBe('The local processor is not ready. Restart Woodshed.');
    byRole(error, 'button', 'Copy').click();
    await settle();
    expect(d.navigator.clipboard.writeText).toHaveBeenCalledWith('The local processor is not ready. Restart Woodshed.');
    byRole(error, 'button', 'Restart processor').click();
    await settle();
    expect(d.desktop.restartProcessor).toHaveBeenCalled();
    // The device line says so too, with its own Restart.
    expect(sheet.el.querySelector('.lib-add-device').textContent).toContain('Offline');
  });

  test('a createSeparation failure renders inline (spec §3.6) and the sheet stays open', async () => {
    makeDeps();
    d.jobs.createSeparation.mockRejectedValue({code: 'queue_full', message: 'Process the queued songs before adding more.', data: {}});
    const sheet = open({}, {query: {q: 'harbor lights'}});
    await settle();
    submitBtn(sheet).click();
    await settle();
    expect(sheet.el.querySelector('.lib-add-error').textContent).toContain('Too many songs are waiting.');
    expect(sheet.state().busy).toBe(false);
    expect(d.feedback.toast).not.toHaveBeenCalled();
  });
});

// =====================================================================================================
describe('after submit', () => {
  test('the toast with Undo (10 s), the announcement, Back to the Library', async () => {
    makeDeps();
    const sheet = open({}, {query: {q: 'harbor lights'}});
    await settle();
    submitBtn(sheet).click();
    await settle();
    const [message, opts] = d.feedback.toast.mock.calls[0];
    expect(message.map(m => (typeof m === 'string' ? m : m.outerHTML))).toEqual(['Adding ', '<strong>Harbor Lights (Official Audio)</strong>']);
    expect(opts.durationMs).toBe(UNDO_MS);
    expect(opts.action.label).toBe('Undo');
    expect(d.feedback.announce).toHaveBeenCalledWith('Adding Harbor Lights (Official Audio)', expect.objectContaining({politeness: 'polite'}));
    expect(d.router.back).toHaveBeenCalledTimes(1);
    await opts.action.run();
    await settle();
    expect(d.jobs.cancel).toHaveBeenCalledWith({jobId: 'job-new'});
    expect(d.feedback.toast.mock.calls[1][0]).toBe(COPY.undone('Harbor Lights (Official Audio)'));
  });

  test('an Undo that comes too late says so', async () => {
    makeDeps();
    d.jobs.cancel.mockRejectedValue({code: 'job_live'});
    const sheet = open({}, {query: {q: 'harbor lights'}});
    await settle();
    submitBtn(sheet).click();
    await settle();
    await d.feedback.toast.mock.calls[0][1].action.run();
    await settle();
    expect(d.feedback.toast.mock.calls[1]).toEqual([COPY.undoFailed, {tone: 'warn'}]);
  });

  test('⇧↵ adds and keeps the sheet open, cleared, with a note', async () => {
    makeDeps();
    const sheet = open({}, {query: {q: 'harbor lights'}});
    await settle();
    key(input(sheet), 'Enter', {shiftKey: true});
    await settle();
    expect(d.jobs.createSeparation).toHaveBeenCalledTimes(1);
    expect(sheet.el.isConnected).toBe(true);
    expect(d.router.back).not.toHaveBeenCalled();
    expect(input(sheet).value).toBe('');
    expect(allByRole(sheet.el, 'radio')).toHaveLength(0);
    expect(sheet.el.querySelector('.lib-add-notice').textContent).toBe(COPY.added('Harbor Lights (Official Audio)'));
    expect(document.activeElement).toBe(input(sheet));
    expect(sheet.el.querySelector('.lib-add-another').textContent).toContain(COPY.addAnother);
  });

  test('Enter on a button activates it; Enter in the omnibox submits', async () => {
    makeDeps();
    const sheet = open({}, {query: {q: 'harbor lights'}});
    await settle();
    key(sheet.el.querySelector('.lib-add-change'), 'Enter');
    expect(d.jobs.createSeparation).not.toHaveBeenCalled();
    key(input(sheet), 'Enter');
    await settle();
    expect(d.jobs.createSeparation).toHaveBeenCalledTimes(1);
  });

  test('"Search for another version" (state dismissJobId): the failed job is dismissed once the new one exists', async () => {
    makeDeps();
    const sheet = open({}, {query: {q: 'harbor lights'}, state: {dismissJobId: 'job-failed'}});
    await settle();
    expect(input(sheet).value).toBe('harbor lights');
    key(input(sheet), 'Enter', {shiftKey: true});
    await settle();
    key(input(sheet), 'Enter', {shiftKey: true});   // nothing to add now: no second dismiss either
    type(sheet, 'night bus');
    await settle();
    key(input(sheet), 'Enter');
    await settle();
    expect(d.jobs.dismiss).toHaveBeenCalledTimes(1);
    expect(d.jobs.dismiss).toHaveBeenCalledWith({jobId: 'job-failed'});
  });

  test('a web job does not dismiss a job when the add fails', async () => {
    makeDeps({desktop: false});
    d.jobs.createSeparation.mockRejectedValue({code: 'unknown', message: 'boom'});
    const sheet = open({}, {query: {q: 'harbor'}, state: {dismissJobId: 'job-failed'}});
    submitBtn(sheet).click();
    await settle();
    expect(d.jobs.dismiss).not.toHaveBeenCalled();
    expect(sheet.el.querySelector('.lib-add-error').textContent).toContain('Something went wrong while adding this song.');
  });

  test('focusNewCard focuses the new card once the Library shows it, rings it for 1.5 s', async () => {
    vi.useFakeTimers();
    const lib = document.createElement('div');
    document.body.append(lib);
    const stop = focusNewCard({keys: ['job:job-new']}, document);
    const card = document.createElement('article');
    card.className = 'lib-card';
    const openBtn = document.createElement('button');
    openBtn.dataset.focusKey = 'job:job-new';
    card.append(openBtn);
    lib.append(card);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.activeElement).toBe(openBtn);
    expect(card.hasAttribute('data-add-ring')).toBe(true);
    await vi.advanceTimersByTimeAsync(RING_MS);
    expect(card.hasAttribute('data-add-ring')).toBe(false);
    stop();
  });

  test('focusNewCard waits for the Library route when the sheet went Back', async () => {
    vi.useFakeTimers();
    document.documentElement.dataset.viewReady = 'add';
    const card = document.createElement('div');
    card.className = 'lib-row';
    const openBtn = document.createElement('button');
    openBtn.dataset.focusKey = 'job:j2';
    card.append(openBtn);
    document.body.append(card);
    focusNewCard({keys: ['job:j2']}, document, {afterRoute: true});
    await vi.advanceTimersByTimeAsync(0);
    expect(document.activeElement).not.toBe(openBtn);
    document.documentElement.dataset.viewReady = 'library';
    await vi.advanceTimersByTimeAsync(0);
    expect(document.activeElement).toBe(openBtn);
    expect(card.hasAttribute('data-add-ring')).toBe(true);
    delete document.documentElement.dataset.viewReady;
  });

  test('an upload card hands focus to its job card when the upload ends', async () => {
    vi.useFakeTimers();
    const handle = uploadHandle('upload-9', audioFile('a.mp3'));
    const up = document.createElement('button');
    up.dataset.focusKey = 'job:upload:upload-9';
    document.body.append(up);
    focusNewCard({keys: ['job:upload:upload-9'], handles: [handle]}, document);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.activeElement).toBe(up);
    up.remove();
    const job = document.createElement('button');
    job.dataset.focusKey = 'job:job-77';
    document.body.append(job);
    handle.finish('job-77');
    await vi.advanceTimersByTimeAsync(0);
    expect(document.activeElement).toBe(job);
  });
});

// =====================================================================================================
describe('files (desktop)', () => {
  test('rows with name, size, duration and ✕; non-audio and over-1-GB files flagged and excluded', async () => {
    makeDeps();
    staged = [audioFile('Harbor Lights.mp3'), audioFile('garage-take-4.wav', 4_200_000), pdf('notes.pdf'), audioFile('huge.wav', 1_200_000_000)];
    const sheet = open();
    await settle();
    const rows = [...sheet.el.querySelectorAll('.lib-add-file')];
    expect(rows.map(r => r.querySelector('.lib-add-file-name').textContent)).toEqual(['Harbor Lights.mp3', 'garage-take-4.wav']);
    expect(rows[0].querySelector('.lib-add-file-meta').textContent).toBe('3.1 MB · 3:41');
    const flags = [...sheet.el.querySelectorAll('.lib-add-flag')].map(f => f.textContent);
    expect(flags[0]).toBe(MODEL_COPY.notAudio('notes.pdf'));
    expect(flags[1]).toBe(`huge.wav: ${UPLOAD_COPY.tooLarge}`);
    expect(d.durationOf).toHaveBeenCalledTimes(2);
    expect(nameOf(submitBtn(sheet))).toBe('Add 2 files');
    expect(sheet.el.querySelector('.lib-add-title-input')).toBeNull();   // two files: no title override
    byRole(sheet.el, 'button', 'Remove notes.pdf').click();
    expect(sheet.el.querySelectorAll('.lib-add-flag')).toHaveLength(1);
    submitBtn(sheet).click();
    await settle();
    const [files, opts] = d.uploads.startUploads.mock.calls[0];
    expect(files.map(f => f.name)).toEqual(['Harbor Lights.mp3', 'garage-take-4.wav']);
    expect(opts).toMatchObject({deviceId: 'dev1', choice: null});
    expect(opts.settings.preset).toBe('balanced');
    expect(opts.profile).toEqual({instruments: ['drums'], primary: 'drums', openWithMyPart: 'in'});
    expect(opts.title).toBeUndefined();
    expect(d.feedback.toast.mock.calls[0][0][1].textContent).toBe('2 files');
    // Undo cancels every upload.
    await d.feedback.toast.mock.calls[0][1].action.run();
    const handles = d.uploads.startUploads.mock.results[0].value;
    expect(handles.every(hd => hd.cancel.mock.calls.length === 1)).toBe(true);
  });

  test('one file: the editable title (from the file name) is sent only when changed', async () => {
    makeDeps();
    staged = [audioFile('garage-take-4.wav')];
    const sheet = open();
    await settle();
    const field = byRole(sheet.el, 'textbox', COPY.titleField);
    expect(field.value).toBe('garage-take-4');
    expect(nameOf(submitBtn(sheet))).toBe('Add & split');
    key(field, 'Enter', {shiftKey: true});
    await settle();
    expect(d.uploads.startUploads.mock.calls[0][1].title).toBeUndefined();
    staged = [];
    sheet.el.querySelector('.lib-add-file-input');
    // A second file, renamed.
    const sheet2 = (sheets.pop().destroy(), makeDeps(), staged = [audioFile('garage-take-4.wav')], open());
    await settle();
    const field2 = byRole(sheet2.el, 'textbox', COPY.titleField);
    field2.value = 'Garage Groove';
    field2.dispatchEvent(new Event('input', {bubbles: true}));
    key(field2, 'Enter');
    await settle();
    expect(d.uploads.startUploads.mock.calls[0][1].title).toBe('Garage Groove');
    expect(d.feedback.toast.mock.calls[0][0][1].textContent).toBe('Garage Groove');
  });

  test('the whole sheet is a drop zone; Choose files… opens the picker', async () => {
    makeDeps();
    const sheet = open();
    const dt = {types: ['Files'], files: [audioFile('dropped.mp3')], dropEffect: 'none'};
    const enter = new Event('dragenter', {bubbles: true, cancelable: true});
    enter.dataTransfer = dt;
    sheet.el.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(sheet.el.querySelector('.lib-add-drop').hidden).toBe(false);
    const drop = new Event('drop', {bubbles: true, cancelable: true});
    drop.dataTransfer = dt;
    sheet.el.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    await settle();
    expect(sheet.el.querySelector('.lib-add-drop').hidden).toBe(true);
    expect(sheet.el.querySelector('.lib-add-file-name').textContent).toBe('dropped.mp3');
    const picker = sheet.el.querySelector('.lib-add-file-input');
    const click = vi.spyOn(picker, 'click');
    byRole(sheet.el, 'button', COPY.chooseFiles).click();
    expect(click).toHaveBeenCalled();
  });

  test('?pick=1 focuses Choose files… and opens the picker with a user activation', () => {
    makeDeps();
    const click = vi.spyOn(HTMLInputElement.prototype, 'click');
    const sheet = open({}, {query: {pick: '1'}});
    expect(document.activeElement).toBe(byRole(sheet.el, 'button', COPY.chooseFiles));
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
    makeDeps({navigator: {userActivation: {isActive: false}}});
    const click2 = vi.spyOn(HTMLInputElement.prototype, 'click');
    open({}, {query: {pick: '1'}});
    expect(click2).not.toHaveBeenCalled();
    click2.mockRestore();
  });
});

// =====================================================================================================
describe('duplicate notice', () => {
  test('same source link: "Already in your library" with Open it and Add another version', async () => {
    makeDeps();
    const sheet = open({}, {query: {q: 'https://www.youtube.com/watch?v=fixture01'}});
    await settle();
    const notice = sheet.el.querySelector('.lib-add-duplicate');
    expect(notice.textContent).toContain('Already in your library: Glasshouse — Northbound');
    byRole(notice, 'button', 'Open it').click();
    expect(d.router.navigate).toHaveBeenCalledWith('/s/glass');
    byRole(sheet.el, 'button', 'Add another version').click();
    expect(sheet.el.querySelector('.lib-add-duplicate')).toBeNull();
    expect(nameOf(submitBtn(sheet))).toBe('Add & split');
    expect(submitBtn(sheet).getAttribute('aria-disabled')).toBeNull();
  });

  test('a candidate with the same title, artist and duration (±2 s) is a duplicate', async () => {
    makeDeps();
    const sheet = open({}, {query: {q: 'harbor lights'}});
    await settle();
    expect(sheet.el.querySelector('.lib-add-duplicate').textContent).toContain('Harbor Lights — Ada Moreno');
    key(input(sheet), 'ArrowDown');                  // the live version (6:12) is not
    expect(sheet.el.querySelector('.lib-add-duplicate')).toBeNull();
  });
});

// =====================================================================================================
describe('defaults line and Change', () => {
  test('the line from the profile; Change expands Stems, Quality, the save box and hints', () => {
    makeDeps();
    const sheet = open();
    expect(sheet.el.querySelector('.lib-add-defaults-text').textContent).toBe('Split for drums · Balanced quality · 4 stems');
    expect([...sheet.el.querySelectorAll('.lib-add-defaults-text strong')].map(x => x.textContent)).toEqual(['drums', 'Balanced']);
    const change = sheet.el.querySelector('.lib-add-change');
    expect(change.textContent).toBe('Change');
    expect(change.getAttribute('aria-expanded')).toBe('false');
    change.click();
    expect(change.getAttribute('aria-expanded')).toBe('true');
    const stems = byRole(sheet.el, 'radiogroup', COPY.stemsLabel);
    expect([...stems.querySelectorAll('[role=radio]')].map(b => b.textContent.trim())).toEqual(STEM_OPTIONS.map(x => x.label));
    const quality = byRole(sheet.el, 'radiogroup', COPY.qualityLabel);
    expect([...quality.querySelectorAll('[role=radio]')].map(b => b.textContent.trim())).toEqual(QUALITY_OPTIONS.map(x => x.label));
    expect(sheet.el.textContent).toContain(COPY.qualityHint);
    expect(sheet.el.textContent).toContain(COPY.customHint);
    [...stems.querySelectorAll('[role=radio]')][1].click();
    expect(sheet.el.querySelector('.lib-add-defaults-text').textContent).toBe('Split for drums · Balanced quality · 6 stems');
    [...quality.querySelectorAll('[role=radio]')][0].click();
    expect(sheet.el.querySelector('.lib-add-defaults-text').textContent).toBe('Split for drums · Fast quality · 6 stems');
  });

  test('a guitar profile defaults to six stems and warns when a layout removes the part', () => {
    makeDeps({account: {profile: {instruments: ['guitar'], primary: 'guitar', openWithMyPart: 'in'}}});
    const sheet = open();
    expect(sheet.el.querySelector('.lib-add-defaults-text').textContent).toBe('Split for guitar · Balanced quality · 6 stems');
    const warning = sheet.el.querySelector('.lib-add-warning');
    expect(warning.hidden).toBe(true);
    sheet.el.querySelector('.lib-add-change').click();
    [...byRole(sheet.el, 'radiogroup', COPY.stemsLabel).querySelectorAll('[role=radio]')][0].click();
    expect(warning.hidden).toBe(false);
    expect(warning.textContent).toBe('Your guitar won’t be a separate track with this layout.');
  });

  test('the choice goes to the job; "Use these for future songs" saves it with addDefaultsSaved', async () => {
    makeDeps();
    const sheet = open({}, {query: {q: 'harbor lights'}});
    await settle();
    sheet.el.querySelector('.lib-add-change').click();
    [...byRole(sheet.el, 'radiogroup', COPY.stemsLabel).querySelectorAll('[role=radio]')][1].click();
    [...byRole(sheet.el, 'radiogroup', COPY.qualityLabel).querySelectorAll('[role=radio]')][2].click();
    const box = byRole(sheet.el, 'checkbox', COPY.saveDefaults);
    box.checked = true;
    box.dispatchEvent(new Event('change', {bubbles: true}));
    submitBtn(sheet).click();
    await settle();
    expect(d.jobs.createSeparation.mock.calls[0][0].settings).toMatchObject({stemMode: 'six', preset: 'studio'});
    expect(d.account.patch).toHaveBeenCalledWith({stemMode: 'six', preset: 'studio', addDefaultsSaved: true});
  });

  test('without the box nothing is saved; an upload gets the choice through `choice`', async () => {
    makeDeps();
    staged = [audioFile('a.mp3')];
    const sheet = open();
    await settle();
    sheet.el.querySelector('.lib-add-change').click();
    [...byRole(sheet.el, 'radiogroup', COPY.stemsLabel).querySelectorAll('[role=radio]')][2].click();
    submitBtn(sheet).click();
    await settle();
    expect(d.account.patch).not.toHaveBeenCalled();
    expect(d.uploads.startUploads.mock.calls[0][1].choice).toEqual({stemMode: 'drums'});
  });

  test('Quality estimates from this computer’s history (desktop, known duration only)', async () => {
    makeDeps();
    prefsData.jobStats = {balanced: {secPerMin: 30, n: 9}, studio: {secPerMin: 95, n: 2}};
    const sheet = open({}, {query: {q: 'harbor lights'}});
    await settle();
    sheet.el.querySelector('.lib-add-change').click();
    const labels = () => [...byRole(sheet.el, 'radiogroup', COPY.qualityLabel).querySelectorAll('[role=radio]')].map(b => b.textContent.trim());
    expect(labels()).toEqual(['Fast', 'Balanced · ~2 min', 'Studio · ~6 min']);
    expect(sheet.el.querySelector('.lib-add-estimate-note').hidden).toBe(false);
    sheets.pop().destroy();
    makeDeps({desktop: false});
    prefsData.jobStats = {balanced: {secPerMin: 30, n: 9}};
    const web = open({}, {query: {q: 'harbor lights'}});
    web.el.querySelector('.lib-add-change').click();
    expect([...byRole(web.el, 'radiogroup', COPY.qualityLabel).querySelectorAll('[role=radio]')].map(b => b.textContent.trim()))
      .toEqual(['Fast', 'Balanced', 'Studio']);
  });
});

// =====================================================================================================
describe('web and iPad (B5)', () => {
  test('always the single-result line, no lookups; the job goes to the chosen computer, unconfirmed', async () => {
    makeDeps({desktop: false});
    const sheet = open({}, {query: {q: 'harbor lights'}});
    await settle();
    expect(d.lookups.searchSources).not.toHaveBeenCalled();
    expect(sheet.el.querySelector('.lib-add-fallback').textContent).toBe(COPY.searchFallback('harbor lights'));
    const line = sheet.el.querySelector('.lib-add-device').textContent.replace(/\s+/g, ' ');
    expect(line).toContain('Your Studio MacBook will split this · Online');
    submitBtn(sheet).click();
    await settle();
    expect(d.uploads.uploadDevice).not.toHaveBeenCalled();
    expect(d.jobs.createSeparation.mock.calls[0][0]).toMatchObject({deviceId: 'dev1', source: {type: 'search'}, confirmed: false});
  });

  test('a pasted link on the web is confirmed', async () => {
    makeDeps({desktop: false});
    const sheet = open({}, {query: {q: 'https://youtu.be/abc'}});
    submitBtn(sheet).click();
    await settle();
    expect(d.jobs.createSeparation.mock.calls[0][0]).toMatchObject({source: {type: 'url'}, confirmed: true});
  });

  test('the ▾ picker chooses another computer and remembers it; an offline one queues', async () => {
    makeDeps({desktop: false});
    const sheet = open();
    byRole(sheet.el, 'button', COPY.chooseDevice('Studio MacBook')).click();
    const items = allByRole(document.body, 'menuitemradio');
    expect(items.map(nameOf)).toEqual(['Studio MacBook · Online', 'MacBook Pro · Offline']);
    expect(items[0].getAttribute('aria-checked')).toBe('true');
    items[1].click();
    await settle();
    expect(d.prefs.set).toHaveBeenCalledWith('deviceId', 'dev2');
    expect(sheet.el.querySelector('.lib-add-device').textContent).toContain('MacBook Pro is offline. Songs you add start when it’s back.');
    type(sheet, 'harbor');
    submitBtn(sheet).click();
    await settle();
    expect(d.jobs.createSeparation.mock.calls[0][0].deviceId).toBe('dev2');
  });

  test('files are disabled on the web, with the reason; dropped files are listed but not added', async () => {
    makeDeps({desktop: false});
    staged = [audioFile('Harbor Lights.mp3'), pdf('notes.pdf')];
    const sheet = open();
    await settle();
    const choose = byRole(sheet.el, 'button', COPY.chooseFiles);
    expect(choose.getAttribute('aria-disabled')).toBe('true');
    const note = sheet.el.querySelector('.lib-add-files-note');
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe(COPY.filesWeb);
    expect(choose.getAttribute('aria-describedby')).toBe(note.id);
    expect(sheet.el.textContent).toContain('Harbor Lights.mp3');
    expect(sheet.el.textContent).toContain(MODEL_COPY.notAudio('notes.pdf'));
    expect(submitBtn(sheet).getAttribute('aria-disabled')).toBe('true');
    expect(d.durationOf).not.toHaveBeenCalled();
  });

  test('no paired computer: the explainer with the platform download, links, share and the example', async () => {
    makeDeps({desktop: false, devices: []});
    const sheet = open();
    await settle();
    expect(sheet.el.dataset.mode).toBe('explainer');
    expect(sheet.el.querySelector('.lib-add-form').hidden).toBe(true);
    const lead = sheet.el.querySelector('.lib-add-explainer-lead');
    expect(lead.querySelector('strong').textContent).toBe('Splitting happens on your computer.');
    expect(lead.textContent).toContain('Everything you add appears here and on your iPad automatically.');
    const primary = byRole(sheet.el, 'link', /^Download for macOS \(Apple Silicon\)/);
    expect(primary.target).toBe('_blank');
    expect(primary.getAttribute('href')).toBe('https://github.com/KyleKincer/woodshed/releases/download/v2.0.0/Woodshed-mac-arm64.dmg');
    expect(byRole(sheet.el, 'link', /^Other platforms/).getAttribute('href')).toBe('/download');
    expect(byRole(sheet.el, 'button', COPY.shareLink)).toBeNull();     // laptop: no share sheet
    byRole(sheet.el, 'button', COPY.copyLink).click();
    await settle();
    expect(d.navigator.clipboard.writeText).toHaveBeenCalledWith('https://woodshed.example/download');
    expect(sheet.el.querySelector('.lib-add-explainer-status').textContent).toBe(COPY.linkCopied);
    expect(sheet.el.textContent).toContain(COPY.alreadyInstalled);
    byRole(sheet.el, 'button', COPY.openExample).click();
    await settle();
    expect(d.router.navigate).toHaveBeenCalledWith(`/share/${'a'.repeat(64)}`);
  });

  test('explainer on iPad: Get Woodshed for desktop and Share download link (navigator.share)', async () => {
    makeDeps({desktop: false, devices: [], coarse: true, ipad: true});
    const sheet = open();
    await settle();
    expect(d.fetchRelease).not.toHaveBeenCalled();     // nothing to install here
    expect(byRole(sheet.el, 'link', `${COPY.getDesktop} ${COPY.newTab}`).getAttribute('href')).toBe('/download');
    byRole(sheet.el, 'button', COPY.shareLink).click();
    await settle();
    expect(d.navigator.share).toHaveBeenCalledWith({title: COPY.shareTitle, text: COPY.shareText, url: 'https://woodshed.example/download'});
  });

  test('a failing release lookup leaves the primary on /download', async () => {
    makeDeps({desktop: false, devices: [], fetchRelease: vi.fn(async () => { throw new Error('offline'); })});
    const sheet = open();
    await settle();
    expect(byRole(sheet.el, 'link', /^Download for macOS/).getAttribute('href')).toBe('/download');
  });

  test('the device line follows the devices list (the explainer turns into the form)', async () => {
    makeDeps({desktop: false, devices: []});
    const sheet = open();
    expect(sheet.el.dataset.mode).toBe('explainer');
    s.library.devices.value = DEVICES;
    await settle();
    expect(sheet.el.dataset.mode).toBe('web');
    expect(sheet.el.querySelector('.lib-add-form').hidden).toBe(false);
  });
});

// =====================================================================================================
describe('closing, accounts and the view', () => {
  test('✕, Cancel and Esc go Back; the dialog leaves the DOM', () => {
    for (const how of ['close', 'cancel', 'escape']) {
      makeDeps();
      const sheet = open();
      if (how === 'close') byRole(sheet.el, 'button', 'Close').click();
      else if (how === 'cancel') byRole(sheet.el, 'button', 'Cancel').click();
      else key(input(sheet), 'Escape');
      expect(d.router.back).toHaveBeenCalledWith({fallback: '/'});
      expect(sheet.el.isConnected).toBe(false);
      d = null;
    }
  });

  test('an export-only account: "Adding songs is paused" with Plan & storage, and Add is disabled', () => {
    makeDeps({status: 'export_only'});
    const sheet = open({}, {query: {q: 'harbor'}});
    const paused = sheet.el.querySelector('.lib-add-paused');
    expect(paused.hidden).toBe(false);
    expect(paused.textContent).toContain('Adding songs is paused on this account.');
    expect(byRole(paused, 'button', 'Plan & storage')).not.toBeNull();
    expect(submitBtn(sheet).getAttribute('aria-disabled')).toBe('true');
  });

  test('desktop first run: the first-song placeholder, once', () => {
    makeDeps({songs: [], account: {onboarding: {}}});
    const sheet = open();
    expect(input(sheet).placeholder).toBe(COPY.placeholderFirst);
    expect(d.account.markOnboarding).toHaveBeenCalledWith('desktopFirstRun', true);
  });

  test('mount() is the route view: update(match) applies ?q=, unmount() closes', async () => {
    store.library.devices.value = DEVICES;
    const router = {navigate: vi.fn(), back: vi.fn()};
    const host = document.createElement('div');
    document.body.append(host);
    const view = mount(host, {name: 'add', query: {}, params: {}, state: null}, {router});
    const dialog = host.querySelector('dialog.lib-add');
    expect(dialog).not.toBeNull();
    view.update({name: 'add', query: {q: 'night bus'}, params: {}, state: null});
    expect(dialog.querySelector('.lib-add-input').value).toBe('night bus');
    await view.unmount();
    expect(host.querySelector('dialog')).toBeNull();
    store.library.devices.value = [];
  });
});

// =====================================================================================================
describe('LB2b review fixes', () => {
  test('a playlist link stays an error after an edit that keeps the same link (a trailing space)', async () => {
    makeDeps();
    d.lookups.resolveSource.mockRejectedValue({code: 'playlist', message: 'This is a playlist.'});
    const url = 'https://www.youtube.com/playlist?list=PL1';
    const sheet = open({}, {query: {q: url}});
    await settle();
    expect(submitBtn(sheet).getAttribute('aria-disabled')).toBe('true');
    type(sheet, `${url} `);
    await new Promise(r => setTimeout(r, DEBOUNCE_MS + 50));
    await settle();
    expect(d.lookups.resolveSource).toHaveBeenCalledTimes(1);
    expect(sheet.el.querySelector('.lib-add-error').textContent).toContain('This link is a playlist. Add one song at a time.');
    expect(sheet.state().canSubmit).toBe(false);
    expect(submitBtn(sheet).getAttribute('aria-disabled')).toBe('true');
    key(input(sheet), 'Enter');
    submitBtn(sheet).click();
    await settle();
    expect(d.jobs.createSeparation).not.toHaveBeenCalled();
    // Back to the same link after a different one: still blocked.
    type(sheet, 'harbor lights');
    expect(sheet.el.querySelector('.lib-add-error')).toBeNull();
  });

  test('a lookup that fell back while the processor was starting is asked again once it is ready', async () => {
    makeDeps({phase: 'starting'});
    d.lookups.searchSources.mockRejectedValueOnce({code: 'aborted'});
    const sheet = open({}, {query: {q: 'harbor lights'}});
    await settle();
    expect(sheet.state().lookup.status).toBe('fallback');
    expect(allByRole(sheet.el, 'radio')).toHaveLength(0);
    s.processor.value = {...s.processor.peek(), phase: 'ready'};
    await settle();
    expect(d.lookups.searchSources).toHaveBeenCalledTimes(2);
    expect(allByRole(sheet.el, 'radio')).toHaveLength(3);
    // A fallback with the processor up and a real answer (bot check) is not asked again on the next tick.
    sheets.pop().destroy();
    makeDeps();
    d.lookups.searchSources.mockRejectedValue({code: 'bot_check'});
    const other = open({}, {query: {q: 'harbor lights'}});
    await settle();
    s.processor.value = {...s.processor.peek(), phase: 'busy'};
    s.processor.value = {...s.processor.peek(), phase: 'ready'};
    await settle();
    expect(d.lookups.searchSources).toHaveBeenCalledTimes(1);
    expect(other.state().lookup.status).toBe('fallback');
  });

  test('the title field keeps focus and the caret when the file’s duration arrives', async () => {
    let finish;
    makeDeps({durationOf: vi.fn(() => new Promise(r => { finish = r; }))});
    staged = [audioFile('Harbor Lights.mp3')];
    const sheet = open();
    const field = byRole(sheet.el, 'textbox', COPY.titleField);
    field.focus();
    field.value = 'My Title';
    field.dispatchEvent(new Event('input', {bubbles: true}));
    field.setSelectionRange(2, 2);
    finish(200);
    await settle();
    expect(sheet.el.querySelector('.lib-add-file-meta').textContent).toContain('3:20');
    expect(document.activeElement).toBe(field);
    expect(field.isConnected).toBe(true);
    expect(field.selectionStart).toBe(2);
  });

  test('removing a file moves focus to the next row’s ✕ (the last one at the end)', async () => {
    makeDeps();
    staged = [audioFile('a.mp3'), audioFile('b.mp3'), audioFile('c.mp3')];
    const sheet = open();
    await settle();
    byRole(sheet.el, 'button', COPY.removeFile('b.mp3')).click();
    expect(document.activeElement.getAttribute('aria-label')).toBe(COPY.removeFile('c.mp3'));
    byRole(sheet.el, 'button', COPY.removeFile('c.mp3')).click();
    expect(document.activeElement.getAttribute('aria-label')).toBe(COPY.removeFile('a.mp3'));
    byRole(sheet.el, 'button', COPY.removeFile('a.mp3')).click();
    expect(document.activeElement).toBe(input(sheet));
  });

  test('closed while an add is in flight, a failure is reported in a toast', async () => {
    makeDeps();
    let fail;
    d.jobs.createSeparation.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    const sheet = open({}, {query: {q: 'harbor lights'}});
    await settle();
    submitBtn(sheet).click();
    await settle();
    key(input(sheet), 'Escape');
    expect(sheet.state().open).toBe(false);
    fail({code: 'queue_full', message: 'Process the queued songs before adding more.', data: {}});
    await settle();
    expect(d.feedback.toast).toHaveBeenCalledTimes(1);
    const [message, opts] = d.feedback.toast.mock.calls[0];
    expect(message.startsWith('The song wasn’t added. Too many songs are waiting.')).toBe(true);
    expect(opts.tone).toBe('warn');
  });

  test('"Use these for future songs" with a two-part layout saves only the quality', async () => {
    makeDeps();
    const sheet = open({}, {query: {q: 'harbor lights'}});
    await settle();
    sheet.el.querySelector('.lib-add-change').click();
    const note = sheet.el.querySelector('.lib-add-two-part-note');
    expect(note.hidden).toBe(true);
    [...byRole(sheet.el, 'radiogroup', COPY.stemsLabel).querySelectorAll('[role=radio]')][STEM_OPTIONS.findIndex(x => x.value === 'drums')].click();
    [...byRole(sheet.el, 'radiogroup', COPY.qualityLabel).querySelectorAll('[role=radio]')][0].click();
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe(COPY.saveTwoPart);
    const box = byRole(sheet.el, 'checkbox', COPY.saveDefaults);
    box.checked = true;
    box.dispatchEvent(new Event('change', {bubbles: true}));
    submitBtn(sheet).click();
    await settle();
    expect(d.jobs.createSeparation.mock.calls[0][0].settings).toMatchObject({stemMode: 'drums', preset: 'fast'});
    expect(d.account.patch).toHaveBeenCalledWith({preset: 'fast'});
  });

  test('desktop first run waits for the library: a user with songs keeps the flag', async () => {
    makeDeps({songs: [], account: {onboarding: {}}});
    s.library.loaded = signal(false);
    const sheet = open();
    expect(d.account.markOnboarding).not.toHaveBeenCalled();
    expect(input(sheet).placeholder).toBe(COPY.placeholder);
    s.library.songs.value = new Map(SONGS.map(x => [x.id, x]));
    s.library.loaded.value = true;
    await settle();
    expect(d.account.markOnboarding).not.toHaveBeenCalled();
    expect(input(sheet).placeholder).toBe(COPY.placeholder);
    sheets.pop().destroy();
    makeDeps({songs: [], account: {onboarding: {}}});
    s.library.loaded = signal(false);
    const fresh = open();
    s.library.loaded.value = true;
    await settle();
    expect(d.account.markOnboarding).toHaveBeenCalledTimes(1);
    expect(input(fresh).placeholder).toBe(COPY.placeholderFirst);
  });

  test('web with dropped files: the files reason is said once', async () => {
    makeDeps({desktop: false});
    staged = [audioFile('Harbor Lights.mp3')];
    const sheet = open();
    await settle();
    const lines = [...sheet.el.querySelectorAll('p')].filter(p => visible(p) && p.textContent === COPY.filesWeb);
    expect(lines).toHaveLength(1);
  });

  test('one paired computer still has the ▾ picker', async () => {
    makeDeps({desktop: false, devices: [DEVICES[0]]});
    const sheet = open();
    byRole(sheet.el, 'button', COPY.chooseDevice('Studio MacBook')).click();
    expect(allByRole(document.body, 'menuitemradio').map(nameOf)).toEqual(['Studio MacBook · Online']);
  });

  test('candidate rows carry a source icon', async () => {
    makeDeps();
    d.lookups.searchSources.mockResolvedValue({query: 'x', candidates: [RESULTS[0], {...RESULTS[1], provider: 'soundcloud'}, {...RESULTS[2], provider: 'vimeo'}]});
    const sheet = open({}, {query: {q: 'harbor lights'}});
    await settle();
    expect([...sheet.el.querySelectorAll('.lib-add-candidate-meta > svg')].map(n => n.dataset.icon)).toEqual(['play', 'cloud', 'link']);
  });

  test('a Spotify link with no YouTube candidates gets the Spotify single-result line and still adds', async () => {
    makeDeps();
    d.lookups.resolveSource.mockResolvedValue({kind: 'spotify', query: 'Harbor Lights Ada Moreno', candidates: []});
    const url = 'https://open.spotify.com/track/abc';
    const sheet = open({}, {query: {q: url}});
    await settle();
    expect(sheet.el.querySelector('.lib-add-fallback').textContent).toBe(COPY.spotifyFallback);
    expect(sheet.el.textContent).not.toContain(COPY.noResults(url));
    submitBtn(sheet).click();
    await settle();
    expect(d.jobs.createSeparation.mock.calls[0][0]).toMatchObject({source: {type: 'spotify', value: url}, confirmed: false});
  });

  test('iPad: a swipe down on the header dismisses past a quarter of the height; a short one does not', () => {
    const pointer = (type, y, target) => {
      const e = new MouseEvent(type, {bubbles: true, cancelable: true, clientY: y, clientX: 100, button: 0});
      Object.defineProperty(e, 'pointerId', {value: 1});
      target.dispatchEvent(e);
      return e;
    };
    makeDeps({desktop: false, coarse: true, ipad: true});
    const sheet = open();
    expect(sheet.state().presentation).toBe('sheet');
    vi.spyOn(sheet.el, 'getBoundingClientRect').mockReturnValue({left: 0, right: 800, top: 100, bottom: 1000, width: 800, height: 900, x: 0, y: 100});
    const head = sheet.el.querySelector('.lib-add-head');
    pointer('pointerdown', 120, head);
    pointer('pointermove', 180, head);
    expect(sheet.el.style.getPropertyValue('translate')).toBe('0 60px');
    pointer('pointerup', 180, head);
    expect(sheet.state().open).toBe(true);
    expect(d.router.back).not.toHaveBeenCalled();
    pointer('pointerdown', 120, head);
    pointer('pointermove', 400, head);
    pointer('pointerup', 400, head);
    expect(sheet.state().open).toBe(false);
    expect(d.router.back).toHaveBeenCalledWith({fallback: '/'});
  });

  test('a pointerdown on the backdrop (outside the dialog box) closes; inside it does not', () => {
    makeDeps();
    const sheet = open();
    vi.spyOn(sheet.el, 'getBoundingClientRect').mockReturnValue({left: 320, right: 960, top: 80, bottom: 600, width: 640, height: 520, x: 320, y: 80});
    const down = (x, y) => sheet.el.dispatchEvent(new MouseEvent('pointerdown', {bubbles: true, clientX: x, clientY: y}));
    down(400, 200);
    expect(sheet.state().open).toBe(true);
    down(40, 200);
    expect(sheet.state().open).toBe(false);
    expect(d.router.back).toHaveBeenCalledWith({fallback: '/'});
  });
});
