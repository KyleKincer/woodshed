# Releasing

Releases are built by GitHub Actions and triggered by a version tag:

```bash
./scripts/build-local.sh     # smoke-test the packaged app first
./scripts/release.sh patch   # or minor / major / an explicit 0.4.2
```

That bumps `package.json`, commits, tags `vX.Y.Z`, and pushes. The tag kicks off
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which builds

| Platform | Artifact |
| --- | --- |
| macOS (Apple Silicon) | `Woodshed-X.Y.Z-mac-arm64.dmg` |
| macOS (Intel) | `Woodshed-X.Y.Z-mac-x64.dmg` |
| Windows | `Woodshed-X.Y.Z-win-x64.exe` |
| Linux | `Woodshed-X.Y.Z-linux-x86_64.AppImage` |

then publishes them as a GitHub Release with generated notes and points the
Homebrew tap at the new version. Pushing the tag is the only step — nothing to
confirm afterwards.

Notes:

- `./scripts/release.sh --dry-run patch` shows the version it would cut and
  changes nothing.
- The release is only created after all four builds succeed, so it can't appear
  with an installer missing. To walk one back: `gh release delete vX.Y.Z`, or
  `gh release edit vX.Y.Z --draft=true` to hide it while you sort it out.
- The workflow refuses to build if the tag doesn't match `package.json`, so don't
  hand-tag — `release.sh` keeps them in sync.
- You can run the workflow manually from the Actions tab (**Run workflow**) to
  build all four platforms without tagging or releasing; the installers show up as
  run artifacts. The `release` and `homebrew` jobs are tag-gated, so a manual run
  publishes nothing.
- Whether Mac builds come out notarized depends on the secrets in
  [signing.md](signing.md). Without them the pipeline still works, it just ships
  ad-hoc builds that downloaders have to clear by hand.
- CI verifies the mac bundle before uploading it; how strictly depends on which
  path ran (see [signing.md](signing.md)). v1.0.0 and v1.0.1 both shipped `.dmg`s
  a Mac wouldn't open, for two different reasons. Those checks exist so there
  isn't a third.

## The Homebrew tap

The `homebrew` job runs [`scripts/render-cask.js`](../scripts/render-cask.js) to
produce `Casks/woodshed.rb` with a `sha256` pinned per architecture, and commits it
to [`KyleKincer/homebrew-tap`](https://github.com/KyleKincer/homebrew-tap). It runs
after the release is published, because Homebrew downloads from the release assets
and they have to exist first.

The default `GITHUB_TOKEN` can't write to another repo, so the job authenticates
with a **deploy key** (`HOMEBREW_TAP_DEPLOY_KEY`) rather than a PAT — write access
to that one repo, nothing else, not tied to anyone's account. It's already set up;
to rotate it, generate a keypair, add the public half at
[the tap's deploy keys](https://github.com/KyleKincer/homebrew-tap/settings/keys)
with write access, and `gh secret set HOMEBREW_TAP_DEPLOY_KEY` with the private
half.

If the secret is ever missing the job logs a notice and uploads the rendered cask
as a run artifact so you can copy it over by hand — a tap problem can't block a
release.

To render one locally:

```bash
node scripts/render-cask.js 1.0.2 path/to/dir/with/both/dmgs
```
