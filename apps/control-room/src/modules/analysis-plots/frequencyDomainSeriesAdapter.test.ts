import { describe, expect, it } from "vitest";

import { ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH } from "@/kernel/api/apiPaths";
import {
  buildEigenSpectrumChartModel,
  buildFrequencyResponseChartModel,
  type FrequencyDomainChartBuildResult,
  type FrequencyDomainChartSeries,
} from "@/shared/domain/analysis/frequencyDomainChartModels";

import {
  frequencyDomainChartSeriesForAnalysisPlots,
  frequencyDomainPrimarySeries,
} from "./frequencyDomainSeriesAdapter";

describe("frequencyDomainSeriesAdapter", () => {
  it("adapts frequency-domain model series to the existing analysis plot series shape", () => {
    const model = buildFrequencyResponseChartModel({
      artifact_path: "response/magnetic_response_sweep.v2.json",
      payload: {
        points: [
          {
            absorbed_power_density: 4.5,
            frequency_hz: 9.5e9,
            frequency_index: 0,
            max_response_amplitude: 2,
            phase_rad: 0.5,
            susceptibility: [0.25, -4],
          },
        ],
        schema_version: "magnetic_response_sweep.v2",
      },
      status: "ready",
    });

    const series = frequencyDomainChartSeriesForAnalysisPlots(model);

    expect(series.map((entry) => entry.quantity)).toEqual([
      "amplitude",
      "phase",
      "absorbed-power-density",
      "susceptibility-max-abs",
    ]);
    expect(series[0]).toEqual(
      expect.objectContaining({
        id: "analysis.frequency-domain:response:amplitude",
        source: {
          kind: "analysis.frequency_domain",
          resourceKey: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
          tableId: "frequency-domain:response-sweep",
        },
        unit: "a.u.",
        xUnit: "GHz",
      }),
    );
    expect(series[0]?.points).toEqual([{ rowIndex: 0, x: 9.5, y: 2 }]);
  });

  it("filters invalid chart points before handing data to chart primitives", () => {
    const model: FrequencyDomainChartBuildResult<unknown> = {
      dataSourceVersion: "unknown",
      diagnostics: [],
      droppedPointCount: 0,
      points: [],
      series: [
        {
          id: "analysis.frequency-domain:test",
          label: "Test",
          points: [
            { rowIndex: 0, x: 1, y: 2 },
            { rowIndex: -1, x: 2, y: 3 },
            { rowIndex: 1, x: Number.NaN, y: 3 },
            { rowIndex: 2, x: 2, y: Number.POSITIVE_INFINITY },
          ],
          quantity: "test",
          source: {
            kind: "analysis.frequency_domain",
            resourceKey: "analysis/frequency-domain/test",
            tableId: "frequency-domain:test",
          },
          status: "ready",
          unit: "a.u.",
          xUnit: "GHz",
        },
      ],
    };

    expect(frequencyDomainChartSeriesForAnalysisPlots(model)[0]?.points).toEqual([
      { rowIndex: 0, x: 1, y: 2 },
    ]);
  });

  it("returns the first renderable frequency-domain series for default chart focus", () => {
    const model = buildEigenSpectrumChartModel({
      payload: {
        modes: [{ frequency_hz: 3e9, raw_mode_index: 1, sample_index: 0 }],
      },
      status: "ready",
    });

    expect(frequencyDomainPrimarySeries(model.series)).toEqual(
      expect.objectContaining({
        id: "analysis.frequency-domain:eigen:spectrum:frequency",
      } satisfies Partial<FrequencyDomainChartSeries>),
    );
  });
});
