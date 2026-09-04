import { unpackTarGz } from './tar.js';

function npmSecurityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function platformMatches(rule, value) {
  if (!rule) return true;
  const rules = Array.isArray(rule) ? rule.map(String) : [String(rule)];
  const excluded = rules.some((item) => item.startsWith('!') && item.slice(1) === value);
  if (excluded) return false;
  const allowed = rules.filter((item) => !item.startsWith('!'));
  return allowed.length === 0 || allowed.includes(value);
}

function packageSupportsPlatform(packageManifest, platform, arch, libc) {
  return platformMatches(packageManifest?.os, platform)
    && platformMatches(packageManifest?.cpu, arch)
    && platformMatches(packageManifest?.libc, libc);
}

function isBrowserNativePackage(name, platform) {
  if (platform !== 'browser') return false;
  const packageName = String(name);
  return packageName === 'sharp'
    || /(?:^|-)\b(?:aix|android|darwin|freebsd|linux|openbsd|sunos|win32)\b(?:-|$)/i.test(packageName);
}

function isBrowserWasmPackage(name, platform) {
  if (platform !== 'browser') return false;
  return /(?:^|[-/])wasm(?:[-/]|$)/i.test(String(name));
}

function optionalPackageSupportsTarget(name, manifest, platform, arch, libc) {
  return packageSupportsPlatform(manifest, platform, arch, libc)
    || isBrowserWasmPackage(name, platform);
}

function base64(bytes) {
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  if (typeof btoa === 'function') return btoa(text);
  return globalThis.Buffer ? globalThis.Buffer.from(text, 'binary').toString('base64') : text;
}

async function verifyIntegrity(bytes, integrity, globalObject = globalThis) {
  if (!integrity) return true;
  const [algorithmName, expected] = String(integrity).split('-', 2);
  const algorithm = ({
    sha1: 'SHA-1',
    sha256: 'SHA-256',
    sha512: 'SHA-512',
  })[String(algorithmName || '').toLowerCase()];
  if (!['SHA-1', 'SHA-256', 'SHA-512'].includes(algorithm) || !expected) {
    throw npmSecurityError('ERR_NPM_INTEGRITY', 'unsupported package integrity metadata');
  }
  if (!globalObject.crypto?.subtle) throw npmSecurityError('ERR_NPM_INTEGRITY', 'package integrity cannot be verified in this environment');
  const digest = await globalObject.crypto.subtle.digest(algorithm, bytes);
  if (base64(new Uint8Array(digest)) !== expected) throw npmSecurityError('ERR_NPM_INTEGRITY', 'package integrity verification failed');
  return true;
}

export function parseSemver(v) {
  const clean = String(v || '').trim().replace(/^[=v]/, '');
  const match = clean.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: match[2] !== undefined ? parseInt(match[2], 10) : 0,
    patch: match[3] !== undefined ? parseInt(match[3], 10) : 0,
    hasMinor: match[2] !== undefined,
    hasPatch: match[3] !== undefined,
    prerelease: match[4] || null,
    build: match[5] || null,
    raw: clean,
  };
}

export function compareSemver(a, b) {
  const sa = typeof a === 'string' ? parseSemver(a) : a;
  const sb = typeof b === 'string' ? parseSemver(b) : b;
  if (!sa && !sb) return 0;
  if (!sa) return -1;
  if (!sb) return 1;
  if (sa.major !== sb.major) return sa.major > sb.major ? 1 : -1;
  if (sa.minor !== sb.minor) return sa.minor > sb.minor ? 1 : -1;
  if (sa.patch !== sb.patch) return sa.patch > sb.patch ? 1 : -1;
  if (sa.prerelease && !sb.prerelease) return -1;
  if (!sa.prerelease && sb.prerelease) return 1;
  if (sa.prerelease && sb.prerelease) {
    if (sa.prerelease !== sb.prerelease) return sa.prerelease > sb.prerelease ? 1 : -1;
  }
  return 0;
}

function wildcardComparator(v, value) {
  const match = String(value).match(/^(>=|<=|>|<|=|~|\^)?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/);
  if (!match || ![match[2], match[3], match[4]].some((part) => part && /[xX*]/.test(part))) return undefined;
  const operator = match[1] || '';
  const majorPart = match[2];
  if (/[xX*]/.test(majorPart)) return operator === '' || operator === '=';
  const major = Number(majorPart);
  const minorPart = match[3];
  const patchPart = match[4];
  const wildcardAt = /[xX*]/.test(minorPart || '') ? 'minor' : /[xX*]/.test(patchPart || '') ? 'patch' : null;
  if (!wildcardAt) return undefined;
  const lower = {
    major,
    minor: minorPart && wildcardAt !== 'minor' ? Number(minorPart) : 0,
    patch: patchPart && wildcardAt !== 'patch' ? Number(patchPart) : 0,
    prerelease: null,
  };
  const upper = wildcardAt === 'minor'
    ? { major: major + 1, minor: 0, patch: 0, prerelease: null }
    : { major, minor: lower.minor + 1, patch: 0, prerelease: null };
  const lowerComparison = compareSemver(v, lower);
  const upperComparison = compareSemver(v, upper);
  if (operator === '>') return upperComparison >= 0;
  if (operator === '>=') return lowerComparison >= 0;
  if (operator === '<') return lowerComparison < 0;
  if (operator === '<=') return upperComparison < 0;
  return lowerComparison >= 0 && upperComparison < 0;
}

function satisfiesComparator(v, comp) {
  const c = comp.trim();
  if (!c || c === '*' || c === 'x' || c === 'X' || c === 'latest') return true;

  // normalize x-ranges like 1.x, 1.2.x, 1.*
  const wildcardResult = wildcardComparator(v, c);
  if (wildcardResult !== undefined) return wildcardResult;

  // Caret ^1.2.3
  if (c.startsWith('^')) {
    const target = parseSemver(c.slice(1));
    if (!target) return false;
    if (v.major !== target.major) return false;
    if (target.major === 0) {
      if (target.hasMinor && target.minor !== 0) {
        if (v.minor !== target.minor) return false;
        return v.patch >= target.patch;
      }
      if (target.hasPatch) return v.patch === target.patch;
    }
    return compareSemver(v, target) >= 0;
  }

  // Tilde ~1.2.3
  if (c.startsWith('~')) {
    const target = parseSemver(c.slice(1));
    if (!target) return false;
    if (v.major !== target.major) return false;
    if (target.hasMinor && v.minor !== target.minor) return false;
    return v.patch >= target.patch;
  }

  if (c.startsWith('>=')) {
    const target = parseSemver(c.slice(2));
    return target ? compareSemver(v, target) >= 0 : false;
  }
  if (c.startsWith('>')) {
    const target = parseSemver(c.slice(1));
    if (!target) return false;
    if (!target.hasMinor && !target.hasPatch) {
      return v.major > target.major;
    }
    return compareSemver(v, target) > 0;
  }
  if (c.startsWith('<=')) {
    const target = parseSemver(c.slice(2));
    if (!target) return false;
    if (!target.hasMinor && !target.hasPatch) {
      return v.major <= target.major;
    }
    return compareSemver(v, target) <= 0;
  }
  if (c.startsWith('<')) {
    const target = parseSemver(c.slice(1));
    return target ? compareSemver(v, target) < 0 : false;
  }
  if (c.startsWith('=')) {
    const target = parseSemver(c.slice(1));
    return target ? compareSemver(v, target) === 0 : false;
  }

  const exact = parseSemver(c);
  if (exact) {
    if (!exact.hasMinor && !exact.hasPatch) return v.major === exact.major;
    if (!exact.hasPatch) return v.major === exact.major && v.minor === exact.minor;
    return compareSemver(v, exact) === 0;
  }
  return true;
}

export function satisfiesSemver(version, range) {
  const v = parseSemver(version);
  if (!v) return false;
  const trimmed = String(range || '').trim();
  if (trimmed === '*' || trimmed === '' || trimmed === 'latest') return true;

  // Handle || OR sets
  const orSets = trimmed.split(/\s*\|\|\s*/);
  return orSets.some((orSet) => {
    // Handle hyphen ranges: 1.2.3 - 2.3.4
    if (orSet.includes(' - ')) {
      const [low, high] = orSet.split(' - ').map((s) => s.trim());
      return satisfiesSemver(version, `>=${low} <=${high}`);
    }
    // Normalize spaces between operators and digits: '>= 2.1.2 < 3' -> '>=2.1.2 <3'
    const normalized = orSet.replace(/(>=|<=|>|<|=|~|\^)\s+/g, '$1').trim();
    if (!normalized) return true;
    const comps = normalized.split(/\s+/);
    return comps.every((comp) => satisfiesComparator(v, comp));
  });
}

export function parsePackageSpec(spec) {
  const trimmed = String(spec || '').trim();
  let name = trimmed;
  let range = 'latest';

  if (trimmed.startsWith('@')) {
    const slashIdx = trimmed.indexOf('/');
    if (slashIdx !== -1) {
      const atIdx = trimmed.indexOf('@', slashIdx);
      if (atIdx !== -1) {
        name = trimmed.slice(0, atIdx);
        range = trimmed.slice(atIdx + 1);
      }
    }
  } else {
    const atIdx = trimmed.indexOf('@');
    if (atIdx !== -1) {
      name = trimmed.slice(0, atIdx);
      range = trimmed.slice(atIdx + 1);
    }
  }

  return { name, range: range || 'latest' };
}

// npm aliases use the public package name as the dependency key while
// resolving metadata and tarballs for the aliased package. Keep this parser
// shared by the browser installer and host-side precache graph builder.
export function parseNpmAlias(range) {
  const trimmed = String(range || '').trim();
  if (!trimmed.startsWith('npm:')) return null;
  return parsePackageSpec(trimmed.slice(4));
}

/**
 * Persistent IndexedDB and in-memory cache for NPM package metadata and tarball archives.
 */
export class BrowserNpmCache {
  constructor({ dbName = 'bnh_npm_cache', globalObject = globalThis } = {}) {
    this.dbName = dbName;
    this.globalObject = globalObject;
    this.memoryMeta = new Map();
    this.memoryTarballs = new Map();
    this.dbPromise = null;
  }

  async _getDb() {
    if (this.dbPromise) return this.dbPromise;
    const indexedDB = this.globalObject.indexedDB;
    if (!indexedDB) return null;

    this.dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(this.dbName, 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('metadata')) {
            db.createObjectStore('metadata', { keyPath: 'name' });
          }
          if (!db.objectStoreNames.contains('tarballs')) {
            db.createObjectStore('tarballs', { keyPath: 'key' });
          }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.dbPromise;
  }

  async getMetadata(packageName) {
    if (this.memoryMeta.has(packageName)) return this.memoryMeta.get(packageName);
    const db = await this._getDb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('metadata', 'readonly');
        const store = tx.objectStore('metadata');
        const req = store.get(packageName);
        req.onsuccess = () => {
          const record = req.result;
          if (record && record.data) {
            this.memoryMeta.set(packageName, record.data);
            resolve(record.data);
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async setMetadata(packageName, data) {
    this.memoryMeta.set(packageName, data);
    const db = await this._getDb();
    if (!db) return;
    try {
      const tx = db.transaction('metadata', 'readwrite');
      tx.objectStore('metadata').put({ name: packageName, data, cachedAt: Date.now() });
    } catch {
      // ignore storage failure
    }
  }

  async getTarball(key) {
    const rawKey = key.replace(/^(?:pkg-tarball:|tarball:|pkg:)/, '');
    const candidateKeys = [key, rawKey, `tarball:${rawKey}`, `pkg-tarball:${rawKey}`, `pkg:${rawKey}`];
    for (const k of candidateKeys) {
      if (this.memoryTarballs.has(k)) return this.memoryTarballs.get(k);
    }
    const db = await this._getDb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('tarballs', 'readonly');
        const store = tx.objectStore('tarballs');
        const req = store.get(key);
        req.onsuccess = () => {
          const record = req.result;
          if (record && record.bytes) {
            const bytes = record.bytes instanceof Uint8Array ? record.bytes : new Uint8Array(record.bytes);
            this.memoryTarballs.set(key, bytes);
            resolve(bytes);
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async setTarball(key, bytes, meta = {}) {
    const uint8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.memoryTarballs.set(key, uint8);
    const db = await this._getDb();
    if (!db) return;
    try {
      const tx = db.transaction('tarballs', 'readwrite');
      tx.objectStore('tarballs').put({
        key,
        bytes: uint8,
        size: uint8.byteLength,
        name: meta.name || '',
        version: meta.version || '',
        cachedAt: Date.now(),
      });
    } catch {
      // ignore storage failure
    }
  }

  async listTarballs() {
    const db = await this._getDb();
    if (!db) {
      return [...this.memoryTarballs.entries()].map(([key, bytes]) => ({
        key,
        size: bytes.byteLength,
      }));
    }
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('tarballs', 'readonly');
        const req = tx.objectStore('tarballs').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  async clear() {
    this.memoryMeta.clear();
    this.memoryTarballs.clear();
    const db = await this._getDb();
    if (!db) return;
    try {
      const tx = db.transaction(['metadata', 'tarballs'], 'readwrite');
      tx.objectStore('metadata').clear();
      tx.objectStore('tarballs').clear();
    } catch {
      // ignore storage failure
    }
  }

  // Drop the in-memory acceleration layer without deleting persistent cache
  // records.  CITGM uses this boundary before handing a live cache proxy to a
  // child so packages fetched after child startup still travel through the
  // normal metadata/tarball path instead of being captured in a parent-only
  // snapshot.
  clearMemory() {
    this.memoryMeta.clear();
    this.memoryTarballs.clear();
  }

  async getStats() {
    const items = await this.listTarballs();
    const totalBytes = items.reduce((acc, item) => acc + (item.size || item.bytes?.byteLength || 0), 0);
    return { count: items.length, totalBytes };
  }
}

/**
 * In-browser NPM package installer supporting semver resolution, tarball downloading, and VFS unpacking.
 */
export class BrowserNpm {
  constructor({
    vfs,
    registry = 'https://registry.npmjs.org',
    cache = null,
    fetchFn = typeof fetch === 'function' ? fetch : null,
    globalObject = globalThis,
    proxyUrl = undefined,
    limits = {},
    lifecycleScripts = false,
    // The package install target is deliberately not the host-shaped Node
    // identity. Browser Nacelle cannot execute a native .node addon, so npm
    // must reject OS-specific optional packages before downloading them.
    platform = 'browser',
    arch = 'browser',
    libc = 'browser',
  } = {}) {
    this.vfs = vfs;
    this.registry = registry.replace(/\/+$/, '');
    this.globalObject = globalObject || globalThis;
    this.cache = cache instanceof BrowserNpmCache ? cache : new BrowserNpmCache({ globalObject: this.globalObject });
    if (proxyUrl !== undefined) {
      this.proxyUrl = proxyUrl;
    } else if (typeof this.globalObject?.location?.origin === 'string' && this.globalObject.location.origin.startsWith('http')) {
      this.proxyUrl = `${this.globalObject.location.origin}/__npm_proxy__/`;
    } else {
      this.proxyUrl = null;
    }
    if (cache instanceof Map) {
      for (const [k, v] of cache.entries()) {
        if (k.startsWith('pkg-tarball:') || k.startsWith('tarball:')) {
          this.cache.memoryTarballs.set(k, v);
        } else if (k.startsWith('meta:')) {
          this.cache.memoryMeta.set(k.slice(5), v);
        } else {
          this.cache.memoryTarballs.set(k, v);
        }
      }
    }
    const rawFetch = fetchFn || (typeof this.globalObject.fetch === 'function' ? this.globalObject.fetch : (typeof fetch === 'function' ? fetch : null));
    this.fetchFn = rawFetch ? (url, init) => rawFetch.call(this.globalObject, url, init) : null;
    this.installed = new Map(); // name -> version
    this.installedLocations = new Map(); // node_modules path -> version
    this.limits = {
      maxEntries: limits.maxEntries ?? 10_000,
      maxExpandedBytes: limits.maxExpandedBytes ?? 256 * 1024 * 1024,
      maxCompressionRatio: limits.maxCompressionRatio ?? 100,
    };
    this.lifecycleScripts = lifecycleScripts === true;
    this.platform = platform;
    this.arch = arch;
    this.libc = libc;
  }

  async fetchPackageMetadata(packageName, { onProgress = null } = {}) {
    const cached = await this.cache.getMetadata(packageName);
    if (cached) {
      onProgress?.({ phase: 'cache-hit-meta', name: packageName });
      return cached;
    }

    if (!this.fetchFn) throw new Error('No fetch implementation available for npm registry');

    const encodedName = packageName.startsWith('@')
      ? `@${packageName.slice(1).split('/').map(encodeURIComponent).join('/')}`
      : encodeURIComponent(packageName);
    const directUrl = `${this.registry}/${encodedName}`;
    const requestUrl = this.proxyUrl ? `${this.proxyUrl}${directUrl}` : directUrl;

    onProgress?.({ phase: 'fetching-meta', name: packageName, url: directUrl });

    let response;
    try {
      response = await this.fetchFn(requestUrl, {
        headers: { accept: 'application/vnd.npm.install-v1+json, application/json;q=0.9, */*;q=0.8' },
      });
    } catch (proxyErr) {
      if (this.proxyUrl) {
        response = await this.fetchFn(directUrl, {
          headers: { accept: 'application/vnd.npm.install-v1+json, application/json;q=0.9, */*;q=0.8' },
        });
      } else {
        throw proxyErr;
      }
    }

    if (!response.ok && this.proxyUrl) {
      // Fallback to direct registry URL if proxy returned non-200
      response = await this.fetchFn(directUrl, {
        headers: { accept: 'application/vnd.npm.install-v1+json, application/json;q=0.9, */*;q=0.8' },
      });
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch package metadata for ${packageName}: HTTP ${response.status}`);
    }
    const data = await response.json();
    await this.cache.setMetadata(packageName, data);
    return data;
  }

  // The registry's install-v1 response intentionally contains compact
  // version records. Commands such as `npm view --json` need the complete
  // package.json manifest, so fetch the selected version endpoint instead of
  // treating the compact install index as the public view result.
  async fetchPackageVersionMetadata(packageName, version, { onProgress = null } = {}) {
    if (!this.fetchFn) throw new Error('No fetch implementation available for npm registry');
    const encodedName = packageName.startsWith('@')
      ? `@${packageName.slice(1).split('/').map(encodeURIComponent).join('/')}`
      : encodeURIComponent(packageName);
    const directUrl = `${this.registry}/${encodedName}/${encodeURIComponent(version)}`;
    const requestUrl = this.proxyUrl ? `${this.proxyUrl}${directUrl}` : directUrl;
    onProgress?.({ phase: 'fetching-version-meta', name: packageName, version, url: directUrl });

    let response;
    try {
      response = await this.fetchFn(requestUrl, {
        headers: { accept: 'application/json, */*;q=0.8' },
      });
    } catch (proxyErr) {
      if (this.proxyUrl) response = await this.fetchFn(directUrl);
      else throw proxyErr;
    }
    if (!response.ok && this.proxyUrl) response = await this.fetchFn(directUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch package manifest for ${packageName}@${version}: HTTP ${response.status}`);
    }
    return response.json();
  }

  resolveVersion(metadata, range) {
    if (range === 'latest' && metadata['dist-tags']?.latest) {
      const latest = metadata['dist-tags'].latest;
      return { version: latest, doc: metadata.versions[latest] };
    }

    const versions = Object.keys(metadata.versions || {}).filter((v) => parseSemver(v));
    // Sort highest first
    versions.sort((a, b) => compareSemver(b, a));

    for (const v of versions) {
      if (satisfiesSemver(v, range)) {
        return { version: v, doc: metadata.versions[v] };
      }
    }

    if (metadata['dist-tags']?.[range]) {
      const tagVersion = metadata['dist-tags'][range];
      return { version: tagVersion, doc: metadata.versions[tagVersion] };
    }

    throw new Error(`No matching version found for ${metadata.name}@${range}`);
  }

  async fetchTarball(tarballUrl, { name = '', version = '', integrity = '', onProgress = null } = {}) {
    const cacheKey = `tarball:${tarballUrl}`;
    const cached = await this.cache.getTarball(cacheKey);
    if (cached) {
      await verifyIntegrity(cached, integrity, this.globalObject);
      onProgress?.({ phase: 'cache-hit-tarball', name, version, bytes: cached.byteLength });
      return cached;
    }

    const pkgKey = `pkg-tarball:${name}@${version}`;
    const cachedByPkg = await this.cache.getTarball(pkgKey);
    if (cachedByPkg) {
      await verifyIntegrity(cachedByPkg, integrity, this.globalObject);
      onProgress?.({ phase: 'cache-hit-tarball', name, version, bytes: cachedByPkg.byteLength });
      return cachedByPkg;
    }

    if (!this.fetchFn) throw new Error(`No fetch implementation available to download ${tarballUrl}`);

    onProgress?.({ phase: 'downloading-tarball', name, version, url: tarballUrl });

    const requestUrl = this.proxyUrl ? `${this.proxyUrl}${tarballUrl}` : tarballUrl;
    let response;
    try {
      response = await this.fetchFn(requestUrl);
    } catch (proxyErr) {
      if (this.proxyUrl) {
        response = await this.fetchFn(tarballUrl);
      } else {
        throw proxyErr;
      }
    }

    if (!response.ok && this.proxyUrl) {
      response = await this.fetchFn(tarballUrl);
    }

    if (!response.ok) {
      throw new Error(`Failed to download tarball ${tarballUrl}: HTTP ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    await verifyIntegrity(bytes, integrity, this.globalObject);
    await this.cache.setTarball(cacheKey, bytes, { name, version });
    await this.cache.setTarball(pkgKey, bytes, { name, version });
    return bytes;
  }

  async readPackageJson(cwd = '/node') {
    const pkgJsonPath = `${cwd.replace(/\/+$/, '')}/package.json`;
    try {
      const bytes = await this.vfs.fs.promises.readFile(pkgJsonPath);
      const text = (typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)).trim();
      if (!text) return null;
      return JSON.parse(text);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async readPackageDependencies(cwd = '/node') {
    const pkg = await this.readPackageJson(cwd);
    if (!pkg) return [];
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return Object.entries(deps).map(([name, range]) => `${name}@${range}`);
  }

  async seedInstalledLocations() {
    const packageJsonSuffix = '/package.json';
    const visit = async (directory) => {
      for (const entry of this.vfs?.entries?.(directory) || []) {
        const pathname = `${directory.replace(/\/+$/, '')}/${entry.name}`;
        if (entry.isDirectory?.()) {
          await visit(pathname);
          continue;
        }
        if (entry.name !== 'package.json' || !pathname.endsWith(packageJsonSuffix)) continue;
        const packageDir = pathname.slice(0, -packageJsonSuffix.length);
        const marker = packageDir.lastIndexOf('/node_modules/');
        if (marker < 0) continue;
        const relative = packageDir.slice(marker + '/node_modules/'.length);
        const segments = relative.split('/');
        if (segments.length !== 1 && !(segments.length === 2 && segments[0].startsWith('@'))) continue;
        try {
          const bytes = await this.vfs.fs.promises.readFile(pathname);
          const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
          const manifest = JSON.parse(text);
          if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
            this.installedLocations.set(packageDir, manifest.version);
            this.installed.set(manifest.name, manifest.version);
          }
        } catch {
          // A malformed or inaccessible manifest is handled by normal loading.
        }
      }
    };
    await visit('/node');
  }

  async install(packageSpecs, {
    cwd = '/node',
    nodeModulesDir = null,
    onProgress = null,
    concurrency = 8,
    lifecycleScripts = this.lifecycleScripts,
    limits = this.limits,
    includeDevDependencies = false,
  } = {}) {
    let rawSpecs = packageSpecs;
    if (!rawSpecs || (Array.isArray(rawSpecs) && rawSpecs.length === 0)) {
      rawSpecs = await this.readPackageDependencies(cwd);
      if (rawSpecs.length === 0) {
        return { packages: [], totalFiles: 0, files: {} };
      }
    }
    const specs = Array.isArray(rawSpecs) ? rawSpecs : [rawSpecs];
    const targetNodeModules = nodeModulesDir || (cwd.endsWith('/') ? `${cwd}node_modules` : `${cwd}/node_modules`);
    await this.seedInstalledLocations();
    const queue = specs.map((spec) => ({ ...parsePackageSpec(spec), optional: false, nodeModulesDir: targetNodeModules }));
    const results = [];
    const visited = new Set();
    const filesToMount = {};

    const parentNodeModulesDir = (directory) => {
      const packageRoot = directory.endsWith('/node_modules')
        ? directory.slice(0, -'/node_modules'.length)
        : directory;
      const marker = packageRoot.lastIndexOf('/node_modules/');
      return marker < 0 ? null : `${packageRoot.slice(0, marker)}/node_modules`;
    };

    const dependencyLocation = (name, range, currentNodeModulesDir, currentPackageDir) => {
      const resolutionRange = parseNpmAlias(range)?.range || range;
      let directory = currentNodeModulesDir;
      let conflict = false;
      while (directory) {
        const installedVersion = this.installedLocations.get(`${directory}/${name}`);
        if (installedVersion) {
          if (satisfiesSemver(installedVersion, resolutionRange)) return null;
          conflict = true;
        }
        directory = parentNodeModulesDir(directory);
      }
      return conflict ? `${currentPackageDir}/node_modules` : currentNodeModulesDir;
    };

    const processItem = async ({
      name,
      range,
      optional = false,
      nodeModulesDir: requestedNodeModulesDir = targetNodeModules,
      parentPackageDir = null,
    }) => {
      const alias = parseNpmAlias(range);
      // npm aliases keep the dependency key and install location under the
      // requested name, but resolve metadata and tarballs using the target
      // package name/range. This is a package-manager contract, not a
      // candidate-specific exception.
      const resolutionName = alias?.name || name;
      const resolutionRange = alias?.range || range;
      let itemNodeModulesDir = requestedNodeModulesDir;
      let locationKey = `${itemNodeModulesDir}/${name}`;
      let installedVersion = this.installedLocations.get(locationKey);
      if (installedVersion && !satisfiesSemver(installedVersion, resolutionRange) && parentPackageDir) {
        itemNodeModulesDir = `${parentPackageDir}/node_modules`;
        locationKey = `${itemNodeModulesDir}/${name}`;
        installedVersion = this.installedLocations.get(locationKey);
      }
      const visitKey = `${itemNodeModulesDir}:${name}@${range}`;
      if (visited.has(visitKey) || (installedVersion && satisfiesSemver(installedVersion, resolutionRange))) return;
      visited.add(visitKey);
      // Platform-specific optional packages are native delivery variants in
      // the npm graph. Skip them before metadata/tarball work; Next.js will
      // select and, when needed, download its own WASM package at runtime.
      if (isBrowserNativePackage(resolutionName, this.platform)) {
        onProgress?.({ phase: 'optional-skipped', name, range, reason: 'browser-native-addon' });
        return;
      }

      let versionDoc = null;
      let version = null;
      let tarballBytes = null;

      // Check direct tarball cache by spec
      const directTarballKey = `pkg-tarball:${resolutionName}@${resolutionRange}`;
      const cachedDirect = await this.cache.getTarball(directTarballKey);
      if (cachedDirect) {
        tarballBytes = cachedDirect;
        version = resolutionRange === 'latest' ? '1.0.0' : resolutionRange;
        onProgress?.({ phase: 'cache-hit-tarball', name, version, bytes: tarballBytes.byteLength });
      } else {
        const metadata = await this.fetchPackageMetadata(resolutionName, { onProgress });
        const resolved = this.resolveVersion(metadata, resolutionRange);
        version = resolved.version;
        versionDoc = resolved.doc;
        if (optional && !optionalPackageSupportsTarget(resolutionName, versionDoc, this.platform, this.arch, this.libc)) {
          onProgress?.({ phase: 'optional-skipped', name, range, reason: 'platform-mismatch' });
          return;
        }
        const tarballUrl = versionDoc?.dist?.tarball;
        if (!tarballUrl) throw new Error(`Missing tarball URL for ${name}@${version}`);
        tarballBytes = await this.fetchTarball(tarballUrl, { name, version, integrity: versionDoc?.dist?.integrity, onProgress });
      }

      onProgress?.({ phase: 'unpacking', name, version });
      const pkgDir = `${itemNodeModulesDir}/${name}`;
      const entries = await unpackTarGz(tarballBytes, {
        stripPrefix: 'package/',
        targetDir: pkgDir,
        ...limits,
      }, this.globalObject);

      let pkgFilesCount = 0;
      let pkgTotalBytes = 0;
      let parsedPkgJson = null;
      const packageFiles = {};

      for (const entry of entries) {
        if (entry.type === 'file' && entry.data) {
          const fileData = entry.data;
          packageFiles[entry.path] = { data: fileData, mode: entry.mode };
          pkgFilesCount += 1;
          pkgTotalBytes += fileData.byteLength;

          if (entry.path === `${pkgDir}/package.json` || entry.path.endsWith('/package.json')) {
            try {
              const raw = typeof fileData === 'string' ? fileData : new TextDecoder().decode(fileData);
              parsedPkgJson = JSON.parse(raw);
            } catch { /* ignore */ }
          }
        }
      }

      if (optional && !optionalPackageSupportsTarget(resolutionName, parsedPkgJson, this.platform, this.arch, this.libc)) {
        onProgress?.({ phase: 'optional-skipped', name, range, reason: 'platform-mismatch' });
        return;
      }
      Object.assign(filesToMount, packageFiles);

      // Link package "bin" scripts into node_modules/.bin/
      if (parsedPkgJson && parsedPkgJson.bin) {
        const binEntries = typeof parsedPkgJson.bin === 'string'
          ? [[parsedPkgJson.name || name, parsedPkgJson.bin]]
          : Object.entries(parsedPkgJson.bin);

        for (const [binName, binRel] of binEntries) {
          const binPath = `${itemNodeModulesDir}/.bin/${binName}`;
          const cleanRel = String(binRel).replace(/^\.\//, '');
          if (!cleanRel || cleanRel.startsWith('/') || cleanRel.split('/').includes('..')) {
            throw npmSecurityError('ERR_NPM_PACKAGE_PATH', `package bin escapes its package directory: ${binRel}`);
          }
          const targetFile = `${pkgDir}/${cleanRel}`;
          // npm places .bin launchers beside the package directory. Keep the
          // launcher specifier relative to that directory so Node's ESM
          // resolver can determine the package scope from the target file,
          // rather than from the generated launcher itself.
          const targetSpecifier = `..${targetFile.slice(itemNodeModulesDir.length)}`;
          const isEsmBin = cleanRel.endsWith('.mjs')
            || (parsedPkgJson.type === 'module' && !cleanRel.endsWith('.cjs'));
          const launcher = isEsmBin
            // The generated .bin file itself has no module extension and is
            // therefore CommonJS when loaded directly. Keep the await inside
            // an async wrapper while retaining a relative ESM target.
            ? `(async () => { await import(${JSON.stringify(targetSpecifier)}); })().catch((error) => { process.stderr.write(String(error?.stack || error) + "\\n"); process.exitCode = 1; });`
            : `require(${JSON.stringify(targetFile)});`;
          filesToMount[binPath] = {
            data: new TextEncoder().encode(
              `#!/usr/bin/env node\n${launcher}\n`,
            ),
            mode: 0o755,
          };
        }
      }

      this.installedLocations.set(locationKey, version);
      this.installed.set(name, version);
      results.push({ name, version, filesCount: pkgFilesCount, bytes: pkgTotalBytes });
      onProgress?.({ phase: 'installed', name, version });

      if (lifecycleScripts && parsedPkgJson?.scripts && Object.keys(parsedPkgJson.scripts).some((name) => ['preinstall', 'install', 'postinstall'].includes(name))) {
        throw npmSecurityError('ERR_NPM_LIFECYCLE_DENIED', 'npm lifecycle scripts require an explicit, separately sandboxed runner');
      }

      // npm installs ordinary dependencies and the platform-compatible subset
      // of optionalDependencies. Peer dependencies are resolved by the caller's
      // dependency graph, as npm does when the peer is already present.
      const deps = {
        ...(versionDoc?.dependencies || {}),
        ...(parsedPkgJson?.dependencies || {}),
      };
      for (const [depName, depRange] of Object.entries(deps)) {
        const dependencyDir = dependencyLocation(depName, depRange, itemNodeModulesDir, pkgDir);
        if (dependencyDir) queue.push({
          name: depName,
          range: depRange,
          optional: false,
          nodeModulesDir: dependencyDir,
          parentPackageDir: pkgDir,
        });
      }
      const optionalDeps = {
        ...(versionDoc?.optionalDependencies || {}),
        ...(parsedPkgJson?.optionalDependencies || {}),
      };
      for (const [depName, depRange] of Object.entries(optionalDeps)) {
        const dependencyDir = dependencyLocation(depName, depRange, itemNodeModulesDir, pkgDir);
        if (dependencyDir) queue.push({
          name: depName,
          range: depRange,
          optional: true,
          nodeModulesDir: dependencyDir,
          parentPackageDir: pkgDir,
        });
      }
      if (includeDevDependencies && !parentPackageDir) {
        for (const [depName, depRange] of Object.entries(parsedPkgJson?.devDependencies || {})) {
          const dependencyDir = dependencyLocation(depName, depRange, itemNodeModulesDir, pkgDir);
          if (dependencyDir) queue.push({
            name: depName,
            range: depRange,
            optional: false,
            nodeModulesDir: dependencyDir,
            parentPackageDir: pkgDir,
          });
        }
      }
    };

    const installLocks = new Map();
    const processQueueItem = async (item) => {
      const lockKey = `${item.nodeModulesDir || targetNodeModules}/${item.name}`;
      const previous = installLocks.get(lockKey) || Promise.resolve();
      let release;
      const current = new Promise((resolve) => { release = resolve; });
      installLocks.set(lockKey, current);
      try {
        await previous;
        // Another dependency may have occupied the requested location while
        // this item waited for the lock. Recompute its npm placement against
        // the now-current tree before unpacking, otherwise a later branch
        // can overwrite an incompatible version at the same location.
        const dependencyDir = item.parentPackageDir
          ? dependencyLocation(item.name, item.range, item.nodeModulesDir, item.parentPackageDir)
          : null;
        await processItem(dependencyDir
          ? { ...item, nodeModulesDir: dependencyDir }
          : item);
      } catch (error) {
        if (!item.optional) throw error;
        onProgress?.({ phase: 'optional-failed', name: item.name, range: item.range, error });
      } finally {
        release();
        if (installLocks.get(lockKey) === current) installLocks.delete(lockKey);
      }
    };

    while (queue.length > 0) {
      const batch = queue.splice(0, concurrency);
      await Promise.all(batch.map(processQueueItem));
    }

    // Mount all unpacked files into VFS
    if (this.vfs && typeof this.vfs.mount === 'function') {
      onProgress?.({ phase: 'mounting', name: 'node_modules', count: Object.keys(filesToMount).length });
      await this.vfs.mount(filesToMount);
      onProgress?.({ phase: 'mounted', name: 'node_modules', count: Object.keys(filesToMount).length });
    }

    return {
      packages: results,
      totalFiles: Object.keys(filesToMount).length,
      files: filesToMount,
    };
  }
}

export { verifyIntegrity };

/**
 * Parses an npm script command string into executable, arguments, and inline environment variables.
 * Handles tokens, quotes, and leading KEY=VAL assignments.
 */
export function parseScriptCommand(cmdString) {
  const env = {};
  const tokens = [];
  const regex = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
  let match;
  while ((match = regex.exec(cmdString)) !== null) {
    let token = match[0];
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      token = token.slice(1, -1);
    }
    tokens.push(token);
  }

  // Extract leading FOO=BAR environment variables
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    const assign = tokens.shift();
    const eqIdx = assign.indexOf('=');
    const key = assign.slice(0, eqIdx);
    const val = assign.slice(eqIdx + 1);
    env[key] = val;
  }

  const binary = tokens[0] || '';
  const args = tokens.slice(1);
  return { binary, args, env, tokens };
}
