import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  frequencySeriesRenderModel,
  frequencySpectrumRenderModel,
} from "@/shared/analysis-charts/frequencyRenderModels";

import {
  frequencyDomainSeriesPointIndexFromChartEvent,
  FrequencyDomainDispersionChart,
  FrequencyDomainResponseChart,
  FrequencyDomainSpectrumChart,
  frequencyDomainSpectrumChartRenderModel,
  spectrumPointIndexFromChartEvent,
} from "./FrequencyDomainCharts";

describe("FrequencyDomainCharts", () => {
  it("never disposes an ECharts instance owned by another mounted frame", () => {
    const source = readFileSync(
      new URL("./FrequencyDomainCharts.tsx", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("oldestChart.dispose()");
    expect(source).not.toContain("activeCharts.shift()");
    expect(source).toContain("EChartsCanvasSurface");
    expect(source).not.toContain("echarts.init");
    expect(source).not.toContain("chartRef.current");
    expect(source).not.toContain("onDoubleClick={() => onPlotMode");
  });

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
              displayModeIndex: 1,
              frequencyHz: 750e6,
              imaginaryFrequencyHz: null,
              modeFieldId: "analysis:eigen:sample-0000:mode-0001",
              modeFieldResourceKey: null,
              modeId: null,
              rawModeIndex: 1,
              residualNorm: 1e-8,
              sampleIndex: 0,
              tangentLeakageMax: 2e-5,
            },
            ...Array.from({ length: 5 }, (_, index) => ({
              branchId: null,
              dampingRateHz: null,
              displayModeIndex: index + 2,
              frequencyHz: (800 + index * 25) * 1e6,
              imaginaryFrequencyHz: null,
              modeFieldId:
                index === 4 ? "analysis:eigen:sample-0000:mode-0006" : null,
              modeFieldResourceKey: null,
              modeId: null,
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
                { rowIndex: 0, x: 750, y: 1 },
                { rowIndex: 1, x: 800, y: 2 },
                { rowIndex: 2, x: 825, y: 3 },
                { rowIndex: 3, x: 850, y: 4 },
                { rowIndex: 4, x: 875, y: 5 },
                { rowIndex: 5, x: 900, y: 6 },
              ],
              quantity: "frequency",
              source: {
                kind: "analysis.frequency_domain",
                resourceKey: "analysis/frequency-domain/eigen/spectrum.v2",
                tableId: "frequency-domain:eigen-spectrum",
              },
              status: "ready",
              unit: "MHz",
              xUnit: "MHz",
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

  it("keeps modal spectrum axes on display mode rank and physical Hz", () => {
    const renderModel = frequencyDomainSpectrumChartRenderModel({
      dataSourceVersion: "unknown",
      diagnostics: [],
      droppedPointCount: 0,
      points: [
        {
          branchId: null,
          dampingRateHz: null,
          displayModeIndex: 0,
          frequencyHz: 3e9,
          imaginaryFrequencyHz: null,
          modeFieldId: null,
          modeFieldResourceKey: null,
          modeId: "mode-alpha",
          rawModeIndex: 17,
          residualNorm: null,
          sampleIndex: 0,
          tangentLeakageMax: null,
        },
        {
          branchId: null,
          dampingRateHz: null,
          displayModeIndex: 1,
          frequencyHz: 4e9,
          imaginaryFrequencyHz: null,
          modeFieldId: null,
          modeFieldResourceKey: null,
          modeId: "mode-beta",
          rawModeIndex: 99,
          residualNorm: null,
          sampleIndex: 0,
          tangentLeakageMax: null,
        },
      ],
      series: [
        {
          id: "analysis.frequency-domain:eigen:spectrum:frequency",
          label: "Eigen frequency",
          points: [
            { rowIndex: 0, x: 0, y: 3e9 },
            { rowIndex: 1, x: 1, y: 4e9 },
          ],
          quantity: "frequency",
          source: {
            kind: "analysis.frequency_domain",
            resourceKey: "analysis/frequency-domain/eigen/spectrum.v2",
            tableId: "frequency-domain:eigen-spectrum",
          },
          status: "ready",
          unit: "Hz",
          xUnit: "1",
        },
      ],
    });

    expect(renderModel.xAxis).toEqual({
      label: "mode rank [1]",
      unit: "1",
    });
    expect(renderModel.yAxes[0]).toEqual({
      label: "Eigen frequency [Hz]",
      unit: "Hz",
    });
    expect(renderModel.series[0]?.points).toEqual([
      { rowIndex: 0, x: 0, y: 3e9 },
      { rowIndex: 1, x: 1, y: 4e9 },
    ]);
  });

  it("labels response chart x axes with the series frequency unit", () => {
    const model = frequencySeriesRenderModel(
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
      "Response",
      "frequency",
    );

    expect(model.xAxis.label).toBe("frequency [MHz]");
  });

  it("maps spectrum chart events back to the model row", () => {
    expect(spectrumPointIndexFromChartEvent({ data: [3, 7.5, 4] })).toBe(4);
    expect(spectrumPointIndexFromChartEvent({ data: [3, 7.5] })).toBeNull();
    expect(spectrumPointIndexFromChartEvent({ data: "invalid" })).toBeNull();
  });

  it("maps generic frequency-domain series events back to the model row", () => {
    const model = frequencySeriesRenderModel(
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
      "Response",
      "frequency",
    );
    expect(model.series[0]?.points).toEqual([{ rowIndex: 3, x: 9.5, y: 2 }]);
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
              analyticFrequencyHz: null,
              branchId: "acoustic",
              frequencyHz: 7.5e9,
              linewidthHz: 2.8e6,
              modeFieldId: null,
              modeFieldResourceKey: null,
              overlap: 0.97,
              pathS: 1.25e6,
              rawModeIndex: 2,
              relativeError: null,
              residualNorm: 1e-8,
              sampleLabel: "G",
              sampleIndex: 4,
              validationGeometry: null,
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
    expect(responseHtml).toContain("Load response field 0 at 9.5 GHz");
    expect(responseHtml).toContain("field ready");
    expect(dispersionHtml).toContain("Select dispersion G sample 4, mode 2");
    expect(dispersionHtml).toContain("G sample 4, mode 2");
    expect(dispersionHtml).toContain("branch acoustic");
    expect(dispersionHtml).toContain("linewidth 2.8 MHz");
  });

  it("renders response component and quantity controls without mixing chart units", () => {
    const model = {
      dataSourceVersion: "response.v2" as const,
      diagnostics: [],
      droppedPointCount: 0,
      points: [
        {
          absorbedPowerDensity: 10,
          amplitude: 2,
          fieldId: "analysis:frequency-response:frequency-0000",
          frequencyHz: 9.5e9,
          frequencyIndex: 0,
          phaseRad: 0.25,
          residualNorm: 1e-7,
          susceptibility: null,
          observableId: "mx",
        },
        {
          absorbedPowerDensity: 11,
          amplitude: 3,
          fieldId: "analysis:frequency-response:frequency-0001",
          frequencyHz: 9.7e9,
          frequencyIndex: 1,
          phaseRad: 0.5,
          residualNorm: 2e-7,
          susceptibility: null,
          observableId: "mx",
        },
        {
          absorbedPowerDensity: 12,
          amplitude: 4,
          fieldId: "analysis:frequency-response:frequency-0002",
          frequencyHz: 9.9e9,
          frequencyIndex: 2,
          phaseRad: 0.75,
          residualNorm: 3e-7,
          susceptibility: null,
          observableId: "mx",
        },
        {
          absorbedPowerDensity: 13,
          amplitude: 5,
          fieldId: "analysis:frequency-response:frequency-0003",
          frequencyHz: 10.1e9,
          frequencyIndex: 3,
          phaseRad: 1,
          residualNorm: 4e-7,
          susceptibility: null,
          observableId: "mx",
        },
        {
          absorbedPowerDensity: 14,
          amplitude: 6,
          fieldId: "analysis:frequency-response:frequency-0004",
          frequencyHz: 10.3e9,
          frequencyIndex: 4,
          phaseRad: 1.25,
          residualNorm: 5e-7,
          susceptibility: null,
          observableId: "mx",
        },
        {
          absorbedPowerDensity: 20,
          amplitude: 7,
          fieldId: "analysis:frequency-response:frequency-0005",
          frequencyHz: 10.5e9,
          frequencyIndex: 5,
          phaseRad: 1.5,
          residualNorm: 6e-7,
          susceptibility: null,
          observableId: "my",
        },
      ],
      series: [
        {
          id: "analysis.frequency-domain:response:amplitude",
          label: "Amplitude",
          points: [
            { rowIndex: 0, x: 9.5, y: 2 },
            { rowIndex: 1, x: 9.7, y: 3 },
            { rowIndex: 2, x: 9.9, y: 4 },
            { rowIndex: 3, x: 10.1, y: 5 },
            { rowIndex: 4, x: 10.3, y: 6 },
            { rowIndex: 5, x: 10.5, y: 7 },
          ],
          quantity: "amplitude",
          source: {
            kind: "analysis.frequency_domain" as const,
            resourceKey: "analysis/frequency-domain/response/magnetic-sweep",
            tableId: "frequency-domain:response-sweep",
          },
          status: "ready" as const,
          unit: "a.u.",
          xUnit: "GHz",
        },
        {
          id: "analysis.frequency-domain:response:phase",
          label: "Phase",
          points: [
            { rowIndex: 0, x: 9.5, y: 0.25 },
            { rowIndex: 1, x: 9.7, y: 0.5 },
            { rowIndex: 2, x: 9.9, y: 0.75 },
            { rowIndex: 3, x: 10.1, y: 1 },
            { rowIndex: 4, x: 10.3, y: 1.25 },
            { rowIndex: 5, x: 10.5, y: 1.5 },
          ],
          quantity: "phase",
          source: {
            kind: "analysis.frequency_domain" as const,
            resourceKey: "analysis/frequency-domain/response/magnetic-sweep",
            tableId: "frequency-domain:response-sweep",
          },
          status: "ready" as const,
          unit: "rad",
          xUnit: "GHz",
        },
      ],
    };
    const html = renderToStaticMarkup(
      <FrequencyDomainResponseChart model={model} />,
    );
    const renderModel = frequencySeriesRenderModel(model.series, "Response", "frequency");

    expect(html).toContain("Response component");
    expect(html).toContain("mx");
    expect(html).toContain("my");
    expect(html).toContain("Chart quantity");
    expect(html).toContain("Amplitude");
    expect(html).toContain("Phase");
    expect(html).toContain("Load response field 4 at 10.3 GHz");
    expect(renderModel.series).toHaveLength(1);
    expect(renderModel.yAxes[0]?.label).toBe("Amplitude [a.u.]");
  });

  it("highlights the selected spectrum mode without changing point identity", () => {
    const model = frequencySpectrumRenderModel(
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
    expect(model.series.find((series) => series.id === "modes")?.points).toEqual([
      { rowIndex: 0, x: 7.5, y: 1 },
      { rowIndex: 1, x: 8.25, y: 1 },
    ]);
  });
});
