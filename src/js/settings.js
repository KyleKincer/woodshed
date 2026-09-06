// Renders the Settings view: quality presets (+ custom knobs), stem layout,
// delivery format, and the local stem cache. Persists on every change.

import * as backend from './backend.js';
import { localRequest, legacyLibraries, importLegacy } from './companion.js';
import { exportLibrary } from './export.js';
import { clearStemCache, stemCacheSize } from './stemcache.js';

import { notify, withButtonProgress } from './feedback.js';
import { version as webVersion } from '../../package.json';

let config = null;

export function initSettings(cfg) {
  config = cfg;
}

function fmtBytes(n) {
  if (!n) return '0 MB';
  const mb = n / 1e6;
  return mb >= 1000 ? `${(mb / 1000).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

export function renderSettings() {
  const root = document.getElementById('settings-root');
  const s = config.settings;
  const presets = ['fast', 'balanced', 'studio'].map(id => config.presets[id]);
  const effective = config.presets[s.preset] || s.custom;
  const presetIndex = Math.max(0, presets.findIndex(p => p.id === s.preset));

  root.innerHTML = `
    <section class="settings-section" aria-labelledby="song-defaults-title">
      <h2 id="song-defaults-title">Song defaults</h2>
      <p class="desc">Applied to new songs. You can choose a different quality or stem layout for each song.</p>
      <h3>Separation quality</h3>
      <p class="hint">Higher quality takes longer to process on your computer.</p>
      <div class="quality-heading"><label for="quality-preset">Quality preset</label><span id="quality-label">${s.preset === 'custom' ? 'Custom' : effective.label}</span></div>
      <input type="range" id="quality-preset" min="0" max="2" step="1" value="${presetIndex}" aria-valuetext="${s.preset === 'custom' ? 'Custom — choose a preset to reset' : effective.label}" />
      <div class="preset-labels">${presets.map((p, i) => `<button type="button" data-preset-index="${i}" aria-pressed="${s.preset === p.id}">${p.label}</button>`).join('')}</div>
      <p class="hint" id="quality-description">${s.preset === 'custom' ? 'Using your advanced parameters. Choose a preset to reset them.' : effective.description}</p>
    <details class="settings-subsection" id="custom-section" ${s.preset === 'custom' ? 'open' : ''}>
      <summary>Advanced</summary>

      <div class="row">
        <div><label for="c-model">Model</label><div class="sub">More accurate, but slower.</div></div>
        <select id="c-model" aria-label="Model">
          ${config.models.map((m) => `<option value="${m.id}" ${effective.model === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}
        </select>
      </div>
      <div class="row">
        <div><label for="c-shifts">Quality passes</label><div class="sub">Higher values take longer to process.</div></div>
        <div class="range-wrap">
          <input type="range" id="c-shifts" aria-label="Quality passes" min="0" max="10" step="1" value="${effective.shifts}" />
          <span id="c-shifts-val">${effective.shifts}</span>
        </div>
      </div>
      <div class="row">
        <div><label for="c-overlap">Overlap</label><div class="sub">Usually leave at the default.</div></div>
        <div class="range-wrap">
          <input type="range" id="c-overlap" aria-label="Overlap" min="0.1" max="0.75" step="0.05" value="${effective.overlap}" />
          <span id="c-overlap-val">${effective.overlap}</span>
        </div>
      </div>
    </details>

    <div class="settings-subsection">
      <h3>Stems &amp; audio</h3>

      <div class="row">
        <div><label for="s-stemmode">Stem layout</label></div>
        <select id="s-stemmode" aria-label="Stem layout">
          ${Object.values(config.stemModes).map((m) => `<option value="${m.id}" ${s.stemMode === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}
        </select>
      </div>
    </div>

    <div class="settings-subsection">
      <p class="hint">Synced stems use compressed Opus audio. Original WAV stems stay on the computer that processed them.</p>
      <div class="row " id="bitrate-row">
        <div><label for="s-bitrate">Sync bitrate</label><div class="sub">Per stem. Higher bitrates use more cloud storage.</div></div>
        <select id="s-bitrate" aria-label="Bitrate">
          ${config.bitrates.map((b) => `<option value="${b.id}" ${Number(s.bitrate) === b.id ? 'selected' : ''}>${b.label}</option>`).join('')}
        </select>
      </div>
      <p class="hint">Changing this affects newly processed songs. Reprocess a song to convert it.</p>
    </div>

    </section>

    <section class="settings-section" aria-labelledby="version-title">
      <h2 id="version-title">App Version</h2>
      <p class="desc" id="app-version">${window.woodshedDesktop ? 'Loading version…' : `Web app · ${webVersion}`}</p>
      ${window.woodshedDesktop ? '<div class="settings-actions"><button class="btn-ghost" id="desktop-updates">Check for updates</button></div>' : '<p class="hint">The web app updates automatically.</p>'}
    </section>

    <section class="settings-section" aria-labelledby="storage-title">
      <h2 id="storage-title">Storage &amp; plan</h2>
      <p class="desc" id="cloud-usage" role="status">Loading storage usage…</p>
      <meter id="storage-meter" class="storage-meter hidden" min="0" max="1" value="0" aria-label="Cloud storage used"></meter>
      <p class="hint">Cloud usage includes pending uploads.</p>
      <div class="settings-actions"><button class="btn-ghost" id="settings-upgrade">Plan &amp; billing</button></div>
      <div class="row cache-row">
        <div><h3>Playback cache</h3><p class="hint">Audio saved on this device for faster playback. Clearing it keeps your library and original files.</p><p class="hint" id="cache-size">Measuring…</p></div>
        <button class="btn-ghost" id="cache-clear">Clear cache</button>
      </div>
    </section>

    <section class="settings-section" aria-labelledby="library-management-title">
      <h2 id="library-management-title">Library management</h2>
      <div class="management-item">
        <h3>Synced library archive</h3>
        <p class="desc">Download a ZIP with synced audio, cover art, song metadata, practice settings, and your song defaults. Original audio files are exported separately.</p>
        <div class="settings-actions"><button class="btn-ghost" id="export-library">Export synced library ZIP</button></div>
      </div>
      <div class="management-item">
        <h3>Original audio files</h3>
        <p class="desc">Copy locally stored source audio and stems (WAV and FLAC) to an export folder in Downloads on the computer that processed them. Requires Woodshed for desktop on that computer.</p>
        <div class="settings-actions"><button class="btn-ghost" id="export-originals" ${window.woodshedDesktop ? '' : 'disabled'}>Export original audio files</button></div>
      </div>
      <details class="management-item">
        <summary>Import an old Woodshed library</summary>
        <p class="desc">Import songs from a previous installation on this computer. Existing files are preserved. Requires Woodshed for desktop.</p>
        <label for="legacy-dir">Old library data directory <span class="hint">(optional)</span></label>
        <input id="legacy-dir" type="text" placeholder="Leave blank to detect automatically" aria-describedby="legacy-hint" ${window.woodshedDesktop ? '' : 'disabled'} />
        <p class="hint" id="legacy-hint">If more than one library is found, enter the full path to the one you want.</p>
        <div class="settings-actions"><button class="btn-ghost" id="import-legacy" ${window.woodshedDesktop ? '' : 'disabled'}>Import old library</button></div>
      </details>
    </section>
  `;
  if (window.woodshedDesktop) {
    const version = root.querySelector('#app-version');
    window.woodshedDesktop.info().then(info => {
      version.textContent = `Version ${info.version}`;
    }).catch(() => { version.textContent = 'Version unavailable'; });
    root.querySelector('#desktop-updates').onclick = event => withButtonProgress(
      event.currentTarget, 'Checking for updates…', () => window.woodshedDesktop.update('show'),
    );
  }
  root.querySelector('#import-legacy').onclick = event => withButtonProgress(
    event.currentTarget, 'Importing library…', async () => {
      let directory = root.querySelector('#legacy-dir').value.trim();
      if (!directory) {
        const found = await legacyLibraries();
        if (found.length !== 1) throw new Error(found.length ? 'More than one library found. Enter the full directory path to import.' : 'No old library detected. Enter its data directory.');
        directory = found[0].directory;
      }
      const result = await importLegacy(directory);
      notify(`Queued ${result.count} songs. Existing files are preserved.${result.remaining ? ` Import again after these finish for ${result.remaining} remaining songs.` : ''}`);
    },
  );
  root.querySelector('#settings-upgrade').onclick = () => document.dispatchEvent(new Event('woodshed:billing'));
  const usage = root.querySelector('#cloud-usage');
  backend.cloudUsage().then(u => {
    usage.textContent = `${fmtBytes(u.usedBytes)} of ${fmtBytes(u.limitBytes)} used${u.appFull ? '. Cloud uploads are paused; playback and export remain available.' : '.'}`;
    const meter = root.querySelector('#storage-meter');
    meter.max = Math.max(1, u.limitBytes); meter.value = u.usedBytes; meter.classList.remove('hidden');
  }).catch(error => { usage.textContent = error.message; });
  root.querySelector('#export-originals').onclick = event => withButtonProgress(
    event.currentTarget, 'Exporting originals…', async () => {
      const result = await localRequest('/export-originals', {});
      notify(`Exported ${result.count} files to ${result.directory}`);
    },
  );
  root.querySelector('#export-library').onclick = event => withButtonProgress(
    event.currentTarget, 'Preparing export…', async progress => {
      await exportLibrary(progress);
      notify('Library export downloaded.');
    },
  );
  wireSettings();
  refreshCacheSize();
}

async function refreshCacheSize() {
  const el = document.getElementById('cache-size');
  if (!el) return;
  try { el.textContent = fmtBytes(await stemCacheSize()); }
  catch { el.textContent = 'Unavailable in this browser'; }
}

// Serialize snapshots so a slow save cannot overwrite a more recent choice.
let saveQueue = Promise.resolve();
function persist() {
  const snapshot = structuredClone(config.settings);
  saveQueue = saveQueue.then(() => backend.saveSettings(snapshot)).catch(error => {
    notify(`Could not save changes: ${error.message}. Change the setting again to retry.`, { error: true });
  });
  return saveQueue;
}

function wireSettings() {
  const s = config.settings;
  const presets = ['fast', 'balanced', 'studio'].map(id => config.presets[id]);
  const slider = document.getElementById('quality-preset');
  const updateQuality = () => {
    const preset = config.presets[s.preset];
    const effective = preset || s.custom;
    document.getElementById('quality-label').textContent = preset?.label || 'Custom';
    document.getElementById('quality-description').textContent = preset?.description || 'Using your advanced parameters. Choose a preset to reset them.';
    slider.setAttribute('aria-valuetext', preset?.label || 'Custom — choose a preset to reset');
    slider.classList.toggle('is-custom', !preset);
    document.querySelectorAll('[data-preset-index]').forEach(button => {
      button.setAttribute('aria-pressed', String(presets[button.dataset.presetIndex].id === s.preset));
    });
    document.getElementById('c-model').value = effective.model;
    for (const key of ['shifts', 'overlap']) {
      document.getElementById(`c-${key}`).value = effective[key];
      document.getElementById(`c-${key}-val`).textContent = effective[key];
    }
  };
  const choosePreset = index => {
    const preset = presets[index];
    s.preset = preset.id;
    s.custom = { model: preset.model, shifts: preset.shifts, overlap: preset.overlap };
    slider.value = index;
    updateQuality();
    persist();
  };
  slider.oninput = event => choosePreset(Number(event.target.value));
  document.querySelectorAll('[data-preset-index]').forEach(button => {
    button.onclick = () => choosePreset(Number(button.dataset.presetIndex));
  });
  const bind = (id, handler) => { const el = document.getElementById(id); if (el) el.oninput = handler; };
  for (const key of ['model', 'shifts', 'overlap']) {
    bind(`c-${key}`, event => {
      const effective = config.presets[s.preset] || s.custom;
      s.custom = { model: effective.model, shifts: effective.shifts, overlap: effective.overlap };
      s.custom[key] = key === 'model' ? event.target.value : Number(event.target.value);
      s.preset = 'custom';
      updateQuality();
      persist();
    });
  }
  updateQuality();
  bind('s-stemmode', (e) => { s.stemMode = e.target.value; persist(); });
  bind('s-bitrate', (e) => { s.bitrate = parseInt(e.target.value, 10); persist(); });

  const clearBtn = document.getElementById('cache-clear');
  if (clearBtn) {
    clearBtn.onclick = () => withButtonProgress(clearBtn, 'Clearing cache…', async () => {
      await clearStemCache();
      await refreshCacheSize();
      notify('Playback cache cleared.');
    });
  }
}
