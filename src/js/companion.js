import { showDesktopSetup } from './desktop.js';
import { convex } from './auth.js';
import { anyApi as api } from 'convex/server';
let LOCAL = 'http://127.0.0.1:47831';
let code = '', ready = false, initialization;
// Local credentials come only from the desktop preload bridge, never browser
// storage or URL fragments. Account authorization still happens in devices.pair.
sessionStorage.removeItem('ws.companion');

async function request(route, body, method = 'POST') {
  let response;
  try {
    response = await fetch(LOCAL + route, {
      method,
      headers: { authorization: `Bearer ${code}`, ...(body instanceof Blob ? {} : {'content-type':'application/json'}) },
      body: method === 'GET' ? undefined : body instanceof Blob ? body : JSON.stringify(body || {}),
      signal: AbortSignal.timeout(body instanceof Blob ? 600_000 : 30_000),
    });
  } catch { throw new Error('Local processor unavailable. Restart Woodshed for desktop to reconnect.'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Local processor request failed.');
  return result;
}
export async function localRequest(route, body, method = 'POST') {
  if (!window.woodshedDesktop) {
    showDesktopSetup();
    throw new Error('Open Woodshed for desktop and sign in to process songs on this computer.');
  }
  if (initialization) await initialization;
  if (!ready) throw new Error('Local processor is not connected. Retry the desktop connection in Settings.');
  return request(route, body, method);
}
export async function desktopStatus() {
  return localRequest('/status', null, 'GET');
}
export async function requireCompanion() {
  const info = await desktopStatus();
  if (!info.connected) throw new Error('Local processor is not connected. Retry the desktop connection in Settings.');
  // The backend checks the signed-in account owns this device for every job.
  return info.deviceId;
}
export const localUpload = file => localRequest('/upload', file);
export const legacyLibraries = () => localRequest('/legacy', null, 'GET');
export const importLegacy = directory => localRequest('/import', {directory});
export const isDesktopApp = () => !!window.woodshedDesktop;

export async function initializeLocalDesktop() {
  if (initialization) return initialization;
  initialization = (async () => {
    ready = false;
    const info = await window.woodshedDesktop.info();
    if (!info.companion || !/^[a-f0-9]{64}$/.test(info.companion.token)) throw new Error('The local processor is not ready. Restart Woodshed.');
    LOCAL = `http://127.0.0.1:${info.companion.port}`;
    code = info.companion.token;
    const status = await request('/status', null, 'GET');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
    const tokenHash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    await convex.mutation(api.devices.pair, {tokenHash, name: status.name});
    await request('/connect', {convexUrl: import.meta.env.VITE_CONVEX_URL});
    ready = true;
    return info;
  })();
  try { return await initialization; }
  finally { initialization = null; }
}
