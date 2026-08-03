# macOS signing and notarization

macOS packaging takes one of two paths, decided by whether an Apple Developer ID
is available. [`electron-builder.cjs`](../electron-builder.cjs) makes that call
once and everything else follows from it.

**Notarized** (needs the secrets below). electron-builder signs with the Developer
ID certificate under the hardened runtime, notarizes the app and staples the
ticket into it; the workflow then signs and notarizes the `.dmg` around it. Both
halves matter — Gatekeeper assesses the disk image when it's double-clicked to
mount, so notarizing only the app leaves the download itself warning. Downloads
then open on a plain double-click, and `brew install --cask` works — Homebrew
quarantines cask apps by default, so it needs notarization just as much as a
browser download does.

**Ad-hoc** (no secrets). [`scripts/adhoc-sign.js`](../scripts/adhoc-sign.js)
applies a `codesign --sign -` signature instead. Builds you make yourself run with
no ceremony, but Gatekeeper refuses a downloaded copy — an ad-hoc signature has no
team behind it and no notarization ticket — with *"Apple could not verify Woodshed
is free of malware"*. Clear it by hand:

```bash
xattr -dr com.apple.quarantine /Applications/Woodshed.app
```

(Or System Settings → Privacy & Security → **Open Anyway**. On current macOS the
old right-click → Open trick no longer works for un-notarized apps.)

Ad-hoc still beats *unsigned*, which is why the hook exists: skipping signing
leaves the renamed Electron binary's stale linker signature on the bundle, and
macOS rejects that outright as "Woodshed is damaged and can't be opened" — worse,
because no workaround bypasses an invalid signature. v1.0.0 shipped that way.

## Turning notarization on

Requires an [Apple Developer Program](https://developer.apple.com/programs/)
membership ($99/yr) on a paid Individual or Organization team — a free team can't
issue a Developer ID or notarize.

[`scripts/setup-apple-signing.sh`](../scripts/setup-apple-signing.sh) does the
mechanical parts:

```bash
./scripts/setup-apple-signing.sh csr
#   -> upload the request at developer.apple.com, download the certificate
./scripts/setup-apple-signing.sh secrets ~/Downloads/developerID_application.cer
```

The second step assembles the `.p12`, verifies it, and sets all five repository
secrets:

| Secret | Where it comes from |
| --- | --- |
| `MAC_CSC_LINK` | Base64 of the assembled *Developer ID Application* `.p12` |
| `MAC_CSC_KEY_PASSWORD` | Randomly generated when the `.p12` is built |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password from [appleid.apple.com](https://appleid.apple.com) |
| `APPLE_TEAM_ID` | Read out of the certificate's OU |

It verifies rather than assumes, because every one of these failed once:

- Bundles Apple's Developer ID intermediate into the `.p12`. Without it, signing
  on a runner can fail to build a chain up to the Apple root.
- Checks the certificate against the local private key, so a certificate issued
  from a different request is caught here instead of as an opaque signing error.
- Imports the `.p12` into a throwaway keychain the way a runner will. OpenSSL 3
  writes PKCS#12 files macOS refuses to import and reports as *"MAC verification
  failed (wrong password?)"* — a password error that has nothing to do with the
  password.
- Asks Apple whether the notarization credentials work, with `notarytool`, before
  storing any of them.

The private key lives in `~/.woodshed-signing` and never enters the repo. Keep
it — re-issuing the certificate needs it.

All five secrets or none. A certificate *without* notarization credentials is the
trap worth knowing about: the bundle satisfies `codesign` and Gatekeeper still
shows the same "could not verify" dialog, so it looks fixed without being fixed.
The release workflow fails fast on a partial set, and a local build warns.

> **Use a certificate from your own developer account.** Signing a personal app
> with an employer's Developer ID publishes and notarizes it under their identity.
> The setup script refuses the *Sweetwater Sound Inc* team by name, because that's
> the Developer ID that happens to be in this machine's keychain.

CI then asserts what actually matters to whoever downloads it — a Developer ID
authority, a stapled ticket (`stapler validate`) and `spctl` acceptance — rather
than merely that a signature verifies. v1.0.1 passed the weaker check and was
still blocked.

Nothing here is required to build or release; without the secrets the pipeline
just produces ad-hoc builds as before.
