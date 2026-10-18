import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ComputeEnvironment, ComputeNodeInventorySummary, ComputeProbeState } from "../model/types";

import { ComputeEnvironmentWidget } from "./ComputeEnvironmentWidget";

const baseCompute: ComputeEnvironment = {
  gpus: [],
  cpuThreads: 16,
  preferredBackend: "cpu",
  warnings: [],
};

function render(
  compute: ComputeProbeState,
  refreshing = false,
  nodeInventory?: ComputeNodeInventorySummary,
) {
  return renderToStaticMarkup(
    <ComputeEnvironmentWidget
      compute={compute}
      nodeInventory={nodeInventory}
      onConfigure={vi.fn()}
      refreshing={refreshing}
    />,
  );
}

describe("ComputeEnvironmentWidget solver routes", () => {
  it("shows each reported runtime lane with a readable availability state", () => {
    const html = render({
      ...baseCompute,
      runtimeLanes: [
        { backend: "FDM", device: "CPU", availability: "available", precisions: ["double"] },
        { backend: "FDM", device: "GPU", availability: "unavailable", precisions: [], reason: "No GPU runtime" },
        { backend: "FEM", device: "CPU", availability: "unknown", precisions: [] },
      ],
    });

    expect(html).toContain("FDM · CPU");
    expect(html).toContain("FDM · GPU");
    expect(html).toContain("FEM · GPU");
    expect(html).toContain('data-availability="available"');
    expect(html).toContain('data-availability="unavailable"');
    expect(html).toContain("Available");
    expect(html).toContain("Unavailable");
    expect(html.match(/Not reported/g)).toHaveLength(2);
  });

  it("does not infer runtime support from a detected host", () => {
    const html = render(baseCompute);

    expect(html.match(/Not reported/g)).toHaveLength(4);
    expect(html).not.toContain('data-availability="available"');
  });

  it("labels experimental diagnostics while retaining unknown production availability", () => {
    const html = render({
      ...baseCompute,
      runtimeLanes: [
        {
          backend: "FEM",
          device: "CPU",
          availability: "unknown",
          precisions: [],
          diagnostic: { kind: "experimental", state: "available" },
        },
        {
          backend: "FEM",
          device: "GPU",
          availability: "unknown",
          precisions: [],
          diagnostic: {
            kind: "experimental",
            state: "unavailable",
            reason: "Native FEM GPU driver is unavailable",
          },
        },
      ],
    });

    expect(html).toContain("Experimental");
    expect(html).toContain("Experimental unavailable");
    expect(html).toContain("Native FEM GPU driver is unavailable");
    expect(html).toContain('data-availability="unknown" data-diagnostic-state="available"');
    expect(html).not.toContain('data-availability="available"');
  });

  it("keeps the initial probe state distinct from a missing runtime report", () => {
    const html = render(undefined);

    expect(html.match(/Loading/g)).toHaveLength(4);
    expect(html).toContain("Not probed");
    expect(html).not.toContain("Not reported");
  });

  it("shows when probing begins and explains when device assignment is resolved", () => {
    const idle = render(undefined);
    const active = render(undefined, true);

    expect(idle).toContain("The desktop host supplies the compute probe.");
    expect(idle).toContain("A concrete device is resolved when a run starts.");
    expect(active).toContain("Reading host telemetry");
    expect(active).toContain("Not probed");
    expect(render(baseCompute)).toContain("A concrete device is resolved when a run starts.");
  });

  it("shows the timestamp of the latest available telemetry sample", () => {
    const sampledAt = Date.UTC(2026, 9, 13, 12, 34, 0);
    const html = render({ ...baseCompute, sampledAt });

    expect(html).toContain("Latest available telemetry sample");
    expect(html).toContain(new Date(sampledAt).toLocaleString());
    expect(html).toContain(`dateTime="${new Date(sampledAt).toISOString()}"`);
  });

  it("shows host inventory freshness separately from telemetry and solver lanes", () => {
    const html = render(baseCompute, false, {
      hasSnapshot: true,
      nodeCount: 1,
      nodes: [],
      refreshFailed: false,
      resourceStatus: "ready",
      staleAfterSeconds: 30,
      state: "current",
    });

    expect(html.replace(/<[^>]*>/g, "")).toContain("Host inventory · Current · 1 node");
    expect(html).toContain("Samples become stale after 30 seconds.");
  });
});
