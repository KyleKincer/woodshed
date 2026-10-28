// @vitest-environment happy-dom
import { beforeEach, expect, test } from 'vitest';
import { initializeInteractions, isPointerControl } from '../src/js/interactions.js';
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
test('label activation and completed slider drags release focus, while a select waits for its choice', async () => {
  document.body.insertAdjacentHTML('beforeend','<label id="label"><input id="check" type="checkbox">Accent</label><input id="slider" type="range"><select id="select"><option>A</option><option>B</option></select>');
  const check=document.getElementById('check');
  document.getElementById('label').dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));
  check.focus(); await Promise.resolve();expect(document.activeElement).not.toBe(check);
  const slider=document.getElementById('slider');slider.focus();
  slider.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
  document.body.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));
  await Promise.resolve();expect(document.activeElement).not.toBe(slider);
  const select=document.getElementById('select');select.focus();
  select.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
  expect(isPointerControl(select)).toBe(true);
  expect(document.activeElement).toBe(select);
  select.dispatchEvent(new Event('change',{bubbles:true}));
  expect(document.activeElement).not.toBe(select);
});
