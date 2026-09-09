# Desktop distribution

The Electron app includes a frozen Python 3.11 processing runtime, yt-dlp,
Demucs, BeatNet, Node.js, FFmpeg and ffprobe. Model weights download on first
use. Linux AppImage, macOS DMG + updater ZIP (Apple Silicon only), and
Windows NSIS installers are built on their native GitHub Actions runners.

Windows and Linux installers include CUDA 12.8 PyTorch for compatible NVIDIA
GPUs, with CPU execution on other hardware. Macs select Apple Metal (MPS)
when available. An accelerator inference failure retries on CPU without changing
the chosen model, shifts, overlap, or output format. GPU packaging increases
the Windows/Linux download size.

CPU inference uses physical cores (performance cores on Apple Silicon), honors
affinity/container limits, and uses up to 16 threads by default. Override with
`WOODSHED_CPU_THREADS`; existing `MKL_NUM_THREADS` and `OMP_NUM_THREADS` are also
honored. `WOODSHED_DEVICE=cpu|cuda|mps|auto` can select a backend for diagnostics.
Each completed separation writes `separation-runtime.json` beside its retained
WAVs, recording the actual backend, thread count, inference time, and fallback
reason if applicable. Stem encoders run concurrently, with at most four workers.
The processor still handles one song at a time to bound model memory.

Runtime unit tests and real frozen separation/encoding/beat tests run on every
release platform. Hosted CI does not provide NVIDIA or Apple GPU hardware; its
CPU fallback tests cannot establish GPU throughput. GPU errors are handled at
runtime and remain visible in the local diagnostic file.

Apple Developer ID signing and notarization use the repository's existing
MAC_CSC_LINK, MAC_CSC_KEY_PASSWORD, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and
APPLE_TEAM_ID secrets. macOS release builds fail if these are missing.
Windows is unsigned until a Windows certificate is configured.

The `/download` page uses the same-origin `/api/downloads` endpoint to find the
latest public release, cached for one minute. `public/downloads.json` is the
verified fallback manifest; update it from a published release when needed.
Installer links point directly to GitHub’s attachment URLs. macOS browsers do
not reliably expose CPU architecture, so the page explicitly labels Apple Silicon.

The icon source is `public/woodshed-icon.svg`. Desktop uses the matching 1024px
`desktop/icon.png`; the browser uses the SVG plus PNG and Apple touch fallbacks.

Updates use electron-updater and public GitHub Releases. The app checks 15 seconds after startup, every six hours, and after an overdue
wake from sleep. A native prompt appears once per available version and again
when its download is ready; prompts wait until Woodshed is focused. Dismissing
the prompt keeps the header update icon available. Downloads require a click,
and restart requires a separate confirmation. Playback and processing do not
block updates. The restart dialog warns when processing will be cancelled;
that cancellation is recorded locally and synced before processing resumes
after relaunch, including after an offline restart. Quitting does not silently install. Settings and the native menu offer update checks.
Draft releases are invisible to installed clients. The release collector writes the Apple Silicon installer to latest-mac.yml and verifies every listed SHA-512. Intel macOS builds are no longer supported starting with 1.4.3.
After upload, tag builds publish the complete release and verify all three public
update feeds through electron-updater's GitHub provider, including installer
availability and sizes. Publication verification uses no GitHub credentials,
retries briefly for propagation, and fails CI if clients cannot see the release.

Build a release/** branch first to inspect CI artifacts. Set package.json and
package-lock.json to the desired version, then tag that commit vX.Y.Z. The tag
workflow stages assets in a draft, then publishes automatically only after all
platform tests, packaged launch checks, and checksum verification pass. Use
release/** branches for review before tagging. A `release/publish-vX.Y.Z` branch is an explicit publication request: after the same gates pass, the workflow creates the matching tag at that exact commit and publishes it. Ordinary `release/**` branches remain artifact-only. The branch/tag version must match package.json. Do not reuse published version numbers. A release replaces
the complete app, including the bundled downloader and processing libraries.

Local build: install the source prerequisites in README, run
`python3.11 companion/setup.py --beats --cuda`, install `pyinstaller==6.16.0`
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

Pitch preservation uses the bundled, same-origin Signalsmith Stretch AudioWorklet
and WASM module (MIT). Web and desktop CSP permit WASM compilation through
`wasm-unsafe-eval`; JavaScript eval remains disabled. The packaged launch gate
loads this asset under the real desktop CSP and renders multichannel audio offline, checking a 440 Hz tone at 0.75x without requiring physical audio hardware on CI. Normal-speed and varispeed playback use native buffer sources; pitch-preserving speed changes use one shared, phase-linked multichannel processor.
