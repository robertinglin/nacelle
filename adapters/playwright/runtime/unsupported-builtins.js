import { unsupportedBoundary } from './errors.js';
import { createBrowserDgram } from './dgram.js';
import { createBrowserDns } from './dns.js';
import { createBrowserNet } from './net.js';
import { createCluster } from './cluster.js';
import { createTlsModule } from './tls.js';
import { createVirtualNetwork } from './virtual-network.js';

function unsupportedMethod(moduleName, memberName, boundary = 'raw-host-networking') {
  return function unsupportedBrowserBuiltinMethod() {
    unsupportedBoundary(
      boundary,
      `${moduleName}.${memberName} requires a browser capability that was not assembled`,
    );
  };
}

function unsupportedMembers(moduleName, names, boundary) {
  return Object.fromEntries(names.map((name) => [name, unsupportedMethod(moduleName, name, boundary)]));
}

function createUnsupportedBuiltin(moduleName, names, values = {}, boundary) {
  return Object.freeze({ ...unsupportedMembers(moduleName, names, boundary), ...values });
}

function createVirtualChildProcessFallback() {
  return createUnsupportedBuiltin('child_process', [
    'exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync',
  ], {
    ChildProcess: unsupportedMethod('child_process', 'ChildProcess', 'real-subprocesses'),
    constants: Object.freeze({}),
    promises: createUnsupportedBuiltin('child_process.promises', [
      'exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn',
    ], {}, 'real-subprocesses'),
  }, 'real-subprocesses');
}

/**
 * Build compatibility modules for callers that have not assembled a full runtime.
 * Network, TLS, UDP, and cluster are virtual by default; only real subprocess
 * methods remain an explicit boundary until a caller supplies a process layer.
 */
export function createUnsupportedBuiltins({
  childProcess: childProcessOverride,
  network = createVirtualNetwork(),
  dns = createBrowserDns(),
  proxy,
  BufferClass,
  cluster: clusterOverride,
  tls: tlsOverride,
} = {}) {
  const net = createBrowserNet({ network, dns, BufferClass });
  const dgram = createBrowserDgram({ network, BufferClass });
  const cluster = clusterOverride || createCluster();
  const tls = tlsOverride || createTlsModule(globalThis, { net, BufferClass, proxy });
  return Object.freeze({
    child_process: childProcessOverride || createVirtualChildProcessFallback(),
    net,
    cluster,
    tls,
    dgram,
  });
}
