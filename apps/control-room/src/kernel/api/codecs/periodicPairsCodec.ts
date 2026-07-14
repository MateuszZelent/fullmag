const MAGIC = "FMPP";
const VERSION = 1;
const HEADER_LEN = 20;

export type DecodedPeriodicPairsStatus =
  | "valid"
  | "invalid"
  | "stale"
  | "unavailable";

export interface DecodedPeriodicFacePair {
  faceA: number;
  faceB: number;
  vertexPairs: Array<[number, number]>;
}

export interface DecodedPeriodicPair {
  facePairs: DecodedPeriodicFacePair[];
  markerA: number;
  markerB: number;
  nodePairs: Array<[number, number]>;
  pairId: string;
}

export interface DecodedPeriodicPairs {
  pairs: DecodedPeriodicPair[];
  revision: number;
  status: DecodedPeriodicPairsStatus;
}

function ensureAvailable(
  view: DataView,
  offset: number,
  byteLength: number,
  label: string,
): void {
  if (offset < 0 || byteLength < 0 || offset + byteLength > view.byteLength) {
    throw new Error(`FMPP buffer truncated while reading ${label}`);
  }
}

function readU32(view: DataView, offset: number, label: string): number {
  ensureAvailable(view, offset, 4, label);
  return view.getUint32(offset, true);
}

function readU64AsSafeNumber(view: DataView, offset: number, label: string): number {
  ensureAvailable(view, offset, 8, label);
  const value = Number(view.getBigUint64(offset, true));
  if (!Number.isSafeInteger(value)) {
    throw new Error(`FMPP ${label} exceeds JavaScript safe integer range`);
  }
  return value;
}

function statusFromCode(code: number): DecodedPeriodicPairsStatus {
  switch (code) {
    case 1:
      return "valid";
    case 2:
      return "invalid";
    case 3:
      return "stale";
    case 4:
      return "unavailable";
    default:
      throw new Error(`Unsupported FMPP validation status code: ${code}`);
  }
}

export function decodePeriodicPairs(buffer: ArrayBuffer): DecodedPeriodicPairs {
  if (buffer.byteLength < HEADER_LEN) {
    throw new Error(
      `FMPP buffer too short: ${buffer.byteLength} bytes, need at least ${HEADER_LEN}`,
    );
  }
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (magic !== MAGIC) {
    throw new Error(`Invalid FMPP magic: expected "${MAGIC}", got "${magic}"`);
  }
  if (view.getUint8(4) !== VERSION) {
    throw new Error(`Unsupported FMPP version: expected ${VERSION}, got ${view.getUint8(4)}`);
  }
  const status = statusFromCode(view.getUint8(5));
  if (view.getUint16(6, true) !== 0) {
    throw new Error("FMPP reserved header bytes must be zero");
  }
  const revision = readU64AsSafeNumber(view, 8, "revision");
  const pairCount = readU32(view, 16, "pair count");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const pairs: DecodedPeriodicPair[] = [];
  const pairIds = new Set<string>();
  let offset = HEADER_LEN;

  for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
    const pairIdLength = readU32(view, offset, `pair ${pairIndex} id length`);
    offset += 4;
    ensureAvailable(view, offset, pairIdLength, `pair ${pairIndex} id`);
    let pairId: string;
    try {
      pairId = decoder.decode(new Uint8Array(buffer, offset, pairIdLength));
    } catch {
      throw new Error(`FMPP pair ${pairIndex} id is not valid UTF-8`);
    }
    offset += pairIdLength;
    if (pairIds.has(pairId)) {
      throw new Error(`FMPP contains duplicate pair id '${pairId}'`);
    }
    pairIds.add(pairId);

    const markerA = readU32(view, offset, `pair ${pairIndex} marker A`);
    offset += 4;
    const markerB = readU32(view, offset, `pair ${pairIndex} marker B`);
    offset += 4;
    const nodePairCount = readU32(view, offset, `pair ${pairIndex} node count`);
    offset += 4;
    const facePairCount = readU32(view, offset, `pair ${pairIndex} face count`);
    offset += 4;

    const nodePairs: Array<[number, number]> = [];
    for (let nodeIndex = 0; nodeIndex < nodePairCount; nodeIndex += 1) {
      const source = readU32(view, offset, `pair ${pairIndex} node ${nodeIndex} source`);
      offset += 4;
      const destination = readU32(
        view,
        offset,
        `pair ${pairIndex} node ${nodeIndex} destination`,
      );
      offset += 4;
      nodePairs.push([source, destination]);
    }

    const facePairs: DecodedPeriodicFacePair[] = [];
    for (let faceIndex = 0; faceIndex < facePairCount; faceIndex += 1) {
      const faceA = readU64AsSafeNumber(view, offset, `pair ${pairIndex} face ${faceIndex} source`);
      offset += 8;
      const faceB = readU64AsSafeNumber(
        view,
        offset,
        `pair ${pairIndex} face ${faceIndex} destination`,
      );
      offset += 8;
      const vertexPairCount = readU32(
        view,
        offset,
        `pair ${pairIndex} face ${faceIndex} vertex count`,
      );
      offset += 4;
      const vertexPairs: Array<[number, number]> = [];
      for (let vertexIndex = 0; vertexIndex < vertexPairCount; vertexIndex += 1) {
        const source = readU32(
          view,
          offset,
          `pair ${pairIndex} face ${faceIndex} vertex ${vertexIndex} source`,
        );
        offset += 4;
        const destination = readU32(
          view,
          offset,
          `pair ${pairIndex} face ${faceIndex} vertex ${vertexIndex} destination`,
        );
        offset += 4;
        vertexPairs.push([source, destination]);
      }
      facePairs.push({ faceA, faceB, vertexPairs });
    }
    pairs.push({ facePairs, markerA, markerB, nodePairs, pairId });
  }

  if (offset !== view.byteLength) {
    throw new Error(`FMPP buffer has trailing bytes: ${view.byteLength - offset}`);
  }
  return { pairs, revision, status };
}
