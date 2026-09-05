Woodshed now includes account sync and a web player at https://woodshed.kylekincer.com.

- Full Electron app with bundled downloading, stem separation, and beat detection. No separate Python, Node.js, or FFmpeg setup.
- Google sign-in opens in your browser. Your library syncs across devices; processing stays on your computer.
- Compact navigation: Settings beside your account, Administration inside the account menu.
- A circular update icon appears when an update is available. One confirmation downloads and restarts; active playback or processing prevents restart.
- A centered Google sign-in screen and player skeletons with the correct stem count. Song details share the main header; Overview sits beside zoom controls.
- Recently played songs reuse decoded audio for faster reopening, with a bounded memory cache.
- Plus adds 5 GB cloud storage for $2/month or $20/year, with Stripe checkout and self-service cancellation in Plan & billing. Core practice tools and exports stay free.
- Export synced audio or retained local WAV files, and import an existing Woodshed library from Settings.

Choose `.dmg` for macOS (arm64 for Apple Silicon, x64 for Intel), `.exe` for Windows, or `.AppImage` for Linux. Windows is currently unsigned and may show an unknown-publisher warning. Make the Linux AppImage executable before opening it. Processing model weights download on first use.
