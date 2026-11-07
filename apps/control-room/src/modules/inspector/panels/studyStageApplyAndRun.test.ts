import { describe, expect, it, vi } from "vitest";

import { MODEL_READINESS_PATH, MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";

import { executeStageAfterApply } from "./studyStageApplyAndRun";

const pinnedResources = {
  mesh_revision: 5,
  domain_generation_id: "grid-a",
  region_topology_revision: 1,
  region_membership_revision: 2,
  region_coefficients_revision: 3,
  region_initial_state_revision: 4,
};

function fixture() {
  const committedScene = { revision: 8 };
  const status = vi.fn(async () => ({
    resources: { ...pinnedResources, scene_revision: 8 },
    run: { run_id: "relax-a" },
  }));
  const readiness = vi.fn(async () => ({ scene_revision: 8, ready_to_run: true, blockers: [] as string[] }));
  const apply = vi.fn(async () => ({ scene_revision: 8, committed_scene: committedScene }));
  const execute = vi.fn(async () => ({ status: "pending", message: "accepted" } as const));
  const options = {
    api: { sessions: { current: { status } }, model: { readiness } } as never,
    apply: apply as never,
    execute,
    isCurrent: () => true,
    pin: {
      ...pinnedResources,
      scene_revision: 7,
      current_run: { kind: "run" as const, run_id: "relax-a" },
    },
    stageId: "relax-b",
  };
  return { apply, committedScene, execute, options, readiness, status };
}

describe("executeStageAfterApply", () => {
  it("runs only the chosen stage with the exact acknowledged scene", async () => {
    const { apply, committedScene, execute, options } = fixture();

    await expect(executeStageAfterApply(options)).resolves.toMatchObject({ status: "pending" });
    expect(apply).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      stageId: "relax-b", initialState: { kind: "default_for_target" },
    }, {
      [MODEL_SCENE_PATH]: committedScene,
      [MODEL_READINESS_PATH]: { scene_revision: 8, ready_to_run: true, blockers: [] },
      [SESSION_STATUS_RESOURCE_KEY]: {
        resources: { ...pinnedResources, scene_revision: 8 },
        run: { run_id: "relax-a" },
      },
    });
  });

  it("keeps the chosen magnetization source through the save confirmation", async () => {
    const { execute, options } = fixture();
    const initialState = {
      kind: "stage_result", run_id: "relax-a", step_id: "step-a",
      case_id: "nominal", artifact_id: "state-a", content_sha256: "f".repeat(64),
    } as const;

    await expect(executeStageAfterApply({ ...options, initialState })).resolves.toMatchObject({ status: "pending" });
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      { stageId: "relax-b", initialState },
      expect.objectContaining({ [MODEL_SCENE_PATH]: { revision: 8 } }),
    );
  });

  it("does not run if saving is unconfirmed or the target changes during Apply", async () => {
    const first = fixture();
    await expect(executeStageAfterApply({ ...first.options, apply: async () => null })).resolves.toMatchObject({ status: "failed" });
    expect(first.status).not.toHaveBeenCalled();
    expect(first.execute).not.toHaveBeenCalled();

    const second = fixture();
    let current = true;
    const apply = async () => {
      current = false;
      return second.apply() as never;
    };
    await expect(executeStageAfterApply({ ...second.options, apply, isCurrent: () => current })).resolves.toMatchObject({ status: "cancelled" });
    expect(second.status).not.toHaveBeenCalled();
    expect(second.execute).not.toHaveBeenCalled();
  });

  it("reports the readiness blocker after saving without attempting to run", async () => {
    const { options, readiness, execute } = fixture();
    readiness.mockResolvedValueOnce({
      scene_revision: 8, ready_to_run: false, blockers: ["Build the current mesh."],
    });
    await expect(executeStageAfterApply(options)).resolves.toEqual({
      message: "Build the current mesh.", status: "failed",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["scene", { scene_revision: 9 }, "relax-a"],
    ["mesh", { mesh_revision: 6 }, "relax-a"],
    ["domain generation", { domain_generation_id: "grid-b" }, "relax-a"],
    ["region topology", { region_topology_revision: 2 }, "relax-a"],
    ["region membership", { region_membership_revision: 3 }, "relax-a"],
    ["region coefficients", { region_coefficients_revision: 4 }, "relax-a"],
    ["initial state", { region_initial_state_revision: 5 }, "relax-a"],
    ["current run", {}, "relax-c"],
  ] as const)("stops after a newer %s appears, even when Apply succeeds", async (_label, changed, runId) => {
    const { options, status, execute } = fixture();
    status.mockResolvedValueOnce({
      resources: { ...pinnedResources, scene_revision: 8, ...changed },
      run: { run_id: runId },
    });
    await expect(executeStageAfterApply(options)).resolves.toMatchObject({ status: "failed" });
    expect(execute).not.toHaveBeenCalled();
  });
});
