import { decodeStringLiteral, encodeStringLiteral } from './async-transform.js';

const expressionPrefixes = new Set([
  '(', '[', '{', ',', ';', ':', '=', '=>', '!', '?', '&&', '||', '??',
  '+', '-', '*', '%', '&', '|', '^', '~', '<', '>', 'return', 'throw',
  'case', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of', 'yield', 'await',
]);
const controlHeads = new Set(['if', 'while', 'for', 'with', 'switch', 'catch']);
const identifierPart = character => character !== undefined && /[$\w\u0080-\uffff]/u.test(character);

/** Route import expressions without editing strings, comments or regex bodies. */
export function rewriteDynamicImports(source, bindingName, depth = 0) {
  const text = String(source);
  if (!text.includes('import') || depth > 64) return text;
  let index = 0;
  const quoted = quote => {
    const start = index++;
    while (index < text.length) {
      const character = text[index++];
      if (character === '\\') index += 1;
      else if (character === quote) break;
    }
    return text.slice(start, index);
  };
  const commentEnd = start => {
    if (text[start + 1] === '/') {
      let end = start + 2;
      while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end += 1;
      return end;
    }
    const end = text.indexOf('*/', start + 2);
    return end < 0 ? text.length : end + 2;
  };
  const skipTrivia = start => {
    let end = start;
    for (;;) {
      while (/\s/u.test(text[end] || '')) end += 1;
      if (text[end] !== '/' || !['/', '*'].includes(text[end + 1])) return end;
      end = commentEnd(end);
    }
  };
  const regularExpression = () => {
    const start = index++;
    let characterClass = false;
    while (index < text.length) {
      const character = text[index++];
      if (character === '\\') index += 1;
      else if (character === '[') characterClass = true;
      else if (character === ']') characterClass = false;
      else if (character === '/' && !characterClass) {
        while (identifierPart(text[index])) index += 1;
        break;
      }
    }
    return text.slice(start, index);
  };
  const template = () => {
    let result = '`'; index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '\\') { result += text.slice(index, index + 2); index += 2; }
      else if (character === '`') { result += character; index += 1; break; }
      else if (character === '$' && text[index + 1] === '{') {
        result += '${'; index += 2; result += code(true);
      } else { result += character; index += 1; }
    }
    return result;
  };
  const isMethodDefinition = open => {
    // A method named import is a property definition, not an import expression.
    const saved = index;
    index = open + 1;
    let balance = 1;
    while (index < text.length && balance) {
      const character = text[index];
      if (character === "'" || character === '"') quoted(character);
      else if (character === '`') template();
      else if (character === '/' && ['/', '*'].includes(text[index + 1])) index = commentEnd(index);
      else {
        index += 1;
        if (character === '(') balance += 1;
        else if (character === ')') balance -= 1;
      }
    }
    const result = balance === 0 && text[skipTrivia(index)] === '{';
    index = saved;
    return result;
  };
  const code = (stopAtBrace = false) => {
    let result = '';
    let braces = stopAtBrace ? 1 : 0;
    let previous = '';
    let expressionStart = true;
    const parentheses = [];
    const braceKinds = [];
    while (index < text.length) {
      const character = text[index];
      const next = text[index + 1];
      if (/\s/u.test(character)) { result += character; index += 1; continue; }
      if (character === '/' && (next === '/' || next === '*')) {
        const end = commentEnd(index); result += text.slice(index, end); index = end; continue;
      }
      if (character === "'" || character === '"') {
        result += quoted(character); previous = '<literal>'; expressionStart = false; continue;
      }
      if (character === '`') { result += template(); previous = '<literal>'; expressionStart = false; continue; }
      if (character === '/' && expressionStart) {
        result += regularExpression(); previous = '<literal>'; expressionStart = false; continue;
      }
      if (/[$A-Z_a-z\u0080-\uffff]/u.test(character)) {
        const start = index++;
        while (identifierPart(text[index])) index += 1;
        const word = text.slice(start, index);
        const open = skipTrivia(index);
        const property = previous === '.' || previous === '?.';
        if (word === 'eval' && !property && text[open] === '(') {
          const literalStart = skipTrivia(open + 1);
          if (text[literalStart] === "'" || text[literalStart] === '"') {
            const saved = index; index = literalStart;
            const literal = quoted(text[literalStart]);
            const end = index;
            const decoded = decodeStringLiteral(literal.slice(1, -1));
            if (text[skipTrivia(end)] === ')' && decoded !== null) {
              const rewritten = rewriteDynamicImports(decoded, bindingName, depth + 1);
              result += text.slice(start, literalStart)
                + literal[0] + encodeStringLiteral(rewritten, literal[0]) + literal.at(-1);
              previous = '<literal>'; expressionStart = false; continue;
            }
            index = saved;
          }
        }
        const methodPosition = ['{', ',', ';', 'static', 'get', 'set', 'async', '*'].includes(previous);
        const importExpression = word === 'import' && !property && text[open] === '('
          && !(methodPosition && isMethodDefinition(open));
        result += importExpression ? bindingName : word;
        previous = word; expressionStart = expressionPrefixes.has(word); continue;
      }
      if (/\d/u.test(character)) {
        const start = index++;
        while (/[$\w.]/u.test(text[index] || '')) index += 1;
        result += text.slice(start, index); previous = '<literal>'; expressionStart = false; continue;
      }
      const token = text.slice(index, index + 4).match(/^(?:=>|===|!==|\?\.|\?\?|&&|\|\||\*\*|\+\+|--|<<|>>|\.{3}|.)/su)[0];
      if (token === '(') parentheses.push(controlHeads.has(previous));
      if (token === ')') expressionStart = parentheses.pop() === true;
      else expressionStart = expressionPrefixes.has(token) || token === '/';
      result += token; index += token.length;
      if (token === '{') {
        braces += 1;
        braceKinds.push(!['=', '(', '[', ',', ':', 'return', 'yield', '?'].includes(previous));
      } else if (token === '}') {
        braces -= 1;
        expressionStart = braceKinds.pop() === true;
        if (stopAtBrace && braces === 0) return result;
      }
      previous = token;
    }
    return result;
  };
  return code();
}
