// Canonical keys for deciding that two separation requests are the same work.
//
// Two axes have to match: *what audio* and *what settings*. Settings are easy —
// they are a fixed set of numbers and enum strings. The audio is the hard part,
// because the same track arrives spelled several ways: a full watch URL with
// tracking parameters, a short youtu.be link, a search phrase, a Spotify link
// that gets matched to a YouTube upload later.
//
// So there are two keys per rendition. `sourceKey` is what the request looked
// like, known up front, and is what lets a repeat request skip the GPU
// entirely. `resolvedKey` is where it actually landed, known only after Modal
// reports back, and is what makes a Spotify link and a plain search collapse
// once either has been processed.

import type { Quality } from './presets';

/** Settings that change the output bytes. Anything else must not be in here. */
export function qualityKey(quality: Quality, stemMode: string): string {
  const bitrate = quality.format === 'opus' ? (quality.bitrate ?? 0) : 0;
  return [
    quality.model,
    quality.shifts,
    quality.overlap,
    quality.format,
    bitrate,
    stemMode,
  ].join('|');
}

/** The YouTube video id in a URL, or null if it isn't a YouTube URL. */
function youtubeId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return /^[\w-]{11}$/.test(id) ? id : null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const id = url.searchParams.get('v');
    if (id && /^[\w-]{11}$/.test(id)) return id;
    // /shorts/<id> and /embed/<id>
    const m = url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/);
    if (m) return m[1];
  }
  return null;
}

/**
 * A canonical key for a URL, collapsing the spellings of the same YouTube
 * video. Non-YouTube URLs keep host and path but lose the query string, which
 * is where share ids and campaign parameters live — `?si=…` on a Spotify link
 * differs per share and must not split the key.
 */
export function urlKey(raw: string): string {
  const id = youtubeId(raw);
  if (id) return `youtube:${id}`;
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    const path = url.pathname.replace(/\/+$/, '');
    return `url:${host}${path}`;
  } catch {
    return `url:${raw.trim().toLowerCase()}`;
  }
}

/**
 * The request-time key for a source, or null for sources that must never be
 * deduped. Search text is normalised only for whitespace and case — deciding
 * that two different phrasings mean the same song is guesswork, and a wrong
 * guess hands somebody the wrong song.
 */
export function sourceKey(source: { type: string; value: string } | undefined | null): string | null {
  if (!source) return null;
  switch (source.type) {
    case 'upload':
      return null;
    case 'search':
      return `search:${source.value.trim().replace(/\s+/g, ' ').toLowerCase()}`;
    case 'url':
    case 'spotify':
      return urlKey(source.value);
    default:
      return null;
  }
}
