import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ANALYSIS_FREQUENCY_RESPONSE_MAGNETIC_SWEEP_V1_PATH,
  DATA_TABLE_COLUMNS_PATH,
  DATA_TABLE_PATH,
  DIAGNOSTICS_SOLVER_PROFILE_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
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
  runtimeCommandControlSessionStatusEquals,
  selectStudyRuntimeCommandSessionStatus,
  shouldLoadRuntimeCommandQueue,
  shouldLoadRuntimeCurrentRun,
  shouldLoadRuntimeMeshBuild,
  shouldLoadRuntimeMeshManifest,
  shouldLoadRuntimeMeshSummary,
  shouldLoadRuntimeScalars,
  shouldLoadRuntimeStageExecution,
  studyRuntimeCommandSessionStatusEquals,
} from "./studyRuntimeResources";

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

  it("loads shared-domain manifest only when FEM or explicit topology has a mesh revision", () => {
    expect(
      shouldLoadRuntimeMeshManifest(
        true,
        statusWith({ discretization: "fem" }),
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
