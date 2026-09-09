// @vitest-environment node
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {Window} from 'happy-dom';
import {expect, test, vi} from 'vitest';
const source = readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8');
function boot({dark = false, saved, blocked = false} = {}) {
  const window = new Window({url:'https://woodshed.test'});
  const document = window.document;
  document.head.innerHTML = '<meta name="theme-color">';
  document.body.innerHTML = '<select data-theme-choice><option>system</option><option>light</option><option>dark</option></select>';
  if (saved) window.localStorage.setItem('ws.theme', saved);
  const media = new window.EventTarget(); media.matches = dark;
  window.matchMedia = () => media;
  window.woodshedDesktop = {setTheme:vi.fn(async () => {})};
  const storage = blocked ? {getItem(){throw Error('Blocked');},setItem(){throw Error('Blocked');}} : window.localStorage;
  vm.runInNewContext(source, {window, document, localStorage:storage, CustomEvent:window.CustomEvent});
  const os = dark => { media.matches = dark; media.dispatchEvent(new window.Event('change')); };
  return {window,document,os,appearance:window.woodshedAppearance};
}
test('first paint follows system and tracks live system changes', () => {
  const {document,os,appearance} = boot({dark:true});
  expect(appearance.preference).toBe('system');
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(document.documentElement.style.colorScheme).toBe('dark');
  os(false); expect(document.documentElement.dataset.theme).toBe('light');
});
test('saved override wins, updates native appearance, and System rejoins OS changes', () => {
  const {document,window,os,appearance} = boot({dark:true,saved:'light'});
  expect(document.documentElement.dataset.theme).toBe('light');
  os(false);os(true);expect(document.documentElement.dataset.theme).toBe('light');
  appearance.set('system');expect(document.documentElement.dataset.theme).toBe('dark');
  expect(window.woodshedDesktop.setTheme).toHaveBeenLastCalledWith('system');
  expect(window.localStorage.getItem('ws.theme')).toBe('system');
  expect(document.querySelector('select').value).toBe('system');
});
test('dynamically rendered controls work and preferences synchronize across tabs', () => {
  const {document,window} = boot();
  const select=document.querySelector('select'); select.value='dark';
  select.dispatchEvent(new window.Event('change',{bubbles:true}));
  expect(document.documentElement.dataset.theme).toBe('dark');
  window.localStorage.setItem('ws.theme','light');
  window.dispatchEvent(new window.StorageEvent('storage',{key:'ws.theme'}));
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(select.value).toBe('light');
});
test('invalid or unavailable storage still permits a working session preference', () => {
  expect(boot({saved:'invalid',dark:true}).document.documentElement.dataset.theme).toBe('dark');
  const {appearance,document} = boot({blocked:true});
  appearance.set('dark');expect(document.documentElement.dataset.theme).toBe('dark');
});
