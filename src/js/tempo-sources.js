// Audition external timing against this recording without losing the user's map.
// The chosen map is the ordinary song map, so the click, grid and notation follow it.
import {importTempoFile, offsetTempoMap} from './tempo-import.js';
import {compile, timeAt} from '../../shared/song-map.ts';

const clone = (value) => structuredClone(value);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const seconds = (value) => { const whole = Math.round(value); return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`; };
const errorText = (error) => String(error?.message || error || 'Could not load that map.');
const sourceName = (value) => value === 'harmonix' ? 'Harmonix Set' : value;

export function createTempoSources({root, song, songMap, engine, search, load, onClose = () => {}, onImportDrums = null, previewDrums = null, play = null}) {
  let opened = false, disposed = false, searchRevision = 0, loadRevision = 0, importingDrums = false;
  let items = [], selected = null, baseline = null, history = null, focusBefore = null, localId = 0;
  let frozen = [];
  function freezeOtherEditors(value) {
    if (value) {
      frozen = [...(root.closest('.player')?.querySelectorAll('.notation-workspace,.workspace-nav,.map-lane') || [])].map(el => [el, el.inert]);
      frozen.forEach(([el]) => { el.inert = true; });
    } else { frozen.forEach(([el, before]) => { el.inert = before; }); frozen = []; }
  }
  const duration = () => engine.duration || song.duration || 1;
  root.classList.add('tempo-sources');
  root.hidden = true;
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Find and align a tempo map');
  root.innerHTML = `
    <div class="ts-heading"><div><h3>Find a tempo map</h3><p>Try a map with the recording. Switch versions or move the whole grid until the click lines up.</p></div>
      <button type="button" class="mi-btn" data-ts="cancel">Cancel</button></div>
    <div class="ts-body">
      <section class="ts-find" aria-label="Available maps">
        <form class="ts-search"><label for="tempo-source-query">Song or artist</label><div class="ts-search-row"><input id="tempo-source-query" name="query" type="search" maxlength="160" autocomplete="off"><button class="mi-btn" type="submit">Search</button></div></form>
        <div class="ts-results" aria-label="Tempo map choices"></div>
        <div class="ts-import"><button type="button" class="mi-btn" data-ts="file">Import a file…</button><input type="file" accept=".mid,.midi,.chart,.txt,.tsv,.lab,.csv" hidden><span>MIDI, Clone Hero chart, or beat timestamps</span></div>
        <details class="ts-elsewhere"><summary>Other sources</summary><p>Find a chart on <a href="https://www.enchor.us/" target="_blank" rel="noopener noreferrer">Chorus Encore</a>, or download MIDI from <a href="https://www.songsterr.com/plus" target="_blank" rel="noopener noreferrer">Songsterr</a>, then import it here. Guitar Pro files can be exported as MIDI first.</p></details>
      </section>
      <section class="ts-align" aria-label="Align the chosen map">
        <div class="ts-listening"><div class="ts-current"><span class="mi-k">Listening to</span><strong data-ts="current">Your map</strong><span data-ts="detail"></span></div><button type="button" class="mi-btn" data-ts="play" ${play ? '' : 'hidden'}>Play / pause</button></div>
        <p class="ts-warning" data-ts="warning"></p>
        <label class="ts-offset-label" for="tempo-source-offset">Move the whole map <span>milliseconds · positive moves later</span></label>
        <div class="ts-offset-row"><button type="button" class="mi-btn" data-shift="-100" aria-label="Move map 100 milliseconds earlier">−100</button><button type="button" class="mi-btn" data-shift="-10" aria-label="Move map 10 milliseconds earlier">−10</button><input id="tempo-source-offset" type="number" step="1" min="-3600000" max="3600000" value="0" aria-label="Map offset in milliseconds"><button type="button" class="mi-btn" data-shift="10" aria-label="Move map 10 milliseconds later">+10</button><button type="button" class="mi-btn" data-shift="100" aria-label="Move map 100 milliseconds later">+100</button></div>
        <div class="ts-align-actions"><button type="button" class="mi-btn" data-ts="align" title="Move bar 1 to the recording position selected in the waveform">First downbeat → cursor</button><button type="button" class="mi-btn" data-ts="reset">Reset offset</button></div>
        <p class="ts-advice">Listen near the start and the end. An offset fixes a steady mismatch; if the grid drifts, try another map or refine its pins.</p>
        <div class="ts-commit"><button type="button" class="mi-btn" data-ts="restore">Your map</button><button type="button" class="mi-btn primary" data-ts="drums" hidden>Use map &amp; import drums</button><button type="button" class="mi-btn primary" data-ts="keep">Keep map</button></div>
      </section>
    </div>
    <p class="ts-status" role="status" aria-live="polite"></p>`;
  const query = root.querySelector('[name=query]'), searchForm = root.querySelector('.ts-search');
  const searchButton = searchForm.querySelector('button'), results = root.querySelector('.ts-results');
  const fileInput = root.querySelector('[type=file]'), offsetInput = root.querySelector('#tempo-source-offset');
  const current = root.querySelector('[data-ts=current]'), detail = root.querySelector('[data-ts=detail]');
  const warning = root.querySelector('[data-ts=warning]'), status = root.querySelector('.ts-status');
  const drumButton = root.querySelector('[data-ts=drums]');
  query.value = [song.artist, song.title].filter(Boolean).join(' ').slice(0, 160);

  function say(message, tone = 'info') { status.textContent = message; status.dataset.tone = tone; }
  function renderChoices() {
    results.innerHTML = items.map((item, index) => `<button type="button" class="ts-choice" data-choice="${index}" aria-pressed="${selected === item}"><span><b>${esc(item.title)}</b><small>${esc([item.artist, item.album, sourceName(item.source), Number.isFinite(item.duration) ? seconds(item.duration) : ''].filter(Boolean).join(' · '))}</small></span><span class="ts-choice-mark" aria-hidden="true">${selected === item ? '✓' : 'Try'}</span></button>`).join('');
  }
  function renderSelection() {
    current.textContent = selected?.title || 'Your map';
    const count = selected?.result?.drums?.hits?.length || 0;
    let preview = null, previewError = '';
    if (count && previewDrums) {
      try { preview = previewDrums({...selected.result, map: songMap.serialize()}); }
      catch (error) { previewError = `Drum notation cannot be imported: ${errorText(error)}`; }
    }
    const importCount = preview?.importedCount ?? count;
    const drumDetail = count ? `${importCount} drum hit${importCount === 1 ? '' : 's'} ${preview ? 'ready to import' : 'available'}${preview?.skippedCount ? ` · ${preview.skippedCount} skipped` : ''}` : '';
    detail.textContent = [selected?.artist, selected?.album, sourceName(selected?.source), drumDetail].filter(Boolean).join(' · ');
    const mismatch = Number.isFinite(selected?.duration) && Math.abs(selected.duration - duration()) > 2
      ? `This version is ${Math.abs(selected.duration - duration()).toFixed(1)} seconds ${selected.duration > duration() ? 'longer' : 'shorter'} than your recording. Check that it is the same performance.` : '';
    warning.textContent = [...new Set([...(selected?.result?.warnings || []), ...(selected?.result?.drums?.warnings || []), ...(preview?.warnings || []), previewError, mismatch].filter(Boolean))].join(' ');
    warning.hidden = !warning.textContent;
    drumButton.hidden = !(onImportDrums && count);
    drumButton.disabled = !!previewError || importCount === 0;
    offsetInput.value = String(Math.round((selected?.offset || 0) * 1000));
    renderChoices();
  }
  function valid(token) { return opened && !disposed && token === loadRevision; }
  function apply(item, offset = item.offset || 0) {
    if (!item.result?.map) throw Error('That source has no timing map.');
    const map = offsetTempoMap(item.result.map, offset);
    // Bar N stays attached to bar N of the user's transcription. The store's
    // notation guards refuse a meter or length change that would strand notes.
    map.measures.forEach((m, i) => { if (baseline.measures[i]) m.id = baseline.measures[i].id; });
    songMap.replace(map, 'tempo-source');
    item.offset = offset;
    selected = item;
    renderSelection();
  }
  async function choose(item) {
    if (!opened || importingDrums) return;
    const token = ++loadRevision;
    try {
      if (!item.result) {
        say(`Loading ${item.title}…`);
        const result = await load(item);
        if (!valid(token)) return;
        item.result = result;
      }
      if (!valid(token)) return;
      apply(item);
      say(item.id === 'original' ? 'Your original map is playing.' : 'Map loaded. Play the recording and check the click near the start and end.');
    } catch (error) { if (valid(token)) say(errorText(error), 'error'); }
  }
  async function find() {
    if (!opened || importingDrums) return;
    const text = query.value.trim(), revision = ++searchRevision;
    if (!text) { say('Enter a song title or artist to search.'); return; }
    searchButton.disabled = true;
    say('Looking for tempo maps…');
    try {
      const response = await search({query: text, duration: duration()});
      if (!opened || disposed || revision !== searchRevision) return;
      const candidates = Array.isArray(response) ? response : response?.candidates || [];
      const retained = items.filter((item) => item.id === 'original' || item.local || item === selected);
      const ids = new Set(retained.map((item) => item.id));
      items = [...retained, ...candidates.filter((item) => item?.id && !ids.has(item.id)).map((item) => ({...item, offset: 0}))];
      renderChoices();
      say(candidates.length ? `${candidates.length} possible map${candidates.length === 1 ? '' : 's'}. Choose one to hear it with your recording.` : 'No catalog matches. Import a MIDI or chart file, or try another title.');
    } catch (error) {
      if (opened && !disposed && revision === searchRevision) say(`Search unavailable. ${errorText(error)} You can still import a file.`, 'error');
    } finally { if (revision === searchRevision) searchButton.disabled = false; }
  }
  function changeOffset(value) {
    if (!selected || importingDrums) return;
    ++loadRevision; // a late source download must not replace a map being aligned
    const next = Number(value);
    try {
      if (!Number.isFinite(next) || Math.abs(next) > 3600000) throw Error('Choose an offset between −3,600,000 and +3,600,000 milliseconds.');
      apply(selected, next / 1000);
      say(`${Math.abs(next).toFixed(next % 1 ? 1 : 0)} ms ${next < 0 ? 'earlier' : 'later'} than the source map.`, 'ok');
    } catch (error) { offsetInput.value = String(Math.round(selected.offset * 1000)); say(errorText(error), 'error'); }
  }
  function open() {
    if (opened || disposed) return;
    focusBefore = document.activeElement;
    opened = true;
    baseline = songMap.serialize();
    history = {undo: [...songMap.undoStack], redo: [...songMap.redoStack], legacy: clone(songMap.legacy)};
    items = [{id: 'original', title: 'Your map', source: 'Before trying sources', result: {map: clone(baseline), warnings: []}, offset: 0}];
    selected = items[0];
    root.hidden = false;
    root.closest('#map-strip')?.classList.add('is-sourcing');
    freezeOtherEditors(true);
    const chorus = new URL('https://www.enchor.us/');
    if (song.title) chorus.searchParams.set('name', song.title);
    if (song.artist) chorus.searchParams.set('artist', song.artist);
    root.querySelector('a[href*="enchor.us"]').href = chorus.href;
    const songsterr = new URL('https://www.songsterr.com/');
    songsterr.searchParams.set('pattern', [song.artist, song.title].filter(Boolean).join(' '));
    root.querySelector('a[href*="songsterr.com"]').href = songsterr.href;
    renderSelection();
    query.focus({preventScroll: true});
    if (query.value.trim()) void find(); else say('Search for a song or import a tempo-map file.');
  }
  function close({keep = false} = {}) {
    if (!opened) return true;
    if (importingDrums) return false;
    if (!keep) {
      try {
        songMap.replace(baseline, 'tempo-source-cancel');
        songMap.undoStack = history.undo; songMap.redoStack = history.redo; songMap.legacy = history.legacy;
      } catch (error) { say(`Could not restore your original map: ${errorText(error)}`, 'error'); return false; }
    }
    opened = false; ++searchRevision; ++loadRevision;
    searchButton.disabled = false; root.hidden = true;
    root.closest('#map-strip')?.classList.remove('is-sourcing');
    freezeOtherEditors(false);
    focusBefore?.isConnected && focusBefore.focus?.({preventScroll: true});
    onClose({keep, kept: keep});
    return true;
  }
  async function readFile() {
    const file = fileInput.files?.[0]; fileInput.value = '';
    if (!file || !opened || importingDrums) return;
    const token = ++loadRevision;
    say(`Reading ${file.name}…`);
    try {
      const result = await importTempoFile(file, {duration: duration()});
      if (!valid(token)) return;
      const item = {id: `file-${++localId}`, title: file.name, source: 'Imported file', local: true, result, offset: 0};
      apply(item); items.push(item); renderChoices();
      say('File loaded. Check its alignment, then keep the map.');
    } catch (error) { if (valid(token)) say(errorText(error), 'error'); }
  }
  async function importDrums() {
    if (!selected?.result?.drums || !onImportDrums || importingDrums) return;
    importingDrums = true;
    root.setAttribute('aria-busy', 'true');
    root.querySelectorAll('button,input').forEach((el) => { el.disabled = true; });
    say('Importing drum notation…');
    try {
      await onImportDrums({...selected.result, map: songMap.serialize()});
      if (disposed) return;
      importingDrums = false;
      close({keep: true});
    } catch (error) { if (!disposed) say(errorText(error), 'error'); }
    finally {
      importingDrums = false;
      root.removeAttribute('aria-busy');
      root.querySelectorAll('button,input').forEach((el) => { el.disabled = false; });
    }
  }
  async function audition() {
    if (!play) return;
    try { await play(); }
    catch (error) { if (opened && !disposed) say(`Could not start playback: ${errorText(error)}`, 'error'); }
  }
  function click(event) {
    const choice = event.target.closest('[data-choice]');
    if (choice) { void choose(items[Number(choice.dataset.choice)]); return; }
    const shift = event.target.closest('[data-shift]');
    if (shift) { changeOffset((selected?.offset || 0) * 1000 + Number(shift.dataset.shift)); return; }
    const action = event.target.closest('[data-ts]')?.dataset.ts;
    if (action === 'cancel') close();
    else if (action === 'keep') close({keep: true});
    else if (action === 'file') fileInput.click();
    else if (action === 'reset') changeOffset(0);
    else if (action === 'restore') void choose(items[0]);
    else if (action === 'drums') void importDrums();
    else if (action === 'play') void audition();
    else if (action === 'align' && selected) {
      const cursor = Number(engine.editPosition ?? engine.getPosition());
      const map = selected.result.map;
      // Query the source through the same store-independent timing code used
      // for offsets; its position 0 is the first bar's downbeat.
      const first = map.pins[0];
      // For maps beginning at position 0 the first pin is exact. Otherwise
      // use the active song-map's extrapolated bar-1 time and remove its offset.
      const at = timeAt(compile(selected.result.map), 0);
      if (first && Number.isFinite(cursor) && Number.isFinite(at)) changeOffset((cursor - at) * 1000);
    }
  }
  function key(event) {
    // Inputs and source choices form their own keyboard scope. Space and
    // letters must never mute a stem, add pins or start a tap pass here.
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === ' ' && !event.target.closest('input,button,a,summary,select,textarea')) { event.preventDefault(); void audition(); }
  }
  searchForm.addEventListener('submit', (event) => { event.preventDefault(); void find(); });
  fileInput.addEventListener('change', readFile);
  offsetInput.addEventListener('change', () => changeOffset(offsetInput.value));
  root.addEventListener('click', click);
  root.addEventListener('keydown', key);
  return {open, close, isOpen: () => opened, destroy() {
    if (disposed) return;
    // If a notation save is already underway it owns its completion; disposing
    // only prevents future UI work and late search/download application.
    if (!importingDrums) close();
    disposed = true; opened = false; ++loadRevision; ++searchRevision;
    freezeOtherEditors(false);
    root.closest('#map-strip')?.classList.remove('is-sourcing');
    root.removeEventListener('click', click); root.removeEventListener('keydown', key);
    root.replaceChildren(); root.hidden = true;
  }};
}
