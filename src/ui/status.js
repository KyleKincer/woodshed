// InlineStatus (architecture §2.12, spec §7.9): one per panel, in flow. Tones info, ok, warn and error; errors are
// role=alert, the rest role=status.
//
//   InlineStatus({tone = 'info', text, action, className, id, attrs, dataset, testid}) → {el, set(partial), destroy()}
//   text    a string, a Node, or an array of them
//   action  {label, run}: a button after the text

import {h} from './h.js';
import {icon} from './icon.js';
import {applyCommon, setContent, withDefaults} from './popover.js';
import '../styles/primitives/status.css';

export const TONES = Object.freeze(['info', 'ok', 'warn', 'error']);
const ICON = {info: 'info', ok: 'check', warn: 'alert-triangle', error: 'alert-circle'};

/** An inline status line. See the header. */
export function InlineStatus(props = {}) {
  let p = withDefaults({tone: 'info'}, props);
  const toneIcon = h('span', {class: 'ui-status-icon', 'aria-hidden': 'true'});
  const text = h('span', {class: 'ui-status-text'});
  const actionButton = h('button', {type: 'button', class: 'ui-status-action'});
  const el = h('div', {class: 'ui-status'}, toneIcon, text, actionButton);
  actionButton.addEventListener('click', e => p.action?.run?.(e));

  const apply = (next, prev = {}) => {
    if (!TONES.includes(next.tone)) throw new RangeError(`InlineStatus: unknown tone ${JSON.stringify(next.tone)}`);
    applyCommon(el, next, prev);
    el.dataset.tone = next.tone;
    el.setAttribute('role', next.tone === 'error' ? 'alert' : 'status');
    if (next.tone !== prev.tone) toneIcon.replaceChildren(icon(ICON[next.tone], {size: 16}));
    if (next.text !== prev.text) setContent(text, next.text);
    actionButton.hidden = !next.action;
    actionButton.textContent = next.action?.label ?? '';
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
