'use strict';

// electron-builder `afterPack` hook: give the macOS bundle a valid ad-hoc
// signature.
//
// Why this exists: we have no Apple Developer certificate, so electron-builder
// skips signing (`mac.identity: null`). But skipping isn't neutral — the
// packaged .app still carries the *stock Electron binary's* linker signature,
// which no longer matches the bundle once it's been renamed and filled with our
// files. macOS sees a signature that doesn't verify and refuses to launch the
// app at all: "Woodshed is damaged and can't be opened." An invalid signature is
// worse than none, because right-click → Open can't bypass it. v1.0.0 shipped
// that way.
//
// An ad-hoc signature (`codesign --sign -`) isn't tied to a developer identity
// and Gatekeeper still won't trust it for distribution — downloads remain
// quarantined and need the `xattr` step in the README. But the signature is
// *valid*, so the app runs once quarantine is cleared, and locally built copies
// (`npm run try`) run with no ceremony at all.
//
// Signing here rather than letting electron-builder do it also keeps any real
// Developer ID certificate that happens to be in the developer's keychain from
// being picked up and stamped onto a personal app.

const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  console.log(`  • ad-hoc signing  ${appPath}`);

  // --deep is discouraged for real distribution signing, but it's the right
  // tool for a one-shot ad-hoc pass over Electron's nested helpers and
  // frameworks. No --options runtime: hardened runtime with an ad-hoc signature
  // brings library-validation problems and buys us nothing without notarization.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });

  // Fail the build here rather than shipping another "damaged" installer.
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit',
  });

  // `codesign -dv` reports on stderr, not stdout.
  const info = spawnSync('codesign', ['-dv', appPath], { encoding: 'utf8' });
  const identifier = /^Identifier=(.*)$/m.exec(info.stderr || '');
  if (!identifier || identifier[1] !== context.packager.appInfo.id) {
    throw new Error(
      `ad-hoc signature reports identifier "${identifier ? identifier[1] : 'unknown'}", ` +
        `expected "${context.packager.appInfo.id}" — the signature does not cover this app`
    );
  }
  console.log(`  • ad-hoc signed   identifier=${identifier[1]}`);
};
