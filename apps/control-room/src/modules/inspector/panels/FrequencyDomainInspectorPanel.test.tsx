import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
  MESHING_PERIODIC_PAIRS_PATH,
} from "@/kernel/api/apiPaths";
import type { Selection } from "@/kernel/selection/selectionTypes";

import { FREQUENCY_DOMAIN_INSPECTOR_SELECTION_KINDS } from "../inspectorRegistry";
import { FrequencyDomainInspectorPanel } from "./FrequencyDomainInspectorPanel";

const emptyResource = {
  data: null,
  error: null,
  refetch: () => undefined,
  revision: null,
  status: "idle",
} as const;

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    commands: {
      execute: vi.fn(async () => ({ message: "ok", status: "completed" })),
    },
  }),
}));

vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useFrequencyDomainEigenBranchesResource: () => ({
    ...emptyResource,
    data: {
      artifact_path: "eigen/branches.v2.json",
      missing_reason: null,
      payload: {
        branches: [
          {
            branch_id: "branch-0",
            label: "acoustic",
            points: [
              {
                frequency_imag_hz: -1.2e7,
                frequency_real_hz: 12.5e9,
                overlap_prev: null,
                raw_mode_index: 2,
                sample_index: 0,
                tracking_confidence: 1,
              },
              {
                frequency_imag_hz: -1.4e7,
                frequency_real_hz: 13.1e9,
                overlap_prev: 0.97,
                raw_mode_index: 1,
                sample_index: 1,
                tracking_confidence: 0.98,
              },
            ],
          },
        ],
        schema_version: "eigen_branches.v2",
        solver_model: "linearized_llg_reference",
      },
      resource_key: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
      schema_version: "frequency_domain_eigen_branches.v2",
      status: "ready",
    },
    revision: "branches:1",
    status: "ready",
  }),
  useFrequencyDomainEigenDispersionResource: () => ({
    ...emptyResource,
    data: {
      status: "ready",
      text: [
        "sample_index,raw_mode_index,branch_id,path_s_rad_per_m,frequency_hz,endpoint_label",
        "0,1,acoustic,0,9.5e9,Gamma",
        "1,1,acoustic,78539816.33974482,12.0e9,X",
      ].join("\n"),
    },
    revision: "dispersion:1",
    status: "ready",
  }),
  useFrequencyDomainEigenModeFieldMetaResource: () => emptyResource,
  useFrequencyDomainEigenModeResource: () => ({
    ...emptyResource,
    data: {
      angular_frequency_rad_per_s: 75398223686.155,
      component_summary: {
        component_count: 3,
        imag_sample_count: 3,
        real_sample_count: 3,
      },
      dominant_polarization: "counter_clockwise",
      frequency_imag_hz: -12000000,
      frequency_real_hz: 12000000000,
      mode_field_resource_key:
        "/v2/sessions/current/data/fields/analysis:eigen:sample-0000:mode-0002/samples/vector?view=phase_rotated_real&phase_rad=0",
      mode_field_sample_count: 3,
      raw_mode_index: 2,
      residual_norm: 1e-8,
      sample_index: 0,
      schema_version: "2",
      tangent_leakage_max_abs: 1e-10,
    },
    revision: "mode:0:2",
    status: "ready",
  }),
  useFrequencyDomainEigenSpectrumResource: () => ({
    ...emptyResource,
    data: {
      artifact_path: "eigen/spectrum.v2.json",
      missing_reason: null,
      payload: {
        modes: [
          {
            frequency_hz: 9.5e9,
            mode_field_id: "analysis:eigen:sample-0000:mode-0001",
            raw_mode_index: 1,
            sample_index: 0,
          },
          {
            frequency_hz: 12.0e9,
            mode_field_id: "analysis:eigen:sample-0000:mode-0002",
            raw_mode_index: 2,
            sample_index: 0,
          },
        ],
        schema_version: "eigen_spectrum.v2",
      },
      resource_key: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
      schema_version: "frequency_domain_eigen_spectrum.v2",
      status: "ready",
    },
    revision: "spectrum:1",
    status: "ready",
  }),
  useFrequencyDomainManifestResource: () => ({
    ...emptyResource,
    data: {
      capabilities: {
        boundary: {
          floquet_modal: { reason: "Bloch phase supported", status: "ready" },
          floquet_response: {
            reason: "Driven Floquet response deferred",
            status: "unsupported",
          },
          periodic_pair_diagnostics: {
            reason: "Pair diagnostics available",
            status: "ready",
          },
          static_periodic: { reason: "Static PBC available", status: "ready" },
        },
        demag: {
          floquet_dynamic_k: {
            reason: "dynamic demag-k is blocked for nonzero-k Floquet",
            status: "unsupported",
          },
          static_periodic_pbc: {
            reason: "Static PBC demag available",
            status: "ready",
          },
        },
        dispersion: {
          branch_tracking: { reason: "Reference tracking", status: "ready" },
          k_path: { reason: "Reference k-path", status: "ready" },
        },
        modal: {
          absorption_from_modes: { reason: "deferred", status: "unsupported" },
          k_path: { reason: "Reference k-path", status: "ready" },
          linewidths: { reason: "Reference linewidths", status: "ready" },
          mode_field_payload: {
            reason: "Mode field payloads available",
            status: "ready",
          },
          mode_tracking: { reason: "deferred", status: "unsupported" },
          production_cpu: { reason: "deferred", status: "unsupported" },
          production_gpu: { reason: "deferred", status: "unsupported" },
          reference_cpu: { reason: "Reference CPU available", status: "ready" },
        },
        response: {
          frequency_sweep: { reason: "Dense validation", status: "ready" },
          magnetic_cpu: {
            reason: "native MFEM CPU gamma/free-boundary response available",
            status: "partial_production_executable",
          },
          magnetic_gpu: { reason: "deferred", status: "unsupported" },
          magnetoelastic_elastodynamic: {
            reason: "deferred",
            status: "unsupported",
          },
          magnetoelastic_quasistatic: {
            reason: "deferred",
            status: "unsupported",
          },
          mode_projected: { reason: "deferred", status: "unsupported" },
        },
        schema_version: "frequency_domain_capabilities.v1",
        validation: {
          fmr_k0: { reason: "FMR k=0 validation", status: "ready" },
        },
        visualization: {
          modal_dispersion_chart: {
            reason: "Dispersion chart available",
            status: "ready",
          },
          modal_spectrum_chart: {
            reason: "Spectrum chart available",
            status: "ready",
          },
          mode_3d_overlay: { reason: "3D overlay available", status: "ready" },
          mode_table: { reason: "Mode table available", status: "ready" },
          response_field_3d_overlay: {
            reason: "Response overlay available",
            status: "ready",
          },
          response_sweep_chart: {
            reason: "Response chart available",
            status: "ready",
          },
        },
      },
      eigen_namespace: "eigen",
      eigenmodes: {
        diagnostics_json: "{}",
        driven_response_available: false,
        dynamic_demag_k_available: false,
        floquet_modal_available: false,
        floquet_response_available: false,
        gpu_available: false,
        modal_solver_available: false,
        static_periodic_response_available: false,
        reason: "modal solver pending",
        status: "unavailable",
        study_kind: "eigenmodes",
      },
      existing_frequency_response_namespace_preserved: true,
      family_namespace: "frequencyDomain",
      floquet_nonzero_k_demag_supported: false,
      floquet_nonzero_k_response_supported: false,
      response: {
        diagnostics_json:
          '{"schema_version":"frequency_domain_availability.v1","execution_lane":"native_fem_mfem_frequency_domain_cpu","scope":"gamma_free_or_static_periodic_magnetic_response"}',
        driven_response_available: true,
        dynamic_demag_k_available: false,
        floquet_modal_available: false,
        floquet_response_available: false,
        gpu_available: false,
        modal_solver_available: false,
        static_periodic_response_available: true,
        reason: "",
        status: "ok",
        study_kind: "frequency_response",
      },
      response_cancel_requested: {
        complete: false,
        completed_frequency_points: 1,
        current_frequency_hz: 9.5e9,
        latest_artifact_manifest_path: "response/artifact_manifest.json",
        missing_reason: null,
        partial_artifacts_available: true,
        progress_json:
          '{"schema_version":"frequency_domain_sweep_progress.v1","state":"cancel_requested"}',
        schema_version: "frequency_domain_sweep_progress.v1",
        status: "cancel_requested",
        total_frequency_points: 4,
        written_frequency_point_artifacts: 1,
      },
      response_progress: null,
      result_manifest: {
        artifact_path: "frequency_domain/manifest.v1.json",
        missing_reason: null,
        payload: {
          artifacts: {
            response_sweep_v2_path: "response/magnetic_response_sweep.v2.json",
          },
          requested_execution: {
            calculation_mode: "fmr_response",
          },
          resources: {
            response_field_resources: [
              {
                field_resource_id: "analysis:frequency-response:frequency-0000",
                frequency_index: 0,
                payload_path:
                  "response/field_payloads/frequency_0000/vector_xyz.bin",
              },
              {
                field_resource_id: "analysis:frequency-response:frequency-0001",
                frequency_index: 1,
                payload_path:
                  "response/field_payloads/frequency_0001/vector_xyz.bin",
              },
            ],
          },
          schema_version: "frequency_domain_manifest.v1",
          stage_kind: "frequency_response",
          spin_wave_bc: {
            floquet_k_vector_rad_per_m: [78539816.33974482, 0, 0],
            kind: "floquet",
            phase_convention: "exp_minus_i_k_dot_delta_r",
          },
        },
        resource_key: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
        schema_version: "frequency_domain_manifest.v1",
        status: "ready",
      },
      schema_version: "frequency_domain_manifest.v1",
    },
    revision: "manifest:1",
    status: "ready",
  }),
  useFrequencyDomainResponseCancelRequestedResource: () => ({
    ...emptyResource,
    data: {
      complete: false,
      completed_frequency_points: 1,
      current_frequency_hz: 9.5e9,
      latest_artifact_manifest_path: "response/artifact_manifest.json",
      missing_reason: null,
      partial_artifacts_available: true,
      progress_json:
        '{"schema_version":"frequency_domain_sweep_progress.v1","state":"cancel_requested"}',
      schema_version: "frequency_domain_sweep_progress.v1",
      status: "cancel_requested",
      total_frequency_points: 4,
      written_frequency_point_artifacts: 1,
    },
    revision: "cancel:1",
    status: "ready",
  }),
  useFrequencyDomainResponseFieldMetaResource: (frequencyIndex?: number) =>
    frequencyIndex == null
      ? emptyResource
      : {
          ...emptyResource,
          data: {
            artifact_path: `response/field_payloads/frequency_${String(frequencyIndex).padStart(4, "0")}/vector_xyz.bin`,
            available_views: [
              "complex",
              "real",
              "imag",
              "abs",
              "amplitude",
              "phase",
              "phase_rotated_real",
            ],
            binary_layout: "complex_f64_pairs_little_endian",
            complex_pair_count: 6,
            component_basis: "global_xyz",
            component_count: 3,
            components: ["x", "y", "z"],
            default_phase_rad: 0,
            default_view: "phase_rotated_real",
            field_id: `analysis:frequency-response:frequency-${String(frequencyIndex).padStart(4, "0")}`,
            missing_reason: null,
            payload_encoding: "f64_interleaved_real_imag_xyz",
            payload_value_count: 12,
            quantity: "delta_m",
            resource_key: `response-field-${frequencyIndex}`,
            schema_version: "frequency_domain_response_field.v1",
            source_family: "analysis/frequency-response",
            status: "ready",
            tangent_component_basis: "local_tangent_frame",
            tangent_component_count: 2,
            tangent_components: ["tangent_e1", "tangent_e2"],
            tangent_complex_pair_count: 4,
            tangent_field_payload_path: `response/field_payloads/frequency_${String(frequencyIndex).padStart(4, "0")}/vector.bin`,
            tangent_payload_encoding: "f64_interleaved_real_imag_tangent",
            tangent_payload_value_count: 8,
            tangent_value_kind: "complex_tangent_vector",
            value_kind: "complex_spatial_vector",
          },
          revision: `response-field-meta:${frequencyIndex}`,
          status: "ready",
        },
  useFrequencyDomainResponseFrequencyPointResource: () => ({
    ...emptyResource,
    data: {
      artifact_path: "response/frequency_points/frequency_0001.json",
      missing_reason: null,
      payload: {
        absorbed_power_density: 42,
        angular_frequency_rad_per_s: 59690260418.206,
        absorbed_power_density_provenance: {
          full_power_density: false,
          kind: "drive_projected_absorption_proxy",
        },
        frequency_hz: 9.5e9,
        m_complex: [[1.0, 0.1], [0.25, -0.2]],
        relative_residual_l2_norm: 1e-9,
        residual_l2_norm: 2e-12,
        response_amplitude: 1.5,
        response_phase: 0.1,
        component_response_amplitude: [1.5, 0.25],
        component_response_phase: [0.1, -0.2],
        susceptibility_tensor: [[3, 4]],
        susceptibility_tensor_provenance: {
          full_tensor: false,
          kind: "drive_projected_scalar",
        },
        tangent_leakage: {
          max_abs_m0_dot_delta_m: 0,
          mean_abs_m0_dot_delta_m: 0,
          status: "evaluated",
        },
      },
      resource_key:
        ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH.replace(
          "{frequency_index}",
          "1",
        ),
      schema_version: "frequency_domain_response_frequency_point.v1",
      status: "ready",
    },
    revision: "point:1",
    status: "ready",
  }),
  useFrequencyDomainResponseProgressResource: () => ({
    ...emptyResource,
    data: {
      complete: false,
      completed_frequency_points: 0,
      current_frequency_hz: null,
      latest_artifact_manifest_path: "frequency_domain/manifest.v1.json",
      missing_reason: "frequency-domain response is unavailable",
      partial_artifacts_available: false,
      progress_json:
        '{"schema_version":"frequency_domain_sweep_progress.v1","state":"unavailable"}',
      schema_version: "frequency_domain_sweep_progress.v1",
      state: "unavailable",
      status: "unavailable",
      total_frequency_points: 2,
      written_frequency_point_artifacts: 0,
    },
    revision: "progress:unavailable",
    status: "ready",
  }),
  useFrequencyDomainResponseSweepResource: () => ({
    ...emptyResource,
    data: {
      artifact_path: "response/magnetic_response_sweep.v2.json",
      missing_reason: null,
      payload: {
        points: [
          {
            frequency_hz: 9.5e9,
            frequency_index: 0,
            max_response_amplitude: 1.5,
            observable_id: "mx",
          },
        ],
        schema_version: "magnetic_response_sweep.v2",
      },
      resource_key:
        ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
      schema_version: "frequency_domain_response_sweep_resource.v1",
      status: "ready",
    },
    revision: "response:1",
    status: "ready",
  }),
  useMeshPeriodicPairsResource: () => ({
    ...emptyResource,
    data: {
      pairs: [
        {
          destination_marker: "x+",
          expected_translation_m: [40e-9, 0, 0],
          marker_a: 11,
          marker_b: 12,
          max_residual_m: 1e-12,
          pair_id: "x-periodic",
          paired_node_count: 24,
          rms_residual_m: 5e-13,
          source_marker: "x-",
          status: "ready",
          unpaired_destination_node_count: 0,
          unpaired_source_node_count: 0,
        },
      ],
      revision: 7,
      schema_version: "periodic_pairs.v1",
    },
    revision: 7,
    status: "ready",
  }),
}));

describe("FrequencyDomainInspectorPanel", () => {
  it("shows the selected frequency-domain resource reference", () => {
    const selection: Selection = {
      kind: "resources.analysis.frequency_response.progress",
      label: "Response Progress",
      moduleSource: "explorer",
      nodeId: "resources:analysis:frequency-response:progress",
      objectId: null,
      ref: {
        kind: "resources.analysis.frequency_response.progress",
        nodeId: "resources:analysis:frequency-response:progress",
        artifactPath: "response/progress.v1.json",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Selected resource");
    expect(html).toContain("Response Progress Resource Detail");
    expect(html).toContain(
      "frequency sweep progress, cancellation, and partial artifacts",
    );
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH);
    expect(html).toContain("Selected artifact");
    expect(html).toContain("response/progress.v1.json");
    expect(html).toContain("Response Cancellation");
    expect(html).toContain("cancel_requested");
    expect(html).toContain("1/4");
    expect(html).toContain("response/artifact_manifest.json");
    expect(html).toContain(
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
    );
    expect(html).toContain("Response data source");
    expect(html).toContain("response.v2");
    expect(html).toContain("Primary chart");
    expect(html).toContain("response-sweep (fmr_response)");
    expect(html).toContain("Response progress status");
    expect(html).toContain("Response progress state");
    expect(html).toContain("unavailable");
    expect(html).toContain("Response progress reason");
    expect(html).toContain("frequency-domain response is unavailable");
    expect(html).toContain("Latest response manifest");
    expect(html).toContain("frequency_domain/manifest.v1.json");
    expect(html).toContain("Demag-k policy");
    expect(html).toContain("dynamic demag-k is blocked for nonzero-k Floquet");
    expect(html).toContain("Driven Response Solver");
    expect(html).toContain("Driven response");
    expect(html).toContain("yes");
    expect(html).toContain("Static-periodic response");
    expect(html).toContain("partial_production_executable");
    expect(html).toContain("Floquet response");
    expect(html).toContain("GPU lane");
    expect(html).toContain("FMR response sweep");
    expect(html).toContain("can be exposed by response artifacts");
  });

  it("renders manifest response field resources for response field resource nodes", () => {
    const selection: Selection = {
      kind: "resources.analysis.frequency_response.field",
      label: "Response Fields",
      moduleSource: "explorer",
      nodeId: "resources:analysis:frequency-response:field",
      objectId: null,
      ref: {
        artifactPath: "response/field_payloads/frequency_0000/vector_xyz.bin",
        fieldId: "analysis:frequency-response:frequency-0000",
        kind: "resources.analysis.frequency_response.field",
        nodeId: "resources:analysis:frequency-response:field",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH.replace(
          "{frequency_index}",
          "0",
        ),
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Response Field Resources");
    expect(html).toContain("2 response field(s)");
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH);
    expect(html).toContain("analysis:frequency-response:frequency-0000");
    expect(html).toContain("analysis:frequency-response:frequency-0001");
    expect(html).toContain(
      "response/field_payloads/frequency_0000/vector_xyz.bin",
    );
    expect(html).toContain(
      "response/field_payloads/frequency_0001/vector_xyz.bin",
    );
  });

  it("renders periodic and Floquet diagnostics for periodic-pair nodes", () => {
    const selection: Selection = {
      kind: "resources.mesh.periodic_pairs",
      label: "Periodic Pairs",
      moduleSource: "explorer",
      nodeId: "resources:mesh:periodic-pairs",
      objectId: null,
      ref: {
        kind: "resources.mesh.periodic_pairs",
        nodeId: "resources:mesh:periodic-pairs",
        resourceRef: MESHING_PERIODIC_PAIRS_PATH,
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Periodic / Floquet mesh resource");
    expect(html).toContain("Periodic/Floquet Node Detail");
    expect(html).toContain("periodic pair table and Floquet capability gates");
    expect(html).toContain("Periodic / Floquet Boundary Conditions");
    expect(html).toContain(MESHING_PERIODIC_PAIRS_PATH);
    expect(html).toContain("Pair count");
    expect(html).toContain("x-periodic");
    expect(html).toContain("markers 11/12");
    expect(html).toContain("Max residual");
    expect(html).toContain("1e-12 m");
    expect(html).toContain("Invalid pairs");
    expect(html).toContain("0");
    expect(html).toContain("Floquet phase preview");
    expect(html).toContain("exp(-i k dot delta_r)");
    expect(html).toContain("Phase angle");
    expect(html).toContain("3.141592653589793 rad");
    expect(html).toContain("Re(exp(-i k dot delta_r))");
    expect(html).toContain("-1");
    expect(html).toContain("Im(exp(-i k dot delta_r))");
    expect(html).toContain("Dynamic demag-k");
    expect(html).toContain("dynamic demag-k is blocked for nonzero-k Floquet");
  });

  it.each([
    [
      "study.stage.eigenmodes.boundary",
      "Eigenmodes Boundary Node Detail",
      "open, periodic, and Floquet modal boundary conditions",
    ],
    [
      "study.stage.eigenmodes.periodic_pairs",
      "Eigenmodes Periodic Pairs Node Detail",
      "periodic pair selector and mesh pairing diagnostics",
    ],
    [
      "study.stage.eigenmodes.k_path",
      "Eigenmodes k-Path Node Detail",
      "Bloch k-path samples and modal dispersion setup",
    ],
    [
      "study.stage.frequency_response.boundary",
      "Frequency Response Boundary Node Detail",
      "open, periodic, and driven Floquet boundary conditions",
    ],
    [
      "study.stage.frequency_response.periodic_pairs",
      "Frequency Response Periodic Pairs Node Detail",
      "periodic pair selector and driven-response Floquet gates",
    ],
    [
      "study.stage.frequency_response.k_grid",
      "Frequency Response k/f Grid Node Detail",
      "future k/f response-map sampling grid",
    ],
    [
      "diagnostics.frequency_domain.periodic_floquet",
      "Periodic/Floquet Diagnostic Node Detail",
      "periodic pairing, Bloch phase, and demag-k diagnostics",
    ],
    [
      "results.frequency_domain.dispersion",
      "Dispersion Result Node Detail",
      "Floquet/Bloch dispersion chart and k-path table",
    ],
  ])(
    "renders dedicated periodic/Floquet detail for %s",
    (kind, expectedTitle, expectedVisualization) => {
      const selection: Selection = {
        kind,
        label: expectedTitle,
        moduleSource: "explorer",
        nodeId: `test:${kind}`,
        objectId: null,
        ref: (kind.startsWith("study.stage.")
          ? {
              kind,
              nodeId: `test:${kind}`,
              stageId: "stage-1",
              stageIndex: 0,
              type: "study-stage",
            }
          : {
              kind,
              nodeId: `test:${kind}`,
              type: "frequency-domain",
            }) as Selection["ref"],
      };

      const html = renderToStaticMarkup(
        <FrequencyDomainInspectorPanel selection={selection} />,
      );

      expect(html).toContain(expectedTitle);
      expect(html).toContain(expectedVisualization);
      expect(html).not.toContain("family overview");
      if (kind.includes("k_path")) {
        expect(html).toContain("k-Path Samples");
        expect(html).toContain("path_s range");
        expect(html).toContain("0-78539816.33974482 rad/m");
        expect(html).toContain("Endpoint labels");
        expect(html).toContain("Gamma -&gt; X");
      }
    },
  );

  it("renders selected response frequency point artifact details", () => {
    const selection: Selection = {
      kind: "results.frequency_response.frequency_point",
      label: "Frequency 1",
      moduleSource: "explorer",
      nodeId: "results:frequency-response:frequency-points:1",
      objectId: null,
      ref: {
        fieldId: "analysis:frequency-response:frequency-0001",
        frequencyIndex: 1,
        kind: "results.frequency_response.frequency_point",
        nodeId: "results:frequency-response:frequency-points:1",
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Selected Response Frequency Point");
    expect(html).toContain("Response Frequency Node Detail");
    expect(html).toContain("frequency index 1");
    expect(html).toContain("real, imag, complex abs, phase, animated phase");
    expect(html).toContain(
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH.replace(
        "{frequency_index}",
        "1",
      ),
    );
    expect(html).toContain("response/frequency_points/frequency_0001.json");
    expect(html).toContain("9500000000 Hz");
    expect(html).toContain("42 W/m^3");
    expect(html).toContain("Absorbed power provenance");
    expect(html).toContain("drive_projected_absorption_proxy");
    expect(html).toContain("Susceptibility pairs");
    expect(html).toContain("Max susceptibility magnitude");
    expect(html).toContain("5");
    expect(html).toContain("Susceptibility provenance");
    expect(html).toContain("drive_projected_scalar");
    expect(html).toContain("Full susceptibility tensor");
    expect(html).toContain("no");
    expect(html).toContain("Tangent leakage status");
    expect(html).toContain("evaluated");
    expect(html).toContain("Complex entries");
    expect(html).toContain("Amplitude entries");
    expect(html).toContain("Phase entries");
    expect(html).toContain("Value kind");
    expect(html).toContain("complex_spatial_vector");
    expect(html).toContain("Component basis");
    expect(html).toContain("global_xyz");
    expect(html).toContain("Component count");
    expect(html).toContain("x, y, z");
    expect(html).toContain("Payload encoding");
    expect(html).toContain("f64_interleaved_real_imag_xyz");
    expect(html).toContain("Binary layout");
    expect(html).toContain("complex_f64_pairs_little_endian");
    expect(html).toContain("Complex pairs");
    expect(html).toContain("Payload scalar values");
    expect(html).toContain("Raw tangent payload");
    expect(html).toContain("vector.bin");
    expect(html).toContain("Raw tangent basis");
    expect(html).toContain("local_tangent_frame");
    expect(html).toContain("Raw tangent components");
    expect(html).toContain("tangent_e1, tangent_e2");
    expect(html).toContain("Raw tangent encoding");
    expect(html).toContain("f64_interleaved_real_imag_tangent");
    expect(html).toContain("3D plot status");
    expect(html).toContain("ready for spatial XYZ overlay");
  });

  it("renders selected response observable sweep details", () => {
    const selection: Selection = {
      kind: "results.frequency_response.observable",
      label: "mx",
      moduleSource: "explorer",
      nodeId: "results:frequency-response:observables:mx",
      objectId: null,
      ref: {
        kind: "results.frequency_response.observable",
        nodeId: "results:frequency-response:observables:mx",
        observableId: "mx",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Selected Response Observable");
    expect(html).toContain("Response Observable Node Detail");
    expect(html).toContain("FMR sweep chart and observable table");
    expect(html).toContain("Observable ID");
    expect(html).toContain("mx");
    expect(html).toContain("Observable points");
    expect(html).toContain("1");
    expect(html).toContain("9500000000-9500000000 Hz");
    expect(html).toContain("Mean amplitude");
    expect(html).toContain("1.5");
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH);
  });

  it("renders FMR peak rows from modal and driven response artifacts", () => {
    const selection: Selection = {
      kind: "results.frequency_domain.fmr_peaks",
      label: "FMR Peaks",
      moduleSource: "explorer",
      nodeId: "results:frequency-domain:fmr:peaks",
      objectId: null,
      ref: {
        kind: "results.frequency_domain.fmr_peaks",
        nodeId: "results:frequency-domain:fmr:peaks",
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainInspectorPanel selection={selection} />,
    );

    expect(html).toContain("FMR Peaks");
    expect(html).toContain("FMR Peaks Node Detail");
    expect(html).toContain("modal resonance table and driven peak table");
    expect(html).toContain("Peak count");
    expect(html).toContain("3");
    expect(html).toContain("Modal peaks");
    expect(html).toContain("2");
    expect(html).toContain("Driven peaks");
    expect(html).toContain("1");
    expect(html).toContain("First peak source");
    expect(html).toContain("modal");
    expect(html).toContain("First peak frequency");
    expect(html).toContain("9500000000 Hz");
  });

  it.each([
    [
      "results.frequency_domain.calculation_modes",
      "Calculation Modes Node Detail",
      "FMR modal, driven FMR, dispersion, response map",
    ],
    [
      "results.frequency_domain.fmr",
      "FMR Result Node Detail",
      "modal and driven FMR comparison",
    ],
    [
      "results.frequency_domain.fmr_modal_spectrum",
      "FMR Modal Spectrum Node Detail",
      "modal resonance spectrum and mode overlay",
    ],
    [
      "results.frequency_domain.fmr_response_sweep",
      "FMR Response Sweep Node Detail",
      "driven response sweep, phase, absorbed power",
    ],
    [
      "results.frequency_domain.response_map",
      "Response Map Node Detail",
      "future k/f intensity map",
    ],
    [
      "results.frequency_domain.comparison",
      "Modal vs Driven Comparison Node Detail",
      "modal-driven resonance comparison",
    ],
    [
      "results.frequency_domain.exports",
      "Frequency-Domain Exports Node Detail",
      "artifact export and provenance bundle",
    ],
  ])(
    "renders dedicated frequency-domain family detail for %s",
    (kind, expectedTitle, expectedVisualization) => {
      const selection: Selection = {
        kind,
        label: expectedTitle,
        moduleSource: "explorer",
        nodeId: `test:${kind}`,
        objectId: null,
        ref: {
          kind,
          nodeId: `test:${kind}`,
          type: "frequency-domain",
        },
      };

      const html = renderToStaticMarkup(
        <FrequencyDomainInspectorPanel selection={selection} />,
      );

      expect(html).toContain(expectedTitle);
      expect(html).toContain(expectedVisualization);
      expect(html).not.toContain("family overview");
    },
  );

  it("renders selected eigen mode metadata and diagnostics", () => {
    const selection: Selection = {
      kind: "results.eigen.mode",
      label: "Mode 2",
      moduleSource: "explorer",
      nodeId: "results:eigen:sample:0:mode:2",
      objectId: null,
      ref: {
        fieldId: "analysis:eigen:sample-0000:mode-0002",
        kind: "results.eigen.mode",
        modeIndex: 2,
        nodeId: "results:eigen:sample:0:mode:2",
        resourceRef:
          "/v2/sessions/current/data/fields/analysis:eigen:sample-0000:mode-0002/samples/vector?view=phase_rotated_real&phase_rad=0",
        sampleIndex: 0,
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Selected Eigen Mode");
    expect(html).toContain("Eigen Mode Node Detail");
    expect(html).toContain("sample 0, mode 2");
    expect(html).toContain("real, imag, complex abs, phase, animated phase");
    expect(html).toContain("eigen/modes/sample_0000/mode_0002.json");
    expect(html).toContain(
      "/v2/sessions/current/data/fields/analysis:eigen:sample-0000:mode-0002/samples/vector?view=phase_rotated_real&amp;phase_rad=0",
    );
    expect(html).toContain("12000000000 Hz");
    expect(html).toContain("-12000000 Hz");
    expect(html).toContain("counter_clockwise");
    expect(html).toContain("Tangent leakage max");
    expect(html).toContain("Real samples");
    expect(html).toContain("Imag samples");
    expect(html).toContain("3D mode view");
    expect(html).toContain("Phase-rotated real");
    expect(html).toContain("Real");
    expect(html).toContain("Imag");
    expect(html).toContain("Complex (abs)");
    expect(html).toContain("Phase");
    const fieldViewSelectStart = html.indexOf("Frequency-domain 3D field view");
    const fieldViewSelect = html.slice(fieldViewSelectStart);
    expect(fieldViewSelect.indexOf("Phase-rotated real")).toBeLessThan(
      fieldViewSelect.indexOf("Complex (abs)"),
    );
    expect(html).toContain("Animate field phase");
    expect(html).toContain("Animation rate");
    expect(html).toContain("Set phase");
    expect(html).toContain("Plot in 3D");
  });

  it("wires Plot in 3D to the user-entered phase value", () => {
    const source = readFileSync(
      resolve(__dirname, "FrequencyDomainInspectorPanel.tsx"),
      "utf8",
    );

    expect(source).toContain("analysisFieldPhaseInputRef.current?.value");
    expect(source).toContain("selectedFieldMeta?.default_phase_rad");
  });

  it("renders dedicated diagnostic node detail for frequency-domain diagnostics", () => {
    const selection: Selection = {
      kind: "diagnostics.frequency_domain.solver",
      label: "Solver Diagnostics",
      moduleSource: "explorer",
      nodeId: "diagnostics:frequency-domain:solver",
      objectId: null,
      ref: {
        artifactPath: "response/diagnostics.v1.json",
        kind: "diagnostics.frequency_domain.solver",
        nodeId: "diagnostics:frequency-domain:solver",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Solver Diagnostic Detail");
    expect(html).toContain("Solver Diagnostics");
    expect(html).toContain("response/diagnostics.v1.json");
    expect(html).toContain("GMRES status, residuals, and production provenance");
  });

  it.each([
    [
      "resources.analysis.frequency_domain.manifest",
      "Frequency-Domain Manifest Resource Detail",
      "family manifest payload and resource links",
    ],
    [
      "resources.analysis.eigen.mode_field",
      "Eigen Mode Field Resource Detail",
      "real, imag, abs, phase, and animated phase field views",
    ],
    [
      "resources.analysis.frequency_response.field",
      "Response Field Resource Detail",
      "real, imag, abs, phase, and animated phase field views",
    ],
    [
      "jobs.frequency_domain.response_frequency",
      "Response Frequency Job Detail",
      "single-frequency GMRES solve progress and residuals",
    ],
    [
      "diagnostics.frequency_domain.capabilities",
      "Frequency-Domain Capability Diagnostic Detail",
      "CPU, GPU, Floquet, demag-k, and modal capability gates",
    ],
    [
      "diagnostics.frequency_domain.visualization",
      "Visualization Diagnostic Detail",
      "3D mode overlays, phase animation, and chart readiness",
    ],
  ])(
    "renders a non-generic node detail for %s",
    (kind, expectedTitle, expectedVisualization) => {
      const selection: Selection = {
        kind,
        label: expectedTitle,
        moduleSource: "explorer",
        nodeId: `test:${kind}`,
        objectId: null,
        ref: {
          kind,
          nodeId: `test:${kind}`,
          type: "frequency-domain",
        },
      };

      const html = renderToStaticMarkup(
        <FrequencyDomainInspectorPanel selection={selection} />,
      );

      expect(html).toContain(expectedTitle);
      expect(html).toContain(expectedVisualization);
      expect(html).not.toContain("Analysis Resource Node Detail");
      expect(html).not.toContain("Frequency-Domain Job Node Detail");
      expect(html).not.toContain("Frequency-Domain Diagnostic Node Detail");
      expect(html).not.toContain("family overview");
    },
  );

  it.each(FREQUENCY_DOMAIN_INSPECTOR_SELECTION_KINDS)(
    "renders exact non-fallback detail for %s",
    (kind) => {
      const selection: Selection = {
        kind,
        label: `Selection ${kind}`,
        moduleSource: "explorer",
        nodeId: `test:${kind}`,
        objectId: null,
        ref: {
          kind,
          nodeId: `test:${kind}`,
          type: "frequency-domain",
        },
      };

      const html = renderToStaticMarkup(
        <FrequencyDomainInspectorPanel selection={selection} />,
      );

      expect(html).not.toContain("Unknown Frequency-Domain Node Detail");
      expect(html).not.toContain("unknown node kind");
      expect(html).not.toContain("family overview");
      expect(html).not.toContain("Analysis Resource Node Detail");
      expect(html).not.toContain("Frequency-Domain Job Node Detail");
      expect(html).not.toContain("Frequency-Domain Diagnostic Node Detail");
    },
  );
});
