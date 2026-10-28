// Plan and billing (convex/billingData.ts `status`, convex/billing.ts `checkout`/`portal`;
// architecture §2.1, §9.12 SE2). One-line wrappers over src/api/client.js; every failure is an
// ApiError (§2.1). User-facing copy comes from the caller (Settings → Plan & storage), never here.
//
//   status() → BillingStatus            once
//   subscribeStatus(onValue, onError?)  live; returns off() (Plan & storage closes it on unmount)
//   checkout({interval})                → the Stripe Checkout URL ('month' | 'year')
//   portal()                            → the Stripe customer-portal URL
//
// BillingStatus = {enabled, access: 'free'|'paid'|'grace', status, interval: 'month'|'year'|null,
//   periodEnd, cancelAtPeriodEnd, graceEndsAt, hasCustomer, cleanupPending, usedBytes, limitBytes,
//   freeBytes, proBytes, monthlyCents, annualCents}
import {action, query, subscribe} from './client.js';

/** The billing intervals checkout accepts. */
export const INTERVALS = Object.freeze(['month', 'year']);

export const status = () => query('billingData:status', {});
export const subscribeStatus = (onValue, onError) => subscribe('billingData:status', {}, onValue, onError);
export const checkout = ({interval}) => action('billing:checkout', {interval});
export const portal = () => action('billing:portal', {});
