'use strict';

const fs = require('fs');
const path = require('path');
const { DEFAULT_SETTINGS } = require('./presets');

// Simple JSON-file persistence inside Electron's userData dir. Library audio
// lives under <userData>/media/<songId>/.
class Store {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.mediaDir = path.join(userDataDir, 'media');
    this.settingsPath = path.join(userDataDir, 'settings.json');
    this.libraryPath = path.join(userDataDir, 'library.json');
    fs.mkdirSync(this.mediaDir, { recursive: true });
  }

  _readJSON(p, fallback) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return fallback;
    }
  }

  _writeJSON(p, data) {
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, p);
  }

  getSettings() {
    const saved = this._readJSON(this.settingsPath, {});
    // Deep-ish merge so new defaults appear for existing installs.
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      custom: { ...DEFAULT_SETTINGS.custom, ...(saved.custom || {}) },
    };
  }

  saveSettings(settings) {
    this._writeJSON(this.settingsPath, settings);
    return this.getSettings();
  }

  getLibrary() {
    const lib = this._readJSON(this.libraryPath, { songs: [] });
    // Sort newest first.
    lib.songs.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return lib;
  }

  _writeLibrary(lib) {
    this._writeJSON(this.libraryPath, lib);
  }

  addSong(song) {
    const lib = this._readJSON(this.libraryPath, { songs: [] });
    lib.songs.push(song);
    this._writeLibrary(lib);
    return song;
  }

  updateSong(id, patch) {
    const lib = this._readJSON(this.libraryPath, { songs: [] });
    const idx = lib.songs.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    lib.songs[idx] = { ...lib.songs[idx], ...patch };
    this._writeLibrary(lib);
    return lib.songs[idx];
  }

  deleteSong(id) {
    const lib = this._readJSON(this.libraryPath, { songs: [] });
    const song = lib.songs.find((s) => s.id === id);
    lib.songs = lib.songs.filter((s) => s.id !== id);
    this._writeLibrary(lib);
    if (song) {
      const songDir = path.join(this.mediaDir, id);
      try {
        fs.rmSync(songDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    return true;
  }

  songDir(id) {
    return path.join(this.mediaDir, id);
  }
}

module.exports = { Store };
