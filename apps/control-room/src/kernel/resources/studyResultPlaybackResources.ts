"use client";

import { useCallback } from "react";

import { useKernel } from "../KernelContext";
import type { StudyStageResult } from "../api/apiTypes";
import { studyResultCacheKey } from "../api/studyResultPlayback";
import { useResource } from "./useResource";

export function useStudyResultPlaybackResources(result: StudyStageResult) {
  const { api } = useKernel();
  const baseKey = `project:study-result:${studyResultCacheKey(result)}`;
  const loadState = useCallback(({ signal }: { signal: AbortSignal }) =>
    api.persistence.projects.studyResultState(result, { signal }), [api, result]);
  const state = useResource({
    resourceKey: baseKey, load: loadState, abortStaleInflight: true, retryPolicy: null,
  });
  const descriptor = state.data;
  const domainKey = `${baseKey}:${descriptor?.domain_generation_id ?? ""}:${descriptor?.topology_fingerprint ?? ""}`;
  const loadGeometry = useCallback(async ({ signal }: { signal: AbortSignal }) => {
    if (!descriptor) throw new Error("The saved Study state is unavailable.");
    const [topology, support] = await Promise.all([
      api.persistence.projects.studyResultTopology(descriptor, { signal }),
      api.persistence.projects.studyResultSupport(descriptor, { signal }),
    ]);
    return { topology, support };
  }, [api, descriptor]);
  const geometry = useResource({
    resourceKey: `${domainKey}:geometry`, enabled: descriptor !== null,
    load: loadGeometry, abortStaleInflight: true, retryPolicy: null,
  });
  const loadMagnetization = useCallback(({ signal }: { signal: AbortSignal }) => {
    if (!descriptor) throw new Error("The saved Study state is unavailable.");
    return api.persistence.projects.studyResultMagnetization(descriptor, { signal });
  }, [api, descriptor]);
  const magnetization = useResource({
    resourceKey: `${domainKey}:magnetization`, enabled: descriptor !== null,
    load: loadMagnetization, abortStaleInflight: true, retryPolicy: null,
  });
  return { state, geometry, magnetization };
}

export function useStudyResultScalarsResource(result: StudyStageResult | null, start: number) {
  const { api } = useKernel();
  const load = useCallback(({ signal }: { signal: AbortSignal }) => {
    if (!result) throw new Error("Select a saved Study result.");
    return api.persistence.projects.studyResultScalars(result, start, { signal });
  }, [api, result, start]);
  return useResource({
    resourceKey: `project:study-result:${result ? studyResultCacheKey(result) : "none"}:scalars:${start}`,
    enabled: result !== null, load, abortStaleInflight: true, retryPolicy: null, notifyOnError: false,
  });
}
