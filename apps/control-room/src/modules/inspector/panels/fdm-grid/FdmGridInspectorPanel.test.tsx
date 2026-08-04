import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FdmGridInspectorPanelView } from "./FdmGridInspectorPanel";
import type { FdmGridInspectorModel } from "./fdmGridInspectorModel";

function readyModel(): FdmGridInspectorModel {
  return {
    cellClassification: "unknown",
    domainId: "domain:fdm",
    generationId: "generation-7",
    membership: {
      encoding: "u32le-v2",
      freshness: "current",
      gridFingerprint: "grid-fingerprint-7",
      legend: [
        {
          numericId: 7,
          objectId: "object:core",
          priority: 0,
          regionId: "region:core",
        },
      ],
      meshRevision: 11,
      regionMembershipRevision: 12,
    },
    notice: null,
    origin: [0, 0, 0],
    shape: [2, 3, 4],
    spacing: [2, 1, 0.5],
    status: "ready",
    statusLabel: "Realized",
    totalCells: 24,
    units: { length: "m", time: "s" },
  };
}

describe("FdmGridInspectorPanelView", () => {
  it("renders structured-grid facts and membership provenance without FEM policy controls", () => {
    const html = renderToStaticMarkup(
      <FdmGridInspectorPanelView model={readyModel()} />,
    );

    expect(html).toContain("Structured Grid");
    expect(html).toContain("2 × 3 × 4");
    expect(html).toContain("Origin");
    expect(html).toContain("Spacing");
    expect(html).toContain("Total cells");
    expect(html).toContain("u32le-v2");
    expect(html).toContain("grid-fingerprint-7");
    expect(html).toContain("region:core");
    expect(html).not.toMatch(/Gmsh|hmax|hmin|tet|quality|Build|Airbox|shared-domain/i);
  });

  it("renders an explicit not-materialized state rather than inventing a mask", () => {
    const model = readyModel();
    model.membership = null;
    model.status = "not-materialized";
    model.statusLabel = "Not materialized";
    model.notice = "FDM region membership is not materialized.";

    const html = renderToStaticMarkup(
      <FdmGridInspectorPanelView model={model} />,
    );

    expect(html).toContain("Not materialized");
    expect(html).toContain("FDM region membership is not materialized.");
    expect(html).toContain("Unknown until the membership resource is available");
    expect(html).not.toContain("Active cells");
    expect(html).not.toContain("Air cells");
  });
});
