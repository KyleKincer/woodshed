import { convex } from './auth.js';
import { anyApi as api } from 'convex/server';
import { exportLibrary } from './export.js';
let unsubscribe;
const bytes = n => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
export function renderBilling() {
  const root = document.getElementById('billing-root');
  unsubscribe?.();
  root.innerHTML = '<p role="status">Checking your plan…</p>';
  unsubscribe = convex.onUpdate(api.billingData.status, {}, state => {
    const paid = state.access === 'paid';
    root.innerHTML = `<div class="billing-intro"><h1>Room for more music</h1><p class="hint">Your practice tools stay free. Plus gives your cloud library more space.</p></div>
      <p class="billing-usage">${bytes(state.usedBytes)} of ${bytes(state.limitBytes)} used</p>
      <div class="billing-plans"><article class="billing-plan"><h2>Free</h2><div class="billing-price">$0</div><p>${bytes(state.freeBytes)} cloud storage</p><p class="hint">About ${Math.floor(state.freeBytes / 24e6)} songs with four stems.</p><ul><li>Local downloads and stem separation</li><li>Playback and practice tools</li><li>Library export</li></ul></article>
      <article class="billing-plan billing-plus"><h2>Plus ${paid ? '<span class="hint">· Your plan</span>' : ''}</h2><div class="billing-price">$2<span> / month</span></div><p>or $20 / year — save $4</p><p><strong>${bytes(state.proBytes)} cloud storage</strong></p><p class="hint">About ${Math.floor(state.proBytes / 24e6)} songs with four stems. Actual capacity depends on length, stem count, and quality.</p><div class="billing-actions">${paid ? '' : '<button class="btn-primary" data-interval="month">Choose monthly</button><button class="btn-ghost" data-interval="year">Choose yearly</button>'}</div></article></div>
      <div class="billing-footer"><p class="hint">USD. Cancel anytime. Keep Plus until your paid period ends, then take 14 days to export or reduce your library to the free limit. Older cloud songs above that limit are then removed. Your local files are preserved.</p><div class="billing-actions">${state.hasCustomer ? '<button class="btn-ghost" id="billing-manage">Manage subscription</button>' : ''}<button class="btn-ghost" id="billing-export">Export library</button></div><p id="billing-notice" role="status"></p></div>`;
    const notice = root.querySelector('#billing-notice');
    if (!state.enabled && !paid) {
      root.querySelectorAll('[data-interval]').forEach(b => b.disabled = true);
      notice.textContent = 'Upgrades are being set up. Your free library is ready to use.';
    }
    if (state.cancelAtPeriodEnd && state.periodEnd) notice.textContent = `Your plan ends ${new Date(state.periodEnd).toLocaleDateString()}. Manage your subscription to keep it.`;
    if (state.access === 'grace') notice.textContent = `Your paid plan has ended. Export or reduce your cloud library by ${new Date(state.graceEndsAt).toLocaleDateString()} to keep the songs you want.`;
    const open = async (button, action, args) => {
      button.disabled = true; notice.textContent = 'Opening Stripe…';
      try { const url = await convex.action(action, args); window.location.assign(url); }
      catch (error) { notice.textContent = error.message; }
      finally { button.disabled = false; }
    };
    root.querySelectorAll('[data-interval]').forEach(b => b.onclick = () => open(b, api.billing.checkout, {interval:b.dataset.interval}));
    const manage = root.querySelector('#billing-manage');
    if (manage) manage.onclick = () => open(manage, api.billing.portal, {});
    root.querySelector('#billing-export').onclick = async event => {
      const button = event.currentTarget; button.disabled = true;
      try { await exportLibrary(text => notice.textContent = text); }
      catch(error) { if(error.name !== 'AbortError') notice.textContent = error.message; }
      finally { button.disabled = false; }
    };
  }, error => { root.textContent = error.message; });
}
