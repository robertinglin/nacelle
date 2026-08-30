const api = globalThis.browser || globalThis.chrome;
const isFirefox = Boolean(globalThis.browser);
const pageElement = document.getElementById('page');
const targetElement = document.getElementById('target');
const privateElement = document.getElementById('allow-private');
const statusElement = document.getElementById('status');
const grantsElement = document.getElementById('grants');

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

async function sendManagement(message) {
  const result = await call(api.runtime, 'sendMessage', { type: 'nacelle-plus-request', ...message });
  if (!result?.ok) throw new Error(result?.error?.message || 'Nacelle+ management request failed.');
  return result;
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
  let parsed;
  try { parsed = new URL(tab?.url); } catch { parsed = null; }
  if (!Number.isInteger(tab?.id) || !parsed || !['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Open an HTTP(S) page before granting Nacelle+ access.');
  }
  return { tab, pageOrigin: parsed.origin };
}

function renderGrants(grants) {
  grantsElement.replaceChildren();
  if (!grants.length) {
    grantsElement.textContent = 'No saved grants.';
    return;
  }
  for (const grant of grants) {
    for (const target of grant.targets) {
      const row = document.createElement('div');
      row.style.marginBottom = '8px';
      const label = document.createElement('span');
      label.textContent = `${grant.pageOrigin} → ${target.targetOrigin}${target.allowPrivate ? ' (private enabled)' : ''}`;
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.textContent = 'Revoke';
      revoke.style.marginTop = '4px';
      revoke.addEventListener('click', async () => {
        revoke.disabled = true;
        try {
          await sendManagement({ operation: 'revoke', pageOrigin: grant.pageOrigin, targetOrigin: target.targetOrigin });
          statusElement.textContent = `Revoked ${target.targetOrigin} for ${grant.pageOrigin}.`;
          await refreshGrants();
        } catch (error) {
          revoke.disabled = false;
          statusElement.textContent = error.message;
        }
      });
      row.append(label, document.createElement('br'), revoke);
      grantsElement.append(row);
    }
  }
}

async function refreshGrants() {
  try {
    const result = await sendManagement({ operation: 'list' });
    renderGrants(result.grants || []);
  } catch (error) {
    grantsElement.textContent = error.message;
  }
}

activeTab().then(({ pageOrigin }) => {
  pageElement.textContent = `Page: ${pageOrigin}`;
  targetElement.value = pageOrigin;
}).catch((error) => { pageElement.textContent = error.message; });
void refreshGrants();

document.getElementById('grant-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  statusElement.textContent = 'Requesting browser permission…';
  try {
    const { tab, pageOrigin } = await activeTab();
    const target = new URL(targetElement.value);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
      throw new Error('Target must be a credential-free HTTP(S) origin.');
    }
    const targetOrigin = target.origin;
    const granted = await call(api.permissions, 'request', {
      origins: [originPattern(pageOrigin), originPattern(targetOrigin)],
    });
    if (!granted) throw new Error('The browser denied the requested host permission.');
    await sendManagement({
      operation: 'grant', pageOrigin, targetOrigin, allowPrivate: privateElement.checked,
    });
    await registerPageBridge(pageOrigin, tab.id);
    statusElement.textContent = `Allowed ${targetOrigin} for ${pageOrigin}. Reload the page if needed.`;
    await refreshGrants();
  } catch (error) {
    statusElement.textContent = error.message;
  }
});
