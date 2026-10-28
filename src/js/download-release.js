const assetRoot = 'https://github.com/KyleKincer/woodshed/releases/download/';
const formats = {
  mac: [{id:'dmg',label:'DMG installer',pattern:/-mac-arm64\.dmg$/},{id:'zip',label:'ZIP archive',pattern:/-mac-arm64\.zip$/}],
  windows: [{id:'exe',label:'EXE installer',pattern:/-win-x64\.exe$/}],
  linux: [{id:'appimage',label:'AppImage',pattern:/-linux-(?:x64|x86_64)\.AppImage$/}],
};

export function detectPlatform(nav = navigator) {
  const ua = nav.userAgent || '';
  const platform = nav.userAgentData?.platform || nav.platform || '';
  if (/Android|iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(platform) && nav.maxTouchPoints > 1)) return 'mobile';
  if (/CrOS/i.test(ua)) return 'web';
  if (/Win/i.test(platform + ' ' + ua)) return 'windows';
  if (/Mac/i.test(platform + ' ' + ua)) return 'mac';
  if (/Linux/i.test(platform + ' ' + ua) && !/aarch64|armv\d/i.test(platform + ' ' + ua)) return 'linux';
  return 'web';
}

export function normalizeRelease(release) {
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw Error('No stable desktop release is available.');
  const downloads = {};
  for (const [platform, entries] of Object.entries(formats)) {
    downloads[platform] = entries.map(format => {
      const asset = release.assets?.find(asset => format.pattern.test(asset.name));
      if (!asset || !(asset.size > 0)) throw Error('The release is missing an installer.');
      const expected = `${assetRoot}${release.tag_name}/${asset.name}`;
      if (asset.browser_download_url !== expected || asset.name.includes('/') || asset.name.includes('..')) throw Error('Invalid installer download address.');
      return {id:format.id,label:format.label,name:asset.name,url:expected,size:asset.size};
    });
  }
  return {version:release.tag_name.slice(1),downloads};
}

export function formatSize(bytes) {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/** Where the download page looks for the release: the cached GitHub lookup, then the bundled manifest. */
export const RELEASE_SOURCES = Object.freeze(['/api/downloads', '/downloads.json']);

/** A signal that aborts after `ms` or when `outer` aborts (no AbortSignal.any before Safari 17.4). */
function deadline(outer, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The download lookup timed out.', 'TimeoutError')), ms);
  const onAbort = () => controller.abort(outer.reason);
  if (outer) outer.addEventListener('abort', onAbort, {once: true});
  return {signal: controller.signal, done() { clearTimeout(timer); outer?.removeEventListener('abort', onAbort); }};
}

export class ReleaseUnavailableError extends Error {
  constructor(causes = []) {
    super('Downloads couldn’t load. Check your connection and try again.');
    this.name = 'ReleaseUnavailableError';
    this.causes = causes;
  }
}

/**
 * The newest stable release, normalised (`{version, downloads}`). Each source is
 * tried in order with its own timeout; a source that fails, answers non-2xx or
 * returns metadata `normalizeRelease` rejects falls through to the next, so the
 * bundled manifest keeps verified downloads available during an API outage.
 * Rejects with ReleaseUnavailableError when every source fails, or with the
 * caller's AbortError when `signal` aborts.
 */
export async function fetchRelease({fetch: fetchImpl = globalThis.fetch, sources = RELEASE_SOURCES, timeoutMs = 10000, signal} = {}) {
  const causes = [];
  for (const url of sources) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The download lookup was aborted.', 'AbortError');
    const {signal: combined, done} = deadline(signal, timeoutMs);
    try {
      const response = await fetchImpl(url, {signal: combined});
      if (!response.ok) throw Error(`Download lookup failed (${response.status})`);
      return normalizeRelease(await response.json());
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      causes.push({url, message: String(error?.message ?? error)});
    } finally {
      done();
    }
  }
  throw new ReleaseUnavailableError(causes);
}
