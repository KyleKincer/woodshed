# Billing operations

Woodshed uses its own Stripe account, `acct_1UC9gVE6zzDxq9iQ`. Live catalog:

- Product: `woodshed_plus`
- Monthly: `price_1UCAAjE6zzDxq9iQnXFD0C6H` ($2 USD)
- Annual: `price_1UCAAlE6zzDxq9iQ8KxdvSp1` ($20 USD)
- Customer portal: `bpc_1UCACRE6zzDxq9iQ03TD9XP1` (default)
- Production webhook: `we_1UCAHqE6zzDxq9iQP8PgMVZC`
- URL: `https://tidy-kookabura-985.convex.site/stripe/webhook`

No secret belongs in this file. Configure each Convex deployment separately:
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`,
`STRIPE_PRICE_ANNUAL`, `BILLING_SITE_URL`, `STRIPE_BILLING_ENABLED`.
Development uses test credentials and test prices; production uses live values.
Only enable billing after checkout, webhook delivery, portal cancellation, and
quota changes have been verified. A disabled checkout does not disable the
customer portal or existing entitlements.

The production restricted key needs Customers and Checkout Sessions write,
Customer Portal write, and Products, Prices, Subscriptions, and Invoices read.
It does not need payouts, refunds, or account administration. CLI access is for
provisioning; its session credential is not the app's production credential.

The portal allows invoice history, payment-method updates, customer email
updates, and cancellation at period end. Price switching can be added later.
Avoid changing the account's default portal configuration without checking this
app. The Stripe account is dedicated to Woodshed.

Billing identity is bound to the authenticated Convex user, never a submitted
email, customer ID, or price ID. Checkout creation uses a short transaction lease;
customer creation has a stable idempotency key. Repeated clicks reuse an open
checkout. A different interval expires the old checkout before making another.

The Stripe component verifies webhook signatures and mirrors events. Woodshed
then reads canonical subscriptions from Stripe before updating entitlements;
a generation number rejects stale concurrent results. An old cancellation event
cannot remove a newer active subscription. If a customer's subscription history
exceeds the bounded scan, reconciliation fails for manual review rather than
risking removal of paid access.

On payment loss, a materialized grace deadline permits exports for 14 days.
Before cleanup, Stripe is refreshed again. Unavailable Stripe service delays
cleanup. Storage deletion proceeds one song at a time, waits for actual R2
removal to release quota, and rechecks both subscription access and admin limits
before each step. Restoring a paid subscription stops remaining cleanup; files
already deleted cannot be restored from the cloud. Local files are never deleted.

Use `PRO_STORAGE_BYTES` to change new/refreshed Plus allocations (default
5,000,000,000 bytes); existing allocations refresh on the next subscription sync.
Change free and base app allowances in Administration. Paid allocations expand
the app ceiling separately so editing the base does not count them twice.

Validation commands: `npm test`, `npm run typecheck`, `npm run test:desktop`,
`npm run build`. See `storage-economics.md` for cost assumptions.
