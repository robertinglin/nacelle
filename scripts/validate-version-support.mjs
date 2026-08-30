#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listNodeVersionProfiles,
  nodeVersionAliases,
  resolveNodeVersionProfile,
} from '../src/versions/index.js';
import { BROWSER_NAPI_VERSION } from '../src/runtime/addon-napi.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJSON = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
const distributionDirectory = path.join(repositoryRoot, 'dist');
const requested = process.argv.find((argument) => argument.startsWith('--node-version='));
const profiles = requested
  ? [resolveNodeVersionProfile(requested.slice('--node-version='.length))]
  : listNodeVersionProfiles();

function requireExportFile(subpath, condition) {
  const target = packageJSON.exports?.[subpath]?.[condition];
  if (!target) throw new Error(`package.json export ${subpath} is missing ${condition}`);
  const outputPath = path.resolve(repositoryRoot, target);
  if (!fs.existsSync(outputPath)) throw new Error(`package export ${subpath}/${condition} is not built: ${target}`);
  return target;
}

function requireDirectExport(subpath) {
  const target = packageJSON.exports?.[subpath];
  if (typeof target !== 'string') throw new Error(`package.json export ${subpath} is missing`);
  if (!fs.existsSync(path.resolve(repositoryRoot, target))) throw new Error(`package export ${subpath} is not built: ${target}`);
}

for (const profile of profiles) {
  const wasmDirectory = path.join(repositoryRoot, profile.wasm.directory);
  const manifestPath = path.join(wasmDirectory, profile.wasm.manifest);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.node_version !== profile.id) throw new Error(`${profile.id} manifest has the wrong node_version`);
  if (manifest.reference_version !== profile.referenceVersion) throw new Error(`${profile.id} manifest has a stale reference version`);
  if (String(manifest.abi?.modules) !== profile.versions.modules) throw new Error(`${profile.id} manifest has the wrong module ABI`);
  if (String(manifest.abi?.napi) !== profile.versions.napi) throw new Error(`${profile.id} manifest has the wrong Node-API version`);
  if (Number(profile.versions.napi) !== BROWSER_NAPI_VERSION) throw new Error(`${profile.id} does not match the browser Node-API implementation`);
  if (!manifest.artifacts.length) throw new Error(`${profile.id} manifest has no artifacts`);
  for (const artifact of manifest.artifacts) {
    const filename = path.basename(artifact.wasm);
    const bytes = fs.readFileSync(path.join(wasmDirectory, filename));
    if (!WebAssembly.validate(bytes)) throw new Error(`${profile.id}/${filename} is not valid WebAssembly`);
  }
  const exported = packageJSON.exports?.[`./${profile.id}`];
  if (!exported?.import || !exported?.types) throw new Error(`package.json does not export ./${profile.id}`);
  for (const condition of ['import', 'require', 'types']) requireExportFile(`./${profile.id}`, condition);
  const metadataPath = path.join(distributionDirectory, profile.id, 'version.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (metadata.packageVersion !== packageJSON.version
    || metadata.nodeTargetVersion !== profile.id
    || metadata.nodeReferenceVersion !== profile.referenceVersion
    || String(metadata.nodeModuleAbi) !== profile.versions.modules
    || String(metadata.nodeApi) !== profile.versions.napi
    || metadata.releaseMaturity !== profile.maturity) {
    throw new Error(`${profile.id} build metadata does not match its profile`);
  }
  const builtManifest = JSON.parse(fs.readFileSync(
    path.join(distributionDirectory, profile.id, 'wasm', profile.wasm.manifest),
    'utf8',
  ));
  if (!builtManifest.artifact_set_sha256 || builtManifest.artifacts.length !== manifest.artifacts.length) {
    throw new Error(`${profile.id} built WASM manifest is incomplete`);
  }
}

for (const [alias, target] of Object.entries(nodeVersionAliases())) {
  const exported = packageJSON.exports?.[`./${alias}`];
  if (!exported?.import?.includes(`/${target}/`)) throw new Error(`package export ./${alias} does not resolve to ${target}`);
  for (const condition of ['import', 'require', 'types']) requireExportFile(`./${alias}`, condition);
}

for (const condition of ['import', 'require', 'types']) requireExportFile('.', condition);
for (const subpath of ['./support', './version', './v22/version']) requireDirectExport(subpath);
const support = JSON.parse(fs.readFileSync(path.join(distributionDirectory, 'support.json'), 'utf8'));
if (support.default !== resolveNodeVersionProfile('latest').id
  || JSON.stringify(support.aliases) !== JSON.stringify(nodeVersionAliases())
  || support.profiles.length !== listNodeVersionProfiles().length) {
  throw new Error('dist/support.json does not match the support registry');
}

console.log(`Validated ${profiles.map((profile) => profile.id).join(', ')}`);
