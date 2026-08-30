#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { Nacelle, resolveNodeVersionProfile } from '../src/index.js';

async function processResult(handle) {
  const code = await handle.exit;
  return {
    code,
    stdout: await handle.stdoutText(),
    stderr: await handle.stderrText(),
  };
}

export async function runVersionParity(version) {
  const profile = resolveNodeVersionProfile(version);
  const createNode = (files = {}) => Nacelle.create({
    version: profile.id,
    gateway: false,
    files,
  });
  const npmFiles = {
      '/node/package.json': JSON.stringify({
        name: `nacelle-parity-${profile.id}`,
        version: '1.0.0',
        scripts: {
          crossenv: 'cross-env NODE_ENV=production node -e "require(\'node:fs\').writeFileSync(\'crossenv.txt\', process.env.NODE_ENV)"',
        },
      }),
      '/node/node_modules/.bin/cross-env': `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const env = { ...process.env };
while (args[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])) {
  const separator = args[0].indexOf('=');
  env[args[0].slice(0, separator)] = args.shift().slice(separator + 1);
}
const child = spawnSync(args.shift(), args, { env, stdio: 'inherit' });
process.exitCode = child.status ?? 1;
`,
  };
  const checks = [];
  const check = async (name, run) => {
    try {
      const details = await run();
      checks.push({ name, status: details.pass ? 'pass' : 'semantic-drift', ...details });
    } catch (error) {
      checks.push({
        name,
        status: String(error?.code || '').startsWith('ERR_UNSUPPORTED_') ? 'unsupported' : 'semantic-drift',
        pass: false,
        error: { name: error?.name, code: error?.code, message: error?.message || String(error) },
      });
    }
  };

  await check('process-metadata', async () => {
    const node = await createNode();
    const result = await processResult(await node.execute(`
      console.log(JSON.stringify({
        version: process.version,
        node: process.versions.node,
        modules: process.versions.modules,
        napi: process.versions.napi,
        lts: process.release.lts || null,
        typescript: process.features.typescript,
      }));
    `));
    const actual = JSON.parse(result.stdout.trim());
    const expected = {
      version: profile.runtimeVersion,
      node: profile.referenceVersion,
      modules: profile.versions.modules,
      napi: profile.versions.napi,
      lts: profile.codename,
      typescript: profile.features.typescript,
    };
    return { pass: result.code === 0 && JSON.stringify(actual) === JSON.stringify(expected), code: result.code, actual, expected, stderr: result.stderr };
  });

  await check('shell-version', async () => {
    const node = await createNode();
    const result = await processResult(await node.bash('node --version'));
    return { pass: result.code === 0 && result.stdout.trim() === profile.runtimeVersion, code: result.code, actual: result.stdout.trim(), expected: profile.runtimeVersion };
  });

  await check('typescript', async () => {
    const node = await createNode();
    const result = await processResult(await node.execute(`
      const { stripTypeScriptTypes } = require('node:module');
      const output = stripTypeScriptTypes('const answer: number = 42; answer', { mode: 'transform' });
      process.stdout.write(String(eval(output)));
    `));
    return { pass: result.code === 0 && result.stdout === '42', code: result.code, actual: result.stdout, expected: '42', stderr: result.stderr };
  });

  await check('npm-crossenv', async () => {
    const node = await createNode(npmFiles);
    const result = await processResult(await node.npm.run('crossenv'));
    const actual = result.code === 0 ? String(await node.fs.readFile('/node/crossenv.txt', 'utf8')) : '';
    return { pass: result.code === 0 && actual === 'production', code: result.code, actual, expected: 'production', stderr: result.stderr };
  });

  await check('http', async () => {
    const node = await createNode();
    const result = await processResult(await node.execute(`
      const http = require('node:http');
      const server = http.createServer((_request, response) => response.end('ok'));
      server.listen(38124, '127.0.0.1', () => {
        http.get('http://127.0.0.1:38124/parity', (response) => {
          let body = '';
          response.on('data', (chunk) => { body += chunk; });
          response.on('end', () => {
            process.stdout.write(response.statusCode + ':' + body);
            server.close();
          });
        });
      });
    `));
    return { pass: result.code === 0 && result.stdout === '200:ok', code: result.code, actual: result.stdout, expected: '200:ok', stderr: result.stderr };
  });

  await check('zlib', async () => {
    const node = await createNode();
    const result = await processResult(await node.execute(`
      const zlib = require('node:zlib');
      zlib.deflate('payload', (deflateError, compressed) => {
        if (deflateError) throw deflateError;
        zlib.inflate(compressed, (inflateError, output) => {
          if (inflateError) throw inflateError;
          process.stdout.write(output.toString());
        });
      });
    `));
    return { pass: result.code === 0 && result.stdout === 'payload', code: result.code, actual: result.stdout, expected: 'payload', stderr: result.stderr };
  });

  const hostMajor = Number(process.versions.node.split('.')[0]);
  const nativeReference = hostMajor === profile.major
    ? {
        status: process.versions.node === profile.referenceVersion
          && process.versions.modules === profile.versions.modules
          && process.versions.napi === profile.versions.napi ? 'pass' : 'semantic-drift',
        version: process.version,
        expectedVersion: profile.runtimeVersion,
        modules: process.versions.modules,
        napi: process.versions.napi,
      }
    : { status: 'not-run', reason: `host Node ${hostMajor} does not match ${profile.id}` };
  const status = checks.every((item) => item.status === 'pass') ? 'pass' : 'semantic-drift';
  return { profile: profile.id, referenceVersion: profile.referenceVersion, status, nativeReference, checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argument = process.argv.find((value) => value.startsWith('--node-version='));
  const report = await runVersionParity(argument?.slice('--node-version='.length) || 'lts');
  console.log(JSON.stringify(report));
  if (report.status !== 'pass') process.exitCode = 1;
}
