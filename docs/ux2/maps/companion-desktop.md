# Companion, processor and Electron map (Woodshed 1.9.0 → 2.0 "Stage")

Research document for the 2.0 rebuild (`docs/ux2/spec.md`). It maps the desktop processor (the `companion/` Node service and its Python pipeline), the Electron shell (`desktop/`), and the Convex job, worker and device functions. It then specifies the backend and desktop work the spec needs: B4, B5, B6, the registry-generated app menu (§6.5), background shortcuts, the native "ready" notification and window memory.

Every claim carries a `file:line` reference against commit `820f4db` (v1.9.0). No source files were changed.

**Owner decisions applied.** All "Decisions for the owner" recommendations are accepted. **Nothing is built for backwards compatibility**: no Classic keys, no key-change hint, no What's-changed sheet, no "new" badges, no rollout flags, and no lingering legacy layer. Stored data is still **read** correctly through a cheap one-way upgrade, with no UI ceremony. On this side that means:
- legacy `library.json` imports keep working (`companion/server.mjs:163-176`);
- old `songs.tempo` shapes are upgraded on load (see `maps/mapedit.md` §11);
- jobs and devices rows already stored stay readable, because every new field is optional.

The client-side job display, the Add modal and the bridge call sites are mapped in `maps/shell.md` §11–§14. This document does not repeat them. It goes deeper on the processor, main-process and server side.

---

## 1. Topology

```
Renderer (Vite app, served by Electron at http://127.0.0.1:47832)
  │  window.woodshedDesktop (preload, contextIsolation)        ── IPC ──►  Electron main (desktop/main.cjs)
  │  fetch http://127.0.0.1:<port> + Bearer token (companion.js)                │ utilityProcess.fork (main.cjs:54)
  ▼                                                                             ▼
Companion HTTP service (companion/server.mjs, bundled to build/companion/server.mjs)
  │  ConvexClient(device token) → worker.* / devices.identity / blobs.* / media.signKeys
  │  spawn per job (server.mjs:81): WOODSHED_PROCESSOR <root>  |  python process.py <root>
  ▼
Processor (companion/process.py, frozen as woodshed-processor via desktop_entry.py)
  ├─ yt-dlp (module_command('yt_dlp'), pipeline.py:278)
  ├─ ffmpeg / ffprobe (resources/bin on PATH, main.cjs:54)
  ├─ separator.py → demucs.separate (subprocess, pipeline.py:362-431)
  ├─ fpcalc (fingerprint.py:9-28)
  └─ BeatNet (beats.py:3-21)
Convex (jobs.ts browser API · worker.ts device API · devices.ts pairing · blobs.ts/storage.ts R2 sync)
```

| Thing | Where | Ref |
|---|---|---|
| Companion data root | `WOODSHED_DATA_DIR`, which Electron sets to `userData/library`; standalone it is `~/.woodshed-companion` | server.mjs:14; main.cjs:54 |
| Pairing token + Convex URL | `<data>/connection.json` (mode 0600). Token = 32 random bytes as hex. `--reset-pairing` regenerates it. | server.mjs:18-24, 50-52 |
| Per-account dir | `<data>/accounts/<sha256(convexUrl:userId)[0:24]>/` | server.mjs:30 |
| Local uploads | `<account>/uploads/<uuid>`, kept forever | server.mjs:190-195 |
| Job work dirs | `<account>/jobs/<jobId>/`: `job.json`, `source.wav`, `source-meta.json`, `separated/…/*.wav`, `separation.complete`, `*.webm`, `cover.jpg`, `result.json`, `synced.json`, `separation-runtime.json`. **Never cleaned.** | server.mjs:104,123,146; process.py:10-78; pipeline.py:432 |
| Legacy import index | `<account>/imports.json` | server.mjs:216-218 |
| Update-cancel marker | `<account>/update-cancellation.json` | server.mjs:53-58, 240-245 |
| Models | `TORCH_HOME = userData/models` | main.cjs:54 |
| NVIDIA runtime cache | `WOODSHED_GPU_CACHE = userData/accelerators`; manifest at `resources/gpu-runtime.json` | main.cjs:54; gpu_runtime.py:157-188 |
| Appearance | `userData/appearance.json` | main.cjs:18-19, 84-90 |
| Ports | UI 47832 (smoke 47833) fixed; companion `WOODSHED_COMPANION_PORT=0`, so the OS picks the port and reports it over `parentPort` | main.cjs:10, 54; server.mjs:15, 230-232 |

**Standalone vs desktop.** `npm run companion` (package.json:16) runs `server.mjs` directly with the venv Python (server.mjs:27) on port 47831. The Electron path forks it as a utility process with the frozen processor (main.cjs:53-54). The web app **cannot** use a standalone companion: it gets the token only from the preload bridge (companion.js:6-8, 25-28, 51-54). The web CSP still lists `http://127.0.0.1:47831` (vercel.json:39). That entry is vestigial and can be deleted.

---

## 2. Pairing, identity and processor status (today)

1. Main forks the companion. The companion posts `{port, token}` on `parentPort` (server.mjs:232), and main stores it as `companionInfo` (main.cjs:56).
2. The renderer's `initializeLocalDesktop()` (companion.js:47-65):
   - `info()` (requires a 64-hex token, `:52`);
   - `GET /status` → `name = os.hostname()` (server.mjs:185);
   - `devices.pair({tokenHash: sha256(token), name})` (companion.js:56-58 → devices.ts:18-33);
   - `POST /connect {convexUrl}` (companion.js:59 → server.mjs:186 → `connect()` :41-64).
3. `connect()` (server.mjs:41-64):
   - validates `https://<x>.convex.cloud/` (:43);
   - refuses to switch deployments while busy (:44);
   - runs `devices.identity` (:47 → devices.ts:34-40) and stores `identity = {userId, deviceId}`;
   - persists `convexUrl` (:52);
   - replays an update-cancellation marker (:53-58);
   - subscribes `onUpdate(worker.next)` (:59-63). That subscription is the **only** link to the server: no heartbeat, by design ("no idle polling or per-second heartbeats", :158).
4. On later launches the companion **auto-connects** from the saved `convexUrl` (server.mjs:237) before the renderer pairs again. The renderer re-pairs anyway on every launch (desktop-client.js:50).

**`devices` row** (schema.ts:70-72): `{userId, tokenHash, name, revoked}`, indexes `by_token`, `by_user`. There is no presence, version, platform or last-seen field.
- `pair` (devices.ts:18-33) needs a writable account.
  - If the token hash exists for another user, it throws "This companion belongs to another account. Reset its pairing locally first." (:25).
  - If it exists for this user it **sets `revoked:false`** (:26), so an admin revoke is undone on the next launch.
  - The name is never refreshed after the first pair.
  - At most 20 devices per user (:29-30).
- `requireDevice` (devices.ts:11-17) hashes the token (`hashToken` rejects non-64-hex, :6-10). It throws "Companion is not paired. Connect it in Settings." when the device is missing or revoked (:14), and calls `assertAccountAccess(…, write=true)` (:15). **Every** worker call, including the `worker.next` subscription, therefore fails for export-only and suspended accounts.
- `revoke` (devices.ts:41-49) exists, but **no client UI calls it**. Only admin `revokeDevice` is used (admin.ts:83-90).

**Processor status available today:**
- `/status` → `{name, connected: !!identity, deviceId, userId, busy}` (server.mjs:185).
- Main's `localStatus()` (main.cjs:24-29) is used only by the quit guard and the smoke test.
- When the companion exits, main sends an **update-state** event `{status:'error', message:'Local processor stopped. Restart Woodshed to reconnect.'}` (main.cjs:57). A processor failure is pushed down the *update* channel, so the 2.0 avatar dot would read it as an update error. That needs fixing (§16.5).
- There is no "starting", "first run", queue length, current job or restart path.

---

## 3. Job model and lifecycle

### 3.1 Schema (`convex/schema.ts:155-190`)
| Field | Notes |
|---|---|
| `userId`, `deviceId?` | `deviceId` is optional in the schema but always set by every creator (jobs.ts:94,123; worker.ts:128) |
| `kind` | `'separate' \| 'beats' \| 'import'` |
| `importMeta?` | `v.any()`: `{id, tempo, practice}` for imports (worker.ts:128) |
| `songId?` | Set up front for re-split (jobs.ts:95) and beats (:125). Set on completion for new songs (worker.ts:100) |
| `label` | Raw input text, filename, `"Detecting beats — <title>"`, or the legacy title |
| `source?` | `sourceValidator` (schema.ts:8-18): `{type: url\|search\|spotify\|upload, value, filename?}` |
| `settings?` | `v.any()`, run through `withDefaults` on create (jobs.ts:88) |
| `status` | `queued \| running \| done \| error \| canceled` |
| `stage` | Free string. The comment says `queued \| download \| separate \| finalize \| detect` (schema.ts:173), but `sync`, `error` and `done` are also written (§4) |
| `percent` | Clamped 0–100 (worker.ts:36) |
| `message?` | ≤ 300 chars (worker.ts:36) |
| `error?` | ≤ 2000 chars (worker.ts:36) |
| `meta?` | "Partial metadata streamed back early" (schema.ts:177-178). **Nothing writes it.** `listActive` returns it (jobs.ts:35) and the library reads `meta.title/coverKey/…` (library.js:200-205), but it is always undefined |
| `result?` | Beats only: `{beats: [[t, beatInBar], …]}` (worker.ts:111) |
| `attempts?` | Initialised to 0 for separations (jobs.ts:102) and **never incremented or read**. The bot-check requeue it was built for (schema.ts:181-183) is not implemented on the companion path |
| `createdAt`, `updatedAt` | `updatedAt` is bumped on every patch |

Indexes: `by_user`, `by_user_status`, `by_song`, `by_device_status` (schema.ts:187-190).

### 3.2 State machine (who moves it)
```
            createSeparation / createBeatDetection / importSong
                               │
                               ▼
   ┌────────── queued ◄──────────── retry (from error only, same device)
   │             │ claim (companion, worker.ts:19-28)
   │             ▼
   │          running ──progress(error)──► error ──dismiss──► (deleted)
   │             │  ├─ finish (separate/import) ─► done (stage 'done', percent 100)
   │             │  └─ beatsDone (beats) ───────► done (stage stays 'detect')
   │             │
   └─ cancel ────┴─► canceled   (jobs.cancel, admin.cancelJob, songs.remove, worker.cancelForUpdate)
```
| Transition | Function | Ref | Guard |
|---|---|---|---|
| → queued (separate) | `jobs.createSeparation` | jobs.ts:60-109 | Device owned and not revoked; < 20 queued on that device; label ≤ 500; source.value ≤ 2000 |
| → queued (beats) | `jobs.createBeatDetection` | jobs.ts:111-136 | Song and device owned. **No dedupe** (a double click queues two). Does not count against the 20 limit |
| → queued (import) | `worker.importSong` (device token) | worker.ts:115-131 | Dedupes against a finished song (`by_user_import`) and against a queued or running import; ≤ 20 queued |
| queued/running → running | `worker.claim` | worker.ts:19-28 | Device owns the job; returns `{...job, quality: resolveQuality(settings), song}` |
| running → running (progress) | `worker.progress` | worker.ts:30-38 | Returns **false** if the job is no longer queued or running. The companion then kills the child (server.mjs:94) |
| running → error | `worker.progress({stage:'error', error})` | server.mjs:154; worker.ts:36 | — |
| running → done | `worker.finish` via `blobs.complete` | worker.ts:57-102; blobs.ts:21-32 | Manifest must match the reserved audioObjects; title ≤ 500; duration > 0 |
| running → done (beats) | `worker.beatsDone` | worker.ts:104-113 | Kind is beats, status running; ≤ 8000 beats; every pair finite |
| any live → canceled | `jobs.cancel` | jobs.ts:143-154 | Not done or canceled. **Does not retire reserved audioObjects.** `admin.cancelJob` does (admin.ts:96-97); otherwise the hourly `storage.expire` cleans them (storage.ts:75-78) |
| live → canceled | `songs.remove` → `deleteSongData` | songs.ts:114-115 | Cancels queued and running jobs `by_song` |
| live → canceled | `worker.cancelForUpdate` | worker.ts:134-144 | The device's own job, during app update (§14) |
| error → queued | `jobs.retry` | jobs.ts:170-179 | Same device as the original. Sets `message:'Resuming local files…'` but **leaves `stage:'error'`, `percent:0`** |
| error → deleted | `jobs.dismiss` | jobs.ts:157-168 | Not queued or running |

**Picking order.** `worker.next` (worker.ts:10-17) returns the device's first `running` job (resume after a restart), otherwise its first `queued` job. Both come from `by_device_status`, so the order is FIFO by `_creationTime`. A retried job keeps its creation time and jumps ahead of newer queued jobs.

**Done and canceled jobs are never deleted.** `jobs.listActive` (jobs.ts:12-38) reads the newest 50 `by_user` rows and then filters to `queued|running|error`. Once more than 50 newer done jobs exist, an older failed job silently disappears from the list. Fix: query `by_user_status` once each for `queued`, `running` and `error` (§16.4).

**Cancellation mechanics** (companion side):
- `jobs.cancel` patches `canceled`.
- The `worker.next` subscription re-runs and returns a different job (or null). `current.id` no longer matches, so `killCurrent()` runs (server.mjs:59-62).
- `killCurrent()` aborts fetches through `AbortController` and kills the process group: `process.kill(-pid,'SIGTERM')`, or `taskkill /T /F` on Windows (server.mjs:65-70; spawn is `detached` on POSIX, :81).
- `execute` rejects and `drain` catches it. Its `progress(error)` returns false because the job is now canceled (server.mjs:151-155).
- The partial work dir stays on disk, and a canceled job can never be retried.

### 3.3 `jobs.listActive` / `jobs.get` payloads
- `listActive` row: `{jobId, kind, songId, label, status, stage, percent, message, error, meta}` (jobs.ts:25-36). It is **missing** `deviceId`, `createdAt`, `startedAt`, `settings`, `source` and `attempts`. Spec §2.8 needs these for the queue position, the device name, "started 1:42 ago", the settings line and the source link.
- `get` row: `{jobId, status, stage, percent, message, error, result}` (jobs.ts:41-58). Only `backend.detectBeats` uses it (backend.js:192). If the job is deleted, `get` returns null and the promise **never settles** (backend.js:193).

---

## 4. Stages, percent and message (every emitter)

The processor prints JSON lines on stdout: `{"stage","percent","message"}`, `{"error"}` or `{"complete":true}` (pipeline.py:38-44; process.py:84-90). `Reporter.progress` drops a repeat of the same `(stage, int(percent))` (pipeline.py:40-43).

The companion forwards progress lines to `worker.progress` **at most once per 2 s, with no trailing flush** (server.mjs:92-95). An event inside the window is dropped, even when it is a stage change. So the final "Separating… pass 8/8 · 99%" or "Encoding sync copies locally…" can be skipped. Error lines are kept locally and reported once at exit (server.mjs:91, 99, 154).

| Stage | % | Message | Emitter |
|---|---|---|---|
| `queued` | 0 | — | jobs.ts:100-101, 129-130; worker.ts:128 |
| `download` | 5 → 40 → 100 | "Fetching your file…" → "Converting to WAV…" → "Ready" | upload source, pipeline.py:138, 144, 167 |
| `download` | 2 | "Resolving Spotify track…" | pipeline.py:177 |
| `download` | 5, then live % from `[download] NN.N%` | "Downloading audio…" | pipeline.py:268-274 |
| `download` | 3 | "YouTube is busy — trying SoundCloud…" | pipeline.py:255 (bot-check fallback) |
| *(none)* | — | Fingerprinting with fpcalc, up to 45 s timeout. **No event**, so the card shows "download 100 Ready" meanwhile | process.py:44-46; fingerprint.py:19 |
| `separate` | 0 | "Loading model…" | pipeline.py:427 |
| `separate` | 0–90 | "Preparing NVIDIA acceleration (one-time download)…" (frozen builds only) | gpu_runtime.py:177-178 |
| `separate` | 0 | "GPU setup unavailable; using CPU…" | gpu_runtime.py:187 |
| `separate` | 0 | "Loading model… (NVIDIA GPU \| Apple GPU \| CPU · N threads)" | pipeline.py:394-402 (from `WOODSHED_RUNTIME`, separator.py:116) |
| `separate` | 0 | "GPU unavailable; continuing on CPU…" | pipeline.py:403-406 (from `WOODSHED_FALLBACK`, separator.py:128) |
| `separate` | 1 | "Separating stems…" | pipeline.py:422-425 |
| `separate` | 0–99 | "Separating stems… (<backend>, pass i/N)" with N = models × max(1, shifts) (`htdemucs_ft` counts as 4; **`mdx_extra` is also a 4-model bag but counts as 1**, so its % jumps and caps at 99) | pipeline.py:384-421 |
| `finalize` | 90 | "Encoding sync copies locally…" | process.py:55 |
| `sync` | 95 | "Syncing your library…" (sent directly, not throttled) | server.mjs:134 |
| `done` | 100 | — | worker.ts:100 (separate/import) |
| `detect` | 20 → 50 | "Building a mix locally…" → "Detecting beats locally…". Nothing after that until done; BeatNet is opaque | process.py:29-31 |
| `error` | 0 | `error` = raw text | server.mjs:154 |

**Percent is per stage**, restarting at 0 for download and separate. Finalize (90) and sync (95) use overall-looking constants. The renderer-only `upload` stage comes from `library.js` (library.js:217, 592) and never reaches Convex.

**First-run model download** is not reported as such. Demucs pulls weights into `TORCH_HOME` on a model's first use. torch.hub prints `Downloading: "…/xxxx.th"` plus a tqdm bar, which `run()` merges into stdout (pipeline.py:52-60). `separate.on_line` matches that bar with `(\d{1,3})%\|` (pipeline.py:410) and shows it as "Separating stems… pass 1/N". "Separating track" then resets the counters (pipeline.py:422-424), so totals recover, but the first-run download is mislabelled. Spec §6.5's "Starting… (first run, ~1 min)" has nothing behind it today (§16.5).

---

## 5. How the client creates jobs

### 5.1 `jobs.createSeparation` args (jobs.ts:60-109)
| Arg | Type | Notes |
|---|---|---|
| `source?` | `{type:'url'\|'search'\|'spotify'\|'upload', value:string, filename?}` | Omitted for re-split, which inherits `song.source` (:73-78). With no source it throws "This song can’t be split again — its original audio is gone." (:80) |
| `deviceId` | `Id<'devices'>` | From `/status.deviceId` via `requireCompanion()` (companion.js:36-41). The server only checks that the device is owned and not revoked (:83-84), so **any** of the user's devices is accepted. B5 builds on this |
| `settings` | `v.any()` | Stored as `withDefaults(settings)` (:88) |
| `label` | string ≤ 500 | Raw input, filename or `"<title> (reprocess)"` |
| `replaceSongId?` | `Id<'songs'>` | Re-split |

It returns `{jobId, songId: null}` **always** (:107). The "dedupe returns songId" contract in backend.js:122-126 is stale: `renditions` exists (renditions.ts) but is not wired into job creation.

**Source classification** (`classifyInput`, backend.js:112-117):
- `open.spotify.com` or `spotify:` → `spotify`;
- `^https?://` → `url`;
- anything else → `search`.

**What each source does in the processor** (pipeline.py:129-237):
- `upload`: `job.localSource = <account>/uploads/<uuid>`. Only a 36-char hex/dash id is accepted ("Original file unavailable locally. Add the file again.", server.mjs:106-109). ffmpeg converts it to WAV. Tags come from ffprobe and cover art from the first video frame (pipeline.py:137-168).
- `url`: yt-dlp on that exact URL with `--no-playlist` and **no fallback** (pipeline.py:235-237).
- `search`: `ytsearch1:<q>`. On a bot check it falls back to `scsearch5:<q>` with `-i --max-downloads 1 --match-filter "duration > 90 & duration < 720"` (pipeline.py:221-234, 240-256). **Whatever comes first is used, unconfirmed.**
- `spotify`: Spotify oEmbed `title` (pipeline.py:174-188). The oEmbed title of a track may not include the artist, so treat the match as weak. It then runs as a search. "Could not resolve this Spotify link." (:188).
- Common yt-dlp args (pipeline.py:4, 276-299):
  - `--js-runtimes node --remote-components ejs:github --ignore-config --no-playlist`;
  - `-f bestaudio/best -x --audio-format wav --audio-quality 0 --write-info-json --progress --newline -o dl.%(ext)s -- <target>`;
  - exit codes 0 and 101 are OK.
- Metadata comes from the info JSON (pipeline.py:312-330). `meta.resolvedUrl = info.webpage_url` (pipeline.py:336-337), but **`process.py` drops it**: its result copies only fixed keys (process.py:70-77), and `resultValidator` has no such field (worker.ts:49-56). The song never learns which recording a search landed on.

### 5.2 Settings, presets and quality (`convex/lib/presets.ts`)
- Presets (:17-42):
  - `studio`: htdemucs_ft, 10 shifts, 0.5 overlap;
  - `balanced`: htdemucs_ft, 2, 0.25 (default, :44);
  - `fast`: htdemucs, 0, 0.25.
- `MODELS` (:46-51): `htdemucs_ft`, `htdemucs`, `htdemucs_6s`, `mdx_extra`.
- `STEM_MODES` (:53-58): `full`, `drums`, `vocals`, `bass`. The two-part modes become `--two-stems=<focus>` (pipeline.py:379-381), giving `[focus, no_focus]` (pipeline.py:346-350).
- `BITRATES` 128/160/192/256 (:62-67).
- `DEFAULT_SETTINGS = {preset:'balanced', stemMode:'full', format:'opus', bitrate:192, custom:{htdemucs_ft,10,0.5}}` (:69-87). `withDefaults` merges one level deep plus `custom` (:92-98).
- `resolveQuality` (:101-117): the preset or `custom`, with model allow-list, shifts clamped 0–10 and overlap 0.1–0.75. `format` is `flac` or `opus`; bitrate must be in the list.
- **`format` is dead.** `process.py:15` forces `quality['format']='opus'` and always writes `.webm`/`audio/webm` (process.py:61-63). Delete the setting rather than expose it (spec §6.2 "audio format/bitrate" becomes bitrate only).
- **6-stem layout:** there is no stem mode for it. You get 6 stems only with `preset:'custom'` plus `custom.model:'htdemucs_6s'` and `stemMode:'full'` (STEM_SETS, pipeline.py:5-7, 346-348).
  - Spec §3.2 wants a first-class "Full band + guitar & piano · 6" choice that keeps the chosen preset's passes and overlap (§16.4 item 7).
  - **Danger:** `expected_stems` sends any unknown mode to the drums two-stem split (pipeline.py:349). A new mode id must be normalised server-side before it reaches Python.
- R2 accepts only stem names `drums|bass|other|vocals|guitar|piano|no_drums|no_bass|no_vocals` with `.webm|.flac` (storage.ts:56).

### 5.3 Client entry points (backend.js)
- `addSong(input, settings)` (:127-136): `requireCompanion` → `createSeparation({source: classifyInput(input), deviceId, settings, label: input.trim()})`.
- `reprocessSong(songId, settings, label)` (:139-147).
- `addFiles(files, settings, onProgress)` (:162-179), §6.
- `detectBeats(songId, onProgress)` (:187-211), §8.
- `retryJob(jobId)` (:224) → `jobs.retry({jobId, deviceId: this computer})`, so retry always needs **the same computer** (jobs.ts:175).
- `cancelJob` / `dismissJob` (:61-67).
- The docblocks at backend.js:1-7 and 151-157 still describe Modal and browser→R2 uploads. Both are false and get deleted.

---

## 6. Upload flow, and is progress real?

**Today (no):**
1. `uploadAndQueue` (library.js:581-601) creates a local `uploads` entry (`upload_<ts>_<rand>`) and renders "Uploading · 0%".
2. `addFiles` (backend.js:162-179), per file:
   - `requireCompanion()`, which costs one `/status` round trip per file;
   - `localUpload(file)` → `request('/upload', file)`. That is `fetch` POST with the raw Blob, bearer auth and a 600 s timeout (companion.js:10-23, 42);
   - **then** one `onProgress({loaded: size, total: size})` (backend.js:167);
   - then `createSeparation({source:{type:'upload', value: id, filename}, …, label: file.name})`.
3. The companion streams the body to `<account>/uploads/<uuid>` with a 1 GB cap (`limitBytes`). It deletes the partial file on failure, writes with `flags:'wx'` and returns `{id}` (server.mjs:190-195). The revocation check runs first (server.mjs:189).

So the bar shows 0% for the whole upload and then jumps to 100%. **Progress is fake.** Cancel during an upload only removes the local entry; the in-flight `addFiles` still creates the job (shell.md §13.4).

**2.0 (spec §3.4 "real bytes"):**
- Replace the fetch for `/upload` with `XMLHttpRequest`:
  - `xhr.upload.onprogress → {loaded, total}`;
  - `xhr.abort()` on cancel (the server's `pipeline` errors and removes the partial file, server.mjs:193);
  - `Authorization` header, `Content-Type: application/octet-stream`, `X-Filename: encodeURIComponent(name)` (already allowed by CORS, server.mjs:181; the server may log it, but must never use it as a path).
- CORS preflight already allows POST, `authorization`, `content-type` and `x-filename` (server.mjs:181), which covers the extra preflight XHR triggers.
- Only create the job after a 200. Check the cancel token again **before** `createSeparation`.
- Fetch the device id once per batch, not per file.
- **Fixture impact:** `tests/fixture/preamble.js:23-29` mocks only `window.fetch`. It needs an `XMLHttpRequest` shim for `127.0.0.1:47831/upload` that emits progress events.

---

## 7. A job on the companion, end to end (`runJob`, server.mjs:102-147; `process.py`)

1. `drain()` (server.mjs:148-162) takes `pending` when `acceptingJobs && !busy`, sets `current = {id, child:null, abort}` and calls `runJob`.
2. `claim` (server.mjs:103) returns the job plus `quality` and `song`. Work dir: `<account>/jobs/<jobId>` (:104-105).
3. Per kind, before spawning:
   - upload → `job.localSource` (:106-109);
   - import → `job.legacySong` from `imports.json` ("Legacy files missing. Import from this computer again.", :110-114);
   - beats → `media.signKeys` for every stem, then download each to `input-<i>.audio` with a 300 MB cap (`download`, :71-75, 115-122). **No progress is sent while the stems download.**
4. Write `job.json` and `execute` (server.mjs:76-101):
   - spawn `WOODSHED_PROCESSOR <root>` (frozen) or `python process.py <root>`, with `PYTHONUNBUFFERED`, `PYTORCH_ENABLE_MPS_FALLBACK` and PATH carrying the venv (:27-28, 79-81);
   - stderr tail is kept to 3000 chars (:84);
   - exit 0 resolves; otherwise reject with `event.error || stderr || 'Processor exited (<code>). Run npm run companion:setup first.'` (:99). **That developer hint reaches packaged users.**
5. `process.py` (process.py:8-79) is **resumable**:
   - a finished `result.json` returns at once (:11-12);
   - `source-meta.json` plus `source.wav` skips acquisition (:35-37);
   - the fingerprint is cached in `source-meta.json` (:44-46);
   - `separation.complete` skips Demucs (:51-53).
   - Encoding runs `min(4, cpu_budget(), n)` ffmpeg Opus encodes in parallel (:59-66; pipeline.py:435-466).
   - Cover ≤ 2 MB (:67-69).
   - Metadata is cleaned and capped at 500 chars. `year` must be 4 digits and track/disc 1–9999 (:70-77).
6. Back in `runJob` (server.mjs:125-146):
   - SHA-256 each file (:128-133);
   - `progress(sync, 95)` (:134);
   - `blobs.prepare` (storage.reserve: 1–8 files, name and mime allow-lists, ≤ 250 MB each, user and app quota checks, 1 h reservation; storage.ts:47-81);
   - PUT each to its signed R2 URL with `x-amz-checksum-sha256` (:137-141);
   - `blobs.complete` (HEAD-verifies size, type and checksum, then `worker.finish`; blobs.ts:21-32);
   - write `synced.json` (:146).
7. `worker.finish` (worker.ts:57-102):
   - re-split: retires the old stem keys and keeps the user's title, artist, album, uploader, cover, addedAt and the metadata fields (:86-90);
   - new song: inserts it, or for an import adopts `importMeta.tempo/practice/localImportId` (:92);
   - new non-import songs get `metadataStatus:'pending'` and `metadataLookup.enrich` is scheduled (:96-99).
8. `drain` `finally` (server.mjs:155-161): clears `busy`, **re-queries `worker.next` once**, and drains again 100 ms later if something is waiting.

---

## 8. Beat-detection job

- Create: `jobs.createBeatDetection({songId, deviceId})` (jobs.ts:111-136), label `"Detecting beats — <title>"`. No dedupe and no queue limit.
- Companion: downloads every stem (server.mjs:115-122). The processor mixes them with `amix=inputs=N:normalize=0`, 22.05 kHz mono (process.py:25-33), runs `beats.detect` (BeatNet offline + DBN, beats.py:3-21) and returns `{beats:[[t, beatInBar]]}`.
- `worker.beatsDone` (worker.ts:104-113) stores `job.result = {beats}`, `status:'done'`, `percent:100`. **It writes nothing to the song.** The map is built **only in the renderer**, if the waiting player is still open:
  - `player.detectBeats` (player.js:950-971) → `metronome.setDetected` (metronome.js:68-70) → `SongMapStore.replaceFromBeats` → `fromBeats` (shared/song-map.ts:233-252) → debounced `saveTempo`;
  - if the user navigates away, the beats stay in a done job nobody reads.
- BeatNet needs `setup.py --beats` (setup.py:21-24). It is collected into the frozen build (scripts/build-processor.py:4). Without it the error is a Python `ModuleNotFoundError` string.
- `listActive` shows beats jobs only while live, and the library filters them out (library.js:62). Spec §2.8 wants them listed.

---

## 9. Legacy import jobs

- `/legacy` (server.mjs:210-213) scans three OS config dirs for `woodshed/library.json` (legacyDirs, :163-165) and returns `[{directory, count}]`.
- `/import {directory}` (server.mjs:214-226):
  - `readLegacy` resolves stem and cover paths (:166-176);
  - merges all songs into `imports.json`;
  - calls `worker.importSong` for up to 20 new songs per click;
  - returns `{count, skipped, remaining}`;
  - "Import queue full. Import more after these finish." (worker.ts:126).
- Processing (process.py:17-24): no download or separation. It copies the cover and re-encodes the legacy WAV stems to Opus; `stemMode` comes from the legacy song.
- `finish` adopts `importMeta.tempo` and `.practice` (worker.ts:92) and dedupes on `localImportId` (:74-81). These legacy `tempo` and `practice` blobs are exactly the stored shapes the 2.0 one-way upgraders must read (see `maps/mapedit.md` §11 and spec §9.3).
- Settings copy (settings.js:152-163): "Queued N songs. Existing files are preserved. Import again after these finish for N remaining songs."
- 2.0 keeps this in Settings → Processing ("Import an old Woodshed library", spec §6.2) and shows import jobs in the Jobs popover. Optional improvement: auto-continue the next 20 when the queue drains instead of asking for another click (companion-side loop over `imports.json` entries without a song).

---

## 10. Error strings (complete catalogue) and the 2.0 mapping

### 10.1 Raw strings by origin
**Processor (Python), via `{"error"}`, which becomes `job.error`:**
| String | Ref |
|---|---|
| yt-dlp detail lines with "Sign in to confirm you’re not a bot" → `BotChecked(detail)` | pipeline.py:25, 77-78 |
| `"<exe> exited with code N\n<last 20 meaningful lines>"` (yt-dlp/python, ffmpeg, woodshed-processor) | pipeline.py:79 |
| "Original file is not on this computer. Add it again." | pipeline.py:143 |
| "Could not resolve this Spotify link." | pipeline.py:188 |
| "No audio could be downloaded." | pipeline.py:256, 302 |
| "Missing stem: <name>" | process.py:58 |
| "WOODSHED_DEVICE must be auto, cpu, cuda, or mps" / "<KEY> must be a positive integer" | separator.py (`select_device`, `thread_count`) |
| "Unsupported processing module" | desktop_entry.py:10-11 |
| Python exceptions (ModuleNotFoundError for BeatNet, MemoryError, OSError ENOSPC) as `str(error)` | process.py:88-90 |

**Companion (Node):**
| String | Ref |
|---|---|
| "Request too large." / "File too large." | server.mjs:34, 39 |
| "Expected a Convex deployment URL." / "Wait for processing to finish before switching deployments." | server.mjs:43-44 |
| "Download failed (<status>)." (beats stem fetch) | server.mjs:73 |
| `errorMessage \|\| stderr tail \|\| "Processor exited (<code>). Run npm run companion:setup first."` | server.mjs:99 |
| "Original file unavailable locally. Add the file again." | server.mjs:107 |
| "Legacy files missing. Import from this computer again." | server.mjs:113 |
| "Sync upload failed (<status>). Your local files are safe." | server.mjs:140 |
| HTTP: "Untrusted origin." 403 · "Invalid local processor credential." 401 · "Pair the companion in Settings first." 400 · "Unknown endpoint." 404 · "Unrecognized library.json." | server.mjs:179, 183, 187, 227, 169 |
| AbortError text on cancel (not visible: `progress` returns false) | server.mjs:72, 139 |

**Convex (thrown to companion or client):**
- jobs: "Connect this computer’s companion in Settings first." · "Process the queued songs before adding more." · "Source is too long." · "Not your song." · "This song can’t be split again — its original audio is gone." · "Connect the local companion first." · "Cancel the job first." · "Retry from the original processing computer." · "Only failed jobs can be retried."
- worker: "Job unavailable." · "Invalid upload manifest." · "Invalid song metadata." · "Invalid stem." · "Song was deleted during processing." · "Job no longer running." · "Invalid fingerprint." · "Invalid beat map." · "Invalid import." · "Import queue full. Import more after these finish."
- devices: "Invalid companion credential." · "Companion is not paired. Connect it in Settings." · "Invalid pairing code." · "This companion belongs to another account. Reset its pairing locally first." · "Device limit reached."
- storage: "Expected 1–8 audio/art files." · "Invalid file name." · "Invalid file size/checksum." · "Invalid file type." · "The previous sync attempt is awaiting cloud cleanup…" · "The local files changed since this upload started…" · **"Your cloud library is full. Upgrade in Plan & billing…"** · **"Cloud storage is currently full…"** (storage.ts:53-70) · blobs: "Uploaded file did not match its reservation." (blobs.ts:28)
- auth: "Not signed in." · **"Your account is suspended…"** · **"Your account is in export-only mode…"** (lib/auth.ts:9, 32-33)

**Renderer:** "Local processor unavailable. Restart Woodshed for desktop to reconnect." · "Open Woodshed for desktop and sign in to process songs on this computer." · "Local processor is not connected. Retry the desktop connection in Settings." (stale; spec §3.6 deletes it) · "The local processor is not ready. Restart Woodshed." · "Local processor request failed." (companion.js:19, 27, 30, 38, 52, 21).

**Main process:**
- "Local processor did not start." (20 s timeout) · "Local processor exited." · "Local processor stopped. Restart Woodshed to reconnect." (on the update channel) · "Processing status unavailable." · "Woodshed could not start" error box · "Untrusted window" · "Unknown theme" · "Unknown update action" (main.cjs:55, 57, 27, 184, 85-97).
- Update-controller copy: §14.

**Today's mapping** is `friendlyError` (library.js:296-309), a regex table (shell.md §14). Three of its rules match only Modal-era strings the companion never emits: "produced no stems", "no stems to analyse", "rejected the job|unauthorized|is not set on this deployment". They are dead.

### 10.2 2.0: structured error codes (classify at the source, not by regex in the UI)
Add `errorCode: v.optional(v.string())` to `jobs`, plus an optional `errorCode` argument to `worker.progress`. The UI maps code → spec §3.6 sentence and action. `job.error` keeps the raw text for `Details`.

| `errorCode` | Set where | Detection | Spec §3.6 row |
|---|---|---|---|
| `bot_check` | process.py top level (`except BotChecked`) | exception type | "YouTube asked for a sign-in check…" `Try now` (auto-retry pending, §16.4 item 4) / "YouTube blocked this download." when attempts are exhausted |
| `unavailable` | pipeline `run()` on yt-dlp failure | `/Private video\|Video unavailable\|is not available\|not available in your country\|has been removed\|members-only\|account .* terminated/i` | "This video isn't available…" `Search for another version` |
| `not_found` | pipeline.py:256, 302; Spotify :188 | literal raise sites | Unknown row, with `Search for another version` |
| `unreadable` | upload ffmpeg conversion (pipeline.py:146) | ffmpeg non-zero on an upload source | "This file couldn't be read as audio." |
| `source_missing` | server.mjs:107; pipeline.py:143 | literal | "…Add the file again." (`Choose another file`) |
| `disk_full` | anywhere | `/No space left on device\|ENOSPC\|Errno 28/` | "This computer is out of space for processing." |
| `separation_failed` | `separate()` run failure | separator exit non-zero, `/out of memory\|MemoryError\|Killed/`, negative exit code | "Splitting failed on this computer." `Try again` / `Try Fast quality` |
| `storage_full` | server.mjs `blobs.prepare` catch | message from storage.ts:69 (user) or :70 (app) | "Your cloud storage is full (x of y GB)." `Manage storage` |
| `account_paused` | server.mjs any Convex call | lib/auth.ts:32-33 | "Adding songs is paused on this account." |
| `sync_failed` | server.mjs:140 | literal | Unknown row (`Try again`; local files kept) |
| `beats_unavailable` | beats job | `ModuleNotFoundError: … BeatNet` | Get-bars surfaces: "Bar detection isn't installed on this computer." |
| `unknown` | fallback | — | "Something went wrong while adding this song." |

Implementation notes:
- Python prints `{"error": str, "code": str}`. `server.mjs` keeps `event.code` beside `errorMessage` (server.mjs:91) and passes it to `progress`.
- Companion-side codes (storage, account, sync, source_missing) are assigned in `drain`'s catch by matching the Convex error message, or better by throwing a `CodedError` from `runJob`.
- **Delete** the developer hint "Run npm run companion:setup first." from packaged builds (server.mjs:99): show it only when `!process.env.WOODSHED_PROCESSOR`.
- Copy stays out of Python. Python emits codes and raw detail only.
- "Processor offline at submit" is a renderer-side error (no job exists). It is thrown when `/status` fails or `connected:false`.

---

## 11. Companion HTTP API (security model)

Routes and payloads are tabulated in `maps/shell.md` §12. Security properties the new routes must keep:
- **Bound to 127.0.0.1** (server.mjs:230). The `Host` header must equal `127.0.0.1:<port>` or `localhost:<port>`, and `Origin` must be in `origins` = `{WOODSHED_WEB_URL origin}` (server.mjs:16-17, 179). In Electron that is `http://127.0.0.1:47832` (main.cjs:54).
- **Bearer token**, compared in constant time (server.mjs:182-183).
- `OPTIONS` answers `Access-Control-Allow-Private-Network: true` (server.mjs:181).
- Every route after `/status` and `/connect` **re-runs `devices.identity`** before touching the filesystem (server.mjs:189). That is one Convex round trip per request, which matters for B4's debounced lookups (§16.1).
- Routing is by exact `req.url` string (`req.url==='/status'`). Routes with query strings need `new URL(req.url, 'http://127.0.0.1')`.
- JSON bodies are capped at 16 KB (`body`, server.mjs:32-36). Uploads are capped at 1 GB.

---

## 12. Electron main (`desktop/main.cjs`)

| Concern | Today | Ref |
|---|---|---|
| Static UI server | `http://127.0.0.1:47832`. Serves `/assets/*` plus 5 allow-listed files; everything else gets `index.html`. CSP: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' http://127.0.0.1:* https://*.convex.cloud wss://… https://*.convex.site https://*.r2.cloudflarestorage.com; img-src 'self' data: blob: https:; media-src 'self' blob: https:; worker-src 'self' blob:` | main.cjs:30-50 (allow-list :41, CSP :46) |
| `/media/<ticket>` | Proxy for signed R2 audio (no CORS upstream): single-use 60 s tickets, ≤ 128 pending, 300 MB cap, 10 min timeout | main.cjs:34; media-proxy.cjs |
| `/oauth/callback` | Reloads the window at `/?<params>` and shows a "Return to Woodshed" page in the system browser | main.cjs:35-39 |
| Companion fork | `utilityProcess.fork(companionEntry, [], {env: WOODSHED_WEB_URL, WOODSHED_COMPANION_PORT:'0', WOODSHED_DATA_DIR, WOODSHED_PROCESSOR, WOODSHED_GPU_MANIFEST, WOODSHED_GPU_CACHE, SSL_CERT_FILE, PATH+=resources/bin, TORCH_HOME, MPLCONFIGDIR})`. 20 s start timeout. Exit → `companionInfo=null` plus the update-channel error | main.cjs:51-60 |
| stop / quiesce | `stopCompanion(forUpdate)`: postMessage `shutdown`, kill after 2.5 s. `quiesceCompanion()`: `quiesce` → `{type:'quiesced', busy}`, or `{busy:true}` after a 3 s timeout | main.cjs:61-74; server.mjs:238-252 |
| Window | Fixed `1280×850`, min `640×480`, background from nativeTheme, `show:false` until `ready-to-show`. `contextIsolation`, no node, `sandbox:true`. **No bounds memory** | main.cjs:105, 110 |
| Navigation | Off-origin `will-navigate` → prevented and opened externally. `window.open` → denied, and `openExternal` allows **only `https:`** | main.cjs:106-108 |
| Permissions | `setPermissionRequestHandler(... callback(false))` denies **everything**: notifications, midi, wake lock (screen-wake-lock), clipboard-read | main.cjs:109 |
| Quit guard | `close` → `localStatus()`. If busy: question dialog "A song is still processing" · "Quitting stops this job. Completed local stages can resume when you reopen Woodshed." [Keep processing] [Quit Woodshed]. Then `closing=true; app.quit()`. **No renderer flush** | main.cjs:111-116 |
| before-quit | If not closing → `window.close()` (runs the guard). Otherwise close the web server and stop the companion, then quit | main.cjs:185 |
| All windows closed | `app.quit()` on every platform, macOS included | main.cjs:186 |
| Single instance | Second launch focuses the window | main.cjs:101-102 |
| App menu | `Woodshed ▸ [Check for Updates… → send 'desktop:open-updates', quit]`, `{role:'editMenu'}`, `{role:'viewMenu'}` (reload, force reload, devtools, zoom, fullscreen, **in packaged builds too**) | main.cjs:117 |
| Theme | `appearance.json` read at start; `desktop:theme` persists it | main.cjs:18-21, 84-90 |
| Smoke test (`--smoke-test`) | Asserts `window.woodshedDesktop`, **`#app-header` present and `#sidebar` absent**. Exercises theme switching, the **`guitar-pro-import-*.js`** chunk, the **`SignalsmithStretch-*.mjs`** worklet with an offline render, and processor `/status` | main.cjs:119-183; scripts/smoke-desktop.mjs |
| Fatal start error | `dialog.showErrorBox('Woodshed could not start', message)` | main.cjs:184 |

**Rebuild-critical:**
- The smoke assertions on `#app-header`/`#sidebar` (main.cjs:121-122) **must move with the new shell's DOM**. Release CI runs them (`.github/workflows/release.yml`, `node scripts/smoke-desktop.mjs`).
- The lazy chunk names `guitar-pro-import` and `SignalsmithStretch` are load-bearing (main.cjs:139, 152).
- New static files (`/manifest.webmanifest`, spec §4.2) must join the allow-list at :41. Fonts must ship through Vite imports so they land in `/assets/` (spec §8.1).

---

## 13. Preload bridge (`desktop/preload.cjs:1-9`)
`window.woodshedDesktop` (frozen object):

| Method | Channel | Kind | Main handler |
|---|---|---|---|
| `onOpenUpdates(cb) → off` | `desktop:open-updates` | main → renderer | menu click (main.cjs:117) |
| `mediaUrl(url) → url` | `desktop:media-url` | invoke | main.cjs:83 (trusted) |
| `setTheme(theme)` | `desktop:theme` | invoke | main.cjs:84-90 |
| `info() → {version, companion:{port, token}\|null, update}` | `desktop:info` | invoke | main.cjs:91-94 |
| `update('show') → state` | `desktop:update` | invoke | main.cjs:95-100 |
| `onUpdate(cb) → off` | `desktop:update-state` | main → renderer | main.cjs:23, 76 |

`trusted(event)` = the sender is the main frame **and** its origin is `UI_ORIGIN` (main.cjs:22). Every new handler must use it, including `ipcMain.on` listeners.

---

## 14. Update flow (`desktop/update-controller.cjs`, `update-policy.cjs`)

- State: `publicUpdateState(status, info)` = `{status, version|null, percent 0–100, message}` (update-policy.cjs:1-5). Statuses: `idle`, `checking`, `current`, `available`, `downloading`, `ready`, `error`.
- Updater config: `autoDownload=false`, `autoInstallOnAppQuit=false`, `allowPrerelease=false` (:143-145).
- Events:
  - `checking-for-update` → `checking`;
  - `update-available` → `available` plus an automatic prompt;
  - `update-not-available` → `current`;
  - `download-progress` → `downloading` with percent;
  - `update-downloaded` → `ready` plus an automatic prompt;
  - `error` → `available` (if it was downloading) or `error` "Could not check or download the update. Please try again." (:146-164).
- Checks: 15 s after start, every 6 h, and on `powerMonitor` resume if overdue (`wake`) (:165-176; main.cjs:81). Only packaged builds check. `check()` dedupes concurrent calls and turns a silent resolve into `error` "Could not check for updates. Open the installed app and try again.", or "…Check your connection and try again." on reject (:25-52).
- `show(automatic)` (:53-142):
  - automatic prompts need window focus and are shown **once per `status:version`** (`prompted`). They are triggered on `focus` (main.cjs:80) and on the events above.
  - Not packaged → "Updates are available in installed builds."
  - `available` → "Woodshed <v> is available" / "Download the update now. You can keep using Woodshed and choose when to restart." [Download update] [Later]. A rejected download reverts to `available`.
  - `ready` → `quiesce()` (the companion stops accepting new jobs) → "Restart to update to Woodshed <v>?" with detail:
    - busy: "Song processing is in progress and will be cancelled when Woodshed restarts." (warning);
    - otherwise "The update is ready. Woodshed will close and reopen.";
    - buttons [Restart now] [Later] (default Later).
    - Restart → `install()`. Otherwise `resume()`.
  - Manual with no update → "Woodshed is up to date." / "Downloading update — N%" / the message.
  - Any throw → "The update could not finish. Please try again."
- `install` (main.cjs:78):
  - `closing=true`;
  - `stopCompanion(true)`, so the companion's `shutdown(forUpdate)` writes `update-cancellation.json`, kills the job and races `worker.cancelForUpdate` against 1.5 s (server.mjs:238-246);
  - `autoUpdater.quitAndInstall(false, true)`.
  - On the next connect the marker is replayed (server.mjs:53-58), so the job ends **canceled**.
- Renderer: `desktop-client.js` header icon (`available|downloading|ready`), `woodshed:show-updates` from the account menu, Settings "Check for updates" (settings.js:143-150).

**2.0 changes:**
1. Delete the header icon. Show the avatar dot and the account-menu item `Update ready — Restart to install` / `Downloading update 40%` (spec §6.5).
2. **Defer automatic prompts while the Stage plays.** Add `setActivity({playing})`. `show(true)` returns early when playing. On the playing → stopped transition, main calls `updates.focus()` again. Manual `show()` is never deferred.
3. **Resume instead of cancel on update (recommended).** `process.py` is already resumable and `worker.next` resumes a `running` job first (worker.ts:12-15). Drop `cancelForUpdate` and its marker (server.mjs:53-58, 238-245; worker.ts:134-144). The restarted companion then picks the job up where it stopped. Change the busy copy to "Song processing will pause and resume after the restart."
   - Risk: a release that changes the work-dir layout must bump a `layoutVersion` in `job.json` and discard mismatched partial state.
   - If the owner prefers the current semantics, keep the code as is.
4. Processor failure must not use `desktop:update-state` (§16.5).

---

## 15. Tests that exist (and what the rebuild touches)

| Test | Covers | Rebuild impact |
|---|---|---|
| `desktop/update-controller.test.cjs` (229 lines) | Startup, periodic and overdue-wake checks; prompt-once; download, then a separate restart prompt; busy warning; dismiss; failed or rejected download retry; disabled updater; manual check awaiting background (:74-229) | Extend: playing defers automatic prompts; the stop transition re-prompts. If (3) above lands: install no longer cancels |
| `desktop/update-policy.test.cjs` | Bounded public state | — |
| `desktop/media-proxy.test.cjs` | R2 URL validation, single-use tickets, expiry, size cap | — |
| `desktop/decoded-stem-cache.test.cjs` | **Imports `../src/js/decoded-stem-cache.js`** (:5) | **Breaks if 2.0 moves that module.** Update the path, or move the test to vitest |
| `desktop/public-release.test.cjs`, `release-metadata.test.cjs` | `scripts/verify-public-release.mjs`, `collect-release.mjs` | — |
| `companion/test_separator.py`, `test_gpu_runtime.py` (CI: `python -m unittest discover -s companion -p 'test_*.py'`) | Device selection, threads, CPU fallback, quality passthrough and backend recording, wrapper resolution; GPU manifest, download, cache and extract safety | Add B4 parsing tests and error-code classification tests here |
| `companion/selftest.py`, `scripts/test-processor.py` | Real Demucs + Opus round trip (frame-exact), resume, BeatNet | — |
| `scripts/smoke-desktop.mjs` → `main.cjs --smoke-test` | Packaged app | Update DOM assertions (§12) |
| `npm run test:desktop` = `node --test desktop/*.test.cjs` (package.json:25) | — | New `desktop/*.test.cjs` files are picked up automatically |

There are **no tests** for `companion/server.mjs` or `convex/jobs.ts`/`worker.ts`/`devices.ts`. `convex-test` is available (package.json devDeps) and used by other `convex/*.test.ts`.

---

## 16. Specifications for 2.0

### 16.1 B4: companion `/resolve` and `/search`

**Routes** (add to `server.mjs` **before** the identity recheck at :187-189, because they touch no account data. Auth and origin checks still apply):

| Route | Method | Query | Response 200 |
|---|---|---|---|
| `/resolve` | GET | `url` (≤ 2000 chars, `https?:` or `spotify:`) | `{kind:'url'\|'spotify'\|'playlist', query?, candidates: Candidate[]}` |
| `/search` | GET | `q` (1–200 chars), `n` (1–5, default 5) | `{query, provider:'youtube'\|'soundcloud', candidates: Candidate[]}` |

`Candidate = {url, id, title, channel, duration (s, number|null), thumbnail (https URL|null), provider:'youtube'|'soundcloud'|'other', live: boolean}`. Badges (`Official`, `Live`, `Cover`, `Lyrics`) are derived **client-side** from `title` (spec §3.2).

Errors are JSON `{error, code}` with these statuses:
- 503 `bot_check` (both providers blocked);
- 404 `unavailable` or `not_found`;
- 422 `playlist` ("This is a playlist link. Paste a link to one song.");
- 504 `timeout` (20 s);
- 400 `invalid`.

**yt-dlp invocation.** Factor a `ytDlp(args, {signal})` helper:
- frozen: `spawn(WOODSHED_PROCESSOR, ['--module', 'yt_dlp', ...args])` (allowed by desktop_entry.py:10);
- dev: `spawn(python, ['-m', 'yt_dlp', ...args])`;
- `env: childEnv`, so PATH has `node` for `--js-runtimes node` (main.cjs:54);
- kill the child on `signal` abort or `req.on('close')`.

Shared base args = the pipeline's `YTDLP_ARGS` (pipeline.py:4): `--js-runtimes node --remote-components ejs:github --ignore-config --no-playlist`, plus `--skip-download --no-warnings --dump-single-json`. Lift them into one constant exported to both Node and Python: either a JSON file `companion/ytdlp-args.json`, or keep them duplicated with a unit test asserting they are equal.
- **Search:** `--flat-playlist ytsearch<n>:<q>`.
  - One request, and no per-video extraction (`--dump-json` without `--flat-playlist` would fetch 5 watch pages: slower, and more of what YouTube's bot check counts, pipeline.py:259-267).
  - Map `entries[]`: `url = https://www.youtube.com/watch?v=<id>`, `channel = channel||uploader`, `duration`, `thumbnail` = the largest `thumbnails[]` ≤ 480 px wide, else `https://i.ytimg.com/vi/<id>/mqdefault.jpg`, `live = live_status==='is_live'`.
  - Drop entries with no id.
  - On a bot check (`BOT_CHECK` regex, pipeline.py:25, re-implemented in JS): retry with `scsearch<n>:<q>` and `provider:'soundcloud'`. Flat SoundCloud entries may lack `duration`; apply the pipeline's 90–720 s window only when the duration is known (pipeline.py:224-233).
- **Resolve URL:** `-- <url>` (full extraction of one page).
  - `_type==='playlist'` → 422 `playlist`.
  - Else one candidate from `webpage_url`, `track||title`, `artist||channel||uploader`, `duration`, `thumbnail`, `extractor_key` → provider.
- **Resolve Spotify:** no yt-dlp.
  - Node `fetch('https://open.spotify.com/oembed?url=…')` → `title` (mirrors pipeline.py:179-186).
  - Then run the search above with `q = title` (plus `author_name` if present).
  - Return `{kind:'spotify', query, candidates}`. "Could not resolve this Spotify link." → 404 `not_found`.

**Performance and abuse controls:**
- One in-flight lookup per route: a new request aborts the previous child.
- LRU cache: 50 entries, 10 min TTL, keyed `search:<n>:<q.toLowerCase()>` / `resolve:<url>`.
- Measure startup latency of the frozen `--module yt_dlp` (PyInstaller onedir plus yt-dlp import, expected 1–3 s) and show skeleton rows meanwhile.
- Lookups may run while a job runs. They do not touch `busy`.

**Client** (`companion.js`):
- `resolveSource(url, {signal})` and `searchSources(q, {n:5, signal})`.
- `request()` must accept an external signal: `AbortSignal.any([signal, AbortSignal.timeout(30_000)])` (companion.js:17).
- The Add sheet debounces 400 ms (spec §3.2).

**Submit with a chosen candidate:**
- `createSeparation({source:{type:'url', value: candidate.url}, label: candidate.title, meta:{title, channel, duration, thumbnail, provider}, …})`.
- New optional `meta` arg, validated: strings ≤ 300, `thumbnail` must be `https:` ≤ 2000. It is stored as `job.meta` immediately, so the card shows the real title and thumbnail from the first frame. Electron `img-src https:` (main.cjs:46) and the web CSP `img-src https:` (vercel.json:39) both allow YouTube thumbnails.
- A confirmed candidate is a `url` source, so the processor downloads **exactly** that video, with no `ytsearch1` drift.
- When `/search` fails (bot check, timeout), the sheet falls back to the honest single-result line and submits `type:'search'` (spec §3.2).

**Persist what was actually fetched:**
- Add `resolvedUrl` and `provider` to the `process.py` result (process.py:70-77, from `meta['resolvedUrl']` pipeline.py:336-337, and `info.extractor_key`).
- Add `resolvedUrl: v.optional(v.string())` and `provider: v.optional(v.string())` to `resultValidator` (worker.ts:49-56) and to the songs table.
- For `source.type==='search'` (unconfirmed), `finish` sets `needsReview: true` on the new song. This drives the one-time "Is this the right recording?" banner (spec §3.5) with the real title, provider and duration, and `songs.markReviewed` clears it.
- The banner exists only for unconfirmed searches. Candidate-confirmed songs never get it.

**Tests:** Python or Node unit tests for flat-entry mapping, playlist rejection, Spotify fallback and bot-check fallback, using recorded yt-dlp JSON fixtures. Fixture mocks for `/resolve` and `/search` in `tests/fixture/preamble.js`.

### 16.2 B5: device presence, `devices.list`, web-initiated jobs

**Schema.** Keep presence out of the `devices` row. `requireDevice` reads that row on **every** worker call, including the always-on `worker.next` subscription (devices.ts:11-17; worker.ts:12). A per-minute patch there would invalidate and re-run every device subscription. Add a table instead:
```ts
devicePresence: defineTable({
  deviceId: v.id('devices'), userId: v.string(),
  lastSeenAt: v.number(),
  state: v.union(v.literal('idle'), v.literal('busy'), v.literal('offline')),
  currentJobId: v.optional(v.id('jobs')),
  appVersion: v.optional(v.string()), platform: v.optional(v.string()),   // 'darwin-arm64' etc.
  accelerator: v.optional(v.string()),                                    // 'NVIDIA GPU' | 'Apple GPU' | 'CPU'
}).index('by_deviceId', ['deviceId']).index('by_userId', ['userId']),
```
Add to `devices`: `displayName: v.optional(v.string())` (user rename) and `revokedBy: v.optional(v.union(v.literal('user'), v.literal('admin')))`.

**Companion → `worker.heartbeat`** (new mutation, token-authenticated):
- Args `{token, state, currentJobId?, appVersion?, platform?, accelerator?}`. It upserts the presence row with `lastSeenAt: Date.now()`.
- Called:
  - on `connect()` success (server.mjs:59);
  - every **60 s** while connected (`setInterval(...).unref()`);
  - on job start and job end in `drain` (server.mjs:150, 156);
  - on `shutdown()` with `state:'offline'`, best effort, raced against 1 s (server.mjs:238-246).
- That is about 1,440 writes per device-day while the app is open, which is acceptable. It replaces the "no heartbeat" stance at server.mjs:158. A heartbeat failure must never kill the current job (unlike the subscription error handler, server.mjs:63).
- Electron passes `appVersion` and `platform` in the fork env (`WOODSHED_APP_VERSION: app.getVersion()`, main.cjs:54).
- `accelerator` comes from the last `separation-runtime.json` backend (pipeline.py:432).

**`devices.list`** (new query, user-authenticated):
- Returns `[{deviceId, name: displayName ?? name, platform, appVersion, lastSeenAt|null, state, currentJobId, queued: number, isThisDevice?: never}]` for the caller's devices where `!revoked`.
- Order: `lastSeenAt` desc. Queue count comes from `by_device_status` queued `.take(21)`.
- The **client** decides online: `state !== 'offline' && Date.now() - lastSeenAt < 150_000`, re-evaluated on a 30 s timer. Convex queries are not reactive to time, so do not compute it in the query.
- `isThisDevice` is computed client-side by comparing against `/status.deviceId` in the desktop app.

**Other device mutations:**
- `devices.rename({deviceId, name ≤ 80})`.
- User `devices.revoke` sets `revokedBy:'user'`; admin `revokeDevice` sets `'admin'` (admin.ts:83-90).
- `devices.pair` (devices.ts:18-33) refuses to un-revoke `revokedBy:'admin'` ("This computer was disconnected by an administrator."). A user-revoked device re-pairs on the next launch, which is the expected "Remove" semantics for a signed-in desktop.
- `pair` refreshes `name` from a **friendly name**: main resolves macOS `scutil --get ComputerName`, otherwise `os.hostname()` with `.local` stripped, and passes it in the fork env (`WOODSHED_DEVICE_NAME`). `/status.name` returns it (server.mjs:185). Spec copy wants "MacBook Pro" / "Kyle's MacBook", not `Kyles-MacBook-Pro.local`.

**Web-initiated jobs** (no server change to the job path; `createSeparation` already accepts any owned device, jobs.ts:83-84):
- `backend.addSong(input, settings, {deviceId})`. On web `deviceId` comes from the device picker. In the desktop app the default is this computer's `/status.deviceId`, and the picker may choose another device.
- Remember the choice in `ws.prefs.deviceId`. Default to the most recently seen online device.
- `requireCompanion()` is used **only** when the chosen device is this computer. Web code never calls `localRequest`, and the web bundle never contacts `127.0.0.1`. Delete the vestigial CSP entry in vercel.json:39.
- Files: disabled on web ("To add files, drop them into Woodshed on your computer.", spec §3.3). In the desktop app, files always go to **this** computer. The server enforces this: `createSeparation` with `source.type==='upload'` stores `originDeviceId = deviceId`, and the companion already fails a foreign upload id (server.mjs:107).
- **Re-split of an upload-sourced song** must go to the device that holds the original:
  - add `originDeviceId: v.optional(v.id('devices'))` on songs, written by `finish` from `job.deviceId` (worker.ts:85);
  - in `createSeparation`, a re-split with `song.source.type==='upload'` and `deviceId !== song.originDeviceId` throws a coded error "Re-split this song on <device name>, which has the original file."
- `jobs.retry` (jobs.ts:170-179) already pins retries to `job.deviceId`. The client passes `job.deviceId` from the extended `listActive` row instead of "this computer" (backend.js:224). That makes Retry work from web too.
- `createBeatDetection` from web: pass the chosen device. It works for any device, because stems come from R2.
- Offline device: jobs queue normally and start when it's back. Spec copy: "MacBook Pro is offline. Songs you add start when it's back." The 20-queued limit (jobs.ts:85-86) still applies per device.
- `jobs.listActive` returns `deviceId`, so rows show "Splitting on Kyle's MacBook" (join on the client with `devices.list`).
- Admin `account` (admin.ts:47-52) adds `lastSeenAt` and `revokedBy` to each device row.

Alternative: the `@convex-dev/presence` component. It is not needed: one table and one mutation are simpler, and they keep presence tied to the device token rather than a user session.

### 16.3 B6: chain a beats job after separation

**Setting:** `settings.autoBeats: boolean`, default **true**. Add it to `DEFAULT_SETTINGS` (presets.ts:69-87; `withDefaults` makes it appear for old rows). UI: Settings → Processing, "Find bars automatically after splitting".

**Enqueue** (inside `worker.finish`, worker.ts:57-102, after the song insert or patch):
- If `job.kind==='separate'`, `withDefaults(job.settings).autoBeats`, the device is still valid, and `!hasRealMap(song.tempo)`:
  - insert `{kind:'beats', userId, deviceId: job.deviceId, songId, label: 'Finding bars — <title>', chainedFrom: job._id, status:'queued', stage:'queued', percent:0, createdAt, updatedAt}`.
  - New optional field `chainedFrom: v.optional(v.id('jobs'))`.
- Re-split of a song that already has a real map: skip.
- `hasRealMap` must become a **shared** function in `shared/song-map.ts`, so Convex and the client use one implementation (spec §1.1; maps/mapedit.md §11.1). `shared/` already imports cleanly into Convex (convex/notation.ts:7-9), and `id()` uses `crypto.randomUUID()` (shared/notation.ts:73), which the Convex runtime provides.

**Prioritise.** `worker.next` (worker.ts:10-17) should return a queued **beats** job before other queued jobs. Beats jobs are about 30 s, and the user wants bars on the song they just added. Implementation: read `by_device_status` queued `.take(20)`, prefer `kind==='beats'`, otherwise the first. The `drain` re-query after completion (server.mjs:159) picks the chained job up immediately.

**Reuse the local audio** (skip the R2 stem round trip):
- For a chained job, `claim` returns `chainedFrom`.
- `runJob` checks `<account>/jobs/<chainedFrom>/source.wav` (written at process.py:40-41) and passes it as `job.localMix`.
- `process.py` beats branch: if `localMix` exists, resample it directly (`ffmpeg -i source.wav -ar 22050 -ac 1 mix.wav`) instead of `amix` over downloaded stems (process.py:26-30). Fall back to the stem download (server.mjs:115-122) otherwise.

**Progress for beats** (spec "Finding bars · 30%", determinate):
- `detect 5` "Fetching audio…" (stems download, new, server.mjs:115);
- `detect 20` "Building a mix locally…";
- `detect 50` "Finding bars…";
- `detect 95` "Saving bars…".
- `beatsDone` sets `stage:'done'` (it does not today, worker.ts:111).

**Write the map server-side** (`worker.beatsDone`, worker.ts:104-113):
- Keep `job.result = {beats}` (the manual Edit · Map flow previews it and offers undo).
- For **every** beats job (chained or manual), also write the map when the song still has no real map, so the result is never lost if the user navigated away (§8):
  ```ts
  const song = await ctx.db.get(j.songId);
  if (song && !hasRealMap(song.tempo)) {
    const map = fromBeats(a.beats.map(([time,k]) => ({time, downbeat: k === 1})), song.duration);
    await ctx.db.patch(song._id, { tempo: {...(song.tempo ?? {}), songMap: {...map, origin: 'detected'}}, tempoRev: (song.tempoRev ?? 0) + 1 });
  }
  ```
  The tempo shape follows the 2.0 serializer (maps/mapedit.md §11.2 item 7: settings plus `songMap` with `origin`, no `source/map/detected` dual-write). `practice` is not touched.
- **Concurrency with an open Stage.** The Stage holds the song's tempo in memory and saves it debounced (`saveTempo`, songs.ts:88-96; persistTempo player.js:833-842). Changing the click volume after a server-side detection would overwrite the detected map with the stale default. Fix:
  - add `tempoRev: v.optional(v.number())` to songs;
  - `songs.saveTempo({id, tempo, baseRev})`: if `baseRev !== (song.tempoRev ?? 0)` and `hasRealMap(song.tempo) && !hasRealMap(tempo)`, keep the stored `songMap`, merge only the click settings, and return `{conflict: true, tempo: merged, tempoRev}`. Otherwise write and bump `tempoRev`;
  - the Stage subscribes to `songs.get` (already live for the header, player.js:246). When a newer `tempoRev` arrives with `origin:'detected'` and the local map is not real and not dirty, it adopts the map as one undoable step ("Bars found · [Undo]"). An explicit user undo then saves with the current `tempoRev`, so it is honoured.
- Chained-job failure (`beats_unavailable`, `separation` OK): the song stays unmapped and shows its normal Get-bars entry points (spec R8). The Jobs popover lists the failed row, with `Try again` → `jobs.retry`.
- **Dedupe:** `createBeatDetection` returns the existing queued or running beats job for the song (`by_song`) instead of inserting a second (jobs.ts:111-136).
- **`backend.detectBeats`:** resolve on `null` (deleted job) with `{error:'Canceled.'}` (backend.js:193). With the server-side write, the Edit · Map flow becomes "wait for done, then adopt `song.tempo` from `songs.get`" rather than calling `metronome.setDetected` itself.

### 16.4 Job-surface extensions the spec needs (do these with Phase 3)
1. **`jobs.listActive`**:
   - query `by_user_status` for each of `queued`, `running`, `error` (bounded `.take(50)` each) instead of newest-50-then-filter (jobs.ts:18-24);
   - return `{…today, deviceId, createdAt, startedAt, updatedAt, attempts, errorCode, retryAt, chainedFrom, source: {type, value, filename}, settingsSummary: {preset, stemMode, model}}`.
   - The client derives "2 ahead" (same device, queued, `createdAt` earlier, plus the running one), "started 1:42 ago" and ETA (spec §3.4: after 15 s, from a moving rate of `percent` updates).
   - The library shows **all kinds** (delete the filter at library.js:62).
2. **`startedAt`** is set by `claim` the first time (worker.ts:25).
3. **`meta`**: write it.
   - (a) From the B4 candidate at create (§16.1).
   - (b) From the processor after acquisition: `process.py` emits `{"meta": {title, artist, uploader, duration, thumbnail}}` once `source-meta.json` exists (process.py:43). `server.mjs` forwards it unthrottled to `worker.progress({…, meta})`, a new optional validated object.
   - The card title switches from the quoted query to the real title (spec §2.8).
4. **Bot-check auto-retry** (spec §3.6 rows 1–2; schema.ts:181-183 intent):
   - `claim` increments `attempts`.
   - `worker.progress` with `errorCode:'bot_check'` and `attempts < 3` sets `status:'error'`, `retryAt = now + 5 min × 2^(attempts-1)` and `ctx.scheduler.runAt(retryAt, internal.worker.autoRetry, {jobId, attempts})`. `autoRetry` re-queues only if the job is still `error` with the same `attempts`.
   - UI: `error && retryAt` → "YouTube asked for a sign-in check. Woodshed will try again in a few minutes." `[Try now]` (= `jobs.retry`). Otherwise "YouTube blocked this download."
   - Resume skips work already on disk, so a retry costs only the download.
5. **`jobs.retry`** resets `stage:'queued', percent:0, errorCode: undefined, retryAt: undefined` (jobs.ts:177 leaves `stage:'error'`).
6. **Throttle** (server.mjs:92-95): always send on a **stage change** or a message change at percent 0. Within a stage, throttle to 2 s **with a trailing flush**. Also send the final event before `exit`.
7. **6-stem layout:**
   - add `STEM_MODES.six = {id:'six', label:'Full band + guitar & piano · 6', twoStems:null}` (presets.ts:53-58);
   - `resolveQuality` forces `model:'htdemucs_6s'` when `stemMode==='six'`, keeping the preset's shifts and overlap;
   - `claim` (worker.ts:27) returns `settings: {...settings, stemMode: stemMode==='six' ? 'full' : stemMode}`, so Python never sees `six` (pipeline.py:349 would split drums two-stem);
   - the stored song `stemMode` stays `full` (6 stems).
   - Profile defaults (spec §3.2 table) pick `six` for guitar or keys.
8. **Delete `format`** from settings and UI (process.py:15 forces opus). Keep `bitrate`.
9. **`job.error` hygiene:** stop leaking the 3000-char stderr tail as the user error when the processor gave none (server.mjs:99). Store it raw in `error` for Details. The code (§10.2) drives the sentence.
10. **First-run model download:**
    - in `separate.on_line` (pipeline.py:392-425), a line matching `Downloading: ".*\.th"` sets `downloading=true` and emits `separate 0` "Downloading the separation model (first run)…";
    - tqdm bars while `downloading` are reported under that message;
    - "Separating track" clears it (it already resets counters, :422-424).
    - Also set `model_count = 4` for `mdx_extra` (pipeline.py:386).
11. **Local disk:** add Settings → Processing "Local files: 3.2 GB · [Clean up]". This is a companion `/local-usage` GET plus `/cleanup` POST, which deletes job dirs whose job is done (`synced.json` present), keeps originals (`source.wav`, `uploads/`) unless "also originals" is ticked, and deletes canceled job dirs. Today nothing is ever deleted (§1 table).

### 16.5 Processor status and Restart processor (spec §2.1, §2.8, §6.5)
**Main** tracks the companion lifecycle:
- `processorState = {phase: 'starting'|'ready'|'stopped'|'restarting', exitCode?, message?}`.
- `startCompanion` sets `starting`; its `message` resolve sets `ready`; `exit` while not closing sets `stopped` (main.cjs:51-60).
- It is pushed on a **new** channel `desktop:processor-state` and returned by `info().processor`. **Stop emitting the update-channel error** at main.cjs:57.

New IPC `desktop:restart-processor` (trusted):
- `await stopCompanion()` (if alive), then `startCompanion()`;
- return the new `{port, token}` (the token is unchanged, `connection.json`);
- the renderer re-runs `initializeLocalDesktop()` (companion.js:47-65). The companion also self-connects from config (server.mjs:237).

**Companion `/status`** grows:
- `{name, connected, deviceId, userId, busy, accepting: acceptingJobs, job: current ? {id, stage, percent} : null, modelsReady: {htdemucs, htdemucs_ft, htdemucs_6s}, version}`;
- `modelsReady` = the weight files exist under `TORCH_HOME/hub/checkpoints`. Take the expected file names from Demucs' own remote file list (`demucs/remote/files.txt` in the installed package) rather than hard-coding hashes.

**Renderer status model** (`src/app/platform.js` per spec §9.2 `session.processor`). It combines main's phase, the pairing result and `/status`:
| Status (spec copy) | Condition |
|---|---|
| `Starting… (first run, ~1 min)` / "Setting up the processor (first run, ~1 min)…" | phase `starting`, or `!modelsReady[preset model]` while the first job is in `separate` |
| `Processor ready` | `ready` + `connected` + `!busy` |
| `Splitting 1 · 46%` | `busy` (from `/status.job` or `listActive`) |
| `Offline — Restart` | phase `stopped`, or `/status` fetch failing |
| "Couldn't connect this computer to your account. [Try again]" | `initializeLocalDesktop` threw (desktop-client.js:53-55 today only logs). `Try again` re-runs init |

Poll `/status` every 5 s only while a Jobs surface or Settings → Processing is visible. Use `processor-state` events otherwise.

### 16.6 App menu generated from the command registry (spec §6.5, §7.1, §7.4)

**Bridge:**
- `registerMenu(spec)`: renderer → main, `ipcMain.on('desktop:menu', …)`, trusted.
- `onCommand(cb) → off`: main → renderer `desktop:command`, payload `{id}`.

**Spec format** (serialisable, validated in main):
```js
[{ menu: 'file'|'edit'|'view'|'transport'|'help', items: [
   { id: 'library.add', label: 'Add Songs…', accelerator: 'CmdOrCtrl+N', enabled: true },
   { type: 'separator' },
   { id: 'view.distance', label: 'Distance', submenu: [{ id: 'view.distance.near', label: 'Near', type: 'radio', checked: false }, …] },
]}]
```
Validation:
- ≤ 6 menus, ≤ 60 items per menu, one submenu level;
- `id` matches `/^[a-z][a-zA-Z0-9.-]{0,63}$/`, label ≤ 80 chars;
- `accelerator` matches an Electron accelerator whitelist regex;
- `type` is in `normal|separator|checkbox|radio`.
- Unknown keys are dropped. On failure main keeps the previous menu.

**Main** builds `Menu.buildFromTemplate` with:
- **macOS app menu (fixed, main-owned):** About Woodshed · Check for Updates… · `Settings…` ⌘, (→ command `nav.settings`) · Services · Hide/Hide Others/Show All · Quit (`role:'quit'`).
- **File** (registry): Add Songs… ⌘N (`library.add`) · Close Song ⌘W (`stage.close` → Library, enabled only while a song is open; otherwise disabled, so ⌘W never quits by accident) · on Windows and Linux also `Settings…` Ctrl+, and `Exit`.
- **Edit:**
  - main-owned roles `cut copy paste pasteAndMatchStyle selectAll`;
  - **Undo/Redo are custom items** that send `edit.undo`/`edit.redo`. The renderer runs `document.execCommand('undo')` when a text field is focused, otherwise the registry's practice or edit undo (spec §4.14, §7.8). Using `role:'undo'` would bypass the app's undo stack.
- **View** (registry): Chart / Road map / Stems (radio), Focus, Distance ▸ (Near / Stand / Kit radio). Main appends zoom roles `resetZoom zoomIn zoomOut` (browser zoom stays an accessibility tool, spec §7.4) and `togglefullscreen`. Add `reload` and `toggleDevTools` **only when `!app.isPackaged`** (main.cjs:117 ships them in production today).
- **Transport** (registry): Play/Stop, Again, Loop, Count-in, Click, Minus me. Each has `enabled` from the command's `when`, and `checked` for toggles.
- **Help** (main-owned): Keyboard Shortcuts (`help.keys` → the `?` sheet), Licenses, on Windows and Linux `Check for Updates…`.

**Accelerators:**
- Only **modifier** accelerators (`CmdOrCtrl+…`) are registered: ⌘N, ⌘W, ⌘, plus any registry ⌘/Ctrl combos the web app doesn't own.
- Plain keys (Space, Enter, L, M…) are displayed but **not registered**, so menus never steal keys from text inputs or the registry dispatcher:
  - Windows/Linux: `registerAccelerator: false`;
  - macOS (where that option is unsupported): omit `accelerator` and keep the key in the registry dispatcher only.
  - Verify on device that ⌘-less key equivalents do not fire on macOS.
- The converter `registryKeyToAccelerator(keys)` lives in `src/app/commands.js` (`e.code` `KeyN` → `N`, `Enter` → `Return`, `Comma` → `,`, `Mod` → `CmdOrCtrl`). It is unit-tested.

**Lifecycle:**
- Main installs a minimal fallback menu at startup (app menu + Edit roles + View zoom), so the menu exists before the renderer boots or after a renderer crash.
- The renderer calls `registerMenu` after registry init and again (debounced 100 ms) when any `when`/`checked` result that feeds the menu changes: song opened or closed, play state, view, Distance.
- The renderer listens to `onCommand` and runs `registry.run(id)`. Unknown ids are ignored.
- `menu.label` comes from the registry's `menu.label ?? title` (spec §7.1 `menu: {label, electron:'Transport'}`).

The **web app never binds ⌘N, ⌘W, ⌘, (spec §7.4).** In Electron those keys come only through the menu, so there is no double-fire.

### 16.7 Background global shortcuts and media keys (spec §6.5)
**Setting:** Settings → Pedals & keys → *(desktop)* "Background shortcuts" (off by default). The setting is per device and must be known before the renderer boots, so persist it in `userData/desktop-prefs.json` (pattern: `appearance.json`, main.cjs:18-19, 84-90).

**Bridge:** `setBackgroundShortcuts(enabled) → {registered: string[], failed: string[]}` (invoke, trusted).

**Main:**
- When enabled, `globalShortcut.register` each of:
  - `Control+Alt+Space` → `transport.playStop`;
  - `Control+Alt+Return` → `transport.again`;
  - `Control+Alt+L` → `transport.loop`;
  - media keys `MediaPlayPause` → `transport.playStop`, `MediaNextTrack` → `transport.nextSection`, `MediaPreviousTrack` → `transport.again`, `MediaStop` → `transport.stop`.
- Each fires `webContents.send('desktop:command', {id, source:'global'})`.
- Register on `whenReady` (from prefs) and on toggle. `globalShortcut.unregisterAll()` on disable and on `will-quit`.
- `register` returns false when the OS or another app owns the combo. Report it in `failed`, and Settings shows "⌃⌥Space is used by your system" per item.
- **Known conflict:** macOS binds ⌃⌥Space to "Select next source in Input menu" by default. Expect `failed` there and surface it; do not silently pick another combo.
- macOS media keys through `globalShortcut` need Accessibility trust. Check `systemPreferences.isTrustedAccessibilityClient(false)` and show "Allow Woodshed in System Settings → Privacy & Security → Accessibility" with a button that calls `isTrustedAccessibilityClient(true)`.
- Commands from `source:'global'` run even when the window is unfocused. The renderer must not steal focus or show overlays for them. The HUD updates normally.
- Web Audio does not create a Chromium Media Session by itself (spec R2), so in Electron the media keys come from `globalShortcut`, not `navigator.mediaSession`.

### 16.8 Native notification on job completion (spec §3.5)
- The permission handler denies renderer notifications (main.cjs:109). Use the **main-process** `Notification`.
- **Bridge:** `notify({title, body, route})` (invoke, trusted). Validate: `title` ≤ 120, `body` ≤ 240, `route` a same-origin path matching `^/(s|edit)/[A-Za-z0-9_-]{1,64}`. Main shows the notification **only when `!window.isFocused()`** (main decides; the renderer may be stale).
  - Click → `window.show(); window.focus(); webContents.send('desktop:navigate', route)`.
  - **Bridge:** `onNavigate(cb) → off`. The router pushes `route`.
- **Trigger** (renderer, `listActive` diff): a `separate` or `import` job leaves `running` and its song appears in `songs.list` → `notify({title: 'Woodshed', body: '<Title> is ready to practise', route: '/s/<songId>'})`.
  - The renderer lives as long as the app (closing the window quits, main.cjs:186), so no main-side Convex client is needed.
  - Chained beats completion does not notify.
  - Failures notify only when not caused by a cancel: "Couldn't add <title>", route `/` (opens the Jobs popover).
- **Opt-out:** `settings.notifyReady` (account setting, default true, in `DEFAULT_SETTINGS`), under Settings → Processing "Notify when songs are ready".
- **Windows:** call `app.setAppUserModelId('com.kylekincer.woodshed')` (electron-builder.yml `appId`) early in `whenReady`, or toasts do not appear in dev or unpacked builds.
- **macOS:** works for the signed app. In dev the notification is attributed to "Electron".
- **Linux AppImage:** needs libnotify. If `Notification.isSupported()` is false, skip silently.

### 16.9 Window size and position memory (spec §6.5)
- **File:** `userData/window-state.json` = `{x, y, width, height, maximized, fullScreen, displayId}`.
- **Save:** debounced 500 ms on `resize`, `move`, `maximize`, `unmaximize`, `enter-full-screen`, `leave-full-screen`, and synchronously in `close` before the quit guard (main.cjs:111). Store `getNormalBounds()` so a maximized window restores to its pre-maximize size.
- **Restore** (main.cjs:105):
  - use the saved bounds only if they intersect some display's `workArea` (`screen.getAllDisplays()`) by at least 100×100 px; otherwise centre the default 1280×850 on the primary display;
  - clamp to `minWidth/minHeight` 640×480;
  - apply `maximize()` or `setFullScreen(true)` after `ready-to-show`.
- No dependency: about 40 lines, in a new `desktop/window-state.cjs` with a `node --test` unit test (`desktop/window-state.test.cjs`, picked up by `test:desktop`) using a fake `screen`.
- **Full screen suggests Focus once:** main sends `desktop:fullscreen {on}` on `enter-full-screen`/`leave-full-screen` (bridge `onFullScreen(cb)`). The renderer shows the one-time "Use Focus for a cleaner stage? [Focus]" suggestion (stored as a per-device convenience in `ws.prefs`). This is a feature hint, not upgrade ceremony.

### 16.10 Quit guard flush, and update prompts while playing
- **Flush:** spec §6.5 says the quit guard "flushes the practice save". Today nothing flushes (main.cjs:111-116), and debounced `saveTempo`/`savePractice` writes can be lost on quit.
  - Bridge: `onFlushRequest(cb)`, where `cb` returns a promise. Main sends `desktop:flush` and awaits `ipcMain.once('desktop:flushed')` with a **3 s timeout**.
  - Run it after the busy dialog's Quit decision, **and** in `install()` before `stopCompanion(true)` (main.cjs:78).
  - The renderer's flush runs every pending debounced save immediately and awaits the Convex mutations.
  - Keep the dialog copy unchanged (spec §6.5).
- **Activity:** `setActivity({playing: boolean, songOpen: boolean})` (send, trusted). It is used by:
  - the update controller (defer automatic prompts while `playing`; re-prompt on stop, §14 change 2);
  - the menu (enable Close Song);
  - optionally the quit guard (no extra prompt needed).

### 16.11 Final bridge contract (`desktop/preload.cjs`)
| Method | Channel | Direction | New? |
|---|---|---|---|
| `info() → {version, platform, companion:{port, token}\|null, update, processor}` | `desktop:info` | invoke | extended |
| `update('show')` | `desktop:update` | invoke | — |
| `onUpdate(cb)` | `desktop:update-state` | main → r | — |
| `onOpenUpdates(cb)` | `desktop:open-updates` | main → r | — (menu item) |
| `setTheme(theme)` | `desktop:theme` | invoke | — |
| `mediaUrl(url)` | `desktop:media-url` | invoke | — |
| `onProcessorState(cb)` | `desktop:processor-state` | main → r | **new** |
| `restartProcessor() → {port, token}` | `desktop:restart-processor` | invoke | **new** |
| `registerMenu(spec)` | `desktop:menu` | send | **new** |
| `onCommand(cb)` | `desktop:command` | main → r | **new** |
| `setActivity({playing, songOpen})` | `desktop:activity` | send | **new** |
| `setBackgroundShortcuts(enabled) → {registered, failed, accessibility?}` | `desktop:global-shortcuts` | invoke | **new** |
| `notify({title, body, route})` | `desktop:notify` | invoke | **new** |
| `onNavigate(cb)` | `desktop:navigate` | main → r | **new** |
| `onFlushRequest(cb)` | `desktop:flush` / `desktop:flushed` | main → r → main | **new** |
| `onFullScreen(cb)` | `desktop:fullscreen` | main → r | **new** |

- Every `on*` returns an unsubscribe function (pattern at preload.cjs:3, 8). Every handler checks `trusted(event)`.
- The fixture fake (`tests/fixture/preamble.js:12-20`) gains no-op versions of each, plus `mediaUrl`, which it lacks today.
- The renderer feature-detects each method, so the web build and fixture never break.

### 16.12 Deletions (no compatibility layer)
- **Header update icon:** `desktop-client.js:5-20` and its insertion at :34-40. Replaced by the avatar dot (spec §6.5).
- **Update-channel processor error:** main.cjs:57. Moved to `processor-state`.
- **Dead regexes** in `friendlyError` (library.js:303-305) and the whole regex mapping, replaced by `errorCode` (§10.2).
- **Stale copy:** "Retry the desktop connection in Settings" (companion.js:30, 38) and "Run npm run companion:setup first." in packaged builds (server.mjs:99).
- **Stale Modal-era comments:** jobs.ts:138-142; worker.ts header comments; schema.ts:153-154, 173; backend.js:1-7, 151-157; presets.ts:1-7 (`estCostUsd`); player.js:943-944.
- **`sessionStorage.removeItem('ws.companion')`** (companion.js:8). It is a one-off cleanup, already run.
- **`settings.format`** (process.py:15 makes it inert).
- **`showDesktopSetup` gating** (spec §9.6; shell.md §13.2).
- **Optional (§14 change 3):** `cancelForUpdate` + `update-cancellation.json`.
- **Unchanged and still read** (stored data): `library.json` legacy import, `imports.json`, `connection.json`, `appearance.json`, old `jobs` rows (every new field optional), `devices` rows without `displayName`/`revokedBy`.

### 16.13 Tests to add
- **`convex/jobs.test.ts` / `worker.test.ts` / `devices.test.ts` (convex-test):**
  - createSeparation device ownership and the 20 limit;
  - upload re-split routed to `originDeviceId`;
  - listActive bounded per status and with the new fields;
  - retry resets stage;
  - bot-check auto-retry schedule and the attempts cap;
  - `finish` chains beats only when `autoBeats && !hasRealMap`;
  - `worker.next` prefers beats;
  - `beatsDone` writes `songMap.origin:'detected'` only when unmapped and bumps `tempoRev`;
  - `saveTempo` stale-rev merge;
  - `createBeatDetection` dedupe;
  - heartbeat upsert and `devices.list` shape;
  - admin-revoked device cannot re-pair;
  - user revoke re-pairs.
- **`desktop/window-state.test.cjs`:** off-screen restore, maximized, min size.
- **`desktop/menu.test.cjs`:** template validation (rejects bad ids, accelerators, depth); plain-key accelerators are not registered; ⌘W disabled without a song.
- **`desktop/update-controller.test.cjs`:** playing defers automatic prompts; the stop transition re-prompts.
- **Python:**
  - error-code classification on recorded yt-dlp, ffmpeg and separator outputs;
  - first-run download lines don't count as passes;
  - `mdx_extra` pass count;
  - `six` never reaches `expected_stems`;
  - beats `localMix` path.
- **Node (companion):** extract `ytDlp`, candidate mapping and the LRU into `companion/lookup.mjs` so `node --test` can run them without Convex.
- **Fixture:** XHR upload progress; `/resolve` and `/search` mocks; every job state including beats, import, `bot_check` auto-retry pending and an offline device (spec §9.8).

---

## 17. Risks
1. **Smoke test DOM coupling:** `#app-header` must exist and `#sidebar` must not (main.cjs:121-122). Release CI fails on the new shell until these are updated.
2. **Presence write amplification:** heartbeats on the `devices` row would re-run every `worker.next` subscription each minute. Use the separate `devicePresence` table (§16.2).
3. **Server-written maps vs. an open Stage:** without the `tempoRev` guard, a click-volume change in an open Stage clobbers a freshly detected map (§16.3).
4. **`expected_stems` silently maps unknown modes to a drums split** (pipeline.py:349). Any new stem mode must be normalised before Python.
5. **macOS ⌃⌥Space conflict** and the Accessibility requirement for media keys (§16.7).
6. **Menu accelerators stealing plain keys** from inputs. Register only modifier combos (§16.6).
7. **Permission handler denies everything** (main.cjs:109): notifications (use main), Web MIDI P2 (needs `midi`/`midiSysex` allowed for `UI_ORIGIN`), wake lock (`screen-wake-lock` is not a permission prompt in Chromium, but verify), clipboard-read for ⌘V prefill (allow `clipboard-read` for `UI_ORIGIN`, or read through IPC `clipboard.readText()`).
8. **Local disk growth:** uploads and job dirs (with WAV stems) are never cleaned (§16.4 item 11).
9. **`job.meta`, `attempts` and `resolvedUrl` look implemented but are not** (schema.ts:177-183; process.py:70-77). Do not build UI on them before §16.4 and §16.1 land.
10. **`desktop/decoded-stem-cache.test.cjs` imports `src/js/decoded-stem-cache.js`.** Moving that module breaks `test:desktop`.
11. **B4 latency:** each frozen `--module yt_dlp` spawn pays PyInstaller and yt-dlp start-up (estimated 1–3 s, not yet measured). The identity recheck adds a Convex round trip if the routes sit after server.mjs:189.
12. **Spotify oEmbed titles may lack the artist** (pipeline.py:184). Candidate confirmation (B4) is the mitigation. Unconfirmed searches carry `needsReview`.
