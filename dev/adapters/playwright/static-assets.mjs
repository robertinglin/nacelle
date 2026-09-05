import path from 'node:path';

export const harnessPage = '<!doctype html><script type="module" src="/target-bridge.example.js"></script>';

/** Resolve browser test assets against canonical source, never a stale copy. */
export function browserAssetPath(requestURL, adapterRoot) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(requestURL, 'http://localhost').pathname); }
  catch { throw new Error(`unsafe browser test path: ${requestURL}`); }
  const relative = pathname === '/' ? 'harness.html' : pathname.replace(/^\/+/, '');
  const sourceAsset = relative === 'runtime.js' || relative === 'index.js'
    || ['runtime/', 'versions/', 'wasm/'].some(prefix => relative.startsWith(prefix));
  const root = sourceAsset ? path.resolve(adapterRoot, '../../../src') : path.resolve(adapterRoot);
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error(`unsafe browser test path: ${requestURL}`);
  }
  return { relative, absolute };
}

export function browserAssetContentType(filename) {
  return ({
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
    '.png': 'image/png',
  })[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}
