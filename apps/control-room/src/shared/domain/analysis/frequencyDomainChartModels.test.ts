import { fieldVectorResourceKey as canonicalFieldVectorResourceKey } from "@/kernel/api/fieldQueryIdentity";
import { describe, expect, it } from "vitest";

import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  DATA_FIELD_VECTOR_PATH,
} from "@/kernel/api/apiPaths";

import {
  buildEigenBranchSelectionRef,
  buildEigenBranchDetailChartModel,
  buildEigenBranchPointModeSelectionRef,
  buildEigenBranchesModel,
  buildEigenDispersionPointSelectionRef,
  buildEigenDispersionChartModel,
  buildEigenModeSelectionRef,
  buildEigenSpectrumChartModel,
  buildFrequencyResponsePointSelectionRef,
  buildFrequencyResponseChartModel,
  buildFmrPeakTableModel,
  eigenModeFieldAvailable,
  readEigenSpectrumPayload,
  frequencyResponseSeriesUnit,
  frequencyDomainChartRouteOverrideFromSelection,
  frequencyDomainChartRouteOverrideFromSubview,
  frequencyDomainManifestSupportsChartRoute,
  frequencyDomainResultContextFromManifest,
  routeFrequencyDomainCalculationMode,
  type FrequencyDomainJsonArtifactLike,
  type FrequencyDomainTextArtifactLike,
} from "./frequencyDomainChartModels";

const artifactOwnership = {
  artifact_set_id: "fixture-artifact-set",
  session_id: "session-a",
  run_id: "run-a",
  stage_id: "stage-a",
  mesh_generation_id: "mesh-a",
};

function jsonResource(
  payload: unknown,
  artifactPath?: string,
): FrequencyDomainJsonArtifactLike {
  return {
    ...artifactOwnership,
    artifact_path: artifactPath,
    payload,
    status: "ready",
  };
}

function textResource(text: string): FrequencyDomainTextArtifactLike {
  return {
    ...artifactOwnership,
    status: "ready",
    text,
  };
}

function fieldVectorResourceKey(
  fieldId: string,
  query?: string,
): string {
  return query === undefined
    ? canonicalFieldVectorResourceKey(fieldId, { view: "phase_rotated_real", phase_rad: 0 })
    : `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", fieldId)}?${query}`;
}

describe("frequencyDomainChartModels", () => {
  it("maps eigen spectrum rows into finite Hz chart points with mode identity", () => {
    const model = buildEigenSpectrumChartModel(
      jsonResource({
        modes: [
          {
            branch_id: "b0",
            frequency_hz: 2.5e9,
            mode_field_id: "field-0",
            mode_field_resource_key: fieldVectorResourceKey("field-0"),
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
        modeFieldResourceKey: fieldVectorResourceKey("field-0"),
        rawModeIndex: 3,
        residualNorm: 1e-7,
        sampleIndex: 2,
      }),
    ]);
    expect(model.series[0]?.points).toEqual([
      { rowIndex: 0, x: 3, y: 2.5 },
    ]);
    expect(model.series[0]?.unit).toBe("GHz");
    expect(model.series[0]?.xUnit).toBe("1");
  });

  it("reads canonical relative L2 from spectrum.v3 without mode-detail artifacts", () => {
    const model = buildEigenSpectrumChartModel(
      jsonResource({
        samples: [{
          modes: [{
            frequency_real_hz: 2.25e9,
            raw_mode_index: 4,
            residual_norm: 6e-5,
            residual_relative_l2: 2e-9,
          }],
          sample_id: "k-path-sample-0003",
          sample_index: 3,
        }],
        schema_version: "eigen_spectrum.v3",
      }, "eigen/spectrum.v3.json"),
    );

    expect(model.points).toHaveLength(1);
    expect(model.points[0]).toMatchObject({
      frequencyHz: 2.25e9,
      modeFieldId: null,
      modeFieldResourceKey: null,
      rawModeIndex: 4,
      residualNorm: 6e-5,
      residualRelativeL2: 2e-9,
      sampleId: "k-path-sample-0003",
      sampleIndex: 3,
    });
  });

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY, -1, "2e-9"])(
    "omits invalid canonical spectrum relative L2 values (%s)",
    (residualRelativeL2) => {
      const model = buildEigenSpectrumChartModel(jsonResource({
        modes: [{
          frequency_hz: 2.25e9,
          raw_mode_index: 4,
          residual_relative_l2: residualRelativeL2,
        }],
        schema_version: "eigen_spectrum.v3",
      }));

      expect(model.points[0]).not.toHaveProperty("residualRelativeL2");
    },
  );

  it("preserves zero as a valid canonical spectrum relative L2 value", () => {
    const model = buildEigenSpectrumChartModel(jsonResource({
      modes: [{ frequency_hz: 2.25e9, raw_mode_index: 4, residual_relative_l2: 0 }],
      schema_version: "eigen_spectrum.v3",
    }));

    expect(model.points[0]).toMatchObject({ residualRelativeL2: 0 });
  });

  it("honors explicit false mode-field availability even when an id is present", () => {
    const model = buildEigenSpectrumChartModel(
      jsonResource({
        modes: [
          {
            frequency_hz: 2.5e9,
            mode_field_available: false,
            mode_field_id: "analysis:eigen:sample-0000:mode-0001",
            mode_field_resource_key: fieldVectorResourceKey(
              "analysis:eigen:sample-0000:mode-0001",
            ),
            mode_id: "sample-0000/mode-0001",
            raw_mode_index: 1,
            sample_id: "k-sample-0000",
            sample_index: 0,
          },
        ],
      }),
    );

    const point = model.points[0]!;
    expect(point).toMatchObject({
      modeFieldAvailable: false,
      modeFieldId: "analysis:eigen:sample-0000:mode-0001",
      modeFieldResourceKey: null,
    });
    const selection = buildEigenModeSelectionRef(point);
    expect(selection).not.toHaveProperty("fieldId");
    expect(selection).not.toHaveProperty("resourceRef");
    expect(selection).toMatchObject({
      modeId: "sample-0000/mode-0001",
      sampleId: "k-sample-0000",
    });
  });

  it("does not infer field availability from an unconfirmed mode field id", () => {
    const model = buildEigenSpectrumChartModel(
      jsonResource({
        modes: [{
          frequency_hz: 2.5e9,
          mode_field_id: "analysis:eigen:sample-0000:mode-0001",
          raw_mode_index: 1,
          sample_index: 0,
        }],
      }),
    );
    const point = model.points[0]!;
    expect(point).toMatchObject({
      modeFieldAvailable: false,
      modeFieldId: "analysis:eigen:sample-0000:mode-0001",
      modeFieldResourceKey: null,
    });
    expect(buildEigenModeSelectionRef(point)).not.toHaveProperty("fieldId");
    expect(buildEigenModeSelectionRef(point)).not.toHaveProperty("resourceRef");
    expect(eigenModeFieldAvailable({
      modeFieldAvailable: true,
      modeFieldId: null,
      modeFieldResourceKey: "data/fields/orphaned",
    })).toBe(false);
  });

  it("derives the canonical vector resource for a published available spectrum.v2 field", () => {
    const fieldId = "analysis:eigen:sample-0003:mode-0001";
    const model = buildEigenSpectrumChartModel(jsonResource({
      samples: [{
        sample_index: 3,
        modes: [{
          frequency_hz: 2.25e9,
          mode_field_available: true,
          mode_field_id: fieldId,
          mode_id: "sample-0003/mode-0001",
          raw_mode_index: 1,
        }],
      }],
      schema_version: "eigen_spectrum.v2",
    }));

    const point = model.points[0]!;
    expect(point).toMatchObject({
      modeFieldAvailable: true,
      modeFieldId: fieldId,
      modeFieldResourceKey: fieldVectorResourceKey(fieldId),
      sampleIndex: 3,
      rawModeIndex: 1,
    });
    expect(buildEigenModeSelectionRef(point)).toMatchObject({
      fieldId,
      resourceRef: fieldVectorResourceKey(fieldId),
      modeId: "sample-0003/mode-0001",
    });
  });

  it("does not fabricate a spectrum field resource for omitted or unidentified payloads", () => {
    const model = buildEigenSpectrumChartModel(jsonResource({
      modes: [
        {
          frequency_hz: 2e9,
          mode_field_available: false,
          mode_field_id: "analysis:eigen:sample-0000:mode-0000",
          raw_mode_index: 0,
        },
        {
          frequency_hz: 3e9,
          mode_field_available: true,
          raw_mode_index: 1,
        },
      ],
    }));

    expect(model.points).toHaveLength(2);
    expect(model.points[0]?.modeFieldId).toBe("analysis:eigen:sample-0000:mode-0000");
    for (const point of model.points) {
      expect(point.modeFieldAvailable).toBe(false);
      expect(point.modeFieldResourceKey).toBeNull();
      expect(buildEigenModeSelectionRef(point)).not.toHaveProperty("fieldId");
      expect(buildEigenModeSelectionRef(point)).not.toHaveProperty("resourceRef");
    }
  });

  it("maps canonical v2 sample modes into finite spectrum points with field ids", () => {
    const mode0ResourceKey = fieldVectorResourceKey(
      "analysis:eigen:sample-0000:mode-0000",
    );
    const mode1ResourceKey = fieldVectorResourceKey(
      "analysis:eigen:sample-0003:mode-0001",
    );

    const model = buildEigenSpectrumChartModel(
      jsonResource({
        samples: [
          {
            label: "Gamma",
            modes: [
              {
                frequency_hz: 1.481196536e9,
                mode_field_id: "analysis:eigen:sample-0000:mode-0000",
                mode_field_resource_key: mode0ResourceKey,
                raw_mode_index: 0,
                residual_norm: 1e-10,
              },
            ],
            sample_index: 0,
          },
          {
            modes: [
              {
                frequency_hz: 2.25e9,
                mode_field_id: "analysis:eigen:sample-0003:mode-0001",
                mode_field_resource_key: mode1ResourceKey,
                raw_mode_index: 1,
              },
            ],
            sample_index: 3,
          },
        ],
        schema_version: "frequency_domain_eigen_spectrum.v2",
      }),
    );

    expect(model.droppedPointCount).toBe(0);
    expect(model.points).toEqual([
      expect.objectContaining({
        frequencyHz: 1.481196536e9,
        modeFieldId: "analysis:eigen:sample-0000:mode-0000",
        modeFieldResourceKey: mode0ResourceKey,
        rawModeIndex: 0,
        residualNorm: 1e-10,
        sampleIndex: 0,
      }),
      expect.objectContaining({
        frequencyHz: 2.25e9,
        modeFieldId: "analysis:eigen:sample-0003:mode-0001",
        modeFieldResourceKey: mode1ResourceKey,
        rawModeIndex: 1,
        sampleIndex: 3,
      }),
    ]);
    expect(model.series[0]?.points).toEqual([
      { rowIndex: 0, x: 0, y: 1.481196536 },
      { rowIndex: 1, x: 1, y: 2.25 },
    ]);
  });

  it("uses stable mode-id rank instead of a raw solver index on the public axis", () => {
    const model = buildEigenSpectrumChartModel(
      jsonResource({
        modes: [
          { frequency_hz: 3e9, mode_id: "mode-alpha", raw_mode_index: 17 },
          { frequency_hz: 4e9, mode_id: "mode-beta", raw_mode_index: 99 },
        ],
      }),
    );

    expect(
      model.points.map((point) => ({
        displayModeIndex: point.displayModeIndex,
        modeId: point.modeId,
        rawModeIndex: point.rawModeIndex,
      })),
    ).toEqual([
      { displayModeIndex: 0, modeId: "mode-alpha", rawModeIndex: 17 },
      { displayModeIndex: 1, modeId: "mode-beta", rawModeIndex: 99 },
    ]);
    expect(model.series[0]?.points).toEqual([
      { rowIndex: 0, x: 0, y: 3 },
      { rowIndex: 1, x: 1, y: 4 },
    ]);
  });

  it("narrows both a spectrum payload and an artifact-wrapped payload", () => {
    const payload = {
      modes: [
        {
          frequency_hz: 3e9,
          mode_id: "mode-alpha",
          raw_mode_index: 17,
          sample_index: 0,
        },
      ],
    };

    expect(readEigenSpectrumPayload(payload)?.modes[0]).toEqual(
      expect.objectContaining({
        displayModeIndex: 0,
        frequencyHz: 3e9,
        modeId: "mode-alpha",
        rawModeIndex: 17,
      }),
    );
    expect(
      readEigenSpectrumPayload({
        artifact_path: "eigen/spectrum.v2.json",
        payload,
      })?.modes[0],
    ).toEqual(expect.objectContaining({ rawModeIndex: 17 }));
  });

  it("accepts modal writer frequency_real_hz fields without inventing missing field resources", () => {
    const model = buildEigenSpectrumChartModel(
      jsonResource({
        samples: [
          {
            modes: [
              {
                frequency_imag_hz: -12.5e6,
                frequency_real_hz: 1.75e9,
                raw_mode_index: 2,
              },
            ],
            sample_index: 4,
          },
        ],
        schema_version: "frequency_domain_eigen_spectrum.v2",
      }),
    );

    expect(model.droppedPointCount).toBe(0);
    expect(model.points).toEqual([
      expect.objectContaining({
        frequencyHz: 1.75e9,
        imaginaryFrequencyHz: -12.5e6,
        modeFieldId: null,
        modeFieldResourceKey: null,
        rawModeIndex: 2,
        sampleIndex: 4,
      }),
    ]);
  });

  it("does not mark eigen modes as 3D-plot-ready when spectrum rows omit field ids", () => {
    const model = buildEigenSpectrumChartModel(
      jsonResource({
        modes: [
          {
            frequency_hz: 750e6,
            raw_mode_index: 7,
            sample_index: 3,
          },
        ],
      }),
    );

    expect(model.points[0]).toEqual(
      expect.objectContaining({
        modeFieldId: null,
        modeFieldResourceKey: null,
        rawModeIndex: 7,
        sampleIndex: 3,
      }),
    );
    expect(buildEigenModeSelectionRef(model.points[0]!)).not.toHaveProperty(
      "fieldId",
    );
    expect(buildEigenModeSelectionRef(model.points[0]!)).not.toHaveProperty(
      "resourceRef",
    );
  });

  it("builds canonical frequency-domain selection refs for eigen modes", () => {
    const model = buildEigenSpectrumChartModel(
      jsonResource({
        modes: [
          {
            branch_id: "b0",
            frequency_hz: 2.5e9,
            mode_id: "sample-0002/mode-0003",
            mode_field_id: "field-0",
            mode_field_resource_key: fieldVectorResourceKey("field-0"),
            raw_mode_index: 3,
            sample_id: "sample-0002",
            sample_index: 2,
          },
        ],
      }),
    );

    expect(buildEigenModeSelectionRef(model.points[0]!, {
      analysisRunId: "run-1",
      analysisStageId: "stage-1",
      artifactRevision: 17,
      artifactPath: "eigen/spectrum.v2.json",
      calculationMode: "fmr_modal",
      equilibriumId: "equilibrium-1",
      kContextKind: "gamma",
      representation: "complex-vector-xyz",
      studyProduct: "modal_eigen",
      wavevectorKf: [0, 0, 0],
    })).toEqual({
      analysisRunId: "run-1",
      analysisStageId: "stage-1",
      artifactRevision: "17",
      artifactPath: "eigen/spectrum.v2.json",
      branchId: "b0",
      calculationMode: "fmr_modal",
      equilibriumId: "equilibrium-1",
      fieldId: "field-0",
      frequencyHz: 2.5e9,
      kContextKind: "gamma",
      kind: "results.eigen.mode",
      modeId: "sample-0002/mode-0003",
      modeIndex: 3,
      nodeId: "results:eigen:sample:2:mode:3",
      representation: "complex-vector-xyz",
      resourceRef: fieldVectorResourceKey("field-0"),
      sampleId: "sample-0002",
      sampleIndex: 2,
      source: "eigen-mode",
      studyProduct: "modal_eigen",
      type: "frequency-domain",
      wavevectorKf: [0, 0, 0],
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

  it("keeps gaps between tracked k samples and does not connect unidentified raw modes", () => {
    const tracked = buildEigenDispersionChartModel(
      textResource([
        "sample_index,raw_mode_index,branch_id,path_s_rad_per_m,frequency_hz,analytic_frequency_hz",
        "0,1,acoustic,0,1e9,1.1e9",
        "2,1,acoustic,2e7,2e9,2.1e9",
      ].join("\n")),
    );
    const numerical = tracked.series.find((series) => series.quantity === "frequency");
    const analytic = tracked.series.find((series) => series.quantity === "analytic_frequency");
    expect(numerical?.points[1]?.breakBefore).toBe(true);
    expect(analytic?.points[1]?.breakBefore).toBe(true);

    const raw = buildEigenDispersionChartModel(
      textResource([
        "sample_index,raw_mode_index,path_s_rad_per_m,frequency_hz",
        "0,1,0,1e9",
        "1,1,1e7,2e9",
      ].join("\n")),
    );
    expect(raw.series[0]?.kind).toBe("scatter");
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

  it("reads modal tracking overlap scores from canonical dispersion CSV rows", () => {
    const model = buildEigenDispersionChartModel(
      textResource(
        [
          "sample_index,raw_mode_index,branch_id,path_s_rad_per_m,frequency_hz,overlap_score",
          "1,0,acoustic,25000000,1.4e9,0.7510407640085653",
        ].join("\n"),
      ),
    );

    expect(model.points[0]).toEqual(
      expect.objectContaining({
        overlap: 0.7510407640085653,
      }),
    );
  });

  it("reads modal linewidth from canonical dispersion CSV rows", () => {
    const model = buildEigenDispersionChartModel(
      textResource(
        [
          "sample_index,raw_mode_index,branch_id,path_s_rad_per_m,frequency_hz,line_width_hz",
          "1,0,acoustic,25000000,1.4e9,2800000",
        ].join("\n"),
      ),
    );

    expect(model.points[0]).toEqual(
      expect.objectContaining({
        linewidthHz: 2800000,
      }),
    );
    expect(model.series[0]?.points[0]).toEqual(
      expect.objectContaining({
        linewidthHz: 2800000,
      }),
    );
  });

  it("reads analytic DE/BV reference columns from canonical dispersion CSV rows", () => {
    const model = buildEigenDispersionChartModel(
      textResource(
        [
          "sample_index,raw_mode_index,branch_id,path_s_rad_per_m,frequency_hz,analytic_frequency_hz,relative_error,validation_geometry",
          "1,0,acoustic,25000000,1.39e9,1.4e9,0.007142857142857143,backward_volume",
        ].join("\n"),
      ),
    );

    expect(model.points[0]).toEqual(
      expect.objectContaining({
        analyticFrequencyHz: 1.4e9,
        relativeError: 0.007142857142857143,
        validationGeometry: "backward_volume",
      }),
    );
    expect(model.series.map((series) => series.id)).toEqual([
      "analysis.frequency-domain:eigen:dispersion:acoustic",
      "analysis.frequency-domain:eigen:dispersion:acoustic:analytic",
    ]);
    expect(model.series[1]?.points).toEqual([
      { rowIndex: 0, x: 25000000, y: 1.4 },
    ]);
  });

  it("preserves dispersion sample labels for high-symmetry k-path points", () => {
    const model = buildEigenDispersionChartModel(
      textResource(
        [
          "sample_index,raw_mode_index,branch_id,path_s_rad_per_m,label,frequency_hz",
          "0,1,acoustic,0,G,1.2e9",
          "1,1,acoustic,78539816.33974482,X,1.4e9",
        ].join("\n"),
      ),
    );

    expect(model.points.map((point) => point.sampleLabel)).toEqual(["G", "X"]);
    expect(model.series[0]?.points).toEqual([
      { label: "G", rowIndex: 0, x: 0, y: 1.2 },
      { label: "X", rowIndex: 1, x: 78539816.33974482, y: 1.4 },
    ]);
  });

  it("uses dispersion path metadata labels when the CSV row label is absent", () => {
    const model = buildEigenDispersionChartModel({
      path_metadata: {
        sampling: {
          closed: false,
          kind: "path",
          points: [
            { k_vector: [0, 0, 0], label: "G" },
            { k_vector: [78539816.33974482, 0, 0], label: "X" },
            { k_vector: [0, 0, 0], label: "G" },
          ],
          samples_per_segment: [1, 1],
        },
      },
      status: "ready",
      text: [
        "sample_index,raw_mode_index,branch_id,path_s_rad_per_m,frequency_hz",
        "0,1,acoustic,0,1.2e9",
        "1,1,acoustic,78539816.33974482,1.4e9",
        "2,1,acoustic,157079632.67948964,1.2e9",
      ].join("\n"),
    });

    expect(model.points.map((point) => point.sampleLabel)).toEqual([
      "G",
      "X",
      "G",
    ]);
    expect(model.series[0]?.points.map((point) => point.label)).toEqual([
      "G",
      "X",
      "G",
    ]);
  });

  it("attaches interpolated path wavevectors to dispersion and branch selections", () => {
    const pathResource: FrequencyDomainTextArtifactLike = {
      ...artifactOwnership,
      path_metadata: {
        sampling: {
          closed: false,
          kind: "path",
          points: [
            { k_vector: [0, 0, 0], label: "G" },
            { k_vector: [1e7, 2e7, -3e7], label: "X" },
          ],
          samples_per_segment: [2],
        },
      },
      status: "ready",
      text: [
        "sample_index,raw_mode_index,path_s_rad_per_m,frequency_hz",
        "0,2,0,1.2e9",
        "1,2,5,1.3e9",
        "2,2,10,1.4e9",
      ].join("\n"),
    };
    const dispersion = buildEigenDispersionChartModel(pathResource);

    expect(dispersion.points.map((point) => point.wavevectorKf)).toEqual([
      [0, 0, 0],
      [5e6, 1e7, -1.5e7],
      [1e7, 2e7, -3e7],
    ]);
    expect(
      buildEigenDispersionPointSelectionRef(dispersion.points[1]!),
    ).toMatchObject({
      kPathCoordinateRadPerM: 5,
      wavevectorKf: [5e6, 1e7, -1.5e7],
    });

    const branches = buildEigenBranchesModel(
      jsonResource({
        branches: [
          {
            branch_id: "acoustic",
            points: [
              {
                frequency_real_hz: 1.3e9,
                raw_mode_index: 2,
                sample_index: 1,
              },
            ],
          },
        ],
      }),
      pathResource,
    );
    const branchPoint = branches.branches[0]!.points[0]!;
    expect(branchPoint).toMatchObject({
      pathS: 5,
      wavevectorKf: [5e6, 1e7, -1.5e7],
    });
    expect(buildEigenBranchPointModeSelectionRef("acoustic", branchPoint)).toMatchObject({
      kPathCoordinateRadPerM: 5,
      wavevectorKf: [5e6, 1e7, -1.5e7],
    });
  });

  it("enriches branch handoff only from the same owned artifact set", () => {
    const branches = jsonResource({ branches: [{ branch_id: "acoustic", points: [{
      frequency_real_hz: 1.3e9, raw_mode_index: 2, sample_index: 1,
    }] }] });
    const dispersion: FrequencyDomainTextArtifactLike = {
      ...textResource("sample_index,raw_mode_index,path_s_rad_per_m,frequency_hz\n1,2,10000000,1.3e9"),
      content_digest: "csv-digest",
      path_metadata: { sampling: { kind: "path", closed: false,
        points: [{ label: "G", k_vector: [0, 0, 0] }, { label: "X", k_vector: [1e7, 0, 0] }],
        samples_per_segment: [1],
      } },
    };
    const standalone = buildEigenBranchesModel(
      { ...branches, stage_id: undefined, mesh_generation_id: undefined },
      { ...dispersion, stage_id: undefined, mesh_generation_id: undefined },
    );
    expect(standalone.branches[0]!.points[0]!.wavevectorKf).toEqual([1e7, 0, 0]);
    expect(standalone.diagnostics).toEqual([]);

    const matched = buildEigenBranchesModel({ ...branches, content_digest: "json-digest" }, dispersion);
    const point = matched.branches[0]!.points[0]!;
    expect(point.pathS).toBe(1e7);
    expect(point.wavevectorKf).toEqual([1e7, 0, 0]);
    const selection = buildEigenBranchPointModeSelectionRef("acoustic", point);
    expect(selection.type).toBe("frequency-domain");
    if (selection.type !== "frequency-domain") {
      throw new Error("Eigen branch mode selection must have frequency-domain identity");
    }
    expect(selection.wavevectorKf).toEqual([1e7, 0, 0]);

    for (const key of ["session_id", "run_id", "stage_id", "artifact_set_id", "mesh_generation_id"] as const) {
      const mismatched = buildEigenBranchesModel(branches, { ...dispersion, [key]: "foreign" });
      expect(mismatched.branches[0]!.points[0]!.wavevectorKf).toBeUndefined();
      expect(mismatched.branches[0]!.points[0]!.pathS).toBeUndefined();
      expect(mismatched.diagnostics).toContain("dispersion enrichment omitted: artifact ownership is missing or mismatched");
    }
    const unowned = buildEigenBranchesModel(branches, { ...dispersion, artifact_set_id: undefined });
    expect(unowned.branches[0]!.points[0]!.wavevectorKf).toBeUndefined();

    const ownedPoint = jsonResource({ branches: [{ branch_id: "acoustic", points: [{
      frequency_real_hz: 1.3e9, raw_mode_index: 2, sample_index: 1,
      wavevector_kf: [-3e7, 0, 0], path_s_rad_per_m: 3e7,
    }] }] });
    const own = buildEigenBranchesModel(ownedPoint, { ...dispersion, run_id: "foreign-run" }).branches[0]!.points[0]!;
    expect(own.wavevectorKf).toEqual([-3e7, 0, 0]);
    expect(own.pathS).toBe(3e7);
  });

  it("does not label dispersion points with branches from another run", () => {
    const branches = buildEigenBranchesModel(jsonResource({ branches: [{ branch_id: "acoustic", points: [{
      frequency_real_hz: 1.3e9, raw_mode_index: 2, sample_index: 1,
    }] }] }));
    const dispersion = textResource("sample_index,raw_mode_index,path_s_rad_per_m,frequency_hz\n1,2,10000000,1.3e9");
    expect(buildEigenDispersionChartModel(dispersion, branches).points[0]!.branchId).toBe("acoustic");
    const mismatched = buildEigenDispersionChartModel({ ...dispersion, run_id: "foreign-run" }, branches);
    expect(mismatched.points[0]!.branchId).toBeNull();
    expect(mismatched.diagnostics).toContain("branch labels omitted: artifact ownership is missing or mismatched");
  });

  it("uses branches.v2 identity when dispersion CSV has no branch ids", () => {
    const branchesModel = buildEigenBranchesModel(
      jsonResource({
        branches: [
          {
            branch_id: "acoustic",
            points: [
              {
                frequency_real_hz: 1.2e9,
                raw_mode_index: 1,
                sample_index: 0,
              },
              {
                frequency_real_hz: 1.4e9,
                raw_mode_index: 2,
                sample_index: 1,
              },
            ],
          },
        ],
      }),
    );
    const model = buildEigenDispersionChartModel(
      textResource(
        [
          "sample_index,raw_mode_index,path_s_rad_per_m,frequency_hz",
          "0,1,0,1.2e9",
          "1,2,3.14e7,1.4e9",
        ].join("\n"),
      ),
      branchesModel,
    );

    expect(model.points.map((point) => point.branchId)).toEqual([
      "acoustic",
      "acoustic",
    ]);
    expect(model.series.map((series) => series.label)).toEqual([
      "Branch acoustic",
    ]);
    expect(model.series[0]?.points).toEqual([
      { rowIndex: 0, x: 0, y: 1.2 },
      { rowIndex: 1, x: 3.14e7, y: 1.4 },
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
      kPathCoordinateRadPerM: 2.5e7,
      modeIndex: 5,
      nodeId: "results:eigen:dispersion:sample:4:mode:5",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
      sampleIndex: 4,
      type: "frequency-domain",
    });
  });

  it("derives an encoded dispersion field route from durable ID without a CSV transport column", () => {
    const model = buildEigenDispersionChartModel(textResource([
      "sample_index,raw_mode_index,path_s_rad_per_m,frequency_hz,mode_field_id",
      "2,0,5.0e7,1.2e9,analysis:eigen:field/α",
    ].join("\n")));
    expect(model.points[0]?.modeFieldResourceKey).toBe(
      fieldVectorResourceKey("analysis:eigen:field/α"),
    );
    expect(model.points[0]?.modeFieldResourceKey).toContain("%2F%CE%B1");
    expect(buildEigenDispersionPointSelectionRef(model.points[0]!).kind).toBe("results.eigen.mode");
  });

  it("selects a dispersion point with mode field metadata as a 3D mode handoff", () => {
    const model = buildEigenDispersionChartModel(
      textResource(
        [
          "sample_index,raw_mode_index,branch_id,path_s_rad_per_m,frequency_hz,mode_field_id,mode_field_resource_key",
          `2,0,acoustic,5.0e7,1.2e9,analysis:eigen:sample-0002:mode-0000,${fieldVectorResourceKey("analysis:eigen:sample-0002:mode-0000")}`,
        ].join("\n"),
      ),
    );

    expect(model.points[0]).toEqual(
      expect.objectContaining({
        modeFieldId: "analysis:eigen:sample-0002:mode-0000",
        modeFieldResourceKey: fieldVectorResourceKey(
          "analysis:eigen:sample-0002:mode-0000",
        ),
      }),
    );
    expect(buildEigenDispersionPointSelectionRef(model.points[0]!)).toEqual({
      branchId: "acoustic",
      calculationMode: "dispersion_modal",
      fieldId: "analysis:eigen:sample-0002:mode-0000",
      kind: "results.eigen.mode",
      kPathCoordinateRadPerM: 5.0e7,
      modeIndex: 0,
      nodeId: "results:eigen:dispersion:sample:2:mode:0",
      resourceRef: fieldVectorResourceKey("analysis:eigen:sample-0002:mode-0000"),
      sampleIndex: 2,
      type: "frequency-domain",
    });
  });

  it("keeps a dispersion point selectable by stable identity without a field handoff", () => {
    const model = buildEigenDispersionChartModel(
      textResource(
        [
          "sample_index,sample_id,raw_mode_index,mode_id,branch_id,path_s_rad_per_m,frequency_hz,mode_field_available,mode_field_id,mode_field_resource_key",
          `2,k-path-sample-0002,0,sample-0002/mode-0000,acoustic,5.0e7,1.2e9,false,field-0,${fieldVectorResourceKey("field-0")}`,
        ].join("\n"),
      ),
    );

    const point = model.points[0]!;
    expect(point).toMatchObject({
      modeFieldAvailable: false,
      modeFieldId: "field-0",
      modeFieldResourceKey: null,
      modeId: "sample-0002/mode-0000",
      sampleId: "k-path-sample-0002",
    });
    const selection = buildEigenDispersionPointSelectionRef(point);
    expect(selection.kind).toBe("results.eigen.dispersion");
    expect(selection).not.toHaveProperty("fieldId");
    expect(selection).toMatchObject({
      modeId: "sample-0002/mode-0000",
      sampleId: "k-path-sample-0002",
    });
  });

  it("does not turn empty dispersion values into zero-valued physics or mode identities", () => {
    const model = buildEigenDispersionChartModel(textResource([
      "sample_index,raw_mode_index,path_s_rad_per_m,frequency_hz,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,residual_norm,line_width_hz",
      "0,1,0,1e9,,,,,",
      "1,,1,1e9,0,0,0,0,0",
      "2,1.5,2,1e9,0,0,0,0,0",
      "3,1,3,,0,0,0,0,0",
    ].join("\n")));
    expect(model.points).toHaveLength(1);
    expect(model.droppedPointCount).toBe(3);
    expect(model.points[0]).toMatchObject({ residualNorm: null, linewidthHz: null });
    expect(model.points[0]?.wavevectorKf).toBeUndefined();
  });

  it.each([false, true])("preserves dispersion identity, revision and clicked k (field=%s)", (withField) => {
    const model = buildEigenDispersionChartModel(textResource([
      "sample_index,raw_mode_index,sample_id,mode_id,path_s_rad_per_m,frequency_hz,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,mode_field_id,mode_field_resource_key",
      `4,7,k-path-sample-0004,sample-0004-mode-0007,2.5e7,1.2e9,-2e7,1e7,0,${withField ? "field-7" : ""},${withField ? fieldVectorResourceKey("field-7") : ""}`,
    ].join("\n")));
    const selection = buildEigenDispersionPointSelectionRef(model.points[0]!, {
      analysisRunId: "run-current",
      artifactRevision: 0,
      equilibriumId: "equilibrium-current",
      representation: "complex-vector-xyz",
      kContextKind: "k_path",
      // A previous selection's vector must not replace the clicked sample.
      wavevectorKf: [9, 9, 9],
    });
    expect(selection).toMatchObject({
      kind: withField ? "results.eigen.mode" : "results.eigen.dispersion",
      sampleId: "k-path-sample-0004",
      modeId: "sample-0004-mode-0007",
      sampleIndex: 4,
      modeIndex: 7,
      analysisRunId: "run-current",
      artifactRevision: "0",
      equilibriumId: "equilibrium-current",
      representation: "complex-vector-xyz",
      kContextKind: "k_path",
      wavevectorKf: [-2e7, 1e7, 0],
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
                mode_field_id: "analysis:eigen:sample-0000:mode-0003",
                mode_id: "sample-0000/mode-0003",
                overlap_prev: null,
                raw_mode_index: 3,
                residual_norm: 1e-7,
                sample_id: "k-path-sample-0000",
                sample_index: 0,
                tracking_confidence: 1,
              },
              {
                frequency_imag_hz: -1.5e6,
                frequency_real_hz: 1.5e9,
                mode_field_id: "analysis:eigen:sample-0001:mode-0002",
                mode_field_resource_key: fieldVectorResourceKey(
                  "analysis:eigen:sample-0001:mode-0002",
                  "component=full&scope_kind=full",
                ),
                mode_id: "sample-0001/mode-0002",
                overlap_prev: 0.93,
                raw_mode_index: 2,
                residual_norm: 2e-7,
                sample_id: "k-path-sample-0001",
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
        points: [
          expect.objectContaining({
            frequencyImagHz: -1e6,
            frequencyRealHz: 1.2e9,
            modeFieldAvailable: true,
            modeFieldId: "analysis:eigen:sample-0000:mode-0003",
            modeFieldResourceKey: fieldVectorResourceKey("analysis:eigen:sample-0000:mode-0003"),
            modeId: "sample-0000/mode-0003",
            overlapPrev: null,
            rawModeIndex: 3,
            residualNorm: 1e-7,
            sampleId: "k-path-sample-0000",
            sampleIndex: 0,
            trackingConfidence: 1,
          }),
          expect.objectContaining({
            frequencyImagHz: -1.5e6,
            frequencyRealHz: 1.5e9,
            modeFieldAvailable: true,
            modeFieldId: "analysis:eigen:sample-0001:mode-0002",
            modeFieldResourceKey: fieldVectorResourceKey(
              "analysis:eigen:sample-0001:mode-0002",
              "component=full&scope_kind=full",
            ),
            modeId: "sample-0001/mode-0002",
            overlapPrev: 0.93,
            rawModeIndex: 2,
            residualNorm: 2e-7,
            sampleId: "k-path-sample-0001",
            sampleIndex: 1,
            trackingConfidence: 0.95,
          }),
        ],
        overlapPrevMean: 0.93,
        overlapPrevMin: 0.93,
        sampleGapCount: 0,
        sampleGapMax: null,
        sampleMax: 1,
        sampleMin: 0,
        trackingConfidenceMin: 0.95,
        warnings: [],
      }),
    ]);
  });

  it("does not create a branch mode field handoff from a key-only artifact", () => {
    const model = buildEigenBranchesModel(
      jsonResource({
        branches: [
          {
            branch_id: "acoustic",
            points: [
              {
                frequency_real_hz: 1.2e9,
                mode_field_resource_key: fieldVectorResourceKey(
                  "analysis:eigen:sample-0000:mode-0002",
                ),
                mode_id: "sample-0000/mode-0002",
                overlap_prev: null,
                raw_mode_index: 2,
                residual_norm: 1.2e-7,
                sample_id: "k-path-sample-0000",
                sample_index: 0,
                tracking_confidence: 1,
              },
            ],
          },
        ],
      }),
    );
    const point = model.branches[0]!.points[0]!;

    expect(point).toMatchObject({
      frequencyRealHz: 1.2e9,
      modeFieldAvailable: false,
      modeFieldId: null,
      modeFieldResourceKey: null,
      modeId: "sample-0000/mode-0002",
      overlapPrev: null,
      rawModeIndex: 2,
      residualNorm: 1.2e-7,
      sampleId: "k-path-sample-0000",
      sampleIndex: 0,
      trackingConfidence: 1,
    });
    const selection = buildEigenBranchPointModeSelectionRef("acoustic", point);
    expect(selection).not.toHaveProperty("fieldId");
    expect(selection).not.toHaveProperty("resourceRef");
    expect(selection).toMatchObject({
      branchId: "acoustic",
      kind: "results.eigen.mode",
      modeId: "sample-0000/mode-0002",
      modeIndex: 2,
      nodeId: "results:eigen:sample:0:mode:2",
      sampleId: "k-path-sample-0000",
      sampleIndex: 0,
    });
  });

  it("builds canonical frequency-domain selection refs for eigen branches", () => {
    expect(
      buildEigenBranchSelectionRef(
        {
          branchId: "acoustic",
          frequencyMaxHz: 2e9,
          frequencyMinHz: 1e9,
          label: "Acoustic",
          overlapPrevMin: 0.91,
          points: [],
          sampleMax: 4,
          sampleMin: 0,
          trackingConfidenceMin: 0.97,
        },
        { analysisStageId: "stage-branches" },
      ),
    ).toEqual({
      analysisStageId: "stage-branches",
      branchId: "acoustic",
      calculationMode: "dispersion_modal",
      kind: "results.eigen.branch",
      nodeId: "results:eigen:branches:branch:acoustic",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
      type: "frequency-domain",
    });
  });

  it("computes branch overlap means, sample gaps, and warnings", () => {
    const model = buildEigenBranchesModel(
      jsonResource({
        branches: [
          {
            branch_id: "gapped",
            points: [
              {
                frequency_real_hz: 1e9,
                overlap_prev: null,
                raw_mode_index: 1,
                sample_index: 0,
                tracking_confidence: 1,
              },
              {
                frequency_real_hz: 1.5e9,
                overlap_prev: 0.8,
                raw_mode_index: 2,
                sample_index: 1,
                tracking_confidence: 0.9,
              },
              {
                frequency_real_hz: 2e9,
                overlap_prev: 0.6,
                raw_mode_index: 3,
                sample_index: 4,
                tracking_confidence: 0.7,
              },
            ],
          },
        ],
      }),
    );

    expect(model.branches[0]).toEqual(
      expect.objectContaining({
        overlapPrevMean: 0.7,
        sampleGapCount: 1,
        sampleGapMax: 2,
        warnings: ["sample gap 2 between 1 and 4"],
      }),
    );
  });

  it("builds canonical mode selection refs from eigen branch samples", () => {
    expect(
      buildEigenBranchPointModeSelectionRef(
        "acoustic",
        {
          frequencyImagHz: -1.2e7,
          frequencyRealHz: 12.5e9,
          modeFieldAvailable: true,
          modeFieldId: "analysis:eigen:sample-0000:mode-0002",
          modeFieldResourceKey: fieldVectorResourceKey(
            "analysis:eigen:sample-0000:mode-0002",
          ),
          modeId: "sample-0000/mode-0002",
          overlapPrev: null,
          rawModeIndex: 2,
          residualNorm: 1.2e-7,
          sampleId: "k-path-sample-0000",
          sampleIndex: 0,
          trackingConfidence: 1,
        },
        { analysisStageId: "stage-branch-point" },
      ),
    ).toEqual({
      analysisStageId: "stage-branch-point",
      branchId: "acoustic",
      calculationMode: "dispersion_modal",
      fieldId: "analysis:eigen:sample-0000:mode-0002",
      frequencyHz: 12.5e9,
      kind: "results.eigen.mode",
      modeId: "sample-0000/mode-0002",
      modeIndex: 2,
      nodeId: "results:eigen:sample:0:mode:2",
      resourceRef: fieldVectorResourceKey(
        "analysis:eigen:sample-0000:mode-0002",
      ),
      sampleId: "k-path-sample-0000",
      sampleIndex: 0,
      source: "eigen-mode",
      type: "frequency-domain",
    });
  });

  it("suppresses branch field handoff when availability is explicitly false", () => {
    const selection = buildEigenBranchPointModeSelectionRef(
      "acoustic",
      {
        frequencyImagHz: -1.2e7,
        frequencyRealHz: 12.5e9,
        modeFieldAvailable: false,
        modeFieldId: "analysis:eigen:sample-0000:mode-0002",
        modeFieldResourceKey: fieldVectorResourceKey(
          "analysis:eigen:sample-0000:mode-0002",
        ),
        modeId: "sample-0000/mode-0002",
        overlapPrev: null,
        rawModeIndex: 2,
        residualNorm: 1.2e-7,
        sampleId: "k-path-sample-0000",
        sampleIndex: 0,
        trackingConfidence: 1,
      },
    );

    expect(selection.kind).toBe("results.eigen.mode");
    expect(selection).not.toHaveProperty("fieldId");
    expect(selection).not.toHaveProperty("resourceRef");
    expect(selection).toMatchObject({
      modeId: "sample-0000/mode-0002",
      sampleId: "k-path-sample-0000",
    });
  });

  it("builds branch detail chart series for frequency and overlap continuity", () => {
    const model = buildEigenBranchDetailChartModel({
      branchId: "acoustic",
      frequencyMaxHz: 13.1e9,
      frequencyMinHz: 12.5e9,
      label: "acoustic",
      overlapPrevMin: 0.97,
      points: [
        {
          frequencyImagHz: -1.2e7,
          frequencyRealHz: 12.5e9,
          modeFieldId: "analysis:eigen:sample-0000:mode-0002",
          modeFieldResourceKey: null,
          overlapPrev: null,
          rawModeIndex: 2,
          residualNorm: 1.2e-7,
          sampleIndex: 0,
          trackingConfidence: 1,
        },
        {
          frequencyImagHz: -1.4e7,
          frequencyRealHz: 13.1e9,
          modeFieldId: null,
          modeFieldResourceKey: null,
          overlapPrev: 0.97,
          rawModeIndex: 1,
          residualNorm: 2.4e-7,
          sampleIndex: 1,
          trackingConfidence: 0.98,
        },
      ],
      sampleMax: 1,
      sampleMin: 0,
      trackingConfidenceMin: 0.98,
    });

    expect(model.frequencySeries).toEqual([
      { label: "sample 0 mode 2", sampleIndex: 0, valueHz: 12.5e9 },
      { label: "sample 1 mode 1", sampleIndex: 1, valueHz: 13.1e9 },
    ]);
    expect(model.overlapSeries).toEqual([
      { label: "sample 1 mode 1", sampleIndex: 1, value: 0.97 },
    ]);
    expect(model.frequencyRangeHz).toEqual({ max: 13.1e9, min: 12.5e9 });
    expect(model.sampleRange).toEqual({ max: 1, min: 0 });
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
        residualNorm: 1e-5,
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

  it("parses published response absolute and relative L2 as separate values", () => {
    const model = buildFrequencyResponseChartModel(jsonResource({
      points: [
        {
          frequency_hz: 9.5e9,
          relative_residual_l2_norm: 2e-9,
          residual_l2_norm: 6e-5,
          residual_norm: 4e-7,
        },
        {
          frequency_hz: 9.6e9,
          relative_residual_l2_norm: -1,
          residual_l2_norm: Number.NaN,
        },
        { frequency_hz: 9.7e9 },
      ],
      schema_version: "magnetic_response_sweep.v2",
    }));

    expect(model.points[0]).toMatchObject({
      residualAbsoluteL2: 6e-5,
      residualNorm: 4e-7,
      residualRelativeL2: 2e-9,
    });
    expect(model.points[1]).not.toHaveProperty("residualAbsoluteL2");
    expect(model.points[1]).not.toHaveProperty("residualRelativeL2");
    expect(model.points[2]).not.toHaveProperty("residualAbsoluteL2");
    expect(model.points[2]).not.toHaveProperty("residualRelativeL2");
  });

  it("uses typed observable units and fails closed when a response unit is not published", () => {
    const resource = jsonResource({
      points: [
        {
          absorbed_power_density: 4.5,
          amplitude: 2.0,
          frequency_hz: 9.5e9,
          observable_id: "mx",
          phase_rad: 1.25,
          susceptibility_tensor: [[1, 2], [3, 4]],
        },
      ],
      schema_version: "magnetic_response_sweep.v1",
    });

    const typed = buildFrequencyResponseChartModel(resource, {
      observables: [
        { identity: "mx", kind: "drive_projected_response", unit: "A/m" },
        { identity: "absorbed-power", kind: "absorbed_power", unit: "W/m^3" },
        { identity: "chi-xx", kind: "susceptibility", unit: "m/A" },
      ],
    });

    expect(typed.series.find((series) => series.quantity === "amplitude")?.unit).toBe("A/m");
    expect(typed.series.find((series) => series.quantity === "absorbed-power-density")?.unit).toBe("W/m^3");
    expect(typed.series.find((series) => series.quantity === "susceptibility-max-abs")?.unit).toBe("m/A");
    expect(typed.series.find((series) => series.quantity === "phase")?.unit).toBe("rad");

    const missing = buildFrequencyResponseChartModel(resource, { observables: [] });
    expect(missing.series.find((series) => series.quantity === "amplitude")?.unit).toBe("not published");
    expect(missing.series.find((series) => series.quantity === "absorbed-power-density")?.unit).toBe("not published");
    expect(missing.series.find((series) => series.quantity === "susceptibility-max-abs")?.unit).toBe("not published");
    expect(missing.diagnostics).toEqual(expect.arrayContaining([
      "amplitude unit is not published in the result manifest",
      "absorbed power density unit is not published in the result manifest",
      "susceptibility unit is not published in the result manifest",
    ]));
    expect(frequencyResponseSeriesUnit(typed, "amplitude")).toBe("A/m");
    expect(frequencyResponseSeriesUnit(missing, "amplitude")).toBe("not published");
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
      calculationMode: "frequency_response",
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
        fieldId: null,
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
        fieldId: null,
        frequencyIndex: 1,
      }),
    );
    expect(buildFrequencyResponsePointSelectionRef(model.points[1]!)).toEqual(
      expect.not.objectContaining({
        fieldId: expect.any(String),
      }),
    );
    expect(buildFrequencyResponsePointSelectionRef(model.points[1]!)).toEqual(
      expect.objectContaining({
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
            mode_field_resource_key: fieldVectorResourceKey(
              "analysis:eigen:sample-0000:mode-0002",
            ),
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
        amplitudeUnit: "not published",
        absorbedPowerDensityUnit: "not published",
        frequencyHz: 10.5e9,
        frequencyPointIndex: 1,
        phaseRad: 0.25,
        source: "driven_response",
      }),
    ]);
  });

  it("does not expose unavailable modal fields through FMR peak rows", () => {
    const model = buildFmrPeakTableModel({
      spectrum: jsonResource({
        modes: [
          {
            frequency_hz: 8.0e9,
            mode_field_available: false,
            mode_field_id: "analysis:eigen:sample-0000:mode-0002",
            mode_field_resource_key: fieldVectorResourceKey(
              "analysis:eigen:sample-0000:mode-0002",
            ),
            raw_mode_index: 2,
            sample_index: 0,
          },
        ],
      }),
    });

    expect(model.peaks).toContainEqual(
      expect.objectContaining({
        fieldId: null,
        fieldResourceKey: null,
        source: "modal",
      }),
    );
  });

  it("links driven FMR peaks to manifest response field resources", () => {
    const model = buildFmrPeakTableModel({
      manifestPayload: {
        resources: {
          response_field_resources: [
            {
              field_resource_id: "analysis:frequency-response:frequency-0001",
              frequency_index: 1,
              payload_path:
                "response/field_payloads/frequency_0001/vector_xyz.bin",
            },
          ],
        },
        schema_version: "frequency_domain_manifest.v1",
      },
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
    });

    expect(model.peaks).toContainEqual(
      expect.objectContaining({
        fieldId: "analysis:frequency-response:frequency-0001",
        fieldResourceKey: fieldVectorResourceKey(
          "analysis:frequency-response:frequency-0001",
        ),
        frequencyPointIndex: 1,
        source: "driven_response",
      }),
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

  it("accepts only the compatible modal-spectrum calculation mode family", () => {
    const freeModesManifest = {
      artifacts: { spectrum_v2_path: "eigen/spectrum.v2.json" },
      requested_execution: { calculation_mode: "free_modes" },
      stage_kind: "eigenmodes",
    };

    expect(
      frequencyDomainManifestSupportsChartRoute(freeModesManifest, {
        mode: "free_modes",
        primaryChart: "modal-spectrum",
      }),
    ).toBe(true);
    expect(
      frequencyDomainManifestSupportsChartRoute(freeModesManifest, {
        mode: "fmr_modal",
        primaryChart: "modal-spectrum",
      }),
    ).toBe(true);
    expect(routeFrequencyDomainCalculationMode(freeModesManifest).mode).toBe("free_modes");

    const fmrModalManifest = {
      ...freeModesManifest,
      requested_execution: { calculation_mode: "fmr_modal" },
    };
    expect(
      frequencyDomainManifestSupportsChartRoute(fmrModalManifest, {
        mode: "free_modes",
        primaryChart: "modal-spectrum",
      }),
    ).toBe(true);
    expect(routeFrequencyDomainCalculationMode(fmrModalManifest).mode).toBe("fmr_modal");
    expect(
      frequencyDomainManifestSupportsChartRoute(freeModesManifest, {
        mode: "fmr_response",
        primaryChart: "modal-spectrum",
      }),
    ).toBe(false);
  });

  it("accepts only the compatible response-sweep calculation mode family", () => {
    const responseManifest = {
      artifacts: { response_sweep_v2_path: "response/sweep.v2.json" },
      requested_execution: { calculation_mode: "frequency_response" },
      stage_kind: "frequency_response",
    };

    expect(
      frequencyDomainManifestSupportsChartRoute(responseManifest, {
        mode: "frequency_response",
        primaryChart: "response-sweep",
      }),
    ).toBe(true);
    expect(
      frequencyDomainManifestSupportsChartRoute(responseManifest, {
        mode: "fmr_response",
        primaryChart: "response-sweep",
      }),
    ).toBe(true);
    expect(routeFrequencyDomainCalculationMode(responseManifest).mode).toBe("frequency_response");

    const fmrResponseManifest = {
      ...responseManifest,
      requested_execution: { calculation_mode: "fmr_response" },
    };
    expect(
      frequencyDomainManifestSupportsChartRoute(fmrResponseManifest, {
        mode: "frequency_response",
        primaryChart: "response-sweep",
      }),
    ).toBe(true);
    expect(routeFrequencyDomainCalculationMode(fmrResponseManifest).mode).toBe("fmr_response");
    expect(
      frequencyDomainManifestSupportsChartRoute(responseManifest, {
        mode: "fmr_modal",
        primaryChart: "response-sweep",
      }),
    ).toBe(false);
  });

  it("does not infer modal-driven comparison from unrelated artifacts", () => {
    const freeModesManifest = {
      artifacts: {
        response_sweep_v2_path: "response/sweep.v2.json",
        spectrum_v2_path: "eigen/spectrum.v2.json",
      },
      equilibrium_identity: "eq-1",
      geometry_identity: "geometry-1",
      mesh_identity: "mesh-1",
      requested_execution: {
        boundary_context: "finite_open",
        calculation_mode: "free_modes",
      },
      run_id: "run-1",
      stage_id: "stage-1",
      study_product: "modal_eigen",
    };

    expect(
      frequencyDomainManifestSupportsChartRoute(freeModesManifest, {
        mode: "fmr_modal_driven",
        primaryChart: "comparison",
      }),
    ).toBe(false);
  });

  it("classifies driven response only from typed physical evidence", () => {
    const neutral = frequencyDomainResultContextFromManifest({
      equilibrium_identity: "eq-1",
      geometry_identity: "geometry-1",
      mesh_identity: "mesh-1",
      run_id: "run-1",
      stage_id: "response-1",
      study_product: "driven_response",
      requested_execution: { boundary_context: "finite_open" },
      drive: { identity: "rf-1", kind: "magnetic_rf" },
      observables: [{ identity: "amplitude", kind: "response_amplitude", unit: "1" }],
    });
    expect(neutral.contractGaps).toEqual([]);
    expect(neutral.classification).toMatchObject({
      fmrQualified: false,
      resultLabel: "Harmonic Response Spectrum",
    });

    const qualified = frequencyDomainResultContextFromManifest({
      equilibrium_identity: "eq-1",
      run_id: "run-1",
      stage_id: "response-1",
      study_product: "driven_response",
      physics: { normalization: "unit_l2" },
      requested_execution: { boundary_context: "finite_open" },
      drive: { identity: "rf-1", kind: "magnetic_rf" },
      observables: [{ identity: "chi-xx", kind: "susceptibility", unit: "1" }],
    });
    expect(qualified.normalization).toBe("unit_l2");
    expect(qualified.evidence?.normalization).toBe("unit_l2");
    expect(qualified.classification).toMatchObject({
      fmrQualified: true,
      resultLabel: "FMR Response Spectrum",
    });
  });

  it("fails physical classification closed without owner and boundary evidence", () => {
    const context = frequencyDomainResultContextFromManifest({
      requested_execution: { calculation_mode: "fmr_response" },
      stage_kind: "frequency_response",
    });
    expect(context.classification).toBeNull();
    expect(context.contractGaps).toEqual([
      "run identity unavailable",
      "stage identity unavailable",
      "equilibrium identity unavailable",
      "study product unavailable",
      "boundary context unavailable",
      "geometry identity unavailable",
      "mesh identity unavailable",
    ]);
  });

  it("maps physics-first analysis subviews to their canonical chart routes", () => {
    expect(frequencyDomainChartRouteOverrideFromSubview("resonance.eigenmodes")).toEqual({
      mode: "fmr_modal",
      primaryChart: "modal-spectrum",
    });
    expect(frequencyDomainChartRouteOverrideFromSubview("resonance.frequency-response")).toEqual({
      mode: "fmr_response",
      primaryChart: "response-sweep",
    });
    expect(frequencyDomainChartRouteOverrideFromSubview("resonance.modal-driven")).toEqual({
      mode: "fmr_modal_driven",
      primaryChart: "comparison",
    });
    expect(frequencyDomainChartRouteOverrideFromSubview("dispersion.modal")).toEqual({
      mode: "dispersion_modal",
      primaryChart: "dispersion",
    });
    expect(frequencyDomainChartRouteOverrideFromSubview("dispersion.branches")).toEqual({
      mode: "dispersion_modal",
      primaryChart: "dispersion",
    });
    expect(frequencyDomainChartRouteOverrideFromSubview("dispersion.driven-map")).toEqual({
      mode: "response_map",
      primaryChart: "response-map",
    });
  });

  it("routes selections from typed calculation mode, never kind, label, or path prefixes", () => {
    expect(frequencyDomainChartRouteOverrideFromSelection({
      kind: "results.frequency_response.sweep",
      ref: { kind: "results.frequency_response.sweep", type: "frequency-domain" },
    })).toBeNull();
    const selection = {
      kind: "anything",
      ref: {
        calculationMode: "frequency_response",
        kind: "anything",
        type: "frequency-domain",
      },
    } as never;
    const route = frequencyDomainChartRouteOverrideFromSelection(selection);
    expect(route).toEqual({ mode: "frequency_response", primaryChart: "response-sweep" });
    expect(frequencyDomainChartRouteOverrideFromSelection(selection)).toBe(route);
  });

  it("uses authoritative artifact owner metadata without rewriting manifest payloads", () => {
    const context = frequencyDomainResultContextFromManifest({
      boundary_context: "floquet_periodic",
      equilibrium_artifact_sha256: "sha256:equilibrium-1",
      k_sampling: { kind: "single", vector_rad_per_m: [0, 0, 0] },
      study_product: "modal_eigen",
    }, {
      meshGenerationId: "mesh-generation-1",
      runId: "run-1",
      stageId: "stage-1",
    });

    expect(context).toMatchObject({
      equilibriumId: "sha256:equilibrium-1",
      meshId: "mesh-generation-1",
      runId: "run-1",
      stageId: "stage-1",
    });
    expect(context.classification?.kContext.kind).toBe("gamma");
  });

  it("keeps a claimed response map unavailable without a typed map resource adapter", () => {
    const route = routeFrequencyDomainCalculationMode({
      artifacts: { response_map_v2_path: "response/map.v2.bin" },
      requested_execution: { calculation_mode: "response_map" },
      resources: { response_map_resource_key: "analysis.response-map:run-1:stage-1@revision-1" },
    });
    expect(route).toMatchObject({
      mode: "response_map",
      primaryChart: "response-map",
      status: "unavailable",
      unavailableReason: "Typed response-map resource is not available in the current Analysis contract.",
    });
  });

  it("does not treat response sweep artifacts as computed response maps", () => {
    const route = routeFrequencyDomainCalculationMode({
      artifacts: {
        response_sweep_v2_path: "response/magnetic_response_sweep.v2.json",
      },
      requested_execution: { calculation_mode: "response_map" },
      stage_kind: "frequency_response",
    });

    expect(route).toEqual(
      expect.objectContaining({
        mode: "response_map",
        primaryChart: "response-map",
        status: "unavailable",
        unavailableReason: "Typed response-map resource is not available in the current Analysis contract.",
      }),
    );
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
