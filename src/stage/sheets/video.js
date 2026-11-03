// The Playthrough video sheet (⋯ › Playthrough video…, the video panel's Line up…; shared/video.ts): add a YouTube
// playthrough or drum cam, line it up with the recording, and choose its sound.
//
// - Add: a YouTube link (any shape shared/video.ts parseYouTubeId reads). A link's start time (t=…) is taken as
//   where the recording starts in the video. More links add more angles (up to 8), each with its name and ✕.
// - Line it up (the angle shown): Line up automatically (Woodshed for desktop: the processor fetches the video's
//   sound, companion/video-audio.mjs, and src/js/video-align.js finds where the recording starts in it); "The
//   recording starts in the video at [m:ss.s]"; nudges −1 s · −100 ms · −10 ms · +10 ms · +100 ms · +1 s. Every
//   change shows on the video at once (video-store.js saves it a moment later).
// - Video sound (this device; 0 = muted) and Show beside the music (this device, view.video).
// A shared song shows its videos but can't change them.
//
//   export function render(container, {session, close, registry?, prefs?, desktop?, fetchAudio?}) → {el, destroy}

import '../../styles/views/stage/sheets-video.css';
import {registry as appRegistry} from '../../app/commands.js';
import {prefs as appPrefs} from '../../app/prefs.js';
import {desktop as appDesktop} from '../../app/desktop.js';
import {effect} from '../../app/store.js';
import {describeError} from '../../app/error-copy.js';
import {h} from '../../ui/h.js';
import {icon} from '../../ui/icon.js';
import {Button} from '../../ui/button.js';
import {Slider} from '../../ui/slider.js';
import {Toggle} from '../../ui/toggle.js';
import {Segmented} from '../../ui/segmented.js';
import {linkStart, parseYouTubeId, videoLabel} from '../../../shared/video.ts';
import {COPY, clockTime, parseClock} from '../video.copy.js';

export const NUDGES = Object.freeze([-1, -0.1, -0.01, 0.01, 0.1, 1]);
let seq = 0;

/** The song's audio and the video's, measured and lined up (desktop): {offset, quality} | null. */
export async function autoLineUp({session, videoId, fetchAudio, signal}) {
  const [{alignVideo, mixdown}, {onsetStrength}] = await Promise.all([import('../../js/video-align.js'), import('../../js/onsets.js')]);
  const buffers = (session?.engine?.tracks ?? []).map((t) => t?.buffer).filter(Boolean);
  if (!buffers.length) return {notReady: true};
  const bytes = await fetchAudio(videoId, {signal});
  const ctx = session.engine?.ctx ?? new OfflineAudioContext(1, 1, 16000);
  const video = await ctx.decodeAudioData(bytes.slice(0));
  return alignVideo({song: onsetStrength(mixdown(buffers, 16000)), video: onsetStrength(video)});
}

export function render(container, {session, registry = appRegistry, prefs = appPrefs, desktop = appDesktop, fetchAudio = null, search = null} = {}) {
  if (!session) throw new TypeError('video sheet: a session is required');
  const id = `sheet-video-${++seq}`;
  const offs = [], parts = [];
  const stage = () => { try { return registry.context()?.stage ?? null; } catch { return null; } };
  const store = stage()?.videos ?? null;
  const readOnly = !store || store.readOnly;
  const getAudio = fetchAudio ?? ((videoId, opts) => import('../../js/companion.js').then((m) => m.videoAudio(videoId, opts)));
  const runSearch = search ?? ((q, opts) => import('../../js/companion.js').then((m) => m.searchSources(q, {n: 6, ...opts})));
  const song = () => session.song?.peek?.() ?? {};
  let searchAbort = null;
  let lineUpAbort = null;

  const section = (key, title, ...children) => {
    const headingId = `${id}-${key}`;
    return h('section', {class: 'sheet-video-section', dataset: {section: key}, attrs: {'aria-labelledby': headingId}},
      h('h3', {class: 'sheet-video-heading', id: headingId}, title), ...children);
  };

  // ---- add a link
  const linkInput = h('input', {type: 'url', class: 'sheet-video-input selectable', id: `${id}-link`, placeholder: COPY.linkPlaceholder,
    autocomplete: 'off', spellcheck: false, attrs: {'aria-describedby': `${id}-link-error`}});
  const linkError = h('p', {class: 'sheet-video-error', id: `${id}-link-error`, role: 'alert', hidden: true});
  const addButton = Button({label: COPY.add, size: 'md', variant: 'primary', icon: 'plus', onClick: () => add()});
  parts.push(addButton);
  function add() {
    const videoId = parseYouTubeId(linkInput.value);
    const fail = (text) => { linkError.textContent = text; linkError.hidden = false; linkInput.focus(); };
    if (!videoId) { fail(COPY.notYouTube); return; }
    const start = linkStart(linkInput.value);
    if (!addVideo(videoId, {offset: start, auto: !start})) { fail(COPY.full); return; }
    linkInput.value = '';
    linkError.hidden = true;
  }
  /** Adds a video; on the desktop it then lines itself up (unless its link said where the song starts). */
  function addVideo(videoId, {offset = 0, label = '', auto = true} = {}) {
    const added = store.add({videoId, offset, label});
    if (!added) return null;
    if (auto && desktop?.available) queueMicrotask(() => void runAuto());
    return added;
  }

  // ---- find a playthrough: the desktop searches YouTube through the processor; the web opens YouTube's search
  const queryOf = () => [song().artist, song().title, 'drum playthrough'].filter((x) => String(x ?? '').trim()).join(' ');
  const findInput = h('input', {type: 'search', class: 'sheet-video-input selectable', id: `${id}-find`, autocomplete: 'off', spellcheck: false});
  const findButton = Button({label: COPY.search, size: 'md', variant: 'secondary', icon: 'search', onClick: () => void find()});
  parts.push(findButton);
  const findStatus = h('p', {class: 'sheet-video-hint', attrs: {role: 'status', 'aria-live': 'polite'}});
  const results = h('ul', {class: 'sheet-video-results', attrs: {'aria-label': COPY.results}});
  const webSearch = h('a', {class: 'sheet-video-web', target: '_blank', rel: 'noopener noreferrer'}, COPY.searchYouTube, icon('external-link', {size: 20}));
  const webHint = h('p', {class: 'sheet-video-hint'}, COPY.searchYouTubeHint);
  findInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void find(); } });
  findInput.addEventListener('input', () => { webSearch.href = youtubeSearch(findInput.value); });
  const youtubeSearch = (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
  async function find() {
    const q = findInput.value.trim();
    if (!q) return;
    searchAbort?.abort();
    const abort = searchAbort = new AbortController();
    findStatus.textContent = COPY.searching;
    results.replaceChildren();
    try {
      const answer = await runSearch(q, {signal: abort.signal});
      if (abort.signal.aborted) return;
      const found = (answer?.candidates ?? []).map((c) => ({...c, videoId: parseYouTubeId(c.url)})).filter((c) => c.videoId && !c.live);
      findStatus.textContent = found.length ? '' : COPY.noResults;
      const have = new Set((store.videos.peek() ?? []).map((v) => v.videoId));
      results.replaceChildren(...found.map((c) => {
        const meta = [c.channel, c.duration ? clockTime(c.duration).replace(/\.\d$/, '') : ''].filter(Boolean).join(' · ');
        const added = have.has(c.videoId);
        const use = Button({label: added ? COPY.added : COPY.use, size: 'sm', variant: added ? 'quiet' : 'secondary', disabled: added,
          attrs: {'aria-label': `${added ? COPY.added : COPY.use}: ${c.title}`},
          onClick: () => { if (addVideo(c.videoId, {label: ''})) { use.set({label: COPY.added, disabled: true}); } }});
        parts.push(use);
        return h('li', {class: 'sheet-video-result'},
          h('img', {src: c.thumbnail || `https://i.ytimg.com/vi/${c.videoId}/mqdefault.jpg`, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer'}),
          h('span', {class: 'sheet-video-result-text'}, h('span', {class: 'sheet-video-result-title'}, c.title), h('span', {class: 'sheet-video-hint'}, meta)),
          use.el);
      }));
    } catch (error) {
      if (abort.signal.aborted) return;
      findStatus.textContent = COPY.searchFailed(describeError(error, {context: 'add'}).sentence);
    } finally {
      if (searchAbort === abort) searchAbort = null;
    }
  }
  const findSection = section('find', COPY.find,
    h('div', {class: 'sheet-video-row', dataset: {desktop: ''}}, findInput, findButton.el), findStatus, results,
    h('div', {class: 'sheet-video-webfind', dataset: {web: ''}}, webSearch, webHint));
  findInput.setAttribute('aria-labelledby', `${id}-find`);
  linkInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  linkInput.addEventListener('input', () => { linkError.hidden = true; });
  const addLabel = h('label', {class: 'sheet-video-label', for: linkInput.id});
  const addRow = h('div', {class: 'sheet-video-add'}, addLabel, h('div', {class: 'sheet-video-row'}, linkInput, addButton.el), linkError);

  // ---- the videos (angles)
  const list = h('ul', {class: 'sheet-video-list', attrs: {'aria-label': COPY.videos}});

  // ---- line up the shown video
  const autoButton = Button({label: COPY.auto, size: 'md', variant: 'secondary', icon: 'wand-2', onClick: () => void runAuto()});
  parts.push(autoButton);
  const autoLine = h('p', {class: 'sheet-video-hint', attrs: {role: 'status', 'aria-live': 'polite'}});
  const startInput = h('input', {type: 'text', class: 'sheet-video-time tabular selectable', id: `${id}-start`, inputMode: 'decimal',
    autocomplete: 'off', spellcheck: false, attrs: {'aria-describedby': `${id}-start-hint`}});
  const startHint = h('p', {class: 'sheet-video-hint', id: `${id}-start-hint`}, COPY.startsAtHint);
  const commitStart = () => {
    const v = store.current();
    const t = parseClock(startInput.value);
    if (!v) return;
    if (t === null) { startHint.textContent = COPY.invalidTime; startInput.setAttribute('aria-invalid', 'true'); return; }
    startInput.removeAttribute('aria-invalid');
    startHint.textContent = COPY.startsAtHint;
    store.update(v.id, {offset: t});
  };
  startInput.addEventListener('change', commitStart);
  startInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitStart(); } });
  const nudges = NUDGES.map((delta) => {
    const b = Button({label: COPY.nudgeLabel(delta), size: 'sm', variant: 'secondary', className: 'sheet-video-nudge',
      attrs: {'aria-label': COPY.nudge(delta)},
      onClick: () => { const v = store.current(); if (v) store.update(v.id, {offset: v.offset + delta}); }});
    parts.push(b);
    return b.el;
  });
  const lineUp = section('lineup', COPY.lineUpHeading,
    h('div', {class: 'sheet-video-row'}, autoButton.el), autoLine,
    h('label', {class: 'sheet-video-label', for: startInput.id}, COPY.startsAt), startInput, startHint,
    h('div', {class: 'sheet-video-nudges', attrs: {role: 'group', 'aria-label': COPY.nudgeHint}}, ...nudges),
    h('p', {class: 'sheet-video-hint'}, COPY.nudgeHint));

  async function runAuto() {
    const v = store.current();
    if (!v || !desktop?.available) return;
    lineUpAbort?.abort();
    const abort = lineUpAbort = new AbortController();
    autoButton.set({busy: COPY.autoBusy, disabled: true});
    autoLine.textContent = COPY.autoBusy;
    try {
      const fit = await autoLineUp({session, videoId: v.videoId, fetchAudio: getAudio, signal: abort.signal});
      if (abort.signal.aborted) return;
      if (fit?.notReady) { autoLine.textContent = COPY.autoNotReady; return; }
      if (!fit || fit.quality === 'poor') { autoLine.textContent = COPY.autoPoor; return; }
      store.update(v.id, {offset: fit.offset});
      autoLine.textContent = (fit.quality === 'good' ? COPY.autoGood : COPY.autoCheck)(clockTime(fit.offset));
    } catch (error) {
      if (abort.signal.aborted) return;
      autoLine.textContent = COPY.autoFailed(describeError(error, {context: 'add'}).sentence);
    } finally {
      if (lineUpAbort === abort) lineUpAbort = null;
      autoButton.set({busy: false, disabled: false});
    }
  }

  // ---- this device
  const sound = Slider({label: COPY.sound, value: Number(prefs.get('video.volume')) || 0, min: 0, max: 100, step: 5,
    format: (v) => (v ? `${Math.round(v)}%` : 'Muted'), className: 'sheet-video-sound',
    onInput: (v) => prefs.set('video.volume', Math.round(v)), onChange: (v) => prefs.set('video.volume', Math.round(v))});
  const show = Toggle({label: COPY.show, size: 'md', pressed: prefs.get('video.show') !== false,
    onChange: (on) => prefs.set('video.show', !!on)});
  const dock = Segmented({label: COPY.layout, size: 'sm', className: 'sheet-video-dock', value: prefs.get('video.dock') ?? 'auto',
    options: ['auto', 'side', 'top', 'float'].map((value) => ({value, label: COPY.docks[value]})),
    onChange: (value) => prefs.set('video.dock', value)});
  const all = Toggle({label: COPY.allAngles, size: 'md', pressed: !!prefs.get('video.all'), onChange: (on) => prefs.set('video.all', !!on)});
  parts.push(sound, show, dock, all);
  const device = section('device', COPY.thisDevice,
    h('p', {class: 'sheet-video-label', attrs: {'aria-hidden': 'true'}}, COPY.layout), dock.el,
    h('p', {class: 'sheet-video-label', attrs: {'aria-hidden': 'true'}}, COPY.sound), sound.el, all.el, show.el);

  const intro = h('p', {class: 'sheet-video-intro'}, COPY.intro);
  const readOnlyNote = h('p', {class: 'sheet-video-hint'}, COPY.readOnly);
  const saveNote = h('p', {class: 'sheet-video-error', role: 'alert', hidden: true}, COPY.saveFailed);
  const root = h('div', {class: 'sheet-video', dataset: {sheetBody: 'video'}}, intro, list, findSection, addRow, lineUp, device, readOnlyNote, saveNote);
  findInput.value = queryOf();
  webSearch.href = youtubeSearch(findInput.value);
  container.append(root);

  function paint() {
    const videos = store?.videos.peek() ?? [];
    const shown = store?.angle.peek() ?? null;
    const current = videos.find((v) => v.id === shown) ?? null;
    addLabel.textContent = videos.length ? COPY.addAnother : COPY.link;
    addButton.set({label: videos.length ? COPY.addAnother : COPY.add});
    addRow.hidden = readOnly;
    findSection.hidden = readOnly;
    findSection.querySelector('h3').textContent = videos.length ? COPY.findAnother : COPY.find;
    findSection.querySelector('[data-desktop]').hidden = !desktop?.available;
    findSection.querySelector('[data-web]').hidden = !!desktop?.available;
    all.el.hidden = videos.length < 2;
    all.set({pressed: !!prefs.get('video.all')});
    dock.set({value: prefs.get('video.dock') ?? 'auto'});
    readOnlyNote.hidden = !readOnly;
    lineUp.hidden = !current || readOnly;
    device.hidden = !videos.length;
    list.hidden = !videos.length;
    list.replaceChildren(...videos.map((v, i) => {
      const name = videoLabel(v, i);
      const pick = h('input', {type: 'radio', name: `${id}-angle`, class: 'sheet-video-pick', checked: v.id === shown, attrs: {'aria-label': name}});
      pick.addEventListener('change', () => store.setAngle(v.id));
      const label = h('input', {type: 'text', class: 'sheet-video-name selectable', value: v.label, placeholder: name, maxLength: 80,
        readOnly, attrs: {'aria-label': COPY.labelOf(name)}});
      label.addEventListener('change', () => store.update(v.id, {label: label.value}));
      const remove = h('button', {type: 'button', class: 'sheet-video-remove', hidden: readOnly, attrs: {'aria-label': COPY.remove(name)}}, icon('x', {size: 20}));
      remove.addEventListener('click', () => store.remove(v.id));
      return h('li', {class: 'sheet-video-item', dataset: {videoId: v.videoId}}, pick, label, remove);
    }));
    if (current && document.activeElement !== startInput) startInput.value = clockTime(current.offset);
    const canAuto = !!desktop?.available;
    autoButton.el.hidden = !canAuto;
    if (!canAuto) autoLine.textContent = COPY.autoDesktop;
  }
  if (store) {
    offs.push(effect(() => { store.videos.value; store.angle.value; paint(); }));
    offs.push(effect(() => { saveNote.hidden = store.saving.value !== 'error'; }));
  } else paint();

  return {
    el: root,
    destroy() {
      lineUpAbort?.abort();
      searchAbort?.abort();
      for (const off of offs.splice(0)) { try { off(); } catch { /* best effort */ } }
      for (const p of parts) p.destroy?.();
      root.remove();
    },
  };
}
