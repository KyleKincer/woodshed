const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  createUpdateController,
  CHECK_INTERVAL,
} = require("./update-controller.cjs");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function setup({ busy = false, focused = true, answers = [] } = {}) {
  const updater = new EventEmitter(),
    dialogs = [],
    states = [],
    scheduled = [];
  let checks = 0,
    installs = 0,
    resumes = 0,
    clock = CHECK_INTERVAL;
  updater.checkForUpdates = async () => {
    checks++;
    updater.emit("checking-for-update");
    updater.emit("update-not-available");
  };
  updater.downloadUpdate = async () => {
    updater.emit("download-progress", { percent: 50 });
    updater.emit("update-downloaded", { version: "1.3.1" });
  };
  const controller = createUpdateController({
    updater,
    publish: (s) => states.push(s),
    version: "1.3.0",
    packaged: true,
    showDialog: async (options) => {
      dialogs.push(options);
      return { response: answers.shift() ?? 1 };
    },
    quiesce: async () => ({ busy }),
    resume: () => resumes++,
    install: async () => installs++,
    isFocused: () => focused,
    now: () => clock,
    timers: {
      setTimeout: (fn, ms) => {
        scheduled.push({ fn, ms });
        return {};
      },
      setInterval: (fn, ms) => {
        scheduled.push({ fn, ms });
        return {};
      },
    },
  });
  return {
    controller,
    updater,
    dialogs,
    states,
    scheduled,
    get checks() {
      return checks;
    },
    get installs() {
      return installs;
    },
    get resumes() {
      return resumes;
    },
    focus: () => {
      focused = true;
      return controller.focus();
    },
    advance: (ms) => (clock += ms),
  };
}
test("checks after startup, periodically, and after overdue wake; ready updates stay ready", async () => {
  const h = setup();
  assert.deepEqual(
    h.scheduled.map((x) => x.ms),
    [15000, CHECK_INTERVAL],
  );
  h.scheduled[0].fn();
  await tick();
  assert.equal(h.checks, 1);
  h.controller.wake();
  await tick();
  assert.equal(h.checks, 1);
  h.advance(CHECK_INTERVAL);
  h.controller.wake();
  await tick();
  assert.equal(h.checks, 2);
  h.scheduled[1].fn();
  await tick();
  assert.equal(h.checks, 3);
  h.updater.emit("update-downloaded", { version: "1.3.1" });
  await tick();
  h.scheduled[1].fn();
  await tick();
  assert.equal(h.checks, 3);
  assert.equal(h.controller.getState().status, "ready");
});
test("prompts once when focused and keeps a dismissed update available", async () => {
  const h = setup({ focused: false });
  h.updater.emit("update-available", { version: "1.3.1" });
  await tick();
  assert.equal(h.dialogs.length, 0);
  await h.focus();
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.controller.getState().status, "available");
  await h.focus();
  assert.equal(h.dialogs.length, 1);
  await h.controller.show();
  assert.equal(h.dialogs.length, 2);
});
test("download prompts for restart separately and Later never installs", async () => {
  const h = setup({ answers: [0, 1] });
  h.updater.emit("update-available", { version: "1.3.1" });
  await tick();
  assert.equal(h.dialogs.length, 2);
  assert.equal(h.controller.getState().status, "ready");
  assert.equal(h.installs, 0);
  assert.equal(h.resumes, 1);
  assert.equal(h.updater.autoInstallOnAppQuit, false);
});
test("processing warns but does not block an explicitly confirmed restart", async () => {
  const h = setup({ busy: true, answers: [0] });
  h.updater.emit("update-downloaded", { version: "1.3.1" });
  await tick();
  assert.match(h.dialogs[0].detail, /will be cancelled/);
  assert.equal(h.dialogs[0].defaultId, 1);
  assert.equal(h.installs, 1);
  assert.equal(h.resumes, 0);
});
test("dismissing restart leaves processing and update available", async () => {
  const h = setup({ busy: true, answers: [1] });
  h.updater.emit("update-downloaded", { version: "1.3.1" });
  await tick();
  assert.equal(h.installs, 0);
  assert.equal(h.resumes, 1);
  assert.equal(h.controller.getState().status, "ready");
});
test("idle restart has no processing warning or playback gate", async () => {
  const h = setup({ answers: [0] });
  h.updater.emit("update-downloaded", { version: "1.3.1" });
  await tick();
  assert.doesNotMatch(h.dialogs[0].detail, /cancelled|playback/i);
  assert.equal(h.installs, 1);
});

test("a failed download remains available for retry and reports the error", async () => {
  const h = setup({ answers: [0, 0] });
  h.updater.downloadUpdate = async () => {
    h.updater.emit("error", new Error("network"));
    throw new Error("network");
  };
  h.updater.emit("update-available", { version: "1.3.1" });
  await tick();
  assert.equal(h.controller.getState().status, "available");
  assert.equal(h.controller.getState().version, "1.3.1");
  assert.equal(h.dialogs.at(-1).type, "error");
});

test("a rejected check cannot reuse an earlier up-to-date result", async () => {
  const h = setup();
  await h.controller.show();
  assert.equal(h.controller.getState().status, "current");
  h.updater.checkForUpdates = async () => { throw new Error("offline"); };
  await h.controller.show();
  assert.equal(h.controller.getState().status, "error");
  assert.equal(h.dialogs.at(-1).type, "error");
  assert.doesNotMatch(h.dialogs.at(-1).message, /up to date/);
  h.updater.checkForUpdates = async () => h.updater.emit("update-not-available");
  await h.controller.show();
  assert.equal(h.controller.getState().status, "current");
});

test("a disabled updater cannot reuse an earlier up-to-date result", async () => {
  const h = setup();
  await h.controller.show();
  h.updater.checkForUpdates = async () => null;
  await h.controller.show();
  assert.equal(h.controller.getState().status, "error");
  assert.equal(h.dialogs.at(-1).type, "error");
});

test("manual checks await a background check and show its completed result", async () => {
  const h = setup();
  let finish;
  h.updater.checkForUpdates = () => new Promise(resolve => { finish = resolve; });
  h.scheduled[0].fn();
  await tick();
  const shown = h.controller.show();
  await tick();
  assert.equal(h.dialogs.length, 0);
  h.updater.emit("update-available", { version: "1.4.0" });
  finish();
  await shown;
  assert.equal(h.dialogs.length, 1);
  assert.match(h.dialogs[0].message, /1.4.0 is available/);
});

test("a download rejection without an error event still allows retry", async () => {
  const h = setup({ focused: false, answers: [0] });
  h.updater.emit("update-available", { version: "1.4.0" });
  h.updater.downloadUpdate = async () => { throw new Error("offline"); };
  await h.controller.show();
  assert.equal(h.controller.getState().status, "available");
  assert.equal(h.controller.getState().version, "1.4.0");
  assert.equal(h.dialogs.at(-1).type, "error");
});

test("overlapping wake and manual checks share a handled failure", async () => {
  const h = setup();
  let fail;
  let calls = 0;
  h.updater.checkForUpdates = () => {
    calls++;
    return new Promise((_resolve, reject) => { fail = reject; });
  };
  h.scheduled[0].fn();
  await tick();
  h.advance(CHECK_INTERVAL);
  h.controller.wake();
  const shown = h.controller.show();
  fail(new Error("offline"));
  await shown;
  await tick();
  assert.equal(calls, 1);
  assert.equal(h.controller.getState().status, "error");
  assert.match(h.dialogs.at(-1).message, /Check your connection/);
});
