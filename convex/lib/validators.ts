import { v, type Infer } from 'convex/values';

/**
 * Shared validators for the 2.0 schema (architecture §6.2). Writers enforce the
 * list caps below; validators cannot express array length.
 */

/** Top spots kept in `practiceSummary.spots` (D5). */
export const SUMMARY_SPOTS_MAX = 3;
/** Section names kept in `mapSummary.sections` (D5). */
export const SUMMARY_SECTIONS_MAX = 64;
/** Suggested sections kept in `songs.sectionSuggestion.sections` (D47). */
export const SECTION_SUGGESTIONS_MAX = 64;

/** A position on the song map: a bar id, a beat inside it, and an optional fraction of that beat. */
export const barRefValidator = v.object({
  id: v.string(),
  beat: v.number(),
  frac: v.optional(v.number()),
});
export type BarRef = Infer<typeof barRefValidator>;

/** What the Library needs from a song's practice without loading it (B1, D5, D52). */
export const practiceSummaryValidator = v.object({
  loopLabel: v.optional(v.string()),
  rate: v.number(),
  minusMe: v.boolean(),
  surface: v.optional(v.string()),
  spotCount: v.number(),
  spots: v.array(v.object({ id: v.string(), name: v.string(), rate: v.number() })), // ≤ SUMMARY_SPOTS_MAX
});
export type PracticeSummary = Infer<typeof practiceSummaryValidator>;

/** What the Library needs from a song's map without loading `tempo` (B1, D5). */
export const mapSummaryValidator = v.object({
  real: v.boolean(),
  bpm: v.optional(v.number()),
  meter: v.optional(v.string()),
  sections: v.array(v.string()), // ≤ SUMMARY_SECTIONS_MAX
});
export type MapSummary = Infer<typeof mapSummaryValidator>;

/**
 * A MusicBrainz candidate kept as `songs.metadataSuggestion` (G5). The listed
 * fields are the contract shape; the optional tail accepts everything
 * `lib/musicBrainz.ts#candidate()` returns, so a raw candidate stores as is.
 */
export const metadataCandidateValidator = v.object({
  recordingId: v.string(),
  releaseId: v.optional(v.string()),
  title: v.string(),
  artist: v.optional(v.string()),
  album: v.optional(v.string()),
  year: v.optional(v.string()),
  duration: v.optional(v.number()),
  coverUrl: v.optional(v.string()),
  albumArtist: v.optional(v.string()),
  trackNumber: v.optional(v.string()),
  discNumber: v.optional(v.string()),
  disambiguation: v.optional(v.string()),
  score: v.optional(v.number()),
});
export type MetadataCandidate = Infer<typeof metadataCandidateValidator>;

/** One suggested section boundary from the companion (B7, D47). */
export const suggestedSectionValidator = v.object({
  t0: v.number(),
  label: v.string(),
  confidence: v.number(),
});

/** `songs.sectionSuggestion`: shown as dashed blocks until the user keeps or dismisses them (D47). */
export const sectionSuggestionValidator = v.object({
  sections: v.array(suggestedSectionValidator), // ≤ SECTION_SUGGESTIONS_MAX
  jobId: v.id('jobs'),
  createdAt: v.number(),
});
export type SectionSuggestion = Infer<typeof sectionSuggestionValidator>;

/** `jobs.kind`. `sections` is new in 2.0 (B7). */
export const jobKindValidator = v.union(
  v.literal('separate'),
  v.literal('beats'),
  v.literal('import'),
  v.literal('sections'),
);
export type JobKind = Infer<typeof jobKindValidator>;

/** `jobs.status`, unchanged from 1.9. */
export const jobStatusValidator = v.union(
  v.literal('queued'),
  v.literal('running'),
  v.literal('done'),
  v.literal('error'),
  v.literal('canceled'),
);
export type JobStatus = Infer<typeof jobStatusValidator>;

/**
 * Early metadata for a job card (B4): `jobs.createSeparation` args and
 * `worker.progress` args. Writers cap strings at 300 and `thumbnail` at 2000
 * (https only). The stored `jobs.meta` stays `v.any()` because 1.9 rows carry
 * other shapes.
 */
export const jobMetaValidator = v.object({
  title: v.optional(v.string()),
  channel: v.optional(v.string()),
  duration: v.optional(v.number()),
  thumbnail: v.optional(v.string()),
  provider: v.optional(v.string()),
});
export type JobMeta = Infer<typeof jobMetaValidator>;

/** Who revoked a device (B5): a user-revoked device can re-pair, an admin-revoked one cannot. */
export const revokedByValidator = v.union(v.literal('user'), v.literal('admin'));

/** A device's reported state in `devicePresence` (D11). "Online" is computed on the client from `lastSeenAt`. */
export const presenceStateValidator = v.union(v.literal('idle'), v.literal('busy'), v.literal('offline'));
export type PresenceState = Infer<typeof presenceStateValidator>;
