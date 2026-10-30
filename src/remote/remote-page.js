// The phone remote (/remote, 2.1): control a song that is open in Woodshed on another of your devices.
// Signed in, so there is no pairing: the page lists the account's hosts (convex/remote.ts) and follows one.
//
//   mount(el, match, ctx) → {update(match), unmount()}
//     ?host=<hostId> picks a device (the Stage's QR code links here with it); else the last one controlled
//     here (prefs.remote.last) if it is still there, else the one seen most recently. A host counts while
//     its heartbeat is fresh (shared/remote.ts STALE_MS by this device's clock); this device itself is never
//     listed. With more than one, a Device menu switches between them.
//   ctx: {router, api, prefs, feedback, now, setTimer, clearTimer, haptic, wakeLock} (tests replace them)
//
// What it shows comes from the host's own HUD (`remote.view`): the song, the section, next, the bar and
// beat, the speed, and the loop, count-in, click and Minus me state. Every button sends one command
// (shared/remote.ts REMOTE_COMMANDS); the readouts update when the host has run it. While the page is
// visible it tells the host it is watching (`remote.watch`, every HEARTBEAT_MS) and keeps the screen awake.
// Nothing open elsewhere: a sentence that says how to get one, which updates the moment a host appears.
import '../styles/views/remote/remote-page.css';
import {HEARTBEAT_MS, STALE_MS} from '../../shared/remote.ts';
import * as appApi from '../api/remote.js';
import * as appFeedback from '../app/feedback.js';
import {describeError} from '../app/error-copy.js';
import {now as clockNow} from '../app/clock.js';
import {haptic as appHaptic} from '../app/platform.js';
import {prefs as appPrefs} from '../app/prefs.js';
import {Button} from '../ui/button.js';
import {h} from '../ui/h.js';
import {icon} from '../ui/icon.js';
import {InlineStatus} from '../ui/status.js';
import {hostIdOf} from './remote-host.js';

export const COPY = Object.freeze({
  title: 'Remote',
  back: 'Library',
  device: 'Device',
  looking: 'Looking for Woodshed on your other devices…',
  noneTitle: 'Nothing is open on your other devices',
  noneBody: 'Open a song in Woodshed on your computer or iPad, signed in to this account. It shows up here right away, with no pairing.',
  on: name => `on ${name}`,
  play: 'Play',
  stop: 'Stop',
  pause: 'Pause',
  again: 'Start again',
  prevSection: 'Previous section',
  nextSection: 'Next section',
  barBack: 'Back a bar',
  barFwd: 'Forward a bar',
  section: 'Section',
  bar: 'Bar',
  slower: 'Slower',
  faster: 'Faster',
  speed: 'Speed',
  normalSpeed: 'Back to 100%',
  loopSection: 'Loop section',
  loop: 'Loop',
  countIn: 'Count-in',
  click: 'Click',
  minusMe: mine => (mine ? `Mute ${mine}` : 'Mute my part'),
  prevSong: 'Previous song',
  nextSong: 'Next song',
  closed: 'That device closed the song.',
  busy: 'That device isn’t keeping up. Try again in a moment.',
  percent: n => `${n}%`,
  bpm: n => `${n} bpm`,
  waiting: '—',
});

/** Controls (role, name) for the table test and the fixture. */
export const CONTROLS = Object.freeze([
  {role: 'link', name: COPY.back},
  {role: 'button', name: COPY.again}, {role: 'button', name: COPY.play}, {role: 'button', name: COPY.pause},
  {role: 'button', name: COPY.prevSection}, {role: 'button', name: COPY.nextSection},
  {role: 'button', name: COPY.slower}, {role: 'button', name: COPY.faster},
  {role: 'button', name: COPY.loopSection}, {role: 'button', name: COPY.countIn}, {role: 'button', name: COPY.click},
]);

const PLAYING = new Set(['playing', 'counting']);

/** The hosts a remote can control: fresh by this device's clock, never this device, most recent first. */
export function liveHosts(rows, {now, self}) {
  return (Array.isArray(rows) ? rows : []).filter(r => r && r.hostId !== self && now - r.seenAt <= STALE_MS)
    .sort((a, b) => b.seenAt - a.seenAt);
}

/** The host to follow: the asked one, else the last one controlled here, else the most recent. */
export function pickHost(hosts, {asked = null, last = null} = {}) {
  return hosts.find(x => x.hostId === asked) ?? hosts.find(x => x.hostId === last) ?? hosts[0] ?? null;
}

export async function mount(el, match, ctx = {}) {
  const api = ctx.api ?? appApi;
  const prefs = ctx.prefs ?? appPrefs;
  const feedback = {...appFeedback, ...(ctx.feedback ?? {})};
  const now = ctx.now ?? clockNow;
  const setTimer = ctx.setTimer ?? globalThis.setInterval.bind(globalThis);
  const clearTimer = ctx.clearTimer ?? globalThis.clearInterval.bind(globalThis);
  const haptic = ctx.haptic ?? appHaptic;
  const doc = el.ownerDocument;
  const self = hostIdOf(prefs);

  let asked = match?.query?.host ?? null;
  let rows = null;            // remote:hosts, null while loading
  let hostId = null;          // the host followed
  let view = undefined;       // remote:view for it (undefined: loading)
  let offView = null, watchTimer = null, wake = null, destroyed = false;
  const buttons = [];
  const button = (props) => { const b = Button(props); buttons.push(b); return b; };

  // ---------- the frame ----------
  const back = h('a', {class: 'remote-back', href: '/', 'data-link': ''}, icon('chevron-left'), h('span', {}, COPY.back));
  back.addEventListener('click', (e) => { if (ctx.router?.navigate) { e.preventDefault(); ctx.router.navigate('/'); } });
  const picker = h('select', {class: 'remote-picker', attrs: {'aria-label': COPY.device}});
  picker.addEventListener('change', () => follow(picker.value, {remember: true}));
  const top = h('header', {class: 'remote-top'}, back, picker);

  const empty = h('div', {class: 'remote-empty'},
    h('p', {class: 'remote-empty-title'}, COPY.looking), h('p', {class: 'remote-empty-body'}, ''));

  const songTitle = h('h1', {class: 'remote-song'});
  const songSub = h('p', {class: 'remote-song-sub'});
  const section = h('p', {class: 'remote-section', attrs: {'aria-live': 'polite'}});
  const next = h('p', {class: 'remote-next'});
  const position = h('span', {class: 'remote-position'});
  const speed = h('span', {class: 'remote-speed'});
  const readouts = h('div', {class: 'remote-readouts'}, songTitle, songSub, section, next, h('p', {class: 'remote-line'}, position, speed));

  const send = (command) => async () => {
    if (!hostId) return;
    haptic(8);
    try {
      const result = await api.send({hostId, command});
      if (result && result.queued === false) status(COPY.busy, 'warn');
      else status('');
    } catch (err) {
      status(err?.code === 'not_found' ? COPY.closed : describeError(err).sentence, 'error');
    }
  };
  const playBtn = button({label: COPY.play, icon: 'play', variant: 'primary', size: 'lg', className: 'remote-play', onClick: send('transport.playStop')});
  const pauseBtn = button({label: COPY.pause, icon: 'pause', size: 'lg', className: 'remote-pause', onClick: send('transport.pause')});
  const againBtn = button({label: COPY.again, icon: 'rotate-ccw', size: 'lg', className: 'remote-again', onClick: send('transport.again')});
  // Short visible labels ('‹ Section', 'Section ›') keep the pairs symmetric on a phone; the names stay whole.
  const prevBtn = button({label: COPY.section, icon: 'chevron-left', size: 'lg', className: 'remote-prev', attrs: {'aria-label': COPY.prevSection},
    onClick: send('nav.prevSection')});
  const nextBtn = button({label: COPY.section, iconEnd: 'chevron-right', size: 'lg', className: 'remote-next-btn', attrs: {'aria-label': COPY.nextSection},
    onClick: send('nav.nextSection')});
  const barBackBtn = button({label: COPY.bar, icon: 'arrow-left', className: 'remote-bar', attrs: {'aria-label': COPY.barBack}, onClick: send('nav.barBack')});
  const barFwdBtn = button({label: COPY.bar, iconEnd: 'arrow-right', className: 'remote-bar', attrs: {'aria-label': COPY.barFwd}, onClick: send('nav.barFwd')});
  const slowerBtn = button({label: COPY.slower, icon: 'minus', className: 'remote-slower', onClick: send('speed.down')});
  const fasterBtn = button({label: COPY.faster, iconEnd: 'plus', className: 'remote-faster', onClick: send('speed.up')});
  const speedReset = button({label: COPY.normalSpeed, variant: 'quiet', size: 'sm', className: 'remote-speed-reset', onClick: send('speed.toggle100')});
  const loopBtn = button({label: COPY.loopSection, icon: 'repeat', className: 'remote-toggle remote-loop', pressed: false,
    onClick: () => send(view?.state?.loop ? 'transport.loopToggle' : 'transport.loopSection')()});
  const countBtn = button({label: COPY.countIn, icon: 'count-in', className: 'remote-toggle', pressed: false, onClick: send('click.countIn')});
  const clickBtn = button({label: COPY.click, icon: 'metronome', className: 'remote-toggle', pressed: false, onClick: send('click.toggle')});
  const meBtn = button({label: COPY.minusMe(''), icon: 'minus-me', className: 'remote-toggle', pressed: false, onClick: send('mix.minusMe')});
  const prevSong = button({label: COPY.prevSong, icon: 'chevron-left', size: 'sm', className: 'remote-song-step', onClick: send('setlist.prev')});
  const nextSong = button({label: COPY.nextSong, iconEnd: 'chevron-right', size: 'sm', className: 'remote-song-step', onClick: send('setlist.next')});
  const setlistRow = h('div', {class: 'remote-setlist'}, prevSong.el, nextSong.el);

  const controls = h('div', {class: 'remote-controls'},
    h('div', {class: 'remote-row remote-row-main'}, againBtn.el, playBtn.el, pauseBtn.el),
    h('div', {class: 'remote-row'}, prevBtn.el, nextBtn.el),
    h('div', {class: 'remote-row remote-row-small'}, barBackBtn.el, barFwdBtn.el),
    h('div', {class: 'remote-row remote-speed-row', role: 'group', 'aria-label': COPY.speed}, slowerBtn.el, speedReset.el, fasterBtn.el),
    h('div', {class: 'remote-toggles'}, loopBtn.el, countBtn.el, clickBtn.el, meBtn.el),
    setlistRow);
  const statusLine = InlineStatus({tone: 'info', text: '', className: 'remote-status'});
  const status = (text, tone = 'info') => { statusLine.el.hidden = !text; statusLine.set({text, tone}); };
  status('');
  const panel = h('main', {class: 'remote-panel'}, readouts, controls, statusLine.el);
  const root = h('section', {class: 'remote', attrs: {'aria-label': COPY.title}}, top, empty, panel);
  el.replaceChildren(root);

  // ---------- painting ----------
  function paint() {
    if (destroyed) return;
    const hosts = liveHosts(rows, {now: now(), self});
    const host = hosts.find(x => x.hostId === hostId) ?? null;
    root.dataset.state = rows === null ? 'loading' : host ? 'host' : 'none';
    empty.hidden = !!host;
    panel.hidden = !host;
    empty.firstChild.textContent = rows === null ? COPY.looking : COPY.noneTitle;
    empty.lastChild.textContent = rows === null ? '' : COPY.noneBody;
    picker.hidden = hosts.length < 2;
    picker.replaceChildren(...hosts.map(x => h('option', {value: x.hostId, selected: x.hostId === hostId}, `${x.name} · ${x.title}`)));
    if (!host) return;
    const s = view?.state ?? null;
    songTitle.textContent = host.title;
    songSub.textContent = [host.artist, COPY.on(host.name)].filter(Boolean).join(' · ');
    section.textContent = s?.section || (s ? '' : COPY.waiting);
    next.textContent = s?.next ?? '';
    position.textContent = s?.position ?? '';
    const pct = Math.round((s?.rate ?? 1) * 100);
    speed.textContent = s ? [COPY.percent(pct), s.bpm ? COPY.bpm(s.bpm) : ''].filter(Boolean).join(' · ') : '';
    const playing = PLAYING.has(s?.phase);
    playBtn.set({label: playing ? COPY.stop : COPY.play, icon: playing ? 'square' : 'play'});
    pauseBtn.set({disabled: !playing});
    speedReset.el.hidden = !s || pct === 100;
    loopBtn.set({pressed: !!s?.loop, label: s?.loop ? (s.loopLabel ? `${COPY.loop}: ${s.loopLabel}` : COPY.loop) : COPY.loopSection});
    countBtn.set({pressed: !!s?.countIn});
    clickBtn.set({pressed: !!s?.click});
    meBtn.set({pressed: !!s?.minusMe, label: COPY.minusMe(s?.mine ?? '')});
    setlistRow.hidden = !s?.setlist;
  }

  // ---------- following a host ----------
  function watchNow() {
    if (hostId && doc.visibilityState !== 'hidden') void Promise.resolve(api.watch({hostId})).catch(() => {});
  }
  function follow(next, {remember = false} = {}) {
    if (next === hostId) { paint(); return; }
    offView?.();
    offView = null;
    hostId = next;
    view = undefined;
    if (remember && next) prefs.set('remote.last', next);
    if (next) {
      offView = api.subscribeView({hostId: next}, (value) => { view = value; paint(); }, () => {});
      watchNow();
    }
    paint();
  }
  function choose() {
    const hosts = liveHosts(rows, {now: now(), self});
    const want = pickHost(hosts, {asked, last: prefs.get('remote.last')});
    if (want && want.hostId === asked) prefs.set('remote.last', asked);
    follow(want?.hostId ?? null);
  }
  const offHosts = api.subscribeHosts((value) => { rows = Array.isArray(value) ? value : []; choose(); }, () => { rows = rows ?? []; paint(); });
  // Staleness is by this device's clock: re-check while nothing else changes; the watch heartbeat rides along.
  watchTimer = setTimer(() => { choose(); watchNow(); }, HEARTBEAT_MS);

  async function lockScreen() {
    try { wake = await (ctx.wakeLock ?? globalThis.navigator?.wakeLock)?.request?.('screen'); } catch { wake = null; }
  }
  const onVisible = () => { if (doc.visibilityState === 'visible') { watchNow(); void lockScreen(); } };
  doc.addEventListener('visibilitychange', onVisible);
  void lockScreen();
  paint();

  return {
    update(m) {
      const nextAsked = m?.query?.host ?? null;
      if (nextAsked !== asked) { asked = nextAsked; choose(); }
    },
    unmount() {
      destroyed = true;
      offHosts?.();
      offView?.();
      clearTimer(watchTimer);
      doc.removeEventListener('visibilitychange', onVisible);
      try { void wake?.release?.(); } catch { /* already released */ }
      for (const b of buttons) b.destroy();
      statusLine.destroy();
      feedback.dismissStatus?.('remote');
    },
  };
}
