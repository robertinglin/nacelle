function splitAlternatives(value, separator = '|') {
  const alternatives = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '(' || value[index] === '{') depth += 1;
    else if (value[index] === ')' || value[index] === '}') depth -= 1;
    else if (value[index] === separator && depth === 0) {
      alternatives.push(value.slice(start, index));
      start = index + 1;
    }
  }
  alternatives.push(value.slice(start));
  return alternatives;
}

function expandBraces(pattern) {
  let open = -1;
  let depth = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === '{') {
      if (open < 0) open = index;
      depth += 1;
    } else if (pattern[index] === '}' && open >= 0) {
      depth -= 1;
      if (depth === 0) {
        const body = pattern.slice(open + 1, index);
        const alternatives = splitAlternatives(body, ',');
        if (alternatives.length === 1) return [pattern];
        return alternatives.flatMap((alternative) => expandBraces(
          `${pattern.slice(0, open)}${alternative}${pattern.slice(index + 1)}`,
        ));
      }
    }
  }
  return [pattern];
}

function balancedGroup(value, start) {
  let depth = 0;
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1;
    else if (value[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function segmentRegexSource(segment) {
  let source = '';
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    if ('+?*@!'.includes(character) && segment[index + 1] === '(') {
      const end = balancedGroup(segment, index + 1);
      if (end >= 0) {
        const body = splitAlternatives(segment.slice(index + 2, end))
          .map((alternative) => segmentRegexSource(alternative))
          .join('|');
        if (character === '!') source += `(?!^(?:${body})$)[^/]*`;
        else source += `(?:${body})${character === '@' ? '' : character}`;
        index = end;
        continue;
      }
    }
    if (character === '*') {
      source += '[^/]*';
      continue;
    }
    if (character === '?') {
      source += '[^/]';
      continue;
    }
    if (character === '[') {
      const end = segment.indexOf(']', index + 1);
      if (end > index + 1) {
        let expression = segment.slice(index + 1, end);
        if (expression[0] === '!') expression = `^${expression.slice(1)}`;
        source += `[${expression}]`;
        index = end;
        continue;
      }
    }
    source += /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
  }
  return source;
}

function segmentMatches(segment, value) {
  if (value.startsWith('.') && !segment.startsWith('.')) return false;
  return new RegExp(`^${segmentRegexSource(segment)}$`).test(value);
}

function hasMagic(segment) {
  return /[*?\[\]{}()+!@]/.test(segment);
}

function normalizePatternParts(parts) {
  const normalized = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (normalized.length > 0 && normalized.at(-1) !== '**') normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return normalized;
}

function expandGlobstars(parts, maximum) {
  const result = [];
  const visit = (index, current) => {
    if (index === parts.length) {
      result.push(normalizePatternParts(current));
      return;
    }
    if (parts[index] !== '**') {
      visit(index + 1, [...current, parts[index]]);
      return;
    }
    for (let count = 0; count <= maximum; count += 1) {
      visit(index + 1, [...current, ...Array.from({ length: count }, () => '*')]);
    }
  };
  visit(0, []);
  return result;
}

function pathParts(path) {
  return path === '.' ? [] : path.split('/').filter((part) => part && part !== '.');
}

function matchesParts(pattern, candidate) {
  const visit = (patternIndex, candidateIndex) => {
    if (patternIndex === pattern.length) return candidateIndex === candidate.length;
    if (candidateIndex === candidate.length) return false;
    return segmentMatches(pattern[patternIndex], candidate[candidateIndex])
      && visit(patternIndex + 1, candidateIndex + 1);
  };
  return visit(0, 0);
}

function matchesPattern(pattern, candidate) {
  const candidateParts = pathParts(candidate);
  return expandGlobstars(pattern.split('/').filter((part, index) => part || index === 0), candidateParts.length + 2)
    .some((parts) => matchesParts(parts, candidateParts));
}

function relativePath(root, path) {
  if (path === root) return '.';
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function absolutePattern(pattern) {
  return pattern.startsWith('/');
}

function outputPath(root, path, isAbsolute) {
  return isAbsolute ? path : relativePath(root, path);
}

function validatePatterns(pattern, invalidType) {
  if (Array.isArray(pattern)) {
    for (let index = 0; index < pattern.length; index += 1) {
      if (typeof pattern[index] !== 'string') throw invalidType(`patterns[${index}]`, pattern[index], 'string');
    }
    return pattern;
  }
  if (typeof pattern !== 'string') throw invalidType('patterns', pattern, 'string');
  return [pattern];
}

function validateOptions(options, invalidType, resolvePath) {
  if (options === undefined) return {};
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw invalidType('options', options, 'Object');
  }
  const result = { ...options };
  if (result.cwd !== undefined) result.cwd = resolvePath(result.cwd);
  if (result.exclude !== undefined && result.exclude !== null
    && typeof result.exclude !== 'function' && !Array.isArray(result.exclude)) {
    throw invalidType('options.exclude', result.exclude, 'function or string[]');
  }
  if (Array.isArray(result.exclude)) {
    for (let index = 0; index < result.exclude.length; index += 1) {
      if (typeof result.exclude[index] !== 'string') {
        throw invalidType(`options.exclude[${index}]`, result.exclude[index], 'string');
      }
    }
  }
  return result;
}

export function createGlob({
  resolvePath,
  listEntries,
  statPath,
  lstatPath,
  roots,
  makeDirent,
  invalidType,
}) {
  function prepare(patternValue, optionsValue) {
    const patterns = validatePatterns(patternValue, invalidType);
    const options = validateOptions(optionsValue, invalidType, resolvePath);
    const cwd = options.cwd === undefined ? resolvePath('.') : options.cwd;
    const exclude = options.exclude;
    const excludePatterns = Array.isArray(exclude)
      ? exclude.flatMap((pattern) => expandBraces(resolvePath(
        pattern.startsWith('/') ? pattern : `${cwd}/${pattern}`,
      )))
      : [];
    return {
      cwd,
      exclude,
      excludePatterns,
      patterns: patterns.flatMap(expandBraces),
      withFileTypes: options.withFileTypes === true,
    };
  }

  function allCandidates(cwd, patterns) {
    const candidates = new Set([cwd]);
    const walked = new Set();
    const walk = (path, depth, symlinkDepth = 0) => {
      if (depth > 40) return;
      let isSymlink = false;
      try { isSymlink = lstatPath(path).isSymbolicLink(); } catch { /* path vanished */ }
      if (isSymlink && symlinkDepth >= 12) return;
      const nextSymlinkDepth = symlinkDepth + (isSymlink ? 1 : 0);
      const walkKey = `${path}\u0000${depth}\u0000${nextSymlinkDepth}`;
      if (walked.has(walkKey)) return;
      walked.add(walkKey);
      let entries;
      try { entries = listEntries(path); } catch { return; }
      for (const entry of entries) {
        const child = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;
        candidates.add(child);
        try {
          if (statPath(child).isDirectory()) walk(child, depth + 1, nextSymlinkDepth);
        } catch {
          // A broken symlink is still a glob candidate, but has no children.
        }
      }
    };
    const starts = new Set();
    for (const pattern of patterns) {
      if (!absolutePattern(pattern)) {
        starts.add(cwd);
        continue;
      }
      const first = pattern.split('/').find(Boolean);
      if (first && !hasMagic(first)) starts.add(`/${first}`);
      else for (const root of roots()) starts.add(root);
    }
    for (const start of starts) {
      try {
        if (start === cwd || statPath(start)) walk(start, 0);
      } catch {
        // Missing or inaccessible roots produce no matches.
      }
    }
    return candidates;
  }

  function patternMatchesWithParent(pattern, cwd) {
    const parts = pattern.split('/').filter((part, index) => part || index === 0);
    const matches = new Set();
    const seen = new Set();
    const parentOf = (path) => path.slice(0, path.lastIndexOf('/')) || '/';
    const visit = (path, index, symlinkDepth) => {
      const key = `${path}\u0000${index}\u0000${symlinkDepth}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (index === parts.length) {
        try { statPath(path); matches.add(path); } catch { /* vanished path */ }
        return;
      }
      const part = parts[index];
      if (part === '.') {
        visit(path, index + 1, symlinkDepth);
        return;
      }
      if (part === '..') {
        visit(parentOf(path), index + 1, symlinkDepth);
        return;
      }
      if (part === '**') {
        visit(path, index + 1, symlinkDepth);
        let entries;
        try { entries = listEntries(path); } catch { return; }
        for (const entry of entries) {
          const nextPart = parts[index + 1];
          if (entry.name.startsWith('.') && (nextPart === '..' || !nextPart?.startsWith('.'))) continue;
          const child = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;
          let childIsDirectory = false;
          let childIsSymlink = false;
          try {
            childIsDirectory = statPath(child).isDirectory();
            childIsSymlink = lstatPath(child).isSymbolicLink();
          } catch {
            continue;
          }
          if (!childIsDirectory) continue;
          const nextSymlinkDepth = symlinkDepth + (childIsSymlink ? 1 : 0);
          if (nextSymlinkDepth > 12) continue;
          visit(child, index, nextSymlinkDepth);
        }
        return;
      }
      let entries;
      try { entries = listEntries(path); } catch { return; }
      for (const entry of entries) {
        if (!segmentMatches(part, entry.name)) continue;
        const child = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;
        visit(child, index + 1, symlinkDepth);
      }
    };
    if (absolutePattern(pattern)) return matches;
    visit(cwd, 0, 0);
    return matches;
  }

  function isExcluded(config, path, output, dirent) {
    for (const pattern of config.excludePatterns) {
      let current = path;
      while (true) {
        if (matchesPattern(pattern, current)) return true;
        if (current === '/') break;
        current = current.slice(0, current.lastIndexOf('/')) || '/';
      }
    }
    if (typeof config.exclude !== 'function') return false;
    return Boolean(config.exclude(config.withFileTypes ? dirent : output));
  }

  function collect(patternValue, optionsValue) {
    const config = prepare(patternValue, optionsValue);
    const candidates = allCandidates(config.cwd, config.patterns);
    const matches = new Map();
    for (const pattern of config.patterns) {
      const isAbsolute = absolutePattern(pattern);
      const trailingSlash = pattern.endsWith('/');
      const patternCandidates = pattern.includes('..')
        ? patternMatchesWithParent(pattern, config.cwd)
        : candidates;
      for (const candidate of patternCandidates) {
        const output = outputPath(config.cwd, candidate, isAbsolute);
        if (trailingSlash) {
          try { if (!statPath(candidate).isDirectory()) continue; } catch { continue; }
        }
        const matchTarget = isAbsolute ? candidate : output;
        if (!matchesPattern(pattern, matchTarget)) continue;
        let dirent;
        if (config.withFileTypes) {
          try { dirent = makeDirent(candidate, lstatPath(candidate)); } catch { continue; }
        }
        if (isExcluded(config, candidate, output, dirent)) continue;
        matches.set(candidate, dirent || output);
      }
    }
    return [...matches.values()];
  }

  return {
    globSync(pattern, options) {
      return collect(pattern, options);
    },
    async *glob(pattern, options) {
      for (const match of collect(pattern, options)) {
        yield match;
      }
    },
  };
}
