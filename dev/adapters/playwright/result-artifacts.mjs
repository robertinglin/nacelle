import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_EXCERPT_BYTES = 4096;
const MAX_SUMMARY_STRING = 512;

function safeSegment(value, fallback = 'run') {
  const segment = String(value || fallback).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
  return segment || fallback;
}

function asText(value) {
  return typeof value === 'string' ? value : String(value ?? '');
}

function asBytes(value, fallback = '') {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return Uint8Array.from(value);
  }
  return new TextEncoder().encode(asText(value ?? fallback));
}

function jsonReplacer() {
  const seen = new WeakSet();
  return (_key, value) => {
    if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
      const bytes = value instanceof Uint8Array
        ? value
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      let binary = '';
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      return {
        type: 'bytes',
        byteLength: bytes.byteLength,
        encoding: 'base64',
        data: typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64'),
      };
    }
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  };
}

export function compactForSummary(value, depth = 0) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, MAX_SUMMARY_STRING);
  if (ArrayBuffer.isView(value)) return { bytes: value.byteLength };
  if (value instanceof ArrayBuffer) return { bytes: value.byteLength };
  if (depth >= 4) return '[summary depth limit]';
  if (Array.isArray(value)) return { count: value.length };
  if (typeof value !== 'object') return String(value).slice(0, MAX_SUMMARY_STRING);
  return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) => [
    key,
    compactForSummary(item, depth + 1),
  ]));
}

export function outputSummary(result = {}, lastProgressEvent = null) {
  const progressOutput = lastProgressEvent?.counters?.output || {};
  const resultOutput = result.output || {};
  const stream = (name) => {
    const rawBytes = result[`${name}Bytes`];
    const captured = Number.isSafeInteger(rawBytes) ? null : asBytes(rawBytes, result[name]);
    const metadata = resultOutput[name] || {};
    const progressBytes = progressOutput[`${name}Bytes`];
    const bytes = Number.isSafeInteger(rawBytes)
      ? rawBytes
      : Number.isSafeInteger(progressBytes) ? progressBytes : captured.byteLength;
    const progressChunks = progressOutput[`${name}Chunks`];
    const chunks = Number.isSafeInteger(metadata.chunks)
      ? metadata.chunks
      : Number.isSafeInteger(progressChunks) ? progressChunks : captured ? 1 : 0;
    return { bytes, chunks };
  };
  const stdout = stream('stdout');
  const stderr = stream('stderr');
  return {
    stdout,
    stderr,
    totalBytes: stdout.bytes + stderr.bytes,
    totalChunks: stdout.chunks + stderr.chunks,
  };
}

export function failureExcerpt(value, limit = DEFAULT_EXCERPT_BYTES) {
  const source = asText(value);
  const maxBytes = Math.max(1, Number(limit) || DEFAULT_EXCERPT_BYTES);
  const lines = source.split(/\r?\n/)
    .filter((line) => /\b(?:error|fail(?:ed|ure)?|fatal|exception|timeout|signal)\b/i.test(line));
  const selected = lines.length ? lines.join('\n') : source;
  const bytes = Buffer.from(selected, 'utf8');
  if (bytes.byteLength <= maxBytes) return selected;
  return `${bytes.subarray(0, maxBytes).toString('utf8')}\n...[excerpt truncated]`;
}

function writeJsonLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

async function finishStream(stream) {
  if (stream.errored) throw stream.errored;
  if (stream.writableFinished) return;
  const completion = once(stream, 'finish');
  stream.end();
  await completion;
}

export async function createCITGMArtifactWriter({ rootDir, module, runId } = {}) {
  const root = path.resolve(rootDir || path.join(process.cwd(), '.bnh-state', 'citgm-results'));
  const directory = path.join(root, `${safeSegment(runId)}-${safeSegment(module)}`);
  await mkdir(directory, { recursive: true });
  const paths = {
    stdout: path.join(directory, 'stdout.log'),
    stderr: path.join(directory, 'stderr.log'),
    progress: path.join(directory, 'progress.ndjson'),
    network: path.join(directory, 'network.ndjson'),
    runResult: path.join(directory, 'run-result.json'),
    summary: path.join(directory, 'summary.json'),
    terminalSummary: path.join(directory, 'terminal-summary.json'),
  };
  await Promise.all([writeFile(paths.progress, ''), writeFile(paths.network, '')]);
  const progressStream = createWriteStream(paths.progress, { encoding: 'utf8' });
  const networkStream = createWriteStream(paths.network, { encoding: 'utf8' });
  const outputStreams = {
    stdout: createWriteStream(paths.stdout),
    stderr: createWriteStream(paths.stderr),
  };
  const outputWritten = { stdout: false, stderr: false };
  const streams = [progressStream, networkStream, ...Object.values(outputStreams)];
  let streamFailure;
  // Open/write errors may arrive before a caller queues the first write, or
  // after write() returned true. Keep an error observer for the whole lifetime.
  for (const stream of streams) stream.on('error', error => { streamFailure ||= error; });
  let writeChain = Promise.resolve();
  let closed = false;
  const appendBytes = (stream, bytes) => {
    if (closed) return writeChain;
    writeChain = writeChain.then(() => new Promise((resolve, reject) => {
      if (streamFailure) { reject(streamFailure); return; }
      stream.write(bytes, error => error ? reject(error) : resolve());
    }));
    // Callers may intentionally fire-and-forget capture writes. Preserve the
    // rejection for close(), without causing a host unhandled rejection.
    writeChain.catch(() => {});
    return writeChain;
  };
  const append = (stream, value) => appendBytes(stream, `${JSON.stringify(value, jsonReplacer())}\n`);
  const appendOutput = (streamName, value) => {
    const stream = outputStreams[streamName];
    if (!stream || closed) return writeChain;
    outputWritten[streamName] = true;
    return appendBytes(stream, asBytes(value));
  };

  return {
    paths,
    recordProgress(event) {
      return append(progressStream, event);
    },
    recordNetwork(event) {
      return append(networkStream, event);
    },
    recordOutput(stream, value) {
      return appendOutput(stream, value);
    },
    async close({ stdout = '', stderr = '', stdoutBytes, stderrBytes, networkEvents = [], runResult = null, summary = null } = {}) {
      if (closed) return paths;
      for (const event of networkEvents) append(networkStream, event);
      closed = true;
      try {
        await writeChain;
        await Promise.all(streams.map(finishStream));
        if (streamFailure) throw streamFailure;
        // Finish even unused output streams before writing fallbacks: their
        // asynchronous open('w') must not truncate a completed fallback file.
        await Promise.all([
          outputWritten.stdout ? Promise.resolve() : writeFile(paths.stdout, asBytes(stdoutBytes, stdout)),
          outputWritten.stderr ? Promise.resolve() : writeFile(paths.stderr, asBytes(stderrBytes, stderr)),
          writeFile(paths.runResult, `${JSON.stringify(runResult, jsonReplacer(), 2)}\n`, 'utf8'),
          writeFile(paths.summary, `${JSON.stringify(summary, jsonReplacer(), 2)}\n`, 'utf8'),
          writeFile(paths.terminalSummary, `${JSON.stringify(summary, jsonReplacer(), 2)}\n`, 'utf8'),
        ]);
      } finally {
        for (const stream of streams) if (!stream.destroyed) stream.destroy();
      }
      return paths;
    },
  };
}
