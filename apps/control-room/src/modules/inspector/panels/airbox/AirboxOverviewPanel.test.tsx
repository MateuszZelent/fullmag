import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { findElement, installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import {
  AIRBOX_VISUALIZATION_TARGET,
  ObjectVisualizationController,
} from "@/kernel/visualization/ObjectVisualizationController";

const kernelMocks = vi.hoisted(() => ({
  selection: { set: vi.fn() },
  visualization: { getSnapshot: vi.fn(), subscribe: vi.fn() },
  visualizationResource: vi.fn(),
}));

vi.mock("@/kernel/KernelContext", () => ({ useKernel: () => kernelMocks }));
vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  useMeshBuildCurrent: () => ({ data: null, status: "idle" }),
  useMeshSharedDomainManifestResource: () => ({ data: null, status: "idle" }),
  useSceneResource: () => ({ data: null, status: "idle" }),
  useUniverseMeshPolicyResource: () => ({ data: { config: null, revision: 0 }, status: "ready" }),
}));
vi.mock("@/kernel/visualization/useVisualizationStateResource", () => ({
  useVisualizationStateResource: kernelMocks.visualizationResource,
}));
vi.mock("./airboxInspectorRuntimeStatus", () => ({
  matchesAirboxTopologyIdentity: () => false,
  resolveAirboxInspectorLane: () => "fem",
  shouldLoadAirboxMeshManifest: () => true,
  useAirboxInspectorRuntimeStatus: () => ({
    authoring: { method: "fem", state: "known", reason: null },
    capabilities: { explicit_topology: false },
    domain: { discretization: "fem" },
    resources: { mesh_build_revision: 0, mesh_revision: 0 },
  }),
}));

import { AirboxOverviewPanel } from "./AirboxOverviewPanel";

describe("AirboxOverviewPanel", () => {
  let visualization: ObjectVisualizationController;

  beforeEach(() => {
    visualization = new ObjectVisualizationController();
    kernelMocks.visualization.getSnapshot.mockImplementation(() => visualization.getSnapshot());
    kernelMocks.visualization.subscribe.mockImplementation((listener) => visualization.subscribe(listener));
    kernelMocks.visualizationResource.mockReturnValue({ data: null, status: "idle" });
  });

  it("shows the Airbox field and updates on a pending Ribbon change before resource refresh", async () => {
    kernelMocks.visualizationResource.mockReturnValue({
      status: "ready",
      data: {
        active_quantity_id: "m",
        overrides: [],
        quantity: { active_quantity_id: "m" },
        revision: 7,
      },
    });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const activeQuantity = () => findElement(
      container, (element) => element.textContent === "Active quantity", "Active quantity row label",
    ).parentElement?.textContent;

    try {
      await act(async () => root.render(<AirboxOverviewPanel selection={null as never} />));
      expect(activeQuantity()).toBe("Active quantityH_demag");

      await act(async () => {
        visualization.patchTargetPending(AIRBOX_VISUALIZATION_TARGET, { activeQuantityId: "H_eff" }, 7, "ribbon-change");
      });
      expect(activeQuantity()).toBe("Active quantityH_eff");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
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
