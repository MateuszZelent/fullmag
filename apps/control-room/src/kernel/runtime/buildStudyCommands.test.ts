import { describe, expect, it, vi } from "vitest";

import {
  MODEL_READINESS_PATH, MODEL_SCENE_PATH, SIMULATION_COMMANDS_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
} from "../api/apiPaths";
import { ControlRoomApiError } from "../api/ControlRoomApi";
import { GEOMETRY_LIFECYCLE_COMMANDS } from "../authoring/geometryLifecycleCommandContributions";
import { PendingFormRegistry } from "../authoring/PendingFormRegistry";
import { CommandRegistry } from "../commands/CommandRegistry";
import type { CommandContext } from "../commands/commandTypes";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { activeLaneCapabilityFixture } from "../resources/activeLaneCapabilityFixture.testSupport";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";
import { createBuildStudyCommands } from "./buildStudyCommands";
import { STUDY_RUNTIME_COMMANDS } from "./studyRuntimeCommandContributions";

function fixture(lane: "fem" | "fdm") {
  const registry = new CommandRegistry();
  registry.attach(new EventBus());
  for (const command of [...GEOMETRY_LIFECYCLE_COMMANDS, ...STUDY_RUNTIME_COMMANDS, ...createBuildStudyCommands(registry)]) {
    registry.register(command);
  }
  const state = {
    revision: 7, meshRevision: 4, runId: "old", meshOwner: "build-a",
    commandsRevision: 1, statusReads: 0, failSolvePreflight: false,
    loseBuildRead: false, loseSolveAck: false, solveIntent: undefined as string | undefined,
    revealSolve: false,
  };
  const solver = { runtime_state: "awaiting_command", revision: 9 };
  const status = () => {
    state.statusReads += 1;
    if (state.failSolvePreflight && state.statusReads === 3) {
      throw new Error("current Study status unavailable");
    }
    return {
      capabilities: {
        explicit_topology: lane === "fem",
        active_lane: {
          ...activeLaneCapabilityFixture(),
          authored: { backend: lane, discretization: lane },
          resolved: { backend: lane, discretization: lane },
          operations: {
            [lane === "fem" ? "shared_mesh_build" : "grid_build"]: {
              state: "supported",
              reason: "",
              requires: [],
            },
          },
        },
      },
      run: { run_id: state.runId },
      domain: { discretization: lane, generation_id: "built-domain" },
      resources: {
        commands_revision: state.commandsRevision,
        scene_revision: state.revision,
        mesh_revision: state.meshRevision,
        domain_generation_id: "built-domain",
      },
    };
  };
  let postedBuild: Record<string, unknown> | null = null;
  const detail = vi.fn(async () => {
    if (state.loseBuildRead) throw new Error("Disconnected");
    return {
      command_id: "build-a", seq: 1, client_intent_id: postedBuild?.client_intent_id,
      kind: lane === "fem" ? "remesh" : "fdm_grid_refresh", status: "completed",
      target: lane === "fdm" ? { kind: "run", run_id: "held" } : undefined,
      mesh_target: lane === "fem" ? { kind: "study_domain" } : undefined,
      precondition: postedBuild?.precondition,
      resource_invalidations: [{ resource_key: "data/domain/topology", revision: state.meshRevision }],
    };
  });
  const submit = vi.fn(async (command: Record<string, unknown>) => {
    if (command.kind === "solve") {
      state.solveIntent = command.client_intent_id as string;
      if (state.loseSolveAck) throw new ControlRoomApiError("Lost ACK", 0, null, "API_UNAVAILABLE");
      return { accepted: true, command_id: "solve-a" };
    }
    state.commandsRevision += 1;
    postedBuild = command;
    if (lane === "fem") state.meshRevision = 5;
    else state.runId = "held";
    return { accepted: true, command_id: "build-a" };
  });
  const readiness = vi.fn(async () => ({ ready_to_run: true, blockers: [], checks: [], scene_revision: state.revision }));
  const api = {
    model: { scene: async () => ({ revision: state.revision }), readiness },
    meshing: {
      builds: { current: async () => ({ provenance: {
        command_id: state.meshOwner, build_id: "mesh:build-a",
        source_scene_revision: 7, mesh_revision: state.meshRevision,
      } }) },
      sharedDomainManifest: async () => ({
        revision: state.meshRevision, source_scene_revision: 7,
        generation_id: "built-domain", topology_fingerprint: "sha256:mesh",
      }),
    },
    commands: {
      submit, detail,
      list: async () => ({
        accepted_count: 0,
        can_accept_commands: true,
        commands: [
          ...(postedBuild ? [await detail()] : []),
          ...(state.revealSolve ? [{ command_id: "solve-a", kind: "solve", client_intent_id: state.solveIntent, seq: 2, status: "accepted" }] : []),
        ],
        completed_count: 0,
        dispatched_count: 0,
        failed_count: 0,
        pending_count: 0,
        rejected_count: 0,
        revision: state.commandsRevision + 11,
        running_count: 0,
        runtime_controls: [],
      }),
    },
    simulation: {
      solver: { status: async () => solver },
      stages: { execution: async () => null },
      preparation: async () => lane === "fem" ? null : ({
        status: "ready", preparation_id: "prep",
        receipt: { run_id: "held", preparation_id: "prep", plan_fingerprint: "plan", payload_sha256: "receipt" },
      }),
    },
    sessions: { current: { status: async () => status() } },
  };
  const context: CommandContext = {
    api: api as unknown as CommandContext["api"], source: "test",
    commandQueueResourceStatus: "stale",
    sessionScopeKey: "scope", isCurrentSessionScope: () => true,
    resourceData: {
      [SESSION_STATUS_RESOURCE_KEY]: status(), [MODEL_SCENE_PATH]: { revision: 7 },
      [MODEL_READINESS_PATH]: { scene_revision: 7, ready_to_run: true },
      [SIMULATION_COMMANDS_PATH]: { commands: [], runtime_controls: [] },
      [SIMULATION_SOLVER_STATUS_PATH]: solver,
    },
  };
  return { registry, state, context, readiness, submit };
}

describe("Build + Study command", () => {
  it.each(["fem", "fdm"] as const)("starts the whole Study after verifying the %s build", async (lane) => {
    const { registry, context, state, submit } = fixture(lane);
    expect(await registry.execute("study.build-and-run", context)).toMatchObject({
      commandId: "solve-a", status: "pending",
    });
    expect(submit.mock.calls.map(([command]) => command.kind)).toEqual([
      lane === "fem" ? "mesh_build" : "fdm_grid_refresh", "solve",
    ]);
    expect(submit.mock.calls[1][0]).toMatchObject({
      target: { kind: "study" },
      precondition: {
        command_revision: 2,
        scene_revision: 7,
        mesh_revision: lane === "fem" ? 5 : 4,
      },
    });
    expect(submit.mock.calls[1][0]).not.toMatchObject({
      precondition: { command_revision: state.commandsRevision + 11 },
    });
  });

  it("does not submit Solve when the fresh post-build status read fails", async () => {
    const { registry, context, state, submit } = fixture("fdm");
    state.failSolvePreflight = true;
    const result = await registry.execute("study.build-and-run", context);

    expect(result).toMatchObject({ status: "failed" });
    expect(submit.mock.calls.map(([command]) => command.kind)).toEqual(["fdm_grid_refresh"]);
  });

  it("does not Compute on a different publication at the same scene and revision", async () => {
    const { registry, context, state, submit } = fixture("fem");
    state.meshOwner = "different-build";
    expect(await registry.execute("study.build-and-run", context)).toMatchObject({ status: "failed" });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("checks a lost build acknowledgement without submitting another build", async () => {
    const { registry, context, state, submit } = fixture("fdm");
    state.loseBuildRead = true;
    expect(await registry.execute("study.build-and-run", context)).toMatchObject({ status: "pending" });
    expect(submit).toHaveBeenCalledOnce();
    state.loseBuildRead = false;
    expect(await registry.execute("study.build-and-run", context)).toMatchObject({ commandId: "solve-a" });
    expect(submit.mock.calls.map(([command]) => command.kind)).toEqual(["fdm_grid_refresh", "solve"]);
  });

  it("reconciles an ambiguous Compute without submitting either mutation again", async () => {
    const { registry, context, state, submit } = fixture("fem");
    state.loseSolveAck = true;
    expect(await registry.execute("study.build-and-run", context)).toMatchObject({ status: "pending" });
    state.revealSolve = true;
    expect(await registry.execute("study.build-and-run", context)).toMatchObject({ commandId: "solve-a" });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it.each(["fem", "fdm"] as const)("does not submit a %s build if a draft appears in the confirmation dialog", async (lane) => {
    const { registry, context, submit } = fixture(lane);
    const bus = new EventBus<KernelEventMap>();
    const pendingForms = new PendingFormRegistry();
    const apply = vi.fn(async () => true);
    const reset = vi.fn();
    bus.on("mesh:build-confirm-requested", ({ requestId }) => {
      pendingForms.register(Symbol("mesh-policy"), {
        apply, reset, dirty: true, applying: false, valid: true, mode: "staged",
      });
      bus.emit("mesh:build-confirm-resolved", {
        requestId, confirmed: true, precondition: { scene_revision: 7, mesh_revision: 4 },
      });
    });

    const result = await registry.execute("study.build-and-run", { ...context, bus, pendingForms });
    expect(result).toMatchObject({ status: "failed", message: expect.stringContaining("Apply or discard") });
    expect(submit).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(pendingForms.getTransitionSnapshot().dirtyOwnerCount).toBe(1);
  });

  it("keeps the completed build and the draft if an edit appears during verification", async () => {
    const { registry, context, readiness, submit } = fixture("fdm");
    const pendingForms = new PendingFormRegistry();
    readiness.mockImplementation(async () => {
      pendingForms.register(Symbol("material"), {
        apply: vi.fn(), reset: vi.fn(), dirty: true, applying: false, valid: true, mode: "staged",
      });
      return { ready_to_run: true, blockers: [], checks: [], scene_revision: 7 };
    });

    const result = await registry.execute("study.build-and-run", { ...context, pendingForms });
    expect(result).toMatchObject({ status: "failed", message: expect.stringContaining("Domain built. Apply or discard") });
    expect(submit.mock.calls.map(([command]) => command.kind)).toEqual(["fdm_grid_refresh"]);
    expect(pendingForms.getTransitionSnapshot().dirtyOwnerCount).toBe(1);
  });

  it("cancels the continuation before Compute even when the build has completed", async () => {
    const { registry, context, readiness, submit } = fixture("fem");
    let started!: () => void;
    let finish!: (value: Awaited<ReturnType<typeof readiness>>) => void;
    const verifying = new Promise<void>((resolve) => { started = resolve; });
    readiness.mockImplementation(() => {
      started();
      return new Promise((resolve) => { finish = resolve; });
    });
    const operation = registry.execute("study.build-and-run", context);
    await verifying;
    expect(await registry.execute("study.cancel-build-and-run", context)).toMatchObject({ status: "cancelled" });
    finish({ ready_to_run: true, blockers: [], checks: [], scene_revision: 7 });
    expect(await operation).toMatchObject({ status: "cancelled" });
    expect(submit).toHaveBeenCalledOnce();
  });
});
