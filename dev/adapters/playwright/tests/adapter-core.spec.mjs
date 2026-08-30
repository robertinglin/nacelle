import assert from 'node:assert/strict';
import { test } from 'playwright/test';

import {
  isTransientBrowserLaunchFailure,
  launchBrowser,
} from '../adapter-core.mjs';

function launchFailure(message) {
  return new Error(message);
}

test('classifies only Chromium sandbox SIGTRAP launches as transient', () => {
  const error = launchFailure(
    'sandbox_host_linux.cc:41: Check failed\nprocess did exit: signal=SIGTRAP',
  );

  assert.equal(isTransientBrowserLaunchFailure(error, 'chromium'), true);
  assert.equal(isTransientBrowserLaunchFailure(error, 'firefox'), false);
  assert.equal(
    isTransientBrowserLaunchFailure(launchFailure('process did exit: signal=SIGTRAP'), 'chromium'),
    false,
  );
});

test('retries a transient Chromium launch once and returns the recovered browser', async () => {
  let attempts = 0;
  const browser = { close: async () => {} };
  const browserType = {
    launch: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw launchFailure('sandbox_host_linux.cc:41; signal=SIGTRAP');
      }
      return browser;
    },
  };

  assert.equal(await launchBrowser(browserType, 'chromium', { retryDelayMs: 0 }), browser);
  assert.equal(attempts, 2);
});

test('does not retry unrelated launch failures', async () => {
  let attempts = 0;
  const failure = launchFailure('browser executable is missing');
  const browserType = {
    launch: async () => {
      attempts += 1;
      throw failure;
    },
  };

  await assert.rejects(
    launchBrowser(browserType, 'chromium', { retryDelayMs: 0 }),
    (error) => error === failure,
  );
  assert.equal(attempts, 1);
});

test('retains both launch diagnostics when the safe retry also fails', async () => {
  let attempts = 0;
  const browserType = {
    launch: async () => {
      attempts += 1;
      throw launchFailure(
        attempts === 1
          ? 'initial sandbox_host_linux.cc:41; signal=SIGTRAP'
          : 'retry sandbox_host_linux.cc:42; signal=SIGTRAP',
      );
    },
  };

  await assert.rejects(
    launchBrowser(browserType, 'chromium', { retryDelayMs: 0 }),
    (error) => (
      error.message.includes('initial launch error:')
      && error.message.includes('initial sandbox_host_linux.cc:41')
      && error.message.includes('retry launch error:')
      && error.message.includes('retry sandbox_host_linux.cc:42')
    ),
  );
  assert.equal(attempts, 2);
});
