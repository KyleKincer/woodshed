import './prepare-fingerprint.mjs';
import { mkdir, copyFile, chmod, writeFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import path from 'node:path';
const require=createRequire(import.meta.url);
await mkdir('build/bin',{recursive:true});
try { await access('build/gpu-runtime.json'); } catch { await writeFile('build/gpu-runtime.json', '{}\n'); }
for(const [source,name] of [[require('ffmpeg-static'),'ffmpeg'],[require('ffprobe-static').path,'ffprobe'],[process.execPath,'node']]){
  const destination=path.join('build/bin',name+(process.platform==='win32'?'.exe':''));
  await copyFile(source,destination);await chmod(destination,0o755);
}
await build({entryPoints:['companion/server.mjs'],outfile:'build/companion/server.mjs',bundle:true,platform:'node',format:'esm',target:'node22'});
await writeFile('build/THIRD-PARTY-NOTICES.txt',`Woodshed includes Electron, Node.js, FFmpeg/ffprobe, Python, PyTorch, Demucs, yt-dlp and their dependencies.\nSignalsmith Stretch: MIT, https://github.com/Signalsmith-Audio/signalsmith-stretch (see bundled license)\nalphaTab: MPL-2.0, https://github.com/CoderLine/alphaTab/tree/v1.8.4 (unmodified library source; see bundled license)\nElectron: MIT, https://github.com/electron/electron\nNode.js: MIT and bundled notices, https://nodejs.org\nFFmpeg binaries: GPL v3 or later, https://github.com/eugeneware/ffmpeg-static (build scripts and corresponding source references); https://github.com/joshwnj/ffprobe-static\nPython: PSF license, https://python.org\nPyTorch: BSD-style, https://github.com/pytorch/pytorch\nDemucs: MIT, https://github.com/facebookresearch/demucs\nyt-dlp: Unlicense, https://github.com/yt-dlp/yt-dlp\nBeatNet and madmom: see bundled package licenses. Model weights may have separate terms.\nAtkinson Hyperlegible Next and Atkinson Hyperlegible Mono fonts: SIL Open Font License 1.1, https://github.com/googlefonts/atkinson-hyperlegible-next and https://github.com/googlefonts/atkinson-hyperlegible-next-mono (see bundled licenses)\nLucide icons: ISC, https://lucide.dev (see bundled license)\nBravura and Academico music fonts: SIL Open Font License 1.1, Steinberg Media Technologies GmbH, https://github.com/steinbergmedia/bravura (see bundled licenses)\nHarmonix Set tempo and section annotations: MIT, https://github.com/urinieto/harmonixset (see bundled license)\nThe frozen runtime retains package license files alongside its libraries.\n`);
console.log('Bundled Node, FFmpeg, ffprobe, and local service.');

await mkdir('build/licenses',{recursive:true});
for(const [source,name] of [['public/licenses/signalsmith-stretch.txt','Signalsmith-Stretch-LICENSE'],['public/licenses/alphatab.txt','alphaTab-LICENSE'],['public/licenses/lucide.txt','Lucide-LICENSE'],['public/licenses/atkinson-hyperlegible-next.txt','Atkinson-Hyperlegible-Next-LICENSE'],['public/licenses/atkinson-hyperlegible-mono.txt','Atkinson-Hyperlegible-Mono-LICENSE'],['public/licenses/academico.txt','Academico-LICENSE'],['public/licenses/bravura.txt','Bravura-LICENSE'],['public/licenses/harmonix-set.txt','Harmonix-Set-LICENSE'],['node_modules/ffmpeg-static/ffmpeg.LICENSE','FFmpeg-LICENSE'],['node_modules/ffmpeg-static/ffmpeg.README','FFmpeg-build-info'],['node_modules/ffprobe-static/LICENSE','ffprobe-static-LICENSE'],['LICENSE','Woodshed-LICENSE']]){
  try{await copyFile(source,path.join('build/licenses',name));}catch(error){if(error.code!=='ENOENT')throw error;}
}
