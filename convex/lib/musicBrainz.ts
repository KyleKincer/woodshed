import { mbid, type Candidate, type MetadataPatch } from './songMetadata';

type Credit = {
  name?: string;
  joinphrase?: string;
  artist?: { name?: string };
};
export type Recording = {
  id: string;
  title: string;
  length?: number;
  score?: number;
  disambiguation?: string;
  'artist-credit'?: Credit[];
  releases?: Release[];
};
export type Release = {
  id: string;
  title?: string;
  date?: string;
  status?: string;
  'artist-credit'?: Credit[];
  'release-group'?: {
    'first-release-date'?: string;
    'secondary-types'?: string[];
  };
  media?: {
    position?: number;
    tracks?: { position?: number; recording?: { id?: string } }[];
  }[];
};
export const normalize = (s: string) =>
  s
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const credit = (c?: Credit[]) =>
  (c ?? [])
    .map((a) => `${a.name ?? a.artist?.name ?? ''}${a.joinphrase ?? ''}`)
    .join('')
    .slice(0, 500);
export function validRecordings(data: unknown): Recording[] {
  if (
    !data ||
    typeof data !== 'object' ||
    !Array.isArray((data as { recordings?: unknown }).recordings)
  )
    return [];
  return (data as { recordings: Recording[] }).recordings
    .filter((r) => r && mbid.test(r.id) && typeof r.title === 'string')
    .slice(0, 12);
}
export function candidate(r: Recording, release?: Release): Candidate {
  const medium = release?.media?.find((m) =>
    m.tracks?.some((t) => t.recording?.id === r.id),
  );
  const track = medium?.tracks?.find((t) => t.recording?.id === r.id);
  return {
    recordingId: r.id,
    ...(release && mbid.test(release.id) ? { releaseId: release.id } : {}),
    title: r.title.slice(0, 500),
    artist: credit(r['artist-credit']),
    album: release?.title?.slice(0, 500) ?? '',
    albumArtist: credit(release?.['artist-credit']),
    year: /^\d{4}/.exec(release?.date ?? '')?.[0] ?? '',
    trackNumber: track?.position ? String(track.position) : '',
    discNumber: medium?.position ? String(medium.position) : '',
    duration: Number.isFinite(r.length) ? r.length! / 1000 : 0,
    disambiguation: (r.disambiguation ?? '').slice(0, 500),
    score: Number(r.score) || 0,
  };
}
export function strongRecording(
  song: { title: string; artist?: string; duration: number },
  recordings: Recording[],
): Recording | undefined {
  const matches = recordings.filter(
    (r) =>
      normalize(r.title) === normalize(song.title) &&
      !!song.artist &&
      normalize(credit(r['artist-credit'])) === normalize(song.artist) &&
      r.length &&
      Math.abs(r.length / 1000 - song.duration) <=
        Math.min(3, song.duration * 0.015) &&
      !r.disambiguation,
  );
  // Separate recording IDs with indistinguishable names/times still require review.
  return new Set(matches.map((r) => r.id)).size === 1 ? matches[0] : undefined;
}
export function selectRelease(
  album: string | undefined,
  releases: Release[],
): Release | undefined {
  const valid = releases.filter(
    (r) => mbid.test(r.id) && r.title && r.status === 'Official',
  );
  const matching = album
    ? valid.filter((r) => normalize(r.title!) === normalize(album))
    : [];
  if (album && !matching.length) return undefined;
  const options = matching.length
    ? matching
    : valid.filter(
        (r) =>
          r.date &&
          r.date === r['release-group']?.['first-release-date'] &&
          !r['release-group']?.['secondary-types']?.length,
      );
  // Multiple original album identities are ambiguous, even if dates tie.
  if (
    !matching.length &&
    new Set(options.map((r) => normalize(r.title!))).size !== 1
  )
    return undefined;
  return options.sort((a, b) =>
    (a.date || '9999').localeCompare(b.date || '9999'),
  )[0];
}
export function candidatePatch(c: Candidate): MetadataPatch {
  const patch: MetadataPatch = { title: c.title, artist: c.artist };
  if (c.releaseId && c.album) {
    patch.album = c.album;
    for (const key of [
      'albumArtist',
      'year',
      'trackNumber',
      'discNumber',
    ] as const)
      if (c[key]) patch[key] = c[key];
  }
  return patch;
}
export function searchText(title: string, artist: string) {
  // Quote each value and escape Lucene syntax; user input never becomes a query operator.
  const quoted = (s: string) =>
    `"${s.replace(/[+\-!(){}\[\]^"~*?:\\/&|]/g, ' ').trim()}"`;
  return `recording:${quoted(title)}${artist.trim() ? ` AND artist:${quoted(artist)}` : ''}`;
}
