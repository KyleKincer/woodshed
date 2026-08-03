import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

// A source is how a song got here. `upload` carries an R2 key the browser
// PUT the original file to; the others are handed straight to yt-dlp.
export const sourceValidator = v.object({
  type: v.union(
    v.literal('url'),
    v.literal('search'),
    v.literal('spotify'),
    v.literal('upload')
  ),
  value: v.string(),
  // Original filename, for `upload` sources only.
  filename: v.optional(v.string()),
});

export const qualityValidator = v.object({
  model: v.string(),
  shifts: v.number(),
  overlap: v.number(),
  // Delivery codec for the separated stems. WAV is migration-only.
  format: v.union(v.literal('opus'), v.literal('flac'), v.literal('wav')),
  bitrate: v.optional(v.number()), // kbps, opus only
});

// One separated stem, stored as an object in R2.
export const stemValidator = v.object({
  name: v.string(),
  key: v.string(),
  bytes: v.optional(v.number()),
  mime: v.optional(v.string()),
});

export default defineSchema({
  songs: defineTable({
    // Clerk subject (`user_...`). Every query scopes on this.
    userId: v.string(),
    title: v.string(),
    uploader: v.optional(v.string()),
    artist: v.optional(v.string()),
    album: v.optional(v.string()),
    duration: v.number(),
    source: v.optional(sourceValidator),
    // R2 key for cover art, if we found any.
    coverKey: v.optional(v.string()),
    stems: v.array(stemValidator),
    stemMode: v.string(),
    quality: qualityValidator,
    addedAt: v.number(),
    // Metronome state: tempo map, time signatures, corrected beat track.
    // Opaque to the backend — the player owns this shape.
    tempo: v.optional(v.any()),
  })
    .index('by_user', ['userId'])
    .index('by_user_added', ['userId', 'addedAt']),

  // One row per processing run. The browser subscribes to these for live
  // progress; Modal drives them forward over HTTP callbacks.
  jobs: defineTable({
    userId: v.string(),
    kind: v.union(v.literal('separate'), v.literal('beats')),
    // Set once we know which song this produces. For a reprocess it is set
    // up front so the UI can overlay the existing card.
    songId: v.optional(v.id('songs')),
    label: v.string(),
    source: v.optional(sourceValidator),
    settings: v.optional(v.any()),
    status: v.union(
      v.literal('queued'),
      v.literal('running'),
      v.literal('done'),
      v.literal('error'),
      v.literal('canceled')
    ),
    stage: v.string(), // queued | download | separate | finalize | detect
    percent: v.number(),
    message: v.optional(v.string()),
    error: v.optional(v.string()),
    // Partial metadata streamed back early so the card can show real art.
    meta: v.optional(v.any()),
    // Beat detection result, for kind === 'beats'.
    result: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_status', ['userId', 'status'])
    .index('by_song', ['songId']),

  userSettings: defineTable({
    userId: v.string(),
    settings: v.any(),
  }).index('by_user', ['userId']),
});
