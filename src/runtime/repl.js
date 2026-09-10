/**
 * Browser-native subset of node:repl.
 *
 * The interactive terminal itself belongs to the embedding page, but Node
 * packages commonly import repl for its server constructor and start helper.
 * Keep those APIs stream-based so they can use the runtime's readline bridge.
 */
export function createBrowserRepl({ EventEmitter, readline } = {}) {
  if (typeof EventEmitter !== 'function') throw new TypeError('EventEmitter is required');
  if (!readline || typeof readline.createInterface !== 'function') {
    throw new TypeError('readline is required');
  }

  class Recoverable extends SyntaxError {
    constructor(message) {
      super(message);
      this.name = 'Recoverable';
    }
  }

  class REPLServer extends EventEmitter {
    constructor(options = {}) {
      super();
      if (!options.input || typeof options.input.on !== 'function') {
        throw new TypeError('input must be a readable stream');
      }
      if (!options.output || typeof options.output.write !== 'function') {
        throw new TypeError('output must be a writable stream');
      }
      this.input = options.input;
      this.output = options.output;
      this.eval = typeof options.eval === 'function' ? options.eval : defaultEval;
      this.writer = typeof options.writer === 'function' ? options.writer : String;
      this.completer = options.completer;
      this.context = options.context || Object.create(null);
      this.commands = Object.create(null);
      this._closed = false;
      this._interface = readline.createInterface({
        input: this.input,
        output: this.output,
        completer: this.completer,
        terminal: options.terminal,
        prompt: options.prompt || '> ',
        historySize: options.historySize,
      });
      this._interface.on('line', (line) => this._evaluate(line));
      this._interface.on('close', () => this.emit('exit'));
      this._interface.on('SIGINT', () => this.emit('SIGINT'));
      if (options.promptOnStart !== false) this.prompt();
    }

    _evaluate(line) {
      const callback = (error, value) => {
        if (error) {
          this.emit('error', error);
          return;
        }
        if (value !== undefined) this.output.write(`${this.writer(value)}\n`);
        this.prompt();
      };
      try {
        this.eval(String(line), this.context, this.filename, callback);
      } catch (error) {
        callback(error);
      }
    }

    prompt(preserveCursor = false) {
      if (!this._closed) this._interface.prompt(preserveCursor);
      return this;
    }

    setPrompt(prompt) {
      this._interface.setPrompt(prompt);
      return this;
    }

    getPrompt() {
      return this._interface.getPrompt();
    }

    pause() {
      this._interface.pause();
      return this;
    }

    resume() {
      this._interface.resume();
      return this;
    }

    close() {
      if (this._closed) return this;
      this._closed = true;
      this._interface.close();
      return this;
    }

    write(data, key) {
      this._interface.write(data, key);
      return this;
    }

    defineCommand(keyword, command) {
      this.commands[String(keyword)] = command;
      return this;
    }

    displayPrompt(preserveCursor = false) {
      return this.prompt(preserveCursor);
    }
  }

  const start = (options = {}) => {
    const normalized = typeof options === 'string' ? { prompt: options } : options;
    return new REPLServer(normalized);
  };

  return {
    REPLServer,
    Recoverable,
    start,
    REPL_MODE_SLOPPY: Symbol('repl-mode-sloppy'),
    REPL_MODE_STRICT: Symbol('repl-mode-strict'),
  };

  function defaultEval(source, context, _filename, callback) {
    try {
      callback(null, Function('context', `with (context) { return (${source}); }`)(context));
    } catch (error) {
      callback(error);
    }
  }
}
