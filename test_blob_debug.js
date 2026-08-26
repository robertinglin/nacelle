const descriptor = { fd: 42, path: '/test' };
class FileBlob extends Blob {
  constructor(...args) {
    super(...args);
    this.kDescriptor = descriptor;
  }
}
const b = new FileBlob(['hello']);
console.log('structuredClone ok:', 'yes');
try { structuredClone(b); } catch (e) { console.log('structuredClone error:', e.name, e.message); }
