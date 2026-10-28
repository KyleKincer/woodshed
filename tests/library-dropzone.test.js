// @vitest-environment happy-dom
// LB2a: the Library's window drop (architecture §2.16, spec §3.1): a file drag over the Library place shows the
// full-window target "Drop to add N files"; a drop stages the files and opens /add; nothing uploads. Elsewhere a
// stray file drop is swallowed so the app never navigates to the file. Behaviour, roles and names only.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

vi.mock('../src/app/feedback.js', () => ({announce: vi.fn(), cancelAnnounce: vi.fn()}));
import {signal} from '../src/app/store.js';
import {openOverlays} from '../src/app/dispatch.js';
import * as feedback from '../src/app/feedback.js';
import {installPopoverShim, isPopoverOpen, restoreDomShims} from './helpers/dom.js';
import {COPY, DRAG_IDLE_MS, stageFiles, startLibraryDrop, takeStagedFiles} from '../src/library/dropzone.js';

const ROUTES = {
  library: {name: 'library', route: {place: 'library'}},
  setlist: {name: 'setlist', route: {place: 'library'}},
  add: {name: 'add', route: {place: 'library', modalOver: 'library'}},
  welcome: {name: 'welcome', route: {place: 'library'}},
  stage: {name: 'stage', route: {place: 'stage'}},
  settings: {name: 'settings', route: {place: 'settings'}},
};

const file = name => new File(['x'], name, {type: name.endsWith('.pdf') ? 'application/pdf' : 'audio/mpeg'});

/** A DataTransfer-like object: `files` only on drop, `items` as the browser reports them during the drag. */
function transfer({files = [], types = ['Files'], items} = {}) {
  return {
    types,
    items: items ?? files.map(f => ({kind: 'file', type: f.type})),
    files,
    dropEffect: 'none',
  };
}

function drag(type, dt, target = window, extra = {}) {
  const e = new Event(type, {bubbles: true, cancelable: true});
  Object.defineProperty(e, 'dataTransfer', {value: dt});
  for (const [k, v] of Object.entries(extra)) Object.defineProperty(e, k, {value: v});
  target.dispatchEvent(e);
  return e;
}

const target = () => document.querySelector('.lib-drop');
const isShown = () => !!target() && isPopoverOpen(target());

let router, off;
beforeEach(() => {
  installPopoverShim();
  feedback.announce.mockClear();
  feedback.cancelAnnounce.mockClear();
  router = {current: signal(ROUTES.library), navigate: vi.fn()};
  off = startLibraryDrop({router});
  takeStagedFiles();
});

afterEach(() => {
  off?.();
  vi.useRealTimers();
  restoreDomShims();
  document.body.replaceChildren();
  delete document.documentElement.dataset.place;
});

describe('on the Library', () => {
  test('a file drag shows the full-window target with the file count', () => {
    const dt = transfer({files: [file('a.mp3'), file('b.wav'), file('notes.pdf')]});
    const enter = drag('dragenter', dt);
    expect(enter.defaultPrevented).toBe(true);
    expect(isShown()).toBe(true);
    const el = target();
    expect(el.getAttribute('popover')).toBe('manual');            // the top layer, no focus taken, nothing inert
    expect(el.textContent).toBe('Drop to add 3 files');
    expect(feedback.announce).toHaveBeenCalledWith('Drop to add 3 files', {key: 'library-drop'});
    expect(el.dataset.testid).toBe('library-drop');

    const over = drag('dragover', dt);
    expect(over.defaultPrevented).toBe(true);
    expect(dt.dropEffect).toBe('copy');
  });

  test.each([
    [1, 'Drop to add 1 file'],
    [2, 'Drop to add 2 files'],
    [null, 'Drop to add files'],
  ])('copy for %s files', (n, text) => {
    expect(COPY.dropTarget(n)).toBe(text);
  });

  test('a browser that hides the count until the drop (Safari) reads "Drop to add files"', () => {
    drag('dragenter', transfer({items: []}));
    expect(target().textContent).toBe('Drop to add files');
  });

  test('the drop stages every file and opens /add; nothing else happens', () => {
    const files = [file('a.mp3'), file('notes.pdf')];
    drag('dragenter', transfer({files}));
    const drop = drag('drop', transfer({files}));
    expect(drop.defaultPrevented).toBe(true);
    expect(isShown()).toBe(false);
    expect(router.navigate).toHaveBeenCalledWith('/add');
    expect(takeStagedFiles()).toEqual(files);
    expect(takeStagedFiles()).toEqual([]);          // taken once
  });

  test('a drop with no files only hides the target', () => {
    drag('dragenter', transfer({items: []}));
    drag('drop', transfer({files: []}));
    expect(isShown()).toBe(false);
    expect(router.navigate).not.toHaveBeenCalled();
  });

  test('a setlist page is the Library place too', () => {
    router.current.value = ROUTES.setlist;
    drag('dragenter', transfer({files: [file('a.mp3')]}));
    expect(isShown()).toBe(true);
  });

  test('only file drags count: text or a link dragged inside the page is left alone', () => {
    const dt = transfer({types: ['text/plain', 'text/uri-list'], items: [{kind: 'string', type: 'text/plain'}]});
    const enter = drag('dragenter', dt);
    const over = drag('dragover', dt);
    const drop = drag('drop', dt);
    expect([enter.defaultPrevented, over.defaultPrevented, drop.defaultPrevented]).toEqual([false, false, false]);
    expect(isShown()).toBe(false);
    expect(router.navigate).not.toHaveBeenCalled();
  });

  test('moving across elements keeps the target; leaving the window hides it', () => {
    const dt = transfer({files: [file('a.mp3')]});
    const card = document.body.appendChild(document.createElement('div'));
    drag('dragenter', dt, card);
    const el = target();
    drag('dragenter', dt, el);                     // the target appears under the pointer: enter it, then leave the card
    drag('dragleave', dt, card);
    expect(isShown()).toBe(true);
    const title = el.querySelector('.ui-dialog-title');
    drag('dragenter', dt, title);
    drag('dragleave', dt, el);
    expect(isShown()).toBe(true);
    drag('dragleave', dt, title);                  // out of the window
    expect(isShown()).toBe(false);
  });

  test('a drag that ends without a dragleave (Esc in the OS) hides after the idle time', () => {
    vi.useFakeTimers();
    const dt = transfer({files: [file('a.mp3')]});
    drag('dragenter', dt);
    vi.advanceTimersByTime(DRAG_IDLE_MS - 50);
    drag('dragover', dt);                          // still hovering
    vi.advanceTimersByTime(DRAG_IDLE_MS - 50);
    expect(isShown()).toBe(true);
    vi.advanceTimersByTime(100);
    expect(isShown()).toBe(false);
  });

  test('dragend hides it too', () => {
    drag('dragenter', transfer({files: [file('a.mp3')]}));
    drag('dragend', transfer({files: []}));
    expect(isShown()).toBe(false);
  });

  test('it is a non-modal overlay while shown: Esc closes it', () => {
    drag('dragenter', transfer({files: [file('a.mp3')]}));
    const entry = openOverlays().find(o => o.el === target());
    expect(entry).toMatchObject({modal: false});
    entry.onEscape();
    expect(isShown()).toBe(false);
    expect(target()).toBeNull();
    expect(feedback.cancelAnnounce).toHaveBeenCalledWith('library-drop');   // a pending announcement is dropped
    expect(openOverlays().some(o => o.el?.classList?.contains('lib-drop'))).toBe(false);
  });

  test('focus stays where it was', () => {
    const field = document.body.appendChild(document.createElement('input'));
    field.focus();
    drag('dragenter', transfer({files: [file('a.mp3')]}));
    expect(document.activeElement).toBe(field);
    drag('drop', transfer({files: [file('a.mp3')]}));
    expect(document.activeElement).toBe(field);
  });

  test('a drop an element handled itself is left to it', () => {
    const zone = document.body.appendChild(document.createElement('div'));
    zone.addEventListener('drop', e => e.preventDefault());
    zone.addEventListener('dragover', e => e.preventDefault());
    const dt = transfer({files: [file('a.mp3')]});
    drag('dragenter', dt, zone);
    const over = drag('dragover', dt, zone);
    expect(over.defaultPrevented).toBe(true);
    expect(dt.dropEffect).toBe('none');            // the element's choice is not overwritten
    drag('drop', transfer({files: [file('a.mp3')]}), zone);
    expect(router.navigate).not.toHaveBeenCalled();
    expect(takeStagedFiles()).toEqual([]);
    expect(isShown()).toBe(false);
  });

  test('no target while another modal dialog is open (a confirm, a menu sheet)', () => {
    const other = document.body.appendChild(document.createElement('dialog'));
    other.setAttribute('open', '');
    drag('dragenter', transfer({files: [file('a.mp3')]}));
    const drop = drag('drop', transfer({files: [file('a.mp3')]}));
    expect(isShown()).toBe(false);
    expect(drop.defaultPrevented).toBe(true);      // still never opens the file
    expect(router.navigate).not.toHaveBeenCalled();
  });
});

describe('elsewhere', () => {
  test.each(['add', 'welcome', 'stage', 'settings'])('%s: no target; a stray drop is swallowed with the no-drop cursor', name => {
    router.current.value = ROUTES[name];
    const dt = transfer({files: [file('a.mp3')]});
    drag('dragenter', dt);
    expect(isShown()).toBe(false);
    const over = drag('dragover', dt);
    expect(over.defaultPrevented).toBe(true);
    expect(dt.dropEffect).toBe('none');
    const drop = drag('drop', transfer({files: [file('a.mp3')]}));
    expect(drop.defaultPrevented).toBe(true);
    expect(router.navigate).not.toHaveBeenCalled();
    expect(takeStagedFiles()).toEqual([]);
  });

  test('navigating away mid-drag hides the target on the next drag event', () => {
    const dt = transfer({files: [file('a.mp3')]});
    drag('dragenter', dt);
    expect(isShown()).toBe(true);
    router.current.value = ROUTES.stage;
    drag('dragenter', dt);
    expect(isShown()).toBe(false);

    router.current.value = ROUTES.library;
    drag('dragenter', dt);
    router.current.value = ROUTES.stage;
    const over = drag('dragover', dt);
    expect(isShown()).toBe(false);
    expect(over.defaultPrevented).toBe(true);
    expect(dt.dropEffect).toBe('none');
  });
});

describe('the module', () => {
  test('without a router it reads html[data-place]', () => {
    off();
    off = startLibraryDrop({});
    document.documentElement.dataset.place = 'stage';
    drag('dragenter', transfer({files: [file('a.mp3')]}));
    expect(isShown()).toBe(false);
    document.documentElement.dataset.place = 'library';
    drag('dragenter', transfer({files: [file('a.mp3')]}));
    expect(isShown()).toBe(true);
  });

  test('off() removes every listener and the target; a second start replaces the first', () => {
    drag('dragenter', transfer({files: [file('a.mp3')]}));
    off();
    expect(target()).toBeNull();
    drag('dragenter', transfer({files: [file('a.mp3')]}));
    expect(isShown()).toBe(false);

    const first = startLibraryDrop({router});
    off = startLibraryDrop({router});
    drag('dragenter', transfer({files: [file('a.mp3')]}));
    expect(document.querySelectorAll('.lib-drop')).toHaveLength(1);
    first();                                         // already replaced: a no-op for the running one
    expect(isShown()).toBe(true);
  });

  test('stageFiles replaces what was staged and drops empty slots', () => {
    const a = file('a.mp3'), b = file('b.mp3');
    stageFiles([a, null, b]);
    stageFiles([b]);
    expect(takeStagedFiles()).toEqual([b]);
    stageFiles(null);
    expect(takeStagedFiles()).toEqual([]);
  });
});
