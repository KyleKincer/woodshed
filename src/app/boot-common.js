// The boot steps the app (main.js) and the Shared Stage (src/share/shared-stage.js) share
// (architecture §2.3.1 step 1, §2.18 step 1): the stylesheet, the icon sprite, the font preload
// and the test handle.
//
//   bootCommon({doc, win, activeSession, settled}) → {devHandle}
//     main.css is imported by this module (and first by main.js); installIcons() inlines the sprite
//     once (D32); preloadFonts() adds <link rel=preload> for the two Latin faces the first paint uses;
//     installDevHandle() only in development builds and on the fixture (§11.4).

import '../styles/main.css';
import uiFont from '../styles/fonts/atkinson-hyperlegible-next-latin-wght-normal.woff2?url';
import monoFont from '../styles/fonts/atkinson-hyperlegible-mono-latin-wght-normal.woff2?url';
import {installIcons} from '../ui/icon.js';
import {installDevHandle} from './dev-handle.js';

/** The font files preloaded at boot (Vite asset URLs: /assets/… in a build). */
export const FONT_PRELOADS = Object.freeze([uiFont, monoFont]);

/** Adds one <link rel=preload as=font> per font to <head>; idempotent. Returns the links. */
export function preloadFonts(doc = globalThis.document, hrefs = FONT_PRELOADS) {
  const links = [];
  for (const href of hrefs) {
    let link = [...doc.head.querySelectorAll('link[rel="preload"][as="font"]')].find(l => l.getAttribute('href') === href);
    if (!link) {
      link = doc.createElement('link');
      link.rel = 'preload';
      link.setAttribute('as', 'font');
      link.type = 'font/woff2';
      link.setAttribute('crossorigin', '');
      link.setAttribute('href', href);
      doc.head.append(link);
    }
    links.push(link);
  }
  return links;
}

export function bootCommon({doc = globalThis.document, win = globalThis.window, activeSession, settled} = {}) {
  installIcons(doc);
  preloadFonts(doc);
  const devHandle = installDevHandle({win, activeSession, settled});
  return {devHandle};
}
