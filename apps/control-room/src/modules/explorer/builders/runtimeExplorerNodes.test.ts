import { describe, expect, it } from "vitest";

import { SIMULATION_RUN_CURRENT_PATH } from "@/kernel/api/apiPaths";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import type {
  CommandDetailResource,
  CommandQueueStatusResource,
  CurrentRunResource,
  GeometryValidationResource,
  HealthResource,
  LiveStatusResource,
  MeshSharedDomainManifestResource,
  PlatformCapabilitiesResource,
  SolverProfileResource,
  SolverStatusResource,
  StageExecutionResource,
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
  seq: 3,
  status: "running",
};

function snapshot() {
  return runtimeExplorerSnapshotFromResources({
    commandDetails: ready([commandDetail], "command-details:3"),
    commandQueue: ready(commandQueue, 3),
    currentRun: ready(currentRun, 12),
    frequencyDomainManifest: unavailable(),
    geometryValidation: unavailable<GeometryValidationResource>(),
    meshManifest: unavailable<MeshSharedDomainManifestResource>(),
    platformCapabilities: unavailable<PlatformCapabilitiesResource>(),
    platformHealth: unavailable<HealthResource>(),
    sessionStatus: unavailable<LiveStatusResource>(),
    solverProfile: unavailable<SolverProfileResource>(),
    solverStatus: unavailable<SolverStatusResource>(),
    stageExecution: ready(stageExecution, 7),
  });
}

describe("runtime-backed Explorer tabs", () => {
  it("publishes resources only from typed descriptors and keeps unknown metadata unavailable", () => {
    const nodes = flattenExplorerNodes(buildRuntimeResourceTree(snapshot().resources));
    const run = nodes.find((node) => node.id === "resources:simulation:current-run");

    expect(run).toMatchObject({
      kind: "resources.runtime",
      resourceState: "ready",
      status: "ready",
      runtimeDetail: {
        cache: null,
        generation: null,
        key: SIMULATION_RUN_CURRENT_PATH,
        location: "/runs/run-12",
        owner: "run:run-12",
        revision: 12,
        schema: null,
        sizeBytes: null,
      },
    });
  });

  it("builds jobs only from real run, stage, and command lifecycle", () => {
    const nodes = flattenExplorerNodes(buildRuntimeJobTree(snapshot().jobs));

    expect(nodes.map((node) => node.id)).toEqual([
      "jobs:root",
      "jobs:run:run-12",
      "jobs:stage:relax-0",
      "jobs:command:command-1",
    ]);
    expect(nodes.find((node) => node.id === "jobs:run:run-12")?.runtimeDetail)
      .toMatchObject({
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
    expect(nodes.find((node) => node.id === "jobs:command:command-1")?.runtimeDetail)
      .toMatchObject({
        requestedExecution: { backend: "fdm", device: "gpu" },
        resolvedExecution: { backend: "fdm-cuda", device: "cuda:0" },
      });
  });

  it("does not render a queue when no command owner resource exists", () => {
    const empty = runtimeExplorerSnapshotFromResources({
      ...snapshot().source,
      commandDetails: unavailable<CommandDetailResource[]>(),
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

  it("publishes explicit contract gaps for missing diagnostic owners", () => {
    const nodes = flattenExplorerNodes(
      buildRuntimeDiagnosticTree(snapshot().diagnostics),
    );

    expect(nodes.filter((node) => node.runtimeDetail?.contractGap).map((node) => node.id))
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
      nodes
        .filter((node) => node.runtimeDetail?.contractGap)
        .every((node) =>
          node.status === "unavailable" &&
          node.runtimeDetail?.sourceStatus === "unavailable"
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
    expect(solver?.runtimeDetail).toMatchObject({ contractGap: true });
    expect(missing).toMatchObject({ error: "not found", missing: true });
  });
});
