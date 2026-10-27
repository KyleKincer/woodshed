# Drum notation: model, engraving, chart and editor

Woodshed writes drum parts the way Guitar Pro and Songsterr do, and shows them
as a rehearsal chart that follows the recording. This document describes the
version 2 design. It replaced hand-placed VexFlow staves whose spacing followed
audio time, and whose notes each carried an authored duration.

## Why version 2

Version 1 stored a written duration, dot and tuplet on every hit, and placed
noteheads proportionally to audio time. Imports had to guess durations from
MIDI gates, a beat could mix values that no engraver would write, and a tuplet
number appeared over every note whose neighbours did not happen to form a
complete group. Dense parts (for example triplet-feel metal) became unreadable,
and the score view was several clicks deep, paginated, and not meant for
reading while playing.

## Model (`shared/notation.ts`)

- A **hit** stores only *when* it sounds (an exact fraction of a quarter note
  from its bar's start) and *how* it is played: kit piece, accent, heavy
  accent, ghost, flam, drag, roll (tremolo slashes), sticking, velocity and
  voice (hands 1, feet 2).
- A **bar** may hold explicit **tuplets** `{start, length, count, voice?}` for
  rhythms the automatic grid cannot infer, such as quarter-note triplets across
  two beats.
- `score.layout` is `combined` (default: one rhythm for the kit, as Guitar Pro
  and Songsterr write it) or `split` (hands stems up, feet stems down).
- The **kit** has 27 pieces matching Guitar Pro 7 percussion articulations:
  china, splash, two crashes and their chokes, open, half-open and closed
  hi-hat, ride, ride edge, bell and choke, cowbell, five toms, snare, rimshot,
  cross-stick, kick and pedal hi-hat. The original 11 ids are unchanged.
- Version 1 parts upgrade on read (`upgradeScore`, `upgradeBar`): durations and
  explicit rests are dropped and positions kept.

## Engraving (`shared/engrave.ts`)

Written rhythm is derived, deterministically, for every source:

1. Each bar is divided into rhythm cells, one per counted beat of its meter
   grouping (dotted beats in compound meters), carved further by explicit
   tuplets. Pickup and partial bars use only their real length.
2. Each cell is written on the coarsest grid that contains all its onsets.
   Binary grids are plain notes. 3, 5, 7 and similar grids become one bracketed
   tuplet per cell. Grids of 6 and 12 per beat are written as triplets per half
   or quarter beat, as Guitar Pro does.
3. Outside tuplets a note lasts until the next onset in its voice, never across
   a beat. Inside tuplets each note is one grid step followed by rests, so the
   grid stays visible. Rests are beat-aligned. Drums are never tied.
4. Empty or single-note beats merge into half-bar and whole-bar values.

`validateBar` runs the engraver in both layouts, so a position that cannot be
written is refused at entry, import and save.

## Rendering (`src/js/notation/alphatab-score.js`, `score-view.js`)

The engraved bars become an alphaTab score (a percussion staff with GP7
articulations, neutral clef, sections, tempo marks, beaming rules for grouped
meters, graces for flams and drags, tremolo for rolls, sticking as lyrics).
alphaTab lays out and draws it; it is already the library behind Guitar Pro
import. The score view adds an overlay beneath the notes for the playing bar,
beat cursor, loop range, selection and edit caret, and maps pointer positions
back to bars, beats and hits.

Notes on alphaTab 1.8.4: workers are disabled (Vite does not emit its worker),
the Bravura font is passed explicitly with `smuflFontSources`, every bar has the
same number of voices, and note bounds are enabled for hit testing. The engine
is a lazily loaded chunk (about 1.2 MB, 270 KB gzipped) and is fetched only
when a chart or the editor is shown.

## Practice chart (`chart.js`)

When a song has a drum part, Practice opens to **Chart**; **Tracks** shows the
stems. The choice is remembered per device.

- The playing bar is highlighted with a beat cursor; the playing line is kept in
  the upper third. Scrolling by hand pauses follow until Follow is pressed.
- Section chips (from tempo-map labels, or Guitar Pro sections) jump to a
  section; Loop section loops the section that is playing.
- Tap a bar to play from its nearest beat. Drag across bars to loop them. On
  touch, long-press the first bar and tap the last.
- Notation size, Together / Hands & feet, and Mute drums are one tap away.
- Defaults: 110% on laptops and 90% on narrow screens (two dense bars per line
  on an iPad in portrait). Controls grow on touch screens.

## Transcribe (`editor.js`)

The editor shares the part with the chart (`part.js`), so edits show in
Practice immediately.

- **Score** is the engraved part. The cursor moves by a step (1–7 for quarter
  to sixty-fourth, `/` cycles triplet, quintuplet, sextuplet and septuplet
  steps); drum keys write at the cursor; R skips a step; A, Shift+A and G toggle
  accent, heavy accent and ghost. Click places the cursor or selects a note;
  double-click writes the piece on that staff line; drag selects.
- **Drum lanes** is an event grid aligned with the waveform, one row per kit
  piece in use (or every piece). Notes are onsets; drag moves them in time or
  between drums.
- Kit pads are grouped by family. Properties covers accents, ghost, flam, drag,
  roll, sticking, velocity and voice. *Tuplet on this beat…* sets or clears an
  explicit tuplet. Copy, paste, repeat, move, review, alignment, import,
  export, print, shortcuts and the accessible note list are in the menu.

## Imports (`import-drums.js`, `guitar-pro-import.js`)

- **Guitar Pro** drums are read from the score model in playback order
  (repeats expanded), keeping articulation, accents, ghosts, flams, drags,
  rolls, tuplets and section names. A Guitar Pro tuplet is kept only where the
  automatic grid would write something different.
- **MIDI and Clone Hero charts** map General MIDI notes to the kit (china,
  splash and the second crash are no longer dropped).
- Every source is quantized per beat: exact positions stay exact; a performance
  is snapped to the simplest grid within tolerance, so a beat never mixes
  sixteenths and triplets because of timing.
- When a tempo map is applied, section labels the user wrote are kept unless
  the source names that bar.

## Storage and compatibility

- Convex validators accept version 1 and version 2 headers and hits. Rows that
  an update did not touch may stay version 1 and are upgraded by clients.
- An older client that tries to save version 1 bars over a version 2 part gets
  `NOTATION_UPGRADE_REQUIRED` and nothing changes; desktop releases before this
  change can still open and edit parts that are still version 1.
- Local journals, `.woodshed.json` files and library exports from version 1 are
  upgraded on read. New exports are envelope version 2.

## Development fixture

`npm run dev:web` serves `/tests/notation-demo.html`: the real launcher, chart
and editor with an in-memory part, a synthetic recording and a synthetic drum
part (`tests/fixtures/drum-score.js`) covering sections, accents, ghosts, flams,
sticking, triplet feel, a china, a splash and a choke. Query parameters:
`theme=dark`, `seek=<seconds>`, `view=transcribe`, `empty`, and
`score=local` (loads `tests/local/vsor-score.json`, ignored by git, for checks
against a real part).
