import { describe, expect, it } from "vitest";

import type {
  FieldMetaResource,
  VisualizationClientAckResource,
} from "@/kernel/api/apiTypes";
import { DATA_FIELD_VECTOR_PATH } from "@/kernel/api/apiPaths";
import type { RequestDiagnosticEntry } from "@/kernel/api/RequestDiagnosticsController";
import { resolveFieldMetaResourceKey } from "@/kernel/resources/studyRuntimeResources";
import type { SelectionRef } from "@/kernel/selection/selectionTypes";
import type {
  VisualizationDebugCarrierSnapshot,
  VisualizationDebugSnapshot,
} from "@/kernel/visualization/visualizationDebugTypes";

import {
  buildVisualizationDebugPanelModel,
  compareBackendAndRender,
  resolveVisualizationDebugCarrierQuery,
  resolveVisualizationDebugTarget,
} from "./VisualizationDebugPanelModel";
import { visualizationDebugFieldMetaHookInput } from "./useVisualizationDebugPanelModel";
import { buildVisualizationDebugExport } from "./visualizationDebugExport";

const VECTOR_PATH = DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m");

function selection(
  value:
    | { kind: "airbox" }
    | { kind: "object"; objectId: string }
    | { kind: "region"; objectId: string; regionId: string },
): SelectionRef {
  if (value.kind === "airbox") {
    return {
      kind: "airbox.visualization.debug",
      nodeId: "airbox:visualization:debug",
      type: "airbox",
      visualizationTargetId: "airbox",
    };
  }
  const visualizationTargetId =
    value.kind === "region"
      ? (`region:${value.objectId}:${encodeURIComponent(value.regionId)}` as const)
      : (`object:${value.objectId}` as const);
  return {
    kind:
      value.kind === "region"
        ? "object.region.visualization.debug"
        : "object.visualization.debug",
    nodeId: `${visualizationTargetId}:visualization:debug`,
    objectId: value.objectId,
    regionId: value.kind === "region" ? value.regionId : undefined,
    type: "scene-object",
    visualizationTargetId,
  };
}

function carrier({
  carrierId = "part:magnet",
  component = "full",
  fieldRevision = "12",
  quantityId = "m",
  resourceKey = `${VECTOR_PATH}?component=full&scope_kind=object&scope_id=magnet&snapshot_id=snap-4&stage_id=relax`,
  scopeId = "magnet",
  scopeKind = "object",
}: Partial<{
  carrierId: string;
  component: string;
  fieldRevision: string;
  quantityId: string;
  resourceKey: string | null;
  scopeId: string | null;
  scopeKind: string;
}> = {}): VisualizationDebugCarrierSnapshot {
  return {
    cache: {
      byteLength: 512,
      entryState: "ready",
      etag: '"field-12"',
      fieldCacheByteLength: 512,
      fieldCacheEntryCount: 1,
      fieldCacheMaxBytes: 4096,
      retainCount: 1,
    },
    carrierId,
    carrierRole: "magnetic",
    memory: [],
    payload: {
      component: null,
      dtype: "float64",
      formatVersion: 3,
      grid: [2, 2, 1],
      indexing: "explicit_node_indices",
      nComp: 3,
      nodeIndexCount: 4,
      pointCount: 4,
      quantityId,
      scopeId,
      scopeKind,
      valueCount: 12,
    },
    render: {
      adoption: {
        frameCommitId: "frame-12",
        surface: {
          adoptedAtMs: 12,
          adoptedFieldBufferId: "buffer-12",
          adoptedResourceKey: resourceKey,
          adoptedScalarBufferKey: "scalar-12",
          adoptionSequence: 12,
        },
        vector: {
          adoptedAtMs: 12,
          adoptedFieldBufferId: "buffer-12",
          adoptedResourceKey: resourceKey,
          adoptedVectorBuildKey: "vectors-12",
          adoptedVectorItemCount: 4,
          adoptionSequence: 12,
        },
      },
      fieldBufferState: "ready",
      requestedFieldBufferId: "buffer-12",
      requestedPasses: ["surface", "vector-glyph"],
      surface: {
        bufferKey: "scalar-12",
        colorMode: component,
        degradation: null,
        projectionMode: "magnitude",
        scalarByteLength: 32,
      },
      vectors: {
        buildKey: "vectors-12",
        degradation: null,
        segmentByteLength: 96,
        segmentCount: 4,
      },
    },
    request: { plannerRequestId: "request-12", resourceKey },
    revisions: {
      domainGenerationId: "domain-1",
      fieldRevision,
      meshTopologyHash: "mesh-1",
      topologyRevision: "topology-1",
      visualizationRevision: "9",
    },
    samples: [],
    scanState: "complete",
    statistics: [
      {
        finiteCount: 4,
        max: 3,
        mean: 2,
        min: 1,
        nonFiniteCount: 0,
        p01: 1,
        p99: 3,
        source: "render-derived",
        zeroCount: 0,
      },
    ],
  };
}

function snapshot({
  carriers = [carrier()],
  targetId = "object:magnet",
  viewportId = "viewport-primary",
}: Partial<{
  carriers: VisualizationDebugCarrierSnapshot[];
  targetId: string;
  viewportId: string;
}> = {}): VisualizationDebugSnapshot {
  return {
    capturedAtMs: 1200,
    carriers,
    disposition: "ready",
    issues: [],
    sharedMemory: [],
    target: {
      carrierIds: carriers.map((item) => item.carrierId),
      id: targetId,
      kind: targetId === "airbox" ? "airbox" : targetId.startsWith("region:") ? "region" : "object",
      label: targetId,
    },
    viewport: {
      contextLost: false,
      drawingBuffer: [1280, 720],
      frameCommittedAtMs: 1190,
      frameCommitId: `frame:${viewportId}`,
      viewportId,
    },
    version: 1,
  };
}

function diagnostic(
  resourceKey: string,
  timestampMs: number,
  overrides: Partial<RequestDiagnosticEntry> = {},
): RequestDiagnosticEntry {
  return {
    byteLength: 10,
    channel: "http",
    contentType: "application/octet-stream",
    detail: null,
    direction: "rx",
    durationMs: 2,
    etag: null,
    id: String(timestampMs),
    messageType: null,
    method: "GET",
    outcome: "ok",
    path: resourceKey,
    requestId: `request-${timestampMs}`,
    resourceKey,
    status: 200,
    timestampMs,
    ...overrides,
  };
}

function backendMeta(fieldRevision = 12): FieldMetaResource {
  return {
    components: 3,
    domain_generation_id: "domain-1",
    field_revision: fieldRevision,
    kind: "vector",
    label: "Magnetization",
    location: "node",
    materialization_wall_time_ns: 0,
    materialized_at_unix_ms: 0,
    quantity_id: "m",
    source_revision: fieldRevision,
    source_step: 0,
    stale_by_steps: 0,
    state: "complete",
    stats: { max: 3, mean: 2, min: 1 },
    unit: "A/m",
  };
}

describe("VisualizationDebugPanelModel", () => {
  it("resolves only canonical Airbox, object and region targets from SelectionRef", () => {
    expect(resolveVisualizationDebugTarget(selection({ kind: "airbox" }))).toEqual({
      id: "airbox",
      kind: "airbox",
      selectionKind: "airbox.visualization.debug",
    });
    expect(
      resolveVisualizationDebugTarget({
        kind: "airbox.visualization.debug",
        nodeId: "model:airbox:visualization:debug",
        type: "airbox",
        visualizationTargetId: "fdm-universe-outside-support",
      }),
    ).toEqual({
      id: "fdm-universe-outside-support",
      kind: "airbox",
      selectionKind: "airbox.visualization.debug",
    });
    expect(
      resolveVisualizationDebugTarget(
        selection({ kind: "object", objectId: "free-layer" }),
      ),
    ).toEqual({
      id: "object:free-layer",
      kind: "object",
      selectionKind: "object.visualization.debug",
    });
    expect(
      resolveVisualizationDebugTarget(
        selection({ kind: "region", objectId: "free-layer", regionId: "edge A" }),
      ),
    ).toEqual({
      id: "region:free-layer:edge%20A",
      kind: "region",
      selectionKind: "object.region.visualization.debug",
    });
    expect(
      resolveVisualizationDebugTarget({
        kind: "study.root",
        nodeId: "study",
        type: "study",
      }),
    ).toBeNull();
    for (const mismatched of [
      {
        ...selection({ kind: "airbox" }),
        visualizationTargetId: "object:free-layer" as const,
      },
      {
        ...selection({ kind: "object", objectId: "free-layer" }),
        visualizationTargetId: "region:free-layer:core" as const,
      },
      {
        ...selection({ kind: "region", objectId: "free-layer", regionId: "core" }),
        visualizationTargetId: "object:free-layer" as const,
      },
    ]) {
      expect(
        resolveVisualizationDebugTarget(mismatched as unknown as SelectionRef),
      ).toBeNull();
    }
    expect(
      resolveVisualizationDebugTarget({
        kind: "object.root",
        nodeId: "object:free-layer",
        objectId: "free-layer",
        type: "scene-object",
        visualizationTargetId: "object:free-layer",
      }),
    ).toBeNull();
    expect(
      resolveVisualizationDebugTarget({
        kind: "airbox.visualization",
        nodeId: "airbox:visualization",
        type: "airbox",
        visualizationTargetId: "airbox",
      }),
    ).toBeNull();
  });

  it.each([
    ["active-non-3d", "cross-section-image", [], "active-non-3d"],
    ["missing snapshot", "viewport-3d", [], "missing-snapshot"],
    [
      "missing viewport identity",
      "viewport-3d",
      [snapshot({ viewportId: "" })],
      "missing-viewport",
    ],
    [
      "target absent from render model",
      "viewport-3d",
      [snapshot({ carriers: [], targetId: "object:magnet" })],
      "target-not-rendered",
    ],
  ])("models %s explicitly", (_label, activeModule, snapshots, expected) => {
    const model = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: activeModule,
      clientAcks: null,
      diagnostics: [],
      fieldMetaByQueryKey: new Map(),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots,
    });
    expect(model.state).toBe(expected);
  });

  it("keeps two viewports and two carriers grouped without merging identities", () => {
    const firstKey = `${VECTOR_PATH}?component=x&scope_kind=part&scope_id=a&snapshot_id=s1&stage_id=stage-a&view=real`;
    const secondKey = `${VECTOR_PATH}?component=y&scope_kind=part&scope_id=b&snapshot_id=s2&stage_id=stage-b&view=imaginary`;
    const model = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks: null,
      diagnostics: [],
      fieldMetaByQueryKey: new Map(),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots: [
        snapshot({
          carriers: [
            carrier({ carrierId: "part:a", component: "x", resourceKey: firstKey, scopeId: "a", scopeKind: "part" }),
            carrier({ carrierId: "part:b", component: "y", resourceKey: secondKey, scopeId: "b", scopeKind: "part" }),
          ],
          viewportId: "viewport-primary",
        }),
        snapshot({
          carriers: [carrier({ carrierId: "part:a", component: "x", resourceKey: firstKey, scopeId: "a", scopeKind: "part" })],
          viewportId: "viewport-secondary",
        }),
      ],
    });

    expect(model.viewports.map((item) => item.viewportId)).toEqual([
      "viewport-primary",
      "viewport-secondary",
    ]);
    expect(model.viewports[0]?.carriers.map((item) => item.carrierId)).toEqual([
      "part:a",
      "part:b",
    ]);
    expect(model.viewports[1]?.carriers.map((item) => item.carrierId)).toEqual([
      "part:a",
    ]);
    expect(model.fieldQueries).toHaveLength(2);
    expect(model.fieldQueries[0]).toMatchObject({
      component: "x",
      scopeId: "a",
      snapshotId: "s1",
      stageId: "stage-a",
      view: "real",
    });
    expect(model.fieldQueries[1]).toMatchObject({
      component: "y",
      scopeId: "b",
      snapshotId: "s2",
      stageId: "stage-b",
      view: "imaginary",
    });
  });

  it("groups repeated snapshots by viewport and repeated carriers by carrier id while preserving observations", () => {
    const first = snapshot({
      carriers: [carrier({ carrierId: "part:a", fieldRevision: "11" })],
      viewportId: "viewport-primary",
    });
    const second = snapshot({
      carriers: [
        carrier({ carrierId: "part:a", fieldRevision: "12" }),
        carrier({ carrierId: "part:b" }),
      ],
      viewportId: "viewport-primary",
    });
    const model = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks: null,
      diagnostics: [],
      fieldMetaByQueryKey: new Map(),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots: [first, second],
    });

    expect(model.viewports).toHaveLength(1);
    expect(model.viewports[0]?.snapshots).toEqual([first, second]);
    expect(model.viewports[0]?.carriers).toHaveLength(2);
    expect(model.viewports[0]?.carriers[0]?.carrierId).toBe("part:a");
    expect(model.viewports[0]?.carriers[0]?.observations).toHaveLength(2);
    expect(
      model.viewports[0]?.carriers[0]?.observations.map(
        (item) => item.carrier.revisions.fieldRevision,
      ),
    ).toEqual(["11", "12"]);
    expect(model.viewports[0]?.carriers[1]?.observations).toHaveLength(1);
  });

  it("deduplicates canonical exact queries independent of URL parameter order while preserving view and phase evidence", () => {
    const ordered = `${VECTOR_PATH}?component=full&geometry_scope=surface&max_samples=128&scope_kind=object&scope_id=magnet&snapshot_id=snap-4&stage_id=relax&view=phase_rotated_real&phase_rad=1.25`;
    const reordered = `${VECTOR_PATH}?phase_rad=1.25&view=phase_rotated_real&stage_id=relax&snapshot_id=snap-4&scope_id=magnet&scope_kind=object&max_samples=128&geometry_scope=surface&component=full`;
    const otherPhase = `${VECTOR_PATH}?component=full&geometry_scope=surface&max_samples=128&scope_kind=object&scope_id=magnet&snapshot_id=snap-4&stage_id=relax&view=phase_rotated_real&phase_rad=2.5`;
    const model = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks: null,
      diagnostics: [],
      fieldMetaByQueryKey: new Map(),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots: [
        snapshot({
          carriers: [
            carrier({ carrierId: "part:a", resourceKey: ordered }),
            carrier({ carrierId: "part:b", resourceKey: reordered }),
            carrier({ carrierId: "part:c", resourceKey: otherPhase }),
          ],
        }),
      ],
    });

    expect(model.fieldQueries).toHaveLength(2);
    expect(model.fieldQueries[0]?.key).toBe(model.viewports[0]?.carriers[0]?.observations[0]?.query?.key);
    expect(model.viewports[0]?.carriers[1]?.observations[0]?.query?.key).toBe(
      model.fieldQueries[0]?.key,
    );
    expect(model.fieldQueries.map((query) => query.phaseRad)).toEqual([1.25, 2.5]);
    expect(new Set(model.fieldQueries.map((query) => query.metaQueryKey)).size).toBe(1);
  });

  it("derives field-meta hook identity from the exact canonical carrier query", () => {
    const reordered = `${VECTOR_PATH}?phase_rad=1.25&view=phase_rotated_real&stage_id=relax&snapshot_id=snap-4&scope_id=magnet&scope_kind=object&component=full`;
    const otherPhase = `${VECTOR_PATH}?component=full&scope_kind=object&scope_id=magnet&snapshot_id=snap-4&stage_id=relax&view=phase_rotated_real&phase_rad=2.5`;
    const first = resolveVisualizationDebugCarrierQuery(
      carrier({ resourceKey: reordered }),
    );
    const second = resolveVisualizationDebugCarrierQuery(
      carrier({ resourceKey: otherPhase }),
    );
    const exactMetaQuery = {
      component: "full",
      scope_id: "magnet",
      scope_kind: "object",
      snapshot_id: "snap-4",
      stage_id: "relax",
    } as const;

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.metaQuery).toEqual(exactMetaQuery);
    expect(first?.metaResourceKey).toBe(
      resolveFieldMetaResourceKey("m", exactMetaQuery),
    );
    expect(second?.metaResourceKey).toBe(first?.metaResourceKey);
    expect(first?.metaQueryKey).toBe(second?.metaQueryKey);
    expect(first?.key).not.toBe(second?.key);

    const hookInput = visualizationDebugFieldMetaHookInput(first);
    expect(hookInput).toEqual({
      component: "full",
      enabled: false,
      quantityId: "m",
      scope_id: "magnet",
      scope_kind: "object",
      snapshot_id: "snap-4",
      stage_id: "relax",
    });
    expect(
      resolveFieldMetaResourceKey(hookInput.quantityId, {
        component: hookInput.component,
        scope_id: hookInput.scope_id,
        scope_kind: hookInput.scope_kind,
        snapshot_id: hookInput.snapshot_id,
        stage_id: hookInput.stage_id,
      }),
    ).toBe(first?.metaResourceKey);
  });

  it("keeps the canonical resource query while decoded evidence reports a mismatch", () => {
    const model = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks: null,
      diagnostics: [],
      fieldMetaByQueryKey: new Map(),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots: [
        snapshot({
          carriers: [
            carrier({
              resourceKey: `${VECTOR_PATH}?component=x&scope_kind=object&scope_id=other`,
            }),
          ],
        }),
      ],
    });

    expect(model.fieldQueries).toEqual([
      expect.objectContaining({
      component: "x",
      geometryScope: null,
      quantityId: "m",
        scopeId: "other",
        scopeKind: "object",
      }),
    ]);
    expect(model.viewports[0]?.carriers[0]?.observations[0]?.query).not.toBeNull();
  });

  it("keeps geometry scope and sample limit in exact query identity", () => {
    const base = carrier();
    const surface = carrier({
      carrierId: "part:surface",
      resourceKey: `${VECTOR_PATH}?component=full&geometry_scope=surface&scope_kind=object&scope_id=magnet&snapshot_id=snap-4&stage_id=relax`,
    });
    const sampled = carrier({
      carrierId: "part:sampled",
      resourceKey: `${VECTOR_PATH}?component=full&max_samples=128&scope_kind=object&scope_id=magnet&snapshot_id=snap-4&stage_id=relax`,
    });
    const baseQuery = resolveVisualizationDebugCarrierQuery(base)!;
    const model = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks: null,
      diagnostics: [],
      fieldMetaByQueryKey: new Map([
        [baseQuery.metaQueryKey, backendMeta(12)],
      ]),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots: [snapshot({ carriers: [base, surface, sampled] })],
    });
    const observations = model.viewports[0]!.carriers.flatMap(
      (group) => group.observations,
    );

    expect(new Set(model.fieldQueries.map((query) => query.key)).size).toBe(3);
    expect(model.fieldQueries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ geometryScope: "surface", maxSamples: null }),
        expect.objectContaining({ geometryScope: null, maxSamples: 128 }),
      ]),
    );
    expect(observations[0]?.backendMeta).toEqual(backendMeta(12));
    expect(observations[1]?.backendMeta).toBeNull();
    expect(observations[2]?.backendMeta).toBeNull();
    expect(model.disposition).toBe("unknown");
  });

  it.each(["base-first", "complex-first"] as const)(
    "does not attach base metadata to a coexisting complex query (%s)",
    (order) => {
      const baseCarrier = carrier({ carrierId: "part:base" });
      const complexCarrier = carrier({
        carrierId: "part:complex",
        resourceKey: `${VECTOR_PATH}?component=full&scope_kind=object&scope_id=magnet&snapshot_id=snap-4&stage_id=relax&view=phase_rotated_real&phase_rad=1.25`,
      });
      const baseQuery = resolveVisualizationDebugCarrierQuery(baseCarrier)!;
      const carriers =
        order === "base-first"
          ? [baseCarrier, complexCarrier]
          : [complexCarrier, baseCarrier];
      const model = buildVisualizationDebugPanelModel({
        activeViewportMainModuleId: "viewport-3d",
        clientAcks: null,
        diagnostics: [],
        fieldMetaByQueryKey: new Map([
          [baseQuery.metaQueryKey, backendMeta(12)],
        ]),
        selection: selection({ kind: "object", objectId: "magnet" }),
        snapshots: [snapshot({ carriers })],
      });
      const observations = model.viewports[0]!.carriers.flatMap(
        (group) => group.observations,
      );

      expect(
        observations.find((entry) => entry.carrier.carrierId === "part:base")
          ?.backendMeta,
      ).toEqual(backendMeta(12));
      expect(
        observations.find(
          (entry) => entry.carrier.carrierId === "part:complex",
        )?.backendMeta,
      ).toBeNull();
      expect(model.disposition).toBe("unknown");
    },
  );

  it("filters transport by exact carrier resource keys only and caps the total at eight", () => {
    const exact = carrier().request.resourceKey!;
    const otherScope = exact.replace("scope_id=magnet", "scope_id=magnet-2");
    const similarPrefix = `${exact}-shadow`;
    const entries = [
      diagnostic(otherScope, 30),
      diagnostic(similarPrefix, 29),
      ...Array.from({ length: 10 }, (_, index) => diagnostic(exact, 28 - index)),
    ];
    const model = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks: null,
      diagnostics: entries,
      fieldMetaByQueryKey: new Map(),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots: [snapshot()],
    });

    expect(model.transport).toHaveLength(8);
    expect(model.transport.every((item) => item.resourceKey === exact)).toBe(true);
  });

  it("uses only the newest terminal exact transport outcome for composite health", () => {
    const exact = carrier().request.resourceKey!;
    const query = resolveVisualizationDebugCarrierQuery(carrier())!;
    const build = (diagnostics: RequestDiagnosticEntry[]) =>
      buildVisualizationDebugPanelModel({
        activeViewportMainModuleId: "viewport-3d",
        clientAcks: null,
        diagnostics,
        fieldMetaByQueryKey: new Map([[query.metaQueryKey, backendMeta(12)]]),
        selection: selection({ kind: "object", objectId: "magnet" }),
        snapshots: [snapshot()],
      });
    const decodeError = diagnostic(exact, 20, {
      detail: "binary decode failed",
      outcome: "error",
      status: 200,
    });
    const olderSuccess = diagnostic(exact, 10, {
      detail: "decoded binary payload",
      outcome: "ok",
    });
    const blocked = build([olderSuccess, decodeError]);

    expect(blocked.disposition).toBe("blocked");
    expect(blocked.issues).toContainEqual(
      expect.objectContaining({ code: "field-request-error" }),
    );

    const recovered = build([
      decodeError,
      diagnostic(exact, 30, {
        detail: "decoded binary payload",
        outcome: "ok",
      }),
      diagnostic(exact, 40, {
        detail: "attempt 1",
        direction: "tx",
        outcome: "sent",
        status: null,
      }),
    ]);
    expect(recovered.disposition).toBe("ready");
    expect(recovered.issues).not.toContainEqual(
      expect.objectContaining({ code: "field-request-error" }),
    );
  });

  it("derives backend range and exact wire/cache evidence at the panel join", () => {
    const exactCarrier = carrier();
    const exact = exactCarrier.request.resourceKey!;
    const query = resolveVisualizationDebugCarrierQuery(exactCarrier)!;
    const model = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks: null,
      diagnostics: [
        diagnostic(exact, 20, {
          byteLength: 999,
          detail: "decoded binary payload",
        }),
      ],
      fieldMetaByQueryKey: new Map([
        [
          query.metaQueryKey,
          { ...backendMeta(12), stats: { max: 30, mean: 20, min: 10 } },
        ],
      ]),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots: [snapshot()],
    });

    expect(model.disposition).toBe("degraded");
    expect(model.issues).toContainEqual(
      expect.objectContaining({ code: "backend-render-range-mismatch" }),
    );
    expect(model.issues).toContainEqual(
      expect.objectContaining({ code: "transport-cache-byte-mismatch" }),
    );
    expect(
      model.viewports[0]?.carriers[0]?.observations[0]?.wireByteLength,
    ).toBe(999);
  });

  it("does not compare aggregated transport bytes or full-vector backend stats to a derived surface", () => {
    const exactCarrier = carrier({ component: "x" });
    const fullQueryCarrier = carrier();
    fullQueryCarrier.render = {
      ...fullQueryCarrier.render,
      surface: { ...fullQueryCarrier.render.surface, colorMode: "x" },
    };
    const exact = fullQueryCarrier.request.resourceKey!;
    const query = resolveVisualizationDebugCarrierQuery(fullQueryCarrier)!;
    const model = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks: null,
      diagnostics: [
        diagnostic(exact, 20, {
          byteLength: 1024,
          detail: "decoded binary payload (x2 over 1ms)",
        }),
      ],
      fieldMetaByQueryKey: new Map([[query.metaQueryKey, backendMeta(12)]]),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots: [snapshot({ carriers: [fullQueryCarrier] })],
    });

    expect(exactCarrier.render.surface.colorMode).toBe("x");
    expect(model.issues).not.toContainEqual(
      expect.objectContaining({ code: "backend-render-range-mismatch" }),
    );
    expect(model.issues).not.toContainEqual(
      expect.objectContaining({ code: "transport-cache-byte-mismatch" }),
    );
    expect(
      model.viewports[0]?.carriers[0]?.observations[0]?.wireByteLength,
    ).toBeNull();
    expect(
      model.viewports[0]?.carriers[0]?.observations[0]
        ?.backendRenderComparison,
    ).toBeNull();
    expect(model.disposition).toBe("unknown");
    expect(model.issues).toContainEqual(
      expect.objectContaining({
        code: "backend-meta-incomparable",
        severity: "info",
      }),
    );
    expect(model.issues).not.toContainEqual(
      expect.objectContaining({ code: "backend-render-incompatible" }),
    );
  });

  it("treats orientation coloring as a derived projection of an exact full-vector field", () => {
    const fullVectorCarrier = carrier();
    fullVectorCarrier.render = {
      ...fullVectorCarrier.render,
      surface: {
        ...fullVectorCarrier.render.surface,
        colorMode: "orientation",
      },
    };
    const query = resolveVisualizationDebugCarrierQuery(fullVectorCarrier)!;
    const model = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks: null,
      diagnostics: [],
      fieldMetaByQueryKey: new Map([[query.metaQueryKey, backendMeta(12)]]),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots: [snapshot({ carriers: [fullVectorCarrier] })],
    });

    expect(
      model.viewports[0]?.carriers[0]?.observations[0]
        ?.backendRenderComparison,
    ).toBeNull();
    expect(model.disposition).toBe("unknown");
    expect(model.issues).toContainEqual(
      expect.objectContaining({
        code: "backend-meta-incomparable",
        evidence: expect.arrayContaining([
          "query_component=full",
          "rendered_component=orientation",
        ]),
        severity: "info",
      }),
    );
    expect(model.issues).not.toContainEqual(
      expect.objectContaining({ code: "backend-render-incompatible" }),
    );
  });

  it("keeps composite health unknown without fresh exact backend metadata", () => {
    const model = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks: null,
      diagnostics: [],
      fieldMetaByQueryKey: new Map(),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots: [snapshot()],
    });

    expect(model.disposition).toBe("unknown");
    expect(model.issues).toContainEqual(
      expect.objectContaining({
        code: "backend-meta-incomparable",
        evidence: expect.arrayContaining(["backend_meta=unavailable"]),
        severity: "info",
      }),
    );
  });

  it("compares the physical response field revision without treating ETag as that revision", () => {
    const exactCarrier = carrier();
    exactCarrier.cache = { ...exactCarrier.cache, etag: '"opaque-etag"' };
    const query = resolveVisualizationDebugCarrierQuery(exactCarrier)!;
    const model = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks: null,
      diagnostics: [],
      fieldMetaByQueryKey: new Map([[query.metaQueryKey, backendMeta(12)]]),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots: [snapshot({ carriers: [exactCarrier] })],
    });

    expect(model.disposition).toBe("ready");
    expect(model.issues).not.toContainEqual(
      expect.objectContaining({ code: "field-revision-stale" }),
    );
  });

  it.each([
    ["11", 12, "degraded", true],
    ["13", 12, "unknown", false],
    ["opaque", 12, "unknown", false],
  ] as const)(
    "classifies rendered physical revision %s against backend %s",
    (fieldRevision, backendRevision, disposition, stale) => {
      const exactCarrier = carrier({ fieldRevision });
      const query = resolveVisualizationDebugCarrierQuery(exactCarrier)!;
      const model = buildVisualizationDebugPanelModel({
        activeViewportMainModuleId: "viewport-3d",
        clientAcks: null,
        diagnostics: [],
        fieldMetaByQueryKey: new Map([
          [query.metaQueryKey, backendMeta(backendRevision)],
        ]),
        selection: selection({ kind: "object", objectId: "magnet" }),
        snapshots: [snapshot({ carriers: [exactCarrier] })],
      });

      expect(model.disposition).toBe(disposition);
      expect(
        model.issues.some((entry) => entry.code === "field-revision-stale"),
      ).toBe(stale);
    },
  );

  it("compares semantic component aliases but not different components", () => {
    const xResourceKey = `${VECTOR_PATH}?component=x&scope_kind=object&scope_id=magnet&snapshot_id=snap-4&stage_id=relax`;
    const c0Carrier = carrier({
      component: "c0",
      resourceKey: xResourceKey,
    });
    const c1Carrier = carrier({
      component: "c1",
      resourceKey: xResourceKey,
    });
    const query = resolveVisualizationDebugCarrierQuery(c0Carrier)!;

    expect(
      compareBackendAndRender({
        backendMeta: backendMeta(12),
        carrier: c0Carrier,
        query,
      }),
    ).toEqual({ compatible: true, rangesMatch: true });
    expect(
      compareBackendAndRender({
        backendMeta: backendMeta(12),
        carrier: c1Carrier,
        query,
      }),
    ).toEqual({ compatible: false, rangesMatch: null });
    const model = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks: null,
      diagnostics: [],
      fieldMetaByQueryKey: new Map([
        [query.metaQueryKey, backendMeta(12)],
      ]),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots: [snapshot({ carriers: [c1Carrier] })],
    });
    expect(model.disposition).toBe("degraded");
    expect(model.issues).toContainEqual(
      expect.objectContaining({ code: "backend-render-incompatible" }),
    );
  });

  it("deduplicates and globally caps composite issues at twenty", () => {
    const issues = Array.from({ length: 25 }, (_, index) => ({
      code: `issue-${index}`,
      evidence: [`index=${index}`],
      message: `Issue ${index}`,
      severity: "warning" as const,
      source: "render-derived" as const,
    }));
    const noisySnapshot = {
      ...snapshot(),
      disposition: "degraded" as const,
      issues: [issues[0]!, ...issues],
    };
    const model = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks: null,
      diagnostics: [],
      fieldMetaByQueryKey: new Map(),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots: [noisySnapshot],
    });

    expect(model.issues).toHaveLength(20);
    expect(model.issues.map((entry) => entry.code)).toEqual(
      Array.from({ length: 20 }, (_, index) => `issue-${index}`),
    );
  });

  it("keeps a late blocking transport cause inside the bounded issue list", () => {
    const exact = carrier().request.resourceKey!;
    const infoIssues = Array.from({ length: 25 }, (_, index) => ({
      code: `note-${index}`,
      evidence: [`index=${index}`],
      message: `Note ${index}`,
      severity: "info" as const,
      source: "ui-derived" as const,
    }));
    const model = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks: null,
      diagnostics: [
        diagnostic(exact, 100, {
          detail: "binary decode failed",
          outcome: "error",
          status: 200,
        }),
      ],
      fieldMetaByQueryKey: new Map(),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots: [
        {
          ...snapshot(),
          disposition: "ready",
          issues: infoIssues,
        },
      ],
    });

    expect(model.disposition).toBe("blocked");
    expect(model.issues).toHaveLength(20);
    expect(model.issues[0]).toMatchObject({
      code: "field-request-error",
      severity: "error",
    });
  });

  it("publishes target-not-active only once when snapshot and panel evidence agree", () => {
    const model = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks: null,
      diagnostics: [],
      fieldMetaByQueryKey: new Map(),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots: [
        {
          ...snapshot({ carriers: [] }),
          disposition: "unknown",
          issues: [
            {
              code: "target-not-active",
              evidence: ["targetActive"],
              message: "Target is not active in the current render model.",
              severity: "warning",
              source: "ui-derived",
            },
          ],
        },
      ],
    });

    expect(model.issues.filter((entry) => entry.code === "target-not-active"))
      .toHaveLength(1);
  });

  it("treats vector-only exact adoption as comparable without range evidence", () => {
    const vectorOnly = carrier();
    vectorOnly.render = {
      ...vectorOnly.render,
      requestedPasses: ["vector-glyph"],
      surface: {
        bufferKey: null,
        colorMode: null,
        degradation: null,
        projectionMode: null,
        scalarByteLength: null,
      },
    };
    const query = resolveVisualizationDebugCarrierQuery(vectorOnly)!;

    expect(
      compareBackendAndRender({
        backendMeta: backendMeta(12),
        carrier: vectorOnly,
        query,
      }),
    ).toEqual({ compatible: true, rangesMatch: null });

    const wrongBuild = {
      ...vectorOnly,
      render: {
        ...vectorOnly.render,
        adoption: {
          ...vectorOnly.render.adoption,
          vector: {
            ...vectorOnly.render.adoption.vector!,
            adoptedVectorBuildKey: "vectors-other",
          },
        },
      },
    };
    expect(
      compareBackendAndRender({
        backendMeta: backendMeta(12),
        carrier: wrongBuild,
        query,
      }),
    ).toEqual({ compatible: false, rangesMatch: null });

    const ready = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks: null,
      diagnostics: [],
      fieldMetaByQueryKey: new Map([
        [query.metaQueryKey, backendMeta(12)],
      ]),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots: [snapshot({ carriers: [vectorOnly] })],
    });
    expect(ready.disposition).toBe("ready");

    const degraded = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks: null,
      diagnostics: [],
      fieldMetaByQueryKey: new Map([
        [query.metaQueryKey, backendMeta(12)],
      ]),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots: [snapshot({ carriers: [wrongBuild] })],
    });
    expect(degraded.disposition).toBe("degraded");
    expect(degraded.issues).toContainEqual(
      expect.objectContaining({
        code: "backend-render-incompatible",
        severity: "warning",
      }),
    );
  });

  it("compares backend and render ranges only with exact component and adopted surface evidence", () => {
    const base = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks: null,
      diagnostics: [],
      fieldMetaByQueryKey: new Map(),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots: [snapshot()],
    });
    const queryKey = base.fieldQueries[0]!.metaQueryKey;

    const compatible = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks: null,
      diagnostics: [],
      fieldMetaByQueryKey: new Map([[queryKey, backendMeta(12)]]),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots: [snapshot()],
    });
    expect(compatible.viewports[0]?.carriers[0]?.observations[0]?.backendRenderComparison).toEqual({
      compatible: true,
      rangesMatch: true,
    });

    const backendOlderThanRender = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks: null,
      diagnostics: [],
      fieldMetaByQueryKey: new Map([[queryKey, backendMeta(11)]]),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots: [snapshot()],
    });
    expect(
      backendOlderThanRender.viewports[0]?.carriers[0]?.observations[0]
        ?.backendRenderComparison,
    ).toBeNull();

    const query = base.fieldQueries[0]!;
    expect(
      compareBackendAndRender({
        backendMeta: backendMeta(12),
        carrier: carrier(),
        query: { ...query, component: "x" },
      }),
    ).toEqual({ compatible: false, rangesMatch: null });

    const exactCarrier = carrier();
    const missingComponentEvidence = {
      ...exactCarrier,
      render: {
        ...exactCarrier.render,
        surface: { ...exactCarrier.render.surface, colorMode: null },
      },
    };
    const missingAdoptionEvidence = {
      ...exactCarrier,
      render: {
        ...exactCarrier.render,
        adoption: {
          ...exactCarrier.render.adoption,
          surface: {
            ...exactCarrier.render.adoption.surface!,
            adoptedFieldBufferId: null,
            adoptedScalarBufferKey: null,
          },
        },
        requestedFieldBufferId: null,
        surface: { ...exactCarrier.render.surface, bufferKey: null },
      },
    };
    for (const incomplete of [
      missingComponentEvidence,
      missingAdoptionEvidence,
    ]) {
      expect(
        compareBackendAndRender({
          backendMeta: backendMeta(12),
          carrier: incomplete,
          query,
        }),
      ).toBeNull();
    }

    const wrongAdoptedResource = {
      ...exactCarrier,
      render: {
        ...exactCarrier.render,
        adoption: {
          ...exactCarrier.render.adoption,
          surface: {
            ...exactCarrier.render.adoption.surface!,
            adoptedResourceKey: `${query.vectorResourceKey}:other`,
          },
        },
      },
    };
    expect(
      compareBackendAndRender({
        backendMeta: backendMeta(12),
        carrier: wrongAdoptedResource,
        query,
      }),
    ).toEqual({ compatible: false, rangesMatch: null });

    const decodedOnlyStatistics = {
      ...exactCarrier,
      statistics: exactCarrier.statistics.map((entry) => ({
        ...entry,
        source: "decoded-payload" as const,
      })),
    };
    expect(
      compareBackendAndRender({
        backendMeta: backendMeta(12),
        carrier: decodedOnlyStatistics,
        query,
      }),
    ).toEqual({ compatible: true, rangesMatch: null });

    for (const incompatibleQuery of [
      { ...query, scopeId: "other" },
      { ...query, scopeKind: "part" },
    ]) {
      expect(
        compareBackendAndRender({
          backendMeta: backendMeta(12),
          carrier: carrier(),
          query: incompatibleQuery,
        }),
      ).toEqual({ compatible: false, rangesMatch: null });
    }
    expect(
      compareBackendAndRender({
        backendMeta: { ...backendMeta(12), domain_generation_id: "domain-old" },
        carrier: carrier(),
        query,
      }),
    ).toEqual({ compatible: false, rangesMatch: null });
  });

  it("keeps backend metadata incomparable for complex, surface, and subsampled queries", () => {
    const complexResourceKey = `${VECTOR_PATH}?component=full&scope_kind=object&scope_id=magnet&snapshot_id=snap-4&stage_id=relax&view=phase_rotated_real&phase_rad=1.25`;
    const complexCarrier = carrier({ resourceKey: complexResourceKey });
    const base = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks: null,
      diagnostics: [],
      fieldMetaByQueryKey: new Map(),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots: [snapshot({ carriers: [complexCarrier] })],
    });
    const query = base.fieldQueries[0]!;
    const model = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks: null,
      diagnostics: [],
      fieldMetaByQueryKey: new Map([[query.metaQueryKey, backendMeta(12)]]),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots: [snapshot({ carriers: [complexCarrier] })],
    });

    expect(
      model.viewports[0]?.carriers[0]?.observations[0]?.backendRenderComparison,
    ).toBeNull();
    expect(
      compareBackendAndRender({
        backendMeta: backendMeta(12),
        carrier: complexCarrier,
        query,
      }),
    ).toBeNull();
    expect(model.issues).toContainEqual(
      expect.objectContaining({
        code: "backend-meta-incomparable",
        severity: "info",
      }),
    );
    expect(buildVisualizationDebugExport(model, 1_234).document.model.issues)
      .toContainEqual(
        expect.objectContaining({ code: "backend-meta-incomparable" }),
      );
    for (const resourceKey of [
      `${VECTOR_PATH}?component=full&scope_kind=object&scope_id=magnet&geometry_scope=surface`,
      `${VECTOR_PATH}?component=full&scope_kind=object&scope_id=magnet&max_samples=128`,
    ]) {
      const unsupportedCarrier = carrier({ resourceKey });
      const unsupportedQuery =
        resolveVisualizationDebugCarrierQuery(unsupportedCarrier);
      expect(unsupportedQuery).not.toBeNull();
      expect(
        compareBackendAndRender({
          backendMeta: backendMeta(12),
          carrier: unsupportedCarrier,
          query: unsupportedQuery,
        }),
      ).toBeNull();
      const unsupportedModel = buildVisualizationDebugPanelModel({
        activeViewportMainModuleId: "viewport-3d",
        clientAcks: null,
        diagnostics: [],
        fieldMetaByQueryKey: new Map(),
        selection: selection({ kind: "object", objectId: "magnet" }),
        snapshots: [snapshot({ carriers: [unsupportedCarrier] })],
      });
      expect(unsupportedModel.disposition).toBe("unknown");
      expect(unsupportedModel.issues).toContainEqual(
        expect.objectContaining({
          code: "backend-meta-incomparable",
          severity: "info",
        }),
      );
    }
    expect(model.disposition).toBe("unknown");
  });

  it("keeps backend/render compatibility unknown when legacy FMVP omits scope and domain evidence", () => {
    const legacyCarrier = carrier();
    legacyCarrier.payload = legacyCarrier.payload
      ? {
          ...legacyCarrier.payload,
          component: null,
          formatVersion: 2,
          scopeId: null,
          scopeKind: null,
        }
      : null;
    legacyCarrier.revisions = {
      ...legacyCarrier.revisions,
      domainGenerationId: null,
      meshTopologyHash: null,
      topologyRevision: null,
    };
    const query = resolveVisualizationDebugCarrierQuery(legacyCarrier);

    expect(query).not.toBeNull();
    expect(
      compareBackendAndRender({
        backendMeta: backendMeta(12),
        carrier: legacyCarrier,
        query,
      }),
    ).toBeNull();

    const derivedProjectionsWithoutCompleteEvidence = [
      {
        backendMeta: backendMeta(12),
        carrier: {
          ...legacyCarrier,
          render: {
            ...legacyCarrier.render,
            surface: { ...legacyCarrier.render.surface, colorMode: "x" },
          },
        },
      },
      {
        backendMeta: backendMeta(12),
        carrier: {
          ...legacyCarrier,
          payload: null,
          render: {
            ...legacyCarrier.render,
            surface: { ...legacyCarrier.render.surface, colorMode: "x" },
          },
        },
      },
    ];
    for (const projection of derivedProjectionsWithoutCompleteEvidence) {
      expect(
        compareBackendAndRender({
          ...projection,
          query,
        }),
      ).toBeNull();
    }

    const knownMismatches = [
      {
        backendMeta: backendMeta(12),
        carrier: {
          ...legacyCarrier,
          render: {
            ...legacyCarrier.render,
            adoption: {
              ...legacyCarrier.render.adoption,
              surface: {
                ...legacyCarrier.render.adoption.surface!,
                adoptedFieldBufferId: "other-buffer",
              },
            },
          },
        },
      },
      {
        backendMeta: { ...backendMeta(12), quantity_id: "H_demag" },
        carrier: legacyCarrier,
      },
      {
        backendMeta: backendMeta(12),
        carrier: {
          ...legacyCarrier,
          payload: legacyCarrier.payload
            ? { ...legacyCarrier.payload, scopeId: "other" }
            : null,
        },
      },
    ];
    for (const mismatch of knownMismatches) {
      expect(
        compareBackendAndRender({
          ...mismatch,
          query,
        }),
      ).toEqual({ compatible: false, rangesMatch: null });
    }
  });

  it("labels client acknowledgements as viewport-wide and does not attach them to carriers", () => {
    const clientAcks: VisualizationClientAckResource = {
      entries: [
        {
          client_id: "browser-a",
          received_at_unix_ms: 100,
          revision: 9,
          status: "rendered",
          viewport_id: "viewport-primary",
        },
        {
          client_id: "browser-b",
          received_at_unix_ms: 90,
          revision: 8,
          status: "applied",
          viewport_id: "viewport-secondary",
        },
      ],
      revision: 9,
    };
    const model = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks,
      diagnostics: [],
      fieldMetaByQueryKey: new Map(),
      selection: selection({ kind: "object", objectId: "magnet" }),
      snapshots: [snapshot()],
    });

    expect(model.viewports[0]?.clientAcks).toEqual([
      expect.objectContaining({
        scope: "viewport-wide",
        viewport_id: "viewport-primary",
      }),
    ]);
    expect(model.viewports[0]?.carriers[0]).not.toHaveProperty("clientAcks");
  });
});
