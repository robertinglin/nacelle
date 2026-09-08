import { gatewayError, DIRECT_GATEWAY_POLICY } from './gateway-selection.js';
import { normalizeVirtualUrl } from './direct-iframe-protocol.js';
import { tokenizeJavaScript, decodeStringLiteral } from './async-transform.js';
import { DIRECT_IFRAME_BOOTSTRAP } from './direct-iframe-bootstrap.js';

export const DIRECT_IFRAME_CSP = "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline' blob:; img-src blob:; media-src blob:; font-src blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'";
const unsupported = message => gatewayError('ERR_GATEWAY_RESOURCE_UNSUPPORTED', message);

export function createBlobOwner(scope = globalThis) {
  const urls = new Map();
  let closed = false;
  return {
    get size() { return urls.size; },
    get resources() { return [...urls].map(([url, blob]) => ({ url, blob })); },
    create(bytes, type) {
      if (closed) throw gatewayError('ERR_GATEWAY_CLOSED', 'Resource document is closed');
      const blob = new scope.Blob([bytes], { type });
      const url = scope.URL.createObjectURL(blob);
      urls.set(url, blob);
      return url;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const url of urls.keys()) scope.URL.revokeObjectURL(url);
      urls.clear();
    },
  };
}

export async function rewriteModule(source, resolve, virtualUrl) {
  const tokens = tokenizeJavaScript(source);
  const replacements = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.value === 'import' && tokens[i - 1]?.value !== '.') {
      if (tokens[i + 1]?.value === '.' && tokens[i + 2]?.value === 'meta' && tokens[i + 3]?.value === '.' && tokens[i + 4]?.value === 'url') {
        replacements.push({ start: token.start, end: tokens[i + 4].end, value: JSON.stringify(virtualUrl) }); i += 4; continue;
      }
      if (tokens[i + 1]?.value === '(') {
        const literal = tokens[i + 2];
        if (!literal || !['"', "'"].includes(source[literal.start]) || tokens[i + 3]?.value !== ')') {
          throw unsupported('Computed module imports are not supported by the direct resource loader');
        }
        replacements.push({ ...literal, value: JSON.stringify(await resolve(decodeStringLiteral(source.slice(literal.start + 1, literal.end - 1)))) });
      } else if (tokens[i + 1]?.value === '<literal>') {
        const literal = tokens[++i];
        replacements.push({ ...literal, value: JSON.stringify(await resolve(decodeStringLiteral(source.slice(literal.start + 1, literal.end - 1)))) });
      }
    }
    if (token.value === 'from' && tokens[i + 1]?.value === '<literal>') {
      const literal = tokens[++i];
      replacements.push({ ...literal, value: JSON.stringify(await resolve(decodeStringLiteral(source.slice(literal.start + 1, literal.end - 1)))) });
    }
  }
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, replacement.start) + replacement.value + source.slice(replacement.end);
  }
  return source;
}

export async function rewriteCss(source, resolve) {
  // CSS escapes and image-set strings need a full CSS tokenizer. Fail visibly
  // instead of letting one bypass the URL pass or make a host request.
  if (/\\|\b(?:image-set|src)\s*\(/i.test(source)) throw unsupported('Escaped CSS URLs and image-set()/src() are unsupported');
  const pattern = /\/\*[\s\S]*?\*\/|@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s;)]+))\s*\)?|url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;
  let result = '';
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    result += source.slice(offset, match.index);
    if (match[0].startsWith('/*')) result += match[0];
    else {
      const isImport = /^@import/i.test(match[0]);
      const url = (isImport ? match[1] ?? match[2] ?? match[3] : match[4] ?? match[5] ?? match[6]).trim();
      const target = url.startsWith('#') && !isImport ? url : await resolve(url, isImport ? 'css' : 'asset');
      result += `${isImport ? '@import ' : ''}url(${JSON.stringify(target)})${isImport ? ' ' : ''}`;
    }
    offset = match.index + match[0].length;
  }
  return result + source.slice(offset);
}

export function bootstrapDocument(content = '') {
  // Only the fixed function source is ever put inside the privileged bootstrap
  // script. Application markup and protocol configuration are separate inputs.
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${DIRECT_IFRAME_CSP}"><script>${DIRECT_IFRAME_BOOTSTRAP}</script></head><body>${content}</body></html>`;
}

/** Parse in an inert template: DOMParser HTML documents may load image URLs. */
export async function rewriteDocument({ html, path, port, pageUrl, scope = globalThis,
  request, owner, maxBodyBytes, onDiagnostic = () => {} }) {
  const template = scope.document.createElement('template');
  template.innerHTML = html;
  if (template.content.querySelector?.('meta[http-equiv="Content-Security-Policy" i]')) throw unsupported('Document CSP cannot be preserved across rewritten opaque origins');
  const cache = new Map();
  let resourceCount = 0;
  let resourceBytes = 0;
  const clean = (url, base = path) => normalizeVirtualUrl(url, { port, base, pageUrl });
  const resource = async (url, kind = 'asset', base = path, ancestry = []) => {
    const target = clean(url, base);
    const key = `${kind}:${target.split('#', 1)[0]}`;
    if (ancestry.includes(key)) throw unsupported(`Cyclic ${kind} resource dependency`);
    const fragment = target.includes('#') ? target.slice(target.indexOf('#')) : '';
    if (cache.has(key)) return await cache.get(key) + fragment;
    if (++resourceCount > DIRECT_GATEWAY_POLICY.maxResources) throw gatewayError('ERR_GATEWAY_REQUEST_LIMIT', 'Document resource count exceeded');
    const promise = (async () => {
      const response = await request(target);
      if (response.status < 200 || response.status >= 300) throw unsupported(`Resource returned HTTP ${response.status}: ${target}`);
      resourceBytes += response.bytes.length;
      if (resourceBytes > maxBodyBytes) throw gatewayError('ERR_GATEWAY_BODY_LIMIT', 'Document resources exceed maxBodyBytes');
      let bytes = response.bytes;
      let type = response.contentType || 'application/octet-stream';
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw unsupported('Encoded subresources are not supported');
      const next = (address, nextKind) => resource(address, nextKind, response.finalUrl, [...ancestry, key]);
      if (kind === 'css') {
        bytes = await rewriteCss(new TextDecoder().decode(bytes), next); type = 'text/css';
      } else if (kind === 'script' || kind === 'module') {
        bytes = await rewriteModule(new TextDecoder().decode(bytes), address => {
          if (!/^(?:[./]|https?:)/i.test(address)) throw unsupported('Bare module specifiers require an unsupported import map');
          return next(address, 'module');
        }, `http://localhost:${port}${response.finalUrl}`);
        type = 'text/javascript';
      }
      return owner.create(bytes, type);
    })();
    cache.set(key, promise);
    return await promise + fragment;
  };
  const report = error => onDiagnostic(error.code?.startsWith('ERR_GATEWAY_') ? error : unsupported(error.message));
  // Remove unsupported active elements and parser instructions before any
  // transformed content enters a browsing context.
  for (const element of template.content.querySelectorAll('base, iframe, frame, frameset, object, embed, meta[http-equiv], link')) {
    if (element.tagName === 'LINK' && ['stylesheet', 'modulepreload', 'import'].includes(element.getAttribute('rel')?.toLowerCase())) continue;
    report(unsupported(`${element.tagName.toLowerCase()} is not supported in direct documents`));
    element.remove();
  }
  for (const element of template.content.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      if (['srcset', 'imagesrcset', 'ping', 'background', 'srcdoc', 'manifest', 'xlink:href'].includes(attribute.name)) {
        element.removeAttribute(attribute.name); report(unsupported(`${attribute.name} is not supported`));
      }
    }
    if (element.hasAttribute('integrity')) {
      report(unsupported('Integrity metadata cannot be applied to rewritten resources'));
      element.remove(); continue;
    }
    if (element.hasAttribute('style')) {
      try { element.setAttribute('style', await rewriteCss(element.getAttribute('style'), resource)); }
      catch (error) { element.removeAttribute('style'); report(error); }
    }
    if (element.tagName === 'STYLE') {
      try { element.textContent = await rewriteCss(element.textContent, resource); }
      catch (error) { element.textContent = ''; report(error); }
    }
    if (element.tagName === 'A' && element.hasAttribute('href')) {
      try { element.setAttribute('data-nacelle-href', clean(element.getAttribute('href'))); }
      catch (error) { report(error); }
      element.setAttribute('href', '#'); element.removeAttribute('target'); element.removeAttribute('download');
    }
    if (element.tagName === 'FORM') {
      try { element.setAttribute('data-nacelle-action', clean(element.getAttribute('action') || path)); }
      catch (error) { report(error); }
      element.removeAttribute('action'); element.removeAttribute('target');
    }
    if (element.hasAttribute('formaction')) {
      try { element.setAttribute('data-nacelle-formaction', clean(element.getAttribute('formaction'))); }
      catch (error) { report(error); }
      element.removeAttribute('formaction');
    }
    const tag = element.tagName;
    if (tag === 'SCRIPT' && !element.hasAttribute('src')) {
      if (element.type === 'importmap') { report(unsupported('Import maps are unsupported')); element.remove(); continue; }
      try {
        element.textContent = await rewriteModule(element.textContent, address => {
          if (!/^(?:[./]|https?:)/i.test(address)) throw unsupported('Bare module specifiers require an unsupported import map');
          return resource(address, 'module');
        }, `http://localhost:${port}${path}`);
      } catch (error) { element.remove(); report(error); }
    }
    let attribute = null;
    let kind = 'asset';
    if (tag === 'SCRIPT') { attribute = 'src'; kind = element.type === 'module' ? 'module' : 'script'; }
    else if (tag === 'LINK') { attribute = 'href'; kind = element.rel.toLowerCase() === 'stylesheet' ? 'css' : 'module'; }
    else if (['IMG', 'SOURCE', 'VIDEO', 'AUDIO', 'TRACK', 'INPUT'].includes(tag)) attribute = 'src';
    if (attribute && element.hasAttribute(attribute)) {
      const url = element.getAttribute(attribute);
      element.removeAttribute(attribute);
      try { element.setAttribute(attribute, await resource(url, kind)); }
      catch (error) { report(error); }
    }
    if (element.hasAttribute('poster')) {
      const url = element.getAttribute('poster'); element.removeAttribute('poster');
      try { element.setAttribute('poster', await resource(url)); } catch (error) { report(error); }
    }
    // Other URL-bearing namespaces are unsupported, including SVG image/use.
    if (!['A', 'LINK'].includes(tag) && element.hasAttribute('href')) {
      element.removeAttribute('href'); report(unsupported(`${tag}.href is unsupported`));
    }
    if (!attribute && element.hasAttribute('src')) {
      element.removeAttribute('src'); report(unsupported(`${tag}.src is unsupported`));
    }
  }
  return template.innerHTML;
}
