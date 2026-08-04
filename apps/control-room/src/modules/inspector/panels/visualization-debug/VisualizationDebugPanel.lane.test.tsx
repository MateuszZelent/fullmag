import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  adapterCalls: 0,
  discretization: "fdm",
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  SESSION_STATUS_RESOURCE_KEY: "session:status",
  useSessionStatusSelector: (selector: (status: unknown) => unknown) =>
    selector({
      data: { domain: { discretization: testState.discretization } },
    }),
}));

vi.mock("./useVisualizationDebugPanelModel", () => ({
  VisualizationDebugPanelModelAdapter: () => {
    testState.adapterCalls += 1;
    return <div>debug adapter</div>;
  },
}));

import type { Selection } from "@/kernel/selection/selectionTypes";
import { VisualizationDebugPanel } from "./VisualizationDebugPanel";

const selection: Selection = {
  kind: "object.visualization.debug",
  label: "Film debug",
  moduleSource: "inspector",
  nodeId: "model:object:film:visualization:debug",
  objectId: "film",
  ref: {
    kind: "object.visualization.debug",
    nodeId: "model:object:film:visualization:debug",
    objectId: "film",
    type: "scene-object",
    visualizationTargetId: "object:film",
  },
};

describe("VisualizationDebugPanel lane gate", () => {
  it("does not mount the FEM evidence adapter for explicit FDM debug selections", () => {
    testState.discretization = "fdm";
    testState.adapterCalls = 0;

    const html = renderToStaticMarkup(<VisualizationDebugPanel selection={selection} />);

    expect(testState.adapterCalls).toBe(0);
    expect(html).toContain("not applicable for the FDM structured-grid lane");
  });

  it("mounts the evidence adapter after the session resolves to FEM", () => {
    testState.discretization = "fem";
    testState.adapterCalls = 0;

    const html = renderToStaticMarkup(<VisualizationDebugPanel selection={selection} />);

    expect(testState.adapterCalls).toBe(1);
    expect(html).toContain("debug adapter");
  });
});
