# Shell and library map (Woodshed 1.9.0 → 2.0 "Stage")

Research document for the 2.0 rebuild (`docs/ux2/spec.md`). It maps the app shell, the library, adding songs, jobs, sharing, settings, billing, admin, desktop and companion integration as they exist at commit `e229f2c` (v1.9.0). Every claim carries a `file:line` reference. No source files were changed.

**Owner decisions applied throughout:** the spec's recommendations are accepted, and there are **no users to protect**. Nothing below proposes Classic keys, key-change hints, a "What's changed" sheet, "new" badges, rollout flags or a lingering legacy CSS layer. Data the owner already has is still read correctly: `songs.practice` v1, the 13 `ws.*` keys and legacy maps get a cheap one-way upgrade with no UI ceremony.

**Scope.** In scope: `index.html`, `public/theme-init.js`, `src/js/app.js`, `library.js`, `backend.js`, `auth.js`, `startup.js`, `companion.js`, `desktop.js`, `desktop-client.js`, `download-release.js`, `shared-song.js`, `share-dialog.js`, `export.js`, `billing.js`, `settings.js`, `admin.js`, `modal-focus.js`, `feedback.js`, `interactions.js`, `motion.js`, `preferences.js`, `artwork.js`, `media-fetch.js`, `stemcache.js` and `decoded-stem-cache.js`. Also `desktop/preload.cjs`, the relevant parts of `desktop/main.cjs` and `companion/server.mjs`, and the Convex functions the client calls.

Other maps own player, engine, metronome, waveform, notation, map-mode, tempo-*, song-map and song-metadata. The leftover small modules are listed in §26 with their owners.

---

## 1. Module inventory

| File | Lines | Role | Imported by | 2.0 fate (spec §9.2 / §9.6) |
|---|---|---|---|---|
| `index.html` | 140 | Static DOM skeleton: header, 4 views, startup status, add modal, drop overlay, sign-in gate | Vite entry | Rewritten. It keeps only `<div id="app">`, the startup status and the sign-in mount. |
| `public/theme-init.js` | 36 | Pre-paint theme and library layout. Defines `window.woodshedAppearance`. Syncs native theme. | `index.html:12` (sync, in `<head>`) | Kept and extended: a Stage-always-dark attribute and `ws.prefs` reading (§8). |
| `src/js/app.js` | 105 | Route dispatch, boot, `showView`/`openSong`, codec banner | Vite module entry `index.html:138` | Becomes `src/app/main.js` + `router.js` |
| `src/js/startup.js` | 32 | `data-startup` state machine; waits for a settled auth snapshot | `auth.js:1`, `app.js:2`, `shared-song.js:5` | Keep (small, tested by `tests/startup.test.js`) |
| `src/js/auth.js` | 222 | Convex clients, AuthClient, sign-in card, suspension gate, account menu, fatal screen | app, backend, companion, billing, admin, share-dialog, shared-song, notation/store | Keep the auth core. The account menu moves to `src/ui` and the sign-in card is rebuilt (§6.6). |
| `src/js/backend.js` | 236 | Thin wrappers over Convex functions; signed-URL cache; add-song orchestration | library, settings, player, song-metadata, export | Keep (spec: "thin additions"). Delete dead `listLibrary` and `renameSong`. |
| `src/js/companion.js` | 65 | Local processor HTTP client and pairing (`devices.pair`) | backend, library, settings, desktop-client | Keep and add status/retry state for the Jobs chip. |
| `src/js/library.js` | 690 | Library grid/list, search, grouping, add modal, uploads, global drop, jobs overlay, card menu, selection, `confirmModal`, reprocess dialog | app | Replaced by `src/library/*` |
| `src/js/desktop.js` | 97 | `showDesktopSetup()` native `<dialog>`; `/download` page renderer | companion, library, app | The download page is kept and restyled. `showDesktopSetup` gating is deleted (§9.6). |
| `src/js/desktop-client.js` | 56 | Header update icon, update-state wiring, local-processor init | app (dynamic import, desktop only) | The header icon is deleted (avatar dot instead). Init moves to `platform.js`. |
| `src/js/download-release.js` | 36 | Platform detection and GitHub release normalisation | desktop | Keep (tested by `tests/downloads.test.js`) |
| `src/js/shared-song.js` | 78 | `/share/:token` boot path | app | Becomes the Shared Stage boot (spec §4.13). It keeps its own boot path. |
| `src/js/share-dialog.js` | 25 | Owner share dialog | library, player | Rebuilt on the Dialog primitive (§6.1) |
| `src/js/export.js` | 57 | Streaming ZIP export | settings, billing | Keep. Only Settings → Plan & storage calls it. |
| `src/js/billing.js` | 81 | Plan & billing view | app | Becomes `src/settings/plan.js` |
| `src/js/settings.js` | 260 | Settings view | app | Becomes `src/settings/*` (one module per section) |
| `src/js/admin.js` | 66 | Admin view | app | Becomes `src/settings/admin/*` |
| `src/js/modal-focus.js` | 29 | Focus trap for `div.modal` overlays | library, song-metadata, notation/editor | Deleted (§9.6). Replaced by native `<dialog>` primitives. |
| `src/js/feedback.js` | 35 | `notify()` toast and `withButtonProgress()` | settings, billing | Replaced by `src/ui/toast.js`, `status.js` and button busy state |
| `src/js/interactions.js` | 38 | Blur-after-pointer hack; `isPointerControl` | app, player, notation/editor | Deleted (§9.6). The dispatcher owns Space. |
| `src/js/motion.js` | 29 | View Transitions wrapper | app, library | Keep or fold into the router |
| `src/js/preferences.js` | 12 | Theme `<select>` markup; `ws.stopBehavior` | settings, desktop, shared-song, player | Folded into `src/app/prefs.js` |
| `src/js/artwork.js` | 42 | Deterministic fallback sleeves; cover markup/hydration | library, player, song-metadata | Keep |
| `src/js/media-fetch.js` | 6 | Routes media fetches through the desktop proxy | stemcache, export | Keep |
| `src/js/stemcache.js` | 138 | Cache API stem cache, size/clear, Opus probe, codec error copy | engine, settings, app, player | Keep. Fix the stale FLAC copy (§3.6). |
| `src/js/decoded-stem-cache.js` | 43 | In-memory AudioBuffer LRU | stemcache, engine | Keep |

---

## 2. Boot sequence

### 2.1 Before any module runs
1. `index.html:2` starts with `<html data-startup="loading">`. CSS keys the skeleton and status pill off this attribute.
2. `public/theme-init.js` runs synchronously in `<head>` (`index.html:12`). It:
   - sets `data-startup="download"` on `/download` (`theme-init.js:3`);
   - reads `ws.view` JSON and sets `data-library-layout` (grid/list) so the 8-card skeleton (`index.html:72`) has the right geometry (`:4`);
   - reads `ws.theme` (system/light/dark), applies `data-theme` and `color-scheme`, and rewrites `<meta name="theme-color">` (`:5-17`);
   - exposes the frozen `window.woodshedAppearance` `{preference, set(value)}` (`:19-26`);
   - calls `window.woodshedDesktop?.setTheme(preference)` on every apply (`:18,35`);
   - registers listeners: system `change`, window `storage`, document `change` for `[data-theme-choice]`, and `DOMContentLoaded` (`:27-34`).
3. Seven stylesheets load in order: styles, record-club, motion, download, theme, sharing, tempo-map (`index.html:13-19`). Feature CSS is imported by JS: `tempo-sources.css` (player.js:11), `chart.css`, `notation.css`, `score-view.css` and `song-metadata.css`.
4. `#app-header` and `#content` start `inert` (`index.html:26,40`). Only `finishStartup()` removes it (`startup.js:13-14`).

### 2.2 Module evaluation side effects (all routes, including `/download` and `/share/*`)
- `companion.js:8` runs `sessionStorage.removeItem('ws.companion')`, a one-off cleanup of a legacy credential.
- `decoded-stem-cache.js:39-43` sizes the cache: 128 MB when `deviceMemory ≤ 4` or `pointer: coarse`, otherwise 512 MB.
- `app.js:17` `initializeInteractions()` installs the 6 document listeners (§10) on **every** route.
- The static import graph of `app.js` pulls in `player.js` (and so the engine, metronome, map-mode and notation launcher) and `library.js` even for `/download`. Only `desktop-client.js` is dynamically imported (`app.js:91`).

### 2.3 Route dispatch (`app.js:103-105`)
```
/download      → renderDownload()      (desktop.js:13; replaces <body>)
/share/*       → renderSharedSong()    (shared-song.js:8)
anything else  → boot()                (app.js:63)
```

### 2.4 `boot()` (`app.js:63-101`)
| Step | Line | What happens |
|---|---|---|
| 1 | 64-66 | 12 s timer adds `.is-slow` to `#startup-status`, which reveals "Taking longer than expected? Retry" (`location.reload()`). Spec wants 8 s with "Still connecting… [Retry]" (§2.7). |
| 2 | 68 | `ensureSignedIn()` → `auth.initialize()` (memoised in `boot ??=`, `auth.js:17-19`), §7 |
| 3 | 70-73 | In parallel: `admin.access` and `settings.config` (once; **never subscribed**) |
| 4 | 74 | `mountUserButton({admin, navigate: showView})` |
| 5 | 75 | `initSettings(config)` stores the shared `config` object. Settings mutates `config.settings` in place, which the add modal reads. |
| 6 | 76-78 | Click handlers on every `[data-view]` present now: `#header-back` and `.brand-home`, both `data-view="library"` (`index.html:28,31`) |
| 7 | 79 | `await initLibrary(config, openSong)` resolves on the **first complete render**, after both `songs.list` and `jobs.listActive` have delivered (`library.js:42-67,110,187`). Subscription errors reject it. |
| 8 | 80 | Codec banner if `likelySupportsOpus()` is false (`app.js:50-61`) |
| 9 | 81 | `/billing` → `showView('billing')` (Stripe return URLs) |
| 10 | 82 | `document` `woodshed:billing` → `showView('billing')` (fired by settings.js:164) |
| 11 | 83 | `/admin` and admin → `showView('admin')`. Non-admins silently get the Library. |
| 12 | 84 | `finishStartup()` hides sign-in, sets `data-startup=ready`, removes `inert`, removes `#startup-status` (`startup.js:10-16`) |
| 13 | 85-89 | `?song=<id>` → `songs.get` → `openSong(song)`. An invalid id fails `v.id` validation and is caught as `null`. **The param is never removed**, so a reload reopens the song. |
| 14 | 90-93 | Desktop only: `import('./desktop-client.js')` → `initializeDesktop()`. Pairing starts **after** the library is visible (§11.3). |
| err | 94-97 | Unless `data-startup=signin`: `showFatal('Couldn't open Woodshed', 'Check your connection and try again. ' + raw message)`. The raw Convex message is shown to the user. |

**`data-startup` values:** `loading` (`index.html:2`, `startup.js:3`), `signin` (`startup.js:7`), `ready` (`startup.js:12`) and `download` (`theme-init.js:3`).

### 2.5 `showView(name)` and `openSong(song)` (`app.js:21-46`)
- `showView` runs inside `transitionView` (View Transitions; skipped under reduced motion, `motion.js:16`). It:
  - toggles `.view.active`;
  - toggles the dead `.nav-btn` (`app.js:25`; no such element exists);
  - toggles `body.in-player`;
  - moves focus to `.brand-home` if `#header-back` had focus;
  - calls `closePlayer()` for any non-player view;
  - **re-renders the target view on every entry**: billing re-subscribes, admin re-fetches, settings rebuilds its whole DOM, library re-renders (`app.js:28-32`).
- `openSong` resets `#content.scrollTop`, activates `#view-player`, adds `body.in-player`, and calls `openPlayer(song)` without awaiting it (`app.js:36-46`).
- **No URL is written anywhere** in the main app. The only History API call in the client is `history.replaceState` in shared-song.js:39. The OAuth library also calls `replaceState` (§7.2).

---

## 3. Routing today, and what the router must honour

### 3.1 Inbound paths and params
| URL | Handled at | Behaviour |
|---|---|---|
| `/download` | app.js:103, theme-init.js:3 | Marketing/download page; no auth |
| `/share/<64 hex>` (optional trailing `/`) | app.js:104, shared-song.js:9 | Public shared song. Any other `/share/*` shape renders "Song unavailable" (`shared-song.js:44`). |
| `/share/<token>?save=1` | shared-song.js:54-58,70-74 | Forces sign-in, then auto-saves to the library |
| `/billing` | app.js:81 | Opens Plan & billing after boot |
| `/billing?checkout=success` | convex/billing.ts:78 (Stripe `successUrl`) | Treated as `/billing`; **`checkout=success` is ignored** |
| `/admin` | app.js:83 | Admin view if `admin.access` is true |
| `/?song=<songId>` | app.js:85-89 | Opens the song after boot. Produced by shared-song.js:33 ("Open in library"). |
| `/?convexAuthCode=…` / `?convexAuthError=…` | `@convex-dev/auth` `oauth/client.js:155-180` | OAuth callback. The library strips its params with `history.replaceState(history.state, …)` before the first await. |
| `/oauth/callback?…` (desktop only) | desktop/main.cjs:35-39 | The Electron static server reloads the window at `UI_ORIGIN + '/?' + params`. **The original path is lost on desktop** (always `/`). |
| any other path | app.js:105 | Boots the Library (no 404) |

### 3.2 URLs the app or backend produce
- Share link: `https://woodshed.kylekincer.com/share/${token}`, **hard-coded host** (`share-dialog.js:14`). Spec §6.1 replaces it with `VITE_SHARE_ORIGIN`.
- Stripe: portal `returnUrl` `${BILLING_SITE_URL}/billing` (convex/billing.ts:40,49,58,68). Checkout `successUrl` `/billing?checkout=success`, `cancelUrl` `/billing` (`:78`). Spec redirects `/billing` → `/settings/plan`. Keep the redirect and use the `checkout=success` flag (§20).
- OAuth `redirectTo` (`auth.js:143`): on desktop, `origin + '/oauth/callback'`; on web, `origin + pathname + search`, so web sign-in returns to the same place (this matters for `/share/<t>?save=1` and any `/s/:id` deep link).
- In-app links: `/download` (auth.js:195), `/` (desktop.js:18,49; shared-song.js:13,18), `/?song=` (shared-song.js:33), `/share/${token}?save=1` (shared-song.js:34).

### 3.3 Hosting constraints on a History router
- **Web (Vercel):** `/(.*)` → `/index.html` rewrite, except `/api/downloads` (`vercel.json`). Any path deep-links fine. CSP `connect-src` allows only `http://127.0.0.1:47831` locally, plus Convex/R2. `font-src 'self' data:`, so fonts must be self-hosted. `/share/(.*)` gets `noindex` and `no-store`.
- **Desktop (Electron static server, desktop/main.cjs:30-50):** serves `index.html` for every path that is not under `/assets/` or in the 5-file allow-list (`main.cjs:41`: `/theme-init.js`, `/woodshed-icon.svg`, `/favicon-32.png`, `/apple-touch-icon.png`, `/downloads.json`). Consequences:
  - Fonts, the PWA manifest and new icons **must** be emitted under `/assets/` by Vite (import them from CSS/JS) or be added to the allow-list. A file in `public/fonts/` would be served as `index.html`.
  - CSP is set per response (`main.cjs:44`): `connect-src 'self' http://127.0.0.1:* https://*.convex.cloud wss://*.convex.cloud https://*.convex.site https://*.r2.cloudflarestorage.com`.
- **Electron navigation:** `will-navigate` to another origin is cancelled and opened externally (`main.cjs:107`). `setWindowOpenHandler` denies every `window.open`/`target=_blank` and calls `openExternal`, **which only allows `https:`** (`main.cjs:106,108`). In the desktop app, "open `/download` in a new tab" (spec §1.2) and any same-origin new-tab link **silently do nothing**. Same-origin links must navigate in place, or be hidden on desktop.
- **Router consequences:**
  - (a) Parse the route only after `auth.init()`, or ignore `convexAuthCode`/`convexAuthError`, since the auth library strips them itself.
  - (b) On desktop, sign-in always lands on `/`. To restore a pre-sign-in place, stash it in `sessionStorage` before `signIn`.
  - (c) Legacy `/?song=X` → `/s/X` and `/billing` → `/settings/plan` via `replaceState`; no UI ceremony.

---

## 4. DOM skeleton (`index.html`) and its consumers

| Element | Line | Consumers |
|---|---|---|
| `#deps-banner` | 24 | app.js:51-61 (codec banner; CSS offsets `left:210px` for a removed sidebar, per inventory §0) |
| `#app-header[inert]` | 26 | startup.js:14; shared-song.js:13-14 rewrites `.header-home` and `.header-actions` |
| `#header-back[data-view=library]` | 28 | app.js:22,76 |
| `.brand.brand-home[data-view=library]` | 31 | app.js:27,76 |
| `#header-song` | 33 | player.js:208,226 (song title/cover/edit/share in the header) |
| `#add-btn` | 35 | library.js:535 |
| `#user-button` | 36 | auth.js:154,201; desktop-client.js:39 (update icon inserted before it) |
| `#content[inert]` | 40 | app.js:38; startup.js:13 |
| `#view-library` (`.view.active`) | 42 | library.js:190 |
| `#group-seg [data-group]` | 46-50 | library.js:76-88 |
| `#layout-seg [data-layout]` | 51-67 | library.js:77-88 |
| `#lib-search` | 68 | library.js:50,500; app.js:32 |
| `.library-selection.startup-selection` | 71 | library.js:672-675 (placeholder until wired) |
| `#library-grid` (8 skeleton cards) | 72 | library.js:112,141,673 |
| `#library-empty` with `[data-add]` | 73-76 | library.js:113,153,535 |
| `#view-player > #player-root` | 80-82 | player.js:223; shared-song.js:16 |
| `#view-billing > #billing-root` | 84 | billing.js:11 |
| `#view-admin > #admin-root` | 85 | admin.js:15 |
| `#view-settings > #settings-root` | 88-91 | settings.js:26 |
| `#startup-status` with `#startup-retry` | 94 | app.js:64-66; startup.js:15 |
| `#add-modal` with `#add-url`, `#file-drop`, `#add-pick`, `#add-file-input`, `#add-preset`, `#add-stemmode`, `#add-preset-desc`, `#add-cancel`, `#add-go` | 97-124 | library.js:504-569 |
| `#drop-overlay` | 127 | library.js:605-624 |
| `#signin > .signin-inner > #signin-mount` and the theme `<select data-theme-choice>` | 130-136 | auth.js:97,207; startup.js:4-11; shared-song.js:57; theme-init.js:15,31 |

---

## 5. Convex functions called by the client

All calls use `anyApi` (untyped). auth.js:9 is the exception: it imports the generated `api` for auth functions. "Sub" means `convex.onUpdate`. Unless noted, functions run on the authenticated `ConvexClient` exported as `convex` (auth.js:12,33).

### 5.1 Auth and session
| Function | Kind | Args | Call site | Notes |
|---|---|---|---|---|
| `auth.refreshSession` | mutation | `{refreshToken}` | auth.js:39 | Via a separate `ConvexHttpClient` transport (auth.js:32) |
| `auth.signOut` | mutation | `{refreshToken}` | auth.js:40 | Same transport |
| `auth.startSignInGoogle` / `auth.completeSignInGoogle` | mutation/action | (library) | auth.js:139-143 | Ambient OAuth sign-in |
| `users.me` | query | `{}` | auth.js:71 | Returns `{id, status, name?, email?, picture?}`; `status` ∈ `active \| export_only \| suspended` (convex/users.ts:28-43) |
| `users.me` | **sub** | `{}` | auth.js:86 | Live suspension check; **never unsubscribed** (app lifetime) |
| `admin.access` | query | `{}` | app.js:71 | Boolean |
| `settings.config` | query | `{}` | backend.js:18 ← app.js:71, export.js:36 | `{settings, presets, defaultPreset, models, stemModes, bitrates}` (convex/settings.ts:17-37). **One-shot**: changes from another device are not seen until reload. |

### 5.2 Library and songs
| Function | Kind | Args | Wrapper → callers | Notes |
|---|---|---|---|---|
| `songs.list` | **sub** | `{}` | `backend.onLibrary` (backend.js:33) ← library.js:54 | `{songs: toClient[]}`, newest first, **`take(1000)`** (convex/songs.ts:21-34). Every song carries full `tempo` and `practice` blobs, so every `savePractice` re-sends the whole list (spec R3, B1). |
| `songs.list` | query | `{}` | `backend.listLibrary` (backend.js:27) | **Dead**, no callers |
| `songs.get` | query | `{id}` | app.js:87 | Deep link `?song=` |
| `songs.get` | **sub** | `{id}` | `backend.onSong` (backend.js:227) ← player.js:247 | Header refresh while open |
| `songs.rename` | mutation | `{id,title}` | `backend.renameSong` (backend.js:41) | **Dead** (deleted in Phase 0, §9.4) |
| `songs.remove` | mutation | `{id}` | `backend.deleteSong` (backend.js:57) ← library.js:450 | Single-song only. Cancels live jobs, deletes the notation part and retires keys (convex/songs.ts:98-118). **There is no bulk mutation**: spec bulk delete (§2.6) means N separate transactions, so partial failure is possible. |
| `songs.saveTempo` | mutation | `{id,tempo}` | backend.js:46 ← player.js:840,1027 | Player map |
| `songs.savePractice` | mutation | `{id,practice}` | backend.js:219 ← player.js:1018,1027 | Player map. v1 shape `{loop, rate, grid, tracks}` (player.js:1014). |
| `songs.exportPage` | query | `{paginationOpts:{numItems:50,cursor}}` | backend.js:222 ← export.js:13 | |
| `metadata.update` | mutation | `{ids,changes}` | backend.js:226 ← song-metadata.js:350 | Bulk-capable (`ids[]`) |
| `metadataLookup.find` | action | `{id,title,artist,recordingId?}` | backend.js:228 ← song-metadata.js:210 | |
| `metadataLookup.detail` | action | `{id,recordingId,releaseId?}` | backend.js:229 ← song-metadata.js:249 | |
| `artworkUpload.prepare` → PUT → `artworkUpload.complete` | action ×2 | `{id,bytes,mime,checksum}` then `{objectId}` | backend.js:230-236 ← song-metadata.js:344 | SHA-256 checksum header on the PUT |
| `media.signKeys` | action | `{keys}` | backend.js:93 (cached 6 h, 5 min margin, backend.js:73-100) ← library.js:138, export.js:43, player.js:282 (and `signKey` ← player.js:234) | Server TTL 21600 s (convex/media.ts:32). The library signs **every visible cover in one call** (up to 1000 keys). |
| `storage.usage` | query | `{}` | `backend.cloudUsage` (backend.js:218) ← settings.js:166 | `{usedBytes, limitBytes, appFull}` |
| `notation.get` | query | `{songId}` / `{token}` | backend.js:220-221 ← export.js:39, player.js:882 | Notation map owns the rest (`notation/store.js`) |
| `tempoSources.search` / `.load` | action | args / `{id}` | backend.js:50,54 ← player.js:915,917 | Tempo map |

### 5.3 Jobs and devices
| Function | Kind | Args | Wrapper → callers | Notes |
|---|---|---|---|---|
| `jobs.listActive` | **sub** | `{}` | `backend.onJobs` (backend.js:38) ← library.js:60 | Last 50 jobs by user with status in `queued \| running \| error` (convex/jobs.ts:10-37). Row: `{jobId, kind, songId, label, status, stage, percent, message, error, meta}`. The **library keeps only `kind==='separate'`** (library.js:62), so `beats` and `import` jobs are invisible. |
| `jobs.get` | **sub** | `{jobId}` | inside `backend.detectBeats` (backend.js:192) | Unsubscribes on done/error/canceled. **Leaks if the job never terminates**, and there is no timeout. |
| `jobs.createSeparation` | mutation | `{source?, deviceId, settings, label, replaceSongId?}` | `addSong` (backend.js:127-136), `reprocessSong` (:139-147), `addFiles` (:162-179) | Always returns `{jobId, songId:null}` (convex/jobs.ts:107). The "dedupe → songId" comments in backend.js:122-126,174-175 are **stale**. Server limits: 20 queued per device, label ≤ 500, source ≤ 2000 (convex/jobs.ts:85-87). |
| `jobs.createBeatDetection` | mutation | `{songId, deviceId}` | backend.js:189 ← player.js:958 | |
| `jobs.cancel` | mutation | `{jobId}` | backend.js:62 ← library.js:376 | **Promise not awaited and errors not handled** |
| `jobs.dismiss` | mutation | `{jobId}` | backend.js:66 ← library.js:391 | Throws "Cancel the job first." for live jobs (jobs.ts:164). Unhandled. |
| `jobs.retry` | mutation | `{jobId, deviceId}` | backend.js:224 ← library.js:383 | Requires the **same** device: "Retry from the original processing computer." (jobs.ts:175). Error shown with `alert()`. |
| `devices.pair` | mutation | `{tokenHash, name}` | companion.js:58 | `requireWritableUserId`, so **export-only accounts cannot pair**. **Re-pairing un-revokes a device** (`patch revoked:false`, convex/devices.ts:24-27), which undoes an admin "Revoke" the next time that desktop launches. |
| `devices.revoke` | mutation | — | **not called by the client** | Users cannot unpair their own computers (only admins, via `admin.revokeDevice`) |

### 5.4 Sharing
| Function | Kind | Args | Call site | Notes |
|---|---|---|---|---|
| `sharing.status` | query | `{id}` | share-dialog.js:24 | `{token, includeNotation}` or null |
| `sharing.create` | mutation | `{id, includeNotation?}` | share-dialog.js:18 (create) and :22 (toggle notation on an existing link) | Returns `{token}` |
| `sharing.revoke` | mutation | `{id}` | share-dialog.js:23 | |
| `sharing.view` | **sub** on an unauthenticated client | `{token}` | shared-song.js:45 | Second `ConvexClient` (shared-song.js:24); closed on `pagehide` |
| `sharing.view` | query (unauthenticated) | `{token}` | shared-song.js:72 | Validates before an auto-save |
| `sharing.saved` | **sub** (authenticated) | `{token}` | shared-song.js:63 | `{songId, status:'copying'\|…}` |
| `shareAudio.playback` | action (unauthenticated) | `{token}` | shared-song.js:51 (`resolveUrls` for the player) | Returns key → URL |
| `shareAudio.save` | action | `{token}` | shared-song.js:37 | Returns the new songId; errors read from `error.data` |

### 5.5 Billing and admin
| Function | Kind | Args | Call site |
|---|---|---|---|
| `billingData.status` | **sub** | `{}` | billing.js:77 (re-subscribed on every view entry and **never unsubscribed** when leaving). Returns `{enabled, access:'free'\|'paid'\|'grace', status, interval, periodEnd, cancelAtPeriodEnd, graceEndsAt, hasCustomer, cleanupPending, usedBytes, limitBytes, freeBytes, proBytes, monthlyCents, annualCents}` (convex/billingData.ts:26-33). The UI **hard-codes prices** (`$2`, `$20`, `$1.67`, "Save $4", billing.js:22,35-36) instead of using `monthlyCents`/`annualCents`. |
| `billing.checkout` | action | `{interval}` | billing.js:61 → `location.assign(url)` |
| `billing.portal` | action | `{}` | billing.js:63; auth.js:79 (suspended screen) |
| `admin.overview` | query | `{}` | admin.js:18 |
| `admin.accounts` | query | `{paginationOpts:{cursor,numItems:25}, email?}` | admin.js:45 |
| `admin.account` | query | `{id}` | admin.js:54 |
| `admin.history` | query | `{paginationOpts}` | admin.js:30 |
| `admin.updatePolicy` | mutation | `{userBytes, appBytes, reason}` | admin.js:23 via `mutate()` (admin.js:8-12) |
| `admin.updateAccount` | mutation | `{id, status, byteLimit\|null, notes, reason}` | admin.js:61 |
| `admin.revokeDevice` | mutation | `{id, reason}` | admin.js:62-63 (reason from `window.prompt`) |
| `admin.cancelJob` | mutation | `{id, reason}` | admin.js:62,64 (reason from `window.prompt`) |

### 5.6 Subscription lifetimes (all `onUpdate` in scope)
| Subscription | Opened | Closed | Leak or risk |
|---|---|---|---|
| `users.me` | auth.js:86 | never | Fine (app lifetime) |
| `songs.list` | library.js:54 | `teardownLibrary` (library.js:69, tests only) | Re-renders the library on every tick even when it is hidden (§15) |
| `jobs.listActive` | library.js:60 | same | Same |
| `billingData.status` | billing.js:77 | the next `renderBilling` call only | Stays live after leaving the view |
| `jobs.get` | backend.js:192 | on a terminal status | Leaks on a stuck job |
| `songs.get` (player) | player.js:247 | player cleanup | Player map |
| `sharing.view` (public client) | shared-song.js:45 | `pagehide` (shared-song.js:77) | |
| `sharing.saved` | shared-song.js:63 | `pagehide` | |
| `notation.get` | notation/store.js:62 | notation map | |

### 5.7 Error surfacing
Many server functions throw plain `Error`: jobs.ts (10), admin.ts (8), billing.ts (9), devices.ts (6), storage.ts (10), songs.ts (3), lib/auth.ts suspension/export-only. Sharing, notation, metadata and tempoSources use `ConvexError`. In production deployments Convex replaces non-`ConvexError` messages with a generic "Server Error" (**verify on the prod deployment**). The friendly server strings would then never reach users, for example "Process the queued songs before adding more.", "Retry from the original processing computer." and "Your account is in export-only mode…".

Where messages do arrive (dev), the client shows them raw, including the `[CONVEX M(jobs:createSeparation)] [Request ID: …] Server Error Uncaught Error:` prefix. This affects library.js:383,488,544, app.js:96, admin.js:11 and settings.js:170. The spec's error-copy mapper (§3.6, §9.8 "error-copy mapping") should key on `ConvexError` `data.code`, which means converting these throws to `ConvexError` with codes. That is a small backend change but a prerequisite for §3.6.

---

## 6. `backend.js` exports → callers

| Export | Line | Callers |
|---|---|---|
| `getConfig` | 17 | app.js:71, export.js:36 |
| `saveSettings` | 21 | settings.js:199 |
| `listLibrary` | 27 | **none** |
| `onLibrary` | 32 | library.js:54 |
| `onJobs` | 37 | library.js:60 |
| `renameSong` | 41 | **none** |
| `saveTempo` | 45 | player.js:840,1027 |
| `findTempoSources` / `loadTempoSource` | 49/53 | player.js:915/917 |
| `deleteSong` | 57 | library.js:450 |
| `cancelJob` / `dismissJob` | 61/65 | library.js:376/391 |
| `signKeys` / `signKey` | 82/103 | library.js:138, export.js:43, player.js:282 / player.js:234 |
| `classifyInput` | 112 | backend.js:129. Returns `spotify` (`open.spotify.com`/`spotify:`), `url` (`^https?://`) or `search`. |
| `addSong` | 127 | library.js:543 |
| `reprocessSong` | 139 | library.js:486 |
| `AUDIO_FILE_RE` | 149 | library.js:573 (`mp3 wav flac m4a aac ogg opus aif aiff wma`) |
| `addFiles` | 162 | library.js:587 |
| `detectBeats` | 187 | player.js:958 |
| `openExternal` | 214 | library.js:420 (`window.open(url,'_blank','noopener,noreferrer')`) |
| `cloudUsage` | 218 | settings.js:166 |
| `savePractice` | 219 | player.js:1018,1027 |
| `getNotation` / `getSharedNotation` | 220/221 | export.js:39, player.js:882 |
| `exportPage` | 222 | export.js:13 |
| `retryJob` | 224 | library.js:383 |
| `updateMetadata`, `onSong`, `findMetadata`, `metadataDetail`, `uploadArtwork` | 226-236 | song-metadata.js / player.js:247 |

---

## 7. Auth (`auth.js`, `startup.js`)

### 7.1 `initialize({optional})` (`auth.js:25-94`)
1. Missing `VITE_CONVEX_URL` → `showFatal('Not configured', …)` and throw (`:26-29`).
2. Creates the HTTP `transport` for auth mutations, the realtime `convex` client, and an `AuthClient` in `spa` mode with `defaultStorage()` (localStorage) namespaced by `CONVEX_URL` (`:32-49`). Library keys: `__convexAuthJWT*` and `__convexAuthRefreshToken*`, plus pending-flow state.
3. `auth.init()` (`:50`) also completes an OAuth callback found in the URL (`convexAuthCode`/`convexAuthError`).
4. `optional` (share page): waits until the snapshot is no longer loading and returns `null` if signed out (`:51-58`).
5. `waitForSession()` (`:59`, `:96-151`) **always builds the sign-in card**, even when already signed in. It stays hidden until `waitForAuthSession` (startup.js:19-32) settles: signed-out → `showSignIn`, loading → `showStartup`.
6. `convex.setAuth(fetchAccessToken, cb)` waits for the backend verdict. On rejection it signs out, then `showFatal('Sign-in failed', …)` (`:61-70`).
7. `users.me` → `checkAccount` (`:71-85`). `suspended` gives a fatal card with `Manage billing` (→ `billing.portal`) and `Sign out` buttons appended to `#signin .setup-card` (`:74-81`). **`export_only` is not surfaced at all**: the user discovers it through failing writes (pair, add, settings save).
8. Live `users.me` sub (`:86`); `showStartup()` (`:87`); `auth.subscribe` reloads the page on a cross-tab sign-out (`:89-92`).

`ensureSignedIn` and `restoreSignIn` share one memoised promise (`boot ??=`, `:17-23`). After `restoreSignIn()` resolves `null`, a later `ensureSignedIn()` in the same page also returns `null`. This is why the share page reloads with `?save=1` to sign in (shared-song.js:34).

### 7.2 Sign-in card (`auth.js:96-151`)
- Title "Sign in", Google image button (`src/assets/google-signin.png`), status line, note "New here? Signing in creates your free account."
- Error codes mapped at `:123-128`: `access_denied`, `expired`, `invalid_flow`, `oauth_error`. Click shows "Opening Google…" and calls `signIn({providerName:'google', startSignIn, completeSignIn}, {redirectTo})` (`:135-149`).
- The theme `<select>` lives in `index.html:134`. The spec removes it (§6.6).

### 7.3 Account menu (`mountUserButton`, `auth.js:153-204`)
- A `<details class="account-menu">` with a `<summary>` avatar (initials plus optional `picture`, `referrerPolicy=no-referrer`).
- Panel items: email, then `Plan & billing` → `navigate('billing')`, `Administration` (admins), `App updates` (desktop → dispatches `woodshed:show-updates`), `Download desktop app` (web → `location.href='/download'`), `Sign out` (`auth.signOut()` then reload; on failure "Retry sign out").
- A separate gear button → `navigate('settings')` with the inline SVG `src/assets/settings.svg?raw` (`:197-200`).
- Closes on any document click outside (`:202`, never removed) and on Escape inside the menu (`:203`). There is no `role=menu` and no arrow-key navigation.

### 7.4 `showFatal(title, message)` (`auth.js:206-222`)
Shows `#signin` and replaces its children with a `.setup-card` (h2, description, `Retry` → reload). **This removes `#signin-mount` and the theme select permanently**, so a later sign-in render in the same page cannot happen.

---

## 8. Client storage keys

### 8.1 `localStorage` (13 `ws.*` keys; matches spec §9.6)
| Key | Shape | Read | Written | Owner map | `ws.prefs` target (one-way upgrade, no UI) |
|---|---|---|---|---|---|
| `ws.theme` | `'system'\|'light'\|'dark'` | theme-init.js:7 | theme-init.js:23 | shell | `prefs.theme`. **theme-init must read it pre-paint**, so either keep this key as the pre-paint source or have theme-init read `ws.prefs` JSON. Cross-tab `storage` sync (`:28-30`) keys on it. |
| `ws.view` | `{group:'songs'\|'albums'\|'artists', layout:'grid'\|'list'}` | theme-init.js:4; library.js:37 | library.js:40 (**no try/catch**: throws in private mode or when storage is full) | shell | `prefs.library = {layout, group: albums→'album', artists→'artist', songs→'none'}` |
| `ws.stopBehavior` | `'return'\|'stay'` | preferences.js:7 | preferences.js:11 | shell/player | `prefs.practice.stop` ('cue' or 'stay') |
| `ws.grid` | JSON grid settings | player.js:60 | player.js:385 | player | `prefs.stems` (spec §9.3; `practice.grid` also moves here) |
| `ws.overview` | `'1'\|'0'` | player.js:83 | player.js:808 | player | dropped (minimap replaced by the Song strip) |
| `ws.preservePitch` | `'1'\|'0'` | player.js:317 | player.js:791 | player | `prefs.practice.keepPitch` default |
| `ws.practice.view` | chart/tracks | notation/launcher.js:8 | launcher.js:9 | notation | seeds `practice.surface` default; `launcher.js` is deleted |
| `ws.chart.scale` | JSON number | notation/chart.js:25 | chart.js:12,195 | notation | `prefs.distance` seed or drop |
| `ws.chart.layout` | JSON | chart.js:26 | chart.js:12,190 | notation | `prefs.chart.layout` |
| `ws.notation.layout` | `'score'\|'lanes'` | notation/editor.js:31 | editor.js:245 | notation | `prefs.edit.chart.layout` |
| `ws.notation.keys` | JSON key remaps | editor.js:35 | editor.js:123 | notation | `prefs.edit.chart.keys` (must survive: user-remapped drum letters) |
| `ws.tapSnap` | `'1'\|'0'` | map-mode.js:39 | map-mode.js:543 | map | `prefs.edit.map.tapSnap` |
| `ws.tapOffset` | number string | map-mode.js:40 | map-mode.js:496 | map | `prefs.edit.map.tapOffset` (a calibration value; must survive) |

**Other storage:**
- `sessionStorage['ws.companion']` is removed on load (companion.js:8). The removal can itself be deleted in 2.0.
- `@convex-dev/auth` keys (`__convexAuthJWT…`, `__convexAuthRefreshToken…`): never touch them.
- IndexedDB `woodshed-notation` / `drafts` (notation/store.js:5).
- Cache API `woodshed-stems-v1` (stemcache.js:10).
- Fixture preamble (tests/fixture/preamble.js:5) wipes every `ws.*` except `ws.theme`, and seeds `ws.view`, `ws.practice.view`, `ws.overview` and `ws.notation.layout` from URL params. **It must be updated with the `ws.prefs` migration** or the fixture scenarios silently stop applying.
- **Recommended migration:** `prefs.js` reads `ws.prefs`. If absent, it builds it from the 13 legacy keys, writes it, and removes the legacy keys, all in one try/catch with no UI. The one exception is `ws.theme`, kept or mirrored for theme-init.

---

## 9. Native dialogs, `confirmModal` and other modals (all call sites)

### 9.1 `alert` / `confirm` / `prompt` (whole `src/js`)
| Call | Site | Context | 2.0 replacement |
|---|---|---|---|
| `alert(error.message)` | library.js:383 | Retry on a failed job card | Inline error under the card plus a toast with Details (§3.6) |
| `window.confirm("Discard your unsaved changes?")` | song-metadata.js:108 | Closing the metadata modal with edits | Dialog `confirm()`; becomes Edit · Details leave-guard |
| `window.prompt('Reason for this admin action:')` | admin.js:62 | Revoke device / cancel job | Dialog with a required Reason field (§6.4) |

### 9.2 `confirmModal` / `buildDialog` (library.js:643-669)
- `confirmModal(title, message, okLabel)` (`:644-660`) always renders **Cancel plus a danger-styled OK**, and is used for both destructive confirms and plain notices. It adds a `document` `keydown` listener that is removed **only when Escape is pressed** (`:656-658`). That leaks on Cancel, OK and backdrop. `focusModal`'s Escape also fires (via `buildDialog`, `:667`), so Escape calls `done(false)` twice; harmless.
- Call sites:
  - `:449` "Delete song?" / `"<title>" will be permanently removed.` / "Delete" (a real destructive confirm).
  - `:488` "Could not reprocess" / raw error / "OK" (a notice in a danger dialog).
  - `:544` "Could not add song" / raw error / "OK" (a notice in a danger dialog; the spec requires inline errors that keep the input).
- `buildDialog(title, html)` (`:662-669`) is also used by the Reprocess dialog (`:455`).

### 9.3 Other overlays in scope
| Overlay | Site | Mechanism | Dismiss |
|---|---|---|---|
| Add modal `#add-modal` | library.js:504-569; index.html:97-124 | `.hidden` toggle plus `focusModal` (re-applied on each open) | Cancel, backdrop, Escape |
| Reprocess dialog | library.js:453-491 | `buildDialog` | Cancel, backdrop, Escape |
| Share dialog `#share-dialog` | share-dialog.js:5-25 | `div.modal` plus `focusModal` | Close, backdrop, Escape |
| Desktop setup `#desktop-dialog` | desktop.js:3-12 | Native `<dialog>.showModal()`, created once | "Keep browsing", native Escape |
| Card context menu `.ctx-menu` | library.js:403-446 | `div` appended to `body` | Capture `mousedown` outside, capture `keydown` Escape. **No focus move, no `role=menu`, no arrow keys, no right-click or long-press entry.** |
| Account menu | auth.js:157-203 | `<details>` | Outside click, Escape |
| Toast `#app-notification` | feedback.js:3-19 | One at a time; non-errors auto-dismiss after 6 s | Dismiss button |
| Fatal/suspended card | auth.js:206-222, 73-84 | Replaces `#signin` | Retry (reload) |
| Drop overlay | library.js:604-625 | `.hidden` toggle | dragleave/drop |

`player.js:1073` suppresses player shortcuts while `.metadata-modal, dialog[open], [role="dialog"]:not(.hidden)` exists. `focusModal` sets `role=dialog` (modal-focus.js:4) to satisfy this. The new dispatcher's overlay scope replaces it (§7.1).

---

## 10. Global listeners and custom events

### 10.1 Listeners on `window` / `document` (shell scope; player and notation listed for completeness)
| Target · event | Phase | Site | Lifetime | Purpose | 2.0 |
|---|---|---|---|---|---|
| `matchMedia(dark)` `change` | — | theme-init.js:27 | page | Re-apply the system theme | keep |
| window `storage` | — | theme-init.js:28-30 | page | Cross-tab theme sync (`ws.theme` or `null` key) | keep, extend to `ws.prefs` |
| document `change` (`[data-theme-choice]`) | bubble | theme-init.js:31-33 | page | Any theme select anywhere | keep or replace with a Segmented control |
| document `DOMContentLoaded` | once | theme-init.js:34 | once | Sync select values | keep |
| document `pointerdown` | capture | interactions.js:11 | page | Track pointer-activated controls | **delete** |
| document `keydown` (Tab) | capture | interactions.js:15 | page | Reset pointer set | **delete** |
| document `click` | capture | interactions.js:19 | page | Blur pointer-clicked controls | **delete** |
| document `change` (select) | bubble | interactions.js:28 | page | Blur selects | **delete** |
| document `pointerup` (range) | capture | interactions.js:31 | page | Blur sliders | **delete** |
| document `dragstart` | bubble | interactions.js:35 | page | Block image drags | keep in base |
| document `click` | bubble | auth.js:202 | page | Close the account menu | Menu primitive |
| window `dragenter` / `dragover` / `dragleave` / `drop` | bubble | library.js:607,613,614,615 | page (registered once in `wireAddModal`) | Global drop overlay, then **silent instant upload** with defaults (`:623`) | **delete** the instant upload. Replace with drop → Add sheet with files listed (§3.1), scoped to Library. |
| document `mousedown` | capture | library.js:444 (removed :405) | while the card menu is open | Outside-click close | Menu primitive |
| document `keydown` | capture | library.js:445 (removed :406) | while the card menu is open | Escape close | Menu primitive |
| document `keydown` | bubble | library.js:656 | **leaks** until Escape | `confirmModal` Escape | **delete** |
| document `woodshed:billing` | — | app.js:82 | page | Settings → billing navigation | router `navigate('/settings/plan')` |
| document `woodshed:show-updates` | — | desktop-client.js:48 | page | Account menu → updates | command `app.updates` |
| window `pagehide` | once | shared-song.js:77 | once | Close the share clients and the player | keep; also flush practice (§9.3) |
| window `woodshed:theme` | — | player.js:1004; notation/chart.js:217; editor.js:328; score-view.js:198 | per view | Canvas redraw on theme change | keep (Stage always dark: the Stage ignores the light theme) |
| window `keydown` | bubble | player.js:1107 | while the player is open | Player shortcuts | registry dispatcher |
| window `keyup` | bubble | player.js:1022 | while the player is open | Practice save debounce | practice-state |
| window `mousemove` / `mouseup` | — | player.js:637-638, 711-712 | during a drag | Timeline/minimap drags | pointer events |
| window `pointermove` / `pointerup` / `pointercancel` | — | notation/editor.js:206 | during a drag | | notation map |
| document `pointerdown` | — | map-mode.js:207 | | Outside-click | map map |
| window `beforeunload`, `online` | — | notation/store.js:17 | store lifetime | Draft flush | notation map |

Element-scoped key handlers in scope: auth.js:203 (menu), library.js:546 (Enter in `#add-url` clicks Process), modal-focus.js:20 (trap and Escape). Others (map-mode.js:361,555, song-metadata.js:315, tempo-sources.js:254, editor.js:242, chart.js:104 and editor.js:241 wheel) belong to other maps.

### 10.2 Custom events
| Event | Dispatched | Listened |
|---|---|---|
| `woodshed:theme` (window, `detail:{preference, theme}`) | theme-init.js:16 | player.js:1004, chart.js:217, editor.js:328, score-view.js:198 |
| `woodshed:billing` (document) | settings.js:164 | app.js:82 |
| `woodshed:show-updates` (document) | auth.js:194 | desktop-client.js:48 |

### 10.3 Globals
- `window.woodshedAppearance` (theme-init.js:19-26); read by preferences.js:2.
- `window.woodshedDesktop` (preload).

---

## 11. Desktop bridge (`window.woodshedDesktop`, `desktop/preload.cjs:2-9`)

### 11.1 API
| Method | IPC | Main handler | Client call sites | Returns |
|---|---|---|---|---|
| `info()` | invoke `desktop:info` | main.cjs:91-94 (trusted frame only) | companion.js:51; settings.js:145 | `{version, companion:{port, token}\|null, update:{status, version, percent, message}}` |
| `update('show')` | invoke `desktop:update` | main.cjs:95-100. Only `'show'` is accepted; runs the native prompt flow. | desktop-client.js:25; settings.js:149 | update state |
| `onUpdate(cb)` | `desktop:update-state` | main.cjs:23,76 | desktop-client.js:42 | unsubscribe fn (ignored) |
| `onOpenUpdates(cb)` | `desktop:open-updates` | app menu "Check for Updates…" (main.cjs:117) | desktop-client.js:47 | unsubscribe fn (ignored) |
| `setTheme(pref)` | invoke `desktop:theme` | main.cjs:84-90; persists `userData/appearance.json` | theme-init.js:18 | — |
| `mediaUrl(url)` | invoke `desktop:media-url` | main.cjs:83 → `mediaProxy.register` (60 s single-use ticket, per inventory §18) | media-fetch.js:4 (stems, export) | local `/media/…` URL |

Presence checks of `window.woodshedDesktop`: app.js:90; auth.js:143,194,195; companion.js:25,45,51; settings.js:105,106,131,137,139,143,145,149; media-fetch.js:4; theme-init.js:18. The fixture fakes `info`, `onUpdate`, `onOpenUpdates`, `update` and `setTheme`, **not `mediaUrl`** (tests/fixture/preamble.js:12-20).

Update `status` values (desktop/update-controller.cjs): `idle`, `checking`, `current`, `available`, `downloading` (with `percent`), `ready`, `error` (main.cjs:57 emits `error` "Local processor stopped. Restart Woodshed to reconnect."). The header icon shows only for `available`, `downloading` and `ready` (desktop-client.js:9).

### 11.2 Main-process behaviour the shell depends on
- **Native update prompts on window focus:** "Download update / Later", then "Restart now / Later" (update-controller.cjs:82,107). They also fire on `focus` (main.cjs:80) and on wake. Nothing in the bridge lets the renderer say "Stage is playing", so spec §6.5 "native prompts deferred while the Stage plays" **needs a new bridge method** (for example `setBusy({playing})`).
- **App menu** (main.cjs:117) is hard-coded: Woodshed (Check for Updates…, Quit), Edit, View. Spec §6.5 needs menus generated from the registry (`registerMenu` in preload, spec §7.1), with accelerators ⌘N, ⌘W and ⌘,. **That requires preload and main changes.**
- **Quit guard** (main.cjs:111-116) asks "A song is still processing" when companion `/status.busy`. It does not flush practice: the renderer must flush on `pagehide`/`beforeunload`.
- Single instance (main.cjs:101-102). Permission requests are all denied (main.cjs:109), so **Notifications, MIDI (`midi`), wake lock and clipboard-read permission prompts are refused in Electron**. Spec items (native "ready" notification §3.5, Web MIDI §7.5, ⌘V URL prefill §3.1) need a permission allow-list or IPC equivalents (`new Notification` from main).
- Window bounds are not remembered (main.cjs:105: fixed 1280×850). The spec wants them remembered (§6.5).
- No globalShortcut and no media-key handling (spec §6.5 background shortcuts).
- No "restart processor" IPC: the companion exits → `emit('error')` only. Spec "Restart processor" (§2.8, §3.6, §6.5) needs `desktop:restart-companion`.

### 11.3 Desktop client init (`desktop-client.js:33-56`, `companion.js:47-65`)
1. Inserts the `.desktop-update-trigger` icon before `#user-button`, subscribes `onUpdate` and `onOpenUpdates`, and listens for `woodshed:show-updates`.
2. `initializeLocalDesktop()`:
   - `info()`; requires `companion.token` to be 64 hex (`:52`);
   - sets `LOCAL = http://127.0.0.1:<port>` and the bearer code;
   - `GET /status`;
   - `devices.pair({tokenHash: sha256(token), name: status.name})`;
   - `POST /connect {convexUrl}`;
   - `ready = true`.
3. **Failure goes only to `console.error`** (desktop-client.js:53-55). Afterwards every `localRequest` throws "Local processor is not connected. Retry the desktop connection in Settings." (companion.js:30,38). **No such retry exists in Settings** (stale copy, spec §3.6).
4. Race: an Add click before `desktop-client.js` has loaded, or after a failed init, has `initialization` undefined and `ready` false, so it fails immediately. There is no retry path short of restarting the app.

---

## 12. Companion HTTP API (used by the client)

Server: `companion/server.mjs:177-232`.
- Requests must come from an allowed `Origin`, with `Host` `127.0.0.1:<port>`/`localhost:<port>`, and carry `Authorization: Bearer <token>` (timing-safe compare).
- CORS preflight allows `GET,POST` and headers `authorization, content-type, x-filename`, plus `Access-Control-Allow-Private-Network`.
- Every route except `/status` and `/connect` rechecks device revocation through `devices.identity` first (`:189`).

Client transport: `companion.js:10-23`, with JSON or Blob body, a 30 s timeout (600 s for Blobs), and error text from `result.error`. A network failure becomes "Local processor unavailable. Restart Woodshed for desktop to reconnect."

| Route | Method | Request | Response | Client caller |
|---|---|---|---|---|
| `/status` | GET | — | `{name: hostname, connected, deviceId, userId, busy}` (`:185`) | companion.js:34 `desktopStatus` ← `requireCompanion` (:36-41) ← backend `addSong`/`reprocessSong`/`addFiles`/`detectBeats`/`retryJob`; init (:55) |
| `/connect` | POST | `{convexUrl}` | identity (`:186`) | companion.js:59 |
| `/upload` | POST | raw Blob body (no filename header used) | `{id}`; 1 GB cap (`:190-195`) | `localUpload` companion.js:42 ← backend.js:166 |
| `/export-originals` | POST | `{}` | `{directory: ~/Downloads/Woodshed-originals-<iso>, count}`; copies `.wav`/`.flac` from `jobs/` (`:196-209`) | settings.js:173 |
| `/legacy` | GET | — | `[{directory, count}]` (`:210-213`) | companion.js:43 ← settings.js:156 |
| `/import` | POST | `{directory}` | `{count, skipped, remaining}`; queues ≤ 20 per call via `worker.importSong` (`:214-226`) | companion.js:44 ← settings.js:160 |

**Spec gaps:** B4 `/resolve` and `/search` do not exist. `/status` has no processor stage (`Starting… first run`), queue length or current job. There is no per-upload progress: `addFiles` reports one 100% tick **after** the upload finishes (backend.js:166-167), so "Uploading · 0%" sits until done (library.js:218,592). Spec §3.4 wants real bytes through XHR `upload.onprogress`, which works because the endpoint is a plain POST body.

---

## 13. Add-song flow (today)

### 13.1 Entry points
- `#add-btn` and `[data-add]` (empty state) → `open()` (library.js:535).
- Window drop anywhere → **instant upload with `config.settings`, no confirmation** (library.js:604-625). It is skipped when the add modal is open (the modal drop zone handles it) or `.metadata-modal` exists.
- No keyboard shortcut and no paste handling.

### 13.2 `open()` (library.js:523-532)
- **Web gate:** `!isDesktopApp()` → `showDesktopSetup()` and return (`:524`). The web user never sees the sheet. The spec replaces this with the web Add sheet body (§3.3).
- Resets preset and stem selects to `config.settings.preset`/`stemMode`, clears the input, updates the description, shows the modal, and calls `focusModal` then focuses `#add-url`.

### 13.3 Modal contents (index.html:97-124; library.js:504-569)
- Text input "Link or search" with placeholder "YouTube / Spotify / SoundCloud link, or type to search…". Enter clicks Process (`:546`).
- Drop zone `#file-drop` (`:558-566`) and `Choose files…` → hidden `<input type=file multiple accept=audio/*,…>` (`:549-555`).
- Quality preset `<select>`: server presets plus `Custom` ("Your custom settings."). Stems `<select>` from `config.stemModes`.
- Description = preset description + `costHint()`. `costHint` ignores its argument and always returns "Downloads and processing run on this computer. Higher quality takes longer." (`:494-497`; `p` unused).
- `modalSettings()` = `{...config.settings, preset, stemMode}` (`:521`).

### 13.4 Submit paths
- **Text** (`:539-545`): empty input refocuses. Otherwise **close first**, then `backend.addSong(input, settings)`:
  1. `requireCompanion()` → `/status`, then `deviceId`;
  2. `classifyInput`;
  3. `jobs.createSeparation({source, deviceId, settings, label: raw input})`.
  - On error the input is **lost** and a danger `confirmModal('Could not add song', raw)` appears.
  - No duplicate check. No feedback on success other than the new "In progress" row arriving through `jobs.listActive`.
- **Files** (`:551-555`, `:561-566`, `:581-601`): `audioFiles()` filters by `AUDIO_FILE_RE` or `type audio/*`. **Non-audio files are dropped silently.** Then `uploadAndQueue` runs sequentially, per file:
  1. local `uploads` entry `upload_<ts>_<rand>` → renders an "In progress" row;
  2. `addFiles([file])` → `requireCompanion` → `POST /upload` → `jobs.createSeparation({source:{type:'upload', value:localId, filename}, …, label:file.name})`;
  3. on success the local entry is deleted (the server job row takes over); on error the entry keeps `error` and shows Failed with Retry/Dismiss.
- **Cancel during upload is cosmetic:** `[data-cancel]` deletes the local entry (`:375`), but the in-flight `addFiles` promise continues and **still creates the server job**. The `onProgress` guard (`:589`) only skips the UI patch. **Retry on a local upload failure** calls `backend.retryJob('upload_…')` with a non-Convex id, so it fails with a validator error in `alert()`.

### 13.5 Reprocess (library.js:453-491)
- Card menu `Reprocess…` appears only if `song.source` exists (`:417`). Dialog copy: "Split "<title>" again. New stems replace the current ones; your beat track and song details are kept." Selects preset (+Custom) and stems (default `song.stemMode`).
- OK closes the dialog, then `reprocessSong(id, settings, '<title> (reprocess)')` → `createSeparation({settings, label, replaceSongId, deviceId})`. The server inherits `song.source` (jobs.ts:74-81). Errors use `confirmModal('Could not reprocess')`.
- **No desktop gate in the menu.** On web the call reaches `localRequest`, which opens the desktop setup dialog and throws, then `confirmModal` appears on top. That is two dialogs.

### 13.6 Settings used per job
`config.settings` (server `withDefaults`) = `{preset, stemMode, bitrate, custom:{model, shifts, overlap}, format?, …}` (convex/lib/presets.ts:92-117). `format: 'flac'` is honoured by the server (`resolveQuality`), but **no UI sets it**, which is why the codec banner's "switch stems to FLAC in Settings" is wrong (app.js:58; also stemcache.js:135-138 `codecErrorMessage`).

---

## 14. Jobs display (today)

- **Sources:** `jobs.listActive` (last 50, live or error), filtered to `kind==='separate'` (library.js:62), plus local `uploads` (library.js:26). `allPending()` (`:196-224`) normalises them to `{jobId, songId, title: meta.title‖label, uploader, artist, album, duration, coverKey, stage, percent, message, error (status==='error'), local}`.
- **Placement** (`:117-121, 156`):
  - Jobs whose `songId` is in the library (re-split) overlay that card (`procBySong`). The card loses its open button and menu and becomes **unclickable** (`:265,267,357`).
  - Other jobs render in an **"In progress" section at the top, always as list rows** (`:256`), filtered by the search query.
- **Stage labels** (`:98-101`): `queued` Queued, `upload` Uploading, `download` Downloading, `separate` Separating, `finalize` Finishing. Anything else (for example `detect`) is "Working".
  - Card overlay: spinner, `<Stage> · <pct>%`, bar, `Cancel` (`:319-335`).
  - Row inline: bar, label, `Cancel` (`:338-349`).
  - `job.message` is never shown, except the hard-coded "Uploading…" for local entries (`:219`). It is not even used there.
- **Failure** (`:320-326, 339-341`): "Failed", `friendlyError(raw)` (`:296-309`) with `Retry` and `Dismiss`. The raw text goes in the `title` tooltip and is logged once to `console.warn` (`:312-317`). friendlyError rules:

| Regex | Copy |
|---|---|
| `not a bot\|sign in to confirm` | "YouTube blocked the download. Try again, or paste a YouTube link directly." |
| `no audio could be downloaded\|could not resolve` | "Couldn't download audio. Check the link and try again." |
| `Spotify` | "Couldn't get this Spotify track. Try a YouTube link instead." |
| `produced no stems` | "No stems were produced. Try a different quality preset." |
| `no stems to analyse` | "This song needs stems before beats can be detected." |
| `rejected the job\|unauthorized\|is not set on this deployment` | "Processing is unavailable right now. Try again in a minute." |
| `exited with code \d+` | "Something went wrong while processing. Try again." |
| otherwise | first line, truncated to 80 chars |

- **Actions:**
  - Cancel → `jobs.cancel` (server) or local delete.
  - Retry → `jobs.retry` (needs the original device) with `alert` on error.
  - Dismiss → `jobs.dismiss` or local delete.
  - None of them handle errors except Retry, and none disable the button while pending.
- **`patchOverlay`** (`:629-637`) updates the label and bar in place for upload progress, without a re-render.
- **Not shown anywhere:** beat-detection jobs (the player shows its own progress), legacy import jobs (`kind:'import'`, convex/worker.ts:128), queue position, device name, ETA, source, settings, start time and `message`. Spec §2.8 and §3.4 need all of these. Queue position, device name and start time are derivable from `jobs` plus `devices`, but `listActive` does not return `deviceId`, `createdAt`, `settings` or `source`. **That needs a small query extension.**

---

## 15. Library rendering

- **State** (library.js:17-32): `songs`, `jobs`, `uploads`, `selecting`, `selected` (Set), `shownIds`, `coverUrls`, `coverPending`, and a `view` from `ws.view` (`:35-40`).
- **Render trigger:** every `songs.list` or `jobs.listActive` tick, search `input`, group/layout click, selection change, upload change and `showView('library')`. It renders even when the library view is hidden, for example on every practice save while a song is open.
- **`renderLibrary(filter, {animate})`** (`:109-193`):
  1. Bails until both subscriptions have loaded (`:110`). A render token drops stale async renders (`:107,111,151,183`).
  2. Search is a case-insensitive substring over title, uploader, artist label (`artistLabel` from song-metadata), album, albumArtist, genre and tags (`:114-115,123`). It is not persisted and not in the URL.
  3. Covers: unsigned `coverKey`s are signed in one batch, without blocking the render. On arrival `<img>` elements are hydrated in place inside `[data-cover-key]` (`:128-150`). Release artwork uses `coverUrl` (coverartarchive) directly (convex/songs.ts:59).
  4. Sections:
     - "In progress" (pending jobs);
     - then, by `view.group`: `songs` (flat, **server order = `addedAt` desc; no sort control**), `albums` or `artists`, grouped by `album` or `artistLabel`;
     - groups are sorted by `localeCompare` with base sensitivity, with "Unknown album/artist" sorted **alphabetically, not last** (`:158-180`);
     - each group header has a cover (first song with art), title and count.
  5. Commit: `container.innerHTML = …` (**the whole grid is rebuilt; focus on a card is lost on every tick**), `wireArtwork`, `wireCards`, and the first render resolves `initLibrary` (`:182-188`). Only explicit group/layout changes animate through View Transitions (`:190-192`).
- **View models** (`:227-243`): `stemLabel` is "N stems" when ≥ 4, else stem names joined with " / ". `subFor` shows the album in the Artists group, otherwise the artist (`:245`).
- **Grid card** (`:262-275`) `.card[data-id][data-job]`, containing in order:
  - an optional `.song-select` checkbox;
  - a `.song-open` overlay button (`aria-label="Open <title>"`);
  - a `.badges` stem badge;
  - a `.card-menu` "⋯" button;
  - `artworkMarkup(..., 'cover')`;
  - `.meta` with `.title`, then `.sub` with artist/album and duration;
  - the optional processing overlay.
- **List row** (`:277-289`) `.list-row`: thumb, title/sub, stem badge, duration, menu (or inline progress).
- **Card click** (`:358-362`): the whole card opens the song through `onOpenSong`, or toggles selection in select mode. The `⋯` button stops propagation.
- **Empty state:** `#library-empty` "No songs yet." with "＋ Add your first song" (index.html:73-76), shown when nothing matches, **including "no search results"** (`:153`). There is no distinct no-results copy.
- **Artwork fallback** (artwork.js): a deterministic FNV hash of `artist\0album` (or id/title) chooses one of 6 palettes × 6 geometric shapes as an SVG data-URI background, so cards never jump when covers load.

---

## 16. Card menu actions (library.js:411-422)

| Item | Condition | Action |
|---|---|---|
| Play | always | `onOpenSong(song)` |
| Share song… | always | `showShareDialog(song)` |
| Reprocess… | `song.source` | `reprocessDialog(song)` (§13.5) |
| Edit song… | always | `editSongs([song])` (song-metadata modal) |
| Select songs… | always | `selecting = true`, preselect this song |
| Open original source | `source.value` is `http(s)` | `backend.openExternal(url)` |
| Delete | always (danger) | `confirmModal` → `songs.remove` |

Placement: under the "⋯" button, clamped to the viewport (`:435-442`). Missing against spec §2.5: `Edit chart`/`Edit map`, Pin, Add to setlist, a desktop-only reason on Re-split, shortcut hints, keyboard and roving focus, right-click/long-press, and coarse-pointer sheet rendering.

---

## 17. Selection and bulk (library.js:671-690, 263-264, 352-370)

- The bar `.library-selection` is placed before `#library-grid`. It holds:
  - `[data-select]` "Select songs" / "Done selecting" (toggle; leaving clears the selection);
  - `[data-count]` "N selected (maximum 100)";
  - `[data-all]` "Select visible" / "Deselect visible" (adds the first 100 of `shownIds`);
  - `[data-edit]` "Edit selected" → `editSongs(selectedSongs)`, the only bulk action.
- Checkboxes appear on cards when `selecting`. Pending and processing cards cannot be selected. The cap of 100 is enforced in `toggleSelected` (`:681`). Selections pruned when songs disappear (`:57`).
- No keyboard entry (⌘/Shift-click), no Escape exit, no bulk delete/pin/re-split, and no floating bar. The bar is always visible, even with 0 songs.

---

## 18. Sharing

### 18.1 Owner dialog (`share-dialog.js:5-25`)
- Entry: card menu (library.js:416) and the player header "Share" button (player.js:239-240, with `beforeShare: saveForShare`, which flushes tempo, practice and transcription first, player.js:1023-1028).
- Copy: "Anyone with the link can listen and save their own copy. Tempo maps, beat corrections, loop, speed, mixer, grid, and count-in settings are included. Private notes and tags stay private."
- Controls: read-only URL field (hidden until a token exists), ☑ "Include drum notation and its alignment", Close, `Stop sharing` (danger, hidden without a token), primary `Create link`/`Copy link`.
- Flow:
  1. Load `sharing.status`.
  2. Create or copy: `beforeShare()`, then `sharing.create({id, includeNotation})`, then `clipboard.writeText`. On clipboard failure: select the field and show "Select and copy the link above."
  3. The notation toggle re-calls `create` on an existing token and reverts on error.
  4. Stop calls `sharing.revoke` **with no confirmation** (spec adds a Dialog).
- Errors render inline in `.share-status` from `error.data.message`, `error.data` or `error.message`.

### 18.2 Shared page (`shared-song.js:8-78`)
1. Adds a `noindex` meta, `body.in-player.shared-page`; the header becomes a brand link plus a theme select. Activates `#view-player`, inserts a `.share-banner` ("Shared song" / "Saved copies count toward your cloud storage." / status / `Add to library` / `My library`), a placeholder, then `finishStartup()`.
2. An unauthenticated `ConvexClient` subscribes `sharing.view`. On a new `song.revision` it calls `openPlayer(song, {readOnly:true, cacheNamespace:'share:<token>:<rev>:', resolveUrls: shareAudio.playback})`. A `null` result means unavailable.
3. `restoreSignIn()` (or `ensureSignedIn()` with `?save=1`). Signed in: subscribe `sharing.saved` (shows "copying" and "Already in your library…").
4. Button states:
   - "Sign in to add" → `/share/<t>?save=1`;
   - "Add to library" → `shareAudio.save` → `replaceState('/share/<t>')`;
   - "Open in library" → `/?song=<id>`.
5. With `?save=1` the sign-in screen gets "Keep listening without signing in" (`:55-58`). After sign-in it validates through `client.query(sharing.view)` and then auto-adds (`:70-74`).
6. `pagehide` closes both subscriptions, the client and the player.

---

## 19. Settings structure (`settings.js:25-186`)

Rebuilt in full by every `showView('settings')`. Sections in DOM order:

| Section | Contents | Persistence |
|---|---|---|
| Appearance (`:33-37`) | `themeControl()` select | `ws.theme` (theme-init) |
| Playback (`:38-43`) | "When playback stops": Return to edit cursor / Stay. Hint mentions "Enter pauses or resumes in place." | `ws.stopBehavior` |
| Song defaults (`:45-101`) | Quality: **range slider 0–2 plus 3 preset buttons (duplicate)**, label, description. `<details>` Advanced: Model select, Quality passes 0–10, Overlap 0.1–0.75 (editing switches to `custom`). Stem layout select. Sync bitrate select. | `settings.save` through a serialised `saveQueue` (`:196-203`). Failure → error toast "Could not save changes: … Change the setting again to retry." |
| App Version (`:103-107`) | Desktop: `Version x` from `info()` plus "Check for updates" → `update('show')`. Web: `Web app · <package.json version>`. | — |
| Storage & plan (`:109-119`) | `storage.usage` text and `<meter>`; "Cloud usage includes pending uploads."; `Plan & billing` → `woodshed:billing`; Playback cache size and `Clear cache` | — |
| Library management (`:121-141`) | Export synced library ZIP; Export original audio files (desktop; **disabled on web**); `<details>` Import an old Woodshed library with an optional directory input (**disabled on web**) | companion `/export-originals`, `/legacy`, `/import` |

- Button work runs through `withButtonProgress` (in-button label, error toast). Success uses `notify`.
- **Settings write the full object** (`settings.save` replaces the row with `withDefaults(args.settings)`, convex/settings.ts:39-52), built from the boot-time `config.settings` snapshot. In 2.0, `profile`, `pins`, `onboarding` and "Use these for future songs" (spec §1.1, §3.2, §6.6) will **all write through this whole-object replace from possibly stale snapshots, so last writer wins across devices and features.**
- **Recommendation:** subscribe `settings.config` and add a partial `settings.update({patch})` mutation that merges server-side. That is a small backend change. Also cap the size, since `settings: v.any()` is unbounded. `settings.save` uses `requireWritableUserId`, so export-only accounts cannot change anything, including theme-independent profile data.

---

## 20. Billing structure (`billing.js:10-81`)

- `#billing-root`: "Plan & billing" title, usage line, then Free and Plus plan cards.
  - Plus has a Monthly/Yearly toggle (module state `interval='year'`), hard-coded prices, and `Get Plus` (hidden when paid; disabled when `!state.enabled`).
  - Footer: terms hint, `Manage subscription` (only `hasCustomer`), `Export library` (duplicate of Settings), and a notice line.
- Notices (`:25-30`): billing not enabled ("Upgrades are being set up…"), `cancelAtPeriodEnd` ("Your plan ends …"), `grace` ("Your paid plan has ended. Export or reduce … by <date>").
- `pending` blocks double clicks and re-renders (`:7,17,43-59`). Checkout and portal call `withButtonProgress('Opening secure billing…')` → `convex.action` → `location.assign(url)`. In Electron that navigation opens the system browser (main.cjs:107), and Stripe returns to the **web** `/billing`, not the app. The desktop session updates reactively through `billingData.status`.
- `?checkout=success` is not acknowledged (no success toast).

---

## 21. Admin structure (`admin.js:13-66`)

- `renderAdmin` (on every view entry):
  - `admin.overview` → summary (cloud MB used of app MB; default per-account MB);
  - `<details>` "Change storage policy" form (default account limit MB, base app ceiling MB, Reason with `minlength=3`) → `admin.updatePolicy` → full re-render;
  - account search by **exact email** plus "All users" reset; list (25 per page, `Next page`, cursor-forward only, no previous);
  - account pane;
  - `<details>` "Audit history" with `Load more`.
- Account pane (`loadAccount`, `:51-66`; stale-guarded by `selected`):
  - name, email, verified, joined, usage/limit;
  - form: Account access (active / export_only / suspended; disabled for admins), Storage override MB (blank = default), Private admin notes, Reason → `admin.updateAccount`;
  - Connected computers with `Revoke`, Recent processing jobs with `Cancel` (queued/running), both through `window.prompt` for the reason;
  - status lines `role=status`.
- All errors become inline text (raw messages).
- Spec §1.2 adds `/admin/accounts/:id`. The current UI has no per-account URL, and `selected` survives re-entry (`:39`).

---

## 22. Export (`export.js:9-57`)

1. `showSaveFilePicker` (Chromium) is called **inside the click gesture, before any await**, which is a hard constraint for the new button (`:10-11`). `AbortError` from cancelling the picker is swallowed by `withButtonProgress` (feedback.js:29).
2. Pages `songs.exportPage` 50 at a time (`:12-13`). Without a picker, more than 100 MB of stems throws "This browser cannot stream a large archive to disk. Export from Chrome or Edge on a desktop." **On iPad/Safari most libraries cannot export.**
3. Streams a STORE-mode ZIP (fflate `ZipPassThrough`):
   - `manifest.json` `{version:1, exportedAt, songs}`;
   - `settings.json`;
   - per song `<safe title>-<id>/drums.woodshed.json` (notation v2 via `upgradeScore`) and every stem plus the cover, through `signKeys` and `fetchMedia`.
4. Progress text goes into the button label ("Exporting i/n: title").
5. The fallback creates a Blob URL download, revoked after 60 s.

---

## 23. Download page and desktop setup dialog (`desktop.js`, `download-release.js`)

- `showDesktopSetup(message)` (desktop.js:3-12):
  - native `<dialog id=desktop-dialog>` with title "Add songs with Woodshed for desktop";
  - copy: "The desktop app downloads and separates audio on your computer. Your songs sync here for practice on any device.";
  - `#desktop-status` message line, `Keep browsing`, `<a href=/download>Download Woodshed</a>` (same tab);
  - called from library.js:524 (Add on web) and companion.js:26 (any `localRequest` on web).
- `renderDownload()` (desktop.js:13-97):
  - replaces `<body>` with nav (brand, theme select, "Open web player ↗") and hero (recommended button, detail, `role=status`);
  - "All downloads" platform cards (macOS DMG/ZIP Apple Silicon, Windows EXE, Linux AppImage), Retry, a 3-step explainer and a footer (Release notes, source);
  - fetches `/api/downloads`, then the `/downloads.json` fallback (10 s timeout each);
  - `normalizeRelease` (download-release.js:19-32) rejects drafts, prereleases and non-`vX.Y.Z` tags, requires every installer, and pins URLs to `github.com/KyleKincer/woodshed/releases/download/<tag>/`;
  - `detectPlatform` (download-release.js:8-17) returns `mobile` (iOS/Android/iPadOS touch Mac), `web` (ChromeOS, ARM Linux), `windows`, `mac` or `linux`. Mobile/web turn the primary button into "Open web player ↗".
- Spec §3.3 reuses `detectPlatform` and the release manifest inside the web Add sheet ("Download for macOS (Apple Silicon) ↗", "Copy download link", `navigator.share`). The sheet needs the release fetch as a reusable function; today it is inlined in `renderDownload`.

---

## 24. Header and account chrome (today → spec)

| Today | Site | Spec |
|---|---|---|
| Back chevron `#header-back` (non-library views) | index.html:28 | Removed. Back is the History API; the Stage has its own identity/Back. |
| Wordmark home button | index.html:31 | Wordmark as the Home link in the 56 px top bar (§2.1) |
| `#header-song` (player identity, edit, share) | player.js:226-240 | Moves into the Stage HUD |
| "＋ Add song" | index.html:35 | Same label, opens `/add` on every platform |
| Account `<details>` + gear | auth.js:153-204 | Avatar Menu with Settings, Plan & storage, Keyboard shortcuts, App updates / Get the desktop app ↗, Administration, Sign out; avatar dot for a ready update |
| Desktop update icon | desktop-client.js:33-40 | Deleted |
| Search lives in the Library view header | index.html:68 | Top-bar search, `/` focus, ⌘K palette |
| Codec banner, fixed | app.js:50-61 | In-flow banner with new copy (§2.7) |
| No Jobs chip | — | Jobs chip and popover (§2.1, §2.8) |

---

## 25. Feedback, focus, motion and interaction helpers

- **`notify(message, {error})`** (feedback.js:3-19): replaces any existing `#app-notification`, `role=alert` for errors and `status` otherwise; non-errors auto-close after 6 s. Callers: settings.js (161,174,180,200,257), billing.js (70,78). **Not held while playing**, which the spec requires (§7.9).
- **`withButtonProgress(button, label, work)`** (feedback.js:21-35): disables the button, sets `aria-busy`, swaps the label, passes a `progress(text)` callback, sends errors (except `AbortError`) to an error toast, then restores. Callers: settings.js:148,152,171,177,254 and billing.js:53,68.
- **`focusModal(modal, dismiss)`** (modal-focus.js:2-29): role/aria-modal/labelledby from `h2`, Tab trap, Escape → dismiss, `MutationObserver` on the whole body (attributes `class`) to clean up when the modal is removed or hidden, focus return. Callers: library.js:530,667; share-dialog.js:12; song-metadata.js; notation/editor.js.
- **`transitionView(update, {interrupt})`** (motion.js:7-29): View Transitions with latest-intent-wins, reduced-motion bypass, `interrupt:false` for library re-renders. Tests: `tests/motion.test.mjs`.
- **`initializeInteractions`/`isPointerControl`** (interactions.js): see §10. `isPointerControl` is used by player.js:1075 and notation/editor.js. The spec's dispatcher makes it unnecessary.

---

## 26. Remaining `src/js` modules (owned by other maps)

| File | Owner | Note for the shell |
|---|---|---|
| `musical-position.js` | player | **Imported only by `tests/playback-engine.test.js:7`**. Dead in the app; spec deletes it (Phase 0). |
| `timeline-navigation.js` | player | `boundedView`, `wheelNavigation` (player.js:16) |
| `player-layout.js` | player | Deleted in Phase 1b |
| `onsets.js` | map-mode | Tap tightening (map-mode.js:7) |
| `map-lane.js` | map-mode | Tempo lane canvas (map-mode.js:8) |
| `guitar-pro-import.js`, `guitar-pro-bounds.js` | tempo/notation | Lazy-loaded alphaTab importer and bounds checks |
| `tempo-import.js`, `tempo-archive.js`, `tempo-sources.js` | tempo | |
| `song-metadata.js` | metadata | `editSongs(songs)` entry (song-metadata.js:70) used by library card menu and selection; contains `window.confirm` (:108) |

---

## 27. Tests and fixture touching the shell

| Test | Count | Modules | Will break when |
|---|---|---|---|
| `tests/library-startup.test.js` | 3 | library, backend, companion (mocked `isDesktopApp:false`), startup | Library is replaced. It relies on `initLibrary`, `renderLibrary`, `teardownLibrary` and the DOM ids. |
| `tests/settings-ui.test.js` | 4 | settings, backend, companion, export, stemcache | Settings restructure |
| `tests/billing-ui.test.js` | 3 | billing, auth, export | Plan moves into Settings |
| `tests/share-dialog.test.js` | 4 | share-dialog, auth | Dialog primitive |
| `tests/sharing-ui.test.js` | 5 | shared-song, player, auth | Shared Stage |
| `tests/companion.test.js` | 3 | companion, desktop, auth | Status/retry additions |
| `tests/downloads.test.js` | 5 | download-release, desktop, `api/downloads.js` | Download page restyle (logic kept) |
| `tests/interactions-ui.test.js` | 5 | interactions, feedback | Both deleted |
| `tests/startup.test.js` | 3 | startup | stable |
| `tests/theme.test.js` | 4 | `public/theme-init.js` | Stage-dark / `ws.prefs` changes |
| `tests/motion.test.mjs` | 4 | motion | stable |
| `tests/artwork.test.mjs` | 2 | artwork | stable |

**Fixture** (`tests/fixture/`, `npm run fixture` on port 5190):
- `db.js` implements every function in §5 used by the shell, **except** `admin.updatePolicy`, `admin.updateAccount`, `admin.revokeDevice`, `admin.cancelJob`, `artworkUpload.complete` and the `auth.*` functions (0 matches).
- `preamble.js` fakes the desktop bridge and companion HTTP on port 47831 (`/status`, `/connect`, `/upload` with a 900 ms delay, `/legacy`, `/export-originals`, …) and seeds `ws.*` keys (§8).

---

## 28. Bugs and risks found (rebuild implications)

| # | Finding | Ref | Implication |
|---|---|---|---|
| S1 | Cancel during a file upload removes the card but the job is still created | library.js:375,587-594; backend.js:162-177 | The new `upload.js` must use an `AbortController`/XHR abort and only call `createSeparation` if not cancelled |
| S2 | Retry on a local upload failure calls `jobs.retry` with a non-Convex id, which fails with `alert` | library.js:379-384 | Local failures need their own retry (re-upload) |
| S3 | Server error messages are plain `Error`, so they are likely redacted in prod; the client shows raw Convex-prefixed text | §5.7 | Convert to `ConvexError({code, message})`. The client error-copy mapper keys on `code`. Prerequisite for spec §3.6. |
| S4 | `devices.pair` re-enables a revoked device | convex/devices.ts:24-27 | Admin revoke is not durable. Decide whether pair should refuse a revoked token. |
| S5 | Pairing failure is console-only; the "Retry the desktop connection in Settings" copy points at nothing | desktop-client.js:53-55; companion.js:30,38 | Processor status state machine (`starting / ready / offline / pair-failed`) in the store, plus `Try again` and a Restart IPC (§11.2) |
| S6 | `settings.config` is one-shot and `settings.save` replaces the whole object | app.js:71; convex/settings.ts:39-52 | Subscribe to config; add a merge-patch mutation before adding `profile`/`pins`/`onboarding` |
| S7 | `songs.list` ships `tempo` and `practice` for up to 1000 songs and re-renders the whole grid `innerHTML` on every tick, even when hidden | convex/songs.ts:21-34; library.js:54-59,184 | Keyed `reconcileList` (spec §9.1) plus B1. Never rebuild focused cards. Skip rendering when the library is not mounted. |
| S8 | `take(1000)` silently truncates large libraries | convex/songs.ts:31 | Document it or paginate; no count UI today |
| S9 | `billingData.status` sub never closed; prices hard-coded | billing.js:12,77; :22,35-36 | Unsubscribe on unmount; render from `monthlyCents`/`annualCents` |
| S10 | `confirmModal` leaks a keydown listener and uses a danger OK for notices | library.js:644-660 | Delete; Dialog `confirm()` for destructive actions only, inline errors otherwise |
| S11 | `ws.view` write has no try/catch | library.js:40 | `prefs.js` wraps every access |
| S12 | `/download` and new-tab links do nothing inside Electron (`openExternal` https-only, `window.open` denied) | desktop/main.cjs:106-108 | Hide or replace same-origin new-tab links on desktop; the web-only "Get the desktop app ↗" is fine |
| S13 | Electron denies all permission requests | main.cjs:109 | Notifications, MIDI, clipboard-read and wake lock need an allow-list or main-process IPC |
| S14 | Fonts and manifest outside `/assets/` are served as `index.html` in Electron | main.cjs:41 | Import fonts through CSS so Vite fingerprints them under `/assets/`; add `/manifest.webmanifest` to the allow-list (spec §9.2) |
| S15 | OAuth on desktop always returns to `/`; the auth lib strips its params via `replaceState` | main.cjs:35-36; oauth/client.js:155-171 | The router starts after `auth.init()`. Stash an intended route in `sessionStorage` before sign-in. |
| S16 | `?song=` is never cleared; `?checkout=success` is ignored; `/admin` for non-admins is silent | app.js:81-89 | Router redirects with `replaceState`; Plan section shows a success state |
| S17 | Share link host hard-coded | share-dialog.js:14 | `VITE_SHARE_ORIGIN` (spec §6.1) |
| S18 | Web Reprocess opens two dialogs (desktop setup and the error confirm) | library.js:417,485-489; companion.js:25-28 | Disable Re-split on web with a visible reason (spec §2.5) |
| S19 | `jobs.listActive` lacks `deviceId`, `createdAt`, `settings` and `source`; beats and import jobs are hidden | convex/jobs.ts:23-36; library.js:62 | Extend the projection for the Jobs popover (§2.8) |
| S20 | `export_only` status has no UI; writes just fail | auth.js:73-85 | Paused-account page and banner (spec §6.3) |
| S21 | Bulk delete has no server batch | convex/songs.ts:98 | Sequential `songs.remove` with a partial-failure report, or add `songs.removeMany` (≤ 100) |
| S22 | `jobs.get` subscription in `detectBeats` has no timeout or cancel | backend.js:187-211 | Jobs store owns all job subscriptions |
| S23 | Export without `showSaveFilePicker` caps at 100 MB (iPad/Safari) | export.js:15-16 | Copy must say so up front on iPad, or B-work for server-side ZIP |
| S24 | Every module is statically imported from `app.js`, including the player, notation launcher, map-mode and alphaTab paths, even for `/download` | app.js:1-15 | Router-level dynamic `import()` per place: lighter Library and download page |
| S25 | Stale comments and dead code: dedupe `songId` (backend.js:122-126,174-175), `listLibrary`, `renameSong`/`songs.rename`, `.nav-btn` (app.js:25,41), `costHint(p)` unused (library.js:494-497), `teardownLibrary` (tests only) | — | Delete during the rebuild |

**Applying the owner's no-compat decision to the shell:**
- Delete outright, with no flags and no transition UI: the old add modal and `index.html` views; `confirmModal`/`buildDialog`; `showDesktopSetup` gating; the silent global drop; the header update icon; the duplicate billing Export; the `interactions.js` hack; `modal-focus.js` (once all dialogs are native); the `woodshed:billing` and `woodshed:show-updates` events (replaced by router and commands); the `ws.companion` cleanup line.
- Keep only these one-way data upgrades, with no UI: the 13 `ws.*` keys → `ws.prefs`; legacy URLs `/?song=` → `/s/:id` and `/billing` (including `?checkout=success`) → `/settings/plan`, because Stripe and existing share-save links still produce them.

---

## 29. Capability checklist (shell portion): today → 2.0 home

| Capability today | Ref | 2.0 home |
|---|---|---|
| Google sign-in, error mapping, cross-tab sign-out reload | auth.js:96-151,89-92 | Sign-in card (§6.6); keep the auth core |
| Suspended screen with Manage billing and Sign out | auth.js:73-84 | Paused-account page (§6.3) |
| Fatal boot screen with Retry | auth.js:206-222; app.js:94-97 | Centred card plus Details (§6.3) |
| Slow-boot Retry | app.js:64-66 | 8 s "Still connecting… [Retry]" (§2.7) |
| Theme System/Light/Dark, cross-tab and native sync | theme-init.js | Settings → Appearance plus Stage always dark |
| Library search (7 fields) | library.js:114-123 | Top-bar search plus URL `?q=` |
| Group songs/albums/artists | library.js:158-180 | Group ▾ (None/Album/Artist) plus drill-down chips |
| Grid/list layout | library.js:75-89 | ▦/☰ toggle, `prefs.library.layout` |
| Processing overlay, cancel, retry, dismiss, friendly errors | library.js:291-394 | Card processing states, Jobs popover, error table (§3.6) |
| In-progress section | library.js:156 | Deleted; new cards at the front under "Adding" (§3.2) |
| Add by link/search/files; preset and stems | library.js:504-601 | Add sheet (§3.2-3.3) |
| Global drop | library.js:604-625 | Drop → Add sheet with files listed |
| Reprocess | library.js:453-491 | Re-split dialog (§3.7) |
| Card menu (7 items) | library.js:411-422 | Menu primitive (§2.5) |
| Select, select visible, bulk edit (≤ 100) | library.js:671-690 | Selection mode with bulk edit/pin/re-split/delete (§2.6) |
| Share create/copy/notation toggle/stop | share-dialog.js | Share dialog (§6.1) |
| Shared page listen and save | shared-song.js | Shared Stage (§4.13) |
| Settings: theme, stop behaviour, quality, advanced, stems, bitrate, version/updates, usage, cache, export ZIP, export originals, import legacy | settings.js:32-141 | Settings sections (§6.2) |
| Billing plans, checkout, portal, notices, export | billing.js | Settings → Plan & storage |
| Admin: policy, accounts, account edit, revoke, cancel, history | admin.js | `/admin`, `/admin/accounts/:id` (§6.4) |
| Desktop updates: icon, menu, settings, app menu | desktop-client.js; auth.js:194; settings.js:149; main.cjs:117 | Avatar dot, menu item, Settings → This device, app menu |
| Download page | desktop.js:13-97 | Kept, restyled; reused by the web Add sheet |
| Codec warning | app.js:50-61 | In-flow banner, corrected copy |
| Export ZIP streaming | export.js | Settings → Plan & storage (only copy) |
