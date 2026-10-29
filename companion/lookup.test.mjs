// B4 lookups (architecture §6.10 CPA): flat-entry mapping, playlist rejection,
// Spotify fallback, bot-check fallback, the LRU, the yt-dlp runner and the HTTP
// routes. The yt-dlp JSON in companion/fixtures/ytdlp/*.json is SYNTHESIZED from
// yt-dlp 2026.10.26's extractor source (each file's $comment says so), not recorded
// live: this container's proxy blocks YouTube, SoundCloud and Spotify. A live
// recording on a real machine replaces them at gate G6.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  BASE_ARGS, LOOKUP_ARGS, BOT_CHECK, LookupError, STATUS,
  classifyFailure, errorLine, ytDlpCommand, createYtDlp, searchArgs, resolveArgs,
  mapFlatEntry, mapSearchResult, mapResolvedInfo, pickThumbnail, providerOf,
  parseResolveInput, parseSearchInput, createLru, createLookup, createLookupRoutes, killAllLookupChildren,
} from './lookup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = name => JSON.parse(readFileSync(path.join(here, 'fixtures', 'ytdlp', `${name}.json`), 'utf8'));
const STDERR = fixture('stderr');
const target = args => args.at(-1);

const rejectsCode = async (promise, code) => {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof LookupError, `expected a LookupError, got ${error}`);
    assert.equal(error.code, code);
    assert.equal(error.status, STATUS[code]);
    return true;
  });
};

/** A scripted ytDlp: `answers` maps a target prefix to a fixture object or a LookupError. */
function scriptedYtDlp(answers) {
  const calls = [];
  const ytDlp = async (args, { signal } = {}) => {
    calls.push(args);
    signal?.throwIfAborted();
    const key = Object.keys(answers).find(k => target(args).startsWith(k));
    assert.ok(key, `unexpected yt-dlp target ${target(args)}`);
    const answer = answers[key];
    if (answer instanceof Error) throw answer;
    return structuredClone(answer);
  };
  return { ytDlp, calls };
}

describe('shared yt-dlp arguments', () => {
  test('lookup.mjs and pipeline.py read the same ytdlp-args.json', () => {
    const file = JSON.parse(readFileSync(path.join(here, 'ytdlp-args.json'), 'utf8'));
    assert.deepEqual([...BASE_ARGS], file.base);
    assert.deepEqual([...LOOKUP_ARGS], ['--skip-download', '--ignore-no-formats-error', '--no-warnings', '--dump-single-json'],
      'lookups need metadata only, so a missing playable format must not fail them');
    const source = readFileSync(path.join(here, 'pipeline.py'), 'utf8');
    assert.match(source, /ytdlp-args\.json/);
    const fallback = /^FALLBACK_YTDLP_ARGS = (\[.*\])$/m.exec(source);
    assert.ok(fallback, 'pipeline.py has a one-line FALLBACK_YTDLP_ARGS');
    assert.deepEqual(JSON.parse(fallback[1]), file.base, 'pipeline.py FALLBACK_YTDLP_ARGS must match ytdlp-args.json base');
  });

  test('pipeline.YTDLP_ARGS equals the shared base list', { skip: spawnSync('python3', ['--version']).status !== 0 && 'python3 not available' }, () => {
    const run = spawnSync('python3', ['-I', '-c', 'import sys, json; sys.path.insert(0, sys.argv[1]); import pipeline; print(json.dumps(pipeline.YTDLP_ARGS))', here], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), [...BASE_ARGS]);
  });

  test('a processor built without ytdlp-args.json falls back to the built-in list and warns', { skip: spawnSync('python3', ['--version']).status !== 0 && 'python3 not available' }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cpa-pipeline-'));
    try {
      copyFileSync(path.join(here, 'pipeline.py'), path.join(dir, 'pipeline.py'));
      const run = spawnSync('python3', ['-I', '-c', 'import sys, json; sys.path.insert(0, sys.argv[1]); import pipeline; print(json.dumps(pipeline.YTDLP_ARGS))', dir], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), [...BASE_ARGS]);
      assert.match(run.stderr, /ytdlp-args\.json is missing/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('frozen builds run the processor module, dev runs python -m', () => {
    assert.deepEqual(ytDlpCommand({ processor: '/App/woodshed-processor', python: '/venv/python' }), { command: '/App/woodshed-processor', prefix: ['--module', 'yt_dlp'] });
    assert.deepEqual(ytDlpCommand({ processor: undefined, python: '/venv/python' }), { command: '/venv/python', prefix: ['-m', 'yt_dlp'] });
  });

  test('search is one flat request; resolve extracts one page, collections flat; the target always follows --', () => {
    const yt = searchArgs('youtube', '-rf harbor lights', 5);
    assert.deepEqual(yt.slice(0, BASE_ARGS.length), [...BASE_ARGS]);
    assert.ok(yt.includes('--flat-playlist') && yt.includes('--dump-single-json') && yt.includes('--skip-download'));
    assert.deepEqual(yt.slice(-2), ['--', 'ytsearch5:-rf harbor lights']);
    assert.deepEqual(searchArgs('soundcloud', 'x', 3).slice(-1), ['scsearch3:x']);
    const one = resolveArgs('https://youtu.be/hL7aQ2mR9sE');
    assert.ok(one.includes('--flat-playlist'), 'a collection page must come back as a flat playlist (→ 422), not resolve every entry');
    assert.ok(one.includes('--no-playlist') && one.includes('--ignore-no-formats-error'));
    assert.deepEqual(one.slice(-2), ['--', 'https://youtu.be/hL7aQ2mR9sE']);
  });
});

// The processor packaging checks (I0B-10, I1b-3) run build-processor.py and
// desktop_entry.py --self-check without PyInstaller or the heavy runtime.
const repo = path.resolve(here, '..');
const noPython = spawnSync('python3', ['--version']).status !== 0 && 'python3 not available';

/** The PyInstaller argv build-processor.py would run, captured without running it. */
function pyinstallerArgs() {
  const capture = [
    'import json, runpy, subprocess, sys',
    'class Captured(Exception): pass',
    'def run(args, **kw):',
    '    print(json.dumps([str(a) for a in args])); raise Captured()',
    'subprocess.run = run',
    'try: runpy.run_path(sys.argv[1], run_name="__main__")',
    'except Captured: pass',
  ].join('\n');
  const run = spawnSync('python3', ['-I', '-c', capture, path.join(repo, 'scripts', 'build-processor.py')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}
const addData = args => args.flatMap((a, i) => a === '--add-data' ? [args[i + 1]] : []);

/** The real companion modules a stand-in bundle carries (beats.py is stubbed: BeatNet is heavy). */
const BUNDLED_COMPANION = ['pipeline.py', 'process.py', 'errors.py', 'fingerprint.py', 'sections.py'];
/** A stand-in bundle: desktop_entry.py and the companion modules with stub heavy runtime modules. */
function bundle({ withArgs, omit = [] }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cpa-selfcheck-'));
  for (const file of ['desktop_entry.py', ...BUNDLED_COMPANION, ...(withArgs ? ['ytdlp-args.json'] : [])].filter(f => !omit.includes(f))) copyFileSync(path.join(here, file), path.join(dir, file));
  for (const stub of ['torch', 'torchaudio', 'demucs', 'yt_dlp', 'soundfile', 'librosa', 'numpy']) writeFileSync(path.join(dir, `${stub}.py`), '');
  writeFileSync(path.join(dir, 'beats.py'), 'def detect(*a, **k): pass\n');
  return dir;
}
const selfCheck = (dir, meipass) => spawnSync('python3', ['-E', '-s', '-c',
  'import runpy, sys; sys.path.insert(0, sys.argv[1]); m = sys.argv[2]\n' +
  'if m: sys._MEIPASS = m\n' +
  'sys.argv = ["woodshed-processor", "--self-check"]; runpy.run_path(sys.path[0] + "/desktop_entry.py", run_name="__main__")',
  dir, meipass || ''], { encoding: 'utf8' });

// I0B-10: the packaged processor must ship ytdlp-args.json, fail its build-time
// self-check without it, and rebuild when it changes.
describe('processor packaging of ytdlp-args.json', () => {
  test('build-processor.py bundles companion/ytdlp-args.json at the bundle root', { skip: noPython }, () => {
    const pathsep = process.platform === 'win32' ? ';' : ':';
    const data = addData(pyinstallerArgs());
    assert.ok(data.includes(`${path.join(repo, 'companion', 'ytdlp-args.json')}${pathsep}.`),
      `--add-data must place ytdlp-args.json where pipeline.py looks (sys._MEIPASS); got ${JSON.stringify(data)}`);
    for (const entry of data) {
      const source = entry.slice(0, entry.lastIndexOf(pathsep));
      assert.ok(readFileSync(source), `bundled file ${source} exists`);
    }
  });

  test('release.yml processor cache keys hash every bundled data file', { skip: noPython }, () => {
    const workflow = readFileSync(path.join(repo, '.github', 'workflows', 'release.yml'), 'utf8');
    const keys = [...workflow.matchAll(/key: processor-[^\n]*hashFiles\(([^)]*)\)/g)].map(m => [...m[1].matchAll(/'([^']+)'/g)].map(g => g[1]));
    assert.equal(keys.length, 2, 'the CUDA and CPU processor caches');
    const glob = pattern => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*') + '$');
    const sources = addData(pyinstallerArgs()).map(entry => path.relative(repo, entry.slice(0, entry.lastIndexOf(process.platform === 'win32' ? ';' : ':'))).split(path.sep).join('/'));
    assert.ok(sources.includes('companion/ytdlp-args.json'));
    for (const files of keys) {
      for (const source of [...sources, 'scripts/build-processor.py', 'companion/pipeline.py', 'companion/desktop_entry.py']) {
        assert.ok(files.some(p => glob(p).test(source)), `processor cache key ${JSON.stringify(files)} must include ${source}`);
      }
    }
  });


  test('desktop_entry.py --self-check fails a build that is missing ytdlp-args.json', { skip: noPython }, () => {
    const dir = bundle({ withArgs: false });
    try {
      const run = selfCheck(dir);
      assert.notEqual(run.status, 0, 'a processor without ytdlp-args.json must not pass its self-check');
      assert.match(run.stderr, /self-check failed: ytdlp-args\.json is not bundled/);
      assert.doesNotMatch(run.stdout, /runtime ready/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('desktop_entry.py --self-check passes with ytdlp-args.json beside pipeline or in sys._MEIPASS, without the fallback warning', { skip: noPython }, () => {
    const beside = bundle({ withArgs: true });
    const code = bundle({ withArgs: false });
    const meipass = mkdtempSync(path.join(tmpdir(), 'cpa-meipass-'));
    try {
      copyFileSync(path.join(here, 'ytdlp-args.json'), path.join(meipass, 'ytdlp-args.json'));
      for (const run of [selfCheck(beside), selfCheck(code, meipass)]) {
        assert.equal(run.status, 0, run.stderr);
        assert.match(run.stdout, /Woodshed processing runtime ready/);
        assert.doesNotMatch(run.stderr, /missing/);
      }
    } finally { for (const d of [beside, code, meipass]) rmSync(d, { recursive: true, force: true }); }
  });
});

// I1b-3: the packaged processor must bundle every companion module a job imports
// (CPC's sections.py, CPB's errors.py), and its self-check must import them.
describe('processor packaging of companion modules', () => {
  /** Companion modules reachable from desktop_entry.py by any import, function-local ones included. */
  function reachableCompanionModules() {
    const walk = [
      'import ast, json, pathlib, sys',
      'root = pathlib.Path(sys.argv[1]); seen = set(); todo = ["desktop_entry"]',
      'while todo:',
      '    name = todo.pop()',
      '    for node in ast.walk(ast.parse((root / (name + ".py")).read_text(encoding="utf-8"))):',
      '        names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module] if isinstance(node, ast.ImportFrom) and node.module and not node.level else []',
      '        for mod in names:',
      '            top = mod.split(".")[0]',
      '            if (root / (top + ".py")).is_file() and top not in seen: seen.add(top); todo.append(top)',
      'print(json.dumps(sorted(seen - {"desktop_entry"})))',
    ].join('\n');
    const run = spawnSync('python3', ['-I', '-c', walk, here], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  }

  test('build-processor.py hidden-imports every companion module the frozen entry reaches', { skip: noPython }, () => {
    const args = pyinstallerArgs();
    const hidden = args.flatMap((a, i) => a === '--hidden-import' ? [args[i + 1]] : []);
    const reachable = reachableCompanionModules();
    for (const module of ['process', 'pipeline', 'errors', 'sections', 'beats', 'fingerprint', 'separator', 'gpu_runtime']) {
      assert.ok(reachable.includes(module), `${module} is reached from desktop_entry.py`);
    }
    const missing = reachable.filter(m => !hidden.includes(m));
    assert.deepEqual(missing, [], `--hidden-import must name every companion module a job imports; missing ${missing.join(', ')}`);
    assert.ok(args.includes('--collect-all') && args[args.indexOf('librosa') - 1] === '--collect-all', 'sections.py needs librosa collected');
  });

  test('desktop_entry.py --self-check passes with sections, errors and process bundled', { skip: noPython }, () => {
    const dir = bundle({ withArgs: true });
    try {
      const run = selfCheck(dir);
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /Woodshed processing runtime ready/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  for (const [file, module] of [['sections.py', 'sections'], ['errors.py', 'errors'], ['process.py', 'process']]) {
    test(`desktop_entry.py --self-check fails a build that is missing ${file}`, { skip: noPython }, () => {
      const dir = bundle({ withArgs: true, omit: [file] });
      try {
        const run = selfCheck(dir);
        assert.notEqual(run.status, 0, `a processor without ${file} must not pass its self-check`);
        assert.match(run.stderr, new RegExp(`No module named '${module}'`));
        assert.doesNotMatch(run.stdout, /runtime ready/);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});

describe('flat-entry mapping', () => {
  test('YouTube search entries become candidates', () => {
    const candidates = mapSearchResult(fixture('youtube-search'), 'youtube', 5);
    assert.deepEqual(candidates.map(c => c.id), ['hL7aQ2mR9sE', 'Zp3kW8vYt0c', 'Q9xR4bN2LmA', 'uP5tYc6Hn1o'],
      'null entries, upcoming streams and duplicates are dropped');
    assert.deepEqual(candidates[0], {
      url: 'https://www.youtube.com/watch?v=hL7aQ2mR9sE',
      id: 'hL7aQ2mR9sE',
      title: 'Ada Moreno - Harbor Lights (Official Audio)',
      channel: 'Ada Moreno',
      duration: 221,
      thumbnail: fixture('youtube-search').entries[0].thumbnails[0].url,
      provider: 'youtube',
      live: false,
    });
    assert.equal(candidates[2].url, 'https://www.youtube.com/watch?v=Q9xR4bN2LmA', 'a Shorts result still downloads as a watch URL');
    assert.equal(candidates[3].live, true);
    assert.equal(candidates[3].duration, null);
    assert.equal(candidates[3].thumbnail, 'https://i.ytimg.com/vi/uP5tYc6Hn1o/mqdefault.jpg', 'no thumbnail ≤ 480 px → the mqdefault still');
    assert.equal(mapSearchResult(fixture('youtube-search'), 'youtube', 2).length, 2, 'at most n');
  });

  test('entries without an id, a title or a video id are dropped', () => {
    assert.equal(mapFlatEntry({ title: 'No id' }, 'youtube'), null);
    assert.equal(mapFlatEntry({ id: 'hL7aQ2mR9sE' }, 'youtube'), null);
    assert.equal(mapFlatEntry({ id: 'UCx9c3f1hTn0bQyJmK3PqY2w', title: 'A channel' }, 'youtube'), null);
    assert.equal(mapFlatEntry({ id: 'PLr3b0Wp6Jq1', title: 'A playlist', ie_key: 'YoutubeTab' }, 'youtube'), null);
    assert.equal(mapFlatEntry(null, 'youtube'), null);
    assert.deepEqual(mapSearchResult({ entries: null }, 'youtube', 5), []);
    assert.deepEqual(mapSearchResult(undefined, 'youtube', 5), []);
  });

  test('SoundCloud entries use the permalink and the 90–720 s window only when the duration is known', () => {
    const candidates = mapSearchResult(fixture('soundcloud-search'), 'soundcloud', 5);
    assert.deepEqual(candidates.map(c => c.url), [
      'https://soundcloud.com/adamoreno/harbor-lights',
      'https://soundcloud.com/quietrooms/harbor-lights-cover',
      'https://soundcloud.com/tapehiss/harbor-lights-slowed',
    ]);
    assert.equal(candidates[0].duration, 221, 'durations are whole seconds');
    assert.equal(candidates[0].channel, 'Ada Moreno');
    assert.equal(candidates[0].thumbnail, 'https://i1.sndcdn.com/artworks-0p1789012345x-crop.jpg', 'largest artwork ≤ 480 px');
    assert.equal(candidates[1].duration, null);
    assert.equal(candidates[1].thumbnail, null, 'no artwork → null');
    assert.ok(candidates.every(c => c.provider === 'soundcloud' && c.live === false));
  });

  test('thumbnails are https only', () => {
    assert.equal(pickThumbnail({ thumbnails: [{ url: 'http://x.example/a.jpg', width: 300 }], thumbnail: 'data:image/png;base64,AA' }, 'other', 'x'), null);
    assert.equal(pickThumbnail({ thumbnail: 'https://x.example/b.jpg' }, 'other', 'x'), 'https://x.example/b.jpg');
    assert.equal(pickThumbnail({ thumbnails: [{ url: 'https://x.example/c.jpg' }] }, 'other', 'x'), 'https://x.example/c.jpg');
  });

  test('extractor keys map to providers', () => {
    assert.equal(providerOf('Youtube'), 'youtube');
    assert.equal(providerOf('YoutubeTab'), 'youtube');
    assert.equal(providerOf('Soundcloud'), 'soundcloud');
    assert.equal(providerOf('BandcampTrack'), 'other');
    assert.equal(providerOf(undefined), 'other');
  });
});

describe('resolved pages', () => {
  test('a YouTube video: track and artist, canonical URL, ≤ 480 px thumbnail', () => {
    assert.deepEqual(mapResolvedInfo(fixture('youtube-video'), 'https://youtu.be/hL7aQ2mR9sE?si=Xc81'), {
      url: 'https://www.youtube.com/watch?v=hL7aQ2mR9sE',
      id: 'hL7aQ2mR9sE',
      title: 'Harbor Lights',
      channel: 'Ada Moreno',
      duration: 221,
      thumbnail: 'https://i.ytimg.com/vi/hL7aQ2mR9sE/hqdefault.jpg',
      provider: 'youtube',
      live: false,
    });
  });

  test('a SoundCloud track and a page from another site', () => {
    const sc = mapResolvedInfo(fixture('soundcloud-track'), 'https://soundcloud.com/adamoreno/harbor-lights');
    assert.equal(sc.provider, 'soundcloud');
    assert.equal(sc.url, 'https://soundcloud.com/adamoreno/harbor-lights');
    assert.equal(sc.channel, 'Ada Moreno');
    const bc = mapResolvedInfo(fixture('bandcamp-track'), 'https://adamoreno.bandcamp.com/track/harbor-lights');
    assert.deepEqual({ provider: bc.provider, title: bc.title, channel: bc.channel, duration: bc.duration, thumbnail: bc.thumbnail },
      { provider: 'other', title: 'Harbor Lights', channel: 'Ada Moreno', duration: 222, thumbnail: 'https://f4.bcbits.com/img/a2318841220_7.jpg' });
  });

  test('a playlist is rejected with 422 playlist', () => {
    assert.throws(() => mapResolvedInfo(fixture('youtube-playlist'), 'https://www.youtube.com/watch?v=x&list=PL'), e => e.code === 'playlist' && e.status === 422);
    assert.throws(() => mapResolvedInfo({ _type: 'multi_video', id: 'x' }, 'https://x.example'), e => e.code === 'playlist');
    assert.throws(() => mapResolvedInfo({ id: 'rT2nV8cX4kB', live_status: 'is_upcoming' }, 'https://x.example'), e => e.code === 'unavailable');
    assert.throws(() => mapResolvedInfo({ title: 'no id' }, 'https://x.example'), e => e.code === 'not_found');
  });
});

describe('failures', () => {
  test('stderr is classified', () => {
    const expected = {
      bot_check: 'bot_check', bot_check_search: 'bot_check', age_gate: 'unavailable', private: 'unavailable', removed: 'unavailable',
      region: 'unavailable', premiere: 'unavailable', unsupported: 'not_found', sc_404: 'not_found', network: 'lookup_unavailable', missing_module: 'lookup_unavailable',
    };
    for (const [name, code] of Object.entries(expected)) assert.equal(classifyFailure(STDERR[name]), code, name);
    assert.ok(BOT_CHECK.test('Sign in to confirm you’re not a bot'));
    assert.ok(!BOT_CHECK.test('Sign in to confirm your age'));
    assert.equal(classifyFailure('ERROR: [youtube] hL7aQ2mR9sE: Requested format is not available. Use --list-formats for a list of available formats'), 'lookup_unavailable',
      'a format-selection failure is not "this video isn’t available"');
  });

  test('the message is the last ERROR line without its prefixes', () => {
    assert.equal(errorLine(STDERR.removed), 'Video unavailable. This video has been removed by the uploader');
    assert.equal(errorLine(STDERR.unsupported), 'Unsupported URL: https://example.com/blog/harbor-lights');
    assert.equal(errorLine(''), '');
  });
});

describe('input validation', () => {
  test('/resolve accepts one http(s) or spotify link of ≤ 2000 characters', () => {
    for (const bad of ['', '   ', 'harbor lights', 'ftp://x.example/a.mp3', 'javascript:alert(1)', 'file:///etc/passwd', `https://x.example/${'a'.repeat(2000)}`, 42, null])
      assert.throws(() => parseResolveInput(bad), e => e.code === 'invalid' && e.status === 400, String(bad).slice(0, 40));
    assert.deepEqual(parseResolveInput(' https://youtu.be/hL7aQ2mR9sE '), { kind: 'url', url: 'https://youtu.be/hL7aQ2mR9sE' });
    assert.deepEqual(parseResolveInput('https://www.youtube.com/watch?v=hL7aQ2mR9sE&list=RDhL7'), { kind: 'url', url: 'https://www.youtube.com/watch?v=hL7aQ2mR9sE&list=RDhL7' },
      'a watch link inside a playlist resolves to its video (--no-playlist)');
  });

  test('known playlist shapes are rejected without a lookup', () => {
    for (const url of ['https://www.youtube.com/playlist?list=PLr3b0Wp6Jq1', 'https://music.youtube.com/playlist?list=OLAK5uy', 'https://soundcloud.com/adamoreno/sets/salt-signal',
      'https://open.spotify.com/album/1A2b3C', 'https://open.spotify.com/playlist/37i9dQZF1DX', 'spotify:playlist:37i9dQZF1DX',
      'https://www.youtube.com/watch?list=PLr3b0Wp6Jq1', 'https://music.youtube.com/watch?list=OLAK5uy&index=2'])
      assert.throws(() => parseResolveInput(url), e => e.code === 'playlist' && e.status === 422, url);
  });

  test('Spotify track links in every form', () => {
    for (const url of ['https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc', 'https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC', 'spotify:track:4uLU6hMCjMI75M1A2tKUQC'])
      assert.deepEqual(parseResolveInput(url).kind, 'spotify', url);
    assert.equal(parseResolveInput('spotify:track:4uLU6hMCjMI75M1A2tKUQC').url, 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
    assert.throws(() => parseResolveInput('https://open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF'), e => e.code === 'invalid');
  });

  test('/search takes 1–200 characters and n in 1–5 (default 5)', () => {
    assert.deepEqual(parseSearchInput('  harbor   lights ', undefined), { query: 'harbor lights', n: 5 });
    assert.deepEqual(parseSearchInput('harbor', '3'), { query: 'harbor', n: 3 });
    for (const [q, n] of [['', 5], ['   ', 5], ['x'.repeat(201), 5], ['ok', 0], ['ok', 6], ['ok', '2.5'], ['ok', 'five']])
      assert.throws(() => parseSearchInput(q, n), e => e.code === 'invalid' && e.status === 400, `${q.slice(0, 5)} ${n}`);
  });
});

describe('the LRU', () => {
  test('keeps 50 entries, evicting the least recently used', () => {
    const cache = createLru();
    for (let i = 0; i < 50; i++) cache.set(`k${i}`, { i });
    assert.deepEqual(cache.get('k0'), { i: 0 }, 'a hit refreshes k0');
    cache.set('k50', { i: 50 });
    assert.equal(cache.size, 50);
    assert.equal(cache.get('k1'), undefined, 'k1 was the least recently used');
    assert.deepEqual(cache.get('k0'), { i: 0 });
    assert.deepEqual(cache.get('k50'), { i: 50 });
  });

  test('entries expire after 10 minutes', () => {
    let t = 1_000;
    const cache = createLru({ now: () => t });
    cache.set('a', 1);
    t += 10 * 60_000 - 1;
    assert.equal(cache.get('a'), 1);
    t += 1;
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.size, 0);
  });

  test('cached values cannot be mutated through a caller', () => {
    const cache = createLru();
    const value = { candidates: [{ id: 'a' }] };
    cache.set('k', value);
    value.candidates.push({ id: 'b' });
    cache.get('k').candidates.push({ id: 'c' });
    assert.deepEqual(cache.get('k'), { candidates: [{ id: 'a' }] });
  });
});

describe('lookups', () => {
  test('search uses YouTube and caches by n and lower-cased query', async () => {
    const { ytDlp, calls } = scriptedYtDlp({ ytsearch: fixture('youtube-search') });
    const lookup = createLookup({ ytDlp });
    const first = await lookup.search('Harbor Lights Ada Moreno', 5);
    assert.equal(first.query, 'Harbor Lights Ada Moreno');
    assert.equal(first.provider, 'youtube');
    assert.equal(first.candidates.length, 4);
    assert.deepEqual(target(calls[0]), 'ytsearch5:Harbor Lights Ada Moreno');
    assert.deepEqual(await lookup.search('harbor lights ada moreno', 5), { ...first, query: 'Harbor Lights Ada Moreno' });
    assert.equal(calls.length, 1, 'the second search was a cache hit');
    assert.deepEqual(lookup.cache.keys(), ['search:5:harbor lights ada moreno']);
    await lookup.search('harbor lights ada moreno', 2);
    assert.equal(calls.length, 2, 'a different n is a different entry');
  });

  test('a YouTube bot check falls back to SoundCloud', async () => {
    const { ytDlp, calls } = scriptedYtDlp({ ytsearch: new LookupError('bot_check', 'blocked'), scsearch: fixture('soundcloud-search') });
    const result = await createLookup({ ytDlp }).search('harbor lights', 5);
    assert.equal(result.provider, 'soundcloud');
    assert.deepEqual(calls.map(target), ['ytsearch5:harbor lights', 'scsearch5:harbor lights']);
    assert.equal(result.candidates[0].url, 'https://soundcloud.com/adamoreno/harbor-lights');
  });

  test('both providers failing is a 503 bot_check; other YouTube failures do not fall back', async () => {
    const both = scriptedYtDlp({ ytsearch: new LookupError('bot_check', 'blocked', { detail: STDERR.bot_check_search }), scsearch: new LookupError('lookup_unavailable', 'down') });
    await rejectsCode(createLookup({ ytDlp: both.ytDlp }).search('harbor lights', 5), 'bot_check');
    const network = scriptedYtDlp({ ytsearch: new LookupError('lookup_unavailable', 'offline') });
    await rejectsCode(createLookup({ ytDlp: network.ytDlp }).search('harbor lights', 5), 'lookup_unavailable');
    assert.equal(network.calls.length, 1);
  });

  test('failures are not cached', async () => {
    let fail = true;
    const lookup = createLookup({ ytDlp: async () => { if (fail) throw new LookupError('lookup_unavailable', 'offline'); return fixture('youtube-search'); } });
    await rejectsCode(lookup.search('harbor', 5), 'lookup_unavailable');
    fail = false;
    assert.equal((await lookup.search('harbor', 5)).candidates.length, 4);
  });

  test('resolve: one candidate for a link; 422 for a playlist page', async () => {
    const { ytDlp, calls } = scriptedYtDlp({ 'https://youtu.be/': fixture('youtube-video'), 'https://www.youtube.com/watch?v=Zp3kW8vYt0c': fixture('youtube-playlist') });
    const lookup = createLookup({ ytDlp });
    const result = await lookup.resolve('https://youtu.be/hL7aQ2mR9sE?si=Xc81');
    assert.equal(result.kind, 'url');
    assert.equal(result.query, undefined);
    assert.deepEqual(result.candidates.map(c => c.url), ['https://www.youtube.com/watch?v=hL7aQ2mR9sE']);
    assert.deepEqual(calls[0].slice(-2), ['--', 'https://youtu.be/hL7aQ2mR9sE?si=Xc81']);
    await lookup.resolve('https://youtu.be/hL7aQ2mR9sE?si=Xc81');
    assert.equal(calls.length, 1, 'cached by URL');
    await rejectsCode(lookup.resolve('https://www.youtube.com/watch?v=Zp3kW8vYt0c&list=PLr3b0Wp6Jq1'), 'playlist');
    await rejectsCode(lookup.resolve('https://www.youtube.com/playlist?list=PLr3b0Wp6Jq1'), 'playlist');
    assert.equal(calls.length, 2, 'a /playlist link never ran yt-dlp');
  });

  test('resolve passes yt-dlp failures through with their code', async () => {
    const lookup = createLookup({ ytDlp: async () => { throw new LookupError('unavailable', 'Private video.'); } });
    await rejectsCode(lookup.resolve('https://www.youtube.com/watch?v=Q9xR4bN2LmA'), 'unavailable');
  });

  test('Spotify: the oEmbed title (plus author) becomes a search, with the bot-check fallback', async () => {
    const fetches = [];
    const fetch = async (url, init) => { fetches.push({ url, init }); return { ok: true, json: async () => ({ ...fixture('spotify-oembed'), author_name: 'Ada Moreno' }) }; };
    const { ytDlp, calls } = scriptedYtDlp({ ytsearch: new LookupError('bot_check', 'blocked'), scsearch: fixture('soundcloud-search') });
    const result = await createLookup({ ytDlp, fetch }).resolve('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc');
    assert.equal(fetches[0].url, `https://open.spotify.com/oembed?url=${encodeURIComponent('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC')}`);
    assert.ok(fetches[0].init.signal instanceof AbortSignal);
    assert.equal(result.kind, 'spotify');
    assert.equal(result.query, 'Harbor Lights Ada Moreno');
    assert.deepEqual(calls.map(target), ['ytsearch5:Harbor Lights Ada Moreno', 'scsearch5:Harbor Lights Ada Moreno']);
    assert.equal(result.candidates.length, 3);
    assert.deepEqual(Object.keys(result).sort(), ['candidates', 'kind', 'query']);
  });

  test('Spotify: a title alone is the query', async () => {
    const fetch = async () => ({ ok: true, json: async () => fixture('spotify-oembed') });
    const { ytDlp, calls } = scriptedYtDlp({ ytsearch: fixture('youtube-search') });
    const result = await createLookup({ ytDlp, fetch }).resolve('spotify:track:4uLU6hMCjMI75M1A2tKUQC');
    assert.equal(result.query, 'Harbor Lights');
    assert.equal(target(calls[0]), 'ytsearch5:Harbor Lights');
  });

  test('Spotify: a bad link is 404 not_found; a Spotify playlist never fetches', async () => {
    const { ytDlp, calls } = scriptedYtDlp({});
    for (const fetch of [async () => ({ ok: false, status: 404, json: async () => ({}) }), async () => ({ ok: false, status: 400, json: async () => ({}) }), async () => ({ ok: true, status: 200, json: async () => ({ type: 'rich' }) })]) {
      await assert.rejects(createLookup({ ytDlp, fetch }).resolve('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'),
        e => e.code === 'not_found' && e.status === 404 && e.message === 'Could not resolve this Spotify link.');
    }
    let fetched = false;
    await rejectsCode(createLookup({ ytDlp, fetch: async () => { fetched = true; } }).resolve('https://open.spotify.com/playlist/37i9dQZF1DX'), 'playlist');
    assert.equal(fetched, false);
    assert.equal(calls.length, 0);
  });

  test('Spotify: no connection, a 5xx, a 429 or unreadable data is 502 lookup_unavailable, not a bad link', async () => {
    const { ytDlp, calls } = scriptedYtDlp({});
    const answers = [
      async () => { throw new TypeError('fetch failed'); },
      async () => ({ ok: false, status: 503, json: async () => ({}) }),
      async () => ({ ok: false, status: 429, json: async () => ({}) }),
      async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }),
    ];
    for (const fetch of answers) {
      await assert.rejects(createLookup({ ytDlp, fetch }).resolve('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'),
        e => e.code === 'lookup_unavailable' && e.status === 502 && typeof e.detail === 'string' && e.detail.length > 0);
    }
    assert.equal(calls.length, 0);
  });

  test('one 20 s deadline covers every child of a lookup', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let aborted = 0;
    const ytDlp = (args, { signal }) => new Promise((resolve, reject) => {
      if (target(args).startsWith('ytsearch')) {
        // YouTube takes 15 s, then bot-checks; SoundCloud then hangs.
        setTimeout(() => reject(new LookupError('bot_check', 'blocked')), 15_000);
        return;
      }
      signal.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true });
    });
    const pending = createLookup({ ytDlp }).search('harbor', 5);
    t.mock.timers.tick(15_000);
    await new Promise(setImmediate);
    t.mock.timers.tick(4_999);
    await new Promise(setImmediate);
    assert.equal(aborted, 0);
    t.mock.timers.tick(1);
    await rejectsCode(pending, 'timeout');
    assert.equal(aborted, 1, 'the SoundCloud child was aborted at 20 s');
  });

  test('a lookup that ignores its signal still answers at the deadline', async () => {
    const lookup = createLookup({ ytDlp: () => new Promise(() => {}), timeoutMs: 20 });
    await rejectsCode(lookup.search('harbor', 5), 'timeout');
  });

  test('aborting the caller signal aborts with its reason', async () => {
    const controller = new AbortController();
    const lookup = createLookup({ ytDlp: (args, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
    const pending = lookup.search('harbor', 5, { signal: controller.signal });
    controller.abort(new LookupError('lookup_busy', 'replaced'));
    await rejectsCode(pending, 'lookup_busy');
  });
});

describe('the yt-dlp runner (real child processes)', () => {
  // `node -e SCRIPT` stands in for `python -m yt_dlp`; FAKE_MODE picks its behaviour.
  const SCRIPT = `
    const mode = process.env.FAKE_MODE, args = process.argv.slice(1);
    if (mode === 'ok') process.stdout.write(JSON.stringify({ _type: 'playlist', args }));
    else if (mode === 'bot') { process.stderr.write(${JSON.stringify(STDERR.bot_check)}); process.stdout.write('{"entries":[null]}'); process.exit(1); }
    else if (mode === 'garbage') process.stdout.write('not json');
    else if (mode === 'hang') { process.stdout.write(''); setInterval(() => {}, 1000); }
  `;
  const runner = (mode, extra = {}) => {
    const children = [];
    const ytDlp = createYtDlp({
      command: process.execPath, prefix: ['-e', SCRIPT, '--'], env: { ...process.env, FAKE_MODE: mode },
      spawn: (...args) => { const child = nodeSpawn(...args); children.push(child); return child; }, ...extra,
    });
    return { ytDlp, children };
  };
  const exited = child => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve)));

  test('resolves the JSON stdout of a successful run, with the prefix and args', async () => {
    const { ytDlp } = runner('ok');
    const result = await ytDlp(searchArgs('youtube', 'harbor', 5));
    assert.deepEqual(result.args, searchArgs('youtube', 'harbor', 5));
  });

  test('a non-zero exit is classified from stderr even when stdout has JSON', async () => {
    const { ytDlp } = runner('bot');
    await assert.rejects(ytDlp(['x']), e => e.code === 'bot_check' && e.status === 503 && /not a bot/.test(e.message) && /not a bot/.test(e.detail));
  });

  test('unreadable output and a missing executable are lookup_unavailable', async () => {
    await rejectsCode(runner('garbage').ytDlp(['x']), 'lookup_unavailable');
    await assert.rejects(createYtDlp({ command: path.join(here, 'no-such-processor') })(['x']),
      e => e.code === 'lookup_unavailable' && e.message === 'The processor is not installed on this computer.');
  });

  test('aborting kills the child and rejects with the abort reason', async () => {
    const { ytDlp, children } = runner('hang');
    const controller = new AbortController();
    const pending = ytDlp(['x'], { signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 150));
    controller.abort(new LookupError('lookup_busy', 'replaced'));
    await rejectsCode(pending, 'lookup_busy');
    await exited(children[0]);
    assert.ok(children[0].signalCode === 'SIGTERM' || children[0].exitCode !== null, 'the child is gone');
  });

  test('an already-aborted signal never spawns', async () => {
    const { ytDlp, children } = runner('ok');
    await rejectsCode(ytDlp(['x'], { signal: AbortSignal.abort() }), 'aborted');
    assert.equal(children.length, 0);
  });

  test('children still running when the companion exits are killed', { skip: process.platform === 'win32' && 'POSIX process groups' }, async () => {
    const lookupUrl = new URL('./lookup.mjs', import.meta.url).href;
    const parent = `
      import { createYtDlp } from ${JSON.stringify(lookupUrl)};
      const ytDlp = createYtDlp({ command: process.execPath, prefix: ['-e', 'setInterval(() => {}, 1000)', '--'],
        spawn: (cmd, args, opts) => { const child = (globalThis.spawnImpl)(cmd, args, opts); process.stdout.write(child.pid + '\\n'); return child; } });
      ytDlp(['x']).catch(() => {});
      setTimeout(() => process.exit(0), 200);
    `;
    const prelude = `import { spawn } from 'node:child_process'; globalThis.spawnImpl = spawn;`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', prelude + parent], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(run.status, 0, run.stderr);
    const pid = Number(run.stdout.trim());
    assert.ok(pid > 0, run.stdout);
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 100 && alive(); i++) await new Promise(resolve => setTimeout(resolve, 20));
    if (alive()) process.kill(-pid, 'SIGKILL');
    assert.equal(alive(), false, 'the orphaned yt-dlp child must die with the companion');
  });

  test('killAllLookupChildren kills every running child', async () => {
    const { ytDlp, children } = runner('hang');
    const pending = [ytDlp(['a']), ytDlp(['b'])].map(p => p.catch(error => error));
    await new Promise(resolve => setTimeout(resolve, 100));
    killAllLookupChildren();
    await Promise.all(children.map(exited));
    assert.deepEqual(children.map(c => c.signalCode), ['SIGTERM', 'SIGTERM']);
    for (const result of await Promise.all(pending)) assert.ok(result instanceof LookupError);
  });

  test('the deadline kills a hung child (504 timeout)', async () => {
    const { ytDlp, children } = runner('hang');
    await rejectsCode(createLookup({ ytDlp, timeoutMs: 300 }).search('harbor', 5), 'timeout');
    await exited(children[0]);
    assert.equal(children[0].signalCode, 'SIGTERM');
  });
});

describe('HTTP routes', () => {
  async function serve(lookup) {
    const handle = createLookupRoutes(lookup, { log: () => {} });
    const server = http.createServer(async (req, res) => {
      if (!(await handle(req, res))) { res.writeHead(404); res.end('{}'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (pathname, init) => {
      const response = await fetch(base + pathname, init);
      return { status: response.status, body: await response.json(), headers: response.headers };
    };
    return { get, base, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
  }

  test('GET /search and /resolve answer JSON; errors carry {error, code}', async () => {
    const { ytDlp } = scriptedYtDlp({ ytsearch: fixture('youtube-search'), 'https://youtu.be/': fixture('youtube-video') });
    const app = await serve(createLookup({ ytDlp }));
    try {
      const search = await app.get(`/search?q=${encodeURIComponent('harbor lights')}&n=3`);
      assert.equal(search.status, 200);
      assert.equal(search.headers.get('cache-control'), 'no-store');
      assert.deepEqual({ query: search.body.query, provider: search.body.provider, n: search.body.candidates.length }, { query: 'harbor lights', provider: 'youtube', n: 3 });
      const resolve = await app.get(`/resolve?url=${encodeURIComponent('https://youtu.be/hL7aQ2mR9sE')}`);
      assert.equal(resolve.status, 200);
      assert.equal(resolve.body.kind, 'url');
      assert.equal(resolve.body.candidates[0].title, 'Harbor Lights');
      const defaultN = await app.get('/search?q=harbor');
      assert.equal(defaultN.status, 200);
      assert.equal(defaultN.body.candidates.length, 4);
      const empty = await app.get('/search?q=');
      assert.deepEqual([empty.status, empty.body], [400, { error: 'Type 1–200 characters.', code: 'invalid' }]);
      const playlist = await app.get(`/resolve?url=${encodeURIComponent('https://www.youtube.com/playlist?list=PL1')}`);
      assert.deepEqual([playlist.status, playlist.body.code, playlist.body.error], [422, 'playlist', 'This is a playlist link. Paste a link to one song.']);
      const post = await app.get('/search?q=x', { method: 'POST' });
      assert.deepEqual([post.status, post.body.code], [405, 'invalid']);
      assert.equal((await app.get('/status')).status, 404, 'other routes are not handled');
    } finally { await app.close(); }
  });

  test('coded yt-dlp failures map to their statuses', async () => {
    const answers = { bot: 'bot_check', gone: 'unavailable', nothing: 'not_found', slow: 'timeout', broken: 'lookup_unavailable' };
    const lookup = createLookup({
      ytDlp: async args => {
        const word = target(args).split(':')[1];
        if (word === 'crash') throw new Error('unexpected');
        throw new LookupError(answers[word], word);
      },
    });
    const app = await serve(lookup);
    try {
      for (const [word, code] of Object.entries(answers)) {
        const { status, body } = await app.get(`/search?q=${word}`);
        if (code === 'bot_check') { assert.deepEqual([status, body.code], [503, 'bot_check']); continue; }
        assert.deepEqual([status, body.code], [STATUS[code], code], word);
      }
      const crash = await app.get('/search?q=crash');
      assert.deepEqual([crash.status, crash.body.code], [502, 'lookup_unavailable']);
    } finally { await app.close(); }
  });

  test('a new request aborts the previous lookup on the same route (409 lookup_busy)', async () => {
    const signals = [];
    const lookup = createLookup({
      ytDlp: (args, { signal }) => new Promise((resolve, reject) => {
        signals.push(signal);
        if (target(args).endsWith('second')) { resolve(fixture('youtube-search')); return; }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    });
    const app = await serve(lookup);
    try {
      const first = app.get('/search?q=first');
      while (signals.length < 1) await new Promise(resolve => setTimeout(resolve, 5));
      const second = await app.get('/search?q=second');
      assert.equal(second.status, 200);
      const replaced = await first;
      assert.deepEqual([replaced.status, replaced.body.code], [409, 'lookup_busy']);
      assert.equal(signals[0].aborted, true);
    } finally { await app.close(); }
  });

  test('routes are independent: a search does not abort a resolve', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const lookup = createLookup({
      ytDlp: async args => {
        if (target(args).startsWith('https://')) { await gate; return fixture('youtube-video'); }
        return fixture('youtube-search');
      },
    });
    const app = await serve(lookup);
    try {
      const resolving = app.get(`/resolve?url=${encodeURIComponent('https://youtu.be/hL7aQ2mR9sE')}`);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal((await app.get('/search?q=harbor')).status, 200);
      release();
      assert.equal((await resolving).status, 200);
    } finally { await app.close(); }
  });

  test('abortAll aborts every in-flight lookup (server shutdown calls it)', async () => {
    const signals = [];
    const lookup = createLookup({ ytDlp: (args, options) => new Promise((_, reject) => { signals.push(options.signal); options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); }) });
    const handle = createLookupRoutes(lookup, { log: () => {} });
    const server = http.createServer(async (req, res) => { await handle(req, res); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const answers = [fetch(`${base}/search?q=harbor`), fetch(`${base}/resolve?url=${encodeURIComponent('https://youtu.be/hL7aQ2mR9sE')}`)];
      while (signals.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
      handle.abortAll();
      assert.ok(signals.every(s => s.aborted && s.reason.code === 'aborted'));
      for (const answer of await Promise.all(answers)) assert.equal(answer.status, 499);
    } finally { await new Promise(resolve => server.close(resolve)); }
    assert.match(readFileSync(path.join(here, 'server.mjs'), 'utf8'), /async function shutdown\([^)]*\)\{[^\n]*\n\s*lookupRoutes\.abortAll\(\);/,
      'server.mjs shutdown() aborts lookups first');
  });

  test('closing the request aborts its lookup', async () => {
    let signal;
    const lookup = createLookup({ ytDlp: (args, options) => new Promise((_, reject) => { signal = options.signal; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
    const app = await serve(lookup);
    try {
      const controller = new AbortController();
      const request = fetch(`${app.base}/search?q=harbor`, { signal: controller.signal }).catch(error => error);
      while (!signal) await new Promise(resolve => setTimeout(resolve, 5));
      controller.abort();
      await request;
      for (let i = 0; i < 100 && !signal.aborted; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(signal.aborted, true);
      assert.equal(signal.reason.code, 'aborted');
    } finally { await app.close(); }
  });
});
