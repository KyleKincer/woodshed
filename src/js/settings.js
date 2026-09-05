// Renders the Settings view: quality presets (+ custom knobs), stem layout,
// delivery format, and the local stem cache. Persists on every change.

import * as backend from './backend.js';
import { localRequest, connectCompanion, disconnectCompanion, legacyLibraries, importLegacy } from './companion.js';
import { exportLibrary } from './export.js';
import { clearStemCache, stemCacheSize } from './stemcache.js';

let config = null;

export function initSettings(cfg) {
  config = cfg;
}

function fmtBytes(n) {
  if (!n) return '0 MB';
  const mb = n / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
}

export function renderSettings() {
  const root = document.getElementById('settings-root');
  const s = config.settings;
  const presets = Object.values(config.presets);

  root.innerHTML = `
    <div class="settings-section">
      <h3>This computer</h3>
      <a href="/download" class="btn-ghost">Download desktop app</a>
      <p class="desc">Install Woodshed for desktop to download and process songs on this computer. Your library plays on other devices without it.</p>
      <div class="row"><input id="pairing-code" type="password" autocomplete="off" placeholder="Companion pairing code" aria-label="Companion pairing code" /><button class="btn-ghost" id="connect-companion">Connect</button><button class="btn-ghost" id="disconnect-companion">Disconnect</button></div>
      <p class="hint" id="companion-message">Open the link printed by your companion, or paste its pairing code here.</p>
      <div class="row"><input id="legacy-dir" placeholder="Old Woodshed data directory (optional)" aria-label="Old library directory" /><button class="btn-ghost" id="import-legacy">Import old library</button></div>
    </div>
    <div class="settings-section">
      <h3>Cloud library</h3>
      <p class="desc" id="cloud-usage">Loading storage usage…</p>
      <button class="btn-ghost" id="export-library">Export whole library</button> <button class="btn-ghost" id="export-originals">Export local WAVs</button>
      <p class="hint" id="export-message">Includes synced audio and practice settings. Original-quality WAV stems remain in your companion’s local data folder for export.</p>
    </div>

    <div class="settings-section">
      <h3>Default quality preset</h3>
      <p class="desc">Default for new songs — you can pick a different one per song. Higher quality takes longer to process on your computer.</p>
      <div class="preset-grid" id="preset-grid">
        ${presets.map((p) => presetCard(p, s.preset === p.id)).join('')}
        ${presetCard({ id: 'custom', label: 'Custom', description: 'Tweak the advanced settings yourself.' }, s.preset === 'custom')}
      </div>
    </div>

    <div class="settings-section ${s.preset === 'custom' ? '' : 'hidden'}" id="custom-section">
      <h3>Custom parameters</h3>
      <p class="desc">Advanced separation settings.</p>
      <div class="row">
        <div><label>Model</label><div class="sub">More accurate, but slower.</div></div>
        <select id="c-model">
          ${config.models.map((m) => `<option value="${m.id}" ${s.custom.model === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}
        </select>
      </div>
      <div class="row">
        <div><label>Quality passes</label><div class="sub">Higher values take longer to process.</div></div>
        <div class="range-wrap">
          <input type="range" id="c-shifts" min="0" max="10" step="1" value="${s.custom.shifts}" />
          <span id="c-shifts-val">${s.custom.shifts}</span>
        </div>
      </div>
      <div class="row">
        <div><label>Overlap</label><div class="sub">Usually leave at the default.</div></div>
        <div class="range-wrap">
          <input type="range" id="c-overlap" min="0.1" max="0.75" step="0.05" value="${s.custom.overlap}" />
          <span id="c-overlap-val">${s.custom.overlap}</span>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3>Default stems</h3>
      <p class="desc">Split the full band, or isolate one part.</p>
      <div class="row">
        <div><label>Stem layout</label></div>
        <select id="s-stemmode">
          ${Object.values(config.stemModes).map((m) => `<option value="${m.id}" ${s.stemMode === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}
        </select>
      </div>
    </div>

    <div class="settings-section">
      <h3>Audio quality</h3>
      <p class="desc">Stems are compressed so a song downloads in seconds rather than minutes. Original WAV stems remain on the processing computer.</p>
      <div class="row">
        <div><label>Format</label><div class="sub">Sync copies use Opus; local WAVs preserve the separation output.</div></div>
        <select id="s-format">
          <option value="opus" ${s.format === 'opus' ? 'selected' : ''}>Compressed (recommended)</option>

        </select>
      </div>
      <div class="row " id="bitrate-row">
        <div><label>Bitrate</label><div class="sub">Per stem. Higher bitrates use more cloud storage.</div></div>
        <select id="s-bitrate">
          ${config.bitrates.map((b) => `<option value="${b.id}" ${Number(s.bitrate) === b.id ? 'selected' : ''}>${b.label}</option>`).join('')}
        </select>
      </div>
      <p class="hint">Changing this affects newly processed songs. Reprocess a song to convert it.</p>
    </div>

    <div class="settings-section">
      <h3>Playback cache</h3>
      <p class="desc">Audio you've played is saved on this device to avoid repeat downloads. Recent songs stay ready for faster reopening.</p>
      <div class="row">
        <div><label>Cached audio</label><div class="sub" id="cache-size">Measuring…</div></div>
        <button class="btn-ghost" id="cache-clear">Clear cache</button>
      </div>
      <div class="row" style="border:none">
        <span class="saved-flash" id="saved-flash">✓ Saved</span>
      </div>
    </div>
  `;
  const message = document.getElementById('companion-message');
  document.getElementById('connect-companion').onclick = async () => {
    try { await connectCompanion(document.getElementById('pairing-code').value); message.textContent='Connected. New songs will process on this computer.'; }
    catch(e) { message.textContent=e.message; }
  };
  document.getElementById('disconnect-companion').onclick = async () => {
    try {await disconnectCompanion();message.textContent='Disconnected.';}catch(e){message.textContent=e.message;}
  };
  document.getElementById('import-legacy').onclick = async () => {
    try {
      let directory=document.getElementById('legacy-dir').value.trim();
      if(!directory){const found=await legacyLibraries();if(found.length!==1)throw new Error(found.length?'Enter the directory to import.':'No old library detected. Enter its data directory.');directory=found[0].directory;}
      const result=await importLegacy(directory);message.textContent=`Queued ${result.count} songs. Existing files are preserved.${result.remaining ? ` Import again after these finish for ${result.remaining} remaining songs.` : ''}`;
    } catch(e) {message.textContent=e.message;}
  };
  backend.cloudUsage().then(u=>{document.getElementById('cloud-usage').textContent=`${(u.usedBytes/1e6).toFixed(1)} MB of ${(u.limitBytes/1e6).toFixed(0)} MB used, including pending uploads. ${u.appFull?'Cloud uploads are paused; playback and export remain available.':''}`;}).catch(e=>{document.getElementById('cloud-usage').textContent=e.message;});
  document.getElementById('export-originals').onclick=async event=>{
    const button=event.currentTarget;button.disabled=true;
    try {const result=await localRequest('/export-originals',{});document.getElementById('export-message').textContent=`Exported ${result.count} files to ${result.directory}`;}
    catch(e){document.getElementById('export-message').textContent=e.message;}finally{button.disabled=false;}
  };
  document.getElementById('export-library').onclick=async event=>{
    const button=event.currentTarget;button.disabled=true;const status=document.getElementById('export-message');
    try{await exportLibrary(text=>{status.textContent=text;});}catch(e){status.textContent=e.message;}finally{button.disabled=false;}
  };


  if (window.woodshedDesktop) {
    const section=root.querySelector('.settings-section');
    section.querySelector('h3').textContent='Desktop app';
    section.querySelector('a').replaceWith(Object.assign(document.createElement('button'),{className:'btn-ghost',textContent:'App updates',onclick:()=>document.dispatchEvent(new Event('woodshed:show-updates'))}));
    section.querySelector('.desc').textContent='Downloading and processing happen here. Your library syncs automatically.';
    section.querySelector('#pairing-code').closest('.row').classList.add('hidden');
    message.textContent='This computer is connected automatically. You can import an older Woodshed library below.';
  }
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
  return `<div class="preset-card ${selected ? 'selected' : ''}" data-preset="${p.id}">
    <div class="pname">${p.label}</div>
    <div class="pdesc">${p.description}${cost}</div>
  </div>`;
}

function flashSaved() {
  const f = document.getElementById('saved-flash');
  if (!f) return;
  f.classList.add('show');
  setTimeout(() => f.classList.remove('show'), 1200);
}

async function persist() {
  config.settings = await backend.saveSettings(config.settings);
  flashSaved();
}

function wireSettings() {
  const s = config.settings;
  document.querySelectorAll('.preset-card').forEach((card) => {
    card.onclick = async () => {
      s.preset = card.dataset.preset;
      await persist();
      renderSettings();
    };
  });

  const bind = (id, handler) => { const el = document.getElementById(id); if (el) el.oninput = handler; };

  bind('c-model', (e) => { s.custom.model = e.target.value; persist(); });
  bind('c-shifts', (e) => { s.custom.shifts = parseInt(e.target.value, 10); document.getElementById('c-shifts-val').textContent = e.target.value; persist(); });
  bind('c-overlap', (e) => { s.custom.overlap = parseFloat(e.target.value); document.getElementById('c-overlap-val').textContent = e.target.value; persist(); });
  bind('s-stemmode', (e) => { s.stemMode = e.target.value; persist(); });
  bind('s-format', (e) => {
    s.format = e.target.value;
    document.getElementById('bitrate-row')?.classList.toggle('hidden', s.format === 'flac');
    persist();
  });
  bind('s-bitrate', (e) => { s.bitrate = parseInt(e.target.value, 10); persist(); });

  const clearBtn = document.getElementById('cache-clear');
  if (clearBtn) {
    clearBtn.onclick = async () => {
      clearBtn.disabled = true;
      await clearStemCache();
      await refreshCacheSize();
      clearBtn.disabled = false;
    };
  }
}
