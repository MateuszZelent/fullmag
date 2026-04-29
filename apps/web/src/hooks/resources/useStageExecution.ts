"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { StageExecutionState } from "@/lib/session/types";
import { getLiveSessionClient } from "../../api/client/LiveSessionClient";
import { LiveApiError } from "../../api/client/errors/LiveApiError";

function mapStageExecutionResource(
  resource: import("../../api/types").StageExecutionResource,
): StageExecutionState {
  return {
    total_stages: resource.total_stages,
    completed_stage_indexes: resource.completed_stage_indexes,
    stages: resource.stages.map((stage) => ({
      status: stage.status,
      reason: (stage.reason as StageExecutionState["stages"][number]["reason"]) ?? null,
      metric_name: stage.metric_name ?? null,
      metric_value: stage.metric_value ?? null,
      threshold: stage.threshold ?? null,
    })),
    stage_statuses: resource.stage_statuses,
    active_stage_index: resource.active_stage_index ?? null,
    active_stage_kind: resource.active_stage_kind ?? null,
    runtime_state: resource.runtime_state,
  };
}

interface UseStageExecutionResult {
  stageExecution: StageExecutionState | null;
  loading: boolean;
  error: LiveApiError | null;
  refresh: () => Promise<void>;
}

export function shouldFetchStageExecutionResource(args: {
  enabled: boolean;
  sessionKey: string | null;
  revision: number | null;
  fetchIdentity: string | null;
  notFoundIdentity: string | null;
}): boolean {
  return Boolean(
    args.enabled &&
      args.sessionKey &&
      args.revision != null &&
      args.revision > 0 &&
      args.fetchIdentity &&
      args.notFoundIdentity !== args.fetchIdentity,
  );
}

export function useStageExecution(options?: {
  enabled?: boolean;
  sessionKey?: string | null;
  revision?: number | null;
}): UseStageExecutionResult {
  const enabled = options?.enabled ?? true;
  const sessionKey = options?.sessionKey ?? null;
  const revision = options?.revision ?? null;
  const [stageExecution, setStageExecution] = useState<StageExecutionState | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<LiveApiError | null>(null);
  const mountedRef = useRef(true);
  const lastFetchedIdentityRef = useRef<string | null>(null);
  const notFoundIdentityRef = useRef<string | null>(null);

  const fetchIdentity = sessionKey
    ? `${sessionKey}:${revision == null ? "no-revision" : revision}`
    : null;

  const fetchStageExecution = useCallback(async () => {
    if (
      !shouldFetchStageExecutionResource({
        enabled,
        sessionKey,
        revision,
        fetchIdentity,
        notFoundIdentity: notFoundIdentityRef.current,
      })
    ) {
      if (mountedRef.current) {
        if (fetchIdentity && notFoundIdentityRef.current === fetchIdentity) {
          lastFetchedIdentityRef.current = fetchIdentity;
        }
        setStageExecution(null);
        setError(null);
        setLoading(false);
      }
      return;
    }

    setLoading(true);
    try {
      const resource = await getLiveSessionClient().stages.execution();
      if (!mountedRef.current) {
        return;
      }
      lastFetchedIdentityRef.current = `${sessionKey}:${resource.revision}`;
      notFoundIdentityRef.current = null;
      setStageExecution(mapStageExecutionResource(resource));
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      const apiError =
        err instanceof LiveApiError
          ? err
          : LiveApiError.networkError("stage-execution", err);
      if (apiError.status === 404) {
        notFoundIdentityRef.current = fetchIdentity;
        lastFetchedIdentityRef.current = fetchIdentity;
        setStageExecution(null);
        setError(null);
        setLoading(false);
        return;
      }
      lastFetchedIdentityRef.current = fetchIdentity;
      setError(apiError);
      setLoading(false);
    }
  }, [enabled, fetchIdentity, revision, sessionKey]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled || !sessionKey || revision == null || revision <= 0) {
      lastFetchedIdentityRef.current = null;
      notFoundIdentityRef.current = null;
      setStageExecution(null);
      setError(null);
      setLoading(false);
      return () => {
        mountedRef.current = false;
      };
    }

    if (lastFetchedIdentityRef.current !== fetchIdentity) {
      void fetchStageExecution();
    }

    return () => {
      mountedRef.current = false;
    };
  }, [enabled, fetchIdentity, fetchStageExecution, sessionKey]);

  return {
    stageExecution,
    loading,
    error,
    refresh: fetchStageExecution,
  };
}
