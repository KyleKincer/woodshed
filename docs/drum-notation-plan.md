# Woodshed drum notation

## Recommendation

Add a **Transcribe** workspace inside each song. Its primary surface is a keyboard-driven percussion staff beside the audio being transcribed. Begin with manual transcription of existing recordings, with a compact drum palette, a persistent rhythmic cursor, and immediate audition. Preserve Woodshed's existing transport, stem mixer, loop, count-in, and playback-rate behavior.

The first release should let someone transcribe a real passage, compare it with the recording, correct it, reuse it, save it safely, and share it. A complete score-writing application, automatic drum transcription, and standalone composition are later projects. The architecture should accommodate other instruments without exposing that complexity in the initial drum workflow.

Use GP5 as a reference for fast, predictable editing and MuseScore Studio as a reference for discoverability, explicit input state, and contextual controls. The proposed default is a new Woodshed workflow, not an exact shortcut clone. Musical notation remains the primary view. A named-lane view can later provide another way to inspect and edit the same musical events.

**The decisive product constraint:** a recording has a fixed timeline. Routine notation edits must never move the audio, silently shift later notes, or rewrite the established tempo map. The editor needs musical positions and an explicit mapping to recording time.

This document records the research and original plan. Kyle subsequently approved the milestone and all three visual concepts, including drum lanes, for implementation in the same feature. See [implementation status and review guide](drum-notation-implementation.md) for the code now present and remaining release checks. The three accompanying visual concepts guide layout; their generated noteheads, rhythms, bar labels, and waveform alignment are illustrative rather than authoritative specifications. The behavior and acceptance criteria below take precedence over visual artifacts in those images.

## 1. Research findings

### GP5: the useful workflow foundation

The original Windows and Mac manuals were located through Arobas's official legacy-download page. Relevant Windows-manual sections are printed pages 10, 15–19, 31–38, 41–48, and 79–81. These are documentation-based findings; the legacy application was not executed. [1,2]

| GP5 behavior documented in the manual | Design implication for Woodshed |
| --- | --- |
| Clicking selects the editing position without entering a note. | Make navigation safe; expose writing explicitly. |
| Arrows navigate; numbers enter notes; plus/minus change duration. | Keep repeated entry at the keyboard. |
| Drum numbers represent MIDI sounds; six tab rows permit simultaneous sounds. | Preserve efficient hit entry without requiring fake strings. |
| The percussion assistant previews and inserts sounds. | Provide named, audible kit controls with shortcut labels. |
| Two voices are edited separately; the inactive voice can be subdued. | Support independent rhythmic layers without mandatory voice management. |
| Paste offers replacement, insertion, and repetitions. | Make passage reuse efficient; default to replacement over fixed audio. |
| Bar-duration feedback and repair tools identify incomplete measures. | Show rhythmic validity separately from transcription completeness. |
| Screen layouts, markers, looping, and speed training support navigation and practice. | Keep score work integrated with the practice transport. |

These facts support the proposed interaction principles; they do not establish that every legacy shortcut or limitation should be retained. [1]

### MuseScore: modernization lessons

MuseScore 4's release announcement describes an interface and engraving overhaul, a more useful Properties panel, a customizable input toolbar, and improved keyboard navigation and screen-reader support. The lesson for Woodshed is that visual refinement, editing behavior, and notation quality need to develop together. A polished shell cannot compensate for unstable selection or unreadable rhythms. [3]

The particularly relevant percussion redesign arrived in **MuseScore Studio 4.5**, rather than in the initial 4.0 release. It introduced an accessible drum-pad panel, visible keyboard/MIDI assignments, configurable pad layouts, and entry at the cursor position. [4]

The current handbook separates **Write** from **Preview**, supports named pads and customizable shortcuts, and describes staff-entry previews. Woodshed should expose those same kinds of choices without making its pad panel dominate the screen. [5]

MuseScore also distinguishes choosing duration before pitch from choosing pitch before duration. This is useful evidence that entry order is a preference worth testing, not a universal truth. Its common duration shortcuts place eighth, quarter, and half notes on 4, 5, and 6. [6,7]

Its percussion customization guide allows pad rearrangement and compact layouts, and still discusses a legacy-panel option for space-constrained cases. Woodshed should remember pane sizes and visibility, and should never pop open a large panel merely because selection changes. [8]

### What these references do not settle

The research does not determine Kyle's ideal cursor-advance behavior, preferred notation density, or acceptable transcription-to-audio alignment workflow. Those need a short interactive prototype with real drum passages. Nor does documentation establish that a notation library can satisfy Woodshed's editing latency, detailed engraving, or audio synchronization requirements without integration work.

GP8's audio-track workflow is a useful later comparison, but it should not be attributed to GP5. Likewise, current MuseScore handbook pages are current behavior, not evidence of how all earlier 4.x releases worked.

## 2. Woodshed integration audit

The implementation was inspected at the published 1.5.0 source tree, remote commit `1f399caea792b2dd24be8f85a6448a67b04b4c84`. This matters because the new editor must preserve recent fixes to transport, focus, scrolling, startup, and sharing. [9]

| Existing component | Current behavior | Consequence for notation |
| --- | --- | --- |
| `engine.js` | Owns AudioContext, scheduled playback segments, playback rate, loop, edit position, and transport revision. | Reuse this clock and transport; add scheduled drum events through a deliberate interface. |
| `metronome.js` | Stores timed tempo sections and an alternative corrected/detected beat list. Schedules clicks against the engine. | Extract shared musical-time services before adding a second consumer. |
| `musical-position.js` | Counts downbeats and reports bar/beat position. | Helpful display infrastructure, but insufficient as a score model. |
| `player.js` | Owns much of the UI, grid math, transport bindings, and window-level shortcuts. | Introduce command routing and pane boundaries rather than appending another large editor to this file. |
| `interactions.js` | Distinguishes pointer activation from keyboard-focused controls. | Preserve this behavior and restore editor focus after pointer-operated notation tools. |
| `schema.ts`, `songs.ts` | Tempo and practice settings are opaque fields on songs. Practice updates are limited to 10 KB. | Store typed notation separately; do not squeeze a score into practice settings. |
| `sharing.ts`, `shareAudio.ts` | Allowlist shared song fields and create independent recipient audio copies. | Add an explicit, versioned notation snapshot to this lifecycle. |
| `export.js` | Exports library metadata and audio. | Include score data and alignment in portable library exports. |
| Theme and player layout CSS | System-aware appearance, compact cobalt header, aligned stem waveforms, shared transport. | Extend the same visual system; load notation only when needed. |

**Timing issue to resolve first:** manual metronome sections store `unit`, but beat generation currently advances by `60 / bpm` and groups by `beatsPerBar`. The denominator does not determine that interval, and the UI does not explicitly identify the BPM beat unit. Detected beats contain time and downbeat flags, without stable musical IDs or explicit beat-unit semantics. This is adequate for some practice displays but ambiguous for precise score alignment in compound and odd meters. [9]

Do not silently reinterpret existing songs. Introduce a versioned mapping, preserve current audio positions, and ask for a beat-unit or meter correction only where the mapping is genuinely ambiguous. A 6/8 passage may be felt in two dotted-quarter pulses; six detected pulses between downbeats cannot simply be assumed to mean the same thing.

## 3. The main transcription session

### Open and orient

Open a song, select **Transcribe**, and choose **Drums**. If no drum part exists, show one focused action: **Create drum part**. Use the current tempo map and loop as starting context. Do not create hundreds of visible empty measures or launch a multi-step score setup wizard.

If the song has usable timing, open at the current musical position. If timing is missing, provide a small alignment panel: identify the first downbeat, set meter and beat unit, and mark a second known position. Beat detection may propose alignment when available, but manual alignment must work on every platform. Do not make desktop-only processing a prerequisite for writing.

### Listen, write, compare

1. Select a short audio range and loop it. Start with two or four bars.
2. Solo the drum stem or reduce the backing mix. Slow playback using the existing speed control.
3. Click a notation position, enable **Write**, choose a duration, and enter hits.
4. Add simultaneous hits without advancing, then move to the next rhythmic step.
5. Switch audition from **Recording** to **Notation** or **Both** and compare the passage.
6. Select a passage, duplicate or repeat it, and modify the fill.
7. Mark the passage reviewed when it represents the recording accurately enough.

The backing controls in the mockups are a compact grouping of existing non-drum stems, not a new processed audio file. Individual stem controls remain available. Entering Transcribe should preserve the previous mix; any transcription preset is explicitly selected and reversible.

### Incomplete transcription is a first-class state

Store coverage separately from musical rests. Suggested measure states are **Not started**, **In progress**, and **Reviewed**. An empty reviewed measure can mean confirmed silence. An untouched measure means that no transcription claim has been made.

During editing, derived rests can keep a voice rhythmically valid, but must not imply that the musician deliberately transcribed silence. Untranscribed ranges get a subtle hatch or label; reviewed empty bars use ordinary rests. Editing a reviewed bar returns it to In progress. Playback of notation remains silent in unknown regions, while the UI explains that those regions are unwritten.

## 4. Keyboard and pointer interaction contract

### Recommended default: add hits at a stable step

Use a persistent duration and a musical insertion cursor. A drum key adds one hit at that cursor. The cursor stays put, making combinations such as kick plus hi-hat easy without a held modifier. Right Arrow advances by the selected step. This is the initial hypothesis to test with Kyle, rather than a claim that it is universally faster than automatic advance.

Pressing a key for a hit already present should select and audition that hit, not create a duplicate and not silently toggle it off. Delete removes the selected hit. Offer an **Advance after entry** preference only if the prototype shows a clear need; that alternative must provide a visible, simple Add at same step command. Do not ship multiple poorly differentiated entry modes just to mimic other applications.

| Command | Proposed default while the notation surface is focused |
| --- | --- |
| Write / select | N enters Write; Escape returns to Select. |
| Drum entry | K kick; S snare; H closed hi-hat; J open hi-hat; D ride; C crash; T rack tom; F floor tom. |
| Duration | 1–7 select 64th through whole; plus halves and minus doubles the duration. Toolbar labels expose the mapping. |
| Dot / tuplet | Period toggles a dot; slash toggles triplet entry; other ratios use a labeled Tuplet control. |
| Move | Left/Right move by the active rhythmic step; Up/Down choose a kit piece without changing an existing note. |
| Measure navigation | Home/End reach bar boundaries; previous/next-bar commands are visible and remappable. |
| Rest | R writes an explicit rest in the active voice over the chosen duration. |
| Delete | Delete/Backspace removes selected hit(s), retaining later event positions. |
| Expression | A accent; G ghost; sticking and grace notes available through labeled contextual controls. |
| Selection | Shift plus navigation extends the time selection; measure headers select complete measures. |
| Reuse | Cmd/Ctrl+C, V, D for copy, paste, duplicate; Repeat… exposes repeat count and replacement scope. |
| Transport | Space play/stop; Enter pause/resume. Held keys cannot repeatedly toggle transport. |
| Undo | Cmd/Ctrl+Z; Cmd/Ctrl+Shift+Z. One user action is one undo step. |

Exact letter assignments are provisional. Provide conflict detection and remapping; avoid hard-wiring musical meaning to a physical keyboard position. Display the current shortcuts on pads and in tooltips. Laptop users must not require Insert, a numeric keypad, simultaneous key chords, or prolonged modifier holds.

### Explicit focus scopes

Command precedence should be: **dialog/text entry → keyboard-focused control → focused notation surface → focused waveform surface → global transport**. A key consumed by notation must never also reach the player handler. In particular, digits cannot mute stems during note entry; plus/minus cannot zoom; S cannot also toggle snap; period cannot nudge playback.

Pointer-clicking a note tool or pad returns focus to the editor. Tab navigation retains normal control semantics, including Space activating a keyboard-focused button or checkbox. Tab must also let the user leave the editor; do not copy GP5's notation-switching Tab shortcut into the web surface. A visible focus treatment and status label identify the active keyboard scope. This follows the general focus/selection distinction in WAI guidance. [10]

### Safe pointer behavior

In Select mode, clicking chooses a note or position; it does not insert. In Write mode, hovering shows the precise kit piece and rhythmic slot to be added. A click on an empty slot adds that hit; clicking an existing hit selects it. Erasure uses Delete or an explicit eraser. Dragging a range selects; moving notes is a separate, deliberate gesture or command with a destination preview.

For dense passages, use a magnified local hit target or popover rather than demanding pixel-perfect clicks on tiny noteheads. Preserve browser zoom, pinch zoom, and horizontal scroll boundaries; continuing to pan at an edge must never change zoom.

## 5. Editing musical material

### Scope and duration

Every command needs a visible target: one hit, a simultaneous group, a voice, selected instruments over a range, or complete bars. A toolbar duration change in Write mode changes the next entry duration. In Select mode, it changes the selected rhythmic object. The status strip must make this distinction clear.

Deleting notes preserves time. Writing into an empty interval creates the event and regenerates surrounding rests. Inserting another kit piece at the same onset adds to the event or an independent voice as needed. Writing over an existing hit of the same kit piece selects it; replacement requires an explicit change.

Lengthening a note may consume rests in that voice. If it collides with another authored event, stop and show the specific conflict. Do not overwrite unrelated hits, create invisible duplicates, or ripple the whole track. Shortening leaves silence rather than pulling later events earlier. An explicit **Shift passage** operation can move a chosen range, with preview, collision checking, and undo.

### Voices and drum semantics

Start with two rhythmic voices, with sensible default routing for hands and feet. Label them Voice 1 / Voice 2 with explanatory names; these are engraving layers, not a restriction on which limbs can play a note. Allow overrides per event. Different-duration simultaneous events can therefore coexist without forcing every kick to share a cymbal's duration.

Include kick, snare, cross-stick, closed/open/pedal hi-hat, ride/bell, crash, and several toms. Model kit piece, technique, written duration, notehead, voice, velocity, and sticking separately. A ghost note is an expressive property, not merely a quieter mixer channel. An open hi-hat has a choke relationship with closed/pedal hi-hat, not a random long sample tail. Preserve kit identity if sound samples change.

The first useful release needs sixteenths and shorter values, dots, triplets, independent voices, accents, ghost notes, flams/grace notes, sticking, and explicit rests. General single-level tuplet ratios should be supported by the data model and validated; nested tuplets, advanced roll interpretation, and specialized marching notation can follow. Do not silently flatten unsupported notation during import or export.

### Repetition and partial passages

Copy and duplicate create independent note events by default. Changing a fill in one copy must not change every occurrence. Repeat… previews the destination span and overwrites only the selected part and voice/instrument scope. Warn before replacing authored notes; retain a one-step undo. Cross-meter paste keeps musical durations, with an explicit conflict preview if the destination does not fit.

For recording-linked scores, use a linear sequence of measure occurrences. Printed repeat signs can be added later as a presentation feature, but must not unexpectedly jump the audio. Imported repeats need expansion or a reviewed occurrence map. A repeated chorus in the recording can contain different timing and different fills.

## 6. Musical time and audio synchronization

### One shared time model

Introduce a song-level **MusicalTimeline** with stable measure IDs, meter, beat unit, grouping, and a monotonic alignment from musical position to media seconds. Notes refer to stable measure ID plus an exact rational quarter-note offset, not a screen x coordinate or a floating-point second value.

For a meter n/d, a full measure contains `n × 4/d` quarter-note units. Tuplets remain rational, such as one-third of a quarter note, rather than rounded decimal offsets. Keep numerator/denominator integers in persisted data, with bounded sizes and normalization. Convert to engine seconds at the scheduling boundary.

Alignment anchors relate a musical position to a recording time. Between anchors, a piecewise linear map is a sensible first implementation. Support denser beat anchors for expressive timing and a sparse tempo-derived map for steady passages. Require increasing positions and times; reject duplicates, zero-duration spans, and crossed anchors with specific feedback.

Meter, grouping, and tempo beat unit are distinct. For example, 6/8 can be grouped 3+3 with a dotted-quarter tempo unit; 7/8 may be grouped 2+2+3. Detecting pulses does not establish those meanings. Existing manual maps and beat corrections seed a draft mapping; explicit decisions resolve ambiguity without changing the recording.

### Map edits after notation exists

Moving an alignment anchor preserves all musical note positions and changes their associated media times. Changing meter is different: it may change grouping and bar boundaries. Preview affected measures and offer a reversible rebar operation. Do not delete score data because a new detection result arrives. Retain the previous timeline revision for recovery.

Handle pickups with an explicit pickup duration and stable ID. Notes before the first complete downbeat remain writable. A partial final measure is intentional, not automatically an error. Alignment gaps outside known anchors are visibly estimated until confirmed.

### Transport and cursor rules

Maintain three distinct values: **notation insertion cursor**, **playback start anchor**, and **moving playback head**. Starting and stopping does not relocate the insertion cursor. Space retains the current return-on-stop preference; Enter retains pause/resume semantics. Loop controls retain their existing behavior.

An explicit click in the audio ruler or a Set playback start command sets the playback anchor. Selecting a notation position while stopped can set that anchor as a linked navigation action; mere note mutation does not. During playback, notation selection and entry never seek or change the start anchor. An explicit Play from cursor command is available when the musician wants that behavior. Moving the insertion cursor with arrows does not continually chase or interrupt playback.

Selection and loop range are independent until **Loop selection** is invoked. Following playback must not steal the viewport while the musician edits elsewhere. Show an unobtrusive Return to playhead action; preserve selected notes and focus.

### Audition on Woodshed's clock

Add a small, locally available drum sampler on the existing AudioContext. Schedule notation events against the engine's future output segments and revision changes. Do not start a second independently timed sequencer, and do not generate note onsets from animation frames. The current `beatsBetween` approach is a useful pattern, but its all-events scan needs an indexed event lookup for dense scores. [9]

Audition choices mean: **Recording** plays the current stem mix; **Notation** plays only the written kit; **Both** combines the two. Provide separate notation volume and a one-click way to mute the recorded drums while retaining the backing. Switching modes uses short gain ramps without moving transport. Preview hits use the same sampler but never edit the score or start the song.

Cancel queued events on seek, stop, loop/rate changes, and score edits. Preserve natural cymbal tails across ordinary loop wraps without replaying the same event twice; cancel or fade them on stop and seek. Respect count-in and audible pre-roll without counting notation events twice. Playback rate changes event timing, not the pitch of the drum kit. Deterministic audition is the default; avoid automatic humanization while checking a transcription.

## 7. Rendering and technical approach

### Recommended starting point

Build a small Woodshed-owned TypeScript score model and command engine, with **VexFlow SVG rendering** behind an adapter. VexFlow is a notation renderer with Canvas and SVG output, not a complete editing product. This leaves more engraving work for Woodshed, but permits precise control over fixed-audio editing, semantic selection, and waveform alignment. [11]

Treat this as a provisional choice until a focused spike compares VexFlow with alphaTab using the same difficult drum fixtures. Do not choose based on a clean four-beat demo alone.

| Candidate | Verified capability | Assessment for this feature |
| --- | --- | --- |
| VexFlow | TypeScript notation rendering to SVG/Canvas; MIT-licensed project. [11] | Preferred first spike for tightly controlled editing and time-aligned layout; requires our own model, spacing policies, interaction, and playback. |
| alphaTab | GP3–5 and other notation importers, score model, rendering and synthesis modules. [12] | Strong candidate for import and potentially rendering; not a drop-in Woodshed editor. |
| OpenSheetMusicDisplay | MusicXML display built using VexFlow. [15] | Useful when displaying existing MusicXML is primary; less direct for a custom interactive drum editor. |
| MuseScore Studio | Reference desktop application with broad notation workflows. [3–8] | Learn from behavior and design; embedding the desktop application is outside this integration. |

alphaTab's documentation warns that direct model changes can create inconsistent rendering state. Its external-media integration explicitly does not mix backing audio and synthesized score audio together. Those are material limitations for this use case, not reasons to dismiss the library: an adapter could rebuild valid models while Woodshed retains playback ownership. [13,14]

The spike should measure notehead hit testing, tuplets and two voices, per-bar re-rendering, fonts in Electron's CSP, dark mode, print output, and the ability to place a cursor from Woodshed's musical-time mapping. If alphaTab performs materially better, adopt it behind the same adapter rather than rewriting storage and commands around library internals.

### Two layout contracts

**Split view** uses a shared timeline width and visible range for waveform and notation. Bar boundaries correspond to recording time. Following Kyle’s engraving review, noteheads occupy padded space **inside** each bar; they must never fall on barlines. The notation playhead and click targets use that same engraved geometry, while the waveform retains its own linear time coordinates. Set a minimum readable width; zoom into dense bars instead of allowing symbols to collide. This is a screen editing layout, not publication engraving.

**Focus / print view** uses musical spacing and wrapping. Cursor position is mapped through rendered note/bar geometry, never assumed to share pixels with the overview waveform. The overview remains an independent navigation control. Switching views retains note IDs, selection, cursor, and transport.

Lazy-load the editor, font, and sampler when opening Transcribe. Keep the ordinary library and player startup path unchanged. Render only visible measures plus a small margin and update only affected bars. A notation failure must leave audio practice usable and preserve unsaved score data.

## 8. Data, saving, sharing, and compatibility

### Proposed storage boundaries

| Entity | Responsibilities |
| --- | --- |
| Song musical timeline | Versioned measures, meter/grouping, alignment anchors, source-audio revision, migration metadata. |
| Notation part | Song ownership, instrument kind, name, kit definition, score schema version, current revision. |
| Measure chunk | Bounded range of stable measures, voices/events, coverage state, revision. |
| Event | Stable ID, rational onset and written duration, hit/rest kind, kit-piece reference, technique, expression, voice and sticking. |
| Local editing state | Cursor, selection, open panels, key bindings, zoom, undo history, pending operations. |

A notation part should belong to a song, not to an R2 stem key. A user can reprocess the drum stem without changing the musical identity of the part. A mapping to a source audio revision lets the UI flag alignment that may need review after changed-duration or changed-offset audio arrives.

Use a command reducer for add/remove hit, set duration, set expression, replace range, duplicate, repeat, and rebar. Commands produce validated transactions with inverses. Preview navigation and transport actions do not pollute musical undo history. Repeated velocity drags can coalesce into one undo step.

### Safe autosave and concurrent editing

Update locally immediately, journal pending edits in IndexedDB, then persist bounded commands or chunks with `baseRevision` and an idempotency key. Show **Saving**, **Saved**, **Offline changes**, or **Needs attention** accurately. “Saved” means the server acknowledged the revision. Keep export/recovery available after a failed save.

Do not use last-writer-wins replacement of a whole score. Begin with optimistic revision checks and a clear conflict path: reload remote, retain local recovery copy, or save the local work as a separate part. Multi-device edits must not silently erase a passage. Real-time collaborative editing is deferred; do not introduce a CRDT solely for hypothetical future collaboration.

Validate rational values, event density, measure count, kit references, ownership, and transaction size on the server. An owner can edit; public share viewers cannot. Apply existing account restrictions consistently. Add cleanup for notation data when a song is deleted, and recovery behavior when an account changes while offline edits are pending.

### Sharing policy

**Recommendation: include the current saved drum notation and its alignment in a shared song by default**, with a clearly labeled Include notation control in the share dialog. Score markings such as sticking and rehearsal labels are part of the shared score; existing private song notes and personal tags remain excluded. Keyboard mappings, open panels, undo history, and pending edits never travel with the song.

Public links can display notation and audition it read-only. Add to library copies notation, kit configuration, coverage, and the exact associated timeline snapshot along with the independent audio. Use a revision or immutable snapshot captured at import start so a sender editing during the copy cannot produce mismatched score and alignment. Revocation before completion follows the existing import-abort policy; already saved recipient copies remain independent.

If a sender changes inclusion settings, stop exposing the score on that link without deleting the sender's part. Public-view caches should include notation and alignment revisions. Sharing must flush pending score edits or clearly report that only the last saved revision is being shared. Never silently present stale edits as current.

### Export and import

The first useful release should include a lossless Woodshed score document and selected-part print/PDF output. Include the score document in full-library exports. Clearly mark untranscribed measures in print, or export only the selected transcribed passage; do not print unknown music as confirmed rests.

Next, add MIDI and MusicXML export, then GP5/MusicXML import with a review screen. Separate notation placement from sounding instrument identity. MusicXML explicitly supports unpitched display positions and distinct instruments; its MIDI-unpitched numbering is 1–128 rather than ordinary MIDI's 0–127, an easy off-by-one interoperability error. [16,17]

Imported scores should not replace the song's timing map automatically. Choose the drum part, review kit mapping, expand repeats if necessary, and align known measures to the recording. Surface unsupported techniques and preserve the original imported file for reprocessing. Do not promise lossless GP5 round-trip export in the first release. alphaTab's 1.8 notes describe a GP5 percussion compatibility correction, reinforcing the need for real legacy fixtures. [18]

## 9. Visual concepts and responsive behavior

### A. Integrated transcription workspace — recommended default

The light-theme concept puts waveform context above a readable percussion staff. A compact kit strip provides labels, sound preview, and shortcut hints. A selected-hit inspector exposes expression without a modal. A single transport remains visible. The proposed shipped version should show either the inspector or more notation width depending on available space, rather than permanently sacrificing the right side.

The most important refinement from the generated image is **exact waveform/notation correspondence**. Its illustrated bar boundaries do not consistently line up; the implemented split view must meet the layout contract in section 7. The labels and highlighted durations are visual examples, not timing truth.

### B. Expanded score — same editor, more musical context

The dark concept gives the score most of the screen, keeps a compact overview, and makes passage selection/reuse visible. This is appropriate when the musician is developing a verse or correcting repeated material. Collapse the kit to its shortcut legend after the user learns it. Expanded score is a layout toggle, not a separate project or mode with different shortcuts.

“Hands / Feet / Both” in the concept is a readability shorthand. The implemented voice selector must distinguish an editable voice from a visibility filter; selecting Both cannot ambiguously decide where a new rest belongs. Repeat commands should appear contextually, not remain permanently open as in the explanatory mockup.

### C. Drum lanes — pulled into the approved scope

The third concept uses named kit rows and discrete hit markers, with a linked staff preview. It makes simultaneous hits, ghost notes, and unknown ranges approachable. It is a second view of the canonical score, not separate pattern data and not a DAW arrangement editor.

Its implementation needs clear distinction between cursor step and written duration, support for off-grid tuplets, and an unambiguous way to select several simultaneous events. Do not allow a fixed sixteenth-note lattice to erase or quantize imported material. Kyle approved this view alongside A and B, so it is included in the implementation.

### Small screens and accessibility

Desktop and tablet landscape get the full editor. Smaller tablets can collapse the inspector and kit while preserving transport and current measure. Phones initially get score reading, practice playback, loop selection, and sharing; dense phone notation entry should not be promised as an incidental responsive layout.

Support system theme, zoom and high contrast, visible selection beyond color alone, reduced motion, semantic descriptions of selected hits, and keyboard access to every required command. Provide a structured event-list alternative for screen readers if the graphical staff cannot expose adequate semantics. Announce “bar 18, beat 2 and, snare, ghost, eighth note” on deliberate selection changes, not on every playback animation frame. Test with VoiceOver and NVDA, including escape from the editor and controls. [10]

## 10. Delivery sequence and gates

These are relative planning estimates for a focused implementation, not delivery promises. Renderer and timing spikes can materially change the effort. The scope is a substantial editor feature and should be released in increments rather than hidden inside a routine patch.

| Phase | Deliverable | Exit gate | Initial effort estimate |
| --- | --- | --- | --- |
| 0. Workflow and renderer spike | Two to four bars, keyboard entry, two voices, basic kit audition; compare renderers. | Kyle completes the core transcription task without a tutorial; no timing or rendering dead end. | 4–7 engineer-days |
| 1. Musical foundation | Typed score/commands, stable measures, alignment migration, focus router, undo and local journal. | Exact musical-time fixtures pass; existing transport and keyboard behavior remain intact. | 7–12 days |
| 2. Useful transcription editor | Split and expanded staff, palette, expression, selection/reuse, complete audition, autosave and recovery. | Transcribe, audition, duplicate, modify and reopen a real passage reliably. | 12–20 days |
| 3. Release hardening | Sharing snapshots, export/print, accessibility, dense-score performance, desktop packaging. | End-to-end acceptance suite and real musician review pass on supported platforms. | 6–10 days |
| 4. Extensions | Lane view, interchange, richer techniques, optional alternative input; later standalone composition. | Prioritize by actual transcription use, with no silent data loss. | Estimate after phases 0–3 |

A first public release is approximately **29–49 engineer-days of work** across phases 0–3, with substantial uncertainty. This is an effort range, not a calendar date or an assumption that all engineering tasks are serial. The strongest initial commitment is the small workflow spike and a second review before broad implementation.

### Suggested implementation boundaries

Create `src/js/notation/` modules for model, commands, selection, keyboard mapping, rendering adapter, sampler, persistence, and import/export. Introduce a shared musical timeline and command router outside `player.js`. Add a notation-pane adapter in the player layout. Keep the current engine authoritative and add a bounded event-scheduling interface rather than exposing internal arrays throughout the editor.

Backend work belongs in typed notation/timeline modules, with indexed ownership queries, bounded chunk updates, and snapshot helpers reused by sharing/export. Expand existing deletion and account-control paths. Keep the notation feature gated during migration; old clients and old songs must still open normally.

## 11. Acceptance criteria

### Musical and editing correctness

| Fixture or action | Required result |
| --- | --- |
| Kick and hi-hat at one step | Two hits, one onset; no forced modifier; no accidental advance. |
| Eighth-note hats over quarter-note kick | Independent voices/durations render and play correctly. |
| Ghost snare, flam, accent and sticking | Distinct stored semantics; reasonable audible result; survives reload. |
| 4/4 → 7/8 → 6/8 | Correct bar lengths, beat units, grouping, cursor positions, and loop boundaries. |
| Pickup and partial ending | Writable and printable without invented full measures. |
| Triplets and quintuplets | Exact rational timing; no accumulated rounding drift. |
| Delete or shorten in bar 4 | Later onsets stay fixed. |
| Lengthen into another authored hit | Specific conflict; no hidden overwrite. |
| Duplicate then change a fill | Original passage remains unchanged. |
| Untranscribed bar vs confirmed rest | Distinct coverage in UI, sharing and export. |

### Playback, focus, and persistence

Test a ten-minute variable-tempo song through repeated loops, rate changes, pause/resume, return-on-stop, count-in cancellation, and audible pre-roll. Capture scheduled or rendered audio to compare expected onsets; a moving line that looks aligned is not proof. Include fractional loop endpoints and fast double-kick passages. Require no cumulative drift, no duplicate boundary hits, and no replay of canceled scheduled events.

Test pointer-clicked controls followed by Space, Tab-focused controls, modifier keys, keyboard repeat, IME composition, and text fields inside popovers. Digits, arrows, S, period, and plus/minus must reach exactly one appropriate command. Undo from the notation surface must not undo text in another focused field.

Test reload during an outstanding save, offline editing, server rejection, two tabs editing the same part, account changes, song deletion, reprocessing, and revision conflicts. No successful-looking save may discard local work. Recovery exports must retain exact musical and alignment data.

Test shared playback, Include notation disabled, import while the sender edits, revocation during import, and deletion of the original after saving. A recipient must receive one coherent score/alignment snapshot with independent editability. An anonymous visitor must never reach an owner mutation.

### Performance and usability targets

Provisional targets: visible feedback within 50 ms at the 95th percentile on a representative laptop; audition response within roughly 30 ms after the audio system is ready, excluding device-output latency; no audio interruptions while editing; smooth navigation of a 250-bar, 10,000-hit fixture. Measure rather than promise these thresholds before the spike.

Run a short musician session using a familiar groove, a syncopated fill, a compound-meter passage, and an imperfect beat map. Observe undo use, wrong-note corrections, accidental transport changes, dependence on hidden shortcuts, and time spent managing voices. Compare stable-step entry with auto-advance only if the first version feels unnecessarily laborious.

## 12. Decisions for the next review

The recommended direction is **A as the default workspace, B as its expanded layout, and C as another view in the approved scope**. Keep one transport and one score. Start with stable-step drum entry, explicit Write/Preview, automatic sensible voice assignment with overrides, and recording-preserving edits.

The next review should resolve three questions through interaction rather than another long specification:

1. Does entering several hits at a stationary cursor, then advancing, feel fluent enough? If not, compare an auto-advance variant on the same passage.
2. Is the staff readable enough beside the waveform, or should the lane view be pulled forward?
3. Is initial release completeness defined by manual transcription and sharing, or are existing GP5-file imports indispensable on day one?

No answer is needed to finish this research. These are concrete prototype decisions, not blockers to the recommended plan.

## Sources

Numbered references identify source support for factual findings. Uncited implementation choices, estimates, interactions, and test thresholds are recommendations. Web sources were checked September 9, 2026. Historical release dates are stated where relevant; current documentation may evolve.

1. Arobas Music. **Guitar Pro 5 User Guide**, Windows edition, version 5 era; publication date not specified. Printed pp. 10, 15–19, 31–38, 41–48, 79–81. https://static.guitar-pro.com/gp5/GuitarPro_EN.pdf
2. Arobas Music Support. **Download Guitar Pro 5 | Tablature Editor Software**, official legacy application/manual links. https://support.guitar-pro.com/hc/en-us/articles/360000280269-Download-Guitar-Pro-5-Tablature-Editor-Software ; Mac guide: https://static.guitar-pro.com/gp5/GuitarPro_MAC_EN.pdf
3. Tantacrul / MuseScore. **MuseScore 4 is OUT NOW!**, December 14, 2022, with subsequent patch notices. Interface, Properties, engraving, accessibility. https://musescore.org/en/4.0
4. MuseScore. **MuseScore Studio 4.5 is now available!**, March 14, 2025. Percussion panel and input improvements. https://musescore.org/en/4.5
5. MuseScore Studio Handbook. **Inputting percussion notation**, current handbook. https://handbook.musescore.org/idiomatic-notation/percussion/inputting-percussion-notation
6. MuseScore Studio Handbook. **Entering notes and rests**, current handbook. https://handbook.musescore.org/basics/entering-notes-and-rests
7. MuseScore Studio Handbook. **Input by duration mode**, current handbook. https://handbook.musescore.org/basics/input-by-duration-mode
8. MuseScore Studio Handbook. **Customizing the percussion panel**, current handbook. https://handbook.musescore.org/idiomatic-notation/percussion/customizing-the-percussion-panel
9. KyleKincer/woodshed. **Version 1.5.0 source tree**, commit `1f399caea792b2dd24be8f85a6448a67b04b4c84`. Inspected engine, metronome, musical-position, player, interactions, player-layout, theme, schema, songs, sharing, shareAudio and export modules. https://github.com/KyleKincer/woodshed/tree/1f399caea792b2dd24be8f85a6448a67b04b4c84 ; timing source: https://github.com/KyleKincer/woodshed/blob/1f399caea792b2dd24be8f85a6448a67b04b4c84/src/js/metronome.js ; transport: https://github.com/KyleKincer/woodshed/blob/1f399caea792b2dd24be8f85a6448a67b04b4c84/src/js/engine.js
10. W3C WAI. **Developing a Keyboard Interface**, Authoring Practices Guide. https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/ ; **Grid Pattern**: https://www.w3.org/WAI/ARIA/apg/patterns/grid/
11. VexFlow contributors. **VexFlow repository and license**, current project. https://github.com/vexflow/vexflow
12. Daniel Kuschny and contributors. **alphaTab Introduction**, current documentation. https://alphatab.net/docs/introduction
13. Daniel Kuschny and contributors. **alphaTab Data Model**, especially model mutation warnings. https://alphatab.net/docs/reference/score
14. Daniel Kuschny and contributors. **alphaTab Audio & Video Sync**, external-media behavior and mixing limitation. https://alphatab.net/docs/guides/audio-video-sync
15. PhonicScore / OpenSheetMusicDisplay contributors. **OpenSheetMusicDisplay repository**. https://github.com/opensheetmusicdisplay/opensheetmusicdisplay
16. W3C Music Notation Community Group. **MusicXML 4.0 Percussion tutorial**. https://www.w3.org/2021/06/musicxml40/tutorial/percussion/
17. W3C Music Notation Community Group. **MusicXML 4.0 midi-unpitched element**. https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/midi-unpitched/
18. Daniel Kuschny and contributors. **alphaTab v1.8 release notes**, GP5 percussion compatibility correction. https://alphatab.net/docs/releases/release1_8
