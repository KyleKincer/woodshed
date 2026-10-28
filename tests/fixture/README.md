# The fixture

The real app (and every harness page) on in-memory stand-ins for Convex, Convex Auth, the local
processor and the desktop bridge. Contract: `docs/ux2/architecture.md` §11.2 and §11.4.

```
npm run fixture                                   # http://127.0.0.1:$FIXTURE_PORT (default 5190)
npm run fixture:capture -- --states FX1           # run states through lib/runner.cjs
npm run fixture:capture -- --strict-requires      # integrations: a state's missing opts.requires file fails it
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

## The database

`db/seed.js` builds the tables listed at the top of that file. Song rows hold only values
`convex/schema.ts` allows: an optional column without a value is absent, never `null`
(`publicSong` in `db/runtime.js` reads it as `null`, as `toClient` does). Three tables are created
by the handlers on first use and are not seeded:

| Table | Shape | Written by |
|---|---|---|
| `db.shareCopies` | `{[songId]: copyId}` | `db/sharing.js`: the first "Add to my library" of a shared song (`<songId>-copy`) |
| `db.metadataLookups` | `{[songId]: dueAt}` | `db/metadata.js`: `metadataLookup:retry`; a reload finishes a lookup that is due |
| `db.admin` | `{users, controls, devices, jobs, audit, policy, fundedBytes, appUsed, seq}` | `db/account.js`: the other accounts Administration manages (`seedAdmin`), created on the first admin call; every admin mutation writes `audit` |

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
| `fx-companion=offline\|busy\|firstrun\|down` | the processor's `/status` (down: every request fails; an upload errors at once, with no progress) |
| `fx-lookup=slow\|fail` · `fx-upload=slow\|fail` · `fx-legacy=1` · `fx-shortcuts=fail` | processor lookups, uploads, the old-library scan, background shortcuts |
| `fx-library=empty\|slow` · `fx-jobs=0\|frozen` | no songs and jobs · the library never arrives · only finished jobs · no job creep |
| `fx-devices=none\|offline\|online` | the paired computers (default: one online, one offline) |
| `fx-account=new` | no stored account settings (first run) |
| `fx-auth=signedout\|suspended\|export_only\|fail` · `fx-signinError=expired` | the account state |
| `fx-billing=free\|plus\|cancel\|grace\|disabled` · `fx-admin=1` | plan and administrator (without `fx-admin=1` every admin call but `admin:access` is refused, `not_owner`) |
| `fx-media=fail\|slow` · `fx-detect=ok\|fail\|slow` | stem signing, beat detection |
| `fx-share=missing\|saved\|copying` | every shared link is unavailable · the shared song is already in the library · a save is in progress (`sharing:saved` reports `copying`) |
| `fx-view`, `fx-practice`, `fx-notation`, `fx-overview` | write the 1.9 `ws.*` keys (exercise the prefs migration; not with `fx-prefs`) |

Seed-affecting switches (`library`, `jobs`, `billing`, `auth`, `devices`, `account`, `now`) replace a
persisted database made with other values.

**Switches stick for the tab.** A URL with any `fx-*` parameter replaces the tab's switches
(`sessionStorage['fx-switches']`; `fx-reset` itself is not kept). A URL with none uses the stored
ones, so a reload after the app rewrote the URL keeps the database, `fx-now`, `fx-platform`,
`fx-desktop` and the rest. `?fx-reset=1` alone drops them. App code that reads a switch must read
`window.__FIXTURE_EARLY__.fx` (or `window.fixture.fx`), not `location.search`.

**Storage switches act once per navigation.** `fx-reset`, `fx-prefs` and the legacy keys run on a
fresh navigation only: not on a reload, back/forward, a URL without `fx-*` parameters, or a tab
opened from this one (it inherits sessionStorage). A later `page.goto` with them applies them
again. `fx-now` is applied on every load. Within a flow, `fixture.reset()` reseeds too.

**Legacy keys need an absent `ws.prefs`.** The prefs migration runs only while `ws.prefs` is absent
(§2.5), so `fx-view`, `fx-practice`, `fx-notation` and `fx-overview` cannot be combined with
`fx-prefs` (a console error, which fails the state). Use them with `fx-reset=1` on their own.

## `window.fixture`

`fx` · `db()` (deep copy) · `update(fn)` · `reset()` · `call(kind, name, args)` · `freezeJobs()` · `changed()` · `now()` ·
`platform` · `removed` · `advance(ms)` and `audio` (`fx-audio=manual`) · `wakeLock` · `midi` · `media` ·
`install` · `share` · `clipboard` · `companion`, `upload` and `desktop` (`fx-desktop=1`).
Each fake documents its controls at the top of its file.

## States and contract imports

A states module exports `[{name, url, fn, opts}]`; every option is listed at the top of
`lib/runner.cjs`. A package imports a same-wave peer module statically by its contract path
(architecture §9.0), so until that peer merges, a page that reaches it cannot load. Such a state
declares the files in `opts.requires` (repo-relative, forward slashes):

```js
{name: 'button-tooltip', url: '/__harness/button?tip=1', opts: {requires: ['src/ui/tooltip.js']}}
```

| Mode | A listed file is missing |
|---|---|
| default (package worktrees) | the state's runs are reported as `skip`, counted in `report.json`'s `skipped` (each result has `skipped: true` and `missing`), and do not fail the run |
| `--strict-requires` (integrations) | each of the state's runs fails with `requires: <path> is missing (--strict-requires)` |

When every file exists the state runs normally in both modes. `--list` names the missing files.

## Structural checks

`lib/structure.cjs` runs on every state (overflow, overlap, clip, placeholder; the rules are at
the top of the file). An open overlay (a `[popover]` that is `:popover-open`, a `dialog[open]`,
or a fallback layer root `[data-layer-fallback]`) covers part of the page by design: the overlap
check skips a pair where exactly one target is inside an open overlay, and still compares two
targets inside overlays (one menu's items with each other). States need no `ignore` for the page
behind an open menu, popover or sheet.

## Harnesses

`tests/harness/**/<name>.harness.js` (and the fixture's own `harness/<name>.harness.js`) export
`default async function mount(el, {fixture, query, h})`. The page at `/__harness/<name>` loads
`src/styles/main.css` and the icon sprite like the app, mounts the harness, and sets
`html[data-view-ready=<name>]`. `?theme=light|dark`, `?place=stage` and `?stage=dark|light` set the
root attributes. `/__harness/` lists them.
