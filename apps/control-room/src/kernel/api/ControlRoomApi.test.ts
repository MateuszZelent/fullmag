import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  collectFieldVectorIdentityIssues,
  ControlRoomApi,
  ControlRoomApiError,
  MAX_TOPOLOGY_BYTES,
  parseFieldVectorResponseMetadata,
  transformFieldMetaForDisplay,
  transformFieldVectorForDisplay,
  withDerivedDriveFluxDensity,
} from "./ControlRoomApi";
import type {
  AuthoringTransactionRequest,
  BinaryResourceResult,
  CurrentTransportMutationRequest,
  FdmSingleGridFieldVectorQuery,
  FdmScopedFieldVectorQuery,
  FieldVectorResponseMetadata,
  LiveStatusResource,
  SimulationPreparationResource,
} from "./apiTypes";
import { SIMULATION_PREPARATION_PATH } from "./apiPaths";
import type { DecodedFieldVector } from "./codecs";
import { RequestDiagnosticsController } from "./RequestDiagnosticsController";
import { activeLaneCapabilityFixture } from "../resources/activeLaneCapabilityFixture.testSupport";

const contractHeaders = { "x-api-contract-version": "1.0.0" };

describe("derived B_drive display quantity", () => {
  it("adds B_drive to a catalog only when H_drive exists", () => {
    const catalog = withDerivedDriveFluxDensity({
      domain_generation_id: "domain-1",
      revision: 7,
      quantities: [{ available: true, components: 3, domain: "magnetic_only", domain_generation_id: "domain-1", field_revision: 4, kind: "vector", label: "Drive field", location: "node", materialization_wall_time_ns: 0, materialized_at_unix_ms: 0, quantity_id: "H_drive", source_revision: 4, source_step: 0, spatial: true, stale_by_steps: 0, state: "complete", ui_exposed: true, unit: "A/m" }],
    });
    expect(catalog.quantities.at(-1)).toMatchObject({
      label: "Drive flux density",
      quantity_id: "B_drive",
      unit: "T",
    });
  });

  it("converts H_drive metadata and values by mu0 without changing stored data", () => {
    const meta = transformFieldMetaForDisplay("B_drive", {
      components: 3,
      domain_generation_id: "domain-1",
      field_revision: 4,
      kind: "vector",
      label: "Drive field",
      location: "node",
      materialization_wall_time_ns: 0,
      materialized_at_unix_ms: 0,
      quantity_id: "H_drive",
      source_revision: 4,
      source_step: 0,
      stale_by_steps: 0,
      state: "complete",
      stats: { min: -2, mean: 0, max: 3 },
      unit: "A/m",
    });
    expect(meta.quantity_id).toBe("B_drive");
    expect(meta.unit).toBe("T");
    expect(meta.stats?.max).toBeCloseTo(3 * 4e-7 * Math.PI, 15);

    const sourceValues = new Float64Array([1, -2, 3]);
    const converted = transformFieldVectorForDisplay("B_drive", {
      byteLength: sourceValues.byteLength,
      data: { dtype: "float64", grid: [1, 1, 1], nComp: 3, pointCount: 1, quantityId: "H_drive", valueCount: 3, values: sourceValues },
      etag: "drive-4",
      responseMetadata: { component: "full", domainGenerationId: "domain-1", encoding: "FMVP;version=3", fieldIndexing: "full_domain", fieldRevision: "4", identityIssues: [], meshTopologyHash: "mesh", nComp: 3, nodeIndexCount: 0, pointCount: 1, quantityId: "H_drive", scopeId: null, scopeKind: "magnetic_only", snapshotId: null, valueCount: 3 },
      status: "ready",
    });
    expect(converted.status).toBe("ready");
    if (converted.status !== "ready") throw new Error("expected ready result");
    expect(converted.data.quantityId).toBe("B_drive");
    expect(converted.data.values[1]).toBeCloseTo(-2 * 4e-7 * Math.PI, 15);
    expect(sourceValues[1]).toBe(-2);
    expect(converted.responseMetadata.quantityId).toBe("B_drive");
  });
});

describe("field vector response metadata", () => {
  it("requires response metadata for ready typed field-vector results", () => {
    type Ready = Extract<
      BinaryResourceResult<DecodedFieldVector, FieldVectorResponseMetadata>,
      { status: "ready" }
    >;
    expectTypeOf<Ready["responseMetadata"]>().toEqualTypeOf<
      FieldVectorResponseMetadata
    >();
    expectTypeOf<Ready["responseMetadata"]["identityIssues"]>().toEqualTypeOf<
      FieldVectorResponseMetadata["identityIssues"]
    >();
  });

  it("parses every documented response header and reports invalid numbers", () => {
    const headers = new Headers({
      "x-fullmag-component": "full",
      "x-fullmag-domain-generation-id": "12",
      "x-fullmag-encoding": "FMVP;version=3",
      "x-fullmag-field-indexing": "explicit_node_indices",
      "x-fullmag-field-revision": "7",
      "x-fullmag-mesh-topology-hash": "abc",
      "x-fullmag-n-comp": "3",
      "x-fullmag-node-index-count": "2",
      "x-fullmag-point-count": "2",
      "x-fullmag-quantity-id": "m",
      "x-fullmag-scope-id": "body",
      "x-fullmag-scope-kind": "object",
      "x-fullmag-snapshot-id": "point-1",
      "x-fullmag-value-count": "not-a-number",
    });
    expect(parseFieldVectorResponseMetadata(headers)).toMatchObject({
      component: "full",
      domainGenerationId: "12",
      encoding: "FMVP;version=3",
      fieldIndexing: "explicit_node_indices",
      fieldRevision: "7",
      meshTopologyHash: "abc",
      nComp: 3,
      nodeIndexCount: 2,
      pointCount: 2,
      quantityId: "m",
      scopeId: "body",
      scopeKind: "object",
      snapshotId: "point-1",
      valueCount: null,
    });
    expect(parseFieldVectorResponseMetadata(new Headers())).toMatchObject({
      pointCount: null,
      quantityId: null,
    });
  });

  it("returns null independently for every absent response header", () => {
    const mappings = [
      ["x-fullmag-component", "component"],
      ["x-fullmag-domain-generation-id", "domainGenerationId"],
      ["x-fullmag-encoding", "encoding"],
      ["x-fullmag-field-indexing", "fieldIndexing"],
      ["x-fullmag-field-revision", "fieldRevision"],
      ["x-fullmag-mesh-topology-hash", "meshTopologyHash"],
      ["x-fullmag-n-comp", "nComp"],
      ["x-fullmag-node-index-count", "nodeIndexCount"],
      ["x-fullmag-point-count", "pointCount"],
      ["x-fullmag-quantity-id", "quantityId"],
      ["x-fullmag-scope-id", "scopeId"],
      ["x-fullmag-scope-kind", "scopeKind"],
      ["x-fullmag-snapshot-id", "snapshotId"],
      ["x-fullmag-value-count", "valueCount"],
    ] as const;
    for (const [header, property] of mappings) {
      const headers = new Headers(
        Object.fromEntries(mappings.map(([name]) => [name, "1"])),
      );
      headers.delete(header);
      expect(parseFieldVectorResponseMetadata(headers)[property], header).toBeNull();
    }
  });

  it("returns null independently for every invalid numeric response header", () => {
    const mappings = [
      ["x-fullmag-n-comp", "nComp"],
      ["x-fullmag-node-index-count", "nodeIndexCount"],
      ["x-fullmag-point-count", "pointCount"],
      ["x-fullmag-value-count", "valueCount"],
    ] as const;
    for (const invalid of ["NaN", "1.5", "-1", "", "9007199254740992"]) {
      for (const [header, property] of mappings) {
        expect(
          parseFieldVectorResponseMetadata(new Headers({ [header]: invalid }))[
            property
          ],
          `${header}=${invalid}`,
        ).toBeNull();
      }
    }
  });

  it("reports header versus FMVP identity mismatches without rejecting legacy v2", () => {
    const decoded = {
      dtype: "float64" as const,
      formatVersion: 3 as const,
      grid: [1, 1, 1] as [number, number, number],
      indexing: "full_domain" as const,
      meshTopologyHash: "payload-hash",
      nComp: 3,
      nodeIndices: null,
      pointCount: 1,
      quantityId: "m",
      scopeId: "body",
      scopeKind: "object" as const,
      valueCount: 3,
      values: new Float64Array(3),
    };
    const issues = collectFieldVectorIdentityIssues(decoded, {
      component: null,
      domainGenerationId: null,
      encoding: null,
      identityIssues: [],
      fieldIndexing: "explicit_node_indices",
      fieldRevision: null,
      meshTopologyHash: "header-hash",
      nComp: 1,
      nodeIndexCount: 2,
      pointCount: 2,
      quantityId: "H_demag",
      scopeId: "air",
      scopeKind: "airbox",
      snapshotId: null,
      valueCount: 2,
    });
    expect(issues.map((issue) => issue.field)).toEqual(
      expect.arrayContaining([
        "quantityId",
        "pointCount",
        "valueCount",
        "nComp",
        "scopeKind",
        "scopeId",
        "meshTopologyHash",
        "fieldIndexing",
        "nodeIndexCount",
      ]),
    );
    expect(
      collectFieldVectorIdentityIssues(
        { ...decoded, formatVersion: 2, indexing: "legacy_count_only" },
        parseFieldVectorResponseMetadata(new Headers()),
      ),
    ).toEqual([]);

    const trustedV2Metadata = parseFieldVectorResponseMetadata(
      new Headers({
        "x-fullmag-domain-generation-id": "fdm-7",
        "x-fullmag-encoding": "FMVP;version=2",
        "x-fullmag-field-revision": "12",
        "x-fullmag-n-comp": "3",
        "x-fullmag-point-count": "1",
        "x-fullmag-quantity-id": "m",
        "x-fullmag-scope-id": "airbox",
        "x-fullmag-scope-kind": "airbox",
        "x-fullmag-value-count": "3",
      }),
    );
    expect(
      collectFieldVectorIdentityIssues(
        { ...decoded, formatVersion: 2, indexing: "legacy_count_only" },
        trustedV2Metadata,
      ),
    ).toEqual([]);
  });
});

const resourceRevisions: LiveStatusResource["resources"] = {
  artifact_revision: 0,
  artifacts_revision: 0,
  command_completion_revision: 0,
  commands_revision: 0,
  display_revision: 0,
  domain_generation_id: "0",
  engine_log_revision: 0,
  field_catalog_revision: 0,
  field_revision: 0,
  fields_revision: 0,
  mesh_build_revision: 0,
  mesh_revision: 0,
  region_coefficients_revision: 0,
  region_initial_state_revision: 0,
  region_membership_revision: 0,
  region_topology_revision: 0,
  scalars_revision: 0,
  scene_revision: null,
  simulation_preparation_revision: 0,
  slice_revision: 0,
  solver_profile_revision: 0,
  stages_revision: 0,
  topology_revision: 0,
  visualization_state_revision: 0,
  workspace_revision: 0,
};

function liveStatusFixture(
  resources: Partial<LiveStatusResource["resources"]> = {},
): LiveStatusResource {
  return {
    api_contract_version: "1.0.0",
    capabilities: {
      active_lane: activeLaneCapabilityFixture(),
      algorithms_available: [],
      binary_fields: true,
      cell_fields: true,
      eigen_modes: false,
      explicit_topology: false,
      gpu_telemetry: true,
      node_fields: false,
      preview_2d: true,
      preview_3d: true,
      scalar_history: true,
      structured_grid: true,
    },
    display: {
      active_quantity_id: "m",
      auto_contrast: true,
      colormap: "viridis",
      contrast_max: null,
      contrast_min: null,
      field_component: "magnitude",
      max_points: 1000,
      slice_layer: 0,
      slice_mode: "xy",
      vector_density: 1,
      vector_glyphs: true,
      view_mode: "3d",
      x_chosen_size: 1,
      y_chosen_size: 1,
    },
    domain: {
      cell_count: 1,
      discretization: "fdm",
      generation_id: "0",
    },
    energies: {},
    metrics: {
      steps_per_second: null,
      total_steps: 0,
      uptime_seconds: 0,
    },
    resources: {
      ...resourceRevisions,
      ...resources,
    },
    run: null,
    runtime_bundle_version: "dev",
    session: {
      created_at: "0",
      name: "test",
      session_id: "session-1",
      workspace_root: "/tmp/fullmag",
    },
    solver: {
      state: "idle",
    },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("x-api-contract-version")) {
    headers.set("x-api-contract-version", "1.0.0");
  }

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

function binaryResponse(body: ArrayBuffer, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("x-api-contract-version")) {
    headers.set("x-api-contract-version", "1.0.0");
  }

  return new Response(body, {
    ...init,
    headers,
  });
}

function parseRequestJsonBody(body: unknown): unknown {
  if (body instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(body));
  }
  if (ArrayBuffer.isView(body)) {
    return JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      ),
    );
  }
  return JSON.parse(String(body));
}

function makeTableRowsBuffer(values: readonly number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(60 + values.length * Float64Array.BYTES_PER_ELEMENT);
  const bytes = new Uint8Array(buffer);
  bytes.set([70, 77, 84, 66], 0);
  const view = new DataView(buffer);
  view.setUint16(4, 1, true);
  view.setUint16(6, 1, true);
  view.setBigUint64(8, BigInt(12), true);
  view.setBigUint64(16, BigInt(1), true);
  view.setBigUint64(24, BigInt(11), true);
  view.setBigUint64(32, BigInt(12), true);
  view.setBigUint64(40, BigInt(12), true);
  view.setBigUint64(48, BigInt(2), true);
  view.setUint32(56, 3, true);
  for (let i = 0; i < values.length; i++) {
    view.setFloat64(60 + i * 8, values[i], true);
  }
  return buffer;
}

function parseByteRange(range: string): [number, number] {
  const match = /^bytes=(\d+)-(\d+)$/.exec(range);
  if (!match) {
    throw new Error(`Unexpected byte range ${range}`);
  }
  return [Number(match[1]), Number(match[2])];
}

function makeTopologyBuffer(): ArrayBuffer {
  const nodeCount = 4;
  const elementCount = 1;
  const boundaryFaceCount = 1;
  const markerCount = 1;
  const byteLength =
    32 +
    nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT +
    elementCount * 4 * Uint32Array.BYTES_PER_ELEMENT +
    boundaryFaceCount * 3 * Uint32Array.BYTES_PER_ELEMENT +
    markerCount * Uint32Array.BYTES_PER_ELEMENT +
    markerCount * Uint32Array.BYTES_PER_ELEMENT;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMMT"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setUint32(8, nodeCount, true);
  view.setUint32(12, elementCount, true);
  view.setUint32(16, boundaryFaceCount, true);
  view.setUint32(20, markerCount, true);
  view.setUint32(24, markerCount, true);

  let offset = 32;
  new Float64Array(buffer, offset, nodeCount * 3).set([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ]);
  offset += nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, 4).set([0, 1, 2, 3]);
  offset += 4 * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, 3).set([0, 1, 2]);
  offset += 3 * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, 1).set([10]);
  offset += Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, 1).set([20]);
  return buffer;
}

function makePeriodicPairsBuffer(): ArrayBuffer {
  const pairId = new TextEncoder().encode("x-minus");
  const byteLength = 20 + 4 + pairId.byteLength + 9 * 4 + 2 * 8;
  const buffer = new ArrayBuffer(byteLength);
  const bytes = new Uint8Array(buffer);
  bytes.set([70, 77, 80, 80], 0);
  const view = new DataView(buffer);
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setBigUint64(8, BigInt(41), true);
  view.setUint32(16, 1, true);

  let offset = 20;
  view.setUint32(offset, pairId.byteLength, true);
  offset += 4;
  bytes.set(pairId, offset);
  offset += pairId.byteLength;
  view.setUint32(offset, 10, true);
  offset += 4;
  view.setUint32(offset, 20, true);
  offset += 4;
  view.setUint32(offset, 1, true);
  offset += 4;
  view.setUint32(offset, 1, true);
  offset += 4;
  view.setUint32(offset, 7, true);
  offset += 4;
  view.setUint32(offset, 17, true);
  offset += 4;
  view.setBigUint64(offset, BigInt(101), true);
  offset += 8;
  view.setBigUint64(offset, BigInt(202), true);
  offset += 8;
  view.setUint32(offset, 1, true);
  offset += 4;
  view.setUint32(offset, 7, true);
  offset += 4;
  view.setUint32(offset, 17, true);
  return buffer;
}

function makeLargeTopologyBuffer(): ArrayBuffer {
  const nodeCount = 700_000;
  const elementCount = 1;
  const boundaryFaceCount = 1;
  const markerCount = 1;
  const byteLength =
    32 +
    nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT +
    elementCount * 4 * Uint32Array.BYTES_PER_ELEMENT +
    boundaryFaceCount * 3 * Uint32Array.BYTES_PER_ELEMENT +
    markerCount * Uint32Array.BYTES_PER_ELEMENT +
    markerCount * Uint32Array.BYTES_PER_ELEMENT;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMMT"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setUint32(8, nodeCount, true);
  view.setUint32(12, elementCount, true);
  view.setUint32(16, boundaryFaceCount, true);
  view.setUint32(20, markerCount, true);
  view.setUint32(24, markerCount, true);

  let offset = 32 + nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, 4).set([0, 1, 2, 3]);
  offset += 4 * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, 3).set([0, 1, 2]);
  offset += 3 * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, markerCount).set([10]);
  offset += markerCount * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, markerCount).set([20]);
  return buffer;
}

function makeLargeMixedTopologyBuffer(): ArrayBuffer {
  const align = (value: number) => Math.ceil(value / 8) * 8;
  const nodeCount = 700_000;
  const cellTypes = [1, 2, 3];
  const cellOffsets = [0, 4, 10, 15];
  const cellNodes = [0, 1, 2, 3, 0, 1, 2, 4, 5, 6, 0, 1, 2, 3, 7];
  const facetTypes = [1, 2];
  const facetRoles = [1, 2];
  const facetOffsets = [0, 3, 7];
  const facetNodes = [0, 1, 2, 0, 1, 4, 3];
  const cellMarkers = [10, 11, 12];
  const facetMarkers = [20, 21];
  const cellGlobalOrdinals = [
    BigInt(10),
    BigInt("9007199254740993"),
    BigInt("18446744073709551615"),
  ];
  const facetGlobalOrdinals = [BigInt(20), BigInt("9007199254740995")];

  let offset = 64;
  offset = align(offset + nodeCount * 3 * 8);
  const cellTypesOffset = offset;
  offset = align(offset + cellTypes.length * 4);
  const cellOffsetsOffset = offset;
  offset = align(offset + cellOffsets.length * 4);
  const cellNodesOffset = offset;
  offset = align(offset + cellNodes.length * 4);
  const facetTypesOffset = offset;
  offset = align(offset + facetTypes.length * 4);
  const facetRolesOffset = offset;
  offset = align(offset + facetRoles.length * 4);
  const facetOffsetsOffset = offset;
  offset = align(offset + facetOffsets.length * 4);
  const facetNodesOffset = offset;
  offset = align(offset + facetNodes.length * 4);
  const cellMarkersOffset = offset;
  offset = align(offset + cellMarkers.length * 4);
  const facetMarkersOffset = offset;
  offset = align(offset + facetMarkers.length * 4);
  const cellGlobalOrdinalsOffset = offset;
  offset = align(offset + cellGlobalOrdinals.length * 8);
  const facetGlobalOrdinalsOffset = offset;
  const buffer = new ArrayBuffer(
    facetGlobalOrdinalsOffset + facetGlobalOrdinals.length * 8,
  );
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMMT"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 2);
  view.setUint8(5, 1);
  view.setUint32(8, nodeCount, true);
  view.setUint32(12, cellTypes.length, true);
  view.setUint32(16, facetTypes.length, true);
  view.setUint32(20, cellNodes.length, true);
  view.setUint32(24, facetNodes.length, true);
  view.setUint32(28, cellMarkers.length, true);
  view.setUint32(32, facetMarkers.length, true);
  view.setUint32(36, 64, true);
  view.setUint32(40, cellGlobalOrdinals.length, true);
  view.setUint32(44, facetGlobalOrdinals.length, true);
  new Uint32Array(buffer, cellTypesOffset, cellTypes.length).set(cellTypes);
  new Uint32Array(buffer, cellOffsetsOffset, cellOffsets.length).set(cellOffsets);
  new Uint32Array(buffer, cellNodesOffset, cellNodes.length).set(cellNodes);
  new Uint32Array(buffer, facetTypesOffset, facetTypes.length).set(facetTypes);
  new Uint32Array(buffer, facetRolesOffset, facetRoles.length).set(facetRoles);
  new Uint32Array(buffer, facetOffsetsOffset, facetOffsets.length).set(facetOffsets);
  new Uint32Array(buffer, facetNodesOffset, facetNodes.length).set(facetNodes);
  new Uint32Array(buffer, cellMarkersOffset, cellMarkers.length).set(cellMarkers);
  new Uint32Array(buffer, facetMarkersOffset, facetMarkers.length).set(facetMarkers);
  new BigUint64Array(
    buffer,
    cellGlobalOrdinalsOffset,
    cellGlobalOrdinals.length,
  ).set(cellGlobalOrdinals);
  new BigUint64Array(
    buffer,
    facetGlobalOrdinalsOffset,
    facetGlobalOrdinals.length,
  ).set(facetGlobalOrdinals);
  return buffer;
}

function makeFieldVectorBuffer(): ArrayBuffer {
  const buffer = new ArrayBuffer(48 + 3 * Float64Array.BYTES_PER_ELEMENT);
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMVP"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 2);
  view.setUint8(5, 1);
  view.setUint8(6, 3);
  view.setUint32(12, 3, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, 1, true);
  new TextEncoder().encodeInto("m", new Uint8Array(buffer, 28, 16));
  new Float64Array(buffer, 48).set([1, 0, -1]);
  return buffer;
}

function makeMeshQualityDataBuffer(): ArrayBuffer {
  const elementCount = 1;
  const buffer = new ArrayBuffer(32 + 3 * Float64Array.BYTES_PER_ELEMENT);
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMMQ"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setUint32(8, elementCount, true);
  view.setUint32(12, 0b111, true);
  new Float64Array(buffer, 32).set([0.5, 0.25, 1 / 6]);
  return buffer;
}

function makeCrossSectionBuffer(): ArrayBuffer {
  const polygonCount = 1;
  const vertexCount = 3;
  const segmentCount = 1;
  const buffer = new ArrayBuffer(
    64 +
      vertexCount * 2 * Float32Array.BYTES_PER_ELEMENT +
      (polygonCount + 1) * Uint32Array.BYTES_PER_ELEMENT +
      polygonCount * Uint32Array.BYTES_PER_ELEMENT +
      segmentCount * 4 * Float32Array.BYTES_PER_ELEMENT +
      vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT +
      vertexCount * 2 * Uint32Array.BYTES_PER_ELEMENT +
      vertexCount * Float32Array.BYTES_PER_ELEMENT +
      vertexCount * Uint32Array.BYTES_PER_ELEMENT,
  );
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMCS"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint32(4, 2, true);
  view.setUint32(8, polygonCount, true);
  view.setUint32(12, vertexCount, true);
  view.setUint32(16, segmentCount, true);
  view.setUint32(20, polygonCount, true);
  view.setUint32(24, vertexCount, true);
  view.setUint32(28, 1, true);
  view.setFloat64(32, 0, true);
  view.setFloat64(40, 1, true);
  view.setFloat64(48, 0, true);
  view.setFloat64(56, 1, true);

  let offset = 64;
  new Float32Array(buffer, offset, vertexCount * 2).set([
    0, 0,
    0.5, 0,
    0, 0.5,
  ]);
  offset += vertexCount * 2 * Float32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, polygonCount + 1).set([0, 3]);
  offset += (polygonCount + 1) * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, polygonCount).set([7]);
  offset += polygonCount * Uint32Array.BYTES_PER_ELEMENT;
  new Float32Array(buffer, offset, segmentCount * 4).set([0, 0, 0.5, 0]);
  offset += segmentCount * 4 * Float32Array.BYTES_PER_ELEMENT;
  new Float32Array(buffer, offset, vertexCount * 3).set([
    0, 0, 0.5,
    0.5, 0, 0.5,
    0, 0.5, 0.5,
  ]);
  offset += vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, vertexCount * 2).set([0, 0, 0, 3, 1, 3]);
  offset += vertexCount * 2 * Uint32Array.BYTES_PER_ELEMENT;
  new Float32Array(buffer, offset, vertexCount).set([0, 0.5, 0.5]);
  offset += vertexCount * Float32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, vertexCount).set([1, 0, 0]);

  return buffer;
}

function makeCrossSectionQualityBuffer(): ArrayBuffer {
  const buffer = new ArrayBuffer(20 + Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMQS"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint32(4, 1, true);
  view.setUint32(8, 1, true);
  view.setFloat32(12, 0.25, true);
  view.setFloat32(16, 0.25, true);
  new Float32Array(buffer, 20, 1).set([0.25]);
  return buffer;
}

function parseRequestBody(body: BodyInit | null | undefined): unknown {
  if (body instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(body));
  }

  return JSON.parse(String(body));
}

describe("ControlRoomApi", () => {
  it("loads preparation through the simulation facade", async () => {
    let observedInit: RequestInit | undefined;
    let observedUrl = "";
    const preparation = {
      active_stage_id: "planning",
      completed_at_unix_ms: null,
      failure: null,
      log_tail: [],
      preparation_id: "prep-1",
      requested_execution: {
        backend: "fdm",
        device: "gpu",
        engine_id: null,
        mode: "strict",
        precision: "double",
        runtime_family: null,
        worker: null,
      },
      resolved_execution: null,
      revision: 7,
      stages: [],
      started_at_unix_ms: 1_000,
      status: "running",
    } satisfies SimulationPreparationResource;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      observedUrl = String(url);
      observedInit = init;
      return jsonResponse(preparation);
    });
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl,
      requestIdFactory: () => "req-preparation",
    });
    const controller = new AbortController();

    await expect(
      api.simulation.preparation({ signal: controller.signal }),
    ).resolves.toMatchObject({ revision: 7 });

    expect(observedUrl).toBe(
      `http://127.0.0.1:8765${SIMULATION_PREPARATION_PATH}`,
    );
    expect(observedInit?.signal?.aborted).toBe(false);
    controller.abort();
    expect(observedInit?.signal?.aborted).toBe(true);
  });

  it("sends a request when the browser exposes crypto without randomUUID", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues(values: Uint8Array) {
        values.fill(0xab);
        return values;
      },
    });
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      return jsonResponse(liveStatusFixture({ fields_revision: 7 }), init);
    });
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl,
    });

    try {
      await expect(api.sessions.current.status()).resolves.toMatchObject({
        resources: { fields_revision: 7 },
      });
    } finally {
      vi.unstubAllGlobals();
    }

    const requestId = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get(
      "x-request-id",
    );
    expect(requestId).toBe("abababab-abab-4bab-abab-abababababab");
  });

  it("loads current session status through the v2 resource path", async () => {
    let observedInit: RequestInit | undefined;
    let observedUrl = "";
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      observedUrl = String(url);
      observedInit = init;
      return jsonResponse(liveStatusFixture({ fields_revision: 7 }));
    });

    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl,
      requestIdFactory: () => "req-1",
    });

    const status = await api.sessions.current.status();

    expect(status.resources.fields_revision).toBe(7);
    const headers = new Headers(observedInit?.headers);
    expect(observedUrl).toBe("http://127.0.0.1:8765/v2/sessions/current/status");
    expect(observedInit?.method).toBe("GET");
    expect(headers.get("x-request-id")).toBe("req-1");
    expect(headers.get("x-fullmag-contract-version")).toBeNull();
  });

  it("loads magnetic response sweep artifacts through the analysis facade", async () => {
    let observedInit: RequestInit | undefined;
    let observedUrl = "";
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      observedUrl = String(url);
      observedInit = init;
      return jsonResponse({
        frequencies: [{ frequency_hz: 1e9, response_amplitude: 2.5 }],
        schema_version: "magnetic_response_sweep.v1",
      });
    });

    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl,
      requestIdFactory: () => "req-response",
    });

    const artifact = await api.analysis.frequencyResponse.magneticSweepV1();

    expect(artifact.schema_version).toBe("magnetic_response_sweep.v1");
    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/analysis/frequency-response/magnetic-sweep.v1",
    );
    expect(observedInit?.method).toBe("GET");
    expect(new Headers(observedInit?.headers).get("x-request-id")).toBe(
      "req-response",
    );
  });

  it("loads frequency-domain solver family manifest through the analysis facade", async () => {
    let observedInit: RequestInit | undefined;
    let observedUrl = "";
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      observedUrl = String(url);
      observedInit = init;
      return jsonResponse({
        eigen_namespace: "eigen",
        eigenmodes: {
          diagnostics_json: "{}",
          driven_response_available: false,
          dynamic_demag_k_available: false,
          floquet_modal_available: false,
          floquet_response_available: false,
          gpu_available: false,
          modal_solver_available: false,
          static_periodic_response_available: false,
          reason: "native FEM modal dynamic-matrix solver is not implemented",
          status: "unavailable",
          study_kind: "eigenmodes",
        },
        existing_frequency_response_namespace_preserved: true,
        family_namespace: "frequencyDomain",
        floquet_nonzero_k_demag_supported: false,
        floquet_nonzero_k_response_supported: false,
        response: {
          diagnostics_json:
            '{"schema_version":"frequency_domain_availability.v1","execution_lane":"native_fem_mfem_frequency_domain_cpu","scope":"gamma_free_or_static_periodic_magnetic_response"}',
          driven_response_available: true,
          dynamic_demag_k_available: false,
          floquet_modal_available: false,
          floquet_response_available: false,
          gpu_available: false,
          modal_solver_available: false,
          static_periodic_response_available: true,
          reason: "",
          status: "ok",
          study_kind: "frequency_response",
        },
        response_progress: null,
        result_manifest: {
          artifact_path: "frequency_domain/manifest.v1.json",
          payload: {
            physics: {
              analysis_family: "magnetic_frequency_domain",
              field_units: "dimensionless_delta_m",
              frequency_units: "Hz",
              normalization: "unit_l2",
              phase_convention: "exp_minus_i_omega_t",
            },
            schema_version: "frequency_domain_manifest.v1",
            stage_kind: "eigenmodes",
          },
          resource_key:
            "/v2/sessions/current/analysis/frequency-domain/manifest.v1",
          schema_version: "frequency_domain_manifest.v1",
          status: "ready",
        },
        schema_version: "frequency_domain_manifest.v1",
      });
    });

    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl,
      requestIdFactory: () => "req-frequency-domain",
    });

    const manifest = await api.analysis.frequencyDomain.manifestV1();

    expect(manifest.schema_version).toBe("frequency_domain_manifest.v1");
    expect(manifest.existing_frequency_response_namespace_preserved).toBe(true);
    expect(manifest.response.study_kind).toBe("frequency_response");
    expect(manifest.response.status).toBe("ok");
    expect(manifest.response.driven_response_available).toBe(true);
    expect(manifest.response.floquet_response_available).toBe(false);
    expect(manifest.response.gpu_available).toBe(false);
    expect(manifest.eigenmodes.study_kind).toBe("eigenmodes");
    expect(manifest.result_manifest?.payload).toMatchObject({
      physics: {
        analysis_family: "magnetic_frequency_domain",
        field_units: "dimensionless_delta_m",
        frequency_units: "Hz",
        normalization: "unit_l2",
        phase_convention: "exp_minus_i_omega_t",
      },
    });
    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/analysis/frequency-domain/manifest.v1",
    );
    expect(observedInit?.method).toBe("GET");
    expect(new Headers(observedInit?.headers).get("x-request-id")).toBe(
      "req-frequency-domain",
    );
  });

  it("loads object topological charge through the analysis extensions facade", async () => {
    let observedInit: RequestInit | undefined;
    let observedUrl = "";
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      observedUrl = String(url);
      observedInit = init;
      return jsonResponse({
        charge: null,
        computed_at_unix_ms: 0,
        domain_generation_id: null,
        field_revision: null,
        integer_error: null,
        mesh_generation_id: null,
        mesh_revision: null,
        method: "berg_luescher",
        nearest_integer: null,
        object_id: "permalloy_layer",
        plane: "auto",
        polarity: null,
        quantity_id: "m",
        revision: 1,
        sample_count: 0,
        sample_grid: null,
        sample_topology: null,
        layer_samples: [],
        status: "no_current_magnetization",
        valid_sample_count: 0,
        warnings: [],
      });
    });

    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl,
      requestIdFactory: () => "req-topological-charge",
    });

    const resource = await api.analysis.extensions.objects.topologicalCharge(
      "permalloy_layer",
      { plane: "xy", support: "layer_profile", profile_samples: 17 },
    );

    expect(resource.status).toBe("no_current_magnetization");
    expect(resource.object_id).toBe("permalloy_layer");
    const observed = new URL(observedUrl);
    expect(`${observed.origin}${observed.pathname}`).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/analysis/extensions/objects/permalloy_layer/topological-charge",
    );
    expect(Object.fromEntries(observed.searchParams.entries())).toEqual({
      plane: "xy",
      support: "layer_profile",
      profile_samples: "17",
    });
    expect(observedInit?.method).toBe("GET");
    expect(new Headers(observedInit?.headers).get("x-request-id")).toBe(
      "req-topological-charge",
    );
  });

  it("loads frequency-domain artifact resources through the analysis facade", async () => {
    const observedUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url);
      observedUrls.push(target);
      if (target.endsWith("/response/progress.v1")) {
        return jsonResponse({
          completed_frequency_points: 1,
          current_frequency_hz: 1e9,
          latest_artifact_manifest_path: null,
          missing_reason: null,
          partial_artifacts_available: true,
          schema_version: "frequency_domain_sweep_progress.v1",
          state: "completed",
          status: "ready",
          total_frequency_points: 2,
          written_frequency_point_artifacts: 1,
        });
      }
      if (target.endsWith("/response/cancel-requested.v1")) {
        return jsonResponse({
          completed_frequency_points: 1,
          current_frequency_hz: 1e9,
          latest_artifact_manifest_path: "response/artifact_manifest.json",
          missing_reason: null,
          partial_artifacts_available: true,
          progress_json:
            '{"schema_version":"frequency_domain_sweep_progress.v1","state":"cancel_requested"}',
          schema_version: "frequency_domain_sweep_progress.v1",
          state: "cancel_requested",
          status: "cancel_requested",
          total_frequency_points: 2,
          written_frequency_point_artifacts: 1,
        });
      }
      if (target.endsWith("/response/field/7/meta")) {
        return jsonResponse({
          artifact_path: "response/field_payloads/frequency_0007/vector_xyz.bin",
          available_views: [
            "complex",
            "real",
            "imag",
            "amplitude",
            "phase",
            "phase_rotated_real",
          ],
          binary_layout: "complex_f64_pairs_little_endian",
          complex_pair_count: 6,
          component_basis: "global_xyz",
          component_count: 3,
          components: ["x", "y", "z"],
          default_phase_rad: 0,
          default_view: "phase_rotated_real",
          field_id: "analysis:frequency-response:frequency-0007",
          missing_reason: null,
          payload_encoding: "f64_interleaved_real_imag_xyz",
          payload_value_count: 12,
          quantity: "delta_m",
          resource_key:
            "/v2/sessions/current/data/fields/analysis:frequency-response:frequency-0007/samples/vector?view=phase_rotated_real&phase_rad=0",
          schema_version: "frequency_domain_response_field.v1",
          source_family: "analysis/frequency-response",
          status: "ready",
          tangent_component_basis: "local_tangent_frame",
          tangent_component_count: 2,
          tangent_components: ["tangent_e1", "tangent_e2"],
          tangent_complex_pair_count: 4,
          tangent_field_payload_path:
            "response/field_payloads/frequency_0007/vector.bin",
          tangent_payload_encoding: "f64_interleaved_real_imag_tangent",
          tangent_payload_value_count: 8,
          tangent_value_kind: "complex_tangent_vector",
          value_kind: "complex_spatial_vector",
        });
      }
      return jsonResponse({
        artifact_path: "response/magnetic_response_sweep.v2.json",
        missing_reason: null,
        payload: { schema_version: "magnetic_response_sweep.v2" },
        resource_key:
          "/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep",
        schema_version: "frequency_domain_response_sweep_resource.v1",
        status: "ready",
      });
    });

    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl,
      requestIdFactory: () => "req-frequency-domain-artifact",
    });

    const sweep = await api.analysis.frequencyDomain.responseMagneticSweep();
    await api.analysis.frequencyDomain.responseFrequencyPoint(7);
    const fieldMeta = await api.analysis.frequencyDomain.responseFieldMeta(7);
    const cancelRequested =
      await api.analysis.frequencyDomain.responseCancelRequestedV1();
    const progress = await api.analysis.frequencyDomain.responseProgressV1();

    expect(sweep.status).toBe("ready");
    expect(fieldMeta.default_view).toBe("phase_rotated_real");
    expect(fieldMeta.default_phase_rad).toBe(0);
    expect(fieldMeta.value_kind).toBe("complex_spatial_vector");
    expect(fieldMeta.component_basis).toBe("global_xyz");
    expect(fieldMeta.component_count).toBe(3);
    expect(fieldMeta.components).toEqual(["x", "y", "z"]);
    expect(fieldMeta.payload_encoding).toBe("f64_interleaved_real_imag_xyz");
    expect(fieldMeta.binary_layout).toBe("complex_f64_pairs_little_endian");
    expect(fieldMeta.complex_pair_count).toBe(6);
    expect(fieldMeta.payload_value_count).toBe(12);
    expect(fieldMeta.tangent_field_payload_path).toBe(
      "response/field_payloads/frequency_0007/vector.bin",
    );
    expect(fieldMeta.tangent_payload_encoding).toBe(
      "f64_interleaved_real_imag_tangent",
    );
    expect(fieldMeta.tangent_value_kind).toBe("complex_tangent_vector");
    expect(fieldMeta.tangent_component_basis).toBe("local_tangent_frame");
    expect(fieldMeta.tangent_component_count).toBe(2);
    expect(fieldMeta.tangent_components).toEqual(["tangent_e1", "tangent_e2"]);
    expect(fieldMeta.tangent_complex_pair_count).toBe(4);
    expect(fieldMeta.tangent_payload_value_count).toBe(8);
    expect(fieldMeta.available_views).toContain("complex");
    expect(cancelRequested.status).toBe("cancel_requested");
    expect(progress.completed_frequency_points).toBe(1);
    expect(observedUrls).toEqual([
      "http://127.0.0.1:8765/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/frequency-domain/response/frequency-points/7",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/frequency-domain/response/field/7/meta",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/frequency-domain/response/cancel-requested.v1",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/frequency-domain/response/progress.v1",
    ]);
  });

  it("preserves frequency-response namespace aliases for v2 response resources", async () => {
    const observedUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url);
      observedUrls.push(target);
      if (target.endsWith("/response/field/4/meta")) {
        return jsonResponse({
          artifact_path: "response/field_payloads/frequency_0004/vector_xyz.bin",
          available_views: ["real", "imag", "phase_rotated_real"],
          binary_layout: "complex_f64_pairs_little_endian",
          complex_pair_count: 2,
          component_basis: "global_xyz",
          component_count: 3,
          components: ["x", "y", "z"],
          default_phase_rad: 0,
          default_view: "phase_rotated_real",
          field_id: "analysis:frequency-response:frequency-0004",
          missing_reason: null,
          payload_encoding: "f64_interleaved_real_imag_xyz",
          payload_value_count: 6,
          quantity: "delta_m",
          resource_key:
            "/v2/sessions/current/data/fields/analysis:frequency-response:frequency-0004/samples/vector?view=phase_rotated_real&phase_rad=0",
          schema_version: "frequency_domain_response_field.v1",
          source_family: "analysis/frequency-response",
          status: "ready",
          tangent_component_basis: "local_tangent_frame",
          tangent_component_count: 2,
          tangent_components: ["tangent_e1", "tangent_e2"],
          tangent_complex_pair_count: 2,
          tangent_field_payload_path:
            "response/field_payloads/frequency_0004/vector.bin",
          tangent_payload_encoding: "f64_interleaved_real_imag_tangent",
          tangent_payload_value_count: 4,
          tangent_value_kind: "complex_tangent_vector",
          value_kind: "complex_spatial_vector",
        });
      }
      return jsonResponse({
        artifact_path: "response/magnetic_response_sweep.v2.json",
        missing_reason: null,
        payload: { schema_version: "magnetic_response_sweep.v2" },
        resource_key:
          "/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep",
        schema_version: "frequency_domain_response_sweep_resource.v1",
        status: "ready",
      });
    });

    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl,
      requestIdFactory: () => "req-frequency-response-v2",
    });

    await api.analysis.frequencyResponse.magneticSweepV2();
    await api.analysis.frequencyResponse.frequencyPoint(4);
    const responseMeta = await api.analysis.frequencyResponse.fieldMeta(4);

    expect(responseMeta.component_basis).toBe("global_xyz");
    expect(responseMeta.components).toEqual(["x", "y", "z"]);
    expect(responseMeta.tangent_component_basis).toBe("local_tangent_frame");
    expect(responseMeta.tangent_components).toEqual(["tangent_e1", "tangent_e2"]);

    expect(observedUrls).toEqual([
      "http://127.0.0.1:8765/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/frequency-domain/response/frequency-points/4",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/frequency-domain/response/field/4/meta",
    ]);
  });

  it("loads modal eigen artifacts through both eigen and family namespaces", async () => {
    const observedUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url);
      observedUrls.push(target);
      if (target.endsWith("/eigen/dispersion")) {
        return jsonResponse({
          artifact_path: "eigen/dispersion.csv",
          missing_reason: null,
          payload: "sample_index,path_s_rad_per_m,mode_index,frequency_hz\n",
          resource_key:
            "/v2/sessions/current/analysis/frequency-domain/eigen/dispersion",
          schema_version: "frequency_domain_text_artifact.v1",
          status: "ready",
        });
      }
      if (target.endsWith("/eigen/mode-field/1/2/meta")) {
        return jsonResponse({
          artifact_path: "eigen/mode_fields/sample_0001/mode_0002/vector.bin",
          available_views: [
            "complex",
            "real",
            "imag",
            "abs",
            "amplitude",
            "phase",
            "phase_rotated_real",
          ],
          binary_layout: "complex_f64_pairs_little_endian",
          complex_pair_count: 3,
          component_basis: "global_xyz",
          component_count: 3,
          components: ["x", "y", "z"],
          default_phase_rad: 0,
          default_view: "phase_rotated_real",
          field_id: "analysis:eigen:sample-0001:mode-0002",
          missing_reason: null,
          payload_encoding: "f64_interleaved_real_imag_xyz",
          payload_value_count: 6,
          quantity: "delta_m",
          resource_key:
            "/v2/sessions/current/data/fields/analysis:eigen:sample-0001:mode-0002/samples/vector?view=phase_rotated_real&phase_rad=0",
          schema_version: "frequency_domain_eigen_field.v1",
          source_family: "analysis/eigen",
          status: "ready",
          value_kind: "complex_spatial_vector",
        });
      }
      if (target.endsWith("/analysis/eigen/modes/1/2")) {
        return jsonResponse({
          branch_id: "branch-0",
          field_id: "analysis:eigen:sample-0001:mode-0002",
          frequency_hz: 3.2e9,
          raw_mode_index: 2,
          sample_index: 1,
          schema_version: "eigen_mode.v2",
        });
      }
      return jsonResponse({
        artifact_path: "eigen/spectrum.v2.json",
        missing_reason: null,
        payload: { schema_version: "eigen_spectrum.v2" },
        resource_key:
          "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2",
        schema_version: "frequency_domain_eigen_artifact.v1",
        status: "ready",
      });
    });

    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl,
      requestIdFactory: () => "req-eigen",
    });

    await api.analysis.eigen.eigenSpectrumV2();
    await api.analysis.eigen.eigenBranchesV2();
    await api.analysis.eigen.eigenDiagnosticsV2();
    await api.analysis.eigen.eigenDispersion();
    const mode = await api.analysis.eigen.modeV2(1, 2);
    const modeMeta = await api.analysis.eigen.eigenModeFieldMeta(1, 2);
    await api.analysis.frequencyDomain.eigenSpectrumV2();

    expect(mode).toMatchObject({
      field_id: "analysis:eigen:sample-0001:mode-0002",
      schema_version: "eigen_mode.v2",
    });
    expect(modeMeta.value_kind).toBe("complex_spatial_vector");
    expect(modeMeta.component_basis).toBe("global_xyz");
    expect(modeMeta.component_count).toBe(3);
    expect(modeMeta.payload_encoding).toBe("f64_interleaved_real_imag_xyz");
    expect(modeMeta.binary_layout).toBe("complex_f64_pairs_little_endian");
    expect(modeMeta.complex_pair_count).toBe(3);
    expect(modeMeta.payload_value_count).toBe(6);
    expect(modeMeta.available_views).toContain("complex");
    expect(modeMeta.available_views).toContain("abs");
    expect(observedUrls).toEqual([
      "http://127.0.0.1:8765/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/frequency-domain/eigen/branches.v2",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/frequency-domain/eigen/diagnostics.v2",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/frequency-domain/eigen/dispersion",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/eigen/modes/1/2",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/1/2/meta",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2",
    ]);
  });

  it("loads hysteresis analysis resources through the analysis facade", async () => {
    const observedUrls: string[] = [];
    const observedMethods: Array<string | undefined> = [];
    const observedBodies: Array<BodyInit | null | undefined> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      observedUrls.push(String(url));
      observedMethods.push(init?.method);
      observedBodies.push(init?.body);
      const target = String(url);
      if (target.endsWith("/metrics")) {
        return jsonResponse({
          metrics: {
            H_c: null,
            H_c_minus: null,
            H_c_plus: null,
            H_eb: null,
            M_r_minus: null,
            M_r_plus: null,
            loop_area: 0,
            magnetization_average_weighting: "uniform_sample_average",
            saturation_preparation_field_mT: null,
            saturation_status: "not_available",
          },
          revision: 12,
          stage_id: "stage 1",
          stage_index: 1,
        });
      }
      if (target.endsWith("/saturation")) {
        return jsonResponse({
          revision: 12,
          saturation: {
            direction: 1,
            max_probe_field_mT: 300,
            points: [],
            preparation_field_mT: null,
            reason: "not run",
            status: "not_available",
            susceptibility_threshold: 0.001,
            transverse_threshold: 0.01,
          },
          stage_id: "stage 1",
          stage_index: 1,
        });
      }
      if (target.endsWith("/adaptive-refinement")) {
        return jsonResponse({
          adaptive_refinement: {
            candidates: [],
            enabled: true,
            kind: "adaptive_refinement",
            max_insertions_per_pass: 0,
            max_passes: 0,
            points: [],
            settle_trace: [],
            source_point_count: 0,
            status: "computed",
          },
          revision: 12,
          stage_id: "stage 1",
          stage_index: 1,
        });
      }
      if (target.endsWith("/branches")) {
        return jsonResponse({
          branches: [],
          revision: 12,
          stage_id: "stage 1",
          stage_index: 1,
        });
      }
      if (target.endsWith("/steps/7")) {
        return jsonResponse({
          field_value_mT: 10,
          m_avg: [1, 0, 0],
          m_ip: 1,
          m_oop: 0,
          m_parallel: 1,
          point_id: 7,
          snapshot_id: "hysteresis_point_007",
          status: "completed",
        });
      }
      if (target.endsWith("/bookmarks")) {
        return jsonResponse({
          bookmarks: [],
          revision: 12,
          stage_id: "stage 1",
          stage_index: 1,
        });
      }
      if (target.endsWith("/minor-loops")) {
        return jsonResponse({
          minor_loops: [],
          revision: 12,
          stage_id: "stage 1",
          stage_index: 1,
        });
      }
      if (target.endsWith("/reversal-fields")) {
        return jsonResponse({
          reversal_fields: [],
          revision: 12,
          stage_id: "stage 1",
          stage_index: 1,
        });
      }
      if (target.includes("/analysis/hysteresis/") && target.endsWith("/points")) {
        return jsonResponse({
          points: [],
          revision: 12,
          stage_id: "stage 1",
          stage_index: 1,
        });
      }
      if (
        target.includes("/analysis/hysteresis/") &&
        target.endsWith("/settle-trace") &&
        !target.includes("/steps/")
      ) {
        return jsonResponse({
          revision: 12,
          settle_trace: [],
          stage_id: "stage 1",
          stage_index: 1,
        });
      }
      return jsonResponse([]);
    });

    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl,
      requestIdFactory: () => "req-hyst",
    });

    await api.analysis.hysteresis.points("stage 1");
    await api.analysis.hysteresis.metrics("stage 1");
    await api.analysis.hysteresis.saturation("stage 1");
    await api.analysis.hysteresis.adaptiveRefinement("stage 1");
    await api.analysis.hysteresis.branches("stage 1");
    await api.analysis.hysteresis.bookmarks("stage 1");
    await api.analysis.hysteresis.bookmarkPoint("stage 1", { point_id: 7 });
    await api.analysis.hysteresis.family("stage 1");
    await api.analysis.hysteresis.familyVariantPoints("stage 1", "theta 90");
    await api.analysis.hysteresis.minorLoops("stage 1");
    await api.analysis.hysteresis.reversalFields("stage 1");
    await api.analysis.hysteresis.point("stage 1", 7);
    await api.analysis.hysteresis.stageSettleTrace("stage 1");
    await api.analysis.hysteresis.settleTrace("stage 1", 7);

    expect(observedMethods).toEqual([
      "GET",
      "GET",
      "GET",
      "GET",
      "GET",
      "GET",
      "POST",
      "GET",
      "GET",
      "GET",
      "GET",
      "GET",
      "GET",
      "GET",
    ]);
    expect(observedUrls).toEqual([
      "http://127.0.0.1:8765/v2/sessions/current/analysis/hysteresis/stage%201/points",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/hysteresis/stage%201/metrics",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/hysteresis/stage%201/saturation",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/hysteresis/stage%201/adaptive-refinement",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/hysteresis/stage%201/branches",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/hysteresis/stage%201/bookmarks",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/hysteresis/stage%201/bookmarks",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/hysteresis-family/stage%201",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/hysteresis-family/stage%201/variants/theta%2090/points",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/hysteresis/stage%201/minor-loops",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/hysteresis/stage%201/reversal-fields",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/hysteresis/stage%201/steps/7",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/hysteresis/stage%201/settle-trace",
      "http://127.0.0.1:8765/v2/sessions/current/analysis/hysteresis/stage%201/steps/7/settle-trace",
    ]);
    const postBody = observedBodies[6];
    expect(
      postBody instanceof ArrayBuffer
        ? new TextDecoder().decode(postBody)
        : postBody,
    ).toBe(JSON.stringify({ point_id: 7 }));
  });

  it("loads hysteresis stage resources through the simulation stage facade", async () => {
    const observedMethods: string[] = [];
    const observedUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      observedMethods.push(init?.method ?? "GET");
      observedUrls.push(String(url));
      return jsonResponse({
        active: true,
        current_field_mT: 25,
        current_point_index: 4,
        current_settle_step_index: 1,
        current_settle_step_kind: "minimize",
        current_settle_step_method: "projected_gradient_bb",
        revision: 11,
        stage_id: "stage 1",
        stage_index: 1,
        stage_kind: "hysteresis",
        status: "running",
      });
    });

    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl,
      requestIdFactory: () => "req-hyst-progress",
    });

    await api.simulation.stages.hysteresis.plan("stage 1");
    await api.simulation.stages.hysteresis.protocol("stage 1");
    await api.simulation.stages.hysteresis.saturation("stage 1");
    await api.simulation.stages.hysteresis.orientation("stage 1");
    await api.simulation.stages.hysteresis.settlePipeline("stage 1");
    await api.simulation.stages.hysteresis.executionTree("stage 1", {
      after: 3,
      before: 2,
      include_bookmarks: true,
      include_snapshots: true,
      include_warnings: true,
      window: "active",
    });
    await api.simulation.stages.hysteresis.progress("stage 1");

    expect(observedMethods).toEqual(Array(7).fill("GET"));
    expect(observedUrls).toEqual([
      "http://127.0.0.1:8765/v2/sessions/current/simulation/stages/stage%201/hysteresis/plan",
      "http://127.0.0.1:8765/v2/sessions/current/simulation/stages/stage%201/hysteresis/protocol",
      "http://127.0.0.1:8765/v2/sessions/current/simulation/stages/stage%201/hysteresis/saturation",
      "http://127.0.0.1:8765/v2/sessions/current/simulation/stages/stage%201/hysteresis/orientation",
      "http://127.0.0.1:8765/v2/sessions/current/simulation/stages/stage%201/hysteresis/settle-pipeline",
      "http://127.0.0.1:8765/v2/sessions/current/simulation/stages/stage%201/hysteresis/execution-tree?after=3&before=2&include_bookmarks=true&include_snapshots=true&include_warnings=true&window=active",
      "http://127.0.0.1:8765/v2/sessions/current/simulation/stages/stage%201/hysteresis/progress",
    ]);
  });

  it("loads the field catalog through the v2 data facade", async () => {
    let observedInit: RequestInit | undefined;
    let observedUrl = "";
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      observedUrl = String(url);
      observedInit = init;
      return jsonResponse({
        domain_generation_id: 3,
        quantities: [
          {
            available: true,
            components: 3,
            domain_generation_id: 3,
            field_revision: 8,
            kind: "vector",
            label: "Magnetization",
            location: "nodes",
            quantity_id: "m",
            unit: "A/m",
          },
        ],
        revision: 11,
      });
    });

    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl,
      requestIdFactory: () => "req-fields",
    });

    const catalog = await api.data.fields.catalog();

    expect(catalog.revision).toBe(11);
    expect(catalog.quantities[0]?.field_revision).toBe(8);
    const headers = new Headers(observedInit?.headers);
    expect(observedUrl).toBe("http://127.0.0.1:8765/v2/sessions/current/data/fields");
    expect(observedInit?.method).toBe("GET");
    expect(headers.get("x-request-id")).toBe("req-fields");
  });

  it("queries scoped field metadata through the v2 data facade", async () => {
    let observedUrl = "";
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        observedUrl = String(url);
        return jsonResponse({
          components: 3,
          domain_generation_id: 3,
          field_revision: 8,
          kind: "vector",
          label: "Magnetization",
          location: "nodes",
          quantity_id: "m",
          stats: { max: 0.4, mean: 0.1, min: -0.2 },
          unit: "",
        });
      },
    });

    const meta = await api.data.fields.meta("m", {
      component: "y",
      scope_id: "film",
      scope_kind: "object",
      snapshot_id: "hysteresis-stage-1-point-4",
      stage_id: "hysteresis-1",
    });

    expect(meta.stats?.min).toBe(-0.2);
    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/data/fields/m/meta?component=y&scope_id=film&scope_kind=object&snapshot_id=hysteresis-stage-1-point-4&stage_id=hysteresis-1",
    );
  });

  it("preserves an owner-qualified FEM region field metadata query", async () => {
    let observedUrl = "";
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        observedUrl = String(url);
        return jsonResponse({
          components: 3,
          domain_generation_id: 3,
          field_revision: 8,
          kind: "vector",
          label: "Magnetization",
          location: "nodes",
          quantity_id: "m",
          stats: { max: 0.4, mean: 0.1, min: -0.2 },
          unit: "",
        });
      },
    });

    await api.data.fields.meta("m", {
      component: "magnitude",
      owner_object_id: "body-b",
      scope_id: "shared",
      scope_kind: "region",
    });

    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/data/fields/m/meta?component=magnitude&owner_object_id=body-b&scope_id=shared&scope_kind=region",
    );
  });

  it("materializes missing field metadata on demand before retrying", async () => {
    const calls: Array<{ body: unknown; method: string | undefined; url: string }> = [];
    let metaRequests = 0;
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        calls.push({
          body: init?.body,
          method: init?.method,
          url: String(url),
        });
        const requestUrl = String(url);
        if (requestUrl.endsWith("/v2/sessions/current/simulation/commands")) {
          return jsonResponse({
            accepted: true,
            command_id: "cmd-fields",
            error: null,
          });
        }
        if (requestUrl.includes("/v2/sessions/current/data/fields/H_demag/meta")) {
          metaRequests += 1;
          if (metaRequests === 1) {
            return jsonResponse(
              { message: "field 'H_demag' not available in memory" },
              { status: 404 },
            );
          }
          return jsonResponse({
            components: 3,
            domain_generation_id: 4,
            field_revision: 12,
            kind: "vector",
            label: "Demagnetizing field",
            location: "cells",
            quantity_id: "H_demag",
            stats: { max: 0.2, mean: 0.01, min: -0.3 },
            unit: "A/m",
          });
        }
        throw new Error(`Unexpected request ${requestUrl}`);
      },
    });

    const meta = await api.data.fields.meta("H_demag", {
      component: "z",
      scope_id: "periodic_antidot_film",
      scope_kind: "object",
    });

    expect(meta.stats?.min).toBe(-0.3);
    expect(metaRequests).toBe(2);
    const commandCall = calls.find((call) =>
      call.url.endsWith("/v2/sessions/current/simulation/commands"),
    );
    expect(commandCall?.method).toBe("POST");
    expect(parseRequestJsonBody(commandCall?.body)).toMatchObject({
      kind: "compute_fields",
      reason: "field_on_demand",
      target: { kind: "study" },
    });
  });

  it("normalizes object-prefixed field metadata scope ids for object scopes", async () => {
    let observedUrl = "";
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        observedUrl = String(url);
        return jsonResponse({
          components: 3,
          domain_generation_id: 3,
          field_revision: 8,
          kind: "vector",
          label: "Magnetization",
          location: "nodes",
          quantity_id: "m",
          stats: { max: 1, mean: 0.5, min: 0 },
          unit: "",
        });
      },
    });

    await api.data.fields.meta("m", {
      component: "x",
      scope_id: "object:permalloy_layer",
      scope_kind: "object",
    });

    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/data/fields/m/meta?component=x&scope_id=permalloy_layer&scope_kind=object",
    );
  });

  it("normalizes object-prefixed field vector scope ids for object scopes", async () => {
    let observedUrl = "";
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        observedUrl = String(url);
        return binaryResponse(makeFieldVectorBuffer());
      },
    });

    await api.data.fields.vector("m", {
      component: "full",
      scope_id: "object:permalloy_layer",
      scope_kind: "object",
    });

    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/data/fields/m/samples/vector?component=full&scope_id=permalloy_layer&scope_kind=object",
    );
  });

  it.each([
    ["object", "object:film", "film"],
    ["region", "edge", "edge"],
    ["layer", "free_layer", "free_layer"],
  ] as const)(
    "sends typed FDM %s field scopes through the central field client",
    async (scopeKind, scopeId, expectedScopeId) => {
      let observedUrl = "";
      const api = new ControlRoomApi({
        baseUrl: "http://127.0.0.1:8765",
        fetchImpl: async (url) => {
          observedUrl = String(url);
          return binaryResponse(makeFieldVectorBuffer());
        },
      });

      await api.data.fields.fdmVector("m", {
        scope_id: scopeId,
        scope_kind: scopeKind,
      });

      expect(observedUrl).toBe(
        `http://127.0.0.1:8765/v2/sessions/current/data/fields/m/samples/vector?scope_id=${expectedScopeId}&scope_kind=${scopeKind}`,
      );
    },
  );

  it("exposes a closed typed FDM field-scope query", () => {
    const api = new ControlRoomApi();
    expectTypeOf(api.data.fields.fdmVector)
      .parameter(1)
      .toEqualTypeOf<FdmScopedFieldVectorQuery>();
  });

  it("allows a single-grid FDM airbox query without a scope id", () => {
    const query = {
      scope_kind: "airbox",
    } satisfies FdmSingleGridFieldVectorQuery;

    expect(query).toEqual({ scope_kind: "airbox" });
  });

  it("materializes missing field vectors on demand before retrying", async () => {
    const calls: Array<{ body: unknown; method: string | undefined; url: string }> = [];
    let vectorRequests = 0;
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        calls.push({
          body: init?.body,
          method: init?.method,
          url: String(url),
        });
        const requestUrl = String(url);
        if (requestUrl.endsWith("/v2/sessions/current/simulation/commands")) {
          return jsonResponse({
            accepted: true,
            command_id: "cmd-fields",
            error: null,
          });
        }
        if (
          requestUrl.includes(
            "/v2/sessions/current/data/fields/H_demag/samples/vector",
          )
        ) {
          vectorRequests += 1;
          if (vectorRequests === 1) {
            return new Response(null, {
              headers: contractHeaders,
              status: 204,
            });
          }
          return binaryResponse(makeFieldVectorBuffer(), {
            headers: { etag: '"field-1"', ...contractHeaders },
          });
        }
        if (requestUrl.includes("/v2/sessions/current/data/fields/H_demag/meta")) {
          return jsonResponse(
            { message: "field 'H_demag' not available in memory" },
            { status: 404 },
          );
        }
        if (requestUrl.endsWith("/v2/sessions/current/simulation/solver/status")) {
          return jsonResponse({ is_busy: false, runtime_state: "waiting_for_compute" });
        }
        throw new Error(`Unexpected request ${requestUrl}`);
      },
    });

    const result = await api.data.fields.vector("H_demag", {
      component: "full",
      scope_id: "periodic_antidot_film",
      scope_kind: "object",
    });

    expect(result.status).toBe("ready");
    expect(vectorRequests).toBe(2);
    const commandCall = calls.find((call) =>
      call.url.endsWith("/v2/sessions/current/simulation/commands"),
    );
    expect(commandCall?.method).toBe("POST");
    expect(parseRequestJsonBody(commandCall?.body)).toMatchObject({
      kind: "compute_fields",
      reason: "field_on_demand",
      target: { kind: "study" },
    });
  });

  it.each(["pending", "stale_complete", "error", "complete"] as const)(
    "returns a %s live-publisher miss for resource invalidation without enqueueing compute_fields",
    async (state) => {
      const calls: Array<{ method: string | undefined; url: string }> = [];
      let vectorRequests = 0;
      const api = new ControlRoomApi({
        baseUrl: "http://127.0.0.1:8765",
        fetchImpl: async (url, init) => {
          calls.push({ method: init?.method, url: String(url) });
          const requestUrl = String(url);
          if (
            requestUrl.includes(
              "/v2/sessions/current/data/fields/H_demag/samples/vector",
            )
          ) {
            vectorRequests += 1;
            if (vectorRequests === 1) {
              return new Response(null, {
                headers: contractHeaders,
                status: 204,
              });
            }
            return binaryResponse(makeFieldVectorBuffer(), {
              headers: { etag: '"field-live"', ...contractHeaders },
            });
          }
          if (requestUrl.includes("/v2/sessions/current/data/fields/H_demag/meta")) {
            return jsonResponse({ state });
          }
          throw new Error(`Unexpected request ${requestUrl}`);
        },
      });

      const result = await api.data.fields.vector("H_demag", {
        component: "full",
        scope_id: "body",
        scope_kind: "part",
      });

      expect(result.status).toBe("not-applicable");
      expect(vectorRequests).toBe(1);
      expect(
        calls.filter((call) =>
          call.url.endsWith("/v2/sessions/current/simulation/commands"),
        ),
      ).toHaveLength(0);
    },
  );

  it("leaves a not-yet-published field to an active solver without enqueueing compute_fields", async () => {
    const calls: Array<{ method: string | undefined; url: string }> = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        const requestUrl = String(url);
        calls.push({ method: init?.method, url: requestUrl });
        if (requestUrl.includes("/data/fields/H_demag/samples/vector")) {
          return new Response(null, { headers: contractHeaders, status: 204 });
        }
        if (requestUrl.includes("/data/fields/H_demag/meta")) {
          return jsonResponse(
            { message: "field 'H_demag' not available in memory" },
            { status: 404 },
          );
        }
        if (requestUrl.endsWith("/v2/sessions/current/simulation/solver/status")) {
          return jsonResponse({ is_busy: true, runtime_state: "running" });
        }
        throw new Error(`Unexpected request ${requestUrl}`);
      },
    });

    await expect(
      api.data.fields.vector("H_demag", {
        component: "full",
        scope_id: "body",
        scope_kind: "part",
      }),
    ).resolves.toMatchObject({ status: "not-applicable" });
    expect(
      calls.filter(
        (call) =>
          call.method === "POST" &&
          call.url.endsWith("/v2/sessions/current/simulation/commands"),
      ),
    ).toHaveLength(0);
  });

  it("loads scalar windows through the v2 data facade", async () => {
    let observedUrl = "";
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      observedUrl = String(url);
      return jsonResponse({
        columns: ["step", "time", "e_total"],
        returned_rows: 1,
        revision: 12,
        rows: [[4, 2.5e-9, 15]],
        total_rows: 8,
      });
    });

    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl,
      requestIdFactory: () => "req-scalars",
    });

    const window = await api.data.scalars.window({
      columns: ["time", "e_total"],
      limit: 50,
      sinceRevision: 10,
    });

    expect(window.revision).toBe(12);
    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/data/scalars?columns=time%2Ce_total&limit=50&since_revision=10",
    );
  });

  it("loads table row windows through the v2 data facade", async () => {
    let observedUrl = "";
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      observedUrl = String(url);
      return jsonResponse({
        columns: [
          {
            column_id: "step",
            component: null,
            dimension: "count",
            label: "step",
            quantity_id: "step",
            reduction: null,
            unit: "1",
            value_type: "integer",
          },
          {
            column_id: "t",
            component: null,
            dimension: "time",
            label: "t",
            quantity_id: "t",
            reduction: null,
            unit: "s",
            value_type: "float",
          },
        ],
        cursor_end: 12,
        cursor_start: 11,
        decimation: {
          endpoints_preserved: true,
          extrema_preserved: true,
          mode: "minmax_lttb",
          returned_points: 2,
          source_rows: 10,
          target_points: 800,
        },
        resync_required: false,
        returned_rows: 2,
        revision: 12,
        rows: [
          [11, 1.1e-12],
          [12, 1.2e-12],
        ],
        schema_revision: 1,
        table_id: "default",
        total_rows: 12,
      });
    });

    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl,
      requestIdFactory: () => "req-table-rows",
    });

    const rows = await api.data.tables.rows("default", {
      columns: ["step", "t"],
      cursor: 10,
      decimation: "minmax_lttb",
      fromRow: 3,
      fromT: 1e-12,
      includeTail: true,
      limit: 100,
      targetPoints: 800,
      toRow: 12,
      toT: 2e-12,
    });

    expect(rows.cursor_end).toBe(12);
    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/data/tables/default/rows?columns=step%2Ct&cursor=10&decimation=minmax_lttb&from_row=3&from_t=1e-12&include_tail=true&limit=100&target_points=800&to_row=12&to_t=2e-12",
    );
  });

  it("loads table metadata and binary rows through the v2 data facade", async () => {
    const observedUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const requestUrl = String(url);
      observedUrls.push(requestUrl);
      if (requestUrl.endsWith("/v2/sessions/current/data/tables")) {
        return jsonResponse({
          revision: 12,
          tables: [
            {
              binary_rows_href:
                "/v2/sessions/current/data/tables/default/rows.bin",
              columns: [],
              columns_href: "/v2/sessions/current/data/tables/default/columns",
              revision: 12,
              rows_href: "/v2/sessions/current/data/tables/default/rows",
              schema_revision: 1,
              table_id: "default",
              total_rows: 12,
            },
          ],
        });
      }
      if (requestUrl.endsWith("/v2/sessions/current/data/tables/default")) {
        return jsonResponse({
          binary_rows_href: "/v2/sessions/current/data/tables/default/rows.bin",
          columns: [],
          columns_href: "/v2/sessions/current/data/tables/default/columns",
          revision: 12,
          rows_href: "/v2/sessions/current/data/tables/default/rows",
          schema_revision: 1,
          table_id: "default",
          total_rows: 12,
        });
      }
      if (requestUrl.endsWith("/v2/sessions/current/data/tables/default/columns")) {
        return jsonResponse([
          {
            column_id: "step",
            component: null,
            dimension: "count",
            label: "step",
            quantity_id: "step",
            reduction: null,
            unit: "1",
            value_type: "integer",
          },
        ]);
      }
      if (requestUrl.includes("/rows.bin?")) {
        return binaryResponse(makeTableRowsBuffer([11, 1.1e-12, 7.1, 12, 1.2e-12, 7.2]), {
          headers: {
            "content-type": "application/vnd.fullmag.table-rows.v1+octet-stream",
          },
        });
      }
      throw new Error(`Unexpected URL ${requestUrl}`);
    });

    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl,
      requestIdFactory: () => "req-table-family",
    });

    await expect(api.data.tables.list()).resolves.toMatchObject({
      revision: 12,
    });
    await expect(api.data.tables.detail("default")).resolves.toMatchObject({
      table_id: "default",
      total_rows: 12,
    });
    await expect(api.data.tables.columns("default")).resolves.toHaveLength(1);
    const binary = await api.data.tables.rowsBinary("default", {
      columns: ["step", "t", "e_total"],
      cursor: 10,
      limit: 2,
    });

    expect(binary.status).toBe("ready");
    if (binary.status !== "ready") {
      throw new Error("expected ready");
    }
    expect(binary.data.rowCount).toBe(2);
    expect(binary.data.columnCount).toBe(3);
    expect(Array.from(binary.data.values)).toEqual([
      11,
      1.1e-12,
      7.1,
      12,
      1.2e-12,
      7.2,
    ]);

    expect(observedUrls).toContain(
      "http://127.0.0.1:8765/v2/sessions/current/data/tables/default/rows.bin?columns=step%2Ct%2Ce_total&cursor=10&limit=2",
    );
  });

  it("binds the default browser fetch to globalThis", async () => {
    const originalFetch = globalThis.fetch;
    let observedThis: unknown = null;

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: function receiverSensitiveFetch(
        this: typeof globalThis,
        url: RequestInfo | URL,
        init?: RequestInit,
      ) {
        void url;
        void init;
        if (this !== globalThis) {
          observedThis = null;
          throw new TypeError("Illegal invocation");
        }
        observedThis = globalThis;
        return Promise.resolve(jsonResponse(liveStatusFixture()));
      } satisfies typeof fetch,
      writable: true,
    });

    try {
      const api = new ControlRoomApi({
        baseUrl: "http://127.0.0.1:8765",
        requestIdFactory: () => "req-browser-fetch",
      });

      await expect(api.sessions.current.status()).resolves.toMatchObject({
        api_contract_version: "1.0.0",
      });
      expect(observedThis).toBe(globalThis);
    } finally {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: originalFetch,
        writable: true,
      });
    }
  });

  it("rejects mismatched API contract response versions", async () => {
    const api = new ControlRoomApi({
      fetchImpl: async () =>
        jsonResponse(liveStatusFixture(), {
          headers: { "x-api-contract-version": "0.9.0" },
        }),
    });

    await expect(api.sessions.current.status()).rejects.toMatchObject({
      status: 0,
      message: "API contract version mismatch: expected 1.0.0, got 0.9.0",
    });
  });

  it("rejects missing API contract response versions", async () => {
    const api = new ControlRoomApi({
      fetchImpl: async () =>
        new Response(JSON.stringify(liveStatusFixture()), { status: 200 }),
    });

    await expect(api.sessions.current.status()).rejects.toMatchObject({
      status: 0,
      message: "API contract version mismatch: expected 1.0.0, got missing",
    });
  });

  it("reports non-ok status responses as API errors", async () => {
    const api = new ControlRoomApi({
      fetchImpl: async () =>
        new Response("No active workspace", {
          headers: contractHeaders,
          status: 404,
        }),
    });

    await expect(api.sessions.current.status()).rejects.toMatchObject({
      status: 404,
      message: "No active workspace",
    });
  });

  it("submits structured commands through the v2 simulation command resource", async () => {
    const diagnostics = new RequestDiagnosticsController();
    let observedInit: RequestInit | undefined;
    let observedUrl = "";
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      observedUrl = String(url);
      observedInit = init;
      return jsonResponse({
        accepted: true,
        command_id: "cmd-1",
        error: null,
      });
    });

    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      diagnostics,
      fetchImpl,
      requestIdFactory: () => "req-command",
    });

    const response = await api.commands.submit({ kind: "pause" });

    expect(response).toEqual({
      accepted: true,
      command_id: "cmd-1",
      error: null,
    });
    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/simulation/commands",
    );
    expect(observedInit?.method).toBe("POST");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body =
      observedInit?.body instanceof ArrayBuffer
        ? new TextDecoder().decode(observedInit.body)
        : String(observedInit?.body);
    expect(JSON.parse(body)).toEqual({ kind: "pause" });
    expect(diagnostics.list()).toMatchObject([
      {
        detail: "attempt 1",
        direction: "tx",
        method: "POST",
        outcome: "sent",
        path: "/v2/sessions/current/simulation/commands",
        requestId: "req-command",
      },
      {
        detail: "attempt 1; command_id=cmd-1; accepted=true",
        direction: "rx",
        method: "POST",
        outcome: "ok",
        path: "/v2/sessions/current/simulation/commands",
        requestId: "req-command",
        status: 200,
      },
    ]);
  });

  it("loads command queue and command detail through v2 command resources", async () => {
    const seenUrls: string[] = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        seenUrls.push(String(url));
        if (String(url).endsWith("/commands/cmd-2")) {
          return jsonResponse({
            command_id: "cmd-2",
            created_at_unix_ms: 1,
            kind: "pause",
            seq: 2,
            status: "completed",
          });
        }
        return jsonResponse({
          accepted_count: 1,
          can_accept_commands: true,
          commands: [],
          completed_count: 0,
          dispatched_count: 0,
          failed_count: 0,
          pending_count: 1,
          rejected_count: 0,
          revision: 3,
          running_count: 0,
          runtime_controls: [],
        });
      },
    });

    const queue = await api.commands.list();
    const detail = await api.commands.detail("cmd-2");

    expect(queue.revision).toBe(3);
    expect(detail.command_id).toBe("cmd-2");
    expect(seenUrls).toEqual([
      "http://127.0.0.1:8765/v2/sessions/current/simulation/commands",
      "http://127.0.0.1:8765/v2/sessions/current/simulation/commands/cmd-2",
    ]);
  });

  it("loads, creates, and restores checkpoints through the v2 persistence facade", async () => {
    const seenUrls: string[] = [];
    const seenMethods: string[] = [];
    const seenBodies: unknown[] = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        seenUrls.push(String(url));
        seenMethods.push(init?.method ?? "GET");
        if (init?.body) {
          seenBodies.push(parseRequestBody(init.body));
        }
        if (init?.method === "POST") {
          if (String(url).endsWith("/exports")) {
            return jsonResponse({
              fms_base64: "Zm1z",
              profile: "resume",
              session_id: "session-1",
              size_bytes: 3,
            });
          }
          if (String(url).endsWith("/restore")) {
            return jsonResponse({
              checkpoint: {
                artifact_ref: "artifacts/checkpoints/cp-000042.fmstate",
                backend_family: "fdm_cpu",
                checkpoint_id: "cp-000042",
                checksum: "sha256:abc",
                coordinate_frame: "solver_domain",
                created_at: "2026-05-14T12:00:00Z",
                dt: 1e-13,
                field_revision: 8,
                format: "fmstate",
                mesh_revision: 5,
                resume_class: "logical_resume",
                run_id: "run-1",
                scene_revision: 3,
                source: "user_requested",
                step: 42,
                time_s: 2.5e-9,
                vector_count: 2,
              },
              field_revision: 8,
              restore_class: "logical_resume",
              restored_vector_count: 2,
              warnings: [],
            });
          }
          return jsonResponse({
            checkpoint: {
              artifact_ref: "artifacts/checkpoints/cp-000042.fmstate",
              backend_family: "fdm_cpu",
              checkpoint_id: "cp-000042",
              checksum: "sha256:abc",
              coordinate_frame: "solver_domain",
              created_at: "2026-05-14T12:00:00Z",
              dt: 1e-13,
              field_revision: 7,
              format: "fmstate",
              mesh_revision: 5,
              resume_class: "logical_resume",
              run_id: "run-1",
              scene_revision: 3,
              source: "user_requested",
              step: 42,
              time_s: 2.5e-9,
              vector_count: 2,
            },
          });
        }
        if (String(url).endsWith("/cp-000042")) {
          return jsonResponse({
            artifact_ref: "artifacts/checkpoints/cp-000042.fmstate",
            backend_family: "fdm_cpu",
            checkpoint_id: "cp-000042",
            checksum: "sha256:abc",
            coordinate_frame: "solver_domain",
            created_at: "2026-05-14T12:00:00Z",
            dt: 1e-13,
            field_revision: 7,
            format: "fmstate",
            mesh_revision: 5,
            resume_class: "logical_resume",
            run_id: "run-1",
            scene_revision: 3,
            source: "manual",
            step: 42,
            time_s: 2.5e-9,
            vector_count: 2,
          });
        }
        return jsonResponse({
          checkpoints: [],
        });
      },
    });

    const list = await api.persistence.checkpoints.list();
    const created = await api.persistence.checkpoints.create({
      profile: "resume",
      reason: "user_requested",
    });
    const detail = await api.persistence.checkpoints.detail("cp-000042");
    const restored = await api.persistence.checkpoints.restore("cp-000042", {
      reason: "user_requested",
    });
    const exported = await api.persistence.exports.create({
      profile: "resume",
    });

    expect(list.checkpoints).toEqual([]);
    expect(created.checkpoint.checkpoint_id).toBe("cp-000042");
    expect(detail.checkpoint_id).toBe("cp-000042");
    expect(restored.restore_class).toBe("logical_resume");
    expect(restored.field_revision).toBe(8);
    expect(exported.session_id).toBe("session-1");
    expect(seenUrls).toEqual([
      "http://127.0.0.1:8765/v2/sessions/current/persistence/checkpoints",
      "http://127.0.0.1:8765/v2/sessions/current/persistence/checkpoints",
      "http://127.0.0.1:8765/v2/sessions/current/persistence/checkpoints/cp-000042",
      "http://127.0.0.1:8765/v2/sessions/current/persistence/checkpoints/cp-000042/restore",
      "http://127.0.0.1:8765/v2/sessions/current/persistence/exports",
    ]);
    expect(seenMethods).toEqual(["GET", "POST", "GET", "POST", "POST"]);
    expect(seenBodies).toEqual([
      {
        profile: "resume",
        reason: "user_requested",
      },
      {
        reason: "user_requested",
      },
      {
        profile: "resume",
      },
    ]);
  });

  it("loads selected object metrics through the v2 simulation object resource", async () => {
    let observedUrl = "";
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        observedUrl = String(url);
        return jsonResponse({
          energies: {
            anisotropy: 0,
            demag: 0,
            dmi: 0,
            exchange: 0,
            total: 0,
            zeeman: 0,
          },
          has_solver_sample: false,
          magnetization_average: { mx: 1, my: 0, mz: 0 },
          object_id: "arch_Waveguide",
          revision: 12,
          source: "initial_state",
          step: 0,
          time_seconds: 0,
        });
      },
    });

    const result = await api.simulation.objects.metrics("arch_Waveguide");

    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/simulation/objects/arch_Waveguide/metrics",
    );
    expect(result).toMatchObject({
      has_solver_sample: false,
      object_id: "arch_Waveguide",
    });
  });

  it("retries idempotent GET failures and records the final request diagnostic", async () => {
    const diagnostics = new RequestDiagnosticsController();
    const seenRequestIds: Array<string | null> = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seenRequestIds.push(new Headers(init?.headers).get("x-request-id"));
      if (seenRequestIds.length === 1) {
        return new Response("temporary", {
          headers: contractHeaders,
          status: 503,
        });
      }
      return jsonResponse(liveStatusFixture({ fields_revision: 9 }));
    });

    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      diagnostics,
      fetchImpl,
      requestIdFactory: () => "req-retry",
    });

    const status = await api.sessions.current.status();

    expect(status.resources.fields_revision).toBe(9);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(seenRequestIds).toEqual(["req-retry", "req-retry"]);
    expect(diagnostics.list()).toMatchObject([
      {
        direction: "tx",
        method: "GET",
        outcome: "sent",
        path: "/v2/sessions/current/status",
        requestId: "req-retry",
      },
      {
        direction: "rx",
        method: "GET",
        outcome: "error",
        path: "/v2/sessions/current/status",
        requestId: "req-retry",
        status: 503,
      },
      {
        direction: "tx",
        method: "GET",
        outcome: "sent",
        path: "/v2/sessions/current/status",
        requestId: "req-retry",
      },
      {
        direction: "rx",
        method: "GET",
        outcome: "ok",
        path: "/v2/sessions/current/status",
        requestId: "req-retry",
        status: 200,
      },
    ]);
  });

  it("uses three total attempts for retryable GET failures", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporary", { headers: contractHeaders, status: 503 }))
      .mockResolvedValueOnce(new Response("temporary", { headers: contractHeaders, status: 503 }))
      .mockResolvedValueOnce(jsonResponse(liveStatusFixture({ fields_revision: 11 })));
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl,
      retryDelayMs: 0,
    });

    await expect(api.sessions.current.status()).resolves.toMatchObject({
      resources: { fields_revision: 11 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("never retries a GET 404", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "missing" }, { status: 404 }),
    );
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl,
      retryDelayMs: 0,
    });

    await expect(api.sessions.current.status()).rejects.toMatchObject({ status: 404 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry mutating commands and records rejected command diagnostics", async () => {
    const diagnostics = new RequestDiagnosticsController();
    const fetchImpl = vi.fn(
      async () =>
        jsonResponse({ error: "No active workspace" }, {
          status: 404,
        }),
    );

    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      diagnostics,
      fetchImpl,
      requestIdFactory: () => "req-post",
    });

    await expect(api.commands.submit({ kind: "pause" })).rejects.toMatchObject({
      status: 404,
      message: "No active workspace",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(diagnostics.list()).toMatchObject([
      {
        direction: "tx",
        method: "POST",
        outcome: "sent",
        path: "/v2/sessions/current/simulation/commands",
        requestId: "req-post",
      },
      {
        direction: "rx",
        method: "POST",
        outcome: "error",
        path: "/v2/sessions/current/simulation/commands",
        requestId: "req-post",
        status: 404,
      },
    ]);
  });

  it("loads and decodes domain topology through the v2 binary facade", async () => {
    const diagnostics = new RequestDiagnosticsController();
    let observedInit: RequestInit | undefined;
    let observedUrl = "";
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      diagnostics,
      fetchImpl: async (url, init) => {
        observedUrl = String(url);
        observedInit = init;
        return binaryResponse(makeTopologyBuffer(), {
          headers: { etag: '"topology-2"', ...contractHeaders },
        });
      },
      requestIdFactory: () => "req-topology",
    });

    const result = await api.data.domain.topology({ etag: '"topology-1"' });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error(`Expected ready topology, received ${result.status}`);
    }
    expect(result.etag).toBe('"topology-2"');
    expect(result.byteLength).toBe(makeTopologyBuffer().byteLength);
    expect(result.data.nodeCount).toBe(4);
    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/data/domain/topology",
    );
    expect(observedInit?.method).toBe("GET");
    const headers = new Headers(observedInit?.headers);
    expect(headers.get("if-none-match")).toBe('"topology-1"');
    expect(headers.get("x-request-id")).toBe("req-topology");
    expect(diagnostics.list()).toMatchObject([
      {
        direction: "tx",
        method: "GET",
        outcome: "sent",
        path: "/v2/sessions/current/data/domain/topology",
        requestId: "req-topology",
      },
      {
        direction: "rx",
        method: "GET",
        outcome: "ok",
        path: "/v2/sessions/current/data/domain/topology",
        requestId: "req-topology",
        status: 200,
      },
      {
        byteLength: makeTopologyBuffer().byteLength,
        detail: "decoded binary payload",
        direction: "rx",
        durationMs: expect.any(Number),
        method: "GET",
        outcome: "ok",
        path: "/v2/sessions/current/data/domain/topology",
        status: 200,
      },
    ]);
  });

  it("loads raw topology byte ranges for chunked topology transport", async () => {
    let observedInit: RequestInit | undefined;
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (_url, init) => {
        observedInit = init;
        return binaryResponse(makeTopologyBuffer().slice(0, 4), {
          headers: {
            "content-range": "bytes 0-3/164",
            etag: '"topology-2"',
            ...contractHeaders,
          },
          status: 206,
        });
      },
      requestIdFactory: () => "req-topology-range",
    });

    const result = await api.data.domain.topologyBytes({
      etag: '"topology-1"',
      range: "bytes=0-3",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error(`Expected ready topology bytes, received ${result.status}`);
    }
    expect(Array.from(new Uint8Array(result.data))).toEqual(
      Array.from(new TextEncoder().encode("FMMT")),
    );
    const headers = new Headers(observedInit?.headers);
    expect(headers.get("if-none-match")).toBe('"topology-1"');
    expect(headers.get("range")).toBe("bytes=0-3");
  });

  it("loads large domain topology through chunked byte ranges", async () => {
    const topologyBuffer = makeLargeTopologyBuffer();
    const observedRanges: string[] = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (_url, init) => {
        const range = new Headers(init?.headers).get("range");
        if (!range) {
          throw new Error("Expected chunked topology request to use Range");
        }
        observedRanges.push(range);
        const [start, end] = parseByteRange(range);
        return binaryResponse(topologyBuffer.slice(start, end + 1), {
          headers: {
            "content-range": `bytes ${start}-${end}/${topologyBuffer.byteLength}`,
            etag: '"topology-large"',
            ...contractHeaders,
          },
          status: 206,
        });
      },
      requestIdFactory: () => "req-topology-chunked",
    });

    const result = await api.data.domain.topologyChunked();

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error(`Expected ready topology, received ${result.status}`);
    }
    expect(result.byteLength).toBe(topologyBuffer.byteLength);
    expect(result.data.nodeCount).toBe(700_000);
    expect(result.data.indices.length).toBe(4);
    expect(result.data.boundaryFaces.length).toBe(3);
    expect(observedRanges[0]).toBe("bytes=0-63");
    expect(observedRanges.length).toBeGreaterThan(2);
  });

  it("loads every FMMT v2 CSR section through chunked byte ranges", async () => {
    const topologyBuffer = makeLargeMixedTopologyBuffer();
    const observedRanges: string[] = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (_url, init) => {
        const range = new Headers(init?.headers).get("range");
        if (!range) throw new Error("Expected chunked topology request to use Range");
        observedRanges.push(range);
        const [start, end] = parseByteRange(range);
        return binaryResponse(topologyBuffer.slice(start, end + 1), {
          headers: {
            "content-range": `bytes ${start}-${end}/${topologyBuffer.byteLength}`,
            etag: '"topology-mixed"',
            ...contractHeaders,
          },
          status: 206,
        });
      },
      requestIdFactory: () => "req-topology-mixed-chunked",
    });

    const result = await api.data.domain.topologyChunked();

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected ready mixed topology");
    expect(result.data.formatVersion).toBe(2);
    expect(Array.from(result.data.cellTypes ?? [])).toEqual([1, 2, 3]);
    expect(Array.from(result.data.cellOffsets ?? [])).toEqual([0, 4, 10, 15]);
    expect(Array.from(result.data.cellNodes ?? [])).toEqual([
      0, 1, 2, 3, 0, 1, 2, 4, 5, 6, 0, 1, 2, 3, 7,
    ]);
    expect(Array.from(result.data.facetTypes ?? [])).toEqual([1, 2]);
    expect(Array.from(result.data.facetRoles ?? [])).toEqual([1, 2]);
    expect(Array.from(result.data.facetOffsets ?? [])).toEqual([0, 3, 7]);
    expect(Array.from(result.data.facetNodes ?? [])).toEqual([0, 1, 2, 0, 1, 4, 3]);
    expect(Array.from(result.data.cellMarkers ?? [])).toEqual([10, 11, 12]);
    expect(Array.from(result.data.facetMarkers ?? [])).toEqual([20, 21]);
    expect(result.data.cellGlobalOrdinals).toEqual(new BigUint64Array([
      BigInt(10),
      BigInt("9007199254740993"),
      BigInt("18446744073709551615"),
    ]));
    expect(result.data.facetGlobalOrdinals).toEqual(new BigUint64Array([
      BigInt(20),
      BigInt("9007199254740995"),
    ]));
    expect(result.data.elementCount).toBe(3);
    expect(result.data.indices).toHaveLength(0);
    expect(result.data.elementMarkers).toBe(result.data.cellMarkers);
    expect(result.data.boundaryFaceCount).toBe(2);
    expect(result.data.boundaryFaces).toHaveLength(0);
    expect(result.data.boundaryMarkers).toBe(result.data.facetMarkers);
    expect(observedRanges[0]).toBe("bytes=0-63");
    expect(observedRanges).toHaveLength(15);
  });

  it.each([
    ["missing", null],
    ["changed", '"topology-changed"'],
  ])("rejects a %s ETag on a topology section range", async (_label, sectionEtag) => {
    const topologyBuffer = makeLargeMixedTopologyBuffer();
    let requestCount = 0;
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (_url, init) => {
        const range = new Headers(init?.headers).get("range");
        if (!range) throw new Error("Expected chunked topology request to use Range");
        const [start, end] = parseByteRange(range);
        const headers = new Headers({
          "content-range": `bytes ${start}-${end}/${topologyBuffer.byteLength}`,
          ...contractHeaders,
        });
        headers.set("etag", requestCount++ === 0 ? '"topology-stable"' : sectionEtag ?? "");
        if (sectionEtag === null && requestCount > 1) headers.delete("etag");
        return binaryResponse(topologyBuffer.slice(start, end + 1), {
          headers,
          status: 206,
        });
      },
      requestIdFactory: () => "req-topology-etag-mutation",
    });

    await expect(api.data.domain.topologyChunked()).rejects.toThrow(/ETag mismatch.*(missing|changed)/);
  });

  it.each([
    ["missing", null],
    ["weak", 'W/"topology-weak"'],
  ])("rejects a %s header ETag before loading topology sections", async (_label, etag) => {
    const topologyBuffer = makeLargeMixedTopologyBuffer();
    let requestCount = 0;
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (_url, init) => {
        requestCount += 1;
        const range = new Headers(init?.headers).get("range");
        if (!range) throw new Error("Expected chunked topology request to use Range");
        const [start, end] = parseByteRange(range);
        const headers = new Headers({
          "content-range": `bytes ${start}-${end}/${topologyBuffer.byteLength}`,
          ...contractHeaders,
        });
        if (etag !== null) headers.set("etag", etag);
        return binaryResponse(topologyBuffer.slice(start, end + 1), {
          headers,
          status: 206,
        });
      },
      requestIdFactory: () => "req-topology-header-etag",
    });

    await expect(api.data.domain.topologyChunked()).rejects.toThrow(/strong ETag/);
    expect(requestCount).toBe(1);
  });

  it("loads topology section ranges with bounded sequential concurrency", async () => {
    const topologyBuffer = makeLargeMixedTopologyBuffer();
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (_url, init) => {
        activeRequests += 1;
        maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
        await new Promise((resolve) => setTimeout(resolve, 1));
        const range = new Headers(init?.headers).get("range");
        if (!range) throw new Error("Expected chunked topology request to use Range");
        const [start, end] = parseByteRange(range);
        activeRequests -= 1;
        return binaryResponse(topologyBuffer.slice(start, end + 1), {
          headers: {
            "content-range": `bytes ${start}-${end}/${topologyBuffer.byteLength}`,
            etag: '"topology-sequential"',
            ...contractHeaders,
          },
          status: 206,
        });
      },
      requestIdFactory: () => "req-topology-sequential",
    });

    const result = await api.data.domain.topologyChunked();

    expect(result.status).toBe("ready");
    expect(maximumActiveRequests).toBe(1);
  });

  it.each([
    ["missing", () => null],
    ["wrong start", (start: number, end: number, total: number) => `bytes ${start + 1}-${end}/${total}`],
    ["wrong end", (start: number, end: number, total: number) => `bytes ${start}-${end - 1}/${total}`],
    ["wrong total", (start: number, end: number, total: number) => `bytes ${start}-${end}/${total + 1}`],
  ])(
    "rejects %s Content-Range metadata on a topology section",
    async (_label, mutateContentRange) => {
      const topologyBuffer = makeLargeMixedTopologyBuffer();
      let requestCount = 0;
      const api = new ControlRoomApi({
        baseUrl: "http://127.0.0.1:8765",
        fetchImpl: async (_url, init) => {
          const range = new Headers(init?.headers).get("range");
          if (!range) throw new Error("Expected chunked topology request to use Range");
          const [start, end] = parseByteRange(range);
          const headers = new Headers({ etag: '"topology-stable"', ...contractHeaders });
          const contentRange =
            requestCount++ === 0
              ? `bytes ${start}-${end}/${topologyBuffer.byteLength}`
              : mutateContentRange(start, end, topologyBuffer.byteLength);
          if (contentRange !== null) headers.set("content-range", contentRange);
          return binaryResponse(topologyBuffer.slice(start, end + 1), {
            headers,
            status: 206,
          });
        },
        requestIdFactory: () => "req-topology-content-range-mutation",
      });

      await expect(api.data.domain.topologyChunked()).rejects.toThrow(/Content-Range/);
    },
  );

  it("rejects topology above the explicit byte limit before section allocation", async () => {
    const header = makeLargeMixedTopologyBuffer().slice(0, 64);
    new DataView(header).setUint32(8, Math.floor(MAX_TOPOLOGY_BYTES / 24) + 1, true);
    let requestCount = 0;
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async () => {
        requestCount += 1;
        return binaryResponse(header, {
          headers: {
            "content-range": "bytes 0-63/999999999",
            etag: '"topology-oversized"',
            ...contractHeaders,
          },
          status: 206,
        });
      },
      requestIdFactory: () => "req-topology-oversized",
    });

    await expect(api.data.domain.topologyChunked()).rejects.toThrow(/exceeds.*byte limit/);
    expect(requestCount).toBe(1);
  });

  it("schedules binary decoders through the configured binary decode scheduler", async () => {
    const diagnostics = new RequestDiagnosticsController();
    const decodeKinds: string[] = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      binaryDecodeScheduler: async ({ buffer, decodeInline, kind }) => {
        decodeKinds.push(kind);
        await Promise.resolve();
        return decodeInline(buffer);
      },
      diagnostics,
      fetchImpl: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === "/v2/sessions/current/data/domain/topology") {
          return binaryResponse(makeTopologyBuffer(), {
            headers: { etag: '"topology-scheduled"', ...contractHeaders },
          });
        }
        if (path === "/v2/sessions/current/meshing/meshes/shared-domain/quality/per-element") {
          return binaryResponse(makeMeshQualityDataBuffer(), {
            headers: { etag: '"quality-scheduled"', ...contractHeaders },
          });
        }
        if (path === "/v2/sessions/current/meshing/meshes/shared-domain/cross-section") {
          return binaryResponse(makeCrossSectionBuffer(), {
            headers: { etag: '"cross-section-scheduled"', ...contractHeaders },
          });
        }
        if (path === "/v2/sessions/current/meshing/meshes/shared-domain/cross-section/quality") {
          return binaryResponse(makeCrossSectionQualityBuffer(), {
            headers: {
              etag: '"cross-section-quality-scheduled"',
              ...contractHeaders,
            },
          });
        }
        if (path === "/v2/sessions/current/data/fields/m/samples/vector") {
          return binaryResponse(makeFieldVectorBuffer(), {
            headers: { etag: '"field-vector-scheduled"', ...contractHeaders },
          });
        }
        throw new Error(`Unexpected binary URL ${url}`);
      },
      requestIdFactory: () => "req-scheduled-binary",
    });

    const topology = await api.data.domain.topology();
    const quality = await api.meshing.sharedDomain.qualityData();
    const crossSection = await api.meshing.sharedDomain.crossSection({
      plane: "xy",
      positionPercent: 50,
    });
    const crossSectionQuality =
      await api.meshing.sharedDomain.crossSectionQuality({
        metric: "gamma",
        plane: "xy",
        positionPercent: 50,
      });
    const fieldVector = await api.data.fields.vector("m");

    expect(topology.status).toBe("ready");
    expect(quality.status).toBe("ready");
    expect(crossSection.status).toBe("ready");
    expect(crossSectionQuality.status).toBe("ready");
    expect(fieldVector.status).toBe("ready");
    if (topology.status !== "ready") {
      throw new Error(`Expected ready topology, received ${topology.status}`);
    }
    if (quality.status !== "ready") {
      throw new Error(`Expected ready quality data, received ${quality.status}`);
    }
    if (crossSection.status !== "ready") {
      throw new Error(`Expected ready cross-section, received ${crossSection.status}`);
    }
    if (crossSectionQuality.status !== "ready") {
      throw new Error(
        `Expected ready cross-section quality, received ${crossSectionQuality.status}`,
      );
    }
    if (fieldVector.status !== "ready") {
      throw new Error(`Expected ready field vector, received ${fieldVector.status}`);
    }
    expect(topology.data.nodeCount).toBe(4);
    expect(quality.data.elementCount).toBe(1);
    expect(crossSection.data.polygonCount).toBe(1);
    expect(crossSectionQuality.data.perElementQuality.length).toBe(1);
    expect(fieldVector.data.quantityId).toBe("m");
    expect(decodeKinds).toEqual([
      "topology",
      "mesh-quality-data",
      "cross-section",
      "cross-section-quality",
      "field-vector",
    ]);
    for (const path of [
      "/v2/sessions/current/data/domain/topology",
      "/v2/sessions/current/meshing/meshes/shared-domain/quality/per-element",
      "/v2/sessions/current/meshing/meshes/shared-domain/cross-section?plane=xy&position_percent=50",
      "/v2/sessions/current/meshing/meshes/shared-domain/cross-section/quality?metric=gamma&plane=xy&position_percent=50",
      "/v2/sessions/current/data/fields/m/samples/vector",
    ]) {
      expect(diagnostics.list()).toContainEqual(
        expect.objectContaining({
          detail: "decoded binary payload",
          durationMs: expect.any(Number),
          outcome: "ok",
          path,
        }),
      );
    }
  });

  it("preserves binary byte length when the decode scheduler transfers the buffer", async () => {
    const diagnostics = new RequestDiagnosticsController();
    const topologyBuffer = makeTopologyBuffer();
    const originalByteLength = topologyBuffer.byteLength;
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      binaryDecodeScheduler: async ({ buffer, decodeInline }) => {
        const data = decodeInline(buffer.slice(0));
        structuredClone(buffer, { transfer: [buffer] });
        expect(buffer.byteLength).toBe(0);
        return data;
      },
      diagnostics,
      fetchImpl: async () =>
        binaryResponse(topologyBuffer, {
          headers: { etag: '"topology-transferred"', ...contractHeaders },
        }),
      requestIdFactory: () => "req-transferred-topology",
    });

    const result = await api.data.domain.topology();

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error(`Expected ready topology, received ${result.status}`);
    }
    expect(result.byteLength).toBe(originalByteLength);
    expect(diagnostics.list()).toContainEqual(
      expect.objectContaining({
        byteLength: originalByteLength,
        detail: "decoded binary payload",
        outcome: "ok",
        path: "/v2/sessions/current/data/domain/topology",
      }),
    );
  });

  it("emits performance measures around binary resource requests", async () => {
    const markSpy = vi.spyOn(performance, "mark");
    const measureSpy = vi.spyOn(performance, "measure");
    const clearMarksSpy = vi.spyOn(performance, "clearMarks");
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async () =>
        binaryResponse(makeTopologyBuffer(), {
          headers: { etag: '"topology-measured"', ...contractHeaders },
        }),
    });

    try {
      await expect(api.data.domain.topology()).resolves.toMatchObject({
        status: "ready",
      });

      expect(markSpy).toHaveBeenCalledWith(
        "fullmag.api.requestBinaryResource.topology:start",
      );
      expect(markSpy).toHaveBeenCalledWith(
        "fullmag.api.requestBinaryResource.topology:end",
      );
      expect(markSpy).toHaveBeenCalledWith(
        "fullmag.api.requestBinaryResource.topology.transport:start",
      );
      expect(markSpy).toHaveBeenCalledWith(
        "fullmag.api.requestBinaryResource.topology.transport:end",
      );
      expect(markSpy).toHaveBeenCalledWith(
        "fullmag.api.requestBinaryResource.topology.decode:start",
      );
      expect(markSpy).toHaveBeenCalledWith(
        "fullmag.api.requestBinaryResource.topology.decode:end",
      );
      expect(measureSpy).toHaveBeenCalledWith(
        "fullmag.api.requestBinaryResource.topology",
        "fullmag.api.requestBinaryResource.topology:start",
        "fullmag.api.requestBinaryResource.topology:end",
      );
      expect(measureSpy).toHaveBeenCalledWith(
        "fullmag.api.requestBinaryResource.topology.transport",
        "fullmag.api.requestBinaryResource.topology.transport:start",
        "fullmag.api.requestBinaryResource.topology.transport:end",
      );
      expect(measureSpy).toHaveBeenCalledWith(
        "fullmag.api.requestBinaryResource.topology.decode",
        "fullmag.api.requestBinaryResource.topology.decode:start",
        "fullmag.api.requestBinaryResource.topology.decode:end",
      );
      expect(clearMarksSpy).toHaveBeenCalledWith(
        "fullmag.api.requestBinaryResource.topology:start",
      );
      expect(clearMarksSpy).toHaveBeenCalledWith(
        "fullmag.api.requestBinaryResource.topology:end",
      );
      expect(clearMarksSpy).toHaveBeenCalledWith(
        "fullmag.api.requestBinaryResource.topology.transport:start",
      );
      expect(clearMarksSpy).toHaveBeenCalledWith(
        "fullmag.api.requestBinaryResource.topology.transport:end",
      );
      expect(clearMarksSpy).toHaveBeenCalledWith(
        "fullmag.api.requestBinaryResource.topology.decode:start",
      );
      expect(clearMarksSpy).toHaveBeenCalledWith(
        "fullmag.api.requestBinaryResource.topology.decode:end",
      );
    } finally {
      markSpy.mockRestore();
      measureSpy.mockRestore();
      clearMarksSpy.mockRestore();
    }
  });

  it("loads shared-domain per-element quality data through the v2 binary facade", async () => {
    let observedUrl = "";
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        observedUrl = String(url);
        return binaryResponse(makeMeshQualityDataBuffer(), {
          headers: { etag: '"quality-data-1"', ...contractHeaders },
        });
      },
    });

    const result = await api.meshing.sharedDomain.qualityData();

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error(`Expected ready quality data, received ${result.status}`);
    }
    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/meshing/meshes/shared-domain/quality/per-element",
    );
    expect(result.etag).toBe('"quality-data-1"');
    expect(result.data.elementCount).toBe(1);
    expect(Array.from(result.data.sicn ?? [])).toEqual([0.5]);
    expect(Array.from(result.data.gamma ?? [])).toEqual([0.25]);
  });

  it("loads periodic face and node pairs through the v2 binary facade", async () => {
    let observedUrl = "";
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        observedUrl = String(url);
        return binaryResponse(makePeriodicPairsBuffer(), {
          headers: {
            etag: '"periodic-pairs-41"',
            "x-fullmag-periodic-pairs-format": "FMPP.v1",
            ...contractHeaders,
          },
        });
      },
    });

    const result = await api.meshing.periodicPairsBinary();

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error(`Expected ready periodic pairs, received ${result.status}`);
    }
    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/meshing/mesh/periodic_pairs.v1.bin",
    );
    expect(result.etag).toBe('"periodic-pairs-41"');
    expect(result.data).toEqual({
      pairs: [
        {
          facePairs: [
            { faceA: 101, faceB: 202, vertexPairs: [[7, 17]] },
          ],
          markerA: 10,
          markerB: 20,
          nodePairs: [[7, 17]],
          pairId: "x-minus",
        },
      ],
      revision: 41,
      status: "valid",
    });
  });

  it("loads mesh histogram-bin element selections through the v2 facade", async () => {
    let observedUrl = "";
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        observedUrl = String(url);
        return jsonResponse({
          bin_index: 12,
          element_indices: [44, 45],
          mesh_id: "study_domain",
          metric: "characteristic_size",
          node_indices: [1, 2, 3, 4, 5],
          part_id: "airbox",
        });
      },
    });

    const result = await api.meshing.histogramBinElements({
      binIndex: 12,
      meshId: "study_domain",
      metric: "characteristic_size",
      partId: "airbox",
    });

    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/meshing/meshes/study_domain/parts/airbox/histogram-bins/characteristic_size/12/elements",
    );
    expect(result.element_indices).toEqual([44, 45]);
    expect(result.node_indices).toEqual([1, 2, 3, 4, 5]);
  });

  it("loads shared-domain cross-section geometry through the v2 binary facade", async () => {
    let observedUrl = "";
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        observedUrl = String(url);
        return binaryResponse(makeCrossSectionBuffer(), {
          headers: { etag: '"cross-section-1"', ...contractHeaders },
        });
      },
    });

    const result = await api.meshing.sharedDomain.crossSection({
      includePolygons: true,
      includeWireframe: false,
      plane: "xz",
      positionPercent: 25,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error(`Expected ready cross-section, received ${result.status}`);
    }
    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/meshing/meshes/shared-domain/cross-section?include_polygons=true&include_wireframe=false&plane=xz&position_percent=25",
    );
    expect(result.etag).toBe('"cross-section-1"');
    expect(result.data.polygonCount).toBe(1);
    expect(Array.from(result.data.parentElementIds)).toEqual([7]);
  });

  it("loads shared-domain cross-section image through the v2 binary facade", async () => {
    let observedUrl = "";
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        observedUrl = String(url);
        return binaryResponse(pngBytes, {
          headers: {
            "content-type": "image/png",
            etag: '"cross-section-image-1"',
            ...contractHeaders,
          },
        });
      },
    });

    const result = await api.meshing.sharedDomain.crossSectionImage({
      colorScale: "viridis",
      filterExpression: ">=0.1",
      legend: true,
      metric: "gamma",
      plane: "xy",
      positionPercent: 50,
      resolution: 1024,
      rotationDegrees: 17,
      shrinkFactor: 0.95,
      wireframe: true,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error(`Expected ready cross-section image, received ${result.status}`);
    }
    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/meshing/meshes/shared-domain/cross-section/image?color_scale=viridis&filter_expression=%3E%3D0.1&legend=true&metric=gamma&plane=xy&position_percent=50&resolution=1024&rotation_degrees=17&shrink_factor=0.95&wireframe=true",
    );
    expect(result.etag).toBe('"cross-section-image-1"');
    expect(result.byteLength).toBe(4);
    expect(Array.from(new Uint8Array(result.data))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("loads shared-domain cross-section quality through the v2 binary facade", async () => {
    let observedUrl = "";
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        observedUrl = String(url);
        return binaryResponse(makeCrossSectionQualityBuffer(), {
          headers: { etag: '"cross-section-quality-1"', ...contractHeaders },
        });
      },
    });

    const result = await api.meshing.sharedDomain.crossSectionQuality({
      metric: "gamma",
      plane: "xy",
      positionPercent: 50,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error(`Expected ready cross-section quality, received ${result.status}`);
    }
    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/meshing/meshes/shared-domain/cross-section/quality?metric=gamma&plane=xy&position_percent=50",
    );
    expect(result.etag).toBe('"cross-section-quality-1"');
    expect([...result.data.perElementQuality]).toEqual([0.25]);
    expect(result.data.range).toEqual({ min: 0.25, max: 0.25 });
  });

  it("preserves the stable unsupported code from every mixed cross-section resource", async () => {
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            code: "mixed_topology_not_supported",
            error:
              "mixed_topology_not_supported: cross-section slicing is tet4-only",
            message:
              "mixed_topology_not_supported: cross-section slicing is tet4-only",
          }),
          {
            headers: {
              "content-type": "application/json",
              ...contractHeaders,
            },
            status: 409,
          },
        ),
    });

    const requests = [
      () =>
        api.meshing.sharedDomain.crossSection({
          plane: "xy",
          positionPercent: 50,
        }),
      () =>
        api.meshing.sharedDomain.crossSectionImage({
          metric: "gamma",
          plane: "xy",
          positionPercent: 50,
        }),
      () =>
        api.meshing.sharedDomain.crossSectionQuality({
          metric: "gamma",
          plane: "xy",
          positionPercent: 50,
        }),
    ];

    for (const request of requests) {
      await expect(request()).rejects.toMatchObject({
        code: "mixed_topology_not_supported",
        status: 409,
      } satisfies Partial<ControlRoomApiError>);
    }
  });

  it("returns not-modified for fresh binary topology resources", async () => {
    const api = new ControlRoomApi({
      fetchImpl: async () =>
        new Response(null, {
          headers: { etag: '"topology-2"', ...contractHeaders },
          status: 304,
        }),
    });

    await expect(
      api.data.domain.topology({ etag: '"topology-2"' }),
    ).resolves.toEqual({
      etag: '"topology-2"',
      status: "not-modified",
    });
  });

  it("allows missing contract version only on binary data-plane responses", async () => {
    const api = new ControlRoomApi({
      fetchImpl: async () =>
        new Response(makeTopologyBuffer(), {
          headers: { etag: '"topology-2"' },
        }),
    });

    await expect(api.data.domain.topology()).resolves.toMatchObject({
      etag: '"topology-2"',
      status: "ready",
    });
  });

  it("rejects wrong contract version on binary data-plane responses", async () => {
    const api = new ControlRoomApi({
      fetchImpl: async () => binaryResponse(makeTopologyBuffer(), {
        headers: {
          "x-api-contract-version": "0.9.0",
          etag: '"topology-2"',
        },
      }),
    });

    await expect(api.data.domain.topology()).rejects.toMatchObject({
      status: 0,
      message: "API contract version mismatch: expected 1.0.0, got 0.9.0",
    });
  });

  it("returns not-applicable for absent binary topology resources", async () => {
    const api = new ControlRoomApi({
      fetchImpl: async () =>
        new Response(null, {
          headers: contractHeaders,
          status: 204,
        }),
    });

    await expect(api.data.domain.topology()).resolves.toEqual({
      etag: null,
      status: "not-applicable",
    });
  });

  it("treats 304 JSON resources as not modified instead of API errors", async () => {
    const api = new ControlRoomApi({
      fetchImpl: async () =>
        new Response(null, {
          headers: { etag: '"manifest-1"', ...contractHeaders },
          status: 304,
        }),
    });

    await expect(api.meshing.sharedDomainManifest()).resolves.toBeNull();
  });

  it("loads stage autosave metadata through the artifact resource facade", async () => {
    let observedUrl = "";
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        observedUrl = String(url);
        return new Response(JSON.stringify([{
          kind: "stage_autosave",
          path: "main.autosave.json",
          stage_autosave: {
            download_path: null,
            format: "zarr",
            layout: "continuous",
            resource_path: "main.zarr",
            schema_version: "fullmag.stage_autosave.artifact.v1",
            stages: [{
              complete: false,
              download_path: null,
              field_quantities: ["m"],
              field_sample_count: 1,
              stage_id: "relax",
              stage_index: 0,
              resource_path: "main.zarr",
              status: "running",
              table_quantities: ["step", "mx"],
              table_sample_count: 2,
            }],
            target: "main",
          },
        }]), { headers: contractHeaders });
      },
    });

    const artifacts = await api.data.artifacts.list();
    expect(observedUrl).toBe("http://127.0.0.1:8765/v2/sessions/current/data/artifacts");
    expect(artifacts[0].stage_autosave?.stages[0]).toMatchObject({
      stage_id: "relax",
      status: "running",
      table_sample_count: 2,
    });
  });

  it("propagates aborted binary resource requests", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("aborted", "AbortError");
    const api = new ControlRoomApi({
      fetchImpl: async () => {
        controller.abort();
        throw abortError;
      },
    });

    await expect(
      api.data.domain.topology({ signal: controller.signal }),
    ).rejects.toBe(abortError);
  });

  it("queries scoped field vectors without exposing endpoint strings to modules", async () => {
    let observedUrl = "";
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        observedUrl = String(url);
        return binaryResponse(makeFieldVectorBuffer(), {
          headers: { etag: '"field-1"', ...contractHeaders },
        });
      },
    });

    const result = await api.data.fields.vector("m", {
      component: "full",
      scope_id: "part-1",
      scope_kind: "part",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error(`Expected ready field vector, received ${result.status}`);
    }
    expect(result.data.quantityId).toBe("m");
    expect(Array.from(result.data.values)).toEqual([1, 0, -1]);
    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/data/fields/m/samples/vector?component=full&scope_id=part-1&scope_kind=part",
    );
  });

  it("queries an owner-qualified FDM region field without collapsing its identity", async () => {
    let observedUrl = "";
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        observedUrl = String(url);
        return binaryResponse(makeFieldVectorBuffer(), {
          headers: { etag: '"field-owner-b"', ...contractHeaders },
        });
      },
    });

    await api.data.fields.fdmVector("m", {
      component: "full",
      owner_object_id: "body-b",
      scope_id: "shared",
      scope_kind: "region",
    });

    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/data/fields/m/samples/vector?component=full&owner_object_id=body-b&scope_id=shared&scope_kind=region",
    );
  });

  it("queries hysteresis snapshot field vectors through the data-plane facade", async () => {
    let observedUrl = "";
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        observedUrl = String(url);
        return binaryResponse(makeFieldVectorBuffer(), {
          headers: { etag: '"field-1"', ...contractHeaders },
        });
      },
    });

    const result = await api.data.fields.vector("m", {
      component: "full",
      scope_kind: "full",
      snapshot_id: "hysteresis-stage-1-point-4",
      stage_id: "hysteresis-1",
    });

    expect(result.status).toBe("ready");
    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/data/fields/m/samples/vector?component=full&scope_kind=full&snapshot_id=hysteresis-stage-1-point-4&stage_id=hysteresis-1",
    );
  });

  it("queries phase-rotated frequency-response field vectors through the data-plane facade", async () => {
    let observedUrl = "";
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        observedUrl = String(url);
        return binaryResponse(makeFieldVectorBuffer(), {
          headers: { etag: '"field-1"', ...contractHeaders },
        });
      },
    });

    const result = await api.data.fields.vector(
      "analysis:frequency-response:frequency-0003",
      {
        component: "full",
        phase_rad: 1.25,
        view: "phase_rotated_real",
      },
    );

    expect(result.status).toBe("ready");
    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/data/fields/analysis%3Afrequency-response%3Afrequency-0003/samples/vector?component=full&phase_rad=1.25&view=phase_rotated_real",
    );
  });

  it("canonicalizes field vector quantity aliases at the v2 data facade boundary", async () => {
    let observedUrl = "";
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        observedUrl = String(url);
        return binaryResponse(makeFieldVectorBuffer(), {
          headers: { etag: '"field-1"', ...contractHeaders },
        });
      },
    });

    const result = await api.data.fields.vector("h_demag", {
      component: "full",
      scope_id: "part:__air__",
      scope_kind: "airbox",
    });

    expect(result.status).toBe("ready");
    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/data/fields/H_demag/samples/vector?component=full&scope_id=part%3A__air__&scope_kind=airbox",
    );
  });

  it("handles binary resource request failures safely without throwing TypeError in error formatter", async () => {
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async () => {
        const resp = new Response("Resource not found", {
          headers: contractHeaders,
          status: 404,
        });
        // Simulate a response whose body has already been consumed (typical for parseAs: arrayBuffer clients)
        Object.defineProperty(resp, "text", {
          value: async () => {
            throw new TypeError("Failed to execute 'text' on 'Response': body stream already read");
          },
        });
        return resp;
      },
    });

    await expect(api.data.fields.vector("H_demag")).rejects.toThrow(
      "Request failed with status 404"
    );
  });

  it("records an exact terminal diagnostic when a successful binary response fails decoding", async () => {
    const diagnostics = new RequestDiagnosticsController();
    const invalid = makeFieldVectorBuffer();
    new Uint8Array(invalid)[0] = "X".charCodeAt(0);
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      diagnostics,
      fetchImpl: async () =>
        binaryResponse(invalid, {
          headers: { etag: '"bad-field"', ...contractHeaders },
        }),
      requestIdFactory: () => "req-decode-error",
    });

    await expect(api.data.fields.vector("m")).rejects.toThrow(
      /Invalid FMVP magic/,
    );

    expect(diagnostics.list()).toContainEqual(
      expect.objectContaining({
        byteLength: invalid.byteLength,
        detail: "binary decode failed",
        direction: "rx",
        outcome: "error",
        path: "/v2/sessions/current/data/fields/m/samples/vector",
        requestId: "binary-payload",
        resourceKey: "/v2/sessions/current/data/fields/m/samples/vector",
        status: 200,
      }),
    );
    expect(JSON.stringify(diagnostics.list())).not.toContain(
      "Invalid FMVP magic",
    );
  });

  it("patches visualization state through the typed v2 facade", async () => {
    let observedInit: RequestInit | undefined;
    let observedUrl = "";
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        observedUrl = String(url);
        observedInit = init;
        return jsonResponse({ active_quantity_id: "m" });
      },
    });

    const result = await api.visualization.patch({
      active_quantity_id: "m",
      vector_glyphs: true,
    });

    expect(result).toEqual({ active_quantity_id: "m" });
    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/visualization/state",
    );
    expect(observedInit?.method).toBe("PATCH");
    expect(parseRequestBody(observedInit?.body)).toEqual({
      active_quantity_id: "m",
      vector_glyphs: true,
    });
  });

  it("posts visualization client acknowledgements through the typed v2 facade", async () => {
    let observedInit: RequestInit | undefined;
    let observedUrl = "";
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        observedUrl = String(url);
        observedInit = init;
        return jsonResponse({
          client_id: "browser-1",
          revision: 41,
          status: "rendered",
        });
      },
    });

    const result = await api.visualization.ack({
      client_id: "browser-1",
      effective_render_mode: "surface",
      revision: 41,
      status: "rendered",
      viewport_id: "viewport-main",
    });

    expect(result).toEqual({
      client_id: "browser-1",
      revision: 41,
      status: "rendered",
    });
    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/visualization/client-acks",
    );
    expect(observedInit?.method).toBe("POST");
    expect(parseRequestBody(observedInit?.body)).toEqual({
      client_id: "browser-1",
      effective_render_mode: "surface",
      revision: 41,
      status: "rendered",
      viewport_id: "viewport-main",
    });
  });

  it("exposes scene, universe, and shared-domain manifest through facade methods", async () => {
    const seenUrls: string[] = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        seenUrls.push(String(url));
        return jsonResponse({ revision: seenUrls.length });
      },
    });

    await api.model.scene();
    await api.model.physicsGraph();
    await api.model.universe();
    await api.meshing.sharedDomainManifest();

    expect(seenUrls).toEqual([
      "http://127.0.0.1:8765/v2/sessions/current/model/scene",
      "http://127.0.0.1:8765/v2/sessions/current/model/physics-graph",
      "http://127.0.0.1:8765/v2/sessions/current/model/universe",
      "http://127.0.0.1:8765/v2/sessions/current/meshing/meshes/shared-domain/manifest",
    ]);
  });

  it("commits geometry authoring transactions through the v2 model transaction resource", async () => {
    let observedInit: RequestInit | undefined;
    let observedUrl = "";
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        observedUrl = String(url);
        observedInit = init;
        return jsonResponse({
          committed_scene: { objects: [{ id: "box-1" }], revision: 12 },
          scene_revision: 12,
          transaction_kind: "create_object",
        });
      },
    });

    const response = await api.model.commitTransaction({
      base_revision: 11,
      geometry: { kind: "box", size: [1, 2, 3] },
      kind: "create_object",
      name: "Box 1",
      object_id: "box-1",
      transform: { rotation: [0, 0, 0], translation: [0, 0, 0] },
    });

    expect(response.scene_revision).toBe(12);
    expect(response.committed_scene).toEqual({
      objects: [{ id: "box-1" }],
      revision: 12,
    });
    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/model/transactions",
    );
    expect(observedInit?.method).toBe("POST");
    expect(parseRequestBody(observedInit?.body)).toEqual({
      base_revision: 11,
      geometry: { kind: "box", size: [1, 2, 3] },
      kind: "create_object",
      name: "Box 1",
      object_id: "box-1",
      transform: { rotation: [0, 0, 0], translation: [0, 0, 0] },
    });
  });

  it("mutates geometry objects through v2 model object facade methods", async () => {
    const requests: Array<{ body: unknown; method: string | undefined; url: string }> = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        requests.push({
          body: init?.body ? parseRequestBody(init.body) : null,
          method: init?.method,
          url: String(url),
        });
        return jsonResponse({ revision: requests.length });
      },
    });

    await api.model.createObject({
      base_revision: 1,
      geometry: { kind: "box" },
      name: "Box",
      object_id: "box",
    });
    await api.model.patchObject("box", {
      base_revision: 2,
      name: "Box updated",
      transform: { translation: [1, 0, 0] },
    });
    await api.model.patchObjectGeometry("box", {
      base_revision: 3,
      geometry: { kind: "box", size: [2, 2, 2] },
    });
    await api.model.deleteObject("box");

    expect(requests).toEqual([
      {
        body: {
          base_revision: 1,
          geometry: { kind: "box" },
          name: "Box",
          object_id: "box",
        },
        method: "POST",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/objects",
      },
      {
        body: {
          base_revision: 2,
          name: "Box updated",
          transform: { translation: [1, 0, 0] },
        },
        method: "PATCH",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/objects/box",
      },
      {
        body: {
          base_revision: 3,
          geometry: { kind: "box", size: [2, 2, 2] },
        },
        method: "PATCH",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/objects/box/geometry",
      },
      {
        body: null,
        method: "DELETE",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/objects/box",
      },
    ]);
  });

  it("loads geometry diagnostics and mesh build resources through facade methods", async () => {
    const seenUrls: string[] = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        seenUrls.push(String(url));
        return jsonResponse({ revision: seenUrls.length });
      },
    });

    await api.model.geometry.capabilities();
    await api.model.geometry.validation();
    await api.model.geometry.diagnostics();
    await api.model.geometry.realization();
    await api.meshing.builds.current();
    await api.meshing.builds.latestSuccessful();
    await api.meshing.periodicPairs();
    await api.meshing.objectReport("box");
    await api.meshing.objectQuality("box");
    await api.meshing.regionQuality("film:core");

    expect(seenUrls).toEqual([
      "http://127.0.0.1:8765/v2/sessions/current/model/geometry/capabilities",
      "http://127.0.0.1:8765/v2/sessions/current/model/geometry/validation",
      "http://127.0.0.1:8765/v2/sessions/current/model/geometry/diagnostics",
      "http://127.0.0.1:8765/v2/sessions/current/model/geometry/realizations/current",
      "http://127.0.0.1:8765/v2/sessions/current/meshing/builds/current",
      "http://127.0.0.1:8765/v2/sessions/current/meshing/builds/latest-successful",
      "http://127.0.0.1:8765/v2/sessions/current/meshing/mesh/periodic_pairs.v1",
      "http://127.0.0.1:8765/v2/sessions/current/meshing/meshes/objects/box/report",
      "http://127.0.0.1:8765/v2/sessions/current/meshing/meshes/objects/box/quality",
      "http://127.0.0.1:8765/v2/sessions/current/meshing/meshes/regions/film%3Acore/quality",
    ]);
  });

  it("loads runtime diagnostics through facade methods", async () => {
    const seenUrls: string[] = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        seenUrls.push(String(url));
        return jsonResponse({
          aggregates: { average_total_ns: 0, sample_count: 0 },
          artifact_refs: [],
          config: { enabled: false, emit_engine_log: false, max_samples: 128, persist_artifact: false, sample_every: 1 },
          devices: [],
          entries: [],
          latest_samples: [],
          revision: 1,
          state: "disabled",
          status: "ok",
          threading: null,
          total: 0,
        });
      },
    });

    await api.diagnostics.engineLog();
    await api.diagnostics.cpuTelemetry();
    await api.diagnostics.gpuTelemetry();
    await api.diagnostics.solverProfile();

    expect(seenUrls).toEqual([
      "http://127.0.0.1:8765/v2/sessions/current/diagnostics/engine-log",
      "http://127.0.0.1:8765/v2/sessions/current/diagnostics/cpu",
      "http://127.0.0.1:8765/v2/sessions/current/diagnostics/gpu",
      "http://127.0.0.1:8765/v2/sessions/current/diagnostics/solver-profile",
    ]);
  });

  it("posts session import requests through persistence facade methods", async () => {
    const requests: Array<{ body: unknown; method: string | undefined; url: string }> = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        requests.push({
          body: init?.body ? parseRequestBody(init.body) : null,
          method: init?.method,
          url: String(url),
        });
        return jsonResponse({ inspection: {}, restore_class: "logical_resume", session_id: "s1", warnings: [] });
      },
    });

    await api.persistence.imports.inspect({ fms_base64: "abc" });
    await api.persistence.imports.commit({
      fms_base64: "abc",
      restore_mode: "resume",
    });

    expect(requests).toEqual([
      {
        body: { fms_base64: "abc" },
        method: "POST",
        url: "http://127.0.0.1:8765/v2/sessions/current/persistence/imports/inspections",
      },
      {
        body: { fms_base64: "abc", restore_mode: "resume" },
        method: "POST",
        url: "http://127.0.0.1:8765/v2/sessions/current/persistence/imports",
      },
    ]);
  });

  it("loads and patches object interaction resources through v2 model facade methods", async () => {
    const requests: Array<{ body: unknown; method: string | undefined; url: string }> = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        requests.push({
          body: init?.body ? parseRequestBody(init.body) : null,
          method: init?.method,
          url: String(url),
        });
        return jsonResponse({
          enabled: true,
          interaction_kind: "uniaxial_anisotropy",
          object_id: "free layer",
          params: { axis: [0, 0, 1], ku1: 1200 },
          present: true,
        });
      },
    });

    const loaded = await api.model.objectInteraction(
      "free layer",
      "uniaxial_anisotropy",
    );
    const patched = await api.model.patchObjectInteraction(
      "free layer",
      "uniaxial_anisotropy",
      {
        enabled: true,
        params: { axis: [0, 0, 1], ku1: 1200 },
        present: true,
      },
    );

    expect(loaded.interaction_kind).toBe("uniaxial_anisotropy");
    expect(patched.params).toEqual({ axis: [0, 0, 1], ku1: 1200 });
    expect(requests).toEqual([
      {
        body: null,
        method: "GET",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/objects/free%20layer/interactions/uniaxial_anisotropy",
      },
      {
        body: {
          enabled: true,
          params: { axis: [0, 0, 1], ku1: 1200 },
          present: true,
        },
        method: "PATCH",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/objects/free%20layer/interactions/uniaxial_anisotropy",
      },
    ]);
  });

  it("loads and patches material, authored region, and realized region resources through v2 model facade methods", async () => {
    const requests: Array<{ body: unknown; method: string | undefined; url: string }> = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        requests.push({
          body: init?.body ? parseRequestBody(init.body) : null,
          method: init?.method,
          url: String(url),
        });
        if (String(url).includes("/model/region-diagnostics")) {
          return jsonResponse({
            diagnostics: [],
            scene_revision: 3,
          });
        }
        if (String(url).includes("/model/realized-regions")) {
          return jsonResponse({
            geometry_realization_revision: 5,
            regions: [
              {
                bounds_max: [1, 1, 1],
                bounds_min: [0, 0, 0],
                enabled: true,
                interaction_refs: [],
                material_ref: "mat:free layer",
                mesh_part_ids: [],
                name: "free layer",
                region_id: "region:free-layer",
                source: "realized_geometry_region",
                source_body_ids: ["body:1"],
                source_object_ids: ["free-layer"],
              },
            ],
            scene_revision: 4,
          });
        }
        if (String(url).includes("/model/regions")) {
          return jsonResponse({
            geometry_realization_revision: 2,
            regions: [],
            scene_revision: 1,
          });
        }
        return jsonResponse({
          id: "mat:free layer",
          name: "Free layer",
          properties: { Aex: 1e-11, Dind: null, Ms: 8e5, alpha: 0.02 },
          revision: requests.length,
        });
      },
    });

    const material = await api.model.material("mat:free layer");
    const patchedMaterial = await api.model.patchMaterial("mat:free layer", {
      name: "Free layer updated",
      properties: { Aex: 1.2e-11, Dind: null, Ms: 8e5, alpha: 0.03 },
    });
    const regions = await api.model.regions();
    const realizedRegions = await api.model.realizedRegions();
    const regionDiagnostics = await api.model.regionDiagnostics();
    await api.model.patchRegion("region:free layer", {
      enabled: false,
      name: "free",
    });

    expect(material.id).toBe("mat:free layer");
    expect(patchedMaterial.properties.alpha).toBe(0.02);
    expect(regions.scene_revision).toBe(1);
    expect(realizedRegions.scene_revision).toBe(4);
    expect(realizedRegions.regions[0]?.source).toBe("realized_geometry_region");
    expect(regionDiagnostics.scene_revision).toBe(3);
    expect(requests).toEqual([
      {
        body: null,
        method: "GET",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/materials/mat%3Afree%20layer",
      },
      {
        body: {
          name: "Free layer updated",
          properties: { Aex: 1.2e-11, Dind: null, Ms: 8e5, alpha: 0.03 },
        },
        method: "PATCH",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/materials/mat%3Afree%20layer",
      },
      {
        body: null,
        method: "GET",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/regions",
      },
      {
        body: null,
        method: "GET",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/realized-regions",
      },
      {
        body: null,
        method: "GET",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/region-diagnostics",
      },
      {
        body: {
          enabled: false,
          name: "free",
        },
        method: "PATCH",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/regions/region%3Afree%20layer",
      },
    ]);
  });

  it("loads mesh region membership through the v2 data facade", async () => {
    const requests: Array<{ body: unknown; method: string | undefined; url: string }> = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        requests.push({
          body: init?.body ? parseRequestBody(init.body) : null,
          method: init?.method,
          url: String(url),
        });
        return jsonResponse({
          boundary_face_indices: [0],
          element_indices: [0, 2],
          mesh_id: "mesh:shared-domain",
          mesh_part_ids: [],
          mesh_revision: 41,
          node_indices: [0, 1, 2, 3],
          owner_object_id: "film",
          realization_method: "shape_centroid_geometry_projection_v1",
          realization_warnings: [
            "geometry_projection uses node and centroid membership; it is not a conformal mesh part",
          ],
          region_id: "film:core",
          source: "geometry_projection",
        });
      },
    });

    const membership = await api.data.meshRegionMembership("film", "film:core");

    expect(membership.source).toBe("geometry_projection");
    expect(membership.element_indices).toEqual([0, 2]);
    expect(requests).toEqual([
      {
        body: null,
        method: "GET",
        url: "http://127.0.0.1:8765/v2/sessions/current/data/mesh-region-membership/film%3Acore?owner_object_id=film",
      },
    ]);
  });

  it("loads mesh region membership list through the v2 data facade", async () => {
    const requests: Array<{ body: unknown; method: string | undefined; url: string }> = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        requests.push({
          body: init?.body ? parseRequestBody(init.body) : null,
          method: init?.method,
          url: String(url),
        });
        return jsonResponse({
          memberships: [
            {
              boundary_face_indices: [0],
              element_indices: [0, 2],
              mesh_id: "mesh:shared-domain",
              mesh_part_ids: [],
              mesh_revision: 41,
              node_indices: [0, 1, 2, 3],
              region_id: "film:core",
              source: "geometry_projection",
            },
          ],
          mesh_id: "mesh:shared-domain",
          mesh_revision: 41,
          unresolved_regions: [
            { owner_object_id: "film", region_id: "film:csg" },
          ],
        });
      },
    });

    const list = await api.data.meshRegionMemberships();

    expect(list.memberships[0].region_id).toBe("film:core");
    expect(list.unresolved_regions).toEqual([
      { owner_object_id: "film", region_id: "film:csg" },
    ]);
    expect(requests).toEqual([
      {
        body: null,
        method: "GET",
        url: "http://127.0.0.1:8765/v2/sessions/current/data/mesh-region-memberships",
      },
    ]);
  });

  it("loads realized FDM membership descriptor and scoped binary bytes", async () => {
    const requests: string[] = [];
    const binary = new Uint8Array(68);
    binary.set([..."FMRM"].map((value) => value.charCodeAt(0)), 0);
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        requests.push(`${init?.method ?? "GET"} ${String(url)}`);
        if (String(url).endsWith("fdm-region-memberships")) {
          return jsonResponse({
            binary_path: "mesh/fdm_region_membership.v1.bin",
            cell_count: 1,
            cell_m: [1e-9, 1e-9, 1e-9],
            counts: [1, 1, 1],
            encoding: "FMRM:u32_le",
            freshness: "current",
            grid_fingerprint: "0".repeat(64),
            mesh_revision: 9,
            origin_m: [0, 0, 0],
            region_legend: [
              { numeric_id: 1, object_id: "body", region_id: "body:core", priority: 0 },
            ],
            region_membership_revision: 4,
            schema_version: "fdm_region_membership.v1",
          });
        }
        return binaryResponse(binary.buffer, { headers: { etag: '"fdm-membership"' } });
      },
    });

    const descriptor = await api.data.fdmRegionMemberships();
    const membership = await api.data.fdmRegionMembershipRegionBytes(
      "body",
      "body:core",
    );

    expect(descriptor.status).toBe("ready");
    if (descriptor.status !== "ready") throw new Error("expected FDM membership descriptor");
    expect(descriptor.data.region_legend[0]?.numeric_id).toBe(1);
    expect(membership.status).toBe("ready");
    expect(membership.status === "ready" ? membership.data.byteLength : 0).toBe(68);
    expect(requests).toEqual([
      "GET http://127.0.0.1:8765/v2/sessions/current/data/fdm-region-memberships",
      "GET http://127.0.0.1:8765/v2/sessions/current/data/fdm-region-membership/body%3Acore?owner_object_id=body",
    ]);
  });

  it("treats an unpublished FDM membership descriptor as not applicable", async () => {
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async () =>
        new Response(null, {
          headers: { "x-api-contract-version": "1.0.0" },
          status: 204,
        }),
    });

    await expect(api.data.fdmRegionMemberships()).resolves.toEqual({
      data: null,
      status: "pending",
    });
  });

  it("commits object region and coupling writes through model transactions", async () => {
    const requests: Array<{ body: unknown; method: string | undefined; url: string }> = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        requests.push({
          body: init?.body ? parseRequestBody(init.body) : null,
          method: init?.method,
          url: String(url),
        });
        return jsonResponse({
          committed_scene: { objects: [], revision: requests.length },
          scene_revision: requests.length,
          transaction_kind: "region_owned_write",
        });
      },
    });

    await api.model.createObjectRegion("film", {
      enabled: true,
      name: "core",
      shape: { kind: "cylinder", radius: 80e-9, axis: [0, 0, 1], center: [0, 0, 0], height: 100e-9 },
    }, { baseRevision: 4 });
    await api.model.patchObjectRegion("film", "film/core", {
      mesh_policy: { maximum_element_size: 1e-9 },
    }, { baseRevision: 5 });
    await api.model.deleteObjectRegion("film", "film/core", {
      baseRevision: 7,
    });
    await api.model.createCoupling({
      coupling_id: "exchange:film:ref",
      enabled: true,
      kind: "exchange",
      parameters: { kind: "exchange", mode: "harmonic_mean", scale: 1 },
      source: { kind: "object", object: "film" },
      target: { kind: "object", object: "reference" },
    }, { baseRevision: 8 });
    await api.model.patchCoupling("exchange:film:ref", {
      parameters: { kind: "exchange", mode: "harmonic_mean", scale: 0.5 },
    }, { baseRevision: 9 });
    await api.model.deleteCoupling("exchange:film:ref", { baseRevision: 10 });

    expect(requests).toEqual([
      {
        body: {
          base_revision: 4,
          kind: "create_object_region",
          object_id: "film",
          region: {
            enabled: true,
            name: "core",
            shape: { kind: "cylinder", radius: 80e-9, axis: [0, 0, 1], center: [0, 0, 0], height: 100e-9 },
          },
        },
        method: "POST",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/transactions",
      },
      {
        body: {
          base_revision: 5,
          kind: "patch_object_region",
          object_id: "film",
          patch: { mesh_policy: { maximum_element_size: 1e-9 } },
          region_id: "film/core",
        },
        method: "POST",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/transactions",
      },
      {
        body: {
          base_revision: 7,
          kind: "delete_object_region",
          object_id: "film",
          region_id: "film/core",
        },
        method: "POST",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/transactions",
      },
      {
        body: {
          base_revision: 8,
          coupling: {
            coupling_id: "exchange:film:ref",
            enabled: true,
            kind: "exchange",
            parameters: { kind: "exchange", mode: "harmonic_mean", scale: 1 },
            source: { kind: "object", object: "film" },
            target: { kind: "object", object: "reference" },
          },
          kind: "create_coupling",
        },
        method: "POST",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/transactions",
      },
      {
        body: {
          base_revision: 9,
          coupling_id: "exchange:film:ref",
          kind: "patch_coupling",
          patch: { parameters: { kind: "exchange", mode: "harmonic_mean", scale: 0.5 } },
        },
        method: "POST",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/transactions",
      },
      {
        body: {
          base_revision: 10,
          coupling_id: "exchange:film:ref",
          kind: "delete_coupling",
        },
        method: "POST",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/transactions",
      },
    ]);
  });

  it("keeps coupling transaction patches on the generated typed contract", () => {
    const patchTransaction = {
      coupling_id: "exchange:film:ref",
      kind: "patch_coupling",
      patch: {
        parameters: { kind: "exchange", mode: "harmonic_mean", scale: 0.5 },
      },
    } satisfies AuthoringTransactionRequest;

    expect(patchTransaction.patch.parameters.kind).toBe("exchange");

    const rawIdentityPatch = {
      coupling_id: "exchange:film:ref",
      kind: "patch_coupling",
      patch: {
        // @ts-expect-error coupling identity belongs to the transaction envelope.
        coupling_id: "other",
      },
    } satisfies AuthoringTransactionRequest;

    expect(rawIdentityPatch.kind).toBe("patch_coupling");
  });

  it("commits material library writes through model transactions", async () => {
    const requests: Array<{ body: unknown; method: string | undefined; url: string }> = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        requests.push({
          body: init?.body ? parseRequestBody(init.body) : null,
          method: init?.method,
          url: String(url),
        });
        return jsonResponse({
          committed_scene: { materials: [{ id: "mat:permalloy" }], revision: 12 },
          scene_revision: 12,
          transaction_kind: "material",
        });
      },
    });

    await api.model.createMaterial(
      "mat:permalloy",
      "Permalloy",
      { Aex: 1.3e-11, Dbulk: null, Dind: null, Ms: 8e5, alpha: 0.01 },
      [{ label: "Reference", url: "https://doi.org/10.1063/1.3072096" }],
      { baseRevision: 9 },
    );
    await api.model.patchMaterialAsset(
      "mat:permalloy",
      {
        name: "Permalloy updated",
        properties: { alpha: 0.02 },
        references: [{ label: "Updated", url: "https://doi.org/10.1063/1.3072096" }],
      },
      { baseRevision: 10 },
    );
    await api.model.deleteMaterial("mat:permalloy", { baseRevision: 11 });

    expect(requests).toEqual([
      {
        body: {
          base_revision: 9,
          kind: "create_material",
          material_id: "mat:permalloy",
          name: "Permalloy",
          properties: { Aex: 1.3e-11, Dbulk: null, Dind: null, Ms: 8e5, alpha: 0.01 },
          references: [{ label: "Reference", url: "https://doi.org/10.1063/1.3072096" }],
        },
        method: "POST",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/transactions",
      },
      {
        body: {
          base_revision: 10,
          kind: "patch_material",
          material_id: "mat:permalloy",
          patch: {
            name: "Permalloy updated",
            properties: { alpha: 0.02 },
            references: [{ label: "Updated", url: "https://doi.org/10.1063/1.3072096" }],
          },
        },
        method: "POST",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/transactions",
      },
      {
        body: {
          base_revision: 11,
          kind: "delete_material",
          material_id: "mat:permalloy",
        },
        method: "POST",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/transactions",
      },
    ]);
  });

  it("commits object region writes through object region resources", async () => {
    const requests: Array<{ body: unknown; method: string | undefined; url: string }> = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        requests.push({
          body: init?.body ? parseRequestBody(init.body) : null,
          method: init?.method,
          url: String(url),
        });
        return jsonResponse({
          objects: [],
          revision: requests.length,
          scene_revision: requests.length,
        });
      },
    });

    await api.model.createRegion("film", {
      enabled: true,
      name: "core",
      shape: { kind: "cylinder", radius: 80e-9, axis: [0, 0, 1], center: [0, 0, 0], height: 100e-9 },
    }, { baseRevision: 4 });
    await api.model.patchObjectRegionResource("film", "film:core", {
      mesh_policy: { maximum_element_size: 1e-9 },
    }, { baseRevision: 5 });
    await api.model.duplicateObjectRegion("film", "film:core", {
      name: "core copy",
    }, { baseRevision: 6 });
    await api.model.reorderObjectRegions("film", ["film:core_copy", "film:core"], {
      baseRevision: 7,
    });
    await api.model.deleteRegion("film", "film:core");

    expect(requests).toEqual([
      {
        body: {
          base_revision: 4,
          region: {
            enabled: true,
            name: "core",
            shape: { kind: "cylinder", radius: 80e-9, axis: [0, 0, 1], center: [0, 0, 0], height: 100e-9 },
          },
        },
        method: "POST",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/objects/film/regions",
      },
      {
        body: {
          base_revision: 5,
          patch: { mesh_policy: { maximum_element_size: 1e-9 } },
        },
        method: "PATCH",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/objects/film/regions/film%3Acore",
      },
      {
        body: {
          base_revision: 6,
          name: "core copy",
        },
        method: "POST",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/objects/film/regions/film%3Acore/duplicate",
      },
      {
        body: {
          base_revision: 7,
          region_ids: ["film:core_copy", "film:core"],
        },
        method: "POST",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/objects/film/regions/reorder",
      },
      {
        body: null,
        method: "DELETE",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/objects/film/regions/film%3Acore",
      },
    ]);
  });

  it("commits object material fields through model transactions", async () => {
    const requests: Array<{ body: unknown; method: string | undefined; url: string }> = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        requests.push({
          body: init?.body ? parseRequestBody(init.body) : null,
          method: init?.method,
          url: String(url),
        });
        return jsonResponse({
          committed_scene: { objects: [{ id: "film" }], revision: 12 },
          scene_revision: 12,
          transaction_kind: "patch_object_material_fields",
        });
      },
    });

    await api.model.patchObjectMaterialFields(
      "film",
      [
        {
          assignment_id: "film:core:ms",
          conflict_policy: "higher_priority_wins",
          owner_object: "film",
          parameter: "ms",
          priority: 10,
          region_id: "film:core",
          value: {
            frame: "object",
            gradient: [1, 0, 0],
            kind: "linear",
            base: 8e5,
            unit: "A/m",
          },
        },
      ],
      { baseRevision: 11 },
    );

    expect(requests).toEqual([
      {
        body: {
          base_revision: 11,
          fields: [
            {
              assignment_id: "film:core:ms",
              conflict_policy: "higher_priority_wins",
              owner_object: "film",
              parameter: "ms",
              priority: 10,
              region_id: "film:core",
              value: {
                frame: "object",
                gradient: [1, 0, 0],
                kind: "linear",
                base: 8e5,
                unit: "A/m",
              },
            },
          ],
          kind: "patch_object_material_fields",
          object_id: "film",
        },
        method: "POST",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/transactions",
      },
    ]);
  });

  it("loads and patches magnetization assets through v2 model facade methods", async () => {
    const requests: Array<{ body: unknown; method: string | undefined; url: string }> = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        requests.push({
          body: init?.body ? parseRequestBody(init.body) : null,
          method: init?.method,
          url: String(url),
        });
        return jsonResponse({
          asset: {
            id: "mag:free layer",
            kind: "preset_texture",
            name: "Free layer texture",
            preset_kind: "uniform",
          },
          scene_revision: requests.length,
        });
      },
    });

    const loaded = await api.model.magnetizationAsset("mag:free layer");
    const patched = await api.model.patchMagnetizationAsset("mag:free layer", {
      asset: {
        id: "mag:free layer",
        kind: "preset_texture",
        mapping: {
          clamp_mode: "none",
          projection: "object_local",
          space: "object",
        },
        name: "Free layer texture",
        preset_kind: "uniform",
        preset_params: { direction: [0, 1, 0] },
        texture_transform: {
          pivot: [0, 0, 0],
          rotation_quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
          translation: [1, 0, 0],
        },
      },
      base_revision: 7,
    });

    expect(loaded.asset.id).toBe("mag:free layer");
    expect(patched.scene_revision).toBe(2);
    expect(requests).toEqual([
      {
        body: null,
        method: "GET",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/magnetization-assets/mag%3Afree%20layer",
      },
      {
        body: {
          asset: {
            id: "mag:free layer",
            kind: "preset_texture",
            mapping: {
              clamp_mode: "none",
              projection: "object_local",
              space: "object",
            },
            name: "Free layer texture",
            preset_kind: "uniform",
            preset_params: { direction: [0, 1, 0] },
            texture_transform: {
              pivot: [0, 0, 0],
              rotation_quat: [0, 0, 0, 1],
              scale: [1, 1, 1],
              translation: [1, 0, 0],
            },
          },
          base_revision: 7,
        },
        method: "PATCH",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/magnetization-assets/mag%3Afree%20layer",
      },
    ]);
  });

  it("loads and replaces per-object mesh policy resources through v2 meshing facade methods", async () => {
    const requests: Array<{ body: unknown; method: string | undefined; url: string }> = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        requests.push({
          body: init?.body ? parseRequestBody(init.body) : null,
          method: init?.method,
          url: String(url),
        });
        return jsonResponse({
          config: { maximum_element_size: 5e-9 },
          object_id: "free layer",
          revision: requests.length,
        });
      },
    });

    const loaded = await api.meshing.objectPolicy("free layer");
    const replaced = await api.meshing.replaceObjectPolicy("free layer", {
      config: { maximum_element_size: 5e-9 },
    });

    expect(loaded.config).toEqual({ maximum_element_size: 5e-9 });
    expect(replaced.revision).toBe(2);
    expect(requests).toEqual([
      {
        body: null,
        method: "GET",
        url: "http://127.0.0.1:8765/v2/sessions/current/meshing/policies/objects/free%20layer",
      },
      {
        body: { config: { maximum_element_size: 5e-9 } },
        method: "PUT",
        url: "http://127.0.0.1:8765/v2/sessions/current/meshing/policies/objects/free%20layer",
      },
    ]);
  });

  it("loads and replaces universe mesh policy resources through v2 meshing facade methods", async () => {
    const requests: Array<{ body: unknown; method: string | undefined; url: string }> = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        requests.push({
          body: init?.body ? parseRequestBody(init.body) : null,
          method: init?.method,
          url: String(url),
        });
        return jsonResponse({
          config: {
            airbox_grading: "linear",
            airbox_growth_rate: 1.4,
            airbox_hmax: 8e-9,
            airbox_hmin: 2e-9,
          },
          revision: requests.length,
        });
      },
    });

    const loaded = await api.meshing.universePolicy();
    const replaced = await api.meshing.replaceUniversePolicy({
      config: {
        airbox_grading: "linear",
        airbox_growth_rate: 1.4,
        airbox_hmax: 8e-9,
        airbox_hmin: 2e-9,
      },
    });

    expect(loaded.config?.airbox_hmax).toBe(8e-9);
    expect(replaced.revision).toBe(2);
    expect(requests).toEqual([
      {
        body: null,
        method: "GET",
        url: "http://127.0.0.1:8765/v2/sessions/current/meshing/policies/universe",
      },
      {
        body: {
          config: {
            airbox_grading: "linear",
            airbox_growth_rate: 1.4,
            airbox_hmax: 8e-9,
            airbox_hmin: 2e-9,
          },
        },
        method: "PUT",
        url: "http://127.0.0.1:8765/v2/sessions/current/meshing/policies/universe",
      },
    ]);
  });

  it("treats an absent shared-domain manifest as not applicable", async () => {
    const api = new ControlRoomApi({
      fetchImpl: async () =>
        new Response(null, {
          headers: contractHeaders,
          status: 204,
        }),
    });

    await expect(api.meshing.sharedDomainManifest()).resolves.toBeNull();
  });

  it("routes spin-transport list and mutations through the canonical model resource", async () => {
    const requests: Array<{ body: unknown; method: string; url: string }> = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        requests.push({
          body: init?.body ? parseRequestJsonBody(init.body) : null,
          method: init?.method ?? "GET",
          url: String(url),
        });
        return jsonResponse({ items: [], scene_revision: 7 });
      },
    });
    const request = {
      base_revision: 7,
      resource: {
        boundaries: [],
        constitutive_version: "transport_constitutive.one_way.fullmag.v1",
        current_source_id: " charge ",
        domain: [],
        id: "spin path/1",
        interfaces: [],
        materials: [],
        mode: "steady" as const,
        requested_execution: {
          device: "auto" as const,
          discretization: "auto" as const,
          execution_mode: "strict" as const,
          precision: "double" as const,
        },
        schema_version: "spin_transport.v1",
        solver: {
          default_external_boundary: "spin_insulating",
          engine: "gmres",
          linear: { absolute_tolerance: 1e-14, max_iterations: 1000, relative_tolerance: 1e-10 },
          operator_version: "fv_spin_upwind_v1",
          physical_residual_version: "transport_balance_integrated_l2.v1",
        },
      },
    };

    await api.model.spinTransports();
    await api.model.spinTransport("spin path/1");
    await api.model.createSpinTransport(request);
    await api.model.replaceSpinTransport("spin path/1", request);
    await api.model.deleteSpinTransport("spin path/1", { base_revision: 8 });

    const collection = "http://127.0.0.1:8765/v2/sessions/current/model/spin-transports";
    const member = `${collection}/spin%20path%2F1`;
    expect(requests).toEqual([
      { body: null, method: "GET", url: collection },
      { body: null, method: "GET", url: member },
      { body: request, method: "POST", url: collection },
      { body: request, method: "PATCH", url: member },
      { body: { base_revision: 8 }, method: "DELETE", url: member },
    ]);
  });

  it("preserves surrounding whitespace in an exact spin-transport member route", async () => {
    const requests: string[] = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        requests.push(String(url));
        return jsonResponse({ items: [], scene_revision: 7 });
      },
    });

    await api.model.spinTransport(" spin ");

    expect(requests).toEqual([
      "http://127.0.0.1:8765/v2/sessions/current/model/spin-transports/%20spin%20",
    ]);
  });

  it("preserves exact spaced transport identities in replace routes and payloads", async () => {
    const requests: Array<{ body: unknown; method: string; url: string }> = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        requests.push({
          body: init?.body ? parseRequestJsonBody(init.body) : null,
          method: init?.method ?? "GET",
          url: String(url),
        });
        return jsonResponse({ items: [], scene_revision: 7 });
      },
    });
    const currentRequest = {
      base_revision: 7,
      resource: {
        coupling: "one_way" as const,
        current_density: [1, 0, 0],
        kind: "current_transport" as const,
        model: "prescribed_density" as const,
        name: " charge ",
      },
    };
    const spinRequest = {
      base_revision: 7,
      resource: {
        boundaries: [],
        constitutive_version: "transport_constitutive.one_way.fullmag.v1",
        current_source_id: "charge",
        domain: [],
        id: " spin ",
        interfaces: [],
        materials: [],
        mode: "steady" as const,
        requested_execution: {
          device: "auto" as const,
          discretization: "auto" as const,
          execution_mode: "strict" as const,
          precision: "double" as const,
        },
        schema_version: "spin_transport.v1",
        solver: {
          default_external_boundary: "spin_insulating",
          engine: "gmres",
          linear: { absolute_tolerance: 1e-14, max_iterations: 1000, relative_tolerance: 1e-10 },
          operator_version: "fv_spin_upwind_v1",
          physical_residual_version: "transport_balance_integrated_l2.v1",
        },
      },
    };

    await api.model.replaceCurrentTransport(" charge ", currentRequest);
    await api.model.replaceSpinTransport(" spin ", spinRequest);

    expect(requests).toEqual([
      {
        body: currentRequest,
        method: "PATCH",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/current-transports/%20charge%20",
      },
      {
        body: spinRequest,
        method: "PATCH",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/spin-transports/%20spin%20",
      },
    ]);
  });

  it("preserves the typed structured-current closure through the current-transport facade", async () => {
    const requests: Array<{ body: unknown; method: string; url: string }> = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        requests.push({
          body: init?.body ? parseRequestJsonBody(init.body) : null,
          method: init?.method ?? "GET",
          url: String(url),
        });
        return jsonResponse({ items: [], scene_revision: 7 });
      },
    });
    const request: CurrentTransportMutationRequest = {
      base_revision: 7,
      resource: {
        boundaries: [],
        coupling: "one_way",
        domain: [{ object_id: "ring" }],
        gauge: "zero_mean",
        kind: "current_transport",
        materials: [],
        model: "ohmic_poisson",
        name: "closed-loop",
        solver: {
          engine: "cg",
          linear: { absolute_tolerance: 1e-14, max_iterations: 1000, relative_tolerance: 1e-10 },
          operator_version: "fv_charge_harmonic_source_cut_v1",
          physical_residual_version: "charge_balance_integrated_l2.v1",
        },
        structured_current_closure: {
          closure_id: "ring-closure",
          kind: "closed_geometry",
          schema_version: "structured_current_closure.v1",
          source_cuts: [{
            circuit_id: "ring-circuit",
            drive: {
              drive_id: "ring-drive",
              kind: "impressed_potential_jump",
              potential_jump_V: 0.125,
              schema_version: "impressed_potential_jump.v1",
            },
            plane: { axis: "y", normal: "positive_axis", offset_m: 2e-9 },
            region: { object_id: "ring", region_id: "source-arm" },
            source_cut_id: "ring-cut",
          }],
        },
      },
    };

    await api.model.replaceCurrentTransport("closed-loop", request);

    expect(requests).toEqual([{
      body: request,
      method: "PATCH",
      url: "http://127.0.0.1:8765/v2/sessions/current/model/current-transports/closed-loop",
    }]);
  });

  it("routes spin-interface projection and clone-only transport validation through model resources", async () => {
    const requests: Array<{ body: unknown; method: string; url: string }> = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        requests.push({
          body: init?.body ? parseRequestJsonBody(init.body) : null,
          method: init?.method ?? "GET",
          url: String(url),
        });
        return jsonResponse({ items: [], scene_revision: 7 });
      },
    });
    const validation = {
      base_revision: 7,
      candidate: {
        kind: "current_transport" as const,
        operation: "create" as const,
        resource: {
          coupling: "one_way" as const,
          current_density: [1, 0, 0],
          kind: "current_transport" as const,
          model: "prescribed_density" as const,
          name: "charge",
        },
      },
      validation_version: "transport-authoring-validation.v1",
    };

    await api.model.spinInterfaces();
    await api.model.validateTransport(validation);

    expect(requests).toEqual([
      {
        body: null,
        method: "GET",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/spin-interfaces",
      },
      {
        body: validation,
        method: "POST",
        url: "http://127.0.0.1:8765/v2/sessions/current/model/transport-validation",
      },
    ]);
  });
});
