"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  VisualizationStatePatch,
  VisualizationStateResource,
} from "../../api/contracts";
import { getLiveSessionClient } from "../../api/client/LiveSessionClient";
import { LiveApiError } from "../../api/client/errors/LiveApiError";

interface UseVisualizationStateResourceResult {
  state: VisualizationStateResource | null;
  loading: boolean;
  error: LiveApiError | null;
  refresh: () => Promise<void>;
  patchState: (
    update: VisualizationStatePatch,
  ) => Promise<VisualizationStateResource | null>;
  replaceState: (
    replacement: VisualizationStateResource,
  ) => Promise<VisualizationStateResource | null>;
}

export function buildVisualizationStateFetchIdentity(args: {
  sessionKey: string | null;
  revision: number | null;
}): string | null {
  return args.sessionKey
    ? `${args.sessionKey}:${args.revision == null ? "no-revision" : args.revision}`
    : null;
}

export function shouldFetchVisualizationStateResource(args: {
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

export function useVisualizationStateResource(options?: {
  enabled?: boolean;
  sessionKey?: string | null;
  revision?: number | null;
}): UseVisualizationStateResourceResult {
  const enabled = options?.enabled ?? true;
  const sessionKey = options?.sessionKey ?? null;
  const revision = options?.revision ?? null;
  const [state, setState] = useState<VisualizationStateResource | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<LiveApiError | null>(null);
  const mountedRef = useRef(true);
  const lastFetchedIdentityRef = useRef<string | null>(null);
  const notFoundIdentityRef = useRef<string | null>(null);

  const fetchIdentity = buildVisualizationStateFetchIdentity({
    sessionKey,
    revision,
  });

  const fetchVisualizationState = useCallback(async () => {
    if (
      !shouldFetchVisualizationStateResource({
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
        setState(null);
        setError(null);
        setLoading(false);
      }
      return;
    }

    setLoading(true);
    try {
      const nextState = await getLiveSessionClient().visualizationState.get();
      if (!mountedRef.current) {
        return;
      }
      lastFetchedIdentityRef.current = `${sessionKey}:${nextState.revision}`;
      notFoundIdentityRef.current = null;
      setState(nextState);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      const apiError =
        err instanceof LiveApiError
          ? err
          : LiveApiError.networkError("visualization-state", err);
      if (apiError.status === 404) {
        notFoundIdentityRef.current = fetchIdentity;
        lastFetchedIdentityRef.current = fetchIdentity;
        setState(null);
        setError(null);
        setLoading(false);
        return;
      }
      lastFetchedIdentityRef.current = fetchIdentity;
      setError(apiError);
      setLoading(false);
    }
  }, [enabled, fetchIdentity, revision, sessionKey]);

  const patchState = useCallback(
    async (
      update: VisualizationStatePatch,
    ): Promise<VisualizationStateResource | null> => {
      if (!enabled || !sessionKey) {
        return null;
      }
      setLoading(true);
      try {
        const nextState = await getLiveSessionClient().visualizationState.patch(update);
        if (!mountedRef.current) {
          return nextState;
        }
        lastFetchedIdentityRef.current = `${sessionKey}:${nextState.revision}`;
        notFoundIdentityRef.current = null;
        setState(nextState);
        setError(null);
        setLoading(false);
        return nextState;
      } catch (err) {
        if (!mountedRef.current) {
          return null;
        }
        const apiError =
          err instanceof LiveApiError
            ? err
            : LiveApiError.networkError("visualization-state", err);
        setError(apiError);
        setLoading(false);
        return null;
      }
    },
    [enabled, sessionKey],
  );

  const replaceState = useCallback(
    async (
      replacement: VisualizationStateResource,
    ): Promise<VisualizationStateResource | null> => {
      if (!enabled || !sessionKey) {
        return null;
      }
      setLoading(true);
      try {
        const nextState =
          await getLiveSessionClient().visualizationState.replace(replacement);
        if (!mountedRef.current) {
          return nextState;
        }
        lastFetchedIdentityRef.current = `${sessionKey}:${nextState.revision}`;
        notFoundIdentityRef.current = null;
        setState(nextState);
        setError(null);
        setLoading(false);
        return nextState;
      } catch (err) {
        if (!mountedRef.current) {
          return null;
        }
        const apiError =
          err instanceof LiveApiError
            ? err
            : LiveApiError.networkError("visualization-state", err);
        setError(apiError);
        setLoading(false);
        return null;
      }
    },
    [enabled, sessionKey],
  );

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled || !sessionKey || revision == null || revision <= 0) {
      lastFetchedIdentityRef.current = null;
      notFoundIdentityRef.current = null;
      setState(null);
      setError(null);
      setLoading(false);
      return () => {
        mountedRef.current = false;
      };
    }

    if (lastFetchedIdentityRef.current !== fetchIdentity) {
      void fetchVisualizationState();
    }

    return () => {
      mountedRef.current = false;
    };
  }, [
    enabled,
    fetchIdentity,
    fetchVisualizationState,
    revision,
    sessionKey,
  ]);

  return {
    state,
    loading,
    error,
    refresh: fetchVisualizationState,
    patchState,
    replaceState,
  };
}
