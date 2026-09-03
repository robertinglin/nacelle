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
    const captured = asText(result[name]);
    const metadata = resultOutput[name] || {};
    const progressChunks = progressOutput[`${name}Chunks`];
    const chunks = Number.isSafeInteger(metadata.chunks)
      ? metadata.chunks
      : Number.isSafeInteger(progressChunks) ? progressChunks : captured ? 1 : 0;
    return { bytes: Buffer.byteLength(captured, 'utf8'), chunks };
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
    summary: path.join(directory, 'summary.json'),
  };
  const progressStream = createWriteStream(paths.progress, { encoding: 'utf8' });
  const networkStream = createWriteStream(paths.network, { encoding: 'utf8' });
  let closed = false;

  return {
    paths,
    recordProgress(event) {
      if (!closed) writeJsonLine(progressStream, event);
    },
    async close({ stdout = '', stderr = '', networkEvents = [], summary = null } = {}) {
      if (closed) return paths;
      closed = true;
      for (const event of networkEvents) writeJsonLine(networkStream, event);
      await Promise.all([
        writeFile(paths.stdout, asText(stdout), 'utf8'),
        writeFile(paths.stderr, asText(stderr), 'utf8'),
        writeFile(paths.summary, JSON.stringify(summary, null, 2), 'utf8'),
        finishStream(progressStream),
        finishStream(networkStream),
      ]);
      return paths;
    },
  };
}
