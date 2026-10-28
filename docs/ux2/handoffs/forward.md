# Forward requests for later packages
Requests from earlier waves' handoffs, grouped by target package ID, for the orchestrator to pass on. Contract changes they rely on are in `docs/ux2/architecture.md` Appendix C. Sections addressed to packages that have since run are removed by the next integration (I0B removed F4b, ED1, U1, U2, PL1, AU1, ST0 and BK1–BK7: all done).

## From I0A (wave 0A handoffs)

### ST1b
- `DrumAudio` (`src/js/notation/audio.js`) must handle every plan change, not only scheduled rates (loop edits that keep the position, `seekAt`, `cancelPending`, later passes and gaps):
  - connect `DrumAudio.out` to `engine.aux ?? ctx.destination`;
  - subscribe to `engine.on('plan', ({from}) => …)`: cancel only hits with `when >= from` (track each entry's `when`, which `play()` already stores), then set `until = Math.min(until, from)`;
  - keep the cancel-all on `subscribeTransport` / `'transport'`.
  Until then a loop edit during Transcribe/Chart playback can leave up to 0.12 s of old-plan hits and skip the new plan's hits in that window.
- `adopt(data)` is now an undoable step (Appendix C item 7): wrap open-time drum-part adoption (`part.js`, "opening a part never creates an undo step") and silent foreign adoption (§2.14.1) in `map.withoutUndo(() => map.adopt(...))`. `mapChange` with Edit · Map mounted gets exactly one map-stack step.

### S1
- Router context: pass `getSession`/`disposeSession` from `src/stage/session.js` as `ctx.getSession` and `ctx.disposeSession` (otherwise the router loads `session.js` through `import.meta.glob` and `ctx.session` is null while it does not exist). The router calls `window.woodshedAppearance.refresh()`; `router.settled()` and `router.stop()` exist.
- Boot step 5: superseded at I0B, see "From I0B" → S1 (`startAccount()` applies and clears `pendingAccount` itself).
- Keys: call `keys.setPlatform(platform.detect())` (so `fx-platform` flows through) and `keys.loadLayoutMap()` at boot; `provide('router', () => router)` (or `'route'`). The dispatcher reads the posture from `html[data-posture]` and the edit tab from `ctx.route.params.tab` (`bulkDetails` maps to `details`); the router must set them. The three boot scopes are already defined inside `commands.js`.
- Frame: `layout.css` offers `.app-frame[data-chrome=topbar|none]` > `.app-topbar` + `.app-main`, `[data-scroller]`, `.app-content`, and `--content-max`, `--gutter`, `--h-topbar`, `--safe-*`. Use these or ticket F1.
- `src/app/dev-handle.js`: `window.__FIXTURE__ === true` is set first in `<head>` by the fixture.

### S2
- Export the `?` sheet's group order (or import `GROUPS` from `src/app/commands.js`) so registry CI's `SHEET_GROUPS` can compare it.

### CPB
- Electron main no longer sends `forUpdate: true`, so `update-cancellation.json` / `worker.cancelForUpdate` is never triggered from Electron and can be deleted as planned (D12).

### DT2
- Send `registerMenu` on every boot (main reinstalls the fallback menu after a reload or crash). Main attaches ⌘N/⌘W/⌘, itself; accelerators must follow the §2.20 grammar (exactly what `keys.accelerator()` emits). Main-sent ids: `nav.settings`, `app.undo`, `app.redo`, `app.shortcuts`, `stage.close`.

### PD1
- A pedal keyup goes to the handler that took its keydown, even after `setPedalHandler` replaces or removes it. Use `pedals.profileBindings(name, {custom, inSetlist, isPedalCommand})`, `actionsFor(bindings, {canHold})` and `createClassifier({canHold})`.
- Settings pedals section (with SE): the "Allow Woodshed in System Settings → Privacy & Security → Accessibility" button calls `setBackgroundShortcuts(true, {promptAccessibility: true})`.

### SE1
- The router remounts the view between `settings` and `settingsPage` (one module); `update(match)` comes only between sections of the same route name. Handling it as an update needs a §2.3 amendment and an F2 ticket.

### ED3, ED4
- Same router rule between `edit` and `editFind` (the session is kept).

### ED4
- I0A deleted the old `tests/tempo-sources.test.js` case "audition candidates independently, retain each offset, restore and cancel exactly". In the port, re-choosing "Your map" must restore the pre-audition data exactly (`map.restore(snapshot)` or `abortBatch`, D20), not `replace(map, 'tempo-source')`, which stamps origin `'imported'` (§4.2).

### ED5
- In `ws.prefs` `edit.chart.keys`, an empty string means the user cleared that kit's key: no key, no fallback to the KIT default; only a kit missing from the map uses its default.
- Give the `edit()` calls in `tests/notation-songmap.test.js` a reason, so `SongMapStore.edit`'s default reason `'edit'` can be removed (ticket the `song-map.js` owner then).

### LB2b
- The Add sheet's "Use these for future songs" writes `addDefaultsSaved: true` with `stemMode`/`preset` through `settings.patch`.

### I1
- Registry CI (`tests/registry-ci.test.js`): add `src/app/global-commands.js` and `src/stage/transport-commands.js` to `DEFINITION_MODULES`; add `desktop/menu.cjs` to `ELECTRON_MENU_SOURCES` once the global definitions (`nav.settings`, `app.undo`, `app.redo`, `app.shortcuts`, `stage.close`) are registered.
- Ticket DT1 to update `runSmokeTest()` DOM assertions in `desktop/main.cjs` (they check `#app-header` and `#sidebar`; §6.11 item 12). The smoke also fails if the processor did not start.
- Delete `SongMapStore.positionLabel` together with `player.js` (ticket its owner).

### I1b, I2a, I2b, I3a
- Registry CI lists: I1b adds `src/library/commands.js`; I2a/I2b add the stage and stems definitions, `CONTROL_MODULES` gains `src/stage/controls.js` once ST5 lands (every `CONTROL_SET` field is checked), and `SHEET_GROUPS` is set from S2's export; I3a adds the edit, map and chart definitions.

### I3a
- Guard activation: `scripts/check-source.mjs` `ACTIVATION.sourceScope = 'all'` (the `inner-html` and `clock` rules keep their own directory lists); `scripts/check-css.mjs` `ACTIVATION.cssLocation = true`, and empty `LOCATION_EXEMPT` once ED5 has deleted `notation.css`. At scope `'all'`, today's `src/js` still has violations in `admin.js`, `library.js`, `interactions.js`, `player.js`, `map-mode.js` and `song-metadata.js` plus backend imports and storage uses; those files go at I1, ED5 and I3a.

### V1
- Delete only the `convex/schema-compat.test.ts` test "v1 songs.practice rows validate and read back", in the same commit that drops `songs.practice` (gate G7).

## From I0B (wave 0B handoffs)
Contract details are in Appendix C items 22–50; this list names only what each package must do.

### S1
- Auth (AU1, Appendix C item 49): signed out is `{user: null, status: null}`, so check `user` before `status`. Catch `AuthError` kind `'oauth'` (codes `expired`, `access_denied`, `invalid_flow`, `oauth_error`, `rejected`, `unverified`) and call `renderSignIn(outlet, {error})`; only kinds `'config'` and `'network'` (including `code: 'timeout'` after 20 s) go to `renderFatal` (`details` from `err.cause`), whose Retry calls `initialize()` again. The app-boot test covers a thrown `'oauth'` → sign-in. `signOut()` never throws: build no "Couldn't sign out" state. On `onChange({user: null})` reload or render sign-in, as 1.9 did; a live status change (for example to suspended) also arrives there.
- Account (BK4): boot step 5 calls `startAccount()` from `src/app/account.js` (it subscribes `settings.config`, fills `store.config`/`store.account`, applies and clears `store.pendingAccount`); do not call `clearPendingAccount()`. Boot step 8 waits for `account.loaded.value` before reading `account.value.value.onboarding.whatDoYouPlay`.
- Platform (PL1): call `desktop.start()` after auth; pass `ctx.desktop = desktop` and `ctx.platform = platform`; `keys.setPlatform(platform)`. Banner sentences come from `SENTENCES.codec` and `SENTENCES.offline` (`src/app/error-copy.copy.js`).
- Icons (U1): call `installIcons()` from `src/ui/icon.js` at boot (D32); it reuses a sprite the harness host already inlined.
- Key-caps (U3): `Kbd` relabels only on its next `set()`; there is no label-change event. Run `keys.setPlatform(...)` and `await keys.loadLayoutMap()` before the first render.
- Data (BK6, BK2): `data.js` fills `store.library.setlists` with `setlists.subscribeList`; jobs come from `src/api/jobs.js` `subscribeActive`.

### S2
- Toasts (U2): mount the toast region (`.ui-toast-region`) with `followLayerHost(region, 'toast')` from `src/ui/popover.js` and keep the `off`; do not use `showLayer` (its buttons would be inert over a modal dialog). Toast tones include `warn`.
- Dialogs (U2): `Dialog({form: {fields, onSubmit}})` implements §2.9's FieldSpec; an error thrown with `{field}` shows at that field (BK7's field errors carry `field`).

### ST1b
- Metronome (F4b): call `metronome.configure(<practice.click fields>)`; the metronome starts itself on `state`/`plan`/`transport`. `onBeat` is `{when, downbeat, unit, kind, audible}`; a `plan` event invalidates beats at or after `from`, a `transport` event all of them. For Between passes `rest`, set `gapSec = metronome.countInPlanAt(a).duration` + one bar at `a`.
- Map events (ST0): `SongMapStore.setHasPart` emits nothing; `notation-session.js` calls `session.position.refresh()` after `map.setHasPart(...)`.
- Detection (BK2, BK3): on the desktop pass the local companion's `deviceId` (from `/status`) to `jobs.createBeatDetection`, `createSectionDetection` and `retry`. A detect call may return a new `jobId` (a stale queued one is cancelled); `retry` may refuse with `job_live` and `{jobId}`: follow that job. Server-applied detections (unmapped songs) carry `appliedAt`, so `latestDetection` is null for them and the session sees them only through the external-change path; on mapped songs call `markApplied` as before.

### ST1c
- Practice state (ST0): pass `status: feedback.status`, `legacyTempo: song.tempo`, `defaults: account.practice` and `local: shared ? {token} : null` to `createPracticeState` (in share mode pass the snapshot as `raw` and no `server`). Call `position.dispose()`, `frame.destroy()` and `practice.dispose()` in `disposeSession`. Spot undo entries are `{key: 'spots', from, to, apply: v => practice.patch({spots: v})}` with `from`/`to` from `practice.value.peek().spots` (tombstones included). Pass `coalesce` through `setSpeed(rate, {coalesce})` and `setVolume(name, v, {coalesce})` to `undo.push`. Pass `{auditioning: mapEditor.value?.auditioning}` to `reanchor`.
- Platform (PL1): per session wire `createWakeLock().update({stageOpen, playing, stoppedAt})`, `watchInterruptions`, `startMediaSession` and `startGestureAudio`.

### ST4
- Undo (ST0): show `undidMessage(entry)` / `redidMessage(entry)`. Show ☼ from the wake lock's `held` (PL1).
- Setlists (BK6): `?set=` uses `setlists.subscribeGet`; ids are never reused, so a stale id means the list was deleted.

### ST5
- BeatLamps (U3): pass `groupStart = true` to `frame()` when `barBeatAt` reports a new counted beat in a bar whose groups are chunked (over 12 counted beats) or a one-unit bar. Consider setting the Position separator " · " in `--font-ui` (in Atkinson Mono it spreads to full cell widths).

### ST9
- Chart (ST3, Appendix C item 39): the surface owns keyboard context menus (Shift+F10, ContextMenu), pinch and the scale. Pinch with `src/stage/pinch.js` (`base` = current scale, `min` 0.8, `max` 2; `chart.previewScale(g.factor, {clientX, clientY})` in `onPreview`, `setScale(g.value)` and `setBase` in `onCommit`). Answer every `onLoopEdit` commit with `setLoopRange` (the chart reverts after 1 s). Use `onRelayout({ms, bars})` for D54's sample. Pass `fonts` as on-screen floors.

### ST10, ST11
- Loop handles and press (ST2): drop the preview on `onEdit` phase `'cancel'`; forward `snap(t, {mode: 'ceil'|'floor'})` to `grid.snapTime` / `SongMapStore.snapTime`. Return false from `onLongStart` when `glass.pressPolicy({pointerType, playing, gesture: 'long'})` gives `'scroll'`. Stems passes `touchAction: 'none'` to `press.js`. Surfaces may pass `haptic: platform.haptic`.

### ED2
- Key-cap hints (U3): set `data-kbd-hints` on the Edit root after keyboard use, only on `(hover: hover) and (pointer: fine)`.

### ED3
- Map session hooks (ED1, Appendix C item 50): `suspendSaves(false, {changed: true})` resumes and saves the current map at once (Use their map); `markers.tombstone(ids, deleted)` patches and saves practice without a practice-undo entry, and `false` un-deletes; `rename(barIndex)` opens the inline rename (the [Rename] action of "Section {n} added"); `loop.set(value)` re-applies the loop without an undo step or a save; `status(text, {tone, action})` shows results that offer Undo. Bind ⌫ to `digits.value ? backspaceDigit() : unpin()` and Enter to `digits.value ? commitDigits() : <apply field>`; bind `map.tapAlong` to `session.tapAlong()`; send `tempo` to `applyBar` only when that field changed. The caller writes `songs.dismissSectionSuggestion`. Lane pin drags use `map.beginBatch` / `map.edit(..., 'drag')` / `map.endBatch`. Prefs paths: `edit.map.tapSnap`, `edit.map.tapOffset`.

### ED4
- Audition (ED1): try candidates with `session.map.replace(next, 'tempo-source')`, re-choose "Your map" with `map.restore(snapshot)`, and commit with `mapSession.endAudition({commit: true})` (Use their map) or `({commit: false})` (Keep my map, Esc).

### ED5
- score-view (ST3): its default fonts stay at the 1.9 sizes (11/15); pass `fonts` for the floors. Toolbar key-caps (5·4·3·2·1) use `Kbd({keys, hint: true})` (U3).

### ED6
- Metadata (BK7): use `validateField`, `LABELS`, `LIMITS`, `statusLine`, `cleanTags`, `sameValue` from `shared/metadata.ts`. Artwork upload is `api.metadata.uploadArtwork({id, file, signal})` → key, then `update({ids: [id], changes: {artwork: {kind: 'upload', key}}})`; Revert within 1 h through `update`/`updateEach` with the old key. `retry` rejects `matched` with `invalid`; "Find a match" may call it on a stuck `pending` song.

### LB1a
- Setlists (BK6): the read-only Setlists row reads `store.library.setlists`.

### LB1b
- Review chip (BK7): "Yes, that's it" is `metadata.confirm({id})` (accepts the current fields). If it means "use the suggested details", send `metadata.update({ids: [id], changes: <suggested fields>, match: {recordingId, releaseId}})` instead.
- Jobs popover (PL1, BK2): call `desktop.watchStatus()` while visible, `refreshStatus()` after a submit, label with `processorLabel()`; jobs from `src/api/jobs.js` (`subscribeActive`, `subscribeJob`, `latestDetection`, `markApplied`, `retry({jobId, preset})`).

### LB2a, LB2b
- Lookups (CPA): ignore `aborted` and `lookup_busy`; any other failure falls back to the single-result line. Collection pages answer `playlist` (422); a Spotify connection problem is `lookup_unavailable` (502). Lookups reject at once with `aborted`/`timeout` while the processor is starting. `uploadXHR` calls `onProgress({loaded, total})` per event and once at completion.
- Search for another version (PL1): it navigates to `/add?q=…` with history state `{dismissJobId}`; once the new job is submitted the Add sheet calls `api.jobs.dismiss({jobId: state.dismissJobId})`.

### LB3
- Setlists (BK6): `addSongs` returns `{added}`; the 8 s Undo removes exactly those through `setSongs`. Take `setSongs`' returned order as the truth (it may be shorter than what was sent).

### SE2
- Processing (PL1): call `desktop.watchStatus()` while visible and use `processorLabel()`.

### SE1, SE2, ON1
- Settings errors (BK4): `settings.patch` throws `invalid` with `data.field`, `pins_full`, `not_owner`; it normalises a `profile.primary` missing from `instruments` instead of refusing it and resolves to the merged settings (show those).

### SE3
- Admin (BK3): `admin.account` device rows are `{id, name, revoked, revokedBy: 'user'|'admin'|null, lastSeenAt}`; a re-pair can be refused with `device_limit` (`data.limit`).

### SH1
- Sharing (BK5, Appendix C items 30, 31, 33): do not use `sharing.playback` before ticket I0B-8 (`publicClient().action`) has landed; the dialog's "Sections and tempo map" toggle sends `includeMap` (ticket I0B-7). `view` returns `ownerName` and a sanitised v2 practice; errors are coded.

### DL1
- Downloads (PL1): use `fetchRelease({fetch, sources, timeoutMs, signal})` from `src/js/download-release.js`.

### CPB
- Worker calls (BK3): `worker.heartbeat({token, state, currentJobId?, appVersion?, platform?, accelerator?})` about every 60 s (an upsert: send `state` and `currentJobId` on every beat, the rest on connect or change; `state: 'offline'` on shutdown). Pass `errorCode` and `meta` to `worker.progress`, `sections` to `worker.beatsDone`, and call `worker.sectionsDone({token, jobId, sections})` for `kind: 'sections'` jobs (claim returns `downbeats`). Repeated reports are no-ops. Revoked computers get `device_unpaired` / `device_revoked_admin` (both messages contain "not paired").
- Companion (CPA): keep `lookupRoutes.abortAll()` at the start of `shutdown()`; keep `FALLBACK_YTDLP_ARGS` equal to `ytdlp-args.json` `base` (`lookup.test.mjs` enforces it); `errors.py`'s BOT_CHECK must not count "Sign in to confirm your age" (match `lookup.mjs`). `/status` still has the 1.9 fields (CPB item 4).
- Delete the case "update cancellation is scoped to the device and preserves completed jobs" from `convex/metadata.test.ts` in the same change that deletes `worker.cancelForUpdate` (granted in `packages.json`).

### I1
- Metronome (F4b): delete the deprecated setters (`setAccent`, `setVolume`, `setCountIn`, `setCountInLength`, `setCountInUnit`, `setAudiblePreRoll`), the `_click` alias, `load()`, the no-store constructor default and `_placeholder` (a ticket for `metronome.js`'s owner, F4b; they are not in §8). Keep `enabled`, `setEnabled` and `clickAt` (ED1's preview and calibration use them).
- Old chart callers (ST3): `src/js/notation/launcher.js`, `notation-demo.html` and `tests/notation-demo.js` go with the 1.9 player.
- Pairing (CPA): `initializeLocalDesktop` in `src/js/companion.js` still pairs through the 1.9 `./auth.js` client; when I1 deletes `src/js/auth.js`, ticket CPA to switch it to `src/api`.
- Auth (AU1): `signOut` finds the session through `import.meta.glob('../stage/session.js')` unless `configure({activeSession})` is called; wire `configure({activeSession: getSession})` in `main.js` (S1) once ST1b has landed.
- Run the runner with `--strict-requires` (§9.0, ticket I0B-4) once FX1 has added it.
