function invalidArgument(name, expected, value) {
  const received = value === null ? 'null' : typeof value;
  const error = new TypeError(`The "${name}" argument must be ${expected}. Received ${received}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function validateReportError(value) {
  if (value === null || typeof value !== 'object') throw invalidArgument('err', 'an object', value);
}

const REPORT_SIGNALS = new Set([
  'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS', 'SIGFPE',
  'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE', 'SIGALRM', 'SIGTERM', 'SIGCHLD',
  'SIGCONT', 'SIGSTOP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGURG', 'SIGXCPU',
  'SIGXFSZ', 'SIGVTALRM', 'SIGPROF', 'SIGWINCH', 'SIGIO', 'SIGPWR', 'SIGSYS',
]);

function reportTimestamp() {
  const now = new Date();
  const date = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 8);
  const time = now.toISOString().replace(/[-:TZ.]/g, '').slice(8, 21);
  return { date, time };
}

function flattenInterfaces(interfaces) {
  return Object.entries(interfaces || {}).flatMap(([name, entries]) => (entries || []).map((entry) => ({
    name,
    ...entry,
    ...(entry.family === 'IPv6' ? { scopeid: entry.scopeid ?? 0 } : {}),
  })));
}

function reportResourceUsage() {
  return {
    userCpuSeconds: 0,
    kernelCpuSeconds: 0,
    cpuConsumptionPercent: 0,
    userCpuConsumptionPercent: 0,
    kernelCpuConsumptionPercent: 0,
    maxRss: '0',
    rss: '0',
    free_memory: '0',
    total_memory: '0',
    available_memory: '0',
    pageFaults: { IORequired: 0, IONotRequired: 0 },
    fsActivity: { reads: 0, writes: 0 },
  };
}

function createReportDocument({ processObject, os, error, event, filename, excludeNetwork = false }) {
  const { date, time } = reportTimestamp();
  const stack = error?.stack ? String(error.stack).split('\n') : undefined;
  const errorProperties = error && typeof error === 'object'
    ? Object.fromEntries(Object.keys(error).map((key) => [key, error[key]]))
    : {};
  const cpus = os.cpus().map(({ model, speed, times }) => ({
    model,
    speed,
    user: times.user,
    nice: times.nice,
    sys: times.sys,
    idle: times.idle,
    irq: times.irq,
  }));
  const totalMemory = os.totalmem();
  const interfaces = flattenInterfaces(os.networkInterfaces());
  return {
    header: {
      event,
      trigger: 'API',
      filename: filename ?? null,
      dumpEventTime: new Date().toISOString(),
      dumpEventTimeStamp: Date.now(),
      processId: Number(processObject.pid),
      commandLine: [...(processObject.argv || [])].map(String),
      nodejsVersion: processObject.version,
      wordSize: 64,
      arch: os.arch(),
      platform: os.platform(),
      componentVersions: processObject.versions,
      release: processObject.release || {},
      osName: os.type(),
      osRelease: os.release(),
      osVersion: os.version(),
      osMachine: os.machine(),
      cpus,
      host: os.hostname(),
      glibcVersionRuntime: '',
      glibcVersionCompiler: '',
      cwd: processObject.cwd(),
      reportVersion: 5,
      ...(excludeNetwork ? {} : { networkInterfaces: interfaces }),
      threadId: null,
    },
    nativeStack: [],
    javascriptStack: {
      message: error?.message ? String(error.message) : '',
      ...(stack ? { stack } : {}),
      errorProperties,
    },
    libuv: [],
    sharedObjects: [],
    resourceUsage: {
      ...reportResourceUsage(),
      rss: String(totalMemory - os.freemem()),
      free_memory: String(os.freemem()),
      total_memory: String(totalMemory),
      available_memory: String(os.freemem()),
    },
    workers: [],
    environmentVariables: { ...(processObject.env || {}) },
    userLimits: {},
  };
}

export function createProcessReport({ processObject, os, fs, path, stdout, stderr, initial = {} }) {
  let directory = '';
  let configuredFilename = '';
  let compact = Boolean(initial.compact);
  let excludeEnv = Boolean(initial.excludeEnv);
  let excludeNetwork = Boolean(initial.excludeNetwork);
  let reportOnFatalError = Boolean(initial.reportOnFatalError);
  let reportOnSignal = Boolean(initial.reportOnSignal);
  let reportOnUncaughtException = Boolean(initial.reportOnUncaughtException);
  let signal = initial.signal;
  let signalListener;
  let signalListenerName = null;

  function updateSignalListener() {
    if (signalListenerName) processObject.removeListener(signalListenerName, signalListener);
    signalListenerName = null;
    if (reportOnSignal) {
      signalListener ||= () => {};
      processObject.on(signal, signalListener);
      signalListenerName = signal;
    }
  }
  let sequence = 0;

  function defaultFilename() {
    const { date, time } = reportTimestamp();
    sequence += 1;
    return `report.${date}.${time}.${processObject.pid}.0.${sequence}.json`;
  }

  function reportPath(file) {
    const name = file || configuredFilename || defaultFilename();
    if (name === 'stdout' || name === 'stderr') return name;
    if (name.startsWith('/')) return name;
    return path.join(directory || processObject.cwd(), name);
  }

  function writeReport(file, error) {
    if (file !== undefined && file !== null && typeof file === 'object') {
      error = file;
      file = undefined;
    } else if (file !== undefined) {
      if (typeof file !== 'string') throw invalidArgument('file', 'a string', file);
    }
    if (error !== undefined) validateReportError(error);
    const target = reportPath(file);
    const document = createReportDocument({
      processObject,
      os,
      error,
      event: 'JavaScript API',
      filename: target === 'stdout' || target === 'stderr' ? null : file || configuredFilename || null,
      excludeNetwork,
    });
    if (excludeEnv) delete document.environmentVariables;
    const text = `${JSON.stringify(document, null, compact ? 0 : 2)}\n`;
    if (target === 'stdout') stdout(text);
    else if (target === 'stderr') stderr(`${text}Node.js report completed\n`);
    else {
      try {
        fs.writeFileSync(target, text, 'utf8');
      } catch (writeError) {
        stderr(`Failed to open Node.js report file: ${writeError.message || writeError}\n`);
      }
    }
    return file || configuredFilename || (target === 'stdout' || target === 'stderr' ? undefined : path.basename(target));
  }

  return {
    writeReport,
    getReport(error) {
      if (error !== undefined) validateReportError(error);
      const document = createReportDocument({ processObject, os, error, event: 'JavaScript API', filename: null, excludeNetwork });
      if (excludeEnv) delete document.environmentVariables;
      return document;
    },
    get directory() { return directory; },
    set directory(value) {
      if (typeof value !== 'string') throw invalidArgument('directory', 'a string', value);
      directory = value;
    },
    get filename() { return configuredFilename; },
    set filename(value) {
      if (typeof value !== 'string') throw invalidArgument('filename', 'a string', value);
      configuredFilename = value;
    },
    get compact() { return compact; },
    set compact(value) { if (typeof value !== 'boolean') throw invalidArgument('compact', 'a boolean', value); compact = value; },
    get excludeNetwork() { return excludeNetwork; },
    set excludeNetwork(value) { if (typeof value !== 'boolean') throw invalidArgument('excludeNetwork', 'a boolean', value); excludeNetwork = value; },
    get signal() { return signal; },
    set signal(value) {
      if (typeof value !== 'string') throw invalidArgument('signal', 'a string', value);
      if (!REPORT_SIGNALS.has(value)) {
        const suffix = value.toUpperCase().startsWith('SIG') && value.toUpperCase() !== value
          ? ' (signals must use all capital letters)'
          : '';
        const error = new Error(`Unknown signal: ${value}${suffix}`);
        error.code = 'ERR_UNKNOWN_SIGNAL';
        throw error;
      }
      signal = value;
      updateSignalListener();
    },
    get reportOnFatalError() { return reportOnFatalError; },
    set reportOnFatalError(value) { if (typeof value !== 'boolean') throw invalidArgument('reportOnFatalError', 'a boolean', value); reportOnFatalError = value; },
    get reportOnSignal() { return reportOnSignal; },
    set reportOnSignal(value) {
      if (typeof value !== 'boolean') throw invalidArgument('reportOnSignal', 'a boolean', value);
      reportOnSignal = value;
      updateSignalListener();
    },
    get reportOnUncaughtException() { return reportOnUncaughtException; },
    set reportOnUncaughtException(value) { if (typeof value !== 'boolean') throw invalidArgument('reportOnUncaughtException', 'a boolean', value); reportOnUncaughtException = value; },
    get excludeEnv() { return excludeEnv; },
    set excludeEnv(value) { if (typeof value !== 'boolean') throw invalidArgument('excludeEnv', 'a boolean', value); excludeEnv = value; },
  };
}
