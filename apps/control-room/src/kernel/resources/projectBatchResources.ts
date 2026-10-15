"use client";

import { useCallback } from "react";

import type {
  ProjectBatchCommandRequest,
  ProjectBatchCommandResource,
  ProjectBatchCaseSummaryResource,
  ProjectBatchCasesQuery,
  ProjectBatchCasesResource,
  ProjectBatchListQuery,
  ProjectBatchListResource,
  ProjectBatchSubmitRequest,
  ProjectBatchSubmitResource,
} from "../api/apiTypes";
import { ControlRoomApiError } from "../api/ControlRoomApi";
import { useKernel } from "../KernelContext";
import { useResource } from "./useResource";

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
type ProjectBatchCaseTaskLifecycle = NonNullable<
  ProjectBatchCaseSummaryResource["published_run"]
>["tasks"][number]["lifecycle"];

const PROJECT_BATCH_CASE_TASK_LIFECYCLES = new Set<ProjectBatchCaseTaskLifecycle>([
  "accepted",
  "queued",
  "preparing",
  "running",
  "stopping",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

export function projectBatchesResourcePrefix(projectId: string): string {
  return `project-batches:${encodeURIComponent(projectId)}:`;
}

export function projectBatchesResourceKey(
  projectId: string,
  query: ProjectBatchListQuery = {},
): string {
  return `${projectBatchesResourcePrefix(projectId)}limit:${resolvePageLimit(query.limit)}:cursor:${encodeURIComponent(query.cursor ?? "first")}`;
}

export function projectBatchCasesResourceKey(
  projectId: string,
  batchId: string,
  query: ProjectBatchCasesQuery = {},
): string {
  return `${projectBatchCasesResourcePrefix(projectId, batchId)}limit:${resolvePageLimit(query.limit)}:cursor:${encodeURIComponent(query.cursor ?? "first")}`;
}

export function projectBatchCasesResourcePrefix(projectId: string, batchId: string): string {
  return `project-batch-cases:${encodeURIComponent(projectId)}:${encodeURIComponent(batchId)}:`;
}

export function validateProjectBatchesEnvelope(
  data: ProjectBatchListResource,
  projectId: string,
  query: ProjectBatchListQuery = {},
): ProjectBatchListResource {
  const cursor = query.cursor ?? null;
  const limit = resolvePageLimit(query.limit);
  if (
    data.project_id !== projectId ||
    !Array.isArray(data.batches) ||
    data.batches.length > limit
  ) {
    throw new Error("Batch list does not match the requested project page.");
  }

  const ids = new Set<string>();
  for (const batch of data.batches) {
    if (
      !isNonEmptyString(batch.batch_id) ||
      ids.has(batch.batch_id) ||
      !isNonEmptyString(batch.accepted_at) ||
      !Number.isFinite(Date.parse(batch.accepted_at)) ||
      !/^[a-f0-9]{64}$/i.test(batch.manifest_sha256) ||
      !isPositiveSafeInteger(batch.case_count) ||
      !isNonNegativeSafeInteger(batch.published_case_count) ||
      !isNonNegativeSafeInteger(batch.command_revision) ||
      batch.published_case_count > batch.case_count ||
      !isExpansionState(batch.expansion_state) ||
      !isFailurePolicy(batch.failure_policy) ||
      (batch.max_parallel_cases != null && !isPositiveSafeInteger(batch.max_parallel_cases))
    ) {
      throw new Error("Batch list contains a malformed or duplicate summary.");
    }
    if (
      (batch.expansion_state === "pending" && batch.published_case_count !== 0) ||
      (batch.expansion_state === "complete" && batch.published_case_count !== batch.case_count) ||
      (batch.expansion_state === "stopped" && (
        batch.failure_policy !== "stop_admission" ||
        batch.published_case_count === 0 ||
        batch.published_case_count === batch.case_count
      )) ||
      (batch.expansion_state === "paused" && batch.published_case_count === batch.case_count) ||
      (batch.expansion_state === "cancelled" && batch.published_case_count === batch.case_count)
    ) {
      throw new Error("Batch expansion state does not match its published prefix.");
    }
    ids.add(batch.batch_id);
  }

  validatePageCursor(data.next_cursor, cursor, data.batches.at(-1)?.batch_id);
  return data;
}

export function validateProjectBatchCasesEnvelope(
  data: ProjectBatchCasesResource,
  batchId: string,
  query: ProjectBatchCasesQuery = {},
): ProjectBatchCasesResource {
  const cursor = query.cursor ?? null;
  const limit = resolvePageLimit(query.limit);
  if (
    data.batch_id !== batchId ||
    !Array.isArray(data.axes) ||
    data.axes.length === 0 ||
    !Array.isArray(data.cases) ||
    data.cases.length > limit
  ) {
    throw new Error("Batch cases do not match the requested batch page.");
  }

  const axisNames = new Set<string>();
  for (const axis of data.axes) {
    if (
      !isNonEmptyString(axis.name) ||
      axisNames.has(axis.name) ||
      !isNonEmptyString(axis.canonical_unit)
    ) {
      throw new Error("Batch case page contains malformed or duplicate axis metadata.");
    }
    axisNames.add(axis.name);
  }

  const ids = new Set<string>();
  for (const item of data.cases) {
    if (
      !isNonEmptyString(item.case_id) ||
      ids.has(item.case_id) ||
      !isNonEmptyString(item.planned_run_id) ||
      !isRecord(item.parameter_tuple) ||
      !matchesParameterTuple(item.parameter_tuple, axisNames) ||
      !isBatchCaseState(item.state) ||
      !matchesPublishedRun(item, item.state)
    ) {
      throw new Error("Batch case page contains a malformed or duplicate identity.");
    }
    ids.add(item.case_id);
  }

  validatePageCursor(data.next_cursor, cursor, data.cases.at(-1)?.case_id);
  return data;
}

export async function loadAllProjectBatchCases(
  batchId: string,
  loadPage: (query: ProjectBatchCasesQuery) => Promise<ProjectBatchCasesResource>,
): Promise<ProjectBatchCaseSummaryResource[]> {
  const cases: ProjectBatchCaseSummaryResource[] = [];
  const caseIds = new Set<string>();
  const requestedCursors = new Set<string | null>();
  let cursor: string | null = null;

  while (true) {
    if (requestedCursors.has(cursor)) {
      throw new Error("Batch case pagination repeated a cursor.");
    }
    requestedCursors.add(cursor);
    const query = { cursor, limit: MAX_PAGE_LIMIT };
    const page = validateProjectBatchCasesEnvelope(
      await loadPage(query),
      batchId,
      query,
    );
    for (const item of page.cases) {
      if (caseIds.has(item.case_id)) {
        throw new Error("Batch case pagination returned a duplicate case.");
      }
      caseIds.add(item.case_id);
      cases.push(item);
    }

    const nextCursor = page.next_cursor ?? null;
    if (nextCursor === null) return cases;
    if (requestedCursors.has(nextCursor)) {
      throw new Error("Batch case pagination did not advance.");
    }
    cursor = nextCursor;
  }
}

export function useProjectBatchesResource(
  projectId: string,
  query: ProjectBatchListQuery = {},
) {
  const { api } = useKernel();
  const cursor = query.cursor ?? null;
  const limit = resolvePageLimit(query.limit);
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.persistence.projects.listBatches(
        projectId,
        { cursor, limit },
        { signal },
      ).then((data) => validateProjectBatchesEnvelope(data, projectId, { cursor, limit })),
    [api, cursor, limit, projectId],
  );

  return useResource<ProjectBatchListResource>({
    abortStaleInflight: true,
    load,
    resourceKey: projectBatchesResourceKey(projectId, { cursor, limit }),
  });
}

export function useProjectBatchCasesResource(
  projectId: string,
  batchId: string | null,
  query: ProjectBatchCasesQuery = {},
) {
  const { api } = useKernel();
  const cursor = query.cursor ?? null;
  const limit = resolvePageLimit(query.limit);
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => {
      if (!batchId) return Promise.reject(new Error("A batch must be selected."));
      return api.persistence.projects.listBatchCases(
        projectId,
        batchId,
        { cursor, limit },
        { signal },
      ).then((data) => validateProjectBatchCasesEnvelope(data, batchId, { cursor, limit }));
    },
    [api, batchId, cursor, limit, projectId],
  );

  return useResource<ProjectBatchCasesResource>({
    abortStaleInflight: true,
    enabled: batchId !== null,
    load,
    resourceKey: batchId
      ? projectBatchCasesResourceKey(projectId, batchId, { cursor, limit })
      : `project-batch-cases:${encodeURIComponent(projectId)}:none`,
  });
}

export function useLoadAllProjectBatchCases(projectId: string) {
  const { api } = useKernel();
  return useCallback(
    (batchId: string) => loadAllProjectBatchCases(
      batchId,
      (query) => api.persistence.projects.listBatchCases(projectId, batchId, query),
    ),
    [api, projectId],
  );
}

let localInvalidationSequence = 0;

function nextLocalInvalidationRevision(): string {
  localInvalidationSequence += 1;
  return `project-batch-local:${Date.now()}:${localInvalidationSequence}`;
}

export function useSubmitProjectBatch(projectId: string) {
  const { api, resources } = useKernel();
  return useCallback(
    async (request: ProjectBatchSubmitRequest): Promise<ProjectBatchSubmitResource> => {
      const accepted = await api.persistence.projects.submitBatch(projectId, request);
      resources.invalidatePrefix(
        projectBatchesResourcePrefix(projectId),
        nextLocalInvalidationRevision(),
      );
      return accepted;
    },
    [api, projectId, resources],
  );
}

export class ProjectBatchCommandRejectedError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ProjectBatchCommandRejectedError";
  }
}

export function useCommandProjectBatch(projectId: string) {
  const { api, resources } = useKernel();
  return useCallback(
    async (
      batchId: string,
      request: ProjectBatchCommandRequest,
    ): Promise<ProjectBatchCommandResource> => {
      let accepted: ProjectBatchCommandResource;
      try {
        accepted = await api.persistence.projects.commandBatch(projectId, batchId, request);
      } catch (error) {
        if (error instanceof ControlRoomApiError && error.status >= 400 && error.status < 500) {
          throw new ProjectBatchCommandRejectedError(error.message, error.status);
        }
        throw error;
      }
      const revision = nextLocalInvalidationRevision();
      resources.invalidatePrefix(projectBatchesResourcePrefix(projectId), revision);
      resources.invalidatePrefix(projectBatchCasesResourcePrefix(projectId, batchId), revision);
      return accepted;
    },
    [api, projectId, resources],
  );
}

function resolvePageLimit(limit: number | null | undefined): number {
  const resolved = limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAX_PAGE_LIMIT) {
    throw new Error(`Project batch page limit must be from 1 to ${MAX_PAGE_LIMIT}.`);
  }
  return resolved;
}

function validatePageCursor(
  nextCursor: string | null | undefined,
  requestedCursor: string | null,
  lastItemId: string | undefined,
): void {
  if (nextCursor == null) return;
  if (
    !isNonEmptyString(nextCursor) ||
    nextCursor === requestedCursor ||
    nextCursor !== lastItemId
  ) {
    throw new Error("Project batch page cursor did not advance from its last item.");
  }
}

function isExpansionState(
  value: unknown,
): boolean {
  return value === "pending" ||
    value === "expanding" ||
    value === "complete" ||
    value === "stopped" ||
    value === "paused" ||
    value === "cancelled";
}

function isFailurePolicy(
  value: unknown,
): value is "continue_independent" | "stop_admission" {
  return value === "continue_independent" || value === "stop_admission";
}

function isBatchCaseState(
  value: unknown,
): value is "pending_expansion" | "pending_materialization" | "materialized" {
  return value === "pending_expansion" ||
    value === "pending_materialization" ||
    value === "materialized";
}

function matchesPublishedRun(
  item: ProjectBatchCaseSummaryResource,
  state: ProjectBatchCaseSummaryResource["state"],
): boolean {
  const publishedRun = item.published_run ?? null;
  if (state === "pending_expansion") return publishedRun === null;
  if (
    publishedRun === null ||
    publishedRun.run_id !== item.planned_run_id ||
    !Array.isArray(publishedRun.tasks)
  ) {
    return false;
  }

  const taskIds = new Set<string>();
  for (const task of publishedRun.tasks) {
    if (
      !isRecord(task) ||
      !isNonEmptyString(task.task_id) ||
      taskIds.has(task.task_id) ||
      !isProjectBatchCaseTaskLifecycle(task.lifecycle) ||
      typeof task.cancellation_requested !== "boolean"
    ) {
      return false;
    }
    taskIds.add(task.task_id);
  }

  if (state === "pending_materialization") {
    return publishedRun.catalog_state === "pending_materialization" &&
      publishedRun.catalog_revision == null &&
      publishedRun.tasks.length === 0;
  }

  return publishedRun.catalog_state === "materialized" &&
    isPositiveSafeInteger(publishedRun.catalog_revision);
}

function isProjectBatchCaseTaskLifecycle(
  value: unknown,
): value is ProjectBatchCaseTaskLifecycle {
  return typeof value === "string" && PROJECT_BATCH_CASE_TASK_LIFECYCLES.has(
    value as ProjectBatchCaseTaskLifecycle,
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesParameterTuple(
  tuple: Record<string, unknown>,
  axisNames: ReadonlySet<string>,
): boolean {
  const entries = Object.entries(tuple);
  return entries.length === axisNames.size && entries.every(
    ([name, value]) => axisNames.has(name) && typeof value === "number" && Number.isFinite(value),
  );
}
