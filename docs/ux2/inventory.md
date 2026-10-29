
# Woodshed 1.9.0: functional and interaction inventory (research only, no repo files changed)

Scope read: index.html, all of src/js (including notation/), src/css plus the co-located js/*.css, desktop/main.cjs, preload.cjs, update-controller.cjs, update-policy.cjs, media-proxy.cjs, companion/server.mjs routes, and the convex/*.ts function surface. Citations are `file:line` relative to /home/user/woodshed. No files were written. The scratchpad was not needed.

---
## 0. Global shell, navigation and cross-cutting patterns

**Entry routes** (app.js:103-105). `/download` goes to the marketing download page (desktop.js:13). `/share/<64-hex>` goes to the shared song view (shared-song.js:8). Every other path boots the app (app.js:63).
- Deep links: `/billing` (app.js:81), `/admin` for admins only (app.js:83), `?song=<id>` opens a song after boot (app.js:85-89).
- **No history integration.** `showView` (app.js:21-34) never pushes a URL. The only history call is `replaceState` in shared-song.js:39. Browser Back leaves the app, and views cannot be bookmarked.
- View switching uses View Transitions and honours reduced motion (motion.js:7-29). `.nav-btn` toggling in app.js:25,41 is dead code; no `.nav-btn` element exists any more.

**Header** (index.html:26-38):
- Back chevron `#header-back`, visible on any view except the library (record-club.css `.header-back` rules).
- Wordmark "Woodshed" acts as the Home button.
- `#header-song` slot is filled by the player.
- "＋ Add song" button.
- `#user-button` holds the account `<details>` menu and a separate Settings gear (auth.js:153-204).
- Account menu: email, Plan & billing, Administration (admins only), App updates (desktop) or Download desktop app (web), Sign out (auth.js:188-196). It closes on outside click or Escape (auth.js:202-203).
- Desktop adds an update-download icon before the user button (desktop-client.js:33-40). It is shown only when an update is available, downloading or ready (desktop-client.js:9).

**Feedback primitives.** There are five distinct mechanisms, which is a pain point:
- Toast `notify()`: auto-dismisses after 6 s unless it is an error, and has a Dismiss button (feedback.js:3-19).
- In-button progress `withButtonProgress()` (feedback.js:21-35).
- Inline `role=status` lines in each panel (map inspector, tempo sources, chart hint, notation footer, share dialog, metadata footer).
- Native `alert()` for job retry failures (library.js:383) and `window.confirm` to discard metadata edits (song-metadata.js:108).
- `window.prompt` for admin reasons (admin.js:62), plus the custom `confirmModal` (library.js:644-660).

**Modals** use `focusModal()` for role=dialog, a focus trap, Escape and focus return (modal-focus.js:1-29).
- Users: add modal, share, metadata, notation dialogs and library dialogs.
- The desktop setup prompt uses a native `<dialog>.showModal()` instead (desktop.js:3-12).
- Escape handling differs. `confirmModal` adds its own document keydown listener (library.js:656-658), which is only removed on Escape. Metadata deliberately ignores outside clicks (song-metadata.js:117). The share, add and reprocess modals close on backdrop click.
- The player suppresses its shortcuts when any dialog is open (player.js:1073).

**Pointer and keyboard hygiene.** interactions.js:7-38 blurs mouse-clicked controls so Space never re-fires a button. Tab restores normal focus semantics. Focus rings come from record-club.css (the `:is(button,a,...):focus-visible` rule).

**Theme**: System, Light or Dark.
- Runs before paint in public/theme-init.js and is persisted as `ws.theme`.
- Syncs across tabs through the `storage` event.
- Fires `woodshed:theme`, which player, chart and editor listen to for redraws.
- Desktop persists the choice natively in appearance.json (desktop/main.cjs:18-21,84-90).
- The theme select appears on sign-in (index.html:134), in Settings (settings.js:33-37), on the download page and in the shared header (shared-song.js:14).

**Advisory banner** (app.js:50-61): an Opus codec warning.
- Its copy says "switch stems to FLAC in Settings". No FLAC option exists in Settings (stale advice).
- Its CSS still offsets `left:210px` for a removed sidebar (styles.css:257).

**CSS layering.** styles.css is the base, record-club.css overrides it (and contains later override blocks of its own), then motion, download, theme, sharing, tempo-map, tempo-sources, chart.css, notation.css, song-metadata.css and score-view.css.
- There are three visual languages:
  - square 2px "record club" controls (record-club.css:106-110)
  - pill-shaped segmented controls in the new chart and practice switch (chart.css:7-15,37-40)
  - rounded 6-10px cards in Settings (record-club.css, the `#settings-root` block)
- Dead selectors remain for removed UI: `.mp-bpm`, `#m-sig`, `.mp-edit`, `.mp-item`, `.preset-grid` and `.preset-card` (record-club.css:106,113,119), `.connection-status`, `.account-name`, `.account-more` and `.be-hint` (record-club.css:126).
- Some light-mode colours are hard-coded: `.mp-item.active #e9eefb`, `.preset-card.selected #e8edfc`, loop fill `#174bd118` (record-club.css:99), and Settings hint colour `#58625b`.

---
## 1. Startup and auth

- The boot shell is `data-startup=loading`. It shows a library skeleton of eight cards (index.html:72) and "Opening your library…" (index.html:94). A "Taking longer than expected? Retry" reload appears after 12 s (app.js:64-66).
- `ensureSignedIn` (auth.js:17-94) runs these steps:
  - Shows "Not configured" if `VITE_CONVEX_URL` is missing.
  - Restores the session and only renders sign-in when it is truly signed out (startup.js:19-32).
  - Waits for backend auth confirmation, loads `users.me` and enforces suspension. A suspended account sees "Account suspended" with Manage billing and Sign out (auth.js:73-85), and this is re-checked live (auth.js:86).
  - Signing out in another tab reloads this one (auth.js:89-92).
- **Sign-in screen** (auth.js:96-151): Google is the only provider.
  - It shows a status line and "New here? Signing in creates your free account."
  - OAuth error codes are mapped to friendly messages (auth.js:123-128).
  - Desktop OAuth returns through http://127.0.0.1:47832/oauth/callback, which shows a "Return to Woodshed" page in the browser (desktop/main.cjs:35-39).
- **Fatal screen** `showFatal` (auth.js:206-222): a title, a message and Retry (reload).
- After auth, boot loads `admin.access` and `settings.config` in parallel (app.js:70-72), then mounts the user button, Settings, library subscriptions and the codec banner. It then opens `?song` and, on desktop, initialises the companion and updates (app.js:90-93).
- Boot failures show "Couldn't open Woodshed" (app.js:95-97).

---
## 2. Library

**Layout** (index.html:42-77):
- "Library" h1.
- Group segmented control: Songs, Albums or Artists.
- Layout toggle: icon-only Grid or List.
- Search box with placeholder "Search songs, artists, albums".
- "Select songs" bar.
- Grid container and empty state: "No songs yet." with "＋ Add your first song".

**Data.** Live Convex subscriptions to `songs.list` (newest first, capped at 1000; convex/songs.ts:30-31) and `jobs.listActive` (library.js:53-65).
- Only `kind==='separate'` jobs show in the library (library.js:62). Beat-detection and import jobs are invisible there.
- There is no user sort, no filter other than search, and no recently practised or recently added view.

**Persistence.** `ws.view` stores `{group, layout}` (library.js:35-40). It is pre-applied before paint by theme-init.js.

**Search** matches title, uploader, artist, album, albumArtist, genre and tags (library.js:123). In-progress cards match on title, uploader, artist and album (library.js:126).

**Grouping**:
- Albums or Artists sections sorted A to Z, each with a header showing cover art, title and count (library.js:158-180, 248-260).
- Unknown values are bucketed as "Unknown album" or "Unknown artist".
- The secondary line shows the album in the Artists view and the artist otherwise (library.js:245).

**Grid card** (library.js:262-275):
- Full-card invisible `song-open` button.
- Stem badge: "N stems", or the stem names when fewer than 4.
- ⋯ menu button. In base CSS it appears only on hover (styles.css:158,179); record-club.css:49 forces opacity 1. It is a 28-32px circle.
- Cover, title, and a sub line with artist and duration.

**List row**: thumbnail, title, sub line, badge (hidden under 700px), duration and ⋯ (library.js:277-289).

**Card ⋯ menu** (library.js:411-446):
- Items: Play; Share song…; Reprocess… (only if the song has a source); Edit song…; Select songs…; Open original source (only for http sources); Delete (danger).
- It is a hand-positioned `.ctx-menu`. It closes on mousedown outside or Escape. It has no arrow-key navigation, no focus move into the menu and no menu role.

**Processing states**:
- Pending cards sit in an "In progress" section that is always rendered as a list (library.js:156,256).
- Reprocess jobs overlay the existing card (library.js:120).
- Stage labels: Queued, Uploading, Downloading, Separating, Finishing (library.js:98-101), shown with a percentage bar.
- The only action while running is Cancel (library.js:333, 347).
- On error the card shows "Failed", a friendly message (library.js:296-309) with the raw error in the tooltip and the console, plus Retry and Dismiss (library.js:319-349).
- Upload progress is patched in place (library.js:629-637).

**Selection mode** (library.js:671-690):
- Toggle "Select songs" / "Done selecting", a count capped at 100 ("(maximum 100)"), "Select visible" / "Deselect visible", and "Edit selected" (bulk metadata).
- No bulk delete, share or reprocess.
- Card click toggles selection while selecting (library.js:360).

**Delete**: `confirmModal("Delete song?")` (library.js:448-451).

**Reprocess dialog** (library.js:453-491): Quality preset (including Custom) and Stems.
- The cost hint text is "Downloads and processing run on this computer. Higher quality takes longer." (library.js:494-497). The comment above it still says "rented GPUs", so the code and copy disagree.

**Pain points**:
- Desktop-only actions are hidden behind a modal on web. Clicking Add on web opens the desktop dialog (library.js:524).
- The global window drop handler (library.js:604-625) uploads immediately with default settings and no confirmation. On web this ends in a companion error card.
- The hover-reveal menu relies on a CSS override to be visible.
- There is no keyboard path to Delete other than Tab to ⋯ and then Tab within the menu.

---
## 3. Add song and processing (desktop companion required)

**Add modal** (index.html:97-124; library.js:504-569):
- "Link or search" text input. Accepts YouTube, Spotify or SoundCloud URLs, or free text to search. `classifyInput` decides spotify, url or search (backend.js:112-117).
- Drag-and-drop zone and "Choose files…" with an accepted extension list (index.html:108; backend.js:149).
- Quality preset select, Stems select and a preset description.
- Cancel and Process. Enter in the URL field submits (library.js:546).
- Picking or dropping files closes the modal and uploads at once (library.js:551-566).
- Errors appear as `confirmModal('Could not add song')` (library.js:544).

**Gate**: `requireCompanion()` (companion.js:36-41).
- Without the desktop bridge it shows `showDesktopSetup()` ("Add songs with Woodshed for desktop": Keep browsing / Download Woodshed; desktop.js:3-12) and throws.
- Error copy says "Retry the desktop connection in Settings" (companion.js:30,38). **No such control exists in Settings** (stale; the `.connection-status` CSS is orphaned).

**Flow**:
- `jobs.createSeparation` is called with source, deviceId and settings (backend.js:127-136).
- Dedupe can return an existing `songId` with no job.
- Uploads go to the local companion `/upload`, then a job is queued (backend.js:162-179; companion/server.mjs:190).
- Reprocess passes `replaceSongId` (backend.js:139-147).

**Presets** (convex/lib/presets.ts): Studio, Balanced (default) and Fast.
- Models: htdemucs_ft, htdemucs, htdemucs_6s ("With piano & guitar", which yields guitar and piano stems) and mdx_extra.
- Stem modes: full, drums+rest, vocals+rest, bass+rest.
- Opus bitrates: 128, 160, 192 (recommended) or 256.

**Desktop quit guard**: quitting while a song is processing asks "Keep processing / Quit Woodshed" (desktop/main.cjs:111-116).

---
## 4. Song metadata and enrichment

**Editor modal** `editSongs(songs)` (song-metadata.js:70-365):
- Opened from the header pencil (22×22px, song-metadata.css:222-237), the card menu or bulk select.
- **Fields** (song-metadata.js:6-19):
  - Song details: Title (required), Artist, Album, Album artist, Release year (pattern 4 digits), Genre, Track number, Disc number.
  - Practice: Musical key, Tuning, Personal tags (comma-separated), Notes (textarea, 10k characters).
- Edited fields are marked `is-edited`. Save stays disabled until something changes.
- Closing with changes asks `window.confirm("Discard your unsaved changes?")`.
- **Artwork** (single song only): Choose another cover (MusicBrainz search, cover only), Upload image (JPEG, PNG or WebP, 2 MB or less, validated with createImageBitmap), Remove artwork, live preview, and a deterministic geometric fallback sleeve (artwork.js:2-19).
- **Lookup**: "Find another match" opens an inline search panel with Title, Artist, Search and Close search, plus MusicBrainz and Cover Art Archive attribution.
  - Each result offers Review and "Albums / covers".
  - Review shows a field-by-field diff with checkboxes, then "Use selected details".
  - Locked or touched fields are unchecked by default (song-metadata.js:191-323).
- Status "Finding song details…" shows only when `metadataStatus==='pending'` (song-metadata.js:90).
- **Bulk** mode has per-field "apply" checkboxes; checked empty fields are cleared (song-metadata.js:86,90).

**Automatic enrichment** runs server-side (`metadataLookup.enrich`, `metadata.applyAutomatic`).
- `metadataStatus` 'uncertain' and 'unavailable' are **never surfaced** in the library or player. The design intent of an optional review queue for uncertain matches (docs/song-metadata-design.md:10,13) is not reachable except by opening each song.

**Pain point**: practice information (key, tuning, notes, tags) is invisible while practising. The player header shows only the title and "artist · album · N stems" (player.js:228-235).

---
## 5. Settings view (settings.js:25-260)

1. **Appearance**: theme select.
2. **Playback**: "When playback stops" is either "Return to edit cursor (default)" or "Stay at playback position". It is stored per device as `ws.stopBehavior` (settings.js:38-43; preferences.js:6-12).
3. **Song defaults** (server, per user):
   - Quality preset is set by a slider *and* a row of preset label buttons that drive the same value (a duplicated control; settings.js:51-52).
   - Advanced `<details>`: Model, Quality passes (0-10), Overlap (0.1-0.75). Any change switches to "Custom" (settings.js:54-77, 238-246).
   - Stem layout (settings.js:79-88). Sync bitrate, with the hint "affects newly processed songs; reprocess to convert" (settings.js:90-99).
   - Changes save on every change through a serialized queue. Failures show a toast saying "Change the setting again to retry" (settings.js:197-203).
4. **App Version**: web version number, or desktop version plus "Check for updates" (settings.js:103-107,143-150).
5. **Storage & plan**:
   - Cloud usage text and a meter, including the paused-uploads warning (settings.js:166-170).
   - "Plan & billing" button.
   - **Playback cache**: size shown, with Clear cache (Cache API `woodshed-stems-v1`, stemcache.js:10-55).
6. **Library management**:
   - Export synced library ZIP (export.js).
   - Export original audio files (desktop only, companion `/export-originals`).
   - "Import an old Woodshed library" `<details>` with an optional directory and auto-detect (desktop only; settings.js:121-141,152-163).
   - Desktop-only controls are visibly disabled on web rather than explained.

---
## 6. Account, billing and admin

**Billing view** (billing.js:10-81), live from `billingData.status`:
- Usage line, a Free plan card, and a Plus card with a Monthly/Yearly toggle ($2/month or $20/year), "Get Plus" (Stripe checkout) and "Manage subscription" (portal).
- An "Export library" duplicate.
- Notices: upgrades not enabled, cancel-at-period-end, and the 14-day grace period.
- All buttons lock while a redirect is pending.

**Admin view** (admin.js):
- Storage overview, and a "Change storage policy" form whose reason field is required.
- Account search by exact email, with paging.
- Account detail: status (active, export_only, suspended), storage override, private notes and a required reason.
- Device revoke and job cancel, each asking for a reason through `window.prompt` (admin.js:62).
- Audit history with "Load more".

---
## 7. Player shell

**Opening a song** (`openPlayer`, player.js:221-333):
- Header slot: cover, title, "artist · album · N stems", the pencil Edit button and the Share button. Edit and Share are hidden when read-only (player.js:226-241). The header is live-updated through `songs.get` (player.js:247).
- **Loading state**: skeleton waveform rows with saved mute and solo state, every control disabled, and a centred progress card "Preparing your song" (player.js:248-265).
  - Progress text cycles through "Loading audio · x / y MB", "Decoding audio · n of N tracks ready" and "Preparing pitch-preserving playback…" (player.js:298-308).
- **Error states**:
  - "Couldn't reach storage: …"
  - "Missing stem audio for: … Try reprocessing this song."
  - The codec decode error (stemcache.js `codecErrorMessage`).
  - "Couldn't load audio: …"
  - Each shows "Try again" (player.js:266-313).
- The whole markup is re-rendered after load (player.js:331), then `arrangePlayerControls` regroups it (player-layout.js:2-44).

**Resulting layout, top to bottom**:
1. **Workspace nav**: tabs "Practice | Transcribe", a spacer, and the Practice view switch "Chart | Tracks" (player-layout.js:30-32; launcher.js:23-27). Two nested levels of mode switching.
2. **Timeline tools**: zoom group and grid group (player-layout.js:24).
3. Time ruler with "Tracks" label and time scale (player-layout.js:26-29).
4. Tempo lane (map mode only).
5. Stem tracks.
6. Overview minimap (optional).
7. Map strip (inspector and tempo sources).
8. Chart and editor hosts (inserted before the transport; launcher.js:20).
9. **Transport**: a `transport-main` row and a "practice strip" loop row.

**Leaving the player**: `closePlayer` destroys the engine, metronome and listeners, and flushes saves (player.js:206-219,1030).

**Pain points**:
- **The song always opens at 0:00.** Playhead, edit cursor, zoom window and follow state are not restored.
- The waveform view is fully re-rendered after load.

---
## 8. Transport (player.js:111-166, 726-801, 973-992)

**Controls**:
- **Play/Stop** `#play` (Space). The label changes among Play, Stop, Resume and Cancel count-in, and the icon among ▶ and ■ (player.js:731-737).
- **Pause/Resume** `#pause` (Enter). It is disabled when idle.
- Stop returns to the **edit cursor** (dashed line) unless the stay preference is set (engine.js:269-273; player.js:738-743).
- The end of the song auto-stops (engine.js:341-349).
- Readouts:
  - Time `m:ss.cc / m:ss`, or "Count-in · Ns" during a count-in.
  - "Bar n / N · Beat b" from the song map (player.js:816-819).
  - "Start m:ss.cc", the edit cursor (player.js:114,1045).
- The Speed group (see §11), Metronome (M), Tempo map (Shift+M), Reset mix (0), and **"?"**.

**"?" pain point**: the `?` button has **no click handler**. It is only a `title` tooltip listing shortcuts (player.js:165), so touch and keyboard users cannot read it.
- The tooltip is also inaccurate. It says "←/→ seek (shift=1s)", but the default step is 5 s (player.js:1089-1090). It omits Escape, the chart and Transcribe.
- By contrast, the tempo map has a real key sheet (map-mode.js:90-92,578).

**Practice strip** = loop row (§10).

**Global keyboard** (player.js:1067-1107; precedence matters):

| Key | Action |
|---|---|
| Space | Play/stop, even when a mouse-clicked button has focus |
| Enter | Pause/resume |
| M | Toggles the metronome **popover**, not the click itself, though the tooltip says "Metronome (M)" |
| G | Grid on/off |
| Shift+S | Snap |
| ← / → | Seek ±5 s (Shift ±1 s) |
| , / . | Seek ±50 ms (Shift ±10 ms) |
| [ / ] | Set loop A or B at the playhead |
| L | Loop toggle |
| Home / End | Loop A or B, else song start or end |
| − / = | Zoom out or in around the playhead |
| \ | Fit |
| 0 | Reset mix |
| 1-9 | Mute stem N |

- Order of handling: tempo sources capture everything; then dialog suppression; Escape closes the metronome popover; map mode keys; Shift+S; Transcribe keys (which **swallow all other player keys** while Transcribe is active; launcher.js:103); then the global set.
- Mixer, loop and speed changes have no undo.

---
## 9. Waveforms, tracks and mixer

**Track row** (player.js:66-80): colour dot and stem name, Mute, Solo, volume slider (0-1, no numeric readout, no pan, no per-track reset), and a waveform canvas.
- Muted or unsoloed tracks are drawn at 28% opacity (player.js:367-377; waveform.js:35-59).
- Stem colours come from theme tokens (player.js:30-38).

**Timeline interaction** on `#timeline-interact`, using **mouse events only** (mousedown and mousemove on window; player.js:602-671):
- Click seeks and sets the edit cursor, snapping to the grid if Snap is on.
- Drag creates a loop. Drag within 7 px of A or B resizes it (EDGE_PX, player.js:599). Drag inside the loop moves it.
- Hover shows a cursor-type change and a time tooltip `m:ss.cc` (with a "grid" suffix when snapping).
- **Pain points**: no touch or pointer support (iPad dragging fails); loop handles are a 2px line with a 14×13 flag (styles.css:339-340); there is no keyboard equivalent of clicking a position other than nudging with ←/→ and , and .

**Wheel**: vertical scrolls zoom at the cursor, horizontal or Shift-scroll pans, and Ctrl/⌘ (pinch) zooms (timeline-navigation.js:10-24; player.js:581-595). Wheel input during playback turns Follow off.

**Timeline tools**: −, +, Fit, **Follow** (pressed state; scrolling pauses it; player.js:540-547) and **Overview** toggle (persisted as `ws.overview`).
- **Grid**: "On/Off" (the label flips), a division select (Beat, 1/2 beat, 1/4 beat) and **Snap** (disabled when the grid is off). The grid is persisted both in `ws.grid` and in per-song `practice.grid`, and the song value wins (player.js:58-64,329,553-579).
- The minimum zoom span is 0.25 s (player.js:35). Ruler labels switch to centiseconds below 10 s (player.js:450).

**Overview minimap** (player.js:464-488, 673-713): a muted waveform of the first stem, a viewport bracket (drag to pan, drag edges within 6 px to zoom, click to seek), the loop region, the playhead and the edit cursor. Mouse-only; the help is only a title attribute (player.js:102).

**Grid and tempo flags**:
- Beat, bar and subdivision lines are drawn on a canvas (player.js:439-462).
- Outside map mode, meter-change and section-label flags appear over the waveform (map-mode.js:631-648).

**Mixer state** is saved per song (§17). Reset mix sets volumes to 1 and clears mute and solo (player.js:796-801).

**Mute duplicates**: track Mute buttons, digit keys, the chart's "Mute drums" and the Transcribe Listen panel's "Mute recorded drums". All of them sync back to the track buttons (player.js:1008, onMixerChange).

---
## 10. Loop / A-B

**Practice strip** (player.js:117-130):
- "Loop" toggle (L).
- A readout `[−][A time][+]` → `[−][B time][+]` with ±50 ms nudges (player.js:757-766). The readouts are buttons that jump to A or B (Home/End; player.js:768-777).
- Length "(x.xxs)".
- "A⇤" and "⇥B" set A or B at the playhead with snap (player.js:755-756).
- "Clear" (player.js:754).

**Hidden behaviours**:
- Turning Loop on with no region loops the **visible window** (player.js:750).
- `[`/`]` and the A⇤/⇥B buttons compute the opposite edge differently (player.js:1093-1094 vs 755-756).
- The engine refuses loops shorter than 20 ms (engine.js:307). The loop wraps the playhead (engine.js:143-148).

**Other loop entry points**, each with a different model:
- Waveform drag (§9).
- Chart: drag across bars, long-press then tap on touch, and "Loop section" (§13).
- Transcribe: "Loop" on the bar range (editor.js:287).
- Tempo map: P "Loop these bars", a temporary preview that restores the user loop (map-mode.js:399-429).
- Loop A/B values display in seconds only. Bars are never shown.

---
## 11. Speed / pitch

- **Speed** slider 0.5-1.5× in 0.05 steps with an "x.xx×" readout. Double-click resets to 1.00× (hidden; tooltip only; player.js:135-136, 780-783). There are no preset chips and no keyboard shortcut.
- **Keep pitch** toggle, default on (player.js:137,784-794). Stored per device as `ws.preservePitch`, while the rate is stored per song, which is inconsistent.
- Engine behaviour:
  - Native playback at 1× or with Keep pitch off.
  - Signalsmith multichannel stretch keeps stems phase-coherent (engine.js:1-6,83-111,168-218).
  - Changing speed, pitch, loop or seek during a count-in cancels the count-in (engine.js:279,291,297,304).

---
## 12. Metronome, count-in and beat detection

**Metronome popover** `#metro-pop` (player.js:168-193; player-layout.js:35-43), opened with the Metronome button or M:
- Close button, On/Off toggle (the label shows state: "Off" or "On"), Accent checkbox, Vol slider.
- **Count-in & pre-roll** fieldset: Count-in checkbox, length 1-16 and unit Bars or Beats (both disabled when Count-in is off), and "Audible pre-roll".
- "At the playhead" readout (pulse = bpm · meter, live; player.js:845-849,1055-1058).
- "Map tempo & meter" duplicates the Tempo map button.
- "Detect beats" with an inline status line.
- Positioned absolutely above the transport (player.js:865). Under 700px it becomes a fixed bottom sheet (record-club.css:126). Escape closes it (player.js:1074).

**Click synthesis**: 1600 Hz accent and 1050 Hz beats, scheduled on the audio clock from the song map with the felt pulse in compound meters (metronome.js:112-136,164-177).

**Count-in** follows the map's tempo and meter at the start point (metronome.js:139-161; engine.js:220-244). Space or Pause cancels it. Audible pre-roll plays the audio leading in, and silence before 0:00 is kept.

**Detect beats**: BeatNet on Modal through a desktop companion job (`jobs.createBeatDetection`; backend.js:187-211).
- It fails on web with the desktop error, and is disabled in shared view (player.js:948).
- On success it replaces the song map and keeps bar IDs (metronome.js:68-70; song-map.js:115-119), auto-enables the click, and says "⌘Z there undoes detection" (player.js:950-970).

**Persistence**: settings plus the song map are saved per song through `songs.saveTempo`, debounced 400 ms (player.js:833-842; metronome.js:53-65).

---
## 13. Tempo map mode (map-mode.js) and sources/import (tempo-sources.js)

**Enter or exit**: the "Tempo map" button (aria-pressed), Shift+M, the popover button, and Transcribe's "Bar meter & label…" or "Align in tempo map…". Done or Esc exits.
- Entering forces the Tracks view (leaves the Chart; player.js:909), turns on the metronome and grid, and restores both on exit (map-mode.js:502-534).
- Disabled in shared view (map-mode.js:536).
- The edit cursor is hidden while mapping (tempo-map.css:8-9).
- **Possible issue**: entering from Transcribe's Score view leaves the waveform hidden (`.notation-expanded` hides tracks; notation.css:17) while the lane shows.

**Tempo lane** (inserted after the ruler, map-mode.js:97-102; drawing in map-lane.js):
- Bar ruler with numbers, meter chips and labels.
- Tempo curve: flat steps for steady spans, slopes for ramps, **amber** for suspect spans (map-lane.js:3,118,138).
- BPM scale, selected line and playhead.
- Pointer:
  - Click selects the nearest line; the top 22 px selects bars only.
  - Drag a pin handle (hit box ±7×9 px) to move it, with the refusal reason shown.
  - Hover shows a tooltip.
  - Double-click pins or unpins (map-mode.js:651-704).

**Inspector** (map-mode.js:45-92):
- Cells: Bar (or "Go to N" while typing digits), Meter with groups and label, Tempo (with unit glyph and ramp arrow), and Pin (time or "free").
- Actions: Pin here [D] / Unpin [⌫], Tap along [Space] / Stop, Edit bar [E], "Find / import…", "More" ⋯ menu, Undo, Redo, Done.
- Contextual hint row plus "All keys ?" (map-mode.js:131-145). A status message has tones: info, ok and error.
- **More menu** (role=menu, arrow keys and Esc; map-mode.js:178-207, 555-559):
  - Ramp to the next pin (R) and Loop these bars (P).
  - Double (*) and Halve (/) the tempo.
  - "Snap taps to drum hits" (`ws.tapSnap`).
  - "Calibrate tap timing": 12 clicks; stores `ws.tapOffset` within ±200 ms (map-mode.js:478-499).
  - Detect beats automatically.
  - All keys.
- **Edit bar form** (in place):
  - Beats n/d (1-16; d is 1, 2, 4, 8 or 16), Groups (e.g. 2+2+3), Pickup length (bar 1 or partial bars only), Label (120 characters).
  - Apply to: This bar / Until next change / To the end.
  - Keep in place: Beats or Bar lines.
  - Tempo (open spans only), Ramp to next pin.
  - Cancel and Apply ↵ (map-mode.js:70-88, 340-396).
- **Key sheet** `MAP_KEYS` (map-mode.js:27-31):

| Key | Action |
|---|---|
| ← / → | Bars (Shift: beats) |
| ⌘ ← / → | Pins and meter changes |
| digits, then ↵ | Go to bar |
| Home / End | First or last bar |
| D / T | Pin downbeat or beat at the playhead, or tap while playing |
| , / . | Nudge 10 ms (Shift: 1 ms) |
| ⌥ ← / → | Renumber the pin |
| ⌫ | Unpin |
| ↑ / ↓ | Beats per bar (Shift: this bar only) |
| ⌥ ↑ / ↓ | Tail tempo (Shift: 0.1) |
| E / R / P | Edit bar, ramp, preview loop |
| * and / | Double or halve |
| ⌘Z, ⇧⌘Z, ⌘Y | Undo, redo |
| ? | Key sheet |
| Esc | Layered close |

- Handled in map-mode.js:562-616.
- Tap passes undo in one step (map-mode.js:448-475), with latency compensation (map-mode.js:432-447). Edits that would strand notation are refused by guards (player.js:878-900; part.js:65-75).
- **Keyboard-only features**: renumbering, beats-per-bar ±, nudging pins, tail tempo and go-to-bar have no pointer equivalent other than Edit bar. On narrow screens the hint row is hidden (tempo-map.css:127) and the mode label too (tempo-map.css:126).

**Find / import panel** (tempo-sources.js:28-48), opened from the inspector or the chart empty state:
- While it is open, all other editors are made inert (tempo-sources.js:17-22). Player shortcuts are disabled; Esc cancels and Space auditions (player.js:1069-1072; tempo-sources.js:243-249).
- **Search**: "Song or artist", pre-filled from artist and title, auto-searches on open. Searches Chorus Encore and Harmonix Set (`tempoSources.search`).
- **Results** are toggle buttons: title, artist, album, source, "Chart by …", "Drum chart" and duration, with a Try/✓ mark.
- **Import a file…**: .gp3, .gp4, .gp5, .gpx, .gp, .sng, .zip, .mid, .midi, .chart, .txt, .tsv, .lab, .csv (tempo-sources.js:35). Files are parsed locally and never uploaded.
  - Limits: 10 MB tempo files (tempo-import.js:5), 128 MiB packages (tempo-archive.js:6,18), 32 MiB expanded Guitar Pro (guitar-pro-bounds.js:6). Many specific error messages exist (tempo-archive.js, guitar-pro-import.js).
- "Other sources" `<details>` links to enchor.us and Songsterr, pre-filled with the song (tempo-sources.js:36,154-160).
- **Align**:
  - "Listening to" shows the current candidate. Play/pause.
  - Duration-mismatch warning when lengths differ by more than 2 s (tempo-sources.js:72-73).
  - Offset in ms with ±10 and ±100 buttons.
  - "First downbeat → cursor" aligns to the edit cursor. Reset offset.
- **Commit**: "Your map" (restore the original), "Use map & import drums" (only when drum hits exist, with a count and skipped hits), "Keep map", and Cancel, which restores the map and its undo history (tempo-sources.js:165-181,195-212).

**Label and naming pain points**:
- The chart empty state says "**Tempo map → Import**" (chart.js:80), but the button is "**Find / import…**".
- Transcribe's menu has "**Import…**", which imports a `.woodshed.json` part, an entirely different importer (editor.js:117).

---
## 14. Notation: Practice Chart (chart.js) and Transcribe (editor.js)

**Workspace logic** (launcher.js):
- Practice defaults to Chart when the part has notation, unless this device last chose Tracks (`ws.practice.view`; launcher.js:93-98).
- Only the Chart/Tracks switch remembers the choice (launcher.js:65-69).
- The Transcribe tab is always visible, including read-only.
- Loading and error states: "Loading chart…" or "Loading notation…", and "Couldn't open …" with Try again (launcher.js:59-86).
- In Chart mode, the timeline tools, tracks, ruler, overview, lane and map strip are hidden. The transport is sticky (chart.css:32-34).

**Chart toolbar** (chart.js:29-42):
- Section chips from tempo-map labels ("Start" or "Bar 1" when there are none, with duplicates numbered). The current chip is highlighted and scrolled into view.
- Loop section toggle, Follow (pressed), a size control (− and +, 80-180%, defaults 110% or 90% under 1000 px; `ws.chart.scale`), Together vs Hands/feet, and Mute drums (hidden when there is no drums stem).
- **Score gestures**:
  - Click or tap a bar seeks to the nearest beat.
  - Mouse drag across bars loops them.
  - Touch: a 380 ms long-press arms a drag, or marks the first bar for a later tap on the last bar (with vibration and a hint pill) (chart.js:128-180).
  - Manual scroll pauses Follow (chart.js:103-105).
  - The playing system is kept 22% from the top (chart.js:93-102).
- Notice box (import result, dismiss ✕) and a transient hint pill (chart.js:41-42,50).
- **Empty state**: "No drum chart yet" with Import a file… and Open Transcribe, or the shared variant "No drum chart shared" (chart.js:74-81).
- **Pain points**:
  - **No keyboard access to bars or sections in the score** (pointer only). Global keys still work, but digits 1-9 mute invisible stems.
  - The Chart's Together/Hands-feet is a **per-device view override** (`ws.chart.layout`, chart.js:190). The identical-looking control in Transcribe **writes the part's layout**, which is shared (editor.js:247). Same label, different semantics.
  - Touch-target enlargements exist here (chart.css:43) but not in the player.

**Transcribe** (editor.js):
- **Heading**: "Drums", a save status, the Score / Drum lanes view switch (`ws.notation.layout`), Kit, Properties and Listen panel toggles, and a "•••" `<details>` menu (editor.js:135). The menu contains:
  - Copy, Paste, Repeat bars…, Move notes…, Tuplet on this beat…, Mark bars reviewed.
  - Bar meter & label… and Align in tempo map… (both open the map).
  - Export, Print, Import…, Keyboard shortcuts…, Note list / Hide note list, and "Show every kit piece" (lanes only).
- **Toolbar** (editor.js:136-137):
  - Step buttons ♩, ♪, 16th, 1/32, 1/64 and dotted •.
  - Tuplet select: Straight, Triplet, Quintuplet, Sextuplet, Septuplet.
  - Together vs Hands/feet (part layout).
  - Skip, Undo ↶ and Redo ↷ as glyph-only buttons.
  - Navigation: range label, ← and →, Fit (lanes), Loop and Follow.
- **Panels** (editor.js:139-141):
  - **Kit**: 27 pads grouped as Cymbals & hi-hat, Drums, Feet and Other, with key letters and an "Audition only" mode.
  - **Properties**: Accent, Heavy accent, Ghost, Flam, Drag, Roll (0-3), Sticking (L/R), Velocity, Voice (Auto, 1 Hands, 2 Feet) and Delete. Properties apply to the selection, or to the next note when nothing is selected.
  - **Listen**: Listen to Recording / Notation / Both, Notation level, Mute recorded drums, Play from cursor.
- **Sidebar**: in Score view, "Writing <piece> [key]", "Add note (N)" and Sections jump buttons. In Lanes view, the lane labels audition pieces (editor.js:142-143).
- **Footer**: help text, message, "Bar n · Beat b", the lanes grid (1/4 to 1/64 and Triplet), and the Retry saving / Review saved version recovery buttons (editor.js:144).
- **Score view**:
  - Paginated **16 bars per page**, with Previous bars and Next bars (editor.js:21,160).
  - Click places the cursor or selects a note (Shift adds). Drag box-selects. Double-click a staff line writes that piece, or opens Properties on a note (editor.js:183-208).
- **Lanes view**: time-aligned with the waveform (tracks are shown above).
  - Click places the cursor and piece. Double-click adds, or deletes on a note.
  - Drag moves notes in time and across lanes. Box select. Shift-click on the bar strip extends the bar range. Wheel zooms and pans (editor.js:211-241; lanes.js).
- **Keys** (editor.js:303-326):

| Key | Action |
|---|---|
| Space / Enter | Play / pause |
| ← / → | Step (Shift extends the range; in lanes with a selection, moves notes) |
| ↑ / ↓ | Piece (lanes with a selection: move lane) |
| ⌥ ← / → | Move notes |
| Home / End | Start or end of bar |
| N | Write |
| Drum letters | Write that piece (remappable, `ws.notation.keys`) |
| R | Skip |
| 1-7 | Step value |
| + / − | Step finer or coarser |
| . | Dotted |
| / | Cycle tuplet |
| A / Shift+A / G | Accent / heavy / ghost |
| ⌫ | Delete |
| ⌘Z / ⇧⌘Z / ⌘Y | Undo / redo |
| ⌘C / ⌘V | Copy / paste |
| ⌘D | Repeat |
| ⌘A | Select bar |
| Esc | Clear selection and close the panel |

- **Dialogs**, all modal (editor.js:94-123,300): Move selected notes (quarter-note offset), Paste/Repeat passage (start bar, copies 1-64, replace), Tuplet (count and span), Align bar / Align beat (legacy, effectively unreachable because the player always passes a songMap), Replace drum part (on import), Drum shortcuts (27 single-letter fields; N, R, A and G reserved), and Load saved version (exports local edits first).
- **Save model** (store.js, NotationStore):
  - Local IndexedDB journal, saved 650 ms after an edit.
  - Statuses: Opening part…, Saved, Saved on this device, Saving…, Waiting for connection, Another version exists (conflict), Device storage unavailable, Read-only (editor.js:43-44).
  - A `beforeunload` guard covers unsaved disk writes.
- **Export** `.woodshed.json` and **Print** (landscape, 4 bars per row) (editor.js:116-122). An accessible note list toggle is available (editor.js:148-149).
- **Pain points**:
  - The richest features are buried in "•••".
  - Glyph-only buttons (↶, ↷, •, ←, →) rely on titles.
  - **Key meaning collides across modes**:
    - 1-9: mute (player), go to bar (map), step (Transcribe)
    - − / =: zoom (player) vs step size (Transcribe)
    - . : nudge seek (player), nudge pin (map), dotted (Transcribe)
    - G: grid (player) vs ghost (Transcribe)
    - R: ramp (map) vs skip (Transcribe)
    - Enter: pause (player) vs go to bar (map)

---
## 15. Sharing and shared view

**Share dialog** (share-dialog.js:3-25), opened from the header Share button or the card menu:
- Explains what is included.
- "Include drum notation and its alignment" checkbox, live-updatable after a link exists.
- Create link (flushes practice, tempo and notation first; player.js:1023-1029) becomes Copy link, with clipboard fallback to select.
- Stop sharing. A new link gives a new URL.
- The share domain is hard-coded as `https://woodshed.kylekincer.com/share/` (share-dialog.js:14).

**Shared page** (shared-song.js):
- noindex. The header shows the brand and theme only.
- Banner: "Shared song" and a storage note, with the button cycling through Add to library, Sign in to add, Adding…, and Open in library. Also "My library".
- Placeholder and "Song unavailable" states (shared-song.js:18-29).
- The player opens read-only: no edit, share, map, detect or saving; the chart shows shared notation (live via `notation.get{token}`).
- "Sign in to add" redirects to `?save=1`, then the save completes after sign-in, with a "Keep listening without signing in" escape (shared-song.js:54-58).
- Copies are independent (`shareAudio.save`).

---
## 16. Export

| Export | Where | Notes |
|---|---|---|
| Library ZIP | Settings and Billing (duplicate) | Streams to disk through showSaveFilePicker in Chrome/Edge. Other browsers have a 100 MB in-memory cap with an error (export.js:9-57). Includes manifest, settings, per-song stems, cover and notation JSON. |
| Original audio | Settings, desktop companion | |
| Notation `.woodshed.json` | Transcribe menu | Plus Print. |

There is no per-song audio or mix-down export, and no MIDI export.

---
## 17. Persistence map

- **Server, per song**:
  - `practice` holds loop, rate, grid and tracks (volume, mute, solo). Saved 600 ms after any input, click, pointerup or keyup in the player; 10 KB cap (player.js:1010-1021; convex/songs.ts:151-155).
  - `tempo` holds metronome settings plus the song map, saved after 400 ms.
  - The notation part is revisioned (`notation.save` / `notation.get`).
  - Metadata and artwork.
  - Share token.
- **Server, per user**: separation settings (`settings.save`), billing and storage usage.
- **Device localStorage**: `ws.theme`, `ws.view`, `ws.grid`, `ws.overview`, `ws.preservePitch`, `ws.stopBehavior`, `ws.practice.view`, `ws.chart.scale`, `ws.chart.layout`, `ws.notation.layout`, `ws.notation.keys`, `ws.tapSnap`, `ws.tapOffset`.
- **Device storage**:
  - IndexedDB `woodshed-notation` drafts.
  - Cache API `woodshed-stems-v1`.
  - In-memory decoded stems: 128 MB on small devices, otherwise 512 MB (decoded-stem-cache.js:39-43).
  - Desktop appearance.json.
- **Not persisted**: playhead and edit cursor, zoom window, Follow, metronome popover state, Transcribe step, piece, expression, panel and lanes grid, chart scroll position.

---
## 18. Desktop-specific

**Electron main** (desktop/main.cjs):
- Serves `dist/` from http://127.0.0.1:47832 with a strict CSP (main.cjs:30-50).
- Forks the companion utility process, which owns the Python processor and models (main.cjs:51-60).
- Single instance. External https links open in the browser. Permission requests are denied. Native theme sync. Smoke-test mode.
- App menu: Woodshed → Check for Updates…, Quit, plus Edit and View menus (main.cjs:117).
- Preload bridge `woodshedDesktop`: info, update, onUpdate, onOpenUpdates, setTheme, mediaUrl (preload.cjs).

**Companion HTTP**: `/status`, `/connect`, `/upload`, `/export-originals`, `/legacy`, `/import` (companion/server.mjs:185-214).
- Pairing goes through `devices.pair` (companion.js:47-65). Failures appear only in the console (desktop-client.js:52-55); the UI shows no connection status.

**Updates** (update-controller.cjs):
- Checks 15 s after launch, then every 6 h, and on wake.
- Prompts natively on focus: "Download update / Later", then "Restart now / Later". The restart prompt warns when processing is busy.
- Entry points: header icon (only when an update exists), account menu "App updates", Settings "Check for updates", and the app menu.

**Media proxy**: proxies signed R2 URLs through 60 s single-use tickets with a 300 MB cap (media-proxy.cjs).

**Download page** (desktop.js:13-97):
- Platform detection, with a recommended installer button.
- macOS (DMG/ZIP, Apple Silicon only), Windows EXE and Linux AppImage.
- Falls back to the bundled `/downloads.json`, with Retry.

---
## 19. Convex function surface (public unless marked internal)

- **admin**: access, overview, accounts, account, history (queries); updateAccount, updatePolicy, revokeDevice, cancelJob (mutations).
- **artworkUpload**: prepare, complete (actions).
- **billing**: portal, checkout (actions). Internal: reconcile, confirmGraceExpiry.
- **billingData**: status (query). Internal: context, beginCheckout, bindCustomer, finishCheckout, beginSync, applySync, expireGrace, startCleanup, cleanup.
- **blobs**: prepare, complete (actions). Internal: erase.
- **devices**: pair, revoke (mutations); identity (query).
- **jobs**: listActive, get (queries); createSeparation, createBeatDetection, cancel, dismiss, retry (mutations).
- **media**: signKeys (action). Internal: authorizedKeys.
- **metadata**: update (mutation). Internal: context, applyAutomatic, requestSlot, deferRequests, cached, cache, expireCache, reserveArtwork, artworkContext, verifiedArtwork.
- **metadataLookup**: find, detail (actions). Internal: enrich.
- **notation**: get (by songId or token), save (with NOTATION_CONFLICT, NOTATION_UNCHANGED and NOTATION_UPGRADE_REQUIRED codes).
- **settings**: config (presets, models, stemModes, bitrates, settings), save.
- **shareAudio**: playback, save (actions).
- **sharing**: status, view, saved (queries); create, revoke (mutations). Internal: mediaContext, importContext, beginImport, finishImport, failImport.
- **songs**: list, get, exportPage (queries); rename (unused by the UI), saveTempo, savePractice, remove (mutations).
- **storage**: usage (query). Internal: reserve, expire, getObject, deleted.
- **tempoSources**: search, load (actions). Internal: authorize.
- **users**: me (query). Internal: createUserGoogle.
- **worker** (companion and Modal): next, claim, progress, beatsDone, importSong, cancelForUpdate. Internal: uploadContext, finish.
- **auth**: signOut, refreshSession, isAuthenticated, startSignInGoogle, completeSignInGoogle.
- **http**: Stripe webhook at `/stripe/webhook`.

---
## 20. Consolidated pain points (for the redesign)

1. **Mode sprawl.** Practice→Chart/Tracks, Transcribe→Score/Lanes, Tempo map (an overlay mode with its own inspector, lane and keys), Find/import (a sub-mode that freezes everything else), and the metronome popover. Each has its own toolbar vocabulary, Follow, loop, zoom, undo stack and keymap (§13, §14).

2. **Duplicated controls**:
   - Tempo map entry ×4 (transport, popover, Shift+M, Transcribe menu).
   - Detect beats ×2.
   - Mute drums ×4.
   - Follow ×3.
   - Loop ×5 models.
   - Export library ×2.
   - Plan & billing ×2.
   - Update checks ×4.
   - Quality preset slider plus buttons.
   - Together/Hands-feet ×2 with different semantics.
   - Zoom ×3 (waveform, chart %, lanes).

3. **Hidden or undiscoverable features**:
   - The "?" button is tooltip-only.
   - Double-click resets speed.
   - Loop with no region loops the visible window.
   - Count-in and pre-roll are buried in the metronome popover.
   - The M key opens the popover rather than toggling the click.
   - Calibration and snap taps live under the map's More menu.
   - Most Transcribe power tools are in "•••".
   - Card ⋯ menu content (Reprocess, Open original source, Select).
   - The uncertain-metadata state is never surfaced.
   - Practice notes, key and tuning never appear while practising.

4. **Mouse-only interactions**: waveform seek/loop drag/edges and overview pan/zoom use mouse events (player.js:602-713). The chart and map lane use pointer events, so the core Tracks view fails on touch.

5. **Keyboard-only interactions**: most tempo-map edits (renumber, beats ±, nudge, tail tempo, go-to-bar); seeking by step; `[`/`]`; Transcribe tuplet cycling. Conversely, the chart score and section chips have no keyboard path to bars.

6. **Tiny targets**: loop handles (2px plus a 14px flag), EDGE_PX 7, overview edges 6px, header edit pencil 22px, `.tbtn` 10px font, nudges 24-28px, card ⋯ 28px, map pin hit box 7×9 px. Only the chart and Transcribe enlarge on `pointer:coarse`.

7. **Confusing or stale labels and copy**:
   - "Tempo map → Import" vs "Find / import…" vs Transcribe "Import…" (a different importer).
   - Grid button reads "On/Off" as state, and metronome "Off/On" also shows state rather than action.
   - Help tooltip says ←/→ is 1 s when it is 5 s.
   - "switch stems to FLAC in Settings" (no such option).
   - "Retry the desktop connection in Settings" (no such control).
   - Reprocess hint versus the GPU comment.
   - Loop readouts in seconds only, never bars.

8. **Inconsistent patterns**:
   - Toggle state by `.on` class vs `aria-pressed` (grid, snap, overview and metronome lack aria-pressed).
   - Five feedback mechanisms, including native alert, confirm and prompt.
   - Mixed modal implementations and Escape semantics.
   - Three visual styles (square, pill, rounded card).
   - Device vs song persistence split: grid stored in both; pitch per device while rate is per song.

9. **Modal and overlay stacks**: Metadata modal → lookup panel → review with window.confirm on close. Transcribe dialog → "Load saved version" which auto-downloads. The map's Find/import panel inertly freezes the chart, editor and lane, and disables all player shortcuts. The metronome popover floats over the transport.

10. **State loss and continuity**: a song always reopens at 0:00 with zoom fitted. There is no browser history or Back. Beat-detection and import jobs do not appear in the library. The web user hits desktop-only walls (Add, Detect, Reprocess, Retry, Export originals, Import legacy) through modal errors rather than up-front capability cues.

11. **Dead or legacy code to drop in the rewrite**:
    - musical-position.js (unused); `.nav-btn`; `songs.rename` and `renameSong`.
    - Legacy alignment and align-beat dialogs (editor.js:108-115,289), unreachable from the player.
    - aria labels for the non-existent `m-bpm` and `m-sig` (player-layout.js:33).
    - Sidebar-era CSS (styles.css:257, record-club.css dead selectors).
