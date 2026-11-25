// Edit · Chart's section navigator: the whole song as one strip under the toolbar, a segment per section, each as
// wide as its share of the bars. It is how you get around a long chart without scrolling: click a section to go to
// its first bar (the sheet scrolls it to the top; while the song is stopped the cue goes there too, so Play starts
// from it). Three marks sit on the strip: the part of the song now on screen, the edit cursor's bar and the
// playhead.
//
//   createNavigator({run}) → {el, update(state), setViewport(bars), setPlayhead(position), destroy()}
//     run(action, ...args)    the workspace's run: 'goToBar' (bar, {seek: true})
//     update(state)           state.sections [{id, label, bar, bars}], state.total, state.cursorBar, state.section
//     setViewport(bars)       {first, last} (the bars on screen) or null (Lanes, nothing engraved yet)
//     setPlayhead(position)   bars from the start of the song (fractional), or null
//
// A song with no section names is one segment, "Bars 1–64". Segments keep a minimum width so a two-bar section
// can still be hit, which bends the strip's scale; the marks are placed inside the segment of their bar, so they
// stay true whatever the widths. On a phone the strip is wider than the screen and scrolls sideways (chart.css);
// the section the cursor is in is kept in view.

import {h} from '../../ui/h.js';
import {COPY} from './menus.js';

export function createNavigator({run} = {}) {
  const track = h('div', {class: 'chart-nav-track'});
  const windowMark = h('div', {class: 'chart-nav-window', 'aria-hidden': 'true', hidden: true});
  const cursorMark = h('div', {class: 'chart-nav-cursor', 'aria-hidden': 'true', hidden: true});
  const nowMark = h('div', {class: 'chart-nav-now', 'aria-hidden': 'true', hidden: true});
  const el = h('nav', {class: 'chart-nav', 'aria-label': COPY.sections}, track, windowMark, cursorMark, nowMark);

  let sections = [], total = 0, key = '', cursorBar = 0, current = -1;
  let viewport = null, playhead = null;
  let buttons = [];

  const onClick = e => {
    const button = e.target.closest?.('.chart-nav-section');
    if (!button || !el.contains(button)) return;
    run?.('goToBar', Number(button.dataset.bar), {seek: true});
  };
  el.addEventListener('click', onClick);

  /** The x of a position in bars (fractional), inside the segment that holds it. */
  function xOf(position) {
    if (!sections.length || !total) return null;
    const p = Math.max(0, Math.min(total, position));
    let k = sections.length - 1;
    while (k > 0 && sections[k].bar > p) k--;
    const button = buttons[k], sec = sections[k];
    if (!button) return null;
    return button.offsetLeft + Math.max(0, Math.min(1, (p - sec.bar) / Math.max(1, sec.bars))) * button.offsetWidth;
  }

  function place() {
    const a = viewport ? xOf(viewport.first) : null, b = viewport ? xOf(viewport.last + 1) : null;
    // The whole song on screen needs no window.
    const whole = !!viewport && viewport.first <= 0 && viewport.last >= total - 1;
    windowMark.hidden = a == null || b == null || whole;
    if (!windowMark.hidden) { windowMark.style.left = `${a}px`; windowMark.style.width = `${Math.max(4, b - a)}px`; }
    const c = xOf(cursorBar);
    cursorMark.hidden = c == null;
    if (c != null) cursorMark.style.left = `${c}px`;
    const n = playhead == null ? null : xOf(playhead);
    nowMark.hidden = n == null;
    if (n != null) nowMark.style.left = `${n}px`;
  }

  function build() {
    buttons = sections.map((sec, k) => {
      const first = sec.bar + 1, last = sec.bar + sec.bars;
      const name = sec.label || (sections.length === 1 ? COPY.allBars(total) : COPY.start);
      const button = h('button', {
        type: 'button', class: 'chart-nav-section', dataset: {bar: sec.bar, index: k},
        'aria-label': COPY.sectionName(name, first, last), title: `${name} · ${COPY.bars(first, last)}`,
        style: {flexGrow: String(sec.bars)},
      }, h('span', {class: 'chart-nav-name'}, name),
      // A named section shows the bar it starts on; "Bars 1–64" already says it.
      sec.label || sections.length > 1 ? h('span', {class: 'chart-nav-bar'}, String(first)) : null);
      return button;
    });
    track.replaceChildren(...buttons);
    current = -1;
  }

  // The strip's width changes with the window: the marks follow.
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => place()) : null;
  resize?.observe(el);

  return {
    el,
    update(state) {
      if (!state) return;
      const next = state.sections ?? [];
      const nextKey = `${state.total}|${next.map(s => `${s.bar}:${s.bars}:${s.label}`).join('|')}`;
      sections = next;
      total = state.total ?? 0;
      el.hidden = !total;
      if (nextKey !== key) { key = nextKey; build(); }
      cursorBar = state.cursorBar ?? 0;
      const now = state.section ?? 0;
      if (now !== current) {
        buttons[current]?.removeAttribute('aria-current');
        buttons[now]?.setAttribute('aria-current', 'true');
        current = now;
        // A strip that scrolls sideways (a phone) keeps the cursor's section in view.
        const b = buttons[now];
        if (b && el.scrollWidth > el.clientWidth + 1) {
          if (b.offsetLeft < el.scrollLeft) el.scrollLeft = Math.max(0, b.offsetLeft - 12);
          else if (b.offsetLeft + b.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = b.offsetLeft + b.offsetWidth - el.clientWidth + 12;
        }
      }
      place();
    },
    setViewport(bars) {
      const next = bars && Number.isInteger(bars.first) && Number.isInteger(bars.last) ? {first: bars.first, last: bars.last} : null;
      if (next?.first === viewport?.first && next?.last === viewport?.last) return;
      viewport = next;
      place();
    },
    setPlayhead(position) {
      const next = Number.isFinite(position) ? position : null;
      if (next === playhead) return;
      playhead = next;
      const n = playhead == null ? null : xOf(playhead);
      nowMark.hidden = n == null;
      if (n != null) nowMark.style.left = `${n}px`;
    },
    destroy() {
      resize?.disconnect();
      el.removeEventListener('click', onClick);
      el.remove();
    },
  };
}
