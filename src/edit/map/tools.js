// Edit · Map's tools, at the far end of the toolbar (2.9; they were the last section of the inspector, a screen
// and a half down). These are the ways a map gets made or checked, so they sit where they can be seen:
//
//   [Tap along Space] [Preview P] [Detect beats] [Find a chart…] [⋯ More tools]
//
// In a toolbar narrower than 1040 px the buttons keep their icons and drop their words (map.css); the names stay
// for screen readers and as tooltips.
//
// Preview needs bars, so an unmapped song shows Tap along, Detect beats and Find a chart only (the inspector's
// "Get a map" explains each). More tools holds what tapping is tuned with: Calibrate tap timing… and Snap taps to
// drum hits (a device pref). Suggest sections is offered in the sections lane while it is empty (sections.js), and
// in More tools while the song has no sections.
//
//   mountMapTools(el, {session, mapSession, registry, prefs}) → {el, update(), destroy()}
//
// Every button runs a registry command, so key-caps, enabled and pressed states and the "Stop tapping" title come
// from §3.4. Detect beats shows the job's line while it runs. A tool that cannot run says why in its tooltip (the
// web with no computer to detect on: "Needs Woodshed for desktop…"): a toolbar button has no room to print it, as
// the inspector's buttons did.
import {registry as appRegistry} from '../../app/commands.js';
import {prefs as appPrefs} from '../../app/prefs.js';
import {effect} from '../../app/store.js';
import {h} from '../../ui/h.js';
import {Button, IconButton} from '../../ui/button.js';
import {Toggle} from '../../ui/toggle.js';
import {Menu} from '../../ui/menu.js';
import {Kbd} from '../../ui/kbd.js';
import {COPY, MAP_COMMANDS as C} from './map.copy.js';

const peek = (v) => (v && typeof v === 'object' && typeof v.peek === 'function' ? v.peek() : v);

/** A key-cap hint inside a control (aria-hidden; shown only in [data-kbd-hints]). */
function hint(el, keys) {
  const k = Kbd({keys, hint: true, className: 'map-hint'});
  k.el.setAttribute('aria-hidden', 'true');
  el.append(k.el);
  return k;
}

export function mountMapTools(el, {session, mapSession, registry = appRegistry, prefs = appPrefs} = {}) {
  if (!el) throw new TypeError('mountMapTools needs a host element.');
  if (!session?.map || !mapSession) throw new TypeError('mountMapTools needs a session and a map session.');
  const {map} = session;
  const owned = [];
  const keep = (p) => { owned.push(p); return p; };
  let destroyed = false;
  let menu = null;

  const tapAlong = keep(Button({command: C.tapAlong, size: 'sm', variant: 'quiet', registry}));
  keep(hint(tapAlong.el, 'Space'));
  const preview = keep(Toggle({label: COPY.previewShort, command: C.preview, size: 'sm', variant: 'quiet', registry,
    attrs: {'aria-label': COPY.preview}, title: COPY.preview}));
  keep(hint(preview.el, 'KeyP'));
  const detect = keep(Button({label: COPY.detect, command: C.detect, size: 'sm', variant: 'quiet', registry}));
  const find = keep(Button({label: COPY.find, command: C.find, size: 'sm', variant: 'quiet', registry}));
  const more = keep(IconButton({label: COPY.moreTools, icon: 'ellipsis', size: 'sm', variant: 'quiet',
    attrs: {'aria-haspopup': 'menu', 'aria-expanded': 'false'}, className: 'map-tools-more', onClick: () => openMore()}));

  const snapTaps = () => prefs.get?.('edit.map.tapSnap') !== false;
  function openMore() {
    menu?.close?.();
    more.el.setAttribute('aria-expanded', 'true');
    menu = Menu.open([
      // Also in the empty sections lane; here it can be run again while a suggestion waits for review.
      ...(map.isReal && !map.hasSections ? [{command: C.suggest}, {type: 'separator'}] : []),
      {command: C.calibrate},
      {id: 'map-snap-taps', type: 'checkbox', label: COPY.snapTaps, checked: snapTaps(), run: () => prefs.set?.('edit.map.tapSnap', !snapTaps())},
    ], {anchor: more.el, label: COPY.moreTools, registry, onClose: () => { more.el.setAttribute('aria-expanded', 'false'); menu = null; }});
  }

  const root = h('div', {class: 'map-tools', role: 'group', attrs: {'aria-label': COPY.tools}, dataset: {testid: 'map-tools'}},
    tapAlong.el, preview.el, detect.el, find.el, more.el);
  el.append(root);

  function busyLine() {
    const state = peek(session.detect?.state);
    return state && (state.phase === 'running' || state.phase === 'starting') ? (state.line || COPY.detect) : false;
  }

  /** The command's disabled reason goes in the tooltip, never in the button (disabledReason '' keeps it out). */
  const reasoned = [[tapAlong, C.tapAlong, null], [preview, C.preview, COPY.preview], [detect, C.detect, null], [find, C.find, null]];
  function update() {
    if (destroyed) return;
    const real = !!map.isReal;
    preview.el.hidden = !real;
    for (const [button, command, title] of reasoned) {
      const reason = registry.state?.(command)?.reason || null;
      button.set({disabledReason: '', title: reason ?? title ?? undefined});
    }
    detect.set({busy: busyLine()});
  }

  const offs = [
    effect(() => { session.detect?.state?.value; mapSession.previewing?.value; mapSession.tapping?.value; update(); }),
    map.subscribe(() => update()),
    registry.onChange?.((change) => { if (!change?.ids || reasoned.some(([, command]) => change.ids.includes(command))) update(); }),
  ];
  update();

  return {
    el: root,
    update,
    /** The More tools menu's Esc layer: true when it closed one. */
    escape() { if (!menu) return false; menu.close?.(); return true; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const off of offs) off?.();
      menu?.close?.();
      for (const p of owned.splice(0)) p?.destroy?.();
      root.remove();
    },
  };
}

export default mountMapTools;
