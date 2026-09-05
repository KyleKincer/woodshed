import { v } from 'convex/values';
import { vGoogleProfile } from '@convex-dev/auth/providers/oauth/google';
import { internalMutation, query } from './_generated/server';
import { accountControl } from './lib/auth';
import { getAuthUserId } from '@convex-dev/auth/core';

export const createUserGoogle = internalMutation({
  args: {
    provider: v.literal('google'),
    providerAccountId: v.string(),
    profile: vGoogleProfile,
  },
  returns: v.id('users'),
  handler: async (ctx, { profile, providerAccountId }) => {
    // Core binds Google's stable account ID to this row atomically. Email is
    // display metadata, never an account-linking or authorization key.
    return await ctx.db.insert('users', {
      googleAccountId: providerAccountId,
      email: profile.email,
      emailVerified: profile.emailVerified,
      name: profile.name,
      picture: profile.picture,
      createdAt: Date.now(),
    });
  },
});

export const me = query({
  args: {},
  returns: v.union(v.null(), v.object({
    id: v.id('users'),
    status: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
  })),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get('users', userId);
    return user ? { id: user._id, name: user.name, email: user.email, status: (await accountControl(ctx, user._id))?.status ?? 'active' } : null;
  },
});
