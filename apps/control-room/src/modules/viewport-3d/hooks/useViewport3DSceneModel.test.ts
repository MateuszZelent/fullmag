import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DEFAULT_CAMERA_REGISTRY_STATE } from "@/kernel/visualization/CameraRegistryController";
import { DATA_FIELD_VECTOR_PATH } from "@/kernel/api/apiPaths";
import {
  ObjectVisualizationController,
} from "@/kernel/visualization/ObjectVisualizationController";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  buildHysteresisChartPointSelection,
} from "@/shared/domain/study/HysteresisChart";

import {
  resolveViewport3DActiveQuantityId,
  resolveViewport3DDisplayedLiveValue,
  resolveViewport3DPrimaryFieldRenderOptions,
  resolveViewport3DPrimaryFieldVectorEnabled,
  resolveViewport3DPrimaryFieldQuery,
  resolveViewport3DSelectedSnapshotId,
  resolveViewport3DSelectedSnapshotQuery,
  filterViewport3DMeshBackedRegionOverlays,
  resolveViewport3DMembershipRegionOverlays,
  resolveViewport3DMeshBackedRegionKeys,
  resolveViewport3DMeshBackedRegionOverlays,
  resolveViewport3DPartVisualizationSettings,
  resolveViewport3DRegionMembershipIds,
  resolveViewport3DRegionOverlays,
  resolveViewport3DRegionSelectionBounds,
  resolveViewport3DRegionSelectionScope,
  resolveViewport3DRegionTargetByPartId,
  resolveViewport3DResourceFrameState,
  resolveViewport3DSceneCameraView,
  resolveViewport3DScopedPartVectorFieldRequests,
  resolveViewport3DScopedVectorFieldQuery,
  resolveViewport3DTargetFieldQuery,
  resolveViewport3DReplayFieldQuery,
  resolveViewport3DFieldDataIssue,
  resolveViewport3DVisualizationQuantityId,
  mergeViewport3DFieldQuery,
  sameViewport3DQuantityId,
} from "./useViewport3DSceneModel";
import {
  resolveHysteresisStepViewportTarget,
} from "../model/viewport3DTargets";
import { resolveViewport3DFieldVectorResourceKey } from "../viewport3dResources";
import { viewport3DFieldRenderOptionsNeedFieldData } from "../viewport3dRenderModel";
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

describe("useViewport3DSceneModel", () => {
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
    expect(source).toContain("targetQuantityFieldQueries.size > 0");
    expect(source).toContain("fieldVectorEnabled,");
  });

  it("uses frequency-domain analysis overlay fields as the primary 3D field source", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("useAnalysisFieldOverlay");
    expect(source).toContain("startAnalysisFieldOverlayPhaseAnimation");
    expect(source).toContain("const primaryFieldQuantityId = analysisOverlay?.fieldId ?? quantityId;");
    expect(source).toContain("if (analysisOverlay) {");
    expect(source).toContain("return analysisOverlay.query;");
    expect(source).toContain("Boolean(analysisOverlay) ||");
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
        }),
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
        }),
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
      { id: "film", kind: "object" },
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

    expect(viewport3DFieldRenderOptionsNeedFieldData(primaryOptions)).toBe(false);
    expect(resolveViewport3DPrimaryFieldQuery({
      fdmInstanceModelNeedsFieldVector: false,
      fdmSurfaceColorMode: null,
      fdmTopographyEnabled: false,
      fdmVectorsVisible: false,
      fieldRenderOptions: primaryOptions,
    })).toEqual({
      component: "full",
      scope_kind: "full",
    });
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
      magneticParts: [{ part }] as never,
      vectorDomain: "auto",
    });

    expect(scopedRequests).toEqual(
      new Map([
        [
          "part:arch_waveguide",
          {
            quantityId: "m",
            query: {
              component: "full",
              max_samples: 512,
              scope_kind: "full",
            },
          },
        ],
      ]),
    );

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
      scopedVectorOnlyPartIds: new Set(["part:arch_waveguide"]),
      vectorDomain: "auto",
    });

    expect(viewport3DFieldRenderOptionsNeedFieldData(primaryOptions)).toBe(false);
  });

  it("keeps scalar-colored magnetic parts on the unsampled primary path", () => {
    const scopedRequests = resolveViewport3DScopedPartVectorFieldRequests({
      getPartSettings: () =>
        ({
          activeQuantityId: "m",
          shaderVisible: true,
          surfaceColorSource: "magnitude",
          vectorBudget: 512,
          vectorsVisible: true,
          visible: true,
        }) as never,
      magneticParts: [{ part: { id: "part:arch_waveguide" } }] as never,
      vectorDomain: "auto",
    });

    expect(scopedRequests.size).toBe(0);
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
    expect(source).toContain("resolveViewport3DFieldVectorResourceKey");
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

  it("builds the FDM instance model once in the scene model without coupling solid rendering to field revisions", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("const fdmInstanceModelEnabled = Boolean(");
    expect(source).toContain("const fdmInstanceModelNeedsFieldVector =");
    expect(source).toContain("const fdmInstanceModelFieldVector = fdmInstanceModelNeedsFieldVector");
    expect(source).toContain("const fdmInstanceModel = useMemo<");
    expect(source).toContain("if (!fdmInstanceModelEnabled) return undefined;");
    expect(source).toContain("fieldVector: fdmInstanceModelFieldVector");
    expect(source).toContain("fdmInstanceModel: fdmInstanceModel");
    expect(source).not.toContain("const fdmSurfaceInstanceModel");
  });
});
