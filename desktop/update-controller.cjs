const { publicUpdateState } = require("./update-policy.cjs");
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
function createUpdateController({
  updater,
  publish,
  showDialog,
  quiesce,
  resume,
  install,
  isFocused,
  version,
  packaged,
  timers = globalThis,
  now = Date.now,
}) {
  let state = publicUpdateState("idle"),
    dialogOpen = false,
    lastCheck = 0;
  const prompted = new Set();
  function emit(status, info) {
    state = publicUpdateState(status, info);
    publish(state);
  }
  async function check() {
    if (
      !packaged ||
      ["checking", "available", "downloading", "ready"].includes(state.status)
    )
      return;
    lastCheck = now();
    try {
      await updater.checkForUpdates();
    } catch {
      /* The updater error event reports this. */
    }
  }
  async function show(automatic = false) {
    if (dialogOpen || (automatic && !isFocused())) return;
    if (
      automatic &&
      (!["available", "ready"].includes(state.status) ||
        prompted.has(`${state.status}:${state.version}`))
    )
      return;
    dialogOpen = true;
    try {
      if (!packaged) {
        await showDialog({
          message: "Updates are available in installed builds.",
          buttons: ["OK"],
        });
        return;
      }
      if (
        !automatic &&
        !["available", "downloading", "ready"].includes(state.status)
      )
        await check();
      if (state.status === "available") {
        prompted.add(`available:${state.version}`);
        const result = await showDialog({
          type: "info",
          message: `Woodshed ${state.version} is available`,
          detail:
            "Download the update now. You can keep using Woodshed and choose when to restart.",
          buttons: ["Download update", "Later"],
          defaultId: 0,
          cancelId: 1,
        });
        if (result.response === 0 && state.status === "available") {
          emit("downloading", { version: state.version });
          await updater.downloadUpdate();
        }
      } else if (state.status === "ready") {
        prompted.add(`ready:${state.version}`);
        let restarting = false;
        try {
          const activity = await quiesce();
          const result = await showDialog({
            type: activity.busy ? "warning" : "info",
            message: `Restart to update to Woodshed ${state.version}?`,
            detail: activity.busy
              ? "Song processing is in progress and will be cancelled when Woodshed restarts."
              : "The update is ready. Woodshed will close and reopen.",
            buttons: ["Restart now", "Later"],
            defaultId: 1,
            cancelId: 1,
          });
          if (result.response === 0) {
            await install();
            restarting = true;
          }
        } finally {
          if (!restarting) resume();
        }
      } else if (!automatic) {
        await showDialog({
          type: state.status === "error" ? "error" : "info",
          message:
            state.status === "current"
              ? "Woodshed is up to date."
              : state.status === "downloading"
                ? `Downloading update — ${Math.round(state.percent)}%`
                : state.message || "Checking for updates…",
          buttons: ["OK"],
        });
      }
    } catch {
      await showDialog({
        type: "error",
        message: "The update could not finish. Please try again.",
        buttons: ["OK"],
      });
    } finally {
      dialogOpen = false;
      // A download may have completed while its prompt was being handled.
      if (state.status === "ready" && !prompted.has(`ready:${state.version}`))
        void show(true);
    }
  }
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.on("checking-for-update", () => emit("checking"));
  updater.on("update-available", (info) => {
    emit("available", info);
    void show(true);
  });
  updater.on("update-not-available", () => emit("current", { version }));
  updater.on("download-progress", (info) =>
    emit("downloading", { ...info, version: state.version }),
  );
  updater.on("update-downloaded", (info) => {
    emit("ready", info);
    void show(true);
  });
  updater.on("error", () =>
    emit(state.status === "downloading" ? "available" : "error", {
      version: state.version,
      message: "Could not check or download the update. Please try again.",
    }),
  );
  if (packaged) {
    timers.setTimeout(() => void check(), 15000).unref?.();
    timers.setInterval(() => void check(), CHECK_INTERVAL).unref?.();
  }
  return {
    getState: () => state,
    show: () => show(false),
    focus: () => show(true),
    wake: () => {
      if (now() - lastCheck >= CHECK_INTERVAL) void check();
    },
  };
}
module.exports = { createUpdateController, CHECK_INTERVAL };
