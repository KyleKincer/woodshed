# Woodshed 2.0 "Stage": architecture (binding contract)

This document is the technical contract for building all of `docs/ux2/spec.md`: Phases 0–5, backend items B1, B2, B3, B4, B5, B6 and B8, and engine item E1. Implementers follow it literally. Where it is silent, the spec decides the UX and the subsystem maps (`docs/ux2/maps/*.md`) describe today's code. Where this document and a map disagree, this document wins. Where this document and the spec disagree, the spec wins on user-visible behaviour, except for the decisions recorded in §0.3, which resolve gaps and contradictions in the spec.

Baseline: commit `820f4db` (v1.9.0). Line references point at that tree.

**Owner decisions (final).**
- All "Decisions for the owner" recommendations in the spec are accepted: Enter = Again with Pause on ⇧Space; the laptop right rail; Atkinson Hyperlegible Next and Mono; the Stage is always dark by default; Transcribe keeps 16-bar pages; setlists (B3) are built.
- **There are no users to protect.** Nothing is built for transition. There are no Classic keys, no key-change hint, no "What's changed" sheet, no "new" badges, no `ws.flags` rollout gating, and no `legacy` CSS layer (§7.1).
- Data the owner already has is still read correctly through cheap one-way upgrades with no UI: `songs.practice` v1, the 13 `ws.*` localStorage keys, legacy tempo maps (`tempo.map`, `tempo.detected`, 1.6–1.9 `songMap` without `origin`), version-1 notation parts and IndexedDB drafts, existing `jobs`/`devices`/`userSettings` rows, and legacy-library `library.json` imports.

**Out of scope (decided):**
- **B7 ML section detection is not built.** It is large ML work on the companion; nothing here is "trivially cheap" about it. The sections lane, strip and HUD are designed so a later B7 only adds a data source.
- The Transcribe continuous-scroll experiment is not built. Edit · Chart keeps 16-bar pages.
- Local processing-disk cleanup (`/local-usage`, `/cleanup`) is not built.
- A silent looping `<audio>` element for Safari headset control is not built (see D13).

---

## 0. Ground rules

### 0.1 Conventions
- **Client:** plain ES modules plus Vite, no framework (spec §9.1). Client code is `.js`; `shared/*.ts` is imported directly (Vite already compiles it, for example `player.js:14`).
- **Factories, not classes,** for new code. The existing classes stay: `MultitrackEngine`, `Metronome`, `SongMapStore`, `NotationStore`, `ScoreEditor` and `DrumAudio`.
- **Every UI module imports its own CSS file** from `src/styles/…`, and that file wraps its rules in the correct `@layer` (§7.1). There is no central list of view stylesheets.
- **Every new network call goes through `src/api/*.js`** (§2.1). New code never imports `src/js/backend.js`, which is deleted in integration I3.
- **localStorage is touched only by** `public/theme-init.js` (read only) and `src/app/prefs.js`. A guard test enforces this (§7.6).
- **Keyboard:** `src/app/dispatch.js` installs the only document-level `keydown`/`keyup` listeners. A guard test enforces this. Components may listen on their own elements, and must mark the keys they consume with `data-consume-keys` (§2.6).
- **No `alert`, `confirm` or `prompt`.** A guard test enforces this.
- **Tests:** `vitest` with `// @vitest-environment happy-dom` for DOM tests (the repo default is `edge-runtime`, `vitest.config.ts`). Convex tests use `convex-test` in `convex/*.test.ts` (read `convex/_generated/ai/guidelines.md` first, as `CLAUDE.md` requires). Desktop tests are `desktop/*.test.cjs` (`node --test`). Companion Node tests are `companion/*.test.mjs` (`node --test`); Python tests are `companion/test_*.py`.
- **Playwright** is the preinstalled `/opt/node-tools/node_modules/playwright` (run with `NODE_PATH=/opt/node-tools/node_modules`). It is not added to `package.json`.
- **New devDependencies (exact versions, all verified with `npm view` on 2026-10-28):**
  - `@fontsource-variable/atkinson-hyperlegible-next@5.3.0`: the woff2 has `wght` 200–800 and the `tnum` and `pnum` features (checked with fontTools);
  - `@fontsource-variable/atkinson-hyperlegible-mono@5.3.0`: `wght` 200–800, monospaced;
  - `lucide-static@1.62.0`: 1,908 icons;
  - `axe-core@4.10.3`: for the accessibility probe.
  - No new runtime dependencies.

### 0.2 Concepts deleted outright
The edit cursor (renamed **cue**), the seconds-only practice strip, the metronome popover, the workspace nav and nested mode tabs, "loop the visible window", the chart's long-press-then-tap pending loop, the overview minimap, the header band and header update icon, `confirmModal`, the desktop-setup gate, the silent global drop upload, the tempo-sources inert freeze, the dual-write of legacy `tempo.source/map/detected`, `songs.rename`, `settings.format`, `worker.cancelForUpdate`, and every one of the six ad-hoc `keydown` listeners.

### 0.3 Decisions made in this document
These resolve open points in the spec and the maps. They are final.

| # | Decision |
|---|---|
| D1 | **No `legacy` CSS layer.** Old CSS is deleted in integration I1, the moment the new shell replaces `index.html`. Between waves, places that are not built yet render a placeholder view (D2). |
| D2 | **No adapters for old views.** Routes whose new view does not exist yet render `src/app/placeholder.js` ("Not built yet"). Placeholder routes are excluded from fixture captures until their wave. `placeholder.js` is deleted in wave 4. |
| D3 | **Stage tokens live on the root element:** `html[data-place=stage][data-stage-theme=dark]`. The router and `theme-init.js` set the attributes. Every canvas and alphaTab reader that reads tokens from `document.documentElement` therefore gets Stage colours without changes. |
| D4 | **B1 moves practice into a `songPractice` table.** `songs.list` returns a slim row. `songTempo` is **not** split out; instead the legacy `detected`/`map`/`source` dual-write is dropped, which roughly halves `tempo`. |
| D5 | `practiceSummary` carries the top 3 spots, and `mapSummary` carries up to 64 section names (for Continue chips and section search). |
| D6 | **All metadata backend additions are built:** G1 (unchanged keys never lock), G2 `unlock`, G3 `confirm`, G4 `match`, G5 `metadataSuggestion`, G6 `needsReview`, G9 `getMany`, G10 `updateEach`, G17 `retry`, plus `shared/metadata.ts`. |
| D7 | **The demo token is a server env var** `DEMO_SHARE_TOKEN`, read by the public query `settings.demo`. `VITE_DEMO_SHARE_TOKEN` is not used. |
| D8 | **Pins and setlists both exist.** Home shows a Setlists row (when any exist) **and** a Pinned row (when pins exist). |
| D9 | **The Electron static server serves any existing file under `dist/`, else `index.html`.** The allow-list goes. The MIME map gains `.webmanifest`, `.txt`, `.wasm`. |
| D10 | **Export-only accounts** may change practice, tempo, metadata and settings (personal state). They may not add songs, re-split, detect beats, pair devices, create shares or setlists, or upload artwork. A Banner says so (spec §6.3). |
| D11 | **Device presence is a `devicePresence` table** written by a device-token heartbeat, not `@convex-dev/presence`. Presence belongs to a device token, not a user session; "online" is computed on the client from `lastSeenAt`, so no query reads the wall clock. |
| D12 | **App updates pause jobs instead of cancelling them.** `process.py` is resumable, and `worker.next` resumes a `running` job first. `worker.cancelForUpdate` and the companion's `update-cancellation.json` marker are deleted. The restart prompt's busy copy becomes "Song processing will pause and resume after the restart." |
| D13 | **Media Session handlers are always registered.** No UI copy mentions headset or media-key control. Settings → This device shows whether Media Session is supported. |
| D14 | **One audio kill switch:** `prefs.audio.safeMode` (Settings → This device, "Safe audio mode", default **off**). When on: speed is clamped to 50–150%, segmented (gap) loops are disabled, so "count in every pass" counts the first pass only and "rest" is ignored, and trainer steps apply with an immediate `setSpeed` at the wrap event instead of a scheduled one. |
| D15 | **Beat lamps:** one dot per meter unit (the numerator: 4 for 4/4, 7 for 7/8, 6 for 6/8), grouped by `beatGroups` with a gap between groups. A group's first dot (a counted beat, which clicks) is larger; the downbeat dot is largest. A bar with more than 12 units shows one dot per group instead. This matches wireframe §10.5 (`● ●  ● ◉  ○ ○ ○`). |
| D16 | **"next" readout:** `next: {name} · {n} bars` gives the bars remaining until that section's downbeat. In the last 2 bars it becomes `{name} in {B} · {b}` (§4.4). Unmapped songs with markers show `next: {label} · {m:ss}`, the time remaining. |
| D17 | **Between passes** (Loop card): `None`; `1 bar rest`, a segmented-loop gap of one bar at the loop start's meter and tempo (clicks play in it unless Click is Off); and `Call & response`, gapless passes that alternate: odd passes play the mix as set, even passes mute *your* stems (Minus me) via `setTrackGains` scheduled exactly at the wrap. Call & response is disabled, with a reason, when no profile stem exists. |
| D18 | **Transcribe keys:** digits keep today's internals (1 = 1/64, 2 = 1/32, 3 = 1/16, 4 = 1/8, 5 = 1/4). 6 and 7 are unbound. The toolbar key-caps read 5·4·3·2·1. Drum letters win inside the score surface. C, K, L and E act on the posture only when focus is outside the surface (or through the toolbar and slim transport). Drum-key validation reserves every key bound in `edit.chart.score`. |
| D19 | **Edit · Map keys:** digits + Enter go to a bar (stems are muted with row M/S buttons in this posture); E focuses the inspector's Meter → Beats stepper; Space is Play/Stop (taps are D and T); Enter goes to the typed bar or applies the focused inspector field (never Again here); ⌫ unpins and never clears the loop. |
| D20 | **Find a chart without a freeze:** while auditioning, every map-mutating command and lane edit is disabled through `when: c => !c.map.auditioning`. The audition runs inside one `beginBatch()`, and tempo saves, notation map-sync saves and bar re-anchoring are suspended. Commits: `Use their map`, `Use map + drum chart (N hits)`, `Keep my map`. Esc means Keep my map; there is no separate Cancel. Leaving Edit · Map mid-audition asks "Use this map?" [Use it] [Keep my map]. |
| D21 | `hasRealMap` includes both recommended additions from `maps/mapedit.md` §11.1 (§4.1). |
| D22 | **Tap the beat** builds its map with a new `fromTaps` (least-squares period and phase), not `fromBeats` (§4.6). |
| D23 | **A section rename from the Stage** strip goes on the *practice* undo stack, as a forward inverse map edit; it never calls `map.undo()`. |
| D24 | **The `stage.stems` scope is active whenever the Stems surface is shown** (it is a surface mode, not focus-based). `edit.chart.score` is focus-based. |
| D25 | **F in the Stage:** if Follow is paused, F resumes it; otherwise F toggles Focus. On the Stems surface, F toggles Follow (spec §7.2). |
| D26 | **Scrolling:** `html` and `body` never scroll. Each place has exactly one scroller, marked `[data-scroller]`. The router saves and restores its `scrollTop` per history entry. |
| D27 | **The notation part, `DrumAudio` and the notation map guard are session-scoped.** Mix "Chart playback" is stored as `practice.chartAudio` (`off \| quiet \| loud`). |
| D28 | **Starting the trainer with no loop** first sets the loop to the trainer's target range (the current section, else the whole song) as one undo step. |
| D29 | **A quantized jump to a target outside an active loop** clears the loop as part of the same undo step. |
| D30 | **E1 is built:** the speed range is **25–150%** unless safe mode is on. Preset chips are unchanged (50…125); the stepper, `,` and `.` reach 25%. |
| D31 | **Web MIDI pedals are built** (Phase 5): Chromium and Electron only, behind a permission allow-list for the UI origin. |
| D32 | **Icons are one Lucide sprite**, built by a script, imported with `?raw` and inlined into `<body>` at boot. Icons use `<svg><use href="#i-name"/></svg>`. |
| D33 | **Fonts are vendored** into `src/styles/fonts/` by `scripts/vendor-fonts.mjs` from the pinned fontsource packages, and the woff2 files are committed. |
| D34 | **The bulk Details route** is `/edit/details?ids=a,b,c` (≤ 100 ids). |
| D35 | **In the Stage and Edit postures,** Space always goes to the registry, even on a focused button. Enter on a keyboard-focused button, link, menu item, tab, checkbox or option activates it natively; elsewhere Enter goes to the registry. |
| D36 | **Two overlay classes.** *Modal* overlays (Dialog, palette, menus, the `/add` sheet, Edit iPad inspector sheets) take all keys except their own bindings and Esc. *Non-modal* overlays (Stage sheets and popovers, the Notes card, the Jobs popover) let registry keys through. |
| D37 | **Profile-to-stem mapping:** drums → `drums`; bass → `bass`; vocals → `vocals`; guitar → `guitar`, else `other`; keys → `piano`, else `other`; other → `other`. On a 2-stem song only an exact stem name matches; `no_*` stems never match. If no instrument matches, Minus me opens the Mix sheet. |
| D38 | **A re-split of an upload-sourced song** must run on the device that holds the original file (`songs.originDeviceId`). Any other device is refused with a coded error. |
| D39 | **First-run "What do you play?"** is the route `/welcome`. Boot pushes it once, when `settings.onboarding.whatDoYouPlay` is unset. |
| D40 | **Settings scope** (account vs device) follows spec §6.2: only items marked "(this device)" are device prefs, plus Settings → This device and everything listed under `ws.prefs` in §2.5. |
| D41 | **The Electron menu registers only modifier accelerators** (⌘N, ⌘W, ⌘, and other Mod combos). Plain keys are not shown in native menus; the `?` sheet shows them. |
| D42 | `settings.save` is deleted. Every settings write goes through `settings.patch` (§6.5). |

---

## 1. Module tree

Every file below has exactly one responsibility. **(new)** marks a new file; **(kept)** means unchanged except as listed in its work package; **(changed)** means it keeps its role with API changes. Anything under `src/js/` that is not listed is deleted (§8).

```
index.html                        (changed) <div id="app">, #startup status, theme-init <script>, module entry /src/app/main.js; no view markup
public/theme-init.js              (changed) pre-paint: reads ws.prefs (falls back to ws.theme/ws.view); sets data-theme, data-place, data-stage-theme, data-library-layout, theme-color
public/manifest.webmanifest       (new) PWA manifest: standalone, orientation any, icons, theme_color #08090a
public/icon-192.png, icon-512.png, icon-maskable-512.png   (new) PWA icons rendered from woodshed-icon.svg
public/licenses/atkinson-hyperlegible-next.txt, atkinson-hyperlegible-mono.txt   (new) OFL texts

src/app/
  main.js            (new) boot: route kind (app|share|download) → auth → account/config → data subscriptions → registry → router.start()
  routes.js          (new) route table: pattern → lazy view, place, chrome, posture scope, session flag, guard, modal parent
  router.js          (new) History API router: match, navigate/replace/back, query mirroring, scroll/focus restoration, legacy redirects, leave hooks
  store.js           (new) signals (signal/computed/effect/batch) and the app store slices
  prefs.js           (new) ws.prefs v1 device prefs: schema, defaults, one-way migration of the 13 ws.* keys, cross-tab sync, deviceStore()
  account.js         (new) account settings: settings.config subscription, settings.patch with optimistic merge, profile/pins/onboarding accessors
  profile.js         (new) instrument profile → stem names (Minus me), Add defaults from the profile (pure)
  data.js            (new) app-lifetime subscriptions: songs.list, jobs.listActive, devices.list, setlists.list → store.library
  keys.js            (new) key-string grammar: parse, match a KeyboardEvent, platform labels (⌘/Ctrl), aria-keyshortcuts, Electron accelerators
  commands.js        (new) command registry: register/get/run/list/bindings, context providers, change notifications
  dispatch.js        (new) the only document keydown/keyup listeners; overlay stack; scope-chain resolution; consume rules
  global-commands.js (new) global and navigation commands (palette, ?, search, settings, library, add, layered Esc)
  pedals.js          (new) pedal classifier (tap/hold/double), pedal-mode runtime, learn flow
  midi.js            (new) Web MIDI input → registry commands (Chromium/Electron)
  palette.js         (new) ⌘K palette: providers, query parsing, frecency, rendering
  shortcuts-sheet.js (new) the ? sheet, generated from the registry, current scope chain first
  feedback.js        (new) toast queue (held while playing), Stage status-line bus, confirm()/form() dialogs, announce()
  error-copy.js      (new) ConvexError code / job errorCode → {sentence, primary, secondary, details} (spec §3.6)
  platform.js        (new) wake lock, audio-interruption watcher, Media Session, PWA install state, pointer/platform signals
  desktop.js         (new) feature-detected wrapper over window.woodshedDesktop; processor status and update models
  desktop-menu.js    (new) registry → Electron menu spec sync; onCommand/onNavigate/onFlushRequest/onFullScreen wiring
  notify-ready.js    (new) job-completion watcher → toast or native notification
  topbar.js          (new) 56/60 px top bar: wordmark, search, Jobs chip slot, Add, avatar menu with update dot
  fatal.js           (new) fatal boot card; paused-account page; offline/codec banners
  placeholder.js     (new, deleted in wave 4) "Not built yet" view for unbuilt routes

src/api/             thin Convex wrappers; normalise errors to ApiError {code, message, data}
  client.js          (new) query/mutation/action/subscribe over the authenticated client from auth.js; public client for share
  songs.js           (new) list/get/getMany/savePractice/saveTempo/remove/markReviewed/exportPage
  media.js           (new) signKeys with the 6 h cache (moved from backend.js:73-100), signKey
  storage.js         (new) usage
  jobs.js            (new) listActive/get/createSeparation/createBeatDetection/cancel/dismiss/retry
  devices.js         (new) pair/list/rename/revoke
  settings.js        (new) config/patch/demo
  sharing.js         (new) status/create/revoke/view/saved/playback/save
  setlists.js        (new) list/get/create/rename/setSongs/addSongs/remove
  metadata.js        (new) update/updateEach/confirm/find/detail/retry/uploadArtwork
  tempo-sources.js   (new) search/load
  billing.js         (new) status/checkout/portal
  admin.js           (new) access/overview/accounts/account/history/updateAccount/updatePolicy/revokeDevice/cancelJob

src/ui/              primitives: each factory returns {el, set(props), destroy()} (§2.12)
  h.js               (new) h(), text(), reconcileList() (keyed, focus-preserving)
  icon.js            (new) icon(name, {size}) → <svg><use>; sprite injection at boot
  button.js          (new) Button, IconButton
  toggle.js          (new) Toggle (aria-pressed)
  hold-button.js     (new) HoldButton (progress ring)
  segmented.js       (new) Segmented (radiogroup)
  chip.js            (new) Chip, ChipGroup
  stepper.js         (new) Stepper (spinbutton; hold-to-repeat; value may open a sheet)
  slider.js          (new) Slider (custom role=slider; arrows only)
  fader.js           (new) Fader (level control; double-tap reset)
  field.js           (new) TextField, Select, Textarea, ChipInput
  menu.js            (new) Menu (role=menu, roving focus, type-ahead, sheet on coarse) + bindContextMenu()
  position.js        (new) place(anchorRect, size, viewport, placement) (pure) + anchor-positioning fallback
  popover.js         (new) Popover (Popover API)
  sheet.js           (new) Sheet (bottom sheet on band, anchored popover on rail; detents; swipe-dismiss)
  dialog.js          (new) Dialog (native <dialog>, focus return, async form submit)
  toast.js           (new) Toast view (rendered by feedback.js)
  status.js          (new) InlineStatus
  banner.js          (new) Banner (in flow)
  progress.js        (new) ProgressRail, ProgressRing, StageStepper
  tabs.js            (new) Tabs (roving tablist)
  kbd.js             (new) Kbd (hidden on touch-only devices)
  tooltip.js         (new) tooltip(el, {text, kbd})
  empty.js           (new) EmptyState
  skeleton.js        (new) Skeleton
  readout.js         (new) Readout (scales with --distance)
  beat-lamps.js      (new) BeatLamps
  stem-pad.js        (new) StemPad
  coachmark.js       (new) CoachMark

src/stage/
  session.js         (new) one song session (song, engine, metronome, map, transport, practice, notation, peaks), shared by Stage and Edit
  notation-session.js (new) lazy drum part (part.js), legacy timeline adoption, map guard, shared DrumAudio
  transport.js       (new) façade over engine+metronome: cue model, play/stop/again/pause, count-in policy, passes, trainer, quantized jump, play-N-times, between-passes, mix
  transport-commands.js (new) registry entries: transport, loop, speed, click, mix, navigation (scopes stage + edit)
  position.js        (new) mapped/unmapped position model: labels, regions (sections or markers), next, steps, snapping, loop default, bar refs
  practice-state.js  (new) practice v2 in memory: patch, debounced save, flush triggers, merge, prune, bar re-anchoring
  undo.js            (new) practice undo stack (50 steps, 1 s coalescing) + "Undid:" feedback
  frame.js           (new) one rAF bus per mounted posture (60 Hz canvases, ≤ 30 Hz text)
  glass.js           (new) pointer policy table (spec §4.9), pure
  layout.js          (new) rail/band decision, Distance metrics, rail width, Focus geometry (pure + data attributes)
  stage.js           (new) Stage view: mount/unmount, layout, surfaces, sheets host, status line, loading/errors, resume chip, Esc and hold-to-leave
  commands.js        (new) Stage registry entries: view, surfaces, Focus, Distance, markers, spots, sheets, edit, leave, setlists
  hud.js             (new) identity row, Section, Next, Position, lamps, Speed, Loop, Mix, status line, count-in plate
  controls.js        (new) one control set rendered as band dock, rail grid, mini rail or Edit slim transport
  strip.js           (new) song strip: sections or waveform, overlays, gestures, keyboard slider, viewport bracket
  menus.js           (new) bar, section, spot, marker, loop-band and stem menus (item builders)
  coach.js           (new) first-Stage coach marks
  grid.js            (new) grid ticks and snapping for Stems and Edit · Map (pure)
  wave-render.js     (new) the one waveform renderer: peak pyramid, stem rows, road-map cells, strip, map lanes, hatch
  loop-handles.js    (new) loop band + handle overlay DOM (44 px hit areas) shared by Road map and Stems
  pinch.js           (new) pinch/two-finger recogniser (CSS-transform preview, commit on release)
  sheets/host.js     (new) opens a named sheet as a bottom Sheet (band) or anchored Popover (rail); one at a time
  sheets/speed.js    (new) Speed sheet + trainer
  sheets/click.js    (new) Click & count-in sheet
  sheets/mix.js      (new) Mix sheet
  sheets/loop.js     (new) Loop card
  sheets/spots.js    (new) Spots list
  sheets/notes.js    (new) Notes card (non-modal, in the music area)
  sheets/tap-beat.js (new) Tap the beat sheet
  sheets/get-bars.js (new) Get bars popover
  surfaces/chart-surface.js    (new) hosts notation/chart.js; glass, pinch, follow pill, bar list overlay
  surfaces/roadmap-surface.js  (new) Road map (mapped) and Wave page (unmapped)
  surfaces/roadmap-layout.js   (new) row layout for both (pure, tested)
  surfaces/stems-surface.js    (new) Stems surface: toolbar, ruler, rows, pointer model, wheel

src/edit/
  edit.js            (new) posture frame: posture bar (Done, title, label, tabs, Undo/Redo, save status), slim transport host, inspector container
  slim-transport.js  (new) 56 px Edit transport (renders controls.js 'slim')
  commands.js        (new) shared Edit commands (Done, tabs, undo/redo routing)
  drum-import.js     (new) file → parse → importDrumHits → session.notation.importScore (used by Map Find panel and Chart Part ▾)
  map/session.js     (new) map editing logic without DOM (ported from map-mode.js)
  map/view.js        (new) Edit · Map main area: toolbar, ruler/sections/tempo lanes, stem rows, strip; geometry
  map/lane.js        (new) lane drawing + hit testing (ruler, sections, tempo; 12 px diamonds, 24/44 px hits)
  map/inspector.js   (new) inspector (Go to, Meter, Label, Tempo, Pin, Tools, status) and "Get a map"
  map/sections.js    (new) sections-lane edits and markers → sections
  map/find-panel.js  (new) Find a chart side panel (ported from tempo-sources.js)
  map/commands.js    (new) edit.map registry entries
  chart/chart-edit.js (new) Edit · Chart frame hosting notation/editor.js through slots
  chart/toolbar.js   (new) Chart toolbar
  chart/menus.js     (new) Edit ▾ / Part ▾ / section jump menus from editor.menus()
  chart/kit-bank.js  (new) iPad portrait kit pad bank
  chart/commands.js  (new) edit.chart and edit.chart.score registry entries (incl. dynamic drum letters)
  details/details.js (new) Edit · Details page (single and bulk)
  details/fields.js  (new) field definitions, per-field serialise/compare (from song-metadata.js:6-68)
  details/artwork.js (new) cover, Choose another cover, Upload, Remove
  details/match.js   (new) match status, Yes/Find another, results, diff review, attribution
  details/bulk.js    (new) bulk "Apply to N songs" rows

src/library/
  home.js            (new) Library place: Continue, Setlists, Pinned, Library header/chips/sort/group/view, grid/list
  library-model.js   (new) filter/sort/group/search (pure)
  song-labels.js     (new) artistLabel (from song-metadata.js:38-40), meta line, state line, relative time
  cards.js           (new) SongCard, SongRow (reconcile-friendly)
  continue.js        (new) Continue hero + recents
  jobs.js            (new) jobs view-model, Jobs chip, Jobs popover
  add-model.js       (new) input classification, title badges, duplicate check, profile defaults, copy (pure)
  add-sheet.js       (new) /add sheet (desktop, web explainer, B5 device picker, B4 candidates)
  upload.js          (new) XHR uploads with real progress, cancellable, then createSeparation
  dropzone.js        (new) Library window drop → /add with files staged
  selection.js       (new) selection model + floating bar + bulk delete
  card-menu.js       (new) card menu items
  resplit-dialog.js  (new) Re-split dialog
  review-chip.js     (new) "Is this right?" chip + popover
  setlists.js        (new) Setlists row on Home, "Add to setlist ▸"
  setlist-page.js    (new) /set/:id page
  first-run.js       (new) Demo and Add cards
  commands.js        (new) library registry entries

src/settings/
  settings.js        (new) Settings frame: section nav (laptop), list → detail (iPad portrait)
  sections/practice.js, instruments.js, pedals.js, processing.js, appearance.js, plan.js, device.js, account.js   (new) one per §6.2 section
  admin/admin.js     (new) /admin overview, policy, account search
  admin/account.js   (new) /admin/accounts/:id
  admin/reason-dialog.js (new) required-Reason confirm Dialog

src/share/
  share-dialog.js    (new) Share dialog (VITE_SHARE_ORIGIN)
  shared-stage.js    (new) /share/:token boot: public client, read-only session, identity row, Add to my library
  shared-practice.js (new) device-local practice for a token; migrates into the saved copy
  demo.js            (new) demo token lookup and "Open example"

src/onboarding/
  signin.js          (new) sign-in card (spec §6.6.1)
  instruments.js     (new) InstrumentPicker (56 px chips, primary badge), shared with Settings → Instruments and the Mix sheet
  welcome.js         (new) /welcome "What do you play?"

src/download/download.js  (new) /download page (logic from src/js/desktop.js:13-97)

src/styles/
  main.css           (new) the @layer order statement + reset, tokens, fonts, base, layout, utilities
  reset.css, tokens.css, fonts.css, base.css, layout.css, utilities.css   (new)
  primitives/*.css   (new) one file per primitive module, imported by that module
  views/**/*.css     (new) one file per view module, imported by that module
  fonts/*.woff2      (new, vendored) 4 files (§7.3)
  icons.svg          (new, generated) sprite; icons-custom/*.svg (new) custom glyphs

src/js/              the kernel: audio, models, notation internals (kept, or changed as listed)
  engine.js (changed) · metronome.js (changed) · song-map.js (changed) · waveform.js (changed: computePeaksRange only)
  stemcache.js (changed: codec copy) · decoded-stem-cache.js · media-fetch.js · onsets.js · timeline-navigation.js
  tempo-import.js · tempo-archive.js · guitar-pro-import.js · guitar-pro-bounds.js · map-lane.js (changed: pure helpers only)
  artwork.js · auth.js (changed: core only) · startup.js · companion.js (changed) · export.js (changed: src/api) · download-release.js (changed: fetchRelease)
  motion.js · notation/{chart.js (changed), editor.js (changed), score-view.js (changed), part.js (changed), audio.js (changed),
                       alphatab-score.js, store.js, entry.js, import-drums.js, lanes.js (changed: tokens), html.js}

shared/
  song-map.ts        (changed) origin, ORIGINS, hasRealMap, barsOf/sectionsOf, fromTaps
  practice.ts        (new) practice v2 types, upgradePractice, mergePractice, prunePractice, summarize, sanitizeForShare, PRACTICE_CAP
  metadata.ts        (new) validateField, LIMITS, labels (used by convex/lib/songMetadata.ts and Edit · Details)
  notation.ts, engrave.ts, content.ts, sng.ts   (kept)

convex/
  schema.ts (changed) · lib/errors.ts (new) · lib/auth.ts (changed: coded errors) · lib/presets.ts (changed) · lib/songMetadata.ts (changed)
  songs.ts (changed) · notation.ts (changed) · jobs.ts (changed) · worker.ts (changed) · devices.ts (changed) · storage.ts (changed)
  settings.ts (changed) · sharing.ts (changed) · shareAudio.ts (changed) · metadata.ts (changed) · metadataLookup.ts (changed)
  admin.ts (changed) · setlists.ts (new) · migrations.ts (new) · convex.config.ts (changed: env)

companion/
  server.mjs (changed) · lookup.mjs (new) · ytdlp-args.json (new) · errors.py (new) · process.py (changed) · pipeline.py (changed)
  lookup.test.mjs (new) · test_errors.py (new) · fixtures/ytdlp/*.json (new)

desktop/
  main.cjs (changed) · preload.cjs (changed) · menu.cjs (new) · window-state.cjs (new) · update-controller.cjs (changed)
  menu.test.cjs (new) · window-state.test.cjs (new) · static-server.test.cjs (new)

scripts/
  vendor-fonts.mjs (new) · build-icons.mjs (new) · check-css.mjs (new) · check-source.mjs (new) · smoke-desktop.mjs (changed)
```

---
