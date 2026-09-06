// Official Chromaprint release assets, pinned and verified before extraction.
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readdir,
  copyFile,
  chmod,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { unzipSync } from 'fflate';
const version = '1.6.1';
const hashes = {
  'linux-x86_64':
    'fc16cd37a70168040bc9ceb45f1d4d1216f5a75bc4c9cf8564bea70ac6a45733',
  'linux-arm64':
    '7eaf5d655c4aa172ab28e3c870b8bb61dd2c327ac94de145676f88842cf6215a',
  'macos-x86_64':
    '0de8947c09dd93c44cece2f5947d408136a3b6692eed726d1f109506500bd773',
  'macos-arm64':
    '254f23cb2d290069ba1d3d28199414fbf66d2054fc2f6821c2fc62ed39470a95',
  'windows-x86_64':
    '735d6182b38e9f364b84ce6f4ccd682c75e2851de89735711d6b762d12b92a4e',
};
const platform = { darwin: 'macos', win32: 'windows', linux: 'linux' }[
  process.platform
];
const target = `${platform}-${process.arch === 'x64' ? 'x86_64' : process.arch}`;
if (!hashes[target])
  throw new Error(`Chromaprint is not bundled for ${target}.`);
const zip = process.platform === 'win32',
  name = `chromaprint-fpcalc-${version}-${target}.${zip ? 'zip' : 'tar.gz'}`;
const response = await fetch(
  `https://github.com/acoustid/chromaprint/releases/download/v${version}/${name}`,
);
if (!response.ok)
  throw new Error(`Chromaprint download failed (${response.status}).`);
const bytes = new Uint8Array(await response.arrayBuffer());
if (createHash('sha256').update(bytes).digest('hex') !== hashes[target])
  throw new Error('Chromaprint checksum mismatch.');
const temp = await mkdtemp(path.join(tmpdir(), 'woodshed-fpcalc-'));
try {
  if (zip) {
    for (const [file, data] of Object.entries(unzipSync(bytes))) {
      if (file.includes('..') || path.isAbsolute(file))
        throw new Error('Unsafe archive path.');
      const dest = path.join(temp, file);
      if (file.endsWith('/')) {
        await mkdir(dest, { recursive: true });
        continue;
      }
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, data);
    }
  } else {
    const archive = path.join(temp, name);
    await writeFile(archive, bytes);
    execFileSync('tar', ['-xzf', archive, '-C', temp]);
  }
  await mkdir('build/bin', { recursive: true });
  await mkdir('build/licenses', { recursive: true });
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (/^fpcalc(\.exe)?$/.test(entry.name)) {
        await copyFile(file, path.join('build/bin', entry.name));
        await chmod(path.join('build/bin', entry.name), 0o755);
      } else if (/license|copying|notice/i.test(entry.name))
        await copyFile(
          file,
          path.join('build/licenses', `Chromaprint-${entry.name}`),
        );
    }
  }
  await visit(temp);
  const license = await fetch(
    `https://raw.githubusercontent.com/acoustid/chromaprint/v${version}/LICENSE.md`,
  );
  if (!license.ok) throw new Error('Could not download Chromaprint license.');
  await writeFile(
    'build/licenses/Chromaprint-LICENSE.md',
    await license.text(),
  );
  const lgpl = await fetch(
    'https://raw.githubusercontent.com/FFmpeg/FFmpeg/n8.0/COPYING.LGPLv2.1',
  );
  if (!lgpl.ok) throw new Error('Could not download LGPL license.');
  await writeFile('build/licenses/Chromaprint-LGPL-2.1.txt', await lgpl.text());
  await writeFile(
    'build/licenses/Chromaprint-source.txt',
    `Chromaprint ${version}: https://github.com/acoustid/chromaprint/tree/v${version}\nOfficial fpcalc binaries include FFmpeg; see the bundled license files.\n`,
  );
  console.log(`Bundled Chromaprint ${version} (${target}).`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
