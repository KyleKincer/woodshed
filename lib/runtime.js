'use strict';

// Self-contained tool runtime. The app never asks the user to install anything:
//   - ffmpeg/ffprobe ship as npm-vendored static binaries (ffmpeg-static, ffprobe-static)
//   - demucs / yt-dlp / spotdl are provisioned on first run into a private,
//     uv-managed Python environment under <userData>/runtime/
//
// The demucs recipe is pinned to torch/torchaudio < 2.9 + soundfile so audio is
// saved via the self-contained libsndfile backend (no TorchCodec, no system
// FFmpeg shared libraries) — and --float32 yields true 32-bit float output.
//
// Any matching tool already on the system PATH is used as a fallback, so an
// existing manual install keeps working.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { resolveBin, augmentedPath } = require('./bins');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

// Pinned, validated recipe.
const PY_VERSION = '3.12';
const TORCH = 'torch==2.7.1';
const TORCHAUDIO = 'torchaudio==2.7.1';
const PY_TOOLS = ['soundfile', 'demucs==4.0.1', 'yt-dlp', 'spotdl'];
const PY_TOOL_BINS = ['demucs', 'yt-dlp', 'spotdl']; // executables we expect in the venv

class Runtime {
  constructor(userDataDir) {
    this.root = path.join(userDataDir, 'runtime');
    this.venvDir = path.join(this.root, 'py', '.venv');
    this.pythonsDir = path.join(this.root, 'pythons');
    this.uvDir = path.join(this.root, 'uv');
  }

  // ---- path helpers -------------------------------------------------------
  _venvBin(name) {
    const dir = IS_WIN ? path.join(this.venvDir, 'Scripts') : path.join(this.venvDir, 'bin');
    return path.join(dir, name + (PY_TOOL_BINS.includes(name) || name === 'python' ? EXE : ''));
  }
  managedPython() {
    return this._venvBin('python');
  }

  _ffmpegStatic() {
    try {
      const p = require('ffmpeg-static');
      // electron-builder may rewrite the asar path to an unpacked copy
      const real = p && p.replace('app.asar', 'app.asar.unpacked');
      return real && fs.existsSync(real) ? real : (p && fs.existsSync(p) ? p : null);
    } catch { return null; }
  }
  _ffprobeStatic() {
    try {
      const p = require('ffprobe-static').path;
      const real = p && p.replace('app.asar', 'app.asar.unpacked');
      return real && fs.existsSync(real) ? real : (p && fs.existsSync(p) ? p : null);
    } catch { return null; }
  }

  // Resolve a tool: managed/bundled first, then system PATH.
  resolveTool(name) {
    if (name === 'ffmpeg') return this._ffmpegStatic() || resolveBin('ffmpeg');
    if (name === 'ffprobe') return this._ffprobeStatic() || resolveBin('ffprobe');
    const managed = this._venvBin(name);
    if (fs.existsSync(managed)) return managed;
    return resolveBin(name);
  }

  ffmpegDir() {
    const f = this.resolveTool('ffmpeg');
    return f ? path.dirname(f) : null;
  }

  // ---- status -------------------------------------------------------------
  status() {
    const tools = {};
    for (const t of ['ffmpeg', 'ffprobe', 'demucs', 'yt-dlp', 'spotdl']) {
      const p = this.resolveTool(t);
      const managed = p && p.startsWith(this.venvDir);
      const bundled = (t === 'ffmpeg' || t === 'ffprobe') && p && p.includes('node_modules');
      tools[t] = { found: !!p, path: p, source: managed ? 'managed' : bundled ? 'bundled' : p ? 'system' : 'missing' };
    }
    const required = ['ffmpeg', 'ffprobe', 'demucs', 'yt-dlp'];
    const ready = required.every((t) => tools[t].found);
    return { tools, ready, hasSystemUv: !!resolveBin('uv') };
  }

  // ---- provisioning -------------------------------------------------------
  _run(bin, args, onLog, extraEnv) {
    return new Promise((resolve, reject) => {
      onLog(`$ ${path.basename(bin)} ${args.join(' ')}`);
      const child = spawn(bin, args, {
        env: { ...process.env, PATH: augmentedPath(), UV_PYTHON_INSTALL_DIR: this.pythonsDir, ...extraEnv },
      });
      const emit = (buf) => buf.toString().split(/\r?\n/).forEach((l) => { if (l.trim()) onLog(l.trimEnd()); });
      child.stdout.on('data', emit);
      child.stderr.on('data', emit);
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} exited with code ${code}`))));
    });
  }

  async _ensureUv(onLog) {
    const sys = resolveBin('uv');
    if (sys) { onLog(`Using uv at ${sys}`); return sys; }
    const local = path.join(this.uvDir, 'uv' + EXE);
    if (fs.existsSync(local)) return local;
    onLog('Downloading uv (Python package manager)…');
    fs.mkdirSync(this.uvDir, { recursive: true });
    const asset = uvAssetName();
    const url = `https://github.com/astral-sh/uv/releases/latest/download/${asset}`;
    const archive = path.join(this.uvDir, asset);
    await download(url, archive, onLog);
    // Extract with the system tar (bsdtar handles .tar.gz and .zip on all of
    // macOS/Linux/Windows 10+).
    await this._run('tar', ['-xf', archive, '-C', this.uvDir], onLog);
    // uv archives extract into a subdir; find the binary.
    const found = findFile(this.uvDir, 'uv' + EXE);
    if (!found) throw new Error('Could not locate uv after extraction.');
    if (!IS_WIN) fs.chmodSync(found, 0o755);
    return found;
  }

  async provision(onLog) {
    fs.mkdirSync(this.root, { recursive: true });
    const uv = await this._ensureUv(onLog);

    onLog(`Creating Python ${PY_VERSION} environment…`);
    fs.mkdirSync(path.dirname(this.venvDir), { recursive: true });
    await this._run(uv, ['venv', '--python', PY_VERSION, this.venvDir], onLog);

    const py = this.managedPython();
    const pipBase = ['pip', 'install', '--python', py];

    if (process.platform === 'darwin') {
      // macOS: default wheels include MPS (Apple GPU) support.
      onLog('Installing PyTorch + demucs + tools (this is the large step)…');
      await this._run(uv, [...pipBase, TORCH, TORCHAUDIO, ...PY_TOOLS], onLog);
    } else {
      // Windows/Linux: pull CPU-only torch from the PyTorch index to avoid the
      // multi-GB CUDA wheels, then the rest from PyPI.
      onLog('Installing CPU PyTorch…');
      await this._run(uv, [...pipBase, '--index-url', 'https://download.pytorch.org/whl/cpu', TORCH, TORCHAUDIO], onLog);
      onLog('Installing demucs + tools…');
      await this._run(uv, [...pipBase, ...PY_TOOLS], onLog);
    }

    const st = this.status();
    if (!st.ready) throw new Error('Provisioning finished but some tools are still missing: ' + JSON.stringify(st.tools));
    onLog('✓ Setup complete.');
    return st;
  }
}

// ---- platform asset + download helpers ------------------------------------
function uvAssetName() {
  const a = process.arch;
  if (process.platform === 'darwin') return a === 'arm64' ? 'uv-aarch64-apple-darwin.tar.gz' : 'uv-x86_64-apple-darwin.tar.gz';
  if (process.platform === 'win32') return a === 'arm64' ? 'uv-aarch64-pc-windows-msvc.zip' : 'uv-x86_64-pc-windows-msvc.zip';
  return a === 'arm64' ? 'uv-aarch64-unknown-linux-gnu.tar.gz' : 'uv-x86_64-unknown-linux-gnu.tar.gz';
}

async function download(url, dest, onLog) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  onLog(`Downloaded ${path.basename(dest)} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

module.exports = { Runtime };
