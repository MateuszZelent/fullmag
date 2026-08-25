import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({ lane: "fem" as "fdm" | "fem" }));

vi.mock("./airbox/airboxInspectorRuntimeStatus", () => ({
  isExplicitFdmAirboxRuntime: (status: { activeLaneDiscretization?: string | null } | null) =>
    status?.activeLaneDiscretization === "fdm",
  isExplicitFemAirboxRuntime: (status: { activeLaneDiscretization?: string | null } | null) =>
    status?.activeLaneDiscretization === "fem",
  useAirboxInspectorRuntimeStatus: () => ({
    activeLaneDiscretization: testState.lane,
    capabilities: { explicit_topology: testState.lane === "fem" },
    domain: { discretization: "fdm" },
    resources: { mesh_build_revision: 0, mesh_revision: 0 },
  }),
}));

vi.mock("./airbox/AirboxMeshParametersPanel", () => ({
  AirboxMeshParametersPanel: ({ lane }: { lane?: string }) => (
    <div data-testid="airbox-setup-panel">{lane} policy editor</div>
  ),
}));

import type { Selection } from "@/kernel/selection/selectionTypes";
import { UniverseRootInspectorPanel } from "./ModelTreeOverviewInspectorPanels";

const selection = {
  kind: "universe.root",
  label: "Universe",
  moduleSource: "explorer",
  nodeId: "model:universe",
  objectId: null,
  ref: null,
} satisfies Selection;

describe("UniverseRootInspectorPanel", () => {
  it("offers FEM Airbox policy authoring from an otherwise empty universe", () => {
    testState.lane = "fem";

    const html = renderToStaticMarkup(<UniverseRootInspectorPanel selection={selection} />);

    expect(html).toContain("FEM Airbox setup");
    expect(html).toContain("airbox-setup-panel");
    expect(html).toContain("fem policy editor");
  });

  it("does not expose FEM Airbox policy controls on an explicit FDM lane", () => {
    testState.lane = "fdm";

    const html = renderToStaticMarkup(<UniverseRootInspectorPanel selection={selection} />);

    expect(html).not.toContain("FEM Airbox setup");
    expect(html).not.toContain("airbox-setup-panel");
  });
});
