# Wave 0B package handoffs
Collected from each package's implement and fix passes (later passes supersede earlier ones).

## AU1

### pass 1

Choices where the contract was silent, for the integrator and for S1/ON1/SH1:
1. Signed out returns `status: null`, because the contract's status type has no signed-out value. main.js should check `user` before `status`.
2. In required mode, a pending OAuth flow error, or a stored session the backend refuses (code 'unverified'), is thrown as AuthError{kind:'oauth'}. main.js should catch kind 'oauth' and call `renderSignIn(outlet, {error})`. Only 'config' and 'network' go to `renderFatal`. The raw error for renderFatal's `details` is in `err.cause`.
3. Optional mode (Shared Stage) never throws. Any AuthError comes back as `{user: null, status: null, error}`.
4. Exports beyond the contract:
   - `AuthError`
   - `OAUTH_MESSAGES` (today's sign-in copy, plus 'unverified', 'start_failed' and 'fallback')
   - `oauthError(flowError)`, for ON1
   - `OAUTH_PARAMS`
   - `configure({activeSession})`, a seam for tests and integration. By default, signOut finds the session through `import.meta.glob('../stage/session.js')`, the same way router.js does. Until ST1b lands (wave 1a) there is no session to flush, and sign-out still works.
5. `signIn()` throws AuthError{kind:'oauth', code:'start_failed'} when Google sign-in cannot start; ON1 shows its message. On success the page navigates away.
6. A sign-out in another tab, or a session the backend later rejects, fires `onChange({user: null, status: null})`. main.js (S1) should reload or render sign-in on that, as 1.9 reloaded. A live users.me status change, for example to 'suspended', also comes through onChange.
7. Desktop is detected by the presence of `window.woodshedDesktop`, as prefs.js does. auth.js does not import PL1's desktop.js.
8. The 1.9 `src/js/auth.js` is untouched; I1 deletes it, as scheduled.

No requests for files owned by other packages.

### pass 2

For the integrator, S1, ON1 and SH1:
1. Ticket for S1 (finding 7): in required mode, initialize() throws AuthError `{kind: 'oauth'}` for these codes: expired, access_denied, invalid_flow, oauth_error, rejected, unverified. main.js must catch kind 'oauth' and call `renderSignIn(outlet, {error: err})`. Only 'config' and 'network' go to renderFatal. S1's app-boot test should cover a thrown kind 'oauth' leading to renderSignIn. Consider adding this to the §2.3.1 step 3 wording.
2. Correction to my earlier handoff: signOut() never throws. Nothing in S1, SH1 or ON1 should build a "Couldn't sign out" or "Retry sign out" state. Revoking the session on the server is best effort.
3. New error code: initialize() can throw AuthError `{kind: 'network', code: 'timeout'}` when the backend does not answer within 20 s, for example a stored session while offline. renderFatal's Retry just calls initialize() again. The deadline can be changed with `configure({connectTimeoutMs})`.
4. signIn() errors: 'start_failed' when sign-in cannot start (offline, or any error that is not a ConvexError). 'rejected' with the backend's message when the backend throws a ConvexError.
5. If a sign-out happens while initialize() is still connecting, initialize() resolves `{user: null, status: null}` instead of a user.

No requests for files owned by other packages.

## BK1

### pass 1

Tickets for the integrator. The fixes all follow from the contract (D52: `songs.get` has no practice; §6.3: list rows have no notes or metadataLocks). Each one is in a file BK1 does not own.

1. **BK5, convex/sharing.test.ts:69 and :77.** These read `saved.practice` from `songs.get`. Read it with `await bob.query(api.songs.getPractice, {id: savedId})` instead. This clears 1 failing test and 2 typecheck errors. Until `finishImport` writes `songPractice`, `getPractice` falls back to the copied `songs.practice`, so the change works before and after BK5's rewrite.

2. **BK7, convex/metadata.test.ts:73–87.** The test reads `notes` and `metadataLocks` from `songs.list` rows, which the contract removes. Read the edited rows with `api.songs.getMany({ids: [a, b]})` (the full shape) instead. This clears 1 failing test and 1 typecheck error.

3. **src/js/backend.js:41-43, `renameSong`.** §8 schedules this deletion for BK1 in wave 0B, but packages.json gives BK1 no ownership of backend.js. Delete it at integration; nothing calls it.

4. **FX1, tests/fixture/unit/fixture-db.test.js:54 and :58.** These use `songs:rename` as their sample mutation. I kept a fixture-only `songs:rename` handler (commented) so FX1's test stays green. Switch the test to a 2.0 mutation, for example `songs:confirmRecording`, then delete that handler from tests/fixture/db/songs.js.

5. **FX1, tests/fixture/db/notation.js, optional.** `notation:save` does not maintain `hasChart`. My songs handlers derive it live from `db.notation`, so nothing is broken today.

6. **Notes for other wave-0B packages and the integrator:**
   - BK3 `worker.finish` and BK5 `finishImport` should write `songPractice` and the summaries, as the contract says. If they don't, `getPractice` and the list still read correctly through the fallbacks, and the account backfill fills them in.
   - Do not add `hasChart` writes to old songs elsewhere: on an old song, `hasChart` is one of the two fields that tell the upgrade it has run.
   - songs.ts exports `nonMapFields`, `toListRow`, `toClient`, `summaryPatch`, `reviewMetadataOf` and `deleteSongData`. migrations.ts exports `practiceSummaryFor`, `mapSummaryFor`, `summaryMapOf`, `upgradeSong` and `ensureBackfill`, if peers want to share them after I0B.

7. **Optional cron.** If the owner wants a whole-table upgrade even for accounts that only browse, add a cron entry for `internal.migrations.backfillB1` with `{cursor: null}` in a new convex/crons.ts (unowned today). The backfill is idempotent, so re-runs are safe. Owner gate G2 still covers this.

8. **Contract choices where the text was ambiguous:**
   - A stale-base conflict writes nothing: no tempoRev bump, no tempoSaveId.
   - `saveTempo` requires a valid `tempo.songMap`; anything else is `invalid`, including 1.5-style `{source, map}` tempos.
   - `mapSummary` uses F5's `mapSummaryOf` (median bpm, most common meter, section display names), per §4.1's "only through these functions", not the "bpm and meter of bar 1" wording in §6.3.
   - `getPractice` returns the stored blob raw, of any version; the client upgrades it.
   - `deletePart` itself clears `hasChart`, so every caller gets it.
   - Removing a song from a setlist does not change the setlist's `updatedAt`.

9. **Size.** The diff is 17 files, about 1,655 insertions and 79 deletions. That is over the L ceiling of 1,500, and about 60% of it is tests. Please record the size exception, as was done for F5 and FX1.

### pass 2

Tickets for the integrator. Each is in a file BK1 does not own. They replace ticket 1 and add to tickets 7 and 8 from the first pass; tickets 3–6 still stand.

1. **BK5, convex/sharing.test.ts (required before I0B is green).**
   - Lines 69 and 77: read practice with `await bob.query(api.songs.getPractice, {id: savedId})` instead of `saved.practice`. Note that line 77 comes after `savePractice` of `{rate:1}`, so it reads the new `songPractice` row.
   - Line 72: change to a 2.0 tempo, for example `{songMap: defaultSongMap(60, 200)}` with `baseRev: 0`. The 1.5 `{map:[…]}` shape is now rejected as `invalid`.
   - Line 73: `saved.tempo.map[0].bpm` reads Bob's untouched copy, so it still holds.

2. **BK5, convex/sharing.ts:54 (`sharedSnapshot`) and the share view.** They read `song.practice`, but 2.0 practice saves write only `songPractice`. Read it through `storedPractice(ctx, song)`, exported from convex/migrations.ts: the songPractice row, else `songs.practice`, else null. `finishImport` should also write `songPractice` and the summaries.

3. **BK7, convex/metadata.test.ts:73–87 (required).** Read the edited rows with `api.songs.getMany({ids:[a,b]})`, not `songs.list`: list rows no longer carry notes or metadataLocks.

4. **Integrator: new convex/crons.ts (unowned).** Add an hourly or daily `internal.migrations.backfillB1` run with `{cursor: null}` so accounts that only browse get their stored fields filled. Every read is already correct without it (lazy `chartOf`, summaries computed on read, the `getPractice` fallback). The backfill is idempotent, so re-runs are safe.

5. **Integrator: Appendix C amendments.**
   - (a) A stale-base `saveTempo` conflict writes nothing: no `tempoRev` bump and no `tempoSaveId`. The §6.3 text says "either way bump"; ST's §2.14.1 logic works either way.
   - (b) Record the size exception: the BK1 diff from 39dcc28 is 17 files with 1,859 insertions and 81 deletions, about 60% of it tests. That is above the L ceiling of 1,500.

6. **Peers (BK3/BK5).** New songs created without `hasChart` still read correctly, at the cost of one indexed read each in `list` until the backfill reaches them. Writing `hasChart: false` and a `mapSummary` (via `mapSummaryFor`) on insert avoids that read. Newly exported helpers in migrations.ts: `chartOf`, `chartPatch`, `storedPractice`.

7. **Earlier tickets 3–6 still stand:**
   - delete `renameSong` from src/js/backend.js;
   - FX1 switches fixture-db.test.js away from `songs:rename`;
   - FX1's `notation:save` fixture handler may optionally maintain `hasChart`;
   - other packages must not write `hasChart` to old songs outside a chart change.

## BK2

### pass 1

Requests for other packages:
1. BK3 (convex/worker.ts, beatsDone): when the server writes the map for an unmapped song (D44), also set `appliedAt: now` on the job. Without it, `jobs.latestDetection` will offer that detection again ("Bars found while you were away · [Use them]") the next time the song opens, because only appliedAt marks a detection as handled.
2. BK3 (worker.ts): `jobs.ts` exports `RESUME_MESSAGE = 'Resuming local files…'`, the same value as worker.ts's own constant. `autoRetry` may import it so the two stay identical. Optional.

Deviations from the contract:
3. `jobs.retry` also accepts an optional `deviceId`. If given, it must be the job's device, otherwise retry_wrong_device. This keeps the 1.9 caller (`src/js/backend.js retryJob`, which passes deviceId) working until I3a, and lets the desktop assert its own computer. The contract's `{jobId, preset?}` calls work unchanged.
4. `createBeatDetection` and `createSectionDetection` without a deviceId use the caller's most recently seen paired device (devicePresence, online first); with no presence recorded, the only paired device; otherwise device_unpaired with "Choose which computer should do this." This is how "the local device is used" is implemented, since the server cannot otherwise know which computer is local.
5. Re-splitting an uploaded song refuses only when the job reuses the song's own upload (same source value) and `originDeviceId` is set. 1.9 uploads without originDeviceId run on any device.
6. A missing or other account's device in createSeparation and detections is refused with device_unpaired (the message still contains "companion", which sync.test needs), not device_other_account.
7. `createSeparation` now returns `{jobId}` only, as the contract says; 1.9 also returned `songId: null`.

For integration:
8. The fixture imports `convex/lib/presets.ts` (resolveQuality, PRESETS, STEM_MODES), so BK4's presets changes flow straight into the fixture's settingsSummary.
9. ST1b, LB2b and S1 can use `src/api/jobs.js`: subscribeActive, subscribeJob, latestDetection, markApplied and retry({jobId, preset}).

### pass 2

Still open from the first pass:
1. BK3 (worker.beatsDone): set `appliedAt: now` when the server writes the map for an unmapped song.
2. BK3 (worker.ts): optional. autoRetry can import `RESUME_MESSAGE` from jobs.ts.

New:
3. Integrator ticket (finding 12). To make the fixture reuse any live detection the way the server does, change FX1's tests/fixture/unit/fixture-db.test.js:211-230 so its createBeatDetection calls use a song with no seeded live beats job (for example 'velvet', not 'quiet'). Then change `liveDetection` in tests/fixture/db/jobs.js to match any live job of that kind for the song. BK2 can make the fixture change once the FX1 test is updated.
4. ST1b and DT (finding 10b). On the desktop, pass the local companion's own deviceId (from the companion's `/status`) to jobs.createBeatDetection, createSectionDetection and retry. Without it the server picks the most recently seen online computer, which can be the wrong one when two computers are online.
5. Contract notes for the client (ST1b, S1):
   - `jobs.retry` on a failed detection can now refuse with `job_live` and `{jobId}` when a newer detection is live; the client should follow that jobId.
   - A user's detect call can now cancel a stale queued detection and return a new jobId.
   - Reusing a chained job clears its chainedFrom.

Earlier deviations still apply: retry accepts an optional deviceId; the default device rule; refusals use device_unpaired; createSeparation returns {jobId} only.

## BK3

### pass 1

1. BK4 (presets.ts): worker.claim still calls `resolveQuality(job.settings)` with one argument, as it does today, and forces `model: 'htdemucs_6s'` itself when `stemMode === 'six'`. If BK4 changes `resolveQuality` to `(preset, stemMode)` (as §6.4's retry text suggests), the integrator needs to update the one call in `convex/worker.ts` (`qualityFor`). worker.finish reads `withDefaults(row.settings).autoBeats` and `.autoSections` and treats undefined as true, so it works whether or not BK4 has added those defaults yet.
2. CPB (companion/server.mjs): new calls are `worker.heartbeat({token, state, currentJobId?, appVersion?, platform?, accelerator?})`. A ~60 s interval fits the client's 150 s online window. Send `state: 'offline'` on shutdown. Also pass `errorCode` and `meta` to `worker.progress` (stage and percent are still required), pass `sections` to `worker.beatsDone`, and call `worker.sectionsDone({token, jobId, sections})` for `kind: 'sections'` jobs (claim returns `downbeats`). `beatsDone` and `sectionsDone` do nothing on a repeated report, so retrying is safe. A revoked computer now gets coded `device_unpaired` or `device_revoked_admin` errors; both messages still contain "not paired".
3. BK1 / list row: new songs from worker.finish now carry `mapSummary`, `originDeviceId`, `resolvedUrl` and `provider`. Imports write `songPractice` and never `songs.practice`, so `getPractice` will find import practice in `songPractice`. A song split with `six` stores `stemMode: 'six'`. This is not in the contract; it keeps a later re-split defaulting to 6 stems. Tell me if it should stay `'full'`.
4. SE3 / PL1 (error copy): admin.account device rows are `{id, name, revoked, revokedBy: 'user'|'admin'|null, lastSeenAt: number|null}`. New codes reach the client from these modules: `device_unpaired`, `device_revoked_admin`, `device_other_account`, `device_limit` (with `data.limit`), `queue_full`, `storage_full_user`, `storage_full_app`, `invalid` (rename has `field: 'name'`, admin reason has `field: 'reason'`) and `not_found`.
5. Data: no backfill is needed. A 1.9 revoked device without `revokedBy` is checked against `adminAudit` `device.revoke` entries (newest 200 per user), so a 1.9 admin revoke still blocks re-pairing. A queued 1.9 import job's practice is upgraded and capped when it finishes.
6. Two small extras beyond the contract: the device limit counts only active (non-revoked) devices, with at most 100 rows read, so revoked rows no longer block new pairings; and `admin.cancelJob` can also cancel a job in error that is waiting for its automatic bot-check retry.

### pass 2

1. Contract amendment, §6.6 / D44 (BK2, ST1b): when `worker.beatsDone` writes the detected map itself (the song had no real map, whether the job is user-started or chained), it now sets `appliedAt` on the job. So `jobs.latestDetection` returns null for server-applied detections, and the client sees them only through the external-change path. When the song is already mapped, the job still has no `appliedAt`, and the client marks it through `markApplied` as before.
2. Contract clarification, §6.6 devices (SE3 / admin UI): a 1.9 revoked device row without `revokedBy` counts as a user revoke everywhere. It can pair again, and `admin.account` reports `revokedBy: 'user'`. The audit-log lookup is gone. This matches 1.9, where any revoked computer could pair again; if an admin wants such a computer kept out, the remedy is to suspend the account or revoke it again in 2.0, which records `revokedBy: 'admin'`. The exported `revokedByOf(device)` is now sync and takes one argument.
3. CPB: `worker.heartbeat` is now an upsert. `appVersion`, `platform` and `accelerator` can be sent only on connect or when they change, and the stored values are kept otherwise. `state` and `currentJobId` must be sent on every beat; leaving out `currentJobId` clears it.
4. The device limit now also applies when a user-revoked computer pairs again: it is refused with `device_limit` (with `data.limit`) when 20 computers are already active. Error copy (SE3 / PL1) may want to cover this case on re-pair.
5. A bot-checked job whose computer was revoked, or whose account was paused, during the backoff stays in error with `errorCode: 'bot_check'` and no `retryAt`. The UI should show the normal Retry path for it.
6. Earlier handoff items 1 to 6 still apply, except that item 5's audit-log note is replaced by point 2 above.

## BK4

### pass 1

TICKETS
1. FX1, tests/fixture/unit/fixture-db.test.js line 269. Replace `expect(fresh.profile).toBeUndefined();` with `expect(fresh.profile).toEqual({instruments: [], primary: null, openWithMyPart: 'in'});`. If the point is "no stored row", additionally assert `runtime.db.settings === null`. Under §6.5 the config query always includes the defaults. This is the only red test in `npm test`.
2. BK2, convex/jobs.ts createSeparation. `withDefaults()` now returns the whole account settings (profile, pins, onboarding, practice). Use `processingSettings(args.settings)` from lib/presets for `job.settings`, so job rows don't carry pins or profile. `withDefaults(row).autoSections` is still right for createBeatDetection. For `retry({jobId, preset})`, either `resolveQuality(preset, job.settings.stemMode)` or `resolveQuality({...job.settings, preset})` works.
3. S1, main.js boot step 5. Call `startAccount()` from src/app/account.js. It subscribes settings.config, fills store.config and store.account, and applies and clears store.pendingAccount itself, so main.js should not call `clearPendingAccount()` (this supersedes the forward.md note). For boot step 8, wait until `account.loaded.value` is true before checking `account.value.value.onboarding.whatDoYouPlay`.

NOTES
- Error codes callers will see from `settings.patch`:
  - `invalid`, with `data.field` naming the field (e.g. `practice.countIn.length`);
  - `pins_full`, for more than 12 pins;
  - `not_owner`, for another account's song in pins.
- Deleted songs in a pins list are silently dropped.
- `profile.primary` must be null or one of the profile's instruments.
- More than 6 instruments is refused; duplicates are removed.
- `onboarding.coach` must be a whole number from 0 to 15.
- BK4 does not depend on owner gate G1: `settings.demo` reads `env` from `./_generated/server`, and the hand-edited Env line typechecks without codegen.
- With `settings.save` gone, the 1.9 app's src/js/settings.js would break at runtime against a real backend until I1. That is allowed by §8, and its tests mock the backend and still pass.
- Testing note for later packages: a happy-dom test that imports src/api/client.js fails on the missing `../app/auth.js` until AU1 merges. tests/app-account.test.js therefore uses the default environment with a stubbed `localStorage`.

Reported failures:
- tests/fixture/unit/fixture-db.test.js:269 (owned by FX1, not BK4) fails because it asserts `fresh.profile` is undefined for fx-account=new. That was 1.9 behaviour; §6.5 says `config` returns the profile default {[], null, 'in'}, and the fixture follows the server.

### pass 2

TICKETS (unchanged from the first pass, plus one note)
1. FX1, tests/fixture/unit/fixture-db.test.js:269. Replace `expect(fresh.profile).toBeUndefined();` with `expect(fresh.profile).toEqual({instruments: [], primary: null, openWithMyPart: 'in'});`. Optionally also assert `runtime.db.settings === null`. This is the only red test in `npm test`, and BK4 is green only once it lands.
2. BK2, convex/jobs.ts:
   - Use `processingSettings(...)` for `job.settings`.
   - For retry, use `resolveQuality(preset, job.settings.stemMode)`.
3. S1, main.js:
   - Boot step 5 calls `startAccount()` and does not call `clearPendingAccount()`.
   - Boot step 8 waits until `account.loaded.value` is true.

CONTRACT NOTE for §2.4/§6.5 and SE, LB and ON1 (an amendment the integrator may want to record)
- settings.patch never refuses a `profile.primary` that is missing from `instruments`. It replaces it with the first instrument in the list, or with null when the list is empty.
- `instruments` and `pins` are deduplicated before their caps (6 and 12) apply.
- settings.patch resolves to the merged settings it stored. account.js now uses that result for what it shows, so the fixture's `settings:patch` must keep returning the merged settings (it already does).
- The earlier NOTES line "profile.primary must be null or one of the profile's instruments" is replaced by the normalisation above.

Reported failures:
- tests/fixture/unit/fixture-db.test.js:269 (owned by FX1, not BK4) still expects `fresh.profile` to be undefined for fx-account=new. Under §6.5, config returns the profile default. The fix is handoff ticket 1.

## BK5

### pass 1

1. **F2 (owner of `src/api/client.js`), needs a §2.1 amendment.** `publicClient()` should also return `action(name, args)`, alongside `query`, `subscribe` and `close`, with errors normalised to `ApiError`. `shareAudio.playback` is an action that signed-out visitors of `/share/:token` must call; 1.9 used the public client's `.action`, and §2.18 sets `resolveUrls: shareAudio.playback`. `src/api/sharing.js` `playback` already calls `publicClient().action('shareAudio:playback', {token})` and its test mocks that, but it fails at run time until client.js adds it. SH1 (wave 2b) needs this first.

2. **Contract gap for the architecture owner and BK0/schema.** Spec §6.1 gives the Share dialog a "☑ Sections and tempo map" toggle, but §6.7 and the schema have only `includeNotation`. Building it needs `songShares.includeMap: v.optional(v.boolean())`, a `sharing.create` arg `includeMap`, and `sharedSnapshot` omitting `tempo` (and the sections in practice labels) when it is false. I did not build it because I cannot change `schema.ts`. It needs an amendment before SH1.

3. **Interface notes for SH1 and integration.**
   - `sharing.view` now returns `ownerName`.
   - `practice` is always a v2 blob, already sanitised.
   - `tempo` is `{songMap}`, or for pre-1.6 songs `{source?, map, detected}`, or absent. The 1.x click fields now live in `practice.click`, not `tempo`.
   - Sharing errors now carry codes (`not_found` for unavailable links and songs, `not_owner`, `invalid`, `storage_full_user`, `storage_full_app`, `account_export_only`) with the old messages.
   - `internal.sharing.importContext` now returns `{keys}`.
   - `sharedSnapshot(ctx, song)` is now async; `sharedSource` is unchanged for `notation.ts`.
   - The fixture adds `db.shareCopies` (created on first save) and a `fx-share=copying` switch; FX1 may want to list it in `tests/fixture/README.md`.

4. **Integrator note.**
   - `convex/sharing.test.ts` reads practice and tempo straight from the tables and writes 1.x-style tempos directly, so it passes against both the base and BK1's songs/notation.
   - When BK1 merges, `finishImport`'s new song already has `hasChart` and `mapSummary` set, so BK1's per-account backfill marker (`isUpgraded`) works.

### pass 2

1. **F2 ticket and §2.1 amendment (unchanged and still needed).** `publicClient()` in `src/api/client.js` should also offer `action(name, args)`, with errors turned into `ApiError`.
   - Signed-out visitors need it, because §2.18 sets `resolveUrls: shareAudio.playback`.
   - Until it lands, `sharing.playback` rejects with `ApiError` 'unknown' instead of throwing a TypeError.
   - When F2 lands, the test in `tests/api-sharing.test.js` that checks the real client's keys will fail on purpose. Then remove the guard in `sharing.js#playback` and update that test.
   - SH1 must not use `playback` until this lands.
2. **Contract gap for the architecture owner and BK0.** Spec §6.1's "Sections and tempo map" toggle needs:
   - `songShares.includeMap: v.optional(v.boolean())` in `schema.ts` (BK0 owns it), and an amendment to §6.7.
   - Then a BK5 follow-up adds `includeMap` to `sharing.create`, `sharing.status` and `src/api/sharing.js#create`. When it is false, `sharedSnapshot` leaves out `tempo` and labels practice by time only, and `finishImport` then copies no map.
   - This must land before SH1.
3. **Size exception for Appendix C.** BK5 is 1,677 changed lines against 39dcc28, over the 1,500 L ceiling. Ignoring whitespace it is 1,243. The extra is reformatting of the dense one-line style in `convex/sharing.test.ts`, `sharing.ts` and `shareAudio.ts`, plus tests. Please record an exception rather than undo the reformatting.
4. **Interface notes from the previous pass still apply**, with these additions:
   - `sharing.view` and `sharing.playback` are now async.
   - `subscribeView` passes a `publicClient()` failure to `onError` and returns a harmless `off()`.
   - The fixture's `shareAudio:save` now follows `fx-share=saved` (returns the saved song) and `fx-share=copying` (rejects with code `invalid`).
   - The fixture now exports `scoreHasChart`.

## BK6

### pass 1

Additions to §6.8, for the integrator to approve or amend; consumers (LB1a, LB3, ST4, SE2) should rely on them:
1. Return values. `addSongs` returns {added: Id<'songs'>[]}, the ids it actually appended; an 8 s Undo removes exactly these (via setSongs). `setSongs` returns the order it stored. `rename`, `remove` and `touch` return null. `create` returns the id, as the contract says.
2. `get` and `touch` take `id: v.string()` instead of v.id('setlists'), because the id comes from the URL (/set/:id, ?set=). A malformed id makes `get` return null and `touch` fail with `not_found`, rather than an argument-validation error.
3. `setSongs` quietly drops an id that is still in the stored list but whose song has since been deleted (a reorder racing a delete). Any other missing or foreign id is `not_found`.
4. Error details. The `invalid` error carries field:'name'. `setlist_limit` and `setlist_full` carry limit:100. Both lists and songs use `not_found`, never `not_owner`, for anything that is not the caller's. Messages: "Enter a setlist name of 1–80 characters.", "You can keep up to 100 setlists.", "A setlist holds up to 100 songs.", "One of these songs is not in your library.", "This setlist is not in your library." error-copy.js (F-series) may want copy rows for setlist_limit and setlist_full.
5. Extra exports. convex/setlists.ts exports LIMITS = {lists: 100, songs: 100, name: 80}. src/api/setlists.js also exports LIMITS, tidyName, isValidName, subscribeList and subscribeGet. data.js should use subscribeList for store.library.setlists, and /set/:id should use subscribeGet.
6. Unchanged writes are skipped (same name, same order, nothing new to add), so updatedAt and the list order only move on a real change.

### pass 2

Amended handoff item 3 (it replaces the earlier wording): `setSongs` quietly drops any requested song id whose song no longer exists, wherever it comes from. That lets a stale drag reorder, or an LB3 8 s Undo built from an older snapshot, succeed after a song was deleted through `songs.remove`/`deleteSongData`, which takes the id out of every list. An id whose song exists but belongs to another user is still `not_found`. Consumers should take the returned order as the truth, because it may be shorter than what they sent. The fixture follows the same rule.

Fixture note: new ids from `setlists:create` are `set-<n>` from a counter that only goes up (`db.setlistSeq`, saved with the db), so an id is never reused after a remove. LB3 and ST4 harness states can count on a stale `/set/:id` or `?set=` leading to the "list deleted" handling.

All other handoff items from the first pass still apply as written.

## BK7

### pass 1

1. **BK1 (convex/songs.ts):**
   - `songs.get` and `getMany` (`toClient`) should include `metadataSuggestion` and `needsReview`. Edit · Details needs the suggestion to choose between "Not sure this is right" and "No match found" (`shared/metadata.ts#statusLine` reads `metadataStatus` and `metadataSuggestion`).
   - The list row's `suggestion` comes from `metadataSuggestion`, which now carries the full `candidate()` shape. The cover image can be derived from `releaseId`; no `coverUrl` is stored.
   - `songs.rename` (deleted by BK1) was the only other `cleanMetadata` caller in songs.ts. Its signature is unchanged; it now throws `fail('invalid', msg, {field})`.
2. **CPB (wave 1a):** `convex/metadata.test.ts` still contains the 1.9 case "update cancellation is scoped to the device and preserves completed jobs", which calls `worker.cancelForUpdate`. When CPB deletes that mutation (D12), this case must go in the same change. Please let CPB delete that one case from convex/metadata.test.ts, or schedule it as a ticket.
3. **FX1 / integrator (tests/fixture/db/seed.js, not mine):** `BLANK.metadataStatus` is `'done'` and `jam03` has `'none'`; neither is a schema value (`maps/meta-css-backend.md` §1.8). They should be null (the field absent). My handlers and `statusLine` treat unknown values as "no lookup ran", so nothing breaks meanwhile. The fixture README could also list `db.metadataLookups` (the fixture's pending retries).
4. **LB1b:** the "Is this right?" popover's "Yes, that's it" maps to `metadata.confirm({id})`. That accepts the song's current fields; it keeps the suggestion's ids only when the suggestion is for the same title and artist. If the popover means "use the suggested details", send `metadata.update({ids: [id], changes: <suggested title/artist/album…>, match: {recordingId, releaseId}})` instead.
5. **ED6:**
   - Use `validateField`/`LABELS`/`LIMITS`/`statusLine`/`cleanTags`/`sameValue` from shared/metadata.ts.
   - The upload flow is `api.metadata.uploadArtwork({id, file, signal})` returning a key, then `update({ids: [id], changes: {artwork: {kind: 'upload', key}}})`.
   - A replaced upload stays restorable for 1 h (Revert through `update`/`updateEach` with the old upload key).
   - `retry` rejects `matched` with `invalid` and does nothing while `pending`.
6. **Not mine:** `convex/artworkUpload.ts` (`complete`) and `convex/lib/catalogRequest.ts` still throw uncoded ConvexError strings ("Artwork upload did not match the selected image.", "MusicBrainz is temporarily unavailable…"). They are outside §6.1's metadata*.ts list; whoever owns them should change them to `fail('artwork_expired' or 'invalid', …)` and `fail('lookup_unavailable', …)`.

### pass 2

This adds to the earlier BK7 handoff (items 1–6 there still stand).

1. **BK1 (list row `reviewMetadata`, D43/§6.3), new ticket:**
   - The derived clause `source.type==='upload' && !artist && title===basename(filename)` keeps "Is this right?" showing after `metadata.confirm`, because confirm can only clear the stored `needsReview` and set `metadataStatus: 'matched'`.
   - Please gate that clause on `metadataStatus !== 'matched'`, or drop it: `needsReview` is the stored G6 signal, and a title edit already clears it.
   - Example: seed song `jam03` after "Yes, that's it" still shows the chip.
2. **Integrator, artworkUpload.ts and lib/catalogRequest.ts:** packages.json gives neither file an owner.
   - MusicBrainz failures now reach users coded, through BK7's `request()` wrapper.
   - The artwork verify failure is coded on the client in `src/api/metadata.js`.
   - The server files themselves still throw bare-string ConvexErrors. Please assign an owner to switch them to `fail()` (`artworkUpload.complete`: `fail('invalid', …, {field:'artwork'})`).
3. **ED6/LB1b, behaviour notes:**
   - `retry` now also recovers a song left `pending` by a lookup that died. The architecture's status copy (§6.9 line 2183) gives `pending` no action, so no UI change is implied, but "Find a match" calling `retry` will work on such a song.
   - A confirm or match made during a lookup is final: the late result is dropped.
   - A replaced upload stays restorable for 1 h after its latest replacement.
4. **Note for the next schema owner:** for `ready` artwork rows in `audioObjects`, `expiresAt` now also means "keep until this Revert window ends" (`metadata.ts#scheduleRetire`), which fits its existing meaning of "earliest erase time" in `storage.retireKey`.
5. **FX1 seed:** the earlier note that `BLANK.metadataRecordingId`/`metadataReleaseId` are `null` still applies; the BK7 fixture handlers now delete these ids rather than write `null`.

## CPA

### pass 1

Requests for files CPA does not own:

1. BLOCKER before the next processor release. scripts/build-processor.py has no owner in packages.json. It must bundle the shared args with `args += ['--add-data', f"{root/'companion/ytdlp-args.json'}{os.pathsep}."]`. pipeline.py now loads `ytdlp-args.json` from next to itself or from `sys._MEIPASS`, and fails loudly at import without it. Two further suggestions:
   - add `import pipeline` to desktop_entry.py's `--self-check`, so a release that is missing the file fails at build time (scripts/test-processor.py would also catch it);
   - add `companion/ytdlp-args.json` to the processor cache `hashFiles(...)` keys in .github/workflows/release.yml (lines 50 and 80), so editing the args rebuilds the processor.
2. Two codes beyond the §6.10 list, both already in `convex/lib/errors.ts`:
   - 409 `lookup_busy`: the answer to a lookup replaced by a newer one on the same route;
   - 502 `lookup_unavailable`: yt-dlp could not run (network down, module missing, unreadable output).
   Error bodies may also carry `detail` (the stderr tail) for Details. The Add sheet (LB2) should ignore `aborted` and `lookup_busy`, and fall back to the single-result line on any other failure. Note also that ytDlp drops upcoming streams from search results and gives 404 `unavailable` for an upcoming stream on /resolve.
3. For CPB (errors.py): lookup.mjs treats "Sign in to confirm your age" as `unavailable`, not a bot check (`BOT_CHECK = /not a bot|sign in to confirm(?! your age)/i`). pipeline.py's BOT_CHECK regex still counts the age gate as a bot check, so CPB's `classify` should match this. Also, `/status` still has the 1.9 fields; CPB owns item 4.
4. For PL1/desktop.js and LB (upload.js, add-sheet.js): the client errors are `CompanionError` objects with the ApiError shape `{code, message, status, data, raw}`; codes are processor_offline, timeout, aborted (name 'AbortError'), the companion's own codes, and unknown. Key behaviours:
   - `status()` and the lookups need no pairing; the paired-only helpers (`localRequest`, `requireCompanion`, `localUpload`) still require `initializeLocalDesktop`.
   - `initializeLocalDesktop()` waits for `onProcessorState` 'ready' when `info().companion` is null at launch, and re-reads `{port, token}` on every call, so `retryPairing` can simply call it again.
   - `uploadXHR` calls `onProgress({loaded, total})` on each progress event and once more at completion.
   - `initializeLocalDesktop` still pairs through the old `./auth.js` `convex` client, because the contract did not move it. Whoever retires src/js/auth.js must switch it to `src/api`.
5. The fixture files in companion/fixtures/ytdlp were built from yt-dlp 2026.10.26's extractor source (the YouTube `_extract_video` flat entries, the SoundCloud `_extract_info_dict` / `_extract_thumbnails`), not recorded live: this container's proxy blocks YouTube, SoundCloud and Spotify. A live recording on the owner's machine would make a good gate G6 check.

### pass 2

Requests for files CPA does not own:

1. scripts/build-processor.py (no owner): bundle the shared args with `args += ['--add-data', f"{root/'companion/ytdlp-args.json'}{os.pathsep}."]`. pipeline.py now falls back to a built-in copy and warns on stderr, so this is no longer a release blocker, but the shipped args should come from the file. Also:
   - add `import pipeline` to the desktop_entry.py `--self-check`;
   - add `companion/ytdlp-args.json` to the processor cache `hashFiles(...)` keys in .github/workflows/release.yml (lines 50 and 80), so editing the args rebuilds the processor.
2. LB2 (Add sheet):
   - A Spotify oEmbed connection problem (network, 5xx, 429) is now 502 `lookup_unavailable`, not 404 `not_found`.
   - Collection pages (channels, albums, user pages, `watch?list=` with no `v`) now answer 422 `playlist` quickly.
   - Lookups answer 499 `aborted` when the companion shuts down; that answer never reaches a client.
   - `request`, `resolveSource`, `searchSources` and `uploadXHR` now reject at once with `aborted` or `timeout` while the processor is still starting. `timeoutMs` covers the whole call, including that wait.
3. CPB, which owns server.mjs and pipeline.py from wave 1a:
   - keep `lookupRoutes.abortAll()` at the start of `shutdown()`;
   - keep `FALLBACK_YTDLP_ARGS` matching `ytdlp-args.json` `base` (lookup.test.mjs enforces this).
   - The earlier BOT_CHECK age-gate note for errors.py still applies.
4. The items from the previous handoff about client error codes, pairing and the fixtures being synthesized still stand. A live yt-dlp recording to replace companion/fixtures/ytdlp is a gate G6 item.

## ED1

### pass 1

Deviations and additions to §2.15, all inside my own file:
1. MapSession gains five extra members: `first()`, `last()` (Home/End, `map.first` / `map.last`), `canUndo` / `canRedo` (ReadonlySignals, false while auditioning, for the posture's Undo/Redo buttons and the `map.undo` `when`), and `review` (ReadonlySignal of the open suggestion review; `reviewSuggestion(null)` closes it).
2. `tapping`, `previewing`, `calibrating` and `auditioning` are read-only views; state changes only through the methods. `message` stays writable.
3. `pinDownbeat(event?)` and `pinBeat(event?)` are `tap('D'|'T', event)`. Stopped, they pin the nearest line at the playhead; playing, they are one tap of a pass; previewing, they pin the nearest line; calibrating, they record a calibration tap. Pass the KeyboardEvent or PointerEvent so its timeStamp and repeat flag are used.
4. `unpin()` never edits digits. The ⌫ and Enter commands (ED3) should call `digits.value ? backspaceDigit() : unpin()` and `digits.value ? commitDigits() : <apply field>`.
5. `goToBar(n)`, `renumberTo(n)` and every message use display bar numbers (§4.3: the pickup is "Pickup", the next measure is bar 1).
6. `applyBar`: pass `tempo` only when the user changed the field, and `ramp` only when `span.form.ramp.available`. Omitting `label` keeps the current one. `applyTo` defaults to 'until'; `keep` defaults to `span.form.keep`.
7. Size: 1,604 changed lines (890 source + 714 tests), slightly over the L ceiling of 1,500. Mostly tests and copy; no split needed.

For ED3, which supplies the hooks:
- `hooks.markers.tombstone(ids, deleted = true)`. With `false` it must un-delete; markersToSections' linked undo relies on that.
- `hooks.loop.get()` returns the user's practice loop in whatever shape you like, or null. `hooks.loop.set(value)` must re-apply that loop to the engine without an undo step or a save. Preview calls `set(get())` to restore.
- `hooks.status(text, {tone, action: {label: 'Undo', run}})` is called for results that offer Undo: the end of a tap pass, markers → sections, and kept suggestions. Every outcome also lands in `message`.
- `prefs` is `src/app/prefs.js#prefs`. Paths used: `edit.map.tapSnap` and `edit.map.tapOffset`; the snap toggle writes the pref directly.
- The session keeps a dismissed suggestion out of `songs.dismissSectionSuggestion`; the caller does that.
- Lane pin drags were not in ported range 104-499, so they are ED3's: use `map.beginBatch` / `map.edit(..., 'drag')` / `map.endBatch`.

For F4b (metronome.js): the session uses `metronome.enabled` and `metronome.setEnabled(bool)` for Preview's forced click and its restore. For calibration it uses `metronome.clickAt(when, accent)`, falling back to `_click(when, accent, false)`. Please keep `enabled`/`setEnabled` (or tell the integrator if `configure` replaces them, so it can open a ticket for ED1).

For ED4: during the audition, try candidates with `session.map.replace(next, 'tempo-source')` and re-choose "Your map" with `map.restore(snapshot)`. Commit with `mapSession.endAudition({commit: true})` for Use their map and `({commit: false})` for Keep my map / Esc. All other MapSession edits are refused while auditioning.

### pass 2

For the integrator:
- Size exception (finding 15). ED1 is now 1,792 changed lines (935 source + 857 tests), over the L ceiling of 1,500. The growth is review-driven regression tests and the fixes above. Please record a size exception in Appendix C item 18, as was done for F5 and FX1.
- Please amend §2.15 hooks to:
  - `suspendSaves(on, {changed}?)`
  - `markers: {list(), tombstone(ids, deleted = true)}`
  - `rename(barIndex)`
- New MapSession members: `tapAlong()` (async; true when it started playback for tapping) and the matching copy `MAP_SESSION_COPY.tapAlong` / `renameAction`. These are in addition to the earlier first/last/canUndo/canRedo/review.

For ED3 (it supplies the hooks):
- `hooks.suspendSaves(false, {changed: true})`: when changed is true, resume and save the current map immediately (Use their map). `endBatch` emits no map event, and the tries' own events arrived while saves were suspended. With `changed` false or missing, resume only. The Keep my map restore equals the last saved map.
- `hooks.markers.tombstone(ids, deleted)`:
  - It must patch practice data and save, but must NOT push a practice-undo entry. The map step's linked undo/redo owns the reversal (D23: one map step plus linked tombstones).
  - `deleted = false` must un-delete.
- `hooks.rename(barIndex)`: opens the inline rename on the strip. It is the [Rename] action of the "Section {n} added" status that addSectionAt sends through hooks.status (§4.5).
- Bind `map.tapAlong` (Inspector [Tap along] / [Start tapping]) to `session.tapAlong()`.
- Meter form: sending the pickup field back unchanged is now safe. applyBar treats `pickup` as a change only when it differs from the bar's current length. Still send `tempo` only when that field changed.
- Lane drags may keep using `map.beginBatch` / `map.edit(..., 'drag')` / `map.endBatch` directly. `canUndo` now counts any open changed batch, so it stays correct.
- Any map edit through the session while a tap pass is open now closes the pass first, as its own undo step.

Unchanged from the previous result: the F4b note about keeping `metronome.enabled` / `setEnabled` / `clickAt`, and the ED4 audition protocol.

## F4b

### pass 1

TICKET for I0B: the 6 ownFailures are in F4a-owned test files (no 0B package owns them), so I didn't edit them. They follow directly from §5.2/§8 deleting `countInPlan()` and moving `serialize()` to `{songMap}` (D51). Verified patch (83/83 pass with it):
(1) `tests/engine-schedule.test.js:448`: replace `metronome.countInPlan()` with `metronome.countInPlanAt(20)`.
(2) `tests/playback-engine.test.js`: delete the four cases from "count-in supports bars and beats, legacy defaults, and persisted audible pre-roll" (line 194) through "count-in follows tempo changes and extrapolates clicks beyond a detected grid" (ends at line 232). Their behaviour is ported, at explicit targets, to `tests/metronome-configure.test.js` ("countInPlanAt" describe, plus "a count the engine plays clicks through the aux bus…").
Assign it to F4b (with a grant for those two files) or let the integrator apply it.

Declared §9.0 deletions (both modules are deleted at I1):
- `tests/map-mode.test.js`: the `saved.detected[0]` assertion (the forward note asked for this).
- `tests/player-ui.test.js`: the saveTempo count-in-fields assertion and its unused `backend` import.

Notes for later packages:
- 1.9 player at runtime: `src/js/player.js:985` calls `metro.countInPlan()`, which now throws when count-in is on. Count-in and click settings are no longer saved in `tempo`. Per §8 only the old app's tests must stay green, and they do. I1 deletes player.js and map-mode.js; please also delete the metronome's deprecated setters (`setAccent`, `setVolume`, `setCountIn`, `setCountInLength`, `setCountInUnit`, `setAudiblePreRoll`), the `_click` alias, `load()` and the no-store constructor default. `setEnabled` is also used by F4a's engine-schedule tests, so update those if it goes.
- ST1b (transport): call `metronome.configure(practice.click fields)`. The metronome starts itself on the engine's `state` event; `start()` is optional.
- ST1b: `onBeat` events carry `{when, downbeat, unit, kind: 'count'|'rest'|'click', audible}`. A `plan` event invalidates beats at or after its `from`; a `transport` event invalidates all of them.
- ST1b: for `between === 'rest'`, set `gapSec = countInPlanAt(a).duration` + one bar at `a`. The metronome clicks the rest bar at the tempo of the bar at `a`, and the count-in at the tempo before `a`.
- Additive fields beyond the contract: `gapsBetween()` entries also carry `rate`, `elapsed` and `end`; the engine has a `loopGap` getter; `metronome.js` exports `CLICK_MODES` and has `settings()`.
- Wrap `pass` in a segmented run counts arrivals at `b` since the plan was last rebuilt, the same meaning as in the gapless case.
- Choices where the contract was silent: a loop edit during a gap whose target is still inside the new loop continues the gap toward the new `a` (a plan change, not a discontinuity). Pausing during a gap rests at `a`, and Play resumes with a pass from `a` without a gap.

Reported failures:
- tests/playback-engine.test.js > 'count-in supports bars and beats, legacy defaults, and persisted audible pre-roll' (calls the deleted metro.countInPlan() and expects click fields in serialize(), D51)
- tests/playback-engine.test.js > 'count-in clicks work with the metronome off and stop immediately on cancellation' (metro.countInPlan is not a function)
- tests/playback-engine.test.js > 'detected count-in at the end uses the final local tempo and meter' (metro.countInPlan is not a function)
- tests/playback-engine.test.js > 'count-in follows tempo changes and extrapolates clicks beyond a detected grid' (metro.countInPlan is not a function)
- tests/engine-schedule.test.js > native path > 'count-in clicks sound through the aux bus while the stems are held at 0; pause mutes the bus at once' (metronome.countInPlan is not a function)
- tests/engine-schedule.test.js > signalsmith path > same case (metronome.countInPlan is not a function)

### pass 2

TICKET for I0B (must land with the F4b merge, or assign it to F4b with a grant for these two files). I re-verified the patch against c29ec17: 83/83 pass.
(1) `tests/engine-schedule.test.js:448`: replace `metronome.countInPlan()` with `metronome.countInPlanAt(20)`.
(2) `tests/playback-engine.test.js`: delete lines 194–233 (the four cases from "count-in supports bars and beats, legacy defaults, and persisted audible pre-roll" through "count-in follows tempo changes and extrapolates clicks beyond a detected grid", plus the trailing blank line). Their behaviour is ported to `tests/metronome-configure.test.js`.

Behaviour changes in this pass, for ST1b and I1:
- The metronome now starts itself on 'plan' and 'transport' events too, not only on 'state'. Turning on "Between passes" mid-playback needs no `start()` call.
- Unmapped songs (`songMap.isReal === false`): the metronome never sounds the continuous click or gap clicks. Count-in beats are reported to `onBeat` with `audible: false`. A metronome built without a store (the 1.9 player's placeholder map) is exempt until I1 deletes that constructor default; I1 should delete `_placeholder` along with it.
- Engine, preroll gaps: a change of `gapSec` or loop during a preroll gap keeps the audio it is playing when it can. If the new gap is shorter than the preroll still needs, or the gap mode changes in the gap, it is a discontinuity (`revision++`, 'transport'). Silent gaps behave as before.
- Engine: in a segmented build only the first entry carries `scheduled: true`, so `cancelPending()` returns false once a jump or scheduled speed change has landed.
- Engine: wrap and gap events never fire after `stopAtWhen` (the wrap at the stop still fires), including on a late tick.

Earlier notes still hold: the 1.9 player's `metro.countInPlan()` call; I1 should delete the deprecated setters, the `_click` alias and `load()`; the ST1b `configure` / `onBeat` / rest-gap guidance.

Reported failures:
- tests/playback-engine.test.js > 4 count-in cases calling the deleted metro.countInPlan() (F4a-owned file; ticket in handoff)
- tests/engine-schedule.test.js > native and signalsmith > 'count-in clicks sound through the aux bus...' (metronome.countInPlan is not a function; F4a-owned file; ticket in handoff)

## PL1

### pass 1

Contract additions (additive; please record them in Appendix C):
1. desktop.js gains `desktop.start()`, `stop()`, `watchStatus()` (returns off) and `refreshStatus()`, plus the exports `processorStatus`, `processorLabel`, `modelFor`, `PROCESSOR_COPY` and `createDesktop`. A ProcessorStatus with phase pair-failed also carries `details`, the raw pairing error.
2. platform.js additions:
   - `detect()` also accepts `{css, document, fx}`. `isIOS` is true for every Apple touch device, iPad included; `isIPad` is the iPad subset.
   - New exports: `createPlatform`, `fixtureSwitches`, `globalsOf`, `createInstall`, `silentWav`, `mediaMetadataFor` and `wakeSetting`.
   - `createWakeLock({navigator, document, desktop, wake, settings, now, timer})` also has `destroy()`.
   - `platform.detect()` re-detects.
3. `describeError` options also take `{song, device, storage, router, jobs, desktop}`. The result adds `code`, `detailsFirst` (rows whose spec action is Details: disk full, processor offline) and a `target` on each action.
   - Two §3.6 labels missing from the §2.10 action table were mapped: "Choose another file" → `/add?pick=1`, "Manage storage" → `/settings/plan`.
   - Job actions appear only when a job id is known. "Restart processor" appears only in the desktop app.
4. `fetchRelease({fetch, sources, timeoutMs, signal})` returns `{version, downloads}` or rejects with `ReleaseUnavailableError {causes}`. The codec sentence lives in `SENTENCES.codec` (error-copy.copy.js) and `stemcache.codecErrorMessage`.

Requests for other packages:
- **S1:** call `desktop.start()` after auth (boot step 4 or 6) and pass `ctx.desktop = desktop` and `ctx.platform = platform`. Call `keys.setPlatform(platform)`. Read the codec banner sentence from `SENTENCES.codec`.
- **CPA:** desktop.js calls `initializeLocalDesktop()` and `status()` from src/js/companion.js. It loads them on demand; `status()` is in CPA's contract but not on the base branch yet.
- **LB2b:** "Search for another version" navigates to `/add?q=…` with history state `{dismissJobId}`. Once the new job is submitted, the Add sheet must call `api.jobs.dismiss({jobId: state.dismissJobId})`.
- **LB2a/LB2b/SE2:** the Jobs popover and Settings → Processing should call `desktop.watchStatus()` while visible, call `refreshStatus()` after a submit, and use `processorLabel()`.
- **ST1c/ST4:** wire `createWakeLock().update({stageOpen, playing, stoppedAt})`, `watchInterruptions`, `startMediaSession` and `startGestureAudio` per session. Show ☼ from `held`.
- **DL1 (wave 1a):** use `fetchRelease`. The old `renderDownload` in src/js/desktop.js still has its own loop and is not owned by PL1.
- **F2 (optional):** prefs.js could call `desktop.setTheme` instead of the bridge directly.

Size exception: about 2,400 inserted lines (about 1,160 source, the rest tests), above the §9.0 L ceiling. The bulk is table tests: one per code × context × kind for error copy, plus every processor phase.

No test cases of other packages were deleted.

### pass 2

- **Size (needs your decision):** PL1's diff from 39dcc28 is 2,550 insertions across 16 files, above the 1,500-line L ceiling in §9.0, and the package was sized M in §9. §9.0 has no exception process, so please record an explicit decision. The alternative is a follow-up that rewrites the error-copy and platform table tests to be generated from data.
- **Contract notes for Appendix C:**
  - `describeError(...).detailsFirst` is true only for disk_full; processor_offline is false.
  - `SENTENCES.offline` is the spec banner sentence.
  - `createWakeLock().update({stoppedAt})` ignores null and other non-number values.
- All the earlier cross-package requests still stand: S1, CPA, LB2b, LB2a/LB2b/SE2, ST1c/ST4, DL1 and F2.

## ST0

### pass 1

Deviations from the contract (none remove anything):
1. `createPracticeState` takes three extra options: `status(text)` (the session passes `feedback.status`, which arrives in wave 1a with S2), and `legacyTempo` / `defaults`. With the last two it runs `upgradePractice` itself, so the session may pass the raw stored value (D51, D14).
2. In the practice state, a `patch` without a `dirty` list works out the changed top-level keys itself, and a given `dirty` list is added to that. Dirty keys stay dirty until the server echoes them. Server updates are taken live for keys this device has not changed. A spot or marker missing from a patched list becomes a tombstone, and one brought back is revived. ST1c/ST8b should push undo entries like `{key: 'spots', from, to, apply: v => practice.patch({spots: v})}`, where `from`/`to` are `practice.value.peek().spots`, tombstones included.
3. `reanchor(map, {auditioning})` takes an explicit flag (SongMapStore has no `auditioning` field). It also skips when `map.auditioning` is set. The session should pass `{auditioning: mapEditor.value?.auditioning}`.
4. With `local: {token}`, the practice state saves to `deviceStore('share')` (it never calls `persist`) and reads that device copy back on open in place of `raw`.
5. `undo.push` returns null for a no-op, and also when a merge lands back where it started. Pushes made while an undo or redo is running are ignored. `stage.js` (ST4) should show `undidMessage(entry)` / `redidMessage(entry)`.
6. glass.js adds the gesture 'longDrag' for the long-press-then-drag row. An empty or unknown `pointerType` is treated as touch.
7. position.js extras: `revision`, `loopLabel(a, b)` (for TransportState.loop.label), `refresh()`, `dispose()`, `formatTenths`. Unmapped `snap(t, 'bar')` rounds to 0.1 s and `snap(t, 'beat')` keeps the exact time (spec §4.8/§4.9). Mapped `rangeLabel` falls back to seconds ('Bar 18 (1.0 s)') when the loop edges are not on bar lines. The unmapped Next countdown rounds up.
8. frame.js extras: `readFrame(session)`, `destroy()`, and an injectable `visibility` target (default `document`).
9. Size: 2,121 changed lines (992 in modules) is over the §9.0 L ceiling. Please record the exception as was done for F5/FX1.

Requests for other owners (tickets):
- F5 (`src/js/song-map.js`): `setHasPart` emits no event, so `position.mapped` only updates on the next map event or `position.refresh()`. Either have `setHasPart` emit (a reason such as 'part') or have ST1b's notation-session call `session.position.refresh()` after `map.setHasPart(...)`.
- ST1c (session): pass `status: feedback.status`, `legacyTempo: song.tempo`, `defaults: account.practice` and `local: shared ? {token} : null` to `createPracticeState`. Call `position.dispose()`, `frame.destroy()` and `practice.dispose()` in `disposeSession`.

### pass 2

Changes to the earlier handoff:
- Drop deviation 7's unmapped loopDefault shift. loopDefault now matches rule 13 exactly.
- `undo.push` takes `coalesce?: boolean`. By default it is true only for `speed` and `level:<stem>` (exported as `coalescesByDefault`). ST1c should pass `coalesce` through from `setSpeed(rate, {coalesce})` and `setVolume(name, v, {coalesce})`. Please add the `coalesce` field to the §2.14.6 push signature.
- In share mode (`local: {token}`), createPracticeState ignores `server` entirely: no subscription and no merge. ST1c may pass the snapshot as `raw` and need not pass `server` for shared songs. Please note this in §2.14.5.
- In-flight keys are cleared as described in the module header: an echo, a value that differs from the pre-save base, the write resolving, or the next server value after it. The session's `saveId` echo handling (ST1b) can sit on top of this unchanged.
- frame.js throttling now uses a half-frame tolerance and treats a clock that stepped backwards as due. The interface is unchanged.

The earlier ticket requests for F5 (`setHasPart` emitting an event) and ST1c (the createPracticeState options and the dispose calls) still stand. Size: this pass adds about 280 lines, mostly tests, on top of the L-ceiling exception already requested.

## ST2

### pass 1

Requests and deviations for the integrator:
1. **Size exception.** About 3,400 changed lines against the L ceiling of 1,500. Roughly 1,250 are source and CSS; the rest is regression tests (about 1,300) and the harness and states (about 380). This follows the precedent recorded for F5 and FX1 in Appendix C item 18.
2. **press.js default haptic.** It uses a local `defaultHaptic`, which calls `navigator.vibrate(8)` and is the same as `platform.haptic` in §2.11. It does not import `src/app/platform.js`, because that file is PL1's and does not exist in this wave. Surfaces can pass `haptic: platform.haptic` explicitly. If wanted, switch the default to the import at I0B.
3. **Contract additions (please record in Appendix C):**
   - `loop-handles` also accepts `hitWidth`, `moveTol` and `toT(clientX, clientY)`. `toX(t, side)` may return a number (same x in every row, Stems) or `{row, x}` (wrapped rows, Road map). A row < 0 or ≥ rows().length means off-view; null hides the edge.
   - `loop-handles` adds `update()`, a `range` getter and a `dragging` getter. `onEdit` also fires `phase: 'cancel'` with the original range on pointercancel; ST10 and ST11 should drop their preview on it.
   - `press.js` adds `touchAction` (default 'pan-y'; Stems should pass 'none'), `e.keyboard` and `e.cancelled`, and calls `onLongEnd(e, {dragged: false})` just before `onMenu`. `onTap` fires immediately, and a double fires `onDouble` instead of a second `onTap`.
   - Cooperation attributes: `[data-press-ignore]` and `[data-press-nodrag]`.
   - `pinch.js`'s API was unspecified; the shape is in the summary. For ST9: `base` = current scale, `min` 0.8, `max` 2, then `chart.previewScale(g.factor)` in onPreview and `setScale(g.value)` plus `setBase` in onCommit.
   - `wave-render` adds `resolveColor`, `invalidateTokens`, `clearHatchCache`, `GRID_ALPHA`, `SECONDARY_ALPHA` and `STEM_KEYS`. Draw functions take an optional `dpr`; `drawGrid` takes `y` and returns which kinds it drew.
   - `computePeaksRange` takes the optional `{samplesPerBin}` 5th argument.
4. **grid.js meaning of ½ and ¼.** The contract did not define them. ½ splits a one-unit beat in two and a grouped beat into its units; ¼ halves those again. Unmapped songs return no ticks and snap to 0.1 s. Please record this.
5. **Pure-helper list.** Nothing to change: grid.js is already on `PURE_HELPERS`.

### pass 2

The previous handoff still applies (size exception, the press.js default haptic, the contract additions, the meaning of ½ and ¼ in grid.js). Please also record these contract additions in Appendix C:
1. **loop-handles snapping.** The surface's `snap(t, {alt, shift, mode})` may be passed `mode: 'ceil'|'floor'` when the dragged edge would snap onto the fixed edge. Surfaces should forward it to `grid.snapTime` or `SongMapStore.snapTime`; if a surface ignores it, the last valid range is kept. An edge drag snaps only the dragged edge; a move snaps both edges.
2. **loop-handles echoes.** `set()` during a drag is ignored except `set(null)`, which ends the drag. A cancel always restores the range from before the drag.
3. **press.js long press while playing.** `onLongStart` may return false to keep the long press scrollable. Then movement ends it with `onLongEnd(e, {dragged: false, cancelled: true})`, and a release without moving still opens the menu. Surfaces (ST10/ST11) should return false when `glass.pressPolicy({pointerType, playing, gesture: 'long'})` gives 'scroll' for a long drag, which means touch or pen while playing.
4. **press.js pen and Ctrl-click.** Pen barrel-button menus arrive at `onMenu` with pointerType 'pen'. A macOS Ctrl-click produces only `onMenu`, never a tap.
5. **wave-render listeners.** wave-render now adds its window theme and place listeners when the module is imported (capture phase, guarded by `typeof window`).

## ST3

### pass 1

1. **Size exception.** The diff is 2,449 insertions and 504 deletions across 10 files. That is over the L ceiling (§9.0 says no package is larger than L). Roughly 1,600 of those lines are tests, states and the harness.

2. **Copy table location.** §9.0 asks for copy in `<module>.copy.js`, but `src/js/notation/chart.copy.js` is not an ST3-owned path. So COPY and EMPTY_ACTIONS are exported from chart.js, and the table-driven role/name test is in tests/notation-chart.test.js. Integrator: either add `src/js/notation/chart.copy.js` to ST3's owns in a follow-up, or accept this as is.

3. **Contract details for the chart-surface package (and ED5):**
   - **onBarActivate event:** `{kind, index, barId, q, time, beatTime, pointerType: 'mouse'|'touch'|'pen', glass, clientX, clientY}`. The chart never seeks. Keyboard context (Shift+F10, the ContextMenu key) and pinch belong to the surface.
   - **onLoopEdit:**
     - It carries aBar/bBar only when both ends sit on bar lines; Alt (beat) edits omit them. There is no cancel phase.
     - After a commit, the chart draws the committed range until setLoopRange answers, and reverts after 1 s if it does not. The surface should answer every commit.
   - **fonts option:** these are on-screen floors in px, i.e. `{barNumber: 14 × d, marker: 20 × d}`. The chart converts them to engraving sizes per scale.
   - **Scale:** the chart does not read or write `prefs.chart.pinchScale`. The surface owns the scale (Distance default or pinch) and passes it in.
   - **Display layout:**
     - The chart reads `prefs chart.display.layout` only when `display.layout` is omitted.
     - setDisplay writes it, storing null when it equals the part's own layout.
   - **Additions beyond the contract:**
     - `previewScale(f, {clientX, clientY})` takes a pinch origin.
     - A read-only `chart.state` getter.
     - Exports SCALE_STEPS, stepScale, clampScale, fontFloors, FONT_FLOORS and the gesture constants.
     - `data-rendered="empty"` for the empty state.
   - **destroy()** empties the host and does not remove it.
   - **Haptics:** vibrate(8) per D50, not the 10 in the notation map.
   - **score-view additions:** configure, relayout, setFonts, setLoopHandles, `setLoop(range, {dragging})`, renderedBars and `view.handles`. The default fonts stay at the 1.9 sizes (11/15), so ED5 must pass fonts if the editor should follow the floors.

4. **Old app until I1.** player.js → launcher.js still calls createChart with the 1.9 options (setLoop, clearLoop, onMixerChange). In the 1.9 app the chart now shows no toolbar and taps no longer seek or loop. Deleting chart.css also removed the `.player.chart-active` hide rules. No test depends on any of this. launcher.js, notation-demo.html and notation-demo.js go at I1.

5. **For the I0B harness run:** use `npm run fixture:capture -- --states ST3`.

### pass 2

1. **§9.0 deviations (integrator decision, unchanged from the first handoff):**
   - Grant `src/js/notation/chart.copy.js` to ST3 and move COPY and EMPTY_ACTIONS there, or accept them living in chart.js.
   - Record the size exception. The package is over the L ceiling, mostly because of tests, states and the harness; this pass adds about 270 lines.
2. **Contract details for ST9 (chart surface) and ED5:**
   - **onRelayout({ms, bars})** now fires only for relayouts that setScale, setDisplay or setFonts ask for. The first engraving and part-edit re-engravings are not reported, so D54's "last two relayouts" sample is layout cost only.
   - **Multi-touch:** once a second touch or pen pointer is down on the score, the chart emits nothing (no tap, long or loop edit) until all are up. Pinch belongs entirely to the surface, which drives previewScale and setScale.
   - **Loop handles:** a handle drag begins past 8 px. A still press on a handle emits tap, double or long for the bar under it, like any other press on the music.
   - **Follow on touch:** touch pauses Follow only once the finger has moved more than 8 px from its touchstart and no press gesture is active.
   - **reveal():** a reveal asked for during a relayout beats the relayout's anchor. A pending reveal or scroll retry is dropped by a manual scroll or by setFollow.
3. **Chart tokens:** score-view now maps staff lines and bar separators to --ink-3 and bar numbers to --ink-2, per spec §8.3. The G4 owner review should use the recaptured PNGs in /home/user/woodshed-wt/ST3/tests/fixture/out/ (st3-chart*.png).

## U1

### pass 1

Requests and notes for the integrator:

1. **F1 ticket: add Lucide `minus` to the icon list.**
   - Add it to `ICONS` in `scripts/build-icons.mjs` and rebuild `icons.svg`.
   - Until then the Stepper uses `chevron-down`/`chevron-up` for − and +.
   - It switches to `minus`/`plus` automatically once the icon exists (it checks with `hasIcon('minus')`).

2. **U3 peers are found automatically.**
   - `src/ui/button.js` loads `./tooltip.js`, `./kbd.js` and `./progress.js` through eager `import.meta.glob`. That way U1 builds and its harness runs without U3.
   - When U3 merges, they are used with these shapes:
     - `tooltip(el, {text, kbd})` → `off`
     - `Kbd({keys})` → `{el, set({keys}), destroy}`
     - `ProgressRing({value, size, label})` → `{el, set({value}), destroy}`
   - Without them, IconButton falls back to a native `title`, key-caps to a plain `<kbd class="ui-keycap">`, and HoldButton to its own SVG ring.
   - Tests that depend on which path runs are guarded with `peers.*`, so they pass either way.
   - I0B should re-run U1's states after the merge, because the tooltip, key-cap and ring then come from U3.

3. **S1 should call `installIcons()` from `src/ui/icon.js` at boot** (D32). It reuses a sprite the harness host has already inlined.

4. **Choices where the contract was silent:**
   - Disabled buttons use `aria-disabled` and stay focusable, so the reason can be reached; the `disabled` attribute is not used.
   - `disabledReason` is shown inside the button as `aria-hidden` text linked with `aria-describedby`, so it stays out of the button's name.
   - `busy` does not block clicks, because Play arms "Play when ready" while loading. Pass `disabled` as well where a second press must not run.
   - StemPad waits 300 ms (`DOUBLE_TAP_MS`) after a pointer tap before muting, so a double tap (level 100%) never flips the mute. Keyboard activation acts at once.
   - Additive props:
     - Button: `tone`, `registry`, `iconOnly` (used by IconButton)
     - HoldButton: `iconOnly`
     - Chip: `badge`, `removeLabel`, `disabled`
     - Slider: `pointer: false`
     - Fader: `host` (pad mode) and `reset()`
     - StemPad: `max`; `onLevel(v, {final})` reports live while dragging and `final: true` on release
     - Stepper: `onChange` source is `'pointer' | 'repeat' | 'key'`
     - Toggle: `onChange(pressed, event)`
   - Slider and Fader consume only arrows and Home/End (§2.12). Spec §7.1 also lists PageUp/PageDown; only the Stepper consumes those.
   - Dock labels (13 px) and the pad name (17 px) use rem values, because there are no 13 or 17 tokens.

5. **Shared code for U2 and U3.** `button.js` exports the common code: `applyCommon`, `setAttr`, `setText`, `uid`, `requireLabel`, `trackPress`, `keyCap`, `attachTooltip`, `peers`, `slot`, `isDev`. U2 and U3 can reuse it if useful.

6. **I0B registry CI.** The `Button({command})` static scan finds no literal `command:` ids in `src/ui`. The harness uses its own isolated registry under `tests/`.

7. **Size exception.** The package is 4,691 changed lines (27 files), above the L ceiling of 1,500. Most of it is tests (97 unit tests), the harness and the states file. Please record it, as was done for F5 and FX1.

### pass 2

1. **I0B ticket: switch U1's peers to static imports (finding #10).**
   - Once U3 is merged, replace the `import.meta.glob` in src/ui/button.js with static imports of `./tooltip.js`, `./kbd.js` and `./progress.js`.
   - Delete the stand-ins: the native-title tooltip in `attachTooltip`, the plain `<kbd class="ui-keycap">` in `keyCap`, and `plainRing` in hold-button.js along with its `.ui-hold-ring-*` CSS.
   - Delete `setPeers`, and change the 'display peers (U3 contract)' tests in tests/ui-actions.test.js to `vi.mock` those three modules.
   - Why it wasn't done in U1: §9.0 says the view resolver (D2) and the harness make a missing peer harmless, but D2 only covers views and the harness host (tests/fixture/vite.config.mjs) has no missing-module resolver. A static import on this branch alone would break `vite build`, the harness and the U1 states. Optionally, FX1 or the architecture should either add a missing-contract-module stub resolver to the fixture plugin or reword §9.0.
2. **Corrected size figures for the record (finding #11).**
   - U1 has 103 tests now; the first report's 97 should have been 92.
   - Against 39dcc28 the package adds 2,860 lines outside tests/ and 2,129 under tests/.
   - Product code alone is about 1.9 times the L ceiling of 1,500. Please decide on the size exception with these numbers rather than the earlier claim that most of the package is tests.
3. **Rejected part of finding #9.** The StemPad name does not use `--fs-stage-sub`, because that token scales with Distance and spec §640 and architecture §2352 say controls never scale. It stays at a fixed 17 px, which is above the 15 px Stage minimum.
4. **Behaviour changes for callers.**
   - TextField's and Textarea's `set({value})` now keep text the user has typed but not committed. Only the committed baseline moves, so a later blur or Enter commits the typed text.
   - Slider's and Fader's `onChange` never fires for a cancelled pointer gesture; `onInput` reports the restored value.
   - `Select.value` is `undefined` when nothing is selected.
5. **Earlier U1 handoff items still stand:** the F1 `minus` icon ticket, S1 calling `installIcons()` at boot, and the contract-silent choices listed in the first report.

## U2

### pass 1

1. **Size exception**: the package is 4,075 inserted lines across 23 files, well over the L ceiling in §9.0. The bulk is tests (about 1,050 lines), harness and states (about 520) and token CSS (about 700). The rest is the nine modules, with menu.js the largest at about 480 lines.

2. **Choices where the contract was silent** (please record in Appendix C at I0B):
   - (a) `close(reason)` calls `onClose(reason)` with `'escape' | 'outside' | 'close' | 'select' | 'tab' | 'swipe' | 'dialog'`; `destroy()` closes silently. Dialog's `closed` promise resolves to the value, or null on `destroy()`.
   - (b) Sheet detents are maximum heights in % of the viewport; the sheet sizes to its content up to the current detent.
   - (c) CoachMark does not join the dispatcher overlay stack (non-blocking), so Esc still reaches the Stage. Its Skip button is the keyboard equivalent.
   - (d) Menu takes extra options `presentation: 'auto'|'popover'|'sheet'` and `registry`. MenuItem accepts `args`, which are passed to `registry.run`; `item.run` gets `{item, event, source}`. Menu sources are `'key'` and `'pointer'`; bindContextMenu's `onOpen` reports `'pointer' | 'longpress' | 'key'`.
   - (e) Overlays opened while a modal `<dialog>` is open are placed inside it, so they are not inert. Modal sheets and dialogs also keep Tab inside.
   - (f) Toast has a 'warn' tone besides info, ok and error.
   - (g) `.ui-toast-region` (toast.css) is the bottom-centre region for feedback.js: fixed, at `--z-toast`, offset by `--toast-offset`. feedback.js can call `showLayer(region, 'toast')` from popover.js so toasts appear above an open dialog.

3. **Shared helpers**: the U2 helpers (`withDefaults`, `applyCommon`, `glyph`, `setContent`, layers, focus) live in `src/ui/popover.js` because U2 owns no common module. If U1 or U3 grew their own versions, I0B may want one `src/ui/common.js`; that would be an amendment plus a ticket.

4. **Ticket request for FX1** (`tests/fixture/lib/structure.cjs`): the overlap check flags an open top-layer overlay (menu, popover, sheet) that partly covers page targets, even though covering them is by design. My states work around it with `opts.structure.ignore` for the content behind (`#ov-content`, `[data-corner]`). A rule that skips pairs where one target is inside an open overlay and the other is not would let later Stage and Library states keep full checks.

5. **Flaky CDP tap**: in the band-sheet state, a CDP touch tap fired right after the swipe drag sometimes produced pointer and touch events but no click. The state now reopens the sheet with a mouse click; the swipe itself is reliable.

6. **Note for S2** (feedback.js): `Dialog({form: {fields, onSubmit}})` implements the FieldSpec of §2.9. An error thrown with `{field}` is shown at that field (useful for BK7's field errors).

### pass 2

1. **For S2 (feedback.js), replacing the earlier handoff item 2(g):** mount the toast region with `followLayerHost(region, 'toast')` from src/ui/popover.js and keep the `off` it returns. Do not use `showLayer`: that draws the region over a modal dialog, but its buttons stay inert. `followLayerHost` puts the region inside the topmost open modal `<dialog>` and moves it back to the body before that dialog closes.

2. **For Appendix C at I0B, new popover.js exports:**
   - `closeLayersInside(host, reason)`: modal hosts close the overlays opened inside them. Dialog uses reason 'dialog'; a modal Sheet uses 'close'.
   - `followLayerHost(el, kind)`: as in item 1.
   - Fallback layers (no Popover API) stack in the order they open. CSS anchor mode adds `data-fit=shrink` when an overlay fits on neither side.
   - `bindContextMenu`'s `off()` closes the menu it opened.
   - `CoachMark.set({playing})` is supported.
   - Sheet bodies no longer carry `[data-scroller]` (D26).

3. **Ticket for I0B (review finding 11, deferred):** replace U2's `glyph()` (src/ui/popover.js) with `icon()` from U1's src/ui/icon.js once both packages are merged. Callers: menu.js, sheet.js, toast.js, status.js and banner.js. This can go with the shared-helpers / `src/ui/common.js` request in earlier handoff item 3. I could not do it here because icon.js does not exist on this branch, and the harness and fixture would break.

4. **Size exception (review finding 12):** U2 is well over the §9.0 L ceiling. It was 4,075 inserted lines before this pass, plus about 420 now, most of it tests and states. Please record it in Appendix C the way item 18 did for F5 and FX1. No split is planned.

5. **FX1 ticket (from earlier handoff item 4) still stands:** the structure overlap check should skip pairs where one target is inside an open overlay and the other is not.

6. **Housekeeping:** a Vite server I did not start is still running from this worktree on port 5288 (PID 22885, parent 1), probably left by a reviewer. I left it alone; my own servers were killed by PID.

## U3

### pass 1

Interface extensions beyond §2.12. All are optional props or extra exports, so the existing contract is unchanged:
- **Kbd:** `hint: true` is for Edit's key-cap hints (spec §5.0). A hint cap renders only inside an ancestor with `[data-kbd-hints]`. ED2 (the Edit frame) should set `data-kbd-hints` on the Edit root after keyboard use, only on `(hover: hover) and (pointer: fine)`. ED5's toolbar caps (5·4·3·2·1) should use `Kbd({keys, hint: true})`. Kbd also takes a `platform` override, and `keys` may be an array (alternatives).
- **tooltip:** `text` and `kbd` may be functions read at show time, and `off.set({text, kbd})` updates content in place, so U1's Button/IconButton can follow registry `title`/`keys[0]` changes without re-registering. `off.show()`/`off.hide()` also exist.
- **Tabs:** `activation: 'manual' | 'auto'` (default manual; I chose it so a heavy posture never loads per arrow press). Tabs also take `label` (aria-label) and per-tab `controls` and `disabled`, and expose `tabId(id)` and `focus()`. Arrow keys are horizontal only, so ArrowUp/ArrowDown still reach the registry.
- **StageStepper:** a `failed` prop (✕ on the current stage) and a `label` prop (the list's aria-label, default 'Progress'), plus the pure export `stageStates`.
- **ProgressRing:** `size` also accepts 'sm' | 'md' | 'lg' | 'fill' or a pixel number. HoldButton and the Play loading ring can pass 'fill' to match their host.
- **Readout:** a `subMinCh` prop.
- **BeatLamps:** `groupStart` in `frame(unitIndex, groupStart)` was not defined by the contract, so I defined it. It is optional: `true` re-triggers the onset flash (count-in), or it can be the unit index where the current counted beat starts. When omitted, both are derived from `groups`. Extra exports: `mode`, `dots`, `lampLayout`, `groupOfUnit`, `MAX_UNIT_DOTS`. Without `size` the dot size comes from the `--lamp` token; `size: 'sm'` (×0.7, for the mini rail) is an addition.
- **Decorative by default:** ProgressRail and ProgressRing without a `label`, and Skeleton without a `label`, are `aria-hidden`.

Requests for the integrator:
1. **Shared helper:** every U3 module carries an identical ~18-line `applyCommon` helper for the common props, because no shared `src/ui` helper file is owned by U3. Consider a follow-up ticket adding `src/ui/common.js` (U1 likely needs the same) and switching the primitives to it.
2. **Size exception:** U3 is about 3,040 changed lines against an M estimate. 1,225 of those are tests (807 unit, 239 states, 179 harness), and the rest is eight primitives with full header docs plus the duplicated helper. Please record this the way Appendix C item 18 did for F5 and FX1.
3. **HUD Position readout:** in the stage harness, Position "13 · 2" set entirely in Atkinson Hyperlegible Mono spreads the " · " to full cell widths. That is within spec (Position uses the mono font), but ST5 may want the separator in `--font-ui`.

### pass 2

Contract and behaviour notes from this pass:
- **tooltip on the overlay stack:** a visible tooltip is a non-modal overlay with the dispatcher (src/app/dispatch.js pushOverlay), so Escape closes the tooltip first and a sheet or dialog behind it on the next press (the APG pattern). Code that reads `openOverlays()` will see the tooltip entry while one is up. tooltip.js now imports src/app/dispatch.js.
- **Hoverable tooltips:** tooltips now take the pointer, with a 120 ms leave grace (export `TOOLTIP_LEAVE_GRACE_MS`). Enter or Space on the anchor hides the tooltip.
- **BeatLamps:** new pure export `chunkGroups(groups, units)`. In groups mode with more than 12 counted beats, `lampLayout().groups` and `starts` are the display chunks, not the counted beats. Consider recording this as a D15 amendment: "a bar over 12 units whose groups still number over 12 shows chunks of 4 units (3 when divisible by 3 but not 4)". A one-unit bar (1/4) needs `frame(u, true)` on each onset. ST5 (HUD) should pass `groupStart = true` when barBeatAt reports a new counted beat in such bars.

Requests for the integrator:
1. **keys.js owner (F-package):** add a change signal, such as `onLabelsChange(fn) → off` or an event, fired after setPlatform, setLayoutMap and a resolved loadLayoutMap. Kbd would then re-render live; today it relabels only on its next `set()`.
2. **U1 / I1 ticket:** once U1's Button lands, map EmptyState plain `{label, onClick, href, variant}` actions to `Button(...)`, and delete `.ui-empty-action` from src/styles/primitives/empty.css and the actionNode branch in src/ui/empty.js (marked TEMPORARY in the code).
3. **Size exception and shared helper:** record the U3 size exception in Appendix C, like item 18. Open a ticket for a shared src/ui/common.js (`applyCommon`), then switch the eight U3 modules (and U1) to it.
