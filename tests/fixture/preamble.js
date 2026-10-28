// Runs before the app: desktop bridge, local-processor HTTP, and a clean slate.
import {fx} from './db.js';
if (fx.reset !== '0' && !sessionStorage.getItem('fx-booted')) {
  // Each fresh tab starts from the fixture defaults; keep theme from the URL.
  for (const key of Object.keys(localStorage)) if (key.startsWith('ws.') && key !== 'ws.theme') localStorage.removeItem(key);
  sessionStorage.setItem('fx-booted', '1');
}
if (fx.view) localStorage.setItem('ws.view', JSON.stringify({group: fx.view.split('-')[0], layout: fx.view.split('-')[1] || 'grid'}));
if (fx.practice) localStorage.setItem('ws.practice.view', fx.practice);
if (fx.overview) localStorage.setItem('ws.overview', '1');
if (fx.notation) localStorage.setItem('ws.notation.layout', fx.notation);
if (fx.desktop === '1') {
  let updateListener = null;
  window.woodshedDesktop = {
    info: async () => ({version: '1.9.0', companion: {port: 47831, token: 'f'.repeat(64)}, update: {status: fx.update || 'idle', percent: 40}}),
    onUpdate: fn => { updateListener = fn; },
    onOpenUpdates: () => {},
    update: async () => {},
    setTheme: async () => {},
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(input?.url || input);
    if (!url.startsWith('http://127.0.0.1:47831')) return realFetch(input, init);
    const route = new URL(url).pathname;
    const body = {'/status': {connected: fx.companion !== 'offline', deviceId: 'dev1', name: 'Studio MacBook'}, '/connect': {}, '/upload': {id: 'local-upload'}, '/legacy': [], '/export-originals': {count: 48, directory: '~/Downloads/Woodshed export'}}[route] ?? {};
    await new Promise(r => setTimeout(r, route === '/upload' ? 900 : 50));
    return new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});
  };
}
