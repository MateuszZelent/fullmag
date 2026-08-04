import { describe, expect, it } from "vitest";

import type {
  DomainMetaResource,
  FdmRegionMembershipResource,
} from "@/kernel/api/apiTypes";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";

import {
  resolveFdmGridInspectorModel,
  type FdmGridInspectorResources,
} from "./fdmGridInspectorModel";

function domainMeta(
  overrides: Partial<DomainMetaResource> = {},
): DomainMetaResource {
  return {
    bounds: { min: [0, 0, 0], max: [4, 3, 2] },
    coordinate_system: "cartesian",
    counts: { cells: 24 },
    dimension: 3,
    discretization: "fdm",
    domain_id: "domain:fdm",
    generation_id: "generation-7",
    grid: {
      origin: [0, 0, 0],
      shape: [2, 3, 4],
      spacing: [2, 1, 0.5],
    },
    units: { length: "m", time: "s" },
    ...overrides,
  };
}

function membership(
  overrides: Partial<FdmRegionMembershipResource> = {},
): FdmRegionMembershipResource {
  return {
    binary_path: "data/fdm-membership.v2.bin",
    cell_count: 24,
    cell_m: [2, 1, 0.5],
    counts: [2, 3, 4],
    encoding: "u32le-v2",
    freshness: "current",
    grid_fingerprint: "grid-fingerprint-7",
    mesh_revision: 11,
    origin_m: [0, 0, 0],
    region_legend: [
      {
        numeric_id: 7,
        object_id: "object:core",
        priority: 0,
        region_id: "region:core",
      },
    ],
    region_membership_revision: 12,
    schema_version: "fdm_region_membership.v2",
    ...overrides,
  };
}

function resource<T>(
  data: T | null,
  status: ResourceResult<T>['status'] = "ready",
): ResourceResult<T> {
  return {
    data,
    error: status === "error" ? new Error("resource failed") : null,
    refetch: () => undefined,
    revision: "revision-1",
    status,
  };
}

function resources(
  overrides: Partial<FdmGridInspectorResources> = {},
): FdmGridInspectorResources {
  return {
    domain: resource(domainMeta()),
    membership: resource(membership()),
    ...overrides,
  };
}

describe("resolveFdmGridInspectorModel", () => {
  it("exposes structured-grid geometry and realized membership provenance", () => {
    const model = resolveFdmGridInspectorModel(resources());

    expect(model).toMatchObject({
      status: "ready",
      statusLabel: "Realized",
      domainId: "domain:fdm",
      generationId: "generation-7",
      shape: [2, 3, 4],
      origin: [0, 0, 0],
      spacing: [2, 1, 0.5],
      totalCells: 24,
      units: { length: "m", time: "s" },
      membership: {
        freshness: "current",
        encoding: "u32le-v2",
        meshRevision: 11,
        regionMembershipRevision: 12,
        gridFingerprint: "grid-fingerprint-7",
      },
    });
    expect(model.membership?.legend).toEqual([
      {
        numericId: 7,
        objectId: "object:core",
        priority: 0,
        regionId: "region:core",
      },
    ]);
  });

  it("keeps an authored grid visible without claiming that membership is realized", () => {
    const model = resolveFdmGridInspectorModel(
      resources({ membership: resource(null, "ready") }),
    );

    expect(model.status).toBe("not-materialized");
    expect(model.statusLabel).toBe("Not materialized");
    expect(model.totalCells).toBe(24);
    expect(model.membership).toBeNull();
    expect(model.notice).toContain("membership");
  });

  it.each([
    ["loading", "Loading"],
    ["stale", "Stale"],
    ["error", "Error"],
  ] as const)("preserves explicit membership %s state", (status, label) => {
    const model = resolveFdmGridInspectorModel(
      resources({ membership: resource(membership(), status) }),
    );

    expect(model.status).toBe(status);
    expect(model.statusLabel).toBe(label);
    expect(model.membership?.gridFingerprint).toBe("grid-fingerprint-7");
  });

  it("does not hide a stale DomainMeta behind a not-materialized membership state", () => {
    const model = resolveFdmGridInspectorModel(
      resources({
        domain: resource(domainMeta(), "stale"),
        membership: resource(null, "ready"),
      }),
    );

    expect(model.status).toBe("stale");
    expect(model.notice).toContain("DomainMeta");
  });

  it("fails closed for FEM and does not expose a synthetic FDM grid", () => {
    const model = resolveFdmGridInspectorModel(
      resources({
        domain: resource(domainMeta({ discretization: "fem", grid: null })),
      }),
    );

    expect(model.status).toBe("not-applicable");
    expect(model.shape).toBeNull();
    expect(model.totalCells).toBeNull();
    expect(model.membership).toBeNull();
    expect(model.notice).toContain("FDM");
  });

  it("does not infer active or air cells from a missing membership mask", () => {
    const model = resolveFdmGridInspectorModel(
      resources({ membership: resource(null, "idle") }),
    );

    expect(model.status).toBe("not-materialized");
    expect(model.cellClassification).toBe("unknown");
  });
});
