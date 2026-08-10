import { describe, expect, it } from "vitest";

import { asDecodedComplexFieldVector, decodeFieldVector } from "./fieldVectorCodec";

function makeFieldVectorBuffer({
  nComp = 3,
  quantityId = "m",
  values = [1, 0, -1],
}: {
  nComp?: number;
  quantityId?: string;
  values?: number[];
} = {}): ArrayBuffer {
  const buffer = new ArrayBuffer(
    48 + values.length * Float64Array.BYTES_PER_ELEMENT,
  );
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMVP"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 2);
  view.setUint8(5, 1);
  view.setUint8(6, nComp);
  view.setUint32(12, values.length, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, 1, true);
  new TextEncoder().encodeInto(quantityId, new Uint8Array(buffer, 28, 16));
  new Float64Array(buffer, 48).set(values);
  return buffer;
}

function makeFieldVectorV3Buffer({
  domainGenerationId = "generation-42",
  indexing = 0,
  metadataVersion = 2,
  nodeIndices = [],
  quantityId = "m",
  scopeId = "",
  scopeKind = "full",
  values = [1, 0, -1],
}: {
  domainGenerationId?: string;
  indexing?: number;
  metadataVersion?: number;
  nodeIndices?: number[];
  quantityId?: string;
  scopeId?: string;
  scopeKind?: string;
  values?: number[];
} = {}): ArrayBuffer {
  const encoder = new TextEncoder();
  const scopeKindBytes = encoder.encode(scopeKind);
  const scopeIdBytes = encoder.encode(scopeId);
  const generationIdBytes = encoder.encode(domainGenerationId);
  const rawMetadataLength =
    68 +
    scopeKindBytes.length +
    scopeIdBytes.length +
    generationIdBytes.length +
    nodeIndices.length * 4;
  const metadataLength = Math.ceil(rawMetadataLength / 8) * 8;
  const buffer = new ArrayBuffer(
    48 + metadataLength + values.length * Float64Array.BYTES_PER_ELEMENT,
  );
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMVP"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 3);
  view.setUint8(5, 1);
  view.setUint8(6, 3);
  view.setUint32(8, metadataLength, true);
  view.setUint32(12, values.length, true);
  view.setUint32(16, values.length / 3, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, 1, true);
  encoder.encodeInto(quantityId, new Uint8Array(buffer, 28, 16));

  for (const [index, code] of [..."FMMI"].entries()) {
    view.setUint8(48 + index, code.charCodeAt(0));
  }
  view.setUint16(52, metadataVersion, true);
  view.setUint16(56, generationIdBytes.length, true);
  view.setBigUint64(64, BigInt(7), true);
  new Uint8Array(buffer, 72, 32).fill(0xab);
  view.setUint32(104, indexing, true);
  view.setUint32(108, nodeIndices.length, true);
  view.setUint16(112, scopeKindBytes.length, true);
  view.setUint16(114, scopeIdBytes.length, true);
  new Uint8Array(buffer, 116, scopeKindBytes.length).set(scopeKindBytes);
  new Uint8Array(buffer, 116 + scopeKindBytes.length, scopeIdBytes.length).set(
    scopeIdBytes,
  );
  const generationIdStart = 116 + scopeKindBytes.length + scopeIdBytes.length;
  new Uint8Array(buffer, generationIdStart, generationIdBytes.length).set(
    generationIdBytes,
  );
  let offset = generationIdStart + generationIdBytes.length;
  for (const nodeIndex of nodeIndices) {
    view.setUint32(offset, nodeIndex, true);
    offset += 4;
  }
  new Float64Array(buffer, 48 + metadataLength).set(values);
  return buffer;
}

describe("decodeFieldVector", () => {
  it("decodes valid FMVP field vector buffers", () => {
    const decoded = decodeFieldVector(makeFieldVectorBuffer());

    expect(decoded.quantityId).toBe("m");
    expect(decoded.formatVersion).toBe(2);
    expect(decoded.indexing).toBe("legacy_count_only");
    expect(decoded.nComp).toBe(3);
    expect(decoded.grid).toEqual([1, 1, 1]);
    expect(Array.from(decoded.values)).toEqual([1, 0, -1]);
  });

  it("decodes FMVP v3 full-domain metadata", () => {
    const decoded = decodeFieldVector(makeFieldVectorV3Buffer());

    expect(decoded.formatVersion).toBe(3);
    expect(decoded.domainGenerationId).toBe("generation-42");
    expect(decoded.meshTopologyRevision).toBe("7");
    expect(decoded.meshTopologyHash).toBe("abababababababababababababababababababababababababababababababab");
    expect(decoded.scopeKind).toBe("full");
    expect(decoded.scopeId).toBeNull();
    expect(decoded.indexing).toBe("full_domain");
    expect(decoded.nodeIndices).toBeNull();
  });

  it("preserves arbitrary UTF-8 FMVP v3 domain generation identities", () => {
    const decoded = decodeFieldVector(
      makeFieldVectorV3Buffer({
        domainGenerationId: "domain:warstwa-α/9007199254741001",
      }),
    );

    expect(decoded.domainGenerationId).toBe("domain:warstwa-α/9007199254741001");
  });

  it.each(["region", "layer"] as const)(
    "decodes FDM %s scope metadata",
    (scopeKind) => {
      const decoded = decodeFieldVector(
        makeFieldVectorV3Buffer({
          indexing: 1,
          nodeIndices: [4],
          scopeId: `${scopeKind}:free`,
          scopeKind,
        }),
      );

      expect(decoded.scopeKind).toBe(scopeKind);
      expect(decoded.scopeId).toBe(`${scopeKind}:free`);
      expect(Array.from(decoded.nodeIndices ?? [])).toEqual([4]);
    },
  );

  it("rejects obsolete metadata v1 instead of decoding generation bytes as u64", () => {
    expect(() =>
      decodeFieldVector(makeFieldVectorV3Buffer({ metadataVersion: 1 })),
    ).toThrow(/Unsupported FMVP metadata version/);
  });

  it("rejects empty FMVP v3 generation identities", () => {
    expect(() =>
      decodeFieldVector(makeFieldVectorV3Buffer({ domainGenerationId: "" })),
    ).toThrow(/domain generation/i);
  });

  it("rejects malformed metadata v2 generation lengths, reserved bytes, and padding", () => {
    const oversizedGeneration = makeFieldVectorV3Buffer();
    new DataView(oversizedGeneration).setUint16(56, 0xffff, true);
    expect(() => decodeFieldVector(oversizedGeneration)).toThrow(/lengths exceed/);

    const nonzeroReserved = makeFieldVectorV3Buffer();
    new DataView(nonzeroReserved).setUint8(58, 1);
    expect(() => decodeFieldVector(nonzeroReserved)).toThrow(/reserved bytes/);

    const nonzeroPadding = makeFieldVectorV3Buffer();
    const paddingView = new DataView(nonzeroPadding);
    const metadataLength = paddingView.getUint32(8, true);
    paddingView.setUint8(48 + metadataLength - 1, 1);
    expect(() => decodeFieldVector(nonzeroPadding)).toThrow(/padding bytes/);
  });

  it("decodes scoped FMVP v3 node indices", () => {
    const decoded = decodeFieldVector(
      makeFieldVectorV3Buffer({
        indexing: 1,
        nodeIndices: [3, 1],
        quantityId: "h_eff",
        scopeId: "part:a",
        scopeKind: "part",
        values: [1, 0, 0, 0, 1, 0],
      }),
    );

    expect(decoded.quantityId).toBe("h_eff");
    expect(decoded.scopeKind).toBe("part");
    expect(decoded.scopeId).toBe("part:a");
    expect(decoded.indexing).toBe("explicit_node_indices");
    expect(Array.from(decoded.nodeIndices ?? [])).toEqual([3, 1]);
  });

  it("rejects malformed FMVP v3 metadata lengths", () => {
    const buffer = makeFieldVectorV3Buffer();
    new DataView(buffer).setUint32(8, 8, true);

    expect(() => decodeFieldVector(buffer)).toThrow(/FMVP metadata/);
  });

  it("rejects malformed FMVP buffers", () => {
    const buffer = makeFieldVectorBuffer();
    new DataView(buffer).setUint8(0, "X".charCodeAt(0));

    expect(() => decodeFieldVector(buffer)).toThrow(/Invalid FMVP magic/);
  });

  it("decodes tensor-valued FMVP quantities with more than three components", () => {
    const decoded = decodeFieldVector(
      makeFieldVectorBuffer({
        nComp: 6,
        quantityId: "stress",
        values: [1, 2, 3, 4, 5, 6],
      }),
    );

    expect(decoded.quantityId).toBe("stress");
    expect(decoded.nComp).toBe(6);
    expect(decoded.valueCount).toBe(6);
    expect(Array.from(decoded.values)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("exposes even-component analysis fields as complex real-imag pairs", () => {
    const decoded = decodeFieldVector(
      makeFieldVectorBuffer({
        nComp: 6,
        quantityId: "analysis:eigen",
        values: [1, 0.1, 2, 0.2, 3, 0.3],
      }),
    );

    expect(asDecodedComplexFieldVector(decoded)).toMatchObject({
      componentCount: 3,
      dtype: "complex128",
      pointCount: 1,
      quantityId: "analysis:eigen",
      valueCount: 6,
    });
  });

  it("does not treat real xyz field vectors as complex analysis fields", () => {
    const decoded = decodeFieldVector(makeFieldVectorBuffer());

    expect(asDecodedComplexFieldVector(decoded)).toBeNull();
  });

  it("rejects invalid FMVP component counts", () => {
    const buffer = makeFieldVectorBuffer();
    new DataView(buffer).setUint8(6, 0);

    expect(() => decodeFieldVector(buffer)).toThrow(/Unsupported FMVP component count/);
  });
});
