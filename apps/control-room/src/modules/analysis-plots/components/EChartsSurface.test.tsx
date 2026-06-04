import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EChartsSurface } from "./EChartsSurface";

describe("EChartsSurface", () => {
  it("keeps the ECharts mount element present before table samples arrive", () => {
    const html = renderToStaticMarkup(
      <EChartsSurface table={null} xAxisId="step" yAxisIds={["mx"]} />
    );

    expect(html).toContain('class="fm-analysis-plots__echarts"');
    expect(html).toContain("No table samples");
  });
});
