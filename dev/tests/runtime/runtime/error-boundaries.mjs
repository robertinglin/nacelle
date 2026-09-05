import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundaryStatus, createBoundaryContract, formatError, nativeAddonDisabledError,
  unsupportedBoundary, unsupportedNativeAddon, UnsupportedBrowserBoundaryError,
  UnsupportedWebCapabilityError,
} from '../../../../src/runtime/errors.js';

test('unsupported boundaries report the same reason in errors and capability contracts', () => {
  const contract = createBoundaryContract();
  assert.ok(Object.isFrozen(contract));
  for (const boundary of contract) {
    assert.ok(Object.isFrozen(boundary));
    assert.throws(() => unsupportedBoundary(boundary.name), error => {
      assert.ok(error instanceof UnsupportedBrowserBoundaryError);
      assert.equal(error.code, 'ERR_UNSUPPORTED_BROWSER_BOUNDARY');
      assert.equal(error.status, boundary.status);
      assert.equal(error.reason, boundary.reason);
      assert.ok(formatError(error).includes(boundary.reason));
      return true;
    });
  }
  assert.equal(new UnsupportedBrowserBoundaryError('unknown').reason, boundaryStatus('unknown').reason);
  assert.throws(() => unsupportedBoundary('custom', 'custom reason'), /custom reason/);
});

test('native addon errors distinguish unavailable support from explicitly disabled loading', () => {
  assert.throws(() => unsupportedNativeAddon('/node/addon.node'), error => {
    assert.equal(error.code, 'ERR_DLOPEN_FAILED');
    assert.equal(error.path, '/node/addon.node');
    assert.equal(error.boundary, 'native-addons');
    assert.match(formatError(error), /\/node\/addon.node/);
    return true;
  });
  const disabled = nativeAddonDisabledError();
  assert.equal(disabled.code, 'ERR_DLOPEN_DISABLED');
  assert.match(formatError(disabled), /loading addons is disabled/);
});

test('missing browser capabilities retain their reason in formatted errors', () => {
  const error = new UnsupportedWebCapabilityError('CompressionStream', 'format unavailable');
  assert.equal(error.code, 'ERR_UNSUPPORTED_WEB_CAPABILITY');
  assert.equal(error.status, 'unsupported-capability');
  assert.match(formatError(error), /CompressionStream.*format unavailable/);
});
