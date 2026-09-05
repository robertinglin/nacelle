import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Nacelle } from '../src/index.js';

// Keep the input and command aligned with the browser demo. Package installation
// is outside the timer so cold compiler startup and repeat builds are comparable.
const html = await readFile(new URL('../examples/typescript.html', import.meta.url), 'utf8');
const source = html.match(/interface: `([\s\S]*?)`,/)[1];
const node = await Nacelle.create({ gateway: false, cwd: '/node' });
await node.npm.install('typescript@5.5.4');
await node.fs.writeFile('/node/src/main.ts', source);
await node.fs.writeFile('/node/src/global.d.ts', `
declare function require(name: string): any;
declare var process: any;
declare var Buffer: any;
`);
const samples = [];
for (let run = 0; run < 5; run++) {
  const start = performance.now();
  const child = await node.bash('mkdir -p dist && tsc src/main.ts src/global.d.ts --outDir dist && node dist/main.js && cat dist/result.txt');
  const code = await child.exit;
  const milliseconds = performance.now() - start;
  assert.equal(code, 0, await child.stderrText());
  assert.match(await child.stdoutText(), /Ada Lovelace/);
  samples.push(milliseconds);
  console.log(`${run === 0 ? 'cold' : 'warm'}: ${milliseconds.toFixed(1)} ms`);
}
const warm = samples.slice(1).sort((a, b) => a - b);
console.log(`warm median: ${((warm[1] + warm[2]) / 2).toFixed(1)} ms`);
