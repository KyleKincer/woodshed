const {chromium} = require('playwright');
const BASE='http://127.0.0.1:5190';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function ready(page){await page.waitForFunction(()=>['ready','signin','download'].includes(document.documentElement.dataset.startup),null,{timeout:20000});await sleep(400);}
async function playerReady(page){await page.waitForFunction(()=>document.querySelector('#player-root .player')&&!document.querySelector('#player-root .player.is-loading')&&!document.querySelector('#player-root [aria-busy="true"]'),null,{timeout:60000});await sleep(1200);}
const measure = () => {
  const out=[]; const sel='button, a[href], input, select, summary, [role=button], [role=tab], label:has(input[type=checkbox])';
  for (const el of document.querySelectorAll(sel)) {
    const r=el.getBoundingClientRect(); if(!r.width||!r.height) continue;
    const cs=getComputedStyle(el); if(cs.visibility==='hidden'||cs.display==='none') continue;
    if (r.bottom<0||r.top>innerHeight) continue;
    const name=(el.getAttribute('aria-label')||el.textContent||el.id||el.className||el.type||'').trim().replace(/\s+/g,' ').slice(0,40);
    out.push({tag:el.tagName.toLowerCase(),type:el.type||'',name,w:Math.round(r.width),h:Math.round(r.height),x:Math.round(r.x),y:Math.round(r.y),font:cs.fontSize});
  }
  return out;
};
(async()=>{
  const b=await chromium.launch();
  const ctx=await b.newContext({viewport:{width:820,height:1180},deviceScaleFactor:1,hasTouch:true});
  const p=await ctx.newPage();
  const res={};
  // chart view
  await p.goto(`${BASE}/?song=glasshouse&fx-jobs=0`); await ready(p); await playerReady(p);
  await p.waitForSelector('.chart:not([hidden]) svg',{timeout:30000}); await sleep(1500);
  res.media = await p.evaluate(()=>({coarse:matchMedia('(pointer:coarse)').matches, hoverNone:matchMedia('(hover:none)').matches}));
  res.chart = await p.evaluate(measure);
  res.chartReadouts = await p.evaluate(()=>[...document.querySelectorAll('#time, .time, [id*=time], [class*=readout], [class*=bar-read], #bar, .bar')].slice(0,10).map(e=>({id:e.id,cls:e.className,txt:e.textContent.trim().slice(0,40),font:getComputedStyle(e).fontSize,weight:getComputedStyle(e).fontWeight})));
  res.chartLayout = await p.evaluate(()=>{const t=document.querySelector('.transport'); const c=document.querySelector('.chart'); return {transport:t&&t.getBoundingClientRect().toJSON(), chart:c&&c.getBoundingClientRect().toJSON(), scrollH:document.scrollingElement.scrollHeight, header:document.querySelector('header')?.getBoundingClientRect().toJSON()};});
  // tracks view
  await p.goto(`${BASE}/?song=lanterns&fx-jobs=0&fx-practice=tracks`); await ready(p); await playerReady(p);
  res.tracks = await p.evaluate(measure);
  res.tracksLayout = await p.evaluate(()=>({scrollH:document.scrollingElement.scrollHeight, inner:innerHeight, transport:document.querySelector('.transport')?.getBoundingClientRect().toJSON(), transportPos:getComputedStyle(document.querySelector('.transport')).position}));
  require('fs').writeFileSync(__dirname+'/targets.json',JSON.stringify(res,null,1));
  await p.screenshot({path:__dirname+'/tracks-6stem-viewport.png'});
  await p.evaluate(()=>scrollTo(0,99999)); await sleep(300);
  await p.screenshot({path:__dirname+'/tracks-6stem-scrolled.png'});
  await b.close();
})().catch(e=>{console.error(e);process.exit(1)});
