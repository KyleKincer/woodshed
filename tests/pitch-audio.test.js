// @vitest-environment node
// Exercise the actual WASM worklet against audio, not a mocked pitch API.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { expect, test } from 'vitest';
const rateHz = 48000;
async function processor(channels = 2) {
  let Processor, ready;
  const initialized = new Promise(resolve => { ready = resolve; });
  const scope = {console, WebAssembly, TextDecoder, atob, setTimeout, clearTimeout, sampleRate:rateHz, currentTime:0,
    AudioWorkletProcessor:class { port = {postMessage: data => { if(data[0] === 'ready') ready(); }}; },
    registerProcessor: (_, Class) => { Processor = Class; }};
  const source = (await readFile(new URL('../node_modules/signalsmith-stretch/SignalsmithStretch.mjs', import.meta.url), 'utf8')).replace('export default _export;', '');
  vm.runInNewContext(source, scope);
  const node = new Processor({numberOfOutputs:1,outputChannelCount:[channels]});
  await initialized;
  const send = (method, value) => node.port.onmessage({data:[0, method, value]});
  return {node,scope,send};
}
for (const rate of [0.5, 0.75, 1, 1.5]) {
  test(`real audio remains 440 Hz at ${rate}x`, async () => {
    const {node,scope,send} = await processor();
    const samples = Float32Array.from({length:rateHz * 5}, (_,i) => Math.sin(2*Math.PI*440*i/rateHz)*0.3);
    send('addBuffers', [samples,samples]);
    send('schedule', {active:true,output:0.2,input:0,rate,semitones:0});
    let crossings = 0, last = 0, count = 0, energy = 0;
    for (let frame=0; frame<rateHz*2; frame+=128) {
      scope.currentTime = frame/rateHz;
      const output = [new Float32Array(128),new Float32Array(128)];
      node.process([[]],[output]);
      if(scope.currentTime >= 0.7) for(const value of output[0]) {
        if(last <= 0 && value > 0) crossings++;
        last=value; energy += value*value; count++;
      }
    }
    expect(Math.sqrt(energy/count)).toBeGreaterThan(0.1);
    expect(crossings/(count/rateHz)).toBeCloseTo(440, 0);
  });
}

test('audio events follow the media clock at half speed, including loop disable', async () => {
  const {node,scope,send} = await processor();
  const samples=Float32Array.from({length:rateHz*5},(_,i)=>{
    const t=i/rateHz;
    const envelope=Math.max(0,1-Math.abs((t-1.25)/0.1));
    return Math.sin(2*Math.PI*440*t)*envelope*0.3;
  });
  send('addBuffers',[samples,samples]);
  send('schedule',{active:true,output:0.2,input:1,rate:0.5,semitones:0,loopStart:1,loopEnd:2});
  const peaks=[];let weighted=0,energy=0;
  for(let frame=0;frame<rateHz*7;frame+=128){
    scope.currentTime=frame/rateHz;
    // At 4.4s the audible media position is 1.1 after two complete loops.
    // Schedule loop-off for 4.6 at media 1.2, exactly as the engine does.
    if(frame===Math.ceil(4.4*rateHz/128)*128)send('schedule',{active:true,output:4.6,input:1.2,rate:0.5,semitones:0,loopStart:0,loopEnd:0});
    const output=[new Float32Array(128),new Float32Array(128)];node.process([[]],[output]);
    let blockEnergy=0;for(const value of output[0])blockEnergy+=value*value;
    if(blockEnergy>0.001){weighted+=scope.currentTime*blockEnergy;energy+=blockEnergy;}
    else if(energy>1){peaks.push(weighted/energy);weighted=0;energy=0;}
  }
  expect(peaks).toHaveLength(3);
  for(let i=0;i<3;i++)expect(Math.abs(peaks[i]-(0.7+i*2))).toBeLessThan(0.035);
});

for (const rate of [0.75, 1, 1.5]) {
  test(`shared processing preserves inter-stem phase at ${rate}x`, async () => {
    const {node,scope,send}=await processor(4);
    const count=rateHz*4;
    let seed=1;
    const noise=Float32Array.from({length:count},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return (seed/2**32-0.5)*0.15;});
    const a=Float32Array.from(noise,(v,i)=>v+Math.sin(2*Math.PI*440*i/rateHz)*0.2);
    const b=Float32Array.from(noise,(v,i)=>-v+Math.sin(2*Math.PI*880*i/rateHz)*0.2);
    const mix=Float32Array.from(a,(v,i)=>v+b[i]);
    send('addBuffers',[a,b,mix,new Float32Array(count)]);
    send('schedule',{active:true,output:0.2,input:0,rate,semitones:0});
    let difference=0, energy=0;
    for(let frame=0;frame<rateHz*2;frame+=128){
      scope.currentTime=frame/rateHz;
      const output=Array.from({length:4},()=>new Float32Array(128));node.process([[]],[output]);
      if(scope.currentTime>0.7)for(let i=0;i<128;i++){
        difference+=(output[0][i]+output[1][i]-output[2][i])**2;
        energy+=output[2][i]**2;
      }
    }
    expect(Math.sqrt(difference/energy)).toBeLessThan(0.001);
  });
}
