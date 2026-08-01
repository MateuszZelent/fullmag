import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PlanarMonitorInspectorPanel } from "./PlanarMonitorInspectorPanel";

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    commands: { execute: vi.fn() },
  }),
}));

vi.mock("@/kernel/resources/planarMonitorResources", () => ({
  usePlanarMonitorResource: () => ({
    data: {
      monitor: {
        frame: {
          extent: { kind: "target_bounds" },
          normal: [0, 0, 1],
          origin_m: [0, 0, 0],
          preset: "xy",
          u_axis: [1, 0, 0],
        },
        id: "plane-1",
        name: "Mid-plane",
        operator: { kind: "plane_sample" },
        target: { kind: "magnetic_domain" },
      },
      scene_revision: 7,
    },
    refetch: vi.fn(),
  }),
}));

vi.mock("../visualization/VisualizationContextSwitch", () => ({
  VisualizationContextSwitch: () => <div>3D / 2D</div>,
}));

vi.mock("../visualization/PlanarVisualizationSection", () => ({
  PlanarVisualizationSection: () => <div>Planar controls</div>,
}));

describe("PlanarMonitorInspectorPanel", () => {
  it("server-renders canonical identity, editable rename and monitor actions", () => {
    const html = renderToStaticMarkup(
      <PlanarMonitorInspectorPanel
        selection={{
          kind: "model.planar.monitor",
          label: "Mid-plane",
          moduleSource: "inspector",
          nodeId: "model:definitions:planar-monitors:plane-1",
          objectId: null,
          ref: {
            kind: "model.planar.monitor",
            monitorId: "plane-1",
            nodeId: "model:definitions:planar-monitors:plane-1",
            type: "planar-monitor",
            visualizationTargetId: "planar-monitor:plane-1",
          },
        }}
      />,
    );

    expect(html).toContain('value="Mid-plane"');
    expect(html).toContain("Apply name");
    expect(html).toContain("Show frame in 3D");
    expect(html).toContain("Open in 2D");
    expect(html).toContain("SceneDocument / ProblemIR");
  });
});
