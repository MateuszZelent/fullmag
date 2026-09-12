import { describe, expect, it } from "vitest";

import { resourcesToViewportModel } from "../resourcesToViewportModel";

describe("resourcesToViewportModel", () => {
  it("maps resource revisions and runtime view state into Viewport3DModel", () => {
    const model = resourcesToViewportModel({
      status: {
        resources: {
          fields_revision: 10,
          scalars_revision: 11,
          domain_generation_id: 12,
          artifacts_revision: 13,
          engine_log_revision: 14,
          display_revision: 15,
          workspace_revision: 16,
          mesh_revision: 17,
          mesh_build_revision: 18,
          commands_revision: 19,
          stages_revision: 20,
          topology_revision: 21,
          field_revision: 22,
        },
      },
      quantity_id: "m",
      component: "magnitude",
      selection: {
        object_id: "object-a",
        part_id: "part-a",
      },
      clip: {
        enabled: true,
        axis: "x",
        position: 0.25,
        invert: true,
      },
    });

    expect(model.topology_revision).toBe(21);
    expect(model.field_revision).toBe(22);
    expect(model.quantity_id).toBe("m");
    expect(model.component).toBe("magnitude");
    expect(model.selection).toEqual({
      object_id: "object-a",
      part_id: "part-a",
    });
    expect(model.clip).toEqual({
      enabled: true,
      axis: "x",
      position: 0.25,
      invert: true,
    });
  });

  it("falls back to defaults for missing optional fields", () => {
    const model = resourcesToViewportModel({
      status: null,
      quantity_id: null,
      component: null,
    });

    expect(model.topology_revision).toBeNull();
    expect(model.field_revision).toBeNull();
    expect(model.selection).toEqual({
      object_id: null,
      part_id: null,
    });
    expect(model.clip).toEqual({
      enabled: false,
      axis: "z",
      position: 0.5,
      invert: false,
    });
  });
});
