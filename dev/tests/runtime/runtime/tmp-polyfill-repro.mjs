// TEMP-DIAG: boot `next dev` like the demo and capture the ENOENT. Not in suite.
import { Nacelle } from '../../../../src/index.js';

const node = await Nacelle.create({ gateway: false, cwd: '/node' });
await node.fs.writeFile('/node/package.json', JSON.stringify({
  name: 'repro', private: true,
  scripts: { dev: 'next dev --webpack' },
  dependencies: { next: '16.3.3', react: '19.2.8', 'react-dom': '19.2.8' },
}));
await node.fs.writeFile('/node/app/page.tsx', 'export default function Page() { return null; }');
await node.npm.install();

const child = await node.npm.run('dev', {});
const timer = setTimeout(() => { child.kill?.(); }, 25000);
const exit = await child.exit;
clearTimeout(timer);
const out = await child.stdoutText();
const err = await child.stderrText();
console.log('exit:', exit);
console.log('--- stdout (last 1200):', out.slice(-1200));
console.log('--- stderr (last 1200):', err.slice(-1200));
process.exit(0);
