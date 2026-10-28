# Forward requests for later packages
Requests from earlier waves' handoffs, grouped by target package ID, for the orchestrator to pass on. Contract changes they rely on are in `docs/ux2/architecture.md` Appendix C. Sections addressed to packages that have since run are removed by the next integration (I0B removed F4b, ED1, U1, U2, PL1, AU1, ST0 and BK1–BK7; I1 removed S1, S2, ST1a, ST1b, DL1, CPB and I1: all done or ticketed as I1-1 … I1-7; I1b removed ST1c, LB1a, LB1b, CPC, VF1 and I1b: all done or ticketed as I1b-1 … I1b-3; I2a removed ST4, ST5, ST6, LB2a, SE1, SE3 and I2a: all done or ticketed as I2a-1 … I2a-15, which landed in wave 2ax; its re-verification ticketed I2a-16 … I2a-18, which landed in round 3, whose re-verification ticketed I2a-19).

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

### LB2b
- The Add sheet's "Use these for future songs" writes `addDefaultsSaved: true` with `stemMode`/`preset` through `settings.patch`.

### I2b, I3a
- Registry CI lists (I2a added `src/stage/commands.js` to `DEFINITION_MODULES` and `src/stage/{controls,hud,stage.copy,strip}.js` to `CONTROL_MODULES`): I2b adds the stems definitions and the sheets' and menus' `CONTROLS` modules; `desktop/menu.cjs` joins `ELECTRON_MENU_SOURCES` in the integration that defines `app.undo`, `app.redo` and `stage.close`; I3a adds the edit, map and chart definitions. (I1 added `global-commands.js` and set `SHEET_GROUPS` from S2's export.)

### I3a
- Guard activation: `scripts/check-source.mjs` `ACTIVATION.sourceScope = 'all'` (the `inner-html` and `clock` rules keep their own directory lists); `scripts/check-css.mjs` `ACTIVATION.cssLocation = true`, and empty `LOCATION_EXEMPT` once ED5 has deleted `notation.css`. At scope `'all'`, today's `src/js` still has violations in `admin.js`, `library.js`, `interactions.js`, `player.js`, `map-mode.js` and `song-metadata.js` plus backend imports and storage uses; I1 deleted `admin.js`, `library.js`, `player.js` and `map-mode.js`; the rest go at ED5 and I3a.

### V1
- Delete only the `convex/schema-compat.test.ts` test "v1 songs.practice rows validate and read back", in the same commit that drops `songs.practice` (gate G7).

## From I0B (wave 0B handoffs)
Contract details are in Appendix C items 22–50; this list names only what each package must do.

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

### LB2b
- Lookups (CPA): ignore `aborted` and `lookup_busy`; any other failure falls back to the single-result line. Collection pages answer `playlist` (422); a Spotify connection problem is `lookup_unavailable` (502). Lookups reject at once with `aborted`/`timeout` while the processor is starting. `uploadXHR` calls `onProgress({loaded, total})` per event and once at completion.
- Search for another version (PL1): it navigates to `/add?q=…` with history state `{dismissJobId}`; once the new job is submitted the Add sheet calls `api.jobs.dismiss({jobId: state.dismissJobId})`.

### LB3
- Setlists (BK6): `addSongs` returns `{added}`; the 8 s Undo removes exactly those through `setSongs`. Take `setSongs`' returned order as the truth (it may be shorter than what was sent).

### SE2
- Processing (PL1): call `desktop.watchStatus()` while visible and use `processorLabel()`.

### SE2
- Settings errors (BK4): `settings.patch` throws `invalid` with `data.field`, `pins_full`, `not_owner`; it normalises a `profile.primary` missing from `instruments` instead of refusing it and resolves to the merged settings (show those).

### SH1
- Sharing (BK5, Appendix C items 30, 31, 33): signed-out visitors call `sharing.playback` through `publicClient().action` (landed in 0Bx, ticket I0B-8); the dialog's "Sections and tempo map" toggle sends `includeMap` (`sharing.create`/`status`, landed in 0Bx, ticket I0B-7). `view` returns `ownerName` and a sanitised v2 practice; errors are coded.

## From I1 (wave 1a handoffs)
Contract details are in Appendix C items 52–72.

### ST7, ST8a
- Mix sheet (ST1a): the transport emits `'mix-sheet' {reason: 'no-part'}` when Minus me / Only me finds no matching stem; the command layer opens the Mix sheet then.

### ST8b, LB3
- "Re-split with 6 stems" (ST1a): the session does not pass `resplit` to the transport yet; whichever package owns the re-split flow passes `resplit` (desktop only), else the transport appends the web copy.

### SH1
- Palette (S2): call `configurePalette({songs: false, navigation: false})` at boot (§2.18 item 6); the palette also drops those groups whenever `session.shareToken` is set.

### SE2
- Export (S1): the paused page's Export library calls `exportLibrary(onProgress)` from `src/js/export.js`, which since I1 runs on the 2.0 client through `backend.js` (Appendix C item 54); SE2's port to `src/api` replaces that. Manage billing calls `billing:portal` through `src/api/client.js`; SE2's `src/api/billing.js` may replace it.

### V1
- When deleting `src/app/placeholder.js`, also drop `routes.js`'s placeholder fallback and `main.js`'s sign-in fallback (`renderSignIn as placeholderSignIn`); ON1's `signin.js` is picked up through a glob and called as `renderSignIn(el, {error, signIn})`.
- `tests/local/{chart,mock-chart}.html` still link the deleted `/src/css/*` stylesheets: delete or repoint them in the orphan sweep.

## From I1b (wave 1b handoffs)
Contract details are in Appendix C items 76–84.

### ST7
- Minus me / Only me already open the Mix sheet when the transport reports no matching stem. If the Stage also listens for the transport's `'mix-sheet'` event, opening the same sheet a second time must do nothing.
- Radio controls get per-option checked and disabled state with `registry.state(id, registry.context({args}))` (`loop.playTimes {n}`, `loop.between {mode}`, `click.mode {mode}`, `mix.chartAudio {level}`).
- `click.countIn` has no `menu.label`: any menu builder (including a later Electron Transport menu) takes the label from the evaluated title, as for `transport.playStop`.
- The Mix sheet's "I play ▾" uses ON1's `InstrumentPicker({…, openWith: false})`.

### ED2
- Provide the `'session'` and `'transport'` contexts in Edit; the S/E sheet commands and `nav.goTo` work there.

### SE2
- Settings → Instruments: `InstrumentPicker({value, onChange, mapping: true, labelledBy: <section heading id>})`; save each change through `account.patch({profile})`.

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


## From I2a (wave 2a handoffs)
Contract details are in Appendix C items 88–104.

### LB2b
- Uploads (LB2a, item 94): read the staged files with `takeStagedFiles()` on mount. Call `startUploads(files, {settings: <stored account settings>, profile: <account profile>, choice: <Change panel {stemMode?, preset?} or null>, deviceId, title})`; do not resolve the settings first (`upload.js` applies `jobSettings(profile, settings, choice)` itself, so a chosen layout must come in through `choice`). Calling `uploadDevice()` first lets a missing processor show inline before the sheet closes. The toast's Undo is `handle.cancel()` (it can take up to about 4.25 s and returns false if the job could not be canceled).
- Use `defaultsParts(profile, settings, choice)` for the bold words, `removesMyStem(profile, stemMode, jobSettings(profile, settings, choice))` / `removesMyStemLine` for the warning (a Custom 6-stem model counts as six), `audioFiles` and `COPY.notAudio`, and `findDuplicate` against `store.library.songs.value`. Files over 1 GB fail with the generic "unknown" sentence (Details explains); the sheet may flag them inline.
- The single-file title override (`title`) reaches the finished song: `createSeparation` marks a new upload's `meta.title` with `meta.titleOverride: true`, `worker.progress` keeps it and `worker.finish` titles the song with it and locks the title (I2a-5, I2a-6, Appendix C item 101).

### LB1b (optional)
- Upload entries offer `retry()`, which re-uploads the file; a "Try again" action on a failed upload row could call `entry.retry()`.

### BK1 (optional)
- Adding `resolvedUrl` to the `songs.list` row lets `findDuplicate` match a pasted link against search-added songs (the matcher already reads it when present).

### SE2
- Section modules (SE1, item 95): `src/settings/sections/{processing,plan}.js` are found through the lazy glob; default-export `{id, title, render(el, ctx) → {destroy}}` with ctx `{router, account, prefs, platform, desktop, install, store, registry, feedback, layout, headingId, window}`. Reuse `createSaver`, `settingRow({row, label, hint, scope, controls, saver, labelId})` and `desktopNote(items)` from `src/settings/settings.js`. Nav titles and list-row summaries for 'processing' and 'plan' are in `src/settings/settings.copy.js` `SECTIONS` (changing them needs an SE1 ticket); a web-hidden section needs `desktopOnly: true` there (none does today). Until `plan.js` exists, `/settings/plan` (and `/billing?checkout=success`, which redirects there) keeps its URL and query and shows "Not built yet" in the detail pane, unlisted in the nav (I2a-15); once the module exists the section is listed and renders, with `?checkout=success` still on the URL.

### PD1
- `src/settings/sections/pedals.js` is PD1's from wave 3a (item 96); today it is SE1's stub row 'shortcuts' (Button `app.shortcuts`). Use `settingRow`, `createSaver` and `desktopNote` from `src/settings/settings.js`. Finishing the section also needs a `packages.json` grant (orchestrator) on two SE1 files: `src/settings/settings.copy.js` (the pedals entries in `CONTROLS` and `ROWS`, and `SECTIONS.pedals`'s summary, today "Keyboard shortcuts") and `tests/settings-sections-a.test.js` (strict pedals control checks; pedals is left out of the strict "nothing else" count today).

### ST8a
- Stage menus (ST4): `stage.js` calls `menus.stageMenu(session, stageApi)`, `barMenu(session, {t, bar})` and `sectionMenu(session, region)`, then `Menu.open`; the `stage.menu` command stays hidden until `menus.js` exists.
- The strip's menu gestures are checked by ST6's `st6-strip-menu-press` only for "never cues, loops or jumps" and, while `menus.js` is absent, "opens nothing" (I2a-12). ST8a's own states check that a long-press and a right-click on a strip segment open the section menu (with "Loop this section" and "Rename…").
- Strip menus (ST6): the strip calls `sectionMenu(session, region, {t, rename})` and opens the items with `Menu.open` at the press point, or under the focused segment for keyboard menus. `region` is a section region (from `position.regions()`, with `startBar`) or a marker region; `t` is the pressed time ("Extend loop to here"); the "Rename…" item calls `opts.rename()`, which opens the strip's inline rename. Until `menus.js` exists, long-press and right-click on the strip open nothing.

### ST9, ST10, ST11
- Surface opts include `stage` (read `layout`, `distance`, `display` and `followStyle` signals there). Optional surface methods the frame calls: `setLayout(l)` and `setDistance(d)` on relayout, and `viewport` (Stems) for the strip bracket. Make the scroller a `[data-scroller]` inside the surface layer; `stage.scrollUp/Down/Top` use it. Never mark surface elements with `[data-anchor]` (position.css); use `[data-stage-anchor]`.

### LB3
- `song.resplit`'s run imports `../library/resplit-dialog.js` and calls `openResplitDialog({songId, router, desktop})`; until it exists desktop shows the reason "Not built yet" and web "Re-split from Woodshed for desktop."

### SH1
- `stage.share` flushes the session (final), then calls `openShareDialog({session, song})` from `src/share/share-dialog.js`. The HUD's read-only identity variant ("Shared by …") has an action slot for SH1 to fill.

### ED2
- Edit starts its own wake lock, interruption watcher and Media Session; `stage.js` stops them on unmount.

### VF2
- Check that the mounted Stage has exactly one `role=status` (item 89); ST5's tests already assert the HUD renders none.
- The cross-module "unmapped never renders Bar" suite (§10.4) must remove the strip's `COPY.noGrid` ("No bar grid · Get bars →") before scanning, as `tests/stage-strip.test.js` does.
- In the rail, gaps around Play are 8 px (spec §4.6); the §10.4 "≥ 12 px gaps around Play" check applies to the dock (12 px, probed in `st5-hud-band`).
- `vf1-flow-back-*` in `tests/fixture/flows/VF1.cjs` now run against the real Stage; `vf1-flow-back-link` presses ST5's ‹ HoldButton (role button, "Back to Library") and requires `src/stage/hud.js` (I2a-11).
