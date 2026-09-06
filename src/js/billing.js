import { convex } from './auth.js';
import { anyApi as api } from 'convex/server';
import { exportLibrary } from './export.js';
import { notify, withButtonProgress } from './feedback.js';
let unsubscribe;
let interval = 'year';
let pending = false;
let refreshBilling;
const bytes = n => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
export function renderBilling() {
  const root = document.getElementById('billing-root');
  unsubscribe?.();
  root.innerHTML = '<p role="status">Checking your plan…</p>';
  let latestState;
  const renderState = state => {
    latestState = state;
    if (pending) return;
    const paid = state.access === 'paid';
    root.innerHTML = `<div class="billing-intro"><h1>Plan & billing</h1></div>
      <p class="billing-usage">${bytes(state.usedBytes)} of ${bytes(state.limitBytes)} used</p>
      <div class="billing-plans"><article class="billing-plan"><h2>Free</h2><div class="billing-price">$0</div><p>${bytes(state.freeBytes)} cloud storage</p><p class="hint">About ${Math.floor(state.freeBytes / 24e6)} songs with four stems.</p><ul><li>Local downloads and stem separation</li><li>Playback and practice tools</li><li>Library export</li></ul></article>
      <article class="billing-plan billing-plus"><h2>Plus ${paid ? '<span class="hint">· Your plan</span>' : ''}</h2><div class="billing-interval" role="group" aria-label="Billing frequency"><button type="button" data-interval="month" aria-pressed="${interval === 'month'}">Monthly</button><button type="button" data-interval="year" aria-pressed="${interval === 'year'}">Yearly <span class="billing-saving">Save $4</span></button></div><div class="billing-price" id="plus-price"></div><p class="hint" id="plus-cadence"></p><p><strong>${bytes(state.proBytes)} cloud storage</strong></p><p class="hint">About ${Math.floor(state.proBytes / 24e6)} songs with four stems. Actual capacity depends on length, stem count, and quality.</p><div class="billing-actions">${paid ? '' : '<button class="btn-primary" id="billing-checkout">Get Plus</button>'}</div></article></div>
      <div class="billing-footer"><p class="hint">USD. Cancel anytime. Keep Plus until your paid period ends, then take 14 days to export or reduce your library to the free limit. Older cloud songs above that limit are then removed. Your local files are preserved.</p><div class="billing-actions">${state.hasCustomer ? '<button class="btn-ghost" id="billing-manage">Manage subscription</button>' : ''}<button class="btn-ghost" id="billing-export">Export library</button></div><p id="billing-notice" role="status"></p></div>`;
    const notice = root.querySelector('#billing-notice');
    if (!state.enabled && !paid) {
      root.querySelector('#billing-checkout').disabled = true;
      notice.textContent = 'Upgrades are being set up. Your free library is ready to use.';
    }
    if (state.cancelAtPeriodEnd && state.periodEnd) notice.textContent = `Your plan ends ${new Date(state.periodEnd).toLocaleDateString()}. Manage your subscription to keep it.`;
    if (state.access === 'grace') notice.textContent = `Your paid plan has ended. Export or reduce your cloud library by ${new Date(state.graceEndsAt).toLocaleDateString()} to keep the songs you want.`;
    const updateInterval = () => {
      root.querySelectorAll('[data-interval]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.interval === interval));
      });
      root.querySelector('#plus-price').innerHTML = interval === 'year' ? '$1.67<span> / month</span>' : '$2<span> / month</span>';
      root.querySelector('#plus-cadence').textContent = interval === 'year' ? '$20 billed yearly. Save $4 a year.' : '$2 billed monthly.';
    };
    root.querySelectorAll('[data-interval]').forEach(button => button.onclick = () => {
      interval = button.dataset.interval;
      updateInterval();
    });
    updateInterval();
    const syncPending = () => {
      root.querySelectorAll('#billing-checkout, #billing-manage, #billing-export, [data-interval]').forEach(button => {
        button.disabled = pending || (button.id === 'billing-checkout' && !state.enabled);
      });
    };
    syncPending();
    const open = async (button, action, args) => {
      if (pending) return;
      pending = true;
      syncPending();
      await withButtonProgress(button, 'Opening secure billing…', async () => {
        const url = await convex.action(action, args);
        window.location.assign(url);
      });
      pending = false;
      refreshBilling?.();
    };
    const checkout = root.querySelector('#billing-checkout');
    if (checkout) checkout.onclick = () => open(checkout, api.billing.checkout, { interval });
    const manage = root.querySelector('#billing-manage');
    if (manage) manage.onclick = () => open(manage, api.billing.portal, {});
    root.querySelector('#billing-export').onclick = async event => {
      if (pending) return;
      pending = true;
      syncPending();
      await withButtonProgress(event.currentTarget, 'Preparing export…', async progress => {
        await exportLibrary(progress);
        notify('Library export downloaded.');
      });
      pending = false;
      refreshBilling?.();
    };
  };
  refreshBilling = () => { if (latestState) renderState(latestState); };
  unsubscribe = convex.onUpdate(api.billingData.status, {}, renderState, error => {
    notify(`Could not load your plan: ${error.message}`, { error: true });
    if (!latestState) root.textContent = 'Your plan is unavailable. Reopen Plan & billing to retry.';
  });
}
