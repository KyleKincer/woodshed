// @vitest-environment happy-dom
// src/ui/{popover,sheet,dialog,toast,status,banner,coachmark}.js: behaviour, roles and names, and how each overlay
// joins the dispatcher's overlay stack (modal or non-modal, D36).
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {createRegistry} from '../src/app/commands.js';
import {openOverlays, startDispatcher} from '../src/app/dispatch.js';
import {store} from '../src/app/store.js';
import {Banner} from '../src/ui/banner.js';
import {CoachMark} from '../src/ui/coachmark.js';
import {Dialog, validateField} from '../src/ui/dialog.js';
import {Menu} from '../src/ui/menu.js';
import {Popover, layerHost} from '../src/ui/popover.js';
import {Sheet, resolveLayout, shouldDismiss, stageLayoutOf} from '../src/ui/sheet.js';
import {InlineStatus} from '../src/ui/status.js';
import {Toast} from '../src/ui/toast.js';
import {installPopoverShim, isPopoverOpen, keydown, pointer, restoreDomShims, setRect, tap} from './helpers/dom.js';

let anchor, handles, stops, reg, ran;

beforeEach(() => {
  installPopoverShim();
  anchor = document.createElement('button');
  anchor.textContent = 'Open';
  document.body.append(anchor);
  anchor.focus();
  handles = [];
  stops = [];
  ran = [];
  reg = createRegistry();
  reg.register({id: 'nav.spots', title: 'Spots', group: 'Practice', keys: ['KeyJ'], scopes: ['global'], run: () => ran.push('spots')});
});

afterEach(() => {
  for (const handle of handles) handle.destroy();
  for (const stop of stops) stop();
  store.stage.value = null;
  vi.useRealTimers();
  restoreDomShims();
  document.body.replaceChildren();
});

const keep = handle => { handles.push(handle); return handle; };
const dispatcher = () => stops.push(startDispatcher({registry: reg}));
const button = label => {
  const b = document.createElement('button');
  b.textContent = label;
  return b;
};

describe('Popover', () => {
  test('opens in the top layer next to its anchor, as a non-modal dialog that takes focus', () => {
    const inner = button('Retry');
    const onClose = vi.fn();
    const pop = keep(Popover({anchor, content: inner, label: 'Jobs', width: 320, placement: 'bottom', onClose, testid: 'jobs'}));
    expect(pop.el.getAttribute('role')).toBe('dialog');
    expect(pop.el.getAttribute('aria-label')).toBe('Jobs');
    expect(pop.el.hasAttribute('aria-modal')).toBe(false);
    expect(pop.el.dataset.testid).toBe('jobs');
    expect(pop.el.style.inlineSize).toBe('320px');
    expect(isPopoverOpen(pop.el)).toBe(true);
    expect(pop.el.dataset.anchor).toBeDefined();
    expect(pop.el.dataset.placement).toBe('bottom');
    expect(document.activeElement).toBe(inner);
    expect(openOverlays().map(o => [o.el, o.modal])).toEqual([[pop.el, false]]);
  });

  test('a non-modal popover lets registry keys through and Esc closes it, returning focus', () => {
    dispatcher();
    const onClose = vi.fn();
    const pop = keep(Popover({anchor, content: button('Retry'), onClose}));
    keydown('KeyJ');
    expect(ran).toEqual(['spots']);
    expect(pop.open).toBe(true);
    keydown('Escape');
    expect(onClose).toHaveBeenCalledWith('escape');
    expect(pop.el.isConnected).toBe(false);
    expect(document.activeElement).toBe(anchor);
    expect(openOverlays()).toHaveLength(0);
  });

  test('a modal popover blocks registry keys and keeps Tab inside', () => {
    dispatcher();
    const a = button('A'), b = button('B');
    const pop = keep(Popover({anchor, content: [a, b], modal: true, label: 'Pick'}));
    expect(pop.el.getAttribute('aria-modal')).toBe('true');
    expect(openOverlays()[0].modal).toBe(true);
    keydown('KeyJ');
    expect(ran).toEqual([]);
    b.focus();
    expect(keydown('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(a);
    keydown('Shift+Tab');
    expect(document.activeElement).toBe(b);
  });

  test('a pointer-down outside closes it; on the anchor or inside it does not', () => {
    const onClose = vi.fn();
    const pop = keep(Popover({anchor, content: 'Hello', onClose}));
    pointer(anchor, 'pointerdown');
    pointer(pop.el, 'pointerdown');
    expect(pop.open).toBe(true);
    pointer(document.body, 'pointerdown');
    expect(onClose).toHaveBeenCalledWith('outside');
  });

  test('set() patches content and props; destroy() closes silently', () => {
    const onClose = vi.fn();
    const pop = Popover({anchor, content: 'One', onClose, autofocus: false});
    expect(document.activeElement).toBe(anchor);
    pop.set({content: 'Two', label: 'Notes', className: 'notes-card'});
    expect(pop.el.textContent).toBe('Two');
    expect(pop.el.classList.contains('notes-card')).toBe(true);
    pop.set({modal: true});
    expect(openOverlays()[0].modal).toBe(true);
    pop.destroy();
    expect(onClose).not.toHaveBeenCalled();
    expect(openOverlays()).toHaveLength(0);
  });

  test('without the Popover API it uses the fallback layer; it needs an anchor', () => {
    restoreDomShims();
    const pop = keep(Popover({anchor, content: 'Hi'}));
    expect(pop.el.hasAttribute('popover')).toBe(false);
    expect(pop.el.dataset.layer).toBe('popover');
    expect(pop.el.hasAttribute('data-layer-fallback')).toBe(true);
    expect(() => Popover({content: 'x'})).toThrow(TypeError);
  });
});

describe('Sheet', () => {
  test.each([
    // dy, h, v → dismiss
    [101, 400, 0, true],       // more than a quarter of the height
    [100, 400, 0, false],      // exactly a quarter is not more
    [40, 400, 0.6, true],      // a fast flick
    [40, 400, 0.5, false],     // 0.5 px/ms is not faster than the threshold
    [10, 400, 0.51, true],
    [0, 400, 2, false],        // no movement
    [-200, 400, 2, false],     // an upward drag never dismisses
    [300, 1000, 0.1, true],
    [200, 1000, 0.1, false],
  ])('shouldDismiss({dy: %d, h: %d, v: %d}) is %s', (dy, h, v, expected) => {
    expect(shouldDismiss({dy, h, v})).toBe(expected);
  });

  test('auto layout follows data-stage-layout: rail → popover left of the anchor, band → bottom', () => {
    const stage = document.createElement('div');
    stage.dataset.stageLayout = 'rail';
    const control = button('Speed');
    stage.append(control);
    document.body.append(stage);
    expect(stageLayoutOf(control)).toBe('rail');
    expect(resolveLayout('auto', control)).toBe('popover');
    expect(resolveLayout('auto', null)).toBe('bottom');
    expect(resolveLayout('bottom', control)).toBe('bottom');
    expect(resolveLayout('popover', null)).toBe('bottom');
    expect(() => resolveLayout('side', control)).toThrow(RangeError);
    stage.dataset.stageLayout = 'band';
    expect(resolveLayout('auto', control)).toBe('bottom');
    stage.remove();
    expect(resolveLayout('auto', control)).toBe('bottom');

    stage.dataset.stageLayout = 'rail';
    document.body.append(stage);
    const sheet = keep(Sheet({title: 'Speed', anchor: control, content: 'x'}));
    expect(sheet.presentation).toBe('popover');
    expect(sheet.el.dataset.presentation).toBe('popover');
    expect(sheet.el.dataset.placement).toBe('left');
    expect(sheet.el.style.inlineSize).toBe('360px');
    expect(sheet.el.querySelector('.ui-sheet-grabber').hidden).toBe(true);
  });

  test('a bottom sheet: labelled dialog, 44 px ✕ named Close, grabber, detents, non-modal overlay', () => {
    const content = button('75%');
    const sheet = keep(Sheet({title: 'Speed', content}));
    const el = sheet.el;
    expect(sheet.presentation).toBe('bottom');
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('aria-labelledby')).toBe(el.querySelector('.ui-sheet-title').id);
    expect(el.querySelector('.ui-sheet-title').textContent).toBe('Speed');
    expect(el.querySelector('.ui-sheet-close').getAttribute('aria-label')).toBe('Close');
    expect(el.querySelector('.ui-sheet-grabber').hidden).toBe(false);
    expect(el.querySelector('.ui-sheet-body').contains(content)).toBe(true);
    expect(el.querySelector('.ui-sheet-body').hasAttribute('data-scroller')).toBe(true);
    expect(isPopoverOpen(el)).toBe(true);
    expect(el.dataset.layer).toBe('sheet');
    expect(openOverlays().map(o => o.modal)).toEqual([false]);
    expect(sheet.detent).toBe(60);
    expect(el.style.getPropertyValue('--ui-sheet-detent')).toBe('60');
    sheet.setDetent(88);
    expect(sheet.detent).toBe(90);
    expect(document.activeElement).toBe(el);
  });

  test('an untitled sheet is named by label; grabber can be turned off', () => {
    const sheet = keep(Sheet({label: 'Mix', grabber: false, content: 'x'}));
    expect(sheet.el.getAttribute('aria-label')).toBe('Mix');
    expect(sheet.el.querySelector('.ui-sheet-title').hidden).toBe(true);
    expect(sheet.el.querySelector('.ui-sheet-grabber').hidden).toBe(true);
  });

  test('✕, Esc (dispatcher rule 8) and a tap outside close it; it never touches history', () => {
    dispatcher();
    const push = vi.spyOn(history, 'pushState');
    const replace = vi.spyOn(history, 'replaceState');
    const length = history.length;
    const onClose = vi.fn();
    let sheet = Sheet({title: 'Mix', content: 'x', onClose});
    keydown('KeyJ');
    expect(ran).toEqual(['spots']);          // non-modal: registry keys pass
    tap(sheet.el.querySelector('.ui-sheet-close'));
    expect(onClose).toHaveBeenLastCalledWith('close');
    expect(document.activeElement).toBe(anchor);
    sheet = Sheet({title: 'Mix', content: 'x', onClose});
    keydown('Escape');
    expect(onClose).toHaveBeenLastCalledWith('escape');
    sheet = Sheet({title: 'Mix', content: 'x', onClose});
    pointer(document.body, 'pointerdown');
    expect(onClose).toHaveBeenLastCalledWith('outside');
    expect(sheet.open).toBe(false);
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(history.length).toBe(length);
    expect(openOverlays()).toHaveLength(0);
  });

  test('a modal sheet is a <dialog> on the modal overlay stack; cancel closes it', () => {
    dispatcher();
    const onClose = vi.fn();
    const sheet = Sheet({title: 'Add a song', content: button('Paste'), modal: true, onClose});
    expect(sheet.el.tagName).toBe('DIALOG');
    expect(sheet.el.open).toBe(true);
    expect(sheet.el.getAttribute('aria-modal')).toBe('true');
    expect(openOverlays().map(o => o.modal)).toEqual([true]);
    expect(layerHost(document)).toBe(sheet.el);
    keydown('KeyJ');
    expect(ran).toEqual([]);
    const cancel = new window.Event('cancel', {cancelable: true});
    sheet.el.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledWith('escape');
    expect(layerHost(document)).toBe(document.body);
  });

  describe('swipe and detents', () => {
    const drag = (sheet, points, msPerStep) => {
      const head = sheet.el.querySelector('.ui-sheet-head');
      const [first, ...rest] = points;
      pointer(head, 'pointerdown', {pointerType: 'touch', y: first});
      for (const y of rest.slice(0, -1)) { vi.advanceTimersByTime(msPerStep); pointer(head, 'pointermove', {pointerType: 'touch', y}); }
      vi.advanceTimersByTime(msPerStep);
      pointer(head, 'pointerup', {pointerType: 'touch', y: rest[rest.length - 1]});
    };
    const open = () => {
      const onClose = vi.fn();
      const sheet = keep(Sheet({title: 'Loop', content: 'x', onClose}));
      setRect(sheet.el, {x: 0, y: 400, width: 820, height: 400});
      return {sheet, onClose};
    };

    test('a slow drag past a quarter of the height dismisses', () => {
      vi.useFakeTimers();
      const {sheet, onClose} = open();
      drag(sheet, [100, 150, 200, 250], 400);
      expect(onClose).toHaveBeenCalledWith('swipe');
    });

    test('a quick short flick dismisses', () => {
      vi.useFakeTimers();
      const {onClose, sheet} = open();
      drag(sheet, [100, 115, 130, 140], 10);
      expect(onClose).toHaveBeenCalledWith('swipe');
    });

    test('a slow short drag moves down one detent; dragging up moves up one; the sheet follows the finger', () => {
      vi.useFakeTimers();
      const {sheet, onClose} = open();
      const head = sheet.el.querySelector('.ui-sheet-head');
      pointer(head, 'pointerdown', {pointerType: 'touch', y: 100});
      vi.advanceTimersByTime(300);
      pointer(head, 'pointermove', {pointerType: 'touch', y: 130});
      expect(sheet.el.style.getPropertyValue('translate')).toBe('0 30px');
      expect(sheet.el.hasAttribute('data-dragging')).toBe(true);
      vi.advanceTimersByTime(300);
      pointer(head, 'pointerup', {pointerType: 'touch', y: 160});
      expect(onClose).not.toHaveBeenCalled();
      expect(sheet.detent).toBe(40);
      expect(sheet.el.style.getPropertyValue('translate')).toBe('');
      drag(sheet, [300, 270, 240, 220], 300);
      expect(sheet.detent).toBe(60);
      drag(sheet, [300, 250, 200, 180], 300);
      expect(sheet.detent).toBe(90);
      drag(sheet, [300, 250, 200, 180], 300);
      expect(sheet.detent).toBe(90);
      expect(onClose).not.toHaveBeenCalled();
    });

    test('the ✕ is not a drag handle', () => {
      vi.useFakeTimers();
      const {sheet, onClose} = open();
      const close = sheet.el.querySelector('.ui-sheet-close');
      pointer(close, 'pointerdown', {pointerType: 'touch', y: 100});
      pointer(close, 'pointerup', {pointerType: 'touch', y: 300});
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});

describe('Dialog', () => {
  test('a native modal dialog: labelled, described, focus on the primary action, returns focus', async () => {
    dispatcher();
    const onClose = vi.fn();
    const d = Dialog({title: 'Delete 3 songs?', body: 'Their stems are removed too.', danger: true, onClose,
      actions: [{label: 'Cancel', value: false}, {label: 'Delete', value: true, variant: 'danger', submit: true}]});
    expect(d.el.tagName).toBe('DIALOG');
    expect(d.el.open).toBe(true);
    expect(document.getElementById(d.el.getAttribute('aria-labelledby')).textContent).toBe('Delete 3 songs?');
    expect(document.getElementById(d.el.getAttribute('aria-describedby')).textContent).toBe('Their stems are removed too.');
    expect(d.el.dataset.tone).toBe('danger');
    expect(document.activeElement.textContent).toBe('Cancel');         // danger: focus starts on the safe action
    expect(openOverlays().map(o => o.modal)).toEqual([true]);
    keydown('KeyJ');
    expect(ran).toEqual([]);
    const [cancel, del] = d.el.querySelectorAll('.ui-dialog-action');
    expect(cancel.dataset.variant).toBe('secondary');
    expect(del.dataset.variant).toBe('danger');
    tap(del);
    del.closest('form').dispatchEvent(new window.Event('submit', {cancelable: true}));
    await expect(d.closed).resolves.toBe(true);
    expect(onClose).toHaveBeenCalledWith(true);
    expect(d.el.isConnected).toBe(false);
    expect(document.activeElement).toBe(anchor);
    expect(openOverlays()).toHaveLength(0);
  });

  test('an action click closes with its value; Esc closes with null; cancel closes with null', async () => {
    dispatcher();
    let d = Dialog({title: 'Notice', actions: [{label: 'Later', value: 'later'}, {label: 'Restart', value: 'restart', variant: 'primary'}]});
    expect(document.activeElement.textContent).toBe('Restart');
    tap(d.el.querySelector('.ui-dialog-action'));
    await expect(d.closed).resolves.toBe('later');
    d = Dialog({title: 'Notice'});
    expect(d.el.querySelector('.ui-dialog-action').textContent).toBe('OK');
    keydown('Escape');
    await expect(d.closed).resolves.toBe(null);
    d = Dialog({title: 'Notice'});
    d.el.dispatchEvent(new window.Event('cancel', {cancelable: true}));
    await expect(d.closed).resolves.toBe(null);
  });

  test('opening a dialog closes open menus', () => {
    const onClose = vi.fn();
    const menu = Menu({anchor, items: [{label: 'Delete'}], onClose});
    keep(Dialog({title: 'Delete?'}));
    expect(menu.open).toBe(false);
    expect(onClose).toHaveBeenCalledWith('dialog');
  });

  test('overlays opened from a dialog are placed inside it (not inert)', () => {
    const d = keep(Dialog({title: 'Pick'}));
    const inner = button('More');
    d.el.querySelector('.ui-dialog-body').append(inner);
    const pop = keep(Popover({anchor: inner, content: 'x'}));
    expect(d.el.contains(pop.el)).toBe(true);
  });

  describe('forms', () => {
    const fields = [
      {name: 'title', label: 'Title', kind: 'text', required: true, value: 'Harbor Lights', maxLength: 120},
      {name: 'reason', label: 'Reason', kind: 'textarea', required: true, minLength: 5, hint: 'Shown in the audit log.'},
    ];

    test('fields are labelled; validation shows errors under the field and blocks submit', () => {
      const onSubmit = vi.fn();
      const d = keep(Dialog({title: 'Suspend account', form: {fields, onSubmit}}));
      const [title, reason] = d.el.querySelectorAll('.ui-dialog-input');
      expect(document.activeElement).toBe(title);
      expect(d.el.querySelector(`label[for="${title.id}"]`).textContent).toBe('Title');
      expect(reason.tagName).toBe('TEXTAREA');
      expect(document.getElementById(reason.getAttribute('aria-describedby')).textContent).toBe('Shown in the audit log.');
      expect(title.maxLength).toBe(120);
      const [cancel, save] = d.el.querySelectorAll('.ui-dialog-action');
      expect([cancel.textContent, save.textContent, save.type]).toEqual(['Cancel', 'Save', 'submit']);
      d.el.querySelector('form').dispatchEvent(new window.Event('submit', {cancelable: true}));
      expect(onSubmit).not.toHaveBeenCalled();
      expect(reason.getAttribute('aria-invalid')).toBe('true');
      const error = d.el.querySelectorAll('.ui-dialog-field-error')[1];
      expect(error.hidden).toBe(false);
      expect(error.textContent).toBe('Reason is required.');
      expect(reason.getAttribute('aria-describedby').split(' ')).toContain(error.id);
      expect(document.activeElement).toBe(reason);
      reason.value = 'abc';
      reason.dispatchEvent(new window.Event('input'));
      expect(error.hidden).toBe(true);
      d.el.querySelector('form').dispatchEvent(new window.Event('submit', {cancelable: true}));
      expect(error.textContent).toBe('Reason needs at least 5 characters.');
    });

    test('async submit: busy, an error stays inline and keeps it open, then success closes with the values', async () => {
      dispatcher();
      let attempt = 0;
      let release;
      const onSubmit = vi.fn(() => new Promise((resolve, reject) => {
        attempt++;
        release = attempt === 1 ? () => reject(new Error('The server said no.')) : resolve;
      }));
      const d = Dialog({title: 'Rename', form: {fields: [{name: 'title', label: 'Title', required: true, value: 'Old'}], onSubmit}});
      const form = d.el.querySelector('form');
      const error = d.el.querySelector('.ui-dialog-error');
      form.dispatchEvent(new window.Event('submit', {cancelable: true}));
      expect(onSubmit).toHaveBeenCalledWith({title: 'Old'});
      expect(form.getAttribute('aria-busy')).toBe('true');
      expect([...d.el.querySelectorAll('.ui-dialog-action')].every(b => b.getAttribute('aria-disabled') === 'true')).toBe(true);
      keydown('Escape');                                    // ignored while busy
      tap(d.el.querySelector('.ui-dialog-action'));          // Cancel is inert while busy
      expect(d.open).toBe(true);
      release();
      await vi.waitFor(() => expect(error.hidden).toBe(false));
      expect(error.textContent).toBe('The server said no.');
      expect(error.getAttribute('role')).toBe('alert');
      expect(d.open).toBe(true);
      expect(form.getAttribute('aria-busy')).toBe('false');
      d.el.querySelector('input').value = 'New';
      form.dispatchEvent(new window.Event('submit', {cancelable: true}));
      expect(error.hidden).toBe(true);
      release();
      await expect(d.closed).resolves.toEqual({title: 'New'});
    });

    test('an error with a field is shown at that field', async () => {
      const onSubmit = vi.fn(async () => { throw Object.assign(new Error('Title is already used.'), {field: 'title'}); });
      const d = keep(Dialog({title: 'Rename', form: {fields: [{name: 'title', label: 'Title', value: 'x'}], onSubmit}}));
      d.el.querySelector('form').dispatchEvent(new window.Event('submit', {cancelable: true}));
      const fieldError = d.el.querySelector('.ui-dialog-field-error');
      await vi.waitFor(() => expect(fieldError.hidden).toBe(false));
      expect(fieldError.textContent).toBe('Title is already used.');
      expect(d.el.querySelector('.ui-dialog-error').hidden).toBe(true);
    });

    test('a form without onSubmit closes with its values; destroy resolves null silently', async () => {
      const onClose = vi.fn();
      const d = Dialog({title: 'Name', form: {fields: [{name: 'name', label: 'Name', value: 'Chorus'}]}, onClose});
      d.el.querySelector('form').dispatchEvent(new window.Event('submit', {cancelable: true}));
      await expect(d.closed).resolves.toEqual({name: 'Chorus'});
      const e = Dialog({title: 'x', onClose});
      e.destroy();
      await expect(e.closed).resolves.toBe(null);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('validateField copy', () => {
      expect(validateField({label: 'Name', required: true}, '  ')).toBe('Name is required.');
      expect(validateField({label: 'Name', maxLength: 3}, 'abcd')).toBe('Name can be at most 3 characters.');
      expect(validateField({label: 'Name', minLength: 3}, '')).toBeNull();
      expect(validateField({label: 'Name'}, 'ok')).toBeNull();
    });
  });
});

describe('Toast', () => {
  test.each([['info', 'status'], ['ok', 'status'], ['warn', 'status'], ['error', 'alert']])('%s → role=%s', (tone, role) => {
    const t = Toast({message: 'Saved', tone});
    expect(t.el.getAttribute('role')).toBe(role);
    expect(t.el.dataset.tone).toBe(tone);
  });

  test('message nodes, an action and ✕; it never takes focus', () => {
    const run = vi.fn();
    const onDismiss = vi.fn();
    const title = document.createElement('strong');
    title.textContent = 'Harbor Lights';
    const t = Toast({message: [title, ' is ready'], action: {label: 'Practice', run}, onDismiss});
    document.body.append(t.el);
    expect(document.activeElement).toBe(anchor);
    expect(t.el.querySelector('.ui-toast-message').textContent).toBe('Harbor Lights is ready');
    const [action, close] = t.el.querySelectorAll('button');
    expect(action.textContent).toBe('Practice');
    expect(close.getAttribute('aria-label')).toBe('Dismiss');
    tap(action);
    expect(run).toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledWith('action');
    tap(close);
    expect(onDismiss).toHaveBeenLastCalledWith('close');
    t.set({message: 'Undid: speed 85% → 100%', action: null, tone: 'ok'});
    expect(t.el.textContent).toContain('Undid: speed 85% → 100%');
    expect(action.hidden).toBe(true);
    expect(() => Toast({message: 'x', tone: 'loud'})).toThrow(RangeError);
    t.destroy();
    expect(t.el.isConnected).toBe(false);
  });
});

describe('InlineStatus and Banner', () => {
  test('InlineStatus: role follows tone, text and action', () => {
    const run = vi.fn();
    const s = InlineStatus({tone: 'ok', text: 'Saved'});
    expect(s.el.getAttribute('role')).toBe('status');
    expect(s.el.textContent).toBe('Saved');
    expect(s.el.querySelector('button').hidden).toBe(true);
    s.set({tone: 'error', text: 'Could not save.', action: {label: 'Retry', run}});
    expect(s.el.getAttribute('role')).toBe('alert');
    expect(s.el.dataset.tone).toBe('error');
    tap(s.el.querySelector('button'));
    expect(run).toHaveBeenCalled();
  });

  test('Banner: in flow (not an overlay), title, text, actions and dismiss', () => {
    const run = vi.fn();
    const onDismiss = vi.fn();
    const b = Banner({tone: 'warn', title: 'Offline', text: "You're offline. Songs you've opened recently can still play.",
      actions: [{label: 'Retry', run, variant: 'primary'}], dismissible: true, onDismiss});
    expect(b.el.isConnected).toBe(false);
    expect(b.el.hasAttribute('popover')).toBe(false);
    expect(openOverlays()).toHaveLength(0);
    expect(b.el.getAttribute('role')).toBe('status');
    expect(b.el.querySelector('.ui-banner-title').textContent).toBe('Offline');
    const [retry, dismiss] = b.el.querySelectorAll('button');
    expect(retry.dataset.variant).toBe('primary');
    tap(retry);
    expect(run).toHaveBeenCalled();
    expect(dismiss.getAttribute('aria-label')).toBe('Dismiss');
    tap(dismiss);
    expect(onDismiss).toHaveBeenCalled();
    const node = button('Ready-made');
    b.set({dismissible: false, actions: [node], title: null, tone: 'error'});
    expect(dismiss.hidden).toBe(true);
    expect(b.el.querySelector('.ui-banner-actions').firstChild).toBe(node);
    expect(b.el.querySelector('.ui-banner-title').hidden).toBe(true);
    expect(b.el.getAttribute('role')).toBe('alert');
  });
});

describe('CoachMark', () => {
  test('anchored, non-blocking (no focus, no overlay), "1 of 3 · Skip"', () => {
    const onSkip = vi.fn();
    const strong = document.createElement('strong');
    strong.textContent = 'Space';
    const c = keep(CoachMark({anchor, title: 'Play', body: [strong, ' or ▶ plays from your loop.'], step: {i: 1, n: 3}, onSkip}));
    expect(c.shown).toBe(true);
    expect(isPopoverOpen(c.el)).toBe(true);
    expect(c.el.dataset.layer).toBe('coachmark');
    expect(document.activeElement).toBe(anchor);
    expect(openOverlays()).toHaveLength(0);
    expect(c.el.querySelector('.ui-coachmark-step').textContent).toBe('1 of 3');
    expect(c.el.querySelector('.ui-coachmark-body').textContent).toBe('Space or ▶ plays from your loop.');
    tap(c.el.querySelector('.ui-coachmark-skip'));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(c.open).toBe(false);
    expect(c.el.isConnected).toBe(false);
  });

  test('never shown while playing; done() ends it', () => {
    store.stage.value = {songId: 's1', playing: true};
    const onDone = vi.fn();
    const c = keep(CoachMark({anchor, title: 'Mix', body: 'Drums OUT takes your part out of the mix.', step: {i: 3, n: 3}, onDone}));
    expect(c.shown).toBe(false);
    expect(c.el.isConnected).toBe(false);
    store.stage.value = {songId: 's1', playing: false};
    expect(c.shown).toBe(true);
    store.stage.value = {songId: 's1', playing: true};
    expect(c.shown).toBe(false);
    store.stage.value = {songId: 's1', playing: false};
    c.done();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(c.shown).toBe(false);
    store.stage.value = {songId: 's1', playing: true};
    store.stage.value = {songId: 's1', playing: false};
    expect(c.shown).toBe(false);
  });

  test('a single mark has no step text; without onSkip there is no Skip', () => {
    const c = keep(CoachMark({anchor, body: 'No bar grid yet, so times are in seconds.', step: {i: 1, n: 1}, playing: () => false}));
    expect(c.el.querySelector('.ui-coachmark-step').hidden).toBe(true);
    expect(c.el.querySelector('.ui-coachmark-skip').hidden).toBe(true);
    expect(c.el.querySelector('.ui-coachmark-foot').hidden).toBe(true);
  });
});

describe('modality table (D36)', () => {
  test.each([
    ['Popover', () => Popover({anchor, content: 'x'}), false],
    ['Popover modal', () => Popover({anchor, content: 'x', modal: true}), true],
    ['Sheet', () => Sheet({title: 'Speed', content: 'x'}), false],
    ['Sheet modal', () => Sheet({title: 'Add', content: 'x', modal: true}), true],
    ['Menu', () => Menu({anchor, items: [{label: 'x'}]}), true],
    ['Dialog', () => Dialog({title: 'x'}), true],
  ])('%s pushes modal=%s and pops on close', (_, make, modal) => {
    const handle = make();
    expect(openOverlays().map(o => o.modal)).toEqual([modal]);
    expect(openOverlays()[0].el).toBe(handle.el.closest('dialog, [data-layer]') ?? handle.el);
    handle.destroy();
    expect(openOverlays()).toHaveLength(0);
  });
});
