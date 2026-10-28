"use node";
import { v } from "convex/values";
import { fail } from "./lib/errors";
import { LIMITS } from "../shared/metadata";
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

const LOOKUP_UNAVAILABLE =
  "Online metadata lookup is currently unavailable. You can still edit every field.";
const lookupEnabled = () => process.env.MUSICBRAINZ_ENABLED === "true";
async function request(ctx: ActionCtx, path: string): Promise<any> {
  if (!lookupEnabled()) fail("lookup_unavailable", LOOKUP_UNAVAILABLE);
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
    fail("invalid", "This recording is not on the selected release.");
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
    if (a.title.length > LIMITS.search || a.artist.length > LIMITS.search)
      fail("invalid", "Search text is too long.", {
        field: a.title.length > LIMITS.search ? "title" : "artist",
      });
    if (a.recordingId) {
      if (!mbid.test(a.recordingId))
        fail("invalid", "Invalid recording.");
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
      fail("invalid", "Invalid match.");
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
        // G5: keep the best guess for "Is this right?" (the search already carried its releases).
        const best = found[0];
        await ctx.runMutation(internal.metadata.applyAutomatic, {
          id,
          before,
          changes: {},
          ...(best
            ? { suggestion: candidate(best, selectRelease(song.album, best.releases ?? [])) }
            : {}),
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
      if (attempt < 2 && lookupEnabled())
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

/**
 * "Couldn't reach MusicBrainz · [Try again]" and "Find a match" (G17): runs
 * the automatic lookup again for one of the caller's songs. The song shows
 * `pending` at once; `enrich` runs after a slot from the shared MusicBrainz
 * limiter (`lookup_busy` when the queue is too long). `lookup_unavailable`
 * when online lookup is switched off.
 */
export const retry = action({
  args: { id: v.id("songs") },
  returns: v.null(),
  handler: async (ctx, { id }): Promise<null> => {
    await ctx.runQuery(internal.metadata.context, { id });
    if (!lookupEnabled()) fail("lookup_unavailable", LOOKUP_UNAVAILABLE);
    await ctx.runMutation(internal.metadata.queueLookup, { id });
    return null;
  },
});
