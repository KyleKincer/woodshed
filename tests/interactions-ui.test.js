// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { initializeInteractions } from '../src/js/interactions.js';
import { notify, withButtonProgress } from '../src/js/feedback.js';
initializeInteractions();
beforeEach(() => { document.body.innerHTML = '<button id="action">Action</button><input id="entry"><details><summary>Advanced</summary></details>'; });
test('pointer clicks release action focus but keyboard activation and text entry retain it', () => {
  const button = document.getElementById('action');
  button.focus();
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  expect(document.activeElement).not.toBe(button);
  button.focus();
  button.click();
  expect(document.activeElement).toBe(button);
  const input = document.getElementById('entry');
  input.focus();
  input.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  expect(document.activeElement).toBe(input);
});
test('pointer activation preserves focus moved by a dialog-opening handler', () => {
  const button = document.getElementById('action');
  const input = document.getElementById('entry');
  button.onclick = () => input.focus();
  button.focus();
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  expect(document.activeElement).toBe(input);
});
test('progress restores controls on failure and displays dismissible literal error text', async () => {
  const button = document.getElementById('action');
  await withButtonProgress(button, 'Working…', async () => {
    expect(button.disabled).toBe(true);
    throw new Error('<b>Failed</b>');
  });
  expect(button.disabled).toBe(false);
  expect(button.textContent).toBe('Action');
  const notice = document.querySelector('[role="alert"]');
  expect(notice.textContent).toContain('<b>Failed</b>');
  expect(notice.querySelector('b')).toBeNull();
  notice.querySelector('button').click();
  expect(notice.isConnected).toBe(false);
});
test('success feedback expires without removing a newer error', () => {
  vi.useFakeTimers();
  notify('Done');
  notify('An error', { error: true });
  vi.advanceTimersByTime(6000);
  expect(document.querySelector('[role="alert"]').textContent).toContain('An error');
  vi.useRealTimers();
});
