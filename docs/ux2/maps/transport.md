# Map: playback and practice subsystem (transport)

Scope: `src/js/player.js` (all 1108 lines), `engine.js` (366), `metronome.js` (182), `player-layout.js` (44),
`waveform.js` (59), `stemcache.js` (138), `decoded-stem-cache.js` (43), `musical-position.js` (21),
`interactions.js` (38), `onsets.js` (40), `timeline-navigation.js` (24, pulled in because player.js depends on it),
and the tests `tests/playback-engine.test.js` (272), `tests/player-ui.test.js` (194), `tests/timeline-navigation.test.js` (26).
The baseline is commit `7deaaf4`. All line numbers refer to that tree.

Spec targets: `docs/ux2/spec.md` §4 (Stage), §7.1–7.2 (registry, keys), §9.2 (architecture), §9.3 (practice v2) and §9.5 (engine additions).
Owner decisions apply: there is **no Classic keys mode, no key-change hint, no What's-changed sheet, no "new" badges, no `ws.flags` rollout gating, and no long-lived legacy layer**.
Stored data is still read: `songs.practice` v1, `ws.*` prefs and legacy tempo maps get a one-way upgrade.

---

## 1. Module dependency graph

```
app.js:12,28,44 ──openPlayer/closePlayer──┐
shared-song.js:4,26,34,51,53,77 ──────────┤
                                          ▼
                                    player.js ── imports ──► share-dialog, notation/launcher (attachNotation), preferences (returnOnStop),
                                          │                  song-metadata (editSongs, artistLabel), artwork (setArtwork), player-layout,
                                          │                  engine, metronome, map-mode, tempo-sources (+css), tempo-import, notation/import-drums,
                                          │                  shared/song-map.ts (fromTimeline), shared/notation.ts (validateBar),
                                          │                  timeline-navigation, shared/content.ts (sameContent), interactions (isPointerControl),
                                          │                  waveform, backend, stemcache (codecErrorMessage, isDecodeError)
                                          ▼
engine.js ── signalsmith-stretch (+?url), stemcache.fetchStem, decoded-stem-cache.decodedStemCache
metronome.js ── song-map.js (SongMapStore), shared/song-map.ts (defaultSongMap)
stemcache.js ── media-fetch.fetchMedia, decoded-stem-cache
map-mode.js ── onsets.js (detectOnsets, nearestOnset)          (map-mode.js:7)
notation/editor.js ── interactions.isPointerControl, timeline-navigation.wheelNavigation   (editor.js:12-13)
settings.js:8 ── stemcache.clearStemCache, stemCacheSize
app.js:3,14 ── interactions.initializeInteractions, stemcache.likelySupportsOpus
musical-position.js ── (no src importer; only tests/playback-engine.test.js:7)
```

---

## 2. Exported API by file

### 2.1 `src/js/player.js`
| Export | Signature | Lines |
|---|---|---|
| `closePlayer` | `closePlayer(): void` | 206-219 |
| `openPlayer` | `async openPlayer(song, {readOnly=false, resolveUrls=null, cacheNamespace=''} = {}): Promise<void>` | 221-1108 |

- **Module state** (199-204): `engine`, `playerGeneration`, `metronome`, `rafId`, `keyHandler`, `cleanupFns`.
  - One player per page. A generation counter guards async continuations: `isCurrent()` (243) is checked after every await (284, 315, 884 and others).
- **`song` input fields read:** `id, title, stems[{name,key}], duration, practice, tempo, coverKey, coverUrl` and, through `artistLabel`, `artist`/`album`.
  - `song.practice` is **mutated** on save (1017, 1028).
- **`closePlayer`:**
  - bumps the generation, clears `#header-song`, cancels rAF;
  - runs `cleanupFns` (these flush practice and tempo and destroy map mode, tempo sources and transcription);
  - destroys metronome and engine, removes the window keydown listener.
  - It then runs `cleanupFns` a second time (217-218). That pass is a harmless no-op because the array was already reset.
- **`openPlayer` options:**
  - `readOnly`: shared view. No header edit/share, no saves, no `onSong`; detection, Map and sources are disabled.
  - `resolveUrls`: replaces `backend.signKeys` (shared playback; `shared-song.js:51`).
  - `cacheNamespace`: prefixed to stem keys for the Cache API and the decoded cache (288).

Private helpers: `cssVar` (37), `colorFor` (38), `prettyStem` (39), `fmt` m:ss (40-45), `fmt2` m:ss.cc (46-53), `clamp` (54), `escapeHtml` (55-57), `loadGridSettings` (58-64), `createTrackRow(t)` (66-80), `playerMarkup(song, {duration, rate})` (82-197).
Constants: `GRID_STORAGE_KEY='ws.grid'` (23), `GRID_DIVISIONS` 1/2/4 (24-28), `STEM_COLOR_VAR` (30-34), `MIN_SPAN=0.25` s (35).

### 2.2 `src/js/engine.js`: `export class MultitrackEngine` (10-366)
**Constructor (11-38)** creates `ctx = new AudioContext()` and `master` gain → `ctx.destination`.

| Field | Initial value |
|---|---|
| `recordingAudible` | true |
| `tracks` | [] |
| `stretch`, `pitchGate`, `splitter` | null |
| `duration` | 0 |
| `playing` | false |
| `rate` | 1 |
| `preservePitch` | true |
| `segments` | [] |
| `lookahead` | 0.05 |
| `destroyed` | false |
| `playRequest`, `revision` | 0 |
| `transportListeners` | Set |
| `pausedAt`, `editPosition` | 0 |
| `paused` | false |
| `countIn` | null |
| `loop` | `{enabled:false,a:0,b:0}` |
| `onEnded` | null |

**Track object** (80): `{name, color, buffer, gain, nativeSources:Set<{source,when}>, merger, volume:1, muted:false, soloed:false}`.

| Method | Signature | Lines | Notes |
|---|---|---|---|
| `loadStems` | `async (stems:[{name,color,key,url}], onProgress?(done,total,{loaded,total})) → {duration,tracks} \| undefined` | 44-112 | Returns undefined if destroyed mid-load. |
| `_applyGains` | `()` | 114-121 | Gain = audible && recordingAudible ? volume : 0. Uses `setTargetAtTime(…, 0.012)`. Solo beats mute. |
| `setVolume` | `(name, v)` | 123-126 | |
| `setRecordingAudible` | `(enabled)` | 127 | Used by `notation/audio.js:78,108` (Listen "notation only"). |
| `toggleMute` / `toggleSolo` | `(name) → boolean\|undefined` | 128-137 | Toggle only. **There is no setter**; v2 restore and undo need `setMuted`/`setSoloed`. |
| `resetMixer` | `()` | 138-141 | |
| `_positionIn` | `(segment, time) → sec` | 143-148 | `offset + max(0,time−when)·rate`, wrapped modulo the loop, clamped to [0,duration]. |
| `_segmentAt` | `(time)` | 150-152 | Last segment with `when ≤ time`, else `segments[0]`. |
| `getPositionAt` | `(ctxTime) → sec` | 154-161 | Not playing → `pausedAt`. During count-in: audible pre-roll → `max(0, target − duration + elapsed·rate)`; silent → `target`. |
| `getPosition` | `() → sec` | 163 | |
| `countingIn` (getter) | `→ boolean` | 164 | `playing && countIn && now < countIn.endWhen` |
| `_schedule` | `(offset?, when = now + lookahead) → when` | 168-218 | See §3.2. |
| `play` | `async ({countIn=null, audiblePreRoll=false} = {})` | 220-244 | `countIn` = `{duration, beats:[{offset,downbeat}]}` from `Metronome.countInPlan()`. |
| `pause` | `()` | 246-264 | Also cancels a pending `play` (`playRequest++`). |
| `subscribeTransport` | `(listener) → unsubscribe` | 265 | Fires on `_schedule` and `pause`, **not** on stationary seeks. Only consumer: `notation/audio.js`. |
| `stop` | `({returnToEdit=true} = {})` | 269-273 | `pause()`, then `seek(returnToEdit ? editPosition : pausedAt)`, then `paused = false`. |
| `toggle` | `()` | 275 | **Unused** anywhere in src. |
| `seek` | `(time)` | 277-287 | Sets `editPosition` (the cue). **A seek during count-in pauses** (279). Wraps to A if ≥ B with the loop on. |
| `setSpeed` | `(rate)` | 289-294 | Clamped to **0.5–1.5** (292). Ignores non-finite values. Pauses during count-in. |
| `setPreservePitch` | `(enabled)` | 296-300 | Pauses during count-in. |
| `setLoop` | `(enabled, a=loop.a, b=loop.b)` | 302-310 | `enabled` is forced false when `b − a < 0.02`. Clamps to the duration. Pauses during count-in. When stopped, `pausedAt ≥ b` → `pausedAt = a`. |
| `beatsBetween` | `(ctxStart, ctxEnd, beats:[{time,…}]) → [{…beat, when}]` | 313-339 | Maps media-time events through every segment and loop wrap. Binary search per window. Used by the metronome and `notation/audio.js:105`. |
| `tickEnd` | `()` | 341-349 | End-of-song detection. **Only called from player rAF** (`player.js:1061`). Not playing, not looping, at the end → `pause`, `pausedAt = duration`, `paused = false`, `onEnded()`. |
| `destroy` | `()` | 351-365 | |

Public fields read by other modules: `ctx`, `duration`, `tracks`, `playing`, `paused`, `loop`, `rate`, `preservePitch`, `editPosition`, `countIn` (its `endWhen`), `countingIn`, `revision`, `lookahead` (tests), `segments` (tests), `master` (`tests/notation-demo.js:20`).

**Events today:** only `onEnded` (single callback) and `subscribeTransport`. There is no `wrap`, no `statechange` handling, no `nextWrapAt`, no `seekAt`. Every §9.5 addition is new work.

### 2.3 `src/js/metronome.js`: `export class Metronome` (10-182)
**`constructor(engine, songMap = null)`** (11-38):
- Creates `out` gain → **`ctx.destination` directly**, bypassing `engine.master`. That is why count-in clicks are audible while master is held at 0.
- Defaults: `enabled=false, accent=true, volume=0.7, countIn=false, countInLength=1, countInUnit='bars', audiblePreRoll=false`.
- If no store is passed, it builds `new SongMapStore(defaultSongMap(duration), duration, {legacy:{map:null,detected:null,source:'map'}})` (35).
- Subscribes to the store: change → `recompute` + `_notify` (36).

| Method | Signature | Lines | Notes |
|---|---|---|---|
| `load` | `(tempo)` | 40-51 | Reads `accent, volume, countIn, countInLength (1–16), countInUnit, audiblePreRoll`, then `songMap.load(tempo)`. `tempo.enabled` → `setEnabled(true)`. |
| `serialize` | `() → tempo` | 53-65 | Settings `{accent, volume, countIn, countInLength, countInUnit, audiblePreRoll, enabled}`. Untouched legacy map → `...songMap.legacy` (`{map, detected, source}`). Otherwise `{songMap, source:'detected', map:[], detected: beats.map({time,downbeat})}` (back-compat for desktop <1.6). |
| `setDetected` | `(rawBeats:[[time, beatInBar]])` | 68-70 | → `songMap.replaceFromBeats`. |
| `recompute` | `()` | 72 | `beats = songMap.beats`, shape `[{time, downbeat, …}]`. |
| `sectionAt` | `(t) → {t,bpm,beatsPerBar,unit}` | 75-78 | Legacy shape. Used by `notation/entry.js:7,16,30`. |
| `setAccent`, `setVolume` | `(b)`, `(v)` | 80-81 | `_notify(false)`: does not cancel the count-in. |
| `setCountIn`, `setCountInLength`, `setCountInUnit`, `setAudiblePreRoll` | | 82-85 | `_notify()`: **cancels a running count-in** (`engine.pause()`). |
| `_notify` | `(cancelCountIn=true)` | 87-90 | Calls `onChange`; player wires that to persistence and redraw (`player.js:863`). |
| `setEnabled` | `(b)` | 93-97 | |
| `start` / `stop` | `()` | 99-105 | 25 ms `setInterval(tick)`. `stop` cancels the scheduled oscillators. |
| `tick` | `()` | 112-136 | Look-ahead window 0.12 s. A change in `engine.revision` cancels clicks and resets `_schedUntil`. Count-in clicks go at `countIn.startWhen + offset/countIn.rate`. Song clicks come from `engine.beatsBetween(max(start, countIn.endWhen), end, beats)`. |
| `countInPlan` | `() → {duration, beats:[{offset,downbeat}]}` | 139-161 | See §4. |
| `_click` | `(ctxTime, accent, tracked=true)` | 164-177 | Oscillator at 1600 Hz (accent) or 1050 Hz, 50 ms envelope. `tracked=false` is used by tap calibration (`map-mode.js`) so those clicks survive cancellation. |
| `beatsForView` | `(t0,t1)` | 179 | **Unused.** |
| `destroy` | `()` | 181 | |

`metronome.source` is read by `notation/entry.js:21` but **never set**. It is always undefined, so that branch is dead.

### 2.4 `src/js/player-layout.js`
`export function arrangePlayerControls(root)` (2-44) reparents the markup after every render:
- `.transport-main` [role=group "Playback"]: `#play #pause .playback-position`, the speed `.t-group`, `#metro-btn #map-btn #mixer-reset #help` (21-22).
- `.practice-strip` [role=group "Loop"]: `#loop-readout` (23).
- `.timeline-tools` [role=group "Timeline"]: the zoom group and the grid group (24).
- `.transport` is replaced by `[transport-main, practice-strip]` (25).
- `.time-ruler` holds `<span>Tracks</span><div class="ruler-scale">` (26-28). The prepend order makes the player start with workspace-nav, tools, ruler.
- `nav.workspace-nav` with `button[data-workspace=practice|transcribe]` (30-32). This is the Practice/Transcribe tab bar that `launcher.js` binds.
- aria-labels for a list of ids (33-34), including the **nonexistent `m-bpm` and `m-sig`** (spec §9.6 deletes these).
- `#metro-btn` gets `aria-controls/expanded`. A `.metro-close` button is prepended to `#metro-pop` (35-43).

### 2.5 `src/js/waveform.js`
| Export | Signature | Lines | Notes |
|---|---|---|---|
| `computePeaks` | `(buffer, width) → Float32Array` | 3-5 | **Unused in src.** |
| `computePeaksRange` | `(buffer, startSec, endSec, width) → Float32Array[width*2]` (min,max pairs) | 9-33 | Mono mix of ch0/ch1. O(samples in window) per call, with no cache. It runs for every visible track on every zoom, pan or resize frame. |
| `drawWaveform` | `(canvas, peaks, color, {dim}) ` | 35-59 | Sets the backing store to the CSS size × dpr. Bars at 0.92 of the half-height. `dim` → alpha 0.28. |

### 2.6 `src/js/stemcache.js`
| Export | Signature | Lines |
|---|---|---|
| `fetchStem` | `async (key, url, onProgress?(loaded,total)) → ArrayBuffer` | 30-55 |
| `clearStemCache` | `async () → count` (also clears the decoded cache) | 79-87 |
| `stemCacheSize` | `async () → bytes` | 90-102 |
| `likelySupportsOpus` | `() → boolean` | 119-123 |
| `isDecodeError` | `(err) → boolean` | 126-133 |
| `codecErrorMessage` | string | 135-138 |

- The Cache API store is `woodshed-stems-v1`, keyed by the synthetic URL `https://stem.cache.invalid/<key>` (10-13).
- A cache hit reports `onProgress(1,1)` (37).
- Progress reading tees through `res.clone()` (47).

### 2.7 `src/js/decoded-stem-cache.js`
- `export class DecodedStemCache(maxBytes)`:
  - `async load(key, sampleRate, decode) → AudioBuffer` is an LRU keyed by `[key, sampleRate]`;
  - a `generation` guard keeps a `clear()` racing a decode from repopulating the cache;
  - `clear()`.
- `export const decodedStemCache`: 128 MB on small or coarse devices, otherwise 512 MB (39-43).

### 2.8 `src/js/musical-position.js`
- `buildBarIndex(beats) → {entries:[{time,bar,beat}], total}` (3-11) and `barPosition(index, time) → {bar, beat}` (13-21).
- **No src importer.** `SongMapStore.positionLabel` (`song-map.js:162-170`) replaced it. Spec §9.4 Phase 0 deletes it, along with its test at `tests/playback-engine.test.js:92-99`.

### 2.9 `src/js/interactions.js`
- `export const isPointerControl(target) → boolean` (6).
- `export function initializeInteractions()` (7-38) installs capture-phase document listeners:
  - `pointerdown` marks the control as pointer-activated;
  - `keydown` Tab resets the marks;
  - `click` blurs pointer-activated buttons and controls (`detail !== 0`), except selects;
  - `change` on a select releases it;
  - `pointerup` on a range releases it;
  - `dragstart` on an img is prevented.
- This is the "blur hack" that keeps Space reaching the transport after a mouse click on a control.
- Consumers: `player.js:1075`, `notation/editor.js:12`. Called from `app.js:3`.
- Spec §9.4 Phase 0 deletes it; the registry and dispatcher plus slider primitives replace it.

### 2.10 `src/js/onsets.js`
- `detectOnsets(buffer, {hop=128, window=512}) → seconds[]` (5-31) and `nearestOnset(onsets, time, tolerance) → sec|null` (34-40).
- Consumer: `map-mode.js:7` (tap snapping to drum hits). **KEEP** (spec §9.2). It is not used by the player itself.

### 2.11 `src/js/timeline-navigation.js`
- `boundedView(start, end, duration, minimum=0.25) → {start,end}` (4-8) clamps the window as a whole, so the span is preserved at the edges.
- `wheelNavigation() → (event, width, now?) → {mode:'pan'|'zoom', delta}` (10-24) holds a gesture-sticky mode for 200 ms. ⌘/Ctrl → zoom, Shift → pan, otherwise the dominant axis. `deltaMode` is normalised.
- Consumers: `player.js:16,529,582`, `notation/editor.js:13`. KEEP for the Stems surface.

---

## 3. Engine internals

### 3.1 Audio graph (`loadStems`, engine.js:44-112)
```
per track:  AudioBufferSourceNode (native path, one per _schedule) ─┐
                                                                     ├─► track.gain ─► master ─► destination
SignalsmithStretch worklet (2N discrete ch) ─► pitchGate (2N ch, gain 0|1) ─► ChannelSplitter(2N)
                                   └─ for track i: splitter[2i,2i+1] ─► ChannelMerger(2) ─► track.gain
metronome.out ─► destination           (metronome.js:14-16; bypasses master)
DrumAudio.out ─► destination           (notation/audio.js:76)
```
1. Each stem is loaded through `decodedStemCache.load(key, sampleRate, () => fetchStem → decodeAudioData)` (56-62). Progress sums the bytes across stems (46-52).
2. **Padding:** shorter stems are copied into a buffer the length of the longest (73-77), so loops past their end stay silent and aligned.
3. `duration` = the longest stem. `loop.b = duration` (82).
4. **One** `SignalsmithStretch(ctx, {numberOfInputs:1, numberOfOutputs:1, outputChannelCount:[2N], channelCount:2N, channelCountMode:'explicit', channelInterpretation:'discrete'})` (86-89). One phase-linked analysis across every stem prevents transient smearing and comb filtering between stems.
   - The module URL comes from the `signalsmith-stretch?url` import (3-6).
5. `addBuffers(buffers, transfer)` receives **copies** (`getChannelData(c).slice()`; mono duplicated to 2 ch) (105-107). The worklet therefore holds a second full copy of every stem.
6. `lookahead = max(0.05, latency() + 0.02)` (108).
7. Destroy is checked after every await (68, 90, 109).

### 3.2 `_schedule(offset?, when)` semantics (engine.js:168-218)
This is the single choke point for every transport change while playing: play, seek, speed, pitch and loop.

1. `current` = the segment audible now. `pending` = the first segment with `when > now` (a change that hasn't rendered yet).
2. `seekOffset = offset ?? pending?.seekOffset`. A pending seek **survives** a rapid speed or pitch change before it renders (test `playback-engine.test.js:47-56`).
3. `position = seekOffset ?? project(current, when) ?? pausedAt`. Then, if the loop is on and position ≥ b → a.
4. `processing = preservePitch && rate !== 1`. At 1× the native path is sample-locked (test 101-116).
5. The new segment is `{when, offset:position, seekOffset, rate, loop:{...loop}, processing}`. `segments = [current, segment]`: history collapses to two entries.
6. `stretch.schedule({active:processing, output:when, input:position, rate, semitones:0, loopStart, loopEnd})` is **always** sent; it is inactive on the native path.
7. **Mutual exclusion:** `pitchGate` is set at `now` to the current segment's processing state and at `when` to the new one (186-188).
   - Native sources that have not started (`entry.when > now`) are stopped and removed now.
   - Started sources get `stop(when)`. The stop time can be moved again if the pending change is replaced.
8. If `!processing`, a fresh `AudioBufferSourceNode` per track is created with `playbackRate = rate` (varispeed when pitch is off), `loop/loopStart/loopEnd` from the engine loop (gapless native loop), and `start(when, position)` (201-213).
9. `revision++`, then the transport listeners are notified (215-216).

**Segment model.** Position at any context time = `_positionIn(_segmentAt(t), t)`. Loops are **modulo inside one segment** (146). The engine schedules no per-pass events. That is why a `wrap` event (spec §9.5) has to be *computed* (`when + (b − offset)/rate`, then every `(b − a)/rate`) instead of observed.

### 3.3 `play` / count-in (engine.js:220-244)
- Guard: already playing, destroyed, or no tracks.
- `request = ++playRequest`, then `await ctx.resume()` if the context is suspended. If `pause`/`stop` ran meanwhile, playback is abandoned (test 78-83).
- `offset = pausedAt` (≥ duration → 0). **No loop-start policy.** Playing with the cue before A plays the lead-in into the loop (test 65-71). Spec §4.6 "Space starts at loop start" must be implemented in `transport.js`, not by changing the engine.
- Count-in:
  - `startWhen = now + lookahead`, `endWhen = startWhen + duration/rate`;
  - `countIn = {...plan, target, startWhen, endWhen, rate, audible}`.
  - **Silent:** audio starts at `endWhen` from `target`.
  - **Audible pre-roll:** audio starts at `startWhen + max(0, −(target − duration))/rate` from `max(0, target − duration)`. Pre-roll before 0 is silence (test 160-166).
- Master gain: 0 now → 1 at `when`.
- Afterwards `playing = true`, `paused = false`.

### 3.4 `pause` / `stop` / `seek` and the cue (engine.js:246-287)
- `pause`: `pausedAt` = the count-in target (counting in), else a pending seek's offset (test 117-120), else the live position. Then `countIn = null`, `paused = true`, segments cleared, master muted, `stretch.stop`, native sources stopped.
- `stop({returnToEdit})` = `pause` + `seek(editPosition | pausedAt)` + `paused = false`. Because `seek` writes `editPosition`, **stop-in-place moves the cue** to where it stopped (test 227-234).
- `seek` always writes `editPosition`, so a click while playing moves the cue too (test 235-239).
  - Spec §4.9 replaces this with a pointer-type split: touch while playing never seeks, mouse seeks immediately.
- Count-in cancellation is implicit: `seek`, `setSpeed`, `setPreservePitch`, `setLoop` and `Metronome._notify()` all call `pause()` while `countingIn` (279, 291, 297, 304; metronome 88). That means a seek during count-in **stops** playback; it does not re-target it (test 167-177).

### 3.5 Speed and pitch paths
| State | Path | Pitch |
|---|---|---|
| rate = 1 | Native `AudioBufferSourceNode`s, sample-locked, pitchGate 0 | Original |
| rate ≠ 1, `preservePitch` | Signalsmith (`active:true`), pitchGate 1, no native sources | Preserved |
| rate ≠ 1, `!preservePitch` | Native with `playbackRate = rate` | Varispeed |

- Rate is clamped 0.5–1.5 (292). Spec E1 (25–49%) lifts the clamp.
- `preservePitch` is **per device** today (`ws.preservePitch`, player.js:317,791). v2 makes it per song (`keepPitch`) with a device default.

### 3.6 Loop path
- Native: `source.loop` with `loopStart`/`loopEnd`. Signalsmith: `loopStart`/`loopEnd` in the schedule. Both are gapless. Position wraps modulo inside the segment.
- The engine's minimum loop length is 0.02 s (307). The player has its own thresholds: 0.02 s on drag (652-661), 0.1 s on the `[`/`]` keys (1093-1094).
- Disabling the loop mid-pass continues from the audible position (test 29-37).

### 3.7 Engine test coverage (`tests/playback-engine.test.js`)
- **Harness:** a fake `AudioContext` with a settable `currentTime` (11-19), `stretch = {schedule, stop}` mocks, two tracks (20-26), and `advance`/`settle` (27-28).
- **Covered:**
  - loop disable after many passes (29);
  - speed and loop edits on one timeline (38);
  - pending seek surviving rate/pitch changes (47);
  - default pitch preservation and varispeed (57);
  - wrap on seek to B, lead-in before A, invalid loop (65);
  - natural end and replay from 0 (72);
  - async resume vs pause (78);
  - metronome loop downbeat and pending rate (84);
  - `musical-position` (92; delete with the module);
  - 1× bypass with no processed tail (101);
  - pause during a pending seek (117);
  - Signalsmith routing (122);
  - silent count-in timing (139);
  - pre-roll into a loop (151);
  - pre-roll before 0 (160);
  - count-in cancellation by seek/speed (167);
  - countInPlan bars/beats and persistence (178);
  - count-in clicks with the metronome off (191);
  - countInPlan at the grid end (202) and with tempo changes and extrapolation (209);
  - stop returns to the cue (219);
  - pause vs stop semantics (227);
  - seek during playback moves the cue (235);
  - stop during pre-roll or a pending start (240);
  - DrumAudio loop segments with no drift (248);
  - DrumAudio preview and hat choke (262).
- **All of these stay valid.** §9.5 additions extend the same harness. The fixture already exposes `currentTime`, so wrap timing, `seekAt` and scheduled `setSpeed(…, {at})` can be tested the same way.

---

## 4. Count-in logic (`Metronome.countInPlan`, metronome.js:139-161)
1. `pos` = the engine position, or 0 at the end. `n` = beats per bar **at pos** (`songMap.beatsPerBarAt`).
2. `count = countInLength × (unit === 'bars' ? n : 1)`.
3. `grid = this.beats`, or `[{time:pos, downbeat:true}]` when there are no beats.
   - Fallback interval = `60 / clamp(bpmAt(pos) || 120, 20, 400)`.
   - `firstInterval`/`lastInterval` come from the grid ends (minimum 0.15 s).
4. `at(i)` extrapolates beats before the first and after the last. Downbeat phase is taken modulo `n` from the last downbeat.
5. `index` = the last beat ≤ pos (or extrapolated). `fraction` = pos's phase within that beat.
   - `start = at(index − count) + fraction·interval`. The count-in **keeps the sub-beat phase**, so the target lands in time even mid-beat.
6. Beats between `start` and `pos` become `{offset: beat.time − start, downbeat}`. The result is `{duration: pos − start, beats}`.

**Player policy:**
- `doPlayStop` (player.js:973-990) passes a count-in only if `metro.countIn && !active.paused`. Resuming from pause never counts in.
- `audiblePreRoll` is passed through.
- After play starts, `metro.start()` runs if count-in or the click is on.
- Clicks are scheduled in `Metronome.tick` (124-129) and cancelled through `revision` changes.

**Spec deltas (§4.3, §4.7, §9.5):**
- "Count in every loop pass" needs the segmented-loop `gapSec` path. The gap clicks reuse `countInPlan` logic.
- Again (Enter) uses count-in, both stopped and playing.
- The unmapped Lead-in is time-based ("Lead-in 2 s", audio pre-roll with no clicks).
- `Click: During count-in only` is today's `enabled=false, countIn=true`. `Always` = `enabled=true`.

---

## 5. `player.js` responsibilities by concern (line ranges)

| # | Concern | Lines | What it does | Fate per spec §9.2 |
|---|---|---|---|---|
| A | Imports / constants / formatters | 1-64 | Grid settings, stem colour tokens, `fmt`, `fmt2` | Formatters → `src/stage/hud.js` / util. `STEM_COLOR_VAR` → tokens / `wave-render.js`. |
| B | Track row template | 66-80 | `.track` with Mute/Solo/volume and canvas | → `surfaces/stems-surface.js` (header 168/128 px, `OUT`/`SOLO` words, 1-9 key-caps) |
| C | **Markup** `playerMarkup` | 82-197 | The whole player DOM (§6) | **Deleted**; replaced by `stage.js` + `hud.js` + `controls.js` + `strip.js` + sheets |
| D | Module state, `closePlayer` | 199-219 | Lifecycle | → `stage.js` `mount/unmount` (unmount = `practice.flush()` + `engine.destroy()`) |
| E | Header identity | 222-247 | `#header-song`: cover, title, artist · album · N stems, Edit (pencil), Share; live `backend.onSong` | → HUD identity row (`‹`, cover, title, key/tuning chips, Notes chip, `⋯`); Edit → `E`; Share → `⋯` |
| F | **Loading** | 248-315 | Skeleton rows (250-256), all controls disabled (257), `.player-load-progress` card (258-265), `showLoadError` with retry (266-275), engine created before URL signing (276-277), `signKeys`/`resolveUrls` (279-285), missing-stem check (290-294), `loadStems` progress text (296-308), codec/decode error mapping (309-313) | → `stage.js` + `transport.js` "interactive loading" (§4.12): controls live and queued, a Play ring carries the progress text, errors show in the music area. The card is deleted. Progress strings move verbatim. |
| G | **Practice restore (v1)** | 317-326 | `ws.preservePitch` → engine; `practice.loop` → `setLoop`; tracks → volume plus *toggle* mute/solo; `rate` | → `practice-state.js` (v1→v2 read). Needs engine mute/solo setters. |
| H | View and grid state, re-render | 327-345 | `view {start,end}`; `grid = {...ws.grid, ...practice.grid}`; full re-render (331) + re-arrange (332); DOM refs | View → stems-surface. Grid → device pref `ws.prefs.stems` (practice.grid is dropped on v2 upgrade) |
| I | Track rows (post-load) | 346-352 | `trackRows[{track, canvas, row}]` | → stems-surface |
| J | Coordinate mapping | 354-358 | `waveW`, `span`, `timeToX`, `xToTime` against `#timeline-interact` | → stems-surface; also needed by map-mode (passed in, 905) |
| K | **Waveform tracks** | 360-377 | rAF-throttled `drawWaveforms`: `computePeaksRange` per track per view, dim when inaudible | → `wave-render.js` (one renderer; hatch for muted; cached peaks pyramid) |
| L | **Beat grid / snap / ruler** | 379-462 | `shouldSnapToGrid` (383), persist `ws.grid` (384-386), `gridTicksForView` (387-403), `snapTime` binary search plus subdivisions, bypassed while tempo sources are open (404-436), `seekTo` = snap + seek + Follow on (437), `tipText` (438), `drawGrid` canvas with map-mode decor and pinned lines, plus the ruler labels (448-450) and `mapMode.renderLane` (451) | → stems-surface (subdued grid, ≥ 6 px rule) + Edit · Map. `snapTime` should become a shared util (map + stems). |
| M | **Overview minimap** | 464-488, 673-713, 803-810 | Muted first-stem waveform, viewport bracket (6 px edges), loop band, edit cursor and playhead ticks; mouse drag pan/zoom/seek; toggle persisted in `ws.overview` | **Deleted**; becomes the strip viewport bracket on the Stems surface (§4.4D, §4.5) |
| N | **Loop overlay and readout (practice strip)** | 490-525 | `#loop-region`, `#handle-a/b`, `#lr-a/b/len`, `#loop-toggle.on`, `#loop-readout.active`; mini overlay | **Deleted**; becomes loop handles on every surface (§4.8), HUD Loop readout, Loop card |
| O | **Zoom / pan / Follow** | 527-551, 581-595 | `setView` via `boundedView`, `zoomAt`, `panBy`, `fit`; Follow toggle (`#follow-playhead`); wheel → pan or zoom, wheel while playing turns Follow off | → stems-surface toolbar + Follow pill (§4.9). `wheelNavigation` is kept. |
| P | Grid UI | 553-579 | `#grid-toggle` (text On/Off), `#grid-snap`, `#grid-division` | → stems-surface toolbar `Grid: Off · Bar · Beat · ½ · ¼` + Snap |
| Q | **Waveform pointer interaction** | 597-671 | **Mouse-only** on `#timeline-interact`. Hover cursor and time tip (602-620); mousedown modes `new/edgeA/edgeB/move` with `EDGE_PX=7` (622-635); window mousemove/up (637-639); drag edits the loop (641-664); a click with no drag (≤ 3 px) → `seekTo` + `mapMode.selectNear` (665-671) | → stems-surface on pointer events + `setPointerCapture`, 8 px threshold, 44 px coarse handles, glass rules |
| R | **Mute / solo / volume** | 715-724, 796-801 | Button toggles → `engine.toggleMute/Solo` + redraw; `.track-vol` input → `setVolume`; `#mixer-reset` | → Mix sheet + stems rows + `transport.js`/`practice-state` (undoable, Minus me, Only me) |
| S | **Transport** | 726-743, 973-992 | `setPlayIcon` (labels Play / Stop / Resume / Cancel count-in; pause disabled unless playing, paused or starting); `stopPlayback` (stop + reveal the position); `engine.onEnded`; `doPlayStop({pause})` with `startingPlayback`/`playAction` race tokens; `#play`/`#pause` | → `transport.js` façade: `play/stop/again/pause`, cue model, loop-start policy, count-in policy, races |
| T | **Loop A/B controls** | 745-777 | `#loop-toggle` (no region → **loops the visible window**, 750); `#loop-clear` (`setLoop(false, 0, duration)`); `#set-a/#set-b` (snap; the opposite edge defaults to duration or 0); `.nudge` ±0.05 s (min length 0.02); `#lr-a/#lr-b` jump (Home/End) | → `transport.js` (smart loop toggle: section → 4-bar phrase → ±5 s), Loop card (bar/beat or 0.1 s, Alt 50 ms, Alt+Shift 10 ms), I/O, ⌫ |
| U | **Speed and Keep pitch** | 779-794 | `#speed` range 0.5–1.5 step 0.05; `#speed-val`; double-click → 1; `#preserve-pitch` → `ws.preservePitch` | → Speed sheet + controls (`−`/`+` 5%, `,` `.`, `` ` ``), keepPitch per song |
| V | Metronome, song map, bar readout | 812-820 | `new Metronome(engine)`; `metronome.load(song.tempo)`; `songMap = metronome.songMap`; `#bar-position` "Bar n / N · Beat b" or "Bar — / N" | → `transport.js` owns the `SongMapStore` (pass it into `Metronome`); HUD Position (never "Bar —") |
| W | **Metronome popover** | 822-872 | `#metro-pop` controls; `refreshMetroUI`; `nowText` "♩ = 120 · 4/4"; `metronome.onChange` → refresh + drawGrid + `persistTempo`; open/position (865) | **Deleted**; becomes the Click sheet (§4.7) |
| X | Tempo persistence | 833-842, 939 | `persistTempo` 400 ms debounce → `backend.saveTempo(song.id, metronome.serialize())`; flush on cleanup | → `transport.js` (or a `tempo-state` helper) + flush on `pagehide`/`visibilitychange` |
| Y | Drum part adoption and map guard | 874-901 | `adoptDrumPart`: fetch notation (owner: `getNotation`; shared: `getSharedNotation(shareToken)` only for a legacy map); `songMap.adopt(fromTimeline(…))` while the map is still legacy; installs the `'notation'` guard that blocks map edits that would strand drum bars (`guard.keep` keeps the measure ids) | Keep the logic; move it to `stage.js` (song session) so both the Stage and Edit · Map use it |
| Z | Map mode hosting | 903-910, 938, 940-941 | `createMapMode({... getView, setView, setFollow, timeToX, play, redraw: drawGrid, onLoopChange, onDetect, onSources, onExit, onEnter: transcription.leaveChart, setGridVisible})`; `#m-map` enters it | → `src/edit/map/` posture. **Coupled to the Tracks DOM** (see §6.3). |
| AA | Tempo sources hosting | 911-937 | `.tempo-sources-host` inside `#map-strip`; search/load/align/import drums wiring; `onImportDrums` → `transcription.importScore` | → Edit · Map "Find a chart" side panel |
| AB | Beat detection | 943-971 | `#m-detect` → `backend.detectBeats(song.id, progress)` → `metronome.setDetected`, auto-enables the click; status in `#m-detect-status` plus the map report | → Edit · Map Get a map / Tools; strip `Get bars` |
| AC | Initial draw, resize, theme | 994-1005 | rAF first draw; `ResizeObserver` on `#tracks` and `#overview`; `woodshed:theme` → recolour dots + redraw | → stems-surface / wave-render (the Stage is always dark, but the Library theme still matters) |
| AD | **Chart and Transcribe hosting** | 1007-1009 | `attachNotation({root, song, engine, metronome, songMap, ready: drumPartReady, setLoop, clearLoop, openImport, mapActive, openMap, getView, setView, setFollow, play: doPlayStop, readOnly, shareToken, onLoopChange, onMixerChange})` | Chart → `surfaces/chart-surface.js` (chart.js `chrome:false`). Transcribe → `src/edit/chart/`. `launcher.js` is deleted (Phase 4). |
| AE | **Save practice** | 1010-1030 | See §7 | → `practice-state.js` |
| AF | Share pre-flush | 1023-1029 | `saveForShare`: `transcription.flush()`, then immediate `saveTempo` + `savePractice` | → `stage.js` `flushAll()` used by the share dialog |
| AG | **rAF frame** | 1032-1064 | `transcription.tick(pos)`; Follow auto-scroll (keeps the playhead in the window, re-anchored at 10%); edit cursor and mini edit cursor; `#edit-position` "Start m:ss.cc"; playhead and mini playhead; `#time` ("Count-in · Ns" or "m:ss.cc / m:ss"); `setPlayIcon`; bar readout; metro "now"; `mapMode.tick()`; snap class; **`engine.tickEnd()`** | → one rAF loop in `stage.js` feeding the HUD (≤ 30 Hz text) and playheads (60 Hz). **End detection must move to a transport ticker** (rAF stalls in background tabs). |
| AH | **Keyboard** | 1066-1107 | See §8 | **Deleted**; replaced by `src/app/commands.js` + `dispatch.js` |

---

## 6. DOM contract (ids and classes other code depends on)

### 6.1 Created by `player.js` markup (82-197) and `createTrackRow` (66-80)
| Selector | Element / purpose | External dependants (file:line) |
|---|---|---|
| `#player-root` | Host (in index.html). Gets `--track-count` (225) and `aria-busy` | `shared-song.js:16`; tests/fixture probes (`#player-root .player`, `.is-loading`, `[aria-busy]`) |
| `#header-song` | App header slot; gets `.pt-cover .pt-meta .ptitle .psub .header-edit-song .header-share-song` | `player-ui.test.js` (`.ptitle`, `.header-edit-song`, `.header-share-song`); CSS `styles.css`, `record-club.css`, `song-metadata.css`, `sharing.css` |
| `.player` (+ `.is-loading`, `.mapping`, `.notation-active`, `.chart-active`, `.notation-expanded`) | Player root | `map-mode.js:512,530` (`.mapping`); `launcher.js:13,30-31`; `editor.js:134,335,341`; `tempo-sources.js:19`; CSS in 5 files |
| `#tracks` / `.tracks` | Track column (rows inserted before `#timeline`) | `map-mode.js:101` (lane fallback); `.tracks > .player-load-progress` in `player-ui.test.js:74` |
| `.track .track-ctrl .track-name .track-dot .track-buttons .tbtn.mute/.solo[data-stem] .track-vol[data-stem] .track-wave canvas` | Stem rows | `player.js:1008` onMixerChange queries `.tbtn.mute`; CSS `styles.css`, `record-club.css`, `theme.css`, `motion.css` |
| `#timeline` | Overlay stack over the rows | `map-mode.js` (via `#map-cursor` inside it); CSS |
| `#grid-canvas`, `#tempo-markers` | Beat grid canvas; map lane marker container | `map-mode.renderLane(tempoMarkers, view)` (451) |
| `#loop-region`, `#handle-a`, `#handle-b` | Loop band and handles | CSS only |
| `#edit-cursor` | Cue line | `player-ui.test.js:182`; CSS `tempo-map.css`, `theme.css` |
| `#map-cursor` | Map selection cursor | `map-mode.js:36,714-721` |
| `#playhead` (+ `.snap-on`), `#time-tip` | Playhead and hover tip | CSS |
| `#timeline-interact` | Pointer surface (wheel, mouse) | `map-mode.js:360` (focus target); `probe-touch.cjs` |
| `#overview` `#mini-canvas` `#mini-loop` `#mini-view .mv-edge.l/.r` `#mini-edit-cursor` `#mini-playhead` | Minimap | CSS only |
| `#map-strip` | Map inspector host (hidden) | `map-mode.js:34` (rewrites its class to `.map-inspector`); `tempo-sources.js:152,176,262`; `player.js:913`; `tests/map-mode.test.js:39,58`; `tempo-sources.test.js` |
| `.transport` | Transport container (reparented) | `launcher.js:20` (chart and editor hosts inserted **before** it); `player.js:865` popover offset |
| `#play` `#pause` | Play/Stop, Pause | `player-layout.js:21`; `player-ui.test.js:181` (`.transport-main #pause`); fixture `capture.cjs` (`#play`) |
| `.playback-position #time #bar-position #edit-position` | Readouts | `player-ui.test.js:82` (`#bar-position` text "Bar 1 / 5 · Beat 1"); probes `#time` |
| `#loop-readout` (+ `.active`) `#loop-toggle` `.nudge[data-edge][data-d]` `#lr-a` `#lr-b` (`.jumpable`) `#lr-len` `#set-a` `#set-b` `#loop-clear` | Practice strip | `player-layout.js:23`; `probe-touch.cjs` (`#loop-readout`); CSS |
| `#speed` `#speed-val` `#preserve-pitch` | Speed | `player-ui.test.js:72-105,133` |
| `#zoom-out` `#zoom-in` `#zoom-fit` `#follow-playhead` `#mini-toggle` | View tools | `player-layout.js:24,33` |
| `#grid-toggle` `#grid-division` `#grid-snap` (`.grid-controls`) | Grid | `player-layout.js:24,33`; `capture.cjs:95` |
| `#metro-btn` | Opens the popover (`aria-expanded`); `.on` = click enabled | `player-layout.js:35-37`; `map-mode.test.js:43,59`; `player-ui.test.js:159`; `capture.cjs` |
| `#map-btn` | Map mode toggle (**bound by map-mode.js:35,535**, not player) | `capture.cjs` (8×) |
| `#mixer-reset`, `#help` (title-only tooltip, no handler) | | `capture.cjs:101` |
| `#metro-pop` `#m-onoff` `#m-accent` `#m-vol` `#m-countin` `#m-countin-length` `#m-countin-unit` `#m-preroll` `#m-now` `#m-map` `#m-detect` `#m-detect-status` | Metronome popover | `player-ui.test.js:133-168,190-192`; `map-mode.test.js:84`; `capture.cjs` |
| `.player-load-progress[role=status] .load-detail progress`, `.player-load-error[role=alert]`, `.wave-skeleton` | Loading and error | `player-ui.test.js:74,109-111`; CSS |
| `.tempo-sources-host` | Inside `#map-strip` | `player.js:911-913` |

### 6.2 Created by `player-layout.js`
`.transport-main`, `.practice-strip`, `.timeline-tools`, `.time-ruler .ruler-scale` (`player.js:448` writes the labels), `nav.workspace-nav button[data-workspace]` (bound by `launcher.js:88-89`), `.metro-close`.
Dependants: `map-mode.js:101` (lane inserted after `.time-ruler`), `launcher.js:13,27` (appends `.workspace-spacer` and `.practice-view` Chart/Tracks switcher to the nav), `tempo-sources.js:19` (makes `.workspace-nav` inert), `chart.css` and `notation.css` (hide `.tracks/.timeline-tools/.time-ruler/.overview/.transport` in chart/notation modes).

### 6.3 Coupling that blocks a clean split
- **map-mode.js expects the Tracks DOM:** `#map-strip`, `#map-btn`, `#map-cursor` inside `#timeline`, `.time-ruler`/`.tracks` for the lane, `#timeline-interact` for focus, `.player.mapping`. It also expects `getView/setView/timeToX/redraw` from the player's view model.
  - Edit · Map (Phase 4) must supply the same contract from the stems surface, or map-mode gets a host/geometry adapter.
- **launcher.js expects `.player`, `.workspace-nav`, `.transport`.** It inserts `.chart`/`.notation-workspace` before `.transport` and paints `.player.chart-active/notation-active`. The spec deletes the workspace nav (Phase 1a), so the chart surface must be hosted without launcher.
- **editor.js** toggles `.player.notation-expanded` (`editor.js:134,335,341`).
- **tempo-sources.js:19** makes `.notation-workspace, .workspace-nav, .map-lane` inert, and `closest('#map-strip')` gates its keys (152, 176, 262).
- **tempo-sources.js:232** reads `engine.editPosition`. A cue rename must keep that property or update this call site.
- **chart.js** drives `engine.seek/loop/toggleMute/getPosition` and calls back `setLoop/clearLoop/onMixerChange`.
- **notation/audio.js** depends on `engine.revision`, `subscribeTransport`, `beatsBetween` and `setRecordingAudible`. Every one must survive the façade.

---

## 7. Practice blob v1 and save cadence

**Shape** (written at `player.js:1015` and `1026`):
```js
{ loop:   { enabled: boolean, a: number, b: number },     // engine.loop copy; b defaults to duration
  rate:   number,                                         // 0.5–1.5
  grid:   { visible: boolean, snap: boolean, division: 1|2|4 },
  tracks: [{ name: string, volume: number, muted: boolean, soloed: boolean }] }
```
- **Reader** (317-329, 252):
  - every field is optional (`p.loop &&`, `p.rate &&`, the tracks matched by `name`);
  - the grid merges over `ws.grid`;
  - the skeleton rows use the saved mute/solo before load (252-253).
- Seen legacy shapes in tests: `{rate, loop, tracks:[]}` (`convex/notation.test.ts:93`) and `{rate:1}` (`convex/sharing.test.ts:76`).
- **Not in v1:** cue/edit position, keep-pitch (device `ws.preservePitch`), view/zoom, overview (`ws.overview`), metronome (that is in `tempo`).
- **Server:** `songs.savePractice` (`convex/songs.ts:151-158`) takes `practice: v.any()`, enforces a **10 000-char JSON cap**, and is a no-op when `sameContent`.

**Save cadence:**
- `schedulePractice` debounces **600 ms** (1020). It is triggered by **any** `input`, `click` or `pointerup` on `#player-root`, plus **window `keyup`** (1021-1022).
  - So map-mode, Transcribe and chart interactions also schedule practice saves. They are skipped by the `sameContent` compare (1016).
- `flushPractice` (1012-1019) builds the blob from the engine and `grid`. It skips the save if it equals `lastPractice` (`structuredClone`d), then mutates `song.practice`. `readOnly` → no save.
- **Flushed on** `closePlayer` (cleanup 1030) and before share (`saveForShare` 1023-1029).
- **Not flushed on `pagehide` or `visibilitychange`** in the main app. There is no listener (only `shared-song.js:77` calls `closePlayer` on pagehide, and that path is read-only). Closing the tab within 600 ms loses the change. Spec §9.3 adds these flushes.
- Tempo: `persistTempo` 400 ms debounce → `saveTempo(song.id, metronome.serialize())`, flushed on cleanup (939) and in `saveForShare`.
- Test `player-ui.test.js:84-93` asserts that a server-reordered practice blob is not re-saved.

**v2 migration notes** (spec §9.3, with no compat ceremony):
- Read v1 and write v2 on the first save: `loop.enabled → loop.on`, `rate`, `tracks` as-is.
- `grid` moves to the device pref (`ws.prefs.stems`).
- `keepPitch` is seeded from `ws.preservePitch`. `cue` is seeded from 0.
- Then drop the `ws.grid`, `ws.overview` and `ws.preservePitch` reads once `prefs.js` migrates them.
- The 10 KB server cap stands until B2.

**localStorage keys touched by this subsystem:** `ws.grid` (player.js:23), `ws.overview` (83, 808), `ws.preservePitch` (317, 791), `ws.stopBehavior` (`preferences.js:6-11`, read through `returnOnStop()`), `ws.practice.view` (`launcher.js:7`), `ws.chart.scale`/`ws.chart.layout` (chart.js), `ws.tapSnap`/`ws.tapOffset` (`map-mode.js:10`).

---

## 8. Keydown bindings today

There is one `window` keydown listener (`player.js:1067-1107`, added 1107, removed in `closePlayer` 216). Precedence runs in this order:

| Step | Line | Rule |
|---|---|---|
| 0 | 1068 | Skip if `defaultPrevented` or `isComposing`. |
| 1 | 1069-1072 | **Tempo sources open:** only Esc (closes them); everything else is swallowed. (Sources handle their own keys on their root, `tempo-sources.js:254`.) |
| 2 | 1073 | Any `.metadata-modal`, `dialog[open]` or `[role="dialog"]:not(.hidden)` → ignore. |
| 3 | 1074 | Esc with `#metro-pop` open → close it, focus `#metro-btn`. |
| 4 | 1075-1077 | Space on a **pointer-activated** control (`isPointerControl`) that is not a text input → Play/Stop (no repeat). |
| 5 | 1078 | Target in input/select/textarea/contenteditable → ignore. |
| 6 | 1079 | Keyboard-focused button/link/summary/[role=button] + Space or Enter → native activation. |
| 7 | 1080 | `mapMode.handleKey(e)`. When inactive it only catches **⇧M** (enter). When active it owns ←/→ (⇧ beat, ⌥ renumber, ⌘ pin), ↑/↓ (⌥ tempo), digits + ↵/⌫ go-to-bar, Home/End, D/T (tap, calibrate), E, R, P, `*`, `/`, `,`/`.` nudge, ⌫ unpin, `?`, ⌘Z/⌘⇧Z/⌘Y, Esc/⇧M exit (`map-mode.js:562-615`; `,`/`.` use `e.code`, so ⇧ works there, unlike the player). |
| 8 | 1081 | **⇧S** (no ctrl/meta/alt) → `#grid-snap` click. This runs **before** Transcribe, so ⇧S never reaches the editor. |
| 9 | 1082 | `transcription.handleKey(e)`. In Transcribe mode it consumes **every** remaining key (`launcher.js:103`). In Chart mode it returns false. |
| 10 | 1083 | Any ctrl/meta/alt → ignore. |

Then the plain keys (1084-1105):

| Key | Action | Line |
|---|---|---|
| Space (`e.code`) | Play/Stop (`doPlayStop`); stop returns to the cue unless `ws.stopBehavior=stay`; no repeat | 1085 |
| Enter | Pause/resume (`doPlayStop({pause:true})`); no count-in on resume; no repeat | 1086 |
| `m`/`M` | Toggle the **metronome popover** (not the click itself) | 1087 |
| `g`/`G` | Grid visible toggle | 1088 |
| ← / → (`e.code`) | Seek ∓5 s (⇧: 1 s), snapped, Follow on | 1089-1090 |
| `,` / `.` | Seek ∓0.05 s (⇧: 0.01 s, but ⇧ on US layouts produces `<`/`>`, so the ⇧ branch is effectively unreachable) | 1091-1092 |
| `[` | Loop A at the snapped playhead; B = max(loop.b, t + 0.1); loop on | 1093 |
| `]` | Loop B at the snapped playhead; A = min(loop.a, t − 0.1); loop on | 1094 |
| `l`/`L` | `#loop-toggle` click (no region → loop the visible window) | 1095 |
| Home | Seek to loop A (loop on) or 0 | 1096 |
| End | Seek to B − 1 ms (loop on) or the duration | 1097 |
| `-` / `_` | Zoom out ×2 at the playhead | 1098 |
| `=` / `+` | Zoom in ×0.5 at the playhead | 1099 |
| `\` | Fit | 1100 |
| `0` | Reset mixer | 1101 |
| `1`–`9` | Toggle mute on track N (row order = stem order) | 1102-1105 |

**Other keyboard paths in the transport area:**
- `interactions.js:15-18`: capture-phase Tab resets the pointer marks.
- `map-mode.js:361` (edit-bar form) and `:555` (menu) keep their keys local with `stopPropagation`.
- `notation/editor.js:242`: the surface keydown handler.
- `tempo-sources.js:254`: its own root keydown.
- `library.js:445,656` and `auth.js:203`: outside the player.

**Inconsistencies to fix in the registry rewrite:**
- `#help` title (165) claims "←/→ seek (shift=1s)", but the default is 5 s; it omits Esc and the chart keys.
- `[`/`]` and the `#set-a/#set-b` buttons compute the opposite edge differently (1093-1094 vs 755-756).
- ⇧S is intercepted in Transcribe.
- `,`/`.` with ⇧ is dead on most layouts.
- The digit keys depend on row order, not canonical stem order.

**Spec §7.2 target** (decided; no Classic keys):

| Key | New meaning |
|---|---|
| Space | Play/Stop from loop start or cue |
| ⇧Space | Pause |
| Enter | Again |
| ←/→ | Bar (mapped) / 5 s; ⇧ beat / 1 s |
| ⌥←/→ | Cue nudge 50/10 ms |
| `[` `]` PgUp/PgDn | Sections |
| ⇧[ ⇧] | Move the loop by its length |
| I/O | Loop in/out |
| ⌫ | Clear the loop |
| `,` `.` | Speed ∓5 (⇧ 1) |
| `` ` `` | Speed 100% ↔ last |
| C / K | Count-in / Click |
| M / ⇧M | Minus me / Only me (map mode moves to `E`/Edit) |
| 1–9 / ⇧1–9 / 0 | Mute / solo / full mix |
| G, ⇧S, `=`/`−`, `\`, Z | Stems surface only |
| V, F, B, J, S, E, ⌘Z | New |

The tests at `player-ui.test.js:130-183` encode **today's** Space, Enter and stop behaviour and must be rewritten against the registry. `:171-183` especially asserts that Enter pauses.

---

## 9. Loading, errors and races (behaviour to preserve)
- **Generation guard:** a load finishing after navigation never paints (`player-ui.test.js:115-121`). The engine created for the abandoned load is destroyed through `closePlayer` (`engine = loadingEngine`, 277).
- `showLoadError` destroys `loadingEngine` and offers "Try again", which re-runs `openPlayer` (266-275; test 107-113).
- Missing signed URL → "Missing stem audio for: … Try reprocessing this song." (290-294). Signing failure → "Couldn't reach storage: …" (283). Decode → `codecErrorMessage` (310).
- Progress copy (301-305): "Loading audio · x / y MB" → "Decoding audio · n of N tracks ready" → "Preparing pitch-preserving playback…". The spec's Play ring reuses these strings.
- Play races: `startingPlayback` plus the `playAction` token (973-990), and engine `playRequest` (222-224, 247). Stop during a pending start never leaks sound (engine test 240-246).
- Shared view (`player-ui.test.js:185-193`): `resolveUrls` is called once, no `onSong`, no saves, detection disabled, cache keys namespaced.

---

## 10. Keep vs decompose (per spec §9.2 `src/stage/*`)

| Today | Verdict | Target |
|---|---|---|
| `engine.js` | **KEEP** + additions | Add `on/off` events (`wrap`, `ended`, `transport`, `statechange`), `nextWrapAt()`, `setSpeed(rate,{at})`, `setTrackGains(g,{at})`, `setLoop(…,{gapSec})` segmented path, `seekAt(target, when)` + `cancelPending()`, `ctx.onstatechange → pause()`, and explicit `setMuted/setSoloed`. Move `tickEnd` onto an internal 25 ms ticker shared with `wrap`. Keep `_schedule`, the segment model and both paths. No `ws.flags` gating (owner decision): ship them on, behind tests. |
| `metronome.js` | **KEEP** | Constructed by `transport.js` with an injected `SongMapStore`. Click modes map onto `enabled`/`countIn`. Add an every-pass count-in (gap clicks reuse `countInPlan`) and a visual-click hook (lamps). Delete `beatsForView`. Keep `serialize`'s legacy passthrough (that is reading stored data). |
| `waveform.js` | **KEEP** (peaks) | `computePeaksRange` is wrapped by `wave-render.js`, which adds a cached multi-resolution peak pyramid per buffer so the Road map, strip, stems and lanes don't rescan samples. `drawWaveform` becomes wave-render internals (hatch and outline for muted). Delete `computePeaks`. |
| `stemcache.js`, `decoded-stem-cache.js` | **KEEP** as-is | `codecErrorMessage` copy may be revised (the spec's "codec → browser advice"). |
| `onsets.js` | **KEEP** as-is | Used by map-mode taps and the Tap-the-beat sheet. |
| `timeline-navigation.js` | **KEEP** | Used by stems-surface and editor. |
| `musical-position.js` | **DELETE** (Phase 0) | Plus its test block (`playback-engine.test.js:7,92-99`). |
| `interactions.js` | **DELETE** (Phase 0) | Replaced by `dispatch.js` + slider/stepper primitives. Update `editor.js:12`, `app.js:3`, `tests/fixtures/tempo-map.js:4`, `tests/notation-demo.js:7`, `tests/interactions-ui.test.js`, and the `player-ui.test.js:26-27` harness. |
| `player-layout.js` | **DELETE** | Nothing in it survives (workspace nav, practice strip, popover close). |
| `player.js` A, E, F, G, S, T, U, V, X, AE, AF, AG | **Decompose** | `stage.js` (D, E-identity, F-mount/loading, AC, AG rAF loop, Y drum adoption, AF flushAll); `transport.js` (S, T policy, U, V, X, AG end/wrap ticker, count-in policy, quantized jump, trainer, pass counter); `practice-state.js` (G, AE, v1→v2); `hud.js` (V readouts, AG text); `controls.js` (dock and rail); `sheets/{speed,click,mix,loop}.js` (U, W, R, T); `strip.js` (replaces M, N). |
| `player.js` B, H-K, L, O-Q, R-rows | **Rebuild** | `surfaces/stems-surface.js` on pointer events plus `wave-render.js`. `snapTime`/`gridTicksForView` become a shared `grid.js` used by stems and map. |
| `player.js` C (markup), M (overview), N (practice strip), W (popover), AH (keys) | **DELETE** | Replaced by the HUD, strip, sheets and command registry. |
| `player.js` Z, AA, AB | **Move** | `src/edit/map/` (map-mode re-hosted with a geometry adapter; tempo-sources; detection). |
| `player.js` AD | **Move** | `chart-surface.js` (chart.js with `chrome:false`) and `src/edit/chart/` (editor.js). `launcher.js` is removed. |

**Suggested `transport.js` façade surface:**
- **Methods:** `play()`, `stop()`, `pause()`, `again()`, `toggleLoop()`, `loopSection()`, `setLoop(a,b,opts)`, `clearLoop()`, `cue(t)`, `jumpQuantized(t)`, `setSpeed(r)`, `setKeepPitch(b)`, `setMix(...)`, `minusMe()`, `onlyMe()`, `startTrainer(cfg)`.
- **Getters:** `position`, `cue`, `state` (`stopped`/`counting`/`playing`/`paused`), `pass`, `countIn`.
- **Events:** `subscribe(fn)`.
- **Pass-throughs for notation:** `engine`, `revision`, `beatsBetween`, `subscribeTransport`, `setRecordingAudible`.
- The edit cursor becomes **cue**. `engine.editPosition` can stay as the storage field (`tempo-sources.js:232` reads it). Alternatively rename it in one pass and update that file and the tests.

---

## 11. Risks and gotchas for the rebuild
1. **`seek` writes the cue** and **stop-in-place moves the cue** (engine 271, 282). The glass rules (no seek on touch while playing) and "Play from loop start" are transport policy over these primitives. Do not change the engine semantics that the tests pin.
2. **Count-in is cancelled by any seek, speed, pitch, loop or count-in setting change** (it pauses rather than re-targets). Again-during-count-in and quantized jump must handle this explicitly.
3. **No wrap, interruption or end events.** `tickEnd` only runs from the player rAF. Background tabs and iPad lock stall end detection. The pass counter, trainer and play-N-times all need the new ticker.
4. **Memory:** stems live as AudioBuffers (decoded LRU up to 512/128 MB, across songs) **plus** a full copy in the Signalsmith worklet (`addBuffers` slices; mono duplicated to stereo). That is roughly 2× the decoded size per open song. It matters on the iPad (R2).
5. **The waveform renderer rescans samples on every view change** (`computePeaksRange` per track per frame of zoom/pan). Road map virtualised rows plus the strip plus stems will multiply this, so a peak cache is required.
6. **map-mode.js is welded to the Tracks DOM and view model** (§6.3). It can't move to Edit · Map until stems-surface exposes `getView/setView/timeToX/redraw`, a `#map-cursor` host, a lane slot and a focus target.
7. **Mute and solo are toggle-only**, so restore, undo and Minus me need idempotent setters. Mute/solo state is reflected into DOM rows by `onMixerChange` (1008) from chart.js and editor.js; a store-driven mix replaces that.
8. **Practice saves fire on every click, input, pointerup or keyup anywhere in the player**, with no pagehide/visibility flush. v2 must add the flushes and stay under the 10 000-char server cap (`convex/songs.ts:155`) with spots and markers.
9. **The tempo blob carries `detected` beats for back-compat** (`metronome.js:63-64`) on every save. The owner decision drops compat UI, not this data, but with no older desktop clients to protect, `serialize` can stop writing `detected`/`map` for non-legacy maps. That is optional; confirm before changing the stored shape.
10. **Tests pinned to today's DOM:** `player-ui.test.js` (ids §6.1), `map-mode.test.js` (`#map-strip`, `#metro-btn`, `#m-countin`), `sharing-ui.test.js`, `tests/fixtures/tempo-map.js`, `tests/fixture/capture.cjs` and the probes (`#play`, `#time`, `#timeline-interact`, `#loop-readout`, `#metro-btn`, `#m-*`, `#map-btn`, `#grid-division`, `#help`). All must be rewritten alongside the Stage. The engine tests (`playback-engine.test.js`) stay and grow.
11. **Dead code to drop during decomposition:**
    - `engine.toggle`, `Metronome.beatsForView`, `waveform.computePeaks`;
    - `metronome.source` (read in `entry.js:21`, never set);
    - `#m-bpm`/`#m-sig` labels (`player-layout.js:33`);
    - the double cleanup loop (`player.js:217-218`);
    - the `#help` title tooltip.
12. **`stopPlayback` (738-742) re-anchors the view after a stop** so the cue is visible. In the Stage that becomes "scroll so the cue sits at the follow position" (§4.12 step 4).
