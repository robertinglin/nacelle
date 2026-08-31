#!/usr/bin/env node
/** Build every supported Node line while selecting one root/default profile. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  listNodeVersionProfiles,
  nodeVersionAliases,
  resolveNodeVersionProfile,
} from '../src/versions/index.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const sourceDirectory = path.join(repositoryRoot, 'src');
const outputDirectory = path.join(repositoryRoot, 'dist');
const packageJSON = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));

function selectedVersion(args) {
  const argument = args.find((value) => value.startsWith('--node-version='));
  return resolveNodeVersionProfile(argument ? argument.slice('--node-version='.length) : 'lts');
}

function sourceRevision() {
  if (process.env.SOURCE_REVISION) return process.env.SOURCE_REVISION;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readManifest(profile) {
  const directory = path.join(repositoryRoot, profile.wasm.directory);
  const manifestPath = path.join(directory, profile.wasm.manifest);
  if (!fs.existsSync(manifestPath)) throw new Error(`Missing WASM manifest for ${profile.id}: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.node_version !== profile.id
    || manifest.reference_version !== profile.referenceVersion
    || String(manifest.abi?.modules) !== profile.versions.modules
    || String(manifest.abi?.napi) !== profile.versions.napi
    || !Array.isArray(manifest.artifacts)
    || manifest.artifacts.length === 0) {
    throw new Error(`WASM manifest metadata does not match the ${profile.id} profile`);
  }
  return { directory, manifest };
}

function stageWasm(profile, targetDirectory) {
  const { directory, manifest } = readManifest(profile);
  fs.mkdirSync(targetDirectory, { recursive: true });
  const stagedFiles = new Set();
  const virtualPaths = new Set();
  const artifacts = manifest.artifacts.map((artifact) => {
    const wasmPath = String(artifact?.wasm || '');
    const filename = path.posix.basename(wasmPath);
    const virtualPath = String(artifact?.node || '');
    const virtualParts = virtualPath.split('/');
    if (wasmPath !== `./${filename}` || !filename.endsWith('.wasm')) {
      throw new Error(`Invalid ${profile.id} WASM artifact path: ${JSON.stringify(artifact?.wasm)}`);
    }
    if (!virtualPath || virtualPath.startsWith('/') || virtualPath.includes('\\')
      || virtualParts.some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`Invalid ${profile.id} virtual addon path: ${JSON.stringify(artifact?.node)}`);
    }
    if (typeof artifact.entry !== 'string' || !artifact.entry) {
      throw new Error(`Invalid ${profile.id} WASM artifact entry for ${filename}`);
    }
    if (stagedFiles.has(filename) || virtualPaths.has(virtualPath)) {
      throw new Error(`Duplicate ${profile.id} WASM artifact mapping for ${filename}`);
    }
    stagedFiles.add(filename);
    virtualPaths.add(virtualPath);
    const source = path.join(directory, filename);
    if (!fs.existsSync(source)) throw new Error(`Missing ${profile.id} WASM artifact: ${filename}`);
    const bytes = fs.readFileSync(source);
    if (!WebAssembly.validate(bytes)) throw new Error(`Invalid ${profile.id} WASM artifact: ${filename}`);
    if (!Array.isArray(artifact.exports) || artifact.exports.length === 0) {
      throw new Error(`Missing export contract for ${profile.id} WASM artifact: ${filename}`);
    }
    const exportedNames = new Set(WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map((item) => item.name));
    const missingExports = artifact.exports.filter((name) => !exportedNames.has(name));
    if (missingExports.length) throw new Error(`Invalid ${profile.id} WASM export contract for ${filename}: ${missingExports.join(', ')}`);
    fs.copyFileSync(source, path.join(targetDirectory, filename));
    return { ...artifact, wasm: `./${filename}`, bytes: bytes.byteLength, sha256: sha256(bytes) };
  });
  const artifactSetHash = sha256(artifacts.map((artifact) => `${artifact.wasm}:${artifact.sha256}\n`).join(''));
  const outputManifest = { ...manifest, artifact_set_sha256: artifactSetHash, artifacts };
  fs.writeFileSync(
    path.join(targetDirectory, profile.wasm.manifest),
    `${JSON.stringify(outputManifest, null, 2)}\n`,
  );
  return { count: artifacts.length, artifactSetHash };
}

function versionEntry(profile, baseImport) {
  return `export * from ${JSON.stringify(baseImport)};
import { Nacelle as BaseNacelle } from ${JSON.stringify(baseImport)};

export class Nacelle extends BaseNacelle {
  static create(options = {}) {
    return super.create({
      ...options,
      version: options.version ?? ${JSON.stringify(profile.id)},
      wasmBaseUrl: options.wasmBaseUrl ?? new URL('./wasm/', import.meta.url).href,
    });
  }
}
export default Nacelle;
`;
}

function commonJsEntry(profile) {
  const record = JSON.stringify(Object.fromEntries([
    'id', 'major', 'nodeRef', 'referenceVersion', 'status', 'maturity', 'codename',
    'endOfLife', 'npmTag', 'wasmDirectory',
  ].map((key) => [key, profile[key]])));
  return `'use strict';
let modulePromise;
const load = () => { modulePromise ||= import('./index.mjs'); return modulePromise; };
const record = Object.freeze(${record});
const records = Object.freeze([record]);
const aliases = Object.freeze(${JSON.stringify(nodeVersionAliases())});
const resolveVersion = (value = 'lts') => {
  const text = String(value).trim().toLowerCase();
  if (aliases[text] === record.id || /^(?:node@?|n|v)?${profile.major}(?:\\..*)?$/.test(text)) return record;
  const error = new RangeError('Unsupported Node.js target ' + JSON.stringify(value) + '; supported targets are ${profile.id}, ${Object.keys(nodeVersionAliases()).join(', ')}');
  error.code = 'ERR_NACELLE_UNSUPPORTED_NODE_VERSION';
  error.requested = value;
  error.supported = [record.id];
  throw error;
};
class Nacelle {
  static get supportedVersions() { return records; }
  static resolveVersion(value) { return resolveVersion(value); }
  static async create(options) { return (await load()).Nacelle.create(options); }
  static async initServiceWorker(...args) { return (await load()).Nacelle.initServiceWorker(...args); }
}
module.exports = {
  Nacelle,
  default: Nacelle,
  load,
  listSupportedNodeVersions: () => records,
  nodeVersionAliases: () => aliases,
  resolveNodeVersionRecord: resolveVersion,
};
`;
}

function profileMetadata(profile, wasm, revision) {
  const profileHash = sha256(JSON.stringify({
    id: profile.id,
    referenceVersion: profile.referenceVersion,
    versions: profile.versions,
    features: profile.features,
    wasm: wasm.artifactSetHash,
  }));
  return {
    name: packageJSON.name,
    packageVersion: packageJSON.version,
    nodeTargetVersion: profile.id,
    nodeReferenceVersion: profile.referenceVersion,
    nodeModuleAbi: profile.versions.modules,
    nodeApi: profile.versions.napi,
    codename: profile.codename,
    endOfLife: profile.endOfLife,
    npmTag: profile.npmTag,
    releaseStatus: profile.status,
    releaseMaturity: profile.maturity,
    sourceRevision: revision,
    profileSha256: profileHash,
    wasmArtifactSetSha256: wasm.artifactSetHash,
  };
}

function assertPublishedExports() {
  const targets = [];
  const visit = (value) => {
    if (typeof value === 'string') targets.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(packageJSON.exports);
  for (const target of targets) {
    if (!target.startsWith('./dist/')) continue;
    const relative = target.slice(2);
    const candidate = path.join(repositoryRoot, relative.replace(/\/\*$/, ''));
    if (!fs.existsSync(candidate)) throw new Error(`Published export target is missing from the build: ${target}`);
  }
}

const defaultProfile = selectedVersion(process.argv.slice(2));
const profiles = listNodeVersionProfiles();
const revision = sourceRevision();

fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.mkdirSync(outputDirectory, { recursive: true });
fs.cpSync(path.join(sourceDirectory, 'runtime'), path.join(outputDirectory, 'runtime'), { recursive: true });
fs.cpSync(path.join(sourceDirectory, 'versions'), path.join(outputDirectory, 'versions'), { recursive: true });
fs.copyFileSync(path.join(sourceDirectory, 'runtime.js'), path.join(outputDirectory, 'runtime.js'));
fs.copyFileSync(path.join(sourceDirectory, 'runtime.js'), path.join(outputDirectory, 'runtime.mjs'));
fs.copyFileSync(path.join(sourceDirectory, 'index.js'), path.join(outputDirectory, 'base-index.mjs'));
fs.copyFileSync(path.join(sourceDirectory, 'types.d.ts'), path.join(outputDirectory, 'index.d.ts'));
fs.copyFileSync(path.join(sourceDirectory, 'runtime', 'process-worker.js'), path.join(outputDirectory, 'process-worker.js'));
fs.copyFileSync(path.join(sourceDirectory, 'runtime', 'gateway-sw.js'), path.join(outputDirectory, 'gateway-sw.js'));

const metadata = [];
for (const profile of profiles) {
  const versionDirectory = path.join(outputDirectory, profile.id);
  fs.mkdirSync(versionDirectory, { recursive: true });
  const wasm = stageWasm(profile, path.join(versionDirectory, 'wasm'));
  const versionMetadata = profileMetadata(profile, wasm, revision);
  metadata.push(versionMetadata);
  fs.writeFileSync(path.join(versionDirectory, 'index.mjs'), versionEntry(profile, '../base-index.mjs'));
  fs.writeFileSync(path.join(versionDirectory, 'index.cjs'), commonJsEntry(profile));
  fs.copyFileSync(path.join(sourceDirectory, 'types.d.ts'), path.join(versionDirectory, 'index.d.ts'));
  fs.writeFileSync(path.join(versionDirectory, 'version.json'), `${JSON.stringify(versionMetadata, null, 2)}\n`);
  console.log(`  ✓ ${profile.id}: ${wasm.count} WASM artifacts, Node ${profile.referenceVersion}`);
}

fs.writeFileSync(path.join(outputDirectory, 'index.mjs'), versionEntry(defaultProfile, './base-index.mjs'));
fs.copyFileSync(path.join(outputDirectory, 'index.mjs'), path.join(outputDirectory, 'index.js'));
fs.writeFileSync(path.join(outputDirectory, 'index.cjs'), commonJsEntry(defaultProfile));
fs.cpSync(
  path.join(outputDirectory, defaultProfile.id, 'wasm'),
  path.join(outputDirectory, 'wasm'),
  { recursive: true },
);

const support = {
  default: defaultProfile.id,
  aliases: nodeVersionAliases(),
  sourceRevision: revision,
  profiles: metadata,
};
fs.writeFileSync(path.join(outputDirectory, 'support.json'), `${JSON.stringify(support, null, 2)}\n`);
fs.writeFileSync(
  path.join(outputDirectory, 'version.json'),
  `${JSON.stringify(metadata.find((item) => item.nodeTargetVersion === defaultProfile.id), null, 2)}\n`,
);

assertPublishedExports();

console.log(`  ✓ default: ${defaultProfile.id}`);
console.log(`  ✓ output: ${path.relative(repositoryRoot, outputDirectory)}/`);
