import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_EXCERPT_BYTES = 4096;

function safeSegment(value, fallback = 'run') {
  const segment = String(value || fallback).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
  return segment || fallback;
}

function asText(value) {
  return typeof value === 'string' ? value : String(value ?? '');
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
  };
  const progressStream = createWriteStream(paths.progress, { encoding: 'utf8' });
  const networkStream = createWriteStream(paths.network, { encoding: 'utf8' });
  let closed = false;

  return {
    paths,
    recordProgress(event) {
      if (!closed) writeJsonLine(progressStream, event);
    },
    async close({ stdout = '', stderr = '', networkEvents = [] } = {}) {
      if (closed) return paths;
      closed = true;
      for (const event of networkEvents) writeJsonLine(networkStream, event);
      await Promise.all([
        writeFile(paths.stdout, asText(stdout), 'utf8'),
        writeFile(paths.stderr, asText(stderr), 'utf8'),
        finishStream(progressStream),
        finishStream(networkStream),
      ]);
      return paths;
    },
  };
}
