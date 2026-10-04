import type {
  DecodedComplexFieldVector,
  DecodedFieldVector,
  DecodedFieldVectorIndexing,
  DecodedFieldVectorScopeKind,
  DecodedFieldVectorSourceKind,
} from "./types";

const HEADER_LEN = 48;
const KIND_F64 = 1;
const MAGIC = "FMVP";
const METADATA_FIXED_LEN = 68;
const METADATA_V4_FIXED_LEN = 80;
const METADATA_MAGIC = "FMMI";
const SUPPORTED_METADATA_VERSION = 2;
const SUPPORTED_METADATA_V4_VERSION = 3;
const SUPPORTED_VERSIONS = new Set([2, 3, 4]);

function readMagic(view: DataView): string {
  return String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
}

export function decodeFieldVector(buffer: ArrayBuffer): DecodedFieldVector {
  if (buffer.byteLength < HEADER_LEN) {
    throw new Error(
      `FMVP buffer too short: ${buffer.byteLength} bytes, need at least ${HEADER_LEN}`,
    );
  }

  const view = new DataView(buffer);
  const magic = readMagic(view);
  if (magic !== MAGIC) {
    throw new Error(`Invalid FMVP magic: expected "${MAGIC}", got "${magic}"`);
  }

  const version = view.getUint8(4);
  if (!SUPPORTED_VERSIONS.has(version)) {
    throw new Error(
      `Unsupported FMVP version: expected 2, 3, or 4, got ${version}`,
    );
  }

  const kind = view.getUint8(5);
  if (kind !== KIND_F64) {
    throw new Error(
      `Unsupported FMVP value kind: expected ${KIND_F64}, got ${kind}`,
    );
  }

  const nComp = view.getUint8(6);
  if (nComp < 1) {
    throw new Error(
      `Unsupported FMVP component count: expected at least 1, got ${nComp}`,
    );
  }

  const metadataLength = version >= 3 ? view.getUint32(8, true) : 0;
  const minimumMetadataLength = version === 4 ? METADATA_V4_FIXED_LEN : METADATA_FIXED_LEN;
  if (version >= 3 && metadataLength < minimumMetadataLength) {
    throw new Error(
      `FMVP metadata block too short: ${metadataLength} bytes, need at least ${minimumMetadataLength}`,
    );
  }
  const valueCount = view.getUint32(12, true);
  const gridX = view.getUint32(16, true);
  const gridY = view.getUint32(20, true);
  const gridZ = view.getUint32(24, true);
  const valueOffset = HEADER_LEN + metadataLength;
  const expectedLength =
    valueOffset + valueCount * Float64Array.BYTES_PER_ELEMENT;

  if (buffer.byteLength !== expectedLength) {
    throw new Error(
      `FMVP buffer size mismatch: expected ${expectedLength}, got ${buffer.byteLength}`,
    );
  }
  if (valueOffset % Float64Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error(`FMVP metadata length is not 8-byte aligned: ${metadataLength}`);
  }

  const idBytes = new Uint8Array(buffer, 28, 16);
  let idEnd = idBytes.indexOf(0);
  if (idEnd === -1) {
    idEnd = idBytes.length;
  }

  const pointCount = gridX * gridY * gridZ;
  const expectedValueCount = pointCount * nComp;
  if (valueCount !== expectedValueCount) {
    throw new Error(
      `FMVP element count mismatch: expected grid*nComp=${expectedValueCount}, got ${valueCount}`,
    );
  }
  const metadata =
    version >= 3
      ? decodeFieldVectorMetadata(view, version, metadataLength, pointCount)
      : legacyFieldVectorMetadata();

  return {
    dtype: "float64",
    domainGenerationId: metadata.domainGenerationId,
    fieldGenerationId: metadata.fieldGenerationId,
    formatVersion: version as 2 | 3 | 4,
    grid: [gridX, gridY, gridZ],
    indexing: metadata.indexing,
    meshTopologyHash: metadata.meshTopologyHash,
    meshTopologyRevision: metadata.meshTopologyRevision,
    nComp,
    nodeIndices: metadata.nodeIndices,
    pointCount,
    quantityId: new TextDecoder().decode(idBytes.subarray(0, idEnd)),
    scopeId: metadata.scopeId,
    scopeKind: metadata.scopeKind,
    sourceId: metadata.sourceId,
    sourceKind: metadata.sourceKind,
    sourceRevision: metadata.sourceRevision,
    valueCount,
    values: new Float64Array(buffer, valueOffset, valueCount),
  };
}

interface DecodedFieldVectorMetadata {
  domainGenerationId: string | null;
  fieldGenerationId: string | null;
  indexing: DecodedFieldVectorIndexing;
  meshTopologyHash: string | null;
  meshTopologyRevision: string | null;
  nodeIndices: Uint32Array | null;
  scopeId: string | null;
  scopeKind: DecodedFieldVectorScopeKind | null;
  sourceId: string | null;
  sourceKind: DecodedFieldVectorSourceKind | null;
  sourceRevision: string | null;
}

function legacyFieldVectorMetadata(): DecodedFieldVectorMetadata {
  return {
    domainGenerationId: null,
    fieldGenerationId: null,
    indexing: "legacy_count_only",
    meshTopologyHash: null,
    meshTopologyRevision: null,
    nodeIndices: null,
    scopeId: null,
    scopeKind: null,
    sourceId: null,
    sourceKind: null,
    sourceRevision: null,
  };
}

function decodeFieldVectorMetadata(
  view: DataView,
  formatVersion: number,
  metadataLength: number,
  pointCount: number,
): DecodedFieldVectorMetadata {
  const fixedLength = formatVersion === 4 ? METADATA_V4_FIXED_LEN : METADATA_FIXED_LEN;
  if (metadataLength < fixedLength) {
    throw new Error(
      `FMVP metadata block too short: ${metadataLength} bytes, need at least ${fixedLength}`,
    );
  }
  const metadataStart = HEADER_LEN;
  const metadataEnd = metadataStart + metadataLength;
  const metadataMagic = String.fromCharCode(
    view.getUint8(metadataStart),
    view.getUint8(metadataStart + 1),
    view.getUint8(metadataStart + 2),
    view.getUint8(metadataStart + 3),
  );
  if (metadataMagic !== METADATA_MAGIC) {
    throw new Error(
      `Invalid FMVP metadata magic: expected "${METADATA_MAGIC}", got "${metadataMagic}"`,
    );
  }
  const metadataVersion = view.getUint16(metadataStart + 4, true);
  const expectedMetadataVersion =
    formatVersion === 4 ? SUPPORTED_METADATA_V4_VERSION : SUPPORTED_METADATA_VERSION;
  if (metadataVersion !== expectedMetadataVersion) {
    throw new Error(
      `Unsupported FMVP metadata version: expected ${expectedMetadataVersion}, got ${metadataVersion}`,
    );
  }

  if (view.getUint16(metadataStart + 6, true) !== 0) {
    throw new Error("FMVP metadata reserved flags must be zero");
  }
  const domainGenerationIdLength = view.getUint16(metadataStart + 8, true);
  if (domainGenerationIdLength === 0) {
    throw new Error("FMVP metadata domain generation identity must not be empty");
  }
  const sourceKindLength = formatVersion === 4 ? view.getUint16(metadataStart + 10, true) : 0;
  const sourceIdLength = formatVersion === 4 ? view.getUint16(metadataStart + 12, true) : 0;
  const fieldGenerationIdLength =
    formatVersion === 4 ? view.getUint16(metadataStart + 14, true) : 0;
  if (formatVersion === 4) {
    if (sourceKindLength === 0 || sourceIdLength === 0 || fieldGenerationIdLength === 0) {
      throw new Error("FMVP v4 metadata source and field generation identities must not be empty");
    }
  } else {
    for (let offset = metadataStart + 10; offset < metadataStart + 16; offset += 1) {
      if (view.getUint8(offset) !== 0) {
        throw new Error("FMVP metadata reserved bytes must be zero");
      }
    }
  }
  const meshTopologyRevision = view
    .getBigUint64(metadataStart + 16, true)
    .toString();
  const meshTopologyHash = hexFromBytes(
    new Uint8Array(view.buffer, view.byteOffset + metadataStart + 24, 32),
  );
  const indexing = decodeFieldVectorIndexing(
    view.getUint32(metadataStart + 56, true),
  );
  const nodeIndexCount = view.getUint32(metadataStart + 60, true);
  const scopeKindLength = view.getUint16(metadataStart + 64, true);
  const scopeIdLength = view.getUint16(metadataStart + 66, true);
  const sourceRevision =
    formatVersion === 4
      ? view.getBigUint64(metadataStart + 68, true).toString()
      : null;
  if (formatVersion === 4) {
    for (let offset = metadataStart + 76; offset < metadataStart + 80; offset += 1) {
      if (view.getUint8(offset) !== 0) {
        throw new Error("FMVP v4 metadata reserved bytes must be zero");
      }
    }
  }
  const scopeKindStart = metadataStart + fixedLength;
  const scopeIdStart = scopeKindStart + scopeKindLength;
  const domainGenerationIdStart = scopeIdStart + scopeIdLength;
  const sourceKindStart = domainGenerationIdStart + domainGenerationIdLength;
  const sourceIdStart = sourceKindStart + sourceKindLength;
  const fieldGenerationIdStart = sourceIdStart + sourceIdLength;
  const nodeIndicesStart = fieldGenerationIdStart + fieldGenerationIdLength;
  const nodeIndicesByteLength = nodeIndexCount * Uint32Array.BYTES_PER_ELEMENT;
  const metadataPayloadEnd = nodeIndicesStart + nodeIndicesByteLength;
  if (metadataPayloadEnd > metadataEnd) {
    throw new Error("FMVP metadata string/node-index lengths exceed metadata block");
  }
  if (metadataEnd - metadataPayloadEnd >= Float64Array.BYTES_PER_ELEMENT) {
    throw new Error("FMVP metadata contains excess trailing bytes");
  }
  for (let offset = metadataPayloadEnd; offset < metadataEnd; offset += 1) {
    if (view.getUint8(offset) !== 0) {
      throw new Error("FMVP metadata padding bytes must be zero");
    }
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const rawScopeKind = decoder.decode(
    new Uint8Array(view.buffer, view.byteOffset + scopeKindStart, scopeKindLength),
  );
  const rawScopeId = decoder.decode(
    new Uint8Array(view.buffer, view.byteOffset + scopeIdStart, scopeIdLength),
  );
  const domainGenerationId = decoder.decode(
    new Uint8Array(
      view.buffer,
      view.byteOffset + domainGenerationIdStart,
      domainGenerationIdLength,
    ),
  );
  const rawSourceKind = decoder.decode(
    new Uint8Array(view.buffer, view.byteOffset + sourceKindStart, sourceKindLength),
  );
  const sourceId = decoder.decode(
    new Uint8Array(view.buffer, view.byteOffset + sourceIdStart, sourceIdLength),
  );
  const fieldGenerationId = decoder.decode(
    new Uint8Array(
      view.buffer,
      view.byteOffset + fieldGenerationIdStart,
      fieldGenerationIdLength,
    ),
  );
  const nodeIndices =
    nodeIndexCount > 0
      ? new Uint32Array(
          view.buffer.slice(
            view.byteOffset + nodeIndicesStart,
            view.byteOffset + nodeIndicesStart + nodeIndicesByteLength,
          ),
        )
      : null;

  if (
    (indexing === "explicit_node_indices" ||
      indexing === "sampled_node_indices") &&
    nodeIndexCount !== pointCount
  ) {
    throw new Error(
      `FMVP metadata node index count mismatch: expected ${pointCount}, got ${nodeIndexCount}`,
    );
  }
  if (
    (indexing === "full_domain" || indexing === "legacy_count_only") &&
    nodeIndexCount !== 0
  ) {
    throw new Error(`FMVP metadata ${indexing} payload must not include node indices`);
  }

  return {
    domainGenerationId,
    fieldGenerationId: fieldGenerationId.length > 0 ? fieldGenerationId : null,
    indexing,
    meshTopologyHash,
    meshTopologyRevision,
    nodeIndices,
    scopeId: rawScopeId.length > 0 ? rawScopeId : null,
    scopeKind: decodeFieldVectorScopeKind(rawScopeKind),
    sourceId: sourceId.length > 0 ? sourceId : null,
    sourceKind: decodeFieldVectorSourceKind(rawSourceKind),
    sourceRevision,
  };
}

function decodeFieldVectorSourceKind(
  value: string,
): DecodedFieldVectorSourceKind | null {
  if (value.length === 0) return null;
  if (value === "live" || value === "observation_frame") return value;
  throw new Error(`Unsupported FMVP metadata source_kind: ${value}`);
}

function decodeFieldVectorIndexing(code: number): DecodedFieldVectorIndexing {
  switch (code) {
    case 0:
      return "full_domain";
    case 1:
      return "explicit_node_indices";
    case 2:
      return "sampled_node_indices";
    case 3:
      return "legacy_count_only";
    default:
      throw new Error(`Unsupported FMVP metadata indexing code: ${code}`);
  }
}

function decodeFieldVectorScopeKind(
  value: string,
): DecodedFieldVectorScopeKind | null {
  if (value.length === 0) return null;
  switch (value) {
    case "airbox":
    case "full":
    case "magnetic_only":
    case "layer":
    case "object":
    case "part":
    case "region":
    case "selection":
      return value;
    default:
      throw new Error(`Unsupported FMVP metadata scope_kind: ${value}`);
  }
}

function hexFromBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function asDecodedComplexFieldVector(
  fieldVector: DecodedFieldVector | null | undefined,
): DecodedComplexFieldVector | null {
  if (!fieldVector || fieldVector.nComp < 2 || fieldVector.nComp % 2 !== 0) {
    return null;
  }
  const componentCount = fieldVector.nComp / 2;
  return {
    componentCount,
    dtype: "complex128",
    domainGenerationId: fieldVector.domainGenerationId,
    fieldGenerationId: fieldVector.fieldGenerationId,
    formatVersion: fieldVector.formatVersion,
    grid: fieldVector.grid,
    indexing: fieldVector.indexing,
    meshTopologyHash: fieldVector.meshTopologyHash,
    meshTopologyRevision: fieldVector.meshTopologyRevision,
    nodeIndices: fieldVector.nodeIndices,
    pointCount: fieldVector.pointCount,
    quantityId: fieldVector.quantityId,
    scopeId: fieldVector.scopeId,
    scopeKind: fieldVector.scopeKind,
    sourceId: fieldVector.sourceId,
    sourceKind: fieldVector.sourceKind,
    sourceRevision: fieldVector.sourceRevision,
    valueCount: fieldVector.valueCount,
    values: fieldVector.values,
  };
}
