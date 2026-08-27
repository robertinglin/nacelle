function createWarning(value, type, code) {
  if (value instanceof Error) return value;
  if (typeof value !== 'string') {
    throw new TypeError('The "warning" argument must be of type string or an instance of Error');
  }
  const warning = new Error(value);
  warning.name = typeof type === 'string' ? type : type?.type || type?.name || 'Warning';
  const warningCode = typeof type === 'object' ? type.code : code;
  if (warningCode !== undefined) warning.code = warningCode;
  if (typeof type === 'object' && type.detail !== undefined) warning.detail = String(type.detail);
  if (globalThis.__bnhVmFilename && !warning.stack.includes(globalThis.__bnhVmFilename)) {
    warning.stack += `\n    at ${globalThis.__bnhVmFilename}`;
  }
  return warning;
}

function warningText(warning) {
  const prefix = warning.code === undefined ? '' : `[${warning.code}] `;
  return `${prefix}${warning.name}: ${warning.message}\n`;
}

export function installWarningContract(process, { synchronous = false } = {}) {
  if (typeof process.emitWarning === 'function') return process;
  process.emitWarning = (value, type, code) => {
    const warning = createWarning(value, type, code);
    const deliver = () => {
      try {
        if (!process.execArgv?.some((argument) => String(argument) === '--no-warnings')) {
          process.stderr?.write?.(warningText(warning));
        }
        process.emit('warning', warning);
      } catch (error) {
        if (!process.emit('uncaughtException', error)) {
          process.stderr?.write?.(`${error?.stack || error}\n`);
          process.exit?.(1);
        }
      }
    };
    if (synchronous) deliver();
    else process.nextTick(deliver);
  };
  return process;
}
