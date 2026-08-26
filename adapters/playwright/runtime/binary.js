export function toUint8Array(value, TextEncoderClass = globalThis.TextEncoder) {
  if (typeof value === 'string') return new TextEncoderClass().encode(value);
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
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
