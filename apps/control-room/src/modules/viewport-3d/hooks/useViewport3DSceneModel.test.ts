import { readFileSync as readFileSyncRaw } from "node:fs";

import { describe, expect, it } from "vitest";

import { DEFAULT_CAMERA_REGISTRY_STATE } from "@/kernel/visualization/CameraRegistryController";
import { DATA_FIELD_VECTOR_PATH } from "@/kernel/api/apiPaths";
import {
  DEFAULT_OBJECT_VISUALIZATION,
  ObjectVisualizationController,
  resolveGlobalObjectVisualizationSettings,
  resolveTargetVisualization,
} from "@/kernel/visualization/ObjectVisualizationController";
import type { DecodedFieldVector, DecodedTopology } from "@/kernel/api/codecs";
import {
  canonicalFieldVectorQuery,
  fieldVectorResourceKey,
  serializeCanonicalFieldVectorResourceKey,
} from "@/kernel/api/fieldQueryIdentity";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  buildHysteresisChartPointSelection,
} from "@/shared/domain/study/HysteresisChart";

import {
  buildViewport3DAirboxSyntheticVectorField,
  applyViewport3DFieldLayerDiagnosticOverrides,
  resolveViewport3DActiveQuantityId,
  resolveViewport3DAnalysisComplexFieldQuery,
  resolveViewport3DAnalysisComplexProjectionEnabled,
  resolveViewport3DDisplayedLiveValue,
  resolveViewport3DFieldMetaScalarComponent,
  resolveViewport3DPrimaryFieldDataOptions,
  resolveViewport3DPrimaryFieldDemandPlan,
  resolveViewport3DPrimaryFieldRenderOptions,
  resolveViewport3DPrimaryFieldVectorEnabled,
  resolveViewport3DPrimaryFieldQuery,
  resolveViewport3DDomainRenderLane,
  resolveViewport3DFdmFieldIdentityCompatible,
  resolveViewport3DFieldRenderModelBuildOptions,
  resolveViewport3DSelectedSnapshotId,
  resolveViewport3DSelectedSnapshotQuery,
  filterViewport3DMeshBackedRegionOverlays,
  resolveViewport3DMembershipRegionOverlays,
  resolveViewport3DMeshBackedRegionKeys,
  resolveViewport3DMeshBackedRegionOverlays,
  resolveViewport3DPartVisualizationSettings,
  resolveViewport3DPartScalarRangeRequests,
  mergeViewport3DPartScalarRanges,
  resolveViewport3DRegionMembershipIds,
  resolveViewport3DRegionOverlays,
  resolveViewport3DRegionSelectionBounds,
  resolveViewport3DRegionSelectionScope,
  resolveViewport3DRegionTargetByPartId,
  resolveViewport3DRegionTargetsForMembershipOwnerParts,
  resolveViewport3DResourceFrameState,
  resolveViewport3DSceneCameraView,
  resolveViewport3DFdmTargetVisualization,
  resolveViewport3DAirboxFieldVectorDemandPlan,
  resolveViewport3DAirboxVectorSampleBudget,
  resolveViewport3DScopedPartVectorFieldDemandPlan,
  resolveViewport3DScopedPartVectorFieldRequests,
  resolveViewport3DScopedVectorFieldQuery,
  resolveViewport3DTargetFieldQuery,
  resolveViewport3DTargetQuantityFieldDemandPlan,
  resolveViewport3DTargetQuantityFieldRequests,
  resolveViewport3DFdmTargetFieldVectorForTarget,
  resolveViewport3DReplayFieldQuery,
  resolveViewport3DFieldDataIssue,
  resolveViewport3DVisualizationQuantityId,
  resolveViewport3DFdmGridVectorScale,
  resolveViewport3DVectorScale,
  mergeViewport3DQuantityCapabilityIds,
  mergeViewport3DFieldQuery,
  mergeViewport3DPrimaryTargetFieldBuffers,
  resolveViewport3DResolvedPartFieldBuffers,
  sameViewport3DQuantityId,
} from "./useViewport3DSceneModel";

import {
  resolveHysteresisStepViewportTarget,
} from "../model/viewport3DTargets";
import { summarizeViewport3DFieldDemandDiagnostics } from "../model/viewport3DFieldDataPlan";
import { resolveViewport3DFieldVectorResourceKey } from "../viewport3dResources";
import {
  buildViewport3DFieldRenderModel,
  buildViewport3DTopologyRenderModel,
  viewport3DFieldRenderOptionsNeedFieldData,
} from "../viewport3dRenderModel";
import {
  buildViewport3DTargetFieldBuffer as buildViewport3DTargetFieldBufferWithResourceKey,
} from "../model/viewport3DTargetFieldBuffer";
import {
  DEFAULT_VIEWPORT_3D_CAMERA_STATE,
  type Viewport3DCommandState,
} from "../viewport3dStore";
import {
  identifyVectorGlyphBuildResult,
  recordVectorFieldAdoption,
} from "../layers/VectorFieldLayer";
import {
  recordFdmCuboidSurfaceAdoption,
  resolveFdmVectorGlyphScaleForCellSize,
} from "../layers/FdmCuboidLayer";
import { createViewport3DRenderAdoptionRegistry } from "../model/viewport3DRenderAdoptionRegistry";
import { resolveViewport3DFieldVectorForDomain } from "../model/viewport3DFieldDomainCompatibility";
import { buildFdmSampledScalarColors } from "../viewport3dFieldMapping";

function readFileSync(
  path: Parameters<typeof readFileSyncRaw>[0],
  encoding: "utf8",
): string {
  return readFileSyncRaw(path, encoding).replace(/\r\n/g, "\n");
}

const sceneModelSourceUrl = new URL("./useViewport3DSceneModel.ts", import.meta.url);
const planarPreviewSourceUrl = new URL("../../../kernel/workspace/planarMonitorFramePreview.ts", import.meta.url);
const TEST_SESSION_IDENTITY = {
  sessionEpoch: "test-session@1000",
  sessionId: "test-session",
} as const;

describe("viewport vector scale", () => {
  it("derives glyphs from effective sample spacing", () => {
    expect(resolveViewport3DVectorScale([500e-9, 125e-9, 54e-9], 1, 1200)).toBeCloseTo(12.1e-9, 1);
    expect(resolveViewport3DVectorScale([500e-9, 125e-9, 54e-9], 2, 1200)).toBeCloseTo(24.2e-9, 1);
  });

  it("removes stale field-catalog ids rejected by the current quantity capabilities", () => {
    const catalog = {
      schema_version: "fullmag.quantity-catalog.v1",
      quantities: [
        {
          capability_state: "unsupported",
          description: "",
          domain: "full_domain",
          id: "H_ext",
          interactive_preview: false,
          label: "External field",
          location: "cell",
          materializable: false,
          materialization_state: "unsupported",
          n_comp: 3,
          normalization_hint: "",
          publication_state: "hidden",
          renderable: false,
          requestable: false,
          shape: "vector_field",
          solver_capability: "unsupported",
          supports_export: false,
          supports_history: false,
          supports_preview_2d: false,
          supports_preview_3d: false,
          unit: "A/m",
        },
      ],
    };

    expect(
      mergeViewport3DQuantityCapabilityIds(
        new Set(["m", "H_ext"]),
        catalog,
      ),
    ).toEqual(new Set(["m"]));
  });

  it("derives multilayer Airbox glyph length from its certified grid", () => {
    expect(
      resolveViewport3DFdmGridVectorScale(
        [160, 40, 18],
        [3.125e-9, 3.125e-9, 3e-9],
        1,
      ),
    ).toBeCloseTo(12.1e-9, 1);
  });

  it("caps the effective Airbox glyph length at the realized cell scale", () => {
    expect(
      resolveFdmVectorGlyphScaleForCellSize([2e-9, 1e-9, 1e-9], 100e-9),
    ).toBeCloseTo(1.5e-9, 12);
    expect(
      resolveFdmVectorGlyphScaleForCellSize([2e-9, 1e-9, 1e-9], 0.5e-9),
    ).toBeCloseTo(0.5e-9, 12);
  });
});

describe("FDM Airbox mesh demand", () => {
  it("adopts an exact terminal FDM scalar grid as the target surface buffer", () => {
    const targetId = "object:sample";
    const quantityId = "scalar_density";
    const demandPlan = resolveViewport3DTargetQuantityFieldDemandPlan({
      availableQuantityIds: new Set([quantityId]),
      fdmSettings: null,
      fdmTargetSettings: [{
        label: "Sample",
        settings: {
          ...DEFAULT_OBJECT_VISUALIZATION,
          activeQuantityId: quantityId,
          shaderVisible: true,
          surfaceColorSource: "colormap",
          vectorsVisible: false,
          visible: true,
        },
        targetId,
      }],
      getPartSettings: () => DEFAULT_OBJECT_VISUALIZATION,
      magneticPartScopedFieldIds: new Set(),
      magneticParts: [],
      maxVectorGlyphs: 384,
      primaryFieldQuantityId: "m",
    });
    const request = Array.from(demandPlan.requests.values())[0]!;
    const resourceKey = resolveViewport3DFieldVectorResourceKey(
      request.quantityId,
      request.query,
    );
    const decoded = fieldVectorFixture({
      formatVersion: 2,
      grid: [2, 2, 2],
      indexing: "legacy_count_only",
      nComp: 1,
      pointCount: 8,
      quantityId,
      valueCount: 8,
      values: new Float64Array([1, 2, 3, 4, 10, 20, 30, 40]),
    });
    const domain = {
      discretization: "fdm" as const,
      domainGenerationId: "fdm-generation",
      gridShape: [2, 2, 2] as const,
      meshTopologyHash: null,
      meshTopologyRevision: null,
      pointCount: 8,
    };
    const accepted = resolveViewport3DFieldVectorForDomain({
      domain,
      fieldVector: decoded,
      responseDomainGenerationId: "fdm-generation",
    });
    const resolved = resolveViewport3DFdmTargetFieldVectorForTarget({
      primaryFieldQuantityId: "m",
      primaryFieldVector: null,
      quantityId,
      targetFieldRequests: demandPlan.requests,
      targetFieldVectors: new Map([[request.requestId, accepted!]]),
      targetId,
    });
    const buffer = buildViewport3DTargetFieldBufferWithResourceKey({
      consumers: request.consumers,
      domain,
      fieldRevision: "field-revision",
      fieldVector: resolved!.fieldVector,
      query: request.query,
      responseDomainGenerationId: "fdm-generation",
      resourceKey,
      targetIds: [targetId],
      topologyRevision: "topology-revision",
    });
    const scalarBuffer = buildFdmSampledScalarColors(
      resolved!.fieldVector,
      Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7]),
      domain.pointCount,
      "magnitude",
      "viridis",
      undefined,
      domain.gridShape,
    )!;
    scalarBuffer.buildKey = "scalar-surface";
    scalarBuffer.sourceFieldBufferId = buffer.bufferId;
    scalarBuffer.sourceResourceKey = resourceKey;
    const registry = createViewport3DRenderAdoptionRegistry();
    registry.setCarrierTargets(new Map([[targetId, [targetId]]]));
    registry.retainDemand(targetId);
    recordFdmCuboidSurfaceAdoption({
      carrierId: targetId,
      fieldBufferId: buffer.bufferId,
      registry,
      sessionIdentity: TEST_SESSION_IDENTITY,
      scalarBuffer,
    });

    expect(accepted).toBe(decoded);
    expect(request).toMatchObject({
      consumers: [`${targetId}:surface`],
      query: { component: "full", scope_kind: "full" },
      quantityId,
    });
    expect(buffer).toMatchObject({
      capability: "scalar-complete",
      domainCompatibility: { status: "compatible" },
      quantityId,
      resourceKey,
      targetIds: [targetId],
    });
    expect(scalarBuffer.colors.byteLength).toBeGreaterThan(0);
    expect(registry.snapshot(targetId)[0]).toMatchObject({
      carrierId: targetId,
      fieldBufferId: buffer.bufferId,
      kind: "surface",
      resourceKey,
      scalarBufferKey: "scalar-surface",
    });
  });

  it("requests and adopts an FDM object vector pass after global H_demag selection", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");
    const settingsBlock = source.slice(
      source.indexOf("const fdmTargetSettingsById = useMemo"),
      source.indexOf("const fdmTargetSettings = useMemo"),
    );
    const visualization = new ObjectVisualizationController();
    const target = { id: "object:film", kind: "object" as const, label: "film" };
    visualization.patchTarget(target, {
      activeQuantityId: "H_demag",
      vectorsVisible: true,
    });

    const demagSettings = resolveViewport3DFdmTargetVisualization({
      inheritedSettings: resolveGlobalObjectVisualizationSettings({
        quantity: { active_quantity_id: "H_demag" },
      } as never),
      snapshot: visualization.getSnapshot(),
      target,
    }).effectiveSettings;
    visualization.removeTargetOverrideField(target, "activeQuantityId");
    const effectiveSettings = resolveViewport3DFdmTargetVisualization({
      inheritedSettings: resolveGlobalObjectVisualizationSettings({
        quantity: { active_quantity_id: "H_eff" },
      } as never),
      snapshot: visualization.getSnapshot(),
      target,
    }).effectiveSettings;
    const request = Array.from(resolveViewport3DTargetQuantityFieldRequests({
      fdmSettings: null,
      getPartSettings: () => DEFAULT_OBJECT_VISUALIZATION,
      magneticPartScopedFieldIds: new Set(),
      magneticParts: [],
      maxVectorGlyphs: 384,
      primaryFieldQuantityId: "m",
    }).values())[0];
    const demagRequest = Array.from(resolveViewport3DTargetQuantityFieldDemandPlan({
      fdmSettings: null,
      fdmTargetSettings: [{ label: target.label, settings: demagSettings, targetId: target.id }],
      getPartSettings: () => DEFAULT_OBJECT_VISUALIZATION,
      magneticPartScopedFieldIds: new Set(),
      magneticParts: [],
      maxVectorGlyphs: 384,
      primaryFieldQuantityId: "m",
    }).requests.values())[0];
    const effectiveRequest = Array.from(resolveViewport3DTargetQuantityFieldDemandPlan({
      fdmSettings: null,
      fdmTargetSettings: [{ label: target.label, settings: effectiveSettings, targetId: target.id }],
      getPartSettings: () => DEFAULT_OBJECT_VISUALIZATION,
      magneticPartScopedFieldIds: new Set(),
      magneticParts: [],
      maxVectorGlyphs: 384,
      primaryFieldQuantityId: "m",
    }).requests.values())[0];
    const fieldVector = fieldVectorFixture({ quantityId: "H_eff" });
    const resourceKey = resolveViewport3DFieldVectorResourceKey(
      effectiveRequest!.quantityId,
      effectiveRequest!.query,
    );
    const buffer = buildViewport3DTargetFieldBufferWithResourceKey({
      consumers: effectiveRequest!.consumers,
      fieldVector,
      query: effectiveRequest!.query,
      resourceKey,
      targetIds: [target.id],
    });
    const demagField = fieldVectorFixture({ quantityId: "H_demag" });
    const demagResourceKey = resolveViewport3DFieldVectorResourceKey(
      demagRequest!.quantityId,
      demagRequest!.query,
    );
    const demagBuffer = buildViewport3DTargetFieldBufferWithResourceKey({
      consumers: demagRequest!.consumers,
      fieldVector: demagField,
      query: demagRequest!.query,
      resourceKey: demagResourceKey,
      targetIds: [target.id],
    });
    const registry = createViewport3DRenderAdoptionRegistry();
    registry.setCarrierTargets(new Map([[target.id, [target.id]]]));
    registry.retainDemand(target.id);
    recordVectorFieldAdoption({
      buildKey: "fdm-target-vector:H_demag",
      byteLength: 96,
      carrierId: target.id,
      fieldBufferId: demagBuffer.bufferId,
      glyphCount: 4,
      resourceKey: demagResourceKey,
      registry,
      sessionIdentity: TEST_SESSION_IDENTITY,
    });

    expect(demagSettings.activeQuantityId).toBe("H_demag");
    expect(demagSettings.vectorsVisible).toBe(true);
    expect(effectiveSettings.activeQuantityId).toBe("H_eff");
    expect(request).toBeUndefined();
    expect(demagRequest).toMatchObject({
      consumers: expect.arrayContaining([`${target.id}:vector-glyph`]),
      quantityId: "H_demag",
    });
    expect(registry.snapshot(target.id)[0]).toMatchObject({
      fieldBufferId: demagBuffer.bufferId,
      kind: "vector",
      resourceKey: demagResourceKey,
      vectorBuildKey: "fdm-target-vector:H_demag",
    });
    expect(effectiveRequest).toMatchObject({ quantityId: "H_eff" });
    expect(resourceKey).toContain("/H_eff/samples/vector");
    expect(buffer).toMatchObject({
      quantityId: "H_eff",
      resourceKey,
      targetIds: ["object:film"],
    });
    expect(settingsBlock).toContain("inheritedSettings: globalObjectBaseSettings");
    expect(settingsBlock).toContain("globalObjectBaseSettings,");
    expect(source).toContain('id: "object-visualization"');
    expect(source).toContain("revision: objectVisualizationSnapshot.version");
  });

  it("maps the outside-support debug target to its exact render carrier", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");
    const targetsStart = source.indexOf("const visualizationDebugTargets =");
    const targetsBlock = source.slice(
      targetsStart,
      source.indexOf(
        "const visualizationDebugTopologyByteLength",
        targetsStart,
      ),
    );

    expect(targetsBlock).toContain(
      "target.id === AIRBOX_VISUALIZATION_TARGET.id",
    );
    expect(targetsBlock).toContain(
      'carrierIds.add("fdm-universe-outside-support")',
    );
    expect(targetsBlock).toContain("carrierIds.add(target.id)");
    expect(targetsBlock).toMatch(
      /target\.id === AIRBOX_VISUALIZATION_TARGET\.id[\s\S]*fdmUniverseOutsideSupport[\s\S]*\? fdmAirboxDebugRenderPass/,
    );
    expect(source).toContain(
      "const fdmAirboxDebugRenderPass: Viewport3DTargetRenderPassModel",
    );
  });

  it("maps the canonical single-grid Airbox target to the outside-support render carrier", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");
    const targetsStart = source.indexOf("const visualizationDebugTargets =");
    const targetsBlock = source.slice(
      targetsStart,
      source.indexOf(
        "const visualizationDebugTopologyByteLength",
        targetsStart,
      ),
    );

    expect(targetsBlock).toMatch(
      /target\.id === AIRBOX_VISUALIZATION_TARGET\.id[\s\S]*carrierIds\.add\("fdm-universe-outside-support"\)/,
    );
    expect(targetsBlock).toMatch(
      /target\.id === AIRBOX_VISUALIZATION_TARGET\.id[\s\S]*fdmAirboxDebugRenderPass/,
    );
  });

  it("does not block single-grid Airbox vectors or geometry on region membership", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");
    const visibilityBlock = source.slice(
      source.indexOf("const fdmAirboxVectorsVisible ="),
      source.indexOf("const fdmInstanceModelEnabled ="),
    );
    const buildBlock = source.slice(
      source.indexOf("const fdmAirboxInstanceModelEnabled ="),
      source.indexOf("const fdmAirboxVectorOnlyBuildInput ="),
    );

    expect(visibilityBlock).not.toContain("fdmMembershipCurrent");
    expect(buildBlock).not.toContain("fdmMembershipCurrent");
  });

  it("keeps canonical FDM Airbox display settings on the subscribed local controller snapshot", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");
    const settingsStart = source.indexOf("const airboxSettings = useMemo(");
    const settingsBlock = source.slice(
      settingsStart,
      source.indexOf("const fdmSingleGridAirboxSettings", settingsStart),
    );

    expect(settingsBlock).toContain(
      "visualizationState: fdmLaneActive ? null : renderingState",
    );
  });

  it("builds the inactive-cell carrier for wireframe, points, or vectors", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain(
      "fdmAirboxPassPlan.needsInactiveCellGeometry",
    );
    expect(source).not.toContain(
      "fdmAirboxPassPlan.needsVectorAnchors,\n  );",
    );
    expect(source).toContain('cellSelection: "inactive"');
  });

  it("keeps geometry identity independent while vector-only builds carry field identity", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");
    const keyStart = source.indexOf("const fdmAirboxBuildKey =");
    const keyBlock = source.slice(
      keyStart,
      source.indexOf("const fdmAirboxBuildState =", keyStart),
    );

    expect(keyBlock).toMatch(
      /fieldRevision:\s*fdmAirboxVectorOnlyBuildEnabled\s*\?/,
    );
    expect(keyBlock).toMatch(
      /quantityId:\s*fdmAirboxVectorOnlyBuildEnabled\s*\?/,
    );
    expect(keyBlock).not.toContain(
      'field=${fdmAirboxFieldVector ? "ready" : "pending"}',
    );
    expect(keyBlock).toContain(
      "`fill=${visualProfile.voxelFillRatio}|airbox=true|scale=${fdmAirboxVectorScale}`",
    );
  });

  it("changes the debug publisher resource frame when the multilayer Airbox field arrives", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");
    const resourceKeyStart = source.indexOf(
      "const resourceFrameKey = buildViewport3DResourceFrameKey([",
    );
    const resourceKeyBlock = source.slice(
      resourceKeyStart,
      source.indexOf("const diagnostics =", resourceKeyStart),
    );

    expect(resourceKeyBlock).toContain(
      'id: "fdm-multilayer-airbox-field"',
    );
    expect(resourceKeyBlock).toContain(
      "fdmMultilayerAirboxField.payloadRevision",
    );
    expect(resourceKeyBlock).toContain(
      "fdmMultilayerAirboxField.revision",
    );
    expect(resourceKeyBlock).toContain(
      'id: "fdm-multilayer-airbox-build"',
    );
    expect(resourceKeyBlock).toContain(
      "fdmMultilayerAirboxBuildState?.buildKey",
    );
  });

  it("creates the exact Airbox glyph identity before vector segments are adopted", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");
    const referenceStart = source.indexOf(
      "const fdmAirboxVectorBuildReference",
    );
    const debugPassStart = source.indexOf(
      "const fdmAirboxDebugRenderPass",
      referenceStart,
    );
    const referenceSource = source.slice(referenceStart, debugPassStart);

    expect(referenceSource).toContain(
      "fdmAirboxFieldBuffer && fdmAirboxBuildKey",
    );
    expect(referenceSource).not.toContain(
      "fdmAirboxFieldBuffer && fdmAirboxVectorSegments",
    );
  });
});
const visualizationStateResourceSourceUrl = new URL(
  "../../../kernel/visualization/useVisualizationStateResource.ts",
  import.meta.url,
);

type TargetFieldBufferOptions = Parameters<
  typeof buildViewport3DTargetFieldBufferWithResourceKey
>[0];

describe("airbox vector sample budget", () => {
  it("clamps to the effective air-only carrier, not legacy or session limits", () => {
    expect(resolveViewport3DAirboxVectorSampleBudget(16_940, 10_586)).toBe(
      10_586,
    );
    expect(resolveViewport3DAirboxVectorSampleBudget(10_586, 10_586)).toBe(
      10_586,
    );
    expect(resolveViewport3DAirboxVectorSampleBudget(384, 10_586)).toBe(384);

    const query = resolveViewport3DScopedVectorFieldQuery({
      geometryScope: "full",
      maxSamples: resolveViewport3DAirboxVectorSampleBudget(16_940, 10_586),
      surfaceColorMode: null,
      vectorsVisible: true,
    });
    expect(
      resolveViewport3DFieldVectorResourceKey("H_demag", {
        ...query,
        scope_id: "part:__air__",
        scope_kind: "airbox",
      }),
    ).toContain("max_samples=10586");

    expect(
      resolveViewport3DScopedVectorFieldQuery({
        geometryScope: "surface",
        maxSamples: 1024,
        surfaceColorMode: null,
        vectorsVisible: true,
      }),
    ).toMatchObject({
      geometry_scope: "surface",
      max_samples: 1024,
    });
  });
});

describe("FDM target visualization boundary", () => {
  it("keeps local FDM object patches effective when a FEM registry entry is present", () => {
    const visualization = new ObjectVisualizationController();
    const target = { id: "object:film", kind: "object" as const };
    visualization.patchTarget(target, {
      shaderVisible: true,
      surfaceColorSource: "component_x",
      visible: true,
      wireframeVisible: false,
    });

    const femRegistryState = {
      revision: 7,
      targets: {
        airbox: {},
        objects: [
          {
            scope: "object",
            scope_id: "film",
            settings: {
              render_mode: "off",
              surface_visible: false,
              visible: false,
            },
          },
        ],
        parts: [],
      },
    } as never;

    expect(
      resolveTargetVisualization({
        snapshot: visualization.getSnapshot(),
        target,
        visualizationState: femRegistryState,
      }).effectiveSettings,
    ).toMatchObject({ shaderVisible: false, visible: false });

    const resolved = resolveViewport3DFdmTargetVisualization({
      snapshot: visualization.getSnapshot(),
      target,
    });

    expect(resolved.effectiveSettings).toMatchObject({
      shaderVisible: true,
      surfaceColorSource: "component_x",
      visible: true,
      wireframeVisible: false,
    });
  });
});

function buildViewport3DTargetFieldBuffer(
  options: Omit<TargetFieldBufferOptions, "resourceKey">,
) {
  return buildViewport3DTargetFieldBufferWithResourceKey({
    ...options,
    resourceKey: serializeCanonicalFieldVectorResourceKey(
      canonicalFieldVectorQuery(options.fieldVector.quantityId, options.query),
    ),
  });
}

function fieldVectorResourceRef(
  quantityId: string,
  snapshotId: string,
  stageId: string,
): string {
  return `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", quantityId)}?snapshot_id=${snapshotId}&stage_id=${stageId}`;
}

function fieldVectorFixture(
  overrides: Partial<DecodedFieldVector> = {},
): DecodedFieldVector {
  const nComp = overrides.nComp ?? 3;
  const pointCount = overrides.pointCount ?? 4;
  return {
    dtype: "float64",
    grid: [pointCount, 1, 1],
    nComp,
    pointCount,
    quantityId: "m",
    valueCount: pointCount * nComp,
    values: new Float64Array(pointCount * nComp),
    ...overrides,
  };
}

describe("useViewport3DSceneModel", () => {
  it("propagates FEM Airbox per-carrier field states into scene and debug models", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain(
      "airboxFieldVectorPartStates: airboxFieldVectors.partStates,",
    );
    expect(
      source.match(
        /airboxFieldVectorPartStates: airboxFieldVectors\.partStates,/g,
      ),
    ).toHaveLength(3);
  });

  it("keeps FDM native-layer visibility on the local structured-grid target state", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");
    const nativeLayerSettingsBlock = source.slice(
      source.indexOf("const fdmNativeLayerSettingsById = useMemo"),
      source.indexOf("const nativeLayerFieldRequests = useMemo"),
    );

    expect(nativeLayerSettingsBlock).toContain(
      "resolveViewport3DFdmTargetVisualization({",
    );
    expect(nativeLayerSettingsBlock).not.toContain(
      "visualizationState: renderingState",
    );
  });

  it("uses canonical local Airbox settings for both FDM Airbox carriers", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");
    expect(source).toContain(
      "target: AIRBOX_VISUALIZATION_TARGET,\n        visualizationState: fdmLaneActive ? null : renderingState,",
    );
    const fdmSingleGridAirboxBlock = source.slice(
      source.indexOf("const fdmSingleGridAirboxSettings ="),
      source.indexOf("const fdmVectorScale =", source.indexOf("const fdmSingleGridAirboxSettings =")),
    );
    expect(fdmSingleGridAirboxBlock).toContain("fdmMultilayerAirboxDomain");
    expect(fdmSingleGridAirboxBlock).toContain(": airboxSettings");
    expect(fdmSingleGridAirboxBlock).not.toContain("fdmUniverseOutsideSupportSettings");
  });

  it("uses the canonical remote Airbox target for both FDM renderers", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");
    const airboxSettingsBlock = source.slice(
      source.indexOf("const airboxSettings = useMemo"),
      source.indexOf("const airboxQuantityCompatible", source.indexOf("const airboxSettings = useMemo")),
    );

    expect(airboxSettingsBlock).toContain("resolveTargetVisualization({");
    expect(airboxSettingsBlock).toContain("target: AIRBOX_VISUALIZATION_TARGET");
    expect(airboxSettingsBlock).toContain(
      "visualizationState: fdmLaneActive ? null : renderingState",
    );
    expect(airboxSettingsBlock).not.toContain("resolveViewport3DFdmTargetVisualization({");

    const singleGridDisplayBlock = source.slice(
      source.indexOf("const fdmAirboxMaxVectorGlyphs ="),
      source.indexOf("const fdmAirboxBuildState =", source.indexOf("const fdmAirboxMaxVectorGlyphs =")),
    );
    expect(singleGridDisplayBlock).toContain("fdmSingleGridAirboxSettings");
    expect(singleGridDisplayBlock).not.toContain("fdmUniverseOutsideSupportSettings");
  });
  it("publishes the central FDM display sampling provenance in the HUD summary", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain(
      'domainMeta.data?.discretization === "fdm" && domainMeta.data.grid',
    );
    expect(source).toContain(
      "adaptFdmDomainPresentation(fdmDomainPresentation, FDM_DISPLAY_CELL_BUDGET)",
    );
    expect(source).toContain("formatFdmDisplaySamplingSummary({");
    expect(source).toContain("budget: fdmDomain.displayCellBudget");
    expect(source).toContain("displaySamples: fdmDomain.displayCellCount");
    expect(source).toContain("stride: fdmDomain.stride");
    expect(source).toContain("total: fdmDomain.totalCells");
    expect(source).not.toContain("`${fdmDomain.displayCellCount}/${fdmDomain.totalCells}`");
  });

  it("keeps FEM colorbar identity compatible regardless of FDM-only diagnostics", () => {
    expect(
      resolveViewport3DFdmFieldIdentityCompatible({
        fdmFieldCompatibilityStatus: "mismatch",
        fdmLaneActive: false,
      }),
    ).toBe(true);
    expect(
      resolveViewport3DFdmFieldIdentityCompatible({
        fdmFieldCompatibilityStatus: "mismatch",
        fdmLaneActive: true,
      }),
    ).toBe(false);
  });

  it("suppresses FEM topology and manifest targets while an FDM domain is active", () => {
    const femDomain = {
      airboxParts: [{ id: "airbox" }],
      magneticParts: [{ id: "film" }],
      magneticSurfacePartsByPartId: new Map(),
      objectPartIds: new Map([["film", ["film"]]]),
      partsById: new Map([["film", { id: "film" }]]),
    } as never;

    for (const topologyFreshness of ["current", "stale", "unknown"] as const) {
      const lane = resolveViewport3DDomainRenderLane({
        fdmActive: true,
        femDomain,
        topologyFreshness,
      });

      expect(lane.femDomain.magneticParts).toEqual([]);
      expect(lane.femDomain.airboxParts).toEqual([]);
      expect(lane.topologyCurrent).toBe(false);
      expect(lane.topologyRenderable).toBe(false);
    }
  });

  it("preserves FEM topology and manifest targets when no FDM domain is active", () => {
    const femDomain = {
      airboxParts: [{ id: "airbox" }],
      magneticParts: [{ id: "film" }],
      magneticSurfacePartsByPartId: new Map(),
      objectPartIds: new Map([["film", ["film"]]]),
      partsById: new Map([["film", { id: "film" }]]),
    } as never;

    const lane = resolveViewport3DDomainRenderLane({
      fdmActive: false,
      femDomain,
      topologyFreshness: "current",
    });

    expect(lane.femDomain).toBe(femDomain);
    expect(lane.topologyCurrent).toBe(true);
    expect(lane.topologyRenderable).toBe(true);
  });

  it("does not surface FEM topology freshness labels in the FDM lane", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain(
      'const fdmLaneActive = domainMeta.data?.discretization === "fdm";',
    );
    expect(source).toContain(
      "const topologyFreshnessStatus = fdmLaneActive\n    ? null\n    : resolveViewport3DTopologyFreshnessLabel(topologyFreshness);",
    );
    expect(source).toContain("topologyFreshnessStatus ??\n    topology.status");
  });

  it("uses full metadata component for scalar spatial quantities", () => {
    expect(resolveViewport3DFieldMetaScalarComponent("eden_total", "magnitude"))
      .toBe("full");
    expect(resolveViewport3DFieldMetaScalarComponent("m", "magnitude"))
      .toBe("magnitude");
  });

  it("does not request generic field metadata for analysis mode fields", () => {
    const requests = resolveViewport3DPartScalarRangeRequests({
      fieldRenderOptions: {
        partScalarColorModes: new Map([["film-part", "magnitude"]]),
      },
      getPartSettings: () => ({
        ...DEFAULT_OBJECT_VISUALIZATION,
        activeQuantityId: "analysis:frequency-response:frequency-0002",
        shaderVisible: true,
        visible: true,
      }),
      magneticParts: [
        {
          part: {
            geometry_id: "film",
            id: "film-part",
            object_id: "film",
          } as never,
        },
      ],
    });

    expect(requests.size).toBe(0);
  });

  it("subscribes to build diagnostic snapshot versions for live compact diagnostics", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("useSyncExternalStore");
    expect(source).toContain("subscribeViewport3DBuildDiagnostics");
    expect(source).toContain("getViewport3DBuildDiagnosticsSnapshotVersion");
    expect(source).toContain("buildDiagnosticsSnapshotVersion");
  });

  it("fails closed for ambiguous legacy FMRM membership", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("resolveViewport3DFdmRealizedRegionIds(");
  });

  it("passes a current FDM grid identity to selection focus without a FEM fallback", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("const fdmSelectionGrid = useMemo<FdmSelectionGrid | null>");
    expect(source).toContain(
      'fdmDomainPresentation?.resourceStatus === "realized"',
    );
    expect(source).toContain("resolveViewport3DSelectionBounds(");
    expect(source).toContain("fdmSelectionGrid,");
  });

  it("filters live authored region overlays once matching mesh-backed regions exist", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");
    const regionOverlayBlock = source.slice(
      source.indexOf("const regionOverlays = useMemo<RegionOverlayInput[]>"),
      source.indexOf(
        "const topologyFreshness = useMemo",
        source.indexOf("const regionOverlays = useMemo<RegionOverlayInput[]>"),
      ),
    );

    expect(regionOverlayBlock).toContain("resolveViewport3DRegionOverlays");
    expect(regionOverlayBlock).toContain(
      "realizedRegionKeys: meshBackedRegionKeys",
    );
    expect(regionOverlayBlock).toContain("meshBackedRegionKeys");
  });

  it("keeps stale topology geometry separate from every field-dependent model path", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain(
      "const topologyRenderModelForGeometry = topologyRenderable ? topologyRenderModel : null;",
    );
    expect(source).toContain(
      "const fieldCompatibleTopologyRenderModel = topologyCurrent\n    ? fieldTopologyRenderModel\n    : null;",
    );
    expect(source).toContain("femDomain.fieldCapableMagneticParts ?? femDomain.magneticParts");
    expect(source).toContain(
      "topologyRenderModel: fieldCompatibleTopologyRenderModel",
    );
    expect(source).toContain("topology: fieldCompatibleTopologyRenderModel");
    expect(source).toContain("topologyModel: topologyRenderModelForGeometry");
    expect(source).toContain(
      "Boolean(fdmDomain || fieldCompatibleTopologyRenderModel) &&",
    );
    expect(source).toContain(
      "magneticParts: fieldCompatibleTopologyRenderModel?.magneticParts ?? [],",
    );
    expect(source).toContain(
      "fdmSettings: fdmDomain ? fdmSettings : null,",
    );
    expect(source).toContain(
      "const tet4FmmqQualitySupported = topologySupportsTet4FmmqQuality(topology.data);",
    );
    expect(source).toContain(
      "useViewport3DMeshQualityData(\n    Boolean(\n      fieldCompatibleTopologyRenderModel &&\n        meshQualityOverlayVisible &&\n        tet4FmmqQualitySupported,\n    ),\n  )",
    );
  });

  it("wraps primary field payloads as target field buffers without mixing legacy maps", () => {
    const primaryVector = fieldVectorFixture({ quantityId: "m" });
    const scopedVector = fieldVectorFixture({ pointCount: 2, quantityId: "m" });
    const scopedBuffer = buildViewport3DTargetFieldBuffer({
      fieldVector: scopedVector,
      query: {
        component: "full",
        scope_id: "part-b",
        scope_kind: "part",
      },
      targetIds: ["part-b"],
    });

    const merged = mergeViewport3DPrimaryTargetFieldBuffers({
      fieldRevision: "field-r1",
      fieldRenderOptions: {
        partFieldVectors: new Map([["part-b", scopedVector]]),
        partTargetFieldBuffers: new Map([["part-b", scopedBuffer]]),
        partVectorBudgets: new Map([
          ["part-a", 32],
          ["part-b", 32],
        ]),
        scalarColorModes: new Set(["x"]),
        scalarColorsVisible: true,
      },
      fieldVector: primaryVector,
      getPartSettings: (part) => ({
        ...DEFAULT_OBJECT_VISUALIZATION,
        activeQuantityId: part.id === "part-c" ? "H_eff" : "m",
        shaderVisible: true,
        vectorsVisible: part.id !== "part-c",
        visible: true,
      }),
      primaryFieldQuantityId: "m",
      primaryFieldRequest: {
        consumers: ["primary-field-vector"],
        quantityId: "m",
        query: {
          component: "full",
          scope_kind: "full",
        },
        requestId: "quantity=m&component=full&scope_kind=full",
      },
      primaryFieldResourceKey: fieldVectorResourceKey("m", {
        component: "full",
        scope_kind: "full",
      }),
      topology: {
        magneticParts: [
          { part: { id: "part-a", label: "A" } },
          { part: { id: "part-b", label: "B" } },
          { part: { id: "part-c", label: "C" } },
        ],
      } as never,
      topologyRevision: "topology-r1",
    });

    expect(merged.partFieldVectors).toBeUndefined();
    expect(merged.partTargetFieldBuffers?.get("part-a")).toMatchObject({
      capability: "full-vector-complete",
      consumers: [
        "part-a:surface",
        "part-a:vector-glyph",
        "primary-field-vector",
      ],
      fieldRevision: "field-r1",
      requestId: expect.stringContaining("component=full"),
      scopeKind: "full",
      topologyRevision: "topology-r1",
    });
    expect(merged.partTargetFieldBuffers?.get("part-b")).toBe(scopedBuffer);
    expect(merged.partTargetFieldBuffers?.has("part-c")).toBe(false);
  });

  it("wraps analysis mode payloads as active target field buffers", () => {
    const modeVector = fieldVectorFixture({
      quantityId: "analysis:eigen:sample-0000:mode-0002",
    });

    const merged = mergeViewport3DPrimaryTargetFieldBuffers({
      fieldRevision: "mode-field-r1",
      fieldRenderOptions: {
        partVectorBudgets: new Map([["part-a", 64]]),
        scalarColorModes: new Set(["magnitude"]),
        scalarColorsVisible: true,
      },
      fieldVector: modeVector,
      getPartSettings: () => ({
        ...DEFAULT_OBJECT_VISUALIZATION,
        activeQuantityId: "m",
        shaderVisible: true,
        vectorsVisible: true,
        visible: true,
      }),
      primaryFieldQuantityId: "analysis:eigen:sample-0000:mode-0002",
      primaryFieldRequest: {
        consumers: ["primary-field-vector"],
        quantityId: "analysis:eigen:sample-0000:mode-0002",
        query: {
          component: "full",
          scope_kind: "full",
          view: "phase_rotated_real",
        },
        requestId: "quantity=analysis:eigen:sample-0000:mode-0002&component=full",
      },
      primaryFieldResourceKey: fieldVectorResourceKey(
        "analysis:eigen:sample-0000:mode-0002",
        {
          component: "full",
          scope_kind: "full",
          view: "phase_rotated_real",
        },
      ),
      topology: {
        magneticParts: [{ part: { id: "part-a", label: "A" } }],
      } as never,
      topologyRevision: "topology-r1",
    });

    expect(merged.partTargetFieldBuffers?.get("part-a")).toMatchObject({
      capability: "full-vector-complete",
      consumers: [
        "part-a:surface",
        "part-a:vector-glyph",
        "primary-field-vector",
      ],
      fieldRevision: "mode-field-r1",
      quantityId: "analysis:eigen:sample-0000:mode-0002",
      scopeKind: "full",
      topologyRevision: "topology-r1",
    });
  });

  it("resolves planned resource payloads into target buffers without mixing legacy maps", () => {
    const targetQuantityVector = fieldVectorFixture({ quantityId: "H_eff" });
    const legacyOnlyVector = fieldVectorFixture({ quantityId: "m" });
    const resolved = resolveViewport3DResolvedPartFieldBuffers({
      getPartSettings: (part) => ({
        ...DEFAULT_OBJECT_VISUALIZATION,
        activeQuantityId: part.id === "part-a" ? "H_eff" : "m",
        shaderVisible: true,
        vectorsVisible: false,
        visible: true,
      }),
      magneticPartFieldVectors: new Map([["part-b", legacyOnlyVector]]),
      targetQuantityFieldRequests: new Map([
        [
          "H_eff",
          {
            consumers: ["part-a:surface"],
            quantityId: "H_eff",
            query: {
              component: "x",
              scope_id: "part-a",
              scope_kind: "part",
            },
            requestId: "quantity=H_eff&component=x&scope_kind=part&scope_id=part-a",
          },
        ],
      ]),
      targetQuantityFieldRevision: "target-r1",
      targetQuantityFieldVectors: new Map([["H_eff", targetQuantityVector]]),
      topology: {
        airboxParts: [],
        magneticParts: [
          { part: { id: "part-a", label: "A" } },
          { part: { id: "part-b", label: "B" } },
        ],
        nodeCount: 4,
      } as never,
      topologyRevision: "topology-r1",
    });

    expect(resolved.partFieldVectors.has("part-a")).toBe(false);
    expect(resolved.partTargetFieldBuffers.get("part-a")).toMatchObject({
      consumers: ["part-a:surface"],
      fieldRevision: "target-r1",
      quantityId: "H_eff",
      requestId: expect.stringContaining("quantity=H_eff"),
      scopeKind: "part",
      topologyRevision: "topology-r1",
    });
    expect(resolved.partFieldVectors.get("part-b")).toBeUndefined();
    expect(resolved.partTargetFieldBuffers.has("part-b")).toBe(false);
  });

  it("does not assign an unplanned quantity-keyed payload to a carrier", () => {
    const resolved = resolveViewport3DResolvedPartFieldBuffers({
      getPartSettings: () => ({
        ...DEFAULT_OBJECT_VISUALIZATION,
        activeQuantityId: "H_eff",
        shaderVisible: true,
        visible: true,
      }),
      targetQuantityFieldVectors: new Map([
        ["H_eff", fieldVectorFixture({ quantityId: "H_eff" })],
      ]),
      topology: {
        airboxParts: [],
        magneticParts: [{ part: { id: "part-a", label: "A" } }],
        nodeCount: 4,
      } as never,
    });

    expect(resolved.partFieldVectors.has("part-a")).toBe(false);
    expect(resolved.partTargetFieldBuffers.has("part-a")).toBe(false);
  });

  it("does not assign a request without a carrier consumer", () => {
    const request = {
      consumers: [],
      quantityId: "H_eff",
      query: {
        component: "full" as const,
        scope_id: "part-a",
        scope_kind: "part" as const,
      },
      requestId: "quantity=H_eff&component=full&scope_id=part-a&scope_kind=part",
    };
    const resolved = resolveViewport3DResolvedPartFieldBuffers({
      getPartSettings: () => ({
        ...DEFAULT_OBJECT_VISUALIZATION,
        activeQuantityId: "H_eff",
        shaderVisible: true,
        visible: true,
      }),
      targetQuantityFieldRequests: new Map([[request.requestId, request]]),
      targetQuantityFieldVectors: new Map([
        [request.requestId, fieldVectorFixture({ quantityId: "H_eff" })],
      ]),
      topology: {
        airboxParts: [],
        magneticParts: [{ part: { id: "part-a", label: "A" } }],
        nodeCount: 4,
      } as never,
    });

    expect(resolved.partFieldVectors.has("part-a")).toBe(false);
    expect(resolved.partTargetFieldBuffers.has("part-a")).toBe(false);
  });

  it("keeps requested resource identity when a decoded scoped payload reports another quantity", () => {
    const resolved = resolveViewport3DResolvedPartFieldBuffers({
      getPartSettings: () => ({
        ...DEFAULT_OBJECT_VISUALIZATION,
        activeQuantityId: "H_eff",
        shaderVisible: true,
        visible: true,
      }),
      magneticPartFieldQueries: new Map([
        [
          "part-a",
          {
            consumers: ["part-a:surface"],
            quantityId: "H_eff",
            query: {
              component: "full",
              scope_id: "part-a",
              scope_kind: "part",
            },
          },
        ],
      ]),
      magneticPartFieldVectors: new Map([
        ["part-a", fieldVectorFixture({ quantityId: "m" })],
      ]),
      topology: {
        airboxParts: [],
        magneticParts: [{ part: { id: "part-a", label: "A" } }],
        nodeCount: 4,
      } as never,
    });

    expect(resolved.partTargetFieldBuffers.get("part-a")).toMatchObject({
      quantityId: "m",
      resourceKey: fieldVectorResourceKey("H_eff", {
        component: "full",
        scope_id: "part-a",
        scope_kind: "part",
      }),
    });
  });

  it("keeps synthetic airbox vectors as target buffers instead of legacy fields", () => {
    const resolved = resolveViewport3DResolvedPartFieldBuffers({
      airboxSyntheticVectorsEnabled: true,
      getPartSettings: () => DEFAULT_OBJECT_VISUALIZATION,
      topology: {
        airboxParts: [
          {
            part: {
              boundary_face_count: 0,
              boundary_face_start: 0,
              id: "airbox",
              label: "Airbox",
              node_indices: [0, 1],
              role: "air",
            },
          },
        ],
        magneticParts: [],
        nodeCount: 2,
      } as never,
      topologyRevision: "topology-r2",
    });

    expect(resolved.partFieldVectors.has("airbox")).toBe(false);
    expect(resolved.partTargetFieldBuffers.get("airbox")).toMatchObject({
      capability: "synthetic-full-vector",
      requestId: null,
      scopeId: "airbox",
      scopeKind: "airbox",
      topologyRevision: "topology-r2",
    });
  });

  it("gives production synthetic airbox vectors a stable topology-local build identity", () => {
    const decodedTopology: DecodedTopology = {
      boundaryFaceCount: 0,
      boundaryFaces: new Uint32Array(),
      boundaryMarkers: new Uint32Array(),
      elementCount: 0,
      elementMarkers: new Uint32Array(),
      indices: new Uint32Array(),
      nodeCount: 2,
      positions: new Float64Array([0, 0, 0, 1, 0, 0]),
    };
    const topology = buildViewport3DTopologyRenderModel(
      decodedTopology,
      [],
      [
        {
          boundary_face_count: 0,
          boundary_face_start: 0,
          element_count: 0,
          element_start: 0,
          id: "airbox",
          label: "Airbox",
          node_count: 2,
          node_indices: [0, 1],
          node_start: 0,
          role: "air" as const,
        },
      ],
      undefined,
      {
        meshGenerationId: "generation-7",
        meshRevision: 7,
        meshTopologyHash: "topology-hash-7",
      },
    );
    expect(topology).not.toBeNull();
    const resolveSyntheticBuffers = () =>
      resolveViewport3DResolvedPartFieldBuffers({
        airboxSyntheticVectorsEnabled: true,
        getPartSettings: () => DEFAULT_OBJECT_VISUALIZATION,
        sessionIdentity: TEST_SESSION_IDENTITY,
        topology,
        topologyRevision: "topology-r2",
      });
    const resolved = resolveSyntheticBuffers();
    const syntheticBuffer = resolved.partTargetFieldBuffers.get("airbox");

    expect(syntheticBuffer?.fieldRevision).not.toBeNull();
    expect(syntheticBuffer?.fieldRevision ?? "").toContain(
      "synthetic:airbox:+z",
    );
    expect(syntheticBuffer?.fieldRevision ?? "").toContain("topology-r2");
    expect(
      resolveSyntheticBuffers().partTargetFieldBuffers.get("airbox")
        ?.fieldRevision,
    ).toBe(syntheticBuffer?.fieldRevision);

    const fieldModel = buildViewport3DFieldRenderModel(topology, null, 1, {
      fieldRevision: "m-332",
      partQuantityIds: new Map([
        ["airbox", syntheticBuffer?.quantityId ?? "unknown"],
      ]),
      partTargetFieldBuffers: resolved.partTargetFieldBuffers,
      partVectorBudgets: new Map([["airbox", 2]]),
      scalarColorsVisible: false,
      topologyRevision: "topology-r2",
    });
    const buildReference = fieldModel?.targetPasses.get("airbox")?.vectors
      .buildReference;

    expect(buildReference).toMatchObject({
      fieldBufferId: syntheticBuffer?.bufferId,
      fieldRevision: syntheticBuffer?.fieldRevision,
      resourceKey: null,
    });
    expect(buildReference?.buildKey).not.toContain("m-332");
    if (!buildReference) {
      throw new Error("Expected a synthetic Airbox vector build reference");
    }
    const identifiedGlyphBuild = identifyVectorGlyphBuildResult(
      {
        colors: null,
        transforms: {
          count: 1,
          directions: new Float32Array(3),
          headCenters: new Float32Array(3),
          headScales: new Float32Array(3),
          shaftCenters: new Float32Array(3),
          shaftScales: new Float32Array(3),
        },
      },
      buildReference,
    );
    const registry = createViewport3DRenderAdoptionRegistry();
    registry.setCarrierTargets(new Map([["airbox", ["airbox"]]]));
    registry.retainDemand("airbox");
    const sourceVectorBuildKey = identifiedGlyphBuild.sourceVectorBuildKey;
    expect(sourceVectorBuildKey).toBe(buildReference.buildKey);
    if (!sourceVectorBuildKey) {
      throw new Error("Expected an identified synthetic vector source key");
    }
    recordVectorFieldAdoption({
      buildKey: sourceVectorBuildKey,
      byteLength: 60,
      carrierId: "airbox",
      fieldBufferId: identifiedGlyphBuild.sourceFieldBufferId ?? null,
      glyphCount: 1,
      resourceKey: identifiedGlyphBuild.sourceResourceKey,
      registry,
      sessionIdentity: TEST_SESSION_IDENTITY,
    });
    const receipt = registry.snapshot("airbox").find(
      ({ kind }) => kind === "vector",
    );

    expect(receipt).toMatchObject({
      fieldBufferId: syntheticBuffer?.bufferId,
      vectorBuildKey: buildReference.buildKey,
    });
    expect(receipt?.vectorBuildKey).not.toContain("m-332");
  });

  it("can disable vector glyphs and field colors independently for diagnostics", () => {
    const options = applyViewport3DFieldLayerDiagnosticOverrides(
      {
        fullVectorBudget: 64,
        partVectorBudgets: new Map([
          ["part-a", 32],
          ["part-b", 16],
        ]),
        scalarColorModes: new Set(["orientation", "magnitude"]),
        scalarColorsVisible: true,
      },
      {
        fieldColorLayersEnabled: false,
        vectorLayersEnabled: false,
      },
    );

    expect(options.fullVectorBudget).toBe(0);
    expect(options.partVectorBudgets).toEqual(new Map());
    expect(options.scalarColorModes).toEqual(new Set());
    expect(options.scalarColorsVisible).toBe(false);
  });

  it("keeps the previously displayed live field value while camera field updates are held", () => {
    expect(resolveViewport3DDisplayedLiveValue("next", "previous", true)).toBe(
      "previous",
    );
    expect(resolveViewport3DDisplayedLiveValue("next", "previous", false)).toBe(
      "next",
    );
  });

  it("keys the render model by the displayed payload revision", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");
    const buildStart = source.indexOf("const fieldRenderModel = useMemo");
    const buildEnd = source.indexOf("const visualizationDebugTargets", buildStart);
    const buildSource = source.slice(buildStart, buildEnd);

    expect(buildSource).toContain("fieldRevision: primaryFieldRevision");
    expect(buildSource).not.toContain(
      "fieldRevision: fieldVector.payloadRevision ?? fieldVector.revision",
    );
  });

  it("keeps camera transport hold outside the React scene model", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).not.toContain("useViewport3DFieldUpdateHoldActive");
    expect(source).not.toContain("fieldUpdateHoldActive");
  });

  it("keeps the part scalar range revision resolver stable across renders", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain(
      "resolveRevision: resolveViewport3DPartScalarRangesRevision",
    );
    expect(source).not.toContain("resolveRevision: (data) =>");
  });

  it("keeps large full-domain scalar color builds out of the synchronous render model", () => {
    const options = resolveViewport3DFieldRenderModelBuildOptions({
      complexFieldVector: null,
      fieldRenderOptions: {
        partVectorBudgets: new Map([["part-a", 256]]),
        scalarColorModes: new Set(["x"]),
        scalarColorsVisible: true,
      },
      fieldVector: { pointCount: 75_000 } as never,
      topology: { nodeCount: 75_000 } as never,
    });

    expect(options.partVectorBudgets).toEqual(new Map([["part-a", 256]]));
    expect(options.scalarColorModes).toEqual(new Set());
    expect(options.scalarColorsVisible).toBe(false);
  });

  it("keeps large mapped scalar color builds out of the synchronous render model", () => {
    const options = resolveViewport3DFieldRenderModelBuildOptions({
      complexFieldVector: null,
      fieldRenderOptions: {
        scalarColorModes: new Set(["orientation"]),
        scalarColorsVisible: true,
      },
      fieldVector: { pointCount: 50_001 } as never,
      topology: {
        magneticParts: [
          {
            part: {
              id: "cofeb",
              nodeCount: 50_001,
              nodeStart: 10,
            },
          },
        ],
        nodeCount: 75_000,
      } as never,
    });

    expect(options.scalarColorModes).toEqual(new Set());
    expect(options.scalarColorsVisible).toBe(false);
  });

  it("keeps large per-part scalar color builds out of the synchronous render model", () => {
    const options = resolveViewport3DFieldRenderModelBuildOptions({
      complexFieldVector: null,
      fieldRenderOptions: {
        partFieldVectors: new Map([
          ["part:film", { pointCount: 75_000 } as never],
        ]),
        partScalarColorModes: new Map([["part:film", "y"]]),
        scalarColorModes: new Set(),
        scalarColorsVisible: true,
      },
      fieldVector: { pointCount: 75_000 } as never,
      topology: {
        airboxParts: [],
        magneticParts: [{ part: { id: "part:film" } }],
        nodeCount: 75_000,
      } as never,
    });

    expect(options.scalarColorModes).toEqual(new Set());
    expect(options.scalarColorsVisible).toBe(false);
  });

  it("keeps target-buffer scalar color builds out of the synchronous render model", () => {
    const fieldVector: DecodedFieldVector = {
      dtype: "float64",
      grid: [75_000, 1, 1],
      nComp: 1,
      pointCount: 75_000,
      quantityId: "m",
      valueCount: 75_000,
      values: new Float64Array(75_000),
    };
    const options = resolveViewport3DFieldRenderModelBuildOptions({
      complexFieldVector: null,
      fieldRenderOptions: {
        partScalarColorModes: new Map([["part:film", "y"]]),
        partTargetFieldBuffers: new Map([
          [
            "part:film",
            buildViewport3DTargetFieldBuffer({
              fieldVector,
              query: {
                component: "y",
                scope_id: "part:film",
                scope_kind: "part",
              },
              targetIds: ["part:film"],
            }),
          ],
        ]),
        scalarColorModes: new Set(),
        scalarColorsVisible: true,
      },
      fieldVector: null,
      topology: {
        airboxParts: [],
        magneticParts: [{ part: { id: "part:film" } }],
        nodeCount: 75_000,
      } as never,
    });

    expect(options.scalarColorModes).toEqual(new Set());
    expect(options.scalarColorsVisible).toBe(false);
  });

  it("keeps synchronous scalar colors for small, unmapped, and complex field cases", () => {
    const fieldRenderOptions = {
      scalarColorModes: new Set(["x"]),
      scalarColorsVisible: true,
    };

    expect(
      resolveViewport3DFieldRenderModelBuildOptions({
        complexFieldVector: null,
        fieldRenderOptions,
        fieldVector: { pointCount: 10_000 } as never,
        topology: { nodeCount: 10_000 } as never,
      }),
    ).toBe(fieldRenderOptions);
    expect(
      resolveViewport3DFieldRenderModelBuildOptions({
        complexFieldVector: null,
        fieldRenderOptions,
        fieldVector: { pointCount: 50_000 } as never,
        topology: { magneticParts: [], nodeCount: 75_000 } as never,
      }),
    ).toBe(fieldRenderOptions);
    expect(
      resolveViewport3DFieldRenderModelBuildOptions({
        complexFieldVector: {},
        fieldRenderOptions,
        fieldVector: { pointCount: 75_000 } as never,
        topology: { nodeCount: 75_000 } as never,
      }),
    ).toBe(fieldRenderOptions);
  });

  it("passes the resolved FDM target field vector to the cuboid layer", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("const fdmFieldVector =");
    expect(source).toContain("resolveViewport3DFieldVectorForDomain({");
    expect(source).toContain("safeViewport3DDomainGenerationId(");
    expect(source).toContain(
      "resolveViewport3DTargetQuantityFieldVectorForTarget({",
    );
    expect(source).toContain("fieldVector: fdmFieldVector,");
  });

  it("builds synthetic +Z airbox vector fields without backend data", () => {
    const field = buildViewport3DAirboxSyntheticVectorField(
      {
        boundary_face_count: 0,
        boundary_face_start: 0,
        id: "airbox",
        label: "Airbox",
        node_indices: [2, 4, 6],
        role: "air",
      } as never,
      8,
    );

    expect(field).toMatchObject({
      dtype: "float64",
      grid: [3, 1, 1],
      nComp: 3,
      pointCount: 3,
      quantityId: "debug:airbox:synthetic:+z",
      valueCount: 9,
    });
    expect(Array.from(field?.values ?? [])).toEqual([
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
    ]);
  });

  it("keeps scoped part scalar ranges ahead of full-field fallback ranges", () => {
    const ranges = mergeViewport3DPartScalarRanges({
      baseRanges: new Map([
        ["part:film", new Map([["y", { max: 5, min: -5 }]])],
      ]),
      partFieldVectors: new Map([
        [
          "part:film",
          {
            dtype: "float64",
            grid: [2, 1, 1],
            nComp: 1,
            pointCount: 2,
            quantityId: "m",
            valueCount: 2,
            values: new Float64Array([100, 200]),
          },
        ],
        [
          "part:ring",
          {
            dtype: "float64",
            grid: [2, 1, 1],
            nComp: 1,
            pointCount: 2,
            quantityId: "m",
            valueCount: 2,
            values: new Float64Array([-2, 3]),
          },
        ],
      ]),
      partScalarColorModes: new Map([
        ["part:film", "y"],
        ["part:ring", "y"],
      ]),
    });

    expect(ranges.get("part:film")?.get("y")).toEqual({ max: 5, min: -5 });
    expect(ranges.get("part:ring")?.get("y")).toEqual({ max: 3, min: -2 });
  });

  it("derives part scalar ranges from target field buffers before legacy vectors", () => {
    const legacyVector: DecodedFieldVector = {
      dtype: "float64",
      grid: [2, 1, 1],
      nComp: 1,
      pointCount: 2,
      quantityId: "m",
      valueCount: 2,
      values: new Float64Array([100, 200]),
    };
    const targetVector: DecodedFieldVector = {
      dtype: "float64",
      grid: [2, 1, 1],
      nComp: 1,
      pointCount: 2,
      quantityId: "m",
      valueCount: 2,
      values: new Float64Array([-0.25, 0.75]),
    };
    const ranges = mergeViewport3DPartScalarRanges({
      partFieldVectors: new Map([["part:film", legacyVector]]),
      partScalarColorModes: new Map([["part:film", "y"]]),
      partTargetFieldBuffers: new Map([
        [
          "part:film",
          buildViewport3DTargetFieldBuffer({
            fieldVector: targetVector,
            query: {
              component: "y",
              scope_id: "part:film",
              scope_kind: "part",
            },
            targetIds: ["part:film"],
          }),
        ],
      ]),
    });

    expect(ranges.get("part:film")?.get("y")).toEqual({
      max: 0.75,
      min: -0.25,
    });
  });

  it("wires synthetic airbox vectors as a local render-only fallback", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("airboxSettings.airboxSyntheticVectorsEnabled");
    expect(source).toContain("buildViewport3DAirboxSyntheticVectorField");
    expect(source).toContain(
      "airboxVectorsVisible && !airboxSettings.airboxSyntheticVectorsEnabled",
    );
    expect(source).toContain("resolveViewport3DResolvedPartFieldBuffers({");
    expect(source).toContain("if (partFieldVectors.has(partId) || partTargetFieldBuffers.has(partId))");
    expect(source).toContain("synthetic: true");
    expect(source).toContain("partTargetFieldBuffers.set(");
  });

  it("uses frequency-domain analysis overlay fields as the primary 3D field source", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("useRenderableAnalysisFieldOverlay");
    expect(source).toContain("startAnalysisFieldOverlayPhaseAnimation");
    expect(source).toContain("const primaryFieldQuantityId = analysisOverlay?.fieldId ?? quantityId;");
    expect(source).toContain("if (analysisOverlay) {");
    expect(source).toContain("query: analysisOverlay.query,");
    expect(source).toContain("consumers: [\"primary-field-vector\"],");
    expect(source).toContain("visualizationPhaseRad:");
    expect(source).toContain("analysisOverlay?.visualizationPhaseRad ??");
    expect(source).toContain("resolveViewport3DAnalysisComplexFieldQuery");
    expect(source).toContain("asDecodedComplexFieldVector");
    expect(source).toContain("Boolean(analysisOverlay) ||");
  });

  it("requests analysis complex field data without making phase part of the resource key", () => {
    expect(
      resolveViewport3DAnalysisComplexFieldQuery({
        component: "full",
        phase_rad: 1.25,
        scope_kind: "full",
        view: "phase_rotated_real",
      }),
    ).toEqual({
      component: "full",
      scope_kind: "full",
      view: "complex",
    });
  });

  it("uses complex projection only for phase-rotated analysis views", () => {
    expect(
      resolveViewport3DAnalysisComplexProjectionEnabled({
        component: "full",
        phase_rad: 0,
        view: "phase_rotated_real",
      }),
    ).toBe(true);

    for (const view of ["real", "imag", "abs", "phase"] as const) {
      expect(
        resolveViewport3DAnalysisComplexProjectionEnabled({
          component: "full",
          phase_rad: 0,
          view,
        }),
      ).toBe(false);
    }
  });

  it("does not fetch authored regions before a scene resource exists", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("useModelRegionsResource({");
    expect(source).toContain("enabled: Boolean(scene.data)");
  });

  it("does not use domain selections to filter object region overlays", () => {
    expect(
      resolveViewport3DRegionSelectionScope({
        kind: "domain",
        label: "fdm-fixture-domain",
        moduleSource: "viewport-3d",
        nodeId: "domain",
        objectId: "fdm-fixture-domain",
        ref: null,
      }),
    ).toEqual({
      selectedObjectId: null,
      selectedRegionId: null,
    });
  });

  it("requests scalar field components when the primary field is only used for scalar surface colors", () => {
    expect(
      resolveViewport3DPrimaryFieldQuery({
        fdmInstanceModelNeedsFieldVector: false,
        fdmSurfaceColorMode: null,
        fdmTopographyEnabled: false,
        fdmVectorsVisible: false,
        fieldRenderOptions: {
          fullVectorBudget: 0,
          partVectorBudgets: new Map(),
          scalarColorModes: new Set(["magnitude"]),
          scalarColorsVisible: true,
        },
      }),
    ).toEqual({
      component: "magnitude",
      scope_kind: "full",
    });

    expect(
      resolveViewport3DPrimaryFieldQuery({
        fdmInstanceModelNeedsFieldVector: false,
        fdmSurfaceColorMode: null,
        fdmTopographyEnabled: false,
        fdmVectorsVisible: false,
        fieldRenderOptions: {
          fullVectorBudget: 0,
          partVectorBudgets: new Map(),
          scalarColorModes: new Set(["x"]),
          scalarColorsVisible: true,
        },
      }),
    ).toEqual({
      component: "x",
      scope_kind: "full",
    });
  });

  it("plans primary field requests with canonical consumers and request identity", () => {
    const plan = resolveViewport3DPrimaryFieldDemandPlan({
      fdmInstanceModelNeedsFieldVector: false,
      fdmSurfaceColorMode: null,
      fdmTopographyEnabled: false,
      fdmVectorsVisible: false,
      fieldRenderOptions: {
        fullVectorBudget: 0,
        partVectorBudgets: new Map(),
        scalarColorModes: new Set(["x"]),
        scalarColorsVisible: true,
      },
      primaryFieldQuantityId: "m",
      snapshotQuery: {
        snapshot_id: "snapshot-3",
        stage_id: "stage-relax",
      },
    });

    expect(plan.demands).toEqual([
      expect.objectContaining({
        component: "full",
        passId: "primary-field:surface",
        passKind: "surface",
        quantityId: "m",
      }),
    ]);
    expect(plan.request).toMatchObject({
      consumers: ["primary-field:surface"],
      quantityId: "m",
      query: {
        component: "full",
        scope_kind: "full",
        snapshot_id: "snapshot-3",
        stage_id: "stage-relax",
      },
    });
    expect(plan.request?.requestId).toContain("quantity=m");
    expect(plan.request?.requestId).toContain("component=full");
    expect(plan.request?.requestId).toContain("scope_kind=full");
    expect(plan.request?.requestId).toContain("snapshot_id=snapshot-3");
    expect(plan.request?.requestId).toContain("stage_id=stage-relax");
  });

  it("plans one complete primary full-vector request when primary shader and vectors both need field data", () => {
    const plan = resolveViewport3DPrimaryFieldDemandPlan({
      fdmInstanceModelNeedsFieldVector: false,
      fdmSurfaceColorMode: null,
      fdmTopographyEnabled: false,
      fdmVectorsVisible: false,
      fieldRenderOptions: {
        fullVectorBudget: 0,
        partVectorBudgets: new Map([["part:film", 512]]),
        scalarColorModes: new Set(["x"]),
        scalarColorsVisible: true,
      },
      primaryFieldQuantityId: "m",
    });

    expect(plan.demands.map((demand) => demand.passKind).sort()).toEqual([
      "surface",
      "vector-glyph",
    ]);
    expect(plan.request).toMatchObject({
      consumers: [
        "primary-field:surface",
        "primary-field:vector-glyph",
      ],
      query: {
        component: "full",
        scope_kind: "full",
      },
    });
    expect(plan.request?.query).not.toHaveProperty("max_samples");
  });

  it("keeps full vector data when scalar surface colors need multiple components", () => {
    expect(
      resolveViewport3DPrimaryFieldQuery({
        fdmInstanceModelNeedsFieldVector: false,
        fdmSurfaceColorMode: null,
        fdmTopographyEnabled: false,
        fdmVectorsVisible: false,
        fieldRenderOptions: {
          fullVectorBudget: 0,
          partVectorBudgets: new Map(),
          scalarColorModes: new Set(["x", "y"]),
          scalarColorsVisible: true,
        },
      }),
    ).toEqual({
      component: "full",
      scope_kind: "full",
    });

    expect(
      resolveViewport3DPrimaryFieldQuery({
        fdmInstanceModelNeedsFieldVector: false,
        fdmSurfaceColorMode: "x",
        fdmTopographyEnabled: false,
        fdmVectorsVisible: false,
        fieldRenderOptions: {
          fullVectorBudget: 0,
          partVectorBudgets: new Map(),
          scalarColorModes: new Set(["magnitude"]),
          scalarColorsVisible: true,
        },
      }),
    ).toEqual({
      component: "full",
      scope_kind: "full",
    });
  });

  it("keeps magnetic part render options active for analysis eigen overlays", () => {
    const options = resolveViewport3DPrimaryFieldRenderOptions({
      analysisOverlayActive: true,
      fieldRenderOptions: {
        fullVectorBudget: 0,
        partVectorBudgets: new Map(),
        scalarColorModes: new Set(),
        scalarColorsVisible: false,
      },
      getPartSettings: () => ({
        activeQuantityId: "m",
        shaderVisible: true,
        surfaceColorSource: "magnitude",
        vectorBudget: 96,
        vectorsVisible: true,
        visible: true,
      }),
      magneticParts: [{ part: { id: "film" } as never }],
      quantityId: "analysis:eigen:sample-0000:mode-0002",
      vectorDomain: "auto",
    });

    expect(options.scalarColorsVisible).toBe(true);
    expect(options.scalarColorModes).toEqual(new Set(["magnitude"]));
    expect(options.partVectorBudgets?.get("film")).toBe(96);
  });

  it("uses analysis overlay appearance for mode field surface coloring", () => {
    const options = resolveViewport3DPrimaryFieldRenderOptions({
      analysisOverlayActive: true,
      analysisOverlayAppearance: {
        scalarColorPalette: "inferno",
        surfaceColorSource: "component_z",
      },
      fieldRenderOptions: {
        fullVectorBudget: 0,
        partVectorBudgets: new Map(),
        scalarColorModes: new Set(),
        scalarColorsVisible: false,
      },
      getPartSettings: () => ({
        activeQuantityId: "m",
        shaderVisible: true,
        surfaceColorSource: "magnitude",
        vectorBudget: 96,
        vectorsVisible: false,
        visible: true,
      }),
      magneticParts: [{ part: { id: "film" } as never }],
      quantityId: "analysis:eigen:sample-0000:mode-0002",
      vectorDomain: "auto",
    });

    expect(options.scalarColorPalette).toBe("inferno");
    expect(options.scalarColorsVisible).toBe(true);
    expect(options.scalarColorModes).toEqual(new Set(["z"]));
  });

  it("preserves per-part scalar color mode and palette for shared field rendering", () => {
    const options = resolveViewport3DPrimaryFieldRenderOptions({
      fieldRenderOptions: {
        fullVectorBudget: 0,
        partScalarColorModes: new Map([["film", "x"]]),
        partScalarColorPalettes: new Map([["film", "inferno"]]),
        partVectorBudgets: new Map(),
        scalarColorModes: new Set(["x"]),
        scalarColorPalette: "viridis",
        scalarColorsVisible: true,
      },
      getPartSettings: () => ({
        activeQuantityId: "m",
        scalarColorPalette: "inferno",
        shaderVisible: true,
        surfaceColorSource: "component_x",
        vectorBudget: 0,
        vectorsVisible: false,
        visible: true,
      }),
      magneticParts: [{ part: { id: "film" } as never }],
      quantityId: "m",
      vectorDomain: "auto",
    });

    expect(options.scalarColorModes).toEqual(new Set(["x"]));
    expect(options.partScalarColorModes?.get("film")).toBe("x");
    expect(options.partScalarColorPalettes?.get("film")).toBe("inferno");
    expect(options.targetRenderPlans?.get("film")).toMatchObject({
      quantityId: "m",
      shader: {
        palette: "inferno",
        scalarColorMode: "x",
        visible: true,
      },
      targetId: "film",
      vectors: {
        budget: 0,
        visible: false,
      },
    });
  });

  it("preserves per-part scalar color modes for non-primary quantities without making them global", () => {
    const options = resolveViewport3DPrimaryFieldRenderOptions({
      fieldRenderOptions: {
        fullVectorBudget: 0,
        partVectorBudgets: new Map(),
        scalarColorModes: new Set(),
        scalarColorPalette: "viridis",
        scalarColorsVisible: false,
      },
      getPartSettings: () => ({
        activeQuantityId: "H_eff",
        scalarColorPalette: "magma",
        shaderVisible: true,
        surfaceColorSource: "component_y",
        vectorBudget: 0,
        vectorsVisible: false,
        visible: true,
      }),
      magneticParts: [{ part: { id: "part:film" } as never }],
      quantityId: "m",
      vectorDomain: "auto",
    });

    expect(options.scalarColorModes).toEqual(new Set());
    expect(options.scalarColorsVisible).toBe(true);
    expect(options.partScalarColorModes?.get("part:film")).toBe("y");
    expect(options.partScalarColorPalettes?.get("part:film")).toBe("magma");
  });

  it("removes stale scalar color plans for hidden region-backed parts", () => {
    const options = resolveViewport3DPrimaryFieldRenderOptions({
      fieldRenderOptions: {
        fullVectorBudget: 0,
        partScalarColorModes: new Map([["part:film:core", "x"]]),
        partScalarColorPalettes: new Map([["part:film:core", "inferno"]]),
        partVectorBudgets: new Map([["part:film:core", 512]]),
        scalarColorModes: new Set(),
        scalarColorsVisible: true,
      },
      getPartSettings: () => ({
        activeQuantityId: "m",
        scalarColorPalette: "inferno",
        shaderVisible: true,
        surfaceColorSource: "component_x",
        vectorBudget: 512,
        vectorsVisible: true,
        visible: false,
      }),
      magneticParts: [{ part: { id: "part:film:core" } as never }],
      quantityId: "m",
      vectorDomain: "auto",
    });

    expect(Boolean(options.partScalarColorModes?.has("part:film:core"))).toBe(false);
    expect(Boolean(options.partScalarColorPalettes?.has("part:film:core"))).toBe(false);
    expect(Boolean(options.partVectorBudgets?.has("part:film:core"))).toBe(false);
    expect(options.scalarColorsVisible).toBe(false);
    expect(options.targetRenderPlans?.get("part:film:core")).toMatchObject({
      shader: { visible: false },
      vectors: { visible: false },
      visible: false,
    });
  });

  it("builds per-part scalar range metadata requests for numeric component color modes", () => {
    const requests = resolveViewport3DPartScalarRangeRequests({
      fieldRenderOptions: {
        partScalarColorModes: new Map([
          ["part:film", "y"],
          ["part:ring", "orientation"],
          ["part:cap", "magnitude"],
        ]),
      },
      getPartSettings: (part) => ({
        activeQuantityId: part.id === "part:cap" ? "H_eff" : "m",
        shaderVisible: part.id !== "part:ring",
        surfaceColorSource:
          part.id === "part:film"
            ? "component_y"
            : part.id === "part:cap"
              ? "magnitude"
              : "orientation",
        visible: true,
      } as never),
      magneticParts: [
        { part: { id: "part:film", object_id: "film" } as never },
        { part: { id: "part:ring", object_id: "ring" } as never },
        { part: { id: "part:cap" } as never },
      ],
      selectedSnapshotQuery: {
        snapshot_id: "snapshot-4",
        stage_id: "stage-1",
      },
    });

    expect([...requests]).toEqual([
      [
        "part:cap",
        {
          component: "magnitude",
          mode: "magnitude",
          partId: "part:cap",
          quantityId: "H_eff",
          scopeId: "part:cap",
          scopeKind: "part",
          snapshot_id: "snapshot-4",
          stage_id: "stage-1",
        },
      ],
      [
        "part:film",
        {
          component: "y",
          mode: "y",
          partId: "part:film",
          quantityId: "m",
          scopeId: "film",
          scopeKind: "object",
          snapshot_id: "snapshot-4",
          stage_id: "stage-1",
        },
      ],
    ]);
  });

  it("uses full field metadata for scalar spatial per-part color ranges", () => {
    const requests = resolveViewport3DPartScalarRangeRequests({
      fieldRenderOptions: {
        partScalarColorModes: new Map([["part:layer", "magnitude"]]),
      },
      getPartSettings: () => ({
        activeQuantityId: "eden_total",
        shaderVisible: true,
        surfaceColorSource: "colormap",
        visible: true,
      } as never),
      magneticParts: [
        { part: { id: "part:layer", object_id: "permalloy_layer" } as never },
      ],
    });

    expect(requests.get("part:layer")).toMatchObject({
      component: "full",
      mode: "magnitude",
      quantityId: "eden_total",
      scopeId: "permalloy_layer",
      scopeKind: "object",
    });
  });

  it("uses analysis overlay display pass appearance for mode field vectors", () => {
    const options = resolveViewport3DPrimaryFieldRenderOptions({
      analysisOverlayActive: true,
      analysisOverlayAppearance: {
        shaderVisible: false,
        vectorBudget: 512,
        vectorsVisible: true,
      },
      fieldRenderOptions: {
        fullVectorBudget: 0,
        partVectorBudgets: new Map(),
        scalarColorModes: new Set(["magnitude"]),
        scalarColorsVisible: true,
      },
      getPartSettings: () => ({
        activeQuantityId: "m",
        shaderVisible: true,
        surfaceColorSource: "magnitude",
        vectorBudget: 96,
        vectorsVisible: false,
        visible: true,
      }),
      magneticParts: [{ part: { id: "film" } as never }],
      quantityId: "analysis:eigen:sample-0000:mode-0002",
      vectorDomain: "auto",
    });

    expect(options.scalarColorsVisible).toBe(false);
    expect(options.scalarColorModes).toEqual(new Set());
    expect(options.partVectorBudgets?.get("film")).toBe(512);
  });

  it("treats solid analysis overlay coloring as material color, not scalar field coloring", () => {
    const options = resolveViewport3DPrimaryFieldRenderOptions({
      analysisOverlayActive: true,
      analysisOverlayAppearance: {
        shaderMonoColor: "#ff3366",
        surfaceColorSource: "solid",
      },
      fieldRenderOptions: {
        fullVectorBudget: 0,
        partVectorBudgets: new Map(),
        scalarColorModes: new Set(["magnitude"]),
        scalarColorsVisible: true,
      },
      getPartSettings: () => ({
        activeQuantityId: "m",
        shaderVisible: true,
        surfaceColorSource: "magnitude",
        vectorBudget: 96,
        vectorsVisible: false,
        visible: true,
      }),
      magneticParts: [{ part: { id: "film" } as never }],
      quantityId: "analysis:eigen:sample-0000:mode-0002",
      vectorDomain: "auto",
    });

    expect(options.scalarColorsVisible).toBe(false);
    expect(options.scalarColorModes).toEqual(new Set());
  });

  it("loads hysteresis point snapshots through the selected point quantity", () => {
    const selection = {
      kind: "analysis.chart-point",
      label: "Point 4",
      moduleSource: "analysis-plots",
      nodeId: "hysteresis-point-4",
      objectId: null,
      ref: {
        chartId: "hysteresis",
        kind: "analysis.chart-point",
        nodeId: "hysteresis-point-4",
        quantity: "m",
        rowIndex: 4,
        seriesId: "hysteresis",
        snapshotId: "hysteresis-stage-1-point-4",
        tableId: "hysteresis",
        type: "analysis-chart-point",
        x: 20,
        y: 0.82,
      },
    } as const;
    const selectedSnapshotId = resolveViewport3DSelectedSnapshotId(selection);

    expect(selectedSnapshotId).toBe("hysteresis-stage-1-point-4");
    expect(
      resolveViewport3DActiveQuantityId({
        selectedSnapshotId,
        selection,
        visualizationState: {
          active_quantity_id: "H_eff",
        } as never,
      }),
    ).toBe("m");
    expect(
      resolveViewport3DPrimaryFieldVectorEnabled({
        fdmInstanceModelNeedsFieldVector: false,
        fdmSurfaceColorMode: null,
        fdmVectorsVisible: false,
        fieldRenderOptions: {
          fullVectorBudget: 0,
          partVectorBudgets: new Map(),
          scalarColorModes: new Set(),
          scalarColorsVisible: false,
        },
        selectedSnapshotId,
      }),
    ).toBe(true);
    expect(
      resolveViewport3DPrimaryFieldQuery({
        fdmInstanceModelNeedsFieldVector: false,
        fdmSurfaceColorMode: null,
        fdmTopographyEnabled: false,
        fdmVectorsVisible: false,
        fieldRenderOptions: {
          fullVectorBudget: 0,
          partVectorBudgets: new Map(),
          scalarColorModes: new Set(),
          scalarColorsVisible: false,
        },
        snapshotId: selectedSnapshotId,
      }),
    ).toEqual({
      component: "full",
      scope_kind: "full",
      snapshot_id: "hysteresis-stage-1-point-4",
    });
  });

  it("routes chart-built hysteresis selections to snapshot field queries", () => {
    const chartSelection = buildHysteresisChartPointSelection({
      point: {
        branch_id: "descending",
        branch_ids: ["descending"],
        branch_index: 0,
        field_value_mT: -25,
        is_reversal_field: false,
        m_avg: [0.1, 0.2, 0.9],
        m_ip: 0.22,
        m_oop: 0.9,
        m_parallel: 0.82,
        minor_loop_id: null,
        parent_branch_id: null,
        point_id: 7,
        protocol_role: "major_descending",
        recoil_start_point_id: null,
        reversal_index: null,
        snapshot_id: "hysteresis_point_008",
        snapshot_resource_ref: null,
        snapshot_vector_resource_ref: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_008&stage_id=hysteresis-1`,
        status: "Completed",
      },
      stageId: "hysteresis-1",
      targetMetadata: {
        fieldOrientation: "in_plane_y",
        fieldRevision: 41,
        measurementAxis: "field_axis",
        meshIdentity: "study_domain",
      },
      yAxisKey: "m_parallel",
    });
    const selection: Selection = {
      kind: chartSelection.kind ?? null,
      label: chartSelection.label ?? null,
      moduleSource: "analysis-plots",
      nodeId: chartSelection.nodeId ?? null,
      objectId: chartSelection.objectId ?? null,
      ref: chartSelection.ref ?? null,
    };

    const target = resolveHysteresisStepViewportTarget(selection);
    const selectedSnapshotId = resolveViewport3DSelectedSnapshotId(selection);

    expect(target).toEqual({
      fieldOrientation: "in_plane_y",
      fieldRevision: 41,
      measurementAxis: "field_axis",
      meshIdentity: "study_domain",
      pointId: 7,
      quantityId: "m",
      resourceRef: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_008&stage_id=hysteresis-1`,
      snapshotId: "hysteresis_point_008",
      stageId: "hysteresis-1",
      targetId: "hysteresis-step:hysteresis-1:7",
    });
    expect(selectedSnapshotId).toBe("hysteresis_point_008");
    expect(
      resolveViewport3DActiveQuantityId({
        selectedSnapshotId,
        selection,
        visualizationState: { active_quantity_id: "H_eff" } as never,
      }),
    ).toBe("m");
    expect(
      resolveViewport3DPrimaryFieldQuery({
        fdmInstanceModelNeedsFieldVector: false,
        fdmSurfaceColorMode: null,
        fdmTopographyEnabled: false,
        fdmVectorsVisible: false,
        fieldRenderOptions: {
          fullVectorBudget: 0,
          partVectorBudgets: new Map(),
          scalarColorModes: new Set(),
          scalarColorsVisible: false,
        },
        snapshotId: selectedSnapshotId,
        snapshotQuery: resolveViewport3DSelectedSnapshotQuery(selection),
      }),
    ).toEqual({
      component: "full",
      scope_kind: "full",
      snapshot_id: "hysteresis_point_008",
      stage_id: "hysteresis-1",
    });
  });

  it("routes explorer hysteresis snapshot selections to snapshot field queries", () => {
    const selection: Selection = {
      kind: "study.stage.action",
      label: "Snapshot hysteresis_point_007",
      moduleSource: "explorer",
      nodeId: "model:study:stages:stage:hysteresis-1:field-point:7:snapshot:hysteresis_point_007",
      objectId: null,
      ref: {
        kind: "study.stage.action",
        nodeId:
          "model:study:stages:stage:hysteresis-1:field-point:7:snapshot:hysteresis_point_007",
        pointId: 7,
        quantityId: "m",
        resourceRef: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_007&stage_id=hysteresis-1`,
        snapshotId: "hysteresis_point_007",
        stageId: "hysteresis-1",
        stageIndex: 0,
        targetId: "hysteresis-step:hysteresis-1:7",
        type: "hysteresis-snapshot",
      },
    };

    const target = resolveHysteresisStepViewportTarget(selection);
    const selectedSnapshotId = resolveViewport3DSelectedSnapshotId(selection);

    expect(target).toEqual({
      fieldOrientation: null,
      fieldRevision: null,
      measurementAxis: null,
      meshIdentity: null,
      pointId: 7,
      quantityId: "m",
      resourceRef: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_007&stage_id=hysteresis-1`,
      snapshotId: "hysteresis_point_007",
      stageId: "hysteresis-1",
      targetId: "hysteresis-step:hysteresis-1:7",
    });
    expect(selectedSnapshotId).toBe("hysteresis_point_007");
    expect(
      resolveViewport3DActiveQuantityId({
        selectedSnapshotId,
        selection,
        visualizationState: { active_quantity_id: "H_eff" } as never,
      }),
    ).toBe("m");
    expect(
      resolveViewport3DPrimaryFieldQuery({
        fdmInstanceModelNeedsFieldVector: false,
        fdmSurfaceColorMode: null,
        fdmTopographyEnabled: false,
        fdmVectorsVisible: false,
        fieldRenderOptions: {
          fullVectorBudget: 0,
          partVectorBudgets: new Map(),
          scalarColorModes: new Set(),
          scalarColorsVisible: false,
        },
        snapshotId: selectedSnapshotId,
        snapshotQuery: resolveViewport3DSelectedSnapshotQuery(selection),
      }),
    ).toEqual({
      component: "full",
      scope_kind: "full",
      snapshot_id: "hysteresis_point_007",
      stage_id: "hysteresis-1",
    });
  });

  it("switches replay field resource keys between saved hysteresis snapshots", () => {
    const buildSelection = (
      stageId: string,
      pointId: number,
      snapshotId: string,
    ): Selection => ({
      kind: "study.stage.action",
      label: `Snapshot ${snapshotId}`,
      moduleSource: "explorer",
      nodeId: `model:study:stages:stage:${stageId}:field-point:${pointId}:snapshot:${snapshotId}`,
      objectId: null,
      ref: {
        kind: "study.stage.action",
        nodeId: `model:study:stages:stage:${stageId}:field-point:${pointId}:snapshot:${snapshotId}`,
        pointId,
        quantityId: "m",
        resourceRef: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=${snapshotId}&stage_id=${stageId}`,
        snapshotId,
        stageId,
        stageIndex: 0,
        targetId: `hysteresis-step:${stageId}:${pointId}`,
        type: "hysteresis-snapshot",
      },
    });
    const fieldQueryForSelection = (selection: Selection) => {
      const selectedSnapshotId = resolveViewport3DSelectedSnapshotId(selection);
      return resolveViewport3DPrimaryFieldQuery({
        fdmInstanceModelNeedsFieldVector: false,
        fdmSurfaceColorMode: null,
        fdmTopographyEnabled: false,
        fdmVectorsVisible: false,
        fieldRenderOptions: {
          fullVectorBudget: 0,
          partVectorBudgets: new Map(),
          scalarColorModes: new Set(),
          scalarColorsVisible: false,
        },
        snapshotId: selectedSnapshotId,
        snapshotQuery: resolveViewport3DSelectedSnapshotQuery(selection),
      });
    };

    const firstKey = resolveViewport3DFieldVectorResourceKey(
      "m",
      fieldQueryForSelection(buildSelection("hysteresis-1", 7, "hysteresis_point_007")),
    );
    const secondKey = resolveViewport3DFieldVectorResourceKey(
      "m",
      fieldQueryForSelection(buildSelection("hysteresis-2", 12, "hysteresis_point_012")),
    );

    expect(firstKey).toBe(
      `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?component=full&scope_kind=full&snapshot_id=hysteresis_point_007&stage_id=hysteresis-1`,
    );
    expect(secondKey).toBe(
      `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?component=full&scope_kind=full&snapshot_id=hysteresis_point_012&stage_id=hysteresis-2`,
    );
    expect(secondKey).not.toContain("hysteresis_point_007");
    expect(secondKey).not.toContain("hysteresis-1");
  });

  it("applies hysteresis snapshot queries to target-specific quantity fields", () => {
    expect(
      resolveViewport3DReplayFieldQuery(
        resolveViewport3DTargetFieldQuery({
          surfaceColorMode: "magnitude",
          vectorsVisible: false,
        })!,
        {
          snapshot_id: "hysteresis_point_007",
          stage_id: "hysteresis-1",
        },
      ),
    ).toEqual({
      component: "full",
      scope_kind: "full",
      snapshot_id: "hysteresis_point_007",
      stage_id: "hysteresis-1",
    });

    expect(
      resolveViewport3DReplayFieldQuery(
        resolveViewport3DTargetFieldQuery({
          surfaceColorMode: null,
          vectorsVisible: true,
        })!,
        {
          snapshot_id: "hysteresis_point_007",
          stage_id: "hysteresis-1",
        },
      ),
    ).toEqual({
      component: "full",
      scope_kind: "full",
      snapshot_id: "hysteresis_point_007",
      stage_id: "hysteresis-1",
    });
  });

  it("preserves hysteresis snapshot queries when target field requests merge to full vectors", () => {
    expect(
      mergeViewport3DFieldQuery(
        {
          component: "x",
          scope_kind: "full",
          snapshot_id: "hysteresis_point_007",
          stage_id: "hysteresis-1",
        },
        {
          component: "y",
          scope_kind: "full",
          snapshot_id: "hysteresis_point_007",
          stage_id: "hysteresis-1",
        },
      ),
    ).toEqual({
      component: "full",
      scope_kind: "full",
      snapshot_id: "hysteresis_point_007",
      stage_id: "hysteresis-1",
    });
  });

  it("preserves scoped target queries when target field requests merge to full vectors", () => {
    expect(
      mergeViewport3DFieldQuery(
        {
          component: "x",
          scope_id: "part-a",
          scope_kind: "part",
        },
        {
          component: "y",
          scope_id: "part-a",
          scope_kind: "part",
        },
      ),
    ).toEqual({
      component: "full",
      scope_id: "part-a",
      scope_kind: "part",
    });
  });

  it("plans target-specific quantity fields with request identity and consumers", () => {
    const demandPlan = resolveViewport3DTargetQuantityFieldDemandPlan({
      fdmSettings: null,
      getPartSettings: (part) =>
        ({
          activeQuantityId: part.id === "part:a" ? "H_eff" : "m",
          shaderVisible: true,
          surfaceColorSource: "component_x",
          vectorBudget: part.id === "part:a" ? 512 : 0,
          vectorsVisible: part.id === "part:a",
          visible: true,
        }) as never,
      magneticPartScopedFieldIds: new Set(),
      magneticParts: [
        { part: { id: "part:a" } },
        { part: { id: "part:b" } },
      ] as never,
      maxVectorGlyphs: 2048,
      primaryFieldQuantityId: "m",
      selectedSnapshotQuery: {
        snapshot_id: "hysteresis_point_007",
        stage_id: "hysteresis-1",
      },
    });
    const requests = resolveViewport3DTargetQuantityFieldRequests({
      fdmSettings: null,
      getPartSettings: (part) =>
        ({
          activeQuantityId: part.id === "part:a" ? "H_eff" : "m",
          shaderVisible: true,
          surfaceColorSource: "component_x",
          vectorBudget: part.id === "part:a" ? 512 : 0,
          vectorsVisible: part.id === "part:a",
          visible: true,
        }) as never,
      magneticPartScopedFieldIds: new Set(),
      magneticParts: [
        { part: { id: "part:a" } },
        { part: { id: "part:b" } },
      ] as never,
      maxVectorGlyphs: 2048,
      primaryFieldQuantityId: "m",
      selectedSnapshotQuery: {
        snapshot_id: "hysteresis_point_007",
        stage_id: "hysteresis-1",
      },
    });

    expect(demandPlan.demands).toEqual([
      expect.objectContaining({
        component: "full",
        passId: "part:a:surface",
        passKind: "surface",
        quantityId: "H_eff",
      }),
      expect.objectContaining({
        component: "full",
        passId: "part:a:vector-glyph",
        passKind: "vector-glyph",
        quantityId: "H_eff",
      }),
    ]);
    expect(demandPlan.requests).toHaveLength(1);
    expect(requests.size).toBe(1);
    const request = Array.from(requests.values())[0];
    expect(request).toMatchObject({
      consumers: [
        "part:a:surface",
        "part:a:vector-glyph",
      ],
      quantityId: "H_eff",
      query: {
        component: "full",
        scope_id: "part:a",
        scope_kind: "part",
        snapshot_id: "hysteresis_point_007",
        stage_id: "hysteresis-1",
      },
    });
    expect(request?.query).not.toHaveProperty("max_samples");
    expect(request?.requestId).toContain("quantity=H_eff");
    expect(request?.requestId).toContain("component=full");
    expect(request?.requestId).toContain("scope_kind=part");
    expect(request?.requestId).toContain("scope_id=part:a");
    expect(request?.requestId).toContain("snapshot_id=hysteresis_point_007");
    expect(request?.requestId).toContain("stage_id=hysteresis-1");
  });

  it("plans independent full-grid FDM resources for object and region targets with distinct quantities", () => {
    const demandPlan = resolveViewport3DTargetQuantityFieldDemandPlan({
      fdmSettings: null,
      fdmTargetSettings: [
        {
          label: "Left object",
          settings: {
            ...DEFAULT_OBJECT_VISUALIZATION,
            activeQuantityId: "H_eff",
            shaderVisible: true,
            surfaceColorSource: "component_x",
            vectorBudget: 256,
            vectorsVisible: true,
            visible: true,
          },
          targetId: "object:left",
        },
        {
          label: "Right core",
          settings: {
            ...DEFAULT_OBJECT_VISUALIZATION,
            activeQuantityId: "H_demag",
            shaderVisible: true,
            surfaceColorSource: "magnitude",
            vectorBudget: 0,
            vectorsVisible: false,
            visible: true,
          },
          targetId: "region:right:core",
        },
      ],
      getPartSettings: () => DEFAULT_OBJECT_VISUALIZATION,
      magneticPartScopedFieldIds: new Set(),
      magneticParts: [],
      maxVectorGlyphs: 2048,
      primaryFieldQuantityId: "m",
    });

    expect(demandPlan.requests).toHaveLength(2);
    expect(Array.from(demandPlan.requests.values())).toEqual([
      expect.objectContaining({
        consumers: ["region:right:core:surface"],
        quantityId: "H_demag",
        query: { component: "full", scope_kind: "full" },
      }),
      expect.objectContaining({
        consumers: ["object:left:surface", "object:left:vector-glyph"],
        quantityId: "H_eff",
        query: { component: "full", scope_kind: "full" },
      }),
    ]);
  });

  it("fails closed instead of assigning another quantity's FDM buffer to a target", () => {
    const request = {
      consumers: ["object:left:surface"],
      quantityId: "H_eff",
      query: { component: "full" as const, scope_kind: "full" as const },
      requestId: "quantity=H_eff&component=full&scope_kind=full",
    };

    expect(
      resolveViewport3DFdmTargetFieldVectorForTarget({
        primaryFieldQuantityId: "m",
        primaryFieldVector: fieldVectorFixture({ quantityId: "m" }),
        quantityId: "H_eff",
        targetFieldRequests: new Map([[request.requestId, request]]),
        targetFieldVectors: new Map([
          [request.requestId, fieldVectorFixture({ quantityId: "m" })],
        ]),
        targetId: "object:left",
      }),
    ).toBeNull();
  });

  it("prefers an exact scoped Airbox response over an unscoped primary field of the same quantity", () => {
    const request = {
      consumers: ["fdm-universe-outside-support:vector-glyph"],
      quantityId: "H_eff",
      query: {
        component: "full" as const,
        max_samples: 64,
        scope_kind: "airbox" as const,
      },
      requestId:
        "component=full&max_samples=64&quantity=H_eff&scope_kind=airbox",
    };
    const primaryField = fieldVectorFixture({
      quantityId: "H_eff",
      scopeKind: "full",
    });
    const scopedField = fieldVectorFixture({
      quantityId: "H_eff",
      scopeKind: "airbox",
    });

    expect(
      resolveViewport3DFdmTargetFieldVectorForTarget({
        primaryFieldQuantityId: "H_eff",
        primaryFieldVector: primaryField,
        quantityId: "H_eff",
        targetFieldRequests: new Map([[request.requestId, request]]),
        targetFieldVectors: new Map([[request.requestId, scopedField]]),
        targetId: "fdm-universe-outside-support",
      }),
    ).toMatchObject({
      fieldVector: scopedField,
      request,
      requestId: request.requestId,
    });
  });

  it("keeps stale field resources out of the render frame key when payload data is still visible", () => {
    expect(
      resolveViewport3DResourceFrameState({
        dataAvailable: true,
        error: null,
        id: "field-vector",
        payloadRevision: "etag-1",
        revision: "scalar-tick-2",
        status: "stale",
      }),
    ).toEqual({
      error: null,
      id: "field-vector",
      revision: "etag-1",
      status: "ready",
    });
  });

  it.each(["stale_complete", "pending"] as const)(
    "keeps topology-compatible %s field payloads in the render frame",
    (materializationState) => {
      expect(
        resolveViewport3DResourceFrameState({
          dataAvailable: true,
          error: null,
          id: "field-vector",
          materializationState,
          payloadRevision: "etag-step-40",
          revision: "freshness-step-50",
          status: "ready",
        }),
      ).toEqual({
        error: null,
        id: "field-vector",
        revision: "etag-step-40",
        status: "ready",
      });
    },
  );

  it("builds immediate region overlays from the committed scene while the region resource refreshes", () => {
    expect(
      resolveViewport3DRegionOverlays({
        objectTransformsById: new Map([
          ["film", { translation: [1, 2, 3] }],
        ]),
        regionResource: { geometry_realization_revision: 7, regions: [], scene_revision: 7 },
        scene: {
          objects: [
            {
              id: "film",
              regions: [
                {
                  name: "core",
                  region_id: "film:r1",
                  shape: {
                    axis: [0, 0, 1],
                    center: [0, 0, 0],
                    height: 2e-9,
                    kind: "cylinder",
                    radius: 50e-9,
                  },
                },
              ],
              transform: { translation: [0, 0, 0] },
              visible: true,
            },
          ],
        },
      }),
    ).toMatchObject([
      {
        name: "core",
        owner_object_id: "film",
        owner_transform: { translation: [1, 2, 3] },
        region_id: "film:r1",
      },
    ]);
  });

  it("normalizes fallback scene region shapes through the generated OpenAPI shape contract", () => {
    expect(
      resolveViewport3DRegionOverlays({
        objectTransformsById: new Map(),
        regionResource: { geometry_realization_revision: 7, regions: [], scene_revision: 7 },
        scene: {
          objects: [
            {
              id: "film",
              regions: [
                {
                  name: "good",
                  region_id: "film:good",
                  shape: {
                    center: [0, 0, 0],
                    kind: "sphere",
                    radius: 2,
                  },
                },
                {
                  name: "bad",
                  region_id: "film:bad",
                  shape: {
                    center: [0, 0, 0],
                    kind: "sphere",
                    radius: "2",
                  },
                },
                {
                  name: "csg",
                  region_id: "film:csg",
                  shape: {
                    expression: {},
                    kind: "csg",
                  },
                },
              ],
            },
          ],
        },
      }),
    ).toEqual([
      {
        enabled: true,
        frame: null,
        name: "good",
        owner_object_id: "film",
        owner_transform: null,
        priority: null,
        region_id: "film:good",
        shape: {
          center: [0, 0, 0],
          kind: "sphere",
          radius: 2,
        },
      },
    ]);
  });

  it("deduplicates scene fallback overlays once the region resource is current", () => {
    expect(
      resolveViewport3DRegionOverlays({
        objectTransformsById: new Map(),
        regionResource: {
          geometry_realization_revision: 8,
          regions: [
            {
              bounds_max: [0, 0, 0],
              bounds_min: [0, 0, 0],
              enabled: true,
              interaction_refs: [],
              material_parameter_fields: [],
              material_ref: "permalloy",
              mesh_part_ids: [],
              name: "core",
              owner_object_id: "film",
              owner_path: "film/film:r1",
              region_id: "film:r1",
              source: "authored_object_region",
              source_body_ids: [],
              source_object_ids: ["film"],
            },
          ],
          scene_revision: 8,
        },
        scene: {
          objects: [
            {
              id: "film",
              regions: [{ name: "core", region_id: "film:r1" }],
            },
          ],
        },
      }),
    ).toHaveLength(1);
  });

  it("hides authored primitive overlays once a region is backed by current mesh parts", () => {
    expect(
      resolveViewport3DRegionOverlays({
        objectTransformsById: new Map(),
        realizedRegionKeys: new Set(["film\u0000film:r1"]),
        regionResource: {
          geometry_realization_revision: 8,
          regions: [
            {
              bounds_max: [0, 0, 0],
              bounds_min: [0, 0, 0],
              enabled: true,
              interaction_refs: [],
              material_parameter_fields: [],
              material_ref: "permalloy",
              mesh_part_ids: [],
              name: "core",
              owner_object_id: "film",
              owner_path: "film/film:r1",
              region_id: "film:r1",
              shape: {
                center: [0, 0, 0],
                kind: "sphere",
                radius: 1,
              },
              source: "authored_object_region",
              source_body_ids: [],
              source_object_ids: ["film"],
            },
          ],
          scene_revision: 8,
        },
        scene: {
          objects: [
            {
              id: "film",
              regions: [
                {
                  name: "core",
                  region_id: "film:r1",
                  shape: {
                    center: [0, 0, 0],
                    kind: "sphere",
                    radius: 1,
                  },
                },
              ],
            },
          ],
        },
      }),
    ).toEqual([]);
  });

  it("hides authored primitive overlays for mesh-backed geometry-id region aliases", () => {
    const realizedRegionKeys = resolveViewport3DMeshBackedRegionKeys([
      {
        material_ref: "permalloy",
        mesh_part_ids: ["part:film:r1"],
        name: "core",
        region_id: "mesh:film:r1",
        source_object_ids: ["film_geom"],
        source_region_candidate_id: "film:r1",
      },
    ] as never);

    expect(
      resolveViewport3DRegionOverlays({
        objectTransformsById: new Map(),
        realizedRegionKeys,
        regionResource: {
          geometry_realization_revision: 8,
          regions: [
            {
              bounds_max: [0, 0, 0],
              bounds_min: [0, 0, 0],
              enabled: true,
              interaction_refs: [],
              material_parameter_fields: [],
              material_ref: "permalloy",
              mesh_part_ids: [],
              name: "core",
              owner_object_id: "film",
              owner_path: "film/film:r1",
              region_id: "film:r1",
              shape: {
                center: [0, 0, 0],
                kind: "sphere",
                radius: 1,
              },
              source: "authored_object_region",
              source_body_ids: [],
              source_object_ids: ["film"],
            },
          ],
          scene_revision: 8,
        },
        scene: {
          objects: [
            {
              id: "film",
              regions: [
                {
                  name: "core",
                  region_id: "film:r1",
                  shape: {
                    center: [0, 0, 0],
                    kind: "sphere",
                    radius: 1,
                  },
                },
              ],
            },
          ],
        },
      }),
    ).toEqual([]);
  });

  it("maps mesh-backed region parts to the same visualization target as authored overlays", () => {
    const regions = [
      {
        bounds_max: [1, 1, 1],
        bounds_min: [0, 0, 0],
        element_count: 24,
        mesh_part_ids: ["part:film_geom"],
        name: "Film",
        region_id: "film",
        source_object_ids: ["film"],
        source_region_candidate_id: "film",
      },
      {
        bounds_max: [1, 1, 1],
        bounds_min: [0, 0, 0],
        element_count: 12,
        mesh_part_ids: ["part:film:core"],
        name: "Core",
        region_id: "film:core",
        source_object_ids: ["film"],
        source_region_candidate_id: "film:core",
      },
    ] as never;

    expect(resolveViewport3DMeshBackedRegionKeys(regions)).toEqual(
      new Set(["film\u0000film", "film\u0000film:core"]),
    );
    expect(resolveViewport3DRegionTargetByPartId(regions)).toEqual(
      new Map([
        [
          "part:film:core",
          {
            id: "region:film:film%3Acore",
            kind: "region",
            label: "Core",
          },
        ],
      ]),
    );
  });

  it("fails closed when one mesh-backed region claims multiple source objects", () => {
    const regions = [
      {
        bounds_max: [1, 1, 1],
        bounds_min: [0, 0, 0],
        element_count: 12,
        mesh_part_ids: ["part:shared:core"],
        name: "Shared core",
        region_id: "shared:core",
        source_object_ids: ["film-a", "film-b"],
        source_region_candidate_id: "shared:core",
      },
    ] as never;

    expect(resolveViewport3DRegionTargetByPartId(regions)).toEqual(new Map());
  });

  it("keeps only mesh-backed regions in the realized overlay input", () => {
    const regions = [
      {
        owner_object_id: "film",
        region_id: "film:core",
      },
      {
        owner_object_id: "film",
        region_id: "film:edge",
      },
    ] as never;

    expect(
      filterViewport3DMeshBackedRegionOverlays(
        regions,
        new Set(["film\u0000film:core"]),
      ),
    ).toEqual([regions[0]]);
  });

  it("carries realized mesh part ids into the mesh-backed overlay input", () => {
    const authored = [
      {
        enabled: true,
        name: "Core",
        owner_object_id: "film",
        region_id: "film:core",
        shape: { center: [0, 0, 0], kind: "sphere", radius: 1 },
      },
    ] as never;

    const overlays =
      resolveViewport3DMeshBackedRegionOverlays({
        manifestRegions: [
          {
            mesh_part_ids: ["part:film:core"],
            name: "Core",
            source_object_ids: ["film"],
            source_region_candidate_id: "film:core",
          },
        ] as never,
        regions: authored,
      });

    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toMatchObject(
      {
        enabled: true,
        mesh_part_ids: ["part:film:core"],
        name: "Core",
        owner_object_id: "film",
        region_id: "film:core",
        shape: { center: [0, 0, 0], kind: "sphere", radius: 1 },
      },
    );
  });

  it("maps projected membership indices into realized mesh overlay inputs", () => {
    const authored = [
      {
        enabled: true,
        name: "Core",
        owner_object_id: "film",
        region_id: "film:core",
        shape: { center: [0, 0, 0], kind: "sphere", radius: 1 },
      },
    ] as never;

    const overlays = resolveViewport3DMembershipRegionOverlays({
      memberships: [
        {
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
        },
      ] as never,
      regions: authored,
    });

    expect(overlays.regions).toEqual([
      {
        enabled: true,
        mesh_part_ids: ["membership:film:film%3Acore"],
        name: "Core",
        owner_object_id: "film",
        region_id: "film:core",
        shape: { center: [0, 0, 0], kind: "sphere", radius: 1 },
      },
    ]);
    expect(overlays.ownerParts).toEqual([
      {
        boundary_face_indices: [0],
        element_indices: [0, 2],
        id: "membership:film:film%3Acore",
        node_indices: [0, 1, 2, 3],
        object_id: "film",
        region_id: "film:core",
      },
    ]);
  });

  it("keeps projected FEM memberships owner-qualified when region ids collide", () => {
    const overlays = resolveViewport3DMembershipRegionOverlays({
      memberships: [
        {
          boundary_face_indices: [0],
          element_indices: [0],
          mesh_id: "mesh:shared-domain",
          mesh_part_ids: [],
          mesh_revision: 41,
          node_indices: [0, 1, 2],
          owner_object_id: "film-a",
          region_id: "core",
          source: "geometry_projection",
        },
        {
          boundary_face_indices: [1],
          element_indices: [1],
          mesh_id: "mesh:shared-domain",
          mesh_part_ids: [],
          mesh_revision: 41,
          node_indices: [3, 4, 5],
          owner_object_id: "film-b",
          region_id: "core",
          source: "geometry_projection",
        },
      ] as never,
      regions: [
        {
          enabled: true,
          name: "Core A",
          owner_object_id: "film-a",
          region_id: "core",
        },
        {
          enabled: true,
          name: "Core B",
          owner_object_id: "film-b",
          region_id: "core",
        },
      ] as never,
    });

    expect(overlays.regions).toEqual([
      expect.objectContaining({
        mesh_part_ids: ["membership:film-a:core"],
        name: "Core A",
        owner_object_id: "film-a",
        region_id: "core",
      }),
      expect.objectContaining({
        mesh_part_ids: ["membership:film-b:core"],
        name: "Core B",
        owner_object_id: "film-b",
        region_id: "core",
      }),
    ]);
    expect(overlays.ownerParts).toEqual([
      expect.objectContaining({
        id: "membership:film-a:core",
        object_id: "film-a",
        region_id: "core",
      }),
      expect.objectContaining({
        id: "membership:film-b:core",
        object_id: "film-b",
        region_id: "core",
      }),
    ]);

    expect(
      resolveViewport3DRegionTargetsForMembershipOwnerParts({
        manifestRegions: [],
        ownerParts: overlays.ownerParts,
        regions: overlays.regions,
      }),
    ).toEqual(
      new Map([
        [
          "membership:film-a:core",
          { id: "region:film-a:core", kind: "region", label: "Core A" },
        ],
        [
          "membership:film-b:core",
          { id: "region:film-b:core", kind: "region", label: "Core B" },
        ],
      ]),
    );
  });

  it("indexes membership regions once while preserving carrier and target ordering", () => {
    let regionIdReads = 0;
    const regionCount = 240;
    const ownerCount = 240;
    const regions = Array.from({ length: regionCount }, (_, index) => {
      const regionId = `film:r${index}`;
      return {
        get region_id() {
          regionIdReads += 1;
          return regionId;
        },
        name: `Region ${index}`,
        owner_object_id: "film",
      };
    });
    const ownerParts = Array.from({ length: ownerCount }, (_, index) => ({
      id: `membership:film:${encodeURIComponent(`film:r${index}`)}`,
      object_id: "film",
      region_id: `film:r${index}`,
    }));

    const targets = resolveViewport3DRegionTargetsForMembershipOwnerParts({
      manifestRegions: [
        {
          mesh_part_ids: ["mesh-backed-first"],
          name: "Mesh-backed first",
          source_object_ids: ["film"],
          source_region_candidate_id: "film:mesh-backed-first",
        },
      ] as never,
      ownerParts: ownerParts as never,
      regions: regions as never,
    });

    expect(Array.from(targets.entries()).slice(0, 3)).toEqual([
      [
        "mesh-backed-first",
        {
          id: "region:film:film%3Amesh-backed-first",
          kind: "region",
          label: "Mesh-backed first",
        },
      ],
      [
        "membership:film:film%3Ar0",
        {
          id: "region:film:film%3Ar0",
          kind: "region",
          label: "Region 0",
        },
      ],
      [
        "membership:film:film%3Ar1",
        {
          id: "region:film:film%3Ar1",
          kind: "region",
          label: "Region 1",
        },
      ],
    ]);
    expect(targets.size).toBe(regionCount + 1);
    expect(regionIdReads).toBeLessThanOrEqual(regionCount + 1);
  });

  it("requests memberships for all non-mesh-backed authored region overlays", () => {
    expect(
      resolveViewport3DRegionMembershipIds({
        meshBackedRegionKeys: new Set(["film\u0000film:mesh-backed"]),
        regions: [
          {
            owner_object_id: "film",
            region_id: "film:core",
          },
          {
            owner_object_id: "film",
            region_id: "film:edge",
          },
          {
            owner_object_id: "film",
            region_id: "film:core",
          },
          {
            owner_object_id: "film",
            region_id: "film:mesh-backed",
          },
          {
            owner_object_id: null,
            region_id: "film:missing-owner",
          },
        ] as never,
      }),
    ).toEqual(["film:core", "film:edge"]);
  });

  it("inherits owner passes for mesh-backed regions except sparse overrides", () => {
    const visualization = new ObjectVisualizationController();
    const part = {
      id: "part:film:core",
      label: "Core",
      object_id: "film",
    } as never;
    const regionTarget = {
      id: "region:film:film%3Acore",
      kind: "region" as const,
    };
    visualization.patchTarget(
      { id: "object:film", kind: "object" },
      {
        shaderVisible: false,
        vectorsVisible: true,
        wireframeVisible: true,
      },
    );
    visualization.patchTarget(regionTarget, { wireframeVisible: false });

    expect(
      resolveViewport3DPartVisualizationSettings({
        objectVisualizationSnapshot: visualization.getSnapshot(),
        part,
        regionTarget,
        sceneObjectIds: new Set(["film"]),
      }),
    ).toMatchObject({
      shaderVisible: false,
      vectorsVisible: true,
      visible: true,
      wireframeVisible: false,
    });
  });

  it("keeps prefixed transport scope while normalizing the semantic part target once", () => {
    const visualization = new ObjectVisualizationController();
    const carrierPartId = "part:part-film";
    const renderingState = {
      targets: {
        airbox: {},
        objects: [],
        parts: [{ scope: "part", scope_id: carrierPartId }],
      },
    } as never;
    const resolved = resolveViewport3DResolvedPartFieldBuffers({
      getPartSettings: () => ({
        ...DEFAULT_OBJECT_VISUALIZATION,
        activeQuantityId: "H_eff",
        shaderVisible: true,
        visible: true,
      }),
      magneticPartFieldQueries: new Map([
        [
          carrierPartId,
          {
            quantityId: "H_eff",
            query: {
              component: "full",
              scope_id: carrierPartId,
              scope_kind: "part",
            },
          },
        ],
      ]),
      magneticPartFieldVectors: new Map([
        [carrierPartId, fieldVectorFixture({ quantityId: "H_eff" })],
      ]),
      topology: {
        airboxParts: [],
        magneticParts: [{ part: { id: carrierPartId, label: "Film" } }],
        nodeCount: 4,
      } as never,
    });

    expect(resolved.partTargetFieldBuffers.get(carrierPartId)).toMatchObject({
      resourceKey: fieldVectorResourceKey("H_eff", {
        component: "full",
        scope_id: carrierPartId,
        scope_kind: "part",
      }),
      scopeId: carrierPartId,
    });

    expect(
      resolveViewport3DPartVisualizationSettings({
        objectVisualizationSnapshot: visualization.getSnapshot(),
        part: {
          geometry_id: "projection-film",
          id: carrierPartId,
          object_id: null,
        } as never,
        renderingState,
        sceneObjectIds: new Set(),
      }).target,
    ).toMatchObject({ id: "part-film", kind: "part" });
  });

  it("applies backend region overrides to mesh-backed region parts", () => {
    const visualization = new ObjectVisualizationController();
    const part = {
      id: "part:film:core",
      label: "Core",
      object_id: "film",
    } as never;
    const regionTarget = {
      id: "region:film:film%3Acore",
      kind: "region" as const,
    };
    visualization.patchTarget(
      { id: "object:film", kind: "object" },
      {
        activeQuantityId: "m",
        shaderVisible: true,
        surfaceColorSource: "component_x",
        visible: true,
      },
    );

    expect(
      resolveViewport3DPartVisualizationSettings({
        objectVisualizationSnapshot: visualization.getSnapshot(),
        part,
        regionTarget,
        renderingState: {
          overrides: [
            {
              display: {
                surface: { visible: true },
                visible: false,
              },
              quantity: { active_quantity_id: "H_eff" },
              scope: "region",
              scope_id: "region:film:film%3Acore",
            },
          ],
        } as never,
      }),
    ).toMatchObject({
      activeQuantityId: "H_eff",
      shaderVisible: false,
      visible: false,
    });
  });

  it("allows an explicit region visibility override when its owner is hidden", () => {
    const visualization = new ObjectVisualizationController();
    const part = {
      geometry_id: "periodic_antidot_film:r1",
      id: "part:periodic_antidot_film:r1",
      label: "periodic_antidot_film:r1",
      object_id: "periodic_antidot_film",
    } as never;
    const regionTarget = {
      id: "region:periodic_antidot_film:periodic_antidot_film%3Ar1",
      kind: "region" as const,
    };
    visualization.patchTarget(
      { id: "object:periodic_antidot_film", kind: "object" },
      { visible: false },
    );
    visualization.patchTarget(regionTarget, {
      shaderVisible: true,
      visible: true,
      wireframeVisible: false,
    });

    expect(
      resolveViewport3DPartVisualizationSettings({
        objectVisualizationSnapshot: visualization.getSnapshot(),
        part,
        regionTarget,
        sceneObjectIds: new Set(["periodic_antidot_film"]),
      }),
    ).toMatchObject({
      shaderVisible: true,
      visible: true,
      wireframeVisible: false,
    });
  });

  it("applies region component color overrides to mesh-backed part render plans", () => {
    const visualization = new ObjectVisualizationController();
    const part = {
      id: "part:film:core",
      label: "Core",
      object_id: "film",
    } as never;
    const regionTarget = {
      id: "region:film:film%3Acore",
      kind: "region" as const,
    };
    visualization.patchTarget(
      { id: "object:film", kind: "object" },
      {
        activeQuantityId: "m",
        shaderVisible: true,
        surfaceColorSource: "orientation",
        visible: true,
      },
    );
    visualization.patchTarget(regionTarget, {
      activeQuantityId: "m",
      shaderVisible: true,
      surfaceColorSource: "component_z",
      visible: true,
    });

    const regionSettings = resolveViewport3DPartVisualizationSettings({
      objectVisualizationSnapshot: visualization.getSnapshot(),
      part,
      regionTarget,
    });
    const options = resolveViewport3DPrimaryFieldRenderOptions({
      fieldRenderOptions: {
        fullVectorBudget: 0,
        partVectorBudgets: new Map(),
        scalarColorModes: new Set(),
        scalarColorPalette: "viridis",
        scalarColorsVisible: false,
      },
      getPartSettings: () => regionSettings,
      magneticParts: [{ part }],
      quantityId: "m",
      vectorDomain: "auto",
    });

    expect(options.partScalarColorModes?.get("part:film:core")).toBe("z");
    expect(options.targetRenderPlans?.get("part:film:core")).toMatchObject({
      quantityId: "m",
      shader: {
        scalarColorMode: "z",
        surfaceColorSource: "component_z",
        visible: true,
      },
    });
  });

  it("inherits owner visualization for an unconfigured mesh-backed region", () => {
    const visualization = new ObjectVisualizationController();
    const part = {
      id: "part:film:core",
      label: "Core",
      object_id: "film",
    } as never;

    expect(
      resolveViewport3DPartVisualizationSettings({
        objectVisualizationSnapshot: visualization.getSnapshot(),
        part,
        regionTarget: {
          id: "region:film:film%3Acore",
          kind: "region",
        },
      }),
    ).toMatchObject({
      shaderVisible: true,
      visible: true,
      wireframeVisible: false,
    });
  });

  it("resolves selected region bounds from region overlays instead of whole object bounds", () => {
    expect(
      resolveViewport3DRegionSelectionBounds(
        {
          kind: "object.region.visualization",
          label: "Core",
          moduleSource: "explorer",
          nodeId: "node-region",
          objectId: "film",
          ref: {
            kind: "object.region.visualization",
            nodeId: "node-region",
            objectId: "film",
            regionId: "film:r1",
            type: "scene-object",
            visualizationTargetId: "region:film:film%3Ar1",
          },
        },
        [
          {
            enabled: true,
            frame: "object",
            name: "core",
            owner_object_id: "film",
            owner_transform: { translation: [1, 2, 3] },
            region_id: "film:r1",
            shape: {
              axis: [0, 0, 1],
              center: [0.5, 0, 0],
              height: 2,
              kind: "cylinder",
              radius: 4,
            },
          },
        ],
      ),
    ).toEqual({
      center: [1.5, 2, 3],
      radius: expect.closeTo(Math.hypot(8, 8, 2) / 2),
      size: [8, 8, 2],
    });
  });

  it("prefers canonical visualization quantity over stale compatibility state", () => {
    expect(
      resolveViewport3DVisualizationQuantityId({
        active_quantity_id: "H_demag",
        quantity: {
          active_quantity_id: "m",
        },
      } as never),
    ).toBe("m");
  });

  it("compares target quantities by canonical identity", () => {
    expect(sameViewport3DQuantityId("h_eff", "H_eff")).toBe(true);
    expect(sameViewport3DQuantityId("h_demag", "H_eff")).toBe(false);
  });

  it("keeps canonical-equivalent target quantities on the primary render path", () => {
    const primaryOptions = resolveViewport3DPrimaryFieldRenderOptions({
      fieldRenderOptions: {
        fullVectorBudget: 0,
        partVectorBudgets: new Map(),
        scalarColorModes: new Set(),
        scalarColorsVisible: false,
      },
      getPartSettings: () =>
        ({
          activeQuantityId: "h_eff",
          shaderVisible: true,
          surfaceColorSource: "magnitude",
          vectorBudget: 256,
          vectorsVisible: true,
          visible: true,
        }) as never,
      magneticParts: [{ part: { id: "part:free-layer" } }] as never,
      quantityId: "H_eff",
      vectorDomain: "auto",
    });

    expect(primaryOptions.scalarColorModes).toEqual(new Set(["magnitude"]));
    expect(primaryOptions.partVectorBudgets).toEqual(
      new Map([["part:free-layer", 256]]),
    );
  });

  it("keeps full field vectors when glyphs or orientation colors need vector components", () => {
    expect(
      resolveViewport3DPrimaryFieldQuery({
        fdmInstanceModelNeedsFieldVector: false,
        fdmSurfaceColorMode: null,
        fdmTopographyEnabled: false,
        fdmVectorsVisible: false,
        fieldRenderOptions: {
          fullVectorBudget: 256,
          scalarColorModes: new Set(["magnitude"]),
          scalarColorsVisible: true,
        },
      }),
    ).toEqual({
      component: "full",
      scope_kind: "full",
    });
    expect(
      resolveViewport3DPrimaryFieldQuery({
        fdmInstanceModelNeedsFieldVector: false,
        fdmSurfaceColorMode: null,
        fdmTopographyEnabled: false,
        fdmVectorsVisible: false,
        fieldRenderOptions: {
          fullVectorBudget: 0,
          partVectorBudgets: new Map(),
          scalarColorModes: new Set(["orientation"]),
          scalarColorsVisible: true,
        },
      }),
    ).toEqual({
      component: "full",
      scope_kind: "full",
    });
  });

  it("keeps target surface field queries full-vector across color projections", () => {
    expect(
      resolveViewport3DTargetFieldQuery({
        surfaceColorMode: null,
        vectorsVisible: false,
      }),
    ).toBeNull();
    expect(
      resolveViewport3DTargetFieldQuery({
        surfaceColorMode: "x",
        vectorsVisible: false,
      }),
    ).toEqual({
      component: "full",
      scope_kind: "full",
    });
    expect(
      resolveViewport3DTargetFieldQuery({
        surfaceColorMode: "orientation",
        vectorsVisible: false,
      }),
    ).toEqual({
      component: "full",
      scope_kind: "full",
    });
    expect(
      resolveViewport3DTargetFieldQuery({
        surfaceColorMode: "magnitude",
        vectorsVisible: true,
      }),
    ).toEqual({
      component: "full",
      scope_kind: "full",
    });
  });

  it("adds sample limits only for scoped vector-only field queries", () => {
    expect(
      resolveViewport3DScopedVectorFieldQuery({
        geometryScope: "full",
        maxSamples: 384,
        surfaceColorMode: null,
        vectorsVisible: true,
      }),
    ).toEqual({
      component: "full",
      max_samples: 384,
      scope_kind: "full",
    });
    expect(
      resolveViewport3DScopedVectorFieldQuery({
        geometryScope: "full",
        maxSamples: 384,
        surfaceColorMode: "magnitude",
        vectorsVisible: true,
      }),
    ).toEqual({
      component: "full",
      scope_kind: "full",
    });
  });

  it("does not let scoped airbox vectors force a full-domain primary field request", () => {
    const primaryOptions = resolveViewport3DPrimaryFieldRenderOptions({
      fieldRenderOptions: {
        fullVectorBudget: 0,
        partVectorBudgets: new Map([["part:__air__", 1024]]),
        scalarColorModes: new Set(["orientation"]),
        scalarColorsVisible: true,
      },
      getPartSettings: () =>
        ({
          activeQuantityId: "m",
          shaderVisible: true,
          surfaceColorSource: "magnitude",
          vectorBudget: 256,
          vectorsVisible: true,
          visible: true,
        }) as never,
      magneticParts: [
        {
          part: { id: "part:arch_waveguide" },
        },
      ] as never,
      quantityId: "h_demag",
      vectorDomain: "auto",
    });

    expect(primaryOptions.partVectorBudgets).toEqual(
      new Map([
        ["part:__air__", 1024],
        ["part:arch_waveguide", 256],
      ]),
    );
    const primaryDataOptions = resolveViewport3DPrimaryFieldDataOptions(
      primaryOptions,
      new Set(["part:__air__", "part:arch_waveguide"]),
    );

    expect(viewport3DFieldRenderOptionsNeedFieldData(primaryDataOptions)).toBe(false);
    expect(resolveViewport3DPrimaryFieldQuery({
      fdmInstanceModelNeedsFieldVector: false,
      fdmSurfaceColorMode: null,
      fdmTopographyEnabled: false,
      fdmVectorsVisible: false,
      fieldRenderOptions: primaryDataOptions,
    })).toEqual({
      component: "full",
      scope_kind: "full",
    });
  });

  it("builds airbox target buffers from the planned airbox request query", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("const airboxFieldDemandPlan = useMemo(");
    expect(source).toContain("resolveViewport3DAirboxFieldVectorDemandPlan({");
    expect(source).toContain(
      "const airboxFieldVectorRequests = airboxFieldDemandPlan.requests;",
    );
    expect(source).toContain("airboxFieldVectorRequests?.get(partId)");
    expect(source).toContain("query: request.query");
    expect(source).not.toContain(
      "query: resolveViewport3DAirboxFieldVectorQuery({\n                ...airboxFieldQuery,\n                scope_id: partId,\n              }),",
    );
  });

  it("derives primary field resource keys and loads from the primary request object", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("const primaryFieldDemandPlan = useMemo");
    expect(source).toContain("resolveViewport3DPrimaryFieldDemandPlan({");
    expect(source).toContain("const primaryFieldRequest = primaryFieldDemandPlan.request;");
    expect(source).toContain(
      "resolveViewport3DFieldVectorRequestResourceKey(primaryFieldRequest)",
    );
    expect(source).toContain("useViewport3DFieldVectorRequest(");
    expect(source).toContain("primaryFieldRequest,");
  });

  it("keeps vector-only magnetic parts on scoped sampled field requests", () => {
    const part = { id: "part:arch_waveguide" };
    const scopedRequests = resolveViewport3DScopedPartVectorFieldRequests({
      getPartSettings: () =>
        ({
          activeQuantityId: "m",
          shaderVisible: false,
          surfaceColorSource: "magnitude",
          vectorBudget: 512,
          vectorsVisible: true,
          visible: true,
        }) as never,
      maxVectorGlyphs: 2048,
      magneticParts: [{ part }] as never,
      vectorDomain: "auto",
    });

    expect(scopedRequests.get("part:arch_waveguide")).toMatchObject({
      quantityId: "m",
      query: {
        component: "full",
        max_samples: 512,
        scope_id: "part:arch_waveguide",
        scope_kind: "part",
      },
    });

    const primaryOptions = resolveViewport3DPrimaryFieldRenderOptions({
      fieldRenderOptions: {
        fullVectorBudget: 0,
        partVectorBudgets: new Map([["part:arch_waveguide", 512]]),
        scalarColorModes: new Set(),
        scalarColorsVisible: false,
      },
      getPartSettings: () =>
        ({
          activeQuantityId: "m",
          shaderVisible: false,
          surfaceColorSource: "magnitude",
          vectorBudget: 512,
          vectorsVisible: true,
          visible: true,
        }) as never,
      magneticParts: [{ part }] as never,
      quantityId: "m",
      vectorDomain: "auto",
    });

    expect(primaryOptions.partVectorBudgets).toEqual(
      new Map([["part:arch_waveguide", 512]]),
    );

    const primaryDataOptions = resolveViewport3DPrimaryFieldDataOptions(
      primaryOptions,
      new Set(["part:arch_waveguide"]),
    );

    expect(primaryDataOptions.partVectorBudgets).toEqual(new Map());
    expect(viewport3DFieldRenderOptionsNeedFieldData(primaryDataOptions)).toBe(
      false,
    );
  });

  it("returns scoped magnetic part requests with planner identity and consumers", () => {
    const scopedRequests = resolveViewport3DScopedPartVectorFieldRequests({
      getPartSettings: () =>
        ({
          activeQuantityId: "m",
          shaderVisible: true,
          surfaceColorSource: "component_y",
          vectorBudget: 512,
          vectorsVisible: true,
          visible: true,
        }) as never,
      maxVectorGlyphs: 2048,
      magneticParts: [{ part: { id: "part:free-layer" } }] as never,
      selectedSnapshotQuery: {
        snapshot_id: "hysteresis_point_009",
        stage_id: "hysteresis-1",
      },
      vectorDomain: "auto",
    });
    const request = scopedRequests.get("part:free-layer");

    expect(request?.consumers).toEqual([
      "part:free-layer:surface",
      "part:free-layer:vector-glyph",
    ]);
    expect(request?.requestId).toContain("quantity=m");
    expect(request?.requestId).toContain("component=full");
    expect(request?.requestId).toContain("scope_id=part:free-layer");
    expect(request?.requestId).toContain("scope_kind=part");
    expect(request?.requestId).toContain("snapshot_id=hysteresis_point_009");
    expect(request?.requestId).toContain("stage_id=hysteresis-1");
  });

  it("keeps vector-only airbox planned requests aligned with query semantics", () => {
    const airboxPlan = resolveViewport3DAirboxFieldVectorDemandPlan({
      airboxParts: [{ id: "part:__air__" }],
      fieldQuery: {
        component: "full",
        max_samples: 1200,
        scope_kind: "airbox",
      },
      quantityId: "H_eff",
      shaderVisible: true,
      surfaceColorSource: "component_x",
      vectorsVisible: true,
    });
    const request = airboxPlan.requests.get("part:__air__");

    expect(request?.query).toEqual({
      component: "full",
      max_samples: 1200,
      scope_id: "part:__air__",
      scope_kind: "airbox",
    });
    const resourceKey = resolveViewport3DFieldVectorResourceKey(
      "H_eff",
      request!.query,
    );
    const resourceQuery = new URLSearchParams(resourceKey.split("?")[1] ?? "");
    expect(resourceQuery.get("component")).toBe("full");
    expect(resourceQuery.get("max_samples")).toBe("1200");
    expect(resourceQuery.get("scope_id")).toBe("part:__air__");
    expect(resourceQuery.get("scope_kind")).toBe("airbox");
    expect(request?.requestId).toContain("component=full");
    expect(request?.requestId).toContain("max_samples=1200");
  });

  it("keeps scoped magnetic and airbox field demands available for diagnostics", () => {
    const scopedPlan = resolveViewport3DScopedPartVectorFieldDemandPlan({
      getPartSettings: () =>
        ({
          activeQuantityId: "m",
          shaderVisible: true,
          surfaceColorSource: "component_y",
          vectorBudget: 512,
          vectorsVisible: true,
          visible: true,
        }) as never,
      maxVectorGlyphs: 2048,
      magneticParts: [{ part: { id: "part:free-layer" } }] as never,
      selectedSnapshotQuery: {
        snapshot_id: "hysteresis_point_009",
        stage_id: "hysteresis-1",
      },
      vectorDomain: "auto",
    });
    const airboxPlan = resolveViewport3DAirboxFieldVectorDemandPlan({
      airboxParts: [{ id: "part:__air__" }],
      fieldQuery: {
        component: "full",
        max_samples: 1200,
        scope_kind: "airbox",
      },
      quantityId: "H_eff",
      replayQuery: {
        snapshot_id: "hysteresis_point_009",
        stage_id: "hysteresis-1",
      },
    });

    const diagnostics = summarizeViewport3DFieldDemandDiagnostics({
      demands: [...scopedPlan.demands, ...airboxPlan.demands],
      requests: [
        ...scopedPlan.requests.values(),
        ...Array.from(airboxPlan.requests.values(), (request) => ({
          consumers: request.consumers ?? [],
          query: request.query,
          quantityId: request.quantityId,
          requestId: request.requestId,
        })),
      ],
    });

    expect(scopedPlan.demands.map((demand) => demand.passKind)).toEqual([
      "surface",
      "vector-glyph",
    ]);
    expect(airboxPlan.demands.map((demand) => demand.passKind)).toEqual([
      "vector-glyph",
    ]);
    expect(diagnostics).toEqual([
      {
        demands: [
          "vector-glyph:full:sampled-ok max_samples=1200",
        ],
        requests: [
          "quantity=H_eff component=full scope=airbox:part:__air__ max_samples=1200 snapshot_id=hysteresis_point_009 stage_id=hysteresis-1 consumers=part:__air__:vector-glyph",
        ],
        targetId: "part:__air__",
      },
      {
        demands: [
          "surface:full:complete",
          "vector-glyph:full:complete",
        ],
        requests: [
          "quantity=m component=full scope=part:part:free-layer snapshot_id=hysteresis_point_009 stage_id=hysteresis-1 consumers=part:free-layer:surface,part:free-layer:vector-glyph",
        ],
        targetId: "part:free-layer",
      },
    ]);
  });

  it("keeps scoped surface demands when scalar aggregate sharing removes per-part requests", () => {
    const scopedPlan = resolveViewport3DScopedPartVectorFieldDemandPlan({
      getPartSettings: () =>
        ({
          activeQuantityId: "m",
          shaderVisible: true,
          surfaceColorSource: "component_x",
          vectorBudget: 0,
          vectorsVisible: false,
          visible: true,
        }) as never,
      maxVectorGlyphs: 2048,
      magneticParts: [
        { part: { id: "part:free-layer" } },
        { part: { id: "part:ring" } },
      ] as never,
      selectedSnapshotQuery: null,
      vectorDomain: "auto",
    });

    expect(scopedPlan.requests.size).toBe(0);
    expect(scopedPlan.demands.map((demand) => demand.passId)).toEqual([
      "part:free-layer:surface",
      "part:ring:surface",
    ]);
    expect(scopedPlan.demands.map((demand) => demand.component)).toEqual([
      "full",
      "full",
    ]);
  });

  it("uses one complete full-vector scoped request for component-colored magnetic parts with vectors", () => {
    const part = { id: "part:arch_waveguide" };
    const scopedRequests = resolveViewport3DScopedPartVectorFieldRequests({
      getPartSettings: () =>
        ({
          activeQuantityId: "m",
          shaderVisible: true,
          surfaceColorSource: "component_x",
          vectorBudget: 512,
          vectorsVisible: true,
          visible: true,
        }) as never,
      maxVectorGlyphs: 2048,
      magneticParts: [{ part }] as never,
      vectorDomain: "auto",
    });

    expect(scopedRequests.get("part:arch_waveguide")).toMatchObject({
      quantityId: "m",
      query: {
        component: "full",
        scope_id: "part:arch_waveguide",
        scope_kind: "part",
      },
    });
    expect(scopedRequests.get("part:arch_waveguide")?.query)
      .not.toHaveProperty("max_samples");
  });

  it("keeps component-colored magnetic parts on scoped full-vector field requests", () => {
    const part = { id: "part:arch_waveguide" };
    const scopedRequests = resolveViewport3DScopedPartVectorFieldRequests({
      getPartSettings: () =>
        ({
          activeQuantityId: "m",
          shaderVisible: true,
          surfaceColorSource: "component_x",
          vectorBudget: 0,
          vectorsVisible: false,
          visible: true,
        }) as never,
      maxVectorGlyphs: 2048,
      magneticParts: [{ part }] as never,
      vectorDomain: "auto",
    });

    expect(scopedRequests.get("part:arch_waveguide")).toMatchObject({
      quantityId: "m",
      query: {
        component: "full",
        scope_id: "part:arch_waveguide",
        scope_kind: "part",
      },
    });

    const primaryOptions = resolveViewport3DPrimaryFieldRenderOptions({
      fieldRenderOptions: {
        fullVectorBudget: 0,
        partVectorBudgets: new Map([["part:arch_waveguide", 512]]),
        scalarColorModes: new Set(),
        scalarColorsVisible: false,
      },
      getPartSettings: () =>
        ({
          activeQuantityId: "m",
          shaderVisible: true,
          surfaceColorSource: "component_x",
          vectorBudget: 0,
          vectorsVisible: false,
          visible: true,
        }) as never,
      magneticParts: [{ part }] as never,
      quantityId: "m",
      vectorDomain: "auto",
    });
    expect(primaryOptions.scalarColorsVisible).toBe(true);
    expect(primaryOptions.scalarColorModes).toEqual(new Set(["x"]));
    expect(primaryOptions.partScalarColorModes?.get("part:arch_waveguide")).toBe(
      "x",
    );
    expect(primaryOptions.partVectorBudgets).toEqual(new Map());
  });

  it("keeps all visible scalar-colored magnetic parts on one aggregate field request", () => {
    const scopedRequests = resolveViewport3DScopedPartVectorFieldRequests({
      getPartSettings: () =>
        ({
          activeQuantityId: "m",
          shaderVisible: true,
          surfaceColorSource: "magnitude",
          vectorBudget: 0,
          vectorsVisible: false,
          visible: true,
        }) as never,
      maxVectorGlyphs: 2048,
      magneticParts: [
        { part: { id: "part:a" } },
        { part: { id: "part:b" } },
      ] as never,
      vectorDomain: "auto",
    });

    expect(scopedRequests).toEqual(new Map());
  });

  it("does not let scalar aggregate sharing suppress vectors on one matching part", () => {
    const scopedRequests = resolveViewport3DScopedPartVectorFieldRequests({
      getPartSettings: (part) =>
        ({
          activeQuantityId: "m",
          shaderVisible: true,
          surfaceColorSource: "component_x",
          vectorBudget: part.id === "part:a" ? 512 : 0,
          vectorsVisible: part.id === "part:a",
          visible: true,
        }) as never,
      maxVectorGlyphs: 2048,
      magneticParts: [
        { part: { id: "part:a" } },
        { part: { id: "part:b" } },
      ] as never,
      vectorDomain: "auto",
    });

    expect(scopedRequests.get("part:a")).toMatchObject({
      quantityId: "m",
      query: {
        component: "full",
        scope_id: "part:a",
        scope_kind: "part",
      },
    });
    expect(scopedRequests.get("part:a")?.query)
      .not.toHaveProperty("max_samples");
  });

  it("keeps scalar-colored subsets on scoped field requests", () => {
    const scopedRequests = resolveViewport3DScopedPartVectorFieldRequests({
      getPartSettings: (part) =>
        ({
          activeQuantityId: "m",
          shaderVisible: part.id === "part:a",
          surfaceColorSource:
            part.id === "part:a" ? "magnitude" : "solid",
          vectorBudget: 0,
          vectorsVisible: false,
          visible: true,
        }) as never,
      maxVectorGlyphs: 2048,
      magneticParts: [
        { part: { id: "part:a" } },
        { part: { id: "part:b" } },
      ] as never,
      vectorDomain: "auto",
    });

    expect(scopedRequests.get("part:a")).toMatchObject({
      quantityId: "m",
      query: {
        component: "full",
        scope_id: "part:a",
        scope_kind: "part",
      },
    });
  });

  it("does not request field data for solid-colored magnetic parts", () => {
    const scopedRequests = resolveViewport3DScopedPartVectorFieldRequests({
      getPartSettings: () =>
        ({
          activeQuantityId: "m",
          shaderVisible: true,
          surfaceColorSource: "solid",
          vectorBudget: 512,
          vectorsVisible: false,
          visible: true,
        }) as never,
      maxVectorGlyphs: 2048,
      magneticParts: [{ part: { id: "part:solid" } }] as never,
      vectorDomain: "auto",
    });

    expect(scopedRequests).toEqual(new Map());
  });

  it("caps scoped vector-only requests to the interactive glyph budget", () => {
    const scopedRequests = resolveViewport3DScopedPartVectorFieldRequests({
      getPartSettings: () =>
        ({
          activeQuantityId: "m",
          shaderVisible: false,
          surfaceColorSource: "magnitude",
          vectorBudget: 48_461,
          vectorsVisible: true,
          visible: true,
        }) as never,
      maxVectorGlyphs: 2048,
      magneticParts: [{ part: { id: "part:arch_waveguide" } }] as never,
      vectorDomain: "auto",
    });

    expect(scopedRequests.get("part:arch_waveguide")?.query).toEqual({
      component: "full",
      max_samples: 2048,
      scope_id: "part:arch_waveguide",
      scope_kind: "part",
    });
  });

  it("feeds every visible FDM and FEM vector carrier through the global allocator", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");
    const allocationBlock = source.slice(
      source.indexOf("const fdmTargetVectorAllocations ="),
      source.indexOf("const fdmTargetViews: "),
    );

    expect(allocationBlock).toContain("fdmTargetViewsResult");
    expect(allocationBlock).toContain("fdmNativeLayerDomains");
    expect(allocationBlock).toContain("fdmMultilayerAirboxDomain");
    expect(allocationBlock).toContain("fieldCompatibleTopologyRenderModel");
    expect(allocationBlock).toContain('targetId: `fdm-target:${view.target.id}`');
    expect(allocationBlock).toContain('targetId: "fdm-airbox"');
    expect(allocationBlock).toContain('targetId: `fdm-native:${domain.layerId}`');
    expect(allocationBlock).toContain('targetId: "fdm-multilayer-airbox"');
    expect(allocationBlock).toContain(
      'targetId: `fem-part:${partModel.part.id}`',
    );
    expect(allocationBlock).toContain(
      "resolveViewport3DGlobalVectorAllocation(",
    );
    expect(source).toContain(
      "const globalFieldRenderOptionsWithPrimaryTargetBuffers = useMemo(",
    );
    expect(source).toContain(
      "applyViewport3DGlobalVectorAllocationsToFieldRenderOptions(",
    );
    expect(source).toContain(
      "fieldRenderOptions: globalFieldRenderOptionsWithPrimaryTargetBuffers",
    );
  });

  it("consumes visualization resources separately from the camera registry", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain(
      'import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";',
    );
    expect(source).toContain(
      'import { useCameraRegistryCamera } from "@/kernel/visualization/useCameraRegistry";',
    );
    expect(source).toContain("const visualizationState = useVisualizationStateResource();");
    expect(source).toContain("const cameraRegistryCamera = useCameraRegistryCamera();");
    expect(source).toContain("const cameraView = resolveViewport3DSceneCameraView({");
    expect(source).toContain("const cameraResource = cameraView.cameraResource;");
    expect(source).not.toContain("useViewport3DVisualizationState");
  });

  it("subscribes to camera registry camera data without rendering on interactionActive flips", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("useCameraRegistryCamera()");
    expect(source).not.toContain("useCameraRegistrySnapshot()");
    expect(source).not.toContain("interactionActive: cameraView.interactionActive");
    expect(source).not.toContain("resolveCommittedViewport3DFieldVector({");
  });

  it("observes backend camera state in the kernel registry without remote camera overwrite logic in the scene model", () => {
    const sceneModelSource = readFileSync(sceneModelSourceUrl, "utf8");
    const visualizationStateResourceSource = readFileSync(
      visualizationStateResourceSourceUrl,
      "utf8",
    );

    expect(visualizationStateResourceSource).toContain(
      "cameraRegistry.observeRemoteState(resource.data);",
    );
    expect(sceneModelSource).not.toContain("hasUnsatisfiedCameraPatch");
    expect(sceneModelSource).not.toContain("useViewport3DRemoteCameraSync");
  });

  it("surfaces field-vector load failures as explicit viewport issues", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("fieldDataIssue");
    expect(source).toContain("fieldVectorEnabled && fieldVector.error");
    expect(source).toContain("resolveViewport3DFieldVectorRequestResourceKey");
  });

  it("surfaces a retryable issue when an enabled field is settled without a payload", () => {
    const retry = () => undefined;
    const resourceKey = fieldVectorResourceRef("m", "full", "current");

    expect(
      resolveViewport3DFieldDataIssue({
        fieldVectorDataAvailable: false,
        fieldVectorEnabled: true,
        fieldVectorErrorMessage: null,
        fieldVectorRefetch: retry,
        fieldVectorResourceKey: resourceKey,
        fieldVectorRevision: null,
        fieldVectorStatus: "ready",
        hysteresisReplayMeshCompatibility: {
          actualMeshIdentity: null,
          reason: null,
          requiredMeshIdentity: null,
          status: "compatible",
        },
        primaryFieldQuantityId: "m",
      }),
    ).toEqual({
      key: `${resourceKey}:none:not-materialized`,
      message:
        "Field vector is not materialized for the selected quantity. Retry to request it again.",
      quantityId: "m",
      resourceKey,
      retry,
    });
  });

  it("blocks hysteresis 3D replay field loads on mesh identity mismatch", () => {
    const retry = () => undefined;

    expect(
      resolveViewport3DFieldDataIssue({
        fieldVectorEnabled: false,
        fieldVectorErrorMessage: null,
        fieldVectorRefetch: retry,
        fieldVectorResourceKey: fieldVectorResourceRef(
          "m",
          "hysteresis_point_005",
          "hysteresis-1",
        ),
        fieldVectorRevision: null,
        hysteresisReplayMeshCompatibility: {
          actualMeshIdentity: "study_domain:rev-13",
          reason:
            "Snapshot was computed on mesh study_domain:rev-12, but the current 3D topology is study_domain:rev-13.",
          requiredMeshIdentity: "study_domain:rev-12",
          status: "mismatch",
        },
        primaryFieldQuantityId: "m",
      }),
    ).toEqual({
      key:
        `${fieldVectorResourceRef(
          "m",
          "hysteresis_point_005",
          "hysteresis-1",
        )}:mesh-mismatch:study_domain:rev-12:study_domain:rev-13`,
      message:
        "Snapshot was computed on mesh study_domain:rev-12, but the current 3D topology is study_domain:rev-13.",
      quantityId: "m",
      resourceKey: fieldVectorResourceRef(
        "m",
        "hysteresis_point_005",
        "hysteresis-1",
      ),
      retry,
    });
  });

  it("loads airbox field data through scoped airbox requests instead of full-domain target requests", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain(
      "const airboxFieldVectorEnabled =\n    airboxVectorsVisible && !airboxSettings.airboxSyntheticVectorsEnabled;",
    );
    expect(source).toContain("surfaceColorMode: null");
    expect(source).not.toContain("airboxSurfaceColorMode");
    expect(source).toContain("useViewport3DAirboxFieldVectors(");
    expect(source).not.toContain("ids.add(airboxSettings.activeQuantityId)");
  });

  it("gates FDM field demands and metadata on catalog availability", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain(
      "domainMeta.data?.discretization === \"fem\"",
    );
    expect(source).toContain(
      "const availableQuantityIdsForPlanning = fdmLaneActive",
    );
    expect(source).toContain(
      "availableQuantityIds: availableQuantityIdsForPlanning",
    );
    const metadataBlock = source.slice(
      source.indexOf("const primaryFieldMetaEnabled ="),
      source.indexOf("const primaryMagnitudeFieldMeta ="),
    );
    expect(metadataBlock).toContain("viewport3DFieldQuantityAvailable");
  });

  it("keeps cross-section draft previews separate from the canonical clip resource path", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("activeCrossSectionFramePreview");
    expect(source).toContain("crossSectionFramePreviewToClip");
    expect(source).toContain("enabled: Boolean(renderingState?.clip?.enabled && topologyCurrent)");
    expect(source).toContain("crossSectionFrameClip");
    expect(source).toContain("clipFrameRotationDegrees: 0");
  });

  it("adapts the canonical planar monitor draft into the existing 3D frame renderer input", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");
    const adapter = readFileSync(planarPreviewSourceUrl, "utf8");

    expect(source).toContain("state.planarMonitorDraft");
    expect(source).toContain("planarMonitorFramePreviewFromDraft");
    expect(adapter).toContain("operator: draft.monitor.operator");
    expect(source).toContain("planarMonitorFramePreview,");
  });

  it("uses the committed camera registry snapshot for live scene rendering", () => {
    const commandState = {
      camera: {
        position: [3, 2, 1],
        target: [0.5, 0.25, 0],
        up: [0, 0, 1],
      },
      widgets: {
        cameraOrthographicScale: 4e-6,
        cameraProjection: "perspective",
      },
    } as Pick<Viewport3DCommandState, "camera" | "widgets">;
    const registryCamera = {
      ...DEFAULT_CAMERA_REGISTRY_STATE,
      position: DEFAULT_VIEWPORT_3D_CAMERA_STATE.position,
      target: DEFAULT_VIEWPORT_3D_CAMERA_STATE.target,
      up: DEFAULT_VIEWPORT_3D_CAMERA_STATE.up,
    };

    expect(
      resolveViewport3DSceneCameraView({
        cameraRegistryCamera: registryCamera,
        commandState,
      }).cameraState,
    ).toEqual({
      position: registryCamera.position,
      target: registryCamera.target,
      up: registryCamera.up,
    });
    expect(
      resolveViewport3DSceneCameraView({
        cameraRegistryCamera: {
          ...registryCamera,
          orthographic_scale: 2.5e-6,
          projection: "orthographic",
        },
        commandState,
      }).cameraOrthographicScale,
    ).toBe(2.5e-6);
    expect(
      resolveViewport3DSceneCameraView({
        cameraRegistryCamera: {
          ...registryCamera,
          orthographic_scale: 2.5e-6,
          projection: "orthographic",
        },
        commandState,
      }).cameraState,
    ).toEqual({
      position: registryCamera.position,
      target: registryCamera.target,
      up: registryCamera.up,
    });
    expect(
      resolveViewport3DSceneCameraView({
        cameraRegistryCamera: {
          ...registryCamera,
          orthographic_scale: 2.5e-6,
          projection: "orthographic",
        },
        commandState,
      }).cameraOrthographicScale,
    ).toBe(2.5e-6);
    expect(readFileSync(sceneModelSourceUrl, "utf8")).not.toContain(
      "useViewport3DCameraRegistryStoreSync",
    );
  });

  it("routes FDM cuboid model builds through the build-engine lane without camera coupling", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("const fdmInstanceModelEnabled = Boolean(");
    expect(source).toContain("const fdmInstanceModelNeedsFieldVector =");
    expect(source).toContain("const fdmInstanceModelFieldVector = fdmInstanceModelNeedsFieldVector");
    expect(source).toContain("buildViewport3DFdmCuboidJobKey");
    expect(source).toContain("useFdmCuboidBuildResult");
    expect(source).toContain("modelFieldVector: fdmInstanceModelFieldVector");
    expect(source).toContain("realizedRegionIds: fdmRealizedRegionIds");
    expect(source).toContain("membership=${fdmRegionMembership.revision ?? \"none\"}");
    expect(source).toContain("const fdmRealizedRegionIds = useMemo");
    expect(source).toContain("adaptDomainPresentation({");
    expect(source).toContain("expectedFdmGridFingerprint:");
    expect(source).toContain(
      "fdmRegionMembershipBinary.data?.gridFingerprint ?? null",
    );
    expect(source).toContain(
      "resolveViewport3DFdmRealizedRegionIds(",
    );
    expect(source).toContain(
      "fdmRegionMembership.error || fdmRegionMembershipBinary.error",
    );
    expect(source).toContain("fdmBuildFieldRevision");
    expect(source).toContain("fdmInstanceModel: fdmInstanceModel");
    expect(source).toContain("fdmVectorSegments");
    expect(source).not.toContain("const fdmInstanceModel = useMemo<");
    expect(source).not.toContain("buildFdmCuboidInstanceModel(");
    expect(source).not.toContain("const fdmSurfaceInstanceModel");
  });

  it("keeps the single-grid Airbox vector-only build enabled without inactive-cell geometry", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("const fdmAirboxVectorOnlyBuildEnabled = Boolean(");
    expect(source).toContain(
      "const fdmAirboxBuildEnabled = Boolean(\n    fdmAirboxInstanceModelEnabled ||\n    fdmAirboxVectorOnlyBuildEnabled",
    );
    expect(source).toContain("enabled: fdmAirboxBuildEnabled,");
    expect(source).toContain("const fdmAirboxBuildKey = fdmAirboxBuildEnabled");
  });

  it("keeps the shared FDM model build key independent of target render settings", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");
    const enablement = source.slice(
      source.indexOf("const fdmInstanceModelEnabled ="),
      source.indexOf("const fdmInstanceModelNeedsFieldVector ="),
    );
    const buildIdentity = source.slice(
      source.indexOf("const fdmBuildFieldRevision ="),
      source.indexOf("const fdmBuildGroupKey ="),
    );

    expect(buildIdentity).not.toContain("renderingState?.revision");
    expect(buildIdentity).not.toContain("fdmBuildTargetRevision");
    expect(buildIdentity).not.toContain("fdmPointsVisible");
    expect(buildIdentity).not.toContain("fdmVectorsVisible");
    expect(buildIdentity).not.toContain("vectorBudget");
    expect(buildIdentity).not.toContain("activeQuantityId");
    expect(buildIdentity).toContain("fdmInstanceModelNeedsFieldVector");
    expect(buildIdentity).toContain("fdmVoxelTopography");
    expect(enablement).toContain("fdmMembershipCurrent");
    expect(enablement).toContain("fdmTargetDefinitionsResult.status");
    expect(enablement).not.toContain("fdmTargetSettings");
    expect(enablement).not.toContain("resolveFdmCuboidPassPlan");
  });

  it("passes the FDM target Surface scope and lift settings to the vector builder", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");
    const targetBlock = source.slice(
      source.indexOf("const fdmTargetViews:"),
      source.indexOf("const fdmMultilayerVoxelFillRatio"),
    );
    expect(targetBlock).toContain("geometryScope: settings.geometryScope");
    expect(targetBlock).toContain(
      "surfaceOffsetEnabled:\n                          settings.vectorSurfaceOffsetEnabled",
    );
    expect(targetBlock).toContain(
      "surfaceOffsetScale:\n                          settings.vectorSurfaceOffsetScale",
    );

    const airboxBuildBlock = source.slice(
      source.indexOf("const fdmAirboxBuildState ="),
      source.indexOf("const fdmAirboxInstanceModel", source.indexOf("const fdmAirboxBuildState =")),
    );
    expect(airboxBuildBlock).toContain(
      "vectorSurfaceOffsetEnabled:\n      fdmSingleGridAirboxSettings?.vectorSurfaceOffsetEnabled ?? false",
    );
    expect(airboxBuildBlock).toContain(
      "vectorSurfaceOffsetScale:\n      fdmSingleGridAirboxSettings?.vectorSurfaceOffsetScale ?? 0",
    );
  });

  it("builds FDM scalar colors from the FDM target palette, not the FEM/global palette", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");
    const fdmColorBlock = source.slice(
      source.indexOf("const fdmTargetViews:"),
      source.indexOf("const chunkedScalarColors = useViewport3DChunkedScalarColors"),
    );

    expect(fdmColorBlock).toContain("settings.scalarColorPalette");
    expect(fdmColorBlock).not.toContain("fdmSurfaceColorMode,\n      scalarColorPalette,");
  });

  it("builds a separate FDM vector color buffer for vector-only colorbars", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");
    const fdmVectorColorBlock = source.slice(
      source.indexOf("const fdmTargetViews:"),
      source.indexOf("const chunkedScalarColors = useViewport3DChunkedScalarColors"),
    );

    expect(fdmVectorColorBlock).toContain("settings.visible && settings.vectorsVisible");
    expect(fdmVectorColorBlock).toContain("settings.vectorColorMode");
    expect(fdmVectorColorBlock).toContain("settings.scalarColorPalette");
    expect(source).toContain("fdmVectorColors,");
  });

  it("binds FMVP v2 FDM rendering to trusted response domain identity", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain(
      "resolveTrustedViewport3DResponseDomainGenerationId(",
    );
    expect(source).toContain("fieldVector.responseMetadata");
    expect(source).toContain(
      "targetQuantityFieldVectors.responseMetadataByRequestId",
    );
    expect(source).toContain("responseDomainGenerationId:");
  });
});
