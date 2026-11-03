// companion/video-audio.mjs: GET /video-audio?id=… streams a video's audio and keeps nothing; only a YouTube id
// is accepted, and a failure keeps its code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVideoAudio, videoAudioArgs } from './video-audio.mjs';

async function serve(t, videoAudio) {
  const server = http.createServer(async (req, res) => { if (!(await videoAudio.route(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('streams the extracted WAV and removes its temporary folder', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'va-test-'));
  const calls = [];
  const videoAudio = createVideoAudio({
    tmpdir: () => root,
    ytDlp: async (args, opts) => {
      calls.push({ args, opts });
      const out = args[args.indexOf('-o') + 1].replace('%(ext)s', 'wav');
      writeFileSync(out, 'RIFF-fake-wav');
    },
  });
  const base = await serve(t, videoAudio);
  const res = await fetch(`${base}/video-audio?id=dQw4w9WgXcQ`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/wav');
  assert.equal(await res.text(), 'RIFF-fake-wav');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.at(-1), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(calls[0].opts.json, false);
  const dir = path.dirname(calls[0].args[calls[0].args.indexOf('-o') + 1]);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(existsSync(dir), false, 'the temporary folder is gone');
});

test('only a YouTube id: anything else is refused before yt-dlp runs', async t => {
  let ran = false;
  const base = await serve(t, createVideoAudio({ ytDlp: async () => { ran = true; } }));
  for (const id of ['', 'https://evil.example/x', '../../etc/passwd', 'abc']) {
    const res = await fetch(`${base}/video-audio?id=${encodeURIComponent(id)}`);
    assert.equal(res.status, 400, id);
    assert.equal((await res.json()).code, 'invalid');
  }
  assert.equal(ran, false);
});

test('a yt-dlp failure keeps its code (a bot check is 503)', async t => {
  const failure = Object.assign(new Error('Sign in to confirm you’re not a bot'), { code: 'bot_check' });
  const base = await serve(t, createVideoAudio({ ytDlp: async () => { throw failure; } }));
  const res = await fetch(`${base}/video-audio?id=dQw4w9WgXcQ`);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'Sign in to confirm you’re not a bot', code: 'bot_check' });
});

test('the arguments: best audio, extracted to mono 16 kHz WAV in the folder', () => {
  const args = videoAudioArgs('dQw4w9WgXcQ', '/tmp/x');
  assert.ok(args.includes('--no-playlist'));
  assert.deepEqual(args.slice(args.indexOf('-f'), args.indexOf('-f') + 2), ['-f', 'bestaudio/best']);
  assert.ok(args.includes('ExtractAudio:-ac 1 -ar 16000'));
  assert.equal(args[args.indexOf('-o') + 1], path.join('/tmp/x', 'audio.%(ext)s'));
});
