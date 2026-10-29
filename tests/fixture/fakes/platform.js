// fx-platform=ipad|mac|win (architecture §2.11, §11.2): src/app/platform.js
// reads the switch itself when window.__FIXTURE__ is set; this also makes the
// navigator look like that platform, so code that sniffs it directly agrees.
//   ipad  desktop-class iPadOS Safari: MacIntel + 5 touch points, no userAgentData
//   mac   Chrome on macOS;   win   Chrome on Windows
export const PLATFORMS = {
  ipad: {
    platform: 'MacIntel', maxTouchPoints: 5, vendor: 'Apple Computer, Inc.',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    userAgentData: null,
  },
  mac: {
    platform: 'MacIntel', maxTouchPoints: 0, vendor: 'Google Inc.',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    userAgentData: {platform: 'macOS', mobile: false},
  },
  win: {
    platform: 'Win32', maxTouchPoints: 0, vendor: 'Google Inc.',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    userAgentData: {platform: 'Windows', mobile: false},
  },
};

const BRANDS = [{brand: 'Chromium', version: '141'}, {brand: 'Google Chrome', version: '141'}];

/** Override the navigator for `name`; returns the name, or null when unset. Unknown names are reported. */
export function applyPlatform(win, name) {
  if (!name) return null;
  const spec = PLATFORMS[name];
  if (!spec) { win.console.error(`[fixture] fx-platform must be one of ${Object.keys(PLATFORMS).join(', ')}, got ${JSON.stringify(name)}`); return null; }
  const nav = win.navigator;
  const define = (key, value) => Object.defineProperty(nav, key, {configurable: true, get: () => value});
  define('platform', spec.platform);
  define('maxTouchPoints', spec.maxTouchPoints);
  define('vendor', spec.vendor);
  define('userAgent', spec.userAgent);
  define('appVersion', spec.userAgent.replace(/^Mozilla\//, ''));
  if (spec.userAgentData) {
    const data = {brands: BRANDS, mobile: spec.userAgentData.mobile, platform: spec.userAgentData.platform,
      getHighEntropyValues: async hints => Object.fromEntries([['brands', BRANDS], ['mobile', false], ['platform', spec.userAgentData.platform], ...hints.map(h => [h, h === 'architecture' ? (name === 'mac' ? 'arm' : 'x86') : ''])])};
    define('userAgentData', data);
  } else {
    // Safari has no userAgentData at all: remove it rather than leave an empty value.
    try { delete win.Navigator?.prototype?.userAgentData; } catch { /* not configurable */ }
    if ('userAgentData' in nav) define('userAgentData', undefined);
  }
  return name;
}
