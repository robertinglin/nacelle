import { EventEmitter } from './events.js';

export function createDomainModule(processObject) {
  const defineProperty = Object.defineProperty;

  // Save any original capture callback mechanism
  const originalSetUncaughtExceptionCaptureCallback = typeof processObject.setUncaughtExceptionCaptureCallback === 'function'
    ? processObject.setUncaughtExceptionCaptureCallback.bind(processObject)
    : null;
  const originalHasUncaughtExceptionCaptureCallback = typeof processObject.hasUncaughtExceptionCaptureCallback === 'function'
    ? processObject.hasUncaughtExceptionCaptureCallback.bind(processObject)
    : null;

  let captureCallback = null;

  processObject.getUncaughtExceptionCaptureCallback = function() {
    return captureCallback;
  };

  processObject.hasUncaughtExceptionCaptureCallback = function() {
    return !!captureCallback || (originalHasUncaughtExceptionCaptureCallback ? originalHasUncaughtExceptionCaptureCallback() : false);
  };

  processObject.setUncaughtExceptionCaptureCallback = function(fn) {
    captureCallback = fn || null;
    if (originalSetUncaughtExceptionCaptureCallback) {
      // Preserve original behavior if needed, but domain claims ownership.
      // Do not call original to avoid conflicts.
    }
  };

  const stack = [];
  let active = null;

  const _domain = [null];
  defineProperty(processObject, 'domain', {
    __proto__: null,
    enumerable: true,
    get: function() {
      return _domain[0];
    },
    set: function(arg) {
      return _domain[0] = arg;
    },
  });

  // Set initial process.domain
  processObject.domain = null;

  // Add init to EventEmitter if missing
  if (!EventEmitter.prototype.init) {
    EventEmitter.init = function(opts) {
      defineProperty(this, 'domain', {
        __proto__: null,
        configurable: true,
        enumerable: false,
        value: null,
        writable: true,
      });
      if (active && !(this instanceof Domain)) {
        this.domain = active;
      }
      return this;
    };
  } else {
    const originalInit = EventEmitter.init;
    EventEmitter.init = function(opts) {
      defineProperty(this, 'domain', {
        __proto__: null,
        configurable: true,
        enumerable: false,
        value: null,
        writable: true,
      });
      if (active && !(this instanceof Domain)) {
        this.domain = active;
      }
      const ret = originalInit ? originalInit.apply(this, arguments) : this;
      return ret;
    };
  }

  EventEmitter.usingDomains = true;

  class Domain extends EventEmitter {
    constructor() {
      super();
      this.members = [];
      this.on('newListener', () => updateExceptionCapture());
      this.on('removeListener', () => updateExceptionCapture());
    }
  }

  Domain.prototype.members = undefined;

  Domain.prototype.add = function(ee) {
    if (ee.domain === this) return;
    if (ee.domain) ee.domain.remove(ee);
    if (this.domain && (ee instanceof Domain)) {
      for (let d = this.domain; d; d = d.domain) {
        if (ee === d) return;
      }
    }
    defineProperty(ee, 'domain', {
      __proto__: null,
      configurable: true,
      enumerable: false,
      value: this,
      writable: true,
    });
    this.members.push(ee);
  };

  Domain.prototype.remove = function(ee) {
    ee.domain = null;
    const index = this.members.indexOf(ee);
    if (index !== -1) this.members.splice(index, 1);
  };

  Domain.prototype.enter = function() {
    active = processObject.domain = this;
    stack.push(this);
    updateExceptionCapture();
  };

  Domain.prototype.exit = function() {
    const index = stack.indexOf(this);
    if (index === -1) return;
    stack.splice(index);
    active = stack.length > 0 ? stack[stack.length - 1] : null;
    processObject.domain = active;
    updateExceptionCapture();
  };

  Domain.prototype.run = function(fn) {
    this.enter();
    const ret = fn.apply(this, Array.from(arguments).slice(1));
    this.exit();
    return ret;
  };

  Domain.prototype.bind = function(cb) {
    const self = this;
    function runBound() {
      return bound(this, self, cb, arguments);
    }
    defineProperty(runBound, 'domain', {
      __proto__: null,
      configurable: true,
      enumerable: false,
      value: this,
      writable: true,
    });
    return runBound;
  };

  Domain.prototype.intercept = function(cb) {
    const self = this;
    return function runIntercepted() {
      return intercepted(this, self, cb, arguments);
    };
  };

  function bound(_this, self, cb, fnargs) {
    self.enter();
    const ret = cb.apply(_this, Array.from(fnargs));
    self.exit();
    return ret;
  }

  function intercepted(_this, self, cb, fnargs) {
    if (fnargs[0] && fnargs[0] instanceof Error) {
      const er = fnargs[0];
      er.domainBound = cb;
      er.domainThrown = false;
      defineProperty(er, 'domain', {
        __proto__: null,
        configurable: true,
        enumerable: false,
        value: self,
        writable: true,
      });
      self.emit('error', er);
      return;
    }
    self.enter();
    const ret = cb.apply(_this, Array.from(fnargs).slice(1));
    self.exit();
    return ret;
  }

  Domain.prototype._errorHandler = function(er) {
    let caught = false;
    if ((typeof er === 'object' && er !== null) || typeof er === 'function') {
      defineProperty(er, 'domain', {
        __proto__: null,
        configurable: true,
        enumerable: false,
        value: this,
        writable: true,
      });
      er.domainThrown = true;
    }
    while (active === this) {
      this.exit();
    }
    if (stack.length === 0) {
      if (this.listenerCount('error') > 0) {
        try {
          caught = this.emit('error', er);
        } finally {
          updateExceptionCapture();
        }
      }
    } else {
      try {
        caught = this.emit('error', er);
      } catch (er2) {
        updateExceptionCapture();
        if (stack.length) {
          active = processObject.domain = stack[stack.length - 1];
          caught = active._errorHandler(er2);
        } else {
          throw er2;
        }
      }
    }
    stack.length = 0;
    active = null;
    processObject.domain = null;
    updateExceptionCapture();
    return caught;
  };

  function updateExceptionCapture() {
    const hasErrorListener = (d) => d && typeof d.listenerCount === 'function' && d.listenerCount('error') > 0;
    // Check active domain and any domain in stack that has an error listener
    let shouldCapture = false;
    if (stack.length > 0) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (hasErrorListener(stack[i])) {
          shouldCapture = true;
          break;
        }
      }
    }
    if (shouldCapture) {
      const domainWithHandler = stack.slice().reverse().find(hasErrorListener);
      captureCallback = (err) => domainWithHandler ? domainWithHandler._errorHandler(err) : false;
      processObject.setUncaughtExceptionCaptureCallback(captureCallback);
    } else {
      captureCallback = null;
      processObject.setUncaughtExceptionCaptureCallback(null);
    }
  }

  const exports = {
    Domain,
    create: function() { return new Domain(); },
    createDomain: function() { return new Domain(); },
    active,
    get _stack() { return stack; },
    set _stack(value) { /* ignore */ },
  };

  // Initialize capture
  updateExceptionCapture();

  return exports;
}
