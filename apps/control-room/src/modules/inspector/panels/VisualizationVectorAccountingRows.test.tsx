import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/kernel/visualization/useVisualizationDebug", () => ({
  useVisualizationDebugSnapshots: () => [],
}));

vi.mock("@/modules/viewport-3d/public", () => ({
  useViewport3DRenderedVectorAdoption: () => ({
    carrierId: "object:film",
    fieldBufferId: "field-buffer:current",
    itemCount: 2_130,
    requestScopeEpoch: "scope-4",
    resourceKey: "field-resource:current",
    sessionEpoch: "session-2",
    sessionId: "session-1",
    targetId: "object:film",
    vectorBuildKey: "fdm-vector:current-generation",
  }),
}));

import { VisualizationVectorAccountingRows } from "./VisualizationVectorAccountingRows";

const source = readFileSync(
  join(process.cwd(), "src/modules/inspector/panels/VisualizationVectorAccountingRows.tsx"),
  "utf8",
);

describe("VisualizationVectorAccountingRows performance contract", () => {
  it("does not request or scan debug statistics when the ordinary inspector mounts", () => {
    expect(source).not.toContain("controller.request(");
    expect(source).not.toContain("scanFieldVectorDebugStatistics");
    expect(source).toContain("useVisualizationDebugSnapshots");
  });

  it("renders distinct available, requested, effective, decoded and adopted accounting rows", () => {
    expect(source).toContain("Available vector anchors");
    expect(source).toContain("Requested budget");
    expect(source).toContain("Effective scene allocation");
    expect(source).toContain("Decoded field samples");
    expect(source).toContain("Adopted arrows");
  });

  it("renders the global scene policy cap as an explicit accounting row", () => {
    expect(source).toContain("Scene policy cap");
  });

  it("passes the expected visualization revision into identity matching", () => {
    expect(source).toContain("expectedVisualizationRevision?:");
    expect(source).toContain("expectedVisualizationRevision: props.expectedVisualizationRevision");
  });

  it("shows the current renderer-adopted arrow count without debug field scans", () => {
    const markup = renderToStaticMarkup(
      <VisualizationVectorAccountingRows
        availableAnchorCount={131_071}
        capacity={null}
        exact
        effectiveAllocation={2_130}
        requestedBudget={2_130}
        sceneCap={16_384}
        targetId="object:film"
        targetKind="object"
      />,
    );

    expect(markup).toContain("Adopted arrows");
    expect(markup).toContain("2,130");
    expect(markup).toContain("Decoded field samples");
    expect(markup).toContain("not reported");
    expect(markup).not.toContain(
      "Vector accounting is not reported for this target.",
    );
  });
});
