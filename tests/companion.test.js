// @vitest-environment node
import { beforeEach, expect, test, vi } from 'vitest';
const { mutation, setup } = vi.hoisted(() => ({mutation: vi.fn(), setup: vi.fn()}));
vi.mock('../src/js/auth.js', () => ({convex: {mutation}}));
vi.mock('../src/js/desktop.js', () => ({showDesktopSetup: setup}));
const token = 'a'.repeat(64);
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubGlobal('sessionStorage', {removeItem: vi.fn(), getItem: () => token});
  vi.stubGlobal('window', {});
  vi.stubGlobal('fetch', vi.fn(async () => ({ok:true, json:async () => ({name:'Computer',connected:true,deviceId:'device'})})));
  mutation.mockResolvedValue('device');
});
test('browser cannot use a stale stored credential for local access', async () => {
  const local = await import('../src/js/companion.js');
  await expect(local.localRequest('/export-originals', {})).rejects.toThrow('Open Woodshed for desktop');
  expect(fetch).not.toHaveBeenCalled();
  expect(local.isDesktopApp()).toBe(false);
});
test('desktop registers the device with the signed-in account before local actions', async () => {
  window.woodshedDesktop = {info:async () => ({companion:{port:12345,token}})};
  const local = await import('../src/js/companion.js');
  await local.initializeLocalDesktop();
  expect(mutation).toHaveBeenCalledWith(expect.anything(), {tokenHash:expect.stringMatching(/^[a-f0-9]{64}$/),name:'Computer'});
  await expect(local.requireCompanion()).resolves.toBe('device');
  expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:12345/status', expect.objectContaining({headers:expect.objectContaining({authorization:`Bearer ${token}`})}));
});
test('account registration failure blocks local export and import', async () => {
  window.woodshedDesktop = {info:async () => ({companion:{port:12345,token}})};
  mutation.mockRejectedValue(new Error('This device belongs to another account'));
  const local = await import('../src/js/companion.js');
  await expect(local.initializeLocalDesktop()).rejects.toThrow('another account');
  await expect(local.localRequest('/export-originals', {})).rejects.toThrow('not connected');
  await expect(local.importLegacy('/old')).rejects.toThrow('not connected');
  expect(fetch).toHaveBeenCalledTimes(1);
});
