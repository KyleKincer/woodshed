// Data migrations (architecture §6.3: `backfillB1`). Owned and implemented by
// package BK1. Distinct from the empty legacy `migrate.ts`. BK0 creates this
// module so `internal.migrations.*` is wired into the hand-edited
// `_generated/api.d.ts` before the first schema push regenerates it.
export {};
