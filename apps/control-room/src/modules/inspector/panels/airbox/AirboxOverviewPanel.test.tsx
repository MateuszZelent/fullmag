import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const kernelMocks = vi.hoisted(() => ({ selection: { set: vi.fn() } }));

vi.mock("@/kernel/KernelContext", () => ({ useKernel: () => kernelMocks }));
vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  useMeshBuildCurrent: () => ({ data: null, status: "idle" }),
  useMeshSharedDomainManifestResource: () => ({ data: null, status: "idle" }),
  useSceneResource: () => ({ data: null, status: "idle" }),
  useUniverseMeshPolicyResource: () => ({ data: { config: null, revision: 0 }, status: "ready" }),
}));
vi.mock("@/kernel/visualization/useVisualizationStateResource", () => ({
  useVisualizationStateResource: () => ({ data: null, status: "idle" }),
}));
vi.mock("./airboxInspectorRuntimeStatus", () => ({
  resolveAirboxInspectorLane: () => "fem",
  useAirboxInspectorRuntimeStatus: () => ({
    authoring: { method: "fem", state: "known", reason: null },
    capabilities: { explicit_topology: false },
    domain: { discretization: "fem" },
    resources: { mesh_build_revision: 0, mesh_revision: 0 },
  }),
}));

import { AirboxOverviewPanel } from "./AirboxOverviewPanel";

describe("AirboxOverviewPanel navigation", () => {
  it("renders Inspector routes as actionable buttons and shows authored versus realized policy separately", () => {
    const html = renderToStaticMarkup(<AirboxOverviewPanel selection={null as never} />);

    expect(html).toContain("<button");
    expect(html).toContain("Mesh Parameters");
    expect(html).toContain("Mesh Build");
    expect(html).toContain("Visualization");
    expect(html).not.toContain("Shortcuts");
    expect(html).toContain("Auto (canonical default)");
    expect(html).toContain("determined after geometry");
    expect(html).toContain("not built");
  });
});
