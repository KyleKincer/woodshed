// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
const mock = vi.hoisted(() => ({ update: null, action: vi.fn() }));
vi.mock('../src/js/auth.js', () => ({ convex: {
  onUpdate: (_api, _args, callback) => { mock.update = callback; return () => {}; },
  action: mock.action,
} }));
vi.mock('../src/js/export.js', () => ({ exportLibrary: vi.fn(async () => {}) }));
import { renderBilling } from '../src/js/billing.js';
const state = { access: 'free', usedBytes: 41e6, limitBytes: 250e6, freeBytes: 250e6, proBytes: 5e9, enabled: true, hasCustomer: true };
const el = id => document.getElementById(id);
beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<main id="billing-root"></main>';
  renderBilling();
  mock.update(state);
});
test('starts yearly, switches price and submits selected interval; errors use shared feedback', async () => {
  expect(document.querySelector('[data-interval="year"]').getAttribute('aria-pressed')).toBe('true');
  expect(el('plus-cadence').textContent).toContain('$20 billed yearly');
  if (process.env.UI_SNAPSHOTS) {
    mkdirSync('artifacts', { recursive: true });
    writeFileSync('artifacts/billing.html', `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/css/styles.css"><link rel="stylesheet" href="/src/css/record-club.css"><style>body{display:block;overflow:auto;padding:32px}#billing-root{margin:auto}</style>${document.body.innerHTML}`);
  }
  document.querySelector('[data-interval="month"]').click();
  expect(el('plus-cadence').textContent).toBe('$2 billed monthly.');
  let reject;
  mock.action.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  el('billing-checkout').click();
  expect(mock.action.mock.calls[0][1]).toEqual({ interval: 'month' });
  expect(el('billing-checkout').getAttribute('aria-busy')).toBe('true');
  expect(el('billing-manage').disabled).toBe(true);
  // Reactive usage changes must not replace the busy control or reset frequency.
  mock.update({ ...state, usedBytes: 42e6 });
  expect(el('billing-checkout').textContent).toBe('Opening secure billing…');
  expect(el('billing-notice').textContent).toBe('');
  reject(new Error('Billing unavailable'));
  await vi.waitFor(() => expect(el('billing-checkout').disabled).toBe(false));
  expect(document.querySelector('[role="alert"]').textContent).toContain('Billing unavailable');
  expect(document.querySelector('.billing-usage').textContent).toContain('42 MB');
  expect(document.querySelector('[data-interval="month"]').getAttribute('aria-pressed')).toBe('true');
});
test('paid plans do not offer checkout; unavailable upgrades and grace remain visible', () => {
  mock.update({ ...state, access: 'paid' });
  expect(el('billing-checkout')).toBeNull();
  expect(el('billing-manage')).not.toBeNull();
  mock.update({ ...state, enabled: false });
  expect(el('billing-checkout').disabled).toBe(true);
  expect(el('billing-notice').textContent).toContain('Upgrades are being set up');
  mock.update({ ...state, access: 'grace', graceEndsAt: Date.now() + 86400000 });
  expect(el('billing-notice').textContent).toContain('Export or reduce');
});

test('reopening billing during a request recovers with the latest subscription state', async () => {
  let reject;
  mock.action.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  el('billing-manage').click();
  renderBilling();
  mock.update({ ...state, usedBytes: 99e6 });
  reject(new Error('Try again'));
  await vi.waitFor(() => expect(el('billing-manage')).not.toBeNull());
  expect(document.querySelector('.billing-usage').textContent).toContain('99 MB');
  expect(el('billing-manage').disabled).toBe(false);
});
