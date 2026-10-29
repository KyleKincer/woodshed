// The Share dialog (architecture §2.18, spec §6.1).
//
//   openShareDialog({song, session}, deps?) → Promise<void>      resolves when the dialog closes
//     song      {id, title, hasChart?}: the Stage's session song, or a Library row
//     session   the Stage's Session (flushed, final, before a link is created or changed), or null
//               (the Library card menu)
//     deps      {sharing, feedback, store, clipboard, env, location}: replaced in tests
//   shareOrigin({env, location}) → string   VITE_SHARE_ORIGIN (no trailing slash), else location.origin;
//                                             desktop builds must set VITE_SHARE_ORIGIN
//   shareUrl(token, {env, location}?) → `${shareOrigin()}/share/${token}`
//   COPIED_MS                                how long Copy link reads "Copied ✓"
//
// The dialog (480 px), "Share <title>":
//   - the body line, then two choices: ☑ Sections and tempo map, ☐ Drum chart (disabled, with a
//     note, when the song has no chart). They are what the next Create link sends; while a link is
//     active a change updates that link at once (sharing.create reuses the active link) and is
//     reverted if the update fails.
//   - no link: [Create link] → the read-only link field plus [Copy link] ("Copied ✓" for 2 s; a
//     clipboard failure selects the field and says so), the note "A new link replaces the old one."
//     and Stop sharing (quiet danger) → "Stop sharing? The link stops working for everyone."
//   - one inline status line (errors through describeError, context 'share'); [Done] closes.
//   - an export-only account (D10) cannot create a link or change its choices: Create link and the
//     choices are disabled and the status line says why; an active link can still be copied or stopped.
// Focus starts on Done, moves to Create link / Copy link once the link state is known (only when it
// is still on Done), to Copy link after Create, and to Create link after Stop sharing.

import '../styles/views/share/share-dialog.css';
import * as appSharing from '../api/sharing.js';
import * as appFeedback from '../app/feedback.js';
import {describeError} from '../app/error-copy.js';
import {store as appStore} from '../app/store.js';
import {Button} from '../ui/button.js';
import {Dialog} from '../ui/dialog.js';
import {h} from '../ui/h.js';
import {InlineStatus} from '../ui/status.js';
import {COPY} from './share.copy.js';

export const COPIED_MS = 2000;

let dialogSeq = 0;

/** The origin share links point at: VITE_SHARE_ORIGIN when set (desktop builds), else this page's origin. */
export function shareOrigin({env = import.meta.env, location = globalThis.location} = {}) {
  const configured = typeof env?.VITE_SHARE_ORIGIN === 'string' ? env.VITE_SHARE_ORIGIN.trim() : '';
  return (configured || location?.origin || '').replace(/\/+$/, '');
}

/** The public URL of a share token. */
export function shareUrl(token, opts) {
  return `${shareOrigin(opts)}/share/${token}`;
}

const sentence = (err) => describeError(err, {context: 'share'}).sentence;

/** Opens the Share dialog for `song`. See the header. */
export async function openShareDialog({song, session = null} = {}, deps = {}) {
  const id = song?.id;
  if (!id) return;
  const sharing = deps.sharing ?? appSharing;
  const feedback = deps.feedback ?? appFeedback;
  const exportOnly = (deps.store ?? appStore)?.session?.peek?.()?.status === 'export_only';
  const clipboard = 'clipboard' in deps ? deps.clipboard : globalThis.navigator?.clipboard;
  const urlOpts = {env: deps.env ?? import.meta.env, location: deps.location ?? globalThis.location};
  const hasChart = !!song.hasChart;
  const seq = ++dialogSeq;
  const ids = {map: `share-${seq}-map`, chart: `share-${seq}-chart`, chartNote: `share-${seq}-chart-note`, link: `share-${seq}-link`};

  const state = {phase: 'loading', token: null, busy: false};
  let copiedTimer = null;
  let closed = false;

  // ---------------- the choices
  // Native checkboxes; the whole label row (40 px, 48 on touch) is the hit target, so the 20 px box itself is
  // exempt from the target-size probe.
  const mapBox = h('input', {type: 'checkbox', id: ids.map, class: 'share-check-input', checked: true, attrs: {'data-target-exempt': true}});
  const chartBox = h('input', {
    type: 'checkbox', id: ids.chart, class: 'share-check-input', checked: false, disabled: !hasChart,
    'aria-describedby': hasChart ? undefined : ids.chartNote, attrs: {'data-target-exempt': true},
  });
  const choices = h('fieldset', {class: 'share-choices'},
    h('legend', {class: 'sr-only'}, COPY.includes),
    h('label', {class: 'share-check', for: ids.map}, mapBox, h('span', {class: 'share-check-text'}, COPY.includeMap)),
    h('label', {class: 'share-check', for: ids.chart, dataset: {disabled: hasChart ? null : ''}},
      chartBox, h('span', {class: 'share-check-text'}, COPY.includeChart)),
    hasChart ? null : h('p', {class: 'share-note share-check-note', id: ids.chartNote}, COPY.noChart));

  const choiceArgs = () => ({includeMap: mapBox.checked, includeNotation: hasChart && chartBox.checked});

  // ---------------- the link
  const createButton = Button({label: COPY.create, variant: 'primary', className: 'share-create', onClick: () => void createLink()});
  const linkInput = h('input', {type: 'url', id: ids.link, class: 'share-link-input', readOnly: true, value: '', spellcheck: false,
    attrs: {autocomplete: 'off'}});
  linkInput.addEventListener('focus', () => linkInput.select());
  const copyButton = Button({label: COPY.copy, variant: 'primary', icon: 'copy', className: 'share-copy', onClick: () => void copyLink()});
  const stopButton = Button({label: COPY.stop, variant: 'quiet', tone: 'danger', className: 'share-stop', onClick: () => void stopSharing()});
  const linkBox = h('div', {class: 'share-link', hidden: true},
    h('label', {class: 'share-link-label', for: ids.link}, COPY.linkLabel),
    h('div', {class: 'share-link-row'}, linkInput, copyButton.el),
    h('p', {class: 'share-note'}, COPY.replaces),
    h('div', {class: 'share-stop-row'}, stopButton.el));
  const createBox = h('div', {class: 'share-create-row'}, createButton.el);

  const status = InlineStatus({tone: 'info', text: '', className: 'share-status'});
  const setStatus = (tone, text) => {
    status.el.classList.toggle('sr-only', !text);
    status.el.toggleAttribute('data-empty', !text);
    status.set({tone, text: text ?? ''});
  };
  setStatus('info', COPY.checking);

  const root = h('div', {class: 'share-dialog-body', dataset: {phase: 'loading'}},
    h('p', {class: 'share-lead'}, COPY.body),
    choices, createBox, linkBox, status.el);

  // ---------------- painting
  function paint() {
    root.dataset.phase = state.phase;
    const active = state.phase === 'active';
    linkBox.hidden = !active;
    createBox.hidden = active;
    linkInput.value = active ? shareUrl(state.token, urlOpts) : '';
    createButton.set({disabled: state.busy || exportOnly || state.phase === 'loading', busy: state.busy && !active ? COPY.creating : false});
    copyButton.set({disabled: state.busy});
    stopButton.set({disabled: state.busy});
    mapBox.disabled = state.busy || exportOnly;
    chartBox.disabled = state.busy || exportOnly || !hasChart;
  }

  const dialog = Dialog({
    title: COPY.title(song.title || COPY.untitled),
    body: root,
    className: 'share-dialog',
    width: 480,
    actions: [{label: COPY.done, value: true, variant: 'secondary'}],
  });
  const doneButton = () => dialog.el.querySelector('.ui-dialog-actions .ui-dialog-action');
  const inDialog = () => dialog.el.contains(dialog.el.ownerDocument.activeElement);
  paint();

  async function run(fn) {
    if (state.busy || closed) return;
    state.busy = true;
    paint();
    try {
      await fn();
    } catch (err) {
      if (!closed) setStatus('error', sentence(err));
    } finally {
      state.busy = false;
      if (!closed) paint();
    }
  }

  function showLink(token) {
    state.token = token;
    state.phase = token ? 'active' : 'none';
  }

  async function createLink() {
    await run(async () => {
      setStatus('info', COPY.creating);
      await session?.flush?.({final: true});
      const {token} = await sharing.create({id, ...choiceArgs()});
      if (closed) return;
      showLink(token);
      setStatus('info', '');
    });
    if (!closed && state.phase === 'active') copyButton.el.focus();
  }

  async function copyLink() {
    if (!state.token || closed) return;
    const url = shareUrl(state.token, urlOpts);
    try {
      if (typeof clipboard?.writeText !== 'function') throw new Error('no clipboard');
      await clipboard.writeText(url);
      if (closed) return;
      clearTimeout(copiedTimer);
      copyButton.set({label: COPY.copied, icon: null});   // the label carries the ✓
      feedback.announce?.(COPY.copiedAnnounce);
      setStatus('info', '');
      copiedTimer = setTimeout(() => { if (!closed) copyButton.set({label: COPY.copy, icon: 'copy'}); }, COPIED_MS);
    } catch {
      if (closed) return;
      setStatus('warn', COPY.copyFailed);
      linkInput.focus();
      linkInput.select();
    }
  }

  async function stopSharing() {
    if (state.busy || closed) return;
    const ok = await feedback.confirm({title: COPY.stopTitle, body: COPY.stopBody, confirmLabel: COPY.stopConfirm, danger: true});
    if (!ok || closed) return;
    await run(async () => {
      await sharing.revoke({id});
      if (closed) return;
      clearTimeout(copiedTimer);
      copyButton.set({label: COPY.copy, icon: 'copy'});
      showLink(null);
      setStatus('info', COPY.stopped);
    });
    if (!closed && state.phase === 'none') createButton.el.focus();
  }

  /** A choice changed: while a link is active, update it (reverting the box when that fails). */
  function onChoice(box) {
    if (state.phase !== 'active') return;
    const wanted = box.checked;
    void run(async () => {
      try {
        await session?.flush?.({final: true});
        const {token} = await sharing.create({id, ...choiceArgs()});
        if (closed) return;
        showLink(token);
        setStatus('info', COPY.updated);
      } catch (err) {
        box.checked = !wanted;
        throw err;
      }
    });
  }
  mapBox.addEventListener('change', () => onChoice(mapBox));
  chartBox.addEventListener('change', () => onChoice(chartBox));

  // ---------------- the link state
  void (async () => {
    let current = null;
    try {
      current = await sharing.status({id});
    } catch (err) {
      if (closed) return;
      showLink(null);
      paint();
      setStatus('error', sentence(err));
      return;
    }
    if (closed) return;
    showLink(current?.token ?? null);
    if (current) {
      mapBox.checked = current.includeMap !== false;
      chartBox.checked = hasChart && current.includeNotation !== false;
    }
    if (exportOnly) setStatus('warn', COPY.exportOnly);
    else setStatus('info', '');
    paint();
    const stillOnDone = !inDialog() || dialog.el.ownerDocument.activeElement === doneButton();
    if (stillOnDone) (state.phase === 'active' ? copyButton.el : createButton.el).focus({preventScroll: true});
  })();

  try {
    await dialog.closed;
  } finally {
    closed = true;
    clearTimeout(copiedTimer);
    for (const b of [createButton, copyButton, stopButton]) b.destroy();
    status.destroy();
  }
}
