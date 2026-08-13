import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  adapterCalls: 0,
  discretization: "fdm",
  omitDomain: false,
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  SESSION_STATUS_RESOURCE_KEY: "session:status",
  useSessionStatusSelector: (selector: (status: unknown) => unknown) =>
    selector({
      data: testState.omitDomain
        ? {}
        : { domain: { discretization: testState.discretization } },
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
  beforeEach(() => {
    testState.adapterCalls = 0;
    testState.discretization = "fdm";
    testState.omitDomain = false;
  });

  it("mounts the existing evidence adapter for explicit FDM debug selections", () => {
    testState.discretization = "fdm";

    const html = renderToStaticMarkup(<VisualizationDebugPanel selection={selection} />);

    expect(testState.adapterCalls).toBe(1);
    expect(html).toContain("debug adapter");
  });

  it("mounts the evidence adapter after the session resolves to FEM", () => {
    testState.discretization = "fem";

    const html = renderToStaticMarkup(<VisualizationDebugPanel selection={selection} />);

    expect(testState.adapterCalls).toBe(1);
    expect(html).toContain("debug adapter");
  });

  it("withholds the evidence adapter until the session lane is explicit", () => {
    testState.discretization = "";

    const html = renderToStaticMarkup(<VisualizationDebugPanel selection={selection} />);

    expect(testState.adapterCalls).toBe(0);
    expect(html).toContain("unavailable until the session discretization is explicit");
  });

  it("withholds the evidence adapter when the status has no domain", () => {
    testState.omitDomain = true;

    const html = renderToStaticMarkup(<VisualizationDebugPanel selection={selection} />);

    expect(testState.adapterCalls).toBe(0);
    expect(html).toContain("unavailable until the session discretization is explicit");
  });
});
