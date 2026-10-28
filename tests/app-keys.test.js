import {afterEach, describe, expect, it} from 'vitest';
import {
  accelerator, aria, canonical, chordOffMac, detectMacLike, isMacLike, isReserved, isValidKey, label, loadLayoutMap, matches, normalize,
  parseKey, setLayoutMap, setPlatform,
} from '../src/app/keys.js';

const ev = (props) => ({key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...props});
const mac = {platform: 'mac'};
const win = {platform: 'win'};

afterEach(() => { setPlatform(null); setLayoutMap(null); });

describe('parseKey and canonical', () => {
  it('parses each base kind', () => {
    expect(parseKey('KeyA')).toMatchObject({base: 'KeyA', kind: 'code', mod: false, shift: false});
    expect(parseKey('Digit7')).toMatchObject({base: 'Digit7', kind: 'code'});
    expect(parseKey('Space')).toMatchObject({base: 'Space', kind: 'named'});
    expect(parseKey('F10')).toMatchObject({kind: 'named'});
    expect(parseKey(',')).toMatchObject({base: ',', kind: 'symbol'});
    expect(parseKey('Mod+Shift+KeyZ')).toMatchObject({mod: true, shift: true, ctrl: false, alt: false, base: 'KeyZ'});
    expect(parseKey('Ctrl+Alt+Space')).toMatchObject({ctrl: true, alt: true, mod: false});
    expect(parseKey('Mod+-')).toMatchObject({mod: true, base: '-', kind: 'symbol'});
  });

  it('rejects malformed strings', () => {
    for (const bad of ['', 'A', 'a', 'Key', 'KeyAA', 'Hyper+KeyA', 'Shift+Shift+KeyA', 'Mod++', '+', 'Numpad1', 'Digit10', 'Esc', 'ShiftKeyA']) {
      expect(isValidKey(bad), bad).toBe(false);
      expect(() => parseKey(bad)).toThrow(TypeError);
    }
    expect(() => parseKey(null)).toThrow(TypeError);
  });

  it('canonicalises modifier order and drops Shift from ? and *', () => {
    expect(canonical('Shift+Mod+KeyZ')).toBe('Mod+Shift+KeyZ');
    expect(canonical('Shift+Alt+Ctrl+ArrowLeft')).toBe('Ctrl+Alt+Shift+ArrowLeft');
    expect(canonical('Shift+?')).toBe('?');
    expect(canonical('Shift+*')).toBe('*');
    expect(canonical('Meta+KeyK')).toBe('Mod+KeyK');
  });
});

describe('matching: codes and named keys', () => {
  it('letters and digits match on e.code whatever the layout prints', () => {
    expect(matches('KeyL', ev({key: 'l', code: 'KeyL'}))).toBe(true);
    expect(matches('KeyQ', ev({key: 'a', code: 'KeyQ'}))).toBe(true);           // AZERTY prints a on the Q key
    expect(matches('KeyA', ev({key: 'a', code: 'KeyQ'}))).toBe(false);
    expect(matches('Digit1', ev({key: '&', code: 'Digit1'}))).toBe(true);        // AZERTY unshifted digit row
    expect(matches('Shift+Digit1', ev({key: '!', code: 'Digit1', shiftKey: true}))).toBe(true);
  });

  it('modifiers are exact', () => {
    expect(matches('KeyL', ev({key: 'L', code: 'KeyL', shiftKey: true}))).toBe(false);
    expect(matches('Shift+KeyL', ev({key: 'L', code: 'KeyL', shiftKey: true}))).toBe(true);
    expect(matches('Shift+KeyL', ev({key: 'l', code: 'KeyL'}))).toBe(false);
    expect(matches('ArrowLeft', ev({key: 'ArrowLeft', code: 'ArrowLeft', altKey: true}))).toBe(false);
    expect(matches('Alt+Shift+ArrowLeft', ev({key: 'ArrowLeft', code: 'ArrowLeft', altKey: true, shiftKey: true}))).toBe(true);
  });

  it('Mod is ⌘ on macOS and iPadOS, Ctrl elsewhere', () => {
    const cmdK = ev({key: 'k', code: 'KeyK', metaKey: true});
    const ctrlK = ev({key: 'k', code: 'KeyK', ctrlKey: true});
    expect(matches('Mod+KeyK', cmdK, mac)).toBe(true);
    expect(matches('Mod+KeyK', ctrlK, mac)).toBe(false);
    expect(matches('Ctrl+KeyK', ctrlK, mac)).toBe(true);
    expect(matches('Mod+KeyK', ctrlK, win)).toBe(true);
    expect(matches('Mod+KeyK', cmdK, win)).toBe(false);                         // the Windows key is not a modifier we bind
    expect(matches('Mod+KeyK', cmdK, {platform: 'ipad'})).toBe(true);
    expect(matches('Mod+KeyK', cmdK, {platform: {isIPad: true}})).toBe(true);
    expect(matches('Ctrl+Alt+Space', ev({key: ' ', code: 'Space', ctrlKey: true, altKey: true}), win)).toBe(true);
  });

  it('uses the module platform when none is passed', () => {
    setPlatform('mac');
    expect(matches('Mod+KeyZ', ev({key: 'z', code: 'KeyZ', metaKey: true}))).toBe(true);
    setPlatform('win');
    expect(matches('Mod+KeyZ', ev({key: 'z', code: 'KeyZ', ctrlKey: true}))).toBe(true);
  });

  it('named keys accept legacy spellings', () => {
    expect(matches('Space', ev({key: ' ', code: 'Space'}))).toBe(true);
    expect(matches('Shift+Space', ev({key: ' ', code: 'Space', shiftKey: true}))).toBe(true);
    expect(matches('Escape', ev({key: 'Esc', code: 'Escape'}))).toBe(true);
    expect(matches('Enter', ev({key: 'Enter', code: 'NumpadEnter'}))).toBe(true);
    expect(matches('ArrowLeft', ev({key: 'Left', code: 'ArrowLeft'}))).toBe(true);
    expect(matches('Delete', ev({key: 'Del', code: 'Delete'}))).toBe(true);
    expect(matches('ContextMenu', ev({key: 'ContextMenu', code: 'ContextMenu'}))).toBe(true);
  });
});

describe('matching: symbols and aliases', () => {
  it('Shift+, matches on the US layout through the physical key', () => {
    expect(matches('Shift+,', ev({key: '<', code: 'Comma', shiftKey: true}))).toBe(true);
    expect(matches(',', ev({key: '<', code: 'Comma', shiftKey: true}))).toBe(false);
    expect(matches(',', ev({key: ',', code: 'Comma'}))).toBe(true);
    expect(matches('Shift+.', ev({key: '>', code: 'Period', shiftKey: true}))).toBe(true);
    expect(matches('Shift+[', ev({key: '{', code: 'BracketLeft', shiftKey: true}))).toBe(true);
    expect(matches('Shift+]', ev({key: '}', code: 'BracketRight', shiftKey: true}))).toBe(true);
  });

  it('Shift+, matches on non-US layouts that print the comma with Shift', () => {
    // Russian: the comma is Shift+Slash; German: the comma key is still Comma and prints ";" with Shift.
    expect(matches('Shift+,', ev({key: ',', code: 'Slash', shiftKey: true}))).toBe(true);
    expect(matches('Shift+,', ev({key: ';', code: 'Comma', shiftKey: true}))).toBe(true);
    // The bare ',' is offered too, but after 'Shift+,', so a Shift+, binding wins where one exists.
    expect(normalize(ev({key: ',', code: 'Slash', shiftKey: true}), win)).toEqual(['Shift+,', ',']);
  });

  it('a symbol the layout needs Shift or Option to type also matches unshifted, after the exact forms', () => {
    // US '+' is Shift+=; German '/' is Shift+7 and '=' is Shift+0; AZERTY '.' is Shift on the US comma key.
    expect(normalize(ev({key: '+', code: 'Equal', shiftKey: true}), win)).toEqual(['=']);
    expect(normalize(ev({key: '/', code: 'Digit7', shiftKey: true}), win)).toEqual(['Shift+Digit7', 'Shift+/', '/']);
    expect(normalize(ev({key: '=', code: 'Digit0', shiftKey: true}), win)).toEqual(['Shift+Digit0', 'Shift+=', '=']);
    expect(normalize(ev({key: '.', code: 'Comma', shiftKey: true}), win)).toEqual(['Shift+.', 'Shift+,', '.']);
    expect(matches('/', ev({key: '/', code: 'Digit7', shiftKey: true}), win)).toBe(true);
    // A German Mac types [ with Option+5; Option is a typing modifier there, not a shortcut one.
    expect(normalize(ev({key: '[', code: 'Digit5', altKey: true}), mac)).toEqual(['Alt+Digit5', 'Alt+[', '[']);
    expect(matches('[', ev({key: '[', code: 'Digit5', altKey: true}), mac)).toBe(true);
    // Off macOS Alt stays a shortcut modifier, and nothing changes for the US unshifted keys.
    expect(matches('[', ev({key: '[', code: 'Digit5', altKey: true}), win)).toBe(false);
    expect(matches('.', ev({key: '>', code: 'Period', shiftKey: true}), win)).toBe(false);
    expect(matches('.', ev({key: '.', code: 'Period', shiftKey: true}), win)).toBe(false);
    expect(matches('Mod+=', ev({key: '+', code: 'Equal', shiftKey: true, ctrlKey: true}), win)).toBe(true); // reserved, unbound
  });

  it('? and * typed on a letter key mean the character, not the letter (AZERTY ? is Shift+KeyM)', () => {
    expect(normalize(ev({key: '?', code: 'KeyM', shiftKey: true}), win)).toEqual(['?']);
    expect(matches('Shift+KeyM', ev({key: '?', code: 'KeyM', shiftKey: true}), win)).toBe(false);
    expect(normalize(ev({key: '*', code: 'Digit8', shiftKey: true}), win)).toEqual(['Shift+Digit8', '*']);   // US digits keep their code
  });

  it('? and * ignore Shift', () => {
    expect(matches('?', ev({key: '?', code: 'Slash', shiftKey: true}))).toBe(true);
    expect(matches('?', ev({key: '?', code: 'Minus'}))).toBe(true);                // a layout with an unshifted ?
    expect(matches('*', ev({key: '*', code: 'Digit8', shiftKey: true}))).toBe(true);
    expect(matches('*', ev({key: '*', code: 'NumpadMultiply'}))).toBe(true);
    expect(matches('?', ev({key: '?', code: 'Slash', shiftKey: true, ctrlKey: true}), win)).toBe(false);
  });

  it('= also matches + and - also matches the minus sign, unshifted', () => {
    expect(matches('=', ev({key: '=', code: 'Equal'}))).toBe(true);
    expect(matches('=', ev({key: '+', code: 'NumpadAdd'}))).toBe(true);
    expect(matches('=', ev({key: '+', code: 'BracketRight'}))).toBe(true);         // German unshifted +
    expect(matches('=', ev({key: '+', code: 'Equal', shiftKey: true}))).toBe(true);  // US + needs Shift
    expect(matches('=', ev({key: '=', code: 'Equal', shiftKey: true}))).toBe(false); // exact modifiers
    expect(matches('-', ev({key: '-', code: 'Minus'}))).toBe(true);
    expect(matches('-', ev({key: '−', code: 'Minus'}))).toBe(true);
    expect(matches('-', ev({key: '-', code: 'NumpadSubtract'}))).toBe(true);
  });

  it('other symbols match on e.key', () => {
    for (const s of ['[', ']', '`', '\\', '/', '.']) expect(matches(s, ev({key: s, code: 'Whatever'})), s).toBe(true);
  });

  it('AltGr symbols are not shortcuts with Ctrl+Alt', () => {
    const altGrBracket = {...ev({key: '[', code: 'Digit8', ctrlKey: true, altKey: true}), getModifierState: k => k === 'AltGraph'};
    expect(matches('[', altGrBracket, win)).toBe(true);
    const ctrlAltBracket = ev({key: '[', code: 'BracketLeft', ctrlKey: true, altKey: true});
    expect(matches('[', ctrlAltBracket, win)).toBe(false);
  });
});

describe('normalize', () => {
  it('lists the code form first, then named and symbol forms', () => {
    expect(normalize(ev({key: '*', code: 'Digit8', shiftKey: true}), win)).toEqual(['Shift+Digit8', '*']);
    expect(normalize(ev({key: 'l', code: 'KeyL'}), win)).toEqual(['KeyL']);
    expect(normalize(ev({key: ' ', code: 'Space'}), win)).toEqual(['Space']);
    expect(normalize(ev({key: '<', code: 'Comma', shiftKey: true}), win)).toEqual(['Shift+,']);
  });

  it('offers the Ctrl+ spelling where Mod is Control', () => {
    expect(normalize(ev({key: 'k', code: 'KeyK', ctrlKey: true}), win)).toEqual(['Mod+KeyK', 'Ctrl+KeyK']);
    expect(normalize(ev({key: 'k', code: 'KeyK', ctrlKey: true}), mac)).toEqual(['Ctrl+KeyK']);
  });

  it('numpad digits are digits; with NumLock off they are the named keys they print', () => {
    expect(normalize(ev({key: '1', code: 'Numpad1'}), win)).toEqual(['Digit1']);
    expect(normalize(ev({key: '0', code: 'Numpad0', shiftKey: false}), win)).toEqual(['Digit0']);
    expect(matches('Digit7', ev({key: '7', code: 'Numpad7'}), win)).toBe(true);
    expect(normalize(ev({key: 'End', code: 'Numpad1'}), win)).toEqual(['End']);
    expect(normalize(ev({key: 'Enter', code: 'NumpadEnter'}), win)).toEqual(['Enter']);
  });

  it('returns nothing for events with an unbindable modifier or no event', () => {
    expect(normalize(ev({key: 'k', code: 'KeyK', metaKey: true}), win)).toEqual([]);
    expect(normalize(null)).toEqual([]);
    expect(normalize(ev({key: 'Shift', code: 'ShiftLeft', shiftKey: true}), win)).toEqual([]);
  });
});

describe('reservations (spec §7.4)', () => {
  it('flags browser and OS keys', () => {
    for (const k of ['Mod+KeyN', 'Mod+KeyW', 'Mod+KeyT', 'Mod+,', 'Mod+=', 'Mod+-', 'Mod+Digit0', 'Mod+Digit1', 'Mod+Digit9',
      'Mod+Shift+KeyT', 'Mod+Shift+=']) expect(isReserved(k), k).toBe(true);
  });
  it('flags the Ctrl+ spelling too: off macOS it is the same chord', () => {
    for (const k of ['Ctrl+KeyN', 'Ctrl+KeyW', 'Ctrl+KeyT', 'Ctrl+Digit1', 'Ctrl+=', 'Ctrl+-', 'Ctrl+,', 'Ctrl+Shift+KeyT']) {
      expect(isReserved(k), k).toBe(true);
    }
    expect(isReserved('Ctrl+Alt+KeyN')).toBe(false);
  });
  it('chordOffMac folds Ctrl+ into Mod+', () => {
    expect(chordOffMac('Ctrl+Alt+Space')).toBe('Mod+Alt+Space');
    expect(chordOffMac('Shift+Ctrl+KeyZ')).toBe('Mod+Shift+KeyZ');
    expect(chordOffMac('Mod+KeyZ')).toBe('Mod+KeyZ');
    expect(chordOffMac('Shift+?')).toBe('?');
  });
  it('leaves app keys alone', () => {
    for (const k of ['Mod+KeyK', 'Mod+KeyZ', 'Mod+Shift+KeyZ', 'KeyN', 'Digit1', '=', 'Alt+Digit1', 'Ctrl+Alt+Space', 'Mod+Alt+KeyN']) {
      expect(isReserved(k), k).toBe(false);
    }
  });
});

describe('label', () => {
  it('uses Apple symbols on macOS', () => {
    expect(label('Mod+KeyK', mac)).toBe('⌘K');
    expect(label('Shift+Space', mac)).toBe('⇧Space');
    expect(label('Alt+ArrowLeft', mac)).toBe('⌥←');
    expect(label('Mod+Shift+KeyZ', mac)).toBe('⇧⌘Z');
    expect(label('Ctrl+Alt+Enter', mac)).toBe('⌃⌥↩');
    expect(label('Backspace', mac)).toBe('⌫');
    expect(label('Escape', mac)).toBe('Esc');
  });

  it('spells modifiers out elsewhere', () => {
    expect(label('Mod+KeyK', win)).toBe('Ctrl+K');
    expect(label('Shift+Space', win)).toBe('Shift+Space');
    expect(label('Alt+ArrowLeft', win)).toBe('Alt+←');
    expect(label('Mod+Shift+KeyZ', win)).toBe('Ctrl+Shift+Z');
    expect(label('Ctrl+Alt+Space', win)).toBe('Ctrl+Alt+Space');
    expect(label('Enter', win)).toBe('Enter');
  });

  it('prints bases plainly', () => {
    expect(label('[', win)).toBe('[');
    expect(label('Digit1', mac)).toBe('1');
    expect(label('Shift+,', mac)).toBe('⇧,');
    expect(label('?', win)).toBe('?');
    expect(label('PageDown', win)).toBe('Page Down');
  });

  it('labels letters from the keyboard layout map (D56)', () => {
    const azerty = new Map([['KeyQ', 'a'], ['KeyA', 'q'], ['Digit1', '&'], ['KeyM', ',']]);
    expect(label('KeyQ', {platform: 'win', layoutMap: azerty})).toBe('A');
    expect(label('Digit1', {platform: 'win', layoutMap: azerty})).toBe('1');
    expect(label('KeyM', {platform: 'win', layoutMap: azerty})).toBe(',');
    expect(label('KeyQ', {platform: 'win', layoutMap: null})).toBe('Q');
    setLayoutMap(azerty);
    expect(label('Mod+KeyQ', mac)).toBe('⌘A');
  });

  it('loads the layout map from navigator.keyboard when available', async () => {
    const map = new Map([['KeyZ', 'w']]);
    await expect(loadLayoutMap({keyboard: {getLayoutMap: async () => map}})).resolves.toBe(true);
    expect(label('KeyZ', win)).toBe('W');
    await expect(loadLayoutMap({})).resolves.toBe(false);
    await expect(loadLayoutMap({keyboard: {getLayoutMap: async () => { throw new Error('denied'); }}})).resolves.toBe(false);
    expect(label('KeyZ', win)).toBe('W');                                        // the cached map is kept
  });
});

describe('aria and accelerator', () => {
  it('aria-keyshortcuts values', () => {
    expect(aria('Mod+KeyK', mac)).toBe('Meta+K');
    expect(aria('Mod+KeyK', win)).toBe('Control+K');
    expect(aria('Shift+Space')).toBe('Shift+Space');
    expect(aria('Alt+ArrowLeft')).toBe('Alt+ArrowLeft');
    expect(aria('Digit3')).toBe('3');
    expect(aria('Ctrl+Alt+Space', mac)).toBe('Control+Alt+Space');
    expect(aria('?')).toBe('?');
  });

  it('Electron accelerators only for Mod/Ctrl keys (D41)', () => {
    expect(accelerator('Mod+KeyN')).toBe('CmdOrCtrl+N');
    expect(accelerator('Mod+Shift+KeyZ')).toBe('CmdOrCtrl+Shift+Z');
    expect(accelerator('Mod+,')).toBe('CmdOrCtrl+,');
    expect(accelerator('Ctrl+Alt+Space')).toBe('Ctrl+Alt+Space');
    expect(accelerator('Ctrl+Alt+Enter')).toBe('Ctrl+Alt+Return');
    expect(accelerator('Mod+ArrowLeft')).toBe('CmdOrCtrl+Left');
    expect(accelerator('Mod+ContextMenu')).toBe(null);
    for (const plain of ['Space', 'KeyN', 'Shift+KeyL', 'Alt+ArrowLeft', '?']) expect(accelerator(plain), plain).toBe(null);
  });
});

describe('platform detection', () => {
  it('detects Mac-like platforms', () => {
    expect(detectMacLike({platform: 'MacIntel'})).toBe(true);
    expect(detectMacLike({platform: 'iPad'})).toBe(true);
    expect(detectMacLike({platform: 'Win32'})).toBe(false);
    expect(detectMacLike({platform: '', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'})).toBe(true);
    expect(detectMacLike({userAgentData: {platform: 'macOS'}, platform: 'Win32'})).toBe(true);
    expect(detectMacLike({userAgentData: {platform: 'Windows'}, platform: 'MacIntel'})).toBe(false);
    expect(detectMacLike(undefined)).toBe(false);
  });

  it('accepts strings and platform objects', () => {
    expect(isMacLike('mac')).toBe(true);
    expect(isMacLike('ios')).toBe(true);
    expect(isMacLike('linux')).toBe(false);
    expect(isMacLike({isMac: false, isIPad: false})).toBe(false);
    expect(isMacLike({isMac: true})).toBe(true);
  });
});
