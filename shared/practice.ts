/**
 * Practice blob v2 (architecture §2.21): the per-song practice state the Stage
 * saves (cue, loop, speed, mix, click, trainer, spots, markers), plus the pure
 * helpers the client and the Convex functions share:
 *
 * - `upgradePractice` reads every stored shape (v1 blobs, v2 blobs, garbage)
 *   and the 1.9 click settings that used to live in `tempo` (D51), and returns
 *   a sanitised v2 value. It is a cheap one-way upgrade with no UI.
 * - `mergePractice` merges this device's state with the server's before a save.
 * - `prunePractice` keeps a blob under `PRACTICE_CAP` (B2).
 * - `summarize` builds the Library's `practiceSummary` (D5, D52).
 * - `sanitizeForShare` is what a share snapshot carries.
 *
 * Everything here is pure and never throws on malformed input. The file is
 * imported by Vite (client) and by Convex functions, so it uses nothing newer
 * than ES2021 and no browser or Node APIs.
 */

export const PRACTICE_CAP = 32_768;           // JSON.stringify length; B2 (server and client use this constant)
export const MAX_SPOTS = 24, MAX_MARKERS = 64, TOMBSTONE_DAYS = 30;
export const MIN_RATE = 0.25, MAX_RATE = 1.5;
export const MAX_TRACKS = 8;
export const MAX_NAME = 60, MAX_NOTE = 280;
export const PLAY_TIMES = [0, 2, 4, 8] as const;
export const SURFACES = ['chart', 'roadmap', 'stems'] as const;

const DAY_MS = 86_400_000;
const MAX_ID = 64;              // spot, marker and bar ids are UUIDs or short measure ids
const MAX_TRACK_NAME = 64;
const MIN_LOOP = 0.02;          // the engine refuses shorter loops (engine.setLoop)
const SECTION_EPS = 0.01;       // s: a loop "equals" a section within 10 ms
const BAR_EPS = 1e-3;           // s: a loop end on a bar line belongs to the bar before it

export type BarRef = {id: string; beat: number; frac?: number};   // measure id, 0-based group index, fraction 0..1 within the group
export type Spot = {id: string; name: string /* ≤ 60 */; a: number; b: number; aBar?: BarRef; bBar?: BarRef; rate: number;
                    note?: string /* ≤ 280 */; lastAt?: number; passes: number; updatedAt: number; deleted?: true};
export type Marker = {id: string; t: number; label: string /* ≤ 60 */; updatedAt: number; deleted?: true};
export type Surface = typeof SURFACES[number];
export type PlayTimes = typeof PLAY_TIMES[number];
export type Between = 'none' | 'rest' | 'call';
export type ChartAudio = 'off' | 'quiet' | 'loud';
export type ClickMode = 'off' | 'countin' | 'always';
export type CountIn = {on: boolean; length: number /* 1–16 */; unit: 'bars' | 'beats'};
export type Click = {countIn: CountIn; mode: ClickMode; lastMode?: 'off' | 'countin'; accent: boolean; volume: number /* 0..1 */; preRoll: boolean};
export type Loop = {on: boolean; a: number; b: number; aBar?: BarRef; bBar?: BarRef;
                    eachPassCount: boolean; playTimes: PlayTimes; between: Between};
export type Track = {name: string; volume: number; muted: boolean; soloed: boolean};
export type Trainer = {start: number; end: number; step: number; passes: number};
export type PracticeV2 = {
  v: 2;
  lastAt?: number;                       // ms epoch; written once per session (first Play)
  cue: number;                           // s, 0..duration
  surface?: Surface;                     // absent → surfaceDefault()
  anchorBar?: number; anchorTime?: number;
  rate: number; lastRate?: number;       // 0.25..1.5
  keepPitch?: boolean;                   // absent → account.practice.keepPitch
  loop: Loop;
  tracks: Track[];                       // ≤ 8
  minusMe: boolean; onlyMe?: boolean;
  chartAudio?: ChartAudio;               // D27; absent → 'off'
  click?: Click;                         // D14, D51; absent → account defaults
  trainer: Trainer | null;
  spots: Spot[]; markers: Marker[];
};
/** `account.practice` (§2.4). Only `eachPassCount` seeds a stored value here; the rest apply at read time (D14). */
export type AccountPracticeDefaults = {
  stop?: 'cue' | 'stay';
  countIn?: Partial<CountIn>;
  click?: ClickMode;
  eachPassCount?: boolean;
  keepPitch?: boolean;
  wake?: 5 | 10 | 30 | 'always';
};
export type PracticeSummary = {loopLabel?: string; rate: number; minusMe: boolean; surface?: string; spotCount: number;
                               spots: {id: string; name: string; rate: number}[]};
/** What `summarize` reads from the map. `name` (display, 'Chorus 2') wins over `label`; `bars` enables 'Bars x–y loop'. */
export type SummarySection = {label: string; name?: string; t0: number; t1: number};
export type SummaryBar = {display: number | null; t0: number; t1: number};
export type SummaryMap = {sections: SummarySection[]; bars?: SummaryBar[]};

/* ---------- value readers (never throw) ---------- */

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const bool = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const oneOf = <T extends string | number>(value: unknown, list: readonly T[]): T | undefined =>
  (list as readonly unknown[]).indexOf(value) >= 0 ? value as T : undefined;
const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' ? value.trim().slice(0, max) : undefined;
const id = (value: unknown): string | undefined => {
  const s = typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  return s && s.length <= MAX_ID ? s : undefined;
};
const time = (value: unknown, duration?: number): number | undefined => {
  const t = num(value);
  if (t === undefined) return undefined;
  return duration ? clamp(t, 0, duration) : Math.max(0, t);
};
const rateOf = (value: unknown): number | undefined => {
  const r = num(value);
  return r === undefined || r <= 0 ? undefined : clamp(r, MIN_RATE, MAX_RATE);
};
const stamp = (value: unknown): number => Math.max(0, num(value) ?? 0);
/** Practice values are plain JSON, so a JSON round trip is a complete deep copy (and safe in every runtime). */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function barRef(value: unknown): BarRef | undefined {
  if (!isObj(value)) return undefined;
  const ref = id(value.id), beat = num(value.beat);
  if (!ref || beat === undefined) return undefined;
  const out: BarRef = {id: ref, beat: Math.max(0, Math.floor(beat))};
  const frac = num(value.frac);
  if (frac !== undefined) out.frac = clamp(frac, 0, 1);
  return out;
}

/* ---------- empty and upgrade ---------- */

export function emptyPractice(): PracticeV2 {
  return {
    v: 2, cue: 0, rate: 1,
    loop: {on: false, a: 0, b: 0, eachPassCount: true, playTimes: 0, between: 'none'},
    tracks: [], minusMe: false, trainer: null, spots: [], markers: [],
  };
}

function loopOf(raw: unknown, eachPassDefault: boolean, v1: boolean): Loop {
  const loop: Loop = {on: false, a: 0, b: 0, eachPassCount: eachPassDefault, playTimes: 0, between: 'none'};
  if (!isObj(raw)) return loop;
  let a = time(raw.a) ?? 0, b = time(raw.b) ?? 0;
  if (b < a) [a, b] = [b, a];
  loop.a = a; loop.b = b;
  loop.on = (v1 ? raw.enabled === true : raw.on === true) && b - a >= MIN_LOOP;
  if (v1) return loop;
  const aBar = barRef(raw.aBar), bBar = barRef(raw.bBar);
  if (aBar) loop.aBar = aBar;
  if (bBar) loop.bBar = bBar;
  loop.eachPassCount = bool(raw.eachPassCount) ?? eachPassDefault;
  loop.playTimes = oneOf(raw.playTimes, PLAY_TIMES) ?? 0;
  loop.between = oneOf(raw.between, ['none', 'rest', 'call'] as const) ?? 'none';
  return loop;
}

function tracksOf(raw: unknown): Track[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>(), out: Track[] = [];
  for (const t of raw) {
    if (out.length >= MAX_TRACKS) break;
    if (!isObj(t)) continue;
    const name = text(t.name, MAX_TRACK_NAME);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({name, volume: clamp(num(t.volume) ?? 1, 0, 1), muted: t.muted === true, soloed: t.soloed === true});
  }
  return out;
}

function countInOf(raw: unknown): CountIn {
  const c = isObj(raw) ? raw : {};
  return {
    on: c.on === true,
    length: clamp(Math.round(num(c.length) ?? 1), 1, 16),
    unit: c.unit === 'beats' ? 'beats' : 'bars',
  };
}

function clickOf(raw: unknown): Click | undefined {
  if (!isObj(raw)) return undefined;
  const click: Click = {
    countIn: countInOf(raw.countIn),
    mode: oneOf(raw.mode, ['off', 'countin', 'always'] as const) ?? 'countin',
    accent: bool(raw.accent) ?? true,
    volume: clamp(num(raw.volume) ?? 0.7, 0, 1),
    preRoll: raw.preRoll === true,
  };
  const lastMode = oneOf(raw.lastMode, ['off', 'countin'] as const);
  if (lastMode) click.lastMode = lastMode;
  return click;
}

const LEGACY_CLICK_FIELDS = ['countIn', 'countInLength', 'countInUnit', 'enabled', 'accent', 'volume', 'audiblePreRoll'];

/** The 1.9 click settings stored in `tempo` (D51), or undefined when none is present. */
function legacyClick(tempo: unknown): Click | undefined {
  if (!isObj(tempo) || !LEGACY_CLICK_FIELDS.some(key => tempo[key] !== undefined && tempo[key] !== null)) return undefined;
  return {
    countIn: {
      on: tempo.countIn === true,
      length: clamp(Math.round(num(tempo.countInLength) ?? 1), 1, 16),
      unit: tempo.countInUnit === 'beats' ? 'beats' : 'bars',
    },
    mode: tempo.enabled === true ? 'always' : 'countin',
    accent: bool(tempo.accent) ?? true,
    volume: clamp(num(tempo.volume) ?? 0.7, 0, 1),
    preRoll: tempo.audiblePreRoll === true,
  };
}

function trainerOf(raw: unknown): Trainer | null {
  if (!isObj(raw)) return null;
  const start = rateOf(raw.start), end = rateOf(raw.end), step = num(raw.step), passes = num(raw.passes);
  if (start === undefined || end === undefined || step === undefined || passes === undefined || step <= 0) return null;
  return {start, end, step: clamp(step, 0.01, MAX_RATE - MIN_RATE), passes: clamp(Math.round(passes), 1, 32)};
}

/** Newest `updatedAt` wins; on a tie a tombstone wins; on a full tie the first one seen (`a`) wins. */
function newer<T extends {updatedAt: number; deleted?: true}>(a: T, b: T): T {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt > a.updatedAt ? b : a;
  return b.deleted && !a.deleted ? b : a;
}

/** Dedupes by id (newest wins) and caps live items and tombstones separately, keeping the newest of each. */
function capList<T extends {id: string; updatedAt: number; deleted?: true}>(items: T[], max: number): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    const prev = byId.get(item.id);
    byId.set(item.id, prev ? newer(prev, item) : item);
  }
  const unique = Array.from(byId.values());
  const keep = new Set<T>();
  for (const deleted of [false, true]) {
    unique.filter(item => !!item.deleted === deleted)
      .sort((x, y) => y.updatedAt - x.updatedAt)
      .slice(0, max)
      .forEach(item => keep.add(item));
  }
  return unique.filter(item => keep.has(item));
}

function spotOf(raw: unknown): Spot | undefined {
  if (!isObj(raw)) return undefined;
  const sid = id(raw.id);
  if (!sid) return undefined;
  let a = time(raw.a), b = time(raw.b);
  const deleted = raw.deleted === true;
  if (a === undefined || b === undefined) {
    if (!deleted) return undefined;
    a = a ?? 0; b = b ?? a;
  }
  if (b < a) [a, b] = [b, a];
  if (!deleted && b - a < MIN_LOOP) return undefined;
  const spot: Spot = {
    id: sid, name: text(raw.name, MAX_NAME) || 'Spot', a, b, rate: rateOf(raw.rate) ?? 1,
    passes: Math.max(0, Math.floor(num(raw.passes) ?? 0)), updatedAt: stamp(raw.updatedAt),
  };
  const aBar = barRef(raw.aBar), bBar = barRef(raw.bBar);
  if (aBar) spot.aBar = aBar;
  if (bBar) spot.bBar = bBar;
  const note = text(raw.note, MAX_NOTE);
  if (note && !deleted) spot.note = note;
  const lastAt = num(raw.lastAt);
  if (lastAt !== undefined && lastAt >= 0) spot.lastAt = lastAt;
  if (deleted) spot.deleted = true;
  return spot;
}

function markerOf(raw: unknown): Marker | undefined {
  if (!isObj(raw)) return undefined;
  const mid = id(raw.id), t = time(raw.t);
  if (!mid || t === undefined) return undefined;
  const marker: Marker = {id: mid, t, label: text(raw.label, MAX_NAME) || 'Marker', updatedAt: stamp(raw.updatedAt)};
  if (raw.deleted === true) marker.deleted = true;
  return marker;
}

function listOf<T extends {id: string; updatedAt: number; deleted?: true}>(raw: unknown, read: (value: unknown) => T | undefined, max: number): T[] {
  if (!Array.isArray(raw)) return [];
  const items: T[] = [];
  for (const value of raw) {
    const item = read(value);
    if (item) items.push(item);
  }
  return capList(items, max);
}

function upgradeV2(raw: Obj, duration: number | undefined, eachPassDefault: boolean): PracticeV2 {
  const p = emptyPractice();
  const lastAt = num(raw.lastAt);
  if (lastAt !== undefined && lastAt >= 0) p.lastAt = lastAt;
  p.cue = time(raw.cue, duration) ?? 0;
  const surface = oneOf(raw.surface, SURFACES);
  if (surface) p.surface = surface;
  const anchorBar = num(raw.anchorBar);
  if (anchorBar !== undefined) p.anchorBar = Math.max(0, Math.floor(anchorBar));
  const anchorTime = time(raw.anchorTime, duration);
  if (anchorTime !== undefined) p.anchorTime = anchorTime;
  p.rate = rateOf(raw.rate) ?? 1;
  const lastRate = rateOf(raw.lastRate);
  if (lastRate !== undefined) p.lastRate = lastRate;
  const keepPitch = bool(raw.keepPitch);
  if (keepPitch !== undefined) p.keepPitch = keepPitch;
  p.loop = loopOf(raw.loop, eachPassDefault, false);
  p.tracks = tracksOf(raw.tracks);
  p.minusMe = raw.minusMe === true;
  if (raw.onlyMe === true) p.onlyMe = true;
  const chartAudio = oneOf(raw.chartAudio, ['off', 'quiet', 'loud'] as const);
  if (chartAudio) p.chartAudio = chartAudio;
  const click = clickOf(raw.click);
  if (click) p.click = click;
  p.trainer = trainerOf(raw.trainer);
  p.spots = listOf(raw.spots, spotOf, MAX_SPOTS);
  p.markers = listOf(raw.markers, markerOf, MAX_MARKERS);
  return p;
}

/** 1.9 blobs: `{loop: {enabled, a, b}, rate, grid, tracks}`. `grid` is dropped (the device pref took `ws.grid`). */
function upgradeV1(raw: Obj, eachPassDefault: boolean): PracticeV2 {
  const p = emptyPractice();
  p.rate = rateOf(raw.rate) ?? 1;
  p.loop = loopOf(raw.loop, eachPassDefault, true);
  p.tracks = tracksOf(raw.tracks);
  return p;
}

/**
 * Reads any stored practice value and returns a sanitised v2 blob.
 * - v2 → a sanitised copy (clamps, caps, drops unknown keys).
 * - v1 (no `v`, or `v: 1`) → v2 with `emptyPractice` defaults; `grid` is dropped.
 * - anything else → `emptyPractice()`.
 * `click` is kept when present; otherwise it comes from the legacy click fields
 * of `legacyTempo` (D51) when any is present; otherwise it stays absent so the
 * account defaults apply (D14). `defaults.eachPassCount` seeds `loop.eachPassCount`
 * when the stored loop has none. Pure; never throws.
 */
export function upgradePractice(raw: unknown, {duration, legacyTempo, defaults}: {duration?: number; legacyTempo?: unknown; defaults?: AccountPracticeDefaults} = {}): PracticeV2 {
  try {
    const span = num(duration) !== undefined && (duration as number) > 0 ? duration : undefined;
    const eachPassDefault = isObj(defaults) && typeof defaults.eachPassCount === 'boolean' ? defaults.eachPassCount : true;
    let p: PracticeV2;
    if (isObj(raw) && raw.v === 2) p = upgradeV2(raw, span, eachPassDefault);
    else if (isObj(raw) && (raw.v === undefined || raw.v === 1)) p = upgradeV1(raw, eachPassDefault);
    else {
      p = emptyPractice();
      p.loop.eachPassCount = eachPassDefault;
    }
    if (!p.click) {
      const click = legacyClick(legacyTempo);
      if (click) p.click = click;
    }
    return p;
  } catch {
    // Only reachable through hostile inputs (throwing getters or proxies).
    return emptyPractice();
  }
}

/* ---------- merge ---------- */

function mergeList<T extends {id: string; updatedAt: number; deleted?: true}>(local: T[], server: T[]): T[] {
  const out = new Map<string, T>();
  for (const item of local) out.set(item.id, out.has(item.id) ? newer(out.get(item.id) as T, item) : item);
  for (const item of server) out.set(item.id, out.has(item.id) ? newer(out.get(item.id) as T, item) : item);
  return Array.from(out.values()).map(item => copy(item));
}

/**
 * Merges this device's practice with the server's before a save.
 * - `spots` and `markers`: union by id; per id the larger `updatedAt` wins; ties → the tombstone wins.
 * - Every other top-level key: the local value when the key is in `dirty`, else the server value.
 * - `lastAt`: the larger of the two.
 */
export function mergePractice(local: PracticeV2, server: PracticeV2 | null, dirty: Set<string>): PracticeV2 {
  if (!server) return copy(local);
  const out: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(server), ...Object.keys(local)]);
  for (const key of keys) {
    if (key === 'v' || key === 'spots' || key === 'markers' || key === 'lastAt') continue;
    const source = dirty.has(key) ? local : server;
    const value = (source as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = copy(value);
  }
  const merged = out as PracticeV2;
  merged.v = 2;
  const lastAt = Math.max(num(local.lastAt) ?? -1, num(server.lastAt) ?? -1);
  if (lastAt >= 0) merged.lastAt = lastAt;
  merged.spots = mergeList(local.spots ?? [], server.spots ?? []);
  merged.markers = mergeList(local.markers ?? [], server.markers ?? []);
  return merged;
}

/* ---------- prune ---------- */

const DEFAULT_MARKER_LABEL = /^Marker(?: \d+)?$/;
const sizeOf = (value: unknown) => JSON.stringify(value).length;
const oldestFirst = <T extends {updatedAt: number}>(items: T[]) => items.slice().sort((x, y) => x.updatedAt - y.updatedAt);

/**
 * Keeps a blob at or under `cap` characters of JSON.
 * Tombstones older than `TOMBSTONE_DAYS` are always dropped (they no longer
 * protect a merge). Then, while the blob is too large, in order:
 *   1. the oldest markers with default labels ('Marker n');
 *   2. the oldest named markers;
 *   3. spot notes, oldest spot first;
 *   4. last resort, the oldest remaining tombstones.
 * Live spots are never dropped. `pruned` counts the markers dropped and the
 * notes trimmed (what the user can notice); silent tombstone expiry is not counted.
 */
export function prunePractice(p: PracticeV2, cap = PRACTICE_CAP, now = Date.now()): {value: PracticeV2, pruned: number} {
  const value = copy(p);
  value.spots = Array.isArray(value.spots) ? value.spots : [];
  value.markers = Array.isArray(value.markers) ? value.markers : [];
  const expiry = now - TOMBSTONE_DAYS * DAY_MS;
  value.spots = value.spots.filter(s => !s.deleted || s.updatedAt >= expiry);
  value.markers = value.markers.filter(m => !m.deleted || m.updatedAt >= expiry);
  let pruned = 0;
  let size = sizeOf(value);
  if (size <= cap) return {value, pruned};

  const dropMarkers = (candidates: Marker[]) => {
    for (const marker of oldestFirst(candidates)) {
      if (size <= cap) return;
      value.markers = value.markers.filter(m => m !== marker);
      pruned++;
      size = sizeOf(value);
    }
  };
  dropMarkers(value.markers.filter(m => !m.deleted && DEFAULT_MARKER_LABEL.test(m.label)));
  dropMarkers(value.markers.filter(m => !m.deleted));

  for (const spot of oldestFirst(value.spots.filter(s => s.note !== undefined))) {
    if (size <= cap) break;
    delete spot.note;
    pruned++;
    size = sizeOf(value);
  }

  const tombstones = oldestFirst([...value.spots, ...value.markers].filter(item => item.deleted)) as Array<Spot | Marker>;
  for (const item of tombstones) {
    if (size <= cap) break;
    value.spots = value.spots.filter(s => s !== item);
    value.markers = value.markers.filter(m => m !== item);
    size = sizeOf(value);
  }
  return {value, pruned};
}

/* ---------- summary ---------- */

/** `m:ss`, seconds floored. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function barIndexAt(bars: SummaryBar[], t: number): number {
  let lo = 0, hi = bars.length - 1, found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t0 <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

function barsLabel(bars: SummaryBar[], a: number, b: number): string | undefined {
  const valid = bars.filter(bar => num(bar.t0) !== undefined && num(bar.t1) !== undefined);
  if (!valid.length) return undefined;
  const first = valid[barIndexAt(valid, a + BAR_EPS)];
  const last = valid[barIndexAt(valid, Math.max(a + BAR_EPS, b - BAR_EPS))];
  const x = first.display, y = last.display;
  if (y === null) return 'Pickup loop';
  if (x === null) return `Pickup–bar ${y} loop`;
  return x === y ? `Bar ${x} loop` : `Bars ${x}–${y} loop`;
}

function loopLabelOf(p: PracticeV2, map: SummaryMap | null): string {
  const {a, b} = p.loop;
  const sections = map && Array.isArray(map.sections) ? map.sections : [];
  const section = sections.find(s => Math.abs(s.t0 - a) <= SECTION_EPS && Math.abs(s.t1 - b) <= SECTION_EPS);
  const name = section && (section.name || section.label);
  if (name) return `${name} loop`;
  const bars = map && Array.isArray(map.bars) ? barsLabel(map.bars, a, b) : undefined;
  return bars ?? `${formatClock(a)}–${formatClock(b)} loop`;
}

/**
 * The Library's practice summary (D5).
 * `loopLabel` (only while the loop is on): '{section} loop' when the loop equals
 * a section, else 'Bars x–y loop' when `map.bars` is given, else 'm:ss–m:ss loop'.
 * `spots` are the 3 most recently practised live spots (`lastAt` desc, then `updatedAt` desc).
 */
export function summarize(p: PracticeV2, map: SummaryMap | null): PracticeSummary {
  const live = (p.spots ?? []).filter(s => !s.deleted);
  const summary: PracticeSummary = {
    rate: p.rate, minusMe: p.minusMe === true, spotCount: live.length,
    spots: live.slice()
      .sort((x, y) => ((y.lastAt ?? -1) - (x.lastAt ?? -1)) || (y.updatedAt - x.updatedAt))
      .slice(0, 3)
      .map(s => ({id: s.id, name: s.name, rate: s.rate})),
  };
  if (p.loop?.on) summary.loopLabel = loopLabelOf(p, map);
  if (p.surface) summary.surface = p.surface;
  return summary;
}

/* ---------- share ---------- */

/**
 * What a share snapshot carries: loops, spots and markers, with nothing
 * personal. Spot notes, practice history (`lastAt`, spot `lastAt`/`passes`),
 * tombstones and the sharer's Minus me / Only me are removed.
 */
export function sanitizeForShare(p: PracticeV2): PracticeV2 {
  const value = copy(p);
  delete value.lastAt;
  delete value.onlyMe;
  value.minusMe = false;
  value.spots = (value.spots ?? []).filter(s => !s.deleted).map(s => {
    const spot = {...s, passes: 0};
    delete spot.note;
    delete spot.lastAt;
    return spot;
  });
  value.markers = (value.markers ?? []).filter(m => !m.deleted);
  return value;
}
