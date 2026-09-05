# Web app and administration

Chosen address: **https://woodshed.kylekincer.com**. This subdomain already
belongs to the Vercel `woodshed` project. No domain purchase is needed.

The web player and desktop companion share the same interface and account.
Browser-only users can play and manage their synced library. Adding a song
without a paired companion opens a desktop setup dialog. `/download` is public,
including before sign-in; it offers a real ZIP setup package built from the
companion sources. The package requires Node.js 22+, Python 3.11, FFmpeg, Git,
and C++ build tools for BeatNet. It is not a signed native installer. Linux
processing has been tested; macOS and Windows setup still need end-to-end tests.

`npm run build` generates the ZIP. `WOODSHED_WEB_URL` controls its pairing
origin and defaults to the chosen public address. No credentials, local library,
Python runtime, or environment files are included in the ZIP.

## Admin access

`/admin` and the Admin navigation item use the same Google sign-in as the
player. Every admin function checks the server-side owner/admin binding.
`ADMIN_USER_IDS` is a comma-separated allowlist of stable Convex Auth user IDs.
`OWNER_GOOGLE_ACCOUNT_ID` identifies the owner by the stable Google account ID
recorded by the trusted OAuth callback. An email,
client flag, hidden navigation item, or companion token cannot grant admin
access. There is no public self-promotion endpoint.

Development is configured for Kyle Kincer's verified Google account. Production
uses that account's verified Google provider ID, so the owner gets admin access
on first sign-in without a manual grant. Email matches and client-supplied
claims never grant ownership. Removing the owner ID environment variable revokes
that binding; explicit ADMIN_USER_IDS grants still apply. The first arbitrary
signup is never promoted.

Capabilities:

- Paginated user directory and exact email lookup.
- Account identity, verification, join date, usage, effective limits, and notes.
- Storage overrides in MB; blank restores the default, zero blocks new uploads.
- App-wide ceiling and default account quota, editable without deployments.
- Active, export-only, and suspended access states. Export-only prevents local
  processing and settings changes while preserving library playback/export and
  library metadata management. Suspension blocks authenticated library access
  and companion activity. Restoration does not delete or recreate data.
- Revoke individual computers and cancel queued/running jobs.
- Paginated audit history with actor, target, reason, and before/after values.

Administrator accounts cannot be suspended or put in export-only mode from the
UI. Every administrative write requires a reason. User notes are admin-only.
Storage grants never bypass the global cap. Lowering limits never deletes files.
The app policy document overrides environment defaults; a per-user override
wins over the app default. Reservations remain counted until R2 deletion succeeds.

Existing signed media URLs may remain usable for up to six hours after account
suspension; previously downloaded audio cannot be recalled. Backend checks stop
new signatures, mutations, and companion jobs. Existing local processing is
aborted when the companion subscription receives an authorization error.

Permanent account erasure, billing, staff roles, impersonation, and automated
subscription expiry are not implemented. Use export-only mode for an export
grace period; suspension is reversible and preserves the library.

## Production cutover

The Vercel project now targets the production Convex backend,
`tidy-kookabura-985`; development is `jovial-cardinal-295`.
Production was updated on 2026-09-04. Configuration for future deployments:

1. Initialize fresh Auth v2 keys on production (do not copy dev signing keys).
2. Configure the Google OAuth client on production. Add its exact redirect URI:
   `https://tidy-kookabura-985.convex.site/oauth/google/callback`.
   The existing Google client can allow both development and production
   callbacks. Publish the Google consent audience for public registration.
3. Set `AUTH_ALLOWED_ORIGINS=https://woodshed.kylekincer.com` and verify production
   R2 CORS allows that origin. Production R2 credentials already exist; verify
   their bucket and avoid sharing a quota ledger across different deployments.
4. Deploy the backend and web build; Vercel's checked-in build command runs
   `npm run build`, including packaging the companion.
5. Verify real production Google sign-in and check the Admin page as the owner
   and an ordinary account. Owner access is preconfigured by Google account ID.

Live website: https://woodshed.kylekincer.com
Production Vercel deployment: dpl_88vkhKpMwCUGyw2oQSzVTBcWzDNS.
The earlier preview still targets the separate development backend.
R2 credentials are limited to object access; CORS was verified by a real
signed GET from the public website origin. Development and production currently
share the existing R2 bucket; each deployment has its own quota ledger, so test
usage is additional to production usage and must stay within reserved headroom.
