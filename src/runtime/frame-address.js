export function watchFrameAddress(frame, onAddress) {
  const readAddress = () => {
    try {
      const location = frame.contentWindow?.location;
      if (!location || !location.pathname || location.pathname === '/blank' || location.pathname === 'about:blank') {
        return null;
      }
      return location.pathname + location.search + location.hash;
    } catch {
      return null;
    }
  };

  const syncAddress = () => {
    const address = readAddress();
    if (address) onAddress(address);
  };

  const watchDocument = () => {
    syncAddress();
    try {
      const frameWindow = frame.contentWindow;
      for (const eventName of ['hashchange', 'popstate']) {
        frameWindow?.addEventListener(eventName, syncAddress);
      }
      for (const methodName of ['pushState', 'replaceState']) {
        const original = frameWindow?.history?.[methodName];
        if (typeof original !== 'function') continue;
        frameWindow.history[methodName] = function updateFrameAddress(...args) {
          const result = original.apply(this, args);
          syncAddress();
          return result;
        };
      }
    } catch {
      // The iframe can be between documents during a browser redirect.
    }
  };

  frame.addEventListener('load', watchDocument);
  return () => frame.removeEventListener('load', watchDocument);
}
