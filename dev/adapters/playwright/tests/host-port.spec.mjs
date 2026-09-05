import assert from 'node:assert/strict';
import { test } from 'playwright/test';
import {
  allocateHostPort,
  isHostPortAvailableForVirtualNetwork,
  VIRTUAL_TCP_PORT_MAX,
  VIRTUAL_TCP_PORT_MIN,
} from '../host-port.mjs';

test('keeps host adapter ports separate from guest virtual TCP ports', async () => {
  assert.equal(isHostPortAvailableForVirtualNetwork(VIRTUAL_TCP_PORT_MIN), false);
  assert.equal(isHostPortAvailableForVirtualNetwork(VIRTUAL_TCP_PORT_MAX), false);
  assert.equal(isHostPortAvailableForVirtualNetwork(VIRTUAL_TCP_PORT_MIN - 1), true);
  assert.equal(isHostPortAvailableForVirtualNetwork(VIRTUAL_TCP_PORT_MAX + 1), true);
  const port = await allocateHostPort();
  assert.equal(isHostPortAvailableForVirtualNetwork(port), true);
});
