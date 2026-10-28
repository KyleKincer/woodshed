// @vitest-environment happy-dom
// The Re-split dialog (architecture §2.16, spec §3.7; D38): the title, the Stems and Quality radiogroups with their
// preselection, the cost line from prefs.jobStats and the processor's name, the jobs it starts, D38's refusal shown
// inline, several songs, and the web.
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {installPopoverShim, restoreDomShims, tap} from './helpers/dom.js';

vi.mock('../src/library/upload.js', () => ({uploadDevice: vi.fn(async () => 'dev-local')}));

const {openResplitDialog, openResplit, presetOf, estimateMinutes, costLine} = await import('../src/library/resplit-dialog.js');
const {COPY, CONTROLS} = await import('../src/library/library-actions.copy.js');
const {signal} = await import('../src/app/store.js');
const {PRESETS} = await import('../convex/lib/presets.ts');

const HARBOR = {id: 'harbor', title: 'Harbor Lights', duration: 240, stemMode: 'full', quality: {model: 'htdemucs_ft', shifts: 2, overlap: 0.25, format: 'opus'}};
const LANTERNS = {id: 'lanterns', title: 'Paper Lanterns', duration: 120, stemMode: 'six', quality: {model: 'htdemucs_6s', shifts: 0, overlap: 0.25, format: 'opus'}};

function nameOf(el) {
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) return labelledby.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim();
  return (el.getAttribute('aria-label') ?? el.textContent).replace(/\s+/g, ' ').trim();
}

function setup({desktop = true, stats = {balanced: {secPerMin: 60, n: 4}}, settings = {preset: 'balanced', stemMode: 'full'}, processor = {name: 'MacBook Pro', deviceId: 'dev1'}} = {}) {
  const store = {library: {songs: signal(new Map([[HARBOR.id, HARBOR], [LANTERNS.id, LANTERNS]]))}};
  const account = {value: signal(settings), profile: signal({instruments: ['drums'], primary: 'drums'})};
  const prefs = {value: signal({jobStats: stats})};
  const jobs = {createSeparation: vi.fn(async () => ({jobId: 'j1'}))};
  const calls = [];
  const toast = vi.fn((message, options = {}) => { calls.push({message, options}); return {dismiss() {}, update() {}}; });
  const opts = {store, account, prefs, jobs, toast, desktop: {available: desktop, processor: signal(processor), refreshStatus: vi.fn()}};
  return {opts, jobs, calls, toast};
}

const dialog = () => document.querySelector('dialog.ui-dialog');
const groups = () => [...dialog().querySelectorAll('[role=radiogroup]')];
const checked = group => group.querySelector('[aria-checked=true]').textContent;
const submit = () => dialog().querySelector('form').dispatchEvent(new Event('submit', {cancelable: true}));

beforeEach(() => { installPopoverShim(); document.body.replaceChildren(); });
afterEach(() => { restoreDomShims(); for (const d of document.querySelectorAll('dialog')) d.remove(); });

describe('pure parts', () => {
  it('presetOf reads a stored quality (the 6-stem model runs every preset)', () => {
    expect(presetOf(HARBOR.quality)).toBe('balanced');
    expect(presetOf({...PRESETS.studio})).toBe('studio');
    expect(presetOf(LANTERNS.quality)).toBe('fast');
    expect(presetOf({model: 'mdx_extra', shifts: 3, overlap: 0.1})).toBeNull();
    expect(presetOf(null)).toBeNull();
  });

  it('estimateMinutes: secPerMin × minutes of audio, at least 1; null without history', () => {
    expect(estimateMinutes({stats: {balanced: {secPerMin: 60}}, preset: 'balanced', seconds: 240})).toBe(4);
    expect(estimateMinutes({stats: {balanced: {secPerMin: 6}}, preset: 'balanced', seconds: 30})).toBe(1);
    expect(estimateMinutes({stats: {}, preset: 'studio', seconds: 240})).toBeNull();
    expect(estimateMinutes({stats: null, preset: 'fast', seconds: 240})).toBeNull();
  });

  it('the cost line is spec §3.7’s, and honest without history', () => {
    expect(costLine({device: 'MacBook Pro', preset: 'balanced', seconds: 240, stats: {balanced: {secPerMin: 60}}}))
      .toBe('Runs on MacBook Pro · about 4 min at Balanced · replaces the stems; your loops, map, spots and chart are kept.');
    expect(costLine({device: null, preset: 'studio', seconds: 240, stats: {}}))
      .toBe('Runs on this computer · Studio quality · replaces the stems; your loops, map, spots and chart are kept.');
  });
});

describe('openResplitDialog', () => {
  it('renders the controls table: title, Stems and Quality radiogroups, Cancel and Re-split', () => {
    const {opts} = setup();
    void openResplitDialog({...opts, songId: 'harbor'});
    expect(nameOf(dialog())).toBe('Re-split Harbor Lights');
    for (const row of CONTROLS.filter(r => r.where === 'resplit-dialog' && r.role !== 'dialog')) {
      const found = [...dialog().querySelectorAll(row.role === 'button' ? 'button' : `[role=${row.role}]`)].some(el => nameOf(el) === row.name);
      expect(found, `${row.role} "${row.name}"`).toBe(true);
    }
    expect([...groups()[0].querySelectorAll('[role=radio]')].map(b => b.textContent)).toEqual(['4 stems', '6 stems', 'Drums + rest', 'Vocals + rest', 'Bass + rest']);
    expect([...groups()[1].querySelectorAll('[role=radio]')].map(b => b.textContent)).toEqual(['Fast', 'Balanced', 'Studio']);
  });

  it('preselects the song’s stems and quality; the cost line follows the choice', () => {
    const {opts} = setup({stats: {balanced: {secPerMin: 60}, studio: {secPerMin: 180}}});
    void openResplitDialog({...opts, songId: 'harbor'});
    const [stems, quality] = groups();
    expect(checked(stems)).toBe('4 stems');
    expect(checked(quality)).toBe('Balanced');
    const cost = dialog().querySelector('.lib-resplit-cost');
    expect(cost.textContent).toBe('Runs on MacBook Pro · about 4 min at Balanced · replaces the stems; your loops, map, spots and chart are kept.');
    tap([...quality.querySelectorAll('[role=radio]')].find(b => b.textContent === 'Studio'));
    expect(cost.textContent).toBe('Runs on MacBook Pro · about 12 min at Studio · replaces the stems; your loops, map, spots and chart are kept.');
    expect(cost.getAttribute('aria-live')).toBe('polite');
  });

  it('opts.stemMode preselects ("Re-split with 6 stems"); Custom is offered when the account uses it', () => {
    const {opts} = setup({settings: {preset: 'custom', stemMode: 'full', custom: {model: 'htdemucs_ft', shifts: 4, overlap: 0.3}}});
    void openResplitDialog({...opts, songId: 'harbor', stemMode: 'six'});
    expect(checked(groups()[0])).toBe('6 stems');
    expect([...groups()[1].querySelectorAll('[role=radio]')].map(b => b.textContent)).toEqual(['Fast', 'Balanced', 'Studio', 'Custom']);
  });

  it('[Re-split] starts the job on this computer with the chosen settings, then closes with a toast', async () => {
    const {opts, jobs, calls} = setup();
    const closed = openResplitDialog({...opts, songId: 'harbor'});
    tap([...groups()[0].querySelectorAll('[role=radio]')].find(b => b.textContent === '6 stems'));
    tap([...groups()[1].querySelectorAll('[role=radio]')].find(b => b.textContent === 'Fast'));
    submit();
    await closed;
    expect(jobs.createSeparation).toHaveBeenCalledTimes(1);
    const args = jobs.createSeparation.mock.calls[0][0];
    expect(args).toMatchObject({deviceId: 'dev1', label: 'Harbor Lights', replaceSongId: 'harbor'});
    expect(args.settings).toMatchObject({stemMode: 'six', preset: 'fast'});
    expect(args.source).toBeUndefined();     // the song's own source (the server inherits it)
    expect(dialog()).toBeNull();
    expect(calls.at(-1).message).toBe('Re-splitting “Harbor Lights”');
    expect(opts.desktop.refreshStatus).toHaveBeenCalled();
  });

  it('without the processor’s device id it asks the companion (uploadDevice)', async () => {
    const {opts, jobs} = setup({processor: {name: null, deviceId: null}});
    const closed = openResplitDialog({...opts, songId: 'harbor'});
    expect(dialog().querySelector('.lib-resplit-cost').textContent).toMatch(/^Runs on this computer · /);
    submit();
    await closed;
    expect(jobs.createSeparation.mock.calls[0][0].deviceId).toBe('dev-local');
  });

  it('D38: the wrong computer is refused inline, in error-copy’s words, and the dialog stays open', async () => {
    const {opts, jobs} = setup();
    jobs.createSeparation.mockRejectedValueOnce(Object.assign(new Error('wrong device'), {code: 'resplit_wrong_device', data: {deviceName: 'DESKTOP-4F2K9'}}));
    void openResplitDialog({...opts, songId: 'harbor'});
    submit();
    await vi.waitFor(() => expect(dialog().querySelector('.ui-dialog-error').hidden).toBe(false));
    expect(dialog().querySelector('.ui-dialog-error').textContent).toBe('Re-split this song on DESKTOP-4F2K9, which has the original file.');
    expect(dialog().open).toBe(true);
  });

  it('several songs: one dialog, one job each, the many-songs copy', async () => {
    const {opts, jobs, calls} = setup();
    const closed = openResplitDialog({...opts, songIds: ['harbor', 'lanterns']});
    expect(dialog().querySelector('.ui-dialog-title').textContent).toBe('Re-split 2 songs');
    expect(dialog().querySelector('.lib-resplit-cost').textContent)
      .toBe('Runs on MacBook Pro · about 6 min at Balanced · replaces their stems; your loops, maps, spots and charts are kept.');
    submit();
    await closed;
    expect(jobs.createSeparation.mock.calls.map(c => c[0].replaceSongId)).toEqual(['harbor', 'lanterns']);
    expect(calls.at(-1).message).toBe('Re-splitting 2 songs');
  });

  it('several songs, some refused: the rest start; the toast names the songs left out, with Details and reasons', async () => {
    const {opts, jobs, calls} = setup();
    jobs.createSeparation.mockRejectedValueOnce(Object.assign(new Error('elsewhere'), {code: 'resplit_wrong_device', data: {deviceName: 'Studio iMac'}}))
      .mockResolvedValueOnce({jobId: 'b'});
    const closed = openResplitDialog({...opts, songIds: ['harbor', 'lanterns']});
    submit();
    await closed;
    const report = calls.at(-1);
    expect(report.message).toBe('Re-splitting 1 of 2 songs. Not started: Harbor Lights.');
    expect(report.options.tone).toBe('error');
    expect(report.options.action.label).toBe('Details');
    report.options.action.run();
    const details = dialog();
    expect(details.querySelector('.ui-dialog-title').textContent).toBe('Not started: Harbor Lights.');
    const row = details.querySelector('.lib-fail-row');
    expect(row.textContent).toContain('Harbor Lights');
    expect(row.querySelector('span').textContent.length).toBeGreaterThan(0);
  });

  it('a full queue with three songs reports every one left, without trying them', async () => {
    const {opts, jobs, calls} = setup();
    opts.store.library.songs.value = new Map([[HARBOR.id, HARBOR], [LANTERNS.id, LANTERNS], ['third', {id: 'third', title: 'Third', duration: 60}]]);
    jobs.createSeparation.mockResolvedValueOnce({jobId: 'a'})
      .mockRejectedValueOnce(Object.assign(new Error('x'), {code: 'queue_full'}));
    const closed = openResplitDialog({...opts, songIds: ['harbor', 'lanterns', 'third']});
    submit();
    await closed;
    expect(jobs.createSeparation).toHaveBeenCalledTimes(2);
    const report = calls.at(-1);
    expect(report.message).toBe(`${COPY.resplitPartial(1, 3)} ${COPY.resplitQueueFull}`);
    report.options.action.run();
    expect([...dialog().querySelectorAll('.lib-fail-row strong')].map(n => n.textContent)).toEqual(['Paper Lanterns', 'Third']);
  });

  it('the web never opens it ("Needs Woodshed for desktop"); a missing song toasts', async () => {
    const web = setup({desktop: false});
    await openResplitDialog({...web.opts, songId: 'harbor'});
    expect(dialog()).toBeNull();
    expect(web.calls[0].message).toBe('Needs Woodshed for desktop');
    const gone = setup();
    await openResplit({id: 'nope'}, gone.opts);
    expect(gone.calls[0].message).toBe(COPY.resplitGone);
  });

  it('Cancel closes without starting anything', async () => {
    const {opts, jobs} = setup();
    const closed = openResplitDialog({...opts, songId: 'harbor'});
    tap([...dialog().querySelectorAll('.ui-dialog-action')].find(b => b.textContent === 'Cancel'));
    await closed;
    expect(jobs.createSeparation).not.toHaveBeenCalled();
  });
});
