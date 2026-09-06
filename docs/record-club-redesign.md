# Record Club redesign

Implemented on `codex/record-club-redesign`, based on `release/desktop-1.1.0` at `16ed913`.
Reference explorations remain on `codex/prototype-three-directions`.

The selected decision is Record Club's visual aesthetic, with the real app's DAW-style stacked track model. The prototype's single focused waveform and all simulation code are excluded.

## Run and review

From this checkout, install dependencies with `npm ci --ignore-scripts`, configure `VITE_CONVEX_URL` as usual, and run `npm run dev:web -- --port 5173`. The preview at `http://localhost:5173/` is the real app, including normal Google authentication, Convex subscriptions and companion integration. No backend deployment is needed for these frontend changes.

## Changes

- Flat cobalt shell, warm neutral surfaces, larger bold library headings and square album sleeves; compact player header retains song metadata.
- Existing library grid/list, songs/albums/artists grouping, search, subscriptions and actions remain. Pending imports use compact status rows. Real artwork is layered over stable geometric fallback sleeves; failed image loads reveal the fallback. Songs sharing artist/album share the same fallback.
- The existing audio engine and stacked waveform renderer remain. Existing controls are reparented into timeline, playback and loop groups without replacing IDs or handlers. A shared time ruler follows the real zoom window. Canvas beat-grid colors are adapted to the light surface.
- All stem mute/solo/level controls stay beside their tracks. Overview, seek/pan/zoom, A–B loop editing/nudging, speed, grid/snap/subdivision, beat detection/editing, manual tempo changes, metronome, count-in and keyboard controls remain wired to their existing implementations.
- Mobile tracks scroll with visible transport controls. Six-stem sessions are supported. Metronome settings have a close control and Escape handling.
- Library entries and preset choices have native keyboard controls; accessible names added to mixer, playback, settings and import controls. Modals receive dialog semantics, initial focus, Tab containment and focus return. Text fields and sliders retain native keyboard input.
- Shared dialogs, settings, account, billing, sign-in and desktop download surfaces use the same visual system. Decorative headings/subtitles were removed from sign-in, billing and download copy. No slogans were introduced.

## Validation and limits

- `npm run build`: passed.
- `npm run typecheck`: passed.
- `npm test`: 21 existing tests passed.
- `npm run test:desktop`: 10 existing desktop tests passed.
- `npm run test:artwork`: 2 tests covering stable album fallback identity and real-image priority/attribute escaping passed.
- `git diff --check`: passed.
- The actual app was opened at port 5173 and reached its real sign-in screen. The browser had no authenticated session on that origin. Live account mutations, account sync, billing and local companion processing were not exercised.
- A separate, ignored integration fixture on port 5191 imports the **production** library/player/settings modules and real Web Audio engine. Only backend/auth adapters are replaced for that fixture. Four local WAV files were fetched and decoded; playback advanced the real engine clock. Mute, zoom, metronome, six-track layout, artwork success/failure, modal cancellation, settings rendering and the companion setup gate were exercised. This is test evidence, not a replacement app or deliverable preview.
- Desktop and mobile views were visually inspected. A compact-status-row overflow found at 390px was fixed; player content fits the mobile width. Browser screenshots in ignored `artifacts/redesign/` are native viewport captures encoded as actual PNG files. Player/library images use the clearly named integration fixture; `sign-in.png` is the real app.
- Audio files, auth credentials, processing APIs, Convex functions, playback engine implementation and desktop update behavior were not changed. No merge or deployment was performed.

Local OAuth requires an origin in AUTH_ALLOWED_ORIGINS. The deployment allows localhost:5173 and 127.0.0.1:5173; the original preview on 5190 was rejected. Vite now uses strictPort to prevent automatic fallback to an unauthorized port. No deployment allowlist was changed. Sign-in status appears in a fixed bottom notice outside the card flow, so there is no blank space while empty and progress/errors do not move the controls.

The account menu displays the Google profile picture returned by `users.me`,
with initials retained underneath as a fallback for missing or failed images.
The settings gear uses the upstream Lucide settings SVG with fixed dimensions.
Source: https://github.com/lucide-icons/lucide/blob/main/icons/settings.svg
Its license is retained in `src/assets/lucide-LICENSE.txt`.

For local desktop testing, run `npm run desktop:dev` from this worktree. It builds
and serves the redesigned UI at the desktop OAuth origin (127.0.0.1:47832) and
starts the bundled local processor. The local runtime here reuses the existing
processor and Electron binaries from `/home/kck/src/woodshed`; a fresh checkout
still requires the desktop build prerequisites in `docs/desktop-releases.md`.
The dev backend has its own library; add a song or use Settings to import an
older local Woodshed library before testing the waveform player.
