// Toast (architecture §2.12, §2.9): the view of one toast. Queueing, holding while playing, auto-dismiss and the
// region live in src/app/feedback.js; this module never takes focus and never times anything.
//
//   Toast({message, tone = 'info', action, onDismiss, dismissLabel = 'Dismiss', className, id, attrs, dataset, testid})
//     → {el, set(partial), destroy()}
//   message    a string, a Node, or an array of them (e.g. [h('strong', title), ' is ready'])
//   tone       'info' | 'ok' | 'warn' | 'error'; errors are role=alert, the rest role=status
//   action     {label, run}: a button; clicking it runs `run()` and then onDismiss('action')
//   onDismiss  (reason: 'action' | 'close') → void; the ✕ button calls it with 'close'
// `.ui-toast-region` (toast.css) is the bottom-centre region feedback.js mounts toasts in: fixed, above the dock or
// transport through `--toast-offset`, at --z-toast (showLayer(region, 'toast') from popover.js puts it in the top layer
// above an open dialog).

import {h} from './h.js';
import {applyCommon, glyph, setContent, withDefaults} from './popover.js';
import '../styles/primitives/toast.css';

export const TONES = Object.freeze(['info', 'ok', 'warn', 'error']);
const ICON = {info: 'info', ok: 'check', warn: 'alert-triangle', error: 'alert-circle'};

/** A toast view. See the header. */
export function Toast(props = {}) {
  let p = withDefaults({tone: 'info', dismissLabel: 'Dismiss'}, props);
  const icon = h('span', {class: 'ui-toast-icon', 'aria-hidden': 'true'});
  const message = h('div', {class: 'ui-toast-message'});
  const actionButton = h('button', {type: 'button', class: 'ui-toast-action'});
  const closeButton = h('button', {type: 'button', class: 'ui-toast-close'}, glyph('x'));
  const el = h('div', {class: 'ui-toast', 'aria-atomic': 'true'}, icon, message, actionButton, closeButton);

  actionButton.addEventListener('click', () => {
    p.action?.run?.();
    p.onDismiss?.('action');
  });
  closeButton.addEventListener('click', () => p.onDismiss?.('close'));

  const apply = (next, prev = {}) => {
    if (!TONES.includes(next.tone)) throw new RangeError(`Toast: unknown tone ${JSON.stringify(next.tone)}`);
    applyCommon(el, next, prev);
    el.dataset.tone = next.tone;
    el.setAttribute('role', next.tone === 'error' ? 'alert' : 'status');
    if (next.tone !== prev.tone) icon.replaceChildren(glyph(ICON[next.tone]));
    if (next.message !== prev.message) setContent(message, next.message);
    actionButton.hidden = !next.action;
    actionButton.textContent = next.action?.label ?? '';
    closeButton.setAttribute('aria-label', next.dismissLabel);
  };
  apply(p);

  return {
    el,
    set(partial = {}) {
      const prev = p;
      p = {...p, ...partial};
      apply(p, prev);
    },
    destroy() { el.remove(); },
  };
}
