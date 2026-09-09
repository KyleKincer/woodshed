# Drum transcription implementation and review guide

The approved scope includes all three design concepts: integrated staff, expanded score, and drum lanes with a linked staff preview. This branch implements those workflows for manual transcription against an existing recording. It has not been deployed or published as a desktop release.

## What is implemented

- A lazy-loaded Transcribe workspace in the existing song player, with system-aware light and dark styling and the existing transport.
- Stationary keyboard entry, named/remappable drum pads, Select / Write / Preview, two independent voices, whole through 64th durations, dots, 3:2 / 5:2 / 7:2 tuplets, explicit and derived rests, accents, ghosts, flams, sticking and velocity.
- Exact rational note addresses, stable measure IDs, variable-tempo alignment, beat anchors, compound/odd-meter grouping, pickup setup, partial measure lengths, section labels and review coverage.
- Note selection, multi-selection, note or whole-bar copy/paste, independent repeated passages, deliberate note movement, collision rejection and undo/redo. Editing does not ripple later notes or alter the recording.
- Staff, expanded score and lanes use the same score and commands. Staff noteheads have leading/trailing engraving space inside barlines; click targets and the moving notation cursor use the same geometry. Waveform bar boundaries stay aligned to the recording. Lane markers stay on their beat grid, as expected for an event view.
- A single AudioContext and engine segment scheduler for recorded stems, metronome and notation. Recording / Notation / Both, notation volume, drum-stem mute, preview, hat choke, loop/rate/seek cancellation, count-in and audible pre-roll are integrated. Kit sounds are deterministic local synthesis, not a sampled acoustic drum library.
- Local IndexedDB journaling, serialized acknowledged revisions, idempotent retry, conflict protection, recovery export, and a warning only when a page close could interrupt the local journal. Opening an owned part currently requires a successful authenticated server read; network loss after opening retains edits locally.
- Typed, owner-checked Convex score/chunk storage with bounded updates, song-deletion cleanup, read-only public viewing, default-on notation inclusion, and independent recipient copies captured at import start. Public viewers subscribe to notation updates and inclusion changes.
- Lossless `.woodshed.json` import/export, notation in full-library exports, and print/browser Save as PDF. Untouched measures remain visibly untranscribed; reviewed empty measures show a whole-bar rest.

## Quick review

Open a song and choose **Transcribe → Create drum part**. Confirm the first downbeat, meter and the note value represented by the tempo pulse. For 6/8 counted in two, choose dotted quarter as the tempo beat unit. Follow existing beats when their pulse interpretation is known; otherwise begin with a steady map and refine it using Align beat / Align / meter.

| Action | Keyboard / control |
| --- | --- |
| Write / select | N / Escape |
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

Copy acts on selected notes when a note selection is active, and on whole bars after bar-header selection. Paste notes at the edit cursor. Whole-bar paste/repeat asks for the destination and requires explicit replacement when authored notes already exist. Alt-arrow movement uses the current duration and rejects collisions atomically.

## Validation completed

- 148 Vitest tests pass, including musical timing, engraving geometry, note movement, interrupted-save replay, ownership, share exclusion/revocation/deletion, coherent import snapshots and library export.
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
