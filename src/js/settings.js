// Renders the Settings view: quality presets (+ custom knobs), stem layout,
// delivery format, and the local stem cache. Persists on every change.

import * as backend from './backend.js';
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
      <h3>Default quality preset</h3>
      <p class="desc">Used for new songs. Separation runs on a cloud GPU and is billed by the second, so the cost estimate moves with the preset. You can override per song when adding.</p>
      <div class="preset-grid" id="preset-grid">
        ${presets.map((p) => presetCard(p, s.preset === p.id)).join('')}
        ${presetCard({ id: 'custom', label: 'Custom', description: 'Dial in the model and shift averaging yourself.' }, s.preset === 'custom')}
      </div>
    </div>

    <div class="settings-section ${s.preset === 'custom' ? '' : 'hidden'}" id="custom-section">
      <h3>Custom parameters</h3>
      <p class="desc">Demucs separation settings.</p>
      <div class="row">
        <div><label>Model</label><div class="sub">Fine-tuned models separate better but run ~4× slower — and cost ~4× as much.</div></div>
        <select id="c-model">
          ${config.models.map((m) => `<option value="${m.id}" ${s.custom.model === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}
        </select>
      </div>
      <div class="row">
        <div><label>Shift averaging</label><div class="sub">Higher = better separation, linearly slower and more expensive. 0–10.</div></div>
        <div class="range-wrap">
          <input type="range" id="c-shifts" min="0" max="10" step="1" value="${s.custom.shifts}" />
          <span id="c-shifts-val">${s.custom.shifts}</span>
        </div>
      </div>
      <div class="row">
        <div><label>Overlap</label><div class="sub">Segment overlap. 0.25 default, up to 0.75.</div></div>
        <div class="range-wrap">
          <input type="range" id="c-overlap" min="0.1" max="0.75" step="0.05" value="${s.custom.overlap}" />
          <span id="c-overlap-val">${s.custom.overlap}</span>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3>Default stems</h3>
      <p class="desc">How many parts to split into. Full band lets you mute any instrument while you play along.</p>
      <div class="row">
        <div><label>Stem layout</label></div>
        <select id="s-stemmode">
          ${Object.values(config.stemModes).map((m) => `<option value="${m.id}" ${s.stemMode === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}
        </select>
      </div>
    </div>

    <div class="settings-section">
      <h3>Audio delivery</h3>
      <p class="desc">
        Stems are stored compressed so a song is tens of megabytes instead of hundreds.
        Opus is encoded into a WebM container, which decodes sample-exactly — so stems stay
        locked to each other and to the beat grid.
      </p>
      <div class="row">
        <div><label>Format</label><div class="sub">FLAC is lossless but roughly 4× the size and download time.</div></div>
        <select id="s-format">
          <option value="opus" ${s.format === 'opus' ? 'selected' : ''}>Opus (recommended)</option>
          <option value="flac" ${s.format === 'flac' ? 'selected' : ''}>FLAC — lossless</option>
        </select>
      </div>
      <div class="row ${s.format === 'flac' ? 'hidden' : ''}" id="bitrate-row">
        <div><label>Opus bitrate</label><div class="sub">Per stem. 192 kbps is past transparent for a single separated part.</div></div>
        <select id="s-bitrate">
          ${config.bitrates.map((b) => `<option value="${b.id}" ${Number(s.bitrate) === b.id ? 'selected' : ''}>${b.label}</option>`).join('')}
        </select>
      </div>
      <p class="hint">Changing this affects newly processed songs. Reprocess a song to convert it.</p>
    </div>

    <div class="settings-section">
      <h3>Offline cache</h3>
      <p class="desc">Stems are cached in this browser after the first play, so re-opening a song is instant and costs no bandwidth.</p>
      <div class="row">
        <div><label>Cached audio</label><div class="sub" id="cache-size">Measuring…</div></div>
        <button class="btn-ghost" id="cache-clear">Clear cache</button>
      </div>
      <div class="row" style="border:none">
        <span class="saved-flash" id="saved-flash">✓ Saved</span>
      </div>
    </div>
  `;

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
