Woodshed 1.4.2 fixes phasey, comb-filtered playback and improves the practice player.

- Plays the original audio without time-stretch processing at 1.00×. Disabling Keep pitch also uses native varispeed playback.
- Keeps stems phase-coherent when preserving pitch at other speeds by processing all channels together. Switching back to normal speed silences the processed tail so it cannot overlap the original audio.
- Keeps the playhead and metronome aligned through loop changes, seeks, pauses, and speed changes. Disabling a loop continues from the current song position rather than accumulated loop time.
- Double-clicking the speed slider restores 1.00×. Keep pitch is enabled by default, with a remembered toggle beside Speed.
- Shows the current bar, total bars, and beat beside the playback time, following the detected beat grid or manual tempo map.
- Keeps the song layout steady while audio loads, with waveform skeletons, progress inside the track panel, and retry on failure. Removes the stray page-shifting spinner.

Existing desktop users can select **Check for Updates** from Settings or the Woodshed menu.

Choose `.dmg` for macOS (arm64 for Apple Silicon, x64 for Intel), `.exe` for Windows, or `.AppImage` for Linux. Windows is unsigned. Make the Linux AppImage executable before opening it. Processing model weights download on first use.
