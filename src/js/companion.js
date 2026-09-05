import { showDesktopSetup } from './desktop.js';
import { convex } from './auth.js';
import { anyApi as api } from 'convex/server';
let LOCAL = 'http://127.0.0.1:47831';
let code = sessionStorage.getItem('ws.companion') || '';
// Capture pairing before OAuth redirects; never put the credential in a query string.
const fragment = new URLSearchParams(location.hash.slice(1));
if (/^[a-f0-9]{64}$/.test(fragment.get('companion') || '')) {
  code = fragment.get('companion'); sessionStorage.setItem('ws.companion',code);
  history.replaceState(null,'',location.pathname+location.search);
}
export async function localRequest(route, body, method = 'POST') {
  if (!code) { showDesktopSetup(); throw new Error('Connect the desktop companion to process songs.'); }
  let response;
  try { response = await fetch(LOCAL+route,{method,headers:{authorization:`Bearer ${code}`,...(body instanceof Blob ? {} : {'content-type':'application/json'})},body:method==='GET'?undefined:body instanceof Blob?body:JSON.stringify(body||{}),signal:AbortSignal.timeout(body instanceof Blob ? 600_000 : 30_000)}); }
  catch { showDesktopSetup('The companion could not be reached on this computer.'); throw new Error('Companion unavailable. Start it on this computer, then connect in Settings. Allow local-network access if your browser asks.'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Companion request failed.');
  return result;
}
export async function connectCompanion(pairingCode) {
  code = String(pairingCode || code).trim();
  if (!/^[a-f0-9]{64}$/.test(code)) throw new Error('Paste the pairing code printed by your companion.');
  const info = await localRequest('/status',null,'GET');
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(code));
  const tokenHash = Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  const deviceId = await convex.mutation(api.devices.pair,{tokenHash,name:info.name});
  await localRequest('/connect',{convexUrl:import.meta.env.VITE_CONVEX_URL});
  sessionStorage.setItem('ws.companion',code);
  return deviceId;
}
export async function requireCompanion() {
  const info = await localRequest('/status',null,'GET');
  if (!info.connected) return connectCompanion();
  // The backend checks the signed-in account owns this device for every job.
  return info.deviceId;
}
export const localUpload = file => localRequest('/upload',file);
export const legacyLibraries = () => localRequest('/legacy',null,'GET');
export const importLegacy = directory => localRequest('/import',{directory});
export async function disconnectCompanion() {
  const info=await localRequest('/status',null,'GET');
  if (info.deviceId) await convex.mutation(api.devices.revoke,{deviceId:info.deviceId});
  sessionStorage.removeItem('ws.companion');code='';
}

export const hasCompanionCode = () => !!code;

export async function initializeLocalDesktop() {
  const info=await window.woodshedDesktop.info();
  if (!info.companion) throw new Error('The local processor is not ready. Restart Woodshed.');
  LOCAL=`http://127.0.0.1:${info.companion.port}`;
  await connectCompanion(info.companion.token);
  return info;
}
