import { describe, expect, it } from "vitest";

import type {
  DomainMetaResource,
  FdmRegionMembershipResource,
} from "@/kernel/api/apiTypes";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  resolveFdmGridInspectorModel,
  resolveFdmGridSelectionInspectorModel,
  type FdmGridInspectorResources,
} from "./fdmGridInspectorModel";

function domainSelection(
  scope: Extract<NonNullable<Selection["ref"]>, { type: "fdm-domain" }>["scope"],
  regionId?: string,
): Selection {
  const kind = scope === "domain" ? "mesh.grid" : `mesh.grid.${scope}`;
  return {
    kind,
    label: scope,
    moduleSource: null,
    nodeId: `model:mesh:${scope}`,
    objectId: null,
    ref: {
      kind: kind as Extract<NonNullable<Selection["ref"]>, { type: "fdm-domain" }>["kind"],
      nodeId: `model:mesh:${scope}`,
      ...(regionId ? { regionId } : {}),
      scope,
      type: "fdm-domain",
      visualizationTargetId: "fdm-domain",
    },
  };
}

function cellSelection(
  overrides: Partial<Extract<NonNullable<Selection["ref"]>, { type: "fdm-cell" }>> = {},
): Selection {
  return {
    kind: "fdm.cell",
    label: "Cell 5",
    moduleSource: null,
    nodeId: "model:mesh:grid",
    objectId: null,
    ref: {
      cellOrdinal: "5",
      gridFingerprint: "grid-fingerprint-7",
      ijk: [1, 2, 0],
      kind: "fdm.cell",
      maskState: "region",
      membershipRevision: "11:12",
      nodeId: "model:mesh:grid",
      numericRegionId: 7,
      regionId: "region:core",
      type: "fdm-cell",
      visualizationTargetId: "fdm-domain",
      ...overrides,
    },
  };
}

function binaryResource(regionIds: number[] = Array.from({ length: 24 }, (_, index) => index === 5 ? 7 : 0xffff_ffff)) {
  return resource({
    counts: [2, 3, 4] as [number, number, number],
    cellCount: 24,
    formatVersion: 2,
    gridFingerprint: "grid-fingerprint-7",
    legendCount: 1,
    payloadKind: 2,
    regionIds: Uint32Array.from(regionIds),
    semanticStatus: "canonical" as const,
  });
}

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

function membershipWithSupport(
  supportOverrides: Partial<NonNullable<FdmRegionMembershipResource["magnetic_support"]>> = {},
): FdmRegionMembershipResource {
  return membership({
    magnetic_support: {
      active_cell_count: 9,
      active_unassigned_cell_count: 2,
      bounds_max_m: [4, 3, 2],
      bounds_min_m: [0, 0, 0],
      grid_fingerprint: "grid-fingerprint-7",
      inactive_cell_count: 15,
      semantic_role: "magnetic-support",
      ...supportOverrides,
    },
  });
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

describe("resolveFdmGridSelectionInspectorModel", () => {
  it.each([
    ["domain", "FDM Domain"],
    ["descriptor", "Structured Grid Descriptor"],
    ["mask", "Cell Mask"],
    ["provenance", "Grid Provenance"],
  ] as const)("presents the %s selection as a distinct scope", (scope, title) => {
    const detail = resolveFdmGridSelectionInspectorModel({
      base: resolveFdmGridInspectorModel(resources()),
      binary: binaryResource(),
      membership: resources().membership,
      selection: domainSelection(scope),
    });

    expect(detail).toMatchObject({ scope, title, status: "current" });
  });

  it("preserves the selected region id and its canonical legend entry", () => {
    const detail = resolveFdmGridSelectionInspectorModel({
      base: resolveFdmGridInspectorModel(resources()),
      binary: binaryResource(),
      membership: resources().membership,
      selection: domainSelection("region", "region:core"),
    });

    expect(detail).toMatchObject({
      scope: "region",
      status: "current",
      region: {
        numericId: 7,
        objectId: "object:core",
        regionId: "region:core",
      },
    });
  });

  it("fails closed when magnetic-support summary is absent", () => {
    const detail = resolveFdmGridSelectionInspectorModel({
      base: resolveFdmGridInspectorModel(resources()),
      binary: binaryResource(),
      membership: resources().membership,
      selection: domainSelection("magnetic-support"),
    });

    expect(detail).toMatchObject({
      scope: "magnetic-support",
      status: "degraded",
      support: null,
    });
    expect(detail.notice).toContain("not published");
  });

  it.each([
    ["active-unassigned", "Active / Unassigned Cells"],
    ["universe-outside-support", "Universe Outside Magnetic Support"],
  ] as const)("uses the canonical support summary for %s", (scope, title) => {
    const descriptor = membershipWithSupport();
    const membershipSnapshot = resource(descriptor);
    const detail = resolveFdmGridSelectionInspectorModel({
      base: resolveFdmGridInspectorModel(resources({ membership: membershipSnapshot })),
      binary: binaryResource(),
      membership: membershipSnapshot,
      selection: domainSelection(scope),
    });

    expect(detail).toMatchObject({
      scope,
      status: "current",
      title,
      support: {
        activeCellCount: 9,
        activeUnassignedCellCount: 2,
        inactiveCellCount: 15,
      },
    });
  });

  it.each([
    "domain",
    "descriptor",
    "mask",
    "provenance",
    "region",
  ] as const)("withholds magnetic-support facts from the %s scope", (scope) => {
    const descriptor = membershipWithSupport();
    const membershipSnapshot = resource(descriptor);
    const detail = resolveFdmGridSelectionInspectorModel({
      base: resolveFdmGridInspectorModel(resources({ membership: membershipSnapshot })),
      binary: binaryResource(),
      membership: membershipSnapshot,
      selection: domainSelection(
        scope,
        scope === "region" ? "region:core" : undefined,
      ),
    });

    expect(detail.status).toBe("current");
    expect(detail.support).toBeNull();
  });

  it("withholds magnetic-support facts from a verified cell scope", () => {
    const descriptor = membershipWithSupport();
    const membershipSnapshot = resource(descriptor);
    const detail = resolveFdmGridSelectionInspectorModel({
      base: resolveFdmGridInspectorModel(resources({ membership: membershipSnapshot })),
      binary: binaryResource(),
      membership: membershipSnapshot,
      selection: cellSelection(),
    });

    expect(detail).toMatchObject({ status: "current", support: null });
  });

  it("withholds support when the underlying grid resource is stale", () => {
    const descriptor = membershipWithSupport();
    const membershipSnapshot = resource(descriptor);
    const detail = resolveFdmGridSelectionInspectorModel({
      base: resolveFdmGridInspectorModel(
        resources({
          domain: resource(domainMeta(), "stale"),
          membership: membershipSnapshot,
        }),
      ),
      binary: binaryResource(),
      membership: membershipSnapshot,
      selection: domainSelection("magnetic-support"),
    });

    expect(detail).toMatchObject({ status: "stale", support: null });
  });

  it("fails closed when support belongs to a different grid fingerprint", () => {
    const descriptor = membershipWithSupport({
      grid_fingerprint: "different-grid",
    });
    const membershipSnapshot = resource(descriptor);
    const detail = resolveFdmGridSelectionInspectorModel({
      base: resolveFdmGridInspectorModel(resources({ membership: membershipSnapshot })),
      binary: binaryResource(),
      membership: membershipSnapshot,
      selection: domainSelection("magnetic-support"),
    });

    expect(detail).toMatchObject({ status: "degraded", support: null });
  });

  const invalidSupportBoundsCases: Array<[
    string,
    Partial<NonNullable<FdmRegionMembershipResource["magnetic_support"]>>,
  ]> = [
    ["outside grid", { bounds_max_m: [6, 3, 2] }],
    ["misaligned", { bounds_min_m: [0.5, 0, 0] }],
    ["zero active extent", { bounds_max_m: [0, 0, 0] }],
  ];

  it.each(invalidSupportBoundsCases)("fails closed for %s magnetic-support bounds", (_case, supportOverrides) => {
    const descriptor = membershipWithSupport(supportOverrides);
    const membershipSnapshot = resource(descriptor);
    const detail = resolveFdmGridSelectionInspectorModel({
      base: resolveFdmGridInspectorModel(resources({ membership: membershipSnapshot })),
      binary: binaryResource(),
      membership: membershipSnapshot,
      selection: domainSelection("magnetic-support"),
    });

    expect(detail).toMatchObject({ status: "degraded", support: null });
  });

  it("rejects an aligned nanometer bound one cell edge beyond the current grid", () => {
    const nanometerDomain = domainMeta({
      bounds: { min: [0, 0, 0], max: [4e-9, 1e-9, 1e-9] },
      counts: { cells: 4 },
      grid: {
        origin: [0, 0, 0],
        shape: [4, 1, 1],
        spacing: [1e-9, 1e-9, 1e-9],
      },
    });
    const descriptor = membership({
      cell_count: 4,
      cell_m: [1e-9, 1e-9, 1e-9],
      counts: [4, 1, 1],
      magnetic_support: {
        active_cell_count: 1,
        active_unassigned_cell_count: 0,
        bounds_max_m: [5e-9, 1e-9, 1e-9],
        bounds_min_m: [0, 0, 0],
        grid_fingerprint: "grid-fingerprint-7",
        inactive_cell_count: 3,
        semantic_role: "magnetic-support",
      },
    });
    const membershipSnapshot = resource(descriptor);
    const detail = resolveFdmGridSelectionInspectorModel({
      base: resolveFdmGridInspectorModel(
        resources({
          domain: resource(nanometerDomain),
          membership: membershipSnapshot,
        }),
      ),
      binary: binaryResource(),
      membership: membershipSnapshot,
      selection: domainSelection("magnetic-support"),
    });

    expect(detail).toMatchObject({ status: "degraded", support: null });
  });

  it("fails closed when support counts contradict the current descriptor", () => {
    const descriptor = membership({
      magnetic_support: {
        active_cell_count: 20,
        active_unassigned_cell_count: 21,
        bounds_max_m: [4, 3, 2],
        bounds_min_m: [0, 0, 0],
        grid_fingerprint: "grid-fingerprint-7",
        inactive_cell_count: 15,
        semantic_role: "magnetic-support",
      },
    });
    const membershipSnapshot = resource(descriptor);
    const detail = resolveFdmGridSelectionInspectorModel({
      base: resolveFdmGridInspectorModel(resources({ membership: membershipSnapshot })),
      binary: binaryResource(),
      membership: membershipSnapshot,
      selection: domainSelection("magnetic-support"),
    });

    expect(detail).toMatchObject({ status: "degraded", support: null });
  });

  it("publishes a current cell only after descriptor, fingerprint, revision, ordinal, ijk, and mask agree", () => {
    const detail = resolveFdmGridSelectionInspectorModel({
      base: resolveFdmGridInspectorModel(resources()),
      binary: binaryResource(),
      membership: resources().membership,
      selection: cellSelection(),
    });

    expect(detail).toMatchObject({
      scope: "cell",
      status: "current",
      cell: {
        cellOrdinal: "5",
        gridFingerprint: "grid-fingerprint-7",
        ijk: [1, 2, 0],
        maskState: "region",
        membershipRevision: "11:12",
        numericRegionId: 7,
        regionId: "region:core",
      },
    });
  });

  it.each([
    ["fingerprint", { gridFingerprint: "old-grid" }],
    ["revision", { membershipRevision: "11:11" }],
    ["ijk", { ijk: [0, 0, 0] as const }],
    ["mask", { numericRegionId: 9 }],
  ])("marks a cell with a mismatched %s as stale without claiming current facts", (_reason, overrides) => {
    const detail = resolveFdmGridSelectionInspectorModel({
      base: resolveFdmGridInspectorModel(resources()),
      binary: binaryResource(),
      membership: resources().membership,
      selection: cellSelection(overrides),
    });

    expect(detail).toMatchObject({ scope: "cell", status: "stale", cell: null });
    expect(detail.snapshotCell).toMatchObject(overrides);
    expect(detail.notice).toContain("match");
  });
});
