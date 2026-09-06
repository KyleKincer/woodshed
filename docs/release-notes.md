Woodshed 1.3.1 makes desktop updates easier to discover and install.

- Checks for updates after startup, every six hours, and after waking from sleep when a check is due.
- Prompts when a new version is available and when its download is ready. Choose Later to keep working; the header update icon stays available.
- Downloads in the background and asks separately before restarting.
- Allows updates during playback or song processing. The restart dialog warns when processing will be cancelled.
- Remembers interrupted-job cancellation across relaunches, including offline updates.
- Keeps failed downloads available to retry and improves update-icon visibility.

Existing desktop users can select **Check for Updates** from the Woodshed menu. The new prompting behavior takes effect after installing 1.3.1.

Choose `.dmg` for macOS (arm64 for Apple Silicon, x64 for Intel), `.exe` for Windows, or `.AppImage` for Linux. Windows is unsigned. Make the Linux AppImage executable before opening it. Processing model weights download on first use.
