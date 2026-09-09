import {spawn} from 'node:child_process';
const args=process.argv.slice(2);
// A requested web host/port launches only the frontend. Normal development
// still runs both Convex and Vite, as before.
const web=args.some(arg=>['--host','--port','--strictPort'].includes(arg));
const child=spawn(process.execPath,web?['node_modules/vite/bin/vite.js',...args]:['node_modules/concurrently/dist/bin/concurrently.js','-n','convex,vite','-c','blue,green','convex dev','vite'],{stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',code=>process.exit(code??1));
