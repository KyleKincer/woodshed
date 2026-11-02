// @vitest-environment happy-dom
// src/edit/chart-file.js: the one way into Import a chart. Its path, the file names it takes, the hand-over of
// a dropped file to Find a chart's import, and dragging a file onto the song.
import {afterEach, describe, expect, test, vi} from 'vitest';
import {ACCEPT, bindChartDrop, chartImportPath, handOffFile, isChartFile, onHandedFile, takeHandedFile} from '../src/edit/chart-file.js';

afterEach(() => { takeHandedFile('s1'); takeHandedFile('s2'); document.body.replaceChildren(); });

/** A drag event carrying `files` (happy-dom has no DataTransfer to fill). */
function drag(type, files = []) {
  const event = new Event(type, {bubbles: true, cancelable: true});
  Object.defineProperty(event, 'dataTransfer', {value: {types: files.length || type !== 'drop' ? ['Files'] : [], files, dropEffect: 'none'}});
  return event;
}

describe('chart files', () => {
  test('the import path, and the names Import a file… reads', () => {
    expect(chartImportPath('a b')).toBe('/s/a%20b/edit/map/find?import=1');
    expect(ACCEPT).toContain('.gp');
    for (const name of ['tab.gp', 'TAB.GP5', 'x.gpx', 'song.mid', 'notes.chart', 'beats.txt', 'pack.sng']) expect(isChartFile({name}), name).toBe(true);
    for (const name of ['cover.jpg', 'song.mp3', 'gp', '']) expect(isChartFile({name}), name).toBe(false);
    expect(isChartFile(null)).toBe(false);
  });

  test('a handed-over file is taken once, by its own song, and an open panel hears of it', () => {
    const heard = vi.fn();
    const off = onHandedFile('s1', heard);
    const file = new File(['gp'], 'tab.gp');
    handOffFile('s1', file);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(takeHandedFile('s2')).toBeNull();
    expect(takeHandedFile('s1')).toBe(file);
    expect(takeHandedFile('s1')).toBeNull();
    off();
    handOffFile('s1', file);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('bindChartDrop', () => {
  test('dragging files marks the song; dropping a chart file hands it over and opens the import', () => {
    const el = document.createElement('div');
    document.body.append(el);
    const navigate = vi.fn();
    const off = bindChartDrop(el, {songId: 's1', navigate});
    const enter = drag('dragenter');
    el.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(el.dataset.chartDrop).toBe('');
    const file = new File(['gp'], 'tab.gp');
    const drop = drag('drop', [new File(['x'], 'cover.jpg'), file]);
    el.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(el.dataset.chartDrop).toBeUndefined();
    expect(navigate).toHaveBeenCalledWith('/s/s1/edit/map/find?import=1');
    expect(takeHandedFile('s1')).toBe(file);
    off();
    el.dispatchEvent(drag('dragenter'));
    expect(el.dataset.chartDrop).toBeUndefined();
  });

  test('other files are left to the browser, and a song that can\'t take a chart (shared) takes nothing', () => {
    const el = document.createElement('div');
    const navigate = vi.fn();
    bindChartDrop(el, {songId: 's1', navigate});
    const drop = drag('drop', [new File(['x'], 'cover.jpg')]);
    el.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();

    const shared = document.createElement('div');
    bindChartDrop(shared, {songId: 's2', navigate, canDrop: () => false});
    const over = drag('dragover');
    shared.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);
    expect(shared.dataset.chartDrop).toBeUndefined();
    shared.dispatchEvent(drag('drop', [new File(['gp'], 'tab.gp')]));
    expect(navigate).not.toHaveBeenCalled();
    expect(takeHandedFile('s2')).toBeNull();
  });

  test('leaving the song after entering clears the mark (nested enters count)', () => {
    const el = document.createElement('div');
    bindChartDrop(el, {songId: 's1', navigate: vi.fn()});
    el.dispatchEvent(drag('dragenter'));
    el.dispatchEvent(drag('dragenter'));
    el.dispatchEvent(new Event('dragleave'));
    expect(el.dataset.chartDrop).toBe('');
    el.dispatchEvent(new Event('dragleave'));
    expect(el.dataset.chartDrop).toBeUndefined();
  });
});
