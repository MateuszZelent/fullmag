import { describe, expect, it } from "vitest";

import type {
  DomainMetaResource,
  FdmRegionMembershipResource,
  MeshSharedDomainManifestResource,
} from "@/kernel/api/apiTypes";
import type { DecodedTopology } from "@/kernel/api/codecs";

import {
  FMRM_INACTIVE_REGION_ID,
  buildDomainPresentation,
  domainPresentationKey,
  isFdmDomain,
  isFemDomain,
  resolveFdmCellState,
} from "./domainPresentation";

function fdmMeta(overrides: Partial<DomainMetaResource> = {}): DomainMetaResource {
  return {
    bounds: { min: [0, 0, 0], max: [4, 2, 1] },
    coordinate_system: "cartesian",
    counts: { cells: 8 },
    dimension: 3,
    discretization: "fdm",
    domain_id: "domain:fdm",
    generation_id: "generation-7",
    grid: { origin: [0, 0, 0], shape: [2, 2, 2], spacing: [2, 1, 0.5] },
    units: { length: "m" },
    ...overrides,
  };
}

function membership(
  overrides: Partial<FdmRegionMembershipResource> = {},
): FdmRegionMembershipResource {
  return {
    binary_path: "data/fdm-membership.v2.bin",
    cell_count: 8,
    cell_m: [2, 1, 0.5],
    counts: [2, 2, 2],
    encoding: "u32le",
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
    schema_version: "fdm_region_membership.v1",
    ...overrides,
  };
}

function femManifest(): MeshSharedDomainManifestResource {
  return {
    mesh_id: "mesh:shared-domain",
    mesh_name: "shared-domain",
    mesh_parts: [
      {
        boundary_face_count: 0,
        boundary_face_start: 0,
        element_count: 1,
        element_start: 0,
        id: "part:airbox",
        label: "Airbox",
        node_count: 4,
        node_start: 0,
        role: "air",
      },
    ],
    revision: 21,
    topology_fingerprint: "fem-topology-fingerprint",
  };
}

function topology(): DecodedTopology {
  return {
    boundaryFaceCount: 0,
    boundaryFaces: new Uint32Array(),
    boundaryMarkers: new Uint32Array(),
    elementCount: 0,
    elementMarkers: new Uint32Array(),
    indices: new Uint32Array(),
    nodeCount: 0,
    positions: new Float64Array(),
  };
}

describe("domain presentation boundary", () => {
  it("presents an FDM authored grid without requiring a FEM manifest", () => {
    const presentation = buildDomainPresentation({
      domainMeta: fdmMeta(),
      fdmMembershipStatus: "ready",
      fdmMembership: null,
    });

    expect(presentation).toMatchObject({
      discretization: "fdm",
      resourceStatus: "authoring-grid",
      fdmGrid: {
        descriptor: { shape: [2, 2, 2], origin: [0, 0, 0], spacing: [2, 1, 0.5] },
        membership: null,
        totalCells: 8,
      },
      femTopology: null,
      universeOutsideMagneticSupport: null,
    });
    expect(isFdmDomain(presentation)).toBe(true);
    expect(isFemDomain(presentation)).toBe(false);
  });

  it("marks a current FDM membership as realized and preserves its fingerprint", () => {
    const presentation = buildDomainPresentation({
      domainMeta: fdmMeta(),
      expectedFdmGridFingerprint: "grid-fingerprint-7",
      fdmMembership: membership({
        magnetic_support: {
          active_cell_count: 6,
          active_unassigned_cell_count: 1,
          bounds_max_m: [3, 2, 1],
          bounds_min_m: [1, 0, 0],
          grid_fingerprint: "grid-fingerprint-7",
          inactive_cell_count: 2,
          semantic_role: "magnetic-support",
        },
      }),
      fdmMembershipStatus: "ready",
    });

    expect(presentation.resourceStatus).toBe("realized");
    expect(presentation.revision).toBe("generation-7:11:12");
    expect(presentation.fingerprint).toBe("grid-fingerprint-7");
    if (!isFdmDomain(presentation)) throw new Error("expected FDM presentation");
    expect(presentation.fdmGrid.membership?.region_legend[0]?.region_id).toBe(
      "region:core",
    );
    expect(presentation.magneticSupport).toEqual({
      activeCellCount: 6,
      activeUnassignedCellCount: 1,
      bounds: { min: [1, 0, 0], max: [3, 2, 1] },
      inactiveCellCount: 2,
      kind: "magnetic-support",
    });
    expect(presentation.universeOutsideMagneticSupport).toEqual({
      bounds: { min: [0, 0, 0], max: [4, 2, 1] },
      kind: "universe-outside-magnetic-support",
      reason: "validated-magnetic-support-with-inactive-cells",
    });
  });

  it("rejects a magnetic-support summary whose counts or bounds do not match the current domain", () => {
    const invalidSupports: Array<
      NonNullable<FdmRegionMembershipResource["magnetic_support"]>
    > = [
      {
        active_cell_count: 7,
        active_unassigned_cell_count: 0,
        bounds_max_m: [3, 2, 1],
        bounds_min_m: [1, 0, 0],
        grid_fingerprint: "grid-fingerprint-7",
        inactive_cell_count: 2,
        semantic_role: "magnetic-support",
      },
      {
        active_cell_count: 6,
        active_unassigned_cell_count: 0,
        bounds_max_m: [5, 2, 1],
        bounds_min_m: [1, 0, 0],
        grid_fingerprint: "grid-fingerprint-7",
        inactive_cell_count: 2,
        semantic_role: "magnetic-support",
      },
    ];
    for (const magnetic_support of invalidSupports) {
      const presentation = buildDomainPresentation({
        domainMeta: fdmMeta(),
        fdmMembership: membership({ magnetic_support }),
        fdmMembershipStatus: "ready",
      });
      if (!isFdmDomain(presentation)) throw new Error("expected FDM presentation");
      expect(presentation.magneticSupport).toBeNull();
    }
  });

  it("keeps an explicitly supplied universe-outside-support role separate from membership", () => {
    const presentation = buildDomainPresentation({
      domainMeta: fdmMeta(),
      fdmMembership: membership(),
      fdmMembershipStatus: "ready",
      universeOutsideMagneticSupport: {
        bounds: { min: [0, 0, 0], max: [4, 2, 1] },
        reason: "backend-declared-universe-outside-magnetic-support",
      },
    });

    if (!isFdmDomain(presentation)) throw new Error("expected FDM presentation");
    expect(presentation.universeOutsideMagneticSupport).toMatchObject({
      kind: "universe-outside-magnetic-support",
      reason: "backend-declared-universe-outside-magnetic-support",
    });
    expect(presentation.airbox).toBeNull();
  });

  it("preserves explicit FDM resource loading, stale, and error states", () => {
    for (const status of ["loading", "stale", "error"] as const) {
      expect(
        buildDomainPresentation({
          domainMeta: fdmMeta(),
          fdmMembership: membership(),
          fdmMembershipStatus: status,
        }).resourceStatus,
      ).toBe(status);
    }
  });

  it("preserves explicit FEM topology loading while retaining prior topology", () => {
    const presentation = buildDomainPresentation({
      domainMeta: {
        ...fdmMeta(),
        discretization: "fem",
        domain_id: "domain:fem",
        grid: null,
      },
      femManifest: femManifest(),
      femTopology: topology(),
      femTopologyStatus: "loading",
    });

    expect(presentation.resourceStatus).toBe("loading");
  });

  it("carries domain units into both FDM and FEM presentations", () => {
    const units = { length: "nm", magnetization: "A/m" };
    const fdm = buildDomainPresentation({ domainMeta: fdmMeta({ units }) });
    expect(fdm.units).toEqual(units);

    const fem = buildDomainPresentation({
      domainMeta: {
        ...fdmMeta({ units }),
        discretization: "fem",
        grid: null,
      },
      femManifest: femManifest(),
      femTopology: topology(),
      femTopologyStatus: "ready",
    });
    expect(fem.units).toEqual(units);
  });

  it("presents FEM shared-domain topology independently of FDM grid data", () => {
    const manifest = femManifest();
    const presentation = buildDomainPresentation({
      domainMeta: {
        ...fdmMeta(),
        discretization: "fem",
        domain_id: "domain:fem",
        grid: null,
      },
      femManifest: manifest,
      femTopology: topology(),
      femTopologyStatus: "ready",
    });

    expect(presentation).toMatchObject({
      discretization: "fem",
      resourceStatus: "realized",
      fdmGrid: null,
      femTopology: {
        manifest,
        topology: expect.any(Object),
        topologyFingerprint: "fem-topology-fingerprint",
      },
      airbox: { kind: "shared-domain-airbox" },
    });
    expect(isFemDomain(presentation)).toBe(true);
    expect(isFdmDomain(presentation)).toBe(false);
  });

  it("fails closed for stale, missing, and incompatible FDM membership", () => {
    expect(
      buildDomainPresentation({
        domainMeta: fdmMeta(),
        fdmMembership: membership({ freshness: "stale" }),
        fdmMembershipStatus: "ready",
      }).resourceStatus,
    ).toBe("stale");
    expect(
      buildDomainPresentation({
        domainMeta: fdmMeta(),
        fdmMembership: null,
        fdmMembershipStatus: "loading",
      }).resourceStatus,
    ).toBe("loading");
    expect(
      buildDomainPresentation({
        domainMeta: fdmMeta(),
        expectedFdmGridFingerprint: "different-grid",
        fdmMembership: membership(),
        fdmMembershipStatus: "ready",
      }).resourceStatus,
    ).toBe("incompatible");
  });

  it("classifies the canonical inactive sentinel and active legend/unassigned cells", () => {
    const descriptor = membership();

    expect(resolveFdmCellState(FMRM_INACTIVE_REGION_ID, descriptor)).toEqual({
      kind: "inactive",
      numericRegionId: null,
      regionId: null,
    });
    expect(resolveFdmCellState(7, descriptor)).toMatchObject({
      kind: "region",
      numericRegionId: 7,
      regionId: "region:core",
    });
    expect(resolveFdmCellState(0, descriptor)).toEqual({
      kind: "active-unassigned",
      numericRegionId: 0,
      regionId: null,
    });
  });

  it("keys presentations by domain and realized resource identity", () => {
    const presentation = buildDomainPresentation({
      domainMeta: fdmMeta(),
      fdmMembership: membership(),
      fdmMembershipStatus: "ready",
    });

    expect(domainPresentationKey(presentation)).toBe(
      "fdm:domain:fdm:generation-7:grid-fingerprint-7:11:12",
    );
  });
});
