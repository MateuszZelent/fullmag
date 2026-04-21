"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { StageExecutionState } from "@/lib/session/types";
import { getLiveApiClient } from "../../api/client/LiveApiClient";
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

export function useStageExecution(options?: {
  enabled?: boolean;
  sessionKey?: string | null;
}): UseStageExecutionResult {
  const enabled = options?.enabled ?? true;
  const sessionKey = options?.sessionKey ?? null;
  const [stageExecution, setStageExecution] = useState<StageExecutionState | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<LiveApiError | null>(null);
  const mountedRef = useRef(true);
  const lastFetchedSessionKeyRef = useRef<string | null>(null);

  const fetchStageExecution = useCallback(async () => {
    if (!enabled || !sessionKey) {
      if (mountedRef.current) {
        setStageExecution(null);
        setError(null);
        setLoading(false);
      }
      return;
    }

    setLoading(true);
    try {
      const resource = await getLiveApiClient().stages.execution();
      if (!mountedRef.current) {
        return;
      }
      lastFetchedSessionKeyRef.current = sessionKey;
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
        setStageExecution(null);
        setError(null);
        setLoading(false);
        return;
      }
      setError(apiError);
      setLoading(false);
    }
  }, [enabled, sessionKey]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled || !sessionKey) {
      lastFetchedSessionKeyRef.current = null;
      setStageExecution(null);
      setError(null);
      setLoading(false);
      return () => {
        mountedRef.current = false;
      };
    }

    if (lastFetchedSessionKeyRef.current !== sessionKey) {
      void fetchStageExecution();
    }

    return () => {
      mountedRef.current = false;
    };
  }, [enabled, fetchStageExecution, sessionKey]);

  return {
    stageExecution,
    loading,
    error,
    refresh: fetchStageExecution,
  };
}
