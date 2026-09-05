import { defineApp } from 'convex/server';
import { v } from 'convex/values';
import r2 from '@convex-dev/r2/convex.config';
import auth from '@convex-dev/auth/core/convex.config';
import oauth from '@convex-dev/auth/providers/oauth/convex.config';
import stripe from '@convex-dev/stripe/convex.config.js';

const app = defineApp({
  env: {
    AUTH_PRIVATE_KEY: v.string(),
    AUTH_JWKS: v.string(),
    AUTH_GOOGLE_CLIENT_ID: v.string(),
    AUTH_GOOGLE_CLIENT_SECRET: v.string(),
    OWNER_GOOGLE_ACCOUNT_ID: v.optional(v.string()),
    ADMIN_USER_IDS: v.optional(v.string()),
    AUTH_ALLOWED_ORIGINS: v.optional(v.string()),
    STRIPE_SECRET_KEY: v.optional(v.string()),
    STRIPE_WEBHOOK_SECRET: v.optional(v.string()),
    STRIPE_PRICE_MONTHLY: v.optional(v.string()),
    STRIPE_PRICE_ANNUAL: v.optional(v.string()),
    STRIPE_BILLING_ENABLED: v.optional(v.string()),
    BILLING_SITE_URL: v.optional(v.string()),
    PRO_STORAGE_BYTES: v.optional(v.string()),
  },
});
app.use(r2);
app.use(stripe);
app.use(auth, {
  httpPrefix: '/auth',
  env: {
    AUTH_PRIVATE_KEY: app.env.AUTH_PRIVATE_KEY,
    AUTH_JWKS: app.env.AUTH_JWKS,
  },
});
app.use(oauth, {
  name: 'oauthGoogle',
  httpPrefix: '/oauth/google',
  env: {
    CLIENT_ID: app.env.AUTH_GOOGLE_CLIENT_ID,
    CLIENT_SECRET: app.env.AUTH_GOOGLE_CLIENT_SECRET,
  },
});

export default app;
