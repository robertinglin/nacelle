# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/cluster-primary-exit.spec.mjs >> terminates cluster workers before the outer process exit event
- Location: ../home/robert/workspace/browser-node-harness/adapters/playwright/tests/cluster-primary-exit.spec.mjs:14:1

# Error details

```
Error: ERR_CAPABILITY_DENIED: path is outside the granted VFS mounts, open '/internal/crypto/webcrypto'
```

# Test source

```ts
  1   | import { EventEmitter } from './events.js';
  2   | import { Readable, Writable } from './streams.js';
  3   | import { resolveEncodingOps } from './buffer.js';
  4   | import { unsupportedNativeAddon } from './errors.js';
  5   | import { AsyncResource } from './async-hooks.js';
  6   | import { createGlob } from './fs-glob.js';
  7   | 
  8   | const textEncoder = new TextEncoder();
  9   | const READ_FILE_ASYNC_STAGES = 4;
  10  | 
  11  | function vfsError(code, path, operation, message = code) {
> 12  |   const error = new Error(`${code}: ${message}${path ? `, ${operation} '${path}'` : ''}`);
      |                 ^ Error: ERR_CAPABILITY_DENIED: path is outside the granted VFS mounts, open '/internal/crypto/webcrypto'
  13  |   error.code = code;
  14  |   if (path) error.path = path;
  15  |   if (operation) error.syscall = operation;
  16  |   const errno = {
  17  |     EEXIST: -17,
  18  |     EBADF: -9,
  19  |     EISDIR: -21,
  20  |     ELOOP: -40,
  21  |     ENOENT: -2,
  22  |     ENOTDIR: -20,
  23  |     ENOTEMPTY: -39,
  24  |   }[code];
  25  |   if (errno !== undefined) error.errno = errno;
  26  |   return error;
  27  | }
  28  | 
  29  | function invalidPath(message = 'path is not a valid logical POSIX path') {
  30  |   return vfsError('ERR_INVALID_PATH', undefined, undefined, message);
  31  | }
  32  | 
  33  | function denied(path, operation) {
  34  |   return vfsError('ERR_CAPABILITY_DENIED', path, operation, 'path is outside the granted VFS mounts');
  35  | }
  36  | 
  37  | function missing(path, operation = 'open') {
  38  |   return vfsError('ENOENT', path, operation, 'no such file or directory');
  39  | }
  40  | 
  41  | function existsError(path, operation = 'mkdir') {
  42  |   return vfsError('EEXIST', path, operation, 'file already exists');
  43  | }
  44  | 
  45  | function notDirectory(path, operation = 'access') {
  46  |   return vfsError('ENOTDIR', path, operation, 'not a directory');
  47  | }
  48  | 
  49  | function isDirectory(path, operation = 'open') {
  50  |   return vfsError('EISDIR', path, operation, 'is a directory');
  51  | }
  52  | 
  53  | function notEmpty(path, operation = 'rmdir') {
  54  |   return vfsError('ENOTEMPTY', path, operation, 'directory not empty');
  55  | }
  56  | 
  57  | function loop(path, operation = 'realpath') {
  58  |   return vfsError('ELOOP', path, operation, 'too many levels of symbolic links');
  59  | }
  60  | 
  61  | function invalidCopy(path, message) {
  62  |   return vfsError('EINVAL', path, 'cp', message);
  63  | }
  64  | 
  65  | function closedHandle() {
  66  |   return vfsError('EBADF', undefined, undefined, 'file handle is closed');
  67  | }
  68  | 
  69  | function outOfRange(name, value, minimum, maximum) {
  70  |   const error = new RangeError(
  71  |     minimum === undefined
  72  |       ? `The value of "${name}" is out of range. It must be an integer. Received ${String(value)}`
  73  |       : `The value of "${name}" is out of range. It must be >= ${minimum} && <= ${maximum}. Received ${String(value)}`,
  74  |   );
  75  |   error.code = 'ERR_OUT_OF_RANGE';
  76  |   return error;
  77  | }
  78  | 
  79  | function receivedArgumentValue(value) {
  80  |   if (value === null || value === undefined) return `Received ${value}`;
  81  |   if (typeof value === 'function') return `Received function ${value.name || ''}`.trimEnd();
  82  |   if (typeof value === 'object') return `Received an instance of ${value.constructor?.name || 'Object'}`;
  83  |   if (typeof value === 'string') {
  84  |     const inspected = `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
  85  |     return `Received type string (${inspected})`;
  86  |   }
  87  |   return `Received type ${typeof value} (${String(value)})`;
  88  | }
  89  | 
  90  | function invalidArgumentType(name, value, expected) {
  91  |   const error = new TypeError(`The "${name}" argument must be of type ${expected}. ${receivedArgumentValue(value)}`);
  92  |   error.code = 'ERR_INVALID_ARG_TYPE';
  93  |   return error;
  94  | }
  95  | 
  96  | function invalidArgumentValue(name, value, message = 'invalid value') {
  97  |   const error = new TypeError(`The "${name}" argument is invalid. ${message}. ${receivedArgumentValue(value)}`);
  98  |   error.code = 'ERR_INVALID_ARG_VALUE';
  99  |   return error;
  100 | }
  101 | 
  102 | function validatePathArgument(value, name = 'path') {
  103 |   if (typeof value === 'string' || value instanceof Uint8Array || isFileUrl(value)) return;
  104 |   throw invalidArgumentType(name, value, 'string or an instance of Buffer or URL');
  105 | }
  106 | 
  107 | function validateCallback(callback) {
  108 |   if (typeof callback !== 'function') throw invalidArgumentType('callback', callback, 'function');
  109 | }
  110 | 
  111 | function methodNotImplemented(name) {
  112 |   const error = new Error(`The ${name} method is not implemented`);
```