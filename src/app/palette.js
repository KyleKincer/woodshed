// The ⌘K command palette (architecture §2.8, spec §7.3).
//
//   openPalette({query = '', registry} = {}) → {close(), setQuery(q), el, get open, get items}
//     A modal overlay (D36): a native <dialog> on the dispatcher's overlay stack. 640 px wide and top-centred, or a
//     full-width top sheet in the band layout and on narrow screens. Opening it again while it is open returns the same
//     handle (with the new query when one is given).
//   registerProvider({id, group, search(query, ctx) → Item[]}) → off
//     group: 'song' (In this song) | 'commands' | 'songs' | 'navigation'. A provider with a built-in's id replaces it
//     until `off`. search() runs on every keystroke with the raw query and a registry context.
//   Item = {id, title, subtitle?, group, keys?: KeyString, icon?, run(ctx, {mod}), disabled?: string (the visible reason),
//           modLabel?: string (what ⌘Enter does, shown on the row), tier?: number, frecency?: boolean, lead?: boolean}
//   configurePalette({songs = true, navigation = true}) — the Shared Stage turns the song-title and navigation
//     providers off (§2.18 item 6); they are also off whenever the session is a shared one (session.shareToken).
//
// Built-in providers and query parsing (§2.8):
//   In this song   `bar 57`, `b57`, `57` → Go to bar 57 (mapped) or Go to 0:57 (unmapped); `1:12` → time. Section names,
//                  spot names and marker labels. Enter cues there (nav.goTo {t}; spots run spot.open {id}); ⌘Enter loops it.
//   Commands       `75`/`75%` → Speed 75% (speed.set {rate}); `loop 41-48` (bars, or seconds unmapped) and `loop chorus`;
//                  `count 2 bars|beats`; `trainer 70 100 [step]` (trainer.toggle {start, end, step, passes});
//                  `only <stem>` / `only me`; `minus` / `minus <stem>`; `mute|unmute <stem>`; and every registry command
//                  by title, menu label and palette keywords (`tap the beat`, `edit map`, `share`, `re-split`). A command
//                  whose `when` fails is hidden; one with a disabledReason is listed, disabled, with the reason visible.
//   Songs          library titles (prefix > word-start > fuzzy) and artists; Enter opens the Stage, ⌘Enter Details.
//   Navigation     nav.library, nav.settings(.<section>), nav.plan, nav.admin and library.add from the registry.
//   A bare number < 400 offers both Speed N% and Go to bar N; the bar comes first when mapped, the speed otherwise.
// Ranking: group order (In this song, Commands, Songs, Navigation; the unmapped bare-number case leads with Commands),
// then the match tier (parsed rows first, then exact, prefix, word start, substring, fuzzy), then frecency
// score = n × 0.5^(ageDays / 14) from prefs.palette.frecency ({[itemId]: {n, at}}, at most FRECENCY_CAP entries; the
// lowest scores go first), then provider order. Parsed rows are not recorded.

import {formatClock} from '../../shared/practice.ts';
import {now} from './clock.js';
import {registry as appRegistry} from './commands.js';
import {pushOverlay} from './dispatch.js';
import {announce} from './feedback.js';
import {isMacLike} from './keys.js';
import {FRECENCY_CAP, prefs} from './prefs.js';
import {store as appStore} from './store.js';
import {h} from '../ui/h.js';
import {icon} from '../ui/icon.js';
import {Kbd} from '../ui/kbd.js';
import {closeAllMenus} from '../ui/menu.js';
import {layerHost, pushModalHost, restoreFocus, trackLayer, trapTab} from '../ui/popover.js';
import '../styles/views/app/palette.css';

export const GROUPS = Object.freeze(['song', 'commands', 'songs', 'navigation']);
export const GROUP_LABELS = Object.freeze({song: 'In this song', commands: 'Commands', songs: 'Songs', navigation: 'Navigation'});
export const TIER = Object.freeze({parsed: -1, exact: 0, prefix: 1, word: 2, substring: 3, fuzzy: 4});
export const HALF_LIFE_DAYS = 14;
export const SPEED_MIN = 25;
export const SPEED_MAX = 150;
export const BARE_NUMBER_MAX = 400;
export const BAND_WIDTH = 720;            // narrower viewports get the top sheet
export const LIMITS = Object.freeze({song: 24, commands: 30, songs: 8, navigation: 16});
export const EMPTY_LIMITS = Object.freeze({song: 12, commands: 8, songs: 5, navigation: 16});
/** Commands the palette reaches only through parsed rows (they need args). */
export const PARSED_ONLY = Object.freeze(['nav.goTo', 'speed.set', 'spot.open']);
/** Registry commands listed under Navigation instead of Commands. */
export const NAV_RE = /^(?:nav\.(?:library|settings|plan|admin)(?:\..+)?|library\.add)$/;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------------------------
// Text matching (pure)

/** Lower-case, accent-free text with an ellipsis or punctuation as spaces; keeps digits, %, :, ., - and +. */
export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/…|\.{3,}/g, ' ')
    .replace(/[‐-―−]/g, '-')
    .replace(/[^\p{L}\p{N}%:.+\-\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const compact = s => s.replace(/[\s.\-]/g, '');

function subsequence(needle, hay) {
  let i = 0;
  for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true;
  return needle.length === 0;
}

/** How well `text` matches `query`: a TIER value, or null for no match. An empty query matches everything (exact). */
export function matchTier(text, query) {
  const q = normalizeText(query);
  if (!q) return TIER.exact;
  const t = normalizeText(text);
  if (!t) return null;
  const cq = compact(q), ct = compact(t);
  if (t === q || (cq && ct === cq)) return TIER.exact;
  if (t.startsWith(q) || (cq && ct.startsWith(cq))) return TIER.prefix;
  const words = t.split(/[\s\-]+/).filter(Boolean);
  const parts = q.split(/[\s\-]+/).filter(Boolean);
  if (parts.length && parts.every(p => words.some(w => w.startsWith(p)))) return TIER.word;
  if (q.length >= 2 && t.includes(q)) return TIER.substring;
  if (cq.length >= 2 && subsequence(cq, ct)) return TIER.fuzzy;
  return null;
}

/** The best tier over several texts; texts after the first count half a tier worse (a title beats a keyword). */
function bestTier(texts, query) {
  let best = null;
  texts.forEach((text, i) => {
    if (!text) return;
    const tier = matchTier(text, query);
    if (tier == null) return;
    const value = i === 0 ? tier : tier + 0.5;
    if (best == null || value < best) best = value;
  });
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Query parsing (pure)

const toNumber = s => (s == null ? undefined : Number(s));
const TIME_RE = /^(\d{1,3}):([0-5]?\d(?:\.\d+)?)$/;
const timeOf = s => {
  const m = TIME_RE.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
};

/**
 * What a query asks for, as far as the built-in providers understand it:
 * {text, bare?, bar?, time?, speed?, speedExplicit?, loop?: {from, to, unit: 'number'|'time'} | {name}, count?: {length, unit},
 *  trainer?: {start, end, step?}, only?: string, minus?: string|true, mute?: {name, on}}.
 */
export function parseQuery(query) {
  const text = normalizeText(query);
  const out = {text};
  let m;
  if ((m = /^(?:bar|b)\s*(\d{1,4})$/.exec(text))) out.bar = Number(m[1]);
  else if ((m = /^(\d{1,4})$/.exec(text))) {
    out.bare = Number(m[1]);
    out.bar = out.bare;
    if (out.bare < BARE_NUMBER_MAX) out.speed = out.bare;
  }
  const time = timeOf(text);
  if (time !== undefined) out.time = time;
  if ((m = /^(\d{1,3}(?:\.\d+)?)\s*%$/.exec(text))) { out.speed = Number(m[1]); out.speedExplicit = true; }
  if ((m = /^loop\s+(.+)$/.exec(text))) {
    const rest = m[1];
    const range = /^(\S+?)\s*(?:-|to)\s*(\S+)$/.exec(rest);
    const a = range?.[1], b = range?.[2];
    if (range && /^\d{1,4}$/.test(a) && /^\d{1,4}$/.test(b)) out.loop = {from: Number(a), to: Number(b), unit: 'number'};
    else if (range && timeOf(a) !== undefined && timeOf(b) !== undefined) out.loop = {from: timeOf(a), to: timeOf(b), unit: 'time'};
    else out.loop = {name: rest};
  }
  if ((m = /^count(?:\s*-?\s*in)?\s+(\d{1,2})\s*(bars?|beats?)?$/.exec(text))) {
    out.count = {length: Number(m[1]), unit: m[2]?.startsWith('beat') ? 'beats' : 'bars'};
  }
  if ((m = /^trainer\s+(\d{1,3})\s*%?\s+(?:to\s+)?(\d{1,3})\s*%?(?:\s+(\d{1,2})\s*%?)?$/.exec(text))) {
    out.trainer = {start: Number(m[1]), end: Number(m[2]), ...(m[3] ? {step: toNumber(m[3])} : {})};
  }
  if ((m = /^only\s+(.+)$/.exec(text))) out.only = m[1];
  if ((m = /^minus(?:\s+(.+))?$/.exec(text))) out.minus = m[1] ?? true;
  if ((m = /^(un)?mute\s+(.+)$/.exec(text))) out.mute = {name: m[2], on: !m[1]};
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Frecency (pure helpers + the prefs store)

/** n × 0.5^(ageDays / 14). */
export function frecencyScore(entry, at = now()) {
  if (!entry || !(entry.n > 0)) return 0;
  const ageDays = Math.max(0, (at - (Number(entry.at) || 0)) / DAY_MS);
  return entry.n * 0.5 ** (ageDays / HALF_LIFE_DAYS);
}

/** The frecency map after one more use of `id`, capped at `cap` entries (the lowest scores are dropped). */
export function bumpFrecency(map, id, at = now(), cap = FRECENCY_CAP) {
  const next = {...(map ?? {})};
  const prev = next[id];
  next[id] = {n: (prev?.n > 0 ? prev.n : 0) + 1, at};
  const ids = Object.keys(next);
  if (ids.length <= cap) return next;
  const ranked = ids
    .map(k => ({k, score: k === id ? Infinity : frecencyScore(next[k], at), at: Number(next[k]?.at) || 0}))
    .sort((x, y) => y.score - x.score || y.at - x.at);
  return Object.fromEntries(ranked.slice(0, cap).map(({k}) => [k, next[k]]));
}

function readFrecency() {
  try { return prefs.get('palette.frecency') ?? {}; } catch { return {}; }
}

/** Records one use of a palette item. */
export function recordUse(id) {
  if (!id) return;
  try {
    prefs.update(draft => {
      draft.palette ??= {frecency: {}};
      draft.palette.frecency = bumpFrecency(draft.palette.frecency, id);
    });
  } catch (err) {
    console.error(err);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Ranking (pure)

/** Orders items: group (a `lead` item's group first), tier, frecency score, then input order. */
export function rankItems(items, {frecency = {}, at = now()} = {}) {
  const lead = items.find(i => i.lead)?.group;
  const order = lead ? [lead, ...GROUPS.filter(g => g !== lead)] : GROUPS;
  const groupRank = g => {
    const i = order.indexOf(g);
    return i < 0 ? order.length : i;
  };
  return items
    .map((item, index) => ({item, index, g: groupRank(item.group), tier: item.tier ?? TIER.exact,
      score: item.frecency === false ? 0 : frecencyScore(frecency[item.id], at)}))
    .sort((a, b) => a.g - b.g || a.tier - b.tier || b.score - a.score || a.index - b.index)
    .map(r => r.item);
}

// ---------------------------------------------------------------------------------------------------------------
// Context helpers

const read = s => (s && typeof s === 'object' && 'value' in s ? (typeof s.peek === 'function' ? s.peek() : s.value) : s);
const live = list => (Array.isArray(list) ? list.filter(x => x && !x.deleted) : []);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The open song as the providers see it, or null. */
function songOf(ctx) {
  const session = ctx.session;
  const map = session?.map;
  if (!map) return null;
  const practice = read(session.practice?.value) ?? {};
  const bars = Array.isArray(map.bars) ? map.bars : [];
  return {
    session, map, mapped: !!map.isReal, duration: Number(map.duration) || 0, bars,
    sections: map.isReal && Array.isArray(map.sections) ? map.sections : [],
    spots: live(practice.spots), markers: live(practice.markers).slice().sort((a, b) => a.t - b.t),
    trainer: practice.trainer ?? null,
  };
}

const lastDisplay = song => song.bars.reduce((n, b) => (b.display != null ? Math.max(n, b.display) : n), 0);
const barByDisplay = (song, n) => song.bars.find(b => b.display === n) ?? null;
const tenths = s => (Number.isInteger(s) ? formatClock(s) : `${formatClock(s)}.${Math.round((s % 1) * 10) % 10}`);

function transportOf(ctx) {
  const t = ctx.transport ?? ctx.session?.transport ?? null;
  return t && typeof t === 'object' ? t : null;
}

const STEM_LABELS = {drums: 'Drums', bass: 'Bass', vocals: 'Vocals', guitar: 'Guitar', piano: 'Piano', other: 'Other'};
const STEM_ALIASES = {keys: 'piano', keyboard: 'piano', vox: 'vocals', voice: 'vocals', vocal: 'vocals', kit: 'drums', drum: 'drums'};
const stemLabel = name => STEM_LABELS[name] ?? String(name).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

function tracksOf(transport) {
  const snap = read(transport?.snapshot);
  return Array.isArray(snap?.mix?.tracks) ? snap.mix.tracks : [];
}

/** The tracks a typed stem name refers to, best match first. */
function stemsMatching(tracks, typed) {
  const q = normalizeText(typed);
  const alias = STEM_ALIASES[q];
  return tracks
    .map(track => {
      const names = [track.name, stemLabel(track.name)];
      const tier = alias === track.name ? TIER.exact : bestTier(names, q);
      return {track, tier};
    })
    .filter(r => r.tier != null)
    .sort((a, b) => a.tier - b.tier);
}

// ---------------------------------------------------------------------------------------------------------------
// Built-in providers

function commandRow(reg, ctx, id, {args, title, subtitle, group = 'commands', tier = TIER.parsed, rowId, icon: iconName,
  frecency = false, lead = false, modLabel, modRun} = {}) {
  const def = reg.get(id);
  if (!def) return null;
  const state = reg.state(id, ctx);
  if (!state?.visible) return null;
  return {
    id: rowId ?? `cmd:${id}`, group, tier, title: title ?? state.title, subtitle, keys: def.keys[0], icon: iconName ?? def.icon,
    disabled: state.reason ?? undefined, frecency, lead, modLabel,
    run: (c, {mod} = {}) => {
      if (mod && modRun) return modRun(c);
      return reg.run(id, {source: 'palette', args});
    },
  };
}

function transportRow(ctx, {id, title, subtitle, group = 'commands', tier = TIER.parsed, icon: iconName, disabled, run, lead = false, modLabel, modRun}) {
  const transport = transportOf(ctx);
  if (!transport) return null;
  return {
    id, group, tier, title, subtitle, icon: iconName, disabled, frecency: false, lead, modLabel,
    run: (c, {mod} = {}) => (mod && modRun ? modRun(transportOf(c) ?? transport) : run(transportOf(c) ?? transport)),
  };
}

function songSearch(reg) {
  return (query, ctx) => {
    const song = songOf(ctx);
    if (!song) return [];
    const parsed = parseQuery(query);
    const out = [];
    const goTo = (t, title, {rowId, subtitle, loop} = {}) => commandRow(reg, ctx, 'nav.goTo', {
      args: {t}, title, subtitle, group: 'song', rowId, icon: 'arrow-right',
      modLabel: loop ? 'Loop' : undefined,
      modRun: loop ? c => loop(transportOf(c)) : undefined,
    });
    // bar 57 / b57 / 57
    if (parsed.bar != null) {
      if (song.mapped) {
        const bar = barByDisplay(song, parsed.bar);
        if (bar) {
          out.push(goTo(bar.t0, `Go to bar ${parsed.bar}`, {
            rowId: 'q:bar', subtitle: bar.label || undefined, loop: t => t?.loopBars(bar.t0, 1),
          }));
        } else if (!(parsed.bare != null && parsed.bare >= SPEED_MIN && parsed.bare <= SPEED_MAX)) {
          // A bare number that is also a valid speed offers only the speed when the bar does not exist.
          const row = goTo(0, `Go to bar ${parsed.bar}`, {rowId: 'q:bar'});
          if (row) out.push({...row, disabled: `This song has ${plural(lastDisplay(song), 'bar')}.`});
        }
      } else if (parsed.bar <= song.duration) {
        out.push(goTo(parsed.bar, `Go to ${formatClock(parsed.bar)}`, {rowId: 'q:bar'}));
      } else if (!(parsed.bare != null && parsed.bare >= SPEED_MIN && parsed.bare <= SPEED_MAX)) {
        const row = goTo(0, `Go to ${formatClock(parsed.bar)}`, {rowId: 'q:bar'});
        if (row) out.push({...row, disabled: `This song is ${formatClock(song.duration)} long.`});
      }
    }
    // 1:12
    if (parsed.time != null) {
      const row = goTo(Math.min(parsed.time, song.duration), `Go to ${tenths(parsed.time)}`, {rowId: 'q:time'});
      if (row) out.push(parsed.time <= song.duration ? row : {...row, disabled: `This song is ${formatClock(song.duration)} long.`});
    }
    const named = parsed.loop || parsed.count || parsed.trainer || parsed.only || parsed.minus || parsed.mute;
    if (named || parsed.speedExplicit) return out.filter(Boolean);
    const text = parsed.bare != null || parsed.time != null || parsed.bar != null ? null : query;
    const loopRange = (t0, t1, label) => tr => tr?.loopRange(t0, t1, {label, snap: song.mapped ? 'bar' : 'none'});
    if (text !== null) {
      // Sections (mapped) and the marker regions they would be on an unmapped song.
      for (const section of song.sections) {
        const tier = bestTier([section.name, section.label], text);
        if (tier == null) continue;
        const first = song.bars[section.startBar]?.display, last = song.bars[section.endBar]?.display;
        const row = goTo(section.t0, section.name, {
          rowId: `section:${song.session.id ?? ''}:${section.name}`,
          subtitle: first != null && last != null ? `Section · bars ${first}–${last}` : 'Section',
          loop: loopRange(section.t0, section.t1, section.name),
        });
        if (row) out.push({...row, tier, frecency: true, icon: 'flag'});
      }
      for (const spot of song.spots) {
        const tier = bestTier([spot.name], text);
        if (tier == null) continue;
        const row = commandRow(reg, ctx, 'spot.open', {
          args: {id: spot.id}, title: spot.name, group: 'song', tier, rowId: `spot:${spot.id}`, icon: 'diamond', frecency: true,
          subtitle: `Spot · ${Math.round((spot.rate ?? 1) * 100)}%`,
        });
        if (row) out.push(row);
      }
      song.markers.forEach((marker, i) => {
        const tier = bestTier([marker.label], text);
        if (tier == null) return;
        const end = song.markers[i + 1]?.t ?? song.duration;
        const row = goTo(marker.t, marker.label, {
          rowId: `marker:${marker.id}`, subtitle: `Marker · ${formatClock(marker.t)}`,
          loop: end > marker.t ? loopRange(marker.t, end, marker.label) : undefined,
        });
        if (row) out.push({...row, tier, frecency: true, icon: 'bookmark'});
      });
    }
    return out.filter(Boolean);
  };
}

function commandSearch(reg) {
  return (query, ctx) => {
    const parsed = parseQuery(query);
    const song = songOf(ctx);
    const out = [];
    // Speed N%
    if (parsed.speed != null) {
      const n = parsed.speed;
      const inRange = n >= SPEED_MIN && n <= SPEED_MAX;
      if (inRange || parsed.speedExplicit) {
        const rate = Math.round(n) / 100;
        const row = commandRow(reg, ctx, 'speed.set', {args: {rate}, title: `Speed ${Math.round(n)}%`, rowId: 'q:speed', icon: 'gauge',
          lead: parsed.bare != null && !song?.mapped});
        if (row) out.push(inRange ? row : {...row, disabled: `Speed goes from ${SPEED_MIN}% to ${SPEED_MAX}%.`});
      }
    }
    // loop 41-48 / loop 1:10-1:20 / loop chorus
    if (parsed.loop && song) {
      const loop = parsed.loop;
      if (loop.name != null) {
        const regions = song.mapped
          ? song.sections.map(s => ({name: s.name, label: s.label, t0: s.t0, t1: s.t1}))
          : song.markers.map((m, i) => ({name: m.label, t0: m.t, t1: song.markers[i + 1]?.t ?? song.duration}));
        for (const region of regions) {
          const tier = bestTier([region.name, region.label], loop.name);
          if (tier == null || !(region.t1 > region.t0)) continue;
          const row = transportRow(ctx, {id: `q:loop:${region.name}`, title: `Loop ${region.name}`, icon: 'repeat', tier: TIER.parsed + tier / 10,
            run: t => t.loopRange(region.t0, region.t1, {label: region.name, snap: song.mapped ? 'bar' : 'none'})});
          if (row) out.push(row);
        }
      } else {
        const from = Math.min(loop.from, loop.to), to = Math.max(loop.from, loop.to);
        if (song.mapped && loop.unit === 'number') {
          const a = barByDisplay(song, from), b = barByDisplay(song, to);
          const label = from === to ? `Bar ${from}` : `Bars ${from}–${to}`;
          const row = transportRow(ctx, {id: 'q:loop', title: `Loop ${from === to ? `bar ${from}` : `bars ${from}–${to}`}`, icon: 'repeat',
            disabled: a && b ? undefined : `This song has ${plural(lastDisplay(song), 'bar')}.`,
            run: t => t.loopRange(a.t0, b.t1, {label, snap: 'bar'})});
          if (row) out.push(row);
        } else {
          const valid = to > from && to <= song.duration + 1e-6;
          const label = `${tenths(from)}–${tenths(to)}`;
          const row = transportRow(ctx, {id: 'q:loop', title: `Loop ${label}`, icon: 'repeat',
            disabled: valid ? undefined : to > from ? `This song is ${formatClock(song.duration)} long.` : 'A loop needs an end after its start.',
            run: t => t.loopRange(from, to, {label, snap: 'none'})});
          if (row) out.push(row);
        }
      }
    }
    // count 2 bars / beats
    if (parsed.count && song) {
      const {length, unit} = parsed.count;
      const ok = length >= 1 && length <= 16;
      const word = unit === 'bars' ? 'bar' : 'beat';
      const row = transportRow(ctx, {id: 'q:count', title: `Count in ${plural(length, word)}`, icon: 'count-in',
        subtitle: song.mapped ? undefined : 'A 2 s lead-in until the song has a bar grid',
        disabled: ok ? undefined : `A count-in is 1 to 16 ${unit}.`,
        run: t => t.setCountIn({on: true, length, unit})});
      if (row) out.push(row);
    }
    // trainer 70 100 [step]
    if (parsed.trainer) {
      const {start, end} = parsed.trainer;
      const step = parsed.trainer.step ?? Math.round((song?.trainer?.step ?? 0.05) * 100);
      const passes = song?.trainer?.passes ?? 2;
      const ok = start >= SPEED_MIN && end <= SPEED_MAX && start < end && step >= 1 && step <= 25;
      const row = commandRow(reg, ctx, 'trainer.toggle', {
        args: {start: start / 100, end: end / 100, step: step / 100, passes},
        title: `Trainer ${start}% → ${end}%`, subtitle: `+${step}% every ${plural(passes, 'pass', 'passes')}`, rowId: 'q:trainer', icon: 'trainer',
      });
      if (row) out.push(ok ? row : {...row, disabled: `The trainer goes up from ${SPEED_MIN}% to at most ${SPEED_MAX}%, in steps of 1–25%.`});
    }
    // only <stem> / minus <stem> / mute <stem>
    const transport = transportOf(ctx);
    const tracks = tracksOf(transport);
    if (typeof parsed.only === 'string' && normalizeText(parsed.only) !== 'me') {
      for (const {track, tier} of stemsMatching(tracks, parsed.only)) {
        const row = transportRow(ctx, {id: `q:only:${track.name}`, title: `Only ${stemLabel(track.name)}`, icon: 'headphones', tier: TIER.parsed + tier / 10,
          run: t => {
            for (const other of tracksOf(t)) if (other.soloed && other.name !== track.name) t.setSoloed(other.name, false);
            t.setSoloed(track.name, true);
          }});
        if (row) out.push(row);
      }
    }
    if (typeof parsed.minus === 'string' && normalizeText(parsed.minus) !== 'me') {
      for (const {track, tier} of stemsMatching(tracks, parsed.minus)) {
        const row = transportRow(ctx, {id: `q:minus:${track.name}`, title: `Mute ${stemLabel(track.name)}`, icon: 'volume-x', tier: TIER.parsed + tier / 10,
          run: t => t.setMuted(track.name, true)});
        if (row) out.push(row);
      }
    }
    if (parsed.mute) {
      for (const {track, tier} of stemsMatching(tracks, parsed.mute.name)) {
        const on = parsed.mute.on ? !track.muted : false;
        const row = transportRow(ctx, {id: `q:mute:${track.name}`, title: `${on ? 'Mute' : 'Unmute'} ${stemLabel(track.name)}`,
          icon: on ? 'volume-x' : 'volume-2', tier: TIER.parsed + tier / 10, run: t => t.setMuted(track.name, on)});
        if (row) out.push(row);
      }
    }
    // Registry commands by title, menu label and keywords.
    const text = normalizeText(query);
    for (const def of reg.all()) {
      if (PARSED_ONLY.includes(def.id) || NAV_RE.test(def.id) || def.palette?.hidden) continue;
      const state = reg.state(def.id, ctx);
      if (!state?.visible) continue;
      const tier = text ? bestTier([state.title, def.menu?.label, ...(def.palette?.keywords ?? [])], text) : TIER.exact;
      if (tier == null) continue;
      out.push({
        id: `cmd:${def.id}`, group: 'commands', tier, title: state.title, keys: def.keys[0], icon: def.icon,
        disabled: state.reason ?? undefined,
        run: () => reg.run(def.id, {source: 'palette'}),
      });
    }
    return out.filter(Boolean);
  };
}

function songsSearch() {
  return (query, ctx) => {
    if (!settings.songs || ctx.session?.shareToken) return [];
    const router = ctx.router;
    if (!router?.navigate) return [];
    const songs = read((ctx.store ?? appStore)?.library?.songs);
    const rows = songs instanceof Map ? [...songs.values()] : Array.isArray(songs) ? songs : [];
    const text = normalizeText(query);
    const out = [];
    for (const song of rows) {
      if (!song?.id || !song.title) continue;
      const tier = text ? bestTier([song.title, song.artist, song.album], text) : TIER.exact;
      if (tier == null) continue;
      const id = song.id;
      out.push({
        id: `song:${id}`, group: 'songs', tier, title: song.title, subtitle: song.artist || undefined, icon: 'music',
        modLabel: 'Details', recent: Number(song.lastPracticedAt) || 0,
        run: (c, {mod} = {}) => (c.router ?? router).navigate(mod ? `/s/${encodeURIComponent(id)}/edit/details` : `/s/${encodeURIComponent(id)}`),
      });
    }
    if (!text) out.sort((a, b) => b.recent - a.recent);
    return out;
  };
}

function navigationSearch(reg) {
  return (query, ctx) => {
    if (!settings.navigation || ctx.session?.shareToken) return [];
    const text = normalizeText(query);
    const out = [];
    for (const def of reg.all()) {
      if (!NAV_RE.test(def.id) || def.palette?.hidden) continue;
      const state = reg.state(def.id, ctx);
      if (!state?.visible) continue;
      const tier = text ? bestTier([state.title, def.menu?.label, ...(def.palette?.keywords ?? [])], text) : TIER.exact;
      if (tier == null) continue;
      out.push({
        id: `nav:${def.id}`, group: 'navigation', tier, title: state.title, keys: def.keys[0], icon: def.icon,
        disabled: state.reason ?? undefined, run: () => reg.run(def.id, {source: 'palette'}),
      });
    }
    return out;
  };
}

const settings = {songs: true, navigation: true};

/** Turns the song-title and navigation providers on or off (the Shared Stage turns both off). */
export function configurePalette({songs = true, navigation = true} = {}) {
  settings.songs = !!songs;
  settings.navigation = !!navigation;
}

const BUILTINS = [
  {id: 'builtin:song', group: 'song', make: songSearch},
  {id: 'builtin:commands', group: 'commands', make: commandSearch},
  {id: 'builtin:songs', group: 'songs', make: songsSearch},
  {id: 'builtin:navigation', group: 'navigation', make: navigationSearch},
];
export const BUILTIN_PROVIDERS = Object.freeze(BUILTINS.map(b => b.id));
const custom = [];   // [{id, group, search}] in registration order

/** Adds a provider. See the header. */
export function registerProvider({id, group, search} = {}) {
  if (typeof id !== 'string' || !id) throw new TypeError('registerProvider: an id is required');
  if (!GROUPS.includes(group)) throw new RangeError(`registerProvider: group must be one of ${GROUPS.join(', ')}`);
  if (typeof search !== 'function') throw new TypeError('registerProvider: search(query, ctx) is required');
  const entry = {id, group, search};
  custom.push(entry);
  return () => {
    const at = custom.indexOf(entry);
    if (at >= 0) custom.splice(at, 1);
  };
}

function providersFor(reg) {
  const list = BUILTINS.map(b => ({id: b.id, group: b.group, search: b.make(reg)}));
  for (const entry of custom) {
    const at = list.findIndex(p => p.id === entry.id);
    if (at >= 0) list[at] = entry; else list.push(entry);
  }
  return list;
}

/** Every row for `query`, ranked and limited per group. `ctx` defaults to a fresh registry context. */
export function paletteItems(query = '', {registry = appRegistry, ctx = registry.context({source: 'palette'})} = {}) {
  const items = [];
  for (const provider of providersFor(registry)) {
    let found;
    try { found = provider.search(query, ctx) ?? []; } catch (err) { console.error(err); continue; }
    for (const item of found) {
      if (!item || !item.title || typeof item.run !== 'function') continue;
      items.push({...item, group: GROUPS.includes(item.group) ? item.group : provider.group, id: item.id ?? `${provider.id}:${item.title}`});
    }
  }
  const ranked = rankItems(items, {frecency: readFrecency()});
  const limits = normalizeText(query) ? LIMITS : EMPTY_LIMITS;
  const counts = {};
  const seen = new Set();
  return ranked.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    counts[item.group] = (counts[item.group] ?? 0) + 1;
    return counts[item.group] <= (limits[item.group] ?? Infinity);
  });
}

/** 'band' (a full-width top sheet) in the Stage's band layout or on a narrow screen, else 'center'. Pure. */
export function paletteLayout({stageLayout = null, width = Infinity} = {}) {
  return stageLayout === 'band' || width < BAND_WIDTH ? 'band' : 'center';
}

// ---------------------------------------------------------------------------------------------------------------
// The overlay

let openHandle = null;
let paletteSeq = 0;

/** Opens the palette (or returns the open one). See the header. */
export function openPalette({query = '', registry = appRegistry} = {}) {
  if (openHandle?.open) {
    if (query) openHandle.setQuery(query);
    return openHandle;
  }
  const doc = globalThis.document;
  const seq = ++paletteSeq;
  const ids = {list: `app-palette-${seq}-list`, input: `app-palette-${seq}-input`};
  const previous = doc.activeElement;
  const stageLayout = appStore.stage.peek()?.layout ?? doc.querySelector('[data-stage-layout]')?.getAttribute('data-stage-layout') ?? null;
  const layout = paletteLayout({stageLayout, width: doc.defaultView?.innerWidth ?? Infinity});

  const input = h('input', {
    id: ids.input, class: 'app-palette-input', type: 'text', role: 'combobox', autocomplete: 'off', spellcheck: false,
    'aria-label': 'Search commands, sections and songs', 'aria-expanded': 'true', 'aria-controls': ids.list,
    'aria-autocomplete': 'list', placeholder: 'Type a command, bar, section or song…', value: query,
  });
  const list = h('div', {id: ids.list, class: 'app-palette-list', role: 'listbox', 'aria-label': 'Results'});
  const empty = h('p', {class: 'app-palette-empty', hidden: true});
  const footer = h('div', {class: 'app-palette-footer', 'aria-hidden': 'true'},
    h('span', {}, Kbd({keys: 'Enter'}).el, ' Run'),
    h('span', {}, Kbd({keys: 'Mod+Enter'}).el, ' Loop or open details'),
    h('span', {}, Kbd({keys: 'Escape'}).el, ' Close'));
  const box = h('div', {class: 'app-palette-box'},
    h('div', {class: 'app-palette-field'}, icon('search'), input), list, empty, footer);
  const el = h('dialog', {class: 'app-palette', 'aria-label': 'Command palette', dataset: {layout}}, box);

  let items = [];
  let active = -1;
  let open = true;
  const cleanups = [];
  const optionId = i => `app-palette-${seq}-opt-${i}`;

  const setActive = (index, {scroll = true} = {}) => {
    if (!items.length) { active = -1; input.removeAttribute('aria-activedescendant'); return; }
    active = Math.max(0, Math.min(items.length - 1, index));
    for (const row of list.querySelectorAll('[role=option]')) {
      const on = Number(row.dataset.index) === active;
      row.setAttribute('aria-selected', String(on));
    }
    input.setAttribute('aria-activedescendant', optionId(active));
    if (scroll) doc.getElementById(optionId(active))?.scrollIntoView?.({block: 'nearest'});
  };

  const renderRow = (item, index) => {
    const reasonId = `${optionId(index)}-reason`;
    const row = h('div', {
      id: optionId(index), class: 'app-palette-row', role: 'option', 'aria-selected': 'false',
      dataset: {index: String(index), itemId: item.id, group: item.group},
      on: {
        pointermove: () => { if (active !== index) setActive(index, {scroll: false}); },
        pointerdown: e => e.preventDefault(),   // keep the focus in the input
        click: e => runItem(index, {mod: isMacLike() ? e.metaKey : e.ctrlKey}),
      },
    },
    h('span', {class: 'app-palette-icon', 'aria-hidden': 'true'}, item.icon ? icon(item.icon) : null),
    h('span', {class: 'app-palette-text'},
      h('span', {class: 'app-palette-title'}, item.title),
      item.subtitle ? h('span', {class: 'app-palette-sub'}, item.subtitle) : null,
      item.disabled ? h('span', {class: 'app-palette-reason', id: reasonId}, item.disabled) : null),
    item.modLabel && !item.disabled ? h('span', {class: 'app-palette-mod', 'aria-hidden': 'true'}, Kbd({keys: 'Mod+Enter'}).el, ` ${item.modLabel}`) : null,
    item.keys ? Kbd({keys: item.keys, className: 'app-palette-key'}).el : null);
    if (item.disabled) {
      row.setAttribute('aria-disabled', 'true');
      row.setAttribute('aria-describedby', reasonId);
    }
    return row;
  };

  const render = ({announceCount = false} = {}) => {
    const q = input.value;
    const keep = announceCount ? null : items[active]?.id;
    try {
      items = paletteItems(q, {registry});
    } catch (err) {
      console.error(err);
      items = [];
    }
    const groups = [];
    items.forEach((item, index) => {
      let g = groups[groups.length - 1];
      if (!g || g.group !== item.group) groups.push(g = {group: item.group, rows: []});
      g.rows.push(renderRow(item, index));
    });
    list.replaceChildren(...groups.map(g => {
      const headingId = `app-palette-${seq}-g-${g.group}`;
      return h('div', {class: 'app-palette-group', role: 'group', 'aria-labelledby': headingId, dataset: {group: g.group}},
        h('div', {class: 'app-palette-heading', id: headingId, role: 'presentation'}, GROUP_LABELS[g.group]),
        ...g.rows);
    }));
    list.hidden = !items.length;
    empty.hidden = !!items.length;
    empty.textContent = items.length ? '' : q.trim() ? `No matches for “${q.trim()}”` : 'Nothing to show yet.';
    // A re-render while the query is unchanged (a registry or state change) keeps the active row.
    const kept = keep ? items.findIndex(i => i.id === keep) : -1;
    const first = items.findIndex(i => !i.disabled);
    setActive(kept >= 0 ? kept : first >= 0 ? first : 0, {scroll: kept < 0});
    if (announceCount && q.trim()) announce(items.length ? plural(items.length, 'result') : 'No matches', {key: 'palette-results', throttleMs: 800});
  };

  function close(reason = 'close') {
    if (!open) return;
    open = false;
    for (const fn of cleanups.splice(0).reverse()) fn();
    if (el.open) el.close();
    el.remove();
    restoreFocus(previous, el);
    if (openHandle === handle) openHandle = null;
    el.dataset.closed = reason;
  }

  function runItem(index, {mod = false} = {}) {
    const item = items[index];
    if (!item) return;
    if (item.disabled) {
      announce(item.disabled, {key: 'palette-reason', throttleMs: 0});
      return;
    }
    close('select');
    if (item.frecency !== false) recordUse(item.id);
    try {
      item.run(registry.context({source: 'palette'}), {mod});
    } catch (err) {
      console.error(err);
    }
  }

  const onKeydown = e => {
    if (e.isComposing) return;
    const mod = isMacLike() ? e.metaKey : e.ctrlKey;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive(active + 1); break;
      case 'ArrowUp': e.preventDefault(); setActive(active - 1); break;
      case 'PageDown': e.preventDefault(); setActive(active + 8); break;
      case 'PageUp': e.preventDefault(); setActive(active - 8); break;
      case 'Enter': e.preventDefault(); runItem(active, {mod}); break;
      case 'Escape': if (!e.defaultPrevented) { e.preventDefault(); close('escape'); } break;
      default:
        if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyK') { e.preventDefault(); close('toggle'); }
    }
  };
  input.addEventListener('keydown', onKeydown);
  input.addEventListener('input', () => render({announceCount: true}));
  el.addEventListener('cancel', e => { e.preventDefault(); close('escape'); });
  el.addEventListener('click', e => { if (e.target === el) close('outside'); });

  const handle = {
    el,
    get open() { return open; },
    get items() { return items.slice(); },
    setQuery(q) {
      if (!open) return;
      input.value = String(q ?? '');
      render({announceCount: true});
    },
    close: () => close('close'),
  };
  openHandle = handle;

  closeAllMenus('dialog');
  layerHost(doc).append(el);
  el.showModal();
  cleanups.push(pushModalHost(el), trackLayer(el), trapTab(el));
  cleanups.push(pushOverlay({el, modal: true, scope: 'palette', onEscape: () => close('escape')}));
  cleanups.push(registry.onChange(change => { if (change?.type === 'registry' || change?.type === 'state') render(); }));
  el.__uiClose = reason => close(reason);
  render();
  input.focus({preventScroll: true});
  input.select?.();
  return handle;
}
