#!/usr/bin/env bash
#
# Cut a new Woodshed version: bump package.json, tag it, push the tag.
# Pushing the tag is what triggers .github/workflows/release.yml, which builds
# every platform and publishes a GitHub Release with the installers attached.
#
#   ./scripts/release.sh patch          # 0.1.0 -> 0.1.1
#   ./scripts/release.sh minor          # 0.1.0 -> 0.2.0
#   ./scripts/release.sh major          # 0.1.0 -> 1.0.0
#   ./scripts/release.sh 0.4.2          # explicit version
#   ./scripts/release.sh patch --dry-run
#
# Smoke-test the packaged app first: ./scripts/build-local.sh
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

RELEASE_BRANCH=main

bump=""
dry_run=false
allow_branch=false

for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) dry_run=true ;;
    --allow-branch) allow_branch=true ;;
    -h|--help)
      # Print the header comment block (everything after the shebang, up to the
      # first line of actual code).
      awk 'NR>1 && !/^#/{exit} NR>1{sub(/^# ?/,""); print}' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    -*)
      echo "unknown option: $arg (try --help)" >&2
      exit 2
      ;;
    *)
      if [ -n "$bump" ]; then
        echo "expected a single version argument, got '$bump' and '$arg'" >&2
        exit 2
      fi
      bump="$arg"
      ;;
  esac
done

if [ -z "$bump" ]; then
  echo "usage: ./scripts/release.sh <patch|minor|major|X.Y.Z> [--dry-run]" >&2
  exit 2
fi

case "$bump" in
  patch|minor|major|prepatch|preminor|premajor|prerelease) ;;
  [0-9]*.[0-9]*.[0-9]*) ;;
  *)
    echo "'$bump' is not a bump keyword or an X.Y.Z version" >&2
    exit 2
    ;;
esac

die() { echo "error: $*" >&2; exit 1; }

# --- preflight -------------------------------------------------------------
# Everything here is about not shipping a tag that doesn't match what's on
# origin, because the release is built from the tag, not from your disk.

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "$RELEASE_BRANCH" ] && [ "$allow_branch" != true ]; then
  die "on branch '$branch', not '$RELEASE_BRANCH' (use --allow-branch to override)"
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short --untracked-files=no >&2
  die "uncommitted changes — commit or stash them first"
fi

echo "==> fetching origin"
git fetch --quiet origin

if git rev-parse -q --verify "refs/remotes/origin/$branch" >/dev/null; then
  behind="$(git rev-list --count "HEAD..origin/$branch")"
  ahead="$(git rev-list --count "origin/$branch..HEAD")"
  if [ "$behind" != 0 ]; then
    die "$branch is $behind commit(s) behind origin/$branch — pull first"
  fi
  if [ "$ahead" != 0 ]; then
    # The release is built from the tag on origin, so push first and keep the
    # release commit from dragging unrelated work along with it.
    die "$branch is $ahead commit(s) ahead of origin/$branch — push them first"
  fi
elif [ "$allow_branch" != true ]; then
  die "origin/$branch does not exist — push the branch first"
else
  echo "    (warning: origin/$branch does not exist yet)"
fi

current="$(node -p "require('./package.json').version")"

# Work out the resulting version up front so we can show it and check the tag
# is free before mutating anything. Deliberately dependency-free (no semver
# package): pre-release bumps are left for npm to compute.
next="$(node -e '
  const [bump, current] = process.argv.slice(1);
  if (/^\d+\.\d+\.\d+/.test(bump)) { console.log(bump); process.exit(0); }
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (!m) process.exit(0);
  let [major, minor, patch] = m.slice(1).map(Number);
  if (bump === "major") { major++; minor = 0; patch = 0; }
  else if (bump === "minor") { minor++; patch = 0; }
  else if (bump === "patch") { patch++; }
  else process.exit(0);
  console.log(`${major}.${minor}.${patch}`);
' "$bump" "$current")"

if [ -n "$next" ]; then
  tag="v$next"
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    die "tag $tag already exists"
  fi
else
  next="(computed by npm)"
  tag="(computed by npm)"
fi

echo "==> $current -> $next  (tag $tag)"

if [ "$dry_run" = true ]; then
  echo
  echo "dry run — would have done:"
  echo "  npm version $bump -m 'Release v%s'"
  echo "  git push origin $branch --follow-tags"
  exit 0
fi

# --- do it -----------------------------------------------------------------

echo "==> bumping version"
# npm version updates package.json + package-lock.json, commits, and tags vX.Y.Z.
npm version "$bump" --message "Release v%s"

new_version="$(node -p "require('./package.json').version")"
new_tag="v$new_version"

echo "==> pushing $branch and $new_tag"
git push origin "$branch" --follow-tags

echo
echo "==> released $new_tag"

remote_url="$(git remote get-url origin)"
slug="$(echo "$remote_url" | sed -E 's#^(git@github.com:|https://github.com/)##; s#\.git$##')"
if [ -n "$slug" ]; then
  echo "    CI:      https://github.com/$slug/actions/workflows/release.yml"
  echo "    Release: https://github.com/$slug/releases/tag/$new_tag (once the builds finish)"
fi
if command -v gh >/dev/null 2>&1; then
  echo
  echo "    watch:   gh run watch \$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
  echo "    undo:    gh release delete $new_tag"
fi
