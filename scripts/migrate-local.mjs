#!/usr/bin/env node
/**
 * One-shot migration: desktop Woodshed library -> Convex + R2.
 *
 * Reads the old library.json, transcodes each stem WAV to the delivery codec,
 * uploads stems and cover art to R2, and inserts the song rows under your
 * Clerk user — preserving tempo maps and hand-corrected beat tracks, which are
 * the part you can't regenerate.
 *
 * Usage:
 *   node scripts/migrate-local.mjs --user user_2abc... [options]
 *
 * Options:
 *   --user <clerkUserId>  Required. Clerk dashboard -> Users -> copy the ID.
 *   --dir <path>          Old app data dir. Defaults to the macOS location.
 *   --format opus|flac    Delivery codec (default: opus).
 *   --bitrate <kbps>      Opus bitrate (default: 192).
 *   --only <id>           Migrate a single legacy song id.
 *   --dry-run             Transcode and report, but upload nothing.
 *
 * Requires in the environment (or .env.local):
 *   R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 * and a logged-in Convex CLI (`npx convex dev` once).
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import 'dotenv/config';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const execFileAsync = promisify(execFile);

// ---- args -----------------------------------------------------------------

function parseArgs(argv) {
  const out = { format: 'opus', bitrate: 192, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user') out.user = argv[++i];
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--format') out.format = argv[++i];
    else if (a === '--bitrate') out.bitrate = parseInt(argv[++i], 10);
    else if (a === '--only') out.only = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.user) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('*/')[0].replace('#!/usr/bin/env node\n', ''));
  process.exit(args.help ? 0 : 1);
}
if (!/^user_/.test(args.user)) {
  console.error(`✗ --user should be a Clerk user id starting with "user_", got "${args.user}"`);
  process.exit(1);
}

const DATA_DIR =
  args.dir || path.join(homedir(), 'Library', 'Application Support', 'woodshed');
const LIBRARY_JSON = path.join(DATA_DIR, 'library.json');
const MEDIA_DIR = path.join(DATA_DIR, 'media');

if (!existsSync(LIBRARY_JSON)) {
  console.error(`✗ No library.json at ${LIBRARY_JSON}\n  Pass --dir if your data lives elsewhere.`);
  process.exit(1);
}

const R2 = {
  endpoint: process.env.R2_ENDPOINT,
  bucket: process.env.R2_BUCKET,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
};
if (!args.dryRun) {
  const missing = Object.entries(R2).filter(([, v]) => !v).map(([k]) => k.toUpperCase());
  if (missing.length) {
    console.error(`✗ Missing R2 credentials: ${missing.join(', ')}\n  Put them in .env.local or the environment.`);
    process.exit(1);
  }
}

const s3 = args.dryRun
  ? null
  : new S3Client({
      region: 'auto',
      endpoint: R2.endpoint,
      credentials: { accessKeyId: R2.accessKeyId, secretAccessKey: R2.secretAccessKey },
    });

// ---- helpers --------------------------------------------------------------

const ffprobeBin = ffprobeStatic.path;
const mb = (n) => (n / 1048576).toFixed(1);

function probeDuration(file) {
  try {
    const out = execFileSync(
      ffprobeBin,
      ['-v', 'quiet', '-print_format', 'json', '-show_format', file],
      { encoding: 'utf8' }
    );
    return Math.round(parseFloat(JSON.parse(out).format?.duration) || 0);
  } catch {
    return 0;
  }
}

async function transcode(src, dest) {
  if (args.format === 'flac') {
    await execFileAsync(ffmpegPath, ['-y', '-i', src, '-c:a', 'flac', '-compression_level', '8', dest]);
    return 'audio/flac';
  }
  // Opus in WebM, matching modal/separate.py — Ogg/Opus would not decode in Safari.
  await execFileAsync(ffmpegPath, [
    '-y', '-i', src,
    '-c:a', 'libopus', '-b:a', `${args.bitrate}k`,
    '-vbr', 'on', '-application', 'audio',
    '-f', 'webm', dest,
  ]);
  return 'audio/webm';
}

async function upload(file, key, contentType) {
  if (args.dryRun) return statSync(file).size;
  const size = statSync(file).size;
  await s3.send(new PutObjectCommand({
    Bucket: R2.bucket,
    Key: key,
    Body: createReadStream(file),
    ContentLength: size,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  return size;
}

async function convexRun(fn, payload) {
  if (args.dryRun) return { dryRun: true };
  const { stdout } = await execFileAsync(
    'npx',
    ['convex', 'run', fn, JSON.stringify(payload)],
    { maxBuffer: 1 << 24 }
  );
  return stdout.trim();
}

// ---- main -----------------------------------------------------------------

const library = JSON.parse(readFileSync(LIBRARY_JSON, 'utf8'));
let songs = library.songs || [];
if (args.only) songs = songs.filter((s) => s.id === args.only);

console.log(`Migrating ${songs.length} song(s) from ${DATA_DIR}`);
console.log(`  target: ${args.format}${args.format === 'opus' ? ` @ ${args.bitrate}k` : ''} -> r2://${R2.bucket || '(dry run)'}`);
console.log(`  user:   ${args.user}\n`);

const ext = args.format === 'flac' ? 'flac' : 'webm';
let ok = 0;
let skipped = 0;
let failed = 0;
let bytesBefore = 0;
let bytesAfter = 0;

for (const [i, song] of songs.entries()) {
  const label = `[${i + 1}/${songs.length}] ${song.title}`;
  const songDir = path.join(MEDIA_DIR, song.id);
  const stemFiles = (song.stems || []).filter((s) => existsSync(path.join(songDir, s.file)));

  if (!stemFiles.length) {
    console.log(`${label} — no stem files on disk, skipping`);
    skipped++;
    continue;
  }

  const tmp = await mkdtemp(path.join(tmpdir(), 'woodshed-mig-'));
  try {
    // Keys mirror what Modal writes, minus the job id: users/<u>/songs/<legacyId>/
    const prefix = `users/${args.user}/songs/${song.id}`;
    const stems = [];

    for (const stem of stemFiles) {
      const src = path.join(songDir, stem.file);
      const dest = path.join(tmp, `${stem.name}.${ext}`);
      const before = statSync(src).size;
      bytesBefore += before;
      const mime = await transcode(src, dest);
      const key = `${prefix}/${stem.name}.${ext}`;
      const size = await upload(dest, key, mime);
      bytesAfter += size;
      stems.push({ name: stem.name, key, bytes: size, mime });
      process.stdout.write(`\r${label} — ${stem.name}: ${mb(before)} -> ${mb(size)} MB   `);
    }

    let coverKey;
    if (song.thumb && existsSync(path.join(songDir, song.thumb))) {
      coverKey = `${prefix}/cover.jpg`;
      await upload(path.join(songDir, song.thumb), coverKey, 'image/jpeg');
    }

    const duration =
      song.duration || probeDuration(path.join(songDir, stemFiles[0].file));

    await convexRun('migrate:importSong', {
      userId: args.user,
      legacyId: song.id,
      title: song.title,
      uploader: song.uploader || undefined,
      artist: song.artist || undefined,
      album: song.album || undefined,
      duration,
      // 'file' sources pointed at a path on the old machine that the cloud
      // can't reach; drop them so the UI doesn't offer a broken reprocess.
      source:
        song.source && song.source.type !== 'file'
          ? { type: song.source.type, value: song.source.value }
          : undefined,
      coverKey,
      stems,
      stemMode: song.stemMode || 'full',
      quality: {
        model: song.quality?.model || 'htdemucs_ft',
        shifts: song.quality?.shifts ?? 0,
        overlap: song.quality?.overlap ?? 0.25,
        format: args.format,
        ...(args.format === 'opus' ? { bitrate: args.bitrate } : {}),
      },
      addedAt: song.addedAt || Date.now(),
      tempo: song.tempo || undefined,
    });

    console.log(`\r${label} — done (${stems.length} stems)${' '.repeat(20)}`);
    ok++;
  } catch (err) {
    console.log(`\r${label} — FAILED: ${err.message}${' '.repeat(20)}`);
    failed++;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

console.log(`\n${ok} migrated, ${skipped} skipped, ${failed} failed`);
if (bytesBefore) {
  console.log(`Audio: ${mb(bytesBefore)} MB -> ${mb(bytesAfter)} MB (${(bytesAfter / bytesBefore * 100).toFixed(0)}%)`);
}
if (args.dryRun) console.log('(dry run — nothing was uploaded or written)');
