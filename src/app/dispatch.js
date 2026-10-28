// The keyboard dispatcher (architecture §2.6): the app's only document-level keydown/keyup listeners. It resolves every
// key against the overlay stack, focus scopes and the active scope chain, and leaves everything else native.
//
// DOM declarations it reads:
//   data-scope="edit.chart.score"   a focus scope while document.activeElement is inside the element
//   data-consume-keys="ArrowLeft …"  keys a focused widget handles itself (sliders, steppers, faders, radiogroups, tablists, grids)
//   data-text-input                  custom text widgets (native input, textarea, select and contenteditable are detected)

import {registry as appRegistry} from './commands.js';
import {normalize} from './keys.js';

const PLACE_SCOPES = new Set(['library', 'settings', 'admin']);
const EDIT_TABS = new Set(['map', 'chart', 'details']);
const INTERACTIVE = ['button', 'a[href]', 'summary', 'input[type=checkbox]', 'input[type=radio]', 'input[type=button]',
  'input[type=submit]', 'input[type=reset]', '[role=button]', '[role=menuitem]', '[role=menuitemcheckbox]',
  '[role=menuitemradio]', '[role=option]', '[role=tab]', '[role=checkbox]', '[role=switch]'].join(',');
const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'submit', 'reset', 'hidden']);

const overlays = [];                // [{el, modal, onEscape, scope}], topmost last
let surfaceScope = null;
let pedalHandler = null;
let activeRegistry = appRegistry;
let activePlatform;                 // undefined → keys.js decides
let activeDocument = typeof document !== 'undefined' ? document : null;
const prevented = new Set();        // codes whose keydown we preventDefault()ed; their keyup is prevented too
const pedalCodes = new Set();       // codes whose keydown went to the pedal handler
let stopCurrent = null;

// ---------------------------------------------------------------------------------------------------------------
// Public API

/**
 * Installs the window capture keydown and keyup listeners and returns `stop`. Options exist for tests and the fixture:
 * `target` (default window), `registry` (default the app registry) and `platform` (the Mod platform, see keys.setPlatform).
 */
export function startDispatcher({target = globalThis.window, registry = appRegistry, platform} = {}) {
  stopCurrent?.();
  activeRegistry = registry;
  activePlatform = platform;
  activeDocument = target?.document ?? (typeof document !== 'undefined' ? document : null);
  const onKeydown = e => handleKeydown(e);
  const onKeyup = e => handleKeyup(e);
  const onBlur = () => prevented.clear();
  target.addEventListener('keydown', onKeydown, true);
  target.addEventListener('keyup', onKeyup, true);
  target.addEventListener('blur', onBlur);
  const stop = () => {
    target.removeEventListener('keydown', onKeydown, true);
    target.removeEventListener('keyup', onKeyup, true);
    target.removeEventListener('blur', onBlur);
    prevented.clear();
    pedalCodes.clear();
    if (stopCurrent === stop) { stopCurrent = null; activeRegistry = appRegistry; activePlatform = undefined; }
  };
  stopCurrent = stop;
  return stop;
}

/**
 * Pushes an overlay. Modal overlays (Dialog, palette, menus, the /add sheet, Edit iPad inspector sheets) take every key
 * except their own scope's bindings and Esc; non-modal overlays (Stage sheets and popovers, the Notes card, the Jobs
 * popover) let registry keys through and close on Esc (D36). Returns `pop` (idempotent).
 */
export function pushOverlay({el = null, modal = false, onEscape, scope = null} = {}) {
  const entry = {el, modal: !!modal, onEscape: typeof onEscape === 'function' ? onEscape : null, scope: scope || null};
  overlays.push(entry);
  return () => {
    const at = overlays.indexOf(entry);
    if (at >= 0) overlays.splice(at, 1);
  };
}

/** The open overlays, bottom first (a copy). */
export function openOverlays() {
  return overlays.map(o => ({...o}));
}

/** 'stage.stems' while the Stems surface is shown (D24); null otherwise. */
export function setSurfaceScope(name) {
  surfaceScope = name || null;
  activeRegistry.invalidate();
}

/**
 * The scopes a key is looked up in right now, innermost first: focus scopes around the focused element, then the
 * surface scope, posture scopes, the place scope and 'global'. Overlays are not included (the ? sheet reads this
 * before it opens).
 */
export function activeScopeChain() {
  const ctx = activeRegistry.context();
  return [...focusScopes(focusedElement()), ...chainFor(ctx)];
}

/** Installs the pedal handler (pedals.startPedals) or removes it with null. */
export function setPedalHandler(handler) {
  if (handler != null && (typeof handler.owns !== 'function' || typeof handler.down !== 'function' || typeof handler.up !== 'function')) {
    throw new TypeError('A pedal handler needs owns(e), down(e) and up(e).');
  }
  pedalHandler = handler ?? null;
  pedalCodes.clear();
}

// ---------------------------------------------------------------------------------------------------------------
// Element tests

function focusedElement() {
  let el = activeDocument?.activeElement ?? null;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

function ancestors(el) {
  const out = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentElement ?? n.getRootNode?.()?.host ?? null) out.push(n);
  return out;
}

function isTextInput(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has(String(el.type || 'text').toLowerCase());
  if (el.isContentEditable) return true;
  return ancestors(el).some(n => n.hasAttribute('data-text-input') ||
    (n.hasAttribute('contenteditable') && n.getAttribute('contenteditable') !== 'false'));
}

function keyTokens(e) {
  const tokens = new Set([e.key, e.code]);
  if (e.key === ' ' || e.code === 'Space') tokens.add('Space');
  if (e.key === 'Esc') tokens.add('Escape');
  return tokens;
}

/** The focused element or an ancestor declares it handles this key itself. */
function consumes(el, e) {
  const tokens = keyTokens(e);
  return ancestors(el).some(n => {
    const list = n.getAttribute('data-consume-keys');
    return list != null && list.split(/\s+/).some(t => t && tokens.has(t));
  });
}

function focusScopes(el) {
  const out = [];
  for (const n of ancestors(el)) {
    const name = n.getAttribute('data-scope');
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function editTab(ctx) {
  const r = ctx.route;
  const tab = r?.params?.tab ?? r?.route?.params?.tab ?? (r?.name === 'bulkDetails' ? 'details' : null) ?? ctx.edit?.tab ?? null;
  return EDIT_TABS.has(tab) ? tab : null;
}

/** Rule 9's chain: surface → posture scopes → place scope → global. */
function chainFor(ctx) {
  const out = [];
  if (surfaceScope) out.push(surfaceScope);
  const posture = ctx.posture;
  if (posture === 'stage') out.push('stage');
  else if (posture === 'edit') {
    const tab = editTab(ctx);
    if (tab) out.push(`edit.${tab}`);
    out.push('edit');
  }
  if (PLACE_SCOPES.has(ctx.place)) out.push(ctx.place);
  out.push('global');
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Keydown

function lookup(scope, candidates, ctx) {
  for (const key of candidates) {
    for (const def of activeRegistry.defsFor(scope, key)) {
      if (activeRegistry.passes(def, ctx)) return def;
    }
  }
  return null;
}

function take(e) {
  e.preventDefault();
  prevented.add(e.code || e.key);
}

function fire(def, e) {
  take(e);
  if (e.repeat && !def.repeat) return;
  activeRegistry.run(def.id, {source: 'key', event: e});
}

function plainOf(e) {
  return !e.ctrlKey && !e.metaKey && !e.altKey;
}

function closeTop() {
  overlays[overlays.length - 1]?.onEscape?.();
}

function handleKeydown(e) {
  // 1. Ignored events.
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.key === 'Dead') return;
  if (e.key === 'Tab' && plainOf(e)) return;

  // 2. Pedals.
  if (pedalHandler && pedalHandler.owns(e)) {
    e.preventDefault();
    pedalCodes.add(e.code);
    pedalHandler.down(e);
    return;
  }

  const candidates = normalize(e, {platform: activePlatform});
  const isEscape = candidates.includes('Escape');
  const ctx = activeRegistry.context({source: 'key', event: e});
  const el = focusedElement();

  // 3. A modal overlay takes every key except its own bindings and Esc.
  let modalAt = -1;
  for (let i = overlays.length - 1; i >= 0; i--) if (overlays[i].modal) { modalAt = i; break; }
  if (modalAt >= 0) {
    for (let i = overlays.length - 1; i >= modalAt; i--) {
      const scope = overlays[i].scope;
      const def = scope ? lookup(scope, candidates, ctx) : null;
      if (def) { fire(def, e); return; }
    }
    if (isEscape) { take(e); closeTop(); }
    return;
  }

  let toChain = false;
  // 4. Text input: only Esc (close the overlay, else blur) and Mod+K pass.
  if (isTextInput(el)) {
    if (isEscape) {
      if (consumes(el, e)) return;
      take(e);
      if (overlays.length) closeTop(); else el.blur?.();
      return;
    }
    if (!candidates.includes('Mod+KeyK')) return;
    toChain = true;
  }

  if (!toChain) {
    // 5. The focused widget handles this key itself.
    if (el && plainOf(e) && consumes(el, e)) return;

    // 6. Focus scopes, innermost first; a stop scope ends the key unless it is in its pass-through list.
    for (const name of focusScopes(el)) {
      const def = lookup(name, candidates, ctx);
      if (def) { fire(def, e); return; }
      const scope = activeRegistry.getScope(name);
      if (scope?.stop) {
        if (scope.passThrough.some(k => candidates.includes(k))) break;
        return;
      }
    }

    // 7. Enter on a keyboard-focused interactive element is native; Space too, outside the Stage and Edit postures.
    if (el && el.matches?.(INTERACTIVE) && plainOf(e)) {
      if (e.key === 'Enter') return;
      if ((e.key === ' ' || e.code === 'Space') && ctx.posture !== 'stage' && ctx.posture !== 'edit') return;
    }

    // 8. Esc closes the topmost non-modal overlay.
    if (isEscape && overlays.length) { take(e); closeTop(); return; }
  }

  // 9. The scope chain.
  for (const scope of chainFor(ctx)) {
    const def = lookup(scope, candidates, ctx);
    if (def) { fire(def, e); return; }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Keyup

function handleKeyup(e) {
  if (pedalCodes.has(e.code) || (pedalHandler && pedalHandler.owns(e))) {
    pedalCodes.delete(e.code);
    e.preventDefault();
    pedalHandler?.up(e);
    return;
  }
  const code = e.code || e.key;
  if (prevented.has(code)) {
    prevented.delete(code);
    e.preventDefault();
  }
}
