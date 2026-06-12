import { describe, expect, it } from "vitest";

import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
} from "@/kernel/api/apiPaths";

import {
  buildEigenBranchesModel,
  buildEigenDispersionPointSelectionRef,
  buildEigenDispersionChartModel,
  buildEigenModeSelectionRef,
  buildEigenSpectrumChartModel,
  buildFrequencyResponsePointSelectionRef,
  buildFrequencyResponseChartModel,
  routeFrequencyDomainCalculationMode,
  type FrequencyDomainJsonArtifactLike,
  type FrequencyDomainTextArtifactLike,
} from "./frequencyDomainChartModels";

function jsonResource(
  payload: unknown,
  artifactPath?: string,
): FrequencyDomainJsonArtifactLike {
  return {
    artifact_path: artifactPath,
    payload,
    status: "ready",
  };
}

function textResource(text: string): FrequencyDomainTextArtifactLike {
  return {
    status: "ready",
    text,
  };
}

describe("frequencyDomainChartModels", () => {
  it("maps eigen spectrum rows into finite GHz chart points with mode identity", () => {
    const model = buildEigenSpectrumChartModel(
      jsonResource({
        modes: [
          {
            branch_id: "b0",
            frequency_hz: 2.5e9,
            mode_field_id: "field-0",
            raw_mode_index: 3,
            residual_norm: 1e-7,
            sample_index: 2,
            tangent_leakage_max: 1e-8,
          },
          { frequency_hz: "not finite", raw_mode_index: 4 },
        ],
      }),
    );

    expect(model.droppedPointCount).toBe(1);
    expect(model.points).toEqual([
      expect.objectContaining({
        branchId: "b0",
        frequencyHz: 2.5e9,
        modeFieldId: "field-0",
        rawModeIndex: 3,
        sampleIndex: 2,
      }),
    ]);
    expect(model.series[0]?.points).toEqual([{ rowIndex: 0, x: 3, y: 2.5 }]);
    expect(model.series[0]?.unit).toBe("GHz");
  });

  it("builds canonical frequency-domain selection refs for eigen modes", () => {
    const model = buildEigenSpectrumChartModel(
      jsonResource({
        modes: [
          {
            branch_id: "b0",
            frequency_hz: 2.5e9,
            mode_field_id: "field-0",
            raw_mode_index: 3,
            sample_index: 2,
          },
        ],
      }),
    );

    expect(buildEigenModeSelectionRef(model.points[0]!, {
      analysisRunId: "run-1",
      analysisStageId: "stage-1",
      artifactPath: "eigen/spectrum.v2.json",
      calculationMode: "fmr_modal",
    })).toEqual({
      analysisRunId: "run-1",
      analysisStageId: "stage-1",
      artifactPath: "eigen/spectrum.v2.json",
      branchId: "b0",
      calculationMode: "fmr_modal",
      fieldId: "field-0",
      kind: "results.eigen.mode",
      modeIndex: 3,
      nodeId: "results:eigen:sample:2:mode:3",
      sampleIndex: 2,
      type: "frequency-domain",
    });
  });

  it("parses dispersion CSV by path_s and creates one series per branch", () => {
    const model = buildEigenDispersionChartModel(
      textResource(
        [
          "sample_index,raw_mode_index,branch_id,path_s,frequency_hz,residual_norm",
          "0,1,acoustic,0,1.2e9,1e-6",
          "1,2,optical,3.14e7,2.4e9,2e-6",
          "2,3,optical,not-finite,3.1e9,3e-6",
        ].join("\n"),
      ),
    );

    expect(model.droppedPointCount).toBe(1);
    expect(model.points.map((point) => point.branchId)).toEqual([
      "acoustic",
      "optical",
    ]);
    expect(model.series.map((series) => series.id)).toEqual([
      "analysis.frequency-domain:eigen:dispersion:acoustic",
      "analysis.frequency-domain:eigen:dispersion:optical",
    ]);
    expect(model.series[1]?.points).toEqual([
      { rowIndex: 1, x: 3.14e7, y: 2.4 },
    ]);
  });

  it("builds canonical frequency-domain selection refs for dispersion points", () => {
    const model = buildEigenDispersionChartModel(
      textResource(
        [
          "sample_index,raw_mode_index,branch_id,path_s,frequency_hz,residual_norm",
          "4,5,acoustic,2.5e7,1.2e9,1e-6",
        ].join("\n"),
      ),
    );

    expect(buildEigenDispersionPointSelectionRef(model.points[0]!, {
      analysisStageId: "stage-dispersion",
    })).toEqual({
      analysisStageId: "stage-dispersion",
      branchId: "acoustic",
      calculationMode: "dispersion_modal",
      kind: "results.eigen.dispersion",
      modeIndex: 5,
      nodeId: "results:eigen:dispersion:sample:4:mode:5",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
      sampleIndex: 4,
      type: "frequency-domain",
    });
  });

  it("parses branch tracking artifacts into branch summaries", () => {
    const model = buildEigenBranchesModel(
      jsonResource({
        branches: [
          {
            branch_id: 0,
            label: "acoustic",
            points: [
              {
                frequency_imag_hz: -1e6,
                frequency_real_hz: 1.2e9,
                overlap_prev: null,
                raw_mode_index: 3,
                sample_index: 0,
                tracking_confidence: 1,
              },
              {
                frequency_imag_hz: -1.5e6,
                frequency_real_hz: 1.5e9,
                overlap_prev: 0.93,
                raw_mode_index: 2,
                sample_index: 1,
                tracking_confidence: 0.95,
              },
            ],
          },
          { label: "missing id", points: [] },
        ],
      }),
    );

    expect(model.droppedBranchCount).toBe(1);
    expect(model.branches).toEqual([
      expect.objectContaining({
        branchId: "0",
        frequencyMaxHz: 1.5e9,
        frequencyMinHz: 1.2e9,
        label: "acoustic",
        overlapPrevMin: 0.93,
        sampleMax: 1,
        sampleMin: 0,
        trackingConfidenceMin: 0.95,
      }),
    ]);
  });

  it("builds driven response amplitude, phase, and absorbed-power series", () => {
    const model = buildFrequencyResponseChartModel(
      jsonResource({
        points: [
          {
            absorbed_power_density: 4.5,
            amplitude: 2.0,
            field_id: "response-field-0",
            frequency_hz: 9.5e9,
            observable_id: "mx",
            phase_rad: 1.25,
            residual_norm: 1e-5,
            susceptibility: [1, 2, 3],
          },
          { amplitude: 3.0, frequency_hz: Number.NaN },
        ],
        schema_version: "magnetic_response_sweep.v1",
      }),
    );

    expect(model.droppedPointCount).toBe(1);
    expect(model.dataSourceVersion).toBe("response.v1");
    expect(model.points[0]).toEqual(
      expect.objectContaining({
        fieldId: "response-field-0",
        frequencyHz: 9.5e9,
        observableId: "mx",
      }),
    );
    expect(model.series.map((series) => series.quantity)).toEqual([
      "amplitude",
      "phase",
      "absorbed-power-density",
    ]);
    expect(model.series[0]?.points).toEqual([{ rowIndex: 0, x: 9.5, y: 2 }]);
  });

  it("builds canonical frequency-domain selection refs for response frequency points", () => {
    const model = buildFrequencyResponseChartModel(
      jsonResource(
        {
          points: [
            {
              amplitude: 0.75,
              field_id: "response-field-7",
              frequency_hz: 12.5e9,
              frequency_index: 7,
              observable_id: "mx",
            },
          ],
          schema_version: "magnetic_response_sweep.v2",
        },
        "response/magnetic_response_sweep.v2.json",
      ),
    );

    expect(buildFrequencyResponsePointSelectionRef(model.points[0]!, {
      analysisRunId: "run-response",
      artifactPath: "response/magnetic_response_sweep.v2.json",
    })).toEqual({
      analysisRunId: "run-response",
      artifactPath: "response/magnetic_response_sweep.v2.json",
      calculationMode: "fmr_response",
      fieldId: "response-field-7",
      frequencyIndex: 7,
      kind: "results.frequency_response.frequency_point",
      nodeId: "results:frequency-response:frequency:7",
      observableId: "mx",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
      type: "frequency-domain",
    });
  });

  it("builds driven response charts from v2 point summaries with provenance", () => {
    const model = buildFrequencyResponseChartModel(
      jsonResource(
        {
          points: [
            {
              absorbed_power_density: 8.5,
              frequency_hz: 12.5e9,
              frequency_index: 7,
              max_response_amplitude: 0.75,
              relative_residual_l2_norm: 2e-5,
              response_field_payload_path:
                "response/field_payloads/frequency_0007/vector.bin",
            },
          ],
          schema_version: "magnetic_response_sweep.v2",
        },
        "response/magnetic_response_sweep.v2.json",
      ),
    );

    expect(model.dataSourceVersion).toBe("response.v2");
    expect(model.diagnostics).toEqual([]);
    expect(model.points[0]).toEqual(
      expect.objectContaining({
        amplitude: 0.75,
        fieldId: "analysis:frequency-response:frequency-0007",
        frequencyHz: 12.5e9,
        frequencyIndex: 7,
      }),
    );
    expect(model.series[0]?.points).toEqual([{ rowIndex: 0, x: 12.5, y: 0.75 }]);
  });

  it("reports a visible diagnostic when a v2 response artifact has no readable points", () => {
    const model = buildFrequencyResponseChartModel(
      jsonResource(
        {
          points: [],
          schema_version: "magnetic_response_sweep.v2",
        },
        "response/magnetic_response_sweep.v2.json",
      ),
    );

    expect(model.dataSourceVersion).toBe("response.v2");
    expect(model.diagnostics).toContain(
      "response.v2 artifact is present but contains no readable points",
    );
  });

  it("routes fmr_response manifests to response sweep charts", () => {
    const route = routeFrequencyDomainCalculationMode({
      artifacts: {
        response_sweep_v2_path: "response/magnetic_response_sweep.v2.json",
      },
      requested_execution: { calculation_mode: "fmr_response" },
      stage_kind: "frequency_response",
    });

    expect(route).toEqual(
      expect.objectContaining({
        mode: "fmr_response",
        primaryChart: "response-sweep",
        status: "available",
      }),
    );
    expect(route.supportingCharts).toContain("response-field-overlay");
  });

  it("routes dispersion_modal manifests to path_s dispersion charts", () => {
    const route = routeFrequencyDomainCalculationMode({
      artifacts: {
        dispersion_csv_path: "eigen/dispersion.csv",
      },
      requested_execution: { calculation_mode: "dispersion_modal" },
      stage_kind: "eigenmodes",
    });

    expect(route).toEqual(
      expect.objectContaining({
        mode: "dispersion_modal",
        primaryChart: "dispersion",
        status: "available",
      }),
    );
    expect(route.supportingCharts).toContain("branch-table");
  });

  it("falls back to free mode spectrum routing for modal stages without explicit mode", () => {
    const route = routeFrequencyDomainCalculationMode({
      artifacts: {},
      stage_kind: "eigenmodes",
    });

    expect(route.mode).toBe("free_modes");
    expect(route.primaryChart).toBe("modal-spectrum");
    expect(route.status).toBe("unavailable");
    expect(route.unavailableReason).toBe("spectrum artifact is missing");
  });
});
