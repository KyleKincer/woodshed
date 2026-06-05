'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { augmentedPath } = require('./bins');
const { resolveQuality, STEM_MODES } = require('./presets');

const AUDIO_EXT = /\.(mp3|wav|flac|m4a|aac|ogg|opus|aiff?|wma|webm)$/i;

// Stem filenames Demucs produces, by mode.
function expectedStems(stemMode, model) {
  if (stemMode === 'full') {
    if (model === 'htdemucs_6s') {
      return ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];
    }
    return ['drums', 'bass', 'other', 'vocals'];
  }
  const focus = STEM_MODES[stemMode]?.twoStems || 'drums';
  return [focus, `no_${focus}`];
}

// Lines that are just tqdm progress redraws — useless in an error report.
const NOISE = /\d+%\||seconds\/s|^[\s|█▏▎▍▌▋▊▉#=>.\-]*$/;

function run(bin, args, { onLine, onSpawn, env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, PATH: augmentedPath(), PYTHONUNBUFFERED: '1', ...env },
    });
    if (onSpawn) onSpawn(child);
    const meaningful = []; // keep real (non-progress) output for error reporting
    const handle = (buf) => {
      const text = buf.toString();
      text.split(/[\r\n]/).forEach((line) => {
        const t = line.trim();
        if (!t) return;
        if (onLine) onLine(t);
        if (!NOISE.test(t)) {
          meaningful.push(t);
          if (meaningful.length > 40) meaningful.shift();
        }
      });
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else {
        const detail = meaningful.slice(-20).join('\n') || '(no error output captured)';
        reject(new Error(`${path.basename(bin)} exited with code ${code}\n${detail}`));
      }
    });
  });
}

function ffprobeDuration(ffprobe, file) {
  if (!ffprobe) return 0;
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      ffprobe,
      ['-v', 'quiet', '-print_format', 'json', '-show_format', file],
      { encoding: 'utf8', env: { ...process.env, PATH: augmentedPath() } }
    );
    return Math.round(parseFloat(JSON.parse(out).format?.duration) || 0);
  } catch {
    return 0;
  }
}

// Turn known cryptic tool errors into actionable messages.
function friendlyError(msg) {
  if (/TorchCodec is required|torchcodec/i.test(msg)) {
    return 'Demucs can\'t save audio because TorchCodec is missing from its environment.\n\nFix it with:\n  pipx inject demucs torchcodec\n\n(Then click Recheck.)\n\n— original error —\n' + msg;
  }
  if (/ffmpeg/i.test(msg) && /not found|No such file/i.test(msg)) {
    return 'ffmpeg is required. Install it:\n  brew install ffmpeg\n\n— original error —\n' + msg;
  }
  return msg;
}

// Classify a raw text input into a source descriptor.
function classifyInput(text) {
  const t = text.trim();
  if (/open\.spotify\.com|spotify:/i.test(t)) return { type: 'spotify', value: t };
  if (/^https?:\/\//i.test(t)) return { type: 'url', value: t };
  return { type: 'search', value: t };
}

class Processor {
  constructor(store, emit, runtime) {
    this.store = store;
    this.emit = emit;
    this.runtime = runtime;
    this.queue = [];
    this.busy = false;
    this.current = null; // { job, child, canceled }
  }

  tool(name) { return this.runtime.resolveTool(name); }

  enqueue(job) {
    this.queue.push(job);
    this.emit('process:queued', { jobId: job.jobId, label: job.label });
    this._drain();
  }

  // Cancel a queued or in-progress job.
  cancel(jobId) {
    if (this.current && this.current.job.jobId === jobId) {
      this.current.canceled = true;
      if (this.current.child) {
        try { this.current.child.kill('SIGKILL'); } catch {}
      }
      return true;
    }
    const idx = this.queue.findIndex((j) => j.jobId === jobId);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
      this.emit('process:canceled', { jobId });
      return true;
    }
    return false;
  }

  // Wrapper that records the spawned child so cancel() can kill it, and makes
  // sure the bundled ffmpeg is discoverable on PATH for demucs/yt-dlp.
  _run(bin, args, opts = {}) {
    const ffDir = this.runtime.ffmpegDir();
    const env = ffDir ? { PATH: `${ffDir}${path.delimiter}${augmentedPath()}` } : {};
    return run(bin, args, {
      ...opts,
      env: { ...env, ...(opts.env || {}) },
      onSpawn: (child) => { if (this.current) this.current.child = child; },
    });
  }

  async _drain() {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    this.current = { job, child: null, canceled: false };
    try {
      const song = await this._process(job);
      this.emit('process:done', { jobId: job.jobId, song });
    } catch (err) {
      if (this.current && this.current.canceled) {
        this.emit('process:canceled', { jobId: job.jobId });
      } else {
        this.emit('process:error', { jobId: job.jobId, error: friendlyError(String(err.message || err)) });
      }
    } finally {
      this.current = null;
      this.busy = false;
      this._drain();
    }
  }

  _progress(jobId, stage, percent, message) {
    this.emit('process:progress', { jobId, stage, percent, message });
  }

  // ---- audio acquisition --------------------------------------------------

  async _ytdlpDownload(jobId, target, tmpDir, stageMsg) {
    const ytdlp = this.tool('yt-dlp');
    if (!ytdlp) throw new Error('yt-dlp is not available.');
    this._progress(jobId, 'download', 0, stageMsg || 'Starting download…');
    const outTmpl = path.join(tmpDir, '%(title)s.%(ext)s');
    const ffDir = this.runtime.ffmpegDir();
    await this._run(
      ytdlp,
      [
        '--no-playlist',
        '-f', 'bestaudio/best',
        '-x', '--audio-format', 'wav', '--audio-quality', '0',
        ...(ffDir ? ['--ffmpeg-location', ffDir] : []),
        '--write-info-json', '--write-thumbnail', '--convert-thumbnails', 'jpg',
        '--progress', '--newline',
        '-o', outTmpl,
        target,
      ],
      {
        onLine: (line) => {
          const m = line.match(/(\d{1,3}(?:\.\d+)?)%/);
          if (m && /\[download\]/.test(line)) {
            this._progress(jobId, 'download', parseFloat(m[1]), stageMsg || 'Downloading audio…');
          }
        },
      }
    );
    const wav = fs.readdirSync(tmpDir).find((f) => f.endsWith('.wav'));
    if (!wav) throw new Error('No audio could be downloaded.');
    return this._collectDownloadMeta(tmpDir, wav);
  }

  _collectDownloadMeta(tmpDir, wav) {
    const audioPath = path.join(tmpDir, wav);
    const base = path.basename(wav, '.wav');
    let meta = {};
    const infoFile = fs.readdirSync(tmpDir).find((f) => f.endsWith('.info.json'));
    if (infoFile) {
      try { meta = JSON.parse(fs.readFileSync(path.join(tmpDir, infoFile), 'utf8')); } catch {}
    }
    const thumbFile = fs.readdirSync(tmpDir).find((f) => /\.(jpg|jpeg|png|webp)$/i.test(f));
    return {
      audioPath,
      base,
      title: meta.title || base,
      uploader: meta.uploader || meta.channel || '',
      duration: meta.duration || ffprobeDuration(this.tool('ffprobe'), audioPath),
      thumbSrc: thumbFile ? path.join(tmpDir, thumbFile) : null,
    };
  }

  async _acquireFile(jobId, filePath, tmpDir) {
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    const base = path.basename(filePath, path.extname(filePath));
    let audioPath = filePath;
    // Normalise non-WAV inputs to WAV so the soundfile backend can read them
    // regardless of which audio libraries demucs was built against.
    if (!/\.wav$/i.test(filePath)) {
      this._progress(jobId, 'download', 20, 'Converting to WAV…');
      const ffmpeg = this.tool('ffmpeg');
      if (!ffmpeg) throw new Error('ffmpeg is not available.');
      const out = path.join(tmpDir, `${base}.wav`);
      await this._run(ffmpeg, ['-y', '-i', filePath, '-vn', out]);
      audioPath = out;
    }
    this._progress(jobId, 'download', 100, 'Ready');
    return {
      audioPath,
      base,
      title: base,
      uploader: 'Local file',
      duration: ffprobeDuration(this.tool('ffprobe'), audioPath),
      thumbSrc: null,
    };
  }

  async _acquireSearch(jobId, query, tmpDir) {
    return this._ytdlpDownload(jobId, `ytsearch1:${query}`, tmpDir, `Searching: ${query}`);
  }

  async _acquireSpotify(jobId, url, tmpDir) {
    const spotdl = this.tool('spotdl');
    if (spotdl) {
      this._progress(jobId, 'download', 0, 'Fetching from Spotify via spotdl…');
      const ffDir = this.runtime.ffmpegDir();
      await this._run(spotdl, ['download', url, ...(ffDir ? ['--ffmpeg', this.tool('ffmpeg')] : []), '--output', path.join(tmpDir, '{artists} - {title}.{output-ext}')], {
        onLine: (line) => {
          if (/Downloaded/i.test(line)) this._progress(jobId, 'download', 90, 'Downloaded from Spotify…');
          else if (/Processing|Found/i.test(line)) this._progress(jobId, 'download', 40, 'Matching track…');
        },
      });
      const audio = fs.readdirSync(tmpDir).find((f) => AUDIO_EXT.test(f));
      if (!audio) throw new Error('spotdl produced no audio (is the link a single track?).');
      const audioPath = path.join(tmpDir, audio);
      return {
        audioPath,
        base: path.basename(audio, path.extname(audio)),
        title: path.basename(audio, path.extname(audio)),
        uploader: 'Spotify → YouTube match',
        duration: ffprobeDuration(this.tool('ffprobe'), audioPath),
        thumbSrc: null,
      };
    }
    // Fallback: resolve the track name via Spotify oEmbed, then search YouTube.
    this._progress(jobId, 'download', 0, 'Resolving Spotify track…');
    let query = null;
    try {
      const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      query = data.title;
    } catch {}
    if (!query) {
      throw new Error('Could not resolve this Spotify link (spotdl unavailable and metadata lookup failed).');
    }
    const got = await this._ytdlpDownload(jobId, `ytsearch1:${query}`, tmpDir, `Spotify match: ${query}`);
    got.uploader = 'Spotify → YouTube match';
    return got;
  }

  // ---- main pipeline ------------------------------------------------------

  async _process(job) {
    const { jobId, source, settings } = job;
    const demucs = this.tool('demucs');
    if (!demucs) throw new Error('demucs is not available — finish setup first.');

    const quality = resolveQuality(settings);
    const stemMode = settings.stemMode || 'full';
    // Reprocessing targets an existing song id and updates it in place.
    const replaceId = job.replaceId || null;
    const existing = replaceId ? this.store.getLibrary().songs.find((s) => s.id === replaceId) : null;
    const id = replaceId || ('song_' + jobId.replace(/[^a-z0-9_]/gi, ''));
    const songDir = this.store.songDir(id);
    fs.mkdirSync(songDir, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-'));
    let ok = false;

    try {
      // 1. Acquire audio (download / file / search / spotify)
      let acq;
      if (source.type === 'file') acq = await this._acquireFile(jobId, source.value, tmpDir);
      else if (source.type === 'search') acq = await this._acquireSearch(jobId, source.value, tmpDir);
      else if (source.type === 'spotify') acq = await this._acquireSpotify(jobId, source.value, tmpDir);
      else acq = await this._ytdlpDownload(jobId, source.value, tmpDir, 'Downloading audio…');

      // Copy thumbnail into the song dir if we got one; otherwise keep any existing one.
      let thumb = existing?.thumb || null;
      if (acq.thumbSrc) {
        const ext = path.extname(acq.thumbSrc);
        try { fs.copyFileSync(acq.thumbSrc, path.join(songDir, `cover${ext}`)); thumb = `cover${ext}`; } catch {}
      }

      // 2. Separate with Demucs
      const stems = await this._separate(jobId, acq.audioPath, acq.base, songDir, quality, stemMode, settings);

      let song;
      if (replaceId) {
        // Preserve the user's title and original add date; swap in new stems/settings.
        song = this.store.updateSong(id, { duration: acq.duration, source, thumb, stems, stemMode, quality });
      } else {
        song = {
          id, title: acq.title, uploader: acq.uploader, duration: acq.duration,
          source, thumb, stems, stemMode, quality, addedAt: job.addedAt,
        };
        this.store.addSong(song);
      }
      this._progress(jobId, 'finalize', 100, 'Done');
      ok = true;
      return song;
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      // Clean up a partial dir only for *new* songs — never destroy an existing
      // song's media when a reprocess fails.
      if (!ok && !replaceId) { try { fs.rmSync(songDir, { recursive: true, force: true }); } catch {} }
    }
  }

  async _separate(jobId, audioPath, base, songDir, quality, stemMode, settings) {
    const demucs = this.tool('demucs');
    this._progress(jobId, 'separate', 0, 'Loading model…');
    const demucsOut = path.join(songDir, '_sep');
    const args = ['-n', quality.model, '--shifts', String(quality.shifts), '--overlap', String(quality.overlap), '-o', demucsOut];
    if (quality.format === 'float32') args.push('--float32');
    else if (quality.format === 'int24') args.push('--int24');
    const twoStems = STEM_MODES[stemMode]?.twoStems;
    if (twoStems) args.push(`--two-stems=${twoStems}`);
    if (settings.device && settings.device !== 'auto') args.push('-d', settings.device);
    args.push(audioPath);

    const modelCount = quality.model === 'htdemucs_ft' ? 4 : 1;
    const totalPasses = modelCount * Math.max(1, quality.shifts || 1);
    let lastBar = 0, passesDone = 0;
    await this._run(demucs, args, {
      onLine: (line) => {
        const m = line.match(/(\d{1,3})%\|/);
        if (m) {
          const bar = parseInt(m[1], 10);
          if (bar < lastBar - 10) passesDone += 1;
          lastBar = bar;
          const overall = Math.min(99, ((passesDone + bar / 100) / totalPasses) * 100);
          this._progress(jobId, 'separate', overall, `Separating stems… (pass ${Math.min(passesDone + 1, totalPasses)}/${totalPasses})`);
        } else if (/Separating track/i.test(line)) {
          this._progress(jobId, 'separate', 1, 'Separating stems…');
        }
      },
    });

    this._progress(jobId, 'finalize', 95, 'Saving stems…');
    const sepBase = path.join(demucsOut, quality.model, base);
    const wanted = expectedStems(stemMode, quality.model);
    // Stage into *.wav.new first, then swap, so a reprocess never destroys the
    // existing stems until the new set is fully in place.
    const staged = [];
    for (const stem of wanted) {
      const src = path.join(sepBase, `${stem}.wav`);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(songDir, `${stem}.wav.new`));
        staged.push(stem);
      }
    }
    if (!staged.length) { try { fs.rmSync(demucsOut, { recursive: true, force: true }); } catch {} ; throw new Error('Demucs produced no stems.'); }
    // Remove any previous stems, then promote the staged ones.
    for (const f of fs.readdirSync(songDir)) {
      if (f.endsWith('.wav')) { try { fs.rmSync(path.join(songDir, f)); } catch {} }
    }
    const stems = staged.map((stem) => {
      fs.renameSync(path.join(songDir, `${stem}.wav.new`), path.join(songDir, `${stem}.wav`));
      return { name: stem, file: `${stem}.wav` };
    });
    try { fs.rmSync(demucsOut, { recursive: true, force: true }); } catch {}
    return stems;
  }
}

module.exports = { Processor, classifyInput };
