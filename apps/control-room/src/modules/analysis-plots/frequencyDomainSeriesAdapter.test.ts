import { describe, expect, it } from "vitest";

import { ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH } from "@/kernel/api/apiPaths";
import {
  buildEigenDispersionChartModel,
  buildEigenSpectrumChartModel,
  buildFrequencyResponseChartModel,
  type FrequencyDomainChartBuildResult,
  type FrequencyDomainChartSeries,
} from "@/shared/domain/analysis/frequencyDomainChartModels";

import {
  frequencyDomainChartSeriesForAnalysisPlots,
  frequencyDomainPrimarySeries,
  frequencyDomainXAxisLabel,
  MAX_FREQUENCY_DOMAIN_RENDER_POINTS,
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
        unit: "not published",
        xUnit: "GHz",
      }),
    );
    expect(series[0]?.points).toEqual([{ rowIndex: 0, x: 9.5, y: 2 }]);
    expect(series.slice(0, 1).map((entry) => ({
      dataRevision: entry.dataRevision ?? null,
      id: entry.id,
      points: entry.points,
      source: entry.source,
      status: entry.status,
      unit: entry.unit,
      xUnit: entry.xUnit,
    }))).toEqual([{
      dataRevision: null,
      id: "analysis.frequency-domain:response:amplitude",
      points: [{ rowIndex: 0, x: 9.5, y: 2 }],
      source: { kind: "analysis.frequency_domain", resourceKey: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH, tableId: "frequency-domain:response-sweep" },
      status: "ready",
      unit: "not published",
      xUnit: "GHz",
    }]);
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

  it("keeps large frequency-domain render series bounded while preserving endpoints", () => {
    const points = Array.from({ length: MAX_FREQUENCY_DOMAIN_RENDER_POINTS + 1 }, (_, rowIndex) => ({
      rowIndex,
      x: rowIndex,
      y: rowIndex * 2,
    }));
    const model: FrequencyDomainChartBuildResult<unknown> = {
      dataSourceVersion: "unknown",
      diagnostics: [],
      droppedPointCount: 0,
      points: [],
      series: [{
        id: "analysis.frequency-domain:test-bounded",
        label: "Bounded test",
        points,
        quantity: "test",
        source: {
          kind: "analysis.frequency_domain",
          resourceKey: "analysis/frequency-domain/test-bounded",
          tableId: "frequency-domain:test-bounded",
        },
        status: "ready",
        unit: "a.u.",
        xUnit: "1",
      }],
    };

    const bounded = frequencyDomainChartSeriesForAnalysisPlots(model)[0]?.points ?? [];
    expect(bounded).toHaveLength(MAX_FREQUENCY_DOMAIN_RENDER_POINTS);
    expect(bounded[0]).toEqual(points[0]);
    expect(bounded.at(-1)).toEqual(points.at(-1));
  });

  it("preserves a narrow resonance when bounding a large render series", () => {
    const pointCount = MAX_FREQUENCY_DOMAIN_RENDER_POINTS + 1;
    const resonanceIndex = 4321;
    const points = Array.from({ length: pointCount }, (_, rowIndex) => ({
      rowIndex,
      x: rowIndex,
      y: rowIndex === resonanceIndex ? 100 : 0,
    }));
    const model: FrequencyDomainChartBuildResult<unknown> = {
      dataSourceVersion: "unknown",
      diagnostics: [],
      droppedPointCount: 0,
      points: [],
      series: [{
        id: "analysis.frequency-domain:test-resonance",
        label: "Resonance test",
        points,
        quantity: "test",
        source: {
          kind: "analysis.frequency_domain",
          resourceKey: "analysis/frequency-domain/test-resonance",
          tableId: "frequency-domain:test-resonance",
        },
        status: "ready",
        unit: "a.u.",
        xUnit: "1",
      }],
    };

    const bounded = frequencyDomainChartSeriesForAnalysisPlots(model)[0]?.points ?? [];

    expect(bounded).toHaveLength(MAX_FREQUENCY_DOMAIN_RENDER_POINTS);
    expect(bounded[0]).toEqual(points[0]);
    expect(bounded.at(-1)).toEqual(points.at(-1));
    expect(bounded).toContainEqual(points[resonanceIndex]);
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

  it("labels ECharts x axes by frequency-domain chart semantics", () => {
    const spectrum = frequencyDomainChartSeriesForAnalysisPlots(
      buildEigenSpectrumChartModel({
        payload: {
          modes: [{ frequency_hz: 3e9, raw_mode_index: 1, sample_index: 0 }],
        },
        status: "ready",
      }),
    );
    const dispersion = frequencyDomainChartSeriesForAnalysisPlots(
      buildEigenDispersionChartModel({
        status: "ready",
        text: [
          "sample_index,raw_mode_index,branch_id,path_s_rad_per_m,frequency_hz",
          "0,1,acoustic,78539816.33974482,9.5e9",
        ].join("\n"),
      }),
    );
    const response = frequencyDomainChartSeriesForAnalysisPlots(
      buildFrequencyResponseChartModel({
        payload: {
          points: [{ frequency_hz: 9.5e9, max_response_amplitude: 2 }],
        },
        status: "ready",
      }),
    );

    expect(frequencyDomainXAxisLabel(spectrum)).toBe("mode index");
    expect(frequencyDomainXAxisLabel(dispersion)).toBe("path_s [rad/m]");
    expect(frequencyDomainXAxisLabel(response)).toBe("frequency [GHz]");
  });

  it("uses MHz axis units for sub-GHz frequency-response sweeps", () => {
    const series = frequencyDomainChartSeriesForAnalysisPlots(
      buildFrequencyResponseChartModel({
        payload: {
          points: [{ frequency_hz: 500e6, max_response_amplitude: 2 }],
        },
        status: "ready",
      }),
    );

    expect(series[0]).toEqual(
      expect.objectContaining({
        xUnit: "MHz",
      }),
    );
    expect(series[0]?.points).toEqual([{ rowIndex: 0, x: 500, y: 2 }]);
    expect(frequencyDomainXAxisLabel(series)).toBe("frequency [MHz]");
  });

  it("uses MHz units for sub-GHz eigen spectrum frequencies", () => {
    const model = buildEigenSpectrumChartModel({
      payload: {
        modes: [{ frequency_hz: 750e6, raw_mode_index: 1, sample_index: 0 }],
      },
      status: "ready",
    });

    expect(model.series[0]).toEqual(
      expect.objectContaining({
        unit: "MHz",
      }),
    );
    expect(model.series[0]?.points).toEqual([{ rowIndex: 0, x: 1, y: 750 }]);
  });

  it("uses MHz units for sub-GHz dispersion frequencies", () => {
    const model = buildEigenDispersionChartModel({
      status: "ready",
      text: [
        "sample_index,raw_mode_index,branch_id,path_s_rad_per_m,frequency_hz",
        "0,1,acoustic,78539816.33974482,250e6",
      ].join("\n"),
    });

    expect(model.series[0]).toEqual(
      expect.objectContaining({
        unit: "MHz",
      }),
    );
    expect(model.series[0]?.points).toEqual([
      { rowIndex: 0, x: 78539816.33974482, y: 250 },
    ]);
  });
});
