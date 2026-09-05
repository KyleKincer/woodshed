# Migration validation — 2026-09-04

Development deployment: `jovial-cardinal-295`. Production has not been deployed.

- The user completed Google OAuth registration/sign-in and confirmed the library loaded.
- Eight backend tests pass: unauthenticated/cross-account job denial,
  device takeover denial, per-user/global reservations, idempotent reservation
  and completion, owned audio/export scoping, cancellation/revocation,
  delayed quota release and duplicate active-import prevention.
- Real R2 PUT + HEAD verified byte length and SHA-256. A larger PUT using the
  same signed URL returned 403. The fixture object was deleted.
- `companion/selftest.py` ran real CPU Demucs on generated stereo audio:
  four Opus round trips each decoded to exactly 352,800 frames at 44.1 kHz.
  Cached result reuse passed. Real BeatNet returned 17 beats.
- Local yt-dlp downloaded a real 19-second YouTube video and converted it to WAV.
  This proves the local route works for that test, not that YouTube never blocks.
- A temporary isolated companion paired with a test identity on development,
  accepted a local WAV, ran Demucs, uploaded four stems through the quota API,
  and produced a synced library entry. Every downloaded stem matched its
  recorded size, browser CORS allowed localhost, usage equaled the total bytes,
  and another identity could not obtain the audio URLs.
- Two export tests pass: the streamed ZIP opens with the expected audio, manifest and settings; failed downloads abort the destination.
- TypeScript, Vite build, Python syntax, shell syntax and dependency audit pass (10 tests total).

The local website and companion are running for continued testing. No browser
was available to the agent: Google login was checked by the user; automated
browser playback and the revised account menu still need visual QA. Export archive contents are tested programmatically.
macOS/Windows have setup paths but have not been executed on those systems.

## Web/admin follow-up

- 14 tests pass, including non-admin rejection, actual storage-reservation
  enforcement with user overrides and the global ceiling, restriction states,
  device revocation, cancellation, required reasons, and audit writes.
- Type checking and the production web build pass.
- Download page checked in a real browser at desktop and 390px phone width;
  no browser console errors observed on that page.
- Download ZIP extracted and verified: 11 source/setup files, valid Bash launcher,
  no environment files, credentials, node_modules, or local library data.
- Live development admin query recognizes the owner's verified account.
  Authenticated admin UI testing still needs a signed-in browser session.
- Vercel preview: https://woodshed-l00lyuyh9-kylekincers-projects.vercel.app
  (uses the development backend; Vercel preview protection may require login).
- Existing subdomain woodshed.kylekincer.com already belongs to the Vercel project.
  Production still uses the older backend until its Google OAuth setup is complete.

## Production release — 2026-09-04

- Published the Convex Auth v2, local-processing, web, and admin implementation
  to production `tidy-kookabura-985` and woodshed.kylekincer.com.
- 15 tests pass, including stable Google owner-ID binding and email-spoof rejection.
- Fresh production signing keys; Google callback supplied by the user; owner
  privileges bind to the same Google account already verified in development.
- Production root, /admin, /download, and companion ZIP return HTTP 200; bundle
  points to production Convex and ZIP has the correct archive signature.
- Production R2 PUT/GET round trip passes; browser-origin CORS matches the public
  domain; temporary verification object removed.
- Anonymous admin access returns false and admin data requests are rejected.
- Completing a real Google login still requires the user's browser session.

- Real hosted Google button opens Google sign-in with the production callback
  accepted (no redirect mismatch). Phone sign-in layout corrected after browser QA.

## Electron desktop revision

- Google OAuth round trip on Linux confirmed by the owner after adding the desktop origin to production.
- Frozen Python runtime separated a generated audio fixture into four stems and encoded Opus sync files.
- Frozen BeatNet completed beat detection, including after excluding unused madmom model weights.
- Desktop launch smoke test verifies the isolated preload bridge, compact header, absent sidebar, and responding bundled local service.
- Two update-policy tests verify playback/processing restart guards and bounded public update state.
- The sign-in button uses Google's official branded asset and was inspected in the running app.
- Cross-platform installer and packaged-app launch checks run in GitHub Actions. Publishing remains gated on their results.

## Player and update UI follow-up

- Native desktop media streaming passes signed-URL, cross-origin refusal,
  single-use ticket, expiry and size-limit regression checks. R2 preflight
  allowed the public website but refused the Electron origin; the desktop
  now downloads directly through its native HTTP client.
- Centered Google sign-in checked at 1280px and 390px; the button is centered
  and the card fits both viewports.
- Browser fixtures verified two-, four- and six-stem skeleton layouts,
  disabled loading controls, and ignored late storage errors after leaving.
  A generated WAV decoded through the real audio engine, replaced all four
  skeletons with waveform canvases, and enabled playback controls.
- Song metadata now occupies the main app header, with no second header or
  Library button. Overview shares the zoom controls.
- Update UI fixture verified: hidden without an update, circular outline
  when available, cancellation performs no action, and one confirmation
  calls download followed by install. Restart guards remain covered by the
  desktop tests; a real installed-version upgrade is not yet exercised.

- Decoded audio now has an LRU memory cache: 512 MiB on desktop-class devices,
  128 MiB on coarse-pointer or reported low-memory devices. Clear cache clears
  both decoded and compressed audio. Three regression tests cover reuse,
  sample-rate isolation, eviction, pending clear, and oversized buffers.
- Real browser/Web Audio verification: four initial downloads and decodes;
  reopening added zero downloads and zero decodes. After clearing memory,
  decoding repeated but downloads stayed at four, proving the disk cache hit.
