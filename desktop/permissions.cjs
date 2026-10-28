'use strict';
// Session permissions and navigation guards (architecture §6.11 item 9, D31).
//
// Only the UI origin may use Web MIDI (no sysex), clipboard read, sanitized
// clipboard write and fullscreen. Everything else is denied: notifications go
// through the main-process Notification, and the display stays awake through
// powerSaveBlocker, never through renderer permissions.

const ALLOWED_PERMISSIONS = Object.freeze(['midi', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
const allowed = new Set(ALLOWED_PERMISSIONS);

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Pure policy: true only for an allow-listed permission from the UI origin. */
function isPermissionAllowed(permission, origin, uiOrigin) {
  return allowed.has(permission) && typeof origin === 'string' && origin === uiOrigin;
}

function requestOrigin(webContents, details) {
  if (details && typeof details.requestingUrl === 'string' && details.requestingUrl) return originOf(details.requestingUrl);
  try {
    return originOf(webContents?.getURL?.());
  } catch {
    return null;
  }
}

/**
 * @param {Electron.Session} session
 * @param {{uiOrigin: string}} options
 */
function installPermissions(session, { uiOrigin }) {
  const expected = new URL(uiOrigin).origin;
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(isPermissionAllowed(permission, requestOrigin(webContents, details), expected));
  });
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const origin = requestingOrigin ? originOf(requestingOrigin) ?? requestingOrigin : requestOrigin(webContents, details);
    return isPermissionAllowed(permission, origin, expected);
  });
}

/** Opens only https: links in the system browser. */
function openExternalSafely(shell, url) {
  try {
    if (new URL(url).protocol === 'https:') void shell.openExternal(url);
  } catch {
    // Not a URL: nothing to open.
  }
}

/**
 * Off-origin navigation is prevented and handed to the system browser;
 * window.open always opens externally; <webview> is never attached.
 */
function installNavigationGuards(webContents, { uiOrigin, shell }) {
  const expected = new URL(uiOrigin).origin;
  webContents.on('will-navigate', (event, url) => {
    if (originOf(url) !== expected) {
      event.preventDefault();
      openExternalSafely(shell, url);
    }
  });
  webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(shell, url);
    return { action: 'deny' };
  });
  webContents.on('will-attach-webview', event => event.preventDefault());
}

module.exports = { ALLOWED_PERMISSIONS, isPermissionAllowed, installPermissions, installNavigationGuards, openExternalSafely };
