// Fixture handlers for convex/remote.ts (the phone remote, 2.1), over three in-memory lists in the db:
// `remoteHosts` ({hostId, userId, name, platform?, songId?, title, artist?, seenAt, watchedAt?}),
// `remoteStates` ({hostId: state}) and `remoteCommands` ({id, hostId, command, sentAt}). Same rules and coded
// errors as the server: allowlisted commands (`invalid`), a host that is gone (`not_found`), MAX_PENDING
// waiting commands, MAX_HOSTS hosts. The fixture has one user, so "the account" is db.user.
//
// fx-remote=host seeds one host (another device: "MacBook" with Glasshouse playing at the Chorus), so the
// Library's remote bar and the /remote page have something to show in one tab.
import {db, fx, clone, convexError} from './runtime.js';
import {MAX_HOSTS, MAX_PENDING, isHostId, isRemoteCommand} from '../../../shared/remote.ts';

const fail = (code, message) => { throw convexError({code, message}); };
const SEEDED = 'fixture-macbook-host';

function lists() {
  if (!db.remoteHosts) {
    db.remoteHosts = [];
    db.remoteStates = {};
    db.remoteCommands = [];
    db.remoteSeq = 0;
    if (fx.remote === 'host') {
      db.remoteHosts.push({hostId: SEEDED, userId: db.user?._id ?? null, name: 'MacBook', platform: 'mac', songId: 'glasshouse',
        title: 'Glasshouse', artist: 'Northbound', seenAt: Date.now()});
      db.remoteStates[SEEDED] = {phase: 'playing', position: '23 · 3', section: 'Chorus', next: 'next: Verse 2 · 6 bars', rate: 0.85,
        bpm: 102, loop: true, loopLabel: 'Chorus', countIn: true, click: false, minusMe: true, mine: 'drums', trainer: false, setlist: false};
    }
  }
  return db;
}
const userId = () => db.user?._id ?? null;
const hostOf = hostId => (isHostId(hostId) ? lists().remoteHosts.find(h => h.hostId === hostId && h.userId === userId()) : null) ?? null;
const view = h => Object.fromEntries(Object.entries({hostId: h.hostId, name: h.name, platform: h.platform, songId: h.songId,
  title: h.title, artist: h.artist, seenAt: h.seenAt}).filter(([, v]) => v !== undefined));
function remove(hostId) {
  const d = lists();
  d.remoteHosts = d.remoteHosts.filter(h => h.hostId !== hostId);
  delete d.remoteStates[hostId];
  d.remoteCommands = d.remoteCommands.filter(c => c.hostId !== hostId);
}

export const handlers = {
  'remote:announce': ({hostId, name, platform, songId, title, artist, fresh}) => {
    if (!isHostId(hostId)) fail('invalid', 'Invalid remote host.');
    const d = lists();
    const fields = {hostId, userId: userId(), name: String(name || 'Woodshed').slice(0, 60), platform, songId,
      title: String(title || 'Untitled').slice(0, 200), artist, seenAt: Date.now()};
    const existing = hostOf(hostId);
    if (existing) {
      Object.assign(existing, fields);
      if (fresh) d.remoteCommands = d.remoteCommands.filter(c => c.hostId !== hostId);
      return null;
    }
    const mine = d.remoteHosts.filter(h => h.userId === userId()).sort((a, b) => a.seenAt - b.seenAt);
    while (mine.length >= MAX_HOSTS) remove(mine.shift().hostId);
    d.remoteHosts.push(fields);
    return null;
  },
  'remote:close': ({hostId}) => { if (hostOf(hostId)) remove(hostId); return null; },
  'remote:publish': ({hostId, state}) => { if (hostOf(hostId)) lists().remoteStates[hostId] = clone(state); return null; },
  'remote:hosts': () => lists().remoteHosts.filter(h => h.userId === userId()).sort((a, b) => b.seenAt - a.seenAt).map(view),
  'remote:view': ({hostId}) => {
    const h = hostOf(hostId);
    return h ? {host: view(h), state: clone(lists().remoteStates[hostId] ?? null), updatedAt: h.seenAt} : null;
  },
  'remote:watch': ({hostId}) => { const h = hostOf(hostId); if (h) h.watchedAt = Date.now(); return null; },
  'remote:send': ({hostId, command}) => {
    if (!isRemoteCommand(command)) fail('invalid', 'That command can’t be sent to another device.');
    if (!hostOf(hostId)) fail('not_found', 'That device has closed the song.');
    const d = lists();
    if (d.remoteCommands.filter(c => c.hostId === hostId).length >= MAX_PENDING) return {queued: false};
    d.remoteCommands.push({id: `rc-${++d.remoteSeq}`, hostId, command, sentAt: Date.now()});
    return {queued: true};
  },
  'remote:commands': ({hostId}) => {
    const h = hostOf(hostId);
    if (!h) return {watchedAt: null, commands: []};
    return {watchedAt: h.watchedAt ?? null, commands: lists().remoteCommands.filter(c => c.hostId === hostId).slice(0, MAX_PENDING)
      .map(c => ({id: c.id, command: c.command, sentAt: c.sentAt}))};
  },
  'remote:ack': ({hostId, ids}) => {
    if (!hostOf(hostId)) return null;
    const drop = new Set(ids);
    const d = lists();
    d.remoteCommands = d.remoteCommands.filter(c => !(c.hostId === hostId && drop.has(c.id)));
    return null;
  },
};
