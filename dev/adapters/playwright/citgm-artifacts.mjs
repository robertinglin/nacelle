import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CITGM_ARTIFACT_SCHEMA_VERSION = 1;
export const CITGM_ARTIFACT_ROOT = '/tmp/nacelle-citgm-results';

function asText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return String(value);
}

function jsonText(value) {
  return JSON.stringify(value, (_key, childValue) => (
    typeof childValue === 'bigint' ? `${childValue}n` : childValue
  ));
}

function jsonLine(value) {
  return `${jsonText(value)}\n`;
}

function boundedLine(value, maxLength = 600) {
  const line = String(value)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    // Terminal summaries are safe-to-log metadata. Complete URLs remain in
    // the stream/trace artifacts, but must not leak into bounded excerpts.
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[url]')
    .trim();
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}

export function extractFailureExcerpts(value, { maxLines = 12, maxLength = 600 } = {}) {
  const lines = asText(value).split(/\r?\n/);
  const matches = lines.filter((line) => /\b(?:not ok|error|failed|failure|exception|uncaught|timed? ?out|timeout|unsupported|assert(?:ion)?error)\b/i.test(line));
  return matches.slice(0, maxLines).map((line) => boundedLine(line, maxLength)).filter(Boolean);
}

function byteCount(value) {
  return new TextEncoder().encode(asText(value)).byteLength;
}

const MAX_INLINE_STRING_LENGTH = 240;

function compactString(value) {
  if (value.length <= MAX_INLINE_STRING_LENGTH) return value;
  return {
    bytes: byteCount(value),
    excerpt: boundedLine(value, MAX_INLINE_STRING_LENGTH),
  };
}

function boundedArrayMetadata(value, key) {
  if (value === null || value === undefined) return value;
  if (value instanceof Uint8Array
    || value instanceof ArrayBuffer
    || ArrayBuffer.isView(value)) {
    return { type: value.constructor?.name || 'ArrayBufferView', bytes: value.byteLength };
  }
  if (typeof value === 'string') {
    // Lifecycle labels are useful and bounded; arbitrary strings may be URLs
    // or payloads, so retain only their shape outside that narrow metadata.
    return /lifecycle/i.test(String(key))
      ? boundedLine(value, 120)
      : { type: 'string', length: value.length };
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return { type: 'array', count: value.length };
  if (typeof value !== 'object') return { type: typeof value };

  const metadata = {};
  const safeKeys = [
    'event', 'phase', 'stage', 'type', 'stream', 'code', 'signal', 'reason',
    'name', 'status', 'outcome', 'state', 'childActive', 'bytes', 'chunks',
  ];
  for (const safeKey of safeKeys) {
    const child = value[safeKey];
    if (child === null || typeof child === 'string' || typeof child === 'number'
      || typeof child === 'boolean') {
      metadata[safeKey] = typeof child === 'string' ? boundedLine(child, 120) : child;
    }
  }
  return Object.keys(metadata).length ? metadata : { type: value.constructor?.name || 'object' };
}

function compactError(value, artifacts, counts, traceKind) {
  const result = { type: value.name || 'Error' };
  const safeKeys = ['name', 'code', 'message', 'stack', 'reason', 'signal'];
  for (const childKey of safeKeys) {
    if (value[childKey] !== undefined) {
      result[childKey] = compactValue(value[childKey], childKey, artifacts, counts, traceKind);
    }
  }
  if (value.cause !== undefined) {
    result.cause = compactValue(value.cause, 'cause', artifacts, counts, traceKind);
  }
  result.fieldCount = Object.keys(value).length;
  return result;
}

function compactArray(value, key, artifacts, traceKind) {
  const reference = traceKind ? artifacts[traceKind] : artifacts.runResult;
  const result = {
    count: value.length,
    artifact: reference,
  };
  if (value.length) result.first = boundedArrayMetadata(value[0], key);
  if (value.length > 1) result.last = boundedArrayMetadata(value[value.length - 1], key);
  return result;
}

function compactValue(value, key, artifacts, counts, traceKind = null) {
  const keyText = String(key).toLowerCase();
  const childTraceKind = keyText.includes('network') ? 'network'
    : keyText.includes('progress') || keyText.includes('trace') ? 'progress' : traceKind;
  if (typeof value === 'string') return compactString(value);
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return { bytes: value.byteLength };
  if (value && typeof value === 'object' && ArrayBuffer.isView(value)) return { bytes: value.byteLength };
  if (Array.isArray(value)) return compactArray(value, key, artifacts, childTraceKind);
  if (value && typeof value === 'object') {
    if (value instanceof Error || /(?:error|exception|failure)/i.test(String(key))) {
      return compactError(value, artifacts, counts, childTraceKind);
    }
    const result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (/^(?:stdout|stderr)$/i.test(childKey)) {
        const stream = childKey.toLowerCase();
        result[childKey] = { bytes: counts[stream].bytes, chunks: counts[stream].chunks, artifact: artifacts[stream] };
      } else {
        result[childKey] = compactValue(childValue, childKey, artifacts, counts, childTraceKind);
      }
    }
    return result;
  }
  return value;
}

export function compactRunResult(runResult, artifacts, counts, traceCounts = {}) {
  if (!runResult || typeof runResult !== 'object') return runResult || null;
  const compacted = compactValue(runResult, '', artifacts, counts);
  if (compacted && typeof compacted === 'object') {
    if (compacted.networkEvents && typeof compacted.networkEvents === 'object') {
      compacted.networkEvents = { count: traceCounts.network || 0, artifact: artifacts.network };
    }
    if (compacted.progressEvents && typeof compacted.progressEvents === 'object') {
      compacted.progressEvents = { count: traceCounts.progress || 0, artifact: artifacts.progress };
    }
  }
  return compacted;
}

export function createTerminalSummary({
  runId,
  result,
  stage,
  artifacts,
  progressEvents = [],
  networkEvents = [],
  outputCounts,
}) {
  const stdout = asText(result?.stdout);
  const stderr = asText(result?.stderr);
  const counts = outputCounts || {
    stdout: { bytes: byteCount(stdout), chunks: stdout ? 1 : 0 },
    stderr: { bytes: byteCount(stderr), chunks: stderr ? 1 : 0 },
  };
  const exit = result?.runResult?.exit || {
    code: result?.exitCode ?? null,
    signal: null,
    reason: result?.timedOut ? 'timeout' : 'exit',
  };
  return {
    schemaVersion: CITGM_ARTIFACT_SCHEMA_VERSION,
    type: 'citgm-terminal',
    runId: String(runId || result?.runResult?.runId || ''),
    exit: {
      code: exit.code ?? result?.exitCode ?? null,
      signal: exit.signal ?? null,
      reason: exit.reason || (result?.timedOut ? 'timeout' : 'exit'),
    },
    timedOut: Boolean(result?.timedOut),
    error: result?.error || result?.runResult?.error || null,
    stage: String(stage || 'unknown'),
    output: {
      stdoutBytes: counts.stdout.bytes,
      stdoutChunks: counts.stdout.chunks,
      stderrBytes: counts.stderr.bytes,
      stderrChunks: counts.stderr.chunks,
      totalBytes: counts.stdout.bytes + counts.stderr.bytes,
      totalChunks: counts.stdout.chunks + counts.stderr.chunks,
    },
    progressEvents: progressEvents.length,
    networkEvents: networkEvents.length,
    artifacts,
    failureExcerpts: {
      stdout: extractFailureExcerpts(stdout),
      stderr: extractFailureExcerpts(stderr),
    },
  };
}

export async function persistTerminalSummary(artifacts, summary) {
  if (!artifacts?.terminalSummary) throw new TypeError('terminal summary artifact path is required');
  await writeFile(artifacts.terminalSummary, jsonText(summary), 'utf8');
  return artifacts.terminalSummary;
}

export async function persistCitgmArtifacts({
  root = CITGM_ARTIFACT_ROOT,
  runId,
  stdout = '',
  stderr = '',
  progressEvents = [],
  networkEvents = [],
  runResult = null,
  metadata = {},
}) {
  const directory = path.resolve(root, String(runId));
  await mkdir(directory, { recursive: true });
  const artifacts = {
    directory,
    stdout: path.join(directory, 'stdout.log'),
    stderr: path.join(directory, 'stderr.log'),
    progress: path.join(directory, 'progress.jsonl'),
    network: path.join(directory, 'network.jsonl'),
    runResult: path.join(directory, 'run-result.json'),
    metadata: path.join(directory, 'metadata.json'),
    terminalSummary: path.join(directory, 'terminal-summary.json'),
  };
  await Promise.all([
    writeFile(artifacts.stdout, asText(stdout), 'utf8'),
    writeFile(artifacts.stderr, asText(stderr), 'utf8'),
    writeFile(artifacts.progress, progressEvents.map(jsonLine).join(''), 'utf8'),
    writeFile(artifacts.network, networkEvents.map(jsonLine).join(''), 'utf8'),
    writeFile(artifacts.runResult, jsonText(runResult || null), 'utf8'),
    writeFile(artifacts.metadata, jsonText({
      schemaVersion: CITGM_ARTIFACT_SCHEMA_VERSION,
      runId: String(runId),
      ...metadata,
    }), 'utf8'),
  ]);
  return artifacts;
}
