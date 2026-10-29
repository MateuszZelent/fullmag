import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResultsArray } from "@/kernel/api/resultsBrowser";
import {
  findElement,
  installSimulationPreparationTestDom,
  TestElement,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

const fixtures = vi.hoisted(() => ({
  activeKey: "snapshot-1",
  identity: {
    runId: "run-1",
    stageId: "propagate",
    datasetId: '["current",null,"m"]',
    quantityId: "m",
    sampleIndex: 0,
    revision: "rev-1",
  },
  appearance: {
    component: "x",
    palette: "coolwarm",
    visible: true,
    rangeMode: "auto",
    min: null,
    max: null,
  },
  array: null as ResultsArray | null,
  arrayStatus: "ready",
  sampleStatus: "ready",
  sampleData: new Float64Array([1, 0, 0]),
  samples: {
    0: new Float64Array([1, 0, 0]),
    1: new Float64Array([0, 0, 2]),
  },
  kernel: {
    diagnosticRecorder: { record: vi.fn() },
    snapshotVisualizations: { returnToLive: vi.fn() },
  },
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => fixtures.kernel,
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () => null,
}));

vi.mock("@/kernel/resources/resultsBrowserResources", () => ({
  useResultsArrayResource: () => ({
    data: fixtures.array,
    error: null,
    status: fixtures.arrayStatus,
  }),
  useResultsSampleResource: (_source: unknown, _array: unknown, sampleIndex: number) => ({
    data: fixtures.sampleStatus === "ready"
      ? fixtures.samples[sampleIndex as 0 | 1] ?? fixtures.sampleData
      : null,
    error: null,
    status: fixtures.sampleStatus,
  }),
  useResultsGeometryResource: () => ({
    data: null,
    error: null,
    status: "ready",
  }),
}));

vi.mock("@/kernel/visualization/returnResultsToLive", () => ({
  returnResultsToLive: vi.fn(),
}));

vi.mock("@/kernel/visualization/useSnapshotVisualization", () => ({
  useSnapshotVisualization: (() => {
    let lastIdentity: typeof fixtures.identity | null = null;
    let lastAppearance: typeof fixtures.appearance | null = null;
    let lastActiveKey: string | null = null;
    let definition: {
      identity: typeof fixtures.identity;
      appearance: typeof fixtures.appearance;
    } | null = null;
    return () => {
      if (
        definition === null ||
        lastIdentity !== fixtures.identity ||
        lastAppearance !== fixtures.appearance ||
        lastActiveKey !== fixtures.activeKey
      ) {
        definition = {
          identity: fixtures.identity,
          appearance: fixtures.appearance,
        };
        lastIdentity = fixtures.identity;
        lastAppearance = fixtures.appearance;
        lastActiveKey = fixtures.activeKey;
      }
      return {
        activeKey: fixtures.activeKey,
        definitions: { [fixtures.activeKey]: definition },
      };
    };
  })(),
}));

vi.mock("../SavedResultsPlaybackViewport", async () => {
  const React = await import("react");
  return {
    SavedFieldCanvas: ({
      colors,
      frameIndex,
    }: {
      colors: Float32Array | null;
      frameIndex: number;
    }) => React.createElement("div", {
      "data-testid": "saved-field-canvas",
      "data-frame-index": String(frameIndex),
      "data-color-count": String(colors?.length ?? 0),
    }),
  };
});

vi.mock("../model/savedResultsPlaybackModel", () => ({
  savedGridGeometry: () => ({
    kind: "instances",
    center: [0, 0, 0],
    size: [1, 1, 1],
    cellSize: [1, 1, 1],
    positions: new Float32Array([0, 0, 0]),
    count: 1,
  }),
  savedSurfaceGeometry: vi.fn(),
}));

import { ResultsSnapshotViewport } from "../ResultsSnapshotViewport";

const array: ResultsArray = {
  id: "m",
  path: "fields/m",
  revision: "rev-1",
  shape: [2, 3],
  chunks: [1, 3],
  dtype: "f8",
  quantity_id: "m",
  unit: "A/m",
  component_count: 3,
  field_layout: "aos_node_major",
  sample_count: 2,
  coordinates: [
    { sample_index: 0, kind: "physical_time", value: 0 },
    { sample_index: 1, kind: "physical_time", value: 1e-9 },
  ],
  can_read_values: true,
  can_visualize_3d: true,
  reason: null,
  geometry: {
    kind: "fdm",
    cells_xyz: [1, 1, 1],
    cell_size_m: [1, 1, 1],
    origin_m: [0, 0, 0],
  },
};

function resetFixtures(): void {
  fixtures.activeKey = "snapshot-1";
  fixtures.identity = {
    runId: "run-1",
    stageId: "propagate",
    datasetId: '["current",null,"m"]',
    quantityId: "m",
    sampleIndex: 0,
    revision: "rev-1",
  };
  fixtures.appearance = {
    component: "x",
    palette: "coolwarm",
    visible: true,
    rangeMode: "auto",
    min: null,
    max: null,
  };
  fixtures.array = array;
  fixtures.arrayStatus = "ready";
  fixtures.sampleStatus = "ready";
  fixtures.sampleData = fixtures.samples[0];
}

async function renderViewport(
  root: ReturnType<typeof createRoot>,
): Promise<void> {
  await act(async () => {
    root.render(<ResultsSnapshotViewport />);
  });
}

function viewport(container: TestElement): TestElement {
  return findElement(
    container,
    (element) => element.getAttribute("aria-label") === "Saved results 3D viewport",
    "saved results viewport",
  );
}

describe("ResultsSnapshotViewport frame retention", () => {
  afterEach(() => {
    resetFixtures();
    vi.clearAllMocks();
  });

  it("keeps the displayed frame and its legend while the requested sample loads", async () => {
    resetFixtures();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);

    try {
      await renderViewport(root);

      fixtures.identity = { ...fixtures.identity, sampleIndex: 1 };
      fixtures.appearance = { ...fixtures.appearance, component: "z", palette: "viridis" };
      fixtures.sampleStatus = "loading";
      await renderViewport(root);

      const pending = viewport(container);
      expect(pending.getAttribute("data-results-snapshot-index")).toBe("1");
      expect(pending.getAttribute("data-results-snapshot-displayed-index")).toBe("0");
      expect(pending.textContent).toContain("Displayed: index 0");
      expect(pending.textContent).toContain("Requested: index 1");
      expect(pending.textContent).toContain("coolwarm");
      expect(pending.textContent).toContain(" · x · coolwarm");
      const pendingCanvas = findElement(
        container,
        (element) => element.getAttribute("data-testid") === "saved-field-canvas",
        "pending canvas",
      );
      expect(pendingCanvas.getAttribute("data-frame-index")).toBe("0");
      expect(pendingCanvas.getAttribute("data-color-count")).toBe("3");

      fixtures.sampleStatus = "ready";
      fixtures.sampleData = fixtures.samples[1];
      await renderViewport(root);

      const ready = viewport(container);
      expect(ready.getAttribute("data-results-snapshot-index")).toBe("1");
      expect(ready.getAttribute("data-results-snapshot-displayed-index")).toBe("1");
      expect(ready.textContent).toContain("Displayed: index 1");
      expect(ready.textContent).not.toContain("Requested: index");
      expect(ready.textContent).toContain(" · z · viridis");
      const readyCanvas = findElement(
        container,
        (element) => element.getAttribute("data-testid") === "saved-field-canvas",
        "ready canvas",
      );
      expect(readyCanvas.getAttribute("data-frame-index")).toBe("1");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("clears retained colors immediately when hidden or when the revision changes", async () => {
    resetFixtures();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);

    try {
      await renderViewport(root);

      fixtures.appearance = { ...fixtures.appearance, visible: false };
      await renderViewport(root);
      let hidden = viewport(container);
      expect(hidden.getAttribute("data-results-snapshot-displayed-index")).toBe("");
      expect(hidden.textContent).not.toContain("coolwarm");
      expect(findElement(
        container,
        (element) => element.getAttribute("data-testid") === "saved-field-canvas",
        "hidden canvas",
      ).getAttribute("data-color-count")).toBe("0");

      resetFixtures();
      await renderViewport(root);
      fixtures.identity = { ...fixtures.identity, revision: "rev-2", sampleIndex: 1 };
      fixtures.array = { ...array, revision: "rev-2" };
      fixtures.sampleStatus = "loading";
      await renderViewport(root);
      hidden = viewport(container);
      expect(hidden.getAttribute("data-results-snapshot-displayed-index")).toBe("");
      expect(hidden.textContent).not.toContain("coolwarm");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
