import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installSimulationPreparationTestDom,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import {
  minMaxFinite,
  ScientificEChart,
  type ResolvedChartThemePalette,
} from "./ScientificEChart";

const echartsMock = vi.hoisted(() => ({
  init: vi.fn(() => {
    const handlers = new Map<string, (event: unknown) => void>();
    return {
      dispose: vi.fn(),
      off: vi.fn((eventName: string) => {
        handlers.delete(eventName);
      }),
      on: vi.fn((eventName: string, handler: (event: unknown) => void) => {
        handlers.set(eventName, handler);
      }),
      resize: vi.fn(),
      setOption: vi.fn(),
      trigger(eventName: string, payload: unknown) {
        handlers.get(eventName)?.(payload);
      },
    };
  }),
}));

vi.mock("echarts", () => echartsMock);

afterEach(() => {
  echartsMock.init.mockClear();
});

describe("ScientificEChart", () => {
  it("minMaxFinite_handles_250k_samples_without_stack_overflow", () => {
    const samples = new Float64Array(250_000);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.sin(index * 0.001) * 100;
    }
    samples[0] = Number.NaN;
    samples[42] = Number.POSITIVE_INFINITY;
    samples[1024] = Number.NEGATIVE_INFINITY;
    samples[123_456] = -987.654;
    samples[249_999] = 4321.5;

    expect(minMaxFinite(samples)).toEqual({
      min: -987.654,
      max: 4321.5,
    });
    expect(minMaxFinite([])).toBeNull();
    expect(minMaxFinite([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])).toBeNull();
  });

  it("renders accessible host markup with role img and optional status overlay", () => {
    const html = renderToStaticMarkup(
      <ScientificEChart
        ariaLabel="Ferromagnetic resonance spectrum"
        emptyMessage="Run frequency response stage to populate spectrum"
        height={240}
        optionBuilder={() => ({ series: [] })}
      />,
    );

    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Ferromagnetic resonance spectrum"');
    expect(html).toContain('data-slot="scientific-echart"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Run frequency response stage to populate spectrum");
  });

  it("mounts a single ECharts instance, reacts to theme changes and resize, forwards clicks, and disposes cleanly without polling", async () => {
    const dom = installSimulationPreparationTestDom();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const cancelFrameSpy = vi.fn();
    let pendingFrame: FrameRequestCallback | null = null;
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      pendingFrame = callback;
      return 19;
    });
    globalThis.cancelAnimationFrame = cancelFrameSpy;

    let resizeCallback: ResizeObserverCallback = () => undefined;
    const resizeDisconnect = vi.fn();
    globalThis.ResizeObserver = class {
      disconnect = resizeDisconnect;
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;

    let themeMutationCallback: MutationCallback = () => undefined;
    const themeDisconnect = vi.fn();
    globalThis.MutationObserver = class {
      disconnect = themeDisconnect;
      constructor(callback: MutationCallback) {
        themeMutationCallback = callback;
      }
      observe() {}
      takeRecords() {
        return [];
      }
    } as unknown as typeof MutationObserver;

    dom.document.documentElement.setAttribute("data-theme", "dark");

    globalThis.getComputedStyle = (() => ({
      getPropertyValue: (token: string) => {
        const isLight =
          dom.document.documentElement.getAttribute("data-theme") === "light";
        if (token === "--fm-text-primary") return isLight ? "#4c4f69" : "#cdd6f4";
        if (token === "--fm-accent") return isLight ? "#1e66f5" : "#89b4fa";
        if (token === "--fm-text-xs") return "12px";
        return "";
      },
    })) as unknown as typeof getComputedStyle;

    const seenPalettes: ResolvedChartThemePalette[] = [];
    const onPointSelect = vi.fn();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        <ScientificEChart
          ariaLabel="Hysteresis loop M(H)"
          optionBuilder={(palette) => {
            seenPalettes.push(palette);
            return {
              textStyle: { color: palette.textPrimary, fontSize: palette.fontSize },
              series: [{ type: "line", data: [[0, 0], [1, 1]] }],
            };
          }}
          onPointSelect={onPointSelect}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(echartsMock.init).toHaveBeenCalledTimes(1);
    const instance = echartsMock.init.mock.results[0]?.value;
    expect(instance).toBeDefined();
    expect(instance.setOption).toHaveBeenCalledTimes(1);
    expect(seenPalettes.at(-1)?.theme).toBe("dark");
    expect(seenPalettes.at(-1)?.textPrimary).toBe("#cdd6f4");
    expect(seenPalettes.at(-1)?.fontSize).toBe(12);

    // Theme switch to Catppuccin Latte refreshes options without re-initializing ECharts.
    dom.document.documentElement.setAttribute("data-theme", "light");
    await act(async () => {
      themeMutationCallback([], {} as MutationObserver);
    });

    expect(echartsMock.init).toHaveBeenCalledTimes(1);
    expect(instance.setOption).toHaveBeenCalledTimes(2);
    expect(seenPalettes.at(-1)?.theme).toBe("light");
    expect(seenPalettes.at(-1)?.textPrimary).toBe("#4c4f69");
    expect(seenPalettes.at(-1)?.accent).toBe("#1e66f5");

    // ResizeObserver coalesces resize in requestAnimationFrame.
    resizeCallback([], {} as ResizeObserver);
    expect(pendingFrame).not.toBeNull();
    pendingFrame?.(16);
    expect(instance.resize).toHaveBeenCalledTimes(1);

    // Click events forward point coordinates.
    instance.trigger("click", { seriesIndex: 0, dataIndex: 1, value: [1, 1] });
    expect(onPointSelect).toHaveBeenCalledWith({
      seriesIndex: 0,
      dataIndex: 1,
      value: [1, 1],
    });

    // Queue another resize frame to verify unmount cancels pending frames.
    resizeCallback([], {} as ResizeObserver);

    await act(async () => root.unmount());

    expect(instance.off).toHaveBeenCalledTimes(1);
    expect(instance.dispose).toHaveBeenCalledTimes(1);
    expect(resizeDisconnect).toHaveBeenCalledTimes(1);
    expect(themeDisconnect).toHaveBeenCalledTimes(1);
    expect(cancelFrameSpy).toHaveBeenCalledWith(19);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    setIntervalSpy.mockRestore();
    dom.restore();
  });
});
