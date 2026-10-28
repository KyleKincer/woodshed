# Wave 1a package handoffs
Collected from each package's implement and fix passes (later passes supersede earlier ones).

## CPB

### pass 1

Requests for files I do not own:
1. **scripts/build-processor.py (packaging owner).** Add 'errors' and 'sections' to the `--hidden-import` list. process.py now imports errors.py, and CPC's sections.py is loaded through a guarded import inside a function. PyInstaller should already follow both through the 'process' hidden import; listing them makes it explicit. Also consider adding `import errors, process` to `desktop_entry.py --self-check` so a missing module fails the build.
2. **Docs (architecture §6.10 item 4, integrator).** `/status` now returns `deviceId` and `userId` as null rather than leaving them out when not paired, and `version` comes from WOODSHED_APP_VERSION (null in dev). This matches the fixture fake in tests/fixture/fakes/companion.js.
3. **CPC (wave 1b).** process.py calls `sections.suggest(audio, sr, downbeats, *, duration)`. It loads the audio with soundfile, falling back to librosa, as float32 mono at the mix's 22050 Hz. It cleans the result to `{t0, label, confidence}`, clamps confidence to 0–1 and rounds t0 to 4 decimals. On a beats job, downbeats are the detected beats where beatInBar == 1. A sections job reports detect 50 "Finding sections…" and detect 95 "Saving sections…"; that copy is not in the contract and should be confirmed or changed.
4. **Client error copy (PL1 / src/app/error-copy.js).** The companion can now send `sync_failed` for a stem download failure on a detection job, as well as for upload and verify failures. The spec action is the same (Try again).
5. **Optional, for the desktop main-process owner.** Electron could pass TORCH_HOME (it already does) and WOODSHED_PROCESSOR so `modelsReady` finds `_internal/demucs/remote`; no change is needed if `--collect-all demucs` keeps the remote yaml and txt files, which it should.

No deviations from the contract beyond the additions listed in the summary.

### pass 2

New in this fix pass:
1. **BK3 / integrator: worker.progress now accepts failure reports from paused accounts.** A call with stage 'error' or `error` set is accepted on an `account_suspended` or `account_export_only` account, as long as the device token is valid and not revoked. A bot_check reported that way is not auto-retried. Everything else on a paused account is still refused. This delivers the §10.2 `account_paused` row; please note it in the contract for §6.6 progress.
   - The regression test is in `tests/convex-worker.test.js`, because `convex/worker.test.ts` belongs to BK3. BK3 may move it into worker.test.ts.
2. **Architecture §6.10 item 6 (docs):** the meta line has no `provider`, matching the contract. The resume path also sends meta again before any progress. The server sends it with the claimed job's stage, percent and message, or attaches it to the next event, so the stored stage never moves backwards.

Still open from the first pass:
- Add 'errors' and 'sections' to the hidden imports in `scripts/build-processor.py`.
- `/status` returns null for `deviceId`, `userId` and `version` when they are unset.
- Confirm or change the sections copy for CPC.
- `sync_failed` can now come from a detection stem download; this includes a body cut short mid-download.
- Optional: have Electron pass WOODSHED_PROCESSOR so `modelsReady` can find Demucs' model lists.

## DL1

### pass 1

For I1 / S1:
- main.js step 2 should `await mod.boot(match)` for /download; boot renders into #app and sets `html[data-view-ready=download]` itself.
- boot expects main.css and the icon sprite to be loaded already (§2.3.1 step 1).
- `app.download` (avatar menu, web only) should open /download in a new tab. If any desktop-reachable entry ever links to /download, `linkTarget()` in src/download/download.js already applies the in-place rule.

At I1, src/js/desktop.js (`renderDownload`) and its cases in tests/downloads.test.js can be deleted as §8 schedules; the `download-release.js` cases in that file stay.

Package tests use only the harness; there is no full-app DL1 state, because the fixture's Vite server has no /api/downloads middleware and the real-app capture comes after I1. A full-app state would need the I1 shell and either that middleware or a fixture answer for /api/downloads, which FX1 owns.

Integration note: the DL1 harness states need no `opts.requires`, since every import (U1–U3 primitives, PL1's platform.js and download-release.js) is already merged.

### pass 2

DL1 size: 1556 changed lines (6 files, after this fix pass; 1354 before it) vs S (<=400). Overrun accepted per Appendix C item 40; most of it is tests, the harness and fixture states.

Copy deviation for owner/integrator approval: the /download lead adapts spec §3.3's Add-sheet panel. The first sentence is emphasised as in the spec, but the last sentence reads "Everything you add appears in your library on every device, including iPad." instead of "...appears here and on your iPad automatically", because "here" would point at /download, which is not the library.

CONTROLS shape: DL1's CONTROLS rows carry an extra `context` field (and an optional `count`) beside {role, name}. registry-ci only reads `command`, so it is unaffected.

Earlier handoff items still stand:
- For I1/S1: main.js should `await mod.boot(match)` for /download. boot expects main.css and the icon sprite to be loaded already. `app.download` (web) opens /download in a new tab.
- At I1, src/js/desktop.js renderDownload and its tests/downloads.test.js cases can be deleted; the download-release.js cases stay.
- A full-app DL1 state needs the I1 shell plus an /api/downloads answer in the fixture (FX1).
- The DL1 harness states need no opts.requires.

## S1

### pass 1

1. I1, registry CI: add `() => import('../src/app/global-commands.js')` to DEFINITION_MODULES in tests/registry-ci.test.js. This turns the one failing case green (verified). Add desktop/menu.cjs to ELECTRON_MENU_SOURCES only once app.undo, app.redo and stage.close exist (§3.2/§3.4 packages).
2. I1, deleted tests (§9.0, declared exceptions): every case of tests/library-startup.test.js and tests/sharing-ui.test.js broke because they read the 1.9 index.html body. Both test modules scheduled for deletion at I1 (§8), so I deleted both files.
3. I1, strict runs: S1's app states and the topbar/avatar harness states declare opts.requires on src/app/feedback.js, palette.js, shortcuts-sheet.js (S2) and src/stage/session.js (ST1b). Run them with --strict-requires after the merge.
4. I1, FX1's fx1-app-boot state: in this worktree the fixture's / page cannot load main.js until S2 and ST1b merge. After the merge it boots the 2.0 shell and sets html[data-view-ready=library].
5. Unit tests for missing peers (§9.0 deviation): vitest 5 cannot vi.mock a relative module that does not exist ('Cannot find module'), so a test cannot import main.js or global-commands.js before S2 and ST1b land. app-boot.test.js and the global-commands block of app-shell.test.js use describe.skipIf on the peer files; they import inside the suite and vi.mock every peer. They run (and pass) once the files exist, which is always true at integration. Please record this in Appendix C. Optionally ticket F2 or FX1 for a vitest resolver that maps missing contract paths to an empty module so vi.mock works earlier.
6. I1, Jobs chip: `mountTopbar` returns `topbar.jobsSlot`, and `setJobsSlot(node)`. Wire `mountJobsChip(topbar.jobsSlot)` once LB1b lands. main.js returns {router, topbar} from boot(), and the top bar is also ctx.topbar and the 'topbar' registry provider.
7. Later-wave starters wire themselves: main.js resolves ./pedals.js#startPedals, ./midi.js#startMidi, ./desktop-menu.js#startDesktopMenu, ./notify-ready.js#startNotifyReady and ../library/dropzone.js#startLibraryDrop by contract path. Each is called with {router} once its module exports the function, so I3a/I2b need not edit main.js. The later-wave command modules (library/stage/edit commands) load through an eager glob the same way.
8. LB1a, LB3: the top bar owns the search field. Call `ctx.topbar.setSearch({value, onInput(value, event), onKeydown(event)})` on mount and `setSearch(null)` on unmount; `focusSearch()` is there for library.search ('/'). For Esc in selection mode (app.escape: clear search, then exit selection), provide a 'library' command context: registry.provide('library', () => ({selecting, exitSelection()})).
9. LB1a: the offline, codec and export-only banners are shell-level, in a banners row above every top-bar place's view (fatal.js mountBanners). The Library should not render its own copies of them.
10. ST4: app.escape on the Stage reads store.stage.{focus, playing}, calls the 'stage' context's toggleFocus(), and runs stage.leave when stopped and not on an iPad. Keep store.stage.playing true while counting in, so Esc never leaves during a count.
11. SE2 (owns src/js/export.js): the paused page's Export library calls `exportLibrary(onProgress)` from src/js/export.js. That only works once export.js runs on src/api (SE2's planned change); until then it fails with the error shown inline. Manage billing calls `billing:portal` through src/api/client.js; SE2's src/api/billing.js may replace that.
12. SE3: boot step 4 calls `query('admin:access', {})` through src/api/client.js because src/api/admin.js belongs to SE3 (wave 2a). Once it exists, main.js can use api.admin.access; ticket S1 if wanted.
13. I1 cleanup: src/js/startup.js keeps waitForAuthSession (and its test) only because the 1.9 src/js/auth.js imports it. Remove it (or ticket S1) when I1 deletes src/js/auth.js.
14. V1 (wave 4): when deleting src/app/placeholder.js, also drop routes.js's placeholder fallback and main.js's sign-in fallback (`renderSignIn as placeholderSignIn`). ON1's signin.js is picked up automatically through a glob, called as renderSignIn(el, {error, signIn}).
15. Choices where the contract was silent:
    - Add song navigates to /add directly instead of using command library.add, which belongs to a later wave and would fail registry CI.
    - Typing in the search outside the Library opens /?q=…; inside it (before LB1a takes the field over) it updates ?q= with replace after 400 ms.
    - The avatar menu's email row is a disabled item.
    - Settings shows ⌘, only in the desktop app.
    - app.download opens /download in a new tab with noopener.
    - Boot routes match any /share/<x>; the Shared Stage validates the token itself.
    - The fatal card's details show the full error and its cause chain.
16. Size: about 1,630 lines of product code (3,591 insertions including tests, harness and states), over the L guidance; please record it as accepted.

Reported failures:
- tests/registry-ci.test.js 'registry CI: the app registry > loads every definition module, then passes every check' fails in this worktree: topbar.js's avatar menu references nav.settings, nav.plan, app.shortcuts, app.updates, app.download, nav.admin and app.signOut. Those are defined in src/app/global-commands.js, which registry CI does not load until I1 adds it to DEFINITION_MODULES (already an I1 item in forward.md). With that line added it passes 21/21. I don't own that test file, so I did not edit it.

### pass 2

1. I1, registry CI (unchanged from the first pass): add `() => import('../src/app/global-commands.js')` to DEFINITION_MODULES in tests/registry-ci.test.js in the same merge that brings in S1. This turns the one red case green. Please also record that this test is red on S1's branch alone.
2. I1 (with SE2), backend client: src/js/backend.js imports `convex` from the 1.9 src/js/auth.js. Only the 1.9 initialize() sets that client, and the 2.0 boot never calls it. As a result, the paused page's Export library (fatal.js lazy-loads src/js/export.js, the contract path) and backend.js's other callers (companion.js, notation/store.js) fail at run time in the 2.0 shell, and the build breaks once I1 deletes src/js/auth.js. Fix it at I1: either move SE2's planned "export.js on src/api" earlier, or point backend.js's client at src/app/auth.js. Until then, a failed export shows "The export didn't finish. Try again." rather than a raw TypeError.
3. §2.18 note (for the architecture, if you want it written down): main.js now dismisses the boot status (finishStartup) after a boot route's boot(match) resolves. Boot modules (DL1's download, the Shared Stage) do not need to call it themselves, and calling it again is harmless.
4. New fixture states s1-app-stage-no-banners and s1-app-share-boot declare opts.requires on S2 and ST1b. Both passed strict on a scratch copy with the real peer files. They use the fixture song /s/glasshouse.
5. Items 2 to 16 from the first pass's handoff still apply.

Reported failures:
- tests/registry-ci.test.js 'registry CI: the app registry > loads every definition module, then passes every check' still fails in this worktree. topbar.js's avatar menu uses commands that are defined in src/app/global-commands.js, and registry CI does not load that module until I1 adds it to DEFINITION_MODULES (already an I1 item in forward.md). Please record this as an accepted, expected-red test until the I1 merge. I don't own that test file.

## S2

### pass 1

Requests for files S2 does not own:
1. tests/registry-ci.test.js (integration): set SHEET_GROUPS from `import {SHEET_GROUPS} from '../src/app/shortcuts-sheet.js'` (it equals GROUPS). This closes the forward item.
2. src/app/account.js (owner BK4/PL lineage): replace the `import.meta.glob('./feedback.js')` probe with a static `import {toast} from './feedback.js'`. feedback.js now exists, and the §9.0 peer rule forbids glob probing.
3. S1 (main.js / global-commands.js):
   - app.palette runs `openPalette()` and app.shortcuts runs `openShortcuts()`.
   - Call `provide('feedback', () => feedback)` with `feedback` from src/app/feedback.js, and pass it as ctx.feedback to the router (router.js already calls `ctx.feedback?.toast`).
   - The palette needs the 'router', 'session', 'transport' and 'store' providers. 'store' falls back to the app store.
4. ST4 / hud.js:
   - Call `attachStatusLine()` while the status line is mounted (keep its `off`) and render `statusLine.value` = {id, text, action, key, tone, durationMs}.
   - Clicking the action should run `entry.action.run()` and then `dismissStatus(entry.key)`.
   - status() falls back to a toast whenever no line is attached.
5. SH1 (shared-stage.js): call `configurePalette({songs: false, navigation: false})` at boot (§2.18 item 6). The palette also drops those groups automatically whenever `session.shareToken` is set.
6. Transport-commands owner (nav.goTo, speed.set, spot.open, trainer.toggle): the palette passes these args.
   - nav.goTo: {t} (seconds).
   - speed.set: {rate} (0.25–1.5).
   - spot.open: {id}.
   - trainer.toggle: {start, end, step, passes} as fractions, meaning "start the trainer with this configuration".
   - Commands that need args should set `palette: {hidden: true}`, unless they are nav.goTo, speed.set or spot.open, which the palette already reaches only through parsed rows.
   - Loop ranges, count-in, solo/mute rows and the ⌘Enter loop variants call the contract transport methods directly: loopRange(a, b, {label, snap}), loopBars(t, 1), setCountIn, setSoloed, setMuted.

Deviations and additions to the contract, all additive:
- feedback.form also accepts `cancelLabel` and an async `onSubmit`.
- status() accepts `tone`.
- Warn toasts auto-dismiss like info.
- Palette rows carry `modLabel` for the ⌘Enter variant.
- openPalette/openShortcuts accept a `registry` option (tests and harness); openShortcuts also accepts `chain`.
- The Navigation group is built from the registry, so it is empty until S1's nav.* commands are registered.
- The harness states need no opts.requires, because they use only merged modules.

### pass 2

The requests 1–6 from the first S2 result are unchanged; this pass adds no new requests for files S2 does not own.

Additive contract changes:
- feedback.js exports cancelAnnounce(key) (also on the `feedback` object) and LIVE_SETTLE_MS (100 ms).
- announce() text for a live region that was just created, moved or replaced is written LIVE_SETTLE_MS later. Tests that read the live region right after the first announce, or right after a dialog opens or closes, must advance that many ms.
- The live regions now sit in a persistent .app-live-host (a manual popover with data-layer=live) that follows the topmost modal host the way the toast region does.
- palette.js exports tenths().
- The shortcut sheet's handle.model is a getter that reflects the rebuilds made while the sheet is open.
- The palette's `loop <name>` row ids changed to q:loop:marker:<id> and q:loop:section:<index>. Frecency is unaffected because parsed rows are not recorded.

## ST1a

### pass 1

Contract deviations (all additive), and what ST1b's session must do with them:
1. createTransport takes more options: status (pass feedback.status, §2.9; S2 is a same-wave peer that fails to resolve even under vi.mock, so it is injected the way ST0's practice state takes it), notation (the notation session or a getter; the transport calls setChartAudio(level) when practice.chartAudio changes, including at ready), resplit (desktop only: run for the "Re-split with 6 stems" status action; without it the web copy is appended), stems (the song's stem names, used before the engine has tracks). account may be a plain AccountSettings, a signal, the account module ({value: signal}) or a getter; signals are subscribed. profile defaults to src/app/profile.js.
2. transport.ready(): ST1b must call it after engine.loadStems resolves and map.setDuration runs (§2.14.1 step 7). It applies the practice state (loop, rate, keep-pitch, mix, cue, practice.click → metronome.configure) and starts an armed Play. If the engine already has tracks at creation it runs at once. Also isReady.
3. Snapshot additions: loop.role ('listen'|'play'|null) for the HUD's "· listen" / "· you play". Countdown is {current, of, label}; label is 'Count-in · bar 17' or 'Lead-in · 0:10'. It also shows during every-pass gap counts.
4. Event additions: 'mix-sheet' {reason: 'no-part'}. minusMe()/onlyMe() return false with no matching stem; the command layer (transport-commands, ST5/ST7) should open the Mix sheet on false or on this event. minusMe(on, {undoable: false}) is the session's "open with my part Out".
5. toggleMuteAt(i)/toggleSoloAt(i) take a 0-based index in canonical order, so mix.mute.N must pass N − 1.
6. Spot counters (§2.14.1) stay with the session: ST1b wires transport 'pass' → practice.touchSpot when the loop equals the active spot. The transport only clears practice.activeSpotId on every loop edit it makes. Do not also touch spots inside the transport.
7. interrupt(reason) is not wired to engine 'interrupted' internally; PL1's watchInterruptions calls it, which avoids a double status.
8. jump() returns {t, when, label} when a quantized jump is pending, else null. goToRegion returns the region.

Ticket for F4b (engine.js owner):
- Add a public engine.cancelStopAt(). The transport calls the private engine._clearStopAt() when a loop edit (a plan change, not a discontinuity) must cancel a Play N times stop.
- engine.nextWrapAt() can return the wrap being emitted inside a 'wrap' handler (float rounding: wrap time 7.5500000000000025 vs now 7.55). The transport works around it; the engine should return strictly-later wraps (round, or skip any wrap ≤ now + 1e-9).

Size: 1521 lines in transport.js plus 1283 in the test, over the L guidance, accepted per Appendix C item 40.

### pass 2

Handoff to ST1b and the integrator (the earlier handoff stands except where noted):
- Item 6 is now accurate. The transport clears practice.activeSpotId on every loop change it makes: commitLoop, the quantized jump's outside-loop clear, Start over, the trainer's D28 loop, and Undo/Redo of loop entries. ST1b must not clear it again; spot.open/spot.save set it after their loop edit.
- New undo key 'trainer'. startTrainer pushes one value entry, describe 'trainer 70% → 100%[ · loop <label>]'. It does not coalesce, so no change is needed in undo.js.
- Stop, Pause and interrupt during a pending AudioContext.resume() now cancel the start, and a second Play returns the same pending promise.
- Size: transport.js is 1632 lines and the test is 1504, over the L guidance; accepted per Appendix C item 40.

F4b ticket (engine.js), unchanged:
- Add a public engine.cancelStopAt(). The transport now calls engine._clearStopAt() directly (no optional chaining), with a TODO to switch once it is merged.
- engine.nextWrapAt() should return strictly-later wraps; the transport's upcomingWrap() workaround stays until then.

## ST1b

### pass 1

1. **Ticket for F2 (tests/app-router.test.js):** the case "without ctx.getSession (before session.js exists) the session is null" assumes `src/stage/session.js` is absent. The router's glob now finds it.
   - Before the merge it fails because the peer imports (feedback.js, transport.js) are missing.
   - After the merge it still fails: the real `getSession` calls `songs.subscribeSong` with no signed-in client and rejects.
   - Expected fix: delete the case, or `vi.mock('../src/stage/session.js')` there and assert `ctx.session` comes from that module.

2. **ST1a seam, wired to their worktree code rather than the §2.14.3 signature:**
   - `createTransport` also receives `status`, `stems` (stem names), `notation` (the notation session) and `account`. `account` is a live view: plain getters (`.practice`, `.profile`) plus `peek()`/`subscribe()`.
   - After decode and `map.setDuration`, the session applies step 7 itself, then awaits `transport.ready()` before `load.phase` becomes `'ready'`.
   - `resplit` is not passed. The "Re-split with 6 stems" action needs a target from LB3/ST8.
   - If ST1a renames `ready()`, ticket ST1b.
   - Please record these options in §2.14.3.

3. **Additive members** (please note them in §2.14.1–2.14.2):
   - Session: `dispose()`, `disposed`, `pending` (for the quit guard), `markersToSections()` (the marker menu's "Turn into section"), `suspendSaves(on, {changed})` (ED3's hook).
   - DetectFlow: `retry()`, `offer` / `useOffer()` / `dismissOffer()` (so the Stage can render [Use them] [Not now]), `claimServerResult()`, `destroy()`.
   - NotationSession: `start()`, `error`, `chartAudio`, `listenMode`, `mapSyncPaused`.
   - `importScore(score, {notice, skipped})` returns `{count, skipped, notice}`.
   - part.js: `openPart({adoptLegacy})`, `setMapSyncPaused`, `mapSyncPaused`.
   - audio.js: `LEVELS`, `setLevel`, `level`, `replan`, and `cancel(from)` (default: every hit).

4. **Deviations:**
   - On desktop with no ready processor and no other online computer, the `canDetect` reason is "Woodshed's processor isn't running on this computer." (or "…is starting.") instead of "Needs Woodshed for desktop…", which stays the web reason. Read-only and export-only use the new `COPY.readOnly` / `COPY.exportOnly` strings.
   - A deleted song makes `getSession` reject with ApiError `not_found`. The router does not catch this; ST4 or S1 should render it.
   - `mapChange` returns null on shared (read-only) songs and while auditioning.
   - The markers offer is not shown while Edit · Map is mounted (ED3 shows its own banner); with Edit · Map mounted, the offer's action calls `mapEditor.markersToSections()`.

5. **For ST1c (test-session.js):** build sessions with `openSession(id, {songs, jobs, media, account, desktop, status, clock, createEngine, createTransport, openPart, notationPersistence, window, document, detect: {library, accountSession, navigate}})`. The three test files here show the in-memory fakes.

6. **For ST4 (stage.js):** wire the wake lock, `watchInterruptions`, `startMediaSession` and `startGestureAudio` per session (the session does not). Show `load.error` by kind (`storage`, `missing` with names, `codec`, `unknown`). The session already flushes itself on pagehide, on the page becoming hidden and on desktop flush requests.

7. **For S1/I1:** call `auth.configure({activeSession})` with the `activeSession` export from session.js. Pass `getSession` / `disposeSession` as `ctx.getSession` / `ctx.disposeSession`.

8. **Owner of src/js/notation/store.js (deleted at I1):** it still imports the 1.9 `../auth.js`, which I1 deletes. Parts opened through the session will break unless store.js switches to `src/api`.

### pass 2

1. **F2 ticket, still open:** tests/app-router.test.js "without ctx.getSession (before session.js exists) the session is null" assumes src/stage/session.js does not exist. Delete the case, or `vi.mock('../src/stage/session.js')` and assert `ctx.session` comes from that module. It must land before the integration's strict run; it is the only red in `npm test`.
2. **Contract notes for §2.14.1 (additive):**
   - New export `ACCOUNT_WAIT_MS = 1500`: `openSession` waits up to this long for `account.loaded`, in parallel with the song subscriptions.
   - Foreign tempo changes held back by pending edits, an in-flight save or an audition are re-checked whenever that gate clears.
   - A conflict answer during an audition keeps the stale baseRev, so the next save meets the conflict again.
   - Undo and redo replays never show the markers offer.
3. **Contract notes for detect.js:**
   - `retry()` no longer sends a deviceId.
   - `start()` refuses a second kind while a detection is live, with the new `COPY.busy` / `COPY.busySections`.
   - `keepAll()` is refused during an audition with `COPY.auditioning`.
4. **Contract notes for §2.14.2:**
   - New export `hasLegacyTempo(song)`, and `needsPartAtOpen(song, {readOnly})`.
   - A null or absent tempo is not legacy.
   - Read-only sessions never adopt, and part.js `adopt()` checks `!readOnly`.
5. **Unchanged from the first pass:** handoff items 2–8 (ST1a seam, additive members, deviations, ST1c/ST4/S1 notes, store.js importing ../auth.js) still apply.
