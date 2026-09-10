import assert from 'node:assert/strict';
import test from 'node:test';
import { createInspectorModule } from '../../../../src/runtime/inspector.js';

test('Profiler.takePreciseCoverage returns a coverage result array', async () => {
  const warnings = [];
  const processObject = {
    execArgv: [],
    nextTick: (callback, ...args) => queueMicrotask(() => callback(...args)),
    emitWarning: (warning) => warnings.push(warning),
  };
  const inspector = createInspectorModule({ processObject });
  const session = new inspector.Session();

  session.connect();
  const coverage = await new Promise((resolve, reject) => {
    session.post('Profiler.takePreciseCoverage', (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });

  assert.deepEqual(coverage, { result: [] });
  assert.deepEqual(warnings, []);
  session.disconnect();
});
