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
  buildFmrPeakTableModel,
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
            mode_field_resource_key:
              "/v2/sessions/current/data/fields/field-0/samples/vector?view=phase_rotated_real&phase_rad=0",
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
        modeFieldResourceKey:
          "/v2/sessions/current/data/fields/field-0/samples/vector?view=phase_rotated_real&phase_rad=0",
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
            mode_field_resource_key:
              "/v2/sessions/current/data/fields/field-0/samples/vector?view=phase_rotated_real&phase_rad=0",
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
      resourceRef:
        "/v2/sessions/current/data/fields/field-0/samples/vector?view=phase_rotated_real&phase_rad=0",
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

  it("accepts path_s_rad_per_m as the dispersion x-axis column", () => {
    const model = buildEigenDispersionChartModel(
      textResource(
        [
          "sample_index,raw_mode_index,branch_id,path_s_rad_per_m,frequency_hz",
          "0,1,acoustic,78539816.33974482,1.2e9",
        ].join("\n"),
      ),
    );

    expect(model.droppedPointCount).toBe(0);
    expect(model.points[0]).toEqual(
      expect.objectContaining({
        pathS: 78539816.33974482,
      }),
    );
    expect(model.series[0]?.points).toEqual([
      { rowIndex: 0, x: 78539816.33974482, y: 1.2 },
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

  it("builds driven response amplitude, phase, absorbed-power, and susceptibility series", () => {
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
            susceptibility_tensor: [[1, 2], [3, 4]],
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
      "susceptibility-max-abs",
    ]);
    expect(model.series[0]?.points).toEqual([{ rowIndex: 0, x: 9.5, y: 2 }]);
    expect(model.series[3]?.points).toEqual([{ rowIndex: 0, x: 9.5, y: 5 }]);
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

  it("prefers manifest response field resources for response point field ids", () => {
    const model = buildFrequencyResponseChartModel(
      jsonResource(
        {
          points: [
            {
              field_id: "response-field-from-sweep",
              frequency_hz: 12.5e9,
              frequency_index: 7,
              max_response_amplitude: 0.75,
              observable_id: "mx",
            },
          ],
          schema_version: "magnetic_response_sweep.v2",
        },
        "response/magnetic_response_sweep.v2.json",
      ),
      {
        resources: {
          response_field_resources: [
            {
              field_resource_id: "analysis:frequency-response:frequency-0042",
              frequency_index: 7,
              payload_path:
                "response/field_payloads/frequency_0007/vector_xyz.bin",
            },
          ],
        },
        schema_version: "frequency_domain_manifest.v1",
      },
    );

    expect(model.points[0]).toEqual(
      expect.objectContaining({
        fieldId: "analysis:frequency-response:frequency-0042",
        frequencyIndex: 7,
      }),
    );
    expect(
      buildFrequencyResponsePointSelectionRef(model.points[0]!),
    ).toMatchObject({
      fieldId: "analysis:frequency-response:frequency-0042",
      frequencyIndex: 7,
      kind: "results.frequency_response.frequency_point",
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
              phase_rad: 1.125,
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
    expect(model.series.find((series) => series.quantity === "phase")?.points).toEqual([
      { rowIndex: 0, x: 12.5, y: 1.125 },
    ]);
  });

  it("derives response frequency identity from v2 row order when native artifacts omit per-point indices", () => {
    const model = buildFrequencyResponseChartModel(
      jsonResource(
        {
          points: [
            {
              frequency_hz: 9.5e9,
              response_amplitude: 0.5,
            },
            {
              frequency_hz: 10.5e9,
              response_amplitude: 0.75,
            },
          ],
          response_field_payload_paths: [
            "response/field_payloads/frequency_0000/vector.bin",
            "response/field_payloads/frequency_0001/vector.bin",
          ],
          schema_version: "magnetic_response_sweep.v2",
        },
        "response/magnetic_response_sweep.v2.json",
      ),
    );

    expect(model.points[1]).toEqual(
      expect.objectContaining({
        fieldId: "analysis:frequency-response:frequency-0001",
        frequencyIndex: 1,
      }),
    );
    expect(buildFrequencyResponsePointSelectionRef(model.points[1]!)).toEqual(
      expect.objectContaining({
        fieldId: "analysis:frequency-response:frequency-0001",
        frequencyIndex: 1,
      }),
    );
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

  it("builds FMR peak rows from modal resonances and driven response local maxima", () => {
    const model = buildFmrPeakTableModel({
      responseSweep: jsonResource(
        {
          points: [
            {
              frequency_hz: 9.5e9,
              frequency_index: 0,
              max_response_amplitude: 0.5,
              observable_id: "mx",
            },
            {
              frequency_hz: 10.5e9,
              frequency_index: 1,
              max_response_amplitude: 1.2,
              observable_id: "mx",
              phase_rad: 0.25,
            },
            {
              frequency_hz: 11.5e9,
              frequency_index: 2,
              max_response_amplitude: 0.8,
              observable_id: "mx",
            },
          ],
          schema_version: "magnetic_response_sweep.v2",
        },
        "response/magnetic_response_sweep.v2.json",
      ),
      spectrum: jsonResource({
        modes: [
          {
            frequency_hz: 8.0e9,
            mode_field_id: "analysis:eigen:sample-0000:mode-0002",
            raw_mode_index: 2,
            sample_index: 0,
          },
        ],
      }),
    });

    expect(model.diagnostics).toEqual([]);
    expect(model.peaks).toEqual([
      expect.objectContaining({
        fieldId: "analysis:eigen:sample-0000:mode-0002",
        frequencyHz: 8.0e9,
        modeRef: { rawModeIndex: 2, sampleIndex: 0 },
        source: "modal",
      }),
      expect.objectContaining({
        amplitude: 1.2,
        frequencyHz: 10.5e9,
        frequencyPointIndex: 1,
        phaseRad: 0.25,
        source: "driven_response",
      }),
    ]);
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
