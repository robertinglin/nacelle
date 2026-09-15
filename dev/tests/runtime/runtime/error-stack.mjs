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

test('retries a structured capture when the constructor filter produces no frames', () => {
  function StructuredRetryError() {}
  StructuredRetryError.captureStackTrace = (target, constructorOpt) => {
    target.stack = constructorOpt ? [] : ['fallback-frame'];
  };

  assert.equal(installErrorStackCompatibility({ Error: StructuredRetryError }), false);
  const target = {};
  StructuredRetryError.captureStackTrace(target, () => {});
  assert.deepEqual(target.stack, ['fallback-frame']);
});

test('normalizes a structured capture when the browser materializes no stack', () => {
  function StructuredMissingStackError() {}
  let calls = 0;
  StructuredMissingStackError.captureStackTrace = (target) => {
    calls += 1;
    target.stack = calls === 1 ? [] : undefined;
  };

  assert.equal(installErrorStackCompatibility({ Error: StructuredMissingStackError }), false);
  const target = {};
  StructuredMissingStackError.captureStackTrace(target);
  assert.deepEqual(target.stack, []);
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

test('marks Firefox CommonJS export frames for caller-callsite compatibility', () => {
  function BrowserError() {}
  BrowserError.captureStackTrace = (target) => {
    Object.defineProperty(target, 'stack', {
      configurable: true,
      value: 'anonymous/</module.exports@/node_modules/example/index.js:6:24',
    });
  };

  installErrorStackCompatibility({ Error: BrowserError });
  const target = {};
  BrowserError.prepareStackTrace = (_error, callSites) => callSites;
  BrowserError.captureStackTrace(target);
  assert.equal(target.stack[0].getTypeName(), 'Object');
  assert.equal(target.stack[0].getFileName(), '/node_modules/example/index.js');
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

test('structured call sites accept consumer metadata', () => {
  function BrowserError() {}
  BrowserError.captureStackTrace = (target) => {
    Object.defineProperty(target, 'stack', {
      configurable: true,
      value: '@https://cdn.example/main.js:4:2',
    });
  };

  installErrorStackCompatibility({ Error: BrowserError });
  const target = {};
  BrowserError.prepareStackTrace = (_error, callSites) => callSites;
  BrowserError.captureStackTrace(target);
  target.stack[0].cwd = '/node';
  assert.equal(target.stack[0].cwd, '/node');
});

test('structured call sites remain extensible when the browser freezes them', () => {
  function BrowserError() {}
  const frozenSite = Object.freeze({
    getFileName: () => '/node/main.js',
    getLineNumber: () => 4,
    getColumnNumber: () => 2,
  });
  BrowserError.captureStackTrace = (target) => {
    target.stack = BrowserError.prepareStackTrace?.(target, [frozenSite]) || 'native';
  };

  installErrorStackCompatibility({ Error: BrowserError });
  const target = {};
  BrowserError.prepareStackTrace = (_error, callSites) => callSites;
  BrowserError.captureStackTrace(target);
  target.stack[0].cwd = '/node';
  assert.equal(target.stack[0].getFileName(), '/node/main.js');
  assert.equal(target.stack[0].cwd, '/node');
});

test('leaves constructors without captureStackTrace untouched', () => {
  function PlainError() {}
  assert.equal(installErrorStackCompatibility({ Error: PlainError }), false);
});
