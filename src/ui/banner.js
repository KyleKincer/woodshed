// Banner (architecture §2.12, spec §7.9): always in layout flow, never fixed (offline, codec, export-only, the
// markers offer, "Is this the right recording?").
//
//   Banner({tone = 'info', title, text, actions = [], dismissible = false, onDismiss, dismissLabel = 'Dismiss',
//           className, id, attrs, dataset, testid}) → {el, set(partial), destroy()}
//   text      a string, a Node, or an array of them
//   actions   [{label, run, variant: 'primary'|'secondary'}] buttons, or ready-made Nodes (e.g. a Button's el)
//   tone      'info' | 'ok' | 'warn' | 'error'; errors are role=alert, the rest role=status

import {h} from './h.js';
import {applyCommon, glyph, setContent, withDefaults} from './popover.js';
import '../styles/primitives/banner.css';

export const TONES = Object.freeze(['info', 'ok', 'warn', 'error']);
const ICON = {info: 'info', ok: 'check', warn: 'alert-triangle', error: 'alert-circle'};
let bannerSeq = 0;

/** An in-flow banner. See the header. */
export function Banner(props = {}) {
  let p = withDefaults({tone: 'info', actions: [], dismissible: false, dismissLabel: 'Dismiss'}, props);
  const seq = ++bannerSeq;
  const icon = h('span', {class: 'ui-banner-icon', 'aria-hidden': 'true'});
  const title = h('strong', {class: 'ui-banner-title', id: `ui-banner-${seq}-title`});
  const text = h('span', {class: 'ui-banner-text'});
  const content = h('div', {class: 'ui-banner-content'}, title, text);
  const actions = h('div', {class: 'ui-banner-actions'});
  const closeButton = h('button', {type: 'button', class: 'ui-banner-close'}, glyph('x'));
  const el = h('div', {class: 'ui-banner'}, icon, content, actions, closeButton);
  closeButton.addEventListener('click', () => p.onDismiss?.());

  const renderActions = list => {
    actions.replaceChildren(...(list ?? []).map(action => {
      if (action && typeof action.nodeType === 'number') return action;
      if (action?.el && typeof action.el.nodeType === 'number') return action.el;
      const button = h('button', {type: 'button', class: 'ui-banner-action', text: action.label});
      button.dataset.variant = action.variant === 'primary' ? 'primary' : 'secondary';
      button.addEventListener('click', e => action.run?.(e));
      return button;
    }));
    actions.hidden = !actions.childNodes.length;
  };

  const apply = (next, prev = {}) => {
    if (!TONES.includes(next.tone)) throw new RangeError(`Banner: unknown tone ${JSON.stringify(next.tone)}`);
    applyCommon(el, next, prev);
    el.dataset.tone = next.tone;
    el.setAttribute('role', next.tone === 'error' ? 'alert' : 'status');
    if (next.tone !== prev.tone) icon.replaceChildren(glyph(ICON[next.tone]));
    title.textContent = next.title ?? '';
    title.hidden = !next.title;
    if (next.text !== prev.text) setContent(text, next.text);
    if (next.actions !== prev.actions) renderActions(next.actions);
    closeButton.hidden = !next.dismissible;
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
