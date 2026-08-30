import { decompress, compress } from './compression.js';

const BLOCK_SIZE = 512;

function decodeNullTerminatedString(bytes, offset, length, encoding = 'utf-8') {
  let end = offset;
  const max = offset + length;
  while (end < max && bytes[end] !== 0) end += 1;
  return new TextDecoder(encoding).decode(bytes.subarray(offset, end));
}

function parseOctal(bytes, offset, length) {
  const str = decodeNullTerminatedString(bytes, offset, length).trim();
  if (!str) return 0;
  const val = parseInt(str, 8);
  return Number.isNaN(val) ? 0 : val;
}

function parsePaxHeader(paxBytes) {
  const text = new TextDecoder('utf-8').decode(paxBytes);
  const metadata = {};
  let offset = 0;
  while (offset < text.length) {
    const spaceIndex = text.indexOf(' ', offset);
    if (spaceIndex === -1) break;
    const length = parseInt(text.slice(offset, spaceIndex), 10);
    if (Number.isNaN(length) || length <= 0) break;
    const line = text.slice(spaceIndex + 1, offset + length);
    const equalIndex = line.indexOf('=');
    if (equalIndex !== -1) {
      const key = line.slice(0, equalIndex);
      let value = line.slice(equalIndex + 1);
      if (value.endsWith('\n')) value = value.slice(0, -1);
      metadata[key] = value;
    }
    offset += length;
  }
  return metadata;
}

export function unpackTar(tarBytes, { stripPrefix = 'package/', targetDir = '' } = {}) {
  const entries = [];
  const bytes = tarBytes instanceof Uint8Array ? tarBytes : new Uint8Array(tarBytes);
  let offset = 0;
  let nextOverrideName = null;
  let globalPax = {};

  while (offset + BLOCK_SIZE <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + BLOCK_SIZE);
    // Check for two consecutive empty blocks (end of archive)
    let isAllZero = true;
    for (let i = 0; i < BLOCK_SIZE; i += 1) {
      if (header[i] !== 0) {
        isAllZero = false;
        break;
      }
    }
    if (isAllZero) {
      offset += BLOCK_SIZE;
      continue;
    }

    let name = decodeNullTerminatedString(header, 0, 100);
    const mode = parseOctal(header, 100, 8);
    const size = parseOctal(header, 124, 12);
    const mtime = parseOctal(header, 136, 12);
    const typeflag = String.fromCharCode(header[156] || 48); // default '0'
    const magic = decodeNullTerminatedString(header, 257, 6);
    const prefix = magic.startsWith('ustar') ? decodeNullTerminatedString(header, 345, 155) : '';

    if (prefix) {
      name = `${prefix}/${name}`;
    }

    offset += BLOCK_SIZE;
    const dataBlocks = Math.ceil(size / BLOCK_SIZE);
    const dataEnd = offset + size;
    const content = bytes.subarray(offset, dataEnd);
    offset += dataBlocks * BLOCK_SIZE;

    // GNU long filename
    if (typeflag === 'L') {
      nextOverrideName = decodeNullTerminatedString(content, 0, content.byteLength);
      continue;
    }

    // PAX extended header
    if (typeflag === 'x') {
      const pax = parsePaxHeader(content);
      if (pax.path) nextOverrideName = pax.path;
      continue;
    }

    if (typeflag === 'g') {
      globalPax = parsePaxHeader(content);
      continue;
    }

    if (nextOverrideName) {
      name = nextOverrideName;
      nextOverrideName = null;
    }

    let normalizedName = name.replace(/\\/g, '/');
    if (stripPrefix && normalizedName.startsWith(stripPrefix)) {
      normalizedName = normalizedName.slice(stripPrefix.length);
    }
    normalizedName = normalizedName.replace(/^\/+/, '');
    if (!normalizedName) continue;

    const fullPath = targetDir
      ? (targetDir.endsWith('/') ? `${targetDir}${normalizedName}` : `${targetDir}/${normalizedName}`)
      : normalizedName;

    const isDir = typeflag === '5' || normalizedName.endsWith('/');
    entries.push({
      path: fullPath,
      name: normalizedName,
      type: isDir ? 'directory' : 'file',
      size: isDir ? 0 : size,
      mode,
      mtime,
      data: isDir ? null : content.slice(),
    });
  }

  return entries;
}

export async function decompressGzipBytes(tarGzBytes, globalObject = globalThis) {
  const bytes = tarGzBytes instanceof Uint8Array ? tarGzBytes : new Uint8Array(tarGzBytes);
  // Check gzip magic bytes (0x1f, 0x8b)
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      return await decompress(bytes, 'gzip', globalObject);
    } catch {
      // If DecompressionStream fails, fallback to Node zlib if present
      if (typeof process !== 'undefined' && process.versions?.node) {
        const { gunzipSync } = await import('node:zlib');
        return new Uint8Array(gunzipSync(bytes));
      }
      throw new Error('Failed to decompress gzip archive');
    }
  }
  return bytes;
}

export async function unpackTarGz(tarGzBytes, options = {}, globalObject = globalThis) {
  const tarBytes = await decompressGzipBytes(tarGzBytes, globalObject);
  return unpackTar(tarBytes, options);
}

export function packTar(entries) {
  let totalBlocks = 0;
  for (const entry of entries) {
    totalBlocks += 1; // header
    if (entry.data) {
      totalBlocks += Math.ceil(entry.data.byteLength / BLOCK_SIZE);
    }
  }
  totalBlocks += 2; // two zero blocks at end

  const output = new Uint8Array(totalBlocks * BLOCK_SIZE);
  let offset = 0;

  for (const entry of entries) {
    const header = output.subarray(offset, offset + BLOCK_SIZE);
    const nameBytes = new TextEncoder().encode(entry.path);
    header.set(nameBytes.subarray(0, 100), 0);

    const modeStr = (entry.mode || (entry.type === 'directory' ? 0o755 : 0o644)).toString(8).padStart(7, '0') + '\0';
    header.set(new TextEncoder().encode(modeStr), 100);

    const uidStr = '0000000\0';
    header.set(new TextEncoder().encode(uidStr), 108);
    const gidStr = '0000000\0';
    header.set(new TextEncoder().encode(gidStr), 116);

    const size = entry.data ? entry.data.byteLength : 0;
    const sizeStr = size.toString(8).padStart(11, '0') + '\0';
    header.set(new TextEncoder().encode(sizeStr), 124);

    const mtimeStr = Math.floor((entry.mtime || Date.now()) / 1000).toString(8).padStart(11, '0') + '\0';
    header.set(new TextEncoder().encode(mtimeStr), 136);

    // typeflag
    header[156] = entry.type === 'directory' ? 53 : 48; // '5' or '0'

    // magic "ustar\0"
    header.set(new TextEncoder().encode('ustar\0'), 257);
    header.set(new TextEncoder().encode('00'), 263);

    // compute checksum
    // header[148..156] are treated as 8 spaces (32)
    for (let i = 148; i < 156; i += 1) header[i] = 32;
    let chksum = 0;
    for (let i = 0; i < BLOCK_SIZE; i += 1) chksum += header[i];
    const chksumStr = chksum.toString(8).padStart(6, '0') + '\0 ';
    header.set(new TextEncoder().encode(chksumStr), 148);

    offset += BLOCK_SIZE;

    if (entry.data && entry.data.byteLength > 0) {
      output.set(entry.data, offset);
      offset += Math.ceil(entry.data.byteLength / BLOCK_SIZE) * BLOCK_SIZE;
    }
  }

  return output;
}

export async function packTarGz(entries, globalObject = globalThis) {
  const tarBytes = packTar(entries);
  try {
    return await compress(tarBytes, 'gzip', globalObject);
  } catch {
    if (typeof process !== 'undefined' && process.versions?.node) {
      const { gzipSync } = await import('node:zlib');
      return new Uint8Array(gzipSync(tarBytes));
    }
    throw new Error('Failed to compress gzip archive');
  }
}
