import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  authoring: "fem" as "fdm" | "fem" | null,
  authoringState: "known" as "known" | "loading" | "missing" | "conflict",
  runtime: null as "fdm" | "fem" | null,
  panelLanes: [] as Array<{ lane: string; runtimeLane: string | null }>,
}));

const kernelMocks = vi.hoisted(() => ({
  commands: { execute: vi.fn() },
  layout: { openBottomPanel: vi.fn() },
  selection: { set: vi.fn() },
}));

vi.mock("@/kernel/KernelContext", () => ({ useKernel: () => kernelMocks }));
vi.mock("@/kernel/commands/commandContext", () => ({ createCommandContext: () => ({}) }));

vi.mock("./airbox/airboxInspectorRuntimeStatus", () => ({
  resolveAirboxInspectorAuthoringLane: () => testState.authoring ?? "unresolved",
  resolveAirboxInspectorLane: () => testState.runtime ?? "unresolved",
  useAirboxInspectorRuntimeStatus: () => ({
    authoring: {
      method: testState.authoring,
      state: testState.authoringState,
      reason: testState.authoringState === "missing" ? "Choose FEM or FDM in Study settings." : null,
    },
    capabilities: { explicit_topology: false },
    domain: { discretization: "" },
    resources: { mesh_build_revision: 0, mesh_revision: 0 },
  }),
}));

vi.mock("./airbox/AirboxMeshParametersPanel", () => ({
  AirboxMeshParametersPanel: ({ lane = "fem", runtimeLane = null }: { lane?: string; runtimeLane?: string | null }) => {
    testState.panelLanes.push({ lane, runtimeLane });
    return <div data-testid="airbox-setup-panel">{lane} policy editor</div>;
  },
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
  it("offers accepted FEM policy authoring while requested runtime resolution is unresolved", () => {
    testState.authoring = "fem";
    testState.authoringState = "known";
    testState.runtime = null;
    testState.panelLanes.length = 0;

    const html = renderToStaticMarkup(<UniverseRootInspectorPanel selection={selection} />);

    expect(html).toContain("Outer-domain policy");
    expect(html).toContain("Airbox generation follows the selected demagnetization settings and planner.");
    expect(html).toContain("airbox-setup-panel");
    expect(html).toContain("fem policy editor");
    expect(html).toContain("Open diagnostics");
    expect(testState.panelLanes).toEqual([{ lane: "fem", runtimeLane: null }]);
  });

  it("keeps the FDM policy editor available and routes to Study grid settings before runtime resolution", () => {
    testState.authoring = "fdm";
    testState.authoringState = "known";
    testState.runtime = null;
    testState.panelLanes.length = 0;

    const html = renderToStaticMarkup(<UniverseRootInspectorPanel selection={selection} />);

    expect(html).toContain("fdm policy editor");
    expect(html).toContain("Open FDM grid settings");
    expect(html).not.toContain("FEM Airbox setup");
    expect(testState.panelLanes).toEqual([{ lane: "fdm", runtimeLane: null }]);
  });

  it("offers concrete method and diagnostics routes when no accepted method exists", () => {
    testState.authoring = null;
    testState.authoringState = "missing";
    testState.runtime = null;

    const html = renderToStaticMarkup(<UniverseRootInspectorPanel selection={selection} />);

    expect(html).toContain("Choose FEM or FDM in Study settings.");
    expect(html).toContain("Choose method in New Problem");
    expect(html).toContain("Open Study settings");
    expect(html).toContain("Open diagnostics");
    expect(html).not.toContain("airbox-setup-panel");
  });
});
