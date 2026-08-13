import { readFileSync } from "node:fs";

import { act, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SIMULATION_RUN_CURRENT_PATH } from "@/kernel/api/apiPaths";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { runtimeExplorerDetailStore } from "@/kernel/resources/runtimeExplorerDetailStore";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { RuntimeExplorerDetail } from "@/modules/explorer/explorerTypes";

import type { InspectorPanelProps } from "../inspectorTypes";
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
  condition: "ready",
  contractGap: false,
  facts: [{ label: "State", value: "running" }],
  generation: "generation-4",
  key: SIMULATION_RUN_CURRENT_PATH,
  lifecycleStatus: "running",
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

function selection(kind: string): Selection {
  const nodeId = `node:${kind}`;
  return {
    kind,
    label: kind,
    moduleSource: "explorer",
    nodeId,
    objectId: null,
    ref: {
      descriptorId: nodeId,
      kind,
      nodeId,
      resourceKey: SIMULATION_RUN_CURRENT_PATH,
      type: "runtime-explorer",
    },
  };
}

async function renderPanel(
  Panel: ComponentType<InspectorPanelProps>,
  panelSelection: Selection,
  nextDetail: RuntimeExplorerDetail,
): Promise<string> {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  runtimeExplorerDetailStore.publish([{
    detail: nextDetail,
    id: panelSelection.nodeId ?? "missing",
  }]);
  try {
    await act(async () => root.render(<Panel selection={panelSelection} />));
    return container.textContent ?? "";
  } finally {
    await act(async () => root.unmount());
    runtimeExplorerDetailStore.clear();
    dom.restore();
  }
}

describe("Runtime Explorer Inspector panels", () => {
  it("reads live detail from an SSR-safe external-store hook", () => {
    const source = readFileSync(
      new URL("./RuntimeExplorerInspectorPanels.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("useRuntimeExplorerDetail");
    expect(source).not.toContain("selection.ref.detail");
  });

  it("renders complete resource metadata and explicit unavailable values", async () => {
    const html = await renderPanel(
      RuntimeResourceInspectorPanel,
      selection("resources.runtime"),
      detail,
    );

    expect(html).toContain("Resource key");
    expect(html).toContain("generation-4");
    expect(html).toContain("Condition");
    expect(html).toContain("Cache");
    expect(html).toContain("Unavailable");
    expect(html).toContain("/runs/run-4");
  });

  it("marks an absent descriptor owner as unavailable and unverified", async () => {
    const html = await renderPanel(
      RuntimeResourceInspectorPanel,
      selection("resources.runtime"),
      { ...detail, owner: null },
    );

    expect(html).toContain("Unavailable / unverified");
  });

  it("renders requested and resolved execution separately from actual lifecycle", async () => {
    const html = await renderPanel(
      RuntimeRunJobInspectorPanel,
      selection("jobs.run"),
      detail,
    );

    expect(html).toContain("Lifecycle status");
    expect(html).toContain("running");
    expect(html).toContain("Requested execution");
    expect(html).toContain("Resolved execution");
    expect(html).toContain("fdm-cuda");
    expect(html).toContain("cuda:0");
  });

  it.each([
    ["run", RuntimeRunJobInspectorPanel],
    ["stage", RuntimeStageJobInspectorPanel],
    ["command", RuntimeCommandJobInspectorPanel],
  ] as const)("shows lifecycle and execution provenance for every %s job Inspector", async (kind, Panel) => {
    const html = await renderPanel(Panel, selection(`jobs.${kind}`), detail);

    expect(html).toContain("Lifecycle status");
    expect(html).toContain("Requested execution");
    expect(html).toContain("Resolved execution");
  });

  it("renders contract gaps as unavailable rather than healthy", async () => {
    const html = await renderPanel(
      RuntimeHealthDiagnosticInspectorPanel,
      selection("diagnostics.health"),
      {
        ...detail,
        category: "diagnostic",
        condition: "unavailable",
        contractGap: true,
        facts: [],
        message: "Health resource is unavailable.",
        sourceStatus: "unavailable",
      },
    );

    expect(html).toContain("Contract gap");
    expect(html).toContain("Health resource is unavailable.");
    expect(html).not.toContain("Published");
  });

  it("updates an already selected Inspector after revision and freshness changes", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const selected = selection("jobs.command");
    runtimeExplorerDetailStore.publish([{ detail, id: selected.nodeId ?? "missing" }]);
    try {
      await act(async () => root.render(
        <RuntimeCommandJobInspectorPanel selection={selected} />,
      ));
      expect(container.textContent).toContain("ready");
      expect(container.textContent).toContain("running");

      await act(async () => runtimeExplorerDetailStore.publish([{
        detail: {
          ...detail,
          condition: "stale",
          lifecycleStatus: "failed",
          message: "Command detail invalidated.",
          revision: 5,
          sourceStatus: "stale",
        },
        id: selected.nodeId ?? "missing",
      }]));

      expect(container.textContent).toContain("stale");
      expect(container.textContent).toContain("failed");
      expect(container.textContent).toContain("Command detail invalidated.");
      expect(container.textContent).toContain("5");
    } finally {
      await act(async () => root.unmount());
      runtimeExplorerDetailStore.clear();
      dom.restore();
    }
  });

  it("uses an empty server snapshot instead of leaking client detail into SSR", () => {
    const selected = selection("resources.runtime");
    runtimeExplorerDetailStore.publish([{ detail, id: selected.nodeId ?? "missing" }]);
    const html = renderToStaticMarkup(
      <RuntimeResourceInspectorPanel selection={selected} />,
    );
    runtimeExplorerDetailStore.clear();

    expect(html).toContain("Typed runtime selection is unavailable.");
    expect(html).not.toContain("/runs/run-4");
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
