const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const yaml=require('js-yaml');
const collector=path.resolve(__dirname,'../scripts/collect-release.mjs');
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'woodshed-release-test-'));
  const source=path.join(root,'artifacts');
  for(const [platform,arch,extension,manifest] of [['mac','arm64','zip','latest-mac.yml'],['mac','x64','zip','latest-mac.yml'],['linux','x64','AppImage','latest-linux.yml'],['win','x64','exe','latest.yml']]){
    const dir=path.join(source,platform+'-'+arch);fs.mkdirSync(dir,{recursive:true});
    const name=`Woodshed-1.1.0-${platform}-${arch}.${extension}`;
    const data=Buffer.from(name);fs.writeFileSync(path.join(dir,name),data);
    fs.writeFileSync(path.join(dir,manifest),yaml.dump({version:'1.1.0',files:[{url:name,sha512:createHash('sha512').update(data).digest('base64'),size:data.length}]}));
  }
  return {root,source,target:path.join(root,'release')};
}
test('release metadata keeps both Mac architectures with verified installers',()=>{
  const f=fixture();try{
    execFileSync(process.execPath,[collector,f.source,f.target]);
    const mac=yaml.load(fs.readFileSync(path.join(f.target,'latest-mac.yml'),'utf8'));
    assert.equal(mac.files.length,2);
    assert(mac.files.some(file=>file.url.includes('arm64')));
    assert(mac.files.some(file=>file.url.includes('x64')));
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('release collection refuses an installer that disagrees with its update checksum',()=>{
  const f=fixture();try{
    fs.appendFileSync(path.join(f.source,'win-x64','Woodshed-1.1.0-win-x64.exe'),'tampered');
    assert.throws(()=>execFileSync(process.execPath,[collector,f.source,f.target],{stdio:'pipe'}),/Update checksum mismatch/);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
