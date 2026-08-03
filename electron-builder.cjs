'use strict';

// electron-builder configuration.
//
// This is a file rather than package.json's "build" field because macOS
// packaging has to fork two ways:
//
//   * With an Apple Developer ID available, sign for distribution and notarize.
//     That is the only thing that makes a *downloaded* build open on a plain
//     double-click, and the only thing that makes `brew install --cask` work
//     (Homebrew quarantines cask apps by default).
//   * Without one, fall back to the ad-hoc signature from
//     scripts/adhoc-sign.js. Good enough to run a build you made yourself;
//     Gatekeeper will still refuse a downloaded copy, because an ad-hoc
//     signature has no team behind it and carries no notarization ticket.
//
// Keeping that fork here means the release workflow, build-local.sh and the
// signing hook all inherit one decision instead of each re-deriving it.
//
// Two naming traps, both of which cost a CI run to find:
//
//   * electron-builder reads this file only when package.json has no "build"
//     key — package.json wins outright and silently.
//   * The extension must stay `.cjs`. Named `electron-builder.js`, this file
//     shadows the CLI on Windows: `.JS` is in the default PATHEXT, so
//     `npx electron-builder` resolves the config in the working directory
//     instead of the real binary, runs it with node, and exits 0 having built
//     nothing. A silent green Windows build that produces no installer.
//     `.cjs` is in electron-builder's discovery list but not in PATHEXT.

// How a certificate reaches us: CI hands electron-builder a base64 .p12 in
// CSC_LINK (opened with CSC_KEY_PASSWORD); locally, CSC_NAME names an identity
// already in the keychain. Either one means "sign for distribution".
//
// Neither means ad-hoc, and note what we *don't* do: fall through to keychain
// auto-discovery. A Developer ID installed for unrelated work shouldn't get
// silently stamped onto this app.
const signForDistribution = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

// Notarization is a separate Apple service with separate credentials, so holding
// a certificate doesn't imply we can notarize. These are the two auth styles
// electron-builder accepts; see getNotarizeOptions() in its macPackager.
const canNotarize =
  Boolean(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) ||
  Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);

// Signed but not notarized is the trap worth shouting about: the app looks
// properly signed to `codesign` and still gets refused by Gatekeeper with
// "Apple could not verify ... is free of malware". The release workflow treats
// the Apple secrets as all-or-nothing so CI can't reach this; a local build
// with half the credentials set can, hence the warning.
if (signForDistribution && !canNotarize) {
  console.warn(
    '\n  ⚠  A signing certificate is configured but no notarization credentials are.\n' +
      '     The build will be signed and NOT notarized, which Gatekeeper still blocks\n' +
      '     for downloaded copies. Set APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD +\n' +
      '     APPLE_TEAM_ID (or the APPLE_API_* trio) to notarize.\n'
  );
}

module.exports = {
  appId: 'com.kylekincer.woodshed',
  productName: 'Woodshed',
  afterPack: 'scripts/adhoc-sign.js',
  files: ['main.js', 'preload.js', 'lib/**/*', 'src/**/*', 'node_modules/**/*'],
  asarUnpack: ['node_modules/ffmpeg-static/**', 'node_modules/ffprobe-static/**'],
  mac: {
    category: 'public.app-category.music',
    artifactName: '${productName}-${version}-mac-${arch}.${ext}',
    target: ['dmg'],

    // Leaving `identity` unset lets electron-builder find the certificate it
    // just imported from CSC_LINK. Setting it to null skips signing entirely,
    // which is what hands the job to scripts/adhoc-sign.js.
    ...(signForDistribution ? {} : { identity: null }),

    // Notarization requires the hardened runtime, so these travel together.
    // They're deliberately off on the ad-hoc path: hardened runtime plus an
    // ad-hoc signature runs into library validation and buys nothing without a
    // notarization ticket. electron-builder's default entitlements already
    // grant what Electron needs under hardened runtime (allow-jit,
    // allow-unsigned-executable-memory, disable-library-validation), so there's
    // no entitlements plist to maintain here.
    hardenedRuntime: signForDistribution,
    notarize: signForDistribution && canNotarize,
  },
  dmg: {
    // electron-builder notarizes and staples the .app and *then* builds the DMG
    // around it, so by default the container someone actually downloads is
    // itself unsigned. That's not cosmetic: Gatekeeper assesses the disk image
    // when it's double-clicked to mount, so an unsigned DMG raises its own
    // "cannot check it for malicious software" dialog even though the app inside
    // is perfectly notarized. Signing here is half the fix — the release
    // workflow notarizes and staples the DMG after this.
    sign: signForDistribution,
  },
  win: {
    artifactName: '${productName}-${version}-win-${arch}.${ext}',
    target: ['nsis'],
  },
  linux: {
    artifactName: '${productName}-${version}-linux-${arch}.${ext}',
    target: ['AppImage'],
    category: 'Audio',
  },
};
