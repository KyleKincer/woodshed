// @vitest-environment happy-dom
// src/app/feedback.js: the toast queue (held while playing, FIFO, per-toast durationMs, error persistence, keys), the
// Stage status-line bus and its toast fallback, confirm()/form() on the Dialog primitive, and the announce throttle,
// all on fake timers and the fake clock.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import * as clock from '../src/app/clock.js';
import {
  LIVE_SETTLE_MS, announce, attachStatusLine, cancelAnnounce, confirm, dismissStatus, feedback, form, resetFeedback, status, statusLine, toast, toastDuration,
  toastState, TOAST_MS, STATUS_MS,
} from '../src/app/feedback.js';
import {store} from '../src/app/store.js';
import {Dialog} from '../src/ui/dialog.js';
import {installPopoverShim, keydown, pointer, restoreDomShims, tap} from './helpers/dom.js';

const region = () => document.querySelector('.ui-toast-region');
const visible = () => [...document.querySelectorAll('.ui-toast-region .ui-toast')];
const visibleText = () => visible().map(t => t.querySelector('.ui-toast-message').textContent);
const flush = () => new Promise(resolve => queueMicrotask(resolve));

beforeEach(() => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
  vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
  clock.set();
  installPopoverShim();
  store.stage.value = null;
});

afterEach(() => {
  resetFeedback();
  store.stage.value = null;
  for (const d of document.querySelectorAll('dialog')) d.__uiClose?.();
  vi.useRealTimers();
  clock.reset();
  restoreDomShims();
  document.body.replaceChildren();
});

describe('toast', () => {
  test('one toast in the bottom-centre region; info dismisses itself at 5000 ms', () => {
    toast('Saved');
    expect(region()).not.toBeNull();
    expect(region().getAttribute('aria-label')).toBe('Notifications');
    expect(region().classList.contains('app-toasts')).toBe(true);
    expect(visibleText()).toEqual(['Saved']);
    expect(visible()[0].getAttribute('role')).toBe('status');
    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(visibleText()).toEqual(['Saved']);
    vi.advanceTimersByTime(1);
    expect(visible()).toEqual([]);
  });

  test('ok and warn dismiss themselves; errors persist (role=alert) until dismissed', () => {
    toast('Done', {tone: 'ok'});
    vi.advanceTimersByTime(TOAST_MS);
    toast('Careful', {tone: 'warn'});
    vi.advanceTimersByTime(TOAST_MS);
    expect(visible()).toEqual([]);
    const err = toast('Couldn’t save', {tone: 'error'});
    vi.advanceTimersByTime(10 * 60_000);
    expect(visibleText()).toEqual(['Couldn’t save']);
    expect(visible()[0].getAttribute('role')).toBe('alert');
    err.dismiss();
    expect(visible()).toEqual([]);
  });

  test('per-toast durationMs, including Infinity and on an error', () => {
    toast('Short', {durationMs: 1200});
    vi.advanceTimersByTime(1199);
    expect(visibleText()).toEqual(['Short']);
    vi.advanceTimersByTime(1);
    expect(visible()).toEqual([]);
    toast('Error that clears', {tone: 'error', durationMs: 3000});
    vi.advanceTimersByTime(3000);
    expect(visible()).toEqual([]);
    const sticky = toast('Sticky', {durationMs: Infinity});
    vi.advanceTimersByTime(60_000);
    expect(visibleText()).toEqual(['Sticky']);
    sticky.dismiss();
    expect(toastDuration('info')).toBe(TOAST_MS);
    expect(toastDuration('error')).toBe(null);
    expect(() => toast('Bad', {durationMs: -1})).toThrow(RangeError);
    expect(() => toast('Bad', {tone: 'loud'})).toThrow(RangeError);
  });

  test('FIFO queue: one visible at a time; dismissing a queued one removes it', () => {
    toast('First');
    const second = toast('Second');
    toast('Third');
    expect(visibleText()).toEqual(['First']);
    expect(toastState().queued.map(e => e.message)).toEqual(['Second', 'Third']);
    second.dismiss();
    vi.advanceTimersByTime(TOAST_MS);
    expect(visibleText()).toEqual(['Third']);
    tap(visible()[0].querySelector('.ui-toast-close'));
    expect(visible()).toEqual([]);
    expect(toastState()).toMatchObject({visible: null, queued: []});
  });

  test('a key replaces the visible toast in place and restarts its timer', () => {
    const a = toast('Uploading 10%', {key: 'up'});
    vi.advanceTimersByTime(4000);
    const b = toast('Uploading 60%', {key: 'up'});
    expect(b).toBe(a);
    expect(visible()).toHaveLength(1);
    expect(visibleText()).toEqual(['Uploading 60%']);
    vi.advanceTimersByTime(4000);
    expect(visibleText()).toEqual(['Uploading 60%']);
    vi.advanceTimersByTime(1000);
    expect(visible()).toEqual([]);
  });

  test('a key replaces a queued toast in place, keeping its position', () => {
    toast('Visible');
    toast('Pins full', {key: 'pins'});
    toast('Later');
    toast('Up to 12 pins', {key: 'pins', tone: 'warn'});
    expect(toastState().queued.map(e => [e.message, e.tone])).toEqual([['Up to 12 pins', 'warn'], ['Later', 'info']]);
  });

  test('update(message) changes a visible or queued toast', () => {
    const a = toast('Adding Harbor Lights');
    const b = toast('Waiting');
    a.update('Added Harbor Lights');
    b.update('Still waiting');
    expect(visibleText()).toEqual(['Added Harbor Lights']);
    expect(toastState().queued[0].message).toBe('Still waiting');
  });

  test('an action runs and dismisses the toast; toasts never take focus', () => {
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    const run = vi.fn();
    toast('Adding Harbor Lights', {action: {label: 'Undo', run}, durationMs: 10_000});
    expect(document.activeElement).toBe(button);
    const action = visible()[0].querySelector('.ui-toast-action');
    expect(action.textContent).toBe('Undo');
    tap(action);
    expect(run).toHaveBeenCalledOnce();
    expect(visible()).toEqual([]);
    expect(() => toast('x', {action: {run}})).toThrow(TypeError);
  });

  test('hovering or focusing a toast pauses its timer; leaving resumes the remaining time', () => {
    toast('Hover me');
    vi.advanceTimersByTime(3000);
    const el = visible()[0];
    pointer(el, 'pointerenter');
    vi.advanceTimersByTime(60_000);
    expect(visibleText()).toEqual(['Hover me']);
    pointer(el, 'pointerleave');
    vi.advanceTimersByTime(1999);
    expect(visibleText()).toEqual(['Hover me']);
    vi.advanceTimersByTime(1);
    expect(visible()).toEqual([]);

    toast('Focus me', {action: {label: 'Undo', run() {}}});
    const action = visible()[0].querySelector('.ui-toast-action');
    action.dispatchEvent(new window.FocusEvent('focusin', {bubbles: true}));
    vi.advanceTimersByTime(60_000);
    expect(visibleText()).toEqual(['Focus me']);
    action.dispatchEvent(new window.FocusEvent('focusout', {bubbles: true, relatedTarget: document.body}));
    vi.advanceTimersByTime(TOAST_MS);
    expect(visible()).toEqual([]);
  });

  test('held while store.stage.playing: new toasts queue, nothing shows, and they release in order on stop', () => {
    store.stage.value = {songId: 'gh', layout: 'band', surface: 'chart', playing: true, focus: false};
    toast('Harbor Lights is ready', {action: {label: 'Practice', run() {}}});
    toast('Second');
    expect(visible()).toEqual([]);
    expect(toastState().held).toBe(true);
    vi.advanceTimersByTime(60_000);                    // no timer runs while held
    expect(toastState().queued).toHaveLength(2);
    store.stage.value = {...store.stage.value, playing: false};
    expect(visibleText()).toEqual(['Harbor Lights is ready']);
    vi.advanceTimersByTime(TOAST_MS);
    expect(visibleText()).toEqual(['Second']);
  });

  test('a toast showing when playback starts goes back to the front of the queue with a fresh timer', () => {
    toast('Shown');
    toast('Queued');
    vi.advanceTimersByTime(4500);
    store.stage.value = {songId: 'gh', playing: true};
    expect(visible()).toEqual([]);
    expect(toastState().queued.map(e => e.message)).toEqual(['Shown', 'Queued']);
    toast('During play');
    store.stage.value = {songId: 'gh', playing: false};
    expect(visibleText()).toEqual(['Shown']);
    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(visibleText()).toEqual(['Shown']);
    vi.advanceTimersByTime(1);
    expect(visibleText()).toEqual(['Queued']);
    vi.advanceTimersByTime(TOAST_MS);
    expect(visibleText()).toEqual(['During play']);
  });

  test('leaving the Stage (store.stage → null) releases held toasts', () => {
    store.stage.value = {songId: 'gh', playing: true};
    toast('Held');
    store.stage.value = null;
    expect(visibleText()).toEqual(['Held']);
  });

  test('the region follows an open modal dialog (followLayerHost) so its buttons stay usable', () => {
    toast('Deleted 3 songs', {action: {label: 'Undo', run() {}}, durationMs: Infinity});
    expect(region().parentElement).toBe(document.body);
    const d = Dialog({title: 'Edit details', body: 'Body'});
    expect(region().parentElement).toBe(d.el);
    d.close();
    expect(region().parentElement).toBe(document.body);
  });
});

describe('status', () => {
  test('outside the Stage it falls back to a toast (the toast default duration unless given)', () => {
    status('Played 4 times');
    expect(visibleText()).toEqual(['Played 4 times']);
    vi.advanceTimersByTime(STATUS_MS);
    expect(visibleText()).toEqual(['Played 4 times']);
    vi.advanceTimersByTime(TOAST_MS - STATUS_MS);
    expect(visible()).toEqual([]);
    const run = vi.fn();
    status('Bars found', {action: {label: 'Undo', run}, durationMs: 8000, key: 'bars'});
    expect(toastState().visible).toMatchObject({message: 'Bars found', key: 'bars', action: 'Undo', durationMs: 8000});
  });

  test('with the Stage status line attached it sets statusLine and clears after 2500 ms', () => {
    const off = attachStatusLine();
    status('Played 4 times');
    expect(visible()).toEqual([]);
    expect(statusLine.value).toMatchObject({text: 'Played 4 times', tone: 'info', durationMs: STATUS_MS, action: null, key: null});
    vi.advanceTimersByTime(STATUS_MS - 1);
    expect(statusLine.value?.text).toBe('Played 4 times');
    vi.advanceTimersByTime(1);
    expect(statusLine.value).toBe(null);
    off();
  });

  test('the latest line wins; durationMs, keys, dismissStatus and off', () => {
    const off = attachStatusLine();
    const run = vi.fn();
    status('Turn 3 markers into sections', {action: {label: 'Turn into sections', run}, durationMs: 8000, key: 'markers'});
    vi.advanceTimersByTime(5000);
    status('Speed 85%');
    expect(statusLine.value.text).toBe('Speed 85%');
    vi.advanceTimersByTime(STATUS_MS);
    expect(statusLine.value).toBe(null);
    status('Waiting', {durationMs: Infinity, key: 'w'});
    vi.advanceTimersByTime(60_000);
    expect(statusLine.value.text).toBe('Waiting');
    dismissStatus('other');
    expect(statusLine.value.text).toBe('Waiting');
    dismissStatus('w');
    expect(statusLine.value).toBe(null);
    status('Paused — audio was interrupted. Press Play to continue.', {durationMs: Infinity});
    off();
    expect(statusLine.value).toBe(null);
    off();                                             // idempotent
    status('After');
    expect(visibleText()).toEqual(['After']);
  });

  test('feedback bundles the API for ctx.feedback', () => {
    expect(Object.keys(feedback).sort()).toEqual(
      ['announce', 'attachStatusLine', 'cancelAnnounce', 'confirm', 'dismissStatus', 'form', 'status', 'statusLine', 'toast'].sort());
  });
});

describe('confirm and form', () => {
  test('confirm resolves true for the confirm action and false for Cancel and Esc', async () => {
    const p = confirm({title: 'Delete Harbor Lights?', body: 'This removes its stems.', confirmLabel: 'Delete'});
    const dialog = document.querySelector('dialog.ui-dialog');
    expect(dialog.querySelector('.ui-dialog-title').textContent).toBe('Delete Harbor Lights?');
    const [cancel, ok] = dialog.querySelectorAll('.ui-dialog-action');
    expect([cancel.textContent, ok.textContent, ok.dataset.variant]).toEqual(['Cancel', 'Delete', 'primary']);
    expect(document.activeElement).toBe(ok);
    tap(ok);
    await expect(p).resolves.toBe(true);

    const q = confirm({title: 'Stop sharing?'});
    tap(document.querySelector('dialog.ui-dialog .ui-dialog-action'));
    await expect(q).resolves.toBe(false);

    const r = confirm({title: 'Leave?', cancelLabel: 'Stay'});
    keydown({key: 'Escape', code: 'Escape'}, {target: document.querySelector('dialog.ui-dialog')});
    await expect(r).resolves.toBe(false);
    expect(() => confirm({})).toThrow(TypeError);
  });

  test('a danger confirm styles only the confirm action and starts on Cancel', async () => {
    const p = confirm({title: 'Delete 3 songs?', confirmLabel: 'Delete', danger: true});
    const dialog = document.querySelector('dialog.ui-dialog');
    const [cancel, del] = dialog.querySelectorAll('.ui-dialog-action');
    expect(del.dataset.variant).toBe('danger');
    expect(cancel.dataset.variant).toBe('secondary');
    expect(document.activeElement).toBe(cancel);
    tap(cancel);
    await expect(p).resolves.toBe(false);
  });

  test('form validates, returns the values, and Cancel returns null', async () => {
    const p = form({title: 'Rename spot', fields: [{name: 'name', label: 'Name', required: true, maxLength: 60, value: ''}], submitLabel: 'Rename'});
    const dialog = document.querySelector('dialog.ui-dialog');
    const formEl = dialog.querySelector('form');
    const [cancel, submit] = dialog.querySelectorAll('.ui-dialog-action');
    expect([cancel.textContent, submit.textContent, submit.type]).toEqual(['Cancel', 'Rename', 'submit']);
    formEl.dispatchEvent(new window.Event('submit', {cancelable: true}));
    expect(dialog.querySelector('.ui-dialog-field-error').textContent).toBe('Name is required.');
    expect(dialog.isConnected).toBe(true);
    dialog.querySelector('input').value = 'Bridge fill';
    formEl.dispatchEvent(new window.Event('submit', {cancelable: true}));
    await expect(p).resolves.toEqual({name: 'Bridge fill'});

    const q = form({title: 'Notes', fields: [{name: 'notes', label: 'Notes', kind: 'textarea'}]});
    tap(document.querySelector('dialog.ui-dialog .ui-dialog-action'));
    await expect(q).resolves.toBe(null);
    expect(() => form({title: 'x', fields: []})).toThrow(TypeError);
  });

  test('form with onSubmit: an async error renders inline at its field and keeps it open; success resolves', async () => {
    const onSubmit = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('That title is too long for the catalogue.'), {field: 'title'}))
      .mockRejectedValueOnce(new Error('Couldn’t save. Check your connection.'))
      .mockResolvedValueOnce(undefined);
    const p = form({title: 'Edit title', fields: [{name: 'title', label: 'Title', value: 'Harbor'}], onSubmit, danger: false});
    const dialog = document.querySelector('dialog.ui-dialog');
    const formEl = dialog.querySelector('form');
    formEl.dispatchEvent(new window.Event('submit', {cancelable: true}));
    await flush(); await flush();
    expect(onSubmit).toHaveBeenCalledWith({title: 'Harbor'});
    expect(dialog.querySelector('.ui-dialog-field-error').textContent).toBe('That title is too long for the catalogue.');
    expect(dialog.isConnected).toBe(true);
    formEl.dispatchEvent(new window.Event('submit', {cancelable: true}));
    await flush(); await flush();
    expect(dialog.querySelector('.ui-dialog-error').textContent).toBe('Couldn’t save. Check your connection.');
    formEl.dispatchEvent(new window.Event('submit', {cancelable: true}));
    await expect(p).resolves.toEqual({title: 'Harbor'});
    expect(dialog.isConnected).toBe(false);
  });
});

describe('announce', () => {
  const polite = () => document.querySelector('[data-live=polite]');
  const assertive = () => document.querySelector('[data-live=assertive]');

  test('speaks into a visually hidden live region as a new node', () => {
    announce('Chorus');
    expect(polite().getAttribute('aria-live')).toBe('polite');
    expect(polite().classList.contains('sr-only')).toBe(true);
    // Both regions are mounted together; the first text waits for the new region to settle.
    expect(assertive()).not.toBe(null);
    expect(polite().textContent).toBe('');
    vi.advanceTimersByTime(LIVE_SETTLE_MS);
    const first = polite().firstChild;
    expect(polite().textContent).toBe('Chorus');
    vi.advanceTimersByTime(2000);
    announce('Chorus');
    expect(polite().firstChild).not.toBe(first);
    announce('Couldn’t reach the processor', {politeness: 'assertive'});
    expect(assertive().getAttribute('aria-live')).toBe('assertive');
    expect(assertive().textContent).toBe('Couldn’t reach the processor');
    expect(() => announce('x', {politeness: 'rude'})).toThrow(RangeError);
  });

  test('the same key within throttleMs waits; the latest text speaks when the window ends', () => {
    announce('Verse', {key: 'section'});
    vi.advanceTimersByTime(LIVE_SETTLE_MS);
    vi.advanceTimersByTime(500 - LIVE_SETTLE_MS);
    announce('Chorus', {key: 'section'});
    announce('Bridge', {key: 'section'});
    expect(polite().textContent).toBe('Verse');
    vi.advanceTimersByTime(1499);
    expect(polite().textContent).toBe('Verse');
    vi.advanceTimersByTime(1);
    expect(polite().textContent).toBe('Bridge');
  });

  test('a repeat of the text last spoken for its key is dropped; other keys are independent; throttleMs 0 never waits', () => {
    announce('Saved');
    vi.advanceTimersByTime(LIVE_SETTLE_MS);
    const node = polite().firstChild;
    vi.advanceTimersByTime(200);
    announce('Saved');
    vi.advanceTimersByTime(5000);
    expect(polite().firstChild).toBe(node);
    announce('Loop on', {key: 'loop'});
    expect(polite().textContent).toBe('Loop on');
    announce('Loop off', {key: 'loop', throttleMs: 0});
    expect(polite().textContent).toBe('Loop off');
  });

  test('announcements made while a modal dialog is open land inside it (not inert)', () => {
    const d = Dialog({title: 'Edit'});
    announce('3 results');
    expect(polite().closest('dialog')).toBe(d.el);
    vi.advanceTimersByTime(LIVE_SETTLE_MS);
    expect(polite().textContent).toBe('3 results');
    d.close();
  });

  test('the regions stay mounted: they move out of a closing dialog, and text after a move waits to settle', () => {
    announce('Ready');
    vi.advanceTimersByTime(LIVE_SETTLE_MS);
    const region = polite();
    expect(region.parentElement.parentElement).toBe(document.body);
    // Settled and unmoved: the next text is written at once.
    announce('Loop on', {key: 'loop'});
    expect(region.textContent).toBe('Loop on');
    const d = Dialog({title: 'Edit'});
    expect(region.closest('dialog')).toBe(d.el);              // moved in when the dialog opened
    announce('Saved', {key: 'save'});
    expect(region.textContent).toBe('Loop on');               // held: the region just moved
    announce('Saved twice', {key: 'save2'});                  // the newest held text wins
    vi.advanceTimersByTime(LIVE_SETTLE_MS);
    expect(region.textContent).toBe('Saved twice');
    d.close();
    expect(region.isConnected).toBe(true);                    // not removed along with the dialog
    expect(polite()).toBe(region);
    expect(region.closest('dialog')).toBe(null);
    announce('Closed', {key: 'closed'});
    expect(region.textContent).toBe('Saved twice');
    vi.advanceTimersByTime(LIVE_SETTLE_MS);
    expect(region.textContent).toBe('Closed');
  });

  test('cancelAnnounce drops text waiting on its throttle or on a settling region', () => {
    announce('1 result', {key: 'count', throttleMs: 800});
    cancelAnnounce('count');                                   // still settling (new region)
    vi.advanceTimersByTime(LIVE_SETTLE_MS);
    expect(polite().textContent).toBe('');
    announce('Other', {key: 'other'});
    vi.advanceTimersByTime(LIVE_SETTLE_MS);
    expect(polite().textContent).toBe('Other');
    announce('2 results', {key: 'count', throttleMs: 800});   // speaks (the key's last text never reached the region)
    expect(polite().textContent).toBe('2 results');
    vi.advanceTimersByTime(100);
    announce('3 results', {key: 'count', throttleMs: 800});   // waits on the throttle
    cancelAnnounce('count');
    vi.advanceTimersByTime(2000);
    expect(polite().textContent).toBe('2 results');
  });
});
