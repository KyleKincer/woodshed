const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ALLOWED_PERMISSIONS, isPermissionAllowed, installPermissions, installNavigationGuards } = require('./permissions.cjs');

const UI = 'http://127.0.0.1:47832';

function fakeSession() {
  const session = {};
  session.setPermissionRequestHandler = fn => { session.request = fn; };
  session.setPermissionCheckHandler = fn => { session.check = fn; };
  return session;
}
const ask = (session, permission, requestingUrl, contents = { getURL: () => requestingUrl }) => {
  let answer;
  session.request(contents, permission, granted => { answer = granted; }, { requestingUrl, isMainFrame: true });
  return answer;
};

test('the allow-list is exactly midi, clipboard read, sanitized clipboard write and fullscreen', () => {
  assert.deepEqual([...ALLOWED_PERMISSIONS].sort(), ['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'midi']);
});

test('requests from the UI origin: allow-listed granted, everything else denied', () => {
  const session = fakeSession();
  installPermissions(session, { uiOrigin: UI });
  for (const permission of ALLOWED_PERMISSIONS) assert.equal(ask(session, permission, `${UI}/s/abc`), true, permission);
  for (const permission of ['midiSysex', 'notifications', 'screen-wake-lock', 'media', 'geolocation', 'display-capture', 'openExternal', 'unknown', 'deprecated-sync-clipboard-read']) {
    assert.equal(ask(session, permission, `${UI}/`), false, permission);
  }
});

test('requests from another origin are denied, even for allow-listed permissions', () => {
  const session = fakeSession();
  installPermissions(session, { uiOrigin: UI });
  for (const url of ['https://evil.example/', 'http://127.0.0.1:47831/', 'http://localhost:47832/', 'file:///etc/passwd', 'not a url']) {
    assert.equal(ask(session, 'midi', url), false, url);
  }
  // Without details.requestingUrl the webContents URL decides.
  let answer;
  session.request({ getURL: () => 'https://evil.example/' }, 'midi', granted => { answer = granted; }, {});
  assert.equal(answer, false);
  session.request({ getURL: () => `${UI}/` }, 'midi', granted => { answer = granted; }, {});
  assert.equal(answer, true);
});

test('permission checks follow the same policy', () => {
  const session = fakeSession();
  installPermissions(session, { uiOrigin: UI });
  assert.equal(session.check(null, 'midi', UI, { isMainFrame: true }), true);
  assert.equal(session.check(null, 'clipboard-sanitized-write', `${UI}/`, { isMainFrame: true }), true);
  assert.equal(session.check(null, 'midiSysex', UI, { isMainFrame: true }), false);
  assert.equal(session.check(null, 'notifications', UI, { isMainFrame: true }), false);
  assert.equal(session.check(null, 'midi', 'https://evil.example', { isMainFrame: false }), false);
  assert.equal(isPermissionAllowed('midi', null, UI), false);
});

test('navigation guards keep the window on the UI origin and open only https externally', () => {
  const contents = new EventEmitter();
  const opened = [];
  contents.setWindowOpenHandler = fn => { contents.openHandler = fn; };
  installNavigationGuards(contents, { uiOrigin: UI, shell: { openExternal: url => { opened.push(url); return Promise.resolve(); } } });
  const navigate = url => {
    let prevented = false;
    contents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, url);
    return prevented;
  };
  assert.equal(navigate(`${UI}/settings`), false);
  assert.equal(navigate('https://help.example/x'), true);
  assert.equal(navigate('http://plain.example/'), true);
  assert.equal(navigate('javascript:alert(1)'), true);
  assert.deepEqual(contents.openHandler({ url: 'https://docs.example/' }), { action: 'deny' });
  assert.deepEqual(contents.openHandler({ url: 'file:///etc/passwd' }), { action: 'deny' });
  assert.deepEqual(opened, ['https://help.example/x', 'https://docs.example/']);
  let webviewPrevented = false;
  contents.emit('will-attach-webview', { preventDefault: () => { webviewPrevented = true; } });
  assert.equal(webviewPrevented, true);
});
