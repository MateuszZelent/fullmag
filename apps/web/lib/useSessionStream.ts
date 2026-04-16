"use client";

/* ── useSessionStream ──
 * Re-exports all types from session/ submodules for backward compatibility,
 * and provides the useCurrentLiveStream React hook. */

import { useCallback, useEffect, useRef, useState } from "react";
import { currentLiveApiClient } from "./liveApiClient";
import { recordFrontendDebugEvent } from "./workspace/navigation-debug";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "./debug/frontendDiagnosticFlags";
import { getLivePollIntervalMs } from "./livePolling";

/* ── Re-export all types ── */
export type {
  SessionManifest,
  RunManifest,
  LiveState,
  FemLiveMesh,
  FemMeshPart,
  ScalarRow,
  EngineLogEntry,
  QuantityDescriptor,
  ArtifactEntry,
  LatestFields,
  SpatialPreviewState,
  GlobalScalarPreviewState,
  PreviewState,
  PreviewConfig,
  DisplayKind,
  DisplaySelection,
  CurrentDisplaySelection,
  MeshCommandTarget,
  RuntimeStatusKind,
  RuntimeStatusState,
  CommandStatus,
  SceneDocument,
  ScriptBuilderSolverState,
  ScriptBuilderMeshState,
  ScriptBuilderUniverseState,
  ScriptBuilderStageState,
  ScriptBuilderInitialState,
  ScriptBuilderState,
  MeshSummaryState,
  MeshQualitySummaryState,
  MeshPipelinePhaseState,
  MeshCapabilitiesState,
  MeshAdaptivityState,
  MeshHistoryEntryState,
  MeshWorkspaceState,
  SessionState,
  ConnectionStatus,
  UseSessionStreamResult,
} from "./session/types";

import type {
  SessionState,
  ConnectionStatus,
  UseSessionStreamResult,
} from "./session/types";

/* ── Import submodules ── */
import { normalizeSessionState } from "./session/normalize";
import { mergeSessionState } from "./session/merge";

type BootstrapCacheEntry = {
  raw: unknown | null;
  fetchedAt: number;
  inFlight: Promise<unknown> | null;
};

const bootstrapCache = new Map<string, BootstrapCacheEntry>();
const BOOTSTRAP_CACHE_TTL_MS = 4000;
const BOOTSTRAP_RECONNECT_TTL_MS = 15000;

function bootstrapCacheAge(cacheKey: string): number | null {
  const cached = bootstrapCache.get(cacheKey);
  if (!cached || !cached.fetchedAt) {
    return null;
  }
  return Math.max(0, Date.now() - cached.fetchedAt);
}

function fetchBootstrapCached(
  cacheKey: string,
  fetcher: () => Promise<unknown>,
): Promise<unknown> {
  const now = Date.now();
  const cached = bootstrapCache.get(cacheKey);
  if (cached?.raw && now - cached.fetchedAt < BOOTSTRAP_CACHE_TTL_MS) {
    recordFrontendDebugEvent("live-stream", "bootstrap_cache_hit", {
      cacheKey,
      ageMs: now - cached.fetchedAt,
    });
    return Promise.resolve(cached.raw);
  }
  if (cached?.inFlight) {
    recordFrontendDebugEvent("live-stream", "bootstrap_inflight_reused", { cacheKey });
    return cached.inFlight;
  }
  const inFlight = fetcher()
    .then((raw) => {
      bootstrapCache.set(cacheKey, {
        raw,
        fetchedAt: Date.now(),
        inFlight: null,
      });
      return raw;
    })
    .catch((error) => {
      const previous = bootstrapCache.get(cacheKey);
      bootstrapCache.set(cacheKey, {
        raw: previous?.raw ?? null,
        fetchedAt: previous?.fetchedAt ?? 0,
        inFlight: null,
      });
      throw error;
    });
  bootstrapCache.set(cacheKey, {
    raw: cached?.raw ?? null,
    fetchedAt: cached?.fetchedAt ?? 0,
    inFlight,
  });
  return inFlight;
}

/* ── Hook ── */

export function useCurrentLiveStream(): UseSessionStreamResult {
  const [state, setState] = useState<SessionState | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const finishedRef = useRef(false);
  const unmountedRef = useRef(false);
  const connectionGenerationRef = useRef(0);
  const bootstrapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollFailureStreakRef = useRef(0);
  const stateRef = useRef<SessionState | null>(null);

  // Ref-based generation tracker to avoid React Compiler strict dependencies
  const executeConnectRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    executeConnectRef.current = () => {
      const nextGen = connectionGenerationRef.current + 1;
      connectionGenerationRef.current = nextGen;
      const connectionGeneration = nextGen;

      const client = currentLiveApiClient();
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }

      const cacheKey = client.urls.bootstrap;
      const hasSessionState = Boolean(stateRef.current?.session);
      const ageMs = bootstrapCacheAge(cacheKey);
      const shouldFetchBootstrap =
        FRONTEND_DIAGNOSTIC_FLAGS.session.enableLiveBootstrapFetch &&
        (!hasSessionState || ageMs == null || ageMs > BOOTSTRAP_RECONNECT_TTL_MS);

      const pollOnce = async () => {
        if (unmountedRef.current || connectionGenerationRef.current !== connectionGeneration) {
          return;
        }
        const previous = stateRef.current;
        const sinceVersion =
          typeof previous?.state_version === "number" ? previous.state_version : 0;
        const scalarRowsTotal =
          typeof previous?.scalar_rows_total === "number" ? previous.scalar_rows_total : 0;
        try {
          const raw = await client.fetchPoll({
            sinceVersion,
            scalarRowsTotal,
          });
          if (unmountedRef.current || connectionGenerationRef.current !== connectionGeneration) {
            return;
          }
          if (raw) {
            const nextState = normalizeSessionState(raw);
            if (nextState.session) {
              if (nextState.live_state?.finished) finishedRef.current = true;
              setState((prevState) => mergeSessionState(prevState, nextState));
            }
          }
          pollFailureStreakRef.current = 0;
          setError(null);
          setConnection("connected");
        } catch (pollError: unknown) {
          if (unmountedRef.current || connectionGenerationRef.current !== connectionGeneration) {
            return;
          }
          setError(
            pollError instanceof Error
              ? pollError.message
              : "Failed to poll live state",
          );
          pollFailureStreakRef.current += 1;
          if (pollFailureStreakRef.current >= 3) {
            setConnection("disconnected");
          } else {
            setConnection("connecting");
          }
        } finally {
          if (unmountedRef.current || connectionGenerationRef.current !== connectionGeneration) {
            return;
          }
          const intervalMs = getLivePollIntervalMs();
          pollTimerRef.current = setTimeout(pollOnce, intervalMs);
        }
      };

      if (shouldFetchBootstrap) {
        recordFrontendDebugEvent("live-stream", "bootstrap_fetch_scheduled", {
          cacheKey,
          connectionGeneration,
          hasSessionState,
          ageMs,
        });
        void fetchBootstrapCached(cacheKey, () => client.fetchBootstrap())
          .then((raw) => {
            if (
              unmountedRef.current ||
              connectionGenerationRef.current !== connectionGeneration
            ) {
              return;
            }
            const nextState = normalizeSessionState(raw);
            if (!nextState.session) {
              // Keep previous snapshot on reconnect/bootstrap hiccups to avoid
              // full UI reset loops while the backend recovers.
              if (!stateRef.current?.session) {
                setState(null);
                stateRef.current = null;
              }
              setError(null);
              return;
            }
            if (nextState.live_state?.finished) finishedRef.current = true;
            setState((prevState) => mergeSessionState(prevState, nextState));
          })
          .catch((bootstrapError: unknown) => {
            if (
              unmountedRef.current ||
              connectionGenerationRef.current !== connectionGeneration
            ) {
              return;
            }
            setError(
              bootstrapError instanceof Error
                ? bootstrapError.message
                : "Failed to load live state",
            );
          })
          .finally(() => {
            if (
              unmountedRef.current ||
              connectionGenerationRef.current !== connectionGeneration
            ) {
              return;
            }
            setConnection("connected");
            void pollOnce();
          });
      } else {
        recordFrontendDebugEvent("live-stream", "bootstrap_fetch_skipped_recent_state", {
          cacheKey,
          connectionGeneration,
          ageMs,
        });
        setConnection("connected");
        void pollOnce();
      }
    };
  }, []);

  const connect = useCallback(() => {
    executeConnectRef.current?.();
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    finishedRef.current = false;
    connectionGenerationRef.current = 0;
    pollFailureStreakRef.current = 0;

    // Delay the first connect slightly so React StrictMode dev remounts
    // do not create duplicate bootstrap requests.
    bootstrapTimerRef.current = setTimeout(() => {
      bootstrapTimerRef.current = null;
      if (unmountedRef.current) return;
      setConnection("connecting");
      setError(null);
      executeConnectRef.current?.();
    }, 60);

    return () => {
      const bootstrapTimer = bootstrapTimerRef.current;
      const pollTimer = pollTimerRef.current;
      unmountedRef.current = true;
      if (bootstrapTimer !== null) {
        clearTimeout(bootstrapTimer);
        bootstrapTimerRef.current = null;
      }
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimerRef.current = null;
      }
    };
  }, [connect]);

  return { state, connection, error };
}
