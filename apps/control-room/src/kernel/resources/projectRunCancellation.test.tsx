import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ControlRoomApiError } from "../api/ControlRoomApi";
import {
  useCancelProjectRunTask,
  useMaterializeProjectRun,
  useRetryProjectRunTask,
} from "./projectRunResources";
import { useRetryProjectBatchCaseTask } from "./projectBatchResources";

const stub = vi.hoisted(() => ({
  cancel: vi.fn(),
  materialize: vi.fn(),
  retry: vi.fn(),
  commandBatch: vi.fn(),
  invalidate: vi.fn(),
  invalidatePrefix: vi.fn(),
}));
vi.mock("../KernelContext", () => ({
  useKernel: () => ({
    api: { persistence: { projects: {
      cancelRunTask: stub.cancel,
      materializeRun: stub.materialize,
      retryRunTask: stub.retry,
      commandBatch: stub.commandBatch,
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
  stub.retry.mockReset();
  stub.commandBatch.mockReset();
  stub.commandBatch.mockReset();
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

describe("durable failed-task retry", () => {
  it("replays the same retry identity after an unknown transport outcome", async () => {
    stub.retry.mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce({ catalog_revision: 6, lifecycle: "queued" });
    let retry!: ReturnType<typeof useRetryProjectRunTask>;
    function Probe() {
      retry = useRetryProjectRunTask("project-a");
      return null;
    }
    renderToStaticMarkup(<Probe />);

    await expect(retry("run-a", "task-a", 4)).rejects.toThrow("connection lost");
    await retry("run-a", "task-a", 5);

    const first = stub.retry.mock.calls[0][3];
    const replay = stub.retry.mock.calls[1][3];
    expect(first.retry_id).toEqual(expect.any(String));
    expect(replay).toEqual(first);
    expect(replay.expected_catalog_revision).toBe(4);
    expect(stub.retry).toHaveBeenCalledWith("project-a", "run-a", "task-a", first);
    expect(stub.invalidate).toHaveBeenCalledWith("project-run:project-a:run-a", 6);
    expect(stub.invalidatePrefix).toHaveBeenCalledWith("project-runs:project-a:", 6);
    expect(stub.invalidatePrefix).toHaveBeenCalledWith("project-batch-cases:project-a:", 6);
  });

  it("starts a fresh request only after a confirmed stale-revision rejection", async () => {
    stub.retry.mockRejectedValueOnce(new ControlRoomApiError(
      "stale revision", 409, null, "run_task_retry_revision_conflict",
    )).mockResolvedValueOnce({ catalog_revision: 7, lifecycle: "queued" });
    let retry!: ReturnType<typeof useRetryProjectRunTask>;
    function Probe() {
      retry = useRetryProjectRunTask("project-a");
      return null;
    }
    renderToStaticMarkup(<Probe />);

    await expect(retry("run-a", "task-a", 4)).rejects.toThrow("stale revision");
    await retry("run-a", "task-a", 5);

    expect(stub.retry.mock.calls[1][3].retry_id)
      .not.toBe(stub.retry.mock.calls[0][3].retry_id);
    expect(stub.retry.mock.calls[1][3].expected_catalog_revision).toBe(5);
  });
});

describe("durable batch-case task retry", () => {
  it("replays the same command and retry identities after an unknown outcome", async () => {
    stub.commandBatch.mockRejectedValueOnce(new Error("connection lost"))
      .mockImplementationOnce(async (_projectId, _batchId, request) => ({
        action: "retry",
        batch_id: "batch-a",
        command_id: request.command_id,
        command_revision: 1,
        disposition: "accepted",
        expansion_state: "complete",
        revision: 1,
        retry: {
          case_id: "case-a",
          task: {
            catalog_revision: 9,
            disposition: "accepted",
            lifecycle: "queued",
            previous_attempt_id: "attempt-previous",
            previous_ownership_epoch: 3,
            retry_id: request.retry?.retry_id,
            run_id: "run-a",
            task_id: "task-a",
          },
        },
      }));
    let retry!: ReturnType<typeof useRetryProjectBatchCaseTask>;
    function Probe() {
      retry = useRetryProjectBatchCaseTask("project-a");
      return null;
    }
    renderToStaticMarkup(<Probe />);

    await expect(retry("batch-a", "case-a", "run-a", "task-a", 2, 4))
      .rejects.toThrow("connection lost");
    await expect(retry("batch-a", "case-a", "run-a", "task-a", 3, 4))
      .resolves.toMatchObject({ lifecycle: "queued", catalog_revision: 9 });

    const first = stub.commandBatch.mock.calls[0][2];
    const replay = stub.commandBatch.mock.calls[1][2];
    expect(first.command_id).toEqual(expect.any(String));
    expect(first.retry?.retry_id).toEqual(expect.any(String));
    expect(replay).toEqual(first);
    expect(replay.expected_revision).toBe(2);
    expect(replay.retry?.expected_catalog_revision).toBe(4);
    expect(stub.commandBatch).toHaveBeenCalledWith("project-a", "batch-a", first);
    expect(stub.invalidate).toHaveBeenCalledWith("project-run:project-a:run-a", 9);
    expect(stub.invalidatePrefix).toHaveBeenCalledWith("project-runs:project-a:", 9);
    expect(stub.invalidatePrefix).toHaveBeenCalledWith(
      "project-batches:project-a:",
      expect.stringMatching(/^project-batch-local:/),
    );
    expect(stub.invalidatePrefix).toHaveBeenCalledWith(
      "project-batch-cases:project-a:batch-a:",
      expect.stringMatching(/^project-batch-local:/),
    );
  });

  it("uses fresh identities when the observed task catalog advances to a newer attempt", async () => {
    stub.commandBatch.mockRejectedValueOnce(new Error("connection lost"))
      .mockImplementationOnce(async (_projectId, _batchId, request) => ({
        action: "retry",
        batch_id: "batch-a",
        command_id: request.command_id,
        command_revision: 2,
        disposition: "accepted",
        expansion_state: "complete",
        revision: 2,
        retry: {
          case_id: "case-a",
          task: {
            catalog_revision: 10,
            disposition: "accepted",
            lifecycle: "queued",
            previous_attempt_id: "attempt-next",
            previous_ownership_epoch: 4,
            retry_id: request.retry?.retry_id,
            run_id: "run-a",
            task_id: "task-a",
          },
        },
      }));
    let retry!: ReturnType<typeof useRetryProjectBatchCaseTask>;
    function Probe() {
      retry = useRetryProjectBatchCaseTask("project-a");
      return null;
    }
    renderToStaticMarkup(<Probe />);

    await expect(retry("batch-a", "case-a", "run-a", "task-a", 1, 8))
      .rejects.toThrow("connection lost");
    await retry("batch-a", "case-a", "run-a", "task-a", 2, 9);

    const previous = stub.commandBatch.mock.calls[0][2];
    const next = stub.commandBatch.mock.calls[1][2];
    expect(next.command_id).not.toBe(previous.command_id);
    expect(next.retry?.retry_id).not.toBe(previous.retry?.retry_id);
    expect(next.expected_revision).toBe(2);
    expect(next.retry?.expected_catalog_revision).toBe(9);
  });

  it("creates new identities only after a definitive batch-command rejection", async () => {
    stub.commandBatch.mockRejectedValueOnce(new ControlRoomApiError(
      "stale revision", 409, null, "batch_command_revision_conflict",
    )).mockImplementationOnce(async (_projectId, _batchId, request) => ({
      action: "retry",
      batch_id: "batch-a",
      command_id: request.command_id,
      command_revision: 1,
      disposition: "accepted",
      expansion_state: "complete",
      revision: 1,
      retry: {
        case_id: "case-a",
        task: {
          catalog_revision: 9,
          disposition: "accepted",
          lifecycle: "queued",
          previous_attempt_id: "attempt-previous",
          previous_ownership_epoch: 3,
          retry_id: request.retry?.retry_id,
          run_id: "run-a",
          task_id: "task-a",
        },
      },
    }));
    let retry!: ReturnType<typeof useRetryProjectBatchCaseTask>;
    function Probe() {
      retry = useRetryProjectBatchCaseTask("project-a");
      return null;
    }
    renderToStaticMarkup(<Probe />);

    await expect(retry("batch-a", "case-a", "run-a", "task-a", 2, 4))
      .rejects.toThrow("stale revision");
    await retry("batch-a", "case-a", "run-a", "task-a", 3, 5);

    const rejected = stub.commandBatch.mock.calls[0][2];
    const fresh = stub.commandBatch.mock.calls[1][2];
    expect(fresh.command_id).not.toBe(rejected.command_id);
    expect(fresh.retry?.retry_id).not.toBe(rejected.retry?.retry_id);
    expect(fresh.expected_revision).toBe(3);
    expect(fresh.retry?.expected_catalog_revision).toBe(5);
  });
});
