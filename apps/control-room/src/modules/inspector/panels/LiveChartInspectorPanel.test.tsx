import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { resolveInspectorPanel } from "../inspectorRegistry";

describe("LiveChartInspectorPanel", () => {
  it("shows descriptor and point provenance without taking over Analysis controls", () => {
    const panel = resolveInspectorPanel({ kind: "live.chart-point" });
    expect(panel?.id).toBe("live-chart");

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
    expect(html).not.toContain("Chart controls");
  });
});
