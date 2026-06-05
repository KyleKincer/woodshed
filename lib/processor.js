'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { resolveBin, augmentedPath } = require('./bins');
const { resolveQuality, STEM_MODES } = require('./presets');

// Stem filenames Demucs produces, by mode.
function expectedStems(stemMode, model) {
  if (stemMode === 'full') {
    if (model === 'htdemucs_6s') {
      return ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];
    }
    return ['drums', 'bass', 'other', 'vocals'];
  }
  // two-stem modes -> the isolated stem + its complement
  const focus = STEM_MODES[stemMode]?.twoStems || 'drums';
  return [focus, `no_${focus}`];
}

function run(bin, args, { onLine, env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, PATH: augmentedPath(), PYTHONUNBUFFERED: '1', ...env },
    });
    let stderrTail = '';
    const handle = (buf) => {
      const text = buf.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      // tqdm / yt-dlp use \r to redraw; split on both.
      text.split(/[\r\n]/).forEach((line) => {
        const t = line.trim();
        if (t && onLine) onLine(t);
      });
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(bin)} exited with code ${code}\n${stderrTail}`));
    });
  });
}

// Processor runs one job at a time from a queue and emits progress events.
class Processor {
  constructor(store, emit) {
    this.store = store;
    this.emit = emit; // (channel, payload) => void
    this.queue = [];
    this.busy = false;
  }

  enqueue(job) {
    this.queue.push(job);
    this.emit('process:queued', { jobId: job.jobId, url: job.url });
    this._drain();
  }

  async _drain() {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    try {
      const song = await this._process(job);
      this.emit('process:done', { jobId: job.jobId, song });
    } catch (err) {
      this.emit('process:error', { jobId: job.jobId, error: String(err.message || err) });
    } finally {
      this.busy = false;
      this._drain();
    }
  }

  _progress(jobId, stage, percent, message) {
    this.emit('process:progress', { jobId, stage, percent, message });
  }

  async _process(job) {
    const { jobId, url, settings } = job;
    const ytdlp = resolveBin('yt-dlp');
    const demucs = resolveBin('demucs');
    if (!ytdlp) throw new Error('yt-dlp not found. Install it (brew install yt-dlp).');
    if (!demucs) throw new Error('demucs not found. Install it (pipx install demucs).');

    const quality = resolveQuality(settings);
    const stemMode = settings.stemMode || 'full';

    const id = 'song_' + jobId;
    const songDir = this.store.songDir(id);
    fs.mkdirSync(songDir, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-'));

    try {
      // ---- 1. Download best audio + metadata ----------------------------
      this._progress(jobId, 'download', 0, 'Starting download…');
      const outTmpl = path.join(tmpDir, '%(title)s.%(ext)s');
      await run(
        ytdlp,
        [
          '--no-playlist',
          '-f', 'bestaudio/best',
          '-x', '--audio-format', 'wav',
          '--audio-quality', '0',
          '--write-info-json',
          '--write-thumbnail', '--convert-thumbnails', 'jpg',
          '--progress', '--newline',
          '-o', outTmpl,
          url,
        ],
        {
          onLine: (line) => {
            const m = line.match(/(\d{1,3}(?:\.\d+)?)%/);
            if (m && /\[download\]/.test(line)) {
              this._progress(jobId, 'download', parseFloat(m[1]), 'Downloading audio…');
            }
          },
        }
      );

      const wav = fs.readdirSync(tmpDir).find((f) => f.endsWith('.wav'));
      if (!wav) throw new Error('Download produced no audio.');
      const wavPath = path.join(tmpDir, wav);
      const base = path.basename(wav, '.wav');

      // Metadata from the info json
      let meta = {};
      const infoFile = fs.readdirSync(tmpDir).find((f) => f.endsWith('.info.json'));
      if (infoFile) {
        try {
          meta = JSON.parse(fs.readFileSync(path.join(tmpDir, infoFile), 'utf8'));
        } catch { /* ignore */ }
      }

      // Thumbnail -> song dir
      let thumb = null;
      const thumbFile = fs.readdirSync(tmpDir).find((f) => /\.(jpg|jpeg|png|webp)$/i.test(f));
      if (thumbFile) {
        const ext = path.extname(thumbFile);
        thumb = `cover${ext}`;
        try {
          fs.copyFileSync(path.join(tmpDir, thumbFile), path.join(songDir, thumb));
        } catch { thumb = null; }
      }

      // ---- 2. Separate with Demucs --------------------------------------
      this._progress(jobId, 'separate', 0, 'Loading model…');
      const demucsOut = path.join(tmpDir, 'separated');
      const args = ['-n', quality.model, '--shifts', String(quality.shifts), '--overlap', String(quality.overlap), '-o', demucsOut];
      if (quality.format === 'float32') args.push('--float32');
      else if (quality.format === 'int24') args.push('--int24');
      const twoStems = STEM_MODES[stemMode]?.twoStems;
      if (twoStems) args.push(`--two-stems=${twoStems}`);
      if (settings.device && settings.device !== 'auto') args.push('-d', settings.device);
      args.push(wavPath);

      // Demucs (htdemucs_ft) is a bag of N models, each repeated `shifts` times,
      // and it prints one tqdm bar per pass. Count finished bars for a coarse
      // overall percentage.
      const modelCount = quality.model === 'htdemucs_ft' ? 4 : 1;
      const totalPasses = modelCount * Math.max(1, quality.shifts || 1);
      let lastBar = 0;
      let passesDone = 0;
      await run(demucs, args, {
        onLine: (line) => {
          const m = line.match(/(\d{1,3})%\|/);
          if (m) {
            const bar = parseInt(m[1], 10);
            if (bar < lastBar - 10) passesDone += 1; // bar wrapped -> a pass finished
            lastBar = bar;
            const overall = Math.min(99, ((passesDone + bar / 100) / totalPasses) * 100);
            this._progress(jobId, 'separate', overall, `Separating stems… (pass ${Math.min(passesDone + 1, totalPasses)}/${totalPasses})`);
          } else if (/Separating track/i.test(line)) {
            this._progress(jobId, 'separate', 1, 'Separating stems…');
          }
        },
      });

      // ---- 3. Collect stems into the song dir ---------------------------
      this._progress(jobId, 'finalize', 95, 'Saving stems…');
      // demucs writes to <out>/<model>/<base>/<stem>.wav
      const sepBase = path.join(demucsOut, quality.model, base);
      const wanted = expectedStems(stemMode, quality.model);
      const stems = [];
      for (const stem of wanted) {
        const src = path.join(sepBase, `${stem}.wav`);
        if (fs.existsSync(src)) {
          const dest = `${stem}.wav`;
          fs.copyFileSync(src, path.join(songDir, dest));
          stems.push({ name: stem, file: dest });
        }
      }
      if (!stems.length) throw new Error('Demucs produced no stems.');

      const song = {
        id,
        title: meta.title || base,
        uploader: meta.uploader || meta.channel || '',
        duration: meta.duration || 0,
        url,
        thumb,
        stems,
        stemMode,
        quality,
        addedAt: job.addedAt,
      };
      this.store.addSong(song);
      this._progress(jobId, 'finalize', 100, 'Done');
      return song;
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

module.exports = { Processor };
