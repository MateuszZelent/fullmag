import { describe, expect, it } from "vitest";

import {
  applyToolbarStateToLegacyRenderState,
  buildToolbarStateFromLegacy,
  buildViewport3DModelFromAdapter,
  mapFdmSettingsToViewport3DState,
  mapViewport3DFdmPatchToLegacySettingsPatch,
} from "../viewport3dAdapters";
import { resolveViewport3DCapabilities } from "../viewport3dCapabilities";
import type { UnifiedRenderState } from "../unifiedViewportTypes";

const BASE_RENDER_STATE: UnifiedRenderState = {
  selectedLayer: 3,
  allLayersVisible: false,
  vectorComponent: "z",
  colorScale: "viridis",
  autoScale: true,
  maxPoints: 50000,
  everyN: 8,
  meshRenderMode: "solid+wireframe",
  meshOpacity: 72,
  clipEnabled: true,
  clipAxis: "y",
  clipPosition: 40,
  femLayers: {
    showPrimitives: true,
    showMesh: false,
    showQuantity: true,
  },
};

describe("viewport3d adapters", () => {
  it("maps legacy render state to canonical toolbar state", () => {
    const toolbar = buildToolbarStateFromLegacy({
      renderState: BASE_RENDER_STATE,
      quantityId: "m",
      clipFlip: false,
      interactionMode: "camera",
      snapEnabled: false,
      objectViewMode: "context",
      vectorsVisible: true,
      legendVisible: true,
      partExplorerVisible: false,
      projection: "perspective",
      navProfile: "trackball",
    });

    expect(toolbar.rowA.renderMode).toBe("shaded+wireframe");
    expect(toolbar.rowA.opacity).toBe(72);
    expect(toolbar.rowA.clipAxis).toBe("y");
    expect(toolbar.rowA.quantity).toBe("m");
  });

  it("maps canonical toolbar state back to legacy clip/render fields", () => {
    const toolbar = buildToolbarStateFromLegacy({
      renderState: BASE_RENDER_STATE,
      quantityId: "m",
      clipFlip: true,
      interactionMode: "move",
      snapEnabled: true,
      objectViewMode: "isolate",
      vectorsVisible: false,
      legendVisible: false,
      partExplorerVisible: true,
      projection: "orthographic",
      navProfile: "cad",
    });

    const mapped = applyToolbarStateToLegacyRenderState(toolbar, BASE_RENDER_STATE);
    expect(mapped.renderState.meshRenderMode).toBe("solid+wireframe");
    expect(mapped.renderState.clipAxis).toBe("y");
    expect(mapped.clipFlip).toBe(true);
  });

  it("builds unified model with fallback mode from capability state", () => {
    const toolbar = buildToolbarStateFromLegacy({
      renderState: BASE_RENDER_STATE,
      quantityId: "m",
      clipFlip: false,
      interactionMode: "camera",
      snapEnabled: false,
      objectViewMode: "context",
      vectorsVisible: true,
      legendVisible: true,
      partExplorerVisible: false,
      projection: "perspective",
      navProfile: "trackball",
    });
    const capabilities = resolveViewport3DCapabilities({
      capabilities: {
        preview_2d: true,
        preview_3d: false,
        structured_grid: false,
        explicit_topology: false,
        binary_fields: true,
        cell_fields: true,
        node_fields: true,
        scalar_history: false,
        eigen_modes: false,
        gpu_telemetry: false,
        algorithms_available: [],
      },
    });
    const model = buildViewport3DModelFromAdapter({
      discretization: "fem",
      renderState: BASE_RENDER_STATE,
      toolbarState: toolbar,
      capabilities,
    });

    expect(model.scene.fallbackMode).toBe("bounds-preview");
    expect(model.scene.renderMode).toBe("shaded+wireframe");
    expect(model.fdm).toBeNull();
  });

  it("maps FDM visualization settings into unified module state", () => {
    const mapped = mapFdmSettingsToViewport3DState(
      {
        quality: "ultra",
        render_mode: "voxel",
        voxel_color_mode: "x",
        sampling: 4,
        brightness: 2.3,
        voxel_opacity: 0.7,
        voxel_gap: 0.11,
        voxel_threshold: 0.2,
        topo_enabled: true,
        topo_component: "y",
        topo_multiplier: 12,
      },
      true,
    );

    expect(mapped.renderMode).toBe("voxel");
    expect(mapped.vectorsVisible).toBe(false);
    expect(mapped.voxelColorMode).toBe("x");
    expect(mapped.topography.enabled).toBe(true);
    expect(mapped.topography.component).toBe("y");
    expect(mapped.topography.amplitude).toBe(12);
  });

  it("includes default FDM module state for non-FEM discretization", () => {
    const toolbar = buildToolbarStateFromLegacy({
      renderState: BASE_RENDER_STATE,
      quantityId: "m",
      clipFlip: false,
      interactionMode: "camera",
      snapEnabled: false,
      objectViewMode: "context",
      vectorsVisible: true,
      legendVisible: true,
      partExplorerVisible: false,
      projection: "perspective",
      navProfile: "trackball",
    });
    const capabilities = resolveViewport3DCapabilities({
      capabilities: {
        preview_2d: true,
        preview_3d: true,
        structured_grid: true,
        explicit_topology: false,
        binary_fields: true,
        cell_fields: true,
        node_fields: true,
        scalar_history: false,
        eigen_modes: false,
        gpu_telemetry: false,
        algorithms_available: [],
      },
    });
    const model = buildViewport3DModelFromAdapter({
      discretization: "fdm",
      renderState: BASE_RENDER_STATE,
      toolbarState: toolbar,
      capabilities,
      fdmVectorsVisible: false,
    });

    expect(model.fdm).not.toBeNull();
    expect(model.fdm?.quality).toBe("high");
    expect(model.fdm?.renderMode).toBe("glyph");
    expect(model.fdm?.vectorsVisible).toBe(false);
  });

  it("maps canonical FDM patch into legacy visualization patch", () => {
    const legacyPatch = mapViewport3DFdmPatchToLegacySettingsPatch({
      renderMode: "voxel",
      voxelOpacity: 0.72,
      topography: {
        enabled: true,
        component: "x",
        amplitude: 14,
      },
    });

    expect(legacyPatch).toEqual({
      render_mode: "voxel",
      voxel_opacity: 0.72,
      topo_enabled: true,
      topo_component: "x",
      topo_multiplier: 14,
    });
  });
});
