function receivedValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'function') return 'function';
  if (typeof value === 'object') {
    return `an instance of ${value.constructor?.name || 'Object'}`;
  }
  return `type ${typeof value} (${String(value)})`;
}

function invalidArgumentType(name, expected, value) {
  const error = new TypeError(
    `The "${name}" argument must be of type ${expected}. Received ${receivedValue(value)}`,
  );
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function validateString(value, name) {
  if (typeof value !== 'string') throw invalidArgumentType(name, 'string', value);
}

function notInSingleExecutableApplicationError() {
  const error = new Error(
    'Operation cannot be invoked when not in a single-executable application',
  );
  error.code = 'ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION';
  return error;
}

function assetNotFoundError(key) {
  const error = new Error(`Cannot find asset ${key} for the single executable application`);
  error.code = 'ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND';
  return error;
}

export function createSeaModule({
  Blob,
  TextDecoder = globalThis.TextDecoder,
  isSea = () => false,
  getAsset: getAssetInternal = () => undefined,
  getAssetKeys: getAssetKeysInternal = () => undefined,
} = {}) {
  function getRawAsset(key) {
    validateString(key, 'key');

    if (!isSea()) throw notInSingleExecutableApplicationError();

    const asset = getAssetInternal(key);
    if (asset === undefined) throw assetNotFoundError(key);
    return asset;
  }

  function getAsset(key, encoding) {
    if (encoding !== undefined) validateString(encoding, 'encoding');
    const asset = getRawAsset(key);
    if (encoding === undefined) return ArrayBuffer.prototype.slice.call(asset);
    return new TextDecoder(encoding).decode(asset);
  }

  function getAssetAsBlob(key, options) {
    return new Blob([getRawAsset(key)], options);
  }

  function getAssetKeys() {
    if (!isSea()) throw notInSingleExecutableApplicationError();
    return getAssetKeysInternal() || [];
  }

  return Object.freeze({
    isSea,
    getAsset,
    getRawAsset,
    getAssetAsBlob,
    getAssetKeys,
  });
}
