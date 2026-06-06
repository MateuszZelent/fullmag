import { describe, expect, it } from "vitest";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  resolveAirboxVisualizationSettingsFromState,
  resolveGlobalObjectVisualizationSettings,
} from "@/kernel/visualization/ObjectVisualizationController";
import {
  resolveViewport3DSelectionBounds,
  targetForFdmDomain,
} from "./viewport3DTargets";

describe("viewport3DTargets", () => {
  it("maps the FDM structured domain to a stable object visualization target", () => {
    expect(targetForFdmDomain("current")).toEqual({
      id: "current",
      kind: "object",
      label: "current",
    });
  });

  it("does not create an FDM visualization target without a domain id", () => {
    expect(targetForFdmDomain(null)).toBeNull();
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
