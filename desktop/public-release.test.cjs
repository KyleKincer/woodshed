const { test } = require('node:test');
const assert = require('node:assert/strict');

async function fixture() {
  const { verifyPublicRelease } = await import('../scripts/verify-public-release.mjs');
  const names = {
    linux: ['Woodshed-1.4.0-linux-x86_64.AppImage'],
    darwin: ['Woodshed-1.4.0-mac-arm64.zip', 'Woodshed-1.4.0-mac-x64.zip'],
    win32: ['Woodshed-1.4.0-win-x64.exe'],
  };
  const feeds = Object.fromEntries(Object.entries(names).map(([platform, files]) => [platform, {
    info: { version: '1.4.0' },
    files: files.map(name => ({ url: new URL(`https://example.com/${name}`), info: { sha512: Buffer.alloc(64).toString('base64'), size: 123 } })),
  }]));
  const options = {
    loadFeed: async platform => feeds[platform],
    fetchAsset: async () => ({ ok: true, headers: new Headers({ 'content-length': '123' }) }),
  };
  return { feeds, options, verify: () => verifyPublicRelease('1.4.0', {}, options) };
}

test('public verification requires the new release on every platform', async () => {
  const f = await fixture();
  await f.verify();
  f.feeds.linux.info.version = '1.3.0';
  await assert.rejects(f.verify(), /public updater sees 1.3.0, expected 1.4.0/);
});

test('public verification rejects a missing Mac updater architecture', async () => {
  const f = await fixture();
  f.feeds.darwin.files.pop();
  await assert.rejects(f.verify(), /missing updater installer/);
});

test('public verification rejects inaccessible or incomplete installer uploads', async () => {
  const f = await fixture();
  f.options.fetchAsset = async () => ({ ok: false });
  await assert.rejects(f.verify(), /installer unavailable or size mismatch/);
  f.options.fetchAsset = async () => ({ ok: true, headers: new Headers({ 'content-length': '122' }) });
  await assert.rejects(f.verify(), /installer unavailable or size mismatch/);
});

test('public verification rejects invalid checksum metadata', async () => {
  const f = await fixture();
  f.feeds.win32.files[0].info.sha512 = 'invalid';
  await assert.rejects(f.verify(), /invalid checksum or size/);
});
