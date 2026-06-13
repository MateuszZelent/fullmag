import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildFrequencyDomainSeriesOption, FrequencyDomainSpectrumChart } from "./FrequencyDomainCharts";

describe("FrequencyDomainCharts", () => {
  it("renders sub-GHz spectrum summaries in MHz", () => {
    const html = renderToStaticMarkup(
      <FrequencyDomainSpectrumChart
        model={{
          dataSourceVersion: "unknown",
          diagnostics: [],
          droppedPointCount: 0,
          points: [
            {
              branchId: null,
              dampingRateHz: null,
              frequencyHz: 750e6,
              imaginaryFrequencyHz: null,
              modeFieldId: "analysis:eigen:sample-0000:mode-0001",
              modeFieldResourceKey: null,
              rawModeIndex: 1,
              residualNorm: null,
              sampleIndex: 0,
              tangentLeakageMax: null,
            },
          ],
          series: [
            {
              id: "analysis.frequency-domain:eigen:spectrum:frequency",
              label: "Eigen frequency",
              points: [{ rowIndex: 0, x: 1, y: 750 }],
              quantity: "frequency",
              source: {
                kind: "analysis.frequency_domain",
                resourceKey: "analysis/frequency-domain/eigen/spectrum.v2",
                tableId: "frequency-domain:eigen-spectrum",
              },
              status: "ready",
              unit: "MHz",
              xUnit: "mode index",
            },
          ],
        }}
      />,
    );

    expect(html).toContain("mode 1: 750 MHz");
    expect(html).not.toContain("mode 1: 0.75 GHz");
  });

  it("labels response chart x axes with the series frequency unit", () => {
    const option = buildFrequencyDomainSeriesOption(
      [
        {
          id: "analysis.frequency-domain:response:amplitude",
          label: "Amplitude",
          points: [{ rowIndex: 0, x: 500, y: 2 }],
          quantity: "amplitude",
          source: {
            kind: "analysis.frequency_domain",
            resourceKey: "analysis/frequency-domain/response/magnetic-sweep",
            tableId: "frequency-domain:response-sweep",
          },
          status: "ready",
          unit: "a.u.",
          xUnit: "MHz",
        },
      ],
      "frequency",
    );

    expect(option.xAxis).toEqual(expect.objectContaining({ name: "frequency [MHz]" }));
  });
});
