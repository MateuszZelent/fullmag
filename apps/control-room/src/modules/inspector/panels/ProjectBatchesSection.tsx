"use client";

import { useState } from "react";

import type {
  ProjectBatchAxisSummaryResource,
  ProjectBatchCaseSummaryResource,
} from "@/kernel/api/apiTypes";
import { useProjectDocumentSnapshot } from "@/kernel/persistence/ProjectDocumentStatus";
import {
  useProjectBatchCasesResource,
  useProjectBatchesResource,
} from "@/kernel/resources/projectBatchResources";
import { useProjectRunResource } from "@/kernel/resources/projectRunResources";
import { useSolutionSetDiscoveryResource } from "@/kernel/resources/solutionSetResources";
import { Button } from "@/shared/ui/Button";

import { InspectorGroup } from "../primitives/InspectorGroup";

const BATCH_PAGE_LIMIT = 20;
const CASE_PAGE_LIMIT = 20;

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
  const batches = useProjectBatchesResource(projectId, {
    cursor: batchCursor,
    limit: BATCH_PAGE_LIMIT,
  });
  const cases = useProjectBatchCasesResource(projectId, selectedBatchId, {
    cursor: caseCursor,
    limit: CASE_PAGE_LIMIT,
  });
  const selectedRun = useProjectRunResource(projectId, selectedRunId);
  const selectedRunResults = useSolutionSetDiscoveryResource(projectId, selectedRunId, {
    query: { cursor: resultCursor, limit: 25 },
  });

  const selectBatch = (batchId: string) => {
    setCaseCursor(null);
    setResultCursor(null);
    setSelectedRunId(null);
    setSelectedBatchId((current) => current === batchId ? null : batchId);
  };

  const toggleRunDetails = (runId: string) => {
    setResultCursor(null);
    setSelectedRunId((current) => current === runId ? null : runId);
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
            {selected ? (
              <div aria-live="polite" className="mt-2 grid min-w-0 gap-2 rounded-md border border-fm-subtle p-2">
                {cases.status === "loading" && !cases.data ? <p>Loading batch cases…</p> : null}
                {cases.error ? <p role="alert">Could not load batch cases: {cases.error.message}</p> : null}
                {cases.data?.cases.map((batchCase) => {
                  const publishedRun = batchCase.published_run ?? null;
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
                          {publishedRun.tasks.map((task) => (
                            <div className="truncate text-fm-xs text-fm-muted" key={task.task_id} title={task.task_id}>
                              {task.lifecycle} · {task.task_id}
                            </div>
                          ))}
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
                        <div className="text-fm-xs text-fm-muted">Child run has not been published.</div>
                      )}
                      {publishedRun && selectedRunId === publishedRun.run_id ? (
                        <div aria-live="polite" className="grid min-w-0 gap-1 rounded-md border border-fm-subtle p-2">
                          {selectedRun.status === "loading" && !selectedRun.data ? <p>Loading run details…</p> : null}
                          {selectedRun.error ? <p role="alert">Could not load run details: {selectedRun.error.message}</p> : null}
                          {selectedRun.data ? (
                            <>
                              <div className="text-fm-xs text-fm-muted">
                                {selectedRun.data.catalog_state === "materialized"
                                  ? `Task catalog revision ${selectedRun.data.catalog_revision ?? "unknown"}`
                                  : "Task catalog has not been materialized"}
                              </div>
                              {selectedRun.data.tasks.map((task) => (
                                <div className="min-w-0 text-fm-xs" key={task.task_id}>
                                  <span className="font-medium text-fm-primary">{task.lifecycle}</span>
                                  {task.readiness.state === "blocked"
                                    ? ` · blocked: ${task.readiness.reason}`
                                    : " · ready"}
                                  <div className="truncate text-fm-muted" title={task.task_id}>
                                    {task.task_id}
                                  </div>
                                </div>
                              ))}
                              {selectedRun.data.tasks.length === 0 ? <p>No tasks have been materialized.</p> : null}
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
                            {selectedRunResults.data?.items.map((item) => (
                              <div className="break-words text-fm-xs text-fm-muted" key={`${item.solution_set_id}:${item.revision}`}>
                                {item.solution_set_id} · revision {item.revision}
                              </div>
                            ))}
                            {selectedRunResults.data?.items.length === 0 ? <p>No saved results for this run yet.</p> : null}
                            {selectedRunResults.data?.next_cursor ? (
                              <Button
                                className="justify-self-start"
                                size="sm"
                                variant="secondary"
                                onClick={() => setResultCursor(selectedRunResults.data?.next_cursor ?? null)}
                              >
                                Next result sets
                              </Button>
                            ) : null}
                          </div>
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
  state: "pending" | "expanding" | "complete" | "stopped",
): string {
  if (state === "pending") return "Pending expansion";
  if (state === "complete") return "Expanded";
  if (state === "stopped") return "Stopped after a case failure";
  return "Expanding";
}

function failurePolicyLabel(policy: "continue_independent" | "stop_admission"): string {
  return policy === "stop_admission"
    ? "stop new cases after a failure"
    : "continue independent cases";
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
