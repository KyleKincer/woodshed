# The fixture

The real app (and every harness page) on in-memory stand-ins for Convex, Convex Auth, the local
processor and the desktop bridge. Contract: `docs/ux2/architecture.md` §11.2 and §11.4.

```
npm run fixture                                   # http://127.0.0.1:$FIXTURE_PORT (default 5190)
npm run fixture:capture -- --states FX1           # run states through lib/runner.cjs
npm run fixture:compare                           # scripts/compare-shots.py: out/ against baselines/2.0/
```

## Layout

| Path | What |
|---|---|
| `vite.config.mjs` | the Vite config: stub resolution, the injected scripts, `/__fixture/early.js`, `/__harness/…` |
| `early.js` | classic script, first in `<head>`: storage switches, `fx-now`, `window.__FIXTURE__` |
| `preamble.js` | first module: boots the database, installs the fakes, builds `window.fixture` |
| `db/index.js` | merges every `db/*.js` `handlers` table; routing, subscriptions, `sessionStorage['fx-db']` |
| `db/seed.js` | seed v2 (what it covers is listed at the top of the file) |
| `db/{songs,jobs,devices,settings,sharing,setlists,metadata}.js` | handlers owned by the wave 0B backend packages |
| `db/{account,media,notation,tempo-sources}.js`, `db/runtime.js` | the fixture's own handlers and helpers |
| `fakes/*.js` | platform, features, manual audio, wake lock, MIDI, Media Session, install prompt, share and clipboard, the local processor, the desktop bridge |
| `stubs/*.js` | `convex/browser`, `@convex-dev/auth/browser`, the OAuth provider |
| `harness/host.js`, `lib/harness.mjs` | the harness host: `tests/harness/**/<name>.harness.js` at `/__harness/<name>` |
| `lib/runner.cjs` | the Playwright runner; `lib/structure.cjs`, `lib/count.cjs`, `lib/touch.cjs` |
| `probes/*.cjs` | targets, focus and touch probes (FX0's geometry and legacy perf probes too) |
| `states/<ID>.cjs` | each package's states (`[{name, url, fn, opts}]`) |
| `out/` | captures, `report.json` and diffs (gitignored) |

## Switches (query parameters)

| Switch | Effect |
|---|---|
| `fx-reset=1` | clear the persisted database and every `ws.*` key before anything runs |
| `fx-prefs=<json>` | deep-merge into `localStorage['ws.prefs']` before `theme-init.js` reads it |
| `fx-now=<ISO>` | `Date` (and so `clock.now()`) starts at that instant and keeps flowing |
| `fx-audio=manual` | `AudioContext.currentTime` moves only through `fixture.advance(ms)` |
| `fx-platform=ipad\|mac\|win` | the navigator looks like that platform (`platform.detect()` also reads it) |
| `fx-nofeature=<list>` | remove `anchor`, `popover`, `wakelock`, `midi`, `mediasession`, `viewtransition`, `share`, `clipboard` |
| `fx-desktop=1` | `window.woodshedDesktop` and the local processor at `127.0.0.1:47831` |
| `fx-update=available\|downloading\|ready` | the desktop update state |
| `fx-processor=starting\|ready\|stopped\|restarting` | the desktop processor phase |
| `fx-companion=offline\|busy\|firstrun\|down` | the processor's `/status` (down: every request fails) |
| `fx-lookup=slow\|fail` · `fx-upload=slow\|fail` · `fx-legacy=1` · `fx-shortcuts=fail` | processor lookups, uploads, the old-library scan, background shortcuts |
| `fx-library=empty\|slow` · `fx-jobs=0\|frozen` | no songs and jobs · the library never arrives · only finished jobs · no job creep |
| `fx-devices=none\|offline\|online` | the paired computers (default: one online, one offline) |
| `fx-account=new` | no stored account settings (first run) |
| `fx-auth=signedout\|suspended\|export_only\|fail` · `fx-signinError=expired` | the account state |
| `fx-billing=free\|plus\|cancel\|grace\|disabled` · `fx-admin=1` | plan and administrator |
| `fx-media=fail\|slow` · `fx-share=missing\|saved` · `fx-detect=ok\|fail\|slow` | stem signing, shared links, beat detection |
| `fx-view`, `fx-practice`, `fx-notation`, `fx-overview` | write the 1.9 `ws.*` keys (exercise the prefs migration) |

Seed-affecting switches (`library`, `jobs`, `billing`, `auth`, `devices`, `account`, `now`) replace a
persisted database made with other values.

## `window.fixture`

`fx` · `db()` (deep copy) · `update(fn)` · `reset()` · `freezeJobs()` · `changed()` · `now()` ·
`platform` · `removed` · `advance(ms)` and `audio` (`fx-audio=manual`) · `wakeLock` · `midi` · `media` ·
`install` · `share` · `clipboard` · `companion`, `upload` and `desktop` (`fx-desktop=1`).
Each fake documents its controls at the top of its file.

## Harnesses

`tests/harness/**/<name>.harness.js` (and the fixture's own `harness/<name>.harness.js`) export
`default async function mount(el, {fixture, query, h})`. The page at `/__harness/<name>` loads
`src/styles/main.css` and the icon sprite like the app, mounts the harness, and sets
`html[data-view-ready=<name>]`. `?theme=light|dark`, `?place=stage` and `?stage=dark|light` set the
root attributes. `/__harness/` lists them.
