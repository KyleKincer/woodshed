// Renders the Settings view: quality presets (+ custom knobs), stem layout,
// delivery format, and the local stem cache. Persists on every change.

import * as backend from './backend.js';
import { localRequest, desktopStatus, initializeLocalDesktop, legacyLibraries, importLegacy } from './companion.js';
import { exportLibrary } from './export.js';
import { clearStemCache, stemCacheSize } from './stemcache.js';

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
  const presets = Object.values(config.presets);

  root.innerHTML = `
    <section class="settings-section" aria-labelledby="song-defaults-title">
      <h2 id="song-defaults-title">Song defaults</h2>
      <p class="desc">Applied to new songs. You can choose a different quality or stem layout for each song.</p>
      <h3>Separation quality</h3>
      <p class="hint">Higher quality takes longer to process on your computer.</p>
      <div class="preset-grid" id="preset-grid" role="group" aria-label="Separation quality">
        ${presets.map((p) => presetCard(p, s.preset === p.id)).join('')}
        ${presetCard({ id: 'custom', label: 'Custom', description: 'Choose advanced parameters.' }, s.preset === 'custom')}
      </div>
    <div class="settings-subsection ${s.preset === 'custom' ? '' : 'hidden'}" id="custom-section">
      <h3>Custom parameters</h3>

      <div class="row">
        <div><label for="c-model">Model</label><div class="sub">More accurate, but slower.</div></div>
        <select id="c-model" aria-label="Model">
          ${config.models.map((m) => `<option value="${m.id}" ${s.custom.model === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}
        </select>
      </div>
      <div class="row">
        <div><label for="c-shifts">Quality passes</label><div class="sub">Higher values take longer to process.</div></div>
        <div class="range-wrap">
          <input type="range" id="c-shifts" aria-label="Quality passes" min="0" max="10" step="1" value="${s.custom.shifts}" />
          <span id="c-shifts-val">${s.custom.shifts}</span>
        </div>
      </div>
      <div class="row">
        <div><label for="c-overlap">Overlap</label><div class="sub">Usually leave at the default.</div></div>
        <div class="range-wrap">
          <input type="range" id="c-overlap" aria-label="Overlap" min="0.1" max="0.75" step="0.05" value="${s.custom.overlap}" />
          <span id="c-overlap-val">${s.custom.overlap}</span>
        </div>
      </div>
    </div>

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

    <p id="saved-flash" class="settings-save-status" role="status">Changes save automatically.</p>
    </section>

    <section class="settings-section" aria-labelledby="desktop-title">
      <h2 id="desktop-title">Desktop connection</h2>
      <p class="connection-status" id="desktop-status" role="status">${window.woodshedDesktop ? 'Checking local processor…' : 'Using the web player'}</p>
      <p class="desc">${window.woodshedDesktop ? 'Downloading and processing happen on this computer. Your library syncs through your signed-in account.' : 'Play your synced library here. To add and process songs, open Woodshed for desktop and sign in with the same account.'}</p>
      <div class="settings-actions">${window.woodshedDesktop ? '<button class="btn-ghost" id="desktop-retry">Retry connection</button><button class="btn-ghost" id="desktop-updates">App updates</button>' : '<a href="/download" class="btn-ghost">Download desktop app</a>'}</div>
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
        <p class="hint" id="export-message" role="status"></p>
      </div>
      <div class="management-item">
        <h3>Original audio files</h3>
        <p class="desc">Copy locally stored source audio and stems (WAV and FLAC) to an export folder in Downloads on the computer that processed them. Requires Woodshed for desktop on that computer.</p>
        <div class="settings-actions"><button class="btn-ghost" id="export-originals" ${window.woodshedDesktop ? '' : 'disabled'}>Export original audio files</button></div>
        <p class="hint" id="originals-message" role="status"></p>
      </div>
      <details class="management-item">
        <summary>Import an old Woodshed library</summary>
        <p class="desc">Import songs from a previous installation on this computer. Existing files are preserved. Requires Woodshed for desktop.</p>
        <label for="legacy-dir">Old library data directory <span class="hint">(optional)</span></label>
        <input id="legacy-dir" type="text" placeholder="Leave blank to detect automatically" aria-describedby="legacy-hint" ${window.woodshedDesktop ? '' : 'disabled'} />
        <p class="hint" id="legacy-hint">If more than one library is found, enter the full path to the one you want.</p>
        <div class="settings-actions"><button class="btn-ghost" id="import-legacy" ${window.woodshedDesktop ? '' : 'disabled'}>Import old library</button></div>
        <p class="hint" id="import-message" role="status"></p>
      </details>
    </section>
  `;
  const status = root.querySelector('#desktop-status');
  const checkDesktop = async () => {
    try {
      const info = await desktopStatus();
      status.textContent = info.connected ? (info.busy ? 'Connected · Processing a song' : 'Connected · Ready to process songs') : 'Local processor is not connected. Retry the connection.';
      root.querySelector('#desktop-retry').hidden = info.connected;
    } catch (error) { status.textContent = error.message; }
  };
  if (window.woodshedDesktop) {
    checkDesktop();
    root.querySelector('#desktop-updates').onclick = () => document.dispatchEvent(new Event('woodshed:show-updates'));
    root.querySelector('#desktop-retry').onclick = async event => {
      const button = event.currentTarget; button.disabled = true;
      try { await initializeLocalDesktop(); await checkDesktop(); }
      catch (error) { status.textContent = error.message; }
      finally { button.disabled = false; }
    };
  }
  root.querySelector('#import-legacy').onclick = async event => {
    const button = event.currentTarget; button.disabled = true;
    const message = root.querySelector('#import-message');
    try {
      let directory = root.querySelector('#legacy-dir').value.trim();
      if (!directory) {
        const found = await legacyLibraries();
        if (found.length !== 1) throw new Error(found.length ? 'More than one library found. Enter the full directory path to import.' : 'No old library detected. Enter its data directory.');
        directory = found[0].directory;
      }
      const result = await importLegacy(directory);
      message.textContent = `Queued ${result.count} songs. Existing files are preserved.${result.remaining ? ` Import again after these finish for ${result.remaining} remaining songs.` : ''}`;
    } catch (error) { message.textContent = error.message; }
    finally { button.disabled = false; }
  };
  root.querySelector('#settings-upgrade').onclick = () => document.dispatchEvent(new Event('woodshed:billing'));
  const usage = root.querySelector('#cloud-usage');
  backend.cloudUsage().then(u => {
    usage.textContent = `${fmtBytes(u.usedBytes)} of ${fmtBytes(u.limitBytes)} used${u.appFull ? '. Cloud uploads are paused; playback and export remain available.' : '.'}`;
    const meter = root.querySelector('#storage-meter');
    meter.max = Math.max(1, u.limitBytes); meter.value = u.usedBytes; meter.classList.remove('hidden');
  }).catch(error => { usage.textContent = error.message; });
  root.querySelector('#export-originals').onclick = async event => {
    const button = event.currentTarget; button.disabled = true;
    const message = root.querySelector('#originals-message');
    try { const result = await localRequest('/export-originals', {}); message.textContent = `Exported ${result.count} files to ${result.directory}`; }
    catch (error) { message.textContent = error.message; }
    finally { button.disabled = false; }
  };
  root.querySelector('#export-library').onclick = async event => {
    const button = event.currentTarget; button.disabled = true;
    const message = root.querySelector('#export-message');
    try { await exportLibrary(text => { message.textContent = text; }); }
    catch (error) { message.textContent = error.message; }
    finally { button.disabled = false; }
  };
  wireSettings();
  refreshCacheSize();
}

async function refreshCacheSize() {
  const el = document.getElementById('cache-size');
  if (!el) return;
  try { el.textContent = fmtBytes(await stemCacheSize()); }
  catch { el.textContent = 'Unavailable in this browser'; }
}

function presetCard(p, selected) {
  const cost = p.estCostUsd ? ` <span class="pcost">~$${p.estCostUsd.toFixed(2)}/song</span>` : '';
  return `<button type="button" class="preset-card ${selected ? 'selected' : ''}" data-preset="${p.id}" aria-pressed="${selected}">
    <div class="pname">${p.label}</div>
    <div class="pdesc">${p.description}${cost}</div>
  </button>`;
}

function flashSaved() {
  const f = document.getElementById('saved-flash');
  if (!f) return;
  f.textContent = '✓ Changes saved';
}

async function persist() {
  const status = document.getElementById('saved-flash');
  try {
    await backend.saveSettings(config.settings);
    flashSaved();
    return true;
  } catch (error) {
    if (status) status.textContent = `Could not save changes: ${error.message}. Change the setting again to retry.`;
    return false;
  }
}

function wireSettings() {
  const s = config.settings;
  document.querySelectorAll('.preset-card').forEach((card) => {
    card.onclick = async () => {
      s.preset = card.dataset.preset;
      if (await persist()) {
        document.querySelectorAll('.preset-card').forEach(button => {
          const selected = button.dataset.preset === s.preset;
          button.classList.toggle('selected', selected);
          button.setAttribute('aria-pressed', String(selected));
        });
        document.getElementById('custom-section').classList.toggle('hidden', s.preset !== 'custom');
      }
    };
  });

  const bind = (id, handler) => { const el = document.getElementById(id); if (el) el.oninput = handler; };

  bind('c-model', (e) => { s.custom.model = e.target.value; persist(); });
  bind('c-shifts', (e) => { s.custom.shifts = parseInt(e.target.value, 10); document.getElementById('c-shifts-val').textContent = e.target.value; persist(); });
  bind('c-overlap', (e) => { s.custom.overlap = parseFloat(e.target.value); document.getElementById('c-overlap-val').textContent = e.target.value; persist(); });
  bind('s-stemmode', (e) => { s.stemMode = e.target.value; persist(); });
  bind('s-bitrate', (e) => { s.bitrate = parseInt(e.target.value, 10); persist(); });

  const clearBtn = document.getElementById('cache-clear');
  if (clearBtn) {
    clearBtn.onclick = async () => {
      clearBtn.disabled = true;
      try { await clearStemCache(); await refreshCacheSize(); }
      catch (error) { document.getElementById('cache-size').textContent = error.message; }
      finally { clearBtn.disabled = false; }
    };
  }
}
