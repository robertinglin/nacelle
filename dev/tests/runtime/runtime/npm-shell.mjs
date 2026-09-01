import assert from 'node:assert/strict';
import test from 'node:test';
import { Nacelle } from '../../../../src/index.js';
import { createShellProcess, runShellScript } from '../../../../src/runtime/shell.js';
import { parseShellScript } from '../../../../src/runtime/shell-parser.js';

function memoryShellFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const directories = new Set(['/']);
  for (const pathname of files.keys()) {
    const parts = pathname.split('/').filter(Boolean);
    for (let index = 1; index <= parts.length; index += 1) directories.add(`/${parts.slice(0, index).join('/')}`);
  }
  return {
    files,
    async stat(pathname) {
      if (files.has(pathname)) return { isFile: () => true, isDirectory: () => false };
      if (directories.has(pathname)) return { isFile: () => false, isDirectory: () => true };
      throw new Error('ENOENT');
    },
    async exists(pathname) { return files.has(pathname) || directories.has(pathname); },
    async readFile(pathname) {
      if (!files.has(pathname)) throw new Error('ENOENT');
      return files.get(pathname);
    },
    async writeFile(pathname, value) {
      files.set(pathname, String(value));
      const parts = pathname.split('/').filter(Boolean);
      for (let index = 1; index < parts.length; index += 1) directories.add(`/${parts.slice(0, index).join('/')}`);
    },
    async mkdir(pathname) { directories.add(pathname); },
    async readdir(pathname) {
      const prefix = pathname === '/' ? '/' : `${pathname}/`;
      return [...files.keys(), ...directories]
        .filter((entry) => entry.startsWith(prefix) && !entry.slice(prefix.length).includes('/'))
        .map((entry) => entry.slice(prefix.length));
    },
    async remove(pathname) { files.delete(pathname); directories.delete(pathname); },
    async copy(source, destination) { files.set(destination, files.get(source)); },
    async rename(source, destination) { files.set(destination, files.get(source)); files.delete(source); },
    async glob(pattern) {
      if (pattern === '*.txt') return ['a.txt', 'b.txt'];
      return [];
    },
  };
}

test('shell parser preserves conditional pipelines and redirections', () => {
  const script = parseShellScript('NODE_ENV=production tool build && cat *.txt | grep ok > result.txt 2>&1');
  assert.equal(script.length, 2);
  assert.equal(script[1].connector, '&&');
  assert.equal(script[1].commands.length, 2);
  assert.deepEqual(script[1].commands[1].redirects.map(({ operator }) => operator), ['>', '2>&1']);
});

test('shell executor handles environment, lookup, pipes, globs, and redirects', async () => {
  const fs = memoryShellFs({
    '/node/node_modules/.bin/tool': 'virtual tool',
    '/node/a.txt': 'ok\n',
    '/node/b.txt': 'no\n',
  });
  const output = [];
  const outcome = await runShellScript(
    'export MODE=production; MODE=$MODE tool build > result.txt; cat *.txt | grep ok',
    {
      cwd: '/node',
      env: { PATH: '/node/node_modules/.bin' },
      fs,
      onStdout: (value) => output.push(value),
      runCommand: async ({ entry, argv, env }) => ({
        code: entry.endsWith('/tool') && argv[0] === 'build' && env.MODE === 'production' ? 0 : 1,
        stdout: 'ok\n',
        stderr: '',
      }),
      runNode: async () => ({ code: 0, stdout: '', stderr: '' }),
    },
  );
  assert.equal(outcome.code, 0);
  assert.deepEqual(output, ['ok\n']);
  assert.equal(fs.files.get('/node/result.txt'), 'ok\n');
});

test('shell forwards nested output and honors redirected command errors', async () => {
  const fs = memoryShellFs();
  const output = [];
  const nested = await runShellScript("sh -c 'printf nested'", {
    cwd: '/node',
    env: {},
    fs,
    onStdout: (value) => output.push(value),
  });
  assert.equal(nested.code, 0);
  assert.deepEqual(output, ['nested']);

  output.length = 0;
  const recovered = await runShellScript('cat missing 2> errors.txt || echo recovered', {
    cwd: '/node',
    env: {},
    fs,
    onStdout: (value) => output.push(value),
  });
  assert.equal(recovered.code, 0);
  assert.deepEqual(output, ['recovered\n']);
  assert.equal(fs.files.get('/node/errors.txt'), 'cat: missing: No such file or directory\n');
});

test('bash exposes common file, process, and text commands', async () => {
  const node = await Nacelle.create({
    gateway: false,
    files: {
      '/node/source.txt': 'copy me\n',
      '/node/src/nested.txt': 'nested\n',
      '/node/src/other.js': 'javascript\n',
    },
  });
  const child = await node.bash(
    "mkdir -p work && cp -r src work && mv source.txt work/moved.txt && ls -la work | grep moved.txt && cat work/moved.txt && printf 'a:a\\na:a\\nb:b\\n' | cut -d: -f2 && printf 'a\\na\\nb\\n' | uniq -c && printf 'abc\\n' | tr a-z A-Z && printf 'tee\\n' | tee work/tee.txt >/dev/null && cat work/tee.txt && find . -type f -name '*.txt' | sort && printenv MODE && realpath work/moved.txt && ps",
    { env: { MODE: 'production' } },
  );
  assert.equal(await child.exit, 0);
  const stdout = await child.stdoutText();
  assert.match(stdout, /moved\.txt/);
  assert.match(stdout, /copy me/);
  assert.match(stdout, /a\na\nb/);
  assert.match(stdout, /\n      2 a\n      1 b\n/);
  assert.match(stdout, /\nABC\n/);
  assert.match(stdout, /\ntee\n/);
  assert.match(stdout, /\.\/work\/src\/nested\.txt/);
  assert.match(stdout, /\nproduction\n\/node\/work\/moved\.txt\n/);
  assert.match(stdout, /PID COMMAND/);
  assert.equal(await node.fs.readFile('/node/work/moved.txt'), 'copy me\n');
  assert.equal(await node.fs.readFile('/node/work/tee.txt'), 'tee\n');
});

test('npm scripts run through the shell compatibility layer', async () => {
  const hostProcess = globalThis.process;
  const hostConsole = globalThis.console;
  const hostAbortSignalAny = globalThis.AbortSignal?.any;
  const node = await Nacelle.create({
    gateway: false,
    files: {
      '/node/package.json': JSON.stringify({
        name: 'shell-fixture',
        version: '1.2.3',
        scripts: { build: 'NODE_ENV=production hello && NODE_ENV=production node build.js && node scripts/postbuild.js' },
      }),
      '/node/node_modules/.bin/hello': '#!/usr/bin/env node\nrequire(\'/node/bin-target.js\');\n',
      '/node/bin-target.js': "require('node:fs').writeFileSync('bin.txt', process.env.NODE_ENV);",
      '/node/build.js': "require('node:fs').writeFileSync('build.txt', process.env.NODE_ENV);",
      '/node/scripts/postbuild.js': "require('node:fs').writeFileSync('postbuild.txt', require('node:fs').readFileSync('build.txt', 'utf8') + ':' + process.env.npm_package_version);",
    },
  });
  const child = await node.npm.run('build');
  assert.equal(await child.exit, 0);
  assert.equal(await node.fs.readFile('/node/bin.txt'), 'production');
  assert.equal(await node.fs.readFile('/node/build.txt'), 'production');
  assert.equal(await node.fs.readFile('/node/postbuild.txt'), 'production:1.2.3');
  assert.strictEqual(globalThis.process, hostProcess);
  assert.strictEqual(globalThis.console, hostConsole);
  assert.strictEqual(globalThis.AbortSignal?.any, hostAbortSignalAny);
});

test('shell process kill waits for the running command to finish', async () => {
  const fs = memoryShellFs({ '/node/tool': '#!/usr/bin/env node\n' });
  let commandStarted;
  const commandStartedPromise = new Promise((resolve) => { commandStarted = resolve; });
  let commandFinished = false;
  const child = createShellProcess('tool', {
    cwd: '/node',
    env: { PATH: '/node' },
    fs,
    runCommand: ({ signal }) => new Promise((resolve) => {
      commandStarted();
      signal.addEventListener('abort', () => {
        commandFinished = true;
        resolve({ code: 130, stdout: '', stderr: '' });
      }, { once: true });
    }),
  });

  await commandStartedPromise;
  await child.kill();
  assert.equal(commandFinished, true);
  assert.equal(await child.exit, 130);
});

test('inline bash can orchestrate a TypeScript strip-and-run build', async () => {
  const node = await Nacelle.create({
    gateway: false,
    files: {
      '/node/package.json': JSON.stringify({
        name: 'typescript-fixture',
        version: '1.0.0',
        scripts: {
          build: "mkdir -p dist && node -e \"const fs = require('node:fs'); const { stripTypeScriptTypes } = require('node:module'); const source = fs.readFileSync('src/main.ts', 'utf8'); fs.writeFileSync('dist/main.js', stripTypeScriptTypes(source, { mode: 'transform' }));\" && cross-env NODE_ENV=production node dist/main.js",
        },
      }),
      '/node/node_modules/.bin/cross-env': '#!/usr/bin/env node\nrequire("../cross-env.js");\n',
      '/node/node_modules/cross-env.js': `const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const env = { ...process.env };
while (args[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])) {
  const separator = args[0].indexOf('=');
  env[args[0].slice(0, separator)] = args.shift().slice(separator + 1);
}
const child = spawnSync(args.shift(), args, { env, stdio: 'inherit' });
process.exitCode = child.status ?? 1;
`,
      '/node/src/main.ts': `interface User {
  name: string;
}

const user: User = { name: 'Ada' };
const greeting: string = 'Hello ' + user.name + ' from TypeScript';
require('node:fs').writeFileSync('dist/result.txt', process.env.NODE_ENV + ': ' + greeting);
`,
    },
  });

  const child = await node.bash('npm run build');
  assert.equal(await child.exit, 0);
  assert.match(String(await node.fs.readFile('/node/dist/main.js')), /Hello ' \+ user\.name/);
  assert.equal(await node.fs.readFile('/node/dist/result.txt'), 'production: Hello Ada from TypeScript');
});

test('inline bash can orchestrate TypeScript conversion through Vite transform', async () => {
  const viteTransformModule = `const fs = require('node:fs');
function transformTypeScript(source, id = 'src/main.ts') {
  let code = String(source);
  code = code.replace(/(?:export\\s+)?interface\\s+[A-Za-z_$][\\w$]*\\s*\\{[\\s\\S]*?\\}\\s*;?/g, '');
  code = code.replace(/(?:export\\s+)?type\\s+[A-Za-z_$][\\w$]*\\s*=\\s*[^;\\n]+;/g, '');
  code = code.replace(/:\\s*[A-Za-z_$][\\w$]*(?:<[^>\\n]+>)?(?=\\s*[,)=;{])/g, '');
  return \`// [vite:esbuild] Transformed \${id}\\n\${code.trim()}\\n\`;
}
module.exports = { transform: transformTypeScript };
`;

  const viteBin = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const vite = require('vite');
const args = process.argv.slice(2);
let entry = 'src/main.ts';
let out = 'dist/main.js';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--entry' && args[i + 1]) entry = args[++i];
  else if (args[i] === '--out' && args[i + 1]) out = args[++i];
}
const source = fs.readFileSync(entry, 'utf8');
const transformed = vite.transform(source, entry);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, transformed);
`;

  const node = await Nacelle.create({
    gateway: false,
    files: {
      '/node/package.json': JSON.stringify({
        name: 'vite-typescript-fixture',
        version: '1.0.0',
        scripts: {
          build: 'mkdir -p dist && vite build --entry src/main.ts --out dist/main.js && node dist/main.js',
        },
      }),
      '/node/node_modules/vite/package.json': JSON.stringify({ name: 'vite', version: '5.4.2', main: 'index.js' }),
      '/node/node_modules/vite/index.js': viteTransformModule,
      '/node/node_modules/vite/bin/vite.js': viteBin,
      '/node/node_modules/.bin/vite': '#!/usr/bin/env node\nrequire("../vite/bin/vite.js");\n',
      '/node/src/main.ts': `interface User {
  name: string;
}
const user: User = { name: 'Ada' };
const greeting: string = 'Hello ' + user.name + ' from Vite TypeScript';
require('node:fs').writeFileSync('dist/result.txt', greeting);
`,
    },
  });

  const child = await node.bash('npm run build');
  assert.equal(await child.exit, 0);
  assert.match(String(await node.fs.readFile('/node/dist/main.js')), /\[vite:esbuild\]/);
  assert.equal(await node.fs.readFile('/node/dist/result.txt'), 'Hello Ada from Vite TypeScript');
});

test('inline bash can orchestrate TypeScript conversion through actual TypeScript compiler from npm', async () => {
  const node = await Nacelle.create({
    gateway: false,
    cwd: '/node',
  });
  await node.npm.install('typescript@5.5.4');

  await node.fs.writeFile('/node/build.js', `
    const fs = require('node:fs');
    const ts = require('typescript');

    const source = fs.readFileSync('src/main.ts', 'utf8');
    const result = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    });

    fs.mkdirSync('dist', { recursive: true });
    fs.writeFileSync('dist/main.js', result.outputText);
    require('./dist/main.js');
  `);

  await node.fs.writeFile('/node/package.json', JSON.stringify({
    name: 'tsc-typescript-fixture',
    version: '1.0.0',
    scripts: {
      build: 'node build.js',
    },
  }));

  await node.fs.writeFile('/node/src/main.ts', `
    interface User {
      name: string;
    }
    const user: User = { name: 'Ada' };
    const greeting: string = 'Hello ' + user.name + ' from TypeScript';
    require('node:fs').writeFileSync('dist/result.txt', greeting);
  `);

  const child = await node.bash('npm run build');
  assert.equal(await child.exit, 0);
  assert.equal(await node.fs.readFile('/node/dist/result.txt'), 'Hello Ada from TypeScript');
});

test('inline bash can orchestrate full-stack React SSR server from npm', async () => {
  const node = await Nacelle.create({
    gateway: false,
    cwd: '/node',
  });
  await node.npm.install(['react@18.3.1', 'react-dom@18.3.1']);

  await node.fs.writeFile('/node/server.js', `
    const http = require('node:http');
    const React = require('react');
    const ReactDOMServer = require('react-dom/server');

    function App({ message }) {
      return React.createElement('h1', null, message);
    }

    const server = http.createServer((req, res) => {
      if (req.url === '/api/hello') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', framework: 'React SSR' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><html><body>' + ReactDOMServer.renderToString(React.createElement(App, { message: 'React SSR' })) + '</body></html>');
    });

    server.listen(3000, '127.0.0.1', () => console.log('ready'));
  `);

  await node.fs.writeFile('/node/package.json', JSON.stringify({
    name: 'react-ssr-fixture',
    version: '1.0.0',
    scripts: {
      dev: 'node server.js',
    },
  }));

  let readyResolve;
  const readyPromise = new Promise((r) => { readyResolve = r; });

  const devChild = await node.bash('npm run dev', {
    onStdout: (chunk) => {
      if (chunk.includes('ready')) readyResolve();
    },
  });

  await readyPromise;
  const res = await node.fetch('http://localhost:3000/api/hello');
  const data = await res.json();
  assert.equal(data.framework, 'React SSR');
  assert.equal(data.status, 'ok');
  devChild.kill();
  await devChild.exit;
});

test('npm scripts stream stdout chunks in real time before command exit', async () => {
  const node = await Nacelle.create({
    gateway: false,
    files: {
      '/node/package.json': JSON.stringify({
        name: 'stream-fixture',
        version: '1.0.0',
        scripts: { start: 'node server.js' },
      }),
      '/node/server.js': `
        process.stdout.write('server listening on 3000\\n');
      `,
    },
  });

  const streamed = [];
  const child = await node.npm.run('start', {
    onStdout: (chunk) => streamed.push(chunk),
  });
  await child.exit;
  assert.deepEqual(streamed, ['server listening on 3000\n']);
});
