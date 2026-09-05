import { mkdir, copyFile, chmod, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import path from 'node:path';
const require=createRequire(import.meta.url);
await mkdir('build/bin',{recursive:true});
for(const [source,name] of [[require('ffmpeg-static'),'ffmpeg'],[require('ffprobe-static').path,'ffprobe'],[process.execPath,'node']]){
  const destination=path.join('build/bin',name+(process.platform==='win32'?'.exe':''));
  await copyFile(source,destination);await chmod(destination,0o755);
}
await build({entryPoints:['companion/server.mjs'],outfile:'build/companion/server.mjs',bundle:true,platform:'node',format:'esm',target:'node22'});
await writeFile('build/THIRD-PARTY-NOTICES.txt',`Woodshed includes Electron, Node.js, FFmpeg/ffprobe, Python, PyTorch, Demucs, yt-dlp and their dependencies.\nElectron: MIT, https://github.com/electron/electron\nNode.js: MIT and bundled notices, https://nodejs.org\nFFmpeg binaries: GPL v3 or later, https://github.com/eugeneware/ffmpeg-static (build scripts and corresponding source references); https://github.com/joshwnj/ffprobe-static\nPython: PSF license, https://python.org\nPyTorch: BSD-style, https://github.com/pytorch/pytorch\nDemucs: MIT, https://github.com/facebookresearch/demucs\nyt-dlp: Unlicense, https://github.com/yt-dlp/yt-dlp\nBeatNet and madmom: see bundled package licenses. Model weights may have separate terms.\nThe frozen runtime retains package license files alongside its libraries.\n`);
console.log('Bundled Node, FFmpeg, ffprobe, and local service.');
