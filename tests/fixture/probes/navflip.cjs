const {chromium}=require('playwright');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{const b=await chromium.launch();const p=await (await b.newContext({viewport:{width:1440,height:900}})).newPage();
await p.goto('http://127.0.0.1:5190/?song=glasshouse&fx-practice=tracks');
await p.waitForFunction(()=>document.querySelector('#player-root .player')&&!document.querySelector('#player-root .player.is-loading'),null,{timeout:60000});await sleep(1500);
await p.screenshot({path:'nav-before.png',clip:{x:0,y:76,width:1440,height:48}});
await p.click('.practice-view button:text-is("Chart")');await sleep(3000);
await p.click('.practice-view button:text-is("Tracks")');await sleep(1200);
await p.screenshot({path:'nav-after.png',clip:{x:0,y:76,width:1440,height:48}});
// waveform touch drag test: does a touch drag create a loop?
await b.close();})();
