const api = globalThis.browser || globalThis.chrome;
const isFirefox = Boolean(globalThis.browser);
const pageElement = document.getElementById('page');
const targetElement = document.getElementById('target');
const statusElement = document.getElementById('status');

function call(target, method, ...args) {
  if (isFirefox) return Promise.resolve(target[method](...args));
  return new Promise((resolve, reject) => {
    target[method](...args, (value) => {
      const error = api.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(value);
    });
  });
}

function originPattern(origin) {
  const value = new URL(origin);
  return `${value.protocol}//${value.host}/*`;
}

function scriptId(origin) {
  return `nacelle-plus-${btoa(origin).replace(/[^a-zA-Z0-9]/g, '').slice(0, 40)}`;
}

async function registerPageBridge(pageOrigin, tabId) {
  const matches = [originPattern(pageOrigin)];
  if (api.scripting?.registerContentScripts) {
    try {
      await call(api.scripting, 'registerContentScripts', [{
        id: scriptId(pageOrigin),
        matches,
        js: ['content-script.js'],
        persistAcrossSessions: true,
        runAt: 'document_start',
      }]);
    } catch (error) {
      if (!/already exists|duplicate/i.test(error.message)) throw error;
    }
    await call(api.scripting, 'executeScript', [{ target: { tabId }, files: ['content-script.js'] }]);
    return;
  }
  if (api.contentScripts?.register) {
    await api.contentScripts.register({ matches, js: [{ file: 'content-script.js' }], runAt: 'document_start' });
    return;
  }
  await call(api.tabs, 'executeScript', tabId, { file: 'content-script.js' });
}

async function activeTab() {
  const tabs = await call(api.tabs, 'query', { active: true, currentWindow: true });
  const tab = tabs?.[0];
  const pageOrigin = tab?.url ? new URL(tab.url).origin : null;
  if (!tab?.id || !pageOrigin || !['http:', 'https:'].includes(new URL(tab.url).protocol)) {
    throw new Error('Open an HTTP(S) page before granting Nacelle+ access.');
  }
  return { tab, pageOrigin };
}

activeTab().then(({ pageOrigin }) => {
  pageElement.textContent = `Page: ${pageOrigin}`;
  targetElement.value = pageOrigin;
}).catch((error) => { statusElement.textContent = error.message; });

document.getElementById('grant-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  statusElement.textContent = 'Requesting browser permission…';
  try {
    const { tab, pageOrigin } = await activeTab();
    const targetOrigin = new URL(targetElement.value).origin;
    if (!['http:', 'https:'].includes(new URL(targetOrigin).protocol)) throw new Error('Target must be HTTP(S).');
    const granted = await call(api.permissions, 'request', { origins: [originPattern(pageOrigin), originPattern(targetOrigin)] });
    if (!granted) throw new Error('The browser denied the requested host permission.');
    const result = await call(api.runtime, 'sendMessage', {
      type: 'nacelle-plus-request', operation: 'grant', pageOrigin, targetOrigin,
    });
    if (!result?.ok) throw new Error(result?.error?.message || 'Could not save the Nacelle+ grant.');
    await registerPageBridge(pageOrigin, tab.id);
    statusElement.textContent = `Allowed ${targetOrigin} for ${pageOrigin}. Reload the page if needed.`;
  } catch (error) {
    statusElement.textContent = error.message;
  }
});
