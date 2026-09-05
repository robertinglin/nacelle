import assert from 'node:assert/strict';
import test from 'node:test';
import { transformAsyncSource } from '../../../../src/runtime/async-transform.js';

function runGenerator(generatorFactory) {
  const iterator = generatorFactory();
  return new Promise((resolve, reject) => {
    const step = (method, value) => {
      let result;
      try {
        result = iterator[method](value);
      } catch (error) {
        reject(error);
        return;
      }
      if (result.done) {
        resolve(result.value);
        return;
      }
      Promise.resolve(result.value).then(
        (nextValue) => step('next', nextValue),
        (error) => step('throw', error),
      );
    };
    step('next');
  });
}

test('async arrows in instance and static class fields preserve parameters and this', async () => {
  const source = `
    class Task {
      value = 3;
      run = async (input) => { return this.value + await Promise.resolve(input); };
      static value = 5;
      static run = async (input) => this.value + await Promise.resolve(input);
    }
  `;
  const transformed = transformAsyncSource(source);
  assert.equal(transformed.transformed, true);
  const Task = new Function(transformed.bindingName, `${transformed.source}; return Task;`)(
    (generator, receiver, args) => runGenerator(() => generator.apply(receiver, args)),
  );
  assert.equal(await new Task().run(7), 10);
  assert.equal(await Task.run(7), 12);
});

test('async arrows still read their enclosing function arguments', async () => {
  const source = `
    function task(value) {
      return async () => { return arguments[0] + await Promise.resolve(2); };
    }
  `;
  const transformed = transformAsyncSource(source);
  const task = new Function(transformed.bindingName, `${transformed.source}; return task;`)(
    (generator, receiver, args) => runGenerator(() => generator.apply(receiver, args)),
  );
  assert.equal(await task(8)(), 10);
});

test('keeps awaited function expression calls syntactically valid', async () => {
  const source = `
    async function invoke() {
      return await function ({ value }) {
        return value;
      }({ value: 7 });
    }
    invoke();
  `;
  const transformed = transformAsyncSource(source).source;
  const invoke = new Function('__bnhAsync', `${transformed}; return invoke;`)(
    (generatorFactory) => runGenerator(generatorFactory),
  );

  assert.equal(await invoke(), 7);
});

test('keeps awaited optional calls syntactically valid', async () => {
  const source = `
    async function invoke(callback, value) {
      return await callback?.(value);
    }
    invoke((input) => input, 9);
  `;
  const transformed = transformAsyncSource(source).source;
  const invoke = new Function('__bnhAsync', `${transformed}; return invoke;`)(
    (generatorFactory) => runGenerator(generatorFactory),
  );

  assert.equal(await invoke((input) => input, 9), 9);
});

test('keeps async function boundaries intact across nested template literals', async () => {
  const source = `
    async function invoke(value) {
      const message = \`${'${value ? `nested ${value}` : "fallback"}'}\`;
      return await Promise.resolve(message);
    }
    invoke('value');
  `;
  const transformed = transformAsyncSource(source).source;
  const invoke = new Function('__bnhAsync', `${transformed}; return invoke;`)(
    (generatorFactory) => runGenerator(generatorFactory),
  );

  assert.equal(await invoke('value'), 'nested value');
});

test('preserves native async identity when no await lowering is needed', () => {
  const source = 'const invoke = async () => 7;';
  const transformed = transformAsyncSource(source).source;
  const invoke = new Function(`${transformed}; return invoke;`)();

  assert.equal(transformed, source);
  assert.equal(invoke.constructor.name, 'AsyncFunction');
  assert.equal(Object.prototype.toString.call(invoke), '[object AsyncFunction]');
});

test('lowers for-await inside nested async functions in strict modules', async () => {
  const source = `
    'use strict';
    async function invoke(values) {
      const collect = async () => {
        const chunks = [];
        for await (const value of values) {
          chunks.push(value);
          break;
        }
        return chunks;
      };
      return await collect();
    }
  `;
  const transformed = transformAsyncSource(source);
  const invoke = new Function(transformed.bindingName, `${transformed.source}; return invoke;`)(runGenerator);
  let closed = false;
  async function* values() {
    try { yield 7; yield 9; }
    finally { closed = true; }
  }
  assert.deepEqual(await invoke(values()), [7]);
  assert.equal(closed, true);
});
