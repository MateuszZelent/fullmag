import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildDomainPresentation } from "@/shared/domain/mesh/domainPresentation";

import { FdmUniverseExtentPanelView } from "./FdmUniverseExtentPanel";
import { resolveFdmUniverseExtentModel } from "./fdmUniverseExtentModel";

describe("FdmUniverseExtentPanel", () => {
  it("renders a neutral structured grid extent without inferring an Airbox role", () => {
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

    const html = renderToStaticMarkup(<FdmUniverseExtentPanelView model={model} />);
    expect(html).toContain("Structured FDM universe/grid extent");
    expect(html).toContain("Magnetic-support / universe role");
    expect(html).toContain("not published");
    expect(html).toContain("Grid shape");
    expect(html).toContain("4 × 2 × 1");
    expect(html).toContain("FEM shared-domain controls");
    expect(html).toContain("Not applicable to explicit FDM");
    expect(html).not.toContain("Airbox");
    expect(html).not.toContain("canonical membership mask");
    expect(html).not.toContain("Maximum element size");
    expect(html).not.toContain("Tetrahedralize");
    expect(html).not.toContain("Build Shared-Domain Mesh");
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

    const html = renderToStaticMarkup(<FdmUniverseExtentPanelView model={model} />);
    expect(html).toContain("Universe outside magnetic support");
    expect(html).toContain("domain presentation");
    expect(html).not.toContain("not published");
  });

  it("renders a bounded warning while the FDM DomainMeta is unavailable", () => {
    const model = resolveFdmUniverseExtentModel({
      explicitFdm: true,
      resource: { data: null, error: null, status: "loading" },
    });
    const html = renderToStaticMarkup(<FdmUniverseExtentPanelView model={model} />);
    expect(html).toContain("FDM DomainMeta is loading");
    expect(html).toContain('data-fdm-universe-status="loading"');
    expect(html).not.toContain("Maximum element size");
  });
});
