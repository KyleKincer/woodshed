// A song's playthrough videos (the Stage's video panel, src/stage/video-panel.js): YouTube videos lined up with the
// recording, saved with the song (songs.videos, convex/songs.ts setVideos) so every device shows them.
//
//   Video = {id, videoId, label, offset}
//     id       stable within the song (the panel's angle choice and a spot's angle refer to it)
//     videoId  YouTube's 11-character id
//     label    what the angle menu shows ('' → "Video 1")
//     offset   the video's time, in seconds, when the recording is at 0 s: videoTime = songTime + offset.
//              A video that starts with someone talking has a positive offset; one that cuts the intro, negative.

export type Video = {id: string; videoId: string; label: string; offset: number};

export const MAX_VIDEOS = 8;
export const LABEL_MAX = 80;
/** The most a video may lead or trail the recording (two hours). */
export const OFFSET_MAX = 7200;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const ID = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * The YouTube video id in a link (youtube.com/watch?v=, youtu.be/, /shorts/, /embed/, /live/, m. and music.
 * hosts, youtube-nocookie.com) or a bare 11-character id; null when it isn't one.
 */
export function parseYouTubeId(input: unknown): string | null {
  const text = String(input ?? '').trim();
  if (VIDEO_ID.test(text)) return text;
  let url: URL;
  try { url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'watch') id = url.searchParams.get('v');
    else if (['shorts', 'embed', 'live', 'v'].includes(parts[0] ?? '')) id = parts[1] ?? null;
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

/** A link's start time (t=90, t=1m30s, start=90), in seconds; 0 when it has none. */
export function linkStart(input: unknown): number {
  let url: URL;
  try { url = new URL(String(input ?? '').trim()); } catch { return 0; }
  const raw = url.searchParams.get('t') ?? url.searchParams.get('start') ?? '';
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s?)?$/.exec(raw);
  if (!raw || !m) return 0;
  return (Number(m[1] ?? 0) * 3600) + (Number(m[2] ?? 0) * 60) + Number(m[3] ?? 0);
}

/** Whether `videos` is a valid list to store. */
export function validVideos(videos: unknown): videos is Video[] {
  if (!Array.isArray(videos) || videos.length > MAX_VIDEOS) return false;
  const ids = new Set<string>();
  for (const v of videos) {
    if (!v || typeof v !== 'object') return false;
    const {id, videoId, label, offset} = v as Video;
    if (typeof id !== 'string' || !ID.test(id) || ids.has(id)) return false;
    if (typeof videoId !== 'string' || !VIDEO_ID.test(videoId)) return false;
    if (typeof label !== 'string' || label.length > LABEL_MAX) return false;
    if (typeof offset !== 'number' || !Number.isFinite(offset) || Math.abs(offset) > OFFSET_MAX) return false;
    ids.add(id);
  }
  return true;
}

/** The video's time for a song time (seconds). */
export const videoTimeAt = (songTime: number, offset: number) => songTime + offset;

/** The offset that puts `videoTime` at `songTime` ("Line up with the cue"). */
export const offsetFor = (videoTime: number, songTime: number) => Math.round((videoTime - songTime) * 1000) / 1000;

/** The label shown for a video: its own, else "Video n". */
export const videoLabel = (video: Pick<Video, 'label'> | null | undefined, index: number) =>
  (video?.label ?? '').trim() || `Video ${index + 1}`;
