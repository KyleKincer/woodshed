#!/usr/bin/env bash
#
# Finish the Cloudflare R2 half of setup, once R2 is enabled on the account.
#
# Creates the bucket, applies the CORS policy the browser needs, and pushes the
# credentials to both Convex and Modal. The Modal secret is rebuilt in full
# (Modal replaces all keys on --force), reusing the shared secret already
# stored in Convex so it never has to be retyped or printed.
#
# Usage:
#   R2_ACCESS_KEY_ID=xxx R2_SECRET_ACCESS_KEY=yyy ./scripts/finish-r2-setup.sh
#
# Create those two in the Cloudflare dashboard under
#   R2 → API → Manage API tokens → Create token (Object Read & Write)
#
# Optional overrides: R2_BUCKET, R2_ACCOUNT_ID, APP_ORIGIN
set -euo pipefail

BUCKET="${R2_BUCKET:-woodshed}"
ACCOUNT_ID="${R2_ACCOUNT_ID:-02ce394a18b10e4dc034e542227eef48}"
ENDPOINT="https://${ACCOUNT_ID}.r2.cloudflarestorage.com"
APP_ORIGIN="${APP_ORIGIN:-http://localhost:5173}"

if [[ -z "${R2_ACCESS_KEY_ID:-}" || -z "${R2_SECRET_ACCESS_KEY:-}" ]]; then
  echo "✗ Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY first." >&2
  echo "  Cloudflare dashboard → R2 → API → Manage API tokens → Object Read & Write" >&2
  exit 1
fi

echo "→ Creating bucket '${BUCKET}' (ok if it already exists)"
npx wrangler r2 bucket create "$BUCKET" 2>&1 | tail -3 || true

# Without this the browser can neither PUT an upload nor GET a stem, and the
# failure shows up as an opaque CORS error rather than anything actionable.
echo "→ Applying CORS policy for ${APP_ORIGIN}"
# R2's own CORS schema — a { "rules": [...] } object, not the S3-style array
# of PascalCase keys. wrangler rejects the S3 shape outright.
CORS_FILE="$(mktemp -t r2cors).json"
cat > "$CORS_FILE" <<JSON
{
  "rules": [
    {
      "allowed": {
        "origins": ["${APP_ORIGIN}"],
        "methods": ["GET", "PUT", "HEAD"],
        "headers": ["content-type"]
      },
      "exposeHeaders": ["content-length"],
      "maxAgeSeconds": 3600
    }
  ]
}
JSON
npx wrangler r2 bucket cors set "$BUCKET" --file "$CORS_FILE" --force 2>&1 | tail -5 || {
  echo "⚠ Could not set CORS via wrangler. Paste this in the dashboard"
  echo "  (R2 → ${BUCKET} → Settings → CORS policy):"
  cat "$CORS_FILE"
}
rm -f "$CORS_FILE"

echo "→ Setting R2 credentials on Convex"
npx convex env set R2_BUCKET            "$BUCKET"    >/dev/null
npx convex env set R2_ENDPOINT          "$ENDPOINT"  >/dev/null
npx convex env set R2_ACCESS_KEY_ID     "$R2_ACCESS_KEY_ID"     >/dev/null
npx convex env set R2_SECRET_ACCESS_KEY "$R2_SECRET_ACCESS_KEY" >/dev/null
echo "  done"

echo "→ Rebuilding the Modal 'woodshed' secret"
# --force replaces every key, so the shared secret has to be included; pull it
# back from Convex rather than reprinting it anywhere.
SHARED="$(npx convex env get MODAL_SHARED_SECRET | tail -1 | tr -d '\r\n')"
if [[ -z "$SHARED" ]]; then
  echo "✗ Could not read MODAL_SHARED_SECRET from Convex." >&2
  exit 1
fi
modal secret create woodshed \
  MODAL_SHARED_SECRET="$SHARED" \
  R2_ENDPOINT="$ENDPOINT" \
  R2_BUCKET="$BUCKET" \
  R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
  R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  --force >/dev/null
unset SHARED
echo "  done"

echo
echo "✓ R2 wired up. Remaining: Clerk (see README §2), then \`npm run dev\`."
