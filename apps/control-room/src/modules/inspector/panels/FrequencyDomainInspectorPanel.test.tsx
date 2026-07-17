import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
  DATA_FIELD_VECTOR_PATH,
  MESHING_PERIODIC_PAIRS_PATH,
} from "@/kernel/api/apiPaths";
import type { FrequencyDomainSweepProgressResource } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

import { FREQUENCY_DOMAIN_INSPECTOR_SELECTION_KINDS } from "../inspectorRegistry";
import { FrequencyDomainInspectorPanel } from "./FrequencyDomainInspectorPanel";
import {
  EigenModeInspectorPanel,
  EigenBranchInspectorPanel,
  EigenBranchesInspectorPanel,
  EigenDiagnosticsInspectorPanel,
  FrequencyDomainApiResourcesDiagnosticInspectorPanel,
  FrequencyDomainArtifactsDiagnosticInspectorPanel,
  FrequencyDomainCapabilitiesDiagnosticInspectorPanel,
  FrequencyDomainDiagnosticsOverviewInspectorPanel,
  FrequencyDomainEquilibriumDiagnosticInspectorPanel,
  FrequencyDomainPeriodicFloquetDiagnosticInspectorPanel,
  FrequencyDomainPeriodicPairsResourceInspectorPanel,
  FrequencyDomainManifestResourceInspectorPanel,
  FrequencyDomainResourceFamilyInspectorPanel,
  EigenSpectrumResourceInspectorPanel,
  EigenModeFieldResourceInspectorPanel,
  FrequencyResponseSweepResourceInspectorPanel,
  FrequencyResponseProgressResourceInspectorPanel,
  FrequencyResponseFieldResourceInspectorPanel,
  FrequencyDomainOperatorDiagnosticInspectorPanel,
  FrequencyDomainSolverDiagnosticInspectorPanel,
  FrequencyDomainVisualizationDiagnosticInspectorPanel,
  EigenKPathInspectorPanel,
  EigenDispersionInspectorPanel,
  EigenModesInspectorPanel,
  EigenOverviewInspectorPanel,
  EigenProvenanceInspectorPanel,
  EigenSpectrumInspectorPanel,
  EigenStudyInspectorPanel,
  EigenSampleJobInspectorPanel,
  FrequencyDomainArtifactExportJobInspectorPanel,
  FrequencyDomainCalculationModesInspectorPanel,
  FrequencyDomainDispersionInspectorPanel,
  FrequencyDomainExportsInspectorPanel,
  FrequencyDomainJobsOverviewInspectorPanel,
  FrequencyDomainOverviewInspectorPanel,
  FrequencyDomainResponseMapInspectorPanel,
  FrequencyDomainRunInspectorPanel,
  FrequencyDomainStageRunJobInspectorPanel,
  FmrOverviewInspectorPanel,
  FrequencyResponseCancelRequestedInspectorPanel,
  FrequencyResponseDiagnosticsInspectorPanel,
  FrequencyResponseOverviewInspectorPanel,
  FrequencyResponseObservableInspectorPanel,
  FrequencyResponseObservablesInspectorPanel,
  FrequencyResponseFrequencyPointsInspectorPanel,
  FmrComparisonInspectorPanel,
  FmrModalSpectrumInspectorPanel,
  FmrPeakInspectorPanel,
  FmrPeaksInspectorPanel,
  FmrResponseSweepInspectorPanel,
  FrequencyResponsePointInspectorPanel,
  FrequencyResponseFrequencyJobInspectorPanel,
  FrequencyResponseProvenanceInspectorPanel,
  FrequencyResponseProgressInspectorPanel,
  FrequencyResponseProgressJobInspectorPanel,
  FrequencyResponseStudyInspectorPanel,
  FrequencyResponseSweepInspectorPanel,
  frequencyDomainVisualizationReadiness,
} from "./frequency-domain/FrequencyDomainResultInspectors";
import { resolveFrequencyDomainNodeDetail } from "./frequencyDomainNodeDetails";

const emptyResource = {
  data: null,
  error: null,
  refetch: () => undefined,
  revision: null,
  status: "idle",
} as const;

const responseProgressFixture = vi.hoisted((): {
  data: FrequencyDomainSweepProgressResource;
} => ({
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
}));

const eigenDiagnosticsFixture = vi.hoisted(() => ({
  payload: {
    basis_transport_policy: "tangent_frame_transport",
    floquet_tangent_frame_max_mismatch: 0,
    floquet_tangent_transport_max_nonunitarity: 0,
    production_cpu_rejection_reason:
      "production_cpu_modal_nonzero_k_floquet_operator_missing",
    production_cpu_rejection_scope: "selected_spectrum_nonzero_k_floquet_modal",
    schema_version: "frequency_domain_eigen_diagnostics.v2",
    solver_model: "reference_full_2x2_tangent",
  } as Record<string, unknown>,
}));

const responseDiagnosticsFixture = vi.hoisted(() => ({
  payload: {
    krylov_preconditioner_applied: true,
    krylov_preconditioner_kind: "mfem_phi_consistency_schur_right",
    krylov_preconditioner_variant: "graph_demag_coarse",
    schema_version: "frequency_domain_response_diagnostics.v1",
  } as Record<string, unknown>,
}));

function analysisFieldVectorResourceKey(fieldId: string): string {
  return `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", fieldId)}?view=phase_rotated_real&phase_rad=0`;
}

const EXPLORER_GENERATED_FREQUENCY_DOMAIN_NODE_KINDS = [
  "results.frequency_domain.root",
  "results.frequency_domain.run",
  "results.frequency_domain.calculation_modes",
  "results.frequency_domain.fmr",
  "results.frequency_domain.fmr_modal_spectrum",
  "results.frequency_domain.fmr_response_sweep",
  "results.frequency_domain.fmr_peaks",
  "results.frequency_domain.dispersion",
  "results.frequency_domain.response_map",
  "results.frequency_domain.comparison",
  "results.frequency_domain.exports",
  "results.eigen.root",
  "results.eigen.study",
  "results.eigen.spectrum",
  "results.eigen.modes",
  "results.eigen.mode",
  "results.eigen.dispersion",
  "results.eigen.k_path",
  "results.eigen.branches",
  "results.eigen.branch",
  "results.eigen.provenance",
  "results.frequency_response.root",
  "results.frequency_response.study",
  "results.frequency_response.sweep",
  "results.frequency_response.progress",
  "results.frequency_response.cancel_requested",
  "results.frequency_response.frequency_points",
  "results.frequency_response.frequency_point",
  "results.frequency_response.observables",
  "results.frequency_response.observable",
  "results.frequency_response.provenance",
  "resources.analysis.frequency_domain",
  "resources.analysis.frequency_domain.manifest",
  "resources.analysis.eigen.spectrum",
  "resources.analysis.eigen.branches",
  "resources.analysis.eigen.dispersion",
  "resources.analysis.eigen.diagnostics",
  "resources.analysis.eigen.mode_metadata",
  "resources.analysis.eigen.mode_field",
  "resources.analysis.frequency_response.sweep",
  "resources.analysis.frequency_response.frequency_point",
  "resources.analysis.frequency_response.field",
  "resources.analysis.frequency_response.observables",
  "resources.analysis.frequency_response.progress",
  "resources.analysis.frequency_response.cancel_requested",
  "resources.analysis.frequency_response.diagnostics",
  "jobs.frequency_domain.root",
  "jobs.frequency_domain.stage_run",
  "jobs.frequency_domain.eigen_sample",
  "jobs.frequency_domain.response_frequency",
  "jobs.frequency_domain.response_progress",
  "jobs.frequency_domain.artifact_export",
  "diagnostics.frequency_domain.root",
  "diagnostics.frequency_domain.capabilities",
  "diagnostics.frequency_domain.equilibrium",
  "diagnostics.frequency_domain.operator",
  "diagnostics.frequency_domain.solver",
  "diagnostics.frequency_domain.artifacts",
  "diagnostics.frequency_domain.api_resources",
  "diagnostics.frequency_domain.visualization",
  "diagnostics.frequency_domain.periodic_floquet",
] as const;

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    commands: {
      execute: vi.fn(async () => ({ message: "ok", status: "completed" })),
    },
    selection: {
      set: vi.fn(),
    },
    visualization: {
      getSnapshot: () => ({
        defaults: {
          part: {
            surfaceColorSource: "magnitude",
          },
        },
        overrides: {},
        version: 1,
      }),
      patchDefaults: vi.fn(),
      subscribe: () => () => undefined,
    },
    visualizationSync: {
      queuePatch: vi.fn(),
    },
  }),
}));

vi.mock("@/kernel/visualization/useVisualizationStateResource", () => ({
  useVisualizationStateResource: () => ({
    ...emptyResource,
    data: {
      colormap: "viridis",
      quantity: {
        colormap: "inferno",
      },
    },
    status: "ready",
  }),
}));

let mockManifestDiagnostics: unknown[] = [];

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
                mode_field_id: "analysis:eigen:sample-0000:mode-0002",
                overlap_prev: null,
                raw_mode_index: 2,
                residual_norm: 1.2e-7,
                sample_index: 0,
                tracking_confidence: 1,
              },
              {
                frequency_imag_hz: -1.4e7,
                frequency_real_hz: 13.1e9,
                overlap_prev: 0.97,
                raw_mode_index: 1,
                residual_norm: 2.4e-7,
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
  useFrequencyDomainEigenDiagnosticsResource: () => ({
    ...emptyResource,
    data: {
      artifact_path: "eigen/diagnostics.v2.json",
      payload: eigenDiagnosticsFixture.payload,
      resource_key: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH,
      schema_version: "frequency_domain_eigen_diagnostics.v2",
      status: "ready",
    },
    revision: "eigen-diagnostics:1",
    status: "ready",
  }),
  useFrequencyDomainEigenDispersionResource: () => ({
    ...emptyResource,
    data: {
      artifact_path: "eigen/dispersion.csv",
      content_type: "text/csv; charset=utf-8",
      path_metadata: {
        sampling: {
          closed: false,
          kind: "path",
          points: [
            { k_vector: [0, 0, 0], label: "G" },
            { k_vector: [78539816.33974482, 0, 0], label: "X" },
          ],
          samples_per_segment: [1],
        },
      },
      resource_key: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
      schema_version: "frequency_domain_eigen_dispersion.v1",
      status: "ready",
      text: [
        "sample_index,raw_mode_index,branch_id,path_s_rad_per_m,frequency_hz,analytic_frequency_hz,relative_error,validation_geometry,label",
        "0,1,acoustic,0,9.5e9,9.45e9,0.005291005291005291,backward_volume,Gamma",
        "1,1,acoustic,78539816.33974482,12.0e9,11.94e9,0.005025125628140704,damon_eshbach,X",
      ].join("\n"),
    },
    revision: "dispersion:1",
    status: "ready",
  }),
  useFrequencyDomainEigenModeFieldMetaResource: (
    sampleIndex: number | null | undefined,
    modeIndex: number | null | undefined,
  ) =>
    sampleIndex === 0 && modeIndex === 2
      ? {
          ...emptyResource,
          data: {
            artifact_path:
              "eigen/mode_fields.zarr/sample_0000/mode_0002/vector_xyz_complex",
            available_views: [
              "phase_rotated_real",
              "real",
              "imag",
              "abs",
              "phase",
            ],
            binary_layout: "zarr_v2_aos_xyz_complex_pairs",
            complex_pair_count: 3,
            component_basis: "global_xyz",
            component_count: 3,
            components: ["x", "y", "z"],
            default_phase_rad: 0,
            default_view: "phase_rotated_real",
            field_id: "analysis:eigen:sample-0000:mode-0002",
            missing_reason: null,
            payload_encoding: "f64_interleaved_real_imag_xyz",
            payload_value_count: 18,
            quantity: "delta_m",
            resource_key: analysisFieldVectorResourceKey(
              "analysis:eigen:sample-0000:mode-0002",
            ),
            schema_version: "frequency_domain_eigen_field.v1",
            source_family: "analysis/eigen",
            status: "ready",
            tangent_component_basis: "local_tangent_e1_e2",
            tangent_components: ["e1", "e2"],
            tangent_field_payload_path:
              "eigen/mode_fields.zarr/sample_0000/mode_0002/tangent_complex/0.0.0",
            tangent_payload_encoding: "f64_interleaved_real_imag_e1_e2",
            tangent_value_kind: "complex_tangent_vector",
            value_kind: "complex_spatial_vector",
            zarr_array_path:
              "eigen/mode_fields.zarr/sample_0000/mode_0002/vector_xyz_complex",
            zarr_chunk_path:
              "eigen/mode_fields.zarr/sample_0000/mode_0002/vector_xyz_complex/0.0.0",
            zarr_chunk_shape: [3, 3, 2],
            zarr_compressor: null,
            zarr_dtype: "<f8",
            zarr_shape: [3, 3, 2],
            zarr_store_path: "eigen/mode_fields.zarr",
          },
          revision: "mode-field-meta:0:2",
          status: "ready",
        }
      : emptyResource,
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
      mode_field_resource_key: analysisFieldVectorResourceKey(
        "analysis:eigen:sample-0000:mode-0002",
      ),
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
          production_cpu: {
            reason: "managed no-demag Bloch/Floquet k-path slice",
            status: "partial_production_executable",
          },
          production_cpu_gamma_k_path: {
            reason: "gamma-equivalent selected-spectrum bridge",
            status: "partial_production_executable",
          },
          production_gpu: {
            reason: "modal GPU deferred",
            status: "unsupported",
          },
          reference_cpu: { reason: "Reference CPU dispersion", status: "ready" },
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
          mode_3d_overlay: { reason: "3D field available", status: "ready" },
          mode_table: { reason: "Mode table available", status: "ready" },
          response_field_3d_overlay: {
            reason: "Response field available",
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
          diagnostics: mockManifestDiagnostics,
          artifacts: {
            response_sweep_v2_path: "response/magnetic_response_sweep.v2.json",
          },
          capabilities: {
            dispersion: {
              branch_tracking: {
                reason: "Artifact branch tracking available",
                status: "reference_executable",
              },
              k_path: {
                reason: "Artifact k-path available",
                status: "reference_executable",
              },
              production_cpu: {
                reason: "managed no-demag Bloch/Floquet k-path slice",
                status: "partial_production_executable",
              },
              production_cpu_gamma_k_path: {
                reason: "gamma-equivalent selected-spectrum bridge",
                status: "partial_production_executable",
              },
              production_gpu: {
                reason: "modal GPU deferred",
                status: "unsupported",
              },
              reference_cpu: {
                reason: "Reference Full2x2 Floquet dispersion",
                status: "reference_executable",
              },
            },
          },
          requested_execution: {
            calculation_mode: "fmr_response",
            magnetostatic_bc: "periodic_airbox_k0",
          },
          physics: {
            analysis_family: "magnetic_frequency_domain",
            field_units: "dimensionless_delta_m",
            frequency_units: "Hz",
            normalization: "unit_l2",
            phase_convention: "exp_minus_i_omega_t",
          },
          excitation: {
            field_au_per_m: [1.0, 0.0, 0.0],
            phase_rad: 0.0,
          },
          validation: {
            dispersion_validation: {
              analytic_model: "kalinikos_slab_n0",
              frequency_window_hz: { max: 5.0e9, min: 0 },
              kind: "thin_film_de_bv_low_k",
              max_k_rad_per_m: 3.0e6,
              scenarios: [
                {
                  branch_id: "acoustic",
                  geometry: "backward_volume",
                  sample_indices: [0, 1, 2],
                },
                {
                  branch_id: "acoustic",
                  geometry: "damon_eshbach",
                  sample_indices: [3, 4, 5],
                },
              ],
            },
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
          magnetostatic_bc: "periodic_airbox_k0",
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
      demag_mode: "periodic_airbox_k0",
      frequency_max_hz: 12.0e9,
      frequency_min_hz: 8.0e9,
      latest_artifact_manifest_path: "response/artifact_manifest.json",
      missing_reason: null,
      partial_artifacts_available: true,
      progress_json:
        '{"schema_version":"frequency_domain_sweep_progress.v1","state":"cancel_requested","native_iteration_count":128,"native_relative_residual_l2_norm":0.0125}',
      schema_version: "frequency_domain_sweep_progress.v1",
      status: "cancel_requested",
      total_frequency_points: 4,
      written_frequency_point_artifacts: 1,
    },
    revision: "cancel:1",
    status: "ready",
  }),
  useFrequencyDomainResponseDiagnosticsResource: () => ({
    ...emptyResource,
    data: {
      artifact_path: "response/diagnostics/solver.v1.json",
      missing_reason: null,
      payload: responseDiagnosticsFixture.payload,
      resource_key: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
      schema_version: "frequency_domain_response_diagnostics_resource.v1",
      status: "ready",
    },
    revision: "response-diagnostics:1",
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
    data: responseProgressFixture.data,
    revision: `progress:${responseProgressFixture.data.status}:${responseProgressFixture.data.current_frequency_hz ?? "none"}`,
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
      status: "valid",
    },
    revision: 7,
    status: "ready",
  }),
}));

beforeEach(() => {
  eigenDiagnosticsFixture.payload = {
    basis_transport_policy: "tangent_frame_transport",
    floquet_tangent_frame_max_mismatch: 0,
    floquet_tangent_transport_max_nonunitarity: 0,
    production_cpu_rejection_reason:
      "production_cpu_modal_nonzero_k_floquet_operator_missing",
    production_cpu_rejection_scope: "selected_spectrum_nonzero_k_floquet_modal",
    schema_version: "frequency_domain_eigen_diagnostics.v2",
    solver_model: "reference_full_2x2_tangent",
  };
  responseDiagnosticsFixture.payload = {
    krylov_preconditioner_applied: true,
    krylov_preconditioner_kind: "mfem_phi_consistency_schur_right",
    krylov_preconditioner_variant: "graph_demag_coarse",
    schema_version: "frequency_domain_response_diagnostics.v1",
  };
  responseProgressFixture.data = {
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
  };
});

describe("FrequencyDomainInspectorPanel", () => {
  it("keeps cancel-requested resource endpoint distinct from the disk artifact path", () => {
    const resultDetail = resolveFrequencyDomainNodeDetail({
      kind: "results.frequency_response.cancel_requested",
      label: "Cancel Requested",
      moduleSource: "explorer",
      nodeId: "results:frequency-response:cancel-requested",
      objectId: null,
      ref: {
        kind: "results.frequency_response.cancel_requested",
        nodeId: "results:frequency-response:cancel-requested",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
        type: "frequency-domain",
      },
    });
    const resourceDetail = resolveFrequencyDomainNodeDetail({
      kind: "resources.analysis.frequency_response.cancel_requested",
      label: "Cancel Requested Resource",
      moduleSource: "explorer",
      nodeId: "resources:analysis:frequency-response:cancel-requested",
      objectId: null,
      ref: {
        kind: "resources.analysis.frequency_response.cancel_requested",
        nodeId: "resources:analysis:frequency-response:cancel-requested",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
        type: "frequency-domain",
      },
    });

    expect(resultDetail.artifact).toBe("response/cancel_requested.v1.json");
    expect(resourceDetail.artifact).toBe("response/cancel_requested.v1.json");
    expect(resultDetail.resource).toBe(
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
    );
    expect(resourceDetail.resource).toBe(
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
    );
  });

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
    expect(html).not.toContain("Driven Response Solver");
    expect(html).not.toContain("Driven Response Chart");
    expect(html).not.toContain("Physics Contract");
    expect(html).not.toContain("Periodic / Floquet Boundary Conditions");
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

  it("explains disabled 3D controls when a response field resource has no data-plane field", () => {
    const selection: Selection = {
      kind: "resources.analysis.frequency_response.field",
      label: "Response Fields",
      moduleSource: "explorer",
      nodeId: "resources:analysis:frequency-response:field",
      objectId: null,
      ref: {
        fieldId: "analysis:frequency-response:frequency-9999",
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

    expect(html).toMatch(
      /aria-label="Frequency-domain mode 3D view"[^>]*disabled=""[^>]*title="Selected frequency-domain field is missing a data-plane resource"/,
    );
    expect(html).toMatch(
      /aria-label="Frequency-domain 3D phase"[^>]*disabled=""[^>]*title="Selected frequency-domain field is missing a data-plane resource"/,
    );
    expect(html).toMatch(
      /aria-label="Plot selected frequency-domain field in 3D"[^>]*disabled=""[^>]*title="Selected frequency-domain field is missing a data-plane resource"/,
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
    expect(html).toContain("Periodic/Floquet");
    expect(html).toContain("periodic pair table and Floquet capability gates");
    expect(html).toContain("Periodic / Floquet Boundary Conditions");
    expect(html).toContain(
      '<span class="fm-inspector-field-row__label">Periodic pairs status</span><span class="fm-inspector-field-row__value">valid</span>',
    );
    expect(html).toContain(MESHING_PERIODIC_PAIRS_PATH);
    expect(html).toContain("Pair count");
    expect(html).toContain("x-periodic");
    expect(html).toContain("markers 11/12");
    expect(html).toContain("Max residual");
    expect(html).toContain("1.000e-12 m");
    expect(html).toContain("Invalid pairs");
    expect(html).toContain("0");
    expect(html).toContain("Floquet phase preview");
    expect(html).toContain("exp(-i k dot delta_r)");
    expect(html).toContain("Phase angle");
    expect(html).toContain("3.1416 rad");
    expect(html).toContain("Re(exp(-i k dot delta_r))");
    expect(html).toContain("-1");
    expect(html).toContain("Im(exp(-i k dot delta_r))");
    expect(html).toContain("Dynamic demag-k");
    expect(html).toContain("dynamic demag-k is blocked for nonzero-k Floquet");
  });

  it.each([
    [
      "study.stage.eigenmodes.boundary",
      "Eigenmodes Boundary",
      "open, periodic, and Floquet modal boundary conditions",
    ],
    [
      "study.stage.eigenmodes.periodic_pairs",
      "Eigenmodes Periodic Pairs",
      "periodic pair selector and mesh pairing diagnostics",
    ],
    [
      "study.stage.eigenmodes.k_path",
      "Eigenmodes k-Path",
      "Bloch k-path samples and modal dispersion setup",
    ],
    [
      "study.stage.frequency_response.boundary",
      "Frequency Response Boundary",
      "open, periodic, and driven Floquet boundary conditions",
    ],
    [
      "study.stage.frequency_response.periodic_pairs",
      "Frequency Response Periodic Pairs",
      "periodic pair selector and driven-response Floquet gates",
    ],
    [
      "study.stage.frequency_response.k_grid",
      "Frequency Response k/f Grid",
      "future k/f response-map sampling grid",
    ],
    [
      "diagnostics.frequency_domain.periodic_floquet",
      "Periodic/Floquet Diagnostic",
      "periodic pairing, Bloch phase, and demag-k diagnostics",
    ],
    [
      "results.frequency_domain.dispersion",
      "Dispersion Result",
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
      if (kind.includes(".boundary") || kind.includes(".periodic_pairs")) {
        expect(html).not.toContain("Modal Eigen Solver");
        expect(html).not.toContain("Driven Response Solver");
        expect(html).not.toContain("Solver Family Contract");
        expect(html).not.toContain("Plot Readiness");
        expect(html).not.toContain("Eigen Mode Browser");
      }
      if (kind.includes("k_path") || kind.includes("k_grid")) {
        expect(html).not.toContain("Modal Eigen Solver");
        expect(html).not.toContain("Driven Response Solver");
        expect(html).not.toContain("Solver Family Contract");
        expect(html).not.toContain("Plot Readiness");
      }
      if (kind.includes("k_path")) {
        expect(html).toContain("Bloch k-Path Parameters");
        expect(html).toContain("path_s range");
        expect(html).toContain("0-78539816.33974482 rad/m");
        expect(html).toContain("Endpoint labels");
        expect(html).toContain("Gamma -&gt; X");
      }
    },
  );

  it.each([
    [
      "diagnostics.frequency_domain.solver",
      "Solver Diagnostic Detail",
      ["Solver Family Contract", "Plot Readiness", "Eigen Mode Browser"],
    ],
    [
      "results.eigen.branch",
      "Eigen Branch",
      ["Modal Eigen Solver", "Modal Spectrum", "Eigen Mode Browser"],
    ],
    [
      "resources.analysis.eigen.diagnostics",
      "Eigen Diagnostics Resource Detail",
      ["Modal Spectrum", "Eigen Mode Browser", "Selected Eigen Mode"],
    ],
    [
      "jobs.frequency_domain.artifact_export",
      "Artifact Export Job Detail",
      ["Solver Family Contract", "Modal Spectrum", "Driven Response Chart"],
    ],
  ])(
    "does not render unrelated shared sections for %s",
    (kind, expectedTitle, forbiddenSections) => {
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
      for (const forbiddenSection of forbiddenSections) {
        expect(html).not.toContain(forbiddenSection);
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
    expect(html).toContain("Response Frequency");
    expect(html).toContain("frequency index 1");
    expect(html).toContain("real, imag, complex abs, phase, animated phase");
    expect(html).toContain(
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH.replace(
        "{frequency_index}",
        "1",
      ),
    );
    expect(html).toContain("response/frequency_points/frequency_0001.json");
    expect(html).toContain("9.5 GHz");
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
    expect(html).toContain("ready for spatial XYZ field");
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
    expect(html).toContain("Response Observable");
    expect(html).toContain("FMR sweep chart and observable table");
    expect(html).toContain("Observable ID");
    expect(html).toContain("mx");
    expect(html).toContain("Observable points");
    expect(html).toContain("1");
    expect(html).toContain("9.5 GHz-9.5 GHz");
    expect(html).toContain("Mean amplitude");
    expect(html).toContain("1.5");
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH);
  });

  it("renders a dedicated response observable control surface", () => {
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
      <FrequencyResponseObservableInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Response Observable Control");
    expect(html).toContain("Canonical object");
    expect(html).toContain("FrequencyResponse observable");
    expect(html).toContain("Observable");
    expect(html).toContain("mx");
    expect(html).toContain("Sweep resource");
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH);
    expect(html).toContain("Frequency range");
    expect(html).toContain("9.5 GHz-9.5 GHz");
    expect(html).toContain("Point count");
    expect(html).toContain("1");
    expect(html).toContain("Mean amplitude");
    expect(html).toContain("1.500");
    expect(html).toContain("Peak amplitude");
    expect(html).toContain("Field payloads");
    expect(html).toContain("1/1 point(s) field-ready");
    expect(html).toContain("Selected Response Observable");
  });

  it("renders a dedicated driven response sweep control surface", () => {
    const selection: Selection = {
      kind: "results.frequency_response.sweep",
      label: "Sweep",
      moduleSource: "explorer",
      nodeId: "results:frequency-response:sweep",
      objectId: null,
      ref: {
        kind: "results.frequency_response.sweep",
        nodeId: "results:frequency-response:sweep",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyResponseSweepInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Driven Response Sweep Control");
    expect(html).toContain("Canonical object");
    expect(html).toContain("FrequencyResponse sweep");
    expect(html).toContain("Sweep resource");
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH);
    expect(html).toContain("Frequency range");
    expect(html).toContain("9.5 GHz-9.5 GHz");
    expect(html).toContain("Frequency points");
    expect(html).toContain("1");
    expect(html).toContain("Observable series");
    expect(html).toContain("1 series");
    expect(html).toContain("Peak response");
    expect(html).toContain("9.5 GHz; amplitude 1.500");
    expect(html).toContain("Field payloads");
    expect(html).toContain("1/1 point(s) field-ready");
    expect(html).toContain("Response series controls");
    expect(html).toContain("Amplitude, Phase, Absorbed power density, Max |susceptibility|");
    expect(html).toContain("Susceptibility component");
    expect(html).toContain("max |χ| from response tensor");
    expect(html).toContain("Phase coverage");
    expect(html).toContain("1/1 point(s)");
    expect(html).toContain("Absorbed-power coverage");
    expect(html).toContain("Cancellation state");
    expect(html).toContain("cancel_requested; 1/4");
    expect(html).toContain("Driven Response Chart");
  });

  it("renders a dedicated frequency-response frequency points collection surface", () => {
    const selection: Selection = {
      kind: "results.frequency_response.frequency_points",
      label: "Frequency Points",
      moduleSource: "explorer",
      nodeId: "results:frequency-response:frequency-points",
      objectId: null,
      ref: {
        kind: "results.frequency_response.frequency_points",
        nodeId: "results:frequency-response:frequency-points",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyResponseFrequencyPointsInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Response Frequency Points Table");
    expect(html).toContain("Canonical collection");
    expect(html).toContain("FrequencyResponse solved points");
    expect(html).toContain("Sweep resource");
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH);
    expect(html).toContain("Solved frequencies");
    expect(html).toContain("1 point(s), 1 observable series");
    expect(html).toContain("Frequency range");
    expect(html).toContain("9.5 GHz-9.5 GHz");
    expect(html).toContain("Amplitude range");
    expect(html).toContain("1.500-1.500");
    expect(html).toContain("Field payloads");
    expect(html).toContain("2 manifest field(s), 1 sweep field(s)");
    expect(html).toContain("Progress state");
    expect(html).toContain("unavailable; 0/2");
    expect(html).toContain("Cancellation state");
    expect(html).toContain("cancel_requested; 1/4");
    expect(html).toContain("Frequency-domain response point table");
  });

  it("renders a dedicated eigen k-path control surface", () => {
    const selection: Selection = {
      kind: "results.eigen.k_path",
      label: "k-Path",
      moduleSource: "explorer",
      nodeId: "results:eigen:k-path",
      objectId: null,
      ref: {
        kind: "results.eigen.k_path",
        nodeId: "results:eigen:k-path",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <EigenKPathInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Eigen k-Path Inspector");
    expect(html).toContain("Canonical workflow");
    expect(html).toContain("dispersion_modal -&gt; StudyIR::Eigenmodes");
    expect(html).toContain("Dispersion resource");
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH);
    expect(html).toContain("Path metadata artifact");
    expect(html).toContain("eigen/dispersion/path.json");
    expect(html).toContain("Path sampling");
    expect(html).toContain("path; 1 segment(s), 2 sample(s), open");
    expect(html).toContain("Path labels");
    expect(html).toContain("G -&gt; X");
    expect(html).toContain("k-path span");
    expect(html).toContain("0-7.854e+7 rad/m");
    expect(html).toContain("Frequency coverage");
    expect(html).toContain("Analytic reference");
    expect(html).toContain("2 point(s); backward_volume, damon_eshbach; max rel. error 0.005291");
    expect(html).toContain("Validation intent");
    expect(html).toContain(
      "thin_film_de_bv_low_k; kalinikos_slab_n0; k&lt;=3.000e+6 rad/m; 0-5 GHz; backward_volume: acoustic [3 sample(s)], damon_eshbach: acoustic [3 sample(s)]",
    );
    expect(html).toContain("9.5 GHz-12 GHz");
    expect(html).toContain("Sample count");
    expect(html).toContain("2 point(s)");
    expect(html).toContain("Branch tracking");
    expect(html).toContain("1 branch(es), 2 tracked point(s)");
    expect(html).toContain("Floquet gate");
    expect(html).toContain("modal ready; response unsupported");
    expect(html).toContain("Dispersion Chart");
  });

  it("renders dedicated eigen diagnostics from modal artifacts and capabilities", () => {
    const selection: Selection = {
      kind: "results.eigen.diagnostics",
      label: "Eigen Diagnostics",
      moduleSource: "explorer",
      nodeId: "results:eigen:diagnostics",
      objectId: null,
      ref: {
        kind: "results.eigen.diagnostics",
        nodeId: "results:eigen:diagnostics",
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <EigenDiagnosticsInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Eigen Diagnostics");
    expect(html).toContain("Modal availability");
    expect(html).toContain("eigenmodes: unavailable; modal=false; gpu=false");
    expect(html).toContain("Capability summary");
    expect(html).toContain(
      "reference_cpu: reference_executable; production_cpu: partial_production_executable; production_cpu_gamma_k_path: partial_production_executable; production_gpu: unsupported; k_path: reference_executable; branch_tracking: reference_executable",
    );
    expect(html).toContain("Modal spectrum");
    expect(html).toContain("2 mode(s), 2 field payload(s)");
    expect(html).toContain("Branch diagnostics");
    expect(html).toContain("1 branch(es), 2 tracked point(s)");
    expect(html).toContain("Solver model");
    expect(html).toContain("reference_full_2x2_tangent");
    expect(html).toContain("Floquet transport");
    expect(html).toContain("tangent_frame_transport");
    expect(html).toContain("frame mismatch 0; nonunitarity 0");
    expect(html).toContain("Demag-k gate");
    expect(html).toContain("modal ready; response unsupported");
  });

  it("renders dedicated frequency-response diagnostics from progress and sweep resources", () => {
    const selection: Selection = {
      kind: "results.frequency_response.diagnostics",
      label: "Response Diagnostics",
      moduleSource: "explorer",
      nodeId: "results:frequency-response:diagnostics",
      objectId: null,
      ref: {
        kind: "results.frequency_response.diagnostics",
        nodeId: "results:frequency-response:diagnostics",
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyResponseDiagnosticsInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Frequency Response Diagnostics");
    expect(html).toContain("Driven availability");
    expect(html).toContain(
      "frequency_response: ok; driven=true; static_periodic=true; gpu=false",
    );
    expect(html).toContain("Sweep progress");
    expect(html).toContain("unavailable; 0/2");
    expect(html).toContain("Cancel state");
    expect(html).toContain("cancel_requested; 1/4");
    expect(html).toContain("Response fields");
    expect(html).toContain("2 manifest field(s), 1 sweep field(s)");
    expect(html).toContain("Krylov preconditioner");
    expect(html).toContain("graph_demag_coarse");
    expect(html).toContain("mfem_phi_consistency_schur_right");
    expect(html).toContain("Residual coverage");
    expect(html).toContain("0/1 point(s)");
    expect(html).toContain("Response artifact");
    expect(html).toContain("response/magnetic_response_sweep.v2.json");
  });

  it("renders a dedicated frequency-response progress status surface", () => {
    const selection: Selection = {
      kind: "results.frequency_response.progress",
      label: "Progress",
      moduleSource: "explorer",
      nodeId: "results:frequency-response:progress",
      objectId: null,
      ref: {
        kind: "results.frequency_response.progress",
        nodeId: "results:frequency-response:progress",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyResponseProgressInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Response Sweep Progress");
    expect(html).toContain("Status");
    expect(html).toContain("unavailable");
    expect(html).toContain("Progress");
    expect(html).toContain("0/2 frequency points");
    expect(html).toContain("Current frequency");
    expect(html).toContain("not available");
    expect(html).toContain("Partial artifacts");
    expect(html).toContain("no");
    expect(html).toContain("Latest manifest");
    expect(html).toContain("frequency_domain/manifest.v1.json");
    expect(html).toContain("Reason");
    expect(html).toContain("frequency-domain response is unavailable");
  });

  it("renders solver-level frequency-response progress from backend progress json", () => {
    responseProgressFixture.data = {
      complete: false,
      completed_frequency_points: 1,
      current_frequency_hz: 3.0e9,
      demag_mode: "periodic_airbox_k0",
      frequency_max_hz: 5.0e9,
      frequency_min_hz: 2.0e9,
      latest_artifact_manifest_path: "frequency_domain/manifest.partial.v1.json",
      missing_reason: null,
      partial_artifacts_available: true,
      progress_json:
        '{"schema_version":"frequency_domain_sweep_progress.v1","state":"running","native_iteration_count":64,"native_relative_residual_l2_norm":0.0075}',
      schema_version: "frequency_domain_sweep_progress.v1",
      state: "running",
      status: "ready",
      total_frequency_points: 7,
      written_frequency_point_artifacts: 1,
    };
    const selection: Selection = {
      kind: "results.frequency_response.progress",
      label: "Progress",
      moduleSource: "explorer",
      nodeId: "results:frequency-response:progress",
      objectId: null,
      ref: {
        kind: "results.frequency_response.progress",
        nodeId: "results:frequency-response:progress",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyResponseProgressInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Response Sweep Progress");
    expect(html).toContain("1/7 frequency points");
    expect(html).toContain("role=\"progressbar\"");
    expect(html).toContain("aria-valuenow=\"14\"");
    expect(html).toContain("3 GHz");
    expect(html).toContain("Frequency range");
    expect(html).toContain("2 GHz-5 GHz");
    expect(html).toContain("Solver progress");
    expect(html).toContain("periodic_airbox_k0");
    expect(html).toContain("GMRES 64");
    expect(html).toContain("relres 7.500e-3");
  });

  it("shows active native solve progress before the first frequency point is written", () => {
    responseProgressFixture.data = {
      complete: false,
      completed_frequency_points: 0,
      current_frequency_hz: 2.5e9,
      demag_mode: "periodic_airbox_k0",
      frequency_max_hz: 3.0e9,
      frequency_min_hz: 2.5e9,
      latest_artifact_manifest_path: "frequency_domain/manifest.partial.v1.json",
      missing_reason: "production CPU GMRES frequency response did not converge",
      partial_artifacts_available: true,
      progress_json:
        '{"schema_version":"frequency_domain_sweep_progress.v1","state":"solve_error","status":"solve_error","total_frequency_points":3,"completed_frequency_points":0,"current_frequency_hz":2500000000,"frequency_min_hz":2500000000,"frequency_max_hz":3000000000,"demag_mode":"periodic_airbox_k0","native_frequency_index":0,"native_iteration_count":512,"native_max_iterations_for_frequency":512,"native_current_frequency_solve_fraction":1.0,"native_relative_residual_l2_norm":0.4179088861990189}',
      schema_version: "frequency_domain_sweep_progress.v1",
      state: "solve_error",
      status: "solve_error",
      total_frequency_points: 3,
      written_frequency_point_artifacts: 0,
    };

    const html = renderToStaticMarkup(
      <FrequencyResponseProgressInspectorPanel
        selection={{
          kind: "results.frequency_response.progress",
          label: "Progress",
          moduleSource: "explorer",
          nodeId: "results:frequency-response:progress",
          objectId: null,
          ref: {
            kind: "results.frequency_response.progress",
            nodeId: "results:frequency-response:progress",
            resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
            type: "frequency-domain",
          },
        }}
      />,
    );

    expect(html).toContain("Response Sweep Progress");
    expect(html).toContain("0/3 frequency points");
    expect(html).toContain("role=\"progressbar\"");
    expect(html).toContain("aria-valuenow=\"33\"");
    expect(html).toContain("2.5 GHz");
    expect(html).toContain("2.5 GHz-3 GHz");
    expect(html).toContain("periodic_airbox_k0");
    expect(html).toContain("GMRES 512/512");
    expect(html).toContain("relres 4.179e-1");
    expect(html).toContain("production CPU GMRES frequency response did not converge");
  });

  it("renders the frequency-response progress resource from the progress artifact resource", () => {
    responseProgressFixture.data = {
      complete: false,
      completed_frequency_points: 0,
      current_frequency_hz: 2.5e9,
      demag_mode: "periodic_airbox_k0",
      frequency_max_hz: 3.0e9,
      frequency_min_hz: 2.5e9,
      latest_artifact_manifest_path: "frequency_domain/manifest.partial.v1.json",
      missing_reason: "production CPU GMRES frequency response did not converge",
      partial_artifacts_available: true,
      progress_json:
        '{"schema_version":"frequency_domain_sweep_progress.v1","state":"solve_error","status":"solve_error","total_frequency_points":3,"completed_frequency_points":0,"current_frequency_hz":2500000000,"frequency_min_hz":2500000000,"frequency_max_hz":3000000000,"demag_mode":"periodic_airbox_k0","native_frequency_index":0,"native_iteration_count":512,"native_max_iterations_for_frequency":512,"native_current_frequency_solve_fraction":1.0,"native_relative_residual_l2_norm":0.4179088861990189}',
      schema_version: "frequency_domain_sweep_progress.v1",
      state: "solve_error",
      status: "solve_error",
      total_frequency_points: 3,
      written_frequency_point_artifacts: 0,
    };

    const html = renderToStaticMarkup(
      <FrequencyResponseProgressResourceInspectorPanel
        selection={{
          kind: "resources.analysis.frequency_response.progress",
          label: "Progress",
          moduleSource: "explorer",
          nodeId: "resources:analysis:frequency-response:progress",
          objectId: null,
          ref: {
            kind: "resources.analysis.frequency_response.progress",
            nodeId: "resources:analysis:frequency-response:progress",
            type: "frequency-domain",
          },
        }}
      />,
    );

    expect(html).toContain("Frequency Response Progress Resource");
    expect(html).toContain("role=\"progressbar\"");
    expect(html).toContain("aria-valuenow=\"33\"");
    expect(html).toContain("0/3 frequency points");
    expect(html).toContain("Current frequency");
    expect(html).toContain("2.5 GHz");
    expect(html).toContain("Solver progress");
    expect(html).toContain("periodic_airbox_k0");
    expect(html).toContain("GMRES 512/512");
    expect(html).toContain("relres 4.179e-1");
  });

  it("renders COMSOL-style frequency-response progress in the job surface", () => {
    responseProgressFixture.data = {
      complete: false,
      completed_frequency_points: 1,
      current_frequency_hz: 3.0e9,
      demag_mode: "periodic_airbox_k0",
      frequency_max_hz: 5.0e9,
      frequency_min_hz: 2.0e9,
      latest_artifact_manifest_path: "frequency_domain/manifest.partial.v1.json",
      missing_reason: null,
      partial_artifacts_available: true,
      progress_json:
        '{"schema_version":"frequency_domain_sweep_progress.v1","state":"running","native_iteration_count":64,"native_relative_residual_l2_norm":0.0075}',
      schema_version: "frequency_domain_sweep_progress.v1",
      state: "running",
      status: "ready",
      total_frequency_points: 7,
      written_frequency_point_artifacts: 1,
    };

    const html = renderToStaticMarkup(
      <FrequencyResponseProgressJobInspectorPanel
        selection={{
          kind: "jobs.frequency_domain.response_progress",
          label: "Response Progress",
          moduleSource: "explorer",
          nodeId: "jobs:frequency-domain:response-progress",
          objectId: null,
          ref: {
            kind: "jobs.frequency_domain.response_progress",
            nodeId: "jobs:frequency-domain:response-progress",
            type: "frequency-domain",
          },
        }}
      />,
    );

    expect(html).toContain("Response Sweep Progress Job");
    expect(html).toContain("role=\"progressbar\"");
    expect(html).toContain("aria-valuenow=\"14\"");
    expect(html).toContain("1/7 frequency points");
    expect(html).toContain("3 GHz");
    expect(html).toContain("Frequency range");
    expect(html).toContain("2 GHz-5 GHz");
    expect(html).toContain("Solver progress");
    expect(html).toContain("periodic_airbox_k0");
    expect(html).toContain("GMRES 64");
    expect(html).toContain("relres 7.500e-3");
  });

  it("renders a dedicated frequency-response cancel-requested status surface", () => {
    const selection: Selection = {
      kind: "results.frequency_response.cancel_requested",
      label: "Cancel Requested",
      moduleSource: "explorer",
      nodeId: "results:frequency-response:cancel-requested",
      objectId: null,
      ref: {
        kind: "results.frequency_response.cancel_requested",
        nodeId: "results:frequency-response:cancel-requested",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyResponseCancelRequestedInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Response Sweep Cancellation");
    expect(html).toContain("Status");
    expect(html).toContain("cancel_requested");
    expect(html).toContain("Progress");
    expect(html).toContain("1/4 frequency points");
    expect(html).toContain("Current frequency");
    expect(html).toContain("9.5 GHz");
    expect(html).toContain("Frequency range");
    expect(html).toContain("8 GHz-12 GHz");
    expect(html).toContain("Solver progress");
    expect(html).toContain("periodic_airbox_k0");
    expect(html).toContain("GMRES 128");
    expect(html).toContain("relres 1.250e-2");
    expect(html).toContain("Partial artifacts");
    expect(html).toContain("yes");
    expect(html).toContain("Written point artifacts");
    expect(html).toContain("1");
    expect(html).toContain("Latest manifest");
    expect(html).toContain("response/artifact_manifest.json");
  });

  it("renders dedicated frequency-domain job control surfaces", () => {
    const jobsOverviewHtml = renderToStaticMarkup(
      <FrequencyDomainJobsOverviewInspectorPanel
        selection={{
          kind: "jobs.frequency_domain.root",
          label: "Frequency Domain Jobs",
          moduleSource: "explorer",
          nodeId: "jobs:frequency-domain",
          objectId: null,
          ref: {
            kind: "jobs.frequency_domain.root",
            nodeId: "jobs:frequency-domain",
            type: "frequency-domain",
          },
        }}
      />,
    );
    const stageRunHtml = renderToStaticMarkup(
      <FrequencyDomainStageRunJobInspectorPanel
        selection={{
          kind: "jobs.frequency_domain.stage_run",
          label: "Stage Runs",
          moduleSource: "explorer",
          nodeId: "jobs:frequency-domain:stage-run",
          objectId: null,
          ref: {
            kind: "jobs.frequency_domain.stage_run",
            nodeId: "jobs:frequency-domain:stage-run",
            type: "frequency-domain",
          },
        }}
      />,
    );
    const eigenSampleHtml = renderToStaticMarkup(
      <EigenSampleJobInspectorPanel
        selection={{
          kind: "jobs.frequency_domain.eigen_sample",
          label: "Eigen k-Samples",
          moduleSource: "explorer",
          nodeId: "jobs:frequency-domain:eigen-sample",
          objectId: null,
          ref: {
            kind: "jobs.frequency_domain.eigen_sample",
            nodeId: "jobs:frequency-domain:eigen-sample",
            type: "frequency-domain",
          },
        }}
      />,
    );
    const responseFrequencyHtml = renderToStaticMarkup(
      <FrequencyResponseFrequencyJobInspectorPanel
        selection={{
          kind: "jobs.frequency_domain.response_frequency",
          label: "Response Frequencies",
          moduleSource: "explorer",
          nodeId: "jobs:frequency-domain:response-frequency",
          objectId: null,
          ref: {
            kind: "jobs.frequency_domain.response_frequency",
            nodeId: "jobs:frequency-domain:response-frequency",
            type: "frequency-domain",
          },
        }}
      />,
    );
    const responseProgressHtml = renderToStaticMarkup(
      <FrequencyResponseProgressJobInspectorPanel
        selection={{
          kind: "jobs.frequency_domain.response_progress",
          label: "Response Progress",
          moduleSource: "explorer",
          nodeId: "jobs:frequency-domain:response-progress",
          objectId: null,
          ref: {
            kind: "jobs.frequency_domain.response_progress",
            nodeId: "jobs:frequency-domain:response-progress",
            type: "frequency-domain",
          },
        }}
      />,
    );
    const exportHtml = renderToStaticMarkup(
      <FrequencyDomainArtifactExportJobInspectorPanel
        selection={{
          kind: "jobs.frequency_domain.artifact_export",
          label: "Artifact Export",
          moduleSource: "explorer",
          nodeId: "jobs:frequency-domain:artifact-export",
          objectId: null,
          ref: {
            kind: "jobs.frequency_domain.artifact_export",
            nodeId: "jobs:frequency-domain:artifact-export",
            type: "frequency-domain",
          },
        }}
      />,
    );

    expect(jobsOverviewHtml).toContain("Frequency-Domain Job Queue");
    expect(jobsOverviewHtml).toContain("Stage run");
    expect(jobsOverviewHtml).toContain("unavailable; 0/2 frequency points; written 0");
    expect(jobsOverviewHtml).toContain("Cancel checkpoint");
    expect(jobsOverviewHtml).toContain(
      "cancel_requested; 1/4 frequency points; partial artifacts yes",
    );
    expect(stageRunHtml).toContain("Frequency-Domain Stage Run Job");
    expect(stageRunHtml).toContain("Requested stage");
    expect(stageRunHtml).toContain("frequency_response");
    expect(stageRunHtml).toContain("Run handoff");
    expect(stageRunHtml).toContain("publish manifest and stage artifacts");
    expect(eigenSampleHtml).toContain("Eigen k-Sample Job");
    expect(eigenSampleHtml).toContain("k-path samples");
    expect(eigenSampleHtml).toContain("2 point(s)");
    expect(eigenSampleHtml).toContain("Mode fields");
    expect(eigenSampleHtml).toContain("2 field-ready");
    expect(responseFrequencyHtml).toContain("Response Frequency Solve Job");
    expect(responseFrequencyHtml).toContain("Frequency work units");
    expect(responseFrequencyHtml).toContain("1 point(s), 1 observable series");
    expect(responseFrequencyHtml).toContain("Sweep progress");
    expect(responseFrequencyHtml).toContain("unavailable; 0/2 frequency points");
    expect(responseFrequencyHtml).toContain("Cancel checkpoint");
    expect(responseFrequencyHtml).toContain(
      "cancel_requested; 1/4 frequency points",
    );
    expect(responseFrequencyHtml).toContain("Field artifacts");
    expect(responseFrequencyHtml).toContain("2 manifest field(s), 1 sweep field(s)");
    expect(responseProgressHtml).toContain("Response Sweep Progress Job");
    expect(responseProgressHtml).toContain("Progress resource");
    expect(responseProgressHtml).toContain(
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
    );
    expect(responseProgressHtml).toContain("Partial artifacts");
    expect(responseProgressHtml).toContain("Runtime state");
    expect(responseProgressHtml).toContain("unavailable");
    expect(responseProgressHtml).toContain("no");
    expect(exportHtml).toContain("Frequency-Domain Artifact Export Job");
    expect(exportHtml).toContain("Export bundle");
    expect(exportHtml).toContain("manifest + modal artifacts + driven response artifacts");
    expect(exportHtml).toContain("Field payloads");
    expect(exportHtml).toContain("2 response field(s), 2 modal field(s)");
  });

  it("renders dedicated frequency-domain diagnostic surfaces", () => {
    const selection = (kind: string, label: string): Selection => ({
      kind,
      label,
      moduleSource: "explorer",
      nodeId: `diagnostics:${kind}`,
      objectId: null,
      ref: {
        kind,
        nodeId: `diagnostics:${kind}`,
        type: "frequency-domain",
      },
    });
    const overviewHtml = renderToStaticMarkup(
      <FrequencyDomainDiagnosticsOverviewInspectorPanel
        selection={selection(
          "diagnostics.frequency_domain.root",
          "Frequency Domain Diagnostics",
        )}
      />,
    );
    const capabilitiesHtml = renderToStaticMarkup(
      <FrequencyDomainCapabilitiesDiagnosticInspectorPanel
        selection={selection(
          "diagnostics.frequency_domain.capabilities",
          "Capabilities",
        )}
      />,
    );
    const equilibriumHtml = renderToStaticMarkup(
      <FrequencyDomainEquilibriumDiagnosticInspectorPanel
        selection={selection(
          "diagnostics.frequency_domain.equilibrium",
          "Equilibrium",
        )}
      />,
    );
    const operatorHtml = renderToStaticMarkup(
      <FrequencyDomainOperatorDiagnosticInspectorPanel
        selection={selection("diagnostics.frequency_domain.operator", "Operator")}
      />,
    );
    const solverHtml = renderToStaticMarkup(
      <FrequencyDomainSolverDiagnosticInspectorPanel
        selection={selection("diagnostics.frequency_domain.solver", "Solver")}
      />,
    );
    const artifactsHtml = renderToStaticMarkup(
      <FrequencyDomainArtifactsDiagnosticInspectorPanel
        selection={selection("diagnostics.frequency_domain.artifacts", "Artifacts")}
      />,
    );
    const apiHtml = renderToStaticMarkup(
      <FrequencyDomainApiResourcesDiagnosticInspectorPanel
        selection={selection(
          "diagnostics.frequency_domain.api_resources",
          "API Resources",
        )}
      />,
    );
    const visualizationHtml = renderToStaticMarkup(
      <FrequencyDomainVisualizationDiagnosticInspectorPanel
        selection={selection(
          "diagnostics.frequency_domain.visualization",
          "Visualization",
        )}
      />,
    );

    expect(overviewHtml).toContain("Frequency-Domain Diagnostics Overview");
    expect(overviewHtml).toContain("Capability gates");
    expect(overviewHtml).toContain("modal ready; response unsupported");
    expect(overviewHtml).toContain("Artifacts");
    expect(overviewHtml).toContain("manifest + modal artifacts + driven response artifacts");
    expect(capabilitiesHtml).toContain("Frequency-Domain Capability Diagnostics");
    expect(capabilitiesHtml).toContain("Modal lane");
    expect(capabilitiesHtml).toContain("reference_cpu: ready");
    expect(capabilitiesHtml).toContain("Driven lane");
    expect(capabilitiesHtml).toContain("magnetic_cpu: partial_production_executable");
    expect(capabilitiesHtml).toContain("Boundary gates");
    expect(capabilitiesHtml).toContain("floquet_modal: ready; floquet_response: unsupported");
    expect(equilibriumHtml).toContain("Frequency-Domain Equilibrium Diagnostics");
    expect(equilibriumHtml).toContain("Equilibrium source");
    expect(equilibriumHtml).toContain("stage://equilibrium/m0");
    expect(equilibriumHtml).toContain("Response readiness");
    expect(equilibriumHtml).toContain("static_periodic=true");
    expect(operatorHtml).toContain("Frequency-Domain Operator Diagnostics");
    expect(operatorHtml).toContain("Operator family");
    expect(operatorHtml).toContain("linearized LLG tangent operator");
    expect(operatorHtml).toContain("Demag-k gate");
    expect(operatorHtml).toContain("unsupported");
    expect(solverHtml).toContain("Frequency-Domain Solver Diagnostics");
    expect(solverHtml).toContain("Response residuals");
    expect(solverHtml).toContain("0/1 point(s)");
    expect(solverHtml).toContain("Execution lane");
    expect(solverHtml).toContain(
      "native_fem_mfem_frequency_domain_cpu; response=ok",
    );
    expect(solverHtml).toContain("Modal transport");
    expect(solverHtml).toContain(
      "reference_full_2x2_tangent; tangent_frame_transport; frame mismatch 0; nonunitarity 0",
    );
    expect(solverHtml).toContain("Production CPU gate");
    expect(solverHtml).toContain(
      "production_cpu_modal_nonzero_k_floquet_operator_missing; selected_spectrum_nonzero_k_floquet_modal",
    );
    expect(artifactsHtml).toContain("Frequency-Domain Artifact Diagnostics");
    expect(artifactsHtml).toContain("Manifest");
    expect(artifactsHtml).toContain("frequency_domain/manifest.v1.json");
    expect(artifactsHtml).toContain("Field payloads");
    expect(artifactsHtml).toContain("2 response field(s), 2 modal field(s)");
    expect(apiHtml).toContain("Frequency-Domain API Resource Diagnostics");
    expect(apiHtml).toContain("Manifest endpoint");
    expect(apiHtml).toContain(ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH);
    expect(apiHtml).toContain("Response progress endpoint");
    expect(apiHtml).toContain(ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH);
    expect(visualizationHtml).toContain("Frequency-Domain Visualization Diagnostics");
    expect(visualizationHtml).toContain("Mode fields");
    expect(visualizationHtml).toContain("2 mode field payload(s)");
    expect(visualizationHtml).toContain("Response fields");
    expect(visualizationHtml).toContain("2 response field artifact(s)");
  });

  it("renders a DMI boundary warning alert when reported in diagnostics", () => {
    mockManifestDiagnostics = [
      {
        id: "frequency_domain.dmi_boundary_condition_uncertain",
        severity: "warning",
        message: "Frequency-domain DMI boundary conditions are not yet fully resolved."
      }
    ];

    const html = renderToStaticMarkup(
      <FrequencyDomainOperatorDiagnosticInspectorPanel
        selection={{
          kind: "diagnostics.frequency_domain.operator",
          label: "Operator",
          moduleSource: "explorer",
          nodeId: "diagnostics:frequency-domain:operator",
          objectId: null,
          ref: null,
        }}
      />
    );

    expect(html).toContain("DMI BC uncertain");
    expect(html).toContain("Frequency-domain DMI boundary conditions are not yet fully resolved.");
    expect(html).toContain("frequency_domain.dmi_boundary_condition_uncertain");

    // Clean up
    mockManifestDiagnostics = [];
  });

  it("reports accepted production CPU modal k-path diagnostics without a stale rejection reason", () => {
    eigenDiagnosticsFixture.payload = {
      basis_transport_policy: "tangent_frame_identity",
      execution_lane: "production_cpu",
      floquet_tangent_frame_max_mismatch: 0,
      floquet_tangent_transport_max_nonunitarity: 0,
      phasor_convention: "exp_i_omega_t",
      production_solver_available: true,
      sample_count: 4,
      schema_version: "frequency_domain_eigen_diagnostics.v2",
      solver_adapter: "slepc_modal_eigen",
      solver_model: "slepc_multi_shift_invert_production_cpu_dense",
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainSolverDiagnosticInspectorPanel
        selection={{
          kind: "diagnostics.frequency_domain.solver",
          label: "Solver",
          moduleSource: "explorer",
          nodeId: "diagnostics:frequency-domain:solver",
          objectId: null,
          ref: {
            kind: "diagnostics.frequency_domain.solver",
            nodeId: "diagnostics:frequency-domain:solver",
            type: "frequency-domain",
          },
        }}
      />,
    );

    expect(html).toContain("Production CPU gate");
    expect(html).toContain(
      "accepted production_cpu selected-spectrum modal k-path; adapter slepc_modal_eigen; sample_count 4",
    );
    expect(html).not.toContain(
      "production_cpu_modal_nonzero_k_floquet_operator_missing",
    );
  });

  it("marks frequency-domain visualization diagnostics degraded when field artifacts are missing", () => {
    expect(
      frequencyDomainVisualizationReadiness({
        modeFieldCount: 0,
        responseFieldCount: 0,
      }),
    ).toBe("field artifacts missing");
    expect(
      frequencyDomainVisualizationReadiness({
        modeFieldCount: 2,
        responseFieldCount: 0,
      }),
    ).toBe("response fields missing");
    expect(
      frequencyDomainVisualizationReadiness({
        modeFieldCount: 0,
        responseFieldCount: 2,
      }),
    ).toBe("mode fields missing");
    expect(
      frequencyDomainVisualizationReadiness({
        modeFieldCount: 2,
        responseFieldCount: 2,
      }),
    ).toBe("3D ready");
  });

  it("renders dedicated frequency-domain resource inspector surfaces", () => {
    const selection = (kind: string, label: string): Selection => ({
      kind,
      label,
      moduleSource: "explorer",
      nodeId: `resources:${kind}`,
      objectId: null,
      ref: {
        kind,
        nodeId: `resources:${kind}`,
        type: "frequency-domain",
      },
    });

    const familyHtml = renderToStaticMarkup(
      <FrequencyDomainResourceFamilyInspectorPanel
        selection={selection(
          "resources.analysis.frequency_domain",
          "Frequency Domain Resources",
        )}
      />,
    );
    const manifestHtml = renderToStaticMarkup(
      <FrequencyDomainManifestResourceInspectorPanel
        selection={selection(
          "resources.analysis.frequency_domain.manifest",
          "Manifest",
        )}
      />,
    );
    const spectrumHtml = renderToStaticMarkup(
      <EigenSpectrumResourceInspectorPanel
        selection={selection("resources.analysis.eigen.spectrum", "Spectrum")}
      />,
    );
    const modeFieldHtml = renderToStaticMarkup(
      <EigenModeFieldResourceInspectorPanel
        selection={selection("resources.analysis.eigen.mode_field", "Mode Field")}
      />,
    );
    const sweepHtml = renderToStaticMarkup(
      <FrequencyResponseSweepResourceInspectorPanel
        selection={selection(
          "resources.analysis.frequency_response.sweep",
          "Response Sweep",
        )}
      />,
    );
    const progressHtml = renderToStaticMarkup(
      <FrequencyResponseProgressResourceInspectorPanel
        selection={selection(
          "resources.analysis.frequency_response.progress",
          "Progress",
        )}
      />,
    );
    const fieldHtml = renderToStaticMarkup(
      <FrequencyResponseFieldResourceInspectorPanel
        selection={selection(
          "resources.analysis.frequency_response.field",
          "Response Field",
        )}
      />,
    );

    expect(familyHtml).toContain("Frequency-Domain Resource Family");
    expect(familyHtml).toContain("Manifest resource");
    expect(familyHtml).toContain(ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH);
    expect(familyHtml).toContain("Available resources");
    expect(familyHtml).toContain("modal spectrum, branches, dispersion, response sweep");
    expect(manifestHtml).toContain("Frequency-Domain Manifest Resource");
    expect(manifestHtml).toContain("Schema");
    expect(manifestHtml).toContain("frequency_domain_manifest.v1");
    expect(manifestHtml).toContain("Physics contract");
    expect(manifestHtml).toContain("unit_l2; exp_minus_i_omega_t; Hz");
    expect(spectrumHtml).toContain("Eigen Spectrum Resource");
    expect(spectrumHtml).toContain("Resource endpoint");
    expect(spectrumHtml).toContain(ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH);
    expect(spectrumHtml).toContain("Mode rows");
    expect(spectrumHtml).toContain("2 mode(s), 2 field payload(s)");
    expect(modeFieldHtml).toContain("Eigen Mode Field Resource");
    expect(modeFieldHtml).toContain("Field payload contract");
    expect(modeFieldHtml).toContain("phase-rotated real / real / imag / abs / phase");
    expect(modeFieldHtml).toContain("Mode fields");
    expect(modeFieldHtml).toContain("2 field-ready");
    expect(sweepHtml).toContain("Frequency Response Sweep Resource");
    expect(sweepHtml).toContain("Sweep endpoint");
    expect(sweepHtml).toContain(ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH);
    expect(sweepHtml).toContain("Frequency points");
    expect(sweepHtml).toContain("1 point(s), 1 observable series");
    expect(progressHtml).toContain("Frequency Response Progress Resource");
    expect(progressHtml).toContain("Progress endpoint");
    expect(progressHtml).toContain(ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH);
    expect(progressHtml).toContain("role=\"progressbar\"");
    expect(progressHtml).toContain("aria-valuenow=\"0\"");
    expect(progressHtml).toContain("Status");
    expect(progressHtml).toContain("unavailable");
    expect(progressHtml).toContain("Progress");
    expect(progressHtml).toContain("0/2 frequency points");
    expect(progressHtml).toContain("Current frequency");
    expect(progressHtml).toContain("not available");
    expect(fieldHtml).toContain("Frequency Response Field Resource");
    expect(fieldHtml).toContain("Field endpoint");
    expect(fieldHtml).toContain(ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH);
    expect(fieldHtml).toContain("Response fields");
    expect(fieldHtml).toContain("2 manifest field(s), 1 sweep field(s)");
  });

  it("renders dedicated remaining frequency-domain wrapper replacement surfaces", () => {
    const selection = (kind: string, label: string): Selection => ({
      kind,
      label,
      moduleSource: "explorer",
      nodeId: `node:${kind}`,
      objectId: null,
      ref: {
        kind,
        nodeId: `node:${kind}`,
        type: "frequency-domain",
      },
    });

    const eigenDispersionHtml = renderToStaticMarkup(
      <EigenDispersionInspectorPanel
        selection={selection("results.eigen.dispersion", "Eigen Dispersion")}
      />,
    );
    const observablesHtml = renderToStaticMarkup(
      <FrequencyResponseObservablesInspectorPanel
        selection={selection(
          "results.frequency_response.observables",
          "Observables",
        )}
      />,
    );
    const periodicResourceHtml = renderToStaticMarkup(
      <FrequencyDomainPeriodicPairsResourceInspectorPanel
        selection={selection("resources.mesh.periodic_pairs", "Periodic Pairs")}
      />,
    );
    const periodicDiagnosticHtml = renderToStaticMarkup(
      <FrequencyDomainPeriodicFloquetDiagnosticInspectorPanel
        selection={selection(
          "diagnostics.frequency_domain.periodic_floquet",
          "Periodic/Floquet",
        )}
      />,
    );

    expect(eigenDispersionHtml).toContain("Eigen Dispersion Inspector");
    expect(eigenDispersionHtml).toContain("Dispersion resource");
    expect(eigenDispersionHtml).toContain(ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH);
    expect(eigenDispersionHtml).toContain("Path metadata artifact");
    expect(eigenDispersionHtml).toContain("eigen/dispersion/path.json");
    expect(eigenDispersionHtml).toContain("Analytic reference");
    expect(eigenDispersionHtml).toContain("2 point(s); backward_volume, damon_eshbach; max rel. error 0.005291");
    expect(eigenDispersionHtml).toContain("Branch tracking");
    expect(eigenDispersionHtml).toContain("1 branch(es), 2 tracked point(s)");
    expect(observablesHtml).toContain("Frequency Response Observables");
    expect(observablesHtml).toContain("Observable series");
    expect(observablesHtml).toContain("1 series: Amplitude");
    expect(observablesHtml).toContain("Field payloads");
    expect(observablesHtml).toContain("1/1 point(s) field-ready");
    expect(periodicResourceHtml).toContain("Periodic/Floquet Pair Resource");
    expect(periodicResourceHtml).toContain("valid");
    expect(periodicResourceHtml).toContain("Pair count");
    expect(periodicResourceHtml).toContain("1 pair(s)");
    expect(periodicResourceHtml).toContain("x-periodic");
    expect(periodicDiagnosticHtml).toContain("Periodic/Floquet Diagnostics");
    expect(periodicDiagnosticHtml).toContain("Floquet gate");
    expect(periodicDiagnosticHtml).toContain("modal ready; response unsupported");
    expect(periodicDiagnosticHtml).toContain("Dynamic demag-k");
    expect(periodicDiagnosticHtml).toContain("unsupported");
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
    expect(html).toContain("9.5 GHz");
  });

  it("renders a dedicated FMR peaks control surface", () => {
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
      <FmrPeaksInspectorPanel selection={selection} />,
    );

    expect(html).toContain("FMR Peak Control");
    expect(html).toContain("Peak workflow");
    expect(html).toContain(
      "select peak -&gt; compare modal/driven provenance -&gt; plot field",
    );
    expect(html).toContain("Peak rows");
    expect(html).toContain("3 total, 2 modal, 1 driven");
    expect(html).toContain("Overlay-ready peaks");
    expect(html).toContain("3 with field artifacts");
    expect(html).toContain("First peak");
    expect(html).toContain("modal, 9.5 GHz");
    expect(html).toContain("Comparison state");
    expect(html).toContain("modal and driven peaks available");
    expect(html).toContain("Nearest modal-driven detuning");
    expect(html).toContain("0 Hz driven-modal; modal 9.5 GHz, driven 9.5 GHz");
    expect(html).toContain("Quality factor coverage");
    expect(html).toContain("0/3 peak(s)");
    expect(html).toContain("FMR Peak Browser");
    expect(html).toContain("Modal eigenmode");
    expect(html).toContain("Driven response");
    expect(html).toContain("Target");
    expect(html).toContain("Power density");
    expect(html).toContain("3D field");
    expect(html).toContain("field-ready");
    expect(html).toContain("mode field ready; driven field ready");
    expect(html).toContain("Frequency-domain FMR peak table");
    expect(html).toContain("<th>Q factor</th>");
    expect(html).toContain("Mode / point");
    expect(html).toContain("Plot 3D");
    expect(html).toContain("FMR Modal-Driven Difference Table");
    expect(html).toContain("Frequency-domain FMR comparison table");
    expect(html).toContain("Field handoff");
  });

  it("renders a dedicated single FMR peak detail surface", () => {
    const selection: Selection = {
      kind: "results.frequency_domain.fmr_peak",
      label: "Modal Peak 1",
      moduleSource: "explorer",
      nodeId: "results:frequency-domain:fmr:peaks:peak:0",
      objectId: null,
      ref: {
        fmrPeakIndex: 0,
        kind: "results.frequency_domain.fmr_peak",
        nodeId: "results:frequency-domain:fmr:peaks:peak:0",
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FmrPeakInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Identity");
    expect(html).toContain("Physical Quantities");
    expect(html).toContain("Provenance");
    expect(html).toContain("Visualization");
    expect(html).toContain("Diagnostics");
    expect(html).toContain("Physical source");
    expect(html).toContain("modal eigenmode");
    expect(html).toContain("Frequency");
    expect(html).toContain("9.5 GHz");
    expect(html).toContain("Canonical target");
    expect(html).toContain("sample 0, mode 1");
    expect(html).toContain("Field ID");
    expect(html).toContain("analysis:eigen:sample-0000:mode-0001");
    expect(html).toContain("Plot readiness");
    expect(html).toContain(
      "field id is published; plot command can use the linked field id",
    );
    expect(html).toContain("Display controls");
    expect(html).toContain("Volume controls");
    expect(html).toContain("Missing values");
    expect(html).toContain("amplitude, absorbed power, phase, linewidth");
    expect(html).toContain("Validation");
    expect(html).toContain("unavailable");
    expect(html).toContain("Source surface");
    expect(html).toContain("Open source result");
    expect(html).toContain("Open linked mode inspector");
    expect(html).toContain("Plot linked field in 3D");
    expect(html).not.toContain("FMR Peak Workbench");
    expect(html).not.toContain("Peak Observables");
    expect(html).not.toContain("Data-plane resource");
    expect(html).not.toContain("Selection kind");
    expect(html).not.toContain("Node ID");
    expect(html).not.toContain("Selected Field Metadata");
    expect(html).not.toContain("Value kind");
    expect(html).not.toContain("Unknown Frequency-Domain");
  });

  it("groups single FMR peak details by product sections and hides transport internals", () => {
    const selection: Selection = {
      kind: "results.frequency_domain.fmr_peak",
      label: "Modal Peak 1",
      moduleSource: "explorer",
      nodeId: "results:frequency-domain:fmr:peaks:peak:0",
      objectId: null,
      ref: {
        fmrPeakIndex: 0,
        kind: "results.frequency_domain.fmr_peak",
        nodeId: "results:frequency-domain:fmr:peaks:peak:0",
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FmrPeakInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Identity");
    expect(html).toContain("Physical Quantities");
    expect(html).toContain("Provenance");
    expect(html).toContain("Visualization");
    expect(html).toContain("Diagnostics");
    expect(html).toContain("Physical source");
    expect(html).toContain("modal eigenmode");
    expect(html).toContain("Frequency");
    expect(html).toContain("9.5 GHz");
    expect(html).toContain("Amplitude");
    expect(html).toContain("Absorbed power density");
    expect(html).toContain("Field ID");
    expect(html).toContain("Plot linked field in 3D");
    expect(html).not.toContain("FMR Peak Workbench");
    expect(html).not.toContain("Peak Observables");
    expect(html).not.toContain("Visualization Handoff");
    expect(html).not.toContain("Resource Provenance");
    expect(html).not.toContain("Data-plane resource");
    expect(html).not.toContain("Selection kind");
    expect(html).not.toContain("Node ID");
  });

  it("renders a dedicated FMR modal spectrum control surface", () => {
    const selection: Selection = {
      kind: "results.frequency_domain.fmr_modal_spectrum",
      label: "FMR Modal Spectrum",
      moduleSource: "explorer",
      nodeId: "results:frequency-domain:fmr:modal-spectrum",
      objectId: null,
      ref: {
        kind: "results.frequency_domain.fmr_modal_spectrum",
        nodeId: "results:frequency-domain:fmr:modal-spectrum",
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FmrModalSpectrumInspectorPanel selection={selection} />,
    );

    expect(html).toContain("FMR Modal Spectrum Control");
    expect(html).toContain("Mode workflow");
    expect(html).toContain(
      "modal k=0 eigenmodes -&gt; resonances -&gt; 3D mode field",
    );
    expect(html).toContain("Spectrum resource");
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH);
    expect(html).toContain("Mode rows");
    expect(html).toContain("2 modes, 2 3D fields");
    expect(html).toContain("Frequency span");
    expect(html).toContain("9.5 GHz-12 GHz");
    expect(html).toContain("Primary resonance");
    expect(html).toContain("mode 1 at 9.5 GHz");
    expect(html).toContain("Residual coverage");
    expect(html).toContain("0/2 mode(s)");
    expect(html).toContain("Damping coverage");
    expect(html).toContain("0/2 mode(s)");
    expect(html).toContain("Field readiness");
    expect(html).toContain("mode fields available");
    expect(html).toContain("Visualization style scope");
    expect(html).toContain(
      "shared across all FMR modes; selecting a mode changes field data only",
    );
    expect(html).toContain("Chart route");
    expect(html).toContain("fmr_modal -&gt; eigen-spectrum");
    expect(html).toContain("Capability summary");
    expect(html).toContain("reference_cpu: ready; magnetic_cpu: partial_production_executable");
    expect(html).toContain("FMR / eigen modal spectrum");
    expect(html).toContain('data-renderer="echarts"');
    expect(html).toContain("FMR Resonance Browser");
    expect(html).toContain("sample 0, mode 1");
    expect(html).toContain("sample 0, mode 2");
    expect(html).toContain("Imag frequency");
    expect(html).toContain("Damping rate");
    expect(html).toContain("Tangent leakage");
    expect(html).toContain("Mode field");
    expect(html).toContain("field-ready");
    expect(html).toContain("Inspect");
    expect(html).toContain("mode 1: 9.5 GHz");
    expect(html).toContain("mode 2: 12 GHz");
    expect(html).toContain("3D ready");
    expect(html).toContain("Frequency-domain mode table");
    expect(html).toContain("Plot this eigen mode with phase-rotated real display");
    expect(html).toContain("Plot the real part of this eigen mode");
    expect(html).toContain("Plot the imaginary part of this eigen mode");
    expect(html).not.toContain("Selected Field Metadata");
  });

  it("renders a dedicated eigen spectrum control surface", () => {
    const selection: Selection = {
      kind: "results.eigen.spectrum",
      label: "Eigen Spectrum",
      moduleSource: "explorer",
      nodeId: "results:eigen:spectrum",
      objectId: null,
      ref: {
        kind: "results.eigen.spectrum",
        nodeId: "results:eigen:spectrum",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <EigenSpectrumInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Eigen Spectrum Workbench");
    expect(html).toContain("Canonical object");
    expect(html).toContain("StudyIR::Eigenmodes spectrum");
    expect(html).toContain("Spectrum resource");
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH);
    expect(html).toContain("Mode rows");
    expect(html).toContain("2 mode(s), 2 field payload(s)");
    expect(html).toContain("Frequency range");
    expect(html).toContain("9.5 GHz-12 GHz");
    expect(html).toContain("Primary mode");
    expect(html).toContain("mode 1 at 9.5 GHz");
    expect(html).toContain("Damping coverage");
    expect(html).toContain("0/2 mode(s)");
    expect(html).toContain("Residual coverage");
    expect(html).toContain("0/2 mode(s)");
    expect(html).toContain("3D workflow");
    expect(html).toContain("select mode -&gt; plot phase-rotated real field");
    expect(html).toContain("Capability summary");
    expect(html).toContain("reference_cpu: ready; mode_field_payload: ready");
    expect(html).toContain("Frequency-domain mode table");
  });

  it("renders a dedicated eigen modes browser control surface", () => {
    const selection: Selection = {
      kind: "results.eigen.modes",
      label: "Modes",
      moduleSource: "explorer",
      nodeId: "results:eigen:modes",
      objectId: null,
      ref: {
        kind: "results.eigen.modes",
        nodeId: "results:eigen:modes",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <EigenModesInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Eigen Modes Browser");
    expect(html).toContain("Canonical collection");
    expect(html).toContain("mode rows from StudyIR::Eigenmodes spectrum");
    expect(html).toContain("Mode table resource");
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH);
    expect(html).toContain("Mode table");
    expect(html).toContain("2 mode(s), 2 field-ready");
    expect(html).toContain("Frequency range");
    expect(html).toContain("9.5 GHz-12 GHz");
    expect(html).toContain("Default 3D action");
    expect(html).toContain("plot phase-rotated real view");
    expect(html).toContain("First selectable mode");
    expect(html).toContain("sample 0, mode 1, 9.5 GHz");
    expect(html).toContain("Selection payload");
    expect(html).toContain("modeIndex + sampleIndex + fieldId");
    expect(html).toContain("Capability summary");
    expect(html).toContain("mode_table: ready; mode_3d_overlay: ready");
    expect(html).toContain("Eigen Mode Browser");
    expect(html).toContain("Frequency-domain mode table");
  });

  it("renders a dedicated FMR workbench control surface", () => {
    const selection: Selection = {
      kind: "results.frequency_domain.fmr",
      label: "FMR",
      moduleSource: "explorer",
      nodeId: "results:frequency-domain:fmr",
      objectId: null,
      ref: {
        calculationMode: "fmr_response",
        kind: "results.frequency_domain.fmr",
        nodeId: "results:frequency-domain:fmr",
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FmrOverviewInspectorPanel selection={selection} />,
    );

    expect(html).toContain("FMR Workbench");
    expect(html).toContain("Canonical workflows");
    expect(html).toContain(
      "Eigenmodes modal FMR + FrequencyResponse driven FMR",
    );
    expect(html).toContain("Active chart route");
    expect(html).toContain("fmr_response -&gt; response-sweep");
    expect(html).toContain("Modal spectrum");
    expect(html).toContain("2 mode(s), 2 field-ready");
    expect(html).toContain("Driven sweep");
    expect(html).toContain("1 frequency point(s), 1 observable series");
    expect(html).toContain("Peak comparison");
    expect(html).toContain(
      "2 modal peak(s), 1 driven peak(s); modal and driven peaks available",
    );
    expect(html).toContain("Nearest modal-driven detuning");
    expect(html).toContain("0 Hz driven-modal; modal 9.5 GHz, driven 9.5 GHz");
    expect(html).toContain("3D visualization");
    expect(html).toContain("2 mode field(s), 2 response field(s)");
    expect(html).toContain("Capability summary");
    expect(html).toContain(
      "reference_cpu: ready; magnetic_cpu: partial_production_executable",
    );
    expect(html).toContain("Resources");
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH);
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH);
    expect(html).toContain("FMR workflow actions");
    expect(html).toContain("Open modal spectrum");
    expect(html).toContain("Open response sweep");
    expect(html).toContain("Open FMR peaks");
    expect(html).toContain("Open modal-vs-driven comparison");
    expect(html).toContain("FMR Modal Spectrum Preview");
    expect(html).toContain("FMR / eigen modal spectrum");
    expect(html).toContain("mode 1: 9.5 GHz");
    expect(html).toContain("FMR Driven Response Preview");
    expect(html).toContain("Driven FMR frequency response");
    expect(html).toContain("mx: 9.5 GHz");
    expect(html).toContain("FMR Peak Snapshot");
    expect(html).toContain("Frequency-domain FMR peak table");
    expect(html).toContain("FMR Modal-Driven Comparison Snapshot");
    expect(html).toContain("Frequency-domain FMR comparison table");
    expect(html).not.toContain("FMR Result");
    expect(html).not.toContain("Selected Field Metadata");
  });

  it("renders a dedicated frequency-domain response-map gate surface", () => {
    const selection: Selection = {
      kind: "results.frequency_domain.response_map",
      label: "Response Map",
      moduleSource: "explorer",
      nodeId: "results:frequency-domain:calculation-modes:response-map",
      objectId: null,
      ref: {
        calculationMode: "response_map",
        kind: "results.frequency_domain.response_map",
        nodeId: "results:frequency-domain:calculation-modes:response-map",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainResponseMapInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Response Map Control");
    expect(html).toContain("Canonical workflow");
    expect(html).toContain("nonzero-k FrequencyResponse response map");
    expect(html).toContain("Manifest resource");
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH);
    expect(html).toContain("Capability gate");
    expect(html).toContain(
      "floquet_response: unsupported; nonzero-k response unavailable",
    );
    expect(html).toContain("Response-map availability");
    expect(html).toContain("unsupported");
    expect(html).toContain("Floquet request");
    expect(html).toContain("kind=floquet; k=[7.854e+7, 0, 0] rad/m");
    expect(html).toContain("Blocking physics");
    expect(html).toContain("dynamic_demag_k: unsupported");
    expect(html).toContain("Current response evidence");
    expect(html).toContain("1 point(s), 2 response field(s)");
    expect(html).toContain("UI fallback");
    expect(html).toContain("show FMR response sweep until nonzero-k map is executable");
    expect(html).toContain("Response Map");
  });

  it("renders a dedicated FMR modal-vs-driven comparison surface", () => {
    const selection: Selection = {
      kind: "results.frequency_domain.comparison",
      label: "Modal vs Driven Comparison",
      moduleSource: "explorer",
      nodeId: "results:frequency-domain:comparison",
      objectId: null,
      ref: {
        kind: "results.frequency_domain.comparison",
        nodeId: "results:frequency-domain:comparison",
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FmrComparisonInspectorPanel selection={selection} />,
    );

    expect(html).toContain("FMR Modal vs Driven Comparison");
    expect(html).toContain("Canonical comparison");
    expect(html).toContain("Eigenmodes resonance vs FrequencyResponse peak");
    expect(html).toContain("Comparison readiness");
    expect(html).toContain("modal and driven peaks available");
    expect(html).toContain("Modal resonance");
    expect(html).toContain("9.5 GHz; mode 1");
    expect(html).toContain("Driven peak");
    expect(html).toContain("9.5 GHz; amplitude 1.500");
    expect(html).toContain("Frequency offset");
    expect(html).toContain("0 Hz (0 Hz)");
    expect(html).toContain("Peak amplitude ratio");
    expect(html).toContain("not available");
    expect(html).toContain("Spatial overlap (eta_j)");
    expect(html).toContain("degraded (field payload missing; request link)");
    expect(html).toContain("Modal field");
    expect(html).toContain("analysis:eigen:sample-0000:mode-0001; mode field ready");
    expect(html).toContain("Driven field");
    expect(html).toContain("analysis:frequency-response:frequency-0000; response field ready");
    expect(html).toContain("Validation state");
    expect(html).toContain("unavailable modal, unavailable driven");
    expect(html).toContain("FMR Comparison Browser");
    expect(html).toContain("modal-driven detuning");
    expect(html).toContain("Modal field");
    expect(html).toContain("Driven field");
    expect(html).toContain("field-ready");
    expect(html).toContain("mode field ready; driven field ready");
    expect(html).toContain("Amplitude ratio");
    expect(html).toContain("Field handoff");
    expect(html).toContain("Plot modal");
    expect(html).toContain("Plot driven");
    expect(html).toContain("FMR Modal-Driven Pair Table");
    expect(html).toContain("Frequency-domain FMR comparison table");
    expect(html).toContain("<th>Modal</th>");
    expect(html).toContain("<th>Driven</th>");
    expect(html).toContain("<th>Detuning</th>");
    expect(html).toContain("<th>Field handoff</th>");
    expect(html).toContain("<td>mode 1 @ 9.5 GHz</td>");
    expect(html).toContain("<td>response @ 9.5 GHz</td>");
    expect(html).toContain("<td>0 Hz</td>");
    expect(html).toContain("mode field ready; driven field ready");
    expect(html).toContain("Resources");
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH);
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH);
    expect(html).toContain("FMR Comparison Actions");
    expect(html).toContain("both fields ready");
    expect(html).toContain("Modal target");
    expect(html).toContain("modal mode 1 9.5 GHz");
    expect(html).toContain("Driven target");
    expect(html).toContain("driven response 9.5 GHz");
    expect(html).toContain("Open modal mode");
    expect(html).toContain("Open driven point");
    expect(html).toContain("Plot modal field");
    expect(html).toContain("Plot driven field");
    expect(html).toContain('title="Plot the driven comparison field in 3D"');
    expect(html).not.toMatch(
      /disabled="" title="Plot the modal comparison field in 3D"/,
    );
    expect(html).not.toContain("Selected Field Metadata");
  });

  it("renders a dedicated frequency-domain dispersion control surface", () => {
    const selection: Selection = {
      kind: "results.frequency_domain.dispersion",
      label: "Dispersion",
      moduleSource: "explorer",
      nodeId: "results:frequency-domain:dispersion",
      objectId: null,
      ref: {
        calculationMode: "dispersion_modal",
        kind: "results.frequency_domain.dispersion",
        nodeId: "results:frequency-domain:dispersion",
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainDispersionInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Frequency-Domain Dispersion Workbench");
    expect(html).toContain("Canonical workflow");
    expect(html).toContain("dispersion_modal -&gt; StudyIR::Eigenmodes");
    expect(html).toContain("Dispersion resource");
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH);
    expect(html).toContain("Dispersion points");
    expect(html).toContain("2 point(s), 2 series");
    expect(html).toContain("Analytic reference");
    expect(html).toContain("2 point(s); backward_volume, damon_eshbach; max rel. error 0.005291");
    expect(html).toContain("Frequency range");
    expect(html).toContain("9.5 GHz-12 GHz");
    expect(html).toContain("k-path span");
    expect(html).toContain("0-7.854e+7 rad/m");
    expect(html).toContain("Branch tracking");
    expect(html).toContain("1 branch(es), 2 tracked point(s)");
    expect(html).toContain("Primary branch");
    expect(html).toContain("acoustic; 12.5 GHz-13.1 GHz");
    expect(html).toContain("Modal fields");
    expect(html).toContain("2 mode field(s) available from modal spectrum");
    expect(html).toContain("Capability summary");
    expect(html).toContain(
      "reference_cpu: reference_executable; production_cpu: partial_production_executable; production_cpu_gamma_k_path: partial_production_executable; production_gpu: unsupported; k_path: reference_executable; branch_tracking: reference_executable",
    );
    expect(html).toContain("Floquet gate");
    expect(html).toContain("modal ready; response unsupported");
    expect(html).toContain("Dispersion Chart");
    expect(html).toContain("Frequency-domain branch table");
    expect(html).toContain("Select branch branch-0 for inspector controls");
    expect(html).toContain("lucide lucide-eye");
  });

  it("renders a dedicated eigen branches table surface", () => {
    const selection: Selection = {
      kind: "results.eigen.branches",
      label: "Branches",
      moduleSource: "explorer",
      nodeId: "results:eigen:branches",
      objectId: null,
      ref: {
        kind: "results.eigen.branches",
        nodeId: "results:eigen:branches",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <EigenBranchesInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Eigen Branch Table");
    expect(html).toContain("Branch resource");
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH);
    expect(html).toContain("Branch count");
    expect(html).toContain("1 branch(es), 2 tracked point(s)");
    expect(html).toContain("Primary branch");
    expect(html).toContain("acoustic; 12.5 GHz-13.1 GHz");
    expect(html).toContain("Overlap quality");
    expect(html).toContain("mean overlap 0.97; lowest overlap 0.97; min confidence 0.98");
    expect(html).toContain("Branch gaps");
    expect(html).toContain("0 gap(s); max gap 0");
    expect(html).toContain("Branch warnings");
    expect(html).toContain("none");
    expect(html).toContain("Sample coverage");
    expect(html).toContain("sample 0-1");
    expect(html).toContain("Representative mode");
    expect(html).toContain("sample 0, mode 2, 12.5 GHz");
    expect(html).toContain("Dispersion workflow");
    expect(html).toContain("select branch -&gt; inspect tracked modes -&gt; plot mode field");
  });

  it("renders a dedicated eigen branch detail surface", () => {
    const selection: Selection = {
      kind: "results.eigen.branch",
      label: "Acoustic",
      moduleSource: "explorer",
      nodeId: "results:eigen:branches:branch-0",
      objectId: null,
      ref: {
        branchId: "branch-0",
        calculationMode: "dispersion_modal",
        kind: "results.eigen.branch",
        nodeId: "results:eigen:branches:branch-0",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <EigenBranchInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Eigen Branch Detail");
    expect(html).toContain("Branch identity");
    expect(html).toContain("branch-0; acoustic");
    expect(html).toContain("Frequency range");
    expect(html).toContain("12.5 GHz-13.1 GHz");
    expect(html).toContain("Tracked points");
    expect(html).toContain("2 point(s); samples 0-1");
    expect(html).toContain("Continuity");
    expect(html).toContain("min overlap 0.97; min confidence 0.98");
    expect(html).toContain("Representative mode");
    expect(html).toContain("sample 0, mode 2, 12.5 GHz");
    expect(html).toContain("3D handoff");
    expect(html).toContain("open representative mode and plot its field payload");
    expect(html).toContain("Branch resource");
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH);
    expect(html).toContain("Tracked Branch Samples");
    expect(html).toContain("Branch Continuity Charts");
    expect(html).toContain("Frequency-domain branch frequency chart");
    expect(html).toContain("Frequency vs sample");
    expect(html).toContain("12.5 GHz-13.1 GHz");
    expect(html).toContain("Frequency-domain branch overlap chart");
    expect(html).toContain("Overlap vs sample");
    expect(html).toContain("sample 1 mode 1: 0.97");
    expect(html).toContain("Frequency-domain branch sample table");
    expect(html).toContain("<th>Sample</th>");
    expect(html).toContain("<th>Raw mode</th>");
    expect(html).toContain("<th>Residual</th>");
    expect(html).toContain("<th>Mode field</th>");
    expect(html).toContain("<td>0</td><td>2</td><td>12.5 GHz</td>");
    expect(html).toContain("1.20e-7");
    expect(html).toContain("available");
    expect(html).toContain("missing");
    expect(html).toContain("Open sample 0 mode 2");
    expect(html).toContain("Plot sample 0 mode 2 in 3D");
    expect(html).toContain("Export branch CSV");
  });

  it("wires eigen branch sample actions to selection, 3D plotting, and CSV export", () => {
    const source = readFileSync(
      resolve(
        __dirname,
        "frequency-domain/FrequencyDomainResultInspectors.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("buildEigenBranchPointModeSelectionRef");
    expect(source).toContain("kernel.selection.set");
    expect(source).toContain('"analysis.eigen.plot-mode-3d"');
    expect(source).toContain("createCommandContext(\"inspector\", kernel");
    expect(source).toContain("navigator.clipboard.writeText");
    expect(source).toContain("branchSamplesCsv(branch)");
  });

  it("wires the dispersion branch table to the eigen branch inspector selection", () => {
    const source = readFileSync(
      resolve(
        __dirname,
        "frequency-domain/FrequencyDomainResultInspectors.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("buildEigenBranchSelectionRef(branch)");
    expect(source).toContain('kind: "results.eigen.branch"');
    expect(source).toContain("kernel.selection.set");
  });

  it("renders a dedicated frequency-domain export package surface", () => {
    const selection: Selection = {
      kind: "results.frequency_domain.exports",
      label: "Exports",
      moduleSource: "explorer",
      nodeId: "results:frequency-domain:exports",
      objectId: null,
      ref: {
        kind: "results.frequency_domain.exports",
        nodeId: "results:frequency-domain:exports",
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainExportsInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Frequency-Domain Exports");
    expect(html).toContain("Reproducibility bundle");
    expect(html).toContain("manifest + modal artifacts + driven response artifacts");
    expect(html).toContain("Manifest");
    expect(html).toContain("frequency_domain/manifest.v1.json");
    expect(html).toContain("Modal spectrum");
    expect(html).toContain("eigen/spectrum.v2.json");
    expect(html).toContain("Modal branches");
    expect(html).toContain("eigen/branches.v2.json");
    expect(html).toContain("Modal dispersion");
    expect(html).toContain("dispersion.csv");
    expect(html).toContain("Driven sweep");
    expect(html).toContain("response/magnetic_response_sweep.v2.json");
    expect(html).toContain("Field payloads");
    expect(html).toContain("2 response field(s), 2 modal field(s)");
    expect(html).toContain("Export formats");
    expect(html).toContain("JSON control plane, CSV dispersion, Zarr field payloads");
    expect(html).toContain("Python round-trip");
    expect(html).toContain("canonical Eigenmodes / FrequencyResponse studies");
    expect(html).toContain("Frequency-Domain Exports");
  });

  it("renders a dedicated eigen mode control surface", () => {
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
        resourceRef: analysisFieldVectorResourceKey(
          "analysis:eigen:sample-0000:mode-0002",
        ),
        sampleIndex: 0,
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <EigenModeInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Eigen Mode Control");
    expect(html).toContain("Canonical object");
    expect(html).toContain("Eigenmodes mode");
    expect(html).toContain("Mode identity");
    expect(html).toContain("sample 0, mode 2");
    expect(html).toContain("12 GHz");
    expect(html).not.toContain("12000000000 Hz");
    expect(html).toContain("Imaginary frequency");
    expect(html).toContain("-12 MHz");
    expect(html).toContain("Decay rate (Gamma)");
    expect(html).toContain("12 MHz");
    expect(html).toContain("Linewidth (FWHM)");
    expect(html).toContain("24 MHz");
    expect(html).toContain("Q-factor");
    expect(html).toContain("500");
    expect(html).toContain("Angular frequency");
    expect(html).toContain("7.540e+10 rad/s");
    expect(html).toContain("Mode field");
    expect(html).toContain("analysis:eigen:sample-0000:mode-0002; field-ready");
    expect(html).toContain("Mode field resource");
    expect(html).toContain(
      analysisFieldVectorResourceKey(
        "analysis:eigen:sample-0000:mode-0002",
      ).replace("&", "&amp;"),
    );
    expect(html).toContain("Available field views");
    expect(html).toContain("phase_rotated_real");
    expect(html).toContain("Residual");
    expect(html).toContain("1.000e-8");
    expect(html).toContain("Tangent leakage max");
    expect(html).toContain("1.000e-10");
    expect(html).toContain("Dominant polarization");
    expect(html).toContain("counter_clockwise");
    expect(html).toContain("3D workflow");
    expect(html).toContain("phasor reconstruction");
    expect(html).toContain("Eigen Mode 3D Visualization");
    expect(html).toContain("3D field ready");
    expect(html).toContain("Field ID");
    expect(html).toContain("Default view");
    expect(html).toContain("Phase-rotated real");
    expect(html).toContain("Phase convention");
    expect(html).toContain("Shared style preset");
    expect(html).toContain("one shared eigen/response mode visualization preset");
    expect(html).toContain("Volume inspection roadmap");
    expect(html).toContain("clip planes and shader opacity remain planned");
    expect(html).toContain("Mode field view");
    expect(html).toContain("Mode component");
    expect(html).toContain("delta m_x");
    expect(html).toContain("delta m_y");
    expect(html).toContain("delta m_z");
    expect(html).toContain("Display passes");
    expect(html).toContain("Mode color source");
    expect(html).toContain("Mode solid color");
    expect(html).toContain("Mode colormap");
    expect(html).toContain("Vector budget");
    expect(html).toContain("Vector scope");
    expect(html).toContain("Selected eigen mode 3D visualization controls");
    expect(html).toContain("Plot selected eigen mode with phase-rotated real display");
    expect(html).toContain("Plot selected eigen mode real component");
    expect(html).toContain("Plot selected eigen mode imaginary component");
    expect(html).toContain("Plot selected eigen mode complex magnitude");
    expect(html).toContain("Plot selected eigen mode phase");
    expect(html).toContain("Animate selected eigen mode phase in 3D");
    expect(html).toContain("Stop selected eigen mode animation");
    expect(html).not.toContain("Selected Eigen Mode");
    expect(html).not.toContain("Selected Field Metadata");
  });

  it("renders a dedicated FMR response sweep control surface", () => {
    const selection: Selection = {
      kind: "results.frequency_domain.fmr_response_sweep",
      label: "FMR Response Sweep",
      moduleSource: "explorer",
      nodeId: "results:frequency-domain:fmr:response-sweep",
      objectId: null,
      ref: {
        kind: "results.frequency_domain.fmr_response_sweep",
        nodeId: "results:frequency-domain:fmr:response-sweep",
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FmrResponseSweepInspectorPanel selection={selection} />,
    );

    expect(html).toContain("FMR Response Sweep Control");
    expect(html).toContain("Sweep workflow");
    expect(html).toContain(
      "driven FMR sweep -&gt; frequency point -&gt; 3D response field",
    );
    expect(html).toContain("Sweep resource");
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH);
    expect(html).toContain("Frequency points");
    expect(html).toContain("1 points, 1 observable series");
    expect(html).toContain("Response fields");
    expect(html).toContain("2 field artifacts");
    expect(html).toContain("Driven peak status");
    expect(html).toContain("1 driven peaks");
    expect(html).toContain("Response series");
    expect(html).toContain("1 chart series");
    expect(html).toContain("3D handoff");
    expect(html).toContain(
      "1/1 frequency points are directly linked; 2 field payloads published",
    );
    expect(html).toContain("FMR Response Sweep Chart");
    expect(html).toContain("Driven FMR frequency response");
    expect(html).toContain('data-renderer="echarts"');
    expect(html).toContain("Plot field");
    expect(html).toContain("FMR Response Point Browser");
    expect(html).toContain("mx, frequency point 0");
    expect(html).toContain("Amplitude");
    expect(html).toContain("1.500");
    expect(html).toContain("Phase");
    expect(html).toContain("Absorbed power");
    expect(html).toContain("Susceptibility");
    expect(html).toContain("Residual");
    expect(html).toContain("Response field");
    expect(html).toContain("field-ready");
    expect(html).not.toContain("field missing");
    expect(html).toContain("Inspect");
    expect(html).toContain("FMR Response Point Table");
    expect(html).toContain("Frequency-domain response point table");
    expect(html).toContain("Plot this response field with phase-rotated real display");
    expect(html).toContain("Driven FMR Peak Table");
    expect(html).toContain("Frequency-domain FMR peak table");
    expect(html).not.toContain("Selected Field Metadata");
  });

  it("renders a dedicated frequency-response point control surface", () => {
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
      <FrequencyResponsePointInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Response Frequency Point Control");
    expect(html).toContain("Canonical object");
    expect(html).toContain("FrequencyResponse point");
    expect(html).toContain("9.5 GHz");
    expect(html).not.toContain("9500000000 Hz");
    expect(html).toContain(
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH.replace(
        "{frequency_index}",
        "1",
      ),
    );
    expect(html).toContain("response/frequency_points/frequency_0001.json");
    expect(html).toContain("Response amplitude");
    expect(html).toContain("1.500");
    expect(html).toContain("Response phase");
    expect(html).toContain("0.1000 rad");
    expect(html).toContain("Absorbed power density");
    expect(html).toContain("42 W/m^3");
    expect(html).toContain("3D field");
    expect(html).toContain("analysis:frequency-response:frequency-0001; field-ready");
    expect(html).toContain("Available field views");
    expect(html).toContain("phase_rotated_real");
    expect(html).toContain("Provenance");
    expect(html).toContain("drive_projected_absorption_proxy");
    expect(html).toContain("Response Point 3D Visualization");
    expect(html).toContain("3D field ready");
    expect(html).toContain("Field ID");
    expect(html).toContain("Field resource");
    expect(html).toContain("Default view");
    expect(html).toContain("Phase-rotated real");
    expect(html).toContain("Default phase");
    expect(html).toContain("Complex response convention");
    expect(html).toContain("phasor response; view controls select real");
    expect(html).toContain("Mode field view");
    expect(html).toContain("Mode component");
    expect(html).toContain("delta m_x");
    expect(html).toContain("delta m_y");
    expect(html).toContain("delta m_z");
    expect(html).toContain("Display passes");
    expect(html).toContain("Mode color source");
    expect(html).toContain("Mode solid color");
    expect(html).toContain("Mode colormap");
    expect(html).toContain("Vector budget");
    expect(html).toContain("Vector scope");
    expect(html).toContain("Response point 3D visualization controls");
    expect(html).toContain("Plot response field with phase-rotated real display");
    expect(html).toContain("Plot response field real component");
    expect(html).toContain("Plot response field imaginary component");
    expect(html).toContain("Plot response field complex magnitude");
    expect(html).toContain("Plot response field phase");
    expect(html).toContain("Animate response field phase in 3D");
    expect(html).toContain("Stop response field animation");
    expect(html).not.toContain("Selected Response Frequency Point");
    expect(html).not.toContain("Selected Field Metadata");
  });

  it("renders active FMR peak workflow controls and provenance", () => {
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

    expect(html).toContain("Active FMR Peak");
    expect(html).toContain("Active peak");
    expect(html).toContain("modal, 9.5 GHz, sample 0 mode 1");
    expect(html).toContain("Peak source");
    expect(html).toContain("modal");
    expect(html).toContain("Modal provenance");
    expect(html).toContain("sample 0, mode 1");
    expect(html).toContain("Driven provenance");
    expect(html).toContain("not a driven peak");
    expect(html).toContain("3D field artifact");
    expect(html).toContain("analysis:eigen:sample-0000:mode-0001");
    expect(html).toContain("Validation");
    expect(html).toContain("unavailable");
    expect(html).toContain("Select active peak");
    expect(html).toContain("Plot active peak 3D");
    expect(html).toMatch(
      /<button class="fm-button fm-button--secondary fm-button--sm"[^>]*>Select active peak<\/button>/,
    );
    expect(html).toMatch(
      /<button class="fm-button fm-button--primary fm-button--sm"[^>]*>Plot active peak 3D<\/button>/,
    );
  });

  it("renders contextual ECharts frequency-domain charts for FMR", () => {
    const selection: Selection = {
      kind: "results.frequency_domain.fmr",
      label: "FMR",
      moduleSource: "explorer",
      nodeId: "results:frequency-domain:fmr",
      objectId: null,
      ref: {
        kind: "results.frequency_domain.fmr",
        nodeId: "results:frequency-domain:fmr",
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainInspectorPanel selection={selection} />,
    );

    expect(html).toContain("FMR / eigen modal spectrum");
    expect(html).toContain("Driven FMR frequency response");
    expect(html).toContain("FMR Spectrum Workbench");
    expect(html).toContain("Active modal resonance");
    expect(html).toContain("mode 1 at 9.5 GHz");
    expect(html).toContain("Modal modes");
    expect(html).toContain("2 modes, 2 field payloads");
    expect(html).toContain("FMR peaks");
    expect(html).toContain("2 modal, 1 driven");
    expect(html).toContain("Field readiness");
    expect(html).toContain("selected mode field ready");
    expect(html).toContain("Driven comparison");
    expect(html).toContain("response sweep available");
    expect(html).toContain("Nearest modal-driven detuning");
    expect(html).toContain("0 Hz driven-modal; modal 9.5 GHz, driven 9.5 GHz");
    expect(html).toContain('class="fm-frequency-domain-chart"');
    expect(html).toContain('data-renderer="echarts"');
    expect(html).toContain("Eigen Mode Browser");
    expect(html).toContain("Select eigen mode for 3D visualization");
    expect(html).toContain("Visualization style scope");
    expect(html).toContain("one shared preset for all modes in this result");
    expect(html).toContain("Mode switch behavior");
    expect(html).toContain(
      "change active field only; keep shader, vector, color, phase, and colormap controls",
    );
    expect(html).toContain("Volume inspection roadmap");
    expect(html).toContain(
      "clip planes and shader opacity are planned for internal-mode inspection",
    );
    expect(html).toContain("Selected mode frequency");
    expect(html).toContain("Selected sample");
    expect(html).toContain("Selected raw mode");
    expect(html).toContain("Selected mode field");
    expect(html).toContain("Eigen mode browser 3D view");
    expect(html).toContain("Mode color source");
    expect(html).toContain("Eigen mode browser color source");
    expect(html).toContain("Solid (plain material)");
    expect(html).toContain("Magnitude |m|");
    expect(html).toContain("Mode solid color");
    expect(html).toContain("Eigen mode browser solid color");
    expect(html).toContain("Mode colormap");
    expect(html).toContain("Eigen mode browser colormap");
    expect(html).toContain("Inferno");
    expect(html).toContain("Eigen mode browser phase");
    expect(html).toContain("Eigen mode browser animation rate");
    expect(html).toContain("Eigen mode 3D visualization controls");
    expect(html).toContain("Plot selected eigen mode with phase-rotated real display");
    expect(html).toContain("Plot selected eigen mode real component");
    expect(html).toContain("Plot selected eigen mode imaginary component");
    expect(html).toContain("Plot selected eigen mode complex magnitude");
    expect(html).toContain("Plot selected eigen mode phase");
    expect(html).toContain("Animate selected eigen mode phase in 3D");
    expect(html).toMatch(
      /<button class="fm-button fm-button--primary fm-button--sm fm-inspector-action-button" aria-label="Plot selected eigen mode with phase-rotated real display"[^>]*><svg[^>]*class="lucide lucide-rotate-cw"/,
    );
    expect(html).toMatch(
      /aria-label="Plot this response field with phase-rotated real display at 9.5 GHz" title="Plot this response field with phase-rotated real display"/,
    );
    expect(html).not.toContain("Response field artifact is missing");
    expect(html).toContain("Frequency-domain mode table");
    expect(html).toContain("Frequency-domain response point table");
    expect(html).toContain("Frequency-domain FMR peak table");
    expect(html).not.toContain("Bloch / Floquet dispersion");
    expect(html).not.toContain("Frequency-domain branch table");
    expect(html).toContain("mode 1: 9.5 GHz");
    expect(html).toContain("mode 2: 12 GHz");
    expect(html).toContain("Amplitude: 1 samples");
    expect(html).toContain("<td>modal</td><td>9.5 GHz</td>");
    expect(html).toContain("<td>0</td><td>1</td>");
    expect(html).toContain("<td>0</td><td>mx</td>");
    expect(html).toContain("available");
    expect(html).toContain("Plot the real part of this eigen mode");
    expect(html).toContain("Plot the imaginary part of this eigen mode");
    expect(html).toContain("Plot the complex magnitude of this eigen mode");
    expect(html).toContain("Plot the phase of this eigen mode");
    expect(html).toContain("Select");
    expect(html).toContain("Animate");
  });

  it("renders mode browser controls for eigen mode field resource nodes", () => {
    const selection: Selection = {
      kind: "resources.analysis.eigen.mode_field",
      label: "Mode Field Resource",
      moduleSource: "explorer",
      nodeId: "resources:analysis:eigen:mode-field",
      objectId: null,
      ref: {
        artifactPath:
          "eigen/mode_fields.zarr/sample_0000/mode_0002/vector_xyz_complex",
        fieldId: "analysis:eigen:sample-0000:mode-0002",
        kind: "resources.analysis.eigen.mode_field",
        nodeId: "resources:analysis:eigen:mode-field",
        resourceRef: analysisFieldVectorResourceKey(
          "analysis:eigen:sample-0000:mode-0002",
        ),
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Eigen Mode Field Resource Detail");
    expect(html).toContain("Eigen Mode Browser");
    expect(html).toContain("Select eigen mode for 3D visualization");
    expect(html).toContain("Visualization style scope");
    expect(html).toContain("one shared preset for all modes in this result");
    expect(html).toContain("Mode switch behavior");
    expect(html).toContain(
      "change active field only; keep shader, vector, color, phase, and colormap controls",
    );
    expect(html).toContain("Volume inspection roadmap");
    expect(html).toContain(
      "clip planes and shader opacity are planned for internal-mode inspection",
    );
    expect(html).toContain("sample 0, mode 1, 9.5 GHz");
    expect(html).toContain("sample 0, mode 2, 12 GHz");
    expect(html).toContain("Selected mode field");
    expect(html).toContain("analysis:eigen:sample-0000:mode-0001");
    expect(html).toContain("Eigen mode browser 3D view");
    expect(html).toContain("Mode color source");
    expect(html).toContain("Eigen mode browser color source");
    expect(html).toContain("Solid (plain material)");
    expect(html).toContain("Magnitude |m|");
    expect(html).toContain("Mode solid color");
    expect(html).toContain("Eigen mode browser solid color");
    expect(html).toContain("Mode colormap");
    expect(html).toContain("Eigen mode browser colormap");
    expect(html).toContain("Inferno");
    expect(html).toContain("Phase-rotated real");
    expect(html).toContain("Real");
    expect(html).toContain("Imag");
    expect(html).toContain("Complex (abs)");
    expect(html).toContain("Phase");
    expect(html).toContain("Eigen mode 3D visualization controls");
    expect(html).toContain("Plot selected eigen mode with phase-rotated real display");
    expect(html).toContain("Plot selected eigen mode real component");
    expect(html).toContain("Plot selected eigen mode imaginary component");
    expect(html).toContain("Plot selected eigen mode complex magnitude");
    expect(html).toContain("Plot selected eigen mode phase");
    expect(html).toContain("Animate selected eigen mode phase in 3D");
    expect(html).toContain("Open selected eigen mode data preview");
    expect(html).toContain("Mode data preview");
    expect(html).not.toMatch(
      /aria-label="Plot selected eigen mode with phase-rotated real display"[^>]*disabled=""/,
    );
    expect(html).not.toMatch(
      /aria-label="Animate selected eigen mode phase in 3D"[^>]*disabled=""/,
    );
    expect(html).toContain("Stop animate");
    expect(html).not.toContain("Mode controls</span><span class=\"fm-inspector-field-row__value\">not available");
  });

  it("does not render empty field metadata for eigen mode-field folder nodes", () => {
    const selection: Selection = {
      kind: "resources.analysis.eigen.mode_field",
      label: "Mode Fields",
      moduleSource: "explorer",
      nodeId: "resources:analysis:eigen:mode-fields",
      objectId: null,
      ref: {
        kind: "resources.analysis.eigen.mode_field",
        nodeId: "resources:analysis:eigen:mode-fields",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Eigen Mode Browser");
    expect(html).toContain("Select eigen mode for 3D visualization");
    expect(html).toContain("sample 0, mode 1, 9.5 GHz");
    expect(html).toContain("sample 0, mode 2, 12 GHz");
    expect(html).toContain("Selected mode field");
    expect(html).toContain("Eigen mode 3D visualization controls");
    expect(html).toContain("Plot selected eigen mode with phase-rotated real display");
    expect(html).toContain("Animate selected eigen mode phase in 3D");
    expect(html).not.toContain("Selected Field Metadata");
    expect(html).not.toContain("Field ID</span><span class=\"fm-inspector-field-row__value\">not selected");
    expect(html).not.toContain("Value kind</span><span class=\"fm-inspector-field-row__value\">not available");
  });

  it("renders result calculation-mode requirements and capability statuses", () => {
    const selection: Selection = {
      kind: "results.frequency_domain.calculation_modes",
      label: "Calculation Mode",
      moduleSource: "explorer",
      nodeId: "results:frequency-domain:calculation-modes",
      objectId: null,
      ref: {
        kind: "results.frequency_domain.calculation_modes",
        nodeId: "results:frequency-domain:calculation-modes",
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainCalculationModesInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Frequency-Domain Workflow Router");
    expect(html).toContain("Active workflow");
    expect(html).toContain("Calculation Mode Matrix");
    expect(html).toContain("Frequency-domain calculation mode table");
    expect(html).toContain("Mode");
    expect(html).toContain("Canonical study");
    expect(html).toContain("Boundary / k");
    expect(html).toContain("Excitation / sweep");
    expect(html).toContain("Artifacts");
    expect(html).toContain("Capability");
    expect(html).toContain("fmr_modal");
    expect(html).toContain("free_modes");
    expect(html).toContain("Eigenmodes");
    expect(html).toContain("k = 0 / no k-path");
    expect(html).toContain("spectrum.v2 + mode fields");
    expect(html).toContain("reference_cpu: ready");
    expect(html).toContain("fmr_response");
    expect(html).toContain("FrequencyResponse");
    expect(html).toContain("frequency sweep required");
    expect(html).toContain("harmonic excitation required");
    expect(html).toContain("magnetic_cpu: partial_production_executable");
    expect(html).toContain("dispersion_modal");
    expect(html).toContain("Floquet/Bloch k-path");
    expect(html).toContain("k-path required");
    expect(html).toContain("production_cpu: partial_production_executable");
    expect(html).toContain(
      "production_cpu_gamma_k_path: partial_production_executable",
    );
    expect(html).toContain("production_gpu: unsupported");
    expect(html).toContain("k_path: ready");
    expect(html).toContain("response_map");
    expect(html).toContain("k/f grid required");
    expect(html).toContain("nonzero-k response unavailable");
    expect(html).toContain("floquet_response: unsupported");
    expect(html).toContain("Calculation Mode Result Shortcuts");
    expect(html).not.toContain("Calculation Mode Workflow");
  });

  it("renders a dedicated calculation-mode workflow router surface", () => {
    const selection: Selection = {
      kind: "results.frequency_domain.calculation_modes",
      label: "Calculation Mode",
      moduleSource: "explorer",
      nodeId: "results:frequency-domain:calculation-modes",
      objectId: null,
      ref: {
        kind: "results.frequency_domain.calculation_modes",
        nodeId: "results:frequency-domain:calculation-modes",
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainCalculationModesInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Frequency-Domain Workflow Router");
    expect(html).toContain("Active workflow");
    expect(html).toContain("fmr_response; available");
    expect(html).toContain("Canonical study");
    expect(html).toContain("FrequencyResponse");
    expect(html).toContain("Primary result chart");
    expect(html).toContain("response-sweep");
    expect(html).toContain("Supported modal workflows");
    expect(html).toContain("fmr_modal, free_modes, dispersion_modal");
    expect(html).toContain("Supported driven workflows");
    expect(html).toContain("fmr_response, response_map");
    expect(html).toContain("Modal evidence");
    expect(html).toContain("2 mode(s), 2 field-ready");
    expect(html).toContain("Driven evidence");
    expect(html).toContain("1 response point(s), 1 observable series");
    expect(html).toContain("Response-map gate");
    expect(html).toContain("nonzero-k response unavailable");
    expect(html).toContain("Required artifacts");
    expect(html).toContain("response sweep + frequency points + fields");
    expect(html).toContain("Capability route");
    expect(html).toContain("magnetic_cpu: partial_production_executable");
    expect(html).toContain("Calculation Mode Matrix");
    expect(html).toContain("Frequency-domain calculation mode table");
    expect(html).toContain("fmr_response (active)");
    expect(html).toContain("fmr_modal");
    expect(html).toContain("dispersion_modal");
    expect(html).toContain("Calculation Mode Result Shortcuts");
    expect(html).toContain("Open FMR workbench");
    expect(html).toContain("Open modal spectrum");
    expect(html).toContain("Open response sweep");
    expect(html).toContain("Open dispersion");
    expect(html).not.toContain("Calculation Mode Workflow");
    expect(html).not.toContain("Selected Field Metadata");
  });

  it("renders a dedicated frequency-domain results overview surface", () => {
    const selection: Selection = {
      kind: "results.frequency_domain.root",
      label: "Frequency Domain",
      moduleSource: "explorer",
      nodeId: "results:frequency-domain",
      objectId: null,
      ref: {
        kind: "results.frequency_domain.root",
        nodeId: "results:frequency-domain",
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainOverviewInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Frequency-Domain Results Overview");
    expect(html).toContain("Primary workflow");
    expect(html).toContain("fmr_response -&gt; response-sweep");
    expect(html).toContain("FMR readiness");
    expect(html).toContain("2 modal mode(s), 1 driven point(s), 3 peak(s)");
    expect(html).toContain("Modal visualization");
    expect(html).toContain("2 mode field payload(s)");
    expect(html).toContain("Driven visualization");
    expect(html).toContain("2 response field artifact(s)");
    expect(html).toContain("Frequency coverage");
    expect(html).toContain("9.5 GHz-12 GHz");
    expect(html).toContain("Capability summary");
    expect(html).toContain(
      "reference_cpu: ready; magnetic_cpu: partial_production_executable",
    );
    expect(html).toContain("Next action");
    expect(html).toContain("open FMR peaks or mode browser");
    expect(html).toContain("Result Family Shortcuts");
    expect(html).toContain("Open FMR workbench");
    expect(html).toContain("Open eigen results");
    expect(html).toContain("Open response results");
    expect(html).not.toContain("Selected Field Metadata");
  });

  it("renders dedicated eigen result overview and study contract surfaces", () => {
    const rootSelection: Selection = {
      kind: "results.eigen.root",
      label: "Eigen",
      moduleSource: "explorer",
      nodeId: "results:eigen",
      objectId: null,
      ref: {
        kind: "results.eigen.root",
        nodeId: "results:eigen",
        type: "frequency-domain",
      },
    };
    const studySelection: Selection = {
      ...rootSelection,
      kind: "results.eigen.study",
      label: "Eigen Study",
      nodeId: "results:eigen:study",
      ref: {
        kind: "results.eigen.study",
        nodeId: "results:eigen:study",
        type: "frequency-domain",
      },
    };

    const rootHtml = renderToStaticMarkup(
      <EigenOverviewInspectorPanel selection={rootSelection} />,
    );
    const studyHtml = renderToStaticMarkup(
      <EigenStudyInspectorPanel selection={studySelection} />,
    );

    expect(rootHtml).toContain("Eigen Results Overview");
    expect(rootHtml).toContain("Spectrum");
    expect(rootHtml).toContain("2 mode(s), 2 field payload(s)");
    expect(rootHtml).toContain("Dispersion");
    expect(rootHtml).toContain("2 k-path point(s), 1 branch(es)");
    expect(rootHtml).toContain("3D handoff");
    expect(rootHtml).toContain("select mode or branch point -&gt; plot mode field");
    expect(rootHtml).toContain("Eigen Result Shortcuts");
    expect(rootHtml).toContain("Open spectrum");
    expect(rootHtml).toContain("Open mode browser");
    expect(rootHtml).toContain("Open dispersion");
    expect(rootHtml).not.toContain("Selected Field Metadata");
    expect(studyHtml).toContain("Eigenmodes Study Contract");
    expect(studyHtml).toContain("Study kind");
    expect(studyHtml).toContain("eigenmodes: unavailable");
    expect(studyHtml).toContain("Operator lane");
    expect(studyHtml).toContain("linearized LLG modal operator");
    expect(studyHtml).toContain("Artifacts");
    expect(studyHtml).toContain(
      "eigen/spectrum.v2.json; eigen/branches.v2.json",
    );
    expect(studyHtml).toContain("Eigen Study Readback");
    expect(studyHtml).toContain("StudyIR::Eigenmodes stage");
    expect(studyHtml).not.toContain("Selected Field Metadata");
  });

  it("renders dedicated frequency-response overview and study contract surfaces", () => {
    const rootSelection: Selection = {
      kind: "results.frequency_response.root",
      label: "Frequency Response",
      moduleSource: "explorer",
      nodeId: "results:frequency-response",
      objectId: null,
      ref: {
        kind: "results.frequency_response.root",
        nodeId: "results:frequency-response",
        type: "frequency-domain",
      },
    };
    const studySelection: Selection = {
      ...rootSelection,
      kind: "results.frequency_response.study",
      label: "Response Study",
      nodeId: "results:frequency-response:study",
      ref: {
        kind: "results.frequency_response.study",
        nodeId: "results:frequency-response:study",
        type: "frequency-domain",
      },
    };

    const rootHtml = renderToStaticMarkup(
      <FrequencyResponseOverviewInspectorPanel selection={rootSelection} />,
    );
    const studyHtml = renderToStaticMarkup(
      <FrequencyResponseStudyInspectorPanel selection={studySelection} />,
    );

    expect(rootHtml).toContain("Frequency Response Results Overview");
    expect(rootHtml).toContain("Sweep");
    expect(rootHtml).toContain("1 point(s), 1 observable series");
    expect(rootHtml).toContain("Progress");
    expect(rootHtml).toContain("unavailable; 0/2");
    expect(rootHtml).toContain("Cancellation");
    expect(rootHtml).toContain("cancel_requested; 1/4");
    expect(rootHtml).toContain("3D handoff");
    expect(rootHtml).toContain(
      "select frequency point -&gt; plot response field",
    );
    expect(rootHtml).toContain("Response Result Shortcuts");
    expect(rootHtml).toContain("Open sweep");
    expect(rootHtml).toContain("Open frequency points");
    expect(rootHtml).toContain("Open observables");
    expect(rootHtml).not.toContain("Selected Field Metadata");
    expect(studyHtml).toContain("Frequency Response Study Contract");
    expect(studyHtml).toContain("Study kind");
    expect(studyHtml).toContain("frequency_response: ok");
    expect(studyHtml).toContain("Execution lane");
    expect(studyHtml).toContain(
      "native_fem_mfem_frequency_domain_cpu; response=ok",
    );
    expect(studyHtml).toContain("Requested spin-wave BC");
    expect(studyHtml).toContain(
      "floquet; k [7.854e+7, 0, 0] rad/m; phase exp_minus_i_k_dot_delta_r",
    );
    expect(studyHtml).toContain("Requested magnetostatic BC");
    expect(studyHtml).toContain("periodic_airbox_k0");
    expect(studyHtml).not.toContain("gamma/free-boundary response");
    expect(studyHtml).toContain("Artifacts");
    expect(studyHtml).toContain("response/magnetic_response_sweep.v2.json");
    expect(studyHtml).toContain("Response Study Readback");
    expect(studyHtml).toContain("StudyIR::FrequencyResponse stage");
    expect(studyHtml).not.toContain("Selected Field Metadata");
  });

  it("renders dedicated run provenance from the frequency-domain manifest", () => {
    const selection: Selection = {
      kind: "results.frequency_domain.run",
      label: "Run",
      moduleSource: "explorer",
      nodeId: "results:frequency-domain:run",
      objectId: null,
      ref: {
        kind: "results.frequency_domain.run",
        nodeId: "results:frequency-domain:run",
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainRunInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Frequency-Domain Run Provenance");
    expect(html).toContain("Manifest resource");
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH);
    expect(html).toContain("Manifest artifact");
    expect(html).toContain("frequency_domain/manifest.v1.json");
    expect(html).toContain("Calculation mode");
    expect(html).toContain("fmr_response");
    expect(html).toContain("Stage kind");
    expect(html).toContain("frequency_response");
    expect(html).toContain("Family namespace");
    expect(html).toContain("frequencyDomain");
    expect(html).toContain("Eigen namespace");
    expect(html).toContain("eigen");
    expect(html).toContain("Response lane");
    expect(html).toContain(
      "frequency_response: ok; driven=true; static_periodic=true; gpu=false",
    );
    expect(html).toContain("Eigen lane");
    expect(html).toContain("eigenmodes: unavailable; modal=false; gpu=false");
    expect(html).toContain("Physics contract");
    expect(html).toContain(
      "unit_l2; exp_minus_i_omega_t; Hz; dimensionless_delta_m",
    );
    expect(html).toContain("Namespace compatibility");
    expect(html).toContain("existing frequency_response namespace preserved=true");
    expect(html).toContain("Frequency-Domain Run");
    expect(html).toContain("Run Resource Links");
    expect(html).toContain("Open calculation modes");
    expect(html).toContain("Open FMR workbench");
    expect(html).not.toContain("Selected Field Metadata");
  });

  it("renders dedicated eigen provenance from manifest and modal artifacts", () => {
    const selection: Selection = {
      kind: "results.eigen.provenance",
      label: "Eigen Provenance",
      moduleSource: "explorer",
      nodeId: "results:eigen:provenance",
      objectId: null,
      ref: {
        kind: "results.eigen.provenance",
        nodeId: "results:eigen:provenance",
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <EigenProvenanceInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Eigen Provenance");
    expect(html).toContain("Canonical family");
    expect(html).toContain("Eigenmodes modal lane");
    expect(html).toContain("Manifest artifact");
    expect(html).toContain("frequency_domain/manifest.v1.json");
    expect(html).toContain("Requested calculation");
    expect(html).toContain("fmr_response");
    expect(html).toContain("Stage kind");
    expect(html).toContain("frequency_response");
    expect(html).toContain("Modal availability");
    expect(html).toContain("eigenmodes: unavailable; modal=false; gpu=false");
    expect(html).toContain("Modal spectrum artifact");
    expect(html).toContain("eigen/spectrum.v2.json");
    expect(html).toContain("Branch artifact");
    expect(html).toContain("eigen/branches.v2.json");
    expect(html).toContain("Physics contract");
    expect(html).toContain(
      "unit_l2; exp_minus_i_omega_t; Hz; dimensionless_delta_m",
    );
    expect(html).toContain("Eigen Provenance Links");
    expect(html).toContain("Open modal spectrum");
    expect(html).toContain("Open mode browser");
    expect(html).not.toContain("Selected Field Metadata");
  });

  it("renders dedicated frequency-response provenance from manifest and driven artifacts", () => {
    const selection: Selection = {
      kind: "results.frequency_response.provenance",
      label: "Response Provenance",
      moduleSource: "explorer",
      nodeId: "results:frequency-response:provenance",
      objectId: null,
      ref: {
        kind: "results.frequency_response.provenance",
        nodeId: "results:frequency-response:provenance",
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyResponseProvenanceInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Frequency Response Provenance");
    expect(html).toContain("Canonical family");
    expect(html).toContain("FrequencyResponse driven lane");
    expect(html).toContain("Manifest artifact");
    expect(html).toContain("frequency_domain/manifest.v1.json");
    expect(html).toContain("Requested calculation");
    expect(html).toContain("fmr_response");
    expect(html).toContain("Stage kind");
    expect(html).toContain("frequency_response");
    expect(html).toContain("Driven availability");
    expect(html).toContain(
      "frequency_response: ok; driven=true; static_periodic=true; gpu=false",
    );
    expect(html).toContain("Requested spin-wave BC");
    expect(html).toContain(
      "floquet; k [7.854e+7, 0, 0] rad/m; phase exp_minus_i_k_dot_delta_r",
    );
    expect(html).toContain("Requested magnetostatic BC");
    expect(html).toContain("periodic_airbox_k0");
    expect(html).toContain("Response sweep artifact");
    expect(html).toContain("response/magnetic_response_sweep.v2.json");
    expect(html).toContain("Response field artifacts");
    expect(html).toContain("2 field artifact(s)");
    expect(html).toContain("Physics contract");
    expect(html).toContain(
      "unit_l2; exp_minus_i_omega_t; Hz; dimensionless_delta_m",
    );
    expect(html).toContain("Response Provenance Links");
    expect(html).toContain("Open response sweep");
    expect(html).toContain("Open frequency points");
    expect(html).not.toContain("Selected Field Metadata");
  });

  it.each([
    [
      "study.stage.eigenmodes.calculation_mode",
      "Eigenmodes calculation-mode authoring",
      "StudyIR::Eigenmodes",
      "fmr_modal",
      "dispersion_modal",
    ],
    [
      "study.stage.frequency_response.calculation_mode",
      "Frequency Response calculation-mode authoring",
      "StudyIR::FrequencyResponse",
      "fmr_response",
      "response_map",
    ],
  ] as const)(
    "renders a controllable authoring workflow for %s",
    (kind, title, canonicalStudy, primaryMode, gatedMode) => {
      const selection: Selection = {
        kind,
        label: kind,
        moduleSource: "explorer",
        nodeId: `test:${kind}`,
        objectId: null,
        ref: {
          kind,
          nodeId: `test:${kind}`,
          stageId: "stage-frequency-domain",
          stageIndex: 0,
          type: "study-stage",
        },
      };

      const html = renderToStaticMarkup(
        <FrequencyDomainInspectorPanel selection={selection} />,
      );

      expect(html).toContain(title);
      expect(html).toContain("Workflow preset");
      expect(html).toContain(primaryMode);
      expect(html).toContain(gatedMode);
      expect(html).toContain(canonicalStudy);
      expect(html).toContain("Canonical patch preview");
      expect(html).toContain("Requested fields");
      expect(html).toContain("Validation gates");
      expect(html).toContain("Capability reason");
      expect(html).toContain("Python export");
      expect(html).toContain("Canonical stage draft");
      expect(html).toContain("Use the Study stage inspector draft editor");
      expect(html).toContain("Apply calculation mode");
      expect(html).toContain("Validate calculation mode");
      expect(html).toContain(
        "Save stage commits calculation_mode through the canonical stage patch",
      );
      expect(html).not.toContain("read-only preview; study transaction wiring pending");
    },
  );

  it.each([
    [
      "study.stage.eigenmodes.setup",
      [
        "Eigenmodes setup authoring",
        "Mode count",
        "Target kind",
        "Target frequency",
        "Operator preset",
        "Requested backend",
        "Requested device",
        "Requested precision",
        "Canonical stage draft",
      ],
    ],
    [
      "study.stage.frequency_response.setup",
      [
        "Frequency Response setup authoring",
        "Direct harmonic response",
        "No time integrator",
        "Frequency count",
        "Response outputs",
        "Canonical stage draft",
      ],
    ],
    [
      "study.stage.eigenmodes.equilibrium",
      [
        "Eigenmodes equilibrium authoring",
        "Equilibrium source",
        "Artifact path",
        "m0 x H0 residual",
        "Normalization error",
        "Canonical stage draft",
      ],
    ],
    [
      "study.stage.frequency_response.equilibrium",
      [
        "Frequency Response equilibrium authoring",
        "Equilibrium source",
        "Artifact path",
        "Modal comparison ready",
        "Canonical stage draft",
      ],
    ],
    [
      "study.stage.eigenmodes.operator",
      [
        "Eigenmodes operator authoring",
        "Operator kind",
        "Include demag",
        "Damping policy",
        "Normalization",
        "Energy terms",
        "Canonical stage draft",
      ],
    ],
    [
      "study.stage.frequency_response.operator",
      [
        "Frequency Response operator authoring",
        "Operator kind",
        "Include demag",
        "Damping policy",
        "Normalization",
        "Production CPU slice",
        "Canonical stage draft",
      ],
    ],
  ] as const)("renders a canonical authoring panel for %s", (kind, expectedLabels) => {
    const selection: Selection = {
      kind,
      label: kind,
      moduleSource: "explorer",
      nodeId: `test:${kind}`,
      objectId: null,
      ref: {
        kind,
        nodeId: `test:${kind}`,
        stageId: "stage-frequency-domain",
        stageIndex: 0,
        type: "study-stage",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainInspectorPanel selection={selection} />,
    );

    for (const label of expectedLabels) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Use the Study stage inspector draft editor");
    expect(html).not.toContain("stage transaction preview");
    expect(html).not.toContain('aria-label="Mode count"');
    expect(html).not.toContain('aria-label="Frequency count"');
    expect(html).not.toContain('aria-label="Equilibrium source"');
    expect(html).not.toContain('aria-label="Drive vector hx"');
    expect(html).not.toContain('aria-label="Start frequency"');
    expect(html).not.toContain("diagnostic view; editing requires study transaction");
    expect(html).not.toContain("badge\">read-only");
  });

  it.each([
    [
      "study.stage.eigenmodes.boundary",
      [
        "Boundary Workflow",
        "Boundary condition selector",
        "Periodic pair source",
        "Floquet phase convention",
        "Demag policy",
        "Status",
      ],
    ],
    [
      "study.stage.eigenmodes.k_path",
      [
        "k-Sampling Workflow",
        "k sampling mode",
        "Path endpoint A",
        "Path endpoint B",
        "k sample count",
        "k units",
        "Status",
      ],
    ],
    [
      "study.stage.frequency_response.k_grid",
      [
        "k-Sampling Workflow",
        "k sampling mode",
        "k-grid nx",
        "k-grid ny",
        "Frequency coupling",
        "Status",
      ],
    ],
  ] as const)("renders authoring controls for %s", (kind, expectedLabels) => {
    const selection: Selection = {
      kind,
      label: kind,
      moduleSource: "explorer",
      nodeId: `test:${kind}`,
      objectId: null,
      ref: {
        kind,
        nodeId: `test:${kind}`,
        stageId: "stage-frequency-domain",
        stageIndex: 0,
        type: "study-stage",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainInspectorPanel selection={selection} />,
    );

    for (const label of expectedLabels) {
      expect(html).toContain(label);
    }
  });

  it.each([
    "study.stage.frequency_response.excitation",
    "study.stage.frequency_response.sweep",
  ] as const)("keeps %s as metadata-only fallback outside the canonical Study router", (kind) => {
    const selection: Selection = {
      kind,
      label: kind,
      moduleSource: "explorer",
      nodeId: `test:${kind}`,
      objectId: null,
      ref: {
        kind,
        nodeId: `test:${kind}`,
        stageId: "stage-frequency-domain",
        stageIndex: 0,
        type: "study-stage",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Node focus");
    expect(html).toContain("Node resource");
    expect(html).toContain("Visualization contract");
    expect(html).not.toContain("Use the Study stage inspector draft editor");
    expect(html).not.toContain("Frequency Response excitation authoring");
    expect(html).not.toContain("Frequency Response sweep authoring");
    expect(html).not.toContain("Excitation Workflow");
    expect(html).not.toContain("Frequency Sweep Workflow");
  });

  it.each([
    [
      "results.frequency_domain.calculation_modes",
      "Calculation Modes",
      "FMR modal, driven FMR, dispersion, response map",
    ],
    [
      "results.frequency_domain.fmr",
      "FMR Result",
      "modal and driven FMR comparison",
    ],
    [
      "results.frequency_domain.fmr_modal_spectrum",
      "FMR Modal Spectrum",
      "modal resonance spectrum and mode field",
    ],
    [
      "results.frequency_domain.fmr_response_sweep",
      "FMR Response Sweep",
      "driven response sweep, phase, absorbed power",
    ],
    [
      "results.frequency_domain.response_map",
      "Response Map",
      "future k/f intensity map",
    ],
    [
      "results.frequency_domain.comparison",
      "Modal vs Driven Comparison",
      "modal-driven resonance comparison",
    ],
    [
      "results.frequency_domain.exports",
      "Frequency-Domain Exports",
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

  it.each([
    [
      "resources.analysis.frequency_domain.calculation_modes",
      [
        "Frequency-Domain Resource Group",
        "Calculation mode resources",
        "Manifest resource",
        "Modal spectrum resource",
        "Driven sweep resource",
        "Dispersion resource",
        "Response map gate",
        "Available charts",
      ],
    ],
    [
      "resources.analysis.frequency_domain.fmr",
      [
        "Frequency-Domain Resource Group",
        "FMR resource group",
        "Modal spectrum resource",
        "Driven sweep resource",
        "FMR peak table",
        "Available charts",
      ],
    ],
    [
      "resources.analysis.frequency_domain.dispersion",
      [
        "Frequency-Domain Resource Group",
        "Dispersion resource group",
        "Dispersion resource",
        "Branch resource",
        "k-path chart",
        "Available charts",
      ],
    ],
    [
      "resources.analysis.frequency_domain.response_map",
      [
        "Frequency-Domain Resource Group",
        "Response-map resource group",
        "Response map gate",
        "nonzero-k response unavailable",
        "Available charts",
      ],
    ],
  ] as const)(
    "renders resource group availability for %s",
    (kind, expectedLabels) => {
      const selection: Selection = {
        kind,
        label: kind,
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

      for (const label of expectedLabels) {
        expect(html).toContain(label);
      }
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
        resourceRef: analysisFieldVectorResourceKey(
          "analysis:eigen:sample-0000:mode-0002",
        ),
        sampleIndex: 0,
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Selected Eigen Mode");
    expect(html).toContain("Eigen Mode");
    expect(html).toContain("sample 0, mode 2");
    expect(html).toContain("real, imag, complex abs, phase, animated phase");
    expect(html).toContain("Mode field ID");
    expect(html).toContain("3D command payload available");
    expect(html).toContain("Spectrum branch");
    expect(html).toContain("Shared mode visualization preset");
    expect(html).toContain("shared across all eigen modes in this result");
    expect(html).toContain("Mode switch behavior");
    expect(html).toContain(
      "changes field payload only; keeps shader, vector, color, phase, and colormap controls",
    );
    expect(html).toContain("Selected eigen mode 3D view");
    expect(html).toContain("Mode color source");
    expect(html).toContain("Selected eigen mode color source");
    expect(html).toContain("Solid (plain material)");
    expect(html).toContain("Magnitude |m|");
    expect(html).toContain("Mode solid color");
    expect(html).toContain("Selected eigen mode solid color");
    expect(html).toContain("Mode colormap");
    expect(html).toContain("Selected eigen mode colormap");
    expect(html).toContain("Inferno");
    expect(html).toContain("Selected eigen mode phase");
    expect(html).toContain("Selected eigen mode animation rate");
    expect(html).toContain("Selected eigen mode 3D visualization controls");
    expect(html).toContain("Plot selected eigen mode with phase-rotated real display");
    expect(html).toContain("Plot selected eigen mode real component");
    expect(html).toContain("Plot selected eigen mode imaginary component");
    expect(html).toContain("Plot selected eigen mode complex magnitude");
    expect(html).toContain("Plot selected eigen mode phase");
    expect(html).toContain("Animate selected eigen mode phase in 3D");
    expect(html).toContain("Open selected eigen mode data preview");
    expect(html).toContain("Mode data preview");
    expect(html).toMatch(
      /<button class="fm-button fm-button--primary fm-button--sm fm-inspector-action-button" aria-label="Plot selected eigen mode with phase-rotated real display"[^>]*><svg[^>]*class="lucide lucide-rotate-cw"/,
    );
    expect(html).not.toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Plot selected eigen mode with phase-rotated real display"/,
    );
    expect(html).toContain("eigen/modes/sample_0000/mode_0002.json");
    expect(html).toContain(
      analysisFieldVectorResourceKey(
        "analysis:eigen:sample-0000:mode-0002",
      ).replace("&", "&amp;"),
    );
    expect(html).toContain("12 GHz");
    expect(html).toContain("-12 MHz");
    expect(html).toContain("counter_clockwise");
    expect(html).toContain("Tangent leakage max");
    expect(html).toContain("Real samples");
    expect(html).toContain("Imag samples");
    expect(html).toContain("Phase-rotated real");
    expect(html).toContain("Real");
    expect(html).toContain("Imag");
    expect(html).toContain("Complex (abs)");
    expect(html).toContain("Phase");
    const fieldViewSelectStart = html.indexOf("Selected eigen mode 3D view");
    const fieldViewSelect = html.slice(fieldViewSelectStart);
    expect(fieldViewSelect.indexOf("Phase-rotated real")).toBeLessThan(
      fieldViewSelect.indexOf("Complex (abs)"),
    );
    expect(html).not.toContain("Value kind</span><strong>not available");
    expect(html).not.toContain("Frequency-domain 3D field view");
  });

  it("wires Plot in 3D to the user-entered phase value", () => {
    const source =
      readFileSync(resolve(__dirname, "FrequencyDomainInspectorPanel.tsx"), "utf8") +
      readFileSync(resolve(__dirname, "FrequencyDomainEigenSection.tsx"), "utf8") +
      readFileSync(resolve(__dirname, "FrequencyDomainResponseSection.tsx"), "utf8");
    const dataPreviewSource = readFileSync(
      resolve(__dirname, "FrequencyDomainModeDataPreviewDialog.tsx"),
      "utf8",
    );
    const displayControlsSource = readFileSync(
      resolve(__dirname, "FrequencyDomainModeDisplayControls.tsx"),
      "utf8",
    );
    const resultInspectorsSource = readFileSync(
      resolve(__dirname, "frequency-domain/FrequencyDomainResultInspectors.tsx"),
      "utf8",
    );

    expect(source).toContain("analysisFieldPhaseInputRef.current?.value");
    expect(source).toContain("selectedFieldMeta?.default_phase_rad");
    expect(source).toContain("const selectedFieldIsEigen = kind.includes(\"eigen\")");
    expect(source).toContain("const selectedFieldPlotCommand = selectedFieldIsEigen");
    expect(source).toContain("const selectedFieldPhaseCommand = selectedFieldIsEigen");
    expect(source).toContain("const selectedFieldAnimationCommand = selectedFieldIsEigen");
    expect(source).toContain('"analysis.eigen.set-mode-3d-phase"');
    expect(source).toContain('"analysis.frequency-domain.set-3d-animation"');
    expect(source).toContain("fieldId: selectedFieldId");
    expect(source).toContain("analysisFieldViewSelectRef.current?.value");
    expect(dataPreviewSource).toContain("useDataPreviewFieldVector({");
    expect(dataPreviewSource).toContain("phaseRad: previewPhaseRad");
    expect(dataPreviewSource).toContain("view: previewView");
    expect(source).toContain("selectedEigenModePhaseInputRef.current?.value");
    expect(source).toContain("selectedEigenModeViewSelectRef.current?.value");
    expect(source).toContain("source: selectedFieldOverlaySource");
    expect(source).toContain('"analysis.eigen.set-mode-3d-animation"');
    expect(source).toContain("action === \"animate\"");
    expect(source).toContain("Stop selected frequency-domain field animation");
    expect(source).toContain('"analysis.frequency-domain.stop-3d-animation"');
    expect(displayControlsSource).toContain('"analysis.frequency-domain.set-3d-appearance"');
    expect(displayControlsSource).toContain("activeAnalysisFieldOverlay?.appearance?.surfaceColorSource");
    expect(displayControlsSource).toContain("activeAnalysisFieldOverlay?.appearance?.scalarColorPalette");
    expect(displayControlsSource).toContain("Mode component");
    expect(displayControlsSource).toContain("delta m_x");
    expect(displayControlsSource).toContain("delta m_y");
    expect(displayControlsSource).toContain("delta m_z");
    expect(displayControlsSource).toContain("activation?.fieldId");
    expect(displayControlsSource).toContain("activation.commandId");
    expect(displayControlsSource).toContain("source: activation.source");
    expect(displayControlsSource).toContain("fieldId: activation.fieldId");
    expect(displayControlsSource).toContain("isActiveAnalysisFieldView");
    expect(resultInspectorsSource).toContain("aria-pressed={isActive}");
    expect(resultInspectorsSource).toContain('variant={isActive ? "primary" : entry.variant}');
    expect(displayControlsSource).toContain("kernel.visualizationSync.queuePatch");
    expect(displayControlsSource).toContain("kernel.visualization.patchDefaults(\"part\"");
    expect(displayControlsSource).toContain("surfaceColorSource,");
    expect(displayControlsSource).toContain("surfaceColorSource: nextComponent");
    expect(displayControlsSource).toContain("quantity: {");
    expect(displayControlsSource).toContain("colormap: nextColormap");
    expect(source).toContain("selectedModeKey={");
    expect(source).toContain("modePointKey(selectedSpectrumMode)");
    expect(source).not.toContain(
      "key={`mode-browser-view:${modePointKey(selectedSpectrumMode)}`}",
    );
    expect(source).not.toContain(
      "key={`mode-browser-phase:${modePointKey(selectedSpectrumMode)}`}",
    );
    expect(source).not.toContain(
      "key={`mode-browser-rate:${modePointKey(selectedSpectrumMode)}`}",
    );
    expect(source).not.toContain(
      'key={`${selectedEigenModeFieldId ?? "none"}:selected-mode-view`}',
    );
    expect(source).not.toContain(
      'key={`${selectedEigenModeFieldId ?? "none"}:selected-mode-phase`}',
    );
    expect(source).not.toContain(
      'key={`${selectedEigenModeFieldId ?? "none"}:selected-mode-rate`}',
    );
  });

  it("renders dedicated diagnostic node detail for frequency-domain diagnostics", () => {
    const selection: Selection = {
      kind: "diagnostics.frequency_domain.solver",
      label: "Solver Diagnostics",
      moduleSource: "explorer",
      nodeId: "diagnostics:frequency-domain:solver",
      objectId: null,
      ref: {
        artifactPath: "response/diagnostics/solver.v1.json",
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
    expect(html).toContain("response/diagnostics/solver.v1.json");
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
      "3D mode fields, phase animation, and chart readiness",
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

      expect(html).not.toContain("Unknown Frequency-Domain");
      expect(html).not.toContain("unknown node kind");
      expect(html).not.toContain("family overview");
      expect(html).not.toContain("Analysis Resource Node Detail");
      expect(html).not.toContain("Frequency-Domain Job Node Detail");
      expect(html).not.toContain("Frequency-Domain Diagnostic Node Detail");
    },
  );

  it.each(EXPLORER_GENERATED_FREQUENCY_DOMAIN_NODE_KINDS)(
    "registers a dedicated inspector for explorer node %s",
    (kind) => {
      expect(FREQUENCY_DOMAIN_INSPECTOR_SELECTION_KINDS).toContain(kind);

      const detail = resolveFrequencyDomainNodeDetail({
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
      });

      expect(detail.title).not.toBe("Unknown Frequency-Domain");
      expect(detail.title).not.toMatch(/\bNode Detail\b/);
      expect(detail.visualization).not.toContain("unknown node kind");
    },
  );
});
