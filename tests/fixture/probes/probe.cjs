const {chromium} = require('playwright');
const OUT = __dirname; const BASE='http://127.0.0.1:5190';
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function ready(p){ await p.waitForFunction(()=>['ready','signin','download'].includes(document.documentElement.dataset.startup),null,{timeout:20000}); await sleep(500);}
async function playerReady(p){ await p.waitForFunction(()=>document.querySelector('#player-root .player')&&!document.querySelector('#player-root .player.is-loading'),null,{timeout:60000}); await sleep(1500);}
const audit = () => {
  const lum = c => { const m=c.match(/[\d.]+/g); if(!m) return null; const [r,g,b,a=1]=m.map(Number); const f=v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)}; return {L:.2126*f(r)+.7152*f(g)+.0722*f(b),a}; };
  const bgOf = el => { for(let e=el;e;e=e.parentElement){ const c=getComputedStyle(e).backgroundColor; const m=c.match(/[\d.]+/g); if(m && (m[3]===undefined||Number(m[3])>0.5)) return c; } return 'rgb(255,255,255)'; };
  const out=[]; const seen=new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (!el.offsetParent && getComputedStyle(el).position!=='fixed') continue;
    const txt=[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join(' ').trim();
    if(!txt) continue; const cs=getComputedStyle(el); if(cs.visibility==='hidden'||Number(cs.opacity)===0) continue;
    const r=el.getBoundingClientRect(); if(r.width<1||r.bottom<0||r.top>innerHeight) continue;
    const fg=lum(cs.color), bg=lum(bgOf(el)); if(!fg||!bg) continue;
    let op=1; for(let e=el;e;e=e.parentElement) op*=Number(getComputedStyle(e).opacity);
    const ratio=(Math.max(fg.L,bg.L)+.05)/(Math.min(fg.L,bg.L)+.05);
    const size=parseFloat(cs.fontSize), bold=Number(cs.fontWeight)>=700; const large=size>=24||(bold&&size>=18.66);
    const need=large?3:4.5; const dis = el.closest(':disabled,[aria-disabled=true]');
    if((ratio<need || op<.99) && !dis) { const k=txt.slice(0,30)+size; if(seen.has(k)) continue; seen.add(k); out.push({t:txt.slice(0,40),size,ratio:+ratio.toFixed(2),opacity:+op.toFixed(2),fg:cs.color,bg:bgOf(el)}); }
  }
  // small targets
  const small=[]; for(const el of document.querySelectorAll('button,a[href],input,select,summary,[role=button]')){ const r=el.getBoundingClientRect(); if(!r.width||r.bottom<0||r.top>innerHeight) continue; if(r.width<24||r.height<24) small.push(`${(el.getAttribute('aria-label')||el.textContent||el.id||el.tagName).trim().slice(0,24)} ${Math.round(r.width)}x${Math.round(r.height)}`);}  
  const sizes={}; for(const el of document.querySelectorAll('button')){const r=el.getBoundingClientRect(); if(!r.width||r.bottom<0||r.top>innerHeight) continue; const h=Math.round(r.height); sizes[h]=(sizes[h]||0)+1;}
  const noname=[...document.querySelectorAll('button')].filter(b=>b.offsetParent&&!(b.getAttribute('aria-label')||b.textContent.trim()||b.title)).length;
  const glyph=[...document.querySelectorAll('button')].filter(b=>b.offsetParent&&!b.getAttribute('aria-label')&&/^[^A-Za-z0-9]{1,3}$/.test(b.textContent.trim())).map(b=>b.textContent.trim()+(b.title?'(title)':''));
  const toggles=[...document.querySelectorAll('button.on,button.active')].filter(b=>b.offsetParent&&!b.hasAttribute('aria-pressed')&&!b.hasAttribute('aria-selected')&&!b.hasAttribute('aria-checked')).map(b=>b.textContent.trim().slice(0,20)||b.getAttribute('aria-label'));
  const landmarks={main:document.querySelectorAll('main,[role=main]').length,nav:document.querySelectorAll('nav,[role=navigation]').length,h1:[...document.querySelectorAll('h1')].filter(h=>h.offsetParent).map(h=>h.textContent.trim()),live:document.querySelectorAll('[aria-live],[role=status],[role=alert]').length};
  const fonts=new Set(); for(const el of document.querySelectorAll('body *')){ if(el.offsetParent) fonts.add(getComputedStyle(el).fontFamily.split(',')[0]); }
  return {lowContrast:out.slice(0,40),lowCount:out.length,small:small.slice(0,40),smallCount:small.length,buttonHeights:sizes,noname,glyph,toggles,landmarks,fonts:[...fonts]};
};
(async()=>{
  const b=await chromium.launch(); const res={};
  for (const theme of ['light','dark']) {
    const ctx=await b.newContext({viewport:{width:1440,height:900},colorScheme:theme}); const p=await ctx.newPage();
    await p.goto(`${BASE}/?fx-jobs=0`); await ready(p); res[`library-${theme}`]=await p.evaluate(audit);
    // focus walk on library
    if(theme==='light'||theme==='dark'){ const stops=[]; for(let i=0;i<9;i++){ await p.keyboard.press('Tab'); await sleep(120); const info=await p.evaluate(()=>{const e=document.activeElement; const cs=getComputedStyle(e); const r=e.getBoundingClientRect(); let bg; for(let x=e.parentElement;x;x=x.parentElement){const c=getComputedStyle(x).backgroundColor; if(!/rgba\(0, 0, 0, 0\)|transparent/.test(c)){bg=c;break;}} return {label:(e.getAttribute('aria-label')||e.textContent||e.tagName).trim().slice(0,30),outline:cs.outlineColor+' '+cs.outlineStyle+' '+cs.outlineWidth,parentBg:bg,rect:[r.x,r.y,r.width,r.height].map(Math.round)};}); stops.push(info); if(i<5) { const r=info.rect; await p.screenshot({path:`${OUT}/focus-${theme}-${i}.png`,clip:{x:Math.max(0,r[0]-16),y:Math.max(0,r[1]-16),width:r[2]+32,height:r[3]+32}}); } } res[`focus-${theme}`]=stops; }
    await p.goto(`${BASE}/?song=glasshouse&fx-practice=tracks`); await ready(p); await playerReady(p); res[`tracks-${theme}`]=await p.evaluate(audit);
    await p.goto(`${BASE}/?song=glasshouse&fx-practice=chart`); await ready(p); await playerReady(p); await sleep(2500); res[`chart-${theme}`]=await p.evaluate(audit);
    await p.goto(`${BASE}/?song=secondwind&fx-practice=tracks`); await ready(p); await playerReady(p); await p.keyboard.press('Shift+M'); await sleep(900); res[`map-${theme}`]=await p.evaluate(audit);
    await ctx.close();
  }
  require('fs').writeFileSync(`${OUT}/probe.json`,JSON.stringify(res,null,1)); await b.close();
})().catch(e=>{console.error(e);process.exit(1)});
