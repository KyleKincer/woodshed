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
- **Web storage is touched only by** `public/theme-init.js` (read only), `src/app/prefs.js`, and `src/app/router.js` (the `sessionStorage` intended-route stash). A guard test enforces this (§7.6). IndexedDB stays in `notation/store.js`.
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
  schema.ts (changed) · lib/errors.ts (new) · lib/validators.ts (new) · lib/auth.ts (changed: coded errors) · lib/presets.ts (changed) · lib/songMetadata.ts (changed)
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
## 2. Public interfaces

Signatures are JavaScript. `Signal<T>` and `ReadonlySignal<T>` come from `src/app/store.js`. "Emits" means the module's `on(event, fn) → off`.

### 2.1 `src/api/client.js`
```js
export function query(name, args = {}) → Promise<any>            // name is 'module:function', e.g. 'songs:get'
export function mutation(name, args = {}) → Promise<any>
export function action(name, args = {}) → Promise<any>
export function subscribe(name, args, onValue, onError?) → off  // convex.onUpdate on the authenticated client
export function publicClient() → {query, subscribe, close}      // unauthenticated ConvexClient for /share (one per page)
export class ApiError extends Error { code; data; raw }          // code = ConvexError data.code, else 'unknown'
```
Every wrapper in `src/api/*.js` is a one-line call through these and rethrows `ApiError`. Error copy comes only from `error-copy.js` (§2.10).

### 2.2 `src/app/store.js`
```js
export function signal(initial, {equals = Object.is} = {}) → Signal
//   Signal = {get value(), set value(v), peek(), update(fn), subscribe(fn) → off}
export function computed(fn) → ReadonlySignal
export function effect(fn) → dispose        // runs now and on change of any signal read; fn may return a cleanup
export function batch(fn)                    // one notification pass at the end
export const store = {
  session:  signal({user: null, admin: false, status: 'active', online: true}),   // status: 'active'|'export_only'|'suspended'
  config:   signal(null),           // settings.config: {presets, models, stemModes, bitrates, defaultPreset}
  account:  signal(null),           // settings.config.settings (account settings; §2.4)
  prefs:    signal(PREFS_DEFAULTS), // device prefs (§2.5), owned by prefs.js
  library:  {songs: signal(new Map()), loaded: signal(false), jobs: signal([]), uploads: signal([]),
             devices: signal([]), setlists: signal([])},
  processor: signal({phase: 'web'}),   // §2.11
  update:    signal({status: 'idle'}),
  stage:     signal(null),   // {songId, layout, surface, playing, focus} while a Stage or Edit view is mounted
};
```
The playback position never passes through signals. It flows through the frame bus (§2.14.7).

### 2.3 `src/app/router.js` and `routes.js`
```js
// routes.js
export const routes = [
  {name: 'library',      path: '/',                          place: 'library',  chrome: 'topbar', view: () => import('../library/home.js')},
  {name: 'add',          path: '/add',                       place: 'library',  chrome: 'topbar', modalOver: 'library', view: () => import('../library/add-sheet.js')},
  {name: 'welcome',      path: '/welcome',                   place: 'library',  chrome: 'none',   view: () => import('../onboarding/welcome.js')},
  {name: 'stage',        path: '/s/:songId',                 place: 'stage',    chrome: 'none',   posture: 'stage', session: true, view: () => import('../stage/stage.js')},
  {name: 'edit',         path: '/s/:songId/edit/:tab',       place: 'edit',     chrome: 'none',   posture: 'edit',  session: true, tabs: ['map', 'chart', 'details'], view: () => import('../edit/edit.js')},
  {name: 'editFind',     path: '/s/:songId/edit/map/find',   place: 'edit',     chrome: 'none',   posture: 'edit',  session: true, view: () => import('../edit/edit.js'), params: {tab: 'map', find: true}},
  {name: 'bulkDetails',  path: '/edit/details',              place: 'edit',     chrome: 'none',   posture: 'edit',  view: () => import('../edit/details/details.js')},   // ?ids=a,b,c
  {name: 'settings',     path: '/settings',                  place: 'settings', chrome: 'topbar', view: () => import('../settings/settings.js')},
  {name: 'settingsPage', path: '/settings/:section',         place: 'settings', chrome: 'topbar', view: () => import('../settings/settings.js')},
  {name: 'admin',        path: '/admin',                     place: 'admin',    chrome: 'topbar', guard: s => s.admin, view: () => import('../settings/admin/admin.js')},
  {name: 'adminAccount', path: '/admin/accounts/:id',        place: 'admin',    chrome: 'topbar', guard: s => s.admin, view: () => import('../settings/admin/account.js')},
  {name: 'setlist',      path: '/set/:id',                   place: 'library',  chrome: 'topbar', view: () => import('../library/setlist-page.js')},
];
export const bootRoutes = [            // matched by main.js before auth; each has its own boot path
  {name: 'download', path: '/download',      boot: () => import('../download/download.js')},
  {name: 'share',    path: '/share/:token',  boot: () => import('../share/shared-stage.js')},   // token /^[a-f0-9]{64}$/, optional trailing /
];
export const redirects = [             // applied with replaceState before the first mount
  {from: url => url.pathname === '/' && url.searchParams.has('song'), to: url => `/s/${url.searchParams.get('song')}`},
  {from: url => url.pathname === '/billing', to: url => `/settings/plan${url.search}`},   // keeps ?checkout=success
];

// router.js
export function createRouter({routes, redirects, outlet, ctx}) → Router
Router = {
  start(),                                   // after auth; reads location, applies redirects, mounts
  current: ReadonlySignal<Match>,            // {name, path, params, query, state, route}
  navigate(to: string, {replace = false, state} = {}),
  back({fallback = '/'} = {}),               // history.back() when the previous entry is ours, else navigate(fallback)
  setQuery(patch, {debounceMs = 0} = {}),    // always replaceState; null removes a key
  href(name, params = {}, query = {}) → string,
  onLeave(fn: (from, to) => void|Promise) → off,   // flush hooks; never block navigation
  link(el)                                   // delegate: same-origin <a href> clicks → navigate (modifier clicks pass through)
}
```
**Mounting.**
- Every view module exports `mount(el, match, ctx) → {update(match), unmount(): void|Promise}`. `ctx = {router, store, registry, feedback, platform, desktop, session?}`.
- Same route name and same view → `update(match)`. Otherwise the old view unmounts, then the new one mounts.
- `modalOver: 'library'`: the parent view stays mounted underneath, and the modal view mounts into an overlay outlet. Back closes the modal.
- `session: true`: the router calls `getSession(songId)` (§2.14.1) and passes it as `ctx.session`. Moving between `stage`, `edit` and `editFind` with the same `songId` keeps the session. Navigating to a non-session route or another song calls `disposeSession(previousId)` after the view unmounts.
- A failed `guard` replaces the URL with `/` and shows the toast "Administration is for admins."
- **Root attributes:** the router sets `html[data-place]` and `data-posture` on every mount, then dispatches `window` `woodshed:place` `{place, posture}`. Canvas modules re-read tokens on `woodshed:place` and on `woodshed:theme`.

**History rules** (spec §1.2):
- **Push:** a place change, opening a song, entering Edit, opening `/add`.
- **Replace:** Edit tab switches, Library `q/sort/group/filter/artist/album` (debounced 400 ms), and Stage `?bar=`/`?t=` (written only on Stop, never while playing).
- **Overlays never touch history.**

**Scroll and focus:**
- `history.state = {key, scroll: number, focus: string|null}`.
- Before leaving, the router stores the `[data-scroller]` `scrollTop` and the `data-focus-key` of the focused element. On `popstate` it restores both after `mount` resolves.
- The Library sets `data-focus-key="song:<id>"` on cards, so Back from the Stage refocuses the card that was opened.

**Auth interplay:**
- `start()` runs after `auth.initialize()`, so OAuth params are already stripped.
- Before `signIn` on desktop, `sessionStorage['ws.intendedRoute'] = location.pathname + location.search`. After sign-in, `start()` navigates there once (with replace) and deletes the key.

**Leaving:** `pagehide` and `visibilitychange → hidden` call every `onLeave` hook with `to = null`. The session uses this to flush.

### 2.4 `src/app/account.js` (account settings)
```js
export const account = {
  value: ReadonlySignal<AccountSettings>,                  // withDefaults(settings.config.settings), live
  patch(partial: Partial<AccountSettings>) → Promise<void>, // optimistic; settings.patch merges on the server; failure reverts + throws ApiError
  profile: ReadonlySignal<Profile>, pins: ReadonlySignal<string[]>,
  togglePin(songId) → Promise<void>,                       // ≤ 12, toast "Up to 12 pins" when full
  markOnboarding(key: 'whatDoYouPlay'|'coach'|'desktopFirstRun', value) → Promise<void>,
};
AccountSettings = {
  preset, stemMode, bitrate, custom: {model, shifts, overlap},       // processing (existing)
  autoBeats: boolean (true), notifyReady: boolean (true),             // B6, §3.5
  profile: {instruments: Instrument[], primary: Instrument|null, openWithMyPart: 'in'|'out'},   // default {[], null, 'in'}
  pins: string[],                                                     // song ids, ≤ 12
  onboarding: {whatDoYouPlay?: 'done'|'skipped', coach?: number /*bitmask of steps 1-4*/, desktopFirstRun?: true},
  practice: {stop: 'cue'|'stay', countIn: {on: boolean, length: 1..16, unit: 'bars'|'beats'}, eachPassCount: boolean,
             keepPitch: boolean, wake: 5|10|30|'always'},
  // defaults: stop 'cue'; countIn {false, 1, 'bars'}; eachPassCount true; keepPitch true; wake 10
}
Instrument = 'drums'|'bass'|'guitar'|'keys'|'vocals'|'other'
```

### 2.5 `src/app/prefs.js` (device prefs, `localStorage['ws.prefs']`)
```js
export const PREFS_DEFAULTS = {
  v: 1,
  theme: 'system',                 // 'system'|'light'|'dark'
  stage: 'dark',                   // 'dark'|'match'   (Appearance → Stage)
  library: {layout: 'grid', group: 'none', sort: null, filter: null, opened: []},   // sort null → default rule (§2.16); opened: song ids opened on this device (≤ 500, FIFO) for the New dot
  practice: {distance: 'stand', focus: false, follow: {rail: 'scroll', band: 'page'}, edgeFlash: false, announceSections: false},
  chart: {display: {layout: null}, pinchScale: null},                  // layout null = the part's own layout
  stems: {grid: 'bar', snap: true, follow: true},                       // grid: 'off'|'bar'|'beat'|'half'|'quarter'
  roadmap: {waveRowSec: null},                                          // null → 10 rail / 8 band
  edit: {lastTab: 'map', map: {tapSnap: true, tapOffset: 0}, chart: {view: 'score', keys: {}}},
  pedals: {enabled: false, profile: 'practice', pedals: [], custom: {}},  // pedals: [{slot, code, canHold}]
  midi: {enabled: false, bindings: []},                                   // [{device, type:'note'|'cc', number, command}]
  palette: {frecency: {}},                                               // {[itemId]: {n, at}}, ≤ 200 entries
  deviceId: null,                  // B5: the processor last chosen in Add
  jobStats: {},                    // {[preset]: {secPerMin, n}} for "~2 min on this computer"
  audio: {safeMode: false},        // D14
  hints: {fullscreenFocus: false},
};
export function loadPrefs(storage = localStorage) → Prefs           // parse ws.prefs, deep-merge defaults; on absence run migrateLegacy
export function migrateLegacy(storage) → Prefs                       // pure over a Storage-like object; tested
export const prefs = {
  value: ReadonlySignal<Prefs>,
  get(path: string) → any,                                           // 'practice.distance'
  set(path: string, value) → void,                                   // writes the whole JSON; try/catch; failure → in-memory only
  update(fn: (draft) => void) → void,
};
export function deviceStore(namespace: string) → {get(key), set(key, value), remove(key)}   // 'share' → ws.share.<key>
```
**Migration (one way, no UI).** It runs once, when `ws.prefs` is absent. It reads each legacy key, writes `ws.prefs`, and then removes the legacy keys. Everything sits inside one try/catch.

| Legacy key | → `ws.prefs` |
|---|---|
| `ws.theme` | `theme` |
| `ws.view` `{group, layout}` | `library.layout`; `library.group`: albums → `'album'`, artists → `'artist'`, songs → `'none'` |
| `ws.stopBehavior` `'return'\|'stay'` | **account** `practice.stop` (`'cue'\|'stay'`), patched once after boot when it differs from the default; then removed |
| `ws.grid` `{visible, snap, division}` | `stems.grid` (`!visible` → `'off'`; division 1/2/4 → `'beat'\|'half'\|'quarter'`), `stems.snap` |
| `ws.overview` | dropped |
| `ws.preservePitch` | **account** `practice.keepPitch`, once, like `ws.stopBehavior` |
| `ws.practice.view` | dropped (the surface default rule replaces it) |
| `ws.chart.scale` | `chart.pinchScale` |
| `ws.chart.layout` | `chart.display.layout` |
| `ws.notation.layout` | `edit.chart.view` |
| `ws.notation.keys` | `edit.chart.keys` (must survive: remapped drum letters) |
| `ws.tapSnap` | `edit.map.tapSnap` |
| `ws.tapOffset` | `edit.map.tapOffset`, clamped to ±0.2 s |

**Rules:**
- `prefs.js` listens to `storage` events for `ws.prefs` and re-reads, so tabs stay in sync.
- On every `theme` or `stage` change it calls `window.woodshedAppearance.set(theme)` (kept from theme-init) and `desktop.setTheme(theme)`.
- `theme-init.js` reads `ws.prefs.theme`, `.stage` and `.library.layout` pre-paint, and falls back to `ws.theme`/`ws.view` if `ws.prefs` is absent. It never writes.

### 2.6 `src/app/keys.js`, `commands.js`, `dispatch.js`
**Key strings.**
```
KeyString := (Mod+)?(Ctrl+)?(Alt+)?(Shift+)?Base           canonical modifier order
Mod   = ⌘ (metaKey) on macOS/iPadOS, Ctrl elsewhere; 'Ctrl+' means the real Control key (used only for ⌃⌥ background shortcuts)
Base  = code   KeyA…KeyZ, Digit0…Digit9                     matched on e.code (layout-independent)
      | named  Space Enter Escape Backspace Delete Tab ArrowLeft ArrowRight ArrowUp ArrowDown Home End PageUp PageDown ContextMenu F10
      | symbol , . [ ] ` = - \ / * ?                          matched on e.key; see aliases
Symbol matching:
  'X' (no Shift):     e.key === X, or e.key in ALIAS[X] ('=' also '+'; '-' also '−')
  'Shift+X':          e.shiftKey && (e.key === X || e.code === US_CODE[X])    // US_CODE: , Comma . Period [ BracketLeft ] BracketRight ` Backquote
  '?' and '*':        e.key only; Shift is ignored
Exact modifiers: every modifier not in the string must be up (Shift is ignored only for '?', '*').
```
```js
// keys.js
export function parseKey(str) → {mod, ctrl, alt, shift, base, kind: 'code'|'named'|'symbol'}
export function matches(str, event) → boolean
export function normalize(event) → string[]        // candidate KeyStrings for lookup (code form and symbol form)
export function label(str, {platform}) → string    // '⌘K', 'Ctrl+K', '⇧Space', '⌥←', '[', '1'
export function aria(str) → string                 // aria-keyshortcuts: 'Meta+K', 'Shift+Space', 'Alt+ArrowLeft'
export function accelerator(str) → string|null     // Electron: 'CmdOrCtrl+N'; null for keys without Mod/Ctrl (D41)
```
**Command definitions.** There is no `classicKeys` field.
```js
register({
  id: 'transport.again',            // /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+)+$/
  title: 'Start again',             // string | (c) => string
  group: 'Transport',               // GROUPS: Transport, Loop, Speed, Click, Mix, Navigate, View, Practice, Edit, Map, Chart, Library, App
  keys: ['Enter'],                  // KeyStrings; keys[0] is shown in hints and menus
  scopes: ['stage', 'edit.chart'],  // where the keys bind (palette and menus ignore scopes and use `when`)
  when: c => !!c.session,           // enabled predicate; false hides it from the palette and disables menu items and buttons
  run: (c, args) => c.transport.again(),
  checked: undefined,               // (c) => boolean for toggles (aria-pressed, menu checkbox/radio)
  repeat: false,                    // true → auto-repeat keydowns re-run (steps, nudges)
  pedal: true,                      // eligible for pedal/MIDI binding
  global: false,                    // may run from background shortcuts while unfocused
  icon: 'rotate-ccw',
  menu: {label: 'Start again (with count-in)', electron: 'Transport', radio: undefined},   // electron: 'File'|'Edit'|'View'|'Transport'|'Help'
  palette: {keywords: ['repeat', 'restart', 'from the top'], hidden: false},
});

// commands.js
export function register(def) / registerMany(defs) / unregister(id)
export function get(id) → def; export function all() → def[]
export function provide(name, getter) → off          // context providers: 'session','transport','stage','edit','map','chart','library',…
export function context(extra) → Ctx                 // {place, posture, route, session, transport, stage, edit, map, chart, library, store, router, feedback, platform, source, event, args}
export function run(id, {source = 'pointer', args, event} = {}) → boolean   // false when unknown or `when` fails
export function isEnabled(id) → boolean; export function isChecked(id) → boolean|undefined
export function bindingsFor(scope) → Map<KeyString, def>
export function onChange(fn) → off                   // registry or enablement changes (menus, ? sheet, buttons)
export function invalidate()                         // re-evaluate when/checked (called on transport/route/prefs changes, debounced 50 ms)
```
**Dispatcher.**
```js
export function startDispatcher() → stop                      // window capture keydown + keyup
export function pushOverlay({el, modal, onEscape, scope}) → pop // overlay stack (Dialog, Sheet, Popover, Menu, Palette push themselves)
export function setSurfaceScope(name|null)                     // 'stage.stems' while the Stems surface is shown (D24)
export function activeScopeChain() → string[]                  // for the ? sheet and tests
export function setPedalHandler({owns(e) → boolean, down(e), up(e)} | null)   // installed by pedals.startPedals (PD1)
// DOM declarations read by the dispatcher:
//   data-scope="edit.chart.score"   focus scope while document.activeElement is inside
//   data-consume-keys="ArrowLeft ArrowRight ArrowUp ArrowDown Home End PageUp PageDown"   (sliders, steppers, faders, radiogroups, tablists, menus, grids)
//   data-text-input                  custom text widgets (native input/textarea/select/[contenteditable] are detected)
```
Keydown algorithm, in order. The first rule that applies ends processing.
1. Ignore when `defaultPrevented`, `isComposing`, `key === 'Dead'`, or a plain Tab.
2. **Pedals:** if a pedal handler is installed and `handler.owns(e)` (pedal mode on and `e.code` learned), `handler.down(e)` takes the event; the matching keyup goes to `handler.up(e)`.
3. **Modal overlay open:** run only bindings registered in that overlay's `scope`, plus `Escape → onEscape()`. Everything else is left to the overlay's own elements.
4. **Text input focused:** only `Escape` (blur, or close the overlay) and `Mod+KeyK` pass. Everything else is native.
5. The focused element or an ancestor has `data-consume-keys` that includes the base key, and no modifiers other than Shift are down → native.
6. **Enter on a keyboard-focused interactive element** (button, a[href], summary, `[role=button|menuitem|menuitemcheckbox|menuitemradio|option|tab|checkbox|switch]`) → native (D35). **Space on one** → native outside the `stage`/`edit` postures; inside them it continues to the registry, which calls `preventDefault()` so the button does not activate.
7. **Escape with a non-modal overlay open** closes the topmost one.
8. **Scope chain:** focus scopes (innermost `data-scope` first) → surface scope (`setSurfaceScope`) → posture scopes (`edit.map`/`edit.chart`/`edit.details`, then `edit`; or `stage`) → place scope (`library`, `settings` or `admin`) → `global`. For each scope, look up every `normalize(e)` candidate. The first def whose `when` passes → `preventDefault()`. If `e.repeat && !def.repeat`, do nothing more; otherwise `run(def.id, {source: 'key', event: e})`.
9. **Browser and OS reservations (spec §7.4):** no def may bind `Mod+KeyN`, `Mod+KeyW`, `Mod+KeyT`, `Mod+Comma`, `Mod+Digit1…9`, `Mod+=`, `Mod+-` or `Mod+Digit0`. A registry test enforces it. In Electron, `library.add` (⌘N), `stage.close` (⌘W) and `nav.settings` (⌘,) arrive only through the menu.

### 2.7 `src/app/pedals.js` and `midi.js`
```js
export function createClassifier({holdMs = 600, doubleMs = 350, slotFor, actionFor, fire}) → {down(e), up(e), reset()}
//   slotFor(e) → 'left'|'right'|'p3'|'p4'|null      actionFor(slot, gesture) → commandId|null     fire(commandId, {slot, gesture})
// Rules:
//   keydown, not repeat:
//     if actionFor(slot,'hold') == null && actionFor(slot,'double') == null → fire(tap) now (keydown latency; Play/Stop rule)
//     else start a hold timer (holdMs).
//   keydown repeat (auto-repeat) → fire(hold) once, mark the press consumed.
//   hold timer elapses → fire(hold), mark consumed.
//   keyup, not consumed:
//     if the pedal is not hold-capable (canHold false) and actionFor(slot,'double') exists:
//       wait doubleMs; a second keyup inside the window → fire(double); otherwise fire(tap)
//     else fire(tap).
// Hold-capable pedals use 'hold'. Non-hold pedals use 'double' as the hold action (spec §7.5): actionFor(slot,'double') = profile[slot].hold.
export const PROFILES = {
  practice: {left: {tap: 'transport.again',  hold: 'nav.prevSection'}, right: {tap: 'transport.playStop', hold: 'nav.nextSection'}, p3: {tap: 'transport.loopToggle'}, p4: {tap: 'mix.minusMe'}},
  navigate: {left: {tap: 'nav.prevSection',  hold: 'transport.loopToggle'}, right: {tap: 'nav.nextSection', hold: 'transport.playStop'}, p3: {tap: 'transport.loopToggle'}, p4: {tap: 'mix.minusMe'}},
  pageturn: {left: {tap: 'stage.scrollUp',   hold: 'stage.scrollTop'}, right: {tap: 'stage.scrollDown'}},
  // custom: prefs.pedals.custom = {[slot]: {tap, hold}}; only commands with pedal:true
};
// With ?set= (B3) in the practice profile, right.hold = 'setlist.next'.
export function startPedals() → stop        // reads prefs.pedals; installs dispatch.setPedalHandler; the HUD shows ⎍ while prefs.pedals.enabled
export function learn({onPrompt, signal}) → Promise<{pedals: [{slot, code, canHold}]}>
//   onPrompt('Press the left pedal…' | 'Hold it for a second…' | 'Press the right pedal…' | 'Third pedal (or Done)…')
//   canHold = an auto-repeat keydown, or a keyup ≥ 600 ms after keydown, was observed during "Hold it for a second…"
// midi.js
export function startMidi() → stop          // navigator.requestMIDIAccess({sysex:false}); note-on vel>0 or CC ≥ 64 → fire(command); bindings from prefs.midi
export function learnMidi({signal}) → Promise<{device, type, number}>
```
Without pedal mode, PageUp and PageDown are ordinary registry keys (`nav.prevSection`, `nav.nextSection`), so page-turner pedals work with no setup.

### 2.8 `src/app/palette.js`, `shortcuts-sheet.js`
```js
export function openPalette({query = ''} = {}) → {close}       // modal overlay; band layout → full-width top sheet
export function registerProvider({id, group: 'song'|'commands'|'songs'|'navigation', search(query, ctx) → Item[]}) → off
Item = {id, title, subtitle?, group, keys?: KeyString, icon?, run(ctx, {mod: boolean}) }   // mod = ⌘Enter
```
**Query parsing (built-in providers):**
- `bar 57`, `b57`, `57` → "Go to bar 57" when mapped, else "Go to 0:57". `1:12` → time.
- `75` or `75%` → "Speed 75%".
- `loop 41-48` → loop bars 41–48 (or seconds when unmapped).
- `count 2 bars`, `count 2 beats`; `trainer 70 100` (optionally a third number for the step).
- `only <stem>`, `minus`, `mute <stem>`.
- Section names, spot names and marker labels: Enter cues there; ⌘Enter loops it.
- Song titles (prefix > word-start > fuzzy): Enter opens the Stage; ⌘Enter opens Details.
- A bare number < 400 offers both "Speed N%" and "Go to bar N"; the bar comes first when mapped.

**Ranking:** scope group order (In this song, Commands, Songs, Navigation), then frecency `score = n × 0.5^(ageDays / 14)`.
```js
export function openShortcuts() → {close}      // groups by command group; the active scope chain's bindings first; labels via keys.label
```

### 2.9 `src/app/feedback.js`
```js
export function toast(message, {tone = 'info', action, durationMs, key} = {}) → {dismiss(), update(message)}
//   tone 'info'|'ok' auto-dismiss at 5000 ms; 'error' persists; action {label, run}; key replaces an existing toast with the same key
//   One toast visible; FIFO queue. While store.stage.playing is true, new toasts queue and nothing shows. They release on stop.
export function status(text, {action, durationMs = 2500, key} = {}) → void
//   Stage status line (role=status). Outside the Stage it falls back to toast().
export function confirm({title, body, confirmLabel, cancelLabel = 'Cancel', danger = false}) → Promise<boolean>
export function form({title, body, fields: FieldSpec[], submitLabel, danger = false}) → Promise<Record<string,string>|null>
//   FieldSpec {name, label, kind: 'text'|'textarea', required, minLength, maxLength, value}; async submit errors render inline
export function announce(text, {politeness = 'polite', throttleMs = 2000, key} = {}) → void
```

### 2.10 `src/app/error-copy.js`
```js
export function describeError(input: ApiError | {errorCode, error, retryAt?, attempts?}, {context: 'add'|'job'|'resplit'|'load'|'save'|'share'|'detect'})
  → {sentence: string, primary?: {label, command?: string, run?: () => void}, secondary?: {label, run}, details: string}
```
`details` always holds the raw text, shown in mono behind `Details` with `Copy`. The code → copy table is spec §3.6 exactly, keyed by the codes in §6.1, with these additions:
- `processor_offline` (renderer-side, before any job exists) → "Woodshed's processor isn't running on this computer." [Restart processor].
- `beats_unavailable` → "Bar detection isn't installed on this computer."
- `resplit_wrong_device` → "Re-split this song on {device}, which has the original file."
- `account_export_only` → "Adding songs is paused on this account." [Plan & storage].

### 2.11 `src/app/platform.js` and `desktop.js`
```js
export const platform = {isDesktopApp, isMac, isIPad, coarse: ReadonlySignal<boolean>, hoverFine: ReadonlySignal<boolean>,
                         reducedMotion: ReadonlySignal<boolean>, standalone: boolean, online: ReadonlySignal<boolean>};
export function createWakeLock() → {held: ReadonlySignal<boolean>, supported: boolean, update({stageOpen, playing, stoppedAt}), release()}
//   Policy: hold while stageOpen && (playing || now - stoppedAt < account.practice.wake min, or wake === 'always').
//   Re-acquire on visibilitychange → visible. Desktop: desktop.setActivity({keepAwake}) → powerSaveBlocker('prevent-display-sleep').
export function watchInterruptions({engine, transport}) → off
//   engine 'interrupted' event, or (iOS/iPadOS) visibilitychange → hidden while playing → transport.interrupt('audio')
export function startMediaSession({transport, session}) → off      // D13: play/pause → transport.playStop; previoustrack → transport.again; nexttrack → nav.nextSection
export const install = {state: ReadonlySignal<{canPrompt, installed, steps: 'ios'|'chromium'|'none'}>, prompt()}

// desktop.js: every method is a no-op when the bridge is absent
export const desktop = {
  available: boolean,
  info() → Promise<{version, platform, companion, update, processor}>,
  setTheme(t), mediaUrl(url),
  update(action: 'show'), onUpdate(cb) → off,                       // → store.update
  processor: ReadonlySignal<ProcessorStatus>, restartProcessor() → Promise, retryPairing() → Promise,
  setActivity({playing, songOpen, keepAwake}),                      // update prompts defer while playing; ⌘W enablement; wake
  notify({title, body, route}) → Promise<boolean>,
  setBackgroundShortcuts(on) → Promise<{registered: string[], failed: string[], accessibility?: 'granted'|'needed'}>,
  registerMenu(spec), onCommand(cb) → off, onNavigate(cb) → off, onFlushRequest(cb: () => Promise) → off, onFullScreen(cb) → off,
};
ProcessorStatus = {
  phase: 'web'|'starting'|'pairing'|'ready'|'busy'|'offline'|'pair-failed',
  name, deviceId, job: {id, stage, percent}|null, firstRun: boolean, message?
}
//   starting: main phase 'starting', or a first job in 'separate' while modelsReady[model] is false (firstRun)
//   ready:    connected && !busy        busy: /status.busy        offline: main phase 'stopped' or /status failing
//   pair-failed: initializeLocalDesktop threw (Try again → retryPairing)
//   /status is polled every 5 s only while the Jobs popover or Settings → Processing is visible; processor-state events otherwise
```

### 2.12 `src/ui` primitives
**Factory shape:** `const p = Prim(props)` returns `{el, set(partial), destroy()}`.
- `set` merges props and patches only what changed.
- `destroy` removes listeners, registry and overlay subscriptions, and removes `el` from the DOM.
- Common props for all primitives: `className`, `id`, `attrs`, `dataset`, `testid` (`data-testid`).
- Classes are `ui-<name>`; variants use `data-variant`, `data-size` and `data-tone`.
- Icon-only controls must have `label`; the factory throws in dev without one.
- `h.js`:
  ```js
  export function h(tag, props = {}, ...children) → Element   // props: class, style (object), dataset, on (map of events), attrs, ref(fn), text
  export function text(s) → Text
  export function reconcileList(container, items, {key: item => string, create: item => {el, update(item)}, before?}) → void
  //   keyed; moves nodes rather than rebuilding; never recreates the node holding focus
  ```

| Primitive | Props (beyond the common ones) | Behaviour |
|---|---|---|
| `Button` | `label`, `icon`, `iconEnd`, `variant: primary\|secondary\|quiet\|danger`, `size: sm\|md\|lg\|dock\|play`, `command`, `onClick(e)`, `onLongPress(e)`, `longPressMs=500`, `disabled`, `disabledReason`, `busy: boolean\|string\|{label, percent}`, `pressed`, `kbd`, `title`, `sublabel`, `type` | With `command`: label, icon and `title` default from the registry; `aria-keyshortcuts` and the tooltip key-cap come from `keys[0]`; click runs the command with `source: 'pointer'`; `disabled` and `aria-pressed` track `when`/`checked` through `onChange`. `disabledReason` renders as visible text linked with `aria-describedby`. `busy` replaces `withButtonProgress`. Dock sizes render the icon above a 13/600 label. |
| `IconButton` | `label` (required), `icon`, `variant`, `size`, `command`, `onClick`, `pressed` | `aria-label` plus a tooltip with the key-cap. |
| `Toggle` | `label`, `pressed`, `onChange(pressed)`, `command`, `sublabel`, `icon`, `size` | `aria-pressed`; the label names the feature, never the state. |
| `HoldButton` | `label`, `icon`, `holdMs=600`, `requireHold: () => boolean`, `onActivate`, `onTapWhileHold(e)` | When `requireHold()` is true, a press must last `holdMs`, with a ring filling; a short tap calls `onTapWhileHold` (the hint). Keyboard Enter/Space activates at once only when `requireHold()` is false. |
| `Segmented` | `options: [{value, label, icon?, disabled?, reason?}]`, `value`, `onChange`, `label`, `size` | `role=radiogroup`, roving tabindex, consumes arrows. |
| `Chip` / `ChipGroup` | Chip: `label`, `pressed`, `removable`, `onRemove`, `onClick`, `tone`, `icon`. ChipGroup: `options`, `value`, `multiple=false`, `clearable=true`, `onChange`, `label`, `primary?` | Single-select with tap-again-to-clear when `clearable`. `primary` badges one chip (Instruments). |
| `Stepper` | `value`, `min`, `max`, `step`, `bigStep`, `format(v)`, `onChange(v, {source})`, `onValueClick`, `onValueLongPress`, `label`, `decLabel`, `incLabel`, `holdRepeat=true`, `size` | `role=spinbutton`; consumes arrows, PageUp/PageDown, Home/End; hold to repeat (400 ms delay, then 80 ms). |
| `Slider` | `value`, `min`, `max`, `step`, `format`, `onInput`, `onChange`, `label`, `showValue=true`, `orientation` | A custom `role=slider` element, not `input[type=range]`. Consumes arrows and Home/End only. Pointer capture. |
| `Fader` | Slider props plus `resetValue=1`, `variant: inline\|pad` | Double-click or double-tap resets. In pad mode a vertical drag inside the host element changes the level (StemPad). |
| `TextField` | `label`, `value`, `hint`, `error`, `placeholder`, `maxLength`, `pattern`, `inputmode`, `autocomplete`, `onInput`, `onCommit(value)` (blur or Enter), `status: null\|'saving'\|'saved'\|{error}`, `size` | Inline status after the field ("Saved" fades after 2 s). |
| `Select` | `label`, `options`, `value`, `onChange`, `hint` | Native `<select>`, styled. |
| `Textarea` | `label`, `value`, `rows`, `maxLength`, `debounceMs`, `onInput`, `onCommit`, `status` | `onCommit` runs on debounce idle, blur and `flush()`. |
| `ChipInput` | `label`, `values`, `maxItems=30`, `maxLength=60`, `caseInsensitive=true`, `onChange(values)` | Commit on Enter, comma or blur; Backspace on empty removes the last chip; each chip has ✕ with an aria-label. |
| `Menu` | `items: MenuItem[]`, `anchor: Element\|{x, y}`, `placement`, `onClose`, `label`; static `Menu.open(items, opts) → handle`; `bindContextMenu(el, getItems)` (right-click, 500 ms long-press, Shift+F10, ContextMenu key) | `MenuItem = {id?, label, kbd?, command?, icon?, type: 'item'\|'checkbox'\|'radio'\|'separator'\|'submenu', checked?, items?, disabled?, reason?, danger?, run?}`. `role=menu`, roving focus, type-ahead, Esc. On coarse pointers it renders as a bottom sheet with 56 px rows. Opening a Dialog closes open menus. A `command` item takes its label, key-cap, enabled and checked state from the registry. |
| `Popover` | `anchor`, `content`, `placement: 'left'\|'right'\|'top'\|'bottom'\|'auto'`, `width`, `modal=false`, `labelledBy`, `onClose` | Popover API (`popover=manual`) with `position.js` placement; closes on outside click and Esc; grows from the anchor (160 ms). |
| `Sheet` | `title`, `content`, `layout: 'auto'\|'bottom'\|'popover'`, `anchor`, `detents=[40,60,90]`, `initialDetent=60`, `modal=false`, `grabber=true`, `onClose` | `auto`: a bottom sheet in band layout, a popover anchored left of `anchor` in rail layout (360 px). Swipe-down dismisses past 25% of the height or at > 0.5 px/ms. Never pushes history. |
| `Dialog` | `title`, `body`, `actions: [{label, variant, value, autofocus}]`, `danger`, `form?: {fields, onSubmit: async values => void}`, `onClose(value)`, `width=480` | Native `<dialog>.showModal()`; returns focus; async submit keeps it open and shows the error inline. |
| `Toast` | `message`, `tone`, `action`, `onDismiss` | View only; queueing lives in `feedback.js`. Never takes focus. |
| `InlineStatus` | `tone: info\|ok\|warn\|error`, `text`, `action?` | `role=status`; errors use `role=alert`. |
| `Banner` | `tone`, `title?`, `text`, `actions`, `dismissible`, `onDismiss` | In flow (never fixed). |
| `ProgressRail` | `value: 0..1\|null`, `striped`, `label` | `null` → shimmer (reduced motion: static 90%). |
| `ProgressRing` | `value`, `size`, `label` | Used by the Play loading ring and HoldButton. |
| `StageStepper` | `stages: [{id, label}]`, `current`, `percent` | `Fetch ✓ — Split ● 46% — Finish — Ready`. |
| `Tabs` | `tabs: [{id, label, href?}]`, `value`, `onChange`, `variant: 'posture'\|'section'` | `role=tablist`, roving. |
| `Kbd` | `keys: KeyString`, `force=false` | Hidden on `(hover:none) and (pointer:coarse)` unless forced; Edit adds `data-kbd-hints` after keyboard use (spec §5.0). |
| `tooltip(el, {text, kbd})` | — | Hover and focus; 400 ms delay; returns `off`. Never the only carrier of information. |
| `EmptyState` | `title`, `body`, `actions` | |
| `Skeleton` | `shape: 'card'\|'row'\|'text'\|'cell'`, `count` | |
| `Readout` | `label` (aria), `value`, `sub`, `size: 'identity'\|'sub'\|'loop'\|'section'\|'speed'\|'position'\|'count'`, `tone: 'ink'\|'ink-3'\|'now'`, `mono`, `minCh` | Sizes come from Stage tokens (§7.2) and scale with Distance; `font-variant-numeric: tabular-nums`; a fixed `min-width` in `ch` stops jitter. |
| `BeatLamps` | `units`, `groups`, `size` | `set({units, groups})` per bar; `frame(unitIndex, groupStart)` per tick (cheap class flip). D15 rules. |
| `StemPad` | `name`, `color` (token name), `state: 'on'\|'out'\|'solo'`, `level`, `keyCap`, `mode: 'mute'\|'solo'`, `size: 'band'\|'rail'`, `onToggle`, `onSolo`, `onLevel` | Out: outline, hatch, struck-through word `OUT`. Solo: accent ring and `SOLO`. The level is a vertical fill dragged inside the pad. |
| `CoachMark` | `anchor`, `title`, `body`, `step: {i, n}`, `onSkip`, `onDone` | Non-blocking, anchored, `--z-coachmark`; never shown while playing. |
| `icon(name, {size = 20})` | — | Returns `<svg class="ui-icon" width height aria-hidden><use href="#i-name"/></svg>`. |

### 2.13 Shell: `topbar.js`, `fatal.js`, `data.js`
```js
mountTopbar(el, {router}) → {setJobsSlot(node), setSearch({value, onInput, onKeydown}), destroy}   // 56/60 px; avatar menu items per spec §2.1
mountJobsChip(slot)  // provided by src/library/jobs.js; wired by integration I1
renderFatal(el, {title, message, details}) / renderPaused(el, {status, reason})
startData() → stop   // subscriptions into store.library; the songs map updates by id; library.loaded flips after the first songs.list
```

### 2.14 `src/stage`

#### 2.14.1 `session.js`
```js
export async function getSession(songId, {shared} = {}) → Session      // cached by id; Stage and Edit share it
export async function disposeSession(songId) → void                     // flush, then engine.destroy(), metronome.destroy(), notation.destroy()
Session = {
  id, readOnly: boolean, shareToken: string|null,
  song: ReadonlySignal<SongFull>,              // songs.get subscription (owner), or the shared snapshot
  engine: MultitrackEngine, metronome: Metronome, map: SongMapStore,
  transport: Transport, position: PositionModel, practice: PracticeState, undo: PracticeUndo,
  notation: NotationSession, peaks: PeaksCache, frame: FrameBus,
  load: ReadonlySignal<LoadState>,
  retry() → Promise<void>, flush() → Promise<void>,
  on(event: 'tempo-adopted'|'loaded'|'error', fn) → off,
}
LoadState = {phase: 'song'|'signing'|'loading'|'decoding'|'preparing'|'ready'|'error',
             loadedBytes, totalBytes, decoded, tracks,
             error: null|{kind: 'storage'|'missing'|'codec'|'unknown', message, missing?: string[]}}
```
Open order (spec §4.12: the song is interactive before decode):
1. Read the song: `songs.get` (owner) or the snapshot.
2. Build `map = SongMapStore.fromTempo(song.tempo, song.duration)` immediately.
3. Build the practice state from `song.practice` (`upgradePractice`).
4. Build the transport with an engine that has not loaded yet. Transport operations made before `ready` apply when the engine is ready.
5. Start `notation.open()` when `song.hasChart`, or when the stored tempo has no `songMap` (legacy timeline adoption; `maps/notation.md` §3.3). Adoption runs before the part opens.
6. Sign URLs and run `engine.loadStems` with progress into `load`. Then `map.setDuration(engine.duration)` and `peaks = createPeaks(engine.tracks)`.
7. Apply the practice state to the engine: loop, rate, keep-pitch, mix, cue.
8. `load.phase = 'ready'`.

**Tempo persistence:** `api.songs.saveTempo({id, tempo: metronome.serialize(), baseRev})`, debounced 400 ms. It is suspended while `mapSession.auditioning`, and flushed by `flush()`. The response `{tempoRev, conflict, tempo}` updates `baseRev`. On `conflict`, the session adopts the returned tempo.

**B6 adoption:** when `song.tempoRev` rises from outside, and the local map has no unsaved edits, and the new map is real while the local one is not, the session replaces the map as one practice-undo step and calls `status('Bars found', {action: {label: 'Undo'}})`. If the local map is not dirty in any other case, the session adopts silently with no undo step.

**`flush()`** runs the practice save, the tempo save and `notation.flush()`. It is called by: `onLeave`, `pagehide`/`visibilitychange → hidden`, the share dialog, `desktop.onFlushRequest`, and `disposeSession`.

#### 2.14.2 `notation-session.js`
```js
createNotationSession({session}) → {
  ready: Promise<void>, part: Part|null,        // notation/part.js openPart(); null for songs with no chart and no adoption
  hasNotation: ReadonlySignal<boolean>, readOnly,
  drumAudio: DrumAudio,                         // one per session (notation/audio.js)
  setChartAudio('off'|'quiet'|'loud'),          // off → setMode('recording'); quiet → 'both' + gain .35; loud → 'both' + gain .65
  setListenMode('recording'|'notation'|'both'), // Edit · Chart Listen tab; does not change practice.chartAudio
  setMapSyncPaused(bool),                       // Find a chart audition (D20)
  importScore(score, {notice}) → Promise<{count, skipped}>,
  open() → Promise<void>, flush() → Promise<void>, destroy(),
}
```
`part.js` gains `setMapSyncPaused(bool)`: while paused, `syncMap` keeps retiming in memory but never calls `commit('map')`. Unpausing commits once if the timeline changed. `audio.js` gains `setLevel(gain)` and no longer resets audibility in `destroy` while the session lives.

#### 2.14.3 `transport.js`
```js
export function createTransport({engine, metronome, map, position, practice, undo}) → Transport
Transport = {
  snapshot: ReadonlySignal<TransportState>,   // discrete changes only
  position() → number,                        // media seconds: engine.getPosition() when playing or counting (target during a silent count), else the cue
  // play / stop
  playStop(), play(), stop(), pause(), again(), playFrom(t),
  // cue, seeking, navigation
  cue(t, {snap = 'none'}), seek(t), step(kind: 'bar'|'beat', dir), nudgeCue(ms), home(), end(),
  jump(t, {label}), cancelJump(), goToRegion(dir),           // dir ±1 = previous/next section or marker
  // loop
  toggleLoop(), loopSection(), loopRange(a, b, {label, snap = 'bar'}), loopBars(t, n), loopIn({exact}), loopOut({exact}),
  moveLoop(dir), extendLoopTo(t), nudgeLoopEdge(edge: 'a'|'b', dir, unit: 'bar'|'beat'|'tenth'|'50ms'|'10ms'), clearLoop(),
  setLoopOptions({eachPassCount, playTimes, between}),
  // speed
  setSpeed(rate, {coalesce = true}), nudgeSpeed(pct), toggleSpeed100(), setKeepPitch(on), startTrainer(cfg?), stopTrainer(),
  // click
  setCountIn({on, length, unit}), setClickMode('off'|'countin'|'always'), setAccent(on), setClickVolume(v), setPreRoll(on),
  // mix
  setMuted(name, on), setSoloed(name, on), setVolume(name, v, {coalesce = true}), toggleMuteAt(i), toggleSoloAt(i),
  minusMe(on?), onlyMe(on?), fullMix(), setChartAudio(level),
  // misc
  interrupt(reason), armPlayWhenReady(), on(event, fn) → off, destroy(),
}
// events: 'pass' {pass}, 'trainer' {stepIndex, rate, done}, 'jumped' {t}, 'ended' {reason}, 'interrupted' {reason}, 'count' {current, of, label}
TransportState = {
  phase: 'loading'|'stopped'|'counting'|'playing'|'paused', armed: boolean,
  cue, rate, lastRate, keepPitch, minRate,                    // minRate 0.25, or 0.5 in safe mode
  loop: {on, a, b, aBar, bBar, eachPassCount, playTimes, between, label},   // label 'Chorus' | 'Bars 13–20' | '0:31.2–0:41.0'
  pass, passTarget: number|null,
  countIn: {on, length, unit}, click: {mode, accent, volume, preRoll},
  countdown: {current, of, label}|null,                        // count-in plate: 'Count-in · bar 13' | 'Lead-in · 0:31'
  mix: {tracks: [{name, volume, muted, soloed}], minusMe, onlyMe, mine: string[], chartAudio},
  trainer: {start, end, step, passes, stepIndex, steps, passInStep, rate, done}|null,
  pendingJump: {t, when, label}|null,
}
```
**Semantics (binding):**
1. **Cue model:** `cue` is where Play starts and Stop returns. Setting a loop (any way) sets `cue = loop.a`. Clearing the loop leaves the cue where it is. `engine.editPosition` stays as the engine's storage field.
2. **`play()`:** from `stopped`, the start is `loop.on ? loop.a : cue`. From `paused`, playback continues in place (no count-in); if the loop is on and the position is outside `[a, b)`, it continues from `a`. Count-in applies when `countIn.on` and playback is not a continue:
   - mapped → `metronome.countInPlan()` at the start;
   - unmapped → **Lead-in 2 s** = `engine.play({countIn: {duration: 2, beats: []}, audiblePreRoll: true})`, with no clicks.
   - While the engine is not ready, Play arms "Play when ready" (`armed`) and starts on load.
   - On unmapped songs the Click and count-in clicks never sound; the Click control shows "Needs a bar grid".
3. **`playStop()`:** `counting` or `playing` → `stop()`; otherwise → `play()`. Space during a count-in cancels it (stop).
4. **`stop()`:** `engine.stop({returnToEdit: account.practice.stop === 'cue'})`. With `stay`, the cue moves to the stop position (today's semantics). Then `practice.markStopped()` flushes the save, and `stage.js` writes `?bar=`/`?t=` with replace on the transition to `stopped`.
5. **`pause()`:** playing → `engine.pause()` (the cue does not move); paused → `play()` (continue).
6. **`again()`:** `target = loop.on ? loop.a : position.againTarget(pos) ?? cue`, where `pos = position()` and `againTarget` is the start of the current section or marker region. It plays from `target` with count-in when `countIn.on`, from any phase (counting restarts the count). Count-in off and playing → `engine.seek(target)` in place.
7. **Passes:** a pass is a traversal from `a` to `b` with no seek, stop, manual speed change, loop edit or jump in between. Any of those sets `pass = 0` and `eligible = position <= a + 0.05`. On each engine `wrap`: if eligible, `pass++` and emit `pass`; then `eligible = true`.
8. **Play N times** (`playTimes` 2|4|8): after the wrap that makes `pass === N − 1`, call `engine.stopAt(engine.nextWrapAt())`. Its `ended {reason: 'stopAt'}` → `stop()` (back to the cue, which is `a`), and `status('Played {N} times')`.
9. **Count in every pass:** it is active when `loop.on && loop.eachPassCount && countIn.on`. Then `gapSec` = the count-in plan duration at `a` (mapped), or 2 s with an audible lead-in (unmapped). `between === 'rest'` adds one bar at `a` (mapped) or 2 s (unmapped), silent apart from clicks. The engine gets `setLoop(true, a, b, {gapSec, gap: unmapped ? 'preroll' : 'silent'})`. With safe mode on, `gapSec` is always 0.
10. **Call & response** (`between === 'call'`): gapless. After each wrap the transport calls `engine.setTrackGains(mineMuted ? {} : muteMine, {at: engine.nextWrapAt()})`, alternating. Odd passes (1, 3, …) are "listen" passes and even passes are "play" passes. The HUD Loop line adds `· listen` or `· you play`. Stopping restores gains to 1.
11. **Trainer:**
    - `cfg = {start, end, step, passes}`, defaulting to practice.trainer, else `{0.7, 1.0, 0.05, 2}`.
    - Target = the loop if on; otherwise the current section (D28: the loop is set as one undo step); otherwise the whole song.
    - Rates = `start, start+step, …` up to and including `end` (the last value is clamped). The first rate applies at once.
    - After the wrap that makes `passInStep === passes − 1`, schedule `engine.setSpeed(nextRate, {at: engine.nextWrapAt()})` (in safe mode: an immediate `setSpeed` on the next wrap). When `passes === 1`, scheduling happens right after each step starts.
    - After the last step: `done = true`, `status('Trainer done — 100%')` (or the end rate), and looping continues at the end rate.
    - Manual speed changes, loop edits and jumps stop the trainer ("Trainer stopped"). Stop keeps the trainer, and Play resumes at the current step with `passInStep = 0`.
12. **Quantized jump** `jump(t)`:
    - Stopped → `cue(t)`.
    - Playing and unmapped → `seek(t)` at once.
    - Playing and mapped:
      - `nd = map.downbeatAfter(position())`;
      - if the loop is on and `engine.nextWrapAt()` comes before `engine.whenAt(nd.time)`, the jump happens at the wrap;
      - `when = engine.whenAt(nd.time)`; if `when − ctx.currentTime < engine.lookahead + 0.03`, use the following downbeat;
      - `engine.seekAt(t, when)`; `pendingJump = {t, when, label}`.
      - If `t` is outside an active loop, the loop is cleared in the same undo step (D29).
      - `cancelJump()` → `engine.cancelPending()`.
13. **Smart loop toggle** `toggleLoop()`:
    - if a loop range exists (`b > a`), toggle `on`;
    - otherwise, mapped with sections → the current section; mapped → the current 4-bar phrase (`map.phraseAt`); unmapped → `[t − 5, t + 5]`, clamped (t = position).
    - `loopSection()` (⇧L) always uses the current section, or the marker region when unmapped, and falls back to the phrase or ±5 s.
14. **I / O:** loop in/out at the position (playing) or the cue (stopped), snapped to the nearest bar line (mapped) unless `exact`. If the other edge becomes invalid, it is set 1 bar (mapped) or 4 s (unmapped) away. The loop turns on.
15. **Move by length:** `moveLoop(±1)` shifts by `b − a`, clamped to `[0, duration]`, and recomputes the bar refs.
16. **Edge nudges** (Loop card): by bar, or by beat with Alt (mapped); by 0.1 s, 50 ms with Alt, or 10 ms with Alt+Shift (unmapped). The engine's 20 ms minimum length applies.
17. **Speed:** clamped to `[minRate, 1.5]` and rounded to 0.01. `` ` `` toggles between 1.0 and `lastRate`, the last rate ≠ 1.0. `nudgeSpeed(±5|±1)`. Changes within 1 s coalesce into one undo step.
18. **Mix:**
    - `toggleMuteAt(i)` and `toggleSoloAt(i)` use canonical stem order: drums, bass, guitar, piano, vocals, other, then two-part focus and `no_*` (not row order).
    - `minusMe()`: `mine = profile.myStems(account.profile, stems)`. If it is empty, open the Mix sheet and return false. Otherwise mute `mine`. When an instrument fell back to `other`, `status('This song wasn't split with a {instrument} part. Muting Other instead.', {action: Re-split with 6 stems (desktop)})`.
    - `onlyMe()` solos `mine`. `fullMix()` sets volume 1, clears mute and solo, and clears `minusMe`/`onlyMe` (one undo step).
    - Open with "my part Out": when `account.profile.openWithMyPart === 'out'` and the song has no saved practice, the session starts with `minusMe(true)` (not an undo step).
19. **Undo:** every mutation goes through `practice.patch` with an `undo.push({key, label, from, to})`. Keys: `speed`, `level:<stem>` coalesce; `loop`, `mix`, `markers`, `spots`, `section`, `startOver` do not.
20. **`interrupt(reason)`:** `engine.pause()`, `cue = position`, `status('Paused — audio was interrupted. Press Play to continue.')`. It never auto-resumes.

#### 2.14.4 `position.js`
```js
createPositionModel({map, practice}) → {
  mapped: ReadonlySignal<boolean>,                               // map.isReal
  label(t) → {main: '13 · 2'|'Pickup · 3'|'1:12', sub: '0:26 / 1:04'|null},
  regions() → Region[],        // mapped: map.sections; unmapped: live markers sorted → [{id, label, t0, t1, kind: 'marker'}]
  regionAt(t) → Region|null,
  next(t) → {region, text, imminent: boolean}|null,              // D16; text per §4.4
  againTarget(t) → number|null,                                  // regionAt(t)?.t0
  stepTarget(t, kind: 'bar'|'beat', dir) → number,               // mapped: bar/beat line; unmapped: ±5 s / ±1 s
  snap(t, unit: 'bar'|'beat'|'tenth') → number,
  loopDefault(t) → {a, b, label},
  ref(t) → BarRef|null, resolve(ref) → number|null,              // map.refAt / map.timeOfRef
  rangeLabel(a, b) → string,   // 'Bars 13–20 · Chorus (8 bars)' | '0:31.2–0:41.0 (9.8 s)'
}
```
**Test (required):** for an unmapped song, no string produced by `position.js`, `hud.js`, `strip.js` or the surfaces contains "Bar" or "bar ".

#### 2.14.5 `practice-state.js` (client side of `shared/practice.ts`)
```js
createPracticeState({songId, raw, duration, readOnly, persist: p => Promise, server: ReadonlySignal<raw>, local?: {token}}) → {
  value: ReadonlySignal<PracticeV2>,
  patch(partial | (draft) => void, {dirty: string[]}) → void,   // dirty = top-level scalar keys this device changed
  addSpot(s) → id, updateSpot(id, patch), deleteSpot(id), touchSpot(id, {passes}),   // ids: crypto.randomUUID()
  addMarker({t, label}) → id, renameMarker(id, label), deleteMarker(id),
  reanchor(map),                 // after a map change: loop and spots with aBar/bBar re-resolve a/b (unless map.auditioning)
  markPlayed(),                  // sets lastAt once per session (the first Play)
  markStopped(),                 // flush now
  flush() → Promise<void>, dispose(),
}
```
**Rules:**
- **Save cadence:** 600 ms debounce; flushed by `markStopped`, unmount, `pagehide`, `visibilitychange → hidden`, share and desktop flush.
- **Before each save:** `next = prunePractice(mergePractice(local, server.value, dirtyKeys), PRACTICE_CAP)`. When pruning dropped anything, `status('Some old markers were removed to make room.')`.
- **Read-only (shared):** `persist` writes to `deviceStore('share').set(token, p)` instead of Convex.
- **Errors:** `practice_too_large` cannot happen after pruning. Any other error retries once after 5 s, then keeps the change locally until the next save.

#### 2.14.6 `undo.js`
```js
createPracticeUndo({limit = 50, coalesceMs = 1000}) → {
  push({key, label, describe: (from, to) => string, from, to, apply(value)}),
  undo() → entry|null, redo() → entry|null, canUndo: ReadonlySignal<boolean>, canRedo: ReadonlySignal<boolean>, clear(),
}
```
An entry with the same `key` within `coalesceMs` of the previous one merges into it (keeping the first `from`). `stage.js` shows "Undid: {describe(from, to)} [Redo]": as a toast when stopped, in the status line when playing. Example: `describe` for speed → `speed 85% → 100%`.

#### 2.14.7 `frame.js`
```js
createFrameBus({session}) → {
  subscribe(fn: (f: Frame) => void, {hz = 60} = {}) → off,
  start(), stop(),
}
Frame = {now: ctxTime, position, playing, counting, bar: BarBeat|null /* map.barBeatAt(position) when mapped */}
```
One `requestAnimationFrame` loop per mounted posture. Text subscribers pass `hz: 30` and are throttled. The bus stops while `document.hidden`; the engine's own 25 ms ticker keeps wraps and end detection running (§5).

#### 2.14.8 `glass.js` (pure)
```js
pressPolicy({pointerType: 'mouse'|'touch'|'pen', playing: boolean, gesture: 'tap'|'double'|'long'|'context'|'drag'|'wheel'|'pinch'})
  → 'cue'|'seek'|'pill'|'playFrom'|'jump'|'menu'|'loopDrag'|'scroll'|'zoom'|'none'
```

| gesture | stopped (any pointer) | playing, touch/pen | playing, mouse |
|---|---|---|---|
| tap | `cue` (nearest beat when mapped) | `pill` ("▶ Play from bar 23", 3 s; tapping it → `jump`) | `seek` |
| double | `playFrom` | `jump` (immediate) | `jump` |
| long / context | `menu` | `menu` | `menu` |
| drag | mouse: `loopDrag`; touch: `scroll` (long-press-then-drag → `loopDrag`) | `scroll` | `loopDrag` |
| wheel | `scroll` (Follow pauses) | `scroll` | `scroll` |
| pinch | `zoom` | `zoom` | `none` |

#### 2.14.9 `layout.js`
```js
export function stageLayout({vw, vh}) → 'rail'|'band'      // (vw / vh >= 1.15 && vw >= 1000) ? 'rail' : 'band'
export function railWidth({distance, vw}) → number          // near 232, stand 264, kit 312; −32 when vw < 1280
export const DISTANCE = {near: .8, stand: 1, kit: 1.3}
export function chartScale({distance, layout, orientation}) → number   // rail: 1.1/1.3/1.6; band (iPad portrait): 1.0/1.2/1.5
export function applyStageAttributes(root, {layout, distance, focus, playing})   // data-stage-layout, data-distance, data-focus, data-playing
```
A layout switch (resize or rotation) is debounced 150 ms. It relayouts once and keeps the playing bar at the same screen fraction (`surface.anchor()` → `surface.reveal()`).

#### 2.14.10 `stage.js`, `hud.js`, `controls.js`, `strip.js`
```js
// stage.js (view)
export async function mount(el, match, ctx) → {update(match), unmount()}
//   query: ?spot=<id> selects the spot (loop+speed+cue); ?bar=N cues bar N (mapped); ?t=83.2 cues the time; ?set=<id> setlist context
//   provides command context 'stage': {layout, surface, setSurface(kind), toggleFocus(), setDistance(d), openSheet(name, {anchor}),
//     closeSheets(), statusLine, leave(), scrollBy(screens), scrollTop(), anchors: Map<'play'|'strip'|'mix'|'getBars', Element>}
export function surfaceDefault(song, notationHasNotation) → 'chart'|'roadmap'   // Chart when a drum part has notation, else Road map
//   Stems is only ever chosen explicitly (V or the ⋯ View menu)

// hud.js
mountHud(el, {session, stage}) → {setLayout(l), setFocus(on), destroy}
//   identity row: ‹ (HoldButton; requireHold = playing), cover 32, h1 title, artist, key/tuning chips, Notes chip, ☼ (wake lock held), ⎍ (pedal mode), `1 ready` chip, ⋯
//   readouts: Section (160 ms crossfade), Next, Position (+ time sub), BeatLamps, Speed (+ bpm), Loop (+ pass/trainer/call), Mix word
//   status line (role=status), count-in plate (overlay at the top of the music)

// controls.js
export const CONTROL_SET = [
  {id: 'again',   command: 'transport.again'},
  {id: 'play',    command: 'transport.playStop', longPress: 'transport.pause'},
  {id: 'loop',    command: 'transport.loopToggle', longPress: 'loop.card'},
  {id: 'speed',   kind: 'stepper', dec: 'speed.down', inc: 'speed.up', value: 'speed.sheet', valueLongPress: 'speed.toggle100'},
  {id: 'countIn', command: 'click.countIn', longPress: 'click.sheet'},
  {id: 'click',   command: 'click.toggle', longPress: 'click.sheet', variants: ['rail', 'slim']},
  {id: 'mix',     command: 'mix.minusMe', caret: 'mix.sheet', longPress: 'mix.sheet'},
  {id: 'pause',   command: 'transport.pause', variants: ['slim']},
];
mountControls(el, {session, variant: 'dock'|'rail'|'mini'|'slim'}) → {destroy}
//   dock: [Again 72][Play 96][Loop 72][− 75% + 184][Count-in 80][Mix 104], 64 tall (Play 80), 12 px gaps
//   rail: 2-column 56 px rows (Play 72), 8 px gaps: [speed][countIn|click][loop|mix][again|play]
//   mini: Speed + Play (Focus mini rail)   slim: ⟲ ▶ ‖, bar.beat + time, loop chip, speed chip, count-in, click, Mix chip
//   While loading, Play shows ProgressRing + 'Loading 62%' / 'Decoding 3 of 4' / 'Preparing pitch-preserving playback'

// strip.js
mountStrip(el, {session, onScrub, viewport?: Signal<{t0, t1}>, onViewport?}) → {destroy}
//   role=slider (aria-valuetext 'Bar 12, beat 3, Chorus' | '1:12'), inside nav[aria-label=Sections]; roving segments: ←/→ move, Enter plays, L loops
//   gestures per spec §4.5 through transport.jump/cue/loopSection and menus.sectionMenu
```

#### 2.14.11 Sheets and menus
```js
// sheets/host.js
openSheet(name: 'speed'|'click'|'mix'|'loop'|'spots'|'notes'|'tapBeat'|'getBars', {session, anchor}) → {close}
closeSheets()
// Band → Sheet (bottom); rail → popover anchored left of the rail control (360 px); notes → non-modal card at the music's top right (320 px).
// One sheet at a time (opening another closes the first). Sheets never pause playback, push history or relayout the music.
// Each sheet module: export function render(container, {session, close}) → {destroy}

// menus.js (MenuItem[] builders)
barMenu(session, {t, bar}) → items       // Play from here · Cue here · Loop this bar · Loop this section · Loop 4 bars from here · Save spot here… · Add marker here
sectionMenu(session, region)             // Play from here · Loop this section · Extend loop to here · Save as spot… · Rename… · Edit sections in Map
spotMenu, markerMenu (Rename · Delete · Turn into section, when mapped), loopBandMenu (Save as spot · Count in every pass ✓ · Move ◀ ▶ · Zoom to loop · Clear), stemMenu (Mute · Solo · Reset level · This is my instrument)
```

#### 2.14.12 Surfaces
```js
Surface = {
  el, kind: 'chart'|'roadmap'|'wave'|'stems',
  frame(f: Frame),                         // playhead, current bar/beat, follow
  setLoop(range: {a, b, aBar?, bBar?}|null), setGlass(playing: boolean), setFollow(on: boolean),
  reveal(t, {smooth = false} = {}),        // put t at the follow line (resume step 4)
  anchor() → {bar?: number, time: number}, // saved as practice.anchorBar/anchorTime
  zoom(dir: 1|-1),                         // = / −: chart size, wave row seconds, or stems zoom
  destroy(),
}
// shared creation options
SurfaceOpts = {session, stage, layout, distance,
  onActivate(e: {kind: 'tap'|'double'|'long'|'context', t, bar?, beatTime?, pointerType, clientX, clientY}),   // stage applies glass.pressPolicy
  onLoopEdit({a, b, aBar?, bBar?, phase: 'preview'|'commit'}),
  onFollowChange(following: boolean),      // shows/hides '⤓ Back to playhead'
  status(text)}
createChartSurface(host, opts) → Surface       // dynamic import('../../js/notation/chart.js'); pinch via pinch.js → chart.previewScale/setScale
createRoadmapSurface(host, opts) → Surface     // kind 'roadmap' when mapped, 'wave' when not; switches on position.mapped
createStemsSurface(host, opts) → Surface & {viewport: Signal<{t0, t1}>}   // the strip binds its bracket to it
```
**`notation/chart.js` API (the only mode; no toolbar, chips, notice, hint or mute button):**
```js
createChart({host, part, engine, scale = 1.2, display = {layout: null, barsPerRow: -1}, followStyle = 'scroll', followAnchor = 0.33,
             glass = false, fonts = {barNumber: 14, marker: 20},
             onBarActivate, onLoopEdit, onFollowChange, onStatus, onEmpty: {findChart, importFile, write}}) → {
  host, setVisible(b), tick(time?), refresh(), destroy(),
  setScale(v, {anchor = true}), previewScale(f|null), setDisplay({layout, barsPerRow}), setFonts({barNumber, marker}),
  setFollowStyle('scroll'|'page', {anchor}), setFollow(b), setLoopRange({a, b}|null), setGlass(b),
  reveal(t, {smooth}), anchorBar() → index, barAtPoint(x, y) → {index, q, time}|null,
}
```
- Behaviour is `maps/notation.md` §11.1, verbatim.
- **Scale steps:** `[.8, .9, 1, 1.1, 1.2, 1.3, 1.45, 1.6, 1.8, 2.0]`.
- **Font floors:** `barNumber = ceil(14 × d / scale)` and `marker = ceil(20 × d / scale)` px, applied before each relayout (d = Distance factor).
- **Page follow:** advances half a viewport (200 ms) when the playing system crosses the middle.
- **Manual scroll** pauses Follow whether playing or stopped, with a 900 ms guard after programmatic scrolls.
- The first render waits for `document.fonts.load('600 15px "Atkinson Hyperlegible Next"')`.
- `.chart-scroll` gets `scrollbar-gutter: stable`.

**`score-view.js` changes:**
- Theme colours are read from `getComputedStyle(host)` using the tokens `--ink`, `--ink-3` and `--ink-2`.
- `fonts` option.
- The loop gets brackets plus a separate handle layer with `pointer-events: auto` and 44 px × row-height hit areas.
- `.score-now-bar` uses `--now-soft`; the playhead is `--now` at 3 px.
- The double re-engrave on `woodshed:theme` goes away: only `score-view` listens.

#### 2.14.13 `wave-render.js`, `grid.js`, `loop-handles.js`
```js
// wave-render.js
export function createPeaks(tracks: [{name, buffer}], {base = 256} = {}) → PeaksCache
//   level k holds min/max pairs per (base × 2^k) samples, built lazily per track from computePeaksRange (src/js/waveform.js); 'mix' = max-abs across tracks
PeaksCache = {ready: boolean, range(name|'mix', t0, t1, bins) → Float32Array /* bins×2, min,max */, perBar(name, bars) → Float32Array}
export function readTokens() → {ink, ink3, now, nowSoft, accent, loop, loopFill, out, line, gridBeat, gridBar, stem: {drums, bass, guitar, piano, vocals, other}}
//   cached; invalidated on 'woodshed:theme' and 'woodshed:place'
export function drawRows(ctx, {rows: [{name, color, state: 'on'|'out'|'solo'|'dim', y, h}], t0, t1, width, dpr, peaks})
export function drawEnvelopeStack(ctx, {x, y, w, h, t0, t1, stems: [{name, color, state, primary}], peaks})
//   primary (your instrument) on top at full opacity, others at .55; 'out' → 1 px outline ghost + 45° hatch (spec §4.4B)
export function drawStripWave(ctx, {w, h, peaks, duration})
export function drawGrid(ctx, {ticks, t0, t1, w, h, minPx = 6})   // beats 8% ink, bars 18%; drawn only when beats are ≥ minPx apart
export function hatch(ctx, color) → CanvasPattern                  // cached per color+dpr
// grid.js (pure)
export function gridTicks(map, t0, t1, division: 'bar'|'beat'|'half'|'quarter') → [{t, kind: 'bar'|'beat'|'sub'}]
export function snapTime(map, t, division, {mode = 'nearest'}) → number
// loop-handles.js
mountLoopHandles(host, {toX(t), toT(x), rows: () => DOMRect[], snap(t, {alt, shift}), onEdit({a, b, phase}), playing: () => boolean}) → {set(range|null), destroy}
//   44 px × row-height hit areas, 20 px grip dot, 3 px --loop edge; 50% opacity while playing (still mouse-draggable); pointer capture
```

### 2.15 `src/edit`
```js
// edit.js (view)
mount(el, match{params: {songId, tab, find?}, query: {bar}}, ctx) → {update, unmount}
//   posture bar 48 px, 2 px --edit top border: '‹ Done', title, label ('Editing map'|'Editing drum chart'|'Editing details'),
//   Tabs Map · Chart · Details (replaceState), ↶ Undo ↷ Redo (labelled), save status slot
//   Done / Esc (nothing selected) → router.back() when the previous entry is this song's Stage, else navigate('/s/:id') with replace
//   main + inspector (laptop: right 320 px; iPad portrait: 45% bottom Sheet collapsing to a 56 px header) + slim transport
//   provides command context 'edit': {tab, setTab(t), done(), undo(), redo(), saveStatus: Signal<{state, text, action?}>}
//   prefs.edit.lastTab is written on each tab change
// map/session.js (no DOM; ported from map-mode.js:104-499, 538-547)
createMapSession({session, prefs}) → MapSession
MapSession = {
  cursorQ: Signal<Fraction>, digits: Signal<string>, tapping: ReadonlySignal<boolean>, previewing, calibrating, auditioning: Signal<boolean>,
  message: Signal<{text, tone: 'info'|'ok'|'error'}|null>, span: ReadonlySignal<SpanInfo>,
  select(q), selectNear(t, {bars}), step(dir, unit: 'bar'|'beat'|'pin'), typeDigit(d), backspaceDigit(), commitDigits(), clearDigits(), goToBar(n),
  pinDownbeat(), pinBeat(), pinLine(q, t), unpin(), nudge(sec), renumber(dir, {byBeat}), renumberTo(bar),
  changeBeats(dir, {thisBar}), applyBar(form: {numerator, denominator, groups, pickup, label, applyTo: 'this'|'until'|'end', keep: 'beats'|'lines', tempo?, ramp?}),
  toggleRamp(), scale(factor), tail(delta), setTempoOpenSpan(bpm),
  tap(kind: 'D'|'T', event), startCalibration(), togglePreview(),
  setLabel(barIndex, label), moveSectionBoundary(fromBar, toBar), addSectionAt(t), markersToSections(markers) → {converted, skipped},
  beginAudition(), endAudition({commit: boolean}),        // D20: wraps a store batch, pauses tempo saves and part map-sync
  undo(), redo(), destroy(),
}
//   Every edit stamps origin through SongMapStore.edit(change, reason) (§4.2). Preview restores both the loop and the click state.
//   Calibration resumes the AudioContext first.
// map/view.js, lane.js, inspector.js, sections.js, find-panel.js
mountMapView(el, {session, mapSession, inspectorEl, find: boolean}) → {destroy}
mountInspector(el, {session, mapSession}) → {destroy}            // spec §5.1 mapping table (maps/mapedit.md §11.4), every key-only edit has a control
mountFindPanel(el, {session, mapSession, onClose}) → {destroy}   // replaces the inspector; the URL /edit/map/find opens it
// chart/chart-edit.js
mount(el, {session, query}) → {destroy}   // hosts createNotationWorkspace (below) with slots; toolbar, menus, inspector tabs, kit bank, scoped keys
// details/details.js
mount(el, match{params: {songId}} | {query: {ids}}, ctx) → {update, unmount}
// drum-import.js
importDrumPartFromFile(file, {session}) → Promise<{count, skipped, warnings}>   // tempo-import parse → importDrumHits → session.notation.importScore
```
**`notation/editor.js` contract** (frame removed, internals kept; `maps/notation.md` §12.1):
```js
createNotationWorkspace({host, slots: {inspector: {kit, properties, listen}, kitBank, status}, part, song, engine, songMap,
  transport: {playStop, pause, again, playFrom(t), setLoop({a, b, aBar, bBar}), isPlaying},
  mix: {toggleRecordedDrums(), recordedDrumsOut(): boolean},
  drumAudio, viewport: {get(), set(t0, t1)}, openMap(q, {edit}), openDrumImport(), dialog: feedback.form}) → {
  handleKey(e) → boolean,          // only while the surface has focus; never Space, Enter or idle Esc
  run(id, ...args), state() → EditorState, subscribe(fn) → off, menus() → {edit: MenuItem[], part: MenuItem[], sections: MenuItem[]},
  focus(), setVisible(b), tick(t), flush(), notice(text), destroy(),
}
```
Removed: the heading, toolbar, panel, footer and pagination markup; `dialog()`/`focusModal`; `alignment()` and the align-beat dialog; the `.player.notation-expanded` toggles; the `setMode('recording')` reset on hide; the Space/Enter clause in `onKey`; `isPointerControl`.

### 2.16 `src/library`
```js
// home.js (view): query {q, sort, group, filter, artist, album}; mirrored to the URL (replace, 400 ms) and prefs.library
// library-model.js (pure)
export const FILTERS = ['chart', 'mapped', 'spots', 'review', 'processing', 'failed']
export const SORTS = ['practised', 'added', 'title', 'artist', 'album', 'duration', 'bpm', 'key']
export function defaultSort(songs) → 'practised'|'added'           // 'practised' once any song has lastPracticedAt
export function matches(song, q) → boolean   // title, uploader, artistLabel, album, albumArtist, genre, tags, mapSummary.sections; case-folded substring
export function filterSongs(songs, {q, filter, artist, album}) → Song[]
export function sortSongs(songs, sort) → Song[]                    // BPM: songs without mapSummary.bpm sort last; stable; Unknown last
export function groupSongs(songs, group: 'none'|'album'|'artist') → [{key, label, cover, count, songs}]   // 'Unknown album/artist' sorts last
// song-labels.js
artistLabel(song), metaLine(song) → '1:04 · Chart · Mapped · 2 spots · 6 stems', stateLine(song, now) → 'Bridge loop · 85% · Drums out · practised yesterday', relativeTime(ms, now)
// cards.js
SongCard(song, opts) / SongRow(song, opts) → {el, update(song, opts)}
//   opts: {job: JobVM|null, selected, selecting, onOpen, onMenu, onArtist, onAlbum, onReview, isNew}; `data-focus-key="song:<id>"`
// jobs.js
createJobsModel() → {items: ReadonlySignal<JobVM[]>, chip: ReadonlySignal<{text, tone, icon}|null>, bySong: ReadonlySignal<Map<id, JobVM>>,
                     ready: ReadonlySignal<Song[]> /* finished during this app session and not opened yet: the Stage `1 ready` chip, toasts, notifications */}
// New dot: isNew(song) = !song.lastPracticedAt && now − addedAt < 30 days && !prefs.library.opened.includes(id); the Stage adds the id on mount
JobVM = {id, kind: 'separate'|'beats'|'import'|'upload', songId, title, quoted, cover, stages: [{id, label, state}], percent, line,
         ahead, device, settingsLine, message, source: {label, url}|null, eta, failure: describeError()|null, local, actions: [{label, run, tone}]}
openJobsPopover({anchor, focusJobId}) → {close}; mountJobsChip(slot) → {destroy}
// add-model.js (pure)
classify(input) → {kind: 'empty'|'url'|'spotify'|'search', value}
badges(title) → Array<'Official'|'Live'|'Cover'|'Lyrics'>
findDuplicate({url?, title?, artist?, duration?}, songs) → Song|null    // same source url, or title+artist case-folded with duration ±2 s
addDefaults(profile, settings) → {stemMode, preset}; describeDefaults(...) → 'Split for drums · Balanced quality · 4 stems'
removesMyStem(profile, stemMode) → Instrument|null                      // 'Your guitar won't be a separate track with this layout.'
// add-sheet.js (modal route /add): query {q}; files arrive through dropzone.stageFiles(files) before navigate('/add')
// upload.js
startUpload(file, {settings, deviceId}) → UploadHandle
UploadHandle = {id, progress: ReadonlySignal<{loaded, total}>, state: ReadonlySignal<'uploading'|'queued'|'error'|'canceled'>, cancel(), promise}
//   XHR to companion /upload (src/js/companion.js uploadXHR), then jobs.createSeparation only if not canceled (S1 fix)
// dropzone.js: startLibraryDrop({router}) → off; stageFiles(files) / takeStagedFiles() → File[]
// selection.js: createSelection({max = 100}) → {ids: Signal<Set>, active: Signal<boolean>, toggle(id), range(id), selectAll(ids), clear(), mountBar(el)}
// card-menu.js: cardMenuItems(song, ctx) → MenuItem[]   (spec §2.5)
// resplit-dialog.js: openResplit(song) → Promise<void>
// review-chip.js: ReviewChip(song) → {el, update}       // metadata.confirm / → /s/:id/edit/details#match
// setlists.js: mountSetlistsRow(el) → {destroy}          (LB1: cards open /set/:id; read-only)
// card-menu.js also exports addToSetlistItems(songIds) → MenuItem   (LB3: 'Add to setlist ▸' with a new-list field)
// setlist-page.js (view /set/:id): reorder, remove, rename, play from the top (→ /s/<first>?set=<id>)
// first-run.js: mountFirstRun(el, {demo}) → {destroy}
```

### 2.17 `src/settings`
```js
// settings.js (view): /settings → index (laptop: redirect to /settings/practice; iPad portrait: list); /settings/:section → section
// sections/*.js:
export default {id, title, desktopOnly?: boolean, render(el, ctx) → {destroy}}
//   ids: 'practice', 'instruments', 'pedals', 'processing', 'appearance', 'plan', 'device', 'account'
//   Every control saves on change and shows an inline 'Saved'; failure → "Couldn't save · [Retry]".
//   On web, desktop-only rows are never shown disabled. They collapse into one note:
//   "These need Woodshed for desktop: … [Get it ↗]"
// admin/admin.js, admin/account.js (views); admin/reason-dialog.js: askReason({title, body, confirmLabel, danger}) → Promise<string|null>   (≥ 3 chars)
```

### 2.18 `src/share` and the demo
```js
openShareDialog(song, {beforeShare: () => session.flush()}) → Promise<void>
shareUrl(token) → `${import.meta.env.VITE_SHARE_ORIGIN || location.origin}/share/${token}`   // desktop builds must set VITE_SHARE_ORIGIN
// shared-stage.js: export async function boot(match) → void
//   publicClient().subscribe('sharing:view', {token}) → a session with {shared: {token, snapshot, resolveUrls: shareAudio.playback, cacheNamespace}}
//   mounts stage.js read-only: identity 'Shared by {name}' + [Add to my library] (signed in) | [Sign in to keep a copy] (?save=1 flow kept)
//   Edit hidden; practice via shared-practice.js; one-time status "Changes stay on this device until you add the song to your library."
//   after shareAudio.save → api.songs.savePractice(newId, upgradePractice(local)) → navigate('/s/<newId>')
// demo.js
demoToken() → Promise<string|null>   // settings:demo; cached for the page
openDemo(router)                      // location.assign(`/share/${token}`); the Shared Stage applies Minus me from the profile when openWithMyPart === 'out' or the profile is set
```

### 2.19 Onboarding and first run
```js
renderSignIn(el, {error}) → {destroy}            // spec §6.6.1 copy; no theme picker
InstrumentPicker({value: Profile, onChange}) → {el, set, destroy}   // 56 px chips; the first tapped is primary; 'When you open a song: [Hear everything] [Start with my part out]'
// welcome.js (view /welcome): Continue → account.patch({profile, onboarding: {whatDoYouPlay: 'done'}}) → replace('/'); Skip → 'skipped'
// coach.js
startStageCoach({stage, session}) → off
//   steps 1–3 (Play, strip, Mix) and step 4 (first unmapped song), each dismissed by doing the thing; never while playing;
//   account.onboarding.coach bitmask (bits 1, 2, 4, 8)
```
**Desktop first run:** while `processor.firstRun`, the processor status reads "Setting up the processor (first run, ~1 min)…". After it, the Add sheet opens once with the placeholder "Paste a link to your first song" (`account.onboarding.desktopFirstRun`).

### 2.20 Desktop menu from the registry (renderer ↔ main)
```js
// desktop-menu.js
startDesktopMenu() → stop
//   builds MenuSpec from registry defs with menu.electron set; re-sends (debounced 100 ms) on registry onChange, route change, transport phase, prefs.practice.distance
//   desktop.onCommand(({id, source}) => run(id, {source: source === 'global' ? 'global' : 'menu'}))
//   desktop.onNavigate(route => router.navigate(route)); desktop.onFlushRequest(() => activeSession?.flush())
//   desktop.onFullScreen(on => on && !prefs.hints.fullscreenFocus && status('Use Focus for a cleaner stage?', {action: Focus}))
MenuSpec = [{menu: 'file'|'edit'|'view'|'transport'|'help', items: MenuSpecItem[]}]
MenuSpecItem = {id, label, accelerator?: string /* only Mod/Ctrl combos, D41 */, enabled: boolean, type?: 'normal'|'checkbox'|'radio',
                checked?: boolean, submenu?: MenuSpecItem[]} | {type: 'separator'}
```
**Main (`desktop/menu.cjs`):**
- `validateMenuSpec(spec) → spec|null`: ≤ 6 menus, ≤ 60 items each, one submenu level, ids `/^[a-z][a-zA-Z0-9.-]{0,63}$/`, labels ≤ 80, an accelerator allow-list regex, and `type` in `normal|separator|checkbox|radio`. Unknown keys are dropped.
- `buildTemplate(spec, {isMac, isPackaged})`:
  - a fixed macOS app menu (About · Check for Updates… · Settings… ⌘, → `nav.settings` · Services · Hide · Quit);
  - Edit = roles (cut, copy, paste, pasteAndMatchStyle, selectAll) plus custom `app.undo`/`app.redo`;
  - View appends zoom roles and `togglefullscreen`; `reload` and `toggleDevTools` only when `!isPackaged`;
  - Help = Keyboard Shortcuts (`app.shortcuts`), Licenses, Check for Updates… (Windows/Linux).
- A fallback menu is installed at startup.
- `File → Close Song` (`stage.close`) is disabled unless `setActivity({songOpen: true})`.

**Preload bridge (final):** `info`, `update`, `onUpdate`, `onOpenUpdates`, `setTheme`, `mediaUrl`, `onProcessorState`, `restartProcessor`, `registerMenu`, `onCommand`, `setActivity`, `setBackgroundShortcuts`, `notify`, `onNavigate`, `onFlushRequest`, `onFullScreen`. These are exactly `maps/companion-desktop.md` §16.11. Every `on*` returns `off`, and every main handler checks `trusted(event)`.

---
### 2.21 `shared/practice.ts` (practice blob v2)
```ts
export const PRACTICE_CAP = 32_768;           // JSON.stringify length; B2 (server and client use this constant)
export const MAX_SPOTS = 24, MAX_MARKERS = 64, TOMBSTONE_DAYS = 30;
export type BarRef = {id: string; beat: number; frac?: number};   // measure id, 0-based group index, fraction 0..1 within the group
export type Spot = {id: string; name: string /* ≤ 60 */; a: number; b: number; aBar?: BarRef; bBar?: BarRef; rate: number;
                    note?: string /* ≤ 280 */; lastAt?: number; passes: number; updatedAt: number; deleted?: true};
export type Marker = {id: string; t: number; label: string /* ≤ 60 */; updatedAt: number; deleted?: true};
export type PracticeV2 = {
  v: 2;
  lastAt?: number;                       // ms epoch; written once per session (first Play)
  cue: number;                           // s, 0..duration
  surface?: 'chart'|'roadmap'|'stems';   // absent → surfaceDefault()
  anchorBar?: number; anchorTime?: number;
  rate: number; lastRate?: number;       // 0.25..1.5
  keepPitch?: boolean;                   // absent → account.practice.keepPitch
  loop: {on: boolean; a: number; b: number; aBar?: BarRef; bBar?: BarRef;
         eachPassCount: boolean; playTimes: 0|2|4|8; between: 'none'|'rest'|'call'};
  tracks: {name: string; volume: number; muted: boolean; soloed: boolean}[];   // ≤ 8
  minusMe: boolean; onlyMe?: boolean;
  chartAudio?: 'off'|'quiet'|'loud';     // D27; absent → 'off'
  trainer: {start: number; end: number; step: number; passes: number} | null;
  spots: Spot[]; markers: Marker[];
};
export function emptyPractice(): PracticeV2       // cue 0, rate 1, loop {on:false, a:0, b:0, eachPassCount:true, playTimes:0, between:'none'}, tracks [], minusMe false, trainer null, spots [], markers []
export function upgradePractice(raw: unknown, {duration}: {duration?: number} = {}): PracticeV2
//   v2 → sanitised copy (clamps, caps, drops unknown keys).
//   v1 {loop:{enabled,a,b}, rate, grid, tracks} → {v:2, loop:{on:enabled, a, b, eachPassCount:true, playTimes:0, between:'none'}, rate, tracks}
//     plus emptyPractice defaults; `grid` is dropped (the device pref took ws.grid; a per-song grid is not kept).
//   Anything else → emptyPractice(). Pure; never throws.
export function mergePractice(local: PracticeV2, server: PracticeV2|null, dirty: Set<string>): PracticeV2
//   spots and markers: union by id; per id the larger updatedAt wins; ties → deleted wins
//   scalars and objects at the top level (cue, rate, loop, tracks, …): local value when the key is in `dirty`, else the server value
//   lastAt: max(local, server)
export function prunePractice(p: PracticeV2, cap = PRACTICE_CAP, now = Date.now()): {value: PracticeV2, pruned: number}
//   1. drop tombstones older than 30 days; 2. drop the oldest markers with default labels ('Marker n'); 3. the oldest named markers;
//   4. trim spot notes; never drop live spots. Repeat until JSON.stringify(value).length ≤ cap.
export function summarize(p: PracticeV2, map: {sections: {label: string, t0: number, t1: number}[]}|null): PracticeSummary
//   loopLabel: loop.on ? (section label covering [a,b) exactly → '{label} loop' | 'Bars x–y loop' | 'm:ss–m:ss loop') : undefined
//   rate, minusMe, surface, spotCount (live), spots: the 3 most recently practised (lastAt desc, then updatedAt) as {id, name, rate}
export function sanitizeForShare(p: PracticeV2): PracticeV2   // drops spot notes; keeps spots and markers; minusMe false; lastAt removed
export type PracticeSummary = {loopLabel?: string; rate: number; minusMe: boolean; surface?: string; spotCount: number;
                               spots: {id: string; name: string; rate: number}[]};
```
The size budget is ≈ 24 × 170 B (spots) + 64 × 75 B (markers) + 8 × 60 B (tracks) + 400 B ≈ 9.6 KB typical, well under 32 KB.

### 2.22 `src/app/profile.js` (pure)
```js
export const INSTRUMENTS = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];
export const STEM_FOR = {drums: ['drums'], bass: ['bass'], vocals: ['vocals'], guitar: ['guitar', 'other'], keys: ['piano', 'other'], other: ['other']};
export function myStems(profile, stemNames) → {names: string[], fallbacks: Instrument[] /* matched 'other' */, missing: Instrument[]}   // D37
export function addDefaults(profile) → {stemMode: 'full'|'six', preset: 'balanced'}   // guitar or keys → 'six'; never a two-part mode
export function describeMapping(profile) → string[]   // 'Guitar → guitar stem on 6-stem songs, otherwise Other'
```

---

## 3. Command registry (complete)

**Columns:**
- **Keys** are KeyStrings (§2.6); `⌫` means `Backspace` and `Delete` are both bound.
- **Scopes:** S = `stage`, Ss = `stage.stems` (surface mode), E = `edit` (every Edit tab), Em = `edit.map`, Ec = `edit.chart`, Ecs = `edit.chart.score` (focus), L = `library`, G = `global`. "—" means palette and menu only.
- **P** marks `pedal: true`.
- **Control/menu** lists the on-screen controls and Electron menu items bound to the command.

**Shadowing:** a key may be bound in more than one scope of a reachable chain only when the pair is listed in `tests/registry-shadows.js`. The allowed pairs are: Ss over S (`=`, `-`, `KeyF`); Ecs over Ec/E (the drum letters, digits, `.`, `=`, `-`, `Escape`); E over G (`Escape`); S over G (none today). The registry test fails on any other overlap.

Every dock, rail and slim-transport control appears here. The registry CI test (§10.1) asserts that every `CONTROL_SET` command, every Menu item `command`, and every `Button({command})` in the source exists here.

### 3.1 Transport, loop, speed, click, mix, navigation (`src/stage/transport-commands.js`; scopes S and E unless noted)
| id | Title | Group | Keys | Scopes | P | Control / menu |
|---|---|---|---|---|---|---|
| `transport.playStop` | Play / Stop | Transport | `Space` | S, E | ✓ | Dock/rail/slim ▶; Transport menu; media key Play/Pause; ⌃⌥Space (global) |
| `transport.pause` | Pause / continue | Transport | `Shift+Space` | S, E | ✓ | Long-press Play; slim ‖ |
| `transport.again` | Start again | Transport | `Enter` | S, Ec | ✓ | Dock/rail/slim ⟲; Transport menu; ⌃⌥↩ (global); media key Previous |
| `transport.stop` | Stop | Transport | — | — | ✓ | Media key Stop (global) |
| `transport.loopToggle` | Loop | Loop | `KeyL` | S | ✓ | Dock/rail Loop; Transport menu; ⌃⌥L (global) |
| `transport.loopSection` | Loop this section | Loop | `Shift+KeyL` | S | ✓ | Strip double-tap; section menu |
| `loop.in` | Loop in at playhead | Loop | `KeyI` | S, Em | — | Loop card |
| `loop.inExact` | Loop in (unsnapped) | Loop | `Shift+KeyI` | S, Em | — | |
| `loop.out` | Loop out at playhead | Loop | `KeyO` | S, Em | — | Loop card |
| `loop.outExact` | Loop out (unsnapped) | Loop | `Shift+KeyO` | S, Em | — | |
| `loop.clear` | Clear loop | Loop | `⌫` | S | — | Loop card; loop-band menu |
| `loop.moveBack` | Move loop back by its length | Loop | `Shift+[` | S | — | Loop card ◀ Move |
| `loop.moveFwd` | Move loop forward by its length | Loop | `Shift+]` | S | — | Loop card Move ▶ |
| `loop.card` | Loop options… | Loop | — | S, E | — | Long-press Loop; slim loop chip; HUD Loop line tap |
| `loop.eachPass` | Count in every pass | Loop | — | S, E | — | Loop card / Click sheet toggle (`checked`) |
| `loop.playTimes` | Play N times then stop | Loop | — | S | — | Loop card segmented (args `{n}`) |
| `loop.between` | Between passes | Loop | — | S | — | Loop card segmented (args `{mode}`) |
| `nav.prevSection` | Previous section | Navigate | `[`, `PageUp` | S, Em | ✓ | Strip; pedals |
| `nav.nextSection` | Next section | Navigate | `]`, `PageDown` | S, Em | ✓ | Strip; pedals; media key Next |
| `nav.barBack` | Back a bar (5 s unmapped) | Navigate | `ArrowLeft` | S | ✓ | — (repeat) |
| `nav.barFwd` | Forward a bar (5 s unmapped) | Navigate | `ArrowRight` | S | ✓ | — (repeat) |
| `nav.beatBack` | Back a beat (1 s unmapped) | Navigate | `Shift+ArrowLeft` | S | — | — (repeat) |
| `nav.beatFwd` | Forward a beat (1 s unmapped) | Navigate | `Shift+ArrowRight` | S | — | — (repeat) |
| `cue.nudgeBack` | Nudge cue −50 ms | Navigate | `Alt+ArrowLeft` | S | — | — (repeat) |
| `cue.nudgeFwd` | Nudge cue +50 ms | Navigate | `Alt+ArrowRight` | S | — | — (repeat) |
| `cue.nudgeBackFine` | Nudge cue −10 ms | Navigate | `Alt+Shift+ArrowLeft` | S | — | — (repeat) |
| `cue.nudgeFwdFine` | Nudge cue +10 ms | Navigate | `Alt+Shift+ArrowRight` | S | — | — (repeat) |
| `nav.home` | Loop start, else song start | Navigate | `Home` | S | — | |
| `nav.end` | Loop end, else song end | Navigate | `End` | S | — | |
| `nav.goTo` | Go to bar or time… | Navigate | — | S, E | — | Palette (`bar 57`, `1:12`; args `{t}`) |
| `speed.down` | Slower (−5%) | Speed | `,` | S, Ec | ✓ | Dock/rail − (repeat) |
| `speed.up` | Faster (+5%) | Speed | `.` | S, Ec | ✓ | Dock/rail + (repeat) |
| `speed.downFine` | Slower (−1%) | Speed | `Shift+,` | S, Ec | — | (repeat) |
| `speed.upFine` | Faster (+1%) | Speed | `Shift+.` | S, Ec | — | (repeat) |
| `speed.toggle100` | Speed 100% ↔ last | Speed | `` ` `` | S, Ec | ✓ | Long-press the speed value |
| `speed.set` | Set speed… | Speed | — | S, E | — | Palette `75%`; Speed sheet presets (args `{rate}`) |
| `speed.sheet` | Speed & trainer… | Speed | — | S, E | — | Tap the speed value; slim speed chip |
| `trainer.toggle` | Start / stop trainer | Speed | — | S | ✓ | Speed sheet; palette `trainer 70 100` (args) |
| `click.countIn` | Count-in | Click | `KeyC` | S, E | ✓ | Dock/rail/slim Count-in; Transport menu |
| `click.toggle` | Click | Click | `KeyK` | S, E | ✓ | Rail/slim Click; Transport menu |
| `click.sheet` | Click & count-in… | Click | — | S, E | — | Long-press Count-in or Click |
| `mix.minusMe` | Minus me | Mix | `KeyM` | S, Em | ✓ | Dock/rail Mix main zone; slim Mix chip; Transport menu |
| `mix.onlyMe` | Only me | Mix | `Shift+KeyM` | S, Em | ✓ | Mix sheet |
| `mix.full` | Full mix | Mix | `Digit0` | S | ✓ | Mix sheet |
| `mix.mute.N` (N = 1…9) | Mute {stem} | Mix | `DigitN` | S | — | Stem pad / stems row key-cap (dynamic; canonical order) |
| `mix.solo.N` (N = 1…9) | Solo {stem} | Mix | `Shift+DigitN` | S | — | (dynamic) |
| `mix.sheet` | Mix… | Mix | — | S, E | — | Dock/rail ⌃ zone; long-press Mix; slim Mix chip |
| `mix.chartAudio` | Chart playback | Mix | — | S, E | — | Mix sheet segmented (args `{level}`) |

### 3.2 Stage (`src/stage/commands.js`; scope S unless noted)
| id | Title | Group | Keys | Scopes | P | Control / menu |
|---|---|---|---|---|---|---|
| `marker.add` | Add marker (section when mapped) at playhead | Practice | `KeyS` | S | ✓ | Bar menu "Add marker here" |
| `spot.save` | Save spot | Practice | `KeyB` | S | ✓ | Loop card; bar/section/loop-band menus |
| `spot.list` | Spots | Practice | `KeyJ` | S | — | Identity ⋯ → Spots |
| `spot.open` | Open spot {name} | Practice | — | S | — | Spots list; palette; `?spot=` (args `{id}`) |
| `view.cycle` | Next view | View | `KeyV` | S | — | |
| `view.chart` | Chart | View | — | S | — | ⋯ → View; View menu (radio) |
| `view.roadmap` | Road map | View | — | S | — | ⋯ → View; View menu (radio) |
| `view.stems` | Stems | View | — | S | — | ⋯ → View; View menu (radio) |
| `view.focus` | Focus (resumes Follow if paused) | View | `KeyF` | S | ✓ | ⋯ → Focus; HUD readouts double-tap; View menu (D25) |
| `view.distance.near` / `.stand` / `.kit` | Distance: Near / Stand / Kit | View | — | S | — | ⋯ → Distance; View → Distance ▸ (radio) |
| `view.bigger` | Larger chart (longer rows on the wave page) | View | `=` | S | — | (repeat) |
| `view.smaller` | Smaller chart (shorter rows) | View | `-` | S | — | (repeat) |
| `view.followResume` | Back to playhead | View | — | S | ✓ | "⤓ Back to playhead" pill |
| `view.display` | Display: Together / Hands & feet | View | — | S | — | ⋯ → Display (args `{layout}`) |
| `view.followStyle` | Follow: Scroll / Page | View | — | S | — | ⋯ → Follow (args `{style}`) |
| `stage.scrollUp` | Scroll up one screen | View | — | S | ✓ | Page-turn pedal profile |
| `stage.scrollDown` | Scroll down one screen | View | — | S | ✓ | Page-turn pedal profile |
| `stage.scrollTop` | Scroll to top | View | — | S | ✓ | Page-turn pedal profile |
| `stage.notes` | Notes | Practice | — | S | — | HUD Notes chip |
| `stage.tapBeat` | Tap the beat… | Practice | — | S | — | Get bars popover; Click sheet; palette |
| `stage.getBars` | Get bars… | Practice | — | S | — | Strip "No bar grid · Get bars →" |
| `stage.share` | Share… | App | — | S | — | ⋯ → Share… |
| `stage.startOver` | Start over | Practice | — | S | — | Resume chip [Start over] |
| `stage.leave` | Back to Library | App | — (Esc reaches it through `app.escape`) | S | — | ‹ (hold while playing) |
| `stage.close` | Close Song | App | — (⌘W via the Electron menu only) | — | — | File menu (enabled while a song is open) |
| `edit.open` | Edit (last tab) | Edit | `KeyE` | S | — | ⋯ → Edit map / Edit chart / Edit details |
| `edit.map` / `edit.chart` / `edit.details` | Edit map / Edit drum chart / Edit details | Edit | — | S, E | — | ⋯ menu; Edit tabs; card menu (Library) |
| `practice.undo` | Undo | Practice | `Mod+KeyZ` | S | — | Edit menu `app.undo` routes here |
| `practice.redo` | Redo | Practice | `Mod+Shift+KeyZ`, `Mod+KeyY` | S | — | Undo toast [Redo] |
| `setlist.next` | Next song in set | Navigate | `Alt+ArrowDown` | S (when `?set`) | ✓ | HUD set line; right-hold pedal in a set |
| `setlist.prev` | Previous song in set | Navigate | `Alt+ArrowUp` | S (when `?set`) | ✓ | HUD set line |

### 3.3 Stems surface (`src/stage/surfaces/stems-surface.js` registers on mount; scope Ss)
| id | Title | Group | Keys | Scopes | P | Control |
|---|---|---|---|---|---|---|
| `stems.zoomIn` | Zoom in | View | `=` | Ss | — | Toolbar + (repeat) |
| `stems.zoomOut` | Zoom out | View | `-` | Ss | — | Toolbar − (repeat) |
| `stems.fit` | Fit | View | `\` | Ss | — | Toolbar Fit |
| `stems.zoomLoop` | Zoom to loop | View | `KeyZ` | Ss | — | Toolbar; loop-band menu |
| `stems.grid` | Grid on/off | View | `KeyG` | Ss | — | Toolbar Grid ▾ (the menu sets the division) |
| `stems.snap` | Snap | View | `Shift+KeyS` | Ss | — | Toolbar Snap (aria-pressed) |
| `stems.follow` | Follow | View | `KeyF` | Ss | — | Toolbar Follow (aria-pressed) |

### 3.4 Edit (`src/edit/commands.js` scope E; `src/edit/map/commands.js` scope Em; `src/edit/chart/commands.js` scopes Ec/Ecs)
| id | Title | Group | Keys | Scopes | P | Control |
|---|---|---|---|---|---|---|
| `edit.done` | Done | Edit | `Escape` | E | — | Posture bar ‹ Done. Esc is layered per tab: Map → close menu/sheet → clear digits → stop preview → close Find (confirm mid-audition) → Done; Chart → close panel sheet (iPad) → Done (the surface's `chart.clear` runs first when focused); Details → Done |
| `edit.tab.map` / `.chart` / `.details` | Map / Chart / Details | Edit | — | E | — | Posture tabs |
| `app.undo` / `app.redo` | Undo / Redo | App | — (menu only) | — | — | Electron Edit menu: text field focused → `document.execCommand`, else the posture's stack |
| `map.undo` | Undo map edit | Map | `Mod+KeyZ` | Em | — | Posture ↶ Undo |
| `map.redo` | Redo map edit | Map | `Mod+Shift+KeyZ`, `Mod+KeyY` | Em | — | Posture ↷ Redo |
| `map.prevBar` / `map.nextBar` | Previous / next bar | Map | `ArrowLeft` / `ArrowRight` | Em | — | Inspector ◀ Bar / Bar ▶ (repeat) |
| `map.prevBeat` / `map.nextBeat` | Previous / next beat | Map | `Shift+ArrowLeft` / `Shift+ArrowRight` | Em | — | (repeat) |
| `map.prevPin` / `map.nextPin` | Previous / next pin or meter change | Map | `Mod+ArrowLeft` / `Mod+ArrowRight` | Em | — | Inspector ⏮ ⏭ |
| `map.digit.N` (N = 0…9) | Go to bar: type N | Map | `DigitN` | Em | — | Inspector "Go to [ ]" (D19) |
| `map.goOrApply` | Go to typed bar / apply field | Map | `Enter` | Em | — | Inspector Go / Apply ↵ |
| `map.first` / `map.last` | First / last bar | Map | `Home` / `End` | Em | — | |
| `map.pinDownbeat` | Pin downbeat (tap while playing) | Map | `KeyD` | Em | — | Inspector [Pin downbeat D] |
| `map.pinBeat` | Pin beat (tap while playing) | Map | `KeyT` | Em | — | Inspector [Pin beat T] |
| `map.unpin` | Unpin | Map | `⌫` | Em | — | Inspector [Unpin ⌫] |
| `map.nudgeBack` / `map.nudgeFwd` | Nudge pin −10 / +10 ms | Map | `,` / `.` | Em | — | Inspector [−10] [+10] (repeat) |
| `map.nudgeBackFine` / `map.nudgeFwdFine` | Nudge pin −1 / +1 ms | Map | `Shift+,` / `Shift+.` | Em | — | Inspector [−1] [+1] (repeat) |
| `map.renumberBack` / `map.renumberFwd` | Move pin to previous / next bar number | Map | `Alt+ArrowLeft` / `Alt+ArrowRight` | Em | — | Inspector "This pin is bar [ ]" |
| `map.renumberBeatBack` / `map.renumberBeatFwd` | Move pin by a beat | Map | `Alt+Shift+ArrowLeft` / `Alt+Shift+ArrowRight` | Em | — | |
| `map.beatsDown` / `map.beatsUp` | Fewer / more beats (until next change) | Map | `ArrowDown` / `ArrowUp` | Em | — | Meter Beats stepper |
| `map.beatsDownBar` / `map.beatsUpBar` | Fewer / more beats (this bar) | Map | `Shift+ArrowDown` / `Shift+ArrowUp` | Em | — | |
| `map.tailDown` / `map.tailUp` | Tail tempo −1 / +1 | Map | `Alt+ArrowDown` / `Alt+ArrowUp` | Em | — | Tempo Tail [−] [+] (repeat) |
| `map.tailDownFine` / `map.tailUpFine` | Tail tempo −0.1 / +0.1 | Map | `Alt+Shift+ArrowDown` / `Alt+Shift+ArrowUp` | Em | — | (repeat) |
| `map.editBar` | Edit bar (focus Meter) | Map | `KeyE` | Em | — | Inspector Meter (D19) |
| `map.ramp` | Ramp to next pin | Map | `KeyR` | Em | — | Inspector ☐ Ramp |
| `map.preview` | Preview these bars | Map | `KeyP` | Em | — | Inspector [Preview bars P] |
| `map.double` / `map.halve` | Double / halve tempo | Map | `*` / `/` | Em | — | Inspector [×2] [÷2] |
| `map.addSection` | Add section at playhead | Map | `KeyS` | Em | — | Sections lane |
| `map.grid` | Grid on/off | Map | `KeyG` | Em | — | Toolbar Grid ▾ |
| `map.snap` | Snap | Map | `Shift+KeyS` | Em | — | Toolbar Snap |
| `map.zoomIn` / `map.zoomOut` | Zoom in / out | Map | `=` / `-` | Em | — | Toolbar + / − (repeat) |
| `map.fit` | Fit | Map | `\` | Em | — | Toolbar Fit |
| `map.zoomSelection` | Zoom to selection | Map | `KeyZ` | Em | — | Toolbar Z |
| `map.tapAlong` | Tap along | Map | — | Em | — | Inspector [Tap along] |
| `map.calibrate` | Calibrate tap timing… | Map | — | Em | — | Inspector |
| `map.detect` | Detect beats | Map | — | Em, S | — | Inspector; Get a map; Get bars popover |
| `map.find` | Find a chart… | Map | — | Em, S | — | Inspector; Get bars; chart empty state (→ `/edit/map/find`) |
| `map.markersToSections` | Turn markers into sections | Map | — | Em | — | Banner |
| `chart.undo` / `chart.redo` | Undo / Redo notation | Chart | `Mod+KeyZ` / `Mod+Shift+KeyZ`, `Mod+KeyY` | Ec | — | Toolbar ↶ ↷ |
| `chart.pagePrev` / `chart.pageNext` | Previous / next 16 bars | Chart | `[`, `PageUp` / `]`, `PageDown` | Ec | — | Toolbar ‹ › |
| `chart.loopSelection` | Loop selection | Chart | `KeyL` | Ec | — | Edit ▾ (D18: drum letter L wins inside the surface) |
| `chart.write` | Write note | Chart | `KeyN` | Ecs | — | Kit bank |
| `chart.piece.<kitId>` (27, dynamic) | Write {piece} | Chart | the remappable letter (`ws.prefs.edit.chart.keys` or the KIT default) | Ecs | — | Kit tab pads; kit bank |
| `chart.cursorBack` / `chart.cursorFwd` | Step back / forward (moves notes in lanes with a selection) | Chart | `ArrowLeft` / `ArrowRight` | Ecs | — | (repeat) |
| `chart.extendBack` / `chart.extendFwd` | Extend selection | Chart | `Shift+ArrowLeft` / `Shift+ArrowRight` | Ecs | — | (repeat) |
| `chart.pieceUp` / `chart.pieceDown` | Previous / next piece (lane) | Chart | `ArrowUp` / `ArrowDown` | Ecs | — | (repeat) |
| `chart.moveBack` / `chart.moveFwd` | Move notes | Chart | `Alt+ArrowLeft` / `Alt+ArrowRight` | Ecs | — | Edit ▾ Move notes… (repeat) |
| `chart.barStart` / `chart.barEnd` | Bar start / end | Chart | `Home` / `End` | Ecs | — | |
| `chart.skip` | Skip | Chart | `KeyR` | Ecs | — | Toolbar Skip (R) |
| `chart.step.N` (N = 1…5) | Step 1/64 … 1/4 | Chart | `Digit1`…`Digit5` | Ecs | — | Toolbar steps (D18) |
| `chart.finer` / `chart.coarser` | Finer / coarser step | Chart | `=` / `-` | Ecs | — | |
| `chart.dot` | Dotted | Chart | `.` | Ecs | — | Toolbar • Dotted |
| `chart.tuplet` | Cycle tuplet | Chart | `/` | Ecs | — | Toolbar Tuplet ▾ |
| `chart.accent` / `chart.heavy` / `chart.ghost` | Accent / heavy accent / ghost | Chart | `KeyA` / `Shift+KeyA` / `KeyG` | Ecs | — | Properties |
| `chart.delete` | Delete note | Chart | `⌫` | Ecs | — | Properties Delete |
| `chart.copy` / `chart.paste` / `chart.repeat` / `chart.selectBar` | Copy / Paste / Repeat bars / Select bar | Chart | `Mod+KeyC` / `Mod+KeyV` / `Mod+KeyD` / `Mod+KeyA` | Ecs | — | Edit ▾ |
| `chart.clear` | Clear selection | Chart | `Escape` (only when there is a gesture or selection) | Ecs | — | |

Edit · Chart menu-only commands, each shown with its shortcut: `chart.moveDialog`, `chart.tupletDialog`, `chart.review`, `chart.barMeter` (→ Edit · Map at the bar), `chart.align` (→ Edit · Map), `chart.export`, `chart.print`, `chart.openPart`, `chart.importDrums`, `chart.drumKeys`, `chart.noteList`, `chart.allLanes`, `chart.shortcuts`, `chart.view` (args `{view}`), `chart.partLayout` (args `{layout}`), `chart.listen` (args `{mode}`), `chart.playCursor`, `chart.fit`, `chart.follow`, `chart.retrySave`, `chart.resolve`.

### 3.5 Library, global, app (`src/library/commands.js` scope L; `src/app/global-commands.js` scope G)
| id | Title | Group | Keys | Scopes | P | Control / menu |
|---|---|---|---|---|---|---|
| `app.palette` | Command palette | App | `Mod+KeyK` | G | — | Search field ⌘K hint |
| `app.shortcuts` | Keyboard shortcuts | App | `?` | G | — | Avatar menu; Help menu |
| `app.escape` | Close / back | App | `Escape` | G | — | Stage: exit Focus → playing: status "Stop playback first (Space)" → stopped (desktop app only): `stage.leave`. Library: clear search → exit selection. Overlays close before this (dispatcher rule 7); Edit uses `edit.done`. Esc never navigates while the transport runs. |
| `nav.library` | Library | App | — | G | — | Wordmark; palette |
| `nav.settings` | Settings… | App | — (⌘, via the Electron menu only) | G | — | Avatar menu; app menu |
| `nav.settings.<section>` | Settings: {section} | App | — | G | — | Palette |
| `nav.plan` | Plan & storage | App | — | G | — | Avatar menu |
| `nav.admin` | Administration | App | — | G | — | Avatar menu (admins) |
| `app.updates` | App updates | App | — | G | — | Avatar menu (desktop); app menu Check for Updates… |
| `app.download` | Get the desktop app | App | — | G | — | Avatar menu (web; new tab) |
| `app.signOut` | Sign out | App | — | G | — | Avatar menu |
| `library.add` | Add song… | Library | `KeyN` (L only; ⌘N via the Electron menu) | L | — | ＋ Add song; File → Add Songs… |
| `library.search` | Search | Library | `/` | L | — | Top-bar search |
| `library.openFocused` | Open song | Library | `Enter` (native on the focused card) | L | — | |
| `library.editFocused` | Edit details | Library | `KeyE` | L | — | Card menu "Edit details… E" |
| `library.deleteSelected` | Delete selected… | Library | `⌫` (selection mode) | L | — | Selection bar |
| `library.selectAll` | Select all visible | Library | `Mod+KeyA` (selection mode) | L | — | Selection bar |
| `library.select` | Select | Library | — | L | — | Sort ▾ → Select |
| `library.first` / `library.last` | First / last card | Library | `Home` / `End` | L | — | |
| `library.view` | Grid / list | Library | — | L | — | ▦/☰ toggle |
| `library.jobs` | Jobs | Library | — | G | — | Jobs chip |
| `library.demo` | Open the example song | Library | — | G | — | Demo card; web Add sheet |

**Arrow keys in the Library** are handled by the grid's roving focus: the grid element declares `data-consume-keys="ArrowLeft ArrowRight ArrowUp ArrowDown"`.

**⌘V in the Library** is a `paste` event listener on the Library view (not a keydown binding). A URL in the clipboard opens `/add?q=<url>`, pre-filled and not submitted.

**Background shortcuts** (desktop, opt-in): ⌃⌥Space → `transport.playStop`, ⌃⌥↩ → `transport.again`, ⌃⌥L → `transport.loopToggle`, plus the media keys listed above. These run through `desktop:command` with `source: 'global'`. Only commands with `global: true` run this way: `transport.playStop`, `transport.again`, `transport.loopToggle`, `transport.stop` and `nav.nextSection`.

---
## 4. `hasRealMap` and the bar/time helpers

### 4.1 `shared/song-map.ts` additions
```ts
export const ORIGINS = ['detected', 'tapped', 'imported', 'edited'] as const;
export type Origin = typeof ORIGINS[number];
export type SongMapData = {version: 1; measures: Measure[]; pins: Pin[]; tailQpm?: number; origin?: Origin};

export function hasRealMap(tempo: unknown, {hasPart = false}: {hasPart?: boolean} = {}): boolean
export function barsOf(data: SongMapData, duration: number): Bar[]            // pure; SongMapStore.bars caches it (§4.3)
export function sectionsOf(data: SongMapData, duration: number): Section[]    // pure; same rules as SongMapStore.sections
export function mapSummaryOf(tempo: unknown, duration: number, {hasPart = false} = {}):
  {real: boolean, bpm?: number, meter?: string, sections: string[] /* names, ≤ 64 */}
```
The server computes summaries **only** through these functions and `shared/practice.ts#summarize`. BK1, BK3 and BK5 each upsert `songPractice` inline (it is two lines), so no Convex helper module is shared between same-wave packages.
`hasRealMap` returns true when the **first** matching rule holds, and false when none does:
1. `cleanSongMap(tempo?.songMap)?.origin` is set.
2. `hasPart` is true. The caller passes `song.hasChart` (B1), or `notation.hasNotation` in a session. `part.editor` existing is **not** evidence, because a missing part still creates an editor.
3. A valid stored `songMap` without `origin` (1.6–1.9 saves) that has any of:
   - more than one pin;
   - any non-empty measure label, ignoring the label `'Pickup'` on measure 0 (written by `fromBeats`, `song-map.ts:246`);
   - one pin that is not the placeholder: pin time ≠ 0, or `tailQpm` present and ≠ 120, or any measure that is not a full 4/4 with default grouping.
4. No valid `songMap` at all, and either `tempo.source === 'detected'` with `tempo.detected.length ≥ 2`, or a non-empty legacy `tempo.map`.

`tempo.source`/`tempo.detected` are **ignored whenever a `songMap` exists**: the old dual-write made them noise.

**`cleanSongMap`** copies `origin` only when it is in `ORIGINS`; an unknown value is dropped silently and never fails the map. **`validateSongMap`** rejects an unknown `origin`. No constructor returns an origin; callers stamp it.

**One-way upgrade (in `SongMapStore.load`):**
- rule 3 holds → `origin = 'edited'`;
- a legacy `detected` translation (`fromBeats`) → `origin = 'detected'`;
- a legacy `map` translation (`fromSections`) → `origin = 'edited'`;
- the placeholder (`defaultSongMap`) → no origin.

The upgraded map is written on the next tempo save. The `legacy` field, its constructor option and every branch that reads it are deleted (`song-map.js`, `metronome.js:33-35,62`, `tempo-sources.js:148,171`). `metronome.serialize()` returns `{accent, volume, countIn, countInLength, countInUnit, audiblePreRoll, enabled, songMap}` only.

### 4.2 `SongMapStore` changes (`src/js/song-map.js`)
```js
constructor(data, duration)                 // no legacy option
static fromTempo(tempo, duration)
setDuration(seconds)                        // re-normalises (keeping notation bars) and clears the caches; the session calls it after decode
get isReal() → boolean                      // !!this.data.origin || this._hasPart   (set via setHasPart(bool) by the notation session)
setHasPart(bool)
edit(change, reason, {origin} = {})         // origin defaults from REASON_ORIGIN[reason]
replace(next, reason)                       // 'tempo-source' → origin 'imported'
replaceFromBeats(beats)                     // origin 'detected'
replaceFromTimeline(timeline)               // origin 'imported'
adopt(data)                                 // keeps a valid origin; stamps 'imported' when none (drum-part adoption)
beginBatch(), endBatch(), undo(), redo()    // unchanged semantics; origin is part of the data, so undo restores it
```
- `REASON_ORIGIN`: `pin, nudge, renumber, meter, unpin, ramp, tempo, scale, bar, drag, label, sections` → `edited`; `tap, tapBeat` → `tapped`; `detect` → `detected`; `tempo-source, timeline, adopt` → `imported`.
- `edit` stamps the origin **only** when the change differs from the current data, ignoring `origin`; a no-op never creates an undo step.
- A label-only edit (`reason` `label` or `sections`) does **not** cancel an active count-in (fixes `maps/mapedit.md` §12.7). `Metronome` subscribes with `cancelCountIn = reason !== 'label' && reason !== 'sections'`.

### 4.3 Bar/time helpers (cached on `SongMapStore`, invalidated in `_set` and `setDuration`)
All times are media seconds. All bar indexes are 0-based measure indexes. **Display bar numbers** are 1-based and skip a pickup: when measure 0 is shorter than full (a pickup), it displays as "Pickup" and measure 1 displays as bar 1; otherwise measure 0 displays as bar 1. `displayBar(index) = pickup ? index : index + 1`.

```js
get bars() → Bar[]
Bar = {index, id, display: number|null /* null for a pickup */, q0, q1, t0, t1, numerator, denominator,
       groups: number[] /* beatGroups(m): units per counted beat */, units: number /* sum(groups) = numerator */,
       label: string /* '' if none */, pickup: boolean, meterChange: boolean /* differs from previous bar */,
       qpm: number /* at bar start */, bpm: number /* felt pulse, bpmAt */, tempoChange: boolean /* |bpm − prev.bpm| > 1 */}
```
Only bars with `t0 < duration` are listed. `t1` is clamped to `duration` for the last bar.

```js
get sections() → Section[]
Section = {index, label, name /* display: duplicates numbered 'Chorus', 'Chorus 2' */, startBar, endBar /* inclusive */, t0, t1, bars}
get hasSections() → boolean
```
**Sections** are built from the bars, in order:
- Every bar with a non-empty label starts a section, except measure 0's auto `'Pickup'` label, which is ignored.
- When at least one label exists and bar 0 is unlabelled, a leading section named **"Start"** covers bars 0 up to the first labelled bar.
- When no labels exist, `sections = []` and `hasSections = false`.
- A section's `t1` is the next section's `t0`, or the end of the last bar.

```js
sectionAt(t) → Section|null                  // t0 ≤ t < t1; t is clamped to [0, duration); null when !hasSections
nextSection(t) → {section, barsUntil, beatsUntil, timeUntil}|null
//   barsUntil = section.startBar − barIndexAt(t)   (≥ 1)
//   beatsUntil = R = the number of counted-beat onsets o with t < o ≤ section.t0 (the section's downbeat included)
//   timeUntil = section.t0 − t
barIndexAt(t) → index                        // binary search over bar t0s; before bar 0's t0 → 0
barBeatAt(t) → BarBeat
BarBeat = {index, display: number|null, pickup: boolean, before: boolean /* t < first downbeat, beyond the pickup */,
           groupIndex: number /* 0-based counted beat */, beat: number /* 1-based display beat */, groups, units,
           unitIndex: number /* 0-based meter unit, for lamps (D15) */, phase: number /* 0..1 inside the counted beat */,
           downbeat: boolean /* groupIndex === 0 && !pickup */}
```
**Pickup numbering:** inside a pickup bar, `beat` counts from the end of the bar exactly as `beatsOf` does: a 2-beat pickup in 4/4 reads beats 3 and 4. Before bar 0's start (t < `timeAt(0)`), the model extrapolates backwards using bar 0's meter (or the first full bar's meter when bar 0 is a pickup). It reports `before: true`, `display: null` and the beat numbered from the end, so the HUD shows `Pickup · 3`. It never returns bar 0 or "—" (this fixes `positionLabel`, which is deleted).

```js
beatGrouping(index) → {groups: number[], label: string /* '2+2+3' | '' when all 1 */, counted: number, units: number, lampMode: 'units'|'groups'}
//   lampMode 'groups' when units > 12 (D15)
downbeatAfter(t, {after = 1e-3} = {}) → {index, time}|null
//   the first bar start with time > t + after, excluding a pickup's start (not a downbeat); null when none before duration
barToTime(index, {group = 0, frac = 0} = {}) → number
//   timeAt(q0 + groupStartQ(group) + frac × groupLengthQ(group)); index is clamped to [0, bars.length]; index === bars.length → end of the last bar
timeToBar(t) → {index, q}                    // fractional position within the bar in quarters
phraseAt(t, n = 4) → {startBar, endBar}
//   inside a section: start = section.startBar + floor((i − section.startBar) / n) × n; end = min(start + n − 1, section.endBar)
//   without sections: aligned to the first downbeat bar (index 1 with a pickup, else 0)
refAt(t) → BarRef                            // {id: bars[i].id, beat: groupIndex, frac: phase}
timeOfRef(ref) → number|null                 // null when the id no longer exists; otherwise barToTime(i, {group: min(beat, last), frac})
snapTime(t, unit: 'bar'|'beat'|'unit', {mode = 'nearest'} = {}) → number   // 'nearest'|'floor'|'ceil'; uses bar t0s, group onsets or unit onsets
```
- **Performance:** `bars`, `sections` and a `Float64Array` of bar `t0`s are built once per data change. `barBeatAt` and `barIndexAt` are O(log n) and safe at 60 Hz. `nearestLine` and `spanAt` stay off the per-frame path.
- **Bar refs:** after any map change, `practice.reanchor(map)` moves a loop or spot that has `aBar`/`bBar` to `timeOfRef`. When a ref no longer resolves, the seconds are kept and the refs are dropped. No re-anchoring happens while `mapSession.auditioning` is true.

### 4.4 HUD text rules (exact)
| Readout | Mapped | Unmapped |
|---|---|---|
| Position main | `{display} · {beat}`; pickup or before: `Pickup · {beat}` | `m:ss` (floor) |
| Position sub | `{m:ss} / {m:ss}` in `--ink-3` | none |
| Section | `sectionAt(t).name`; hidden when there are no sections | the region (marker) label at t; hidden when there are no markers |
| Next | `barsUntil > 2`: `next: {name} · {barsUntil} bars` (`1 bar` singular). `barsUntil ≤ 2`: `{name} in {B} · {b}` in `--now`, where `R = beatsUntil`, `bpb` = counted beats of the current bar, `B = floor((R − 1) / bpb)`, `b = ((R − 1) mod bpb) + 1`; when `B === 0` it reads `{name} in {b}`, so the last beats count down like a count-in. Hidden at the last section. | `next: {label} · {m:ss of timeUntil}` when a later marker exists |
| Lamps | D15, from `barBeatAt(t)` | hidden |
| Speed sub | `{round(bpm at t × rate)} bpm` | none |
| Loop line 1 | `LOOP · {section name}` when `[a,b)` equals a section, else `LOOP` | `LOOP` |
| Loop line 2 | `Bars {x}–{y} · pass {n}`; trainer: `Trainer {start} → {end}% · step {i} of {n}`; call & response: `· listen` / `· you play` | `{m:ss.s}–{m:ss.s} · pass {n}` |
| Mix | `DRUMS OUT` (instrument names), `BASS SOLO`, `MIX` when changed without a single word, hidden for the full mix | same |
| Count-in plate | `Count-in · bar {display}` | `Lead-in · {m:ss}` |

### 4.5 Markers on unmapped songs
- `S` adds `{id, t: position, label: 'Marker {n}', updatedAt}`, where n = the live marker count + 1. The status line says "Marker {n} added — Rename".
- Markers are regions for the strip, Next, `[`/`]` and Again (`position.regions()`).
- **Turning markers into sections (Edit · Map banner):** one map edit with reason `sections`, then one practice patch that tombstones the converted markers. Each marker snaps to `snapTime(t, 'bar')`; when two markers land on the same bar, the first wins and the result reports `skipped`. The banner's Undo reverts both: the map edit through `map.undo()` and the practice patch through the practice undo stack, as one action.

### 4.6 `fromTaps` (Tap the beat, D22)
```ts
export function fromTaps(taps: number[] /* seconds, ≥ 4 */, duration: number, {numerator = 4} = {}): SongMapData
//   period P and phase φ by least squares over tap index k: t_k ≈ φ + kP (outliers |residual| > 0.35 P are dropped once, then refit)
//   first downbeat = φ (the first tap); pins at the first and last fitted taps (k = 0 and k = K) only; tailQpm = 60 / P
//   measures: numerator/4 bars from φ; bar 0 starts at φ (no pickup); normalize(duration); origin 'tapped'
```
The Tap sheet shows "≈ {60 / P rounded} bpm · {n} taps" live. The result reads "{bpm} bpm · 4/4 · first downbeat {m:ss.ss}" with [Use it] [Try again] [Open map editor]. [Use it] runs `map.replace(fromTaps(...), 'tapBeat')`, which is undoable.

---

## 5. Engine and metronome additions (spec §9.5, E1)

No rollout flags (owner decision). Every addition ships on. The single kill switch is `prefs.audio.safeMode` (D14). The transport reads it; the engine only exposes `minRate`.

### 5.1 New and changed members (`src/js/engine.js`)
| Member | Exact semantics |
|---|---|
| `on(type, fn) → off` | Event types: `'wrap'` `{when, a, b, pass: segmentPassIndex}`; `'gap'` `{when, until, target}`; `'ended'` `{reason: 'end'\|'stopAt'}`; `'interrupted'` `{state}`; `'transport'` (the same moments as `subscribeTransport`, which stays for `notation/audio.js`). Listeners run from the ticker, outside audio callbacks. |
| ticker | A 25 ms `setInterval` that runs while `playing` (started in `play`, cleared in `pause` and `destroy`). Each tick: (1) promote scheduled changes whose time has passed (`rate`, gains); (2) emit `wrap` and `gap` for boundaries with `when ≤ ctx.currentTime`, each exactly once, carrying the exact audio time; (3) schedule the next pass of a segmented loop when its start is ≤ 0.3 s away; (4) honour `stopAt`; (5) end detection: the old `tickEnd` moves here, and the public `tickEnd()` is deleted. |
| `nextWrapAt() → number\|null` | The audio time of the next arrival at `loop.b` in the current or pending segment. Gapless: `seg.when + (b − seg.offset)/seg.rate` for the first pass, then every `(b − a)/seg.rate`. Segmented: the current pass segment's `until`. `null` when the loop is off or not playing. |
| `whenAt(t) → number\|null` | The first future audio time at which the position reaches media time `t`, taking loop wraps into account. `null` when `t` is never reached (outside the loop range, or past the end). |
| `setSpeed(rate, {at} = {})` | The rate is clamped to `[minRate, 1.5]` (`minRate` defaults to 0.25 (E1); the transport sets 0.5 in safe mode). With no `at`, or `at ≤ now + lookahead`: today's behaviour. With a future `at`: append a scheduled segment `{when: at, offset: positionAt(at), rate, …, scheduled: true}` on both paths, through `_schedule(undefined, at, {rate})` (`_schedule` gains an optional `rate` override) without changing `this.rate`, and record `pendingRate = {rate, at}`. The ticker sets `this.rate = rate` once `currentTime ≥ at`. **Any other `_schedule` caller** (seek, loop edit, pitch change, immediate speed change) first drops scheduled segments and `pendingRate`, so pending changes never leak. A position projected exactly at a wrap boundary (within 1e-6 s of `b`) maps to `a`. |
| `setTrackGains(gains, {at} = {})` | `gains: {[trackName]: 0..1}`. Each track gets a new `auto` GainNode between `track.gain` and `master`, at 1 by default. `auto.gain.setValueAtTime(g, at ?? now)`. The user mix (`_applyGains`) is never touched. `pause()` and `stop()` reset every `auto` to 1. |
| `setLoop(enabled, a, b, {gapSec = 0, gap = 'silent'} = {})` | `gapSec = 0`: today's path, unchanged (gapless native `source.loop`, Signalsmith `loopStart`/`loopEnd`). **`gapSec > 0` (segmented):** native sources play one pass each (`loop = false`, `start(when, offset)`, `stop(until)`), and Signalsmith gets `loopStart = loopEnd = 0` with one `schedule({output: passWhen, input: a, rate})` per pass. The segment list holds a `pass` segment `{kind: 'pass', when, offset, until = when + (b − offset)/rate}`, then a gap `{kind: 'gap', when: until, until: until + gapSec/rate, target: a}`, then the next pass at `offset = a`. **`gap: 'silent'`:** `pitchGate` and master go to 0 for the gap, and the position reads `a` during it. **`gap: 'preroll'`:** the gap plays media `[a − gapSec, a)` (clamped at 0, silence before 0) as part of the next pass's native source (one source from `a − gapSec` to `b`), and the position reads `a − gapSec + (t − gap.when) × rate`. `wrap` fires at each pass's `until`; `gap` fires at each gap start. Changing `gapSec` while playing rebuilds from the current position. |
| `gapsBetween(t0, t1) → [{when, until, target}]` | Gap segments overlapping the window, used by the metronome for every-pass count-in clicks. |
| `beatsBetween` | Skips `gap` segments, so song clicks never fall inside a gap. |
| `seekAt(target, when)` | Quantized jump: `_schedule(target, max(when, now + lookahead))` as a pending segment carrying `seekOffset = target`. The audible segment continues until `when`. |
| `cancelPending()` | Removes every segment with `when > now` (stopping their not-yet-started native sources), then re-projects the current segment with `_schedule(undefined, now + lookahead)`. A pending seek is **not** carried over (unlike `_schedule`'s default). |
| `stopAt(when)` | Sets master gain to 0 at `when` and records `stopAtWhen`. When `currentTime ≥ when`, the ticker calls `pause()`, sets `pausedAt = positionAt(when − 1e-4)`, sets `paused = false` and emits `ended {reason: 'stopAt'}`. Any `_schedule` or `pause` clears it. |
| interruption | `ctx.onstatechange`: while `playing`, a state of `'interrupted'` or `'suspended'` → `pause()`, then emit `interrupted {state}`. It never resumes by itself. |
| `setMuted(name, on)`, `setSoloed(name, on)` | Idempotent setters (restore, undo, Minus me). `toggleMute`/`toggleSolo` stay, as thin wrappers. |
| `minRate` | A public field, 0.25. |
| deleted | `toggle()`, public `tickEnd()`. |

### 5.2 Metronome changes (`src/js/metronome.js`)
- **Construction:** `new Metronome(engine, songMap)` with the session's store, always injected. The internal default-store construction (metronome.js:35) is deleted.
- **Gap clicks:** `tick()` schedules count-in clicks inside every gap returned by `engine.gapsBetween(windowStart, windowEnd)`. It uses `countInPlanAt(gap.target)` (cached per `{a, countInLength, countInUnit, map revision}`) and places each beat at `gap.until − (plan.duration − beat.offset) / rate`. A `rest` gap longer than the plan clicks every counted beat of the rest bar at the loop-start tempo (accented downbeat) when Click ≠ Off.
- **Click modes:** `'off'` → `enabled = false, countIn = false`; `'countin'` → `enabled = false, countIn = true`; `'always'` → `enabled = true`. The transport maps Click and Count-in onto these.
- **Unmapped:** the transport never asks `countInPlan` when `!map.isReal` (Lead-in 2 s instead). `countInPlan` is unchanged.
- **Visual click:** `onBeat(fn) → off` emits `{when, downbeat, unit}` for every scheduled click. The HUD lamps flash with it, and the optional edge flash on downbeats (60 ms in, 180 ms out; with reduced motion, on/off only).
- **Serialisation:** `serialize()` no longer writes `source`, `map` or `detected`.
- **Deleted:** `beatsForView`, `metronome.source` (read in `entry.js:21`; that branch goes too).

### 5.3 Defaults
- Count in every loop pass: **on**, when count-in is on and looping (account `practice.eachPassCount`, default true).
- Between passes: None. Play N times: Off. Speed range: 25–150%.
- Safe mode: off. When on: `minRate = 0.5`, `gapSec` forced to 0, trainer steps applied on the wrap event (up to ≈25 ms late).

### 5.4 Test plan (fake clock; extends `tests/playback-engine.test.js`, plus `tests/stage-transport.test.js`)
Every case runs on **both paths**: native (`rate = 1`, or keep-pitch off) and Signalsmith (`preservePitch && rate ≠ 1`, asserting `stretch.schedule` calls).
1. `wrap` fires once per pass at `when + (b − offset)/rate` and then every `(b − a)/rate`; the lead-in before `a` fires its first wrap at the first arrival at `b`.
2. `nextWrapAt` and `whenAt` across a rate change, a pending seek and a loop disable.
3. `setSpeed(r, {at: nextWrapAt()})`: the rate changes exactly at the wrap; a seek or loop edit in between cancels it (no leaked segment); `this.rate` is promoted only after `at`.
4. Segmented loop, silent gap: pass segments and stops line up sample-exactly; the position reads `a` during the gap; `beatsBetween` returns no clicks inside gaps; `gapsBetween` reports each gap; count-in clicks land so the last beat ends at the pass start (metronome test).
5. Segmented loop, preroll gap: the source starts at `a − gapSec`, and before 0 the gap is silence.
6. `gapSec = 0` is byte-for-byte today's behaviour: the existing tests stay green unchanged.
7. `seekAt`: the audible segment continues until `when`; `cancelPending` restores continuity, and the pending seek is not applied.
8. `stopAt` at a wrap: `ended {reason: 'stopAt'}`, `pausedAt ≈ b`, no audio after `when` (master automation asserted).
9. `setTrackGains({drums: 0}, {at})`: automation on `auto` only; reset on pause.
10. `ctx.onstatechange('interrupted')` while playing → paused, event emitted, position kept.
11. E1: `setSpeed(0.25)` is accepted on both paths; safe mode → clamped to 0.5.
12. **Transport (fake engine and clock):**
    - Space from the loop start; stop returns to the cue; stay mode;
    - Again from each phase, with and without count-in;
    - count-in every pass (gap computed from the plan);
    - unmapped Lead-in 2 s with no clicks;
    - pass counting and resets (seek, stop, speed, loop edit, jump);
    - play N times stops at `b` and returns to the cue;
    - the trainer advances on schedule, completes, and stops on a manual speed change;
    - a quantized jump at the next downbeat, at a wrap that comes earlier, and cancel;
    - a jump outside the loop clears it (one undo step);
    - call & response alternates gains;
    - the smart loop toggle (section → phrase → ±5 s);
    - I/O snapping; move by length; Minus me mapping and fallbacks.
13. **Manual (release checklist, not gating):** listening checks on a real laptop and iPad for clicks at pass boundaries, drift over 10 minutes of segmented looping, comb filtering at trainer steps, and quality at 25–49% on the Signalsmith path.

---
## 6. Backend (Convex, companion, Electron main)

Follow `convex/_generated/ai/guidelines.md`:
- new indexes spell their fields (`by_userId_and_updatedAt`);
- new code uses the three-argument `ctx.db.patch('table', id, …)` / `ctx.db.get('table', id)`;
- every function has argument validators;
- queries never read the wall clock;
- reads are bounded (`.take(n)` or pagination).

### 6.1 Error codes (`convex/lib/errors.ts`, new)
```ts
export type Code =
  | 'not_signed_in' | 'account_suspended' | 'account_export_only' | 'not_found' | 'not_owner' | 'invalid'
  | 'device_unpaired' | 'device_revoked_admin' | 'device_other_account' | 'device_limit' | 'queue_full'
  | 'storage_full_user' | 'storage_full_app' | 'resplit_no_source' | 'resplit_wrong_device' | 'retry_wrong_device'
  | 'job_live' | 'job_not_failed' | 'practice_too_large' | 'setlist_limit' | 'setlist_full' | 'pins_full'
  | 'lookup_unavailable' | 'lookup_busy' | 'artwork_expired';
export function fail(code: Code, message: string, data: Record<string, unknown> = {}): never   // throw new ConvexError({code, message, ...data})
```
- Every user-reachable `throw new Error(...)` in `jobs.ts`, `worker.ts`, `devices.ts`, `storage.ts`, `songs.ts`, `settings.ts`, `lib/auth.ts`, `setlists.ts` and `metadata*.ts` becomes `fail(code, sameMessage)`.
- Messages are kept, so Details shows them.
- `ConvexError` data survives production redaction, which plain `Error` messages do not.

Job `errorCode` values, set by the companion and Python (§6.10): `bot_check`, `unavailable`, `not_found`, `unreadable`, `source_missing`, `disk_full`, `separation_failed`, `storage_full`, `account_paused`, `sync_failed`, `beats_unavailable`, `playlist`, `unknown`.

### 6.2 Schema changes (`convex/schema.ts`; all in BK0)
```ts
// shared validators (convex/lib/validators.ts, new)
export const barRefValidator = v.object({id: v.string(), beat: v.number(), frac: v.optional(v.number())});
export const practiceSummaryValidator = v.object({
  loopLabel: v.optional(v.string()), rate: v.number(), minusMe: v.boolean(), surface: v.optional(v.string()),
  spotCount: v.number(), spots: v.array(v.object({id: v.string(), name: v.string(), rate: v.number()})),   // ≤ 3
});
export const mapSummaryValidator = v.object({
  real: v.boolean(), bpm: v.optional(v.number()), meter: v.optional(v.string()), sections: v.array(v.string()),   // ≤ 64
});
export const metadataCandidateValidator = v.object({   // the shape metadataLookup's candidate() already returns
  recordingId: v.string(), releaseId: v.optional(v.string()), title: v.string(), artist: v.optional(v.string()),
  album: v.optional(v.string()), year: v.optional(v.string()), duration: v.optional(v.number()), coverUrl: v.optional(v.string()),
});

songs: defineTable({
  ...existing,
  practice: v.optional(v.any()),                       // read-only after B1 backfill; field removed in wave 4 (V1)
  hasChart: v.optional(v.boolean()),
  lastPracticedAt: v.optional(v.number()),
  practiceSummary: v.optional(practiceSummaryValidator),
  mapSummary: v.optional(mapSummaryValidator),
  tempoRev: v.optional(v.number()),
  metadataSuggestion: v.optional(metadataCandidateValidator),
  needsReview: v.optional(v.boolean()),                // B4: unconfirmed search source; G6 untitled upload
  resolvedUrl: v.optional(v.string()), provider: v.optional(v.string()),
  originDeviceId: v.optional(v.id('devices')),
}) /* indexes unchanged */,

songPractice: defineTable({songId: v.id('songs'), userId: v.string(), practice: v.any(), updatedAt: v.number()})
  .index('by_songId', ['songId']),

setlists: defineTable({
  userId: v.string(), name: v.string(), songIds: v.array(v.id('songs')),   // ≤ 100
  createdAt: v.number(), updatedAt: v.number(), lastOpenedAt: v.optional(v.number()),
}).index('by_userId_and_updatedAt', ['userId', 'updatedAt']),

devices: defineTable({
  ...existing, displayName: v.optional(v.string()), revokedBy: v.optional(v.union(v.literal('user'), v.literal('admin'))),
}),

devicePresence: defineTable({
  deviceId: v.id('devices'), userId: v.string(), lastSeenAt: v.number(),
  state: v.union(v.literal('idle'), v.literal('busy'), v.literal('offline')),
  currentJobId: v.optional(v.id('jobs')), appVersion: v.optional(v.string()), platform: v.optional(v.string()), accelerator: v.optional(v.string()),
}).index('by_deviceId', ['deviceId']).index('by_userId', ['userId']),

jobs: defineTable({
  ...existing, errorCode: v.optional(v.string()), retryAt: v.optional(v.number()), startedAt: v.optional(v.number()),
  chainedFrom: v.optional(v.id('jobs')),
}),
```
`userSettings.settings` stays `v.any()`. Its shape is enforced by `settings.patch` validators (§6.5).

### 6.3 `convex/songs.ts` and `notation.ts` (BK1: B1, B2, plus the rest of songs)
| Function | Kind | Args | Behaviour |
|---|---|---|---|
| `list` | query | `{}` | `by_user_added` desc `.take(1000)` → `toListRow(song)`: id, title, artist, album, albumArtist, uploader, duration, addedAt, stemMode, stems (name, key, bytes, mime), coverKey, coverUrl, artwork, source, quality, year, genre, trackNumber, discNumber, musicalKey, tuning, tags, metadataStatus, `needsReview` (stored flag, or `source.type === 'upload' && !artist && title === basename(filename)`), `suggestion` (title, artist, album, releaseId from `metadataSuggestion`), hasChart, mapSummary, lastPracticedAt, practiceSummary. **No** notes, tempo, practice, metadataLocks or recording/release ids. |
| `get` | query | `{id}` | `toClient(song)` (full) + `practice` from `songPractice.by_songId` (falling back to `songs.practice`) + `tempoRev`. Owner only, else null. |
| `getMany` | query | `{ids: v.array(v.id('songs'))}` (1–100) | The owner's songs as `toClient` (bulk Details, G9); missing or foreign ids are omitted. |
| `savePractice` | mutation | `{id, practice: v.any()}` | `requireOwned`. Rejects with `practice_too_large` when `JSON.stringify(practice).length > PRACTICE_CAP` (32,768, **B2**). Upserts `songPractice` (`sameContent` no-op). Computes `summary = summarize(upgradePractice(practice), sectionsOf(song.tempo))`, and patches `songs` with `{practiceSummary, lastPracticedAt: practice.lastAt}` **only when either changed**, so most saves never touch the `songs` row (R3). |
| `saveTempo` | mutation | `{id, tempo: v.any(), baseRev: v.optional(v.number())}` | `requireOwned`. If `baseRev !== (song.tempoRev ?? 0)` and `hasRealMap(song.tempo) && !hasRealMap(tempo)`: keep the stored `songMap`, merge only the click settings, write, and return `{tempoRev, conflict: true, tempo: merged}`. Otherwise write. Either way bump `tempoRev`, recompute `mapSummary` (real, bpm at bar 1, meter of bar 1, section names ≤ 64), and return `{tempoRev, conflict: false}`. No-op (no bump) when `sameContent`. |
| `remove` | mutation | `{id}` | Unchanged entry. `deleteSongData` also deletes the `songPractice` row, strips the id from the user's setlists (`by_userId_and_updatedAt`, ≤ 100 rows) and from `userSettings.settings.pins`. Billing cleanup inherits this. |
| `markReviewed` | mutation | `{id}` | Clears `needsReview` (Stage "Is this the right recording? [Yes]"). |
| `exportPage` | query | unchanged args | Full `toClient` + practice joined from `songPractice` (export ZIP). |
| `rename` | — | — | **Deleted.** |
| `migrations.backfillB1` | internalMutation | `{cursor: v.union(v.string(), v.null())}` | Paginates `songs` 50 at a time. For each song: move `practice` → `songPractice` (pruned to the cap with `prunePractice`), compute `practiceSummary`, `lastPracticedAt`, `mapSummary`, and `hasChart` (`notationParts.by_songId` → `hitCount > 0`). Then reschedule itself with `runAfter(0)` until done. Started from the dashboard or `npx convex run migrations:backfillB1 '{"cursor":null}'`. |

`notation.ts`: `save` sets `songs.hasChart = hitCount > 0 || anyReviewed` when it changes. `deletePart` callers clear it.

### 6.4 `convex/jobs.ts` (BK2)
| Function | Change |
|---|---|
| `listActive` | Reads `by_user_status` once each for `queued`, `running` and `error` (`.take(50)` each) instead of newest-50-then-filter. Each row is today's fields plus `deviceId, createdAt, startedAt, updatedAt, attempts, errorCode, retryAt, chainedFrom, source {type, value, filename}, settingsSummary {preset, stemMode, model}`. Rows are sorted by `createdAt`. |
| `createSeparation` | Args gain `meta: v.optional(v.object({title: v.optional(v.string()), channel: v.optional(v.string()), duration: v.optional(v.number()), thumbnail: v.optional(v.string()), provider: v.optional(v.string())}))`. Strings are ≤ 300; `thumbnail` must be `https:` and ≤ 2000. It is stored as `job.meta` (B4). `settings.stemMode === 'six'` is kept in `job.settings` (normalised at claim). An upload source requires `deviceId` = the caller's chosen device, which is stored for `originDeviceId`. A re-split of an upload-sourced song with `deviceId !== song.originDeviceId` (when that is set) → `fail('resplit_wrong_device', …, {deviceName})` (D38). Returns `{jobId}`. |
| `createBeatDetection` | Dedupe: if a queued or running beats job exists for the song (`by_song`), return it instead of inserting. |
| `retry` | Resets `stage: 'queued', percent: 0, errorCode: undefined, retryAt: undefined, message: 'Resuming local files…'`. Keeps the same-device rule (`retry_wrong_device`). |
| `cancel`, `dismiss`, `get` | Coded errors only (`job_live`, `job_not_failed`). |

### 6.5 `convex/settings.ts` and `lib/presets.ts` (BK4)
```ts
export const profileValidator = v.object({
  instruments: v.array(v.union(...INSTRUMENTS.map(v.literal))),   // ≤ 6, deduplicated
  primary: v.union(v.null(), ...INSTRUMENTS.map(v.literal)),
  openWithMyPart: v.union(v.literal('in'), v.literal('out')),
});
export const practiceDefaultsValidator = v.object({
  stop: v.union(v.literal('cue'), v.literal('stay')),
  countIn: v.object({on: v.boolean(), length: v.number() /* 1–16 */, unit: v.union(v.literal('bars'), v.literal('beats'))}),
  eachPassCount: v.boolean(), keepPitch: v.boolean(),
  wake: v.union(v.literal(5), v.literal(10), v.literal(30), v.literal('always')),
});
patch = mutation({args: {patch: v.object({
  preset: v.optional(v.string()), stemMode: v.optional(v.string()), bitrate: v.optional(v.number()),
  custom: v.optional(v.object({model: v.string(), shifts: v.number(), overlap: v.number()})),
  autoBeats: v.optional(v.boolean()), notifyReady: v.optional(v.boolean()),
  profile: v.optional(profileValidator), pins: v.optional(v.array(v.id('songs'))),   // ≤ 12, deduplicated, owned
  onboarding: v.optional(v.object({whatDoYouPlay: v.optional(v.union(v.literal('done'), v.literal('skipped'))),
                                   coach: v.optional(v.number()), desktopFirstRun: v.optional(v.boolean())})),
  practice: v.optional(practiceDefaultsValidator.partial()),
})}, handler: /* requireUserId (D10: export-only allowed); deep-merge onto withDefaults(row.settings); validate enums/caps; replace row */});
demo = query({args: {}, handler: () => /^[a-f0-9]{64}$/.test(env.DEMO_SHARE_TOKEN ?? '') ? {token: env.DEMO_SHARE_TOKEN} : null});   // B8
```
- `settings.save` is deleted (D42).
- `config` returns `withDefaults(settings)`, now including `autoBeats: true, notifyReady: true, profile {[], null, 'in'}, pins [], onboarding {}, practice {stop: 'cue', countIn: {on: false, length: 1, unit: 'bars'}, eachPassCount: true, keepPitch: true, wake: 10}`. `withDefaults` deep-merges `custom`, `profile`, `onboarding` and `practice`.
- `convex.config.ts` declares `DEMO_SHARE_TOKEN: v.optional(v.string())`.
- **`presets.ts`:**
  - add `STEM_MODES.six = {id: 'six', label: 'Full band + guitar & piano · 6', twoStems: null}`;
  - `resolveQuality` forces `model: 'htdemucs_6s'` for `six`, keeping the preset's shifts and overlap;
  - `expectedStems('six')` returns the 6 names;
  - delete `format` from `DEFAULT_SETTINGS` (`qualityValidator.format` stays for stored songs);
  - delete the Modal-era `estCostUsd` comment.

### 6.6 `convex/worker.ts`, `devices.ts`, `storage.ts`, `admin.ts` (BK3: B4, B5, B6)
| Function | Kind | Change |
|---|---|---|
| `worker.next` | query (device) | Returns the device's first `running` job; else, among queued `.take(20)` by `by_device_status`, the first `kind === 'beats'`; else the first queued job (B6 prioritisation). |
| `worker.claim` | mutation | Sets `startedAt` on the first claim and increments `attempts`. Returns `chainedFrom`, and `settings` with `stemMode: 'six'` normalised to `'full'`, so Python never sees `six`. |
| `worker.progress` | mutation | Args gain `errorCode: v.optional(v.string())` and `meta: v.optional(jobMetaValidator)`. On `stage: 'error'` with `errorCode === 'bot_check'` and `attempts < 3`: `status: 'error'`, `retryAt = now + 5 min × 2^(attempts − 1)`, and `scheduler.runAt(retryAt, internal.worker.autoRetry, {jobId, attempts})`. |
| `worker.autoRetry` | internalMutation | `{jobId, attempts}`: re-queues (the same resets as `jobs.retry`) only if the job is still `error` with the same `attempts`. |
| `worker.finish` | internalMutation | Result validator gains `resolvedUrl: v.optional(v.string())` and `provider: v.optional(v.string())`. New songs store `resolvedUrl`, `provider` and `originDeviceId: job.deviceId`, plus `needsReview: true` when `job.source.type === 'search'` without `job.meta.title` (unconfirmed). Imports compute `practiceSummary`/`mapSummary` and write `songPractice` from `importMeta`. **B6 chain:** when `kind === 'separate'`, `withDefaults(job.settings).autoBeats`, the device is valid and `!hasRealMap(song.tempo, {hasPart: song.hasChart})`, insert `{kind: 'beats', userId, deviceId, songId, label: 'Finding bars — <title>', chainedFrom: job._id, status: 'queued', stage: 'queued', percent: 0, createdAt, updatedAt}`. |
| `worker.beatsDone` | mutation | Sets `stage: 'done'` and keeps `result`. When the song still has no real map: `tempo = {...settings-only(song.tempo), songMap: {...fromBeats(beats, duration), origin: 'detected'}}`; bump `tempoRev`; recompute `mapSummary`. |
| `worker.heartbeat` | mutation (device token) | `{token, state: 'idle'\|'busy'\|'offline', currentJobId?, appVersion?, platform?, accelerator?}` → upsert `devicePresence` by `deviceId` with `lastSeenAt: Date.now()`. |
| `worker.cancelForUpdate` | — | **Deleted** (D12). |
| `devices.list` | query | Caller's non-revoked devices (`by_user`, ≤ 20) joined with presence: `[{deviceId, name: displayName ?? name, platform, appVersion, lastSeenAt: number\|null, state, currentJobId, queued /* by_device_status queued .take(21) length */}]`, ordered by `lastSeenAt` desc. The client computes online as `state !== 'offline' && now − lastSeenAt < 150 000` and re-evaluates every 30 s. |
| `devices.rename` | mutation | `{deviceId, name}` (1–80 after trim) → `displayName`. |
| `devices.revoke` | mutation | Owner: `revoked: true, revokedBy: 'user'`. |
| `devices.pair` | mutation | Refuses `revokedBy === 'admin'` with `fail('device_revoked_admin', 'This computer was disconnected by an administrator.')`. A user-revoked device re-pairs (it un-revokes). The name refreshes from the friendly name on every pair. Coded errors throughout. |
| `admin.account` / `admin.revokeDevice` | — | Device rows add `lastSeenAt` and `revokedBy`; revoke sets `revokedBy: 'admin'`. |
| `storage.*` | — | `fail('storage_full_user', …)` / `fail('storage_full_app', …)` and the other coded errors. |

### 6.7 `convex/sharing.ts`, `shareAudio.ts` (BK5: B8 support)
- `practiceSettings` becomes `sanitizeForShare(upgradePractice(practice))`. Practice is read from `songPractice` first, so v1 and v2 sources both share loops, spots and markers.
- `tempoSettings` keeps `cleanSongMap`, which now carries `origin`.
- `finishImport`:
  - writes the copied practice into `songPractice`;
  - sets `practiceSummary`/`mapSummary`, `hasChart` (when `notationPartId` exists) and `tempoRev: 0` on the new song.
- `sharing.view` returns `ownerName` (the owner's `users.name` first word) for "Shared by Kyle K." It never returns an email.
- Update `convex/sharing.test.ts:29,45,69` for the v2 snapshot.

### 6.8 `convex/setlists.ts` (BK6: B3)
| Function | Kind | Auth | Args | Behaviour |
|---|---|---|---|---|
| `list` | query | `getUserId` → `[]` | `{}` | `by_userId_and_updatedAt` desc `.take(100)` → `[{id, name, count, songIds, updatedAt, lastOpenedAt}]` |
| `get` | query | owner or null | `{id}` | `{id, name, songIds}` |
| `create` | mutation | writable | `{name, songIds?: v.optional(v.array(v.id('songs')))}` | Name 1–80 after trim; ≤ 100 lists (`setlist_limit`); ≤ 100 songs; every id owned; returns the id |
| `rename` | mutation | writable + owner | `{id, name}` | |
| `setSongs` | mutation | writable + owner | `{id, songIds}` | Replaces the order; deduplicated; owned; ≤ 100 |
| `addSongs` | mutation | writable + owner | `{id, songIds}` | Appends ids not present; past 100 → `setlist_full` |
| `remove` | mutation | writable + owner | `{id}` | |
| `touch` | mutation | owner | `{id}` | Sets `lastOpenedAt` (opening `/set/:id` or `?set=`) |

Cleanup lives in `deleteSongData` (§6.3). The export ZIP adds `setlists.json` (SE2).

### 6.9 Metadata (BK7: D6)
- **`shared/metadata.ts`:** `LIMITS`, `LABELS`, and `validateField(key, raw) → {value} | {error, field}` with labelled copy ("Album artist is too long (500 characters max)."). `convex/lib/songMetadata.ts#cleanMetadata` wraps errors as `fail('invalid', message, {field})`. Tag dedupe becomes case-insensitive.
- **`metadata.update`** `{ids, changes, unlock?: v.optional(v.array(v.string())), match?: v.optional(v.object({recordingId: v.string(), releaseId: v.optional(v.string())}))}`:
  - G1: keys whose cleaned value equals the stored value are skipped (no patch, no lock, no id clearing);
  - G2: `unlock` keys are removed from `metadataLocks` after patching;
  - G4: `match` (single id only, MBIDs validated) sets `metadataStatus: 'matched'` and the ids *after* the clearing rule;
  - any title or artist change clears `metadataSuggestion`.
- **`metadata.updateEach`** `{items: v.array(v.object({id, changes, unlock: v.optional(v.array(v.string()))}))}` (≤ 100, atomic; bulk Revert).
- **`metadata.confirm`** `{id}`: `metadataStatus: 'matched'`; identity keys present (title, artist, album, albumArtist, year, trackNumber, discNumber, plus artwork when set) are added to `metadataLocks`; clears `metadataSuggestion` and `needsReview`.
- **`metadataLookup.retry`** `{id}` (owner): re-schedules `enrich` through the existing `requestSlot`. **`enrich`** stores `metadataSuggestion` when no recording is strong but `found.length > 0` (G5; no extra MusicBrainz call).
- **Status copy** (client): `pending` "Finding song details…" · `matched` "Matched on MusicBrainz" · `uncertain` with a suggestion "Not sure this is right" · `uncertain` without one "No match found" · `unavailable` "Couldn't reach MusicBrainz" [Try again].

### 6.10 Companion (CPA, CPB)
**CPB: processing core** (`process.py`, `pipeline.py`, `errors.py`, `server.mjs`; package CPB, wave 1):
1. **Error codes:** `errors.py` exports `classify(detail: str, *, stage, source_type) → code` (rules: `maps/companion-desktop.md` §10.2). Python prints `{"error": detail, "code": code}`. `server.mjs` keeps `event.code` and passes `errorCode` to `worker.progress`. Companion-side failures throw a `CodedError(code)`: `source_missing`, `storage_full` (from the coded Convex error), `account_paused`, `sync_failed`.
2. **Throttle:** always send on a stage change, on a message change at percent 0, and the final event before exit. Within a stage, send at most every 2 s with a trailing flush.
3. **Developer hint:** "Run npm run companion:setup first." appears only when `!process.env.WOODSHED_PROCESSOR`. The stderr tail goes to `error` (Details), never as the sentence.
4. **`/status`** returns `{name: WOODSHED_DEVICE_NAME ?? hostname, connected, deviceId, userId, busy, accepting, job: {id, stage, percent}|null, modelsReady: {[model]: bool}, version}`. `modelsReady` checks `TORCH_HOME/hub/checkpoints` against Demucs' `remote/files.txt`.
5. **First-run model download:** a `Downloading: "….th"` line emits `separate 0` "Downloading the separation model (first run)…", and tqdm bars report under it until "Separating track". `mdx_extra` counts as 4 models.
6. **Meta:** after acquisition, emit `{"meta": {title, artist, uploader, duration, thumbnail}}` once. `server.mjs` forwards it unthrottled as `progress({meta})`. The result gains `resolvedUrl` and `provider` (`extractor_key`).
7. **Beats (B6):** `claim` returns `chainedFrom`. When `<account>/jobs/<chainedFrom>/source.wav` exists, it is passed as `job.localMix` and resampled directly (`-ar 22050 -ac 1`); otherwise stems are downloaded as today. Progress: `detect 5` "Fetching audio…", `20` "Building a mix locally…", `50` "Finding bars…", `95` "Saving bars…".
8. **Heartbeat (B5):** `worker.heartbeat` on connect, every 60 s (`setInterval(...).unref()`), at job start and end, and with `state: 'offline'` on shutdown (raced against 1 s). A failure is logged and never stops a job. Electron passes `WOODSHED_APP_VERSION`, `WOODSHED_PLATFORM` and `WOODSHED_DEVICE_NAME` in the fork env.
9. **Updates (D12):** delete the `update-cancellation.json` write and replay (server.mjs:53-58, 238-245). Shutdown for an update just stops; the next launch resumes the `running` job.
10. **Tests:** `companion/test_errors.py` (classification on recorded yt-dlp, ffmpeg and separator outputs; first-run lines are not passes; `mdx_extra` pass count).

**CPA: lookup (B4)** (`lookup.mjs`, `ytdlp-args.json`, `server.mjs` routes, `src/js/companion.js` client; package CPA, wave 0B):
```
GET /resolve?url=…   → 200 {kind: 'url'|'spotify', query?, candidates: Candidate[]}   (playlist → 422 {code:'playlist'})
GET /search?q=…&n=5  → 200 {query, provider: 'youtube'|'soundcloud', candidates: Candidate[]}
Candidate = {url, id, title, channel, duration: number|null, thumbnail: string|null, provider: 'youtube'|'soundcloud'|'other', live: boolean}
errors: 503 bot_check · 404 unavailable|not_found · 422 playlist · 504 timeout (20 s) · 400 invalid   (JSON {error, code})
```
- **Placement:** the routes sit **before** the identity recheck (server.mjs:187-189); origin, host and bearer checks still apply. URLs are parsed with `new URL(req.url, 'http://127.0.0.1')`.
- **yt-dlp:** one `ytDlp(args, {signal})` helper. Frozen builds run `WOODSHED_PROCESSOR --module yt_dlp …`; dev runs `python -m yt_dlp …`. Base args come from `ytdlp-args.json`, shared with `pipeline.py`, which reads the same file. Search: `--flat-playlist --dump-single-json --skip-download ytsearch<n>:<q>`, falling back to `scsearch<n>:` on a bot check. Resolve: `--dump-single-json --skip-download -- <url>`. Spotify: oEmbed `title` (+ `author_name`) → search.
- **Limits:** one in-flight lookup per route (a new request aborts the previous child); an LRU of 50 entries with a 10 min TTL; the child is killed on request close.
- **`src/js/companion.js` gains:**
  ```js
  request(path, {method, body, signal, timeoutMs})   // AbortSignal.any([signal, AbortSignal.timeout(timeoutMs ?? 30000)])
  resolveSource(url, {signal}) → Promise<ResolveResult>
  searchSources(q, {n = 5, signal}) → Promise<SearchResult>
  uploadXHR(file, {signal, onProgress}) → Promise<{id}>   // XHR POST /upload, Content-Type application/octet-stream,
                                                          // X-Filename encodeURIComponent(name), Authorization Bearer
  status() → Promise<Status>
  ```
  The stale copy "Retry the desktop connection in Settings" and the `ws.companion` cleanup line are deleted.
- **Tests:** `companion/lookup.test.mjs` (flat-entry mapping, playlist rejection, Spotify fallback, bot-check fallback, LRU) using `companion/fixtures/ytdlp/*.json`. `package.json` gains `"test:companion": "node --test companion/*.test.mjs"`.

### 6.11 Electron main and preload (DT1)
1. **Static server (D9):** serve `path.join(webRoot, decodeURIComponent(pathname))` when it is a file inside `webRoot` (the traversal guard is kept), else `index.html`. The MIME map adds `.webmanifest` → `application/manifest+json`, `.txt` → `text/plain; charset=utf-8`, `.wasm` → `application/wasm`, `.png`, `.ico`. Covered by `desktop/static-server.test.cjs`.
2. **Processor state:** `processorState = {phase: 'starting'|'ready'|'stopped'|'restarting', exitCode?, message?}` on `desktop:processor-state`, also returned in `info().processor`. The update-channel error at main.cjs:57 is deleted. `desktop:restart-processor` → `stopCompanion()`, then `startCompanion()`, returning the new `{port, token}`.
3. **Menu:** `desktop/menu.cjs` (`validateMenuSpec`, `buildTemplate`, `fallbackTemplate`), `ipcMain.on('desktop:menu')`, `webContents.send('desktop:command', {id, source})` (§2.20). Covered by `desktop/menu.test.cjs`.
4. **Activity:** `desktop:activity` `{playing, songOpen, keepAwake}`:
   - `keepAwake` starts or stops `powerSaveBlocker('prevent-display-sleep')`;
   - `songOpen` enables File → Close Song;
   - `playing` defers automatic update prompts. `update-controller.cjs#show(true)` returns early while playing, and the playing → stopped transition re-runs the focus prompt check.
5. **Global shortcuts:** `desktop:global-shortcuts` (§2.11). The setting is persisted in `userData/desktop-prefs.json` and registered at `whenReady`. Failures are reported. macOS media keys check Accessibility trust. `unregisterAll` runs on disable and on `will-quit`.
6. **Notifications:** `desktop:notify` validated (title ≤ 120, body ≤ 240, route `^/(s|edit|set)/[A-Za-z0-9_-]{1,64}(/.*)?$` or `/`). The notification shows only when `!win.isFocused()`; a click focuses the window and sends `desktop:navigate`. `app.setAppUserModelId('com.kylekincer.woodshed')` is set at startup.
7. **Flush:** `desktop:flush` → await `desktop:flushed` (3 s timeout). It runs after the quit-guard decision and in `install()` before stopping the companion.
8. **Window state:** `desktop/window-state.cjs` (`maps/companion-desktop.md` §16.9) with `desktop/window-state.test.cjs`. `desktop:fullscreen` events.
9. **Permissions:** `setPermissionRequestHandler` allows `midi` (no sysex), `clipboard-read`, `clipboard-sanitized-write` and `fullscreen` for `UI_ORIGIN` only, and denies everything else.
10. **Fork env:** `WOODSHED_APP_VERSION`, `WOODSHED_PLATFORM` (`${process.platform}-${process.arch}`), and `WOODSHED_DEVICE_NAME` (macOS `scutil --get ComputerName`, else hostname without `.local`).
11. **Update copy (D12):** the restart prompt's busy detail reads "Song processing will pause and resume after the restart." `stopCompanion(true)` no longer cancels jobs.
12. **Smoke test:** `main.cjs --smoke-test` asserts `#app` and `html[data-startup]`, and no `#app-header` or `#sidebar`. This changes in integration I1, together with the new shell.
13. **Tests:** `update-controller.test.cjs` gains "playing defers automatic prompts" and "stop re-prompts". `decoded-stem-cache.test.cjs` keeps its import path, because the module does not move.

---
## 7. CSS, tokens, fonts, icons, guards

### 7.1 Layers and files
`src/styles/main.css` is imported first by `src/app/main.js` (`import '../styles/main.css'`). Its first statement is:
```css
@layer reset, tokens, base, primitives, layout, views, utilities;
@import './reset.css' layer(reset);
@import './tokens.css' layer(tokens);
@import './fonts.css' layer(tokens);
@import './base.css' layer(base);
@import './layout.css' layer(layout);
@import './utilities.css' layer(utilities);
```
- **There is no `legacy` layer (D1).** The old files are deleted in integration I1: `src/css/*.css`, `src/js/song-metadata.css`, `src/js/notation/{chart,notation,score-view}.css`.
- **Primitive and view CSS:** every primitive module imports `src/styles/primitives/<name>.css`, whose whole content is `@layer primitives { … }`. Every view module imports `src/styles/views/<area>/<name>.css`, whose whole content is `@layer views { … }`. Lazy chunks (chart, editor) therefore load their CSS into the declared layer, and the "Chart/Tracks nav flip" cannot recur.
- **Notation internals' CSS** (score, lanes, note list, print) moves to `src/styles/views/notation/{score-view,editor,lanes}.css` and is tokenised (ST3, ED5). Print rules live in `utilities.css` under `@media print` (`body > *:not(.notation-print){display:none !important}`), with `--print-ink`.
- **`reset.css`:** box-sizing, margin 0, `[hidden]{display:none !important}`, a `.hidden` alias, `img{max-width:100%}`, `button{font: inherit; touch-action: manipulation; -webkit-tap-highlight-color: transparent}`. The global `input[type=range]` styling does not exist; Slider and Fader are custom elements.
- **`base.css`:**
  - `html, body {height: 100%; overflow: hidden; background: var(--bg); color: var(--ink); font: var(--fs-16)/1.4 var(--font-ui)}`, and `#app {height: 100%}`. Each place has one `[data-scroller]` (D26).
  - The single focus rule: `:focus-visible {outline: 3px solid var(--focus-ring); outline-offset: 2px}`.
  - `user-select: none` on chrome; text content (titles, notes, details, the Details page, error details) is opted back in with `.selectable`.
  - Reduced motion: `@media (prefers-reduced-motion: reduce) { :root {--motion-fast: 0ms; --motion-enter: 0ms; --motion-nav: 0ms; --motion-slow: 0ms} }`. Components animate only through motion tokens.
- **`layout.css`:** the app frame (top-bar place vs full-bleed place), the content max width of 1280 px and gutters (32 laptop, 24 iPad), and safe-area insets.
- **`utilities.css`:** `.sr-only`, `.selectable`, `.tabular`, the print rules, and `!important` only here and in `reset.css`.

### 7.2 Tokens (`src/styles/tokens.css`; the only file with colour literals)
**Selectors:**
- `:root` = **paper**;
- `:root[data-theme=dark]` = **night**;
- `:root[data-place=stage][data-stage-theme=dark]` = **stage**.

`data-theme` is the resolved light/dark theme. `data-stage-theme` is `dark` when `prefs.stage === 'dark'` or the theme is dark, else `light` (then paper or night apply on the Stage). The Shared Stage is `data-place=stage`.

| Token | paper | night | stage |
|---|---|---|---|
| `--bg` | #f6f5f0 | #121615 | #08090a |
| `--surface` | #ffffff | #1a1f1e | #111414 |
| `--surface-2` | #efede6 | #232a28 | #191d1c |
| `--line` | #d9d6cc | #3a4441 | #2a302e |
| `--line-strong` | #b9b4a6 | #4c5753 | #3b4340 |
| `--ink` | #17201f | #eef0ea | #ffffff |
| `--ink-2` | #3f4a46 | #b9c2bd | #d3dad6 |
| `--ink-3` | #626d68 | #8b9692 | #9aa5a0 |
| `--accent` | #174bd1 | #8aafff | #9cbcff |
| `--accent-fill` | #174bd1 | #3d63d6 | #3d63d6 |
| `--on-accent` | #ffffff | #ffffff | #ffffff |
| `--accent-soft` | #e4eafb | #22304d | #1b2742 |
| `--now` | #c25700 | #ffb547 | #ffc14d |
| `--now-soft` | #ffe9d4 | #3a2b12 | #2e220e |
| `--loop` | #174bd1 | #8aafff | #7fa6ff |
| `--loop-fill` | rgb(23 75 209 / .10) | rgb(138 175 255 / .16) | rgb(127 166 255 / .18) |
| `--edit` | #6b45c4 | #b39bff | #b39bff (never used on the Stage) |
| `--out` | #626d68 | #8b9692 | #8b9692 |
| `--ok` | #2f7a4c | #80c79b | #80c79b |
| `--warn` | #8f5400 | #f3b77d | #f3b77d |
| `--danger` | #b13a30 | #ff8a7d | #ff8a7d |
| `--focus-ring` | #174bd1 | #9cbcff | #9cbcff |
| `--stem-drums` | #b85029 | #ed9870 | #f2b294 |
| `--stem-bass` | #347052 | #80c79b | #9cd3b1 |
| `--stem-vocals` | #174bd1 | #8aafff | #b3cbff |
| `--stem-other` | #5d6470 | #b4becd | #ccd3dd |
| `--stem-guitar` | #804759 | #d79db4 | #e3baca |
| `--stem-piano` | #3b7371 | #85c9c3 | #a1d6d1 |
| `--grid-beat` | color-mix(in srgb, var(--ink) 8%, transparent) | same | same |
| `--grid-bar` | color-mix(in srgb, var(--ink) 18%, transparent) | same | same |
| `--backdrop` | rgb(0 0 0 / .4) | rgb(0 0 0 / .5) | rgb(0 0 0 / .6) |
| `--print-ink` | #111111 | #111111 | #111111 |

The paper stems are the effective light values (record-club.css:2). The stage stems are night + 8% HSL lightness (computed).

**Set-independent tokens:**
```css
--s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px; --s8: 64px;
--r-control: 8px; --r-surface: 12px; --r-pill: 999px;                       /* covers stay 0 (literal 0 allowed) */
--h-sm: 32px; --h-md: 40px; --h-lg: 48px; --hit-handle: 24px; --hit-handle-visual: 8px;   /* fine pointers */
@media (pointer: coarse) { --h-sm: 44px; --h-md: 48px; --h-lg: 56px; --hit-handle: 44px; --hit-handle-visual: 20px; }
--h-dock: 64px; --h-play: 80px;                                             /* [data-stage-layout=rail]: 56px / 72px */
--z-under: -1; --z-base: 0; --z-local: 1; --z-local-2: 2; --z-sticky: 10; --z-overlay: 20; --z-popover: 30; --z-sheet: 40;
--z-dialog: 50; --z-toast: 60; --z-coachmark: 70; --z-drag: 80;
--shadow-sticky: 0 1px 0 var(--line); --shadow-overlay: 0 2px 8px rgb(0 0 0 / .18); --shadow-popover: 0 8px 24px rgb(0 0 0 / .18);
--shadow-sheet: 0 -8px 32px rgb(0 0 0 / .22); --shadow-dialog: 0 16px 48px rgb(0 0 0 / .24);
--motion-fast: 120ms; --motion-enter: 160ms; --motion-nav: 220ms; --motion-slow: 260ms; --ease: cubic-bezier(.2, .8, .2, 1);
--font-ui: 'Atkinson Hyperlegible Next', system-ui, -apple-system, 'Segoe UI', sans-serif;
--font-mono: 'Atkinson Hyperlegible Mono', ui-monospace, 'SF Mono', Menlo, monospace;
--fs-12: 12px; --fs-14: 14px; --fs-16: 16px; --fs-20: 20px; --fs-24: 24px; --fs-32: 32px;   /* desk scale */
--fw-regular: 400; --fw-semibold: 600; --fw-bold: 700; --fw-heavy: 800;
--distance: 1;                                                              /* [data-distance=near] .8, [data-distance=kit] 1.3 */
--fs-stage-identity: max(15px, calc(15px * var(--distance)));
--fs-stage-sub: max(15px, calc(17px * var(--distance)));
--fs-stage-loop: max(15px, calc(17px * var(--distance)));                  /* rail: 20px base */
--fs-stage-speed: calc(40px * var(--distance));
--fs-stage-section: 40px;          /* near 32px · stand 40px · kit 52px (explicit, spec §4.11 table) */
--fs-stage-position: 56px;         /* band: near 44 · stand 56 · kit 72;  rail: near 52 · stand 64 · kit 84 (explicit) */
--fs-stage-count: calc(120px * var(--distance));
--lamp: 18px;                      /* rail 20px; × distance */
--rail-w: 264px;                   /* near 232 · stand 264 · kit 312; [data-rail-narrow] −32px */
```
Stage tokens are set on `[data-stage-layout]`/`[data-distance]` attributes, which `layout.js` sets on the Stage root. Controls never scale with Distance.

**Contrast test** (`tests/tokens-contrast.test.js`): parse `tokens.css` and assert WCAG ratios in all three sets:
- `--ink`, `--ink-2` and `--ink-3` on `--bg` and `--surface` ≥ 4.5;
- `--on-accent` on `--accent-fill` ≥ 4.5;
- `--now`, `--accent`, `--loop`, `--danger`, `--warn` and `--ok` on `--bg` ≥ 3 (non-text) and ≥ 4.5 where used as text (`--now` count-in and next, `--danger` failed line);
- `--focus-ring` on `--bg` ≥ 3.

If a spec value fails, the test names it and the implementer adjusts that single value by the smallest lightness change that passes, then records it in this table.

### 7.3 Fonts
- **Packages** (devDependencies): `@fontsource-variable/atkinson-hyperlegible-next@5.3.0` and `@fontsource-variable/atkinson-hyperlegible-mono@5.3.0`, verified on npm on 2026-10-28.
- **`scripts/vendor-fonts.mjs`** copies these four files from `node_modules/@fontsource-variable/*/files/` into `src/styles/fonts/`, and writes the OFL texts to `public/licenses/atkinson-hyperlegible-{next,mono}.txt`:
  - `atkinson-hyperlegible-next-latin-wght-normal.woff2` (34 KB)
  - `atkinson-hyperlegible-next-latin-ext-wght-normal.woff2`
  - `atkinson-hyperlegible-mono-latin-wght-normal.woff2` (18 KB)
  - `atkinson-hyperlegible-mono-latin-ext-wght-normal.woff2`
- The copied files are committed, so builds never depend on the packages. Italics are not shipped.
- **`fonts.css`:** four `@font-face` rules with `font-weight: 200 800`, `font-display: swap`, `src: url('./fonts/…woff2') format('woff2')`, and the `unicode-range` values copied verbatim from the packages' `index.css`. Vite emits the files under `/assets/`, which Electron serves (D9) under `font-src 'self'`.
- **Preload:** `main.js` imports the Next latin file with `?url` and injects `<link rel=preload as=font type=font/woff2 crossorigin>`.
- **Usage:**
  - UI: `--font-ui`.
  - Readout numerals (Position, Speed, count-in, times, Kbd, Details raw text): `--font-mono`.
  - Tabular columns (list Length/BPM/Key, meters): `--font-ui` with `font-variant-numeric: tabular-nums`; Next has `tnum`.
  - No layout shift on swap: readouts have fixed `min-width` in `ch` (Readout `minCh`).
- **alphaTab:** `score-view.js` passes `--font-ui` (resolved) to alphaTab and awaits `document.fonts.load` before the first render (§2.14.12).
- **Licences:** add both OFL files, `academico`, `bravura` and `harmonix-set` to the `scripts/prepare-desktop.mjs:18` copy list and to `build/THIRD-PARTY-NOTICES.txt`.

### 7.4 Icons
- **Source:** `lucide-static@1.62.0` (devDependency).
- **`scripts/build-icons.mjs`** reads `ICONS`, an explicit list in the script, from `node_modules/lucide-static/icons/<name>.svg`. It strips `width`, `height`, `stroke-width` and `class`, and wraps each icon as `<symbol id="i-<name>" viewBox="0 0 24 24">`. It appends the custom glyphs in `src/styles/icons-custom/*.svg`: `metronome`, `drum`, `minus-me`, `trainer`, `count-in`. The output is `src/styles/icons.svg`, which is committed.
- **Initial `ICONS` list:** play, square, pause, rotate-ccw, repeat, repeat-1, gauge, timer, music, mic, mic-off, volume-2, volume-x, headphones, list-music, layers, layout-grid, list, search, plus, x, check, chevron-left, chevron-right, chevron-down, chevron-up, ellipsis, more-vertical, pencil, share-2, link, copy, trash-2, pin, pin-off, star, flag, diamond, bookmark, sticky-note, maximize-2, minimize-2, zoom-in, zoom-out, scan, grid-3x3, magnet, arrow-down-to-line, arrow-left, arrow-right, keyboard, settings, user, log-out, download, upload, refresh-cw, alert-triangle, alert-circle, info, loader, sun, moon, monitor, cpu, hard-drive, cloud, wifi-off, external-link, file-music, file-audio, folder-open, wand-2, sparkles, sliders-horizontal, footprints, hand, keyboard-music, guitar, piano, drum, undo-2, redo-2, gamepad-2.
- **Inlining:** `src/ui/icon.js` imports `../styles/icons.svg?raw` and injects it hidden into `<body>` at boot (D32).
- **Sizes and stroke:** 20/24/32 px; `stroke-width` comes from CSS: `--icon-stroke: 1.75` on desk places, `2` on `[data-place=stage]`.
- **Licence:** `public/licenses/lucide.txt` already exists.

### 7.5 View-specific CSS rules (enforced in review)
- **Music width stability:** the Stage music column has a fixed width per layout and Distance. The HUD band, dock and strip change only height. `.chart-scroll` uses `scrollbar-gutter: stable`.
- **Covers:** `border-radius: 0`.
- **Solo has no hue:** an accent ring plus the word `SOLO`.
- **Muted is never shown with opacity:** outline, hatch and `OUT`.
- **No saturated full-bleed band anywhere.** Strip segments alternate `--surface` / `--surface-2`.
- **`theme-color`:** the router sets it per place, from `--bg` of the active set (paper #f6f5f0, night #121615, stage #08090a). `theme-init.js` pre-paints it, including for a `/s/:id` deep link (`data-place=stage` is set pre-paint when the path matches `^/s/[^/]+/?$` or `^/share/`).

### 7.6 Guards (`scripts/check-css.mjs`, `scripts/check-source.mjs`; run by `tests/guards.test.js` under `npm test`)
**CSS** (every file under `src/styles/` except `tokens.css` and `fonts.css`):
- no `#hex`, `rgb(`, `rgba(`, `hsl(`, `hsla(`, `color-mix(`, `white` or `black` colour literals (`transparent`, `currentColor` and `inherit` are allowed);
- `z-index` only `var(--z-*)` or `auto`;
- `border-radius` only `var(--r-*)` or `0`;
- `!important` only in `reset.css` and `utilities.css`;
- `font-size` and the `font` shorthand only through `var(--fs-*)`, `inherit`, or `em`/`%`/`rem`; no px font sizes;
- `font-family` only `var(--font-ui)` / `var(--font-mono)`;
- every primitive and view file's content is a single `@layer primitives {}` / `@layer views {}` block;
- **no CSS file outside `src/styles/`.**

**Source** (`src/**/*.js`):
- no `alert(`, `confirm(` or `prompt(` (other than `feedback.confirm`);
- no `addEventListener('keydown'` / `'keyup'` on `window` or `document` outside `src/app/dispatch.js`;
- no `localStorage` / `sessionStorage` outside `src/app/prefs.js`, `src/app/router.js` (`ws.intendedRoute`) and `src/js/notation/store.js` (IndexedDB is not covered);
- no import of `src/js/backend.js` from `src/{app,ui,stage,edit,library,settings,share,onboarding,download,api}` (after I3, no import anywhere);
- no `innerHTML =` with interpolated strings in `src/{app,ui,stage,edit,library,settings,share,onboarding}` (use `h()`);
- no `z-index` in inline styles;
- registry reservations (§2.6 rule 9).

**Exemptions** (listed in the guard source): `src/js/artwork.js` palettes (art data), `public/theme-init.js`, `desktop/*.cjs` hex constants, alphaTab print colours in `score-view.js` (through `--print-ink` where possible).

---

## 8. What is deleted, and when
| When | Deleted |
|---|---|
| Wave 0A (F4, F5, BK0…) | `engine.toggle`, public `tickEnd`; `Metronome.beatsForView`, `metronome.source`; `SongMapStore.legacy` and every `legacy` branch; the `tempo` dual-write; `musical-position.js` and its test block (`playback-engine.test.js:7,92-99`); `computePeaks`, `drawWaveform` (`waveform.js`); `songs.rename` is removed in BK1 (0B) |
| Wave 0B (BK1–BK7, CPA, PL1) | `songs.rename`, `backend.renameSong`, `backend.listLibrary`; `settings.save`; `settings.format` (defaults); `worker.cancelForUpdate`; `jobs.listActive` newest-50 filter; "Retry the desktop connection in Settings" copy; the `ws.companion` cleanup line; vestigial `http://127.0.0.1:47831` in `vercel.json` CSP |
| Wave 1 (CPB) | companion `update-cancellation.json` write/replay; the packaged-build developer hint; the `friendlyError` regex table's dead Modal-era rules (with `library.js` at I1) |
| **Integration I1** (the new shell lands) | `src/js/app.js`, `library.js`, `player.js`, `player-layout.js`, `settings.js`, `billing.js`, `admin.js`, `desktop.js`, `desktop-client.js`, `feedback.js`, `interactions.js`, `modal-focus.js`, `preferences.js`, `shared-song.js`, `share-dialog.js`, `map-mode.js` (logic ported by ED1), `notation/launcher.js`; **all of `src/css/`** and `src/js/song-metadata.css`, `src/js/notation/{chart,notation,score-view}.css` (moved and tokenised); `index.html` view markup, brand band, add modal, drop overlay and sign-in theme select; `tests/fixture/probes/navflip.cjs`; tests for deleted modules (`player-ui`, `library-startup`, `settings-ui`, `billing-ui`, `interactions-ui`, `share-dialog`, `sharing-ui`, `map-mode`, `timeline-navigation` stays); the ⇧M map toggle; `#help` tooltip; the m-bpm/m-sig aria labels |
| Integration I3 | `src/js/tempo-sources.js` (ported by ED4), `src/js/song-metadata.js` (ported by ED6), `src/js/backend.js` (all callers on `src/api`), `map-lane.js#drawLane`, `notation/editor.js` frame markup and `alignment()`/align-beat dialog, `entry.scoreFromTiming` when no caller remains |
| Wave 4 (V1) | `songs.practice` schema field (after `backfillB1` has run on every deployment), `src/app/placeholder.js`, any `src/js` module with no importer (checked by `scripts/check-source.mjs --orphans`) |
| localStorage | the 13 `ws.*` keys are removed by `prefs.js` migration on first run (wave 1+) |

---
## 9. Work packages

### 9.0 Rules
- **Waves run in order. Packages inside a wave run in parallel in one working tree.** File ownership inside a wave is disjoint: a package edits only the files it owns, plus new test files named after its own modules.
- **Earlier waves are done and integrated** before a wave starts.
- **Peer modules inside the same wave** may be imported by their contract path (this document is the contract). The importing package's tests must `vi.mock` the peer. A wave is first expected to build (`vite build`) and run in the fixture at its integration package.
- **Integration packages** (I0A, I0B, I1, I2, I3) have a single owner. They may touch any file, but only to wire modules together, resolve seams, delete what §8 schedules, and make minimal fixes. Each one ends with the verification in §10.
- **`npm test`, `npm run typecheck` and `npm run test:desktop` stay green at the end of every package.** A package that breaks a test of a module scheduled for deletion may delete that test case and must say so in its summary.
- **Sizes** include tests: **S** ≤ 400 changed lines, **M** 400–900, **L** 900–1500.
- **Shared test helpers:**
  - `tests/helpers/fake-audio.js` (fake AudioContext and Signalsmith; F4);
  - `tests/helpers/fake-session.js` (fake Session/Transport/Map/Practice; ST1);
  - `tests/helpers/dom.js` (happy-dom utilities, keyboard and pointer event builders; F2).
  - Only their owners change them; later packages extend them through new helper files.

### 9.1 Wave 0A: foundations without UI
| ID | Title | Owns | Deps | Acceptance | Size |
|---|---|---|---|---|---|
| **F1** | Styles system, fonts, icons, guards | `src/styles/{main,reset,tokens,fonts,base,layout,utilities}.css`, `src/styles/fonts/*`, `src/styles/icons.svg`, `src/styles/icons-custom/*`, `scripts/{vendor-fonts,build-icons,check-css,check-source}.mjs`, `tests/guards.test.js`, `tests/tokens-contrast.test.js`, `public/licenses/atkinson-hyperlegible-{next,mono}.txt`, `package.json` (devDeps §0.1; scripts `vendor:fonts`, `build:icons`, `fixture:capture` = `NODE_PATH=/opt/node-tools/node_modules node tests/fixture/capture.cjs`), `scripts/prepare-desktop.mjs` (licence list), `build/THIRD-PARTY-NOTICES.txt` | — | Tokens exactly §7.2; the contrast test passes, or failing values are adjusted and recorded. The guard scanners implement §7.6; until I1 the source rules apply only to the new top-level directories (`src/{app,ui,stage,edit,library,settings,share,onboarding,download,api}`); I3 extends them to `src/js`. `npm run vendor:fonts` and `build:icons` are idempotent. A throwaway `vite build` of a page importing `main.css` emits `dist/assets/atkinson-*.woff2`. | M |
| **F2** | App core: store, prefs, router, h, API client | `src/app/{store,prefs,router}.js`, `src/ui/h.js`, `src/api/client.js`, `public/theme-init.js`, `tests/helpers/dom.js`, `tests/app-store.test.js`, `tests/app-prefs.test.js`, `tests/app-router.test.js`, `tests/ui-h.test.js`, `tests/api-client.test.js`, `tests/theme.test.js` (extended) | — | Signals: ordering, batch, cleanup, no leaks. Prefs: `migrateLegacy` maps all 13 keys (§2.5 table), removes them, and survives throwing storage; cross-tab `storage` sync. Router: push/replace rules, modal `/add` over Library, Back restores scroll and focus key, legacy redirects (`/?song=X`, `/billing?checkout=success`), `onLeave` on pagehide, guard fallback, `woodshed:place` dispatch. `reconcileList` keeps the focused node. theme-init: `ws.prefs` first, legacy fallback, `data-place=stage` pre-paint for `/s/:id` and `/share/:t`, theme-color per set. | L |
| **F3** | Keys, registry, dispatcher, pedal classifier | `src/app/{keys,commands,dispatch}.js`, `src/app/pedals.js` (classifier + `PROFILES` only), `tests/app-keys.test.js`, `tests/app-commands.test.js`, `tests/app-dispatch.test.js`, `tests/app-pedals.test.js`, `tests/registry-ci.test.js` (harness with an empty definition list), `tests/registry-shadows.js` | — | Key grammar and symbol aliases (`Shift+,` on US and non-US layouts, `?`, `=`/`+`); `label`/`aria`/`accelerator`. Dispatcher rules 1–9 (§2.6), each with a test, including: a focused Slider never swallows Space or digits; Enter on a focused button is native; text inputs pass only Esc and ⌘K; modal vs non-modal overlays; the surface scope; reserved keys rejected. Classifier: tap/hold/double timings (600/350 ms), keydown fire when no hold action exists, auto-repeat → hold. `registry-ci.test.js` asserts no unlisted shadowing, titles and groups present, controls mapped (definition modules are added by integrations). | L |
| **F4** | Engine and metronome additions + E1 | `src/js/engine.js`, `src/js/metronome.js`, `src/js/musical-position.js` (delete), `tests/playback-engine.test.js`, `tests/engine-schedule.test.js`, `tests/metronome-gaps.test.js`, `tests/helpers/fake-audio.js` | — | Everything in §5.1–5.2 and test plan §5.4 items 1–11 on both paths. `Metronome` takes an injected store; the old no-store default stays only until I1 (I1 removes it). Public `metronome.clickAt(when, accent)` replaces `_click(…, tracked = false)` (used by calibration); `_click` stays as an alias until I1. Label-only map edits (`reason` `label`/`sections`) do not cancel a running count-in (§4.2). `gapSec = 0` behaviour is identical: the existing tests pass unchanged. | L |
| **F5** | Song-map model: origin, hasRealMap, helpers, fromTaps | `shared/song-map.ts`, `src/js/song-map.js`, `tests/song-map.test.js`, `tests/song-map-store.test.js`, `tests/song-map-helpers.test.js`, `tests/has-real-map.test.js`, `tests/map-mode.test.js` (remove the "legacy maps save unchanged" case only) | — | §4.1–4.3 and §4.6. `hasRealMap`: each rule, both additions, `source:'detected'` ignored when a songMap exists, undo back to a no-origin map → not real, shared round-trip through `cleanSongMap`. Helpers: pickup numbering (`Pickup · 3`), before-first extrapolation, sections ("Start", duplicate numbering, the `'Pickup'` label ignored), `nextSection` counts, `downbeatAfter` skips the pickup start, `phraseAt` alignment, `refAt`/`timeOfRef` across a meter edit, `snapTime` modes, `setDuration`. `fromTaps`: a jittered 92 bpm input gives 92 ± 0.2 with 2 pins. `REASON_ORIGIN` stamping; no-op edits push no undo. | L |
| **F6** | Practice model and profile | `shared/practice.ts`, `src/app/profile.js`, `tests/practice-model.test.js`, `tests/profile.test.js` | — | §2.21–2.22. v1 → v2 upgrade for every legacy shape seen (`{rate,loop,tracks:[]}`, `{rate:1}`, full v1 with grid); never throws on garbage. Merge: id union, newest wins, tombstones win ties, dirty scalars. Prune order and cap (a 40 KB synthetic input ends ≤ 32,768). `summarize` loop labels and top-3 spots. `sanitizeForShare` drops notes. `myStems` for every D37 case, including 2-stem songs. | M |
| **BK0** | Convex schema, error codes, validators | `convex/schema.ts`, `convex/lib/errors.ts`, `convex/lib/validators.ts`, `convex/lib/auth.ts`, `convex/convex.config.ts`, `convex/errors.test.ts` | — | §6.1–6.2. Every new field is optional, so the deploy passes against existing rows. `lib/auth.ts` throws coded `account_suspended`/`account_export_only`/`not_signed_in`. `npm run typecheck` green. | S |
| **DT1** | Electron main and preload | `desktop/{main.cjs,preload.cjs,menu.cjs,window-state.cjs,update-controller.cjs}`, `desktop/{menu,window-state,static-server}.test.cjs`, `desktop/update-controller.test.cjs` | — | §6.11 items 1–11 (item 12, the smoke DOM, is I1). `node --test desktop/*.test.cjs` green: menu validation rejects bad ids, accelerators and depth; plain keys are never registered; ⌘W disabled without a song; off-screen window restore; exists-or-index serving with traversal blocked; update prompts deferred while playing. | L |
| **FX1** | Fixture restructure and legacy baselines | `tests/fixture/**` except `tests/fixture/db/{songs,jobs,devices,settings,sharing,setlists,metadata}.js` content added in 0B (FX1 creates these files with today's handlers moved verbatim) | — | `db.js` split into `db/index.js` (loader: `import.meta.glob('./*.js', {eager: true})` merges `handlers`), `db/seed.js` (data) and the domain files. **Seed adds:** v2 practice (spots, markers, chartAudio), v1 practice rows, mapped (origin), unmapped, a 1.6–1.9 no-origin map, a pre-1.6 `tempo.map`, a pickup map, a 7/8 map, a demo share, every job state (`queued`, upload, download, separate with ETA, finalize, beats chained, import, `bot_check` with `retryAt`, failed `separation_failed`), two devices (one offline), setlists, pins, `metadataSuggestion`. `preamble.js` seeds `ws.prefs` (`fx-prefs=<json>`), adds an XHR shim for `/upload` with progress events, fakes `/resolve`, `/search` and the extended `/status`, and gives every bridge method no-op fakes (incl. `mediaUrl`). `vite.config.mjs` injects the preamble before `/src/js/app.js` **or** `/src/app/main.js`. `capture.cjs` loads `states/*.cjs` (each exporting `[{name, fn, opts}]`) and writes `tests/fixture/shots/<state>--<device>-<theme>.png`. **Legacy baselines:** before any notation change (spec R9), capture Transcribe score and lanes and the practice chart (laptop and iPad × light and dark = 12 PNGs) into `tests/fixture/baselines/legacy/` (committed, for side-by-side review), and record `score-geometry.json`: for the fixture `demoScore(64,120)` at scale 1.0 and 1.2, the bars per system plus every notehead box relative to its bar origin, from `view.noteBoxes()`/`barBounds()`. | M |

### 9.2 Integration I0A
- Run `npm test`, `typecheck` and `test:desktop`, and `npx convex dev --once` against the dev deployment (schema push).
- Confirm that `vite build` still succeeds for the old app.
- No product wiring.

### 9.3 Wave 0B: primitives, platform, backend, kernels
| ID | Title | Owns | Deps | Acceptance | Size |
|---|---|---|---|---|---|
| **U1** | Primitives: actions and inputs | `src/ui/{icon,button,toggle,hold-button,segmented,chip,stepper,slider,fader,field,stem-pad}.js`, `src/styles/primitives/{icon,button,toggle,hold-button,segmented,chip,stepper,slider,fader,field,stem-pad}.css`, `tests/ui-actions.test.js`, `tests/ui-inputs.test.js`, `tests/ui-stem-pad.test.js` | F1–F3 | Props and behaviour per §2.12. Button with `command` reflects `when`/`checked` live, sets `aria-keyshortcuts`, runs with `source: 'pointer'`. Long-press 500 ms. Slider, Stepper and Fader consume only their keys (dispatcher interop test). HoldButton keyboard rule. ChipInput commit rules. Icon-only controls without a label throw in dev. Target sizes from tokens (`--h-*`). | L |
| **U2** | Primitives: overlays | `src/ui/{position,popover,menu,sheet,dialog,toast,status,banner,coachmark}.js` + `src/styles/primitives/*.css` for each, `tests/ui-position.test.js`, `tests/ui-overlays.test.js`, `tests/ui-menu.test.js` | F1–F3 | `place()` flips and clamps (pure tests). Menu: roving, type-ahead, Esc, submenu, checked/radio, coarse → sheet, `bindContextMenu` (right-click, 500 ms long-press, Shift+F10, ContextMenu). Sheet: auto layout by `data-stage-layout`, detents, swipe threshold, no history. Dialog: focus return, async submit error inline. All push to the dispatcher overlay stack with the correct modality (D36). | L |
| **U3** | Primitives: display | `src/ui/{progress,tabs,kbd,tooltip,empty,skeleton,readout,beat-lamps}.js` + `src/styles/primitives/*.css` for each, `tests/ui-display.test.js` | F1–F3 | Kbd platform labels and touch hiding; BeatLamps D15 (4/4, 7/8 2+2+3, 6/8, 15/16 → groups); Readout minCh; ProgressRail null → shimmer, static under reduced motion. | M |
| **PL1** | Platform, desktop wrapper, error copy | `src/app/{platform,desktop,error-copy}.js`, `src/js/stemcache.js` (codec copy), `src/js/download-release.js` (`fetchRelease`), `public/manifest.webmanifest`, `public/icon-{192,512}.png`, `public/icon-maskable-512.png`, `vercel.json`, `tests/app-platform.test.js`, `tests/app-desktop.test.js`, `tests/error-copy.test.js`, `tests/downloads.test.js` | F2 | Wake-lock policy with a fake `navigator.wakeLock` (acquire, release after N minutes stopped, re-acquire on visible). Interruption → `transport.interrupt`. Media Session handlers. Processor status state machine (every phase). `describeError` covers every §3.6 row and every code in §6.1. The codec copy no longer mentions FLAC. Manifest valid. | M |
| **ST0** | Stage kernels: position, practice state, undo, glass, frame | `src/stage/{position,practice-state,undo,glass,frame}.js`, `tests/stage-position.test.js`, `tests/stage-practice-state.test.js`, `tests/stage-undo.test.js`, `tests/stage-glass.test.js` | F2, F5, F6 | §2.14.4–2.14.8. **"Unmapped never renders Bar"** test for `position.js`. Practice state: debounce 600 ms, flush triggers, merge before save, prune warning, `lastAt` once per session, local-only persistence for share tokens, `reanchor`. Undo: coalescing in 1 s, cap 50, `describe`. Glass: the full table. | M |
| **ST2** | Waveform renderer, grid, loop handles, pinch | `src/stage/{wave-render,grid,loop-handles,pinch}.js`, `src/js/waveform.js`, `src/styles/views/stage/loop-handles.css`, `tests/stage-wave-render.test.js`, `tests/stage-grid.test.js`, `tests/stage-loop-handles.test.js`, `tests/stage-pinch.test.js` | F1, F5 | Peak pyramid levels and `range` equal `computePeaksRange` within 1e-6; `perBar`; the hatch pattern is cached; `drawGrid` skips lines < 6 px apart. Loop handles: 44 px hits, edge/inside drag, Alt/Shift snapping callbacks, pointer capture, 50% while playing. Pinch: scale factor and commit on release. | M |
| **ST3** | Chart API (chrome-less) and score view | `src/js/notation/{chart,score-view,lanes}.js`, `src/styles/views/notation/{chart,score-view,lanes}.css` (moved from `src/js/notation/*.css`, tokenised), `tests/notation-chart.test.js` (rewritten), `tests/notation-render.test.js` | F1 | §2.14.12 and `maps/notation.md` §11. Tests: tap/double/long/context emission with pointerType; glass suppression; mouse drag → `onLoopEdit` preview/commit with bar ids, with **no implicit seek**; Alt-drag beat snap; handles; `setScale` keeps the anchor; Page follow advances half a viewport; `setLoopRange` draws without polling; font floors; the long-press pending state is gone; empty-state actions `{findChart, importFile, write}`. Theme read from the host. Engraving geometry matches `baselines/legacy/score-geometry.json`: identical bars per system and noteheads within ±2 px of their bar origin (colours and fonts change by design; the PNGs are reviewed side by side). | L |
| **ED1** | Map editing session (no DOM) | `src/edit/map/session.js`, `tests/map-session.test.js` | F4, F5 | All `MapSession` members (§2.15). Every scenario from `tests/map-mode.test.js` is ported to drive `session.js` with a fake engine: pin/renumber/meter/undo; digits do not leak; drum-part guard refusals; the E form (meter, groups, scope); 4/4 → 3/4 rebar on a tapped map. Plus: Preview restores the click; calibration resumes the context; audition batch semantics; `markersToSections` collisions. | L |
| **BK1** | Songs, notation, B1, B2, migration | `convex/songs.ts`, `convex/notation.ts`, `convex/migrations.ts`, `convex/songs.test.ts`, `convex/migrations.test.ts`, `src/api/{songs,media,storage}.js`, `tests/fixture/db/songs.js` | BK0, F5, F6 | §6.3. **convex-test:** list rows contain no practice/tempo/notes/locks; a `savePractice` with an unchanged summary does not patch `songs` (assert `songs` doc unchanged); 32,768 accepted, 32,769 rejected (`practice_too_large`); `saveTempo` stale-rev merge keeps a real map and returns `conflict`; `hasChart` follows notation save and delete; `getMany` is scoped and capped; `deleteSongData` strips setlists, pins and `songPractice`; backfill is idempotent and paginates. Fixture handlers mirror list/get/getMany/savePractice/saveTempo/markReviewed. | L |
| **BK2** | Jobs | `convex/jobs.ts`, `convex/jobs.test.ts`, `src/api/jobs.js`, `tests/fixture/db/jobs.js` | BK0 | §6.4. Tests: per-status listing beyond 50 done jobs; new fields; `meta` validation (non-https thumbnail rejected); upload origin device; `resplit_wrong_device`; beats dedupe; retry resets stage; coded errors. | M |
| **BK3** | Worker, devices, presence, storage, admin (B4/B5/B6 server) | `convex/{worker,devices,storage,admin}.ts`, `convex/worker.test.ts`, `convex/devices.test.ts`, `src/api/devices.js`, `tests/fixture/db/devices.js` | BK0, F5, F6 | §6.6. Tests: `next` prefers beats; `claim` startedAt/attempts and `six` normalisation; bot-check auto-retry schedule and the attempts cap; `finish` chains beats only when `autoBeats && !hasRealMap`, stores resolvedUrl/provider/needsReview/originDeviceId; `beatsDone` writes `origin: 'detected'` only when unmapped and bumps `tempoRev`; heartbeat upsert; `devices.list` shape; rename; user revoke re-pairs; admin revoke refuses re-pair. | L |
| **BK4** | Settings, presets, account client, demo | `convex/settings.ts`, `convex/lib/presets.ts`, `convex/settings.test.ts`, `src/api/settings.js`, `src/app/account.js`, `tests/app-account.test.js`, `tests/fixture/db/settings.js` | BK0 | §6.5. Tests: patch validation (enums, ≤ 12 pins, owned ids, ≤ 6 instruments); concurrent patches from two clients both survive; export-only accounts may patch; `demo` returns null for a malformed env; `six` → `htdemucs_6s` with the preset's shifts. `account.js`: optimistic patch and revert on error; `togglePin` cap; the one-time `ws.stopBehavior`/`ws.preservePitch` carry-over (via the prefs migration result). | M |
| **BK5** | Sharing v2 | `convex/sharing.ts`, `convex/shareAudio.ts`, `convex/sharing.test.ts`, `src/api/sharing.js`, `tests/fixture/db/sharing.js` | BK0, F6 | §6.7. Tests: a v1 source shares its loop; a v2 source shares spots and markers without notes; `ownerName` without email; `finishImport` writes `songPractice`, summaries and `hasChart`. | M |
| **BK6** | Setlists (B3) | `convex/setlists.ts`, `convex/setlists.test.ts`, `src/api/setlists.js`, `tests/fixture/db/setlists.js` | BK0 | §6.8. Tests: ownership (Bob cannot read, modify or add Alice's ids), caps (100/100/80 chars), dedupe, export-only refused, touch. | M |
| **BK7** | Metadata (D6) | `shared/metadata.ts`, `convex/lib/songMetadata.ts`, `convex/metadata.ts`, `convex/metadataLookup.ts`, `convex/metadata.test.ts`, `tests/metadata-shared.test.js`, `src/api/metadata.js`, `tests/fixture/db/metadata.js` | BK0 | §6.9. Tests: unchanged keys neither lock nor clear ids; `unlock`; `confirm` locks identity keys and clears suggestion/needsReview; `match` survives the clearing rule; the suggestion is stored on `uncertain` and cleared on a title edit; `updateEach` is atomic; `retry` re-schedules; field errors carry `field` and labelled copy. | L |
| **CPA** | Companion lookup (B4) and client | `companion/lookup.mjs`, `companion/ytdlp-args.json`, `companion/lookup.test.mjs`, `companion/fixtures/ytdlp/*.json`, `companion/server.mjs` (routes `/resolve`, `/search` only), `companion/pipeline.py` (read `ytdlp-args.json` only), `src/js/companion.js`, `tests/companion.test.js`, `package.json` (script `test:companion` only) | — | §6.10 CPA part. `node --test companion/*.test.mjs` green. Client: abort and timeout, XHR progress events, resolve/search parsing, coded errors → `ApiError`-like `{code}`. | M |

### 9.4 Integration I0B
- Deploy the dev schema and functions, and run `migrations:backfillB1` on dev.
- Extend `registry-ci.test.js` with the primitive `Button({command})` scan.
- Run the full §10.1 suite.

### 9.5 Wave 1: shell, session, Library home, onboarding, processing core
| ID | Title | Owns | Deps | Acceptance | Size |
|---|---|---|---|---|---|
| **S1** | App shell | `index.html`, `src/app/{main,routes,topbar,fatal,placeholder,data,global-commands}.js`, `src/styles/views/shell/{topbar,fatal,placeholder}.css`, `tests/app-shell.test.js`, `tests/app-routes.test.js`, `tests/fixture/states/shell.cjs` | waves 0A, 0B | Boot order (route kind → auth → config/account → data → registry → router), with mocks. Placeholder views for every route not yet built. Top bar per spec §2.1 (avatar menu items, update dot from `store.update`, Jobs slot). Fatal card with Details and an 8 s "Still connecting… [Retry]". Paused-account page for `suspended`; export-only Banner. In-flow offline and codec banners. `global-commands.js` registers §3.5 G commands. Desktop: processor/update models wired into the store. The intended-route stash around sign-in. | L |
| **S2** | Feedback, palette, shortcut sheet | `src/app/{feedback,palette,shortcuts-sheet}.js`, `src/styles/views/app/{toast,palette,shortcuts}.css`, `tests/app-feedback.test.js`, `tests/app-palette.test.js`, `tests/app-shortcuts.test.js`, `tests/fixture/states/app.cjs` | 0B | Toasts held while `store.stage.playing` and released on stop; queue; error persistence; `confirm`/`form`; announce throttle. Palette: every parsing rule in §2.8, ranking, frecency cap, ⌘Enter variants, band top sheet. `?` sheet generated from the registry with the current chain first; shadowed keys marked. | L |
| **ST1** | Song session and transport | `src/stage/{session,notation-session,transport,transport-commands}.js`, `src/js/notation/{part,audio}.js`, `tests/helpers/fake-session.js`, `tests/stage-transport.test.js`, `tests/stage-session.test.js`, `tests/stage-notation-session.test.js` | 0A, 0B | §2.14.1–2.14.3 and §5.4 item 12 (transport). Session: render-before-decode order, legacy timeline adoption before the part opens, the guard installed once, flush triggers, B6 adoption (tempoRev) with an undo step, the tempo conflict path, audition suspension. Notation session: chart audio levels, `setMapSyncPaused`, Listen state survives posture changes. `transport-commands.js` registers §3.1. `fake-session.js` exposes signals matching the real shapes. | L |
| **LB1** | Library home, cards, jobs, first run | `src/library/{home,library-model,song-labels,cards,continue,jobs,review-chip,first-run,setlists,commands}.js`, `src/styles/views/library/{home,cards,continue,jobs,first-run}.css`, `tests/library-model.test.js`, `tests/library-labels.test.js`, `tests/library-jobs.test.js`, `tests/library-home.test.js`, `tests/fixture/states/library.cjs` | 0B | Spec §2.1–2.4, 2.7 and 2.8, without Add, selection or menus (LB2/LB3). Sort, group and drill-down chips; filters (Processing/Failed only when > 0); URL and prefs mirroring; the first-run threshold (6 songs) for Sort/Group/Select; the keyed reconcile never rebuilds the focused card; `content-visibility: auto` on the list; processing states per §3.4 (real upload bytes from `store.library.uploads`); Jobs popover rows (stepper, device name, ahead count, ETA after 15 s, message, source, actions); Needs-review chip → `metadata.confirm`; Continue hero, recents and spot chips from `practiceSummary`; the Pinned row and the Setlists row (`setlists.js`, read-only cards); the New dot; the Demo card from `settings.demo` (hidden when null); no-results, empty-filter, loading, offline and codec states. | L |
| **ON1** | Sign-in, welcome, instruments picker | `src/onboarding/{signin,instruments,welcome}.js`, `src/js/auth.js` (core only: remove `mountUserButton`, sign-in card markup and `showFatal`), `src/js/startup.js` (if needed), `src/styles/views/onboarding/*.css`, `tests/onboarding.test.js`, `tests/startup.test.js`, `tests/fixture/states/onboarding.cjs` | 0B | Spec §6.6.1–6.6.3: copy exact, no theme picker, OAuth error mapping kept. `/welcome` writes the profile and the onboarding flag; Skip. InstrumentPicker: the primary is the first tapped; open-with-my-part choice. | M |
| **CPB** | Companion processing core (B5, B6, D12) | `companion/{process.py,pipeline.py,errors.py,server.mjs,test_errors.py}` | BK3 | §6.10 CPB items 1–10. Python unit tests green (`python -m unittest discover -s companion -p 'test_*.py'`). Progress throttling (stage change, trailing flush). `/status` shape. Heartbeat cadence (fake timers in a Node test via an exported `createHeartbeat`). | L |

### 9.6 Integration I1 (the switch)
1. Confirm that the new `index.html` (S1) boots in the fixture and in `vite build`, and that `main.js` imports `main.css` first.
2. Delete everything §8 lists for I1. Remove the `Metronome` no-store default.
3. Wire `mountJobsChip` into the top bar and the Library `paste` and `/` handlers. Register the Library, Stage-transport and global definitions in `registry-ci.test.js`.
4. Update the desktop smoke assertions (§6.11.12), and the test helpers in `tests/fixtures/*` that imported deleted modules (`tempo-map.js` imported `interactions.js`).
5. Run §10.3.

### 9.7 Wave 2: the Stage, Add, Library actions, Settings, Download
| ID | Title | Owns | Deps | Acceptance | Size |
|---|---|---|---|---|---|
| **ST4** | Stage frame | `src/stage/{stage,layout,commands}.js`, `src/stage/sheets/host.js`, `src/styles/views/stage/{stage,status,focus}.css`, `tests/stage-layout.test.js`, `tests/stage-view.test.js`, `tests/fixture/states/stage-frame.cjs` | wave 1 | Rail/band rule and the 150 ms debounced relayout with the anchor kept. Distance metrics and rail widths. Focus: band hides identity, strip and dock (height only, with a 72 px reveal zone and 5 s reveal); rail → 120 px mini rail (one relayout). Interactive loading (controls live, Play ring with the exact progress strings), errors in the music area with `aria-disabled` reasons. Resume: restore surface, scroll anchor, the resume chip (4 s) with Start over as one undo step. `?spot`, `?bar`, `?t`, `?set`. Hold-to-leave (600 ms) and the Esc rule. The surface default rule, switched once when the part answers. The wake lock, interruption watcher and Media Session started. `store.stage` updates. The setlist context (HUD data, `setlist.next/prev`). Read-only sessions disable Edit, Share, map and detect commands through `when`. The Stage adds the song to `prefs.library.opened` on mount. §3.2 commands. Undo feedback. | L |
| **ST5** | HUD and controls | `src/stage/{hud,controls}.js`, `src/styles/views/stage/{hud,controls,count-in}.css`, `tests/stage-hud.test.js`, `tests/stage-controls.test.js` | wave 1 | §4.4 text rules (every row, mapped and unmapped, pickup); the 160 ms section crossfade; lamps from the frame bus at 60 Hz, text ≤ 30 Hz; the count-in plate; ☼ and ⎍ indicators; the `1 ready` chip; dims (identity 40%, controls 70%) while playing. The read-only identity variant ("Shared by …" plus an action slot that SH1 fills). The setlist line "Set: Thursday · 2/5 · next: Velvet Arc" when `?set=`. The `1 ready` chip reads `jobsModel.ready`. `CONTROL_SET` rendered as dock (608 + 60 + 32 = 700 px; Play 96) / rail / mini / slim; long-press and ⌃ zones; every control `command`-bound. Computed font sizes per Distance (unit test on CSS vars). | L |
| **ST6** | Song strip | `src/stage/strip.js`, `src/styles/views/stage/strip.css`, `tests/stage-strip.test.js` | wave 1 | Spec §4.5: segments ≥ 56 px with scrolling, alternation, progress fill; unmapped waveform + marker ticks + the "No bar grid · Get bars →" chip; overlays (playhead, cue ▼, loop bracket, spots, viewport bracket); stopped tap → cue, double → loop section; playing tap → quantized jump with `→ Verse 2` and tap-again cancel; long-press/right-click section menu; scrub label `Bar 41 · Bridge`; mouse drag loop; roving keyboard slider with `aria-valuetext`. | M |
| **ST7** | Speed, Click, Mix sheets | `src/stage/sheets/{speed,click,mix}.js`, `src/styles/views/stage/sheets-{speed,click,mix}.css`, `tests/stage-sheets-a.test.js` | wave 1 | Spec §4.7 exact controls. Speed: presets, ±1, keep pitch per song, trainer steppers + "Trains on: …" + done copy, 25% floor (50% in safe mode). Click: count-in options (1–16 bars/beats custom), every pass, Click modes, accent, volume, pre-roll, edge flash, the read-only "At the cue: ♩ = 96 · 4/4 · from the map" line, unmapped Lead-in and "Needs a bar grid", the Edit map footer. Mix: Minus me / I play (InstrumentPicker inline) / Only me / Full mix, the Mute·Solo mode switch, StemPads in canonical order, Chart playback, no-stem copy (desktop vs web). | L |
| **ST8** | Loop card, spots, notes, tap the beat, get bars, menus | `src/stage/sheets/{loop,spots,notes,tap-beat,get-bars}.js`, `src/stage/menus.js`, `src/styles/views/stage/sheets-{loop,spots,notes,tap-beat}.css`, `tests/stage-sheets-b.test.js`, `tests/stage-menus.test.js` | wave 1 | Loop card per spec §4.7 + D17 (between passes, call & response disabled with a reason), edge nudges by unit, move by length, Save as spot (pre-filled name, B), Clear (undoable). Spots list: rows, swipe/right-click actions, select → loop+speed+cue, `practised 2 days ago · 14 times`. Notes card (non-modal, 17 px). Tap the beat: 160×160 pad, T/Space taps (pad scope), live bpm, result actions, `fromTaps`, undoable. Get bars popover (desktop-only Detect disabled on web with a reason). Every menu in §2.14.11. | L |
| **ST9** | Chart surface | `src/stage/surfaces/chart-surface.js`, `src/styles/views/stage/surface-chart.css`, `tests/stage-chart-surface.test.js` | wave 1 | Hosts `createChart` (lazy import). Glass via `pressPolicy` (pill 3 s, tap-pill → jump). Pinch preview/commit (80–200%). Follow pill (56 px bottom-centre), 8 s idle resume, Play/Again/F resume. Distance → scale and font floors; dense parts → 2 bars/system on band, 4 on rail. An accessible bar list overlay (←/→, Enter plays, L loops). Empty states (owner and shared). The Display menu (device). | M |
| **ST10** | Road map and Wave page | `src/stage/surfaces/{roadmap-surface,roadmap-layout}.js`, `src/styles/views/stage/surface-roadmap.css`, `tests/stage-roadmap-layout.test.js`, `tests/stage-roadmap-surface.test.js` | wave 1 | Spec §4.4B/C. Layout (pure): 4 bars per row on band, 8 on rail (music width ≥ 1100); breaks at sections and meter changes; long sections wrap; wave rows of 10/8 s (4–30 s via `=`/`−`). Rows virtualised (visible + 2), one canvas per row + DOM labels and handles; cells 88 px × Distance; meter and tempo chips; spot flags; `drawEnvelopeStack` with your stem on top and muted hatch; the current-bar outline and sweeping playhead; follow at 30%; roving-tabindex bar grid; shimmer before peaks; **no "Bar" or lamps when unmapped** (test). | L |
| **ST11** | Stems surface | `src/stage/surfaces/stems-surface.js`, `src/styles/views/stage/surface-stems.css`, `tests/stage-stems-surface.test.js` | wave 1 | Spec §4.4D: toolbar (− + Fit, Zoom to loop, Grid ▾, Snap, Follow), ruler in bars or time, rows with headers (168/128 px), M/S (32 fine / 44 coarse), laptop faders, OUT/SOLO words, hatch; one pointer-events model (mouse seek/drag/edges/move; touch stopped: tap cue, long-press-drag loop, two-finger pan, pinch zoom); wheel per today (`wheelNavigation`); Follow pause and pill; `viewport` signal for the strip bracket; `setSurfaceScope('stage.stems')` while shown; §3.3 commands; grid lines at 8%/18% only when ≥ 6 px apart; `prefs.stems`. | L |
| **LB2** | Add sheet and uploads (B4, B5 UI) | `src/library/{add-sheet,add-model,upload,dropzone}.js`, `src/styles/views/library/add.css`, `tests/library-add-model.test.js`, `tests/library-add-sheet.test.js`, `tests/library-upload.test.js`, `tests/fixture/states/add.cjs` | wave 1 | Spec §3.1–3.6 exactly. Omnibox with a 400 ms debounce; candidates from `/resolve`/`/search` (radio rows, ↑/↓, badges) or the honest single-result line when B4 fails; Spotify copy; file rows with duration from `<audio>` metadata, non-audio flagged; duplicate notice; the defaults line from the profile with Change (Stems, Quality with the jobStats estimate, "Use these for future songs" → `account.patch`); the removes-my-stem warning; device line / B5 picker ("Your MacBook Pro will split this · ● Online ▾", offline copy, files disabled on web); `⇧↵` add another; after submit: close, the new card at the front under "Adding" with a ring, the toast with Undo (10 s → `jobs.cancel` or upload abort), live-region announce; inline errors keep the input; the web explainer with platform download (`fetchRelease`), Copy link, `navigator.share`, Open the example. XHR progress; cancel before `createSeparation` (S1 bug); device id fetched once per batch; window drop → `/add` with staged files (Library place only). | L |
| **LB3** | Selection, card menu, re-split, pins, setlists UI (B3) | `src/library/{selection,card-menu,resplit-dialog,setlist-page}.js`, `src/styles/views/library/{selection,setlists}.css`, `tests/library-selection.test.js`, `tests/library-setlists.test.js`, `tests/fixture/states/library-actions.cjs` | wave 1 | Spec §2.5–2.6, §3.7. Selection entry (⌘/Shift-click, long-press, Select), floating bar, bulk Edit details (→ `/edit/details?ids=`), Pin, Re-split (desktop), bulk delete Dialog copy (sequential `songs.remove` with a partial-failure report), ⌘A, Esc, "Up to 100 at a time". Card menu items with reasons (web Re-split disabled with a visible reason), shortcut hints. Re-split dialog cost line from jobStats and the device name; D38 error. Pins (8 s Undo toast). The "Add to setlist ▸" submenu (new list inline), `/set/:id` (rename, reorder by drag and by ⌥↑/⌥↓ keys, remove, play → `/s/<first>?set=<id>`, touch). | L |
| **SE1** | Settings frame and sections (practice, instruments, appearance, device, account, pedals stub) | `src/settings/settings.js`, `src/settings/sections/{practice,instruments,appearance,device,account,pedals}.js`, `src/styles/views/settings/*.css`, `tests/settings-frame.test.js`, `tests/settings-sections-a.test.js`, `tests/fixture/states/settings.cjs` | wave 1 | Spec §6.2 rows, minus Classic keys. Laptop 200 px nav + ≤ 720 px content; iPad list → detail; Back rules. Save on change with inline Saved / "Couldn't save · [Retry]". The account vs device split (D40). Appearance: Theme, Stage (Match theme / Always dark). This device: install steps, wake-lock support and fallback tip, Media Session status, Announce sections, Safe audio mode, version, Check for updates (desktop), Licenses (opened in-app from a `?raw` import). `pedals.js` stub: "View keyboard shortcuts" only (PD1 completes it). | L |
| **SE2** | Settings: processing, plan and storage, export | `src/settings/sections/{processing,plan}.js`, `src/js/export.js`, `src/api/billing.js`, `src/styles/views/settings/{processing,plan}.css`, `tests/settings-sections-b.test.js` | wave 1 | Processing: status + Restart processor, default stems (incl. `six`), one Quality segmented control (no duplicate slider), Advanced `<details>` → Custom, bitrate, Notify when ready, Find bars automatically (autoBeats), Import an old library, Export original audio; on web, processor status + B5 device list (rename, remove) and the desktop-only note. Plan & storage: usage meter + 5 largest songs (stem bytes), Free/Plus cards with prices from `monthlyCents`/`annualCents`, notices, `?checkout=success` toast, Export library ZIP (the only copy; picker inside the gesture; iPad 100 MB note up front), playback cache size + Clear. Billing subscription closed on unmount. `export.js` on `src/api` + `setlists.json`. | L |
| **SE3** | Admin | `src/settings/admin/{admin,account,reason-dialog}.js`, `src/api/admin.js`, `src/styles/views/settings/admin.css`, `tests/admin.test.js` | wave 1 | Spec §6.4: overview cards, policy form, account search (exact email), `/admin/accounts/:id` page (status segmented, storage override, notes, devices with `lastSeenAt`, Revoke…, jobs Cancel…, audit history with Load more); every mutation behind the Reason dialog (≥ 3 chars); no `prompt`. | M |
| **DL1** | Download page | `src/download/download.js`, `src/styles/views/download/download.css`, `tests/download-page.test.js` | wave 1 | Same logic as today (`detectPlatform`, `fetchRelease`, fallback, Retry) on primitives and tokens. On desktop, same-origin new-tab links navigate in place. | S |

### 9.8 Integration I2
1. Assemble the Stage (`stage.js` with hud, controls, strip, sheets and surfaces) and replace the Stage placeholder.
2. Wire the Library card menu, selection and Add into home; register the Stage/Stems/Library definitions in `registry-ci.test.js`.
3. Write `tests/fixture/flows/rehearsal.cjs` (keys-only laptop and touch-only iPad: open → loop the bridge → 75% → drums out → count-in → play; ≤ 3 actions after resume, ≤ 6 fresh).
4. Run §10.4.

### 9.9 Wave 3: Edit postures, sharing, pedals, coach marks, desktop renderer
| ID | Title | Owns | Deps | Acceptance | Size |
|---|---|---|---|---|---|
| **ED2** | Edit frame and slim transport | `src/edit/{edit,slim-transport,commands}.js`, `src/styles/views/edit/{frame,slim-transport}.css`, `tests/edit-frame.test.js`, `tests/fixture/states/edit-frame.cjs` | wave 2 | Spec §5.0: posture bar (2 px `--edit`, label, tabs with replace, Undo/Redo routed per tab, save status slot), Done/Esc semantics, the inspector container (laptop 320 px; iPad 45% sheet collapsing to 56 px with the landscape hint), the slim transport (controls 'slim'), key-cap hints only after keyboard use on fine pointers, app-theme tokens (not Stage), the shared session (playback continues across Stage ↔ Edit). | M |
| **ED3** | Edit · Map view, lanes, inspector, sections | `src/edit/map/{view,lane,inspector,sections,commands}.js`, `src/js/map-lane.js` (pure helpers only), `src/styles/views/edit/map.css`, `tests/edit-map-view.test.js`, `tests/edit-map-lane.test.js`, `tests/edit-map-inspector.test.js`, `tests/map-lane.test.js`, `tests/fixture/states/edit-map.cjs` | ED1, wave 2 | Spec §5.1–5.1.1: toolbar (Grid ▾, Snap, − + Fit, Z), bar ruler with meter chips, sections lane (32 px, editable blocks, rename, drag boundary), tempo lane (96 px; steps, ramps, amber suspect; 12 px diamonds with 24/44 px hits), stem rows on `wave-render` with M/S and faders, the strip. The inspector mapping table complete (every key-only edit has a control; `maps/mapedit.md` §11.4). Get a map (unmapped). Markers → sections banner with Undo. Guard refusals in the status line. The §3.4 Em commands and D19. `?bar=` focuses the bar. | L |
| **ED4** | Find a chart panel and drum import | `src/edit/map/find-panel.js`, `src/edit/drum-import.js`, `src/api/tempo-sources.js`, `src/styles/views/edit/find.css`, `tests/edit-find-panel.test.js` (ports `tempo-sources.test.js` scenarios), `tests/tempo-sources.test.js` (delete) | ED1, wave 2 | Spec §5.1.2 + D20: search pre-filled and auto-run; radio rows; Import a file… (all formats and limits); Other sources links; Align (audition with Space; ±10/±100 ms; Line up the first downbeat with the cue; Reset; duration-mismatch warning); commits `Use their map` / `Use map + drum chart (N hits)` / `Keep my map`; one undo step per commit; no tempo or notation saves during the audition; map-mutating commands disabled; the leave-mid-audition confirm; late-response safety; input keys never reach the registry. | L |
| **ED5** | Edit · Chart re-frame | `src/edit/chart/{chart-edit,toolbar,menus,kit-bank,commands}.js`, `src/js/notation/editor.js`, `src/styles/views/notation/editor.css`, `src/styles/views/edit/chart.css`, `tests/notation-editor.test.js`, `tests/notation-songmap.test.js`, `tests/edit-chart.test.js`, `tests/fixture/states/edit-chart.cjs` | ST3, wave 2 | Spec §5.2 + `maps/notation.md` §12 + D18: toolbar (View, steps with 5·4·3·2·1 hints, Dotted, Tuplet, Skip, Writing: piece, Undo/Redo text ≥ 1200 px, range nav + section menu, Edit ▾, Part ▾; Lanes-only Grid ▾ and Fit); every menu item with its shortcut; inspector tabs Kit · Properties · Listen (Recorded drums In/Out synced with Mix; Listen persists across postures); part layout footer; scoped keys (§3.4 Ecs) with dynamic drum letters re-registered on Drum keys save; the reserved-key validation; iPad kit pad bank (4 × 7 + Skip, ◂ ▸); save status in the posture bar with Review/Retry; 16-bar pages kept. `notation-*` model/engrave/store/render suites unchanged and green. Engraving geometry matches `score-geometry.json` (as ST3); lanes and score PNGs are reviewed side by side with `baselines/legacy/`. | L |
| **ED6** | Edit · Details | `src/edit/details/{details,fields,artwork,match,bulk}.js`, `src/styles/views/edit/details.css`, `tests/edit-details.test.js`, `tests/fixture/states/edit-details.cjs` | BK7, wave 2 | Spec §5.3 + G1–G17: per-field autosave on blur (textarea debounced 1 s + flush on unmount and pagehide), inline Saved, Revert with `unlock`, client validation via `shared/metadata.ts`, live server updates that never overwrite a focused or pending field; artwork upload/choose/remove (2 MB, JPEG/PNG/WebP, `createImageBitmap` check); Match section (status copy §6.9, Yes → `confirm`, Find another with results, Albums/covers, field-diff review → `update` with `match`, attribution ≥ 12 px); `#match` scroll; bulk mode via `getMany` with "Apply to N songs" rows and Revert through `updateEach`. | L |
| **SH1** | Share dialog, Shared Stage, demo | `src/share/{share-dialog,shared-stage,shared-practice,demo}.js`, `src/styles/views/share/*.css`, `tests/share.test.js`, `tests/fixture/states/share.cjs` | wave 2 | Spec §6.1 (the dialog copy, toggles, Copy link → "Copied ✓" 2 s, Stop sharing confirm, `VITE_SHARE_ORIGIN`) and §4.13 (read-only Stage, the Shared-by identity, Add to my library / Sign in to keep a copy with `?save=1`, local practice keyed by token with the one-time notice, migration into the saved copy, Edit hidden, theme picker gone). Demo: Open example → `/share/<token>` with Minus me per the profile. | M |
| **PD1** | Pedal mode, MIDI, Pedals & keys settings | `src/app/pedals.js` (add `startPedals`, `learn`), `src/app/midi.js`, `src/settings/sections/pedals.js`, `src/styles/views/settings/pedals.css`, `tests/app-pedals-runtime.test.js`, `tests/pedal-session.test.js` | wave 2 | Spec §7.5: learn 2–4 pedals with hold detection; profiles and Custom (pedal-flagged commands only); pedal bindings take precedence only in pedal mode; the ⎍ indicator flag in the store; the double-tap fallback; setlist right-hold. **Scripted 10-minute pedal-only session** (`tests/pedal-session.test.js`): fake clock + fake engine; pedals only (Again, Play/Stop, next/prev section, trainer start via a custom binding) → the trainer completes all steps, the pass counts are correct, and no pointer events occur. Web MIDI learn and bindings (Chromium/Electron); the desktop Background shortcuts row with per-item failures and the Accessibility prompt. | M |
| **CM1** | Stage coach marks | `src/stage/coach.js`, `src/styles/views/stage/coach.css`, `tests/stage-coach.test.js` | wave 2 | Spec §6.6.5: steps 1–3 + the unmapped step 4, `1 of 3 · Skip`, dismissed by doing the thing, never while playing, account bitmask. | S |
| **DT2** | Desktop renderer integration | `src/app/{desktop-menu,notify-ready}.js`, `tests/app-desktop-menu.test.js`, `tests/app-notify-ready.test.js` | DT1, wave 2 | §2.20: spec built from registry defs; only Mod accelerators; enabled/checked from `when`/`checked`; re-sent on change (debounced); onCommand / onNavigate / onFlushRequest / onFullScreen; `setActivity` driven by `store.stage`. Notify-ready: on a listActive diff (separate/import done and the song present) → toast (held while playing) and, desktop unfocused + `notifyReady`, a native notification; failures (not cancels) → "Couldn't add {title}". Desktop first run: the Add sheet opens once. | M |

### 9.10 Integration I3
1. Route Edit tabs and `/edit/details`; wire `coach.js` into `stage.js`; wire PD1 `startPedals` and DT2 into `main.js`.
2. Delete everything §8 lists for I3. Extend the source guards to `src/js`.
3. Register the Edit/Map/Chart definitions in `registry-ci.test.js`.
4. Run §10.5.

### 9.11 Wave 4: finish
| ID | Title | Owns | Deps | Acceptance | Size |
|---|---|---|---|---|---|
| **V1** | Cleanup, full baselines, audits, release | `convex/schema.ts` (remove `songs.practice` after `backfillB1` on prod), `src/app/placeholder.js` (delete), orphan modules, `tests/fixture/baselines/**`, `tests/fixture/probes/{probe-axe,probe-readouts,probe-perf}.cjs`, `docs/ux2/release-notes.md`, `package.json` version `2.0.0` | wave 3 | The full §10.6 suite; every visual baseline recorded and reviewed; axe with no violations; target-size and focus probes pass; readout sizes per Distance; perf budgets met; the device matrix (§10.7) checklist filled in by the owner; release notes. | M |

---

## 10. Verification plan

### 10.1 Always (every package and integration)
- `npm test` (vitest: unit, DOM, convex-test and guards), `npm run typecheck`, `npm run test:desktop`, `npm run test:companion` (from CPA on), and `python -m unittest discover -s companion -p 'test_*.py'` (from CPB on).
- **Registry CI** (`tests/registry-ci.test.js`, extended at each integration):
  - every def has a title and a group;
  - no key bound twice in one scope, and no unlisted shadowing in any reachable chain;
  - reserved browser keys are never bound;
  - every `CONTROL_SET` command, every `command:` used in `src/**` (static scan) and every Electron-menu id exists;
  - the `?` sheet groups equal the registry groups.
- **Guards** (`tests/guards.test.js`): §7.6.

### 10.2 Waves 0A / 0B (I0A, I0B)
- **Unit and backend:** every package's tests, §5.4 items 1–11, `convex-test` for BK1–BK7, `node --test` for desktop and companion, Python error classification.
- **Fixture:** after I0A the old app still runs in the fixture and the legacy baselines (FX1) are recorded. After 0B the old app is **not** expected to keep working (slim list rows, chrome-less chart, `settings.save` gone); nothing captures it again.
- **Probes:** none (no new UI yet).
- **Deploy check:** `npx convex dev --once` pushes the schema; `backfillB1` runs on dev. BK1's convex-test asserts that `songs.list` for a 1,000-song synthetic library (mapped, with practice) is < 2 MB of JSON.

### 10.3 Wave 1 (I1)
- **Fixture captures** (`npm run fixture:capture`, laptop 1440×900 and iPad 820×1180 × light and dark), states:
  - `shell.cjs`: sign-in, sign-in error, welcome, fatal, paused, export-only banner, offline banner, codec banner, avatar menu (web, desktop, admin, update ready);
  - `library.cjs`: first run (web, desktop), continue + recents, pinned and setlists rows (read-only display), grid, list, grouped by album and by artist, each filter chip, drill-down chips, no results, empty filter, loading skeleton, "Still connecting…", processing cards (every stage), failed card, needs-review chip + popover, Jobs chip and popover (every job kind, bot-check retry pending, offline device);
  - `app.cjs`: palette (empty, `57`, `75%`, `loop 41-48`, songs), the `?` sheet, toasts.
- **Probes:** `probe-targets.cjs` (fine ≥ 24, coarse ≥ 44) and `probe.cjs` (focus ring visible on every focusable) on the Library and Settings placeholder pages; `probe-touch.cjs` updated for card long-press → menu (menu stub until LB3).
- **Desktop smoke** (`node scripts/smoke-desktop.mjs` on a packaged build, when available).

### 10.4 Wave 2 (I2)
- **Unit:** the "unmapped never renders Bar" suite across `position`, `hud`, `strip`, `roadmap-surface`, `stems-surface` and `chart-surface` (render each with an unmapped fake session and scan the text content); the Distance computed sizes (Position 52/64/84 rail, 44/56/72 band; Section 32/40/52); the dock width ≤ 700 px.
- **Fixture captures:**
  - `stage-frame`, the HUD and controls: rail and band × chart, road map, wave page and stems × stopped, playing, count-in, looping, trainer, Focus, plus every sheet (speed, click, mix, loop, spots, notes, tap beat, get bars), the glass pill, the hold ring, resume chip, load error, loading ring, Distance Kit spot checks, iPad landscape spot checks;
  - `add.cjs` (desktop with candidates, single-result fallback, Spotify, files with a non-audio flag, duplicate, defaults expanded, every inline error, web explainer, B5 picker online/offline, the "Adding" divider + toast);
  - `library-actions.cjs` (selection bar, bulk delete dialog, card menu web/desktop, re-split dialog, setlist page, add-to-setlist);
  - `settings.cjs` (every section, web and desktop).
- **Interaction flows (Playwright + CDP touch):**
  - `flows/rehearsal.cjs`;
  - glass: touch tap while playing never seeks, a mouse click does;
  - long-press menus;
  - hold-to-leave;
  - sheet swipe-dismiss;
  - iPad loop drag and handles on the road map, stems and chart;
  - resume after reload restores cue, loop, speed, mix, surface and scroll;
  - Esc never navigates while playing;
  - the keyboard-only rehearsal (< 10 keys from Library).
- **Probes:**
  - targets (dock ≥ 56 rail / 64 band, Play ≥ 72/80, ≥ 12 px gaps around Play);
  - focus;
  - `probe-readouts.cjs` (computed font sizes per Distance);
  - `probe-perf.cjs`: main thread ≤ 4 ms per frame while playing (Performance API long-task + rAF sampling over 10 s on chart and road map); open → Play enabled no slower than the 1.9 baseline measured in FX1 (recorded in `baselines/perf.json`); a 64-bar chart relayout ≤ 300 ms (laptop; the iPad Air gate is manual, §10.7).

### 10.5 Wave 3 (I3)
- **Unit:** the editor suites unchanged and green; `notation-editor.test.js` updated only for the documented key-scope change (D18) and frame slots.
- **Fixture captures:**
  - `edit-frame`/`edit-map` (mapped, unmapped "Get a map", inspector sections, Find panel searching/auditioning/committing, markers banner, iPad portrait sheet);
  - `edit-chart` (score, lanes, each inspector tab, Edit ▾, Part ▾, Drum keys dialog, iPad kit bank, save statuses);
  - `edit-details` (single, bulk, matched, uncertain with a suggestion, lookup unavailable, field error);
  - `share.cjs` (dialog new/created/active, Shared Stage signed in/out/saved/unavailable, demo).
- **Compare** Transcribe score and lanes against `baselines/legacy/`: the geometry check passes, and the PNGs are reviewed side by side (colour and font changes are expected; layout and notation are not).
- **Flows:**
  - Stage ↔ Edit keeps playback;
  - Find a chart audition then Keep my map leaves the map, the undo stack and the saved tempo unchanged;
  - Done returns to the same Stage position.
- **Pedal session test** (PD1) and the MIDI learn unit test.
- **Desktop:** the menu reflects the song state (manual check in `npm run desktop:dev`), ⌘W closes the song, ⌘N opens Add, ⌘, opens Settings, background shortcuts register or report failure, a notification while unfocused, the quit-guard flush.

### 10.6 Wave 4 (V1)
- The full capture set (≈ 80 states × 4 variants + spot checks). `animations: 'disabled'`, masked clocks and playheads, threshold 0.1–0.2%. Baselines are rebaselined only in reviewed PRs.
- **axe** (`probe-axe.cjs`, `axe-core@4.10.3` injected): no violations on every captured state.
- **Stage semantics:** the h1 title, "Now playing" group, "Transport" toolbar, "Sections" nav slider with `aria-valuetext`.
- **Announcements:** sections off by default; trainer steps, count-in start and job completion polite, throttled ≥ 2 s.
- Reduced motion everywhere (lamps still change per beat).
- The release checklist: the Electron smoke test on all three platforms, release notes.

### 10.7 Real-device matrix (owner, per release; informational, never gating code)
- **iPad Air and mini:** Safari tab and home-screen app × iPadOS 17 and 18.
  - Wake lock held and re-acquired.
  - Interruption pause (call, Siri, other audio).
  - Media Session buttons (record the result; copy never promises them).
  - 64-bar chart relayout ≤ 300 ms.
- **Laptop:** pedal (PageUp/PageDown page-turner) out of the box; MIDI pad in Chrome and Electron.
- **Listening checks** (§5.4 item 13).
