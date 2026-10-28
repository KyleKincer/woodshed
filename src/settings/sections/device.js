// Settings → This device (architecture §2.17, §2.11, D13, D40; spec §6.2, §4.2, §8.4): facts about
// this browser or computer, plus the one device pref that lives here.
//   Install as app       the platform's steps (install.state.steps): iOS/iPadOS "Share → Add to Home
//                        Screen", Chromium's install prompt ([Install Woodshed]) or its menu, installed,
//                        or a browser that cannot install; not shown in Woodshed for desktop
//   Keep screen awake    wake-lock support (the desktop app keeps the display on itself) and, where
//                        the lock may not hold (no support, or iOS/iPadOS), the tip "Set Auto-Lock to
//                        Never while practising."
//   Media keys           Supported / Not supported ('mediaSession' in navigator, D13); no promise
//                        about headset buttons
//   Announce sections while playing   prefs.practice.announceSections (off by default, spec §8.4)
//   Version              the web build's version, or the desktop app's (desktop.info())
//   Check for updates    desktop only: desktop.update('show'), with the update state (store.update)
//   Licenses             every file in public/licenses, shown in a Dialog from a ?raw import
// On the web, Check for updates is not shown (the web app updates itself), never shown disabled.

import '../../styles/views/settings/sections.css';
import {version as webVersion} from '../../../package.json';
import {h} from '../../ui/h.js';
import {Button, uid} from '../../ui/button.js';
import {Dialog} from '../../ui/dialog.js';
import {Toggle} from '../../ui/toggle.js';
import {createSaver, settingRow} from '../settings.js';
import {COPY, LICENSE_NAMES, SECTION_TITLES} from '../settings.copy.js';

const D = COPY.device;

/** Licence texts by basename, loaded on demand (public/licenses/*.txt, as raw strings). */
export const LICENSE_FILES = import.meta.glob('../../../public/licenses/*.txt', {query: '?raw', import: 'default'});

/** [{id, name, load}] in LICENSE_NAMES order, then any other file by name. */
export function licenses(files = LICENSE_FILES) {
  const known = Object.keys(LICENSE_NAMES);
  return Object.entries(files)
    .map(([path, load]) => {
      const id = path.split('/').pop().replace(/\.txt$/, '');
      return {id, name: LICENSE_NAMES[id] ?? id, load};
    })
    .sort((a, b) => {
      const ia = known.indexOf(a.id), ib = known.indexOf(b.id);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0 || ib >= 0) return ia >= 0 ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

/** The install row's text for an install state, or null when the button replaces it. */
export function installText(state) {
  if (!state) return D.install.none;
  if (state.installed) return D.install.installed;
  if (state.steps === 'ios') return D.install.ios;
  if (state.steps === 'chromium') return state.canPrompt ? null : D.install.chromium;
  return D.install.none;
}

/** The update line for a desktop update state (store.update), or '' when there is nothing to say. */
export function updateText(update) {
  switch (update?.status) {
    case 'checking': return D.updates.checking;
    case 'available': return D.updates.available(update.version);
    case 'downloading': return D.updates.downloading(Math.max(0, Math.min(100, Math.round(Number(update.percent) || 0))));
    case 'ready': return D.updates.ready;
    case 'current': return D.updates.current;
    case 'error': return D.updates.error;
    default: return '';
  }
}

function render(el, ctx) {
  const {prefs, platform, desktop, install, store} = ctx;
  const desktopApp = !!(platform?.isDesktopApp || desktop?.available);
  const parts = [];
  const offs = [];
  const keep = part => { parts.push(part); return part; };
  const rows = [];
  let destroyed = false;

  // ---- Install as app (browsers only)
  if (!desktopApp) {
    const text = h('p', {class: 'settings-value'});
    const result = h('p', {class: 'settings-row-hint', role: 'status'});
    const button = keep(Button({label: D.install.button, icon: 'download', variant: 'primary', onClick: async () => {
      result.textContent = '';
      const outcome = await install.prompt();
      if (!destroyed && outcome === 'dismissed') result.textContent = D.install.dismissed;
    }}));
    const row = settingRow({row: 'install', label: D.install.label, scope: 'info', controls: [text, button, result]});
    const show = state => {
      const line = installText(state);
      text.textContent = line ?? '';
      text.hidden = line == null;
      button.el.hidden = line != null;
    };
    show(install.state.peek());
    offs.push(install.state.subscribe(show));
    rows.push(row);
  }

  // ---- Keep screen awake (support)
  {
    const supported = desktopApp || !!platform?.features?.wakeLock;
    const line = desktopApp ? D.wake.desktop : supported ? D.wake.supported : D.wake.unsupported;
    const tip = !desktopApp && (!supported || platform?.isIOS) ? h('p', {class: 'settings-tip'}, D.wake.tip) : null;
    rows.push(settingRow({row: 'wakeLock', label: D.wake.label, scope: 'info', controls: [h('p', {class: 'settings-value', dataset: {supported}}, line), tip]}));
  }

  // ---- Media keys (D13)
  {
    const supported = !!platform?.features?.mediaSession;
    rows.push(settingRow({row: 'mediaKeys', label: D.mediaKeys.label, scope: 'info',
      controls: [h('p', {class: 'settings-value', dataset: {supported}}, supported ? D.mediaKeys.supported : D.mediaKeys.unsupported)]}));
  }

  // ---- Announce sections while playing (this device)
  {
    let toggle;
    const id = uid('settings-row');
    const saver = keep(createSaver({focus: () => toggle.el}));
    toggle = keep(Toggle({
      label: D.announce.label, pressed: !!prefs.get('practice.announceSections'), className: 'settings-toggle',
      attrs: {'aria-describedby': `${id}-hint`},
      onChange: pressed => saver.run(() => prefs.set('practice.announceSections', pressed)),
    }));
    offs.push(prefs.value.subscribe(() => toggle.set({pressed: !!prefs.get('practice.announceSections')})));
    rows.push(settingRow({row: 'announceSections', hint: D.announce.hint, scope: 'device', controls: [toggle], saver, labelId: id}));
  }

  // ---- Version and, on desktop, Check for updates
  {
    const versionText = h('p', {class: 'settings-value'},
      desktopApp ? D.version.desktop(webVersion) : D.version.web(webVersion));
    const controls = [versionText];
    if (desktopApp) {
      Promise.resolve(desktop.info?.()).then(info => {
        if (!destroyed && info?.version) versionText.textContent = D.version.desktop(info.version);
      }, () => {});
      const line = h('p', {class: 'settings-row-hint', role: 'status'});
      const check = keep(Button({label: D.updates.button, icon: 'refresh-cw', onClick: async () => {
        check.set({busy: true});
        try {
          const state = await desktop.update('show');
          if (!destroyed && state?.status) line.textContent = updateText(state);
        } catch (err) {
          console.warn('[settings] the update check failed:', err?.message ?? err);
          if (!destroyed) line.textContent = D.updates.error;
        } finally {
          if (!destroyed) check.set({busy: false});
        }
      }}));
      const showUpdate = update => { line.textContent = updateText(update); };
      showUpdate(store.update.peek());
      offs.push(store.update.subscribe(showUpdate));
      controls.push(check, line);
    }
    rows.push(settingRow({row: 'version', label: D.version.label, scope: 'info', controls}));
  }

  // ---- Licenses
  {
    const buttons = licenses(ctx.licenseFiles ?? LICENSE_FILES).map(item => keep(Button({
      label: item.name, variant: 'quiet', size: 'sm', className: 'settings-license', onClick: () => openLicense(item),
    })));
    rows.push(settingRow({row: 'licenses', label: D.licenses.label, hint: D.licenses.hint, scope: 'info',
      controls: [h('div', {class: 'settings-licenses'}, buttons.map(b => b.el))]}));
  }

  let dialog = null;
  function openLicense(item) {
    dialog?.destroy();
    const text = h('pre', {class: 'settings-license-text', tabindex: '0', 'aria-label': item.name}, D.licenses.loading);
    dialog = Dialog({title: item.name, body: text, width: 640, actions: [{label: D.licenses.close, value: null, variant: 'secondary', autofocus: true}]});
    Promise.resolve().then(() => item.load()).then(
      body => { text.textContent = String(body ?? ''); },
      err => {
        console.error(`[settings] the ${item.id} licence could not load`, err);
        text.textContent = D.licenses.failed;
      });
  }

  const page = h('div', {class: 'settings-section', dataset: {section: 'device'}}, h('div', {class: 'settings-group'}, rows.map(r => r.el)));
  el.replaceChildren(page);

  return {
    destroy() {
      destroyed = true;
      dialog?.destroy();
      for (const off of offs.splice(0)) off();
      for (const part of parts.splice(0)) part.destroy();
      page.remove();
    },
  };
}

export default Object.freeze({id: 'device', title: SECTION_TITLES.device, render});
