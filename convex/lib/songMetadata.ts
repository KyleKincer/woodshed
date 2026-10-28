import { v, type Infer } from 'convex/values';
import { MBID, validatePatch } from '../../shared/metadata';
import { fail } from './errors';

export const artworkValidator = v.union(
  v.object({ kind: v.literal('removed') }),
  v.object({ kind: v.literal('upload'), key: v.string() }),
  v.object({ kind: v.literal('release'), releaseId: v.string() }),
);
export const metadataFields = {
  title: v.optional(v.string()),
  artist: v.optional(v.string()),
  album: v.optional(v.string()),
  albumArtist: v.optional(v.string()),
  year: v.optional(v.string()),
  genre: v.optional(v.string()),
  trackNumber: v.optional(v.string()),
  discNumber: v.optional(v.string()),
  musicalKey: v.optional(v.string()),
  tuning: v.optional(v.string()),
  tags: v.optional(v.array(v.string())),
  notes: v.optional(v.string()),
  artwork: v.optional(artworkValidator),
};
export const metadataPatch = v.object(metadataFields);
export type MetadataPatch = Infer<typeof metadataPatch>;
/** A MusicBrainz identifier (the shared `MBID`). */
export const mbid = MBID;
export const fingerprintValidator = v.object({
  value: v.string(),
  duration: v.number(),
});
export const candidateValidator = v.object({
  recordingId: v.string(),
  releaseId: v.optional(v.string()),
  title: v.string(),
  artist: v.string(),
  album: v.string(),
  albumArtist: v.string(),
  year: v.string(),
  trackNumber: v.string(),
  discNumber: v.string(),
  duration: v.number(),
  disambiguation: v.string(),
  score: v.number(),
});
export type Candidate = Infer<typeof candidateValidator>;
/**
 * Cleans and validates a metadata patch with the shared rules
 * (`shared/metadata.ts#validatePatch`): text trimmed, tags trimmed and
 * deduplicated case-insensitively, artwork checked. Keys left undefined are
 * dropped. The first invalid field fails with `invalid`, carrying `field` and
 * its labelled copy ("Album artist is too long (500 characters max).").
 */
export function cleanMetadata(input: MetadataPatch): MetadataPatch {
  const result = validatePatch(input as Record<string, unknown>);
  if ('error' in result) fail('invalid', result.error, { field: result.field });
  return result.value as MetadataPatch;
}
export function unprotected(
  patch: MetadataPatch,
  locks: string[] = [],
): MetadataPatch {
  return Object.fromEntries(
    Object.entries(patch).filter(([key]) => !locks.includes(key)),
  );
}
export function coverKeyOf(song: {
  coverKey?: string;
  artwork?: Infer<typeof artworkValidator>;
}) {
  return song.artwork
    ? song.artwork.kind === 'upload'
      ? song.artwork.key
      : undefined
    : song.coverKey;
}
