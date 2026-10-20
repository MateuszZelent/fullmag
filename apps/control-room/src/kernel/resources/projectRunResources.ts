"use client";

import { useCallback, useRef } from "react";

import type {
  ProjectRunListResource,
  ProjectRunMaterializationResource,
  ProjectRunResource,
  ProjectRunTaskCancellationRequest,
  ProjectRunTaskRetryRequest,
} from "../api/apiTypes";
import { assertSolutionSetRunId, ControlRoomApiError } from "../api/ControlRoomApi";
import { useKernel } from "../KernelContext";
import { useResource } from "./useResource";

export function projectRunsResourceKey(
  projectId: string,
  cursor: string | null,
) {
  return `project-runs:${encodeURIComponent(projectId)}:${encodeURIComponent(cursor ?? "first")}`;
}

export function projectRunResourceKey(projectId: string, runId: string) {
  return `project-run:${encodeURIComponent(projectId)}:${encodeURIComponent(runId)}`;
}

export function validateProjectRunsEnvelope(
  data: ProjectRunListResource,
  projectId: string,
  cursor: string | null = null,
): ProjectRunListResource {
  if (data.project_id !== projectId || data.runs.length > 50) {
    throw new Error("Saved runs do not belong to the requested project page.");
  }
  const ids = new Set<string>();
  if (data.next_cursor != null) {
    assertSolutionSetRunId(data.next_cursor);
    if (data.next_cursor === cursor) throw new Error("Saved run page cursor did not advance.");
  }
  for (const run of data.runs) {
    assertSolutionSetRunId(run.run_id);
    if (ids.has(run.run_id)) throw new Error("Saved run page contains duplicate identities.");
    ids.add(run.run_id);
  }
  return data;
}

export function validateProjectRunEnvelope(
  data: ProjectRunResource,
  projectId: string,
  runId: string,
): ProjectRunResource {
  if (data.project_id !== projectId || data.run_id !== runId) {
    throw new Error("Saved run does not match the requested project and run.");
  }
  return data;
}

export function useProjectRunsResource(projectId: string, cursor: string | null) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.persistence.projects.listRuns(
        projectId,
        { limit: 50, cursor },
        { signal },
      ).then((data) => validateProjectRunsEnvelope(data, projectId, cursor)),
    [api, cursor, projectId],
  );

  return useResource<ProjectRunListResource>({
    abortStaleInflight: true,
    load,
    resourceKey: projectRunsResourceKey(projectId, cursor),
  });
}

export function useProjectRunResource(projectId: string, runId: string | null) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => {
      if (!runId) return Promise.reject(new Error("A run must be selected."));
      return api.persistence.projects.getRun(projectId, runId, { signal })
        .then((data) => validateProjectRunEnvelope(data, projectId, runId));
    },
    [api, projectId, runId],
  );

  return useResource({
    abortStaleInflight: true,
    enabled: runId !== null,
    load,
    resourceKey: runId
      ? projectRunResourceKey(projectId, runId)
      : `project-run:${encodeURIComponent(projectId)}:none`,
  });
}

export function useMaterializeProjectRun(projectId: string) {
  const { api, resources } = useKernel();

  return useCallback(
    async (runId: string): Promise<ProjectRunMaterializationResource> => {
      const materialization = await api.persistence.projects.materializeRun(projectId, runId);
      const revision = materialization.catalog_revision;
      resources.invalidate(projectRunResourceKey(projectId, runId), revision);
      resources.invalidatePrefix(`project-runs:${encodeURIComponent(projectId)}:`, revision);
      resources.invalidatePrefix(`project-batch-cases:${encodeURIComponent(projectId)}:`, revision);
      return materialization;
    },
    [api, projectId, resources],
  );
}

export function useCancelProjectRunTask(
  projectId: string,
  runId: string | null,
  cursor: string | null,
) {
  const { api, resources } = useKernel();
  const requests = useRef(new Map<string, {
    cancellation_id: string;
    expected_catalog_revision: number;
    reason: string;
  }>());

  return useCallback(
    async (taskId: string, reason: string, expectedCatalogRevision?: number) => {
      if (!runId) throw new Error("A run must be selected.");
      let request: ProjectRunTaskCancellationRequest = { reason };
      if (expectedCatalogRevision !== undefined) {
        if (!Number.isSafeInteger(expectedCatalogRevision) || expectedCatalogRevision < 1) {
          throw new Error("A current task catalog revision is required.");
        }
        const key = `${projectId}:${runId}:${taskId}`;
        const previous = requests.current.get(key);
        if (previous && previous.reason !== reason) {
          throw new Error("Retry the original cancellation request before changing its reason.");
        }
        const intent = previous ?? {
          cancellation_id: crypto.randomUUID(),
          expected_catalog_revision: expectedCatalogRevision,
          reason,
        };
        requests.current.set(key, intent);
        request = intent;
      }
      let cancellation;
      try {
        cancellation = await api.persistence.projects.cancelRunTask(
          projectId, runId, taskId, request,
        );
      } catch (error) {
        if (error instanceof ControlRoomApiError && error.code === "run_task_cancel_revision_conflict") {
          // This response proves the new request was rejected before publication.
          requests.current.delete(`${projectId}:${runId}:${taskId}`);
        }
        // A transport failure does not prove that the durable request was rejected.
        throw error;
      }
      resources.invalidate(
        projectRunResourceKey(projectId, runId),
        cancellation.catalog_revision,
      );
      resources.invalidate(
        projectRunsResourceKey(projectId, cursor),
        cancellation.catalog_revision,
      );
      return cancellation;
    },
    [api, cursor, projectId, resources, runId],
  );
}

export function useCancelProjectRunTaskById(projectId: string) {
  const { api, resources } = useKernel();

  return useCallback(
    async (
      runId: string,
      taskId: string,
      request: ProjectRunTaskCancellationRequest,
    ) => {
      const cancellation = await api.persistence.projects.cancelRunTask(
        projectId,
        runId,
        taskId,
        request,
      );
      resources.invalidate(
        projectRunResourceKey(projectId, runId),
        cancellation.catalog_revision,
      );
      resources.invalidatePrefix(
        `project-runs:${encodeURIComponent(projectId)}:`,
        cancellation.catalog_revision,
      );
      return cancellation;
    },
    [api, projectId, resources],
  );
}

export function useRetryProjectRunTask(projectId: string) {
  const { api, resources } = useKernel();
  const requests = useRef(new Map<string, ProjectRunTaskRetryRequest>());

  return useCallback(
    async (runId: string, taskId: string, expectedCatalogRevision: number) => {
      if (!Number.isSafeInteger(expectedCatalogRevision) || expectedCatalogRevision < 1) {
        throw new Error("Refresh run details before retrying this task.");
      }
      const key = `${projectId}:${runId}:${taskId}`;
      const previous = requests.current.get(key);
      const request = previous ?? {
        retry_id: crypto.randomUUID(),
        expected_catalog_revision: expectedCatalogRevision,
      };
      requests.current.set(key, request);

      try {
        const retry = await api.persistence.projects.retryRunTask(
          projectId,
          runId,
          taskId,
          request,
        );
        requests.current.delete(key);
        resources.invalidate(projectRunResourceKey(projectId, runId), retry.catalog_revision);
        resources.invalidatePrefix(`project-runs:${encodeURIComponent(projectId)}:`, retry.catalog_revision);
        resources.invalidatePrefix(`project-batch-cases:${encodeURIComponent(projectId)}:`, retry.catalog_revision);
        return retry;
      } catch (error) {
        if (error instanceof ControlRoomApiError && error.code === "run_task_retry_revision_conflict") {
          // This response proves that the new retry decision was not published.
          requests.current.delete(key);
        }
        // Preserve the exact ID after transport or post-publication failures.
        throw error;
      }
    },
    [api, projectId, resources],
  );
}
