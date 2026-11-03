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
import {linkStart, parseYouTubeId, videoLabel} from '../../../shared/video.ts';
import {COPY, clockTime, parseClock} from '../video.copy.js';

export const NUDGES = Object.freeze([-1, -0.1, -0.01, 0.01, 0.1, 1]);
let seq = 0;

/** The song's audio and the video's, measured and lined up (desktop): {offset, quality} | null. */
export async function autoLineUp({session, videoId, fetchAudio, signal}) {
  const [{alignVideo, mixdown}, {onsetStrength}] = await Promise.all([import('../../js/video-align.js'), import('../../js/onsets.js')]);
  const buffers = (session?.engine?.tracks ?? []).map((t) => t?.buffer).filter(Boolean);
  if (!buffers.length) return null;
  const bytes = await fetchAudio(videoId, {signal});
  const ctx = session.engine?.ctx ?? new OfflineAudioContext(1, 1, 16000);
  const video = await ctx.decodeAudioData(bytes.slice(0));
  return alignVideo({song: onsetStrength(mixdown(buffers, 16000)), video: onsetStrength(video)});
}

export function render(container, {session, registry = appRegistry, prefs = appPrefs, desktop = appDesktop, fetchAudio = null} = {}) {
  if (!session) throw new TypeError('video sheet: a session is required');
  const id = `sheet-video-${++seq}`;
  const offs = [], parts = [];
  const stage = () => { try { return registry.context()?.stage ?? null; } catch { return null; } };
  const store = stage()?.videos ?? null;
  const readOnly = !store || store.readOnly;
  const getAudio = fetchAudio ?? ((videoId, opts) => import('../../js/companion.js').then((m) => m.videoAudio(videoId, opts)));
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
    const added = store.add({videoId, offset: linkStart(linkInput.value)});
    if (!added) { fail(COPY.full); return; }
    linkInput.value = '';
    linkError.hidden = true;
  }
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
  parts.push(sound, show);
  const device = h('section', {class: 'sheet-video-section', dataset: {section: 'device'}},
    h('p', {class: 'sheet-video-label', attrs: {'aria-hidden': 'true'}}, COPY.sound), sound.el, show.el);

  const intro = h('p', {class: 'sheet-video-intro'}, COPY.intro);
  const readOnlyNote = h('p', {class: 'sheet-video-hint'}, COPY.readOnly);
  const saveNote = h('p', {class: 'sheet-video-error', role: 'alert', hidden: true}, COPY.saveFailed);
  const root = h('div', {class: 'sheet-video', dataset: {sheetBody: 'video'}}, intro, list, addRow, lineUp, device, readOnlyNote, saveNote);
  container.append(root);

  function paint() {
    const videos = store?.videos.peek() ?? [];
    const shown = store?.angle.peek() ?? null;
    const current = videos.find((v) => v.id === shown) ?? null;
    addLabel.textContent = videos.length ? COPY.addAnother : COPY.link;
    addButton.set({label: videos.length ? COPY.addAnother : COPY.add});
    addRow.hidden = readOnly;
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
      for (const off of offs.splice(0)) { try { off(); } catch { /* best effort */ } }
      for (const p of parts) p.destroy?.();
      root.remove();
    },
  };
}
