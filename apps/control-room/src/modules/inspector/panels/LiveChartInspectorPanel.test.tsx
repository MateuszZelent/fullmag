import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { liveChartPreferencesStore } from "@/kernel/workspace/liveChartPreferences";

import { resolveInspectorPanel } from "../inspectorRegistry";

const selectValueProps = vi.hoisted(() => vi.fn());
vi.mock("@/shared/ui/Select", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/ui/Select")>();
  return {
    ...actual,
    SelectValue: (props: ComponentProps<typeof actual.SelectValue>) => {
      selectValueProps(props);
      return <actual.SelectValue {...props} />;
    },
  };
});

describe("LiveChartInspectorPanel", () => {
  it("labels the persisted fixed window instead of showing an empty selector", () => {
    selectValueProps.mockClear();
    const snapshot = liveChartPreferencesStore.getServerHydrationSnapshot();
    const mock = vi.spyOn(liveChartPreferencesStore, "getServerHydrationSnapshot").mockReturnValue({
      ...snapshot,
      preferences: {
        ...snapshot.preferences,
        descriptors: {
          magnetization: {
            displayUnits: {}, liveMode: "following", selectedSeriesIds: ["mx"],
            targetPoints: 800, xAxisId: "step", range: { mode: "fixed", fromSI: 200, toSI: 300 },
          },
        },
      },
    });
    try {
      const Panel = resolveInspectorPanel({ kind: "live.chart" })!.component;
      const html = renderToStaticMarkup(<Panel selection={{
        kind: "live.chart", label: "Live Chart", moduleSource: "live-charts" as never,
        nodeId: "live:chart:magnetization", objectId: null,
        ref: { descriptorId: "magnetization", kind: "live.chart", nodeId: "live:chart:magnetization", type: "live-chart" },
      }} />);
      expect(html).toContain("Selected range (step)");
      expect(html).toContain("200.000 … 300.000");
      // Radix owns the value's children via a portal. Explicit text conflicts
      // with that portal when the selected window changes during zoom.
      expect(selectValueProps).toHaveBeenCalled();
      for (const [props] of selectValueProps.mock.calls) {
        expect(props.children).toBeUndefined();
      }
    } finally {
      mock.mockRestore();
    }
  });

  it("shows descriptor and point provenance without taking over Analysis controls", () => {
    const panel = resolveInspectorPanel({ kind: "live.chart-point" });
    expect(panel?.id).toBe("live-chart-point");

    const Panel = panel!.component;
    const html = renderToStaticMarkup(
      <Panel
        selection={{
          kind: "live.chart-point",
          label: "mx 0.2",
          moduleSource: "live-charts" as never,
          nodeId: "live:chart:magnetization:point:mx:1:7",
          objectId: null,
          ref: {
            descriptorId: "magnetization",
            kind: "live.chart-point",
            nodeId: "live:chart:magnetization:point:mx:1:7",
            pointIndex: 1,
            revision: 7,
            seriesId: "mx",
            type: "live-chart-point",
          } as never,
        }}
      />,
    );

    expect(html).toContain("Live Chart");
    expect(html).toContain("magnetization");
    expect(html).toContain("mx");
    expect(html).toContain("7");
    expect(html).toContain("Display");
    expect(html).toContain("Signals");
    expect(html).toContain("Show mx");
    expect(html).not.toContain("Chart controls");
  });
});
