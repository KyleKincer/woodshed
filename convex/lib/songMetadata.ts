import { v, ConvexError, type Infer } from 'convex/values';

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
export const mbid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
export function cleanMetadata(input: MetadataPatch): MetadataPatch {
  const result = { ...input };
  for (const key of Object.keys(result) as (keyof MetadataPatch)[]) {
    const value = result[key];
    if (typeof value !== 'string') continue;
    const cleaned = value.trim();
    if (cleaned.length > (key === 'notes' ? 10000 : 500))
      throw new ConvexError(`${key} is too long.`);
    if (key === 'title' && !cleaned)
      throw new ConvexError('Enter a song title.');
    if (key === 'year' && cleaned && !/^\d{4}$/.test(cleaned))
      throw new ConvexError('Use a four-digit release year.');
    if (
      ['trackNumber', 'discNumber'].includes(key) &&
      cleaned &&
      !/^[1-9]\d{0,3}$/.test(cleaned)
    )
      throw new ConvexError(
        'Track and disc numbers must be positive whole numbers.',
      );
    (result as Record<string, unknown>)[key] = cleaned;
  }
  if (result.tags) {
    if (
      result.tags.length > 30 ||
      result.tags.some((t) => t.trim().length > 60)
    )
      throw new ConvexError('Use up to 30 tags, each at most 60 characters.');
    result.tags = [
      ...new Set(result.tags.map((t) => t.trim()).filter(Boolean)),
    ];
  }
  if (
    result.artwork?.kind === 'release' &&
    !mbid.test(result.artwork.releaseId)
  )
    throw new ConvexError('Invalid cover selection.');
  return result;
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
