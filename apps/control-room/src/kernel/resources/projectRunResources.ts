"use client";

import { useCallback } from "react";

import type { ProjectRunListResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import { useResource } from "./useResource";

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
    resourceKey: `project-runs:${encodeURIComponent(projectId)}:${encodeURIComponent(cursor ?? "first")}`,
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
    resourceKey: `project-run:${encodeURIComponent(projectId)}:${encodeURIComponent(runId ?? "none")}`,
  });
}
