'use strict';
// Renderer flush before quitting or installing an update (architecture §6.11
// item 7, maps/companion-desktop.md §16.10).
//
// Main sends `desktop:flush` {id}; the preload runs every registered flush
// callback (pending practice and tempo saves) and answers `desktop:flushed`
// {id}. Main never waits longer than timeoutMs.

let sequence = 0;

/**
 * @param {Electron.WebContents} webContents
 * @param {{timeoutMs?: number, timers?: {setTimeout: Function, clearTimeout: Function}, trusted?: (event) => boolean}} [options]
 * @returns {Promise<'flushed'|'timeout'|'gone'>}
 */
function requestFlush(webContents, { timeoutMs = 3000, timers = globalThis, trusted } = {}) {
  return new Promise(resolve => {
    if (!webContents || webContents.isDestroyed?.() || !webContents.ipc) {
      resolve('gone');
      return;
    }
    const id = `flush-${++sequence}`;
    const { ipc } = webContents;
    let done = false;
    let timer = null;
    const finish = result => {
      if (done) return;
      done = true;
      if (timer !== null) timers.clearTimeout(timer);
      ipc.removeListener('desktop:flushed', onFlushed);
      webContents.removeListener?.('destroyed', onGone);
      webContents.removeListener?.('render-process-gone', onGone);
      resolve(result);
    };
    function onFlushed(event, reply) {
      if (!reply || reply.id !== id) return;
      if (trusted && !trusted(event)) return;
      finish('flushed');
    }
    function onGone() {
      finish('gone');
    }
    ipc.on('desktop:flushed', onFlushed);
    webContents.once?.('destroyed', onGone);
    webContents.once?.('render-process-gone', onGone);
    timer = timers.setTimeout(() => finish('timeout'), timeoutMs);
    try {
      webContents.send('desktop:flush', { id });
    } catch {
      finish('gone');
    }
  });
}

// The quit-guard copy is unchanged from 1.9 (spec §6.5).
const BUSY_QUIT_DIALOG = Object.freeze({
  type: 'question',
  buttons: ['Keep processing', 'Quit Woodshed'],
  defaultId: 0,
  cancelId: 0,
  message: 'A song is still processing',
  detail: 'Quitting stops this job. Completed local stages can resume when you reopen Woodshed.',
});

/**
 * The window `close` handler: ask when a job is running, then flush, then quit.
 * @param {{isClosing: () => boolean, localStatus: () => Promise<{busy?: boolean}>, showDialog: (options) => Promise<{response: number}>, flush: () => Promise<unknown>, quit: () => void}} deps
 */
function createQuitGuard({ isClosing, localStatus, showDialog, flush, quit }) {
  let pending = false;
  return async function onClose(event) {
    if (isClosing()) return;
    event.preventDefault();
    if (pending) return;
    pending = true;
    try {
      let busy = false;
      try {
        busy = (await localStatus())?.busy === true;
      } catch {
        busy = false;
      }
      if (busy) {
        const { response } = await showDialog(BUSY_QUIT_DIALOG);
        if (response !== 1) return;
      }
      try {
        await flush();
      } catch {
        // A failed flush never blocks quitting.
      }
      quit();
    } finally {
      pending = false;
    }
  };
}

/**
 * Update install order (D12): mark closing, flush the renderer, stop the
 * companion (which pauses its job; it resumes after the restart), install.
 */
async function installUpdate({ markClosing, flush, stopCompanion, quitAndInstall }) {
  markClosing();
  try {
    await flush();
  } catch {
    // Install anyway; the flush is best effort.
  }
  await stopCompanion();
  quitAndInstall();
}

module.exports = { requestFlush, createQuitGuard, installUpdate, BUSY_QUIT_DIALOG };
