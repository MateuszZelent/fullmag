import { describe, expect, it } from "vitest";

import { DATA_FIELD_VECTOR_PATH } from "@/kernel/api/apiPaths";
import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  resolveAirboxVisualizationSettingsFromState,
  resolveGlobalObjectVisualizationSettings,
} from "@/kernel/visualization/ObjectVisualizationController";
import {
  buildHysteresisReplayGlyphModel,
  resolveHysteresisReplayMeshCompatibility,
  resolveHysteresisStepViewportTarget,
  resolveViewport3DSelectionBounds,
  targetForFdmDomain,
  targetForMeshPart,
} from "./viewport3DTargets";

function fieldVectorResourceRef(
  quantityId: string,
  snapshotId: string,
  stageId: string,
): string {
  return `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", quantityId)}?snapshot_id=${snapshotId}&stage_id=${stageId}`;
}

describe("viewport3DTargets", () => {
  it("maps the FDM structured domain to a stable object visualization target", () => {
    expect(targetForFdmDomain("current")).toEqual({
      id: "object:current",
      kind: "object",
      label: "current",
    });
  });

  it("maps mesh parts with object ownership to canonical object visualization targets", () => {
    expect(
      targetForMeshPart({
        id: "mesh-part:free-layer",
        label: "Free layer",
        object_id: "free-layer",
      } as Parameters<typeof targetForMeshPart>[0]),
    ).toEqual({
      id: "object:free-layer",
      kind: "object",
      label: "Free layer",
    });
  });

  it("does not create an FDM visualization target without a domain id", () => {
    expect(targetForFdmDomain(null)).toBeNull();
  });

  it("resolves hysteresis point selections to read-only snapshot targets", () => {
    const selection: Selection = {
      kind: "analysis.chart-point",
      label: "Point 4 (25 mT)",
      moduleSource: "analysis-plots",
      nodeId: "analysis:hysteresis:hysteresis-1:point:4",
      objectId: null,
      ref: {
        chartId: "hysteresis:hysteresis-1",
        kind: "analysis.chart-point",
        nodeId: "analysis:hysteresis:hysteresis-1:point:4",
        pointId: 4,
        quantity: "m",
        resourceRef: fieldVectorResourceRef(
          "m",
          "hysteresis_point_005",
          "hysteresis-1",
        ),
        rowIndex: 4,
        seriesId: "hysteresis:hysteresis-1:m",
        snapshotId: "hysteresis_point_005",
        stageId: "hysteresis-1",
        tableId: "hysteresis:hysteresis-1",
        targetId: "hysteresis-step:hysteresis-1:4",
        targetKind: "hysteresis-step",
        type: "analysis-chart-point",
        x: 25,
        y: 0.8,
      },
    };

    expect(resolveHysteresisStepViewportTarget(selection)).toEqual({
      fieldRevision: null,
      fieldOrientation: null,
      measurementAxis: null,
      meshIdentity: null,
      pointId: 4,
      quantityId: "m",
      resourceRef: fieldVectorResourceRef(
        "m",
        "hysteresis_point_005",
        "hysteresis-1",
      ),
      snapshotId: "hysteresis_point_005",
      stageId: "hysteresis-1",
      targetId: "hysteresis-step:hysteresis-1:4",
    });
  });

  it("preserves replay metadata from explorer hysteresis snapshot selections", () => {
    const selection: Selection = {
      kind: "study.stage.action",
      label: "Snapshot hysteresis_point_005",
      moduleSource: "explorer",
      nodeId:
        "model:study:stages:stage:hysteresis-1:field-point:4:snapshot:hysteresis_point_005",
      objectId: null,
      ref: {
        fieldOrientation: JSON.stringify({ kind: "preset", preset_name: "in_plane_x" }),
        fieldRevision: 12,
        kind: "study.stage.action",
        measurementAxis: JSON.stringify({ kind: "custom", vector: [1, 0, 0] }),
        meshIdentity: "study_domain:rev-12",
        nodeId:
          "model:study:stages:stage:hysteresis-1:field-point:4:snapshot:hysteresis_point_005",
        pointId: 4,
        quantityId: "m",
        resourceRef: fieldVectorResourceRef(
          "m",
          "hysteresis_point_005",
          "hysteresis-1",
        ),
        snapshotId: "hysteresis_point_005",
        stageId: "hysteresis-1",
        stageIndex: 0,
        targetId: "hysteresis-step:hysteresis-1:4",
        type: "hysteresis-snapshot",
      },
    };

    expect(resolveHysteresisStepViewportTarget(selection)).toEqual({
      fieldOrientation: JSON.stringify({ kind: "preset", preset_name: "in_plane_x" }),
      fieldRevision: 12,
      measurementAxis: JSON.stringify({ kind: "custom", vector: [1, 0, 0] }),
      meshIdentity: "study_domain:rev-12",
      pointId: 4,
      quantityId: "m",
      resourceRef: fieldVectorResourceRef(
        "m",
        "hysteresis_point_005",
        "hysteresis-1",
      ),
      snapshotId: "hysteresis_point_005",
      stageId: "hysteresis-1",
      targetId: "hysteresis-step:hysteresis-1:4",
    });
  });

  it("detects hysteresis replay mesh identity mismatches without remapping", () => {
    expect(
      resolveHysteresisReplayMeshCompatibility(
        {
          fieldOrientation: null,
          fieldRevision: null,
          measurementAxis: null,
          meshIdentity: "study_domain:rev-12",
          pointId: 4,
          quantityId: "m",
          resourceRef: null,
          snapshotId: "hysteresis_point_005",
          stageId: "hysteresis-1",
          targetId: "hysteresis-step:hysteresis-1:4",
        },
        { meshGenerationId: "study_domain:rev-12", meshRevision: 12 },
      ),
    ).toEqual({
      actualMeshIdentity: "study_domain:rev-12",
      reason: null,
      requiredMeshIdentity: "study_domain:rev-12",
      status: "compatible",
    });

    expect(
      resolveHysteresisReplayMeshCompatibility(
        {
          fieldOrientation: null,
          fieldRevision: null,
          measurementAxis: null,
          meshIdentity: "study_domain:rev-12",
          pointId: 4,
          quantityId: "m",
          resourceRef: null,
          snapshotId: "hysteresis_point_005",
          stageId: "hysteresis-1",
          targetId: "hysteresis-step:hysteresis-1:4",
        },
        { meshGenerationId: "study_domain:rev-13", meshRevision: 13 },
      ),
    ).toEqual({
      actualMeshIdentity: "study_domain:rev-13",
      reason:
        "Snapshot was computed on mesh study_domain:rev-12, but the current 3D topology is study_domain:rev-13.",
      requiredMeshIdentity: "study_domain:rev-12",
      status: "mismatch",
    });

    expect(
      resolveHysteresisReplayMeshCompatibility(
        {
          fieldOrientation: null,
          fieldRevision: null,
          measurementAxis: null,
          meshIdentity: null,
          pointId: 4,
          quantityId: "m",
          resourceRef: null,
          snapshotId: "hysteresis_point_005",
          stageId: "hysteresis-1",
          targetId: "hysteresis-step:hysteresis-1:4",
        },
        { meshGenerationId: "study_domain:rev-13", meshRevision: 13 },
      ),
    ).toMatchObject({
      reason: "Snapshot mesh identity is unavailable.",
      status: "unknown",
    });
  });

  it("builds a domain-neutral glyph model for hysteresis replay field and measurement axes", () => {
    expect(
      buildHysteresisReplayGlyphModel({
        fieldOrientation: JSON.stringify({
          kind: "custom",
          vector: [0, 0, 2],
        }),
        fieldRevision: 12,
        measurementAxis: JSON.stringify({
          kind: "custom",
          vector: [3, 4, 0],
        }),
        meshIdentity: "study_domain:rev-12",
        pointId: 4,
        quantityId: "m",
        resourceRef: null,
        snapshotId: "hysteresis_point_005",
        stageId: "hysteresis-1",
        targetId: "hysteresis-step:hysteresis-1:4",
      }),
    ).toEqual({
      fieldDirection: {
        label: "H field",
        source: "custom",
        vector: [0, 0, 1],
      },
      measurementAxis: {
        label: "Measurement axis",
        source: "custom",
        vector: [0.6, 0.8, 0],
      },
      pointId: 4,
      sampleNormal: {
        label: "Sample normal",
        source: "derived_oop",
        vector: [0, 0, 1],
      },
      stageId: "hysteresis-1",
      targetId: "hysteresis-step:hysteresis-1:4",
    });
  });

  it("builds preset OOP and in-plane hysteresis replay glyph axes", () => {
    expect(
      buildHysteresisReplayGlyphModel({
        fieldOrientation: JSON.stringify({
          kind: "preset",
          preset_name: "oop",
        }),
        fieldRevision: null,
        measurementAxis: JSON.stringify({
          kind: "preset",
          preset_name: "in_plane_y",
        }),
        meshIdentity: null,
        pointId: 6,
        quantityId: "m",
        resourceRef: null,
        snapshotId: "hysteresis_point_007",
        stageId: "hysteresis-1",
        targetId: "hysteresis-step:hysteresis-1:6",
      }),
    ).toMatchObject({
      fieldDirection: {
        source: "oop",
        vector: [0, 0, 1],
      },
      measurementAxis: {
        source: "in_plane_y",
        vector: [0, 1, 0],
      },
    });
  });

  it("maps canonical global mesh/vector layers into object render defaults", () => {
    expect(
      resolveGlobalObjectVisualizationSettings({
        layers: {
          points: { opacity: 0.45, visible: true },
          surface: { opacity: 0.45, visible: false },
          vectors: { density: 512, domain: "full_domain", visible: true },
          wireframe: { opacity: 0.45, visible: false },
        },
      } as unknown as VisualizationStateResource),
    ).toMatchObject({
      opacityPercent: 45,
      pointsVisible: true,
      renderMode: "points",
      shaderVisible: false,
      vectorsVisible: true,
      wireframeVisible: false,
    });
  });

  it("maps global vector style into object display fallback style fields", () => {
    expect(
      resolveGlobalObjectVisualizationSettings({
        vector_style: {
          alpha: 0.4,
          color_mode: "x",
          ferromagnet_visibility: "all",
          length_scale: 1,
          mono_color: "#44ccff",
          thickness: 2,
        },
      } as unknown as VisualizationStateResource),
    ).toMatchObject({
      shaderColorMode: "x",
      shaderMonoColor: "#44ccff",
      surfaceColorSource: "component_x",
      vectorAlphaPercent: 40,
      vectorColorMode: "x",
      vectorMonoColor: "#44ccff",
      vectorThickness: 2,
    });
  });

  it("maps canonical airbox layer state into the airbox render base", () => {
    expect(
      resolveAirboxVisualizationSettingsFromState({
        layers: {
          airbox: {
            opacity: 0.35,
            points: { opacity: 1, visible: false },
            surface: { opacity: 1, visible: false },
            vectors: { density: 128, domain: "airbox_only", visible: true },
            visible: true,
            wireframe: { opacity: 1, visible: true },
          },
        },
      } as VisualizationStateResource),
    ).toMatchObject({
      opacityPercent: 35,
      renderMode: "wireframe",
      shaderVisible: false,
      vectorsVisible: true,
      visible: true,
      wireframeVisible: true,
    });
  });

  it("resolves mesh quality element selections to centroid bounds", () => {
    const selection: Selection = {
      kind: "mesh.quality",
      label: "Worst mesh element 7",
      moduleSource: "mesh",
      nodeId: "model:mesh:quality:element:7",
      objectId: null,
      ref: {
        centroid: [1, 2, 3],
        elementIndex: 7,
        kind: "mesh.quality.element",
        nodeId: "model:mesh:quality:element:7",
        type: "mesh-quality-element",
        visualizationTargetId: "mesh:quality:element:7",
      },
    };

    const bounds = resolveViewport3DSelectionBounds(
      selection,
      {
        airboxParts: [],
        magneticParts: [],
        magneticSurfacePartsByPartId: new Map(),
        objectPartIds: new Map(),
        partsById: new Map(),
      },
      { center: [0, 0, 0], radius: 10, size: [20, 20, 20] },
    );

    expect(bounds).toMatchObject({
      center: [1, 2, 3],
      radius: 0.3,
      size: [0.6, 0.6, 0.6],
    });
  });
});
