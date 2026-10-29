// CoachMark (architecture §2.12, §2.19, spec §6.6): a non-blocking, anchored callout ("1 of 3 · Skip") for the first
// Stage visit. It sits at --z-coachmark (the top layer with the Popover API), takes no keys and no focus, is never
// shown while the transport plays, and goes away when the user does the thing (src/stage/coach.js calls done()).
//
//   CoachMark({anchor, title, body, step: {i, n}, onSkip, onDone, placement = 'auto', skipLabel = 'Skip', playing,
//              className, id, attrs, dataset, testid})
//     → {el, set(partial), done(), skip(), destroy(), get open, get shown}
//   body     a string, a Node, or an array of them (e.g. [h('strong', 'Space'), ' or ▶ plays from your loop.'])
//   playing  () => boolean, read inside an effect (default: store.stage.value?.playing); while it is true the mark hides
//   done()   hides it for good and calls onDone(); skip() (the Skip button) hides it and calls onSkip()

import {effect, store} from '../app/store.js';
import {h} from './h.js';
import {anchorTo} from './position.js';
import {applyCommon, hideLayer, setContent, showLayer, withDefaults} from './popover.js';
import '../styles/primitives/coachmark.css';

let coachSeq = 0;

/** An anchored coach mark. See the header. */
export function CoachMark(props = {}) {
  let p = withDefaults({placement: 'auto', skipLabel: 'Skip'}, props);
  if (!p.anchor) throw new TypeError('CoachMark: an anchor element is required');
  const seq = ++coachSeq;
  const title = h('p', {class: 'ui-coachmark-title', id: `ui-coachmark-${seq}-title`});
  const body = h('div', {class: 'ui-coachmark-body'});
  const step = h('span', {class: 'ui-coachmark-step'});
  const dot = h('span', {class: 'ui-coachmark-dot', 'aria-hidden': 'true'}, '·');
  const skipButton = h('button', {type: 'button', class: 'ui-coachmark-skip'});
  const foot = h('div', {class: 'ui-coachmark-foot'}, step, dot, skipButton);
  const el = h('div', {class: 'ui-coachmark', role: 'status', 'aria-labelledby': title.id}, title, body, foot);

  let open = true;
  let shown = false;
  let positioner = null;

  const show = () => {
    if (shown || !open) return;
    shown = true;
    showLayer(el, 'coachmark');
    positioner = anchorTo(el, p.anchor, {placement: p.placement});
  };
  const hide = () => {
    if (!shown) return;
    shown = false;
    positioner?.destroy();
    positioner = null;
    hideLayer(el);
  };

  const apply = (next, prev = {}) => {
    applyCommon(el, next, prev);
    title.textContent = next.title ?? '';
    title.hidden = !next.title;
    if (next.body !== prev.body) setContent(body, next.body);
    const s = next.step;
    step.textContent = s && s.n > 1 ? `${s.i} of ${s.n}` : '';
    step.hidden = !step.textContent;
    skipButton.textContent = next.skipLabel;
    skipButton.hidden = !next.onSkip;
    dot.hidden = step.hidden || skipButton.hidden;
    foot.hidden = step.hidden && skipButton.hidden;
  };

  const finish = callback => {
    if (!open) return;
    open = false;
    stopWatching();
    hide();
    callback?.();
  };

  apply(p);
  skipButton.addEventListener('click', () => finish(p.onSkip));
  const isPlaying = () => (typeof p.playing === 'function' ? !!p.playing() : !!store.stage.value?.playing);
  // The effect tracks the signals the current `playing` reads; set({playing}) re-creates it for the new source.
  let stopEffect = null;
  const watch = () => {
    stopEffect?.();
    stopEffect = effect(() => {
      if (isPlaying()) hide(); else show();
    });
  };
  const stopWatching = () => { stopEffect?.(); stopEffect = null; };
  watch();

  return {
    el,
    get open() { return open; },
    get shown() { return shown; },
    set(partial = {}) {
      if (!open) return;
      const prev = p;
      p = {...p, ...partial};
      apply(p, prev);
      if (p.playing !== prev.playing) watch();
      if (shown && (p.anchor !== prev.anchor || p.placement !== prev.placement)) {
        positioner?.destroy();
        positioner = anchorTo(el, p.anchor, {placement: p.placement});
      } else {
        positioner?.update();
      }
    },
    done() { finish(p.onDone); },
    skip() { finish(p.onSkip); },
    destroy() { finish(null); },
  };
}
