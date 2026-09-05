import assert from 'node:assert/strict';
import test from 'node:test';
import { formatError } from '../../../../src/runtime/errors.js';

test('retains error names and messages when browser stacks contain only frames', () => {
  assert.equal(formatError({
    name: 'SyntaxError', message: 'invalid JavaScript', stack: 'compile@runtime.js:10:2',
  }), 'SyntaxError: invalid JavaScript\ncompile@runtime.js:10:2');
});

test('preserves stacks that already contain the message without duplicating it', () => {
  const stack = 'Error: Cannot find module\n    at resolve (runtime.js:10:2)';
  assert.equal(formatError({ name: 'Error', message: 'Cannot find module', stack }), stack);
});

test('formats thrown values and errors without stacks', () => {
  assert.equal(formatError('failure'), 'failure');
  assert.equal(formatError(null), 'null');
  assert.equal(formatError({ message: 'failure' }), 'failure');
  assert.equal(formatError({ message: '', stack: 'frame@runtime.js:1:1' }), 'frame@runtime.js:1:1');
});
