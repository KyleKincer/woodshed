# Building locally

`npm start` runs the source tree. That's fine for most work, but it doesn't
exercise packaging — asar paths, the vendored ffmpeg/ffprobe binaries, the managed
Python environment resolving from inside a bundle. To test what people actually
download:

```bash
npm run try        # build unpacked (fast) and launch the packaged app
npm run try:dmg    # build the real .dmg, then open dist/
```

`npm run try` runs the app binary in the foreground, so logs come back to your
terminal (unlike double-clicking it). Extra flags:

```bash
./scripts/build-local.sh --clean     # wipe dist/ first
./scripts/build-local.sh --no-run    # just build
```

Installers for one platform, if you want them by hand:

```bash
npm run dist:mac      # .dmg for this Mac's architecture
npm run dist:win      # .exe  (run on Windows)
npm run dist:linux    # .AppImage (run on Linux)
```

> **Build on the platform and architecture you're targeting.** `ffmpeg-static`
> downloads a single binary for the install host, so an x64 `.dmg` built on Apple
> Silicon would ship an arm64 ffmpeg and fail at runtime. That's why
> `npm run dist:mac` only builds this machine's architecture, and why CI sets
> `npm_config_arch` per job. (`ffprobe-static` bundles every platform, so it's
> never a problem.)

Local macOS builds are ad-hoc signed and run with no ceremony; a build someone
*downloads* needs notarization. See [signing.md](signing.md).

## Configuration

Build config lives in [`electron-builder.cjs`](../electron-builder.cjs) rather
than a `build` key in `package.json`, so the macOS signing path can branch on
what's in the environment. Two naming traps are documented in that file — both
cost a CI run to find, and both fail quietly.

## The app icon

[`scripts/make-icon.js`](../scripts/make-icon.js) generates `build/icon.png` from
the sidebar logo's geometry — the `◐` mark in `--accent`, drawn rather than
rasterised from a font so it stays crisp at 16px. electron-builder picks `build/`
up as its resources directory automatically and converts to `.icns` / `.ico` per
platform, so there's no icon config to maintain. Re-run it only if the mark or the
palette in `src/css/styles.css` changes:

```bash
node scripts/make-icon.js
```
