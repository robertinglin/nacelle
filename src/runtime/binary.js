export function toUint8Array(value, TextEncoderClass = globalThis.TextEncoder) {
  if (typeof value === 'string') return new TextEncoderClass().encode(value);
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value !== null && typeof value === 'object'
    && ['[object ArrayBuffer]', '[object SharedArrayBuffer]'].includes(Object.prototype.toString.call(value))) {
    return new Uint8Array(value);
  }
  throw new TypeError('expected a string, ArrayBuffer, or typed-array view');
}

export function copyBytes(value, TextEncoderClass = globalThis.TextEncoder) {
  return new Uint8Array(toUint8Array(value, TextEncoderClass));
}

export function hex(value) {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function assertByteLength(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

export function allocateBytes(length, label = 'length') {
  assertByteLength(length, label);
  try {
    return new Uint8Array(length);
  } catch (error) {
    const allocationError = new RangeError('Array buffer allocation failed');
    allocationError.code = 'ERR_ARRAY_BUFFER_ALLOCATION_FAILED';
    allocationError.cause = error;
    throw allocationError;
  }
}
