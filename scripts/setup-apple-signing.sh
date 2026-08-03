#!/usr/bin/env bash
#
# One-time setup for notarized macOS releases.
#
# Notarization is the only thing that lets a downloaded .dmg open on a plain
# double-click, and it needs an Apple Developer ID. This script does every part
# of that which can be automated; the two steps that need an Apple login are
# printed for you to do in a browser.
#
#   ./scripts/setup-apple-signing.sh csr
#       Generate a private key and a certificate request. Upload the request at
#       developer.apple.com, download the certificate, then run:
#
#   ./scripts/setup-apple-signing.sh secrets ~/Downloads/developerID_application.cer
#       Build a .p12 from that certificate, verify your notarization credentials
#       actually work, and set all five GitHub secrets.
#
# The private key stays in ~/.woodshed-signing and never enters the repo.
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

KEY_DIR="$HOME/.woodshed-signing"
KEY="$KEY_DIR/developer-id.key"
CSR="$KEY_DIR/developer-id.csr"
REPO="KyleKincer/woodshed"

# Apple's Developer ID intermediate. Bundling it into the .p12 matters: without
# it, codesign on a CI runner may be unable to build a chain from the leaf up to
# the Apple root, and signing fails with a confusing "unable to build chain".
INTERMEDIATE_URL="https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer"

# The Developer ID certificate on this machine's keychain belongs to Sweetwater
# Sound Inc. Signing a personal app with an employer's identity publishes and
# notarizes it as that employer, so refuse it outright rather than let a
# copy-paste mistake ship.
FORBIDDEN_TEAM="6AK5EVRBB4"

die() { echo "error: $*" >&2; exit 1; }

# Scratch space for the assembled .p12, which holds the signing private key.
# Deliberately global with a default: an EXIT trap fires after the function that
# created it has returned, so a `local` would be out of scope by then and `set -u`
# would abort the trap — leaving the key on disk. That happened once.
WORK=""
cleanup() { [ -n "$WORK" ] && rm -rf "$WORK"; return 0; }
trap cleanup EXIT

cmd_csr() {
  mkdir -p "$KEY_DIR"
  chmod 700 "$KEY_DIR"

  if [ -f "$KEY" ]; then
    echo "==> reusing the existing key at $KEY"
  else
    echo "==> generating a private key"
    (umask 077; openssl genrsa -out "$KEY" 2048 2>/dev/null)
  fi

  read -r -p "Apple ID email for your personal developer account: " apple_id
  [ -n "$apple_id" ] || die "an Apple ID is required"

  echo "==> generating a certificate request"
  openssl req -new -key "$KEY" -out "$CSR" \
    -subj "/emailAddress=$apple_id/CN=Woodshed Developer ID/C=US"

  cat <<EOF

Done. Next, in a browser signed in as $apple_id:

  1. https://developer.apple.com/account/resources/certificates/add
  2. Choose "Developer ID Application".
     If it isn't offered, your account isn't on a paid Individual/Organization
     team — a free team can't notarize.
  3. Upload this request:
       $CSR
  4. Download the issued certificate, then run:
       ./scripts/setup-apple-signing.sh secrets ~/Downloads/developerID_application.cer

Also create an app-specific password at https://appleid.apple.com
(Sign-In and Security -> App-Specific Passwords). You'll be asked for it in
step 4; it is not your Apple ID password.
EOF
}

cmd_secrets() {
  local cer="${1:-}"
  [ -n "$cer" ] || die "usage: setup-apple-signing.sh secrets <path-to-.cer>"
  [ -f "$cer" ] || die "no such file: $cer"
  [ -f "$KEY" ] || die "no private key at $KEY — run 'setup-apple-signing.sh csr' first"
  command -v gh >/dev/null || die "the gh CLI is required to set repository secrets"

  WORK="$(mktemp -d)"
  local work="$WORK"

  # Apple hands out DER; everything downstream wants PEM.
  openssl x509 -inform DER -in "$cer" -out "$work/leaf.pem" 2>/dev/null \
    || cp "$cer" "$work/leaf.pem"

  local subject team
  subject="$(openssl x509 -in "$work/leaf.pem" -noout -subject)"
  echo "==> certificate: $subject"

  case "$subject" in
    *"Developer ID Application"*) ;;
    *) die "that is not a Developer ID Application certificate — notarization needs one" ;;
  esac

  # OU carries the team ID, which is also what notarytool wants.
  team="$(openssl x509 -in "$work/leaf.pem" -noout -subject \
    | tr ',' '\n' | sed -n 's/.*OU *= *//p' | head -1 | tr -d ' ')"
  [ -n "$team" ] || die "could not read a team ID out of the certificate"

  if [ "$team" = "$FORBIDDEN_TEAM" ]; then
    die "that certificate belongs to team $team (Sweetwater Sound Inc). Use a certificate from your personal developer account instead."
  fi
  echo "==> team ID: $team"

  # Verify the private key matches before building anything: a mismatch here is
  # otherwise only discovered as an opaque signing failure in CI.
  local key_mod cert_mod
  key_mod="$(openssl rsa -in "$KEY" -noout -modulus 2>/dev/null)"
  cert_mod="$(openssl x509 -in "$work/leaf.pem" -noout -modulus)"
  [ "$key_mod" = "$cert_mod" ] || die "this certificate does not match the key in $KEY — was it issued from a different request?"
  echo "==> certificate matches the local private key"

  echo "==> fetching Apple's Developer ID intermediate"
  curl -fsSL "$INTERMEDIATE_URL" -o "$work/intermediate.cer"
  openssl x509 -inform DER -in "$work/intermediate.cer" -out "$work/intermediate.pem" 2>/dev/null

  local p12_pass
  p12_pass="$(openssl rand -base64 24)"
  echo "==> building the .p12"
  openssl pkcs12 -export \
    -inkey "$KEY" \
    -in "$work/leaf.pem" \
    -certfile "$work/intermediate.pem" \
    -out "$work/signing.p12" \
    -passout "pass:$p12_pass"

  read -r -p "Apple ID email: " apple_id
  [ -n "$apple_id" ] || die "an Apple ID is required"
  read -r -s -p "App-specific password (from appleid.apple.com): " asp; echo
  [ -n "$asp" ] || die "an app-specific password is required"

  # Ask Apple whether these credentials actually work. Far better to find out
  # now than after a 10-minute build ends in a notarization rejection.
  echo "==> checking the credentials against Apple's notary service"
  if ! xcrun notarytool history --apple-id "$apple_id" --password "$asp" --team-id "$team" >/dev/null 2>"$work/notary.err"; then
    echo "--- notarytool said ---" >&2
    cat "$work/notary.err" >&2
    die "Apple rejected those notarization credentials. Check the Apple ID, the app-specific password, and that team $team is on your account."
  fi
  echo "==> credentials accepted by Apple"

  echo "==> setting repository secrets on $REPO"
  base64 -i "$work/signing.p12" | gh secret set MAC_CSC_LINK --repo "$REPO"
  printf '%s' "$p12_pass" | gh secret set MAC_CSC_KEY_PASSWORD --repo "$REPO"
  printf '%s' "$apple_id" | gh secret set APPLE_ID --repo "$REPO"
  printf '%s' "$asp" | gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo "$REPO"
  printf '%s' "$team" | gh secret set APPLE_TEAM_ID --repo "$REPO"

  cat <<EOF

All five secrets are set. The next release will be signed and notarized:

  ./scripts/release.sh patch

CI fails the build rather than publishing if the result isn't properly notarized,
so a bad setup shows up as a red run, not a broken download.

Keep $KEY — you need it if you ever re-issue the certificate.
EOF
}

case "${1:-}" in
  csr) cmd_csr ;;
  secrets) shift; cmd_secrets "$@" ;;
  *)
    awk 'NR>1 && !/^#/{exit} NR>1{sub(/^# ?/,""); print}' "${BASH_SOURCE[0]}"
    exit 2
    ;;
esac
