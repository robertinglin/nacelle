function normalizePath(value, platform = 'posix') {
  const separator = platform === 'win32' ? '\\' : '/';
  const source = String(value).replaceAll(platform === 'win32' ? '/' : '\\', separator);
  const absolute = source.startsWith(separator) || (platform === 'win32' && /^[A-Za-z]:[\\/]/.test(source));
  const drive = platform === 'win32' && /^[A-Za-z]:/.test(source) ? source.slice(0, 2) : '';
  const parts = source.slice(drive.length).split(separator);
  const output = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..' && output.length && output.at(-1) !== '..') output.pop();
    else if (part !== '..' || !absolute) output.push(part);
  }
  const result = output.join(separator);
  if (absolute) return `${drive}${separator}${result}`;
  return result || '.';
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
  const separator = platform === 'win32' ? '\\' : '/';
  const isAbsolute = (value) => platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(String(value)) || /^\\\\/.test(String(value)) : String(value).startsWith('/');
  const resolved = [];
  let absolute = false;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = String(parts[index] ?? '');
    if (!part) continue;
    resolved.unshift(part);
    if (isAbsolute(part)) {
      absolute = true;
      break;
    }
  }
  if (!absolute) resolved.unshift(platform === 'win32' ? 'C:\\' : '/node');
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

function createPath(platform) {
  const separator = platform === 'win32' ? '\\' : '/';
  const delimiter = platform === 'win32' ? ';' : ':';
  const isAbsolute = (value) => platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(String(value)) || /^\\\\/.test(String(value)) : String(value).startsWith('/');
  return {
    sep: separator,
    delimiter,
    isAbsolute,
    toNamespacedPath: (value) => toNamespacedPath(value, platform),
    normalize: (value) => normalizePath(value, platform),
    join: (...parts) => normalizePath(parts.filter((part) => part !== '').join(separator), platform),
    resolve(...parts) { return resolvePath(parts, platform); },
    relative(from, to) {
      return relativePath(resolvePath([from], platform), resolvePath([to], platform), platform);
    },
    dirname(value) {
      const normalized = normalizePath(value, platform); const index = normalized.lastIndexOf(separator);
      if (index < 0) return '.'; if (index === 0) return separator; return normalized.slice(0, index) || separator;
    },
    basename(value, suffix) {
      const name = String(value).replaceAll('\\', separator).split(separator).at(-1) || '';
      return suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
    },
    extname(value) {
      const name = String(value).replaceAll('\\', separator).split(separator).at(-1) || '';
      const index = name.lastIndexOf('.'); return index <= 0 ? '' : name.slice(index);
    },
    parse(value) {
      const root = isAbsolute(value) ? separator : ''; const base = this.basename(value); const ext = this.extname(base);
      return { root, dir: this.dirname(value), base, ext, name: ext ? base.slice(0, -ext.length) : base };
    },
    format(value) { return `${value.dir || value.root || ''}${value.dir || value.root ? separator : ''}${value.base || `${value.name || ''}${value.ext || ''}`}`; },
  };
}

export const posix = createPath('posix');
export const win32 = createPath('win32');
export const path = { ...posix, posix, win32 };
