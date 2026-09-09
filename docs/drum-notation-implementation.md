# Drum transcription implementation and review guide

The approved scope includes all three design concepts: integrated staff, expanded score, and drum lanes with a linked staff preview. This branch implements those workflows for manual transcription against an existing recording. This document records the implementation review before web publication; GitHub/Vercel track deployment status. Desktop publication is separate.

## What is implemented

- A lazy-loaded Transcribe workspace in the existing song player, with system-aware light and dark styling and the existing transport.
- Stationary keyboard entry, named/remappable drum pads, unified selection and entry, optional pad audition, two independent voices, whole through 64th durations, dots, 3:2 / 5:2 / 7:2 tuplets, explicit and derived rests, accents, ghosts, flams, sticking and velocity.
- Exact rational note addresses, stable measure IDs, variable-tempo alignment, beat anchors, compound/odd-meter grouping, pickup detection, partial measure lengths, section labels and review coverage.
- Note selection, multi-selection, note or whole-bar copy/paste, independent repeated passages, deliberate note movement, collision rejection and undo/redo. Editing does not ripple later notes or alter the recording.
- Staff, expanded score and lanes use the same score and commands. Staff noteheads have leading/trailing engraving space inside barlines; click targets and the moving notation cursor use the same geometry. Waveform bar boundaries stay aligned to the recording. Lane markers stay on their beat grid, as expected for an event view.
- A single AudioContext and engine segment scheduler for recorded stems, metronome and notation. Recording / Notation / Both, notation volume, drum-stem mute, preview, hat choke, loop/rate/seek cancellation, count-in and audible pre-roll are integrated. Kit sounds are deterministic local synthesis, not a sampled acoustic drum library.
- Local IndexedDB journaling, serialized acknowledged revisions, idempotent retry, conflict protection, recovery export, and a warning only when a page close could interrupt the local journal. Opening an owned part currently requires a successful authenticated server read; network loss after opening retains edits locally.
- Typed, owner-checked Convex score/chunk storage with bounded updates, song-deletion cleanup, read-only public viewing, default-on notation inclusion, and independent recipient copies captured at import start. Public viewers subscribe to notation updates and inclusion changes.
- Lossless `.woodshed.json` import/export, notation in full-library exports, and print/browser Save as PDF. Untouched measures remain visibly untranscribed; reviewed empty measures show a whole-bar rest.

## Quick review

Open a song and choose **Transcribe**. A new draft opens directly from the existing beat map, retaining the exact downbeat and pulse timestamps. Nothing is saved until an edit is made. Existing parts keep their stored timing. Meter, grouping and alignment remain available under **••• → Bar properties / Align beat**.

| Action | Keyboard / control |
| --- | --- |
| Add current drum / clear selection | N / Escape |
| Add simultaneous hits | Drum letters; cursor stays put |
| Advance / retreat | Right / Left Arrow |
| Choose duration | 1–7, shortest to longest; + shortens, − lengthens |
| Dot / triplet | Period / slash |
| Rest | R |
| Accent / ghost | A / G |
| Play/stop / pause | Space / Enter |
| Move selected notes | Alt + Left/Right, or Move… |
| Copy / paste / repeat bars | Cmd/Ctrl+C / V / D |
| Undo / redo | Cmd/Ctrl+Z / Shift+Z |
| Select bars | Click a bar header; Shift-click extends |

Pointer-operated tools return focus to the editor. Keyboard-focused controls retain their normal semantics, and Tab exits the editor. The optional note list exposes individual notes with descriptions for keyboard and assistive access.

Copy acts on selected notes when a note selection is active, and on whole bars after bar-header selection. Paste notes at the edit cursor. Shift-click bar headers to extend a whole-bar selection. Whole-bar paste/repeat asks for the destination and requires explicit replacement when authored notes already exist. Alt-arrow movement uses the current duration and rejects collisions atomically.

## Validation completed

- 149 Vitest tests pass, including musical timing, engraving geometry, note movement, interrupted-save replay, ownership, share exclusion/revocation/deletion, coherent import snapshots and library export.
- Audio scheduler tests cover repeated loop boundaries without duplicate hits or accumulated drift, immediate cancellation on rate/seek/stop, first-preview continuity, and hi-hat choke scheduling.
- TypeScript backend/shared-model check and production Vite build pass.
- 26 existing desktop tests pass. The desktop CSP now explicitly allows the bundled font data URLs; scripts remain under the existing policy.
- Browser review used the actual editor and engine with an isolated development fixture: entry, expressions, selection, view switching, dark mode, dialogs barline spacing, compound-meter setup, and a triplet pickup. Bundled fonts were confirmed loaded under the desktop CSP. The fixture uses in-memory persistence and synthetic audio. It does not substitute for a live authenticated Convex or installed Electron end-to-end test.

The editor is a separate lazy chunk (approximately 0.78 MB minified / 0.41 MB gzip, including Bravura). The ordinary player does not fetch it until Transcribe opens. Vite reports the expected large-chunk advisory for this engraving bundle.

## Before a public release

Deploy the additive Convex schema/functions and run generated API/type checks against that configured deployment. This workspace has no `CONVEX_DEPLOYMENT`, so authenticated live persistence and production deployment were not performed. Review a real song save/reopen, an anonymous shared link, and Add to library on that environment before publishing binaries.

Run musician review on the supported desktop platforms, including real audio output, dense passages, printing, VoiceOver/NVDA, and small-screen layouts. The 50 ms editing / 30 ms audition targets in the research plan are goals, not measured guarantees. VexFlow is the implemented renderer; a comparative alphaTab benchmark was not completed.

The first version supports one drum part per song, 512 measures, 256 hits per measure and 16,000 total hits. Nested tuplets, rolls, advanced marching notation, real-time collaboration, MIDI/MusicXML/GP5 interchange, and standalone composition remain future work. A lossless Woodshed document is the current interchange format. These are outside the three approved interface concepts' core manual-transcription flow.

## Local development fixture

`npm run dev:web` serves `/tests/notation-demo.html`. It uses the real workspace with an injected in-memory store, a synthetic recording and the native playback path. It performs no account writes. The fixture is not an input to the production Vite build. HTTP preview environments do not expose AudioWorklet, so pitch-preserving DSP is covered separately by the existing audio tests.

## Separate web and desktop publication

The web feature can ship ahead of desktop 1.5.0. Desktop serves its bundled UI, and the shared backend change adds tables and optional fields without removing or requiring new arguments on existing APIs. A compatibility regression test exercises the 1.5 request shapes for tempo saves, practice saves and share creation: notation and its inclusion preference remain intact.

Desktop 1.5.0 cannot display, edit or export the new notation; use the web for those actions until desktop is updated. Normal desktop practice edits preserve the score and its separate alignment.

The Vercel integration publishes pushes to main. Its configured build command deploys Convex and builds the web client with the deployment URL. The desktop workflow runs on version tags, release branches or explicit dispatch, so merging this feature to main does not publish installers or alter updater feeds.


## Web UX iteration: direct entry and lane editing

The setup modal is removed, including the HTML numeric-step constraint that
rejected its own high-precision downbeat. Duration and expression commands act
on selected notes immediately after entry. Moving to an empty cursor position
sets up the next note. There is no global Select/Write mode.

- Click an empty position or an existing note to select and seek, even while playing.
- Double-click empty space to add; in lanes, double-click a hit to delete it.
- Staff double-click on an existing note opens Properties.
- Drum keys enter at the cursor. `S` is Snare in Transcribe; waveform Snap is `Shift+S`.
- Lane blocks display written duration. Drag the body in time or between drums;
  drag its right edge to resize to a written value. A gesture is one undo step.
- Drag empty space to select multiple notes; Shift-click toggles a note in the selection.
- Lane arrow keys move selected notes; without selection they move the insertion cursor.
- The lane grid is independent of note duration, with straight and triplet subdivisions.
- Independent drums can have overlapping durations. Same-drum collisions and
  explicit rests still validate atomically; edits cannot silently discard notes.
- The two persistent tool rows contain views, duration, undo and navigation.
  Kit, Properties and Listen are collapsible. File, bar and repeat commands are
  in the overflow menu. Staff preview in lanes is optional.

### Reference decisions

[MuseScore's interface documentation](https://handbook.musescore.org/navigation/the-user-interface)
describes a persistent note toolbar, optional side panels, and a small status bar.
Its [percussion panel](https://handbook.musescore.org/idiomatic-notation/percussion/inputting-percussion-notation)
provides direct pad entry, an audition option, and shortcut conflict detection.
MuseScore itself retains note input modes; removing the global switch here is a
Woodshed adaptation, not a claim about MuseScore's behavior.

Visual review also used the [MuseScore 4 screenshot](https://commons.wikimedia.org/wiki/File:MuseScore_4_in_dark_mode.png): a thin note toolbar, tabbed left panels, collapsible palette groups and a separate optional keyboard panel. Handbook text supplied the current percussion behavior; the official video loaded captions but its video frames stalled here.

The [GP5 manual](https://static.guitar-pro.com/gp5/GuitarPro_EN.pdf), particularly
its Main Screen and Adding Notes pages, supports cursor-based selection and
changing note duration at that cursor. Its screenshot shows a large score region
with compact movable toolbars and a separate track overview.

[Ableton's MIDI editor manual](https://www.ableton.com/en/manual/editing-midi/)
provides the lane reference: double-click entry, note selection, dragging,
resizing, and grid settings separate from note properties. Woodshed retains its
musical fractions and shared recording clock underneath these interactions.

Validation adds direct workspace interaction tests, exact-timing initialization,
lane transactions, and backend round trips for independent drum durations. No
schema migration or desktop release is required; desktop 1.5 request compatibility
continues to be covered by the existing backend test.
