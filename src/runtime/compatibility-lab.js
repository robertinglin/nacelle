function stable(value) {
  if (value instanceof Uint8Array) return `bytes:${Array.from(value).join(',')}`;
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

/** Differential corpus runner used by parity demos and release reports. */
export function createCompatibilityLab({ cases = [], runner, oracle } = {}) {
  if (typeof runner !== 'function' || typeof oracle !== 'function') throw new TypeError('compatibility lab runner and oracle functions are required');
  return {
    async run(inputCases = cases) {
      const results = [];
      for (const item of inputCases) {
        const name = String(item.name || item.id || results.length);
        try {
          const [actual, expected] = await Promise.all([runner(item.input, item), oracle(item.input, item)]);
          const passed = JSON.stringify(stable(actual)) === JSON.stringify(stable(expected));
          results.push({ name, status: passed ? 'passed' : 'mismatch', actual, expected });
        } catch (error) {
          results.push({ name, status: error?.code?.startsWith('ERR_UNSUPPORTED') ? 'unsupported' : 'failed', error: { code: error.code, message: error.message } });
        }
      }
      const metrics = {
        total: results.length,
        passed: results.filter((result) => result.status === 'passed').length,
        mismatched: results.filter((result) => result.status === 'mismatch').length,
        failed: results.filter((result) => result.status === 'failed').length,
        unsupported: results.filter((result) => result.status === 'unsupported').length,
      };
      return Object.freeze({ results, metrics });
    },
  };
}
