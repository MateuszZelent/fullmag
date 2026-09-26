"use client";

import { useState } from "react";

import { useProjectDocumentSnapshot } from "@/kernel/persistence/ProjectDocumentStatus";
import {
  useCancelProjectRunTask,
  useProjectRunResource,
  useProjectRunsResource,
} from "@/kernel/resources/projectRunResources";
import { Button } from "@/shared/ui/Button";

import { InspectorGroup } from "../primitives/InspectorGroup";

export function ProjectRunsSection() {
  const project = useProjectDocumentSnapshot();
  if (project.state !== "ready") return null;
  return <ProjectRunsPage key={project.resource.project_id} projectId={project.resource.project_id} />;
}

function ProjectRunsPage({ projectId }: { projectId: string }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<{
    message: string;
    taskId: string;
  } | null>(null);
  const runs = useProjectRunsResource(projectId, cursor);
  const selectedRun = useProjectRunResource(projectId, selectedRunId);
  const cancelTask = useCancelProjectRunTask(projectId, selectedRunId, cursor);

  const handleCancelTask = async (taskId: string) => {
    setPendingTaskId(taskId);
    setCancelError(null);
    try {
      await cancelTask(taskId, "Cancelled by operator from Control Room");
    } catch (error) {
      setCancelError({
        message: error instanceof Error ? error.message : "Cancellation failed.",
        taskId,
      });
    } finally {
      setPendingTaskId((current) => (current === taskId ? null : current));
    }
  };

  return (
    <InspectorGroup
      title="Saved project runs"
      badge={runs.data ? `${runs.data.runs.length}` : undefined}
    >
      <Button
        aria-label="Refresh saved project runs"
        className="justify-self-start"
        size="sm"
        variant="ghost"
        onClick={runs.refetch}
      >
        Refresh
      </Button>
      {runs.status === "loading" && !runs.data ? <p>Loading saved runs…</p> : null}
      {runs.error ? <p role="alert">Could not load saved runs: {runs.error.message}</p> : null}
      {runs.data?.runs.length === 0 ? <p>No submitted runs in this project.</p> : null}
      {runs.data?.runs.map((run) => (
        <div className="min-w-0 border-b border-fm-subtle py-2 last:border-b-0" key={run.run_id}>
          <Button
            aria-expanded={selectedRunId === run.run_id}
            className="h-auto max-w-full justify-start px-0 py-1 text-left"
            size="sm"
            title={run.run_id}
            variant="ghost"
            onClick={() =>
              setSelectedRunId((current) =>
                current === run.run_id ? null : run.run_id,
              )
            }
          >
            <span className="truncate">{run.run_id}</span>
          </Button>
          <div className="text-fm-xs text-fm-muted">
            {run.catalog_state === "materialized"
              ? `${run.task_count} tasks`
              : "Pending materialization"}
            {` · ${run.requested_execution.backend} / ${run.requested_execution.device}`}
          </div>
        </div>
      ))}
      {selectedRunId ? (
        <div
          aria-live="polite"
          className="grid min-w-0 gap-2 rounded-md border border-fm-subtle p-2"
        >
          {selectedRun.status === "loading" && !selectedRun.data ? <p>Loading run details…</p> : null}
          {selectedRun.error ? <p role="alert">Could not load run details: {selectedRun.error.message}</p> : null}
          {selectedRun.data ? (
            <>
              <div className="text-fm-xs text-fm-muted">
                {selectedRun.data.catalog_state === "materialized"
                  ? `Task catalog revision ${selectedRun.data.catalog_revision ?? "unknown"}`
                  : "Task catalog has not been materialized"}
              </div>
              <div className="grid min-w-0 gap-1">
                {selectedRun.data.tasks.map((task) => (
                  <div className="grid min-w-0 gap-1 text-fm-xs" key={task.task_id}>
                    <div>
                      <span className="font-medium text-fm-primary">{task.lifecycle}</span>
                      {task.readiness.state === "blocked"
                        ? ` · blocked: ${task.readiness.reason}`
                        : " · ready"}
                    </div>
                    <div className="truncate text-fm-muted" title={task.task_id}>
                      {task.task_id}
                    </div>
                    {task.lifecycle === "running" ? (
                      <Button
                        aria-label={`Cancel task ${task.task_id}`}
                        className="justify-self-start"
                        disabled={pendingTaskId === task.task_id}
                        size="sm"
                        variant="secondary"
                        onClick={() => void handleCancelTask(task.task_id)}
                      >
                        {pendingTaskId === task.task_id ? "Cancelling…" : "Cancel"}
                      </Button>
                    ) : null}
                    {task.lifecycle === "stopping" ? (
                      <div className="text-fm-muted">Cancellation requested</div>
                    ) : null}
                    {cancelError?.taskId === task.task_id ? (
                      <p role="alert">Could not cancel task: {cancelError.message}</p>
                    ) : null}
                  </div>
                ))}
                {selectedRun.data.tasks.length === 0 ? <p>No tasks have been materialized.</p> : null}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      {runs.data?.next_cursor ? (
        <Button size="sm" variant="secondary" onClick={() => setCursor(runs.data?.next_cursor ?? null)}>
          Next runs
        </Button>
      ) : null}
    </InspectorGroup>
  );
}
