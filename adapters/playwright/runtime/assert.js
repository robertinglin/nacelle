import { CallTracker } from './call-tracker.js';

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function isPlainObject(value) {
  return isObject(value) && !Array.isArray(value);
}

function isArrayIndexKey(key) {
  if (typeof key !== 'string' || key === '') return false;
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 0xffffffff && String(index) === key;
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

const inspectCustomSymbol = Symbol.for('nodejs.util.inspect.custom');
const cryptoKeyMaterialMarker = Symbol.for('bnh.cryptoKeyMaterial');
const typedArrayTagGetter = typeof Uint8Array === 'function'
  ? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get
  : undefined;
const boxedPrimitiveTags = new Set([
  '[object Boolean]',
  '[object Number]',
  '[object String]',
  '[object Symbol]',
  '[object BigInt]',
]);

const wellKnownConstructors = new Set([
  Array,
  ArrayBuffer,
  BigInt,
  BigInt64Array,
  BigUint64Array,
  Boolean,
  DataView,
  Date,
  Error,
  Float32Array,
  Float64Array,
  Function,
  Int8Array,
  Int16Array,
  Int32Array,
  Map,
  Number,
  Object,
  Promise,
  RegExp,
  Set,
  String,
  Symbol,
  Uint8Array,
  Uint8ClampedArray,
  Uint16Array,
  Uint32Array,
  WeakMap,
  WeakSet,
]);

if (typeof Float16Array === 'function') wellKnownConstructors.add(Float16Array);

function compareStrictPrototype(actual, expected) {
  const actualConstructor = actual.constructor;
  if (wellKnownConstructors.has(actualConstructor)
    || (actualConstructor !== undefined
      && !Object.prototype.hasOwnProperty.call(actual, 'constructor'))) {
    return actualConstructor === expected.constructor;
  }
  return Object.getPrototypeOf(actual) === Object.getPrototypeOf(expected);
}

function cryptoKeyMaterial(value) {
  if (value[cryptoKeyMaterialMarker] !== undefined) return value[cryptoKeyMaterialMarker];
  const symbol = Reflect.ownKeys(value).find((key) => String(key) === 'Symbol(kKeyObject)');
  return symbol === undefined ? undefined : value[symbol];
}

function intrinsicTypedArrayTag(value) {
  try {
    return typedArrayTagGetter?.call(value);
  } catch {
    return undefined;
  }
}

function intrinsicBoxedPrimitiveValue(value, tag) {
  switch (tag) {
    case '[object Boolean]': return Boolean.prototype.valueOf.call(value);
    case '[object Number]': return Number.prototype.valueOf.call(value);
    case '[object String]': return String.prototype.valueOf.call(value);
    case '[object Symbol]': return Symbol.prototype.valueOf.call(value);
    case '[object BigInt]': return BigInt.prototype.valueOf.call(value);
    default: return undefined;
  }
}

export { inspect, quote, indentMultiline, isObject, isPlainObject, Comparison, typeDescription };

function quote(value) {
  const text = String(value);
  const quoteMark = text.includes("'") && !text.includes('"') ? '"' : "'";
  return `${quoteMark}${text
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
    .replaceAll(quoteMark, `\\${quoteMark}`)}${quoteMark}`;
}

function inspectString(value, options) {
  const quoted = quote(value);
  if (options.compact !== false || !value.includes('\n') || quoted.length <= 80) return quoted;
  const lines = value.split('\n');
  const terminated = lines.at(-1) === '';
  if (terminated) lines.pop();
  return lines.map((line, index) => {
    const hasFollowingLine = index < lines.length - 1;
    const chunk = quote(`${line}${hasFollowingLine || (terminated && index === lines.length - 1) ? '\n' : ''}`);
    return `${index === 0 ? chunk : `  ${chunk}`}${hasFollowingLine ? ' +' : ''}`;
  }).join('\n');
}

function inspectEnumerableProperties(value, options, state) {
  const keys = Reflect.ownKeys(value)
    .filter((key) => Object.prototype.propertyIsEnumerable.call(value, key))
    .sort((a, b) => String(a).localeCompare(String(b)));
  if (keys.length === 0) return '';
  const entries = keys.map((key) => `  ${propertyLabel(key)}: ${indentMultiline(inspect(value[key], options, state), 2)}`);
  return `{\n${entries.join(',\n')}\n}`;
}

function propertyLabel(key) {
  return typeof key === 'symbol'
    ? `[${String(key)}]`
    : /^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key);
}

function indentMultiline(value, amount) {
  return value.replaceAll('\n', `\n${' '.repeat(amount)}`);
}

function inspect(value, options = {}, state = { seen: new Map(), nextReference: 1 }) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return inspectString(value, options);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (Object.is(value, -0)) return '-0';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    return String(value);
  }
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'symbol') return String(value);
  if (typeof value === 'function') return `[Function${value.name ? `: ${value.name}` : ' (anonymous)'}]`;
  if (options.depth === -1) {
    if (Array.isArray(value)) return '[Array]';
    return `[${value.constructor?.name || 'Object'}]`;
  }
  if (options.customInspect !== false) {
    const customInspect = value?.[inspectCustomSymbol];
    if (typeof customInspect === 'function' && customInspect !== inspect) {
      const result = customInspect.call(value, options.depth ?? 2, options, inspect);
      if (result !== value) return typeof result === 'string' ? result : inspect(result, options, state);
    }
  }
  if (value instanceof RegExp) {
    try {
      const base = String(value);
      const extra = inspectEnumerableProperties(value, options, state);
      const prefix = value.constructor?.name && value.constructor.name !== 'RegExp'
        ? `${value.constructor.name} ` : '';
      return `${prefix}${base}${extra ? ` ${extra}` : ''}`;
    } catch {
      return 'RegExp {}';
    }
  }
  if (value instanceof Date) {
    try {
      const time = Date.prototype.getTime.call(value);
      const base = Number.isNaN(time) ? 'Invalid Date' : Date.prototype.toISOString.call(value);
      const extra = inspectEnumerableProperties(value, options, state);
      const prefix = value.constructor?.name && value.constructor.name !== 'Date'
        ? `${value.constructor.name} ` : '';
      return `${prefix}${base}${extra ? ` ${extra}` : ''}`;
    } catch {
      return 'Date {}';
    }
  }
  if (value instanceof Error) {
    const label = value.name || 'Error';
    if (label === 'AssertionError' && ('actual' in value || 'expected' in value)) {
      const propertyNames = ['generatedMessage', 'code', 'actual', 'expected', 'operator'];
      const propertyText = propertyNames
        .filter((key) => Object.prototype.hasOwnProperty.call(value, key))
        .map((key) => {
          const propertyValue = value[key];
          let inspected;
          if (typeof propertyValue === 'string' && propertyValue.includes('\n')) {
            const lines = propertyValue.split('\n');
            const truncated = lines.length > 11 ? `${lines.slice(0, 10).join('\n')}\n...` : propertyValue;
            inspected = inspectString(truncated, { ...options, compact: false });
            inspected = inspected.split('\n').map((line, index) => index === 0 ? line : `  ${line}`).join('\n');
          } else if (typeof propertyValue === 'string' && propertyValue.length > 9_488) {
            inspected = quote(`${propertyValue.slice(0, 9_488)}...`);
          } else if (typeof propertyValue === 'string' && propertyValue.length > 512) {
            inspected = quote(`${propertyValue.slice(0, 488)}...`);
          } else if (Array.isArray(propertyValue)) {
            inspected = '[Array]';
          } else {
            inspected = inspect(propertyValue, options, state);
          }
          return `  ${key}: ${inspected}`;
        })
        .join(',\n');
      return `[${label}${value.message ? `: ${value.message}` : ''}] {\n${propertyText}\n}`;
    }
    const keys = Reflect.ownKeys(value)
      .filter((key) => Object.prototype.propertyIsEnumerable.call(value, key))
      .sort((a, b) => String(a).localeCompare(String(b)));
    if (keys.length === 0) return `[${label}${value.message ? `: ${value.message}` : ''}]`;
    const entries = keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && (descriptor.get || descriptor.set)) {
        const accessor = descriptor.get && descriptor.set ? 'Getter/Setter' : descriptor.get ? 'Getter' : 'Setter';
        if (options.getters !== true || !descriptor.get) return `  ${propertyLabel(key)}: [${accessor}]`;
        return `  ${propertyLabel(key)}: [Getter: ${indentMultiline(inspect(value[key], options, state), 2)}]`;
      }
      return `  ${propertyLabel(key)}: ${indentMultiline(inspect(value[key], options, state), 2)}`;
    });
    return `[${label}${value.message ? `: ${value.message}` : ''}] {\n${entries.join(',\n')}\n}`;
  }

  if (value?.constructor?.name === 'AbortController' && value.signal) {
    if (options.depth === null) return 'AbortController { signal: AbortSignal { aborted: false } }';
    return 'AbortController { signal: [AbortSignal] }';
  }
  if (value?.constructor?.name === 'AbortSignal' && typeof value.aborted === 'boolean') {
    return `AbortSignal { aborted: ${value.aborted} }`;
  }

  if (options.customInspect === false && Object.prototype.toString.call(value) === '[object URL]') {
    return String(value);
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
    const rendered = `[\n${items.join(',\n')}\n]`;
    return rendered.includes(`[Circular *${reference}]`)
      ? `<ref *${reference}> ${rendered}`
      : rendered;
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const isBuffer = value.constructor?.name === 'Buffer';
    const name = isBuffer ? `Buffer(${value.length}) [Uint8Array]` : `${value.constructor?.name || 'TypedArray'}(${value.length})`;
    const items = Array.from(value, (item) => `  ${inspect(item, options, state)}`);
    const keys = Reflect.ownKeys(value).filter((key) => {
      if (typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key)) return false;
      return Object.getOwnPropertyDescriptor(value, key)?.enumerable === true;
    });
    for (const key of keys) {
      items.push(`  ${propertyLabel(key)}: ${indentMultiline(inspect(value[key], options, state), 2)}`);
    }
    return `${name} [${items.length ? `\n${items.join(',\n')}\n` : ''}]`;
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
    .sort((a, b) => typeof a === 'symbol' ? -1 : typeof b === 'symbol' ? 1 : String(a).localeCompare(String(b)));
  if (keys.length === 0) return '{}';
  const entries = keys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && (descriptor.get || descriptor.set)) {
      const accessor = descriptor.get && descriptor.set ? 'Getter/Setter' : descriptor.get ? 'Getter' : 'Setter';
      if (options.getters !== true || !descriptor.get) return `  ${propertyLabel(key)}: [${accessor}]`;
      return `  ${propertyLabel(key)}: [Getter: ${indentMultiline(inspect(value[key], options, state), 2)}]`;
    }
    let entry;
    try {
      entry = value[key];
    } catch {
      entry = '<unavailable>';
    }
    return `  ${propertyLabel(key)}: ${indentMultiline(inspect(entry, options, state), 2)}`;
  });
 const prefix = '';
 const label = value instanceof Comparison ? 'Comparison ' : '';
  const rendered = `${prefix}${label}{\n${entries.join(',\n')}\n}`;
  return rendered.includes(`[Circular *${reference}]`)
    ? `<ref *${reference}> ${rendered}`
    : rendered;
}

function typeDescription(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  switch (typeof value) {
    case 'bigint': return `type bigint (${value}n)`;
    case 'number':
      if (Number.isNaN(value)) return 'type number (NaN)';
      if (value === Infinity || value === -Infinity) return `type number (${value})`;
      if (Object.is(value, -0)) return 'type number (-0)';
      return `type number (${value})`;
    case 'boolean': return `type boolean (${value})`;
    case 'symbol': return `type symbol (${String(value)})`;
    case 'function': return `function ${value.name || ''}`;
    case 'string': {
      const short = value.length > 28 ? `${value.slice(0, 25)}...` : value;
      return `type string ('${short.replaceAll("'", "\\'")}')`;
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
  const call = sourceLine.match(/\b(?:[A-Za-z_$][\w$]*\.)?(?:ok|assert|strict)(?:(?:\.[A-Za-z_$][\w$]*)|(?:\[['"][^'"]+['"]\]))*\s*\(/);
  if (!call) return undefined;
  let start = call.index;
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
  if (sourceLine[start] === 'n' && (sourceLine.slice(start).startsWith('nassert.')
    || sourceLine.slice(start).startsWith('nstrict.'))) start += 1;
  return sourceLine.slice(start, end).replace(/[\u0000-\u001f\u007f]/g, (character) => {
    const code = character.codePointAt(0).toString(16).padStart(4, '0');
    return `\\u${code}`;
  }).replaceAll('\\\\u', '\\u');
}

function extractSourceExpressions(sourceLine) {
  const expressions = [];
  for (const match of sourceLine.matchAll(/\b(?:[A-Za-z_$][\w$]*\.)?(?:ok|assert|strict)(?:(?:\.[A-Za-z_$][\w$]*)|(?:\[['"][^'"]+['"]\]))*\s*\(/g)) {
    const expression = extractSourceExpression(sourceLine.slice(match.index));
    if (expression) expressions.push(expression);
  }
  return expressions;
}

function extractCallExpressions(sourceLine) {
  const expressions = [];
  for (const match of sourceLine.matchAll(/\b[A-Za-z_$][\w$]*(?:(?:\.[A-Za-z_$][\w$]*)|(?:\[['"][^'"]+['"]\]))*\s*\(/g)) {
    const expression = sourceLine.slice(match.index).match(/^[\s\S]*?\)/)?.[0];
    if (expression && !/^(?:if|for|while|switch|catch|function)\s*\(/.test(expression)
      && !/\bassert\b/.test(expression)
      && !/^(?:assert|strict)\.(?:throws|doesNotThrow|rejects|doesNotReject)\s*\(/.test(expression)) {
      expressions.push(expression);
    }
  }
  return expressions;
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
    const sourceLines = source.split('\n');
    const lineNumber = Number(match[2]);
    const offsets = [0, 1, 2, 3, 4, 5, -1, -2, -3, -4, -5];
    for (const offset of offsets) {
      const sourceLine = sourceLines[lineNumber - offset - 1]?.trim();
      const expressions = sourceLine
        ? extractSourceExpressions(sourceLine).filter((expression) => !/^(?:assert|strict)\.(?:throws|doesNotThrow|rejects|doesNotReject)\s*\(/.test(expression))
        : [];
      const expression = expressions.at(-1);
      if (expression) return expression;
    }
    for (const offset of offsets) {
      const sourceLine = sourceLines[lineNumber - offset - 1]?.trim();
      const expression = sourceLine ? extractCallExpressions(sourceLine).at(-1) : undefined;
      if (expression) return expression;
    }
  }
  if (sourcePath && !stack.includes('/node/')) return 'strict.ok(';
  if (!sourcePath) return undefined;
  try {
    const rawSource = readSource(sourcePath);
    const source = typeof rawSource === 'string' ? rawSource : new TextDecoder().decode(rawSource);
    const sourceLines = source.split('\n');
    const stackLineNumbers = [...stack.matchAll(/(\/node\/[^):]+):(\d+):\d+/g)]
      .map((match) => Number(match[2]))
      .reverse();
    for (const lineNumber of stackLineNumbers) {
      const offsets = [0, 1, 2, 3, 4, 5, -1, -2, -3, -4, -5];
      for (const offset of offsets) {
        const sourceLine = sourceLines[lineNumber - offset - 1]?.trim() || '';
        const expression = extractSourceExpressions(sourceLine)
          .filter((candidate) => !/^(?:assert|strict)\.(?:throws|doesNotThrow|rejects|doesNotReject)\s*\(/.test(candidate))
          .at(-1);
        if (expression) return expression;
      }
      for (const offset of offsets) {
        const sourceLine = sourceLines[lineNumber - offset - 1]?.trim() || '';
        const expression = extractCallExpressions(sourceLine).at(-1);
        if (expression) return expression;
      }
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

function same(actual, expected, seen = new Map(), strictNumbers = true) {
  if (Object.is(actual, expected)) return true;
  if (!strictNumbers && (actual === null || typeof actual !== 'object')) {
    if (!(expected === null || typeof expected !== 'object')) return false;
    return actual == expected || (Number.isNaN(actual) && Number.isNaN(expected));
  }
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') return false;
  if (strictNumbers && !compareStrictPrototype(actual, expected)) {
    const sameRegExp = Object.prototype.toString.call(actual) === '[object RegExp]'
      && Object.prototype.toString.call(expected) === '[object RegExp]'
      && String(actual) === String(expected);
    if (!sameRegExp) return false;
  }
  if (seen.get(actual) === expected) return true;
  seen.set(actual, expected);

  const actualTag = Object.prototype.toString.call(actual);
  const expectedTag = Object.prototype.toString.call(expected);
  if (actualTag !== expectedTag) return false;
  if (Array.isArray(actual) && actual.length !== expected.length) return false;
  if (actual instanceof Date) {
    let actualTime;
    let expectedTime;
    try {
      actualTime = Date.prototype.getTime.call(actual);
      expectedTime = Date.prototype.getTime.call(expected);
    } catch {
      return false;
    }
    if (actualTime !== expectedTime) return false;
  }
  const actualErrorTag = actualTag === '[object Error]';
  const expectedErrorTag = expectedTag === '[object Error]';
  if (actualErrorTag !== expectedErrorTag) return false;
  if (actualErrorTag && expectedErrorTag
    && (actual.name !== expected.name || actual.message !== expected.message)) return false;
  if (actual instanceof RegExp) {
    try {
      if (!(expected instanceof RegExp)
        || String(actual) !== String(expected)
        || actual.lastIndex !== expected.lastIndex) return false;
    } catch {
      return false;
    }
  }
  const actualBoxedTag = actualTag;
  const expectedBoxedTag = expectedTag;
  if (boxedPrimitiveTags.has(actualBoxedTag) || boxedPrimitiveTags.has(expectedBoxedTag)) {
    if (actualBoxedTag !== expectedBoxedTag) return false;
    try {
      const actualValue = intrinsicBoxedPrimitiveValue(actual, actualBoxedTag);
      const expectedValue = intrinsicBoxedPrimitiveValue(expected, expectedBoxedTag);
      if (!(strictNumbers ? Object.is(actualValue, expectedValue) : actualValue == expectedValue)) return false;
    } catch {
      return false;
    }
  }
  if (actual instanceof Error && expected instanceof Error) {
    if (actual.name !== expected.name || actual.message !== expected.message) return false;
    const actualHasCause = Object.prototype.hasOwnProperty.call(actual, 'cause');
    const expectedHasCause = Object.prototype.hasOwnProperty.call(expected, 'cause');
    if (actualHasCause !== expectedHasCause) return false;
    if (actualHasCause && !same(actual.cause, expected.cause, seen, strictNumbers)) return false;
    const actualHasErrors = Object.prototype.hasOwnProperty.call(actual, 'errors');
    const expectedHasErrors = Object.prototype.hasOwnProperty.call(expected, 'errors');
    if (actualHasErrors !== expectedHasErrors) return false;
    if (actualHasErrors && !same(actual.errors, expected.errors, seen, strictNumbers)) return false;
  }
  if (actualTag === '[object URL]' && expectedTag === '[object URL]') {
    if (String(actual) !== String(expected)) return false;
  }
  if (ArrayBuffer.isView(actual) !== ArrayBuffer.isView(expected)
    || Array.isArray(actual) !== Array.isArray(expected)) return false;
  if (ArrayBuffer.isView(actual) && ArrayBuffer.isView(expected)
    && intrinsicTypedArrayTag(actual) !== intrinsicTypedArrayTag(expected)) return false;
  if (actual instanceof Map && expected instanceof Map) {
    if (actual.size !== expected.size) return false;
    const entries = [...expected];
    const used = new Set();
    const matched = [...actual].every(([actualKey, actualValue]) => {
      for (let index = 0; index < entries.length; index += 1) {
        if (used.has(index)) continue;
        const candidateSeen = new Map(seen);
        const [expectedKey, expectedValue] = entries[index];
        if (same(actualKey, expectedKey, candidateSeen, strictNumbers)
          && same(actualValue, expectedValue, candidateSeen, strictNumbers)) {
          used.add(index);
          seen.clear();
          for (const [key, value] of candidateSeen) seen.set(key, value);
          return true;
        }
      }
      return false;
    });
    if (!matched) return false;
  }
  if (actual instanceof Set && expected instanceof Set) {
    if (actual.size !== expected.size) return false;
    const values = [...expected];
    const used = new Set();
    const matched = [...actual].every((actualValue) => {
      for (let index = 0; index < values.length; index += 1) {
        if (used.has(index)) continue;
        const candidateSeen = new Map(seen);
        if (same(actualValue, values[index], candidateSeen, strictNumbers)) {
          used.add(index);
          seen.clear();
          for (const [key, value] of candidateSeen) seen.set(key, value);
          return true;
        }
      }
      return false;
    });
    if (!matched) return false;
  }
  if ((actualTag === '[object WeakMap]' && expectedTag === '[object WeakMap]')
    || (actualTag === '[object WeakSet]' && expectedTag === '[object WeakSet]')) return false;
  if (ArrayBuffer.isView(actual) && ArrayBuffer.isView(expected)) {
    if (intrinsicTypedArrayTag(actual) !== intrinsicTypedArrayTag(expected)
      || actual.byteLength !== expected.byteLength) return false;
    if (actual instanceof DataView || expected instanceof DataView) {
      const actualBytes = new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength);
      const expectedBytes = new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength);
      if (!actualBytes.every((value, index) => same(value, expectedBytes[index], seen, strictNumbers))) return false;
    } else if (![...actual].every((value, index) => same(value, expected[index], seen, strictNumbers))) {
      return false;
    }
  }
  if (actual instanceof ArrayBuffer && expected instanceof ArrayBuffer) {
    if (actual.byteLength !== expected.byteLength) return false;
    const actualBytes = new Uint8Array(actual);
    const expectedBytes = new Uint8Array(expected);
    if (!actualBytes.every((value, index) => value === expectedBytes[index])) return false;
  }
  if (typeof SharedArrayBuffer === 'function' && actual instanceof SharedArrayBuffer && expected instanceof SharedArrayBuffer) {
    if (actual.byteLength !== expected.byteLength) return false;
    if (!same(new Uint8Array(actual), new Uint8Array(expected), seen, strictNumbers)) return false;
  }
  if (actual.constructor?.name === 'CryptoKey' && expected.constructor?.name === 'CryptoKey') {
    if (actual.type !== expected.type
      || actual.extractable !== expected.extractable
      || !same(actual.algorithm, expected.algorithm, seen, strictNumbers)
      || !same(actual.usages, expected.usages, seen, strictNumbers)) return false;
    const actualKey = cryptoKeyMaterial(actual);
    const expectedKey = cryptoKeyMaterial(expected);
    if (actualKey !== undefined && expectedKey !== undefined) {
      if (typeof actualKey.equals === 'function') {
        if (!actualKey.equals(expectedKey)) return false;
      } else if (!same(actualKey, expectedKey, seen, strictNumbers)) {
        return false;
      }
    }
  }

  const actualKeys = Reflect.ownKeys(actual).filter((key) =>
    (strictNumbers || typeof key !== 'symbol')
      && Object.prototype.propertyIsEnumerable.call(actual, key));
  const expectedKeys = Reflect.ownKeys(expected).filter((key) =>
    (strictNumbers || typeof key !== 'symbol')
      && Object.prototype.propertyIsEnumerable.call(expected, key));
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key) => expectedKeys.includes(key) && same(actual[key], expected[key], seen, strictNumbers));
}

function partialSame(actual, expected, seen = new Map()) {
  if (Object.is(actual, expected)) return true;
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') return false;
  const actualTag = Object.prototype.toString.call(actual);
  const expectedTag = Object.prototype.toString.call(expected);
  if (actualTag !== expectedTag) return false;
  const plainRecords = Object.prototype.toString.call(actual) === '[object Object]'
    && Object.prototype.toString.call(expected) === '[object Object]';
  if (actual.constructor !== expected.constructor && !plainRecords && actualTag !== expectedTag) return false;
  if (seen.get(actual) === expected) return true;
  seen.set(actual, expected);

  if (actualTag === '[object Date]') {
    try {
      if (Date.prototype.getTime.call(actual) !== Date.prototype.getTime.call(expected)) return false;
    } catch {
      return false;
    }
  }
  if ((actualTag === '[object Error]') !== (expectedTag === '[object Error]')) return false;
  if (actualTag === '[object Error]' && expectedTag === '[object Error]'
    && (actual.name !== expected.name
      || (Object.prototype.hasOwnProperty.call(expected, 'message') && actual.message !== expected.message))) return false;
  if (actualTag === '[object RegExp]') {
    try {
      if (String(actual) !== String(expected) || actual.lastIndex !== expected.lastIndex) return false;
    } catch {
      return false;
    }
  }
  if (boxedPrimitiveTags.has(actualTag) || boxedPrimitiveTags.has(expectedTag)) {
    if (actualTag !== expectedTag) return false;
    try {
      if (!Object.is(intrinsicBoxedPrimitiveValue(actual, actualTag), intrinsicBoxedPrimitiveValue(expected, expectedTag))) return false;
    } catch {
      return false;
    }
  }
  if (actual instanceof Error && expected instanceof Error) {
    if (Object.prototype.hasOwnProperty.call(expected, 'name') && actual.name !== expected.name) return false;
    if (Object.prototype.hasOwnProperty.call(expected, 'message') && actual.message !== expected.message) return false;
    if (Object.prototype.hasOwnProperty.call(expected, 'cause')) {
      if (!Object.prototype.hasOwnProperty.call(actual, 'cause')) return false;
      if (!partialSame(actual.cause, expected.cause, seen)) return false;
    }
    if (expected.name === 'AggregateError' && Object.prototype.hasOwnProperty.call(expected, 'errors')) {
      if (!Object.prototype.hasOwnProperty.call(actual, 'errors')) return false;
      if (!partialSame(actual.errors, expected.errors, seen)) return false;
    }
  }
  if (actual.constructor?.name === 'CryptoKey' && expected.constructor?.name === 'CryptoKey') {
    if (actual.type !== expected.type
      || actual.extractable !== expected.extractable
      || !partialSame(actual.algorithm, expected.algorithm, seen)
      || !partialSame(actual.usages, expected.usages, seen)) return false;
    const actualKey = cryptoKeyMaterial(actual);
    const expectedKey = cryptoKeyMaterial(expected);
    if (actualKey !== undefined && expectedKey !== undefined) {
      if (ArrayBuffer.isView(actualKey) && ArrayBuffer.isView(expectedKey)) {
        if (actualKey.byteLength !== expectedKey.byteLength
          || ![...actualKey].every((value, index) => value === expectedKey[index])) return false;
      } else if (actualKey !== expectedKey) {
        return false;
      }
    }
  }
  if (actualTag === '[object URL]' && expectedTag === '[object URL]') {
    if (String(actual) !== String(expected)) return false;
  }
  if ((actualTag === '[object WeakMap]' && expectedTag === '[object WeakMap]')
    || (actualTag === '[object WeakSet]' && expectedTag === '[object WeakSet]')) return false;
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  if (ArrayBuffer.isView(actual) !== ArrayBuffer.isView(expected)) return false;
  if (ArrayBuffer.isView(actual) && ArrayBuffer.isView(expected)
    && intrinsicTypedArrayTag(actual) !== intrinsicTypedArrayTag(expected)) return false;

  if (actualTag === '[object Map]' && expectedTag === '[object Map]') {
    if (actual.size < expected.size) return false;
    const entries = [...actual];
    const used = new Set();
    const matched = [...expected].every(([expectedKey, expectedValue]) => {
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
    if (!matched) return false;
  }
  if (actualTag === '[object Set]' && expectedTag === '[object Set]') {
    if (actual.size < expected.size) return false;
    const values = [...actual];
    const used = new Set();
    const matched = [...expected].every((expectedValue) => {
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
    if (!matched) return false;
  }
  if (ArrayBuffer.isView(actual) && ArrayBuffer.isView(expected)) {
    if (actualTag !== expectedTag || actual.length < expected.length) return false;
    if (actual instanceof DataView || expected instanceof DataView) {
      const actualBytes = new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength);
      const expectedBytes = new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength);
      return expectedBytes.every((value, index) => actualBytes[index] === value);
    }
    let actualIndex = 0;
    for (const expectedValue of expected) {
      let matched = false;
      for (; actualIndex < actual.length; actualIndex += 1) {
        if (Object.is(actual[actualIndex], expectedValue)) {
          actualIndex += 1;
          matched = true;
          break;
        }
      }
      if (!matched) return false;
    }
    const expectedKeys = Reflect.ownKeys(expected)
      .filter((key) => !isArrayIndexKey(key)
        && Object.prototype.propertyIsEnumerable.call(expected, key));
    return expectedKeys.every((key) => Object.prototype.propertyIsEnumerable.call(actual, key)
      && partialSame(actual[key], expected[key], seen));
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
  if (typeof SharedArrayBuffer === 'function' && actual instanceof SharedArrayBuffer && expected instanceof SharedArrayBuffer) {
    if (actual.byteLength < expected.byteLength) return false;
    const actualBytes = new Uint8Array(actual);
    const expectedBytes = new Uint8Array(expected);
    return expectedBytes.every((value, index) => actualBytes[index] === value);
  }

  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length < expected.length) return false;
    let actualIndex = 0;
    let sparseHandled = false;
    for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
      if (!Object.prototype.hasOwnProperty.call(expected, expectedIndex)) {
        if (!partialSparseArraySame(actual, expected, actualIndex, expectedIndex, seen)) return false;
        actualIndex = actual.length;
        sparseHandled = true;
        break;
      }
      let matched = false;
      for (; actualIndex < actual.length; actualIndex += 1) {
        if (!Object.prototype.hasOwnProperty.call(actual, actualIndex)) {
          if (!partialSparseArraySame(actual, expected, actualIndex, expectedIndex, seen)) return false;
          actualIndex = actual.length;
          sparseHandled = true;
          matched = true;
          break;
        }
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
      if (sparseHandled) break;
    }
    const expectedKeys = Reflect.ownKeys(expected)
      .filter((key) => key !== 'length' && !isArrayIndexKey(key)
        && Object.prototype.propertyIsEnumerable.call(expected, key));
    return expectedKeys.every((key) => Object.prototype.propertyIsEnumerable.call(actual, key)
      && partialSame(actual[key], expected[key], seen));
  }

  const expectedKeys = Reflect.ownKeys(expected)
    .filter((key) => Object.prototype.propertyIsEnumerable.call(expected, key));
  return expectedKeys.every((key) => Object.prototype.propertyIsEnumerable.call(actual, key)
    && partialSame(actual[key], expected[key], seen));
}

function partialSparseArraySame(actual, expected, startA, startB, seen) {
  const actualKeys = Object.keys(actual).slice(startA);
  const expectedKeys = Object.keys(expected).slice(startB);
  if (actualKeys.length < expectedKeys.length) return false;
  let actualIndex = 0;
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const expectedKey = expectedKeys[index];
    while (!partialSame(actual[actualKeys[actualIndex]], expected[expectedKey], seen)) {
      actualIndex += 1;
      if (actualIndex > actualKeys.length - expectedKeys.length + index) return false;
    }
    actualIndex += 1;
  }
  return true;
}

function diffLines(actual, expected) {
  const left = actual.split('\n');
  const right = expected.split('\n');
  const sameLine = (leftLine, rightLine) => leftLine === rightLine
    || leftLine.replace(/,$/, '') === rightLine.replace(/,$/, '');
  const max = left.length + right.length;
  const vector = new Int32Array(2 * max + 1);
  const trace = [];
  let operations;

  for (let level = 0; level <= max; level += 1) {
    trace.push(vector.slice());
    for (let diagonal = -level; diagonal <= level; diagonal += 2) {
      const offset = diagonal + max;
      const previous = vector[offset - 1];
      const next = vector[offset + 1];
      let x = diagonal === -level || (diagonal !== level && previous < next)
        ? next
        : previous + 1;
      let y = x - diagonal;
      while (x < left.length && y < right.length && sameLine(left[x], right[y])) {
        x += 1;
        y += 1;
      }
      vector[offset] = x;
      if (x >= left.length && y >= right.length) {
        operations = [];
        let currentX = left.length;
        let currentY = right.length;
        for (let traceLevel = trace.length - 1; traceLevel >= 0; traceLevel -= 1) {
          const previousVector = trace[traceLevel];
          const currentDiagonal = currentX - currentY;
          const currentOffset = currentDiagonal + max;
          const previousDiagonal = currentDiagonal === -traceLevel
            || (currentDiagonal !== traceLevel && previousVector[currentOffset - 1] < previousVector[currentOffset + 1])
            ? currentDiagonal + 1
            : currentDiagonal - 1;
          const previousX = previousVector[previousDiagonal + max];
          const previousY = previousX - previousDiagonal;
          while (currentX > previousX && currentY > previousY) {
            const value = !left[currentX - 1].endsWith(',') ? right[currentY - 1] : left[currentX - 1];
            operations.push([0, value]);
            currentX -= 1;
            currentY -= 1;
          }
          if (traceLevel > 0) {
            if (currentX > previousX) operations.push([1, left[--currentX]]);
            else operations.push([-1, right[--currentY]]);
          }
        }
        break;
      }
    }
    if (operations) break;
  }

  const lines = [];
  let skipped = false;
  let nopCount = 0;
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const [operation, value] = operations[index];
    const previousOperation = index < operations.length - 1 ? operations[index + 1][0] : null;
    if (previousOperation === 0 && operation !== 0) {
      if (nopCount === 6) lines.push(`  ${operations[index + 1][1]}`);
      else if (nopCount === 7) {
        lines.push(`  ${operations[index + 2][1]}`);
        lines.push(`  ${operations[index + 1][1]}`);
      } else if (nopCount >= 8) {
        lines.push('...');
        lines.push(`  ${operations[index + 1][1]}`);
        skipped = true;
      }
      nopCount = 0;
    }
    if (operation === 1) lines.push(`+ ${value}`);
    else if (operation === -1) lines.push(`- ${value}`);
    else {
      if (nopCount < 5) lines.push(`  ${value}`);
      nopCount += 1;
    }
  }
  return { text: lines.join('\n'), skipped };
}

function strictDiff(actual, expected, operator, message) {
  const inspectOptions = { customInspect: false, compact: false, getters: true };
  const actualText = inspect(actual, inspectOptions);
  const expectedText = inspect(expected, inspectOptions);
  const title = operator === 'deepStrictEqual'
    ? 'Expected values to be strictly deep-equal:'
    : operator === 'partialDeepStrictEqual'
      ? 'Expected values to be partially and strictly deep-equal:'
      : 'Expected values to be strictly equal:';

  if (operator === 'deepStrictEqual' && actual instanceof Error && expected instanceof Error) {
    const label = (error) => `[${error.name || 'Error'}${error.message ? `: ${error.message}` : ''}]`;
    const signedCauseLines = (sign, error) => {
      const lines = inspect(error.cause).split('\n');
      return [
        `${sign}   [cause]: ${lines[0]}`,
        ...lines.slice(1).map((line) => line.trim() === '}'
          ? `${sign}   }`
          : `${sign}     ${line.replace(/^  /, '')}`),
      ];
    };
    const actualHasCause = Object.prototype.hasOwnProperty.call(actual, 'cause');
    const expectedHasCause = Object.prototype.hasOwnProperty.call(expected, 'cause');
    if (actual.name === expected.name && actual.message === expected.message) {
      if (actualHasCause && expectedHasCause) {
        return `${message || title}\n+ actual - expected\n\n  ${label(actual)} {\n${signedCauseLines('+', actual).join('\n')}\n${signedCauseLines('-', expected).join('\n')}\n  }\n`;
      }
      if (actualHasCause !== expectedHasCause) {
        const actualLines = actualHasCause
          ? [`+ ${label(actual)} {`, ...signedCauseLines('+', actual), '+ }']
          : [`+ ${label(actual)}`];
        const expectedLines = expectedHasCause
          ? [`- ${label(expected)} {`, ...signedCauseLines('-', expected), '- }']
          : [`- ${label(expected)}`];
        return `${message || title}\n+ actual - expected\n\n${[...actualLines, ...expectedLines].join('\n')}\n`;
      }
    }
  }

  if (operator === 'deepStrictEqual'
    && (actual instanceof RegExp || expected instanceof RegExp)
    && actualText !== expectedText) {
    const diff = diffLines(actualText, expectedText);
    return `${message || title}\n+ actual - expected\n${diff.skipped ? '... Skipped lines\n\n' : '\n'}${diff.text}\n`;
  }

  if (operator === 'strictEqual' && isObject(actual) && isObject(expected) && actualText === expectedText) {
    return `${message || 'Values have same structure but are not reference-equal:'}\n\n${actualText}\n`;
  }
  if (isObject(actual) && isObject(expected) && actualText === expectedText
    && actualText.split('\n').length > 50) {
    const lines = actualText.split('\n');
    return `${message || 'Values have same structure but are not reference-equal:'}\n\n${lines.slice(0, 50).join('\n')}\n...}\n`;
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
    const diff = diffLines(actualText, expectedLines.join('\n'));
    return `${message || 'Expected "actual" to be reference-equal to "expected":'}\n+ actual - expected\n${diff.skipped ? '... Skipped lines\n\n' : '\n'}${diff.text}\n`;
  }
  if (operator === 'strictEqual'
    && typeof actual === 'string'
    && typeof expected === 'string'
    && (actual.includes('\n') || expected.includes('\n'))
    && actual.length + expected.length > 128) {
    const render = (sign, value) => value
      .split(/(?<=\n)/)
      .map((line, index, lines) => `${sign} ${index === 0 ? quote(line) : `  ${quote(line)}`}${index < lines.length - 1 ? ' +' : ''}`)
      .join('\n');
    return `${message || title}\n+ actual - expected\n\n${render('+', actual)}\n${render('-', expected)}\n`;
  }
  if (!actualText.includes('\n') && !expectedText.includes('\n')) {
    if ((typeof actual === 'string' && typeof expected === 'string' && actualText.length + expectedText.length > 20)
      || typeof actual === 'function' || typeof expected === 'function'
      || actualText.length + expectedText.length > 80) {
      let indicator = '';
      if (typeof actual === 'string' && typeof expected === 'string'
        && actual.length + expected.length <= 80) {
        let divergence = -1;
        for (let index = 0; index < Math.min(actualText.length, expectedText.length); index += 1) {
          if (actualText[index] !== expectedText[index]) {
            divergence = index;
            break;
          }
        }
        if (divergence >= 3) indicator = `\n${' '.repeat(divergence + 2)}^`;
      }
      return `${message || title}\n+ actual - expected\n\n+ ${actualText}\n- ${expectedText}${indicator}\n`;
    }
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
  const diff = diffLines(actualText, expectedText);
  return `${message || title}\n+ actual - expected\n${diff.skipped ? '... Skipped lines\n\n' : '\n'}${diff.text}\n`;
}

function looseDeepDiff(actual, expected, full = false) {
  const format = (value) => {
    if (typeof value !== 'string') return inspect(value, { customInspect: false, compact: false });
    if (value.includes('\n') && value.length > 128) {
      const chunks = value.split(/(?<=\n)/);
      const limit = full ? chunks.length : Math.min(chunks.length, 51);
      const selected = chunks.slice(0, limit);
      const lines = selected
        .map((chunk, index) => `${index === 0 ? quote(chunk) : `  ${quote(chunk)}`}${index < selected.length - 1 || !full ? ' +' : ''}`);
      if (!full && chunks.length > limit) lines.push(' ...');
      return lines.join('\n');
    }
    if (full || value.length <= 511) return quote(value);
    return `'${value.slice(0, 508)}...`;
  };
  return `Expected values to be loosely deep-equal:\n\n${format(actual)}\n\nshould loosely deep-equal\n\n${format(expected)}`;
}

function notStrictDiff(actual, full = false) {
  const lines = actual.split('\n');
  const visibleLines = full ? lines : lines.slice(0, 48);
  const body = visibleLines
    .map((line, index) => quote(`${line}${index < visibleLines.length - 1 ? '\n' : ''}`))
    .join(' +\n');
  return `Expected "actual" to be strictly unequal to:\n\n${body}`;
}

function assertionMessage(actual, expected, operator, message, fallback) {
  if (message instanceof Error
    && operator !== 'throws'
    && operator !== 'rejects'
    && operator !== 'doesNotThrow'
    && operator !== 'doesNotReject') throw message;
  if (operator === 'strictEqual' || operator === 'deepStrictEqual' || operator === 'partialDeepStrictEqual') {
    return strictDiff(actual, expected, operator, message);
  }
  if (operator === 'throws' || operator === 'rejects'
    || operator === 'doesNotThrow' || operator === 'doesNotReject') {
    if (operator === 'doesNotThrow' || operator === 'doesNotReject') return fallback;
    return message ? String(message) : fallback;
  }
  if (message) return String(message);
  if (operator === 'notStrictEqual') {
    if (isObject(actual) || typeof actual === 'function') {
      const text = inspect(actual);
      return `Expected "actual" not to be reference-equal to "expected":${text.includes('\n') ? `\n\n${text}\n` : ` ${text}`}`;
    }
    if (typeof actual === 'string' && typeof expected === 'string' && actual.length + expected.length > 50) {
      return `Expected "actual" to be strictly unequal to:\n\n${inspect(actual)}`;
    }
    return `Expected "actual" to be strictly unequal to: ${inspect(actual)}`;
  }
  if (operator === 'notDeepStrictEqual') {
    let text = inspect(actual);
    const lines = text.split('\n');
    if (lines.length > 50) {
      lines[46] = '...';
      lines.length = 47;
      text = lines.join('\n');
    }
    return `Expected "actual" not to be strictly deep-equal to:\n\n${text}${text.includes('\n') ? '\n' : ''}`;
  }
  if (operator === 'equal') return `${inspect(actual)} != ${inspect(expected)}`;
  if (operator === '!=') return `${inspect(actual)} != ${inspect(expected)}`;
  if (operator === 'notEqual') return `${inspect(actual)} == ${inspect(expected)}`;
  if (operator === 'deepEqual') return looseDeepDiff(actual, expected);
  if (operator === 'notDeepEqual') {
    const actualText = inspect(actual);
    const expectedText = inspect(expected);
    return actualText === expectedText
      ? `Expected "actual" not to be loosely deep-equal to:\n\n${actualText}`
      : `Expected values not to be loosely deep-equal:\n\n${inspect(actual)}\n\nshould not loosely deep-equal\n\n${inspect(expected)}`;
  }
  if (operator === '==') return fallback || `${inspect(actual)} == ${inspect(expected)}`;
  if (operator !== 'fail') return `${inspect(actual)} ${operator} ${inspect(expected)}`;
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

function addEllipsis(value) {
  const lines = String(value).split('\n', 11);
  if (lines.length > 10) {
    lines.length = 10;
    return `${lines.join('\n')}\n...`;
  }
  if (value.length > 512) return `${value.slice(512)}...`;
  return value;
}

export class AssertionError extends Error {
  constructor(options) {
    if (!isPlainObject(options)) throw invalidArgumentType('options', options, 'object');
    const message = options.message == null ? '' : String(options.message);
    super(message);
    this.name = 'AssertionError';
    this.code = 'ERR_ASSERTION';
    this.generatedMessage = options.generatedMessage ?? !options.message;
    if (Array.isArray(options.details)) {
      this.actual = undefined;
      this.expected = undefined;
      this.operator = undefined;
      for (let index = 0; index < options.details.length; index += 1) {
        const detail = options.details[index];
        this[`message ${index}`] = detail.message;
        this[`actual ${index}`] = detail.actual;
        this[`expected ${index}`] = detail.expected;
        this[`operator ${index}`] = detail.operator;
        this[`stack trace ${index}`] = detail.stack;
      }
    } else {
      this.actual = options.actual;
      this.expected = options.expected;
      this.operator = options.operator;
    }
    const stackStartFunction = options.stackStartFn || options.stackStartFunction;
    if (typeof stackStartFunction === 'function' && typeof this.stack === 'string') {
      const marker = stackStartFunction.name ? `at ${stackStartFunction.name}` : undefined;
      if (marker) this.stack = this.stack.split('\n').filter((line) => !line.includes(marker)).join('\n');
    }
  }

  toString() {
    return `${this.name} [${this.code}]: ${this.message}`;
  }

  [inspectCustomSymbol](recurseTimes, context) {
    const actual = this.actual;
    const expected = this.expected;

    if (typeof actual === 'string') this.actual = addEllipsis(actual);
    if (typeof expected === 'string') this.expected = addEllipsis(expected);

    const result = inspect(this, {
      ...context,
      customInspect: false,
      depth: 0,
    });

    this.actual = actual;
    this.expected = expected;
    return result;
  }
}

function matcherResult(error, expected) {
  if (expected == null) return { matched: false };
  if (typeof expected === 'function') {
    if (expected.name.endsWith('Error')
      && error?.name === expected.name
      && Object.getPrototypeOf(error) !== expected.prototype) return { matched: false };
    if (expected.prototype !== undefined && error instanceof expected) {
      if (expected.name.endsWith('Error')
        && error.constructor?.name === expected.name
        && error.constructor !== expected) return { matched: false };
      return { matched: true };
    }
    const isErrorConstructor = expected.prototype
      && (expected.prototype instanceof Error
        || (typeof expected.name === 'string'
          && expected.name.endsWith('Error')
          && expected.prototype.name === expected.name));
    if (isErrorConstructor) return { matched: false };
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
      const matchesRegExp = actualValue instanceof RegExp
        ? String(actualValue) === String(expectedValue) && actualValue.lastIndex === expectedValue.lastIndex
        : typeof actualValue === 'string' && expectedValue.test(actualValue);
      if (!matchesRegExp) {
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
  if (Object.prototype.toString.call(expected) === '[object Object]' && Object.keys(expected).length === 0) {
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

function missingException(expected, message, rejection = false) {
  let detail = '';
  if (expected?.name) detail += ` (${expected.name})`;
  detail += message ? `: ${message}` : '.';
  return `Missing expected ${rejection ? 'rejection' : 'exception'}${detail}`;
}

function mismatchMessage(error, expected, message, match) {
  const objectExpectation = isObject(expected) && !(expected instanceof RegExp);
  if (message && objectExpectation && !Object.prototype.hasOwnProperty.call(expected, 'message')) return message;
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
  if (typeof expected === 'function') {
    const name = expected.name ? `"${expected.name}" ` : '';
    let result = `The ${name}validation function is expected to return "true". Received ${inspect(match?.result)}`;
    if (error instanceof Error) result += `\n\nCaught error:\n\n${error}`;
    return result;
  }
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

const noRejection = Symbol('no rejection');

function isPromiseLike(value) {
  return value instanceof Promise
    || (value !== null && typeof value === 'object'
      && typeof value.then === 'function'
      && typeof value.catch === 'function');
}

function invalidReturnValue(name, value, modernMessage = false) {
  const error = new TypeError(modernMessage
    ? `The "${name}" function is expected to return an instance of Promise. Received ${typeDescription(value)}.`
    : `Expected instance of Promise to be returned from the "${name}" function but got ${typeDescription(value)}.`);
  error.code = 'ERR_INVALID_RETURN_VALUE';
  return error;
}

async function waitForActual(promiseOrFn, modernInvalidReturn = false) {
  let promise;
  if (typeof promiseOrFn === 'function') {
    promise = promiseOrFn();
    if (!isPromiseLike(promise)) throw invalidReturnValue('promiseFn', promise, modernInvalidReturn);
  } else if (isPromiseLike(promiseOrFn)) {
    promise = promiseOrFn;
  } else {
    throw invalidArgumentType('promiseFn', promiseOrFn, 'function or an instance of Promise');
  }
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return noRejection;
}

function missingArguments() {
  const error = new TypeError('The "actual" and "expected" arguments must be specified');
  error.code = 'ERR_MISSING_ARGS';
  return error;
}

export function createAssert({ strict = false, readSource, sourcePath, process: processObject } = {}) {
  let failDeprecatedWarningEmitted = false;
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
  assert.fail = function failAssertion(actual, expected, message, operator, stackFrameFunction) {
    if (arguments.length > 1 && !failDeprecatedWarningEmitted) {
      failDeprecatedWarningEmitted = true;
      processObject?.emitWarning?.(
        'assert.fail() with more than one argument is deprecated. Please use assert.strictEqual() instead or only pass a message.',
        { code: 'DEP0094', type: 'DeprecationWarning' },
      );
    }
    const throwFailure = (failure) => {
      if (typeof stackFrameFunction === 'function' && typeof failure?.stack === 'string') {
        const frame = `at ${stackFrameFunction.name || ''}`;
        failure.stack = failure.stack.split('\n').filter((line) => !line.includes(frame)).join('\n');
      }
      throw failure;
    };
    if (arguments.length <= 1) {
      if (actual instanceof Error) throwFailure(actual);
      try {
        fail(actual, undefined, undefined, 'fail', actual === undefined ? 'Failed' : 'Assertion failed');
      } catch (error) {
        throwFailure(error);
      }
    }
    if (message instanceof Error) throwFailure(message);
    const normalizedOperator = operator === undefined ? (arguments.length === 2 ? '!=' : 'fail') : String(operator);
    try {
      fail(
        message,
        actual,
        expected,
        normalizedOperator,
        normalizedOperator === 'fail' ? 'Assertion failed' : undefined,
      );
    } catch (error) {
      throwFailure(error);
    }
  };

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
    if (actual == expected || (Number.isNaN(actual) && Number.isNaN(expected))) fail(message, actual, expected, '!=' );
  }
  function deepEqual(actual, expected, message) {
    if (arguments.length < 2) throw missingArguments();
    if (!same(actual, expected, new Map(), false)) fail(message, actual, expected, 'deepEqual');
  }
  function notDeepEqual(actual, expected, message) {
    if (arguments.length < 2) throw missingArguments();
    if (same(actual, expected, new Map(), false)) fail(message, actual, expected, 'notDeepEqual');
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
    if (!result.threw) {
      try {
        fail(undefined, undefined, expected, 'throws', missingException(expected, message));
      } catch (error) {
        if (typeof error?.stack === 'string') {
          error.stack = error.stack
            .split('\n')
            .filter((line) => !line.includes('assert.throws') && !line.includes('Assert.throws'))
            .join('\n');
        }
        throw error;
      }
    }
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
    const match = matcherResult(result.value, expected);
    if (!result.threw) return;
    if (expected == null || match.matched) {
      try {
        fail(message, result.value, expected, 'doesNotThrow', `Got unwanted exception${message ? `: ${message}` : '.'}\nActual message: "${result.value?.message}"`);
      } catch (error) {
        if (typeof error?.stack === 'string') {
          error.stack = error.stack
            .split('\n')
            .filter((line) => !line.includes('assert.doesNotThrow')
              && !line.includes('Assert.doesNotThrow')
              && !line.includes('as doesNotThrow'))
            .join('\n');
        }
        throw error;
      }
    }
    throw result.value;
  };

  assert.rejects = async function rejects(promiseOrFn, expected, message) {
    const normalized = normalizeErrorArguments(expected, message, arguments.length);
    expected = normalized.expected;
    message = normalized.message;
    validateErrorExpectation(expected);
    const result = await waitForActual(promiseOrFn);
    if (result === noRejection) fail(message, undefined, expected, 'rejects', missingException(expected, message, true));
    const match = expected == null ? { matched: true } : matcherResult(result, expected);
    if (!match.matched) {
      const failureMessage = mismatchMessage(result, expected, message, match);
      const objectExpectation = isObject(expected) && !(expected instanceof RegExp);
      fail(message && objectExpectation ? failureMessage : message, result, expected, 'rejects', failureMessage);
    }
    return result;
  };

  assert.doesNotReject = async function doesNotReject(promiseOrFn, expected, message) {
    const normalized = normalizeErrorArguments(expected, message, arguments.length);
    expected = normalized.expected;
    message = normalized.message;
    const result = await waitForActual(promiseOrFn);
    if (result === noRejection) return;
    validateNoErrorExpectation(expected);
    const match = matcherResult(result, expected);
    if (expected == null || match.matched) {
      try {
        fail(message, result, expected, 'doesNotReject', `Got unwanted rejection${message ? `: ${message}` : '.'}\nActual message: "${result?.message}"`);
      } catch (error) {
        if (typeof error?.stack === 'string') {
          error.stack = error.stack
            .split('\n')
            .filter((line) => !line.includes('assert.doesNotReject') && !line.includes('Assert.doesNotReject'))
            .join('\n');
        }
        throw error;
      }
    }
    throw result;
  };

function compactMatchValue(value) {
  if (value === null || Object.prototype.toString.call(value) !== '[object Object]') return inspect(value);
  const entries = Object.keys(value).map((key) => `${propertyLabel(key)}: ${inspect(value[key])}`);
  const rendered = `{ ${entries.join(', ')} }`;
  return rendered.length <= 80 && !rendered.includes('\\n') ? rendered : inspect(value);
}

function internalMatch(actual, regexp, message, operator, shouldMatch) {
    if (!(regexp instanceof RegExp)) {
      const error = new TypeError(
        `The "regexp" argument must be an instance of RegExp. Received ${typeDescription(regexp)}`,
      );
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    const matched = typeof actual === 'string' && regexp.exec(actual) !== null;
    if (typeof actual === 'string' && matched === shouldMatch) return;
    if (message instanceof Error) throw message;
    const generatedMessage = !message;
    const failureMessage = message || (typeof actual !== 'string'
      ? `The "string" argument must be of type string. Received type ${typeof actual} (${compactMatchValue(actual)})`
      : `${shouldMatch
        ? 'The input did not match the regular expression '
        : 'The input was expected to not match the regular expression '}${inspect(regexp)}. Input:\n\n${inspect(actual)}\n`);
    const error = new AssertionError({
      actual,
      expected: regexp,
      message: failureMessage,
      operator,
    });
    error.generatedMessage = generatedMessage;
    throw error;
  }
  assert.match = (actual, regexp, message) => internalMatch(actual, regexp, message, 'match', true);
  assert.doesNotMatch = (actual, regexp, message) => internalMatch(actual, regexp, message, 'doesNotMatch', false);

  assert.AssertionError = AssertionError;
  let callTrackerWarned = false;
  function deprecatedCallTracker(...args) {
    if (!callTrackerWarned && !processObject?.noDeprecation) {
      callTrackerWarned = true;
      processObject?.emitWarning?.(
        'assert.CallTracker is deprecated.',
        { code: 'DEP0173', type: 'DeprecationWarning' },
      );
    }
    if (!new.target) return Reflect.apply(CallTracker, this, args);
    return Reflect.construct(CallTracker, [processObject, AssertionError], new.target);
  }
  Object.defineProperty(deprecatedCallTracker, 'name', { configurable: true, value: 'deprecated' });
  Object.defineProperty(deprecatedCallTracker, 'length', { configurable: true, value: 0 });
  Object.setPrototypeOf(deprecatedCallTracker, CallTracker);
  deprecatedCallTracker.prototype = CallTracker.prototype;
  assert.CallTracker = deprecatedCallTracker;
  const strictAssert = strict ? assert : createAssert({ strict: true, readSource, sourcePath, process: processObject });
  if (!strict) strictAssert.ok = assert;
  assert.strict = strictAssert;
  assert.ifError = (value) => {
    if (value !== null && value !== undefined) {
      let message = 'ifError got unwanted exception: ';
      if (typeof value === 'object' && typeof value.message === 'string') {
        if (value.message.length === 0 && value.constructor) message += value.constructor.name;
        else message += value.message;
      } else {
        const keys = Object.keys(value);
        if (value.constructor === Object && keys.length) {
          message += `{ ${keys.map((key) => `${key}: ${inspect(value[key])}`).join(', ')} }`;
        } else {
          message += inspect(value);
        }
      }
      throw new AssertionError({
        message,
        actual: value,
        expected: null,
        operator: 'ifError',
        generatedMessage: false,
      });
    }
  };

  const kOptions = Symbol('options');
  const methodLengths = {
    fail: 5,
    ok: 0,
    equal: 3,
    notEqual: 3,
    deepEqual: 3,
    notDeepEqual: 3,
    deepStrictEqual: 3,
    notDeepStrictEqual: 3,
    strictEqual: 3,
    notStrictEqual: 3,
    partialDeepStrictEqual: 3,
    throws: 1,
    rejects: 1,
    doesNotThrow: 1,
    doesNotReject: 1,
    ifError: 1,
    match: 3,
    doesNotMatch: 3,
  };

  function Assert(options = {}) {
    if (!new.target) {
      const error = new TypeError('Class constructor Assert cannot be invoked without `new`');
      error.code = 'ERR_CONSTRUCT_CALL_REQUIRED';
      throw error;
    }

    const configuredOptions = Object.assign({ __proto__: null, strict: true }, options);
    if (configuredOptions.diff !== undefined
      && configuredOptions.diff !== 'simple'
      && configuredOptions.diff !== 'full') {
      const error = new TypeError(
        `The property 'options.diff' must be one of: 'simple', 'full'. Received '${String(configuredOptions.diff)}'`,
      );
      error.code = 'ERR_INVALID_ARG_VALUE';
      throw error;
    }

    this.AssertionError = AssertionError;
    Object.defineProperty(this, kOptions, {
      value: configuredOptions,
      enumerable: false,
      configurable: false,
      writable: false,
    });

    if (configuredOptions.strict) {
      this.equal = this.strictEqual;
      this.deepEqual = this.deepStrictEqual;
      this.notEqual = this.notStrictEqual;
      this.notDeepEqual = this.notDeepStrictEqual;
    }
  }

  const wrapAssertMethod = (name) => {
    const method = function (...args) {
      const options = this?.[kOptions];
      const base = options?.strict ? assert.strict : assert;
      try {
        return base[name](...args);
      } catch (error) {
        if (error instanceof AssertionError) {
          const selectedDiff = name === 'match' || name === 'doesNotMatch'
            ? 'simple'
            : options?.diff || 'simple';
          error.diff = selectedDiff;
          if (error.operator === 'deepEqual') {
            error.message = looseDeepDiff(error.actual, error.expected, selectedDiff === 'full');
          } else if (error.operator === 'notStrictEqual'
            && typeof error.actual === 'string'
            && error.actual.includes('\n')) {
            error.message = notStrictDiff(error.actual, selectedDiff === 'full');
          }
        }
        throw error;
      }
    };
    Object.defineProperty(method, 'name', { value: name });
    Object.defineProperty(method, 'length', { value: methodLengths[name] });
    return method;
  };

  for (const name of Object.keys(methodLengths)) {
    Assert.prototype[name] = wrapAssertMethod(name);
  }

  assert.Assert = Assert;
  assert.strict.Assert = Assert;
  return assert;
}
