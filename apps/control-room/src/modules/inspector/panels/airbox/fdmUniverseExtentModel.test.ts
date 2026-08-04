import { describe, expect, it } from "vitest";

import { buildDomainPresentation } from "@/shared/domain/mesh/domainPresentation";

import { resolveFdmUniverseExtentModel } from "./fdmUniverseExtentModel";

const fdmDomain = {
  bounds: { min: [-2, -1, 0], max: [2, 3, 0.5] },
  coordinate_system: "cartesian",
  counts: { cells: 24, elements: null, nodes: null, boundary_faces: null },
  dimension: 3,
  discretization: "fdm",
  domain_id: "domain:fdm",
  element_type: null,
  generation_id: "generation-7",
  grid: {
    origin: [-2, -1, 0],
    shape: [4, 3, 2],
    spacing: [1, 4 / 3, 0.25],
  },
  units: { length: "m" },
};

describe("fdmUniverseExtentModel", () => {
  it("exposes a neutral structured extent without inferring a support/universe role", () => {
    const model = resolveFdmUniverseExtentModel({
      explicitFdm: true,
      resource: { data: fdmDomain, error: null, status: "ready" },
    });

    expect(model).toMatchObject({
      boundsMin: [-2, -1, 0],
      boundsMax: [2, 3, 0.5],
      domainId: "domain:fdm",
      generationId: "generation-7",
      gridShape: [4, 3, 2],
      origin: [-2, -1, 0],
      spacing: [1, 4 / 3, 0.25],
      status: "ready",
      totalCells: 24,
      universeRole: null,
      universeRoleSource: null,
    });
    expect(model.notice).toContain("Structured FDM universe/grid extent");
    expect(model.notice).not.toContain("membership mask");
    expect(model.notice).not.toContain("Airbox");
  });

  it("accepts an explicitly identity-matched DomainPresentation role", () => {
    const presentation = buildDomainPresentation({
      domainMeta: fdmDomain,
      universeOutsideMagneticSupport: {
        bounds: {
          min: [-2, -1, 0],
          max: [2, 3, 0.5],
        },
        reason: "backend-published support role",
      },
    });

    const model = resolveFdmUniverseExtentModel({
      explicitFdm: true,
      resource: { data: fdmDomain, error: null, status: "ready" },
      roleEvidence: { source: "domain-presentation", presentation },
    });

    expect(model.universeRole).toMatchObject({
      kind: "universe-outside-magnetic-support",
      reason: "backend-published support role",
    });
    expect(model.universeRoleSource).toBe("domain-presentation");
  });

  it("rejects a role from a different DomainMeta identity", () => {
    const presentation = buildDomainPresentation({
      domainMeta: { ...fdmDomain, generation_id: "generation-other" },
      universeOutsideMagneticSupport: {
        bounds: {
          min: [-2, -1, 0],
          max: [2, 3, 0.5],
        },
        reason: "stale support role",
      },
    });

    const model = resolveFdmUniverseExtentModel({
      explicitFdm: true,
      resource: { data: fdmDomain, error: null, status: "ready" },
      roleEvidence: { source: "domain-presentation", presentation },
    });

    expect(model.universeRole).toBeNull();
    expect(model.universeRoleSource).toBeNull();
  });

  it("accepts an identity-matched bounded explicit role resource", () => {
    const model = resolveFdmUniverseExtentModel({
      explicitFdm: true,
      resource: { data: fdmDomain, error: null, status: "ready" },
      roleEvidence: {
        domainId: "domain:fdm",
        generationId: "generation-7",
        role: {
          bounds: {
            min: [-2, -1, 0],
            max: [2, 3, 0.5],
          },
          kind: "universe-outside-magnetic-support",
          reason: "bounded role resource",
        },
        source: "explicit-role-resource",
      },
    });

    expect(model.universeRoleSource).toBe("explicit-role-resource");
    expect(model.universeRole?.reason).toBe("bounded role resource");
  });

  it("does not derive total cells from the shape when the API count is absent", () => {
    const model = resolveFdmUniverseExtentModel({
      explicitFdm: true,
      resource: {
        data: { ...fdmDomain, counts: { ...fdmDomain.counts, cells: null } },
        error: null,
        status: "ready",
      },
    });

    expect(model.gridShape).toEqual([4, 3, 2]);
    expect(model.totalCells).toBeNull();
  });

  it("does not infer FDM from a missing or errored resource", () => {
    expect(
      resolveFdmUniverseExtentModel({
        explicitFdm: false,
        resource: { data: null, error: null, status: "idle" },
      }).status,
    ).toBe("not-applicable");
    expect(
      resolveFdmUniverseExtentModel({
        explicitFdm: true,
        resource: { data: null, error: null, status: "idle" },
      }).status,
    ).toBe("not-materialized");
    expect(
      resolveFdmUniverseExtentModel({
        explicitFdm: true,
        resource: { data: null, error: new Error("offline"), status: "error" },
      }).status,
    ).toBe("error");
  });

  it("fails closed when the session lane and DomainMeta disagree", () => {
    const model = resolveFdmUniverseExtentModel({
      explicitFdm: true,
      resource: {
        data: { ...fdmDomain, discretization: "fem", grid: null },
        error: null,
        status: "ready",
      },
    });

    expect(model.status).toBe("error");
    expect(model.notice).toContain("Session requested FDM");
  });

  it("keeps a stale grid explicit instead of presenting it as current", () => {
    const model = resolveFdmUniverseExtentModel({
      explicitFdm: true,
      resource: { data: fdmDomain, error: null, status: "stale" },
    });
    expect(model.status).toBe("stale");
  });
});
