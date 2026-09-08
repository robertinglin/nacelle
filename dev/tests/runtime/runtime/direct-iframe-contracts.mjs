import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Nacelle } from '../../../../src/index.js';
import { normalizeGatewayOptions, selectGateway, DIRECT_GATEWAY_POLICY } from '../../../../src/runtime/gateway-selection.js';
import { normalizeVirtualUrl, normalizeRequestHeaders, normalizeRequest, createEnvelopePeer } from '../../../../src/runtime/direct-iframe-protocol.js';
import { createGatewayHttpParser, openGatewayHttp } from '../../../../src/runtime/gateway-http.js';
import { createBlobOwner, rewriteCss, rewriteModule, bootstrapDocument } from '../../../../src/runtime/direct-iframe-resources.js';
import { createVirtualNetwork } from '../../../../src/runtime/virtual-network.js';

const code = value => ({ code: value });
const encode = value => new TextEncoder().encode(value);
const decode = value => new TextDecoder().decode(value);
const context = { port: 3000, pageUrl: 'https://host.test/app', base: '/dir/index.html?q=1' };

test('gateway options and transport selection cover explicit, CDN, unavailable, same-origin and disabled', () => {
  assert.equal(normalizeGatewayOptions().mode, 'auto');
  assert.equal(normalizeGatewayOptions(false).mode, 'disabled');
  assert.equal(normalizeGatewayOptions({ mode: 'direct-iframe', maxBodyBytes: 42 }).maxBodyBytes, 42);
  assert.equal(normalizeGatewayOptions({}).maxBodyBytes, DIRECT_GATEWAY_POLICY.maxBodyBytes);
  for (const value of [null, 0, '', [], { mode: '' }, { mode: 'bad' }, { scope: '' }, { swPath: 2 }, { maxBodyBytes: 0 },
    { maxBodyBytes: 1.5 }, { maxConcurrentRequests: Infinity }, { requestTimeoutMs: 2 ** 31 }]) {
    assert.throws(() => normalizeGatewayOptions(value), code('ERR_GATEWAY_MODE'));
  }
  const common = { runtimeModuleUrl: 'https://host.test/runtime.js', pageUrl: 'https://host.test/app', serviceWorkerAvailable: true };
  assert.equal(selectGateway(common).mode, 'service-worker');
  assert.equal(selectGateway({ ...common, runtimeModuleUrl: 'https://esm.sh/nacelle' }).mode, 'direct-iframe');
  assert.equal(selectGateway({ ...common, runtimeModuleUrl: 'https://another-cdn.test/pkg' }).reason, 'cross-origin-module');
  assert.equal(selectGateway({ ...common, serviceWorkerAvailable: false }).reason, 'service-worker-unavailable');
  assert.equal(selectGateway({ ...common, runtimeModuleUrl: 'file:///code.js' }).mode, 'direct-iframe');
  assert.equal(selectGateway({ ...common, runtimeModuleUrl: 'invalid' }).mode, 'direct-iframe');
  assert.equal(selectGateway({ ...common, requestedMode: 'disabled' }).mode, 'disabled');
  for (const requestedMode of ['direct-iframe', 'service-worker']) assert.equal(selectGateway({ requestedMode }).mode, requestedMode);
  assert.throws(() => selectGateway({ requestedMode: 'wrong' }), code('ERR_GATEWAY_MODE'));
  assert.equal(selectGateway().mode, 'direct-iframe');
});

test('read-only runtime diagnostics and forced worker failures are actionable', async () => {
  const node = await Nacelle.create({ gateway: false });
  assert.equal(node.gateway.mode, 'disabled');
  assert.throws(() => { node.gateway.mode = 'direct-iframe'; }, TypeError);
  assert.throws(() => { node.gateway = {}; }, TypeError);
  assert.throws(() => node.connectIframe({}), code('ERR_GATEWAY_MODE'));
  assert.deepEqual(node.gateway.sessions, []);
  assert.equal(node.rawRuntime.runtimeModuleUrl, node.gateway.runtimeModuleUrl);
  await assert.rejects(Nacelle.create({ gateway: { mode: 'service-worker' } }), code('ERR_GATEWAY_MODE'));
  await node.reset(); await node.shutdown(); await node.shutdown();
  await assert.rejects(node.reset(), code('ERR_GATEWAY_CLOSED'));
  assert.throws(() => node.connectIframe({}), code('ERR_GATEWAY_CLOSED'));
});

test('worker initialization times out and releases its controller listener', async () => {
  const worker = new EventTarget();
  let listeners = 0;
  const add = worker.addEventListener.bind(worker); const remove = worker.removeEventListener.bind(worker);
  worker.addEventListener = (...args) => { listeners++; add(...args); };
  worker.removeEventListener = (...args) => { listeners--; remove(...args); };
  worker.register = async () => ({ update: async () => {} }); worker.ready = Promise.resolve();
  await assert.rejects(Nacelle.initServiceWorker('/sw', '/', { navigator: { serviceWorker: worker } }, 10), code('ERR_GATEWAY_TIMEOUT'));
  assert.equal(listeners, 0);
  assert.equal(await Nacelle.initServiceWorker('/sw', '/', {}), null);
  worker.register = () => new Promise(resolve => setTimeout(() => resolve({ update: async () => {} }), 20));
  await assert.rejects(Nacelle.initServiceWorker('/sw', '/', { navigator: { serviceWorker: worker } }, 5), code('ERR_GATEWAY_TIMEOUT'));
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(listeners, 0);
});

test('virtual paths resolve queries, fragments, relative paths and loopback authority only', () => {
  assert.equal(normalizeVirtualUrl('../api?q=x#y', context), '/api?q=x#y');
  assert.equal(normalizeVirtualUrl('?new=2', context), '/dir/index.html?new=2');
  assert.equal(normalizeVirtualUrl('http://127.0.0.1:3000/x', context), '/x');
  assert.equal(normalizeVirtualUrl('http://[::1]:3000/x', context), '/x');
  assert.equal(normalizeVirtualUrl('/'), '/');
  assert.equal(normalizeVirtualUrl('ws://localhost:3000/echo', { ...context, websocket: true }), '/echo');
  assert.equal(normalizeVirtualUrl('http://localhost:3000/echo', { ...context, websocket: true }), '/echo');
  for (const value of ['https://host.test/api', 'http://localhost:4000/', 'https://localhost:3000/', '//evil.test/api',
    'javascript:alert(1)', 'data:text/plain,x', 'file:///tmp/x', 'ftp://localhost:3000/a', 'http://u:p@localhost:3000/',
    '/__vhost__/3000/', '/__bnh_vnet__/3000/', '/bad\\x', '/a\nX:', '/a b', '', null, 'http://[', 'ws://localhost:3000/']) {
    assert.throws(() => normalizeVirtualUrl(value, context), code('ERR_GATEWAY_NAVIGATION'));
  }
  assert.throws(() => normalizeVirtualUrl('ws://localhost:3000/#hash', { ...context, websocket: true }), code('ERR_GATEWAY_NAVIGATION'));
  assert.throws(() => normalizeVirtualUrl('http://localhost:3000/x', { ...context, pageUrl: 'http://localhost:3000/' }), code('ERR_GATEWAY_NAVIGATION'));
  for (const port of [0, 65536, '3000', 1.1]) assert.throws(() => normalizeVirtualUrl('/', { port }), code('ERR_GATEWAY_NAVIGATION'));
});

test('headers are lowercase, bounded and cannot carry ambient or hop-by-hop credentials', () => {
  const headers = normalizeRequestHeaders({ 'X-Example': 'one', Cookie: 'secret', Authorization: 'secret',
    Host: 'host.test', Connection: 'upgrade', 'Content-Length': '999', 'Sec-Fetch-Site': 'same-origin', 'Proxy-Thing': 'x' });
  assert.deepEqual({ ...headers }, { 'x-example': 'one' });
  assert.deepEqual({ ...normalizeRequestHeaders([['X-A', 'a'], ['x-a', 'b']]) }, { 'x-a': 'a, b' });
  assert.deepEqual({ ...normalizeRequestHeaders(new Headers({ a: 'b' })) }, { a: 'b' });
  assert.deepEqual({ ...normalizeRequestHeaders() }, {});
  for (const value of [null, 'x', [['x']], { 'bad name': 'x' }, { x: 'a\r\nb' }, { x: 1 }, { x: '☃' }]) {
    assert.throws(() => normalizeRequestHeaders(value), code('ERR_GATEWAY_PROTOCOL'));
  }
  assert.throws(() => normalizeRequestHeaders(Array.from({ length: 129 }, () => ['a', 'b'])), code('ERR_GATEWAY_BODY_LIMIT'));
  assert.throws(() => normalizeRequestHeaders({ x: 'x'.repeat(32769) }), code('ERR_GATEWAY_BODY_LIMIT'));
});

test('request normalization rejects unsafe methods, credentials, bodies and options before dispatch', () => {
  assert.equal(normalizeRequest({ url: '/', body: null }, context, 32).method, 'GET');
  assert.equal(normalizeRequest({ url: '/', method: 'post', body: 'hello' }, context, 32).body.length, 5);
  assert.equal(normalizeRequest({ url: '/', method: 'POST', body: new ArrayBuffer(2), mode: 'cors', credentials: 'omit', redirect: 'manual' }, context, 32).body.length, 2);
  assert.equal(normalizeRequest({ path: '/', method: 'POST', body: new Uint8Array(2) }, context, 32).path, '/');
  for (const payload of [null, { url: '/', method: 3 }, { url: '/', method: 'CONNECT' }, { url: '/', method: 'BAD METHOD' },
    { url: '/', credentials: 'include' }, { url: '/', mode: 'bad' }, { url: '/', redirect: 'bad' }, { url: '/', body: {} }, { url: '/', body: 'not-allowed' }]) {
    assert.throws(() => normalizeRequest(payload, context, 32), code('ERR_GATEWAY_PROTOCOL'));
  }
  assert.throws(() => normalizeRequest({ url: '/', method: 'POST', body: '123' }, context, 2), code('ERR_GATEWAY_BODY_LIMIT'));
});

test('envelopes authenticate nonce/version/session, discard duplicates, and fail closed on sequence gaps', () => {
  const output = []; const errors = [];
  const peer = createEnvelopePeer({ sessionId: 'id', nonce: 'nonce', send: (...args) => output.push(args), onError: e => errors.push(e.code) });
  peer.send('ready'); peer.send('test', { a: 1 }, ['transfer']);
  const valid = output[0][0];
  assert.equal(valid.sequence, 1); assert.deepEqual(output[1][1], ['transfer']);
  for (const input of [null, {}, { ...valid, protocol: 'bad' }, { ...valid, version: 2 }, { ...valid, sessionId: 'other' },
    { ...valid, nonce: 'other' }, { ...valid, sequence: 0 }, { ...valid, sequence: 1.5 }, { ...valid, type: 4 }, { ...valid, payload: [] }]) assert.equal(peer.receive(input), false);
  assert.equal(peer.receive(valid), true); assert.equal(peer.receive(valid), false);
  assert.equal(peer.receive({ ...valid, sequence: 3 }), false);
  assert.equal(errors.at(-1), 'ERR_GATEWAY_SEQUENCE');
  assert.equal(peer.receive({ ...valid, sequence: 2 }), false); peer.send('ignored'); assert.equal(output.length, 2);
});

function parse(parts, options = {}) {
  const events = [];
  const parser = createGatewayHttpParser({ ...options, onStart: value => events.push(['start', value]),
    onChunk: bytes => events.push(['chunk', decode(bytes)]), onEnd: () => events.push(['end']) });
  for (const part of parts) parser.write(typeof part === 'string' ? encode(part) : part);
  return { events, parser };
}

test('HTTP parser streams fixed length and chunked responses across every possible byte split', () => {
  for (const response of [
    'HTTP/1.1 200 OK\r\nContent-Length: 5\r\nX-Test: yes\r\n\r\nhello',
    'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2;x=y\r\nhe\r\n3\r\nllo\r\n0\r\nX-Trailer: ignored\r\n\r\n',
  ]) {
    for (let split = 0; split <= response.length; split++) {
      const { events, parser } = parse([response.slice(0, split), response.slice(split)]);
      parser.end(); parser.write(encode('ignored')); parser.end();
      assert.equal(events[0][0], 'start'); assert.equal(events.at(-1)[0], 'end');
      assert.equal(events.filter(e => e[0] === 'chunk').map(e => e[1]).join(''), 'hello');
      assert.equal(events.filter(e => e[0] === 'end').length, 1);
    }
  }
  const partial = parse(['HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nh']);
  assert.equal(partial.events[1][1], 'h');
  partial.parser.write(encode('ello')); assert.equal(partial.events.at(-1)[0], 'end');
});

test('HTTP EOF, HEAD and bodyless statuses complete without waiting for nonexistent bodies', () => {
  const eof = parse(['HTTP/1.0 200\r\nX-A: one\r\nX-A: two\r\nSet-Cookie: secret\r\nConnection: x-private\r\nX-Private: secret\r\n\r\nhi']);
  assert.equal(eof.events.at(-1)[0], 'chunk'); eof.parser.end();
  assert.equal(eof.events.at(-1)[0], 'end'); assert.equal(eof.events[0][1].headers['x-a'], 'one, two');
  assert.equal(eof.events[0][1].headers['set-cookie'], undefined); assert.equal(eof.events[0][1].headers['x-private'], undefined);
  for (const status of [204, 205, 304]) assert.equal(parse([`HTTP/1.1 ${status} Empty\r\n\r\n`]).events.at(-1)[0], 'end');
  assert.equal(parse(['HTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\n'], { method: 'HEAD', maxBodyBytes: 2 }).events.at(-1)[0], 'end');
  assert.equal(parse(['HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n']).events.at(-1)[0], 'end');
});

test('HTTP framing rejects ambiguity, malformed/truncated data and resource exhaustion', () => {
  for (const raw of ['nonsense\r\n\r\n', 'HTTP/1.1 999 Bad\r\n\r\n', 'HTTP/1.1 101 Upgrade\r\n\r\n',
    'HTTP/1.1 200 OK\r\ninvalid\r\n\r\n', 'HTTP/1.1 200 OK\r\nX-A: bad\x01\r\n\r\n',
    'HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n', 'HTTP/1.1 200 OK\r\nContent-Length: invalid\r\n\r\n',
    'HTTP/1.1 200 OK\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nz\r\n',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\naXX',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\ninvalid\r\n',
    'x'.repeat(32769), `HTTP/1.1 200 OK\r\nX-A: ${'a'.repeat(32769)}\r\n\r\n`,
    `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${'a'.repeat(8193)}`,
    `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n${'X-A: x\r\n'.repeat(5000)}`]) {
    assert.throws(() => parse([raw]), code('ERR_GATEWAY_PROTOCOL'));
  }
  for (const raw of ['HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n',
    'HTTP/1.1 200 OK\r\n\r\nabc', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\n']) {
    assert.throws(() => parse([raw], { maxBodyBytes: 2 }), code('ERR_GATEWAY_BODY_LIMIT'));
  }
  for (const raw of ['', 'HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\na']) assert.throws(() => parse([raw]).parser.end(), code('ERR_GATEWAY_PROTOCOL'));
});

test('virtual HTTP socket cleanup covers success, errors, cancellation and synchronous connect failures', async () => {
  function network(response, fail = false) {
    const socket = new EventEmitter(); socket.written = [];
    socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
    socket.write = bytes => { socket.written.push(decode(bytes)); if (socket.written.length === 1) queueMicrotask(() => {
      if (fail) socket.emit('error', new Error('refused'));
      else if (response != null) { socket.emit('data', encode(response)); socket.emit('end'); }
    }); };
    return { socket, connect: () => socket };
  }
  const request = { method: 'POST', path: '/api?q=1#fragment', headers: { 'x-test': 'yes' }, body: encode('body') };
  const net = network('HTTP/1.1 200 OK\r\n\r\nhello'); const chunks = [];
  await openGatewayHttp({ net, port: 3000, request, onStart() {}, onChunk: bytes => chunks.push(decode(bytes)) });
  assert.deepEqual(chunks, ['hello']); assert.ok(net.socket.destroyed);
  assert.match(net.socket.written[0], /^POST \/api\?q=1 HTTP\/1.1/); assert.equal(net.socket.written[1], 'body');
  for (const broken of [network(null, true), { connect() { throw new Error('broken'); } }, network('bad')]) {
    await assert.rejects(openGatewayHttp({ net: broken, port: 3000, request, onStart() {}, onChunk() {} }));
  }
  const abort = new AbortController(); const hanging = network(null);
  const waiting = openGatewayHttp({ net: hanging, port: 3000, request, signal: abort.signal, onStart() {}, onChunk() {} });
  abort.abort(new Error('cancel')); await assert.rejects(waiting, /cancel/); assert.ok(hanging.socket.destroyed);
  await assert.rejects(openGatewayHttp({ net: hanging, port: 3000, request, signal: abort.signal }), /cancel/);
});

test('virtual-only gateway sockets cannot fall through to an egress proxy', async () => {
  let calls = 0;
  const network = createVirtualNetwork({ transport: { connect() { calls++; } } });
  await new Promise(resolve => network.connectTcp({ address: '127.0.0.1', port: 3000, virtualOnly: true,
    onConnected: () => assert.fail('must not connect'), onError: error => { assert.equal(error.code, 'ECONNREFUSED'); resolve(); } }));
  assert.equal(calls, 0);
});

test('Blob owners revoke exactly once and cannot create resources after close', () => {
  const revoked = []; const created = [];
  const owner = createBlobOwner({ Blob, URL: { createObjectURL(blob) { created.push(blob); return `blob:${created.length}`; }, revokeObjectURL(url) { revoked.push(url); } } });
  assert.equal(owner.create('one', 'text/plain'), 'blob:1'); owner.create('two', 'text/css'); assert.equal(owner.size, 2);
  owner.close(); owner.close(); assert.deepEqual(revoked, ['blob:1', 'blob:2']); assert.equal(owner.size, 0);
  assert.throws(() => owner.create('', ''), code('ERR_GATEWAY_CLOSED'));
});

test('CSS URLs, imports and fragments are rewritten recursively without touching comments', async () => {
  const calls = [];
  const result = await rewriteCss(`/* url(secret) */ @import 'base.css' screen; @import url("other.css"); .x{background:url(../img.png?q=1);mask:url(#mask)}`, async (url, kind) => { calls.push([url, kind]); return `blob:${calls.length}`; });
  assert.match(result, /\/\* url\(secret\) \*\//); assert.match(result, /@import url\("blob:1"\) screen/); assert.match(result, /url\("#mask"\)/);
  assert.deepEqual(calls, [['base.css', 'css'], ['other.css', 'css'], ['../img.png?q=1', 'asset']]);
  for (const css of ['a{background:u\\72l(x)}', 'a{background:image-set("x" 1x)}', 'a{background:src("x")}']) await assert.rejects(rewriteCss(css, () => ''), code('ERR_GATEWAY_RESOURCE_UNSUPPORTED'));
});

test('module specifiers and import.meta.url rewrite without changing comments or strings', async () => {
  const source = `// import 'not-real'\nconst text="from './ignored'"; import './one.js'; import { x } from './two.js'; export { x } from './three.js'; const lazy=import('./four.js'); const url=import.meta.url;`;
  const calls = [];
  const output = await rewriteModule(source, async value => { calls.push(value); return `blob:${calls.length}`; }, 'http://localhost:3000/app.js');
  assert.deepEqual(calls, ['./one.js', './two.js', './three.js', './four.js']);
  assert.match(output, /const text="from '\.\/ignored'"/); assert.match(output, /url="http:\/\/localhost:3000\/app.js"/);
  await assert.rejects(rewriteModule('import(variable)', async () => '', '/'), code('ERR_GATEWAY_RESOURCE_UNSUPPORTED'));
  assert.ok(bootstrapDocument('<h1>content</h1>').indexOf('nacelle-direct-gateway') < bootstrapDocument('<h1>content</h1>').indexOf('<h1>content'));
});

test('Service Worker and direct adapters share HTTP framing without changing worker response messages', async () => {
  const { installGatewayBridge } = await import('../../../../src/runtime/gateway-bridge.js');
  const { EventEmitter } = await import('node:events');
  const events = new EventTarget();
  const windows = new EventTarget();
  const scope = { navigator: { serviceWorker: events }, location: { origin: 'https://host.test' },
    addEventListener: windows.addEventListener.bind(windows), removeEventListener: windows.removeEventListener.bind(windows) };
  const sockets = [];
  const net = { connect() {
    const socket = new EventEmitter();socket.destroy=()=>{socket.destroyed=true};
    socket.write=()=>queueMicrotask(()=>{
      const response='HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n3\r\none\r\n3\r\ntwo\r\n0\r\n\r\n';
      for(const byte of new TextEncoder().encode(response))socket.emit('data',new Uint8Array([byte]));
    });sockets.push(socket);return socket;
  } };
  const close=installGatewayBridge({net,globalObject:scope});const messages=[];
  const event = new Event('message');Object.assign(event,{data:{type:'bnh-vnet-request',port:3000,method:'GET',url:'/'},ports:[{postMessage:message=>messages.push(message),start(){},close(){}}]});events.dispatchEvent(event);
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(messages[0].type,'bnh-vnet-response-start');assert.equal(messages[0].statusCode,200);assert.deepEqual(messages[0].headers['set-cookie'],['a=1','b=2']);
  assert.equal(messages.filter(message=>message.type==='bnh-vnet-response-chunk').map(message=>new TextDecoder().decode(message.chunk)).join(''),'onetwo');
  assert.equal(messages.at(-1).type,'bnh-vnet-response-end');assert.ok(sockets[0].destroyed);
  const second=installGatewayBridge({net:{connect(){throw new Error('second fixture')}},globalObject:scope});second();assert.equal(scope.__bnhActiveGatewayNet,net);
  close();close();assert.equal(scope.__bnhGatewayBridgeInstalled,false);assert.equal(scope.__bnhActiveGatewayNet,null);
  const restart=installGatewayBridge({net,globalObject:scope});assert.equal(scope.__bnhGatewayBridgeInstalled,true);restart();
});
