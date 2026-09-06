import { v, ConvexError } from "convex/values";
import { mutation, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUserId } from "./lib/auth";
import {
  cleanMetadata,
  metadataPatch,
  unprotected,
  candidateValidator,
} from "./lib/songMetadata";
import { adjust, limits, used, retireKey } from "./storage";

export const context = internalQuery({
  args: { id: v.id("songs") },
  returns: v.any(),
  handler: async (ctx, { id }) => {
    const userId = await requireUserId(ctx);
    const song = await ctx.db.get(id);
    if (!song || song.userId !== userId)
      throw new ConvexError("Song unavailable.");
    return song;
  },
});
export const update = mutation({
  args: { ids: v.array(v.id("songs")), changes: metadataPatch },
  returns: v.null(),
  handler: async (ctx, { ids, changes }) => {
    const userId = await requireUserId(ctx);
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length || uniqueIds.length > 100)
      throw new ConvexError("Select between 1 and 100 songs.");
    const patch = cleanMetadata(changes);
    if (!Object.keys(patch).length) return null;
    if (patch.artwork?.kind === "upload" && uniqueIds.length !== 1)
      throw new ConvexError("Upload artwork for one song at a time.");
    for (const id of uniqueIds) {
      const song = await ctx.db.get(id);
      if (!song || song.userId !== userId)
        throw new ConvexError("Song unavailable.");
      if (patch.artwork?.kind === "upload") {
        const art = patch.artwork;
        const object = await ctx.db
          .query("audioObjects")
          .withIndex("by_key", (q) => q.eq("key", art.key))
          .unique();
        if (
          !object ||
          object.userId !== userId ||
          object.songId !== id ||
          !object.verified ||
          object.status === "deleting" ||
          (object.status === "reserved" && object.expiresAt <= Date.now())
        )
          throw new ConvexError(
            "Artwork upload expired. Choose the image again.",
          );
        await ctx.db.patch(object._id, { status: "ready" });
      }
      if (
        patch.artwork &&
        song.artwork?.kind === "upload" &&
        (patch.artwork.kind !== "upload" ||
          patch.artwork.key !== song.artwork.key)
      )
        await retireKey(ctx, song.artwork.key);
      await ctx.db.patch(id, {
        ...patch,
        ...("title" in patch || "artist" in patch
          ? { metadataRecordingId: undefined, metadataReleaseId: undefined }
          : "album" in patch || "albumArtist" in patch
            ? { metadataReleaseId: undefined }
            : {}),
        metadataLocks: [
          ...new Set([...(song.metadataLocks ?? []), ...Object.keys(patch)]),
        ],
      });
    }
    return null;
  },
});
export const applyAutomatic = internalMutation({
  args: {
    id: v.id("songs"),
    before: metadataPatch,
    changes: metadataPatch,
    candidate: v.optional(candidateValidator),
    status: v.union(
      v.literal("matched"),
      v.literal("uncertain"),
      v.literal("unavailable"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const song = await ctx.db.get(args.id);
    if (!song) return null;
    const patch = unprotected(cleanMetadata(args.changes), song.metadataLocks);
    // An import, another lookup or an edit may have finished during the network request.
    for (const key of Object.keys(patch)) {
      if (
        JSON.stringify(song[key as keyof typeof song] ?? "") !==
        JSON.stringify(args.before[key as keyof typeof args.before] ?? "")
      )
        delete (patch as Record<string, unknown>)[key];
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
    await ctx.db.patch(song._id, {
      ...patch,
      metadataStatus: args.status,
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
export const requestSlot = internalMutation({
  args: { key: v.string() },
  returns: v.number(),
  handler: async (ctx, { key }) => {
    const row = await ctx.db
      .query("metadataRequests")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    const now = Date.now(),
      at = Math.max(now, row?.nextAt ?? now);
    if (at - now > 25000)
      throw new ConvexError("Metadata lookup is busy. Try again shortly.");
    const nextAt = at + (key === "musicbrainz" ? 1200 : 400);
    if (row) await ctx.db.patch(row._id, { nextAt });
    else await ctx.db.insert("metadataRequests", { key, nextAt });
    return at - now;
  },
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
    if (row) await ctx.db.patch(row._id, { nextAt });
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
    if (row) await ctx.db.patch(row._id, { payload, expiresAt });
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
    const row = await ctx.db.get(id);
    if (row && row.expiresAt <= Date.now()) await ctx.db.delete(id);
    else if (row)
      await ctx.scheduler.runAt(row.expiresAt, internal.metadata.expireCache, {
        id,
      });
    return null;
  },
});
export const reserveArtwork = internalMutation({
  args: {
    id: v.id("songs"),
    bytes: v.number(),
    mime: v.string(),
    checksum: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, a) => {
    const userId = await requireUserId(ctx),
      song = await ctx.db.get(a.id);
    if (!song || song.userId !== userId)
      throw new ConvexError("Song unavailable.");
    if (
      !Number.isSafeInteger(a.bytes) ||
      a.bytes < 1 ||
      a.bytes > 2000000 ||
      !["image/jpeg", "image/png", "image/webp"].includes(a.mime) ||
      !/^[A-Za-z0-9+/]{43}=$/.test(a.checksum)
    )
      throw new ConvexError("Choose a JPEG, PNG or WebP image under 2 MB.");
    const quota = await limits(ctx, userId);
    if (
      (await used(ctx, `user:${userId}`)) + a.bytes > quota.userBytes ||
      (await used(ctx, "app")) + a.bytes > quota.appBytes
    )
      throw new ConvexError(
        "There is not enough cloud storage for this image.",
      );
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
export const artworkContext = internalQuery({
  args: { objectId: v.id("audioObjects") },
  returns: v.any(),
  handler: async (ctx, { objectId }) => {
    const userId = await requireUserId(ctx),
      row = await ctx.db.get(objectId);
    if (
      !row ||
      row.userId !== userId ||
      !row.songId ||
      row.status !== "reserved" ||
      row.expiresAt <= Date.now()
    )
      throw new ConvexError("Artwork upload expired.");
    return row;
  },
});
export const verifiedArtwork = internalMutation({
  args: { objectId: v.id("audioObjects") },
  returns: v.string(),
  handler: async (ctx, { objectId }) => {
    const userId = await requireUserId(ctx),
      row = await ctx.db.get(objectId);
    if (
      !row ||
      row.userId !== userId ||
      !row.songId ||
      row.status !== "reserved" ||
      row.expiresAt <= Date.now()
    )
      throw new ConvexError("Artwork upload expired.");
    await ctx.db.patch(objectId, { verified: true });
    return row.key;
  },
});
