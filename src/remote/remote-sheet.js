// The Phone remote dialog (Stage ⋯ → Phone remote…, the palette): how to control this device from a phone.
// There is no pairing: any device signed in to the same account can be the remote, so this is help, a
// shortcut and a switch, not a setup step.
//
//   openRemoteSheet(deps?) → Promise<void>      resolves when the dialog closes
//     deps {prefs, status, origin, platform}: replaced in tests
//   remoteUrl(hostId, origin) → `${origin}/remote?host=<hostId>`
//   qrSvg(text, doc) → <svg>                     dark modules on white (scanners need the contrast in any theme)
//
// "Phone remote"
//   On your phone, open Woodshed signed in to this account: <device> shows up with the song that's open,
//   ready to control. No pairing needed.
//   [QR code] "Or scan to open the remote" + the link
//   [Allow remote control on this <device>] (prefs.remote.allow; off: the host leaves at once)
//   the status: "Your phone is connected." while a remote watches; "Waiting for your phone…" otherwise
import '../styles/views/remote/remote-sheet.css';
import qrcode from 'qrcode-generator';
import {prefs as appPrefs} from '../app/prefs.js';
import {platform as appPlatform} from '../app/platform.js';
import {now as clockNow} from '../app/clock.js';
import {effect} from '../app/store.js';
import {Dialog} from '../ui/dialog.js';
import {h} from '../ui/h.js';
import {Toggle} from '../ui/toggle.js';
import {deviceName, hostIdOf, hostStatus, WATCH_MS} from './remote-host.js';
import {shareOrigin} from '../share/share-dialog.js';

export const COPY = Object.freeze({
  title: 'Phone remote',
  lead: device => `On your phone, open Woodshed signed in to this account. This ${device} shows up with the song that’s open, ready to control. No pairing needed.`,
  scan: 'Or scan to open the remote',
  allow: device => `Allow remote control on this ${device}`,
  connected: 'Your phone is connected.',
  waiting: 'Waiting for your phone…',
  off: 'Remote control is off on this device.',
  done: 'Done',
});

const SVG = 'http://www.w3.org/2000/svg';

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

  const off = effect(() => {
    const s = status.value;
    const allowed = prefs.get('remote.allow') !== false;
    allow.set({pressed: allowed});
    line.textContent = !allowed ? COPY.off
      : s?.hosting && s.watchedAt && now() - s.watchedAt <= WATCH_MS ? COPY.connected : COPY.waiting;
    line.dataset.connected = String(line.textContent === COPY.connected);
  });

  const dialog = Dialog({title: COPY.title, body, className: 'remote-sheet-dialog', width: 440, actions: [{label: COPY.done, value: true, variant: 'primary'}]});
  try {
    await dialog.closed;
  } finally {
    off();
    allow.destroy();
  }
}
