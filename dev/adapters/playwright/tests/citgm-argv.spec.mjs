import assert from 'node:assert/strict';
import test from 'node:test';
import { createCitgmProcessArgv } from '../citgm-argv.mjs';

test('keeps the CITGM module positional before value-taking options', () => {
  assert.deepEqual(
    createCitgmProcessArgv('/node/node_modules/citgm/bin/citgm.js', 'example', ['--verbose']),
    ['node', '/node/node_modules/citgm/bin/citgm.js', 'example', '--verbose'],
  );
});

test('preserves option order and values without rewriting them', () => {
  const args = ['--run', 'test', '-v', 'verbose', '--custom=value'];
  assert.deepEqual(
    createCitgmProcessArgv('/node/citgm.js', 'consumer', args),
    ['node', '/node/citgm.js', 'consumer', ...args],
  );
});
