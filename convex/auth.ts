import { setupCore } from '@convex-dev/auth/core/setup';
import { setupGoogle } from '@convex-dev/auth/providers/oauth/google';
import { components, internal } from './_generated/api';

const core = setupCore({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

// Explicit origins prevent redirects to a caller-controlled site. Set this
// deployment variable to the public website origin before publishing.
// Read through process.env so bootstrapping from legacy generated/server.js
// does not depend on an env export that the first codegen has yet to create.
const allowedRedirectOrigins = (process.env.AUTH_ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',').map((origin) => origin.trim()).filter(Boolean);

export const { startSignInGoogle, completeSignInGoogle } = setupGoogle(core, {
  component: components.oauthGoogle,
  allowedRedirectOrigins,
}).attachUserCallbacks({ createUser: internal.users.createUserGoogle });
