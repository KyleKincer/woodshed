#!/usr/bin/env bash
#
# Build Woodshed for *this* machine and run the packaged app.
#
# `npm start` runs the source tree, which hides the bugs that only show up once
# the app is packaged: asar paths, the vendored ffmpeg/ffprobe binaries, the
# managed Python env resolving from inside a bundle. This builds the real thing
# and launches it in the foreground so you still get the logs.
#
#   ./scripts/build-local.sh            # fast unpacked build, then launch it
#   ./scripts/build-local.sh --dmg      # full .dmg installer, then reveal it
#   ./scripts/build-local.sh --no-run   # just build
#   ./scripts/build-local.sh --clean    # wipe dist/ first
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

mode=dir
run=true
clean=false

for arg in "$@"; do
  case "$arg" in
    --dmg|--installer) mode=installer ;;
    --no-run) run=false ;;
    --clean) clean=true ;;
    -h|--help)
      # Print the header comment block (everything after the shebang, up to the
      # first line of actual code).
      awk 'NR>1 && !/^#/{exit} NR>1{sub(/^# ?/,""); print}' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

version="$(node -p "require('./package.json').version")"

case "$(uname -s)" in
  Darwin) platform_flag=--mac; installer_target=dmg ;;
  Linux)  platform_flag=--linux; installer_target=AppImage ;;
  *)
    echo "This script covers macOS and Linux. On Windows run: npm run dist:win" >&2
    exit 1
    ;;
esac

if [ ! -d node_modules ]; then
  echo "==> node_modules missing, running npm install"
  npm install
fi

if [ "$clean" = true ]; then
  echo "==> removing dist/"
  rm -rf dist
fi

# Signing: electron-builder.cjs picks the path. With no CSC_LINK/CSC_NAME in the
# environment — the normal case here — it sets `mac.identity: null` and
# scripts/adhoc-sign.js applies an ad-hoc signature, which is what makes the
# built app launchable at all on Apple Silicon. Local builds aren't quarantined,
# so that's all they need; a *download* needs notarization (see the README).

if [ "$mode" = installer ]; then
  echo "==> building Woodshed $version installer ($installer_target, this machine's arch)"
  npx --no-install electron-builder "$platform_flag" "$installer_target" --publish never
else
  echo "==> building Woodshed $version unpacked (fast, no installer)"
  npx --no-install electron-builder "$platform_flag" --dir --publish never
fi

if [ "$run" != true ]; then
  echo "==> done. Output in ./dist"
  exit 0
fi

if [ "$mode" = installer ]; then
  echo
  echo "==> built:"
  ls -lh dist/*."$installer_target" 2>/dev/null || true
  if [ "$platform_flag" = --mac ]; then
    open dist
  fi
  exit 0
fi

# Launch the packaged binary directly (not `open`) so stdout/stderr land here.
if [ "$platform_flag" = --mac ]; then
  app="$(find dist -maxdepth 2 -name '*.app' -type d | head -1)"
  if [ -z "$app" ]; then
    echo "could not find a built .app under dist/" >&2
    exit 1
  fi
  binary="$app/Contents/MacOS/$(basename "$app" .app)"
else
  binary="$(find dist -maxdepth 2 -type f -perm -u+x -name 'woodshed*' | head -1)"
  if [ -z "$binary" ]; then
    echo "could not find a built executable under dist/" >&2
    exit 1
  fi
fi

echo
echo "==> launching $binary"
echo "    (ctrl-c to quit; this is the packaged app, not npm start)"
echo
exec "$binary"
