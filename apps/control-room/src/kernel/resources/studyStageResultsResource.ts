"use client";

import { useCallback } from "react";

import { useKernel } from "../KernelContext";
import { SIMULATION_STAGES_RESULTS_PATH } from "../api/apiPaths";
import type { StudyStageResultsResource } from "../api/apiTypes";
import { useResource } from "./useResource";
import { useSessionScopedResourceKey } from "./useSessionScopedResourceKey";
import { useSessionStatusSelector } from "./useSessionStatus";

export function useStudyStageResultsResource({
  stageId, runId, cursor, limit, sceneRevision, enabled,
}: {
  stageId?: string;
  runId?: string;
  cursor?: string;
  limit: number;
  sceneRevision: number | null;
  enabled: boolean;
}) {
  const { api } = useKernel();
  const runtimeIdentity = useSessionStatusSelector(({ data }) =>
    JSON.stringify([
      data?.run?.run_id ?? null,
      data?.resources.command_completion_revision ?? null,
      data?.resources.mesh_revision ?? null,
    ]),
    { enabled },
  );
  const query = new URLSearchParams({
    limit: String(limit),
    scene: String(sceneRevision ?? ""),
    runtime: runtimeIdentity,
  });
  if (stageId) query.set("stage_id", stageId);
  if (runId) query.set("run_id", runId);
  if (cursor) query.set("cursor", cursor);
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    `${SIMULATION_STAGES_RESULTS_PATH}?${query}`,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.simulation.stages.results({ stage_id: stageId, run_id: runId, cursor, limit }, { sessionScopeKey, signal }),
    [api, stageId, runId, cursor, limit],
  );
  return useResource<StudyStageResultsResource>({
    enabled: enabled && sessionIdentity !== null,
    abortStaleInflight: true,
    notifyOnError: false,
    load,
    resolveRevision: (data) => data.revision,
    resourceKey,
  });
}
