export interface ZipArchiveEntryInput {
  path: string;
  data: Uint8Array | string;
}

export interface ZipArchiveOptions {
  mtime?: Date;
}

export interface ZipArchiveEntryOutput {
  path: string;
  data: Uint8Array;
  crc32: number;
}

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;

const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

/** Computes standard IEEE 802.3 CRC-32 checksum over a byte buffer. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function normalizeArchivePath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === "..")) {
    throw new RangeError(`Invalid ZIP archive entry path: "${rawPath}"`);
  }
  return normalized;
}

function encodeDosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = Math.floor(date.getUTCSeconds() / 2);
  const dosTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
  return { dosTime, dosDate };
}

/**
 * Builds an uncompressed (STORE mode, method 0) PKZIP archive in memory with
 * valid CRC-32 checksums and UTF-8 file names.
 */
export function createStoreZipArchive(
  entries: readonly ZipArchiveEntryInput[],
  options: ZipArchiveOptions = {},
): Uint8Array {
  const encoder = new TextEncoder();
  const mtime = options.mtime ?? new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  const { dosTime, dosDate } = encodeDosDateTime(mtime);

  interface PreparedEntry {
    nameBytes: Uint8Array;
    payload: Uint8Array;
    crc: number;
    localOffset: number;
  }

  const prepared: PreparedEntry[] = [];
  const seenPaths = new Set<string>();
  let localSectionBytes = 0;
  let centralDirBytes = 0;

  for (const entry of entries) {
    const cleanPath = normalizeArchivePath(entry.path);
    if (seenPaths.has(cleanPath)) {
      throw new RangeError(`Duplicate ZIP archive entry path: "${cleanPath}"`);
    }
    seenPaths.add(cleanPath);

    const nameBytes = encoder.encode(cleanPath);
    const payload =
      typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const crc = crc32(payload);
    prepared.push({
      nameBytes,
      payload,
      crc,
      localOffset: localSectionBytes,
    });
    localSectionBytes += 30 + nameBytes.length + payload.length;
    centralDirBytes += 46 + nameBytes.length;
  }

  const totalBytes = localSectionBytes + centralDirBytes + 22;
  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer);
  let cursor = 0;

  // Write Local File Headers + payloads.
  for (const item of prepared) {
    view.setUint32(cursor, LOCAL_FILE_HEADER_SIG, true);
    view.setUint16(cursor + 4, 20, true);
    view.setUint16(cursor + 6, UTF8_FLAG, true);
    view.setUint16(cursor + 8, 0, true);
    view.setUint16(cursor + 10, dosTime, true);
    view.setUint16(cursor + 12, dosDate, true);
    view.setUint32(cursor + 14, item.crc, true);
    view.setUint32(cursor + 18, item.payload.length, true);
    view.setUint32(cursor + 22, item.payload.length, true);
    view.setUint16(cursor + 26, item.nameBytes.length, true);
    view.setUint16(cursor + 28, 0, true);
    cursor += 30;

    out.set(item.nameBytes, cursor);
    cursor += item.nameBytes.length;
    out.set(item.payload, cursor);
    cursor += item.payload.length;
  }

  const centralDirOffset = cursor;

  // Write Central Directory File Headers.
  for (const item of prepared) {
    view.setUint32(cursor, CENTRAL_DIR_HEADER_SIG, true);
    view.setUint16(cursor + 4, 20, true);
    view.setUint16(cursor + 6, 20, true);
    view.setUint16(cursor + 8, UTF8_FLAG, true);
    view.setUint16(cursor + 10, 0, true);
    view.setUint16(cursor + 12, dosTime, true);
    view.setUint16(cursor + 14, dosDate, true);
    view.setUint32(cursor + 16, item.crc, true);
    view.setUint32(cursor + 20, item.payload.length, true);
    view.setUint32(cursor + 24, item.payload.length, true);
    view.setUint16(cursor + 28, item.nameBytes.length, true);
    view.setUint16(cursor + 30, 0, true);
    view.setUint16(cursor + 32, 0, true);
    view.setUint16(cursor + 34, 0, true);
    view.setUint16(cursor + 36, 0, true);
    view.setUint32(cursor + 38, 0, true);
    view.setUint32(cursor + 42, item.localOffset, true);
    cursor += 46;

    out.set(item.nameBytes, cursor);
    cursor += item.nameBytes.length;
  }

  // Write End of Central Directory Record.
  view.setUint32(cursor, END_OF_CENTRAL_DIR_SIG, true);
  view.setUint16(cursor + 4, 0, true);
  view.setUint16(cursor + 6, 0, true);
  view.setUint16(cursor + 8, prepared.length, true);
  view.setUint16(cursor + 10, prepared.length, true);
  view.setUint32(cursor + 12, centralDirBytes, true);
  view.setUint32(cursor + 16, centralDirOffset, true);
  view.setUint16(cursor + 20, 0, true);

  return out;
}

/**
 * Reads entries from a STORE-mode ZIP archive and verifies CRC-32 checksums.
 */
export function readStoreZipArchive(bytes: Uint8Array): ZipArchiveEntryOutput[] {
  if (bytes.length < 22) {
    throw new RangeError("Buffer is too short to be a valid ZIP archive");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocdOffset = -1;
  for (let pos = bytes.length - 22; pos >= Math.max(0, bytes.length - 65557); pos -= 1) {
    if (view.getUint32(pos, true) === END_OF_CENTRAL_DIR_SIG) {
      eocdOffset = pos;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error("ZIP End of Central Directory record not found");
  }

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const decoder = new TextDecoder();
  const result: ZipArchiveEntryOutput[] = [];
  let cursor = cdOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (view.getUint32(cursor, true) !== CENTRAL_DIR_HEADER_SIG) {
      throw new Error(`Invalid Central Directory header at offset ${cursor}`);
    }
    const method = view.getUint16(cursor + 10, true);
    if (method !== 0) {
      throw new Error(`Unsupported ZIP compression method ${method}; expected STORE (0)`);
    }
    const expectedCrc = view.getUint32(cursor + 16, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const path = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));
    cursor += 46 + nameLen + extraLen + commentLen;

    if (view.getUint32(localOffset, true) !== LOCAL_FILE_HEADER_SIG) {
      throw new Error(`Invalid Local File Header at offset ${localOffset}`);
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = bytes.slice(dataStart, dataStart + size);
    const actualCrc = crc32(data);
    if (actualCrc !== expectedCrc) {
      throw new Error(
        `CRC-32 mismatch for "${path}": expected ${expectedCrc}, got ${actualCrc}`,
      );
    }
    result.push({ path, data, crc32: actualCrc });
  }

  return result;
}
