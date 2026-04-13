"use client";

/* ── useSessionStream ──
 * Re-exports all types from session/ submodules for backward compatibility,
 * and provides the useCurrentLiveStream React hook. */

import { useCallback, useEffect, useRef, useState } from "react";
import { currentLiveApiClient } from "./liveApiClient";
import { recordFrontendDebugEvent } from "./workspace/navigation-debug";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "./debug/frontendDiagnosticFlags";

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
  RuntimeCurrentLiveEvent,
  ConnectionStatus,
  UseSessionStreamResult,
  ScalarRow,
} from "./session/types";

/* ── Import submodules ── */
import { normalizeSessionState } from "./session/normalize";
import { mergeSessionState, mergeCommandStatusEvent, mergeScalarRowsDelta } from "./session/merge";
import { decodePreviewBinaryFrame, attachPreviewBinaryPayload } from "./session/binary-preview";

type BootstrapCacheEntry = {
  raw: unknown | null;
  fetchedAt: number;
  inFlight: Promise<unknown> | null;
};

function normalizeChartScalarRows(rows: unknown[]): ScalarRow[] {
  return rows.map((row: any) => ({
    step: Number(row?.step ?? 0),
    time: Number(row?.time ?? 0),
    solver_dt: Number(row?.solver_dt ?? row?.dt ?? 0),
    mx: Number(row?.mx ?? 0),
    my: Number(row?.my ?? 0),
    mz: Number(row?.mz ?? 0),
    e_ex: Number(row?.e_ex ?? 0),
    e_demag: Number(row?.e_demag ?? 0),
    e_ext: Number(row?.e_ext ?? 0),
    e_ani: Number(row?.e_ani ?? 0),
    e_dmi: Number(row?.e_dmi ?? 0),
    e_total: Number(row?.e_total ?? 0),
    max_dm_dt: Number(row?.max_dm_dt ?? 0),
    max_h_eff: Number(row?.max_h_eff ?? 0),
    max_h_demag: Number(row?.max_h_demag ?? 0),
    max_torque_Apm:
      typeof row?.max_torque_Apm === "number" ? Number(row.max_torque_Apm) : undefined,
    max_torque_T:
      typeof row?.max_torque_T === "number" ? Number(row.max_torque_T) : undefined,
  }));
}

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
  const wsRef = useRef<WebSocket | null>(null);
  const finishedRef = useRef(false);
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const unmountedRef = useRef(false);
  const intentionallyClosedRef = useRef(new WeakSet<WebSocket>());
  const pendingPreviewPayloadsRef = useRef(new Map<number, Float64Array>());
  const connectionGenerationRef = useRef(0);
  const bootstrapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef<SessionState | null>(null);

  // Ref-based generation tracker to avoid React Compiler strict dependencies
  const executeConnectRef = useRef<() => void>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    (executeConnectRef as any).current = () => {
      const nextGen = connectionGenerationRef.current + 1;
      (connectionGenerationRef as any).current = nextGen;
      const connectionGeneration = nextGen;

      const client = currentLiveApiClient();
      const previousWs = wsRef.current;
      if (previousWs) {
        intentionallyClosedRef.current.add(previousWs);
        previousWs.close();
        (wsRef as any).current = null;
      }
      pendingPreviewPayloadsRef.current.clear();

      const cacheKey = client.urls.bootstrap;
      const hasSessionState = Boolean(stateRef.current?.session);
      const ageMs = bootstrapCacheAge(cacheKey);
      const shouldFetchBootstrap =
        FRONTEND_DIAGNOSTIC_FLAGS.session.enableLiveBootstrapFetch &&
        (!hasSessionState ||
          ageMs == null ||
          ageMs > BOOTSTRAP_RECONNECT_TTL_MS);

      if (shouldFetchBootstrap) {
        recordFrontendDebugEvent("live-stream", "bootstrap_fetch_scheduled", {
          cacheKey,
          connectionGeneration,
          hasSessionState,
          ageMs,
        });
        void fetchBootstrapCached(cacheKey, () => client.fetchBootstrap())
          .then((raw: any) => {
            if (unmountedRef.current || connectionGenerationRef.current !== connectionGeneration) return;
            const nextState = normalizeSessionState(raw, pendingPreviewPayloadsRef.current);
            if (!nextState.session) {
              setState(null);
              stateRef.current = null;
              setError(null);
              return;
            }
            if (nextState.live_state?.finished) (finishedRef as any).current = true;
            setState((prevState) => mergeSessionState(prevState, nextState));
          })
          .catch((err: any) => {
            if (unmountedRef.current || connectionGenerationRef.current !== connectionGeneration) return;
            setError(err instanceof Error ? err.message : "Failed to load live state");
          });
      } else {
        recordFrontendDebugEvent("live-stream", "bootstrap_fetch_skipped_recent_state", {
          cacheKey,
          connectionGeneration,
          ageMs,
        });
      }

      if (!FRONTEND_DIAGNOSTIC_FLAGS.session.enableLiveWebSocket) {
        recordFrontendDebugEvent("live-stream", "ws_disabled_by_diagnostic_flag", {
          connectionGeneration,
        });
        setConnection("disconnected");
        return;
      }

      const ws = client.connectWebSocket();
      ws.binaryType = "arraybuffer";
      (wsRef as any).current = ws;

      ws.onopen = () => {
        if (unmountedRef.current || wsRef.current !== ws || connectionGenerationRef.current !== connectionGeneration) return;
        if (disconnectTimerRef.current) { clearTimeout(disconnectTimerRef.current); (disconnectTimerRef as any).current = null; }
        if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); (reconnectTimerRef as any).current = null; }
        recordFrontendDebugEvent("live-stream", "ws_open", { connectionGeneration });
        setConnection("connected"); setError(null); (reconnectAttemptRef as any).current = 0;
      };

      ws.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
        if (unmountedRef.current || wsRef.current !== ws || connectionGenerationRef.current !== connectionGeneration) return;
        if (event.data instanceof ArrayBuffer) {
          const p = decodePreviewBinaryFrame(event.data);
          if (!p) return;
          pendingPreviewPayloadsRef.current.set(p.payloadId, p.vectorFieldValues);
          const v2Meta = "version" in p && p.version === 2
            ? { quantityId: (p as any).quantityId as string, nComp: (p as any).nComp as number, grid: (p as any).grid as [number, number, number] }
            : undefined;
          setState((prev) => attachPreviewBinaryPayload(prev, p.payloadId, p.vectorFieldValues, v2Meta));
          return;
        }
        try {
          const raw = JSON.parse(event.data);
          setState((prev) => {
            if (raw?.kind === "chart_state") {
              if (!prev) return prev;
              const rawRows = Array.isArray(raw?.state?.scalar_rows) ? raw.state.scalar_rows : [];
              const deltaRows = normalizeChartScalarRows(rawRows);
              const total =
                typeof raw?.state?.scalar_rows_total === "number"
                  ? raw.state.scalar_rows_total
                  : undefined;
              const mergedRows = mergeScalarRowsDelta(prev.scalar_rows, deltaRows, total);
              if (mergedRows === prev.scalar_rows) return prev;
              return {
                ...prev,
                scalar_rows: mergedRows,
                scalar_rows_total: total ?? prev.scalar_rows_total,
              };
            }
            if (
              raw?.kind === "command_ack" ||
              raw?.kind === "command_rejected" ||
              raw?.kind === "command_completed"
            ) {
              return mergeCommandStatusEvent(prev, raw as RuntimeCurrentLiveEvent);
            }
            const next = normalizeSessionState(raw?.kind === "session_state" ? raw.state : raw, pendingPreviewPayloadsRef.current);
            if (!next.session) {
              return prev;
            }
            if (next.live_state?.finished) (finishedRef as any).current = true;
            return mergeSessionState(prev, next);
          });
        } catch (e) { console.warn("WS parse error", e); }
      };

      ws.onerror = () => { if (wsRef.current === ws) ws.close(); };
      ws.onclose = () => {
        if (unmountedRef.current || wsRef.current !== ws || intentionallyClosedRef.current.has(ws)) return;
        if (finishedRef.current) { setConnection("disconnected"); return; }
        recordFrontendDebugEvent("live-stream", "ws_close_schedule_reconnect", {
          connectionGeneration,
          reconnectAttempt: reconnectAttemptRef.current,
        });
        setConnection("connecting");
        (disconnectTimerRef as any).current = setTimeout(() => { (disconnectTimerRef as any).current = null; setConnection("disconnected"); }, 2000);
        (reconnectTimerRef as any).current = setTimeout(() => {
          (reconnectTimerRef as any).current = null;
          if (wsRef.current === ws) { (reconnectAttemptRef as any).current += 1; executeConnectRef.current?.(); }
        }, Math.min(1500 * Math.pow(2, reconnectAttemptRef.current), 30000));
      };
    };
  }, []);

  const connect = useCallback(() => { executeConnectRef.current?.(); }, []);

  useEffect(() => {
    (unmountedRef as any).current = false;
    (finishedRef as any).current = false;
    (connectionGenerationRef as any).current = 0;
    
    // Delay the first connect slightly so React StrictMode dev remounts
    // do not create and immediately tear down a connecting WebSocket.
    bootstrapTimerRef.current = setTimeout(() => {
      bootstrapTimerRef.current = null;
      if (unmountedRef.current) return;
      setState(null);
      setConnection("connecting");
      setError(null);
      executeConnectRef.current?.();
    }, 60);
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const ws = wsRef.current;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const intentionallyClosedSet = intentionallyClosedRef.current;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const disconnectTimer = disconnectTimerRef.current;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const reconnectTimer = reconnectTimerRef.current;
      const bootstrapTimer = bootstrapTimerRef.current;
      (unmountedRef as any).current = true;
      if (bootstrapTimer !== null) {
        clearTimeout(bootstrapTimer);
        (bootstrapTimerRef as any).current = null;
      }
      if (ws) {
        intentionallyClosedSet.add(ws);
        ws.close();
        (wsRef as any).current = null;
      }
      if (disconnectTimer !== null) {
        clearTimeout(disconnectTimer);
      }
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
      }
    };
  }, [connect]);

  return { state, connection, error };
}
