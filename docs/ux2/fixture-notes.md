> **Superseded (I0A).** This note describes the 1.9 scratchpad fixture that FX0 used for the legacy baselines. The fixture in the repo is `tests/fixture/` (FX1); its reference is `tests/fixture/README.md` and architecture §11.2, §11.4 and Appendix C item 17.

## Full-app fixture: what was built

Everything is under `/tmp/claude-0/-home-user-woodshed/b86dd4e5-7909-507e-b288-f25d17a1e2c7/scratchpad/ux/`. No tracked repo files were changed (`git status` is clean). The Vite cache goes to `fixture/.vite-cache`, not to the repo's node_modules.

**How it works.** The real `index.html`, `app.js`, `auth.js`, `backend.js`, `companion.js`, `shared-song.js` and every other app module run unchanged. Instead of stubbing `backend.js`/`auth.js` directly, the Vite `resolveId` plugin swaps out the network layer underneath them:
- `convex/browser` is replaced by `fixture/stubs/convex-browser.js`. Its fake `ConvexClient`/`ConvexHttpClient` send every query, mutation, action and `onUpdate` to an in-memory db by function name (e.g. "songs:list"). Subscriptions update when data changes.
- `@convex-dev/auth/browser` is replaced by `stubs/convex-auth.js`, a fake `AuthClient` that starts signed in, or signed out on request.
- `@convex-dev/auth/providers/oauth/react` is replaced by `stubs/oauth.js`.
- `transformIndexHtml` injects `fixture/preamble.js` before `app.js`. In desktop mode it adds a fake `window.woodshedDesktop` bridge and intercepts the local processor's `fetch(http://127.0.0.1:47831/...)` calls. It also pre-sets per-device preferences.
- `fixture/db.js` holds the data and a handler for every Convex function the web app calls:
  - **Account:** user Kyle Kincer; settings and presets come from the real `convex/lib/presets.ts`.
  - **Library:** 12 songs. Some have album art as data-URI SVGs (via `coverUrl` or a signed `coverKey`), some use the fallback art. Stem layouts include 4 stems, 6 stems, and 2 stems (vocals/no_vocals). There is one upload with no metadata, one with a YouTube uploader only, and one with a very long album name.
  - **Jobs:** separating, downloading, queued, failed (YouTube bot check) and reprocessing.
  - **Drum part:** "Glasshouse" uses `demoScore(64,120)`, and its drum stem is rendered from the score so chart playback lines up.
  - **Tempo:** "Second Wind" has a detected tempo map, a saved loop, 0.85× speed and muted vocals.
  - **Other data:** billing states, storage usage, sharing, tempo-source search and load, MusicBrainz-style lookup and admin data.
- `fixture/audio.js` generates the stem audio as WAV blob URLs: drums, bass, vocal phrases, pads, guitar, piano, with section dynamics.
- **Scenario switches** are URL parameters, documented at the top of `db.js`:
  - `fx-auth=signedout|suspended|fail`, `fx-signinError=expired`
  - `fx-desktop=1`, `fx-companion=offline`, `fx-update=available|downloading`
  - `fx-library=empty|slow`, `fx-jobs=0`
  - `fx-billing=free|plus|cancel|grace|disabled`, `fx-admin=1`
  - `fx-media=fail|slow`, `fx-share=missing|saved`
  - `fx-view=<songs|albums|artists>-<grid|list>`, `fx-practice=chart|tracks`, `fx-notation=score|lanes`, `fx-overview=1`
- Deep links work: `/?song=<id>` opens a song (ids: glasshouse, lowtide, lanterns, secondwind, cobblestone, nightbus, jam03, shuffle, velvet, counting, metropolis, quiet). The other routes are `/share/<a3f1×16>` (shared song), `/billing`, `/admin` and `/download`.

## How to run it

```
cd /home/user/woodshed
npx vite --config /tmp/claude-0/-home-user-woodshed/b86dd4e5-7909-507e-b288-f25d17a1e2c7/scratchpad/ux/fixture/vite.config.mjs --port 5190
# open http://127.0.0.1:5190/  (add ?fx-desktop=1 to enable "Add song")
```

To re-capture everything (this starts the server if it isn't running, then runs four parallel Playwright jobs, about 8 minutes):

```
/tmp/claude-0/-home-user-woodshed/b86dd4e5-7909-507e-b288-f25d17a1e2c7/scratchpad/ux/scripts/run-all.sh
# or a single combo and filter:
cd /tmp/claude-0/-home-user-woodshed/b86dd4e5-7909-507e-b288-f25d17a1e2c7/scratchpad/ux/scripts
NODE_PATH=/opt/node-tools/node_modules node capture.cjs laptop dark "chart|transcribe"
```

`require('playwright')` resolves to the preinstalled `/opt/node-tools/node_modules/playwright`, which is why `NODE_PATH` is set. Each state runs in a fresh browser context. Logs are in `ux/run-*.log`.

Contact sheets (9 states per image) are in `ux/sheets/<device>-<theme>-NN.png`. The script that builds them is `ux/scripts/sheet.py`.

## Screenshots

`/tmp/claude-0/-home-user-woodshed/b86dd4e5-7909-507e-b288-f25d17a1e2c7/scratchpad/ux/shots/` holds 388 files: 97 states × 4 variants, with 0 failures. Files are named `<state>--<laptop|ipad>-<light|dark>.png`:
- laptop is 1440×900; ipad is 820×1180 with touch.
- Dark mode is the app's System theme with the browser set to dark.
- States marked (full page) below were captured as a whole-page screenshot.

**Sign-in and startup**
- `auth-signin`: the Google sign-in card with the theme picker.
- `auth-signin-error-expired`: sign-in with the "link expired" message.
- `auth-signin-opening-google`: the "Opening Google…" status after clicking sign in.
- `startup-loading-skeleton`: library skeleton plus the "Opening your library…" toast, while the library never arrives.
- `startup-boot-failed`: the "Couldn't open Woodshed" fatal card with Retry.
- `auth-account-suspended`: suspended account, with Retry, Manage billing and Sign out.

**Library**
- `library-songs-grid`, `-songs-list`, `-albums-grid`, `-albums-list`, `-artists-grid`, `-artists-list` (full page): every grouping and layout, including the In progress section.
- `library-songs-grid-viewport`: default first view with jobs.
- `library-no-jobs-grid`: library with no jobs.
- `library-search-results`: search for "northbound".
- `library-search-no-results`: search with no matches.
- `library-card-menu`: the ⋯ menu on a grid card.
- `library-list-row-menu`: the ⋯ menu on a list row.
- `library-select-mode`: 3 songs selected, with the Edit selected bar.
- `library-empty`: the "No songs yet" empty state.
- `library-reprocessing-card-grid`: a grid card with the reprocessing overlay (spinner, %, Cancel).
- `library-account-menu`: the account dropdown.
- `library-account-menu-admin-desktop`: account dropdown with Administration and App updates.
- `library-desktop-update-available`, `library-desktop-update-downloading`: the desktop update button in the header.
- `library-codec-banner`: Opus-unsupported state (see "What could not be rendered").
- `library-reprocess-dialog`: the Reprocess dialog.
- `library-delete-confirm`: the delete confirmation.

**Add song**
- `add-song-web-needs-desktop`: on web, Add song opens the "Add songs with Woodshed for desktop" dialog.
- `add-song-modal`: the add dialog (link/search field, drop zone, preset, stems).
- `add-song-modal-filled`: URL entered and Studio preset chosen.
- `add-song-preset-menu-custom`: Custom preset with a search query.
- `add-song-submitted-queued`: new "Queued · 0%" row after Process.
- `add-song-submitted-downloading`: the job advancing to Downloading with metadata.
- `add-song-error-processor-offline`: "Could not add song" because the local processor is disconnected.
- `add-song-drop-overlay`: the full-window "Drop audio files to add" overlay.
- `add-song-modal-drop-hover`: the drop zone highlighted inside the dialog.
- `add-song-file-uploading`: local upload row showing "Uploading".

**Song metadata**
- `metadata-edit-song`: the single-song editor (art row, lookup, fields).
- `metadata-edit-song-scrolled`: the Practice fields with an edited Tuning field highlighted.
- `metadata-find-matches`: MusicBrainz-style match results.
- `metadata-review-match`: the "Review changes" diff with checkboxes.
- `metadata-choose-cover`: album/cover choices ("Use cover").
- `metadata-untagged-upload`: editor for the upload with no metadata.
- `metadata-bulk-edit`: the "Edit 3 songs" bulk editor showing "Multiple values" and per-field apply checkboxes.

**Settings, billing, admin, download**
- `settings` (full page): all of Settings.
- `settings-advanced-open`: quality slider with the Advanced section open.
- `settings-desktop`: desktop-only items (version, originals export, legacy import).
- `billing-free`, `billing-plus`, `billing-cancel`, `billing-grace`, `billing-disabled` (full page): each plan state and its notice.
- `billing-checkout-error`: the error toast after Get Plus fails.
- `admin` (full page): admin overview with one account opened.
- `download-page` (full page): the /download page, filled from the bundled `downloads.json`.

**Player: Tracks view**
- `player-loading`: "Preparing your song" with skeleton tracks.
- `player-tracks-drums-song`: Glasshouse tracks, drums muted, section labels on the timeline.
- `player-tracks-6-stems`: Paper Lanterns.
- `player-tracks-2-stems`: Night Bus.
- `player-loop-speed-muted-overview`: saved A–B loop, 0.85×, muted vocals, overview strip.
- `player-zoomed-grid-quarter-snap`: zoomed in, 1/4-beat grid, snap on.
- `player-solo-and-volume`: bass soloed, drums volume lowered.
- `player-playing`: during playback.
- `player-metronome-popover`: metronome on, count-in checked.
- `player-detect-beats`: "Listening for beats…" status.
- `player-load-error`: "Couldn't reach storage" with Try again.
- `player-help-tooltip-button`: hovering the "?" button (see "What could not be rendered").

**Tempo map**
- `tempo-map-mode`: Second Wind with its detected map.
- `tempo-map-drum-song`: Glasshouse map with section labels.
- `tempo-map-default-unmapped`: a new map ("Pin here", placeholder 120).
- `tempo-map-more-menu`: the ⋯ tools menu.
- `tempo-map-all-keys`: the map's full keyboard-help overlay.
- `tempo-map-edit-bar`: the bar editor (beats, groups, pickup, label, scope).
- `tempo-sources-dialog`: "Find a tempo map" with search results.
- `tempo-sources-trying-map`: auditioning a Chorus map (offset controls, Keep map).

**Practice Chart**
- `chart-practice`: the alphaTab chart.
- `chart-hands-feet`: hands/feet voicing.
- `chart-chorus-loop-playing`: Chorus selected, looping, playing.
- `chart-empty-state`: "No drum chart yet" with Import and Open Transcribe.

**Transcribe**
- `transcribe-score`: the score editor.
- `transcribe-lanes`: the Drum lanes view.
- `transcribe-kit-panel`, `transcribe-properties-panel`, `transcribe-listen-panel`: each side panel.
- `transcribe-commands-menu`: the ••• commands menu.
- `transcribe-shortcuts-dialog`: the "Drum shortcuts" key-mapping dialog.
- `transcribe-empty-song`, `transcribe-lanes-empty-song`: a song with no drum part.

**Sharing**
- `share-dialog-active-link`: share dialog from the player header, link active.
- `share-dialog-new`: before a link exists ("Create link").
- `share-dialog-created`: the link just created.
- `shared-song-signed-in`: /share page with the chart and "Add to library".
- `shared-song-signed-out`: "Sign in to add".
- `shared-song-already-saved`: "Open in library".
- `shared-song-tracks`: shared song in the Tracks view.
- `shared-song-unavailable`: "Song unavailable".

## What could not be rendered, and things noticed along the way

- **Player keyboard help:** the "?" button has no help panel; its text exists only as a native `title` tooltip, which Chromium does not draw in screenshots. `player-help-tooltip-button` shows only the hovered button. Keyboard help that does render is in `tempo-map-all-keys` and `transcribe-shortcuts-dialog`.
- **Codec warning banner:** it does get shown (`#deps-banner` loses `.hidden` and is `display:flex`), but it sits at y≈38px behind the app header, so `library-codec-banner` looks identical to the normal library. This looks like a real layering bug in the app, not a fixture problem.
- **Not captured on purpose:**
  - Native `window.confirm`/`prompt`: discarding unsaved metadata and admin reasons. They are auto-accepted.
  - The OS file picker.
  - Real Stripe or Google redirects. Checkout and portal return a fixture error, shown in `billing-checkout-error`.
  - Real artwork uploads (`artworkUpload.prepare` throws).
  - Desktop-only native update dialogs.
  - Electron window chrome.
  - Library ZIP export: it would run against the fixture, but it produces a download, not a screen.
- **Other UX observations from the captures, for the redesign:**
  - A search with no matches shows the first-run empty state ("No songs yet / Add your first song").
  - Failed jobs show only "Failed" plus Retry/Dismiss in the In progress list; the plain-language reason is only in a hover tooltip.
  - The shared-song Tracks view pushes the transport below the fold on laptop.
  - The bar readout shows "Bar —" before the first downbeat.
  - The empty Transcribe staff shows a "rendered by alphaTab" watermark.
- **Fixture limits:**
  - Audio is synthetic and decoded duration equals the song's listed duration, so long songs like Metropolis (9:23) take a few seconds to generate when opened.
  - Running job percentages creep forward every 4 s; scenarios freeze them where it matters.
  - Matches from the metadata lookup use SVG covers supplied through Playwright route interception. Opened by hand in a browser, those cover images fail and are removed, as the app does.