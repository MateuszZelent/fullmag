import { describe, expect, it, vi } from "vitest";

import type {
  LiveStatusResource,
  SimulationPreparationResource,
} from "../api/apiTypes";
import { ControlRoomApiError } from "../api/ControlRoomApi";
import type { ResourceResult } from "../resources/resourceTypes";

import { resolveSimulationPreparationViewModel } from "./simulationPreparationModel";

const refetch = vi.fn();

function resource<TData>(
  data: TData | null,
  status: ResourceResult<TData>["status"] = "ready",
): ResourceResult<TData> {
  return {
    data,
    error: null,
    refetch,
    revision: data ? 7 : null,
    status,
  };
}

function statusResource(
  status: ResourceResult<LiveStatusResource>["status"] = "ready",
  patch: {
    preparationRevision?: number;
    solverState?: string;
  } = {},
): ResourceResult<LiveStatusResource> {
  return resource(
    {
      resources: {
        simulation_preparation_revision: patch.preparationRevision ?? 7,
      },
      session: { name: "permalloy-relaxation" },
      solver: { state: patch.solverState ?? "bootstrapping" },
    } as LiveStatusResource,
    status,
  );
}

function preparationError(error: Error): ResourceResult<SimulationPreparationResource> {
  return {
    data: null,
    error,
    refetch,
    revision: null,
    status: "error",
  };
}

function preparationFixture(
  patch: Partial<SimulationPreparationResource> = {},
): SimulationPreparationResource {
  const activeStageId = patch.active_stage_id ?? "meshing";
  return {
    active_stage_id: activeStageId,
    completed_at_unix_ms: null,
    failure: null,
    log_tail: [
      {
        level: "info",
        message: "Optimizing element quality",
        stage_id: "meshing",
        timestamp_unix_ms: 18_500,
      },
    ],
    preparation_id: "prep-7",
    requested_execution: {
      backend: "fem",
      device: "auto",
      engine_id: null,
      mode: "strict",
      precision: "double",
      runtime_family: null,
      worker: null,
    },
    resolved_execution: {
      backend: "fem",
      device: "gpu",
      engine_id: "mfem",
      mode: "strict",
      precision: "double",
      runtime_family: "local",
      worker: null,
    },
    revision: 7,
    stages: [
      stage("runtime_startup", "Runtime startup", "completed", 180),
      stage("script_materialization", "Script materialization", "completed", 220),
      stage("validation", "Validation", "completed", 100),
      stage("planning", "Planning", "completed", 200),
      stage("domain_preparation", "Domain preparation", "completed", 1_800),
      stage("meshing", "Meshing", "active", 16_200, 63),
      stage("mesh_postprocessing", "Mesh post-processing", "pending"),
      stage("solver_initialization", "Solver initialization", "pending"),
      stage("ready", "Ready", "pending"),
    ],
    started_at_unix_ms: 0,
    status: "running",
    ...patch,
  };
}

function stage(
  id: SimulationPreparationResource["stages"][number]["id"],
  label: string,
  status: SimulationPreparationResource["stages"][number]["status"],
  durationMs: number | null = null,
  progressPercent: number | null = null,
): SimulationPreparationResource["stages"][number] {
  return {
    completed_at_unix_ms: status === "completed" ? durationMs : null,
    detail: status === "active" ? "Optimizing element quality" : "",
    duration_ms: durationMs,
    id,
    label,
    progress_label:
      progressPercent === null ? null : "142580 / 226318 elements",
    progress_percent: progressPercent,
    started_at_unix_ms: status === "active" ? 2_500 : null,
    status,
  };
}

describe("resolveSimulationPreparationViewModel", () => {
  it("keeps initial connection indeterminate without inventing stages or an ETA", () => {
    const model = resolveSimulationPreparationViewModel(
      resource<SimulationPreparationResource>(null, "loading"),
      resource<LiveStatusResource>(null, "loading"),
      1_000,
    );

    expect(model).toMatchObject({
      isVisible: true,
      kind: "connecting",
      progress: { kind: "indeterminate" },
      title: "Preparing simulation",
    });
    expect(model.stages).toEqual([]);
    expect(model.progress).toEqual({ kind: "indeterminate" });
    expect(model).not.toHaveProperty("eta");
    expect(model).not.toHaveProperty("percent");
  });

  it("releases a ready restored session when revision zero has no preparation snapshot", () => {
    const model = resolveSimulationPreparationViewModel(
      preparationError(new ControlRoomApiError("preparation not found", 404)),
      statusResource("ready", {
        preparationRevision: 0,
        solverState: "awaiting_command",
      }),
      1_000,
    );

    expect(model).toMatchObject({
      isTerminal: false,
      isVisible: false,
      kind: "hidden",
    });
  });

  it("keeps genuine revision-zero runtime startup visible", () => {
    const model = resolveSimulationPreparationViewModel(
      preparationError(new ControlRoomApiError("preparation not found", 404)),
      statusResource("ready", {
        preparationRevision: 0,
        solverState: "bootstrapping",
      }),
      1_000,
    );

    expect(model).toMatchObject({
      detail: "Starting the runtime workspace.",
      isVisible: true,
      kind: "connecting",
    });
  });

  it.each([
    {
      detail: "Authorization is required to read simulation preparation status.",
      error: new ControlRoomApiError("request rejected with bearer token abc", 401),
    },
    {
      detail:
        "The Control Room API contract is incompatible. Restart or update the local runtime.",
      error: new ControlRoomApiError(
        "API contract version mismatch: expected 1.0.0, got 0.9.0",
        0,
      ),
    },
    {
      detail:
        "The local runtime could not provide simulation preparation status. Open diagnostics or retry.",
      error: new ControlRoomApiError("internal path /private/model.py failed", 500),
    },
  ])("keeps an initial non-transient preparation error bounded and visible", ({
    detail,
    error,
  }) => {
    const model = resolveSimulationPreparationViewModel(
      preparationError(error),
      statusResource("ready", {
        preparationRevision: 1,
        solverState: "awaiting_command",
      }),
      1_000,
    );

    expect(model).toMatchObject({
      detail,
      isTerminal: true,
      isVisible: true,
      kind: "resource-error",
      title: "Preparation status unavailable",
    });
    expect(JSON.stringify(model)).not.toContain(error.message);
  });

  it("uses numeric progress only for a measurable active stage", () => {
    const model = resolveSimulationPreparationViewModel(
      resource(preparationFixture()),
      statusResource(),
      18_700,
    );

    expect(model.progress).toEqual({ kind: "determinate", value: 63 });
    expect(model.activeStage?.elapsedLabel).toBe("16.2s");
    expect(model.stages).toHaveLength(9);
  });

  it("does not fabricate percent for an indeterminate planning stage", () => {
    const planning = stage("planning", "Planning", "active", 2_100);
    const model = resolveSimulationPreparationViewModel(
      resource(
        preparationFixture({
          active_stage_id: "planning",
          stages: [
            stage("runtime_startup", "Runtime startup", "completed", 180),
            stage("script_materialization", "Script materialization", "completed", 220),
            stage("validation", "Validation", "completed", 100),
            planning,
          ],
        }),
      ),
      statusResource(),
      4_600,
    );

    expect(model.progress).toEqual({ kind: "indeterminate" });
    expect(model.activeStage?.elapsedLabel).toBe("2.1s");
  });

  it("preserves skipped stages as explicit textual state", () => {
    const skipped = stage(
      "mesh_postprocessing",
      "Mesh post-processing",
      "skipped",
    );
    const model = resolveSimulationPreparationViewModel(
      resource(preparationFixture({ stages: [skipped] })),
      statusResource(),
      18_700,
    );

    expect(model.stages[0]).toMatchObject({
      elapsedLabel: "Skipped",
      stateLabel: "Skipped",
    });
  });

  it("retains the last snapshot and marks stale transport as reconnecting", () => {
    const model = resolveSimulationPreparationViewModel(
      resource(preparationFixture(), "stale"),
      statusResource("stale"),
      19_700,
    );

    expect(model).toMatchObject({
      isVisible: true,
      kind: "stale",
      reconnectingMessage: "Displayed progress may be out of date.",
      reconnectingTitle: "Reconnecting…",
    });
    expect(model.activeStage?.label).toBe("Meshing");
  });

  it("does not treat routine stale session-status polling as reconnecting", () => {
    const model = resolveSimulationPreparationViewModel(
      resource(preparationFixture()),
      statusResource("stale"),
      19_700,
    );

    expect(model.kind).toBe("running");
    expect(model.reconnectingTitle).toBeNull();
    expect(model.reconnectingMessage).toBeNull();
  });

  it("keeps the polite summary stable across display-only elapsed ticks", () => {
    const beforeTick = resolveSimulationPreparationViewModel(
      resource(preparationFixture()),
      statusResource(),
      18_700,
    );
    const afterTick = resolveSimulationPreparationViewModel(
      resource(preparationFixture()),
      statusResource(),
      19_700,
    );

    expect(afterTick.activeStage?.elapsedLabel).not.toBe(
      beforeTick.activeStage?.elapsedLabel,
    );
    expect(afterTick.liveSummary).toBe(beforeTick.liveSummary);
    expect(afterTick.liveSummary).not.toMatch(/elapsed|\d+\.\d+s/i);
  });

  it("resolves ready as terminal and releases the startup gate", () => {
    const model = resolveSimulationPreparationViewModel(
      resource(
        preparationFixture({
          active_stage_id: null,
          completed_at_unix_ms: 20_000,
          status: "ready",
        }),
      ),
      statusResource(),
      20_000,
    );

    expect(model).toMatchObject({ isTerminal: true, isVisible: false, kind: "ready" });
  });

  it("keeps a failed stage and safe failure summary visible", () => {
    const failedStage = stage("meshing", "Meshing", "failed", 16_900);
    const model = resolveSimulationPreparationViewModel(
      resource(
        preparationFixture({
          active_stage_id: null,
          failure: {
            diagnostics_correlation_id: "diag-42",
            error_code: "mesh_generation_failed",
            stage_id: "meshing",
            summary: "Mesh generation did not converge.",
          },
          stages: [failedStage],
          status: "failed",
        }),
      ),
      statusResource(),
      20_000,
    );

    expect(model).toMatchObject({
      failure: {
        correlationId: "diag-42",
        errorCode: "mesh_generation_failed",
        summary: "Mesh generation did not converge.",
      },
      isTerminal: true,
      isVisible: true,
      kind: "failed",
      progress: { kind: "terminal" },
    });
    expect(model.stages[0]?.stateLabel).toBe("Failed");
  });

  it("propagates failure causes, exact omitted entries, and incomplete predicate analysis", () => {
    const detail = `failed_predicates=[fem_order_not_p1,${Array.from(
      { length: 32 },
      (_, index) => `future_constraint_${index}`,
    ).join(",")}]`;
    const model = resolveSimulationPreparationViewModel(
      resource(
        preparationFixture({
          active_stage_id: null,
          failure: {
            detail,
            diagnostics_correlation_id: "diag-42",
            error_code: "mesh_generation_failed",
            stage_id: "meshing",
            summary: "Mesh generation did not converge.",
          },
          status: "failed",
        }),
      ),
      statusResource(),
      20_000,
    );

    expect(model.failure).toMatchObject({
      detail,
      omittedPredicateCount: 1,
      predicateAnalysisTruncated: true,
    });
    expect(model.failure?.causes).toHaveLength(32);
    expect(model.failure?.causes[0]).toEqual(
      expect.objectContaining({ known: true, predicate: "fem_order_not_p1" }),
    );
  });
});
