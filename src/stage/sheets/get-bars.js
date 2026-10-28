// The Get bars popover (architecture §2.14.11, D44, B5; spec §4.4C, §5.1.1): the strip's
// "No bar grid · Get bars →" chip, the ⋯ menu and the palette open it. Three ways to a bar grid:
//
// - Tap the beat… (`stage.tapBeat`): works on every platform; it opens the Tap the beat sheet in
//   this one's place.
// - Detect beats (`map.detect`): enabled on desktop with a ready processor, and on the web with an
//   online paired computer (`detect.canDetect`); otherwise disabled with the reason shown. While a
//   detection runs, its line ("Finding bars · 30%") and a progress rail replace the description; a
//   failure shows describeError's sentence with [Try again] (`detect.retry`). The web without a
//   paired computer (the needs-desktop reason) also gets a "Get Woodshed for desktop" link; a paused
//   account or a desktop whose processor is down does not, since installing would not help.
// - The description names where a detection runs: "About 30 s on this computer." for this
//   computer's processor (its companion is also one of the paired devices, so the verdict's
//   deviceId is compared with the local processor's), else "Runs on <computer>.".
// - Find a chart… (`map.find`): Edit · Map's Find panel.
//
//   export function render(container, {session, close, registry?, devices?, desktop?}) → {destroy}

import '../../styles/views/stage/sheets-get-bars.css';
import {registry as appRegistry} from '../../app/commands.js';
import {desktop as appDesktop} from '../../app/desktop.js';
import {effect, store} from '../../app/store.js';
import {Button} from '../../ui/button.js';
import {h} from '../../ui/h.js';
import {ProgressRail} from '../../ui/progress.js';
import {InlineStatus} from '../../ui/status.js';
import {COPY as DETECT_COPY} from '../detect.js';
import {COPY as ALL} from './sheets-b.copy.js';

const COPY = ALL.getBars;
/** Where "Get Woodshed for desktop" goes (the download page, DL1). */
export const DOWNLOAD_PATH = '/download';

const peek = (v) => (v && typeof v === 'object' && typeof v.peek === 'function' ? v.peek() : v);

/** The Detect row's description for a canDetect verdict. */
export function detectDescription(verdict, {devices = [], desktopAvailable = false, localDeviceId = null} = {}) {
  if (!verdict?.ok) return COPY.detectGeneric;
  const localProcessor = desktopAvailable && (!verdict.deviceId || verdict.deviceId === localDeviceId);
  if (localProcessor) return COPY.detectBody;
  const device = devices.find((d) => d.deviceId === verdict.deviceId);
  const name = typeof device?.name === 'string' ? device.name.trim() : '';
  return name ? COPY.detectRemote(name) : COPY.detectRemoteUnnamed;
}

export function render(container, {session, close = () => {}, registry = appRegistry, devices = store.library.devices, desktop = appDesktop} = {}) {
  if (!session) throw new TypeError('getBars: a session is required');
  const detect = session.detect ?? null;
  const offs = [];

  const option = (button, body, extra = []) => h('li', {class: 'getbars-option'}, button.el, body, ...extra);

  const tap = Button({label: COPY.tap, command: 'stage.tapBeat', registry, icon: 'hand', variant: 'secondary', className: 'getbars-button'});
  const tapBody = h('p', {class: 'getbars-body'}, COPY.tapBody);

  const detectButton = Button({label: COPY.detect, command: 'map.detect', registry, icon: 'wand-2', variant: 'secondary', className: 'getbars-button'});
  const detectBody = h('p', {class: 'getbars-body'});
  const progressLine = h('p', {class: 'getbars-progress-line', dataset: {volatile: ''}});
  const rail = ProgressRail({value: null, label: COPY.progress});
  const progress = h('div', {class: 'getbars-progress'}, progressLine, rail.el);
  const retry = {label: COPY.retry, run: () => { void detect?.retry?.(); }};
  // describeError's own action when it is not a plain retry (e.g. Restart processor); a retry goes
  // through the flow, which follows the job again.
  const failureAction = (error) => {
    const primary = error?.primary;
    return primary?.label && primary.label !== COPY.retry && typeof primary.run === 'function' ? {label: primary.label, run: () => primary.run()} : retry;
  };
  const failure = InlineStatus({tone: 'error', text: '', action: retry});
  const download = h('a', {class: 'getbars-download', href: DOWNLOAD_PATH}, COPY.getDesktop);

  const find = Button({label: COPY.find, command: 'map.find', registry, icon: 'search', variant: 'secondary', className: 'getbars-button',
    onClick: () => close()});
  const findBody = h('p', {class: 'getbars-body'}, COPY.findBody);

  const intro = h('p', {class: 'getbars-intro'});
  const root = h('div', {class: 'getbars', dataset: {sheetBody: 'getBars'}},
    intro,
    h('ul', {class: 'getbars-options'},
      option(tap, tapBody),
      option(detectButton, detectBody, [progress, failure.el, download]),
      option(find, findBody)));
  container.append(root);

  function paint() {
    const mapped = peek(session.position?.mapped) ?? !!session.map?.isReal;
    intro.textContent = mapped ? COPY.mapped : COPY.unmapped;
    const verdict = peek(detect?.canDetect) ?? null;
    const state = peek(detect?.state) ?? {phase: 'idle'};
    const list = peek(devices) ?? [];
    const running = state.phase === 'starting' || state.phase === 'running';
    const localDeviceId = peek(desktop?.processor)?.deviceId ?? null;
    detectBody.textContent = detectDescription(verdict, {devices: list, desktopAvailable: !!desktop?.available, localDeviceId});
    detectBody.hidden = running;
    progress.hidden = !running;
    root.toggleAttribute('data-detecting', running);
    if (running) {
      progressLine.textContent = state.phase === 'starting' ? COPY.starting : state.line ?? COPY.starting;
      rail.set({value: Number.isFinite(state.percent) && state.phase === 'running' ? state.percent / 100 : null});
    }
    detectButton.set({disabled: running ? true : undefined});
    const failed = state.phase === 'error';
    failure.el.hidden = !failed;
    if (failed) failure.set({text: state.error?.sentence ?? String(state.error ?? ''), action: failureAction(state.error)});
    download.hidden = !!desktop?.available || session.readOnly || !(verdict && !verdict.ok && verdict.reason === DETECT_COPY.needsDesktop);
  }

  if (detect) {
    offs.push(effect(() => {
      detect.canDetect?.value;
      detect.state?.value;
      devices?.value;
      desktop?.processor?.value;
      session.position?.mapped?.value;
      paint();
      // The buttons read the commands' enabled state and reasons through the registry.
      registry.invalidate?.();
    }));
  } else {
    paint();
  }

  return {
    el: root,
    destroy() {
      for (const off of offs.splice(0).reverse()) off?.();
      tap.destroy(); detectButton.destroy(); find.destroy(); rail.destroy(); failure.destroy();
      root.remove();
    },
  };
}

export default render;
