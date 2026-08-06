import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { FdmRegionMembershipResource } from "@/kernel/api/apiTypes";
import { buildDomainPresentation } from "@/shared/domain/mesh/domainPresentation";

import { FdmUniverseExtentPanelView } from "./FdmUniverseExtentPanel";
import { resolveFdmUniverseExtentModel } from "./fdmUniverseExtentModel";

describe("FdmUniverseExtentPanel", () => {
  it("renders the shared Airbox product surface without inferring an unsupported role", () => {
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
    expect(html).toContain("Airbox · FDM structured universe");
    expect(html).toContain("Airbox role");
    expect(html).toContain("not published");
    expect(html).toContain("Grid shape");
    expect(html).toContain("4 × 2 × 1");
    expect(html).toContain("Airbox execution artifact");
    expect(html).toContain("Published structured-grid artifact");
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
    expect(html).toContain("Airbox outside magnetic support");
    expect(html).toContain("domain presentation");
    expect(html).not.toContain("not published");
  });

  it("keeps multiple ferromagnetic owners and regions visible in the Airbox legend", () => {
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
    const membership = {
      region_legend: [
        { numeric_id: 3, object_id: "magnet-a", priority: 0, region_id: "left" },
        { numeric_id: 8, object_id: "magnet-b", priority: 1, region_id: "right" },
      ],
    } as FdmRegionMembershipResource;

    const html = renderToStaticMarkup(
      <FdmUniverseExtentPanelView membership={membership} model={model} />,
    );
    expect(html).toContain("Magnetic support owners and regions");
    expect(html).toContain("Owner: magnet-a · Region: left · numeric 3 · priority 0");
    expect(html).toContain("Owner: magnet-b · Region: right · numeric 8 · priority 1");
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
