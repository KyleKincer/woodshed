# Tempo maps and drum drafts

Open a song, choose **Tempo map → Find / import…**. The source browser stays beside the recording and tempo lane. It offers Harmonix lookup and local file imports. It never selects a catalog result automatically.

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
| Harmonix Set | Authenticated catalog search and explicit beat-file retrieval. 912 human-annotated recordings; metadata includes meter hints. | Limited repertoire. No automatic claim that a result matches the user's recording. Beat data contains no drum notes. |
| Standard MIDI | Local format 0/1 PPQN tempo and meter events, plus GM channel-10 percussion. | Format 2, SMPTE timing and unsupported meters are rejected. Game-specific MIDI lane encodings are not GM percussion and are not converted into invented kit notes. |
| Clone Hero `.chart` | Local SyncTrack tempo/meter with audio Offset; ExpertDrums can seed a draft. | Game drum lanes approximate the kit, including cymbal markers. Other difficulty tracks are not substituted. |
| Beat timestamps | Two or three columns: seconds, beat in bar, optional bar number. Harmonix/Isophonics-style files are accepted. | Missing consecutive beats are rejected. Without a usable meter hint, quarter-note interpretation is explicitly disclosed. |
| Songsterr / Guitar Pro | External search/export, then MIDI import. | No automated scraping or subscription-dependent download integration. Guitar Pro audio sync points may need conversion into score tempo automations before MIDI export. |
| Chorus Encore | External song/artist search, then chart/MIDI import. | Its client downloads full `.sng` song packages including audio. Woodshed does not download those packages just to extract timing. |

MIDI/chart timing becomes native measures and pins. Timestamps remain authoritative; bar IDs are reused by index so written notation remains attached. Negative shifts insert an audio-zero boundary and retain musical coordinates instead of clamping beats together. Clipping inside a gradual ramp is refused. Files are limited to 10 MiB, 8,000 pins and 1,024 measures.

## Drum drafts

When supported percussion is present, the selection shows a conversion preview and **Use map & import drums**. Keep map alone imports timing only. Drum import uses the active editor and its existing revision-aware store and local journal; it does not create a competing saver.

Supported GM instruments map into Woodshed's kit. Variants, unsupported percussion, duplicates, off-recording events and rounded rhythmic positions are reported. Written durations are inferred from onsets, because a MIDI note-off is a playback gate rather than a notation value. Straight and 3/5/7-tuplet positions are supported. Imported bars are marked in progress and must be reviewed against the recording. The existing score limits apply. Imports refuse to overwrite a written or reviewed part, and normal notation Undo restores the empty part.

## Provider operations

Harmonix annotations and metadata are pinned to commit `64abeb509429e73d74559fb98e621dac866efea1` for reproducible results. Its MIT attribution is in `public/licenses/harmonix-set.txt`. Audio and spectrograms are never fetched. Search operates on a shared fixed catalog; user audio and search terms are not sent to GitHub. Requests require an active Woodshed account, use catalog-owned identifiers, and cap streamed responses at 1 MiB with a 15-second timeout. Provider failures preserve file import and the original map.

Primary references:

- [Harmonix Set documentation and annotation format](https://github.com/urinieto/harmonixset/tree/64abeb509429e73d74559fb98e621dac866efea1)
- [Guitar Pro audio synchronization and score tempo automations](https://www.guitar-pro.com/docs/gp8/audio/backing-track)
- [Songsterr export features](https://www.songsterr.com/plus)
- [Chorus Encore's official Bridge client](https://github.com/Geomitron/Bridge)

Validation includes parser/meter/offset fixtures, provider authorization and download bounds, source switching and cancellation, native undo and notation overwrite protection, and player teardown/race regressions. Live upstream checks imported five representative maps, including mixed meter, 3/4 and 6/8, with every pin timestamp exactly matching its source. Browser visual verification from the cloud environment could not reach the local test server; automated DOM interaction tests cover the player and source panel. Native release CI supplies packaged-app launch and platform checks.
