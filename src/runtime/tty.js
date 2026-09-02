export function createTtyModule(processObject, { stream = null, net = null } = {}) {
  const streamForFd = (fd) => {
    if (fd === 0) return processObject?.stdin;
    if (fd === 1) return processObject?.stdout;
    if (fd === 2) return processObject?.stderr;
    return null;
  };

  function isatty(fd) {
    if (typeof fd === 'number' && (fd === 0 || fd === 1 || fd === 2)) {
      return Boolean(streamForFd(fd)?.isTTY);
    }
    if (fd && typeof fd === 'object' && fd.isTTY) return true;
    return false;
  }

  function getWindowSize(fd = 1) {
    const target = typeof fd === 'object' ? fd : streamForFd(fd);
    if (typeof target?.getWindowSize === 'function') return target.getWindowSize();
    return [80, 24];
  }

  class ReadStream {
    constructor(fd, options = {}) {
      this.isTTY = true;
      this.isRaw = false;
      this.fd = fd;
    }
    setRawMode(mode) {
      this.isRaw = Boolean(mode);
      return this;
    }
  }

  class WriteStream {
    constructor(fd, options = {}) {
      this.isTTY = true;
      this.fd = fd;
      this.columns = 80;
      this.rows = 24;
    }
    getColorDepth(env) {
      return 8; // 256 colors
    }
    hasColors(count = 16, env) {
      return true;
    }
    getWindowSize() {
      return [this.columns, this.rows];
    }
    clearLine(dir, callback) {
      if (typeof callback === 'function') callback();
      return true;
    }
    clearScreenDown(callback) {
      if (typeof callback === 'function') callback();
      return true;
    }
    cursorTo(x, y, callback) {
      if (typeof callback === 'function') callback();
      return true;
    }
    moveCursor(dx, dy, callback) {
      if (typeof callback === 'function') callback();
      return true;
    }
  }

  return {
    isatty,
    getWindowSize,
    ReadStream,
    WriteStream,
  };
}
