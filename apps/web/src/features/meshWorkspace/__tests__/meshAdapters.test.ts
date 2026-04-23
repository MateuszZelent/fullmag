import { describe, expect, it } from "vitest";

import type { MeshSemanticsResource } from "../../../api/types";
import { meshSemanticsResourceToView } from "../meshAdapters";

describe("meshSemanticsResourceToView", () => {
  it("maps three-level mesh semantics payload to UI view model", () => {
    const resource: MeshSemanticsResource = {
      revision: 73,
      universe_config: {
        mode: "box",
        size: [4, 5, 6],
        padding: [1, 1.5, 2],
        airbox_hmax: 8e-9,
      },
      shared_domain_config: {
        algorithm_2d: 6,
        algorithm_3d: 10,
      },
      object_configs: [
        {
          object_id: "body",
          object_name: "body",
          config: {
            mode: "override",
            hmax: "2e-9",
            hmin: "5e-10",
          },
        },
      ],
      solver_mesh: {
        mesh_name: "mesh-a",
        mesh_id: "mesh-a:1",
        generation_id: "42",
        domain_mesh_mode: "shared_domain",
        object_segment_count: 1,
        mesh_part_count: 2,
      },
      mesh_build_diagnostics: {
        mesh_quality_summary: { min_quality: 0.82 },
        last_build_summary: { elements: 24 },
        mesh_pipeline_status: [{ id: "meshing", status: "active" }],
        last_build_error: "quality threshold not met",
      },
      render_only_controls_do_not_change_solver_domain: true,
    };

    const view = meshSemanticsResourceToView(resource);
    expect(view).not.toBeNull();
    expect(view?.revision).toBe(73);
    expect(view?.universe?.mode).toBe("box");
    expect(view?.universe?.size).toEqual([4, 5, 6]);
    expect(view?.objects[0].object_id).toBe("body");
    expect(view?.objects[0].mode).toBe("override");
    expect(view?.objects[0].hmax).toBe(2e-9);
    expect(view?.solver_mesh?.mesh_name).toBe("mesh-a");
    expect(view?.diagnostics?.min_quality).toBe(0.82);
    expect(view?.diagnostics?.pipeline_phase_count).toBe(1);
    expect(view?.render_only_controls_do_not_change_solver_domain).toBe(true);
  });

  it("returns null for missing payload", () => {
    expect(meshSemanticsResourceToView(null)).toBeNull();
    expect(meshSemanticsResourceToView(undefined)).toBeNull();
  });
});
