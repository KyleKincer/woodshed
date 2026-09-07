# Desktop distribution

The Electron app includes a frozen Python 3.11 CPU processing runtime, yt-dlp,
Demucs, BeatNet, Node.js, FFmpeg and ffprobe. Model weights download on first
use. Linux AppImage, macOS DMG + updater ZIP (Intel and Apple Silicon), and
Windows NSIS installers are built on their native GitHub Actions runners.

Apple Developer ID signing and notarization use the repository's existing
MAC_CSC_LINK, MAC_CSC_KEY_PASSWORD, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and
APPLE_TEAM_ID secrets. macOS release builds fail if these are missing.
Windows is unsigned until a Windows certificate is configured.

Updates use electron-updater and public GitHub Releases. The app checks 15 seconds after startup, every six hours, and after an overdue
wake from sleep. A native prompt appears once per available version and again
when its download is ready; prompts wait until Woodshed is focused. Dismissing
the prompt keeps the header update icon available. Downloads require a click,
and restart requires a separate confirmation. Playback and processing do not
block updates. The restart dialog warns when processing will be cancelled;
that cancellation is recorded locally and synced before processing resumes
after relaunch, including after an offline restart. Quitting does not silently install. Settings and the native menu offer update checks.
Draft releases are invisible to installed clients. The release collector merges
both Mac architectures into latest-mac.yml and verifies every listed SHA-512.
After upload, tag builds publish the complete release and verify all three public
update feeds through electron-updater's GitHub provider, including installer
availability and sizes. Publication verification uses no GitHub credentials,
retries briefly for propagation, and fails CI if clients cannot see the release.

Build a release/** branch first to inspect CI artifacts. Set package.json and
package-lock.json to the desired version, then tag that commit vX.Y.Z. The tag
workflow stages assets in a draft, then publishes automatically only after all
platform tests, packaged launch checks, and checksum verification pass. Use
release/** branches for review before tagging. Do not reuse published version numbers. A release replaces
the complete app, including the bundled downloader and processing libraries.

Local build: install the source prerequisites in README, run
`python3.11 companion/setup.py --beats --cpu`, install `pyinstaller==6.16.0`
in companion/.venv, then run `companion/.venv/bin/python scripts/build-processor.py`
and `npm run desktop:package`. Use the equivalent Scripts/python.exe on Windows.

Desktop serves its bundled UI on http://127.0.0.1:47832. Add this exact origin to
AUTH_ALLOWED_ORIGINS. OAuth still uses the existing Convex Google callback;
Google console does not need another redirect. The final browser redirect to
/oauth/callback returns the one-time flow result to the desktop app. The app's
local storage retains the flow proof; the browser does not receive its session.
The private local service uses an ephemeral loopback port and random credential.

GitHub hosts installer/update bytes, keeping them off Vercel and R2. Model
weights come from their upstream hosts. The locally built Linux installer is
roughly 594 MiB compressed; platform sizes vary. The large ML runtime is included
so users do not need developer tools. Installer size does not count against a
user's audio quota.

The Google sign-in button is an unmodified pre-approved PNG from
https://developers.google.com/identity/branding-guidelines.
