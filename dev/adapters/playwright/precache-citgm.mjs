#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { compareSemver, parseNpmAlias, parseSemver, satisfiesSemver } from '../../../src/runtime/npm.js';
import { resolveCitgmProjectUrl } from './citgm-project-url.mjs';

const adapterRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultRegistry = 'https://registry.npmjs.org';

function usage() {
  return 'Usage: npm run citgm:precache -- [--citgm-version=10.0.2] <module>';
}

function parseArgs(rawArgs) {
  let citgmVersion = process.env.NACELLE_CITGM_VERSION || '10.0.2';
  let module = null;
  for (let index = 0; index < rawArgs.length; index += 1) {
    const argument = rawArgs[index];
    if (argument === '--') continue;
    if (argument === '--citgm-version' || argument.startsWith('--citgm-version=')) {
      citgmVersion = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : rawArgs[++index];
      continue;
    }
    if (!module && !argument.startsWith('-')) module = argument;
  }
  if (!module) throw new Error(usage());
  if (/^(?:[./]|\w+:)/.test(module)) {
    throw new Error('CITGM precache currently accepts registry package specs only');
  }
  return { citgmVersion, module };
}

function artifactId(citgmVersion, module, registry) {
  return Buffer.from(`${citgmVersion}\u0000${module}\u0000${registry}`).toString('base64url');
}

function packageUrl(registry, name) {
  const encodedName = name.startsWith('@')
    ? `@${encodeURIComponent(name.slice(1))}`
    : encodeURIComponent(name);
  return `${registry}/${encodedName}`;
}

function packageAssetId(name, version) {
  return createHash('sha256').update(`${name}@${version}`).digest('hex');
}

function packageNameFromSpec(spec) {
  if (spec.startsWith('@')) {
    const separator = spec.indexOf('@', 1);
    return separator > 0 ? spec.slice(0, separator) : spec;
  }
  const separator = spec.indexOf('@');
  return separator > 0 ? spec.slice(0, separator) : spec;
}

async function runHostNpm(args, cwd) {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`host npm exited with ${code ?? signal}`));
    });
  });
}

async function packageDirectories(nodeModulesDir, packages) {
  let entries;
  try {
    entries = await readdir(nodeModulesDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = path.join(nodeModulesDir, entry.name);
    if (entry.name.startsWith('@')) {
      let scopedEntries;
      try {
        scopedEntries = await readdir(entryPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const scopedEntry of scopedEntries) {
        if (!scopedEntry.isDirectory()) continue;
        await collectPackage(path.join(entryPath, scopedEntry.name), packages);
      }
    } else if (entry.isDirectory()) {
      await collectPackage(entryPath, packages);
    }
  }
}

async function collectPackage(packageDir, packages) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  } catch {
    return;
  }
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') return;
  const key = `${manifest.name}@${manifest.version}`;
  if (packages.has(key)) return;
  packages.set(key, {
    name: manifest.name,
    version: manifest.version,
    dependencies: { ...manifest.dependencies, ...manifest.optionalDependencies },
  });
  await packageDirectories(path.join(packageDir, 'node_modules'), packages);
}

async function mapWithConcurrency(values, concurrency, callback) {
  const results = [];
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await callback(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  return response.json();
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function projectPackageManifest(bytes) {
  const tar = gunzipSync(bytes);
  for (let offset = 0; offset + 512 <= tar.byteLength;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = new TextDecoder().decode(header.subarray(0, 100)).replace(/\0.*$/, '');
    const sizeText = new TextDecoder().decode(header.subarray(124, 136)).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeText || '0', 8);
    const contentStart = offset + 512;
    if (name.endsWith('/package.json') || name === 'package.json') {
      try {
        return JSON.parse(new TextDecoder().decode(tar.subarray(contentStart, contentStart + size)));
      } catch {
        return null;
      }
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

function resolveVersion(document, range) {
  if (range === 'latest' && document['dist-tags']?.latest) {
    const version = document['dist-tags'].latest;
    return { version, document: document.versions?.[version] };
  }
  const versions = Object.keys(document.versions || {})
    .filter((version) => parseSemver(version))
    .sort((left, right) => compareSemver(right, left));
  const version = versions.find((candidate) => satisfiesSemver(candidate, range))
    || document['dist-tags']?.[range];
  return version ? { version, document: document.versions?.[version] } : { version: null, document: null };
}

async function resolvePackageGraph(initialPackages, metadata, registry, includeDevDependencies = new Set()) {
  const packages = new Map(initialPackages.map((item) => [`${item.name}@${item.version}`, item]));
  const requestedNames = new Set(initialPackages.map(({ name }) => name));
  const pending = [];
  const pendingKeys = new Set();
  const processed = new Set();
  const addRequest = (name, range) => {
    if (typeof name !== 'string' || typeof range !== 'string') return;
    const alias = parseNpmAlias(range);
    const requestName = alias?.name || name;
    const requestRange = alias?.range || range;
    if (/^(?:file:|git:|github:|https?:\/\/)/i.test(requestRange)) {
      throw new Error(`CITGM precache does not support non-registry dependency ${requestName}@${requestRange}`);
    }
    requestedNames.add(requestName);
    const key = `${requestName}@${requestRange}`;
    if (pendingKeys.has(key)) return;
    pendingKeys.add(key);
    pending.push({ name: requestName, range: requestRange });
  };

  for (const item of initialPackages) {
    addRequest(item.name, item.version);
    for (const [name, range] of Object.entries(item.dependencies || {})) addRequest(name, range);
    if (includeDevDependencies.has(item.name)) {
      for (const [name, range] of Object.entries(item.devDependencies || {})) addRequest(name, range);
    }
  }

  while (true) {
    const missingNames = [...requestedNames].filter((name) => !metadata.has(name));
    if (missingNames.length) {
      await mapWithConcurrency(missingNames, 16, async (name) => {
        metadata.set(name, await fetchJson(packageUrl(registry, name)));
      });
    }
    let processedRequest = false;
    const pendingLength = pending.length;
    for (let index = 0; index < pendingLength; index += 1) {
      const request = pending[index];
      const requestKey = `${request.name}@${request.range}`;
      if (processed.has(requestKey)) continue;
      processed.add(requestKey);
      processedRequest = true;
      const resolved = resolveVersion(metadata.get(request.name), request.range);
      if (!resolved.version || !resolved.document) {
        throw new Error(`No matching version found for ${request.name}@${request.range}`);
      }
      const packageKey = `${request.name}@${resolved.version}`;
      if (!packages.has(packageKey)) packages.set(packageKey, { name: request.name, version: resolved.version });
      for (const [name, range] of Object.entries({
        ...resolved.document.dependencies,
        ...resolved.document.optionalDependencies,
      })) addRequest(name, range);
    }
    if (!processedRequest && ![...requestedNames].some((name) => !metadata.has(name))) break;
  }
  return [...packages.values()];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const registry = String(process.env.NACELLE_NPM_REGISTRY || defaultRegistry).replace(/\/+$/, '');
  const stagingDir = await mkdtemp(path.join(os.tmpdir(), 'nacelle-citgm-precache-'));
  const cacheDir = path.join(adapterRoot, '.cache', 'citgm', artifactId(options.citgmVersion, options.module, registry));
  try {
    await runHostNpm([
      'install', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', '--no-package-lock',
      `citgm@${options.citgmVersion}`, options.module,
    ], stagingDir);

    const packages = new Map();
    await packageDirectories(path.join(stagingDir, 'node_modules'), packages);
    const installedPackages = [...packages.values()];
    const targetName = packageNameFromSpec(options.module);
    const targetPackage = installedPackages.find(({ name }) => name === targetName);
    if (targetPackage) {
      const targetManifestPath = path.join(stagingDir, 'node_modules', ...targetName.split('/'), 'package.json');
      const targetManifest = JSON.parse(await readFile(targetManifestPath, 'utf8'));
      targetPackage.devDependencies = { ...targetManifest.devDependencies };
    }
    const citgmLookup = JSON.parse(await readFile(
      path.join(stagingDir, 'node_modules', 'citgm', 'lib', 'lookup.json'),
      'utf8',
    ));
    const metadata = new Map();
    process.stdout.write(`Resolving metadata for ${new Set(installedPackages.map(({ name }) => name)).size} packages...\n`);
    let packageList = await resolvePackageGraph(installedPackages, metadata, registry, new Set([targetName]));
    process.stdout.write(`Fetching metadata for ${metadata.size} packages...\n`);

    const projectPaths = {};
    const projectUrl = resolveCitgmProjectUrl({
      moduleSpec: options.module,
      metadata: metadata.get(targetName),
      lookup: citgmLookup?.[targetName],
    });
    let projectArchive = null;
    if (projectUrl) {
      process.stdout.write(`Fetching CITGM project archive ${projectUrl}...\n`);
      projectArchive = await fetchBytes(projectUrl);
      const projectManifest = projectPackageManifest(projectArchive);
      if (targetPackage && projectManifest?.devDependencies) {
        targetPackage.devDependencies = {
          ...targetPackage.devDependencies,
          ...projectManifest.devDependencies,
        };
        packageList = await resolvePackageGraph(installedPackages, metadata, registry, new Set([targetName]));
        process.stdout.write(`Resolved project test dependencies; metadata now covers ${metadata.size} packages.\n`);
      }
    }

    await rm(cacheDir, { recursive: true, force: true });
    await mkdir(path.join(cacheDir, 'metadata'), { recursive: true });
    await mkdir(path.join(cacheDir, 'tarballs'), { recursive: true });
    const metadataPaths = {};
    for (const [name, document] of metadata) {
      const relative = `metadata/${packageAssetId(name, 'metadata')}.json`;
      await writeFile(path.join(cacheDir, relative), JSON.stringify(document));
      metadataPaths[name] = relative;
    }

    process.stdout.write(`Fetching ${packageList.length} package tarballs...\n`);
    const tarballPaths = {};
    await mapWithConcurrency(packageList, 12, async ({ name, version }) => {
      const document = metadata.get(name);
      const packageDocument = document?.versions?.[version];
      const tarballUrl = packageDocument?.dist?.tarball;
      if (!tarballUrl) throw new Error(`metadata has no tarball for ${name}@${version}`);
      const relative = `tarballs/${packageAssetId(name, version)}.tgz`;
      await writeFile(path.join(cacheDir, relative), await fetchBytes(tarballUrl));
      tarballPaths[`pkg-tarball:${name}@${version}`] = relative;
      tarballPaths[`tarball:${tarballUrl}`] = relative;
    });

    if (projectUrl && projectArchive) {
      const relative = `projects/${createHash('sha256').update(projectUrl).digest('hex')}.tar.gz`;
      await mkdir(path.join(cacheDir, 'projects'), { recursive: true });
      await writeFile(path.join(cacheDir, relative), projectArchive);
      projectPaths[projectUrl] = relative;
    }

    const manifest = {
      schemaVersion: 1,
      citgmVersion: options.citgmVersion,
      module: options.module,
      registry,
      generatedAt: new Date().toISOString(),
      metadata: metadataPaths,
      tarballs: tarballPaths,
      projects: projectPaths,
      packageCount: packageList.length,
    };
    await writeFile(path.join(cacheDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`Wrote ${path.relative(process.cwd(), path.join(cacheDir, 'manifest.json'))} (${packageList.length} packages).\n`);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
}
