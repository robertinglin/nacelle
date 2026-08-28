const VALID_PLATFORMS = new Set([
  'aix', 'android', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32',
]);

const VALID_ARCHES = new Set([
  'arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64',
  'riscv64', 's390', 's390x', 'x32', 'x64',
]);

const BROWSER_TOTAL_MEMORY = 512 * 1024 * 1024;
const BROWSER_FREE_MEMORY = 256 * 1024 * 1024;
const BROWSER_CPU = Object.freeze({
  model: 'Browser CPU',
  speed: 0,
  times: Object.freeze({ user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }),
});
const MACHINE_BY_ARCH = Object.freeze({
  arm: 'arm',
  arm64: 'aarch64',
  ia32: 'i686',
  x64: 'x86_64',
});

function freezeConstants() {
  return Object.freeze({
    UV_UDP_REUSEADDR: 4,
    dlopen: Object.freeze({ RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_GLOBAL: 256, RTLD_LOCAL: 0, RTLD_DEEPBIND: 8 }),
    signals: Object.freeze({
      SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6,
      SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12,
      SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGCONT: 18,
      SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23,
      SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28,
      SIGIO: 29, SIGPOLL: 29, SIGPWR: 30, SIGSYS: 31,
    }),
    priority: Object.freeze({
      PRIORITY_LOW: 19,
      PRIORITY_BELOW_NORMAL: 10,
      PRIORITY_NORMAL: 0,
      PRIORITY_ABOVE_NORMAL: -7,
      PRIORITY_HIGH: -14,
      PRIORITY_HIGHEST: -20,
    }),
  });
}

function validateChoice(value, choices, label) {
  if (!choices.has(value)) throw new RangeError(`unsupported ${label}: ${value}`);
  return value;
}

function encodeUserInfo(value, encoding) {
  if (encoding !== 'buffer') return value;
  const BufferClass = globalThis.Buffer;
  return typeof BufferClass?.from === 'function' ? BufferClass.from(value) : value;
}

function createPrimitiveMethod(readValue) {
  const method = () => readValue();
  Object.defineProperty(method, Symbol.toPrimitive, { value: () => String(readValue()) });
  return method;
}

function createCheckedPrimitiveMethod(readValue) {
  const method = function (...args) {
    try {
      return Reflect.apply(readValue, this, args);
    } catch (error) {
      if (Error.stackTraceLimit && typeof Error.captureStackTrace === 'function') {
        Error.captureStackTrace(error, method);
      }
      throw error;
    }
  };
  Object.defineProperty(method, Symbol.toPrimitive, { value: () => String(method()) });
  method.withoutStackTrace = readValue;
  return method;
}

export function createPlatformContract({
  variant = 'browser',
  platform = 'linux',
  arch = 'x64',
  tmpdir = '/tmp',
  eol = '\n',
  env = {},
} = {}) {
  validateChoice(platform, VALID_PLATFORMS, 'platform');
  validateChoice(arch, VALID_ARCHES, 'architecture');
  if (typeof variant !== 'string' || variant.length === 0) throw new TypeError('variant must be a non-empty string');
  if (typeof tmpdir !== 'string' || !tmpdir.startsWith('/')) throw new TypeError('tmpdir must be an absolute POSIX path');
  if (eol !== '\n' && eol !== '\r\n') throw new RangeError('eol must be LF or CRLF');

  let priority = 0;
  const constants = freezeConstants();
  const homedir = '/home/browser';
  const machine = MACHINE_BY_ARCH[arch] || arch;
  const devNull = platform === 'win32' ? '\\\\.\\nul' : '/dev/null';
  const configuredTmpdir = () => {
    const candidate = platform === 'win32'
      ? env.TEMP || env.TMP || tmpdir
      : env.TMPDIR || env.TMP || env.TEMP || tmpdir;
    if (candidate === '/' || candidate === '\\\\') return candidate;
    return platform === 'win32'
      ? String(candidate).replace(/[\\/]+$/, '')
      : String(candidate).replace(/\/+$/, '');
  };
  const os = Object.freeze({
    EOL: eol,
    constants,
    arch: createPrimitiveMethod(() => arch),
    platform: createPrimitiveMethod(() => platform),
    tmpdir: createPrimitiveMethod(configuredTmpdir),
    type: createPrimitiveMethod(() => 'Browser'),
    release: createPrimitiveMethod(() => 'browser'),
    endianness: createPrimitiveMethod(() => 'LE'),
    totalmem: createPrimitiveMethod(() => BROWSER_TOTAL_MEMORY),
    freemem: createPrimitiveMethod(() => BROWSER_FREE_MEMORY),
    availableParallelism: createPrimitiveMethod(() => 1),
    cpus: () => [{ ...BROWSER_CPU, times: { ...BROWSER_CPU.times } }],
    homedir: createCheckedPrimitiveMethod(() => homedir),
    hostname: createCheckedPrimitiveMethod(() => 'browser'),
    uptime: createCheckedPrimitiveMethod(() => 1),
    loadavg: () => [0, 0, 0],
    userInfo: (options = {}) => {
      const encoding = options?.encoding;
      return {
        uid: 0,
        gid: 0,
        username: encodeUserInfo('browser', encoding),
        homedir: encodeUserInfo(homedir, encoding),
        shell: encodeUserInfo('/bin/sh', encoding),
      };
    },
    version: createPrimitiveMethod(() => 'Browser Native OS'),
    machine: createPrimitiveMethod(() => machine),
    devNull,
    getPriority: createPrimitiveMethod(() => priority),
    setPriority: (...args) => {
      const value = args.length === 1 ? args[0] : args[1];
      if (!Number.isInteger(value)) throw new TypeError('priority must be an integer');
      priority = value;
    },
    networkInterfaces: () => ({
      lo: [
        { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' },
        { address: '::1', netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', family: 'IPv6', mac: '00:00:00:00:00:00', internal: true, cidr: '::1/128' },
      ],
    }),
  });
  const environment = Object.freeze({ variant, platform, arch });

  return Object.freeze({
    os,
    environment,
    platform,
    arch,
    EOL: eol,
    tmpdir,
  });
}
