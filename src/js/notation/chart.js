// Rehearsal chart: the drum part engraved like Guitar Pro / Songsterr, read
// while playing along. Follows playback, highlights the playing bar, seeks on
// tap, loops bars by dragging and loops whole sections in one tap. Works the
// same on a laptop and an iPad in portrait.
import {number, musicalStarts, toTime, toQuarter} from '../../../shared/notation.ts';
import {createScoreView} from './score-view.js';
import {xml} from './html.js';
import './chart.css';

const store = {
  get(key, fallback) { try { const value = localStorage.getItem(key); return value == null ? fallback : JSON.parse(value); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
};
const SCALES = [.8, .9, 1, 1.1, 1.25, 1.4, 1.6, 1.8];
// Two dense bars per line on a portrait tablet; three on a laptop.
const defaultScale = () => (window.innerWidth || 1200) < 1000 ? .9 : 1.1;

/**
 * @param options.part shared drum part (part.js)
 * @param options.setLoop (startSeconds, endSeconds) enable a loop and update the transport
 * @param options.clearLoop () disable the loop
 * @param options.onEmpty {transcribe(), importFile()} actions offered when there is no chart
 */
export function createChart({host, part, engine, setLoop, clearLoop, onMixerChange = () => {}, onEmpty = {}}) {
  let scale = store.get('ws.chart.scale', defaultScale());
  let layoutOverride = store.get('ws.chart.layout', null);
  let pendingLoop = null, follow = true, visible = false, view = null, lastQ = null, lastLoop = '', lastSystem = null, programmaticScroll = -Infinity, renderedScore = null, renderedLayout = null;
  host.classList.add('chart');
  host.innerHTML = `<div class="chart-bar" role="toolbar" aria-label="Chart">
      <div class="chart-sections" aria-label="Sections"></div>
      <div class="chart-tools">
        <button type="button" data-chart="loop-section" title="Loop the section that is playing">Loop section</button>
        <button type="button" data-chart="follow" aria-pressed="true" title="Keep the playing bar in view">Follow</button>
        <div class="chart-zoom" role="group" aria-label="Notation size"><button type="button" data-chart="smaller" aria-label="Smaller notation">−</button><span class="chart-scale"></span><button type="button" data-chart="larger" aria-label="Larger notation">+</button></div>
        <div class="chart-layout" role="group" aria-label="Note layout"><button type="button" data-layout="combined" title="One rhythm for the whole kit, like Guitar Pro and Songsterr">Together</button><button type="button" data-layout="split" title="Hands stems up, feet stems down">Hands / feet</button></div>
        <button type="button" data-chart="mute-drums" aria-pressed="false" title="Mute the recorded drum stem and play along">Mute drums</button>
      </div>
    </div>
    <div class="chart-scroll" tabindex="-1"><div class="chart-score"></div></div>
    <div class="chart-empty" hidden></div>
    <div class="chart-notice" role="status" hidden><p></p><button type="button" data-chart="dismiss" aria-label="Dismiss">✕</button></div>
    <p class="chart-hint" role="status"></p>`;
  const sections = host.querySelector('.chart-sections'), scroller = host.querySelector('.chart-scroll'), empty = host.querySelector('.chart-empty'), hint = host.querySelector('.chart-hint');
  const timeline = () => part.score?.timeline;
  const starts = () => musicalStarts(timeline());
  const barTime = index => toTime(timeline(), number(starts()[index]));
  const barEndTime = index => toTime(timeline(), number(starts()[index]) + number(timeline().measures[index].length));
  const layout = () => layoutOverride || part.score?.layout || 'combined';
  const drumTrack = () => engine.tracks?.find(t => t.name === 'drums');
  const say = text => { hint.textContent = text; clearTimeout(say.timer); say.timer = setTimeout(() => { hint.textContent = ''; }, 3200); };

  function sectionList() {
    const t = timeline();
    if (!t) return [];
    const list = [];
    t.measures.forEach((m, i) => { if (m.label) list.push({index: i, label: m.label}); });
    if (!list.length || list[0].index !== 0) list.unshift({index: 0, label: list.length ? 'Start' : 'Bar 1'});
    const seen = new Map();
    return list.map((s, k) => { const n = (seen.get(s.label) || 0) + 1; seen.set(s.label, n); return {...s, label: n > 1 ? `${s.label} ${n}` : s.label, end: (list[k + 1]?.index ?? t.measures.length) - 1}; });
  }
  function currentSection(q) { const t = timeline(); if (!t) return null; const index = view?.barAt(q) ?? 0; return sectionList().filter(s => s.index <= index).at(-1) ?? null; }

  function paintTools() {
    host.querySelector('[data-chart="follow"]').setAttribute('aria-pressed', String(follow));
    host.querySelector('.chart-scale').textContent = `${Math.round(scale * 100)}%`;
    for (const b of host.querySelectorAll('[data-layout]')) b.setAttribute('aria-pressed', String(b.dataset.layout === layout()));
    const drums = drumTrack(), mute = host.querySelector('[data-chart="mute-drums"]');
    mute.hidden = !drums;
    if (drums) { mute.setAttribute('aria-pressed', String(!!drums.muted)); mute.textContent = drums.muted ? 'Drums muted' : 'Mute drums'; }
    const list = sectionList(), q = lastQ ?? 0, active = currentSection(q);
    sections.innerHTML = list.map(s => `<button type="button" data-section="${s.index}" aria-current="${active?.index === s.index ? 'true' : 'false'}" title="Bars ${s.index + 1}–${s.end + 1}">${xml(s.label)}</button>`).join('');
  }

  function showEmpty() {
    const readOnly = part.readOnly;
    empty.hidden = false;
    scroller.hidden = true;
    host.querySelector('.chart-bar').hidden = true;
    empty.innerHTML = readOnly ? '<h2>No drum chart shared</h2><p>The person who shared this song hasn’t included drum notation.</p>'
      : `<h2>No drum chart yet</h2><p>Import a Guitar Pro, MIDI or Clone Hero chart from <strong>Tempo map → Import</strong>, or write the part in Transcribe. The chart follows the recording as you practice.</p><div class="chart-empty-actions">${onEmpty.importFile ? '<button type="button" class="btn-primary" data-chart="import">Import a file…</button>' : ''}${onEmpty.transcribe ? '<button type="button" data-chart="transcribe">Open Transcribe</button>' : ''}</div>`;
  }

  function render() {
    if (!visible) return;
    if (!part.score || !part.hasNotation) { view?.destroy(); view = null; renderedScore = null; showEmpty(); return; }
    empty.hidden = true; scroller.hidden = false; host.querySelector('.chart-bar').hidden = false;
    paintTools();
    if (!view) view = createScoreView(host.querySelector('.chart-score'), {scale, onRender: () => { lastSystem = null; sync(true); }, onPointer: pointer});
    if (renderedScore !== part.score || renderedLayout !== layout()) { renderedScore = part.score; renderedLayout = layout(); view.setScore(part.score, {layout: layout()}); }
  }

  // Keep the playing system in the upper third; never fight a reader who scrolls.
  function scrollToBar(index, smooth = true, attempt = 0) {
    const bounds = view?.barBounds(index);
    if (!bounds) return;
    const target = Math.max(0, bounds.y - scroller.clientHeight * .22);
    if (Math.abs(scroller.scrollTop - target) < 4) return;
    // alphaTab sizes its surface after layout; wait until the bar is reachable.
    if (scroller.scrollHeight - scroller.clientHeight < target - 1 && attempt < 30) { requestAnimationFrame(() => scrollToBar(index, smooth, attempt + 1)); return; }
    programmaticScroll = performance.now();
    scroller.scrollTo({top: target, behavior: smooth ? 'smooth' : 'auto'});
  }
  const stopFollowing = () => { if (performance.now() - programmaticScroll < 900) return; if (follow && engine.playing) { follow = false; paintTools(); } };
  scroller.addEventListener('wheel', stopFollowing, {passive: true});
  scroller.addEventListener('touchmove', stopFollowing, {passive: true});

  function sync(force = false) {
    if (!view?.ready || !part.score) return;
    const time = engine.getPosition(), q = toQuarter(timeline(), time);
    if (force || q !== lastQ) {
      lastQ = q;
      view.setPlayhead(q);
      const index = view.barAt(q), bounds = view.barBounds(index);
      if (follow && bounds && (force || bounds.y !== lastSystem)) { scrollToBar(index, !force); lastSystem = bounds.y; }
      const active = currentSection(q);
      for (const b of sections.querySelectorAll('[data-section]')) {
        const on = Number(b.dataset.section) === active?.index;
        if ((b.getAttribute('aria-current') === 'true') !== on) { b.setAttribute('aria-current', String(on)); if (on) b.scrollIntoView({block: 'nearest', inline: 'nearest'}); }
      }
    }
    const loop = engine.loop, key = loop.enabled ? `${loop.a}:${loop.b}` : '';
    if (force || key !== lastLoop) { lastLoop = key; view.setLoop(loop.enabled ? [toQuarter(timeline(), loop.a), toQuarter(timeline(), loop.b)] : null); }
  }

  // Tap a bar to play from its nearest beat; drag across bars to loop them.
  // On touch, a long press starts the loop drag so scrolling stays natural.
  let gesture = null;
  function pointer({kind, event, at}) {
    if (kind === 'down') {
      if (event.button !== 0 || at.index == null) return;
      gesture = {id: event.pointerId, start: at, x: event.clientX, y: event.clientY, dragging: false, touch: event.pointerType !== 'mouse', armed: event.pointerType === 'mouse'};
      if (gesture.touch) gesture.timer = setTimeout(() => { if (gesture) { gesture.armed = true; gesture.dragging = true; navigator.vibrate?.(10); view.setRange([at.index, at.index]); say('Drag across bars to loop them'); } }, 380);
      return;
    }
    if (!gesture || event.pointerId !== gesture.id) return;
    if (kind === 'move') {
      const distance = Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y);
      if (!gesture.armed) { if (distance > 8) { clearTimeout(gesture.timer); gesture = null; } return; }
      if (distance > 6 && !gesture.dragging) gesture.dragging = true;
      if (gesture.dragging && at.index != null) {
        event.preventDefault();
        view.setRange([Math.min(gesture.start.index, at.index), Math.max(gesture.start.index, at.index)]);
        gesture.end = at;
      }
      return;
    }
    clearTimeout(gesture.timer);
    const g = gesture; gesture = null;
    if (kind === 'cancel') { if (g.dragging) view.setRange(pendingLoop == null ? null : [pendingLoop, pendingLoop]); return; }
    // Touch: long-press marks the first bar; the next tap marks the last.
    if (g.touch && g.armed && !g.end) { pendingLoop = g.start.index; view.setRange([pendingLoop, pendingLoop]); say('Tap the last bar to loop'); return; }
    if (pendingLoop != null && kind === 'up' && !g.dragging) {
      const a = Math.min(pendingLoop, g.start.index), b = Math.max(pendingLoop, g.start.index);
      pendingLoop = null;
      g.dragging = true; g.start = {index: a}; g.end = {index: b};
    }
    if (g.dragging) {
      const end = g.end ?? g.start, a = Math.min(g.start.index, end.index), b = Math.max(g.start.index, end.index);
      view.setRange(null);
      setLoop(barTime(a), barEndTime(b));
      engine.seek(barTime(a));
      say(a === b ? `Looping bar ${a + 1}` : `Looping bars ${a + 1}–${b + 1}`);
      follow = true; paintTools(); sync(true);
      return;
    }
    if (kind !== 'up') return;
    const q = g.start.beatQ != null && Math.abs(g.start.beatQ - g.start.q) < 1 ? g.start.beatQ : number(starts()[g.start.index]);
    engine.seek(toTime(timeline(), q));
    follow = true; paintTools(); sync(true);
  }
  host.querySelector('.chart-score').addEventListener('contextmenu', e => { if (gesture?.touch) e.preventDefault(); });

  host.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || !host.contains(button)) return;
    if (button.dataset.section) {
      const index = Number(button.dataset.section);
      engine.seek(barTime(index)); follow = true; scrollToBar(index); sync(true); paintTools();
      return;
    }
    if (button.dataset.layout) { layoutOverride = button.dataset.layout === (part.score?.layout || 'combined') ? null : button.dataset.layout; store.set('ws.chart.layout', layoutOverride); render(); return; }
    switch (button.dataset.chart) {
      case 'follow': follow = !follow; paintTools(); if (follow) sync(true); break;
      case 'smaller': case 'larger': {
        const i = SCALES.findIndex(s => s >= scale - 1e-6), next = SCALES[Math.max(0, Math.min(SCALES.length - 1, (i < 0 ? SCALES.length - 1 : i) + (button.dataset.chart === 'larger' ? 1 : -1)))];
        scale = next; store.set('ws.chart.scale', scale); paintTools(); view?.setScale(scale); break;
      }
      case 'loop-section': {
        const section = currentSection(lastQ ?? 0);
        if (!section) break;
        if (engine.loop.enabled && Math.abs(engine.loop.a - barTime(section.index)) < 1e-3 && Math.abs(engine.loop.b - barEndTime(section.end)) < 1e-3) { clearLoop(); say('Loop off'); break; }
        setLoop(barTime(section.index), barEndTime(section.end));
        if (!engine.playing) engine.seek(barTime(section.index));
        say(`Looping ${section.label}`); sync(true); break;
      }
      case 'mute-drums': { if (drumTrack()) { engine.toggleMute('drums'); onMixerChange(); paintTools(); } break; }
      case 'dismiss': host.querySelector('.chart-notice').hidden = true; break;
      case 'import': onEmpty.importFile?.(); break;
      case 'transcribe': onEmpty.transcribe?.(); break;
    }
  });

  const unsubscribe = part.subscribe(() => { if (visible) render(); });
  const onTheme = () => { if (view) { renderedScore = null; render(); } };
  window.addEventListener('woodshed:theme', onTheme);

  return {
    host,
    setVisible(next) { visible = next; host.hidden = !next; if (next) { render(); requestAnimationFrame(() => sync(true)); } },
    tick() { if (visible) sync(); },
    refresh() { renderedScore = null; render(); },
    notice(text) { const box = host.querySelector('.chart-notice'); box.querySelector('p').textContent = text; box.hidden = !text; },
    destroy() { unsubscribe(); window.removeEventListener('woodshed:theme', onTheme); view?.destroy(); host.remove(); },
  };
}
