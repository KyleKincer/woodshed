import { readdir, mkdir, readFile, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
const source=process.argv[2]||'artifacts', target=process.argv[3]||'release-assets';
await mkdir(target,{recursive:true});
const metadata=new Map();
for(const dir of await readdir(source)){
  for(const name of await readdir(path.join(source,dir))){
    const file=path.join(source,dir,name);
    if(/^latest.*\.yml$/.test(name)){
      const next=yaml.load(await readFile(file,'utf8'));
      const previous=metadata.get(name);
      if(previous && previous.version!==next.version)throw Error('Mismatched release versions');
      metadata.set(name,previous?{...previous,files:[...previous.files,...next.files]}:next);
    }else if(/\.(AppImage|exe|dmg|zip|blockmap)$/.test(name))await copyFile(file,path.join(target,name));
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
console.log('Release files and updater checksums verified.');
