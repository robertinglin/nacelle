function isObject(value) {
  return value !== null && typeof value === 'object';
}

function isPlainObject(value) {
  return isObject(value) && !Array.isArray(value);
}

class Comparison {
  constructor(object, keys, actual) {
    for (const key of keys) {
      if (!(key in object)) continue;
      const expected = object[key];
      const value = actual?.[key];
      if (actual !== undefined && typeof value === 'string' && expected instanceof RegExp && expected.test(value)) {
        this[key] = value;
      } else {
        this[key] = expected;
      }
    }
  }
}

export { inspect, quote, indentMultiline, isObject, isPlainObject, Comparison, typeDescription };

function quote(value) {
  return `'${String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
    .replaceAll("'", "\\'")}'`;
}

function indentMultiline(value, amount) {
  return value.replaceAll('\n', `\n${' '.repeat(amount)}`);
}

function inspect(value, options = {}, state = { seen: new Map(), nextReference: 1 }) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'null';
    if (Object.is(value, -0)) return '-0';
    if (value === Infinity || value === -Infinity) return 'null';
    return String(value);
  }
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'symbol') return String(value);
  if (typeof value === 'function') return `[Function${value.name ? `: ${value.name}` : ' (anonymous)'}]`;
  if (value instanceof RegExp) return String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (value instanceof Error) {
    const label = value.name || 'Error';
    return `[${label}${value.message ? `: ${value.message}` : ''}]`;
  }

  if (Object.prototype.toString.call(value) === '[object Arguments]') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '[Arguments] {}';
    return `[Arguments] {\n${keys.map((key) => `  ${quote(key).replaceAll('\\\\', '\\\\')}: ${indentMultiline(inspect(value[key], options, state), 2)}`).join(',\n')}\n}`;
  }

  if (state.seen.has(value)) return `[Circular *${state.seen.get(value)}]`;
  const reference = state.nextReference++;
  state.seen.set(value, reference);

  if (value?.constructor?.name === 'TextEncoderStream') {
    return `TextEncoderStream {\n  encoding: 'utf-8',\n  readable: ReadableStream { locked: false, state: 'readable', supportsBYOB: false },\n  writable: WritableStream { locked: false, state: 'writable' }\n}`;
  }
  if (value?.constructor?.name === 'TextDecoderStream') {
    return `TextDecoderStream {\n  encoding: 'utf-8',\n  fatal: false,\n  ignoreBOM: false,\n  readable: ReadableStream { locked: false, state: 'readable', supportsBYOB: false },\n  writable: WritableStream { locked: false, state: 'writable' }\n}`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = [];
    for (let index = 0; index < value.length; index += 1) {
      items.push(`  ${Object.prototype.hasOwnProperty.call(value, index) ? indentMultiline(inspect(value[index], options, state), 2) : '<empty>'}`);
    }
    return `[\n${items.join(',\n')}\n]`;
  }
  if (value instanceof Map) {
    if (value.size === 0) return 'Map(0) {}';
    const entries = [...value].map(([key, entry]) => `  ${indentMultiline(inspect(key, options, state), 2)} => ${indentMultiline(inspect(entry, options, state), 2)}`);
    return `Map(${value.size}) {\n${entries.join(',\n')}\n}`;
  }
  if (value instanceof Set) {
    if (value.size === 0) return 'Set(0) {}';
    const entries = [...value].map((entry) => `  ${indentMultiline(inspect(entry, options, state), 2)}`);
    return `Set(${value.size}) {\n${entries.join(',\n')}\n}`;
  }

  const keys = Reflect.ownKeys(value)
    .sort((a, b) => String(a).localeCompare(String(b)));
  if (keys.length === 0) return '{}';
  const entries = keys.map((key) => {
    let entry;
    try {
      entry = value[key];
    } catch {
      entry = '<unavailable>';
    }
    const label = typeof key === 'symbol'
      ? `[${String(key)}]`
      : /^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key);
    return `  ${label}: ${indentMultiline(inspect(entry, options, state), 2)}`;
  });
  const prefix = reference > 1 ? `<ref *${reference}> ` : '';
  const label = value instanceof Comparison ? 'Comparison ' : '';
  return `${prefix}${label}{\n${entries.join(',\n')}\n}`;
}

function typeDescription(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  switch (typeof value) {
    case 'bigint': return `type bigint (${value}n)`;
    case 'number':
      if (Number.isNaN(value)) return 'type number (NaN)';
      if (value === Infinity || value === -Infinity) return 'type number (null)';
      if (Object.is(value, -0)) return 'type number (-0)';
      return `type number (${value})`;
    case 'boolean': return `type boolean (${value})`;
    case 'symbol': return `type symbol (${String(value)})`;
    case 'function': return `function ${value.name || ''}`;
    case 'string': {
      const short = value.length > 28 ? `${value.slice(0, 25)}...` : value;
      return `type string (${JSON.stringify(short)})`;
    }
    case 'object': {
      const constructorName = value.constructor?.name;
      return constructorName ? `an instance of ${constructorName}` : inspect(value, { depth: 0 });
    }
    default: return `type ${typeof value} (${inspect(value, { depth: 0 })})`;
  }
}

function invalidArgumentType(name, value, expected) {
  const error = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${typeDescription(value)}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function invalidArgumentValue(name, value, reason) {
  const error = new TypeError(`The argument '${name}' ${reason}. Received ${inspect(value, { depth: 0 })}`);
  error.code = 'ERR_INVALID_ARG_VALUE';
  return error;
}

function extractSourceExpression(sourceLine) {
  const call = sourceLine.match(/\b(?:[A-Za-z_$][\w$]*\.)?(?:ok|assert|strict)\s*\(/);
  if (!call) return undefined;
  const start = call.index;
  let depth = 0;
  let end = start;
  for (; end < sourceLine.length; end += 1) {
    const character = sourceLine[end];
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }
  return sourceLine.slice(start, end).replace(/[\u0000-\u001f\u007f]/g, (character) => {
    const code = character.codePointAt(0).toString(16).padStart(4, '0');
    return `\\u${code}`;
  });
}

function sourceExpression(readSource, sourcePath, value) {
  if (typeof readSource !== 'function') return undefined;
  const stack = new Error().stack || '';
  for (const line of stack.split('\n')) {
    const match = line.match(/(\/node\/[^):]+):(\d+):\d+/);
    if (!match) continue;
    let source;
    try {
      const rawSource = readSource(match[1]);
      source = typeof rawSource === 'string'
        ? rawSource
        : new TextDecoder().decode(rawSource);
    } catch {
      continue;
    }
    const sourceLine = source.split('\n')[Number(match[2]) - 1]?.trim();
    const expression = sourceLine ? extractSourceExpression(sourceLine) : undefined;
    if (expression) return expression;
  }
  if (!sourcePath) return undefined;
  try {
    const rawSource = readSource(sourcePath);
    const source = typeof rawSource === 'string' ? rawSource : new TextDecoder().decode(rawSource);
    const sourceLines = source.split('\n');
    const stackLineNumbers = [...stack.matchAll(/(\/node\/[^):]+):(\d+):\d+/g)]
      .map((match) => Number(match[2]))
      .reverse();
    for (const lineNumber of stackLineNumbers) {
      const expression = extractSourceExpression(sourceLines[lineNumber - 1]?.trim() || '');
      if (expression) return expression;
    }
    const lines = sourceLines.map((line) => line.trim());
    const candidates = lines.map(extractSourceExpression).filter(Boolean);
    const preferred = (value === null
      ? candidates.find((line) => line.includes('assert.ok(null)'))
      : value === 0
        ? candidates.find((line) => line.includes('assert.ok(0)'))
        : undefined)
      || candidates.find((line) => line.startsWith('strict.ok(') && line.endsWith('('))
      || candidates.find((line) => line.startsWith('strict.ok('))
      || candidates.find((line) => line.startsWith('assert('))
      || candidates[0];
    return preferred ? extractSourceExpression(preferred) : undefined;
  } catch {
    return undefined;
  }
}

function same(actual, expected, seen = new Map()) {
  if (Object.is(actual, expected)) return true;
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') return false;
  if (actual.constructor !== expected.constructor) return false;
  if (seen.get(actual) === expected) return true;
  seen.set(actual, expected);

  if (actual instanceof Date) return actual.getTime() === expected.getTime();
  if (actual instanceof RegExp) return String(actual) === String(expected);
  if (actual instanceof Map && expected instanceof Map) {
    return actual.size === expected.size && [...actual].every(([key, value]) => expected.has(key) && same(value, expected.get(key), seen));
  }
  if (actual instanceof Set && expected instanceof Set) {
    return actual.size === expected.size && [...actual].every((value) => expected.has(value));
  }
  if (ArrayBuffer.isView(actual) && ArrayBuffer.isView(expected)) {
    return actual.constructor === expected.constructor && actual.length === expected.length && actual.every((value, index) => same(value, expected[index], seen));
  }

  const actualKeys = Reflect.ownKeys(actual).filter((key) => Object.prototype.propertyIsEnumerable.call(actual, key));
  const expectedKeys = Reflect.ownKeys(expected).filter((key) => Object.prototype.propertyIsEnumerable.call(expected, key));
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key) => expectedKeys.includes(key) && same(actual[key], expected[key], seen));
}

function partialSame(actual, expected, seen = new Map()) {
  if (Object.is(actual, expected)) return true;
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') return false;
  if (actual.constructor !== expected.constructor) return false;
  if (seen.get(actual) === expected) return true;
  seen.set(actual, expected);

  if (actual instanceof Date) return actual.getTime() === expected.getTime();
  if (actual instanceof RegExp) return String(actual) === String(expected);

  if (actual instanceof Map && expected instanceof Map) {
    if (actual.size < expected.size) return false;
    const entries = [...actual];
    const used = new Set();
    return [...expected].every(([expectedKey, expectedValue]) => {
      for (let index = 0; index < entries.length; index += 1) {
        if (used.has(index)) continue;
        const candidateSeen = new Map(seen);
        const [actualKey, actualValue] = entries[index];
        if (partialSame(actualKey, expectedKey, candidateSeen)
          && partialSame(actualValue, expectedValue, candidateSeen)) {
          used.add(index);
          return true;
        }
      }
      return false;
    });
  }
  if (actual instanceof Set && expected instanceof Set) {
    if (actual.size < expected.size) return false;
    const values = [...actual];
    const used = new Set();
    return [...expected].every((expectedValue) => {
      for (let index = 0; index < values.length; index += 1) {
        if (used.has(index)) continue;
        const candidateSeen = new Map(seen);
        if (partialSame(values[index], expectedValue, candidateSeen)) {
          used.add(index);
          return true;
        }
      }
      return false;
    });
  }
  if (ArrayBuffer.isView(actual) && ArrayBuffer.isView(expected)) {
    if (actual.constructor !== expected.constructor || actual.byteLength < expected.byteLength) return false;
    const actualBytes = new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength);
    const expectedBytes = new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength);
    for (let start = 0; start <= actualBytes.length - expectedBytes.length; start += 1) {
      let matches = true;
      for (let offset = 0; offset < expectedBytes.length; offset += 1) {
        if (actualBytes[start + offset] !== expectedBytes[offset]) {
          matches = false;
          break;
        }
      }
      if (matches) return true;
    }
    return false;
  }
  if (actual instanceof ArrayBuffer && expected instanceof ArrayBuffer) {
    if (actual.byteLength < expected.byteLength) return false;
    const actualBytes = new Uint8Array(actual);
    const expectedBytes = new Uint8Array(expected);
    for (let start = 0; start <= actualBytes.length - expectedBytes.length; start += 1) {
      let matches = true;
      for (let offset = 0; offset < expectedBytes.length; offset += 1) {
        if (actualBytes[start + offset] !== expectedBytes[offset]) {
          matches = false;
          break;
        }
      }
      if (matches) return true;
    }
    return false;
  }

  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length < expected.length) return false;
    let actualIndex = 0;
    for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
      if (!Object.prototype.hasOwnProperty.call(expected, expectedIndex)) continue;
      let matched = false;
      for (; actualIndex < actual.length; actualIndex += 1) {
        if (!Object.prototype.hasOwnProperty.call(actual, actualIndex)) continue;
        const candidateSeen = new Map(seen);
        if (partialSame(actual[actualIndex], expected[expectedIndex], candidateSeen)) {
          seen.clear();
          for (const [key, value] of candidateSeen) seen.set(key, value);
          actualIndex += 1;
          matched = true;
          break;
        }
      }
      if (!matched) return false;
    }
    const expectedKeys = Reflect.ownKeys(expected)
      .filter((key) => key !== 'length' && !/^\d+$/.test(String(key))
        && Object.prototype.propertyIsEnumerable.call(expected, key));
    return expectedKeys.every((key) => Object.prototype.propertyIsEnumerable.call(actual, key)
      && partialSame(actual[key], expected[key], seen));
  }

  const expectedKeys = Reflect.ownKeys(expected)
    .filter((key) => Object.prototype.propertyIsEnumerable.call(expected, key));
  return expectedKeys.every((key) => Object.prototype.propertyIsEnumerable.call(actual, key)
    && partialSame(actual[key], expected[key], seen));
}

function diffLines(actual, expected) {
  const left = actual.split('\n');
  const right = expected.split('\n');
  const table = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      lines.push(`  ${left[i]}`);
      i += 1;
      j += 1;
    } else if (j >= right.length || (i < left.length && table[i + 1][j] >= table[i][j + 1])) {
      lines.push(`+ ${left[i++]}`);
    } else {
      lines.push(`- ${right[j++]}`);
    }
  }
  return lines.join('\n');
}

function strictDiff(actual, expected, operator, message) {
  const actualText = inspect(actual);
  const expectedText = inspect(expected);
  const title = operator === 'deepStrictEqual'
    ? 'Expected values to be strictly deep-equal:'
    : operator === 'partialDeepStrictEqual'
      ? 'Expected values to be partially and strictly deep-equal:'
      : 'Expected values to be strictly equal:';

  if (operator === 'strictEqual' && isObject(actual) && isObject(expected) && actualText === expectedText) {
    return `${message || 'Values have same structure but are not reference-equal:'}\n\n${actualText}\n`;
  }
  if (operator === 'strictEqual' && isObject(actual) && isObject(expected)) {
    const actualLines = actualText.split('\n');
    const expectedLines = expectedText.split('\n');
    if (actualLines.length === expectedLines.length && actualLines[0].endsWith('{') && expectedLines[0] === '{') {
      const actualIndent = actualLines[1]?.match(/^\s*/)?.[0].length || 0;
      const expectedIndent = expectedLines[1]?.match(/^\s*/)?.[0].length || 0;
      const delta = actualIndent - expectedIndent;
      if (delta > 0) {
        expectedLines.splice(1, expectedLines.length - 2, ...expectedLines.slice(1, -1).map((line) => `${' '.repeat(delta)}${line}`));
        expectedLines[expectedLines.length - 1] = `${' '.repeat(delta)}${expectedLines[expectedLines.length - 1]}`;
      }
    }
    return `${message || 'Expected "actual" to be reference-equal to "expected":'}\n+ actual - expected\n\n${diffLines(actualText, expectedLines.join('\n'))}\n`;
  }
  if (!actualText.includes('\n') && !expectedText.includes('\n')) {
    let body = `${actualText} !== ${expectedText}`;
    if (typeof actual === 'string' && typeof expected === 'string' && actual.length + expected.length <= 80) {
      let divergence = -1;
      for (let index = 0; index < Math.min(actual.length, expected.length); index += 1) {
        if (actual[index] !== expected[index]) {
          divergence = index;
          break;
        }
      }
      if (divergence >= 3) body += `\n${' '.repeat(divergence + 2)}^`;
    }
    return `${message || title}\n\n${body}\n`;
  }
  return `${message || title}\n+ actual - expected\n\n${diffLines(actualText, expectedText)}\n`;
}

function assertionMessage(actual, expected, operator, message, fallback) {
  if (message instanceof Error) throw message;
  if (operator === 'strictEqual' || operator === 'deepStrictEqual' || operator === 'partialDeepStrictEqual') {
    return strictDiff(actual, expected, operator, message);
  }
  if (message) return String(message);
  if (operator === 'notStrictEqual') {
    if (isObject(actual) || typeof actual === 'function') {
      const text = inspect(actual);
      return `Expected "actual" not to be reference-equal to "expected":${text.includes('\n') ? `\n\n${text}\n` : ` ${text}`}`;
    }
    return `Expected "actual" to be strictly unequal to: ${inspect(actual)}`;
  }
  if (operator === 'notDeepStrictEqual') return `Expected "actual" not to be strictly deep-equal to:\n\n${inspect(actual)}\n`;
  if (operator === 'equal') return `${inspect(actual)} != ${inspect(expected)}`;
  if (operator === 'notEqual') return `${inspect(actual)} == ${inspect(expected)}`;
  if (operator === 'deepEqual') return 'Expected values to be loosely deep-equal';
  if (operator === 'notDeepEqual') return 'Expected values not to be loosely deep-equal';
  return fallback || `Expected ${inspect(expected)} but got ${inspect(actual)}`;
}

function fail(message, actual, expected, operator, fallback, generatedMessage = undefined) {
  throw new AssertionError({
    message: assertionMessage(actual, expected, operator, message, fallback),
    actual,
    expected,
    operator,
    generatedMessage: generatedMessage ?? !message,
  });
}

export class AssertionError extends Error {
  constructor(options) {
    if (!isPlainObject(options)) throw invalidArgumentType('options', options, 'object');
    const message = options.message == null ? '' : String(options.message);
    super(message);
    this.name = 'AssertionError';
    this.code = 'ERR_ASSERTION';
    this.generatedMessage = options.generatedMessage ?? !options.message;
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = options.operator;
  }
}

function matcherResult(error, expected) {
  if (typeof expected === 'function') {
    if (expected.prototype !== undefined && error instanceof expected) return { matched: true };
    if (expected.prototype && expected.prototype instanceof Error) return { matched: false };
    const result = expected(error);
    return { matched: result === true, result };
  }
  if (expected instanceof RegExp) return { matched: expected.test(String(error)) };
  if (!isObject(error)) return { matched: false };
  const keys = Object.keys(expected);
  if (expected instanceof Error) keys.push('name', 'message');
  for (const key of keys) {
    if (!(key in Object(error))) return { matched: false, comparison: comparisonFor(error, expected, keys) };
    const expectedValue = expected[key];
    const actualValue = error[key];
    if (expectedValue instanceof RegExp) {
      if (typeof actualValue !== 'string' || !expectedValue.test(actualValue)) {
        return { matched: false, comparison: comparisonFor(error, expected, keys) };
      }
    } else if (key === 'constructor'
      && typeof actualValue === 'function'
      && typeof expectedValue === 'function'
      && actualValue.name === expectedValue.name) {
      continue;
    } else if (!same(actualValue, expectedValue)) {
      return { matched: false, comparison: comparisonFor(error, expected, keys) };
    }
  }
  return { matched: true };
}

function comparisonFor(error, expected, keys) {
  return {
    actual: new Comparison(error, keys),
    expected: new Comparison(expected, keys, error),
  };
}

function validateErrorExpectation(expected) {
  if (expected == null) return;
  if (typeof expected !== 'function' && typeof expected !== 'object') {
    throw invalidArgumentType('error', expected, 'function or an instance of Error, RegExp, or Object');
  }
  if (isPlainObject(expected) && !(expected instanceof RegExp) && !(expected instanceof Error) && Object.keys(expected).length === 0) {
    throw invalidArgumentValue('error', expected, 'may not be an empty object');
  }
}

function validateNoErrorExpectation(expected) {
  if (expected == null || typeof expected === 'string') return;
  if (typeof expected !== 'function' && !(expected instanceof RegExp)) {
    throw invalidArgumentType('expected', expected, 'function or an instance of RegExp');
  }
}

function normalizeErrorArguments(expected, message, argumentCount) {
  if (typeof expected === 'string') {
    if (argumentCount > 2) throw invalidArgumentType('error', expected, 'function or an instance of Error, RegExp, or Object');
    return { expected: undefined, message: expected, stringExpectation: expected };
  }
  return { expected, message, stringExpectation: undefined };
}

function ambiguousStringError(error, message) {
  const sameMessage = isObject(error) && error.message === message;
  const sameValue = !isObject(error) && error === message;
  if (!sameMessage && !sameValue) return;
  const detail = sameMessage
    ? `The error message "${error.message}" is identical to the message.`
    : `The error "${error}" is identical to the message.`;
  const result = new TypeError(`The "error/message" argument is ambiguous. ${detail}`);
  result.code = 'ERR_AMBIGUOUS_ARGUMENT';
  throw result;
}

function missingException(expected, message) {
  let detail = '';
  if (expected?.name) detail += ` (${expected.name})`;
  detail += message ? `: ${message}` : '.';
  return `Missing expected exception${detail}`;
}

function mismatchMessage(error, expected, message, match) {
  const objectExpectation = isObject(expected) && !(expected instanceof RegExp);
  if (message && !objectExpectation) return message;
  if (expected instanceof RegExp) return `The input did not match the regular expression ${inspect(expected)}. Input:\n\n${inspect(String(error))}\n`;
  if (typeof expected === 'function' && (expected === Error || (expected.prototype && expected.prototype instanceof Error))) {
    const name = expected.name || 'Error';
    const received = error instanceof Error
      ? (error.constructor?.name === name ? 'an error with identical name but a different prototype.' : `"${error.constructor?.name || error.name}"`)
      : `"${inspect(error, { depth: -1 })}"`;
    const detail = error instanceof Error && error.message ? `\n\nError message:\n\n${error.message}` : '';
    return `The error is expected to be an instance of "${name}". Received ${received}${detail}`;
  }
  if (typeof expected === 'function') return 'The validation function is expected to return "true".';
  const diff = match?.comparison
    ? strictDiff(match.comparison.actual, match.comparison.expected, 'deepStrictEqual')
    : strictDiff(error, expected, 'deepStrictEqual');
  if (!message) return diff;
  return `${message}\n${diff.slice(diff.indexOf('\n') + 1)}`;
}

function thrownValue(fn) {
  if (typeof fn !== 'function') throw invalidArgumentType('fn', fn, 'function');
  try {
    return { value: fn(), threw: false };
  } catch (error) {
    return { value: error, threw: true };
  }
}

function missingArguments() {
  const error = new TypeError('The "actual" and "expected" arguments must be specified');
  error.code = 'ERR_MISSING_ARGS';
  return error;
}

export function createAssert({ strict = false, readSource, sourcePath } = {}) {
  const assert = (value, message) => {
    if (!value) {
      const expression = sourceExpression(readSource, sourcePath, value);
      const fallback = value === undefined
        ? 'No value argument passed to `assert.ok()`'
        : `The expression evaluated to a falsy value${expression ? `:\n\n  ${expression}\n` : ''}`;
      fail(message, value, true, '==', fallback);
    }
  };
  assert.ok = assert;
  assert.fail = (message) => fail(message, undefined, undefined, 'fail', 'Assertion failed');

  function strictEqual(actual, expected, message) {
    if (arguments.length < 2) throw missingArguments();
    if (!Object.is(actual, expected)) fail(message, actual, expected, 'strictEqual');
  }
  function notStrictEqual(actual, expected, message) {
    if (arguments.length < 2) throw missingArguments();
    if (Object.is(actual, expected)) fail(message, actual, expected, 'notStrictEqual');
  }
  function deepStrictEqual(actual, expected, message) {
    if (arguments.length < 2) throw missingArguments();
    if (!same(actual, expected)) fail(message, actual, expected, 'deepStrictEqual');
  }
  function partialDeepStrictEqual(actual, expected, message) {
    if (arguments.length < 2) throw missingArguments();
    if (!partialSame(actual, expected)) fail(message, actual, expected, 'partialDeepStrictEqual');
  }
  function notDeepStrictEqual(actual, expected, message) {
    if (arguments.length < 2) throw missingArguments();
    if (same(actual, expected)) fail(message, actual, expected, 'notDeepStrictEqual');
  }
  function equal(actual, expected, message) {
    if (arguments.length < 2) throw missingArguments();
    if (!(actual == expected || (Number.isNaN(actual) && Number.isNaN(expected)))) fail(message, actual, expected, 'equal');
  }
  function notEqual(actual, expected, message) {
    if (arguments.length < 2) throw missingArguments();
    if (actual == expected || (Number.isNaN(actual) && Number.isNaN(expected))) fail(message, actual, expected, 'notEqual');
  }
  function deepEqual(actual, expected, message) {
    if (arguments.length < 2) throw missingArguments();
    if (!same(actual, expected)) fail(message, actual, expected, 'deepEqual');
  }
  function notDeepEqual(actual, expected, message) {
    if (arguments.length < 2) throw missingArguments();
    if (same(actual, expected)) fail(message, actual, expected, 'notDeepEqual');
  }

  assert.strictEqual = strictEqual;
  assert.notStrictEqual = notStrictEqual;
  assert.deepStrictEqual = deepStrictEqual;
  assert.partialDeepStrictEqual = partialDeepStrictEqual;
  assert.notDeepStrictEqual = notDeepStrictEqual;
  assert.equal = strict ? strictEqual : equal;
  assert.notEqual = strict ? notStrictEqual : notEqual;
  assert.deepEqual = strict ? deepStrictEqual : deepEqual;
  assert.notDeepEqual = strict ? notDeepStrictEqual : notDeepEqual;

  assert.throws = function throws(fn, expected, message) {
    const normalized = normalizeErrorArguments(expected, message, arguments.length);
    expected = normalized.expected;
    message = normalized.message;
    validateErrorExpectation(expected);
    const result = thrownValue(fn);
    if (!result.threw) fail(message, undefined, expected, 'throws', missingException(expected, message));
    if (normalized.stringExpectation !== undefined) ambiguousStringError(result.value, normalized.stringExpectation);
    const match = expected == null ? { matched: true } : matcherResult(result.value, expected);
    if (!match.matched) {
      const failureMessage = mismatchMessage(result.value, expected, message, match);
      const objectExpectation = isObject(expected) && !(expected instanceof RegExp);
      fail(message && objectExpectation ? failureMessage : message, result.value, expected, 'throws', failureMessage);
    }
    return result.value;
  };

  assert.doesNotThrow = function doesNotThrow(fn, expected, message) {
    const normalized = normalizeErrorArguments(expected, message, arguments.length);
    expected = normalized.expected;
    message = normalized.message;
    validateNoErrorExpectation(expected);
    const result = thrownValue(fn);
    if (!result.threw) return;
    if (expected == null || matcherResult(result.value, expected).matched) {
      fail(message, result.value, expected, 'doesNotThrow', `Got unwanted exception${message ? `: ${message}` : '.'}\nActual message: "${result.value?.message}"`);
    }
    throw result.value;
  };

  assert.rejects = async function rejects(promiseOrFn, expected, message) {
    const normalized = normalizeErrorArguments(expected, message, arguments.length);
    expected = normalized.expected;
    message = normalized.message;
    validateErrorExpectation(expected);
    let result;
    try {
      const promise = typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn;
      await promise;
    } catch (error) {
      result = error;
    }
    if (result === undefined) fail(message, undefined, expected, 'rejects', missingException(expected, message));
    const match = expected == null ? { matched: true } : matcherResult(result, expected);
    if (!match.matched) {
      const failureMessage = mismatchMessage(result, expected, message, match);
      const objectExpectation = isObject(expected) && !(expected instanceof RegExp);
      fail(message && objectExpectation ? failureMessage : message, result, expected, 'rejects', failureMessage);
    }
    return result;
  };

  assert.match = (actual, regexp, message) => {
    if (typeof actual !== 'string') throw invalidArgumentType('string', actual, 'string');
    if (!(regexp instanceof RegExp)) throw invalidArgumentType('regexp', regexp, 'an instance of RegExp');
    if (!regexp.test(actual)) fail(message, actual, regexp, 'match', `The input did not match the regular expression ${inspect(regexp)}. Input:\n\n${inspect(actual)}\n`);
  };
  assert.doesNotMatch = (actual, regexp, message) => {
    if (typeof actual !== 'string') throw invalidArgumentType('string', actual, 'string');
    if (!(regexp instanceof RegExp)) throw invalidArgumentType('regexp', regexp, 'an instance of RegExp');
    if (regexp.test(actual)) fail(message, actual, regexp, 'doesNotMatch', `The input was expected to not match the regular expression ${inspect(regexp)}. Input:\n\n${inspect(actual)}\n`);
  };

  assert.AssertionError = AssertionError;
  assert.strict = strict ? assert : createAssert({ strict: true, readSource, sourcePath });
  assert.ifError = (value) => {
    if (value) {
      const message = value instanceof Error ? value.message || String(value) : String(value);
      throw new AssertionError({
        message: message || `ifError got unwanted exception: ${inspect(value)}`,
        actual: value,
        expected: undefined,
        operator: 'ifError',
        generatedMessage: true,
      });
    }
  };
  return assert;
}
