import { rewriteDynamicImports } from './dynamic-imports.js';
import { transformAsyncSource, transformEvalLiterals } from './async-transform.js';

function hasTopLevelCommonJsProcessBinding(source) {
  const masked = String(source)
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '');
  return /(?:^|[;\n])\s*(?:const|let|var|function|class)\s+process\b/m.test(masked)
    || /(?:^|[;\n])\s*(?:const|let|var)\s*[({[][^;\n}]*\bprocess\b/m.test(masked);
}

export function createCommonJsSourcePreparer({ maxCharacters = 16 * 1024 * 1024 } = {}) {
  const cache = new Map();
  let retainedCharacters = 0;
  return function prepare(source) {
    const cached = cache.get(source);
    if (cached) return cached;
    const async = transformAsyncSource(rewriteDynamicImports(source, '__bnhImport'));
    const evaluated = transformEvalLiterals(async.source, async.bindingName);
    const text = (evaluated.transformed ? evaluated.source : async.source)
      .replace(/^#![^\r\n]*(?:\r\n|\n|$)/, (shebang) => shebang.endsWith('\n') ? '\n' : '');
    const prepared = Object.freeze({
      source: text,
      bindingName: async.bindingName,
      bindAsync: async.transformed || evaluated.transformed,
      hasProcessBinding: hasTopLevelCommonJsProcessBinding(text),
    });
    // Cache source preparation only: exports, functions, and process bindings
    // must be created separately for each execution. Count both retained texts.
    const characters = source.length + (text === source ? 0 : text.length);
    if (characters <= maxCharacters) {
      while (cache.size && retainedCharacters + characters > maxCharacters) {
        const [oldSource, oldPrepared] = cache.entries().next().value;
        retainedCharacters -= oldSource.length
          + (oldPrepared.source === oldSource ? 0 : oldPrepared.source.length);
        cache.delete(oldSource);
      }
      cache.set(source, prepared);
      retainedCharacters += characters;
    }
    return prepared;
  };
}
