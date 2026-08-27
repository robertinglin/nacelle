function trackerError(code, message, ErrorClass = Error) {
  const error = new ErrorClass(message);
  error.code = code;
  return error;
}

export class CallTracker {
  constructor(processObject, AssertionError = Error) {
    this._records = new Set();
    this._trackedFunctions = new WeakMap();
    this._process = processObject;
    this._AssertionError = AssertionError;
  }

  _getTrackedFunction(tracked) {
    const record = typeof tracked === 'function' ? this._trackedFunctions.get(tracked) : undefined;
    if (!record) throw trackerError('ERR_INVALID_ARG_VALUE', 'The "tracked" argument is not a tracked function');
    return record;
  }

  reset(tracked = undefined) {
    if (tracked === undefined) {
      for (const record of this._records) record.calls = [];
      return;
    }
    this._getTrackedFunction(tracked).calls = [];
  }

  getCalls(tracked) {
    const record = this._getTrackedFunction(tracked);
    return Object.freeze([...record.calls]);
  }

  calls(fn, expected = 1) {
    if (this._process?._bnhIsExited?.() || this._process?._exitRequested?.()) {
      throw trackerError('ERR_UNAVAILABLE_DURING_EXIT', 'Cannot create a call tracker during process exit');
    }
    if (typeof fn === 'number') {
      expected = fn;
      fn = Function.prototype;
    } else if (fn === undefined) {
      fn = Function.prototype;
    } else if (typeof fn !== 'function') {
      throw trackerError('ERR_INVALID_ARG_TYPE', 'The "fn" argument must be of type function');
    }
    if (typeof expected !== 'number') {
      throw trackerError('ERR_INVALID_ARG_TYPE', 'The "expected" argument must be of type number');
    }
    if (!Number.isInteger(expected) || expected < 0 || expected > 0xFFFF_FFFF) {
      throw trackerError('ERR_OUT_OF_RANGE', 'The "expected" argument is out of range');
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
