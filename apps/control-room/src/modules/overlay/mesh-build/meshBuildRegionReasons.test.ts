import { describe, expect, it } from "vitest";

import { buildRegionMeshBuildReasonRows } from "./meshBuildRegionReasons";

describe("mesh build region reasons", () => {
  it("summarizes region mesh policy diagnostics as rebuild reasons", () => {
    expect(
      buildRegionMeshBuildReasonRows({
        scene_revision: 12,
        diagnostics: [
          {
            capability_gate: "regions.mesh_policy",
            code: "region_mesh_policy_requires_rebuild",
            diagnostic_id: "region:r1:mesh-policy-pending",
            message: "Region mesh policy is authored but not applied yet.",
            owner_object_id: "obj1",
            realization_status: "authored",
            region_id: "r1",
            severity: "warning",
          },
          {
            capability_gate: "regions.material_override",
            code: "region_material_realization_pending",
            diagnostic_id: "region:r1:material-pending",
            message: "Material override is pending.",
            owner_object_id: "obj1",
            region_id: "r1",
            severity: "warning",
          },
        ],
      }),
    ).toEqual([{ label: "Rebuild reasons", value: "region mesh policy changed" }]);
  });
});
