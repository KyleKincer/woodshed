// Fixture handlers for convex/devices.ts. Created by FX1 with the 1.9 fixture's
// handlers moved verbatim; BK3 (wave 0B) owns the bodies from here on (§6.6:
// list, rename, revoke, presence). The seed's `db.devices` and
// `db.devicePresence` rows are the tables that work reads (fx-devices=none|offline|online).
export const handlers = {
  'devices:pair': () => null,
};
