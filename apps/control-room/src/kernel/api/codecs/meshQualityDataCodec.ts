import type {
  DecodedMeshQualityData,
  DecodedMeshQualityMetric,
} from "./types";

const HEADER_LEN = 32;
const KIND_F64 = 1;
const MAGIC = "FMMQ";
const SUPPORTED_FLAGS = 0b111;
const SUPPORTED_VERSION = 1;
const FLAG_SICN = 0b001;
const FLAG_GAMMA = 0b010;
const FLAG_VOLUME = 0b100;

const FMMQ_V2_HEADER_LEN = 128;
const FMMQ_V2_DIGEST_LEN = 32;
const FMMQ_V2_DTYPE_F64 = "f64le";
const FMMQ_V2_IDENTITY_SCHEMA = "fmmq_identity.v1";
const FMMQ_V2_DIRECTORY_SCHEMA = "fmmq_metric_directory.v1";

function readMagic(view: DataView): string {
  return String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
}

function metricCount(flags: number): number {
  return Number(Boolean(flags & FLAG_SICN)) +
    Number(Boolean(flags & FLAG_GAMMA)) +
    Number(Boolean(flags & FLAG_VOLUME));
}

function readMetric(
  buffer: ArrayBuffer,
  offset: number,
  elementCount: number,
  enabled: boolean,
): { nextOffset: number; values: Float64Array | null } {
  if (!enabled) return { nextOffset: offset, values: null };
  const values = new Float64Array(buffer, offset, elementCount);
  return {
    nextOffset: offset + values.byteLength,
    values,
  };
}

function validateFinite(metric: string, values: Float64Array | null): void {
  if (!values) return;
  for (let index = 0; index < values.length; index++) {
    if (!Number.isFinite(values[index])) {
      throw new Error(`FMMQ: non-finite ${metric} value at element ${index}`);
    }
  }
}

function readU64(view: DataView, offset: number, label: string): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`FMMQ v2 ${label} exceeds JavaScript safe integer range`);
  }
  return Number(value);
}

function checkedSection(
  byteLength: number,
  name: string,
  start: number,
  length: number,
): { end: number; start: number } {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < FMMQ_V2_HEADER_LEN || length < 0) {
    throw new Error(`FMMQ v2 ${name} section has invalid bounds`);
  }
  const end = start + length;
  if (!Number.isSafeInteger(end) || end > byteLength) {
    throw new Error(`FMMQ v2 ${name} section exceeds payload`);
  }
  return { start, end };
}

function readV2Values(view: DataView, start: number, count: number): Float64Array {
  const values = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    const value = view.getFloat64(start + index * Float64Array.BYTES_PER_ELEMENT, true);
    if (!Number.isFinite(value)) {
      throw new Error(`FMMQ v2 contains non-finite value at element ${index}`);
    }
    values[index] = value;
  }
  return values;
}

function expectedV2MetricUnit(metricId: string): string | null {
  switch (metricId) {
    case "cell.max_edge.v1":
      return "m";
    case "cell.volume.v1":
      return "m^3";
    case "cell.sicn.v1":
    case "cell.gamma.v1":
    case "adjacent_size_growth.v1":
      return "1";
    default:
      if (metricId.startsWith("signed_jacobian.") && metricId.endsWith(".v1")) {
        return "m^3";
      }
      if (
        (metricId.startsWith("scaled_jacobian.") ||
          metricId.startsWith("edge_aspect.") ||
          metricId.startsWith("skewness.") ||
          metricId.startsWith("edge_length_uniformity.")) &&
        metricId.endsWith(".v1")
      ) {
        return "1";
      }
      return null;
  }
}

function isFamilyMetric(metricId: string): boolean {
  return (
    metricId.startsWith("signed_jacobian.") ||
    metricId.startsWith("scaled_jacobian.") ||
    metricId.startsWith("edge_aspect.") ||
    metricId.startsWith("skewness.") ||
    metricId.startsWith("edge_length_uniformity.")
  );
}

function compareOrdinalTuples(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function familyExpectedOrdinals(
  familyRow: Record<string, unknown>,
  elementCount: number,
): number[] {
  const rawRanges = familyRow.ordinal_ranges;
  const ranges: unknown[] = rawRanges === undefined
    ? [[familyRow.ordinal_min, familyRow.ordinal_max]]
    : Array.isArray(rawRanges) ? rawRanges : [];
  if (!Array.isArray(ranges) || ranges.length === 0) {
    throw new Error("FMMQ v2 family ordinal ranges are invalid");
  }
  const result: number[] = [];
  let previousEnd = -1;
  for (const rawRange of ranges) {
    if (
      !Array.isArray(rawRange) || rawRange.length !== 2 ||
      rawRange.some((value) => typeof value !== "number" || !Number.isSafeInteger(value))
    ) {
      throw new Error("FMMQ v2 family ordinal ranges are invalid");
    }
    const [start, end] = rawRange as [number, number];
    if (start < 0 || end < start || end >= elementCount || start <= previousEnd) {
      throw new Error("FMMQ v2 family ordinal ranges overlap or exceed the mesh");
    }
    for (let ordinal = start; ordinal <= end; ordinal++) result.push(ordinal);
    previousEnd = end;
  }
  const ordinalMin = familyRow.ordinal_min;
  const ordinalMax = familyRow.ordinal_max;
  if (
    typeof ordinalMin !== "number" || !Number.isSafeInteger(ordinalMin) ||
    typeof ordinalMax !== "number" || !Number.isSafeInteger(ordinalMax) ||
    result[0] !== ordinalMin || result[result.length - 1] !== ordinalMax
  ) {
    throw new Error("FMMQ v2 family ordinal bounds are inconsistent");
  }
  return result;
}

function readV2MetricChannel(
  view: DataView,
  entry: Record<string, unknown>,
  dataSection: { end: number; start: number },
  ordinalSection: { end: number; start: number },
  elementCount: number,
  familyByName: ReadonlyMap<string, Record<string, unknown>>,
): DecodedMeshQualityMetric {
  const metricId = entry.id;
  if (typeof metricId !== "string" || metricId.trim() === "") {
    throw new Error("FMMQ v2 metric ID is missing");
  }
  const expectedUnit = expectedV2MetricUnit(metricId);
  if (expectedUnit === null || entry.dtype !== FMMQ_V2_DTYPE_F64 || entry.unit !== expectedUnit) {
    throw new Error(`FMMQ v2 ${metricId} has an unsupported dtype or unit`);
  }
  const count = entry.count;
  const arity = entry.ordinal_arity;
  const ordinalCount = entry.ordinal_count;
  if (
    typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 ||
    typeof arity !== "number" || !Number.isSafeInteger(arity) || arity < 1 ||
    typeof ordinalCount !== "number" || !Number.isSafeInteger(ordinalCount) ||
    !Number.isSafeInteger(count * arity) || ordinalCount !== count * arity
  ) {
    throw new Error(`FMMQ v2 ${metricId} has invalid count or ordinal arity`);
  }
  const family = entry.family;
  if (isFamilyMetric(metricId)) {
    if (typeof family !== "string" || family.trim() === "") {
      throw new Error(`FMMQ v2 family metric ${metricId} has no family identity`);
    }
  } else if (family !== null && family !== undefined && typeof family !== "string") {
    throw new Error(`FMMQ v2 ${metricId} has an invalid family identity`);
  }
  const dataOffset = entry.data_offset;
  const ordinalOffset = entry.ordinal_offset;
  if (
    typeof dataOffset !== "number" || !Number.isSafeInteger(dataOffset) ||
    typeof ordinalOffset !== "number" || !Number.isSafeInteger(ordinalOffset)
  ) {
    throw new Error(`FMMQ v2 ${metricId} has invalid channel offsets`);
  }
  const dataEnd = dataOffset + count * Float64Array.BYTES_PER_ELEMENT;
  const ordinalEnd = ordinalOffset + ordinalCount * 8;
  if (
    dataOffset < dataSection.start || dataEnd > dataSection.end ||
    ordinalOffset < ordinalSection.start || ordinalEnd > ordinalSection.end ||
    !Number.isSafeInteger(dataEnd) || !Number.isSafeInteger(ordinalEnd)
  ) {
    throw new Error(`FMMQ v2 ${metricId} channel lies outside its section`);
  }
  const ordinals: number[] = [];
  let previous: number[] | null = null;
  for (let index = 0; index < ordinalCount; index += arity) {
    const tuple: number[] = [];
    for (let component = 0; component < arity; component++) {
      const ordinal = readU64(
        view,
        ordinalOffset + (index + component) * 8,
        `${metricId} ordinal`,
      );
      if (ordinal >= elementCount) {
        throw new Error(`FMMQ v2 ${metricId} ordinal exceeds element_count`);
      }
      tuple.push(ordinal);
      ordinals.push(ordinal);
    }
    if (previous !== null && compareOrdinalTuples(previous, tuple) >= 0) {
      throw new Error(`FMMQ v2 ${metricId} ordinals are not canonical`);
    }
    previous = tuple;
  }
  if (isFamilyMetric(metricId)) {
    const familyRow = typeof family === "string" ? familyByName.get(family) : undefined;
    if (!familyRow) {
      throw new Error(`FMMQ v2 ${metricId} references an unknown family`);
    }
    const expected = familyExpectedOrdinals(familyRow, elementCount);
    if (
      arity !== 1 || count !== expected.length ||
      !expected.every((ordinal, index) => ordinals[index] === ordinal)
    ) {
      throw new Error(`FMMQ v2 ${metricId} is not a complete family vector`);
    }
  } else if (
    metricId.startsWith("cell.") && arity === 1 && count === elementCount &&
    !ordinals.every((ordinal, index) => ordinal === index)
  ) {
    throw new Error(`FMMQ v2 ${metricId} does not cover all element ordinals`);
  }
  const values = readV2Values(view, dataOffset, count);
  return {
    id: metricId,
    unit: expectedUnit,
    family: typeof family === "string" ? family : null,
    ordinalArity: arity,
    ordinals,
    values,
  };
}

function decodeFmmqV2(buffer: ArrayBuffer): DecodedMeshQualityData {
  if (buffer.byteLength < FMMQ_V2_HEADER_LEN + FMMQ_V2_DIGEST_LEN) {
    throw new Error("FMMQ v2 buffer is shorter than its fixed header");
  }
  const view = new DataView(buffer);
  if (view.getUint8(5) !== 1 || view.getUint16(6, true) !== FMMQ_V2_HEADER_LEN) {
    throw new Error("FMMQ v2 uses unsupported endian or header length");
  }
  const elementCount = readU64(view, 12, "element_count");
  const familyCount = view.getUint32(20, true);
  const metricCount = view.getUint32(24, true);
  if (elementCount < 1 || familyCount < 1 || metricCount < 1) {
    throw new Error("FMMQ v2 fixed-header counts are invalid");
  }
  const sections = [
    checkedSection(buffer.byteLength, "identity", readU64(view, 28, "identity_offset"), readU64(view, 36, "identity_length")),
    checkedSection(buffer.byteLength, "directory", readU64(view, 44, "directory_offset"), readU64(view, 52, "directory_length")),
    checkedSection(buffer.byteLength, "ordinals", readU64(view, 60, "ordinal_offset"), readU64(view, 68, "ordinal_length")),
    checkedSection(buffer.byteLength, "data", readU64(view, 76, "data_offset"), readU64(view, 84, "data_length")),
    checkedSection(buffer.byteLength, "digest", readU64(view, 92, "digest_offset"), readU64(view, 100, "digest_length")),
  ];
  if (sections[4].end !== buffer.byteLength || sections[4].end - sections[4].start !== FMMQ_V2_DIGEST_LEN) {
    throw new Error("FMMQ v2 digest must be the final 32 bytes");
  }
  const ordered = [...sections].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index - 1].end > ordered[index].start) {
      throw new Error("FMMQ v2 sections overlap");
    }
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let identity: Record<string, unknown>;
  let directory: Record<string, unknown>;
  try {
    identity = JSON.parse(decoder.decode(new Uint8Array(buffer, sections[0].start, sections[0].end - sections[0].start))) as Record<string, unknown>;
    directory = JSON.parse(decoder.decode(new Uint8Array(buffer, sections[1].start, sections[1].end - sections[1].start))) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`FMMQ v2 JSON is malformed: ${String(error)}`);
  }
  if (
    identity === null || typeof identity !== "object" ||
    identity.schema_version !== FMMQ_V2_IDENTITY_SCHEMA || identity.format !== "fmmq.v2" ||
    typeof identity.topology_fingerprint !== "string" || identity.topology_fingerprint.trim() === "" ||
    typeof identity.policy_fingerprint !== "string" || identity.policy_fingerprint.trim() === "" ||
    typeof identity.mesh_revision !== "string" || identity.mesh_revision.trim() === ""
  ) {
    throw new Error("FMMQ v2 identity is incomplete");
  }
  const familyRows = identity.families;
  if (!Array.isArray(familyRows) || familyRows.length !== familyCount) {
    throw new Error("FMMQ v2 identity family table count is invalid");
  }
  const familyByName = new Map<string, Record<string, unknown>>();
  const familyIntervals: Array<{ end: number; start: number }> = [];
  let familyElementTotal = 0;
  for (const candidate of familyRows) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error("FMMQ v2 identity family table entry is invalid");
    }
    const row = candidate as Record<string, unknown>;
    const family = row.family;
    const nodeArity = row.node_arity;
    const familyElementCount = row.element_count;
    if (
      typeof family !== "string" || family.trim() === "" || familyByName.has(family) ||
      typeof nodeArity !== "number" || !Number.isSafeInteger(nodeArity) || nodeArity < 1 ||
      typeof familyElementCount !== "number" || !Number.isSafeInteger(familyElementCount) ||
      familyElementCount < 1
    ) {
      throw new Error("FMMQ v2 identity family table entry is invalid");
    }
    const expectedArity: Record<string, number> = {
      tet4: 4,
      prism6: 6,
      pyramid5: 5,
      hex8: 8,
    };
    if (expectedArity[family] !== nodeArity) {
      throw new Error(`FMMQ v2 family ${family} has an unsupported node arity`);
    }
    const ordinals = familyExpectedOrdinals(row, elementCount);
    if (ordinals.length !== familyElementCount) {
      throw new Error(`FMMQ v2 family ${family} count does not match ordinal ranges`);
    }
    familyByName.set(family, row);
    familyElementTotal += familyElementCount;
    for (const ordinal of ordinals) familyIntervals.push({ start: ordinal, end: ordinal });
  }
  if (familyElementTotal !== elementCount) {
    throw new Error("FMMQ v2 family element counts do not reconcile");
  }
  familyIntervals.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 0; index < familyIntervals.length; index++) {
    if (familyIntervals[index].start !== index) {
      throw new Error("FMMQ v2 family ordinal ranges leave a gap or overlap");
    }
  }
  if (directory === null || typeof directory !== "object" || directory.schema_version !== FMMQ_V2_DIRECTORY_SCHEMA) {
    throw new Error("FMMQ v2 metric directory schema is unsupported");
  }
  if (!Array.isArray(directory.metrics) || directory.metrics.length !== metricCount) {
    throw new Error("FMMQ v2 metric directory count is invalid");
  }
  const channels: DecodedMeshQualityMetric[] = [];
  const dataRanges: Array<{ end: number; start: number }> = [];
  const ordinalRanges: Array<{ end: number; start: number }> = [];
  const seenMetricIds = new Set<string>();
  for (const candidate of directory.metrics) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error("FMMQ v2 metric directory entry is invalid");
    }
    const entry = candidate as Record<string, unknown>;
    const metricId = entry.id;
    if (typeof metricId !== "string" || metricId.trim() === "" || seenMetricIds.has(metricId)) {
      throw new Error("FMMQ v2 metric IDs must be unique non-empty strings");
    }
    seenMetricIds.add(metricId);
    const count = entry.count;
    const arity = entry.ordinal_arity;
    const ordinalCount = entry.ordinal_count;
    const dataOffset = entry.data_offset;
    const ordinalOffset = entry.ordinal_offset;
    if (
      typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 ||
      typeof arity !== "number" || !Number.isSafeInteger(arity) || arity < 1 ||
      typeof ordinalCount !== "number" || !Number.isSafeInteger(ordinalCount) ||
      !Number.isSafeInteger(count * arity) || ordinalCount !== count * arity ||
      typeof dataOffset !== "number" || !Number.isSafeInteger(dataOffset) ||
      typeof ordinalOffset !== "number" || !Number.isSafeInteger(ordinalOffset)
    ) {
      throw new Error(`FMMQ v2 ${metricId} has invalid channel metadata`);
    }
    const dataEnd = dataOffset + count * Float64Array.BYTES_PER_ELEMENT;
    const ordinalEnd = ordinalOffset + ordinalCount * 8;
    if (!Number.isSafeInteger(dataEnd) || !Number.isSafeInteger(ordinalEnd)) {
      throw new Error(`FMMQ v2 ${metricId} channel bounds overflow`);
    }
    channels.push(
      readV2MetricChannel(
        view,
        entry,
        sections[3],
        sections[2],
        elementCount,
        familyByName,
      ),
    );
    dataRanges.push({ start: dataOffset, end: dataEnd });
    ordinalRanges.push({ start: ordinalOffset, end: ordinalEnd });
  }
  for (const ranges of [dataRanges, ordinalRanges]) {
    ranges.sort((left, right) => left.start - right.start || left.end - right.end);
    for (let index = 1; index < ranges.length; index++) {
      if (ranges[index - 1].end > ranges[index].start) {
        throw new Error("FMMQ v2 metric channels overlap");
      }
    }
  }
  const channel = (metricId: string): Float64Array | null =>
    channels.find((candidate) => candidate.id === metricId)?.values ?? null;
  return {
    elementCount,
    formatVersion: 2,
    identity,
    metrics: channels,
    sicn: channel("cell.sicn.v1"),
    gamma: channel("cell.gamma.v1"),
    volume: channel("cell.volume.v1"),
  };
}

export function decodeMeshQualityData(buffer: ArrayBuffer): DecodedMeshQualityData {
  if (buffer.byteLength < HEADER_LEN) {
    throw new Error(
      `FMMQ buffer too short: ${buffer.byteLength} bytes, need at least ${HEADER_LEN}`,
    );
  }

  const view = new DataView(buffer);
  const magic = readMagic(view);
  if (magic !== MAGIC) {
    throw new Error(`Invalid FMMQ magic: expected "${MAGIC}", got "${magic}"`);
  }

  const version = view.getUint8(4);
  if (version === 2) {
    return decodeFmmqV2(buffer);
  }
  if (version !== SUPPORTED_VERSION) {
    throw new Error(
      `Unsupported FMMQ version: expected ${SUPPORTED_VERSION}, got ${version}`,
    );
  }

  const kind = view.getUint8(5);
  if (kind !== KIND_F64) {
    throw new Error(`Unsupported FMMQ payload kind: expected ${KIND_F64}, got ${kind}`);
  }

  const elementCount = view.getUint32(8, true);
  const flags = view.getUint32(12, true);
  if ((flags & ~SUPPORTED_FLAGS) !== 0) {
    throw new Error(`Unsupported FMMQ metric flags: ${flags}`);
  }
  const expected = HEADER_LEN +
    elementCount * metricCount(flags) * Float64Array.BYTES_PER_ELEMENT;
  if (buffer.byteLength !== expected) {
    throw new Error(
      `FMMQ buffer size mismatch: expected ${expected}, got ${buffer.byteLength}`,
    );
  }

  let offset = HEADER_LEN;
  const sicn = readMetric(buffer, offset, elementCount, Boolean(flags & FLAG_SICN));
  offset = sicn.nextOffset;
  const gamma = readMetric(buffer, offset, elementCount, Boolean(flags & FLAG_GAMMA));
  offset = gamma.nextOffset;
  const volume = readMetric(buffer, offset, elementCount, Boolean(flags & FLAG_VOLUME));
  offset = volume.nextOffset;
  if (offset !== buffer.byteLength) {
    throw new Error("FMMQ buffer has trailing bytes");
  }

  validateFinite("sicn", sicn.values);
  validateFinite("gamma", gamma.values);
  validateFinite("volume", volume.values);

  return {
    elementCount,
    gamma: gamma.values,
    sicn: sicn.values,
    volume: volume.values,
  };
}
