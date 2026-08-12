import { describe, expect, it } from "vitest";

import {
  DATA_ARTIFACTS_PATH,
  DATA_FIELDS_PATH,
  DATA_TABLES_PATH,
  SIMULATION_COMMAND_DETAIL_PATH,
  SIMULATION_RUN_CURRENT_PATH,
} from "@/kernel/api/apiPaths";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import type { RuntimeCommandDetailEntry } from "@/kernel/resources/runtimeExplorerTypes";
import type {
  CommandDetailResource,
  CommandQueueStatusResource,
  CurrentRunResource,
  FieldCatalogResource,
  GeometryValidationResource,
  HealthResource,
  LiveStatusResource,
  MeshSharedDomainManifestResource,
  PlatformCapabilitiesResource,
  SolverProfileResource,
  SolverStatusResource,
  StageExecutionResource,
  TableListResource,
} from "@/kernel/api/apiTypes";

import { flattenExplorerNodes } from "./buildModelTree";
import { buildRuntimeDiagnosticTree } from "./diagnosticExplorerNodes";
import { buildRuntimeJobTree } from "./jobExplorerNodes";
import { buildRuntimeResourceTree } from "./resourceExplorerNodes";
import {
  runtimeExplorerSnapshotFromResources,
  runtimeResourceSnapshot,
  type RuntimeResourceSnapshot,
} from "./runtimeExplorerSnapshot";

function ready<T>(data: T, revision: number | string | null): RuntimeResourceSnapshot<T> {
  return { data, error: null, missing: false, revision, status: "ready" };
}

function unavailable<T>(): RuntimeResourceSnapshot<T> {
  return { data: null, error: null, missing: false, revision: null, status: "ready" };
}

function stale<T>(data: T, revision: number | string): RuntimeResourceSnapshot<T> {
  return { data, error: null, missing: false, revision, status: "stale" };
}

const currentRun: CurrentRunResource = {
  artifact_dir: "/runs/run-12",
  requested_backend: "fdm",
  requested_device: "gpu",
  requested_mode: "gpu",
  requested_precision: "double",
  resolved_backend: "fdm-cuda",
  resolved_device: "cuda:0",
  resolved_engine_id: "fdm-cuda-double",
  resolved_mode: "gpu",
  resolved_precision: "double",
  resolved_runtime_family: "cuda",
  resolved_worker: "local",
  revision: 12,
  run_id: "run-12",
  session_id: "session-1",
  started_at: "2026-08-12T10:00:00Z",
  status: "running",
  total_steps: 45,
};

const stageExecution: StageExecutionResource = {
  active_stage_index: 0,
  active_stage_kind: "relax",
  completed_stage_indexes: [],
  revision: 7,
  runtime_state: "running",
  stage_statuses: ["running"],
  stages: [{
    converged: false,
    command_id: "command-1",
    index: 0,
    kind: "relax",
    label: "Relax",
    stage_id: "relax-0",
    status: "running",
  }],
  total_stages: 1,
};

const commandQueue: CommandQueueStatusResource = {
  accepted_count: 1,
  can_accept_commands: true,
  commands: [{
    command_id: "command-1",
    created_at_unix_ms: 1,
    kind: "relax",
    seq: 3,
    status: "running",
  }],
  completed_count: 0,
  dispatched_count: 1,
  failed_count: 0,
  pending_count: 0,
  rejected_count: 0,
  revision: 3,
  running_count: 1,
  runtime_controls: [],
};

const commandDetail: CommandDetailResource = {
  command_id: "command-1",
  created_at_unix_ms: 1,
  kind: "relax",
  requested_execution: {
    backend: "fdm",
    device: "gpu",
    precision: "double",
  },
  resolved_execution: {
    backend: "fdm-cuda",
    device: "cuda:0",
    precision: "double",
    runtime_family: "cuda",
  },
  run_id: "run-12",
  seq: 3,
  status: "running",
};

const commandDetailEntry: RuntimeCommandDetailEntry = {
  commandId: commandDetail.command_id,
  data: commandDetail,
  error: null,
  missing: false,
  revision: commandDetail.seq,
  status: "ready",
};

function snapshot() {
  return runtimeExplorerSnapshotFromResources({
    artifacts: ready([{
      kind: "zarr",
      path: "/runs/run-12/result.zarr",
    }], "artifacts:/runs/run-12/result.zarr:zarr"),
    commandDetails: ready([commandDetailEntry], "command-details:3"),
    commandQueue: ready(commandQueue, 3),
    currentRun: ready(currentRun, 12),
    fieldCatalog: ready<FieldCatalogResource>({
      domain_generation_id: "domain-generation-4",
      quantities: [],
      revision: 21,
    }, 21),
    frequencyDomainManifest: unavailable(),
    geometryValidation: unavailable<GeometryValidationResource>(),
    meshManifest: unavailable<MeshSharedDomainManifestResource>(),
    platformCapabilities: unavailable<PlatformCapabilitiesResource>(),
    platformHealth: unavailable<HealthResource>(),
    sessionStatus: unavailable<LiveStatusResource>(),
    solverProfile: unavailable<SolverProfileResource>(),
    solverStatus: unavailable<SolverStatusResource>(),
    stageExecution: ready(stageExecution, 7),
    tableCatalog: ready<TableListResource>({
      revision: 8,
      tables: [{
        binary_rows_href: "/tables/default/rows.bin",
        columns: [],
        columns_href: "/tables/default/columns",
        revision: 8,
        rows_href: "/tables/default/rows",
        schema_revision: 2,
        table_id: "default",
        total_rows: 42,
      }],
    }, 8),
  });
}

describe("runtime-backed Explorer tabs", () => {
  it("publishes resources only from typed descriptors and keeps unknown metadata unavailable", () => {
    const runtime = snapshot();
    const nodes = flattenExplorerNodes(buildRuntimeResourceTree(runtime.resources));
    const run = nodes.find((node) => node.id === "resources:simulation:current-run");
    const runDescriptor = runtime.resources.find((descriptor) => descriptor.id === run?.id);

    expect(run).toMatchObject({
      kind: "resources.runtime",
      resourceState: "ready",
      status: "ready",
      runtimeDescriptorId: "resources:simulation:current-run",
      runtimeResourceKey: SIMULATION_RUN_CURRENT_PATH,
    });
    expect(runDescriptor?.detail).toMatchObject({
        cache: null,
        generation: null,
        key: SIMULATION_RUN_CURRENT_PATH,
        location: "/runs/run-12",
        owner: "run:run-12",
        revision: 12,
        schema: null,
        sizeBytes: null,
    });
  });

  it("publishes the typed field, table, and artifact catalogs with honest facets", () => {
    const resources = snapshot().resources;

    expect(resources.find((resource) => resource.id === "resources:data:fields")?.detail)
      .toMatchObject({
        generation: "domain-generation-4",
        key: DATA_FIELDS_PATH,
        location: null,
        owner: null,
        revision: 21,
      });
    expect(resources.find((resource) => resource.id === "resources:data:fields")?.detail.facts)
      .toEqual(expect.arrayContaining([
        { label: "Quantities", value: "0" },
        { label: "Available", value: "0" },
      ]));
    expect(resources.find((resource) => resource.id === "resources:data:tables")?.detail)
      .toMatchObject({ key: DATA_TABLES_PATH, location: null, owner: null, revision: 8 });
    expect(resources.find((resource) => resource.id === "resources:data:tables")?.detail.facts)
      .toEqual(expect.arrayContaining([
        { label: "Tables", value: "1" },
        { label: "Rows", value: "42" },
      ]));
    expect(resources.find((resource) => resource.id === "resources:data:artifacts")?.detail)
      .toMatchObject({
        key: DATA_ARTIFACTS_PATH,
        location: null,
        owner: null,
        revision: "artifacts:/runs/run-12/result.zarr:zarr",
      });
    expect(resources.find((resource) => resource.id === "resources:data:artifacts")?.detail.facts)
      .toEqual(expect.arrayContaining([
        { label: "Artifacts", value: "1" },
        { label: "Kinds", value: "zarr:1" },
      ]));
  });

  it("builds jobs only from real run, stage, and command lifecycle", () => {
    const nodes = flattenExplorerNodes(buildRuntimeJobTree(snapshot().jobs));

    expect(nodes.map((node) => node.id)).toEqual([
      "jobs:root",
      "jobs:run:run-12",
      "jobs:stage:run%3Arun-12:relax-0",
      "jobs:command:command-1",
    ]);
    expect(snapshot().jobs.find((job) => job.id === "jobs:run:run-12")?.detail)
      .toMatchObject({
        lifecycleStatus: "running",
        requestedExecution: {
          backend: "fdm",
          device: "gpu",
          precision: "double",
        },
        resolvedExecution: {
          backend: "fdm-cuda",
          device: "cuda:0",
          precision: "double",
        },
      });
    expect(snapshot().jobs.find((job) => job.id === "jobs:command:command-1")?.detail)
      .toMatchObject({
        lifecycleStatus: "running",
        key: SIMULATION_COMMAND_DETAIL_PATH.replace(
          "{command_id}",
          encodeURIComponent("command-1"),
        ),
        requestedExecution: { backend: "fdm", device: "gpu" },
        resolvedExecution: { backend: "fdm-cuda", device: "cuda:0" },
      });
  });

  it("never borrows owner identity from the current run", () => {
    const runtime = runtimeExplorerSnapshotFromResources({
      ...snapshot().source,
      commandDetails: unavailable<RuntimeCommandDetailEntry[]>(),
      currentRun: ready({ ...currentRun, run_id: "new-run", revision: 13 }, 13),
      solverStatus: stale({
        can_accept_commands: false,
        is_busy: false,
        revision: 4,
        run_id: "old-run",
        runtime_state: "idle",
        runtime_status_code: "idle",
        runtime_status_kind: "idle",
        session_status: "ready",
        warnings: [],
      }, 4),
    });

    expect(runtime.resources.find((resource) => resource.id === "resources:simulation:stages")?.detail.owner)
      .toBeNull();
    expect(runtime.resources.find((resource) => resource.id === "resources:simulation:solver-status")?.detail.owner)
      .toBeNull();
    expect(runtime.resources.find((resource) => resource.id === "resources:diagnostics:solver-profile")?.detail.owner)
      .toBeNull();
    expect(runtime.resources.find((resource) => resource.id === "resources:analysis:frequency-domain:manifest")?.detail.owner)
      .toBeNull();
    expect(runtime.jobs.find((job) => job.kind === "stage")).toMatchObject({
      id: "jobs:stage:unverified:7:0:relax-0",
      selectable: false,
    });
    expect(runtime.jobs.find((job) => job.kind === "stage")?.detail.owner).toBeNull();
  });

  it("does not render a queue when no command owner resource exists", () => {
    const empty = runtimeExplorerSnapshotFromResources({
      ...snapshot().source,
      commandDetails: unavailable<RuntimeCommandDetailEntry[]>(),
      commandQueue: unavailable<CommandQueueStatusResource>(),
    });
    const nodes = flattenExplorerNodes(buildRuntimeJobTree(empty.jobs));

    expect(nodes.some((node) => node.id.startsWith("jobs:command:"))).toBe(false);
    expect(nodes[0]).toMatchObject({ status: "running" });
  });

  it("keeps stale and error resources visibly non-ready", () => {
    const staleRun = runtimeExplorerSnapshotFromResources({
      ...snapshot().source,
      currentRun: stale(currentRun, 12),
      solverStatus: {
        data: null,
        error: "solver status request failed",
        missing: false,
        revision: 9,
        status: "error",
      },
    });
    const resources = flattenExplorerNodes(buildRuntimeResourceTree(staleRun.resources));
    const diagnostics = flattenExplorerNodes(
      buildRuntimeDiagnosticTree(staleRun.diagnostics),
    );
    const jobs = flattenExplorerNodes(buildRuntimeJobTree(staleRun.jobs));

    expect(resources.find((node) => node.id === "resources:simulation:current-run"))
      .toMatchObject({ resourceState: "stale", status: "stale" });
    expect(jobs.find((node) => node.id === "jobs:root"))
      .toMatchObject({ availability: "partial", resourceState: "stale", status: "stale" });
    expect(diagnostics.find((node) => node.id === "diagnostics:solver"))
      .toMatchObject({ resourceState: "error", status: "failed" });
  });

  it("marks mixed roots partial instead of presenting a ready branch", () => {
    const runtime = runtimeExplorerSnapshotFromResources({
      ...snapshot().source,
      platformHealth: ready({
        active_session: true,
        api_contract_version: "1.0.0",
        status: "ok",
        uptime_seconds: 4,
      }, 4),
    });
    const resources = flattenExplorerNodes(buildRuntimeResourceTree(runtime.resources));
    const diagnostics = flattenExplorerNodes(buildRuntimeDiagnosticTree(runtime.diagnostics));

    expect(resources.find((node) => node.id === "resources:root"))
      .toMatchObject({ availability: "partial", status: "warning" });
    expect(diagnostics.find((node) => node.id === "diagnostics:root"))
      .toMatchObject({ availability: "partial", status: "warning" });
  });

  it.each([
    ["partial", "warning"],
    ["degraded", "degraded"],
    ["error", "failed"],
    ["stale", "stale"],
  ] as const)("maps %s runtime conditions without presenting ready or completed", (condition, expected) => {
    const runtime = runtimeExplorerSnapshotFromResources({
      ...snapshot().source,
      platformHealth: condition === "stale"
        ? stale({
            active_session: true,
            api_contract_version: "1.0.0",
            status: "ok",
            uptime_seconds: 4,
          }, 4)
        : ready({
            active_session: true,
            api_contract_version: "1.0.0",
            status: condition,
            uptime_seconds: 4,
          }, 4),
    });
    const node = flattenExplorerNodes(
      buildRuntimeDiagnosticTree(runtime.diagnostics),
    ).find((entry) => entry.id === "diagnostics:health");
    const descriptor = runtime.diagnostics.find(
      (entry) => entry.id === "diagnostics:health",
    );

    expect(node?.status).toBe(expected);
    expect(node?.status).not.toBe("ready");
    expect(node?.executionState).not.toBe("completed");
    expect(descriptor?.detail.condition).toBe(expected);
  });

  it("maps loaded diagnostic errors, warnings, and mesh fallbacks conservatively", () => {
    const runtime = runtimeExplorerSnapshotFromResources({
      ...snapshot().source,
      geometryValidation: ready({
        backend_target: "fdm",
        diagnostics: [{
          code: "geometry.invalid",
          id: "geometry.invalid",
          message: "Geometry is invalid.",
          severity: "error",
        }],
        dirty: false,
        scene_revision: 9,
        status: "ready",
      }, 9),
      meshManifest: ready({
        fallbacks_triggered: ["surface triangulation fallback"],
        mesh_id: "mesh-4",
        mesh_name: "Shared domain",
        revision: 4,
        topology_fingerprint: "mesh-fingerprint",
      }, 4),
      solverStatus: ready({
        can_accept_commands: false,
        is_busy: false,
        last_error: null,
        revision: 4,
        runtime_state: "running",
        runtime_status_code: "running",
        runtime_status_kind: "running",
        session_status: "running",
        warnings: ["step size reduced"],
      }, 4),
    });
    const nodes = flattenExplorerNodes(buildRuntimeDiagnosticTree(runtime.diagnostics));

    expect(nodes.find((node) => node.id === "diagnostics:problem")?.status).toBe("failed");
    expect(nodes.find((node) => node.id === "diagnostics:mesh")?.status).toBe("degraded");
    expect(nodes.find((node) => node.id === "diagnostics:solver")?.status).toBe("warning");
  });

  it("uses command detail freshness independently from queue lifecycle", () => {
    const runtime = runtimeExplorerSnapshotFromResources({
      ...snapshot().source,
      commandDetails: stale([commandDetailEntry], "command-details:3"),
      commandQueue: ready({
        ...commandQueue,
        commands: [{ ...commandQueue.commands[0]!, status: "completed" }],
      }, 4),
    });
    const command = runtime.jobs.find((job) => job.kind === "command");
    const stage = runtime.jobs.find((job) => job.kind === "stage");

    expect(command?.detail).toMatchObject({
      condition: "stale",
      lifecycleStatus: "completed",
      revision: 3,
      sourceStatus: "stale",
    });
    expect(command?.state).toMatchObject({
      executionState: "not_started",
      resourceState: "stale",
      status: "stale",
    });
    expect(stage).toMatchObject({
      id: "jobs:stage:unverified:7:0:relax-0",
      detail: { owner: null },
      selectable: false,
    });
  });

  it("keeps run and stage identities collision-safe across run changes", () => {
    const nextRun = runtimeExplorerSnapshotFromResources({
      ...snapshot().source,
      currentRun: ready({ ...currentRun, run_id: "run-13", revision: 13 }, 13),
      commandDetails: ready([{
        ...commandDetailEntry,
        data: { ...commandDetail, run_id: "run-13" },
      }], "command-details:4"),
    });

    expect(nextRun.jobs.find((job) => job.kind === "run")?.id)
      .toBe("jobs:run:run-13");
    expect(nextRun.jobs.find((job) => job.kind === "stage")?.id)
      .toBe("jobs:stage:run%3Arun-13:relax-0");
    expect(nextRun.jobs.find((job) => job.kind === "stage")?.id)
      .not.toBe(snapshot().jobs.find((job) => job.kind === "stage")?.id);
  });

  it.each([
    ["idle", null, "unavailable"],
    ["loading", null, "unavailable"],
    ["error", null, "failed"],
    ["stale", {
      active_session: true,
      api_contract_version: "1.0.0",
      status: "ok",
      uptime_seconds: 4,
    }, "stale"],
    ["ready-empty", null, "unavailable"],
    ["unsupported", {
      active_session: true,
      api_contract_version: "1.0.0",
      status: "unsupported",
      uptime_seconds: 4,
    }, "unsupported"],
  ] as const)("never presents %s as ready or completed", (name, data, expected) => {
    const source = name === "idle" || name === "loading"
      ? {
          data: null,
          error: null,
          missing: false,
          revision: null,
          status: name,
        }
      : name === "error"
        ? {
            data: null,
            error: "health failed",
            missing: false,
            revision: null,
            status: "error" as const,
          }
        : name === "stale"
          ? stale(data!, 4)
          : { ...unavailable(), data };
    const runtime = runtimeExplorerSnapshotFromResources({
      ...snapshot().source,
      platformHealth: source,
    });
    const node = flattenExplorerNodes(buildRuntimeDiagnosticTree(runtime.diagnostics))
      .find((entry) => entry.id === "diagnostics:health");

    expect(node?.status, name).toBe(expected);
    expect(node?.status, name).not.toBe("ready");
    expect(node?.status, name).not.toBe("completed");
  });

  it("publishes explicit contract gaps for missing diagnostic owners", () => {
    const gaps = snapshot().diagnostics.filter((descriptor) => descriptor.detail.contractGap);
    expect(gaps.map((descriptor) => descriptor.id))
      .toEqual([
        "diagnostics:problem",
        "diagnostics:health",
        "diagnostics:capability",
        "diagnostics:solver",
        "diagnostics:mesh",
        "diagnostics:frequency-domain",
        "diagnostics:performance",
      ]);
    expect(
      gaps.every((descriptor) =>
          descriptor.state.status === "unavailable" &&
          descriptor.detail.sourceStatus === "unavailable"
        ),
    ).toBe(true);
  });

  it("distinguishes a missing typed resource from a transport failure", () => {
    const missing = runtimeResourceSnapshot<SolverStatusResource>({
      data: null,
      error: new ControlRoomApiError("not found", 404),
      revision: null,
      status: "error",
    });
    const missingSolver = runtimeExplorerSnapshotFromResources({
      ...snapshot().source,
      solverStatus: missing,
    });
    const solver = flattenExplorerNodes(
      buildRuntimeDiagnosticTree(missingSolver.diagnostics),
    ).find((node) => node.id === "diagnostics:solver");

    expect(solver).toMatchObject({
      availability: "unavailable",
      resourceState: "error",
      status: "unavailable",
    });
    expect(missingSolver.diagnostics.find((descriptor) => descriptor.id === "diagnostics:solver")?.detail)
      .toMatchObject({ condition: "unavailable", contractGap: true });
    expect(missing).toMatchObject({ error: "not found", missing: true });
  });
});
