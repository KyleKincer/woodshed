// Key-string grammar (architecture §2.6).
//
//   KeyString := (Mod+)?(Ctrl+)?(Alt+)?(Shift+)?Base        canonical modifier order
//   Mod  = ⌘ (metaKey) on macOS/iPadOS, Ctrl elsewhere. 'Ctrl+' is the real Control key (⌃⌥ background shortcuts);
//          on platforms where Mod already is Control, 'Ctrl+' and 'Mod+' name the same modifier.
//   Base = code   KeyA…KeyZ, Digit0…Digit9 (matched on e.code, layout-independent)
//        | named  Space Enter Escape Backspace Delete Tab ArrowLeft ArrowRight ArrowUp ArrowDown Home End PageUp PageDown ContextMenu F10
//        | symbol , . [ ] ` = - \ / * ?  (matched on e.key, with aliases)
//
// Pure apart from two module settings: the platform used for Mod (setPlatform) and the cached keyboard
// layout map used for letter labels (setLayoutMap / loadLayoutMap, D56).

export const NAMED_KEYS = Object.freeze(['Space', 'Enter', 'Escape', 'Backspace', 'Delete', 'Tab', 'ArrowLeft', 'ArrowRight',
  'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'ContextMenu', 'F10']);
export const SYMBOL_KEYS = Object.freeze([',', '.', '[', ']', '`', '=', '-', '\\', '/', '*', '?']);

/** Unshifted symbols that also match another e.key value ('=' is also '+', '-' is also the minus sign). */
export const ALIAS = Object.freeze({'=': Object.freeze(['+']), '-': Object.freeze(['−'])});
/** The US physical key of a symbol, so 'Shift+,' matches Shift+Comma whatever the layout prints. */
export const US_CODE = Object.freeze({',': 'Comma', '.': 'Period', '[': 'BracketLeft', ']': 'BracketRight', '`': 'Backquote'});
/** Symbols matched on e.key alone; Shift is ignored because most layouts need it to type them. */
const SHIFT_FREE = new Set(['?', '*']);
/** The US physical key that types each symbol without Shift; anywhere else, the layout needed Shift or Option to type it. */
const US_PLAIN_CODE = Object.freeze({',': 'Comma', '.': 'Period', '[': 'BracketLeft', ']': 'BracketRight', '`': 'Backquote',
  '=': 'Equal', '-': 'Minus', '\\': 'Backslash', '/': 'Slash'});
const LETTER_RE = /^Key[A-Z]$/;
const NUMPAD_DIGIT_RE = /^Numpad([0-9])$/;

const NAMED = new Set(NAMED_KEYS);
const SYMBOLS = new Set(SYMBOL_KEYS);
const CODE_RE = /^(Key[A-Z]|Digit[0-9])$/;
const MODIFIERS = ['Mod', 'Ctrl', 'Alt', 'Shift'];
const ALIAS_TO_SYMBOL = new Map(Object.entries(ALIAS).flatMap(([symbol, list]) => list.map(alias => [alias, symbol])));
const CODE_TO_SYMBOL = new Map(Object.entries(US_CODE).map(([symbol, code]) => [code, symbol]));
// Legacy and platform spellings of KeyboardEvent.key values.
const KEY_SPELLINGS = {' ': 'Space', Spacebar: 'Space', Esc: 'Escape', Del: 'Delete', Left: 'ArrowLeft', Right: 'ArrowRight',
  Up: 'ArrowUp', Down: 'ArrowDown', Apps: 'ContextMenu'};

// ---------------------------------------------------------------------------------------------------------------
// Platform

let currentPlatform = null;
let layoutMap = null;

/** Detects whether Mod is ⌘ from a navigator-like object (macOS, iPadOS — including iPads that report MacIntel — iOS). */
export function detectMacLike(nav = globalThis.navigator) {
  if (!nav) return false;
  const hinted = nav.userAgentData?.platform;
  if (typeof hinted === 'string' && hinted) return /mac|ios|iphone|ipad/i.test(hinted);
  const p = String(nav.platform || '');
  if (/Mac|iPhone|iPad|iPod/.test(p)) return true;
  return /iPhone|iPad|iPod/.test(String(nav.userAgent || ''));
}

/**
 * Sets the platform used for 'Mod' when callers pass no `platform` option (main.js sets it from platform.detect()).
 * Accepts 'mac' | 'ipad' | 'ios' | 'win' | 'linux' | 'other', a platform object ({isMac, isIPad, isIOS}), or null to re-detect.
 */
export function setPlatform(platform) { currentPlatform = platform ?? null; }

/** True when Mod is ⌘ (metaKey) for this platform value (see setPlatform for the accepted shapes). */
export function isMacLike(platform = currentPlatform) {
  if (platform == null) return detectMacLike();
  if (typeof platform === 'string') return ['mac', 'macos', 'ipad', 'ios', 'iphone'].includes(platform.toLowerCase());
  if (typeof platform === 'object') return !!(platform.isMac || platform.isIPad || platform.isIOS || platform.mac);
  return false;
}

/** Caches a keyboard layout map (`Map<code, char>`, e.g. from navigator.keyboard.getLayoutMap()) for letter labels; null clears it. */
export function setLayoutMap(map) { layoutMap = map ?? null; }

/** Loads navigator.keyboard.getLayoutMap() when available and caches it. Resolves true when a map was loaded. */
export async function loadLayoutMap(nav = globalThis.navigator) {
  try {
    const map = await nav?.keyboard?.getLayoutMap?.();
    if (map && typeof map.get === 'function') { layoutMap = map; return true; }
  } catch { /* Not allowed in this frame or not supported: the US letter is used. */ }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Grammar

const parsed = new Map();

/** Parses a KeyString. Modifiers may come in any order; unknown parts throw. */
export function parseKey(str) {
  if (typeof str !== 'string' || !str) throw new TypeError(`Invalid key string: ${JSON.stringify(str)}`);
  const hit = parsed.get(str);
  if (hit) return hit;
  // A trailing '+' is a base only when the whole string is '+', which the grammar spells '='; so split on '+'
  // and treat an empty last part (e.g. 'Mod++') as an error rather than a key.
  const parts = str.split('+');
  const base = parts.pop();
  const mods = {mod: false, ctrl: false, alt: false, shift: false};
  for (const part of parts) {
    const name = part === 'Cmd' || part === 'Meta' ? 'Mod' : part === 'Control' ? 'Ctrl' : part === 'Option' ? 'Alt' : part;
    if (!MODIFIERS.includes(name)) throw new TypeError(`Invalid modifier "${part}" in key string "${str}"`);
    const keyName = name.toLowerCase();
    if (mods[keyName]) throw new TypeError(`Repeated modifier "${part}" in key string "${str}"`);
    mods[keyName] = true;
  }
  let kind;
  if (CODE_RE.test(base)) kind = 'code';
  else if (NAMED.has(base)) kind = 'named';
  else if (SYMBOLS.has(base)) kind = 'symbol';
  else throw new TypeError(`Invalid key "${base}" in key string "${str}"`);
  const result = Object.freeze({...mods, base, kind});
  parsed.set(str, result);
  return result;
}

/** True when the string parses. */
export function isValidKey(str) {
  try { parseKey(str); return true; } catch { return false; }
}

function format({mod, ctrl, alt, shift, base}) {
  return `${mod ? 'Mod+' : ''}${ctrl ? 'Ctrl+' : ''}${alt ? 'Alt+' : ''}${shift ? 'Shift+' : ''}${base}`;
}

/** The canonical spelling of a KeyString (modifier order Mod, Ctrl, Alt, Shift; '?' and '*' never carry Shift). */
export function canonical(str) {
  const p = parseKey(str);
  return format(SHIFT_FREE.has(p.base) ? {...p, shift: false} : p);
}

// ---------------------------------------------------------------------------------------------------------------
// Matching

function eventMods(event, mac) {
  const meta = !!event.metaKey, ctrlKey = !!event.ctrlKey;
  return mac
    ? {mod: meta, ctrl: ctrlKey, alt: !!event.altKey, shift: !!event.shiftKey, extra: false}
    // Elsewhere Mod is Control; the Windows/Super key has no spelling, so a held meta key matches nothing.
    : {mod: ctrlKey, ctrl: false, alt: !!event.altKey, shift: !!event.shiftKey, extra: meta};
}

function namedBase(event) {
  if (event.code === 'Space' || event.key === ' ') return 'Space';
  const key = KEY_SPELLINGS[event.key] ?? event.key;
  return NAMED.has(key) ? key : null;
}

/**
 * Candidate KeyStrings for a KeyboardEvent, in lookup order: the code form (letters and digits), the named form, then
 * the symbol forms. Empty when a modifier is down that no KeyString can express.
 */
export function normalize(event, {platform} = {}) {
  if (!event) return [];
  const mac = isMacLike(platform === undefined ? currentPlatform : platform);
  const m = eventMods(event, mac);
  if (m.extra) return [];
  const out = [];
  const push = s => { if (!out.includes(s)) out.push(s); };
  // On non-Mac platforms the Control key is Mod; offer the 'Ctrl+' spelling as well so ⌃⌥ strings still bind.
  const withMods = (mods, base) => {
    push(format({...mods, base}));
    if (!mac && mods.mod) push(format({...mods, mod: false, ctrl: true, base}));
  };
  const key = typeof event.key === 'string' ? event.key : '';
  let code = typeof event.code === 'string' ? event.code : '';
  // Numpad digits are Digit0…9 (NumLock off reports Home, End, arrows… as e.key instead; those match as named keys).
  const numpad = NUMPAD_DIGIT_RE.exec(code);
  if (numpad && key === numpad[1]) code = `Digit${numpad[1]}`;
  // A layout that puts '?' or '*' on a letter key (AZERTY: Shift+KeyM is '?') means that character, not the letter.
  const characterOnLetter = LETTER_RE.test(code) && SHIFT_FREE.has(key);
  if (CODE_RE.test(code) && !characterOnLetter) withMods(m, code);
  const named = namedBase(event);
  if (named) withMods(m, named);

  // AltGr (reported as Ctrl+Alt on Windows) is how many layouts type [ ] \ and friends; it is not a shortcut modifier there.
  const altGraph = typeof event.getModifierState === 'function' && event.getModifierState('AltGraph');
  const symMods = altGraph ? {...m, ctrl: false, alt: false, mod: mac ? m.mod : false} : m;
  if (SYMBOLS.has(key) && SHIFT_FREE.has(key)) {
    withMods({...symMods, shift: false}, key);
  } else if (symMods.shift) {
    if (SYMBOLS.has(key)) withMods(symMods, key);
    const fromCode = CODE_TO_SYMBOL.get(code);
    if (fromCode) withMods(symMods, fromCode);
  } else {
    const symbol = SYMBOLS.has(key) ? key : ALIAS_TO_SYMBOL.get(key);
    if (symbol && !SHIFT_FREE.has(symbol)) withMods(symMods, symbol);
  }
  // Last, the symbol as typed when the layout needed Shift (or Option on macOS) to produce it: German '/' is Shift+7,
  // US '+' is Shift+=, a German Mac types '[' with Option+5. The bare symbol comes after every exact form, so a
  // 'Shift+X' binding still wins where one exists.
  const typed = SYMBOLS.has(key) ? key : ALIAS_TO_SYMBOL.get(key);
  const layoutMods = mac ? ['shift', 'alt'] : ['shift'];
  if (typed && !SHIFT_FREE.has(typed) && layoutMods.some(k => symMods[k]) && code !== US_PLAIN_CODE[key]) {
    const bare = {...symMods};
    for (const k of layoutMods) bare[k] = false;
    withMods(bare, typed);
  }
  return out;
}

/**
 * True when `event` is the key `str` with exactly its modifiers. Shift is ignored for '?' and '*', and for any symbol the
 * layout needed Shift (or Option on macOS) to type.
 */
export function matches(str, event, {platform} = {}) {
  return normalize(event, {platform}).includes(canonical(str));
}

// ---------------------------------------------------------------------------------------------------------------
// Reservations (spec §7.4, dispatcher rule 10)

const RESERVED_BASES = new Set(['KeyN', 'KeyW', 'KeyT', ',', '=', '-', 'Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
  'Digit6', 'Digit7', 'Digit8', 'Digit9']);

/**
 * Browser and OS reservations: Mod+N, Mod+W, Mod+T, Mod+Comma, Mod+1…9, Mod+0, Mod+= and Mod+-, with or without Shift
 * (⌘⇧N, ⌘⇧T and ⌘+ are browser commands too). The 'Ctrl+' spelling is reserved the same way, because off macOS it is the
 * same chord as 'Mod+' ('Ctrl+' is meant only for ⌃⌥ background shortcuts). No command may bind these.
 */
export function isReserved(str) {
  const p = parseKey(str);
  return p.mod !== p.ctrl && !p.alt && RESERVED_BASES.has(p.base);
}

/**
 * The chord a KeyString names off macOS, where 'Ctrl+' and 'Mod+' are the same modifier: 'Ctrl+Alt+Space' →
 * 'Mod+Alt+Space'. Registry CI compares bindings with it so the two spellings cannot hide a clash.
 */
export function chordOffMac(str) {
  const p = parseKey(canonical(str));
  return p.ctrl && !p.mod ? format({...p, mod: true, ctrl: false}) : format(p);
}

// ---------------------------------------------------------------------------------------------------------------
// Presentation

const MAC_NAMED = {Space: 'Space', Enter: '↩', Escape: 'Esc', Backspace: '⌫', Delete: '⌦', Tab: '⇥', ArrowLeft: '←', ArrowRight: '→',
  ArrowUp: '↑', ArrowDown: '↓', Home: 'Home', End: 'End', PageUp: 'Page Up', PageDown: 'Page Down', ContextMenu: 'Menu', F10: 'F10'};
const OTHER_NAMED = {...MAC_NAMED, Enter: 'Enter', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab'};

function baseLabel(p, mac, map) {
  if (p.kind === 'code') {
    if (p.base.startsWith('Digit')) return p.base.slice(5);
    const fromLayout = map?.get?.(p.base);
    if (typeof fromLayout === 'string' && fromLayout.length === 1 && fromLayout.trim()) return fromLayout.toUpperCase();
    return p.base.slice(3);
  }
  if (p.kind === 'named') return (mac ? MAC_NAMED : OTHER_NAMED)[p.base];
  return p.base;
}

/**
 * A human label: '⌘K' / 'Ctrl+K', '⇧Space' / 'Shift+Space', '⌥←' / 'Alt+←', '[', '1'. Letters use the keyboard layout map
 * when one is cached or passed (D56), else the US letter.
 */
export function label(str, {platform, layoutMap: map} = {}) {
  const p = parseKey(canonical(str));
  const mac = isMacLike(platform === undefined ? currentPlatform : platform);
  const base = baseLabel(p, mac, map === undefined ? layoutMap : map);
  if (mac) return `${p.ctrl ? '⌃' : ''}${p.alt ? '⌥' : ''}${p.shift ? '⇧' : ''}${p.mod ? '⌘' : ''}${base}`;
  const mods = [];
  if (p.mod || p.ctrl) mods.push('Ctrl');
  if (p.alt) mods.push('Alt');
  if (p.shift) mods.push('Shift');
  return [...mods, base].join('+');
}

/** The aria-keyshortcuts value: 'Meta+K' (Control+K off macOS), 'Shift+Space', 'Alt+ArrowLeft'. */
export function aria(str, {platform} = {}) {
  const p = parseKey(canonical(str));
  const mac = isMacLike(platform === undefined ? currentPlatform : platform);
  const mods = [];
  if (mac) {
    if (p.ctrl) mods.push('Control');
    if (p.mod) mods.push('Meta');
  } else if (p.mod || p.ctrl) {
    mods.push('Control');
  }
  if (p.alt) mods.push('Alt');
  if (p.shift) mods.push('Shift');
  const base = p.kind === 'code' ? p.base.replace(/^Key|^Digit/, '') : p.base;
  return [...mods, base].join('+');
}

const ACCEL_NAMED = {Space: 'Space', Enter: 'Return', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Home: 'Home', End: 'End', PageUp: 'PageUp',
  PageDown: 'PageDown', F10: 'F10'};

/**
 * The Electron accelerator ('CmdOrCtrl+N', 'CmdOrCtrl+Shift+Z', 'Ctrl+Alt+Space'), or null for keys without Mod or Ctrl:
 * native menus never register plain keys (D41).
 */
export function accelerator(str) {
  const p = parseKey(canonical(str));
  if (!p.mod && !p.ctrl) return null;
  let base;
  if (p.kind === 'code') base = p.base.replace(/^Key|^Digit/, '');
  else if (p.kind === 'named') base = ACCEL_NAMED[p.base];
  else base = p.base;
  if (!base) return null;
  const mods = [];
  if (p.mod) mods.push('CmdOrCtrl');
  if (p.ctrl) mods.push('Ctrl');
  if (p.alt) mods.push('Alt');
  if (p.shift) mods.push('Shift');
  return [...mods, base].join('+');
}
