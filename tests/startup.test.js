// @vitest-environment happy-dom
// S1: src/js/startup.js, the boot status (#startup) and its 8 s "Still connecting… [Retry]".
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {SLOW_MS, STARTUP_COPY, finishStartup, showSignIn, showStartup, waitForAuthSession} from '../src/js/startup.js';

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

// The 1.9 client (src/js/auth.js) waits on its auth state through this until I1 deletes it.
describe('waitForAuthSession', () => {
  function session(initial) {
    let state = initial, listener;
    const unsubscribe = vi.fn();
    return {getSnapshot: () => state, subscribe: cb => { listener = cb; return unsubscribe; }, unsubscribe,
      update: next => { state = next; listener(); }};
  }

  test('a restoring session never reports signed out; it resolves once authenticated', async () => {
    const auth = session({isLoading: true, isAuthenticated: false});
    const onSignedOut = vi.fn(), onLoading = vi.fn();
    const ready = waitForAuthSession(auth, {onSignedOut, onLoading});
    auth.update({isLoading: false, isAuthenticated: true});
    await ready;
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(onLoading).toHaveBeenCalled();
    expect(auth.unsubscribe).toHaveBeenCalled();
  });

  test('a settled signed-out state reports it; an OAuth return goes back to loading', async () => {
    const auth = session({isLoading: false, isAuthenticated: false});
    const onSignedOut = vi.fn(), onLoading = vi.fn();
    const ready = waitForAuthSession(auth, {onSignedOut, onLoading});
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    auth.update({isLoading: true, isAuthenticated: false});
    expect(onLoading).toHaveBeenCalledTimes(1);
    auth.update({isLoading: false, isAuthenticated: true});
    await ready;
  });

  test('an already authenticated session resolves at once', async () => {
    const onSignedOut = vi.fn();
    await waitForAuthSession(session({isLoading: false, isAuthenticated: true}), {onSignedOut, onLoading: vi.fn()});
    expect(onSignedOut).not.toHaveBeenCalled();
  });
});
