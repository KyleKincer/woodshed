# Forward requests for later packages
Requests from earlier waves' handoffs, grouped by target package ID, for the orchestrator to pass on. Contract changes they rely on are in `docs/ux2/architecture.md` Appendix C. Sections addressed to packages that have since run are removed by the next integration (I0B removed F4b, ED1, U1, U2, PL1, AU1, ST0 and BK1–BK7; I1 removed S1, S2, ST1a, ST1b, DL1, CPB and I1: all done or ticketed as I1-1 … I1-7; I1b removed ST1c, LB1a, LB1b, CPC, VF1 and I1b: all done or ticketed as I1b-1 … I1b-3; I2a removed ST4, ST5, ST6, LB2a, SE1, SE3 and I2a: all done or ticketed as I2a-1 … I2a-15, which landed in wave 2ax; its re-verification ticketed I2a-16 … I2a-18, which landed in round 3, whose re-verification ticketed I2a-19, which landed in round 4); I2b removed ST7, ST8a, ST8b, ST9, ST10, ST11, LB2b, LB3, SE2 and I2b: all done or ticketed as I2b-1 … I2b-37).

## From I0A (wave 0A handoffs)

### DT2
- Send `registerMenu` on every boot (main reinstalls the fallback menu after a reload or crash). Main attaches ⌘N/⌘W/⌘, itself; accelerators must follow the §2.20 grammar (exactly what `keys.accelerator()` emits). Main-sent ids: `nav.settings`, `app.undo`, `app.redo`, `app.shortcuts`, `stage.close`.

### PD1
- A pedal keyup goes to the handler that took its keydown, even after `setPedalHandler` replaces or removes it. Use `pedals.profileBindings(name, {custom, inSetlist, isPedalCommand})`, `actionsFor(bindings, {canHold})` and `createClassifier({canHold})`.
- Settings pedals section (with SE): the "Allow Woodshed in System Settings → Privacy & Security → Accessibility" button calls `setBackgroundShortcuts(true, {promptAccessibility: true})`.

### ED3, ED4
- Same router rule between `edit` and `editFind` (the session is kept).

### ED4
- I0A deleted the old `tests/tempo-sources.test.js` case "audition candidates independently, retain each offset, restore and cancel exactly". In the port, re-choosing "Your map" must restore the pre-audition data exactly (`map.restore(snapshot)` or `abortBatch`, D20), not `replace(map, 'tempo-source')`, which stamps origin `'imported'` (§4.2).

### ED5
- In `ws.prefs` `edit.chart.keys`, an empty string means the user cleared that kit's key: no key, no fallback to the KIT default; only a kit missing from the map uses its default.
- Give the `edit()` calls in `tests/notation-songmap.test.js` a reason, so `SongMapStore.edit`'s default reason `'edit'` can be removed (ticket the `song-map.js` owner then).

### I3a
- Registry CI lists (I2a added `src/stage/commands.js` to `DEFINITION_MODULES` and `src/stage/{controls,hud,stage.copy,strip}.js` to `CONTROL_MODULES`; I2b added `stems-surface.js#defineStemsCommands` to `DEFINITION_MODULES`, the wave 2b sheets, menus, surfaces and `library-actions.copy.js` to `CONTROL_MODULES`, and `via` to the control fields): `desktop/menu.cjs` joins `ELECTRON_MENU_SOURCES` in the integration that defines `app.undo` and `app.redo` (`stage.close` exists since I2a); I3a adds the edit, map and chart definitions. (I1 added `global-commands.js` and set `SHEET_GROUPS` from S2's export.)
- Guard activation: `scripts/check-source.mjs` `ACTIVATION.sourceScope = 'all'` (the `inner-html` and `clock` rules keep their own directory lists); `scripts/check-css.mjs` `ACTIVATION.cssLocation = true`, and empty `LOCATION_EXEMPT` once ED5 has deleted `notation.css`. At scope `'all'`, today's `src/js` still has violations in `admin.js`, `library.js`, `interactions.js`, `player.js`, `map-mode.js` and `song-metadata.js` plus backend imports and storage uses; I1 deleted `admin.js`, `library.js`, `player.js` and `map-mode.js`; the rest go at ED5 and I3a.

### V1
- Delete only the `convex/schema-compat.test.ts` test "v1 songs.practice rows validate and read back", in the same commit that drops `songs.practice` (gate G7).

## From I0B (wave 0B handoffs)
Contract details are in Appendix C items 22–50; this list names only what each package must do.

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

### SH1
- Sharing (BK5, Appendix C items 30, 31, 33): signed-out visitors call `sharing.playback` through `publicClient().action` (landed in 0Bx, ticket I0B-8); the dialog's "Sections and tempo map" toggle sends `includeMap` (`sharing.create`/`status`, landed in 0Bx, ticket I0B-7). `view` returns `ownerName` and a sanitised v2 practice; errors are coded.

## From I1 (wave 1a handoffs)
Contract details are in Appendix C items 52–72.

### SH1
- Palette (S2): call `configurePalette({songs: false, navigation: false})` at boot (§2.18 item 6); the palette also drops those groups whenever `session.shareToken` is set.

### V1
- When deleting `src/app/placeholder.js`, also drop `routes.js`'s placeholder fallback and `main.js`'s sign-in fallback (`renderSignIn as placeholderSignIn`); ON1's `signin.js` is picked up through a glob and called as `renderSignIn(el, {error, signIn})`.
- `tests/local/{chart,mock-chart}.html` still link the deleted `/src/css/*` stylesheets: delete or repoint them in the orphan sweep.

## From I1b (wave 1b handoffs)
Contract details are in Appendix C items 76–84.

### ED2
- Provide the `'session'` and `'transport'` contexts in Edit; the S/E sheet commands and `nav.goTo` work there.

### DT2
- `notify-ready.js`: use `jobsModel.ready` for completion toasts and notifications.
- Optional (from I1): pass `WOODSHED_PROCESSOR` so `modelsReady` finds `_internal/demucs/remote` (unneeded if `--collect-all demucs` keeps those files).

### BK1 (optional)
- Adding `recordingId` to the list row's `suggestion` would remove the extra `songs.get` call that the review chip's "Yes, that's it" makes when it applies a suggestion for a different recording.

### FX1 (optional)
- With `fx-library=empty` the seed has no `demoToken`, so the first-run Demo card cannot show; LB1a's `first-run-web` state sets the token with `fixture.update` and reloads. Seeding the token independently of the library would let the plain fixture show it.


## From I2a (wave 2a handoffs)
Contract details are in Appendix C items 88–104.

### LB1b (optional)
- Upload entries offer `retry()`, which re-uploads the file; a "Try again" action on a failed upload row could call `entry.retry()`.

### BK1 (optional)
- Adding `resolvedUrl` to the `songs.list` row lets `findDuplicate` match a pasted link against search-added songs (the matcher already reads it when present).

### PD1
- `src/settings/sections/pedals.js` is PD1's from wave 3a (item 96); today it is SE1's stub row 'shortcuts' (Button `app.shortcuts`). Use `settingRow`, `createSaver` and `desktopNote` from `src/settings/settings.js`. Finishing the section also needs a `packages.json` grant (orchestrator) on two SE1 files: `src/settings/settings.copy.js` (the pedals entries in `CONTROLS` and `ROWS`, and `SECTIONS.pedals`'s summary, today "Keyboard shortcuts") and `tests/settings-sections-a.test.js` (strict pedals control checks; pedals is left out of the strict "nothing else" count today).

### SH1
- `stage.share` flushes the session (final), then calls `openShareDialog({session, song})` from `src/share/share-dialog.js`. The HUD's read-only identity variant ("Shared by …") has an action slot for SH1 to fill.

### ED2
- Edit starts its own wake lock, interruption watcher and Media Session; `stage.js` stops them on unmount.

### VF2
- Check that the mounted Stage has exactly one `role=status` (item 89); ST5's tests already assert the HUD renders none.
- The cross-module "unmapped never renders Bar" suite (§10.4) must remove the strip's `COPY.noGrid` ("No bar grid · Get bars →") before scanning, as `tests/stage-strip.test.js` does.
- In the rail, gaps around Play are 8 px (spec §4.6); the §10.4 "≥ 12 px gaps around Play" check applies to the dock (12 px, probed in `st5-hud-band`).
- `vf1-flow-back-*` in `tests/fixture/flows/VF1.cjs` now run against the real Stage; `vf1-flow-back-link` presses ST5's ‹ HoldButton (role button, "Back to Library") and requires `src/stage/hud.js` (I2a-11).

## From I2b (wave 2b handoffs)
Contract details are in Appendix C items 107–121.

### SH1
- Both callers use the object form `openShareDialog({song, session})` (§2.18 amended at I2b): the Stage's `stage.share` passes the session (flush it, final, before creating the share); the Library card menu passes `session: null`. Until `src/share/share-dialog.js` exists, Share… is disabled with "Not built yet" in both menus.
- On a shared song the ⋯ and section menus already hide their Edit rows (item 110); keep the `edit.*` `when` checks.

### ED4
- The chart surface's empty state "Import a file" navigates to `/s/:id/edit/map/find?import=1`; the Find panel should honour `?import=1` by opening (or focusing) its "Import a file…".

### ED2
- The Stage sheets (ST7, ST8b) run their controls through the app registry; in the slim transport they work once Edit provides the `'session'` and `'transport'` contexts (the I1b item above). D59: a bottom-sheet Speed preset closes the sheet there too.

### I3a
- When SH1 lands, drop `structure: {placeholder: true}` from `lb3-card-menu-desktop` and `lb3-card-menu-web` (`tests/fixture/states/LB3.cjs`, LB3's file: ticket it).

### VF2
- R1 (D54, item 118): run `st9-chart-r1` and `st9-chart-relayouts` in a quiet container as the R1 gate (I2b's run was provisional at load 8.6: 1.55–1.77× FX0 with 2 relayouts per Distance change). `probe-perf`'s relayout64 measures FX0's score-geometry harness, not a Distance change; add a Distance-change metric on the ST9 harness or use `st9-chart-r1`.
- The "unmapped never renders Bar" suite: `roadmap-surface` renders no "Bar"/"bar " when unmapped, including aria-labels and `ctx.focused` (unmapped grid items are `{kind: 'marker', t0, t1, label: '0:40–0:50'}`).
- The "exactly one `role=status`" check: U1's Segmented always renders a hidden `role=status` reason note, so an open Click or Mix sheet adds hidden nodes; count the Stage's visible status only (or ticket U1).
- In iPad captures the strip's `.strip-playhead` (`will-change: transform`) appeared to paint a 1 px line over the `:popover-open` bottom Sheet (ST8a); check it on the real Stage.

