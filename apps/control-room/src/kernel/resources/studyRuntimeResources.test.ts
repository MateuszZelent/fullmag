import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
  ANALYSIS_EIGEN_MODE_V2_PATH,
  ANALYSIS_FREQUENCY_RESPONSE_MAGNETIC_SWEEP_V1_PATH,
  ANALYSIS_HYSTERESIS_FAMILY_PATH,
  DATA_TABLE_COLUMNS_PATH,
  DATA_TABLE_PATH,
  DIAGNOSTICS_SOLVER_PROFILE_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_PERIODIC_PAIRS_PATH,
  MESHING_SUMMARY_PATH,
  MODEL_SCENE_PATH,
  PERSISTENCE_CHECKPOINTS_PATH,
  SIMULATION_RUN_CURRENT_PATH,
  DATA_TABLE_ROWS_PATH,
  DATA_TABLES_PATH,
} from "../api/apiPaths";
import type { LiveStatusResource } from "../api/apiTypes";

import {
  STUDY_RUNTIME_CONTROL_RESOURCE_KEYS,
  frequencyDomainManifestRevision,
  frequencyDomainSweepProgressRevision,
  runtimeCommandControlSessionStatusEquals,
  selectStudyRuntimeCommandSessionStatus,
  shouldLoadRuntimeCommandQueue,
  shouldLoadRuntimeCurrentRun,
  shouldLoadFrequencyDomainManifest,
  shouldLoadRuntimeMeshBuild,
  shouldLoadRuntimeMeshManifest,
  shouldLoadRuntimeMeshSummary,
  shouldLoadRuntimeScalars,
  shouldLoadRuntimeStageExecution,
  studyRuntimeCommandSessionStatusEquals,
} from "./studyRuntimeResources";

const capability = (status: string, reason = "test fixture") => ({ status, reason });

const frequencyDomainCapabilityFixture = {
  boundary: {
    floquet_modal: capability("semantic_only"),
    floquet_response: capability("unsupported"),
    periodic_pair_diagnostics: capability("reference_executable"),
    static_periodic: capability("partial_production_executable"),
  },
  demag: {
    floquet_dynamic_k: capability("unsupported"),
    static_periodic_pbc: capability("semantic_only"),
  },
  dispersion: {
    branch_tracking: capability("reference_executable"),
    k_path: capability("reference_executable"),
  },
  modal: {
    absorption_from_modes: capability("unsupported"),
    k_path: capability("reference_executable"),
    linewidths: capability("reference_executable"),
    mode_field_payload: capability("reference_executable"),
    mode_tracking: capability("reference_executable"),
    production_cpu: capability("unsupported"),
    production_gpu: capability("unsupported"),
    reference_cpu: capability("reference_executable"),
  },
  response: {
    frequency_sweep: capability("reference_executable"),
    magnetic_cpu: capability("partial_production_executable"),
    magnetic_gpu: capability("unsupported"),
    magnetoelastic_elastodynamic: capability("unsupported"),
    magnetoelastic_quasistatic: capability("unsupported"),
    mode_projected: capability("unsupported"),
  },
  schema_version: "frequency_domain_capabilities.v1",
  validation: {
    fmr_k0: capability("source_visible"),
  },
  visualization: {
    modal_dispersion_chart: capability("reference_executable"),
    modal_spectrum_chart: capability("reference_executable"),
    mode_3d_overlay: capability("reference_executable"),
    mode_table: capability("reference_executable"),
    response_field_3d_overlay: capability("reference_executable"),
    response_sweep_chart: capability("reference_executable"),
  },
} as const;

const FREQUENCY_DOMAIN_MANIFEST = {
  capabilities: frequencyDomainCapabilityFixture,
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
    reason: "pending",
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
  response_cancel_requested: null,
  response_progress: null,
  result_manifest: null,
  schema_version: "frequency_domain_manifest.v1",
} as const;

const studyRuntimeResourcesUrl = new URL("./studyRuntimeResources.ts", import.meta.url);

const baseResources: LiveStatusResource["resources"] = {
  artifact_revision: 0,
  artifacts_revision: 0,
  command_completion_revision: 0,
  commands_revision: 0,
  display_revision: 0,
  domain_generation_id: 1,
  engine_log_revision: 0,
  field_catalog_revision: 0,
  field_revision: 0,
  fields_revision: 0,
  mesh_build_revision: 0,
  mesh_revision: 0,
  scalars_revision: 0,
  scene_revision: 1,
  slice_revision: 0,
  solver_profile_revision: 0,
  stages_revision: 0,
  topology_revision: 0,
  visualization_state_revision: 0,
  workspace_revision: 0,
};

function statusWith({
  discretization = "fdm",
  explicitTopology = false,
  resources = {},
  run = null,
  sessionId = "session-1",
}: {
  discretization?: string;
  explicitTopology?: boolean;
  resources?: Partial<LiveStatusResource["resources"]>;
  run?: LiveStatusResource["run"];
  sessionId?: string;
} = {}): Pick<
  LiveStatusResource,
  "capabilities" | "domain" | "resources" | "run" | "session"
> {
  return {
    capabilities: {
      algorithms_available: [],
      binary_fields: true,
      cell_fields: true,
      eigen_modes: false,
      explicit_topology: explicitTopology,
      gpu_telemetry: true,
      node_fields: explicitTopology,
      preview_2d: true,
      preview_3d: true,
      scalar_history: true,
      structured_grid: !explicitTopology,
    },
    domain: {
      cell_count: 1,
      discretization,
      generation_id: 1,
    },
    resources: { ...baseResources, ...resources },
    run,
    session: {
      created_at: "2026-05-29T00:00:00.000Z",
      name: "Test session",
      session_id: sessionId,
      workspace_root: "/tmp/fullmag-test",
    },
  };
}

describe("study runtime command resource bundles", () => {
  it("selects only command-control session status fields for always-mounted controls", () => {
    const source = readFileSync(studyRuntimeResourcesUrl, "utf8");
    const controlHook = source.slice(
      source.indexOf("export function useRuntimeCommandControlResourceData"),
      source.indexOf("export function useObjectMetricsResource"),
    );

    expect(source).toContain("selectRuntimeCommandControlSessionStatus");
    expect(source).toContain("runtimeCommandControlSessionStatusEquals");
    expect(controlHook).toContain(
      "useSessionStatusSelector(selectRuntimeCommandControlSessionStatus",
    );
    expect(controlHook).not.toContain("useSessionStatus()");
  });

  it("treats session identity changes as runtime command control changes", () => {
    const previous = statusWith({
      resources: { commands_revision: 2, scene_revision: 8 },
      sessionId: "session-old",
    }) as LiveStatusResource;
    const next = statusWith({
      resources: { commands_revision: 2, scene_revision: 8 },
      sessionId: "session-new",
    }) as LiveStatusResource;

    expect(runtimeCommandControlSessionStatusEquals(previous, next)).toBe(false);
  });

  it("treats run identity changes as runtime command control changes", () => {
    const previous = statusWith({
      resources: { commands_revision: 2, scene_revision: 8 },
      run: {
        run_id: "run-old",
        solver_steps: 0,
        solver_time: 0,
        stage_count: 1,
        stage_index: 0,
        stage_label: "relax",
        started_at: "0",
      },
    }) as LiveStatusResource;
    const next = statusWith({
      resources: { commands_revision: 2, scene_revision: 8 },
      run: {
        run_id: "run-new",
        solver_steps: 0,
        solver_time: 0,
        stage_count: 1,
        stage_index: 0,
        stage_label: "relax",
        started_at: "0",
      },
    }) as LiveStatusResource;

    expect(runtimeCommandControlSessionStatusEquals(previous, next)).toBe(false);
  });

  it("treats command completion revision changes as runtime command control changes", () => {
    const previous = statusWith({
      resources: {
        command_completion_revision: 3,
        commands_revision: 4,
        stages_revision: 2,
      },
    }) as LiveStatusResource;
    const next = statusWith({
      resources: {
        command_completion_revision: 4,
        commands_revision: 4,
        stages_revision: 2,
      },
    }) as LiveStatusResource;

    expect(runtimeCommandControlSessionStatusEquals(previous, next)).toBe(false);
  });

  it("selects only command-palette session status fields for the full runtime command bundle", () => {
    const source = readFileSync(studyRuntimeResourcesUrl, "utf8");
    const commandBundleHook = source.slice(
      source.indexOf("export function useStudyRuntimeCommandResourceData"),
      source.indexOf("export function useRuntimeCommandControlResourceData"),
    );

    expect(source).toContain("selectStudyRuntimeCommandSessionStatus");
    expect(source).toContain("studyRuntimeCommandSessionStatusEquals");
    expect(commandBundleHook).toMatch(
      /useSessionStatusSelector\(\s*selectStudyRuntimeCommandSessionStatus/,
    );
    expect(commandBundleHook).not.toContain("useSessionStatus()");
    expect(commandBundleHook).not.toContain("sessionStatus.data");
  });

  it("treats command completion revision changes as full runtime command state changes", () => {
    const previous = selectStudyRuntimeCommandSessionStatus({
      data: statusWith({
        resources: {
          command_completion_revision: 3,
          commands_revision: 4,
          stages_revision: 2,
        },
      }) as LiveStatusResource,
    });
    const next = selectStudyRuntimeCommandSessionStatus({
      data: statusWith({
        resources: {
          command_completion_revision: 4,
          commands_revision: 4,
          stages_revision: 2,
        },
      }) as LiveStatusResource,
    });

    expect(studyRuntimeCommandSessionStatusEquals(previous, next)).toBe(false);
  });

  it("treats domain generation changes as full runtime command state changes", () => {
    const previous = selectStudyRuntimeCommandSessionStatus({
      data: statusWith({
        discretization: "fem",
        resources: {
          domain_generation_id: 0,
          mesh_revision: 0,
        },
      }) as LiveStatusResource,
    });
    const next = selectStudyRuntimeCommandSessionStatus({
      data: statusWith({
        discretization: "fem",
        resources: {
          domain_generation_id: 5,
          mesh_revision: 0,
        },
      }) as LiveStatusResource,
    });

    expect(studyRuntimeCommandSessionStatusEquals(previous, next)).toBe(false);
  });

  it("keeps always-mounted command controls off the full runtime resource bundle", () => {
    expect(STUDY_RUNTIME_CONTROL_RESOURCE_KEYS).not.toEqual(
      expect.arrayContaining([
        DIAGNOSTICS_SOLVER_PROFILE_PATH,
        MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
        MESHING_SUMMARY_PATH,
        MODEL_SCENE_PATH,
        PERSISTENCE_CHECKPOINTS_PATH,
        SIMULATION_RUN_CURRENT_PATH,
      ]),
    );
  });

  it("exposes the magnetic response sweep artifact as an optional runtime resource", () => {
    const source = readFileSync(studyRuntimeResourcesUrl, "utf8");
    const hookSource = source.slice(
      source.indexOf("export function useMagneticResponseSweepResource"),
      source.indexOf("export function useStudyRuntimeCommandResourceData"),
    );

    expect(ANALYSIS_FREQUENCY_RESPONSE_MAGNETIC_SWEEP_V1_PATH).toBeTruthy();
    expect(hookSource).toMatch(/api\.analysis\.frequencyResponse\s*\.magneticSweepV1/);
    expect(hookSource).toContain("ignoreMissingResource<MagneticResponseSweepResource>");
    expect(hookSource).toContain(
      "resourceKey: ANALYSIS_FREQUENCY_RESPONSE_MAGNETIC_SWEEP_V1_PATH",
    );
  });

  it("exposes the frequency-domain family manifest as a revision-gated analysis resource", () => {
    const source = readFileSync(studyRuntimeResourcesUrl, "utf8");
    const hookSource = source.slice(
      source.indexOf("export function useFrequencyDomainManifestResource"),
      source.indexOf("export function useHysteresisPointsResource"),
    );

    expect(ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH).toBeTruthy();
    expect(hookSource).toMatch(/api\.analysis\.frequencyDomain\s*\.manifestV1/);
    expect(hookSource).toContain(
      "ignoreMissingResource<FrequencyDomainManifestResource>",
    );
    expect(hookSource).toContain(
      "resourceKey: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH",
    );
    expect(shouldLoadFrequencyDomainManifest(true, statusWith())).toBe(false);
    expect(
      shouldLoadFrequencyDomainManifest(
        true,
        statusWith({ resources: { artifact_revision: 2 } }),
      ),
    ).toBe(true);
    expect(
      shouldLoadFrequencyDomainManifest(
        true,
        statusWith({ resources: { artifacts_revision: 3 } }),
      ),
    ).toBe(true);
    expect(
      shouldLoadFrequencyDomainManifest(
        true,
        statusWith({ resources: { stages_revision: 4 } }),
      ),
    ).toBe(true);
  });

  it("exposes mesh periodic pairs as a revision-gated meshing resource", () => {
    const source = readFileSync(studyRuntimeResourcesUrl, "utf8");
    const hookSource = source.slice(
      source.indexOf("export function useMeshPeriodicPairsResource"),
      source.indexOf("export function useHysteresisStagePlanResource"),
    );

    expect(MESHING_PERIODIC_PAIRS_PATH).toBeTruthy();
    expect(hookSource).toMatch(/api\.meshing\s*\.periodicPairs/);
    expect(hookSource).toContain(
      "ignoreMissingResource<MeshPeriodicPairsResource>",
    );
    expect(hookSource).toContain(
      "resourceKey: MESHING_PERIODIC_PAIRS_PATH",
    );
    expect(hookSource).toContain(
      "resolveRevision: (data) => data?.revision ?? null",
    );
  });

  it("changes the frequency-domain manifest revision when artifact state changes", () => {
    const baseRevision = frequencyDomainManifestRevision(
      FREQUENCY_DOMAIN_MANIFEST,
    );
    const progressRevision = frequencyDomainManifestRevision({
      ...FREQUENCY_DOMAIN_MANIFEST,
      response_progress: {
        complete: false,
        completed_frequency_points: 1,
        current_frequency_hz: 1.0e9,
        latest_artifact_manifest_path: "response/artifact_manifest.json",
        missing_reason: null,
        partial_artifacts_available: true,
        progress_json:
          '{"schema_version":"frequency_domain_sweep_progress.v1","state":"running"}',
        schema_version: "frequency_domain_sweep_progress.v1",
        state: "running",
        status: "ready",
        total_frequency_points: 4,
        written_frequency_point_artifacts: 1,
      },
    });
    const cancelRevision = frequencyDomainManifestRevision({
      ...FREQUENCY_DOMAIN_MANIFEST,
      response_cancel_requested: {
        complete: false,
        completed_frequency_points: 1,
        current_frequency_hz: 1.0e9,
        latest_artifact_manifest_path: "response/artifact_manifest.json",
        missing_reason: null,
        partial_artifacts_available: true,
        progress_json:
          '{"schema_version":"frequency_domain_sweep_progress.v1","state":"cancel_requested"}',
        schema_version: "frequency_domain_sweep_progress.v1",
        state: "cancel_requested",
        status: "cancel_requested",
        total_frequency_points: 4,
        written_frequency_point_artifacts: 1,
      },
    });
    const resultRevision = frequencyDomainManifestRevision({
      ...FREQUENCY_DOMAIN_MANIFEST,
      result_manifest: {
        artifact_path: "frequency_domain/manifest.v1.json",
        missing_reason: null,
        payload: { schema_version: "frequency_domain_manifest.v1" },
        resource_key: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
        schema_version: "frequency_domain_manifest.v1",
        status: "ready",
      },
    });

    expect(progressRevision).not.toBe(baseRevision);
    expect(cancelRevision).not.toBe(baseRevision);
    expect(resultRevision).not.toBe(baseRevision);
  });

  it("changes frequency-domain progress revision for partial artifact state", () => {
    const baseProgress = {
      complete: false,
      completed_frequency_points: 1,
      current_frequency_hz: 1.0e9,
      latest_artifact_manifest_path: "frequency_domain/manifest.v1.json",
      missing_reason: null,
      partial_artifacts_available: true,
      progress_json:
        '{"schema_version":"frequency_domain_sweep_progress.v1","state":"interrupted"}',
      schema_version: "frequency_domain_sweep_progress.v1",
      state: "interrupted",
      status: "interrupted",
      total_frequency_points: 4,
      written_frequency_point_artifacts: 1,
    };
    const baseRevision = frequencyDomainSweepProgressRevision(baseProgress);

    expect(
      frequencyDomainSweepProgressRevision({
        ...baseProgress,
        written_frequency_point_artifacts: 2,
      }),
    ).not.toBe(baseRevision);
    expect(
      frequencyDomainSweepProgressRevision({
        ...baseProgress,
        partial_artifacts_available: false,
      }),
    ).not.toBe(baseRevision);
    expect(
      frequencyDomainSweepProgressRevision({
        ...baseProgress,
        latest_artifact_manifest_path: "frequency_domain/manifest.partial.v1.json",
      }),
    ).not.toBe(baseRevision);
  });

  it("uses the full frequency-domain progress revision key in progress hooks", () => {
    const source = readFileSync(studyRuntimeResourcesUrl, "utf8");
    const hookSource = source.slice(
      source.indexOf("export function useFrequencyDomainResponseProgressResource"),
      source.indexOf("export function useFrequencyDomainResponseDiagnosticsResource"),
    );

    expect(hookSource).toContain(
      "resolveRevision: frequencyDomainSweepProgressRevision",
    );
    expect(hookSource).toContain(
      "resourceKey: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH",
    );
    expect(hookSource).toContain(
      "resourceKey: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH",
    );
  });

  it("exposes the hysteresis angular family as a revision-gated analysis resource", () => {
    const source = readFileSync(studyRuntimeResourcesUrl, "utf8");
    const hookSource = source.slice(
      source.indexOf("export function useHysteresisFamilyResource"),
      source.indexOf("export function useHysteresisMinorLoopsResource"),
    );

    expect(ANALYSIS_HYSTERESIS_FAMILY_PATH).toBeTruthy();
    expect(hookSource).toMatch(/api\.analysis\.hysteresis\s*\.family/);
    expect(hookSource).toContain(
      "ignoreMissingResource<HysteresisAngularFamilyResource>",
    );
    expect(hookSource).toContain(
      "resourceKey = stageId",
    );
    expect(hookSource).toContain(
      "resolveRevision: (data) => data?.revision ?? null",
    );
  });

  it("exposes frequency-domain artifact resources through the family facade", () => {
    const source = readFileSync(studyRuntimeResourcesUrl, "utf8");
    const hookSource = source.slice(
      source.indexOf("export function useFrequencyDomainEigenSpectrumResource"),
      source.indexOf("export function useHysteresisPointsResource"),
    );

    expect(ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH).toBeTruthy();
    expect(ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH).toBeTruthy();
    expect(
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
    ).toBeTruthy();
    expect(ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH).toBeTruthy();
    expect(ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH).toBeTruthy();
    expect(ANALYSIS_EIGEN_MODE_V2_PATH).toBeTruthy();
    expect(hookSource).toMatch(/analysis\.eigen\.eigenSpectrumV2/);
    expect(hookSource).toMatch(/analysis\.eigen\s*\.modeV2/);
    expect(hookSource).toMatch(/frequencyDomain\.responseMagneticSweep/);
    expect(hookSource).toMatch(/frequencyDomain\s*\.responseCancelRequestedV1/);
    expect(hookSource).toMatch(/frequencyDomain\.responseProgressV1/);
    expect(hookSource).toContain(
      "ignoreMissingResource<FrequencyDomainSweepProgressResource>",
    );
    expect(hookSource).toContain("useMagneticResponseSweepV2Resource");
    expect(hookSource).toContain("useFrequencyResponsePointResource");
    expect(hookSource).toContain("useFrequencyResponseFieldMetaResource");
    expect(hookSource).toMatch(/analysis\.eigen\.eigenModeFieldMeta/);
    expect(hookSource).toContain(
      "ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH",
    );
    expect(hookSource).toContain(
      "ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH",
    );
    expect(hookSource).toContain(
      "ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH",
    );
    expect(hookSource).toContain(
      "ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH",
    );
    expect(hookSource).toContain("ANALYSIS_EIGEN_MODE_V2_PATH");
  });

  it("keeps frequency-domain resource hooks free of raw v2 endpoint strings", () => {
    const source = readFileSync(studyRuntimeResourcesUrl, "utf8");
    const hookSource = source.slice(
      source.indexOf("export function useFrequencyDomainManifestResource"),
      source.indexOf("export function useHysteresisPointsResource"),
    );
    const frequencyDomainFamilyPath =
      ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH.replace("/manifest.v1", "");

    expect(hookSource).not.toContain(frequencyDomainFamilyPath);
  });

  it("does not load stage execution for idle command controls", () => {
    expect(
      shouldLoadRuntimeStageExecution(true, statusWith()),
    ).toBe(false);
    expect(shouldLoadRuntimeStageExecution(true, null)).toBe(false);
    expect(
      shouldLoadRuntimeStageExecution(
        true,
        statusWith({ resources: { stages_revision: 9 } }),
      ),
    ).toBe(true);
  });

  it("loads command queue only after status reports a command revision", () => {
    expect(shouldLoadRuntimeCommandQueue(true, statusWith())).toBe(false);
    expect(shouldLoadRuntimeCommandQueue(false, statusWith({
      resources: { commands_revision: 3 },
    }))).toBe(false);
    expect(
      shouldLoadRuntimeCommandQueue(
        true,
        statusWith({ resources: { commands_revision: 3 } }),
      ),
    ).toBe(true);
  });

  it("loads mesh build resources only after a mesh build revision exists", () => {
    expect(shouldLoadRuntimeMeshBuild(true, statusWith())).toBe(false);
    expect(
      shouldLoadRuntimeMeshBuild(
        true,
        statusWith({ resources: { mesh_build_revision: 4 } }),
      ),
    ).toBe(true);
  });

  it("loads mesh summaries after either mesh or mesh-build data exists", () => {
    expect(shouldLoadRuntimeMeshSummary(true, statusWith())).toBe(false);
    expect(
      shouldLoadRuntimeMeshSummary(
        true,
        statusWith({ resources: { mesh_build_revision: 4 } }),
      ),
    ).toBe(true);
    expect(
      shouldLoadRuntimeMeshSummary(
        true,
        statusWith({ resources: { mesh_revision: 5 } }),
      ),
    ).toBe(true);
  });

  it("loads shared-domain manifest when FEM or explicit topology has a mesh or domain revision", () => {
    expect(
      shouldLoadRuntimeMeshManifest(
        true,
        statusWith({
          discretization: "fem",
          resources: { domain_generation_id: 0 },
        }),
      ),
    ).toBe(false);
    expect(
      shouldLoadRuntimeMeshManifest(
        true,
        statusWith({ resources: { mesh_revision: 5 } }),
      ),
    ).toBe(false);
    expect(
      shouldLoadRuntimeMeshManifest(
        true,
        statusWith({
          discretization: "fem",
          resources: { mesh_revision: 5 },
        }),
      ),
    ).toBe(true);
    expect(
      shouldLoadRuntimeMeshManifest(
        true,
        statusWith({
          discretization: "fem",
          resources: { domain_generation_id: 5, mesh_revision: 0 },
        }),
      ),
    ).toBe(true);
    expect(
      shouldLoadRuntimeMeshManifest(
        true,
        statusWith({
          explicitTopology: true,
          resources: { mesh_revision: 5 },
        }),
      ),
    ).toBe(true);
  });

  it("loads current run and scalar resources only after status points at data", () => {
    expect(shouldLoadRuntimeCurrentRun(true, statusWith())).toBe(false);
    expect(
      shouldLoadRuntimeCurrentRun(
        true,
        statusWith({
          run: {
            run_id: "run-1",
            solver_steps: 0,
            solver_time: 0,
            stage_count: 1,
            stage_index: 0,
            stage_label: "relax",
            started_at: "0",
          },
        }),
      ),
    ).toBe(true);
    expect(shouldLoadRuntimeScalars(true, statusWith())).toBe(false);
    expect(
      shouldLoadRuntimeScalars(
        true,
        statusWith({ resources: { scalars_revision: 7 } }),
      ),
    ).toBe(true);
  });

  it("uses a revision-driven table rows resource without interval polling", () => {
    const source = readFileSync(studyRuntimeResourcesUrl, "utf8");
    const tableHook = source.slice(
      source.indexOf("export function useTableListResource"),
      source.indexOf("export function useCheckpointCatalogResource"),
    );
    const rowsHook = source.slice(
      source.indexOf("export function useTableRowsResource"),
      source.indexOf("export function useCheckpointCatalogResource"),
    );
    const binaryRowsHook = source.slice(
      source.indexOf("export function useTableRowsBinaryResource"),
      source.indexOf("export function useCheckpointCatalogResource"),
    );

    expect(source).toContain("export function useTableListResource");
    expect(source).toContain("export function useTableResource");
    expect(source).toContain("export function useTableColumnsResource");
    expect(source).toContain("export function useTableRowsResource");
    expect(source).toContain("export function useTableRowsBinaryResource");
    expect(tableHook).toContain(".list(");
    expect(tableHook).toContain(".detail(");
    expect(tableHook).toContain(".columns(");
    expect(tableHook).toContain("api.data.tables");
    expect(rowsHook).toContain(".rows(");
    expect(binaryRowsHook).toContain(".rowsBinary(");
    expect(binaryRowsHook).toContain("}#binary`");
    expect(rowsHook).toContain("tableRowsResourceKey");
    expect(binaryRowsHook).toContain("tableRowsResourceKey");
    expect(rowsHook).toContain("minRefetchIntervalMs");
    expect(binaryRowsHook).toContain("minRefetchIntervalMs");
    expect(tableHook).not.toContain("setInterval");
    expect(DATA_TABLES_PATH).toBe(
      ["", "v2", "sessions", "current", "data", "tables"].join("/"),
    );
    expect(DATA_TABLE_PATH).toBe(
      ["", "v2", "sessions", "current", "data", "tables", "{table_id}"].join("/"),
    );
    expect(DATA_TABLE_COLUMNS_PATH).toBe(
      ["", "v2", "sessions", "current", "data", "tables", "{table_id}", "columns"].join("/"),
    );
    expect(DATA_TABLE_ROWS_PATH).toBe(
      ["", "v2", "sessions", "current", "data", "tables", "{table_id}", "rows"].join("/"),
    );
  });
});
