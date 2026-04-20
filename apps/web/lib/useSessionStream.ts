"use client";

/* ── useSessionStream ──
 * Re-exports all types from session/ submodules for backward compatibility,
 * and provides the useCurrentLiveStream React hook. */

import { useCallback, useEffect, useRef, useState } from "react";
import { currentLiveApiClient } from "./liveApiClient";
import { recordFrontendDebugEvent } from "./workspace/navigation-debug";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "./debug/frontendDiagnosticFlags";
import { getEffectiveLivePollIntervalMs } from "./livePolling";

/* ── Re-export all types ── */
export type {
  SessionManifest,
  RunManifest,
  LiveState,
  FemLiveMesh,
  FemMeshPart,
  BackendCapabilities,
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

const ENABLE_LIVE_DEBUG_LOGS =
  FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging &&
  typeof process !== "undefined" &&
  process.env.NODE_ENV !== "production";

type BootstrapCacheEntry = {
  raw: unknown | null;
  fetchedAt: number;
  inFlight: Promise<unknown> | null;
};

function logLiveSnapshot(
  source: "bootstrap" | "poll" | "refresh",
  nextState: SessionState,
): void {
  if (!ENABLE_LIVE_DEBUG_LOGS) {
    return;
  }
  console.info("[fullmag-debug][live-stream] RX <- backend snapshot", {
    source,
    stateVersion: nextState.state_version ?? null,
    sessionId: nextState.session?.session_id ?? null,
    runId: nextState.run?.run_id ?? null,
    sessionStatus: nextState.session?.status ?? null,
    liveStep: nextState.live_state?.step ?? null,
    scalarRows: nextState.scalar_rows?.length ?? 0,
    scalarRowsTotal:
      typeof nextState.scalar_rows_total === "number"
        ? nextState.scalar_rows_total
        : nextState.scalar_rows?.length ?? 0,
    hasPreview: nextState.preview != null,
    liveMagnetizationLength: nextState.live_state?.magnetization?.length ?? 0,
    previewSourceStep:
      nextState.preview?.kind === "spatial" || nextState.preview?.kind === "global_scalar"
        ? nextState.preview.source_step ?? null
        : null,
    previewVectorLength:
      nextState.preview?.kind === "spatial"
        ? nextState.preview.vector_field_values?.length ?? 0
        : 0,
    latestFieldFrames: Object.keys(nextState.latest_fields?.frames ?? {}).length,
    stepUpdateFrames: nextState.step_update_v2?.frames?.length ?? 0,
    stepUpdateFrameQuantities:
      Array.isArray(nextState.step_update_v2?.frames)
        ? nextState.step_update_v2.frames.map((frame) => frame.quantity_id)
        : [],
  });
}

const bootstrapCache = new Map<string, BootstrapCacheEntry>();
const BOOTSTRAP_CACHE_TTL_MS = 4000;
const BOOTSTRAP_RECONNECT_TTL_MS = 15000;

/**
 * Build a cache key that includes session/run identity when available,
 * so a session or run change invalidates stale bootstrap snapshots.
 * See: FE-002 in fullmag-fem-regression-p6-frontend-hardening.mdx
 */
function bootstrapCacheKeyFor(
  baseUrl: string,
  state: { session?: { session_id?: string } | null; run?: { run_id?: string } | null } | null,
): string {
  const sid = state?.session?.session_id;
  const rid = state?.run?.run_id;
  if (sid && rid) return `${baseUrl}::${sid}::${rid}`;
  if (sid) return `${baseUrl}::${sid}`;
  return baseUrl;
}

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

  const applyRawSessionState = useCallback(
    (
      raw: unknown,
      options?: {
        preserveNullSession?: boolean;
        source?: "bootstrap" | "poll" | "refresh";
      },
    ) => {
      const nextState = normalizeSessionState(raw);
      const previousState = stateRef.current;
      if (!nextState.session) {
        if (!options?.preserveNullSession && !previousState?.session) {
          setState(null);
          stateRef.current = null;
        }
        return false;
      }
      const previousVersion =
        typeof previousState?.state_version === "number" ? previousState.state_version : null;
      const nextVersion =
        typeof nextState.state_version === "number" ? nextState.state_version : null;
      if (
        previousState &&
        previousVersion != null &&
        nextVersion != null &&
        nextVersion <= previousVersion
      ) {
        if (ENABLE_LIVE_DEBUG_LOGS) {
          console.info("[fullmag-debug][live-stream] ignored stale-or-duplicate snapshot", {
            source: options?.source ?? "poll",
            previousVersion,
            nextVersion,
            sessionId: nextState.session.session_id,
          });
        }
        return false;
      }
      if (nextState.live_state?.finished) {
        finishedRef.current = true;
      }
      logLiveSnapshot(options?.source ?? "poll", nextState);
      setState((prevState) => {
        const mergedState = mergeSessionState(prevState, nextState);
        stateRef.current = mergedState;
        return mergedState;
      });
      return true;
    },
    [],
  );

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

      const cacheKey = bootstrapCacheKeyFor(client.urls.bootstrap, stateRef.current);
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
            applyRawSessionState(raw, {
              preserveNullSession: true,
              source: "poll",
            });
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
          const intervalMs = getEffectiveLivePollIntervalMs({
            hidden: typeof document !== "undefined" ? document.hidden : false,
          });
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
            if (!applyRawSessionState(raw, { source: "bootstrap" })) {
              // Keep previous snapshot on reconnect/bootstrap hiccups to avoid
              // full UI reset loops while the backend recovers.
              setError(null);
              return;
            }
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
  }, [applyRawSessionState]);

  const refresh = useCallback(async (options?: { forceBootstrap?: boolean }) => {
    const client = currentLiveApiClient();
    const connectionGeneration = connectionGenerationRef.current;
    const currentState = stateRef.current;
    const forceBootstrap = options?.forceBootstrap ?? true;

    try {
      const raw =
        forceBootstrap || !currentState?.session
          ? await client.fetchBootstrap()
          : await client.fetchPoll({
              sinceVersion: 0,
              scalarRowsTotal: 0,
            }) ?? await client.fetchBootstrap();

      if (
        unmountedRef.current ||
        connectionGenerationRef.current !== connectionGeneration
      ) {
        return;
      }

      bootstrapCache.set(bootstrapCacheKeyFor(client.urls.bootstrap, currentState), {
        raw,
        fetchedAt: Date.now(),
        inFlight: null,
      });

      if (applyRawSessionState(raw, {
        preserveNullSession: true,
        source: forceBootstrap ? "refresh" : "poll",
      })) {
        setError(null);
        setConnection("connected");
      }
    } catch (refreshError: unknown) {
      if (
        unmountedRef.current ||
        connectionGenerationRef.current !== connectionGeneration
      ) {
        return;
      }
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Failed to refresh live state",
      );
      throw refreshError;
    }
  }, [applyRawSessionState]);

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

  return { state, connection, error, refresh };
}
