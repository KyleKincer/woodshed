// Song labels for the Library and the Stage (architecture §2.16, spec §2.2 and §2.4). Pure: no
// DOM, no storage; the clock is an argument.
//
//   artistLabel(song)                 the artist, else the uploader (unless the artist was deliberately cleared)
//   formatDuration(seconds)           '1:04', '1:02:09'; '' for a missing duration
//   metaLine(song)                    '1:04 · Chart · Mapped · 2 spots · 6 stems' (stem count only when not 4)
//   practiceLine(song, {profile})     'Bridge loop · 85% · Drums out' from practiceSummary
//   practisedLine(song, now)          'practised yesterday' from lastPracticedAt
//   stateLine(song, now, {profile})   both joined: 'Bridge loop · 85% · Drums out · practised yesterday'
//   relativeTime(ms, now)             'just now', '5 min ago', 'yesterday', '3 days ago', 'last week', …
//   ratePercent(rate)                 '85%'
//   spotLabel(spot)                   'Bridge walk-up · 85%'
//   initialsOf(label)                 'NB' for a group disc without a cover
//
// "Drums out" names the profile's primary instrument (else its first one); without a profile
// Minus me reads "My part out".

export const SEP = ' · ';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

const INSTRUMENT_LABELS = Object.freeze({drums: 'Drums', bass: 'Bass', guitar: 'Guitar', keys: 'Keys', vocals: 'Vocals', other: 'Other'});

/** The card's artist line: artist, else the uploader unless the artist is locked empty (1.9 song-metadata.js:38-40). */
export function artistLabel(song) {
  if (!song) return '';
  const artist = typeof song.artist === 'string' ? song.artist.trim() : '';
  if (artist) return artist;
  if (Array.isArray(song.metadataLocks) && song.metadataLocks.includes('artist')) return '';
  return typeof song.uploader === 'string' ? song.uploader.trim() : '';
}

/** m:ss (h:mm:ss from an hour); '' when there is no usable duration. */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The number of saved spots on a row (practiceSummary.spotCount). */
export const spotCountOf = song => {
  const n = song?.practiceSummary?.spotCount;
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Row 3 of a card: duration · Chart · Mapped · N spots · N stems (only when not 4). */
export function metaLine(song) {
  if (!song) return '';
  const parts = [];
  const length = formatDuration(song.duration);
  if (length) parts.push(length);
  if (song.hasChart) parts.push('Chart');
  if (song.mapSummary?.real) parts.push('Mapped');
  const spots = spotCountOf(song);
  if (spots) parts.push(plural(spots, 'spot'));
  const stems = Array.isArray(song.stems) ? song.stems.length : 0;
  if (stems && stems !== 4) parts.push(plural(stems, 'stem'));
  return parts.join(SEP);
}

/** '85%' for a playback rate of 0.85. */
export function ratePercent(rate) {
  const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
  return `${Math.round(r * 100)}%`;
}

/** 'Drums out' for the profile's primary instrument; 'My part out' without one. */
export function minusMeLabel(profile) {
  const list = Array.isArray(profile?.instruments) ? profile.instruments : [];
  const primary = INSTRUMENT_LABELS[profile?.primary] ? profile.primary : list.find(i => INSTRUMENT_LABELS[i]);
  return primary ? `${INSTRUMENT_LABELS[primary]} out` : 'My part out';
}

/** The practice half of the state line: loop label, rate and Minus me. '' without a summary. */
export function practiceLine(song, {profile} = {}) {
  const summary = song?.practiceSummary;
  if (!summary) return '';
  const parts = [];
  if (typeof summary.loopLabel === 'string' && summary.loopLabel.trim()) parts.push(summary.loopLabel.trim());
  parts.push(ratePercent(summary.rate));
  if (summary.minusMe) parts.push(minusMeLabel(profile));
  return parts.join(SEP);
}

/**
 * A short relative time: 'just now', '5 min ago', '3 hours ago', 'yesterday', '3 days ago',
 * 'last week', '3 weeks ago', 'last month', '4 months ago', 'last year', '2 years ago'.
 * Times in the future (a skewed clock) read 'just now'. '' when `ms` is not a time.
 */
export function relativeTime(ms, now) {
  if (!Number.isFinite(ms) || !Number.isFinite(now)) return '';
  const diff = now - ms;
  if (diff < MIN) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MIN)} min ago`;
  const midnight = startOfDay(now);
  if (ms >= midnight) return plural(Math.floor(diff / HOUR), 'hour') + ' ago';
  const days = Math.round((midnight - startOfDay(ms)) / DAY);
  if (days <= 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 60) return 'last month';
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  if (days < 730) return 'last year';
  return `${Math.floor(days / 365)} years ago`;
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 'practised yesterday'; '' for a song never practised. */
export function practisedLine(song, now) {
  const when = relativeTime(song?.lastPracticedAt, now);
  return when ? `practised ${when}` : '';
}

/** 'Bridge loop · 85% · Drums out · practised yesterday' (spec §2.2). */
export function stateLine(song, now, {profile} = {}) {
  return [practiceLine(song, {profile}), practisedLine(song, now)].filter(Boolean).join(SEP);
}

/** A spot chip's text: 'Bridge walk-up · 85%'. */
export function spotLabel(spot) {
  const name = typeof spot?.name === 'string' && spot.name.trim() ? spot.name.trim() : 'Spot';
  return `${name}${SEP}${ratePercent(spot?.rate)}`;
}

/** Up to two initials for a group header disc. */
export function initialsOf(label) {
  const words = String(label ?? '').trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map(w => [...w.replace(/^[^\p{L}\p{N}]+/u, '')][0] ?? '').join('');
  return letters.toUpperCase() || '·';
}
