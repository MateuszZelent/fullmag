import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DEFAULT_CAMERA_REGISTRY_STATE } from "@/kernel/visualization/CameraRegistryController";
import { DATA_FIELD_VECTOR_PATH } from "@/kernel/api/apiPaths";
import {
  DEFAULT_OBJECT_VISUALIZATION,
  ObjectVisualizationController,
} from "@/kernel/visualization/ObjectVisualizationController";
import type { DecodedFieldVector } from "@/kernel/api/codecs";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  buildHysteresisChartPointSelection,
} from "@/shared/domain/study/HysteresisChart";

import {
  buildViewport3DAirboxSyntheticVectorField,
  applyViewport3DFieldLayerDiagnosticOverrides,
  resolveViewport3DActiveQuantityId,
  resolveViewport3DAnalysisComplexFieldQuery,
  resolveViewport3DDisplayedLiveValue,
  resolveViewport3DPrimaryFieldDataOptions,
  resolveViewport3DPrimaryFieldDemandPlan,
  resolveViewport3DPrimaryFieldRenderOptions,
  resolveViewport3DPrimaryFieldVectorEnabled,
  resolveViewport3DPrimaryFieldQuery,
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
  resolveViewport3DResourceFrameState,
  resolveViewport3DSceneCameraView,
  resolveViewport3DAirboxFieldVectorDemandPlan,
  resolveViewport3DScopedPartVectorFieldDemandPlan,
  resolveViewport3DScopedPartVectorFieldRequests,
  resolveViewport3DScopedVectorFieldQuery,
  resolveViewport3DTargetFieldQuery,
  resolveViewport3DTargetQuantityFieldDemandPlan,
  resolveViewport3DTargetQuantityFieldRequests,
  resolveViewport3DReplayFieldQuery,
  resolveViewport3DFieldDataIssue,
  resolveViewport3DVisualizationQuantityId,
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
import { viewport3DFieldRenderOptionsNeedFieldData } from "../viewport3dRenderModel";
import { buildViewport3DTargetFieldBuffer } from "../model/viewport3DTargetFieldBuffer";
import {
  DEFAULT_VIEWPORT_3D_CAMERA_STATE,
  type Viewport3DCommandState,
} from "../viewport3dStore";

const sceneModelSourceUrl = new URL("./useViewport3DSceneModel.ts", import.meta.url);
const visualizationStateResourceSourceUrl = new URL(
  "../../../kernel/visualization/useVisualizationStateResource.ts",
  import.meta.url,
);

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
  it("subscribes to build diagnostic snapshot versions for live compact diagnostics", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("useSyncExternalStore");
    expect(source).toContain("subscribeViewport3DBuildDiagnostics");
    expect(source).toContain("getViewport3DBuildDiagnosticsSnapshotVersion");
    expect(source).toContain("buildDiagnosticsSnapshotVersion");
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
              scope_kind: "full",
            },
            requestId: "quantity=H_eff&component=x&scope_kind=full",
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
      scopeKind: "full",
      topologyRevision: "topology-r1",
    });
    expect(resolved.partFieldVectors.get("part-b")).toBeUndefined();
    expect(resolved.partTargetFieldBuffers.has("part-b")).toBe(false);
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

  it("pauses heavy field vector resource hooks while camera field updates are held", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("const fieldUpdateHoldActive =");
    expect(source).toContain("{ pauseLoad: fieldUpdateHoldActive }");
    expect(source).toContain("magneticPartFieldQueries.size > 0");
    expect(source).toContain("targetQuantityFieldRequests.size > 0");
    expect(source).toContain("fieldVectorEnabled,");
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
      "(airboxVectorsVisible && !airboxSettings.airboxSyntheticVectorsEnabled)",
    );
    expect(source).toContain("resolveViewport3DResolvedPartFieldBuffers({");
    expect(source).toContain("if (partFieldVectors.has(partId) || partTargetFieldBuffers.has(partId))");
    expect(source).toContain("synthetic: true");
    expect(source).toContain("partTargetFieldBuffers.set(");
  });

  it("uses frequency-domain analysis overlay fields as the primary 3D field source", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("useAnalysisFieldOverlay");
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
        component: "x",
        passId: "primary-field:surface",
        passKind: "surface",
        quantityId: "m",
      }),
    ]);
    expect(plan.request).toMatchObject({
      consumers: ["primary-field:surface"],
      quantityId: "m",
      query: {
        component: "x",
        scope_kind: "full",
        snapshot_id: "snapshot-3",
        stage_id: "stage-relax",
      },
    });
    expect(plan.request?.requestId).toContain("quantity=m");
    expect(plan.request?.requestId).toContain("component=x");
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
      component: "magnitude",
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
        component: "x",
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
        scope_kind: "full",
        snapshot_id: "hysteresis_point_007",
        stage_id: "hysteresis-1",
      },
    });
    expect(request?.query).not.toHaveProperty("max_samples");
    expect(request?.requestId).toContain("quantity=H_eff");
    expect(request?.requestId).toContain("component=full");
    expect(request?.requestId).toContain("scope_kind=full");
    expect(request?.requestId).toContain("snapshot_id=hysteresis_point_007");
    expect(request?.requestId).toContain("stage_id=hysteresis-1");
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

  it("maps mesh-backed region parts to the same visualization target as authored overlays", () => {
    const regions = [
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
      new Set(["film\u0000film:core"]),
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
        mesh_part_ids: ["membership:film%3Acore"],
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
        id: "membership:film%3Acore",
        node_indices: [0, 1, 2, 3],
        object_id: "film",
      },
    ]);
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

  it("keeps parent visualization active for mesh-backed region parts", () => {
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
      }),
    ).toMatchObject({
      shaderVisible: false,
      vectorsVisible: true,
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

  it("resolves target-specific scalar field queries unless vectors need full components", () => {
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
      component: "x",
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

  it("keeps airbox planned requests aligned with query semantics", () => {
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
      vectorsVisible: false,
    });
    const request = airboxPlan.requests.get("part:__air__");

    expect(request?.query).toEqual({
      component: "x",
      scope_id: "part:__air__",
      scope_kind: "airbox",
    });
    expect(resolveViewport3DFieldVectorResourceKey("H_eff", request!.query))
      .toBe(
        "/v2/sessions/current/data/fields/H_eff/samples/vector?component=x&scope_id=part%3A__air__&scope_kind=airbox",
      );
    expect(request?.requestId).toContain("component=x");
    expect(request?.requestId).not.toContain("max_samples=1200");
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
          "surface:y:complete",
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
      "x",
      "x",
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

  it("keeps component-colored magnetic parts on scoped unsampled field requests", () => {
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
        component: "x",
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
        component: "magnitude",
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

    expect(source).toContain("const airboxFieldVectorEnabled = Boolean(");
    expect(source).toContain("airboxSurfaceColorMode");
    expect(source).toContain("useViewport3DAirboxFieldVectors(");
    expect(source).not.toContain("ids.add(airboxSettings.activeQuantityId)");
  });

  it("keeps cross-section draft previews separate from the canonical clip resource path", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("activeCrossSectionFramePreview");
    expect(source).toContain("crossSectionFramePreviewToClip");
    expect(source).toContain("enabled: Boolean(renderingState?.clip?.enabled && topologyCurrent)");
    expect(source).toContain("crossSectionFrameClip");
    expect(source).toContain("clipFrameRotationDegrees: 0");
  });

  it("uses the local viewport camera for live scene rendering", () => {
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
    ).toEqual(commandState.camera);
    expect(
      resolveViewport3DSceneCameraView({
        cameraRegistryCamera: {
          ...registryCamera,
          orthographic_scale: 2.5e-6,
          projection: "orthographic",
        },
        commandState,
      }).cameraOrthographicScale,
    ).toBe(4e-6);
    expect(
      resolveViewport3DSceneCameraView({
        cameraRegistryCamera: {
          ...registryCamera,
          orthographic_scale: 2.5e-6,
          projection: "orthographic",
        },
        commandState,
      }).cameraState,
    ).toEqual(commandState.camera);
    expect(
      resolveViewport3DSceneCameraView({
        cameraRegistryCamera: {
          ...registryCamera,
          orthographic_scale: 2.5e-6,
          projection: "orthographic",
        },
        commandState,
      }).cameraOrthographicScale,
    ).toBe(4e-6);
  });

  it("routes FDM cuboid model builds through the build-engine lane without camera coupling", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("const fdmInstanceModelEnabled = Boolean(");
    expect(source).toContain("const fdmInstanceModelNeedsFieldVector =");
    expect(source).toContain("const fdmInstanceModelFieldVector = fdmInstanceModelNeedsFieldVector");
    expect(source).toContain("buildViewport3DFdmCuboidJobKey");
    expect(source).toContain("useFdmCuboidBuildResult");
    expect(source).toContain("modelFieldVector: fdmInstanceModelFieldVector");
    expect(source).toContain("fdmBuildFieldRevision");
    expect(source).toContain("fdmInstanceModel: fdmInstanceModel");
    expect(source).toContain("fdmVectorSegments");
    expect(source).not.toContain("const fdmInstanceModel = useMemo<");
    expect(source).not.toContain("buildFdmCuboidInstanceModel(");
    expect(source).not.toContain("const fdmSurfaceInstanceModel");
  });
});
