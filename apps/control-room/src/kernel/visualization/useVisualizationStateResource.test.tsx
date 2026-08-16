import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { VisualizationRegistrySyncController } from "./VisualizationRegistrySyncController";
import { useVisualizationStateResource } from "./useVisualizationStateResource";

const mocks = vi.hoisted(() => ({
  controller: null as VisualizationRegistrySyncController | null,
  remote: null as Record<string, unknown> | null,
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    cameraRegistry: { observeRemoteState: vi.fn() },
    visualization: { acknowledgePendingTargetPatches: vi.fn() },
    visualizationSync: mocks.controller,
  }),
}));

vi.mock("@/kernel/resources/useResource", () => ({
  useResource: () => ({
    data: mocks.remote,
    error: null,
    refetch: vi.fn(),
    revision: mocks.remote?.revision ?? null,
    status: "ready",
  }),
}));

function PlanarIdentity() {
  const visualization = useVisualizationStateResource();
  const source = (visualization.data as { planar?: { source?: { kind: string; monitor_id?: string } } } | null)?.planar?.source;
  return <output>{source?.kind === "monitor" ? source.monitor_id : source?.kind ?? "none"}</output>;
}

describe("useVisualizationStateResource", () => {
  it("does not expose queued planar identity before the authoritative resource revision updates", () => {
    const controller = new VisualizationRegistrySyncController({
      api: { patch: vi.fn() },
    });
    mocks.controller = controller;
    mocks.remote = {
      planar: { source: { kind: "monitor", monitor_id: "plane-1" } },
      revision: 7,
    };

    controller.queuePatch({ planar: { source: { kind: "monitor", monitor_id: "plane-2" } } });

    expect(renderToStaticMarkup(<PlanarIdentity />)).toContain("plane-1");

    mocks.remote = {
      planar: { source: { kind: "monitor", monitor_id: "plane-2" } },
      revision: 8,
    };

    expect(renderToStaticMarkup(<PlanarIdentity />)).toContain("plane-2");
  });
});
