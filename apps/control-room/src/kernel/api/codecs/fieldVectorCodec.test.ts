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

function makeFieldVectorV4Buffer(): ArrayBuffer {
  const encoder = new TextEncoder();
  const scopeKind = encoder.encode("full");
  const domainGenerationId = encoder.encode("sha256:domain");
  const sourceKind = encoder.encode("observation_frame");
  const sourceId = encoder.encode("frame-123");
  const fieldGenerationId = encoder.encode("field:frame-123:m:29");
  const rawMetadataLength =
    80 +
    scopeKind.length +
    domainGenerationId.length +
    sourceKind.length +
    sourceId.length +
    fieldGenerationId.length;
  const metadataLength = Math.ceil(rawMetadataLength / 8) * 8;
  const values = [1, 0, 0];
  const buffer = new ArrayBuffer(48 + metadataLength + values.length * 8);
  const view = new DataView(buffer);
  encoder.encodeInto("FMVP", new Uint8Array(buffer, 0, 4));
  view.setUint8(4, 4);
  view.setUint8(5, 1);
  view.setUint8(6, 3);
  view.setUint32(8, metadataLength, true);
  view.setUint32(12, values.length, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, 1, true);
  encoder.encodeInto("m", new Uint8Array(buffer, 28, 16));
  encoder.encodeInto("FMMI", new Uint8Array(buffer, 48, 4));
  view.setUint16(52, 3, true);
  view.setUint16(56, domainGenerationId.length, true);
  view.setUint16(58, sourceKind.length, true);
  view.setUint16(60, sourceId.length, true);
  view.setUint16(62, fieldGenerationId.length, true);
  view.setBigUint64(64, BigInt(17), true);
  new Uint8Array(buffer, 72, 32).fill(0xab);
  view.setUint32(104, 0, true);
  view.setUint32(108, 0, true);
  view.setUint16(112, scopeKind.length, true);
  view.setUint16(114, 0, true);
  view.setBigUint64(116, BigInt(29), true);
  let offset = 128;
  for (const bytes of [
    scopeKind,
    domainGenerationId,
    sourceKind,
    sourceId,
    fieldGenerationId,
  ]) {
    new Uint8Array(buffer, offset, bytes.length).set(bytes);
    offset += bytes.length;
  }
  new Float64Array(buffer, 48 + metadataLength).set(values);
  return buffer;
}

function makeFieldVectorV5Buffer({
  domainGenerationId = "sha256:domain",
  fieldGenerationId = "",
  indexing = 0,
  meshTopologyHash = new Uint8Array(32).fill(0xab),
  meshTopologyRevision = BigInt(17),
  nodeIndices = [],
  quantityId = "analysis:eigen:sample-0001:mode-0001:delta_m_xyz",
  scopeId = "",
  scopeKind = "full",
  sourceId = "",
  sourceKind = "",
  sourceRevision = BigInt(0),
  values = [1, 0.1, 2, 0.2, 3, 0.3],
}: {
  domainGenerationId?: string;
  fieldGenerationId?: string;
  indexing?: number;
  meshTopologyHash?: Uint8Array;
  meshTopologyRevision?: bigint;
  nodeIndices?: number[];
  quantityId?: string;
  scopeId?: string;
  scopeKind?: string;
  sourceId?: string;
  sourceKind?: string;
  sourceRevision?: bigint;
  values?: number[];
} = {}): ArrayBuffer {
  const encoder = new TextEncoder();
  const scopeKindBytes = encoder.encode(scopeKind);
  const scopeIdBytes = encoder.encode(scopeId);
  const domainGenerationIdBytes = encoder.encode(domainGenerationId);
  const sourceKindBytes = encoder.encode(sourceKind);
  const sourceIdBytes = encoder.encode(sourceId);
  const fieldGenerationIdBytes = encoder.encode(fieldGenerationId);
  const quantityIdBytes = encoder.encode(quantityId);
  const metadataPayloadLength =
    scopeKindBytes.length +
    scopeIdBytes.length +
    domainGenerationIdBytes.length +
    sourceKindBytes.length +
    sourceIdBytes.length +
    fieldGenerationIdBytes.length +
    quantityIdBytes.length +
    nodeIndices.length * Uint32Array.BYTES_PER_ELEMENT;
  const metadataLength = Math.ceil((88 + metadataPayloadLength) / 8) * 8;
  const buffer = new ArrayBuffer(
    48 + metadataLength + values.length * Float64Array.BYTES_PER_ELEMENT,
  );
  const view = new DataView(buffer);
  encoder.encodeInto("FMVP", new Uint8Array(buffer, 0, 4));
  view.setUint8(4, 5);
  view.setUint8(5, 1);
  view.setUint8(6, 6);
  view.setUint32(8, metadataLength, true);
  view.setUint32(12, values.length, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, 1, true);
  new Uint8Array(buffer, 28, 16).set(quantityIdBytes.subarray(0, 16));

  encoder.encodeInto("FMMI", new Uint8Array(buffer, 48, 4));
  view.setUint16(52, 4, true);
  view.setUint16(56, domainGenerationIdBytes.length, true);
  view.setUint16(58, sourceKindBytes.length, true);
  view.setUint16(60, sourceIdBytes.length, true);
  view.setUint16(62, fieldGenerationIdBytes.length, true);
  view.setBigUint64(64, meshTopologyRevision, true);
  new Uint8Array(buffer, 72, 32).set(meshTopologyHash);
  view.setUint32(104, indexing, true);
  view.setUint32(108, nodeIndices.length, true);
  view.setUint16(112, scopeKindBytes.length, true);
  view.setUint16(114, scopeIdBytes.length, true);
  view.setBigUint64(116, sourceRevision, true);
  view.setUint16(128, quantityIdBytes.length, true);

  let offset = 48 + 88;
  for (const bytes of [
    scopeKindBytes,
    scopeIdBytes,
    domainGenerationIdBytes,
    sourceKindBytes,
    sourceIdBytes,
    fieldGenerationIdBytes,
    quantityIdBytes,
  ]) {
    new Uint8Array(buffer, offset, bytes.length).set(bytes);
    offset += bytes.length;
  }
  for (const nodeIndex of nodeIndices) {
    view.setUint32(offset, nodeIndex, true);
    offset += Uint32Array.BYTES_PER_ELEMENT;
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

  it("decodes source-qualified FMVP v4 metadata", () => {
    const decoded = decodeFieldVector(makeFieldVectorV4Buffer());

    expect(decoded).toMatchObject({
      domainGenerationId: "sha256:domain",
      fieldGenerationId: "field:frame-123:m:29",
      formatVersion: 4,
      meshTopologyRevision: "17",
      sourceId: "frame-123",
      sourceKind: "observation_frame",
      sourceRevision: "29",
    });
  });

  it("decodes the full quantity identity from source-qualified FMVP v5 metadata", () => {
    const quantityIds = [
      "analysis:eigen:sample-0001:mode-0001:delta_m_xyz",
      "analysis:eigen:sample-0001:mode-0002:delta_m_xyz",
    ];
    const buffers = quantityIds.map((quantityId) =>
      makeFieldVectorV5Buffer({
        fieldGenerationId: `field:${quantityId}:r7`,
        quantityId,
        sourceId: "run-7",
        sourceKind: "live",
        sourceRevision: BigInt(7),
      }),
    );
    const decoded = buffers.map(decodeFieldVector);
    const legacyPrefixes = buffers.map((buffer) =>
      Array.from(new Uint8Array(buffer, 28, 16)),
    );

    expect(decoded.map((field) => field.quantityId)).toEqual(quantityIds);
    expect(decoded[0]!.quantityId.slice(0, 16)).toBe(decoded[1]!.quantityId.slice(0, 16));
    expect(legacyPrefixes[0]).toEqual(legacyPrefixes[1]);
    expect(decoded.map((field) => field.formatVersion)).toEqual([5, 5]);
    expect(decoded[0]).toMatchObject({
      fieldGenerationId: `field:${quantityIds[0]}:r7`,
      sourceId: "run-7",
      sourceKind: "live",
      sourceRevision: "7",
    });
    expect(asDecodedComplexFieldVector(decoded[0]!)).toMatchObject({
      componentCount: 3,
      quantityId: quantityIds[0],
    });
  });

  it("validates an FMVP v5 quantity prefix as raw UTF-8 bytes at a split code point", () => {
    const quantityId = "analysis:eigen:α-mode";
    const buffer = makeFieldVectorV5Buffer({ quantityId });
    const quantityBytes = new TextEncoder().encode(quantityId);

    expect(new Uint8Array(buffer, 28, 16)[15]).toBe(quantityBytes[15]);
    expect(decodeFieldVector(buffer).quantityId).toBe(quantityId);
  });

  it("accepts a wholly unqualified FMVP v5 source only with zero source revision", () => {
    const decoded = decodeFieldVector(makeFieldVectorV5Buffer());

    expect(decoded).toMatchObject({
      fieldGenerationId: null,
      formatVersion: 5,
      sourceId: null,
      sourceKind: null,
      sourceRevision: null,
    });
    expect(() =>
      decodeFieldVector(makeFieldVectorV5Buffer({ sourceRevision: BigInt(1) })),
    ).toThrow(/unqualified source revision/);
    expect(() =>
      decodeFieldVector(makeFieldVectorV5Buffer({ sourceKind: "live" })),
    ).toThrow(/wholly qualified or empty/);
  });

  it("decodes only the declared FMVP v5 no-topology sentinel as absent topology", () => {
    const decoded = decodeFieldVector(
      makeFieldVectorV5Buffer({
        indexing: 3,
        meshTopologyHash: new Uint8Array(32),
        meshTopologyRevision: BigInt(0),
      }),
    );

    expect(decoded).toMatchObject({
      domainGenerationId: "sha256:domain",
      fieldGenerationId: null,
      formatVersion: 5,
      indexing: "legacy_count_only",
      meshTopologyHash: null,
      meshTopologyRevision: null,
    });
    expect(() =>
      decodeFieldVector(
        makeFieldVectorV5Buffer({
          indexing: 3,
          meshTopologyRevision: BigInt(0),
        }),
      ),
    ).toThrow(/absent-topology sentinel/);
    expect(() =>
      decodeFieldVector(makeFieldVectorV5Buffer({ indexing: 3 })),
    ).toThrow(/absent-topology sentinel/);
    expect(() =>
      decodeFieldVector(
        makeFieldVectorV5Buffer({
          indexing: 3,
          meshTopologyHash: new Uint8Array(32),
        }),
      ),
    ).toThrow(/absent-topology sentinel/);
    expect(() =>
      decodeFieldVector(
        makeFieldVectorV5Buffer({
          indexing: 3,
          meshTopologyHash: new Uint8Array(32),
          meshTopologyRevision: BigInt(0),
          nodeIndices: [0],
        }),
      ),
    ).toThrow(/absent-topology sentinel/);
  });

  it("preserves zero revisions when FMVP v5 carries a real topology hash", () => {
    const fullDomain = decodeFieldVector(
      makeFieldVectorV5Buffer({ meshTopologyRevision: BigInt(0) }),
    );
    expect(fullDomain).toMatchObject({
      indexing: "full_domain",
      meshTopologyHash: "ab".repeat(32),
      meshTopologyRevision: "0",
    });

    const explicitNodes = decodeFieldVector(
      makeFieldVectorV5Buffer({
        indexing: 1,
        meshTopologyRevision: BigInt(0),
        nodeIndices: [0],
      }),
    );
    expect(explicitNodes).toMatchObject({
      indexing: "explicit_node_indices",
      meshTopologyHash: "ab".repeat(32),
      meshTopologyRevision: "0",
    });
  });

  it("rejects malformed FMVP v5 quantity length, prefix, reserved bytes, padding, and control IDs", () => {
    const badQuantityLength = makeFieldVectorV5Buffer();
    new DataView(badQuantityLength).setUint16(128, 0xffff, true);
    expect(() => decodeFieldVector(badQuantityLength)).toThrow(/lengths exceed/);

    const emptyQuantityId = makeFieldVectorV5Buffer();
    new DataView(emptyQuantityId).setUint16(128, 0, true);
    expect(() => decodeFieldVector(emptyQuantityId)).toThrow(/must not be empty/);

    const invalidUtf8QuantityId = makeFieldVectorV5Buffer();
    const quantityOffset =
      48 +
      88 +
      new TextEncoder().encode("full").length +
      new TextEncoder().encode("sha256:domain").length;
    new DataView(invalidUtf8QuantityId).setUint8(quantityOffset, 0xff);
    expect(() => decodeFieldVector(invalidUtf8QuantityId)).toThrow();

    const badPrefix = makeFieldVectorV5Buffer();
    new DataView(badPrefix).setUint8(28, new DataView(badPrefix).getUint8(28) ^ 1);
    expect(() => decodeFieldVector(badPrefix)).toThrow(/prefix does not match/);

    const nonzeroReserved = makeFieldVectorV5Buffer();
    new DataView(nonzeroReserved).setUint8(130, 1);
    expect(() => decodeFieldVector(nonzeroReserved)).toThrow(/reserved bytes/);

    const nonzeroPadding = makeFieldVectorV5Buffer();
    const paddingView = new DataView(nonzeroPadding);
    const metadataLength = paddingView.getUint32(8, true);
    paddingView.setUint8(48 + metadataLength - 1, 1);
    expect(() => decodeFieldVector(nonzeroPadding)).toThrow(/padding bytes/);

    expect(() =>
      decodeFieldVector(makeFieldVectorV5Buffer({ quantityId: "analysis:eigen:\u0000bad" })),
    ).toThrow(/control characters/);
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
