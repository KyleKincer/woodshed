// @vitest-environment happy-dom
// S1: src/js/startup.js, the boot status (#startup) and its 8 s "Still connecting… [Retry]".
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import * as startup from '../src/js/startup.js';
import {SLOW_MS, STARTUP_COPY, finishStartup, showSignIn, showStartup} from '../src/js/startup.js';

const root = document.documentElement;
const status = () => document.getElementById('startup');

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div><div id="startup" role="status">Opening Woodshed…</div>';
  root.dataset.startup = 'loading';
  vi.useFakeTimers();
});
afterEach(() => {
  finishStartup();
  vi.useRealTimers();
});

describe('the boot status', () => {
  test('shows "Opening Woodshed…" as a polite status while loading', () => {
    showStartup({onRetry: vi.fn()});
    expect(root.dataset.startup).toBe('loading');
    expect(status().getAttribute('role')).toBe('status');
    expect(status().textContent).toBe(STARTUP_COPY.opening);
    expect(status().querySelector('button')).toBeNull();
  });

  test('after 8 s it reads "Still connecting…" with a Retry button', () => {
    const onRetry = vi.fn();
    showStartup({onRetry});
    vi.advanceTimersByTime(SLOW_MS - 1);
    expect(status().dataset.slow).toBe('false');
    vi.advanceTimersByTime(1);
    expect(SLOW_MS).toBe(8000);
    expect(status().dataset.slow).toBe('true');
    expect(status().textContent).toContain(STARTUP_COPY.slow);
    const retry = status().querySelector('button');
    expect(retry.textContent).toBe(STARTUP_COPY.retry);
    retry.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('showing it again restarts the 8 s window', () => {
    showStartup({onRetry: vi.fn()});
    vi.advanceTimersByTime(6000);
    showStartup({onRetry: vi.fn()});
    vi.advanceTimersByTime(6000);
    expect(status().dataset.slow).toBe('false');
    vi.advanceTimersByTime(2000);
    expect(status().dataset.slow).toBe('true');
  });

  test('creates the status when index.html had none', () => {
    document.body.replaceChildren();
    showStartup({onRetry: vi.fn()});
    expect(status().parentNode).toBe(document.body);
    expect(status().getAttribute('role')).toBe('status');
  });

  test('finishStartup removes it, marks the page ready and cancels the slow notice', () => {
    showStartup({onRetry: vi.fn()});
    finishStartup();
    expect(root.dataset.startup).toBe('ready');
    expect(status()).toBeNull();
    vi.advanceTimersByTime(SLOW_MS);
    expect(status()).toBeNull();
  });

  test('showSignIn removes it and marks the page signin', () => {
    showStartup({onRetry: vi.fn()});
    showSignIn();
    expect(root.dataset.startup).toBe('signin');
    expect(status()).toBeNull();
  });
});

// I1-6: the 1.9 auth bridge (waitForAuthSession) left with src/js/auth.js; the module is the boot status only.
test('exports only the boot status API', () => {
  expect(Object.keys(startup).sort()).toEqual(['SLOW_MS', 'STARTUP_COPY', 'finishStartup', 'showSignIn', 'showStartup']);
});
