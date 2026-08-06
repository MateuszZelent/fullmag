import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  lane: "fdm" as "fdm" | "unknown",
}));

vi.mock("./mesh-details/useMeshDetailsModel", () => ({
  useMeshDetailsModel: () => ({ lane: testState.lane }),
}));
vi.mock("./fdm-grid/FdmGridInspectorPanel", () => ({
  FdmGridInspectorPanel: () => <div data-testid="fdm-mesh-summary">FDM structured Mesh summary</div>,
}));

import type { Selection } from "@/kernel/selection/selectionTypes";
import { MeshDetailsPanel } from "./MeshDetailsPanel";

const selection = {
  kind: "mesh.root",
  label: "Mesh",
  moduleSource: "inspector",
  nodeId: "model:mesh",
  objectId: null,
  ref: null,
} satisfies Selection;

describe("MeshDetailsPanel lane boundary", () => {
  it("renders the shared Mesh summary through the structured-grid adapter in FDM", () => {
    testState.lane = "fdm";
    const html = renderToStaticMarkup(
      <MeshDetailsPanel selection={selection} />,
    );

    expect(html).toContain("FDM structured Mesh summary");
    expect(html).not.toContain("Shared-Domain Mesh");
    expect(html).not.toContain("Mesh Build Pipeline");
  });

  it("withholds FEM sections while the discretization lane is unresolved", () => {
    testState.lane = "unknown";
    const html = renderToStaticMarkup(
      <MeshDetailsPanel selection={selection} />,
    );

    expect(html).toContain("Mesh lane unresolved");
    expect(html).toContain("withheld");
    expect(html).not.toContain("not applicable");
    expect(html).toContain("FEM shared-domain mesh");
    expect(html).not.toContain("Mesh Quality");
    expect(html).not.toContain("Universe Quality JSON");
  });
});
