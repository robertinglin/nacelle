import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test.describe('Node test loader host-only boundaries', () => {
  test('loads test-assert.js without traversing common/child_process.js', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert');
        const fs = require('node:fs');
        const marker = '__bnhChildProcessLoads';
        delete globalThis[marker];
        fs.mkdirSync('/node/test/common', { recursive: true });
        fs.mkdirSync('/node/test/parallel', { recursive: true });
        fs.writeFileSync('/node/test/common/child_process.js', [
          \"globalThis.__bnhChildProcessLoads = (globalThis.__bnhChildProcessLoads || 0) + 1;\",
          'module.exports = {',
          '  spawnSync() {',
          \"    const error = new Error('subprocesses are unavailable in the browser runtime');\",
          \"    error.code = 'ERR_UNSUPPORTED_BROWSER_BOUNDARY';\",
          \"    error.boundary = 'real-subprocesses';\",
          '    error.status = \\'unsupported-boundary\\';',
          '    throw error;',
          '  },',
          '};',
        ].join('\\n'));
        fs.writeFileSync('/node/test/common/index.js', [
          \"'use strict';\",
          \"const assert = require('node:assert');\",
          \"const http = require('node:http');\",
          'module.exports = {',
          '  assert,',
          \"  spawnSync: () => require('./child_process').spawnSync(),\",
          '  createServer: () => http.createServer(),',
          '};',
        ].join('\\n'));
        fs.writeFileSync('/node/test/parallel/test-assert.js', [
          \"'use strict';\",
          \"const common = require('../common');\",
          \"const assert = require('node:assert');\",
          'assert.strictEqual(common.assert, assert);',
          'assert.strictEqual(globalThis.__bnhChildProcessLoads || 0, 0);',
          'module.exports = { childProcessLoads: globalThis.__bnhChildProcessLoads || 0 };',
        ].join('\\n'));

        const loaded = require('/node/test/parallel/test-assert.js');
        assert.deepStrictEqual(loaded, { childProcessLoads: 0 });
        assert.strictEqual(globalThis[marker] || 0, 0);
        process.stdout.write('test-assert loaded without child_process recursion');
      })();
    `);

    await expectPass(expect, result);
    expect(result.stdout).toContain('without child_process recursion');
  });

  test('turns subprocess and raw-network calls into explicit browser boundary errors', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert');
        const fs = require('node:fs');
        fs.mkdirSync('/node/test/common', { recursive: true });
        fs.mkdirSync('/node/test/parallel', { recursive: true });
        fs.writeFileSync('/node/test/common/child_process.js', [
          'module.exports = {',
          '  spawnSync() {',
          \"    const error = new Error('subprocesses are unavailable in the browser runtime');\",
          \"    error.code = 'ERR_UNSUPPORTED_BROWSER_BOUNDARY';\",
          \"    error.boundary = 'real-subprocesses';\",
          '    error.status = \\'unsupported-boundary\\';',
          '    throw error;',
          '  },',
          '};',
        ].join('\\n'));
        fs.writeFileSync('/node/test/common/index.js', [
          \"const http = require('node:http');\",
          \"const childProcess = require('./child_process');\",
          'module.exports = {',
          '  spawnSync: childProcess.spawnSync,',
          '  createServer: http.createServer,',
          '};',
        ].join('\\n'));
        fs.writeFileSync('/node/test/parallel/test-assert.js', [
          \"const common = require('../common');\",
          'module.exports = common;',
        ].join('\\n'));

        const common = require('/node/test/parallel/test-assert.js');
        const boundary = (name) => (error) =>
          error.code === 'ERR_UNSUPPORTED_BROWSER_BOUNDARY'
          && error.boundary === name
          && error.status === 'unsupported-boundary';
        assert.throws(() => common.spawnSync(), boundary('real-subprocesses'));
        const server = common.createServer();
        assert.strictEqual(server.listening, false);
        assert.strictEqual(typeof server.listen, 'function');
        server.close();
        process.stdout.write('subprocess boundary is explicit and network is virtual');
      })();
    `);

    await expectPass(expect, result);
    expect(result.stdout).toContain('network is virtual');
  });
});
