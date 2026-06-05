'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// GUI apps on macOS launch with a minimal PATH that usually omits Homebrew and
// pipx locations, so we can't rely on `process.env.PATH`. We probe the common
// install dirs explicitly, and also ask a login shell for the user's real PATH.
const HOME = os.homedir();
const COMMON_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  path.join(HOME, '.local', 'bin'),
  path.join(HOME, 'bin'),
  path.join(HOME, '.pyenv', 'shims'),
  path.join(HOME, 'Library', 'Python', '3.11', 'bin'),
  path.join(HOME, 'Library', 'Python', '3.12', 'bin'),
  path.join(HOME, 'Library', 'Python', '3.13', 'bin'),
  '/opt/homebrew/opt/python/libexec/bin',
];

let loginPathDirs = null;
function getLoginShellPathDirs() {
  if (loginPathDirs) return loginPathDirs;
  loginPathDirs = [];
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shell, ['-l', '-i', '-c', 'echo "$PATH"'], {
      encoding: 'utf8',
      timeout: 4000,
    });
    loginPathDirs = out.trim().split(':').filter(Boolean);
  } catch {
    loginPathDirs = [];
  }
  return loginPathDirs;
}

function candidateDirs() {
  const fromEnv = (process.env.PATH || '').split(':').filter(Boolean);
  return Array.from(new Set([...fromEnv, ...getLoginShellPathDirs(), ...COMMON_DIRS]));
}

/** Resolve an executable to an absolute path, or null if not found. */
function resolveBin(name) {
  for (const dir of candidateDirs()) {
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Build a PATH string that includes everything we know about. */
function augmentedPath() {
  return candidateDirs().join(':');
}

/** Check tools; returns { key: {found, path, bin, optional} }. */
function checkDeps() {
  const tools = {
    ytdlp: { bin: 'yt-dlp', optional: false },
    demucs: { bin: 'demucs', optional: false },
    ffmpeg: { bin: 'ffmpeg', optional: false },
    spotdl: { bin: 'spotdl', optional: true }, // only needed for Spotify links
  };
  const result = {};
  for (const [key, { bin, optional }] of Object.entries(tools)) {
    const p = resolveBin(bin);
    result[key] = { found: !!p, path: p, bin, optional };
  }
  return result;
}

module.exports = { resolveBin, augmentedPath, checkDeps };
