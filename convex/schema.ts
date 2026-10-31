import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { metadataFields, fingerprintValidator } from './lib/songMetadata';
import {headerValidator,barValidator} from './lib/notationValidators';
import {
  practiceSummaryValidator, mapSummaryValidator, metadataCandidateValidator, sectionSuggestionValidator,
  jobKindValidator, jobStatusValidator, revokedByValidator, presenceStateValidator, remoteStateValidator,
} from './lib/validators';

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
  notationParts: defineTable({songId:v.optional(v.id('songs')),userId:v.string(),header:headerValidator,revision:v.number(),lastMutation:v.string(),hitCount:v.number()}).index('by_songId',['songId']),
  notationBars: defineTable({partId:v.id('notationParts'),bar:barValidator}).index('by_partId',['partId']),
  songShares: defineTable({
    songId:v.id('songs'), userId:v.string(), token:v.string(), active:v.boolean(), createdAt:v.number(),includeNotation:v.optional(v.boolean()),
    // Absent means true (1.9 links always carried the map); spec §6.1 'Sections and tempo map', architecture §6.7.
    includeMap:v.optional(v.boolean()),
  }).index('by_songId',['songId']).index('by_token',['token']),
  shareImports: defineTable({
    userId:v.string(), sourceSongId:v.id('songs'), token:v.string(), attempt:v.string(),
    status:v.union(v.literal('copying'),v.literal('ready'),v.literal('failed')),
    songId:v.optional(v.id('songs')), snapshot:v.any(), expiresAt:v.number(),notationPartId:v.optional(v.id('notationParts')),
    files:v.array(v.object({sourceKey:v.string(), key:v.string(), objectId:v.id('audioObjects'), bytes:v.number(), mime:v.string(), etag:v.string()})),
  }).index('by_userId_and_sourceSongId',['userId','sourceSongId']),
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
    // The user's own name for the computer (B5); `name` stays the friendly name refreshed on every pair.
    displayName: v.optional(v.string()),
    // Absent on 1.9 rows. An admin revoke blocks re-pairing; a user revoke does not.
    revokedBy: v.optional(revokedByValidator),
  }).index('by_token', ['tokenHash']).index('by_user', ['userId']),
  // High-churn heartbeat state, kept off `devices` (D11). Written by the device
  // token (`worker.heartbeat`), one row per device. Queries never read the
  // clock: the client computes "online" from `lastSeenAt`.
  devicePresence: defineTable({
    deviceId: v.id('devices'), userId: v.string(), lastSeenAt: v.number(),
    state: presenceStateValidator,
    currentJobId: v.optional(v.id('jobs')), appVersion: v.optional(v.string()),
    platform: v.optional(v.string()), accelerator: v.optional(v.string()),
  }).index('by_deviceId', ['deviceId']).index('by_userId', ['userId']),
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
    // 1.9 practice blob. Read-only after the B1 backfill moves it to
    // `songPractice`; the field is removed in wave 4 (V1, owner gate G7).
    practice: v.optional(v.any()),
    localImportId: v.optional(v.string()),
    // ---- 2.0 (all optional: 1.9 rows have none of these) ----
    // Denormalised for the slim `songs.list` row (B1, D4, D5).
    hasChart: v.optional(v.boolean()),
    lastPracticedAt: v.optional(v.number()),
    practiceSummary: v.optional(practiceSummaryValidator),
    mapSummary: v.optional(mapSummaryValidator),
    // Bumped on every tempo write; `saveTempo` refuses to replace a real map with a non-real one from a stale base.
    tempoRev: v.optional(v.number()),
    // The last tempo save's id, so a session ignores its own echoes (D53).
    tempoSaveId: v.optional(v.string()),
    // G5: a candidate that was not strong enough to apply.
    metadataSuggestion: v.optional(metadataCandidateValidator),
    // G6: an untitled upload whose metadata needs a look (metadata only, D43).
    needsReview: v.optional(v.boolean()),
    // B4 / spec §3.5: a search the user did not confirm (D43).
    recordingUnconfirmed: v.optional(v.boolean()),
    // B7 section suggestions, never written into the map until kept (D47).
    sectionSuggestion: v.optional(sectionSuggestionValidator),
    // Where a URL or search resolved to, and which site served it (B4).
    resolvedUrl: v.optional(v.string()),
    provider: v.optional(v.string()),
    // The device that holds an upload's original file; re-splits must run there (D38).
    originDeviceId: v.optional(v.id('devices')),
  })
    .index('by_user', ['userId'])
    .index('by_user_added', ['userId', 'addedAt'])
    .index('by_user_import', ['userId', 'localImportId']),

  // A song's practice state (practice blob v2, `shared/practice.ts`), out of
  // `songs` so a practice save re-runs only the narrow `songs.getPractice`
  // query (D4, D52). One row per song.
  songPractice: defineTable({
    songId: v.id('songs'), userId: v.string(), practice: v.any(), updatedAt: v.number(),
  }).index('by_songId', ['songId']),

  // B3. `songIds` holds at most 100 ids (enforced by `setlists.ts`).
  setlists: defineTable({
    userId: v.string(), name: v.string(), songIds: v.array(v.id('songs')),
    createdAt: v.number(), updatedAt: v.number(), lastOpenedAt: v.optional(v.number()),
  }).index('by_userId_and_updatedAt', ['userId', 'updatedAt']),

  // One row per processing run. The browser subscribes to these for live
  // progress; Modal drives them forward over HTTP callbacks.
  jobs: defineTable({
    userId: v.string(),
    deviceId: v.optional(v.id('devices')),
    kind: jobKindValidator,
    importMeta: v.optional(v.any()),
    // Set once we know which song this produces. For a reprocess it is set
    // up front so the UI can overlay the existing card.
    songId: v.optional(v.id('songs')),
    label: v.string(),
    source: v.optional(sourceValidator),
    settings: v.optional(v.any()),
    status: jobStatusValidator,
    stage: v.string(), // queued | download | separate | finalize | detect | done
    percent: v.number(),
    message: v.optional(v.string()),
    error: v.optional(v.string()),
    // Partial metadata streamed back early so the card can show real art.
    meta: v.optional(v.any()),
    // Detection result: `{beats, sections?}` for kind 'beats', `{sections}` for kind 'sections'.
    result: v.optional(v.any()),
    // Dispatches so far. YouTube's bot check comes and goes in windows of
    // minutes, so a blocked job is requeued rather than failed; this bounds it.
    attempts: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    // ---- 2.0 (all optional: 1.9 rows have none of these) ----
    // A classified failure (§6.1 job codes), set by the companion.
    errorCode: v.optional(v.string()),
    // When a bot-check failure re-queues itself (§6.6 `worker.autoRetry`).
    retryAt: v.optional(v.number()),
    // First claim by a device.
    startedAt: v.optional(v.number()),
    // The separation that queued this beats job automatically (B6).
    chainedFrom: v.optional(v.id('jobs')),
    // The user chose this recording: a B4 candidate or a pasted URL (D43).
    confirmed: v.optional(v.boolean()),
    // A detection result the open session applied (D44).
    appliedAt: v.optional(v.number()),
  })
    .index('by_user', ['userId'])
    .index('by_user_status', ['userId', 'status'])
    .index('by_song', ['songId'])
    .index('by_device_status', ['deviceId', 'status']),

  userSettings: defineTable({
    userId: v.string(),
    settings: v.any(),
  }).index('by_user', ['userId']),

  // ---- 2.1: the phone remote (convex/remote.ts) ----
  // A device with a song open on the Stage announces itself to its account; any other signed-in device of
  // the account can control it, with no pairing. Light presence (what the remote's picker and the Library
  // bar read), written on a song change and every heartbeat. Queries never read the clock: clients compare
  // `seenAt` with the server's clock as they estimate it (shared/remote.ts STALE_MS). `by_seenAt` is how the
  // hourly cleanup finds the expired ones.
  remoteHosts: defineTable({
    userId: v.string(), hostId: v.string(), name: v.string(), platform: v.optional(v.string()),
    songId: v.optional(v.id('songs')), title: v.string(), artist: v.optional(v.string()), seenAt: v.number(),
    // When a remote last had this host open (`remote.watch`): the host publishes its state only while watched.
    watchedAt: v.optional(v.number()),
  }).index('by_userId', ['userId']).index('by_userId_and_hostId', ['userId', 'hostId']).index('by_seenAt', ['seenAt']),
  // High-churn playback state, kept off `remoteHosts` (written as bars pass); only an open remote reads it.
  remoteStates: defineTable({
    hostRef: v.id('remoteHosts'), userId: v.string(), state: remoteStateValidator, updatedAt: v.number(),
  }).index('by_hostRef', ['hostRef']),
  // Commands a remote sent that the host has not run yet (shared/remote.ts REMOTE_COMMANDS).
  remoteCommands: defineTable({
    hostRef: v.id('remoteHosts'), userId: v.string(), command: v.string(), sentAt: v.number(),
  }).index('by_hostRef', ['hostRef']),
});
