import type { DecodedArtifactFieldMapping, DecodedFieldVector, DecodedFieldVectorIndexing } from "./types";

/** Decode only provider-owned FMVP6/FMMI4; native u64 IDs never become JS numbers. */
export function decodeArtifactFieldVector(buffer: ArrayBuffer): DecodedFieldVector {
  const fail = (message: string): never => { throw new Error(`FMVP v6: ${message}`); };
  const view = new DataView(buffer);
  const fixed = 88, start = 48;
  if (buffer.byteLength < start + fixed || buffer.byteLength > 128 * 1024 * 1024) fail("bounded header/payload length");
  const text = new TextDecoder("utf-8", { fatal: true });
  const bytes = (offset: number, count: number) => new Uint8Array(buffer, offset, count);
  if (text.decode(bytes(0, 4)) !== "FMVP" || view.getUint8(4) !== 6 || view.getUint8(5) !== 1 || view.getUint8(7) !== 0 || view.getUint32(44, true) !== 0) fail("header magic/version/kind/reserved");
  const nComp = view.getUint8(6), metadataLength = view.getUint32(8, true), valueCount = view.getUint32(12, true);
  const count = view.getUint32(16, true), valueStart = start + metadataLength;
  if (!nComp || !count || view.getUint32(20, true) !== 1 || view.getUint32(24, true) !== 1 || count * nComp !== valueCount) fail("grid/component count");
  if (metadataLength < fixed || metadataLength % 8 || valueStart + valueCount * 8 !== buffer.byteLength) fail("metadata/value lengths");
  if (text.decode(bytes(start, 4)) !== "FMMI" || view.getUint16(start + 4, true) !== 4 || view.getUint16(start + 6, true) !== 0 || view.getUint32(start + 84, true) !== 0) fail("metadata version/reserved");
  const code = view.getUint32(start + 56, true), mappingCount = view.getUint32(start + 60, true), stride = view.getUint32(start + 76, true);
  const names: Record<number, DecodedFieldVectorIndexing> = { 4: "source_nodes", 5: "sample_nodes", 6: "point_samples", 7: "tet4_cell_local_nodes", 8: "cell_centers" };
  const indexing = names[code];
  if (!indexing || view.getUint32(start + 80, true) !== code || mappingCount !== count || stride !== (code === 7 ? 24 : 8) || code === 7 && count % 4) fail("mapping code/count/stride");
  const revision = view.getBigUint64(start + 16, true), sourceRevision = view.getBigUint64(start + 68, true);
  if (revision === BigInt(0)) fail("empty carrier revision");
  const hash = Array.from(bytes(start + 24, 32), v => v.toString(16).padStart(2, "0")).join("");
  if (revision !== view.getBigUint64(start + 24, true)) fail("content-derived carrier revision differs");
  const lengths = [64, 66, 8, 10, 12, 14].map(offset => view.getUint16(start + offset, true));
  let offset = start + fixed;
  const strings = lengths.map((length, index) => {
    if (offset + length > valueStart) fail("string length exceeds metadata");
    const value = text.decode(bytes(offset, length)); offset += length;
    if ((!value.length && index !== 1) || value.includes("\0")) fail("empty or NUL owner string");
    return value;
  });
  const [scopeKind, scopeId, generation, sourceKind, sourceId, fieldGeneration] = strings;
  if (!((scopeKind === "object" && scopeId.length > 0) || (scopeKind === "full" && scopeId.length === 0)) || sourceKind !== "artifact_inspection" || generation !== hash || !/^(sha256:)?[0-9a-f]{64}$/.test(sourceId) || !/^sha256:[0-9a-f]{64}$/.test(fieldGeneration)) fail("source/scope/digest binding");
  const mappingEnd = offset + count * stride;
  if (mappingEnd > valueStart || valueStart - mappingEnd >= 8) fail("mapping length or padding");
  for (let i = mappingEnd; i < valueStart; i++) if (view.getUint8(i)) fail("nonzero padding");
  const identityIds = new BigUint64Array(count);
  const elementOrdinals = code === 7 ? new BigUint64Array(count) : null;
  const localVertexIndices = code === 7 ? new Uint8Array(count) : null;
  const unique = new Set<string>();
  for (let i = 0; i < count; i++) {
    const at = offset + i * stride, first = view.getBigUint64(at, true);
    if (code === 7) {
      const local = view.getUint8(at + 8);
      if (local !== i % 4) fail("incomplete Tet4 trace order");
      for (let j = 9; j < 16; j++) if (view.getUint8(at + j)) fail("nonzero local trace reserved bytes");
      elementOrdinals![i] = first; localVertexIndices![i] = local; identityIds[i] = view.getBigUint64(at + 16, true);
      if (i % 4 && elementOrdinals![i - i % 4] !== first) fail("mixed Tet4 source element");
      if (i % 4 === 3 && new Set(identityIds.subarray(i - 3, i + 1)).size !== 4) fail("duplicate Tet4 stable vertex");
    } else {
      identityIds[i] = first;
      if ((code === 5 || code === 6) && first !== BigInt(i)) fail("sample ordinal differs");
    }
    const key = code === 7 ? `${first}:${i % 4}` : first.toString();
    if (unique.has(key)) fail("duplicate mapping identity");
    unique.add(key);
  }
  const values = new Float64Array(buffer, valueStart, valueCount);
  if (values.some(value => !Number.isFinite(value))) fail("non-finite field values");
  const quantityBytes = bytes(28, 16), zero = quantityBytes.indexOf(0);
  const quantityId = text.decode(quantityBytes.subarray(0, zero < 0 ? 16 : zero));
  if (!quantityId || zero >= 0 && quantityBytes.subarray(zero).some(v => v !== 0)) fail("quantity ID padding");
  const artifactMapping: DecodedArtifactFieldMapping = { indexing: indexing as DecodedArtifactFieldMapping["indexing"], identityIds, elementOrdinals, localVertexIndices };
  return { dtype: "float64", formatVersion: 6, grid: [count, 1, 1], nComp, pointCount: count, valueCount, quantityId, values,
    domainGenerationId: generation, meshTopologyHash: hash, meshTopologyRevision: revision.toString(), indexing, nodeIndices: null,
    scopeKind: scopeKind as DecodedFieldVector["scopeKind"], scopeId: scopeId || null, sourceKind: "artifact_inspection", sourceId, sourceRevision: sourceRevision.toString(), fieldGenerationId: fieldGeneration, artifactMapping };
}
