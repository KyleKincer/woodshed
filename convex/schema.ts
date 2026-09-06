import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { metadataFields, fingerprintValidator } from './lib/songMetadata';

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
  users: defineTable({ googleAccountId: v.optional(v.string()), email: v.optional(v.string()), emailVerified: v.boolean(), name: v.optional(v.string()), picture: v.optional(v.string()), createdAt: v.number() }).index('by_email', ['email']),
  accountControls: defineTable({
    userId: v.string(),
    status: v.union(v.literal('active'), v.literal('export_only'), v.literal('suspended')),
    byteLimit: v.optional(v.number()), notes: v.string(),
  }).index('by_userId', ['userId']),
  appPolicy: defineTable({ key: v.string(), userBytes: v.number(), appBytes: v.number() }).index('by_key', ['key']),
  billingAccounts: defineTable({
    userId: v.string(), customerId: v.optional(v.string()),
    access: v.union(v.literal('free'), v.literal('paid'), v.literal('grace')),
    subscriptionId: v.optional(v.string()), status: v.optional(v.string()),
    interval: v.optional(v.union(v.literal('month'), v.literal('year'))),
    periodEnd: v.optional(v.number()), cancelAtPeriodEnd: v.optional(v.boolean()),
    graceEndsAt: v.optional(v.number()), allocatedBytes: v.number(), cleanupPending: v.optional(v.boolean()),
    syncGeneration: v.number(), checkoutGeneration: v.number(),
    checkoutBusyUntil: v.optional(v.number()), checkoutSessionId: v.optional(v.string()),
    checkoutUrl: v.optional(v.string()), checkoutExpiresAt: v.optional(v.number()),
    checkoutInterval: v.optional(v.union(v.literal('month'), v.literal('year'))),
  }).index('by_userId', ['userId']).index('by_customerId', ['customerId']),
  billingCapacity: defineTable({ key: v.string(), bytes: v.number() }).index('by_key', ['key']),
  adminAudit: defineTable({ actorId: v.string(), targetId: v.string(), action: v.string(), reason: v.string(), before: v.any(), after: v.any(), at: v.number() }).index('by_targetId', ['targetId']),
  devices: defineTable({
    userId: v.string(), tokenHash: v.string(), name: v.string(), revoked: v.boolean(),
  }).index('by_token', ['tokenHash']).index('by_user', ['userId']),
  storageUsage: defineTable({scope: v.string(), bytes: v.number()}).index('by_scope', ['scope']),
  audioObjects: defineTable({
    userId: v.string(), jobId: v.optional(v.id('jobs')), songId: v.optional(v.id('songs')), verified: v.optional(v.boolean()), key: v.string(), name: v.string(),
    bytes: v.number(), mime: v.string(), checksum: v.string(), expiresAt: v.number(),
    status: v.union(v.literal('reserved'), v.literal('ready'), v.literal('deleting')),
  }).index('by_key', ['key']).index('by_job', ['jobId']).index('by_userId_status', ['userId', 'status']),

  // A separation that already exists, so a second request for the same audio at
  // the same settings costs nothing. Separation is deterministic and expensive:
  // the same public track at the same quality yields byte-identical stems, and
  // GPU time is the largest cost in the app.
  //
  // The rendition owns its R2 objects; songs borrow them. `refCount` is why
  // deleting one user's song cannot pull the audio out from under another's —
  // blobs are freed only when the last reference goes.
  //
  // Uploads are never deduped. They are the user's own files, so sharing them
  // between accounts would leak private content, and a content hash would still
  // reveal that another account holds the same file.
  renditions: defineTable({
    // How the audio was asked for, canonicalised — see lib/dedupe.ts.
    sourceKey: v.string(),
    // Where it actually resolved to, once known. A search and a link that land
    // on the same upload share this, so the second one hits even though the
    // request keys differ.
    resolvedKey: v.optional(v.string()),
    // Serialised separation settings; different settings are different audio.
    qualityKey: v.string(),
    stems: v.array(stemValidator),
    coverKey: v.optional(v.string()),
    title: v.string(),
    uploader: v.optional(v.string()),
    artist: v.optional(v.string()),
    album: v.optional(v.string()),
    duration: v.number(),
    stemMode: v.string(),
    quality: qualityValidator,
    refCount: v.number(),
    createdAt: v.number(),
  })
    .index('by_source_quality', ['sourceKey', 'qualityKey'])
    .index('by_resolved_quality', ['resolvedKey', 'qualityKey']),

  metadataRequests: defineTable({ key: v.string(), nextAt: v.number() }).index('by_key', ['key']),
  metadataCache: defineTable({ key: v.string(), payload: v.any(), expiresAt: v.number() }).index('by_key', ['key']),

  songs: defineTable({
    ...metadataFields,
    metadataLocks: v.optional(v.array(v.string())),
    metadataStatus: v.optional(v.union(v.literal('pending'), v.literal('matched'), v.literal('uncertain'), v.literal('unavailable'))),
    metadataRecordingId: v.optional(v.string()),
    metadataReleaseId: v.optional(v.string()),
    fingerprint: v.optional(fingerprintValidator),
    // Stable Convex Auth user identifier. Every query scopes on this.
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
    // Set when the stems are shared with other songs. Absent means this song
    // owns its blobs outright (uploads, and rows written before dedupe existed).
    renditionId: v.optional(v.id('renditions')),
    addedAt: v.number(),
    // Metronome state: tempo map, time signatures, corrected beat track.
    // Opaque to the backend — the player owns this shape.
    tempo: v.optional(v.any()),
    practice: v.optional(v.any()),
    localImportId: v.optional(v.string()),
  })
    .index('by_user', ['userId'])
    .index('by_user_added', ['userId', 'addedAt'])
    .index('by_user_import', ['userId', 'localImportId']),

  // One row per processing run. The browser subscribes to these for live
  // progress; Modal drives them forward over HTTP callbacks.
  jobs: defineTable({
    userId: v.string(),
    deviceId: v.optional(v.id('devices')),
    kind: v.union(v.literal('separate'), v.literal('beats'), v.literal('import')),
    importMeta: v.optional(v.any()),
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
    // Dispatches so far. YouTube's bot check comes and goes in windows of
    // minutes, so a blocked job is requeued rather than failed; this bounds it.
    attempts: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_status', ['userId', 'status'])
    .index('by_song', ['songId'])
    .index('by_device_status', ['deviceId', 'status']),

  userSettings: defineTable({
    userId: v.string(),
    settings: v.any(),
  }).index('by_user', ['userId']),
});
