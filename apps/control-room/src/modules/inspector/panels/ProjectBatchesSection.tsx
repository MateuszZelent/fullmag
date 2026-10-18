"use client";

import { useState } from "react";

import type {
  ProjectBatchCommandAction,
  ProjectBatchCommandRequest,
  ProjectBatchAxisSummaryResource,
  ProjectBatchCaseSummaryResource,
  ProjectBatchSummaryResource,
  ProjectRunTaskCancellationRequest,
  SolutionSetDiscoveryPageResource,
} from "@/kernel/api/apiTypes";
import { useProjectDocumentSnapshot } from "@/kernel/persistence/ProjectDocumentStatus";
import {
  useCommandProjectBatch,
  useLoadAllProjectBatchCases,
  useProjectBatchCasesResource,
  useProjectBatchesResource,
  useRetryProjectBatchCaseTask,
} from "@/kernel/resources/projectBatchResources";
import {
  useCancelProjectRunTask,
  useCancelProjectRunTaskById,
  useMaterializeProjectRun,
  useProjectRunResource,
} from "@/kernel/resources/projectRunResources";
import { useSolutionSetDiscoveryResource } from "@/kernel/resources/solutionSetResources";
import { Button } from "@/shared/ui/Button";

import { BatchCaseResults } from "./BatchCaseResults";
import { InspectorGroup } from "../primitives/InspectorGroup";

const BATCH_PAGE_LIMIT = 20;
const CASE_PAGE_LIMIT = 20;

type PendingBatchCommand = {
  readonly batchId: string;
  readonly request: ProjectBatchCommandRequest;
};

type MaterializationFeedback = {
  readonly runId: string;
  readonly kind: "error" | "rejected" | "status";
  readonly message: string;
};

type BatchCommandFeedback = {
  readonly batchId: string;
  readonly message: string;
};

type BatchLifecycleAction = "cancel_pending" | "stop_active_and_cancel_pending";

type BatchTaskCancellationTarget = {
  readonly runId: string;
  readonly taskId: string;
  readonly kind: "pending" | "active";
  readonly request: ProjectRunTaskCancellationRequest;
};

type BatchTaskCancellationPlan = {
  readonly targets: readonly BatchTaskCancellationTarget[];
  readonly alreadyRequestedCount: number;
  readonly activeTasksLeftRunning: number;
  readonly notAdmittedCaseCount: number;
  readonly pendingMaterializationCaseCount: number;
};

type PendingBatchLifecycle = {
  readonly batchId: string;
  readonly action: BatchLifecycleAction;
  readonly operationId: string;
  readonly admissionRequest: ProjectBatchCommandRequest | null;
  readonly admissionAccepted: boolean;
  readonly plan: BatchTaskCancellationPlan | null;
  readonly nextTargetIndex: number;
};

type PendingCaseLifecycle = {
  readonly batchId: string;
  readonly caseId: string;
  readonly operationId: string;
  readonly runId: string | null;
  readonly plan: BatchTaskCancellationPlan | null;
  readonly nextTargetIndex: number;
};

type CaseLifecycleFeedback = {
  readonly kind: "error" | "status";
  readonly message: string;
  readonly cancellationRunId?: string;
  readonly cancellationCatalogRevision?: number;
};

type SelectedBatchResult = {
  readonly runId: string;
  readonly solution: SolutionSetDiscoveryPageResource["items"][number];
};

export function ProjectBatchesSection() {
  const project = useProjectDocumentSnapshot();
  if (project.state !== "ready") return null;
  return <ProjectBatchesPage key={project.resource.project_id} projectId={project.resource.project_id} />;
}

function ProjectBatchesPage({ projectId }: { readonly projectId: string }) {
  const [batchCursor, setBatchCursor] = useState<string | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [caseCursor, setCaseCursor] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [resultCursor, setResultCursor] = useState<string | null>(null);
  const [selectedBatchResult, setSelectedBatchResult] = useState<SelectedBatchResult | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [pendingMaterializationRunId, setPendingMaterializationRunId] = useState<string | null>(null);
  const [materializationFeedback, setMaterializationFeedback] = useState<MaterializationFeedback | null>(null);
  const [pendingBatchCommand, setPendingBatchCommand] = useState<PendingBatchCommand | null>(null);
  const [busyBatchCommandId, setBusyBatchCommandId] = useState<string | null>(null);
  const [batchCommandError, setBatchCommandError] = useState<BatchCommandFeedback | null>(null);
  const [batchCommandStatus, setBatchCommandStatus] = useState<BatchCommandFeedback | null>(null);
  const [pendingBatchLifecycle, setPendingBatchLifecycle] = useState<PendingBatchLifecycle | null>(null);
  const [busyBatchLifecycleId, setBusyBatchLifecycleId] = useState<string | null>(null);
  const [batchLifecycleError, setBatchLifecycleError] = useState<BatchCommandFeedback | null>(null);
  const [batchLifecycleStatus, setBatchLifecycleStatus] = useState<BatchCommandFeedback | null>(null);
  const [pendingCaseLifecycles, setPendingCaseLifecycles] = useState<Record<string, PendingCaseLifecycle>>({});
  const [busyCaseLifecycleIds, setBusyCaseLifecycleIds] = useState<Record<string, string>>({});
  const [caseLifecycleFeedback, setCaseLifecycleFeedback] = useState<Record<string, CaseLifecycleFeedback>>({});
  const [cancelError, setCancelError] = useState<{
    readonly message: string;
    readonly runId: string;
    readonly taskId: string;
  } | null>(null);
  const [pendingRetryTaskId, setPendingRetryTaskId] = useState<string | null>(null);
  const [retryFeedback, setRetryFeedback] = useState<{
    readonly kind: "error" | "status";
    readonly message: string;
    readonly runId: string;
    readonly taskId: string;
  } | null>(null);
  const batches = useProjectBatchesResource(projectId, {
    cursor: batchCursor,
    limit: BATCH_PAGE_LIMIT,
  });
  const cases = useProjectBatchCasesResource(projectId, selectedBatchId, {
    cursor: caseCursor,
    limit: CASE_PAGE_LIMIT,
  });
  const selectedRun = useProjectRunResource(projectId, selectedRunId);
  const materializeRun = useMaterializeProjectRun(projectId);
  const cancelTask = useCancelProjectRunTask(projectId, selectedRunId, null);
  const cancelBatchTask = useCancelProjectRunTaskById(projectId);
  const retryBatchCaseTask = useRetryProjectBatchCaseTask(projectId);
  const commandBatch = useCommandProjectBatch(projectId);
  const loadAllBatchCases = useLoadAllProjectBatchCases(projectId);
  const selectedRunResults = useSolutionSetDiscoveryResource(projectId, selectedRunId, {
    query: { cursor: resultCursor, limit: 25 },
  });

  const selectBatch = (batchId: string) => {
    setCaseCursor(null);
    setResultCursor(null);
    setSelectedBatchResult(null);
    setRetryFeedback(null);
    setSelectedRunId(null);
    setSelectedBatchId((current) => current === batchId ? null : batchId);
  };

  const toggleRunDetails = (runId: string) => {
    setResultCursor(null);
    setSelectedBatchResult(null);
    setCancelError(null);
    setRetryFeedback(null);
    setSelectedRunId((current) => current === runId ? null : runId);
  };

  const handleCancelTask = async (taskId: string) => {
    const run = selectedRun.data;
    if (!run) return;
    const task = run.tasks.find((candidate) => candidate.task_id === taskId);
    if (!task || !isCancelableTaskLifecycle(task.lifecycle)) return;

    setPendingTaskId(taskId);
    setCancelError(null);
    const beforeClaim = task.lifecycle === "accepted" || task.lifecycle === "queued";
    const revision = run.catalog_revision;
    try {
      if (beforeClaim && (revision === null || revision === undefined)) {
        throw new Error("Refresh run details before cancelling this task.");
      }
      await cancelTask(
        taskId,
        "Cancelled from the project batch inspector",
        beforeClaim ? revision! : undefined,
      );
    } catch (error) {
      void selectedRun.refetch();
      setCancelError({
        message: `Cancellation was not confirmed: ${error instanceof Error ? error.message : "unknown error"}`,
        runId: run.run_id,
        taskId,
      });
      setPendingTaskId((current) => (current === taskId ? null : current));
      return;
    }

    try {
      await Promise.all([selectedRun.refetch(), cases.refetch(), batches.refetch()]);
    } catch (error) {
      setCancelError({
        message: `Cancellation was accepted, but status refresh failed: ${error instanceof Error ? error.message : "unknown error"}`,
        runId: run.run_id,
        taskId,
      });
    } finally {
      setPendingTaskId((current) => (current === taskId ? null : current));
    }
  };

  const handleRetryTask = async (taskId: string) => {
    const run = selectedRun.data;
    if (!run || !selectedBatchId) return;
    const task = run.tasks.find((candidate) => candidate.task_id === taskId);
    if (
      !task ||
      (task.lifecycle !== "failed" && task.lifecycle !== "interrupted") ||
      task.cancellation_intent
    ) return;

    const revision = run.catalog_revision;
    if (revision === null || revision === undefined) {
      setRetryFeedback({
        kind: "error",
        message: "Refresh run details before retrying this task.",
        runId: run.run_id,
        taskId,
      });
      return;
    }

    const batch = batches.data?.batches.find((candidate) => candidate.batch_id === selectedBatchId);
    const batchCase = cases.data?.cases.find((candidate) =>
      candidate.published_run?.run_id === run.run_id);
    if (!batch || !batchCase) {
      setRetryFeedback({
        kind: "error",
        message: "Refresh the selected batch and case details before retrying this task.",
        runId: run.run_id,
        taskId,
      });
      return;
    }

    setPendingRetryTaskId(taskId);
    setRetryFeedback(null);
    let retryLifecycle: string;
    try {
      const retry = await retryBatchCaseTask(
        batch.batch_id,
        batchCase.case_id,
        run.run_id,
        taskId,
        batch.command_revision,
        revision,
      );
      retryLifecycle = retry.lifecycle;
    } catch (error) {
      void selectedRun.refetch();
      void cases.refetch();
      void batches.refetch();
      setRetryFeedback({
        kind: "error",
        message: isDefinitiveBatchCommandRejection(error)
          ? `The batch retry was rejected (HTTP ${error.status}). Refresh the batch and run status before trying again. ${error.message}`
          : `Could not confirm retry: ${error instanceof Error ? error.message : "unknown error"}. Refresh status. If the same failed attempt remains, retry will reuse the same command and retry IDs.`,
        runId: run.run_id,
        taskId,
      });
      setPendingRetryTaskId((current) => current === taskId ? null : current);
      return;
    }

    try {
      await Promise.all([selectedRun.refetch(), cases.refetch(), batches.refetch()]);
      setRetryFeedback({
        kind: "status",
        message: `Retry was accepted; task status is ${retryLifecycle}.`,
        runId: run.run_id,
        taskId,
      });
    } catch (error) {
      setRetryFeedback({
        kind: "error",
        message: `Retry was accepted, but status refresh failed: ${error instanceof Error ? error.message : "unknown error"}.`,
        runId: run.run_id,
        taskId,
      });
    } finally {
      setPendingRetryTaskId((current) => current === taskId ? null : current);
    }
  };

  const handleMaterializeRun = async (runId: string) => {
    setPendingMaterializationRunId(runId);
    setMaterializationFeedback(null);
    let catalogRevision: number;
    try {
      const materialization = await materializeRun(runId);
      catalogRevision = materialization.catalog_revision;
    } catch (error) {
      if (isDefinitiveHttpRejection(error)) {
        setMaterializationFeedback({
          runId,
          kind: "rejected",
          message: `Materialization was rejected (HTTP ${error.status}): ${error.message}. Refresh the batch and run status before trying again.`,
        });
        setPendingMaterializationRunId((current) => current === runId ? null : current);
        return;
      }
      setMaterializationFeedback({
        runId,
        kind: "error",
        message: `Materialization outcome is unknown: ${error instanceof Error ? error.message : "unknown error"}. Retry will reuse the same run ID.`,
      });
      setPendingMaterializationRunId((current) => current === runId ? null : current);
      return;
    }

    try {
      await Promise.all([
        cases.refetch(),
        batches.refetch(),
        selectedRunId === runId ? selectedRun.refetch() : Promise.resolve(),
      ]);
      setMaterializationFeedback({
        runId,
        kind: "status",
        message: `Task catalog revision ${catalogRevision} materialized; case status refreshed.`,
      });
    } catch (error) {
      setMaterializationFeedback({
        runId,
        kind: "error",
        message: `Task catalog revision ${catalogRevision} materialized, but refreshing its status failed: ${error instanceof Error ? error.message : "unknown error"}. Use Refresh to reconcile.`,
      });
    } finally {
      setPendingMaterializationRunId((current) => current === runId ? null : current);
    }
  };

  const refreshBatchCommandStatus = async (batchId: string) => {
    await batches.refetch();
    if (selectedBatchId === batchId) await cases.refetch();
  };

  const sendBatchCommand = async (batchId: string, request: ProjectBatchCommandRequest) => {
    setPendingBatchCommand({ batchId, request });
    setBusyBatchCommandId(request.command_id);
    setBatchCommandError(null);
    setBatchCommandStatus(null);
    try {
      const accepted = await commandBatch(batchId, request);
      setPendingBatchCommand((current) =>
        current?.request.command_id === request.command_id ? null : current,
      );
      setBatchCommandStatus({
        batchId,
        message: accepted.disposition === "replayed"
          ? "The same admission command was already accepted."
          : "Admission command accepted.",
      });
      try {
        await refreshBatchCommandStatus(batchId);
      } catch (error) {
        setBatchCommandError({
          batchId,
          message: `The command was accepted, but status refresh failed: ${error instanceof Error ? error.message : "unknown error"}`,
        });
      }
    } catch (error) {
      if (isDefinitiveBatchCommandRejection(error)) {
        setPendingBatchCommand((current) =>
          current?.request.command_id === request.command_id ? null : current,
        );
        setBatchCommandError({
          batchId,
          message: `The admission command was rejected (HTTP ${error.status}). Batch status is being refreshed; issue a new command against its current revision. ${error.message}`,
        });
      } else {
        setBatchCommandError({
          batchId,
          message: `The command outcome is unknown: ${error instanceof Error ? error.message : "unknown error"}. Retry will reuse the same command ID.`,
        });
      }
      try {
        await refreshBatchCommandStatus(batchId);
      } catch {
        // The explicit Refresh action remains available if reconciliation also fails.
      }
    } finally {
      setBusyBatchCommandId((current) => current === request.command_id ? null : current);
    }
  };

  const startBatchCommand = async (
    batch: ProjectBatchSummaryResource,
    action: ProjectBatchCommandAction,
  ) => {
    const commandId = globalThis.crypto?.randomUUID?.();
    if (!commandId) {
      setBatchCommandError({
        batchId: batch.batch_id,
        message: "This browser cannot create a secure command ID; reload the local application and try again.",
      });
      return;
    }
    await sendBatchCommand(batch.batch_id, {
      action,
      command_id: commandId,
      expected_revision: batch.command_revision,
      reason: `Batch admission ${action} from the project inspector`,
    });
  };

  const setPendingCaseLifecycle = (key: string, operation: PendingCaseLifecycle | null) => {
    setPendingCaseLifecycles((current) => {
      const next = { ...current };
      if (operation) next[key] = operation;
      else delete next[key];
      return next;
    });
  };

  const setCaseLifecycleNotice = (key: string, feedback: CaseLifecycleFeedback | null) => {
    setCaseLifecycleFeedback((current) => {
      const next = { ...current };
      if (feedback) next[key] = feedback;
      else delete next[key];
      return next;
    });
  };

  const executeCaseLifecycle = async (key: string, operation: PendingCaseLifecycle) => {
    let current = operation;
    setBusyCaseLifecycleIds((busy) => ({ ...busy, [key]: operation.operationId }));
    setCaseLifecycleNotice(key, null);
    try {
      if (!current.plan) {
        const loadedCases = await loadAllBatchCases(current.batchId);
        const batchCase = loadedCases.find((candidate) => candidate.case_id === current.caseId);
        if (!batchCase) throw new Error(`Case ${current.caseId} is no longer in batch ${current.batchId}.`);
        const publishedRun = batchCase.published_run ?? null;
        if (
          batchCase.state !== "materialized" ||
          !publishedRun ||
          publishedRun.catalog_state !== "materialized"
        ) {
          throw new Error(`Case ${current.caseId} must have a materialized task catalog before it can be cancelled.`);
        }

        const reason = `Batch ${current.batchId} case ${current.caseId}: cancel this case`;
        const plan = planBatchTaskCancellations(
          [batchCase],
          "stop_active_and_cancel_pending",
          reason,
        );
        current = { ...current, runId: publishedRun.run_id, plan };
        setPendingCaseLifecycle(key, current);
      }

      let plan = current.plan;
      if (!plan) throw new Error("Case cancellation plan was not created.");
      for (let index = current.nextTargetIndex; index < plan.targets.length; index += 1) {
        const target = plan.targets[index];
        if (!target) throw new Error("Case cancellation target disappeared.");
        const response = await cancelBatchTask(target.runId, target.taskId, target.request);
        plan = advanceBatchTaskCancellationPlan(plan, index, response.catalog_revision);
        current = { ...current, plan, nextTargetIndex: index + 1 };
        setPendingCaseLifecycle(key, current);
      }

      await cases.refetch();
      const reconciledCases = await loadAllBatchCases(current.batchId);
      if (!cancellationTargetsObserved(reconciledCases, plan.targets)) {
        setPendingCaseLifecycle(key, current);
        setCaseLifecycleNotice(key, {
          kind: "status",
          message: `Cancellation requests were accepted for case ${current.caseId}, but its task status has not caught up. Refresh case status to reconcile without resending requests.`,
        });
        return;
      }
      if (current.runId && selectedRunId === current.runId) await selectedRun.refetch();
      const reconciledRun = reconciledCases.find((candidate) =>
        candidate.case_id === current.caseId)?.published_run ?? null;
      setCaseLifecycleNotice(key, {
        kind: "status",
        message: caseLifecycleCompletionMessage(current.caseId, plan),
        cancellationRunId: reconciledRun?.run_id,
        cancellationCatalogRevision: reconciledRun?.catalog_state === "materialized" &&
            typeof reconciledRun.catalog_revision === "number"
          ? reconciledRun.catalog_revision
          : undefined,
      });
      setPendingCaseLifecycle(key, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      if (!current.plan) {
        setPendingCaseLifecycle(key, current);
        setCaseLifecycleNotice(key, {
          kind: "error",
          message: `Could not prepare case cancellation: ${message}. Retry will reload this case before sending requests.`,
        });
      } else if (isDefinitiveHttpRejection(error)) {
        setPendingCaseLifecycle(key, null);
        setCaseLifecycleNotice(key, {
          kind: "error",
          message: `The request was rejected (HTTP ${error.status}). Refresh this case before issuing a new cancellation. ${message}`,
        });
      } else if (current.nextTargetIndex >= current.plan.targets.length) {
        setPendingCaseLifecycle(key, current);
        setCaseLifecycleNotice(key, {
          kind: "error",
          message: `Cancellation requests were sent, but status refresh failed: ${message}. Retry will refresh without resending completed requests.`,
        });
      } else {
        setPendingCaseLifecycle(key, current);
        setCaseLifecycleNotice(key, {
          kind: "error",
          message: `The outcome is unknown: ${message}. Retry will reuse the same task cancellation IDs and catalog revisions.`,
        });
      }
    } finally {
      setBusyCaseLifecycleIds((busy) => {
        if (busy[key] !== operation.operationId) return busy;
        const next = { ...busy };
        delete next[key];
        return next;
      });
    }
  };

  const startCaseLifecycle = (batchId: string, caseId: string) => {
    const key = caseLifecycleKey(batchId, caseId);
    if (pendingCaseLifecycles[key] || busyCaseLifecycleIds[key]) return;
    const operationId = globalThis.crypto?.randomUUID?.();
    if (!operationId) {
      setCaseLifecycleNotice(key, {
        kind: "error",
        message: "This browser cannot create a secure request ID; reload the local application and try again.",
      });
      return;
    }
    const operation: PendingCaseLifecycle = {
      batchId,
      caseId,
      operationId,
      runId: null,
      plan: null,
      nextTargetIndex: 0,
    };
    setPendingCaseLifecycle(key, operation);
    void executeCaseLifecycle(key, operation);
  };

  const retryCaseLifecycle = (key: string) => {
    const operation = pendingCaseLifecycles[key];
    if (!operation || busyCaseLifecycleIds[key]) return;
    void executeCaseLifecycle(key, operation);
  };

  const executeBatchLifecycle = async (operation: PendingBatchLifecycle) => {
    let current = operation;
    setBusyBatchLifecycleId(operation.operationId);
    setBatchLifecycleError(null);
    setBatchLifecycleStatus(null);
    try {
      if (current.admissionRequest && !current.admissionAccepted) {
        await commandBatch(current.batchId, current.admissionRequest);
        current = { ...current, admissionAccepted: true };
        setPendingBatchLifecycle(current);
      }

      if (!current.plan) {
        const cases = await loadAllBatchCases(current.batchId);
        const plan = planBatchTaskCancellations(
          cases,
          current.action,
          `Batch ${current.batchId}: ${batchLifecycleActionLabel(current.action)}`,
        );
        current = { ...current, plan };
        setPendingBatchLifecycle(current);
      }

      let plan = current.plan;
      if (!plan) throw new Error("Batch cancellation plan was not created.");
      for (let index = current.nextTargetIndex; index < plan.targets.length; index += 1) {
        const target = plan.targets[index];
        if (!target) throw new Error("Batch cancellation target disappeared.");
        const response = await cancelBatchTask(target.runId, target.taskId, target.request);
        plan = advanceBatchTaskCancellationPlan(plan, index, response.catalog_revision);
        current = { ...current, plan, nextTargetIndex: index + 1 };
        setPendingBatchLifecycle(current);
      }

      await refreshBatchCommandStatus(current.batchId);
      if (selectedBatchId === current.batchId) {
        await cases.refetch();
        if (selectedRunId) await selectedRun.refetch();
      }
      setBatchLifecycleStatus({
        batchId: current.batchId,
        message: batchLifecycleCompletionMessage(current),
      });
      setPendingBatchLifecycle(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      if (isDefinitiveHttpRejection(error)) {
        setPendingBatchLifecycle(null);
        setBatchLifecycleError({
          batchId: current.batchId,
          message: `The request was rejected (HTTP ${error.status}). Refresh the batch and task states before issuing a new action. ${message}`,
        });
      } else {
        setPendingBatchLifecycle(current);
        setBatchLifecycleError({
          batchId: current.batchId,
          message: `The outcome is unknown: ${message}. Retry will reuse the same command and cancellation IDs.`,
        });
      }
    } finally {
      setBusyBatchLifecycleId((busy) => busy === operation.operationId ? null : busy);
    }
  };

  const startBatchLifecycle = async (
    batch: ProjectBatchSummaryResource,
    action: BatchLifecycleAction,
  ) => {
    const operationId = globalThis.crypto?.randomUUID?.();
    if (!operationId) {
      setBatchLifecycleError({
        batchId: batch.batch_id,
        message: "This browser cannot create secure request IDs; reload the local application and try again.",
      });
      return;
    }
    const needsAdmissionGate = batch.expansion_state === "pending" ||
      batch.expansion_state === "expanding" ||
      batch.expansion_state === "paused";
    const admissionRequest = needsAdmissionGate
      ? {
          action: "cancel_admission" as const,
          command_id: operationId,
          expected_revision: batch.command_revision,
          reason: `${batchLifecycleActionLabel(action)} from the project batch inspector`,
        }
      : null;
    const operation: PendingBatchLifecycle = {
      batchId: batch.batch_id,
      action,
      operationId,
      admissionRequest,
      admissionAccepted: admissionRequest === null,
      plan: null,
      nextTargetIndex: 0,
    };
    setPendingBatchLifecycle(operation);
    await executeBatchLifecycle(operation);
  };

  const retryBatchLifecycle = () => {
    if (pendingBatchLifecycle) void executeBatchLifecycle(pendingBatchLifecycle);
  };

  const loadNextBatchPage = () => {
    setSelectedBatchId(null);
    setCaseCursor(null);
    setResultCursor(null);
    setSelectedRunId(null);
    setBatchCursor(batches.data?.next_cursor ?? null);
  };

  return (
    <InspectorGroup
      badge={batches.data ? `${batches.data.batches.length}` : undefined}
      description="Accepted parameter sweeps and their published case prefix."
      title="Saved project batches"
    >
      <Button
        aria-label="Refresh saved project batches"
        className="justify-self-start"
        size="sm"
        variant="ghost"
        onClick={() => {
          batches.refetch();
          cases.refetch();
          if (selectedRunId) {
            selectedRun.refetch();
            selectedRunResults.refetch();
          }
        }}
      >
        Refresh
      </Button>
      {batches.status === "loading" && !batches.data ? <p>Loading saved batches…</p> : null}
      {batches.error ? <p role="alert">Could not load saved batches: {batches.error.message}</p> : null}
      {batches.data?.batches.length === 0 ? <p>No submitted batches in this project.</p> : null}

      {batches.data?.batches.map((batch) => {
        const selected = selectedBatchId === batch.batch_id;
        const selectedRunResource = selectedRun.data;
        const selectedBatchCase = selected && selectedRunResource
          ? cases.data?.cases.find((candidate) =>
              candidate.published_run?.run_id === selectedRunResource.run_id) ?? null
          : null;
        const commandActions = batchAdmissionActions(batch.expansion_state);
        const pendingCommand = pendingBatchCommand?.batchId === batch.batch_id
          ? pendingBatchCommand
          : null;
        const commandError = batchCommandError?.batchId === batch.batch_id
          ? batchCommandError.message
          : null;
        const commandStatus = batchCommandStatus?.batchId === batch.batch_id
          ? batchCommandStatus.message
          : null;
        const pendingLifecycle = pendingBatchLifecycle?.batchId === batch.batch_id
          ? pendingBatchLifecycle
          : null;
        const lifecycleError = batchLifecycleError?.batchId === batch.batch_id
          ? batchLifecycleError.message
          : null;
        const lifecycleStatus = batchLifecycleStatus?.batchId === batch.batch_id
          ? batchLifecycleStatus.message
          : null;
        const hasPendingCaseLifecycle = Object.values(pendingCaseLifecycles)
          .some((operation) => operation.batchId === batch.batch_id);
        const pendingCaseOperations = Object.values(pendingCaseLifecycles)
          .filter((operation) => operation.batchId === batch.batch_id);
        const batchActionsDisabled = busyBatchCommandId !== null ||
          pendingBatchCommand !== null ||
          busyBatchLifecycleId !== null ||
          pendingBatchLifecycle !== null ||
          hasPendingCaseLifecycle;
        return (
          <div className="min-w-0 border-b border-fm-subtle py-2 last:border-b-0" key={batch.batch_id}>
            <Button
              aria-expanded={selected}
              className="h-auto max-w-full justify-start px-0 py-1 text-left"
              size="sm"
              title={batch.batch_id}
              variant="ghost"
              onClick={() => selectBatch(batch.batch_id)}
            >
              <span className="truncate">{batch.batch_id}</span>
            </Button>
            <div className="text-fm-xs text-fm-muted">
              {expansionStateLabel(batch.expansion_state)}
              {` · ${batch.published_case_count} / ${batch.case_count} cases published`}
              {` · max parallel ${batch.max_parallel_cases ?? "Auto"}`}
              {` · on failure: ${failurePolicyLabel(batch.failure_policy)}`}
            </div>
            <div aria-live="polite" className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
              {commandActions.map((action) => (
                <Button
                  aria-label={`${batchCommandActionLabel(action)} for batch ${batch.batch_id}`}
                  disabled={batchActionsDisabled}
                  key={action}
                  size="sm"
                  variant="secondary"
                  onClick={() => void startBatchCommand(batch, action)}
                >
                  {batchCommandActionLabel(action)}
                </Button>
              ))}
              <Button
                aria-label={`Cancel pending tasks for batch ${batch.batch_id}`}
                disabled={batchActionsDisabled}
                size="sm"
                variant="secondary"
                onClick={() => void startBatchLifecycle(batch, "cancel_pending")}
              >
                Cancel pending
              </Button>
              <Button
                aria-label={`Stop active and cancel pending tasks for batch ${batch.batch_id}`}
                disabled={batchActionsDisabled}
                size="sm"
                variant="secondary"
                onClick={() => void startBatchLifecycle(batch, "stop_active_and_cancel_pending")}
              >
                Stop active + cancel pending
              </Button>
              {pendingCommand ? (
                <Button
                  aria-label={`Retry ${batchCommandActionLabel(pendingCommand.request.action)} for batch ${batch.batch_id}`}
                  disabled={busyBatchCommandId !== null || busyBatchLifecycleId !== null}
                  size="sm"
                  variant="secondary"
                  onClick={() => void sendBatchCommand(batch.batch_id, pendingCommand.request)}
                >
                  {busyBatchCommandId === pendingCommand.request.command_id
                    ? "Sending…"
                    : `Retry ${batchCommandActionLabel(pendingCommand.request.action)}`}
                </Button>
              ) : null}
              {pendingLifecycle ? (
                <Button
                  aria-label={`Retry ${batchLifecycleActionLabel(pendingLifecycle.action)} for batch ${batch.batch_id}`}
                  disabled={busyBatchLifecycleId !== null || busyBatchCommandId !== null}
                  size="sm"
                  variant="secondary"
                  onClick={retryBatchLifecycle}
                >
                  {busyBatchLifecycleId === pendingLifecycle.operationId
                    ? "Requesting…"
                    : `Retry ${batchLifecycleActionLabel(pendingLifecycle.action)}`}
                </Button>
              ) : null}
              {pendingCaseOperations.map((operation) => {
                const key = caseLifecycleKey(operation.batchId, operation.caseId);
                const requestsComplete = Boolean(
                  operation.plan && operation.nextTargetIndex >= operation.plan.targets.length,
                );
                const feedback = caseLifecycleFeedback[key] ?? null;
                return (
                  <span className="flex min-w-0 flex-wrap items-center gap-1" key={key}>
                    <Button
                      aria-label={requestsComplete
                        ? `Refresh case status for ${operation.caseId}`
                        : `Retry cancel case ${operation.caseId}`}
                      disabled={busyCaseLifecycleIds[key] !== undefined || pendingLifecycle !== null}
                      size="sm"
                      variant="secondary"
                      onClick={() => retryCaseLifecycle(key)}
                    >
                      {busyCaseLifecycleIds[key]
                        ? "Cancelling…"
                        : requestsComplete
                          ? `Refresh case status · ${operation.caseId}`
                          : `Retry cancel case · ${operation.caseId}`}
                    </Button>
                    {feedback ? (
                      <span
                        role={feedback.kind === "status" ? "status" : "alert"}
                        className={feedback.kind === "status"
                          ? "text-fm-xs text-fm-muted"
                          : "text-fm-xs text-fm-danger"}
                      >
                        {feedback.message}
                      </span>
                    ) : null}
                  </span>
                );
              })}
              {commandStatus ? <span className="text-fm-xs text-fm-muted" role="status">{commandStatus}</span> : null}
              {commandError ? <span className="text-fm-xs text-fm-danger" role="alert">{commandError}</span> : null}
              {lifecycleStatus ? <span className="text-fm-xs text-fm-muted" role="status">{lifecycleStatus}</span> : null}
              {lifecycleError ? <span className="text-fm-xs text-fm-danger" role="alert">{lifecycleError}</span> : null}
            </div>
            {selected ? (
              <div aria-live="polite" className="mt-2 grid min-w-0 gap-2 rounded-md border border-fm-subtle p-2">
                {cases.status === "loading" && !cases.data ? <p>Loading batch cases…</p> : null}
                {cases.error ? <p role="alert">Could not load batch cases: {cases.error.message}</p> : null}
                {cases.data?.cases.map((batchCase) => {
                  const publishedRun = batchCase.published_run ?? null;
                  const caseKey = caseLifecycleKey(batch.batch_id, batchCase.case_id);
                  const caseOperation = pendingCaseLifecycles[caseKey] ?? null;
                  const caseBusy = busyCaseLifecycleIds[caseKey] !== undefined;
                  const caseFeedback = caseLifecycleFeedback[caseKey] ?? null;
                  const caseFeedbackCatalogRevision = caseFeedback?.cancellationCatalogRevision;
                  const suppressCaseCancellation = caseFeedback?.kind === "status" &&
                    typeof caseFeedbackCatalogRevision === "number" &&
                    publishedRun?.catalog_state === "materialized" &&
                    typeof publishedRun.catalog_revision === "number" &&
                    caseFeedback.cancellationRunId === publishedRun.run_id &&
                    publishedRun.catalog_revision <= caseFeedbackCatalogRevision;
                  const caseHasCancelableTasks = publishedRun?.catalog_state === "materialized" &&
                    publishedRun.tasks.some((task) =>
                      !task.cancellation_requested && isCancelableTaskLifecycle(task.lifecycle));
                  return (
                    <div className="grid min-w-0 gap-1 border-b border-fm-subtle pb-2 last:border-b-0 last:pb-0" key={batchCase.case_id}>
                      <div className="flex min-w-0 items-center justify-between gap-2 text-fm-xs">
                        <span className="truncate font-medium text-fm-primary" title={batchCase.case_id}>
                          {batchCase.case_id}
                        </span>
                        <span className="shrink-0 text-fm-muted">{caseStateLabel(batchCase.state)}</span>
                      </div>
                      <div className="break-words text-fm-xs text-fm-muted">
                        {formatParameterTuple(batchCase.parameter_tuple, cases.data?.axes ?? [])}
                      </div>
                      <div className="truncate text-fm-xs text-fm-muted" title={batchCase.planned_run_id}>
                        Planned run: {batchCase.planned_run_id}
                      </div>
                      {publishedRun ? (
                        <>
                          <div className="truncate text-fm-xs text-fm-muted" title={publishedRun.run_id}>
                            Published child run: {publishedRun.run_id}
                          </div>
                          <div className="text-fm-xs text-fm-muted">
                            {publishedRun.catalog_state === "materialized"
                              ? `Task catalog revision ${publishedRun.catalog_revision ?? "unknown"} · ${publishedRun.tasks.length} task(s)`
                              : "Task catalog pending materialization"}
                          </div>
                          {publishedRun.catalog_state === "pending_materialization" ? (
                            <p className="text-fm-xs text-fm-muted">
                              Case cancellation is unavailable until its task catalog is materialized.
                            </p>
                          ) : null}
                          {publishedRun.catalog_state === "pending_materialization" ? (
                            <>
                              <Button
                                aria-label={`Materialize tasks for run ${publishedRun.run_id}`}
                                className="justify-self-start"
                                disabled={pendingMaterializationRunId !== null}
                                size="sm"
                                variant="secondary"
                                onClick={() => void handleMaterializeRun(publishedRun.run_id)}
                              >
                                {pendingMaterializationRunId === publishedRun.run_id
                                  ? "Materializing…"
                                  : materializationFeedback?.runId === publishedRun.run_id &&
                                      materializationFeedback.kind === "error"
                                    ? "Retry materialization"
                                    : "Materialize tasks"}
                              </Button>
                              {materializationFeedback?.runId === publishedRun.run_id ? (
                                <p
                                  role={materializationFeedback.kind === "status" ? "status" : "alert"}
                                  className={materializationFeedback.kind === "status"
                                    ? "text-fm-xs text-fm-muted"
                                    : "text-fm-xs text-fm-danger"}
                                >
                                  {materializationFeedback.message}
                                </p>
                              ) : null}
                            </>
                          ) : null}
                          {publishedRun.tasks.map((task) => (
                            <div className="truncate text-fm-xs text-fm-muted" key={task.task_id} title={task.task_id}>
                              {task.lifecycle}{task.cancellation_requested ? " · cancellation requested" : ""} · {task.task_id}
                            </div>
                          ))}
                          {caseHasCancelableTasks && !caseOperation && !suppressCaseCancellation ? (
                            <Button
                              aria-label={`Cancel case ${batchCase.case_id}`}
                              className="justify-self-start"
                              disabled={caseBusy || pendingLifecycle !== null}
                              size="sm"
                              variant="secondary"
                              onClick={() => startCaseLifecycle(batch.batch_id, batchCase.case_id)}
                            >
                              Cancel case
                            </Button>
                          ) : null}
                          <Button
                            aria-expanded={selectedRunId === publishedRun.run_id}
                            className="justify-self-start"
                            size="sm"
                            variant="ghost"
                            onClick={() => toggleRunDetails(publishedRun.run_id)}
                          >
                            {selectedRunId === publishedRun.run_id ? "Hide run details" : "View run details"}
                          </Button>
                        </>
                      ) : (
                        <div className="text-fm-xs text-fm-muted">
                          Child run has not been published; case cancellation is unavailable before publication.
                        </div>
                      )}
                      {caseFeedback && !caseOperation ? (
                        <p
                          role={caseFeedback.kind === "status" ? "status" : "alert"}
                          className={caseFeedback.kind === "status"
                            ? "text-fm-xs text-fm-muted"
                            : "text-fm-xs text-fm-danger"}
                        >
                          {caseFeedback.message}
                        </p>
                      ) : null}
                      {publishedRun && selectedRunId === publishedRun.run_id ? (
                        <div aria-live="polite" className="grid min-w-0 gap-1 rounded-md border border-fm-subtle p-2">
                          {selectedRun.status === "loading" && !selectedRun.data ? <p>Loading run details…</p> : null}
                          {selectedRun.error ? <p role="alert">Could not load run details: {selectedRun.error.message}</p> : null}
                          {selectedRunResource ? (
                            <>
                              <div className="text-fm-xs text-fm-muted">
                                {selectedRunResource.catalog_state === "materialized"
                                  ? `Task catalog revision ${selectedRunResource.catalog_revision ?? "unknown"}`
                                  : "Task catalog has not been materialized"}
                              </div>
                              {selectedRunResource.tasks.map((task) => {
                                const isPending = task.lifecycle === "accepted" || task.lifecycle === "queued";
                                const isRetryable =
                                  (task.lifecycle === "failed" || task.lifecycle === "interrupted") &&
                                  !task.cancellation_intent;
                                const cancellationRequested =
                                  task.lifecycle === "stopping" ||
                                  (Boolean(task.cancellation_intent) && !isTerminalTaskLifecycle(task.lifecycle));
                                const needsCatalogRevision = isPending && selectedRunResource.catalog_revision == null;
                                const needsRetryRevision = isRetryable && (
                                  selectedRunResource.catalog_revision == null ||
                                  !selectedBatchCase
                                );
                                const error = cancelError?.runId === selectedRunResource.run_id &&
                                  cancelError.taskId === task.task_id
                                  ? cancelError.message
                                  : null;
                                const retryMessage = retryFeedback?.runId === selectedRunResource.run_id &&
                                  retryFeedback.taskId === task.task_id
                                  ? retryFeedback
                                  : null;
                                return (
                                  <div className="grid min-w-0 gap-1 border-b border-fm-subtle py-1 last:border-b-0" key={task.task_id}>
                                    <div>
                                      <span className="font-medium text-fm-primary">{task.lifecycle}</span>
                                      {task.readiness.state === "blocked"
                                        ? ` · blocked: ${task.readiness.reason}`
                                        : " · ready"}
                                    </div>
                                    <div className="truncate text-fm-muted" title={task.task_id}>
                                      {task.task_id}
                                    </div>
                                    {cancellationRequested ? (
                                      <p className="text-fm-muted" role="status">Cancellation requested; waiting for terminal status.</p>
                                    ) : isCancelableTaskLifecycle(task.lifecycle) ? (
                                      <>
                                        {needsCatalogRevision ? (
                                          <p className="text-fm-muted">Refresh run details before cancelling this queued task.</p>
                                        ) : null}
                                        <Button
                                          aria-label={`${isPending ? "Cancel" : "Stop"} task ${task.task_id}`}
                                          className="justify-self-start"
                                          disabled={pendingTaskId === task.task_id || needsCatalogRevision}
                                          size="sm"
                                          variant="secondary"
                                          onClick={() => void handleCancelTask(task.task_id)}
                                        >
                                          {pendingTaskId === task.task_id
                                            ? "Requesting…"
                                            : isPending ? "Cancel queued task" : "Stop active task"}
                                        </Button>
                                      </>
                                    ) : null}
                                    {error ? <p role="alert">Could not cancel task: {error}</p> : null}
                                    {isRetryable ? (
                                      <>
                                        {needsRetryRevision ? (
                                          <p className="text-fm-muted">Refresh batch cases and run details before retrying this task.</p>
                                        ) : null}
                                        <Button
                                          aria-label={`Retry task ${task.task_id}`}
                                          className="justify-self-start"
                                          disabled={pendingRetryTaskId === task.task_id || needsRetryRevision}
                                          size="sm"
                                          variant="secondary"
                                          onClick={() => void handleRetryTask(task.task_id)}
                                        >
                                          {pendingRetryTaskId === task.task_id ? "Retrying…" : "Retry task"}
                                        </Button>
                                      </>
                                    ) : null}
                                    {retryMessage ? (
                                      <p
                                        className={retryMessage.kind === "status" ? "text-fm-muted" : "text-fm-danger"}
                                        role={retryMessage.kind === "status" ? "status" : "alert"}
                                      >
                                        {retryMessage.message}
                                      </p>
                                    ) : null}
                                  </div>
                                );
                              })}
                              {selectedRunResource.tasks.length === 0 ? <p>No tasks have been materialized.</p> : null}
                            </>
                          ) : null}
                          <div className="grid min-w-0 gap-1 border-t border-fm-subtle pt-1">
                            <span className="text-fm-xs font-medium text-fm-primary">Available results</span>
                            {selectedRunResults.status === "loading" && !selectedRunResults.data ? (
                              <p>Loading result sets…</p>
                            ) : null}
                            {selectedRunResults.error ? (
                              <p role="alert">Could not load result sets: {selectedRunResults.error.message}</p>
                            ) : null}
                            {selectedRunResults.data?.items.map((item) => {
                              const isSelected = selectedBatchResult !== null &&
                                selectedBatchResult.runId === selectedRunId &&
                                selectedBatchResult.solution.solution_set_id === item.solution_set_id &&
                                selectedBatchResult.solution.revision === item.revision &&
                                selectedBatchResult.solution.manifest_digest === item.manifest_digest;
                              return (
                                <div className="flex min-w-0 items-center gap-2" key={`${item.solution_set_id}:${item.revision}`}>
                                  <span className="min-w-0 flex-1 break-words text-fm-xs text-fm-muted">
                                    {item.solution_set_id} · revision {item.revision}
                                  </span>
                                  <Button
                                    aria-current={isSelected ? "true" : undefined}
                                    className="shrink-0"
                                    size="sm"
                                    variant={isSelected ? "primary" : "secondary"}
                                    onClick={() => {
                                      if (selectedRunId) {
                                        setSelectedBatchResult({ runId: selectedRunId, solution: item });
                                      }
                                    }}
                                  >
                                    Browse results
                                  </Button>
                                </div>
                              );
                            })}
                            {selectedRunResults.data?.items.length === 0 ? <p>No saved results for this run yet.</p> : null}
                            {selectedRunResults.data?.next_cursor ? (
                              <Button
                                className="justify-self-start"
                                size="sm"
                                variant="secondary"
                                onClick={() => {
                                  setSelectedBatchResult(null);
                                  setResultCursor(selectedRunResults.data?.next_cursor ?? null);
                                }}
                              >
                                Next result sets
                              </Button>
                            ) : null}
                          </div>
                          {selectedBatchResult && selectedBatchResult.runId === selectedRunId && selectedRunId ? (
                            <BatchCaseResults
                              key={`${projectId}:${selectedBatchResult.runId}:${selectedBatchResult.solution.solution_set_id}:${selectedBatchResult.solution.revision}:${selectedBatchResult.solution.manifest_digest}`}
                              projectId={projectId}
                              runId={selectedRunId}
                              solution={selectedBatchResult.solution}
                              onClose={() => setSelectedBatchResult(null)}
                            />
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {cases.data?.cases.length === 0 ? <p>No cases were returned for this page.</p> : null}
                {cases.data?.next_cursor ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setSelectedRunId(null);
                      setResultCursor(null);
                    setSelectedBatchResult(null);
                      setCaseCursor(cases.data?.next_cursor ?? null);
                    }}
                  >
                    Next cases
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}

      {batches.data?.next_cursor ? (
        <Button size="sm" variant="secondary" onClick={loadNextBatchPage}>
          Next batches
        </Button>
      ) : null}
    </InspectorGroup>
  );
}

function expansionStateLabel(
  state: string,
): string {
  if (state === "pending") return "Pending expansion";
  if (state === "complete") return "Expanded";
  if (state === "stopped") return "Stopped after a case failure";
  if (state === "paused") return "Paused";
  if (state === "cancelled") return "Admission cancelled";
  return "Expanding";
}

function batchAdmissionActions(
  state: ProjectBatchSummaryResource["expansion_state"],
): readonly ProjectBatchCommandAction[] {
  if (state === "pending" || state === "expanding") return ["pause_admission"];
  if (state === "paused") return ["resume_admission"];
  return [];
}

function planBatchTaskCancellations(
  cases: readonly ProjectBatchCaseSummaryResource[],
  action: BatchLifecycleAction,
  reason: string,
): BatchTaskCancellationPlan {
  const targets: BatchTaskCancellationTarget[] = [];
  let alreadyRequestedCount = 0;
  let activeTasksLeftRunning = 0;
  let notAdmittedCaseCount = 0;
  let pendingMaterializationCaseCount = 0;

  for (const batchCase of cases) {
    const publishedRun = batchCase.published_run ?? null;
    if (batchCase.state === "pending_expansion") {
      notAdmittedCaseCount += 1;
      continue;
    }
    if (batchCase.state === "pending_materialization") {
      pendingMaterializationCaseCount += 1;
      continue;
    }
    if (!publishedRun || publishedRun.catalog_state !== "materialized") continue;

    for (const task of publishedRun.tasks) {
      if (task.cancellation_requested || task.lifecycle === "stopping") {
        alreadyRequestedCount += 1;
        continue;
      }
      if (task.lifecycle === "accepted" || task.lifecycle === "queued") {
        if (publishedRun.catalog_revision == null) {
          throw new Error(`Task catalog revision is missing for queued run ${publishedRun.run_id}.`);
        }
        const cancellationId = globalThis.crypto?.randomUUID?.();
        if (!cancellationId) {
          throw new Error("This browser cannot create secure task cancellation IDs.");
        }
        targets.push({
          runId: publishedRun.run_id,
          taskId: task.task_id,
          kind: "pending",
          request: {
            cancellation_id: cancellationId,
            expected_catalog_revision: publishedRun.catalog_revision,
            reason,
          },
        });
        continue;
      }
      if (task.lifecycle === "preparing" || task.lifecycle === "running") {
        if (action === "stop_active_and_cancel_pending") {
          targets.push({
            runId: publishedRun.run_id,
            taskId: task.task_id,
            kind: "active",
            request: { reason },
          });
        } else {
          activeTasksLeftRunning += 1;
        }
      }
    }
  }

  return {
    targets,
    alreadyRequestedCount,
    activeTasksLeftRunning,
    notAdmittedCaseCount,
    pendingMaterializationCaseCount,
  };
}

function advanceBatchTaskCancellationPlan(
  plan: BatchTaskCancellationPlan,
  completedTargetIndex: number,
  catalogRevision: number,
): BatchTaskCancellationPlan {
  const completedTarget = plan.targets[completedTargetIndex];
  if (!completedTarget) throw new Error("Completed cancellation target disappeared.");
  if (!Number.isSafeInteger(catalogRevision) || catalogRevision < 1) {
    throw new Error("Cancellation response did not include a valid task catalog revision.");
  }
  return {
    ...plan,
    targets: plan.targets.map((target, index) => {
      if (
        index <= completedTargetIndex ||
        target.runId !== completedTarget.runId ||
        target.kind !== "pending"
      ) {
        return target;
      }
      return {
        ...target,
        request: { ...target.request, expected_catalog_revision: catalogRevision },
      };
    }),
  };
}

function cancellationTargetsObserved(
  cases: readonly ProjectBatchCaseSummaryResource[],
  targets: readonly BatchTaskCancellationTarget[],
): boolean {
  return targets.every((target) => {
    const publishedRun = cases.find((batchCase) =>
      batchCase.published_run?.run_id === target.runId)?.published_run;
    const task = publishedRun?.tasks.find((candidate) => candidate.task_id === target.taskId);
    return Boolean(task && (
      task.cancellation_requested ||
      task.lifecycle === "stopping" ||
      isTerminalTaskLifecycle(task.lifecycle)
    ));
  });
}

function caseLifecycleKey(batchId: string, caseId: string): string {
  return JSON.stringify([batchId, caseId]);
}

function caseLifecycleCompletionMessage(
  caseId: string,
  plan: BatchTaskCancellationPlan,
): string {
  const pendingCount = plan.targets.filter((target) => target.kind === "pending").length;
  const activeCount = plan.targets.filter((target) => target.kind === "active").length;
  if (pendingCount === 0 && activeCount === 0 && plan.alreadyRequestedCount === 0) {
    return `No queued or active tasks remain for case ${caseId}; existing results are preserved.`;
  }
  const parts = [
    `Case ${caseId}: cancellation requested for ${pendingCount} pending and ${activeCount} active task(s).`,
  ];
  if (plan.alreadyRequestedCount > 0) {
    parts.push(`${plan.alreadyRequestedCount} task(s) already had a cancellation request.`);
  }
  parts.push("Wait for terminal task receipts and resource release before treating the case as stopped.");
  return parts.join(" ");
}

function batchLifecycleActionLabel(action: BatchLifecycleAction): string {
  return action === "cancel_pending"
    ? "Cancel pending cases"
    : "Stop active and cancel pending cases";
}

function batchLifecycleCompletionMessage(operation: PendingBatchLifecycle): string {
  const plan = operation.plan;
  if (!plan) return "No cancellation plan was available.";
  const pendingCount = plan.targets.filter((target) => target.kind === "pending").length;
  const activeCount = plan.targets.filter((target) => target.kind === "active").length;
  const admissionStatus = operation.admissionRequest
    ? "Admission stopped."
    : "No further cases can be admitted.";
  const parts = [
    `${admissionStatus} Cancellation requested for ${pendingCount} pending and ${activeCount} active task(s).`,
  ];
  if (plan.activeTasksLeftRunning > 0) {
    parts.push(`${plan.activeTasksLeftRunning} active task(s) were left running.`);
  }
  if (plan.alreadyRequestedCount > 0) {
    parts.push(`${plan.alreadyRequestedCount} task(s) already had a cancellation request.`);
  }
  if (plan.notAdmittedCaseCount > 0) {
    parts.push(`${plan.notAdmittedCaseCount} unpublished case(s) will not be admitted.`);
  }
  if (plan.pendingMaterializationCaseCount > 0) {
    parts.push(`${plan.pendingMaterializationCaseCount} published case(s) still await task materialization; refresh and review their status.`);
  }
  parts.push("Wait for terminal task receipts and resource release before treating stopped work as complete.");
  return parts.join(" ");
}

function isDefinitiveHttpRejection(
  error: unknown,
): error is Error & { readonly status: number } {
  if (!(error instanceof Error) || !("status" in error)) return false;
  const status = (error as Error & { readonly status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500;
}

function batchCommandActionLabel(action: ProjectBatchCommandAction): string {
  if (action === "pause_admission") return "Pause admission";
  if (action === "resume_admission") return "Resume admission";
  if (action === "cancel_admission") return "Cancel admission";
  return "Retry task";
}

function isDefinitiveBatchCommandRejection(
  error: unknown,
): error is Error & { readonly status: number } {
  return error instanceof Error &&
    error.name === "ProjectBatchCommandRejectedError" &&
    "status" in error &&
    typeof error.status === "number";
}

function failurePolicyLabel(policy: "continue_independent" | "stop_admission"): string {
  return policy === "stop_admission"
    ? "stop new cases after a failure"
    : "continue independent cases";
}

function isCancelableTaskLifecycle(lifecycle: string): boolean {
  return lifecycle === "accepted" ||
    lifecycle === "queued" ||
    lifecycle === "preparing" ||
    lifecycle === "running";
}

function isTerminalTaskLifecycle(lifecycle: string): boolean {
  return lifecycle === "succeeded" ||
    lifecycle === "failed" ||
    lifecycle === "cancelled" ||
    lifecycle === "interrupted";
}

function caseStateLabel(state: ProjectBatchCaseSummaryResource["state"]): string {
  if (state === "pending_expansion") return "Pending expansion";
  if (state === "pending_materialization") return "Child run published; task materialization pending";
  return "Tasks materialized";
}

function formatParameterTuple(
  tuple: Record<string, unknown>,
  axes: readonly ProjectBatchAxisSummaryResource[],
): string {
  const units = new Map(axes.map((axis) => [axis.name, axis.canonical_unit]));
  const entries = Object.entries(tuple);
  return entries.length > 0
    ? entries.map(([name, value]) => `${name}=${String(value)} ${units.get(name) ?? ""}`.trimEnd()).join(" · ")
    : "No parameter values";
}
