"use client";

import { useCallback } from "react";

import type { ProjectRunListResource } from "../api/apiTypes";
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

export function useProjectRunsResource(projectId: string, cursor: string | null) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.persistence.projects.listRuns(
        projectId,
        { limit: 50, cursor },
        { signal },
      ),
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
      return api.persistence.projects.getRun(projectId, runId, { signal });
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

export function useCancelProjectRunTask(
  projectId: string,
  runId: string | null,
  cursor: string | null,
) {
  const { api, resources } = useKernel();

  return useCallback(
    async (taskId: string, reason: string) => {
      if (!runId) throw new Error("A run must be selected.");
      const cancellation = await api.persistence.projects.cancelRunTask(
        projectId,
        runId,
        taskId,
        { reason },
      );
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
