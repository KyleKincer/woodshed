import type { Auth } from 'convex/server';

// Structural, not one of the GenericXCtx unions: those are invariant in their
// DataModel, so a ctx carrying the real schema won't assign to one carrying
// GenericDataModel. Auth is all these helpers touch anyway.
type AnyCtx = { auth: Auth };

/**
 * The Clerk subject (`user_...`) for the caller. Every user-facing function
 * scopes its reads and writes on this; there is no other tenancy boundary.
 */
export async function requireUserId(ctx: AnyCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error('Not signed in.');
  return identity.subject;
}

/** Null instead of throwing — for queries that render before sign-in settles. */
export async function getUserId(ctx: AnyCtx): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  return identity?.subject ?? null;
}

/** R2 keys are namespaced per user so a leaked key can't cross tenants. */
export function userPrefix(userId: string): string {
  return `users/${userId}`;
}

export function ownsKey(userId: string, key: string): boolean {
  return key.startsWith(`${userPrefix(userId)}/`);
}
