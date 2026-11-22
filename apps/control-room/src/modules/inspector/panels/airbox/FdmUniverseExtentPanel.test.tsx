import { describe, expect, it } from "vitest";

import { buildDomainPresentation } from "@/shared/domain/mesh/domainPresentation";

import { resolveFdmUniverseExtentModel } from "./fdmUniverseExtentModel";

describe("fdmUniverseExtentModel", () => {
  it("resolves the shared Airbox product surface without inferring an unsupported role", () => {
    const model = resolveFdmUniverseExtentModel({
      explicitFdm: true,
      resource: {
        data: {
          bounds: { min: [0, 0, 0], max: [4, 2, 1] },
          coordinate_system: "cartesian",
          counts: { cells: 8, elements: null, nodes: null, boundary_faces: null },
          dimension: 3,
          discretization: "fdm",
          domain_id: "domain:fdm",
          element_type: null,
          generation_id: "generation-1",
          grid: { origin: [0, 0, 0], shape: [4, 2, 1], spacing: [1, 1, 1] },
          units: { length: "m" },
        },
        error: null,
        status: "ready",
      },
    });

    expect(model.status).toBe("ready");
    expect(model.universeRole).toBeNull();
    expect(model.universeRoleSource).toBeNull();
    expect(model.gridShape).toEqual([4, 2, 1]);
  });

  it("shows a published role only when an identity-matched DomainPresentation supplies it", () => {
    const domain = {
      bounds: { min: [0, 0, 0], max: [4, 2, 1] },
      coordinate_system: "cartesian",
      counts: { cells: 8, elements: null, nodes: null, boundary_faces: null },
      dimension: 3,
      discretization: "fdm",
      domain_id: "domain:fdm",
      element_type: null,
      generation_id: "generation-1",
      grid: { origin: [0, 0, 0], shape: [4, 2, 1], spacing: [1, 1, 1] },
      units: { length: "m" },
    };
    const presentation = buildDomainPresentation({
      domainMeta: domain,
      universeOutsideMagneticSupport: {
        bounds: {
          min: [0, 0, 0],
          max: [4, 2, 1],
        },
        reason: "published by the domain resource",
      },
    });
    const model = resolveFdmUniverseExtentModel({
      explicitFdm: true,
      resource: { data: domain, error: null, status: "ready" },
      roleEvidence: { source: "domain-presentation", presentation },
    });

    expect(model.universeRole?.reason).toBe("published by the domain resource");
    expect(model.universeRoleSource).toBe("domain-presentation");
  });

  it("reports loading state while the FDM DomainMeta is unavailable", () => {
    const model = resolveFdmUniverseExtentModel({
      explicitFdm: true,
      resource: { data: null, error: null, status: "loading" },
    });
    expect(model.status).toBe("loading");
  });
});
