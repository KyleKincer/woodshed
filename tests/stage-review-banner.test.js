// @vitest-environment happy-dom
// "Is this the right recording?" (D43, spec §3.5; architecture §9.10 ST4): the banner's text, its
// three actions (Yes → songs.confirmRecording; Wrong song → /add?q=<source>; Delete → confirm, then
// songs.remove and Library with replace), the dismissal, "never while playing" and the copy table.
import {afterEach, describe, expect, test, vi} from 'vitest';
import {signal} from '../src/app/store.js';
import {mountReviewBanner, reviewText, searchAgainQuery, shouldReview} from '../src/stage/review-banner.js';
import {COPY, CONTROLS} from '../src/stage/stage.copy.js';

const SONG = Object.freeze({
  id: 'shuffle', title: 'Sunday Shuffle (Blues Backing Track in A)', duration: 312, provider: 'YouTube',
  source: {type: 'search', value: 'sunday shuffle blues backing track in a'}, recordingUnconfirmed: true,
});

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function bed({song = SONG, readOnly = false, phase = 'stopped', confirm = true, songsApi} = {}) {
  const songSig = signal({...song});
  const snapshot = signal({phase});
  const session = {id: song.id, readOnly, song: songSig, transport: {snapshot}};
  const songs = songsApi ?? {confirmRecording: vi.fn(async () => null), remove: vi.fn(async () => null)};
  const router = {navigate: vi.fn()};
  const feedback = {status: vi.fn(), toast: vi.fn(), confirm: vi.fn(async () => confirm)};
  const onDone = vi.fn();
  const host = document.body.appendChild(document.createElement('div'));
  const view = mountReviewBanner(host, {session, router, feedback, songs, onDone});
  const button = (name) => [...host.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.textContent.trim()) === name);
  return {session, songSig, snapshot, songs, router, feedback, onDone, host, view, button};
}

afterEach(() => { document.body.replaceChildren(); });

describe('who gets the check', () => {
  test('an owner session whose song is an unconfirmed search', () => {
    expect(shouldReview({readOnly: false, song: signal({recordingUnconfirmed: true})})).toBe(true);
    expect(shouldReview({readOnly: false, song: signal({recordingUnconfirmed: false})})).toBe(false);
    expect(shouldReview({readOnly: false, song: signal({needsReview: true})})).toBe(false);
    expect(shouldReview({readOnly: true, song: signal({recordingUnconfirmed: true})})).toBe(false);
    expect(shouldReview(null)).toBe(false);
  });

  test('the text: "Is this the right recording? **{title}** · {provider} · {m:ss}"', () => {
    expect(reviewText(SONG)).toEqual({question: 'Is this the right recording?', title: SONG.title, meta: 'YouTube · 5:12'});
    expect(reviewText({title: 'X', duration: 61})).toEqual({question: 'Is this the right recording?', title: 'X', meta: '1:01'});
  });

  test('"search again" uses the original search, else the link, else title and artist', () => {
    expect(searchAgainQuery(SONG)).toBe('sunday shuffle blues backing track in a');
    expect(searchAgainQuery({source: {type: 'url', value: 'https://youtu.be/x'}})).toBe('https://youtu.be/x');
    expect(searchAgainQuery({title: 'Glasshouse', artist: 'Northbound'})).toBe('Glasshouse Northbound');
  });
});

describe('the banner', () => {
  test('renders the question, the bold title and the provider · length, with Yes / Wrong song / Delete and Not now', () => {
    const b = bed();
    const text = b.host.textContent.replace(/\s+/g, ' ');
    expect(text).toContain('Is this the right recording?');
    expect(text).toContain(`${SONG.title} · YouTube · 5:12`);
    expect(b.host.querySelector('.stage-review-title').textContent).toBe(SONG.title);
    expect(b.host.querySelector('.stage-review-title').tagName).toBe('STRONG');
    for (const name of [COPY.reviewYes, COPY.reviewWrong, COPY.reviewDelete, COPY.reviewDismiss]) expect(b.button(name), name).toBeTruthy();
    expect(b.view.el.hidden).toBe(false);
  });

  test('every review row of CONTROLS is a button with that accessible name', () => {
    const b = bed();
    for (const row of CONTROLS.filter((r) => r.where === 'review')) {
      const el = b.button(row.name);
      expect(el, row.name).toBeTruthy();
      expect(el.tagName.toLowerCase()).toBe(row.role);
    }
  });

  test('[Yes] confirms the recording, hides the banner at once and says thanks', async () => {
    const b = bed();
    b.button(COPY.reviewYes).click();
    expect(b.view.el.hidden).toBe(true);
    await flush();
    expect(b.songs.confirmRecording).toHaveBeenCalledWith({id: 'shuffle'});
    expect(b.onDone).toHaveBeenCalledWith('confirmed');
    expect(b.feedback.status).toHaveBeenCalledWith(COPY.reviewThanks, expect.objectContaining({key: 'review'}));
  });

  test('a failed confirm brings the banner back with an error line', async () => {
    const b = bed({songsApi: {confirmRecording: vi.fn(async () => { throw new Error('offline'); }), remove: vi.fn()}});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    b.button(COPY.reviewYes).click();
    await flush();
    expect(b.view.el.hidden).toBe(false);
    expect(b.onDone).not.toHaveBeenCalled();
    expect(b.feedback.status).toHaveBeenCalledWith(COPY.reviewFailed, expect.objectContaining({tone: 'error'}));
  });

  test('[Wrong song — search again] opens /add?q=<song.source.value>', () => {
    const b = bed();
    b.button(COPY.reviewWrong).click();
    expect(b.router.navigate).toHaveBeenCalledWith(`/add?q=${encodeURIComponent(SONG.source.value)}`);
  });

  test('[Delete this one] asks first; Cancel deletes nothing', async () => {
    const b = bed({confirm: false});
    b.button(COPY.reviewDelete).click();
    await flush();
    expect(b.feedback.confirm).toHaveBeenCalledWith(expect.objectContaining({title: COPY.deleteTitle(SONG.title), danger: true, confirmLabel: COPY.deleteConfirm}));
    expect(b.songs.remove).not.toHaveBeenCalled();
    expect(b.router.navigate).not.toHaveBeenCalled();
  });

  test('[Delete this one] confirmed removes the song and replaces the Stage with the Library', async () => {
    const b = bed();
    b.button(COPY.reviewDelete).click();
    await flush();
    expect(b.songs.remove).toHaveBeenCalledWith({id: 'shuffle'});
    expect(b.router.navigate).toHaveBeenCalledWith('/', {replace: true});
    expect(b.onDone).toHaveBeenCalledWith('deleted');
  });

  test('✕ (Not now) hides it for the session', () => {
    const b = bed();
    b.button(COPY.reviewDismiss).click();
    expect(b.view.el.hidden).toBe(true);
    expect(b.onDone).toHaveBeenCalledWith('dismissed');
    b.snapshot.value = {phase: 'playing'};
    b.snapshot.value = {phase: 'stopped'};
    expect(b.view.el.hidden).toBe(true);
  });

  test('never while playing: hidden while playing or counting, back when stopped', () => {
    const b = bed({phase: 'playing'});
    expect(b.view.el.hidden).toBe(true);
    b.snapshot.value = {phase: 'stopped'};
    expect(b.view.el.hidden).toBe(false);
    b.snapshot.value = {phase: 'counting'};
    expect(b.view.el.hidden).toBe(true);
    b.snapshot.value = {phase: 'paused'};
    expect(b.view.el.hidden).toBe(false);
  });

  test('the check answered elsewhere (the flag clears) removes the banner', () => {
    const b = bed();
    b.songSig.value = {...SONG, recordingUnconfirmed: false};
    expect(b.view.el.hidden).toBe(true);
    expect(b.onDone).toHaveBeenCalledWith('resolved');
  });

  test('destroy() removes it', () => {
    const b = bed();
    b.view.destroy();
    expect(b.host.querySelector('.stage-review')).toBeNull();
  });

  test('needs a host and a session', () => {
    expect(() => mountReviewBanner(null, {session: {}})).toThrow(TypeError);
    expect(() => mountReviewBanner(document.createElement('div'), {})).toThrow(TypeError);
  });
});
