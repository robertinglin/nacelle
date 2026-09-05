import assert from 'node:assert/strict';
import test from 'node:test';
import { Nacelle } from '../../../../src/index.js';

test('Next.js can query npm registry synchronously without a config script', async () => {
  const node = await Nacelle.create({ gateway: false, files: {
    '/node/entry.cjs': `
      const { execSync } = require('child_process');
      const assert = require('assert/strict');
      const registry = execSync('npm config get registry --no-workspaces', {
        env: { ...process.env, NODE_OPTIONS: '' },
      });
      console.log(registry.toString().trim());
      assert.equal(execSync('npm config get registry --no-workspaces', {
        encoding: 'utf8', env: { npm_config_registry: 'https://registry.example.test' },
      }), 'https://registry.example.test/\\n');
      assert.equal(execSync('echo hello', { encoding: 'utf8' }), 'hello\\n');
      assert.equal(execSync('node probe', { encoding: 'utf8' }), 'NODE\\n');
    `,
    '/node/probe.js': 'console.log("NODE");',
  } });
  const child = await node.run({ entry: '/node/entry.cjs', timeout: 2500 });
  assert.equal(await child.exit, 0, await child.stderrText());
  assert.equal(await child.stdoutText(), 'https://registry.npmjs.org/\n');
});
