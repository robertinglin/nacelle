function formatError(error) {
  return error?.stack || String(error);
}

function normalizeOptions(options) {
  return options && typeof options === 'object' ? options : {};
}

function splitDefinition(name, options, callback) {
  if (typeof name === 'function') return { name: '(anonymous)', options: {}, callback: name };
  if (typeof options === 'function') return { name, options: {}, callback: options };
  return { name, options: normalizeOptions(options), callback };
}

/** Run the useful node:test surface inside the browser process lifecycle. */
export function createNodeTest({ scope, processObject, stdout, stderr, trackTask }) {
  const schedule = typeof scope.queueMicrotask === 'function'
    ? scope.queueMicrotask.bind(scope)
    : (callback) => scope.setTimeout(callback, 0);
  const root = {
    parent: null,
    before: [],
    after: [],
    beforeEach: [],
    afterEach: [],
    children: [],
    started: false,
    beforeReady: null,
    completion: null,
  };
  const suiteStack = [root];

  function reportFailure(error) {
    processObject.exitCode ||= 1;
    const detail = formatError(error);
    stderr(`${detail}\n`);
    return detail;
  }

  async function runHooks(hooks, context) {
    for (const hook of hooks) await hook(context);
  }

  function startSuite(suite) {
    if (suite.started) return suite;
    suite.started = true;
    const release = trackTask();
    suite.beforeReady = (async () => {
      try {
        await Promise.resolve();
        await runHooks(suite.before, { name: suite.name, signal: suite.signal });
        return null;
      } catch (error) {
        return error;
      }
    })();
    suite.completion = (async () => {
      const beforeError = await suite.beforeReady;
      await Promise.all(suite.children);
      let afterError = null;
      try {
        await runHooks([...suite.after].reverse(), { name: suite.name, signal: suite.signal });
      } catch (error) {
        afterError = error;
      }
      if (beforeError) reportFailure(beforeError);
      if (afterError) reportFailure(afterError);
    })().finally(() => release?.());
    return suite;
  }

  function hook(name, callback) {
    if (typeof callback !== 'function') throw new TypeError(`${name} callback must be a function`);
    suiteStack.at(-1)[name].push(callback);
  }

  function hookChain(suite, name) {
    const chain = [];
    for (let current = suite; current; current = current.parent) chain.push(...current[name]);
    return name === 'afterEach' ? chain : chain.reverse();
  }

  function createSuite(name, options, callback, parent) {
    const suite = {
      name: String(name ?? '(anonymous suite)'),
      parent,
      signal: options.signal,
      before: [],
      after: [],
      beforeEach: [],
      afterEach: [],
      children: [],
      started: false,
      beforeReady: null,
      completion: null,
    };
    parent.children.push(startSuite(suite).completion);
    if (!options.skip && !options.todo && typeof callback === 'function') {
      suiteStack.push(suite);
      try {
        callback();
      } finally {
        suiteStack.pop();
      }
    }
    return suite.completion;
  }

  function register(name, options, callback, parent = suiteStack.at(-1)) {
    const task = splitDefinition(name, options, callback);
    const label = String(task.name ?? '(unnamed test)');
    const testOptions = task.options;
    const result = new Promise((resolve) => {
      const node = { children: [] };
      const run = async () => {
        const release = trackTask();
        try {
          const suiteState = startSuite(parent);
          const beforeError = await suiteState.beforeReady;
          if (beforeError) {
            const detail = reportFailure(beforeError);
            stderr(`not ok - ${label}: ${detail}\n`);
            return { name: label, status: 'fail', skipped: false, todo: false };
          }
          if (testOptions.skip || testOptions.todo) {
            const status = testOptions.skip ? 'skip' : 'pass';
            const marker = testOptions.skip ? ' # SKIP' : ' # TODO';
            const reason = testOptions.skip === true || testOptions.todo === true
              ? ''
              : `: ${String(testOptions.skip ?? testOptions.todo)}`;
            stdout(`ok - ${label}${marker}${reason}\n`);
            return { name: label, status, skipped: status === 'skip', todo: Boolean(testOptions.todo) };
          }

          const context = {
            name: label,
            signal: testOptions.signal,
            test: (childName, childOptions, childCallback) => {
              const child = register(childName, childOptions, childCallback, parent);
              node.children.push(child);
              return child;
            },
          };
          let failure = null;
          try {
            await runHooks(hookChain(parent, 'beforeEach'), context);
            if (typeof task.callback === 'function') await task.callback(context);
          } catch (error) {
            failure = error;
          } finally {
            try {
              await runHooks(hookChain(parent, 'afterEach'), context);
            } catch (error) {
              failure ||= error;
            }
          }
          const childResults = await Promise.all(node.children);
          if (!failure && childResults.some((child) => child.status === 'fail')) {
            failure = new Error(`subtest of '${label}' failed`);
          }
          if (failure) {
            const detail = reportFailure(failure);
            stderr(`not ok - ${label}: ${detail}\n`);
            return { name: label, status: 'fail', skipped: false, todo: false };
          }
          stdout(`ok - ${label}\n`);
          return { name: label, status: 'pass', skipped: false, todo: false };
        } finally {
          release?.();
        }
      };
      schedule(() => run().then(resolve, (error) => resolve({
        name: label,
        status: 'fail',
        skipped: false,
        todo: false,
        error,
      })));
    });
    parent.children.push(result);
    return result;
  }

  function test(name, options, callback) {
    return register(name, options, callback);
  }

  function describe(name, options, callback) {
    const definition = splitDefinition(name, options, callback);
    return createSuite(definition.name, definition.options, definition.callback, suiteStack.at(-1));
  }

  test.test = test;
  test.it = test;
  test.describe = describe;
  test.suite = describe;
  test.only = test;
  test.skip = (name, options, callback) => {
    const definition = splitDefinition(name, options, callback);
    return register(definition.name, { ...definition.options, skip: true }, definition.callback);
  };
  test.todo = (name, options, callback) => {
    const definition = splitDefinition(name, options, callback);
    return register(definition.name, { ...definition.options, todo: true }, definition.callback);
  };
  test.before = (callback) => hook('before', callback);
  test.after = (callback) => hook('after', callback);
  test.beforeEach = (callback) => hook('beforeEach', callback);
  test.afterEach = (callback) => hook('afterEach', callback);
  test.run = () => ({ concurrency: 1 });

  describe.skip = (name, options, callback) => describe(name, { ...normalizeOptions(options), skip: true }, callback);
  describe.todo = (name, options, callback) => describe(name, { ...normalizeOptions(options), todo: true }, callback);
  describe.only = describe;
  describe.before = test.before;
  describe.after = test.after;
  describe.beforeEach = test.beforeEach;
  describe.afterEach = test.afterEach;
  return test;
}
