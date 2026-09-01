import assert from 'node:assert/strict';
import test from 'node:test';
import { installErrorStackCompatibility } from '../../../../src/runtime/error-stack.js';

test('does not replace a captureStackTrace implementation with structured output', () => {
  function StructuredError() {}
  StructuredError.captureStackTrace = (target) => {
    target.stack = StructuredError.prepareStackTrace?.(target, []) || 'native';
  };

  assert.equal(installErrorStackCompatibility({ Error: StructuredError }), false);
  const target = {};
  StructuredError.captureStackTrace(target);
  assert.equal(target.stack, 'native');
});

test('adds V8 CallSite output when captureStackTrace ignores prepareStackTrace', () => {
  function BrowserError() {}
  BrowserError.captureStackTrace = (target, constructorOpt) => {
    assert.equal(constructorOpt, BrowserError);
    Object.defineProperty(target, 'stack', {
      configurable: true,
      value: [
        'Error',
        'depd@https://cdn.example/send.js:9:2391',
        '@/node_modules/next/index.js:12:4',
        'at startServer (/node/start-server.js:21:8)',
        'at /node/boot.js:3:1',
      ].join('\n'),
    });
  };

  const scope = { Error: BrowserError };
  assert.equal(installErrorStackCompatibility(scope), true);
  assert.equal(installErrorStackCompatibility(scope), false);

  const target = { name: 'Error', message: 'boom' };
  const originalPrepare = BrowserError.prepareStackTrace;
  BrowserError.prepareStackTrace = (error, callSites) => {
    assert.equal(error, target);
    return callSites;
  };
  BrowserError.captureStackTrace(target, BrowserError);
  const callSites = target.stack;
  BrowserError.prepareStackTrace = originalPrepare;

  assert.equal(callSites.length, 4);
  assert.equal(callSites[0].getFileName(), 'https://cdn.example/send.js');
  assert.equal(callSites[0].getLineNumber(), 9);
  assert.equal(callSites[0].getColumnNumber(), 2391);
  assert.equal(callSites[0].getFunctionName(), 'depd');
  assert.equal(callSites[1].getFileName(), '/node_modules/next/index.js');
  assert.equal(callSites[1].getFunctionName(), null);
  assert.equal(callSites[2].getFileName(), '/node/start-server.js');
  assert.equal(callSites[2].getFunctionName(), 'startServer');
  assert.equal(callSites[3].getFunctionName(), null);
  assert.equal(callSites[0].getTypeName(), null);
  assert.equal(callSites[0].getMethodName(), null);
  assert.equal(callSites[0].getEvalOrigin(), undefined);
  assert.equal(callSites[0].isToplevel(), false);
  assert.equal(callSites[0].isEval(), false);
  assert.equal(callSites[0].isNative(), false);
  assert.equal(callSites[0].isConstructor(), false);
  assert.equal(callSites[0].isAsync(), false);
  assert.equal(callSites[0].getThis(), undefined);
  assert.equal(callSites[0].toString(), 'depd@https://cdn.example/send.js:9:2391');
});

test('formats a captured stack when no custom formatter is installed', () => {
  function BrowserError() {}
  BrowserError.captureStackTrace = (target) => {
    Object.defineProperty(target, 'stack', {
      configurable: true,
      value: '@https://cdn.example/main.js:4:2',
    });
  };

  installErrorStackCompatibility({ Error: BrowserError });
  const target = { name: 'TypeError', message: 'bad input' };
  BrowserError.captureStackTrace(target);
  assert.match(target.stack, /^TypeError: bad input\n\s+at @https:\/\/cdn\.example\/main\.js:4:2$/);
});

test('leaves constructors without captureStackTrace untouched', () => {
  function PlainError() {}
  assert.equal(installErrorStackCompatibility({ Error: PlainError }), false);
});
