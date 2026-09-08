import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

const root = fileURLToPath(new URL('../../../src/', import.meta.url));
const modulePath = process.env.BNH_PLAYWRIGHT_MODULE
  || new URL('../../adapters/playwright/node_modules/playwright/index.mjs', import.meta.url).href;
const { chromium, firefox } = await import(modulePath);
const inMemory = process.env.BNH_GATEWAY_IN_MEMORY === '1';
const engine = process.env.BNH_BROWSER === 'firefox' ? firefox : chromium;

// No npm or host-network service is involved: the fixture uses the runtime's
// actual HTTP/upgrade server and TCP stack. Express parity lives in the adapter.
const application = `
const http = require('http');
const crypto = require('crypto');
const requests = [];
const html = ${JSON.stringify(`<!doctype html><html><head><title>Direct fixture</title>
<link rel="stylesheet" href="/style.css?q=1"><style>.inline{background-image:url('/pixel.png?inline')}</style>
<script src="/classic.js?q=1"></script><script type="module" src="/module.js"></script>
<script type="module">import { value } from './dep.js'; window.inlineModule = value;</script>
</head><body><h1 id="title">Direct fixture</h1><img id="pixel" src="/pixel.png?q=1#pixel">
<a id="link" href="/next?q=two">Next</a><form id="get" action="/form" method="get"><input name="name" value="A B"><button>Go</button></form>
<form id="post" action="/form" method="post"><input name="name" value="C D"><button>Post</button></form></body></html>`)};
const server = http.createServer((req, res) => {
  requests.push(req.method + ' ' + req.url); console.log('http', req.method, req.url);
  const url = new URL(req.url, 'http://localhost:3000');
  if (url.pathname === '/hang') return;
  if (url.pathname === '/stream') { res.setHeader('content-type', 'text/plain'); res.write('first'); setTimeout(() => res.end('second'), 250); return; }
  if (url.pathname === '/redirect') { res.writeHead(302, { location: '/api?redirect=1' }); res.end('redirect'); return; }
  if (url.pathname === '/redirect-external') { res.writeHead(302, { location: 'https://denied.invalid/' }); res.end(); return; }
  if (url.pathname === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
  if (url.pathname === '/style.css') { res.setHeader('content-type','text/css');res.end('@import "./nested.css" screen; #title { width: 123px; background-image:url("/pixel.png?css"); }'); return; }
  if (url.pathname === '/nested.css') { res.setHeader('content-type','text/css');res.end('#title { height: 45px; }'); return; }
  if (url.pathname === '/classic.js') { res.setHeader('content-type','text/javascript');res.end('window.classicLoaded=true;'); return; }
  if (url.pathname === '/module.js') { res.setHeader('content-type','text/javascript');res.end('import { value } from "./dep.js"; window.moduleLoaded=value; window.moduleURL=import.meta.url; import("./dynamic.js").then(m=>window.dynamicLoaded=m.value);'); return; }
  if (url.pathname === '/dep.js' || url.pathname === '/dynamic.js') { res.setHeader('content-type','text/javascript');res.end('export const value=42;'); return; }
  if (url.pathname === '/pixel.png') { res.setHeader('content-type','image/png');res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')); return; }
  if (url.pathname === '/empty') { res.writeHead(204); res.end(); return; }
  if (url.pathname === '/api' || url.pathname === '/form') {
    let body='';req.on('data',part=>body+=part);req.on('end',()=>{
      res.setHeader('x-fixture','yes'); res.setHeader('set-cookie','secret=1');res.setHeader('content-type',url.pathname==='/api'?'application/json':'text/html');
      const data = { method:req.method, url:req.url, body, headers:req.headers };
      res.end(url.pathname==='/api'?JSON.stringify(data):'<pre id="result">'+JSON.stringify(data)+'</pre>');
    }); return;
  }
  if (url.pathname === '/next') { res.setHeader('content-type','text/html');res.end('<h1 id="next">'+req.url+'</h1><script>window.popstates=[];addEventListener("popstate",e=>popstates.push(e.state));</script>'); return; }
  if (url.pathname === '/unsupported') { res.setHeader('content-type','text/html');res.end('<h1>Unsupported</h1><iframe src="/secret"></iframe><img src="https://denied.invalid/pixel"><style>x{background:image-set(url(/secret) 1x)}</style>');return; }
  res.setHeader('content-type','text/html');res.end(html);
});
server.on('upgrade',(req,socket)=>{
  const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\nSec-WebSocket-Protocol: echo\\r\\n\\r\\n');
  socket.on('data',data=>{
    const opcode=data[0]&15; const n=data[1]&127; const mask=data.subarray(2,6);const body=Buffer.alloc(n);
    for(let i=0;i<n;i++)body[i]=data[6+i]^mask[i%4];
    socket.write(Buffer.concat([Buffer.from([128|opcode,n]),body]));
    if(opcode===8)socket.end();
  });
});
server.listen(3000,()=>console.log('gateway-fixture-ready'));
`;

async function fixture(t, gateway = { mode: 'direct-iframe', requestTimeoutMs: 15000 }) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('service-worker-allowed', '/');
    if (pathname === '/') { res.setHeader('content-type','text/html'); res.end('<iframe id="preview"></iframe>'); return; }
    try {
      const file = path.join(root, pathname);
      if (!file.startsWith(root)) throw new Error('invalid path');
      res.setHeader('content-type', pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
      res.end(await fs.readFile(file));
    } catch { res.statusCode = 404; res.end('not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await engine.launch({ headless: true,
    ...(process.env.BNH_BROWSER_EXECUTABLE ? { executablePath: process.env.BNH_BROWSER_EXECUTABLE } : {}),
  });
  let page;
  t.after(async () => {
    if (page && !page.isClosed()) {
      if (process.env.BNH_GATEWAY_COVERAGE) {
        const coverage = await page.coverage.stopJSCoverage();
        await fs.mkdir(process.env.BNH_GATEWAY_COVERAGE, { recursive: true });
        await fs.writeFile(path.join(process.env.BNH_GATEWAY_COVERAGE, `browser-${Date.now()}-${Math.random()}.json`), JSON.stringify(coverage));
      }
      await page.evaluate(() => window.node?.shutdown()).catch(() => {});
    }
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  page = await browser.newPage();
  if (process.env.BNH_GATEWAY_COVERAGE) await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: true });
  page.setDefaultTimeout(6000);

  const errors = [];
  const consoleErrors = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  if (inMemory) {
    // For environments where policy blocks top-level navigation, keep the page
    // in about:blank and serve ESM reads through Playwright's in-memory route.
    // These tests still use real Chromium sandboxing/MessagePorts/Blob URLs.
    // This is not an esm.sh, secure-context, or Service Worker acceptance run.
    await page.setContent('<iframe id="preview"></iframe>');
    await page.route(`${origin}/**`, async route => {
      const pathname = new URL(route.request().url()).pathname;
      try { await route.fulfill({ status:200, contentType:'text/javascript', headers:{'access-control-allow-origin':'*'}, body:await fs.readFile(path.join(root,pathname)) }); }
      catch { await route.fulfill({ status:404, body:'not found' }); }
    });
    await page.exposeFunction('__gatewayTestDigest', async (algorithm, bytes) => [...new Uint8Array(await webcrypto.subtle.digest(algorithm, new Uint8Array(bytes)))]);
    await page.evaluate(() => {
      globalThis.CryptoKey = class CryptoKey {};
      globalThis.SubtleCrypto = class SubtleCrypto {};
      Object.defineProperty(crypto, 'subtle', { value: { digest: async (algorithm, bytes) =>
        new Uint8Array(await __gatewayTestDigest(algorithm, [...new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength)])).buffer } });
    });
  } else await page.goto(gateway === true ? origin.replace('127.0.0.1', 'localhost') : origin);
  await page.evaluate(async ({ origin, gateway, application }) => {
    const { Nacelle } = await import(`${origin}/index.js`);
    window.node = await Nacelle.create({ gateway });
    window.output = '';
    node.on('stdout', event => { output += typeof event === 'string' ? event : event.text ?? event.data ?? ''; });
    window.app = await node.execute(application);
    window.appFailure = null;
    app.exit.catch(error => { appFailure = String(error.stack); });
  }, { origin, gateway, application });
  // Reading the public stream is independent from gateway response delivery.
  await page.waitForFunction(() => output.includes('gateway-fixture-ready') || appFailure);
  assert.equal(await page.evaluate(() => appFailure), null);
  await page.evaluate(() => { window.connection = node.connectIframe(document.querySelector('iframe')); });
  await page.waitForFunction(() => node.gateway.mode === 'service-worker' || node.gateway.sessions[0]?.state === 'loaded').catch(async error => { t.diagnostic(JSON.stringify({errors,consoleErrors,diag:await page.evaluate(()=>node.gateway),output:await page.evaluate(()=>output),frames:await Promise.all(page.frames().slice(1).map(f=>f.evaluate(()=>({html:document.body.innerHTML,classic:window.classicLoaded,module:window.moduleLoaded,inline:window.inlineModule,dynamic:window.dynamicLoaded}))))})); throw error; });
  const frame = () => page.frames().find(frame => frame !== page.mainFrame());
  if (gateway?.mode === 'service-worker') await frame().waitForSelector('#title');
  return { page, frame, requests, errors, consoleErrors, origin };
}

function noVirtualHostRequests(requests) {
  assert.deepEqual(requests.filter(url => /__vhost__|__bnh_vnet__|localhost:3000|denied\.invalid/.test(url)), []);
}

test('direct browser: resources, modules, query strings, opaque sandbox, stdout and streamed fetch', { timeout: 25000 }, async t => {
  const { page, frame, requests, errors, consoleErrors } = await fixture(t);
  await frame().waitForFunction(() => window.moduleLoaded === 42 && window.inlineModule === 42 && window.dynamicLoaded === 42).catch(async error => { t.diagnostic(JSON.stringify({ errors, consoleErrors, diag: await page.evaluate(() => node.gateway.diagnostics), state: await frame().evaluate(() => ({classic:window.classicLoaded,module:window.moduleLoaded,inline:window.inlineModule,dynamic:window.dynamicLoaded,text:document.body.textContent})) })); throw error; });
  assert.equal(await frame().evaluate(() => window.classicLoaded), true);
  assert.equal(await frame().evaluate(() => window.moduleURL), 'http://localhost:3000/module.js');
  assert.equal(await frame().locator('#pixel').evaluate(image => image.complete && image.naturalWidth === 1), true);
  assert.deepEqual(await frame().locator('#title').evaluate(element => [getComputedStyle(element).width, getComputedStyle(element).height]), ['123px', '45px']);
  assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts allow-forms');
  assert.equal(await frame().evaluate(() => { try { return parent.document ? 'access' : 'none'; } catch (error) { return error.name; } }), 'SecurityError');
  const api = await frame().evaluate(async () => {
    const response = await fetch('/api?q=a%20b', { method:'POST', body:'hello', headers:{'x-test':'yes', authorization:'secret'} });
    return { status:response.status, header:response.headers.get('x-fixture'), cookie:response.headers.get('set-cookie'), data:await response.json() };
  });
  assert.equal(api.status,200); assert.equal(api.header,'yes'); assert.equal(api.cookie,null);
  assert.equal(api.data.body,'hello');assert.equal(api.data.url,'/api?q=a%20b');assert.equal(api.data.headers.authorization,undefined);
  const stream = await frame().evaluate(async () => {
    const start = performance.now(); const response = await fetch('/stream'); const reader = response.body.getReader();
    const first = await reader.read();const early = performance.now() - start;const second = await reader.read();
    return { first:new TextDecoder().decode(first.value), second:new TextDecoder().decode(second.value), early, total:performance.now()-start, done:(await reader.read()).done };
  });
  assert.equal(stream.first,'first');assert.equal(stream.second,'second');assert.equal(stream.done,true);assert.ok(stream.total-stream.early > 100);
  assert.ok((await page.evaluate(() => output)).includes('http GET /stream'));
  noVirtualHostRequests(requests); assert.deepEqual(errors, []);
});

test('direct browser: XHR, redirects, empty responses, limits, cancellation and WebSocket', { timeout: 25000 }, async t => {
  const { page, frame, requests, errors, consoleErrors } = await fixture(t);
  const result = await frame().evaluate(async () => {
    const xhr = await new Promise((resolve,reject) => {const request=new XMLHttpRequest();request.open('POST','/api?xhr=1');request.responseType='json';request.setRequestHeader('x-xhr','yes');request.onload=()=>resolve({status:request.status,data:request.response,url:request.responseURL,headers:request.getAllResponseHeaders()});request.onerror=reject;request.send('xhr-body');});
    const redirect=await fetch('/redirect');const data=await redirect.json();
    const manual=await fetch('/redirect',{redirect:'manual'});
    const empty=await fetch('/empty');
    const failures=[];
    for(const [url,init] of [['https://denied.invalid/api',{}],['/redirect-external',{}],['/redirect',{redirect:'error'}],['/loop',{}],['/api',{credentials:'include'}]])try{await fetch(url,init);failures.push('accepted')}catch(error){failures.push(error.code)}
    const abort=new AbortController();const pending=fetch('/hang',{signal:abort.signal});setTimeout(()=>abort.abort(),20);let aborted;try{await pending}catch(error){aborted=error.name}
    const reader=(await fetch('/stream')).body.getReader();await reader.read();await reader.cancel();
    const ws=await new Promise((resolve,reject)=>{const socket=new WebSocket('/echo','echo');const messages=[];socket.binaryType='arraybuffer';socket.onopen=()=>{socket.send('hello');socket.send(new Uint8Array([1,2,3]));};socket.onmessage=event=>{messages.push(typeof event.data==='string'?event.data:[...new Uint8Array(event.data)]);if(messages.length===2)socket.close(3001,'done')};socket.onerror=()=>reject(new Error('socket failed'));socket.onclose=event=>resolve({messages,code:event.code,reason:event.reason,clean:event.wasClean,protocol:socket.protocol,state:socket.readyState});});
    return {xhr,redirect:{url:redirect.url,redirected:redirect.redirected,data},manual:{status:manual.status,location:manual.headers.get('location')},empty:{status:empty.status,text:await empty.text()},failures,aborted,ws};
  });
  assert.equal(result.xhr.status,200);assert.equal(result.xhr.data.body,'xhr-body');assert.match(result.xhr.headers,/x-fixture: yes/);
  assert.equal(result.redirect.redirected,true);assert.equal(result.redirect.url,'http://localhost:3000/api?redirect=1');
  assert.deepEqual(result.manual,{status:302,location:'/api?redirect=1'});assert.deepEqual(result.empty,{status:204,text:''});
  assert.deepEqual(result.failures,['ERR_GATEWAY_NAVIGATION','ERR_GATEWAY_NAVIGATION','ERR_GATEWAY_NAVIGATION','ERR_GATEWAY_NAVIGATION','ERR_GATEWAY_PROTOCOL']);
  assert.equal(result.aborted,'AbortError');assert.deepEqual(result.ws,{messages:['hello',[1,2,3]],code:3001,reason:'done',clean:true,protocol:'echo',state:3});
  await page.waitForFunction(()=>node.gateway.sessions[0].pendingRequests===0);
  noVirtualHostRequests(requests);assert.deepEqual(errors,[]);
});

test('direct browser: links, forms, history, unsupported resources and lifecycle', { timeout: 30000 }, async t => {
  const { page, frame, requests } = await fixture(t);
  await frame().locator('#link').click();await frame().waitForSelector('#next');
  assert.equal(await frame().locator('#next').textContent(),'/next?q=two');
  assert.equal(await page.evaluate(()=>node.gateway.sessions[0].path),'/next?q=two');
  await frame().evaluate(()=>{history.pushState({route:1},'', '/next?q=three');});
  await page.waitForFunction(()=>node.gateway.sessions[0].path==='/next?q=three');
  assert.deepEqual(await frame().evaluate(()=>history.state),{route:1});
  await frame().evaluate(()=>history.back());await page.waitForFunction(()=>node.gateway.sessions[0].path==='/next?q=two'&&node.gateway.sessions[0].state==='loaded');
  await page.evaluate(()=>connection.navigate('/'));
  await frame().locator('#get button').click();await frame().waitForSelector('#result');
  assert.equal(JSON.parse(await frame().locator('#result').textContent()).url,'/form?name=A+B');
  await page.evaluate(()=>connection.navigate('/'));
  await frame().locator('#post button').click();await frame().waitForSelector('#result');
  assert.equal(JSON.parse(await frame().locator('#result').textContent()).body,'name=C+D');
  await page.evaluate(()=>connection.navigate('/unsupported'));
  assert.equal(await frame().locator('iframe').count(),0);assert.match(await frame().locator('[data-nacelle-gateway-error]').textContent(),/ERR_GATEWAY_/);
  await frame().evaluate(()=>{window.pending=fetch('/hang').catch(error=>error.code)});
  await page.waitForFunction(()=>node.gateway.sessions[0].pendingRequests===1);
  await page.evaluate(()=>document.querySelector('iframe').remove());
  await page.waitForFunction(()=>node.gateway.sessions.length===0);
  noVirtualHostRequests(requests);
});


test('direct browser: automatic cross-origin or unavailable-worker selection never requests a worker asset', { timeout: 25000 }, async t => {
  const { page, frame, requests } = await fixture(t, true);
  assert.equal(await page.evaluate(() => node.gateway.mode), 'direct-iframe');
  assert.equal(await page.evaluate(() => node.gateway.reason), inMemory ? 'service-worker-unavailable' : 'cross-origin-module');
  assert.equal(await frame().locator('#title').textContent(), 'Direct fixture');
  assert.deepEqual(requests.filter(url => url.includes('gateway-sw.js')), []);
  noVirtualHostRequests(requests);
});

test('worker browser: forced Service Worker preserves the same virtual HTTP response', {
  timeout: 45000, skip: inMemory ? 'Service Workers require a navigable secure host origin' : false,
}, async t => {
  const { page, frame } = await fixture(t, { mode: 'service-worker', requestTimeoutMs: 15000 });
  assert.equal(await page.evaluate(() => node.gateway.mode), 'service-worker');
  const response = await frame().evaluate(async () => {
    const reply = await fetch('/api?parity=1');
    return { status: reply.status, header: reply.headers.get('x-fixture'), body: await reply.json() };
  });
  assert.equal(response.status, 200);assert.equal(response.header, 'yes');assert.equal(response.body.url, '/api?parity=1');
});
