function asText(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return typeof value.toString === 'function' ? value.toString() : String(value);
}

function callbackResult(callback, error, value) {
  if (typeof callback !== 'function') return;
  queueMicrotask(() => callback(error, value));
}

function writeControl(stream, sequence, callback) {
  let result = true;
  if (stream && typeof stream.write === 'function') result = stream.write(sequence);
  callbackResult(callback, null);
  return result;
}

/**
 * Browser-native implementation of the stream-facing readline contract.
 * Interactive terminal editing is intentionally left to the host terminal;
 * Node libraries generally need the line events and cursor helpers instead.
 */
export function createBrowserReadline({ EventEmitter } = {}) {
  if (typeof EventEmitter !== 'function') throw new TypeError('EventEmitter is required');

  class Interface extends EventEmitter {
    constructor(input, output, completer, terminal) {
      let options = input;
      if (!options || typeof options !== 'object' || !Object.hasOwn(options, 'input')) {
        options = { input, output, completer, terminal };
      }
      super();
      if (!options.input || typeof options.input.on !== 'function') {
        throw new TypeError('input must be a readable stream');
      }
      this.input = options.input;
      this.output = options.output;
      this.completer = options.completer;
      this.terminal = options.terminal ?? Boolean(options.output?.isTTY);
      this.historySize = Number.isInteger(options.historySize) ? Math.max(0, options.historySize) : 30;
      this.history = Array.isArray(options.history) ? [...options.history] : [];
      this.removeHistoryDuplicates = Boolean(options.removeHistoryDuplicates);
      this.crlfDelay = Math.max(100, Number(options.crlfDelay) || 100);
      this.escapeCode = options.escapeCode || '\u001b';
      this.tabSize = Number.isInteger(options.tabSize) ? options.tabSize : tabSizeDefault;
      this.line = '';
      this.cursor = 0;
      this._prompt = options.prompt || '> ';
      this._lineBuffer = '';
      this._pendingCarriageReturn = false;
      this._closed = false;
      this._lineQueue = [];
      this._lineWaiters = [];
      this._inputListeners = {
        data: (chunk) => this._consume(asText(chunk)),
        end: () => this.close(),
        close: () => this.close(),
        error: (error) => this.emit('error', error),
      };
      this.input.on('data', this._inputListeners.data);
      this.input.once?.('end', this._inputListeners.end);
      this.input.once?.('close', this._inputListeners.close);
      this.input.once?.('error', this._inputListeners.error);
      this.input.resume?.();
      options.signal?.addEventListener?.('abort', () => this.close(), { once: true });
    }

    _consume(value) {
      for (const character of value) {
        if (this._pendingCarriageReturn) {
          this._pendingCarriageReturn = false;
          if (character === '\n') continue;
        }
        if (character === '\r') {
          this._pendingCarriageReturn = true;
          this._emitLine();
        } else if (character === '\n') {
          this._emitLine();
        } else {
          this._lineBuffer += character;
          this.line = this._lineBuffer;
          this.cursor = this.line.length;
        }
      }
    }

    _emitLine() {
      const line = this._lineBuffer;
      this._lineBuffer = '';
      this.line = '';
      this.cursor = 0;
      if (line && this.historySize > 0) {
        if (!this.removeHistoryDuplicates || this.history[0] !== line) {
          this.history.unshift(line);
          if (this.history.length > this.historySize) this.history.length = this.historySize;
        }
      }
      const waiter = this._lineWaiters.shift();
      if (waiter) waiter.resolve(line);
      else this._lineQueue.push(line);
      this.emit('line', line);
    }

    _waitForLine() {
      if (this._lineQueue.length) return Promise.resolve(this._lineQueue.shift());
      if (this._closed) return Promise.resolve(undefined);
      return new Promise((resolve, reject) => this._lineWaiters.push({ resolve, reject }));
    }

    setPrompt(prompt) {
      this._prompt = String(prompt);
    }

    getPrompt() {
      return this._prompt;
    }

    prompt(preserveCursor = false) {
      if (!preserveCursor) this.cursor = this.line.length;
      if (this.output?.write) this.output.write(this._prompt);
    }

    question(query, options, callback) {
      let actualCallback = callback;
      if (typeof options === 'function') {
        actualCallback = options;
      }
      const answer = this._waitForLine();
      if (query !== undefined && this.output?.write) this.output.write(String(query));
      if (typeof actualCallback === 'function') {
        answer.then((value) => actualCallback(null, value));
        return undefined;
      }
      return answer;
    }

    pause() {
      this.input.pause?.();
      return this;
    }

    resume() {
      this.input.resume?.();
      return this;
    }

    close() {
      if (this._closed) return this;
      if (this._lineBuffer) this._emitLine();
      this._closed = true;
      this.input.removeListener?.('data', this._inputListeners.data);
      this.input.removeListener?.('end', this._inputListeners.end);
      this.input.removeListener?.('close', this._inputListeners.close);
      this.input.removeListener?.('error', this._inputListeners.error);
      for (const waiter of this._lineWaiters.splice(0)) waiter.resolve(undefined);
      this.emit('close');
      return this;
    }

    write(data, key) {
      if (key?.name === 'c' && key.ctrl) {
        this.emit('SIGINT');
        return this;
      }
      if (key?.name === 'd' && key.ctrl) return this.close();
      if (data !== undefined) this._consume(asText(data));
      return this;
    }

    clearLine(direction, callback) {
      return clearLine(this.output, direction, callback);
    }

    cursorTo(x, y, callback) {
      return cursorTo(this.output, x, y, callback);
    }

    getCursorPos() {
      return { cols: this.cursor, rows: 0 };
    }

    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          const value = await this._waitForLine();
          return value === undefined && this._closed
            ? { value: undefined, done: true }
            : { value, done: false };
        },
        return: async () => {
          this.close();
          return { value: undefined, done: true };
        },
        [Symbol.asyncIterator]() { return this; },
      };
    }
  }

  class PromiseInterface extends Interface {
    question(query, options = {}) {
      return super.question(query, options);
    }
  }

  const createInterface = (...args) => new Interface(...args);
  const createPromiseInterface = (...args) => new PromiseInterface(...args);
  const readline = {
    Interface,
    Readline: Interface,
    clearLine,
    clearScreenDown,
    cursorTo,
    emitKeypressEvents: (stream) => stream,
    moveCursor,
    createInterface,
    promises: {
      Interface: PromiseInterface,
      createInterface: createPromiseInterface,
    },
  };
  Object.defineProperty(readline, 'default', { enumerable: false, value: readline });
  return readline;

  function clearLine(stream, direction = 0, callback) {
    const code = direction < 0 ? '\u001b[1K' : direction > 0 ? '\u001b[0K' : '\u001b[2K';
    return writeControl(stream, code, callback);
  }

  function clearScreenDown(stream, callback) {
    return writeControl(stream, '\u001b[0J', callback);
  }

  function cursorTo(stream, x, y, callback) {
    const sequence = y === undefined
      ? `\u001b[${Math.max(0, Number(x) || 0) + 1}G`
      : `\u001b[${Math.max(0, Number(y) || 0) + 1};${Math.max(0, Number(x) || 0) + 1}H`;
    return writeControl(stream, sequence, callback);
  }

  function moveCursor(stream, dx, dy, callback) {
    const horizontal = Number(dx) || 0;
    const vertical = Number(dy) || 0;
    let sequence = '';
    if (horizontal > 0) sequence += `\u001b[${horizontal}C`;
    if (horizontal < 0) sequence += `\u001b[${-horizontal}D`;
    if (vertical > 0) sequence += `\u001b[${vertical}B`;
    if (vertical < 0) sequence += `\u001b[${-vertical}A`;
    return writeControl(stream, sequence, callback);
  }
}

const tabSizeDefault = 8;
