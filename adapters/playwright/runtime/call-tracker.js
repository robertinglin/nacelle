function trackerError(code, message, ErrorClass = Error) {
  const error = new ErrorClass(message);
  error.code = code;
  return error;
}

function freezeCalls(calls) {
  return Object.freeze(calls.map((call) => Object.freeze({
    arguments: Object.freeze([...call.arguments]),
    thisArg: call.thisArg,
  })));
}

function expectedCallMessage(record) {
  return `Expected the ${record.operator} function to be executed ${record.expected} time(s) but was executed ${record.calls.length} time(s).`;
}

export class CallTracker {
  constructor(processObject) {
    this._records = new Map();
    this._process = processObject;
  }

  calls(fn, exact = undefined) {
    if (this._process?._bnhIsExited?.() || this._process?._exitRequested?.()) {
      throw trackerError('ERR_UNAVAILABLE_DURING_EXIT', 'Cannot create a call tracker during process exit');
    }
    if (fn !== undefined && typeof fn !== 'function' && arguments.length > 1) {
      throw trackerError('ERR_INVALID_ARG_TYPE', 'The "fn" argument must be of type function');
    }
    if (exact !== undefined && typeof exact !== 'number') {
      throw trackerError('ERR_INVALID_ARG_TYPE', 'The "exact" argument must be of type number');
    }
    if (exact !== undefined && (!Number.isInteger(exact) || exact < 0)) {
      throw trackerError('ERR_OUT_OF_RANGE', 'The "exact" argument is out of range');
    }
    const target = typeof fn === 'function' ? fn : undefined;
    const record = { target, expected: exact, calls: [], operator: target?.name || 'anonymous' };
    const tracked = function trackedCall(...args) {
      record.calls.push({ arguments: args, thisArg: this });
      return target?.apply(this, args);
    };
    if (target) {
      const keys = Reflect.ownKeys(target);
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        if (key === 'length' || key === 'name' || key === 'prototype'
          || key === 'arguments' || key === 'caller') continue;
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        if (descriptor) Object.defineProperty(tracked, key, descriptor);
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(target, 'length');
      if (lengthDescriptor) Object.defineProperty(tracked, 'length', lengthDescriptor);
      else delete tracked.length;
      const nameDescriptor = Object.getOwnPropertyDescriptor(target, 'name');
      if (nameDescriptor) Object.defineProperty(tracked, 'name', nameDescriptor);
    }
    this._records.set(tracked, record);
    return tracked;
  }

  getCalls(fn) {
    const record = this._records.get(fn);
    if (!record) throw trackerError('ERR_INVALID_ARG_VALUE', 'The function is not tracked');
    return freezeCalls(record.calls);
  }

  reset(fn = undefined) {
    if (fn === undefined) {
      for (const record of this._records.values()) record.calls.length = 0;
      return;
    }
    const record = this._records.get(fn);
    if (!record) throw trackerError('ERR_INVALID_ARG_VALUE', 'The function is not tracked');
    record.calls.length = 0;
  }

  report() {
    return [...this._records.values()]
      .filter((record) => record.expected !== undefined && record.calls.length !== record.expected)
      .map((record) => ({
        actual: record.calls.length,
        expected: record.expected,
        operator: record.operator,
      }));
  }

  verify() {
    const failures = [...this._records.values()]
      .filter((record) => record.expected !== undefined && record.calls.length !== record.expected);
    if (failures.length === 0) return;
    if (failures.length > 1) throw new Error('Functions were not called the expected number of times');
    throw new Error(expectedCallMessage(failures[0]));
  }
}
