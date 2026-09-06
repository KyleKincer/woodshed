"use node";
import { v, ConvexError } from "convex/values";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  metadataFields,
  candidateValidator,
  mbid,
  type Candidate,
  type MetadataPatch,
} from "./lib/songMetadata";
import {
  candidate,
  candidatePatch,
  validRecordings,
  strongRecording,
  selectRelease,
  searchText,
  type Recording,
  type Release,
} from "./lib/musicBrainz";

import { catalogRequest } from "./lib/catalogRequest";
async function request(ctx: ActionCtx, path: string): Promise<any> {
  if (process.env.MUSICBRAINZ_ENABLED !== "true")
    throw new ConvexError(
      "Online metadata lookup is currently unavailable. You can still edit every field.",
    );
  const key = `mb:${path}`;
  const hit = await ctx.runQuery(internal.metadata.cached, { key });
  if (hit) return hit;
  const payload = await catalogRequest(`https://musicbrainz.org/ws/2/${path}`, {
    reserve: () =>
      ctx.runMutation(internal.metadata.requestSlot, { key: "musicbrainz" }),
    defer: async (ms) => {
      await ctx.runMutation(internal.metadata.deferRequests, {
        key: "musicbrainz",
        delay: ms,
      });
    },
  });
  await ctx.runMutation(internal.metadata.cache, { key, payload });
  return payload;
}
async function search(
  ctx: ActionCtx,
  title: string,
  artist: string,
): Promise<Recording[]> {
  if (!title.trim()) return [];
  return validRecordings(
    await request(
      ctx,
      `recording?${new URLSearchParams({ query: searchText(title, artist), fmt: "json", limit: "12" })}`,
    ),
  );
}
async function fingerprintMatch(
  ctx: ActionCtx,
  song: Doc<"songs">,
): Promise<Recording | undefined> {
  const key = process.env.ACOUSTID_API_KEY;
  if (!key || !song.fingerprint) return;
  const delay = await ctx.runMutation(internal.metadata.requestSlot, {
    key: "acoustid",
  });
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  const body = new URLSearchParams({
    client: key,
    meta: "recordingids",
    duration: String(Math.round(song.fingerprint.duration)),
    fingerprint: song.fingerprint.value,
    format: "json",
  });
  const response = await fetch("https://api.acoustid.org/v2/lookup", {
    method: "POST",
    body,
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) return;
  const data = await response.json();
  const matches = (Array.isArray(data.results) ? data.results : []).filter(
    (r: { score: number }) => r.score >= 0.95,
  );
  const ids = [
    ...new Set<string>(
      matches
        .flatMap((r: { recordings?: { id: string }[] }) =>
          (r.recordings ?? []).map((r) => r.id),
        )
        .filter((id: string) => mbid.test(id)),
    ),
  ];
  if (ids.length !== 1) return;
  const recording = await request(
    ctx,
    `recording/${ids[0]}?fmt=json&inc=artist-credits`,
  );
  // Fingerprint confidence alone cannot excuse a substantially different recording length.
  if (
    !recording.length ||
    Math.abs(recording.length / 1000 - song.duration) >
      Math.min(5, song.duration * 0.02)
  )
    return;
  return recording;
}
async function releases(
  ctx: ActionCtx,
  recordingId: string,
): Promise<Release[]> {
  const data = await request(
    ctx,
    `release?${new URLSearchParams({ recording: recordingId, inc: "artist-credits+release-groups", fmt: "json", limit: "100" })}`,
  );
  return Array.isArray(data.releases)
    ? data.releases.filter((r: Release) => r && mbid.test(r.id))
    : [];
}
async function details(
  ctx: ActionCtx,
  r: Recording,
  release?: Release,
): Promise<Candidate> {
  if (!release) return candidate(r);
  const full = await request(
    ctx,
    `release/${release.id}?fmt=json&inc=recordings+artist-credits`,
  );
  if (
    !full.media?.some((m: { tracks?: { recording?: { id: string } }[] }) =>
      m.tracks?.some((t) => t.recording?.id === r.id),
    )
  )
    throw new ConvexError("This recording is not on the selected release.");
  return candidate(r, full);
}
export const find = action({
  args: {
    id: v.id("songs"),
    title: v.string(),
    artist: v.string(),
    recordingId: v.optional(v.string()),
  },
  returns: v.array(candidateValidator),
  handler: async (ctx, a): Promise<Candidate[]> => {
    const song: Doc<"songs"> = await ctx.runQuery(internal.metadata.context, {
      id: a.id,
    });
    if (a.title.length > 500 || a.artist.length > 500)
      throw new ConvexError("Search text is too long.");
    if (a.recordingId) {
      if (!mbid.test(a.recordingId))
        throw new ConvexError("Invalid recording.");
      const r = await request(
        ctx,
        `recording/${a.recordingId}?fmt=json&inc=artist-credits`,
      );
      return (await releases(ctx, r.id))
        .map((release) => candidate(r, release))
        .slice(0, 100);
    }
    let results = await search(ctx, a.title, a.artist);
    if (
      !strongRecording({ ...song, title: a.title, artist: a.artist }, results)
    ) {
      const identified = await fingerprintMatch(ctx, song).catch(
        () => undefined,
      );
      if (identified)
        results = [
          identified,
          ...results.filter((r) => r.id !== identified.id),
        ];
    }
    return results.map((r) =>
      candidate(r, selectRelease(song.album, r.releases ?? [])),
    );
  },
});
export const detail = action({
  args: {
    id: v.id("songs"),
    recordingId: v.string(),
    releaseId: v.optional(v.string()),
  },
  returns: candidateValidator,
  handler: async (ctx, a): Promise<Candidate> => {
    await ctx.runQuery(internal.metadata.context, { id: a.id });
    if (!mbid.test(a.recordingId) || (a.releaseId && !mbid.test(a.releaseId)))
      throw new ConvexError("Invalid match.");
    const r = await request(
      ctx,
      `recording/${a.recordingId}?fmt=json&inc=artist-credits`,
    );
    return details(ctx, r, a.releaseId ? { id: a.releaseId } : undefined);
  },
});
export const enrich = internalAction({
  args: { id: v.id("songs"), attempt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { id, attempt = 0 }) => {
    const song: Doc<"songs"> | null = await ctx.runQuery(
      internal.songsInternal.load,
      { songId: id },
    );
    if (!song) return null;
    const before: MetadataPatch = Object.fromEntries(
      Object.keys(metadataFields)
        .filter((key) => song[key as keyof typeof song] !== undefined)
        .map((key) => [key, song[key as keyof typeof song]]),
    );
    try {
      const found = await search(ctx, song.title, song.artist ?? "");
      const recording =
        strongRecording(song, found) ?? (await fingerprintMatch(ctx, song));
      if (!recording) {
        await ctx.runMutation(internal.metadata.applyAutomatic, {
          id,
          before,
          changes: {},
          status: "uncertain",
        });
        return null;
      }
      const release = selectRelease(
        song.album,
        await releases(ctx, recording.id),
      );
      const match = await details(ctx, recording, release);
      const changes = candidatePatch(match);
      // Existing imported artwork is credible until the user requests another cover.
      if (match.releaseId && !song.coverKey && !song.artwork) {
        const cover = await fetch(
          `https://coverartarchive.org/release/${match.releaseId}`,
          { signal: AbortSignal.timeout(8000) },
        );
        if (cover.ok) {
          const data = await cover.json();
          if (
            data.images?.some(
              (i: { front: boolean; approved: boolean }) =>
                i.front && i.approved,
            )
          )
            changes.artwork = { kind: "release", releaseId: match.releaseId };
        }
      }
      await ctx.runMutation(internal.metadata.applyAutomatic, {
        id,
        before,
        changes,
        candidate: match,
        status: "matched",
      });
    } catch {
      if (attempt < 2 && process.env.MUSICBRAINZ_ENABLED === "true")
        await ctx.scheduler.runAfter(
          60000 * (attempt + 1),
          internal.metadataLookup.enrich,
          { id, attempt: attempt + 1 },
        );
      else
        await ctx.runMutation(internal.metadata.applyAutomatic, {
          id,
          before,
          changes: {},
          status: "unavailable",
        });
    }
    return null;
  },
});
