import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  buildFrequencyDomainSeriesOption,
  buildSpectrumOption,
  frequencyDomainSeriesPointIndexFromChartEvent,
  FrequencyDomainDispersionChart,
  FrequencyDomainResponseChart,
  FrequencyDomainSpectrumChart,
  spectrumPointIndexFromChartEvent,
} from "./FrequencyDomainCharts";

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
              dampingRateHz: 1.5e6,
              frequencyHz: 750e6,
              imaginaryFrequencyHz: null,
              modeFieldId: "analysis:eigen:sample-0000:mode-0001",
              modeFieldResourceKey: null,
              rawModeIndex: 1,
              residualNorm: 1e-8,
              sampleIndex: 0,
              tangentLeakageMax: 2e-5,
            },
            ...Array.from({ length: 5 }, (_, index) => ({
              branchId: null,
              dampingRateHz: null,
              frequencyHz: (800 + index * 25) * 1e6,
              imaginaryFrequencyHz: null,
              modeFieldId:
                index === 4 ? "analysis:eigen:sample-0000:mode-0006" : null,
              modeFieldResourceKey: null,
              rawModeIndex: index + 2,
              residualNorm: null,
              sampleIndex: 0,
              tangentLeakageMax: null,
            })),
          ],
          series: [
            {
              id: "analysis.frequency-domain:eigen:spectrum:frequency",
              label: "Eigen frequency",
              points: [
                { rowIndex: 0, x: 1, y: 750 },
                { rowIndex: 1, x: 2, y: 800 },
                { rowIndex: 2, x: 3, y: 825 },
                { rowIndex: 3, x: 4, y: 850 },
                { rowIndex: 4, x: 5, y: 875 },
                { rowIndex: 5, x: 6, y: 900 },
              ],
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
    expect(html).toContain("mode 6: 900 MHz");
    expect(html).toContain("Select mode 1 at 750 MHz, 3D field available");
    expect(html).toContain("Select mode 2 at 800 MHz, 3D field missing");
    expect(html).toContain("3D ready");
    expect(html).toContain("field missing");
    expect(html).toContain("residual");
    expect(html).toContain("leakage");
    expect(html).toContain("fm-button");
    expect(html).toContain("fm-frequency-domain-chart__mode");
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

  it("maps spectrum chart events back to the model row", () => {
    expect(spectrumPointIndexFromChartEvent({ data: [3, 7.5, 4] })).toBe(4);
    expect(spectrumPointIndexFromChartEvent({ data: [3, 7.5] })).toBeNull();
    expect(spectrumPointIndexFromChartEvent({ data: "invalid" })).toBeNull();
  });

  it("maps generic frequency-domain series events back to the model row", () => {
    const option = buildFrequencyDomainSeriesOption(
      [
        {
          id: "analysis.frequency-domain:response:amplitude",
          label: "Amplitude",
          points: [{ rowIndex: 3, x: 9.5, y: 2 }],
          quantity: "amplitude",
          source: {
            kind: "analysis.frequency_domain",
            resourceKey: "analysis/frequency-domain/response/magnetic-sweep",
            tableId: "frequency-domain:response-sweep",
          },
          status: "ready",
          unit: "a.u.",
          xUnit: "GHz",
        },
      ],
      "frequency",
    );
    const series = Array.isArray(option.series) ? option.series[0] : null;

    expect(series).toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ value: [9.5, 2, 3] })],
      }),
    );
    expect(
      frequencyDomainSeriesPointIndexFromChartEvent({ data: [9.5, 2, 3] }),
    ).toBe(3);
    expect(frequencyDomainSeriesPointIndexFromChartEvent({ data: [9.5, 2] })).toBeNull();
    expect(
      frequencyDomainSeriesPointIndexFromChartEvent({ data: "invalid" }),
    ).toBeNull();
  });

  it("renders selectable response and dispersion chart point controls", () => {
    const responseHtml = renderToStaticMarkup(
      <FrequencyDomainResponseChart
        model={{
          dataSourceVersion: "response.v2",
          diagnostics: [],
          droppedPointCount: 0,
          points: [
            {
              absorbedPowerDensity: null,
              amplitude: 2,
              fieldId: "analysis:frequency-response:frequency-0000",
              frequencyHz: 9.5e9,
              frequencyIndex: 0,
              phaseRad: 0.25,
              residualNorm: 1e-7,
              susceptibility: null,
              observableId: "mx",
            },
          ],
          series: [
            {
              id: "analysis.frequency-domain:response:amplitude",
              label: "Amplitude",
              points: [{ rowIndex: 0, x: 9.5, y: 2 }],
              quantity: "amplitude",
              source: {
                kind: "analysis.frequency_domain",
                resourceKey: "analysis/frequency-domain/response/magnetic-sweep",
                tableId: "frequency-domain:response-sweep",
              },
              status: "ready",
              unit: "a.u.",
              xUnit: "GHz",
            },
          ],
        }}
      />,
    );
    const dispersionHtml = renderToStaticMarkup(
      <FrequencyDomainDispersionChart
        model={{
          dataSourceVersion: "unknown",
          diagnostics: [],
          droppedPointCount: 0,
          points: [
            {
              branchId: "acoustic",
              frequencyHz: 7.5e9,
              linewidthHz: 2.8e6,
              modeFieldId: null,
              modeFieldResourceKey: null,
              overlap: 0.97,
              pathS: 1.25e6,
              rawModeIndex: 2,
              residualNorm: 1e-8,
              sampleLabel: "G",
              sampleIndex: 4,
            },
          ],
          series: [
            {
              id: "analysis.frequency-domain:eigen:dispersion:acoustic",
              label: "acoustic",
              points: [{ rowIndex: 0, x: 1.25e6, y: 7.5 }],
              quantity: "frequency",
              source: {
                kind: "analysis.frequency_domain",
                resourceKey: "analysis/frequency-domain/eigen/dispersion",
                tableId: "frequency-domain:eigen-dispersion",
              },
              status: "ready",
              unit: "GHz",
              xUnit: "rad/m",
            },
          ],
        }}
      />,
    );

    expect(responseHtml).toContain("Select response point 0 at 9.5 GHz");
    expect(responseHtml).toContain("Plot response field 0 at 9.5 GHz");
    expect(responseHtml).toContain("field ready");
    expect(dispersionHtml).toContain("Select dispersion G sample 4, mode 2");
    expect(dispersionHtml).toContain("G sample 4, mode 2");
    expect(dispersionHtml).toContain("branch acoustic");
    expect(dispersionHtml).toContain("linewidth 2.8 MHz");
  });

  it("highlights the selected spectrum mode without changing point identity", () => {
    const option = buildSpectrumOption(
      [
        {
          dampingRateHz: null,
          frequencyValue: 7.5,
          leakage: null,
          mode: 3,
          name: "mode 3",
          rowIndex: 0,
          residualNorm: null,
          sample: 0,
          selected: false,
        },
        {
          dampingRateHz: null,
          frequencyValue: 8.25,
          leakage: null,
          mode: 4,
          name: "mode 4",
          rowIndex: 1,
          residualNorm: 1e-7,
          sample: 0,
          selected: true,
        },
      ],
      "GHz",
    );
    const series = Array.isArray(option.series) ? option.series[0] : null;

    expect(series).toEqual(
      expect.objectContaining({
        data: [
          expect.objectContaining({ value: [3, 7.5, 0] }),
          expect.objectContaining({
            itemStyle: expect.objectContaining({ borderWidth: 2 }),
            value: [4, 8.25, 1],
          }),
        ],
      }),
    );
    expect(Array.isArray(option.yAxis) ? option.yAxis[1] : null).toEqual(
      expect.objectContaining({ name: "Residual" }),
    );
    expect(Array.isArray(option.series) ? option.series[1] : null).toEqual(
      expect.objectContaining({
        name: "Residual",
        type: "line",
        yAxisIndex: 1,
      }),
    );
  });
});
