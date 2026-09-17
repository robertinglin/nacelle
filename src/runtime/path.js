function win32Root(value) {
  const source = String(value).replaceAll('/', '\\');
  if (/^[A-Za-z]:\\/.test(source)) return source.slice(0, 3);
  if (/^[A-Za-z]:/.test(source)) return source.slice(0, 2);
  if (source.startsWith('\\\\')) {
    const parts = source.slice(2).split('\\');
    if (parts[0] === '?' || parts[0] === '.') {
      if (/^[A-Za-z]:$/.test(parts[1] || '')) return `\\\\${parts[0]}\\${parts[1]}\\`;
      if (parts[0] === '?' && parts[1] === 'UNC' && parts[2] && parts[3]) return '\\\\?\\UNC\\';
    }
    if (parts[0] && parts[1]) return `\\\\${parts[0]}\\${parts[1]}\\`;
    return '\\';
  }
  if (source.startsWith('\\')) return '\\';
  return '';
}

function normalizeWin32(value) {
  const separator = '\\';
  const source = String(value).replaceAll('/', separator);
  const root = win32Root(source);
  const parts = source.slice(root.length).split(separator);
  const output = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..' && output.length && output.at(-1) !== '..') output.pop();
    else if (part !== '..' || (root === '' || /^[A-Za-z]:$/.test(root))) output.push(part);
  }
  const result = output.join(separator);
  const trailingSeparator = source.endsWith(separator) && result !== '';
  if (root) return `${root}${result}${trailingSeparator ? separator : ''}`;
  return `${result || '.'}${trailingSeparator ? separator : ''}`;
}

function normalizePath(value, platform = 'posix') {
  if (platform === 'win32') return normalizeWin32(value);
  const separator = '/';
  const source = String(value).replaceAll('\\', separator);
  const absolute = source.startsWith(separator);
  const parts = source.split(separator);
  const output = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..' && output.length && output.at(-1) !== '..') output.pop();
    else if (part !== '..' || !absolute) output.push(part);
  }
  const result = output.join(separator);
  const trailingSeparator = source.endsWith(separator) && result !== '';
  if (absolute) return `${separator}${result}${trailingSeparator ? separator : ''}`;
  return `${result || '.'}${trailingSeparator ? separator : ''}`;
}

function relativePath(from, to, platform) {
  const separator = platform === 'win32' ? '\\' : '/';
  const fromPath = normalizePath(from, platform);
  const toPath = normalizePath(to, platform);
  const fromDrive = platform === 'win32' && /^[A-Za-z]:/.test(fromPath) ? fromPath.slice(0, 2).toLowerCase() : '';
  const toDrive = platform === 'win32' && /^[A-Za-z]:/.test(toPath) ? toPath.slice(0, 2).toLowerCase() : '';

  // Node returns the destination unchanged when win32 paths are on different drives.
  if (platform === 'win32' && fromDrive !== toDrive) return toPath;

  const rootLength = platform === 'win32' && /^[A-Za-z]:[\\/]/.test(fromPath) ? 3 : platform === 'posix' ? 1 : 0;
  const fromParts = fromPath.slice(rootLength).split(separator).filter(Boolean);
  const toRootLength = platform === 'win32' && /^[A-Za-z]:[\\/]/.test(toPath) ? 3 : platform === 'posix' ? 1 : 0;
  const toParts = toPath.slice(toRootLength).split(separator).filter(Boolean);
  const equals = platform === 'win32'
    ? (left, right) => left.toLowerCase() === right.toLowerCase()
    : (left, right) => left === right;
  let common = 0;
  while (common < fromParts.length && common < toParts.length && equals(fromParts[common], toParts[common])) common += 1;
  return [...fromParts.slice(common).map(() => '..'), ...toParts.slice(common)].join(separator);
}

function resolvePath(parts, platform) {
  if (platform === 'win32') {
    const values = parts.map((part, index) => validateString(part, `paths[${index}]`).replaceAll('/', '\\'));
    const tail = [];
    let root = '';
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const value = values[index];
      if (!value) continue;
      if (value.startsWith('\\')) {
        if (value.startsWith('\\\\') || /^[A-Za-z]:\\/.test(value)) root = value;
        else {
          const drive = values.slice(0, index).find((item) => /^[A-Za-z]:/.test(item))?.slice(0, 2) || 'C:';
          root = `${drive}\\${value.slice(1)}`;
        }
        break;
      }
      if (/^[A-Za-z]:\\/.test(value)) {
        root = value;
        break;
      }
      tail.unshift(value);
    }
    if (!root) root = 'C:\\';
    return normalizeWin32(`${root}${tail.length ? `\\${tail.join('\\')}` : ''}`);
  }
  const separator = platform === 'win32' ? '\\' : '/';
  const isAbsolute = (value) => {
    validateString(value, 'path');
    return platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) : value.startsWith('/');
  };
  const resolved = [];
  let absolute = false;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = validateString(parts[index], `paths[${index}]`);
    if (!part) continue;
    resolved.unshift(part);
    if (isAbsolute(part)) {
      absolute = true;
      break;
    }
  }
  if (!absolute) resolved.unshift('/node');
  return normalizePath(resolved.join(separator), platform);
}

function toNamespacedPath(value, platform) {
  if (typeof value !== 'string' || platform === 'posix' || value.length === 0) return value;
  const normalized = value.replaceAll('/', '\\');
  if (/^\\\\[?.]\\/.test(normalized)) return value;
  if (/^\\\\/.test(normalized)) return `\\\\?\\UNC\\${normalized.slice(2)}`;
  if (/^[A-Za-z]:\\/.test(normalized)) return `\\\\?\\${normalized}`;
  return value;
}

function invalidStringArgument(name, value) {
  const received = value === null || value === undefined
    ? `Received ${value}`
    : typeof value === 'function'
      ? `Received function ${value.name || ''}`.trimEnd()
      : typeof value === 'object'
        ? `Received an instance of ${value?.constructor?.name || 'Object'}`
        : `Received type ${typeof value} (${typeof value === 'string' ? `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'` : String(value)})`;
  const error = new TypeError(`The "${name}" argument must be of type string. Received ${received}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function validateString(value, name) {
  if (typeof value !== 'string') throw invalidStringArgument(name, value);
  return value;
}

function validateObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    const received = value === null ? 'null' : Array.isArray(value)
      ? 'an instance of Array' : typeof value;
    const error = new TypeError(`The "${name}" argument must be of type Object. Received ${received}`);
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  return value;
}

function globPathInfo(value, platform) {
  const separator = platform === 'win32' ? '\\' : '/';
  const normalized = platform === 'win32' ? value.replaceAll('/', separator) : value;
  const absolute = platform === 'win32'
    ? normalized.startsWith(separator) || /^[A-Za-z]:\\/.test(normalized)
    : normalized.startsWith(separator);
  const trailingSeparator = normalized.length > 0 && normalized.endsWith(separator);
  return { absolute, parts: normalized.split(separator).filter(Boolean), trailingSeparator };
}

function globClass(pattern, start, nocase) {
  let index = start + 1;
  let negate = false;
  if (pattern[index] === '!' || pattern[index] === '^') { negate = true; index += 1; }
  const values = [];
  let hasValue = false;
  for (; index < pattern.length; index += 1) {
    const current = pattern[index];
    if (current === ']' && hasValue) break;
    if (current === '\\' && !nocase && index + 1 < pattern.length) {
      index += 1; values.push({ value: pattern[index] }); hasValue = true; continue;
    }
    if (index + 2 < pattern.length && pattern[index + 1] === '-' && pattern[index + 2] !== ']') {
      values.push({ from: current, to: pattern[index + 2] }); hasValue = true; index += 2;
    } else { values.push({ value: current }); hasValue = true; }
  }
  if (index >= pattern.length || !hasValue || pattern[index] !== ']') return null;
  return { end: index, negate, values };
}

function globTokens(pattern, platform) {
  const tokens = [];
  const allowEscapes = platform === 'posix';
  for (let index = 0; index < pattern.length; index += 1) {
    const current = pattern[index];
    if (allowEscapes && current === '\\' && index + 1 < pattern.length) {
      tokens.push({ type: 'literal', value: pattern[++index] });
    } else if (current === '*') tokens.push({ type: 'star' });
    else if (current === '?') tokens.push({ type: 'question' });
    else if (current === '[') {
      const parsed = globClass(pattern, index, platform === 'win32');
      if (parsed) { tokens.push({ type: 'class', ...parsed }); index = parsed.end; }
      else tokens.push({ type: 'literal', value: current });
    } else tokens.push({ type: 'literal', value: current });
  }
  return tokens;
}

function globClassMatches(token, value, nocase) {
  const candidate = nocase ? value.toLowerCase() : value;
  let matched = false;
  for (const item of token.values) {
    if (item.value !== undefined) {
      const expected = nocase ? item.value.toLowerCase() : item.value;
      if (candidate === expected) matched = true;
    } else {
      const from = nocase ? item.from.toLowerCase() : item.from;
      const to = nocase ? item.to.toLowerCase() : item.to;
      if (from <= candidate && candidate <= to) matched = true;
    }
  }
  return token.negate ? !matched : matched;
}

function globSegmentMatches(value, pattern, platform) {
  const tokens = globTokens(pattern, platform);
  const nocaseMagic = platform === 'win32';
  if (value.startsWith('.') && pattern[0] !== '.') return false;
  const matches = (valueIndex, tokenIndex) => {
    if (tokenIndex === tokens.length) return valueIndex === value.length;
    const token = tokens[tokenIndex];
    if (token.type === 'star') return matches(valueIndex, tokenIndex + 1)
      || (valueIndex < value.length && matches(valueIndex + 1, tokenIndex));
    if (valueIndex >= value.length) return false;
    if (token.type === 'question') return matches(valueIndex + 1, tokenIndex + 1);
    if (token.type === 'class') return globClassMatches(token, value[valueIndex], nocaseMagic)
      && matches(valueIndex + 1, tokenIndex + 1);
    return value[valueIndex] === token.value && matches(valueIndex + 1, tokenIndex + 1);
  };
  return matches(0, 0);
}

function matchesGlob(value, pattern, platform) {
  if (typeof value !== 'string') throw invalidStringArgument('path', value);
  if (typeof pattern !== 'string') throw invalidStringArgument('pattern', pattern);
  const pathInfo = globPathInfo(value, platform);
  const patternInfo = globPathInfo(pattern, platform);
  if (pathInfo.absolute !== patternInfo.absolute) return false;
  const pathParts = pathInfo.parts;
  const patternParts = patternInfo.parts;
  const matchParts = (pathIndex, patternIndex, globstarConsumed = false) => {
    if (patternIndex === patternParts.length) return pathIndex === pathParts.length;
    const segment = patternParts[patternIndex];
    if (segment === '**') {
      if (matchParts(pathIndex, patternIndex + 1)
          && (patternIndex !== patternParts.length - 1 || globstarConsumed || pathInfo.trailingSeparator || pathParts.length === 0)) return true;
      for (let index = pathIndex; index < pathParts.length; index += 1) {
        if (pathParts[index].startsWith('.')) break;
        if (matchParts(index + 1, patternIndex, true)) return true;
      }
      return false;
    }
    return pathIndex < pathParts.length && globSegmentMatches(pathParts[pathIndex], segment, platform)
      && matchParts(pathIndex + 1, patternIndex + 1);
  };
  if (patternInfo.trailingSeparator && !pathInfo.trailingSeparator) return false;
  return matchParts(0, 0);
}

function createPath(platform) {
  const separator = platform === 'win32' ? '\\' : '/';
  const delimiter = platform === 'win32' ? ';' : ':';
  const isAbsolute = (value) => platform === 'win32'
    ? String(value).startsWith('\\') || String(value).startsWith('/') || /^[A-Za-z]:[\\/]/.test(String(value))
    : String(value).startsWith('/');
  const namespacedPath = (value) => toNamespacedPath(value, platform);
  const globMatcher = (value, pattern) => matchesGlob(value, pattern, platform);
  return {
    sep: separator,
    delimiter,
    isAbsolute,
    toNamespacedPath: namespacedPath,
    _makeLong: namespacedPath,
    matchesGlob: globMatcher,
    normalize: (value) => normalizePath(validateString(value, 'path'), platform),
    join: (...parts) => normalizePath(parts
      .map((part) => validateString(part, 'path'))
      .filter((part) => part !== '')
      .join(separator), platform),
    resolve(...parts) { return resolvePath(parts, platform); },
    relative(from, to) {
      validateString(from, 'from'); validateString(to, 'to');
      return relativePath(resolvePath([from], platform), resolvePath([to], platform), platform);
    },
    dirname(value) {
      validateString(value, 'path');
      const normalized = normalizePath(value, platform); const index = normalized.lastIndexOf(separator);
      if (index < 0) return '.'; if (index === 0) return separator; return normalized.slice(0, index) || separator;
    },
    basename(value, suffix) {
      if (suffix !== undefined) validateString(suffix, 'suffix');
      validateString(value, 'path');
      const name = String(value).replaceAll('\\', separator).split(separator).at(-1) || '';
      return suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
    },
    extname(value) {
      validateString(value, 'path');
      const name = String(value).replaceAll('\\', separator).split(separator).at(-1) || '';
      const index = name.lastIndexOf('.'); return index <= 0 ? '' : name.slice(index);
    },
    parse(value) {
      validateString(value, 'path');
      const normalized = normalizePath(value, platform);
      const root = platform === 'win32'
        ? win32Root(value)
        : isAbsolute(value) ? separator : '';
      const base = normalized.split(separator).at(-1) || '';
      const extensionIndex = base.lastIndexOf('.');
      const ext = extensionIndex <= 0 ? '' : base.slice(extensionIndex);
      const lastSeparator = normalized.lastIndexOf(separator);
      const dir = lastSeparator < 0
        ? '.'
        : lastSeparator === 0 ? separator : normalized.slice(0, lastSeparator);
      return { root, dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
    },
    format(value) {
      validateObject(value, 'pathObject');
      return `${value.dir || value.root || ''}${value.dir || value.root ? separator : ''}${value.base || `${value.name || ''}${value.ext || ''}`}`;
    },
  };
}

export const posix = createPath('posix');
export const win32 = createPath('win32');
posix.posix = posix;
posix.win32 = win32;
win32.posix = posix;
win32.win32 = win32;
export const path = posix;
