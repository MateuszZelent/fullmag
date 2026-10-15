import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectBatchCasesQuery } from "@/kernel/api/apiTypes";
import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  type TestElement,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { ProjectBatchesSection } from "./ProjectBatchesSection";

const fakes = vi.hoisted(() => ({
  projectSnapshot: vi.fn(),
  listBatches: vi.fn(),
  listBatchCases: vi.fn(),
  commandBatch: vi.fn(),
  loadAllBatchCases: vi.fn(),
  cancelTask: vi.fn(),
  cancelTaskById: vi.fn(),
  materializeRun: vi.fn(),
  runDetails: vi.fn(),
  runResults: vi.fn(),
}));

vi.mock("@/kernel/persistence/ProjectDocumentStatus", () => ({
  useProjectDocumentSnapshot: fakes.projectSnapshot,
}));

vi.mock("@/kernel/resources/projectBatchResources", () => ({
  useCommandProjectBatch: fakes.commandBatch,
  useLoadAllProjectBatchCases: fakes.loadAllBatchCases,
  useProjectBatchesResource: fakes.listBatches,
  useProjectBatchCasesResource: fakes.listBatchCases,
}));

vi.mock("@/kernel/resources/projectRunResources", () => ({
  useCancelProjectRunTask: fakes.cancelTask,
  useCancelProjectRunTaskById: fakes.cancelTaskById,
  useMaterializeProjectRun: fakes.materializeRun,
  useProjectRunResource: fakes.runDetails,
}));

vi.mock("@/kernel/resources/solutionSetResources", () => ({
  useSolutionSetDiscoveryResource: fakes.runResults,
}));

describe("ProjectBatchesSection", () => {
  let dom: ReturnType<typeof installSimulationPreparationTestDom>;
  let roots: Array<ReturnType<typeof createRoot>>;

  beforeEach(() => {
    dom = installSimulationPreparationTestDom();
    roots = [];
    vi.clearAllMocks();
    fakes.commandBatch.mockReturnValue(vi.fn().mockResolvedValue({
      disposition: "accepted",
      command_id: "command-1",
    }));
    fakes.cancelTask.mockReturnValue(vi.fn().mockResolvedValue(undefined));
    fakes.cancelTaskById.mockReturnValue(vi.fn().mockResolvedValue(undefined));
    fakes.materializeRun.mockReturnValue(vi.fn().mockResolvedValue({
      catalog_revision: 8,
      execution_state: "pending_preparation",
      run_id: "run-pending",
      task_ids: ["task-pending"],
    }));
    fakes.loadAllBatchCases.mockReturnValue(vi.fn().mockResolvedValue([{
      case_id: "case-a",
      parameter_tuple: { B_ext: 0.01 },
      planned_run_id: "run-a",
      state: "pending_expansion",
      published_run: null,
    }, {
      case_id: "case-b",
      parameter_tuple: { B_ext: 0.02 },
      planned_run_id: "run-b",
      state: "materialized",
      published_run: {
        run_id: "run-b",
        catalog_state: "materialized",
        catalog_revision: 7,
        tasks: [{ task_id: "task-b", lifecycle: "running", cancellation_requested: false }],
      },
    }]));
    fakes.projectSnapshot.mockReturnValue({
      state: "ready",
      resource: { project_id: "project-a" },
    });
    fakes.listBatches.mockReturnValue({
      data: {
        project_id: "project-a",
        batches: [{
          accepted_at: "2026-10-07T12:00:00Z",
          batch_id: "batch-a",
          case_count: 5,
          command_revision: 0,
          expansion_state: "expanding",
          failure_policy: "continue_independent",
          manifest_sha256: "a".repeat(64),
          max_parallel_cases: 2,
          published_case_count: 2,
        }],
        next_cursor: null,
      },
      error: null,
      refetch: vi.fn(),
      status: "ready",
    });
    fakes.listBatchCases.mockImplementation((
      _projectId: string,
      batchId: string | null,
      _query: ProjectBatchCasesQuery,
    ) =>
      batchId === "batch-a"
        ? {
            data: {
              batch_id: "batch-a",
              axes: [{ name: "B_ext", canonical_unit: "T" }],
              cases: [{
                case_id: "case-a",
                parameter_tuple: { B_ext: 0.01 },
                planned_run_id: "run-a",
                state: "pending_expansion",
                published_run: null,
              }, {
                case_id: "case-b",
                parameter_tuple: { B_ext: 0.02 },
                planned_run_id: "run-b",
                state: "materialized",
                published_run: {
                  run_id: "run-b",
                  catalog_state: "materialized",
                  catalog_revision: 7,
                  tasks: [{ task_id: "task-b", lifecycle: "running", cancellation_requested: false }],
                },
              }],
              next_cursor: "case-b",
            },
            error: null,
            refetch: vi.fn(),
            status: "ready",
          }
        : {
            data: null,
            error: null,
            refetch: vi.fn(),
            status: "idle",
          },
    );
    fakes.runDetails.mockReturnValue({
      data: {
        catalog_revision: 7,
        catalog_state: "materialized",
        project_id: "project-a",
        run_id: "run-b",
        tasks: [{
          lifecycle: "running",
          readiness: { state: "ready" },
          task_id: "task-b",
        }],
      },
      error: null,
      refetch: vi.fn(),
      status: "ready",
    });
    fakes.runResults.mockReturnValue({
      data: {
        items: [{
          manifest_digest: `sha256:${"b".repeat(64)}`,
          revision: "4",
          solution_set_id: "solution-a",
        }],
        project_id: "project-a",
        run_id: "run-b",
        schema_version: "fullmag.analysis.solution_set_discovery.v1",
        next_cursor: null,
      },
      error: null,
      refetch: vi.fn(),
      status: "ready",
    });
  });

  afterEach(async () => {
    await act(async () => roots.forEach((root) => root.unmount()));
    vi.unstubAllGlobals();
    dom.restore();
  });

  it("shows published progress and opens a paged case list", async () => {
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    roots.push(root);

    await act(async () => root.render(<ProjectBatchesSection />));

    expect(container.textContent).toContain("Saved project batches");
    expect(container.textContent).toContain(
      "Expanding · 2 / 5 cases published · max parallel 2 · on failure: continue independent cases",
    );
    expect(fakes.listBatchCases).toHaveBeenCalledWith("project-a", null, {
      cursor: null,
      limit: 20,
    });

    const toggle = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "batch-a",
      "batch disclosure",
    );
    await act(async () => toggle.click());

    expect(container.textContent).toContain("B_ext=0.01 T");
    expect(container.textContent).toContain("B_ext=0.02 T");
    expect(container.textContent).toContain("Planned run: run-a");
    expect(container.textContent).toContain("Child run has not been published.");
    expect(container.textContent).toContain("Published child run: run-b");
    expect(container.textContent).toContain("Task catalog revision 7 · 1 task(s)");
    expect(container.textContent).toContain("running · task-b");
    expect(findElements(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "View run details",
    )).toHaveLength(1);
    const viewRun = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "View run details",
      "view run details button",
    );
    await act(async () => viewRun.click());
    expect(container.textContent).toContain("Task catalog revision 7");
    expect(container.textContent).toContain("running · ready");
    expect(container.textContent).toContain("task-b");
    expect(container.textContent).toContain("Available results");
    expect(container.textContent).toContain("solution-a · revision 4");
    expect(fakes.listBatchCases).toHaveBeenLastCalledWith("project-a", "batch-a", {
      cursor: null,
      limit: 20,
    });

    const nextCases = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "Next cases",
      "next cases button",
    );
    await act(async () => nextCases.click());
    expect(fakes.listBatchCases).toHaveBeenLastCalledWith("project-a", "batch-a", {
      cursor: "case-b",
      limit: 20,
    });
  });

  it("retries uncertain task materialization with the same child run ID", async () => {
    const materialize = vi.fn()
      .mockRejectedValueOnce(new Error("connection closed"))
      .mockResolvedValueOnce({
        catalog_revision: 8,
        execution_state: "pending_preparation",
        run_id: "run-pending",
        task_ids: ["task-pending"],
      });
    fakes.materializeRun.mockReturnValue(materialize);
    const refreshCases = vi.fn().mockResolvedValue(undefined);
    fakes.listBatchCases.mockImplementation((
      _projectId: string,
      batchId: string | null,
      _query: ProjectBatchCasesQuery,
    ) => batchId === "batch-a"
      ? {
          data: {
            batch_id: "batch-a",
            axes: [{ name: "B_ext", canonical_unit: "T" }],
            cases: [{
              case_id: "case-pending",
              parameter_tuple: { B_ext: 0.01 },
              planned_run_id: "run-pending",
              state: "pending_materialization",
              published_run: {
                run_id: "run-pending",
                catalog_state: "pending_materialization",
                catalog_revision: null,
                tasks: [],
              },
            }],
            next_cursor: null,
          },
          error: null,
          refetch: refreshCases,
          status: "ready",
        }
      : {
          data: null,
          error: null,
          refetch: vi.fn(),
          status: "idle",
        });
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    roots.push(root);

    await act(async () => root.render(<ProjectBatchesSection />));
    const batch = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "batch-a",
      "batch disclosure",
    );
    await act(async () => batch.click());
    const materializeButton = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "Materialize tasks",
      "materialize tasks button",
    );
    await act(async () => materializeButton.click());

    expect(materialize).toHaveBeenCalledTimes(1);
    expect(materialize).toHaveBeenNthCalledWith(1, "run-pending");
    expect(container.textContent).toContain("Materialization outcome is unknown");
    expect(container.textContent).toContain("Retry will reuse the same run ID.");

    const retry = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "Retry materialization",
      "retry materialization button",
    );
    await act(async () => retry.click());

    expect(materialize).toHaveBeenCalledTimes(2);
    expect(materialize.mock.calls.map(([runId]) => runId)).toEqual([
      "run-pending",
      "run-pending",
    ]);
    expect(refreshCases).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(
      "Task catalog revision 8 materialized; case status refreshed.",
    );
  });

  it("shows definitive materialization rejection separately from an unknown outcome", async () => {
    const rejection = Object.assign(new Error("run belongs to another project"), { status: 409 });
    const materialize = vi.fn().mockRejectedValue(rejection);
    fakes.materializeRun.mockReturnValue(materialize);
    fakes.listBatchCases.mockImplementation((
      _projectId: string,
      batchId: string | null,
    ) => batchId === "batch-a"
      ? {
          data: {
            batch_id: "batch-a",
            axes: [{ name: "B_ext", canonical_unit: "T" }],
            cases: [{
              case_id: "case-pending",
              parameter_tuple: { B_ext: 0.01 },
              planned_run_id: "run-pending",
              state: "pending_materialization",
              published_run: {
                run_id: "run-pending",
                catalog_state: "pending_materialization",
                catalog_revision: null,
                tasks: [],
              },
            }],
            next_cursor: null,
          },
          error: null,
          refetch: vi.fn(),
          status: "ready",
        }
      : {
          data: null,
          error: null,
          refetch: vi.fn(),
          status: "idle",
        });
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    roots.push(root);

    await act(async () => root.render(<ProjectBatchesSection />));
    const batch = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "batch-a",
      "batch disclosure",
    );
    await act(async () => batch.click());
    const materializeButton = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "Materialize tasks",
      "materialize tasks button",
    );
    await act(async () => materializeButton.click());

    expect(materialize).toHaveBeenCalledWith("run-pending");
    expect(container.textContent).toContain("Materialization was rejected (HTTP 409)");
    expect(container.textContent).not.toContain("Materialization outcome is unknown");
    expect(findElements(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "Retry materialization",
    )).toHaveLength(0);
  });

  it("stops a running task from the selected batch child run", async () => {
    const requestCancellation = vi.fn().mockResolvedValue(undefined);
    fakes.cancelTask.mockReturnValue(requestCancellation);
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    roots.push(root);

    await act(async () => root.render(<ProjectBatchesSection />));
    const batch = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "batch-a",
      "batch disclosure",
    );
    await act(async () => batch.click());
    const viewRun = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "View run details",
      "view run details button",
    );
    await act(async () => viewRun.click());
    const stopTask = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "Stop active task",
      "stop active task button",
    );
    await act(async () => stopTask.click());

    expect(requestCancellation).toHaveBeenCalledWith(
      "task-b",
      "Cancelled from the project batch inspector",
      undefined,
    );
  });

  it("retries an uncertain batch admission command with the same durable command ID", async () => {
    const submitCommand = vi.fn()
      .mockRejectedValueOnce(new Error("connection closed"))
      .mockResolvedValueOnce({
        disposition: "replayed",
        command_id: "command-1",
      });
    fakes.commandBatch.mockReturnValue(submitCommand);
    vi.stubGlobal("crypto", { randomUUID: () => "command-1" });
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    roots.push(root);

    await act(async () => root.render(<ProjectBatchesSection />));
    const pause = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "Pause admission",
      "pause admission button",
    );
    await act(async () => pause.click());

    expect(submitCommand).toHaveBeenCalledTimes(1);
    const firstRequest = submitCommand.mock.calls[0]?.[1];
    expect(firstRequest).toMatchObject({
      action: "pause_admission",
      command_id: "command-1",
      expected_revision: 0,
    });
    expect(container.textContent).toContain("Retry will reuse the same command ID.");

    const retry = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "Retry Pause admission",
      "retry admission button",
    );
    await act(async () => retry.click());

    expect(submitCommand).toHaveBeenCalledTimes(2);
    expect(submitCommand.mock.calls[1]?.[1]).toBe(firstRequest);
    expect(container.textContent).toContain("The same admission command was already accepted.");
  });

  it("fences queued child-task cancellation to the observed catalog revision", async () => {
    const requestCancellation = vi.fn().mockResolvedValue(undefined);
    fakes.cancelTask.mockReturnValue(requestCancellation);
    fakes.runDetails.mockReturnValue({
      data: {
        catalog_revision: 9,
        catalog_state: "materialized",
        project_id: "project-a",
        run_id: "run-b",
        tasks: [{
          lifecycle: "queued",
          readiness: { state: "ready" },
          task_id: "task-b",
        }],
      },
      error: null,
      refetch: vi.fn(),
      status: "ready",
    });
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    roots.push(root);

    await act(async () => root.render(<ProjectBatchesSection />));
    const batch = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "batch-a",
      "batch disclosure",
    );
    await act(async () => batch.click());
    const viewRun = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "View run details",
      "view run details button",
    );
    await act(async () => viewRun.click());
    const cancelTask = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "Cancel queued task",
      "cancel queued task button",
    );
    await act(async () => cancelTask.click());

    expect(requestCancellation).toHaveBeenCalledWith(
      "task-b",
      "Cancelled from the project batch inspector",
      9,
    );
  });

  it("stops admission before bulk cancellation and retries an uncertain task with the same IDs", async () => {
    const submitCommand = vi.fn().mockResolvedValue({
      disposition: "accepted",
      command_id: "operation-1",
    });
    fakes.commandBatch.mockReturnValue(submitCommand);
    const cancelBatchTask = vi.fn()
      .mockRejectedValueOnce(new Error("connection closed"))
      .mockResolvedValueOnce({ disposition: "replayed" });
    fakes.cancelTaskById.mockReturnValue(cancelBatchTask);
    const loadAllCases = vi.fn().mockResolvedValue([{
      case_id: "case-queued",
      parameter_tuple: { B_ext: 0.03 },
      planned_run_id: "run-queued",
      state: "materialized",
      published_run: {
        run_id: "run-queued",
        catalog_state: "materialized",
        catalog_revision: 9,
        tasks: [{ task_id: "task-queued", lifecycle: "queued", cancellation_requested: false }],
      },
    }, {
      case_id: "case-active",
      parameter_tuple: { B_ext: 0.04 },
      planned_run_id: "run-active",
      state: "materialized",
      published_run: {
        run_id: "run-active",
        catalog_state: "materialized",
        catalog_revision: 4,
        tasks: [{ task_id: "task-active", lifecycle: "running", cancellation_requested: false }],
      },
    }, {
      case_id: "case-materializing",
      parameter_tuple: { B_ext: 0.05 },
      planned_run_id: "run-materializing",
      state: "pending_materialization",
      published_run: {
        run_id: "run-materializing",
        catalog_state: "pending_materialization",
        catalog_revision: null,
        tasks: [],
      },
    }]);
    fakes.loadAllBatchCases.mockReturnValue(loadAllCases);
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn()
        .mockReturnValueOnce("operation-1")
        .mockReturnValueOnce("cancellation-1"),
    });
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    roots.push(root);

    await act(async () => root.render(<ProjectBatchesSection />));
    const cancelPending = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "Cancel pending",
      "cancel pending batch button",
    );
    await act(async () => cancelPending.click());

    expect(submitCommand).toHaveBeenCalledWith("batch-a", expect.objectContaining({
      action: "cancel_admission",
      command_id: "operation-1",
      expected_revision: 0,
    }));
    expect(loadAllCases).toHaveBeenCalledWith("batch-a");
    expect(cancelBatchTask).toHaveBeenCalledTimes(1);
    const firstRequest = cancelBatchTask.mock.calls[0]?.[2];
    expect(firstRequest).toMatchObject({
      cancellation_id: "cancellation-1",
      expected_catalog_revision: 9,
      reason: "Batch batch-a: Cancel pending cases",
    });

    const retry = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "Retry Cancel pending cases",
      "retry batch cancellation button",
    );
    await act(async () => retry.click());

    expect(submitCommand).toHaveBeenCalledTimes(1);
    expect(loadAllCases).toHaveBeenCalledTimes(1);
    expect(cancelBatchTask).toHaveBeenCalledTimes(2);
    expect(cancelBatchTask.mock.calls[1]?.[2]).toBe(firstRequest);
    expect(container.textContent).toContain("1 active task(s) were left running.");
    expect(container.textContent).toContain("1 published case(s) still await task materialization");
    expect(container.textContent).toContain("Wait for terminal task receipts and resource release");
  });

  it("sends Stop to active tasks only for the explicit stop-active batch action", async () => {
    const submitCommand = vi.fn().mockResolvedValue({
      disposition: "accepted",
      command_id: "operation-stop",
    });
    fakes.commandBatch.mockReturnValue(submitCommand);
    const cancelBatchTask = vi.fn().mockResolvedValue({ disposition: "accepted" });
    fakes.cancelTaskById.mockReturnValue(cancelBatchTask);
    vi.stubGlobal("crypto", { randomUUID: () => "operation-stop" });
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    roots.push(root);

    await act(async () => root.render(<ProjectBatchesSection />));
    const stopActive = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "Stop active + cancel pending",
      "stop active batch button",
    );
    await act(async () => stopActive.click());

    expect(cancelBatchTask).toHaveBeenCalledWith(
      "run-b",
      "task-b",
      { reason: "Batch batch-a: Stop active and cancel pending cases" },
    );
    expect(container.textContent).toContain("1 active task(s).");
    expect(container.textContent).toContain("Wait for terminal task receipts and resource release");
  });

  it("does not create another request for a task with durable cancellation intent", async () => {
    const cancelBatchTask = vi.fn().mockResolvedValue({ disposition: "replayed" });
    fakes.cancelTaskById.mockReturnValue(cancelBatchTask);
    const loadAllCases = vi.fn().mockResolvedValue([{
      case_id: "case-queued",
      parameter_tuple: { B_ext: 0.03 },
      planned_run_id: "run-queued",
      state: "materialized",
      published_run: {
        run_id: "run-queued",
        catalog_state: "materialized",
        catalog_revision: 9,
        tasks: [{ task_id: "task-queued", lifecycle: "queued", cancellation_requested: true }],
      },
    }]);
    fakes.loadAllBatchCases.mockReturnValue(loadAllCases);
    vi.stubGlobal("crypto", { randomUUID: () => "operation-existing" });
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    roots.push(root);

    await act(async () => root.render(<ProjectBatchesSection />));
    const cancelPending = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "Cancel pending",
      "cancel pending batch button",
    );
    await act(async () => cancelPending.click());

    expect(cancelBatchTask).not.toHaveBeenCalled();
    expect(container.textContent).toContain("1 task(s) already had a cancellation request.");
  });
});
