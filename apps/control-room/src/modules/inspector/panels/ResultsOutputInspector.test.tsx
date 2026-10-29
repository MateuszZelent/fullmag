import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ResultsArray, ResultsEntry, ResultsFilePreview } from "@/kernel/api/resultsBrowser";
import {
  findElement,
  installSimulationPreparationTestDom,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { SnapshotVisualizationAppearance } from "@/kernel/visualization/SnapshotVisualizationController";

import {
  clampResultsSampleIndex,
  formatResultsSampleCoordinate,
  ResultsOutputInspector,
} from "./ResultsOutputInspector";

const entry: ResultsEntry = {
  id: "array-m",
  path: "fields/m",
  parent_id: "dir-fields",
  name: "m",
  kind: "zarr_array",
  size_bytes: 208,
  array_id: "array-m",
};

const array: ResultsArray = {
  id: "array-m",
  path: "fields/m",
  revision: "sha256:array-1",
  shape: [3, 2, 3],
  chunks: [1, 2, 3],
  dtype: "float64",
  quantity_id: "m",
  unit: "A/m",
  component_count: 3,
  field_layout: "component-major",
  sample_count: 3,
  coordinates: [
    { sample_index: 0, kind: "physical_time", value: 12e-9 },
    { sample_index: 1, kind: "accepted_step", value: 7 },
  ],
  can_read_values: true,
  can_visualize_3d: true,
  reason: null,
  geometry: {
    kind: "fdm",
    cells_xyz: [2, 2, 1],
    cell_size_m: [1, 1, 1],
    origin_m: [0, 0, 0],
  },
};

const appearance: SnapshotVisualizationAppearance = {
  component: "z",
  palette: "coolwarm",
  visible: true,
  rangeMode: "auto",
  min: null,
  max: null,
};

const preview: ResultsFilePreview = {
  id: "file-log",
  path: "logs/solver.txt",
  revision: "sha256:file-1",
  content_type: "text/plain",
  text: "solver completed\\nresidual=0.0",
  truncated: true,
};

function inspectorProps() {
  return {
    entry,
    array,
    status: "ready",
    error: null,
    sampleIndex: 0,
    onSampleIndexChange: vi.fn(),
    onLoadTo3D: vi.fn(),
    onReturnToLive: vi.fn(),
    canReturnToLive: true,
    returnActionLabel: "Return to live" as const,
    appearance,
    onAppearanceChange: vi.fn(),
    values: new Float64Array([0.25, -1.5, 2.75]),
    valuesAvailable: true,
    valuesEnabled: true,
    valuesError: null,
    valuesStatus: "ready",
    onValuesOpenChange: vi.fn(),
    filePreview: preview,
  };
}

describe("ResultsOutputInspector", () => {
  it("renders source metadata, bounded previews, actual coordinate labels, and accessible controls", () => {
    const html = renderToStaticMarkup(
      <ResultsOutputInspector
        {...inspectorProps()}
        values={new Float64Array(Array.from({ length: 26 }, (_, index) => index))}
      />,
    );

    expect(html).toContain("fields/m");
    expect(html).toContain("3 × 2 × 3");
    expect(html).toContain("1 × 2 × 3");
    expect(html).toContain("float64");
    expect(html).toContain("A/m");
    expect(html).toContain("Physical time: 12 ns");
    expect(html).toContain('aria-label="Saved sample"');
    expect(html).toContain('aria-valuetext="Sample 1 of 3"');
    expect(html).toContain("Sample 1 of 3");
    expect(html).toContain('aria-label="First sample"');
    expect(html).toContain('aria-label="Previous sample"');
    expect(html).toContain('aria-label="Next sample"');
    expect(html).toContain('aria-label="Last sample"');
    expect(html).toContain("Visualization");
    expect(html.indexOf('aria-label="Saved sample"')).toBeLessThan(html.indexOf("Output metadata"));
    expect(html.indexOf('aria-label="Visualization component"')).toBeLessThan(html.indexOf("Output metadata"));
    expect(html).toContain('data-collapsible="true" data-open="false"');
    expect(html).toContain('aria-label="Visualization palette"');
    expect(html).toContain('aria-label="Visualization component"');
    expect(html).toContain("text/plain");
    expect(html).toContain("Preview truncated by the results resource.");
    expect(html).toContain("Raw bytes");
    expect(html).toContain("Showing the first 24 values.");
    expect(html).toContain("Load into 3D");
    expect(html).not.toContain("Current session");
  });

  it("labels table values in column order without treating a vector quantity as a column", () => {
    const table = renderToStaticMarkup(<ResultsOutputInspector {...inspectorProps()}
      array={{...array, quantity_ids:["mx", "e_total"], shape:[3, 2]}}
      values={new Float64Array([0.25, -1.5])} />);
    expect(table).toContain("mx: 0.25");
    expect(table).toContain("e_total: -1.5");
    const vector = renderToStaticMarkup(<ResultsOutputInspector {...inspectorProps()}
      array={{...array, quantity_ids:["m"]}} />);
    expect(vector).not.toContain("m: 0.25");
  });

  it("renders decoded values collapsed before a payload is available", () => {
    const html = renderToStaticMarkup(
      <ResultsOutputInspector
        {...inspectorProps()}
        values={null}
        valuesEnabled={false}
      />,
    );

    expect(html).toContain("Decoded values");
    expect(html).toContain('data-collapsible="true" data-open="false"');
    expect(html).not.toContain("Raw bytes");
  });

  it("uses the close-results label when no live session is confirmed", () => {
    const html = renderToStaticMarkup(
      <ResultsOutputInspector
        {...inspectorProps()}
        returnActionLabel="Close results"
      />,
    );

    expect(html).toContain("Close results");
    expect(html).not.toContain("Return to live");
  });

  it("keeps extreme physical values compact and does not show stale catalog warnings", () => {
    const html = renderToStaticMarkup(<ResultsOutputInspector {...inspectorProps()}
      entry={{...entry, reason:"array has no explicit persisted 3-D geometry mapping"}}
      values={new Float64Array([Number.MIN_VALUE, 1e100, -1e-120])} />);
    expect(html).toContain("4.9407e-324");
    expect(html).toContain("1.0000e+100");
    expect(html).not.toContain("array has no explicit persisted 3-D geometry mapping");
    expect(html).not.toContain("0".repeat(100));
  });

  it("keeps scalar range controls available without vector component choices", () => {
    const html = renderToStaticMarkup(<ResultsOutputInspector {...inspectorProps()}
      array={{...array, component_count:1, quantity_id:"eden_total", unit:"J/m^3"}} />);
    expect(html).toContain("scalar");
    expect(html).not.toContain("Range controls are unavailable");
    expect(html).not.toContain('aria-label="Visualization component"');
    const rangeControl=html.match(/<button[^>]*aria-label="Visualization range mode"[^>]*>/)?.[0];
    expect(rangeControl).toBeDefined();
    expect(rangeControl).not.toContain('disabled=""');
  });

  it("does not invent a missing coordinate and disables unverified 3D loading", () => {
    const unsupportedArray: ResultsArray = {
      ...array,
      can_visualize_3d: false,
      coordinates: [],
      quantity_id: null,
      unit: null,
      reason: "This array has no published geometry mapping.",
    };
    const html = renderToStaticMarkup(
      <ResultsOutputInspector
        {...inspectorProps()}
        array={unsupportedArray}
        sampleIndex={1}
      />,
    );

    expect(html).toContain("This array has no published geometry mapping.");
    expect(html).toMatch(/Quantity[\s\S]*Unavailable/);
    expect(html).toMatch(/Unit[\s\S]*Unavailable/);
    expect(html).toContain("Sample 2 of 3");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Load into 3D<\/button>/);
    expect(formatResultsSampleCoordinate(undefined, 1)).toBe("Sample index 1");
    expect(formatResultsSampleCoordinate({ sample_index: 0, kind: "physical_time", value: 2e-9 }, 0)).toBe("Physical time: 2 ns");
    expect(formatResultsSampleCoordinate({ sample_index: 1, kind: "accepted_step", value: 7 }, 1)).toBe("Accepted step: 7");
  });

  it("exposes first, middle, last, and empty sample ordinals to the native range", () => {
    expect(renderToStaticMarkup(<ResultsOutputInspector {...inspectorProps()} sampleIndex={0} />))
      .toContain('aria-valuetext="Sample 1 of 3"');
    expect(renderToStaticMarkup(<ResultsOutputInspector {...inspectorProps()} sampleIndex={1} />))
      .toContain('aria-valuetext="Sample 2 of 3"');
    expect(renderToStaticMarkup(<ResultsOutputInspector {...inspectorProps()} sampleIndex={2} />))
      .toContain('aria-valuetext="Sample 3 of 3"');
    expect(renderToStaticMarkup(
      <ResultsOutputInspector
        {...inspectorProps()}
        array={{ ...array, sample_count: 0, coordinates: [] }}
      />,
    )).toContain('aria-valuetext="Sample unavailable"');
  });

  it("bounds sample indexes and routes navigation, load, and live-return actions", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const onSampleIndexChange = vi.fn();
    const onLoadTo3D = vi.fn();
    const onReturnToLive = vi.fn();

    try {
      await act(async () => {
        root.render(
          <ResultsOutputInspector
            {...inspectorProps()}
            onLoadTo3D={onLoadTo3D}
            onReturnToLive={onReturnToLive}
            onSampleIndexChange={onSampleIndexChange}
          />,
        );
      });

      const nextButton = findElement(
        container,
        (element) => element.getAttribute("aria-label") === "Next sample",
        "next sample button",
      );
      const loadButton = findElement(
        container,
        (element) => element.textContent === "Load into 3D",
        "3D load button",
      );
      const returnButton = findElement(
        container,
        (element) => element.textContent === "Return to live",
        "return to live button",
      );

      await act(async () => {
        nextButton.dispatchEvent(new TestEvent("click", { bubbles: true }));
        loadButton.dispatchEvent(new TestEvent("click", { bubbles: true }));
        returnButton.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });

      expect(onSampleIndexChange).toHaveBeenCalledWith(1);
      expect(onLoadTo3D).toHaveBeenCalledOnce();
      expect(onReturnToLive).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }

    expect(clampResultsSampleIndex(-1, 3)).toBe(0);
    expect(clampResultsSampleIndex(1, 3)).toBe(1);
    expect(clampResultsSampleIndex(20, 3)).toBe(2);
    expect(clampResultsSampleIndex(4, 0)).toBe(0);
  });
});
