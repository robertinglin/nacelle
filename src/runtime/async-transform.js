const identifierStart = /[$A-Z_a-z]/;
const identifierPart = /[$\w]/u;
const regularExpressionPredecessors = new Set([
  '(', '[', '{', ',', ';', ':', '=', '=>', '!', '?', '&&', '||', '??',
  '+', '-', '*', '%', '&', '|', '^', '~', '<', '>', 'return', 'throw',
  'case', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of',
]);

function isIdentifierStart(character) {
  return character !== undefined && identifierStart.test(character);
}

function isIdentifierPart(character) {
  return character !== undefined && identifierPart.test(character);
}

function canStartRegularExpression(previous) {
  if (!previous) return true;
  return regularExpressionPredecessors.has(previous.value);
}

function skipQuoted(source, index, quote) {
  index += 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

function skipComment(source, index) {
  if (source[index + 1] === '/') {
    const newline = source.indexOf('\n', index + 2);
    return newline < 0 ? source.length : newline + 1;
  }
  const end = source.indexOf('*/', index + 2);
  return end < 0 ? source.length : end + 2;
}

function skipTemplate(source, index) {
  index += 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source[index] === '`') return index + 1;
    index += 1;
  }
  return source.length;
}

function skipRegularExpression(source, index) {
  index += 1;
  let inCharacterClass = false;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '[') inCharacterClass = true;
    else if (character === ']') inCharacterClass = false;
    else if (character === '/' && !inCharacterClass) {
      index += 1;
      while (isIdentifierPart(source[index])) index += 1;
      return index;
    }
    index += 1;
  }
  return source.length;
}

function literalToken(source, start, end) {
  return { value: '<literal>', start, end };
}

function tokenize(source) {
  const tokens = [];
  let index = 0;
  let previous;
  while (index < source.length) {
    const character = source[index];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
      index = skipComment(source, index);
      continue;
    }
    if (character === "'" || character === '"') {
      const start = index;
      index = skipQuoted(source, index, character);
      previous = literalToken(source, start, index);
      tokens.push(previous);
      continue;
    }
    if (character === '`') {
      const start = index;
      index = skipTemplate(source, index);
      previous = literalToken(source, start, index);
      tokens.push(previous);
      continue;
    }
    if (character === '/' && canStartRegularExpression(previous)) {
      const start = index;
      index = skipRegularExpression(source, index);
      previous = literalToken(source, start, index);
      tokens.push(previous);
      continue;
    }
    if (/\d/u.test(character)) {
      const start = index;
      index += 1;
      while (/[$\w.]/u.test(source[index] || '')) index += 1;
      previous = literalToken(source, start, index);
      tokens.push(previous);
      continue;
    }
    if (isIdentifierStart(character)) {
      const start = index;
      index += 1;
      while (isIdentifierPart(source[index])) index += 1;
      previous = { value: source.slice(start, index), start, end: index };
      tokens.push(previous);
      continue;
    }
    const start = index;
    const punctuator = source.slice(index).match(/^(?:=>|===|!==|\?\.|\?\?|&&|\|\||\*\*|\+\+|--|<<|>>|\.{3}|.)/s)[0];
    index += punctuator.length;
    previous = { value: punctuator, start, end: index };
    tokens.push(previous);
  }
  return tokens;
}

function matchingToken(tokens, index, opening, closing) {
  let depth = 0;
  for (let cursor = index; cursor < tokens.length; cursor += 1) {
    if (tokens[cursor].value === opening) depth += 1;
    else if (tokens[cursor].value === closing) {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

function asyncGeneratorBodyRanges(tokens) {
  const ranges = [];
  for (let index = 0; index < tokens.length - 2; index += 1) {
    const isFunctionGenerator = tokens[index].value === 'async'
      && tokens[index + 1].value === 'function'
      && tokens[index + 2].value === '*';
    const isMethodGenerator = tokens[index].value === 'async'
      && tokens[index + 1].value === '*';
    if (!isFunctionGenerator && !isMethodGenerator) continue;
    const bodyIndex = tokens.findIndex((token, tokenIndex) => tokenIndex > index && token.value === '{');
    if (bodyIndex < 0) continue;
    const bodyEnd = matchingToken(tokens, bodyIndex, '{', '}');
    if (bodyEnd >= 0) ranges.push({ start: bodyIndex, end: bodyEnd });
  }
  return ranges;
}

function rewriteForAwaitLoops(source) {
  const tokens = tokenize(source);
  const asyncGeneratorBodies = asyncGeneratorBodyRanges(tokens);
  const names = new Set(tokens.filter((token) => token.value !== '<literal>').map((token) => token.value));
  const replacements = [];
  let sequence = 0;
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (tokens[index].value !== 'for' || tokens[index + 1].value !== 'await') continue;
    if (asyncGeneratorBodies.some(({ start, end }) => index > start && index < end)) continue;
    const openIndex = index + 2;
    if (tokens[openIndex]?.value !== '(') continue;
    const closeIndex = matchingToken(tokens, openIndex, '(', ')');
    if (closeIndex < 0) continue;
    const bodyOpenIndex = closeIndex + 1;
    if (tokens[bodyOpenIndex]?.value !== '{') continue;
    const bodyCloseIndex = matchingToken(tokens, bodyOpenIndex, '{', '}');
    if (bodyCloseIndex < 0) continue;

    let roundDepth = 0;
    let squareDepth = 0;
    let curlyDepth = 0;
    let ofIndex = -1;
    for (let cursor = openIndex + 1; cursor < closeIndex; cursor += 1) {
      const value = tokens[cursor].value;
      if (value === '(') roundDepth += 1;
      else if (value === ')') roundDepth -= 1;
      else if (value === '[') squareDepth += 1;
      else if (value === ']') squareDepth -= 1;
      else if (value === '{') curlyDepth += 1;
      else if (value === '}') curlyDepth -= 1;
      else if (value === 'of' && roundDepth === 0 && squareDepth === 0 && curlyDepth === 0) {
        ofIndex = cursor;
        break;
      }
    }
    if (ofIndex < 0) continue;
    const declaration = source.slice(tokens[openIndex + 1].start, tokens[ofIndex].start).trim();
    const declarationMatch = /^(const|let|var)\s+([\s\S]+)$/.exec(declaration);
    if (!declarationMatch) continue;
    const iterable = source.slice(tokens[ofIndex].end, tokens[closeIndex].start).trim();
    if (!iterable) continue;

    const uniqueName = (base) => {
      let name = `${base}${sequence}`;
      while (names.has(name)) name = `${base}${++sequence}`;
      names.add(name);
      return name;
    };
    const valueName = uniqueName('__bnhForAwaitValue');
    const iteratorName = uniqueName('__bnhForAwaitIterator');
    const stepName = uniqueName('__bnhForAwaitStep');
    const body = source.slice(tokens[bodyOpenIndex].end, tokens[bodyCloseIndex].start);
    replacements.push({
      start: tokens[index].start,
      end: tokens[bodyCloseIndex].end,
      value: `{
  const ${valueName} = (${iterable});
  const ${iteratorName} = ${valueName}[Symbol.asyncIterator]
    ? ${valueName}[Symbol.asyncIterator]()
    : ${valueName}[Symbol.iterator]();
  let ${stepName};
  try {
    while (!(${stepName} = (yield Promise.resolve(${iteratorName}.next()).then((result) => (
      Promise.resolve(result.value).then((value) => ({ ...result, value }))
    )))).done) {
      ${declarationMatch[1]} ${declarationMatch[2]} = ${stepName}.value;${body}
    }
  } finally {
    if (${stepName} && !${stepName}.done && typeof ${iteratorName}.return === 'function') {
      yield Promise.resolve(${iteratorName}.return());
    }
  }
}`,
    });
  }
  return applyReplacements(source, replacements);
}

function findArrowBodyEnd(tokens, arrowIndex, sourceLength) {
  let round = 0;
  let square = 0;
  let curly = 0;
  for (let index = arrowIndex + 1; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === '(') round += 1;
    else if (value === ')') {
      if (round === 0 && square === 0 && curly === 0) return tokens[index].start;
      round -= 1;
    } else if (value === '[') square += 1;
    else if (value === ']') {
      if (square === 0 && round === 0 && curly === 0) return tokens[index].start;
      square -= 1;
    } else if (value === '{') curly += 1;
    else if (value === '}') {
      if (curly === 0 && round === 0 && square === 0) return tokens[index].start;
      curly -= 1;
    } else if ((value === ',' || value === ';') && round === 0 && square === 0 && curly === 0) {
      return tokens[index].start;
    }
  }
  return sourceLength;
}

function asyncFunctionCandidates(source) {
  const tokens = tokenize(source);
  const candidates = [];
  let unsupported = false;
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== 'async') continue;
    const next = tokens[index + 1];
    if (!next) continue;
    if (next.value === 'function') {
      if (tokens[index + 2]?.value === '*') {
        unsupported = true;
        continue;
      }
      const parameterStart = index + 2;
      const openIndex = tokens.findIndex((token, tokenIndex) => tokenIndex >= parameterStart && token.value === '(');
      if (openIndex < 0) continue;
      const closeIndex = matchingToken(tokens, openIndex, '(', ')');
      const bodyIndex = closeIndex < 0 ? -1 : closeIndex + 1;
      if (bodyIndex < 0 || tokens[bodyIndex]?.value !== '{') continue;
      const closeBodyIndex = matchingToken(tokens, bodyIndex, '{', '}');
      if (closeBodyIndex < 0) continue;
      candidates.push({
        kind: 'function',
        start: tokens[index].start,
        asyncEnd: tokens[index].end,
        headerEnd: tokens[bodyIndex].start,
        bodyStart: tokens[bodyIndex].start,
        bodyEnd: tokens[closeBodyIndex].end,
        bodyTokenStart: bodyIndex + 1,
        bodyTokenEnd: closeBodyIndex - 1,
      });
      continue;
    }

    if (isIdentifierStart(next.value[0]) && tokens[index + 2]?.value === '(') {
      const closeIndex = matchingToken(tokens, index + 2, '(', ')');
      const bodyIndex = closeIndex < 0 ? -1 : closeIndex + 1;
      if (bodyIndex >= 0 && tokens[bodyIndex]?.value === '{') {
        const closeBodyIndex = matchingToken(tokens, bodyIndex, '{', '}');
        if (closeBodyIndex >= 0) {
          candidates.push({
            kind: 'method',
            start: tokens[index].start,
            asyncEnd: tokens[index].end,
            headerEnd: tokens[bodyIndex].start,
            bodyStart: tokens[bodyIndex].start,
            bodyEnd: tokens[closeBodyIndex].end,
            bodyTokenStart: bodyIndex + 1,
            bodyTokenEnd: closeBodyIndex - 1,
          });
        }
      }
      continue;
    }

    let arrowIndex = -1;
    if (next.value === '(') {
      const closeIndex = matchingToken(tokens, index + 1, '(', ')');
      if (closeIndex >= 0 && tokens[closeIndex + 1]?.value === '=>') arrowIndex = closeIndex + 1;
    } else if (isIdentifierStart(next.value[0]) && tokens[index + 2]?.value === '=>') {
      arrowIndex = index + 2;
    }
    if (arrowIndex < 0) continue;
    const bodyToken = tokens[arrowIndex + 1];
    if (!bodyToken) continue;
    if (bodyToken.value === '{') {
      const closeBodyIndex = matchingToken(tokens, arrowIndex + 1, '{', '}');
      if (closeBodyIndex < 0) continue;
      candidates.push({
        kind: 'arrow-block',
        start: tokens[index].start,
        asyncEnd: tokens[index].end,
        arrowEnd: tokens[arrowIndex].end,
        headerEnd: bodyToken.start,
        bodyStart: bodyToken.start,
        bodyEnd: tokens[closeBodyIndex].end,
        bodyTokenStart: arrowIndex + 2,
        bodyTokenEnd: closeBodyIndex - 1,
      });
    } else {
      const end = findArrowBodyEnd(tokens, arrowIndex, source.length);
      if (end <= bodyToken.start) continue;
      candidates.push({
        kind: 'arrow-expression',
        start: tokens[index].start,
        asyncEnd: tokens[index].end,
        arrowEnd: tokens[arrowIndex].end,
        headerEnd: bodyToken.start,
        bodyStart: bodyToken.start,
        expressionStart: bodyToken.start,
        expressionEnd: end,
        bodyEnd: end,
      });
    }
  }
  const asyncGeneratorBodies = asyncGeneratorBodyRanges(tokens);
  const forAwaitPrefix = [0];
  const superPrefix = [0];
  for (let index = 0; index < tokens.length; index += 1) {
    forAwaitPrefix.push(forAwaitPrefix[index]
      + (tokens[index].value === 'for'
        && tokens[index + 1]?.value === 'await'
        && !asyncGeneratorBodies.some(({ start, end }) => index > start && index < end) ? 1 : 0));
    superPrefix.push(superPrefix[index] + (tokens[index].value === 'super' ? 1 : 0));
  }
  for (const candidate of candidates) {
    if (candidate.bodyTokenStart === undefined) continue;
    candidate.containsUnsupportedSyntax = forAwaitPrefix[candidate.bodyTokenEnd + 1]
      - forAwaitPrefix[candidate.bodyTokenStart] > 0
      || superPrefix[candidate.bodyTokenEnd + 1] - superPrefix[candidate.bodyTokenStart] > 0;
  }
  return { candidates, unsupported };
}

function awaitOperandEnd(tokens, awaitIndex) {
  let index = awaitIndex + 1;
  const consumePrimary = () => {
    const token = tokens[index];
    if (!token) return index;
    if (token.value === 'async' && tokens[index + 1]?.value === 'function') {
      index += 1;
      consumePrimary();
      return index;
    }
    if (token.value === 'function') {
      index += 1;
      if (tokens[index]?.value === '*') index += 1;
      if (isIdentifierStart(tokens[index]?.value?.[0])) index += 1;
      if (tokens[index]?.value === '(') {
        const parametersEnd = matchingToken(tokens, index, '(', ')');
        index = parametersEnd < 0 ? tokens.length : parametersEnd + 1;
      }
      if (tokens[index]?.value === '{') {
        const bodyEnd = matchingToken(tokens, index, '{', '}');
        index = bodyEnd < 0 ? tokens.length : bodyEnd + 1;
      }
      return index;
    }
    if (['!', '~', '+', '-'].includes(token.value)
      || ['typeof', 'void', 'delete', 'await', 'new'].includes(token.value)) {
      index += 1;
      consumePrimary();
      return index;
    }
    if (token.value === '(' || token.value === '[' || token.value === '{') {
      const close = matchingToken(tokens, index, token.value, { '(': ')', '[': ']', '{': '}' }[token.value]);
      index = close < 0 ? tokens.length : close + 1;
      return index;
    }
    index += 1;
    return index;
  };
  consumePrimary();
  while (index < tokens.length) {
    const value = tokens[index].value;
    if (value === '.' || value === '?.') {
      // Private fields are tokenized as '.', '#', and the field name.
      // Consume the whole member just like a normal dot property so an
      // awaited private-field access remains valid after rewriting.
      index += tokens[index + 1]?.value === '#' ? 3 : 2;
      continue;
    }
    if (value === '[' || value === '(') {
      const close = matchingToken(tokens, index, value, value === '[' ? ']' : ')');
      index = close < 0 ? tokens.length : close + 1;
      continue;
    }
    break;
  }
  return tokens[index - 1]?.end || tokens[awaitIndex].end;
}

function matchingSourceBrace(source, openingIndex) {
  let depth = 0;
  let index = openingIndex;
  while (index < source.length) {
    const character = source[index];
    if (character === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
      index = skipComment(source, index);
      continue;
    }
    if (character === "'" || character === '"') {
      index = skipQuoted(source, index, character);
      continue;
    }
    if (character === '`') {
      index = skipTemplate(source, index);
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return index;
    index += 1;
  }
  return -1;
}

function replaceTemplateAwaitExpressions(source) {
  let result = '';
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
      const end = skipComment(source, index);
      result += source.slice(index, end);
      index = end;
      continue;
    }
    if (character === "'" || character === '"') {
      const end = skipQuoted(source, index, character);
      result += source.slice(index, end);
      index = end;
      continue;
    }
    if (character !== '`') {
      result += character;
      index += 1;
      continue;
    }
    result += character;
    index += 1;
    while (index < source.length) {
      if (source[index] === '\\') {
        result += source.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (source[index] === '`') {
        result += source[index++];
        break;
      }
      if (source[index] === '$' && source[index + 1] === '{') {
        const close = matchingSourceBrace(source, index + 1);
        if (close < 0) {
          result += source.slice(index);
          return result;
        }
        result += '${';
        result += replaceAwaitExpressions(source.slice(index + 2, close));
        result += '}';
        index = close + 1;
        continue;
      }
      result += source[index++];
    }
  }
  return result;
}

function replaceAwaitExpressions(source) {
  const templateExpanded = replaceTemplateAwaitExpressions(source);
  const tokens = tokenize(templateExpanded);
  const spans = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value !== 'await') continue;
    const previous = tokens[index - 1]?.value;
    const next = tokens[index + 1]?.value;
    if (previous === '.' || previous === '?.' || previous === 'for' || next === ':') continue;
    spans.push({ start: token.start, end: awaitOperandEnd(tokens, index), token });
  }
  const outerSpans = spans.filter((span) => !spans.some((parent) => (
    parent !== span && parent.start < span.start && parent.end >= span.end
  )));
  return applyReplacements(templateExpanded, outerSpans.map((span) => ({
    start: span.start,
    end: span.end,
    value: `${(() => {
      const previous = tokens[tokens.indexOf(span.token) - 1];
      const hasLineBreak = previous
        && /\r?\n/u.test(templateExpanded.slice(previous.end, span.token.start));
      const continuation = new Set([
        '(', '[', '{', ',', '.', '?.', ':', '?', '=', '=>',
        '!', '~', '+', '-', '*', '/', '%', '&', '|', '^', '&&', '||', '??',
        'return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of',
      ]);
      return hasLineBreak && !continuation.has(previous.value) ? ';' : '';
    })()}(yield ${replaceAwaitExpressions(templateExpanded.slice(span.token.end, span.end))})`,
  })));
}

function applyReplacements(source, replacements) {
  let result = source;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`;
  }
  return result;
}

function transformCandidates(source, candidates, bindingName) {
  const transformableCandidates = candidates.filter((candidate) => !candidate.containsUnsupportedSyntax);
  const outerCandidates = [];
  const active = [];
  for (const candidate of [...transformableCandidates].sort((left, right) => (
    left.start - right.start || right.bodyEnd - left.bodyEnd
  ))) {
    while (active.length && candidate.start >= active.at(-1).bodyEnd) active.pop();
    if (!active.length) outerCandidates.push(candidate);
    active.push(candidate);
  }
  const replacements = outerCandidates.map((candidate) => {
    const bodyStart = candidate.kind === 'arrow-expression'
      ? candidate.expressionStart
      : candidate.bodyStart + 1;
    const bodyEnd = candidate.kind === 'arrow-expression' ? candidate.expressionEnd : candidate.bodyEnd - 1;
    const rawBody = source.slice(bodyStart, bodyEnd);
    const transformedNested = transformAsyncSource(rawBody, bindingName).source;
    const body = replaceAwaitExpressions(transformedNested);
    // Keep the async marker on the generated function. The body still routes
    // through the runtime generator bridge for task tracking, but callers must
    // observe the standard AsyncFunction constructor/toString identity.
    const header = source.slice(candidate.start, candidate.headerEnd);
    if (candidate.kind === 'function' || candidate.kind === 'method') {
      return {
        start: candidate.start,
        end: candidate.bodyEnd,
        value: `${header}{ return ${bindingName}(function* () {${body}}, this, arguments); }`,
      };
    }
    if (candidate.kind === 'arrow-block') {
      return {
        start: candidate.start,
        end: candidate.bodyEnd,
        value: `${header}{ return ${bindingName}(function* () {${body}}, this, arguments); }`,
      };
    }
    return {
      start: candidate.start,
      end: candidate.bodyEnd,
      value: `${header}${bindingName}(function* () { return ${body}; }, this, arguments)`,
    };
  });
  return applyReplacements(source, replacements);
}

export function transformAsyncSource(source, preferredBinding = '__bnhAsync') {
  const text = rewriteForAwaitLoops(String(source));
  const names = new Set(text.match(/\b[$A-Z_a-z][$\w]*\b/gu) || []);
  let bindingName = preferredBinding;
  while (names.has(bindingName)) bindingName = `${preferredBinding}$`;
  const { candidates } = asyncFunctionCandidates(text);
  if (!candidates.some((candidate) => !candidate.containsUnsupportedSyntax)) {
    return { source: text, transformed: false, bindingName };
  }
  return {
    source: transformCandidates(text, candidates, bindingName),
    transformed: true,
    bindingName,
  };
}
