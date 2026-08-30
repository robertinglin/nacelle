const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');
const MAX_TRACING_COUNT = 10;

function receivedValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'an instance of Array';
  if (typeof value === 'object') return `an instance of ${value.constructor?.name || 'Object'}`;
  return `type ${typeof value} (${String(value)})`;
}

function invalidArgumentType(name, expected, value) {
  const error = new TypeError(
    `The "${name}" argument must be of type ${expected}. Received ${receivedValue(value)}`,
  );
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function validateObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidArgumentType(name, 'object', value);
  }
}

function validateStringArray(value, name) {
  if (!Array.isArray(value)) throw invalidArgumentType(name, 'Array', value);
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== 'string') {
      throw invalidArgumentType(`${name}[${index}]`, 'string', value[index]);
    }
  }
}

export function traceEventsUnavailableError() {
  const error = new Error('Trace events are unavailable');
  error.code = 'ERR_TRACE_EVENTS_UNAVAILABLE';
  return error;
}

function categoryRequiredError() {
  const error = new TypeError('At least one category is required');
  error.code = 'ERR_TRACE_EVENTS_CATEGORY_REQUIRED';
  return error;
}

function commandLineCategories(process) {
  const args = process?.execArgv || [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = String(args[index]);
    if (argument === '--trace-event-categories') return String(args[index + 1] || '').split(',').filter(Boolean);
    if (argument.startsWith('--trace-event-categories=')) {
      return argument.slice('--trace-event-categories='.length).split(',').filter(Boolean);
    }
  }
  return [];
}

export function createTraceEventsModule(binding, { process, unavailable = false } = {}) {
  if (unavailable || !binding || typeof binding.CategorySet !== 'function') {
    return Object.freeze({
      createTracing() { throw traceEventsUnavailableError(); },
      getEnabledCategories() { throw traceEventsUnavailableError(); },
    });
  }

  const initialCategories = commandLineCategories(process);
  if (initialCategories.length > 0) {
    const commandLineTracing = new binding.CategorySet(initialCategories);
    commandLineTracing.enable();
  }

  const enabledTracingObjects = new Set();

  class Tracing {
    #handle;
    #categories;
    #enabled = false;

    constructor(categories) {
      this.#handle = new binding.CategorySet(categories);
      this.#categories = categories;
    }

    enable() {
      if (!this.#enabled) {
        this.#enabled = true;
        this.#handle.enable();
        enabledTracingObjects.add(this);
        if (enabledTracingObjects.size > MAX_TRACING_COUNT) {
          process?.emitWarning?.(
            'Possible trace_events memory leak detected. There are more than ' +
            `${MAX_TRACING_COUNT} enabled Tracing objects.`,
          );
        }
      }
    }

    disable() {
      if (this.#enabled) {
        this.#enabled = false;
        this.#handle.disable();
        enabledTracingObjects.delete(this);
      }
    }

    get enabled() {
      return this.#enabled;
    }

    get categories() {
      return this.#categories.join(',');
    }

    [INSPECT_CUSTOM](depth, options, inspect) {
      if (typeof depth === 'number' && depth < 0) return this;
      if (typeof depth === 'number' && depth < 1) return 'Tracing {}';
      const inspectString = typeof inspect === 'function'
        ? inspect(this.categories, options)
        : `'${this.categories.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
      return `Tracing { enabled: ${this.enabled}, categories: ${inspectString} }`;
    }
  }

  function createTracing(options) {
    validateObject(options, 'options');
    validateStringArray(options.categories, 'options.categories');
    if (options.categories.length <= 0) throw categoryRequiredError();
    return new Tracing(options.categories);
  }

  return Object.freeze({
    createTracing,
    getEnabledCategories: binding.getEnabledCategories,
  });
}
