import assert from 'node:assert/strict';
import test from 'node:test';
import { Nacelle, createProxyConfig } from '../../../../src/index.js';

test('createProxyConfig normalizes proxy URLs and NO_PROXY values', () => {
  const config = createProxyConfig({
    url: 'http://proxy.example.test:8080',
    noProxy: ['localhost', '.internal', '127.0.0.1:3000'],
  });

  assert.equal(config.env.http_proxy, 'http://proxy.example.test:8080/');
  assert.equal(config.env.HTTP_PROXY, 'http://proxy.example.test:8080/');
  assert.equal(config.env.https_proxy, 'http://proxy.example.test:8080/');
  assert.equal(config.env.HTTPS_PROXY, 'http://proxy.example.test:8080/');
  assert.equal(config.env.NO_PROXY, 'localhost,.internal,127.0.0.1:3000');
  assert.equal(config.env.NODE_USE_ENV_PROXY, '1');
  assert.equal(config.enabled, false);
  assert.equal(config.mode, 'virtual');
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.env), true);
});

test('createProxyConfig rejects unsupported proxy URLs before runtime startup', () => {
  assert.throws(
    () => createProxyConfig({ httpProxy: 'javascript:alert(1)' }),
    { code: 'ERR_PROXY_INVALID_CONFIG' },
  );
  assert.throws(
    () => createProxyConfig({ httpProxy: 'http://proxy.example.test:99999' }),
    { code: 'ERR_PROXY_INVALID_CONFIG' },
  );
  assert.throws(
    () => createProxyConfig({ env: 'HTTP_PROXY=http://proxy.example.test:8080' }),
    { name: 'TypeError' },
  );
  assert.equal(createProxyConfig({ noProxy: '' }).env.NO_PROXY, '');
});

test('native Node HTTP APIs use createProxyConfig for a real virtual proxy server', async () => {
  const node = await Nacelle.create({
    gateway: false,
    proxy: createProxyConfig({ httpProxy: 'http://127.0.0.1:3128' }),
  });
  const child = await node.execute(`
    const http = require('node:http');
    const target = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'x-target': 'native' });
      response.end('target:' + request.url);
    });
    const proxy = http.createServer((request, response) => {
      const savedProxyFlag = process.env.NODE_USE_ENV_PROXY;
      process.env.NODE_USE_ENV_PROXY = '0';
      http.get(request.url, (upstream) => {
        const chunks = [];
        upstream.on('data', (chunk) => chunks.push(chunk));
        upstream.on('end', () => {
          response.writeHead(upstream.statusCode, { ...upstream.headers, 'x-via-proxy': 'yes' });
          response.end(Buffer.concat(chunks));
          if (savedProxyFlag === undefined) delete process.env.NODE_USE_ENV_PROXY;
          else process.env.NODE_USE_ENV_PROXY = savedProxyFlag;
        });
      }).on('error', (error) => {
        response.writeHead(502);
        response.end(error.message);
        if (savedProxyFlag === undefined) delete process.env.NODE_USE_ENV_PROXY;
        else process.env.NODE_USE_ENV_PROXY = savedProxyFlag;
      });
    });
    target.listen(3129, '127.0.0.1', () => proxy.listen(3128, '127.0.0.1', () => {
      http.get('http://127.0.0.1:3129/demo', (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          process.stdout.write(response.statusCode + ':' + response.headers['x-target'] + ':' + response.headers['x-via-proxy'] + ':' + body);
          proxy.close();
          target.close();
        });
      }).on('error', (error) => {
        console.error(error);
        process.exitCode = 1;
      });
    }));
  `);

  assert.equal(await child.exit, 0);
  assert.equal(await child.stdoutText(), '200:native:yes:target:/demo');
});
