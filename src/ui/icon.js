// Icons (architecture §2.12, §7.4, D32). One Lucide sprite, built by scripts/build-icons.mjs into
// src/styles/icons.svg, is inlined hidden into <body> once at boot (installIcons); every icon is then
//   <svg class="ui-icon" width height aria-hidden="true" focusable="false"><use href="#i-name"/></svg>
// The symbols carry no stroke-width: primitives/icon.css sets it from --icon-stroke (1.75 on desk
// places, 2 on the Stage). There is deliberately no global `svg` rule (alphaTab draws SVG too).
//
//   icon(name, {size = 20}) → SVGSVGElement      sizes 20 / 24 / 32
//   installIcons(doc = document) → Element        the sprite root (idempotent)
//   hasIcon(name, doc = document) → boolean       whether the sprite defines #i-<name>

import '../styles/primitives/icon.css';
import sprite from '../styles/icons.svg?raw';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SPRITE_ID = 'ws-icon-sprite';
export const ICON_SIZES = Object.freeze([20, 24, 32]);
const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** An icon element. `name` is the sprite id without the `i-` prefix ('play', 'chevron-left'). */
export function icon(name, {size = 20} = {}) {
  if (typeof name !== 'string' || !NAME.test(name)) throw new TypeError(`icon: not an icon name: ${String(name)}`);
  const px = Number(size) > 0 ? Number(size) : 20;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ui-icon');
  svg.setAttribute('width', String(px));
  svg.setAttribute('height', String(px));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('data-icon', name);
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/**
 * Inlines the sprite into <body>, hidden, once (D32). A sprite already in the document (the
 * fixture's harness host inlines one too) is reused, so symbol ids are never duplicated.
 */
export function installIcons(doc = document) {
  const existing = doc.getElementById(SPRITE_ID) ?? doc.getElementById('i-play')?.closest('svg');
  if (existing) return existing;
  const parsed = new DOMParser().parseFromString(sprite, 'image/svg+xml').documentElement;
  const root = doc.importNode(parsed, true);
  root.setAttribute('id', SPRITE_ID);
  root.setAttribute('class', 'ui-icon-sprite');
  root.setAttribute('aria-hidden', 'true');
  root.setAttribute('focusable', 'false');
  root.setAttribute('width', '0');
  root.setAttribute('height', '0');
  doc.body.prepend(root);
  return root;
}

/** Whether the document's sprite, or the bundled one, defines `#i-<name>`. */
export function hasIcon(name, doc = document) {
  return !!doc.getElementById(`i-${name}`) || sprite.includes(`<symbol id="i-${name}"`);
}
