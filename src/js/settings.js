// Renders the Settings view: quality presets (+ custom knobs), stem layout,
// and compute device. Persists on every change via window.api.saveSettings.

let config = null;

export function initSettings(cfg) {
  config = cfg;
}

export function renderSettings() {
  const root = document.getElementById('settings-root');
  const s = config.settings;
  const presets = Object.values(config.presets);

  root.innerHTML = `
    <div class="settings-section">
      <h3>Default quality preset</h3>
      <p class="desc">Used for new songs. <strong>Studio</strong> is the highest-quality option (slowest). You can override per song when adding.</p>
      <div class="preset-grid" id="preset-grid">
        ${presets.map((p) => presetCard(p, s.preset === p.id)).join('')}
        ${presetCard({ id: 'custom', label: 'Custom', description: 'Dial in the model, shift averaging and output format yourself.' }, s.preset === 'custom')}
      </div>
    </div>

    <div class="settings-section ${s.preset === 'custom' ? '' : 'hidden'}" id="custom-section">
      <h3>Custom parameters</h3>
      <p class="desc">Demucs separation settings.</p>
      <div class="row">
        <div><label>Model</label><div class="sub">Fine-tuned models separate better but run ~4× slower.</div></div>
        <select id="c-model">
          ${config.models.map((m) => `<option value="${m.id}" ${s.custom.model === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}
        </select>
      </div>
      <div class="row">
        <div><label>Shift averaging</label><div class="sub">Higher = better separation, linearly slower. 0–10.</div></div>
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
      <div class="row">
        <div><label>Output format</label><div class="sub">float32 = full precision (largest); int24 = excellent + smaller.</div></div>
        <select id="c-format">
          <option value="float32" ${s.custom.format === 'float32' ? 'selected' : ''}>32-bit float WAV</option>
          <option value="int24" ${s.custom.format === 'int24' ? 'selected' : ''}>24-bit WAV</option>
        </select>
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
      <h3>Compute device</h3>
      <p class="desc">Auto picks the best available. On Apple Silicon, MPS uses the GPU and is much faster.</p>
      <div class="row">
        <div><label>Device</label></div>
        <select id="s-device">
          ${['auto', 'mps', 'cuda', 'cpu'].map((d) => `<option value="${d}" ${s.device === d ? 'selected' : ''}>${d}</option>`).join('')}
        </select>
      </div>
      <div class="row" style="border:none">
        <span class="saved-flash" id="saved-flash">✓ Saved</span>
      </div>
    </div>
  `;

  wireSettings();
}

function presetCard(p, selected) {
  return `<div class="preset-card ${selected ? 'selected' : ''}" data-preset="${p.id}">
    <div class="pname">${p.label}</div>
    <div class="pdesc">${p.description}</div>
  </div>`;
}

function flashSaved() {
  const f = document.getElementById('saved-flash');
  if (!f) return;
  f.classList.add('show');
  setTimeout(() => f.classList.remove('show'), 1200);
}

async function persist() {
  config.settings = await window.api.saveSettings(config.settings);
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
  bind('c-format', (e) => { s.custom.format = e.target.value; persist(); });
  bind('s-stemmode', (e) => { s.stemMode = e.target.value; persist(); });
  bind('s-device', (e) => { s.device = e.target.value; persist(); });
}
