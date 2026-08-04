import { describe, expect, it } from "vitest";

import {
  buildFieldMapDataPlan,
  buildFieldMapProbeQuery,
} from "./fieldMapDataPlan";

describe("field-map data plan", () => {
  it("does not enable planar requests for an inactive module", () => {
    expect(
      buildFieldMapDataPlan({
        active: false,
        component: "normal",
        includeMesh: true,
        monitorId: "plane-1",
        quantityId: "m",
        resolution: [512, 256],
        showVectors: true,
      }),
    ).toMatchObject({
      enabled: false,
      requestMask: false,
      requestMesh: false,
      requestScalar: false,
      requestVectors: false,
    });
  });

  it("requests only selected layers with bounded interactive parameters", () => {
    const plan = buildFieldMapDataPlan({
      active: true,
      component: "normal",
      includeMesh: false,
      monitorId: "plane-1",
      quantityId: "m",
      resolution: [512, 256],
      showVectors: true,
    });
    expect(plan).toMatchObject({
      enabled: true,
      requestMesh: false,
      requestScalar: true,
      requestVectors: true,
      query: {
        quality: "interactive",
        resolution_x: 512,
        resolution_y: 256,
        vector_budget: 2_000,
      },
    });
  });

  it("keeps the exact view scope and revision identity on the shared query", () => {
    const plan = buildFieldMapDataPlan({
      active: true,
      component: "normal",
      expectedFieldRevision: 17,
      expectedMeshRevision: 8,
      expectedMonitorRevision: 5,
      includeMesh: true,
      monitorId: "plane-1",
      quantityId: "m",
      resolution: [128, 64],
      showVectors: true,
      snapshotId: "snapshot-4",
      stageId: "stage-2",
      viewScope: { kind: "mesh_part", scope_id: "part-7" },
    });

    expect(plan.query).toMatchObject({
      expected_field_revision: 17,
      expected_mesh_revision: 8,
      expected_monitor_revision: 5,
      scope_id: "part-7",
      scope_kind: "mesh_part",
      snapshot_id: "snapshot-4",
      stage_id: "stage-2",
    });
  });

  it.each([
    [{ kind: "monitor_target" as const }, undefined],
    [{ kind: "airbox" as const }, undefined],
    [{ kind: "mesh_part" as const, scope_id: "part-7" }, "part-7"],
  ])("preserves the supported %s scope without inventing a fallback id", (viewScope, scopeId) => {
    const plan = buildFieldMapDataPlan({
      active: true,
      component: "magnitude",
      includeMesh: false,
      monitorId: "plane-1",
      quantityId: "m",
      resolution: [32, 32],
      showVectors: false,
      viewScope,
    });

    expect(plan.query.scope_kind).toBe(viewScope.kind);
    expect(plan.query.scope_id).toBe(scopeId);
  });

  it("fails closed with an explicit not-applicable state for FDM mesh-part and airbox scopes", () => {
    for (const viewScope of [
      { kind: "mesh_part" as const, scope_id: "part-7" },
      { kind: "airbox" as const },
    ]) {
      const plan = buildFieldMapDataPlan({
        active: true,
        component: "magnitude",
        discretization: "fdm",
        includeMesh: true,
        monitorId: "plane-1",
        quantityId: "m",
        resolution: [32, 32],
        showVectors: true,
        viewScope,
      });

      expect(plan).toMatchObject({
        availability: "not-applicable",
        enabled: false,
        requestMask: false,
        requestMesh: false,
        requestScalar: false,
        requestVectors: false,
      });
      expect(plan.unavailableReason).toContain("structured FDM grid");
    }
  });

  it("adds probe coordinates without dropping raster identity", () => {
    const query = {
      component: "normal",
      expected_field_revision: 17,
      expected_mesh_revision: 8,
      expected_monitor_revision: 5,
      include_mesh: true,
      quality: "interactive",
      resolution_x: 128,
      resolution_y: 64,
      scope_id: "part-7",
      scope_kind: "mesh_part",
      snapshot_id: "snapshot-4",
      stage_id: "stage-2",
      vector_budget: 2_000,
    };

    expect(buildFieldMapProbeQuery(query, 1.25, -0.5)).toEqual({
      ...query,
      u_m: 1.25,
      v_m: -0.5,
    });
  });
});
