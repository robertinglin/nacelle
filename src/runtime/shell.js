import {
  expandShellWord,
  literalShellWord,
  parseShellScript,
  rawShellWord,
} from './shell-parser.js';
import { resolveNodeVersionProfile } from '../versions/index.js';

const DEFAULT_NODE_VERSION = resolveNodeVersionProfile('lts').runtimeVersion;

const BUILTINS = new Set([
  ':', '.', '[', 'alias', 'basename', 'cat', 'cd', 'command', 'cp', 'cut', 'dirname', 'echo', 'env', 'export',
  'false', 'find', 'grep', 'head', 'ls', 'mkdir', 'mv', 'printenv', 'printf', 'ps', 'pwd', 'realpath', 'rm',
  'rmdir', 'sed', 'sort', 'source', 'tail', 'tee', 'test', 'touch', 'tr', 'true', 'type', 'umask', 'uniq', 'unset', 'wc', 'which',
]);

const GLOB_PATTERN = /[*?\[\]{}()!@]/;

function shellPath(value, cwd) {
  const source = String(value);
  const base = source.startsWith('/') ? [] : String(cwd).split('/').filter(Boolean);
  const parts = [...base];
  for (const part of source.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}` || '/';
}

function result(code = 0, stdout = '', stderr = '') {
  return {
    code,
    stdout: stdout == null ? '' : String(stdout),
    stderr: stderr == null ? '' : String(stderr),
  };
}

function shellText(value) {
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return value == null ? '' : String(value);
}

function commandError(command, message, code = 1) {
  return result(code, '', `${command}: ${message}\n`);
}

function isAssignment(word) {
  const raw = rawShellWord(word);
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw);
}

async function fileIs(fs, pathname, type = 'file') {
  try {
    const stats = await fs.stat(pathname);
    return type === 'directory' ? stats.isDirectory() : stats.isFile();
  } catch {
    return false;
  }
}

async function expandWord(word, context, { pathname = false } = {}) {
  const expanded = expandShellWord(word, context.env, context.lastStatus);
  if (pathname || !expanded.glob || !GLOB_PATTERN.test(expanded.value) || !context.fs.glob) {
    return [expanded.value];
  }
  try {
    const matches = await context.fs.glob(expanded.value, context.cwd);
    if (matches.length) return [...matches].map(String).sort();
  } catch {
    // An unmatched glob is passed to the command literally, like POSIX sh.
  }
  return [expanded.value];
}

async function expandWords(words, context) {
  const values = [];
  for (const word of words) values.push(...await expandWord(word, context));
  return values;
}

async function resolveCommand(name, context) {
  if (BUILTINS.has(name)) return { type: 'builtin', name };
  if (name === 'node' || name === 'nodejs' || name === '/browser/node') return { type: 'node', name };
  if (name === 'npm' || name === 'npx') return { type: 'npm', name };
  // Package-manager children are virtual browser commands. They do not need
  // a materialized .bin shim because the runtime handles their registry and
  // lifecycle operations directly, but shell lookup must still match Node's
  // PATH-visible command contract.
  if (name === 'yarn' || name === 'yarnpkg') {
    return { type: 'external', path: `${String(context.cwd || '/node').replace(/\/$/, '')}/node_modules/.bin/${name}`, name };
  }
  if (name === 'sh' || name === 'bash' || name === '/bin/sh' || name === '/bin/bash') return { type: 'shell', name };

  const candidates = [];
  if (name.includes('/')) candidates.push(shellPath(name, context.cwd));
  else {
    for (const segment of String(context.env.PATH || '').split(':')) {
      const directory = segment ? shellPath(segment, context.cwd) : context.cwd;
      candidates.push(`${directory.replace(/\/$/, '')}/${name}`);
    }
  }
  for (const pathname of candidates) {
    if (await fileIs(context.fs, pathname)) return { type: 'external', path: pathname, name };
  }
  return null;
}

async function readInputFile(pathname, context, command) {
  try {
    return await context.fs.readFile(pathname);
  } catch {
    return commandError(command, `No such file or directory: ${pathname}`);
  }
}

async function createFileDestination(pathname, append, context) {
  let text = '';
  if (append) {
    try { text = String(await context.fs.readFile(pathname)); } catch { /* append creates a missing file */ }
  }
  return { kind: 'file', pathname, text, append };
}

function createCaptureDestination() {
  return { kind: 'capture', text: '' };
}

function writeDestination(destination, value) {
  destination.text += String(value);
}

async function flushDestinations(destinations, context, command) {
  const written = new Set();
  for (const destination of destinations) {
    if (destination.kind !== 'file' || written.has(destination)) continue;
    written.add(destination);
    try {
      await context.fs.writeFile(destination.pathname, destination.text);
    } catch (error) {
      return commandError(command, error.message || String(error));
    }
  }
  return null;
}

function textLines(value) {
  const lines = String(value).split(/\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

async function runCat(args, input, context) {
  const files = args.filter((arg) => arg !== '-n' && arg !== '--number');
  if (!files.length) return result(0, input);
  let stdout = '';
  let stderr = '';
  let code = 0;
  for (const file of files) {
    if (file === '-') {
      stdout += input;
      continue;
    }
    try { stdout += String(await context.fs.readFile(shellPath(file, context.cwd))); }
    catch { stderr += `cat: ${file}: No such file or directory\n`; code = 1; }
  }
  if (args.includes('-n') || args.includes('--number')) {
    stdout = textLines(stdout).map((line, index) => `${String(index + 1).padStart(6)}\t${line}\n`).join('');
  }
  return result(code, stdout, stderr);
}

function parseNumberOption(args, index, fallback) {
  const value = args[index] === undefined ? undefined : Number(args[index]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

async function runGrep(args, input, context) {
  let invert = false;
  let ignoreCase = false;
  let numbered = false;
  let quiet = false;
  let index = 0;
  while (index < args.length && args[index].startsWith('-') && args[index] !== '-') {
    if (args[index] === '--') { index += 1; break; }
    const flags = args[index].slice(1);
    if (!flags || flags === '-') break;
    for (const flag of flags) {
      if (flag === 'v') invert = true;
      else if (flag === 'i') ignoreCase = true;
      else if (flag === 'n') numbered = true;
      else if (flag === 'q') quiet = true;
      else if (flag === 'E' || flag === 'F') continue;
      else return commandError('grep', `invalid option -- '${flag}'`);
    }
    index += 1;
  }
  const pattern = args[index++];
  if (pattern === undefined) return commandError('grep', 'missing pattern');
  const files = args.slice(index);
  let code = 1;
  let stdout = '';
  let stderr = '';
  const sources = files.length ? files : ['-'];
  for (const file of sources) {
    let contents;
    if (file === '-') contents = input;
    else {
      try { contents = String(await context.fs.readFile(shellPath(file, context.cwd))); }
      catch { stderr += `grep: ${file}: No such file or directory\n`; code = 2; continue; }
    }
    const matcher = ignoreCase ? String(pattern).toLowerCase() : String(pattern);
    for (const [lineIndex, line] of textLines(contents).entries()) {
      const candidate = ignoreCase ? line.toLowerCase() : line;
      const matches = candidate.includes(matcher);
      if (matches === invert) continue;
      code = 0;
      if (quiet) return result(0, '', stderr);
      const prefix = files.length > 1 ? `${file}:` : '';
      const lineNumber = numbered ? `${lineIndex + 1}:` : '';
      stdout += `${prefix}${lineNumber}${line}\n`;
    }
  }
  return result(code, stdout, stderr);
}

function decodeTextArgument(value) {
  return String(value)
    .replaceAll('\\n', '\n')
    .replaceAll('\\r', '\r')
    .replaceAll('\\t', '\t')
    .replaceAll('\\\\', '\\');
}

function expandCharacterSet(value) {
  const decoded = decodeTextArgument(value);
  const characters = [];
  for (let index = 0; index < decoded.length; index += 1) {
    if (decoded[index + 1] === '-' && decoded[index + 2] !== undefined) {
      const start = decoded.charCodeAt(index);
      const end = decoded.charCodeAt(index + 2);
      if (start <= end) {
        for (let code = start; code <= end; code += 1) characters.push(String.fromCharCode(code));
        index += 2;
        continue;
      }
    }
    characters.push(decoded[index]);
  }
  return characters;
}

function runTr(args, input) {
  let deleteCharacters = false;
  let squeezeCharacters = false;
  const values = [];
  for (const arg of args) {
    if (arg === '-d' || arg === '--delete') deleteCharacters = true;
    else if (arg === '-s' || arg === '--squeeze-repeats') squeezeCharacters = true;
    else if (!arg.startsWith('-') || arg === '-') values.push(arg);
  }
  if (!values.length) return commandError('tr', 'missing operand');
  const source = expandCharacterSet(values[0]);
  const replacement = expandCharacterSet(values[1] ?? (squeezeCharacters ? values[0] : ''));
  const replacementMap = new Map(source.map((character, index) => [character, replacement[index] ?? replacement.at(-1) ?? '']));
  let output = '';
  let lastOutput = '';
  for (const character of String(input)) {
    if (deleteCharacters && source.includes(character)) continue;
    const transformed = deleteCharacters ? character : replacementMap.get(character) ?? character;
    if (squeezeCharacters && transformed === lastOutput && source.includes(character)) continue;
    output += transformed;
    lastOutput = transformed;
  }
  return result(0, output);
}

async function runCut(args, input, context) {
  let delimiter = '\t';
  let fields = '';
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    const option = args[index];
    if (option === '--') { index += 1; break; }
    if (option === '-d') delimiter = args[++index] ?? delimiter;
    else if (option.startsWith('-d')) delimiter = option.slice(2);
    else if (option === '-f') fields = args[++index] ?? '';
    else if (option.startsWith('-f')) fields = option.slice(2);
    else return commandError('cut', `invalid option -- '${option.slice(1)}'`);
    index += 1;
  }
  if (!fields) return commandError('cut', 'you must specify a list of bytes, characters, or fields');
  const selectedFields = new Set();
  for (const part of fields.split(',')) {
    const [start, end] = part.split('-').map((value) => value ? Number(value) : undefined);
    if (!Number.isInteger(start) && !Number.isInteger(end)) continue;
    const first = start ?? 1;
    const last = end ?? start;
    for (let field = first; field <= (last ?? first); field += 1) selectedFields.add(field);
  }
  const files = args.slice(index);
  let contents = input;
  if (files.length) {
    try { contents = String(await context.fs.readFile(shellPath(files[0], context.cwd))); }
    catch { return commandError('cut', `${files[0]}: No such file or directory`); }
  }
  const lines = textLines(contents);
  const output = lines.map((line) => line.split(delimiter).filter((_value, field) => selectedFields.has(field + 1)).join(delimiter));
  return result(0, `${output.join('\n')}${contents.endsWith('\n') && output.length ? '\n' : ''}`);
}

function runUniq(args, input) {
  const count = args.includes('-c') || args.includes('--count');
  const duplicatesOnly = args.includes('-d') || args.includes('--repeated');
  const uniqueOnly = args.includes('-u') || args.includes('--unique');
  const groups = [];
  for (const line of textLines(input)) {
    const previous = groups.at(-1);
    if (previous?.line === line) previous.count += 1;
    else groups.push({ line, count: 1 });
  }
  const selected = groups.filter(({ count: occurrences }) => (!duplicatesOnly || occurrences > 1) && (!uniqueOnly || occurrences === 1));
  const output = selected.map(({ line, count: occurrences }) => count
    ? `${String(occurrences).padStart(7)} ${line}`
    : line);
  return result(0, `${output.join('\n')}${output.length && input.endsWith('\n') ? '\n' : ''}`);
}

async function runTee(args, input, context) {
  const append = args.includes('-a') || args.includes('--append');
  const files = args.filter((arg) => !arg.startsWith('-'));
  for (const file of files) {
    const pathname = shellPath(file, context.cwd);
    let contents = '';
    if (append) {
      try { contents = String(await context.fs.readFile(pathname)); } catch { /* tee creates a missing file */ }
    }
    try { await context.fs.writeFile(pathname, contents + input); }
    catch (error) { return commandError('tee', error.message || String(error)); }
  }
  return result(0, input);
}

function runPrintenv(args, context) {
  const names = args.filter((arg) => arg !== '--');
  if (!names.length) return result(0, `${Object.entries(context.env).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
  let code = 0;
  let stdout = '';
  for (const name of names) {
    if (context.env[name] === undefined) { code = 1; continue; }
    stdout += `${context.env[name]}\n`;
  }
  return result(code, stdout);
}

function shellGlobRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('*', '.*').replaceAll('?', '.')}\$`);
}

async function runFind(args, context) {
  let index = 0;
  const root = args[0] && !args[0].startsWith('-') ? args[index++] : '.';
  let namePattern = null;
  let type = null;
  let maxDepth = Infinity;
  while (index < args.length) {
    const option = args[index++];
    if (option === '-name') namePattern = args[index++];
    else if (option === '-type') type = args[index++];
    else if (option === '-maxdepth') maxDepth = Number(args[index++]);
    else if (option === '-print' || option === '--') continue;
    else return commandError('find', `unknown predicate: ${option}`);
  }
  if (maxDepth !== Infinity && (!Number.isInteger(maxDepth) || maxDepth < 0)) {
    return commandError('find', 'invalid maxdepth');
  }
  const matcher = namePattern === null ? null : shellGlobRegExp(namePattern);
  const matches = [];
  const visit = async (pathname, display, depth) => {
    let stats;
    try { stats = await context.fs.stat(pathname); }
    catch { return; }
    const kind = stats.isDirectory() ? 'd' : 'f';
    if ((!type || type === kind) && (!matcher || matcher.test(display.split('/').at(-1)))) matches.push(display);
    if (!stats.isDirectory() || depth >= maxDepth) return;
    const entries = await context.fs.readdir(pathname);
    for (const entry of [...new Set(entries)].sort()) {
      await visit(`${pathname.replace(/\/$/, '')}/${entry}`, `${display.replace(/\/$/, '')}/${entry}`, depth + 1);
    }
  };
  await visit(shellPath(root, context.cwd), root, 0);
  return result(0, matches.length ? `${matches.join('\n')}\n` : '');
}

async function runSed(args, input, context) {
  const files = args.filter((arg) => !arg.startsWith('-') && !arg.startsWith('s/'));
  const expression = args.find((arg) => arg.startsWith('s/'));
  if (!expression) return result(0, input);
  const match = expression.match(/^s\/((?:\\.|[^/])*)\/((?:\\.|[^/])*)\/([gim]*)$/);
  if (!match) return commandError('sed', `unsupported expression: ${expression}`);
  const pattern = match[1].replaceAll('\\/', '/');
  const replacement = match[2].replaceAll('\\/', '/');
  const flags = match[3].includes('g') ? 'g' : '';
  const regexp = new RegExp(pattern, `${flags}${match[3].includes('i') ? 'i' : ''}`);
  const transform = (source) => textLines(source).map((line) => `${line.replace(regexp, replacement)}\n`).join('');
  if (!files.length) return result(0, transform(input));
  let stdout = '';
  let stderr = '';
  let code = 0;
  for (const file of files) {
    try { stdout += transform(String(await context.fs.readFile(shellPath(file, context.cwd)))); }
    catch { stderr += `sed: ${file}: No such file or directory\n`; code = 2; }
  }
  return result(code, stdout, stderr);
}

function runEcho(args) {
  let newline = true;
  if (args[0] === '-n') {
    newline = false;
    args = args.slice(1);
  }
  return result(0, `${args.join(' ')}${newline ? '\n' : ''}`);
}

function runPrintf(args) {
  if (!args.length) return result(0);
  let format = String(args[0]).replaceAll('\\n', '\n').replaceAll('\\t', '\t').replaceAll('\\\\', '\\');
  let argIndex = 1;
  format = format.replace(/%([sdif%])/g, (_, type) => {
    if (type === '%') return '%';
    const value = args[argIndex++] ?? '';
    if (type === 'd' || type === 'i') return String(Number.parseInt(value, 10) || 0);
    if (type === 'f') return String(Number(value) || 0);
    return String(value);
  });
  return result(0, format);
}

function runPwd(context) {
  return result(0, `${context.cwd}\n`);
}

async function runLs(args, context) {
  const showAll = args.some((arg) => arg === '--all' || (arg.startsWith('-') && arg.includes('a')));
  const long = args.some((arg) => arg === '--long' || (arg.startsWith('-') && arg.includes('l')));
  const directoryOnly = args.some((arg) => arg === '--directory' || (arg.startsWith('-') && arg.includes('d')));
  const paths = args.filter((arg) => arg !== '--' && !arg.startsWith('-'));
  const targets = paths.length ? paths : ['.'];
  let stdout = '';
  let stderr = '';
  let code = 0;
  for (const target of targets) {
    const pathname = shellPath(target, context.cwd);
    try {
      const stats = await context.fs.stat(pathname);
      if (!stats.isDirectory() || directoryOnly) {
        stdout += `${long ? `${stats.isDirectory() ? 'd' : '-'}rwxr-xr-x ` : ''}${target}\n`;
        continue;
      }
      const entries = [...new Set(await context.fs.readdir(pathname))]
        .filter((entry) => showAll || !entry.startsWith('.'))
        .sort();
      const lines = long
        ? await Promise.all(entries.map(async (entry) => {
          let entryStats;
          try { entryStats = await context.fs.stat(`${pathname.replace(/\/$/, '')}/${entry}`); }
          catch { entryStats = { isDirectory: () => false }; }
          return `${entryStats.isDirectory() ? 'd' : '-'}rwxr-xr-x ${entry}`;
        }))
        : entries;
      if (targets.length > 1) stdout += `${target}:\n`;
      if (lines.length) stdout += `${lines.join('\n')}\n`;
    } catch {
      stderr += `ls: cannot access '${target}': No such file or directory\n`;
      code = 2;
    }
  }
  return result(code, stdout, stderr);
}

function runPs(args, context) {
  const rows = typeof context.processList === 'function'
    ? context.processList()
    : [{ pid: context.pid ?? 1, command: 'browser-node' }];
  const output = ['  PID COMMAND'];
  for (const row of rows || []) {
    const pid = row?.pid ?? row?.id ?? 1;
    const command = row?.command ?? row?.entry ?? 'browser-node';
    output.push(`${String(pid).padStart(5)} ${command}`);
  }
  return result(0, `${output.join('\n')}\n`);
}

async function runEnv(args, input, context, runProgram) {
  let childEnv = { ...context.env };
  let index = 0;
  if (args[0] === '-i') {
    childEnv = { PATH: context.env.PATH || '/usr/local/bin:/usr/bin:/bin' };
    index = 1;
  }
  while (index < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[index])) {
    const separator = args[index].indexOf('=');
    childEnv[args[index].slice(0, separator)] = args[index].slice(separator + 1);
    index += 1;
  }
  if (index === args.length) {
    return result(0, `${Object.entries(childEnv).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
  }
  return runProgram(args[index], args.slice(index + 1), input, { ...context, env: childEnv });
}

async function runTest(args, context) {
  if (args[0] === '!') return result((await runTest(args.slice(1), context)).code === 0 ? 1 : 0);
  if (args.length === 3 && ['=', '==', '!='].includes(args[1])) {
    const equal = args[0] === args[2];
    return result(args[1] === '!=' ? (equal ? 1 : 0) : (equal ? 0 : 1));
  }
  if (args.length === 2 && ['-e', '-f', '-d'].includes(args[0])) {
    const type = args[0] === '-d' ? 'directory' : 'file';
    const exists = args[0] === '-e'
      ? await context.fs.exists(shellPath(args[1], context.cwd))
      : await fileIs(context.fs, shellPath(args[1], context.cwd), type);
    return result(exists ? 0 : 1);
  }
  if (args.length === 2 && ['-n', '-z'].includes(args[0])) {
    const nonEmpty = args[1].length > 0;
    return result((args[0] === '-n' ? nonEmpty : !nonEmpty) ? 0 : 1);
  }
  return result(args.length === 1 && args[0] ? 0 : 1);
}

async function runFileUtility(name, args, input, context) {
  if (name === 'cat') return runCat(args, input, context);
  if (name === 'grep') return runGrep(args, input, context);
  if (name === 'cut') return runCut(args, input, context);
  if (name === 'find') return runFind(args, context);
  if (name === 'sed') return runSed(args, input, context);
  if (name === 'ls') return runLs(args, context);
  if (name === 'ps') return runPs(args, context);
  if (name === 'printenv') return runPrintenv(args, context);
  if (name === 'pwd') return runPwd(context);
  if (name === 'realpath') return result(0, `${shellPath(args[0] || '.', context.cwd)}\n`);
  if (name === 'sort') return result(0, `${textLines(input).sort().join('\n')}${input.endsWith('\n') ? '\n' : ''}`);
  if (name === 'tee') return runTee(args, input, context);
  if (name === 'head' || name === 'tail') {
    let count = 10;
    const optionIndex = args.indexOf('-n');
    if (optionIndex >= 0) count = parseNumberOption(args, optionIndex + 1, count);
    const lines = textLines(input);
    const selected = name === 'head' ? lines.slice(0, count) : lines.slice(-count);
    return result(0, `${selected.join('\n')}${selected.length ? '\n' : ''}`);
  }
  if (name === 'wc') {
    const lines = textLines(input).length;
    const words = input.trim() ? input.trim().split(/\s+/).length : 0;
    const bytes = new TextEncoder().encode(input).byteLength;
    return result(0, `      ${lines}      ${words}      ${bytes}\n`);
  }
  if (name === 'tr') return runTr(args, input);
  if (name === 'uniq') return runUniq(args, input);
  return null;
}

async function runBuiltin(name, args, input, context, runProgram, options) {
  if (name === ':' || name === 'true') return result(0);
  if (name === 'false') return result(1);
  if (name === 'echo') return runEcho(args);
  if (name === 'printf') return runPrintf(args);
  if (name === 'pwd') return runPwd(context);
  if (name === 'env') return runEnv(args, input, context, runProgram);
  if (name === 'cat' || name === 'cut' || name === 'find' || name === 'grep' || name === 'ls' || name === 'ps'
    || name === 'printenv' || name === 'realpath' || name === 'sed' || name === 'sort' || name === 'tail'
    || name === 'tee' || name === 'tr' || name === 'uniq' || name === 'head' || name === 'wc') {
    return runFileUtility(name, args, input, context);
  }
  if (name === 'cd') {
    const shellState = context.shellState || context;
    const target = args[0] === '-' ? shellState.previousCwd || shellState.cwd : args[0] || context.env.HOME || '/';
    const pathname = shellPath(target, shellState.cwd);
    if (!(await fileIs(context.fs, pathname, 'directory'))) return commandError('cd', `${target}: No such file or directory`);
    shellState.previousCwd = shellState.cwd;
    shellState.cwd = pathname;
    return result(0);
  }
  if (name === '.' || name === 'source') {
    const script = args[0];
    if (!script) return commandError(name, 'filename argument required');
    let source;
    try { source = String(await context.fs.readFile(shellPath(script, context.cwd))); }
    catch { return commandError(name, `${script}: No such file or directory`); }
    const shellState = context.shellState || context;
    const stdout = [];
    const stderr = [];
    const nested = await runShellScript(source, {
      ...options,
      args: args.slice(1),
      cwd: shellState.cwd,
      env: shellState.env,
      fs: context.fs,
      stdin: input,
      signal: context.signal,
      timeout: context.timeout,
      onNetwork: context.onNetwork,
      onStdout: (chunk) => stdout.push(String(chunk)),
      onStderr: (chunk) => stderr.push(String(chunk)),
    });
    shellState.cwd = nested.cwd;
    for (const key of Object.keys(shellState.env)) delete shellState.env[key];
    Object.assign(shellState.env, nested.env);
    return result(nested.code, stdout.join(''), stderr.join(''));
  }
  if (name === 'export') {
    const shellState = context.shellState || context;
    for (const assignment of args) {
      const separator = assignment.indexOf('=');
      if (separator < 1) continue;
      shellState.env[assignment.slice(0, separator)] = assignment.slice(separator + 1);
    }
    return result(0);
  }
  if (name === 'unset') {
    const shellState = context.shellState || context;
    for (const key of args) delete shellState.env[key];
    return result(0);
  }
  if (name === 'test' || name === '[') {
    const testArgs = name === '[' && args.at(-1) === ']' ? args.slice(0, -1) : args;
    return runTest(testArgs, context);
  }
  if (name === 'command' || name === 'which' || name === 'type') {
    const commandArgs = args.filter((arg) => arg !== '-v' && arg !== '-a');
    if (!commandArgs.length) return result(0);
    const resolved = await resolveCommand(commandArgs[0], context);
    if (!resolved) return commandError(commandArgs[0], 'command not found', 127);
    const display = resolved.type === 'builtin' ? commandArgs[0] : resolved.type === 'node' ? '/browser/node' : resolved.path;
    if (name === 'command' || name === 'which') return result(0, `${display}\n`);
    return result(0, `${commandArgs[0]} is ${resolved.type === 'builtin' ? 'a shell builtin' : display}\n`);
  }
  if (name === 'mkdir') {
    const recursive = args.includes('-p');
    for (const target of args.filter((arg) => !arg.startsWith('-'))) {
      try { await context.fs.mkdir(shellPath(target, context.cwd), { recursive }); }
      catch (error) { return commandError('mkdir', error.message || String(error)); }
    }
    return result(0);
  }
  if (name === 'rm') {
    const force = args.includes('-f');
    const recursive = args.some((arg) => arg === '-r' || arg === '-R' || arg.includes('r'));
    for (const target of args.filter((arg) => !arg.startsWith('-'))) {
      try { await context.fs.remove(shellPath(target, context.cwd), { recursive, force }); }
      catch (error) {
        if (!force) return commandError('rm', error.message || String(error));
      }
    }
    return result(0);
  }
  if (name === 'touch') {
    for (const target of args) {
      const pathname = shellPath(target, context.cwd);
      if (!(await context.fs.exists(pathname))) await context.fs.writeFile(pathname, '');
    }
    return result(0);
  }
  if (name === 'rmdir') {
    for (const target of args.filter((arg) => arg !== '--' && !arg.startsWith('-'))) {
      try { await context.fs.remove(shellPath(target, context.cwd), { recursive: false, force: false }); }
      catch (error) { return commandError('rmdir', error.message || String(error)); }
    }
    return result(0);
  }
  if (name === 'cp' || name === 'mv') {
    const recursive = args.some((arg) => arg === '-r' || arg === '-R' || arg === '-a');
    const operands = args.filter((arg) => arg !== '--' && !arg.startsWith('-'));
    if (operands.length < 2) return commandError(name, 'missing file operand');
    const destination = shellPath(operands.at(-1), context.cwd);
    const destinationIsDirectory = await fileIs(context.fs, destination, 'directory');
    if (operands.length > 2 && !destinationIsDirectory) return commandError(name, 'target is not a directory');
    for (const operand of operands.slice(0, -1)) {
      const source = shellPath(operand, context.cwd);
      const target = destinationIsDirectory
        ? `${destination.replace(/\/$/, '')}/${operand.replace(/\/$/, '').split('/').at(-1)}`
        : destination;
      try {
        if (name === 'cp') {
          await context.fs.copy(source, target, { recursive, force: true });
        } else {
          if (await context.fs.exists(target)) {
            await context.fs.remove(target, { recursive: true, force: true });
          }
          await context.fs.rename(source, target);
        }
      } catch (error) { return commandError(name, error.message || String(error)); }
    }
    return result(0);
  }
  if (name === 'basename' || name === 'dirname') {
    const value = args[0] || '';
    const clean = value.replace(/\/+$/, '');
    const slash = clean.lastIndexOf('/');
    return result(0, `${name === 'basename' ? clean.slice(slash + 1) : clean.slice(0, slash) || '.'}\n`);
  }
  if (name === 'alias' || name === 'umask') return result(0);
  return commandError(name, 'not implemented');
}

async function runNode(args, input, context, options) {
  if (typeof options.runNode !== 'function') return commandError('node', 'Node execution is unavailable');
  let index = 0;
  while (index < args.length && args[index].startsWith('-') && args[index] !== '--') {
    const flag = args[index];
    if (flag === '-e' || flag === '--eval') {
      const code = args[index + 1];
      if (code === undefined) return commandError('node', 'argument expected for -e');
      return options.runNode({
        args: args.slice(index + 2), code, print: false, input, cwd: context.cwd, env: context.env,
        signal: context.signal, timeout: context.timeout,
        onNetwork: context.onNetwork,
        onStdout: context.onStdout, onStderr: context.onStderr,
      });
    }
    if (flag === '-p' || flag === '--print') {
      const code = args[index + 1];
      if (code === undefined) return commandError('node', 'argument expected for -p');
      return options.runNode({
        args: args.slice(index + 2), code, print: true, input, cwd: context.cwd, env: context.env,
        signal: context.signal, timeout: context.timeout,
        onNetwork: context.onNetwork,
        onStdout: context.onStdout, onStderr: context.onStderr,
      });
    }
    if (flag === '--version' || flag === '-v') return result(0, `${options.nodeVersion || DEFAULT_NODE_VERSION}\n`);
    index += flag === '--input-type' ? 2 : 1;
  }
  if (args[index] === '--') index += 1;
  const script = args[index];
  if (!script) return commandError('node', 'no script specified');
  return options.runNode({
    script: shellPath(script, context.cwd),
    args: args.slice(index + 1),
    cwd: context.cwd,
    env: context.env,
    input,
    signal: context.signal,
    timeout: context.timeout,
    onNetwork: context.onNetwork,
    onStdout: context.onStdout,
    onStderr: context.onStderr,
  });
}

async function runShell(name, args, input, context, options) {
  let source;
  let scriptArgs = [];
  if (args[0] === '-c') {
    source = args[1];
    scriptArgs = args.slice(2);
  } else {
    const script = args[0];
    if (!script) return commandError(name, 'no script specified');
    scriptArgs = args.slice(1);
    try { source = String(await context.fs.readFile(shellPath(script, context.cwd))); }
    catch { return commandError(name, `${script}: No such file or directory`); }
  }
  if (source === undefined) return commandError(name, 'argument expected for -c');
  const stdout = [];
  const stderr = [];
  const nested = await runShellScript(source, {
    ...options,
    args: scriptArgs,
    cwd: context.cwd,
    env: context.env,
    stdin: input,
    onNetwork: (event) => context.onNetwork?.(event),
    onStdout: (chunk) => stdout.push(String(chunk)),
    onStderr: (chunk) => stderr.push(String(chunk)),
  });
  return result(nested.code, stdout.join(''), stderr.join(''));
}

async function runNpm(name, args, input, context, options) {
  if (name === 'npx') {
    const commandArgs = args.filter((arg) => !['-y', '--yes', '--'].includes(arg));
    if (!commandArgs.length) return commandError('npx', 'missing command');
    return runProgram(commandArgs[0], commandArgs.slice(1), input, context, options);
  }
  const meaningfulArgs = args.filter((arg) => !['--silent', '--loglevel=silent'].includes(arg));
  if (meaningfulArgs[0] === '--version' || meaningfulArgs[0] === '-v') return result(0, '10.0.0-browser\n');
  const isTest = meaningfulArgs[0] === 'test';
  if ((!['run', 'run-script'].includes(meaningfulArgs[0]) && !isTest)
    || (!isTest && !meaningfulArgs[1])) {
    return commandError('npm', 'only npm run is supported by the browser shell');
  }
  if (typeof options.npmRun !== 'function') return commandError('npm', 'npm execution is unavailable');
  const scriptName = isTest ? 'test' : meaningfulArgs[1];
  const separator = meaningfulArgs.indexOf('--');
  const scriptArgs = separator >= 0 ? meaningfulArgs.slice(separator + 1) : isTest ? [] : meaningfulArgs.slice(2);
  const stdout = [];
  const stderr = [];
  let streamed = false;
  try {
    const child = await options.npmRun(scriptName, {
      args: scriptArgs,
      cwd: context.cwd,
      env: context.env,
      stdin: input,
      signal: context.signal,
      timeout: context.timeout,
      onNetwork: (event) => context.onNetwork?.(event),
      onStdout: (chunk) => {
        const text = String(chunk);
        stdout.push(text);
        if (text) streamed = true;
        context.onStdout?.(text);
      },
      onStderr: (chunk) => {
        const text = String(chunk);
        stderr.push(text);
        if (text) streamed = true;
        context.onStderr?.(text);
      },
    });
    const code = child && typeof child === 'object' && 'exit' in child
      ? await child.exit
      : child?.code;
    // A package-script implementation may expose its terminal output as
    // returned text instead of invoking the streaming callbacks. Preserve
    // that standard child-process contract without duplicating chunks that
    // were already forwarded through the callbacks.
    if (!stdout.length && typeof child?.stdoutText === 'function') {
      const returned = await child.stdoutText();
      if (returned) stdout.push(String(returned));
    }
    if (!stderr.length && typeof child?.stderrText === 'function') {
      const returned = await child.stderrText();
      if (returned) stderr.push(String(returned));
    }
    const res = result(code ?? 1, stdout.join(''), stderr.join(''));
    // A callback being available does not mean that the child actually
    // delivered output through it.  Callers use this bit to decide whether
    // returned stdout/stderr still needs forwarding; marking an empty stream
    // as streamed loses a valid child result at the shell boundary.
    res.streamed = streamed;
    return res;
  } catch (error) {
    return commandError('npm', error.message || String(error));
  }
}

async function runProgram(name, args, input, context, options) {
  const resolved = await resolveCommand(name, context);
  if (!resolved) return commandError(name, 'command not found', 127);
  if (resolved.type === 'builtin') return runBuiltin(resolved.name, args, input, context, (childName, childArgs, childInput, childContext) => runProgram(childName, childArgs, childInput, childContext, options), options);
  if (resolved.type === 'node') return runNode(args, input, context, options);
  if (resolved.type === 'npm') return runNpm(resolved.name, args, input, context, options);
  if (resolved.type === 'shell') return runShell(resolved.name, args, input, context, options);
  if (resolved.type === 'external' && resolved.path.endsWith('.sh')) {
    return runShell(resolved.name, [resolved.path, ...args], input, context, options);
  }
  return options.runCommand({
    entry: resolved.path, argv: args, cwd: context.cwd, env: context.env,
    stdin: input, signal: context.signal, timeout: context.timeout,
    onNetwork: context.onNetwork,
    onStdout: context.onStdout, onStderr: context.onStderr,
  });
}

async function executeSimple(command, context, options) {
  let commandEnv = { ...context.env };
  let wordIndex = 0;
  while (wordIndex < command.words.length && isAssignment(command.words[wordIndex])) {
    const assignment = (await expandWord(command.words[wordIndex], { ...context, env: commandEnv }, { pathname: true }))[0];
    const separator = assignment.indexOf('=');
    commandEnv[assignment.slice(0, separator)] = assignment.slice(separator + 1);
    wordIndex += 1;
  }
  const outputCapture = createCaptureDestination();
  const errorCapture = createCaptureDestination();
  let stdoutDestination = outputCapture;
  let stderrDestination = errorCapture;
  const destinations = [outputCapture, errorCapture];
  let input = context.stdin || '';
  let redirectError = null;

  for (const redirect of command.redirects) {
    if (redirect.operator === '2>&1') {
      stderrDestination = stdoutDestination;
      continue;
    }
    const target = (await expandWord(redirect.target, { ...context, env: commandEnv }, { pathname: true }))[0];
    const pathname = shellPath(target, context.cwd);
    if (redirect.operator === '<') {
      const source = await readInputFile(pathname, { ...context, env: commandEnv }, command.words[0] ? rawShellWord(command.words[0]) : 'shell');
      if (typeof source === 'object') redirectError = source;
      else input = source;
      continue;
    }
    const append = redirect.operator === '>>' || redirect.operator === '2>>';
    const fileDestination = await createFileDestination(pathname, append, { ...context, env: commandEnv });
    destinations.push(fileDestination);
    if (redirect.operator === '2>' || redirect.operator === '2>>') stderrDestination = fileDestination;
    else if (redirect.operator === '>&' || redirect.operator === '&>') {
      stdoutDestination = fileDestination;
      stderrDestination = fileDestination;
    } else stdoutDestination = fileDestination;
  }

  const shouldStreamStdout = stdoutDestination.kind === 'capture' && (context.isLastInPipeline ?? true);
  const shouldStreamStderr = stderrDestination.kind === 'capture';
  const commandContext = {
    ...context,
    env: commandEnv,
    shellState: context.shellState || context,
    onStdout: shouldStreamStdout ? options.onStdout : undefined,
    onStderr: shouldStreamStderr ? options.onStderr : undefined,
    onNetwork: options.onNetwork,
  };

  let commandResult = result(0);
  let rawResult = null;
  if (redirectError) commandResult = redirectError;
  else if (wordIndex < command.words.length) {
    const words = await expandWords(command.words.slice(wordIndex), commandContext);
    rawResult = await runProgram(words[0], words.slice(1), input, {
      ...commandContext,
      signal: options.signal,
      timeout: options.timeout,
    }, options);
    commandResult = result(rawResult?.code ?? 1, rawResult?.stdout, rawResult?.stderr);
  } else if (wordIndex > 0) {
    context.shellState.env = commandEnv;
  }

  writeDestination(stdoutDestination, commandResult.stdout);
  writeDestination(stderrDestination, commandResult.stderr);
  const flushError = await flushDestinations(destinations, commandContext, command.words[0] ? rawShellWord(command.words[0]) : 'shell');
  if (flushError) commandResult = flushError;

  if (wordIndex > 0 && command.words.length === wordIndex) context.shellState.env = commandEnv;
  return {
    code: commandResult.code,
    stdout: stdoutDestination.kind === 'capture' ? stdoutDestination.text : '',
    stderr: stderrDestination.kind === 'capture' ? stderrDestination.text : '',
    pipe: stdoutDestination.kind === 'capture' ? stdoutDestination.text : '',
    streamedStdout: Boolean(rawResult?.streamed && shouldStreamStdout),
    streamedStderr: Boolean(rawResult?.streamed && shouldStreamStderr),
  };
}

async function executePipeline(pipeline, context, options) {
  let input = context.stdin || '';
  let stderr = '';
  let last = result(0);
  let streamedStdout = false;
  let streamedStderr = false;
  for (let index = 0; index < pipeline.commands.length; index += 1) {
    const isLast = index === pipeline.commands.length - 1;
    const commandResult = await executeSimple(pipeline.commands[index], { ...context, stdin: input, isLastInPipeline: isLast }, options);
    last = commandResult;
    stderr += commandResult.stderr;
    input = commandResult.pipe;
    if (isLast && commandResult.streamedStdout) streamedStdout = true;
    if (commandResult.streamedStderr) streamedStderr = true;
  }
  return { code: last.code, stdout: last.stdout, stderr, streamedStdout, streamedStderr };
}

/** Execute the supported npm-script subset of POSIX shell syntax. */
export async function runShellScript(command, options) {
  const pipelines = parseShellScript(command);
  const state = {
    cwd: shellPath(options.cwd || '/node', '/'),
    env: { ...(options.env || {}) },
    previousCwd: null,
    lastStatus: 0,
    fs: options.fs,
    onNetwork: options.onNetwork,
  };
  const finalPipeline = pipelines.at(-1);
  const extraArgs = Array.isArray(options.args) ? options.args : [];
  if (extraArgs.length) {
    finalPipeline.commands.at(-1).words.push(...extraArgs.map(literalShellWord));
  }

  for (const pipeline of pipelines) {
    if (options.signal?.aborted) return { code: 130, cwd: state.cwd, env: state.env };
    const shouldRun = pipeline.connector === null
      || pipeline.connector === ';'
      || (pipeline.connector === '&&' && state.lastStatus === 0)
      || (pipeline.connector === '||' && state.lastStatus !== 0);
    if (!shouldRun) continue;
    const pipelineResult = await executePipeline(pipeline, { ...state, stdin: shellText(options.stdin), shellState: state }, options);
    state.lastStatus = pipelineResult.code;
    if (pipelineResult.stdout && !pipelineResult.streamedStdout) options.onStdout?.(pipelineResult.stdout);
    if (pipelineResult.stderr && !pipelineResult.streamedStderr) options.onStderr?.(pipelineResult.stderr);
  }
  return { code: state.lastStatus, cwd: state.cwd, env: state.env };
}

/** Return a process-like handle for npm's shell-backed script API. */
export function createShellProcess(command, options) {
  const stdout = [];
  const stderr = [];
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const signal = controller?.signal || options.signal;
  let removeExternalAbort = () => {};
  if (controller && options.signal) {
    const abortExternal = () => controller.abort(options.signal.reason);
    if (options.signal.aborted) abortExternal();
    else {
      options.signal.addEventListener('abort', abortExternal, { once: true });
      removeExternalAbort = () => options.signal.removeEventListener('abort', abortExternal);
    }
  }
  const exit = Promise.resolve().then(() => runShellScript(command, {
    ...options,
    signal,
    onStdout: (chunk) => { stdout.push(String(chunk)); options.onStdout?.(chunk); },
    onStderr: (chunk) => { stderr.push(String(chunk)); options.onStderr?.(chunk); },
    onNetwork: (event) => options.onNetwork?.(event),
  })).catch((error) => {
    const message = `${error?.message || error}\n`;
    stderr.push(message);
    options.onStderr?.(message);
    return { code: 2 };
  }).finally(removeExternalAbort).then((outcome) => outcome.code);
  return {
    exit,
    stdoutText: async () => { await exit; return stdout.join(''); },
    stderrText: async () => { await exit; return stderr.join(''); },
    kill: async () => {
      controller?.abort();
      await exit.catch(() => {});
    },
    structuredResult: null,
  };
}
