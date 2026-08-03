import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findElement,
  installSimulationPreparationTestDom,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { EChartsCanvasSurface } from "./EChartsCanvasSurface";
import type { ChartRenderModel } from "./chartRenderer";

const echarts = vi.hoisted(() => ({
  init: vi.fn(() => ({
    dispatchAction: vi.fn(),
    dispose: vi.fn(),
    getDataURL: vi.fn(() => "data:image/png;base64,"),
    resize: vi.fn(),
    setOption: vi.fn(),
  })),
}));

vi.mock("echarts", () => echarts);

afterEach(() => {
  echarts.init.mockClear();
});

describe("EChartsCanvasSurface", () => {
  const dummyModel: ChartRenderModel = {
    ariaLabel: "Test chart",
    key: "test-key-123",
    provenance: {
      dataRevision: 1,
      decimation: "none",
      query: "select",
      resourceKey: "res:1",
    },
    series: [
      {
        id: "s1",
        kind: "line",
        label: "Series 1",
        points: [
          { rowIndex: 0, x: 0, y: 1 },
          { rowIndex: 1, x: 1, y: 2 },
        ],
        unit: "m",
        yAxis: 0,
      },
    ],
    status: "ready",
    xAxis: { label: "x", unit: "s" },
    yAxes: [{ label: "y", unit: "m" }],
  };

  it("renders surface container with aria-label and model key", () => {
    const html = renderToStaticMarkup(<EChartsCanvasSurface model={dummyModel} />);
    expect(html).toContain('aria-label="Test chart"');
    expect(html).toContain('data-chart-model-key="test-key-123"');
  });

  it("renders empty state overlay when series has no points", () => {
    const emptyModel: ChartRenderModel = {
      ...dummyModel,
      series: [{ ...dummyModel.series[0], points: [] }],
      status: "empty",
      statusMessage: "No samples available",
    };
    const html = renderToStaticMarkup(<EChartsCanvasSurface model={emptyModel} />);
    expect(html).toContain("No samples available");
    expect(html).toContain('role="status"');
  });

  it("renders error state overlay with role alert", () => {
    const errorModel: ChartRenderModel = {
      ...dummyModel,
      status: "error",
      statusMessage: "Resource failed to load",
    };
    const html = renderToStaticMarkup(<EChartsCanvasSurface model={errorModel} />);
    expect(html).toContain("Resource failed to load");
    expect(html).toContain('role="alert"');
  });

  it("keeps the same canvas through 100 refreshing rerenders without a loading overlay", async () => {
    const dom = installSimulationPreparationTestDom();
    globalThis.getComputedStyle = (() => ({
      direction: "ltr",
      getPropertyValue: () => "",
    })) as unknown as typeof getComputedStyle;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const ready = { kind: "ready" as const, revision: 41 };
    const refreshing = {
      kind: "refreshing" as const,
      requestedRevision: 42,
      visibleRevision: 41,
    };

    await act(async () => {
      root.render(<EChartsCanvasSurface model={dummyModel} presentation={ready} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const canvas = findElement(
      container,
      (element) => element.getAttribute("class") === "fm-analysis-plots__echarts",
      "chart canvas",
    );
    canvas.clientHeight = 240;
    canvas.clientWidth = 480;
    const bounds = canvas.getBoundingClientRect();

    for (let revision = 42; revision < 142; revision += 1) {
      await act(async () => {
        root.render(
          <EChartsCanvasSurface
            model={dummyModel}
            presentation={{ ...refreshing, requestedRevision: revision }}
          />,
        );
      });
      expect(
        findElement(
          container,
          (element) => element.getAttribute("class") === "fm-analysis-plots__echarts",
          "retained chart canvas",
        ),
      ).toBe(canvas);
    }

    expect(canvas.getBoundingClientRect()).toMatchObject({
      height: bounds.height,
      width: bounds.width,
    });
    expect(container.textContent).not.toContain("Loading");
    expect(echarts.init).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    dom.restore();
  });

  it("disposes its ECharts owner and ResizeObserver when the active footer content unmounts", async () => {
    const dom = installSimulationPreparationTestDom();
    const disconnect = vi.fn();
    globalThis.ResizeObserver = class {
      disconnect = disconnect;
      observe() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    globalThis.getComputedStyle = (() => ({
      direction: "ltr",
      getPropertyValue: () => "",
    })) as unknown as typeof getComputedStyle;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(<EChartsCanvasSurface model={dummyModel} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const instance = echarts.init.mock.results.at(-1)?.value;
    expect(instance).toBeDefined();

    await act(async () => root.unmount());

    expect(instance?.dispose).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    dom.restore();
  });

  it("applies a pinned SI range after mount, update, and remount without fetching data", async () => {
    const dom = installSimulationPreparationTestDom();
    globalThis.getComputedStyle = (() => ({
      direction: "ltr",
      getPropertyValue: () => "",
    })) as unknown as typeof getComputedStyle;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const firstRoot = createRoot(container as unknown as Element);

    await act(async () => {
      firstRoot.render(<EChartsCanvasSurface initialRange={{ fromValue: 2, toValue: 8 }} model={dummyModel} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const first = echarts.init.mock.results.at(-1)?.value;
    expect(first?.dispatchAction).toHaveBeenCalledWith({ type: "dataZoom", startValue: 2, endValue: 8 });

    await act(async () => {
      firstRoot.render(<EChartsCanvasSurface initialRange={{ fromValue: 3, toValue: 7 }} model={dummyModel} />);
    });
    expect(first?.dispatchAction).toHaveBeenCalledWith({ type: "dataZoom", startValue: 3, endValue: 7 });
    await act(async () => firstRoot.unmount());

    const secondRoot = createRoot(container as unknown as Element);
    await act(async () => {
      secondRoot.render(<EChartsCanvasSurface initialRange={{ fromValue: 4, toValue: 6 }} model={dummyModel} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const second = echarts.init.mock.results.at(-1)?.value;
    expect(second).not.toBe(first);
    expect(second?.dispatchAction).toHaveBeenCalledWith({ type: "dataZoom", startValue: 4, endValue: 6 });
    await act(async () => secondRoot.unmount());
    dom.restore();
  });

  it("fits exactly once when a mounted pinned range is cleared", async () => {
    const dom = installSimulationPreparationTestDom();
    globalThis.getComputedStyle = (() => ({
      direction: "ltr",
      getPropertyValue: () => "",
    })) as unknown as typeof getComputedStyle;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(<EChartsCanvasSurface initialRange={{ fromValue: 2, toValue: 8 }} model={dummyModel} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const instance = echarts.init.mock.results.at(-1)?.value;
    instance?.dispatchAction.mockClear();

    await act(async () => {
      root.render(<EChartsCanvasSurface initialRange={null} model={dummyModel} />);
    });
    expect(instance?.dispatchAction).toHaveBeenCalledTimes(1);
    expect(instance?.dispatchAction).toHaveBeenCalledWith({ type: "dataZoom", start: 0, end: 100 });

    await act(async () => {
      root.render(<EChartsCanvasSurface initialRange={null} model={dummyModel} />);
    });
    expect(instance?.dispatchAction).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    dom.restore();
  });
});
