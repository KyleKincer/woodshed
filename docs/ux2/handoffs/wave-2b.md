# Wave 2b package handoffs
Collected from each package's implement and fix passes (later passes supersede earlier ones).

## LB2b

### pass 1

Tickets for the integrator:

**LB2b-1 (LB2a, tests/fixture/states/LB2a.cjs).**
- Failing check: `lb2a-drop-add` (all 4 runs). After the drop it reads `takeStagedFiles()` as soon as `location.pathname === '/add'`, before the real sheet has mounted, so it takes the files itself.
- Expected: wait for `html[data-view-ready=add]` (state `attached`) right after the pathname wait. A scratch copy with only that change passes; the sheet then lists all three files, including "notes.pdf isn't audio…".

**LB2b-2 (LB1a, src/library/home.js and/or src/library/library-model.js `addingJobsOf` ordering).**
- Spec §3.2 says the new card appears at the front of the grid under "Adding". Today the Adding group orders failed, then running, then uploads, then queued, so a just-queued job is last in the group.
- Expected: the most recently created job (and an upload in progress) first in the Adding group. The sheet already focuses the card, scrolls it to centre and rings it wherever it sits (lb2b-adding checks this).

**LB2b-3 (FX1, tests/fixture/lib/structure.cjs `findOverlaps`).**
- Two targets inside different open overlays (a Menu opened inside a modal `<dialog>`, placed there by `pushModalHost`) are compared as if they were one layer.
- Expected: skip pairs whose `overlay` indexes differ. `lb2b-picker-online` works around it with `structure.ignore: ['.lib-add-form']`.

**Deviations from the contract (please record):**
- **Title override sent only when edited.** The single-file title is sent as `title` only when the user changes it from the file-name prefill. This keeps a file's own tags from being overwritten and locked to its file name (I2a-6 locks the title).
- **Chosen candidates go as `url` sources.** A chosen B4 candidate, including one found for a Spotify link, is sent as `source {type: 'url', value: candidate.url}` with `confirmed: true`. The single-result fallback keeps `search` or `spotify` with `confirmed: false`.
- **Desktop first run.** The sheet shows the first-song placeholder and marks `onboarding.desktopFirstRun` itself. Nothing opens the sheet automatically after `processor.firstRun` (§2.19); that is not in any package row.
- **Explainer download link.** On iPad, or when there is no installable platform, the primary is "Get Woodshed for desktop ↗" linking to `/download`; Copy and Share use `${origin}/download`.
- **Added copy not in the spec:** the no-results line, the Undo results "Stopped adding …" and "Too late to undo…", "Added … Add another, or close this.", the title-field hint, the estimate note, and "The files above are added. Remove them to add a link or search instead." All are in `add-sheet.copy.js`.

**Size:** 3,381 inserted lines (the test file is 981 of them), over the L guideline; recording under Appendix C item 40 is requested.

### pass 2

Tickets LB2b-1 (the LB2a `lb2a-drop-add` race), LB2b-2 (LB1a: the newest job first in the Adding group) and LB2b-3 (FX1 `findOverlaps` across overlays) are unchanged from the first pass.

Once LB2b-2 lands, LB2b should add a check to `lb2b-adding` that the ringed card sits first under the "Adding" divider (review finding 13). Until then, that check would fail on today's ordering.

**New deviations to record:**
- **Quality estimate wording.** Each option reads "Balanced · ~2 min", with the separate note "Estimates on this computer, from the songs it has split.", instead of the spec's "~2 min on this computer" on every option. This keeps the three Quality segments from overflowing in the 640 px dialog.
- **Two-part layouts and "Use these for future songs".** With a two-part layout (drums, vocals or bass + rest), the box saves only `{preset}`. `stemMode` and `addDefaultsSaved` are not written; `profile.js` `addDefaults` never returns a two-part mode. A visible note says so. New copy: `saveTwoPart`.
- **Source icon.** The sprite has no brand marks, so the candidate rows use generic icons: `play` for YouTube, `cloud` for SoundCloud, `link` for anything else.
- **Failed add after closing.** If the sheet is closed while an add is in flight and it fails, a warn toast appears. New copy: `notAdded` ("The song wasn't added. <sentence>").
- **A Spotify link with no YouTube candidates** falls back to the Spotify single-result line and is added unconfirmed.
- **Lookup retry.** A lookup that fell back while the processor was not up (or with `aborted`, `timeout` or `processor_offline`) runs again once the processor is ready or busy (architecture appendix item 35).

## LB3

### pass 1

Requests for the integrator (I2b) and tickets on files LB3 does not own:

1. **LB1a, src/library/home.js — selection wiring (needs a grant; the forward.md I1b note says to ticket it with LB3).** tests/harness/library/library-selection.harness.js does this wiring on real cards and can be used as the reference.
   - Import `{sharedSelection, selectionClick, selectionContext}` from './selection.js'.
   - `const selection = sharedSelection(); selection.setOrder(() => visibleSongs.map(s => s.id));`
   - In `songOpts`: `selecting: selection.active.peek()`, `selected: selection.has(song.id)`. The `onOpen` callback should start with `if (selectionClick(selection, s.id, event)) return true;` before the existing plain-click check, so Cmd/Ctrl-click, Shift-click and a plain click while selecting become selection gestures.
   - Read `selection.ids.value` and `selection.active.value` in the render effect so cards update.
   - Mount the bar once: `const bar = selection.mountBar(host, {router, store, desktop})`, with host at the end of `.lib-home`. On unmount call `bar.destroy()` and `selection.clear()`.
   - Spread `selectionContext(selection, {deleteSelected: () => bar.deleteSelected(), order: () => visibleSongs.map(s => s.id)})` into `libraryContext`, replacing the stub `selecting` getter and `exitSelection`. The Sort ▾ → Select item then appears through library.select's `when`. Esc, Cmd+A and ⌫ then work through LB1a's commands and app.escape.
   - The card menu's Select item already starts `sharedSelection()`, so it works once home renders the selection.
2. **LB1a, tests/fixture/states/LB1a.cjs** — `lb1a-home` asserts `g.more === 0` ("no ⋯ until the card menu exists (LB3)"). It now fails on all four variants because the card menu exists. Change it to expect one ⋯ per card.
3. **ST1a / ST4, src/stage/session.js (the createTransport call)** — the forward.md 'ST8b, LB3' item. To get the desktop "Re-split with 6 stems" action, pass `resplit: desktop.available ? () => import('../library/resplit-dialog.js').then(m => m.openResplitDialog({songId, stemMode: 'six', router, desktop})) : null`. openResplitDialog accepts `stemMode` to preselect 6 stems.
4. **SH1 (wave 3a)** — the Library card menu calls `openShareDialog({song, session: null})` from src/share/share-dialog.js (found through import.meta.glob). Until that file exists, Share… is disabled with "Not built yet". Two LB3 states (lb3-card-menu-desktop and -web) set `structure: {placeholder: true}` for that reason; drop it once SH1 lands.
5. **Contract deviations to record in Appendix C:**
   - The harness is tests/harness/library/library-selection.harness.js instead of tests/harness/library/actions.harness.js, because the latter would share a basename with U1's tests/harness/ui/actions.harness.js and break /__harness/actions. The ownership naming rule allows the new path.
   - "Add to setlist ▸ (new list inline)" is a "New setlist…" item that opens a one-field Dialog, because the Menu primitive cannot hold a text field.
   - The re-split module exports both `openResplitDialog` (what song.resplit already calls) and the contract's `openResplit(song)`.
   - `createSelection` adds `count`, `limited`, `has`, `list`, `start`, `set`, `prune` and `setOrder`.
   - The floating bar carries `data-structure-allow="overlap"` because it floats over the grid by design, as the toast region does.
   - The setlist page adds "Delete setlist…" with a confirm, since lists could not be deleted anywhere else.
6. **I2b** — add src/library/library-actions.copy.js to registry-ci's CONTROL_MODULES if the CI wants its CONTROLS. Run lb3-* states after merging home.js wiring to confirm.

### pass 2

Requests for I2b and tickets on files LB3 does not own. These replace the earlier handoff where they differ.

1. **BLOCKER for calling the LB3 feature done: LB1a, src/library/home.js selection wiring.** Without it, ⌘/Shift-click, Sort ▾ → Select, the floating bar, ⌘A and Esc only work on tests/harness/library/library-selection.harness.js. That harness is the reference wiring. Until the wiring lands, the card menu leaves Select out on purpose, because nothing would render the selection.
   - Import `{sharedSelection, selectionClick, selectionContext}` from './selection.js'.
   - `const selection = sharedSelection(); selection.setOrder(() => visibleSongs.map(s => s.id));`
   - In `songOpts`: `selecting: selection.active.peek()`, `selected: selection.has(song.id)`.
   - `onOpen` starts with `if (selectionClick(selection, s.id, event)) return true;`. A plain open of a song (navigating to /s/…) calls `selection.clear()` first.
   - Read `selection.ids.value` and `selection.active.value` in the render effect.
   - Mount the bar once: `const bar = selection.mountBar(host, {router, store, desktop})`, with host at the end of `.lib-home`. Mounting it sets `selection.hosted`, and from then on the card menu offers Select and the selection menu.
   - **Unmount: call `bar.destroy()` only. Do NOT call `selection.clear()`.** Bulk Details (/edit/details?ids=) returns to the Library selection through router.back (§2.15).
   - Spread `selectionContext(selection, {deleteSelected: () => bar.deleteSelected(), order: () => visibleSongs.map(s => s.id)})` into `libraryContext`, replacing the stub `selecting` and `exitSelection`.
   - After merging, run the lb3-* states. lb3-card-menu-desktop and -web then expect Select first automatically.
2. **LB1a, tests/fixture/states/LB1a.cjs.** `lb1a-home` asserts `g.more === 0` and fails on all four variants once LB3 merges. Change it to expect one ⋯ per card, and merge that together with LB3.
3. **ST1a / ST4, src/stage/session.js (createTransport).** Unchanged from the earlier handoff: pass `resplit: desktop.available ? () => import('../library/resplit-dialog.js').then(m => m.openResplitDialog({songId, stemMode: 'six', router, desktop})) : null`.
4. **SH1 (wave 3a).** The card menu calls `openShareDialog({song, session: null})` from src/share/share-dialog.js. Until that file exists, Share… is disabled with "Not built yet". Drop `structure: {placeholder: true}` from lb3-card-menu-desktop and -web when SH1 lands.
5. **Appendix C deviations to record:**
   - (a) The harness is tests/harness/library/library-selection.harness.js, not actions.harness.js, because of the basename clash with U1's tests/harness/ui/actions.harness.js.
   - (b) "Add to setlist ▸ (new list inline)" is a "New setlist…" item that opens a one-field Dialog, because the Menu primitive cannot hold a text field.
   - (c) resplit-dialog exports both `openResplitDialog` and the contract's `openResplit(song)`, plus `failureReport`.
   - (d) `createSelection` adds `count`, `limited`, `hosted`, `has`, `list`, `start`, `set`, `prune`, `setOrder`, and mountBar returns `{el, deleteSelected, destroy}`.
   - (e) The bar carries `data-structure-allow="overlap"`.
   - (f) The setlist page adds "Delete setlist…" with a confirm.
   - (g) **§2.18 share call shape:** LB3 calls `openShareDialog({song, session})` in the object form, matching forward.md:156 and stage.js:576. §2.18 shows `openShareDialog(song, {beforeShare})`. Amend §2.18 to the object form SH1 must implement, or tell LB3 and the Stage to switch.
   - (h) The selection survives leaving the Library (bulk Details round trip, §2.15). It ends on Done, Esc, opening a song, or a reload.
   - (i) The card menu's Select item, and its swap to the selection menu, depend on `selection.hosted`.
6. **Size overrun (§9.0, Appendix C item 40):** LB3 is past L. `git diff --stat af6c8df..HEAD` shows about 3,980 inserted lines over 13 files, against L ≤ 1500 changed lines including tests; src alone is about 1,990 lines. The earlier "No size overrun to report" was wrong.
7. **I2b, registry-ci:** add src/library/library-actions.copy.js to CONTROL_MODULES if the CI should check its CONTROLS.

## SE2

### pass 1

Tickets requested (files SE2 does not own):

1. **convex/export.test.ts (BK1's file; BK1's wave is closed, so it needs a packages.json grant or an `--allow` exception, as BK3 had at I2a).** Either delete the file's three cases, because tests/export.test.js now covers each of them plus setlists.json, pagination, the no-picker 100 MB limit, abort and picker-before-await. Or port it: replace `vi.mock('../src/js/backend.js', …)` with `exportLibrary(progress, {api: {exportPage, config, setlists, notation, signKeys, fetch}, window: {showSaveFilePicker}})`. The failing check is `npm test` (3 cases); expected green.

2. **tests/fixture/states/SE1.cjs (SE1), se1-app-nav.** With src/settings/sections/plan.js present, the laptop nav order is Practice, Instruments, Pedals & keys, Processing, Appearance, Plan & storage, This device, Account. The expectation `next === 'device'` after Appearance should become `'plan'`. Failing check: `fixture:capture --states SE1`.

Optional (S1):
- src/app/fatal.js could call `portal()` from src/api/billing.js instead of `apiAction('billing:portal')`.
- export.js now passes a second structured argument to `onProgress` (`{phase, done, total, title}`) and accepts `{signal}`, so the paused page could show a progress rail and a Cancel button.

Contract notes:
- **Copy location.** processing.js and plan.js export their own COPY, CONTROLS and ROWS (§9.0 fallback, since settings.copy.js is SE1's).
- **Extra ctx keys.** Both sections accept extra ctx keys for tests and harnesses: `companion`, `devicesApi`, `now`, `timers`, `billingApi`, `storageApi`, `exporter`, `cache`, `formatDate` and `location`. The frame never passes them, so the app uses the real modules.
- **Default stems.** Default stems writes `{stemMode, addDefaultsSaved: true}` and offers only full and six, because addDefaults ignores two-part modes.
- **Notation read.** export.js reads charts with `query('notation:get', {songId})` from src/api/client.js, because there is no src/api/notation.js wrapper.
- **Checkout query.** `?checkout=success` is left on the URL (I2a-15 and s1-app-redirects depend on it). The toast shows once per mount of the section.

Size: about 3,800 lines added, over the L guidance (§9.0, accepted as an overrun).

Reported failures:
- convex/export.test.ts: 3 cases fail ('whole-library streaming export…', 'failed download aborts…', 'exported notation is always current…'). They vi.mock '../src/js/backend.js', which src/js/export.js no longer imports now that it runs on src/api, so the real client throws ApiError not_signed_in. The file is BK1's (listed literally in packages.json), so it was not edited. The same scenarios, plus setlists.json, pagination, the 100 MB limit, abort and picker-before-await, pass in tests/export.test.js.
- tests/fixture/states/SE1.cjs se1-app-nav (laptop-light) fails: 'Tab moves along the nav (plan)'. Now that plan.js exists, Plan & storage is listed between Appearance and This device (spec order, as I2a-15 anticipated), so Tab from Appearance lands on 'plan' instead of 'device'. The file is SE1's, so it was not edited.

### pass 2

Tickets (files SE2 does not own):

1. **convex/export.test.ts (BK1; needs a grant or an --allow exception).** Still open from the first pass. Either delete the 3 cases or port them to `exportLibrary(progress, {api: {exportPage, config, setlists, notation, signKeys, fetch}, window: {showSaveFilePicker}})`. The 'failed download' case also expects the old wording and should expect EXPORT_COPY.songFailed. After that, `npm test` should be green.
2. **tests/fixture/states/SE1.cjs se1-app-nav (SE1).** Unchanged from the first pass: after Appearance, Tab now lands on 'plan', not 'device'.
3. **src/js/companion.js (owner of companion.js).** Add a `{timeoutMs}` option to `localRequest(route, body, method, {timeoutMs})`. processing.js could then go back to localRequest for /export-originals instead of calling desktopStatus() and then request().
4. **companion/server.mjs (companion owner).** Make the defaults safe at the source; the UI already maps all of these:
   - /export-originals should answer `{directory, count: 0}` when the jobs folder is missing.
   - /import should return a coded `{code: 'not_found'}` when the folder has no library.json, and `{code: 'invalid'}` for an unreadable one.
5. **src/js/media-fetch.js.** Let `fetchMedia(url, init)` pass init (signal) through to fetch. export.js could then use it again; for now it inlines the same mediaUrl routing.

Contract notes:
- plan.js now imports src/app/auth.js (user() and onChange) so a sign-out cancels an export. It accepts an optional ctx key `auth`.
- The running export is page-level state in plan.js. `runningExport()` and `resetExport()` are exported for tests and harnesses.
- On the web, processing.js calls `devicesApi.subscribeList` only when the store's devices list is empty at mount. The better fix is a `library.devicesLoaded` flag in src/app/data.js; that is optional, for the data.js owner.
- Spec deviation: the Details disclosure has no Copy button. The raw text is selectable, and leaving the button out avoids new CONTROLS rows.

Reported failures:
- convex/export.test.ts: the same 3 cases still fail. The file is BK1's: it mocks src/js/backend.js, which export.js no longer imports. Ticketed again below; tests/export.test.js covers the same cases.
- tests/fixture/states/SE1.cjs se1-app-nav (SE1's file): expects 'device' after Appearance, but the nav now has Plan & storage there. Ticketed in the first pass; not re-run here.

## ST10

### pass 1

Requests for the integrator:
1. ST4 owns `tests/fixture/states/ST4.cjs`. Once ST10 merges, `st4-frame-unmapped` fails on all 4 variants because it expects "Wave page" in `.stage-surface-later`. It should assert the real surface instead, e.g. `.stage-surface .roadmap[data-kind="wave"]`.
2. ST4 owns `src/stage/stage.js`. It reads `instance.kind` once when the surface opens, so after a live unmapped → mapped switch, `stage.surface` and `layer.dataset.surface` stay 'wave' and `view.bigger`/`view.smaller` keep their Wave titles. The surface exposes `kind` as a live getter and `el[data-kind]`. Suggestion: re-read `current.instance.kind` when `session.position.mapped` changes and update `surface.value` and the layer dataset.
3. Copy for the owner (ST4's `stage.copy.js`): `=` (view.bigger) on the Wave page is titled "Longer rows". On this surface `=` zooms in, meaning fewer seconds per row with a bigger waveform, the usual "bigger" sense; `−` gives more seconds. Either swap the copy (e.g. "Bigger waveform" / "More per row") or confirm the direction.
4. Layout seam, ST4 or I2b: the 56 px "Back to playhead" pill (bottom centre of the music) can overlap the stage's floating status line (`.stage-float`), e.g. the resume chip's "Start over". The structure check flagged it on the band when Follow was paused while the resume chip showed. ST9's chart pill sits in the same place. Suggestion: the stage lifts `.stage-float` above a visible follow pill, or offers a slot for it.
5. VF2's §10.4 "unmapped never renders Bar" suite: `roadmap-surface` produces no "Bar"/"bar " for unmapped songs, including aria-labels and ctx.focused. Unmapped grid items are `{kind: 'marker', t0, t1, label: '0:40–0:50'}`, matching the strip's unmapped steps.
6. Registry CI (I2b): `src/stage/surfaces/roadmap-surface.js` exports `CONTROLS` (grid "Bars", gridcell, grid "Song timeline", button "Back to playhead") for `CONTROL_MODULES`.

Contract additions:
- Surface opts accept `registry` (default: the app registry).
- The surface also exposes `model`, `following` and `seconds` getters, used by tests.
- `stemsOf(mix)` is exported.
- The Stage passes `stage.followStyle`, which the surface reads for scroll or page follow.

Size: about 2,450 lines including tests, harness and states, over the L guidance (accepted under Appendix C item 40).

### pass 2

The six requests from the first ST10 result still stand: ST4.cjs st4-frame-unmapped, stage.js re-reading instance.kind, the view.bigger copy direction, the follow pill overlapping .stage-float, the VF2 unmapped suite, and CONTROL_MODULES registration.

New in this pass:
7. Owner decision, follow style (finding 9; affects ST4 stage.js and ST8a menus). Spec §4.4B says the Road map holds the current row at 30% with Page style available. The surface reads stage.followStyle, which falls back to practice.follow.band = 'page', so on the band the Road map turns pages by default, and the ⋯ → Follow menu is listed for the chart only. Options:
   (a) ST4 computes followStyle per surface, so the Road map defaults to 'scroll' unless the user picked Page for it.
   (b) ST8a offers Follow ▸ on the Road map too.
   (c) Confirm Page as the band default.
   Either way, no ST10 code change is needed: the surface honours whatever stage.followStyle says.

Contract additions:
- Surface opts accept `prefs` (default: the app prefs). The surface reads and writes `roadmap.waveRowSec`; null means the layout default of 10 s rail / 8 s band. Stored values are snapped to WAVE_STEPS.
- timeAtX() in roadmap-layout.js now also returns `outside` (boolean).

## ST11

### pass 1

For I2b (registry CI, tests/registry-ci.test.js; not owned by ST11):
- §3.3 says the stems commands register on mount, so importing stems-surface.js registers nothing. Add this to DEFINITION_MODULES: `() => import('../src/stage/surfaces/stems-surface.js').then(m => m.defineStemsCommands())`. A surface mounted later reuses commands that are already registered instead of registering them twice.
- Add `() => import('../src/stage/surfaces/stems-surface.js')` to CONTROL_MODULES. Its CONTROLS table names the stems.* commands.
- The surface passes command ids to its Buttons and Toggles through the exported `COMMAND_IDS` constants, not `command: '…'` string literals. That is deliberate: the source scan cannot pass for stems.* until the definitions are in DEFINITION_MODULES. The check is complete once the two list entries above are added.

Contract notes for the integrator:
- `onLoopEdit` is called with `{a, b, aBar?, bBar?, phase}`, where aBar and bBar are display bar numbers. The Stage uses only a and b on commit.
- `onActivate` sends `beatTime` equal to the snapped `t` (the Snap setting and grid division; exact time with Snap off), so the Stage's own beat snap is bypassed.
- `setFollow(on)` does not call `onFollowChange` (the Stage updates its own `following` signal). A pause caused on the surface does call `onFollowChange(false)`, and the pill, F or a new Play call `onFollowChange(true)`.

Not done (no ST11 contract item covers it): a right-click or long-press stem menu on a row header using ST8a's `stemMenu`. Headers have M/S, the fader and keys 1–9 only. If a stem menu is wanted, ticket it after ST8a merges.

Test-only note for whoever touches surface tests: happy-dom's WheelEvent drops clientX/clientY and the modifier keys, so the unit test defines them on the event. The surface also accepts injected `raf`/`caf` options because requestAnimationFrame under vi fake timers did not fire reliably in this suite (cause not found); with the injected queue the runs are stable.

### pass 2

For I2b (tests/registry-ci.test.js; not owned by ST11), unchanged from the first pass:
- Add `() => import('../src/stage/surfaces/stems-surface.js').then(m => m.defineStemsCommands())` to DEFINITION_MODULES.
- Add `() => import('../src/stage/surfaces/stems-surface.js')` to CONTROL_MODULES. Its CONTROLS table now also names view.followResume, on the pill row.
- Once both are in, ST11 can switch its Buttons and Toggles to literal `command: 'stems.*'` ids so the source scan covers them (reviewer finding 12).

Contract notes for the integrator:
- onActivate: 'tap' and 'double' send t equal to beatTime, snapped to the nearest beat when mapped. The division is ½ / ¼ when the grid is finer, the exact time when Snap is off or Shift is held, and beats with Alt. The Stage's own beat snap is therefore bypassed, which matches spec §4.9.
- 'context' and 'long' send the unsnapped time under the pointer, with `bar` set to the bar that contains it. barMenu should loop or cue from that t.
- Follow: the surface resumes on its own after 8 s idle while playing and on the transport 'gesture' event, calling onFollowChange(true) both times. A Stop clears a paused Follow and also calls onFollowChange(true). In the Stage the pill runs view.followResume.
- Layout: the laptop % value is a separate `.stems-level` span on the M/S line (aria-hidden). The Fader runs with showValue: false, and the slider keeps aria-valuetext.

## ST7

### pass 1

Requests for the integrator:
1. I2b registry CI: add `() => import('../src/stage/sheets/sheets-a.copy.js')` to CONTROL_MODULES in tests/registry-ci.test.js (CONTROLS rows reference edit.map, stage.tapBeat, stage.getBars, song.resplit).
2. Ticket for ST5 (hud.js) or ST4 (stage.js): the "Flash screen edges on downbeats" toggle writes prefs `practice.edgeFlash` (as Settings → Practice already does), but nothing draws the flash yet. Per §5.2 and spec §4.7: on `metronome.onBeat` events with `downbeat` true and the pref on, a 6 px --now inset glow on the Stage edges, 60 ms in / 180 ms out; reduced motion: on/off, no fade.
3. Copy difference to note: spec §4.7's Mix-sheet line puts quotes around 'Other' ("Muting 'Other' instead."). The Mix sheet uses the spec text, but transport.js `COPY.noPartFallback` (ST1a, status line) has no quotes. Align one of them if wanted.
4. For the Stage's "exactly one role=status" check: the Segmented primitive (U1) always renders a hidden `role=status` reason note, so an open Click or Mix sheet adds hidden role=status nodes. My sheets add none of their own; the only live element is the InlineStatus `role=alert` shown when a profile save fails.

Deviations and choices where the contract was silent:
- D59 "band" is read as the sheet being presented as a bottom sheet. Edit's slim transport also opens bottom sheets, so presets close the sheet there too.
- "Full mix" is always enabled; it does nothing on a full mix.
- The edge flash and Visual click section are hidden on unmapped songs (downbeats need a bar grid).
- The Mix sheet imports `stemLabel` from transport-commands.js, which already registers on the app registry at boot.
- Sheets take optional injected deps (`layout`, `registry`, `prefs`, `account`, `desktop`) beyond the §2.14.11 `{session, close}`. The host passes only `{session, close}`, so in the app the app modules are used.

Size: 2,433 added lines (L).

### pass 2

1. I2b registry CI: add `() => import('../src/stage/sheets/sheets-a.copy.js')` to CONTROL_MODULES in tests/registry-ci.test.js. CONTROLS now also names speed.set, speed.downFine, speed.upFine, trainer.toggle, loop.eachPass, click.mode, mix.minusMe, mix.onlyMe, mix.full and mix.chartAudio, as well as edit.map, stage.tapBeat, stage.getBars and song.resplit.
2. Ticket for ST5 (hud.js) or ST4 (stage.js), still open (finding 9): draw the "Flash screen edges on downbeats" flash. On metronome.onBeat with downbeat true and prefs `practice.edgeFlash` on, show a 6 px --now inset glow on the Stage edges, 60 ms in and 180 ms out; with reduced motion, on/off with no fade (spec §4.7, §5.2). The edge flash is not done until this lands.
3. Dependency for ED2: the sheets now run their controls through the app registry. In Edit's slim transport, the sheets' command controls work only once Edit provides the 'session' and 'transport' contexts (already in the forward.md I1b → ED2 handoff). Until then they show as unavailable there.
4. Flaky test ticket (owner of scripts/wt.mjs tests): tests/scripts/wt.test.js:252 `not.toMatch(/B1/)` matches the random mkdtemp suffix (it failed with /tmp/ws-wt-JB1EQ5). Anchor the match to the start of the line, e.g. /^B1\s/m.
5. Still open from the first pass: the quotes around 'Other' differ between transport.js COPY.noPartFallback and the Mix sheet (the Mix sheet follows spec §4.7). The Segmented primitive always renders a hidden role=status reason note.
Deviations: trainer Start/End steppers keep 5% steps, so an off-grid stored or palette trainer is snapped to the grid (shown and restarted at the snapped value) rather than the steppers being widened to 1%. New copy key COPY.mix.chooseShared.

## ST8a

### pass 1

Contract deviations and choices, for the integrator:
1. **Edit key-cap.** The contract shows "Edit details E", but E runs `edit.open`, which opens the last Edit tab (`prefs.edit.lastTab`, default map). `stageMenu` therefore puts the E key-cap on whichever Edit tab E would open.
2. **Extra builder signatures.** The contract names the spot, marker, loop-band and stem menus without signatures. They are `spotMenu(session, spot, {rename?, onOpen?})`, `markerMenu(session, marker, {rename?})`, `loopBandMenu(session, {zoomToLoop?})` and `stemMenu(session, stemName, {account?})`. Every builder also takes `opts.registry`, `opts.feedback` and `opts.account`, defaulting to the app's. ST8b's Spots list can reuse `spotMenu`, `saveSpot` and `updateSpotFromCurrent`.
3. **Spot Open row.** It runs `registry.run('spot.open', {args: {id}})` from the item instead of `{command: 'spot.open'}`. The Menu primitive resolves a command's state without args, and `spot.open`'s `when` needs the id.
4. **Zoom to loop.** The loop-band menu offers it through `opts.zoomToLoop`, else `stems.zoomLoop` while that command is registered (ST11 registers it on mount). The id is held in a const, so the static `command:` scan does not need the Stems definitions yet.
5. **Loop card in/out labels.** The visible labels are "Loop in here" and "Loop out here" so they fit the 360 px popover. The command titles stay the tooltips.
6. **Unmapped wording.** The unmapped "1 bar rest" option reads "2 s rest", which is what the transport does there (rule 9).

Requests for files ST8a does not own:
- **I2b / registry CI:** add `src/stage/menus.js` and `src/stage/sheets/loop.js` (their `CONTROLS`) to `CONTROL_MODULES` in `tests/registry-ci.test.js`.
- **ST4, optional:** `spot.save` could take `args.name` and `marker.add` could take `args.t`. menus.js then would not need its own `saveSpot` / `addMarkerAt` copies of `saveSpotHere` / `addMarkerHere`.
- **U2 / ST6 visual check:** in the iPad harness captures, the strip's `.strip-playhead` (`will-change: transform`) paints a 1 px line over the `:popover-open` bottom Sheet. It is visible in the captures but not hit-testable. Worth checking in VF2 on the real Stage.
- **U2:** Menu rows use `--fs-14` in the Stage, below its 15 px text floor.

Verification note: the full `npm test` hit 5 s timeouts in unrelated suites under load from parallel worktrees. They pass with a longer timeout.

### pass 2

Requests for files ST8a does not own:
1. **Session owner (src/stage/session.js):** expose a read-only `top` getter on `session.undo` that returns the internal `topEntry`, or a public `session.undoEntry(entry)`.
   - `boundUndo` already uses `undo.top` when it exists, so this needs no change in menus.js.
   - Until then it uses the snapshot comparison described in finding 1. That comparison is conservative: a foreign-device sync or a non-volatile practice patch made after the step marks the Undo as out of date, and it shows the stale message instead of undoing.
   - `transport.clearLoop()` returning its undo entry, or `undo.top`, would let the Loop card bind to the exact entry.
2. **ST4 (src/stage/stage.js:588, Start over):** its status Undo runs `practice.undo` without checking which step is on top, the same defect as finding 1. Switch it to `boundUndo(session)` from menus.js, or to the session hook once it exists.
3. **Spec/architecture conflict:** on shared songs the ⋯ menu and section menu now hide the Edit rows, following spec §4.13 ("Edit is hidden"), instead of disabling them as architecture §2.18 item 10 describes. The `edit.*` commands' `when` checks still guard the keys. SH1 or the integrator should align §2.18.
4. **Contract additions:**
   - New menus.js exports: `boundUndo`, `turnReason` and `secondsLoopAt`.
   - New COPY strings: `undoStale`, `signInForMine` and `noPartBefore`.
   - The CONTROLS `when` field may now hold several space-separated conditions, and a new `'owner'` condition marks rows hidden on shared songs.
   - A new `via` field marks the spot Open row as one that runs `spot.open` itself rather than being bound to it. When menus.js joins `CONTROL_MODULES`, registry CI should treat `via` as a reference to an existing command, not as a command binding.
   - `stemMenu` takes `opts.signedIn`, which overrides the `account.loaded` check.
5. **Still open from the first pass:** add `src/stage/menus.js` and `src/stage/sheets/loop.js` to `CONTROL_MODULES` in tests/registry-ci.test.js; optionally let `spot.save` take `args.name` and `marker.add` take `args.t`; the U2 Menu row font-size and the strip playhead painting over the Sheet in iPad captures.

## ST8b

### pass 1

Requests for I2b (files ST8b doesn't own):

1. **Get bars popover jitters on the rail (src/stage/sheets/host.js from ST4, src/ui/position.js from U2).** With no `getBars` anchor, the sheet anchors to the full-width strip with placement 'left'. In Chromium's CSS-anchor mode, the `data-fit=shrink` check in `anchorTo` then flips the popover between 360 px and 248 px wide every frame, and it covers the rail. Seen in st8b-getbars-online and st8b-getbars-web on the laptop. Two fixes are possible: anchor Get bars to the strip's chip, or the rail controls, with a placement that fits (e.g. 'top'); or make `fit()` stable. ST8b's state works around it by sending the click with `dispatchEvent`.
2. **Toasts cover the bottom sheet on iPad (S2 feedback toast region / U2 Sheet).** The Delete-spot Undo toast lands on top of the Spots sheet's rows, so the structure check reports an overlap. st8b-spots-band dismisses the toast before its final capture.
3. **Registry CI:** add `src/stage/sheets/sheets-b.copy.js` (its `CONTROLS`) to `CONTROL_MODULES`.
4. **For ST8a's `spotMenu`:** spots.js handles Rename, Update from current and Delete itself, with its own undo entries and toast. Exposing them as shared actions (e.g. from commands.js or menus.js) would let the strip, Road map and Stems spot menus reuse them. I didn't make a cross-package stand-in.
5. **Forward item "Re-split with 6 stems" (addressed to ST8b and LB3):** not taken. It needs session.js and the re-split dialog, neither of which ST8b owns; LB3's re-split flow should pass `resplit`.

Contract notes:
- Each sheet's `render(container, {session, close})` also accepts optional `registry` and `feedback`; Get bars also takes `devices` and `desktop`. These are for tests and default to the app's.
- spots.js imports `openSpot` from src/stage/commands.js (ST4, already merged) as a fallback when `registry.run('spot.open')` can't run.
- I added a `CONTROLS` export to the copy file; §9.0 calls for one.
- Tap the beat always builds a 4/4 map, matching spec §5.1.3's result line.

### pass 2

Still open from the first pass (files ST8b doesn't own):
1. **Get bars popover jitters on the rail (host.js / position.js).** Its width flips every frame on the laptop.
2. **Undo toast covers the Spots bottom sheet on iPad** (feedback / Sheet).
3. **Registry CI:** add `sheets-b.copy.js` `CONTROLS` to `CONTROL_MODULES`.
4. **Shared spot actions for ST8a's `spotMenu`.**
5. **"Re-split with 6 stems"** belongs to LB3.

New request:
6. **Session owner (session.js):** expose on `session.undo` a way to tell whether a given entry is on top, such as `isTop(entry)` or a `top` getter (session.js already tracks `topEntry` internally for `undoEntry`). Until then, spots.js decides this from the entry's own undo/redo state plus the stack size. That check is exact except when steps fall off the bottom of the 50-step stack, where it safely falls back to bringing back just the spot.

Contract notes:
- `detectDescription(verdict, {devices, desktopAvailable, localDeviceId})` has a new `localDeviceId` option.
- New copy: `spots.restored` and `spots.describeRestore`.
- Removed copy: `tap.unchanged`.
- New exports: `spots.js` `DELETE_TOAST_MS`.
- New `CONTROLS` `when` values: `tray`, `rename`, `failed`, plus a `textbox` row.

## ST9

### pass 1

1. **ST3 ticket (one relayout per Distance change).** A Distance change needs a new scale and new label floors together. With today's chart API that is `setFonts` then `setScale`, so two relayouts. The spec says a Distance change relayouts once.
   - Please add `chart.setScale(v, {anchor, fonts})`, or `setFonts(f, {relayout: false})`, so both apply in one relayout.
   - Then `applySize()` in `chart-surface.js` becomes a single call.
2. **ST5 ticket (Count-in clips at Near).** In the rail at Distance Near (232 px, laptop 1440×900), "Count-in 1 bar" clips: the structure check says 84 px needed, 78 px available. `st9-chart-near` ignores `.stage-controls` in its structure check for this reason only.
3. **ED4 request.** The chart empty state's "Import a file" navigates to `/s/:id/edit/map/find?import=1`. The Find panel should honour `?import=1` by focusing or opening its "Import a file…".
4. **I2b.**
   - Add `src/stage/surfaces/chart-surface.js` (its CONTROLS) to `CONTROL_MODULES` in `registry-ci.test.js`.
   - Run `st9-chart-menu` once ST8a's `menus.js` merges.
   - Re-run `st9-chart-r1` and `probe-perf --metrics frameChart` in a quiet container (VF2). Every run here was provisional at load average 20–27.
5. **Contract additions to record:**
   - `createChartSurface` also takes `registry`, `router` and `prefs`; all default to the app's.
   - The surface root carries `data-state` (opening, error or chart), `data-following` and `data-relayout-ms`.
   - The bar list is the chart scroller's first child (sticky, 0 px tall), which gives the scroller keyboard access for axe.
   - The surface writes `prefs.chart.pinchScale` on pinch and =/−, and clears it on a Distance change.
   - The surface adds `data-scroller` to the chart's `.chart-scroll` and `data-press-ignore` to `.chart-score`.
6. **Size.** About 1,900 changed lines (about 610 product, the rest tests, harness and states), over the M guidance (Appendix C item 40).

### pass 2

1. **ST3 ticket (expanded; blocks R1 and the "relayouts once" contract).**
   - **The API:** add one chart call that takes scale, label floors and barsPerRow together in a single relayout, e.g. `chart.configure({scale, fonts, barsPerRow}, {anchor})` or `setDisplay({barsPerRow, scale, fonts})`.
   - **Why:** today a Distance change is setFonts then setScale, and a dense layout switch is setDisplay then setScale. Each pair is 2 relayouts.
   - **Then in ST9:** applySize() in chart-surface.js becomes one call, and `st9-chart-relayouts` should assert exactly 1.
   - **R1 numbers (provisional, load 15 to 18):** the summed Distance change measured Near 102 ms (2.29x FX0's 44.6 ms), Stand 122 ms (2.74x) and Kit 126 ms (2.83x), each with 2 relayouts. VF2 should treat this as a probable R1 failure until the single-call API lands, not as load noise.
   - **Rail-to-band resize (ST3/ST4):** it also re-engraves once more because the music area's width changes (3 engravings measured). Please decide whether the width re-engrave can be merged with the layout switch.
2. **Prefs ticket (§2.5 / prefs.js owner), else ST4 + SE1.** Add nullable `chart.pinchDistance` ('near' | 'stand' | 'kit') to the prefs schema. ST9 would then write it with `chart.pinchScale`, and `scaleFor` would ignore a pinch made at another Distance. Otherwise: Stage.setDistance and its prefs subscription (ST4), and the Settings Distance control (SE1), should clear `chart.pinchScale`.
   - **The bug:** today a Distance change made while another surface is up, or from Settings outside the Stage, leaves the pinch override set.
3. **ST4/ST8a ticket (D54 apply on release).** When the Distance menu closes (or any Distance or =/- stepper is released), call `current.instance.commitSize?.()`. The surface then applies a deferred change at once instead of after the 400 ms settle.
4. **Contract additions to record:**
   - The Surface also has `commitSize()`.
   - The root's `data-relayout-ms` is now the last size change's summed relayout cost, and the new `data-relayouts` is how many relayouts that change took.
   - A surface whose build throws removes its root before rethrowing.
5. **I2b / VF2.**
   - Run `st9-chart-r1` and `st9-chart-relayouts` in a quiet container.
   - probe-perf's relayout64 measures FX0's score-geometry harness, not a Distance change. The probe-perf owner should either add a metric that runs a Distance change on the ST9 harness, or VF2 should run `st9-chart-r1` as the R1 gate.
   - Still open from the previous pass: add chart-surface CONTROLS to `CONTROL_MODULES` in registry-ci.test.js, and run `st9-chart-menu` once ST8a's `menus.js` merges.
6. **Still open from the first pass:** the ST5 Count-in clip at Near (`st9-chart-near` still ignores `.stage-controls` in its structure check), and the ED4 `?import=1` request.
