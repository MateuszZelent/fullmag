import { readFileSync } from "node:fs";

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
        source: { kind: "monitor", monitorId: "plane-1" },
        quality: "interactive",
        quantityId: "m",
        resolution: [512, 256],
        showVectors: true,
        vectorBudget: 2_000,
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
      source: { kind: "monitor", monitorId: "plane-1" },
      quality: "export",
      quantityId: "m",
      resolution: [512, 256],
      showVectors: true,
      vectorBudget: 768,
    });
    expect(plan).toMatchObject({
      enabled: true,
      requestMesh: false,
      requestScalar: true,
      requestVectors: true,
      query: {
        quality: "export",
        resolution_x: 512,
        resolution_y: 256,
        vector_budget: 768,
      },
    });
  });

  it("does not substitute scene or global field revisions for exact sample revisions", () => {
    const sceneRevision = "101";
    const monitorRevision = "202";
    const globalFieldRevision = "303";
    const quantityRevision = "404";
    expect(sceneRevision).not.toBe(monitorRevision);
    expect(globalFieldRevision).not.toBe(quantityRevision);
    const plan = buildFieldMapDataPlan({
      active: true,
      component: "normal",
      ...{
        expectedFieldRevision: globalFieldRevision,
        expectedMonitorRevision: sceneRevision,
      },
      includeMesh: true,
      source: { kind: "monitor", monitorId: "plane-1" },
      quality: "interactive",
      quantityId: "m",
      resolution: [128, 64],
      showVectors: true,
      snapshotId: "snapshot-4",
      stageId: "stage-2",
      viewScope: { kind: "mesh_part", scope_id: "part-7" },
      vectorBudget: 2_000,
    });

    expect(plan.query).toMatchObject({
      scope_id: "part-7",
      scope_kind: "mesh_part",
      snapshot_id: "snapshot-4",
      stage_id: "stage-2",
    });
    expect(plan.query).not.toHaveProperty("expected_field_revision");
    expect(plan.query).not.toHaveProperty("expected_monitor_revision");
  });

  it("gates binary resources on the canonical metadata sample", () => {
    const source = readFileSync(
      new URL("../FieldMapModule.tsx", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("status.data?.resources.field_revision");
    expect(source).not.toContain("monitor.data?.scene_revision");
    expect(source).toContain("planarFieldQueryFromMeta(");
    expect(source).toContain("plan.quantityId");
    expect(source).toContain("plan.source");
    expect(source).toContain("meta.data");
    expect(source).toContain("canonicalSample?.ok ? canonicalSample.query : null");
    expect(source).toContain("const canonicalSampleReady = canonicalQuery !== null");
    expect(source).toContain("canonicalSampleError");
    expect(source).toContain("canonicalSampleError !== null");
    expect(source).toContain("canonicalSampleError?.message");
    expect(source.match(/canonicalSampleReady/g)).toHaveLength(6);
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
      source: { kind: "monitor", monitorId: "plane-1" },
      quality: "interactive",
      quantityId: "m",
      resolution: [32, 32],
      showVectors: false,
      vectorBudget: 2_000,
      viewScope,
    });

    expect(plan.query.scope_kind).toBe(viewScope.kind);
    expect(plan.query.scope_id).toBe(scopeId);
  });

  it("enables a fresh default source without requiring a monitor id", () => {
    const plan = buildFieldMapDataPlan({
      active: true,
      component: "magnitude",
      includeMesh: false,
      source: { kind: "default" },
      quality: "interactive",
      quantityId: "m",
      resolution: [32, 32],
      showVectors: false,
      vectorBudget: 256,
    });

    expect(plan).toMatchObject({
      availability: "ready",
      enabled: true,
      source: { kind: "default" },
    });
    expect(plan).not.toHaveProperty("monitorId");
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
        source: { kind: "monitor", monitorId: "plane-1" },
        quality: "interactive",
        quantityId: "m",
        resolution: [32, 32],
        showVectors: true,
        viewScope,
        vectorBudget: 2_000,
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
      expected_field_revision: "9007199254741001",
      expected_mesh_revision: "9007199254741002",
      expected_monitor_revision: "9007199254741003",
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

  it("requests mesh overlay for FEM discretization even when includeMesh is false", () => {
    const plan = buildFieldMapDataPlan({
      active: true,
      component: "magnitude",
      discretization: "fem",
      includeMesh: false,
      source: { kind: "default" },
      quality: "interactive",
      quantityId: "m",
      resolution: [32, 32],
      showVectors: false,
      vectorBudget: 0,
    });
    expect(plan.requestMesh).toBe(true);
    expect(plan.query.include_mesh).toBe(true);
  });
});
