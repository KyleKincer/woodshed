// The Phone remote dialog (Stage ⋯ → Phone remote…, the palette): how to control this device from a phone.
// There is no pairing: any device signed in to the same account can be the remote, so this is help, a
// shortcut and a switch, not a setup step.
//
//   openRemoteSheet(deps?) → Promise<void>      resolves when the dialog closes
//     deps {prefs, status, origin, platform, now, setTimer, clearTimer}: replaced in tests
//   remoteUrl(hostId, origin) → `${origin}/remote?host=<hostId>`
//   qrSvg(text, doc) → <svg>                     dark modules on white (scanners need the contrast in any theme)
//
// "Phone remote"
//   On your phone, open Woodshed signed in to this account: <device> shows up with the song that's open,
//   ready to control. No pairing needed.
//   [QR code] "Or scan to open the remote" + the link
//   [Allow remote control on this <device>] (prefs.remote.allow; off: the host leaves at once)
//   the status: "Your phone is connected." while a remote watches (its last `watch` within WATCH_MS by the
//   server's clock, re-checked every RECHECK_MS: a phone that leaves just stops watching); the other-tab line
//   while another tab of this browser hosts (the host id, so the QR code, is shared); "Waiting for your
//   phone…" otherwise. The line is rewritten only when it changes (it is a live region).
import '../styles/views/remote/remote-sheet.css';
import qrcode from 'qrcode-generator';
import {prefs as appPrefs} from '../app/prefs.js';
import {platform as appPlatform} from '../app/platform.js';
import {now as clockNow} from '../app/clock.js';
import {effect} from '../app/store.js';
import {Dialog} from '../ui/dialog.js';
import {h} from '../ui/h.js';
import {Toggle} from '../ui/toggle.js';
import {deviceName, hostIdOf, hostStatus, serverTime, WATCH_MS} from './remote-host.js';
import {shareOrigin} from '../share/share-dialog.js';

export const COPY = Object.freeze({
  title: 'Phone remote',
  lead: device => `On your phone, open Woodshed signed in to this account. This ${device} shows up with the song that’s open, ready to control. No pairing needed.`,
  scan: 'Or scan to open the remote',
  allow: device => `Allow remote control on this ${device}`,
  connected: 'Your phone is connected.',
  elsewhere: 'Woodshed is open in another tab or window too. Your phone controls the song there.',
  waiting: 'Waiting for your phone…',
  off: 'Remote control is off on this device.',
  done: 'Done',
});

const SVG = 'http://www.w3.org/2000/svg';
/** While the dialog is open, whether the phone is still watching is re-checked this often. */
export const RECHECK_MS = 5_000;

export function remoteUrl(hostId, origin) {
  return `${String(origin ?? '').replace(/\/+$/, '')}/remote?host=${encodeURIComponent(hostId)}`;
}

export function qrSvg(text, doc = globalThis.document) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), quiet = 4, size = n + quiet * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('class', 'remote-qr');
  svg.setAttribute('role', 'img');
  svg.setAttribute('shape-rendering', 'crispEdges');
  const bg = doc.createElementNS(SVG, 'rect');
  bg.setAttribute('width', String(size));
  bg.setAttribute('height', String(size));
  bg.setAttribute('fill', '#fff');
  const path = doc.createElementNS(SVG, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svg.append(bg, path);
  return svg;
}

export async function openRemoteSheet(deps = {}) {
  const prefs = deps.prefs ?? appPrefs;
  const status = deps.status ?? hostStatus;
  const now = deps.now ?? clockNow;
  const setTimer = deps.setTimer ?? globalThis.setInterval.bind(globalThis);
  const clearTimer = deps.clearTimer ?? globalThis.clearInterval.bind(globalThis);
  const device = deviceName(deps.platform ?? appPlatform);
  const hostId = hostIdOf(prefs);
  const url = remoteUrl(hostId, deps.origin ?? shareOrigin());

  const qr = qrSvg(url);
  qr.setAttribute('aria-label', COPY.scan);
  const link = h('a', {class: 'remote-sheet-link', href: url, target: '_blank', rel: 'noopener'}, url.replace(/^https?:\/\//, ''));
  const line = h('p', {class: 'remote-sheet-status', role: 'status'});
  const allow = Toggle({label: COPY.allow(device), pressed: prefs.get('remote.allow') !== false, className: 'remote-sheet-allow',
    onChange: (on) => prefs.set('remote.allow', !!on)});
  const body = h('div', {class: 'remote-sheet'},
    h('p', {class: 'remote-sheet-lead'}, COPY.lead(device)),
    h('figure', {class: 'remote-sheet-code'}, qr, h('figcaption', {}, COPY.scan, h('br'), link)),
    allow.el, line);

  function paint() {
    const s = status.value;
    const allowed = prefs.get('remote.allow') !== false;
    allow.set({pressed: allowed});
    const text = !allowed ? COPY.off
      : s?.hosting && s.watchedAt && serverTime(now()) - s.watchedAt <= WATCH_MS ? COPY.connected
        : !s?.hosting && s?.elsewhere ? COPY.elsewhere : COPY.waiting;
    if (line.textContent !== text) line.textContent = text;
    line.dataset.connected = String(text === COPY.connected);
  }
  const off = effect(paint);
  // A phone that leaves just stops watching, which changes nothing the effect reads.
  const timer = setTimer(paint, RECHECK_MS);

  const dialog = Dialog({title: COPY.title, body, className: 'remote-sheet-dialog', width: 440, actions: [{label: COPY.done, value: true, variant: 'primary'}]});
  try {
    await dialog.closed;
  } finally {
    off();
    clearTimer(timer);
    allow.destroy();
  }
}
