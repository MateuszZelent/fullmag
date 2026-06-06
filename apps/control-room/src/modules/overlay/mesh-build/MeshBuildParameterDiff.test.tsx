import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { MeshPolicyDiffRow } from "@/shared/domain/mesh/meshPolicyDiff";

import { MeshBuildParameterDiff } from "./MeshBuildParameterDiff";

describe("MeshBuildParameterDiff", () => {
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
