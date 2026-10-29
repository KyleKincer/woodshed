// @vitest-environment happy-dom
// SH1: the Share dialog (spec §6.1; architecture §2.18), the device-local practice of a share token and its
// migration into the saved copy (spec §4.13), and the demo entry point (D7).
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {installPopoverShim, restoreDomShims} from './helpers/dom.js';

const {openShareDialog, shareUrl, shareOrigin, COPIED_MS} = await import('../src/share/share-dialog.js');
const {sharedPractice, watchLocalNotice, migrateSharedPractice, NOTICE_MS} = await import('../src/share/shared-practice.js');
const {demoToken, openDemo, resetDemoToken} = await import('../src/share/demo.js');
const {COPY} = await import('../src/share/share.copy.js');
const {signal} = await import('../src/app/store.js');
const {deviceStore} = await import('../src/app/prefs.js');

const TOKEN = 'a3f1'.repeat(16);
const NEXT = 'b7c2'.repeat(16);
const ORIGIN = {env: {}, location: {origin: 'https://woodshed.test'}};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async (n = 4) => { for (let i = 0; i < n; i++) await flush(); };

function memoryStore() {
  const map = new Map();
  return {
    get: key => (map.has(key) ? structuredClone(map.get(key)) : null),
    set: (key, value) => { map.set(key, structuredClone(value)); },
    remove: key => { map.delete(key); },
    map,
  };
}

function fakeSharing({status = null, failStatus = null, failCreate = null} = {}) {
  const calls = [];
  let current = status;
  return {
    calls,
    status: vi.fn(async args => { calls.push(['status', args]); if (failStatus) throw failStatus; return current; }),
    create: vi.fn(async args => {
      calls.push(['create', args]);
      if (failCreate) throw failCreate;
      current = {token: current?.token ?? TOKEN, includeNotation: args.includeNotation, includeMap: args.includeMap};
      return {token: current.token};
    }),
    revoke: vi.fn(async args => { calls.push(['revoke', args]); current = null; return null; }),
  };
}

function fakeFeedback({confirm = true} = {}) {
  return {confirm: vi.fn(async () => confirm), announce: vi.fn(), toast: vi.fn(), status: vi.fn()};
}

const dialog = () => document.querySelector('dialog.ui-dialog.share-dialog');
const q = sel => dialog()?.querySelector(sel);
const buttonByText = text => [...dialog().querySelectorAll('button')].find(b => b.textContent.replace(/\s+/g, ' ').trim().startsWith(text));
const visible = el => !!el && !el.closest('[hidden]');

beforeEach(() => { installPopoverShim(); document.body.replaceChildren(); });
afterEach(() => { vi.useRealTimers(); restoreDomShims(); for (const d of document.querySelectorAll('dialog')) d.remove(); });

describe('share URL', () => {
  it('uses VITE_SHARE_ORIGIN (without a trailing slash) over the page origin', () => {
    expect(shareUrl(TOKEN, {env: {VITE_SHARE_ORIGIN: 'https://woodshed.kylekincer.com/'}, location: {origin: 'app://woodshed'}}))
      .toBe(`https://woodshed.kylekincer.com/share/${TOKEN}`);
    expect(shareUrl(TOKEN, ORIGIN)).toBe(`https://woodshed.test/share/${TOKEN}`);
    expect(shareOrigin({env: {VITE_SHARE_ORIGIN: '  '}, location: {origin: 'https://a.b'}})).toBe('https://a.b');
  });
});

describe('the Share dialog', () => {
  const GLASS = {id: 'glasshouse', title: 'Glasshouse', hasChart: true};

  it('opens as "Share <title>" with the body, the two choices and Create link; nothing is created until asked', async () => {
    const sharing = fakeSharing();
    const done = openShareDialog({song: GLASS, session: null}, {sharing, feedback: fakeFeedback(), ...ORIGIN});
    await settle();
    expect(dialog().querySelector('.ui-dialog-title').textContent).toBe('Share Glasshouse');
    expect(q('.share-lead').textContent).toBe('Anyone with the link can listen and practise along. They can save their own copy.');
    const labels = [...dialog().querySelectorAll('.share-check')].map(l => l.textContent.trim());
    expect(labels).toEqual(['Sections and tempo map', 'Drum chart']);
    const [map, chart] = dialog().querySelectorAll('.share-check-input');
    expect(map.checked).toBe(true);
    expect(chart.checked).toBe(false);
    expect(chart.disabled).toBe(false);
    expect(visible(buttonByText('Create link'))).toBe(true);
    expect(visible(q('.share-link'))).toBe(false);
    expect(sharing.create).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(buttonByText('Create link'));
    buttonByText('Done').click();
    await done;
    expect(dialog()).toBeNull();
  });

  it('Create link flushes the session first, sends the choices, then shows the read-only link with Copy link', async () => {
    const sharing = fakeSharing();
    const order = [];
    const session = {flush: vi.fn(async opts => { order.push(['flush', opts]); })};
    sharing.create.mockImplementation(async args => { order.push(['create', args]); return {token: TOKEN}; });
    void openShareDialog({song: GLASS, session}, {sharing, feedback: fakeFeedback(), ...ORIGIN});
    await settle();
    dialog().querySelectorAll('.share-check-input')[1].click();   // ☑ Drum chart
    buttonByText('Create link').click();
    await settle();
    expect(order).toEqual([['flush', {final: true}], ['create', {id: 'glasshouse', includeMap: true, includeNotation: true}]]);
    const input = q('.share-link-input');
    expect(visible(input)).toBe(true);
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe(`https://woodshed.test/share/${TOKEN}`);
    expect(dialog().querySelector(`label[for="${input.id}"]`).textContent).toBe('Link');
    expect(q('.share-link .share-note').textContent).toBe('A new link replaces the old one.');
    expect(visible(buttonByText('Stop sharing'))).toBe(true);
    expect(visible(buttonByText('Create link'))).toBe(false);
    expect(document.activeElement).toBe(buttonByText('Copy link'));
  });

  it('Copy link writes the URL and reads "Copied ✓" for 2 s', async () => {
    const sharing = fakeSharing({status: {token: TOKEN, includeNotation: false, includeMap: true}});
    const clipboard = {writeText: vi.fn(async () => {})};
    const feedback = fakeFeedback();
    void openShareDialog({song: GLASS}, {sharing, feedback, clipboard, ...ORIGIN});
    await settle();
    vi.useFakeTimers();
    buttonByText('Copy link').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(clipboard.writeText).toHaveBeenCalledWith(`https://woodshed.test/share/${TOKEN}`);
    const copy = q('.share-copy');
    expect(copy.textContent).toContain('Copied ✓');
    expect(feedback.announce).toHaveBeenCalledWith('Link copied');
    await vi.advanceTimersByTimeAsync(COPIED_MS - 10);
    expect(copy.textContent).toContain('Copied ✓');
    await vi.advanceTimersByTimeAsync(20);
    expect(copy.textContent).toContain('Copy link');
    expect(copy.textContent).not.toContain('Copied');
  });

  it('a refused clipboard selects the link and says so', async () => {
    const sharing = fakeSharing({status: {token: TOKEN, includeNotation: true, includeMap: true}});
    const clipboard = {writeText: vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError'); })};
    void openShareDialog({song: GLASS}, {sharing, feedback: fakeFeedback(), clipboard, ...ORIGIN});
    await settle();
    buttonByText('Copy link').click();
    await settle();
    expect(q('.share-status').textContent).toContain('Select the link and copy it.');
    expect(document.activeElement).toBe(q('.share-link-input'));
  });

  it('an active link shows at once with its stored choices; changing one updates that link', async () => {
    const sharing = fakeSharing({status: {token: TOKEN, includeNotation: true, includeMap: false}});
    const session = {flush: vi.fn(async () => {})};
    void openShareDialog({song: GLASS, session}, {sharing, feedback: fakeFeedback(), ...ORIGIN});
    await settle();
    const [map, chart] = dialog().querySelectorAll('.share-check-input');
    expect(map.checked).toBe(false);
    expect(chart.checked).toBe(true);
    expect(document.activeElement).toBe(buttonByText('Copy link'));
    map.click();
    await settle();
    expect(sharing.create).toHaveBeenLastCalledWith({id: 'glasshouse', includeMap: true, includeNotation: true});
    expect(session.flush).toHaveBeenCalledWith({final: true});
    expect(q('.share-status').textContent).toContain('Link updated.');
  });

  it('a failed update reverts the choice and shows the share error', async () => {
    const err = Object.assign(new Error('nope'), {code: 'network'});
    const sharing = fakeSharing({status: {token: TOKEN, includeNotation: false, includeMap: true}, failCreate: err});
    void openShareDialog({song: GLASS}, {sharing, feedback: fakeFeedback(), ...ORIGIN});
    await settle();
    const [map] = dialog().querySelectorAll('.share-check-input');
    map.click();
    await settle();
    expect(map.checked).toBe(true);
    const line = q('.share-status');
    expect(line.getAttribute('role')).toBe('alert');
    expect(line.textContent.trim().length).toBeGreaterThan(0);
  });

  it('Stop sharing asks first ("Stop sharing? The link stops working for everyone."), then revokes', async () => {
    const sharing = fakeSharing({status: {token: TOKEN, includeNotation: false, includeMap: true}});
    const feedback = fakeFeedback({confirm: false});
    void openShareDialog({song: GLASS}, {sharing, feedback, ...ORIGIN});
    await settle();
    expect(buttonByText('Stop sharing').dataset.variant).toBe('quiet');
    expect(buttonByText('Stop sharing').dataset.tone).toBe('danger');
    buttonByText('Stop sharing').click();
    await settle();
    expect(feedback.confirm).toHaveBeenCalledWith({title: 'Stop sharing?', body: 'The link stops working for everyone.', confirmLabel: 'Stop sharing', danger: true});
    expect(sharing.revoke).not.toHaveBeenCalled();
    feedback.confirm.mockResolvedValue(true);
    buttonByText('Stop sharing').click();
    await settle();
    expect(sharing.revoke).toHaveBeenCalledWith({id: 'glasshouse'});
    expect(visible(q('.share-link'))).toBe(false);
    expect(visible(buttonByText('Create link'))).toBe(true);
    expect(document.activeElement).toBe(buttonByText('Create link'));
    expect(q('.share-status').textContent).toContain('Sharing stopped.');
  });

  it('a song without a drum chart cannot include one (disabled, with the reason linked)', async () => {
    const sharing = fakeSharing();
    void openShareDialog({song: {id: 'lowtide', title: 'Low Tide'}}, {sharing, feedback: fakeFeedback(), ...ORIGIN});
    await settle();
    const chart = dialog().querySelectorAll('.share-check-input')[1];
    expect(chart.disabled).toBe(true);
    expect(document.getElementById(chart.getAttribute('aria-describedby')).textContent).toBe('This song has no drum chart yet.');
    buttonByText('Create link').click();
    await settle();
    expect(sharing.create).toHaveBeenCalledWith({id: 'lowtide', includeMap: true, includeNotation: false});
  });

  it('a failed status lookup still allows Create link, with the error shown', async () => {
    const sharing = fakeSharing({failStatus: Object.assign(new Error('offline'), {code: 'network'})});
    void openShareDialog({song: GLASS}, {sharing, feedback: fakeFeedback(), ...ORIGIN});
    await settle();
    expect(q('.share-status').getAttribute('role')).toBe('alert');
    expect(buttonByText('Create link').getAttribute('aria-disabled')).not.toBe('true');
  });

  it('an export-only account (D10) cannot create a link or change its choices, and is told why', async () => {
    const store = {session: signal({user: {id: 'u1'}, status: 'export_only'})};
    const none = fakeSharing();
    void openShareDialog({song: GLASS, session: null}, {sharing: none, feedback: fakeFeedback(), store, ...ORIGIN});
    await settle();
    expect(buttonByText('Create link').getAttribute('aria-disabled')).toBe('true');
    expect([...dialog().querySelectorAll('.share-check-input')].every(box => box.disabled)).toBe(true);
    expect(q('.share-status').textContent).toContain(COPY.exportOnly);
    buttonByText('Create link').click();
    await settle();
    expect(none.create).not.toHaveBeenCalled();
    buttonByText('Done').click();
    await settle();
    // An active link can still be copied and stopped.
    const active = fakeSharing({status: {token: TOKEN, includeMap: true, includeNotation: false}});
    void openShareDialog({song: GLASS, session: null}, {sharing: active, feedback: fakeFeedback(), store, ...ORIGIN});
    await settle();
    expect(q('.share-link-input').value).toBe(`https://woodshed.test/share/${TOKEN}`);
    buttonByText('Stop sharing').click();
    await settle();
    expect(active.revoke).toHaveBeenCalledWith({id: 'glasshouse'});
  });

  it('a song without an id opens nothing', async () => {
    await openShareDialog({song: null}, {sharing: fakeSharing()});
    expect(dialog()).toBeNull();
  });
});

describe('device-local practice', () => {
  it('reads, reports and clears the device copy and the notice flag for one token', () => {
    const store = {practice: memoryStore(), notice: memoryStore()};
    const local = sharedPractice(TOKEN, {store});
    expect(local.read()).toBeNull();
    expect(local.has()).toBe(false);
    store.practice.set(TOKEN, {v: 2, rate: 0.8});
    expect(local.read()).toEqual({v: 2, rate: 0.8});
    expect(local.has()).toBe(true);
    local.markNotice();
    expect(local.noticeShown()).toBe(true);
    local.clear();
    expect(local.has()).toBe(false);
    expect(local.noticeShown()).toBe(false);
  });

  it('defaults to the namespace practice-state.js writes (ws.share.<token>)', () => {
    deviceStore('share').set(NEXT, {v: 2, rate: 0.7});
    expect(sharedPractice(NEXT).read()).toEqual({v: 2, rate: 0.7});
    sharedPractice(NEXT).clear();
    expect(deviceStore('share').get(NEXT)).toBeNull();
  });

  it('the one-time notice: on the first change the viewer makes, once per token and device', () => {
    const store = {practice: memoryStore(), notice: memoryStore()};
    const value = signal({v: 2, rate: 1, lastAt: 0, spots: []});
    const session = {practice: {value}};
    const status = vi.fn();
    watchLocalNotice({session, token: TOKEN, status, store});
    value.value = {...value.peek(), lastAt: 12};            // playback moved: not a change of theirs
    expect(status).not.toHaveBeenCalled();
    value.value = {...value.peek(), rate: 0.85};
    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith('Changes stay on this device until you add the song to your library.', {key: 'share-local', durationMs: NOTICE_MS});
    value.value = {...value.peek(), rate: 0.7};
    expect(status).toHaveBeenCalledTimes(1);
    // Another visit on this device: never again for this token.
    const again = vi.fn();
    watchLocalNotice({session: {practice: {value: signal({v: 2, rate: 1})}}, token: TOKEN, status: again, store});
    expect(again).not.toHaveBeenCalled();
  });

  it('migrates the device copy into the saved song through the one-way upgrade, then clears it', async () => {
    const store = {practice: memoryStore(), notice: memoryStore()};
    store.practice.set(TOKEN, {loop: {a: 10, b: 20, on: true}, rate: 0.8, speed: 80});   // a v1-shaped blob
    const songs = {savePractice: vi.fn(async () => null)};
    expect(await migrateSharedPractice({token: TOKEN, songId: 'copy-1', duration: 200, songs, store})).toBe(true);
    const [args] = songs.savePractice.mock.calls[0];
    expect(args.id).toBe('copy-1');
    expect(args.final).toBe(true);
    expect(args.practice.v).toBe(2);
    expect(store.practice.get(TOKEN)).toBeNull();
  });

  it('writes nothing without a device copy, and keeps the copy when the save fails', async () => {
    const store = {practice: memoryStore(), notice: memoryStore()};
    const songs = {savePractice: vi.fn(async () => { throw new Error('offline'); })};
    expect(await migrateSharedPractice({token: TOKEN, songId: 'copy-1', songs, store})).toBe(false);
    expect(songs.savePractice).not.toHaveBeenCalled();
    store.practice.set(TOKEN, {v: 2, rate: 0.9});
    await expect(migrateSharedPractice({token: TOKEN, songId: 'copy-1', songs, store})).rejects.toThrow('offline');
    expect(store.practice.get(TOKEN)).toEqual({v: 2, rate: 0.9});
  });
});

describe('the demo', () => {
  beforeEach(() => resetDemoToken());

  it('demoToken asks settings.demo once per page and keeps a valid token', async () => {
    const settings = {demo: vi.fn(async () => ({token: TOKEN}))};
    expect(await demoToken({settings})).toBe(TOKEN);
    expect(await demoToken({settings})).toBe(TOKEN);
    expect(settings.demo).toHaveBeenCalledTimes(1);
  });

  it('a failed lookup is asked again; a malformed token is null', async () => {
    const settings = {demo: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({token: 'nope'})};
    await expect(demoToken({settings})).rejects.toThrow('offline');
    expect(await demoToken({settings})).toBeNull();
    expect(settings.demo).toHaveBeenCalledTimes(2);
  });

  it('openDemo leaves for /share/<token> through location.assign', async () => {
    const location = {assign: vi.fn()};
    expect(await openDemo(null, {settings: {demo: async () => ({token: TOKEN})}, location, feedback: fakeFeedback()})).toBe(true);
    expect(location.assign).toHaveBeenCalledWith(`/share/${TOKEN}`);
  });

  it('with no demo configured it says so and stays', async () => {
    const location = {assign: vi.fn()};
    const feedback = fakeFeedback();
    expect(await openDemo(null, {settings: {demo: async () => null}, location, feedback})).toBe(false);
    expect(location.assign).not.toHaveBeenCalled();
    expect(feedback.toast).toHaveBeenCalledWith(COPY.demoMissing, {key: 'demo-missing'});
  });
});
