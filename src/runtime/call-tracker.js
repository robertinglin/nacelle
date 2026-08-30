function trackerError(code, message, ErrorClass = Error) {
  const error = new ErrorClass(message);
  error.code = code;
  return error;
}

function received(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return `type string ('${value}')`;
  if (typeof value === 'boolean') return `type boolean (${value})`;
  if (typeof value === 'number') return String(value);
  return `an instance of ${value?.constructor?.name || typeof value}`;
}

function getTrackedFunction(tracker, tracked) {
  const record = tracker._trackedFunctions.get(tracked);
  if (!record) {
    throw trackerError(
      'ERR_INVALID_ARG_VALUE',
      `The argument 'tracked' is not a tracked function. Received ${received(tracked)}`,
      TypeError,
    );
  }
  return record;
}

export class CallTracker {
  constructor(processObject, AssertionError = Error) {
    this._records = new Set();
    this._trackedFunctions = new WeakMap();
    this._process = processObject;
    this._AssertionError = AssertionError;
  }

  reset(tracked) {
    if (tracked === undefined) {
      for (const record of this._records) record.calls = [];
      return;
    }
    getTrackedFunction(this, tracked).calls = [];
  }

  getCalls(tracked) {
    const record = getTrackedFunction(this, tracked);
    return Object.freeze([...record.calls]);
  }

  calls(fn, expected = 1) {
    if (this._process?._bnhIsExited?.() || this._process?._exitRequested?.()) {
      throw trackerError('ERR_UNAVAILABLE_DURING_EXIT', 'Cannot call function in process exit handler');
    }
    if (typeof fn === 'number') {
      expected = fn;
      fn = Function.prototype;
    } else if (fn === undefined) {
      fn = Function.prototype;
    }
    if (typeof expected !== 'number') {
      throw trackerError(
        'ERR_INVALID_ARG_TYPE',
        `The "expected" argument must be of type number. Received ${received(expected)}`,
        TypeError,
      );
    }
    if (!Number.isInteger(expected)) {
      throw trackerError(
        'ERR_OUT_OF_RANGE',
        `The value of "expected" is out of range. It must be an integer. Received ${expected}`,
        RangeError,
      );
    }
    if (expected < 1 || expected > 0xFFFF_FFFF) {
      throw trackerError(
        'ERR_OUT_OF_RANGE',
        `The value of "expected" is out of range. It must be >= 1 && <= 4294967295. Received ${expected}`,
        RangeError,
      );
    }
    const record = {
      target: fn,
      expected,
      calls: [],
      operator: fn.name || 'calls',
      stack: new Error(),
    };
    const tracked = new Proxy(fn, {
      apply(target, thisArg, args) {
        record.calls.push(Object.freeze({
          thisArg,
          arguments: Object.freeze([...args]),
        }));
        return Reflect.apply(target, thisArg, args);
      },
    });
    this._records.add(record);
    this._trackedFunctions.set(tracked, record);
    return tracked;
  }

  report() {
    return [...this._records].flatMap((record) => {
      if (record.calls.length === record.expected) return [];
      return [{
        message: `Expected the ${record.operator} function to be executed ${record.expected} time(s) but was executed ${record.calls.length} time(s).`,
        actual: record.calls.length,
        expected: record.expected,
        operator: record.operator,
        stack: record.stack,
      }];
    });
  }

  verify() {
    const failures = this.report();
    if (failures.length === 0) return;
    const message = failures.length === 1
      ? failures[0].message
      : 'Functions were not called the expected number of times';
    throw new this._AssertionError({ message, details: failures });
  }
}
