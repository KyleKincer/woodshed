# Forward requests for later packages
Requests from earlier waves' handoffs, grouped by target package ID, for the orchestrator to pass on. Contract changes they rely on are in `docs/ux2/architecture.md` Appendix C. Sections addressed to packages that have since run are removed by the next integration (I0B removed F4b, ED1, U1, U2, PL1, AU1, ST0 and BK1–BK7; I1 removed S1, S2, ST1a, ST1b, DL1, CPB and I1: all done or ticketed as I1-1 … I1-7; I1b removed ST1c, LB1a, LB1b, CPC and I1b: all done or ticketed as I1b-1 … I1b-3).

## From I0A (wave 0A handoffs)

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

### I2a, I2b, I3a
- Registry CI lists (I1b added `src/library/commands.js` and `src/stage/transport-commands.js` to `DEFINITION_MODULES`): I2a/I2b add the stage and stems definitions, and `CONTROL_MODULES` gains `src/stage/controls.js` once ST5 lands (every `CONTROL_SET` field is checked); `desktop/menu.cjs` joins `ELECTRON_MENU_SOURCES` in the integration that defines `app.undo`, `app.redo` and `stage.close`; I3a adds the edit, map and chart definitions. (I1 added `global-commands.js` and set `SHEET_GROUPS` from S2's export.)

### I3a
- Guard activation: `scripts/check-source.mjs` `ACTIVATION.sourceScope = 'all'` (the `inner-html` and `clock` rules keep their own directory lists); `scripts/check-css.mjs` `ACTIVATION.cssLocation = true`, and empty `LOCATION_EXEMPT` once ED5 has deleted `notation.css`. At scope `'all'`, today's `src/js` still has violations in `admin.js`, `library.js`, `interactions.js`, `player.js`, `map-mode.js` and `song-metadata.js` plus backend imports and storage uses; I1 deleted `admin.js`, `library.js`, `player.js` and `map-mode.js`; the rest go at ED5 and I3a.

### V1
- Delete only the `convex/schema-compat.test.ts` test "v1 songs.practice rows validate and read back", in the same commit that drops `songs.practice` (gate G7).

## From I0B (wave 0B handoffs)
Contract details are in Appendix C items 22–50; this list names only what each package must do.

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

### LB2a, LB2b
- Lookups (CPA): ignore `aborted` and `lookup_busy`; any other failure falls back to the single-result line. Collection pages answer `playlist` (422); a Spotify connection problem is `lookup_unavailable` (502). Lookups reject at once with `aborted`/`timeout` while the processor is starting. `uploadXHR` calls `onProgress({loaded, total})` per event and once at completion.
- Search for another version (PL1): it navigates to `/add?q=…` with history state `{dismissJobId}`; once the new job is submitted the Add sheet calls `api.jobs.dismiss({jobId: state.dismissJobId})`.

### LB3
- Setlists (BK6): `addSongs` returns `{added}`; the 8 s Undo removes exactly those through `setSongs`. Take `setSongs`' returned order as the truth (it may be shorter than what was sent).

### SE2
- Processing (PL1): call `desktop.watchStatus()` while visible and use `processorLabel()`.

### SE1, SE2
- Settings errors (BK4): `settings.patch` throws `invalid` with `data.field`, `pins_full`, `not_owner`; it normalises a `profile.primary` missing from `instruments` instead of refusing it and resolves to the merged settings (show those).

### SE3
- Admin (BK3): `admin.account` device rows are `{id, name, revoked, revokedBy: 'user'|'admin'|null, lastSeenAt}`; a re-pair can be refused with `device_limit` (`data.limit`).

### SH1
- Sharing (BK5, Appendix C items 30, 31, 33): signed-out visitors call `sharing.playback` through `publicClient().action` (landed in 0Bx, ticket I0B-8); the dialog's "Sections and tempo map" toggle sends `includeMap` (`sharing.create`/`status`, landed in 0Bx, ticket I0B-7). `view` returns `ownerName` and a sanitised v2 practice; errors are coded.

## From I1 (wave 1a handoffs)
Contract details are in Appendix C items 52–72.

### ST4
- Status line (S2): call `attachStatusLine()` while the HUD's status line is mounted (keep its `off`) and render `statusLine.value` = `{id, text, action, key, tone, durationMs}`; clicking the action runs `entry.action.run()` then `dismissStatus(entry.key)`. Without an attached line `status()` falls back to a toast.
- `app.escape` (S1): it reads `store.stage.{focus, playing}`, calls the `'stage'` context's `toggleFocus()`, and runs `stage.leave` when stopped and not on an iPad. Provide that context, and keep `store.stage.playing` true while counting in so Esc never leaves during a count.
- Per session (ST1b): wire the wake lock, `watchInterruptions` (it calls `transport.interrupt(reason)`), `startMediaSession` and `startGestureAudio` in `stage.js`; the session does not. The session already flushes itself on `pagehide`, on the page becoming hidden and on desktop flush requests.
- Render `load.error` by kind (`storage`, `missing` with stem names, `codec`, `unknown`). A deleted song makes `getSession` reject with `ApiError` `not_found`, which the router does not catch: render it.
- HUD inputs: `snapshot.loop.role` (`'listen'|'play'|null`) for "· listen" / "· you play"; `snapshot.countdown` `{current, of, label}`. The DetectFlow's `offer` / `useOffer()` / `dismissOffer()` drive "Bars found while you were away · [Use them] [Not now]".

### ST5, ST7, ST8a
- Mix sheet (ST1a): the transport emits `'mix-sheet' {reason: 'no-part'}` when Minus me / Only me finds no matching stem; the command layer opens the Mix sheet then.

### ST8b, LB3
- "Re-split with 6 stems" (ST1a): the session does not pass `resplit` to the transport yet; whichever package owns the re-split flow passes `resplit` (desktop only), else the transport appends the web copy.

### SH1
- Palette (S2): call `configurePalette({songs: false, navigation: false})` at boot (§2.18 item 6); the palette also drops those groups whenever `session.shareToken` is set.

### SE2
- Export (S1): the paused page's Export library calls `exportLibrary(onProgress)` from `src/js/export.js`, which since I1 runs on the 2.0 client through `backend.js` (Appendix C item 54); SE2's port to `src/api` replaces that. Manage billing calls `billing:portal` through `src/api/client.js`; SE2's `src/api/billing.js` may replace it.

### SE3
- Admin access (S1): boot step 4 calls `query('admin:access', {})` through `src/api/client.js`; once `src/api/admin.js` exists, ticket S1 to use `api.admin.access`.

### VF1
- `/download` has no full-app capture state: the fixture has no `/api/downloads` middleware (DL1), so the page relies on its fallback source (I1's check of `/download` on the fixture saw no console error or failed request). If the §10.3 DL1 capture needs the lookup path, ticket FX1 for an `/api/downloads` answer.

### V1
- When deleting `src/app/placeholder.js`, also drop `routes.js`'s placeholder fallback and `main.js`'s sign-in fallback (`renderSignIn as placeholderSignIn`); ON1's `signin.js` is picked up through a glob and called as `renderSignIn(el, {error, signIn})`.
- `tests/local/{chart,mock-chart}.html` still link the deleted `/src/css/*` stylesheets: delete or repoint them in the orphan sweep.

## From I1b (wave 1b handoffs)
Contract details are in Appendix C items 76–84.

### ST4
- Contexts for the transport commands (ST1c, item 81): provide `'session'` and `'transport'` (optional; the commands fall back to `session.transport`), and the `'stage'` context with `openSheet(name, {anchor})` and `anchors`. The commands look anchors up as `anchors.get(<sheet>)` with the sheet names `'speed'`, `'click'`, `'mix'` and `'loop'`: add `'speed'`, `'click'` and `'loop'` entries next to `'mix'` if those sheets should be anchored. `sheets/host.js` must export `openSheet(name, {session, anchor})` (Edit's slim transport reaches the sheets through it).
- Spot undo entries (ST0, from I0B): `{key: 'spots', from, to, apply: v => practice.patch({spots: v})}` with `from`/`to` from `practice.value.peek().spots` (tombstones included), pushed by `spot.save`/`spot.open` (§3.2; with ST8b).

### ST4, ST5, ST7
- Minus me / Only me already open the Mix sheet when the transport reports no matching stem. If the Stage also listens for the transport's `'mix-sheet'` event, opening the same sheet a second time must do nothing.
- Radio controls get per-option checked and disabled state with `registry.state(id, registry.context({args}))` (`loop.playTimes {n}`, `loop.between {mode}`, `click.mode {mode}`, `mix.chartAudio {level}`).
- `click.countIn` has no `menu.label`: any menu builder (including a later Electron Transport menu) takes the label from the evaluated title, as for `transport.playStop`.

### ST5
- The `1 ready` chip reads `jobsModel.ready` (Song[]) from `src/library/jobs.js`; `ready` clears when `store.stage.songId` becomes that song.

### ST7
- The Mix sheet's "I play ▾" uses ON1's `InstrumentPicker({…, openWith: false})`.

### ED2
- Provide the `'session'` and `'transport'` contexts in Edit; the S/E sheet commands and `nav.goTo` work there.

### SE1, SE2
- Settings → Instruments: `InstrumentPicker({value, onChange, mapping: true, labelledBy: <section heading id>})`; save each change through `account.patch({profile})`.

### LB2a
- `store.library.uploads` entries as LB1b reads them: `{id, name (or file.name), title?, deviceId?, progress: Signal<{loaded, total}>, state: Signal<'uploading'|'queued'|'error'|'canceled'>, cancel(), error?, dismiss?()}` (plain values are accepted too). Only `uploading` and `error` entries become Jobs rows; without `dismiss()` the popover's Dismiss removes the entry from the signal itself.

### LB3
- `home.js` finds `./card-menu.js` through `import.meta.glob` and calls `cardMenuItems(song, ctx)`; cards show the ⋯ button and long-press opens the menu once the file exists.
- ⌘-click and Shift-click on a card are left to the browser today (`onOpen` returns false). Turning them into selection needs a grant on `src/library/home.js` (ticket it with LB3), as does the `'library'` context's `selecting` / `exitSelection()` (today a stub returning false).

### DT2
- `notify-ready.js`: use `jobsModel.ready` for completion toasts and notifications.
- Optional (from I1): pass `WOODSHED_PROCESSOR` so `modelsReady` finds `_internal/demucs/remote` (unneeded if `--collect-all demucs` keeps those files).

### BK1 (optional)
- Adding `recordingId` to the list row's `suggestion` would remove the extra `songs.get` call that the review chip's "Yes, that's it" makes when it applies a suggestion for a different recording.

### FX1 (optional)
- With `fx-library=empty` the seed has no `demoToken`, so the first-run Demo card cannot show; LB1a's `first-run-web` state sets the token with `fixture.update` and reloads. Seeding the token independently of the library would let the plain fixture show it.

### VF1
- Run §10.3's `LB1a`/`LB1b`/`ON1` captures on the merged tree; the found-detection rows depend on tickets I1b-1/I1b-2 (until they land, only the 12 most recently practised or added songs are probed).
