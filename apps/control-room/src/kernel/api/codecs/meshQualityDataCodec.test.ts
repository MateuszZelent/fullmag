import { describe, expect, it } from "vitest";

import { decodeMeshQualityData } from "./meshQualityDataCodec";

function writeMagic(view: DataView, magic: string): void {
  for (const [index, code] of [...magic].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
}

function makeQualityBuffer(flags = 0b111): ArrayBuffer {
  const elementCount = 2;
  const metricCount =
    Number(Boolean(flags & 0b001)) +
    Number(Boolean(flags & 0b010)) +
    Number(Boolean(flags & 0b100));
  const buffer = new ArrayBuffer(
    32 + elementCount * metricCount * Float64Array.BYTES_PER_ELEMENT,
  );
  const view = new DataView(buffer);
  writeMagic(view, "FMMQ");
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setUint32(8, elementCount, true);
  view.setUint32(12, flags, true);

  let offset = 32;
  if (flags & 0b001) {
    new Float64Array(buffer, offset, elementCount).set([0.4, 0.8]);
    offset += elementCount * Float64Array.BYTES_PER_ELEMENT;
  }
  if (flags & 0b010) {
    new Float64Array(buffer, offset, elementCount).set([0.2, 0.6]);
    offset += elementCount * Float64Array.BYTES_PER_ELEMENT;
  }
  if (flags & 0b100) {
    new Float64Array(buffer, offset, elementCount).set([1.0, 2.0]);
  }
  return buffer;
}

function makeQualityV2Buffer(): ArrayBuffer {
  const encoder = new TextEncoder();
  const identity = encoder.encode(
    '{"families":[{"element_count":2,"family":"tet4","node_arity":4,"ordinal_max":1,"ordinal_min":0}],"format":"fmmq.v2","mesh_revision":"r","policy_fingerprint":"p","schema_version":"fmmq_identity.v1","topology_fingerprint":"t"}',
  );
  const identityOffset = 128;
  const directoryOffset = identityOffset + identity.byteLength;
  const ordinalLength = 2 * 8;
  const dataLength = 2 * 8;
  // Start with an encoded (and therefore ArrayBufferLike-compatible) value so
  // TypeScript does not narrow the mutable fixture to Uint8Array<ArrayBuffer>.
  let directory = encoder.encode("");
  let ordinalOffset = 0;
  let dataOffset = 0;
  for (let iteration = 0; iteration < 8; iteration++) {
    ordinalOffset = directoryOffset + directory.byteLength;
    dataOffset = ordinalOffset + ordinalLength;
    const text = `{"metrics":[{"checksum":"sha256:placeholder","count":2,"data_offset":${dataOffset},"dtype":"f64le","id":"cell.volume.v1","ordinal_arity":1,"ordinal_count":2,"ordinal_offset":${ordinalOffset},"unit":"m^3"}],"schema_version":"fmmq_metric_directory.v1"}`;
    const candidate = encoder.encode(text);
    if (candidate.byteLength === directory.byteLength) {
      directory = candidate;
      break;
    }
    directory = candidate;
  }
  const digestOffset = dataOffset + dataLength;
  const buffer = new ArrayBuffer(digestOffset + 32);
  const view = new DataView(buffer);
  writeMagic(view, "FMMQ");
  view.setUint8(4, 2);
  view.setUint8(5, 1);
  view.setUint16(6, 128, true);
  view.setUint32(12, 2, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, 1, true);
  view.setBigUint64(28, BigInt(identityOffset), true);
  view.setBigUint64(36, BigInt(identity.byteLength), true);
  view.setBigUint64(44, BigInt(directoryOffset), true);
  view.setBigUint64(52, BigInt(directory.byteLength), true);
  view.setBigUint64(60, BigInt(ordinalOffset), true);
  view.setBigUint64(68, BigInt(ordinalLength), true);
  view.setBigUint64(76, BigInt(dataOffset), true);
  view.setBigUint64(84, BigInt(dataLength), true);
  view.setBigUint64(92, BigInt(digestOffset), true);
  view.setBigUint64(100, BigInt(32), true);
  new Uint8Array(buffer, identityOffset, identity.byteLength).set(identity);
  new Uint8Array(buffer, directoryOffset, directory.byteLength).set(directory);
  view.setBigUint64(ordinalOffset, BigInt(0), true);
  view.setBigUint64(ordinalOffset + 8, BigInt(1), true);
  view.setFloat64(dataOffset, 1.0, true);
  view.setFloat64(dataOffset + 8, 2.0, true);
  return buffer;
}

describe("decodeMeshQualityData", () => {
  it("decodes FMMQ per-element quality arrays", () => {
    const decoded = decodeMeshQualityData(makeQualityBuffer());

    expect(decoded.elementCount).toBe(2);
    expect(Array.from(decoded.sicn ?? [])).toEqual([0.4, 0.8]);
    expect(Array.from(decoded.gamma ?? [])).toEqual([0.2, 0.6]);
    expect(Array.from(decoded.volume ?? [])).toEqual([1, 2]);
  });

  it("rejects buffers with unsupported flags", () => {
    const buffer = makeQualityBuffer(0b1000);

    expect(() => decodeMeshQualityData(buffer)).toThrow(/Unsupported FMMQ metric flags/);
  });

  it("decodes the v2 volume channel from unaligned section offsets", () => {
    const decoded = decodeMeshQualityData(makeQualityV2Buffer());

    expect(decoded.elementCount).toBe(2);
    expect(decoded.sicn).toBeNull();
    expect(decoded.gamma).toBeNull();
    expect(Array.from(decoded.volume ?? [])).toEqual([1, 2]);
  });

  it("accepts edge_length_uniformity family metric in v2 payload without error", () => {
    const encoder = new TextEncoder();
    const identity = encoder.encode(
      '{"families":[{"element_count":2,"family":"tet4","node_arity":4,"ordinal_max":1,"ordinal_min":0}],"format":"fmmq.v2","mesh_revision":"r","policy_fingerprint":"p","schema_version":"fmmq_identity.v1","topology_fingerprint":"t"}',
    );
    const identityOffset = 128;
    const directoryOffset = identityOffset + identity.byteLength;
    const ordinalLength = 2 * 8;
    const dataLength = 2 * 8;
    let directory = encoder.encode("");
    let ordinalOffset = 0;
    let dataOffset = 0;
    for (let iteration = 0; iteration < 8; iteration++) {
      ordinalOffset = directoryOffset + directory.byteLength;
      dataOffset = ordinalOffset + ordinalLength;
      const text = `{"metrics":[{"checksum":"sha256:placeholder","count":2,"data_offset":${dataOffset},"dtype":"f64le","family":"tet4","id":"edge_length_uniformity.tet4.v1","ordinal_arity":1,"ordinal_count":2,"ordinal_offset":${ordinalOffset},"unit":"1"}],"schema_version":"fmmq_metric_directory.v1"}`;
      const candidate = encoder.encode(text);
      if (candidate.byteLength === directory.byteLength) {
        directory = candidate;
        break;
      }
      directory = candidate;
    }
    const digestOffset = dataOffset + dataLength;
    const buffer = new ArrayBuffer(digestOffset + 32);
    const view = new DataView(buffer);
    writeMagic(view, "FMMQ");
    view.setUint8(4, 2);
    view.setUint8(5, 1);
    view.setUint16(6, 128, true);
    view.setUint32(12, 2, true);
    view.setUint32(20, 1, true);
    view.setUint32(24, 1, true);
    view.setBigUint64(28, BigInt(identityOffset), true);
    view.setBigUint64(36, BigInt(identity.byteLength), true);
    view.setBigUint64(44, BigInt(directoryOffset), true);
    view.setBigUint64(52, BigInt(directory.byteLength), true);
    view.setBigUint64(60, BigInt(ordinalOffset), true);
    view.setBigUint64(68, BigInt(ordinalLength), true);
    view.setBigUint64(76, BigInt(dataOffset), true);
    view.setBigUint64(84, BigInt(dataLength), true);
    view.setBigUint64(92, BigInt(digestOffset), true);
    view.setBigUint64(100, BigInt(32), true);
    new Uint8Array(buffer, identityOffset, identity.byteLength).set(identity);
    new Uint8Array(buffer, directoryOffset, directory.byteLength).set(directory);
    view.setBigUint64(ordinalOffset, BigInt(0), true);
    view.setBigUint64(ordinalOffset + 8, BigInt(1), true);
    view.setFloat64(dataOffset, 0.85, true);
    view.setFloat64(dataOffset + 8, 0.95, true);

    const decoded = decodeMeshQualityData(buffer);
    expect(decoded.elementCount).toBe(2);
  });
});
