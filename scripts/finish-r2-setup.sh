#!/usr/bin/env bash
set -euo pipefail
# Credential setup is on the Convex deployment only; the companion gets signed URLs.
: "${R2_BUCKET:?Set R2_BUCKET}"
: "${R2_ENDPOINT:?Set R2_ENDPOINT}"
: "${R2_ACCESS_KEY_ID:?Set R2_ACCESS_KEY_ID}"
: "${R2_SECRET_ACCESS_KEY:?Set R2_SECRET_ACCESS_KEY}"
for key in R2_BUCKET R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  npx convex env set "$key=${!key}" >/dev/null
done
printf 'R2 credentials configured. Allow your website origins in bucket CORS for GET and HEAD, exposing content-length.\n'
