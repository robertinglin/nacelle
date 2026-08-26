function hasFlag(processObject, flag) {
  return (processObject?.argv || []).some((value) => String(value) === flag || String(value).startsWith(`${flag}=`));
}

function requireCallback(callback, name) {
  if (typeof callback !== 'function') throw new TypeError(`${name} callback must be a function`);
}

export function createV8Module(processObject) {
  const serializeCallbacks = [];
  const deserializeCallbacks = [];
  let deserializeMainFunction = null;

  const startupSnapshot = {
    addSerializeCallback(callback, ...args) {
      requireCallback(callback, 'serialize');
      serializeCallbacks.push({ callback, args });
    },
    addDeserializeCallback(callback, ...args) {
      requireCallback(callback, 'deserialize');
      deserializeCallbacks.push({ callback, args });
    },
    setDeserializeMainFunction(callback, ...args) {
      requireCallback(callback, 'deserialize main');
      deserializeMainFunction = { callback, args };
    },
    isBuildingSnapshot: () => hasFlag(processObject, '--build-snapshot'),
    isTakingSnapshot: () => hasFlag(processObject, '--snapshot-blob') && !hasFlag(processObject, '--build-snapshot'),
    _callbacks: { serializeCallbacks, deserializeCallbacks, get deserializeMainFunction() { return deserializeMainFunction; } },
  };

  return { startupSnapshot };
}
