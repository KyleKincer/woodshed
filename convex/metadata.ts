import { v } from "convex/values";
import { mutation, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUserId, requireWritableUserId } from "./lib/auth";
import { fail } from "./lib/errors";
import { metadataCandidateValidator } from "./lib/validators";
import {
  cleanMetadata,
  metadataPatch,
  unprotected,
  mbid,
  type MetadataPatch,
} from "./lib/songMetadata";
import {
  IDENTITY_KEYS,
  LIMITS,
  RECORDING_KEYS,
  RELEASE_KEYS,
  ARTWORK_TYPES,
  changedKeys,
  hasValue,
  isFieldKey,
} from "../shared/metadata";
import { normalize } from "./lib/musicBrainz";
import { adjust, limits, used, retireKey } from "./storage";

/**
 * Song metadata (architecture §6.9, D6). User edits go through `update`
 * (one patch for 1–100 songs) and `updateEach` (a different patch per song,
 * for bulk Revert); `confirm` accepts the current details. Automatic
 * enrichment (`metadataLookup.enrich`) writes through `applyAutomatic`.
 *
 * Edit rules (G1–G5):
 * - a key whose cleaned value equals the stored value is skipped: no patch,
 *   no lock, no id clearing (G1);
 * - every changed key is added to `metadataLocks`, then the `unlock` keys are
 *   removed (G2, Revert);
 * - a title or artist change clears the MusicBrainz ids and the suggestion
 *   (a title change also clears `needsReview`: the upload is untitled no
 *   more); an album or album artist change clears the release id;
 * - `match` (single song) then sets `metadataStatus: 'matched'` and the ids
 *   (G4), and clears the suggestion and `needsReview`.
 */

/** A replaced upload stays restorable (Revert, G11) for this long before its key is retired. */
const ARTWORK_RETIRE_DELAY = 3_600_000;
const UNAVAILABLE = "Song unavailable.";

async function ownedSong(ctx: MutationCtx, userId: string, id: Id<"songs">) {
  const song = await ctx.db.get("songs", id);
  if (!song || song.userId !== userId) fail("not_found", UNAVAILABLE);
  return song;
}

/** Validates `unlock` keys against the editable fields; returns them deduplicated. */
function cleanUnlock(unlock: string[] | undefined): string[] {
  const keys = [...new Set(unlock ?? [])];
  for (const key of keys)
    if (!isFieldKey(key)) fail("invalid", "Unknown field.", { field: key });
  return keys;
}

type Match = { recordingId: string; releaseId?: string };

function cleanMatch(match: Match | undefined, count: number): Match | undefined {
  if (!match) return undefined;
  if (count !== 1) fail("invalid", "Apply a match to one song at a time.");
  if (!mbid.test(match.recordingId) || (match.releaseId !== undefined && !mbid.test(match.releaseId)))
    fail("invalid", "Invalid match.");
  return match;
}

/** The upload a song is about to show must be the caller's, for this song, verified and live. */
async function claimUpload(ctx: MutationCtx, userId: string, id: Id<"songs">, key: string) {
  const object = await ctx.db
    .query("audioObjects")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  if (
    !object ||
    object.userId !== userId ||
    object.songId !== id ||
    !object.verified ||
    object.status === "deleting" ||
    (object.status === "reserved" && object.expiresAt <= Date.now())
  )
    fail("artwork_expired", "Artwork upload expired. Choose the image again.");
  if (object.status !== "ready") await ctx.db.patch("audioObjects", object._id, { status: "ready" });
}

/**
 * Applies one cleaned patch to one owned song with the edit rules above.
 * Returns whether anything was written.
 */
async function applyEdit(
  ctx: MutationCtx,
  userId: string,
  song: Doc<"songs">,
  patch: MetadataPatch,
  unlock: string[],
  match: Match | undefined,
): Promise<boolean> {
  const keys = changedKeys(patch as Record<string, unknown>, song as unknown as Record<string, unknown>);
  const changes: Record<string, unknown> = Object.fromEntries(keys.map((k) => [k, patch[k]]));
  const art = patch.artwork;
  if (keys.includes("artwork") && art?.kind === "upload") await claimUpload(ctx, userId, song._id, art.key);
  // The replaced upload is retired later, so Revert can still restore it (G11).
  if (keys.includes("artwork") && song.artwork?.kind === "upload")
    await ctx.scheduler.runAfter(ARTWORK_RETIRE_DELAY, internal.metadata.retireArtwork, {
      id: song._id,
      key: song.artwork.key,
    });
  const touches = (list: readonly string[]) => list.some((k) => keys.includes(k as (typeof keys)[number]));
  if (touches(RECORDING_KEYS)) {
    changes.metadataRecordingId = undefined;
    changes.metadataReleaseId = undefined;
    changes.metadataSuggestion = undefined;
  } else if (touches(RELEASE_KEYS)) changes.metadataReleaseId = undefined;
  if (keys.includes("title") && song.needsReview) changes.needsReview = undefined;
  const before = song.metadataLocks ?? [];
  const locks = [...new Set([...before, ...keys])].filter((k) => !unlock.includes(k));
  if (locks.length !== before.length || locks.some((k, i) => k !== before[i])) changes.metadataLocks = locks;
  if (match) {
    // After the clearing rule, so the ids the user just chose survive it (G4).
    changes.metadataStatus = "matched";
    changes.metadataRecordingId = match.recordingId;
    changes.metadataReleaseId = match.releaseId;
    if (song.metadataSuggestion) changes.metadataSuggestion = undefined;
    if (song.needsReview) changes.needsReview = undefined;
  }
  if (!Object.keys(changes).length) return false;
  await ctx.db.patch("songs", song._id, changes as Partial<Doc<"songs">>);
  return true;
}

export const context = internalQuery({
  args: { id: v.id("songs") },
  returns: v.any(),
  handler: async (ctx, { id }) => {
    const userId = await requireUserId(ctx);
    const song = await ctx.db.get("songs", id);
    if (!song || song.userId !== userId) fail("not_found", UNAVAILABLE);
    return song;
  },
});

/**
 * One patch for 1–100 of the caller's songs, atomically (one foreign or
 * missing id fails the whole call). `unlock` lists fields to unlock after
 * patching (Revert, G2). `match` records a chosen MusicBrainz match for a
 * single song (G4).
 */
export const update = mutation({
  args: {
    ids: v.array(v.id("songs")),
    changes: metadataPatch,
    unlock: v.optional(v.array(v.string())),
    match: v.optional(v.object({ recordingId: v.string(), releaseId: v.optional(v.string()) })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const ids = [...new Set(args.ids)];
    if (!ids.length || ids.length > LIMITS.bulk)
      fail("invalid", `Select between 1 and ${LIMITS.bulk} songs.`);
    const patch = cleanMetadata(args.changes);
    const unlock = cleanUnlock(args.unlock);
    const match = cleanMatch(args.match, ids.length);
    if (!Object.keys(patch).length && !unlock.length && !match) return null;
    if (patch.artwork?.kind === "upload" && ids.length !== 1)
      fail("invalid", "Upload artwork for one song at a time.", { field: "artwork" });
    const songs = [];
    for (const id of ids) songs.push(await ownedSong(ctx, userId, id));
    for (const song of songs) await applyEdit(ctx, userId, song, patch, unlock, match);
    return null;
  },
});

/**
 * A different patch per song (≤ 100 items, one per song), atomically: bulk
 * Revert restores each song's own original values and locks (G10). Every
 * item is validated before anything is written.
 */
export const updateEach = mutation({
  args: {
    items: v.array(
      v.object({
        id: v.id("songs"),
        changes: metadataPatch,
        unlock: v.optional(v.array(v.string())),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { items }) => {
    const userId = await requireUserId(ctx);
    if (!items.length || items.length > LIMITS.bulk)
      fail("invalid", `Select between 1 and ${LIMITS.bulk} songs.`);
    if (new Set(items.map((item) => item.id)).size !== items.length)
      fail("invalid", "Each song can appear only once.");
    const prepared = [];
    for (const item of items)
      prepared.push({
        song: await ownedSong(ctx, userId, item.id),
        patch: cleanMetadata(item.changes),
        unlock: cleanUnlock(item.unlock),
      });
    for (const { song, patch, unlock } of prepared) await applyEdit(ctx, userId, song, patch, unlock, undefined);
    return null;
  },
});

/**
 * "Yes, this is right" (G3; the Library's "Yes, that's it" too): the song's
 * current details are its match. Sets `metadataStatus: 'matched'`, locks the
 * identity fields that have a value (plus artwork when chosen), and clears
 * the suggestion and `needsReview`. `recordingUnconfirmed` is the Stage's
 * separate question and stays (D43). When the stored suggestion names the
 * same recording as the song's current title and artist, its ids are kept.
 */
export const confirm = mutation({
  args: { id: v.id("songs") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const userId = await requireUserId(ctx);
    const song = await ownedSong(ctx, userId, id);
    const fields = song as unknown as Record<string, unknown>;
    const identity = [
      ...IDENTITY_KEYS.filter((k) => hasValue(fields, k)),
      ...(hasValue(fields, "artwork") ? (["artwork"] as const) : []),
    ];
    const changes: Partial<Doc<"songs">> = {
      metadataStatus: "matched",
      metadataLocks: [...new Set([...(song.metadataLocks ?? []), ...identity])],
      metadataSuggestion: undefined,
      needsReview: undefined,
    };
    const s = song.metadataSuggestion;
    if (
      s &&
      !song.metadataRecordingId &&
      mbid.test(s.recordingId) &&
      normalize(s.title) === normalize(song.title) &&
      normalize(s.artist ?? "") === normalize(song.artist ?? "")
    ) {
      changes.metadataRecordingId = s.recordingId;
      if (s.releaseId && mbid.test(s.releaseId) && s.album && normalize(s.album) === normalize(song.album ?? ""))
        changes.metadataReleaseId = s.releaseId;
    }
    await ctx.db.patch("songs", id, changes);
    return null;
  },
});

/** Retires a replaced artwork upload unless the song shows it again (Revert) by now. */
export const retireArtwork = internalMutation({
  args: { id: v.id("songs"), key: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, key }) => {
    const song = await ctx.db.get("songs", id);
    if (song?.artwork?.kind === "upload" && song.artwork.key === key) return null;
    await retireKey(ctx, key);
    return null;
  },
});

/**
 * `metadataLookup.retry` (G17): marks the caller's song `pending` and
 * schedules `enrich` after a MusicBrainz slot from the shared limiter
 * (`lookup_busy` when the queue is too long). A lookup already pending is
 * left alone; a matched song keeps its match (Find another match changes it).
 */
export const queueLookup = internalMutation({
  args: { id: v.id("songs") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const userId = await requireUserId(ctx);
    const song = await ownedSong(ctx, userId, id);
    if (song.metadataStatus === "pending") return null;
    if (song.metadataStatus === "matched") fail("invalid", "This song is already matched.");
    const delay = await reserveSlot(ctx, "musicbrainz");
    await ctx.db.patch("songs", id, { metadataStatus: "pending" });
    await ctx.scheduler.runAfter(delay, internal.metadataLookup.enrich, { id });
    return null;
  },
});

export const applyAutomatic = internalMutation({
  args: {
    id: v.id("songs"),
    before: metadataPatch,
    changes: metadataPatch,
    candidate: v.optional(metadataCandidateValidator),
    /** G5: the best guess when nothing was strong enough to apply (`uncertain` only). */
    suggestion: v.optional(metadataCandidateValidator),
    status: v.union(
      v.literal("matched"),
      v.literal("uncertain"),
      v.literal("unavailable"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const song = await ctx.db.get("songs", args.id);
    if (!song) return null;
    const patch = unprotected(cleanMetadata(args.changes), song.metadataLocks);
    const stale = (key: string) =>
      JSON.stringify(song[key as keyof typeof song] ?? "") !==
      JSON.stringify(args.before[key as keyof typeof args.before] ?? "");
    // An import, another lookup or an edit may have finished during the network request.
    for (const key of Object.keys(patch)) {
      if (stale(key)) delete (patch as Record<string, unknown>)[key];
    }
    // Album identity, its year, numbering and artwork must stay coherent.
    if (
      ["album", "albumArtist", "year", "trackNumber", "discNumber"].some((k) =>
        song.metadataLocks?.includes(k),
      )
    ) {
      for (const key of [
        "album",
        "albumArtist",
        "year",
        "trackNumber",
        "discNumber",
        "artwork",
      ] as const)
        delete patch[key];
    }
    // A suggestion describes the title and artist it was searched with; an edit since makes it stale.
    const suggestion =
      args.status === "uncertain" && args.suggestion && !RECORDING_KEYS.some(stale)
        ? args.suggestion
        : undefined;
    await ctx.db.patch("songs", song._id, {
      ...patch,
      metadataStatus: args.status,
      ...(args.status !== "unavailable" ? { metadataSuggestion: suggestion } : {}),
      ...(args.candidate
        ? {
            metadataRecordingId: args.candidate.recordingId,
            ...(patch.album && args.candidate.releaseId
              ? { metadataReleaseId: args.candidate.releaseId }
              : {}),
          }
        : {}),
    });
    return null;
  },
});

/**
 * Reserves the next request slot for a provider (MusicBrainz 1.2 s apart,
 * others 0.4 s) and returns how long to wait; `lookup_busy` past 25 s.
 */
async function reserveSlot(ctx: MutationCtx, key: string): Promise<number> {
  const row = await ctx.db
    .query("metadataRequests")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  const now = Date.now(),
    at = Math.max(now, row?.nextAt ?? now);
  if (at - now > 25000)
    fail("lookup_busy", "Metadata lookup is busy. Try again shortly.");
  const nextAt = at + (key === "musicbrainz" ? 1200 : 400);
  if (row) await ctx.db.patch("metadataRequests", row._id, { nextAt });
  else await ctx.db.insert("metadataRequests", { key, nextAt });
  return at - now;
}

export const requestSlot = internalMutation({
  args: { key: v.string() },
  returns: v.number(),
  handler: (ctx, { key }) => reserveSlot(ctx, key),
});
export const deferRequests = internalMutation({
  args: { key: v.string(), delay: v.number() },
  returns: v.null(),
  handler: async (ctx, { key, delay }) => {
    const row = await ctx.db
      .query("metadataRequests")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    const nextAt = Math.max(row?.nextAt ?? 0, Date.now() + Math.max(0, delay));
    if (row) await ctx.db.patch("metadataRequests", row._id, { nextAt });
    else await ctx.db.insert("metadataRequests", { key, nextAt });
    return null;
  },
});
export const cached = internalQuery({
  args: { key: v.string() },
  returns: v.any(),
  handler: async (ctx, { key }) => {
    const row = await ctx.db
      .query("metadataCache")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    return row && row.expiresAt > Date.now() ? row.payload : null;
  },
});
export const cache = internalMutation({
  args: { key: v.string(), payload: v.any() },
  returns: v.null(),
  handler: async (ctx, { key, payload }) => {
    const row = await ctx.db
      .query("metadataCache")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    const expiresAt = Date.now() + 86400000;
    if (row) await ctx.db.patch("metadataCache", row._id, { payload, expiresAt });
    else {
      const id = await ctx.db.insert("metadataCache", {
        key,
        payload,
        expiresAt,
      });
      await ctx.scheduler.runAt(expiresAt, internal.metadata.expireCache, {
        id,
      });
    }
    return null;
  },
});
export const expireCache = internalMutation({
  args: { id: v.id("metadataCache") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get("metadataCache", id);
    if (row && row.expiresAt <= Date.now()) await ctx.db.delete("metadataCache", id);
    else if (row)
      await ctx.scheduler.runAt(row.expiresAt, internal.metadata.expireCache, {
        id,
      });
    return null;
  },
});
/**
 * Reserves an artwork upload (`artworkUpload.prepare`). Export-only accounts
 * cannot add stored media (D10). The image must be a JPEG, PNG or WebP under
 * 2 MB and fit both quotas.
 */
export const reserveArtwork = internalMutation({
  args: {
    id: v.id("songs"),
    bytes: v.number(),
    mime: v.string(),
    checksum: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, a) => {
    const userId = await requireWritableUserId(ctx);
    await ownedSong(ctx, userId, a.id);
    if (
      !Number.isSafeInteger(a.bytes) ||
      a.bytes < 1 ||
      a.bytes > LIMITS.artworkBytes ||
      !(ARTWORK_TYPES as readonly string[]).includes(a.mime) ||
      !/^[A-Za-z0-9+/]{43}=$/.test(a.checksum)
    )
      fail("invalid", "Choose a JPEG, PNG or WebP image under 2 MB.", { field: "artwork" });
    const quota = await limits(ctx, userId);
    const full = "There is not enough cloud storage for this image.";
    if ((await used(ctx, `user:${userId}`)) + a.bytes > quota.userBytes) fail("storage_full_user", full);
    if ((await used(ctx, "app")) + a.bytes > quota.appBytes) fail("storage_full_app", full);
    const name = `cover.${a.mime === "image/jpeg" ? "jpg" : a.mime.split("/")[1]}`;
    const row = {
      userId,
      songId: a.id,
      key: `users/${encodeURIComponent(userId)}/artwork/${crypto.randomUUID()}/${name}`,
      name,
      bytes: a.bytes,
      mime: a.mime,
      checksum: a.checksum,
      expiresAt: Date.now() + 3600000,
      status: "reserved" as const,
    };
    await adjust(ctx, userId, a.bytes);
    const objectId = await ctx.db.insert("audioObjects", row);
    await ctx.scheduler.runAt(row.expiresAt, internal.storage.expire, {
      id: objectId,
    });
    return { ...row, objectId };
  },
});

/** A live reservation of the caller's, for a song; else `artwork_expired`. */
async function liveReservation(ctx: MutationCtx | QueryCtx, objectId: Id<"audioObjects">) {
  const userId = await requireUserId(ctx),
    row = await ctx.db.get("audioObjects", objectId);
  if (
    !row ||
    row.userId !== userId ||
    !row.songId ||
    row.status !== "reserved" ||
    row.expiresAt <= Date.now()
  )
    fail("artwork_expired", "Artwork upload expired.");
  return row;
}

export const artworkContext = internalQuery({
  args: { objectId: v.id("audioObjects") },
  returns: v.any(),
  handler: (ctx, { objectId }) => liveReservation(ctx, objectId),
});
export const verifiedArtwork = internalMutation({
  args: { objectId: v.id("audioObjects") },
  returns: v.string(),
  handler: async (ctx, { objectId }) => {
    const row = await liveReservation(ctx, objectId);
    await ctx.db.patch("audioObjects", objectId, { verified: true });
    return row.key;
  },
});
