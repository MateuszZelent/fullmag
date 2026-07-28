import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { MeshPolicyDiffRow } from "@/shared/domain/mesh/meshPolicyDiff";

import { MeshBuildParameterDiff } from "./MeshBuildParameterDiff";

describe("MeshBuildParameterDiff", () => {
  it("shows element layers, node planes, and canonical layered topology labels", () => {
    const rows: MeshPolicyDiffRow[] = [
      {
        currentValue: "unset",
        draftValue: "1",
        impact: "geometry",
        label: "through_thickness_elements",
        path: "through_thickness_elements",
        realizedValue: "unset",
        scope: "object",
        state: "changed",
      },
      {
        currentValue: "tetrahedral",
        draftValue: "prismatic",
        impact: "geometry",
        label: "topology",
        path: "topology",
        realizedValue: "tetrahedral",
        scope: "object",
        state: "changed",
      },
    ];

    const html = renderToStaticMarkup(<MeshBuildParameterDiff rows={rows} />);

    expect(html).toContain("Element layers / node planes");
    expect(html).toContain("1 layer / 2 node planes");
    expect(html).toContain("Requested topology");
  });

  it("renders current new realized and impact columns", () => {
    const rows: MeshPolicyDiffRow[] = [
      {
        currentValue: "2e-8",
        draftValue: "1e-8",
        impact: "resolution",
        label: "airbox_hmax",
        path: "airbox_hmax",
        realizedValue: "2e-8",
        scope: "airbox",
        state: "changed",
      },
    ];

    const html = renderToStaticMarkup(<MeshBuildParameterDiff rows={rows} />);

    expect(html).toContain("Scope");
    expect(html).toContain("Parameter");
    expect(html).toContain("Current");
    expect(html).toContain("New");
    expect(html).toContain("Last realized");
    expect(html).toContain("Impact");
    expect(html).toContain("airbox_hmax");
    expect(html).toContain("resolution");
  });
});
