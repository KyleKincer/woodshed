# Map: notation subsystem (Chart, Transcribe, drum part)

Scope, with line counts at baseline commit `7deaaf4` (all line numbers refer to that tree):
- `src/js/notation/`: `chart.js` (227), `editor.js` (342), `launcher.js` (114), `part.js` (110), `store.js` (62), `score-view.js` (252), `alphatab-score.js` (164), `lanes.js` (43), `audio.js` (109), `entry.js` (63), `import-drums.js` (144), `html.js` (1), plus CSS `chart.css` (45), `notation.css` (79) and `score-view.css` (17).
- Shared and server: `shared/notation.ts` (192), `shared/engrave.ts` (297), `convex/notation.ts` (73).
- Tests: `tests/notation-{alphatab,audio,chart,editor,engrave,entry,model,regressions,render,songmap,store}.test.js`, `tests/drum-import.test.js`, `convex/notation.test.ts`.
- Integration points read: `src/js/player.js:2,13,15,874-937,1007-1009,1022-1029,1033-1035,1080-1083`.

Spec targets:
- `docs/ux2/spec.md` §4.4A: chart surface API `chrome:false`, `setScale`, `setDisplay`, `setFollowStyle`, `onBarActivate`, `setLoopRange`, `setGlass`.
- §4.8 and §4.9: loop creation and glass rules on the music.
- §4.11: Distance.
- §5.2: Edit · Chart re-frame.
- §7.1 and §7.2: registry and keys.
- §9.2: `surfaces/chart-surface.js`, `src/edit/chart/`.
- §9.6: deletions.

Owner decisions apply to everything below:
- **No backwards-compat UX.** No `chrome:true` chart path kept beside the new one. No Classic keys, no key-change hint, no "new" badges, no `ws.flags` rollout gating, no long-lived legacy CSS.
- **Stored data is still read, with a one-way upgrade.** That covers `ws.chart.*`, `ws.notation.*`, `ws.practice.view`, version-1 notation parts and IndexedDB drafts.
- Transcribe keeps **16-bar pages**. The Stage is **always dark**.

---

## 1. Module graph

```
player.js:2  ── attachNotation ──► launcher.js ──(dynamic)──► part.js ──► store.js ──► convex notation.get/save, IndexedDB 'woodshed-notation'
player.js:13 ── importDrumHits ──► import-drums.js                  │        └──► entry.js (scoreFromTiming)
player.js:15 ── validateBar (shared/notation.ts)                    │
                                   launcher.js ──(dynamic)──► chart.js ──► score-view.js ──► alphatab-score.js ──► shared/engrave.ts
                                   launcher.js ──(dynamic)──► editor.js ─► score-view.js, lanes.js, audio.js, entry.js,
                                                                           ../modal-focus.js (focusModal), ../interactions.js (isPointerControl),
                                                                           ../timeline-navigation.js (wheelNavigation)
shared/notation.ts ◄──► shared/engrave.ts   (notation.ts imports engraveBar for validateBar; engrave.ts imports types and KIT;
                                              engrave.ts:46 warns that nothing may call into notation.ts at load time)
convex/notation.ts ──► shared/notation (validateTimeline, validateBar, upgradeBar, currentBar), convex/lib/notationValidators, convex/sharing (sharedSource)
```

Other consumers of the notation model:
- `export.js:4,39-41` exports `drums.woodshed.json`.
- `song-map.js:3,58-59` provides `notationAfter`.
- `map-mode.js:5,277,376` refuses meter changes when later bars hold notation.
- `tempo-sources.js:19` makes `.notation-workspace` inert.
- `guitar-pro-import.js:6` and `tempo-import.js:2` share the KIT and fraction maths.

Code-splitting: `part.js`, `chart.js` and `editor.js` (with alphaTab) load only through `launcher.js:37,43,53`. Keep this split in the new tree: `chart-surface.js` and `src/edit/chart/` must import them dynamically, so alphaTab stays off the Library path.

---

## 2. Data model the UI relies on (`shared/notation.ts`, `shared/engrave.ts`). KEEP unchanged.

| Export | Line | Used by the UI for |
|---|---|---|
| Types `Fraction`, `Measure{id,numerator,denominator,length,label,grouping?}`, `Anchor{position,time}`, `Timeline{version:1,measures,anchors}` | 2-5 | Bars and sections. `measure.label` is the section name, the same model as the song map. |
| `Hit` (position plus expression only; no duration) | 10-14 | Editor and import |
| `TupletSpan`, `Bar{measureId,coverage,hits,tuplets?}` | 16-17 | `coverage: 'unstarted'\|'progress'\|'reviewed'` drives `hasNotation` and the "Mark bars reviewed" overlay |
| `Layout = 'split'\|'combined'` | 19 | Part layout (saved) vs Display (device), §4 and §5 below |
| `Score{version:2,title,layout?,timeline,bars}` | 20 | |
| `MAX_MEASURES=1024, MAX_HITS_PER_BAR=256, MAX_HITS=16000, MAX_TUPLETS_PER_BAR=32` | 24 | Limits copy |
| `KIT` (27 pieces: `id,name,short,key,midi,gp,line,voice,family,core?`) | 33-60 | Kit pads, lane rows, drum letters and the iPad pad bank (§12.6). Families: cymbal 15, drum 9, foot 2, aux 1. |
| `kitPiece(id)` | 62 | |
| `fraction/number/add/subtract/compare/id/durationOf` | 65-74 | |
| `beatGroups(m)`, `groupAt` | 76-77 | |
| `musicalStarts(t)` / `starts(t)` / `extent(t)` | 78-80 | Bar start quarters, e.g. `chart.js:45-47` |
| `toTime(t,q)` / `toQuarter(t,time)` | 88-89 | Piecewise-linear over the anchors. This is how the chart and editor map engine seconds to quarter-note position. |
| `locate(t,q)` → `{index,measure,start,startPosition,offset}` | 90 | |
| `emptyScore`, `validateTimeline`, `validateBar`, `validateScore` | 94-131 | Guards |
| `upgradeBar`, `upgradeScore`, `currentBar` | 134-169 | **One-way read of version-1 parts.** It must stay: the owner's stored parts. |
| `class ScoreEditor` (`transact`, `undo`/`redo` with 100-deep stacks, `bar`, `insert`, `remove`, `change`, `setTuplet`, `setLayout`, `move`, `pasteHits`, `paste`) | 170-191 | The notation undo stack (§7.8 "Notation") |
| `engrave.ts`: `isBinary`, `writtenValue`, `rhythmCells`, `engraveBar`, `canWrite`, `chooseGrid` | 50-297 | Written rhythm is derived. Nothing in the re-frame touches it. |

The Stage needs these from the model, all already present:
- section list: `measure.label`;
- bar↔time: `musicalStarts` + `toTime`/`toQuarter`;
- measure ids for bar-anchored loops and spots (`aBar.id`). The part's timeline **is** the song map's timeline: `part.js:21-28,51-62` clones `songMap.timeline()`, so `measure.id` values are shared with the song map.

---

## 3. Persistence

### 3.1 `store.js`: `NotationStore` (local journal plus revisioned server writes)
- IndexedDB `woodshed-notation` / store `drafts`, keyed by songId (`store.js:5-6`).
- `load()` (18-35):
  - fetches `notation.get{songId}` and the local draft in parallel;
  - if the draft differs from its baseline, or holds a pending write, it **replays** the pending mutation;
  - a version-1 journal is upgraded at 26;
  - it can end **blocked** (`conflict`) when the server revision moved (30).
  - Statuses go through `onStatus`: `saved`, `local`, `conflict`.
- `set(score)` (37) canonicalises, journals (`persist`), sets `local` and debounces `flush` by **650 ms**.
- `flush()` / `drain()` (38-57):
  - serialized;
  - sends **≤ 16 changed bars per mutation** (47), each write with a fresh `mutationId` stored in the journal before sending (50);
  - loops until the score equals the baseline;
  - statuses: `saving` → `saved`; on error `conflict` / `offline` / `storage-error`.
- `reload()` (58) adopts the server copy (used by "Load saved version").
- `destroy()` (59) flushes, and removes the `beforeunload` guard (17) only after the flush.
- `loadSharedNotation(token)` / `watchSharedNotation(token, …)` (61-62) serve read-only shared parts, live through `convex.onUpdate`.

### 3.2 `convex/notation.ts`
- `get({songId}|{token})` (31-36):
  - with a token: `sharedSource`, and returns null if `songShares.includeNotation === false`;
  - otherwise: an owner check.
  - Returns `{score: {...header, bars}, revision}` or null.
- `save({songId, baseRevision, mutationId, header, bars ≤ 16})` (37-73):
  - checks ownership and a writable account;
  - validation: timeline, every bar, version-2 bars already current (43), no duplicate bars;
  - idempotent on `lastMutation` (46);
  - error codes: `NOTATION_UPGRADE_REQUIRED` (49), `NOTATION_CONFLICT` (50), `NOTATION_UNCHANGED` (54-55, 66; the client treats it as an ack, `store.js:10-13`);
  - writes `notationParts{header, revision, lastMutation, hitCount}` and one `notationBars` row per bar.
- Helpers used elsewhere: `readPart`, `sharedPart`, `deletePart` (songs.remove), `capturePart` (shared copy) (11-30).
- **No change is required by the spec.**
  - Optional backend item B1 wants `hasChart` in `songs.list`. Today that needs either a `notationParts.by_songId` lookup per listed song, or a denormalised field written by `notation.save`. Prefer the latter: `hitCount > 0 || any reviewed bar`.
  - The legacy-client branches (version-1 writes, `NOTATION_UNCHANGED`) are server compatibility, not UX. Leaving them costs nothing. Deleting them would only be cleanup; it is not required by the owner's no-compat rule, which is about UI ceremony.

### 3.3 `part.js`: `openPart(options)`, one drum part per open song (13-110)
The Chart and Transcribe already share one part object. **That is the property the Stage/Edit shared session needs (§1.2 "one loaded song").**

- **Inputs:** `{song, engine, metronome, songMap, readOnly, shareToken, persistence}` (13).
- **Load** (35-48):
  - read-only parts come from `loadSharedNotation`;
  - otherwise from `persistence || new NotationStore`;
  - a missing score still creates an editor on `newScore()` (33).
  - **Consequence:** `part.editor` is non-null even when no part row exists. "A notation part exists", from the legacy `hasRealMap` rule (§1.1), must not be read from `part.editor`. Use `part.hasNotation` or the raw load result.
- **Song-map binding:**
  - `mapScore`/`fitScore` (21-32) force the part onto `songMap.timeline()` and remap bar ids when needed;
  - `syncMap` (52-62) follows map edits and retimes the undo and redo stacks (51);
  - `noteGuard` (65-74) is registered as `songMap.setGuard('notation', …)` (75) and refuses map edits that strand notes. Spec §5.1 renders these refusals in the Map inspector status line.
- **Shared:** `sharedUpdate` and `watchSharedNotation` (76-77) emit `'shared'`.
- **Object** (79-109):
  - getters: `readOnly`, `song`, `editor`, `score`, `store`, `status`, `hasNotation` (86: any bar with hits or `reviewed`);
  - `subscribe(fn(reason))`, where reason ∈ `'edit'|'map'|'import'|'shared'|'reload'|{type:'error',message}`;
  - `onStatus(fn)`, called immediately with the current status (88);
  - `commit(reason)`;
  - `mapScore`, `fitScore`;
  - `importScore(input)` (94-103): refuses when the part is read-only, blocked or already written; one undoable transaction;
  - `reload()`, `clampPosition`, `flush`, `destroy`.

**Duplicate path to remove when the session is rebuilt:**
- `player.js:878-901` (`adoptDrumPart`) fetches `notation.get` a second time (also fetched in `store.load`).
- It adopts the part's timeline into a **legacy** song map (885-887). Keep this; it is a one-way upgrade of stored data.
- It also installs a second `'notation'` guard (889-899), which `part.js:75` later replaces.
- `launcher.js:37` waits on `ready: drumPartReady` so the part opens **after** map adoption.

The new session must keep this order: adopt the legacy map, then open the part. It can pass the already-fetched remote into the store, so `notation.get` is not fetched twice.

---

## 4. Rendering: `score-view.js` + `alphatab-score.js`

### 4.1 `createScoreView(host, {scale=1, barsPerRow=-1, print=false, onRender, onPointer})` (score-view.js:29)
- **DOM:** `.score-stage > svg.score-overlay + .score-engraving` (30-39). alphaTab draws into `.score-engraving`; the overlay sits **under** it (z-index 0, `pointer-events:none`; score-view.css:4-6).
- **alphaTab settings** (42-70):
  - no workers;
  - note bounds on;
  - lazy loading except for print;
  - Bravura via Vite `?url` (6-7, so it lands in `/assets/`, fine for Electron);
  - player and cursor off;
  - `LayoutMode.Page`, `StaveProfile.Score`;
  - `display.scale`, `display.barsPerRow`, padding 12/18, system padding 6/18;
  - title, track names, tuning, dynamics and chord elements hidden (59-60).
- **Theme** (12-21, 61, 197-198): `themeResources` reads `--text`, `--muted` and `--notation-lines` with `getComputedStyle(document.documentElement)`. **It reads the document root, not the host.** It re-renders on `woodshed:theme`.
- **Fonts** (63-69):
  - family from `--font`, read **once at construction**;
  - EffectMarker (section labels) bold 15 px;
  - EffectTempo bold 12;
  - **BarNumber 11 px**;
  - EffectText italic 12;
  - EffectLyrics (sticking) bold 11.
- **Geometry** (76-118): built on `renderFinished` (174-180). Per bar it holds `{bar, system, points (q→x knots), beats, lineTop, lineHeight}`. `xAt(q)` interpolates; `barIndexAt(q)` is a binary search.
- **Overlay layers** (120-172):
  - static: bar marks, loop rects (one per bar row segment), focus-range rects, selected noteheads, caret plus label;
  - `nowLayer`: `rect.score-now-bar` plus `line.score-playhead`, updated alone by `setPlayhead`.
- **Render** (182-195): `startBar`/`barCount` from `renderOptions.range` (editor pagination), then `buildAlphaTabScore` and `api.renderScore`.
- **`locate(event)`** (201-222) → `{x, y, index, q, hit, beat, beatQ, lineTop, lineHeight}`, from stage-relative pointer coordinates.
- **Pointer wiring:** `pointer{down,move,up,cancel}` on `stage` → `onPointer({kind, event, at})` (223).
- A `ResizeObserver` on the stage re-measures the overlay only (224-225). alphaTab itself re-lays out on container **width** change.
- **Returned API** (227-250):
  - `api, host, stage, ready, score`;
  - `setScore(score, opts)`, `setOptions`;
  - `setScale(v)`: `updateSettings` plus `api.render()`, a full relayout;
  - `setBarsPerRow(v)`;
  - `setPlayhead(q)`, `setLoop([qa,qb]|null)`, `setSelection(Set)`, `setCaret({q,label}|null)`, `setRange([i,j]|null)`, `setBarMarks(Map)`;
  - `locate`, `noteBoxes()`, `barBounds(i)` → `{x, y: system.y, w, h: system.h, lineTop, lineHeight}`, `positionX(q)`, `barAt(q)`, `rendered(i)`, `destroy()`.
- **Overlay CSS** (score-view.css:7-16):
  - `.score-now-bar` uses `--accent` at .13;
  - `.score-playhead` is `--accent`, 2.5 px;
  - `.score-loop` uses `--loop-fill` with an `--accent` stroke;
  - `.score-selected` / `.score-caret` use `--accent`;
  - `.score-mark-reviewed` uses `--good`.
  - Under the spec's colour rule (§8.3), the now-bar and playhead become `--now-soft` / `--now` (3 px); caret, selection and loop stay cobalt.

### 4.2 `alphatab-score.js` (pure, Node-tested)
- `barTempo` (11) and `tempoMarks` (22): only changes ≥ 4 BPM that hold for 2 bars become marks.
- `repeatedBars` (35): simile.
- `buildAlphaTabScore(at, score, {layout, range, simile, title})` (59-163):
  - section labels become `master.section` (89);
  - tempo automations;
  - per-bar beaming rules (94-99);
  - one or two voices by layout;
  - untranscribed bars stay blank (111);
  - flam and drag graces, tuplets, rolls (tremolo), sticking as lyrics;
  - returns `{score, beats: Map<atBeat,{index,beat,voice}>, bars: number[], noteHits: Map<atNote,hit>}`.
- KEEP unchanged.

---

## 5. `chart.js`: today's practice chart

### 5.1 Public API
`createChart({host, part, engine, setLoop, clearLoop, onMixerChange = () => {}, onEmpty = {}})` (24). It returns (219-226):

| Member | Behaviour |
|---|---|
| `host` | The `section.chart` element |
| `setVisible(next)` | Sets `visible` and `host.hidden`. When shown: `render()`, then `requestAnimationFrame(() => sync(true))`. |
| `tick()` | `sync()` when visible. The time argument the launcher passes (`launcher.js:104`) is **ignored**; `sync` reads `engine.getPosition()` itself. |
| `refresh()` | Forces a re-engrave (`renderedScore = null; render()`) |
| `notice(text)` | Shows or hides the dismissable `.chart-notice` box (used after an import) |
| `destroy()` | Unsubscribes from the part, removes the theme listener, destroys the view, removes the host |

**Engine surface it touches:** `engine.getPosition()`, `engine.seek(t)`, `engine.loop{enabled,a,b}`, `engine.duration`, `engine.playing`, `engine.tracks[].name/.muted`, `engine.toggleMute('drums')`.

**Part surface it touches:** `part.score` (`.timeline`, `.layout`), `part.hasNotation`, `part.readOnly`, `part.subscribe`.

### 5.2 State and preferences
- `scale = ws.chart.scale` (JSON number), default `defaultScale()`: 0.9 under 1000 px wide, else 1.1 (16, 25). Steps `SCALES = [.8,.9,1,1.1,1.25,1.4,1.6,1.8]` (14).
- `layoutOverride = ws.chart.layout` (JSON `'combined'|'split'|null`) (26). This is a **per-device display override** of the part's own `score.layout` (48).
- Ephemeral: `pendingLoop`, `follow = true`, `visible`, `view`, `lastQ`, `lastLoop`, `lastSystem`, `programmaticScroll`, `renderedScore`, `renderedLayout` (27).
- A local `store` wrapper over localStorage (10-13) duplicates the pattern found elsewhere. It goes once `prefs.js` exists.

### 5.3 Markup (29-42)
```
.chart-bar[role=toolbar "Chart"]
  .chart-sections[aria-label=Sections]            ← section chips (buttons, data-section=index, aria-current)
  .chart-tools
    [data-chart=loop-section] "Loop section"
    [data-chart=follow][aria-pressed] "Follow"
    .chart-zoom[role=group] [data-chart=smaller] "−" · .chart-scale "110%" · [data-chart=larger] "+"
    .chart-layout[role=group] [data-layout=combined] "Together" · [data-layout=split] "Hands / feet"
    [data-chart=mute-drums][aria-pressed] "Mute drums" / "Drums muted"   (hidden without a drums stem)
.chart-scroll[tabindex=-1] > .chart-score          ← createScoreView host
.chart-empty[hidden]
.chart-notice[role=status][hidden] > p + [data-chart=dismiss] ✕
p.chart-hint[role=status]                          ← 3.2 s transient pill (say(), 50)
```

### 5.4 Toolbar features and their new homes (spec §4.4A)
| Feature | Today (file:line) | Semantics to preserve | New home |
|---|---|---|---|
| **Section chips** | `sectionList` 52-60, paint 70-71, active sync 115-119, click 185-188 | One chip per labelled bar. A "Start" chip is prepended when bar 1 is unlabelled; with no labels at all there is one "Bar 1" chip. Duplicate labels are numbered ("Chorus 2"). `end` = the bar before the next chip. Tap → `engine.seek(barTime)`, follow on, scroll to the bar. The current chip gets `aria-current` and `scrollIntoView`. | **Song strip** (§4.5). Move `sectionList` to a shared pure helper so the strip, the HUD "Section/Next" and the editor section menu use one rule. Under `hasRealMap`, "Bar 1" must never show on unmapped songs; a chart implies a mapped song, but the helper is shared. |
| **Loop section** | 197-207 | Current section from `lastQ`. a = `max(0, barTime(index))`, b = `min(duration, barEndTime(end))`. If the loop already equals [a,b] (1 ms tolerance) → clear it ("Loop off"). Refuse if `b − a < .02` ("This section starts after the recording ends"). Otherwise `setLoop(a,b)`; when stopped, seek to the section start. | `L` (smart default) and `⇧L`, plus strip double-tap, as transport commands (`transport.loopSection()`). Keep the clamp and the refusal copy. The toggle-off-when-identical rule becomes plain `L`. |
| **Follow** | button 33,192; `stopFollowing` 103-105; resumed on tap/drag/chip (169,175,187) | Manual wheel/touchmove **while playing** turns follow off, ignoring the first 900 ms after a programmatic scroll and any armed gesture. Taps, loop drags and chips turn it back on. | Automatic, plus the `⤓ Back to playhead` pill (§4.9). Resumes after 8 s idle, or on Play/Again/F. The chart reports changes through `onFollowChange` (§11). Spec change: manual scroll pauses Follow **when stopped too**. |
| **Size** | 34, 193-196, `SCALES`, `ws.chart.scale` | ±1 step through `SCALES`, persisted, `view.setScale` (full relayout) | Distance default (laptop 110/130/160 %, iPad portrait 100/120/150 %), plus pinch (80–200 %: CSS transform while pinching, one relayout on release), plus `=`/`−`. The chart exposes `setScale` and `previewScale`; persistence moves to `prefs`. |
| **Together / Hands & feet** | 35, 190, `layout()` 48 | Per-device override. Picking the part's own layout stores `null`. Re-renders with `view.setScore(score, {layout})`. | `⋯` → "**Display:** Together · Hands & feet (this device)" → `chart.setDisplay({layout})`. The **part** layout (saved) lives only in Edit · Chart Properties (§5.2). |
| **Mute drums** | 36, 49, 67-69, 122-123, 208 | `engine.toggleMute('drums')` + `onMixerChange()`. Repainted each `sync` when the stem is muted elsewhere. Hidden with no drum stem. | Mix sheet / Minus me (`M`). Removed from the chart entirely. |
| **Notice box** | 41, 209, 224 | Import result text with a dismiss ✕ | Status line or toast from the importer (Edit · Map Find panel). No chart DOM. |
| **Hint pill** `say()` | 42, 50 | 3.2 s text ("Drag across bars to loop them", "Tap the last bar to loop", "Looping bars 3–6", "Loop off") | The Stage status line (`role=status`, 2.5 s), through an `onStatus(text)` callback |

### 5.5 Gestures (`pointer()` 128-180), the exact current behaviour
- **Down** (132-138). Ignored unless button 0 and a bar hit (`at.index != null`).
  - `gesture = {id, start: at, x, y, dragging: false, touch: pointerType !== 'mouse', armed: pointerType === 'mouse'}`.
  - Mouse: `setPointerCapture` on `view.stage` (136). The "drag released outside the score" test covers this (`notation-chart.test.js:220`).
  - Touch: a **380 ms** timer arms the gesture (`armed = dragging = true`), vibrates 10 ms, shows a one-bar range (`view.setRange`) and says "Drag across bars to loop them" (137).
- **Move** (140-151).
  - A mouse move with `buttons === 0` is treated as up (141).
  - Unarmed (touch before the long-press): moving more than 8 px cancels the gesture, so it becomes a scroll (144).
  - Armed: more than 6 px starts dragging, and `view.setRange([min,max])` follows.
- `touchmove` is `preventDefault`ed while armed (180), so the loop drag doesn't scroll. `contextmenu` is suppressed for touch gestures (177).
- **Cancel** (155): clears the range, keeping a pending one-bar mark if present.
- **The long-press-then-tap pending state** (156-162; the spec cites ~162-166). **DELETE.**
  - 157: a touch long-press released with no drag sets `pendingLoop = start.index`, keeps the one-bar range and says "Tap the last bar to loop".
  - 158-162: the next plain tap turns the gesture into a loop from `pendingLoop` to that bar.
  - Test `notation-chart.test.js:108` pins this behaviour.
- **Drag end** (163-171): `setLoop(barTime(a), barEndTime(b))`, `engine.seek(barTime(a))`, a status message, follow on, `sync(true)`. So **a loop drag always seeks to its start**, even while playing.
- **Tap** (172-175): seeks to `beatQ` when the nearest written beat lies within 1 quarter of the tap, otherwise to the bar start. Follow on. Tests: `notation-chart.test.js:88,119`.
- What the spec changes (§4.8, §4.9):
  - touch long-press becomes **350 ms**;
  - release without a drag opens the **bar menu**;
  - while playing, touch taps never seek (pill instead);
  - mouse click while playing seeks;
  - double-tap / double-click plays from there;
  - right-click and long-press open the bar menu;
  - Alt-drag snaps to beats;
  - loop handles resize and move the loop;
  - touch while playing never creates a loop.

### 5.6 Empty state (`showEmpty` 74-81; `render` 85)
- Shown when `!part.score || !part.hasNotation`. It hides the scroller and toolbar.
- Owner copy: "No drum chart yet". The body refers to "**Tempo map → Import**", a label that no longer exists (inventory §13).
- Buttons: `Import a file…` (`onEmpty.importFile`) and `Open Transcribe` (`onEmpty.transcribe`).
- Read-only copy: "No drum chart shared" / "The person who shared this song hasn't included drum notation."
- Spec (§5.4): "No drum chart yet. [Find a chart] [Import a file] [Write one]". Shared: "No drum chart was shared." `onEmpty` becomes `{findChart, importFile, write}`:
  - `findChart` → `/s/:id/edit/map/find`;
  - `importFile` → the Find panel's file import;
  - `write` → `/s/:id/edit/chart`.

### 5.7 Render and scroll internals
- `render()` (83-90):
  - creates the view lazily with `{scale, onRender: () => {lastSystem = null; sync(true)}, onPointer}`;
  - re-engraves only when `part.score` identity or the layout changes;
  - is called on every `part.subscribe` notification while visible (215).
- `scrollToBar(index, smooth, attempt)` (93-102):
  - target = `bounds.y − clientHeight × 0.22` (**22 %**, hard-coded);
  - it skips when within 4 px;
  - it retries for up to 30 rAFs until alphaTab has grown the surface (99);
  - it stamps `programmaticScroll`.
- `sync(force)` (107-126), run every frame from `tick`:
  1. `q = toQuarter(timeline, engine.getPosition())`.
  2. If q changed (or force): `view.setPlayhead(q)`. If follow is on and the bar's **system y** changed (or force), `scrollToBar`. Update section chip `aria-current`.
  3. Repaint the mute button if the drums stem's mute changed (122-123).
  4. Loop: build a key from `engine.loop` and, on change, `view.setLoop([toQuarter(a), toQuarter(b)] | null)` (124-125). **The chart polls `engine.loop` every frame.**
- Theme (216-217): `woodshed:theme` → `renderedScore = null; render()`. `score-view.js:197-198` *also* re-renders on the same event, so a theme change engraves twice. The Stage is always dark, so the Stage chart should ignore app-theme events (see §14 R3).
- Layout CSS (chart.css):
  - `.chart` is a flex column;
  - `.chart-scroll` is `overflow:auto; overscroll-behavior:contain`;
  - `.chart-score{max-width:1500px; padding: 8px 8px 40vh}`. The 40vh bottom pad lets late systems reach the follow line; keep it for Page follow.
  - `.score-stage{touch-action: pan-x pan-y; user-select: none; -webkit-touch-callout: none}` (22);
  - `.player.chart-active …{display:none!important}` hides the waveform UI (32-34);
  - the coarse-pointer enlargements (43) go with the toolbar.

---

## 6. How the chart is mounted from `player.js` and how it follows playback

1. **Map adoption first.** `player.js:880-901` `adoptDrumPart()` produces `drumPartReady` (901).
2. **Mount.** `player.js:1007-1008` calls `attachNotation({...})` with:
   - `root, song, engine: activeEngine, metronome: songMetronome, songMap`;
   - `ready: drumPartReady`;
   - `setLoop: (a,b) => {activeEngine.setLoop(true,a,b); setLoopBtn(true); updateLoopOverlay();}`;
   - `clearLoop: () => {activeEngine.setLoop(false); setLoopBtn(false); updateLoopOverlay();}`;
   - `openImport: readOnly ? null : async () => {mapMode.enter(); await drumPartReady; if (mapMode.active()) tempoSources.open();}`;
   - `mapActive: () => mapMode.active()`;
   - `openMap: (q, options) => mapMode.enter(q, options)`;
   - `getView: () => ({...view}), setView, setFollow`. These are the **waveform** viewport, used by the editor's lanes view.
   - `play: doPlayStop`, `readOnly`, `shareToken`, `onLoopChange: updateLoopOverlay`;
   - `onMixerChange` repaints the track mute buttons and waveforms.
   - Cleanup is registered at 1009.
3. **Launcher → chart.** `launcher.js:42-47` creates the chart with `host: chartHost` (a `section.chart` inserted before `.transport`, 16-20), `engine`, `onMixerChange`, `setLoop`, `clearLoop` and `onEmpty`.
4. **Initial view.** When the part loads with `hasNotation` and `ws.practice.view !== 'tracks'`, the launcher shows `'chart'` (93-98). This sets `.player.chart-active` (31), which hides the tracks, ruler, overview, timeline tools, map lane and map strip (chart.css:32).
5. **Per-frame follow.** The `player.js:1033` rAF `frame()` calls `transcription.tick(pos)` (1035) → `launcher.tick` (104) → `chart.tick()` → `sync()`. That sets the playhead each frame q changes and scrolls whenever the playing bar's system changes. During loop wraps, q jumps back, the system changes and the view smooth-scrolls back up. When stopped and seeking, the same code follows the cue.
   - The player's own `follow` and `setFollow` (540-546) are the **waveform** follow and are unrelated to the chart's `follow`.
   - `doPlayStop` (980) calls `setFollow(true)` for the waveform only. The chart's follow is resumed only by chart gestures.
6. **Leaving.**
   - Entering the tempo map calls `transcription.leaveChart()` (909) → `show('tracks')`. The map edits the waveform timeline (tested at `notation-chart.test.js:213`).
   - `saveForShare` awaits `transcription.flush()` (1024).
   - Drum import from tempo sources calls `transcription.importScore(score, warnings)` (931) → the chart is shown with a notice.

**In the Stage this becomes:**
- `stage.js` owns one rAF.
- `chart-surface.js` calls `chart.tick()`. The time is passed in, so the per-frame position comes from one place.
- Loop state is pushed with `setLoopRange` instead of polled.
- Follow is driven by `setFollowStyle` and the follow pill.

---

## 7. `launcher.js` responsibilities and where each goes (the file is deleted, §9.6)

| # | Responsibility | Lines | New home |
|---|---|---|---|
| L1 | Create `section.chart` and `section.notation-workspace` and insert them before `.transport` | 16-20 | `chart-surface.js` mounts into the Stage music column; `src/edit/chart/` mounts into the Edit main area |
| L2 | Practice view switch "Chart \| Tracks" in `.workspace-nav`, plus the spacer | 22-27, 33-34, 90 | Deleted. Replaced by surface choice (`V`, `⋯` → View) saved in `practice.surface` |
| L3 | `ws.practice.view` read/write (only the switch remembers) | 7-9, 65-69, 89, 93-98 | One-way upgrade: `'tracks'` → `surface: 'stems'`; `'chart'` → `'chart'`. Applied as the default only when the song has no `practice.surface`. Then the key is deleted. |
| L4 | `.player` classes `notation-active` / `chart-active`; `aria-pressed` on the nav tabs | 29-35 | Deleted. Postures are routes (`/s/:id`, `/s/:id/edit/chart`). |
| L5 | Lazy-load the part once (`partPending`), gated on `ready`; destroy it if the song closed meanwhile | 37-40 | **Session level** (one part per loaded song, shared by the Stage chart, the Edit chart, the Mix "Chart playback", hasRealMap and the importer). For example `src/stage/notation-session.js`, created by the song session after map adoption. |
| L6 | Lazy-load `chart.js` / `editor.js` (code split), with `closed` guards | 42-57 | `chart-surface.js` (dynamic `import('../../js/notation/chart.js')`), `src/edit/chart/chart-edit.js` (dynamic editor import) |
| L7 | Loading text and error with Try again ("Loading chart…", "Couldn't open the chart") | 59-63, 77-79, 82-84 | The chart surface's own loading state (bar-grid shimmer) and error state in the music area (§4.12: errors in the music area, other controls `aria-disabled`) |
| L8 | Auto-open the chart when the part has notation | 93-98 | Surface default rule (§4.4): Chart when `hasNotation`, else Road map. It must wait for the part load, since resume renders immediately. Show the Road map/grid shimmer until the part answers, then switch **once**, and only if `practice.surface` was unset. |
| L9 | `leaveChart()` for the tempo map | 102 | Deleted. Edit · Map is a separate posture. |
| L10 | `handleKey(e)`: **returns `true` whenever Transcribe is shown**, which swallows all remaining player keys | 103 | Registry scopes (§12.5) |
| L11 | `tick(time)` routed to whichever view is shown | 104 | The Stage rAF and the Edit rAF |
| L12 | `flush()` | 105 | `session.flush()` (share, unmount, `pagehide`) |
| L13 | `importScore(score, notice)`: load the part, `part.importScore`, show the chart, notice | 106-111 | `session.notation.importScore()`, called by the Find panel commit "Use map + drum chart (N hits)". The notice goes to the panel's InlineStatus or a toast. Then the Stage surface becomes Chart. |
| L14 | `destroy()` | 112 | Session unmount |

---

## 8. `editor.js`: Transcribe workspace, frame vs internals

### 8.1 Factory signature and coupling
`createNotationWorkspace({host, part, song, engine, songMap = null, mapActive = () => false, openMap = null, getView, setView, setFollow, play, readOnly = false, onLoopChange = () => {}, onMixerChange = () => {}, setLoop = null})` (30) is `async`.

| Option | Used at | Coupling note |
|---|---|---|
| `getView`/`setView`/`setFollow` | 63-65, 77, 101, 164-165, 186, 212-216, 241, 286, 338 | The **player waveform window**. Lanes are drawn in the same seconds window as the tracks above them (`.notation-active` keeps 64 px tracks visible; notation.css:21). `setFollow(false)` turns off **waveform** follow on any edit. |
| `play` | 297, 304 | `doPlayStop({pause})`. Space = play/stop; **Enter = pause** (304). |
| `songMap`, `openMap` | 135, 288-289 | With a song map (always, in today's player), "Bar meter & label…" → `openMap(a.startPosition, {edit:true})` and "Align in tempo map…" → `openMap(cursor)`. Without one, the legacy `alignment()` dialog (108-115) and the "Align this beat" dialog (289) open; these are unreachable. |
| `mapActive` | 303 | Keys yield while map mode is active |
| `setLoop`/`onLoopChange` | 287 | "Loop" on the bar range |
| `onMixerChange` | 298 | "Mute recorded drums" |
| `readOnly` | 71, 125, 135-136, 140, 145-146, 266 | Shared view. The spec hides Edit on the Shared Stage (§4.13), so every read-only branch becomes dead. |
| `host.closest('.player')` | 134, 335, 341 | Toggles `.notation-expanded` on the player (CSS hides tracks in Score view; notation.css:17) |
| `../modal-focus.js` `focusModal` | 11, 98 | Dialog focus trap (deleted, §9.6) |
| `../interactions.js` `isPointerControl` | 12, 254 | Refocuses the surface after a pointer-driven `change` (deleted per shell map) |
| `../timeline-navigation.js` `wheelNavigation` | 13, 36, 241 | Lanes wheel zoom/pan. Keep. |

### 8.2 State (31-38)
- Per session (not persisted): `layout` (`ws.notation.layout`), `cursor` (Fraction), `selected` (Set of hit ids), `barRange`, `piece` (default snare, then the most-used piece, 331-333), `stepValue = 8`, `stepDotted`, `stepTuplet`, `voice = 'auto'`, `clipboard`, `noteClipboard`, `showList`, `selectionKind`, `panel` (`''|'kit'|'properties'|'mixer'`), `auditionPads`, `gridValue = 16`, `gridTuplet`, `allLanes`, `page`, `followPlayback = true`, `expression{accent, heavy, ghost, flam, drag, roll, sticking, velocity}`.
- `shortcuts = ws.notation.keys` (JSON `{kitId: letter}`), with `keyFor(kit)` (35, 37).
- `audio` is created lazily (`ensureAudio`, 45).

### 8.3 Internals (KEEP; logic unchanged per §5.2 "internals … unchanged")
| Function | Lines | Notes |
|---|---|---|
| `statusText`, `saveStatus` | 43-44 | The status string map (§8.8). `saveStatus` writes into `.notation-save` and toggles the recovery buttons. The **writer** is frame; the **map** is internal. |
| `changed()` | 46 | Prunes the selection, clamps the cursor and range, `part.commit()` |
| `navigate(q, {seek, extend})` | 57-67 | Moves the cursor, sets `page = pageOf(bar)`, optional seek, **turns follow off** (63), keeps lanes in view |
| `insert(instrument, {preview})` | 68-75 | `canWrite` guard with an error message; plays the hit through `DrumAudio` |
| `revealCursor`, `fitBars` | 77, 101 | Lanes window |
| `setStep(value, dotted, tuplet)` | 78-80 | Snaps the cursor inside its beat |
| `setExpression(prop, value)` | 81 | Applies to the selection or arms the next note; flam/drag exclusivity; heavy implies accent |
| `copy(wholeBars)` | 82-92 | Notes (relative offsets) or bars |
| `moveNotes(delta)` | 93 | Score uses `editor.move`; lanes use `moveLaneNotes` |
| `moveDialog`, `repeat(paste)`, `tupletDialog`, `alignment` | 94, 102-104, 106-107, 108-115 | Bodies are internal; they open through `dialog()` (frame). `alignment` is **deleted** (spec §5.2 "legacy Align bar / Align beat dialogs are deleted"). |
| `exportNative`, `importNative`, `printScore` | 116, 117, 118-122 | Export/print/open part. Print uses a second `createScoreView({print: true, barsPerRow: 4})` and `@media print{body>*{display:none}}` (notation.css:20). The new shell must keep its root a child of `body` for that rule. |
| `keyboardSettings` | 123 | Drum keys remap: unique letters; **`n r a g` reserved** |
| `renderScore` | 153-161 | Page `[page, min(page+16, total)−1]` via `view.setScore(s, {range})`; caret, selection, range |
| `renderLanesView` | 162-169 | `renderLanes` over the bars intersecting `getView()` |
| `render` | 170-179 | Hides body parts when there is no editor; `renderChrome()` + the view; restores focus by `data-*` attribute |
| `scorePointer` | 181-208 | Click places the cursor (snapped) or selects a note (Shift adds/removes). Double-click (< 400 ms, < 8 px) writes the staff-line piece, or opens Properties on a note. Drag draws a marquee. Uses **window** listeners (206). Touch-scroll cancel (185). |
| Lanes pointer | 210-240 | Click → cursor + piece. Double-click adds, or deletes a note. Drag moves in time and across lanes (one transaction). Box select. Shift-click on the bar strip extends the range. |
| Lanes wheel | 241 | `wheelNavigation`: zoom at the cursor / pan; `setFollow(false)` |
| `action(name)` | 266-302 | Command switch (§8.6) |
| `onKey(e)` | 303-326 | Keymap (§8.7) |
| `tick(time)` | 336-340 | Score: when `followPlayback && engine.playing` and the playing bar leaves the page, flip `page`; playhead shown when playing **or paused**. Lanes: re-render when the waveform view changed; draw the `.notation-playhead` div. |
| `part.subscribe` handler | 329 | On `'shared'`, `'reload'` or `'import'`: clear the selection, clamp the cursor, reset the range and page. Update `audio` with the new score. |
| `part.onStatus` → `saveStatus` | 330 | |
| `ResizeObserver` (lanes only), theme listener (lanes only) | 327-328 | |

### 8.4 Frame (REPLACE in the re-frame)
| Frame piece | Lines | Content today |
|---|---|---|
| `btn()` helper | 17 | `<button data-action title>`. Most buttons are glyph-only with a `title`. |
| Skeleton `host.innerHTML` | 125-127 | `header.notation-heading`, `.notation-toolbar`, `.notation-panel.hidden`, `.notation-empty.notation-unshared` ("No notation shared"), `.notation-body > aside.notation-sections + .notation-surface[role=grid, tabindex=0, aria-describedby=notation-help] > .notation-score + .notation-lanes + .notation-pagination + sr-only row/gridcell #notation-active-cell`, `.notation-note-list.hidden`, `footer.notation-footer` |
| **Heading** | 135 | `<strong>Drums</strong>` · `.notation-save[role=status]` · `.notation-views` (Score / Drum lanes, `data-view`, `aria-pressed`) · **panel toggles** Kit / Properties / Listen (`data-action=panel-kit\|panel-properties\|panel-mixer`, `aria-expanded`) · **`<details class=notation-menu><summary>•••`**, which contains: Copy · Paste · Repeat bars… · Move notes… · Tuplet on this beat… · Mark bars reviewed · Bar meter & label… / Bar properties… · Align in tempo map… / Align beat… · Export · Print · Import… · Keyboard shortcuts… · Note list / Hide note list · (lanes only) Show every kit piece / Show kit in use. Read-only hides the write items. |
| **Toolbar** | 136-137 | `.notation-durations` (♩ ♪ 𝅘𝅥𝅯 1/32 1/64, `data-step`; title "Quarter step · 5" … "64th step · 1"; dotted `•` `data-action=dot`, disabled with a tuplet) · `Tuplet <select data-field=tuplet>` (Straight, Triplet, Quintuplet, Sextuplet, Septuplet) · `.notation-layout` Together / Hands / feet (`data-layout`, **writes the part**, 247) · Skip · ↶ · ↷ · `.notation-navigation`: `.notation-range` ("Bar 3" / "Bars 3–6"), ← →, Fit (lanes), Loop, Follow (`aria-pressed`) |
| **Panels** (inspector content) | 138-141 | `kit`: title, "Audition only" checkbox, 4 families of pads (`data-kit`, `aria-pressed`, `<kbd>` letter). `properties`: "N selected" / "Next note", checkboxes Accent / Heavy accent / Ghost / Flam / Drag (`data-expression`), Roll select 0-3, Sticking —/L/R, Velocity range .05-1, Voice Auto / 1 Hands / 2 Feet (`data-field=voice`), Delete. `mixer` (labelled "Listen"): Listen to Recording / Notation / Both (`data-field=listen`), Notation level range (`data-field=level`), Mute recorded drums, Play from cursor. |
| **Sidebar** | 142-143 | Score: `.notation-piece` "Writing **Snare** [S]" + Add note (N) + `<h3>Sections</h3>` (start and labelled bars, `data-bar`). Lanes: lane labels that audition pieces (`data-audition-kit`, height `LANE_HEIGHT`). |
| **Footer** | 144 | `#notation-help` hint · `.notation-message[role=status]` · `.notation-position` "Bar n · Beat b.bb" · lanes Grid select 1/4-1/64 + Triplet · Retry saving · Review saved version |
| Read-only disabling | 145-146 | |
| a11y row text | 147 | `#notation-active-cell` "Bar n, beat b, piece. Selection description." Keep it inside the surface. |
| Note list | 148-149 | Buttons per hit in the visible page (score) or bar range (lanes). Internal content, toggled from the menu. |
| Pagination markup | 160 | `Previous bars` · "Bars 17–32 of 64" · `Next bars` (only when > 16 bars) |
| `dialog()` | 95-100 | `div.modal.notation-dialog[role=dialog]` + `form.modal-card` + `[role=alert]` error + Cancel/submit. Async `onSubmit` keeps the dialog open on throw. `focusModal`. |
| Click delegation | 244-253 | Routes `data-view`, `data-step`, `data-layout`, `data-kit`, `data-audition-kit`, `data-bar`, `data-hit`, `data-action`; ignores clicks inside the score stage; refocuses the surface after a pointer click |
| Change delegation | 254-264 | `data-expression`, `data-field` (`grid`, `grid-triplet`, `audition`, `tuplet`, `voice`, `listen`, `level`) |
| `.player.notation-expanded` toggling | 134, 335, 341 | |

### 8.5 Pagination (16 bars), keep exactly
- `PAGE = 16` (21) and `pageOf(i) = floor(i/16) × 16` (54).
- `renderScore` renders `range: [page, last]` (155-158). The key `${page}:${layout}` avoids a re-engrave.
- `navigate` moves the page with the cursor (61).
- `page-prev`/`page-next` (295-296).
- `tick` flips pages while following (337).
- The note list is limited to the page (149).
- `moveNotes` re-pages (93).
- Part reload, shared update or import re-pages (329).
- Spec §7.2 adds `[`/`]` and PageUp/PageDown = previous/next 16 bars in Edit · Chart. These are new bindings, mapped onto `page-prev`/`page-next`.

### 8.6 Command switch `action(name)` (266-302): the menu and toolbar inventory
- `panel-kit|panel-properties|panel-mixer` (269) toggle the panel.
- `all-lanes`, `add-note`, `dot`, `skip`, `undo`, `redo`, `delete`, `copy`, `paste` (→ `repeat(true)`), `repeat`, `move`, `tuplet`.
- `review` sets coverage `reviewed` for `barRange`.
- `previous` / `next` move one bar. `fit` is lanes only.
- `follow` (286) toggles `followPlayback` and the waveform follow, re-pages to the playing bar and fits lanes.
- `loop` (287): `setLoop(from, to)` for `barRange`, or the engine loop + `onLoopChange`.
- `align` / `align-beat` (288-289).
- `export`, `import` (opens a `.woodshed.json`), `print`.
- `shortcuts` → **`keyboardSettings()`**. Today the "Keyboard shortcuts…" item opens the drum-key remap dialog, not a shortcut sheet.
- `list`, `page-prev`, `page-next`.
- `play-cursor`: seek to the cursor, then `play()` if stopped.
- `mute-drums`: `engine.toggleMute('drums')`, `onMixerChange`, message.
- `retry-save` (299): `part.store.persist().then(flush)`.
- `resolve` (300): dialog "Load saved version" → `exportNative()` then `part.reload()`, reset the cursor, page and selection.
- Read-only guard list (266).

### 8.7 Keys: two listener paths and the current map
**Paths:**
1. `surface.addEventListener('keydown', e => onKey(e))` (**editor.js:242**) fires when the score or lanes surface has focus.
2. `player.js:1080-1083` window `keydown` → `transcription.handleKey(e)` → `launcher.js:103` → `workspace.handleKey = onKey`. Here the launcher returns `true` whenever Transcribe is shown, **swallowing every player key below it** (M, G, digits, ±, `\`, `[ ]`, Home/End, ←/→, `,` `.`) even when `onKey` did not handle the key.
   - The window path runs only for events not stopped by path 1. `onKey` calls `stopPropagation` when it handles a key (325).
   - Player keys that are checked **before** `handleKey` still work: tempo-sources capture, dialog suppression, Esc on the popover, `mapMode.handleKey`, ⇧S grid snap.

**`onKey` guards** (303), in order: no editor, hidden host, `defaultPrevented`, `isComposing`, Tab, `mapActive()`, target inside `input, select, textarea, [contenteditable], button, summary, a[href]` → ignore. Then **⇧S returns unhandled** (otherwise `k = 's'` would write a snare).

| Key | Lines | Action |
|---|---|---|
| Space, Enter | 304 | `preventDefault` + `stopPropagation`; `play({pause: key === 'Enter'})` (not on repeat). **Must change**: Space → registry Play/Stop, ⇧Space → Pause, Enter → **Again** (owner decision). |
| ⌥← / ⌥→ | 305 | `moveNotes(±navigationStep)`. Other Alt combos return unhandled. |
| ⌘/Ctrl Z, ⇧Z, Y, C, V, D, A | 306 | undo, redo, redo, copy, paste, repeat, select the bar's notes. Other mod keys are unhandled (so ⌘K passes). |
| → / ← | 307-308 | Lanes with a selection and no Shift: move notes by the grid. Otherwise step the cursor (Shift extends `barRange`). |
| ↑ / ↓ | 309 | Lanes with a selection: move lane. Otherwise change the piece (lane rows or full KIT order). |
| Home / End | 310-311 | Bar start / last step of the bar |
| Esc | 312 | `cancelGesture`, clear the selection, **close the panel**, all in one press, always handled |
| N | 313 | Write |
| Delete / Backspace | 314 | Delete selected |
| R | 315 | Skip |
| 1-7 | 316 | Step `2^(7−k)` clamped to 4..64: 1 = 1/64, 2 = 1/32, 3 = 1/16, 4 = 1/8, 5 = 1/4, **6 and 7 also give 1/4** |
| + / = and − / _ | 317-318 | Finer / coarser step |
| . | 319 | Toggle dotted (clears the tuplet) |
| / | 320 | Cycle the tuplet 1 → 3 → 5 → 6 → 7 → 1 |
| A / ⇧A | 321 | Toggle accent / heavy |
| G | 322 | Toggle ghost |
| Drum letter (`keyFor`) | 323 | Write that piece (not on repeat) |

Unhandled keys today: `?`, PageUp/PageDown, `[ ]`, Shift+letters other than A, F-keys.

**Default drum letters** (`shared/notation.ts:33-60`): q China, w Splash, c Crash, e Crash 2, j Open HH, l Half HH, h Hi-hat, d Ride, o Ride edge, b Bell, m Cowbell, y Tom 1, t Tom 2, u Tom 3, s Snare, z Rimshot, x X-stick, i Tom 4, f Floor, v Floor 2, k Kick, p HH pedal. The chokes have none.

### 8.8 Save status and recovery
- Strings (`statusText` 43):
  - `loading` "Opening part…";
  - `saved` "Saved";
  - `local` "Saved on this device";
  - `saving` "Saving…";
  - `offline` "Waiting for connection · edits kept here";
  - `conflict` "Another version exists · edits kept here";
  - `storage-error` "Device storage unavailable · export a backup";
  - `read-only` "Read-only shared part";
  - `fixture` "Local development fixture".
- `saveStatus` (44) toggles `[data-action=resolve]` (conflict only) and `[data-action=retry-save]` (offline or storage-error).
- Spec §5.2 wants these labels in the posture bar right side: "Saved / Saving… / Saved on this device / Another version exists [Review]". Retry saving stays for offline/storage-error. Recovery "Load saved version" is kept.

### 8.9 Lifecycle API returned (334-341)
- `handleKey: onKey`, `flush: () => part.flush()`, `notice: message`.
- `setVisible(v)`. **On hide it cancels the gesture and resets `audio.setMode('recording')`.** Leaving Transcribe always returns Listen to Recording, which conflicts with the spec's shared session and the "Recorded drums" ↔ Mix sync.
- `tick(time)`, `destroy()`. `destroy` also destroys `audio`, which calls `engine.setRecordingAudible(true)`.

---

## 9. Supporting modules

- **`audio.js`**
  - `VOICES` / `CHOKES` (8-16).
  - `sample(ctx, id)` (19-38): deterministic synthesis.
  - `scoreEvents(score)` (46-73): rolls are expanded.
  - `class DrumAudio(engine)` (75-109):
    - output gain .65 straight to `ctx.destination`;
    - a 25 ms scheduler using `engine.beatsBetween`;
    - `engine.subscribeTransport` cancels on seek;
    - `setMode('recording'|'notation'|'both')` calls `engine.setRecordingAudible(mode !== 'notation')` (78);
    - `play(hit, when, preview)` handles chokes and flam/drag graces;
    - `destroy()` restores recording audibility.
  - **New requirement from spec §4.7:** the Mix sheet has "Chart playback: Off · Quiet · Loud" in the **Stage**. Today only the editor creates `DrumAudio` (`editor.js:45`). Ownership must move to the notation session, with one instance shared by the Stage Mix and the Edit Listen tab:
    - Off = mode `recording`;
    - Quiet/Loud = mode `both` with gain ≈ .35/.65;
    - Edit Listen's "Notation" (recording silent) stays an Edit-only choice.
  - Practice v2 (§9.3) has no field for it yet. Add `practice.chartAudio: 'off'|'quiet'|'loud'` (or put it under the mix), saved per song like the rest of the mix.
- **`entry.js`**
  - `scoreFromTiming(duration, metronome)` (4-35) builds a draft timeline from practice pulses. It is used only when there is no song map (`part.js:33`). The new session always has a song map, so this becomes dead unless the session can open without one.
  - `snapPosition(score, raw, grid)` (37-41).
  - `moveLaneNotes(editor, ids, delta, laneDelta, lanes)` (45-63): one transaction.
- **`lanes.js`**
  - `LANE_HEIGHT = 28`, `LANE_TOP = 26` (7).
  - `laneRows(score, {piece, all})` (9-13): the core kit, plus pieces in use, plus the current piece.
  - `renderLanes(host, {...})` (15-43) draws an SVG string with literal `var(--border)`, `--grid-minor`, `--drums`, `--accent`, `--bg`, `--bg-2` and `--muted`. **Token names must be remapped** when `tokens.css` lands (§8.3 semantic tokens).
- **`import-drums.js`**
  - `importDrumHits(hits, timing, {title, source, duration, tuplets})` (32-144): onsets → a validated draft score plus `warnings`, `importedCount`, `skippedCount`.
  - Pure. Called from `player.js:925,928` (tempo sources preview/commit). It moves with the Find panel; the module itself is unchanged.
  - The new Part ▾ "Drum part from file (Guitar Pro, MIDI, Clone Hero)…" needs the same parse → `importDrumHits` → `part.importScore` chain (`player.js:917-934` + `tempo-import.js`). Factor it into a function callable from both Edit · Map and Edit · Chart.
- **`html.js`**: `xml()` escaper (1). It is used by chart, editor and lanes, and is superseded by `h()` text nodes where markup moves to primitives.

---

## 10. Tests and how the re-frame affects them

| Test file | Pins | Impact |
|---|---|---|
| `notation-chart.test.js` (mocks score-view; drives through `attachNotation`) | Launcher routing (49, 57, 67, 81, 187, 213), tap seek (88), mouse drag loop (96), **long-press then tap pending loop (108)**, scroll-before-long-press (119), section chips (129), Loop section toggle and clamp (137, 195), Mute drums (147, 157, 207), follow pause and resume (163), import notice (173), drag released outside (220) | **Rewrite against `createChart` directly** (the launcher goes). Delete 108, 129, 137, 147, 157, 195, 207, 213, 57, 187. Move section-list numbering (129) to the shared helper test. Move Loop section (137, 195) to transport tests. Rewrite tap (88) and drag (96, 220) as `onBarActivate` / loop-edit emission tests, with pointerType and glass cases. New tests: `setScale` anchor preservation, `setFollowStyle('page')` advancing, `setLoopRange` drawing without polling `engine.loop`, `setGlass` suppressing touch seeks, 350 ms long-press → `{kind: 'long'}`. |
| `notation-editor.test.js` (mocks score-view; `createNotationWorkspace` directly) | Keys via `[role=grid]` keydown (`key()` helper, 34), `[data-action=…]` clicks (35), kit pads (86), layout switch (114), lane gestures (121, 130), `workspace.handleKey` routing (136-140) | Keep green through the re-frame (spec R9). If toolbar and inspector markup move to frame slots, provide a test frame (`slots` with plain divs), or keep `data-action`/`data-kit` hooks in the slot markup. Test 136 asserts `handleKey` claims drum keys from `document.body`. Under scoped keys that becomes **"not claimed unless the surface is focused"**, so it is an intended behaviour change: update the assertion. ⇧S unhandled stays. |
| `notation-songmap.test.js` | 70: "bar properties and align beat open the tempo map instead of a seconds dialog". 80: keys yield to the map while it is active. | 70 stays (it becomes "switches to Edit · Map at that bar"). 80 is obsolete once Map and Chart are separate postures. |
| `notation-store.test.js`, `-model`, `-engrave`, `-render`, `-regressions`, `-alphatab`, `-audio`, `-entry`, `drum-import`, `convex/notation.test.ts` | Model, engraving, store, server | Untouched, and must stay green |
| Fixture `tests/fixture/db.js:10,75,236-245` | `fx-practice=chart\|tracks`, `fx-notation=score\|lanes`, `notation:get/save` stubs | Update `fx-practice` to seed `practice.surface`. Keep `fx-notation`. Playwright baselines of Transcribe score/lanes must be taken **before** the frame change (spec R9). |

---

## 11. Proposed chart API for spec §4.4A (minimal changes)

**Decision: make chrome-less the only mode.** The toolbar, chips, notice, hint and mute button are deleted outright. `chrome:false` exists in the spec only for a strangler period, and the owner removed that. `createChart` accepts and ignores `chrome`, or the option is dropped. The file keeps its name and its tests (rewritten).

```js
createChart({
  host, part, engine,
  scale = 1.2,                    // alphaTab display.scale; caller passes the Distance default (§4.11)
  display = {layout: null, barsPerRow: -1},   // layout null = the part's own; barsPerRow -1 = auto by width
  followStyle = 'scroll',         // 'scroll' | 'page'
  followAnchor = 0.33,            // scroll: playing system top at this fraction (0.28 band, 0.33 rail)
  glass = false,                  // see setGlass
  onBarActivate = () => {},       // (event) => void, below
  onLoopEdit = () => {},          // ({a, b, aBar, bBar, phase: 'preview'|'commit'}) => void
  onFollowChange = () => {},      // (following: boolean) => void: the surface shows/hides "⤓ Back to playhead"
  onStatus = () => {},            // (text) => void: Stage status line (replaces say())
  onEmpty = {},                   // {findChart, importFile, write}; read-only parts get the shared copy
}) → {
  host,
  setVisible(bool), tick(time?), refresh(), destroy(),   // kept (tick may take the frame time; falls back to engine.getPosition())
  setScale(value, {anchor = true} = {}),  // relayout once; keep the anchor bar at its screen fraction
  previewScale(factor | null),            // pinch: CSS transform on .chart-score only, no relayout
  setDisplay({layout, barsPerRow}),       // one re-engrave for both; anchor kept
  setFollowStyle(style, {anchor} = {}),
  setFollow(bool),                        // the surface resumes after 8 s idle / Play / Again / F
  setLoopRange(range | null),             // {a, b} seconds (the surface converts bar-anchored loops); draws band + brackets + handles
  setGlass(bool),
  reveal(time, {smooth = false} = {}),    // resume: put the cue / loop start at the follow line (§4.12 step 4)
  anchorBar(),                            // index of the bar at the follow line, saved as practice.anchorBar
  barAtPoint(clientX, clientY),           // for the surface's own long-press / pill placement
}
```

### 11.1 Behaviour of each new member
- **`setScale(value)`**
  - Clamp to 0.8–2.0. Replace `SCALES` with the `=`/`−` steps `[.8, .9, 1, 1.1, 1.2, 1.3, 1.45, 1.6, 1.8, 2.0]`, which include every Distance default.
  - Record `{index: anchorBar(), fraction: (bounds.y − scrollTop) / clientHeight}`, call `view.setScale(value)`, and in the next `onRender` restore `scrollTop = bounds.y − fraction × clientHeight` instead of today's `sync(true)` jump to 22 %.
  - **No localStorage.** Distance and pinch values live in `prefs` (per device). Upgrade from stored data: `ws.chart.scale` seeds the pinch override once if present, then the key is dropped.
  - Font floor (§4.4A: bar numbers ≥ 14 px × distance; section labels ≥ 20 px × distance). alphaTab element fonts are multiplied by `display.scale`. Today's BarNumber 11 px × 1.2 (iPad Stand) = 13.2 px, and EffectMarker 15 × 1.2 = 18 px; **both fail**. Give `createScoreView` a `fonts` option (or `setFonts`) and pass `barNumber = ceil(14 × d / scale)` and `marker = ceil(20 × d / scale)`, where `d` is the Distance factor, before each relayout. Verify on a Playwright computed-size probe.
- **`previewScale(f)`**
  - Live pinch: `transform: scale(f)` with `transform-origin` at the pinch centre.
  - On release the surface calls `setScale(scale × f)` then `previewScale(null)`.
  - The pinch recogniser lives in `chart-surface.js`. The chart only needs this hook because `.chart-score` is internal.
- **`setDisplay({layout, barsPerRow})`**
  - `layout` replaces `layoutOverride` (no `ws.chart.layout` write). One-way upgrade: a stored `ws.chart.layout` seeds `prefs.chart.display` once.
  - `barsPerRow` maps to `view.setBarsPerRow`. The spec's 2 bars per system for dense parts on iPad portrait and 4 on laptop: the surface decides "dense" (for example, > 8 hits per bar on average), and the chart applies it.
  - Batch both into a single `updateSettings` + `setScore`, so it relayouts once.
- **`setFollowStyle('scroll'|'page', {anchor})`** replaces the fixed 22 % in `scrollToBar` (96).
  - **Scroll:** target = `bounds.y − clientHeight × anchor`, smooth. Same system-change trigger as today (114).
  - **Page:** when the playing system's bottom crosses `scrollTop + clientHeight / 2`, scroll by `+clientHeight / 2` over 200 ms (`behavior: 'auto'` under `prefers-reduced-motion`). On a backwards jump (loop wrap, seek), page-align so the playing system sits in the top half.
  - Manual scroll handling (`stopFollowing`, 103-105) becomes: any user wheel, touchmove or scrollbar drag, **playing or stopped**, sets follow off and calls `onFollowChange(false)`. Keep the 900 ms programmatic-scroll guard.
- **`onBarActivate(event)`**, with event = `{kind: 'tap'|'double'|'long'|'context', index, q, time, beatTime, pointerType: 'mouse'|'touch'|'pen', glass, clientX, clientY}`.
  - `beatTime` keeps today's snapping rule (173): the nearest written beat within 1 quarter, else the bar start.
  - **The chart no longer seeks.** It only emits. The surface applies §4.9:
    - stopped: tap → cue to `beatTime`;
    - playing, touch: pill "▶ Play from bar {index+1}";
    - playing, mouse: seek;
    - double: play from there;
    - long or context: open the bar menu at `clientX/Y`.
  - Double detection: a second tap within 300 ms and 8 px. Mouse `dblclick` emits `double`.
  - `context` comes from a `contextmenu` listener on `.score-stage` (today it is only `preventDefault`ed for touch, 177). Shift+F10 and the ContextMenu key are handled by the surface using the playing bar.
  - Long-press is **350 ms** with `navigator.vibrate?.(10)`. Release without a drag emits `long`. The `pendingLoop` state (27, 155-162) is deleted.
- **Loop creation and editing (`onLoopEdit`, `setLoopRange`)**
  - Mouse drag across bars (8 px threshold, any time): emit `{phase: 'preview'}` while dragging, `{phase: 'commit', a: barTime(a), b: barEndTime(b), aBar: measures[a].id, bBar: measures[b].id}` on release.
    - Alt-drag snaps to beats (use `at.beatQ`).
    - **No implicit `engine.seek`.** Today's drag end seeks (167). Under the cue model, the loop start *is* the cue, so the transport decides.
  - Touch, stopped: long-press then drag does the same.
  - Touch while playing, or `glass === true`: never creates a loop.
  - `setLoopRange({a, b} | null)` replaces polling `engine.loop` in `sync` (124-125). The surface pushes the transport's loop on change.
  - Handles need new score-view overlay elements: brackets at both ends, a 3 px `--loop` edge, a 20 px grip dot and a **44 px × row-height hit area** (§4.8). They go in a *separate* SVG layer with `pointer-events: auto`, since the current overlay is `pointer-events: none` (score-view.css:6).
    - Drag an edge → resize (bar-snapped, Alt = beat).
    - Drag inside → move.
    - Both emit `onLoopEdit`.
    - Handles show at 50 % opacity while playing and stay mouse-draggable.
- **`setGlass(on)`**: the surface sets it to `engine.playing`. When on:
  - touch/pen taps emit `{kind: 'tap', glass: true}`, never a cue;
  - touch drags only scroll;
  - long-press still emits `long`.
  - Mouse is unaffected.
- **`reveal(time)` / `anchorBar()`** serve resume (§4.12 step 4) and `practice.anchorBar`. `reveal` reuses `scrollToBar` with the current follow style's anchor.

### 11.2 Deleted from chart.js
Lines 10-16 (store, SCALES, defaultScale), 25-26 (prefs reads), 29-38 (toolbar markup), 41-42 (notice, hint), 49 (drumTrack), 50 (say), 63-72 (`paintTools`), 115-119 (chip sync), 121-123 (mute repaint), 124-125 (loop polling), 155-162 (pending loop), 182-213 (toolbar click handler; `import`/`transcribe` move to the empty-state buttons only), and 216-217 (theme listener; see R3). `sectionList` and `currentSection` (52-61) move to the shared sections helper. `chart.css` keeps only `.chart`, `.chart-scroll`, `.chart-score`, `.score-stage` touch rules and `.chart-empty`; the rest goes, along with the `.player.chart-active` rules (32-34).

### 11.3 score-view.js additions (small, renderer-level)
1. `themeResources` and the font family (12, 63) read from `getComputedStyle(host)` instead of `document.documentElement`, so the always-dark Stage scope wins over a light app theme. The token names move to the §8.3 set (`--ink`, `--ink-3`, a staff-line token).
2. A `fonts` option / `setFonts({barNumber, marker})` (65-69).
3. The loop band gets brackets, plus a handle layer (above).
4. `.score-now-bar` → `--now-soft`, `.score-playhead` → `--now` at 3 px.
5. Wait for `document.fonts.ready` before the first `renderScore`. alphaTab measures with the web font; Atkinson Hyperlegible Next arriving late gives wrong label widths.
6. Optional: expose `systemBounds(index)` for page-follow maths (`barBounds` already returns `system.y/h`).

---

## 12. Proposed Edit · Chart re-frame for spec §5.2 (minimal changes)

**Principle:** keep §8.3 internals byte-for-byte where possible. Move every §8.4 frame piece out, behind a small interface. The internals already render through `renderChrome()` (131-150) into fixed selectors, so the least-churn cut is **slots**. The frame owns the elements; the editor renders internal content into them, and returns menu descriptors and state for the frame to draw with primitives.

### 12.1 Factory
```js
createNotationWorkspace({
  host,                       // main area: surface (score/lanes), pagination, note list (editor-owned DOM)
  slots = {},                 // {inspector: {kit, properties, listen}, kitBank, status} → elements the frame owns; any may be omitted
  part, song, engine, songMap,               // songMap is now required (legacy align dialogs deleted)
  transport,                  // {playStop(), pause(), again(), playFrom(t), setLoop({a,b,aBar,bBar}), isPlaying()}: replaces play/setLoop/onLoopChange
  mix,                        // {toggleRecordedDrums(), recordedDrumsOut(), chartAudio}: replaces onMixerChange; shares the session DrumAudio
  viewport,                   // {get(), set(start, end)}: Edit·Chart's own seconds window for lanes; replaces getView/setView/setFollow
  openMap,                    // (q, {edit}) → navigate to /s/:id/edit/map at that bar
  openDrumImport,             // () → Part ▾ "Drum part from file…"
  confirmDialog,              // the Dialog primitive (form body, async submit, inline error); replaces dialog()/focusModal
}) → {
  handleKey(e) → boolean,     // scoped: handles only while the surface is focused; never Space/Enter/Esc-when-idle
  run(id, ...args),           // every action() name plus setters below
  state(),                    // snapshot for the frame (below)
  subscribe(fn) → unsubscribe,// called after each render()
  menus() → {edit: Item[], part: Item[], sections: Item[]},   // Item = {id, label, shortcut?, enabled, checked?}
  focus(),                    // frame calls after menu/toolbar use (today's focus(), 41)
  setVisible, tick, flush, notice, destroy,     // kept
}
```

`state()` returns:
- `layout` (`'score'|'lanes'`), `step: {value, dotted, tuplet}`, `piece: {id, name, key}`, `selectedCount`;
- `range: {first, last, page, pages, total}` for "Bars 17–32 ‹ ›", `barLabel` ("Bar 3" / "Bars 3–6"), `position` ("Bar n · Beat b");
- `canUndo` / `canRedo` (from `editor.undoStack.length` / `redoStack.length`);
- `status` (raw state) plus `statusText` (§8.8 map), `recovery: 'resolve'|'retry'|null`;
- `listen: {mode, level}`, `audition`, `allLanes`, `showList`, `follow`, `grid: {value, triplet}`;
- `partLayout` (`score.layout || 'combined'`), `expression` (or the first selected hit), `voice`.

New setters exposed through `run` are thin wrappers over existing internals: `setLayoutView(v)` (245), `setStep(...)` (78), `setPiece(id)`, `setExpression(p, v)` (81), `setVoice(v)` (261), `setListen(mode)` (262), `setLevel(x)` (263), `setAudition(b)` (259), `setGrid(v, triplet)` (257-258), `setPartLayout(l)` (247), `goToPage(p)` / `page-prev` / `page-next` (295-296), `goToBar(i)` (250).

### 12.2 Toolbar (44 px; 52 coarse), rendered by the frame from `state()` with `run()`
| Spec item | Internal it drives | Today |
|---|---|---|
| View `Score · Lanes` (Segmented) | `setLayoutView` | heading 135; `ws.notation.layout` read stays (31), write stays (245) |
| Steps `♩ 1/4 · ♪ 1/8 · 1/16 · 1/32 · 1/64` with key-caps 5·4·3·2·1, `• Dotted`, `Tuplet ▾`, `Skip (R)` | `setStep`, `dot`, `skip` | toolbar 136. **Key-hint correction:** today's digits are 1 = 1/64 … 5 = 1/4, and 6 and 7 also give 1/4 (316). The spec's "key hints 1–7" must show 5…1, or digits should be remapped 1 = 1/4 … 5 = 1/64; this is an internal keymap change, so flag it. |
| "Writing: **Snare** (S)" | `piece` | sidebar 143 |
| `↶ Undo` `↷ Redo` (text ≥ 1200 px) | `undo` / `redo` | toolbar 136 (glyph-only) |
| `Bars 17–32 ‹ ›` + section jump menu | `page-prev`/`page-next`, `goToBar` from `menus().sections` | pagination 160; sidebar sections 142 |
| `Edit ▾`, `Part ▾` | `menus()` | `•••` 135 |
| Not in the spec but must keep a visible home: **Lanes Grid** 1/4–1/64 + Triplet, **Fit** (lanes), **Follow**, **Loop selection**, **Add note (N)**, **← → bar** | `setGrid`, `fit`, `follow`, `loop`, `add-note`, `previous`/`next` | footer 144, toolbar 137 |

Proposal for the items the spec omits:
- Grid ▾ and Fit appear in the toolbar in Lanes view only.
- Follow becomes automatic: `followPlayback = true` on Play/Again (today it stays off after any click until the toggle; 63, 286). Pressing the follow pill re-enables it.
- "Loop selection L" goes in Edit ▾.
- "Add note" becomes the pad bank and the N key.
- ← → bar is covered by keys and the pad bank's arrow pads (§12.6).

### 12.3 Menus (Menu primitive; each item shows its shortcut)
- **Edit ▾**:
  - Copy ⌘C (`copy`);
  - Paste ⌘V (`paste`);
  - Repeat bars… ⌘D (`repeat`);
  - Move notes… ⌥←/→ (`move`);
  - Tuplet on this beat… (`tuplet`);
  - Mark bars reviewed (`review`);
  - Loop selection L (`loop`; added);
  - Bar meter & label… → `openMap(a.startPosition, {edit: true})` (288);
  - Align in tempo map… → `openMap(cursor)` (289).
  - The last two **switch to Edit · Map at that bar** (spec), so `openMap` becomes a route change.
- **Part ▾**:
  - Export `.woodshed.json` (`export`);
  - Print (`print`);
  - **Open .woodshed.json part…** (`import`, renamed);
  - **Drum part from file (Guitar Pro, MIDI, Clone Hero)…** → `openDrumImport` (new wiring to the shared importer, §9);
  - **Drum keys…** (`shortcuts` → `keyboardSettings`, renamed);
  - **Note list** ✓ (`list`);
  - **Show every kit piece** ✓ (`all-lanes`; enabled in Lanes only);
  - **Keyboard shortcuts** → the registry `?` sheet scoped to `edit.chart` (new; today this label opens Drum keys).
- **Deleted:** `alignment()` (108-115), the `align-beat` dialog branch (289), the `•••` `<details>` (135), and the "Bar properties… / Align beat…" non-songMap labels.

### 12.4 Inspector tabs `Kit · Properties · Listen` (right 320 px; iPad portrait: sheets)
- Render today's panel bodies (139-141) into `slots.inspector.{kit, properties, listen}`. Replace `panel` toggling (`panel-*`, 269) with `setInspectorTab`. One tab is always selected on laptop. `panel` stays the internal name, and Esc no longer "closes" it on laptop.
- **Kit:** the pads plus "Audition only" (139). Each pad shows its key letter (`keyFor`). Key-caps show only on `(hover:hover) and (pointer:fine)` after keyboard use (§5.0).
- **Properties:** 140 unchanged, plus the **Part layout footer** "Together · Hands & feet — saved with the part" (moved from toolbar 136; `setPartLayout`). Delete stays.
- **Listen:** Recording / Notation / Both, Notation level, Play from cursor (141). "Mute recorded drums" becomes **"Recorded drums: In/Out"**, bound to `mix` so it is the same state as the Stage Mix. **Remove the `setMode('recording')` reset on hide** (335): Listen and Mix state persist across postures.
- Double-clicking a note opens Properties (197). That becomes `setInspectorTab('properties')`, or opens the sheet on iPad.

### 12.5 Scoped keys (registry integration)
Target (§5.2, §7.1, §7.2): drum letters, 1–7, `+ −`, `.`, `/`, A, ⇧A, G, R, N, ⌘C/⌘V/⌘D/⌘A, ⌫, arrows, Home/End and ⌥←/→ apply **only while the score or lanes have focus** (scope `edit.chart.score`). Space, ⇧Space, Enter, Esc, PageUp/PageDown, ⌘K, `?` and E pass through.

Minimal implementation:
1. Delete the surface listener (242). The capture-phase dispatcher calls `workspace.handleKey(e)` for scope `edit.chart.score` when `surface.contains(document.activeElement)`.
2. In `onKey`:
   - remove the Space/Enter clause (304), leaving those to the registry;
   - drop `mapActive` (303);
   - Esc returns *handled* only if there is a gesture or selection to clear; otherwise the posture handles "close panel → Done";
   - add `[`/`]` and PageUp/PageDown → `page-prev`/`page-next` at posture scope;
   - keep the ⇧S early return.
3. Register static registry entries mirroring §8.7 (titles and groups for the `?` sheet and `aria-keyshortcuts`), with `run: c => c.chart.run(id)`. The **drum letters are dynamic**: register one command per KIT piece with `keys: [keyFor(kit)]`, and re-register on Drum keys save (123). This satisfies the CI rule that `?` is generated from the registry.
4. Remove `launcher.handleKey`'s swallow (103). Player keys disappear anyway with `player.js` decomposition.

**Collisions to resolve (spec inconsistency, needs an architect decision):** surface scope sits above posture scope, so while the surface is focused, these default drum letters shadow posture/global commands that §7.2 lists for Edit · Chart:

| Key | Drum default | Spec Edit · Chart meaning |
|---|---|---|
| **E** | Crash 2 | §5.2 says E "passes through". The table shows "—", Stage uses it for Edit. |
| **C** | Crash | Count-in ("same") |
| **K** | Kick | Click ("same") |
| **L** | Half-open hi-hat | Loop selection |
| **M** | Cowbell | Not bound in Edit · Chart (OK) |

Recommendation:
- Drum letters win inside the surface. The `?` sheet shows the shadowing.
- C, K and L work with focus outside the surface or via the toolbar and slim transport.
- Delete "E passes through" from §5.2.
- Do **not** silently change defaults, because `ws.notation.keys` remaps must keep working.
- Extend the Drum keys validation reserved set (`'nrag'`, 123) to derive from the registry's `edit.chart.score` bindings, so a remap can't steal `/`, `.` or digits.

### 12.6 iPad portrait layout and the kit pad bank
- Order: score (or lanes) on top, then the toolbar, then a **kit pad bank** docked at the bottom: 4 × 7 pads of 56 px, grouped by colour (`family`). Inspector tabs open as sheets.
- KIT has 27 pieces, so 28 slots leave one free. Suggested rows:
  1. crash, crash2, ride, rideBell, rideEdge, china, splash;
  2. closedHat, halfHat, openHat, crashChoke, crash2Choke, rideChoke, chinaChoke;
  3. snare, rimshot, crossStick, tom1, rackTom, tom3, tom4;
  4. floorTom, floorTom2, kick, pedalHat, cowbell, splashChoke, and the free slot.
- Use the free slot (or a 5th thin row) for **Skip ▸** (`skip`). Writing doesn't advance the cursor (`insert`, 68-75), so touch entry needs Skip and ◂ ▸ within thumb reach. ◂ ▸ map to `navigate(±step)`.
- Pad tap = `insert(kit.id, {preview: auditionPads})` (248), identical to the Kit tab. Render it into `slots.kitBank` from the same template as the Kit tab (139), with a `bank` variant class. Long-press a pad → audition.
- Score touch: `scorePointer` uses window listeners and double-click timing (183-207), which works with touch. Today's `.notation-surface` CSS has no coarse `touch-action` rule. Add `touch-action: pan-y` on the score stage so a vertical scroll isn't a cursor drag.

### 12.7 Heading, status, recovery and pagination
- The heading `<strong>Drums</strong>` becomes the posture-bar label "Editing drum chart".
- The save status moves to the posture bar right side. It subscribes to `part.onStatus` (already called immediately with the current state) and uses `state().statusText`.
  - The conflict state shows `[Review]` → `run('resolve')` (300; still exports local edits first).
  - Offline/storage-error show `[Retry]` → `run('retry-save')` (299).
- Pagination: keep `PAGE = 16` and every re-page site (§8.5). The frame renders "Bars 17–32 ‹ ›" from `state().range` and removes the in-surface `.notation-pagination` markup (160). Alternatively keep it as the only pager on iPad.
- Footer: `#notation-help` and `#notation-active-cell` stay inside the surface for `aria-describedby`/`aria-activedescendant` (126, 129). `.notation-message` becomes the Edit InlineStatus (`notice()`). `.notation-position` goes to the slim transport.

### 12.8 Deleted with the re-frame
- `btn()` uses in the frame, the skeleton heading/toolbar/panel/footer (125-127, 135-138, 142-144), read-only branches (71, 125 `.notation-unshared`, 145-146, 266), and `.player.notation-expanded` toggles (134, 335, 341).
- `dialog()` + `focusModal` (95-100) go to the Dialog primitive. The callers keep their bodies: move, repeat/paste, tuplet, replace part, drum keys, load saved version.
- `isPointerControl` (254): replace it with "refocus the surface unless the change target is a text field".
- `alignment()` + the align-beat dialog. `entry.scoreFromTiming` if no-map sessions are impossible.
- `notation.css` rules for `.notation-heading`, `.notation-toolbar`, `.notation-panel`, `.notation-sections`, `.notation-footer`, `.notation-active`, `.notation-expanded` and `.is-expanded`. Keep surface, score, lanes, note list and print rules.

---

## 13. Stored preferences: one-way upgrade (no UI ceremony)
| Key | Writer and reader | Upgrade |
|---|---|---|
| `ws.practice.view` (`'chart'\|'tracks'`) | launcher.js:7-9 | → default `practice.surface` (`'tracks'` → `'stems'`) for songs without one. Delete the key. |
| `ws.chart.scale` (JSON number) | chart.js:25,195 | → `prefs.chart.pinchScale` (seeds once). Distance otherwise. Delete. |
| `ws.chart.layout` (JSON `'combined'\|'split'\|null`) | chart.js:26,190 | → `prefs.chart.display.layout`. Delete. |
| `ws.notation.layout` (`'score'\|'lanes'`) | editor.js:31,245 | → `prefs.edit.chart.view` (or keep the raw key; it is per device) |
| `ws.notation.keys` (JSON `{kitId: letter}`) | editor.js:35,123 | → `prefs.edit.chart.keys`. **Must survive** (user remaps), and feeds the dynamic registry entries. |
| IndexedDB `woodshed-notation/drafts` | store.js:5 | Unchanged. Pending journals replay, including the version-1 upgrade at store.js:26. |
| Server version-1 parts | shared/notation.ts:134-169 | Unchanged upgrade-on-read |

---

## 14. Risks and open questions

- **R1. Theme scope (high).** `score-view.js:12-21,63` read colours and the font from `document.documentElement`. With "Stage always dark" implemented as a scoped token set (`.stage[data-theme=dark]`), the chart would engrave **light-theme ink on a dark Stage** unless the reads move to `getComputedStyle(host)`. Also, `woodshed:theme` triggers two re-engraves (chart.js:216, score-view.js:197). The Stage chart should ignore app-theme changes. Edit · Chart follows the app theme (§5.0), so the same part renders with different tokens in each posture: either keep two views, or re-engrave on the posture switch (cost: R2).
- **R2. Relayout cost and width stability (high, spec R1).**
  - `setScale` and `setBarsPerRow` call `api.render()`: a full relayout.
  - alphaTab also relayouts on container **width** changes. `.chart-scroll` is `overflow:auto` with classic scrollbars (Electron on Windows). A scrollbar appearing when Focus changes the height **changes the width** and relayouts, breaking "music width never changes by itself". Add `scrollbar-gutter: stable` (or overlay scrollbars) to `.chart-scroll`.
  - Measure 64-bar relayout on an iPad Air before live Distance switching.
- **R3. Font floors.** The current alphaTab fonts (BarNumber 11 px, marker 15 px) miss §4.4A's 14 px and 20 px floors at iPad scale 1.2. Scale-compensated font sizes are needed (§11.3), and the web font must be loaded before the first engrave.
- **R4. Shared session ownership.**
  - The part (`part.js`), `DrumAudio` and the notation guard must be session-scoped, not surface-scoped, so Stage ↔ Edit doesn't reload, lose undo history or reset Listen.
  - Today `editor.setVisible(false)` resets the audio mode (editor.js:335), and `DrumAudio.destroy` forces recording audible (audio.js:108). Both break the "Recorded drums ↔ Mix" sync.
  - The Mix "Chart playback Off/Quiet/Loud" needs a new practice field.
- **R5. `hasRealMap` and `hasNotation` subtlety.** `part.editor` exists even with no saved part (part.js:43). The legacy rule "a notation part exists" must use the load result or `hasNotation`. The Library can't evaluate it without B1 (`songs.list` has no notation info), and B1's `hasChart` needs a denormalised field on `notation.save`.
- **R6. Key collisions.** Drum letters E/C/K/L shadow Edit · Chart posture commands (§12.5). §5.2's "E passes through" contradicts the default Crash 2 key. Digit hints in §5.2 ("1–7") don't match today's mapping (1 = 1/64 … 5 = 1/4; 6 and 7 are redundant). The resolution must keep `ws.notation.keys` remaps working.
- **R7. Behaviour changes hidden in "internals unchanged."**
  - Enter is today Pause in the editor (304); the owner decision is Enter = Again.
  - Esc today clears the selection and closes the panel in one press (312).
  - Follow stays off after any edit until toggled (63, 286).
  - Every one of these touches `onKey`/`action`, so the "internals byte-for-byte" promise holds only for the model and rendering, not the keymap. Update `notation-editor.test.js:136` deliberately.
- **R8. Loop drag seeks.** chart.js:167 seeks on every loop drag, even while playing. Under the cue model the transport decides, so the chart must stop seeking. Make sure the Stage transport sets the cue to the loop start when stopped, and doesn't jump while playing (spec §4.8: drag allowed while playing).
- **R9. Duplicate notation fetch and guard.** player.js:878-901 adoption is a required ordering step (map adoption → part open), not dead code. Fold it into the session boot and keep the legacy-map `fromTimeline` adoption.
- **R10. Lanes lose their waveform.** Lanes are time-aligned with the player's waveform window (getView/setView, `.notation-active` keeps the tracks visible). The spec's Edit · Chart doesn't mention stem rows. Decide whether Lanes shows the drums stem row from `wave-render.js` above the lanes. The lanes view itself only needs a `viewport` object.
- **R11. Print depends on `body > *`.** `@media print` (notation.css:20) hides every body child except `.notation-print`. A shell that mounts dialogs or portals elsewhere is fine, but the print node must stay a direct `body` child.
- **R12. Test churn.** `notation-chart.test.js` is mostly launcher and toolbar tests, so most of it is rewritten. The model, store, engrave and render suites must stay green, and score/lanes Playwright baselines must be captured **before** the editor frame changes (spec R9).
