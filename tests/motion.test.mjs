import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transitionView } from '../src/js/motion.js';

test('navigation commits immediately without support or with reduced motion', () => {
  let calls = 0;
  globalThis.document = {};
  globalThis.matchMedia = () => ({ matches: false });
  transitionView(() => calls++);
  document.startViewTransition = () => assert.fail('must not capture reduced motion');
  globalThis.matchMedia = () => ({ matches: true });
  transitionView(() => calls++);
  assert.equal(calls, 2);
});

test('rapid navigation discards stale commits even when skipping still runs the callback', async () => {
  const captures = [];
  const commits = [];
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.document = { startViewTransition(update) {
    let finish;
    const transition = {
      update, skipped: false, ready: Promise.resolve(),
      finished: new Promise(resolve => { finish = resolve; }),
      skipTransition() { this.skipped = true; },
      finish: () => finish(),
    };
    captures.push(transition);
    return transition;
  } };
  transitionView(() => commits.push('song'));
  transitionView(() => commits.push('library'));
  captures[0].update();
  captures[1].update();
  assert.equal(captures[0].skipped, true);
  assert.deepEqual(commits, ['library']);
  captures.forEach(capture => capture.finish());
  await Promise.resolve();
});

test('switching to reduced motion also invalidates a pending animated navigation', () => {
  let pending;
  let skipped = false;
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.document = { startViewTransition(update) {
    pending = update;
    return { ready: Promise.resolve(), finished: Promise.resolve(), skipTransition() { skipped = true; } };
  } };
  const commits = [];
  transitionView(() => commits.push('song'));
  globalThis.matchMedia = () => ({ matches: true });
  transitionView(() => commits.push('settings'));
  pending();
  assert.equal(skipped, true);
  assert.deepEqual(commits, ['settings']);
});

test('a delayed layout render cannot cancel a pending navigation', () => {
  let pending;
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.document = { startViewTransition(update) {
    pending = update;
    return { ready: Promise.resolve(), finished: Promise.resolve(), skipTransition() { assert.fail('layout must not skip navigation'); } };
  } };
  const commits = [];
  transitionView(() => commits.push('player'));
  transitionView(() => commits.push('library layout'), { interrupt: false });
  pending();
  assert.deepEqual(commits, ['library layout', 'player']);
});
