// Clerk → Convex auth. Create a JWT template named "convex" in the Clerk
// dashboard (Configure → JWT Templates → New → Convex); it prints the issuer
// URL to put in CLERK_JWT_ISSUER_DOMAIN.
//
//   npx convex env set CLERK_JWT_ISSUER_DOMAIN https://your-app.clerk.accounts.dev
// Convex statically requires every env var named here to be set before it will
// push, so this must be configured (even to a placeholder) for `convex dev` to
// run at all.
export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: 'convex',
    },
  ],
};
