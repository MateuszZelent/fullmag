import { describe, expect, it } from "vitest";

import { computeViewport3DStatus } from "../useViewport3DStatus";

describe("computeViewport3DStatus", () => {
  it("treats Mesh mode as an active 3D viewport mode", () => {
    const result = computeViewport3DStatus({
      femDiscretization: true,
      model: {
        airMeshVisible: false,
        femMeshData: {
          nNodes: 12,
          nElements: 24,
          meshGenerationId: "mesh:1",
        } as any,
        femTopologyKey: "topology:1",
        femViewportLayers: {
          showPrimitives: true,
          showMesh: false,
          showQuantity: false,
          showMagneticTexture: false,
        } as any,
        meshShowArrows: false,
        objectViewMode: "context",
        selectedEntityId: null,
        selectedObjectId: null,
      },
      spatialPreview: null,
      viewport: {
        effectiveViewMode: "Mesh",
        previewBusy: false,
        previewGrid: null,
      },
      viewportRuntimeHealth: null,
    });

    expect(result.status).toBe("active");
    expect(result.reason).toBe("3D visualization is active.");
  });

  it("keeps non-3D and non-Mesh modes inactive", () => {
    const result = computeViewport3DStatus({
      femDiscretization: false,
      model: {
        airMeshVisible: false,
        femMeshData: null,
        femTopologyKey: null,
        femViewportLayers: {
          showPrimitives: false,
          showMesh: false,
          showQuantity: false,
          showMagneticTexture: false,
        } as any,
        meshShowArrows: false,
        objectViewMode: "context",
        selectedEntityId: null,
        selectedObjectId: null,
      },
      spatialPreview: null,
      viewport: {
        effectiveViewMode: "Analyze",
        previewBusy: false,
        previewGrid: null,
      },
      viewportRuntimeHealth: null,
    });

    expect(result.status).toBe("inactive");
    expect(result.reason).toContain("Current viewport mode is Analyze");
  });
});
