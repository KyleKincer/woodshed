# Metadata, CSS and backend map (Woodshed 1.9.0 → 2.0 "Stage")

This document supports the 2.0 rebuild described in `docs/ux2/spec.md`. It covers three areas:

- **(a) metadata and details editing.** This is everything Edit · Details (spec §5.3) replaces or relies on: `src/js/song-metadata.js`, its CSS, `convex/metadata*.ts`, `convex/lib/songMetadata.ts`, `convex/lib/musicBrainz.ts` and `convex/artworkUpload.ts`. It also covers the backend surfaces that the B1, B2, B3 and B8 items touch: `convex/songs.ts`, `convex/schema.ts`, `convex/settings.ts` and `convex/lib/presets.ts`.
- **(b) all CSS.** That means `src/css/*.css` and `src/js/**/*.css`, plus theme handling, fonts, z-index, radii, `!important`, literal colours, and the JavaScript that reads CSS tokens.
- **(c) static serving.** This covers the Electron static server, the `public/` folder and `vite.config.js`.

The code base is at commit `820f4db` (v1.9.0). Every `file:line` reference is relative to `/home/user/woodshed`, and no source files were changed. The counts in the CSS sections come from a comment-stripping scan of the parsed declarations, not from a plain text grep.

**Owner decisions applied.** All the spec's recommendations are accepted. There are **no users to protect**, so this map proposes no Classic keys, key-change hint, "What's changed" sheet, "new" badges, rollout-only `ws.flags`, or lingering legacy CSS layer. Stored data is still read correctly through a cheap one-way upgrade with no UI ceremony: `songs.practice` v1, `ws.*` prefs, legacy tempo maps, `userSettings` rows and existing metadata locks. Some proposals below are only allowed because of this decision; they are marked **[no-compat]**. Examples are dropping the legacy `detected` beat copy in `tempo`, deleting `songs.rename`, and renaming tokens without aliases.

Other maps own neighbouring areas: `shell.md` (shell, library, jobs UI, settings UI), `transport.md` (engine, practice v2 client, player) and `mapedit.md` (map-mode, song-map, tempo-sources, notation). Where a finding here depends on their code, it is stated once and cross-referenced.

---

## 1. Edit · Details: what exists today

### 1.1 `src/js/song-metadata.js` (365 lines), by line

| Lines | What | 2.0 fate |
|---|---|---|
| 1-4 | Imports `backend`, `focusModal` (`modal-focus.js`), `setArtwork` (`artwork.js`), and the CSS side-effect import `./song-metadata.css`. | The CSS import goes. `modal-focus.js` is deleted in Phase 4 (spec §9.6). |
| 6-19 | `songFields`: 12 `[key,label]` pairs. 0-7 are Song details (title, artist, album, albumArtist, year, genre, trackNumber, discNumber). 8-11 are Practice (musicalKey, tuning, tags, notes). | **Keep.** Move it to `src/edit/details/fields.js`. The new grouping is Song (8) and Practice (4); spec §5.3 relabels "Musical key" as "key". |
| 20-25 | `friendlyError`: uses `error.data` when it is a string; `[CONVEX` → generic copy. | Moves to `src/app/feedback.js` (one error-copy mapper, spec §9.8 "error-copy mapping"). |
| 26-29 | `durationLabel` (m:ss) | Reuse a shared time formatter. |
| 30-37 | `esc` HTML escaper | Replaced by `h()` (DOM, not strings). |
| 38-40 | `artistLabel(song)`: `artist`, else `uploader`, unless `artist` is locked (a deliberately cleared artist stays empty). | **Keep; it is used by Library and the Stage.** Today it is imported by `player.js:4,228,233` and `library.js:3,102`. Move it to a shared song util (`src/library/song-labels.js`). |
| 41-46 | `commonValue(songs,key)`: the shared value, or `null` when values differ (bulk "Multiple values"). Tags are compared as a comma-joined string. | Keep (bulk mode). |
| 47-68 | `draftPatch(form,touched)`: builds the patch from touched keys. Tags are split on `,`, trimmed, deduped (case-sensitive) and emptied. | Replaced by per-field serializers (§1.6, G1). |
| 70-71 | `editSongs(songs, api=backend)` is the entry point. It is a singleton: it refuses while `.metadata-modal` exists. | Replaced by the `/s/:id/edit/details` route plus a bulk route (§1.6, G9). |
| 82-88 | Field markup. `maxlength` is 500 (tags 1800, notes 10000). There are 4-digit `pattern`s for year and `[1-9][0-9]{0,3}` for track/disc, `inputmode=numeric` on numbers, and `required` on title (single only). In bulk mode the placeholder reads "Multiple values — unchanged", and each label has a per-field `data-apply` checkbox (86). | Becomes Field primitives (TextField, Textarea, ChipInput) with the same constraints. |
| 89-93 | Modal markup: heading "Edit song" / "Edit N songs"; the bulk hint "Only checked fields will change… Empty checked fields will be cleared."; the artwork row (single only); the lookup row; two `<h3>` groups; a footer with a `role=status` message, Cancel and Save (disabled until something is touched). | Becomes a page (`/s/:id/edit/details`) inside the Edit posture frame (spec §5.0). |
| 98-105 | `sync()`: Save is disabled while busy or untouched; `.is-edited` is set on touched fields. | Becomes per-field "Saved" / error InlineStatus. |
| 106-113 | `close()`: refuses while busy; `window.confirm("Discard your unsaved changes?")` when touched (108); revokes the preview URL. | **Deleted.** Autosave makes the confirm unnecessary (spec §5.3, §7.9). |
| 114-117 | `focusModal(modal, close)`. Outside clicks intentionally do nothing (117). | Deleted (a page, not a modal). |
| 118-132 | Input marks a field as touched and auto-checks its bulk apply box; unchecking an apply box un-touches it. | Becomes the bulk "Apply to N songs" model (§1.6, G10). |
| 133-149 | Live artwork preview with `setArtwork` (single only). Starts with `song.coverUrl`, then signs `song.coverKey` (143-149) unless artwork was touched. | Keep the logic and the fallback sleeve (`artwork.js:6-19`). |
| 150-180 | Upload: hidden `<input type=file accept=jpeg,png,webp>`. It rejects files over 2,000,000 bytes or of another type (156-162), checks the image with `createImageBitmap` (163-170), then creates an object URL preview and sets `touched.add('artwork')` (172-179). | Keep the checks; save immediately (autosave). |
| 181-187 | Remove artwork → `{kind:'removed'}` | Keep (immediate, with Revert). |
| 188-189 | `[data-find]` → `openLookup(false)`; `[data-cover]` → `openLookup(true)` (cover-only) | Match section and Artwork "Choose another cover" |
| 191-323 | `openLookup(coverOnly)`. Inline panel: Title and Artist inputs prefilled from the form, Search, Close search, attribution (195). A generation counter drops stale results (194, 201, 205). | Match section (§1.6, G4/G5) |
| 203-274 | `run(recordingId?)` → `api.findMetadata(id,title,artist,recordingId)`. Rows show the CAA thumbnail `front-250`, title (or album when listing releases), and an artist · album · year · duration · disambiguation line. They offer "Review" (or "Use cover" in cover-only mode with a `releaseId`) and "Albums / covers" (lists releases for that recording, 230). Cover-only plus a release sets `artwork={kind:'release',releaseId}` and previews `front-500` (232-245). Errors restore the previous results with an error line on top (264-270). | Same flows inside the Match section |
| 275-312 | `review(candidate)`. A field diff covers only string fields that differ from the *draft*. A checkbox is pre-checked unless that field is in `song.metadataLocks` or touched this session (289). "These details already match your draft." `Use selected details` copies the values into the form and marks them touched (301-310). | Kept as the "field-diff review with checkboxes". Apply must save at once **and record the match** (G4). |
| 313-322 | Enter in search fields runs the search. The search auto-runs on open (322). | Keep (spec: "pre-filled and auto-run" is the Find-a-chart pattern; reuse it here). |
| 324-364 | Submit. A cleared title is refused ("Enter a song title.", 328-332). Everything is disabled while saving. An artwork upload runs first via `api.uploadArtwork` (341-347), then `api.updateMetadata(ids, changes)` (350-353) runs as **one** mutation for all songs. Errors show `friendlyError` and re-enable the form. | Becomes per-field saves (G1). |

**Callers to rewire:**
- `player.js:237`, the header pencil (`.header-edit-song`, 22×22 px). Deleted in Phase 1a, along with the header band.
- `library.js:418`, card menu "Edit song…" → `Edit details… E` (spec §2.5).
- `library.js:678`, selection bar "Edit selected" → bulk Details.

### 1.2 `src/js/song-metadata.css` (320 lines)

| Lines | Selectors | Note |
|---|---|---|
| 1-3 | `.metadata-modal{z-index:300}` | One of the 22 z-levels (§8.5) |
| 4-189 | `.metadata-editor`, `-heading`, `-eyebrow` (dead: no markup emits it), `-body`, `-art*`, `-lookup`, `-fields` (2-column grid; `.wide` spans both), `-field` (`is-edited` turns the label accent), `-footer`, `-message`, `-search`, `-match`, `-review` | All deleted with the modal |
| **190-221** | `.library-selection`, `.song-select` (z 6), `.list-row .song-select`, `.card.is-selected`, `.list-row.is-selected` | **Library selection styles live in the metadata CSS.** They load only because `library.js` imports `song-metadata.js`. When the modal is deleted, Library selection loses its styles unless they move. They are replaced by the Phase 3 selection bar. |
| 222-238 | `.header-edit-song` (22 px pencil) | Deleted with the header band |
| 239-290, 297-304 | `@media (max-width:600px)`: full-screen sheet (`100dvh`, safe-area footer); title, artist, album and albumArtist span both columns | Becomes a responsive page. iPad portrait is 820 px, so this breakpoint never fires there. |
| 292-295 | `.metadata-editor button:disabled{opacity:.45}` | Use the primitives' disabled state instead |
| 306-320 | `.metadata-attribution` (11 px), `.metadata-lookup` `:has()` layout | Attribution must stay at ≥ 12 px (spec §8.1 minimum) |

Literal values in this file: `border-radius` 2px (109), 3px (226) and 0 (249); `z-index` 300 (2) and 6 (205); 11 font-size declarations, including 10 px (26) and 11 px (173, 309).

### 1.3 Client → server calls (`src/js/backend.js`)

| backend.js | Convex | Notes |
|---|---|---|
| `updateMetadata(ids,changes)` :226 | `metadata.update` mutation | 1–100 ids |
| `findMetadata(id,title,artist,recordingId?)` :228 | `metadataLookup.find` action | ≤ 12 recordings, or ≤ 100 releases when `recordingId` is given |
| `metadataDetail(id,recordingId,releaseId?)` :229 | `metadataLookup.detail` action | One full candidate |
| `uploadArtwork(id,file)` :230-236 | `artworkUpload.prepare` → PUT to a signed R2 URL with `x-amz-checksum-sha256` → `artworkUpload.complete` | SHA-256 is computed on the client (231) |
| `signKey(key)` :103 | `media.signKeys` | Cover preview |
| `onSong(id,cb)` :227 | `songs.get` subscription | Used by the player header (`player.js:247`); Details needs it too |
| `renameSong` :41 | `songs.rename` | Dead. Delete both (spec §9.6) **[no-compat]**. |
| `listLibrary` :27 | `songs.list` one-shot | Dead (only `onLibrary` :32 is used) |

### 1.4 Server semantics Edit · Details must respect

**`metadata.update` (`convex/metadata.ts:24-80`)**
- Calls `requireUserId` (24-28). The account must not be suspended, but export-only accounts **can** edit metadata, unlike `settings.save`, which is writable-only (inconsistent; decide).
- Deduplicates ids, and allows 1–100 of them ("Select between 1 and 100 songs.", 29-31).
- Runs `cleanMetadata(changes)` (32). An empty patch is a no-op (33).
- `artwork.kind==='upload'` is allowed for a single song only (34-35). The `audioObjects` row must be owned, linked to this song, verified, not deleting and not expired (40-57). Otherwise it fails with "Artwork upload expired. Choose the image again."
- Replacing an uploaded artwork retires the old key (59-65).
- **Side effects of every patch** (66-76):
  - title or artist in the patch clears `metadataRecordingId` **and** `metadataReleaseId`;
  - album or albumArtist clears `metadataReleaseId`;
  - **every key in the patch is added to `metadataLocks`**, including keys whose value did not change, and including `artwork`.
- `metadataStatus` is **never** changed by user edits.
- It is atomic across all ids: one bad id fails the whole batch (36-39). The tests rely on this (`convex/metadata.test.ts:47`, "bulk edits are scoped, atomic, and modify only supplied fields").

**`cleanMetadata` (`convex/lib/songMetadata.ts:46-84`)** is the only validator.

| Rule | Lines | Error copy |
|---|---|---|
| Strings are trimmed | 51 | none |
| Length ≤ 500 (notes ≤ 10,000) | 52-53 | `` `${key} is too long.` ``. This leaks the raw key, for example "albumArtist is too long.". It needs mapping to a label. |
| A title cannot be empty | 54-55 | "Enter a song title." |
| Year must be `^\d{4}$` when not empty | 56-57 | "Use a four-digit release year." |
| Track and disc must be `^[1-9]\d{0,3}$` when not empty | 58-65 | "Track and disc numbers must be positive whole numbers." |
| Tags: ≤ 30 tags, each ≤ 60 characters; trimmed and deduplicated (case-sensitive) | 68-77 | "Use up to 30 tags, each at most 60 characters." |
| `artwork.release` must be a valid MBID | 78-82 | "Invalid cover selection." |

Fields are stored as strings (`metadataFields`, `songMetadata.ts:8-22`); year, track and disc are strings too. `artworkValidator` (3-7) is `removed | upload{key} | release{releaseId}`. `coverKeyOf` (93-102): explicit artwork wins over the imported `coverKey`, and `removed` yields no key.

**Automatic enrichment.** `metadataLookup.enrich` (`convex/metadataLookup.ts:200-274`) is scheduled at:
- `worker.finish` for new non-import songs (`convex/worker.ts:96-99`; status `pending`);
- `renditions.claimInto` for dedupe hits (`convex/renditions.ts:72-74`).

Enrichment calls `metadata.applyAutomatic` (`metadata.ts:81-136`), which:
- applies only unlocked keys (`unprotected`, 97);
- applies only keys whose value still equals the `before` snapshot (99-105), so an edit during the lookup wins;
- treats album identity as coherent: if any of album/albumArtist/year/track/disc is locked, it drops all of them plus artwork (107-121);
- sets `metadataStatus` and, with a candidate, `metadataRecordingId` (and `metadataReleaseId` when the album was applied) (122-133).

**Lookup gating and limits.**
- Every MusicBrainz request throws "Online metadata lookup is currently unavailable. You can still edit every field." unless `MUSICBRAINZ_ENABLED==='true'` (`metadataLookup.ts:26-29`).
- Responses are cached for 24 h (`metadata.ts:180-215`).
- Requests are spaced 1.2 s apart for MusicBrainz and 0.4 s for AcoustID. A wait longer than 25 s throws "Metadata lookup is busy. Try again shortly." (`metadata.ts:137-154`).
- `find` refuses title or artist over 500 characters (151-152). When the text search is weak and a fingerprint exists, the AcoustID top match is prepended (164-176).
- `detail` validates MBIDs (191-192). It throws "This recording is not on the selected release." when the release does not contain the recording (131-136).
- Matching is conservative (`convex/lib/musicBrainz.ts:74-90`). Title and artist must match exactly after normalisation, duration must be within min(3 s, 1.5%), there must be no disambiguation, and exactly one recording id must qualify. `selectRelease` (91-119) returns nothing on ambiguity.

**Artwork upload limits** (`metadata.ts:216-264`, `artworkUpload.ts:8-56`):
- ≤ 2,000,000 bytes; JPEG, PNG or WebP only; base64 SHA-256 checksum.
- Counts against the user and app quotas ("There is not enough cloud storage for this image.").
- The reservation expires after 1 h; the PUT URL expires after 600 s.
- `complete` HEAD-verifies length, type and checksum.

### 1.5 `metadataStatus` lifecycle (`convex/schema.ts:122`)

| Value | Written by | Meaning | Edit · Details copy (spec §5.3) |
|---|---|---|---|
| absent / `null` | Imports (`worker.ts:96` skips them), shared copies (`sharing.sharedSnapshot` does not carry it, `sharing.ts:46-56`), songs from before metadata existed | No lookup was ever run | Show neither state; offer `[Find a match]` |
| `pending` | `worker.ts:97`, `renditions.ts:72` | Lookup queued or running | "Finding song details…" (today `song-metadata.js:90`) |
| `matched` | `applyAutomatic` with a strong recording (`metadataLookup.ts:250-256`) | Auto-applied | "Matched on MusicBrainz". This is only true while `metadataRecordingId` is set; a later title or artist edit clears the id but leaves the status `matched`. |
| `uncertain` | `applyAutomatic`, **no** strong recording (`metadataLookup.ts:218-225`) | No confident match. **Nothing is stored about the best guess.** | "Not sure this is right". Spec §2.4 puts the "Is this right?" chip on the Library card. |
| `unavailable` | Lookup errored after 2 retries, or MusicBrainz is disabled (`metadataLookup.ts:257-270`) | Lookup failed | The spec says "No match found". **Inaccurate:** this state means "lookup unavailable", not "no match". |

Spec mapping problem: "No match found" corresponds to `uncertain` with no candidate, and `unavailable` needs its own copy ("Couldn't reach MusicBrainz · [Try again]").

### 1.6 Gaps between today and spec §5.3, with concrete changes

| # | Gap | Concrete change |
|---|---|---|
| **G1** | **Autosave pollutes locks.** Per-field autosave on blur calls `metadata.update` with one key. The server adds every patched key to `metadataLocks` even when the value is unchanged (`metadata.ts:73-75`), and a title or artist save also wipes the match ids (68-72). | **Client:** send a field only when `clean(value) !== clean(serverValue)`, compared after trim and, for tags, after split/trim/dedupe. **Server:** in `update`, skip keys whose cleaned value equals the stored value, so they neither patch nor lock nor clear ids. This also protects bulk saves. Add a test. |
| **G2** | **Revert** ("for fields changed this session") has no lock semantics. Restoring the old value leaves the field locked, so future automatic enrichment can never touch it. | Add `unlock?: string[]` to `metadata.update` (validated against the `metadataFields` keys). The server removes those keys from `metadataLocks` after patching. The client remembers `{value, locked}` per field at session start, and Revert sends `{changes:{k: original}, unlock: originallyUnlocked ? [k] : []}`. |
| **G3** | **"[Yes, this is right] (locks the match)"** has no backend. `update` never touches `metadataStatus`. | New mutation `metadata.confirm({id})`: owner check, `metadataStatus:'matched'`, and the identity keys present on the song (`title, artist, album, albumArtist, year, trackNumber, discNumber`, plus `artwork` when set) added to `metadataLocks`. The Library "Yes, that's it" calls the same mutation. |
| **G4** | **Applying a reviewed match loses the match.** "Use selected details" (`song-metadata.js:301-310`) produces an `update` with title and artist, and `update` clears `metadataRecordingId`/`metadataReleaseId` (`metadata.ts:68-72`). The song never becomes "Matched", and the status stays `uncertain`. | Add an optional `match?: {recordingId, releaseId?}` arg to `metadata.update`, single id only, MBID-validated. When present, the server sets `metadataStatus:'matched'` and the ids **after** the clearing rule. "Use selected details" sends the selected fields together with `match`, so it is one autosave and one undo point. |
| **G5** | **"Is this right?" (Library, spec §2.4) needs "the match (title, artist, album, cover)"**, but `uncertain` stores no candidate (`metadataLookup.ts:219-224` passes `changes:{}`). | Schema: add `metadataSuggestion: v.optional(candidateValidator)` to `songs`. In `enrich`, when `strongRecording` fails but `found.length`, store `candidate(found[0], selectRelease(song.album, found[0].releases ?? []))`. That needs no extra MusicBrainz call: the search already includes releases. `applyAutomatic` gains `suggestion?`. Clear it on `confirm`, on a `match` apply and on any title or artist edit. Add it to the list projection (B1 row: `needsReview`, `suggestion` title/artist/album/releaseId). |
| **G6** | **"Needs review … or an untitled upload"** has no signal. Uploads go through enrich like the others. | Derive it on the server in the list row: `source?.type==='upload' && !artist && title === basename(source.filename)`. Put it in the B1 row as `needsReview: boolean`. |
| **G7** | Error copy leaks keys (`` `${key} is too long.` ``, `songMetadata.ts:53`). Errors are form-level today; spec §5.3 wants per-field inline status. | Move the rules into `shared/metadata.ts` as pure functions: `validateField(key, raw) → {value} \| {error, field}`, plus `LIMITS`. Both `cleanMetadata` (server, wrapping errors in `ConvexError({field, message})`) and the Details page (client pre-validation) use it. Convex already imports `../shared/*` (`convex/songs.ts:12`, `convex/sharing.ts:10`). Copy uses labels: "Album artist is too long (500 characters max)." |
| **G8** | `window.confirm` (`song-metadata.js:108`) | Deleted; autosave makes it unnecessary (spec §7.9). |
| **G9** | **Bulk mode has no URL.** Spec §5.3 says "the same page in bulk mode" from Library selection; §1.2 lists only `/s/:id/edit/details`. Bulk also needs **full** rows: `commonValue` over notes and tags. B1 drops `notes` from the list (§3). | Route `/edit/details?ids=a,b,c` (≤ 100 ids, `replaceState`; Back returns to Library with the selection restored). New query `songs.getMany({ids})` (≤ 100, owner-scoped, returns `toClient`) so bulk mode never depends on list fields. |
| **G10** | Bulk "Apply to 3 songs" checkboxes vs "autosave, no global Save". Checkbox-then-autosave-on-blur across up to 100 songs is surprising. | Each bulk field has a value, an `[Apply to N songs]` button and a "Multiple values — unchanged" placeholder. Apply is one `metadata.update(ids, {k: v})`, then an inline "Applied to 3 songs · Revert". Revert sends per-song originals, which needs `metadata.updateEach({items:[{id,changes,unlock}]})` (≤ 100) because originals differ per song. Clearing a field is an explicit Apply with an empty value; the old "checked empty fields are cleared" rule stays visible. |
| **G11** | Artwork flows with autosave | Upload saves right away (`uploadArtwork` → `update({artwork:{kind:'upload',key}})`). Choose cover → `update({artwork:{kind:'release',releaseId}})`. Remove → `{kind:'removed'}`. Revert restores the previous artwork value. Restoring a previous **upload** is impossible because `update` retires the old key (`metadata.ts:59-65`), so Revert after replacing an upload can only offer "Remove". To make full revert possible, defer `retireKey` by scheduling it ~1 h later instead of running it inline. |
| **G12** | Live data vs editing | Subscribe to `songs.get` (`backend.onSong`). Overwrite a field from the server only when it is not focused and has no pending save. An enrichment finishing mid-edit then fills only untouched fields. That is already the server rule (`applyAutomatic` `before` check, `metadata.ts:99-105`). |
| **G13** | Lookup disabled or busy | Render the `ConvexError` strings above (§1.4) as `InlineStatus` tone `warn` inside the Match section. Every field stays editable. |
| **G14** | Tags ChipInput | Commit a chip on Enter, comma or blur. Show ≤ 30 chips of ≤ 60 characters each. Dedupe **case-insensitively** on the client; the server's `Set` is case-sensitive (`songMetadata.ts:74-76`), so making it case-insensitive is a one-line change. Backspace on an empty input removes the last chip. Each chip has a ✕ with an aria-label. |
| **G15** | Notes (≤ 10,000 characters) are "shown in the Stage Notes card" (§5.3). The Stage reads them from `songs.get` (`toClient` has `notes`, `songs.ts:53`). | Debounced save of the textarea (≈ 1 s idle) plus flush on blur, route unmount and `pagehide`. Do not rely on blur alone: removing a focused element does not reliably fire `blur`. |
| **G16** | Read-only contexts | Shared Stage (`/share/:token`) never links to Details (`player.js:237` already gates on `readOnly`). Export-only accounts: decide whether metadata stays editable (today it does, G-note in §1.4) and show a Banner if not. |
| **G17** | The `metadataStatus` copy mismatch (§1.5) | Map `unavailable` → "Couldn't reach MusicBrainz" + `[Try again]`. That needs a public `metadataLookup.retry({id})` that re-schedules `enrich` (owner-scoped, rate-limited by the existing `requestSlot`). Map `uncertain` without a suggestion → "No match found". |

### 1.7 Proposed module shape (spec §9.2 `src/edit/details/`)

```
src/edit/details/details.js   mount(el,{songId}|{ids},ctx) → {update,unmount}; posture label "Editing details"
src/edit/details/fields.js    songFields, groups, per-field serialize/compare (from song-metadata.js:6-68)
src/edit/details/artwork.js   cover, Choose another cover (lookup coverOnly), Upload, Remove (from :133-187, :232-246)
src/edit/details/match.js     status line, Yes/Find another, results, Albums/covers, diff review, attribution (from :191-323)
src/edit/details/bulk.js      Apply-to-N rows (G10)
shared/metadata.ts            validateField / LIMITS (G7), used by convex/lib/songMetadata.ts
```

Deleted in Phase 4: `src/js/song-metadata.js` (after `artistLabel` moves), `src/js/song-metadata.css` (after its Library-selection block, 190-221, is replaced in Phase 3), `modal-focus.js`, and the fixture's dialog paths.

### 1.8 Tests

- **Convex** (`convex/metadata.test.ts`), new cases:
  - no-op keys are not locked (G1);
  - `unlock` (G2);
  - `confirm` sets `matched` and locks (G3);
  - `match` survives the title/artist clearing (G4);
  - a suggestion is stored on `uncertain` and cleared on edit (G5);
  - `getMany` is scoped and capped (G9);
  - `updateEach` is atomic (G10).
- **Unit:** `shared/metadata.ts` rules mirror the current server errors (G7).
- **Fixture** (`tests/fixture/db.js:43,61`):
  - `metadataStatus: 'done'` and `'none'` are not valid schema values; use `matched` / `uncertain` / `unavailable` / `pending` / `null`;
  - `metadata:update` (:167-170) must mimic locks, id clearing and `match`;
  - add `metadata:confirm`, `songs:getMany` and `metadataLookup:retry`.
- **Visual baselines:** Edit · Details single, bulk, matched, uncertain with a suggestion, lookup unavailable.

---

## 2. Backend reference (songs, schema, settings)

### 2.1 `convex/songs.ts` (166 lines)

| Export | Lines | Kind | Auth | Notes |
|---|---|---|---|---|
| `list` | 21-34 | query | `getUserId` (null → `{songs:[]}`; suspended throws via `assertAccountAccess`) | `by_user_added`, `desc`, `.take(1000)`, `songs.map(toClient)`. **Reads every full document**, including `tempo` and `practice`. |
| `get` | 36-45 | query | owner or null | `toClient` |
| `toClient` | 49-75 | helper | none | Shape below (§2.2). Also used by `exportPage` and `rename`. |
| `rename` | 77-86 | mutation | `requireOwned` | Unused (backend.js:41 is dead). Delete **[no-compat]**. |
| `saveTempo` | 88-96 | mutation | `requireOwned` | Opaque `v.any()`. Patched only if `!sameContent` (93). **No size cap.** |
| `remove` | 98-106 | mutation | `requireOwned` | → `deleteSongData` |
| `deleteSongData` | 108-140 | helper | none | Deletes the notation part, retires stem, cover and upload keys, cancels queued/running jobs (`by_song`, ≤ 100), releases the rendition and best-effort-deletes untracked R2 objects, then deletes the row. **Also called by billing cleanup** (`convex/billingData.ts:123-125`). |
| `requireOwned` | 142-148 | helper | `requireUserId`, **not** writable | So export-only accounts can `saveTempo` and `savePractice`. |
| `savePractice` | 151-158 | mutation | `requireOwned` | **Cap:** `JSON.stringify(practice).length > 10_000` → "Practice settings too large." (155). Patched only if changed (156). No shape validation. |
| `exportPage` | 159-166 | query | `requireUserId` | `by_user` paginate → `toClient` (export ZIP manifest, `src/js/export.js:13`) |

### 2.2 `toClient` fields (songs.ts:49-75) and who needs them in the list

| Field | Size class | Library 2.0 needs it in the list? |
|---|---|---|
| `id, title, artist, album, albumArtist, uploader, duration, addedAt, stemMode, stems[] (name,key,bytes,mime), coverKey, coverUrl, artwork, source, quality` | small | Yes. Stems give the "6 stems" meta and the bytes for Plan & storage's "5 largest songs" (spec §6.2). Source gives "Open original source ↗". |
| `year, genre, trackNumber, discNumber, musicalKey, tuning, tags` | small | Yes: sort by Key, search covers genre and tags (`library.js:123`), list Key column |
| `metadataLocks, metadataStatus, metadataRecordingId, metadataReleaseId` | small | Status yes (Needs review); locks and ids no |
| `notes` | ≤ 10,000 characters | **No.** It is needed in the Stage Notes card and Details (`songs.get`). |
| `tempo` | Unbounded. `songMap` ≤ 1,024 measures (`shared/notation.ts:24` `MAX_MEASURES`), **plus** a legacy `detected` copy of every beat written on every save (`src/js/metronome.js:63-64`) and `map` | **No.** It is needed for `hasRealMap`, BPM, section names (search) and loop labels → summaries. |
| `practice` | ≤ 10,000 characters today, 32,768 after B2 | **No.** It is needed for Continue/state lines → `practiceSummary`, `lastPracticedAt`. |

Current consumers of `tempo`/`practice` from list rows:
- `app.js:36` `openSong(song)` passes the list row into `player.js`;
- `player.js` reads `song.tempo` (814) and `song.practice` (82, 252, 318-329, 1011);
- `app.js:87` already uses `songs.get` for `?song=`.

After B1 the Stage must mount from `songs.get` (spec §9.4 B1: "The Stage loads full data via `songs.get`").

### 2.3 Schema tables in scope (`convex/schema.ts`)

| Table | Lines | Fields / indexes | 2.0 relevance |
|---|---|---|---|
| `songs` | 119-151 | `...metadataFields`, `metadataLocks`, `metadataStatus`, `metadataRecordingId`, `metadataReleaseId`, `fingerprint`, `userId`, `title`, `uploader`, `artist`, `album`, `duration`, `source`, `coverKey`, `stems`, `stemMode`, `quality`, `renditionId`, `addedAt`, `tempo: v.any()`, `practice: v.any()`, `localImportId`. Indexes: `by_user`, `by_user_added`, `by_user_import`. | B1 summary fields, G5 `metadataSuggestion` |
| `jobs` | 155-190 | `kind: separate \| beats \| import`, `deviceId`, `songId`, `label`, `source`, `settings`, `status`, `stage`, `percent`, `message`, `error`, `meta`, `result`, `attempts`, `createdAt`, `updatedAt`. Indexes: `by_user`, `by_user_status`, `by_song`, `by_device_status`. | Jobs popover (spec §2.8). `jobs.listActive` (`convex/jobs.ts:12-38`) does **not** return `createdAt`, `updatedAt`, `deviceId`, `settings` or `source`, all needed for "started 1:42 ago", "on Kyle's MacBook", "Balanced · 4 stems", "youtube.com/… ↗" and "2 songs ahead". `library.js:62` also filters the list to `kind==='separate'`. The projection needs extending (owned by `shell.md`; the schema needs no change). |
| `devices` | 70-72 | `userId`, `tokenHash`, `name`, `revoked`; `by_token`, `by_user` | B5 adds `lastSeenAt` and a `devices.list` query. There is no public device list today (only admin's). |
| `notationParts` | 38 | `songId` (optional: a shared-copy part has none until `finishImport`, `sharing.ts:164`), `userId`, `header`, `revision`, `lastMutation`, `hitCount`; **only** the `by_songId` index | `hasChart` for the list needs either a `by_userId` index or a denormalized flag (§3) |
| `notationBars` | 39 | `partId`, `bar`; `by_partId` | none |
| `songShares` | 40-42 | `songId`, `userId`, `token` (64 hex), `active`, `createdAt`, `includeNotation`; `by_songId`, `by_token` | B8 demo. One row per song; `create` reuses an active token (`sharing.ts:72`) and rotates it only after `revoke`. |
| `shareImports` | 43-48 | the `snapshot` (`sharedSnapshot`) is copied into the new song | Must carry v2 practice (§7.3) |
| `userSettings` | 192-195 | `userId`, `settings: v.any()`; `by_user` | `profile`, `pins`, `onboarding` and Practice prefs are new keys (spec §1.1). See §2.4. |

There is **no** `by_userId` index on `notationParts`, `songShares` or `shareImports` beyond those listed. The Convex guidelines ask for index names that spell every field (`by_field1_and_field2`, `convex/_generated/ai/guidelines.md` "Schema guidelines"); existing names (`by_user_added`) predate this. Use the convention for new indexes.

### 2.4 `settings.ts` and `lib/presets.ts`

- `settings.config` (`convex/settings.ts:17-37`) returns `withDefaults(row?.settings)` plus the static catalogues `PRESETS`, `DEFAULT_PRESET`, `MODELS`, `STEM_MODES` and `BITRATES` (`presets.ts:17-67`).
- `settings.save({settings: v.any()})` (`settings.ts:39-53`):
  - calls `requireWritableUserId`;
  - stores `withDefaults(args.settings)`, a **whole-object replace**;
  - has **no size cap and no validation**.
- The client sends a full snapshot after each change (`src/js/settings.js:196-203`, `persist()` with a serialized queue).
- `withDefaults` (`presets.ts:92-98`) spreads `DEFAULT_SETTINGS` (69-87: `preset`, `stemMode`, `format`, `bitrate`, `custom`) under the saved object. **Only `custom` is deep-merged.**
- `resolveQuality` (101-117) and `expectedStems` (120-128) feed `jobs.createSeparation` (`jobs.ts:88`).

What 2.0 needs (spec §1.1, §6.2, §6.6):

| Key | Shape | Validation needed |
|---|---|---|
| `profile` | `{instruments: ('drums'\|'bass'\|'guitar'\|'keys'\|'vocals'\|'other')[], primary, openWithMyPart: 'in'\|'out'}` | Enum values, ≤ 6 |
| `pins` | `Id<'songs'>[]` | ≤ 12, deduplicated; strip deleted ids (in `deleteSongData`, or filter on the client) |
| `onboarding` | `{stage?: number, whatDoYouPlay?: true}` | Booleans/ints |
| `practice` (account-level rows of Settings → Practice) | `{stop:'cue'\|'stay', countIn, countEveryPass, keepPitch, wake:5\|10\|30\|'always', edgeFlash}` | Enums. Spec §6.2 marks Distance and Follow as "(this device)", so the rest are account-level; today `ws.stopBehavior` (`preferences.js:7-11`) and `ws.preservePitch` are device-only. |
| `appearance.stage` | `'match'\|'dark'` | Optional, if Stage appearance should roam; otherwise it stays in `ws.prefs`. |

**Concrete change:** add `settings.patch({profile?, pins?, onboarding?, practice?})`. It takes typed validators, merges on the server, and caps each list. That way a pin toggle from one tab cannot overwrite a preset change from another; today `save` replaces everything. Extend `withDefaults` to deep-merge the new sub-objects (as it does for `custom`, `presets.ts:96`). Keep `save` for the Processing section, or move it onto `patch` too.

### 2.5 Every song insert and delete path (for summaries and setlists)

| Path | File:line | B1 summary init | B3 cleanup |
|---|---|---|---|
| New separation | `worker.finish`, `convex/worker.ts:92` (insert) / `:90` (reprocess patch) | Import jobs carry `importMeta.tempo/practice` (92), so compute summaries from them | none |
| Dedupe hit | `renditions.claimInto`, `convex/renditions.ts:56` | Defaults | none |
| Share save | `sharing.finishImport`, `convex/sharing.ts:160` | Compute from `snapshot.tempo/practice` | none |
| Legacy import | `worker.importSong` creates the job (`worker.ts:115-131`); `finish` inserts | Compute; **no practice size cap** on this path today | none |
| Delete | `songs.remove` → `deleteSongData` (`songs.ts:98-140`); billing cleanup → `deleteSongData` (`billingData.ts:123-125`) | n/a | Strip the id from setlists and pins **inside `deleteSongData`** so both paths are covered |

`media.authorizedKeys` (`convex/media.ts:20-24`) also reads up to 1,000 full song documents (legacy fallback for keys without an `audioObjects` row). The byte concern in §3 applies there too.

---

## 3. B1: slim `songs.list` plus summaries (concrete)

**Spec text** (§9.4 table): drop `tempo`/`practice` from the projection; return `hasChart`, `hasRealMap`, `lastPracticedAt` and `practiceSummary {loopLabel, rate, minusMe, spotCount}`, written by `savePractice`. The Stage loads full data via `songs.get`.

**Finding: changing the projection alone does not stop churn or cut read cost.**
- A Convex query reads whole documents.
- `songs.list` reads ≤ 1,000 `songs` docs (`songs.ts:27-31`). It is invalidated by **any** write to any of them, including every `savePractice` (600 ms debounce on the client, `player.js:1010-1021`) and every `saveTempo`.
- What a slimmer projection saves is the payload sent to the client: Convex re-sends only when the result changes.
- It does not reduce `bytesRead`, and it does not stop the re-execution of a 1,000-document query on every practice save.

**Per-song size estimate**, a 5-minute song at 120 bpm:
- `tempo` holds `songMap` (~150 measures × ~80 B ≈ 12 KB) plus `detected` (~600 beats × ~35 B ≈ 21 KB) plus `map`;
- `practice` is ≤ 10 KB, or 32 KB after B2;
- so ~45–65 KB per song.

At 1,000 songs that is ~45–65 MB per `songs.list` run. This is far above Convex's per-function read limit; verify the current figure with the `convex-docs` skill, but it is on the order of 16 MiB. Today's list would fail at a few hundred mapped songs, and B2 makes that worse. The Convex guideline "Separate high-churn operational data … into a dedicated table" (`guidelines.md`, Schema guidelines) applies directly.

**Recommended B1, concrete:**

1. **New table `songPractice`:** `{songId: v.id('songs'), userId: v.string(), practice: v.any(), updatedAt: v.number()}`, index `by_songId`.
   - `savePractice` writes here.
   - It patches the `songs` row **only when the derived summary changes**.
   - One-shot backfill moves `songs.practice` into it, then deletes the `practice` field from the schema **[no-compat]**.
2. **Summary fields on `songs`:**
   ```ts
   lastPracticedAt: v.optional(v.number()),
   practiceSummary: v.optional(v.object({
     loopLabel: v.optional(v.string()),      // "Bridge loop" | "0:48–1:12" | absent
     rate: v.number(), minusMe: v.boolean(),
     surface: v.optional(v.string()),
     spotCount: v.number(),
     spots: v.array(v.object({id: v.string(), name: v.string(), rate: v.number()})), // ≤ 3, for the Continue hero chips (spec §2.2)
   })),
   ```
   The spec's `spotCount` alone cannot render "up to 3 spot chips (`◆ Bridge walk-up · 85%`)" on the hero (§2.2), so the summary needs the top 3 spots too.
3. **Map summary on `songs`,** written by `saveTempo`:
   ```ts
   mapSummary: v.optional(v.object({ real: v.boolean(), bpm: v.optional(v.number()), meter: v.optional(v.string()),
                                     sections: v.array(v.string()) /* ≤ 64 labels, for "Search songs, artists, sections…" (§2.1) */ })),
   ```
   Optionally move `tempo` itself into a `songTempo` table for the same reasons. That touches `saveTempo`, `get`, `sharing.sharedSnapshot`/`tempoSettings` (`sharing.ts:37-44`), `worker.finish` imports, `exportPage` and the fixture. At minimum, **stop writing the legacy `detected`/`map` copies** (`metronome.js:59-64`, "so earlier desktop versions still hear the same clicks") **[no-compat]**. That roughly halves `tempo`, and `song-map.js:30-44` still reads old rows.
4. **`hasChart`:** denormalize `hasChart: v.optional(v.boolean())` on `songs`.
   - Set it in `notation.save` (`convex/notation.ts:67-69`).
   - Set it in `sharing.finishImport` when `notationPartId` exists (`sharing.ts:164`).
   - Clear it in `deletePart` callers (`notation.ts:22-25`, `songs.ts:109`).
   - The alternative, an extra `notationParts` index `by_userId` and one range read per list, is cheaper to build but adds a list dependency on another table.
5. **Shared pure helpers** in `shared/practice.ts`, imported by the client (`src/stage/practice-state.js`) and by `convex/songs.ts`:
   - `migratePractice(v1) → v2`;
   - `summarize(practice, songMap) → practiceSummary`. `loopLabel` needs section labels from the song map, and `savePractice` already loads the song document.
   - `hasRealMap(tempo, hasChart)`;
   - `PRACTICE_CAP`.
6. **`songs.list`** returns `toListRow(song)`:
   - everything in §2.2 marked "Yes";
   - `metadataStatus`, `needsReview` (G6) and `suggestion` (G5);
   - `hasChart`, `mapSummary`, `lastPracticedAt`, `practiceSummary`;
   - no `notes`, `tempo`, `practice`, `metadataLocks` or ids.

   `exportPage` keeps the full `toClient` and joins `songPractice` (50 songs per page). Add `songs.getMany` (G9).
7. **`songs.get`** joins `songPractice` and returns `practice` (v2 after the upgrade) on the same shape the Stage expects.
8. **Backfill:** `internalMutation` `migrations.b1` paginates `songs` (all users) in batches of ~50. For each song it moves `practice`, computes the summaries, and schedules itself with the cursor. The guidelines ("process one batch, then `ctx.scheduler.runAfter(0, …)`") or `@convex-dev/migrations` both fit. Since there are no users, a single run before deploy of the client is enough.
9. **Tests** (`convex-test`):
   - list payload contains no `practice`, `tempo` or `notes`;
   - `savePractice` with an unchanged summary does not patch `songs` (assert via a `list` subscription or `_creationTime`-stable doc);
   - summary computed from v1 and v2;
   - `hasRealMap` rules;
   - `hasChart` follows notation save and delete;
   - `getMany` scoping.
   - Spec §9.8 also wants a list payload size check.
10. **Client rewiring:**
    - `app.js:36` `openSong` and `library.js` callers pass the id;
    - Stage mount subscribes to `songs.get`;
    - `library.js:123` search adds `mapSummary.sections`;
    - fixture `songs:list`/`songs:get` (`tests/fixture/db.js:160-161`) split into list row vs full.

**`hasRealMap` correctness (affects B1 and spec §1.1).** The spec's legacy heuristic includes "`source === 'detected'` with detected beats". Every non-legacy save writes `source:'detected'` and `detected` pulses of the **current** map, including the 120 bpm placeholder (`metronome.js:63-64`). Any song whose tempo was ever saved (count-in, click volume) would therefore count as mapped.

Rule for rows that have a `songMap`:
- use `songMap.origin` when present;
- else pins > 1, or any measure label, or a notation part;
- ignore `source`/`detected`, which are derived.

Apply the `source==='detected'` clause only to legacy rows **without** `songMap` (`song-map.js:34-36`).

**`origin` is stripped today.** `cleanSongMap` (`shared/song-map.ts:163-173`) whitelists `version`, `measures`, `pins` and `tailQpm`, so a client-written `songMap.origin` is dropped:
- on load (`src/js/song-map.js:32`);
- in `adopt` (121);
- in shared snapshots (`sharing.ts:43`).

Add `origin` (`detected|tapped|imported|edited`) to `SongMapData`, `cleanSongMap` and `serialize`. `mapedit.md` owns the change, and B1 depends on it.

---

## 4. B2: practice cap 10 KB → 32 KB (concrete)

- **Change:** `songs.ts:155` `10_000` → a shared `PRACTICE_CAP = 32_768` (from `shared/practice.ts`). The client saver (spec §9.3 "size budget") uses the same constant, and the error stays "Practice settings too large."
- **Unit:** the check measures UTF-16 code units of `JSON.stringify`, not bytes. That is fine as a budget; the Convex document limit is 1 MiB (`guidelines.md` "Validators" table).
- **Apply it to every write path:**
  - `savePractice`;
  - `worker.importSong` (`worker.ts:116-128`; `practice` is unbounded today);
  - `sharing.finishImport` (via the snapshot, already pruned by `practiceSettings`, `sharing.ts:31-36`);
  - the `songPractice` backfill (truncate oversize legacy blobs with the client's prune order: old tombstones, then oldest unnamed markers).
- **Do it only with the B1 `songPractice` split** (§3). Otherwise 32 KB × 1,000 documents goes into every list run.
- **Test:** 32,768 accepted; 32,769 rejected; the import path is capped.

---

## 5. B3: setlists (concrete)

**Schema:**
```ts
setlists: defineTable({
  userId: v.string(),
  name: v.string(),                    // 1–80 chars, trimmed
  songIds: v.array(v.id('songs')),     // ≤ 100 (bounded, so an array is acceptable per guidelines)
  createdAt: v.number(), updatedAt: v.number(), lastOpenedAt: v.optional(v.number()),
}).index('by_userId_and_updatedAt', ['userId', 'updatedAt']),
```

**Functions** (`convex/setlists.ts`):

| Name | Kind | Auth | Behaviour |
|---|---|---|---|
| `list` | query | `getUserId` → `[]` | `by_userId_and_updatedAt` desc, `.take(100)`: `{id,name,count,songIds,updatedAt}` |
| `get` | query | owner or null | `{id,name,songIds}`; ids of deleted songs are already stripped (see cleanup) |
| `create` | mutation | `requireWritableUserId` | `{name, songIds?}`; ≤ 100 lists per user ("Up to 100 setlists"); validates every id is owned; returns id |
| `rename` | mutation | writable + owner | trim, 1–80 |
| `setSongs` | mutation | writable + owner | Replaces the order (reorder, remove). ≤ 100 ids, all owned, deduplicated. |
| `addSongs` | mutation | writable + owner | Appends owned ids not already present (card menu "Add to setlist ▸", selection bar); refuses past 100 |
| `remove` | mutation | writable + owner | deletes |
| `touch` | mutation | owner | sets `lastOpenedAt` (for ordering "Setlists" on Home); optional |

**Cleanup:** in `deleteSongData` (`songs.ts:108`), query `setlists` by `by_userId_and_updatedAt` for `song.userId` (≤ 100) and patch every list that contains the id. This covers `songs.remove` and billing cleanup (`billingData.ts:125`). The same hook strips the id from `userSettings.settings.pins` (§2.4).

**Export:** add `setlists.json` to the ZIP (`src/js/export.js:36` already writes `settings.json`) via an `exportPage`-style query or `setlists.list`.

**Fixture:** add `setlists:*` handlers to `tests/fixture/db.js`.

**Tests** (spec §9.8 "convex-test for setlists ownership and cleanup"):
- Bob cannot read, rename or modify Alice's list;
- Bob cannot add Alice's song ids to his own list;
- caps (100 lists, 100 songs, name length);
- deleting a song strips it from lists, via both delete paths;
- export-only accounts cannot mutate.

**Client contract** (other maps): `/set/:id` and `/s/:id?set=:setId`; the HUD reads "Set: Thursday · 2/5 · next: Velvet Arc"; ⌥↑/⌥↓ and pedal hold move through the set.

**Open point for the orchestrator.** Spec §2.2 says Pinned "becomes **Setlists**" with B3, but the card menu (§2.5) keeps `Pin` / `Unpin` next to `Add to setlist ▸`. Decide either:
- (a) keep pins as their own quick row (`settings.pins`); or
- (b) drop pins and treat setlists as the only grouping.

Recommendation: (a). Pins cost nothing and cover "my 5 current songs", while setlists cover rehearsals.

---

## 6. B8: demo song token (concrete)

**Spec:** `VITE_DEMO_SHARE_TOKEN` → "Open example" opens `/share/<token>` as a Shared Stage with Minus me from the profile. "Add to my library" uses `shareAudio.save`, and "no backend code" is needed.

**Findings:**

1. **Shared snapshots cannot carry the demo's spot, or v2 practice at all.**
   - `practiceSettings` (`sharing.ts:31-36`) whitelists `rate`, `loop{enabled,a,b}`, `grid{…}` and `tracks[≤8]{name,volume,muted,soloed}`.
   - The demo needs one spot ("Chorus fill · bars 19–20", spec §6.6.4), and spec §9.3 renames `loop.enabled` → `loop.on`. A v2 owner blob would share with **no loop at all**.
   - So B8 needs server code: extend `practiceSettings` to v2 (`v`, `cue`, `surface`, `loop{on,a,b,aBar,bBar,eachPassCount,playTimes}`, `spots[≤24]{id,name,a,b,aBar,bBar,rate,note?}`, `markers[≤64]`, `trainer`, `keepPitch`, `minusMe` false), still dropping `notes` and private fields.
   - Run it through `shared/practice.ts#migratePractice` so v1 sources still share.
   - Update `convex/sharing.test.ts:29,45,69`.
2. **Section and origin data:** the `tempoSettings` → `cleanSongMap` path drops `songMap.origin` (§3), so a shared mapped song falls back to the heuristic.
3. **Token placement.** `VITE_*` values are baked in at build time:
   - `vite.config.js` has no `define`;
   - Vercel builds via `vercel.json` `buildCommand`;
   - the desktop app loads the built `dist/` (`desktop/main.cjs:16`).

   Rotating the token (revoke + create gives a new token, `sharing.ts:73-75`) then needs a desktop release. Two options:
   - **(a)** Keep `VITE_DEMO_SHARE_TOKEN`. Add it to `.env.local.example` and the Vercel env, and validate it against `/^[a-f0-9]{64}$/` on the client (the `shared-song.js:9` pattern).
   - **(b)** A server-side `DEMO_SHARE_TOKEN` env var in `convex/convex.config.ts` `env` (lines 9-24), plus a public query `settings.demo()` → `{token} | null`. No rebuild is needed to rotate.

   Recommendation: (b). It is three lines of server code and avoids stale tokens in shipped desktop builds.
4. **Availability rules the demo inherits** (`sharing.sharedSource`, `sharing.ts:14-26`):
   - the owner account must not be suspended;
   - stems must number 1–8;
   - every stem object must be `ready`.

   The demo must be shared with `includeNotation: true` (`notation.ts:18-21,33`). If it is unavailable, the Library demo card should hide itself rather than open the "Song unavailable" page (`shared-song.js:27-31`).
5. **Add to my library:**
   - `shareAudio.save` (`convex/shareAudio.ts:17-45`) charges the user's quota for the ≈ 5 MB (`sharing.ts:131-133`);
   - it enforces the 1,000-song limit (130);
   - it is idempotent through `sharing.saved` / `shareImports.by_userId_and_sourceSongId` (104-113, 125-127).
6. **Routing:** `/share/:token` has its own boot (`app.js` → `renderSharedSong`, `src/js/shared-song.js:8-78`), which creates a second `ConvexClient` (24). Opening the demo from the signed-in Library is a full navigation (`location.assign`) unless the router hosts the Shared Stage in-app. Spec §1.2 says it "keeps its own boot path", which is fine.
7. **Share origin** (spec §6.1): `share-dialog.js:14` hard-codes `https://woodshed.kylekincer.com/share/…`. Add `VITE_SHARE_ORIGIN` to `.env.local.example`, with a fallback to `location.origin` on web. On desktop, `location.origin` is `http://127.0.0.1:47832`, so the env value is required there.

---

## 7. Other backend findings surfaced by this map

1. **`songs.rename` and `backend.renameSong` are dead.** Delete them, along with the fixture handler `tests/fixture/db.js:162` **[no-compat]**.
2. **`metadata.update` vs `settings.save` auth inconsistency.** The first uses `requireUserId` and the second `requireWritableUserId`. Practice and tempo saves are also allowed for export-only accounts (`songs.ts:143`). Decide the export-only rule once, and make Banner copy (spec §6.3) match.
3. **Shared snapshots and v2** (§6.1). Also `shareImports.snapshot` stores the pruned practice, so a saved copy inherits v2 spots once `practiceSettings` is extended.
4. **Practice v1 → v2 upgrade is client-side** (spec §9.3). The server sees v1 (`{loop:{enabled,a,b},rate,grid,tracks}`, `player.js:1015`) until first save. B1's `summarize` must accept both.
5. **`jobs.listActive` projection** (§2.3) needs `createdAt`, `updatedAt`, `deviceId` (+ name), a `settings` summary and `source` for the Jobs popover.
6. **Convex API style:** the guidelines show `ctx.db.patch("table", id, …)` / `ctx.db.replace("table", id, …)` (`guidelines.md`, Mutation guidelines), while the existing code uses the 2-argument form. New modules (setlists, `songPractice`) should follow the guidelines. Read `convex/_generated/ai/guidelines.md` before writing them, as `CLAUDE.md` requires.

---

## 8. CSS inventory

### 8.1 Files, how they load, sizes

| File | Bytes | Loaded by | Built chunk |
|---|---|---|---|
| `src/css/styles.css` | 37,859 | `<link>` in `index.html:13` | `index-*.css` (89.5 KB total) |
| `src/css/record-club.css` | 28,423 | `index.html:14` | same |
| `src/css/motion.css` | 2,845 | `index.html:15` | same |
| `src/css/download.css` | 5,315 | `index.html:16` | same |
| `src/css/theme.css` | 4,838 | `index.html:17` | same |
| `src/css/sharing.css` | 1,561 | `index.html:18` | same |
| `src/css/tempo-map.css` | 11,636 | `index.html:19` | same |
| `src/css/tempo-sources.css` | 4,202 | `import` in `player.js:11` | same (player is in the entry graph) |
| `src/js/song-metadata.css` | 5,720 | `import` in `song-metadata.js:4` | same |
| `src/js/notation/chart.css` | 4,606 | `import` in `notation/chart.js:8` | **lazy** `chart-*.css` (loads with the chart chunk: the "Chart/Tracks nav flip", spec §9.2) |
| `src/js/notation/notation.css` | 14,034 | `import` in `notation/editor.js:15` | **lazy** `editor-*.css` |
| `src/js/notation/score-view.css` | 1,112 | `import` in `notation/score-view.js:10` | **lazy** `html-*.css` |

The total is ≈ 122 KB of source. There are no `@layer`, `@import`, `@supports`, `@container` or `@font-face` rules anywhere today.

**Cascade order today:** styles → record-club (overrides styles, then overrides itself in later blocks, lines 115-254) → motion → download → theme → sharing → tempo-map → JS-imported (tempo-sources, song-metadata) → lazy chunks (chart, editor, score-view) in load order.

### 8.2 Current tokens: effective values and mapping to spec §8.3

Effective light values. Later rules win: `record-club.css:2` overrides `styles.css:1-24` for `--font` and the stems.

| Legacy token | Light | Dark (`theme.css:6-13` unless noted) | Spec token | Collision / note |
|---|---|---|---|---|
| `--bg` | #f8f7f1 (styles:2) | #171c1b | `--bg` (#f6f5f0 / #121615 / stage #08090a) | **Same name, new value** |
| `--bg-2` | #ffffff | #202725 | `--surface` | rename |
| `--bg-3` | #eeeee5 | #2c3532 | `--surface-2` | rename |
| `--panel` | #ffffff | #202725 | `--surface` | merge |
| `--border` | #ced1c7 | #46524c | `--line` | rename |
| `--text` | #18211f | #f0f1e9 | `--ink` | rename |
| `--muted` | #61685f | #acb8ae | `--ink-3` (or `--ink-2` for body copy) | rename; check the contrast test |
| `--accent` | #174bd1 | #8aafff | `--accent` | same name; dark value is kept |
| `--accent-2` | #174bd1 | (none) | (none) | used only by `.tempo-flag` (styles:336); delete |
| `--accent-fill` | #174bd1 (theme:2) | **not redefined** (stays #174bd1) | `--accent-fill` (#174bd1 / #3d63d6) | same name |
| `--good` | #28704b | #80c79b | `--ok` | rename |
| `--warn` | #b25a23 | #f3b77d | `--warn` (#8f5400 / #f3b77d) | same name, new light value |
| `--bad` | #b13a30 | #ff9a8e | `--danger` | rename |
| `--danger-fill` | #b13a30 (theme:2) | not redefined | (none; danger buttons use `--danger`) | delete |
| `--selected` | #e8edfc (theme:2) | #283c58 | `--accent-soft` | rename |
| `--error-surface` | #fff4ee | #3b2824 | (none) | delete (failed cards use text, spec §2.4) |
| `--loop-fill` | #174bd118 | #8aafff20 | `--loop-fill` | same name |
| `--grid-minor/-beat/-bar` | rgba (theme:4) | theme:12 | keep as `--grid-*` (not in spec; add to tokens) | read by JS (§8.3) |
| `--map-fill`, `--map-connector`, `--map-kbd` | `tempo-map.css:4` | `tempo-map.css:5` | `--loop-fill` / `--accent-soft` / `--surface-2` | defined outside the theme file |
| `--drums --bass --vocals --other --guitar --piano` | record-club:2 (#b85029 #347052 #174bd1 #5d6470 #804759 #3b7371); `styles.css:14-19` values are dead | theme:10 (#ed9870 #80c79b #8aafff #b4becd #d79db4 #85c9c3) | `--stem-*` | Spec: "existing light values" = **record-club.css:2**, not styles.css |
| `--radius` | 3px | n/a | `--r-control` / `--r-surface` / `--r-pill` | used 4× (`styles.css:130,209,266,303`) |
| `--font` | `Arial,Helvetica,sans-serif` (record-club:2; overrides the system stack at styles:21) | n/a | `--font-ui` | read by alphaTab (§8.3) |
| `--track-control-w` | 164px (114px ≤ 700px, record-club:126) | n/a | Stems surface layout var | used by notation and map CSS too |
| `--titlebar-h` 38px, `--shell-pad` 12px | styles:22-23 | n/a | (none) | Sidebar/titlebar era: `#content` top padding is `calc(38px+12px)` (styles:81), and the deps banner sits at `top:38px; left:210px` (styles:257). Delete. |
| `--motion-fast 120ms`, `--motion-enter 160ms`, `--motion-nav 220ms`, `--motion-ease` | motion.css:2-7 | n/a | Spec adds `--motion-slow 260ms` and renames `--motion-ease` → `--ease` | small rename |
| `--notation-lines` | **never defined** | n/a | `--ink-3` | read by `score-view.js:18` (falls back to `--muted`) |

**Custom properties obey cascade layers.** A `tokens` layer `:root{--bg:…}` beats a `legacy` layer `:root[data-theme=dark]{--bg:…}` whatever the specificity. So `tokens.css` must define all three sets itself (paper on `:root`, night on `[data-theme=dark]`, stage on the Stage scope). New values then apply to legacy UI immediately. That is intended: legacy screens pick up the new palette on day 1.

### 8.3 JavaScript that reads tokens (renames break these)

| File:line | Reads | From |
|---|---|---|
| `src/js/player.js:30-38` | `--drums --bass --vocals --other --guitar --piano --accent` (stem colours; `#888` fallback) | `document.documentElement` |
| `player.js:455,458,475` | `--loop-fill`, `--accent`, `--grid-minor`, `--grid-bar`, `--grid-beat`, `--muted` (canvas grid, minimap) | root |
| `player.js:1000-1005` | redraws on `woodshed:theme` | none |
| `src/js/map-mode.js:14,618-623` | `--accent --accent-fill --text --muted --border --bg-2 --bg --grid-minor --warn --loop-fill --map-fill --map-connector` (lane canvas; rgba fallbacks) | root |
| `src/js/notation/score-view.js:12-19` | `--text` (fallback #17201f), `--muted` (#68716d), `--notation-lines`; print uses #111111/#555555/#444444 | root |
| `score-view.js:63` | `--font` → alphaTab `elementFonts` (EffectMarker bold 15px, EffectTempo bold 12px, …) | root |
| `score-view.js:197-198`, `chart.js:216-217`, `editor.js:328` | redraw on `woodshed:theme` | none |
| `src/js/notation/lanes.js:20-39` | inline SVG `var(--border) var(--muted) var(--grid-minor) var(--bg-2) var(--accent) var(--drums) var(--bg)` | inherits from DOM |
| `src/js/artwork.js:2` | 6 hard-coded palette pairs (fallback sleeves; this is art data, not UI tokens) | none |

**Two consequences:**
1. **The token rename must cover these readers in the same phase.** Spec §5.2 says "Editor internals unchanged", so `score-view.js`, `lanes.js` and `editor.js` are internals; they need either a mechanical rename or a temporary alias block (`--text: var(--ink)` and so on). The alias block is an internal migration aid, not user compatibility, and is deleted when `legacy` is emptied (Phase 4).
2. **"Stage always dark" vs readers on `documentElement`.** If stage tokens are scoped to a Stage subtree (`.stage{…}`), every canvas, alphaTab and lane reader above still gets the *app* theme from `:root`. So either:
   - **(a)** put the stage token set on the root while on `/s/:id` (for example `html[data-place=stage][data-stage-theme=dark]`, set by the router and pre-painted by theme-init), and dispatch `woodshed:theme` on posture change; or
   - **(b)** change every reader to `getComputedStyle(hostEl)`.

   Recommendation: **(a)**. It is one place, matches "`theme-color` meta updates per theme and posture" (spec §8.3), and Edit postures follow the app theme (§5.0) by flipping the attribute.

### 8.4 Theme handling

**`public/theme-init.js` (36 lines)** is a classic script loaded from `index.html:12` before the CSS. It is served raw from `public/`, not processed by Vite.
- Line 3: `data-startup=download` on `/download`.
- Line 4: `data-library-layout` from `ws.view` (pre-paint list/grid skeleton; `theme.css:55-59`).
- Lines 5-9: `ws.theme` ∈ system|light|dark (invalid → system).
- Lines 10-17: `apply()` sets `html[data-theme]`, inline `color-scheme`, `meta[name=theme-color]` = `#171c1b` / `#f8f7f1` (hex in JS), syncs every `[data-theme-choice]` control, and dispatches `woodshed:theme` `{preference, theme}`.
- Line 18: `syncNative()` → `window.woodshedDesktop.setTheme(preference)`.
- Lines 19-26: `window.woodshedAppearance` exposes `{preference, set()}`.
- Lines 27-33: OS changes, the cross-tab `storage` event and delegated `change` on `[data-theme-choice]`.
- Line 34: re-apply on DOMContentLoaded.
- Tested by `tests/theme.test.js` (4 tests; `vm` + happy-dom).

**Other theme pieces:**
- `index.html:11` sets the initial `theme-color` to `#174bd1` (the old brand band); theme-init overwrites it.
- Theme pickers appear at `index.html:134` (sign-in), `src/js/preferences.js:1-4` (`themeControl()`, used by Settings and the shared header `shared-song.js:14`) and on the download page. Spec §6.6 removes the sign-in picker; Appearance gains "Stage: Match theme · Always dark".

**Electron:**
- `desktop/main.cjs:19` reads `appearance.json` into `nativeTheme.themeSource`.
- `:20` window background `#171c1b` / `#f8f7f1`; `:21` updates it on `nativeTheme` change.
- `:84-90` `desktop:theme` IPC accepts only system|light|dark and persists the choice.
- `:38` the OAuth return page has inline `light-dark(#f8f7f1,#171c1b)` / `light-dark(#18211f,#f0f1e9)`.
- Preload bridge: `desktop/preload.cjs` `setTheme`.

**Changes needed:**
- `theme-init.js` reads `ws.prefs` (JSON) first: `prefs.theme` and `prefs.stage` ('dark' default). It falls back to `ws.theme`/`ws.view` once, then writes `ws.prefs`; this is the one-way upgrade, with no UI.
- The `storage` listener must match `ws.prefs` (line 29 checks only `ws.theme`).
- Pre-paint the Stage scope when `location.pathname` matches `^/s/[^/]+/?$` (not `/edit/`), so a deep link never flashes light.
- Replace the hex `theme-color` values with the new `--bg` per set (paper #f6f5f0, night #121615, stage #08090a).
- Electron window backgrounds (`main.cjs:20`) and the OAuth page (`:38`) move to the same hex values. These are outside the CSS guard (main-process HTML and JS), so keep them in one constant.
- Electron `nativeTheme` keeps following the app preference, not the Stage. macOS window chrome stays light on a dark Stage with a light app theme; accept this, or call `setTheme('dark')` while on the Stage. That is cosmetic, so decide.

### 8.5 z-index: 44 declarations, 22 distinct values

| z | Selector (file:line) | → spec layer (§8.5) |
|---|---|---|
| 0 | `.grid-canvas` (styles:332), `.score-overlay` (score-view:6) | local stacking (component) |
| 1 | `.tempo-markers` (styles:333), `.score-engraving` (score-view:5) | local |
| 2 | `.song-open` (record-club:39), `.playhead` (styles:329), `.loop-handle` (styles:339), `.map-lane-tip` (tempo-map:25), `.notation-playhead` (notation:13) | local / `--z-overlay` for handles |
| 3 | `.card .badges` (rc:47), `#timeline-interact` (styles:328), `.map-cursor` (tm:12), `.edit-cursor,.mini-edit-cursor` (theme:32) | local (the edit cursor is deleted) |
| 4 | `.player-load-progress` (rc:241), `.card-menu` (rc:49), `.proc-inline` (rc:62), `.notation-drag-preview` (notation:48) | local |
| 5 | `.card-proc` (rc:63 and styles:185), `.time-tip` (styles:342), `.chart-hint` (chart:28) | local / `--z-overlay` |
| 6 | `.song-select` (song-metadata:205) | local |
| 8 | `.transport` (rc:130 @≤700px; chart:34; notation:21) | `--z-sticky` |
| 20 | `.notation-menu[open]>div` (notation:37) | `--z-popover` |
| 30 | `.metro-pop` (styles:389) | deleted (metronome popover) |
| 40 | `.deps-banner` (styles:257), `.mi-menu,.mi-keys` (tm:104) | banner → in flow (no z); menus → `--z-popover` |
| 50 | `#titlebar` (styles:40) | dead; delete |
| 80 | `.account-panel` (styles:69) | `--z-popover` |
| 90 | `#app-header` (rc:10, styles:49) | `--z-sticky` |
| 95 | `#startup-status` (theme:45) | `--z-toast` |
| 100 | `.modal` (styles:208) | `<dialog>` top layer |
| 110 | `.metro-pop` @≤700px (rc:126) | deleted |
| 200 | `.drop-overlay` (styles:225) | `--z-drag` (or top layer) |
| 250 | `.ctx-menu` (styles:243) | `--z-popover` / `popover` top layer |
| 300 | `.setup` (styles:432, dead), `.signin` (styles:436), `.metadata-modal` (song-metadata:2) | sign-in → full page (no z); metadata → deleted |
| 301 | `.signin-card .signin-status` (rc:132) | `--z-toast` |
| 400 | `.app-notification` (rc:213) | `--z-toast` |

No z-index is set from JavaScript (`grep zIndex src/js` finds nothing).

**Guard note:** component-internal stacking (canvas, overlay, playhead, handles) needs small values. Either allow `z-index: var(--z-local-1..3)` tokens, or use `isolation:isolate` plus DOM order. Spec §9.2's "no z-index literals" otherwise forces tokens for local stacking. Add `--z-under:-1`, `--z-local:1`, `--z-local-2:2` to tokens.

### 8.6 Radii: 167 declarations, 24 distinct values

| Value | Count | Value | Count |
|---|---|---|---|
| `0` | 27 | `5px` | 6 |
| `2px` | 20 | `10px` | 5 |
| `3px` | 18 | `var(--radius)` (3px) | 4 |
| `9px` | 12 | `16px` | 4 |
| `8px` | 11 | `12px` | 4 |
| `6px` | 11 | `20px` | 3 |
| `7px` | 10 | `999px` / pill halves | 6 |
| `50%` | 10 (avatar, play button, thumbs, spinner, card ⋯, update dot) | `30px` | 1 (`#app-header .add-btn`, rc:14) |
| `4px` | 9 | partial corners (`0 4px 4px 0`, etc.) | 7 |

By file: styles 73, record-club 55, notation 12, chart 9, tempo-map 7, theme 3, song-metadata 3, download 2, tempo-sources 2, sharing 1.

**Mapping:**
- `0`: covers, list thumbs, section covers, tracks.
- 2–4 px: controls → `--r-control 8`.
- 5–16 px: cards, menus, dialogs, popovers → `--r-surface 12`.
- `999px` / `30px`: chips, segmented controls → `--r-pill`.
- `50%`: circular play button and avatar. The spec does not list circles, so allow `--r-pill` (999px gives the same circle on square boxes).

**Contradiction to resolve:** `record-club.css` forces square 0–3 px controls (rc:28-34, 68, 76, 97, 108), while `chart.css` uses pills (chart:8, 14-16, 38-39). Spec §8.2 picks 8/12/999.

### 8.7 `!important`: 13 uses

| File:line | Rule | Fate |
|---|---|---|
| styles:45 | `.hidden{display:none!important}` | Keep the behaviour: JavaScript toggles `.hidden` widely. Move it to `utilities` together with a `[hidden]{display:none!important}` reset rule. Today `[hidden]` is re-asserted per component (chart:3,5,20; notation:79; tempo-map:17,26,30,80,84,105; tempo-sources:3-4). |
| rc:126 | `.metro-pop{inset:auto 12px 12px!important}` @≤700px | deleted with the popover |
| rc:127 (×3) | reduced motion: `*{scroll-behavior:auto!important;animation:none!important;transition:none!important}` | `utilities` (global reduced-motion), or per-component `@media (prefers-reduced-motion)`. Spec §8.4: "Beat lamps still change state per beat, without fades" is compatible. |
| tempo-map:9 | hide `.edit-cursor` while mapping | deleted (edit cursor concept) |
| tempo-sources:7 | hide `.map-cursor` while sourcing | deleted (Find-a-chart panel, no freeze) |
| chart:32 | `.player.chart-active .tracks,… {display:none!important}` | deleted (Stage surfaces) |
| notation:18 | `.notation-dialog-error{color:var(--bad)!important}` | delete with the dialogs |
| notation:20 (×3) | print: `body>*{display:none!important}`, `body>.notation-print{display:block!important}`, `.notation-print svg text{fill:#111!important}` | Keep print (Part ▾ → Print). Move to a `print` block in `utilities`; tokenize `#111` as `--print-ink`. |
| notation:79 | `.notation-workspace [hidden]{display:none!important}` | covered by the global `[hidden]` reset |

**Layer semantics trap:** `!important` declarations in an *earlier* layer beat `!important` in later layers **and** all normal declarations. While legacy CSS lives in `layer(legacy)`, its `display:none!important` rules (chart:32, tempo-map:9, tempo-sources:7) beat any new-layer `display`. New markup must not reuse legacy class names inside `.player.chart-active` / `.player.mapping`. Use `ui-*` and new view classes (spec §8.8).

### 8.8 Literal colours outside token definitions: 125 declarations

By file: record-club 48, styles 49, tempo-map 10, notation 6, sharing 5, theme 5, chart 2. This counts hex, `rgb()`/`rgba()`, `white`/`black`, and `color-mix(…, black)`; the token definitions themselves are excluded.

**Groups:**
- **Brand band on blue** (all deleted with the header band, spec §1.3):
  - `color:white` / `#ffffffNN` on `#app-header`, `.brand-home`, `.account-*`, `.header-back`, `.header-share-song`, `.ptitle`, `.psub #e5ebff`;
  - rc:10,12,15,16,18,20,87,221-224; sharing:1-3,8.
- **Orange "Record Club" accents:**
  - `#ee7a3d` on `.add-btn` (rc:14), `.play-btn` (rc:105) and the live map inspector (tempo-map:73), with text `#17211d`;
  - `#c4561d` (tempo-map:74), `#f3b77d` (tempo-map:75).
  - Spec §8.3 reserves amber `--now` for "where the music is", so the orange **must not** survive on Add or Play.
- **Overlays and shadows:** `#18211f80` modal (rc:73), `rgba(0,0,0,.55)` (styles:208), `#000a` (styles:480); ~15 different `box-shadow` colours (rc:21,74,80,112,124,132,206,213,241; styles:69,245,392,479,537; tm:104; chart:28; notation:37) → the 4 elevation shadows (spec §8.5).
- **Hard-coded light-only colours:**
  - `.badge #f8f7f1` (rc:48); `.card-proc #f8f7f1ed` / error `#fff5efef` (rc:63,65); `.card-proc.error #fff4ee` (rc:128);
  - `.mp-item.active #e9eefb` (rc:113); `.preset-card.selected #e8edfc` (rc:119);
  - `#settings-root` hint `#58625b` (rc:145); `.file-drop.over #e8edfa` (styles:223);
  - `.loop-region,.mini-loop #174bd118` (rc:99); `.mini-view #174bd10a` (rc:101); `.billing-plus border #174bd1` (styles:566).
  - All of these are wrong in dark mode today. The inventory names some of them (`inventory.md:55`).
- **Solo yellow:** `.tbtn.solo.on #f2bb48/#c79427/#17211d` (rc:97). Spec: "Solo has no hue of its own".
- **Dark-only leftovers in `styles.css`** (from the original dark app): `.playhead #fff` + glow (329-330), `.loop-region rgba(91,140,255,.16)` (331), `.mini-* rgba(255,255,255,…)` (350-354), `.card-proc rgba(10,11,14,.74)` (186-200), `.deps-banner #2a1f12/#ffd9a3` (258-261), `.setup-log #0a0b0e/#9fb0c8` (450-451). Most are overridden later by record-club; all are deleted.
- **Codec / deps banner:** `#f6e5c7/#573b17/#c9ac75` (rc:82); dark `#3c301e/#f3ce95/#856a3e` (theme:26) → `Banner` warn tone tokens.
- **Print:** `#111`, `white` (notation:20) → `--print-*`.

**JavaScript-side literals:**
- `artwork.js:2` palettes (keep as art data, exempt from the guard);
- `score-view.js:16-18` fallbacks and print colours;
- `map-mode.js:621-622` rgba fallbacks;
- `player.js:37` `#888`;
- `theme-init.js:14`; `main.cjs:20,38`.

### 8.9 Typography today

- **Family:** effectively `Arial, Helvetica, sans-serif` (`record-club.css:2-3`); `styles.css:21` has a system stack that is overridden.
- **Monospace:** `ui-monospace, monospace` appears in **28** declarations (download 5, record-club 10, tempo-map 5, notation 3, styles/tempo-sources/theme/song-metadata/chart 1 each) for readouts: time, loop values, badges, BPM, ruler, kbd. Spec: Atkinson Hyperlegible Mono with `tabular-nums`.
- **Sizes:** 256 `font-size` declarations plus ~90 `font:` shorthands with px sizes.
  - Distribution of px sizes across both: 9px ×6, 10px ×37, 11px ×38, 12px ×71, 13px ×45, 14px ×25, 15px ×14, 16px ×11, then 17–84px (headings and the brand `clamp(35px,4.7vw,68px)`, rc:11).
  - **81 declarations are below 12 px.** Spec §8.1 sets 12 px as the minimum (14 px in coarse chrome, 15 px in the Stage).
  - The worst offenders: `.notation-hover 9px` (notation:26), `.notation-piece small`/`.notation-pad-family 9px` (notation:64,69), `.download-platform.recommended h3::after 9px` (download:24), `.badge 9px` @≤700 (rc:126), and `.tbtn 10px` (rc:97). The notation ones are Edit · Chart internals; resize them via tokens and leave the logic alone.
- **Weights in use:** 400, 500, 600, 650, 700, 750, 800, 900. The spec weights are 400/600/700/800, so 500/650/750/900 must map.
- **Letter-spacing:** negative tracking (−4px to −0.2px) on headings, brand and cards throughout record-club. The spec gives none for Atkinson, so remove it.

### 8.10 Fonts plan inputs (spec §8.1)

- **Source:** Atkinson Hyperlegible Next (variable) and Atkinson Hyperlegible Mono (variable), both SIL OFL 1.1 (Braille Institute; on Google Fonts).
- **Getting the files:** vendor the `.woff2` files into `src/styles/fonts/`, either downloaded once or taken from the `@fontsource-variable/atkinson-hyperlegible-next` and `-mono` npm packages. Verify both names and versions before adding, and check that the repo's network policy allows the install. No font package is in `node_modules` today.
- **Feature check:** verify that **Next** has a `tnum` (tabular) feature. If it does not, every numeric readout and table column (BPM, length, list Key/BPM/Length columns) must use the Mono face.
- **Declaration:** `@font-face` in `src/styles/tokens.css` or `base.css` with `url('./fonts/…woff2') format('woff2')`. Vite rewrites the URL to `/assets/<name>-<hash>.woff2` (fonts are above the 4 KB `assetsInlineLimit` default; `vite.config.js` sets nothing). There is a precedent: alphaTab's Bravura is imported with `?url` (`score-view.js:6-7`) and emitted as `dist/assets/Bravura-*.woff2`.
  - Use `font-display: swap` with metric-matched fallback faces (`size-adjust`, `ascent-override`) so Stage readouts do not shift on swap.
  - Optionally preload the Next woff2 by importing it with `?url` in `main.js` and injecting `<link rel=preload as=font type=font/woff2 crossorigin>`.
- **Serving:**
  - Electron serves `/assets/*` with `.woff2 → font/woff2` (`main.cjs:41,45`), under CSP `font-src 'self' data:` (`main.cjs:46`).
  - Vercel's CSP has `font-src 'self' data:` (`vercel.json`), and `/assets/*` is cached immutable (`vercel.json`).
  - Nothing else is needed.
- **alphaTab:** `score-view.js:63` passes `--font` to alphaTab text elements. alphaTab measures text when it renders, so await `document.fonts.load('600 15px "Atkinson Hyperlegible Next"')` before the first render. Re-render on `document.fonts` `loadingdone` the first time; otherwise section and tempo labels are laid out with fallback metrics.
- **Licences:**
  - add `public/licenses/atkinson-hyperlegible-next.txt` and `-mono.txt` (OFL text and copyright);
  - add both to the `scripts/prepare-desktop.mjs:18` copy list. That list already omits `academico`, `bravura`, `vexflow` and `harmonix-set`, which exist in `public/licenses/`; add them too;
  - mention them in `build/THIRD-PARTY-NOTICES.txt` (`prepare-desktop.mjs:14`).

### 8.11 Media queries and input modes

- **Breakpoints** (max-width): 380 (rc:233), 500 (styles:544), 600 (download:49, rc:174, styles:573, theme:37, song-metadata:239,297), 700 (rc:126,130,227,248; sharing:18; styles:495,510,516; tempo-map:127), 800 (notation:19, download:42, tempo-sources:49), 1000 (rc:125, chart:42, notation:53), 1100 (tempo-map:126); and min-width 701 (styles:527). That is 8 widths.
  - The spec's targets are layout modes, not widths: laptop rail vs iPad band, portrait vs landscape, `pointer:coarse`.
  - Electron's minimum window is 640×480 (`main.cjs:105`), so band layout must hold at 640.
- **`pointer:coarse`:** only `chart.css:43` and `notation.css:78`. Spec §8.2 gives coarse sizes everywhere through `--h-*` tokens.
- **`(hover:hover) and (pointer:fine)`:** only `motion.css:46`. Spec §5.0 uses it for key-cap hints.
- **Reduced motion:** rc:127 (global kill switch), rc:217, styles:324, styles:557, tempo-map:120, theme:51; `motion.css:9` wraps everything in `no-preference`.
- **Print:** notation:20, 77.
- **`@keyframes`:**
  - `motion-in/out/enter` (motion:61-66); `action-spin` (rc:212); `wave-loading` (styles:323); `spin` (styles:459); `update-pulse` (styles:556; header update icon, deleted); `mi-caret`, `mi-rise` (tempo-map:50,119); `startup-pulse` (theme:50).
  - View Transitions: `view-transition-name` on header parts (motion:10-14). Re-target them to the Library → Stage cover morph (spec §8.6).

### 8.12 Global and element selectors that would bleed into new layers

These sit in `legacy` but still match new DOM. Each must be neutralized in `reset`/`base` (later layers win) or deleted in Phase 0:

| Rule | File:line | Effect on new UI |
|---|---|---|
| `*{box-sizing:border-box;margin:0;padding:0}` | styles:26 | harmless (reset does the same) |
| `html,body{height:100%;overflow:hidden;user-select:none}` | styles:28-35 | **The page never scrolls; `#content` is the scroller (styles:81).** The new router layout must choose: keep a single scroller per place, or allow body scroll on Library and Settings. This also affects `content-visibility`, sticky headers and iOS rubber-banding. |
| `body{display:flex;flex-direction:column}` | styles:43,48 | the new app root must expect this or override it |
| `body{user-select:none}` + opt-in list | rc:4, rc:185-190 | Readable text (notes, song titles) is unselectable unless listed. Decide in `base`. |
| `button,input,…{-webkit-tap-highlight-color:transparent}`, `button{touch-action:manipulation}` | rc:5,7,191 | wanted; move to `base` |
| `input[type=range]{-webkit-appearance:none;height:4px;background;border-radius:3px}` + thumb | styles:282-283 | **Restyles every slider**, including the new Slider and Fader primitives. Override every property or delete it in Phase 0. |
| `input[type=range],input[type=checkbox]{accent-color:var(--accent)}` | rc:9 | fine |
| Focus: `button:focus-visible,a:focus-visible,…{outline…}` | rc:6 | replaced by the single `@layer base` rule (spec §8.4) |
| `:is(button,a,input,select,textarea,summary,[tabindex]):focus-visible{outline:3px solid var(--accent);outline-offset:3px}` | rc:192 | replaced as above |
| `#settings-root :is(…):focus-visible` | rc:163 | replaced as above |
| `.account-trigger:focus-visible{outline:2px …}` | styles:65 | replaced as above |
| `.brand-home:focus-visible{outline-color:white}`, `.header-back:focus-visible{outline-color:white}`, `.header-share-song:focus-visible{outline-color:white}` | rc:12, rc:224, sharing:3 | These are the "invisible header focus" the spec fixes. Delete them with the band. |
| `.hidden` | styles:45 | keep (utilities) |
| `[aria-busy=true]{cursor:progress}`, `button[aria-busy=true]::before` spinner | rc:210-211 | Replaced by Button's loading state. `tests/player-ui.test.js:123-128` asserts this rule exists in `record-club.css`; update the test when it moves. |
| `.view{display:none}.view.active{display:block}` | styles:82-83 | replaced by router mounting |

### 8.13 Dead selectors (no matching markup in `src/js` or `index.html`)

- `#titlebar` (styles:38-41), `.logo` (styles:52), `.setup` (styles:432);
- `.mp-bpm`, `.mp-edit`, `.mp-item`, `.mp-changes`, `.mp-list` (styles:396-425; rc:108,113); `#m-sig` (styles:402; only an aria label map entry remains, `player-layout.js:33`);
- `.preset-grid`, `.preset-card` (styles:269-275, rc:119,147-149); `.saved-flash` (styles:284-285);
- `.connection-status` (rc:164), `.account-name`, `.account-more` (styles:59,67-68, rc:20), `.be-hint` (styles:414);
- `.metadata-eyebrow` (song-metadata:23-30).

The sidebar-era offsets are `--titlebar-h` (styles:22,81,257) and `left:210px` (styles:257). Phase 0 can delete all of these without visual change.

### 8.14 Tests that read or depend on CSS

- `tests/player-ui.test.js:123-128` reads `src/css/record-club.css` for the `button[aria-busy=true]::before` rule.
- `tests/billing-ui.test.js:24` and `tests/settings-ui.test.js:81` write artifact HTML linking `/src/css/styles.css` and others. Update them to the new entry (`src/styles/main.css`).
- `tests/theme.test.js` covers `theme-init.js` (extend for `ws.prefs` and the stage pre-paint).
- `tests/motion.test.mjs` is a node test of `motion.js` behaviour, not CSS.
- Fixture probes (`tests/fixture/probes/probe.cjs`, `probe-targets.cjs`, `probe-touch.cjs`, `navflip.cjs`) are the focus-ring, target-size and nav-flip probes the spec reuses (§9.8).

---

## 9. Static serving: Electron, `public/`, Vite

### 9.1 Electron static server (`desktop/main.cjs:31-50`)

- Host-checked: `Host` must equal `127.0.0.1:47832`, or `:47833` in smoke tests (32, 10).
- `/media/*` → the media proxy (34). `/oauth/callback` → reloads the window with the query and returns the inline "Return to Woodshed" page (35-38).
- **Allow-list** (41): `url.pathname.startsWith('/assets/')`, or exactly one of `/theme-init.js`, `/woodshed-icon.svg`, `/favicon-32.png`, `/apple-touch-icon.png`, `/downloads.json`. **Everything else returns `index.html`.**
- Path traversal guard (43). Read with `readFileSync`, no streaming (44).
- **MIME map** (45): `.html .js .mjs .css .svg .png .json .woff2 .woff`. Anything else is sent as `application/octet-stream`.
- Headers (46): `Cache-Control: no-store` on everything. CSP: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' http://127.0.0.1:* https://*.convex.cloud wss://*.convex.cloud https://*.convex.site https://*.r2.cloudflarestorage.com; img-src 'self' data: blob: https:; media-src 'self' blob: https:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'`.

**Consequences for 2.0:**

| Need | Today | Change |
|---|---|---|
| PWA manifest (spec §9.2) | `/manifest.webmanifest` would return `index.html` | Add it to the allow-list and add `.webmanifest → application/manifest+json`. The manifest's icons also need allow-listing: `public/` has only `apple-touch-icon.png` (180), `favicon-32.png` and `woodshed-icon.svg`, and a PWA needs 192 and 512 (+ maskable). |
| Licenses page (spec §6.2 "This device → Licenses") | `/licenses/*.txt` returns `index.html` in Electron, though Vercel serves `dist/licenses/` | Either allow-list `/licenses/` with `.txt → text/plain; charset=utf-8`, or render licences in-app (import with `?raw`, so they land in the JS bundle). |
| Fonts, icon sprite | via `/assets/` | Works once imported through CSS or JS (§8.10). Prefer inlining the Lucide sprite at boot (`icons.svg?raw`) over external `<use href="/assets/…#id">`. No new allow-list entry is needed either way. |
| WASM | Signalsmith ships as `assets/SignalsmithStretch-*.mjs` (WASM embedded); no `.wasm` file is emitted | If a future dependency emits `.wasm`, add `application/wasm` (needed for `instantiateStreaming`). |
| Simplification **[no-compat]** | allow-list + SPA fallback | Replace with "serve the file if it exists under `webRoot`, else `index.html`" plus an extended MIME map. This keeps the traversal guard (43) and removes the allow-list maintenance trap. |

Other relevant facts in `main.cjs` (platform map items, listed here because they block spec features):
- `setPermissionRequestHandler((…)=>callback(false))` (109) **denies every permission request**. Electron routes `fullscreen` (Focus → full screen), `notifications` (spec §3.5 native notification on completion), `midi`/`midiSysex` (Phase 5 MIDI pedals) and `clipboard-sanitized-write` through this handler; verify each on Electron 44. Today the share dialog already falls back to "Select and copy the link above." when clipboard write fails (`share-dialog.js:18-19`).
- For **wake lock**, Electron's own `powerSaveBlocker.start('prevent-display-sleep')` over IPC is the dependable path. Add it to the preload bridge for spec §4.2.
- The window is 1280×850, minimum 640×480 (105). The app menu (117) is only Woodshed → Check for Updates…, Quit, plus the default Edit and View menus. Spec §6.5 generates it from the command registry.

### 9.2 `public/` contents (copied as-is into `dist/`)

| File | Bytes | Used by | 2.0 |
|---|---|---|---|
| `theme-init.js` | 2,093 | `index.html:12` | Extend (§8.4) |
| `woodshed-icon.svg` | 308 | favicon (`index.html:7`) | Keep; use it as the manifest icon source |
| `favicon-32.png` | 721 | `index.html:8` | keep |
| `apple-touch-icon.png` | 4,130 | `index.html:9` | keep; add 192/512 PNGs for the manifest |
| `downloads.json` | 893 | download page fallback (`desktop.js`) | keep |
| `licenses/academico.txt` | 4,474 | none (Academico, alphaTab's text font licence) | keep; add to the desktop copy list |
| `licenses/alphatab.txt` | 19,132 | copied to desktop (`prepare-desktop.mjs:18`) | keep |
| `licenses/bravura.txt` | 4,470 | none | keep; add to the desktop copy list |
| `licenses/harmonix-set.txt` | 1,068 | none | keep; add to the desktop copy list |
| `licenses/lucide.txt` | 3,208 | copied to desktop | keep. **Lucide is not a dependency** (no `lucide*` in `node_modules`); today's icons are hand-inlined SVG strings. Spec §8.7 needs either a pinned `lucide-static` devDependency plus a small `scripts/build-icons.mjs` that writes `src/styles/icons.svg`, or vendored paths. |
| `licenses/signalsmith-stretch.txt` | 1,094 | copied to desktop | keep |
| `licenses/vexflow.txt` | 1,201 | none | VexFlow is not in `package.json`; it may be stale (verify before deleting) |
| (new) `licenses/atkinson-hyperlegible-next.txt`, `-mono.txt` | n/a | n/a | add (§8.10) |
| (new) `manifest.webmanifest`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | n/a | n/a | add and allow-list |

### 9.3 `vite.config.js` (21 lines)

- One plugin: `download-api` dev middleware that mounts `api/downloads.js` at `/api/downloads` (5-11).
- `server`: port 5173 strict, `allowedHosts:['terminal.local']` (12).
- `build`: `outDir:'dist'`, `sourcemap:true` (13-18). Source maps are emitted into `dist/assets` and therefore shipped in the Electron asar and on Vercel.
- No `css` options, no `define`, no `envPrefix` change, and no `assetsInlineLimit` change.
- Vite is **8.2.0** and builds CSS with Lightning CSS (the minified output reorders declarations, for example `index-*.css`). `lightningcss` and `postcss` are both installed.
- **Verify in the first Phase 0 build** that `@import url('…') layer(legacy)` inside the CSS entry is inlined with the layer kept, and that `@layer` order statements survive minification. Vite's CSS `@import` inlining supports `layer()`, but check the built output (`grep '@layer' dist/assets/index-*.css`) before relying on it.
- The fixture config (`tests/fixture/vite.config.mjs`) uses the same `index.html` and replaces only modules (convex/browser, auth), so it needs no changes for CSS.

---

## 10. CSS migration plan inputs (spec §8, §9.2)

### 10.1 Layer setup

1. Create `src/styles/main.css`, imported once from `src/app/main.js`. Its **first** statement is:
   ```css
   @layer legacy, reset, tokens, base, primitives, layout, views, utilities;
   ```
   Then `@import`s:
   - `./reset.css layer(reset)`, `./tokens.css layer(tokens)`, `./base.css layer(base)`, `./primitives.css layer(primitives)`, `./layout.css layer(layout)`, `./stage.css layer(views)`, `./views/*.css layer(views)`, `./utilities.css layer(utilities)`;
   - the legacy files `../css/styles.css`, `record-club.css`, `motion.css`, `download.css`, `theme.css`, `sharing.css`, `tempo-map.css` with `layer(legacy)`, **in today's order** to keep their internal cascade.
2. Delete the 7 `<link rel=stylesheet>` lines (`index.html:13-19`).
3. **JS-imported and lazy CSS is unlayered, and unlayered CSS beats every layer.** That covers `tempo-sources.css` (`player.js:11`), `song-metadata.css` (`song-metadata.js:4`), `chart.css` (`chart.js:8`), `notation.css` (`editor.js:15`) and `score-view.css` (`score-view.js:10`). Without action, these would override the new primitives and views. Wrap each file's whole content in `@layer legacy { … }`; the layer order is already declared by `main.css`, which loads first. Per spec §9.2, move `chart.css` control styles into `primitives.css` (this fixes the lazy-load "flip"). `score-view.css` and `notation.css` stay as Edit · Chart internals, so wrap them in `@layer views {}` rather than `legacy`, and tokenise them in Phase 4.
4. **`!important` inside `legacy`** wins over everything later (§8.7). Delete chart:32, tempo-map:9 and tempo-sources:7 as soon as their features are replaced. Never reuse `.tracks`, `.time-ruler`, `.overview`, `.timeline-tools`, `.map-lane`, `#map-strip`, `.edit-cursor` or `.map-cursor` class names in new markup.
5. **Phase 0 deletions with no visual change:** the dead selectors (§8.13), `#titlebar`/`--titlebar-h`/`left:210px`, and the duplicate focus rules (§8.12; replaced by the one `base` rule).
6. **Tokens day 1:** `tokens.css` defines paper/night/stage plus spacing, radii, heights, z-layers, motion and font tokens. To keep `legacy` and JS readers working until they are migrated, it also defines the alias block (`--text:var(--ink); --muted:var(--ink-3); --border:var(--line); --bg-2:var(--surface); --bg-3:var(--surface-2); --panel:var(--surface); --good:var(--ok); --bad:var(--danger); --selected:var(--accent-soft); --font:var(--font-ui); --drums:var(--stem-drums) …`). The alias block, `theme.css` and the legacy `:root` token blocks (styles:1-24, rc:2, tempo-map:4-5) are deleted when the last reader is migrated (Phase 4), together with the `legacy` imports. Spec: "The legacy CSS layer is empty after this phase".
7. **Stage scope:** `html[data-place=stage]` and `[data-stage-theme=dark|match]` (§8.3) hold the stage token set. Edit postures set `data-place=edit` and follow the app theme.

### 10.2 Per-phase deletions (from spec §9.4 / §9.6, mapped to files)

| Phase | Delete from legacy |
|---|---|
| 0 | Dead selectors §8.13; focus duplicates; `input[type=range]` global (styles:282-283) once Slider ships; `.hidden` → utilities; reduced-motion global → utilities; deps banner (styles:256-262, rc:82, theme:26) → Banner |
| 1a | Header band and in-player header (rc:10-23, 84-88, 125-126 header parts, 136-137, 219-236; styles:47-72; sharing:1-3,7-8; motion:10-14 header names); `.header-edit-song` (song-metadata:222-238); `.metro-pop` / `.mp-*` (styles:387-429; rc:108-113,126 parts); workspace nav (rc:249-252; notation:1-3; chart:35-41); chart toolbar styles (chart:4-18) |
| 1b | Practice strip and loop readout (styles:377-385; rc:106-110,129); transport (styles:356-376; rc:102-105,130); `.edit-cursor`, `.pause-btn` (theme:32-36); player-load (rc:238-248) |
| 2 | Tracks/timeline/overview (styles:298-354; rc:89-101,114,125-126 parts; theme:23-25); `.chart-active` hides (chart:32-34) |
| 3 | Library (styles:92-205; rc:24-67,128; theme:16-21 parts, 38-59 startup skeleton → new skeleton); add modal, file drop, drop overlay (styles:207-239; rc:73-81); ctx menu (styles:241-253); settings and billing (styles:264-285; rc:115-183,193-209; theme:22); sign-in/setup (styles:431-447, 529-545; rc:120-121,131-133); account (styles:56-72; rc:15-23); `.library-selection` etc. (song-metadata:190-221); download (download.css → `views/download.css`); `record-club.css` is empty by now |
| 4 | Metadata modal (song-metadata.css whole); `tempo-map.css`, `tempo-sources.css` (inert freeze, sourcing) → `views/edit-map.css`; `notation.css` heading/toolbar markup; admin (styles:461-475); `styles.css`, `theme.css`, `motion.css` (tokens moved), `sharing.css`; alias block; `legacy` declaration |

### 10.3 Guards (`scripts/check-css.mjs`, spec §9.2)

- **Placement:** `npm test` is `vitest run` (`package.json` scripts), and vitest includes only `convex/**/*.test.ts` and `tests/**/*.test.js` (`vitest.config.ts`). A standalone `scripts/check-css.mjs` therefore does **not** run under `npm test`. Write it as `tests/css-guards.test.js`, which imports a scanner from `scripts/check-css.mjs` so it can also run from the CLI.
- **Scope:** `src/styles/**/*.css`. Skip files imported with `layer(legacy)` and any file whose whole content is `@layer legacy {}`, so the guard does not fail before legacy is gone. Fail if a non-legacy file is newly imported into `legacy`.
- **Rules:**
  - no `#hex`, `rgb(`, `rgba(`, `hsl(` or named colours (`white`, `black`) outside `tokens.css`. `transparent`, `currentColor` and `inherit` are allowed;
  - `z-index` only `var(--z-*)` (plus `auto`, and the local tokens of §8.5);
  - `border-radius` only `var(--r-*)` or `0`;
  - `!important` only in `utilities.css` and `reset.css`. The reset needs `[hidden]{display:none!important}`, so the spec's "only utilities" has to be widened to reset as well;
  - `font-size` / `font:` only through `var(--fs-*)` or relative units in `tokens.css`; no px font sizes elsewhere.
- **Also worth guarding:** no `font-family` literal outside tokens, and no `ui-monospace` (use `--font-mono`).
- **Out of scope (document as exemptions):** JS literals (`artwork.js:2`, `theme-init.js`, `main.cjs`), alphaTab print colours (`score-view.js:16-18`), and canvas colour fallbacks (`player.js:37`, `map-mode.js:620-622`). Tokenise the canvas fallbacks or delete them when those modules move.

### 10.4 Risks

1. **Unlayered JS-imported or lazy CSS** silently overrides the new system (§10.1 item 3). This is the most likely cause of "my primitive looks wrong only after opening a chart".
2. **Token readers on `documentElement`** vs a Stage-scoped dark theme (§8.3). The chart, waveforms and map lane render in the app theme on a dark Stage unless the scope is on the root.
3. **`html,body{overflow:hidden}` plus the `#content` scroller** (styles:28-35,81) conflicts with sticky group headers, `content-visibility`, scroll restoration on Back (spec §1.2 "restoring scroll") and iOS behaviour. Decide the scroller model in Phase 0.
4. **Legacy `!important`** beats new layers (§8.7).
5. **The font swap** shifts Stage readouts, and alphaTab measures text before the font loads (§8.10).
6. **Contrast:** spec `--ink-3` on `--bg` must be ≥ 4.5:1 (test-enforced). The legacy `--muted` (#61685f on #f8f7f1 ≈ 5.6:1) maps safely; dark `--ink-3` #8b9692 on #121615 should be checked by the token-contrast unit test (spec §9.8).
7. **Electron allow-list** silently serves `index.html` for any new root-level public file, so a manifest or licence returns HTML with a 200 (§9.1). Generalize the server early.

---

## 11. Decisions for the orchestrator (from this map)

1. Move `practice` into a `songPractice` table with B1. Optionally move `tempo` into a `songTempo` table, or at least stop writing the legacy `detected`/`map` copies (§3). Recommended: yes to `songPractice` and to dropping the duplicates; `songTempo` is optional.
2. `practiceSummary` includes the top 3 spots and `mapSummary` includes section names (§3). Recommended: yes; the spec's field list cannot render the Continue hero or section search otherwise.
3. Metadata backend additions G1–G5, G9, G10 and G17: no-op-key skip, `unlock`, `confirm`, `match`, `metadataSuggestion`, `getMany`, `updateEach`, `retry`. Recommended: all of them; they are small and §5.3 cannot be built honestly without them.
4. Demo token: server-side env plus query vs `VITE_DEMO_SHARE_TOKEN` (§6.3). Recommended: server-side. B8 needs server code anyway, for v2 practice in shared snapshots (§6.1).
5. Pins alongside setlists (§5). Recommended: keep both.
6. Stage dark scope on the root element (§8.3). Recommended: yes.
7. Replace the Electron allow-list with exists-or-index (§9.1). Recommended: yes **[no-compat]**.
8. Export-only accounts: whether metadata, practice and tempo edits stay allowed (§7.2). Today they are allowed while settings saves are refused.
