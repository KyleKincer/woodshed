# Woodshed 2.0: "Stage" UX redesign spec (definitive)

This is the one spec to build from. It starts from the **Stage First** proposal, which scored highest with all three judges (rehearsal 9, tablet 9, feasibility 7). It adds the strongest ideas from **Studio** and **Coach**, fixes every weakness the judges named, and rejects some ideas outright (§0.3).

**Grounding.** I re-checked these facts in the repo before writing:
- `engine.setSpeed` clamps to 0.5–1.5 (`src/js/engine.js:292`).
- `songs.savePractice` caps practice at 10,000 chars (`convex/songs.ts:155`), and `toClient` ships `practice` in every `songs.list` row (`convex/songs.ts:73`).
- The desktop static server serves only `/assets/*` plus an explicit allow-list. Everything else returns `index.html` (`desktop/main.cjs:41`).
- `engine._schedule(offset, when)` already takes an audio-clock `when`. The pitch-preserving path loops inside Signalsmith (`loopStart`/`loopEnd` in `stretch.schedule`), and the native path loops with `source.loop`. Both matter for count-in on every pass (§9.5).
- Six separate `keydown` listeners exist today (`player.js`, `editor.js:242`, `map-mode.js:361/555`, `tempo-sources.js:254`, `interactions.js:15`, `modal-focus.js:20`).

---

## 0. Direction, grafts and principles

### 0.1 The direction in one paragraph
Inside a song, Woodshed is a **performance display**, like a music stand with a heads-up display. You can read it from 1–2 m. Stray touches do nothing. It works hands-free from keys and pedals. Every song reopens exactly where you left it. Everything else (library, adding, editing, settings, billing, admin) is calm, subordinate and out of the way. **Practice (Stage)** and **Edit (Map / Chart / Details)** are two postures of the same song, at different URLs. Editing tools never appear in the Stage.

### 0.2 What was grafted in, and from where
| Idea | Source | Where in this spec |
|---|---|---|
| Next-section anticipation: "next: Verse 2 · 6 bars" becomes "Verse 2 in 2 · 1" | Stage | §4.3 |
| Quantized section jump at the next downbeat, cancellable | Stage | §4.5 |
| Distance setting (Near / Stand / Kit) driven by mm targets | Stage | §4.11 |
| Strict colour meaning: amber `--now` = where the music is; cobalt `--accent`/`--loop` = what you chose | Stage | §8.3 |
| Stems surface keeps zoom, fit, grid, snap, wheel zoom/pan and a bar ruler | Studio | §4.4D |
| A mouse click seeks immediately while playing; glass rules apply only to touch and pen | Studio | §4.9 |
| 2 px `--edit` top border plus an "Editing map" label | Studio | §5.0 |
| "Display" (device) vs "Part layout" (saved with the part) | Studio | §4.4A, §5.2 |
| Electron app menu generated from the command registry; browser-reserved shortcuts avoided on web | Studio | §6.5, §7.4 |
| Coalesced practice undo with an "Undid: speed 85% → 100%" toast | Studio | §4.14 |
| Every job kind made visible (split, beats, import) | Studio / Coach | §2.8 |
| Chrome never changes the width of the music, so hiding or showing it never relayouts alphaTab | Coach | §4.1, §4.10 |
| Page-turn follow as the iPad-portrait default | Coach | §4.4A |
| "Tap the beat" quick sheet that builds a map without the editor | Coach | §5.1.3 |
| Honest "Lead-in 2 s" count-in on unmapped songs | Coach | §4.7 |
| Mix sheet with a visible "Tap to: Mute · Solo" mode; Only me (⇧M) | Coach | §4.7 |
| Add defaults from the instrument profile (6 stems for guitar/keys, never 2-stem by default) | Coach | §3.2 |
| Spots anchored to bar ids so they survive map edits | Coach | §1.1, §9.3 |
| Engine plan: wrap event, scheduled speed/gain changes, segmented loops only when gap > 0 | Coach | §9.5 |
| Pedal double-tap fallback for pedals that cannot hold | Coach | §7.5 |
| First-run "What do you play?" plus "Open songs with my part: In / Out" | Coach | §6.6 |

### 0.3 What was rejected, and why (decided; not open questions)
- **Persistent cross-navigation session (Studio).**
  - Why not: it means extracting a SongSession from the 1,108-line `player.js` in phase 1. It also keeps decoded audio and the wake lock alive across places, and needs a mini transport everywhere. All of that is iPad memory and lifecycle risk.
  - Instead: **Resume exactly** (§4.12) plus **hold-to-leave** (§4.9) make an accidental Back cost nothing. Revisit only if setlists (B3) ship and users ask to browse while playing.
- **Readiness, "Solid", "Rusty" and percent progress (Coach).** The app cannot tell whether you played cleanly, so these would be invented facts, the same honesty problem as fake bars. Kept: honest counters only. Spots record "practised 2 days ago · 14 times through".
- **Key choices rejected:**
  - ⌫ = Again (⌫ means remove everywhere else).
  - ←/→ = beat (drummers step bars).
  - ⌘± for chart zoom (it hijacks browser zoom, an accessibility regression).
  - Web ⌘N and ⌘, (Chrome owns them).
- **Speed below 50%.** The engine clamps at 0.5. The range stays **50–150%**. 25–49% is optional engine phase E1.
- **Esc leaving the song.** Esc never navigates while the transport runs.
- **Auto-hiding the dock behind a "wake" tap (Studio iPad).** Again or Loop would cost two taps mid-song. The dock stays live and dims to 70% instead.
- **Studio's 3-pane resizable shell, virtualised table, Albums/Artists places and rebinding UI in the core phases.** Albums and Artists become Group-by plus drill-down filters (§2.3). Rebinding is limited to pedals.
- **Studio's "Loop from here to…" banner and today's long-press-then-tap pending state.** Both are hidden pending states.

### 0.4 Principles (every screen is checked against these)
1. **Read high, touch low.** Information sits where the eyes rest: the HUD band (portrait) or the top of the rail (landscape). Controls sit where the hands are: the dock or the bottom of the rail. Nothing that changes playback lives in the reading zone.
2. **One playhead, one cue, one loop.** The "edit cursor" is gone. The **cue** is where Play starts and Stop returns. When a loop is on, the cue *is* the loop start.
3. **Bars when they are real, honest seconds when they are not.** Never show bar numbers from the placeholder 120 BPM map.
4. **Glass for fingers, not for mice.** While playing, one stray touch cannot seek, loop or navigate. Mouse and keyboard are deliberate and act immediately.
5. **Nothing interrupts playback.** No modals, focus-stealing toasts, layout shifts, update prompts or upsells while the transport runs. They queue until Stop.
6. **Resume is the default.** Same cue, loop, speed, mix, surface and scroll on reopen. The song is interactive before decode finishes.
7. **The music's width never changes by itself.** Only an explicit user action (rotate, Focus, Distance, pinch release) may relayout the chart, and the playing bar keeps its screen position.
8. **One registry for every input.** Keys, pedals, palette, menus, tooltips, the `?` sheet and the Electron menu all come from one command list.

---

## 1. Product model and information architecture

### 1.1 Objects
| Object | Meaning | Storage |
|---|---|---|
| **Song** | Audio, stems, metadata, artwork, notes | `songs` (unchanged) |
| **Map** | Tempo/meter map. **Real** only when detected, tapped, imported or edited. | `songs.tempo.songMap` + new `songMap.origin` ∈ `detected \| tapped \| imported \| edited` (client-written, no schema change) |
| **Section** | A named span of bars on a mapped song: `measure.label` on its first bar | inside the Map (unchanged model) |
| **Marker** | A named point in time on an unmapped song. Converts to a Section when a real map arrives (with Undo). | `practice.markers[]` |
| **Chart** | The drum notation part | `notationParts` / `notationBars` (unchanged) |
| **Cue** | Where Play starts and Stop returns | `practice.cue` |
| **Loop** | Active practice range plus options (count every pass, play N times, trainer) | `practice.loop` |
| **Spot** | A saved, named loop with speed and optional note. Bar-anchored when mapped. Example: "Bridge walk-up · 85%". | `practice.spots[]` (≤ 24) |
| **Practice state** | Cue, surface, scroll anchor, rate, keep-pitch, mix, minus-me, trainer, lastAt | `practice` v2 (§9.3) |
| **Instrument profile** | "I play drums (and guitar)" plus "Open songs with my part In/Out" | `userSettings.settings.profile` (merged by `withDefaults`; no schema change) |
| **Pin** | Up to 12 song ids on Home | `userSettings.settings.pins` |
| **Setlist** *(optional B3)* | An ordered list of songs | new `setlists` table |
| **Job** | Split, beat detection, import | `jobs` (unchanged) |
| **Device** | A paired desktop processor | `devices` (presence is optional B5) |

**Real-map rule (`hasRealMap`)** is one function, unit-tested and used everywhere bars or count-ins could appear. It is true when `songMap.origin` is set. For legacy rows without `origin`, it is true if **any** of these hold:
- more than one pin;
- any section label;
- `source === 'detected'` with detected beats;
- a notation part exists.

Otherwise the map is a placeholder. The Stage shows time, and a test asserts that unmapped songs never render the word "Bar".

### 1.2 Places and URLs (History API router; every place is a URL)
| URL | Place | Notes |
|---|---|---|
| `/` | **Library** (home) | `?q=&sort=&group=&filter=&artist=&album=` mirrored with `replaceState` |
| `/add` | **Add sheet** over Library | Modal route: Back closes it. `?q=` pre-fills. |
| `/s/:songId` | **Stage** | `?spot=:id`, `?bar=57`, `?t=83.2`; `?set=:id` with B3 |
| `/s/:songId/edit/map` | Edit · **Map** | `/s/:id/edit/map/find` opens Find a chart |
| `/s/:songId/edit/chart` | Edit · **Chart** (Transcribe) | |
| `/s/:songId/edit/details` | Edit · **Details** | `#match` scrolls to the Match section |
| `/settings`, `/settings/:section` | Settings | sections listed in §6.2 |
| `/admin`, `/admin/accounts/:id` | Admin | admins only |
| `/share/:token` | **Shared Stage** | read-only Stage; keeps its own boot path |
| `/download` | Desktop download | from inside the app it always opens in a new tab |
| `/set/:id` | Setlist *(B3)* | |

**Legacy redirects** (`replaceState`): `/?song=X` → `/s/X`; `/billing` → `/settings/plan` (Stripe return URLs keep working).

**History rules:**
- **Push:** place changes, opening a song, entering Edit, opening `/add`.
- **Replace:** switching Edit tabs, Library sort/filter/search (debounced 400 ms), and `?bar=`. The URL is written on Stop, never while playing.
- **Back:**
  - Edit → Stage at the same position.
  - Stage → Library, restoring scroll and focus on the card you opened.
  - `/add` → Library.
  - Settings section → Settings index (iPad portrait) or Library (laptop).
- **Overlays:** sheets, popovers and menus never push history. Esc closes them.
- **iOS edge-swipe Back and browser Back while playing** cannot be blocked, and that is fine. The page flushes the practice save on `popstate` and `pagehide`, and reopening resumes exactly.
- **One loaded song.** Leaving `/s/:id/*` stops and unloads the engine. Stage and Edit share one session; moving between them keeps playback state.

### 1.3 Chrome per place
- **Library, Settings, Admin:** a 56 px top bar (60 px on coarse pointers). The saturated 76–108 px brand band is removed everywhere.
- **Stage:** no app chrome. Identity and Back live in the HUD (band) or the rail.
- **Edit:** a 48 px posture bar with a 2 px `--edit` top border:
  - `‹ Done`, the song title, the label "Editing map", tabs `Map · Chart · Details`;
  - right side: Undo, Redo, save status.
  - A 56 px slim transport at the bottom uses the same commands as the Stage.

### 1.4 What happens to today's views
| Today | Tomorrow |
|---|---|
| Brand header band | Removed. Calm 56 px top bar outside the Stage; nothing inside it. |
| Practice → Chart/Tracks, Transcribe tab | Stage surfaces Chart / Road map / Stems. Transcribe becomes Edit · Chart. |
| Tempo map overlay mode + Find/import panel | Edit · Map with a Find-a-chart side panel (no app-wide inert freeze) |
| Metronome popover | Count-in and Click controls plus the Click sheet. Map and Detect move to Edit · Map. |
| Practice strip (A/B seconds, ±50 ms) | Loop card (bars, or 0.1 s with Alt 50 ms / Alt+Shift 10 ms), handles on the surface, song-strip bracket, I/O keys |
| Overview minimap | Song strip (adds a viewport bracket on the Stems surface) |
| Metadata modal stack | Edit · Details page |
| Settings + Billing | One Settings; Plan & storage is a section |
| In-progress list on Library | Processing state on the song's own card, plus a Jobs popover |

---

## 2. Library home

Calm and artwork-first, built to **resume**. Max content width 1280 px. Gutters are 32 px on laptop and 24 px on iPad.

### 2.1 Top bar (56 px; 60 coarse)
Left to right:
- **Wordmark** "Woodshed", 18/800 in `--ink`. It is the Home link.
- **Search** field: 40 px tall (48 coarse), max 520 px, placeholder "Search songs, artists, sections…", with a `⌘K` key-cap hint.
  - `/` focuses it. Typing filters the grid live.
  - `⌘K` opens the palette (§7.3).
- **Jobs chip.** Present only when there is something to show:
  - `◐ 2 splitting`, `⚠ 1 failed`, or `⦸ Processor offline` (desktop).
  - Click opens the Jobs popover (§2.8).
- **`＋ Add song`**: 40 px, accent fill. Opens `/add` on every platform. On web the sheet explains the desktop step and never dead-ends.
- **Avatar** (36 px; 44 coarse) opens the account menu:
  - email;
  - Settings (`⌘,` in Electron only);
  - Plan & storage;
  - Keyboard shortcuts `?`;
  - App updates (desktop) or Get the desktop app ↗ (web);
  - Administration (admins);
  - Sign out.
  - A 8 px dot on the avatar marks a ready desktop update.

### 2.2 Body, top to bottom
1. **Continue** (only if any song has `practice.lastAt`).
   - **Hero card:** 2 grid columns on laptop, full width on iPad.
     - cover 160 px (128 on iPad);
     - title 28/700; artist 16 `--ink-2`;
     - state line 16, e.g. `Bridge loop · 85% · Drums out · practised yesterday`;
     - `▶ Resume` (primary, 48 px; 56 coarse) and `Start from top` (quiet);
     - up to 3 spot chips (`◆ Bridge walk-up · 85%`), each opening `/s/:id?spot=…`.
   - **Up to 3 compact recents:** cover 64, title, state line. They sit beside the hero on laptop and as a row of 3 under it on iPad.
   - **Resume** opens the song stopped, at its cue, with focus on the Stage, so Space plays at once.
   - **Data source:** until B1, Continue reads `practice.lastAt` from today's list payload. `lastAt` is written once per session, so this adds no churn (§9.3).
2. **Pinned** (when pins exist). One row of compact cards. With B3 it becomes **Setlists**: `Thursday rehearsal · 6 songs` cards opening `/set/:id`.
3. **Library.**
   - Header: `Library` 20/700 and a count `42`.
   - Filter chips, single-select (tap again for All): `Has chart` · `Mapped` · `Has spots` · `Needs review` · `Processing` (only if > 0) · `Failed` (only if > 0).
   - Right side: `Sort ▾`, `Group ▾`, and the view toggle `▦ / ☰`.
   - Then the grid or list.

### 2.3 Sort, group, drill-down
- **Sort:** Recently practised (default once any practice exists) · Recently added (default before that) · Title · Artist · Album · Duration · BPM (mapped songs; others last) · Key.
- **Group:** None (default), Album, Artist. Group headers are sticky, 40 px, with a 32 px cover or initials disc and a count. "Unknown album/artist" groups sort last.
- **Drill-down:** clicking an artist or album name on a card or list row adds a removable filter chip (`Artist: Northbound ✕`). This replaces today's Songs/Albums/Artists tabs without new places.
- **Persistence:** all view state goes in `ws.prefs.library` and in the URL. A new search never resets sort.

### 2.4 Song card (grid) and list row
- **Columns:** 6 at 1440 (≈190 px), 3 on iPad portrait (≈240 px), 5 on iPad landscape.
- **Cover:** square, radius 0 (the record-sleeve look is kept). The only overlays are the processing rail and the 10 px **New** dot.
- **Row 1:** title 16/600, two-line clamp. The `⋯` button (32 px; 44 coarse) sits in **its own grid cell**, so it never covers text.
- **Row 2:** artist 14 `--ink-2`. Clicking it drills down.
- **Row 3, meta:** 13 `--ink-3`, joined with `·`: duration · `Chart` · `Mapped` · `2 spots` · stem count only when not 4 (`6 stems`, `2 stems`).
- **States:**
  - **New:** an accent dot before the title until first open.
  - **Needs review** (`metadataStatus` `uncertain`, or an untitled upload): a quiet chip `Is this right?`. It opens an inline popover with the match (title, artist, album, cover) and `Yes, that's it` / `Find another` (→ `/s/:id/edit/details#match`).
  - **Processing:** cover at 55% opacity, a 4 px progress rail on the bottom edge of the cover, and the stage line in row 3 (§3.4). Click opens the Jobs popover focused on this job.
  - **Re-splitting:** the same as processing, but title and artist stay full contrast and the old stems stay playable.
  - **Failed:** the cover keeps its identity. Row 3 becomes one sentence in `--danger` text plus inline `Try again` and `Details`.
- **Interaction:** click opens the Stage. Right-click or long-press (500 ms) opens the card menu. ⌘/Ctrl-click or Shift-click enters selection.
- **List row** (56 px; 64 coarse), columns on laptop: thumb 40 · Title/Artist · Album · Key · BPM · Length · Practised · ⋯. Headers are sortable (▲/▼). On iPad the album and BPM columns are dropped. Rendering uses `content-visibility: auto`; no virtualisation until a library passes 500 songs.

### 2.5 Card menu (Menu primitive)
- `Practice ↵`
- `Edit details… E`
- `Edit chart` (if a part exists)
- `Edit map`
- divider
- `Pin` / `Unpin`, `Share…`, `Add to setlist ▸` (B3)
- divider
- `Re-split…` (desktop; on web it is disabled with the visible reason "Needs Woodshed for desktop")
- `Open original source ↗` (http sources)
- divider
- `Delete…` (danger)

### 2.6 Selection mode
- **Entry:** ⌘-click, Shift-click, long-press then tap others, or `Select` in the Sort menu.
- **A 56 px floating bar** at bottom centre: `3 selected · Edit details · Pin · Re-split (desktop) · Delete · Done`.
- **Bulk delete** asks for confirmation in a Dialog: "Delete 3 songs? Their stems and charts are removed from your library. Shared links stop working." [Cancel] [Delete 3 songs].
- The cap stays at 100, worded "Up to 100 at a time".
- `Esc` exits; `⌘A` selects all visible.

### 2.7 Empty and edge states
- **First run (no songs).** Two cards side by side (stacked on iPad):
  - **Demo card:** cover, "**Try the example song**", "A full band with a drum chart, sections and a tempo map. Your part starts muted so you can play along." `▶ Open example` (§6.6).
  - **Add card, desktop:** "**Add your first song**" · "Paste a YouTube, SoundCloud or Spotify link, search by name, or drop audio files." · `＋ Add song`.
  - **Add card, web/iPad:** "**Add songs from your computer**" · "Woodshed splits songs into stems on your Mac or PC. Your library syncs here automatically." · `Get Woodshed for desktop ↗` (new tab) · `I already have it`, which reveals "Open Woodshed on your computer and sign in with this account."
  - Sort, Group, filter and Select stay hidden until the library has 6 or more songs.
- **No search results:** "No songs match "**zzzz**"." [Clear search] [Add "zzzz" as a new song →] (desktop, or B5 web).
- **Empty filter:** for example, "No songs with a drum chart yet. Find one from a song's Edit · Map, or write one in Edit · Chart." [Show all].
- **Loading:** an 8-card skeleton in the new geometry. After 8 s: "Still connecting… [Retry]".
- **Offline:** an in-flow banner, never fixed: "You're offline. Songs you've opened recently can still play."
- **Codec:** an in-flow banner: "This browser can't play Woodshed's audio format. Use Chrome, Edge, Firefox or Safari 15 or later." [Dismiss].

### 2.8 Jobs popover (from the Jobs chip or a processing card)
- **Lists every job kind:** split, beat detection, chart import. Beats and imports are invisible today.
- **Each row:**
  - cover 40, title (or `"harbor lights ada moreno"` in quotes until `job.meta.title` arrives);
  - stepper `Fetch ✓ — Split ● 46% — Finish — Ready`;
  - line `Splitting on Kyle's MacBook · started 1:42 ago · about 2 min left`;
  - `2 songs ahead of this one`;
  - settings line `Balanced · 4 stems`;
  - `job.message` in 12 `--ink-3` when present (computed today, never shown);
  - source `youtube.com/… ↗`;
  - actions: `Cancel` (quiet danger) or the failure's primary action, plus `Details`.
- **Footer:** "Processor ready · MacBook Pro" (desktop), or `Restart processor` when offline.

---

## 3. Adding songs

### 3.1 Entry points (all open the same Add sheet at `/add`)
- `＋ Add song`.
- `N` in Library.
- Palette: "Add…".
- `⌘V` in Library when the clipboard holds a URL. It pre-fills only; nothing is submitted.
- **Dropping files anywhere in Library.** A full-window target reads "Drop to add 3 files". The sheet opens with the files listed; nothing uploads until you confirm. Today's silent instant upload (`library.js:604-625`) is deleted.
- Search no-result "Add 'x'".
- Electron menu File → Add Songs… (⌘N).

### 3.2 Add sheet (desktop app, or web with B5)
**Container.** Laptop: a centred 640 px dialog. iPad: a bottom sheet at 90% height with a grabber. Contents, top to bottom:

1. **Title:** "Add a song" 24/700.
2. **Omnibox:**
   - 56 px tall, 18 px text, autofocused.
   - Placeholder: "Paste a link or search for a song".
   - Trailing `Choose files…` quiet button; on touch, also `Paste`.
   - Hint line, 13 `--ink-3`: "YouTube, SoundCloud and Spotify links · MP3, WAV, FLAC, M4A, AAC, OGG, Opus, AIFF, WMA".
   - The whole sheet is a drop zone.
3. **Resolution area** (live, 400 ms debounce):
   - **URL:** one candidate row: thumbnail 96×54, title, channel, duration, source icon. *Needs companion `/resolve` (B4).* Until then: "We'll fetch this link when you press Add" plus the raw URL.
   - **Free text:** 3–5 radio rows (72 px; 80 coarse), first preselected; ↑/↓ move.
     - Each row: thumbnail, title, channel, duration, and badges derived from the title (`Official`, `Live`, `Cover`, `Lyrics`).
     - *Needs B4.* Until then, one honest line: "Woodshed will search YouTube and use the top result for "…". You can check it when it's ready." That check happens on first open (§3.5).
   - **Spotify link:** "Spotify doesn't allow downloads. We'll find this song on YouTube:" then candidates (B4) or the single-result line.
   - **Files:** one row each with name, size and duration (from `<audio>` metadata), plus ✕.
     - Non-audio files are flagged inline and excluded: "notes.pdf isn't audio. Woodshed accepts MP3, WAV, FLAC, M4A, AAC, OGG, Opus, AIFF and WMA."
     - A single file can get a title override.
   - **Duplicate** (client check on same source URL, or title+artist case-folded with duration ±2 s): "**Already in your library:** Harbor Lights — Ada Moreno [Open it] [Add another version]".
4. **Defaults line** (one line, 14 px): "Split for **drums** · **Balanced** quality · 4 stems [Change]".
   - `Change` expands in place:
     - **Stems** segmented: `Full band · 4` / `Full band + guitar & piano · 6` / `Drums + rest` / `Vocals + rest` / `Bass + rest`;
     - **Quality** segmented: `Fast · Balanced · Studio`, each with an estimate once local job history exists ("~2 min on this computer"), stored in `ws.prefs.jobStats`;
     - ☐ "Use these for future songs" (writes `settings.save`);
     - hint: "Higher quality takes longer. You can re-split any song later."
     - Custom model, passes and overlap stay in Settings → Processing.
   - If a layout would remove the user's instrument stem: "Your guitar won't be a separate track with this layout."

   **Defaults from the instrument profile:**
   | Profile includes | Stems | Model |
   |---|---|---|
   | only drums, bass, vocals or other (or no profile) | Full band · 4 | Balanced (`htdemucs_ft`) |
   | guitar or keys | Full band + guitar & piano · 6 | `htdemucs_6s`, Balanced passes and overlap |
   | — | Two-part splits are **never** the default | — |

5. **Footer:**
   - Device line: "Processing on this computer · ● Ready" (or the B5 device picker).
   - `Cancel` (quiet) and primary `Add & split`, which becomes `Add 3 files` for multiple files.
   - `⇧↵` = add and keep the sheet open (hint "⇧↵ add another").

**After submit:**
- The sheet closes. The new card appears at the front of the grid under a thin "Adding" divider, whatever the sort, with a 1.5 s accent ring. Focus moves to it.
- Toast: "Adding **Harbor Lights** · [Undo]". Undo lasts 10 s and calls `jobs.cancel`.
- A polite live region announces the same text.
- **Errors render inline under the omnibox with the input kept** (§3.6). There is no modal and no danger-styled OK.

### 3.3 Web and iPad
Same sheet, different body.
- **No paired processor:**
  - Panel: "**Splitting happens on your computer.** Woodshed for Mac, Windows or Linux downloads songs and splits them into stems. Everything you add appears here and on your iPad automatically."
  - Platform-detected primary `Download for macOS (Apple Silicon) ↗` (new tab), then `Other platforms`, `Copy download link`, and on iPad `Share download link` (`navigator.share`).
  - Tertiary: `Open the example song`.
- **Paired processor online (optional B5):**
  - Header: "Your **MacBook Pro** will split this · ● Online ▾".
  - Links and searches work and queue to that `deviceId`.
  - Files are disabled with "To add files, drop them into Woodshed on your computer."
  - Offline device: "MacBook Pro is offline. Songs you add start when it's back."

### 3.4 Pipeline display (card, Jobs popover, toast)
| Stage | Card line (13 px) | Rail |
|---|---|---|
| queued | `Waiting · 2 ahead`, or `Waiting for MacBook Pro (offline)` | empty, striped |
| upload | `Uploading · 12 of 31 MB` (**real bytes**: `addFiles` switches to XHR `upload.onprogress`) | determinate |
| download | `Fetching audio · 38%` | determinate |
| separate | `Splitting · 46% · ~2 min` (ETA after 15 s from a moving rate; hidden if unstable) | determinate |
| finalize | `Finishing` | shimmer (reduced motion: static 90%) |
| beats (job, or B6 chained) | `Finding bars · 30%` | determinate |
| done | normal card plus the New dot; moves to its sorted place (260 ms FLIP) | — |

### 3.5 Completion
- **Toast** (held while the transport plays): "**Harbor Lights** is ready [Practice]".
- **In the Stage while playing:** nothing appears until Stop. Then a `1 ready` chip shows in the identity row.
- **Desktop, window unfocused:** a native notification "Harbor Lights is ready to practise". Opt-out in Settings → Processing.
- **Search-added songs without B4:** on first open, a one-time banner in the status line area reads "Is this the right recording? **Harbor Lights — Ada Moreno (Official Audio)** · YouTube · 3:41 [Yes] [Wrong song — search again] [Delete this one]".

### 3.6 Errors
Each error has one sentence, one primary action and `Details`. Details is a disclosure with the raw text in mono, selectable, plus `Copy`. Never a tooltip, never `alert`.

| Cause | Sentence | Primary | Secondary |
|---|---|---|---|
| YouTube bot check, auto-retry pending | "YouTube asked for a sign-in check. Woodshed will try again in a few minutes." | `Try now` | `Upload a file instead` |
| Bot check, retries exhausted | "YouTube blocked this download." | `Search for another version` | `Upload a file instead` |
| Private, removed or region-locked | "This video isn't available. It may be private, removed or blocked in your region." | `Search for another version` | `Dismiss` |
| Processor offline at submit (inline) | "Woodshed's processor isn't running on this computer." | `Restart processor` | `Details` |
| Unreadable file | "This file couldn't be read as audio." | `Choose another file` | `Dismiss` |
| Disk full (local) | "This computer is out of space for processing." | `Details` | `Dismiss` |
| Cloud storage full | "Your cloud storage is full (2.0 of 2.0 GB)." | `Manage storage` | `Dismiss` |
| Account paused | "Adding songs is paused on this account." | `Plan & storage` | — |
| Separation crash or OOM | "Splitting failed on this computer." | `Try again` | `Try Fast quality` |
| Unknown | "Something went wrong while adding this song." | `Try again` | `Dismiss` |

Stale copy is deleted: "Retry the desktop connection in Settings" and "switch stems to FLAC in Settings".

### 3.7 Re-split (was Reprocess)
- Dialog "Re-split Harbor Lights" with Stems and Quality segmented controls.
- Cost line: "Runs on MacBook Pro · about 4 min at Balanced · replaces the stems; your loops, map, spots and chart are kept."
- Primary `[Re-split]`.

---

## 4. The Stage (practice surface)

### 4.1 Layout rule
`stageLayout = (vw / vh ≥ 1.15 && vw ≥ 1000) ? 'rail' : 'band'`

- **Rail** (laptop on a stand, desktop app, iPad landscape):
  - The music fills the left column at full height.
  - A right **rail** holds readouts at the top and controls at the bottom.
  - Rail width depends on Distance: Near 232, **Stand 264**, Kit 312. Subtract 32 when vw < 1280.
  - The **song strip** sits under the music.
- **Band** (iPad portrait, narrow windows):
  - **HUD band** on top, music in the middle, **song strip** and **dock** at the bottom.
  - The music scroller always spans the full width. HUD and dock are opaque bands, and Focus changes only the *height* of the music area, so alphaTab never relayouts on chrome changes. Its layout depends only on width.
- **Switching layouts** (resize or rotation) relayouts once, debounced 150 ms, with the playing bar kept at the same screen fraction.

**Vertical budget, iPad portrait 820×1180, Stand:**
- status 24 + identity 44 + readouts 88 + music **≈860 (73%)** + strip 56 + dock 88 + safe area 20.
- Focus: 24 + readouts 88 + music **≈1048 (89%)** + 20.

**Laptop 1440×900:** the music column is 1176 × 844 (strip 56). Focus mini-rail: 1320 wide.

### 4.2 Wake, interruptions, install, media keys
- **Wake lock:** `navigator.wakeLock.request('screen')` while the Stage is open and (playing, or stopped for less than N minutes).
  - N options: 5 / **10** / 30 / Always while open.
  - Re-acquire on `visibilitychange → visible`.
  - A tiny `☼` in the identity row shows when the lock is held.
  - Settings → This device reports support and gives the fallback tip: "Set Auto-Lock to Never while practising."
- **Interruptions:** on `AudioContext` `statechange` to `interrupted`/`suspended` while playing, or `visibilitychange → hidden` (iOS):
  - pause, keep the position as the cue, flush the save;
  - status line: "Paused — audio was interrupted. Press Play to continue."
  - Never auto-resume.
- **PWA:**
  - `manifest.webmanifest` (`display: standalone`, `orientation: any`, icons, `theme_color` per theme), `apple-mobile-web-app-capable`, `viewport-fit=cover`.
  - Safe-area insets on the dock and rail.
  - **Desktop:** add `/manifest.webmanifest` to the static allow-list in `desktop/main.cjs:41`. Fonts and icons ship through Vite imports so they land in `/assets/` (never `public/fonts`, which Electron would answer with index.html).
- **Media Session** (behind the flag `ws.flags.mediaSession`):
  - `play`/`pause` → Play/Stop; `previoustrack` → Again; `nexttrack` → next section.
  - Safari may need a playing media element. Test a silent looping `<audio>` on a real iPad before promising headset control. **No UI copy promises headset buttons until the device matrix passes (§9.8).**

### 4.3 HUD readouts (sizes at Distance = Stand; ×0.8 Near, ×1.3 Kit)
| Readout | Content | Band (iPad) | Rail (laptop) | Rules |
|---|---|---|---|---|
| Identity row | `‹` · cover 32 · **Glasshouse** · Northbound · `E minor · Drop D` (key/tuning chips only if set) · `Notes` chip · `⋯` | 15 px, 44 px row | 15 px, two lines | Dims to 40% while playing. `‹` needs a 600 ms hold while playing (§4.9). |
| **Section** | `Chorus` (current section or marker; hidden if none) | 40/700 | 40/700 | 160 ms crossfade on change |
| **Next** | `next: Verse 2 · 6 bars`; in the last 2 bars `Verse 2 in 2 · 1` in `--now` | 17 | 17 | Mapped with sections only. Unmapped with markers: `next: Marker 4 · 0:12`. |
| **Position** | Mapped: `13 · 2` (bar · beat). Before bar 1: `Pickup · 3`. Unmapped: `1:12` (m:ss). | 56 tabular | 64 tabular | Never "Bar —". When mapped, time `0:26 / 1:04` sits underneath at 15 `--ink-3`. |
| **Beat lamps** | One dot per counted beat, meter-grouped (2+2+3 shown with gaps). Downbeat dot is larger; the current one is lit in `--now`. | 18 px dots, 8 gap | 20 px | Mapped only. It is the visual metronome. |
| **Speed** | `75%` plus `84 bpm` (mapped: tempo at the playhead × rate) | 40 + 15 | 40 + 15 | At 100% the value shows in `--ink-3` |
| **Loop** | `LOOP · Chorus` / `Bars 13–20 · pass 3`. With trainer: `Trainer 80 → 100% · step 3 of 7` | 17/600 + 15 | 20/600 + 15 | Hidden when off. "Pass" = completed traversals (§4.6). |
| **Mix** | `DRUMS OUT` (struck-through drum icon), `BASS SOLO`, or nothing for the full mix | 15/700 caps pill | same | Text, never opacity |
| Status line | One transient line (2.5 s): "Marker 4 added — Rename", "Spot saved", interruptions, the hold-to-leave hint | 15 | 15 | `role=status`. The only in-Stage feedback while playing. |

**Count-in overlay.** A centred plate (`--surface` at 85%) over the top of the music shows `4 3 2 1`. The current number is 120 px (Stand) in `--now`, with "Count-in · bar 13" (or "Lead-in · 0:31") beneath at 17. The lamps flash with it. Space or Play cancels; the Play button reads `✕ Count` during the count.

### 4.4 Music surfaces
Each song keeps its own surface choice. Switch it with `V` (cycle) or identity `⋯` → `View: Chart · Road map · Stems`. Default: **Chart** when a drum part exists, otherwise **Road map**.

#### A. Chart (drum part exists): today's alphaTab chart, promoted
- `chart.js` gets `chrome:false` and an API: `setScale`, `setDisplay`, `setFollowStyle`, `onBarActivate`, `setLoopRange`, `setGlass`. Its toolbar moves:
  - section chips → song strip;
  - Loop section → `L` / strip double-tap;
  - Follow → automatic, plus the pill;
  - size → Distance plus pinch plus `=`/`−`;
  - Together / Hands & feet → `⋯` → "**Display:** Together · Hands & feet (this device)";
  - Mute drums → Mix.
- **Default scale** comes from Distance: iPad portrait 120% (staff space ≈ 2.1 mm), laptop 130%. 2 bars per system for dense parts on iPad portrait, 4 on laptop.
- **Follow styles** (per device, `⋯` → Follow):
  - **Scroll:** the playing system is held at 28% (band) or 33% (rail) from the top. Default in rail.
  - **Page:** when the playing system crosses the middle, the view advances half a viewport (200 ms; reduced motion jumps), like a stand page-turner. Default in band.
- **Visuals:**
  - current bar: `--now-soft` fill plus a 3 px `--now` beat cursor;
  - loop: `--loop-fill` band with brackets;
  - bar numbers ≥ 14 px × distance; section labels ≥ 20 px.
- The long-press-then-tap pending state (`chart.js:162-166`) is deleted. Long-press opens the bar menu (§4.9).

#### B. Road map (mapped, no chart): new
A lead-sheet "page of bars", read top to bottom.
- Each section starts a row with a heading `Chorus` 20/700 · `bars 13–20` 14 `--ink-3`.
- Row width: 4 bars (band) or 8 bars (rail, music width ≥ 1100). Rows break at section and meter changes; long sections wrap.
- **Bar cell:**
  - 88 px tall (Stand);
  - bar number top-left, 14;
  - beat ticks along the bottom, grouping-aware;
  - a meter chip on change (`7/8 (2+2+3)`) and a tempo chip on a change > 1 bpm (`♩=96`);
  - a **mini waveform**: stacked stem envelopes in stem colours, your instrument on top at full opacity, others at 55%. **Muted stems are drawn as 1 px outline ghosts with a 45° hatch**, so the "hole you fill" stays visible.
- **Current bar:** 3 px `--now` outline, `--now-soft` fill, a playhead line sweeping across, and the current beat tick lit.
- **Loop:** `--loop-fill` cells, brackets at both ends, 44 px-wide hit areas and a 20 px grip dot.
- **Spots:** a `◆ Bridge walk-up` flag above the start bar.
- **Follow:** the current row is held at 30% from the top (Page style available).
- **Rendering:** per-bar peaks are downsampled from existing `waveform.js` peaks. Rows are virtualised (visible + 2), one canvas per row plus DOM for labels and handles. It shares the waveform drawing module with the Stems surface (§9.2), so there is one renderer.

#### C. Wave page (unmapped): the Road map's honest variant
- Rows are fixed time spans: 10 s (rail) or 8 s (band). Change with pinch or `=`/`−` (4–30 s).
- Second ticks every 1 s, labels every 5 s (`0:45`). Markers show as flags with labels.
- **No bar numbers and no beat lamps.**
- The strip ends with a quiet chip `No bar grid · Get bars →`, which opens the **Get bars** popover:
  - `Tap the beat` (§5.1.3; works on every platform);
  - `Detect beats` (desktop, or B5);
  - `Find a chart online` (→ Edit · Map Find panel).

#### D. Stems: today's Tracks, rebuilt on pointer events
- **View toolbar** (40 px; only on this surface):
  - `[− + Fit]` `[Zoom to loop Z]`;
  - `Grid: Off · Bar · Beat · ½ · ¼ ▾`;
  - `Snap` toggle (`aria-pressed`, ⇧S);
  - `Follow` toggle.
- **Ruler:** in bars (mapped) or time.
- **Track rows:** height split equally (minimum 72). A header of 168 px (laptop) or 128 px (iPad) holds:
  - colour bar, name 16/700, key-cap `1`;
  - `OUT`/`SOLO` state word;
  - `[M] [S]` (32 px fine; 44 coarse);
  - on laptop, a 120 px fader with a `%` value. On iPad the fader lives in the Mix sheet.
- **Muted:** outline plus hatch and `OUT`. **Soloed:** an accent ring plus `SOLO`; the others draw as outlines.
- **Grid lines:** beats at 8% `--ink`, bars at 18%. Drawn only when beats are ≥ 6 px apart, which removes the "blue barcode".
- **Pointer model:** one pointer-events model with `setPointerCapture`.
  - Mouse: click seeks (immediately, even while playing); drag creates a loop (8 px threshold); edges resize; inside moves.
  - Touch while stopped: tap cues; long-press then drag loops; two fingers pan; pinch zooms.
- **Wheel** (as today): vertical zooms at the cursor, horizontal or Shift pans, ⌘/Ctrl or a trackpad pinch zooms. Manual wheel use pauses Follow and shows the pill.
- **Strip:** gains a draggable **viewport bracket** (replaces the overview minimap).

### 4.5 Song strip (sections, overview and progress in one)
- **Size:** 56 px (Stand), full width. It sits above the dock (band) or under the music (rail).
- **Mapped:** one segment per section, width proportional to duration, minimum 56 px. If segments overflow, the strip scrolls and keeps the current one in view.
  - Segments alternate `--surface` / `--surface-2`.
  - Label 15/600; the current segment gets a `--now-soft` fill and a 2 px progress fill.
- **Unmapped:** the full-song mini waveform with marker ticks.
- **Overlays:** playhead tick (2 px `--now`), cue flag (▼ `--accent`), loop bracket (`--loop`), spot diamonds, and the viewport bracket on the Stems surface.
- **Gestures:**
  - **Stopped:** tap → cue to the segment start. Double-tap → loop the section.
  - **Playing:** tap → **quantized jump**. The segment shows `→ Verse 2` pending, and playback jumps at the next downbeat (unmapped: immediately). Tap again to cancel. Mouse click behaves the same, because a quantized jump is a musical action, not a seek.
  - **Long-press / right-click** → `Play from here` · `Loop this section` · `Extend loop to here` · `Save as spot…` · `Rename…` (inline field; mapped songs write the bar label) · `Edit sections in Map`.
  - **Drag:** when stopped, scrubs with a label `Bar 41 · Bridge`. Mouse drag (any time) creates a loop across segments.
- **Keyboard:** the strip is a `role=slider`. Focusable segments use roving tabindex: ←/→ moves between segments, Enter plays, L loops.

### 4.6 Controls
**Transport semantics (one model, everywhere):**
- **Play/Stop** (Space): starts at the **loop start** when a loop is on, otherwise at the **cue**. Stop returns to the cue (Settings: or stay where it stopped).
- **Pause/continue in place** (⇧Space; long-press Play).
- **Again** (Enter): jump to the loop start, else the current section start, else the cue, and play. Uses count-in if count-in is on. Works while playing or stopped.
- **Loop toggle** (L), when no loop is defined: loop the **current section** (mapped with sections) → else the **current 4-bar phrase** (mapped) → else **±5 s around the playhead** (unmapped). Never "the visible window".
- **Pass:** a traversal from the loop start to the loop end with no seek, stop, speed change or loop edit in between. Counted from the engine `wrap` event.

**Band dock** (iPad portrait): one row, 88 px plus the safe area. Controls 64 tall (Play 80), 12 px gaps, 16 px padding.
```
[⟲ Again 72] [▶ Play 96] [⟳ Loop 72] [ − | 75% | + 184 ] [Count-in 80] [Drums OUT ⌃ 104]
```
- Total 608 + 60 + 32 = **700 px**. That fits an iPad mini (744) and an Air (820).
- Icons are 24 px above 13/600 labels. No glyph-only buttons.
- Again is at the far left, never next to Play's tap-zone edge without the 12 px gap.

**Rail controls** (laptop): a 2-column grid of 56 px rows (Play 72), 8 px gaps, at the bottom of the rail.
```
[    −    |   75%   |    +    ]
[ Count-in ][  Click   ]
[  Loop    ][ Drums OUT ⌃ ]
[ ⟲ Again  ][  ▶ Play  ]
```

| Control | Tap / click | Long-press / ⌃ segment | Key | State shown |
|---|---|---|---|---|
| Play | Play/Stop as above. While audio loads: a progress ring "Loading 62%"; pressing arms "Play when ready". | Pause/continue | Space, ⇧Space | ▶ / ■ / `✕ Count` |
| Again | as above | — | Enter | — |
| Loop | Toggle (smart default above) | Loop card | L, ⇧L = loop this section | `--loop` fill when on; HUD range |
| Speed | `−`/`+` ±5% within **50–150%**; tap the value → Speed sheet | Value long-press: 100% ↔ last | `,` `.` (⇧ ±1%), `` ` `` | `75%` |
| Count-in | Toggle (default length 1 bar) | Click sheet | C | lit plus sublabel `1 bar` |
| Click (rail; on the band it lives in the Click sheet) | Toggle the continuous click | Click sheet | K | lit |
| Mix | Main zone: **Minus me** (mutes the profile instrument's stems). No profile or no matching stem → opens the Mix sheet. | `⌃` zone (44 px) or long-press: Mix sheet | M (⇧M Only me) | `Drums OUT` with strikethrough / `Mix` |

Previous and next section on the band are reached from the strip, `[` `]`, PageUp/PageDown and pedals.

### 4.7 Sheets and cards
- **Band:** bottom sheets, max 60% height, grabber, dismissed by swipe-down, ✕ (44 px), Esc or tapping outside.
- **Rail:** popovers anchored left of their rail control, 360 px wide.
- None of them pause playback, push history or relayout the music.

**Speed sheet:**
- Value `75%` (56) plus `84 bpm`.
- Preset chips (56 px; 2 rows on band): `50 · 60 · 70 · 75 · 80 · 85 · 90 · 100 · 110 · 125`.
- Fine `−1` / `+1`.
- `Keep pitch` toggle, now **per song** (stored with the rate), with the device default in Settings.
- **Trainer:**
  - steppers `Start 70%`, `End 100%`, `Step +5%`, `Passes per step 2`;
  - `Start trainer` / `Stop trainer`;
  - an inline "Trains on: Chorus (bars 13–20)" (loop if on, else the current section, else the whole song);
  - it advances on engine `wrap` with a scheduled speed change exactly at the wrap;
  - the last step reads "Trainer done — 100%".
  - There is no "clean pass" wording.

**Click sheet:**
- `Count-in`: Off · 1 bar · 2 bars · 2 beats · Custom (1–16, Bars | Beats). Today's range is preserved.
- `Count in every loop pass` (default **on** when looping; engine §9.5).
- `Click`: Off · During count-in only · Always ("Always" is today's metronome on).
- `Accent downbeats`; `Click volume` slider with a value 0–100.
- `Play the song during count-in` (today's "Audible pre-roll").
- `Visual click`: beat lamps (always) plus `Flash screen edges on downbeats` (off; a 6 px `--now` inset glow, 60 ms in / 180 ms out; reduced motion: on/off, no fade).
- Read-only line: "At the cue: ♩ = 96 · 4/4 · from the map".
- **Unmapped:**
  - count-in becomes "**Lead-in 2 s**" (audio pre-roll, no fake clicks);
  - Click shows "Needs a bar grid" with [Tap the beat] [Get bars].
- Footer: `Tempo & bars wrong? Edit map →`.

**Mix sheet:**
- **Top row:** `Minus me: Drums` (56 px toggle), `I play: Drums ▾` (edits the profile inline), `Only me` toggle, `Full mix` (resets mute, solo and levels; undoable).
- **Mode switch:** `Tap to: Mute · Solo` segmented, so solo is visible on touch. Long-press a pad also solos; Shift-click solos on laptop.
- **Stem pads**, in canonical order drums, bass, guitar, piano, vocals, other (2-stem: the pair):
  - 120×168 on band (3 per row), 160×96 in the rail popover (2 per row);
  - colour bar, name 17/700, state word `ON` / `OUT` (struck through, hatched) / `SOLO` (accent ring);
  - the level as a vertical fill you drag inside the pad, double-tap for 100%, value shown;
  - key-cap `1`–`6` in the corner.
- **Chart playback:** `Off · Quiet · Loud` when a part exists. This is today's Listen synth level. The Transcribe "Recorded drums: In/Out" control stays, synced to this mix.
- **No separate stem for your instrument:**
  - desktop: "This song wasn't split with a guitar part. Muting 'Other' instead. [Re-split with 6 stems]";
  - web: "…Re-split it from Woodshed for desktop."

**Loop card:**
- Range `Bars 13–20 · Chorus (8 bars)` or `0:31.2–0:41.0 (9.8 s)`.
- Start `◀ ▶` and End `◀ ▶`: by bar (Alt: by beat) when mapped; by 0.1 s (Alt 50 ms, Alt+Shift 10 ms) when unmapped. Today's fine nudges are preserved.
- `◀ Move 8 bars` / `Move 8 bars ▶` (shift by its own length).
- `Count in every pass`; `Play N times then stop`: Off · 2 · 4 · 8.
- `Between passes` (Phase 5): None · 1 bar rest · Call & response.
- `Trainer…`; `Save as spot…` (inline name, pre-filled `Chorus` or `Bars 13–20`; key B); `Clear loop` (undoable).

**Spots list** (`J`, or identity `⋯` → Spots):
- Rows: name · `bars 41–48` · `85%` · `practised 2 days ago · 14 times` · `▶`.
- Swipe left or right-click → Rename / Update from current / Delete (undo toast).
- Selecting a spot sets loop, speed and cue, then closes.

**Notes card** (the HUD `Notes` chip):
- A non-modal card at the top-right of the music, 320 px, 17 px text: the song's practice notes, key, tuning and tags.
- It stays open until closed. Spot notes show from the spot flag's long-press.

### 4.8 Loop creation on the music
- **Mouse:** drag across bars (8 px threshold) creates a loop snapped to bars, or 0.1 s unmapped. Alt-drag snaps to beats. Edges resize; dragging inside moves it. Allowed while playing.
- **Touch, stopped:** long-press (350 ms, haptic where available) then drag. Releasing without a drag opens the bar menu.
- **Touch, playing:** no loop creation on the music. Use the strip, the Loop button or long-press → menu.
- **Keys:**
  - `I` / `O` = loop in/out at the playhead (bar-snapped; ⇧ unsnapped);
  - `⇧[` / `⇧]` = move by length;
  - `⌫` = clear (undoable).
- **Handles:** a 44 px × row-height hit area, a 20 px grip dot and a 3 px `--loop` edge. Visible whenever a loop exists; 50% opacity while playing (still mouse-draggable).

### 4.9 Glass: what touches do
| Gesture on the music | Stopped | Playing, touch/pen | Playing, mouse |
|---|---|---|---|
| Tap / click | Cue to the nearest beat (mapped) or that time | **No seek.** A pill at the touch point for 3 s: `▶ Play from bar 23`; tap the pill to jump | Seek immediately |
| Double-tap / double-click | Play from there | Jump there immediately (deliberate) | same |
| Long-press / right-click | Bar menu: `Play from here · Cue here · Loop this bar · Loop this section · Loop 4 bars from here · Save spot here… · Add marker here` | same menu | same |
| One-finger vertical drag / wheel | Scroll; Follow pauses | Scroll; Follow pauses; `⤓ Back to playhead` pill (56 px, bottom-centre of the music). Resumes after 8 s idle, or on Play/Again/F. | same |
| Pinch / ⌘-wheel | Chart size 80–200% (CSS transform live; one relayout on release) | same | — |

**Leaving while playing:**
- `‹` needs a **600 ms hold**, with a ring filling in the button. A tap shows "Hold to leave — playback will stop".
- **Esc never navigates while the transport runs.** It closes an overlay or exits Focus; otherwise it shows "Stop playback first (Space)".
- When stopped, Esc in the Stage goes to the Library (desktop only; on iPad use `‹`).
- Keyboard users can always Stop, then Esc. Browser Back works (state is saved).

**Spacing:** dock and rail controls are ≥ 64 px (band) or ≥ 56 px (rail), with ≥ 12 px between Play and its neighbours.

### 4.10 Chrome while playing, and Focus
- **While playing:** the identity row dims to 40% and the controls to 70% (still fully live). HUD readouts stay at 100%. Toasts are held, the update dot is hidden, and **nothing moves or resizes**.
- **Focus** (`F`, `⋯` → Focus, or double-tap the HUD readouts):
  - **Band:** hides the identity row, strip and dock. Only the height changes, so there is no relayout. A 72 px invisible **reveal zone** along the bottom shows the dock for 5 s on tap. Pedals and keys keep working.
  - **Rail:** collapses to a 120 px **mini rail** showing Section, Position, lamps, Speed and Play. This is the only Focus change that relayouts, once, with the anchor bar preserved.
  - `F` or Esc exits. Focus is remembered per device.

### 4.11 Readability: Distance
One per-device control, `Distance: Near · Stand · Kit`, in `⋯` and Settings → Practice. It scales the HUD type, chart scale and rail width. **Controls never scale.**

| Distance | × | Eye distance | Position (rail / band) | Section | Chart (laptop / iPad portrait) | Rail width |
|---|---|---|---|---|---|---|
| Near | 0.8 | 50–70 cm | 52 / 44 | 32 | 110% / 100% | 232 |
| **Stand** (default) | 1.0 | 80–120 cm | 64 / 56 | 40 | 130% / 120% | 264 |
| Kit | 1.3 | 1.2–2 m | 84 / 72 | 52 | 160% / 150% | 312 |

**Rules:**
- Glanceable numerals need cap height ≥ distance ÷ 160 (≈ 9.5 mm at 1.5 m ≈ a 64 px font on a 14″ laptop at ≈ 0.21 mm/px).
- Staff space ≥ 2 mm at Stand and ≥ 2.6 mm at Kit.
- HUD text is never below 15 px.
- Tests assert computed font sizes per Distance.
- A Distance change relayouts once, with the anchor kept. Each scale's layout is cached.

### 4.12 Open, resume, loading
1. Render immediately from saved practice state: identity, surface, strip, speed, loop, mix, minus-me. **Every control is live**; changes queue until the engine is ready.
2. The chart renders as soon as the part loads. The Road map renders from cached peaks, or a bar grid with shimmering cells.
3. Play shows a ring with `Loading audio 62%` → `Decoding 3 of 4` → `Preparing pitch-preserving playback`. The full-screen "Preparing your song" card is deleted.
4. Scroll so the cue (or loop start) sits at the follow position.
5. **Resume chip** in the status line for 4 s: "Back at **Chorus loop** · 75% · Drums out [Start over]". Start over = cue 0, loop off, 100%, as one undo step.

- **Saved per song:** cue, surface, anchor bar, loop and options, rate, keep-pitch, mix, minus-me, trainer, spots, markers, `lastAt`.
- **Per device:** Distance, Focus, Display, Follow style, pedal profile, Stems grid/snap/zoom.
- **Load errors** appear in the music area, not behind a live Play button:
  - "Couldn't load the audio for this song. [Try again]";
  - missing stem → [Re-split] (desktop);
  - codec → browser advice.
  - Other controls get `aria-disabled` with a reason.

### 4.13 Shared Stage (`/share/:token`)
- The same Stage, read-only.
- The identity row shows "**Shared** by Kyle K." plus `Add to my library` (signed in) or `Sign in to keep a copy` (the existing `?save=1` flow).
- Edit is hidden.
- Markers, spots, speed and mix save **on this device only** (localStorage keyed by token). A one-time status line says: "Changes stay on this device until you add the song to your library."
- After `shareAudio.save`, local practice state migrates into the new song's `practice`.
- The theme picker in the shared header is deleted (it follows the system).

### 4.14 Practice undo
- `⌘Z` / `⇧⌘Z` in the Stage. Stack depth 50, per song per session.
- Covers: loop set/move/clear, speed, mix and minus-me, marker add/rename/delete, spot save/update/delete, section rename from the strip, Start over.
- Speed and level changes within 1 s coalesce.
- Each undo shows "Undid: speed 85% → 100% [Redo]": a toast when stopped, the status line when playing.

---

## 5. Edit postures

### 5.0 Common frame
- **Enter** with `E` (last tab), `⋯` → Edit map / Edit chart / Edit details, or links. **Exit** with `Done` or Esc (when nothing is selected) back to the Stage at the same position.
- **Shared session:** engine, loop, speed and mix carry across. Edit is not a new song session.
- **Posture bar** (48 px) with a 2 px `--edit` top border and the label "Editing map" / "Editing drum chart" / "Editing details". The theme follows the app theme, not the Stage.
- **Slim transport** (56 px): `⟲ ▶ ‖`, bar.beat plus time, loop chip, speed chip, count-in and click toggles, Mix chip. Same commands.
- **Inspector:** right side, 320 px on laptop. On iPad portrait, a bottom sheet at 45% that collapses to a 56 px header. iPad also shows the hint "Map editing is roomier in landscape".
- **Key-cap hints** appear only on `(hover:hover) and (pointer:fine)` after keyboard use. On touch, buttons stand in for them.

### 5.1 Edit · Map (tempo, meter, sections, detection, imports)
**Main area, top to bottom:**
- bar ruler with meter chips;
- **sections lane** (32 px, editable blocks);
- **tempo lane** (96 px): flat steps, ramps, amber-striped suspect spans; pins are 12 px diamonds with 24 px hit areas (44 on coarse);
- stem rows on the shared Stems renderer, with M/S and a fader per row;
- the strip.

Grid ▾, Snap (⇧S), `− + Fit` and `Z` sit in a 40 px toolbar.

**Inspector, selected bar or pin:**
- **Go to:** `Bar [ 41 ] Go` · `◀ Bar` `Bar ▶` · `⏮ ⏭` previous/next pin or meter change.
- **Meter:** Beats `[−] 4 [+]` · Unit `1 · 2 · 4 · 8 · 16` · Groups `2+2+3` · **Pickup length** (bar 1) · **Apply to** `This bar · Until next change · To the end` · **Keep in place** `Beats · Bar lines` · `Apply ↵`. This is today's Edit bar form, every field kept.
- **Label:** `[Bridge]`.
- **Tempo:** `♩ [96.00]` · ☐ Ramp to next pin (R) · `[×2]` `[÷2]` · Tail tempo `[−] [+]` (⌥↓/⌥↑; Shift ±0.1).
- **Pin:** "● Locked at 0:48.120" or "free" · `[Pin downbeat D]` `[Pin beat T]` / `[Unpin ⌫]` · Nudge `[−10 ms] [−1] [+1] [+10 ms]` · **Renumber** "This pin is bar [ 41 ]" (⌥←/→).
- **Tools:** `[Tap along Space]` · `[Calibrate tap timing…]` · ☐ Snap taps to drum hits · `[Preview these bars P]` (shows "Previewing bars 41–48 · Esc to stop"; your loop is restored) · `[Detect beats]` · `[Find a chart…]`.
- **Status line:** tones info / ok / error. The existing refusal guards (`player.js:878-900`, `part.js:65-75`) render here.

**Other rules:**
- **Undo:** ⌘Z targets the map stack in this posture, with labelled `↶ Undo` `↷ Redo` buttons. Detection stays undoable ("Beat grid found · Undo").
- **Map origin:** any edit, detection, tap or import writes `songMap.origin`. That switches bars on in the Stage.
- **Markers → sections:** when a real map exists and markers exist, a banner reads "You have 5 markers. [Turn them into sections] (snaps each to the nearest bar)", with Undo.

#### 5.1.1 Get a map (inspector content when unmapped)
1. **Detect beats** (desktop or B5): "Listens to the recording and places every bar and beat. About 30 s on this computer." `[Detect]`. While running, the job shows in Jobs as `Finding bars · 30%`. Web without B5: "Needs Woodshed for desktop [Get it ↗]".
2. **Tap along:** "Play the song and tap downbeats (D) or every beat (T)." `[Start tapping]`.
3. **Find a chart online / import a file:** `[Find a chart…]`.

#### 5.1.2 Find a chart (a side panel replacing today's app-freezing Find/import)
- **Search:** Chorus Encore and the Harmonix set, pre-filled and auto-run. Results are radio rows (title, artist, source, `Drum chart` badge, duration).
- `Import a file…` (Guitar Pro, MIDI, Clone Hero `.chart`, text maps; today's limits).
- **Other sources:** links to enchor.us and Songsterr (kept).
- **Align:** audition with the main transport (Space), offset `[−100][−10] 0 ms [+10][+100]`, `Line up first downbeat with the cue`, Reset, and the duration-mismatch warning.
- **Commit:** `Use their map` · `Use map + drum chart (312 hits)` · `Keep my map` · `Cancel`.
- Only the panel's own keys are active while its field has focus. Nothing else is made inert.

#### 5.1.3 Tap the beat (quick sheet; reachable from the Stage without entering Edit)
- 480 px sheet (band: 60% bottom sheet): "Play the song and tap every beat for 2 bars."
- A **160×160 tap pad** (T or Space also taps).
- Live "≈ 92 bpm · 6 taps".
- Result: "92 bpm · 4/4 · first downbeat 0:00.41 [Use it] [Try again] [Open map editor]".
- It builds a constant-tempo map via `fromBeats` (first and last taps pinned), sets `origin: 'tapped'`, and is undoable.

### 5.2 Edit · Chart (Transcribe): preserved, re-framed
Editor internals, save model, keys and alphaTab rendering are unchanged. Only the frame changes.

- **Toolbar** (44 px; 52 coarse):
  - View `Score · Lanes`;
  - step values `♩ 1/4 · ♪ 1/8 · 1/16 · 1/32 · 1/64` (with key hints 1–7), `• Dotted`, `Tuplet ▾`, `Skip (R)`;
  - "Writing: **Snare** (S)";
  - `↶ Undo` `↷ Redo` (text plus glyph at ≥ 1200 px, icon plus aria-label below);
  - range nav `Bars 17–32 ‹ ›` plus a section jump menu;
  - `Edit ▾` and `Part ▾`.
- **Edit ▾:** Copy, Paste, Repeat bars…, Move notes…, Tuplet on this beat…, Mark bars reviewed. Each shows its shortcut.
- **Part ▾:** Export `.woodshed.json`, Print, **Open .woodshed.json part…** (renamed from "Import…"), Drum part from file (Guitar Pro, MIDI, Clone Hero)…, **Drum keys…** (remap dialog), **Note list**, **Show every kit piece**, Keyboard shortcuts.
- **Bar meter & label…** and **Align in tempo map…** switch to Edit · Map at that bar.
- **Inspector tabs:** `Kit · Properties · Listen`. Kit shows each pad's key letter. Listen keeps Recording / Notation / Both, levels, and "Recorded drums: In/Out" (synced with Mix).
- **Part layout:** `Together · Hands & feet`, labelled "saved with the part", in the Properties footer. It is distinct from the Stage's device-level **Display**.
- **Score paging:** keep **16-bar pages** in v2 (see Decisions). Continuous scroll is a later experiment behind a flag, only after the score/lanes visual baselines and an iPad perf budget pass.
- **Save status** stays visible: Saved / Saving… / Saved on this device / Another version exists [Review]. Recovery ("Load saved version") is kept.
- **Key scope:** drum letters, 1–7, `+ −`, `.`, `/`, A, ⇧A, G, R, N, ⌘C/⌘V/⌘D/⌘A and ⌫ apply only while the score or lanes have focus. Only Space, ⇧Space, Enter, Esc, PageUp/PageDown, ⌘K, `?` and E pass through.
- **iPad portrait:** score on top, toolbar, and a **kit pad bank** docked at the bottom (4 × 7 pads of 56 px, grouped by colour). Inspector tabs open as sheets.
- The legacy Align bar / Align beat dialogs are deleted (unreachable today).

### 5.3 Edit · Details (metadata page)
- **Song:** title*, artist, album, album artist, year, genre, track, disc.
- **Practice:** key, tuning, tags (chip input), notes (shown in the Stage Notes card).
- **Artwork:** cover, `Choose another cover`, `Upload image`, `Remove`.
- **Match:** "Matched on MusicBrainz" / "Not sure this is right" / "No match found" · `[Yes, this is right]` (locks the match) · `[Find another match]` with inline results and the field-diff review with checkboxes (existing logic), plus attribution.
- **Behaviour:** autosave per field on blur, with an inline "Saved", and `Revert` for fields changed this session. No global Save, so `window.confirm` is gone.
- **Bulk** (from Library selection): the same page in bulk mode, with per-field "Apply to 3 songs" checkboxes ("Multiple values — unchanged").

### 5.4 How editing relates to practice
- The Stage shows *results* (sections, bars, chart, click), never editing controls.
- **Edits allowed in the Stage** are cheap, musical and undoable: a marker or section at the playhead (S, no dialog while playing; it gets a default name), renaming a marker or section from its long-press, saving a spot (B), loop edits, and Tap the beat.
- **Wrong data is one hop away:**
  - Click sheet → `Tempo & bars wrong? Edit map →`;
  - strip `No bar grid · Get bars →`;
  - chart empty state "No drum chart yet. [Find a chart] [Import a file] [Write one]";
  - shared variant: "No drum chart was shared."

---

## 6. Sharing, settings, account, admin, desktop, first run

### 6.1 Sharing
- **Entry:** Stage `⋯` → Share…, or the card menu.
- **Dialog** (480 px), "Share Glasshouse":
  - body: "Anyone with the link can listen and practise along. They can save their own copy.";
  - ☑ Sections and tempo map; ☐ Drum chart;
  - `[Create link]` → a read-only field plus `[Copy link]` → "Copied ✓" (2 s);
  - note "A new link replaces the old one.";
  - `Stop sharing` (quiet danger) → Dialog "Stop sharing? The link stops working for everyone."
- **Share origin** comes from `VITE_SHARE_ORIGIN` instead of the hard-coded host (`share-dialog.js:14`).

### 6.2 Settings (`/settings/:section`)
- **Layout:** laptop is a 200 px section nav plus content ≤ 720 px; iPad portrait is a list, then a detail page.
- **Saving:** every control saves on change with an inline "Saved". Failure shows "Couldn't save · [Retry]".

| Section | Contents |
|---|---|
| **Practice** | When Stop is pressed: Return to cue / Stay · Default count-in · Count in every loop pass · Keep pitch by default · Distance (this device) · Follow style (this device) · Keep screen awake: 5 / 10 / 30 min / Always · Edge flash · Classic keys (Enter pauses), shown for v2.0–v2.1 only |
| **Instruments** | "What do you play?" multi-select chips (56 px): Drums · Bass · Guitar · Keys · Vocals · Other; primary badge · Open songs with my part: In / Out · the stem mapping in plain words ("Guitar → guitar stem on 6-stem songs, otherwise Other") |
| **Pedals & keys** | Pedal mode on/off · profile · `Learn my pedal` · mapping table (tap / hold / double-tap) · `View keyboard shortcuts` · *(desktop)* Background shortcuts (opt-in) · *(Chromium/desktop, P2)* MIDI devices |
| **Processing** (desktop; on web it shows processor status plus the B5 device list) | Processor status + `Restart processor` · Default stems · Quality (one segmented control; the duplicate slider is deleted) · Advanced `<details>` (model, passes 0–10, overlap 0.1–0.75 → "Custom") · audio format/bitrate · Notify when songs are ready · Import an old Woodshed library · Export original audio |
| **Appearance** | Theme: System · Light · Dark · Stage: Match theme · **Always dark** (default) · Reduce motion follows the system (note) |
| **Plan & storage** | Usage meter `1.2 of 2.0 GB` with the 5 largest songs · plan cards Free/Plus with Monthly/Yearly, `Get Plus` / `Manage subscription` · notices (grace period, cancel at period end) · **Export library (ZIP)** (the only copy) · Playback cache `412 MB · Clear` |
| **This device** | Install as app (platform steps) · wake-lock support · Media Session status (experiment) · version · `Check for updates` (desktop) · Licenses |
| **Account** | Email, Google account, Sign out, Administration link (admins) |

Desktop-only rows on web are never shown disabled. They collapse into one note: "These need Woodshed for desktop: Import an old library, Export original audio, Processing. [Get it ↗]".

### 6.3 Account, billing, suspension
- `/billing` → `/settings/plan`. The duplicate Export in billing is removed.
- **Suspended or export-only:** a calm full page in the app frame:
  - title "Your account is paused", the reason;
  - `Manage billing`, `Export library`, `Sign out`.
  - Export-only keeps the Library readable, with an in-flow banner.
- **Fatal boot errors:** a centred 480 px card, "Couldn't open Woodshed. Check your connection and try again. [Retry]", with raw details behind `Details`.
- **Upsells** never appear during Stage playback. The storage-full prompt appears only in Add and in Settings.

### 6.4 Admin
- Same primitives:
  - Storage overview cards, Policy form.
  - Account search (exact email kept) → an account page with status segmented, storage override, notes, devices with `Revoke…`, jobs with `Cancel…`, and audit history with `Load more`.
- Every mutation opens a Dialog with a required **Reason** field. `window.prompt` is deleted.

### 6.5 Desktop-specific
- **Processor status** (Jobs chip and Settings → Processing):
  - `Processor ready` · `Splitting 1 · 46%` · `Starting… (first run, ~1 min)` · `Offline — Restart`.
  - Pairing failures surface here: "Couldn't connect this computer to your account. [Try again]". Today they go only to the console (`desktop-client.js:52-55`).
- **Updates:** one avatar dot plus the menu item `Update ready — Restart to install` / `Downloading update 40%`. The header update icon is deleted. App menu `Check for Updates…` stays. Native prompts are **deferred while the Stage plays**.
- **App menu, generated from the registry:**
  - File: Add Songs… ⌘N, Close Song ⌘W (→ Library);
  - View: Chart / Road map / Stems, Focus, Distance ▸;
  - Transport: Play/Stop, Again, Loop, Count-in, Click, Minus me;
  - Woodshed: Settings… ⌘,.
  - Electron owns ⌘N, ⌘W and ⌘,. The web app never binds them.
- **Background shortcuts** (opt-in, Electron `globalShortcut`): `⌃⌥Space` play/stop, `⌃⌥↩` again, `⌃⌥L` loop, plus hardware media keys.
- **Quit guard:** kept. It flushes the practice save; copy unchanged.
- **Window:** remembers size and position. Full screen (`⌃⌘F`) suggests Focus once.

### 6.6 First run and onboarding
1. **Sign-in** (centred 400 px card; wordmark):
   - Title "Practise along with any song".
   - Three lines with 20 px icons:
     - "Split any song into drums, bass, vocals and more"
     - "Loop the hard part, slow it down, take your part out"
     - "Read drum charts that follow the recording"
   - `[Continue with Google]` (48 px).
   - Fine print: "New here? This creates your free account. Adding songs uses the free desktop app (Mac, Windows, Linux). Practising works everywhere, including iPad."
   - The theme picker is removed (it follows the system).
2. **What do you play?** (one screen, skippable):
   - 56 px chips; the first tapped becomes primary.
   - Below: "When you open a song: [Hear everything] [Start with my part out]".
   - Copy: "Woodshed can take your part out of the mix so you can play it, and picks the right stems when you add songs."
   - Writes `settings.profile`.
3. **Library first run:** the Demo and Add cards (§2.7).
4. **Demo song, no backend code:**
   - The owner shares a curated, licensed song with a chart, sections, a map and one spot ("Chorus fill · bars 19–20").
   - The token goes in `VITE_DEMO_SHARE_TOKEN`. "Open example" opens `/share/<token>` as a Shared Stage with Minus me applied from the profile.
   - `Add to my library` uses the existing `shareAudio.save`. The demo is ≈ 5 MB, so no quota exemption is needed.
5. **First Stage coach marks** (once per account, `settings.onboarding.stage`): non-blocking anchored callouts, `1 of 3 · Skip`, each dismissed by doing the thing, never shown while playing.
   1. On Play: "**Space** or ▶ plays from your loop. **Enter** starts again with a count-in."
   2. On the strip: "Tap a section to jump there. Double-tap to loop it."
   3. On Mix: "**Drums OUT** takes your part out of the mix. You play it."
   - A fourth appears the first time a song has no bars: "No bar grid yet, so times are in seconds. [Get bars]".
6. **Desktop first run:** the processor status shows "Setting up the processor (first run, ~1 min)…". Then the Add sheet opens once with "Paste a link to your first song".
7. **Key change hint** (existing users, v2.0): the first Enter press after upgrade shows in the status line "Enter now starts again with a count-in. Pause is ⇧Space. [Keep old keys]". A one-time "What's changed" sheet lists the remaps, and `?` marks changed keys with "new".

---

## 7. Interaction grammar

### 7.1 One command registry (`src/app/commands.js`)
```js
register({
  id: 'transport.again', title: 'Start again', group: 'Transport',
  keys: ['Enter'], classicKeys: [], pedal: true,
  scopes: ['stage', 'edit'], when: c => c.song?.ready,
  run: c => c.transport.again(), icon: 'rotate-ccw',
  menu: { label: 'Start again (with count-in)', electron: 'Transport' },
  palette: { keywords: ['repeat', 'restart', 'from the top'] },
});
```
- **Consumers:** one capture-phase `keydown` dispatcher (the six listeners listed at the top are removed), the `?` sheet, the palette, context menus (right-aligned shortcut hints), `aria-keyshortcuts` and tooltips, the pedal mapper, and the Electron menu (via preload `registerMenu`).
- **Scope stack**, top first: overlay (dialog / sheet / menu / palette) → text input (only Esc and ⌘/Ctrl combos pass) → surface (`stage.stems`, `edit.chart.score`) → posture (`edit.map`, `edit.chart`, `stage`) → `library` → `global`. The first scope with a binding whose `when` passes wins.
- **Sliders, steppers and faders** are custom primitives that consume only arrows, PageUp/PageDown, Home and End when focused. Space, digits and letters always reach the registry, so the "focused slider swallows Space" bug cannot come back.
- **Key strings:** `e.code` for letters and digits (layout-independent), `e.key` for symbols.
- **CI test:** no duplicate binding within any scope chain; every command has a title and group; every dock and rail control maps to a command; `?` is generated from the registry.

### 7.2 Keyboard map
| Key | Stage | Stems surface (adds/overrides) | Edit · Map | Edit · Chart | Library |
|---|---|---|---|---|---|
| Space | Play/Stop (loop start or cue) | | Play/Stop; taps while tapping | Play/Stop | — |
| ⇧Space | Pause/continue in place | | same | same | — |
| Enter | **Again** (count-in). Classic keys: Pause | | Apply inspector field | Again | Open focused song |
| ← / → | Bar (mapped) / 5 s | | Bar (today) | Cursor (today) | Roving focus |
| ⇧← / ⇧→ | Beat / 1 s | | Beat | Extend selection | — |
| ⌥← / ⌥→ | Nudge cue 50 ms (⌥⇧: 10 ms) | | Renumber pin | Move notes | — |
| [ ] and PageUp/PageDown | Previous/next section or marker | | same | Previous/next 16 bars | — |
| ⇧[ / ⇧] | Move loop by its length | | — | — | — |
| Home / End | Loop start/end, else song start/end | | First/last bar | Bar start/end | First/last card |
| L / ⇧L | Loop toggle / loop this section | | — (P previews) | Loop selection | — |
| I / O | Loop in / out at playhead | | same | — | — |
| ⌫ | Clear loop (undoable) | | Unpin | Delete note | Delete selected… (dialog) |
| , / . | Speed −5 / +5 (⇧ ±1) | | Nudge pin 10 ms (⇧ 1 ms) | `.` = dotted | — |
| \` | Speed 100% ↔ last | | | | — |
| C / K | Count-in / Click | | same | same | — |
| M / ⇧M | Minus me / Only me | | same | — | — |
| 1–9 / ⇧1–9 / 0 | Mute / solo stem N / full mix | | same | Step values (scoped) | — |
| S | Marker or section at playhead | | Add section at playhead | — | — |
| ⇧S | — | Snap | Snap | — | — |
| G | — | Grid on/off | Grid | Ghost (today) | — |
| Z | — | Zoom to loop | Zoom to selection | — | — |
| = / − | Chart size / Wave page row length | Zoom in/out | Zoom | Finer/coarser step (today) | — |
| \\ | — | Fit | Fit | — | — |
| B / J | Save spot / Spots list | | — | — | — |
| V / F | Cycle surface / Focus | Follow toggle on F | — | — | — |
| E | Edit (last tab) | | — | — | Edit details of focused |
| N | — | | — | Write note (today) | Add song |
| / | — | | `/` halve (today) | Tuplet (today) | Focus search |
| ⌘Z / ⇧⌘Z | Practice undo/redo | | Map undo/redo | Notation undo/redo | — |
| ⌘K | Palette (everywhere) | | | | |
| ? | Shortcut sheet, current scope first (everywhere) | | | | |
| Esc | Close overlay → exit Focus → (stopped, desktop) Library. **Never navigates while playing.** | | Close panel → clear selection → Done | Clear selection → close panel → Done | Clear search / exit select |

**Notes:**
- Edit · Map keeps today's full `MAP_KEYS` (`map-mode.js:27-31`): digits + ↵ go to bar, D/T, ↑↓, ⌥↑↓, E, R, P, `*`, `/`, ⌘←/→.
- Edit · Chart keeps today's map (`editor.js:303-326`), including remappable drum letters.
- **Changed from today:**
  - Enter is Again (Pause → ⇧Space).
  - `,` `.` are speed (fine nudge → ⌥←/→).
  - `[` `]` are sections (loop in/out → I/O).
  - M is Minus me (the click → K; the popover is gone).
  - `−` `=` zoom is kept on the Stems surface.
  - G and ⇧S are kept on the Stems surface and in Map.
- **"Classic keys"** (Settings → Practice, v2.0–v2.1) restores Enter = Pause and `[` `]` = loop in/out. Removed in v2.2.

### 7.3 Command palette (⌘K / Ctrl+K)
- **Container:** 640 px wide, top-centred; input 52 px, rows 44 px, 8 visible. Band layout uses a full-width top sheet.
- **Groups**, ranked by scope then frecency:
  1. **In this song:** sections (`chorus 2`), spots (`◆ bridge`), markers. `bar 57` / `b57` / `57` → Go to bar 57 (mapped) or 0:57. `1:12` → time. Enter cues; ⌘Enter loops it.
  2. **Commands:** `75` / `75%` → Speed 75%; `minus`; `only bass`; `loop chorus`; `loop 41-48`; `count 2 bars`; `trainer 70 100`; `tap the beat`; `edit map`; `share`; `re-split`.
  3. **Songs:** prefix > word-start > fuzzy match. Enter opens the Stage; ⌘Enter opens Details.
  4. **Navigation:** Library, Settings sections, Add song.
- A bare number < 400 offers both "Speed N%" and "Go to bar N"; the bar option comes first when mapped.
- Every row shows its shortcut key-cap.

### 7.4 Browser and platform reservations
- **The web app never binds** ⌘N, ⌘W, ⌘T, ⌘,, ⌘1–9, or ⌘+/⌘−/⌘0 (browser zoom stays an accessibility tool). ⌘K and ⌘Z are intercepted only inside the app.
- **Electron** binds ⌘N, ⌘W and ⌘, through menu accelerators from the registry.
- **iPad hardware keyboards** get the same map. Long-press ⌘ shows iPadOS's discoverability overlay, populated from `aria-keyshortcuts` where supported.

### 7.5 Pedals (hands-free)
- **Out of the box (no setup):** PageUp/PageDown = previous/next section in the Stage. Most page-turner pedals work with nothing configured.
- **Pedal mode** (per device):
  - Learn 2–4 pedals ("Press the left pedal…"), recording `event.code` and whether it auto-repeats (= hold capable).
  - Pedal bindings take precedence over keyboard ones. A `⎍ Pedal` indicator shows in the identity row.
- **Tap / hold / double-tap:**
  - Hold = keydown→keyup ≥ 600 ms, or auto-repeat; it fires at the threshold.
  - Tap fires on keyup (≈ 80 ms latency). **Play/Stop fires on keydown when no hold action is bound.**
  - Pedals that can't report a hold get **double-tap (≤ 350 ms)** as the fallback for the hold action.

| Profile | Left tap | Left hold / double | Right tap | Right hold / double |
|---|---|---|---|---|
| **Practice** (default) | Again | Previous section | Play/Stop | Next section |
| **Navigate** | Previous section | Loop toggle | Next section | Play/Stop |
| **Page turn** | Scroll up one screen | Top | Scroll down one screen | — |
| **Custom** | any registry command marked `pedal` | | | |

- Third and fourth pedals default to Loop toggle and Minus me.
- With B3, right-hold in a setlist = next song.
- **Optional P2:** Web MIDI mapping (Chromium/Electron only), e.g. "crash pad = Again".

### 7.6 Touch gestures (each has a visible equivalent)
| Target | Tap | Double-tap | Long-press | Drag |
|---|---|---|---|---|
| Music (stopped) | Cue | Play from there | Bar menu | Long-press then drag: loop |
| Music (playing) | "Play from bar N" pill | Jump | Bar menu | Scroll (pauses Follow) |
| Strip segment | Cue (stopped) / quantized jump (playing) | Loop section | Section menu | Scrub (stopped) |
| Loop handle | — | — | — | Resize (bar snap) |
| Dock control | Action | — | Its sheet | Speed value: ±1% per 12 px |
| Stem pad | Mute (or Solo in Solo mode) | Level 100% | Solo | Vertical: level |
| Library card | Open | — | Card menu | — |
| Sheet grabber | — | — | — | Swipe down to close |

There are no hidden multi-finger gestures, except two-finger pan and pinch on the Stems surface, which are also on the toolbar.

### 7.7 Context menus
- **One Menu primitive:** right-click, long-press (500 ms), Shift+F10, the ContextMenu key, or `⋯`. `role=menu`, roving focus, type-ahead, shortcut hints. Coarse pointers render it as a sheet with 56 px rows.
- **Defined menus:** bar, section (strip / sections lane), spot, marker (Rename · Delete · Turn into section when mapped), loop band (Save as spot · Count in every pass ✓ · Move ◀ ▶ · Zoom to loop · Clear), stem pad/header (Mute · Solo · Reset level · "This is my instrument"), song card, selection.
- Opening a Dialog closes any open menu.

### 7.8 Undo summary
| Stack | Scope | UI |
|---|---|---|
| Practice | Stage, per song session, 50 steps, coalescing 1 s | "Undid: …" toast or status line |
| Map | Edit · Map (existing SongMapStore) | Undo/Redo buttons |
| Notation | Edit · Chart (existing NotationStore) | Undo/Redo buttons |
| Library | Delete song(s): confirmed by Dialog. Pin/unpin, add/remove from setlist, spot delete: 8 s Undo toast | toast |

### 7.9 Feedback and overlay stack (one system)
- **Toast region:** bottom-centre above the dock or transport, one at a time with a queue. Info and success auto-dismiss at 5 s; errors persist. Toasts never take focus and are **held while playing**.
- **Status line** (Stage only) for in-play feedback.
- **InlineStatus:** one per panel, tones info / ok / warn / error.
- **Dialog:** native `<dialog>` with `showModal`, focus return, and `confirm({title, body, confirmLabel, danger})` returning a Promise. Danger styling only for destructive confirms.
- **Banners:** in layout flow only.
- **Deleted:** every `alert`, `confirm` and `prompt`; `confirmModal` and its leaked listener; the danger-styled OK on notices.

---

## 8. Visual design system

### 8.1 Typography
- **Atkinson Hyperlegible Next** (variable, SIL OFL) for the UI, chosen for distance legibility (distinct letterforms, open counters). **Atkinson Hyperlegible Mono** for readout numerals. Both are imported from `src/styles/fonts/*.woff2` via CSS so Vite emits them under `/assets/` (Electron CSP and allow-list safe). Fallback stack: `system-ui, -apple-system, "Segoe UI", sans-serif`.
- **Desk scale** (Library, Settings, Edit; body line-height 1.4, headings 1.2): 12 caption · 14 small/meta · 16 body · 20 title-s · 24 title-m · 32 title-l.
- **Stage scale** (× Distance): 15 identity/status · 17 sub-readouts · 20 loop line (rail) · 40 section and speed · 56/64 position (band/rail) · 120 count-in.
- **Weights:** 400 / 600 / 700 / 800 (readouts 600–800). All readouts use `font-variant-numeric: tabular-nums`.
- **Minimums:** 12 px anywhere, 14 px in coarse-pointer chrome, 15 px in the Stage. The 9–11 px labels are deleted. Overline labels are 12/600 caps with +0.06em tracking.

### 8.2 Spacing, radii, sizes
- **Spacing (4 px base):** `--s1 4 · --s2 8 · --s3 12 · --s4 16 · --s5 24 · --s6 32 · --s7 48 · --s8 64`.
- **Radii:** `--r-control 8` (buttons, inputs, pads) · `--r-surface 12` (cards, sheets, popovers, dialogs) · `--r-pill 999` (chips, segmented, badges). **Covers stay 0.** That is three values, down from about 25.
- **Control heights:**
| Token | Fine | Coarse | Stage |
|---|---|---|---|
| `--h-sm` | 32 | 44 | — |
| `--h-md` | 40 | 48 | — |
| `--h-lg` | 48 | 56 | — |
| `--h-dock` | — | — | 56 rail / 64 band |
| `--h-play` | — | — | 72 rail / 80 band |
| `--hit-handle` | 24 (visual 8) | 44 (visual 20) | 44 |
- **Minimum hit targets:** 24×24 fine (WCAG 2.2), 44×44 coarse. Gaps ≥ 8 (desk) and ≥ 12 (Stage). Enforced by the target-size probe.

### 8.3 Colour tokens (semantic only; no hex in components)
Three sets: **paper** (light), **night** (dark), **stage** (dark, high contrast; used in the Stage when Appearance → Stage = Always dark (default) or the theme is dark).

| Token | paper | night | stage | Use |
|---|---|---|---|---|
| `--bg` | #f6f5f0 | #121615 | #08090a | page (`body` explicit) |
| `--surface` | #ffffff | #1a1f1e | #111414 | cards, rail, dock |
| `--surface-2` | #efede6 | #232a28 | #191d1c | inputs, pads, alternating strip segments |
| `--line` | #d9d6cc | #3a4441 | #2a302e | borders |
| `--line-strong` | #b9b4a6 | #4c5753 | #3b4340 | inputs, outlined/muted pads |
| `--ink` | #17201f | #eef0ea | #ffffff | primary text |
| `--ink-2` | #3f4a46 | #b9c2bd | #d3dad6 | secondary |
| `--ink-3` | #626d68 | #8b9692 | #9aa5a0 | tertiary (≥ 4.5:1 on `--bg`, test-enforced) |
| `--accent` | #174bd1 | #8aafff | #9cbcff | primary actions, cue, selection, **solo ring** |
| `--accent-fill` | #174bd1 | #3d63d6 | #3d63d6 | filled buttons (one blue per theme) |
| `--on-accent` | #ffffff | #ffffff | #ffffff | text on accent-fill |
| `--accent-soft` | #e4eafb | #22304d | #1b2742 | selected backgrounds |
| `--now` | #c25700 | #ffb547 | #ffc14d | playhead, current bar/beat, count-in, current section |
| `--now-soft` | #ffe9d4 | #3a2b12 | #2e220e | current bar/segment fill |
| `--loop` | #174bd1 | #8aafff | #7fa6ff | loop edges, loop on |
| `--loop-fill` | rgb(23 75 209/.10) | rgb(138 175 255/.16) | rgb(127 166 255/.18) | loop band |
| `--edit` | #6b45c4 | #b39bff | — | edit posture border and label |
| `--out` | #626d68 | #8b9692 | #8b9692 | "OUT" text, ghost outlines, hatch |
| `--ok` / `--warn` / `--danger` | #2f7a4c / #8f5400 / #b13a30 | #80c79b / #f3b77d / #ff8a7d | as night | status |
| `--focus-ring` | #174bd1 | #9cbcff | #9cbcff | focus outline |
| `--stem-*` | existing light values | #ed9870 · #80c79b · #8aafff · #b4becd · #d79db4 · #85c9c3 | night +8% lightness | waveforms, pads |

**Rules:**
- `--now` (amber) means only "where the music is". `--accent`/`--loop` (cobalt) means only "what you chose". They never swap.
- **Solo has no hue of its own.** It is an accent ring plus the word `SOLO`, so the old yellow can't be confused with `--now`.
- Muted is an outline plus hatch plus `OUT`, never 28% opacity.
- No saturated full-bleed band anywhere. Section segments use neutral alternation, not hue families.
- **Chart in stage:** alphaTab note ink `--ink`, staff lines `--ink-3`, bar numbers `--ink-2`, playing-bar overlay `--now-soft`.
- `theme-color` meta updates per theme and posture.
- The theme-init pre-paint and the `woodshed:theme` event are kept.

### 8.4 Focus and accessibility
- **One focus rule** in `@layer base`: `:focus-visible { outline: 3px solid var(--focus-ring); outline-offset: 2px; }`. The offset gap shows the page background, so the ring is two-tone on any surface, including filled buttons. No box-shadow variant. This fixes the invisible header focus.
- **Toggles:** `aria-pressed`, labelled with the feature ("Count-in"), never with a state word ("On").
- **Stage semantics:**
  - the song title is the `h1` (in the identity row);
  - readouts are a `role=group` labelled "Now playing";
  - the dock or rail controls are `role=toolbar` labelled "Transport";
  - the strip is a `nav` labelled "Sections" with a `role=slider` (`aria-valuetext="Bar 12, beat 3, Chorus"`).
- **Surfaces:** Road map bars are a roving-tabindex grid of buttons. Chart bars are reachable through an overlay bar list (←/→ by bar, Enter plays, L loops).
- **Announcements:** section-change announcements are **off by default** (Settings → This device: "Announce sections while playing"). Trainer steps, count-in start and job completion are announced politely, throttled to ≥ 2 s. Nothing per beat.
- **Equivalents:** hold-to-leave and long-press menus have keyboard and visible equivalents (Stop then Esc; Shift+F10 or `⋯`).
- **Reduced motion:** honoured everywhere. Beat lamps still change state per beat, without fades.

### 8.5 Elevation and z-layers
| Layer token | z | Shadow (paper; night uses one surface step lighter + `--line`) |
|---|---|---|
| `--z-base` | 0 | none |
| `--z-sticky` (top bar, rail, dock, strip, posture bar) | 10 | `0 1px 0 var(--line)` |
| `--z-overlay` (pills, handles, count-in plate) | 20 | `0 2px 8px rgb(0 0 0/.18)` |
| `--z-popover` / menu | 30 | `0 8px 24px rgb(0 0 0/.18)` |
| `--z-sheet` | 40 | `0 -8px 32px rgb(0 0 0/.22)` |
| `--z-dialog` (+ backdrop rgb(0 0 0/.4)) | 50 | `0 16px 48px rgb(0 0 0/.24)` |
| `--z-toast` | 60 | as popover |
| `--z-coachmark` | 70 | as popover |
| `--z-drag` | 80 | — |

Prefer the top layer (`<dialog>`, `popover`). The 22 ad-hoc z-index values are deleted.

### 8.6 Motion
- **Tokens:** `--motion-fast 120ms`, `--motion-enter 160ms`, `--motion-nav 220ms`, `--motion-slow 260ms`, `--ease cubic-bezier(.2,.8,.2,1)`.
- **Uses:**
  - section label crossfade 160 ms;
  - beat lamp 60 ms on / 180 ms decay;
  - loop brackets spring to bar lines 120 ms;
  - sheets slide 220 ms; popovers grow from their anchor 160 ms;
  - processing cards FLIP 260 ms;
  - surface switch crossfades with the current bar as a shared anchor;
  - Library → Stage View Transition morphs the cover into the identity cover.
- **Never animate:** readout numerals, or layout during playback.

### 8.7 Iconography
- **Lucide** (licence already in `public/licenses/lucide.txt`), compiled into one sprite imported from `src/styles/icons.svg` (emitted to `/assets/`). Sizes 20/24/32; stroke 1.75 (desk), 2 (Stage).
- **Custom glyphs:** metronome, drum, minus-me, trainer steps, count-in "1·2·3".
- **Labels:** Stage controls always show a text label. Desk icon-only buttons need an `aria-label` plus a tooltip with the shortcut. Glyph-only text buttons (`A⇤`, `⇥B`, `↶`, `•`) are banned.

### 8.8 Primitives (plain JS)
Each is a factory returning `{ el, set(props), destroy() }`. Light DOM, `ui-*` classes, `data-*` variants, CSS in `@layer primitives`.

- **Actions:** `Button` (primary / secondary / quiet / danger; sm / md / lg / dock; `command` prop pulls label, shortcut and run from the registry; loading state replacing `withButtonProgress`) · `IconButton` (label required) · `Toggle` (`aria-pressed`) · `HoldButton` (progress ring).
- **Inputs:** `Segmented` (radiogroup) · `Chip` / `ChipGroup` · `Stepper` (value can open a sheet; hold-to-repeat) · `Slider` (shows its value; arrows only) · `Fader` · `Field` (TextField, Select, Textarea, ChipInput with label, hint, error).
- **Overlays:** `Menu` · `Popover` (Popover API plus CSS anchor positioning with a JS fallback) · `Sheet` (bottom on band, anchored popover on rail; one API; swipe to dismiss; detents 40 / 60 / 90%) · `Dialog` · `Toast` (held while playing) · `InlineStatus` · `Banner`.
- **Display:** `ProgressRail` / `ProgressRing` / `Stepper` (stages) · `Tabs` · `Kbd` (hidden on touch-only devices) · `Tooltip` (hover and focus; never the only carrier of information) · `EmptyState` · `Skeleton`.
- **Domain:** `SongCard` / `SongRow` · `Readout` (scales with `--distance`) · `BeatLamps` · `StemPad` · `SongStrip` · `Palette` · `CoachMark`.

---

## 9. Implementation strategy for this codebase

### 9.1 Stack decision
- **Plain ES modules plus Vite, no framework.** React stays out of the client; it appears in `package.json` only for auth helpers.
- **Why:** the hard parts (Web Audio with Signalsmith, canvases, alphaTab) are imperative, and a VDOM adds nothing there. A ≈100-line signal store, a ≈150-line router, an `h()` helper with a keyed `reconcileList`, and the primitives cover the declarative needs.
- **No lit-html.** That avoids a third rendering idiom during the transition. If templating hurts later, lit-html (templates only) is the sanctioned fallback.

### 9.2 Architecture
```
src/app/      main.js (boot; from app.js) · router.js · store.js · prefs.js (ws.prefs v1 + migration of the 13 ws.* keys)
              commands.js (registry) · dispatch.js (keys, scopes) · pedals.js · palette.js · feedback.js · platform.js
              (wake lock, interruption, media session, PWA)
src/ui/       h.js · button.js · toggle.js · hold-button.js · segmented.js · chip.js · stepper.js · slider.js · fader.js
              menu.js · popover.js (+position.js) · sheet.js · dialog.js · toast.js · status.js · field.js · progress.js
              tabs.js · kbd.js · tooltip.js · empty.js · banner.js · coachmark.js · icons.svg
src/stage/    stage.js (layout rail/band, mount/unmount) · transport.js (façade over MultitrackEngine + Metronome:
              cue model, play/stop/again/pause, count-in policy, pass counter, trainer, quantized jump)
              practice-state.js (v2 schema, v1 migration, debounced save, flush, size budget, id-merge, undo)
              hud.js · controls.js (dock + rail share one control set) · strip.js · sheets/{speed,click,mix,loop,spots,notes,tap-beat}.js
              surfaces/{chart-surface.js (wraps notation/chart.js, chrome:false), roadmap-surface.js (mapped + wave page),
              stems-surface.js (pointer events, toolbar)} · wave-render.js (one waveform renderer: stems rows, road-map
              cells, strip, map lanes)
src/edit/     edit.js (posture bar, slim transport) · map/ (map-mode.js + map-lane.js + tempo-sources.js re-hosted;
              inspector rebuilt) · chart/ (notation/editor.js re-hosted; menus) · details/ (from song-metadata.js)
src/library/  home.js · cards.js · add-sheet.js · upload.js (XHR progress) · jobs.js · selection.js
src/settings/ one module per section · plan.js (from billing.js) · admin/*
src/styles/   layers.css · tokens.css · base.css · primitives.css · layout.css · stage.css · fonts/ · views/*.css
KEEP          engine.js (+ additions §9.5) · metronome.js · song-map.js / shared/song-map.ts (origin passthrough) · waveform.js peaks
              stemcache.js · decoded-stem-cache.js · notation/* (model, engraving, alphaTab) · tempo-import.js · tempo-archive.js
              guitar-pro-*.js · onsets.js · backend.js (thin additions) · auth.js · companion.js · export.js
```
- **View contract:** `mount(el, params, ctx) → { update(params), unmount() }`. The Stage's `unmount` calls `practice.flush()` and `engine.destroy()`.
- **Store slices:**
  - `session` (user, config, admin, devices, processor);
  - `library` (songs, jobs; Convex subscriptions write in);
  - `prefs`;
  - `stage` (per open song: transport snapshot, practice).
  - Position goes from one rAF loop straight to the HUD, lamps and playheads (60 Hz for canvases, ≤ 30 Hz for text). Other state updates on change.
- **CSS:** `@layer legacy, reset, tokens, base, primitives, layout, views, utilities;` declared first. Today's `styles.css`, `record-club.css`, `theme.css` and feature CSS are imported with `layer(legacy)`, so all new layers win without `!important`. Each phase deletes the legacy rules it replaces. `chart.css` control styles move to `primitives.css`, loaded with the shell, which fixes the Chart/Tracks nav "flip".
- **Guards** (`scripts/check-css.mjs` in `npm test`): no hex/rgb outside `tokens.css`; no z-index or border-radius literals; no `!important` outside `utilities`; no px font sizes outside tokens.
- **Desktop:** add `/manifest.webmanifest` to the allow-list at `desktop/main.cjs:41`. Everything else goes through `/assets/`.

### 9.3 Practice blob v2 (`songs.practice` is `v.any()`, so no schema change)
```js
{ v: 2, lastAt: 1761650000000,
  cue: 83.2, surface: 'chart'|'roadmap'|'stems', anchorBar: 13,
  rate: 0.75, keepPitch: true,
  loop: { on: true, a: 24.0, b: 40.0, aBar?: {id, beat}, bBar?: {id, beat}, eachPassCount: true, playTimes: 0 },
  tracks: [{ name, volume, muted, soloed }], minusMe: true,
  trainer: { start: .7, end: 1, step: .05, passes: 2 } | null,
  spots: [{ id, name, a, b, aBar?, bBar?, rate, note?, lastAt, passes, updatedAt, deleted? }],   // ≤ 24
  markers: [{ id, t, label, updatedAt, deleted? }] }                                            // ≤ 64, unmapped only
```
- **Migration:** v1 `{loop, rate, grid, tracks}` is read and upgraded on first save. `grid` moves to the device pref `ws.prefs.stems`.
- **Bar anchoring:** when the map changes, spots and loops with `aBar`/`bBar` re-resolve their times from bar ids.
- **Size budget:** under 10 KB (≈ 24 × 160 B + 64 × 70 B + tracks ≈ 9 KB). The saver drops tombstones older than 30 days first, then the oldest unnamed markers, and warns in the status line. B2 raises the cap.
- **Multi-device merge** (client-only): before each save, merge with the latest server `practice` from the `songs.get` subscription:
  - `spots` and `markers` by `id`, newest `updatedAt` wins, tombstones respected;
  - scalars last-writer-wins.
  - This stops laptop and iPad sessions from silently deleting each other's spots.
- **Cadence:** debounced 600 ms as today, plus flush on Stop, unmount, `pagehide` and `visibilitychange → hidden`. **`lastAt` is written once per session** (first Play), never on every save. That limits `songs.list` churn until B1.
- **Map origin:** `tempo.songMap.origin` is written by detection, tap, import and Edit · Map. The `hasRealMap` heuristic (§1.1) covers legacy rows.

### 9.4 Phased plan (each phase ships; ~14 focused sessions in total)
**Phase 0. Foundations (2 sessions) → v1.10, mostly invisible plus fixes**
- Promote the scratchpad fixture into `tests/fixture/` (Vite stubs for `convex/browser` and `@convex-dev/auth`, `db.js`, synthetic audio, scenario params; `npm run fixture`).
- Playwright baselines **first**, including Transcribe score/lanes and the chart, at laptop 1440×900 and iPad 820×1180 × light/dark.
- Tokens, layers (legacy lowest), fonts via `/assets`, focus ring.
- Primitives wave 1: Button, IconButton, Toggle, Segmented, Menu, Popover, Dialog, Toast, InlineStatus, Sheet, Slider, Stepper, Kbd.
- `router.js` (`/`, `/s/:id`, `/settings`, `/admin`, legacy redirects): **Back works.**
- `commands.js` + `dispatch.js` with **today's keys unchanged**; a real `?` sheet; the slider-swallows-Space fix.
- Replace `alert`/`confirm`/`prompt`/`confirmModal`. Fix stale copy and the codec banner.
- Pointer events for the timeline and overview (`player.js:602-713`) with 44 px handles on coarse pointers.
- Wake lock, interruption pause, PWA manifest plus the Electron allow-list.
- **Delete:** `.nav-btn`, `musical-position.js`, `renameSong`/`songs.rename`, legacy align dialogs, `interactions.js` blur hack, dead selectors.
- **Milestone:** all fixture states render; axe adds no violations; iPad loop drag passes; no native dialogs.

**Phase 1a. Stage frame (2 sessions) → v2.0-beta behind `?stage=1`**
- `transport.js`: cue model (rename the edit cursor), Space from loop start, Again, ⇧Space, count-in policy.
- `practice-state.js` (v2, resume, merge, undo).
- `hasRealMap` plus honest unmapped HUD.
- Rail/band layout; HUD (identity, section, next, position, lamps, speed, loop, mix, status line); count-in overlay; dock and rail controls.
- Speed, Click and Mix sheets with Minus me and Only me; profile in Settings → Instruments.
- The chart hosted with `chrome:false`; **today's Tracks view hosted as the Stems surface**.
- Interactive loading with the Play ring. `E` opens the *existing* map / Transcribe inside a temporary Edit route.
- **Delete:** the header band on the player, the chart toolbar, the metronome popover, the workspace nav.
- **Milestone:** HUD sizes pass the §4.11 tests; resume restores everything.

**Phase 1b. Stage behaviour (2 sessions) → v2.0 (Stage is the default)**
- Song strip (replaces chips and the minimap); Loop card; loop handles on chart and Stems; glass rules with pointer-type split; hold-to-leave; Esc rule.
- Distance and Focus; Follow styles (Scroll / Page); practice undo with "Undid:" toasts.
- Key remap with Classic keys, the first-press hint and the "What's changed" sheet; Stage coach marks.
- **Delete:** the practice strip, `player-layout.js`, about 70% of `player.js` markup/keys, duplicate Follow and Mute controls.
- **Milestone:** the rehearsal task (open → loop the bridge → 75% → drums out → count-in → play) takes ≤ 3 actions after resume and ≤ 6 on a fresh song, on laptop keys-only and iPad touch-only. A stray tap while playing never seeks.

**Phase 2. Every song is stage-ready (3 sessions) → v2.1**
- Road map and Wave page on the shared `wave-render.js`; Stems surface rebuilt (toolbar, bar ruler, hatch mute, subdued grid, viewport bracket on the strip).
- Markers (S), spots (B, J, `?spot=`), Tap the beat sheet.
- Engine additions (§9.5) behind flags: `wrap` event, trainer, count-in every pass, quantized jump, play-N-times.
- Pedal mode (learn, profiles, double-tap fallback); PageUp/PageDown sections; Media Session experiment.
- **Milestone:** unmapped songs never render "Bar"; markers convert to sections with Undo; a 10-minute pedal-only trainer session with no touches (scripted plus manual).

**Phase 3. Library, Add, first run, settings (2–3 sessions) → v2.2**
- Top bar, Continue, Pins, chips, sort, group, drill-down, list columns, new cards with processing in place, Jobs popover (all kinds), selection with bulk delete.
- Add sheet: omnibox, honest single-result mode, defaults line from the profile, duplicate check, drop-to-confirm, XHR upload progress, inline errors, completion toast and native notification.
- Web/iPad explainer. Sign-in copy, "What do you play?", demo card (`VITE_DEMO_SHARE_TOKEN`).
- Settings restructure, Plan merged, desktop-only grouping. Classic keys removed.
- **Recommended in this window: B1** (slim list).
- **Delete:** old add modal, In-progress list, `showDesktopSetup` gating, global silent-upload drop handler, Reprocess dialog, `record-club.css` library blocks, the duplicate quality slider, duplicate update and billing entries.

**Phase 4. Edit postures (3 sessions) → v2.3**
- Posture frame with `--edit`.
- Edit · Map: sections lane, the full inspector (every key-only edit plus the full Edit bar fields), Get a map, Find a chart side panel with Other sources, markers → sections banner.
- Edit · Chart re-frame: toolbar, Edit ▾ / Part ▾ with every item, inspector tabs, scoped keys, iPad kit pad bank, pagination kept.
- Edit · Details page with Match and bulk mode. Shared Stage local state and migration on save. Admin on primitives.
- **Delete:** `launcher.js`, the metadata modal, `modal-focus.js`, `tempo-sources` inert-freeze logic, editor heading/toolbar markup. **The legacy CSS layer is empty after this phase** and the `legacy` imports are removed.

**Phase 5. Platform extras (independent, 1 session each)**
- Electron menu from the registry; background shortcuts and media keys.
- Call & response and "between passes rest".
- Web MIDI pedals.
- Transcribe continuous-scroll experiment behind a flag.

**Optional backend, ML and engine work** (none required for Phases 0–4):
| ID | Work | Size | Unlocks |
|---|---|---|---|
| B1 | Slim `songs.list` (drop `tempo`/`practice` from the projection; return `hasChart`, `hasRealMap`, `lastPracticedAt`, `practiceSummary {loopLabel, rate, minusMe, spotCount}` written by `savePractice`). The Stage loads full data via `songs.get`. | S, non-breaking | Removes every-save list churn; fast Continue/sort |
| B2 | `practice` cap 10 KB → 32 KB (only after B1) | XS | More spots and markers |
| B3 | `setlists` table + CRUD; `/set/:id`; HUD "Set: Thursday · 2/5 · next: Velvet Arc"; ⌥↑/⌥↓ and pedal hold; `songs.remove` strips ids | S–M | Rehearsal setlists |
| B4 | Companion `/resolve?url=` and `/search?q=&n=5` (yt-dlp `--dump-json --skip-download`, `ytsearch5:`) | M | Candidate confirmation |
| B5 | `devices.lastSeenAt` heartbeat + `devices.list`; web-initiated jobs to a chosen device | M | Add from iPad/web |
| B6 | Chain a `beats` job after separation (setting) | M | Bars on every song without action |
| B7 | **Section detection (ML)** on the companion; suggested sections as dashed blocks with `[Keep all] [Review]` | L | Sections from minute one |
| B8 | Demo token in config (no server code) | XS | Demo |
| E1 | Speed 25–49% (lift the 0.5 clamp; quality check of the Signalsmith path) | S + listening test | Very slow practice |

### 9.5 Engine and transport additions (fake-clock tested; both playback paths)
| Addition | Change | Notes |
|---|---|---|
| `engine.on('wrap', fn)`, `nextWrapAt()` | Compute from the active segment (`when + (b − offset)/rate`, then every `(b − a)/rate`). Emit from a 25 ms ticker. | Pass counter, trainer, play-N-times |
| `setSpeed(rate, {at})`, `setTrackGains(g, {at})` | Use the existing `_schedule(undefined, at)`; gain automation on `track.gain` at `at` | Trainer steps exactly at the wrap; call & response |
| **Segmented loop** `setLoop(on, a, b, {gapSec})` | When `gapSec > 0`: native `source.loop = false` **and** Signalsmith `loopStart = loopEnd = 0`; schedule each pass as its own segment (`when_k = when_{k−1} + (b − a)/rate + gapSec/rate`), stopping at B. The metronome schedules count-in clicks inside the gap with its existing count-in logic (`metronome.js:139-161`). | `gapSec = 0` keeps today's gapless native and stretch loop untouched. Tests cover both the native and the processing (`preservePitch && rate ≠ 1`) paths. |
| **Quantized jump** `seekAt(target, when)` + `cancelPending()` | `when = now + (nextDownbeat − pos)/rate`, rounded to the scheduler look-ahead; cancel re-projects the current segment | Unmapped: immediate seek |
| Interruption | `ctx.onstatechange` → `pause()`; position kept | iOS `interrupted` |

Every addition is behind `ws.flags`, with fake-clock tests extending `tests/playback-engine.test.js` and a real-device listening check (clicks, drift, comb filtering) before the flag defaults on.

### 9.6 What gets deleted (cumulative)
- **CSS:** `record-club.css` (whole), most of `styles.css`, `theme.css` (replaced by tokens), sidebar-era CSS (`styles.css:257`), dead selectors, 13 `!important`s, 22 z-index levels, about 25 radii.
- **JS:**
  - `player-layout.js`, `launcher.js`, `musical-position.js`, `modal-focus.js`, the `interactions.js` blur hack;
  - about 70% of `player.js` (markup, practice strip, metronome popover, keys);
  - the `chart.js` toolbar; the editor heading and toolbar markup; the legacy align dialogs;
  - `confirmModal`; `renameSong`/`songs.rename`; the header update icon;
  - the `?` title tooltip; the global silent drop upload; `showDesktopSetup` gating; the tempo-sources inert freeze;
  - the `m-bpm`/`m-sig` aria leftovers.
- **Concepts:** the edit cursor, the seconds practice strip, the metronome popover, nested mode tabs, "loop the visible window", the long-press-then-tap pending state, and the duplicates in inventory §20.2 (each now has one home).
- **localStorage:** 13 `ws.*` keys → `ws.prefs` (migrated, then removed).

### 9.7 Risks and mitigations
| Risk | Mitigation |
|---|---|
| R1 alphaTab relayout cost on iPad (Distance, pinch, rotation, Focus on rail) | Chrome never changes music width automatically. Pinch uses a CSS transform live and relayouts on release. Layouts cached per scale. **Perf gate:** relayout of 64 bars ≤ 300 ms on an iPad Air before live Distance switching ships. |
| R2 iPadOS behaviour (wake lock in a standalone PWA, `interrupted`, Media Session with Web Audio) | Feature-detect plus a Settings status. **Real-device matrix per release:** Safari tab and home-screen app × iPadOS 17 and 18 × wake lock / interruption (call, Siri, other audio) / headset buttons. No copy promises headset control until it passes. |
| R3 `songs.list` churn | `lastAt` once per session now; B1 recommended in Phase 3; a test measures list payload size. |
| R4 key remaps | Classic keys for two releases, first-press hint, What's-changed sheet, "new" badges in `?`. |
| R5 engine changes (gap loop, scheduled speed, quantized jump) | Flags; fake-clock tests on both paths; listening tests; native gapless path unchanged at gap 0. |
| R6 multi-device practice conflicts | Id-based merge with tombstones (§9.3). |
| R7 `player.js` decomposition | Strangler order: 1a hosts the old chart and Tracks inside the new frame; old DOM ids kept until each piece is replaced. |
| R8 honest mode reveals that many songs lack bars | Get bars entry points on every unmapped surface; Tap the beat; B6 as the strongest follow-up. |
| R9 Transcribe regressions (owner's favourite) | Baselines for score and lanes before any frame change; internals untouched; all `notation-*.test.js` green; pagination kept. |
| R10 two waveform renderers | One `wave-render.js` from Phase 2 (stems rows, road-map cells, strip, map lanes). |
| R11 pedal key collisions (pedals sending ←/→) | Explicit learned pedal mode with a HUD indicator; pedal bindings take precedence only in that mode. |

### 9.8 Test strategy
- **Fixture:** `tests/fixture/` runs the real app modules. Extend `db.js` with v2 practice (spots, markers), mapped and unmapped songs, legacy maps for the heuristic, a demo share, and every job state including beats and import.
- **Visual baselines** (Playwright, about 80 states × 4 variants, plus iPad landscape and Distance=Kit spot checks):
  - Stage rail/band × chart / road map / wave page / stems × stopped / playing / count-in / looping / trainer / Focus;
  - every sheet; the glass pill; the hold ring;
  - Library first-run / continue / processing / failed / needs-review / no-results / grouped;
  - Add sheet (desktop, web, duplicate, error);
  - Edit map / chart / details; Shared Stage; Settings sections.
  - `animations: 'disabled'`, masked clocks and playheads, threshold 0.1–0.2%, rebaselined only in reviewed PRs.
- **Unit (vitest + happy-dom):**
  - router (push/replace, Back, modal routes, redirects);
  - registry (no collisions per scope chain; all titled; every control mapped);
  - dispatcher (sliders never trap Space or digits; Esc never navigates while playing);
  - pedal tap/hold/double-tap classifier;
  - practice v1→v2 migration, size budget, id-merge;
  - transport semantics on the fake clock (Space from loop start, Again, stop-to-cue, count-in every pass, quantized jump, trainer, play-N-times, pass counting);
  - `hasRealMap`, plus "unmapped never renders Bar";
  - road-map row layout; bar↔time loop snapping and move-by-length;
  - error-copy mapping; token contrast (WCAG ratios for every text pair in all three sets).
- **Interaction (Playwright + CDP touch):**
  - iPad loop drag and handles; glass (tap while playing doesn't seek; mouse click does);
  - long-press menus; hold-to-leave; sheet swipe-dismiss;
  - the keyboard-only rehearsal task (< 10 keys from Library to "chorus looped at 75%, drums out");
  - resume after reload.
- **Accessibility:** axe on every state; the target-size probe (fine ≥ 24, coarse ≥ 44, dock ≥ 56; reusing `critique-tablet/probe-targets.cjs`); a focus-walk ring visibility probe (`critique-craft/probe.cjs`); computed readout sizes ≥ the §4.11 table per Distance.
- **Performance:** Stage main thread ≤ 4 ms per frame while playing; chart relayout timing; list payload size (B1 check); open → Play enabled no slower than today.
- **Convex** (when B-phases ship): `convex-test` for setlists ownership and cleanup, the `savePractice` cap, and `practiceSummary`.

---

## 10. Wireframes

### 10.1 Library: laptop 1440×900
```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Woodshed     [⌕  Search songs, artists, sections…                 ⌘K]      ◐ 2 splitting  [＋ Add song] (KK)│ 56
├──────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  Continue                                                                                                │
│  ┌──────────────────────────────────────────────────────┐ ┌───────────────────────┐ ┌───────────────────────┐
│  │ ┌──────────┐  Second Wind                   28/700  │ │ ▣ Glasshouse          │ │ ▣ Cobblestone         │
│  │ │  cover   │  The Ferry Hours                        │ │   Chorus loop · 100%  │ │   1:12 · 90%          │
│  │ │   160    │  Bridge loop · 85% · Vocals out         │ │   2 days ago          │ │   last week           │
│  │ └──────────┘  practised yesterday                    │ └───────────────────────┘ └───────────────────────┘
│  │               [ ▶ Resume ]   Start from top          │ ┌───────────────────────┐
│  │               ◆ Bridge walk-up · 85%  ◆ Outro · 70%  │ │ ▣ Night Bus           │
│  └──────────────────────────────────────────────────────┘ │   Verse · 100%        │
│                                                           └───────────────────────┘
│  Pinned  [▣ Low Tide Static] [▣ Paper Lanterns] [▣ Metropolis Pt. II]                                    │
│                                                                                                          │
│  Library 42   (Has chart)(Mapped)(Has spots)(Needs review)(Processing 2)(Failed 1)  Sort: Recently practised ▾  Group ▾ [▦|☰]
│  ── Adding ─────────────────────                                                                         │
│  ┌────────┐ ┌────────┐   ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                                     │
│  │░cover░░│ │ cover  │   │ cover  │ │ cover  │ │ cover  │ │ cover  │                                     │
│  │░░░░░░░░│ │        │   │        │ │        │ │        │ │        │                                     │
│  └▬▬▬▬────┘ └────────┘   └────────┘ └────────┘ └────────┘ └────────┘                                     │
│  Harbor Li… ⋯ Undertow ⋯  Glasshouse⋯ Second Wi.⋯ Cobblestn⋯ untitled_j⋯                                 │
│  Ada Moreno  Tidewater    Northbound  Ferry Hours Ferry Hours —                                          │
│  Splitting   Couldn't     1:04 ·Chart 1:30 ·      3:21       (Is this right?)                            │
│  46% · ~2min download.    · 2 spots   Mapped                 2:28                                        │
│              [Try again][Details]                                                                        │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 10.2 Library: iPad portrait 820×1180
```
┌────────────────────────────────────────────────────────────┐
│ Woodshed  [⌕ Search…            ]   ◐ 2   [＋ Add]   (KK)  │ 60
├────────────────────────────────────────────────────────────┤
│ Continue                                                   │
│ ┌────────────────────────────────────────────────────────┐ │
│ │ ┌────────┐ Second Wind                                 │ │
│ │ │ cover  │ The Ferry Hours                             │ │
│ │ │  128   │ Bridge loop · 85% · Vocals out              │ │
│ │ └────────┘ [   ▶ Resume  56   ]   Start from top       │ │
│ │ ◆ Bridge walk-up · 85%     ◆ Outro fill · 70%          │ │
│ └────────────────────────────────────────────────────────┘ │
│ ┌────────────────┐ ┌────────────────┐ ┌────────────────┐   │
│ │▣ Glasshouse    │ │▣ Cobblestone   │ │▣ Night Bus     │   │
│ │  Chorus · 100% │ │  1:12 · 90%    │ │  Verse · 100%  │   │
│ └────────────────┘ └────────────────┘ └────────────────┘   │
│ Library 42                        Sort ▾  Group ▾  [▦|☰]   │
│ (Has chart)(Mapped)(Has spots)(Needs review)(Processing) → │ 44, scrolls
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐         │
│ │              │ │              │ │░░░░░░░░░░░░░░│         │
│ │    cover     │ │    cover     │ │░░░ cover ░░░░│  ≈240   │
│ │              │ │              │ │░░░░░░░░░░░░░░│         │
│ └──────────────┘ └──────────────┘ └▬▬▬▬▬▬────────┘         │
│ Glasshouse  (⋯)  Low Tide…   (⋯)  Harbor Lights (⋯)  ⋯=44  │
│ Northbound       Northbound       Ada Moreno               │
│ 1:04 · Chart     1:32             Splitting · 46%          │
└────────────────────────────────────────────────────────────┘
```

### 10.3 Stage with chart: laptop rail (1440×900), playing, looping
```
┌────────────────────────────────────────────────────────────────────────────────────┬──────────────────────────┐
│                                                                                    │ ‹  ▣ Glasshouse       ⋯  │
│   Verse                                                                            │    Northbound · E min    │
│    9 |>x  x  >x  x |>x  x  >x  x | 10 |>x  x  >x  x |>x  x  >x  x |               │    [Notes]   ☼   ⎍       │
│      |o     o      |o     o      |    |o     o      |o     o      |               ├──────────────────────────┤
│   ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  │ Chorus             40/700│
│   ┃ Chorus                                                                    ┃  │ next: Verse 2 · 6 bars 17│
│   ┃ 13 |>x 3 >x 3 |>x 3 >x 3 | 14 |▓▓▓▓│▓▓ playing bar (--now-soft) ▓|>x 3 |  ┃  ├──────────────────────────┤
│   ┃    |o  o  o  o|o  o  o  o|    |▓o  │o  o▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓|o  o |  ┃  │      14 · 2        64 tab│
│   ┃ 15 |...       |...       | 16 |...                          |...   |  ┃  │   ●  ◉  ○  ○       lamps │
│   ┃ 17 |...                                                              ┃  │   0:26 / 1:04            │
│   ┃ 19 |...                       | 20 |...                              ┃  ├──────────────────────────┤
│   ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │ 75%          84 bpm      │
│   Outro    (loop band --loop-fill, brackets with 44 px handles)                    ├──────────────────────────┤
│   21 |...                                                                          │ LOOP · Chorus        20  │
│                                     [ ⤓ Back to playhead ] (only after scroll)     │ Bars 13–20 · pass 3      │
│                                                                                    │ [DRUMS OUT]              │
│                                                                                    ├──────────────────────────┤
│                                                                                    │ [  −  │   75%  │  +  ] 56│
│ ┌──────────────────────────────────────────────────────────────────────────────┐   │ [Count-in ][  Click   ]  │
│ │ Intro │ Verse      │▐Chorus ▬▬▌│ Verse 2  │ Bridge │ Chorus 2   │ Outro       │56 │ [ Loop ●  ][DrumsOUT⌃]   │
│ └──────────────────────────────────────────────────────────────────────────────┘   │ [⟲ Again  ][ ■  Stop ] 72│
└────────────────────────────────────────────────────────────────────────────────────┴──────────────────────────┘
  music 1176 px wide · rail 264 (Stand) · strip: ▐ ▌ loop bracket, ▬ played part, playhead tick --now
  Focus (F): rail → 120 px mini rail (Section, Position, lamps, Speed, Play); one relayout, anchor kept.
  Mouse click on a bar while playing seeks immediately; touch shows the "Play from bar N" pill.
```

### 10.4 Stage with chart: iPad portrait band (820×1180)
```
┌──────────────────────────────────────────────────────────┐
│ ‹  Glasshouse · Northbound           E min [Notes]   ⋯   │ 44 (dims 40% playing; ‹ = hold 600 ms)
│ Chorus              14 · 2              75%    LOOP ×3   │
│ next: Verse 2 · 6   ● ◉ ○ ○             84 bpm DRUMS OUT │ readouts 88
├──────────────────────────────────────────────────────────┤
│  12 |>x  x  >x  x |>x x >x  x |                          │
│ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  │
│ ┃ Chorus                                               ┃  │
│ ┃ 13 |>x 3 >x 3 >x 3|  14 |▓▓▓▓│▓ playing ▓▓▓▓▓▓▓▓▓|  ┃  │ Page follow: advances half a
│ ┃ 15 |...           |  16 |...                   |  ┃  │ screen when the playing system
│ ┃ 17 |...           |  18 |...                   |  ┃  │ crosses the middle
│ ┃ 19 |...           |  20 |...                   |  ┃  │
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │ ≈860 (73%) · Focus ≈1048 (89%)
│  Outro                                                   │
│  21 |...           |  22 |...       ( ▶ Play from bar 21 )│ ← glass pill after a stray tap
├──────────────────────────────────────────────────────────┤
│ Intro│Verse  │▐Chorus▬▌│Verse 2│Bridge│Chorus 2│ Outro    │ strip 56 (tap = jump at next downbeat)
├──────────────────────────────────────────────────────────┤
│ [⟲ Again][ ■  Stop ][⟳ Loop][ − │ 75% │ + ][Count][DRUMS⌃]│ dock 88 (live, 70% while playing)
│   72        96        72          184        80    OUT104│
└──────────────────────────────────────────────────────────┘  + safe area

 Count-in plate (overlays the top of the music, no layout change):
 │            ┌──────────────────────────────┐              │
 │            │              2               │ 120 px --now │
 │            │      Count-in · bar 13       │              │
 │            └──────────────────────────────┘              │
```

### 10.5 Stage without chart, mapped: Road map, laptop rail
```
┌────────────────────────────────────────────────────────────────────────────────────┬──────────────────────────┐
│  Verse  bars 5–12                                                                  │ ‹ ▣ Second Wind       ⋯  │
│  ┌─────────┬─────────┬─────────┬─────────┬─────────┬─────────┬─────────┬────────┐  │   The Ferry Hours        │
│  │5 ∿∿∿∿∿∿ │6 ∿∿∿∿∿∿ │7 ∿∿∿∿∿∿ │8 ∿∿∿∿∿∿ │9 ∿∿∿∿∿∿ │10 ∿∿∿∿∿ │11 ∿∿∿∿∿ │12 ∿∿∿∿ │  ├──────────────────────────┤
│  │ ' ' ' ' │ ' ' ' ' │ ' ' ' ' │ ' ' ' ' │ ' ' ' ' │ ' ' ' ' │ ' ' ' ' │ ' ' ' '│  │ Bridge                   │
│  └─────────┴─────────┴─────────┴─────────┴─────────┴─────────┴─────────┴────────┘  │ Chorus 2 in 2 · 1 (--now)│
│  ◆ Bridge walk-up                                           7/8 (2+2+3)            ├──────────────────────────┤
│  Bridge  bars 41–48                                                                │     47 · 3               │
│  ┏━━━━━━━━━┯━━━━━━━━━┯━━━━━━━━━┯━━━━━━━━━┯━━━━━━━━━┯━━━━━━━━━┯━━━━━━━━━┯━━━━━━━━┓  │   ● ●  ● ◉  ○ ○ ○        │
│  ┃41 ∿∿∿∿∿ │42 ∿∿∿∿∿ │43 ∿∿∿∿∿ │44 ∿∿∿∿∿ │45 ∿∿∿∿∿ │46 ∿∿∿∿∿ │47╔═══▌══╗│48 ∿∿∿∿ ┃  │   1:02 / 1:30            │
│  ┃ ' ' ' ' │ ' ' ' ' │ ' ' ' ' │ ' ' ' ' │ ' ' ' ' │ ' ' ' ' │ ║now   ║│ ' ' ' '┃  ├──────────────────────────┤
│  ┗━━━━━━━━━┷━━━━━━━━━┷━━━━━━━━━┷━━━━━━━━━┷━━━━━━━━━┷━━━━━━━━━┷━╚══════╝┷━━━━━━━━┛  │ 85%          82 bpm      │
│   ⇤ loop handle (44 px hit)                                      loop handle ⇥     ├──────────────────────────┤
│  Chorus 2  bars 49–56                                                              │ LOOP · Bridge            │
│  ┌─────────┬─────────┬─────────┬──────────────────────────────────────────────┐    │ Bars 41–48 · pass 2      │
│  │49 ∿∿∿∿∿ │50 ∿∿∿∿∿ │51 ...                                                │    │ Trainer 85 → 100 · 2/4   │
│  └─────────┴─────────┴──────────────────────────────────────────────────────────┘  │ [VOCALS OUT]             │
│  ∿ = stacked stem envelopes; my instrument on top; muted stems = outline + hatch   ├──────────────────────────┤
│ ┌──────────────────────────────────────────────────────────────────────────────┐   │ [ −  │  85%  │  + ]      │
│ │ Intro │ Verse │ Chorus │ Verse 2 │▐Bridge▬▌│ Chorus 2 │ Outro                  │   │ [Count-in ][ Click ●]    │
│ └──────────────────────────────────────────────────────────────────────────────┘   │ [ Loop ●  ][VocalsOUT⌃]  │
└────────────────────────────────────────────────────────────────────────────────────┴ [⟲ Again  ][ ■ Stop  ] ──┘
```

### 10.6 Stage without chart: iPad portrait, mapped (Road map) and unmapped (Wave page)
```
 MAPPED (Road map, 4 bars per row)                         UNMAPPED (Wave page, 8 s per row)
┌──────────────────────────────────────────────┐          ┌──────────────────────────────────────────────┐
│ ‹  Second Wind · The Ferry Hours        ⋯    │          │ ‹  Cobblestone · The Ferry Hours        ⋯    │
│ Bridge          45 · 3          85%  LOOP ×2 │          │ bridge?          2:09            100%        │
│ next: Chorus 2  ● ● ● ◉ ○ ○ ○  82bpm VOX OUT │          │ next: Outro · 0:21   no bar grid             │
├──────────────────────────────────────────────┤          ├──────────────────────────────────────────────┤
│ Bridge  bars 41–48                           │          │ 1:50 ┊   ┊   ┊   ┊ 1:55 ┊   ┊   ┊   ┊ 2:00  │
│ ┏━━41━━━┯━━42━━━┯━━43━━━┯━━44━━━┓            │          │ ∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿     │
│ ┃∿∿∿∿∿∿ │∿∿∿∿∿∿ │∿∿∿∿∿∿ │∿∿∿∿∿∿ ┃ cells 88   │          │ ⚑ bridge?                                    │
│ ┠━━45━━━┼━━46━━━┼━━47━━━┼━━48━━━┨            │          │ 2:00 ┊   ┊   ┊   ┊ 2:05 ┊ ▌now ┊   ┊ 2:10  │
│ ┃∿∿∿▌∿∿ │∿∿∿∿∿∿ │∿7/8∿∿ │∿∿∿∿∿∿ ┃            │          │ ▓∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿▌∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿     │
│ ┗━━━━━━━┷━━━━━━━┷━━━━━━━┷━━━━━━━┛            │          │ 2:10 ┊ …                     (loop tint ▓)   │
│ Chorus 2  bars 49–56                         │          │ …                                            │
│ ┌──49───┬──50───┬──51───┬──52───┐            │          │                                              │
│ └───────┴───────┴───────┴───────┘            │          │                                              │
├──────────────────────────────────────────────┤          ├──────────────────────────────────────────────┤
│Intro│Verse│Chorus│Verse 2│▐Bridge▌│Ch 2│Out  │          │∿∿∿│mk1∿∿│mk2∿∿▐∿mk3▬▌∿∿│mk4  [No bar grid ·  │
├──────────────────────────────────────────────┤          │                               Get bars →]    │
│[⟲ Again][ ■ Stop ][⟳ Loop][− 85% +][Count][Mix⌃]│        ├──────────────────────────────────────────────┤
└──────────────────────────────────────────────┘          │[⟲ Again][ ▶ Play ][⟳ Loop][− 100% +][Count][Mix⌃]│
                                                          └──────────────────────────────────────────────┘
                                                           S drops a marker: "Marker 4 added — Rename".
                                                           Count shows "Lead-in 2 s"; Click shows "Needs a bar grid".
```

### 10.7 Stems surface: laptop (for completeness; rail omitted)
```
│ [− + Fit] [Zoom to loop Z]  Grid: Bar ▾  Snap ● (⇧S)                                         Follow ●       │ 40
│ ruler:  37      38      39      40   ┊ 41      42      43      44      45      46      47      48 ┊ 49      │ 24
│ ┌ 1 ▌Drums   OUT ┐ ╱╱╱╱ outline + hatch (muted) ╱╱╱╱╱╱╱╱╱╱╱╱▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒╱╱╱╱╱╱╱╱╱╱╱╱     │
│ │ [M] [S] ▬▬ 100% │                              ⟦ loop band 41–48, 44 px handles on coarse ⟧              │
│ ├ 2 ▌Bass        ┤ ▂▃▅▆▅▃▂▃▅▆▅▃▂▃▅▆▅▃▂▃▅▆▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▅▃▂▃▅▆▅▃▂                      │
│ ├ 3 ▌Vocals SOLO ┤ ▁▁▅▇▅▁▁▅▇▅▁ … (accent ring on header)                                                     │
│ ├ 4 ▌Other       ┤ (outline: not soloed)                                                                     │
│ strip: sections + loop bracket + draggable viewport bracket ⟦      ⟧ (replaces the overview minimap)        │
```

### 10.8 Mix sheet: iPad portrait
```
├──────────────────────────────────────────────────────────┤
│ ───── (grabber)                                       ✕  │
│ Mix                                                      │
│ [✓ Minus me: Drums]  I play: Drums ▾  [Only me] [Full mix]│ 56
│ Tap to: ( Mute │ Solo )                                  │
│ ┌────────────┐ ┌────────────┐ ┌────────────┐             │
│ │▌Drums   [1]│ │▌Bass    [2]│ │▌Vocals  [3]│             │
│ │  OUT       │ │  ON        │ │  ON        │  120×168    │
│ │  ╱╱╱╱╱╱    │ │  ██████    │ │  ████      │  drag = level│
│ │      100%  │ │       100% │ │       70%  │             │
│ └────────────┘ └────────────┘ └────────────┘             │
│ ┌────────────┐                                           │
│ │▌Other   [4]│   tap: mute · hold: solo · drag: level    │
│ │  ON   ███  │                                           │
│ └────────────┘                                           │
│ Chart playback   ( Off | Quiet | Loud )                  │
└──────────────────────────────────────────────────────────┘
```

### 10.9 Add song: laptop (desktop app, with B4 candidates) and web
```
 DESKTOP APP                                                   WEB / iPad, NO PROCESSOR
┌────────────────────────────────────────────────────────────┐ ┌────────────────────────────────────────────────────┐
│ Add a song                                              ✕  │ │ Add a song                                      ✕  │
│ ┌────────────────────────────────────────────────────────┐ │ │ ┌────────────────────────────────────────────────┐ │
│ │ harbor lights ada moreno                Choose files…  │ │ │ │ Splitting happens on your computer.            │ │
│ └────────────────────────────────────────────────────────┘ │ │ │ Woodshed for Mac, Windows or Linux downloads   │ │
│ YouTube, SoundCloud, Spotify links · MP3 WAV FLAC M4A…     │ │ │ songs and splits them into stems. Everything   │ │
│ ◉ ┌──────┐ Harbor Lights (Official Audio)  Official 3:41  │ │ │ you add appears here and on your iPad.         │ │
│   │thumb │ Ada Moreno · YouTube                     72px  │ │ │ [ Download for macOS (Apple Silicon) ↗ ]       │ │
│   └──────┘                                                 │ │ │ Other platforms · Copy download link           │ │
│ ○ ┌──────┐ Harbor Lights — Live at the Roundhouse  Live 6:12│ │ │ Already installed? Open it and sign in.        │ │
│   └──────┘ Ada Moreno · YouTube                            │ │ └────────────────────────────────────────────────┘ │
│ ○ ┌──────┐ Harbor Lights (Drum Cover)       Cover 3:50     │ │ Meanwhile: [ Open the example song ]               │
│   └──────┘ StickWorks · YouTube                            │ │                                                    │
│ ⓘ Already in your library: Harbor Lights — Ada Moreno      │ │ B5, paired computer online:                        │
│   [Open it]  [Add another version]                         │ │ ┌ Paste a link or search…                       ┐  │
│ Split for drums · Balanced quality · 4 stems   [Change]    │ │ └ Your MacBook Pro will split this · ● Online ▾ ┘  │
│ Processing on this computer · ● Ready                      │ └────────────────────────────────────────────────────┘
│                       ⇧↵ add another  [Cancel] [Add & split]│
└────────────────────────────────────────────────────────────┘
 Before B4, free text shows one line: "Woodshed will search YouTube and use the top result for "…".
 You can check it when it's ready."   Inline error (input kept): ⚠ Woodshed's processor isn't running. [Restart processor]
 iPad: the same content in a 90% bottom sheet, 56 px rows and primary button.
```

### 10.10 Edit · Map posture: laptop
```
┌══════════════════════════════════════════════════════════════════════════════════════════════════════════════┐ 2 px --edit
│ ‹ Done   Second Wind   Editing map   [ Map | Chart | Details ]                       ↶ Undo  ↷ Redo   Saved  │ 48
├──────────────────────────────────────────────────────────────────────────────────┬───────────────────────────┤
│ [− + Fit][Z]  Grid: Beat ▾  Snap ● ⇧S                                            │ BAR 41   [◀ Bar] [Bar ▶]  │
│ bars │1 4/4 │2 │3 │4 │5 │…                     │41 7/8 │42 │43 │44 │…           │ Go to [ 41 ] [Go]  ⏮ ⏭    │
│ sect │ Intro      │ Verse              │ …      │ Bridge            │ Chorus 2   │ METER Beats [−] 7 [+]     │
│ tempo│▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔╱▔▔▔▔▔▔▔▔ ▒amber suspect▒ ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔│  Unit (1|2|4|8|16) Groups │
│      │ ♩=96 ◆                         ◆ ♩=102                           ◆        │  [2+2+3]  Pickup [ 0 ]    │
│ Drums│∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿│  Apply (This│Until│End)   │
│ M S ▬│                                                                         │  Keep (Beats│Bar lines)   │
│ Bass │∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿│  [Apply ↵]                │
│ Vox  │∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿│ LABEL [Bridge          ]  │
│ Other│∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿│ TEMPO ♩[102.00] ☐ Ramp R  │
│                                                                                  │  [×2] [÷2] Tail [−][+]    │
│ ⓘ You have 5 markers. [Turn them into sections]                                  │ PIN ● 0:48.120            │
│                                                                                  │  [Pin D][Pin beat T][Unpin]│
│                                                                                  │  [−10][−1] ms [+1][+10]   │
│                                                                                  │  This pin is bar [ 41 ]   │
│                                                                                  │ TOOLS [Tap along ⎵]       │
│                                                                                  │  [Preview bars P]         │
│                                                                                  │  [Calibrate taps…]        │
│                                                                                  │  ☐ Snap taps to drum hits │
│                                                                                  │  [Detect beats]           │
│                                                                                  │  [Find a chart…]          │
│                                                                                  │ ✓ Pinned bar 41 at 0:48.12│
├──────────────────────────────────────────────────────────────────────────────────┴───────────────────────────┤
│ [⟲] [▶] [‖]  41 · 1   0:48.12     [Loop: bars 41–48]  [100%]  [Count-in] [Click ●]  [Mix]                     │ 56
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 Unmapped: the inspector shows "Get a map": [Detect beats] / [Tap along] / [Find a chart…].
 Find a chart opens as a right side panel replacing the inspector (search, results, Import a file…,
 Other sources: enchor.us · Songsterr, Align ±10/±100 ms, [Use their map] [Use map + drum chart (312 hits)] [Keep my map]).
 iPad portrait: lanes and rows fill the top 55%; the inspector is a 45% bottom sheet with 48 px buttons in a
 3-column grid and no key-caps; hint "Map editing is roomier in landscape."
```

---

## Appendix A. Copy deck (Stage)
| Where | Copy |
|---|---|
| Resume chip | "Back at **{loop \| section \| time}** · {rate}% · {mix state} [Start over]" |
| Next cue | "next: {Section} · {n} bars" → "{Section} in 2 · 1" |
| Unmapped strip chip | "No bar grid · Get bars →" |
| Glass pill | "▶ Play from bar {n}" / "▶ Play from {m:ss}" |
| Hold to leave | "Hold to leave — playback will stop" |
| Esc while playing | "Stop playback first (Space)" |
| Interrupted | "Paused — audio was interrupted. Press Play to continue." |
| Marker | "Marker {n} added — Rename" |
| Spot | "Saved spot **{name}** · {rate}%" |
| Trainer | "Trainer: {rate}% · pass {p} of {n}" → "Trainer done — 100%" |
| Undo | "Undid: {what} {from} → {to} [Redo]" |
| Minus me, no stem | "This song wasn't split with a {instrument} part. Muting Other instead. [Re-split with 6 stems]" |
| Load error | "Couldn't load the audio for this song. [Try again]" |
| Key change hint | "Enter now starts again with a count-in. Pause is ⇧Space. [Keep old keys]" |
| Shared | "Changes stay on this device until you add the song to your library." |

## Appendix B. Capability preservation checklist (inventory → new home)
| Today | New home |
|---|---|
| Library grid/list, Songs/Albums/Artists tabs, search | Grid/list with columns, Group: Album/Artist plus drill-down chips, search plus ⌘K |
| Select mode, bulk metadata (≤ 100) | Selection bar plus bulk Details page (same per-field apply) plus bulk delete |
| Card menu: Play, Share, Reprocess, Edit, Select, Open source, Delete | Card menu (§2.5); Reprocess → Re-split |
| In-progress list, cancel, retry, dismiss | Processing on cards plus the Jobs popover (all job kinds) |
| Add: link, search, files, presets, stem modes, custom/advanced | Add sheet (§3) plus Settings → Processing Advanced |
| Desktop gate | Web explainer panel; B5 send-to-computer |
| Metadata editor, lookup, review, artwork, bulk | Edit · Details |
| Player loading and error states | Interactive loading with the Play ring; errors in the music area |
| Play/Stop, Pause, stop behaviour, readouts | Transport model (§4.6); Settings → Practice; HUD |
| Mute/solo/volume, reset mix, digit keys | Mix sheet, Stems surface rows, Edit · Map rows; 1–9, ⇧1–9, 0 |
| Zoom, fit, follow, overview, wheel zoom/pan | Stems surface toolbar plus wheel; strip viewport bracket; Follow pill and styles |
| Grid, snap, division | Stems surface and Edit · Map (G, ⇧S) |
| Loop A/B, ±50 ms and 10 ms nudges, set at playhead, clear, jump to A/B | Loop card (bar/beat or 0.1 s / Alt 50 ms / Alt+Shift 10 ms), handles, I/O, ⌫, Home/End |
| Speed 0.5–1.5×, keep pitch | Speed sheet (50–150%, presets, trainer); per-song keep pitch |
| Metronome on/off, accent, volume, count-in 1–16 bars/beats, audible pre-roll | Click sheet (all kept, plus every-pass and visual click) |
| Detect beats | Edit · Map Get a map / Tools; strip Get bars; Jobs |
| Tempo map: lane, pins, tap, calibrate, snap taps, Edit bar (pickup, apply-to, keep-in-place), ramps, ×2/÷2, tail tempo, renumber, nudge, go-to-bar, preview, undo, key sheet | Edit · Map inspector (§5.1), every key also a button |
| Find/import: search, file import, Other sources, align, commit variants | Find a chart side panel |
| Chart: sections, loop section, follow, size, Together/Hands & feet, mute drums, gestures, empty state | Chart surface, strip, Distance/pinch, Display menu, Mix, bar menu, empty-state actions |
| Transcribe: score/lanes, steps, dotted, tuplets, kit, properties, listen, copy/paste/repeat/move/tuplet/mark reviewed, bar meter & label, align, export, print, open part, drum-key remap, note list, show every kit piece, save statuses, recovery, shortcuts | Edit · Chart (§5.2); internals unchanged; pagination kept |
| Sharing dialog and shared view, save copy | Share dialog; Shared Stage with local practice state |
| Export library ZIP, export originals | Settings → Plan & storage; Settings → Processing (desktop) |
| Settings: theme, playback, song defaults, version, storage, cache, import legacy | Settings sections (§6.2) |
| Billing states, admin console, audit | Settings → Plan & storage; Admin with Reason dialogs |
| Desktop: companion, updates, app menu, quit guard, download page | Processor status, avatar update item, registry menu, quit guard (flushes), `/download` |
| Persistence (per-song practice, ws.* prefs) | Practice v2 plus `ws.prefs` |

---

## Decisions for the owner (subjective; my recommendation for each)
1. **Enter = Again, or keep Enter = Pause?**
   - Recommend **Enter = Again**, with Pause on ⇧Space. Again is the most frequent action in a practice loop, and Enter is the biggest easy key.
   - Ship "Classic keys" for v2.0–v2.1, plus a first-press hint and the What's-changed sheet.
2. **Laptop Stage layout: right rail, or bottom dock?**
   - Recommend the **264 px right rail**. It puts 64 px readouts at eye height next to the music and costs about 18% of chart width.
   - Focus collapses it to a 120 px mini rail. Choose a bottom dock only if you find the chart too narrow at 1280 px.
3. **Typeface: Atkinson Hyperlegible Next, or Inter?**
   - Recommend **Atkinson Hyperlegible Next + Mono**. It was designed for legibility at a distance, and it gives the app a distinctive voice.
   - Inter is the safe neutral alternative; it is a token swap either way.
4. **Stage appearance default: Always dark, or match the app theme?**
   - Recommend **Always dark**. It means less glare on a stand, it is the critiques' best-looking surface, and amber `--now` reads best on black.
   - The setting stays in Appearance.
5. **Transcribe score: keep 16-bar pages, or move to continuous scroll?**
   - Recommend **keeping pages in v2**. It is your favourite surface, and the change is cosmetic, not a fix.
   - Run continuous scroll as a flagged experiment after the score baselines and the iPad perf gate pass.
6. **Setlists: build B3 (a small Convex table) in v2.2, or stay with Pins?**
   - Recommend **building B3 right after Phase 3**. "Tomorrow's rehearsal" is the core scenario, and it is small backend work with no ML.
   - Pins cover the gap until then.
