/**
 * Song metadata rules (architecture §6.9, D6; maps/meta-css-backend.md G1, G7, G14).
 *
 * The one place that knows the editable metadata fields, their labels and
 * limits, how a raw value is cleaned and validated, when two values count as
 * the same, and the Match status copy. It is shared by the Convex functions
 * (`convex/lib/songMetadata.ts#cleanMetadata`, `convex/metadata.ts`) and by
 * Edit · Details, which pre-validates a field on the client with exactly the
 * server's rules and copy.
 *
 * Everything here is pure and never throws. The file is imported by Vite
 * (client) and by Convex functions, so it uses nothing newer than ES2021 and
 * no browser or Node APIs.
 */

/** Text fields, stored as trimmed strings (year, track and disc are strings too). */
export const TEXT_FIELDS = [
  'title', 'artist', 'album', 'albumArtist', 'year', 'genre', 'trackNumber', 'discNumber', 'musicalKey', 'tuning', 'notes',
] as const;
/** Every editable field, in Edit · Details order (Song, Practice, Artwork). */
export const FIELD_KEYS = [
  'title', 'artist', 'album', 'albumArtist', 'year', 'genre', 'trackNumber', 'discNumber',
  'musicalKey', 'tuning', 'tags', 'notes', 'artwork',
] as const;
/** What `metadata.confirm` locks when present on the song (G3), artwork aside. */
export const IDENTITY_KEYS = ['title', 'artist', 'album', 'albumArtist', 'year', 'trackNumber', 'discNumber'] as const;
/** Fields whose change makes the stored MusicBrainz recording (and suggestion) stale. */
export const RECORDING_KEYS = ['title', 'artist'] as const;
/** Fields whose change makes the stored MusicBrainz release stale. */
export const RELEASE_KEYS = ['album', 'albumArtist'] as const;

export type FieldKey = (typeof FIELD_KEYS)[number];
export type TextField = (typeof TEXT_FIELDS)[number];

export const LIMITS = {
  /** Characters per text field. */
  text: 500,
  /** Characters of notes (shown in the Stage Notes card). */
  notes: 10_000,
  /** Tags per song. */
  tags: 30,
  /** Characters per tag. */
  tag: 60,
  /** Characters of a Find-a-match search term. */
  search: 500,
  /** Songs per bulk edit (`metadata.update` ids, `metadata.updateEach` items). */
  bulk: 100,
  /** Bytes of an uploaded cover image. */
  artworkBytes: 2_000_000,
} as const;

/** The image types an uploaded cover may have. */
export const ARTWORK_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Field labels, as Edit · Details shows them (spec §5.3) and as error copy names them. */
export const LABELS: Readonly<Record<FieldKey, string>> = {
  title: 'Title',
  artist: 'Artist',
  album: 'Album',
  albumArtist: 'Album artist',
  year: 'Year',
  genre: 'Genre',
  trackNumber: 'Track',
  discNumber: 'Disc',
  musicalKey: 'Key',
  tuning: 'Tuning',
  tags: 'Tags',
  notes: 'Notes',
  artwork: 'Artwork',
};

/** A MusicBrainz identifier (UUID). */
export const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Artwork =
  | {kind: 'removed'}
  | {kind: 'upload'; key: string}
  | {kind: 'release'; releaseId: string};
export type FieldValue = string | string[] | Artwork;
export type FieldError = {error: string; field: string};
export type FieldResult = {value: FieldValue} | FieldError;
export type MetadataValues = Partial<Record<TextField, string>> & {tags?: string[]; artwork?: Artwork};

/** Validation copy. Each sentence names the field by its label, never by its key. */
export const MESSAGES = {
  titleRequired: 'Enter a song title.',
  year: 'Use a four-digit release year.',
  number: 'Track and disc numbers must be positive whole numbers.',
  tags: `Use up to ${LIMITS.tags} tags, each at most ${LIMITS.tag} characters.`,
  artwork: 'Invalid cover selection.',
  unknownField: 'Unknown field.',
} as const;

const KEY_SET: ReadonlySet<string> = new Set(FIELD_KEYS);
const TEXT_SET: ReadonlySet<string> = new Set(TEXT_FIELDS);
const PLURAL: ReadonlySet<string> = new Set(['notes', 'tags']);

export function isFieldKey(key: unknown): key is FieldKey {
  return typeof key === 'string' && KEY_SET.has(key);
}

/** The most characters a text field may hold. */
export function maxLength(key: TextField): number {
  return key === 'notes' ? LIMITS.notes : LIMITS.text;
}

const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** "Album artist is too long (500 characters max)." */
export function tooLongMessage(key: TextField): string {
  return `${LABELS[key]} ${PLURAL.has(key) ? 'are' : 'is'} too long (${thousands(maxLength(key))} characters max).`;
}

/** Trims tags, drops empty ones and removes case-insensitive duplicates, keeping the first spelling (G14). */
export function cleanTags(tags: readonly string[]): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim(), folded = tag.toLowerCase();
    if (!tag || seen.has(folded)) continue;
    seen.add(folded);
    out.push(tag);
  }
  return out;
}

const fieldError = (field: string, error: string): FieldError => ({error, field});

function validateArtwork(raw: unknown): FieldResult {
  if (!raw || typeof raw !== 'object') return fieldError('artwork', MESSAGES.artwork);
  const art = raw as {kind?: unknown; key?: unknown; releaseId?: unknown};
  if (art.kind === 'removed') return {value: {kind: 'removed'}};
  if (art.kind === 'upload' && typeof art.key === 'string' && art.key) return {value: {kind: 'upload', key: art.key}};
  if (art.kind === 'release' && typeof art.releaseId === 'string' && MBID.test(art.releaseId))
    return {value: {kind: 'release', releaseId: art.releaseId}};
  return fieldError('artwork', MESSAGES.artwork);
}

/**
 * Cleans and validates one field: text is trimmed and checked against its
 * rules, tags are cleaned (`cleanTags`), artwork must be a valid choice.
 * Returns `{value}` (the value to store) or `{error, field}` with labelled copy.
 */
export function validateField(key: string, raw: unknown): FieldResult {
  if (!isFieldKey(key)) return fieldError(key, MESSAGES.unknownField);
  if (key === 'artwork') return validateArtwork(raw);
  if (key === 'tags') {
    if (!Array.isArray(raw) || raw.some(t => typeof t !== 'string')) return fieldError('tags', MESSAGES.tags);
    if (raw.length > LIMITS.tags || raw.some((t: string) => t.trim().length > LIMITS.tag)) return fieldError('tags', MESSAGES.tags);
    return {value: cleanTags(raw)};
  }
  if (typeof raw !== 'string') return fieldError(key, `${LABELS[key]} must be text.`);
  const value = raw.trim();
  if (value.length > maxLength(key)) return fieldError(key, tooLongMessage(key));
  if (key === 'title' && !value) return fieldError(key, MESSAGES.titleRequired);
  if (key === 'year' && value && !/^\d{4}$/.test(value)) return fieldError(key, MESSAGES.year);
  if ((key === 'trackNumber' || key === 'discNumber') && value && !/^[1-9]\d{0,3}$/.test(value))
    return fieldError(key, MESSAGES.number);
  return {value};
}

/**
 * Validates every defined key of a patch (in `FIELD_KEYS` order, so the first
 * error is the one highest on the page). Returns the cleaned patch, or the
 * first error.
 */
export function validatePatch(changes: Record<string, unknown>): {value: MetadataValues} | FieldError {
  const keys = Object.keys(changes).filter(k => changes[k] !== undefined);
  keys.sort((a, b) => order(a) - order(b));
  const value: Record<string, FieldValue> = {};
  for (const key of keys) {
    const result = validateField(key, changes[key]);
    if ('error' in result) return result;
    value[key] = result.value;
  }
  return {value: value as MetadataValues};
}

function order(key: string): number {
  const i = (FIELD_KEYS as readonly string[]).indexOf(key);
  return i < 0 ? FIELD_KEYS.length : i;
}

function sameArtwork(a: unknown, b: unknown): boolean {
  const x = (a ?? null) as Artwork | null, y = (b ?? null) as Artwork | null;
  if (!x || !y) return x === y;
  if (x.kind !== y.kind) return false;
  if (x.kind === 'upload') return x.key === (y as {key: string}).key;
  if (x.kind === 'release') return x.releaseId.toLowerCase() === (y as {releaseId: string}).releaseId.toLowerCase();
  return true;
}

/**
 * Whether two values of a field are the same for saving (G1). Text compares
 * after trimming, with a missing value equal to ''; tags compare after
 * `cleanTags`, with a missing list equal to []; artwork compares by choice.
 * Use the stored value as one side and the edited value as the other.
 */
export function sameValue(key: string, a: unknown, b: unknown): boolean {
  if (key === 'artwork') return sameArtwork(a, b);
  if (key === 'tags') {
    const x = Array.isArray(a) ? cleanTags(a) : [], y = Array.isArray(b) ? cleanTags(b) : [];
    return x.length === y.length && x.every((t, i) => t === y[i]);
  }
  if (TEXT_SET.has(key)) {
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));
    return text(a) === text(b);
  }
  return a === b;
}

/** The keys of `patch` whose value differs from `stored` (G1: only these save, lock and clear ids). */
export function changedKeys(patch: Record<string, unknown>, stored: Record<string, unknown>): FieldKey[] {
  return FIELD_KEYS.filter(key => patch[key] !== undefined && !sameValue(key, stored[key], patch[key]));
}

/** Whether a song has a value for `key` (a non-empty text or tag list, or an artwork choice). */
export function hasValue(song: Record<string, unknown>, key: FieldKey): boolean {
  const value = song[key];
  if (key === 'artwork') return !!value && typeof value === 'object';
  if (key === 'tags') return Array.isArray(value) && value.length > 0;
  return typeof value === 'string' && value.trim() !== '';
}

// ---- Match status (Edit · Details, spec §5.3; §6.9 status copy) -------------------

export type MetadataStatus = 'pending' | 'matched' | 'uncertain' | 'unavailable';

export const STATUS_COPY = {
  pending: 'Finding song details…',
  matched: 'Matched on MusicBrainz',
  suggestion: 'Not sure this is right',
  noMatch: 'No match found',
  unavailable: "Couldn't reach MusicBrainz",
  retry: 'Try again',
} as const;

export type StatusLine = {
  /** Which line this is: the status, with `uncertain` split by whether a suggestion exists. */
  state: 'pending' | 'matched' | 'suggestion' | 'noMatch' | 'unavailable';
  text: string;
  /** `retry` → `metadataLookup.retry({id})`. */
  action?: {id: 'retry'; label: string};
};

/**
 * The Match section's status line for a song, or null when no lookup ever ran
 * (imports, shared copies, songs older than metadata), where Details offers
 * Find a match instead. Unknown stored values read as no lookup.
 */
export function statusLine(song: {metadataStatus?: unknown; metadataSuggestion?: unknown} | null | undefined): StatusLine | null {
  switch (song?.metadataStatus) {
    case 'pending': return {state: 'pending', text: STATUS_COPY.pending};
    case 'matched': return {state: 'matched', text: STATUS_COPY.matched};
    case 'uncertain':
      return song.metadataSuggestion && typeof song.metadataSuggestion === 'object'
        ? {state: 'suggestion', text: STATUS_COPY.suggestion}
        : {state: 'noMatch', text: STATUS_COPY.noMatch};
    case 'unavailable':
      return {state: 'unavailable', text: STATUS_COPY.unavailable, action: {id: 'retry', label: STATUS_COPY.retry}};
    default: return null;
  }
}
