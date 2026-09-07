import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider');
const { NodeHttpExecutor } = require('builder-util/out/nodeHttpExecutor');
const semver = require('semver');
const yaml = require('js-yaml');

const installers = {
  linux: [/-linux-(?:x64|x86_64)\.AppImage$/],
  darwin: [/-mac-arm64\.zip$/, /-mac-x64\.zip$/],
  win32: [/-win-x64\.exe$/],
};

// Use the installed updater's public GitHub provider, without a GitHub token.
// A successful upload alone does not prove that installed clients can see it.
export async function verifyPublicRelease(version, publish, {
  loadFeed = async platform => {
    const provider = new GitHubProvider(publish, {
      allowPrerelease: false, currentVersion: semver.parse('0.0.0'), fullChangelog: false,
    }, { executor: new NodeHttpExecutor(), platform, isUseMultipleRangeRequest: false });
    const info = await provider.getLatestVersion();
    return { info, files: provider.resolveFiles(info) };
  },
  fetchAsset = url => fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(30000) }),
} = {}) {
  if (!semver.valid(version) || semver.prerelease(version)) throw Error('Expected a stable release version');
  await Promise.all(Object.entries(installers).map(async ([platform, required]) => {
    const { info, files } = await loadFeed(platform);
    if (info.version !== version) throw Error(`${platform}: public updater sees ${info.version}, expected ${version}`);
    for (const pattern of required) {
      if (!files.some(file => pattern.test(file.url.pathname))) throw Error(`${platform}: missing updater installer ${pattern}`);
    }
    await Promise.all(files.map(async file => {
      if (!/^[A-Za-z0-9+/]{86}==$/.test(file.info.sha512) || !(file.info.size > 0))
        throw Error(`${platform}: invalid checksum or size for ${file.url.pathname}`);
      const response = await fetchAsset(file.url);
      if (!response.ok || Number(response.headers.get('content-length')) !== file.info.size)
        throw Error(`${platform}: installer unavailable or size mismatch: ${file.url.pathname}`);
    }));
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2] || JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version;
  const { publish } = yaml.load(await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8'));
  for (let attempt = 1; ; attempt++) {
    try {
      await verifyPublicRelease(version, publish);
      console.log(`Public update feeds and installer sizes verified for Woodshed ${version} on Linux, macOS, and Windows.`);
      break;
    } catch (error) {
      if (attempt === 6) throw error;
      console.warn(`Public release not ready (attempt ${attempt}/6): ${error.message}`);
      await setTimeout(10000);
    }
  }
}
