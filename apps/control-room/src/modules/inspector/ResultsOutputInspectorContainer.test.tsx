import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ResultsArray,
  ResultsEntry,
  ResultsSource,
} from "@/kernel/api/resultsBrowser";
import { KernelContext } from "@/kernel/KernelContext";
import type { KernelApi } from "@/kernel/types";
import { SnapshotVisualizationController } from "@/kernel/visualization/SnapshotVisualizationController";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  findElement,
  installSimulationPreparationTestDom,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { ResultsOutputInspectorContainer } from "./ResultsOutputInspectorContainer";

const resourceMocks = vi.hoisted(() => ({
  arrays: new Map<string, ResultsArray>(),
  sampleCalls: [] as Array<{ array: ResultsArray | null; sampleIndex: number }>,
}));

vi.mock("@/kernel/resources/resultsBrowserResources", () => ({
  useResultsArrayResource: (_source: ResultsSource, arrayId: string | null) => {
    const data = arrayId ? resourceMocks.arrays.get(arrayId) ?? null : null;
    return { data, error: null, status: data ? "ready" : "idle" };
  },
  useResultsFilePreviewResource: (_source: ResultsSource, entryId: string | null) => ({
    data: entryId
      ? {
          content_type: "text/plain",
          id: entryId,
          path: "logs/solver.txt",
          revision: "sha256:file-1",
          text: "solver completed",
          truncated: false,
        }
      : null,
    error: null,
    status: entryId ? "ready" : "idle",
  }),
  useResultsSampleResource: (
    _source: ResultsSource,
    array: ResultsArray | null,
    sampleIndex: number,
  ) => {
    resourceMocks.sampleCalls.push({ array, sampleIndex });
    return {
      data: array ? new Float64Array([1, 2, 3]) : null,
      error: null,
      status: array ? "ready" : "idle",
    };
  },
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () => ({
    requestScopeEpoch: "scope-1",
    sessionEpoch: "epoch-1",
    sessionId: "session-1",
  }),
}));

vi.mock("@/kernel/saved-results/useSavedResultsPlayback", () => ({
  useSavedResultsPlaybackSelection: () => null,
}));

const source: ResultsSource = { kind: "current" };
const arrayEntry: ResultsEntry = {
  array_id: "array-m",
  id: "array-m",
  kind: "zarr_array",
  name: "m",
  parent_id: "fields",
  path: "fields/m",
  size_bytes: 208,
  status: "ready",
};
const fileEntry: ResultsEntry = {
  array_id: null,
  id: "solver-log",
  kind: "file",
  name: "solver.txt",
  parent_id: "logs",
  path: "logs/solver.txt",
  size_bytes: 64,
  status: "ready",
};
const array: ResultsArray = {
  can_read_values: true,
  can_visualize_3d: true,
  chunks: [1, 1, 3],
  component_count: 3,
  coordinates: [
    { kind: "physical_time", sample_index: 0, value: 0 },
    { kind: "physical_time", sample_index: 5, value: 5e-9 },
  ],
  dtype: "float64",
  field_layout: "component-major",
  geometry: {
    cell_size_m: [1, 1, 1],
    cells_xyz: [1, 1, 1],
    kind: "fdm",
    origin_m: [0, 0, 0],
  },
  id: "array-m",
  path: "fields/m",
  quantity_id: "m",
  revision: "sha256:array-1",
  sample_count: 6,
  shape: [6, 1, 3],
  unit: "A/m",
};

function resultSelection(entry: ResultsEntry, nodeId: string): Selection {
  return {
    kind: "results.output.entry",
    label: entry.path,
    moduleSource: "results-navigator",
    nodeId,
    objectId: null,
    ref: {
      entry,
      kind: "results.output.entry",
      nodeId,
      revision: "sha256:catalog-1",
      runId: "run-1",
      source,
      type: "result-output",
    },
  };
}

function createKernel(controller: SnapshotVisualizationController): KernelApi {
  return {
    layout: {
      setActiveViewportMainModule: vi.fn(),
      setFocusedSlot: vi.fn(),
    },
    snapshotVisualizations: controller,
  } as unknown as KernelApi;
}

describe("ResultsOutputInspectorContainer sample restoration", () => {
  beforeEach(() => {
    resourceMocks.arrays.clear();
    resourceMocks.sampleCalls.length = 0;
    resourceMocks.arrays.set(array.id, array);
  });

  it("restores the displayed sample across array to file to array reselection", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const controller = new SnapshotVisualizationController();
    const kernel = createKernel(controller);
    const arraySelection = resultSelection(arrayEntry, "results:array-m");
    const fileSelection = resultSelection(fileEntry, "results:solver-log");

    try {
      const renderSelection = async (selection: Selection) => {
        await act(async () => {
          root.render(
            <KernelContext.Provider value={kernel}>
              <ResultsOutputInspectorContainer selection={selection} />
            </KernelContext.Provider>,
          );
        });
      };

      await renderSelection(arraySelection);
      const lastSample = findElement(
        container,
        (element) => element.getAttribute("aria-label") === "Last sample",
        "last sample button",
      );
      await act(async () => {
        lastSample.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });
      expect(container.textContent).toContain("6 / 6");

      const loadButton = findElement(
        container,
        (element) => element.textContent === "Load into 3D",
        "load into 3D button",
      );
      await act(async () => {
        loadButton.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });
      const displayedKey = controller.getSnapshot().activeKey;
      expect(displayedKey).not.toBeNull();
      expect(JSON.parse(displayedKey!)[4]).toBe(5);

      await renderSelection(fileSelection);
      expect(container.textContent).toContain("solver.txt");
      expect(container.textContent).not.toContain("6 / 6");

      await renderSelection(arraySelection);
      const restoredSlider = findElement(
        container,
        (element) => element.getAttribute("aria-label") === "Saved sample index",
        "restored sample slider",
      );
      expect(restoredSlider.value).toBe("5");
      expect(container.textContent).toContain("6 / 6");
      expect(controller.getSnapshot().activeKey).toBe(displayedKey);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("loads decoded values only after opening the section and follows sample changes", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const controller = new SnapshotVisualizationController();
    const kernel = createKernel(controller);
    const arraySelection = resultSelection(arrayEntry, "results:array-m");

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <ResultsOutputInspectorContainer selection={arraySelection} />
          </KernelContext.Provider>,
        );
      });

      expect(
        resourceMocks.sampleCalls.filter((call) => call.array !== null),
      ).toHaveLength(0);
      const lastSample = findElement(
        container,
        (element) => element.getAttribute("aria-label") === "Last sample",
        "last sample button",
      );
      await act(async () => {
        lastSample.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });
      expect(
        resourceMocks.sampleCalls.filter((call) => call.array !== null),
      ).toHaveLength(0);

      const decodedValuesToggle = findElement(
        container,
        (element) =>
          element.getAttribute("data-slot") === "inspector-group-trigger" &&
          element.textContent === "Decoded values",
        "decoded values disclosure",
      );
      expect(decodedValuesToggle.getAttribute("aria-expanded")).toBe("false");
      await act(async () => {
        decodedValuesToggle.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });
      expect(
        resourceMocks.sampleCalls.some(
          (call) => call.array === array && call.sampleIndex === 5,
        ),
      ).toBe(true);
      expect(container.textContent).toContain("Raw bytes");
      expect(controller.getSnapshot().activeKey).toBeNull();

      const firstSample = findElement(
        container,
        (element) => element.getAttribute("aria-label") === "First sample",
        "first sample button",
      );
      await act(async () => {
        firstSample.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });
      expect(
        resourceMocks.sampleCalls.some(
          (call) => call.array === array && call.sampleIndex === 0,
        ),
      ).toBe(true);
      expect(controller.getSnapshot().activeKey).toBeNull();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
