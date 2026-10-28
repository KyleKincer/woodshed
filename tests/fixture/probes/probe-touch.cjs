const {chromium} = require('playwright');
const BASE='http://127.0.0.1:5190';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function ready(page){await page.waitForFunction(()=>['ready','signin','download'].includes(document.documentElement.dataset.startup),null,{timeout:20000});await sleep(400);}
async function playerReady(page){await page.waitForFunction(()=>document.querySelector('#player-root .player')&&!document.querySelector('#player-root .player.is-loading')&&!document.querySelector('#player-root [aria-busy="true"]'),null,{timeout:60000});await sleep(1200);}
async function touchDrag(cdp, x1,y1,x2,y2,steps=12,holdMs=0){
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x1,y:y1}]});
  if(holdMs) await sleep(holdMs);
  for(let i=1;i<=steps;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x1+(x2-x1)*i/steps,y:y1+(y2-y1)*i/steps}]});await sleep(16);}
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
}
const state = p => p.evaluate(()=>({time:document.querySelector('#time')?.textContent, loop:document.querySelector('#loop-readout')?.textContent.replace(/\s+/g,' ').trim(), loopOn:document.querySelector('#loop')?.getAttribute('aria-pressed')??document.querySelector('#loop')?.className, follow:[...document.querySelectorAll('button')].filter(b=>/^Follow$/.test(b.textContent.trim())&&b.offsetParent).map(b=>b.getAttribute('aria-pressed')||b.className).join('|'), url:location.href}));
(async()=>{
  const b=await chromium.launch(); const log=[];
  const ctx=await b.newContext({viewport:{width:820,height:1180},deviceScaleFactor:1,hasTouch:true});
  const p=await ctx.newPage(); const cdp=await ctx.newCDPSession(p);
  await p.goto(`${BASE}/?song=lowtide&fx-jobs=0&fx-practice=tracks`); await ready(p); await playerReady(p);
  log.push(['tracks initial', await state(p)]);
  const tl = await p.evaluate(()=>document.querySelector('#timeline-interact').getBoundingClientRect().toJSON());
  log.push(['timeline rect', tl]);
  await p.touchscreen.tap(tl.x+tl.width*0.5, tl.y+200); await sleep(400);
  log.push(['after tap mid waveform', await state(p)]);
  await touchDrag(cdp, tl.x+tl.width*0.2, tl.y+300, tl.x+tl.width*0.45, tl.y+300); await sleep(500);
  log.push(['after touch drag 20%->45% (expect loop)', await state(p)]);
  await p.screenshot({path:__dirname+'/tracks-after-touch-drag.png'});
  // mouse drag for comparison
  await p.mouse.move(tl.x+tl.width*0.2, tl.y+300); await p.mouse.down(); await p.mouse.move(tl.x+tl.width*0.45, tl.y+300,{steps:10}); await p.mouse.up(); await sleep(400);
  log.push(['after MOUSE drag (control)', await state(p)]);
  // chart: stray tap during playback
  await p.goto(`${BASE}/?song=glasshouse&fx-jobs=0&fx-practice=chart`); await ready(p); await playerReady(p); await p.waitForSelector('.chart:not([hidden]) svg'); await sleep(1500);
  await p.touchscreen.tap(48,1052); await sleep(3000);
  log.push(['chart playing 3s', await state(p)]);
  await p.touchscreen.tap(600,860); await sleep(300);
  log.push(['after stray tap on score while playing', await state(p)]);
  // scroll the score by touch -> follow off?
  await touchDrag(cdp, 400,800,400,500,10); await sleep(2500);
  log.push(['after touch scroll during playback', await state(p)]);
  await p.screenshot({path:__dirname+'/chart-after-scroll-playing.png'});
  // long-press arms pendingLoop then forget; later tap
  await p.touchscreen.tap(48,1052); await sleep(300); // stop
  await touchDrag(cdp, 300,700,300,700,1,600); await sleep(300);
  log.push(['after long-press (pending loop)', await state(p)]);
  await sleep(4000);
  await p.touchscreen.tap(500,500); await sleep(500);
  log.push(['plain tap 4s later (becomes loop?)', await state(p)]);
  await p.screenshot({path:__dirname+'/chart-pending-loop-then-tap.png'});
  // header: what does a tap 30px right of back do (wordmark)?
  require('fs').writeFileSync(__dirname+'/touch-log.json',JSON.stringify(log,null,1));
  for(const l of log) console.log(l[0], JSON.stringify(l[1]));
  // Other viewports
  for (const vp of [{width:768,height:1024,n:'ipad97-portrait'},{width:744,height:1133,n:'ipadmini-portrait'},{width:1180,height:820,n:'ipad-landscape'}]) {
    const c=await b.newContext({viewport:{width:vp.width,height:vp.height},deviceScaleFactor:1,hasTouch:true}); const q=await c.newPage();
    await q.goto(`${BASE}/?song=glasshouse&fx-jobs=0&fx-practice=chart`); await ready(q); await playerReady(q); await q.waitForSelector('.chart:not([hidden]) svg'); await sleep(1800);
    await q.screenshot({path:`${__dirname}/chart-${vp.n}.png`});
    const info = await q.evaluate(()=>{const s=document.querySelector('.chart-scroll').getBoundingClientRect(); const t=document.querySelector('.transport').getBoundingClientRect(); return {scrollTop:s.top,scrollH:s.height,transportTop:t.top,transportH:t.height, docScroll:document.scrollingElement.scrollHeight}});
    console.log(vp.n, JSON.stringify(info));
    await q.goto(`${BASE}/?song=lanterns&fx-jobs=0&fx-practice=tracks`); await ready(q); await playerReady(q);
    await q.screenshot({path:`${__dirname}/tracks6-${vp.n}.png`});
    await c.close();
  }
  await b.close();
})().catch(e=>{console.error(e);process.exit(1)});
