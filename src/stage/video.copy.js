// Copy for the playthrough video: the Stage's panel (video-panel.js) and the Playthrough video sheet
// (sheets/video.js). Pure, so the tests read it.

const pad = (n) => String(n).padStart(2, '0');

/** Seconds as m:ss.s (a sign for negatives): 14.3 → '0:14.3', −2.05 → '−0:02.1'. */
export function clockTime(seconds) {
  const s = Number.isFinite(seconds) ? seconds : 0;
  const a = Math.round(Math.abs(s) * 10) / 10;
  const m = Math.floor(a / 60), rest = a - m * 60;
  const whole = Math.floor(rest), tenth = Math.round((rest - whole) * 10);
  return `${s < 0 && a > 0 ? '−' : ''}${m}:${pad(whole)}.${tenth}`;
}

/** 'm:ss', 'm:ss.s', 'ss' or 'h:mm:ss' typed by a person → seconds (a leading minus allowed), or null. */
export function parseClock(text) {
  const t = String(text ?? '').trim().replace(/^[−–]/, '-');
  const m = /^(-)?(?:(\d+):)?(?:(\d+):)?(\d+(?:[.,]\d+)?)$/.exec(t);
  if (!m) return null;
  const parts = [m[2], m[3]].filter((x) => x !== undefined).map(Number);
  const sec = Number(m[4].replace(',', '.'));
  const total = parts.length === 2 ? parts[0] * 3600 + parts[1] * 60 + sec : parts.length === 1 ? parts[0] * 60 + sec : sec;
  return Number.isFinite(total) ? (m[1] ? -total : total) : null;
}

export const COPY = Object.freeze({
  // ---- the panel
  region: 'Playthrough video',
  angle: 'Video',
  angles: 'Angles',
  watch: (name) => `Watch ${name}`,
  resize: 'Resize the video',
  more: 'Video options',
  soundOn: 'Turn the video’s sound on',
  soundOff: 'Mute the video',
  mirror: 'Mirror',
  resetZoom: 'Reset zoom',
  allAngles: 'Show all angles',
  layout: 'Layout',
  docks: Object.freeze({auto: 'Automatic', side: 'Beside the music', top: 'Above the music', float: 'Floating'}),
  lineUp: 'Line up…',
  hide: 'Hide video',
  before: (at) => `The video starts at ${at} in the song.`,
  after: 'The video has ended here.',
  loading: 'Loading the video…',
  blocked: 'This video’s owner doesn’t allow it to play in other apps.',
  missing: 'This video is unavailable.',
  failed: 'The video couldn’t play.',
  openOnYouTube: 'Open on YouTube',

  // ---- the sheet
  title: 'Playthrough video',
  find: 'Find a playthrough',
  findAnother: 'Find another angle',
  search: 'Search',
  searching: 'Searching YouTube…',
  results: 'Videos found',
  noResults: 'Nothing found. Try other words, or paste a link below.',
  searchFailed: (sentence) => `The search didn’t work. ${sentence}`,
  use: 'Add',
  added: 'Added',
  searchYouTube: 'Search on YouTube',
  searchYouTubeHint: 'Copy the video’s link (Share › Copy link) and paste it below.',
  thisDevice: 'On this device',
  intro: 'A drum cam or playthrough of this recording. It plays muted beside the music and follows play, loops and speed.',
  link: 'YouTube link',
  linkPlaceholder: 'https://youtube.com/watch?v=…',
  add: 'Add video',
  addAnother: 'Add another angle',
  notYouTube: 'That isn’t a YouTube video link.',
  full: 'A song can have up to 8 videos.',
  videos: 'Videos',
  labelOf: (name) => `Name of ${name}`,
  remove: (name) => `Remove ${name}`,
  lineUpHeading: 'Line it up',
  auto: 'Line up automatically',
  autoBusy: 'Listening to the video…',
  autoDesktop: 'Woodshed for desktop can line it up for you by listening to the video.',
  autoGood: (at) => `Lined up: the recording starts at ${at} in the video.`,
  autoCheck: (at) => `Probably lined up: the recording starts at ${at} in the video. Play a few bars to check.`,
  autoPoor: 'Woodshed couldn’t find this recording in the video’s sound. Line it up by hand below.',
  autoNotReady: 'The song is still loading. Line up automatically once it plays.',
  autoFailed: (sentence) => `The video’s sound couldn’t be fetched. ${sentence}`,
  startsAt: 'The recording starts in the video at',
  startsAtHint: 'Find the moment the song starts in the video on YouTube and type it here, then nudge while it plays.',
  invalidTime: 'Type a time like 0:14.3',
  nudge: (delta) => `${delta > 0 ? 'Later' : 'Earlier'} by ${Math.abs(delta) >= 1 ? `${Math.abs(delta)} s` : `${Math.round(Math.abs(delta) * 1000)} ms`}`,
  nudgeLabel: (delta) => `${delta > 0 ? '+' : '−'}${Math.abs(delta) >= 1 ? `${Math.abs(delta)} s` : `${Math.round(Math.abs(delta) * 1000)} ms`}`,
  nudgeHint: 'Video ahead of the music? Earlier. Behind? Later.',
  sound: 'Video sound',
  show: 'Show beside the music',
  readOnly: 'Only the song’s owner can change its videos.',
  saveFailed: 'Couldn’t save the videos. Your changes are kept here; they save when you’re back online.',
});
