export function formatError(error) {
  const message = error?.message == null ? String(error) : String(error.message);
  const stack = typeof error?.stack === 'string' ? error.stack : '';
  if (!stack) return message;
  if (!message || stack.includes(message)) return stack;
  return `${error?.name || 'Error'}: ${message}\n${stack}`;
}

const BOUNDARY_REASONS = Object.freeze({
  'native-addons': 'requires a browser-safe WASM or JavaScript adapter',
  'privileged-os-apis': 'requires explicit browser permission and adapter scope',
  'real-subprocesses': 'must not proxy execution to a host process',
  'raw-host-networking': 'raw sockets and host-network access are outside the browser capability model',
});

export class UnsupportedBrowserBoundaryError extends Error {
  constructor(name, reason = boundaryReason(name)) {
    super(`${name} is an unsupported browser boundary: ${reason}`);
    this.name = 'UnsupportedBrowserBoundaryError';
    this.code = 'ERR_UNSUPPORTED_BROWSER_BOUNDARY';
    this.boundary = name;
    this.status = 'unsupported-boundary';
    this.reason = reason;
  }
}

export class UnsupportedNativeAddonError extends Error {
  constructor(path) {
    super(`Cannot load native addon '${path}': native addons are unavailable in the browser runtime`);
    this.name = 'Error';
    this.code = 'ERR_DLOPEN_FAILED';
    this.path = path;
    this.boundary = 'native-addons';
    this.status = 'unsupported-boundary';
    this.reason = boundaryReason('native-addons');
  }
}

export function nativeAddonDisabledError() {
  const error = new Error('Cannot load native addon because loading addons is disabled.');
  error.code = 'ERR_DLOPEN_DISABLED';
  return error;
}

export class UnsupportedWebCapabilityError extends Error {
  constructor(capability, reason) {
    super(`${capability} is unavailable in this browser: ${reason}`);
    this.name = 'UnsupportedWebCapabilityError';
    this.code = 'ERR_UNSUPPORTED_WEB_CAPABILITY';
    this.capability = capability;
    this.status = 'unsupported-capability';
    this.reason = reason;
  }
}

export function boundaryReason(name) {
  return BOUNDARY_REASONS[name] ?? 'requires an explicit browser adapter';
}

export function boundaryStatus(name, reason = boundaryReason(name)) {
  return Object.freeze({ name, status: 'unsupported-boundary', reason });
}

export function unsupportedBoundary(name, reason = boundaryReason(name)) {
  throw new UnsupportedBrowserBoundaryError(name, reason);
}

export function unsupportedNativeAddon(path) {
  throw new UnsupportedNativeAddonError(path);
}

export function createBoundaryContract() {
  return Object.freeze(Object.keys(BOUNDARY_REASONS).map((name) => boundaryStatus(name)));
}
