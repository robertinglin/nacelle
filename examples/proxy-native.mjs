import { Nacelle, createProxyConfig } from '../src/index.js';

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
    const restoreProxyFlag = () => {
      if (savedProxyFlag === undefined) delete process.env.NODE_USE_ENV_PROXY;
      else process.env.NODE_USE_ENV_PROXY = savedProxyFlag;
    };
    http.get(request.url, (upstream) => {
      const chunks = [];
      upstream.on('data', (chunk) => chunks.push(chunk));
      upstream.on('end', () => {
        response.writeHead(upstream.statusCode, { ...upstream.headers, 'x-via-proxy': 'yes' });
        response.end(Buffer.concat(chunks));
        restoreProxyFlag();
      });
    }).on('error', (error) => {
      response.writeHead(502);
      response.end(error.message);
      restoreProxyFlag();
    });
  });

  target.listen(3129, '127.0.0.1', () => proxy.listen(3128, '127.0.0.1', () => {
    http.get('http://127.0.0.1:3129/demo', (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        process.stdout.write(JSON.stringify({
          status: response.statusCode,
          target: response.headers['x-target'],
          viaProxy: response.headers['x-via-proxy'],
          body,
          proxy: process.env.HTTP_PROXY,
        }));
        proxy.close();
        target.close();
      });
    }).on('error', (error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }));
`);

const code = await child.exit;
process.stdout.write(`${await child.stdoutText()}\n`);
if (code !== 0) process.stderr.write(await child.stderrText());
process.exitCode = code;
