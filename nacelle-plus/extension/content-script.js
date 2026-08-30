const api = globalThis.browser || globalThis.chrome;
const isFirefox = Boolean(globalThis.browser);
const PAGE_SOURCE = 'nacelle-plus-page';
const EXTENSION_SOURCE = 'nacelle-plus-extension';

function sendMessage(message) {
  if (isFirefox) return api.runtime.sendMessage(message);
  return new Promise((resolve, reject) => {
    api.runtime.sendMessage(message, (response) => {
      const error = api.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== PAGE_SOURCE) return;
  const { requestId, request, extensionId } = event.data;
  sendMessage({ type: 'nacelle-plus-request', operation: 'request', requestId, extensionId, request })
    .then((response) => {
      const transfer = response?.body instanceof ArrayBuffer ? [response.body] : [];
      window.postMessage({ source: EXTENSION_SOURCE, requestId, response }, '*', transfer);
    })
    .catch((error) => {
      window.postMessage({
        source: EXTENSION_SOURCE,
        requestId,
        response: { ok: false, error: { code: 'ERR_NACELLE_PLUS_EXTENSION', message: error.message } },
      }, '*');
    });
});
