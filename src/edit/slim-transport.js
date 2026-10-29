// Edit's slim transport (architecture §2.15, spec §5.0): the 56 px row at the bottom of every
// Edit tab: ⟲ ▶ ‖, bar.beat plus time, the loop chip, the speed chip, Count-in and Click, and the
// Mix chip. It is the Stage's control set rendered as `controls.js` variant 'slim', so every control
// runs the same registry command as on the Stage (same commands, spec §5.0), and the speed, click,
// loop and mix chips open the same Stage sheets: outside the Stage they open as bottom sheets
// through src/stage/sheets/host.js (the transport commands read the 'session' and 'transport'
// contexts, which the Edit frame provides).
//
//   mountSlimTransport(el, {session, registry}) → {el, destroy()}
//
// The controls are one toolbar named "Transport" (controls.js). Long-presses, right-clicks,
// Shift+F10 and the ContextMenu key open the sheets (controls.js).

import '../styles/views/edit/slim-transport.css';
import {registry as appRegistry} from '../app/commands.js';
import {h} from '../ui/h.js';
import {mountControls} from '../stage/controls.js';

/** Mounts the slim transport into `el`. */
export function mountSlimTransport(el, {session, registry = appRegistry} = {}) {
  if (!el) throw new TypeError('mountSlimTransport: el is required');
  if (!session?.transport) throw new TypeError('mountSlimTransport: session is required');
  // The anchors the controls register (play, speed, loop, click, mix) stay local: Edit's sheets are
  // bottom sheets (sheets/host.js), and the Stage's 'stage' context is not provided in Edit.
  const anchors = new Map();
  const root = h('div', {class: 'edit-slim', dataset: {editTransport: ''}});
  el.append(root);
  let controls = null;
  try {
    controls = mountControls(root, {session, variant: 'slim', stage: {anchors}, registry});
  } catch (err) {
    root.remove();
    throw err;
  }
  let destroyed = false;
  return {
    el: root,
    get anchors() { return anchors; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      try { controls?.destroy?.(); } finally { root.remove(); }
    },
  };
}

export default mountSlimTransport;
