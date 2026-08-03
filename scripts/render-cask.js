#!/usr/bin/env node
'use strict';

// Render the Homebrew cask for a released version.
//
//   node scripts/render-cask.js 1.0.2 path/to/installers
//
// Prints the cask to stdout; the release workflow commits it to the tap as
// Casks/woodshed.rb. `installers` must hold both macOS DMGs for that version,
// because a cask pins a sha256 per architecture and Homebrew aborts the install
// on a mismatch — so the checksums have to come from the exact files that were
// uploaded, not be filled in later by hand.
//
// Worth knowing why the cask needs a notarized app at all: Homebrew quarantines
// cask-installed apps by default (`cask_opts_quarantine?` returns true unless
// you pass --no-quarantine), so `brew install --cask woodshed` hits the same
// Gatekeeper wall as a browser download. See electron-builder.js.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = 'KyleKincer/woodshed';

// Keyed by the `arch` values the cask declares, which double as the DMG name
// suffix electron-builder produces (see mac.artifactName).
const ARCHS = { arm: 'arm64', intel: 'x64' };

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main([version, installersDir]) {
  if (!version || !installersDir) {
    console.error('usage: render-cask.js <version> <installers-dir>');
    process.exit(2);
  }

  const checksums = {};
  for (const [caskArch, fileArch] of Object.entries(ARCHS)) {
    const dmg = path.join(installersDir, `Woodshed-${version}-mac-${fileArch}.dmg`);
    if (!fs.existsSync(dmg)) {
      console.error(`missing ${dmg} — cannot pin a checksum for the ${caskArch} build`);
      process.exit(1);
    }
    checksums[caskArch] = sha256(dmg);
  }

  // Stanza order follows the Cask Cookbook, which `brew style` enforces.
  process.stdout.write(`cask "woodshed" do
  arch arm: "${ARCHS.arm}", intel: "${ARCHS.intel}"

  version "${version}"
  sha256 arm:   "${checksums.arm}",
         intel: "${checksums.intel}"

  url "https://github.com/${REPO}/releases/download/v#{version}/Woodshed-#{version}-mac-#{arch}.dmg",
      verified: "github.com/${REPO}/"
  name "Woodshed"
  desc "Practice tool that splits songs into stems for play-along"
  homepage "https://github.com/${REPO}/"

  livecheck do
    url :url
    strategy :github_latest
  end

  # Electron 34's floor. A bare symbol already means "this version or newer" —
  # Homebrew's OSDependsOn cop rejects the older ">= :big_sur" spelling.
  depends_on macos: :big_sur

  app "Woodshed.app"

  # The uv-managed Python environment and any downloaded stems live under the
  # app's userData directory, so a zap has real work to do here.
  zap trash: [
    "~/Library/Application Support/Woodshed",
    "~/Library/Preferences/com.kylekincer.woodshed.plist",
    "~/Library/Saved Application State/com.kylekincer.woodshed.savedState",
  ]
end
`);
}

main(process.argv.slice(2));
