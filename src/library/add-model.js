// The Add sheet's model (architecture §2.16, spec §3.1–3.2). Pure: no DOM, no storage, no clock, no network.
// The sheet (LB2b, add-sheet.js) and the Library commands read it; `src/library/commands.js` may import it (D46).
//
//   classify(input)                 → {kind: 'empty'|'url'|'spotify'|'search', value}
//   badges(title)                   → Array<'Official'|'Live'|'Cover'|'Lyrics'>
//   findDuplicate({url?, title?, artist?, duration?}, songs) → Song|null
//   describeDefaults(profile, settings) → 'Split for drums · Balanced quality · 4 stems'
//   removesMyStem(profile, stemMode, settings?) → Instrument|null
//
// Helpers the sheet also uses: defaultsParts (the defaults line with its emphasised words), jobSettings (the
// settings a job runs with: addDefaults plus the Change choice; upload.js uses it too), stemsFor / stemCount
// (what each stem layout makes), isAudioFile / audioFiles (the accepted formats) and COPY (this module's strings:
// its row lists no .copy.js, so the module exports them, §9.0).

import {INSTRUMENTS, addDefaults, myStems} from '../app/profile.js';

/** @typedef {'drums'|'bass'|'guitar'|'keys'|'vocals'|'other'} Instrument */
/** @typedef {'full'|'six'|'drums'|'vocals'|'bass'} StemMode */

export const COPY = Object.freeze({
  /** The defaults line's clauses (spec §3.2 item 4). */
  splitFor: 'Split for ',
  quality: ' quality',
  stems: n => `${n} stems`,
  separator: ' · ',
  /** Preset names as the line shows them (convex/lib/presets.ts labels; `custom` is Settings → Processing's own mix). */
  presets: Object.freeze({fast: 'Fast', balanced: 'Balanced', studio: 'Studio', custom: 'Custom'}),
  /** The instrument word in "Split for …" and "Your … won’t be …"; `other` has no word of its own. */
  instruments: Object.freeze({drums: 'drums', bass: 'bass', guitar: 'guitar', keys: 'keys', vocals: 'vocals', other: null}),
  removesMyStem: instrument => `Your ${instrument ?? 'part'} won’t be a separate track with this layout.`,
  /** Spec §3.2 item 3, Files. */
  formats: 'MP3, WAV, FLAC, M4A, AAC, OGG, Opus, AIFF and WMA',
  notAudio: name => `${name} isn’t audio. Woodshed accepts MP3, WAV, FLAC, M4A, AAC, OGG, Opus, AIFF and WMA.`,
});

// ---------------------------------------------------------------- classify

const SPOTIFY_HOSTS = new Set(['open.spotify.com', 'play.spotify.com', 'spotify.link']);
const SPOTIFY_URI = /^spotify:(track|album|playlist|artist|episode|show|user):([A-Za-z0-9]+)$/i;
/** A link typed without a scheme: `youtu.be/…`, `www.example.com`, `soundcloud.com/a/b`. */
const BARE_LINK = /^(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?::\d{1,5})?(?:[/?#]\S*)?$/i;
/** Hosts recognised as links even when typed bare with no path (`youtu.be` alone is still a host). */
const MEDIA_HOSTS = /^(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be|soundcloud\.com|on\.soundcloud\.com|bandcamp\.com|vimeo\.com|open\.spotify\.com|spotify\.link)$/i;
const MAX_INPUT = 2000;

function hostOf(url) {
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

/** An http(s) URL for `text`, or null. A bare host needs `www.`, a path, or a known media host. */
function asUrl(text) {
  if (/\s/.test(text)) return null;
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      return url.hostname ? url : null;
    } catch { return null; }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^:]+:\d/.test(text)) return null;   // another scheme (mailto:, ftp:) is not a link
  if (!BARE_LINK.test(text)) return null;
  const host = text.split(/[/?#:]/, 1)[0];
  if (!/^www\./i.test(host) && !/[/?#]/.test(text) && !MEDIA_HOSTS.test(host)) return null;
  try { return new URL(`https://${text}`); } catch { return null; }
}

/**
 * What the omnibox holds (spec §3.2 item 3): nothing, a link, a Spotify link (which is searched for on YouTube),
 * or a search. `value` is the trimmed input; a link typed without a scheme gains `https://`, and a Spotify URI
 * becomes its open.spotify.com link (what the companion's oEmbed lookup accepts). A search collapses runs of
 * whitespace. Over-long input (> 2000 characters) is a search; the server refuses it with a coded error.
 */
export function classify(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text) return {kind: 'empty', value: ''};
  if (text.length <= MAX_INPUT) {
    const uri = SPOTIFY_URI.exec(text);
    if (uri) return {kind: 'spotify', value: `https://open.spotify.com/${uri[1].toLowerCase()}/${uri[2]}`};
    const url = asUrl(text);
    if (url) return {kind: SPOTIFY_HOSTS.has(hostOf(url)) ? 'spotify' : 'url', value: url.href};
  }
  return {kind: 'search', value: text.replace(/\s+/g, ' ')};
}

// ---------------------------------------------------------------- badges

/** The separators a video title puts between its parts: "Artist - Title - Live at Wembley", "Title | Drum Cover". */
const SEGMENT_SEPARATOR = /\s+[-–—]\s+|\s*\|\s*/;

/** The title's dash- or bar-separated parts; part 0 is usually the artist, part 1 the song name. */
function segmentsOf(text) {
  return text.split(SEGMENT_SEPARATOR).map(part => part.trim()).filter(Boolean);
}

/** Bracketed parts: "(Live at Wembley)", "[Drum Cover]". */
const bracketsOf = text => [...text.matchAll(/[([{]([^)\]}]*)[)\]}]/g)].map(m => m[1]);

/**
 * A performance marker. "Live" counts inside brackets ("(Live)", "[Live at Wembley]"), before a performance word
 * anywhere ("Live at …", "Live from …", "Live Session"), as a whole separated part ("Title - Live"), or opening a part
 * after the song name ("Artist - Title - Live in Paris"). A song whose name starts or ends with the word ("Oasis - Live
 * Forever", "Wings - Live and Let Die", "I Want to Live") gets no badge.
 */
const LIVE_WORDS = /\blive\s+(?:at|from|session|sessions|version|video|performance|recording|acoustic|concert|cover|in\s+concert|on\s+(?:stage|air|tv|kexp|letterman))\b/i;
function isLive(text) {
  if (LIVE_WORDS.test(text)) return true;
  if (bracketsOf(text).some(inner => /\blive\b/i.test(inner))) return true;
  const parts = segmentsOf(text.replace(/[([{][^)\]}]*[)\]}]/g, ' '));
  return parts.some((part, i) => (i >= 1 && /^live$/i.test(part)) || (i >= 2 && /^live\b/i.test(part)));
}

/** Instrument and style words that make "… cover" a cover ("Drum Cover", "Acoustic Cover"). */
const COVER_KIND = /\b(?:live|drum|drums|guitar|bass|piano|keys|keyboard|vocal|vocals|acoustic|metal|punk|rock|jazz|cello|violin|ukulele|sax|saxophone|band|full\s+band|instrumental|orchestral|a\s+cappella|lofi|lo-fi)\s+cover\b/i;
/**
 * A cover marker. "Cover" counts inside brackets ("(Bob Dylan cover)"), after an instrument or style word
 * ("Drum Cover"), as "cover by" / "cover version", as a whole separated part ("Title - Cover"), or anywhere in a part
 * after the song name ("Artist - Title - Piano cover"). A song named "Cover Me" or "Under Cover of Darkness" gets none.
 */
function isCover(text) {
  if (COVER_KIND.test(text) || /\bcover(?:ed)?\s+by\b|\bcover\s+version\b/i.test(text)) return true;
  if (bracketsOf(text).some(inner => /\bcover(?:ed)?\b/i.test(inner))) return true;
  const parts = segmentsOf(text.replace(/[([{][^)\]}]*[)\]}]/g, ' '));
  return parts.some((part, i) => (i >= 1 && /^cover$/i.test(part)) || (i >= 2 && /\bcover(?:ed)?\b/i.test(part)));
}

const BADGE_RULES = [
  ['Official', text => /\bofficial\b/i.test(text)],
  ['Live', isLive],
  ['Cover', isCover],
  ['Lyrics', text => /\blyrics?\b/i.test(text)],
];

/** Badges derived from a candidate's title (spec §3.2 item 3), in the order Official, Live, Cover, Lyrics. */
export function badges(title) {
  const text = typeof title === 'string' ? title : '';
  if (!text.trim()) return [];
  return BADGE_RULES.filter(([, test]) => test(text)).map(([name]) => name);
}

// ---------------------------------------------------------------- duplicates

/** Case-folded, accent-folded, punctuation-light text for comparing names. */
function fold(text) {
  return String(text ?? '')
    .normalize('NFKD').replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim();
}

/** Bracketed decorations a video title adds to the song title: "(Official Audio)", "[Lyrics]", "(HD)", "(Remastered 2011)". */
const DECORATION = /\s*[([{]\s*(?:official|audio|video|music video|lyrics?|lyric video|visuali[sz]er|hd|hq|4k|mv|remaster(?:ed)?|explicit|clean|full song)\b[^)\]}]*[)\]}]/gi;

function songTitleOf(title) {
  return String(title ?? '').replaceAll(DECORATION, '').trim();
}

/** A channel name as an artist: "Ada Moreno - Topic" and "AdaMorenoVEVO" both read "ada moreno"-ish. */
function artistOf(name) {
  return fold(String(name ?? '').replace(/\s+-\s+topic$/i, '').replace(/vevo$/i, ''));
}

const squash = text => text.replace(/[\s']+/g, '');

/** The comparable forms of a song's artist: artist, album artist and uploader (an upload's or channel's name). */
function songArtists(song) {
  return [song?.artist, song?.albumArtist, song?.uploader].map(artistOf).filter(Boolean);
}

/**
 * Same artist, or no artist on either side (an untagged file added twice: "" equals "" once case-folded). An
 * uploader is a channel or upload name, not an artist, so it does not stop an artist-less match.
 */
function sameArtist(candidate, song) {
  const want = artistOf(candidate);
  if (!want) return !artistOf(song?.artist) && !artistOf(song?.albumArtist);
  return songArtists(song).some(a => a === want || squash(a) === squash(want));
}

/** {title, artist} pairs a candidate's text may mean: "Title" by "artist", or "Artist - Title" from a video title. */
function readings({title, artist}) {
  const plain = songTitleOf(title);
  const out = [{title: fold(plain), artist}];
  const dash = /^(.+?)\s+[-–—]\s+(.+)$/.exec(plain);
  if (dash) out.push({title: fold(songTitleOf(dash[2])), artist: dash[1]});
  return out.filter(r => r.title);
}

const YOUTUBE_HOSTS = /^(?:(?:www|m|music)\.)?youtube(?:-nocookie)?\.com$/;
const TRACKING = /^(?:utm_.+|si|feature|fbclid|gclid|igshid|ref|ref_src|pp|ab_channel|t|start|list|index)$/i;

/** A canonical form of a media link, so the same recording compares equal however it was pasted. */
export function canonicalUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const spotify = SPOTIFY_URI.exec(raw.trim());
  if (spotify) return `spotify:${spotify[1].toLowerCase()}:${spotify[2]}`;
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.test(host)) {
    const v = url.searchParams.get('v');
    if (v) return `youtube:${v}`;
    const path = /^\/(?:shorts|embed|live|v)\/([\w-]{6,})/.exec(url.pathname);
    if (path) return `youtube:${path[1]}`;
  }
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    if (id) return `youtube:${id}`;
  }
  const bare = host.replace(/^(?:www|m)\./, '');
  if (bare === 'open.spotify.com' || bare === 'play.spotify.com') {
    const parts = url.pathname.split('/').filter(p => p && !/^intl-[a-z-]+$/i.test(p) && p !== 'embed');
    if (parts.length >= 2) return `spotify:${parts[0].toLowerCase()}:${parts[1]}`;
  }
  const params = [...url.searchParams.entries()].filter(([key]) => !TRACKING.test(key)).sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${new URLSearchParams(params)}` : '';
  const path = url.pathname.replace(/\/+$/, '') || '';
  return `${bare}${path}${query}`.toLowerCase();
}

/** The links a library song was made from: its source link and, when the row has it, the link a search resolved to. */
function songUrls(song) {
  const out = [];
  const source = song?.source;
  if (source && (source.type === 'url' || source.type === 'spotify')) out.push(canonicalUrl(source.value));
  if (typeof song?.resolvedUrl === 'string') out.push(canonicalUrl(song.resolvedUrl));
  return out.filter(Boolean);
}

const DURATION_TOLERANCE_S = 2;

const listOf = songs => {
  if (!songs) return [];
  if (songs instanceof Map) return [...songs.values()];
  if (Array.isArray(songs)) return songs;
  if (typeof songs[Symbol.iterator] === 'function') return [...songs];
  return [];
};

/**
 * The library song this candidate already is (spec §3.2 item 3, "Duplicate"), or null: the same source link,
 * or the same title and artist (case- and accent-folded; a video title's "(Official Audio)" and an "Artist - Title"
 * reading are understood; the artist matches the song's artist, album artist or uploader, and no artist on
 * either side counts as the same) with durations within ±2 s. Without both durations a title match is not enough.
 * @param {{url?: string, title?: string, artist?: string, duration?: number}} candidate
 * @param {Map<string, object>|object[]} songs  store.library.songs.value or a list of rows
 */
export function findDuplicate(candidate, songs) {
  const list = listOf(songs).filter(s => s && typeof s === 'object');
  if (!candidate || !list.length) return null;
  const url = canonicalUrl(candidate.url);
  if (url) {
    const byUrl = list.find(song => songUrls(song).includes(url));
    if (byUrl) return byUrl;
  }
  const duration = Number(candidate.duration);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const options = readings({title: candidate.title, artist: candidate.artist});
  if (!options.length) return null;
  return list.find(song => {
    if (!Number.isFinite(song.duration) || Math.abs(song.duration - duration) > DURATION_TOLERANCE_S) return false;
    const title = fold(songTitleOf(song.title));
    if (!title) return false;
    return options.some(o => (o.title === title || squash(o.title) === squash(title)) && sameArtist(o.artist, song));
  }) ?? null;
}

// ---------------------------------------------------------------- stem layouts and defaults

/** The stems each layout makes (convex/lib/presets.ts STEM_MODES; `six` is the 6-stem model). */
const STEMS = Object.freeze({
  full: Object.freeze(['drums', 'bass', 'other', 'vocals']),
  six: Object.freeze(['drums', 'bass', 'guitar', 'piano', 'vocals', 'other']),
  drums: Object.freeze(['drums', 'no_drums']),
  vocals: Object.freeze(['vocals', 'no_vocals']),
  bass: Object.freeze(['bass', 'no_bass']),
});

/** Stem layouts in the order the Change panel lists them (spec §3.2 item 4). */
export const STEM_MODES = Object.freeze(['full', 'six', 'drums', 'vocals', 'bass']);

/** The 6-stem model (convex/lib/presets.ts SIX_STEM_MODEL): a `full` split with it makes six stems. */
const SIX_STEM_MODEL = 'htdemucs_6s';

/**
 * The stem names a layout makes; [] for an unknown layout. `settings` (optional) is what the job runs with: a
 * `full` split on the Custom preset with the 6-stem model makes six stems, as convex/lib/presets.ts expectedStems says.
 * `preset` overrides settings.preset (the Change panel's choice).
 */
export function stemsFor(stemMode, settings = null, preset = settings?.preset) {
  const stems = STEMS[stemMode] ?? [];
  if (stemMode === 'full' && preset === 'custom' && settings?.custom?.model === SIX_STEM_MODEL) return STEMS.six;
  return stems;
}

/** How many stems a layout makes (4, 6 or 2; 6 for `full` on the Custom 6-stem model); 0 for an unknown layout. */
export function stemCount(stemMode, settings = null, preset = settings?.preset) {
  return stemsFor(stemMode, settings, preset).length;
}

/**
 * The settings a new job runs with (spec §3.2 item 4): the stored account settings with the stem layout and preset
 * the Add sheet shows, i.e. profile.js addDefaults (a stored two-part split or an unsaved legacy `full` is never a
 * default) unless the Change panel chose otherwise (`choice` = {stemMode?, preset?}).
 */
export function jobSettings(profile, settings, choice = null) {
  const stored = settings && typeof settings === 'object' ? settings : {};
  const defaults = addDefaults(profile, stored);
  const stemMode = STEMS[choice?.stemMode] ? choice.stemMode : defaults.stemMode;
  const preset = typeof choice?.preset === 'string' && choice.preset ? choice.preset : defaults.preset;
  return {...stored, stemMode, preset};
}

/** The profile's instruments, known names only and deduplicated, with the primary first. */
function instrumentsOf(profile) {
  const list = Array.isArray(profile?.instruments) ? profile.instruments : [];
  const out = [];
  if (INSTRUMENTS.includes(profile?.primary) && list.includes(profile.primary)) out.push(profile.primary);
  for (const instrument of list) if (INSTRUMENTS.includes(instrument) && !out.includes(instrument)) out.push(instrument);
  return out;
}

/** The instrument a split is "for": the primary, else the first instrument; null without a profile. */
function splitInstrument(profile) {
  return instrumentsOf(profile)[0] ?? null;
}

/**
 * The defaults line as parts, for a sheet that emphasises words (spec: "Split for **drums** · **Balanced** quality ·
 * 4 stems"): [{text, strong}]. `choice` overrides the stored defaults ({stemMode, preset}, from Change).
 * The "Split for" clause is left out when the profile names no instrument with a word of its own (none, or Other).
 */
export function defaultsParts(profile, settings, choice = null) {
  const resolved = jobSettings(profile, settings, choice);
  const {stemMode, preset} = resolved;
  const word = COPY.instruments[splitInstrument(profile)] ?? null;
  const label = COPY.presets[preset] ?? COPY.presets.balanced;
  const parts = [];
  if (word) parts.push({text: COPY.splitFor, strong: false}, {text: word, strong: true}, {text: COPY.separator, strong: false});
  parts.push({text: label, strong: true}, {text: COPY.quality + COPY.separator, strong: false}, {text: COPY.stems(stemCount(stemMode, resolved)), strong: false});
  return parts;
}

/**
 * The Add sheet's defaults line (spec §3.2 item 4) from the instrument profile and the account settings, through
 * profile.js addDefaults (the only definition of the defaults, §2.22): 'Split for drums · Balanced quality · 4 stems'.
 */
export function describeDefaults(profile, settings) {
  return defaultsParts(profile, settings).map(p => p.text).join('');
}

/**
 * The profile instrument (the primary first) that would not get its own track with this stem layout, or null:
 * guitar or keys on a 4-stem split (they land in Other), or anything a two-part split leaves out (spec §3.2:
 * "Your guitar won't be a separate track with this layout."). Other is never separate except as `other` itself.
 * `settings` (optional, the job's settings as jobSettings gives them) makes a `full` split on the Custom 6-stem model
 * count as six stems.
 */
export function removesMyStem(profile, stemMode, settings = null) {
  if (!STEMS[stemMode]) return null;
  const stems = stemsFor(stemMode, settings);
  for (const instrument of instrumentsOf(profile)) {
    const {fallbacks, missing} = myStems({instruments: [instrument]}, stems);
    if (fallbacks.length || missing.length) return instrument;
  }
  return null;
}

/** The warning line for removesMyStem's instrument ('Your guitar won’t be a separate track with this layout.'). */
export function removesMyStemLine(instrument) {
  return COPY.removesMyStem(COPY.instruments[instrument] ?? null);
}

// ---------------------------------------------------------------- files

/** File extensions the processor accepts (spec §3.2 hint line; the companion converts each with ffmpeg). */
export const AUDIO_EXTENSIONS = Object.freeze(['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'aif', 'aiff', 'aifc', 'wma']);
const AUDIO_NAME = new RegExp(`\\.(?:${AUDIO_EXTENSIONS.join('|')})$`, 'i');

/** Whether a dropped or chosen file is audio Woodshed can split: by extension, else by an audio/* type. */
export function isAudioFile(file) {
  if (!file || typeof file !== 'object') return false;
  const name = typeof file.name === 'string' ? file.name : '';
  if (AUDIO_NAME.test(name)) return true;
  if (/\.[a-z0-9]{1,8}$/i.test(name) && !/^audio\//i.test(file.type ?? '')) return false;
  return /^audio\//i.test(file.type ?? '');
}

/** Splits files into the audio ones and the rest, keeping their order. */
export function audioFiles(files) {
  const audio = [], other = [];
  for (const file of listOf(files)) (isAudioFile(file) ? audio : other).push(file);
  return {audio, other};
}
