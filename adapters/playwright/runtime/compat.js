import { ensureOutputStream } from './streams.js';
import { AsyncResource } from './async-hooks.js';
import { inspect as runtimeInspect } from './assert.js';

export const kWeakHandler = Symbol.for('nodejs.internal.event_target.weakHandler');

const abortSignalCompatibilityKey = Symbol.for('bnh.abort-signal-compatibility');

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new TextEncoder().encode(String(value));
}

/** Map Node-shaped compatibility names to already-assembled grants. */
export function createCapabilityCompatibility(capabilities) {
  if (!capabilities?.manifest || !capabilities.vfs || !capabilities.output) {
    const error = new Error('browser capabilities were not assembled');
    error.code = 'ERR_CAPABILITY_DENIED';
    throw error;
  }
  const stdout = ensureOutputStream(capabilities.output.stdout);
  const stderr = ensureOutputStream(capabilities.output.stderr);
  return Object.freeze({
    fs: capabilities.vfs.fs,
    promises: capabilities.vfs.fs.promises,
    stdout,
    stderr,
    envKeys: Object.freeze([...capabilities.manifest.envVars.allowed]),
  });
}

function encodeComponent(value) {
  return encodeURIComponent(String(value));
}

function decodeComponent(value) {
  return decodeURIComponent(String(value).replace(/\+/g, ' '));
}

function appendQueryValue(target, key, value) {
  if (target[key] === undefined) target[key] = value;
  else if (Array.isArray(target[key])) target[key].push(value);
  else target[key] = [target[key], value];
}

export function createQuerystring() {
  const stringify = (value, separator = '&', equal = '=') => Object.entries(value || {})
    .flatMap(([key, item]) => (Array.isArray(item) ? item : [item]).map((entry) => (
      `${encodeComponent(key)}${equal}${entry === null || entry === undefined ? '' : encodeComponent(entry)}`
    )))
    .join(separator);
  const parse = (value, separator = '&', equal = '=') => {
    const result = {};
    for (const part of String(value || '').split(separator)) {
      if (!part) continue;
      const index = part.indexOf(equal);
      const key = decodeComponent(index < 0 ? part : part.slice(0, index));
      const item = decodeComponent(index < 0 ? '' : part.slice(index + equal.length));
      appendQueryValue(result, key, item);
    }
    return result;
  };
  return Object.freeze({
    stringify,
    encode: stringify,
    parse,
    decode: parse,
    escape: encodeURIComponent,
    unescape: decodeURIComponent,
  });
}

export function createStringDecoder() {
  return class StringDecoder {
    constructor(encoding = 'utf8') {
      const normalized = String(encoding).toLowerCase();
      this.encoding = normalized;
      const browserEncoding = normalized === 'utf8' ? 'utf-8' : normalized;
      this.decoder = new TextDecoder(browserEncoding === 'utf-8' ? browserEncoding : 'utf-8');
    }

    write(value) {
      return this.decoder.decode(bytes(value), { stream: true });
    }

    end(value) {
      return `${value === undefined ? '' : this.decoder.decode(bytes(value), { stream: true })}${this.decoder.decode()}`;
    }
  };
}

function tag(value) {
  return Object.prototype.toString.call(value);
}

function isError(value) {
  return tag(value) === '[object Error]' || value instanceof Error;
}

function isFunction(value) {
  return typeof value === 'function';
}

function isNull(value) {
  return value === null;
}

function isNullOrUndefined(value) {
  return value === null || value === undefined;
}

function isNumber(value) {
  return typeof value === 'number';
}

function isString(value) {
  return typeof value === 'string';
}

function isSymbol(value) {
  return typeof value === 'symbol';
}

function isUndefined(value) {
  return value === undefined;
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function isPrimitive(value) {
  return value === null || (typeof value !== 'object' && typeof value !== 'function');
}

function isRegExp(value) {
  return tag(value) === '[object RegExp]';
}

const NOT_HTTP_TOKEN_CODE_POINT = /[^!#$%&'*+\-.^_`|~A-Za-z0-9]/;
const NOT_HTTP_QUOTED_STRING_CODE_POINT = /[^\t\u0020-~\u0080-\u00FF]/;

function invalidMimeSyntax(production, value, invalidIndex) {
  const suffix = invalidIndex === -1 ? '' : ` at ${invalidIndex}`;
  const error = new TypeError(`The MIME syntax for a ${production} in "${value}" is invalid${suffix}`);
  error.code = 'ERR_INVALID_MIME_SYNTAX';
  return error;
}

class MIMEParams {
  #data = new Map();

  delete(name) {
    this.#data.delete(name);
  }

  get(name) {
    return this.#data.has(name) ? this.#data.get(name) : null;
  }

  has(name) {
    return this.#data.has(name);
  }

  set(name, value) {
    name = `${name}`;
    value = `${value}`;
    const invalidNameIndex = name.search(NOT_HTTP_TOKEN_CODE_POINT);
    if (name.length === 0 || invalidNameIndex !== -1) {
      throw invalidMimeSyntax('parameter name', name, invalidNameIndex);
    }
    const invalidValueIndex = value.search(NOT_HTTP_QUOTED_STRING_CODE_POINT);
    if (invalidValueIndex !== -1) {
      throw invalidMimeSyntax('parameter value', value, invalidValueIndex);
    }
    this.#data.set(name, value);
  }

  *entries() {
    yield* this.#data.entries();
  }

  *keys() {
    yield* this.#data.keys();
  }

  *values() {
    yield* this.#data.values();
  }

  toString() {
    let result = '';
    for (const [key, value] of this.#data) {
      if (result.length) result += ';';
      const encoded = value.length === 0 || NOT_HTTP_TOKEN_CODE_POINT.test(value)
        ? `"${value.replace(/[\\"]/g, (character) => `\\${character}`)}"`
        : value;
      result += `${key}=${encoded}`;
    }
    return result;
  }
}

Object.defineProperty(MIMEParams.prototype, Symbol.iterator, {
  configurable: true,
  value: MIMEParams.prototype.entries,
  writable: true,
});
Object.defineProperty(MIMEParams.prototype, 'toJSON', {
  configurable: true,
  value: MIMEParams.prototype.toString,
  writable: true,
});

function typedArray(value) {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function invalidArgumentType(name, expected, value) {
  const received = value === null ? 'null' : Array.isArray(value) ? 'an instance of Array'
    : value === undefined ? 'undefined' : `type ${typeof value}`;
  const error = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${received}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function invalidArgumentValue(name, value, reason) {
  const error = new TypeError(`The property '${name}' must be ${reason}. Received ${String(value)}`);
  error.code = 'ERR_INVALID_ARG_VALUE';
  return error;
}

function validateParseArgsConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw invalidArgumentType('config', 'object', config);
  }
  const args = config.args ?? undefined;
  if (args !== undefined && !Array.isArray(args)) throw invalidArgumentType('args', 'an Array', args);
  const strict = config.strict ?? true;
  if (typeof strict !== 'boolean') throw invalidArgumentType('strict', 'boolean', strict);
  const allowPositionals = config.allowPositionals ?? !strict;
  if (typeof allowPositionals !== 'boolean') throw invalidArgumentType('allowPositionals', 'boolean', allowPositionals);
  const tokens = config.tokens ?? false;
  if (typeof tokens !== 'boolean') throw invalidArgumentType('tokens', 'boolean', tokens);
  const allowNegative = config.allowNegative ?? false;
  if (typeof allowNegative !== 'boolean') throw invalidArgumentType('allowNegative', 'boolean', allowNegative);
  const options = config.options ?? Object.create(null);
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw invalidArgumentType('options', 'object', options);
  }
  for (const [longOption, option] of Object.entries(options)) {
    if (option === null || typeof option !== 'object' || Array.isArray(option)) {
      throw invalidArgumentType(`options.${longOption}`, 'object', option);
    }
    if (option.type !== 'string' && option.type !== 'boolean') {
      throw invalidArgumentValue(`options.${longOption}.type`, option.type, "'string' or 'boolean'");
    }
    if (Object.hasOwn(option, 'short')) {
      if (typeof option.short !== 'string') throw invalidArgumentType(`options.${longOption}.short`, 'string', option.short);
      if ([...option.short].length !== 1) {
        throw invalidArgumentValue(`options.${longOption}.short`, option.short, 'a single character');
      }
    }
    if (Object.hasOwn(option, 'multiple') && typeof option.multiple !== 'boolean') {
      throw invalidArgumentType(`options.${longOption}.multiple`, 'boolean', option.multiple);
    }
    if (Object.hasOwn(option, 'default') && option.default !== undefined) {
      const multiple = option.multiple === true;
      if (option.type === 'string' && (multiple ? !Array.isArray(option.default) || option.default.some((value) => typeof value !== 'string') : typeof option.default !== 'string')) {
        throw invalidArgumentType(`options.${longOption}.default`, multiple ? 'an array of strings' : 'string', option.default);
      }
      if (option.type === 'boolean' && (multiple ? !Array.isArray(option.default) || option.default.some((value) => typeof value !== 'boolean') : typeof option.default !== 'boolean')) {
        throw invalidArgumentType(`options.${longOption}.default`, multiple ? 'an array of booleans' : 'boolean', option.default);
      }
    }
  }
  return { args, strict, allowPositionals, tokens, allowNegative, options };
}

function optionHas(options, name) {
  return Object.prototype.hasOwnProperty.call(options, name);
}

function optionValue(options, name, property) {
  return options[name]?.[property];
}

function isOptionLikeValue(value) {
  return value != null && value.length > 1 && value[0] === '-';
}

function isOptionValue(value) {
  return value != null;
}

function findLongOptionForShort(short, options) {
  for (const [name, option] of Object.entries(options)) if (option.short === short) return name;
  return short;
}

function argsToTokens(args, options) {
  const tokens = [];
  const remaining = [...args];
  let index = -1;
  let groupCount = 0;
  while (remaining.length > 0) {
    const arg = remaining.shift();
    const next = remaining[0];
    if (groupCount > 0) groupCount -= 1;
    else index += 1;
    if (arg === '--') {
      tokens.push({ kind: 'option-terminator', index });
      for (const value of remaining) tokens.push({ kind: 'positional', index: ++index, value });
      break;
    }
    if (/^-[^-]$/.test(arg)) {
      const short = arg[1];
      const name = findLongOptionForShort(short, options);
      let value;
      let inlineValue;
      if (optionValue(options, name, 'type') === 'string' && isOptionValue(next)) {
        value = remaining.shift();
        inlineValue = false;
      }
      tokens.push({ kind: 'option', name, rawName: arg, index, value, inlineValue });
      if (value !== undefined) index += 1;
      continue;
    }
    if (/^-[^-]{2,}$/.test(arg) && optionValue(options, findLongOptionForShort(arg[1], options), 'type') !== 'string') {
      const expanded = [];
      for (let shortIndex = 1; shortIndex < arg.length; shortIndex += 1) {
        const name = findLongOptionForShort(arg[shortIndex], options);
        if (optionValue(options, name, 'type') !== 'string' || shortIndex === arg.length - 1) {
          expanded.push(`-${arg[shortIndex]}`);
        } else {
          expanded.push(`-${arg.slice(shortIndex)}`);
          break;
        }
      }
      remaining.unshift(...expanded);
      groupCount = expanded.length;
      continue;
    }
    if (/^-[^-].+$/.test(arg)) {
      const short = arg[1];
      const name = findLongOptionForShort(short, options);
      if (name !== undefined && optionValue(options, name, 'type') === 'string') {
        tokens.push({ kind: 'option', name, rawName: `-${short}`, index, value: arg.slice(2), inlineValue: true });
        continue;
      }
    }
    if (arg.startsWith('--') && !arg.includes('=', 2)) {
      const name = arg.slice(2);
      let value;
      let inlineValue;
      if (optionValue(options, name, 'type') === 'string' && isOptionValue(next)) {
        value = remaining.shift();
        inlineValue = false;
      }
      tokens.push({ kind: 'option', name, rawName: arg, index, value, inlineValue });
      if (value !== undefined) index += 1;
      continue;
    }
    if (arg.startsWith('--') && arg.includes('=', 2)) {
      const equal = arg.indexOf('=');
      const name = arg.slice(2, equal);
      tokens.push({ kind: 'option', name, rawName: `--${name}`, index, value: arg.slice(equal + 1), inlineValue: true });
      continue;
    }
    tokens.push({ kind: 'positional', index, value: arg });
  }
  return tokens;
}

function parseArgs(config = {}, scope = globalThis) {
  const normalized = validateParseArgsConfig(config);
  const args = normalized.args ?? (() => {
    const argv = scope?.process?.argv;
    const values = Array.isArray(argv) ? argv.slice(2) : [];
    return values;
  })();
  if (!args.every((value) => typeof value === 'string')) throw invalidArgumentType('args', 'an Array of strings', args);
  const result = { values: Object.create(null), positionals: [] };
  const tokens = argsToTokens(args, normalized.options);
  if (normalized.tokens) result.tokens = tokens;
  for (const token of tokens) {
    if (token.kind === 'positional') {
      if (!normalized.allowPositionals) {
        const error = new TypeError(`Unexpected positional argument '${token.value}'. This command does not take positional arguments`);
        error.code = 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL';
        throw error;
      }
      result.positionals.push(token.value);
      continue;
    }
    if (token.kind !== 'option') continue;
    let name = token.name;
    if (normalized.strict) {
      if (!optionHas(normalized.options, name)) {
        if (!(normalized.allowNegative && name.startsWith('no-') && optionHas(normalized.options, name.slice(3)) && optionValue(normalized.options, name.slice(3), 'type') === 'boolean')) {
          const error = new TypeError(`Unknown option '${token.rawName}'`);
          error.code = 'ERR_PARSE_ARGS_UNKNOWN_OPTION';
          throw error;
        }
      }
      const type = normalized.allowNegative && name.startsWith('no-') && token.value === undefined
        ? optionValue(normalized.options, name.slice(3), 'type') : optionValue(normalized.options, name, 'type');
      if (type === 'string' && typeof token.value !== 'string') {
        const error = new TypeError(`Option '--${name} <value>' argument missing`);
        error.code = 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE';
        throw error;
      }
      if (type === 'boolean' && token.value != null) {
        const error = new TypeError(`Option '--${name}' does not take an argument`);
        error.code = 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE';
        throw error;
      }
      if (!token.inlineValue && isOptionLikeValue(token.value)) {
        const error = new TypeError(`Option '${token.rawName}' argument is ambiguous.`);
        error.code = 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE';
        throw error;
      }
    }
    if (normalized.allowNegative && name.startsWith('no-') && token.value === undefined
      && optionValue(normalized.options, name.slice(3), 'type') === 'boolean') {
      name = name.slice(3);
      token.name = name;
      token.value = false;
    }
    if (name === '__proto__') continue;
    const value = token.value ?? true;
    if (optionValue(normalized.options, name, 'multiple')) {
      (result.values[name] ||= []).push(value);
    } else {
      result.values[name] = value;
    }
  }
  for (const [name, option] of Object.entries(normalized.options)) {
    if (!Object.hasOwn(result.values, name) && Object.hasOwn(option, 'default')) result.values[name] = option.default;
  }
  return result;
}

function parseEnv(content) {
  if (typeof content !== 'string') throw invalidArgumentType('content', 'string', content);
  const result = {};
  const trim = (value) => value.replace(/^[ \t\n]+|[ \t\n]+$/g, '');
  let remaining = trim(content.replaceAll('\r', ''));
  while (remaining) {
    if (remaining[0] === '\n' || remaining[0] === '#') {
      const newline = remaining.indexOf('\n');
      remaining = newline === -1 ? '' : remaining.slice(newline + 1);
      continue;
    }
    const separator = remaining.search(/[=\n]/);
    if (separator === -1 || remaining[separator] === '\n') {
      remaining = separator === -1 ? '' : trim(remaining.slice(separator + 1));
      continue;
    }
    let key = trim(remaining.slice(0, separator));
    remaining = remaining.slice(separator + 1);
    if (!remaining || remaining[0] === '\n') {
      result[key] = '';
      continue;
    }
    remaining = trim(remaining);
    if (!key) continue;
    if (key.startsWith('export ')) key = trim(key.slice(7));
    if (!remaining) {
      result[key] = '';
      break;
    }
    if (remaining[0] === '"') {
      const closing = remaining.indexOf('"', 1);
      if (closing !== -1) {
        result[key] = remaining.slice(1, closing).replaceAll('\\n', '\n');
        const newline = remaining.indexOf('\n', closing + 1);
        remaining = newline === -1 ? '' : remaining.slice(newline + 1);
        continue;
      }
    }
    if (['\'', '"', '`'].includes(remaining[0])) {
      const quote = remaining[0];
      const closing = remaining.indexOf(quote, 1);
      if (closing === -1) {
        const newline = remaining.indexOf('\n');
        if (newline === -1) {
          result[key] = remaining;
          break;
        }
        result[key] = remaining.slice(0, newline);
        remaining = remaining.slice(newline + 1);
      } else {
        result[key] = remaining.slice(1, closing);
        const newline = remaining.indexOf('\n', closing + 1);
        remaining = newline === -1 ? '' : remaining.slice(newline + 1);
      }
      continue;
    }
    const newline = remaining.indexOf('\n');
    let value = newline === -1 ? remaining : remaining.slice(0, newline);
    const hash = value.indexOf('#');
    if (hash !== -1) value = value.slice(0, hash);
    result[key] = trim(value);
    remaining = newline === -1 ? '' : remaining.slice(newline + 1);
    remaining = trim(remaining);
  }
  return result;
}

const ansiControlCharacters = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*' +
  '(?:(?:(?:(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]+)*' +
  '|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]*)*)?' +
  '(?:\\u0007|\\u001B\\u005C|\\u009C))' +
  '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?' +
  '[\\dA-PR-TZcf-nq-uy=><~]))', 'g',
);

function stripVTControlCharacters(value) {
  if (typeof value !== 'string') throw invalidArgumentType('str', 'string', value);
  return value.replace(ansiControlCharacters, '');
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${now.getDate()} ${months[now.getMonth()]} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function log(scope, ...args) {
  const output = `${timestamp()} - ${formatConsole(args)}\n`;
  if (typeof scope?.process?.stdout?.write === 'function') scope.process.stdout.write(output);
  else (scope?.console || console).log(output.trimEnd());
}

function setTraceSigInt() {
  // Browser contexts do not expose a process-level SIGINT watchdog. Keeping
  // this operation a no-op is the browser-safe equivalent of disabling it.
}

const styleTextColors = Object.freeze({
  reset: [0, 0], bold: [1, 22], dim: [2, 22], italic: [3, 23], underline: [4, 24],
  blink: [5, 25], inverse: [7, 27], hidden: [8, 28], strikethrough: [9, 29],
  doubleunderline: [21, 24], black: [30, 39], red: [31, 39], green: [32, 39],
  yellow: [33, 39], blue: [34, 39], magenta: [35, 39], cyan: [36, 39], white: [37, 39],
  gray: [90, 39], grey: [90, 39], bgBlack: [40, 49], bgRed: [41, 49], bgGreen: [42, 49],
  bgYellow: [43, 49], bgBlue: [44, 49], bgMagenta: [45, 49], bgCyan: [46, 49], bgWhite: [47, 49],
  bgGray: [100, 49], bgGrey: [100, 49],
});

function styleText(format, text, options, scope = globalThis) {
  const formats = Array.isArray(format) ? format : [format];
  if (!Array.isArray(format) && typeof format !== 'string') {
    throw invalidArgumentValue('format', format, 'a valid style format');
  }
  if (typeof text !== 'string') throw invalidArgumentType('text', 'string', text);
  if (!formats.every((value) => typeof value === 'string' && (value === 'none' || styleTextColors[value]))) {
    throw invalidArgumentValue('format', format, 'a valid style format');
  }
  if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) {
    throw invalidArgumentType('options', 'an Object', options);
  }
  const validateStream = options?.validateStream ?? true;
  if (typeof validateStream !== 'boolean') throw invalidArgumentType('options.validateStream', 'boolean', validateStream);
  const stream = options?.stream;
  if (stream !== undefined && (stream === null || typeof stream !== 'object')) {
    throw invalidArgumentType('options.stream', 'a stream', stream);
  }
  if (validateStream && stream !== undefined && typeof stream.isTTY !== 'boolean') {
    throw invalidArgumentType('options.stream', 'a TTY stream', stream);
  }
  if (Array.isArray(format) && formats.length === 1) return styleText(formats[0], text, options, scope);
  const env = scope?.process?.env || {};
  if (validateStream && !env.FORCE_COLOR && stream?.isTTY === false) return text;
  if (validateStream && !env.FORCE_COLOR && (env.NO_COLOR || env.NODE_DISABLE_COLORS)) return text;
  let prefix = '';
  let suffix = '';
  let body = text;
  const restores = new Map();
  for (const value of formats) {
    if (value === 'none') continue;
    const style = styleTextColors[value];
    if (!restores.has(style[1])) restores.set(style[1], style[0]);
  }
  for (const [close, open] of restores) {
    const replacement = close >= 30 ? `\u001b[${open}m` : `\u001b[${close}m\u001b[${open}m`;
    body = body.replace(new RegExp(`\\u001b\\[${close}m(?=[\\s\\S])`, 'g'), replacement);
  }
  for (const value of formats) {
    if (value === 'none') continue;
    const style = styleTextColors[value];
    prefix += `\u001b[${style[0]}m`;
    suffix = `\u001b[${style[1]}m${suffix}`;
  }
  return `${prefix}${body}${suffix}`;
}

function toUSVString(value) {
  const string = String(value);
  if (typeof string.toWellFormed === 'function') return string.toWellFormed();
  let result = '';
  for (let index = 0; index < string.length; index += 1) {
    const code = string.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = string.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        result += string[index] + string[++index];
      } else {
        result += '\uFFFD';
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      result += '\uFFFD';
    } else {
      result += string[index];
    }
  }
  return result;
}

const transferableAbortSignalKey = Symbol.for('bnh.util.transferableAbortSignal');
const transferableAbortCompatibilityKey = Symbol.for('bnh.util.transferableAbortCompatibility');

function unsupportedTransferableAbortSignal() {
  const error = new Error('transferable AbortSignals require browser MessageChannel support');
  error.name = 'CapabilityError';
  error.code = 'ERR_UNSUPPORTED_BROWSER_BOUNDARY';
  return error;
}

function transferListValue(input) {
  if (input === undefined) return undefined;
  if (Array.isArray(input)) return input;
  if (input && typeof input === 'object' && Object.hasOwn(input, 'transfer')) return input.transfer;
  return input;
}

function replaceAbortSignalTransferValues(value, replacements, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  if (replacements.has(value)) return replacements.get(value);
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const copy = [];
    seen.set(value, copy);
    for (const item of value) copy.push(replaceAbortSignalTransferValues(item, replacements, seen));
    return copy;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    copy[key] = replaceAbortSignalTransferValues(item, replacements, seen);
  }
  return copy;
}

function restoreAbortSignalTransferValues(value, signals, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  if (value.bnhTransferMarker === 'signal' && Number.isInteger(value.id)) return signals.get(value.id) || value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const copy = [];
    seen.set(value, copy);
    for (const item of value) copy.push(restoreAbortSignalTransferValues(item, signals, seen));
    return copy;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    copy[key] = restoreAbortSignalTransferValues(item, signals, seen);
  }
  return copy;
}

function createAbortSignalTransferCompatibility(scope) {
  const MessagePortClass = scope.MessagePort;
  const MessageChannelClass = scope.MessageChannel;
  const AbortSignalClass = scope.AbortSignal;
  const AbortControllerClass = scope.AbortController;
  if (typeof MessagePortClass !== 'function' || typeof MessageChannelClass !== 'function'
      || typeof AbortSignalClass !== 'function' || typeof AbortControllerClass !== 'function') {
    return false;
  }
  const prototype = MessagePortClass.prototype;
  const nativePostMessage = prototype.postMessage;
  const nativeAddEventListener = prototype.addEventListener;
  const nativeRemoveEventListener = prototype.removeEventListener;
  if (typeof nativePostMessage !== 'function' || typeof nativeAddEventListener !== 'function'
      || typeof nativeRemoveEventListener !== 'function') return false;

  const marker = 'bnh-transferable-abort-signal';
  const listeners = new WeakMap();
  const onMessages = new WeakMap();

  const decodeEvent = (event) => {
    const envelope = event?.data;
    if (!envelope || envelope[marker] !== true) return event;
    const signals = new Map();
    for (const record of envelope.signals || []) {
      const controller = new AbortControllerClass();
      const signal = controller.signal;
      try { Object.defineProperty(signal, transferableAbortSignalKey, { configurable: true, value: true }); } catch { /* host signal may be sealed */ }
      signals.set(record.id, signal);
      const bridge = record.port?.raw || record.port;
      if (bridge && typeof bridge.addEventListener === 'function') {
        nativeAddEventListener.call(bridge, 'message', (abortEvent) => {
          if (abortEvent?.data?.[marker] !== 'abort' || signal.aborted) return;
          controller.abort(abortEvent.data.reason);
          bridge.close?.();
        });
        bridge.start?.();
      }
      if (record.aborted) controller.abort(record.reason);
    }
    const data = restoreAbortSignalTransferValues(envelope.data, signals);
    const decoded = { data };
    for (const property of ['type', 'bubbles', 'cancelable', 'composed', 'origin', 'lastEventId', 'source', 'ports']) {
      try { decoded[property] = event[property]; } catch { /* browser event property is optional */ }
    }
    return decoded;
  };

  const wrapListener = (port, listener) => {
    if (typeof listener !== 'function' && (!listener || typeof listener.handleEvent !== 'function')) return listener;
    const wrapped = function onMessage(event) {
      const decoded = decodeEvent(event);
      if (typeof listener === 'function') listener.call(this, decoded);
      else listener.handleEvent.call(listener, decoded);
    };
    let portListeners = listeners.get(port);
    if (!portListeners) {
      portListeners = new Map();
      listeners.set(port, portListeners);
    }
    portListeners.set(listener, wrapped);
    return wrapped;
  };

  prototype.postMessage = function postMessage(value, options) {
    const transfer = transferListValue(options);
    const list = transfer === undefined ? [] : Array.from(transfer || []);
    const abortSignals = list.filter((item) => item?.[transferableAbortSignalKey] === true);
    if (abortSignals.length === 0) return nativePostMessage.call(this, value, options);
    const replacements = new Map();
    const signals = [];
    const nativeTransfers = [];
    for (const [index, signal] of abortSignals.entries()) {
      const bridge = new MessageChannelClass();
      const bridgePort1 = bridge.port1?.raw || bridge.port1;
      const bridgePort2 = bridge.port2?.raw || bridge.port2;
      const id = index;
      replacements.set(signal, { bnhTransferMarker: 'signal', id });
      signals.push({
        id,
        port: bridgePort2,
        aborted: signal.aborted,
        reason: signal.reason,
      });
      nativeTransfers.push(bridgePort2);
      signal.addEventListener('abort', () => {
        try { nativePostMessage.call(bridgePort1, { [marker]: 'abort', reason: signal.reason }); } catch { /* destination may be closed */ }
      }, { once: true });
    }
    for (const item of list) if (!abortSignals.includes(item)) nativeTransfers.push(item);
    const payload = {
      [marker]: true,
      data: replaceAbortSignalTransferValues(value, replacements),
      signals,
    };
    return nativePostMessage.call(this, payload, nativeTransfers);
  };

  prototype.addEventListener = function addEventListener(type, listener, options) {
    const wrapped = type === 'message' ? wrapListener(this, listener) : listener;
    return nativeAddEventListener.call(this, type, wrapped, options);
  };

  prototype.removeEventListener = function removeEventListener(type, listener, options) {
    const wrapped = type === 'message' ? listeners.get(this)?.get(listener) || listener : listener;
    listeners.get(this)?.delete(listener);
    return nativeRemoveEventListener.call(this, type, wrapped, options);
  };

  const nativeOnMessage = Object.getOwnPropertyDescriptor(prototype, 'onmessage');
  if (nativeOnMessage?.configurable) {
    Object.defineProperty(prototype, 'onmessage', {
      configurable: true,
      enumerable: nativeOnMessage.enumerable,
      get() { return onMessages.get(this)?.listener || null; },
      set(listener) {
        const previous = onMessages.get(this);
        if (previous) nativeRemoveEventListener.call(this, 'message', previous.wrapped);
        if (listener === null || listener === undefined) {
          onMessages.delete(this);
          return;
        }
        const wrapped = wrapListener(this, listener);
        onMessages.set(this, { listener, wrapped });
        nativeAddEventListener.call(this, 'message', wrapped);
      },
    });
  }
  return true;
}

function markTransferableAbortSignal(scope, signal) {
  if (!(signal instanceof scope.AbortSignal)) throw invalidArgumentType('signal', 'an instance of AbortSignal', signal);
  if (!scope[transferableAbortCompatibilityKey]) {
    const installed = createAbortSignalTransferCompatibility(scope);
    if (!installed) throw unsupportedTransferableAbortSignal();
    Object.defineProperty(scope, transferableAbortCompatibilityKey, { configurable: true, value: true });
  }
  try { Object.defineProperty(signal, transferableAbortSignalKey, { configurable: true, value: true }); } catch { /* host signal may be sealed */ }
  return signal;
}

function transferableAbortController(scope) {
  const controller = new scope.AbortController();
  markTransferableAbortSignal(scope, controller.signal);
  return controller;
}

function transferableAbortSignal(scope, signal) {
  return markTransferableAbortSignal(scope, signal);
}

const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
// Node exposes the callback result names through this well-known symbol.
// Keeping the exact registry key matters because callers define it without
// importing any runtime-specific helper.
const promisifyArgs = Symbol.for('nodejs.util.promisify.customArgs');

function invalidFunctionArgument(name, value) {
  const received = value === null ? 'null' : typeof value;
  const error = new TypeError(`The "${name}" argument must be of type function. Received ${received}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

export function createPromisify() {
  function promisify(original) {
    if (typeof original !== 'function') throw invalidFunctionArgument('original', original);

    const custom = original[promisifyCustom];
    if (custom !== undefined) {
      if (typeof custom !== 'function') throw invalidFunctionArgument('util.promisify.custom', custom);
      Object.defineProperty(custom, promisifyCustom, {
        configurable: true,
        enumerable: false,
        value: custom,
        writable: false,
      });
      return custom;
    }

    const argumentNames = original[promisifyArgs];
    const wrapped = function promisified(...args) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const callback = (error, ...values) => {
          if (settled) return;
          settled = true;
          if (error) {
            reject(error);
            return;
          }
          if (Array.isArray(argumentNames) && values.length > 1) {
            resolve(Object.fromEntries(argumentNames.map((name, index) => [name, values[index]])));
          } else {
            resolve(values[0]);
          }
        };
        try {
          Reflect.apply(original, this, [...args, callback]);
        } catch (error) {
          reject(error);
        }
      });
    };

    Object.setPrototypeOf(wrapped, Object.getPrototypeOf(original));
    Object.defineProperty(wrapped, promisifyCustom, {
      configurable: true,
      enumerable: false,
      value: wrapped,
      writable: false,
    });
    for (const key of Reflect.ownKeys(original)) {
      if (key === 'length' || key === 'name' || key === 'prototype' || key === promisifyCustom) continue;
      const descriptor = Object.getOwnPropertyDescriptor(original, key);
      if (descriptor) {
        try { Object.defineProperty(wrapped, key, descriptor); } catch { /* function metadata can be non-configurable */ }
      }
    }
    return wrapped;
  }

  Object.defineProperty(promisify, 'custom', {
    configurable: false,
    enumerable: true,
    value: promisifyCustom,
    writable: false,
  });
  return promisify;
}

export function createUtilModule(scope = globalThis) {
  const types = createUtilTypes(scope);
  return Object.freeze({
    MIMEParams,
    isError,
    isFunction,
    isNull,
    isNullOrUndefined,
    isNumber,
    isString,
    isSymbol,
    isUndefined,
    isObject,
    isPrimitive,
    isRegExp,
    log: (...args) => log(scope, ...args),
    parseArgs: (config) => parseArgs(config, scope),
    parseEnv,
    promisify: createPromisify(),
    styleText: (format, text, options) => styleText(format, text, options, scope),
    setTraceSigInt,
    stripVTControlCharacters,
    customPromisifyArgs: promisifyArgs,
    toUSVString,
    transferableAbortController: () => transferableAbortController(scope),
    transferableAbortSignal: (signal) => transferableAbortSignal(scope, signal),
    types,
  });
}

export function createUtilTypes(scope = globalThis) {
  const isTag = (name) => (value) => tag(value) === `[object ${name}]`;
  return Object.freeze({
    isAnyArrayBuffer: (value) => value instanceof ArrayBuffer || (typeof scope.SharedArrayBuffer === 'function' && value instanceof scope.SharedArrayBuffer),
    isArrayBuffer: (value) => value instanceof ArrayBuffer,
    isArrayBufferView: (value) => ArrayBuffer.isView(value),
    isArgumentsObject: isTag('Arguments'),
    isAsyncFunction: isTag('AsyncFunction'),
    isBigInt64Array: (value) => value instanceof BigInt64Array,
    isBigUint64Array: (value) => value instanceof BigUint64Array,
    isBooleanObject: isTag('Boolean'),
    isBoxedPrimitive: (value) => ['Boolean', 'Number', 'String', 'BigInt', 'Symbol'].includes(tag(value).slice(8, -1)),
    isCryptoKey: (value) => typeof scope.CryptoKey === 'function' && value instanceof scope.CryptoKey,
    isDataView: (value) => value instanceof DataView,
    isDate: isTag('Date'),
    isFloat32Array: (value) => value instanceof Float32Array,
    isFloat64Array: (value) => value instanceof Float64Array,
    isGeneratorFunction: isTag('GeneratorFunction'),
    isGeneratorObject: isTag('Generator'),
    isInt16Array: (value) => value instanceof Int16Array,
    isInt32Array: (value) => value instanceof Int32Array,
    isInt8Array: (value) => value instanceof Int8Array,
    isMap: (value) => value instanceof Map,
    isNativeError: (value) => value instanceof Error,
    isNumberObject: isTag('Number'),
    isPromise: (value) => value instanceof Promise,
    isRegExp,
    isSet: (value) => value instanceof Set,
    isSharedArrayBuffer: (value) => typeof scope.SharedArrayBuffer === 'function' && value instanceof scope.SharedArrayBuffer,
    isStringObject: isTag('String'),
    isSymbolObject: isTag('Symbol'),
    isTypedArray: typedArray,
    isUint16Array: (value) => value instanceof Uint16Array,
    isUint32Array: (value) => value instanceof Uint32Array,
    isUint8Array: (value) => value instanceof Uint8Array,
    isUint8ClampedArray: (value) => value instanceof Uint8ClampedArray,
    isWeakMap: (value) => value instanceof WeakMap,
    isWeakSet: (value) => value instanceof WeakSet,
    isProxy: () => false,
    isExternal: () => false,
    isMapIterator: (value) => tag(value) === '[object Map Iterator]',
    isSetIterator: (value) => tag(value) === '[object Set Iterator]',
    isModuleNamespaceObject: (value) => tag(value) === '[object Module]',
  });
}

export function createConstants() {
  return Object.freeze({
    O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024,
    O_NOCTTY: 256, O_NONBLOCK: 2048, O_DSYNC: 4096, O_DIRECT: 16384,
    O_DIRECTORY: 65536, O_NOFOLLOW: 131072, O_NOATIME: 0x40000, O_SYNC: 1052672,
    F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
    SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGPIPE: 13,
    UV_DIRENT_FILE: 1, UV_DIRENT_DIR: 2, UV_DIRENT_LINK: 3,
    crypto: Object.freeze({
      ENGINE_METHOD_ALL: 0,
      POINT_CONVERSION_COMPRESSED: 2,
      SSL_OP_ALL: 2147485776,
      SSL_OP_ALLOW_NO_DHE_KEX: 1024,
      SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION: 262144,
      SSL_OP_CIPHER_SERVER_PREFERENCE: 4194304,
      SSL_OP_CISCO_ANYCONNECT: 32768,
      SSL_OP_COOKIE_EXCHANGE: 8192,
    }),
  });
}

function quoteConsoleString(value) {
  return `'${String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')}'`;
}

function inspectConsole(value, options = {}, state = { seen: new WeakSet(), depth: 0 }) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return quoteConsoleString(value);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (Object.is(value, -0)) return '-0';
    return String(value);
  }
  if (typeof value === 'bigint' || typeof value === 'boolean' || typeof value === 'symbol') return String(value);
  if (typeof value === 'function') return `[Function${value.name ? `: ${value.name}` : ' (anonymous)'}]`;
  if (state.seen.has(value)) return '[Circular]';
  if (options.depth !== null && state.depth >= (options.depth ?? 2)) {
    if (Array.isArray(value)) return '[Array]';
    return '[Object]';
  }
  state.seen.add(value);
  const next = { ...state, depth: state.depth + 1 };
  let result;
  if (Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView))) {
    const items = Array.from(value, (entry) => inspectConsole(entry, options, next));
    result = options.multiline && items.length
      ? `[\n${items.map((entry) => `  ${entry}`).join(',\n')}\n]`
      : items.length ? `[ ${items.join(', ')} ]` : '[]';
  } else if (value instanceof Date) {
    result = Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  } else if (value instanceof Map) {
    result = `Map(${value.size}) { ${[...value].map(([key, entry]) => `${inspectConsole(key, options, next)} => ${inspectConsole(entry, options, next)}`).join(', ')} }`;
  } else if (value instanceof Set) {
    result = `Set(${value.size}) { ${[...value].map((entry) => inspectConsole(entry, options, next)).join(', ')} }`;
  } else {
    const keys = Object.keys(value);
    const entries = keys.map((key) => {
      const label = /^[A-Za-z_$][\w$]*$/.test(key) ? key : quoteConsoleString(key);
      return `${label}: ${inspectConsole(value[key], options, next)}`;
    });
    result = options.multiline && entries.length
      ? `{\n${entries.map((entry) => `  ${entry}`).join(',\n')}\n}`
      : entries.length ? `{ ${entries.join(', ')} }` : '{}';
  }
  state.seen.delete(value);
  return result;
}

function inspectValue(value, inspectOptions, useRuntimeInspect) {
  return useRuntimeInspect ? runtimeInspect(value, inspectOptions) : inspectConsole(value, inspectOptions);
}

function formatConsole(values, inspectOptions = {}, useRuntimeInspect = false) {
  if (!values.length) return '';
  if (typeof values[0] !== 'string') return values.map((value) => inspectValue(value, inspectOptions, useRuntimeInspect)).join(' ');
  let index = 1;
  const first = values[0].replace(/%[sdifjoO%]/g, (token) => {
    if (token === '%%') return '%';
    if (index >= values.length) return token;
    const value = values[index++];
    if (token === '%j') {
      try { return JSON.stringify(value); } catch { return '[Circular]'; }
    }
    if (token === '%o' || token === '%O') return inspectValue(value, inspectOptions, useRuntimeInspect);
    if (token === '%d' || token === '%i') return String(Number(value));
    if (token === '%f') return String(Number.parseFloat(value));
    return String(value);
  });
  return [first, ...values.slice(index).map((value) => typeof value === 'string' ? value : inspectValue(value, inspectOptions, useRuntimeInspect))].join(' ');
}

function invalidConsoleType(name, value, expected) {
  const received = value === null ? 'null' : value === undefined ? 'undefined' : typeof value === 'object'
    ? `an instance of ${value.constructor?.name || 'Object'}` : `type ${typeof value} (${String(value)})`;
  const error = new TypeError(`The "${name}" argument must be ${expected}. Received ${received}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function invalidInspectOptions(value) {
  const received = value === null ? 'null' : typeof value === 'boolean' ? `type boolean (${value})`
    : typeof value === 'string' ? `type string (${quoteConsoleString(value)})`
      : typeof value === 'number' ? `type number (${value})`
        : typeof value === 'symbol' ? `type symbol (${String(value)})` : String(value);
  const error = new TypeError(`The "options.inspectOptions" property must be of type object. Received ${received}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function invalidConsoleValue(name, value) {
  const error = new TypeError(`The argument '${name}' must be one of: 'auto', true, false. Received ${inspectConsole(value)}`);
  error.code = 'ERR_INVALID_ARG_VALUE';
  return error;
}

function writableConsoleStream(stream, name) {
  if (stream && typeof stream.write === 'function') return stream;
  const error = new TypeError(`Console expects a writable stream instance for ${name}`);
  error.code = 'ERR_CONSOLE_WRITABLE_STREAM';
  throw error;
}

function noop() {}

function createWriteErrorHandler(instance, streamName) {
  return (error) => {
    const stream = instance[streamName];
    if (error !== null && error !== undefined
      && !stream?._writableState?.errorEmitted
      && typeof stream?.listenerCount === 'function'
      && stream.listenerCount('error') === 0
      && typeof stream.once === 'function') {
      stream.once('error', noop);
    }
  };
}

export function installConsoleErrorHandlers(instance) {
  Object.defineProperties(instance, {
    _stdoutErrorHandler: {
      configurable: true,
      value: createWriteErrorHandler(instance, '_stdout'),
      writable: true,
    },
    _stderrErrorHandler: {
      configurable: true,
      value: createWriteErrorHandler(instance, '_stderr'),
      writable: true,
    },
  });
  return instance;
}

function writeStream(stream, value, ignoreErrors, errorHandler) {
  const output = `${value}\n`;
  if (ignoreErrors === false) {
    stream.write(output);
    return;
  }

  try {
    // Catch synchronous stream errors and keep asynchronous errors from
    // becoming uncaught exceptions. The temporary listener is removed after
    // the write so it cannot affect later non-console writes.
    if (typeof stream.listenerCount === 'function'
      && stream.listenerCount('error') === 0
      && typeof stream.once === 'function') {
      stream.once('error', noop);
    }
    stream.write(output, errorHandler);
  } catch (error) {
    // Console is a debugging utility; do not swallow stack overflows caused
    // by a synchronous write implementation.
    if (error instanceof RangeError) throw error;
  } finally {
    stream.removeListener?.('error', noop);
  }
}

function stringWidth(value) {
  return [...String(value)].reduce((width, character) => {
    const code = character.codePointAt(0);
    return width + ((code >= 0x1100 && (code <= 0x115f || code >= 0x2e80)) ? 2 : 1);
  }, 0);
}

const TABLE_UNDEFINED = Symbol('console.table.undefined');

function tableRows(data, properties) {
  const iteratorTag = Object.prototype.toString.call(data);
  if (data instanceof Map || iteratorTag === '[object Map Iterator]') {
    const entries = data instanceof Map ? [...data] : [...data];
    if (data instanceof Map || entries.every((entry) => Array.isArray(entry) && entry.length === 2)) {
      return { index: '(iteration index)', rows: entries.map(([key, value], index) => ({ index, key, value })), columns: ['Key', 'Values'], values: (row, column) => column === 'Key' ? row.key : row.value };
    }
    return { index: '(iteration index)', rows: entries.map((value, index) => ({ index, value })), columns: ['Values'], values: (row) => row.value };
  }
  if (data && (data instanceof Set || iteratorTag === '[object Set Iterator]')) {
    const values = data instanceof Set ? [...data] : [...data];
    return { index: '(iteration index)', rows: values.map((value, index) => ({ index, value })), columns: ['Values'], values: (row) => row.value };
  }
  if (Array.isArray(data) || (ArrayBuffer.isView(data) && !(data instanceof DataView))) {
    const rows = Array.from(data, (value, index) => ({ index, value }));
    const nested = new Set();
    let hasValues = false;
    for (const row of rows) {
      if (row.value && typeof row.value === 'object' && !Array.isArray(row.value)) for (const key of Object.keys(row.value)) nested.add(key);
      if (Array.isArray(row.value)) for (let index = 0; index < row.value.length; index += 1) nested.add(String(index));
      if (row.value === null || typeof row.value !== 'object') hasValues = true;
    }
    const columns = rows.length === 0 ? [] : [...nested, ...(hasValues ? ['Values'] : nested.size ? [] : ['Values'])];
    return {
      index: '(index)', rows, columns,
      values: (row, column) => column === 'Values' && (row.value === null || typeof row.value !== 'object')
        ? row.value === undefined ? TABLE_UNDEFINED : row.value
        : row.value && Object.prototype.hasOwnProperty.call(row.value, column) ? row.value[column] : undefined,
    };
  }
  const rows = Object.keys(Object(data)).map((key) => ({ index: key, value: data[key] }));
  const nested = new Set();
  let hasValues = false;
  for (const row of rows) {
    if (row.value && typeof row.value === 'object' && !Array.isArray(row.value)) for (const key of Object.keys(row.value)) nested.add(key);
    if (Array.isArray(row.value)) for (let index = 0; index < row.value.length; index += 1) nested.add(String(index));
    if (row.value === null || typeof row.value !== 'object') hasValues = true;
  }
  const columns = rows.length === 0 ? [] : [...nested, ...(hasValues ? ['Values'] : nested.size ? [] : ['Values'])];
  return {
    index: '(index)', rows, columns,
    values: (row, column) => column === 'Values' && (row.value === null || typeof row.value !== 'object')
      ? row.value === undefined ? TABLE_UNDEFINED : row.value
      : row.value && Object.prototype.hasOwnProperty.call(row.value, column) ? row.value[column] : undefined,
  };
}

function formatTable(data, properties) {
  const table = tableRows(data, properties);
  const columns = properties === undefined ? table.columns : properties;
  const headers = [table.index, ...columns];
  const rows = table.rows.map((row) => [row.index, ...columns.map((column) => table.values(row, column))]);
  const rendered = rows.map((row) => row.map((value, index) => index === 0
    ? String(value)
    : value === TABLE_UNDEFINED ? inspectConsole(undefined) : value === undefined ? ''
      : Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView))
        ? inspectConsole(value) : inspectConsole(value, { depth: 0 })));
  const widths = headers.map((header, index) => Math.max(stringWidth(header), ...rendered.map((row) => stringWidth(row[index] || ''))));
  const border = (left, join, right, fill = '─') => left + widths.map((width) => fill.repeat(width + 2)).join(join) + right;
  const line = (row) => `│${row.map((value, index) => ` ${value}${' '.repeat(widths[index] - stringWidth(value))} `).join('│')}│`;
  return [
    border('┌', '┬', '┐'),
    line(headers),
    border('├', '┼', '┤'),
    ...rendered.map(line),
    border('└', '┴', '┘'),
  ].join('\n');
}

export function createConsoleModule(processObject) {
  const methods = ['log', 'info', 'debug', 'warn', 'error', 'dir', 'time', 'timeEnd', 'timeLog', 'timeStamp', 'trace', 'assert', 'clear', 'count', 'countReset', 'group', 'groupEnd', 'table', 'dirxml', 'groupCollapsed'];
  function Console(stdoutOrOptions, stderr, ignoreErrors) {
    if (!new.target) return new Console(...arguments);
    let options = {};
    if (stdoutOrOptions && typeof stdoutOrOptions === 'object' && Object.hasOwn(stdoutOrOptions, 'stdout')) options = stdoutOrOptions;
    const stdout = options.stdout ?? stdoutOrOptions;
    const error = options.stderr ?? stderr ?? processObject.stderr;
    this._stdout = writableConsoleStream(stdout, 'stdout');
    this._stderr = writableConsoleStream(error, 'stderr');
    installConsoleErrorHandlers(this);
    this._ignoreErrors = options.ignoreErrors ?? ignoreErrors ?? true;
    this._inspectOptions = options.inspectOptions ?? {};
    if (options.inspectOptions !== undefined && (options.inspectOptions === null || typeof options.inspectOptions !== 'object' || Array.isArray(options.inspectOptions))) {
      throw invalidInspectOptions(options.inspectOptions);
    }
    if (options.colorMode !== undefined && !['auto', true, false].includes(options.colorMode)) throw invalidConsoleValue('colorMode', options.colorMode);
    if (options.colorMode !== undefined && options.inspectOptions?.colors !== undefined) {
      const incompatible = new TypeError('Option "options.inspectOptions.color" cannot be used in combination with option "colorMode"');
      incompatible.code = 'ERR_INCOMPATIBLE_OPTION_PAIR';
      throw incompatible;
    }
    this._colorMode = options.colorMode;
    this._groupIndentation = options.groupIndentation === undefined ? 2 : options.groupIndentation;
    if (options.groupIndentation !== undefined && typeof options.groupIndentation !== 'number') {
      throw invalidConsoleType('options.groupIndentation', options.groupIndentation, 'of type number');
    }
    if (options.groupIndentation !== undefined && !Number.isInteger(options.groupIndentation)) {
      const range = new RangeError('The property \'options.groupIndentation\' must be an integer');
      range.code = 'ERR_OUT_OF_RANGE';
      throw range;
    }
    if (this._groupIndentation < 0 || this._groupIndentation > 1000) {
      const range = new RangeError('The property \'options.groupIndentation\' must be >= 0 && <= 1000');
      range.code = 'ERR_OUT_OF_RANGE';
      throw range;
    }
    this._groupIndent = 0;
    this._times = new Map();
    this._counts = new Map();
    for (const name of methods) if (typeof this[name] === 'function') this[name] = this[name].bind(this);
  }
  const write = (instance, stream, errorHandler, values) => {
    const indentation = ' '.repeat(instance._groupIndent * instance._groupIndentation);
    const inspectOptions = instance._colorMode !== undefined || Object.keys(instance._inspectOptions).length > 0
      ? { ...instance._inspectOptions, multiline: true }
      : instance._inspectOptions;
    const text = formatConsole(values, inspectOptions, false).replaceAll('\n', `\n${indentation}`);
    writeStream(stream, `${indentation}${text}`, instance._ignoreErrors, errorHandler);
  };
  Object.assign(Console.prototype, {
    constructor: Console,
    log(...values) { write(this, this._stdout, this._stdoutErrorHandler, values); },
    info(...values) { this.log(...values); },
    debug(...values) { this.log(...values); },
    warn(...values) { write(this, this._stderr, this._stderrErrorHandler, values); },
    error(...values) { this.warn(...values); },
    dir(value) {
      const inspectOptions = this._colorMode !== undefined || Object.keys(this._inspectOptions).length > 0
        ? { ...this._inspectOptions, multiline: true }
        : this._inspectOptions;
      write(this, this._stdout, this._stdoutErrorHandler, [inspectValue(value, inspectOptions, false)]);
    },
    time(label = 'default') { if (!this._times.has(String(label))) this._times.set(String(label), Date.now()); },
    timeEnd(label = 'default') { const key = String(label); if (!this._times.has(key)) return; const duration = Date.now() - this._times.get(key); this._times.delete(key); this.log(`${key}: ${duration}ms`); },
    timeLog(label = 'default', ...values) { const key = String(label); if (!this._times.has(key)) return; const duration = Date.now() - this._times.get(key); this.log(`${key}: ${duration}ms`, ...values); },
    timeStamp() {},
    trace(...values) {
      const stack = new Error().stack?.split('\n').slice(2).join('\n') || '';
      const inspectOptions = this._colorMode !== undefined || Object.keys(this._inspectOptions).length > 0
        ? { ...this._inspectOptions, multiline: true }
        : this._inspectOptions;
      write(this, this._stderr, this._stderrErrorHandler, [`Trace: ${formatConsole(values, inspectOptions, false)}${stack ? `\n${stack}` : ''}`]);
    },
    assert(value, ...values) { if (!value) this.error('Assertion failed', ...values); },
    clear() {},
    count(label = 'default') { const key = String(label); const count = (this._counts.get(key) || 0) + 1; this._counts.set(key, count); this.log(`${key}: ${count}`); },
    countReset(label = 'default') { this._counts.delete(String(label)); },
    group(...values) { if (values.length) this.log(...values); this._groupIndent += 1; },
    groupEnd() { this._groupIndent = Math.max(0, this._groupIndent - 1); },
    table(data, properties) {
      if (properties !== undefined && !Array.isArray(properties)) throw invalidConsoleType('properties', properties, 'an instance of Array');
      if (data === null || data === undefined || typeof data !== 'object') {
        writeStream(this._stdout, typeof data === 'string' ? data : inspectConsole(data, this._inspectOptions), this._ignoreErrors, this._stdoutErrorHandler);
        return;
      }
      writeStream(this._stdout, formatTable(data, properties), this._ignoreErrors, this._stdoutErrorHandler);
    },
    dirxml(...values) { this.log(...values); },
    groupCollapsed(...values) { this.group(...values); },
  });
  const consoleObject = new Console(processObject.stdout, processObject.stderr);
  consoleObject.Console = Console;
  return Object.freeze(consoleObject);
}

async function readStream(stream) {
  if (stream?.getReader) {
    const reader = stream.getReader();
    const chunks = [];
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        chunks.push(bytes(item.value));
      }
    } finally {
      reader.releaseLock();
    }
    return chunks;
  }
  const chunks = [];
  for await (const item of stream || []) chunks.push(bytes(item));
  return chunks;
}

function joinChunks(chunks) {
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export function createStreamConsumers(scope, BufferClass) {
  const collect = async (stream) => joinChunks(await readStream(stream));
  return Object.freeze({
    arrayBuffer: async (stream) => (await collect(stream)).buffer,
    blob: async (stream) => new scope.Blob([await collect(stream)]),
    buffer: async (stream) => BufferClass.from(await collect(stream)),
    json: async (stream) => JSON.parse(new TextDecoder().decode(await collect(stream))),
    text: async (stream) => new TextDecoder().decode(await collect(stream)),
  });
}

function abortError() {
  return new DOMException('The operation was aborted', 'AbortError');
}

function installAbortSignalCompatibility(scope) {
  const AbortSignalClass = scope.AbortSignal;
  if (typeof AbortSignalClass !== 'function' || scope[abortSignalCompatibilityKey]) return;

  const state = { gcGeneration: 0, signals: new WeakMap() };
  Object.defineProperty(scope, abortSignalCompatibilityKey, { configurable: true, value: state });

  const trackSignal = (signal) => {
    if (!signal || state.signals.has(signal)) return state.signals.get(signal);
    const signalState = { strongListeners: new Set(), weakListeners: new Set() };
    state.signals.set(signal, signalState);
    return signalState;
  };
  const nativeAddEventListener = AbortSignalClass.prototype.addEventListener;
  const nativeRemoveEventListener = AbortSignalClass.prototype.removeEventListener;
  if (typeof nativeAddEventListener === 'function' && typeof nativeRemoveEventListener === 'function') {
    Object.defineProperties(AbortSignalClass.prototype, {
      addEventListener: {
        configurable: true,
        value(type, listener, options) {
          const result = Reflect.apply(nativeAddEventListener, this, [type, listener, options]);
          if (type === 'abort' && typeof listener === 'function') {
            const signalState = trackSignal(this);
            const listeners = options?.[kWeakHandler] ? signalState.weakListeners : signalState.strongListeners;
            listeners.add(listener);
          }
          return result;
        },
      },
      removeEventListener: {
        configurable: true,
        value(type, listener, options) {
          const result = Reflect.apply(nativeRemoveEventListener, this, [type, listener, options]);
          if (type === 'abort' && typeof listener === 'function') {
            const signalState = state.signals.get(this);
            signalState?.strongListeners.delete(listener);
            signalState?.weakListeners.delete(listener);
          }
          return result;
        },
      },
    });
  }

  if (typeof AbortSignalClass.timeout === 'function') {
    const nativeTimeout = AbortSignalClass.timeout.bind(AbortSignalClass);
    const timeout = (milliseconds) => {
      const nativeSignal = nativeTimeout(milliseconds);
      trackSignal(nativeSignal);
      const controller = new scope.AbortController();
      const abort = () => controller.abort(new scope.DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      ));
      if (nativeSignal.aborted) abort();
      else nativeSignal.addEventListener('abort', abort, { once: true, [kWeakHandler]: true });
      trackSignal(controller.signal);
      return controller.signal;
    };
    try { AbortSignalClass.timeout = timeout; } catch { /* native method is immutable */ }
  }

  if (typeof AbortSignalClass.any === 'function') {
    const nativeAny = AbortSignalClass.any.bind(AbortSignalClass);
    const receivedType = (value) => value === null ? 'null' : value === undefined ? 'undefined' : typeof value;
    const any = (signals) => {
      if (signals === null || signals === undefined || typeof signals[Symbol.iterator] !== 'function') {
        const error = new TypeError(`The "signals" argument must be an iterable of AbortSignal instances. Received ${receivedType(signals)}`);
        error.code = 'ERR_INVALID_ARG_TYPE';
        throw error;
      }
      const values = [...signals];
      for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        if (!(value instanceof AbortSignalClass)) {
          const error = new TypeError(`The "signals[${index}]" argument must be an instance of AbortSignal. Received ${receivedType(value)}`);
          error.code = 'ERR_INVALID_ARG_TYPE';
          throw error;
        }
      }
      const signal = nativeAny(values);
      trackSignal(signal);
      return signal;
    };
    try { AbortSignalClass.any = any; } catch { /* native method is immutable */ }
  }

  const signalConstructor = function AbortSignal() {
    const error = new TypeError('Illegal constructor');
    error.code = 'ERR_ILLEGAL_CONSTRUCTOR';
    throw error;
  };
  try {
    Object.defineProperty(AbortSignalClass.prototype, 'constructor', {
      configurable: true,
      value: signalConstructor,
      writable: true,
    });
  } catch { /* browser prototype is immutable */ }

  if (typeof scope.Event === 'function' && scope.Event.prototype
      && !Object.prototype.hasOwnProperty.call(scope.Event.prototype, 'isTrusted')) {
    try {
      Object.defineProperty(scope.Event.prototype, 'isTrusted', {
        configurable: true,
        get() { return false; },
      });
    } catch { /* browser prototype is immutable */ }
  }

  const NativeWeakRef = scope.WeakRef;
  if (typeof NativeWeakRef === 'function') {
    class CompatibleWeakRef {
      constructor(value) {
        const signalState = state.signals.get(value);
        this.signalState = signalState;
        this.value = signalState ? value : undefined;
        this.native = signalState ? null : new NativeWeakRef(value);
      }

      deref() {
        if (!this.signalState) return this.native.deref();
        if (state.gcGeneration > 0 && this.signalState.strongListeners.size === 0) this.value = undefined;
        return this.value;
      }
    }
    scope.WeakRef = CompatibleWeakRef;
  }

  const nativeGc = typeof scope.gc === 'function' ? scope.gc.bind(scope) : null;
  scope.gc = () => {
    state.gcGeneration += 1;
    nativeGc?.();
  };
}

export function createInternalEventTarget(scope = globalThis) {
  const Event = scope.Event || class BrowserEvent {};
  const EventTarget = scope.EventTarget || class BrowserEventTarget {
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() { return true; }
  };
  class NodeEventTarget extends EventTarget {}
  const kCreateEvent = Symbol('bnh.createEvent');
  const kNewListener = Symbol('bnh.newListener');
  const kRemoveListener = Symbol('bnh.removeListener');

  function defineEventHandler(target, name) {
    const property = `on${name}`;
    if (Object.getOwnPropertyDescriptor(target, property)) return;
    const handler = Symbol(property);
    Object.defineProperty(target, property, {
      configurable: true,
      enumerable: true,
      get() { return this[handler] || null; },
      set(value) {
        const previous = this[handler];
        if (previous) this.removeEventListener?.(name, previous);
        this[handler] = typeof value === 'function' ? value : null;
        if (this[handler]) this.addEventListener?.(name, this[handler]);
      },
    });
  }

  function initNodeEventTarget() {}

  return Object.freeze({
    Event,
    EventTarget,
    NodeEventTarget,
    defineEventHandler,
    initNodeEventTarget,
    kCreateEvent,
    kNewListener,
    kRemoveListener,
    kWeakHandler,
  });
}

export function installBrowserAbortSignalCompatibility(scope = globalThis) {
  installAbortSignalCompatibility(scope);
}

export function createAborted() {
  return function aborted(signal, resource) {
    if (signal === undefined) {
      const err = new TypeError("The \"signal\" argument must be an instance of AbortSignal. Received undefined");
      err.code = 'ERR_INVALID_ARG_TYPE';
      return Promise.reject(err);
    }
    if (signal === null || typeof signal !== 'object' || !('aborted' in signal)) {
      const err = new TypeError("The \"signal\" argument must be an instance of AbortSignal. Received " + (signal === null ? 'null' : typeof signal));
      err.code = 'ERR_INVALID_ARG_TYPE';
      return Promise.reject(err);
    }
    const throwOnNullable = true;
    const allowArray = true;
    const allowFunction = true;
    if (throwOnNullable && resource === null) {
      const err = new TypeError("The \"resource\" argument must be of type Object. Received null");
      err.code = 'ERR_INVALID_ARG_TYPE';
      return Promise.reject(err);
    }
    const throwOnArray = !allowArray;
    if (throwOnArray && Array.isArray(resource)) {
      const err = new TypeError("The \"resource\" argument must be of type Object. Received array");
      err.code = 'ERR_INVALID_ARG_TYPE';
      return Promise.reject(err);
    }
    const throwOnFunction = !allowFunction;
    const typeofValue = typeof resource;
    if (typeofValue !== 'object' && (throwOnFunction || typeofValue !== 'function')) {
      const err = new TypeError("The \"resource\" argument must be of type Object. Received " + (resource === null ? 'null' : typeofValue));
      err.code = 'ERR_INVALID_ARG_TYPE';
      return Promise.reject(err);
    }
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  };
}

const kIsClosedPromise = Symbol.for('nodejs.webstream.isClosedPromise');
const kControllerErrorFunction = Symbol.for('nodejs.webstream.controllerErrorFunction');

export function addAbortSignal(signal, stream) {
  try {
    if (!signal || typeof signal !== 'object' || !('aborted' in signal)) {
      return stream;
    }
    if (signal.aborted) {
      if (stream && typeof stream.destroy === 'function') {
        stream.destroy(abortError());
      } else if (stream && typeof stream[kControllerErrorFunction] === 'function') {
        stream[kControllerErrorFunction](abortError());
      } else if (stream && typeof stream.cancel === 'function' && typeof stream.getReader === 'function') {
        stream.cancel(abortError());
      } else if (stream && typeof stream.abort === 'function' && typeof stream.getWriter === 'function') {
        stream.abort(abortError());
      }
      return stream;
    }
    const onAbort = () => {
      try {
        if (stream && typeof stream.destroy === 'function') {
          stream.destroy(abortError());
        } else if (stream && typeof stream[kControllerErrorFunction] === 'function') {
          stream[kControllerErrorFunction](abortError());
        } else if (stream && typeof stream.cancel === 'function' && typeof stream.getReader === 'function') {
          stream.cancel(abortError());
        } else if (stream && typeof stream.abort === 'function' && typeof stream.getWriter === 'function') {
          stream.abort(abortError());
        }
      } catch (e) {
        throw e;
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    return stream;
  } catch (e) {
    throw e;
  }
}

export function finished(stream, options, callbackArgument) {
  try {
    const isNodeStream = stream && typeof stream.on === 'function'
      && (stream._readableState || stream._writableState);
    const isWebStream = stream && (typeof stream.getReader === 'function'
      || typeof stream.getWriter === 'function');
    if (!isNodeStream && !isWebStream && !(stream && kIsClosedPromise in stream)) {
      const error = new TypeError('The "stream" argument must be an instance of Stream or ReadableStream');
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    let callback = callbackArgument;
    if (typeof options === 'function') {
      if (callbackArgument !== undefined) {
        const error = new TypeError('The "callback" argument must be of type function');
        error.code = 'ERR_INVALID_ARG_TYPE';
        throw error;
      }
      callback = options;
      options = undefined;
    } else if (options !== undefined && options !== null && typeof options !== 'object') {
      const error = new TypeError(callbackArgument === undefined
        ? 'The "callback" argument must be of type function'
        : 'The "options" argument must be an object');
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    if (options?.cleanup !== undefined && typeof options.cleanup !== 'boolean') {
      const error = new TypeError('The "options.cleanup" argument must be of type boolean');
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    if (callback !== undefined && typeof callback !== 'function') {
      const error = new TypeError('The "callback" argument must be of type function');
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    if (callback === undefined) callback = null;
    const callbackResource = callback ? new AsyncResource('STREAMFINISHED') : null;
    return new Promise((resolve, reject) => {
      let settled = false;
      const complete = (error = undefined) => {
        if (settled) return;
        settled = true;
        try {
          if (options?.cleanup) {
            stream.off?.('finish', onFinish);
            stream.off?.('end', onFinish);
            stream.off?.('close', onClose);
            stream.off?.('error', onError);
          }
          if (callbackResource) callbackResource.runInAsyncScope(callback, undefined, error);
          if (error && !callbackResource) reject(error);
          else resolve();
        } finally {
          callbackResource?.emitDestroy();
        }
      };
      const onFinish = () => complete();
      const onError = (err) => complete(err || abortError());
      const onClose = () => {
        const readableState = stream?._readableState;
        const writableState = stream?._writableState;
        const streamError = readableState?.errored || writableState?.errored;
        if (streamError) {
          complete(streamError);
          return;
        }
        const premature = Boolean(
          (readableState?.readable !== false && !readableState?.endEmitted)
          || (writableState?.writable !== false && !writableState?.finished),
        );
        if (!premature) {
          complete();
          return;
        }
        const error = new Error('Premature close');
        error.code = 'ERR_STREAM_PREMATURE_CLOSE';
        complete(error);
      };
      if (stream && typeof stream.on === 'function') {
        stream.on('finish', onFinish);
        stream.on('end', onFinish);
        stream.on('close', onClose);
        if (options && options.error !== false) {
          stream.on('error', onError);
        }
        if (options?.signal?.addEventListener) {
          const onAbort = () => complete(abortError());
          if (options.signal.aborted) onAbort();
          else options.signal.addEventListener('abort', onAbort, { once: true });
        }
    } else if (stream && typeof stream.getReader === 'function') {
      if (stream.locked) {
        const closedPromise = stream[kIsClosedPromise];
        Promise.resolve(closedPromise?.promise).then(
          () => resolve(),
          (err) => reject(err || abortError())
        );
        return;
      }
      (async () => {
        try {
            const reader = stream.getReader();
            while (true) {
              const result = await reader.read();
              if (result.done) break;
            }
            reader.releaseLock();
            resolve();
          } catch (err) {
            reject(err || abortError());
          }
        })();
        return;
      } else if (stream && kIsClosedPromise in stream && stream[kIsClosedPromise]) {
        const closedPromise = stream[kIsClosedPromise];
        Promise.resolve(closedPromise.promise).then(
          () => resolve(),
          (err) => reject(err || abortError())
        );
        return;
      } else {
        resolve();
      }
    });
  } catch (e) {
    throw e;
  }
}

export function createWebStreamModule(scope) {
  const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
  const patchStream = (StreamClass) => {
    if (typeof StreamClass === 'function' && StreamClass.prototype) {
      StreamClass.prototype[inspectCustom] = function() {
        throw Object.assign(new TypeError('Invalid this'), { code: 'ERR_INVALID_THIS' });
      };
    }
  };
  if (typeof scope.TextEncoderStream === 'function') patchStream(scope.TextEncoderStream);
  if (typeof scope.TextDecoderStream === 'function') patchStream(scope.TextDecoderStream);
  const patchCompressionInspect = (StreamClass, name) => {
    if (typeof StreamClass !== 'function' || !StreamClass.prototype) return;
    Object.defineProperty(StreamClass.prototype, inspectCustom, {
      configurable: true,
      value() { return `${name} { readable: ReadableStream, writable: WritableStream }`; },
    });
  };
  patchCompressionInspect(scope.CompressionStream, 'CompressionStream');
  patchCompressionInspect(scope.DecompressionStream, 'DecompressionStream');
  return Object.freeze({
    ReadableStream: scope.ReadableStream,
    WritableStream: scope.WritableStream,
    TransformStream: scope.TransformStream,
    ByteLengthQueuingStrategy: scope.ByteLengthQueuingStrategy,
    CountQueuingStrategy: scope.CountQueuingStrategy,
    TextEncoderStream: typeof scope.TextEncoderStream === 'function' ? scope.TextEncoderStream : undefined,
    TextDecoderStream: typeof scope.TextDecoderStream === 'function' ? scope.TextDecoderStream : undefined,
    CompressionStream: typeof scope.CompressionStream === 'function' ? scope.CompressionStream : undefined,
    DecompressionStream: typeof scope.DecompressionStream === 'function' ? scope.DecompressionStream : undefined,
  });
}
