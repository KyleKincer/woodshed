const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { MIME, CSP, createStaticHandler, createUiServer, listen } = require('./static-server.cjs');

let tmp, webRoot, server, port;
const ORIGIN_HOST = () => `127.0.0.1:${port}`;

function request(pathname, { host = ORIGIN_HOST(), method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { host } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const oauth = [];
const media = [];
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-static-'));
  webRoot = path.join(tmp, 'dist');
  fs.mkdirSync(path.join(webRoot, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(webRoot, 'licenses'), { recursive: true });
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>index</title>');
  fs.writeFileSync(path.join(webRoot, 'assets', 'app-1234.js'), 'export {}');
  fs.writeFileSync(path.join(webRoot, 'assets', 'engine.wasm'), Buffer.from([0, 97, 115, 109]));
  fs.writeFileSync(path.join(webRoot, 'manifest.webmanifest'), '{"name":"Woodshed"}');
  fs.writeFileSync(path.join(webRoot, 'licenses', 'lucide.txt'), 'ISC');
  fs.writeFileSync(path.join(webRoot, 'favicon.ico'), Buffer.from([0, 0, 1, 0]));
  fs.writeFileSync(path.join(webRoot, 'woodshed-icon.png'), Buffer.from([137, 80, 78, 71]));
  fs.writeFileSync(path.join(webRoot, 'odd.bin'), 'x');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'top secret');
  fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(webRoot, 'link.txt'));
  server = createUiServer({
    origin: 'http://127.0.0.1:1',
    handleStatic: createStaticHandler({ webRoot }),
    mediaProxy: { serve: (req, res) => { media.push(req.url); res.writeHead(204); res.end(); } },
    onOAuthCallback: search => oauth.push(search),
  });
  // The host check uses the origin's host; rebuild with the real port once known.
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  server.close();
  server = createUiServer({
    origin: `http://127.0.0.1:${port}`,
    handleStatic: createStaticHandler({ webRoot }),
    mediaProxy: { serve: (req, res) => { media.push(req.url); res.writeHead(204); res.end(); } },
    onOAuthCallback: search => oauth.push(search),
  });
  await listen(server, `http://127.0.0.1:${port}`);
});
after(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('serves any existing file under dist with its MIME type (D9)', async () => {
  const cases = [
    ['/assets/app-1234.js', 'text/javascript; charset=utf-8', 'export {}'],
    ['/manifest.webmanifest', 'application/manifest+json', '{"name":"Woodshed"}'],
    ['/licenses/lucide.txt', 'text/plain; charset=utf-8', 'ISC'],
  ];
  for (const [pathname, type, body] of cases) {
    const res = await request(pathname);
    assert.equal(res.status, 200, pathname);
    assert.equal(res.headers['content-type'], type, pathname);
    assert.equal(res.body, body, pathname);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['content-security-policy'], CSP);
  }
  assert.equal((await request('/assets/engine.wasm')).headers['content-type'], 'application/wasm');
  assert.equal((await request('/favicon.ico')).headers['content-type'], 'image/x-icon');
  assert.equal((await request('/woodshed-icon.png')).headers['content-type'], 'image/png');
  assert.equal((await request('/odd.bin')).headers['content-type'], 'application/octet-stream');
});

test('the MIME map has the new types', () => {
  assert.equal(MIME['.webmanifest'], 'application/manifest+json');
  assert.equal(MIME['.txt'], 'text/plain; charset=utf-8');
  assert.equal(MIME['.wasm'], 'application/wasm');
  assert.equal(MIME['.png'], 'image/png');
  assert.equal(MIME['.ico'], 'image/x-icon');
});

test('anything that is not a file inside dist gets index.html', async () => {
  for (const pathname of ['/', '/s/abc123', '/edit/xyz/map', '/assets/missing.js', '/licenses', '/%E0%A4%A']) {
    const res = await request(pathname);
    assert.equal(res.status, 200, pathname);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8', pathname);
    assert.match(res.body, /<title>index<\/title>/, pathname);
  }
});

test('traversal out of dist is blocked', async () => {
  for (const pathname of ['/..%2fsecret.txt', '/assets/..%2f..%2fsecret.txt', '/%2e%2e%2fsecret.txt', '/..%5csecret.txt', '/a%00b']) {
    const res = await request(pathname);
    assert.notEqual(res.body, 'top secret', pathname);
    if (path.sep === '/' && pathname.includes('%5c')) continue; // a literal backslash is a file name on POSIX
    assert.equal(res.status, 403, pathname);
  }
  const handler = createStaticHandler({ webRoot });
  assert.equal(handler.resolve('/../secret.txt').status, 403);
  assert.equal(handler.resolve('/assets/../../secret.txt').status, 403);
  assert.equal(handler.resolve('/assets/app-1234.js').file, path.join(webRoot, 'assets', 'app-1234.js'));
});

test('a symlink pointing outside dist is not followed', async () => {
  const res = await request('/link.txt');
  assert.notEqual(res.body, 'top secret');
  assert.match(res.body, /<title>index<\/title>/);
});

test('HEAD sends headers only; other methods are refused', async () => {
  const head = await request('/assets/app-1234.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], '9');
  const post = await request('/assets/app-1234.js', { method: 'POST' });
  assert.equal(post.status, 405);
});

test('requests for another host are refused', async () => {
  const res = await request('/', { host: 'evil.example:80' });
  assert.equal(res.status, 403);
});

test('/media/ goes to the media proxy and /oauth/callback reloads the window', async () => {
  const mediaRes = await request('/media/abc');
  assert.equal(mediaRes.status, 204);
  assert.deepEqual(media, ['/media/abc']);
  const res = await request('/oauth/callback?code=1&state=2');
  assert.equal(res.status, 200);
  assert.match(res.body, /Return to Woodshed/);
  assert.equal(res.headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline'");
  assert.deepEqual(oauth, ['code=1&state=2']);
});
