// Legacy CLI entry point: imports through the locally paired companion.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const config=JSON.parse(await fs.readFile(path.join(process.env.WOODSHED_DATA_DIR||path.join(os.homedir(),'.woodshed-companion'),'connection.json'),'utf8'));
const origin=new URL(process.env.WOODSHED_WEB_URL||'http://localhost:5173').origin;
const headers={origin,authorization:`Bearer ${config.token}`,'content-type':'application/json'};
const base='http://127.0.0.1:47831';
let directory=process.argv[process.argv.indexOf('--dir')+1];
if(!process.argv.includes('--dir')) {
 const response=await fetch(base+'/legacy',{headers});const found=await response.json();
 if(!response.ok||found.length!==1)throw new Error('Pass --dir followed by the old Woodshed data directory.');
 directory=found[0].directory;
}
const response=await fetch(base+'/import',{method:'POST',headers,body:JSON.stringify({directory})});
const result=await response.json();if(!response.ok)throw new Error(result.error);console.log(`Queued ${result.count} songs. Existing files are preserved.`);
