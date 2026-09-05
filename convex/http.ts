import { httpRouter } from 'convex/server';

// Auth v2 components mount /auth/.well-known/jwks.json and
// /oauth/google/callback through httpPrefix in convex.config.ts. Refresh and
// sign-out use the validated auth mutations directly from the SPA client.
export default httpRouter();
