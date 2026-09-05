import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { getUserId, requireWritableUserId } from './lib/auth';
import {
  BITRATES,
  DEFAULT_PRESET,
  MODELS,
  PRESETS,
  STEM_MODES,
  withDefaults,
} from './lib/presets';

/**
 * Everything the UI needs at boot: the user's settings plus the static preset
 * catalogue. Mirrors the old Electron `config:get` IPC call.
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

export const save = mutation({
  args: { settings: v.any() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userId = await requireWritableUserId(ctx);
    const merged = withDefaults(args.settings);
    const row = await ctx.db
      .query('userSettings')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .unique();
    if (row) await ctx.db.patch(row._id, { settings: merged });
    else await ctx.db.insert('userSettings', { userId, settings: merged });
    return merged;
  },
});
