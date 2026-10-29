# Map: tempo-map editing subsystem (mapedit)

Scope: `shared/song-map.ts` (376 lines), `src/js/song-map.js` (180), `src/js/map-mode.js` (734), `src/js/map-lane.js` (161),
`src/js/tempo-sources.js` (266), `src/js/tempo-import.js` (308), `src/js/tempo-archive.js` (150), `src/js/guitar-pro-bounds.js` (159),
plus `src/js/guitar-pro-import.js` (only where it feeds the map), `convex/tempoSources.ts` (96), `src/css/tempo-map.css` (127),
`src/css/tempo-sources.css` (54). It also covers the coupling to `player.js`, `metronome.js`, `notation/part.js`, `notation/editor.js`,
`notation/chart.js`, `notation/launcher.js` and `convex/sharing.ts`.
Tests: `tests/song-map.test.js`, `tests/song-map-store.test.js`, `tests/map-mode.test.js`, `tests/map-lane.test.js`,
`tests/tempo-sources.test.js`, `tests/tempo-import.test.js`, `tests/tempo-archive.test.js`, `tests/guitar-pro-bounds.test.js`,
`tests/guitar-pro-import.test.js` and `convex/tempoSources.test.ts`.

The baseline is commit `7deaaf4`. All line numbers refer to that tree.
Spec targets: `docs/ux2/spec.md` §1.1 (Map object, `hasRealMap`), §4.3 (HUD), §4.5 (strip), §4.6 (Loop, Again), §5.1 (Edit · Map), §7.2 (keys), §7.8 (undo), §9.2 (module layout) and §9.3 (map origin).
**Owner decisions apply:** there is no rollout ceremony and no backwards-compat UI. Stored data is still read: pre-1.6 `tempo.map`/`tempo.detected`, and 1.6–1.9 `tempo.songMap` without `origin`, get a cheap one-way upgrade on load. Nothing is written in the old shapes any more.

Facts marked **verified** were checked by running the real modules in a scratch vitest probe. The probe lived outside the repo; no source files were changed.

---

## 1. Files and dependency graph

```
shared/notation.ts ── Fraction math, Measure/Timeline types, beatGroups (notation.ts:76), id(), MAX_MEASURES=1024 (notation.ts:24)
        ▲
shared/song-map.ts ── pure model: types, compile, timeAt/positionAt/velocityAt, beatsOf/linesOf, validate/clean, normalize,
        ▲              constructors (default/fromSections/fromBeats/fromTimeline/toTimeline), edit primitives
        │   imported by: song-map.js, map-mode.js:6, map-lane.js:6, tempo-sources.js:4, tempo-import.js:3, guitar-pro-import.js:7,
        │                notation/import-drums.js:7 (toTimeline), metronome.js:8 (defaultSongMap), player.js:14 (fromTimeline),
        │                convex/sharing.ts:10 (cleanSongMap, server side)
src/js/song-map.js ── SongMapStore: undo/redo transactions, guards, cached queries         ◄── metronome.js:7 (constructs it), tempo-sources tests
src/js/metronome.js ── owns the store (metronome.js:35), serializes `tempo` (53-65), setDetected (68-70), count-in (139-161)
src/js/map-mode.js ── createMapMode: inspector DOM, keys, taps, preview, calibration, lane pointer   ◄── player.js:9
        ├── map-lane.js (drawLane, segments, tempoRange, guides)
        └── onsets.js (detectOnsets, nearestOnset: snap taps)
src/js/tempo-sources.js ── createTempoSources: Find/import panel                         ◄── player.js:10 (+ tempo-sources.css, player.js:11)
        ├── tempo-import.js (importTempoFile, offsetTempoMap)
        │       ├── tempo-archive.js (lazy, .sng/.zip) ── fflate Inflate, shared/sng.ts
        │       └── guitar-pro-import.js (lazy, .gp*) ── @coderline/alphatab importer, guitar-pro-bounds.js (preflight)
        └── backend.js:49-55 → convex/tempoSources.ts (search, load actions) ── convex/lib/tempoCatalog.ts, convex/lib/chorusCatalog.ts, shared/sng.ts
player.js:12 also imports parseBeatText/parseTempoFile to decode online loads (player.js:915-924)
desktop/main.cjs:139 looks up the hashed `guitar-pro-import-*.js` chunk by name (the lazy chunk name is load-bearing).
```

---

## 2. The SongMap model (`shared/song-map.ts`)

### 2.1 Types and limits
| Item | Definition | Line |
|---|---|---|
| `Pin` | `{position: Fraction (quarter notes from bar 1's downbeat), time: number (s), ramp?: boolean}` | 9 |
| `SongMapData` | `{version: 1, measures: Measure[], pins: Pin[], tailQpm?: number}`. There is **no `origin`, no `source` and no section list**. | 10 |
| `Measure` (from notation.ts:3) | `{id, numerator 1–16, denominator 1/2/4/8/16, length: Fraction (≤ full length; a short bar 1 is a pickup), label ≤120 chars, grouping?: number[]}` | notation.ts:3 |
| `Span` | compiled segment between two pins: `{p0, p1, t0, t1, v0, v1 (quarters/s), ramp}` | 11 |
| `Compiled` | `{pins (sorted), spans, head (q/s before the first pin), tail (q/s after the last)}` | 12 |
| `Beat` | `{time, downbeat, bar (0-based index), beat (1-based counted pulse), q}` | 13 |
| `MAX_PINS = 8000`, `MIN_QPM = 10`, `MAX_QPM = 1000` | | 15-16 |

**Labels = sections.** A section is `measure.label` on its first bar (spec §1.1). There is no other section structure.
**Source.** The model stores no provenance. Today the only provenance hint lives outside the map, in `tempo.source` and `tempo.detected`, and `metronome.serialize` writes `source: 'detected'` for *every* edited map (metronome.js:63). So the stored field carries no information (§11.1).

**Core invariant** (header comment, lines 1-6): tempo is never stored between pins. It is derived from them, so meter or numbering edits never move a pin in time.

### 2.2 Geometry helpers
- `fullLength(m)` = 4·n/d quarters (23).
- `measureStarts(measures)` = cumulative Fraction starts (24).
- `extentOf(data)` = total quarters (25).
- `pulseOf(measure)` (28-31): the felt pulse in quarters. 6/8 → 1.5 (dotted quarter), uneven groups such as 7/8 2+2+3 → 0.5 (eighth), 4/4 → 1. It drives every "BPM" shown to users (`bpmAt`).

### 2.3 Compile, and bar↔time conversion (exact)
- `compile(data)` (44-60) sorts the pins and builds a span between each consecutive pair.
  - **Steady span:** `v = Δq/Δt`.
  - **Ramp span** (the `ramp` flag on the span's *start* pin): the tempo changes linearly in musical position.
    - If a previous span exists, it starts at that span's `v1` and solves its end with `solveRampEnd` (36-42; a bisection on `Q·ln(v1/v0)/(v1−v0)`).
    - Otherwise (an opening ramp) it lands on the next span's steady tempo.
  - `tail` = `tailQpm/60`, else the last span's `v1`, else 2 q/s (120 qpm). `head` = the first span's `v0`, else `tail`.
- `timeAt(c, q)` (68-75): extrapolates linearly before the first pin (`head`) and after the last (`tail`). Within a span it is linear, or logarithmic for a ramp. A binary search over spans (`spanIndexAt`, 62-66) makes it O(log n).
- `positionAt(c, t)` (77-84) is the exact inverse. `velocityAt(c, q)` (87-93) gives quarters per second.
- `barIndexAt(data, q, starts)` (95-99): binary search. It returns 0 for q < 0.
- `beatsOf(data, c, duration)` (102-118): one entry **per beat group** (the counted pulse, = one click), limited to 0 ≤ time < duration.
  - **Pickup rule:** bar 0 shorter than full is a pickup. Its beats get `downbeat:false` and are numbered from the *end* of the bar (beat 3, 4 for a 2-beat pickup in 4/4). **Verified.**
- `linesOf(data)` (121-132): every bar line and group start as `{q, bar, beat, downbeat: beat===1}`. It numbers from the *start* of the bar and marks the pickup's first line `downbeat:true`, so it **disagrees with `beatsOf`** on pickups (**verified**: lines say bar 0 beat 1 at q=0; beats say beat 3).

### 2.4 Validation and cleaning
- `validateSongMap` (139-160) checks:
  - version 1;
  - 1–1024 measures and 1–8000 pins;
  - each measure's id (unique, ≤80), meter range, label ≤120, length > 0 and ≤ full, and grouping summing to the numerator;
  - pins strictly increasing in position *and* time (gap > 0.1 ms);
  - `tailQpm` within 10–1000;
  - ramp spans within 2.5–4000 qpm.
- `cleanSongMap(value)` (163-173) rebuilds an object from **known fields only**: version, measures, pins (`ramp` only when true) and `tailQpm`. Then it validates, returning `null` on any failure.
  - **It drops any `origin` field (verified).** This is the single choke point for `origin` passthrough (§11.2).
  - It is also what Convex runs on shared snapshots (`convex/sharing.ts:43`).

### 2.5 Normalization
`normalize(data, duration, keep)` (180-193) mutates the data in place:
- It sorts the pins.
- It appends bars in the last meter until the bars cover the recording and the last pin.
- It pops trailing bars that start after both the recording and the last pin, unless `keep(id)` (bars with drum notation).
- Capped at `MAX_MEASURES`.

### 2.6 Constructors
| Function | Result | Line |
|---|---|---|
| `defaultSongMap(duration, qpm=120, n=4, d=4, firstDownbeat=0)` | one 4/4 bar, normalized; **one pin at `firstDownbeat`**, `tailQpm: qpm` | 196-199 |
| `fromSections(sections, duration)` | Pre-1.6 manual sections `{t, bpm, beatsPerBar, unit}`. Pins each section start, plus its last pulse when another section follows; grouping all 1s; last bar full; tailQpm from the last section. | 207-230 |
| `fromBeats(beats, duration)` | One pin **per beat**. Bars come from downbeat spacing (≤16 beats, otherwise the nominal count). A leading non-downbeat run becomes a pickup measure **labelled `'Pickup'`** (246, **verified**). Grouping all 1s, denominator 4, last bar full. Fewer than 2 beats → `defaultSongMap(..., firstDownbeat = beats[0].time)`. | 233-253 |
| `fromTimeline(timeline, duration)` | Adopts a drum part's timeline: anchors become pins (dropping anchors < 1 ms apart), measures cloned, normalized with keep-all | 255-261 |
| `toTimeline(data)` | The drum part's timeline. Pins become anchors, ramps are densified every eighth note, plus one anchor 4 quarters after the last pin. ≤8192 anchors. | 267-277 |

### 2.7 Edit primitives (pure; callers clone, normalize, validate)
| Function | Behaviour | Line |
|---|---|---|
| `findPin(data, q)` | index by exact position | 280 |
| `pin(data, q, time, replace=false)` | Places a pin. Conflicting pins (out of time order within 1 ms) throw unless `replace`, in which case they are removed and counted. Keeps an existing pin's `ramp`. **Deletes `tailQpm` when pinning past the last pin.** Returns the conflict count. | 283-294 |
| `unpin(data, q)` | refuses to remove the last pin | 296-302 |
| `renumberPin(data, from, to)` | moves a pin's musical position; refuses crossing another pin or going below 0 | 305-313 |
| `editBars(data, from, to, patch)` | "Keep bar lines". Each pin keeps its (bar, offset). Pins whose offset no longer fits a shortened bar are dropped and counted. | 319-336 |
| `rebarBars(data, from, to, patch)` | "Keep beats". It only patches the measures, so pins keep their musical positions and times and later bar lines slide. Returns 0. | 343-346 |
| `beatsPinnedNear(data, from, to)` | whether any non-bar-line pin lies in these bars or the next one (chooses the default Keep mode) | 349-354 |
| `sameMeter`, `meterRun(data, i)` | the run of bars up to the next meter change | 356-363 |
| `setMeter(m, n, d, grouping?)` | sets the meter; keeps the grouping only if it has more than one group and sums to n; **resets `length` to full** | 365-369 |
| `scaleTempo(data, factor)` | ×2 / ÷2: pin positions and `tailQpm` scale, times do not | 372-376 |

---

## 3. `SongMapStore` (`src/js/song-map.js`)

### 3.1 Lifecycle
- `constructor(data, duration, {legacy})` (12-22).
  - **`duration` is fixed at construction** (`Math.max(0.001, …)`), and there is no setter.
  - The metronome builds the store with `engine.duration || 1` (metronome.js:35), so today the map exists only after stems decode.
- `SongMapStore.fromTempo(tempo, duration)` (24-28).
- `load(tempo)` (31-48):
  - A valid `tempo.songMap` wins.
  - Otherwise it translates legacy data: `fromBeats(tempo.detected)` when `source==='detected'`, else `fromSections(tempo.map)`, else `defaultSongMap`.
  - It sets `this.legacy = {map, detected, source}`, which makes `metronome.serialize` write the old fields back untouched (metronome.js:62).
  - It clears undo and emits `'load'`.

### 3.2 Change plumbing
- `subscribe(fn)` (51).
- `setGuard(name, guard)` (56): a guard throws to refuse a map. `guard.keep(id)` protects bars from trimming (`_kept`, 57).
  - There are two notation guards, both named `'notation'` (so the later one replaces the earlier):
    - `player.js:889-899` reads the saved part directly, before Transcribe opens;
    - `notation/part.js:65-75` reads the live editor.
  - The refusal copy is "Bar N has drum notes that would no longer fit. Edit them in Transcribe first." / "That change would remove a bar that has drum notation."
- `notationAfter(index)` (59): any kept bar after the index (blocks "keep beats").
- **`edit(change, reason)` (69-89):**
  1. clone the data, then run `change(draft)`;
  2. if only one pin is left and there is no `tailQpm`, freeze the current tail tempo (73);
  3. `normalize` (with keep), `validateSongMap`, and the 1024-bar coverage check (77-78);
  4. `toTimeline` and run every guard (79-80);
  5. no-op if `sameContent` (81);
  6. otherwise push undo (cap 200; inside a batch only mark it changed), clear redo, **set `legacy = null`**, `_set`, emit `reason`.
- `beginBatch()` / `endBatch()` (92-96): one undo step for a tap pass or a pin drag.
- `undo()` / `redo()` → `_step` (98-111). It ends any batch and re-runs the guards on the target. If a guard refuses, the step is put back and the error rethrown. It sets `legacy = null` and emits `'undo'`.
- `replace(next, reason)` (113): wholesale replacement as an undoable edit.
- `replaceFromBeats(beats)` (115-119): detection. Bar N keeps the old bar N's id, so drum notes stay attached.
- `adopt(data)` (121): `load({songMap: clean})` only if valid. **It resets the undo history.**
- `replaceFromTimeline(timeline)` (122).
- `serialize()` (124) = a clone of the data.

### 3.3 Queries
`starts`, `beats`, `lines`, `timeline()` and `barCount` are cached and invalidated in `_set` (62-66).

| Query | Meaning | Cost | Line |
|---|---|---|---|
| `starts` | Fraction start per bar | cached | 127 |
| `beats` | `beatsOf`: every click with bar and beat | cached | 128 |
| `lines` | `linesOf` | cached | 130 |
| `timeline()` | `toTimeline` | cached | 131 |
| `barCount` | bars starting inside the recording (≥1) | cached; O(n log n) first time | 133 |
| `pins` | compiled, sorted pins | — | 134 |
| `timeAt(q)` / `positionAt(t)` | §2.3 | O(log n) | 136-137 |
| `barIndexAt(q)`, `measure(i)`, `barStart(i)` | | O(log n) / O(1) | 138-140 |
| `bpmAt(q)` | tempo in the felt pulse | O(log n) | 142 |
| `qpmAt(time)` | quarters per minute at a time | O(log n) | 144 |
| `pulseLabel(i)` | ♩ ♩. ♪ 𝅗𝅥 𝅘𝅥𝅯 𝅗𝅥. | O(1) | 145 |
| `beatsPerBarAt(time)` | group count (count-in) | O(log n) | 146 |
| `spanAt(q)` | `{index, from, to, ramp, startBpm, endBpm, open: 'head'\|'tail'\|null}` | **O(pins), linear** | 149-159 |
| `positionLabel(time)` | `{bar (1-based), beat}`; `{0,0}` before bar 1 | O(log n) | 162-169 |
| `nearestLine(time, {bars})` | nearest navigation line | **O(lines) × timeAt; not for per-frame use** | 172-177 |

**`positionLabel` defects for the Stage (verified):**
- It numbers pickup beats from the bar start (1, 2), while `beatsOf` and the click say 3, 4.
- It returns bar 0 for anything before bar 1's downbeat (`t < first pin` with q < 0).

player.js:818 then renders "Bar — / N", which violates "never Bar —" (§4.3).

---

## 4. Persistence and the metronome coupling

**Load.** `metronome.load(song.tempo)` (player.js:814; metronome.js:40-51) reads the click settings, then calls `songMap.load(tempo)`.

**Serialize** (metronome.js:53-65):
- With `legacy` set, it returns the settings plus the original legacy fields.
- Otherwise it returns the settings plus `songMap`, plus a **dual-write** of `source:'detected'`, `map:[]` and `detected:` every pulse. The comment says this is "so earlier desktop versions still hear the same clicks". **The owner decision deletes this.**

**Every map change → `metronome._notify(true)`** (metronome.js:36, 87-90):
- It **pauses the engine if it is counting in**.
- Then `onChange` → `refreshMetroUI`, `drawGrid` and `persistTempo` (player.js:863).
- `persistTempo` is debounced 400 ms → `backend.saveTempo` (player.js:833-842) → `songs.saveTempo` (`convex/songs.ts:88-96`, which takes `v.any()` and patches only if `!sameContent`).
- Flushed on cleanup (player.js:939) and by `saveForShare` (player.js:1023-1029).

**Detection.** `metronome.setDetected(raw)` (68-70) → `replaceFromBeats`. The beat job runs through `backend.detectBeats` (backend.js:187-210, a companion job).

**Sharing.** `convex/sharing.ts:37-44 tempoSettings` sends the click settings, legacy `map`/`detected`, `source` and `songMap: cleanSongMap(...)`.

**Drum part ↔ map** (player.js:874-901, part.js:19-75):
- **Adoption:** if the map is still `legacy`, the saved part's timeline is adopted (`songMap.adopt(fromTimeline(...))`, player.js:885-887).
- **Guards** refuse map edits that strand notes.
- **Follow:** `part.js:52-63 syncMap` runs on **every** map emit. If the timeline changed, it rewrites the part's timeline and its undo/redo stacks, then calls `part.commit('map')` → `store.set(score)`, which **saves the notation**. Label edits change `measures`, so they also trigger a notation save.
- **Reconcile on load:** `part.js:29-32 fitScore` calls `songMap.replaceFromTimeline` if the part cannot be mapped onto the current map. Transcribe's `.woodshed.json` import does the same (editor.js:117).

---

## 5. Map mode (`src/js/map-mode.js`)

### 5.1 Factory and dependencies
`createMapMode({...})` (map-mode.js:33) takes:

| Parameter | Meaning |
|---|---|
| `root` | DOM it needs: `#map-strip`, `#map-btn`, `#map-cursor`, `.time-ruler`/`.tracks`, `.player` and `#timeline-interact` |
| `engine` | uses `duration`, `seek`, `playing`, `countingIn`, `loop`, `setLoop`, `getPosition`, `getPositionAt`, `ctx` (`currentTime`, `outputLatency`, `baseLatency`) and `tracks[].buffer`/`name` |
| `songMap` | the store |
| `metronome` | uses `enabled`, `setEnabled` and the private `_click(when, accent, tracked=false)` |
| `readOnly` | shared view |
| `getView`, `setView`, `setFollow`, `timeToX` | the waveform view |
| `play` | toggles play/stop |
| `setGridVisible(v)` | returns the previous value |
| `redraw`, `onLoopChange`, `onDetect(report)`, `onSources()`, `onExit()`, `onEnter()` | callbacks |

It returns `{active, enter, exit, handleKey, selectNear, renderLane, gridDecor, tick, refresh, destroy}` (730-733).

**State** (37-40):
- `active`;
- `cursorQ`: the selected line, a Fraction;
- `digits`: go-to-bar entry;
- `preview`, `previewStarting`;
- `pass`: the tap pass;
- `calibration`, `drag`;
- `saved`: metronome and grid state to restore;
- `onsets` (lazy), `editing`, `hoverPin`, `laneHits`, `tone`, `message`;
- `snapTaps` from `ws.tapSnap` (default on);
- `tapOffset()` from `ws.tapOffset`, clamped ±0.2 s.

**Placeholder test** (121): `unmapped = pins.length===1 && pins[0].time===0 && undoStack.length===0`. **It is wrong for real one-pin maps whose pin is at 0:00.000** (§12).

### 5.2 Entry and exit
**Entry points today:**
1. the transport `#map-btn` "Tempo map" (player.js:161; onclick map-mode.js:535);
2. **Shift+M** (565);
3. the metronome popover "Map tempo & meter" `#m-map` (player.js:188, 940);
4. Transcribe "Align in tempo map…" (`openMap(a.startPosition, {edit:true})`) and "Align this beat" (`openMap(cursor)`) (editor.js:288-289);
5. the chart empty state "Import a file…" → `openImport` → `mapMode.enter()` then `tempoSources.open()` (launcher.js:46; player.js:1008);
6. the inspector's Find/import (907).

**`enter(q=null, {edit})`** (502-520):
- Returns false if `readOnly`.
- `onEnter()` → `transcription.leaveChart()` (player.js:909; launcher.js:102). The map edits the waveform timeline.
- Saves the metronome and grid state, **forces the click on** and the grid visible.
- Shows the panel and lane; `#map-btn` gets `aria-pressed`; `.player.mapping` is set.
- The cursor goes to `q`, else the nearest bar line to the playhead.
- `edit:true` opens the Edit bar form.

**`exit()`** (521-534):
- `onExit()` → `tempoSources.close()`, which **cancels** an audition (player.js:908). A `false` return aborts the exit (drum import in flight).
- Then finishPass, stopPreview, close the editor, menu and keys; hide everything; restore the click and grid; redraw.
- Exit triggers: Done, Esc or ⇧M (layered, 570-577), and after a drum import (player.js:935).

Read-only: `#map-btn` is disabled with the title "Add this song to your library to edit its tempo map" (536).

### 5.3 `MAP_KEYS` (map-mode.js:27-31, verbatim) and the real handler (562-616)
| Group | Key | Label in `MAP_KEYS` | Actual handler |
|---|---|---|---|
| Move | ← → | Previous / next bar | `step(±1,'bar')` over downbeat lines inside the recording (588-591) |
| Move | ⇧ ← → | Previous / next beat | `step(±1,'beat')` |
| Move | ⌘ ← → | Previous / next pin or meter change | `step(±1,'pin')`; targets are pins plus meter-change starts (222-227, 582) |
| Move | 1–9 ↵ | Go to a bar | Digits 0–9 accumulate (max 4; 585). Backspace edits (586), ↵ jumps (587, `goToBar` 333-337), Esc clears. **Digits are captured unconditionally while mapping.** |
| Move | Home End | First / last bar | 597 |
| Pin and tap | D | Pin the downbeat at the playhead | 599-606. **Stopped:** `pinNearest('bar', playhead)` pins the *nearest bar line to the playhead* at the playhead time, not the cursor line. **Playing:** a tap pass. **Previewing:** pin nearest. **Count-in:** "Taps start after the count-in." Repeat is ignored. |
| Pin and tap | T | Pin the beat at the playhead | same, with any line |
| Pin and tap | Space | Play, then tap T on every beat | Space is **not** handled by map mode; it falls through to the player (Play/Stop) |
| Pin and tap | , . | Nudge 10 ms (⇧ 1 ms) | `e.code` Comma/Period → `nudge(±0.01 / ±0.001)` (608) |
| Pin and tap | ⌥ ← → | Wrong bar number? Move the pin | `renumber(±1, byBeat = ⇧)` (590) |
| Pin and tap | ⌫ | Unpin | Delete/Backspace → `removePin` (609) |
| Shape | ↑ ↓ | Beats in this bar (⇧ this bar only) | `changeBeats(±1, ⇧)` (594) |
| Shape | E | Edit bar | `openEditor` (610) |
| Shape | R | Ramp to the next pin | `toggleRamp` (611) |
| Shape | P | Loop these bars | `togglePreview` (612) |
| Shape | * / | Double / halve the tempo | `scale(2)` / `scale(0.5)` (613-614) |
| Shape | ⌥ ↑ ↓ | Tempo after the last pin | `openTempo(±1, ⇧ ±0.1)` (594) |
| Shape | ⌘Z | Undo | ⌘Z / ⇧⌘Z / ⌘Y (580-581) |
| Shape | Esc | Done | Layered: menu → key sheet → digits → preview → exit (570-577) |
| (not listed) | ? | — | Toggles the key sheet (578) |
| (not listed) | ⇧M | — | Enters when inactive (565) and exits when active (570) |
| (calibration) | T / D | — | records a calibration tap (569) |

**Precedence:**
- While the Edit bar form is open, map mode returns false (568). The form stops propagation itself (361-364).
- A modifier key with no binding returns false (583). ⌥ plus letters returns false (598).
- Player routing (player.js:1067-1104):
  1. sources open → only Esc;
  2. dialogs → nothing;
  3. metronome popover Esc;
  4. Space on a pointer control;
  5. inputs → nothing;
  6. `mapMode.handleKey` (1080);
  7. ⇧S snap;
  8. Transcribe (`editor.js:303` also bails while `mapActive()`);
  9. global player keys.
- So with mapping on, G, L, M, `[`, `]`, `-`, `=` and `\` still reach the player.

### 5.4 Inspector (45-92) and every control
**Cells** (render 146-175):

| Cell | Content |
|---|---|
| Bar | index+1, or "Go to N" with a caret; sub: "beat k" / "downbeat" / "Enter to jump" |
| Meter | n/d; sub: groups (shown only if not all 1s) · label, or "pickup" |
| Tempo | `unit bpm` or `start → end` for a ramp; sub: "a placeholder until you pin" / "ramp to …" / "after the last pin · ⌥↑↓ sets it" / "before the first pin" / "steady to …" |
| Pin | glyph plus `m:ss.mmm`, or "free" / "none yet"; sub: "locked to the recording" / "D pins a downbeat here" / "follows the pins around it" |

**Hint row** (`hintFor`, 131-139) has contexts: calibration, preview, playing, digits, unmapped, pinned, default.
The status line `#map-note` (`role=status`) has tones info / ok / error (`say`, 123). `attempt()` (125-128) turns thrown refusals into error status.

**Buttons** (54-64, actions 538-547):

| Control | Behaviour | Code |
|---|---|---|
| Pin here D / Unpin ⌫ | If the cursor is pinned (and the map isn't a placeholder) → `removePin`. Else `pinLine(cursorQ, playhead)`: **the cursor line at the playhead time**, unlike the D key. | 539 |
| Tap along Space / Stop Space | Stops if playing. Otherwise ends any preview, plays, and says "Tap T on every beat…". | 540 |
| Edit bar E | `openEditor` | 541 |
| Find / import… | finishPass, stopPreview, close the menus → `onSources` → (player.js:907) awaits `drumPartReady`, then `tempoSources.open()` | 546 |
| ⋯ More | `toggleMenu` | 545 |
| Undo / Redo | `history(false/true)`; disabled from the stack state (170-171) | 541 |
| Done | `exit` | 542 |

**More menu** (`renderMenu` 178-194; arrow-key roving and Esc 555-559; closes on an outside pointerdown 203-207):
- Ramp to the next pin R: checkbox, disabled unless between two pins.
- Loop these bars P: checkbox.
- Double the tempo `*`; Halve the tempo `/`.
- Snap taps to drum hits: checkbox; persists `ws.tapSnap` (543).
- Calibrate tap timing.
- Detect beats automatically: only with `onDetect` and not read-only. It calls `detectBeats(report)` with status mirrored into the inspector (544; player.js:906, 950-970).
- All keys ?

**Key sheet** (90-92): `MAP_KEYS` rendered in three groups. "All keys ?" sits in the hint row (144).

**Edit bar form** (70-88; `openEditor` 340-359; submit 365-396). It replaces the cells in place (`.is-editing`):

| Field | Rules |
|---|---|
| Beats `n` (1–16) / `d` select 1·2·4·8·16 | required |
| Groups | Text such as `2+2+3`; empty = even. It must sum to n, otherwise an error with an example (370). All-1 groupings show as empty (348). |
| Pickup (♩) | Shown and enabled only for bar 1 or an already-partial bar (352). Rounded to 1/16 quarter, minimum 1/16 (384). Applied only to the edited bar. |
| Label | ≤120, trimmed; applied to the edited bar only (382) |
| Apply to | This bar / **Until next change** (default) / To the end → end index = index, `meterRun`, or last (378) |
| Keep in place | Beats (`rebarBars`) or Bar lines (`editBars`). The default is Beats when `beatsPinnedNear` (350). Keep-beats plus later notation → refused (376). |
| Tempo | Only for an open span (tail, or head with a single pin; 344, 354). Applied only if the text changed from its initial `toFixed(2)` (387). Sets `tailQpm = bpm × pulse` of the new meter. |
| Ramp to next pin | Shown when the span has both pins and (index > 0 or > 2 pins) (356). Toggles `ramp` on the span's start pin (388). |
| Cancel / Apply ↵ | Esc cancels (362). Submit runs all of the above in **one** `songMap.edit(…, 'bar')`. The message is from `meterNote` ("…beats stayed put, later bar lines moved · removed N pins…") or "Bar N updated" (394). |

**Shape and pin operations:**

| Operation | Rules | Code |
|---|---|---|
| `changeBeats` (↑↓) | ±1 within 1–16. Applies to this bar (⇧) or the meter run. Keep mode is chosen automatically (`beatsPinnedNear`). Keep-beats with later notation → error "…Keep bar lines instead (Edit bar, E)" (277). | 284-293 |
| `toggleRamp` (R) | Needs `from` and `to` pins. The first span with < 3 pins is refused ("needs a steady tempo next to it"). The message gives start → end BPM. | 300-309 |
| `scale` (`*` `/`) | `scaleTempo`; the cursor is rescaled and snapped to a navigable line | 318-324 |
| `openTempo` (⌥↑↓) | Open spans only, otherwise "Tempo here comes from the pins around it…". ±1 or ±0.1 BPM in the felt pulse; sets `tailQpm`. | 310-317 |
| `renumber` (⌥←→) | Needs a pin at the cursor. Target = next/previous downbeat line (⇧: any line). `renumberPin` refuses crossing a pin. | 259-269 |
| `nudge` (`,` `.`) | Moves the cursor pin, or **creates** one at its derived time + delta. Clamped 2 ms inside its neighbours. Seeks when stopped; re-places the preview. | 249-258 |
| `pinLine` | `pin(..., replace=true)`. Reports replaced out-of-order pins and "BPM since bar N" (`tempoSince` 240). | 241-247 |
| `removePin` (⌫) | refuses an unpinned line and the last pin | 294-299 |
| `history` | undo/redo; re-snaps the cursor if its line disappeared | 325-332 |

**Navigation:**
- `select(q)` (210-218): sets the cursor and seeks (unless tapping; re-places the preview loop). If the line is out of view it scrolls the view to 25/75% and turns Follow off.
- `navigable()` (108) = lines starting before the end of the recording.

### 5.5 Taps, calibration, snap, preview
- **Heard time** (`heardTime`, 432-436): `engine.getPositionAt(ctx.currentTime − eventDelay(≤100 ms, from e.timeStamp) − outputLatency − baseLatency − tapOffset)`.
- **Snap taps** (`tapTime`, 443-447): the nearest onset within 40 ms, from `detectOnsets` on the drums stem buffer, else the first stem. Computed lazily once (437-442).
- **Tap pass** (`tap`, 448-468):
  - The first tap opens `pass` and `beginBatch`.
  - First target:
    - D → the cursor if it is a downbeat, else the next downbeat;
    - T → the cursor.
  - Later targets: the next line after `pass.lastQ` (downbeats only for D).
  - Each tap is one `edit(…,'tap')` that also **deletes pins skipped between taps**.
  - `finishPass` (469-475) runs when the transport stops (`tick`, 715), on exit, or on opening Find. It calls `endBatch`, giving one undo step, and says "⌘Z undoes the whole pass".
- **Calibration** (478-499):
  - Stops playback.
  - Schedules 12 untracked clicks, 0.6 s apart, starting 0.4 s ahead, via `metronome._click`.
  - T/D taps are recorded against the nearest click.
  - It finishes in `tick` once `ctx.currentTime > end`: the first 3 taps are discarded, at least 4 are needed, and the median offset is clamped ±0.2 s and stored in `ws.tapOffset`.
- **Preview** P (399-429):
  - It saves the user's loop, click and playing state.
  - Forces the click on; sets the engine loop to **3 bars** (cursor bar −1 … +1); seeks; plays.
  - ← → re-place the loop (via `select`).
  - It stops on P, Esc, the transport stopping (`tick`, 718), exit, or opening Find. On stop it restores the loop and seeks to the cursor.
  - **The saved click state is never restored.** `stopPreview` ignores `preview.metronome`.
  - D/T while previewing pin the nearest line (603).

### 5.6 Lane pointer model (map-mode.js:97-102, 618-704)
The lane DOM is inserted after `.time-ruler`. It holds a key column with the BPM scale, a canvas, a playhead and a tooltip.

| Gesture | Behaviour | Code |
|---|---|---|
| pointerdown on a pin | Hit box ±7 × ±9 px, else ±4 px in x (652). Starts a drag: `setPointerCapture`, `beginBatch`, cursor to the pin. | 653-663 |
| pointerdown elsewhere | `selectNear(time, {bars: y < 22})`: the ruler band selects bars only. Seeks if stopped. | 664-665 |
| pointermove (dragging, > 2 px) | `edit(pin(...),'drag')`, clamped 2 ms inside its neighbours and the recording. A refusal keeps the last valid position and shows the reason. Tooltip "bar N · m:ss.mmm". | 667-680 |
| pointermove (hover) | Cursor `ew-resize` over a pin; hover outline; tooltip "pinned …" or "bar N · BPM" | 682-686 |
| pointerup | `endBatch` (one undo step); message "Moved …", or a seek on a click | 688-696 |
| dblclick | pin/unpin the nearest line at its derived time | 698-703 |
| leave | hide the tip | 697 |

**Also:**
- **Waveform click while mapping:** `player.js:668` seeks and calls `mapMode.selectNear(t)` (any line).
- **`gridDecor()`** (707-711): `{pinned: Set(time×1e4), band: [barStart, barEnd]}`. player.js:454-459 tints the selected bar and draws pinned grid lines in accent.
- **`renderLane(container, view)`** (649): when not mapping, `renderFlags` (631-648) draws meter-change and label flags over the waveform (≥46 px apart). When mapping, `drawTempoLane` runs.
- **`tick()`** (713-727) runs every frame from player.js:1059. It finishes a pass or calibration, auto-stops the preview, positions `#map-cursor` and the lane playhead, and re-renders on play-state changes.
- **Subscribe** (729): any store change re-renders the inspector while active.

---

## 6. `map-lane.js`
- `RULER = 22` (8). The font is a hardcoded mono stack, and the label font is hardcoded `Arial, Helvetica` (9, 94).
- `segments(songMap, duration)` (13-25): head, steady/ramp spans and tail in qpm.
  - **Suspect:** a steady span ≥ ~1 quarter that differs > 6% from *both* neighbours (18-23; tested in map-lane.test.js:8).
- `tempoRange(segs)` (28-39): a duration-weighted median ±50% window with padding (outlier-proof). `guides(range)` (42-47): 2–3 round values.
- `drawLane(canvas, {songMap, view, timeToX, duration, cursorQ, hoverPin, color})` (49-161) draws:
  - the selected-bar fill and the guides;
  - **the bar ruler** (numbers thinned to ≥26 px, meter chips on change, labels);
  - the curve (fill plus line; ramps sampled every 6 px; suspect spans in `warn`; head and tail dashed);
  - the selected line and span labels (≥58 px wide, in the felt pulse);
  - **square pins** (8 px, 10 selected, 5 when dense);
  - the unpinned-selection marker.
  - It returns `{range, guides, hits:[{pin,x,y}], top}`.
- Colours come from CSS variables read per draw (map-mode.js:619-623): `--accent`, `--accent-fill`, `--text`, `--muted`, `--border`, `--bg-2`, `--bg`, `--grid-minor`, `--warn`, `--loop-fill`, `--map-fill`, `--map-connector`.
- Spec §5.1 wants separate ruler, sections and tempo lanes, 12 px diamonds and 24/44 px hit areas. The ruler drawing must be split out of `drawLane`. The curve, suspect logic, range and guides are reusable unchanged.

---

## 7. Find / import (`tempo-sources.js` and the importers)

### 7.1 Panel flow (`createTempoSources`, tempo-sources.js:13-266)
**Dependencies** (13):
- `root` (host div inside `#map-strip`, player.js:911-913), `song`, `songMap`, `engine`;
- `search` → `backend.findTempoSources` → `tempoSources.search`;
- `load` (player.js:915-924): `tempoSources.load`, then `parseBeatText(text, {meter: candidate.meter})`, or `parseTempoFile(bytes, {name: notes.mid|notes.chart})`, then `applyChartMetadata` when metadata is present;
- `onClose`, `onImportDrums`, `previewDrums`, `play` (= `doPlayStop({pause:true})`).

**`open()`** (143-164):
- Snapshots the `baseline` map and the undo/redo/legacy `history`.
- items = `[{id:'original', title:'Your map'}]`.
- Shows the panel; adds `.is-sourcing` to `#map-strip`.
- **Freezes the other editors** (§7.3).
- Builds enchor.us and Songsterr links from the title and artist.
- Focuses the query (pre-filled "artist title", ≤160) and **auto-searches**.

**`find()`** (109-132):
- `searchRevision` guards against late responses.
- Keeps original, local and selected items, then appends new candidates.
- Messages: "N possible maps…", "Search incomplete…" (provider warnings), "No matches in Chorus Encore or Harmonix Set…".

**Result rows** (58-60): toggle buttons (`aria-pressed`) showing title; artist · album · source name · "Chart by X" · "Drum chart" · m:ss; and a Try/✓ mark.

**`choose(item)`** (94-108): `loadRevision` token; loads once (cached on the item); `apply`.

**`apply(item, offset)`** (82-93):
- `offsetTempoMap(result.map, offset)`.
- Bar N takes the baseline's bar N **id**, plus the baseline label when the source has none.
- **`songMap.replace(map,'tempo-source')`.** This is the live store: guards apply, so an incompatible candidate is refused with the notation reason (test tempo-sources.test.js:121).
- Then `renderSelection`.

**`renderSelection`** (61-80):
- "Listening to" title and detail.
- The drum preview (`previewDrums` → `importDrumHits` against the current map) gives "N drum hits ready to import · M skipped" or a preview error.
- Warnings are a union of source, drum, preview and **duration mismatch > 2 s** (72-73).
- The drums button shows when hits exist and is disabled on error or 0. The offset is displayed.

**Align:**
- Offset input in ms (±3,600,000; `changeOffset` 133-142 bumps `loadRevision` so late loads cannot clobber it).
- ±10 / ±100 buttons.
- **"First downbeat → cursor"** (231-241): offset = `engine.editPosition` − bar-1 time of the *unshifted* source map.
- Reset offset; Play/pause (`audition` 213-217).

**Commit:**
- "Your map" → `choose(items[0])`, a restore that stays open.
- **"Use map & import drums"** (`importDrums` 195-212): disables every control (`aria-busy`), then `onImportDrums` → `importDrumHits` → `transcription.importScore` (player.js:927-934), then `close({keep:true})` → `onClose` → `mapMode.exit()`.
- **"Keep map"** → `close({keep:true})`.
- **Cancel** / Esc → `close()`: replace the baseline, then **reassign** `undoStack`, `redoStack` and `legacy` from the snapshot (169-172). If restoring fails, it stays open.
- `close` refuses while importing drums (167). It restores focus and calls `onClose({keep, kept})` (178-179).

**Keys:** the panel's `keydown` stops propagation of everything (243-249). Esc = cancel. Space outside a field = audition. In the player, while open, only Esc acts (player.js:1069-1072). `snapTime` bypasses the grid while open (player.js:407).

**`destroy()`** (255-265).

### 7.2 Import formats (`importTempoFile`, tempo-import.js:302-308)
| Input | Path | Limits and notes |
|---|---|---|
| `.sng`, `.zip` (Chorus packages) | lazy `tempo-archive.js:142-150` → SNG reader or `extractZipChart` (67-140: central directory first; only `notes.chart`/`notes.mid(i)`/`song.ini`; single folder; prefers notes.chart; CRC; streaming inflate in 512 B chunks) → `parseTempoFile` → `applyChartMetadata` (song.ini `delay` ms → `offsetTempoMap`, 43-51) | 128 MiB package (6, 18); 10 MB chart; 64 KiB ini; no ZIP64, encryption or multi-song |
| `.gp3` `.gp4` `.gp5` `.gpx` `.gp` | lazy `guitar-pro-import.js:15` `parseGuitarPro` → `preflightGuitarPro` (guitar-pro-bounds.js:153-159: ZIP for GP7/8, BCFZ→BCFS for GPX, GP3–5 passthrough) → alphaTab ScoreLoader → playback-order map (repeats and alternate endings unfolded), **section names become `measure.label`** (guitar-pro-import.js:98-99), drums with articulations and tuplets | 10 MB file, 32 MiB expanded, 128 entries; ≤1024 bars and 64 tracks; ≤8000 tempo changes; free-time refused; warnings for sync points and fermatas |
| `.mid` `.midi` (or an `MThd` header) | `parseMidiTempo` (121-196): format 0/1, PPQ only; tempo 0x51, meter 0x58, track name, text; drums from **PART DRUMS** expert lanes 95–101 with tom markers 110–112 (`gameMidiDrums` 86-119), else GM channel 10 | 10 MB; ≤1M events; ≤16000 hits; no tempo → 120 with a warning |
| `.chart` (or a `[SyncTrack]` body) | `parseChartTempo` (198-241): Resolution, Offset; B/TS/A events (A ignored); ExpertDrums lanes with cymbal flags 66–68; five-lane inference | 3×8000 sync rows; ≤16000 hits |
| `.txt` `.tsv` `.lab` `.csv` | `parseBeatText` (244-286): `seconds, beat-in-bar[, bar]`, header and `#` comments allowed → `fromBeats`. An optional meter hint (Harmonix catalog) re-units compound 6/8 and similar. | ≥2, ≤8000 beats; strictly increasing |
| `.musicxml` / `.xml` | refused with guidance (291) | — |

- `eventMap` (48-80) turns tempo and meter events into a map: one pin per tempo event, step tempo with no ramps, `tailQpm` = the last tempo, bars to the end of the recording, chart offset applied.
- `offsetTempoMap` (32-44) shifts the times. When pins would go below 0, it cuts them and inserts a boundary pin at time 0 (`positionAt`). It refuses to cut through a ramp.

**Result shape:** `{map: SongMapData, format, warnings[], drums?: {hits:[{q, midi, durationQ, velocity}], source, warnings, tuplets?}, sourceUrl?}`.

### 7.3 The inert freeze (to be deleted, spec §5.1.2 and §9.6)
- **JS:**
  - `freezeOtherEditors` (tempo-sources.js:16-22) sets `inert` on `.notation-workspace`, `.workspace-nav` and `.map-lane` inside `.player`;
  - called at 153, 177 and 261;
  - plus the player's key block (player.js:1069-1072).
- **CSS:**
  - `tempo-sources.css:5`: the inspector hides cells and form;
  - `tempo-sources.css:6`: lane `pointer-events:none`;
  - `tempo-sources.css:7`: the map cursor is hidden with `!important`;
  - `tempo-map.css:8-9`: the edit cursor stays visible while sourcing, because Align uses it.
- **Why it exists:** the audition mutates the **live** store. Any other map or notation edit during an audition would be overwritten by the next try and lost on Cancel, which reassigns the undo stacks wholesale.
- **Hidden side effects of every audition try today** (§12, R1):
  - a tempo save after 400 ms (`metronome._notify` → `persistTempo`);
  - a **notation part retime and save** (`part.js:52-61`);
  - a count-in pause;
  - one undo entry per try. After "Keep", ⌘Z steps back through every try; the test only covers one try (tempo-sources.test.js:109-119).

### 7.4 `convex/tempoSources.ts`
- **`authorize`** (17-20): an internal query; `requireUserId` (the signed-in and not-suspended checks; test :53-61).
- **`search`** (38-58):
  - `{query ≤300, duration?}`; < 2 characters → empty.
  - `Promise.allSettled` of the Harmonix catalog (GitHub CSV at a pinned revision, cached per isolate; failures not cached, 25-36) and Chorus Encore search.
  - Returns ≤40 candidates `{id, title, artist, album, source: 'harmonix'|'chorus', duration, bpm?, meter?, charter?, hasDrums?, sourceUrl?}` and per-provider warnings.
- **`load`** (60-96):
  - `chorus:<hash>` → server-side SNG extraction from a fixed URL, ≤900 KB → `{format:'chart'|'midi', data, sourceUrl, metadata?}` (whitelisted delay, chart_offset, pro_drums, five_lane_drums).
  - A Harmonix id is validated and must be in the catalog → `{format:'beats', text, sourceUrl}`.
- No user audio leaves the client. Spec §5.1.2 needs **no backend change**.

---

## 8. CSS (both files must be rewritten for the §9.2 guards)
- **`tempo-map.css`:**
  - hex literals: :4-5 (`--map-kbd` #eeeee5 / #2c3532), :73-75 (#ee7a3d, #c4561d, #f3b77d);
  - `rgba` in tokens: :4-5, :104;
  - `!important`: :9;
  - z-index literals: :12, :25, :104;
  - radius literals: 2–3 px throughout;
  - px font sizes everywhere;
  - `[data-theme=dark]` selectors (:5, :75);
  - breakpoints: :126 (1100 px) and :127 (700 px, which hides the hint row).
- **`tempo-sources.css`:**
  - `!important`: :7;
  - px fonts;
  - `:has(.is-sourcing)` freeze rules: :5-7.
- **Keep:** the semantic idea of `--map-fill` and `--map-connector`, the suspect `--warn`, and the selection tint. Map them to §8.3 tokens: `--edit` for the posture accent, `--warn`, `--now` for the playhead, `--loop-fill`.

---

## 9. Every coupling point in `player.js`
| player.js | What | 2.0 home |
|---|---|---|
| 9-14 | imports map-mode, tempo-sources (+css), parseBeatText/parseTempoFile, fromTimeline | `src/edit/map/*`; the online-load decoder moves into find-panel |
| 90 `#tempo-markers` | flags container (`renderLane`) | flags → Stems surface ruler (`wave-render.js`) |
| 95 `#map-cursor`, 109 `#map-strip` | cursor line and inspector host | Edit · Map layout |
| 161 `#map-btn`, 165 help title (Shift+M), 188-190 `#m-map`/`#m-detect` | entry and detect | deleted; `E`, Edit · Map Tools, Get bars |
| 382 | `mapMode`, `tempoSources` lets | session |
| 383-437 | grid ticks and `snapTime` from `metronome.beats`; 407 bypass while sources open | Stems surface snap uses store beats; the bypass becomes "Find panel aligning" |
| 451, 454-459 | `renderLane`, `gridDecor` in `drawGrid` | Edit · Map stem rows on the shared renderer |
| 668 | waveform click → `selectNear` | Edit · Map pointer model |
| 812-820 | `new Metronome(engine)`, `songMap = metronome.songMap`, "Bar n / N · Beat b" | Session-level store creation; HUD Position via the new helpers (§11.3) |
| 833-842, 939, 1023-1029 | tempo save, flush, saveForShare | practice-state/session save (flush on Stop, pagehide, unmount) |
| 845-849 | `nowText` (♩ = 96 · 4/4) | Click sheet read-only line "At the cue: ♩ = 96 · 4/4 · from the map" |
| 863 | `metronome.onChange` → persist | same, minus the dual-write |
| 874-901 | `adoptDrumPart` + guard | session (keep; the "legacy" test changes, §11.2) |
| 903-910 | `createMapMode` wiring (play, redraw, onLoopChange, onDetect, onSources, onExit, onEnter=leaveChart, setGridVisible) | `src/edit/map/session.js` dependencies |
| 911-937 | `createTempoSources` wiring (search, load decode, play, previewDrums, onImportDrums, onClose) | `src/edit/map/find-panel.js` |
| 943-971 | `detectBeats` | Jobs-backed detect command (`Finding bars · 30%`) |
| 1008 | `attachNotation({…openImport, mapActive, openMap})` | Edit · Chart → navigate to `/s/:id/edit/map?bar=N` (+ `find`) |
| 1059 | `mapMode.tick()` in `frame` | posture rAF |
| 1069-1072, 1080 | key routing | command registry, scope `edit.map` |

---

## 10. Tests and what they lock in
| File | Locks in (keep these behaviours when re-hosting) |
|---|---|
| song-map.test.js | Exact decimal tempos from two pins; ramp start/landing/inversion; opening ramp; legacy sections keep every click; `fromBeats` pickup and meter inference; meter edits keep later pins; conflict replace and renumber blocking; normalize and default 120 4/4; ×2/÷2; compound/odd pulse; clean/validate; `fromTimeline` adopt; rebar keeps every beat |
| song-map-store.test.js | Detection keeps bar ids; one-pin tail freeze; migrated maps editable; crowded drum-part anchors adopt; invalid maps never replace |
| map-mode.test.js (drives the **whole player** with a mocked engine) | Shift+M pin/renumber/meter/undo/Esc restores the click; arrows and digits do not leak; **"untouched legacy maps save unchanged"** (:80; changes under §11.2); drum part adopted and protecting notes; key sheet and menu via keyboard; E form with meter/groups/scope and Esc; 4/4→3/4 rebar on a tapped map |
| map-lane.test.js | suspect flagging; outlier-proof range |
| tempo-sources.test.js | open leaves the map untouched; Chorus metadata row; partial provider failures; independent audition offsets, restore and cancel with an exact history restore; align incl. pre-zero; keep is undoable and keeps ids; guard refusal; late-response safety; failed search keeps import; **input keys never reach player bindings** (:152); file import with drums; GP flow; drum preview skipped/empty; Space audition |
| tempo-import, tempo-archive, guitar-pro-bounds, guitar-pro-import, convex/tempoSources.test.ts | Parser and security bounds; unaffected by the UX rebuild |

`map-mode.test.js` is written against `openPlayer`. It must be rewritten against the new session module plus Edit · Map mount, with the same scenarios.

---

## 11. What 2.0 needs

### 11.1 `hasRealMap` (spec §1.1)
**Where:** `shared/song-map.ts`, so Convex can reuse it for B1 (`songs.list` → `hasRealMap`). The Convex target has no `Array.prototype.at` (song-map.ts:20-21): use `final()`.

**Proposed signature:** `hasRealMap(tempo, {hasPart = false} = {}) → boolean`.
1. `cleanSongMap(tempo?.songMap)?.origin` → true.
2. `hasPart` → true. The spec's "a notation part exists"; the caller supplies it (`getNotation`/`hasChart`).
3. A stored `songMap` with no origin (1.6–1.9 saves) → true if **any** of:
   - > 1 pin (spec);
   - any label (spec);
   - **recommended addition:** a one-pin map that is not the placeholder (pin time ≠ 0, `tailQpm` ≠ 120, or any bar not plain 4/4). Pressing D once on the first downbeat and setting the tail tempo with ⌥↑↓ is a real, deliberate map that the spec rule misses.
4. No songMap:
   - `source==='detected'` with a non-empty `detected` (spec) → true;
   - **recommended addition:** a non-empty legacy `tempo.map` (pre-1.6 manual sections). One section gives one pin and no label, so the spec rule calls a hand-entered "97 BPM 3/4" song unmapped.
5. Else false.

**Notes:**
- In 1.6–1.9 data, `source==='detected'` is meaningless next to a `songMap`, because every edited save dual-writes it (metronome.js:63). Only test leg 4 when `songMap` is absent.
- `'Pickup'` labels from `fromBeats` (song-map.ts:246) satisfy "any label". That is harmless (those maps are detected), but see §11.3 sections.
- **In-session**, the store should expose `isReal` = `!!data.origin || hasPart`, after a one-way upgrade at `load` (§11.2) so the heuristic runs once.
- Replace `map-mode.js:121 unmapped()` and `player.js:818` with it.
- Unit tests:
  - the spec cases plus both additions;
  - undo back to a no-origin map → not real;
  - shared snapshot round-trip;
  - "unmapped never renders Bar".

### 11.2 `songMap.origin` passthrough (exact change list)
1. `SongMapData` (song-map.ts:10): add `origin?: 'detected'|'tapped'|'imported'|'edited'`. Export `ORIGINS`.
2. `cleanSongMap` (163-173): copy `origin` only when it is in `ORIGINS`. **Drop an unknown value silently; never fail the whole map over it**, because a `null` return would make `load` fall back to legacy or default data.
3. `validateSongMap` (139-160): reject an unknown `origin` (edits only produce known values).
4. `toTimeline` (267-277) builds a new object and needs nothing. `normalize` mutates in place, so the origin survives. The constructors return no origin; callers stamp it.
5. **`SongMapStore.edit`** (69-89): add `edit(change, reason, {origin} = {})`, or a `REASON_ORIGIN` table:

   | Reasons | Origin |
   |---|---|
   | `pin`, `nudge`, `renumber`, `meter`, `unpin`, `ramp`, `tempo`, `scale`, `bar`, `drag`, `label`/`sections` (new) | `edited` |
   | `tap` and Tap-the-beat | `tapped` |
   | `replaceFromBeats` (detect) | `detected` |
   | `tempo-source`, `replaceFromTimeline`, drum-part adopt | `imported` |
   | `tempo-source-cancel` | none (keep the baseline's) |

   Stamp the origin only when the draft differs from `this.data` **ignoring `origin`**, so a no-op edit never creates an undo step. Origin lives inside the data, so **undo and redo restore it automatically**: undoing the first edit returns the Stage to unmapped.
6. `SongMapStore.load` (31-48), the **one-way upgrade**:
   - A stored map without origin that passes §11.1 rule 3 → `edited`.
   - A legacy `detected` translation → `detected`; a non-empty legacy `map` → `edited`.
   - Then **delete the `legacy` concept**: the `legacy` field, constructor option, `_step`/`edit` resets, metronome.js:33-35, metronome.js:62, and tempo-sources.js:148 and :171. It is written on the next save.
7. `metronome.serialize` (53-65) returns the settings plus `songMap` (with origin). **Drop the dual-write** of `source`, `map` and `detected`.
8. `player.js:882` (fetch shared notation only `if songMap.legacy`) and `:885` (adopt the part timeline `if songMap.legacy`) become "the stored tempo has no `songMap`". Stamp `origin:'imported'` on the adopted map.
9. `adopt(data)` (song-map.js:121) keeps a valid origin through `cleanSongMap`.
10. `convex/sharing.ts:43` needs no edit: it goes through `cleanSongMap`.
11. Tests to update:
    - map-mode.test.js:80 ("untouched legacy maps save unchanged" becomes "legacy maps upgrade once, on the next save");
    - song-map.test.js:96 (clean keeps origin; unknown dropped);
    - tempo-sources history restore (no legacy).

### 11.3 Bar↔time helpers for the Stage (add to `SongMapStore`; all cached in `_set`)
| Helper | Returns | Used by | Notes |
|---|---|---|---|
| `setDuration(d)` / construct from `song.duration` | — | §4.12 open before decode | Today the duration is fixed at construction (song-map.js:13) and the store only exists after stems load (player.js:813). The Stage renders the Road map and strip before audio is ready. |
| `bars` | `[{index, id, q0, q1, t0, t1, numerator, denominator, groups: beatGroups(m), label, pickup, meterChange, bpm, tempoChange: >1 bpm}]` for bars with t0 < duration | Road map rows and chips, strip, Edit · Map ruler | `beatGroups` is at notation.ts:76 |
| `barTimes` (Float64Array) + `barAtTime(t)` | index | lamps, loop snapping | binary search; avoid `nearestLine` (O(n)) per frame |
| `nextDownbeat(t, {after = 1e-3})` | `{index, time}` or null | **quantized jump** (§4.5, §9.5 `seekAt`), Again | Use bar starts (includes the pickup start, q = 0) |
| `beatAt(t)` | `{bar, beat, groups, groupIndex, phase 0–1, downbeat, pickup}` | **beat lamps**, Position `13 · 2` | Binary search over `beats` (`beatsOf` numbering). Before bar 1 (q < 0), number backwards from bar 0's meter, so "Pickup · 3" works. |
| `positionLabel(t)` (fix) | add `pickup: true` and `beat` numbered like `beatsOf` | HUD Position, count-in "bar 13" | Fixes the verified pickup and bar-0 inconsistency (§3.3) |
| `sections` | `[{bar, endBar, label (duplicates numbered "Chorus 2"), t0, t1, bars}]` plus `hasSections` | strip segments, HUD Section and Next, `[` `]`, palette, Loop default | Lift from `chart.js:52-60`, which reads the *part* timeline; mapped songs without a chart need it from the map. Leading unlabelled bars → "Start". **Ignore the bar-0 `'Pickup'` label** written by `fromBeats` (or stop writing it). |
| `sectionAt(t)`, `nextSection(t)` | `{section, barsUntil, beatsUntil}` | `next: Verse 2 · 6 bars`; in the last 2 bars `Verse 2 in 2 · 1` | — |
| `phraseAt(t, n = 4)` | bar range | Loop toggle "current 4-bar phrase" | phrases aligned to the section start |
| `refAt(t)` / `timeOfRef({id, beat})` | bar id plus group index (plus a fraction) | §9.3 `aBar`/`bBar` spot and loop anchoring | Re-resolve on store `subscribe` |
| `snapTime(t, 'bar'\|'beat')` | time | I/O, loop handles, Loop card ◀▶ | — |

The count-in for unmapped songs ("Lead-in 2 s") must consult `isReal`: `metronome.countInPlan` (139-161) currently always builds clicks from the placeholder grid.

### 11.4 Re-hosting in Edit · Map (spec §5.1, §9.2 `src/edit/map/`)
**Module split:**

| New module | From | Change |
|---|---|---|
| `session.js` (no DOM) | map-mode.js:104-499 (geometry, edits, bar form apply, preview, taps, calibration) and :538-547 actions | Inject a **transport façade** (`seek`, `playing`, `countingIn`, `toggle`, `positionAt(ctxTime)`, `ctx`, `setTemporaryLoop()`/`restoreLoop()`), a **click** (`enabled`, `setEnabled`, `clickAt(when, accent)` replacing `metronome._click`), view callbacks, prefs (`tapSnap`, `tapOffset` → `ws.prefs`; migrate `ws.tapSnap` and `ws.tapOffset`), an onsets provider. It emits `change` and `message(text, tone)`. |
| `inspector.js` | map-mode.js:45-96, 131-207, 340-396 | Rebuilt on primitives (Stepper, Segmented, Field, Button, InlineStatus); the mapping table is below |
| `lane.js` | map-mode.js:97-102, 618-704 + map-lane.js | Split the ruler from the curve. Diamonds 12 px with 24/44 px hit areas (map-mode.js:652). Token colours and fonts. Sections lane is new. |
| `find-panel.js` | tempo-sources.js | No freeze; a side panel; batch undo; the online-load decoder from player.js:915-924 |
| `commands.js` entries (scope `edit.map`) | `MAP_KEYS` and `handleKey` | `?` is generated from the registry |

**Inspector mapping** (spec §5.1 ← today):

| Section | New control | Today |
|---|---|---|
| Go to | `Bar [41] Go` | digits + ↵ (585-587, 333-337) |
| Go to | `◀ Bar` / `Bar ▶` | ← → (`step`, 219-233) |
| Go to | `⏮ ⏭` | ⌘← → |
| Meter | Beats `[−] n [+]` | `n` field / ↑↓ (`changeBeats`) |
| Meter | Unit · Groups · Pickup · Apply to · Keep in place · `Apply ↵` | the Edit bar form fields and submit (365-396), unchanged semantics |
| Label | `[Bridge]` | the Edit bar label field |
| Tempo | `♩ [96.00]` | the form's bpm field, editable **only on open spans** (344) |
| Tempo | ☐ Ramp (R) | `toggleRamp` / the form checkbox |
| Tempo | ×2 ÷2 | `scale` |
| Tempo | Tail tempo `[−] [+]` | ⌥↑↓ (`openTempo`) |
| Pin | "● Locked at …" / "free" | the Pin cell |
| Pin | `[Pin downbeat D]` `[Pin beat T]` / `[Unpin ⌫]` | `pinNearest` / `pinLine` / `removePin` |
| Pin | Nudge `[−10][−1][+1][+10] ms` | `,` `.` (`nudge`) |
| Pin | Renumber `[41]` | ⌥← → (`renumber`); typed numbers map to `renumberPin` to `barStart(n−1)` |
| Tools | Tap along | the Tap button |
| Tools | Calibrate… | menu → `startCalibration` |
| Tools | ☐ Snap taps | menu (`ws.tapSnap`) |
| Tools | Preview P | `togglePreview` |
| Tools | Detect beats | menu → `onDetect` |
| Tools | Find a chart… | `sources` |
| Status | InlineStatus | `say`/`attempt`, plus the guard refusals (player.js:889-899, part.js:65-75) |
| Undo | `↶ Undo` `↷ Redo` in the posture bar, ⌘Z | `history` |

**Find a chart without the freeze** (spec §5.1.2 "Nothing else is made inert"):
1. While auditioning, **disable every map-mutating command and lane edit** via the registry's `when: c => !c.map.auditioning`. This is cheaper and safer than isolating a second store.
   - Isolating would also need a second metronome and grid source, and would break guard checks against the live part.
2. Transport, Mix and view commands stay live. "Only the panel's own keys" applies while its field has focus (tempo-sources.js:243-249 already does this).
3. Wrap the audition in `beginBatch()` at open. "Use their map" → `endBatch()` gives one undo step. Cancel → restore the baseline without pushing.
   - This replaces the undo-stack reassignment at tempo-sources.js:171, and the "every try is an undo step" behaviour.
4. **Suppress persistence while auditioning:**
   - no `saveTempo` until commit or cancel;
   - pause notation `syncMap` saves: `part.commit('map')` → `store.set` on every try (part.js:61);
   - and do not re-resolve bar-anchored practice loops and spots per try.
5. Switching to Edit · Chart, or Done, mid-audition → `confirm({title:'Use this map?'})` (Use / Keep my map). Today `exit` silently cancels (map-mode.js:523 → tempo-sources.js:165).
6. Commit labels: **Use their map** = keep; **Use map + drum chart (N hits)** = importDrums; **Keep my map** = restore and close.
   - The spec also lists `Cancel`, which is identical to Keep my map. Ship one of them.
   - Keep "Your map" as the first radio row (restore and stay open).
7. "Line up first downbeat with the cue": read the transport cue (today `engine.editPosition`, tempo-sources.js:232).

**Entry, exit and URLs:**
- `/s/:id/edit/map?bar=N` (replace), and `/edit/map/find` opens the panel.
- `E` from the Stage. Edit · Chart "Bar meter & label…" and "Align in tempo map…" (editor.js:288-289) → navigate with `bar` and focus Meter. The chart empty state and the strip's Get bars → `/find`.
- Delete ⇧M (map-mode.js:565, 570), `#map-btn`, `#m-map` and `onEnter: leaveChart`.
- Keep entry's forced click and grid, restored on Done (map-mode.js:508-509, 531). **Also restore the click after Preview** (a bug today, §5.5).
- Done = `exit` (finish the pass, stop the preview, restore the loop) → Stage at the same position (shared session).
- Read-only: Edit is hidden in the Shared Stage.

**Key conflicts to resolve in the registry** (spec §7.2 vs `MAP_KEYS`):
- **K1 digits:** the §7.2 table says 1–9 in Edit · Map = "same" (mute stems), but its note keeps `MAP_KEYS` digits + ↵ = go to bar (map-mode.js:585).
  - Recommend digits = go to bar in `edit.map`; mute through the stem-row M/S buttons.
- **K2 E:** `MAP_KEYS` E = Edit bar; the §7.2 row says "—". Recommend E = focus the inspector's Meter → Beats field.
- **K3 Space:** §7.2 says "Play/Stop; taps while tapping". Today Space only plays and stops, and T/D tap (MAP_KEYS "Space: Play, then tap T").
  - Keep today's behaviour. Space cannot both tap and stop.
- **K4 Enter:** with digits pending → go to bar; with focus in an inspector field → Apply. Never Again in this scope.
- **K5:** ⇧S Snap, G Grid, `=`/`−` Zoom, `\` Fit, Z zoom to selection and S add section at playhead are new or moved into `edit.map`. L does nothing (P previews). ⌫ unpins (it must not clear the loop here).
- **K6 Esc order:** close menu or sheet → clear digits → stop preview → close Find (with the confirm) → Done.

### 11.5 Sections editing (new; no code today)
The sections lane and the strip's Rename write `measure.label` through `songMap.edit(d => { d.measures[i].label = … }, 'label')`:
- **Move a boundary** = clear the old bar's label and set the new bar's, in one edit.
- **Markers → sections** (§5.1 banner) = one edit snapping each marker with `nearestLine(t, {bars: true})`. Define a rule for two markers on one bar: keep the first and report a count.

Stage-side section edits (S, Rename) are map edits, but spec §4.14 puts "section rename from the strip" on the **practice** undo stack. Implement the practice entry as a forward inverse edit (`edit` restoring the old label), never `songMap.undo()`, because the two stacks interleave.

---

## 12. Bugs and risks found (ranked)
1. **The audition mutates the live store, which triggers persistence.** Each try causes a tempo save (400 ms), a notation retime and **save** (part.js:52-61), a count-in pause (metronome.js:88) and one undo entry. Removing the freeze without §11.4's scoping and suppression would let users edit during an audition and lose it, or would save candidate maps. Today this is contained only by the inert freeze.
2. **`cleanSongMap` strips `origin`** (verified). Without §11.2 the Stage's real-map switch is lost on every reload and share.
3. **The `hasRealMap` spec heuristic has gaps:** pre-1.6 manual sections, and real one-pin maps. Also `source==='detected'` is noise in 1.6–1.9 data (§11.1).
4. **Pickup and pre-bar-1 numbering is inconsistent** (verified): `positionLabel` 1·2 vs `beatsOf` 3·4; bar 0 before bar 1; `linesOf` marks the pickup start as a downbeat. `fromBeats` also writes a `'Pickup'` label that would show as a section.
5. **The store duration is fixed and the store is created after decode**, which blocks the §4.12 "render immediately" Road map and strip.
6. **The preview loop can be persisted as the practice loop:** `flushPractice` reads `engine.loop` on any keyup or click (player.js:1012-1022). Also, Preview never restores the click state (map-mode.js:421-429).
7. **Any map change pauses an active count-in** (metronome.js:88). A Stage `S` (add section) during a count-in would stop playback. Exempt label-only edits.
8. **`unmapped()` placeholder test** (map-mode.js:121) misclassifies a real map pinned at exactly 0:00.000 after reload. Replace it with `isReal`.
9. **Calibration never finishes if the AudioContext is suspended:** `tick` waits for `ctx.currentTime` (map-mode.js:716). Resume the context first.
10. **The Tap-the-beat spec text contradicts itself:** "via `fromBeats` (first and last taps pinned)", but `fromBeats` pins every tap, which gives a jittery tempo. Add `fromTaps(taps, duration, {numerator})`, a least-squares period and phase with pins at the first and last fitted downbeats and `origin:'tapped'`.
11. **Lamps:** "one dot per counted beat, 2+2+3 shown with gaps". Counted beats are groups (3 clicks in 7/8). Recommend one lamp per group, sized by group length, so the lamps match the click.
12. **Performance:** `nearestLine` and `spanAt` are linear; `getComputedStyle` runs per lane draw (map-mode.js:619-623). Keep them off the Stage's 60 Hz path.
13. **Every label edit also rewrites and saves the notation part** (timeline `measures` include labels; part.js:54-61). This is acceptable but chatty, and section renames from the Stage will save the part too.
14. **Every rule in `tempo-map.css` and `tempo-sources.css` violates the §9.2 CSS guards**, and the lane hardcodes its fonts (map-lane.js:9, 94). These need a full rewrite, not an import into `layer(legacy)` for longer than Phase 4.
15. **`map-mode.test.js` drives the whole `player.js`.** Its seven scenarios must be ported to the session module before `player.js` is decomposed (R7), or the strongest map regression net is lost.
