// The Library's remote bar (2.1): "Glasshouse is open on MacBook · [Remote ›]" whenever one of the account's
// songs is open on another device, so a phone (or any other device) is one tap from controlling it. Like
// Spotify's device bar: nothing to set up, it appears and disappears with the other device's Stage.
//
//   mountRemoteBar(host, {router, api, prefs, now, setTimer, clearTimer}) → {destroy()}
//
// Reads remote:hosts live; a host counts while fresh by this device's clock (remote-page.js liveHosts), so
// the bar also re-checks every HEARTBEAT_MS. This device's own host is never shown. Hidden (and taking no
// space) with nothing to show.
import '../styles/views/remote/remote-bar.css';
import {HEARTBEAT_MS} from '../../shared/remote.ts';
import * as appApi from '../api/remote.js';
import {now as clockNow} from '../app/clock.js';
import {prefs as appPrefs} from '../app/prefs.js';
import {Button} from '../ui/button.js';
import {h} from '../ui/h.js';
import {icon} from '../ui/icon.js';
import {hostIdOf} from './remote-host.js';
import {liveHosts} from './remote-page.js';

export const COPY = Object.freeze({
  open: (title, name) => `${title} is open on ${name}`,
  more: n => ` · ${n} more`,
  remote: 'Remote',
  label: 'Your other devices',
});

export function mountRemoteBar(host, {router = null, api = appApi, prefs = appPrefs, now = clockNow,
  setTimer = globalThis.setInterval.bind(globalThis), clearTimer = globalThis.clearInterval.bind(globalThis)} = {}) {
  const self = hostIdOf(prefs);
  let rows = [];
  const text = h('span', {class: 'remote-bar-text'});
  const go = () => {
    const first = liveHosts(rows, {now: now(), self})[0];
    const path = first ? `/remote?host=${encodeURIComponent(first.hostId)}` : '/remote';
    if (router?.navigate) router.navigate(path); else globalThis.location?.assign?.(path);
  };
  const button = Button({label: COPY.remote, iconEnd: 'chevron-right', variant: 'primary', size: 'sm', className: 'remote-bar-go', onClick: go});
  const el = h('aside', {class: 'remote-bar', hidden: true, attrs: {'aria-label': COPY.label}},
    h('span', {class: 'remote-bar-icon', attrs: {'aria-hidden': 'true'}}, icon('monitor-smartphone')), text, button.el);
  host.append(el);

  function paint() {
    const hosts = liveHosts(rows, {now: now(), self});
    el.hidden = !hosts.length;
    if (!hosts.length) return;
    text.textContent = COPY.open(hosts[0].title, hosts[0].name) + (hosts.length > 1 ? COPY.more(hosts.length - 1) : '');
  }
  const off = api.subscribeHosts((value) => { rows = Array.isArray(value) ? value : []; paint(); }, () => {});
  const timer = setTimer(paint, HEARTBEAT_MS);
  return {
    el,
    destroy() {
      off?.();
      clearTimer(timer);
      button.destroy();
      el.remove();
    },
  };
}
