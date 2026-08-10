import { describe, expect, it } from "vitest";

import type {
  DomainMetaResource,
  FdmRegionMembershipResource,
} from "@/kernel/api/apiTypes";
import {
  FMRM_INACTIVE_REGION_ID,
  type DecodedFdmRegionMembership,
} from "@/kernel/api/codecs/fdmRegionMembershipCodec";

import {
  fdmMeshNotApplicableReason,
  resolveFdmObjectMeshInspectorModel,
  resolveMeshInspectorLane,
  type FdmObjectMeshInspectorResources,
} from "./fdmMeshInspectorModel";

function domain(
  overrides: Partial<DomainMetaResource> = {},
): DomainMetaResource {
  return {
    bounds: { min: [0, 0, 0], max: [4, 3, 2] },
    coordinate_system: "cartesian",
    counts: { cells: 24 },
    dimension: 3,
    discretization: "fdm",
    domain_id: "domain:fdm",
    generation_id: "generation-1",
    grid: { origin: [0, 0, 0], shape: [2, 3, 4], spacing: [2, 1, 0.5] },
    units: { length: "m" },
    ...overrides,
  };
}

function membership(
  overrides: Partial<FdmRegionMembershipResource> = {},
): FdmRegionMembershipResource {
  return {
    binary_path: "mesh/fdm-membership.v2.bin",
    cell_count: 24,
    cell_m: [2, 1, 0.5],
    counts: [2, 3, 4],
    domain_generation_id: "generation-1",
    encoding: "u32le-v2",
    freshness: "current",
    grid_fingerprint: "grid-1",
    mesh_revision: 1,
    origin_m: [0, 0, 0],
    region_legend: [
      { numeric_id: 7, object_id: "object:a", priority: 2, region_id: "region:a" },
      { numeric_id: 9, object_id: "object:b", priority: 1, region_id: "region:b" },
    ],
    region_membership_revision: 2,
    schema_version: "fdm_region_membership.v2",
    ...overrides,
  };
}

function snapshot<T>(
  data: T | null,
  status: "loading" | "ready" | "stale" | "error" = "ready",
) {
  return {
    data,
    error: status === "error" ? new Error("resource failed") : null,
    status,
  } as const;
}

function resources(
  overrides: Partial<FdmObjectMeshInspectorResources> = {},
): FdmObjectMeshInspectorResources {
  return {
    domain: snapshot(domain()),
    membership: snapshot(membership()),
    ...overrides,
  };
}

describe("fdmMeshInspectorModel", () => {
  it("requires an explicit discretization and never infers FDM from missing data", () => {
    expect(resolveMeshInspectorLane(null)).toBe("unknown");
    expect(resolveMeshInspectorLane(undefined)).toBe("unknown");
    expect(resolveMeshInspectorLane("auto")).toBe("unknown");
    expect(
      resolveFdmObjectMeshInspectorModel({
        lane: "unknown",
        objectId: "object:a",
        resources: resources({ domain: snapshot(null, "loading") }),
      }),
    ).toMatchObject({ status: "not-applicable", readonly: true });
  });

  it("exposes structured-grid semantics and object region metadata", () => {
    const model = resolveFdmObjectMeshInspectorModel({
      lane: "fdm",
      objectId: "object:a",
      resources: resources(),
    });

    expect(model).toMatchObject({
      status: "not-materialized",
      origin: [0, 0, 0],
      shape: [2, 3, 4],
      spacing: [2, 1, 0.5],
      totalCells: 24,
      participation: "descriptor-only",
      metadata: [{ numericId: 7, objectId: "object:a", regionId: "region:a" }],
      readonly: true,
    });
    expect(model.notice).toContain("binary region membership is not materialized");
  });

  it("counts canonical mask participation and rejects legacy mask semantics", () => {
    const canonical: DecodedFdmRegionMembership = {
      counts: [2, 3, 4],
      cellCount: 24,
      formatVersion: 2,
      gridFingerprint: "grid-1",
      legendCount: 2,
      payloadKind: 2,
      regionIds: new Uint32Array([7, 7, 9, 0xffff_ffff, ...new Array(20).fill(0)]),
      semanticStatus: "canonical",
    };
    const ready = resolveFdmObjectMeshInspectorModel({
      lane: "fdm",
      objectId: "object:a",
      resources: resources({ binary: snapshot(canonical) }),
    });
    expect(ready).toMatchObject({
      participation: "canonical-mask",
      activeCellCount: 2,
      inactiveCellCount: 1,
    });

    const legacy = resolveFdmObjectMeshInspectorModel({
      lane: "fdm",
      objectId: "object:a",
      resources: resources({
        binary: snapshot({ ...canonical, semanticStatus: "legacy-ambiguous" }),
      }),
    });
    expect(legacy).toMatchObject({
      participation: "legacy-ambiguous",
      activeCellCount: null,
      inactiveCellCount: null,
      status: "not-materialized",
    });
  });

  it("scopes canonical participation to the selected authored region", () => {
    const canonical: DecodedFdmRegionMembership = {
      counts: [2, 3, 4],
      cellCount: 24,
      formatVersion: 2,
      gridFingerprint: "grid-1",
      legendCount: 2,
      payloadKind: 2,
      regionIds: new Uint32Array([
        9,
        9,
        FMRM_INACTIVE_REGION_ID,
        ...new Array(21).fill(FMRM_INACTIVE_REGION_ID),
      ]),
      semanticStatus: "canonical",
    };

    const selected = resolveFdmObjectMeshInspectorModel({
      lane: "fdm",
      objectId: "object:b",
      regionId: "region:b",
      resources: resources({ binary: snapshot(canonical) }),
    });

    expect(selected).toMatchObject({
      status: "ready",
      participation: "canonical-mask",
      activeCellCount: 2,
      inactiveCellCount: 22,
      metadata: [{ numericId: 9, objectId: "object:b", regionId: "region:b" }],
    });
  });

  it("keeps duplicate region ids scoped to the selected object owner", () => {
    const duplicateOwnerMembership = membership({
      region_legend: [
        { numeric_id: 7, object_id: "object:a", priority: 0, region_id: "region:shared" },
        { numeric_id: 9, object_id: "object:b", priority: 0, region_id: "region:shared" },
      ],
    });
    const canonical: DecodedFdmRegionMembership = {
      counts: [2, 3, 4],
      cellCount: 24,
      formatVersion: 2,
      gridFingerprint: "grid-1",
      legendCount: 2,
      payloadKind: 2,
      regionIds: new Uint32Array([7, 9, FMRM_INACTIVE_REGION_ID, ...new Array(21).fill(FMRM_INACTIVE_REGION_ID)]),
      semanticStatus: "canonical",
    };

    const model = resolveFdmObjectMeshInspectorModel({
      lane: "fdm",
      objectId: "object:a",
      regionId: "region:shared",
      resources: resources({
        membership: snapshot(duplicateOwnerMembership),
        binary: snapshot(canonical),
      }),
    });

    expect(model.metadata).toEqual([
      { numericId: 7, objectId: "object:a", priority: 0, regionId: "region:shared" },
    ]);
    expect(model.activeCellCount).toBe(1);
  });

  it("fails closed when the selected region is not owned by the selected object", () => {
    const canonical: DecodedFdmRegionMembership = {
      counts: [2, 3, 4],
      cellCount: 24,
      formatVersion: 2,
      gridFingerprint: "grid-1",
      legendCount: 2,
      payloadKind: 2,
      regionIds: new Uint32Array(24),
      semanticStatus: "canonical",
    };

    const mismatch = resolveFdmObjectMeshInspectorModel({
      lane: "fdm",
      objectId: "object:a",
      regionId: "region:b",
      resources: resources({ binary: snapshot(canonical) }),
    });

    expect(mismatch).toMatchObject({
      status: "not-materialized",
      activeCellCount: null,
      inactiveCellCount: null,
      metadata: [],
    });
    expect(mismatch.notice).toContain("Selected FDM region");
  });

  it("withholds classification for stale or mismatched membership", () => {
    const stale = resolveFdmObjectMeshInspectorModel({
      lane: "fdm",
      objectId: "object:a",
      resources: resources({
        membership: snapshot(membership({ freshness: "stale" })),
      }),
    });
    expect(stale).toMatchObject({
      status: "stale",
      activeCellCount: null,
      inactiveCellCount: null,
    });

    const mismatch = resolveFdmObjectMeshInspectorModel({
      lane: "fdm",
      objectId: "object:a",
      resources: resources({
        membership: snapshot(membership({ counts: [2, 3, 2], cell_count: 12 })),
      }),
    });
    expect(mismatch).toMatchObject({
      status: "not-materialized",
      activeCellCount: null,
      inactiveCellCount: null,
    });
    expect(mismatch.notice).toContain("does not match the current grid");
  });

  it("requires a canonical binary identity before reporting ready participation", () => {
    const canonical: DecodedFdmRegionMembership = {
      counts: [2, 3, 4],
      cellCount: 24,
      formatVersion: 2,
      gridFingerprint: "different-grid",
      legendCount: 2,
      payloadKind: 2,
      regionIds: new Uint32Array([7, 7, 9, FMRM_INACTIVE_REGION_ID, ...new Array(20).fill(0)]),
      semanticStatus: "canonical",
    };
    const mismatch = resolveFdmObjectMeshInspectorModel({
      lane: "fdm",
      objectId: "object:a",
      resources: resources({ binary: snapshot(canonical) }),
    });
    expect(mismatch).toMatchObject({
      status: "not-materialized",
      participation: "descriptor-only",
      activeCellCount: null,
      inactiveCellCount: null,
    });

    const loading = resolveFdmObjectMeshInspectorModel({
      lane: "fdm",
      objectId: "object:a",
      resources: resources({
        membership: snapshot(null, "loading"),
      }),
    });
    expect(loading).toMatchObject({ status: "loading", activeCellCount: null });
  });

  it("publishes one explicit not-applicable reason for FEM-only controls", () => {
    expect(fdmMeshNotApplicableReason()).toContain("FEM element order");
    expect(fdmMeshNotApplicableReason()).toContain("Gmsh");
    expect(fdmMeshNotApplicableReason()).toContain("shared-domain");
  });
});
