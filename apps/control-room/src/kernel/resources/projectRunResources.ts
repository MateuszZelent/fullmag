"use client";

import { useCallback } from "react";

import type { ProjectRunListResource, ProjectRunResource } from "../api/apiTypes";
import { assertSolutionSetRunId } from "../api/ControlRoomApi";
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
