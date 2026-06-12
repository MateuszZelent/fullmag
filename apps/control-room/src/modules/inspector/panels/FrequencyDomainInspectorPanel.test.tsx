import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
  MESHING_PERIODIC_PAIRS_PATH,
} from "@/kernel/api/apiPaths";
import type { Selection } from "@/kernel/selection/selectionTypes";

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
  useFrequencyDomainEigenDispersionResource: () => emptyResource,
  useFrequencyDomainEigenModeFieldMetaResource: () => emptyResource,
  useFrequencyDomainEigenModeResource: () => ({
    ...emptyResource,
    data: {
      angular_frequency_rad_per_s: 75398223686.155,
      dominant_polarization: "counter_clockwise",
      frequency_imag_hz: -12000000,
      frequency_real_hz: 12000000000,
      imag: [[0, 1], [0, 0], [0.5, 0]],
      raw_mode_index: 2,
      real: [[1, 0], [0.25, 0], [0, -0.5]],
      residual_norm: 1e-8,
      sample_index: 0,
      schema_version: "2",
      tangent_leakage_max_abs: 1e-10,
    },
    revision: "mode:0:2",
    status: "ready",
  }),
  useFrequencyDomainEigenSpectrumResource: () => emptyResource,
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
          magnetic_cpu: { reason: "Dense validation", status: "ready" },
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
        reason: "modal solver pending",
        status: "unavailable",
        study_kind: "eigenmodes",
      },
      existing_frequency_response_namespace_preserved: true,
      family_namespace: "frequencyDomain",
      floquet_nonzero_k_demag_supported: false,
      response: {
        diagnostics_json: "{}",
        driven_response_available: false,
        dynamic_demag_k_available: false,
        floquet_modal_available: false,
        floquet_response_available: false,
        gpu_available: false,
        modal_solver_available: false,
        reason: "response solver pending",
        status: "unavailable",
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
          schema_version: "frequency_domain_manifest.v1",
          stage_kind: "frequency_response",
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
  useFrequencyDomainResponseFieldMetaResource: () => emptyResource,
  useFrequencyDomainResponseFrequencyPointResource: () => ({
    ...emptyResource,
    data: {
      artifact_path: "response/frequency_points/frequency_0001.json",
      missing_reason: null,
      payload: {
        absorbed_power_density: 42,
        angular_frequency_rad_per_s: 59690260418.206,
        frequency_hz: 9.5e9,
        relative_residual_l2_norm: 1e-9,
        residual_l2_norm: 2e-12,
        response_amplitude: [1.5, 0.25],
        response_phase: [0.1, -0.2],
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
  useFrequencyDomainResponseProgressResource: () => emptyResource,
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
    expect(html).toContain("Periodic / Floquet Boundary Conditions");
    expect(html).toContain(MESHING_PERIODIC_PAIRS_PATH);
    expect(html).toContain("Pair count");
    expect(html).toContain("x-periodic");
    expect(html).toContain("markers 11/12");
    expect(html).toContain("Dynamic demag-k");
    expect(html).toContain("dynamic demag-k is blocked for nonzero-k Floquet");
  });

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
    expect(html).toContain(
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH.replace(
        "{frequency_index}",
        "1",
      ),
    );
    expect(html).toContain("response/frequency_points/frequency_0001.json");
    expect(html).toContain("9500000000 Hz");
    expect(html).toContain("42 W/m^3");
    expect(html).toContain("Amplitude entries");
    expect(html).toContain("Phase entries");
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
    expect(html).toContain("Observable ID");
    expect(html).toContain("mx");
    expect(html).toContain("Observable points");
    expect(html).toContain("1");
    expect(html).toContain("9500000000-9500000000 Hz");
    expect(html).toContain("Mean amplitude");
    expect(html).toContain("1.5");
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH);
  });

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
        sampleIndex: 0,
        type: "frequency-domain",
      },
    };

    const html = renderToStaticMarkup(
      <FrequencyDomainInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Selected Eigen Mode");
    expect(html).toContain("eigen/modes/sample_0000/mode_0002.json");
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
    expect(html).toContain("Abs");
    expect(html).toContain("Phase");
    expect(html).toContain("Animate mode phase");
    expect(html).toContain("Animation rate");
    expect(html).toContain("Set phase");
    expect(html).toContain("Plot in 3D");
  });
});
