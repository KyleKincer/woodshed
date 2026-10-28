import { v } from 'convex/values';
import { env, mutation, query, type MutationCtx } from './_generated/server';
import { getUserId, requireUserId } from './lib/auth';
import { fail } from './lib/errors';
import {
  BITRATES,
  DEFAULT_PRESET,
  MODELS,
  PRESETS,
  STEM_MODES,
  checkPatch,
  mergeSettings,
  sameSettings,
  withDefaults,
} from './lib/presets';

// Account settings (architecture §6.5). `userSettings.settings` stays `v.any()`
// in the schema; its shape is enforced here, on every write. Stored 1.9 rows are
// read through `withDefaults` (new keys appear, the retired `format` goes) and
// are rewritten in the 2.0 shape by their first `patch`, so no backfill exists.

const instrumentValidator = v.union(
  v.literal('drums'),
  v.literal('bass'),
  v.literal('guitar'),
  v.literal('keys'),
  v.literal('vocals'),
  v.literal('other'),
);

export const profileValidator = v.object({
  instruments: v.array(instrumentValidator), // ≤ 6, deduplicated
  primary: v.union(v.null(), instrumentValidator),
  openWithMyPart: v.union(v.literal('in'), v.literal('out')),
});

export const practiceDefaultsValidator = v.object({
  stop: v.union(v.literal('cue'), v.literal('stay')),
  countIn: v.object({ on: v.boolean(), length: v.number() /* 1–16 */, unit: v.union(v.literal('bars'), v.literal('beats')) }),
  click: v.union(v.literal('off'), v.literal('countin'), v.literal('always')),
  eachPassCount: v.boolean(),
  keepPitch: v.boolean(),
  wake: v.union(v.literal(5), v.literal(10), v.literal(30), v.literal('always')),
});

export const settingsPatchValidator = v.object({
  preset: v.optional(v.string()),
  stemMode: v.optional(v.string()),
  bitrate: v.optional(v.number()),
  custom: v.optional(v.object({ model: v.string(), shifts: v.number(), overlap: v.number() })),
  autoBeats: v.optional(v.boolean()),
  notifyReady: v.optional(v.boolean()),
  profile: v.optional(profileValidator),
  pins: v.optional(v.array(v.id('songs'))), // ≤ 12, deduplicated, owned
  onboarding: v.optional(v.object({
    whatDoYouPlay: v.optional(v.union(v.literal('done'), v.literal('skipped'))),
    coach: v.optional(v.number()),
    desktopFirstRun: v.optional(v.boolean()),
  })),
  practice: v.optional(practiceDefaultsValidator.partial()),
  autoSections: v.optional(v.boolean()),
  // Written true with stemMode/preset by the Add sheet's "Use these for future songs";
  // `addDefaults` honours a stored stemMode only when this is true (or the mode is 'six').
  addDefaultsSaved: v.optional(v.boolean()),
});

const DEMO_TOKEN_RE = /^[a-f0-9]{64}$/;

/**
 * Everything the UI needs at boot: the user's settings (over the defaults) plus
 * the static preset catalogue.
 */
export const config = query({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const userId = await getUserId(ctx);
    const row = userId
      ? await ctx.db
          .query('userSettings')
          .withIndex('by_user', (q) => q.eq('userId', userId))
          .unique()
      : null;
    return {
      settings: withDefaults(row?.settings),
      presets: PRESETS,
      defaultPreset: DEFAULT_PRESET,
      models: MODELS,
      stemModes: STEM_MODES,
      bitrates: BITRATES,
    };
  },
});

/** Pins name the caller's songs: a deleted song is dropped, someone else's is refused. */
async function ownedPins(ctx: MutationCtx, userId: string, pins: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const raw of pins) {
    const id = ctx.db.normalizeId('songs', raw);
    const song = id ? await ctx.db.get('songs', id) : null;
    if (!song) continue;
    if (song.userId !== userId) fail('not_owner', 'You can pin only your own songs.', { field: 'pins' });
    out.push(raw);
  }
  return out;
}

/**
 * Merges a partial change into the caller's settings. Two clients that patch
 * different keys never undo each other: each patch merges onto the stored row,
 * key by key (`mergeSettings`), inside one transaction. Export-only accounts may
 * patch (D10: settings are personal state); suspended accounts may not. Returns
 * the merged settings.
 */
export const patch = mutation({
  args: { patch: settingsPatchValidator },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const checked = checkPatch(args.patch);
    if (!checked.ok) fail(checked.code, checked.message, { field: checked.field });
    const change = checked.patch;
    if (change.pins) change.pins = await ownedPins(ctx, userId, change.pins);
    const row = await ctx.db
      .query('userSettings')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .unique();
    const next = mergeSettings(withDefaults(row?.settings), change);
    if (!row) await ctx.db.insert('userSettings', { userId, settings: next });
    // Key order is not compared: the database returns fields in its own order.
    else if (!sameSettings(row.settings, next)) await ctx.db.replace('userSettings', row._id, { userId, settings: next });
    return next;
  },
});

/** B8 (D7): the demo song's share token, from the deployment's `DEMO_SHARE_TOKEN`; null unless it is 64 hex characters. */
export const demo = query({
  args: {},
  returns: v.union(v.null(), v.object({ token: v.string() })),
  handler: async () => {
    const token = env.DEMO_SHARE_TOKEN ?? '';
    return DEMO_TOKEN_RE.test(token) ? { token } : null;
  },
});
