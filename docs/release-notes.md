Woodshed 1.6.1 redesigns the tempo map so it's easier to read and to use.

- A tempo lane above your stems shows bar numbers, meter changes, section labels and a tempo curve. Steady stretches are flat steps and ramps are slopes. A stretch that disagrees with the stretches on both sides turns amber, which usually means a miscounted bar.
- In the lane, drag a pin's handle to move it, hover to see its bar and time, and double-click to pin or unpin a line.
- The selected bar is highlighted across the lane and the stems, and pinned beats are drawn solid through the waveform. The edit cursor is hidden while you map, so there's one less line to tell apart.
- An inspector shows the bar, meter, tempo and pin at the selection. Pin, Tap along and Edit bar are one click away, with their keys printed on them. Less common tools are under More. The hints change with what you're doing, and ? shows every key.
- Change a meter without moving any beats. When the beats around a bar are pinned (a tap-along or detected map), ↑/↓ and Edit bar keep every beat where it is and slide the later bar lines. When only downbeats are pinned, those bar lines stay and the beats between them re-spread. Edit bar lets you pick either one.
- Edit bar works in place with labelled fields. Hidden fields can no longer block Apply.
- Beat detection can be started from the tempo map and reports its progress there.
- A song you haven't mapped yet opens with a one-line how-to, and its placeholder tempo is no longer shown as a pin.

Woodshed 1.6.0 adds a keyboard-driven tempo map for lining the beat grid up with any recording, whether or not it was played to a click.

- Press Shift+M, or choose Tempo map in the transport, to map the song. ←/→ moves bar by bar and Shift+←/→ beat by beat. The playhead follows the selection, and Cmd+←/→ jumps between pins and meter changes. Type a bar number and press Enter to jump to it.
- Pin bars instead of hunting for a BPM. Stop on a downbeat and press D, or press T for a beat. Tempo between pins is worked out exactly, to hundredths of a BPM. For a song played to a click, pin bar 1 and one late downbeat and you're done. If the bar number is off, Alt+←/→ renumbers the pin and the tempo re-solves.
- Tap along with songs that weren't played to a click. Play and tap T on every beat (D on downbeats keeps the bar count in sync). Each tap pins the next beat. Taps are corrected for audio latency and snap to the nearest hit in the drum stem. You can also calibrate how early or late you tap. A whole tapping pass undoes in one step.
- Fix meters without moving anything. ↑/↓ adds or removes a beat from the bar until the next meter change; Shift limits it to one bar. E edits the meter, beat grouping (such as 2+2+3), pickup length, section label and open-ended tempo. Pinned bars never move. A miscounted bar shows up as a stretch with an odd tempo.
- Ramps. R turns the stretch between two pins into a gradual tempo change for accelerandos and ritardandos.
- P loops the bars around the selection with the click. ,/. nudges the selected bar line by 10 ms (1 ms with Shift) while you listen, and ←/→ steps the loop through the song. Cmd+Z undoes any change.
- The metronome, count-in, beat grid, snapping, bar readout and drum transcription all share this one map. Fixing the map fixes the drum part's timing too. Map edits that would strand written notes are refused, and Transcribe's bar and alignment commands open the tempo map.
- Detected beats now feed the tempo map, so they can be refined with the same keys. Compound and odd meters click their felt pulse: dotted quarters in 6/8, 2+2+3 in 7/8.
- Existing songs keep their clicks exactly where they were, including drum parts' timing. Shared songs include the full tempo map.

Woodshed 1.5.1 speeds up local audio processing.

- Uses Apple GPU acceleration on supported Macs and NVIDIA CUDA on supported Windows/Linux PCs. If the accelerator cannot process a track, Woodshed retries on CPU.
- Uses more available CPU cores instead of the previous four-thread limit. Keeps your chosen separation model and quality settings.
- Encodes stem files concurrently and avoids loading PyTorch twice before separation.
- Shows the active processor during separation and records local runtime diagnostics for troubleshooting.
- NVIDIA acceleration downloads a separate runtime on first use, then reuses it. CPU processing works without that download. Macs use their built-in GPU support.
- Includes the drum transcription workspace and note-entry improvements already available on the web.

Woodshed 1.5.0 adds song sharing.

- Choose Share in the player or Share song from a library card to create an unlisted link. Anyone with the link can listen and practice in their browser; signing in lets them add the song to their library.
- Shared songs include their audio stems, artwork, song metadata, tempo maps, time signatures, downbeats and beat corrections, loop, playback speed, mixer, grid, and count-in settings. Private notes, personal tags, account details, and original file paths stay private.
- Add to library creates an independent copy without processing the audio again. Your copy and practice settings remain yours if the sender changes or deletes the original or stops sharing. Copies count toward your cloud storage.
- Stop sharing disables the link. Creating another link produces a new address. Existing saved copies are retained.
- Duplicate saves, interrupted copies, unavailable audio, and storage limits are handled without creating partial library entries. Signing in returns you to the shared song and finishes the requested save.

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
