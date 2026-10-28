# Wave 2a package handoffs
Collected from each package's implement and fix passes (later passes supersede earlier ones).

## LB2a

### pass 1

Where the contract was silent (choices made, not contract changes):
- Handles also expose retry(), dismiss(), error (a signal), jobId, file and promise. promise resolves {jobId}, resolves null on cancel, and rejects with the mapped error (a handler is attached so an unawaited failure is not reported).
- add-model.js also exports defaultsParts, stemsFor, stemCount, STEM_MODES, isAudioFile, audioFiles, canonicalUrl, removesMyStemLine and COPY; dropzone.js and upload.js export COPY too.
- A file waiting for its turn in a batch is already 'uploading' at 0 bytes, so every file of a batch shows in Jobs and in the "Adding" group straight away.

Requests:
1. BK2 + BK3 + CPB (title override; LB2b acceptance depends on it): upload.js sends a single file's title override as createSeparation meta.title, with the label kept as the file name. Today worker.progress overwrites meta.title with the processor's metadata, and worker.finish titles the song from the file's tags or name. So the override shows on the job card but not on the finished song. Proposal: have createSeparation store meta.title for an upload as a protected title override (e.g. job.titleOverride). worker.progress must not overwrite it, and worker.finish should use it as the song title, ideally with a 'title' metadata lock.
2. LB2b (wave 2b):
   - Read the staged files with takeStagedFiles() on mount.
   - Call startUploads(files, {settings, deviceId, title}). It is safe to call uploadDevice() first so a missing processor shows inline before the sheet closes.
   - The toast's Undo is handle.cancel().
   - Use defaultsParts for the bold words, removesMyStem/removesMyStemLine, audioFiles and COPY.notAudio, and findDuplicate against store.library.songs.value.
   - Files over 1 GB fail with the generic "unknown" sentence (Details explains), so the sheet may want to flag them inline.
3. LB1b (optional): upload entries now offer retry(), which re-uploads the file. A "Try again" action on a failed upload row could call entry.retry() instead of showing no retry.
4. BK1 (optional): adding resolvedUrl to the songs.list row would let findDuplicate match a pasted link against search-added songs. The matcher already reads it when present.
5. Owner copy to confirm (recorded, not blocking):
   - "Drop to add files" when the browser hides the count.
   - "Your part won’t be a separate track with this layout." for the Other instrument.
   - "This file is larger than 1 GB, the most Woodshed can add." in upload Details.
   - The defaults line leaves out "Split for …" when there is no profile or the instrument is Other.
6. Integration (I2a): no wiring needed; main.js already resolves ../library/dropzone.js#startLibraryDrop. The LB2a states need no peers. lb2a-drop-add accepts either the /add placeholder (files still staged) or LB2b's sheet (files taken).

### pass 2

This updates the LB2b instructions given in the previous handoff (only the call changes):
- Call startUploads(files, {settings: <stored account settings>, profile: <account profile>, choice: <Change panel {stemMode?, preset?} or null>, deviceId, title}).
- Do not resolve the settings beforehand. upload.js applies jobSettings(profile, settings, choice) itself, so anything put in settings.stemMode without addDefaultsSaved is replaced by the default; a chosen layout must come in through `choice`.
- For the defaults line use defaultsParts(profile, settings, choice).
- For the warning use removesMyStem(profile, stemMode, jobSettings(profile, settings, choice)), so a Custom 6-stem model counts as six stems.

Contract notes (additions only, nothing breaking):
- New exports: add-model.js jobSettings and upload.js CANCEL_RETRY_MS.
- Optional new parameters: stemsFor and stemCount take (stemMode, settings?, preset?); removesMyStem takes an optional third settings argument; startUploads and startUpload take profile and choice.
- Behaviour change: cancel() during createSeparation now resolves only after the race is settled, which can take up to about 4.25 s if jobs.cancel keeps failing. It returns false if the job could not be canceled; the handle is then 'queued' with its jobId.
- Behaviour change: DRAG_IDLE_MS is now 1000 ms.
- Copy for the owner to confirm: none new.

The earlier requests (BK2/BK3/CPB title override, LB1b retry, BK1 resolvedUrl) stand unchanged.

## SE1

### pass 1

- **PD1:** `src/settings/sections/pedals.js` is owned by SE1, so PD1 needs an ownership grant on it in packages.json to complete the section. Today it is the stub row 'shortcuts' (Button command app.shortcuts). PD1 should use `settingRow`, `createSaver` and `desktopNote` from `src/settings/settings.js`. The forward note about the Accessibility button (`setBackgroundShortcuts(true, {promptAccessibility: true})`) belongs there.
- **SE2:** `processing.js` and `plan.js` are found automatically through the lazy glob. Default-export `{id, title, render(el, ctx) → {destroy}}`. ctx holds `{router, account, prefs, platform, desktop, install, store, registry, feedback, layout, headingId, window}`. Reuse `createSaver`, `settingRow({row, label, hint, scope, controls, saver, labelId})` and `desktopNote(items)` from `src/settings/settings.js`. Nav titles and the list-row summaries for 'processing' and 'plan' are in `src/settings/settings.copy.js` SECTIONS; changing them needs a ticket to SE1. A section that must be hidden on the web needs `desktopOnly: true` in SECTIONS (none does today; per spec, Processing shows on the web).
- **I2a:** no wiring is needed. /settings and /settings/:section resolve `src/settings/settings.js` through the existing routes glob (D2), and /billing → /settings/plan falls back to /settings/practice until SE2 merges.
- **Choices where the contract was silent (for the owner):**
  - The stack/split breakpoint is 899 px.
  - The Follow style row has two radiogroups, "Follow style with the side panel" and "Follow style with the bottom dock" (prefs.practice.follow.rail and .band).
  - Edge flash and Announce sections are device prefs, per §2.5.
  - Check for updates is not shown on the web, rather than going into the desktop note.
  - The web version is package.json's version.
  - Licenses lists every file in public/licenses, including Harmonix Set.
  - The license texts are imported with ?raw from public/; this works in vite build and in vitest.

### pass 2

This corrects the PD1 note in my earlier handoff:
- **What PD1 already owns:** src/settings/sections/pedals.js (packages.json:1249). PD1 needs no grant for that file.
- **What PD1 does need:** a grant or ticket on two SE1-owned files to finish the section:
  - tests/settings-sections-a.test.js, to add strict control checks for pedals if it wants them (pedals is now left out of the strict "nothing else" count);
  - src/settings/settings.copy.js: the pedals entries in CONTROLS and ROWS, and the SECTIONS.pedals summary, which today reads 'Keyboard shortcuts'.
- **Shared helpers PD1 should use:** `settingRow`, `createSaver` and `desktopNote` from src/settings/settings.js.
- **Overlapping ownership:** packages.json:897 also lists pedals.js under SE1, through the brace pattern. The integrator should settle which package owns it.

Nothing else from the earlier handoff has changed for SE2 or I2a.

## SE3

### pass 1

Requests for files SE3 does not own:
1. **S1, `src/app/main.js`** (forward.md item for SE3, Appendix C 57): `src/api/admin.js` now exists. Boot step 4 should call `api.admin.access()` (`import * as adminApi from '../api/admin.js'`) instead of `query('admin:access', {})`.
2. **BK3, `convex/admin.ts` `account` query:**
   - Job rows should include `retryAt`. Without it the page cannot offer Cancel… on a bot-check-waiting job, even though `admin.cancelJob` allows it (Appendix C item 28). The view already reads `retryAt` when present, and the harness has such a job.
   - Device rows should return `name: d.displayName ?? d.name`, matching `devices.list`, so a renamed computer shows the user's name.
3. **FX1, `tests/fixture/db/account.js`:**
   - The admin handlers are static. Please add the mutations (`admin:updateAccount`, `updatePolicy`, `revokeDevice`, `cancelJob`), filter `admin:accounts` by exact email and page it, make `admin:account` use its id (it always returns Dana) with device rows carrying `revokedBy` and `lastSeenAt` and job rows carrying `retryAt`, filter `admin:history` by `targetId`, and give history rows `_id`, `before` and `after`. Without these, changes on the full app's /admin route have no fixture handler.
   - `tests/harness/settings/admin.harness.js` has a complete stateful version that can be copied.
   - `users:me` returns `_id`, but `convex/users.ts` returns `id`, so `auth.user().id` is undefined on the fixture. The harness works around it.
4. **SE1:** Settings → Account's "Administration" link should go to `/admin` (it already exists as the `nav.admin` command).

Deviations from the contract:
- `askReason` takes two extra optional arguments beyond §2.17: `run(reason)`, which runs the change inside the dialog so server errors appear inline, and `cancelLabel`.
- COPY and CONTROLS are exported from `admin.js` and `account.js`, because the package row lists no `.copy.js` (§9.0).
- The unit tests for `src/api/admin.js` are in `tests/api-admin.test.js`, allowed by the module-test naming rule.
- The 5 s timeout on `convex/migrations.test.ts` under parallel load is a possible flake, not caused by SE3.

### pass 2

New in this pass:
- **BK3, `convex/admin.ts` `account` query:** please declare the id argument as `v.string()`, normalize it, and call `fail('not_found', 'Account not found.')` when it is not a users id. Today `v.id('users')` throws an uncoded validator error for a malformed or other-table id. The client now matches that error's message wording (`isMissingAccount` in account.js), but that depends on the server's wording staying the same.

Earlier requests, still open:
1. **S1, `src/app/main.js` boot step 4:** call `api.admin.access()` from `src/api/admin.js` instead of `query('admin:access', {})`.
2. **BK3, `admin.account` rows:**
   - Job rows should include `retryAt`.
   - Device rows should return `name: d.displayName ?? d.name`.
3. **FX1, `tests/fixture/db/account.js`:**
   - Add stateful admin mutations.
   - Filter and page `admin:accounts` by exact email.
   - Make `admin:account` use its id, and return not_found for a missing well-formed id and an uncoded validator error for a malformed one.
   - Filter `admin:history` by `targetId`, and give its rows `_id`, `before` and `after`.
   - `users:me` returns `_id` where `convex/users.ts` returns `id`.
   - `tests/harness/settings/admin.harness.js` has a complete version to copy.
4. **SE1:** Settings → Account's "Administration" link should go to `/admin`.

Contract deviations beyond the earlier pass's:
- `askReason` now also takes an optional `signal` (AbortSignal).
- reason-dialog.js exports `adminError` and `REASON_COPY.notAdmin`.
- admin.js exports `FIRST_DATA_MS`, `firstData` and `COPY.loadFailed`.
- account.js exports `isMissingAccount`.
- `mount()` of both pages now resolves once the first data arrives or after 1.5 s, whichever is first.

## ST4

### pass 1

I2a:
- Add `() => import('../src/stage/commands.js')` to DEFINITION_MODULES in tests/registry-ci.test.js. It is the only thing keeping registry-ci red. Also add src/stage/controls.js to CONTROL_MODULES.
- Then run the ST4 states with --strict-requires; they need ST5's hud.js/controls.js and ST6's strip.js.

F2 ticket (router, src/app/router.js):
- Today a rejected ctx.getSession (deleted song, ApiError not_found) fails the transition: no view mounts, html gets data-view-error, and console.error fires.
- Please mount the session route's view anyway with ctx.session = null and ctx.sessionError = err. stage.js already renders "Song not found" with a Back to Library link for that case.
- No not-found state is in ST4.cjs until this lands.

S1 ticket (optional; main.js/global-commands): the first Library → Stage open of a page load gets no cover morph. stage.js arms its router onLeave hook when it loads, which is after that first navigation has started. Fix: have boot call `armStageEntry(router)` from src/stage/stage.js, e.g. through an idle lazy import.

ST5 (contract notes, all already compatible with ST5's committed code):
- The 'stage' context provides `anchors` (a Map; ST5's anchors.set is honoured), `wakeHeld`, `setlist` ({id, name, index, count, prev, next}), `leaveHint()` and `plateHost` (the music area). pedalMode is left for PD1.
- The frame passes `registry` to mountHud, and `stage` plus `registry` to mountControls.
- Do not mark anchors with `[data-anchor]`: position.css makes those position:fixed. stage.js uses `[data-stage-anchor]` as its fallback.
- Two issues seen with ST5's code in the frame:
  - At Distance Kit on 1440×900 the rail HUD plus controls are taller than 900 px. The frame clips the HUD (overflow hidden; the controls never move), so the Mix pill is cut off.
  - During loading the Play button label "Decoding 1 of 4" clips: structure check says 99 px needed, 94 px available.

ST6:
- The frame passes `registry` to mountStrip.
- The ST6 worktree holds untracked copies of ST4's src/stage/commands.js and stage.copy.js; they must not be committed by ST6.

LB3: song.resplit's run imports `../library/resplit-dialog.js` and calls `openResplitDialog({songId, router, desktop})`. Until that file exists, desktop shows the reason "Not built yet"; web shows "Re-split from Woodshed for desktop."

SH1: stage.share flushes the session (final), then calls `openShareDialog({session, song})` from src/share/share-dialog.js.

ST8a: stage.js calls `menus.stageMenu(session, stageApi)`, `barMenu(session, {t, bar})` and `sectionMenu(session, region)`, then Menu.open. The stage.menu command stays hidden until menus.js exists.

ST9/ST10/ST11:
- The surface opts include `stage` (read layout, distance, display and followStyle signals there).
- Optional surface methods the frame calls: setLayout(l) and setDistance(d) on relayout, and `viewport` (Stems) for the strip bracket.
- Make the scroller a `[data-scroller]` inside the surface layer; stage.scrollUp/Down/Top use it.

ED2: Edit should start its own wake lock, interruption watcher and Media Session; stage.js stops them on unmount.

VF1 (ticket): vf1-flow-back-link looks up `getByRole('link', {name: 'Back to Library'})`. Once the real Stage replaces the placeholder at I2a, the ‹ is ST5's HoldButton (role button). The flow should click that, or run stage.leave; ST4's st4-app-back checks the same requirement.

Copy for the owner to confirm: "Song not found", "Started over" [Undo], "Couldn’t reach storage for this song’s audio.", "Missing stem audio for Drums, Bass, Vocals & Other.", the review delete dialog ("Delete “{title}”?" / "Its stems and charts are removed from your library. Shared links stop working." / [Delete song]), and "Thanks — recording confirmed".

Choices the contract left open:
- On a shared (read-only) song, S adds a local marker even when the song is mapped.
- setlist.next/prev navigate with replace, so leaving the Stage still returns to the Library or setlist page.
- The status line floats over the bottom of the music on both layouts, so nothing moves.

Reported failures:
- tests/registry-ci.test.js "loads every definition module, then passes every check" fails on this branch alone: CONTROLS in src/stage/stage.copy.js and Button({command: 'song.resplit'}) in src/stage/stage.js reference §3.2 commands, and src/stage/commands.js is not yet in DEFINITION_MODULES. That one line is I2a's job (§9.11), and with it the file passes 21/21. Same precedent as S1 before I1 (Appendix C item 56).

### pass 2

I2a:
- Add `() => import('../src/stage/commands.js')` to DEFINITION_MODULES in tests/registry-ci.test.js, and add src/stage/controls.js to CONTROL_MODULES.
- Then run the ST4 states with --strict-requires; they need ST5's hud.js/controls.js and ST6's strip.js. I ran them with all three present: 72/72.

S1 ticket from the first pass (armStageEntry at boot): WITHDRAWN. The hook now lives in src/stage/commands.js, which main.js imports eagerly. It arms on the first user input, and st4-app-transition checks the first open.

Contract additions on the 'stage' context:
- `batch(fn)`: the store's signal batch, so stage commands can group transport changes without importing store.js (D46).
- `entryGhost`, `dropEntryGhost`, `canEntryTransition`, `armStageEntry` and `ENTRY_WAIT_MS` are exported from src/stage/commands.js. stage.js still re-exports armStageEntry and ENTRY_WAIT_MS.

Layout change for ST5/ST6 and visual review: the recording banner and the status line now share one floating stack, `.stage-float` (grid-area main, bottom, above the strip). `.stage-banners` is no longer inside `.stage-main`.

Still open from the first pass:
- The F2 router ticket: mount the session route's view with ctx.sessionError instead of failing the transition.
- The VF1 back-link ticket.
- The contract notes for ST5, ST6, LB3, SH1, ST8a, ST9–ST11 and ED2.

Owner copy to confirm, added this pass: the undo text "Undid: open {spot}" (spot open) and "Undid: add Section {n}" (S on a mapped song).

Reported failures:
- tests/registry-ci.test.js "loads every definition module, then passes every check" still fails on this branch alone, as in the first pass. stage.copy.js and stage.js reference §3.2 commands, and src/stage/commands.js is not yet in DEFINITION_MODULES; ST5's hud files and ST6's strip.js also reference those commands when they are present. Adding the one line, which is I2a's job, makes it 21/21.

## ST5

### pass 1

For I2a:
1. Registry CI: add `src/stage/controls.js` (exports CONTROL_SET and CONTROLS) and `src/stage/hud.js` (exports CONTROLS) to `CONTROL_MODULES`. Add `src/stage/commands.js` (ST4) to `DEFINITION_MODULES`; that clears the registry-ci red described in ownFailures.
2. Status line (a deviation from §2.14.10's hud.js list): the HUD does not render the status line. ST4's stage.js already renders S2's statusLine with the resume chip and the detection and markers offers, and owns status.css; two role=status lines would duplicate every message. The HUD only writes to it: the hold-to-leave hint goes through stage.leaveHint() when present, else feedback.status.
3. Ticket for ST4, plate host: stage.js calls `mountHud(hudHost, {session, stage: api})` without a plate host. It should pass the music area: `mountHud(hudHost, {session, stage: api, plateHost: main})`, or expose `api.plateHost`. Without it, the count-in plate hangs just below the HUD element: fine in the band, wrong in the rail.
4. Ticket for ST4, [data-anchor]: stage.js marks anchors with `[data-anchor=<name>]` (stripHost 'strip', controlsHost 'controls', and its AnchorMap looks that attribute up). src/styles/primitives/position.css styles every `[data-anchor]` as a fixed-position overlay, which broke control layout when I tried it. Use another attribute name, for example data-stage-anchor. HUD and controls do not set the attribute; they register 'play', 'speed', 'loop', 'click', 'mix' and 'menu' in the stage context's anchors Map while mounted and remove them on destroy. Controls read the Map from the `stage` option, else from the registry's 'stage' context, because stage.js calls `mountControls(controlsHost, {session, variant})`.
5. Class names: the HUD root is `.hud` and the control set `.ctl-set`, not `.stage-hud` / `.stage-controls`, because stage.js uses those two names for its host elements and controls.css would otherwise style ST4's controlsHost[data-variant]. Identity-row inputs: `stage.wakeHeld` (or `stage.wakeLock.held`) drives ☼, `stage.pedalMode` drives ⎍ (PD1 adds it), and `stage.setlist` drives the set line (ST4's shape {id, name, index, count, prev, next} matches). The identity cover carries `data-stage-cover` and `view-transition-name: cover-<songId>`.
6. Stage commands the HUD needs from ST4: stage.leave, stage.notes, stage.menu, view.focus, setlist.prev and setlist.next. I confirmed all six exist in ST4's commands.js.
7. For VF2: in the rail, gaps are 8 px as spec §4.6 says. The '≥ 12 px gaps around Play' check (§10.4) holds in the dock (12 px, probed in st5-hud-band).
8. Owner notes, no ticket:
   - The spec's 13 px dock labels are 15/600 to keep the Stage's 15 px floor. Count-in and Mix stack icon, label and sublabel at line-height 1.05 so they fit the 64 px controls.
   - Play's visible label while loading is the first word ('Loading', 'Decoding', 'Preparing') with '62%' / '3 of 4' as a sublabel. The full string is the accessible name and the tooltip, because the full strings do not fit 96 px.
   - The Mix main zone's name is '<visible> · Minus me' (e.g. 'Drums OUT · Minus me'), which keeps the visible label in the accessible name.

Reported failures:
- tests/registry-ci.test.js 'loads every definition module, then passes every check' fails on this branch alone: the HUD uses command ids that same-wave peer ST4 defines in src/stage/commands.js. It passes once I2a merges ST4 and adds that module to DEFINITION_MODULES.

### pass 2

For I2a (the earlier handoff items 1-8 still apply):
1. Registry CI: add src/stage/controls.js and src/stage/hud.js to CONTROL_MODULES, and ST4's src/stage/commands.js to DEFINITION_MODULES. Then run the ST5 states with --strict-requires; they now import ST4's commands.js.
2. Ticket for the src/stage/undo.js + src/stage/transport.js owners (ST1a / undo owner), needed for the speed drag to be one undo step: add a gesture-bounded push. For example, undo.beginGesture(key) returns a token with end(). Pushes carrying that token merge into one step whatever their timing, and the first one never merges into an earlier step. transport.setSpeed(rate, {gesture}) would pass it through. Then ST5 opens the gesture on pointerdown in the HUD speed drag, passes it on each step and ends it on pointerup or pointercancel. Regression tests for that ST5 follow-up: a pause of more than 1 s mid-drag gives 1 step (today 2), and a +/− tap just before the drag stays its own step.
3. Contract change for §2.14.10 / Appendix C: move 'status line (role=status)' from hud.js to stage.js (ST4), which already renders it. ST5 tests that the HUD renders no role=status or aria-live. ST4 (or VF2) should add a test that the mounted Stage has exactly one role=status.
4. Ticket for ST1a: transport.again and transport.playStop should be `when`-disabled with reason COPY.loadError while session.load.phase === 'error'. The controls are now aria-disabled, but the keyboard and the registry can still run transport.again, which arms "Play when ready" behind the error.
5. For U1 (button.js), optional: trackPress keeps `fired` until the next primary pointerdown, so after a touch long-press, a later mouse right-click's contextmenu is still preventDefaulted. ST5 no longer relies on defaultPrevented, so this is harmless for ST5.

Reported failures:
- tests/registry-ci.test.js 'loads every definition module, then passes every check' still fails on this branch alone: stage.leave, stage.notes, stage.menu, setlist.prev and setlist.next are not registered because same-wave peer ST4's src/stage/commands.js is not merged. It passes once I2a merges ST4 and adds that module to DEFINITION_MODULES.
- All 27 ST5 harness states are skipped (opts.requires: src/stage/commands.js) until ST4 merges. With ST4's module present they pass 27/27 under --strict-requires.

## ST6

### pass 1

1. **ST4 / I2a, a layout bug in the frame:** stage.js puts `data-anchor="strip"` on the strip slot (`.stage-strip`), and `data-anchor` may be on other anchor slots too. src/styles/primitives/position.css has `[data-anchor]{position: fixed}` for anchored overlays, so the slot becomes position:fixed and shrinks to its content: about 255 px for an unmapped strip, and 1,792 px wide for an overflowing one. I hit this in my harness and dropped the attribute there. ST4 should name its anchor slots with another attribute (for example data-stage-anchor), or the integration should rename it.
2. **I2a:** add src/stage/commands.js to registry-ci's DEFINITION_MODULES; that clears ST6's command-reference red. Run the ST6 states with --strict-requires after the merge.
3. **ST8a (`menus.sectionMenu`):** the strip calls `sectionMenu(session, region, {t, rename})` and opens the items with `Menu.open` at the press point, or under the focused segment for keyboard menus. `region` is a section region (from position.regions(), with startBar) or a marker region. `t` is the pressed time, useful for "Extend loop to here". `rename()` opens the strip's inline Rename… field, so the "Rename…" item should call `opts.rename`. The handle returned by `mountStrip` also exposes `rename(region)`. Until menus.js exists, long-press and right-click open nothing (LB1a's precedent, Appendix C item 79).
4. **VF2 / the §10.4 "unmapped never renders Bar" suite:** the spec's unmapped chip copy "No bar grid · Get bars →" itself contains "bar ". The strip's own test removes `COPY.noGrid` before scanning; the cross-module suite needs the same exemption.
5. **Contract additions to record in Appendix C:**
   - mountStrip also takes `registry` (default: the app registry) and returns `{el, rename(region), destroy()}`.
   - strip.js exports `stripLayout`, `spanMapper`, `COPY`, `CONTROLS`, `MIN_SEGMENT_PX`, `STEP_SEC`, `SPRING_MS`, `MOVE_TOL`.
   - `ctx.focused` for unmapped songs with no markers is a `{kind: 'marker', t0, t1: t0 + 5, label: 'm:ss'}` step; mapped songs without sections use `{kind: 'bar', t0, t1, bar, label}`.
   - The suggestion tray is role=group named "Suggested sections" with the visible word "Suggested".
6. **Size:** about 1,041 product lines in strip.js and 300 in strip.css, plus tests, harness and states (about 2,490 in total) — over the M estimate; please accept under Appendix C item 40.
7. **No other ST6 items** are addressed in docs/ux2/handoffs/forward.md.

Reported failures:
- tests/registry-ci.test.js 'every command: used in src/** exists' fails on this branch alone: the strip's chips bind stage.getBars, sections.keepAll and sections.review, which ST4's src/stage/commands.js defines. It should pass once I2a adds src/stage/commands.js to DEFINITION_MODULES.

### pass 2

The earlier ST6 handoff still stands (items 1-7): ST4's data-anchor slot clashes with position.css `[data-anchor]{position:fixed}`; I2a should add src/stage/commands.js to registry-ci DEFINITION_MODULES and rerun the ST6 states with --strict-requires; the menus.sectionMenu(session, region, {t, rename}) contract for ST8a; the VF2 "No bar grid" exemption; the Appendix C contract additions; the size note.

Contract notes to add to Appendix C from this pass:
(a) The strip provides ctx.focused only after keyboard use. A keyboard focus-in or an arrow, Home or End key starts it. A pointer press on the strip, or a focus-in caused by one, withdraws it, so Enter and L then reach transport.again and transport.loopToggle.
(b) Shift+F10 with no roving item targets the section or region at the current position.
(c) A blur commits the inline rename without moving focus back to the strip; Enter and Escape return focus to the slider.
(d) A second pointer during a stopped touch scrub cancels the scrub without cueing.

No files outside ST6's ownership were changed.

Reported failures:
- tests/registry-ci.test.js 'loads every definition module, then passes every check' (the command-reference check) fails on this branch alone: the strip's chips bind stage.getBars, sections.keepAll and sections.review, which ST4's src/stage/commands.js defines. It clears once I2a adds src/stage/commands.js to DEFINITION_MODULES.
