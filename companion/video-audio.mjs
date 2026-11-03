// A playthrough video's audio, for lining it up with the recording (src/js/video-align.js; the Stage's Playthrough
// video sheet). The companion answers
//   GET /video-audio?id=<YouTube video id>  → audio/wav, mono 16 kHz 16-bit (the video's soundtrack, nothing kept)
// Only a YouTube id is taken, never a URL: the companion builds the watch URL itself. yt-dlp extracts the audio to a
// temporary folder, the WAV is streamed back and the folder removed. One at a time: a new request ends the last.
//
//   createVideoAudio({ytDlp, tmpdir, fs, timeoutMs}) → {route(req, res) → Promise<boolean>, abortAll()}
//     ytDlp(args, {signal, json: false}) → Promise   lookup.mjs createYtDlp: runs yt-dlp to completion
import { createReadStream } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YTDLP_ARGS from './ytdlp-args.json' with { type: 'json' };

export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
export const TIMEOUT_MS = 180_000;
/** The audio is for onsets only: 16 kHz mono keeps a ten-minute video near 19 MB. */
export const RATE = 16000;

/** yt-dlp's arguments: the best audio stream, extracted to a mono 16 kHz WAV at `dir/audio.wav`. */
export function videoAudioArgs(id, dir) {
  return [...YTDLP_ARGS.base, '--no-warnings', '--no-progress', '-f', 'bestaudio/best', '-x', '--audio-format', 'wav',
    '--postprocessor-args', `ExtractAudio:-ac 1 -ar ${RATE}`, '-o', path.join(dir, 'audio.%(ext)s'),
    `https://www.youtube.com/watch?v=${id}`];
}

export function createVideoAudio({ ytDlp, tmpdir = os.tmpdir, fs = nodeFs, timeoutMs = TIMEOUT_MS }) {
  let current = null;   // AbortController of the request in flight

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  async function route(req, res) {
    const url = new URL(req.url, 'http://local');
    if (url.pathname !== '/video-audio' || req.method !== 'GET') return false;
    const id = url.searchParams.get('id') ?? '';
    if (!VIDEO_ID.test(id)) { json(res, 400, { error: 'That isn’t a YouTube video.', code: 'invalid' }); return true; }
    current?.abort();
    const abort = current = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    // The app gave up (a closed sheet, a new request): stop yt-dlp. (A GET's own 'close' fires once it is read.)
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'woodshed-video-'));
    try {
      await ytDlp(videoAudioArgs(id, dir), { signal: abort.signal, json: false });
      const file = path.join(dir, 'audio.wav');
      const { size } = await fs.stat(file);
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(size), 'cache-control': 'no-store' });
      await new Promise((resolve, reject) => {
        const stream = createReadStream(file);
        stream.on('error', reject);
        res.on('close', resolve);
        stream.pipe(res);
      });
    } catch (error) {
      if (!res.headersSent) {
        const code = abort.signal.aborted ? 'timeout' : error?.code ?? 'unavailable';
        json(res, code === 'bot_check' ? 503 : code === 'timeout' ? 504 : 502, { error: error?.message || 'The video’s audio could not be fetched.', code });
      } else res.destroy();
    } finally {
      clearTimeout(timer);
      if (current === abort) current = null;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    return true;
  }

  return { route, abortAll: () => current?.abort() };
}
