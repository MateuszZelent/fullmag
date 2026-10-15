import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ControlRoomApiError } from "../api/ControlRoomApi";
import {
  useCancelProjectRunTask,
  useMaterializeProjectRun,
} from "./projectRunResources";

const stub = vi.hoisted(() => ({
  cancel: vi.fn(),
  materialize: vi.fn(),
  invalidate: vi.fn(),
  invalidatePrefix: vi.fn(),
}));
vi.mock("../KernelContext", () => ({
  useKernel: () => ({
    api: { persistence: { projects: {
      cancelRunTask: stub.cancel,
      materializeRun: stub.materialize,
    } } },
    resources: {
      invalidate: stub.invalidate,
      invalidatePrefix: stub.invalidatePrefix,
    },
  }),
}));

function mountedCancellation() {
  let cancel!: ReturnType<typeof useCancelProjectRunTask>;
  function Probe() {
    cancel = useCancelProjectRunTask("project-a", "run-a", null);
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return cancel;
}

function mountedMaterialization() {
  let materialize!: ReturnType<typeof useMaterializeProjectRun>;
  function Probe() {
    materialize = useMaterializeProjectRun("project-a");
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return materialize;
}

beforeEach(() => {
  stub.cancel.mockReset();
  stub.materialize.mockReset();
  stub.invalidate.mockReset();
  stub.invalidatePrefix.mockReset();
});

describe("durable pre-claim cancellation retry", () => {
  it("replays the original identity and revision after an unknown transport outcome", async () => {
    stub.cancel.mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce({ catalog_revision: 4 });
    const cancel = mountedCancellation();
    await expect(cancel("task-a", "stop", 2)).rejects.toThrow("connection lost");
    expect(stub.invalidate).not.toHaveBeenCalled();
    await cancel("task-a", "stop", 3);
    const first = stub.cancel.mock.calls[0][3];
    const replay = stub.cancel.mock.calls[1][3];
    expect(first.cancellation_id).toEqual(expect.any(String));
    expect(replay).toEqual(first);
    expect(replay.expected_catalog_revision).toBe(2);
    expect(stub.invalidate).toHaveBeenCalledWith("project-run:project-a:run-a", 4);
  });

  it("allows a fresh request only after a confirmed stale-revision rejection", async () => {
    stub.cancel.mockRejectedValueOnce(new ControlRoomApiError(
      "stale revision", 409, null, "run_task_cancel_revision_conflict",
    )).mockResolvedValueOnce({ catalog_revision: 5 });
    const cancel = mountedCancellation();
    await expect(cancel("task-a", "stop", 2)).rejects.toThrow("stale revision");
    await cancel("task-a", "stop", 4);
    expect(stub.cancel.mock.calls[1][3].cancellation_id)
      .not.toBe(stub.cancel.mock.calls[0][3].cancellation_id);
    expect(stub.cancel.mock.calls[1][3].expected_catalog_revision).toBe(4);
  });

  it("keeps legacy claimed-task Stop requests free of pre-claim fields", async () => {
    stub.cancel.mockResolvedValueOnce({ catalog_revision: 8 });
    await mountedCancellation()("task-a", "stop");
    expect(stub.cancel).toHaveBeenCalledWith("project-a", "run-a", "task-a", { reason: "stop" });
  });
});

describe("idempotent child-run task materialization", () => {
  it("invalidates run, run-list, and batch-case resources at the returned catalog revision", async () => {
    stub.materialize.mockResolvedValue({
      catalog_revision: 11,
      execution_state: "pending_preparation",
      run_id: "run-a",
      task_ids: ["task-a"],
    });
    const materialize = mountedMaterialization();

    await expect(materialize("run-a")).resolves.toMatchObject({
      catalog_revision: 11,
      run_id: "run-a",
      task_ids: ["task-a"],
    });

    expect(stub.materialize).toHaveBeenCalledWith("project-a", "run-a");
    expect(stub.invalidate).toHaveBeenCalledWith("project-run:project-a:run-a", 11);
    expect(stub.invalidatePrefix).toHaveBeenCalledWith("project-runs:project-a:", 11);
    expect(stub.invalidatePrefix).toHaveBeenCalledWith("project-batch-cases:project-a:", 11);
  });
});
