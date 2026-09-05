import { spawn } from 'node:child_process';
import path from 'node:path';
const executable=process.platform==='win32'?'release/win-unpacked/Woodshed.exe':process.platform==='darwin'?`release/mac${process.arch==='arm64'?'-arm64':''}/Woodshed.app/Contents/MacOS/Woodshed`:'release/linux-unpacked/woodshed';
const headless=process.platform==='linux'&&!!process.env.CI;
const child=spawn(headless?'xvfb-run':path.resolve(executable),headless?['-a',path.resolve(executable),'--no-sandbox','--smoke-test']:['--smoke-test'],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:''}});
const timer=setTimeout(()=>{child.kill();console.error('Desktop smoke test timed out');process.exitCode=1;},60_000);
child.on('error',error=>{clearTimeout(timer);console.error(error);process.exitCode=1;});
child.on('exit',code=>{clearTimeout(timer);process.exitCode=code===0?0:1;});
