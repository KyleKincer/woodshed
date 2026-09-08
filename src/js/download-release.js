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
