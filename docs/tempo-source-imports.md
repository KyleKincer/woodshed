# Tempo maps and drum drafts

Open a song, choose **Tempo map → Find / import…**. The source browser stays beside the recording and tempo lane. It searches Chorus Encore and Harmonix and accepts local song packages and notes files. It never selects a catalog result automatically.

## Choosing and aligning

- Search starts with the song's artist and title. Matching results include the source and duration; a difference of more than two seconds gets a recording-version warning.
- Choose a result to audition its grid and click. Play / pause is available in the panel. Try another result, restore Your map, or import another file. Each choice retains its own offset until the panel closes.
- Offset buttons move the entire map by 10 or 100 milliseconds; a signed field accepts larger adjustments. Positive means later. Click the waveform, then use First downbeat → cursor to put bar 1 there. Grid snapping is suspended while choosing this recording position.
- Check both ends of the recording. Offset cannot correct a different arrangement, edited intro, or tempo drift. Keep the closest map and refine its pins, or try another source.
- Keep map retains normal editable song timing. Cancel restores the original map, its legacy representation and its undo history. Closing the song cancels an uncommitted audition before the final save. Previews use the ordinary persistence path while open; Cancel writes the restored map.
- Map-lane and transcription editing are suspended while auditioning. Existing drum notation still follows the grid for listening. Its guards reject maps that remove written bars or strand notes.

## Sources and formats

| Source | Integration | Limits |
| --- | --- | --- |
| Chorus Encore | Live catalog search with charter and drum availability. Selecting a match reads only SNG headers/index and the notes entry using bounded HTTP ranges. | Community chart quality varies; a guitar-only chart supplies tempo but no drum draft. Unsupported bounded downloads fail with an import fallback. |
| Harmonix Set | Authenticated catalog search and explicit beat-file retrieval. 912 human-annotated recordings; metadata includes meter hints. | Limited repertoire. No automatic claim that a result matches the user's recording. Beat data contains no drum notes. |
| Standard MIDI | Local format 0/1 PPQN tempo and meter events, GM channel-10 percussion, and named Rock Band/Clone Hero Expert drum tracks. | Format 2, SMPTE timing and unsupported meters are rejected. Named game tracks use their own lane and tom-marker rules; ordinary MIDI percussion remains GM. |
| Clone Hero `.chart` | Local SyncTrack tempo/meter with audio Offset; ExpertDrums can seed a draft. | Game drum lanes approximate the kit, including cymbal markers. Other difficulty tracks are not substituted. |
| Beat timestamps | Two or three columns: seconds, beat in bar, optional bar number. Harmonix/Isophonics-style files are accepted. | Missing consecutive beats are rejected. Without a usable meter hint, quarter-note interpretation is explicitly disclosed. |
| Songsterr / Guitar Pro | External search/export, then MIDI import. | No automated scraping or subscription-dependent download integration. Guitar Pro audio sync points may need conversion into score tempo automations before MIDI export. |
| Local SNG / ZIP | Import a Chorus song download directly. The reader selects notes.chart or notes.mid and applies song.ini timing metadata once. | Single-song archives only, 128 MiB maximum. ZIP64, encrypted ZIPs, unsupported compression and ambiguous multi-song packages require extracting the notes file manually. |

MIDI/chart timing becomes native measures and pins. Timestamps remain authoritative; bar IDs are reused by index so written notation remains attached. Negative shifts insert an audio-zero boundary and retain musical coordinates instead of clamping beats together. Clipping inside a gradual ramp is refused. Notes files are limited to 10 MiB, 8,000 pins and 1,024 measures. Online SNG reads cap notes at 750 KiB to fit action return limits. Local archive reads skip audio and bound decompression; they never upload the package.

## Drum drafts

When supported percussion is present, the selection shows a conversion preview and **Use map & import drums**. Keep map alone imports timing only. Drum import uses the active editor and its existing revision-aware store and local journal; it does not create a competing saver.

Supported GM instruments map into Woodshed's kit. Variants, unsupported percussion, duplicates, off-recording events and rounded rhythmic positions are reported. Written durations are inferred from onsets, because a MIDI note-off is a playback gate rather than a notation value. Straight and 3/5/7-tuplet positions are supported. Imported bars are marked in progress and must be reviewed against the recording. The existing score limits apply. Imports refuse to overwrite a written or reviewed part, and normal notation Undo restores the empty part.

## Provider operations

Harmonix annotations and metadata are pinned to commit `64abeb509429e73d74559fb98e621dac866efea1` for reproducible results. Its MIT attribution is in `public/licenses/harmonix-set.txt`. Audio and spectrograms are never fetched. Harmonix search operates on a shared fixed catalog; search terms are not sent to GitHub. Chorus receives the requested artist/title search through its public API. Requests require an active Woodshed account and use fixed provider hosts and validated identifiers. Provider failures are reported separately, preserving the other provider's results, file import and the original map.

Chorus package loading validates 206 responses, byte ranges, stable sizes and ETags and refuses servers that ignore Range. Only bounded metadata, file index and notes bytes are requested; bundled audio and artwork are skipped. Local ZIP imports validate the directory, entry bounds, CRC and actual decompressed size. Package delay is milliseconds; a positive delay moves notes later, separately from the chart's own Offset. Repeated chart_offset metadata is not applied again.

Primary references:

- [Harmonix Set documentation and annotation format](https://github.com/urinieto/harmonixset/tree/64abeb509429e73d74559fb98e621dac866efea1)
- [Guitar Pro audio synchronization and score tempo automations](https://www.guitar-pro.com/docs/gp8/audio/backing-track)
- [Songsterr export features](https://www.songsterr.com/plus)
- [Chorus Encore's official Bridge client](https://github.com/Geomitron/Bridge)
- [SNG file format](https://github.com/mdsitton/SngFileFormat)
- [Guitar-game MIDI drum track documentation](https://solamint.github.io/GuitarGame_ChartFormats/Chart-File-Formats/mid-format/Tracks/Drums/)

Validation includes parser/meter/offset fixtures, provider authorization and download bounds, source switching and cancellation, native undo and notation overwrite protection, archive security, and player teardown/race regressions. Live upstream checks imported five representative Harmonix maps, including mixed meter, 3/4 and 6/8, with every pin timestamp exactly matching its source. The live Chorus search/load flow found Meshuggah's Born In Dissonance (Zantor + Voxelated), extracted its 145,645-byte chart using 146,609 bytes of ranged transfers from a 4,325,280-byte SNG, and parsed its six tempo pins. That particular chart contains guitar only and correctly offers no drum draft. Browser visual verification from the cloud environment could not reach the local test server; automated DOM interaction tests cover the player and source panel. Native release CI supplies packaged-app launch and platform checks.
