// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://127.0.0.1:5190/__harness/fixture-smoke?fx-desktop=1&fx-platform=win&fx-nofeature=midi&theme=dark"}
// The preamble and the harness host in a DOM: window.fixture gets the
// database API and the fakes (minus removed features), and the host mounts
// the fixture's own harness and marks the page ready (architecture §11.2).
import {describe, it, expect, vi} from 'vitest';

describe('preamble.js', () => {
  it('installs window.fixture: db, fakes, desktop bridge and the switches', async () => {
    await import('../preamble.js');
    const fixture = window.fixture;
    expect(fixture.fx).toMatchObject({desktop: '1', platform: 'win', nofeature: 'midi'});
    expect(fixture.db().songs).toHaveLength(12);
    expect(fixture.platform).toBe('win');
    expect(navigator.platform).toBe('Win32');
    expect(fixture.removed).toEqual(['midi']);
    expect(fixture.midi).toBeUndefined();
    expect('requestMIDIAccess' in navigator).toBe(false);
    for (const key of ['wakeLock', 'media', 'install', 'share', 'clipboard', 'companion', 'upload', 'desktop']) expect(fixture[key], key).toBeTruthy();
    expect(typeof window.woodshedDesktop.registerMenu).toBe('function');
    expect(Math.abs(fixture.now() - Date.now())).toBeLessThan(1000);
    await expect(fixture.advance(25)).rejects.toThrow('fixture.advance needs ?fx-audio=manual');
  });
  it('installFixture reports a bad fx-audio value', async () => {
    const {installFixture} = await import('../preamble.js');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    installFixture(window, {audio: 'real'});
    expect(error).toHaveBeenCalledWith('[fixture] fx-audio must be "manual", got "real"');
    error.mockRestore();
  });
});

describe('harness/host.js', () => {
  it('mounts the named harness with {fixture, query, h} and sets data-view-ready', async () => {
    document.body.innerHTML = '<main id="harness" data-scroller></main>';
    const {fallbackH} = await import('../harness/host.js');
    await vi.waitFor(() => expect(document.documentElement.dataset.viewReady).toBe('fixture-smoke'), {timeout: 5000});
    expect(document.documentElement.dataset.harnessError).toBeUndefined();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.querySelector('#harness h1').textContent).toBe('Fixture');
    expect(document.querySelectorAll('#harness section')).toHaveLength(4);
    expect(window.__harness).toMatchObject({name: 'fixture-smoke', file: '/tests/fixture/harness/fixture-smoke.harness.js'});
    window.__harness.mounted.unmount();
    expect(document.querySelector('#harness').children).toHaveLength(0);

    const click = vi.fn();
    const el = fallbackH('button', {class: ['a', null, 'b'], type: 'button', disabled: false, hidden: true, 'aria-label': 'Go', onClick: click, dataset: {focusKey: 'x'}, style: {width: '10px'}}, 'Go ', ['now', null, false]);
    expect(el.outerHTML).toBe('<button class="a b" type="button" hidden="" aria-label="Go" data-focus-key="x" style="width: 10px;">Go now</button>');
    el.click();
    expect(click).toHaveBeenCalledOnce();
  });
});
