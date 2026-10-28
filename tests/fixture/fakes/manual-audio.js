// fx-audio=manual (architecture §11.2): AudioContext's clock stands still until
// a test moves it, so captures and flows are deterministic.
//   window.fixture.advance(ms)  steps audio time and the page clock together in 25 ms steps.
//                               With Playwright's page.clock installed it runs the fake timers
//                               for each step; otherwise each step waits 25 ms of real time.
//   window.fixture.audio:       time() (s), set(seconds), step(seconds), contexts() (count)
// Rule: never call page.clock.install() without fx-audio=manual; real-time audio with a frozen
// clock breaks wraps, stopAt and end detection. The runner enforces it (lib/runner.cjs).
export const STEP_MS = 25;

export function installManualAudio(win) {
  const Native = win.AudioContext || win.webkitAudioContext;
  let time = 0, count = 0;
  if (typeof Native !== 'function') {
    win.console.error('[fixture] fx-audio=manual: this browser has no AudioContext');
    return null;
  }
  class ManualAudioContext extends Native {
    constructor(...args) { super(...args); count++; }
    get currentTime() { return time; }
    getOutputTimestamp() { return {contextTime: time, performanceTime: win.performance.now()}; }
  }
  Object.defineProperty(ManualAudioContext, 'name', {value: Native.name});
  win.AudioContext = ManualAudioContext;
  if (win.webkitAudioContext) win.webkitAudioContext = ManualAudioContext;

  const audio = {
    time: () => time,
    set(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError(`fixture.audio.set: a time ≥ 0, got ${seconds}`);
      time = seconds;
    },
    step(seconds) { audio.set(time + seconds); },
    contexts: () => count,
  };

  async function advance(ms) {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`fixture.advance: milliseconds ≥ 0, got ${ms}`);
    let left = ms;
    while (left > 0) {
      const step = Math.min(STEP_MS, left);
      audio.step(step / 1000);
      const clock = win.__pwClock?.controller;
      if (clock?.runFor) await clock.runFor(step);
      else await new Promise(resolve => setTimeout(resolve, step));
      left -= step;
    }
    return time;
  }
  return {audio, advance};
}
