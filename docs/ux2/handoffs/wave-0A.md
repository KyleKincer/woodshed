# Wave 0A package handoffs
Collected from each package's implement and fix passes (later entries supersede earlier ones).

## BK0

### pass 1

1. Ticket request (`convex/_generated/server.d.ts`, which BK0 does not own). `convex.config.ts` now declares `DEMO_SHARE_TOKEN`, but the generated `Env` type in `server.d.ts` will not list it until the owner's first `npx convex dev --once` (gate G1). Until then, BK4's planned `env.DEMO_SHARE_TOKEN` in `settings.demo` fails `npm run typecheck`. Either let I0A/BK0 add `readonly DEMO_SHARE_TOKEN: string | undefined;` to `Env` in `server.d.ts` (codegen's alphabetical format, between `BILLING_SITE_URL` and `OWNER_GOOGLE_ACCOUNT_ID`), or tell BK4 to read `process.env.DEMO_SHARE_TOKEN` until G1. At runtime, `env` is `process.env`, so convex-test already works.
2. Deviation, for BK7: `metadataCandidateValidator` has the contract fields plus optional `albumArtist`, `trackNumber`, `discNumber`, `disambiguation` and `score`. The contract describes it as "the shape candidate() already returns", but `lib/musicBrainz.ts#candidate()` returns those extra fields. Without them, storing a raw candidate as `metadataSuggestion` would fail validation. The contract's narrower shape still validates.
3. Deviation: `requireAdmin` now throws `fail('not_owner', 'Administrator access required.')`, because the §6.1 code list has no admin code.
4. Notes for 0B packages:
   - New shared validators in `convex/lib/validators.ts`: `sectionSuggestionValidator` and `suggestedSectionValidator` (BK3 `beatsDone`/`sectionsDone`), `jobMetaValidator` (BK2 `createSeparation.meta`, BK3 `worker.progress`), `jobKindValidator`/`jobStatusValidator`, `presenceStateValidator` (BK3 heartbeat), `revokedByValidator`.
   - `JOB_ERROR_CODES` and `isJobErrorCode` live in `lib/errors.ts`. `codeOf(error)` lets server code catch one coded error.
   - `jobs.meta` and `jobs.errorCode` stay loosely typed (`v.any()` and `v.string()`), because 1.9 rows hold other shapes.
5. `schema-compat.test.ts` asserts only fields that BK1/BK2's planned changes keep (`songs.get` id/title/stems/tempo/metadata, list ids/titles/order, `listActive` jobId/kind/label/status/stage/percent for queued/running/error). If BK1 or BK2 change those, they need to tell the integrator. V1 deletes only the test named "v1 songs.practice rows validate and read back", in the same commit that drops the field.
6. No data migration is needed for BK0: every schema change is additive and optional, and nothing indexes an existing table. Per the environment rules, BK1's `migrations.backfillB1` must run on its own after a deploy (for example a lazy upgrade in `getPractice`/`savePractice` plus an idempotent self-scheduling backfill), rather than relying only on owner gate G2.

### pass 2

1. Ticket for src/js/shared-song.js (owned by I1 or whoever owns the 1.9 share page until it is deleted). Line 40 renders an object `error.data` as "[object Object]" now that auth errors are coded. Change the catch to: `message.textContent = error.data?.message || (typeof error.data === 'string' ? error.data : null) || 'Couldn’t add this song. Check your connection and try again.';` This matches share-dialog.js:15. The error shape it relies on is pinned by the convex/errors.test.ts test "the share-save path carries an object `data` with a string message". Other 1.9 consumers already handle object data: share-dialog.js:15 and song-metadata.js:20.
2. Ticket for convex/_generated/server.d.ts (not owned by BK0), unchanged from the first pass. Add `readonly DEMO_SHARE_TOKEN: string | undefined;` to `Env`, after `BILLING_SITE_URL`. The alternative is to tell BK4 to read `process.env.DEMO_SHARE_TOKEN` until gate G1's codegen runs. Without one of these, BK4's `env.DEMO_SHARE_TOKEN` fails typecheck.
3. The rest of the first-pass handoff still stands: the metadataCandidateValidator extras, requireAdmin throwing `not_owner`, the shared validators for the 0B packages, the read-back fields that schema-compat asserts, and BK1's self-running backfill. One addition: the schema-compat jobs fixture now includes the companion's `stage:'sync'` row and its `stage:'error'`/`percent:0` failure row. BK2's `listActive` rework must keep returning kind, label, status, stage and percent for both rows.

## DT1

### pass 1

Contract additions and deviations, for the integrator to approve or amend:
1. The companion host (`createCompanionHost`), the fork env (`companionEnv`, `deviceName`), background shortcuts (`createGlobalShortcuts`), desktop prefs (`createDesktopPrefs`) and `createTrust` live in `desktop/ipc-handlers.cjs`; no other owned module fits them. The quit guard (`createQuitGuard`) and the update install order (`installUpdate`) are in `flush.cjs`. `createUiServer` (host check, `/media/`, `/oauth/callback`) is in `static-server.cjs`. Navigation guards are in `permissions.cjs`. `watchFullScreen` is in `window-state.cjs`.
2. `info()` also returns `backgroundShortcuts: {enabled, registered, failed, accessibility?}`, so Settings can show the per-device toggle before any change. `platform` is `process.platform`.
3. The preload's `setBackgroundShortcuts(on, {promptAccessibility}?)` takes an optional second argument. The Settings "Allow Woodshed in System Settings → Privacy & Security → Accessibility" button should call `setBackgroundShortcuts(true, {promptAccessibility: true})`, which runs `isTrustedAccessibilityClient(true)`. Owners: PL (`src/app/desktop.js`), PD1/SE (pedals section).
4. What each bridge callback receives: `onFullScreen(cb(on: boolean))`, `onNavigate(cb(route))`, `onCommand(cb({id, source: 'menu'|'global'}))`, `onProcessorState(cb(state))`, `onOpenUpdates(cb())`. `onFlushRequest(cb)` may return a promise; the preload awaits every registered callback, then answers. With no callbacks it answers at once.
5. Menu ids main sends itself: `nav.settings`, `app.undo`, `app.redo`, `app.shortcuts`, and `stage.close` (Close Song is added to File if the renderer's spec lacks it). Registry CI should treat these as Electron-menu ids. Main attaches ⌘N, ⌘W and ⌘, to `library.add`, `stage.close` and `nav.settings` even when the spec sends no accelerator; DT2 does not need to send them. Help → Licenses opens `resources/THIRD-PARTY-NOTICES.txt` and runs no command. Check for Updates… still sends `desktop:open-updates`.
6. FX1 (`tests/fixture/preamble.js`): the fake `window.woodshedDesktop` needs no-op versions of all 16 bridge methods (info, update, onUpdate, onOpenUpdates, setTheme, mediaUrl, onProcessorState, restartProcessor, registerMenu, onCommand, setActivity, setBackgroundShortcuts, notify, onNavigate, onFlushRequest, onFullScreen); every `on*` must return an unsubscribe.
7. I1: update the smoke DOM assertions in `runSmokeTest()` in `desktop/main.cjs` (§6.11 item 12); they still check `#app-header` and `#sidebar`. The smoke now also fails if the processor did not start, since a start failure no longer aborts the app.
8. CPB (D12): main no longer sends `forUpdate: true`, so the companion's `update-cancellation.json` / `worker.cancelForUpdate` path is never triggered from Electron and can be deleted as planned.

### pass 2

This adds to the handoff from the first pass:
1. **Accelerator grammar, for F3 and DT2.** `MenuSpecItem.accelerator` accepts `CmdOrCtrl` (or `CommandOrControl`) or `Ctrl` (or `Control`) first. Then come distinct extra modifiers from `Ctrl`/`Alt`/`Option`/`Shift`, though `Ctrl` cannot repeat after a `Ctrl` lead. Then one key from `[A-Z0-9]`, `F1`–`F24`, `Space`, `Return`/`Enter`, `Escape`, `Backspace`, `Delete`, `Tab`, `Up`/`Down`/`Left`/`Right`, `Home`/`End`/`PageUp`/`PageDown`, `Plus`, or one of `` ,./\[];'`=- ``. This is exactly what F3's `accelerator()` emits. Any other accelerator still rejects the whole spec, as §2.20 says, but the rejection is now logged. Please record this grammar in architecture §2.20.
2. **Processor start no longer blocks the window.** At launch the renderer may see `info().companion === null` with `processor.phase === 'starting'`. PL (`src/app/desktop.js`) and ProcessorStatus (§2.11) should wait for `onProcessorState` `ready` and then call `info()` again to get `{port, token}`, the same as after a restart.
3. **Menu reset on reload or crash.** After a reload or crash main reinstalls the fallback menu, so DT2 must send `registerMenu` on every boot.

## F1

### pass 1

1. **Contrast adjustment to record (`docs/ux2/architecture.md`, not mine):** in the §7.2 table, change paper `--now` from #c25700 to #b85200. The spec value is 4.13:1 on `--bg` and fails the 4.5:1 text minimum; the new value is 4.53:1, at HSL lightness 36% instead of 38%. `tests/tokens-contrast.test.js` keeps passing after the edit.

2. **Activation switches for I3a:**
   - In `scripts/check-source.mjs`, set `ACTIVATION.sourceScope = 'all'`. The `inner-html` and `clock` rules keep their own directory lists.
   - In `scripts/check-css.mjs`, set `ACTIVATION.cssLocation = true`, and empty `LOCATION_EXEMPT` once ED5 has deleted `notation.css`.
   - The guard tests pass the scope explicitly, so flipping these switches does not break them.
   - At scope 'all', today's `src/js` still has these violations: `admin.js` and `library.js` dialogs; `interactions.js`, `library.js` and `player.js` key listeners; `map-mode.js` and `player.js` colour literals; `song-metadata.js` confirm; plus backend imports and storage uses. These files are deleted at I1, ED5 and I3a.

3. **`PURE_HELPERS` list (D46) in `check-source.mjs`:** I defined the modules a `commands.js` file may import statically:
   - the registry and keys: `src/app/{commands,keys}.js`
   - other app modules: `src/app/{clock,profile,error-copy}.js`
   - Stage helpers: `src/stage/{glass,grid}.js`, `src/stage/surfaces/roadmap-layout.js`
   - Library models: `src/library/{library-model,add-model}.js`
   - shared models: `shared/{song-map,practice,metadata,notation}.ts`
   - any `*.copy.js`

   Integrations may amend the list. `src/app/global-commands.js` is not covered, because the contract names only `*/commands.js` and `transport-commands.js`; if it should follow the same rule, the integrator should open a ticket for F1.

4. **For U1 (`src/ui/icon.js`):**
   - The sprite symbols have no stroke-width. U1's `primitives/icon.css` should set `stroke-width: var(--icon-stroke)` on the icon svg; the token is in `tokens.css`. I deliberately did not add a global `svg` rule, because it would change alphaTab's SVG.
   - The sprite root has `aria-hidden` and `focusable="false"`; `icon.js` hides it when it injects it.
   - The id `i-drum` is the custom glyph, not Lucide's drum icon.

5. **For S1 (`main.js`, `topbar.js`), `layout.css` offers:**
   - `.app-frame[data-chrome=topbar|none]` > `.app-topbar` + `.app-main`
   - `[data-scroller]` and `.app-content`
   - the variables `--content-max`, `--gutter`, `--h-topbar`, `--safe-*`

   S1 should use these frame classes, or request changes through a ticket for F1.

6. **Additions beyond the contract:**
   - Tokens: `[data-distance=stand]` is accepted as an explicit Stand.
   - CSS guard: two extra rules, `main` (the layer statement must come first) and `placement`.
   - Source guard: a `colour` rule for JS, justified by the §7.6 exemption list.

7. **`--hit-handle` on the Stage:** I followed §7.2 (24 px on fine pointers, 44 px on coarse). Spec §8.2 lists a Stage column of 44 px. If the owner wants 44 px on the Stage with fine pointers too, the contract needs a ruling.

8. **`check-source` false-positive risk:** a string that is exactly a short hex word (for example `'#add'`) counts as a colour literal. The match requires 3, 4, 6 or 8 hex digits not preceded by a word character, so URL fragments such as `/x#add` are not affected.

### pass 2

1. **Contract note for `docs/ux2/architecture.md` §7.2 (not F1's file):** the set-independent block should show the Stage value `--hit-handle: 44px` on `:root[data-place=stage]`, matching spec §8.2 (the visual size stays 8 on fine pointers and 20 on coarse). F1 now implements this, and a test in tokens-contrast checks it. If the owner rules otherwise, delete that one declaration in tokens.css and the one test.
2. **Still open from the earlier F1 handoff:** paper `--now` should read #b85200 instead of #c25700 in §7.2.
3. **New contract detail for §7.6:** the router.js sessionStorage limit is now enforced. router.js may use only `getItem`, `setItem` and `removeItem` with the key `'ws.intendedRoute'`, as a literal or a `const` holding it, and `typeof sessionStorage` is allowed. The router package should write its stash that way.
4. **For the integrator:** `npm test -- --maxWorkers=2` fails, because the `test` script already passes `--maxWorkers=${VITEST_MAX_WORKERS:-2}`. The §9.0/§10.1 completion-check instructions should say to set `VITEST_MAX_WORKERS` and run plain `npm test`.

## F2

### pass 1

Requests for other owners:
1. DT1 (desktop/main.cjs): the --smoke-test block calls `window.woodshedAppearance.set(theme)`. Per §2.5 that method is now `apply({theme, stage})`, persists nothing and does not call the desktop. Persisted renderer theme changes go through prefs.set('theme', …) in prefs.js.
2. S1 / BK4 (boot step 5): after account.patch(store.pendingAccount) succeeds, call `clearPendingAccount()` from src/app/prefs.js, or set `store.pendingAccount.value = null`. Either clears both the signal and ws.prefs.pendingAccount.
3. S1 (main.js and routes.js):
   - Pass getSession/disposeSession from src/stage/session.js in the router ctx as `ctx.getSession` and `ctx.disposeSession`. Without them the router loads src/stage/session.js through import.meta.glob, and ctx.session is null while that file does not exist.
   - The router calls `window.woodshedAppearance.refresh()` (theme-init) to set theme-color per place.
   - `router.settled()` and `router.stop()` also exist.
4. PL1: prefs.js calls the bridge `window.woodshedDesktop.setTheme` directly instead of importing desktop.js, so that 0A modules have no forward import of a 0B file. If PL1 wants prefs.js to use `desktop.setTheme`, that is a ticket for F2.
5. AU1 and the I0A integrator: src/api/client.js statically imports `client` from '../app/auth.js' (AU1, wave 0B), as the contract says. Until AU1 lands, client.js must not be reachable from a Vite entry; it is not reachable in 0A, so `vite build` is unaffected. While auth.js is missing, a test that imports client.js has to vi.mock both '../src/app/auth.js' and the raw specifier '../app/auth.js'; tests/api-client.test.js shows the pattern.
6. FX1: theme-init now reads ws.prefs (theme, stage, library.layout), and prefs.js migrates and then removes the 13 ws.* keys on first access. Fixture switches should seed ws.prefs, for example through fx-prefs.

Contract points other packages should know:
- `store.prefs` and `store.pendingAccount` are getters that load prefs on first access.
- `subscribe()` on a signal fires on changes only, not immediately.
- In the dom.js Popover shim, the open state is the `data-popover-open` attribute; there is no `:popover-open` pseudo-class.
- The old app's theme `<select data-theme-choice>` no longer works at runtime. This is allowed, since the old app only has to keep its tests green and it is deleted at I1.

No tests of other packages were changed or deleted.

### pass 2

All earlier handoff items still apply. New contract notes for other packages:
1. ED3/ED4 (edit.js) and SE1 (settings.js): the router now follows §2.3 as written. Going from edit to editFind, or from settings to settingsPage, unmounts and remounts the view, even though each pair shares one module. update(match) only comes for the same route name (for example an Edit tab switch, or one settings section to another). The session is still kept between edit and editFind. If those packages want editFind or settingsPage handled as an update instead, that needs a §2.3 amendment and then a ticket for F2.
2. ED5 (drum keys, §3.4 `chart.piece.<kitId>`): in ws.prefs `edit.chart.keys`, an empty string means the user cleared that kit's key in 1.x, so it has no key. Do not fall back to the KIT default letter for it. Only a kit that is missing from the map uses its default.
3. Everyone writing views and primitives: h() now sets value, selectedIndex and checked after the children are appended, and a property set to null is left unset (the attribute is removed).
4. Everyone using the effects in store.js: an effect's first run is batched, so anything it writes runs its effects after the first run returns, not during it.
5. Everyone writing tests: in tests/helpers/dom.js, `:popover-open` now works in matches, closest, querySelector and querySelectorAll while the Popover shim is installed. Production code can use the standard pseudo-class.

## F3

### pass 1

For the integrator:

1. **Registry CI lists to fill in.** `tests/registry-ci.test.js` has four lists at the top that integrations fill in:
   - `DEFINITION_MODULES`: I1 adds global-commands and stage/transport-commands; I1b adds library/commands; I2a/I2b add the stage and stems definitions; I3a adds the edit, map and chart definitions.
   - `CONTROL_MODULES`: add `src/stage/controls.js` once ST5 lands. Every CONTROL_SET field (command, longPress, dec, inc, value, valueLongPress, caret) is checked.
   - `ELECTRON_MENU_SOURCES`: add `desktop/menu.cjs` only after the global definitions are registered (I1). It names `nav.settings`, `app.shortcuts` and so on, so adding it at I0A would fail.
   - `SHEET_GROUPS`: set it from S2's group order. Request for S2: export the `?` sheet's group order (or import `GROUPS` from `commands.js`) so CI can compare it.

2. **Additions beyond the contract signatures.** All are additive; nothing in the contract was renamed.
   - `commands.js`:
     - `createRegistry()` and the `registry` singleton.
     - Per-command accessors: `state(id)` returning `{visible, enabled, reason, checked, title}`, `disabledReasonFor`, `titleFor`, `passes`.
     - Lookup and scope accessors: `defsFor(scope, key)`, `boundScopes()`, `getScope`, `dynamicFamilies()`.
     - Constants: `GROUPS`, `ELECTRON_MENUS`, `ID_RE`, `CONTEXT_NAMES`, `BOOT_SCOPES`.
     - The three boot scopes are defined inside `commands.js`, so `main.js` does not need to define them.
     - `register` and `registerMany` also return an `off` function.
     - `onChange` listeners receive `{type: 'registry'|'state', ids}`.
     - U1/U2 Button and Menu should read `state(id)` for the disabled reason.
   - `dispatch.js`:
     - `startDispatcher({target, registry, platform})` takes optional arguments.
     - `openOverlays()` returns the overlay stack.
   - `keys.js`:
     - `canonical`, `isValidKey`, `isReserved`.
     - Platform: `setPlatform`, `isMacLike`, `detectMacLike`.
     - Layout map: `setLayoutMap`, `loadLayoutMap`.
     - `aria` and `normalize` accept an optional `{platform}`.
   - `pedals.js`:
     - `profileBindings(name, {custom, inSetlist, isPedalCommand})` and `actionsFor(bindings, {canHold})` for PD1.
     - Constants: `SLOTS`, `GESTURES`, `HOLD_MS`, `DOUBLE_MS`, `SETLIST_RIGHT_HOLD`.
     - `createClassifier` takes a `canHold(slot)` option (default true).

3. **Requests for S1 (`main.js`).**
   - Call `keys.setPlatform(platform)` with `platform.detect()`; the fixture's `fx-platform` should flow through it.
   - Call `keys.loadLayoutMap()` at boot.
   - Call `provide('router', () => router)` (or provide `'route'`).
   - The dispatcher takes the posture from `html[data-posture]` and the edit tab from `ctx.route.params.tab` (`bulkDetails` maps to `details`), so the router must set those.

4. **Choices where the contract was silent.**
   - Shadowing is checked between consecutive bindings in a chain. Ecs over E plus E over G covers Ecs over G for Escape, which the §3 list implies but does not name.
   - Esc in a text input closes the topmost overlay, otherwise blurs the field, unless the field declares `data-consume-keys="Escape"`.
   - Rule 7's list of interactive elements also includes native checkbox, radio, button, submit and reset inputs.

5. **For F1's guard.** The "registry reservations" rule can reuse `keys.isReserved`.

### pass 2

Contract clarifications for the architecture owner (§2.6 / D35), matching what F3 now does:

1. **Exact-modifier rule widened.** §2.6 says "Shift is ignored only for '?', '*'". F3 now also offers the bare symbol, after every exact form, when the layout needed Shift (or Option on macOS) to type it. "Needed" means e.key is a grammar symbol (or '+') and e.code is not that symbol's US unshifted key. Effects:
   - US Shift+= ('+') matches '='.
   - German '/', '=' and Mac Option+5 '[' match '/', '=' and '['.
   - No US key changes meaning.
   Please amend the §2.6 symbol-matching block.

2. **Characters on letter keys.** When '?' or '*' is typed on a letter key (AZERTY Shift+KeyM), F3 drops the letter's code candidate, so '?' wins over Shift+KeyM. Please note this in §2.6.

3. **AZERTY '.' is still open.** '.' needs Shift on the US Comma key, so it matches 'Shift+.' (speed.upFine / map.nudgeFwdFine) before the bare '.'. That follows the contract's "'Shift+X': e.shiftKey && e.key === X" alias. Making plain '.' reachable on AZERTY needs an owner decision.

4. **Numpad digits.** Numpad0–9 now match Digit0–9 when e.key is the digit. Please add this to §2.6, which lists only Digit0…9 on e.code.

5. **Ctrl+ reservations.** `isReserved` now also refuses Ctrl+ without Alt. New export: `keys.chordOffMac(str)`, which folds Ctrl+ into Mod+. Registry CI uses it for the bound-twice and shadowing checks. F1's guard can reuse both.

6. **D35 "keyboard-focused".** The dispatcher tracks pointerdown, mousedown and touchstart against focusin itself; it does not rely on :focus-visible. Programmatic focus counts as pointer focus when the last input was a pointer. U-packages need nothing new.

7. **Pedal keyups.** A pedal keyup now goes to the handler that took its keydown, even after `setPedalHandler` replaces or removes it. PD1 can rely on this when it swaps handlers on a profile change.

Still open from the first pass: the registry-CI lists (DEFINITION_MODULES, CONTROL_MODULES, ELECTRON_MENU_SOURCES, SHEET_GROUPS) and the S1 boot requests (setPlatform, loadLayoutMap, provide('router'), data-posture).

## F4a

### pass 1

1. Integrator ticket: the 3 old-app tests listed under failures fail because the wave removes `legacy`, both in the metronome (F4a, per §4.2) and in SongMapStore (F5). They fail after the merge whatever F4a does. F5's acceptance deletes only the 'untouched legacy maps' case. The other two are in test files for modules deleted at I1 (map-mode.js, player.js), so their owners or the integrator should delete them as §9.0 allows. I don't own those test files.

2. Contract deviation on `outputTime` (§5.0, §5.4): SignalsmithStretch 1.3.2's `schedule` (SignalsmithStretch.mjs:117-121) drops every segment before a change whose `output` is at or before `outputTime`. Passing `outputTime: when` for a future change therefore drops the audible segment, and the processor plays the future segment's timeline run backwards. For a quantized jump that means the jump happens early; for a trainer rate change, wrong audio for up to a whole pass.
   - The engine passes an explicit `outputTime` on every call, at the cut: after the last kept change and strictly before `output`. Tests assert it on every post.
   - The worklet's time map can hold only one future change beside the audible one, so later entries are posted from the ticker once the earlier one starts. The pitch gate and native sources still carry the whole plan ahead.
   - Two tests document this against the library's real code: replaying the engine's posts gives matching time maps, and `outputTime === output` is shown to drop the segment.
   - For F4b: on the Signalsmith path a segmented loop needs only the next pass posted (gaps are silenced by the gate). Loops shorter than about 1 s can still be posted late in a throttled tab.

3. ST1b (owner of src/js/notation/audio.js) ticket, item 12 for DrumAudio:
   - connect `DrumAudio.out` to `engine.aux ?? ctx.destination`;
   - subscribe to `engine.on('plan', ({from}) => …)`: cancel only hits with `when >= from` (track each entry's `when`, which `play()` already stores), then set `until = Math.min(until, from)`;
   - keep the `subscribeTransport` cancel-all.
   Until then, a scheduled rate change does not cancel DrumAudio hits already scheduled in its 0.12 s window.

4. Notes for F4b, which takes over engine.js and metronome.js:
   - The metronome already has the §5.2 plan/transport event handling (needed for item 12); keep it.
   - I kept the tempo dual-write (`source/map/detected`) in `serialize()`. Removing it breaks tests/map-mode.test.js:64, which F5 does not remove. It goes with F4b's `serialize() → {songMap}` (D51).
   - The metronome's map-edit pause (`_notify`) and `countInPlan` are left for F4b, per §8.

5. Owner of src/js/notation/entry.js (no package in 0A): line 21 reads `metronome.source`, which no longer exists (it was already undefined). Per §5.2 'that branch goes too'.

6. Deliberate choices beyond the contract text:
   - After pause/stop, aux goes to 0 at once and back to 1 after 50 ms. This keeps editor previews and calibration clicks audible while stopped (contract: play() restores 1). Pending clicks are already cancelled by then.
   - An engine call during a count-in warns in dev (console.warn) and ends the count, rather than throwing.
   - `cancelPending()` returns false and changes nothing when nothing scheduled is pending.
   - An immediate change keeps a pending immediate seek (as today) but drops pending scheduled entries (rate, quantized seek).
   - `seekAt` while stopped falls back to an immediate seek with `{cue: false}`.

7. `createClock()` in tests/helpers/fake-audio.js drives audio time and fake timers only. It does not call `src/app/clock.js` `set()`, because F2 delivers that module in parallel; tests that need the wall clock call it themselves.

Reported failures:
- tests/map-mode.test.js > 'untouched legacy maps save unchanged; edits save a song map with exact decimal tempo': fails because the metronome's legacy save branch is gone (§4.2/§8). F5 deletes this case in the same wave.
- tests/map-mode.test.js > 'an existing drum part becomes the song map and protects its notes from meter changes': fails because `player.js:885` adopts the part only when `songMap.legacy` is set. Removing the metronome's legacy constructor option (§4.2, metronome.js:33-35) or F5's SongMapStore change breaks it either way. map-mode.js is deleted at I1.
- tests/player-ui.test.js > 'closing a source audition restores the original map before the final tempo save': expects the legacy save path (`songMap` undefined). It fails once `legacy` is gone, which F5's store change also causes. player.js is deleted at I1.

### pass 2

1. Integrator ticket (unchanged): the 3 old-app tests listed under failures go red once `legacy` is removed (by F4a's metronome change and F5's SongMapStore change). Merge F4a together with F5, then delete the two remaining cases (map-mode 'existing drum part', player-ui 'source audition'), or amend packages.json so a package may remove them.

2. Architecture amendment (integrator or architecture owner), needed before F4b starts:
   - §5.0 and the §5.1 setLoop row: replace "outputTime: when" with the cut rule. Every post passes an outputTime after the last kept change and strictly before `output`. The time map holds at most one future change; the ticker posts the next one once the earlier one has started. This matches SignalsmithStretch 1.3.2 `schedule`, lines 88-121.
   - Record the aux re-open rule: on pause/stop, aux goes to 0 at once and back to 1 after 50 ms, so previews and calibration clicks still sound while stopped.
   - Record the promotion rule: `rate`/`loop` reflect what is audible. Started entries are applied lazily (`_promote`) before every change and on read. An entry never overrides a direct write made after it was planned.

3. ST1b ticket (owner of src/js/notation/audio.js), widened. DrumAudio must handle every plan change, not only scheduled rates: loop edits that keep the position, `seekAt`, `cancelPending`, and later passes and gaps.
   - Connect `DrumAudio.out` to `engine.aux ?? ctx.destination`.
   - Subscribe to `engine.on('plan', ({from}) => …)`: cancel only hits with `when >= from`, then set `until = Math.min(until, from)`.
   - Keep the cancel-all on `subscribeTransport` / `'transport'`.
   - I0A notes: between 0A and ST1b, a loop edit during Transcribe/Chart playback can leave up to 0.12 s of drum hits from the old plan and skip the new plan's hits in that window. I did not add an engine workaround. It would go against D55, cancel every metronome click on each loop edit, and conflict with ST1b's selective cancel.

4. Notes for F4b (unchanged from the first pass), plus these:
   - `rate` and `loop` are now getter/setter pairs backed by `_rate`/`_loop`.
   - Plan entries carry `seq` and `promoted`.
   - Keep `_promote()` at the start of any new mutator, for example segmented `setLoop` and `appendPass`.

Reported failures:
- tests/map-mode.test.js > 'untouched legacy maps save unchanged; edits save a song map with exact decimal tempo': fails because §4.2 removes `legacy`. F5 deletes this case in the same wave.
- tests/map-mode.test.js > 'an existing drum part becomes the song map and protects its notes from meter changes': fails because player.js:885 needs `songMap.legacy`. This test covers map-mode.js, which is deleted at I1. No package in 0A owns this test.
- tests/player-ui.test.js > 'closing a source audition restores the original map before the final tempo save': expects the legacy save path. player.js is deleted at I1. No package in 0A owns this test.

## F5

### pass 1

Tickets:
1. Integrator (I0A): delete the two unowned test cases in ownFailures. Both test modules scheduled for deletion (player.js at I1, tempo-sources.js at I3a). The ownership checker's `--allow` is meant for exactly this, but I was told not to edit files I don't own.

2. Contract name clash in `barIndexAt`. Today's `SongMapStore.barIndexAt(q)` takes quarters; §4.3 defines `barIndexAt(t)` taking seconds, so I followed the contract.
   - The quarter version is now `barIndexAtQ(q)`. The pure `barIndexAt(data, q, starts)` in shared/song-map.ts is unchanged.
   - Old callers that still pass quarters, in files nobody owns, so their results are now wrong at runtime: map-mode.js (×9), map-lane.js:60 and :133, player.js:846, metronome.js:76 (`sectionAt`).
   - F4a/F4b own metronome.js: please switch `sectionAt` to `songMap.barIndexAtQ(q)` or `timeToBar(t).index`.
   - ED1 must use `barIndexAtQ` (or `timeToBar`) when porting map-mode.js logic.

3. F4a/F4b (metronome.js), from §8 and D51:
   - Drop the `{legacy}` third argument in the constructor (it is now ignored).
   - Delete the `songMap.legacy` branch and the `source`/`map`/`detected` dual-write in `serialize()`. §8 lists the tempo dual-write under F5, but it lives in metronome.js, which F5 does not own.
   - Subscribe with `cancelCountIn = !LABEL_REASONS.includes(reason)`; `LABEL_REASONS` is exported from src/js/song-map.js.

4. Behaviour peers should know:
   - Listeners are called `listener(reason, {reason, revision})`. Reasons are the edit reasons plus 'load', 'undo', 'redo', 'restore' and 'adopt'. `setDuration` and `setHasPart` emit nothing.
   - `edit()` defaults its reason to 'edit' (in REASON_ORIGIN), because tests/notation-songmap.test.js calls it with no reason. `replace()` with no reason, and any unknown reason, throws.
   - `fromTaps` returns origin 'tapped' (§4.6), the one constructor that does.
   - `applySuggestion` returns `{change, added: number}`. `sectionsFromMarkers` ignores markers with `deleted`. Both take `(store.data, …, store.duration)`; apply them with `map.edit(change, 'sections')`.
   - `refAt` returns null before bar 0. `phraseAt` inside a pickup returns the first full phrase.
   - `mapSummaryOf` reports bpm as the median of the full bars' bpm, rounded, and meter as the most common one.

5. I1: delete `SongMapStore.positionLabel` together with player.js; it is kept only for that file.

Reported failures:
- tests/player-ui.test.js > 'closing a source audition restores the original map before the final tempo save': it expects the saved tempo to have no songMap. That only happened through `SongMapStore.legacy`, which §4.1 and §8 tell F5 to delete. I don't own the file, so I didn't touch it.
- tests/tempo-sources.test.js > 'audition candidates independently, retain each offset, restore and cancel exactly': at line 83, re-choosing 'Your map' in the old panel calls `replace(map, 'tempo-source')`, and §4.2 says that reason stamps origin 'imported', so the result no longer equals the original. Cancel restores the original exactly. The file belongs to ED4 and is deleted with tempo-sources.js.

### pass 2

TICKETS
1. BLOCKER for I0A. Callers still pass quarters to the renamed `barIndexAt`, which now takes seconds (§4.3). The quarter-note lookup is now `barIndexAtQ(q)`. The patch is a plain rename of `songMap.barIndexAt(` to `songMap.barIndexAtQ(` in:
   - src/js/map-mode.js (9 calls: lines 117, 149, 285, 313, 343, 367, 400, 709)
   - src/js/map-lane.js:60 and :133
   - src/js/player.js:846
   - src/js/metronome.js:76, `map.barIndexAt(q)` → `map.barIndexAtQ(q)`. This is F4a/F4b's file and must land in wave 0A, because notation/entry.js (`scoreFromTiming`) reads `sectionAt` in 2.0. Please add a test with q ≠ t, e.g. 120 qpm with a meter change.
   1a. I tested this patch: three of the four failing map-mode cases pass with it. ED1 must use `barIndexAtQ` or `timeToBar` when porting map-mode.js.
   1b. The fourth case (drum-part adoption) needs player.js:882/885 to stop reading `songMap.legacy`, e.g. `!song.tempo?.songMap`. Otherwise I0A records it with `--allow` until I1 deletes map-mode.js and player.js.

2. I0A: delete the two unowned cases, or `--allow` them: player-ui 'closing a source audition…' and tempo-sources 'audition candidates independently…' (see ownFailures).

3. F4a (metronome.js), from §8 and D51:
   - Drop the `{legacy}` constructor argument.
   - Remove the `songMap.legacy` branch and the source/map/detected dual-write in `serialize()`. The §8 "tempo dual-write (F5)" item now belongs to F4a.
   - Subscribe with `cancelCountIn = !LABEL_REASONS.includes(reason)`.

4. I1: delete `SongMapStore.positionLabel` together with player.js.

5. Waiver request for the orchestrator: F5's diff is 1898 changed lines against e7db2f0, over the L limit of 1500. The growth is regression tests the review asked for.

6. Raise a ticket with the owner of tests/notation-songmap.test.js to give its `edit()` calls a reason. Then F5 can remove `edit`'s default reason 'edit'. The new scan already rejects missing reasons anywhere in src/.

BEHAVIOUR CHANGES PEERS MUST KNOW (ST1b, ED1)
- `adopt(data)` is now an ordinary step with reason 'adopt'. An open batch collects it; on its own it pushes one undo step; inside `withoutUndo` it pushes nothing. So:
  - open-time drum-part adoption (ST1b part.js, "opening a part never creates an undo step") must wrap it: `map.withoutUndo(() => map.adopt(...))`;
  - silent foreign adoption (§2.14.1 "otherwise adopt silently") must also run inside `withoutUndo`;
  - `mapChange` with Edit · Map mounted now gets exactly one map-stack step.
- `adopt` of data with no origin: a map someone made gets 'imported'; the placeholder gets no origin.
- Edits made in `withoutUndo` and `restore()` calls during an open batch now count toward it, so `abortBatch` reverts them.
- `snapTime` floor/ceil before bar 0 can return a time below 0 (extrapolated grid). Past the end, ceil returns t.
- `hasRealMap` rule 4 is true only when the legacy data can actually be translated. Translation also works for legacy times past the duration, or with duration 0 on the server.
- A user-written "Start" label keeps its name; the automatic leading section becomes "Start 2" (or the next free number).

Reported failures:
- tests/map-mode.test.js: four cases put back exactly as in the base so the break stays visible. 'Shift+M maps with the keyboard…', 'E edits the bar in place…' and 'on a map tapped on every beat, 4/4 → 3/4…' fail because map-mode.js (unowned) passes quarters to the now time-based `barIndexAt`. Ticket 1a fixes all three. 'an existing drum part becomes the song map…' fails because player.js adopts the part only `if (songMap.legacy)`, and §4.1 says that field is gone (it now reads undefined). That one is fixed by I1, or by ticket 1b.
- tests/player-ui.test.js > 'closing a source audition restores the original map before the final tempo save': depends on the deleted `SongMapStore.legacy`. File not owned; it is deleted at I1.
- tests/tempo-sources.test.js > 'audition candidates independently, retain each offset, restore and cancel exactly': `replace(map, 'tempo-source')` now stamps origin 'imported', as §4.2 requires. File is ED4's and deleted at I3a.

## F6

### pass 1

Requests for the integrator (no changes were made outside F6's own files):

1. **Bar loop labels (BK1, BK3, BK5).** To get 'Bars x–y loop' in practiceSummary, call `summarize(upgradePractice(practice, {legacyTempo: song.tempo}), {sections: sectionsOf(data, duration), bars: barsOf(data, duration)})`. The §6.3 text `sectionsOf(song.tempo)` doesn't match the §4.1 signature `sectionsOf(data, duration)`. With sections only, a loop that is not exactly a section gets 'm:ss–m:ss loop'.

2. **`pruned` count (ST package that owns practice-state.js).** `pruned` counts only markers dropped and notes trimmed. Expired tombstones are dropped silently, so the "Some old markers were removed to make room." status only shows when the user actually lost something.

3. **Saved Add defaults (BK4, LB2a/LB2b).** addDefaults treats any stemMode other than 'full' as saved. If the owner wants "Full band · 4" saved explicitly to override a guitar/keys profile, the settings schema needs an explicit saved flag (e.g. `addDefaultsSaved`); addDefaults can then read it. Today a saved 'full' with a guitar or keys profile still returns 'six'.

4. **Share snapshots (BK5).** sanitizeForShare also removes onlyMe and tombstones and resets spot lastAt/passes, so the sharer's practice history never reaches a recipient.

5. **New helpers.** shared/practice.ts also exports formatClock and the types SummaryMap, SummarySection, SummaryBar, Click, Loop, Track, Trainer and AccountPracticeDefaults, for consumers that need them.

### pass 2

Requests for the integrator (I changed nothing outside F6's files):

1. **BK4 (settings schema/patch) and LB2b (Add sheet "Use these for future songs").** addDefaults now honours a stored stemMode only when `settings.addDefaultsSaved === true`, or when the stored mode is 'six'.
   - Please add `addDefaultsSaved: v.optional(v.boolean())` to settings.
   - The Add sheet checkbox should write it as true along with stemMode/preset through `settings.patch`.
   - Without the flag, a guitar or keys profile can't save "Full band · 4" as its default.
   - Two-part modes are never returned, saved or not (spec §3.2).
2. **ST (practice-state.js) and spots UI.**
   - MAX_SPOTS (24) and MAX_MARKERS (64) are now add limits only. The UI must block adding a spot or marker when the live count is at or over the limit.
   - upgradePractice and mergePractice never drop live items by count, so after a multi-device merge the live count can exceed the limit.
   - mergePractice now accepts the raw `server.value`, as §2.14.5 calls it, and upgrades it internally. Callers don't need to upgrade it first.
3. **Song backend (§6.3 savePractice summary).**
   - `summarize` now accepts either `{sections, bars?}` or a bare section array, so `summarize(upgradePractice(practice), sectionsOf(...))` labels section loops.
   - 'Bars x–y loop' still requires `{sections, bars}`.
   - Passing `{duration: song.duration}` to upgradePractice also clamps the loop, spot and marker times.

## FX1

### pass 1

Contract deviations for the integrator to approve or amend:
1. Harness discovery also scans tests/fixture/harness/*.harness.js, so the fixture's own smoke harness can sit in a path FX1 owns. A basename that appears twice is an error.
2. Extra fx-nofeature tokens beyond §2.11's six: share and clipboard.
3. Extra switches beyond §11.2: fx-account=new, fx-auth=export_only, fx-processor, fx-companion=busy|firstrun|down, fx-lookup, fx-upload, fx-legacy, fx-shortcuts and fx-jobs=frozen. All are listed in tests/fixture/README.md.
4. fx-reset now acts only when it is fx-reset=1. The 1.9 behaviour of clearing ws.* on every new tab is gone, so the cross-tab prefs test (§10.3) works.
5. The handlers moved into db/{songs,jobs,settings,sharing}.js carry minimal adaptations to seed v2, each commented in its file:
   - listActive returns queued, running and failed jobs only;
   - beat detections live in db.jobs and honour fx-detect;
   - settings:config applies withDefaults to the stored row;
   - sharing finds a link by its token.
   db/setlists.js exports an empty table because 1.9 had no setlist handlers.
6. The package is larger than size L: 56 files and about 5,200 inserted lines, most of it tests and seed data.

Notes for the wave 0B owners:
- Seed table shapes are documented at the top of db/seed.js.
  - BK1: db.songPractice rows {songId, userId, practice, updatedAt}. v1 rows keep songs.practice.
  - BK3: db.devices plus db.devicePresence.
  - BK6: db.setlists.
  - BK4 (settings:demo): db.demoToken.
  - BK7: the metadataSuggestion on the counting song.
  - BK2: the done, unapplied detection is job-detect-nightbus, for jobs.latestDetection.
- F2 (src/app/clock.js): the fixture's fx-now shifts window.Date before any module runs. clock.now() picks it up as long as it defaults to Date.now(). The shift is also recorded on window.__FIXTURE_EARLY__.now.
- S1 (src/app/dev-handle.js): window.__FIXTURE__ === true is set first in <head>.
- tests/fixture/unit/fixture-host.test.js mounts the smoke harness through src/ui/h.js once F2 lands. It calls h(tag, props, ...children) with string attributes only. If F2's h() takes another shape, adjust that harness in an I0A ticket.
- docs/ux2/fixture-notes.md (not owned by FX1) still describes the 1.9 scratchpad fixture and capture.cjs. The integrator may want to point it at tests/fixture/README.md.

### pass 2

Integrator requests:
1. Finding 14 (harness discovery). Either amend §11.2 and the packages.json notes so discovery also covers tests/fixture/harness/*.harness.js (the fixture's own smoke harness), or open an I0A ticket to move fixture-smoke.harness.js to tests/harness/fixture/, which FX1 does not own.
2. Finding 15 (size). FX1 is beyond the §9.0 L ceiling: 56 files and about 5,800 insertions, mostly tests and seed data. Record an explicit exception, or split it later into tooling (runner, count, touch, structure, compare-shots) and seed plus fakes.
3. New fixture contract for §11.2 and fixture-notes.md:
   - Switches stick for the tab through sessionStorage['fx-switches']. A URL without fx-* parameters keeps them; ?fx-reset=1 alone clears them.
   - fx-reset, fx-prefs and the legacy keys apply only on a fresh navigation (not on a reload, back/forward or a cloned tab).
   - fx-prefs combined with fx-view, fx-practice, fx-overview or fx-notation is a console error.
   - window.fixture.call(kind, name, args) runs a handler.
   - opts.structure.viewportOnly is a new option. The overlap check now covers the whole page by scrolling and restoring.
   - The clip check matches chip and readout classes by whole token, not by substring.
4. Ticket for F2/S1 (src/app/platform.js, §2.11). detect() reads fx-platform and fx-nofeature "from the query". It should read window.__FIXTURE_EARLY__.fx (or window.fixture.fx), so these switches survive a reload after the app rewrites the URL. The navigator fakes already survive, because the preamble reads the stored map.
5. Note for BK2, who owns jobs.js bodies in 0B. Beat-detection rows now carry finishAt. Handler modules can export settle(now), which runs on boot and on each creep tick, and resume(), which runs once after boot. Keep both if you rewrite jobs.js.
6. Still open from before: docs/ux2/fixture-notes.md, which FX1 does not own, describes the 1.9 fixture. Point it at tests/fixture/README.md.
