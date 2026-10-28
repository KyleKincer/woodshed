'use strict';
// The desktop app's UI server (architecture §6.11 item 1, D9).
//
// createStaticHandler serves any existing file under webRoot and falls back to
// index.html for every other in-root path, so client routes (/s/:id, /edit/…)
// load the app. Paths that resolve outside webRoot are refused (403).
// createUiServer adds the host check, the /media/ proxy and the OAuth callback.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
});

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "connect-src 'self' http://127.0.0.1:* https://*.convex.cloud wss://*.convex.cloud https://*.convex.site https://*.r2.cloudflarestorage.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

const BASE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': CSP,
});

function inside(root, file) {
  return file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * @param {{webRoot: string, mime?: Record<string,string>, fs?: typeof import('node:fs'), headers?: Record<string,string>}} options
 * @returns {((req, res) => Promise<void>) & {resolve(pathname: string): {status: number, file?: string}}}
 */
function createStaticHandler({ webRoot, mime = MIME, fs: fsImpl = fs, headers = BASE_HEADERS }) {
  const root = path.resolve(webRoot);
  const index = path.join(root, 'index.html');
  let realRoot = null;
  const realRootOf = () => {
    if (realRoot) return realRoot;
    try { realRoot = fsImpl.realpathSync(root); } catch { return root; }
    return realRoot;
  };

  function isFile(file) {
    try {
      if (!fsImpl.statSync(file).isFile()) return false;
      // A symlink inside dist/ must not reach outside it either.
      return inside(realRootOf(), fsImpl.realpathSync(file));
    } catch {
      return false;
    }
  }

  function resolve(pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(String(pathname || '/'));
    } catch {
      return { status: 200, file: index };
    }
    if (decoded.includes('\0')) return { status: 403 };
    const file = path.join(root, decoded);
    if (!inside(root, file)) return { status: 403 };
    if (file !== root && isFile(file)) return { status: 200, file };
    return { status: 200, file: index };
  }

  async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    let pathname;
    try {
      pathname = new URL(req.url, 'http://ui.invalid').pathname;
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const target = resolve(pathname);
    if (target.status !== 200) {
      res.writeHead(target.status);
      res.end();
      return;
    }
    let data;
    try {
      data = await fsImpl.promises.readFile(target.file);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      ...headers,
      'Content-Type': mime[path.extname(target.file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': String(data.length),
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  handle.resolve = resolve;
  return handle;
}

const OAUTH_PAGE = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Return to Woodshed</title>'
  + '<body style="font:18px system-ui;color-scheme:light dark;background:light-dark(#f8f7f1,#171c1b);color:light-dark(#18211f,#f0f1e9);padding:60px">'
  + '<h1>Return to Woodshed</h1><p>Finish signing in in the desktop app. You can close this tab.</p></body></html>';

/**
 * The UI origin's HTTP server (not yet listening).
 * @param {{origin: string, handleStatic: Function, mediaProxy?: {serve(req, res): any}, onOAuthCallback?: (search: string) => void}} options
 */
function createUiServer({ origin, handleStatic, mediaProxy, onOAuthCallback = () => {} }) {
  const host = new URL(origin).host;
  return http.createServer((req, res) => {
    if (req.headers.host !== host) {
      res.writeHead(403);
      res.end();
      return;
    }
    let url;
    try {
      url = new URL(req.url, origin);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (url.pathname.startsWith('/media/') && mediaProxy) {
      void mediaProxy.serve(req, res);
      return;
    }
    if (url.pathname === '/oauth/callback') {
      onOAuthCallback(url.searchParams.toString());
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      });
      res.end(OAUTH_PAGE);
      return;
    }
    void handleStatic(req, res);
  });
}

/** Listens on the origin's loopback port. */
function listen(server, origin) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(new URL(origin).port), '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

module.exports = { MIME, CSP, createStaticHandler, createUiServer, listen };
