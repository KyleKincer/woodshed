import { readdir, mkdir, readFile, copyFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
const source=process.argv[2]||'artifacts', target=process.argv[3]||'release-assets';
await mkdir(target,{recursive:true});
const metadata=new Map();
for(const dir of await readdir(source)){
  for(const name of await readdir(path.join(source,dir))){
    if (/-mac-x64\./.test(name)) throw Error('Intel macOS installers are no longer supported');
    const file=path.join(source,dir,name);
    if(/^latest.*\.yml$/.test(name)){
      const next=yaml.load(await readFile(file,'utf8'));
      const previous=metadata.get(name);
      if(previous && previous.version!==next.version)throw Error('Mismatched release versions');
      metadata.set(name,previous?{...previous,files:[...previous.files,...next.files]}:next);
    }else if(/\.(AppImage|exe|dmg|zip|blockmap)$/.test(name)||/^woodshed-cuda-.*\.(json|part\d{3})$/.test(name)){
      if((await stat(file)).size>=2*1024**3)throw Error(`Release asset exceeds GitHub limit: ${name}`);
      await copyFile(file,path.join(target,name));
    }
  }
}
for(const [name,info] of metadata){
  for(const file of info.files){
    if(path.basename(file.url)!==file.url)throw Error('Unsafe release asset name');
    const hash=createHash('sha512');
    for await(const data of createReadStream(path.join(target,file.url)))hash.update(data);
    if(hash.digest('base64')!==file.sha512)throw Error(`Update checksum mismatch: ${file.url}`);
  }
  await writeFile(path.join(target,name),yaml.dump(info));
}
for(const required of ['latest.yml','latest-linux.yml','latest-mac.yml'])if(!metadata.has(required))throw Error(`Missing ${required}`);
const version=metadata.get('latest.yml').version;
for(const platform of ['linux','win32']){
  const manifest=JSON.parse(await readFile(path.join(target,`woodshed-cuda-${platform}-x64-${version}.json`),'utf8'));
  if(manifest.version!==version||manifest.platform!==platform||!manifest.parts?.length)throw Error('Invalid CUDA manifest');
  for(const part of manifest.parts){
    if(path.basename(part.name)!==part.name)throw Error('Unsafe CUDA asset name');
    const file=path.join(target,part.name), hash=createHash('sha256');
    if((await stat(file)).size!==part.size)throw Error(`CUDA part size mismatch: ${part.name}`);
    for await(const data of createReadStream(file))hash.update(data);
    if(hash.digest('hex')!==part.sha256)throw Error(`CUDA checksum mismatch: ${part.name}`);
  }
}
console.log('Release files, CUDA parts, and updater checksums verified.');
