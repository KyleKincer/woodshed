// Edit · Chart (architecture §2.15, spec §5.2, maps/notation.md §12): the Transcribe workspace
// (src/js/notation/editor.js, internals unchanged) in the Edit posture's frame.
//
//   mount(el, {session, query, inspectorEl, edit, registry, commands}) → {destroy, workspace}
//     session      the song session (src/stage/session.js): its notation part, DrumAudio, transport,
//                  engine, map and frame bus are shared with the Stage (D27), so Listen and the
//                  Recorded drums switch carry across postures
//     query        the route query: ?bar=N (1-based) places the cursor on bar N
//     inspectorEl  the frame's inspector container (src/edit/edit.js): on a laptop (or iPad
//                  landscape) the tabs Kit · Properties · Listen live there; in iPad portrait the
//                  container stays empty (so the frame hides it) and each tab opens as a sheet
//     edit         the 'edit' command context: its saveStatus signal shows the save status in the
//                  posture bar (Saved / Saving… / Saved on this device / Another version exists
//                  [Review], Retry for offline and storage errors); its layout signal picks the
//                  portrait arrangement. Without it the toolbar shows the status and the window
//                  size picks the layout.
//     registry     the command registry (default the app registry); the view provides 'chart'
//                  (the workspace) on it while mounted
//     commands     {setDrumKeys(keys)}: re-registers the drum-letter commands after Drum keys…
//                  (default: the app registry's, src/edit/chart/commands.js)
//
// The view, top to bottom: the toolbar (toolbar.js), the message line (role=status), the score or
// lanes (the editor's surface, focus scope `edit.chart.score`), and in iPad portrait the inspector
// buttons and the kit pad bank (kit-bank.js) docked at the bottom. Menus (menus.js) open from the
// toolbar. Every key is a registry command (commands.js) that calls the workspace's run().

import '../../styles/views/edit/chart.css';
import {registry as appRegistry} from '../../app/commands.js';
import {prefs as appPrefs} from '../../app/prefs.js';
import {h} from '../../ui/h.js';
import {Button} from '../../ui/button.js';
import {Menu} from '../../ui/menu.js';
import {Sheet} from '../../ui/sheet.js';
import {Tabs} from '../../ui/tabs.js';
import {stageLayout} from '../../stage/layout.js';
import {createNotationWorkspace, formDialog, INSPECTOR_TABS} from '../../js/notation/editor.js';
import {musicalStarts, toTime, number} from '../../../shared/notation.ts';
import {confirm as appConfirm} from '../../app/feedback.js';
import {importDrumPartFromFile, replaceDialog} from '../drum-import.js';
import {reservedScoreKeys, setDrumKeys as setAppDrumKeys} from './commands.js';
import {createToolbar} from './toolbar.js';
import {createKitBank} from './kit-bank.js';
import {COPY, gridMenu, tupletMenu, viewMenu} from './menus.js';

const PLAYING = new Set(['playing', 'counting']);
const RESIZE_MS = 150;
const peek = (v) => (v && typeof v.peek === 'function' ? v.peek() : v?.value ?? v ?? null);

/** The posture bar's save status for a part status (architecture §2.15 'edit'.saveStatus). */
export function saveStatusOf(state, run) {
  if (!state || state.status === 'loading') return {state: 'saving', text: state?.statusText ?? ''};
  const kind = {saved: 'saved', fixture: 'saved', local: 'local', saving: 'saving', conflict: 'conflict', offline: 'error',
    'storage-error': 'error', 'read-only': 'idle'}[state.status] ?? 'idle';
  const out = {state: kind, text: state.statusText};
  if (state.recovery === 'resolve') out.action = {label: COPY.review, run: () => run('resolve')};
  else if (state.recovery === 'retry') out.action = {label: COPY.retry, run: () => run('retry-save')};
  return out;
}

/** 'wide' (inspector on the right) or 'portrait' (sheets and the kit bank), from the window (spec §5.0, §5.2). */
export function windowLayout(win = globalThis.window) {
  if (!win) return 'wide';
  return stageLayout({vw: win.innerWidth, vh: win.innerHeight}) === 'rail' ? 'wide' : 'portrait';
}

/** A file picker for Part ▾ → Drum part from file…; resolves with the chosen File or null. */
function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', {type: 'file', accept});
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), {once: true});
    input.addEventListener('cancel', () => resolve(null), {once: true});
    input.click();
  });
}

export function mount(el, {session, query = {}, inspectorEl = null, edit = null, registry = appRegistry, prefs = appPrefs,
  commands = registry === appRegistry ? {setDrumKeys: setAppDrumKeys} : null, dialog = formDialog,
  importDrums = importDrumPartFromFile, chooseFile = pickFile, confirm = appConfirm} = {}) {
  if (!session) throw new TypeError('Edit · Chart needs a song session.');
  const notation = session.notation;
  const transport = session.transport;
  const cleanups = [];
  const cleanup = (fn) => { if (typeof fn === 'function') cleanups.push(fn); };
  let destroyed = false;
  let workspace = null;
  let toolbar = null;
  let kitBank = null;
  let tabs = null;
  let sheet = null;
  let sheetTab = null;
  let lastTab = null;
  let layout = edit?.layout ? peek(edit.layout) ?? 'wide' : windowLayout();

  // ---- the frame's elements --------------------------------------------------------------------------------
  const message = h('p', {class: 'chart-edit-message', role: 'status', 'aria-live': 'polite'});
  const main = h('div', {class: 'chart-edit-main'});
  const notice = h('div', {class: 'chart-edit-notice'});
  const panelButtons = h('div', {class: 'chart-edit-panels', role: 'group', 'aria-label': COPY.inspector});
  const bankHost = h('div', {class: 'chart-edit-bank'});
  const toolHost = h('div', {class: 'chart-edit-tools'});
  // iPad portrait docks the toolbar, the inspector buttons and the kit bank at the bottom (score on top).
  const dock = h('div', {class: 'chart-edit-dock'}, panelButtons, bankHost);
  const root = h('section', {class: 'chart-edit', 'aria-label': COPY.editor, dataset: {layout}},
    toolHost, message, notice, main, dock);
  el.append(root);

  // The inspector panels: the editor renders the tab bodies into them (slots.inspector).
  const panels = Object.fromEntries(INSPECTOR_TABS.map((tab) => [tab, h('div', {
    class: `chart-edit-panel chart-edit-panel-${tab}`, id: `chart-edit-panel-${tab}`, role: 'tabpanel', tabIndex: -1,
  })]));
  const inspectorRoot = h('div', {class: 'chart-edit-inspector'});
  const parked = h('div', {hidden: true});   // panels live here while no tab or sheet shows them
  root.append(parked);
  for (const panel of Object.values(panels)) parked.append(panel);

  const say = (text) => { message.textContent = text ?? ''; };

  // ---- part states (opening, error, read-only) -------------------------------------------------------------
  function showNotice(text, {busy = false, retry = false} = {}) {
    notice.replaceChildren();
    notice.hidden = !text;
    if (!text) { notice.removeAttribute('aria-busy'); return; }
    notice.setAttribute('aria-busy', busy ? 'true' : 'false');
    notice.append(h('p', {class: 'chart-edit-notice-text'}, text));
    if (retry) {
      const again = Button({label: COPY.tryAgain, variant: 'primary', onClick: () => { again.destroy(); start(); }});
      notice.append(again.el);
    }
  }

  // ---- adapters over the session -----------------------------------------------------------------------------
  const snapshot = () => transport.snapshot?.peek?.() ?? null;
  const tr = {
    playStop: () => transport.playStop(),
    pause: () => transport.pause(),
    again: () => transport.again(),
    playFrom: (t) => transport.playFrom(t),
    // Stopped: a click on the score moves the cue (Play starts there); playing: it seeks and leaves the cue.
    seek: (t) => (PLAYING.has(snapshot()?.phase) ? transport.seek(t) : transport.cue(t)),
    setLoop: ({a, b}) => transport.loopRange(a, b, {snap: 'bar'}),
    isPlaying: () => PLAYING.has(snapshot()?.phase),
  };
  const drumsTrack = () => snapshot()?.mix?.tracks?.find((t) => t.name === 'drums') ?? null;
  const mix = {
    hasRecordedDrums: () => !!drumsTrack(),
    recordedDrumsOut: () => !!drumsTrack()?.muted,
    toggleRecordedDrums: () => { const t = drumsTrack(); if (t) transport.setMuted('drums', !t.muted); },
  };
  const listen = {
    mode: () => notation.listenMode,
    setMode: (m) => notation.setListenMode(m),
    level: () => notation.drumAudio.level,
    setLevel: (x) => notation.drumAudio.setLevel(x),
  };
  const drumKeys = {
    get: () => prefs.get('edit.chart.keys') ?? {},
    save: (keys) => { prefs.set('edit.chart.keys', keys); commands?.setDrumKeys?.(keys); },
    reserved: () => reservedScoreKeys(registry),
  };
  const router = () => registry.context().router ?? null;
  const songId = () => session.id ?? session.song?.peek?.()?.id;
  function openMap(_q, {bar} = {}) {
    const n = Number.isInteger(bar) ? bar + 1 : null;
    const path = `/s/${encodeURIComponent(songId())}/edit/map${n ? `?bar=${n}` : ''}`;
    const r = router();
    if (r?.navigate) r.navigate(path, {replace: true});
    else if (edit?.setTab) edit.setTab('map');
  }
  async function openDrumImport() {
    const file = await chooseFile(COPY.importAccept);
    if (!file || destroyed) return;
    say(COPY.importing);
    try {
      const result = await importDrums(file, {session, confirmReplace: replaceDialog(confirm)});
      if (destroyed) return;
      say(result?.canceled ? '' : COPY.imported(result?.count ?? 0, result?.skipped ?? 0, !!result?.replaced));
    } catch (err) {
      if (!destroyed) say(err?.message || COPY.importFailed);
    }
  }

  // ---- layout: wide (inspector tabs on the right) or portrait (sheets and the kit bank) ---------------------
  function placePanels() {
    closeSheet();
    if (layout === 'wide' && inspectorEl && workspace) {
      if (!tabs) {
        tabs = Tabs({
          label: COPY.inspector, variant: 'section', activation: 'auto',
          tabs: INSPECTOR_TABS.map((id) => ({id, label: COPY.tabs[id], controls: panels[id].id})),
          value: workspace.state().inspectorTab,
          onChange: (id) => workspace.run('setInspectorTab', id),
        });
        for (const id of INSPECTOR_TABS) panels[id].setAttribute('aria-labelledby', tabs.tabId(id));
      }
      inspectorRoot.replaceChildren(tabs.el, ...INSPECTOR_TABS.map((id) => panels[id]));
      if (inspectorRoot.parentNode !== inspectorEl) inspectorEl.append(inspectorRoot);
      syncTabs(workspace.state());
    } else {
      inspectorRoot.remove();
      for (const id of INSPECTOR_TABS) { panels[id].hidden = false; parked.append(panels[id]); }
    }
    if (layout === 'portrait') dock.prepend(toolHost); else root.prepend(toolHost);
    panelButtons.hidden = layout !== 'portrait' || !workspace;
    bankHost.hidden = layout !== 'portrait' || !workspace;
  }
  function syncTabs(state) {
    if (!tabs || !state) return;
    tabs.set({value: state.inspectorTab});
    for (const id of INSPECTOR_TABS) panels[id].hidden = id !== state.inspectorTab;
  }
  function setLayout(next) {
    if (next === layout) return;
    layout = next;
    root.dataset.layout = layout;
    placePanels();
  }

  // iPad portrait: each inspector tab is a sheet (a modal overlay, D36: Esc closes it first).
  function openSheet(tab) {
    if (!workspace) return;
    closeSheet();
    workspace.run('setInspectorTab', tab);
    sheetTab = tab;
    const panel = panels[tab];
    panel.hidden = false;
    sheet = Sheet({
      title: COPY.tabs[tab], content: panel, layout: 'bottom', modal: true, detents: [45, 90], initialDetent: 45,
      className: 'chart-edit-sheet',
      onClose: () => { parked.append(panel); sheet = null; sheetTab = null; syncPanelButtons(); workspace?.focus(); },
    });
    syncPanelButtons();
  }
  function closeSheet() {
    const s = sheet;
    sheet = null;
    sheetTab = null;
    s?.close('layout');
  }
  const sheetButtons = Object.fromEntries(INSPECTOR_TABS.map((tab) => {
    const b = Button({label: COPY.tabs[tab], size: 'md', variant: 'secondary', className: 'chart-edit-panel-button',
      attrs: {'aria-haspopup': 'dialog', 'aria-expanded': 'false'}, onClick: () => openSheet(tab)});
    panelButtons.append(b.el);
    return [tab, b];
  }));
  function syncPanelButtons() {
    for (const [tab, b] of Object.entries(sheetButtons)) b.el.setAttribute('aria-expanded', String(sheetTab === tab));
  }

  if (edit?.layout?.subscribe) {
    cleanup(edit.layout.subscribe((v) => setLayout(v === 'portrait' ? 'portrait' : 'wide')));
  } else if (typeof window !== 'undefined') {
    let timer = null;
    const onResize = () => { clearTimeout(timer); timer = setTimeout(() => setLayout(windowLayout()), RESIZE_MS); };
    window.addEventListener('resize', onResize);
    cleanup(() => { clearTimeout(timer); window.removeEventListener('resize', onResize); });
  }

  // ---- menus ----------------------------------------------------------------------------------------------------
  let menu = null;
  function openMenu(name, anchor) {
    if (!workspace) return;
    menu?.close();
    const state = workspace.state();
    const run = (...args) => workspace.run(...args);
    const menus = workspace.menus();
    const items = {
      view: () => viewMenu(state),
      tuplet: () => tupletMenu(state, run),
      grid: () => gridMenu(state, run),
      edit: () => menus.edit,
      part: () => menus.part,
      sections: () => menus.sections,
    }[name]?.();
    if (!items?.length) return;
    const label = {view: COPY.viewOptions, tuplet: COPY.tuplet, grid: COPY.grid, edit: COPY.edit, part: COPY.part, sections: COPY.sections}[name];
    menu = Menu({items, anchor, label, registry, onClose: () => { menu = null; }});
  }

  // ---- the workspace --------------------------------------------------------------------------------------------
  function onState(state) {
    toolbar?.update(state);
    kitBank?.update(state);
    if (state.message !== undefined && message.textContent !== state.message) say(state.message);
    if (state.inspectorTab !== lastTab) {
      const changed = lastTab !== null;
      lastTab = state.inspectorTab;
      syncTabs(state);
      // Double-clicking a note opens Properties: on iPad portrait that is its sheet.
      if (changed && layout === 'portrait' && sheetTab && sheetTab !== state.inspectorTab) openSheet(state.inspectorTab);
    }
    if (edit?.saveStatus && 'value' in edit.saveStatus) edit.saveStatus.value = saveStatusOf(state, (...a) => workspace?.run(...a));
    registry.invalidate();
  }

  async function build(part) {
    const song = session.song?.peek?.() ?? {};
    const ws = await createNotationWorkspace({
      host: main,
      slots: {inspector: panels, status: null},
      part, song, engine: session.engine, songMap: session.map,
      transport: tr, mix, drumAudio: () => notation.drumAudio, listen, drumKeys, prefs,
      openMap, openDrumImport, dialog, confirm,
    });
    if (destroyed) { ws.destroy(); return; }
    workspace = ws;
    toolbar = createToolbar({run: (...a) => ws.run(...a), registry, openMenu, saveStatus: !edit?.saveStatus});
    toolHost.replaceChildren(toolbar.el);
    kitBank = createKitBank({run: (...a) => ws.run(...a)});
    bankHost.replaceChildren(kitBank.el);
    commands?.setDrumKeys?.(drumKeys.get());
    cleanup(registry.provide('chart', () => workspace));
    cleanup(ws.subscribe(onState));
    if (session.frame?.subscribe) cleanup(session.frame.subscribe((f) => ws.tick(f.position)));
    // The Mix sheet and the Stage share the Recorded drums switch and chart playback: redraw Listen when they change.
    if (transport.snapshot?.subscribe) {
      const mixKey = (s) => `${!!s?.mix?.tracks?.find((t) => t.name === 'drums')?.muted}|${s?.mix?.chartAudio ?? ''}`;
      let last = mixKey(snapshot());
      cleanup(transport.snapshot.subscribe((s) => {
        const key = mixKey(s);
        if (key !== last) { last = key; ws.run('refresh'); }
      }));
    }
    const paging = prefs.get('edit.chart.paging');
    if (ws.state().pagingModes.includes(paging)) ws.setPaging(paging);
    const bar = Number(query?.bar);
    if (Number.isInteger(bar) && bar >= 1) ws.run('goToBar', bar - 1);
    showNotice(null);
    root.dataset.state = 'ready';
    placePanels();
    onState(ws.state());
    ws.setVisible(true);
    ws.focus();
  }

  let attempt = 0;
  async function start() {
    const mine = ++attempt;
    root.dataset.state = 'opening';
    showNotice(COPY.opening, {busy: true});
    if (edit?.saveStatus && 'value' in edit.saveStatus) edit.saveStatus.value = null;
    if (session.readOnly || notation?.readOnly) {
      root.dataset.state = 'read-only';
      showNotice(COPY.readOnly);
      return;
    }
    try {
      await notation.open();
      if (destroyed || mine !== attempt) return;
      const part = notation.part;
      if (!part?.editor) {
        root.dataset.state = 'empty';
        showNotice(COPY.noPart);
        return;
      }
      await build(part);
    } catch (err) {
      if (destroyed || mine !== attempt) return;
      console.warn('[chart] the drum part could not be opened', err);
      root.dataset.state = 'error';
      showNotice(COPY.openFailed, {retry: true});
    }
  }
  const ready = start();

  return {
    root,
    ready,
    get workspace() { return workspace; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      menu?.close();
      closeSheet();
      for (const fn of cleanups.splice(0).reverse()) { try { fn(); } catch (err) { console.warn('[chart] cleanup failed', err); } }
      void workspace?.flush?.();
      workspace?.destroy();
      toolbar?.destroy();
      kitBank?.destroy();
      tabs?.destroy();
      for (const b of Object.values(sheetButtons)) b.destroy();
      inspectorRoot.remove();
      if (edit?.saveStatus && 'value' in edit.saveStatus) edit.saveStatus.value = null;
      root.remove();
      registry.invalidate();
    },
  };
}

/** The time of bar `index` (0-based) on the part's timeline; the harness and tests use it. */
export function barTime(part, index) {
  const t = part?.score?.timeline;
  return t ? toTime(t, number(musicalStarts(t)[index])) : 0;
}

export default mount;
