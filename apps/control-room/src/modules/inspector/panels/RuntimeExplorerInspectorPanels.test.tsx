import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SIMULATION_RUN_CURRENT_PATH } from "@/kernel/api/apiPaths";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { RuntimeExplorerDetail } from "@/modules/explorer/explorerTypes";

import {
  RuntimeCapabilityDiagnosticInspectorPanel,
  RuntimeCommandJobInspectorPanel,
  RuntimeFrequencyDiagnosticInspectorPanel,
  RuntimeHealthDiagnosticInspectorPanel,
  RuntimeMeshDiagnosticInspectorPanel,
  RuntimePerformanceDiagnosticInspectorPanel,
  RuntimeProblemDiagnosticInspectorPanel,
  RuntimeResourceInspectorPanel,
  RuntimeRunJobInspectorPanel,
  RuntimeSolverDiagnosticInspectorPanel,
  RuntimeStageJobInspectorPanel,
} from "./RuntimeExplorerInspectorPanels";

const detail: RuntimeExplorerDetail = {
  cache: null,
  category: "resource",
  contractGap: false,
  facts: [{ label: "State", value: "running" }],
  generation: "generation-4",
  key: SIMULATION_RUN_CURRENT_PATH,
  location: "/runs/run-4",
  message: null,
  owner: "run:run-4",
  requestedExecution: {
    backend: "fdm",
    device: "gpu",
    engineId: null,
    mode: "gpu",
    precision: "double",
    runtimeFamily: null,
    worker: null,
  },
  resolvedExecution: {
    backend: "fdm-cuda",
    device: "cuda:0",
    engineId: "fdm-cuda-double",
    mode: "gpu",
    precision: "double",
    runtimeFamily: "cuda",
    worker: "local",
  },
  revision: 4,
  schema: null,
  sizeBytes: null,
  sourceStatus: "ready",
};

function selection(kind: string, nextDetail: RuntimeExplorerDetail = detail): Selection {
  return {
    kind,
    label: kind,
    moduleSource: "explorer",
    nodeId: `node:${kind}`,
    objectId: null,
    ref: {
      detail: nextDetail,
      kind,
      nodeId: `node:${kind}`,
      type: "runtime-explorer",
    },
  };
}

describe("Runtime Explorer Inspector panels", () => {
  it("renders complete resource metadata and explicit unavailable values", () => {
    const html = renderToStaticMarkup(
      <RuntimeResourceInspectorPanel selection={selection("resources.runtime")} />,
    );

    expect(html).toContain("Resource key");
    expect(html).toContain("generation-4");
    expect(html).toContain("Cache");
    expect(html).toContain("Unavailable");
    expect(html).toContain("/runs/run-4");
  });

  it("renders requested and resolved execution as independent sections", () => {
    const html = renderToStaticMarkup(
      <RuntimeRunJobInspectorPanel selection={selection("jobs.run")} />,
    );

    expect(html).toContain("Requested execution");
    expect(html).toContain("Resolved execution");
    expect(html).toContain("fdm-cuda");
    expect(html).toContain("cuda:0");
  });

  it("renders contract gaps as unavailable rather than healthy", () => {
    const html = renderToStaticMarkup(
      <RuntimeHealthDiagnosticInspectorPanel
        selection={selection("diagnostics.health", {
          ...detail,
          category: "diagnostic",
          contractGap: true,
          facts: [],
          message: "Health resource is unavailable.",
          sourceStatus: "unavailable",
        })}
      />,
    );

    expect(html).toContain("Contract gap");
    expect(html).toContain("Health resource is unavailable.");
    expect(html).not.toContain("Published");
  });

  it("exports a distinct dedicated component for every emitted runtime kind", () => {
    expect(new Set([
      RuntimeResourceInspectorPanel,
      RuntimeRunJobInspectorPanel,
      RuntimeStageJobInspectorPanel,
      RuntimeCommandJobInspectorPanel,
      RuntimeProblemDiagnosticInspectorPanel,
      RuntimeHealthDiagnosticInspectorPanel,
      RuntimeCapabilityDiagnosticInspectorPanel,
      RuntimeSolverDiagnosticInspectorPanel,
      RuntimeMeshDiagnosticInspectorPanel,
      RuntimeFrequencyDiagnosticInspectorPanel,
      RuntimePerformanceDiagnosticInspectorPanel,
    ]).size).toBe(11);
  });
});
