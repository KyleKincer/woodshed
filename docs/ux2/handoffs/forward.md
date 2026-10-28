# Forward requests for later packages
Requests from earlier waves' handoffs, grouped by target package ID, for the orchestrator to pass on. Contract changes they rely on are in `docs/ux2/architecture.md` Appendix C.

## From I0A (wave 0A handoffs)

### F4b
- The `outputTime` cut rule, the aux re-open rule and the promotion rule now bind you (§5.0, §5.1, Appendix C items 1–3). Call `_promote()` at the start of every new mutator (segmented `setLoop`, pass appends). `rate`/`loop` are getter/setter pairs over `_rate`/`_loop`; plan entries carry `seq` and `promoted`.
- On the Signalsmith path a segmented loop needs only the next pass posted (the gate silences gaps); loops shorter than about 1 s can still be posted late in a throttled tab.
- Keep the metronome's §5.2 `plan`/`transport` handling that F4a already added.
- The `tempo` dual-write (`source`/`map`/`detected` in `metronome.serialize()`) is yours now, with `serialize() → {songMap}` (D51, §8). Removing it breaks `tests/map-mode.test.js` "Shift+M maps with the keyboard…" (line 64 asserts `saved.detected`); `map-mode.js` is deleted at I1, so delete that assertion or case (§9.0) and say so.
- When you delete the map-edit pause (`_notify`), subscribe with `cancelCountIn = !LABEL_REASONS.includes(reason)` (`LABEL_REASONS` from `src/js/song-map.js`). Listeners receive `(reason, {reason, revision})`.

### ST1b
- `DrumAudio` (`src/js/notation/audio.js`) must handle every plan change, not only scheduled rates (loop edits that keep the position, `seekAt`, `cancelPending`, later passes and gaps):
  - connect `DrumAudio.out` to `engine.aux ?? ctx.destination`;
  - subscribe to `engine.on('plan', ({from}) => …)`: cancel only hits with `when >= from` (track each entry's `when`, which `play()` already stores), then set `until = Math.min(until, from)`;
  - keep the cancel-all on `subscribeTransport` / `'transport'`.
  Until then a loop edit during Transcribe/Chart playback can leave up to 0.12 s of old-plan hits and skip the new plan's hits in that window.
- `adopt(data)` is now an undoable step (Appendix C item 7): wrap open-time drum-part adoption (`part.js`, "opening a part never creates an undo step") and silent foreign adoption (§2.14.1) in `map.withoutUndo(() => map.adopt(...))`. `mapChange` with Edit · Map mounted gets exactly one map-stack step.

### ED1
- Use `barIndexAtQ(q)` or `timeToBar(t)` when porting `map-mode.js` logic: `SongMapStore.barIndexAt(t)` now takes seconds.
- `adopt` semantics as for ST1b; edits in `withoutUndo` and `restore()` during an open batch count toward it, so `abortBatch` reverts them.

### S1
- Router context: pass `getSession`/`disposeSession` from `src/stage/session.js` as `ctx.getSession` and `ctx.disposeSession` (otherwise the router loads `session.js` through `import.meta.glob` and `ctx.session` is null while it does not exist). The router calls `window.woodshedAppearance.refresh()`; `router.settled()` and `router.stop()` exist.
- Boot step 5: after `account.patch(store.pendingAccount)` succeeds, call `clearPendingAccount()` from `src/app/prefs.js` (or set `store.pendingAccount.value = null`).
- Keys: call `keys.setPlatform(platform.detect())` (so `fx-platform` flows through) and `keys.loadLayoutMap()` at boot; `provide('router', () => router)` (or `'route'`). The dispatcher reads the posture from `html[data-posture]` and the edit tab from `ctx.route.params.tab` (`bulkDetails` maps to `details`); the router must set them. The three boot scopes are already defined inside `commands.js`.
- Frame: `layout.css` offers `.app-frame[data-chrome=topbar|none]` > `.app-topbar` + `.app-main`, `[data-scroller]`, `.app-content`, and `--content-max`, `--gutter`, `--h-topbar`, `--safe-*`. Use these or ticket F1.
- `src/app/dev-handle.js`: `window.__FIXTURE__ === true` is set first in `<head>` by the fixture.

### S2
- Export the `?` sheet's group order (or import `GROUPS` from `src/app/commands.js`) so registry CI's `SHEET_GROUPS` can compare it.

### U1
- `primitives/icon.css` sets `stroke-width: var(--icon-stroke)` on the icon svg (the sprite symbols have none; there is deliberately no global `svg` rule because of alphaTab). The sprite root has `aria-hidden` and `focusable="false"`; `icon.js` hides it when injecting. `i-drum` is the custom glyph, not Lucide's.
- Button with `command` reads `registry.state(id)` → `{visible, enabled, reason, checked, title}` for the disabled reason.

### U2
- Menu reads `registry.state(id)` for `disabledReason`. In `tests/helpers/dom.js`, `:popover-open` works in `matches`/`closest`/`querySelector(All)` while the Popover shim is installed (the open state is the `data-popover-open` attribute).

### PL1
- `src/app/platform.js` `detect()` reads `fx-platform`/`fx-nofeature` from `window.__FIXTURE_EARLY__.fx` (or `window.fixture.fx`), not the query string, so the switches survive a reload after the app rewrites the URL.
- `src/app/desktop.js` and ProcessorStatus: at launch `info().companion` may be null with `processor.phase === 'starting'`; wait for `onProcessorState` `ready`, then call `info()` again for `{port, token}` (same as after a restart). `info()` also returns `backgroundShortcuts: {enabled, registered, failed, accessibility?}`.
- `prefs.js` calls `window.woodshedDesktop.setTheme` directly; if you want it to use `desktop.setTheme`, that is a ticket for F2.

### AU1
- `src/api/client.js` statically imports `client` from `../app/auth.js`. Until `auth.js` exists, tests importing `client.js` mock both `'../src/app/auth.js'` and the raw specifier `'../app/auth.js'` (see `tests/api-client.test.js`).

### ST0
- `practice-state.js`: `pruned` counts only markers dropped and notes trimmed (expired tombstones are dropped silently), so "Some old markers were removed to make room." shows only on a real loss. `MAX_SPOTS` (24) and `MAX_MARKERS` (64) are add limits: block adding when the live count is at or over them (a merge can exceed them). `mergePractice` accepts the raw `server.value`.

### BK1
- `savePractice` summary: `summarize(upgradePractice(practice, {legacyTempo: song.tempo, duration: song.duration}), {sections: sectionsOf(data, duration), bars: barsOf(data, duration)})` (§6.3 amended); with sections only a non-section loop reads 'm:ss–m:ss loop'.
- `schema-compat.test.ts` asserts `songs.get` id/title/stems/tempo/metadata and list ids/titles/order; tell the integrator if you change those.
- Make `migrations.backfillB1` runnable on its own after a deploy (for example a lazy upgrade in `getPractice`/`savePractice` plus an idempotent self-scheduling backfill), not only through owner gate G2.
- Fixture seed: `db.songPractice` rows are `{songId, userId, practice, updatedAt}`; v1 rows keep `songs.practice`.

### BK2
- `listActive` must keep returning kind, label, status, stage and percent for the schema-compat rows, including the companion's `stage: 'sync'` row and its `stage: 'error'`/`percent: 0` failure row.
- Shared validators: `jobMetaValidator` (for `createSeparation.meta`), `jobKindValidator`/`jobStatusValidator`; `JOB_ERROR_CODES`, `isJobErrorCode`, `codeOf(error)` in `lib/errors.ts`.
- Fixture `db/jobs.js`: beat-detection rows carry `finishAt`; handler modules can export `settle(now)` (boot and every creep tick) and `resume()` (once after boot); keep both if you rewrite it. The done, unapplied detection for `jobs.latestDetection` is `job-detect-nightbus`.

### BK3
- Validators: `sectionSuggestionValidator`, `suggestedSectionValidator` (`beatsDone`/`sectionsDone`), `jobMetaValidator` (`worker.progress`), `presenceStateValidator` (heartbeat), `revokedByValidator`. Fixture: `db.devices` plus `db.devicePresence`.

### BK4
- Add `readonly DEMO_SHARE_TOKEN: string | undefined;` to `Env` in `convex/_generated/server.d.ts` after `BILLING_SITE_URL` (you now own that file for this one edit), so `env.DEMO_SHARE_TOKEN` in `settings.demo` typechecks before gate G1.
- `settings.patch` gains `addDefaultsSaved: v.optional(v.boolean())` (§6.5 amended); `addDefaults` honours a stored `stemMode` only when it is true or the mode is `'six'`.
- Fixture `settings:demo` reads `db.demoToken`.

### BK5
- `sanitizeForShare` also removes `onlyMe` and tombstones and resets spot `lastAt`/`passes`. For bar loop labels use `summarize(…, {sections, bars})` as for BK1.

### BK6
- Fixture: `db.setlists` (empty handler table until you write the bodies; 1.9 had none).

### BK7
- `metadataCandidateValidator` also accepts optional `albumArtist`, `trackNumber`, `discNumber`, `disambiguation`, `score`, so a raw `candidate()` result can be stored as `metadataSuggestion`. Fixture: the `metadataSuggestion` is on the counting song.

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
