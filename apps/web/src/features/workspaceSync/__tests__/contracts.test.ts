import { describe, expect, it } from "vitest";

import type { CapabilityMap, DisplaySelection } from "../../../api/types";
import {
  capabilityGateMap,
  domainRevisionStateFromResources,
  isDomainTopologyStale,
  quantitySelectionFromDisplay,
  reduceCrossSurfaceSelection,
  reduceWorkspaceSyncState,
  sharedCapabilitiesFromApi,
  shouldResampleSliceForRevisionChange,
  slicePlaneFromDisplay,
} from "../contracts";

function display(overrides: Partial<DisplaySelection> = {}): DisplaySelection {
  return {
    active_quantity_id: "m",
    view_mode: "2d",
    field_component: "magnitude",
    colormap: "viridis",
    auto_contrast: true,
    contrast_min: null,
    contrast_max: null,
    vector_glyphs: false,
    vector_density: 4,
    slice_mode: "single",
    slice_layer: 3,
    max_points: 1000,
    x_chosen_size: 64,
    y_chosen_size: 64,
    ...overrides,
  };
}

describe("workspaceSync contracts", () => {
  it("normalizes display selection into shared quantity state", () => {
    expect(quantitySelectionFromDisplay(display({ field_component: "x" }))).toMatchObject({
      activeQuantityId: "m",
      component: "x",
      colormap: "viridis",
    });
    expect(quantitySelectionFromDisplay(display({ view_mode: "3d" })).component).toBe("3D");
  });

  it("normalizes slice plane state without FDM/FEM-specific top-level types", () => {
    expect(
      slicePlaneFromDisplay(display({ slice_mode: "all_layers", slice_layer: 9 }), {
        axis: "x",
        positionPercent: 120,
      }),
    ).toEqual({
      axis: "x",
      mode: "all_layers",
      positionPercent: 100,
      layerIndex: 9,
      thicknessPercent: null,
      syncWith3DClip: false,
    });
  });

  it("builds revision state from status resource revisions", () => {
    expect(
      domainRevisionStateFromResources({
        domain_generation_id: 7,
        fields_revision: 11,
        display_revision: 13,
        mesh_revision: 17,
        mesh_build_revision: 19,
        scalars_revision: 23,
        scene_revision: 29,
      }),
    ).toMatchObject({
      domainGenerationId: 7,
      fieldsRevision: 11,
      meshRevision: 17,
      sceneRevision: 29,
    });
  });

  it("keeps missing capabilities visible with reasons", () => {
    const capabilities: CapabilityMap = {
      structured_grid: false,
      explicit_topology: true,
      binary_fields: true,
      cell_fields: true,
      node_fields: true,
      scalar_history: true,
      eigen_modes: false,
      gpu_telemetry: false,
      preview_2d: true,
      preview_3d: true,
      algorithms_available: [],
    };
    const shared = sharedCapabilitiesFromApi(capabilities, { meshing: true });
    const gates = capabilityGateMap(shared);
    expect(gates.explicit_topology.enabled).toBe(true);
    expect(gates.structured_grid.enabled).toBe(false);
    expect(gates.structured_grid.reason).toBe("Requires structured_grid capability");
  });

  it("reduces cross-surface selection and preserves source surface", () => {
    const next = reduceCrossSurfaceSelection(
      {
        primary: { kind: "none", id: null },
        multi: [],
        sourceSurface: null,
        mappedSceneObjectId: null,
      },
      {
        primary: { kind: "mesh_part", id: "part-a" },
        sourceSurface: "mesh",
        mappedSceneObjectId: "object-a",
      },
    );
    expect(next.primary).toEqual({ kind: "mesh_part", id: "part-a" });
    expect(next.sourceSurface).toBe("mesh");
    expect(next.mappedSceneObjectId).toBe("object-a");
  });

  it("reduces sync toggles without changing unrelated sync flags", () => {
    expect(
      reduceWorkspaceSyncState(
        {
          quantitySync: true,
          selectionSync: true,
          planeSync: false,
          followSelectionAcrossTabs: false,
        },
        { type: "set_plane_sync", enabled: true },
      ),
    ).toEqual({
      quantitySync: true,
      selectionSync: true,
      planeSync: true,
      followSelectionAcrossTabs: false,
    });
  });

  it("detects topology and field revision changes for slice invalidation", () => {
    const previous = domainRevisionStateFromResources({
      domain_generation_id: 1,
      topology_revision: 2,
      fields_revision: 3,
      mesh_revision: 4,
      mesh_build_revision: 5,
    });
    const topologyChanged = { ...previous, meshRevision: 6 };
    const fieldChanged = { ...previous, fieldsRevision: 7 };
    expect(isDomainTopologyStale(previous, topologyChanged)).toBe(true);
    expect(shouldResampleSliceForRevisionChange(previous, fieldChanged)).toBe(true);
    expect(shouldResampleSliceForRevisionChange(previous, { ...previous })).toBe(false);
  });
});
