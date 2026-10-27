/**
 * Song workspaces: Practice (tracks or the drum chart) and Transcribe.
 * The drum part loads in the background when a song opens, so Practice can
 * open straight to the chart; engraving and the editor stay off the startup
 * path until they are shown.
 */
const VIEW_KEY = 'ws.practice.view';
const readView = () => { try { return localStorage.getItem(VIEW_KEY); } catch { return null; } };
const writeView = value => { try { localStorage.setItem(VIEW_KEY, value); } catch { /* private mode */ } };

export function attachNotation(options) {
  const {root, ready = Promise.resolve(), openImport = null} = options;
  const player = root.querySelector('.player'), nav = root.querySelector('.workspace-nav');
  let mode = 'tracks', closed = false, part = null, partPending = null, chart = null, chartPending = null, workspace = null, workspacePending = null, chosen = false;

  const chartHost = document.createElement('section');
  chartHost.className = 'chart'; chartHost.hidden = true; chartHost.setAttribute('aria-label', 'Drum chart');
  const editorHost = document.createElement('section');
  editorHost.className = 'notation-workspace'; editorHost.hidden = true; editorHost.setAttribute('aria-label', 'Drum transcription');
  root.querySelector('.transport').before(chartHost, editorHost);

  // Practice holds two views of the same song: the chart and the stems.
  const switcher = document.createElement('div');
  switcher.className = 'practice-view'; switcher.setAttribute('role', 'group'); switcher.setAttribute('aria-label', 'Practice view');
  switcher.innerHTML = '<button type="button" data-practice-view="chart" aria-pressed="false">Chart</button><button type="button" data-practice-view="tracks" aria-pressed="true">Tracks</button>';
  const spacer = document.createElement('span'); spacer.className = 'workspace-spacer';
  nav.append(spacer, switcher);

  const paint = () => {
    player.classList.toggle('notation-active', mode === 'transcribe');
    player.classList.toggle('chart-active', mode === 'chart');
    nav.querySelectorAll('[data-workspace]').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.workspace === 'transcribe') === (mode === 'transcribe'))));
    switcher.hidden = mode === 'transcribe';
    switcher.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.practiceView === mode)));
  };

  const loadPart = () => partPending ??= ready.catch(() => {}).then(() => import('./part.js')).then(({openPart}) => openPart(options)).then(result => {
    if (closed) { result.destroy(); throw new Error('Reopen the song to see its drum part.'); }
    part = result; return part;
  }).catch(error => { partPending = null; throw error; });

  const loadChart = async () => {
    chartPending ??= Promise.all([loadPart(), import('./chart.js')]).then(([loaded, {createChart}]) => createChart({
      host: chartHost, part: loaded, engine: options.engine, onMixerChange: options.onMixerChange,
      setLoop: options.setLoop, clearLoop: options.clearLoop,
      onEmpty: {transcribe: options.readOnly ? null : () => show('transcribe'), importFile: openImport ? () => { show('tracks'); openImport(); } : null},
    })).catch(error => { chartPending = null; throw error; });
    chart = await chartPending;
    if (closed) chart.destroy();
    return chart;
  };
  const loadWorkspace = async () => {
    workspacePending ??= Promise.all([loadPart(), import('./editor.js')]).then(([loaded, {createNotationWorkspace}]) => createNotationWorkspace({...options, host: editorHost, part: loaded})).catch(error => { workspacePending = null; throw error; });
    workspace = await workspacePending;
    if (closed) workspace.destroy();
    return workspace;
  };

  const failed = (host, title, retry) => {
    host.innerHTML = `<div class="notation-empty"><h2>${title}</h2><p>Check your connection and try again.</p><button type="button">Try again</button></div>`;
    host.querySelector('button').onclick = retry;
  };

  async function show(next, {remember = true} = {}) {
    chosen = true;
    mode = next;
    if (remember && next !== 'transcribe') writeView(next);
    paint();
    chartHost.hidden = next !== 'chart';
    editorHost.hidden = next !== 'transcribe';
    if (next !== 'chart') chart?.setVisible(false);
    if (next !== 'transcribe') workspace?.setVisible(false);
    if (next === 'chart') {
      if (chart) { chart.setVisible(true); return; }
      chartHost.innerHTML = '<div class="notation-loading" role="status">Loading chart…</div>';
      try { await loadChart(); if (mode === 'chart') chart.setVisible(true); }
      catch { failed(chartHost, 'Couldn’t open the chart', () => show('chart')); }
    } else if (next === 'transcribe') {
      if (workspace) { workspace.setVisible(true); return; }
      editorHost.innerHTML = '<div class="notation-loading" role="status">Loading notation…</div>';
      try { await loadWorkspace(); if (mode === 'transcribe') workspace.setVisible(true); }
      catch { failed(editorHost, 'Couldn’t open transcription', () => show('transcribe')); }
    }
  }

  nav.querySelector('[data-workspace="transcribe"]').onclick = () => show('transcribe');
  nav.querySelector('[data-workspace="practice"]').onclick = () => show(readView() === 'tracks' ? 'tracks' : (part?.hasNotation ? 'chart' : 'tracks'));
  switcher.addEventListener('click', event => { const b = event.target.closest('[data-practice-view]'); if (b) show(b.dataset.practiceView); });
  paint();

  // Open straight to the chart when the song has one, unless this device
  // last chose the stems.
  loadPart().then(loaded => {
    if (closed || chosen) return;
    if (loaded.hasNotation && readView() !== 'tracks') void show('chart', {remember: false});
  }).catch(() => {});

  return {
    handleKey: e => { if (mode !== 'transcribe') return false; workspace?.handleKey(e); return true; },
    tick: time => { if (mode === 'chart') chart?.tick(time); else if (mode === 'transcribe') workspace?.tick(time); },
    flush: async () => { await part?.flush(); },
    async importScore(score, notice) {
      const loaded = await loadPart();
      loaded.importScore(score);
      await show('chart');
      chart?.notice(notice || 'Imported drum part. Check it against the recording; Undo in Transcribe restores the empty part.');
    },
    destroy() { closed = true; chart?.destroy(); workspace?.destroy(); part?.destroy(); chartHost.remove(); editorHost.remove(); switcher.remove(); spacer.remove(); },
  };
}
