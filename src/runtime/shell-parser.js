const VARIABLE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*|\?|\$)/g;

const SHELL_OPERATORS = [
  '2>&1', '2>>', '2>', '&>', '>>', '&&', '||', '>&', '>', '<', '|', ';',
];

function shellSyntaxError(message) {
  const error = new SyntaxError(message);
  error.code = 'ERR_SHELL_SYNTAX';
  return error;
}

function samePartMode(left, right) {
  return left.expandVariables === right.expandVariables && left.glob === right.glob;
}

function appendPart(parts, text, expandVariables, glob) {
  const mode = { expandVariables, glob };
  const previous = parts.at(-1);
  if (previous && !previous.commandSubstitution && samePartMode(previous, mode)) previous.text += text;
  else parts.push({ text, ...mode });
}

function appendCommandSubstitution(parts, command, expandVariables, glob) {
  parts.push({ command, commandSubstitution: true, expandVariables, glob });
}

function commandSubstitutionEnd(source, start) {
  let depth = 1;
  let quote = null;
  for (let index = start + 2; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')' && --depth === 0) return index;
  }
  return -1;
}

function operatorAt(source, index) {
  return SHELL_OPERATORS.find((operator) => source.startsWith(operator, index));
}

function startsComment(source, index, wordStarted) {
  if (wordStarted || source[index] !== '#') return false;
  return index === 0 || /\s/.test(source[index - 1]);
}

/** Tokenize only the shell syntax needed by npm scripts. */
export function tokenizeShellScript(command) {
  const source = String(command);
  const tokens = [];
  let parts = [];
  let wordStarted = false;
  let quote = null;

  const pushWord = () => {
    if (!wordStarted) return;
    tokens.push({ type: 'word', parts });
    parts = [];
    wordStarted = false;
  };
  const pushOperator = (value) => {
    pushWord();
    tokens.push({ type: 'operator', value });
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (quote === "'") {
      if (character === "'") quote = null;
      else appendPart(parts, character, false, false);
      wordStarted = true;
      continue;
    }

    if (quote === '"') {
      if (character === '"') {
        quote = null;
        wordStarted = true;
        continue;
      }
      if (character === '\\') {
        const next = source[index + 1];
        if (next === '"' || next === '\\' || next === '$' || next === '`' || next === '\n') {
          appendPart(parts, next || '', false, false);
          index += 1;
        } else appendPart(parts, character, false, false);
        wordStarted = true;
        continue;
      }
      if (character === '$' && source[index + 1] === '(') {
        const end = commandSubstitutionEnd(source, index);
        if (end >= 0) {
          appendCommandSubstitution(parts, source.slice(index + 2, end), true, false);
          wordStarted = true;
          index = end;
          continue;
        }
      }
      appendPart(parts, character, true, false);
      wordStarted = true;
      continue;
    }

    if (character === "'") {
      quote = character;
      wordStarted = true;
      continue;
    }
    if (character === '"') {
      quote = character;
      wordStarted = true;
      continue;
    }
    if (character === '`') throw shellSyntaxError('command substitution is not supported in npm scripts');
    if (character === '$' && source[index + 1] === '(') {
      const end = commandSubstitutionEnd(source, index);
      if (end >= 0) {
        appendCommandSubstitution(parts, source.slice(index + 2, end), true, true);
        wordStarted = true;
        index = end;
        continue;
      }
    }
    if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      if (wordStarted) {
        pushWord();
        tokens.push({ type: 'operator', value: ';' });
      } else if (tokens.at(-1)?.type === 'word') {
        tokens.push({ type: 'operator', value: ';' });
      }
      continue;
    }
    if (character === '\\') {
      const next = source[index + 1];
      if (next === '\n') index += 1;
      else {
        appendPart(parts, next || '', false, false);
        wordStarted = true;
        index += 1;
      }
      continue;
    }
    if (startsComment(source, index, wordStarted)) {
      while (index < source.length && source[index] !== '\n') index += 1;
      index -= 1;
      continue;
    }
    if (/\s/.test(character)) {
      pushWord();
      continue;
    }

    const operator = operatorAt(source, index);
    if (operator) {
      pushOperator(operator);
      index += operator.length - 1;
      continue;
    }
    if (character === '&') throw shellSyntaxError('background jobs are not supported in npm scripts');
    appendPart(parts, character, true, true);
    wordStarted = true;
  }

  if (quote) throw shellSyntaxError('unterminated shell quote in npm script');
  pushWord();
  return tokens;
}

function emptyCommand() {
  return { words: [], redirects: [] };
}

/** Parse a shell command line into conditional pipelines and simple commands. */
export function parseShellScript(command) {
  const tokens = tokenizeShellScript(command);
  const pipelines = [];
  let pipeline = { connector: null, commands: [] };
  let simple = emptyCommand();

  const finishSimple = () => {
    if (!simple.words.length && !simple.redirects.length) {
      throw shellSyntaxError('expected a command');
    }
    pipeline.commands.push(simple);
    simple = emptyCommand();
  };
  const finishPipeline = (connector) => {
    if (!pipeline.commands.length) throw shellSyntaxError('expected a command before shell operator');
    pipelines.push(pipeline);
    pipeline = { connector, commands: [] };
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === 'word') {
      simple.words.push(token);
      continue;
    }
    if (token.value === '|') {
      finishSimple();
      continue;
    }
    if (['<', '>', '>>', '2>', '2>>', '>&', '&>'].includes(token.value)) {
      const target = tokens[++index];
      if (!target || target.type !== 'word') throw shellSyntaxError(`redirection ${token.value} needs a target`);
      simple.redirects.push({ operator: token.value, target });
      continue;
    }
    if (token.value === '2>&1') {
      simple.redirects.push({ operator: token.value });
      continue;
    }
    if (['&&', '||', ';'].includes(token.value)) {
      finishSimple();
      finishPipeline(token.value);
      continue;
    }
    throw shellSyntaxError(`unsupported shell operator: ${token.value}`);
  }

  if (simple.words.length || simple.redirects.length) finishSimple();
  if (pipeline.commands.length) finishPipeline(null);
  if (!pipelines.length) throw shellSyntaxError('shell script is empty');
  return pipelines;
}

function expandVariable(name, env, lastStatus) {
  if (name === '?') return String(lastStatus);
  if (name === '$') return String(env.$$ ?? '');
  return String(env[name] ?? '');
}

/** Expand variables while retaining shell quoting and globbing rules. */
export function expandShellWord(word, env, lastStatus = 0) {
  let value = '';
  let glob = false;
  for (const part of word.parts) {
    if (part.commandSubstitution) {
      value += `$(${part.command})`;
      glob ||= part.glob;
      continue;
    }
    const expanded = part.expandVariables
      ? part.text.replace(VARIABLE_PATTERN, (_, braced, plain) => expandVariable(braced || plain, env, lastStatus))
      : part.text;
    value += expanded;
    glob ||= part.glob;
  }
  return { value, glob };
}

/** Expand a shell word, including asynchronous POSIX command substitutions. */
export async function expandShellWordAsync(word, env, lastStatus = 0, runCommand) {
  let value = '';
  let glob = false;
  for (const part of word.parts) {
    if (part.commandSubstitution) {
      const nested = typeof runCommand === 'function'
        ? await runCommand(part.command)
        : { stdout: '' };
      // POSIX command substitution removes all trailing newlines from the
      // substituted command's standard output. Its stderr remains the
      // surrounding command's stderr and is handled by the caller.
      value += String(nested?.stdout || '').replace(/\n+$/, '');
      glob ||= part.glob;
      continue;
    }
    const expanded = part.expandVariables
      ? part.text.replace(VARIABLE_PATTERN, (_, braced, plain) => expandVariable(braced || plain, env, lastStatus))
      : part.text;
    value += expanded;
    glob ||= part.glob;
  }
  return { value, glob };
}

export function rawShellWord(word) {
  return word.parts.map((part) => part.text).join('');
}

export function literalShellWord(value) {
  return { type: 'word', parts: [{ text: String(value), expandVariables: false, glob: false }] };
}
