# Tempo and meter mapping

Status: built for 1.6.0. The proposal below is kept as written. The final section records the decisions and what shipped.

## Intent

Mapping a song's tempo and time-signature changes should be fast, keyboard-centric and calm. That holds whether the band played to a click or not. Today it means clicking to a bar, adding a change, and stepping a BPM value up and down until the grid happens to line up. The metronome, count-in, grid and snapping keep working as they do now. What changes is how the map gets built and corrected.

This proposal sets the shape of the workflow and the model underneath it. It leaves layout, exact key assignments and edge-case behavior to be settled with a prototype.

## What makes it slow today

Read from the current source (`src/js/metronome.js`, `src/js/player.js`, `src/js/notation/editor.js`):

- **The user has to search for the tempo.** A manual section is `{t, bpm, beatsPerBar, unit}`, and the grid comes from the BPM. You have to find a BPM that keeps beats on the audio for the whole section.
- **BPM is an integer.** `normSection` rounds it. A song at 117.6 BPM cannot line up across a long section with any value you try, which is a likely source of the "floating around" experience.
- **Edits target "the section under the playhead."** Bars are reached by seeking, and changes are made with popover buttons and ±1 nudges. Tap tempo is a mouse button and moves the section start to the first tap.
- **There are three timing systems:**
  - manual sections;
  - the BeatNet beat list, corrected by dragging individual beats with the mouse;
  - the Transcribe timeline, made of bars and anchors.

  Once a drum part exists, Transcribe locks the metronome map. Its "Align beat…" dialog asks for a recording time typed in seconds.
- **Tempo edits can't be undone.**
- **The beat unit is ambiguous.** Clicks advance by `60 / bpm` and ignore `unit`, so whether 6/8 runs in quarters or dotted quarters is undefined. The notation plan already flagged this.

## What other tools do

Pro Tools (Identify Beat, Bar|Beat markers), REAPER (create measure from time selection, SWS marker conversion), Logic (Smart Tempo hints, Beat Mapping), Ableton (warp markers), Transcribe!, osu!, Cubase (Time Warp), Melodyne, Capo and Sonic Visualiser all converge on a few ideas:

1. **You place bar lines on the audio and the tempo is derived.** Pro Tools, Ableton warp markers, the Cubase Time Warp tool and the Melodyne tempo editor all work this way. Moving one anchor re-solves only its neighbors' tempos; everything else stays put.
2. **Two known points solve the tempo.** Pro Tools Identify Beat and REAPER "create measure from time selection": mark two downbeats, say how many bars lie between them, and the tool computes BPM.
3. **Tap during playback, then clean up.** Transcribe! uses M/B keys, Logic uses D (downbeat) and T (beat) hints, and Capo has "record downbeats". Taps are coarse and always refined afterwards.
4. **Leapfrog, then refine.** Pin every 4–8 bars, then add pins only where the playing drifts.
5. **Meter is attached to a bar, and detectors don't infer it.** Logic only finds meter changes you hint, and REAPER flags truncated measures. The person supplies meter; the tool supplies precision.
6. **Half and double fix-ups for detected tempo.** Live and Logic have ×2/÷2; Cubase adds 4/3 and 3/4.
7. **Check by ear at slowed speed, near the end of a span,** where error accumulates. This is the osu! method.
8. **Precise keyboard moves:** arrow nudges with modifier step sizes, jump to next/previous marker, and edit the nearest marker.

Woodshed has an advantage most of these tools lack: separated stems. The drum stem is a clean, transient-rich reference for where beats actually land.

## The core idea: pin bars, don't search for tempo

Replace "a list of tempo sections" with **one song map: a run of bars, some of whose bar lines are pinned to moments in the recording.**

- **Bars carry meter** (numerator, denominator, optional grouping such as 2+2+3) and an optional label (Verse, Chorus…). A meter applies from its bar until the next change.
- **Pins are the truth.** A pin says "this bar line, or this beat, happens at this time in the audio." Editing meter, renumbering or adding pins never moves an existing pin.
- **Tempo is derived.** Between two pins, beats are evenly spaced, so the span has one exact tempo, displayed to two decimals. After the last pin the last tempo continues. Before the first pin it extends backward, which handles pickups and count-ins.
- **A typed tempo is only for open spans.** With one pin, or after the last pin, you can enter a BPM as a starting guess. Once a later pin exists, the BPM is a readout.

This turns "find 117.6 BPM" into "put bar 97 on the hit at 3:12." The BPM you were hunting for falls out exactly. Meter mistakes become visible: if a span reads 117.98 BPM and its neighbors read 117.6, that span has a miscounted bar.

This is the bars-and-anchors model already in `shared/notation.ts` (`Timeline`: measures with stable IDs, rational positions, grouping, partial bars, labels, interpolated anchors). The proposal promotes it from "the drum part's timing" to "the song's timing."

## Map mode

**Shift+M** (beside M for the metronome) enters Map mode, a keyboard scope over the waveform like the Transcribe surface. Keys it consumes never reach the player handler, so digits don't mute stems and `,` `.` don't nudge the playhead. **Esc** leaves. Entering Map mode turns the click on and shows the grid; leaving restores both.

There is one **selected bar line**, the cursor. The playhead follows it when stopped, and the view keeps it in sight.

| Key | Action |
| --- | --- |
| ← / → | Previous / next bar line |
| Shift+← / → | Previous / next beat |
| Cmd/Ctrl+← / → | Previous / next pin or meter change |
| Digits, then Enter | Go to bar N |
| Space / Enter | Play/stop, pause (unchanged) |
| **D** | Pin a downbeat at the playhead. When stopped, pins the nearest bar line; during playback, taps (see below) |
| **T** | Same, for a beat |
| `,` / `.` | Nudge the selected line earlier / later by 10 ms (Shift: 1 ms), pinning it |
| Alt+← / → | Renumber the selected pin to the previous / next bar, keeping its time and re-solving tempo |
| ↑ / ↓ | One more / fewer beat in this bar's meter, from here to the next change |
| E | Inline editor at the cursor: meter, grouping, open-span BPM, label. Tab between fields, Enter commits |
| Delete | Unpin. The line falls back to interpolation |
| `*` / `/` | Double / halve the beats in the current span |
| P | Preview loop: one bar before the cursor to one bar after, with click. **It follows the cursor**, so ← → steps the loop through the song |
| Cmd/Ctrl+Z, Shift+Z | Undo / redo; each key press or tap pass is one step |

The assignments are provisional. D and T follow Logic's tap hints and the D the player already uses for downbeats. They need a conflict check against Transcribe, whose drum letters include D and T. Map mode should take precedence while active.

**Status strip.** A single line shows where you are and what the last action did, e.g. `Bar 33 · 7/8 (2+2+3) · span 29–41: 117.62 BPM · pinned 1:12.348`. After a renumber or meter change it shows the before → after tempo.

**Map lane.** The existing tempo-flag strip above the waveform becomes a lane with three elements:
- bar numbers;
- meter changes;
- pin handles, with each span's tempo between them.

Spans whose tempo jumps sharply from their neighbors are tinted as likely miscounts. Pointer editing (dragging a pin) still works, but nothing requires it.

## Three ways in

### Recorded to a click (two pins)

1. Shift+M. Play, then press **D** on the first downbeat, or stop on it and press D. Bar 1 is pinned.
2. Press **End** or jump to the last clear downbeat near the end, and press **D**. Woodshed pins the bar line nearest the playhead under the current guess and shows `Bar 97 · span 1–97: 117.98 BPM`. If the count is off, **Alt+← / →** renumbers it and the tempo re-solves.
3. Step to each meter change with ← →, press ↑ / ↓ or E, and watch the span tempo settle back to a round value.
4. Press **P**, slow playback to 50–75%, and spot-check late bars.

A typical click-track song is done in under a minute with no number entry.

### Not to a click (tap through, then refine)

1. Shift+M, put the cursor on bar 1, and play, at reduced speed if you like.
2. **Tap D on every downbeat.** Each tap pins the next bar line. Tap T as well to pin beats where the playing breathes. A pass overwrites existing pins in the range it covers and is one undo step. You can start a pass from any bar to redo a section.
3. **Refine bar by bar:** P to loop the cursor bar, `,` `.` to nudge, → to the next bar. The loop follows.

Two details make taps usable as data rather than rough hints:

- **Latency compensation.** Subtract the audio output latency and a personal tap offset, measured once by tapping along to the click.
- **Snap taps to the drum stem.** Move each tap to the nearest onset in the drum stem within about ±40 ms. Raw taps stay one keystroke away. Onset detection on a single stem is a cheap client-side calculation.

### From beat detection

"Detect beats" stops being a separate editing world. BeatNet output becomes pins at detected downbeats, with meter inferred from beats per bar where it is consistent. Everything else is corrected in Map mode: ×2/÷2 for double-time detection, ↑ / ↓ for meters it missed, and nudges for stray downbeats. Later, "detect from here" re-runs detection for the span after the cursor, following Ableton's Warp From Here.

## Also in scope

- **Decimal tempo everywhere,** displayed to 0.01 BPM.
- **An explicit beat unit.** The click follows the meter's grouping, so 6/8 clicks two dotted quarters, and BPM is shown in that pulse. The notation model already has `beatGroups`.
- **Simplify** (later). Remove pins that don't change the grid by more than a few milliseconds, collapsing a tap pass over a clicked song into a handful of constant spans, like Melodyne's Make Tempo Constant.
- **Ramps** (later). A per-span "gradual" flag for accelerando or ritardando between two pins, like REAPER's gradual transition. The data model should leave room for it.

## Model and migration

- **The song map is a `Timeline`.** The metronome reads beats from it. The separate `map` and `detected` lists go away after migration.
- **Migration preserves audio positions:**
  - a manual section's start becomes a pin, and a pin at the next section's start fixes its tempo;
  - detected beats become downbeat pins plus inferred meter;
  - nothing a person hears today should move.
- **Practice settings stay on the metronome.** On/off, volume, accent, count-in and pre-roll are unchanged. The popover keeps these plus "Map tempo (Shift+M)" and "Detect beats".
- **The drum part shares the song map** (see the first decision below). Map edits then move notes in time with the bars, which is what a correction should do. Notation edits still never change the map. "Align beat…" and "Bar properties…" in Transcribe open Map mode at the cursor instead of a seconds dialog.
- **Limits.** `MAX_MEASURES` (512) and the anchor cap (8192) need checking against a tap pass that pins every beat of a long song.

## Decisions and what shipped (1.6.0)

- **One global song map.** The metronome, grid, snapping, bar readout and drum parts all read the same map (`shared/song-map.ts`, `src/js/song-map.js`). A drum part's timeline is derived from it. A song without a saved map adopts its existing drum part's timing, which is what Transcribe already used. Map edits that would leave written notes outside their bar are refused with the bar number. Transcribe's Bar properties and Align beat commands open Map mode.
- **Tapping follows ordinary tap tempo: tap every beat.** In Map mode during playback, **T** pins the next beat, starting at the selected line. **D** pins the next bar line, skipping any beats left in the bar, which keeps the bar count in sync. Stopped, D/T pin the nearest bar line or beat to the playhead. A tapping pass is one undo step. Taps subtract output latency, input-event delay and a calibrated personal offset (Calibrate taps). By default they snap to the nearest drum-stem onset within 40 ms (`src/js/onsets.js`).
- **Ramps are supported.** **R** makes the span between two pins a gradual tempo change. Tempo is linear in musical position. A ramp starts from the tempo before it, or for the first span lands on the tempo after it. The end tempo is solved so that both pins hold. Drum-part timelines approximate ramps with an anchor every eighth note.
- **Shift+M** enters Map mode. The scope takes precedence over the player and the Transcribe surface while active.
- **Additions beyond the proposal:**
  - Shift+↑/↓ changes a single bar's beat count.
  - Alt+↑/↓ adjusts the open tempo after the last pin.
  - Home/End go to the first or last bar.
  - Clicking the waveform selects the nearest line.
  - Pins can be dragged.
  - Preview taps (D/T while the loop plays) re-pin the nearest line.
- **Storage.** `song.tempo.songMap` holds `{version:1, measures, pins:[{position, time, ramp?}], tailQpm?}`. Each save also writes the map's pulses in the pre-1.6 `detected` shape, so older desktop builds keep the same clicks. An untouched pre-1.6 map is saved unchanged. The bar limit rose from 512 to 1024.
- **Not built yet:** Simplify (thin pins on clicked songs) and re-detecting from the cursor onward.

## Phases (original plan)

1. **Model.** Song map on `Timeline`, migration, decimal tempo, undo. The metronome and grid read from it; the visible UI is barely changed.
2. **Map mode core.** Cursor navigation, D/T pin, nudge, renumber, ↑ / ↓ meter, the E editor, the status strip and lane, and the follow-the-cursor preview loop.
3. **Tapping.** Tap passes, latency calibration and drum-stem onset snapping.
4. **Detection and cleanup.** Beat detection seeds pins, ×2/÷2, simplify.
5. **Transcribe.** Shared map; Align beat and Bar properties route to Map mode.
