// "Is this the right recording?" (D43, spec §3.5): a one-time banner in the Stage's status area for
// a song added from a search that nobody confirmed against a candidate (`song.recordingUnconfirmed`).
//
//   shouldReview(session) → boolean        an owner session whose song still needs the check
//   reviewText(song) → {question, title, meta}   "Is this the right recording? **{title}** · {provider} · {m:ss}"
//   mountReviewBanner(host, {session, router, feedback, songs, transport, onDone}) → {el, update(), destroy()}
//
// Actions:
//   [Yes]                       → songs.confirmRecording({id}); the banner leaves at once
//   [Wrong song — search again] → /add?q=<song.source.value> (the original search, or the link)
//   [Delete this one]           → feedback.confirm, then songs.remove({id}) and router.navigate('/', {replace: true})
//   ✕ (Not now)                 → hidden for the rest of this session
// It is shown once per session (stage.js mounts it once and remembers an answer or a dismissal) and
// never while playing: it hides while the transport plays or counts and returns when it stops.

import '../styles/views/stage/review-banner.css';
import * as songsApi from '../api/songs.js';
import {feedback as appFeedback} from '../app/feedback.js';
import {h} from '../ui/h.js';
import {Banner} from '../ui/banner.js';
import {formatClock} from '../../shared/practice.ts';
import {COPY} from './stage.copy.js';

const PLAYING = new Set(['playing', 'counting']);
const peek = (v) => (v && typeof v.peek === 'function' ? v.peek() : v?.value ?? null);

/** True for an owner session whose song still asks "Is this the right recording?". */
export function shouldReview(session) {
  if (!session || session.readOnly) return false;
  return peek(session.song)?.recordingUnconfirmed === true;
}

/** The banner's parts: the question, the bold title and "{provider} · {m:ss}". */
export function reviewText(song) {
  const provider = String(song?.provider ?? '').trim();
  const length = Number.isFinite(song?.duration) && song.duration > 0 ? formatClock(song.duration) : '';
  return {question: COPY.reviewQuestion, title: String(song?.title ?? ''), meta: [provider, length].filter(Boolean).join(' · ')};
}

/** The text the Add sheet searches with for "Wrong song — search again". */
export function searchAgainQuery(song) {
  const value = song?.source?.value;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return [song?.title, song?.artist].filter(Boolean).join(' ');
}

export function mountReviewBanner(host, {
  session, router, feedback = appFeedback, songs = songsApi, transport = session?.transport, onDone = () => {},
} = {}) {
  if (!host) throw new TypeError('mountReviewBanner: a host element is required');
  if (!session) throw new TypeError('mountReviewBanner: a session is required');
  let done = false, busy = false;
  const wrap = h('div', {class: 'stage-review', dataset: {review: ''}});
  const banner = Banner({tone: 'warn', dismissible: true, dismissLabel: COPY.reviewDismiss, onDismiss: () => finish('dismissed'), text: ''});
  wrap.append(banner.el);
  host.append(wrap);

  const song = () => peek(session.song);
  const finish = (how) => {
    if (done) return;
    done = true;
    wrap.hidden = true;
    onDone(how);
    cleanup();
  };

  async function confirmIt() {
    if (busy || done) return;
    busy = true;
    wrap.hidden = true;
    try {
      await songs.confirmRecording({id: session.id});
      feedback.status?.(COPY.reviewThanks, {key: 'review'});
      finish('confirmed');
    } catch (err) {
      console.error('[review] confirmRecording failed', err);
      feedback.status?.(COPY.reviewFailed, {key: 'review', tone: 'error'});
      busy = false;
      render();
    }
  }

  function searchAgain() {
    if (done) return;
    const q = searchAgainQuery(song());
    router?.navigate?.(q ? `/add?q=${encodeURIComponent(q)}` : '/add');
  }

  async function deleteIt() {
    if (busy || done) return;
    const title = song()?.title ?? '';
    const ok = await feedback.confirm({title: COPY.deleteTitle(title), body: COPY.deleteBody, confirmLabel: COPY.deleteConfirm, danger: true});
    if (!ok || done) return;
    busy = true;
    try {
      await songs.remove({id: session.id});
      finish('deleted');
      router?.navigate?.('/', {replace: true});
      feedback.toast?.(COPY.deleted(title));
    } catch (err) {
      console.error('[review] remove failed', err);
      busy = false;
      feedback.status?.(COPY.deleteFailed, {key: 'review', tone: 'error'});
    }
  }

  const actions = [
    {label: COPY.reviewYes, variant: 'primary', run: () => { void confirmIt(); }},
    {label: COPY.reviewWrong, variant: 'secondary', run: searchAgain},
    {label: COPY.reviewDelete, variant: 'secondary', run: () => { void deleteIt(); }},
  ];

  function render() {
    if (done) return;
    const s = song();
    if (!shouldReview(session)) { finish('resolved'); return; }
    const {question, title, meta} = reviewText(s);
    banner.set({
      title: question,
      text: [h('strong', {class: 'stage-review-title'}, title), meta ? ` · ${meta}` : ''],
      actions,
    });
    const playing = PLAYING.has(peek(transport?.snapshot)?.phase);
    wrap.hidden = busy || playing;
  }

  const offs = [];
  if (session.song?.subscribe) offs.push(session.song.subscribe(() => render()));
  if (transport?.snapshot?.subscribe) offs.push(transport.snapshot.subscribe(() => render()));
  function cleanup() { for (const off of offs.splice(0)) off?.(); }
  render();

  return {
    el: wrap,
    get done() { return done; },
    update: render,
    destroy() {
      cleanup();
      banner.destroy?.();
      wrap.remove();
    },
  };
}
