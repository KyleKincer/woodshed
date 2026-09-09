Woodshed 1.4.5 adds system-aware dark mode, a repeatable practice transport, and a stable startup.

- Appearance follows your system by default and updates when the system changes. Choose System, Light, or Dark in Settings, on sign-in, or on the download page. Choices are remembered on the current device. Waveforms, loading states, dialogs, and native desktop windows follow the same appearance.
- The edit cursor is separate from the moving playback head. Click a waveform to select your start. Space plays or stops; stopping returns to that start by default. Enter or the Pause button pauses and resumes in place, without repeating count-in. Settings also offers “Stay at playback position.”
- A dashed edit cursor and Start readout keep the selected position visible. Repeated playback, loop changes, seeks, rate changes, and canceled count-ins preserve the intended start.
- Startup keeps the library skeleton in place while restoring the session and receiving the first library and job snapshots. Restored sessions skip sign-in, and the app no longer flashes an empty library. Independent startup reads run together, artwork loads without blocking song controls or replacing keyboard focus, and slow or failed connections offer retry.

Woodshed 1.4.4 refreshes the app icon and desktop download experience.

- A new cobalt-blue and ivory W icon matches Woodshed’s current styling across the desktop app, browser tab, and saved web shortcuts.
- The download page detects macOS, Windows, and Linux and offers the matching installer directly. All supported installers, including the Mac ZIP, appear on the Woodshed site with file sizes and version details.
- Phones and tablets open the web player by default, with desktop downloads available on the same page. Mac downloads clearly require Apple Silicon.
- Downloads follow the current published release, with a saved set of verified installers available if the release lookup is temporarily unavailable.

Includes the navigation, count-in, and keyboard improvements from 1.4.3:

- macOS releases now support Apple Silicon (arm64) only. Windows and Linux builds continue.
- Panning stops cleanly at either song boundary without changing zoom. Horizontal trackpad gestures retain their direction through momentum, and wheel units are normalized across devices.
- Manual timeline scrolling pauses Follow so the playhead cannot pull the view back. Use Follow or start playback again to resume it. Overview edge resizing keeps the opposite edge fixed.
- Count-in length is customizable from 1–16 bars or beats and works independently of the regular metronome. Audible pre-roll optionally plays the song leading up to the start point; it is off by default. Missing audio before the beginning of a song stays silent while the full count-in completes.
- Count-in clicks and playback share the audio clock at every speed. Space or Pause cancels immediately and returns to the intended start point. Seeking or changing playback settings cancels an active count-in. Settings are saved even when leaving the song immediately.
- Mouse-clicked checkboxes, sliders, selectors, and buttons no longer capture the next Space press. Text entry, dialogs, and Tab-focused controls retain their normal keyboard behavior. Holding Space cannot repeatedly toggle playback.

Includes the playback and loading improvements from 1.4.2:

- Plays the original audio without time-stretch processing at 1.00×. Disabling Keep pitch also uses native varispeed playback.
- Keeps stems phase-coherent when preserving pitch at other speeds by processing all channels together. Switching back to normal speed silences the processed tail so it cannot overlap the original audio.
- Keeps the playhead and metronome aligned through loop changes, seeks, pauses, and speed changes. Disabling a loop continues from the current song position rather than accumulated loop time.
- Double-clicking the speed slider restores 1.00×. Keep pitch is enabled by default, with a remembered toggle beside Speed.
- Shows the current bar, total bars, and beat beside the playback time, following the detected beat grid or manual tempo map.
- Keeps the song layout steady while audio loads, with waveform skeletons, progress inside the track panel, and retry on failure. Removes the stray page-shifting spinner.

Existing desktop users can select **Check for Updates** from Settings or the Woodshed menu.

Choose `.dmg` for macOS on Apple Silicon (arm64), `.exe` for Windows, or `.AppImage` for Linux. Windows is unsigned. Make the Linux AppImage executable before opening it. Processing model weights download on first use.
